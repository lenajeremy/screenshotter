import { spawn } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { cacheDir, formatFor, outputPathFor } from "../util/files.js";
import { newPage } from "./browser.js";
import { BACKDROP, CALLOUT, animatedIds, backdropStyle, evaluate, evaluateBackdrop, evaluateCallouts, evaluateCamera, keyMoments, targetsOf, timelineEnd, uses3d, type AnimEntity } from "./animate.js";
import { buildScene, layoutScene, renderHtml, type MockupResult, type SceneEntity, type SceneFrame } from "./mockup.js";
import { MockupInputShape, type MockupInput } from "./schema.js";
import { renderShape } from "./shapes.js";

const timing = z.object({
  in: z.number().optional().describe("Seconds when it appears (fades in)."),
  out: z.number().optional().describe("Seconds when it has faded out. Omit to keep it."),
});

export const VideoOptionsSchema = z
  .object({
    duration: z.number().min(0.5).max(60).optional().describe("Seconds. Default 6 (or the screen recording's length)."),
    fps: z.number().int().min(12).max(60).optional().describe("Default 30."),
    motion: z
      .enum(["none", "subtle", "float", "drift", "push-in"])
      .optional()
      .describe("Ambient motion: subtle bob, float (gentle 3D sway), drift (slow pan and turn), push-in (slow camera push). Default subtle."),
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
          .describe("Where the cursor is over time; it glides between points. record_web returns these for the flow it recorded."),
      })
      .optional()
      .describe("Draw a cursor moving over a device's screen, clicking and dragging where you say. It moves with the device (tilt, motion, zooms)."),
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
interface AnimFrame {
  /** `units`: a text's words or letters in reading order, each [opacity, dx, dy, scaleX, scaleY, turn, blur]. */
  els: Array<{ id: string; dx: number; dy: number; sx: number; sy: number; r: number; rx: number; ry: number; o: number; color?: string; blur?: number; units?: number[][] }>;
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

function animFrame(animations: MockupInput["animations"], entities: AnimEntity[], t: number, W: number, H: number, backdrop = { width: W, height: H }): AnimFrame {
  const frame: AnimFrame = { els: [], shapes: [], callouts: [] };
  for (const [id, st] of evaluate(animations, entities, t, W, H)) {
    if (st.shape) {
      const r = renderShape(st.shape, W, H);
      frame.shapes.push({ id, left: r.left, top: r.top, width: r.width, height: r.height, rotate: r.rotate, filter: r.filter, svg: r.svg });
    } else {
      const units = st.units?.map((u) => [u.opacity, u.dx, u.dy, u.sx, u.sy, u.rotate, u.blur]);
      frame.els.push({ id, dx: st.dx, dy: st.dy, sx: st.sx, sy: st.sy, r: st.rotate, rx: st.rotateX, ry: st.rotateY, o: st.opacity, color: st.color, blur: st.blur, units });
    }
  }
  for (const [id, v] of evaluateCallouts(animations, t)) {
    const m = CALLOUT.exec(id)!;
    frame.callouts.push({ device: `device-${m[1]}`, index: Number(m[2]) - 1, v });
  }
  const cam = evaluateCamera(animations, t);
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
  cursor?: { device: number; style: "pointer" | "touch"; size: number; points: Array<{ t: number; x: number; y: number; click?: boolean; drag?: boolean }> };
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
      cursorEl.style.cssText = `position:absolute;left:0;top:0;width:${size}px;height:${size}px;pointer-events:none;z-index:5;will-change:transform`;
      cursorEl.innerHTML = pointer
        ? `<svg viewBox="0 0 12 19" width="${size * 0.64}" height="${size}" style="display:block;overflow:visible;filter:drop-shadow(0 ${size * 0.04}px ${size * 0.08}px rgba(0,0,0,.35))"><path d="M0.6 0.6 L0.6 15.6 L4.2 12.2 L6.6 17.8 L9 16.8 L6.7 11.3 L11.4 11.3 Z" fill="#000" stroke="#fff" stroke-width="1.1" stroke-linejoin="round"/></svg>`
        : `<div class="dot" style="width:100%;height:100%;border-radius:50%;background:rgba(255,255,255,.55);box-shadow:0 0 0 ${size * 0.05}px rgba(0,0,0,.18), 0 ${size * 0.06}px ${size * 0.2}px rgba(0,0,0,.25);transform:translate(-50%,-50%)"></div>`;
      ripple = document.createElement("div");
      ripple.style.cssText = `position:absolute;left:0;top:0;width:${size * (pointer ? 2.2 : 1.4)}px;height:${size * (pointer ? 2.2 : 1.4)}px;border-radius:50%;border:${Math.max(1, size * (pointer ? 0.1 : 0.05))}px solid rgba(255,255,255,.95);box-shadow:0 0 ${size * 0.2}px rgba(0,0,0,.25);pointer-events:none;z-index:4;opacity:0`;
      host.append(ripple, cursorEl);
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
  const motion = opts.motion ?? "subtle";
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

    await page.evaluate(installTimeline, {
      animated: [...animatedIds(animations)],
      duration,
      W,
      H,
      motion,
      amount: opts.motionAmount ?? 1,
      keys: cameraKeys(zooms),
      cursor: opts.cursor ? { device: cursorDevice, style: opts.cursor.style ?? (pointerDefault ? "pointer" : "touch"), size: opts.cursor.size ?? 1, points: opts.cursor.points } : undefined,
      highlight: opts.highlight ?? (hasHighlights ? { in: duration * 0.25 } : undefined),
      caption: opts.caption,
      fade: opts.fade ?? 0.4,
      grainFps: opts.grainFps ?? 24,
      s: view.scale,
    });
  } catch (e) {
    await close();
    throw e;
  }
  /** Show the scene as it is at `t` seconds. */
  const setTime = (t: number) => page.evaluate((t, f) => (window as any).__setTime(t, f), t, animFrame(animations, ents, t, W, H, backdrop));
  // What to photograph: the whole page.
  const clip = { x: 0, y: 0, width: Math.round(view.width), height: Math.round(view.height) };
  return { page, dir, scene, ents, animations, W, H, view, clip, duration, natural, setTime, close };
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

export interface RenderOptions {
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
export async function createVideo(input: VideoInput): Promise<VideoResult> {
  const main = await renderVideo(input);
  if (!input.versions?.length) return main;
  const versions: NonNullable<VideoResult["versions"]> = [];
  for (const v of input.versions) {
    const spec = versionSpec(v, input.layout);
    const format = spec.appStore ? "mp4" : main.path.split(".").pop()!;
    const out = main.path.replace(/\.[a-z0-9]+$/i, `.${spec.name}.${format}`);
    const r = await renderVideo(spec.fit === "rearrange" ? { ...input, canvas: `${spec.width}x${spec.height}`, deliveryWidth: undefined } : { ...input, deliveryWidth: undefined }, {
      frame: spec.fit === "rearrange" ? undefined : { width: spec.width, height: spec.height, fit: spec.fit },
      appStore: spec.appStore,
      length: spec.appStore ? [15, 30] : undefined,
      output: out,
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

/** Render one video: the design at its own size, or in a frame, as a delivery file or a sequence's shot. */
export async function renderVideo(input: VideoInput, o: RenderOptions = {}): Promise<VideoResult> {
  const opts = input.video ?? {};
  const format = o.shot || o.appStore ? "mp4" : formatFor(input.format, o.output ?? input.output, ["mp4", "mov", "webm", "gif"] as const, "mp4", { m4v: "mp4" });
  const fps = o.appStore ? 30 : (opts.fps ?? 30);
  const preview = input.quality === "preview" && !o.appStore;
  const stage = await openStage(input, preview ? 0.5 : 1, { frame: o.frame, length: o.length });
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
      }
      ffmpeg.stdin.end();
      const code = await ffDone;
      if (ffFailed) throw ffFailed;
      if (code !== 0) throw new Error(`ffmpeg failed (${code}): ${ffErr.trim().split("\n").slice(-3).join(" ")}`);
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
