import { spawn } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { formatFor, outputPathFor } from "../util/files.js";
import { newPage } from "./browser.js";
import { buildScene, renderHtml, type MockupResult } from "./mockup.js";
import { MockupInputShape, type MockupInput } from "./schema.js";

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

const { format: _f, quality: _q, jpegQuality: _j, preview: _p, ...stillShape } = MockupInputShape;

export const VideoInputShape = {
  ...stillShape,
  video: VideoOptionsSchema,
  format: z.enum(["mp4", "mov", "webm", "gif"]).optional().describe("mp4 (H.264, default), mov (ProRes, keeps transparency), webm (VP9), gif."),
  quality: z.enum(["preview", "final"]).optional().describe("preview renders at half resolution for a quick check."),
  preview: z.boolean().optional().describe("Return a strip of frames from the video. Default true."),
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
}

function encoderArgs(format: string, fps: number, out: string, transparent: boolean, width: number, deliveryWidth?: number): string[] {
  const input = ["-y", "-loglevel", "error", "-f", "image2pipe", "-framerate", String(fps), "-i", "-"];
  const scale = deliveryWidth ? `scale=${deliveryWidth}:-2:flags=lanczos` : "scale=trunc(iw/2)*2:trunc(ih/2)*2";
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

/** Installed in the page: sets every animated property for time t (seconds). */
function installTimeline(cfg: {
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
}) {
  const root = document.getElementById("canvas")!;
  const stage = document.getElementById("stage")!;
  const devs = Array.from(document.querySelectorAll<HTMLElement>(".dev-wrap"));
  const videos = Array.from(document.querySelectorAll<HTMLVideoElement>("video.shot"));
  const grains = Array.from(document.querySelectorAll<HTMLElement>(".grain"));
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

  (window as any).__setTime = async (t: number) => {
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
    for (let k = 0; k < keys.length - 1; k++) {
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

/** Render an animated mockup to a video file. */
export async function createVideo(input: VideoInput): Promise<VideoResult> {
  const opts = input.video ?? {};
  const motion = opts.motion ?? "subtle";
  const format = formatFor(input.format, input.output, ["mp4", "mov", "webm", "gif"] as const, "mp4", { m4v: "mp4" });
  const zoomList = [...(opts.zoom ? [opts.zoom] : []), ...(opts.zooms ?? [])];
  for (const z of zoomList) {
    if (!(z.end > z.start)) throw new Error(`A zoom's end (${z.end}s) must be after its start (${z.start}s).`);
  }
  const fps = opts.fps ?? 30;
  const preview = input.quality === "preview";
  const scene = await buildScene({ ...input, format: undefined, quality: undefined } as MockupInput, {
    motion3d: motion === "float" || motion === "drift",
  });
  const W = scene.width;
  const H = scene.height;
  const hasHighlights = input.devices.some((d) => d.highlights?.length);

  const dir = await mkdtemp(path.join(tmpdir(), "screenshotter-video-"));
  const htmlFile = path.join(dir, "scene.html");
  await writeFile(htmlFile, scene.html);
  const out = outputPathFor(input.output, "videos", `video-${scene.layout}`, format);
  const page = await newPage();
  let frames = 0;
  let duration = opts.duration ?? 6;
  const strip: string[] = [];
  try {
    await page.setViewport({ width: W, height: H, deviceScaleFactor: preview ? 0.5 : 1 });
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

    // Each zoom's focus: its x/y, else a highlight on screen (the first by default), else the centre.
    const spots = await page.evaluate(() =>
      Array.from(document.querySelectorAll(".hl .hlx, .hlx")).map((el) => {
        const r = el.getBoundingClientRect();
        return { x: (r.left + r.width / 2) / window.innerWidth, y: (r.top + r.height / 2) / window.innerHeight };
      }),
    );
    const zooms = zoomList.map((z) => {
      const spot = spots[("highlight" in z && typeof z.highlight === "number" ? z.highlight : undefined) ?? 0];
      return { start: z.start, end: z.end, scale: z.scale ?? 1.8, x: z.x ?? spot?.x ?? 0.5, y: z.y ?? spot?.y ?? 0.5 };
    });
    // Pointer for Macs and browser/window frames, a fingertip elsewhere.
    const cursorDevice = opts.cursor?.device ?? 0;
    const cursorFrame = scene.result.entities?.find((e) => e.kind === "device" && e.index === cursorDevice);
    const pointerDefault = cursorFrame?.frame === "browser" || cursorFrame?.frame === "window" || /MacBook|iMac/i.test(cursorFrame?.device ?? "");

    await page.evaluate(installTimeline, {
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
    });

    const transparent = scene.transparent && (format === "mov" || format === "webm");
    const ffmpeg = spawn("ffmpeg", encoderArgs(format, fps, out, transparent, W, input.deliveryWidth), { stdio: ["pipe", "ignore", "pipe"] });
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
      const stripAt = new Set([0, Math.round(total * 0.33), Math.round(total * 0.66), total - 1]);
      for (let i = 0; i < total; i++) {
        if (ffFailed) throw ffFailed;
        await page.evaluate((t) => (window as any).__setTime(t), i / fps);
        const buf = (await page.screenshot({
          type: transparent ? "png" : "jpeg",
          quality: transparent ? undefined : 94,
          clip: { x: 0, y: 0, width: W, height: H },
          omitBackground: transparent,
          optimizeForSpeed: true,
        })) as Uint8Array;
        if (stripAt.has(i)) {
          const f = path.join(dir, `strip-${i}.${transparent ? "png" : "jpg"}`);
          writeFileSync(f, buf);
          strip.push(f);
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

    // Poster (first frame at full quality) and a filmstrip for a quick visual check.
    const poster = out.replace(/\.[a-z0-9]+$/i, ".poster.jpg");
    await page.evaluate((t) => (window as any).__setTime(t), Math.min(duration * 0.5, duration));
    await page.screenshot({ path: poster as `${string}.jpeg`, type: "jpeg", quality: 90, clip: { x: 0, y: 0, width: W, height: H } });
    const filmstrip = out.replace(/\.[a-z0-9]+$/i, ".filmstrip.jpg");
    const tileW = Math.round(900 * (W / H));
    const stripHtml = `<!doctype html><html><body style="margin:0;background:#111"><div style="display:flex;gap:12px;padding:12px">${strip
      .map((f, k) => `<div style="position:relative"><img src="${pathToFileURL(f).href}" style="height:900px;width:${tileW}px;display:block;border-radius:8px"><div style="position:absolute;left:12px;top:10px;font:600 28px system-ui;color:#fff;text-shadow:0 1px 4px #000">${["0%", "33%", "66%", "100%"][k]}</div></div>`)
      .join("")}</div></body></html>`;
    await renderHtml(stripHtml, filmstrip, (tileW + 12) * strip.length + 12, 924, { scale: 1, format: "jpeg", transparent: false });
    writeFileSync(`${out}.mockup.json`, JSON.stringify({ ...input, output: out }, null, 2));
    return {
      path: out,
      poster,
      filmstrip,
      width: input.deliveryWidth ?? (preview ? Math.round(W / 2) : W),
      height: Math.round((H * (input.deliveryWidth ?? (preview ? W / 2 : W))) / W),
      duration,
      fps,
      frames,
      ...scene.result,
    };
  } finally {
    await page.close().catch(() => undefined);
    await rm(dir, { recursive: true, force: true });
  }
}
