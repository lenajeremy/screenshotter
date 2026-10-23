import { spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { cacheDir, formatFor, outputPathFor } from "../util/files.js";
import { mediaInfo } from "../util/media.js";
import { newPage } from "./browser.js";
import { BACKDROP, CALLOUT, animatedIds, backdropStyle, cameraTransform, evaluate, evaluateBackdrop, evaluateCallouts, evaluateCamera, keyMoments, targetsOf, timelineEnd, uses3d, type AnimEntity } from "./animate.js";
import { CURSOR_ART, cursorAt, readLog, trackOf } from "./cursor.js";
import { cutLogFile, cutVideo } from "./cut-files.js";
import { fastAvailable, renderFast, type FastStage } from "./fast.js";
import { buildScene, layoutScene, renderHtml, type MockupResult, type SceneEntity, type SceneFrame } from "./mockup.js";
import { MOTIONS, MockupInputShape, type MockupInput } from "./schema.js";
import { renderShape } from "./shapes.js";

/** The longest video: an hour, for a whole screen recording. */
export const MAX_LENGTH = 3600;

const timing = z.object({
  in: z.number().optional().describe("Seconds when it appears (fades in)."),
  out: z.number().optional().describe("Seconds when it has faded out. Omit to keep it."),
});

export const VideoOptionsSchema = z
  .object({
    duration: z.number().min(0.5).max(MAX_LENGTH).optional().describe("Seconds. Default 6 (or the screen recording's length, up to a minute)."),
    sound: z
      .boolean()
      .optional()
      .describe("Keep the sound of the devices' recordings (a screen recording's voice-over and system sound), mixed into the video. Default false: silent. Not for GIFs."),
    fps: z.number().int().min(12).max(60).optional().describe("Default 30."),
    motion: z
      .enum(MOTIONS)
      .optional()
      .describe("Ambient motion: subtle bob, float (gentle 3D sway), drift (slow pan and turn), push-in (slow camera push). Default: the design's own motion, else subtle."),
    motionAmount: z.number().optional().describe("Multiplier for motion strength. Default 1."),
    zoom: z
      .object({
        start: z.number().describe("Seconds when the zoom starts."),
        end: z.number().describe("Seconds when it has zoomed back out."),
        scale: z.number().optional().describe("Default 1.8."),
        x: z.number().optional().describe("Focus x (0–1 of canvas). Default: the first highlight, else centre."),
        y: z.number().optional(),
      })
      .optional()
      .describe("Camera push into a point and back out, e.g. onto a highlighted row. For several, use zooms."),
    zooms: z
      .array(
        z.object({
          start: z.number().describe("Seconds when this zoom starts."),
          end: z.number().describe("Seconds when it ends."),
          scale: z.number().min(1).max(6).optional().describe("Default 1.8."),
          x: z.number().optional().describe("Focus x (0–1 of canvas)."),
          y: z.number().optional().describe("Focus y (0–1 of canvas)."),
          highlight: z.number().int().min(0).optional().describe("Instead of x/y: focus on this highlight (0 = the first on screen)."),
        }),
      )
      .max(12)
      .optional()
      .describe("Zooms in turn. When one ends within 0.8 s of the next starting, the camera glides from one point to the next instead of pulling out: zooms that follow the action (a tap, then the screen it opens)."),
    cursor: z
      .object({
        device: z.number().int().min(0).optional().describe("Which device's screen the cursor moves on (index). Default 0."),
        style: z.enum(["pointer", "touch"]).optional().describe("pointer: the macOS arrow (Mac apps, web pages). touch: a fingertip dot (iPhone, iPad, Watch). Default: pointer for MacBooks and browser/window frames, touch otherwise."),
        size: z.number().positive().max(4).optional().describe("Size multiplier. Default 1."),
        log: z
          .string()
          .optional()
          .describe("A cursor log the capture bar wrote beside a screen recording (cursor.json): the real path, clicks and cursors, instead of points."),
        smooth: z.number().min(0).max(1).optional().describe("With a log: how much shake to take out of the path, 0 (none) to 1. Default 0.5."),
        ripple: z.boolean().optional().describe("A ring where each click lands. Default true."),
        points: z
          .array(
            z.object({
              t: z.number().min(0).describe("Seconds."),
              x: z.number().describe("Fraction of the screenshot's width (0 left, 1 right)."),
              y: z.number().describe("Fraction of its height."),
              click: z.boolean().optional().describe("A click or tap here, at time t."),
              drag: z.boolean().optional().describe("Held down from here to the next point: a drag."),
            }),
          )
          .min(1)
          .max(300)
          .optional()
          .describe("Where the cursor is over time; it glides between points. record_web returns these for the flow it recorded. Not needed with a log."),
      })
      .optional()
      .describe("Draw a cursor moving over a device's screen, clicking and dragging where you say (or as a recording's log has it). It moves with the device (tilt, motion, zooms)."),
    follow: z.boolean().optional().describe("With a cursor log: while the camera is zoomed in, it glides after the cursor."),
    highlight: timing.optional().describe("When highlights appear. Default: at 25% of the duration."),
    caption: timing.optional().describe("When the caption shows. Default: from the start."),
    fade: z.number().optional().describe("Fade length in seconds. Default 0.4."),
    grainFps: z.number().optional().describe("Animate film grain at this rate (0 = static). Default 24."),
  })
  .optional();

/**
 * Sizes a video can be made for. The App Store ones follow Apple's app preview rules: that exact
 * size, 15 to 30 seconds, 30 fps, H.264 at about 11 Mbps, with a stereo sound track.
 */
export const VIDEO_PRESETS = {
  "app-store-iphone": { width: 886, height: 1920, label: "App Store · iPhone", appStore: true },
  "app-store-iphone-landscape": { width: 1920, height: 886, label: "App Store · iPhone, landscape", appStore: true },
  "app-store-ipad": { width: 1200, height: 1600, label: "App Store · iPad", appStore: true },
  "app-store-ipad-landscape": { width: 1600, height: 1200, label: "App Store · iPad, landscape", appStore: true },
  "app-store-mac": { width: 1920, height: 1080, label: "App Store · Mac and Apple TV", appStore: true },
  vertical: { width: 1080, height: 1920, label: "Vertical 9:16 · Reels, TikTok, Shorts", appStore: false },
  portrait: { width: 1080, height: 1350, label: "Portrait 4:5 · feed posts", appStore: false },
  square: { width: 1080, height: 1080, label: "Square 1:1", appStore: false },
  widescreen: { width: 1920, height: 1080, label: "Widescreen 16:9 · YouTube, websites", appStore: false },
} as const;
export type VideoPreset = keyof typeof VIDEO_PRESETS;
export const PRESET_NAMES = Object.keys(VIDEO_PRESETS) as VideoPreset[];
/** How a design goes into a frame of another shape. */
export const FITS = ["fit", "fill", "rearrange"] as const;
export type Fit = (typeof FITS)[number];

export const VersionSchema = z.union([
  z.enum(PRESET_NAMES as [VideoPreset, ...VideoPreset[]]),
  z.object({
    size: z.union([z.enum(PRESET_NAMES as [VideoPreset, ...VideoPreset[]]), z.string().regex(/^\d{2,5}x\d{2,5}$/)]).describe('A preset, or "WIDTHxHEIGHT".'),
    fit: z.enum(FITS).optional().describe("How the design goes into this shape: fit (all of it, the backdrop filling the rest; the default for hand-placed designs), fill (fills the frame, trimming the edges), rearrange (lay it out again for this shape; the default for automatic layouts)."),
  }),
]);
export type Version = z.infer<typeof VersionSchema>;

const { format: _f, quality: _q, jpegQuality: _j, preview: _p, ...stillShape } = MockupInputShape;

export const VideoInputShape = {
  ...stillShape,
  video: VideoOptionsSchema,
  format: z.enum(["mp4", "mov", "webm", "gif"]).optional().describe("mp4 (H.264, default), mov (ProRes, keeps transparency), webm (VP9), gif."),
  quality: z.enum(["preview", "final"]).optional().describe("preview renders at half resolution for a quick check."),
  preview: z.boolean().optional().describe("Return a strip of frames from the video. Default true."),
  versions: z
    .array(VersionSchema)
    .max(9)
    .optional()
    .describe(
      `Also make it at these sizes, each its own file: ${PRESET_NAMES.map((n) => `${n} (${VIDEO_PRESETS[n].width}×${VIDEO_PRESETS[n].height})`).join(", ")}, or { size: "WIDTHxHEIGHT", fit }. App Store versions follow Apple's app preview rules (15–30 s, 30 fps, H.264, a silent stereo track).`,
    ),
};
export const VideoInputSchema = z.object(VideoInputShape);
export type VideoInput = z.infer<typeof VideoInputSchema>;

export interface VideoResult extends Omit<MockupResult, "path"> {
  path: string;
  poster: string;
  filmstrip: string;
  duration: number;
  fps: number;
  frames: number;
  /** The other sizes asked for, each its own file. */
  versions?: Array<{ name: string; label: string; path: string; poster: string; width: number; height: number; duration: number; fit: Fit; appStore: boolean; warnings?: string[] }>;
}

/**
 * How ffmpeg encodes the frames piped to it. `appStore` follows Apple's app preview rules (H.264
 * High 4.0 at about 11 Mbps, 30 fps, a silent stereo AAC track); `shot` is a sequence's shot,
 * quick and near-lossless, to be joined and encoded once more.
 */
function encoderArgs(format: string, fps: number, out: string, transparent: boolean, width: number, deliveryWidth?: number, mode: "normal" | "appStore" | "shot" = "normal"): string[] {
  const input = ["-y", "-loglevel", "error", "-f", "image2pipe", "-framerate", String(fps), "-i", "-"];
  const scale = deliveryWidth ? `scale=${deliveryWidth}:-2:flags=lanczos` : "scale=trunc(iw/2)*2:trunc(ih/2)*2";
  if (mode === "appStore") {
    return [
      ...input,
      ...["-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=48000"],
      ...["-vf", scale, "-c:v", "libx264", "-preset", "medium", "-profile:v", "high", "-level:v", "4.0", "-pix_fmt", "yuv420p"],
      ...["-b:v", "11M", "-maxrate", "12M", "-bufsize", "24M", "-r", "30"],
      ...["-c:a", "aac", "-b:a", "256k", "-ar", "48000", "-ac", "2", "-shortest", "-movflags", "+faststart", out],
    ];
  }
  if (mode === "shot") return [...input, "-vf", scale, "-c:v", "libx264", "-preset", "veryfast", "-crf", "10", "-pix_fmt", "yuv420p", out];
  switch (format) {
    case "webm":
      return [...input, "-vf", scale, "-c:v", "libvpx-vp9", "-b:v", "0", "-crf", "26", "-row-mt", "1", "-pix_fmt", transparent ? "yuva420p" : "yuv420p", out];
    case "mov":
      return [...input, "-vf", scale, "-c:v", "prores_ks", "-profile:v", transparent ? "4" : "3", "-pix_fmt", transparent ? "yuva444p10le" : "yuv422p10le", out];
    case "gif": {
      const w = deliveryWidth ?? Math.min(width, 960);
      return [...input, "-vf", `fps=${Math.min(fps, 20)},scale=${w}:-1:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=sierra2_4a`, "-loop", "0", out];
    }
    default:
      return [...input, "-vf", scale, "-c:v", "libx264", "-preset", "medium", "-crf", "16", "-pix_fmt", "yuv420p", "-movflags", "+faststart", out];
  }
}

interface CameraKey {
  t: number;
  s: number;
  x: number;
  y: number;
}

/**
 * Camera keyframes for a list of zooms: in, hold, out. A zoom that starts within 0.8 s of the last
 * one ending doesn't pull out in between: the camera glides straight to the next point.
 */
export function cameraKeys(zooms: Array<{ start: number; end: number; scale: number; x: number; y: number }>): CameraKey[] {
  const list = [...zooms].sort((a, b) => a.start - b.start);
  if (!list.length) return [{ t: 0, s: 1, x: 0.5, y: 0.5 }];
  const keys: CameraKey[] = [{ t: 0, s: 1, x: list[0].x, y: list[0].y }];
  list.forEach((z, i) => {
    const ramp = Math.min(0.9, Math.max(0.3, (z.end - z.start) / 3));
    const prev = list[i - 1];
    const next = list[i + 1];
    const follows = prev && z.start - prev.end < 0.8;
    const followed = next && next.start - z.end < 0.8;
    if (!follows) keys.push({ t: z.start, s: 1, x: z.x, y: z.y });
    keys.push({ t: z.start + ramp, s: z.scale, x: z.x, y: z.y });
    const hold = Math.max(z.start + ramp, z.end - ramp);
    keys.push({ t: hold, s: z.scale, x: z.x, y: z.y });
    if (!followed) keys.push({ t: Math.max(hold, z.end), s: 1, x: z.x, y: z.y });
  });
  // Keys must run forward in time.
  return keys.filter((k, i) => i === 0 || k.t >= keys[i - 1].t);
}

/** One frame of the scene's animations: values for devices and text, and animated shapes redrawn. */
export interface AnimFrame {
  /** `units`: a text's words or letters in reading order, each [opacity, dx, dy, scaleX, scaleY, turn, blur]. */
  els: Array<{ id: string; dx: number; dy: number; sx: number; sy: number; r: number; rx: number; ry: number; o: number; color?: string; blur?: number; mark?: number; units?: number[][] }>;
  /** Call-outs with their own timing: how far each is shown (0–1), by device and index from 0. */
  callouts: Array<{ device: string; index: number; v: number }>;
  /** Where the camera is, when the animations move it. */
  camera?: { s: number; x: number; y: number };
  /** The backdrop's own move, when the animations move it (worked out at the backdrop's size). */
  backdrop?: { transform: string; filter: string };
  shapes: Array<{ id: string; left: number; top: number; width: number; height: number; rotate: number; filter?: string; svg: string }>;
}

/** The layout's items, as the animation engine needs them. */
export function animEntities(entities: SceneEntity[] = []): AnimEntity[] {
  return entities.map((e) => ({ id: e.id, kind: e.kind, x: e.x, y: e.y, width: e.width, height: e.height, anchor: e.anchor, align: e.align, size: e.size, color: e.color, shape: e.shape, text: e.text, subtext: e.subtext, blur: e.blur }));
}

function animFrame(animations: MockupInput["animations"], entities: AnimEntity[], t: number, W: number, H: number, backdrop = { width: W, height: H }, follow?: (t: number) => { x: number; y: number } | undefined): AnimFrame {
  const frame: AnimFrame = { els: [], shapes: [], callouts: [] };
  for (const [id, st] of evaluate(animations, entities, t, W, H)) {
    if (st.shape) {
      const r = renderShape(st.shape, W, H);
      frame.shapes.push({ id, left: r.left, top: r.top, width: r.width, height: r.height, rotate: r.rotate, filter: r.filter, svg: r.svg });
    } else {
      const units = st.units?.map((u) => [u.opacity, u.dx, u.dy, u.sx, u.sy, u.rotate, u.blur]);
      frame.els.push({ id, dx: st.dx, dy: st.dy, sx: st.sx, sy: st.sy, r: st.rotate, rx: st.rotateX, ry: st.rotateY, o: st.opacity, color: st.color, blur: st.blur, mark: st.mark, units });
    }
  }
  for (const [id, v] of evaluateCallouts(animations, t)) {
    const m = CALLOUT.exec(id)!;
    frame.callouts.push({ device: `device-${m[1]}`, index: Number(m[2]) - 1, v });
  }
  const cam = evaluateCamera(animations, t, follow);
  if (cam) frame.camera = { s: cam.zoom, x: cam.x, y: cam.y };
  const bd = evaluateBackdrop(animations, t, W);
  if (bd) frame.backdrop = backdropStyle(bd, backdrop.width, backdrop.height);
  return frame;
}

/** Installed in the page: sets every animated property for time t (seconds). */
function installTimeline(cfg: {
  animated: string[];
  duration: number;
  W: number;
  H: number;
  motion: string;
  amount: number;
  keys: CameraKey[];
  cursor?: {
    device: number;
    style: "pointer" | "touch";
    size: number;
    points: Array<{ t: number; x: number; y: number; click?: boolean; drag?: boolean }>;
    /** A recording's own cursor: its path every `step` seconds, clicks, which cursor when, and how they're drawn. */
    track?: { step: number; xs: number[]; ys: number[]; clicks: Array<[number, number, number]>; kinds: Array<[number, string]>; ripple: boolean; art: typeof CURSOR_ART };
  };
  highlight?: { in?: number; out?: number };
  caption?: { in?: number; out?: number };
  fade: number;
  grainFps: number;
  /** The design's scale in the page (below 1 when it's fitted into a smaller frame). */
  s: number;
}) {
  const root = document.getElementById("canvas")!;
  // Page measurements are in the frame's pixels; the design's own are in its canvas's.
  const k = cfg.s || 1;
  const stage = document.getElementById("stage")!;
  // The menu bar and text sit over the scene: a camera the animations move takes them along.
  const overlay = document.getElementById("overlay");
  const devs = Array.from(document.querySelectorAll<HTMLElement>(".dev-wrap"));
  const videos = Array.from(document.querySelectorAll<HTMLVideoElement>("video.shot"));
  const grains = Array.from(document.querySelectorAll<HTMLElement>(".grain"));
  const backdrop = document.querySelector<HTMLElement>(".bg-move");
  // A gradient accent drawn in pieces: clipped to text, it wouldn't reach the words inside it,
  // so each piece carries its own slice of the phrase's gradient, lined up across the phrase.
  const phrases = new Map<string, HTMLElement[]>();
  document.querySelectorAll<HTMLElement>(".accent[data-acc]").forEach((acc) => {
    const owner = acc.closest("[data-ent]")?.getAttribute("data-ent") ?? "";
    const key = `${owner}|${acc.dataset.acc}`;
    phrases.set(key, [...(phrases.get(key) ?? []), acc]);
  });
  for (const spans of phrases.values()) {
    const image = getComputedStyle(spans[0]).backgroundImage;
    if (!image || image === "none") continue;
    const boxes = spans.map((sp) => sp.getBoundingClientRect());
    const left = Math.min(...boxes.map((b) => b.left));
    const top = Math.min(...boxes.map((b) => b.top));
    const width = Math.max(...boxes.map((b) => b.right)) - left;
    const height = Math.max(...boxes.map((b) => b.bottom)) - top;
    for (const sp of spans) {
      sp.querySelectorAll<HTMLElement>(".u").forEach((u) => {
        const r = u.getBoundingClientRect();
        u.style.backgroundImage = image;
        u.style.backgroundSize = `${width / k}px ${height / k}px`;
        u.style.backgroundPosition = `${(left - r.left) / k}px ${(top - r.top) / k}px`;
        u.style.setProperty("-webkit-background-clip", "text");
        u.style.setProperty("background-clip", "text");
        u.style.setProperty("-webkit-text-fill-color", "transparent");
        u.style.color = "transparent";
      });
    }
  }
  // Animated items: each one's element, and how far its visual middle sits from the point CSS
  // scales and turns it about, so it can scale and turn about its middle instead.
  const at = root.getBoundingClientRect();
  const items = new Map<string, { el: HTMLElement; vx: number; vy: number; units: HTMLElement[] }>();
  for (const id of cfg.animated) {
    const el = document.querySelector<HTMLElement>(`[data-ent="${id}"]`);
    if (!el) continue;
    const r = el.getBoundingClientRect();
    let x = 0;
    let y = 0;
    for (let n: HTMLElement | null = el; n && n !== root; n = n.offsetParent as HTMLElement | null) {
      x += n.offsetLeft;
      y += n.offsetTop;
    }
    items.set(id, { el, vx: (r.left + r.width / 2 - at.left) / k - (x + el.offsetWidth / 2), vy: (r.top + r.height / 2 - at.top) / k - (y + el.offsetHeight / 2), units: Array.from(el.querySelectorAll<HTMLElement>(".u")) });
  }
  const applyAnim = (frame: AnimFrame | undefined) => {
    if (!frame) return;
    for (const f of frame.els) {
      const it = items.get(f.id);
      if (!it) continue;
      // Scale and turn about the middle: move by the offset, plus what turning about the CSS
      // origin would have moved the middle.
      const a = (f.r * Math.PI) / 180;
      const sx = it.vx * f.sx;
      const sy = it.vy * f.sy;
      const tx = f.dx + it.vx - (sx * Math.cos(a) - sy * Math.sin(a));
      const ty = f.dy + it.vy - (sx * Math.sin(a) + sy * Math.cos(a));
      const st = it.el.style;
      st.setProperty("--ax", `${tx}px`);
      st.setProperty("--ay", `${ty}px`);
      st.setProperty("--asx", String(f.sx));
      st.setProperty("--asy", String(f.sy));
      st.setProperty("--ar", `${f.r}deg`);
      st.setProperty("--arx", `${f.rx}deg`);
      st.setProperty("--ary", `${f.ry}deg`);
      st.setProperty("--ao", String(Math.max(0, Math.min(1, f.o))));
      if (f.color) st.setProperty("--acolor", f.color);
      if (f.blur !== undefined) st.setProperty("--ablur", `${Math.max(0, f.blur)}px`);
      if (f.mark !== undefined) st.setProperty("--amark", String(Math.max(0, Math.min(1, f.mark))));
      // Words or letters, each about its own middle.
      f.units?.forEach((u, i) => {
        const piece = it.units[i]?.style;
        if (!piece) return;
        piece.opacity = String(Math.max(0, Math.min(1, u[0])));
        piece.translate = `${u[1]}px ${u[2]}px`;
        piece.scale = `${u[3]} ${u[4]}`;
        piece.rotate = `${u[5]}deg`;
        piece.filter = u[6] > 0.05 ? `blur(${u[6]}px)` : "";
      });
    }
    if (frame.backdrop && backdrop) {
      backdrop.style.transform = frame.backdrop.transform;
      backdrop.style.filter = frame.backdrop.filter;
    }
    // A call-out with its own timing: its own reveal (it rises or grows the way its style does).
    for (const c of frame.callouts) {
      document.querySelectorAll<HTMLElement>(`[data-ent="${c.device}"] [data-callout="${c.index}"]`).forEach((el) => el.style.setProperty("--hl", String(Math.max(0, Math.min(1, c.v)))));
    }
    for (const f of frame.shapes) {
      const it = items.get(f.id);
      if (!it) continue;
      const st = it.el.style;
      st.left = `${f.left}px`;
      st.top = `${f.top}px`;
      st.width = `${f.width}px`;
      st.height = `${f.height}px`;
      st.transform = f.rotate ? `rotate(${f.rotate}deg)` : "";
      st.filter = f.filter ?? "";
      it.el.innerHTML = f.svg;
    }
  };
  const ease = (x: number) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));
  const window_ = (t: number, span: { in?: number; out?: number } | undefined, f: number) => {
    if (!span) return 1;
    const a = span.in ?? 0;
    const up = a <= 0 ? 1 : ease((t - a) / f);
    const down = span.out === undefined ? 1 : 1 - ease((t - (span.out - f)) / f);
    return Math.min(up, down);
  };
  // The cursor lives on the device's screenshot, so it moves with the device.
  let cursorEl: HTMLElement | undefined;
  let ripple: HTMLElement | undefined;
  let moveCursor: (t: number) => void = () => undefined;
  if (cfg.cursor) {
    const c = cfg.cursor;
    const shot = devs[c.device]?.querySelector<HTMLElement>(".shot");
    if (shot?.parentElement) {
      const host = shot.parentElement;
      const w = shot.offsetWidth;
      const pointer = c.style === "pointer";
      const size = (pointer ? w * 0.016 : w * 0.105) * c.size;
      cursorEl = document.createElement("div");
      // The fast export draws the cursor itself: it leaves these out (.nx-cursor).
      cursorEl.className = "nx-cursor";
      cursorEl.style.cssText = `position:absolute;left:0;top:0;width:${size}px;height:${size}px;pointer-events:none;z-index:5;will-change:transform`;
      cursorEl.innerHTML = pointer
        ? `<svg viewBox="0 0 12 19" width="${size * 0.64}" height="${size}" style="display:block;overflow:visible;filter:drop-shadow(0 ${size * 0.04}px ${size * 0.08}px rgba(0,0,0,.35))"><path d="M0.6 0.6 L0.6 15.6 L4.2 12.2 L6.6 17.8 L9 16.8 L6.7 11.3 L11.4 11.3 Z" fill="#000" stroke="#fff" stroke-width="1.1" stroke-linejoin="round"/></svg>`
        : `<div class="dot" style="width:100%;height:100%;border-radius:50%;background:rgba(255,255,255,.55);box-shadow:0 0 0 ${size * 0.05}px rgba(0,0,0,.18), 0 ${size * 0.06}px ${size * 0.2}px rgba(0,0,0,.25);transform:translate(-50%,-50%)"></div>`;
      ripple = document.createElement("div");
      ripple.className = "nx-cursor";
      ripple.style.cssText = `position:absolute;left:0;top:0;width:${size * (pointer ? 2.2 : 1.4)}px;height:${size * (pointer ? 2.2 : 1.4)}px;border-radius:50%;border:${Math.max(1, size * (pointer ? 0.1 : 0.05))}px solid rgba(255,255,255,.95);box-shadow:0 0 ${size * 0.2}px rgba(0,0,0,.25);pointer-events:none;z-index:4;opacity:0`;
      host.append(ripple, cursorEl);
      if (c.track) {
        // A recording's own cursor: its path, the cursor macOS showed, a dip and a ring on each click.
        const tr = c.track;
        let shown = "";
        const draw = (kind: string) => {
          const art = tr.art[kind] ?? tr.art.arrow;
          const sc = size / art.box[1];
          cursorEl!.innerHTML = `<svg viewBox="0 0 ${art.box[0]} ${art.box[1]}" width="${art.box[0] * sc}" height="${size}" style="display:block;overflow:visible;margin:${-art.hot[1] * sc}px 0 0 ${-art.hot[0] * sc}px;filter:drop-shadow(0 ${size * 0.04}px ${size * 0.08}px rgba(0,0,0,.35))">${art.svg}</svg>`;
          shown = kind;
        };
        moveCursor = (t: number) => {
          const n = tr.xs.length;
          if (!n) return;
          const f = Math.max(0, t / tr.step);
          const i = Math.min(n - 1, Math.floor(f));
          const j = Math.min(n - 1, i + 1);
          const px = tr.xs[i] + (tr.xs[j] - tr.xs[i]) * (f - i);
          const py = tr.ys[i] + (tr.ys[j] - tr.ys[i]) * (f - i);
          let kind = "arrow";
          for (const [at, k] of tr.kinds) {
            if (at > t) break;
            kind = k;
          }
          if (kind !== shown) draw(kind);
          const x = shot.offsetLeft + px * shot.offsetWidth;
          const y = shot.offsetTop + py * shot.offsetHeight;
          const inside = px >= -0.01 && px <= 1.01 && py >= -0.01 && py <= 1.01;
          let since: number | undefined;
          let at: [number, number, number] | undefined;
          for (const c of tr.clicks) {
            if (c[0] > t + 0.06) break;
            at = c;
          }
          if (at && t - at[0] <= 0.5) since = t - at[0];
          const press = since !== undefined && since < 0.14 ? 0.86 : 1;
          cursorEl!.style.opacity = inside ? "1" : "0";
          cursorEl!.style.transformOrigin = "0 0";
          cursorEl!.style.transform = `translate(${x}px, ${y}px) scale(${press})`;
          const rs = ripple!.offsetWidth;
          if (tr.ripple && at && since !== undefined && since >= 0) {
            const k = since / 0.5;
            const rx = shot.offsetLeft + at[1] * shot.offsetWidth;
            const ry = shot.offsetTop + at[2] * shot.offsetHeight;
            ripple!.style.opacity = String(Math.max(0, 1 - k));
            ripple!.style.transform = `translate(${rx - rs / 2}px, ${ry - rs / 2}px) scale(${0.45 + k * 0.9})`;
          } else ripple!.style.opacity = "0";
        };
      } else {
        const pts = [...c.points].sort((a, b) => a.t - b.t);
        const clicks = pts.filter((p) => p.click).map((p) => p.t);
        const at = (t: number) => {
          if (t <= pts[0].t) return { x: pts[0].x, y: pts[0].y, down: false };
          for (let k = 0; k < pts.length - 1; k++) {
            const a = pts[k];
            const b = pts[k + 1];
            if (t <= b.t) {
              const p = b.t > a.t ? (t - a.t) / (b.t - a.t) : 1;
              const e = p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2;
              return { x: a.x + (b.x - a.x) * e, y: a.y + (b.y - a.y) * e, down: Boolean(a.drag) };
            }
          }
          const last = pts[pts.length - 1];
          return { x: last.x, y: last.y, down: false };
        };
        moveCursor = (t: number) => {
          const p = at(t);
          const x = shot.offsetLeft + p.x * shot.offsetWidth;
          const y = shot.offsetTop + p.y * shot.offsetHeight;
          // A press dips the cursor; each click sends out a ring.
          const near = clicks.map((c) => t - c).filter((d) => d >= -0.08 && d <= 0.45);
          const since = near.length ? Math.max(...near) : undefined;
          const press = p.down || (since !== undefined && since < 0.14) ? (pointer ? 0.86 : 0.84) : 1;
          cursorEl!.style.transform = `translate(${x}px, ${y}px) scale(${press})`;
          cursorEl!.style.transformOrigin = "0 0";
          if (!pointer) (cursorEl!.firstElementChild as HTMLElement).style.background = p.down || press < 1 ? "rgba(255,255,255,.8)" : "rgba(255,255,255,.55)";
          const rs = ripple!.offsetWidth;
          if (since !== undefined && since >= 0) {
            const k = since / 0.45;
            ripple!.style.opacity = String(Math.max(0, 1 - k));
            ripple!.style.transform = `translate(${x - rs / 2}px, ${y - rs / 2}px) scale(${0.45 + k * 0.9})`;
          } else ripple!.style.opacity = "0";
        };
      }
    }
  }

  (window as any).__setTime = async (t: number, frame?: AnimFrame) => {
    applyAnim(frame);
    const { W, H, duration: D, amount: A } = cfg;
    devs.forEach((d, i) => {
      const ph = i * 1.3;
      const w = (period: number) => Math.sin((2 * Math.PI * t) / period + ph);
      let dx = 0, dy = 0, dr = 0, drx = 0, dry = 0;
      if (cfg.motion === "subtle") {
        dy = w(6) * 0.004 * H * A;
        dr = w(7.5) * 0.35 * A;
      } else if (cfg.motion === "float") {
        dy = w(5) * 0.012 * H * A;
        drx = w(6.3) * 2.2 * A;
        dry = Math.cos((2 * Math.PI * t) / 7.1 + ph) * 3 * A;
      } else if (cfg.motion === "drift") {
        const k = ease(t / D);
        dx = (k - 0.5) * 0.03 * W * A;
        dry = (0.5 - k) * 8 * A;
        dy = w(6) * 0.003 * H * A;
      }
      d.style.setProperty("--dx", `${dx}px`);
      d.style.setProperty("--dy", `${dy}px`);
      d.style.setProperty("--dr", `${dr}deg`);
      d.style.setProperty("--drx", `${drx}deg`);
      d.style.setProperty("--dry", `${dry}deg`);
    });
    // The camera: glide through the keys (scale and focus), easing in and out of each.
    const keys = cfg.keys;
    let cam = keys[0] ?? { t: 0, s: 1, x: 0.5, y: 0.5 };
    // A camera the animations move takes over from the zooms.
    if (frame?.camera) cam = { t, ...frame.camera };
    else for (let k = 0; k < keys.length - 1; k++) {
      const a = keys[k];
      const b = keys[k + 1];
      if (t >= a.t && t <= b.t) {
        const p = b.t > a.t ? (t - a.t) / (b.t - a.t) : 1;
        const e = p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2;
        cam = { t, s: a.s + (b.s - a.s) * e, x: a.x + (b.x - a.x) * e, y: a.y + (b.y - a.y) * e };
        break;
      }
      if (t > b.t) cam = b;
    }
    let zoom = cam.s;
    if (cfg.motion === "push-in") zoom *= 1 + 0.07 * A * ease(t / D);
    // Zoomed in, the focus drifts toward the middle of the frame, never showing past an edge.
    const fx = cam.x * W;
    const fy = cam.y * H;
    const clampC = (f: number, c: number, size: number) => Math.min(f * zoom, Math.max(size - (size - f) * zoom, c));
    const cx = clampC(fx, fx + (W / 2 - fx) * (1 - 1 / zoom), W);
    const cy = clampC(fy, fy + (H / 2 - fy) * (1 - 1 / zoom), H);
    stage.style.transformOrigin = `${fx}px ${fy}px`;
    stage.style.transform = `translate(${cx - fx}px, ${cy - fy}px) scale(${zoom})`;
    if (overlay) {
      overlay.style.transformOrigin = stage.style.transformOrigin;
      overlay.style.transform = frame?.camera ? stage.style.transform : "";
    }
    if (cursorEl && cfg.cursor) moveCursor(t);
    root.style.setProperty("--hl", String(window_(t, cfg.highlight, cfg.fade)));
    root.style.setProperty("--cap", String(window_(t, cfg.caption, cfg.fade)));
    if (cfg.grainFps > 0) {
      const k = Math.floor(t * cfg.grainFps);
      grains.forEach((g) => {
        g.style.setProperty("--gx", `${(k * 73) % 220}px`);
        g.style.setProperty("--gy", `${(k * 151) % 220}px`);
      });
    }
    await Promise.all(
      videos.map(
        (v) =>
          new Promise<void>((resolve) => {
            const target = Math.min(t, Math.max(0, (v.duration || 0) - 0.05));
            if (!Number.isFinite(target) || Math.abs(v.currentTime - target) < 0.001) return resolve();
            const done = () => resolve();
            v.addEventListener("seeked", done, { once: true });
            v.currentTime = target;
            setTimeout(done, 3000);
          }),
      ),
    );
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  };
}

/**
 * The scene loaded in a page with its timeline installed: set a time, then take a picture.
 * `scale` is the device scale factor (1 for full size). Close it when done.
 */
export async function openStage(input: VideoInput, scale: number, o: { frame?: SceneFrame; length?: [number, number] } = {}) {
  const opts = input.video ?? {};
  const motion = opts.motion ?? input.motion ?? "subtle";
  const zoomList = [...(opts.zoom ? [opts.zoom] : []), ...(opts.zooms ?? [])];
  for (const z of zoomList) {
    if (!(z.end > z.start)) throw new Error(`A zoom's end (${z.end}s) must be after its start (${z.start}s).`);
  }
  const animations = input.animations ?? [];
  // Items whose blur is animated take it from the timeline each frame (rack focus, focus-in).
  const blurred = new Set(animations.filter((a) => a.to?.blur !== undefined || a.from?.blur !== undefined || a.enter === "blur" || a.exit === "blur").flatMap(targetsOf).filter((id) => id !== BACKDROP));
  const scene = await buildScene(
    { ...input, format: undefined, quality: undefined } as MockupInput,
    { motion3d: motion === "float" || motion === "drift" || uses3d(animations), blurred },
    o.frame,
  );
  const ents = animEntities(scene.result.entities);
  // Call-outs are named by device and number: check they exist.
  const callouts = [...new Set(animations.flatMap(targetsOf).filter((id) => CALLOUT.test(id)))];
  const missing = callouts.filter((id) => {
    const m = CALLOUT.exec(id)!;
    return !(input.devices[Number(m[1]) - 1]?.highlights?.length! >= Number(m[2]));
  });
  if (missing.length) (scene.result.warnings ??= []).push(`Animations name ${missing.map((u) => `"${u}"`).join(", ")}: no such call-out. A device's call-outs are its highlights, counted from 1 ("device-1/callout-1").`);
  const unknown = [...animatedIds(animations)].filter((id) => !ents.some((e) => e.id === id));
  if (unknown.length) (scene.result.warnings ??= []).push(`Animations name ${unknown.map((u) => `"${u}"`).join(", ")}, which ${unknown.length === 1 ? "isn't" : "aren't"} in the scene; ids are ${ents.map((e) => e.id).join(", ")}.`);
  const W = scene.width;
  const H = scene.height;
  // The page: the design's canvas, or the frame it's fitted into (whose backdrop fills the frame).
  const view = scene.view;
  const backdrop = o.frame?.fit === "fit" ? { width: view.width, height: view.height } : { width: W, height: H };
  const hasHighlights = input.devices.some((d) => d.highlights?.length);

  const dir = await mkdtemp(path.join(tmpdir(), "screenshotter-video-"));
  const htmlFile = path.join(dir, "scene.html");
  await writeFile(htmlFile, scene.html);
  const page = await newPage();
  const close = async () => {
    await page.close().catch(() => undefined);
    await rm(dir, { recursive: true, force: true });
  };
  let duration = opts.duration ?? 6;
  let natural = duration;
  // A recording's camera gliding after its cursor (`follow`), and its cursor (for the fast export).
  let follow: ((t: number) => { x: number; y: number } | undefined) | undefined;
  let cursorTrack: NonNullable<Parameters<typeof installTimeline>[0]["cursor"]>["track"];
  // What the page was given to play the timeline (the fast export works the same things out).
  let timeline: Parameters<typeof installTimeline>[0] | undefined;
  try {
    await page.setViewport({ width: Math.round(view.width), height: Math.round(view.height), deviceScaleFactor: scale });
    await page.goto(pathToFileURL(htmlFile).href, { waitUntil: "load", timeout: 90_000 });
    const videoLength = await page.evaluate(async () => {
      await Promise.race([document.fonts.ready, new Promise((r) => setTimeout(r, 8000))]);
      await Promise.all(Array.from(document.images).map((img) => (img.complete ? Promise.resolve() : img.decode().catch(() => undefined))));
      const vids = Array.from(document.querySelectorAll("video"));
      await Promise.all(
        vids.map((v) => (v.readyState >= 2 ? Promise.resolve() : new Promise((r) => { v.addEventListener("loadeddata", r, { once: true }); setTimeout(r, 10000); }))),
      );
      return Math.max(0, ...vids.map((v) => v.duration || 0));
    });
    if (!opts.duration && videoLength > 1) duration = Math.min(60, videoLength);
    // Kept to the length asked for, up to the longest a video can be.
    duration = Math.min(MAX_LENGTH, duration);
    // Long enough for every animation to finish, with a moment to take it in.
    if (!opts.duration && animations.length) duration = Math.min(60, Math.max(duration, timelineEnd(animations, ents) + 1.2));
    // A length it must keep to (an App Store preview's 15 to 30 s, a shot's own length).
    natural = duration;
    if (o.length) duration = Math.min(o.length[1], Math.max(o.length[0], duration));

    // Each zoom's focus: its x/y, else a highlight on screen (the first by default), else the centre.
    const spots = await page.evaluate(() => {
      const at = document.getElementById("canvas")!.getBoundingClientRect();
      return Array.from(document.querySelectorAll(".hl .hlx, .hlx")).map((el) => {
        const r = el.getBoundingClientRect();
        return { x: (r.left + r.width / 2 - at.left) / at.width, y: (r.top + r.height / 2 - at.top) / at.height };
      });
    });
    const zooms = zoomList.map((z) => {
      const spot = spots[("highlight" in z && typeof z.highlight === "number" ? z.highlight : undefined) ?? 0];
      return { start: z.start, end: z.end, scale: z.scale ?? 1.8, x: z.x ?? spot?.x ?? 0.5, y: z.y ?? spot?.y ?? 0.5 };
    });
    // Pointer for Macs and browser/window frames, a fingertip elsewhere.
    const cursorDevice = opts.cursor?.device ?? 0;
    const cursorFrame = scene.result.entities?.find((e) => e.kind === "device" && e.index === cursorDevice);
    const pointerDefault = cursorFrame?.frame === "browser" || cursorFrame?.frame === "window" || /MacBook|iMac/i.test(cursorFrame?.device ?? "");
    // A recording's own cursor, from the log the capture bar kept beside it.
    let track: NonNullable<Parameters<typeof installTimeline>[0]["cursor"]>["track"];
    if (opts.cursor?.log) {
      try {
        const log = readLog(JSON.parse(readFileSync(opts.cursor.log, "utf8")));
        const t = trackOf(log, opts.cursor.smooth ?? 0.5);
        const r4 = (v: number) => Math.round(v * 10000) / 10000;
        track = { step: t.step, xs: t.xs.map(r4), ys: t.ys.map(r4), clicks: t.clicks, kinds: t.kinds, ripple: opts.cursor.ripple ?? true, art: CURSOR_ART };
        cursorTrack = track;
        // The camera follows a calmer path than the cursor's own.
        if (opts.follow && cursorFrame) {
          const calm = trackOf(log, 1);
          const w = cursorFrame.width ?? 1;
          const h = cursorFrame.height ?? 1;
          const box = { x: cursorFrame.x - w / 2, y: cursorFrame.y - h / 2, w, h };
          follow = (t: number) => {
            const p = cursorAt(calm, t);
            return p && { x: box.x + p.x * box.w, y: box.y + p.y * box.h };
          };
        }
      } catch (e) {
        (scene.result.warnings ??= []).push(`The cursor log couldn't be read (${(e as Error).message}); the video has no cursor.`);
      }
    }

    timeline = {
      animated: [...animatedIds(animations)],
      duration,
      W,
      H,
      motion,
      amount: opts.motionAmount ?? 1,
      keys: cameraKeys(zooms),
      cursor:
        opts.cursor && (opts.cursor.points?.length || track)
          ? { device: cursorDevice, style: track ? "pointer" : (opts.cursor.style ?? (pointerDefault ? "pointer" : "touch")), size: opts.cursor.size ?? 1, points: opts.cursor.points ?? [], track }
          : undefined,
      highlight: opts.highlight ?? (hasHighlights ? { in: duration * 0.25 } : undefined),
      caption: opts.caption,
      fade: opts.fade ?? 0.4,
      grainFps: opts.grainFps ?? 24,
      s: view.scale,
    };
    await page.evaluate(installTimeline, timeline);
  } catch (e) {
    await close();
    throw e;
  }
  /** Show the scene as it is at `t` seconds. */
  const setTime = (t: number) => page.evaluate((t, f) => (window as any).__setTime(t, f), t, animFrame(animations, ents, t, W, H, backdrop, follow));
  // What to photograph: the whole page.
  const clip = { x: 0, y: 0, width: Math.round(view.width), height: Math.round(view.height) };
  return { page, dir, scene, ents, animations, W, H, view, clip, duration, natural, setTime, close, backdrop, follow, cursorTrack, scale, timeline: timeline!, frameAt: (t: number) => animFrame(animations, ents, t, W, H, backdrop, follow) };
}

/** A moment's label: as precise as it was asked for (1 s, 1.5 s, 1.25 s, 1.125 s). */
const clock = (t: number) => `${Number(t.toFixed(3))} s`;

/** Frames side by side (or in rows), each with a label: a filmstrip, or a storyboard of key moments. */
async function composeSheet(files: string[], labels: string[], aspect: number, out: string, grid: boolean): Promise<void> {
  const portrait = aspect < 1;
  const cols = grid ? Math.min(files.length, portrait ? 4 : 3) : files.length;
  // More frames, smaller ones, so the sheet stays a sensible size.
  const tileH = grid ? (portrait ? (files.length > 8 ? 480 : 640) : files.length > 9 ? 280 : 380) : 900;
  const tileW = Math.round(tileH * aspect);
  const rows = Math.ceil(files.length / cols);
  const gap = grid ? 8 : 12;
  const html = `<!doctype html><html><body style="margin:0;background:#111"><div style="display:grid;grid-template-columns:repeat(${cols}, ${tileW}px);gap:${gap}px;padding:${gap}px">${files
    .map((f, k) => `<div style="position:relative"><img src="${pathToFileURL(f).href}" style="height:${tileH}px;width:${tileW}px;display:block;border-radius:8px"><div style="position:absolute;left:${grid ? 8 : 12}px;top:${grid ? 7 : 10}px;padding:${grid ? "2px 8px" : "0"};border-radius:6px;${grid ? "background:rgba(0,0,0,.72);" : ""}font:600 ${grid ? 17 : 28}px system-ui;color:#fff;text-shadow:0 1px 4px #000">${labels[k]}</div></div>`)
    .join("")}</div></body></html>`;
  await renderHtml(html, out, (tileW + gap) * cols + gap, (tileH + gap) * rows + gap, { scale: 1, format: "jpeg", transparent: false });
}

export interface Storyboard {
  /** The sheet: one picture with a frame per moment, left to right, top to bottom. */
  path: string;
  /** The moment each frame shows, in seconds. */
  times: number[];
  duration: number;
  warnings?: string[];
}

/** Most frames one storyboard shows. */
export const MAX_MOMENTS = 16;

/**
 * The video at chosen moments, without rendering the video. `times` picks them (seconds, to the
 * millisecond); `every` takes one each so many seconds; otherwise the key moments: the start, the
 * end of each animation, the middle of long ones, and the settled end.
 */
export async function storyboard(input: VideoInput, o: { max?: number; output?: string; times?: number[]; every?: number; frame?: SceneFrame } = {}): Promise<Storyboard> {
  input = await applyCuts(input);
  const canvas: { width: number; height: number } = o.frame ? o.frame : (await layoutScene({ ...input, format: undefined, quality: undefined } as MockupInput)).canvas;
  // Each frame a little sharper than the tile it's shown in.
  const tileH = canvas.width < canvas.height ? 640 : 380;
  const stage = await openStage(input, Math.min(1, (tileH * 1.4) / canvas.height), { frame: o.frame });
  try {
    const { page, clip, duration } = stage;
    const chosen = o.times?.length ? o.times : o.every && o.every > 0 ? Array.from({ length: Math.floor(duration / o.every) + 1 }, (_, i) => i * o.every!) : undefined;
    const times = chosen
      ? [...new Set(chosen.map((t) => Math.round(Math.min(duration, Math.max(0, t)) * 1000) / 1000))].sort((p, q) => p - q).slice(0, MAX_MOMENTS)
      : keyMoments(stage.animations, stage.ents, duration, Math.min(o.max ?? 8, MAX_MOMENTS));
    const files: string[] = [];
    for (const [i, t] of times.entries()) {
      await stage.setTime(t);
      const f = path.join(stage.dir, `moment-${i}.jpg`) as `${string}.jpg`;
      await page.screenshot({ path: f, type: "jpeg", quality: 88, clip, optimizeForSpeed: true });
      files.push(f);
    }
    const out = o.output ?? path.join(cacheDir("storyboards"), `storyboard-${Date.now()}-${Math.round(Math.random() * 1e6)}.jpg`);
    await composeSheet(files, times.map(clock), clip.width / clip.height, out, true);
    return { path: out, times, duration, warnings: stage.scene.result.warnings?.length ? stage.scene.result.warnings : undefined };
  } finally {
    await stage.close();
  }
}

/** How far along an export is, 0 to 1. */
export type Progress = (fraction: number) => void;

export interface RenderOptions {
  /** Told how far along it is as frames are drawn. */
  progress?: Progress;
  /** A frame of another shape (a preset's size) to show the design in. */
  frame?: SceneFrame;
  /** Follow Apple's app preview rules: 15 to 30 s, 30 fps, H.264, a silent stereo track. */
  appStore?: boolean;
  /** Seconds it must run between. */
  length?: [number, number];
  /** A sequence's shot: near-lossless, and no poster or filmstrip. */
  shot?: boolean;
  /** Where to write it, instead of input.output. */
  output?: string;
}

/** Render an animated mockup to a video file, or to each size asked for in `versions` as well. */
export async function createVideo(input: VideoInput, opts: { progress?: Progress } = {}): Promise<VideoResult> {
  // Each size an equal share of the progress.
  const n = 1 + (input.versions?.length ?? 0);
  const main = await renderVideo(input, { progress: opts.progress && ((f) => opts.progress!(f / n)) });
  if (!input.versions?.length) return main;
  const versions: NonNullable<VideoResult["versions"]> = [];
  for (const [k, v] of input.versions.entries()) {
    const spec = versionSpec(v, input.layout);
    const format = spec.appStore ? "mp4" : main.path.split(".").pop()!;
    const out = main.path.replace(/\.[a-z0-9]+$/i, `.${spec.name}.${format}`);
    const r = await renderVideo(spec.fit === "rearrange" ? { ...input, canvas: `${spec.width}x${spec.height}`, deliveryWidth: undefined } : { ...input, deliveryWidth: undefined }, {
      frame: spec.fit === "rearrange" ? undefined : { width: spec.width, height: spec.height, fit: spec.fit },
      appStore: spec.appStore,
      length: spec.appStore ? [15, 30] : undefined,
      output: out,
      progress: opts.progress && ((f) => opts.progress!((k + 1 + f) / n)),
    });
    versions.push({ name: spec.name, label: spec.label, path: r.path, poster: r.poster, width: r.width, height: r.height, duration: r.duration, fit: spec.fit, appStore: spec.appStore, warnings: r.warnings });
  }
  return { ...main, versions };
}

/** A version's size, name and how the design goes into it (fit for hand-placed designs, else laid out again). */
export function versionSpec(v: Version, layout?: string): { name: string; label: string; width: number; height: number; fit: Fit; appStore: boolean } {
  const size = typeof v === "string" ? v : v.size;
  const preset = (VIDEO_PRESETS as Record<string, (typeof VIDEO_PRESETS)[VideoPreset]>)[size];
  const [w, h] = preset ? [preset.width, preset.height] : size.split("x").map(Number);
  const fit = (typeof v === "object" && v.fit) || (layout === "custom" ? "fit" : "rearrange");
  return { name: preset ? size : `${w}x${h}`, label: preset?.label ?? `${w} × ${h}`, width: w, height: h, fit, appStore: preset?.appStore ?? false };
}

/** Whether a file has a sound track. */
const hasSound = (file: string) => mediaInfo(file).then((i) => i.sound, () => false);

/**
 * A piece of the video's sound: `from`–`to` seconds of a file, starting `at` seconds into the video
 * (and cut off at `until`, the end of its shot in a video of several).
 */
export type SoundPiece = { src: string; at: number; from: number; to?: number; volume?: number; fadeIn?: number; fadeOut?: number; until?: number };

/** The video's sound: the pieces the design gives (`sounds`), or each device recording's own, whole, from the start. */
export function soundPieces(input: VideoInput): SoundPiece[] {
  const local = (p: string) => p.replace(/^file:\/\//, "");
  if (input.sounds) return input.sounds.map((p) => ({ ...p, src: local(p.src), from: p.from ?? 0 }));
  const videos = (input.devices ?? []).map((d) => d.video).filter((v): v is string => Boolean(v));
  return [...new Set(videos.map(local))].map((src) => ({ src, at: 0, from: 0 }));
}

/** How long a file runs, in seconds (0 when it can't be told). */
export const mediaLength = (file: string) => mediaInfo(file).then((i) => i.length, () => 0);

/**
 * The sound under the finished frames: each piece cut from its file, turned up or down, faded,
 * placed at its time, and all mixed, cut to the video's length. The picture is copied as it is.
 */
export async function addSound(out: string, format: string, pieces: SoundPiece[], duration: number, warnings: string[]): Promise<void> {
  const voiced = new Set<string>();
  for (const f of new Set(pieces.map((p) => p.src))) if (await hasSound(f)) voiced.add(f);
  // Each piece's end in its file: as given, else the file's end; then cut off at its shot's end.
  const ends = new Map<SoundPiece, number>();
  for (const p of pieces) {
    if (!voiced.has(p.src)) continue;
    let end = p.to ?? (await mediaLength(p.src));
    if (p.until !== undefined) end = Math.min(end, p.from + (p.until - p.at));
    ends.set(p, end);
  }
  const used = pieces.filter((p) => ends.has(p) && p.at < duration && ends.get(p)! > p.from + 0.01 && (p.volume ?? 1) > 0);
  if (!used.length) return;
  const files = [...voiced].filter((f) => used.some((p) => p.src === f));
  // Where one piece carries straight on from another (cut, not moved), there's no seam to soften.
  const flows = (a: SoundPiece, b: SoundPiece) => a.src === b.src && Math.abs(a.at + (ends.get(a)! - a.from) - b.at) < 0.002 && Math.abs(ends.get(a)! - b.from) < 0.002;
  const DECLICK = 0.008;
  const chains = used.map((p, k) => {
    const end = ends.get(p)!;
    const len = Math.max(0.01, end - p.from);
    // Every piece in one format (files differ in rate and channels), so they mix.
    const f = [`atrim=start=${p.from.toFixed(4)}:end=${end.toFixed(4)}`, "asetpts=PTS-STARTPTS", "aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo"];
    if (p.volume !== undefined && p.volume !== 1) f.push(`volume=${p.volume.toFixed(3)}`);
    // Its fades; and at a cut (a seam with nothing carrying on), a few milliseconds' fade so it doesn't click.
    const fadeIn = p.fadeIn || (used.some((o) => o !== p && flows(o, p)) || p.from < 0.001 ? 0 : DECLICK);
    const fadeOut = p.fadeOut || (used.some((o) => o !== p && flows(p, o)) ? 0 : DECLICK);
    if (fadeIn) f.push(`afade=t=in:st=0:d=${Math.min(fadeIn, len).toFixed(3)}`);
    if (fadeOut) f.push(`afade=t=out:st=${Math.max(0, len - fadeOut).toFixed(3)}:d=${Math.min(fadeOut, len).toFixed(3)}`);
    if (p.at > 0) f.push(`adelay=delays=${Math.round(p.at * 1000)}:all=1`);
    return `[${files.indexOf(p.src) + 1}:a:0]${f.join(",")}[s${k}]`;
  });
  const graph = `${chains.join(";")};${used.map((_, k) => `[s${k}]`).join("")}amix=inputs=${used.length}:normalize=0:dropout_transition=0[a]`;
  const tmp = out.replace(/(\.[a-z0-9]+)$/i, ".sound$1");
  const codec = format === "webm" ? ["-c:a", "libopus", "-b:a", "160k"] : ["-c:a", "aac", "-b:a", "192k"];
  const args = ["-y", "-loglevel", "error", "-i", out, ...files.flatMap((f) => ["-i", f]), "-filter_complex", graph, "-map", "0:v", "-map", "[a]", "-c:v", "copy", ...codec, "-t", duration.toFixed(3), ...(format === "mp4" ? ["-movflags", "+faststart"] : []), tmp];
  const err = await new Promise<string | null>((resolve) => {
    const p = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
    let e = "";
    p.stderr.on("data", (d) => (e += d));
    p.on("error", (x) => resolve(x.message));
    p.on("exit", (c) => resolve(c === 0 ? null : e.trim().split("\n").slice(-2).join(" ") || `exit ${c}`));
  });
  if (err) {
    rmSync(tmp, { force: true });
    warnings.push(`The sound couldn't be added (${err}); the video is silent.`);
    return;
  }
  const { renameSync } = await import("node:fs");
  renameSync(tmp, out);
}

/** A silent stereo track under a video (Apple's app previews must have one). */
async function silentTrack(out: string): Promise<void> {
  const tmp = out.replace(/(\.[a-z0-9]+)$/i, ".audio$1");
  await new Promise<void>((resolve, reject) => {
    const p = spawn("ffmpeg", ["-y", "-loglevel", "error", "-i", out, "-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=48000", "-map", "0:v", "-map", "1:a", "-c:v", "copy", "-c:a", "aac", "-b:a", "256k", "-ar", "48000", "-ac", "2", "-shortest", "-movflags", "+faststart", tmp], { stdio: ["ignore", "ignore", "pipe"] });
    p.on("error", reject);
    p.on("exit", (c) => (c === 0 ? resolve() : reject(new Error(`ffmpeg couldn't add the sound track (${c})`))));
  });
  const { renameSync } = await import("node:fs");
  renameSync(tmp, out);
}

/** A still of a finished video at `t`. */
const stillOf = (video: string, t: number, file: string, duration: number) =>
  new Promise<void>((resolve, reject) => {
    const p = spawn("ffmpeg", ["-y", "-loglevel", "error", "-ss", Math.max(0, Math.min(duration - 0.05, t)).toFixed(3), "-i", video, "-frames:v", "1", "-q:v", "3", file], { stdio: ["ignore", "ignore", "pipe"] });
    p.on("error", reject);
    p.on("exit", (c) => (c === 0 ? resolve() : reject(new Error(`ffmpeg couldn't take a still (${c})`))));
  });

/** Render one video: the design at its own size, or in a frame, as a delivery file or a sequence's shot. */
/**
 * A video's devices with the parts of their recordings taken out (`cuts`) as files that play
 * without them, sound and all, and its logged cursor with them taken out too. Done once: the
 * result has no cuts left.
 */
export async function applyCuts(input: VideoInput): Promise<VideoInput> {
  if (!input.devices?.some((d) => d.video && d.cuts?.length)) return input;
  const devices = await Promise.all(
    input.devices.map(async (d) => {
      if (!d.cuts) return d;
      const { cuts, ...rest } = d;
      return d.video && cuts.length ? { ...rest, video: await cutVideo(d.video, cuts) } : rest;
    }),
  );
  const c = input.video?.cursor;
  const cuts = input.devices[c?.device ?? 0]?.cuts;
  const video = c?.log && cuts?.length ? { ...input.video, cursor: { ...c, log: cutLogFile(c.log, cuts) } } : input.video;
  return { ...input, devices, video };
}

export async function renderVideo(input: VideoInput, o: RenderOptions = {}): Promise<VideoResult> {
  input = await applyCuts(input);
  const opts = input.video ?? {};
  const format = o.shot || o.appStore ? "mp4" : formatFor(input.format, o.output ?? input.output, ["mp4", "mov", "webm", "gif"] as const, "mp4", { m4v: "mp4" });
  const fps = o.appStore ? 30 : (opts.fps ?? 30);
  const preview = input.quality === "preview" && !o.appStore;
  let stage = await openStage(input, preview ? 0.5 : 1, { frame: o.frame, length: o.length });
  // The fast way first: the Mac app draws it on the GPU (when it runs the engine).
  if (fastAvailable(input)) {
    const out = o.output ?? outputPathFor(input.output, "videos", `video-${stage.scene.layout}`, format);
    const warnings = [...(stage.scene.result.warnings ?? [])];
    try {
      const { scene, ents, animations, duration } = stage;
      const r = await renderFast(input, stage as unknown as FastStage, out, fps, { format, shot: o.shot, appStore: o.appStore, deliveryWidth: o.appStore || o.shot ? undefined : input.deliveryWidth, progress: o.progress });
      if (o.appStore) await silentTrack(out);
      else if (opts.sound && format !== "gif" && !o.shot) await addSound(out, format, soundPieces(input), duration, warnings);
      const size = { width: r.width, height: r.height };
      if (o.shot) {
        await stage.close();
        return { path: out, poster: "", filmstrip: "", ...size, duration, fps, frames: r.frames, ...scene.result, warnings };
      }
      // Poster and filmstrip from the finished video.
      const poster = out.replace(/\.[a-z0-9]+$/i, ".poster.jpg");
      const from = out;
      await stillOf(from, animations.length ? Math.min(duration, timelineEnd(animations, ents)) : duration * 0.5, poster, duration);
      const times = animations.length ? keyMoments(animations, ents, duration) : [0.1, 0.3, 0.5, 0.7, 0.9].map((p) => p * duration);
      const strip: string[] = [];
      for (const [n, t] of times.entries()) {
        const f = path.join(stage.dir, `strip-${n}.jpg`);
        await stillOf(from, t, f, duration);
        strip.push(f);
      }
      const filmstrip = out.replace(/\.[a-z0-9]+$/i, ".filmstrip.jpg");
      await composeSheet(strip, times.map(clock), r.width / r.height, filmstrip, animations.length > 0);
      writeFileSync(`${out}.mockup.json`, JSON.stringify({ ...input, output: out }, null, 2));
      o.progress?.(1);
      await stage.close();
      return { path: out, poster, filmstrip, ...size, duration, fps, frames: r.frames, ...scene.result, warnings };
    } catch (e) {
      // The usual export instead, on a fresh page.
      rmSync(out, { force: true });
      await stage.close();
      stage = await openStage(input, preview ? 0.5 : 1, { frame: o.frame, length: o.length });
      (stage.scene.result.warnings ??= []).push(`The fast export didn't work (${(e as Error).message}), so this one took the usual way.`);
    }
  }
  const { page, dir, scene, ents, animations, clip, duration } = stage;
  const out = o.output ?? outputPathFor(input.output, "videos", `video-${scene.layout}`, format);
  const warnings = [...(scene.result.warnings ?? [])];
  if (o.appStore && stage.natural < 15) warnings.push(`Held the end for ${(15 - stage.natural).toFixed(1)} s more: an App Store preview runs at least 15 seconds.`);
  if (o.appStore && stage.natural > 30) warnings.push(`Cut at 30 s, the longest an App Store preview can be (it ran ${stage.natural.toFixed(1)} s).`);
  let frames = 0;
  const strip: string[] = [];
  const stripLabels: string[] = [];
  const stripTimes = new Map<number, number>();
  try {
    const transparent = scene.transparent && (format === "mov" || format === "webm");
    const ffmpeg = spawn("ffmpeg", encoderArgs(format, fps, out, transparent && !o.shot, clip.width, o.appStore || o.shot ? undefined : input.deliveryWidth, o.appStore ? "appStore" : o.shot ? "shot" : "normal"), { stdio: ["pipe", "ignore", "pipe"] });
    let ffErr = "";
    let ffFailed: Error | undefined;
    ffmpeg.stderr.on("data", (d) => (ffErr += d));
    // Missing ffmpeg or a crashed encoder must surface as an error, never as an uncaught event.
    ffmpeg.on("error", (e) => {
      ffFailed = (e as NodeJS.ErrnoException).code === "ENOENT" ? new Error("ffmpeg isn't installed. Install it with `brew install ffmpeg`.") : e;
    });
    ffmpeg.stdin.on("error", (e) => {
      ffFailed ??= new Error(`ffmpeg stopped accepting frames: ${ffErr.trim() || e.message}`);
    });
    const ffDone = new Promise<number | null>((resolve) => {
      ffmpeg.on("exit", resolve);
      ffmpeg.on("error", () => resolve(null));
    });
    try {
      const total = Math.max(1, Math.round(duration * fps));
      // The filmstrip: an animated design's key moments, else four frames spread across it.
      for (const t of animations.length ? keyMoments(animations, ents, duration) : []) stripTimes.set(Math.min(total - 1, Math.round(t * fps)), t);
      const stripAt = o.shot ? new Set<number>() : animations.length ? new Set(stripTimes.keys()) : new Set([0, Math.round(total * 0.33), Math.round(total * 0.66), total - 1]);
      for (let i = 0; i < total; i++) {
        if (ffFailed) throw ffFailed;
        await stage.setTime(i / fps);
        const buf = (await page.screenshot({
          type: transparent ? "png" : "jpeg",
          quality: transparent ? undefined : 94,
          clip,
          omitBackground: transparent,
          optimizeForSpeed: true,
        })) as Uint8Array;
        if (stripAt.has(i)) {
          const f = path.join(dir, `strip-${i}.${transparent ? "png" : "jpg"}`);
          writeFileSync(f, buf);
          strip.push(f);
          stripLabels.push(stripTimes.has(i) ? clock(stripTimes.get(i)!) : ["0%", "33%", "66%", "100%"][stripLabels.length]);
        }
        if (ffFailed) throw ffFailed;
        if (!ffmpeg.stdin.write(buf)) {
          // Wait for ffmpeg to catch up (or die), then drop both listeners so they don't pile up.
          await new Promise<void>((r) => {
            const done = () => {
              ffmpeg.stdin.off("drain", done);
              ffmpeg.off("exit", done);
              r();
            };
            ffmpeg.stdin.once("drain", done);
            ffmpeg.once("exit", done);
          });
        }
        frames++;
        o.progress?.(frames / total);
      }
      ffmpeg.stdin.end();
      const code = await ffDone;
      if (ffFailed) throw ffFailed;
      if (code !== 0) throw new Error(`ffmpeg failed (${code}): ${ffErr.trim().split("\n").slice(-3).join(" ")}`);
      if (opts.sound && format !== "gif" && !o.shot) await addSound(out, format, soundPieces(input), duration, warnings);
    } catch (e) {
      if (ffmpeg.exitCode === null) ffmpeg.kill("SIGKILL");
      rmSync(out, { force: true });
      throw e;
    }

    const W = clip.width;
    const H = clip.height;
    const width = o.appStore || o.shot ? W : (input.deliveryWidth ?? (preview ? Math.round(W / 2) : W));
    const size = { width, height: Math.round((H * width) / W) };
    if (o.shot) return { path: out, poster: "", filmstrip: "", ...size, duration, fps, frames, ...scene.result, warnings };
    // Poster (first frame at full quality) and a filmstrip for a quick visual check.
    const poster = out.replace(/\.[a-z0-9]+$/i, ".poster.jpg");
    const posterAt = animations.length ? Math.min(duration, timelineEnd(animations, ents)) : Math.min(duration * 0.5, duration);
    await stage.setTime(posterAt);
    await page.screenshot({ path: poster as `${string}.jpeg`, type: "jpeg", quality: 90, clip });
    const filmstrip = out.replace(/\.[a-z0-9]+$/i, ".filmstrip.jpg");
    await composeSheet(strip, stripLabels, W / H, filmstrip, animations.length > 0);
    writeFileSync(`${out}.mockup.json`, JSON.stringify({ ...input, output: out }, null, 2));
    return { path: out, poster, filmstrip, ...size, duration, fps, frames, ...scene.result, warnings };
  } finally {
    await stage.close();
  }
}
