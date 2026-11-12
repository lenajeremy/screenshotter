/**
 * Video layers' stills. As in Figma, a video on the canvas shows its first frame until it's played,
 * and pictures of the board (exports, thumbnails, agents' screenshots) show that frame, so they
 * always come out the same. The frame is drawn once, beside the video, with the ffmpeg the app carries.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { run } from "../util/exec.js";
import { mediaInfo } from "../util/media.js";
import type { BoardNode } from "./core.js";

export const VIDEO_EXT = /\.(mp4|m4v|mov|webm)$/i;

const remote = (src: string) => /^(https?:|data:|blob:)/i.test(src);

/** A video's first frame as a JPEG beside it (made the first time). Undefined when ffmpeg can't read it. */
export async function videoStill(file: string): Promise<string | undefined> {
  const out = `${file}.still.jpg`;
  if (existsSync(out)) return out;
  try {
    await run("ffmpeg", ["-v", "error", "-y", "-i", file, "-frames:v", "1", "-q:v", "3", out], { timeoutMs: 60_000 });
  } catch {
    return undefined;
  }
  return existsSync(out) ? out : undefined;
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
      const info = await mediaInfo(n.src).catch(() => undefined);
      if (info?.width && info.height) {
        const k = Math.min(1, 720 / Math.max(info.width, info.height));
        n.style = { width: `${Math.round(info.width * k)}px`, height: `${Math.round(info.height * k)}px`, objectFit: "cover", ...n.style };
      }
    }
  }
}
