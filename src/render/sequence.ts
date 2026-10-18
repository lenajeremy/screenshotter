/**
 * Videos of several shots: designs one after another, each with its own animations and length,
 * joined by transitions (a cut, a crossfade, a push, a wipe, an iris, a zoom…). Each shot is
 * rendered at the video's size (fitted, filled or laid out again when its own shape differs), then
 * ffmpeg joins them and encodes the whole once. Versions at other sizes work as for create_video.
 */
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";
import { cacheDir, formatFor, outputPathFor } from "../util/files.js";
import { keyMoments } from "./animate.js";
import { layoutScene, renderHtml, type SceneFrame } from "./mockup.js";
import type { MockupInput } from "./schema.js";
import { FITS, PRESET_NAMES, VIDEO_PRESETS, VersionSchema, VideoInputShape, addSound, openStage, renderVideo, soundPieces, versionSpec, type Fit, type VideoInput, type VideoPreset } from "./video.js";

export const TRANSITIONS = ["cut", "fade", "fade-black", "fade-white", "push-left", "push-right", "push-up", "push-down", "wipe-left", "wipe-right", "iris", "zoom", "blur", "dissolve"] as const;
export type Transition = (typeof TRANSITIONS)[number];
/** ffmpeg's name for each (xfade). A cut is a one-frame fade. */
const XFADE: Record<Transition, string> = {
  cut: "fade",
  fade: "fade",
  "fade-black": "fadeblack",
  "fade-white": "fadewhite",
  "push-left": "slideleft",
  "push-right": "slideright",
  "push-up": "slideup",
  "push-down": "slidedown",
  "wipe-left": "smoothleft",
  "wipe-right": "smoothright",
  iris: "circleopen",
  zoom: "zoomin",
  blur: "hblur",
  dissolve: "dissolve",
};
export const DEFAULT_TRANSITION: { type: Transition; duration: number } = { type: "fade", duration: 0.5 };

const { output: _o, format: _f, quality: _q, preview: _p, versions: _v, deliveryWidth: _d, ...sceneShape } = VideoInputShape;

export const ShotSchema = z.object({
  ...sceneShape,
  length: z.number().min(0.5).max(60).optional().describe("Seconds this shot is on screen, its transitions included. Default: as long as its animations need (or its video.duration)."),
  transition: z
    .object({
      type: z.enum(TRANSITIONS).describe("cut, fade (a crossfade), fade-black / fade-white (through black or white), push-left/right/up/down (the new shot pushes the old one off), wipe-left/right (a soft wipe), iris (opens from the middle), zoom (zooms through), blur, dissolve."),
      duration: z.number().min(0).max(3).optional().describe("Seconds. Default 0.5 (a cut is instant)."),
    })
    .optional()
    .describe("How this shot comes in from the one before. Default a 0.5 s crossfade. Ignored on the first shot."),
});
export type Shot = z.infer<typeof ShotSchema>;

export const SequenceInputShape = {
  shots: z.array(ShotSchema).min(1).max(20).describe("The shots, in order: each a scene as create_video takes it (devices, text, backdrop, animations, video options), with its length and how it comes in."),
  size: z
    .union([z.enum(PRESET_NAMES as [VideoPreset, ...VideoPreset[]]), z.string().regex(/^\d{2,5}x\d{2,5}$/)])
    .optional()
    .describe(`The video's size: a preset (${PRESET_NAMES.join(", ")}) or "WIDTHxHEIGHT". Default: the first shot's canvas. An App Store preset follows Apple's app preview rules.`),
  fit: z.enum(FITS).optional().describe("How a shot of another shape goes into the video's: fit (all of it, its backdrop filling the rest), fill (fills it, trimming the edges), rearrange (laid out again). Default: fit for hand-placed designs, rearrange for automatic layouts."),
  fps: z.number().int().min(12).max(60).optional().describe("Default 30."),
  format: z.enum(["mp4", "mov", "webm", "gif"]).optional().describe("Default mp4."),
  quality: z.enum(["preview", "final"]).optional().describe("preview renders at half resolution for a quick check."),
  output: z.string().optional().describe("Output file or directory. Default ./screenshots/videos/."),
  name: z.string().max(120).optional().describe("What to call the file when `output` isn't a file: this, then the time. Default \"video-N-shots\"."),
  deliveryWidth: z.number().int().min(16).max(8192).optional().describe("Resize the video to this width."),
  preview: z.boolean().optional().describe("Return a strip of frames from the video. Default true."),
  versions: z.array(VersionSchema).max(9).optional().describe("Also make it at these sizes, each its own file (see create_video)."),
};
export const SequenceInputSchema = z.object(SequenceInputShape);
export type SequenceInput = z.infer<typeof SequenceInputSchema>;

export interface SequenceResult {
  path: string;
  poster: string;
  filmstrip: string;
  width: number;
  height: number;
  duration: number;
  fps: number;
  /** When each shot starts and how long it's on screen (seconds), transitions included. */
  shots: Array<{ start: number; length: number; transition?: Transition }>;
  versions?: Array<{ name: string; label: string; path: string; width: number; height: number; duration: number; fit: Fit; appStore: boolean; warnings?: string[] }>;
  warnings?: string[];
}

/** The video's size: a preset, "WxH", or the first shot's own canvas. */
async function sizeOf(input: Pick<SequenceInput, "shots" | "size">): Promise<{ width: number; height: number; appStore: boolean }> {
  const preset = input.size ? (VIDEO_PRESETS as Record<string, (typeof VIDEO_PRESETS)[VideoPreset]>)[input.size] : undefined;
  if (preset) return { width: preset.width, height: preset.height, appStore: preset.appStore };
  if (input.size) {
    const [width, height] = input.size.split("x").map(Number);
    return { width, height, appStore: false };
  }
  const c = (await layoutScene(asScene(input.shots[0]))).canvas;
  return { width: c.width, height: c.height, appStore: false };
}

const asScene = (shot: Shot) => {
  const { length: _l, transition: _t, ...scene } = shot;
  return scene as MockupInput;
};

/** A shot as a video to render at the sequence's size: in a frame, or laid out again for it. */
async function shotPlan(shot: Shot, size: { width: number; height: number }, fit: Fit | undefined, fps: number): Promise<{ input: VideoInput; frame?: SceneFrame }> {
  const { length, transition: _t, ...scene } = shot;
  const input: VideoInput = { ...scene, video: { ...scene.video, fps, ...(length ? { duration: length } : {}) } } as VideoInput;
  const own = (await layoutScene(scene as MockupInput)).canvas;
  if (Math.abs(own.width - size.width) < 1 && Math.abs(own.height - size.height) < 1) return { input };
  const how = fit ?? (scene.layout === "custom" ? "fit" : "rearrange");
  if (how === "rearrange") return { input: { ...input, canvas: `${size.width}x${size.height}` } };
  return { input, frame: { width: size.width, height: size.height, fit: how } };
}

/** Transition lengths that fit their shots: never more than 45% of either, and a cut is one frame. */
function joins(shots: Shot[], lengths: number[], fps: number) {
  return shots.map((s, i) => {
    if (i === 0) return { type: undefined, duration: 0 };
    const t = s.transition ?? DEFAULT_TRANSITION;
    const d = t.type === "cut" ? 1 / fps : Math.min(t.duration ?? DEFAULT_TRANSITION.duration, 0.45 * lengths[i - 1], 0.45 * lengths[i]);
    return { type: t.type, duration: Math.max(1 / fps, d) };
  });
}

/** When each shot starts: each comes in as the one before is still finishing. */
function starts(lengths: number[], j: Array<{ duration: number }>): number[] {
  const out = [0];
  for (let i = 1; i < lengths.length; i++) out.push(out[i - 1] + lengths[i - 1] - j[i].duration);
  return out;
}

/** Run ffmpeg; its last lines of error output on failure. */
function ffmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    p.stderr.on("data", (d) => (err += d));
    p.on("error", (e) => reject((e as NodeJS.ErrnoException).code === "ENOENT" ? new Error("ffmpeg isn't installed. Install it with `brew install ffmpeg`.") : e));
    p.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg failed (${code}): ${err.trim().split("\n").slice(-3).join(" ")}`))));
  });
}

/** The final encoding: the delivery formats, or an App Store preview (with its silent stereo track). */
function finalArgs(format: string, appStore: boolean, deliveryWidth: number | undefined, fps: number): { filter: string; codec: string[] } {
  const scale = deliveryWidth ? `scale=${deliveryWidth}:-2:flags=lanczos` : "scale=trunc(iw/2)*2:trunc(ih/2)*2";
  if (appStore) return { filter: scale, codec: ["-c:v", "libx264", "-preset", "medium", "-profile:v", "high", "-level:v", "4.0", "-pix_fmt", "yuv420p", "-b:v", "11M", "-maxrate", "12M", "-bufsize", "24M", "-r", "30", "-c:a", "aac", "-b:a", "256k", "-ar", "48000", "-ac", "2", "-shortest", "-movflags", "+faststart"] };
  switch (format) {
    case "webm":
      return { filter: scale, codec: ["-c:v", "libvpx-vp9", "-b:v", "0", "-crf", "26", "-row-mt", "1", "-pix_fmt", "yuv420p"] };
    case "mov":
      return { filter: scale, codec: ["-c:v", "prores_ks", "-profile:v", "3", "-pix_fmt", "yuv422p10le"] };
    case "gif":
      return { filter: `fps=${Math.min(fps, 20)},scale=${deliveryWidth ?? 960}:-1:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=sierra2_4a`, codec: ["-loop", "0"] };
    default:
      return { filter: scale, codec: ["-c:v", "libx264", "-preset", "medium", "-crf", "16", "-pix_fmt", "yuv420p", "-movflags", "+faststart"] };
  }
}

/** Join rendered shots with their transitions into one file. */
async function join(files: string[], lengths: number[], j: Array<{ type?: Transition; duration: number }>, fps: number, out: string, format: string, appStore: boolean, deliveryWidth?: number) {
  const inputs = files.flatMap((f) => ["-i", f]);
  const prep = files.map((_, i) => `[${i}:v]settb=AVTB,fps=${fps},format=yuv420p[s${i}]`);
  const chain: string[] = [];
  let last = "s0";
  let acc = lengths[0];
  for (let i = 1; i < files.length; i++) {
    const offset = Math.max(0, acc - j[i].duration);
    chain.push(`[${last}][s${i}]xfade=transition=${XFADE[j[i].type ?? "fade"]}:duration=${j[i].duration.toFixed(4)}:offset=${offset.toFixed(4)}[x${i}]`);
    last = `x${i}`;
    acc += lengths[i] - j[i].duration;
  }
  const enc = finalArgs(format, appStore, deliveryWidth, fps);
  const graph = [...prep, ...chain, `[${last}]${enc.filter}[out]`].join(";");
  const audio = appStore ? ["-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=48000"] : [];
  await ffmpeg(["-y", "-loglevel", "error", ...inputs, ...audio, "-filter_complex", graph, "-map", "[out]", ...(appStore ? ["-map", `${files.length}:a`] : []), ...enc.codec, out]);
}

/** Frames of a finished video at chosen times, as one labelled sheet. */
async function sheetFromVideo(file: string, times: number[], labels: string[], aspect: number, out: string, dir: string) {
  const frames: string[] = [];
  for (const [i, t] of times.entries()) {
    const f = path.join(dir, `frame-${i}.jpg`);
    await ffmpeg(["-y", "-loglevel", "error", "-ss", t.toFixed(3), "-i", file, "-frames:v", "1", "-q:v", "3", f]);
    frames.push(f);
  }
  await composeTiles(frames, labels, aspect, out);
}

/** Tiles in a grid, each labelled: a filmstrip or a storyboard. */
async function composeTiles(files: string[], labels: string[], aspect: number, out: string) {
  const { pathToFileURL } = await import("node:url");
  const portrait = aspect < 1;
  const cols = Math.min(files.length, portrait ? 4 : 3);
  const tileH = portrait ? (files.length > 8 ? 480 : 640) : files.length > 9 ? 280 : 380;
  const tileW = Math.round(tileH * aspect);
  const rows = Math.ceil(files.length / cols);
  const gap = 8;
  const html = `<!doctype html><html><body style="margin:0;background:#111"><div style="display:grid;grid-template-columns:repeat(${cols}, ${tileW}px);gap:${gap}px;padding:${gap}px">${files
    .map((f, k) => `<div style="position:relative"><img src="${pathToFileURL(f).href}" style="height:${tileH}px;width:${tileW}px;display:block;border-radius:8px;object-fit:cover"><div style="position:absolute;left:8px;top:7px;padding:2px 8px;border-radius:6px;background:rgba(0,0,0,.72);font:600 17px system-ui;color:#fff">${labels[k]}</div></div>`)
    .join("")}</div></body></html>`;
  await renderHtml(html, out, (tileW + gap) * cols + gap, (tileH + gap) * rows + gap, { scale: 1, format: "jpeg", transparent: false });
}

const clock = (t: number) => `${Number(t.toFixed(2))} s`;

/** Render a video of several shots, joined by transitions, and each version asked for. */
export async function createSequence(input: SequenceInput, opts: { progress?: (f: number) => void } = {}): Promise<SequenceResult> {
  const n = 1 + (input.versions?.length ?? 0);
  const main = await renderSequence(input, { progress: opts.progress && ((f) => opts.progress!(f / n)) });
  if (!input.versions?.length) return main;
  const versions: NonNullable<SequenceResult["versions"]> = [];
  for (const [k, v] of input.versions.entries()) {
    const spec = versionSpec(v, input.shots[0]?.layout);
    const format = spec.appStore ? "mp4" : main.path.split(".").pop()!;
    const out = main.path.replace(/\.[a-z0-9]+$/i, `.${spec.name}.${format}`);
    // Each shot keeps its own way in (fit for hand-placed designs, laid out again otherwise) unless the version says.
    const fit = (typeof v === "object" && v.fit) || input.fit;
    const r = await renderSequence({ ...input, size: `${spec.width}x${spec.height}`, fit, deliveryWidth: undefined }, { output: out, appStore: spec.appStore, filmstrip: false, progress: opts.progress && ((f) => opts.progress!((k + 1 + f) / n)) });
    versions.push({ name: spec.name, label: spec.label, path: r.path, width: r.width, height: r.height, duration: r.duration, fit: fit ?? "fit", appStore: spec.appStore, warnings: r.warnings });
  }
  return { ...main, versions };
}

async function renderSequence(input: SequenceInput, o: { output?: string; appStore?: boolean; filmstrip?: boolean; progress?: (f: number) => void }): Promise<SequenceResult> {
  const size = await sizeOf(input);
  const appStore = o.appStore ?? size.appStore;
  const fps = appStore ? 30 : (input.fps ?? 30);
  const format = appStore ? "mp4" : formatFor(input.format, o.output ?? input.output, ["mp4", "mov", "webm", "gif"] as const, "mp4", { m4v: "mp4" });
  const out = o.output ?? outputPathFor(input.output, "videos", input.name || `video-${input.shots.length}-shots`, format);
  const dir = await mkdtemp(path.join(tmpdir(), "screenshotter-sequence-"));
  const warnings: string[] = [];
  try {
    // Each shot at the video's size, two at a time.
    const plans = await Promise.all(input.shots.map((s) => shotPlan(s, size, input.fit, fps)));
    const rendered: Array<{ path: string; duration: number; warnings?: string[] }> = new Array(plans.length);
    // The shots take most of the time; joining them, the rest.
    const shares = plans.map(() => 0);
    const report = () => o.progress?.((0.92 * shares.reduce((a, b) => a + b, 0)) / Math.max(1, shares.length));
    let next = 0;
    const worker = async () => {
      while (next < plans.length) {
        const i = next++;
        const p = plans[i];
        // An App Store preview is always its exact size.
        const r = await renderVideo({ ...p.input, quality: appStore ? "final" : input.quality }, {
          shot: true,
          frame: p.frame,
          output: path.join(dir, `shot-${i}.mp4`),
          progress: (f) => {
            shares[i] = f;
            report();
          },
        });
        rendered[i] = r;
      }
    };
    await Promise.all([worker(), worker()]);
    rendered.forEach((r, i) => r.warnings?.forEach((w) => warnings.push(`Shot ${i + 1}: ${w}`)));
    const lengths = rendered.map((r) => r.duration);
    const j = joins(input.shots, lengths, fps);
    let total = lengths.reduce((a, b) => a + b, 0) - j.reduce((a, b) => a + b.duration, 0);
    // An App Store preview runs 15 to 30 s: hold the last shot longer, or say it's too long.
    if (appStore && total < 15) {
      const extra = 15 - total;
      const last = plans.length - 1;
      const r = await renderVideo({ ...plans[last].input, video: { ...plans[last].input.video, duration: lengths[last] + extra }, quality: "final" }, { shot: true, frame: plans[last].frame, output: path.join(dir, `shot-${last}-long.mp4`) });
      rendered[last] = r;
      lengths[last] = r.duration;
      total += extra;
      warnings.push(`Held the last shot ${extra.toFixed(1)} s longer: an App Store preview runs at least 15 seconds.`);
    }
    if (appStore && total > 30) warnings.push(`It runs ${total.toFixed(1)} s; an App Store preview can be 30 s at most. Shorten some shots.`);
    await join(rendered.map((r) => r.path), lengths, j, fps, out, format, appStore, appStore ? undefined : input.deliveryWidth);
    const at = starts(lengths, j);
    // The shots' sound (a shot's recordings, or the pieces it gives), each from where its shot
    // starts in the video to where it ends.
    if (!appStore && format !== "gif") {
      const pieces = plans.flatMap((p, i) => (p.input.video?.sound ? soundPieces(p.input).map((s) => ({ ...s, at: at[i] + s.at, until: at[i] + lengths[i] })) : []));
      if (pieces.length) await addSound(out, format, pieces, total, warnings);
    }
    const shots = lengths.map((length, i) => ({ start: Math.round(at[i] * 1000) / 1000, length: Math.round(length * 1000) / 1000, transition: j[i].type }));

    // Poster (the end of the first shot) and a filmstrip: the middle of each shot and each transition.
    const poster = out.replace(/\.[a-z0-9]+$/i, ".poster.jpg");
    await ffmpeg(["-y", "-loglevel", "error", "-ss", Math.min(total - 0.05, Math.max(0, lengths[0] - (j[1]?.duration ?? 0) - 0.1)).toFixed(3), "-i", out, "-frames:v", "1", "-q:v", "2", poster]).catch(() => undefined);
    let filmstrip = "";
    if (o.filmstrip !== false && input.preview !== false && format !== "gif") {
      const moments: Array<{ t: number; label: string }> = [];
      shots.forEach((s, i) => {
        if (i > 0) moments.push({ t: s.start + j[i].duration / 2, label: `${clock(s.start + j[i].duration / 2)} · ${s.transition}` });
        moments.push({ t: s.start + s.length / 2, label: `${clock(s.start + s.length / 2)} · shot ${i + 1}` });
      });
      filmstrip = out.replace(/\.[a-z0-9]+$/i, ".filmstrip.jpg");
      const pick = moments.slice(0, 16);
      await sheetFromVideo(out, pick.map((m) => Math.min(total - 0.05, m.t)), pick.map((m) => m.label), size.width / size.height, filmstrip, dir);
    }
    writeFileSync(`${out}.sequence.json`, JSON.stringify({ ...input, output: out }, null, 2));
    const width = appStore ? size.width : (input.deliveryWidth ?? (input.quality === "preview" ? Math.round(size.width / 2) : size.width));
    return { path: out, poster, filmstrip, width, height: Math.round((size.height * width) / size.width), duration: Math.round(total * 1000) / 1000, fps, shots, warnings: warnings.length ? warnings : undefined };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * A sequence at chosen moments without rendering it: each shot's key moments (or `times`, or one
 * `every` so many seconds, across the whole video), labelled with the time and the shot. During a
 * transition it shows the shot that's mostly on screen.
 */
export async function sequenceStoryboard(input: SequenceInput, o: { max?: number; output?: string; times?: number[]; every?: number; numbers?: number[] } = {}): Promise<{ path: string; times: number[]; duration: number; shots: Array<{ start: number; length: number }>; warnings?: string[] }> {
  const size = await sizeOf(input);
  const fps = input.fps ?? 30;
  const tileH = size.width < size.height ? 640 : 380;
  const scale = Math.min(1, (tileH * 1.4) / size.height);
  const max = Math.min(o.max ?? 12, 16);
  const dir = await mkdtemp(path.join(tmpdir(), "screenshotter-sequence-board-"));
  const files: string[] = [];
  const labels: string[] = [];
  const times: number[] = [];
  const warnings: string[] = [];
  const lengths: number[] = [];
  const at: number[] = [];
  try {
    // One shot at a time: its start is known once the one before it has been opened.
    let wanted = o.times?.length ? [...o.times].sort((a, b) => a - b) : undefined;
    for (const [i, shot] of input.shots.entries()) {
      const plan = await shotPlan(shot, size, input.fit, fps);
      const stage = await openStage(plan.input, scale, { frame: plan.frame });
      try {
        lengths.push(stage.duration);
        stage.scene.result.warnings?.forEach((w) => warnings.push(`Shot ${i + 1}: ${w}`));
        const j = joins(input.shots.slice(0, i + 1), lengths, fps);
        at.push(i === 0 ? 0 : at[i - 1] + lengths[i - 1] - j[i].duration);
        const nextIn = input.shots[i + 1] ? Math.min((input.shots[i + 1].transition ?? DEFAULT_TRANSITION).type === "cut" ? 0 : (input.shots[i + 1].transition?.duration ?? DEFAULT_TRANSITION.duration), 0.45 * stage.duration) : 0;
        const inHalf = i === 0 ? 0 : j[i].duration / 2;
        // This shot's own stretch: from half way through its way in, to half way through its way out.
        const from = at[i] + inHalf;
        const to = at[i] + stage.duration - nextIn / 2;
        let local: number[];
        if (wanted || o.every) {
          const all = wanted ?? Array.from({ length: Math.floor(1e-9 + (at[i] + stage.duration) / o.every!) + 1 }, (_, n) => n * o.every!);
          local = all.filter((t) => t >= from - 1e-9 && (t < to || i === input.shots.length - 1)).map((t) => t - at[i]);
        } else {
          const per = Math.max(2, Math.floor(max / input.shots.length));
          local = keyMoments(stage.animations, stage.ents, stage.duration, per).filter((t) => at[i] + t >= from - 0.05 && at[i] + t <= to + 0.05);
          if (!local.length) local = [Math.max(0, (from + to) / 2 - at[i])];
        }
        for (const t of local) {
          if (files.length >= 16) break;
          await stage.setTime(Math.min(stage.duration, Math.max(0, t)));
          const f = path.join(dir, `m-${files.length}.jpg`);
          await stage.page.screenshot({ path: f as `${string}.jpg`, type: "jpeg", quality: 88, clip: stage.clip, optimizeForSpeed: true });
          files.push(f);
          times.push(Math.round((at[i] + t) * 1000) / 1000);
          labels.push(`${clock(at[i] + t)} · shot ${o.numbers?.[i] ?? i + 1}`);
        }
      } finally {
        await stage.close();
      }
    }
    const out = o.output ?? path.join(cacheDir("storyboards"), `sequence-${Date.now()}-${Math.round(Math.random() * 1e6)}.jpg`);
    await composeTiles(files, labels, size.width / size.height, out);
    const j = joins(input.shots, lengths, fps);
    const duration = lengths.reduce((a, b) => a + b, 0) - j.reduce((a, b) => a + b.duration, 0);
    return { path: out, times, duration: Math.round(duration * 1000) / 1000, shots: lengths.map((l, i) => ({ start: Math.round(at[i] * 1000) / 1000, length: Math.round(l * 1000) / 1000 })), warnings: warnings.length ? warnings : undefined };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
