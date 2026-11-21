/**
 * Video layers' stills. As in Figma, a video on the canvas shows its first frame until it's played,
 * and pictures of the board (exports, thumbnails, agents' screenshots) show that frame, so they
 * always come out the same. The browser the engine draws boards with reads the video: its size,
 * its length and its first frame, kept beside it as a JPEG.
 */
import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { newPage } from "../render/browser.js";
import type { BoardNode } from "./core.js";

export const VIDEO_EXT = /\.(mp4|m4v|mov|webm)$/i;

const remote = (src: string) => /^(https?:|data:|blob:)/i.test(src);

export interface VideoInfo {
  width: number;
  height: number;
  /** Seconds; 0 when it can't be told. */
  length: number;
}

const read = new Map<string, Promise<{ still?: string; info?: VideoInfo }>>();

/** A video's size, length and first frame (a JPEG beside it). Empty when the browser can't play it. */
export function readVideo(file: string): Promise<{ still?: string; info?: VideoInfo }> {
  let p = read.get(file);
  if (!p) {
    p = readNow(file);
    read.set(file, p);
    // A failure may be the browser starting up: try again next time.
    p.then((r) => !r.info && read.delete(file));
  }
  return p;
}

async function readNow(file: string): Promise<{ still?: string; info?: VideoInfo }> {
  const out = `${file}.still.jpg`;
  const page = await newPage();
  try {
    // The video on its own, as Chrome opens one: a page with just it.
    await page.goto(pathToFileURL(file).href, { waitUntil: "domcontentloaded", timeout: 30_000 });
    const got = await page.evaluate(async () => {
      const v = document.querySelector("video");
      if (!v) return null;
      v.muted = true;
      v.pause();
      if (v.readyState < 2)
        await new Promise((ok, no) => {
          v.addEventListener("loadeddata", ok, { once: true });
          v.addEventListener("error", no, { once: true });
          setTimeout(no, 20_000);
        });
      v.pause();
      if (v.currentTime > 0) {
        v.currentTime = 0;
        await new Promise((ok) => v.addEventListener("seeked", ok, { once: true }));
      }
      if (!v.videoWidth) return null;
      const k = Math.min(1, 1920 / Math.max(v.videoWidth, v.videoHeight));
      const c = document.createElement("canvas");
      c.width = Math.round(v.videoWidth * k);
      c.height = Math.round(v.videoHeight * k);
      c.getContext("2d")!.drawImage(v, 0, 0, c.width, c.height);
      return { width: v.videoWidth, height: v.videoHeight, length: Number.isFinite(v.duration) ? Math.round(v.duration * 100) / 100 : 0, jpeg: c.toDataURL("image/jpeg", 0.85) };
    });
    if (!got) return {};
    if (!existsSync(out)) writeFileSync(out, Buffer.from(got.jpeg.split(",")[1], "base64"));
    return { still: out, info: { width: got.width, height: got.height, length: got.length } };
  } catch {
    return {};
  } finally {
    await page.close().catch(() => undefined);
  }
}

/** A video's first frame as a JPEG beside it (made the first time). Undefined when it can't be read. */
export async function videoStill(file: string): Promise<string | undefined> {
  const out = `${file}.still.jpg`;
  if (existsSync(out)) return out;
  return (await readVideo(file)).still;
}

/**
 * Give the video layers among `nodes` (already in the library) their stills, and a size from the
 * video when they were given none (its own shape, no bigger than 720 on its longer side).
 */
export async function addVideoStills(nodes: Record<string, BoardNode>, warnings: string[] = []): Promise<void> {
  for (const n of Object.values(nodes)) {
    if (n.type !== "video" || !n.src || remote(n.src)) continue;
    if (!existsSync(n.src)) continue;
    if (!n.poster) {
      const still = await videoStill(n.src);
      if (still) n.poster = still;
      else warnings.push(`Couldn't read the video ${path.basename(n.src)}: it shows as an empty box until it plays. Use an MP4, MOV or WebM.`);
    }
    if (!n.style.width || !n.style.height) {
      const { info } = await readVideo(n.src);
      if (info?.width && info.height) {
        const k = Math.min(1, 720 / Math.max(info.width, info.height));
        n.style = { width: `${Math.round(info.width * k)}px`, height: `${Math.round(info.height * k)}px`, objectFit: "cover", ...n.style };
      }
    }
  }
}
