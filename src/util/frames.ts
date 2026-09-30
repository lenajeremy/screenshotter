import { createHash } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { run } from "./exec.js";
import { cacheDir } from "./files.js";

/**
 * The first frame of a screen recording, as a PNG (cached per file and modification time).
 * Lets a device show a recording with no separate screenshot: stills and previews use this frame.
 */
export async function firstFrame(video: string): Promise<string> {
  if (!existsSync(video)) throw new Error(`Recording not found: ${video}`);
  const key = createHash("sha1").update(`${video}:${statSync(video).mtimeMs}`).digest("hex").slice(0, 16);
  const out = path.join(cacheDir("frames"), `${path.parse(video).name.slice(0, 40)}-${key}.png`);
  if (existsSync(out)) return out;
  try {
    await run("ffmpeg", ["-v", "error", "-y", "-i", video, "-frames:v", "1", out], { timeoutMs: 60_000 });
  } catch (e) {
    throw new Error(`Couldn't read the first frame of ${path.basename(video)} (${(e as Error).message.split("\n")[0]}). Is ffmpeg installed? brew install ffmpeg`);
  }
  return out;
}
