/**
 * A recording's still: the frame a device shows in images and on the canvas. It used to be the
 * first frame, which is often blank or mid-transition. Here the Studio offers a handful of
 * moments from the recording to pick from, and saves the one picked next to it.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, statSync } from "node:fs";
import path from "node:path";
import { run } from "../util/exec.js";
import { cacheDir } from "../util/files.js";
import { imageSize } from "../util/image.js";
import { mediaInfo } from "../util/media.js";

/** Each design's still of a recording: `<recording>.still-<ms>.png`, beside the recording. */
export const STILL = /\.still-\d+\.png$/i;
export const isRecording = (p: string) => /\.(mp4|mov)$/i.test(p);

/** The recording's own still (its first frame), made when it was recorded or imported. */
const firstFrame = (video: string) => video.replace(/\.(mp4|mov)$/i, ".png");

async function duration(video: string): Promise<number> {
  return (await mediaInfo(video)).length;
}

/** When the picture changes a lot (a new screen, a big scroll), in seconds. */
async function changes(video: string): Promise<number[]> {
  try {
    const { stderr } = await run("ffmpeg", ["-hide_banner", "-i", video, "-an", "-vf", "fps=12,select='gt(scene,0.06)',showinfo", "-f", "null", "-"], { timeoutMs: 25_000 });
    return [...stderr.matchAll(/pts_time:([\d.]+)/g)].map((m) => Number(m[1])).filter(Number.isFinite);
  } catch {
    return [];
  }
}

/** A tiny grey version of one moment, to tell moments apart. */
function tiny(video: string, t: number): Promise<Buffer | undefined> {
  return new Promise((resolve) => {
    execFile(
      "ffmpeg",
      ["-v", "error", "-ss", t.toFixed(3), "-i", video, "-frames:v", "1", "-vf", "scale=12:24,format=gray", "-f", "rawvideo", "-"],
      { encoding: "buffer", timeout: 15_000, maxBuffer: 1024 * 1024 },
      (error, out) => resolve(error || !out.length ? undefined : out),
    );
  });
}
const alike = (a: Buffer, b: Buffer) => {
  if (a.length !== b.length) return false;
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
  return sum / a.length < 6;
};

/**
 * Up to `n` moments worth picking from: the first frame, each point where the picture changes,
 * and evenly spread ones to fill in, leaving out moments that look the same as one already in.
 * When the recording shows fewer than 5 different pictures, it still offers 5 (some alike).
 */
export async function stillMoments(video: string, n = 8): Promise<{ duration: number; moments: number[] }> {
  const d = await duration(video);
  const last = Math.max(0, d - 0.1);
  const even = Array.from({ length: n }, (_, i) => (n === 1 ? 0 : (i * last) / (n - 1)));
  const cuts = (await changes(video)).filter((t) => t > 0.05 && t < last);
  // Changes first (spread out when there are many), then the evenly spaced ones.
  const step = cuts.length > n ? cuts.length / n : 1;
  const picked = Array.from({ length: Math.min(n, cuts.length) }, (_, i) => cuts[Math.floor(i * step)]);
  const candidates = [0, ...picked, ...even].map((t) => Math.round(t * 10) / 10).filter((t, i, all) => all.indexOf(t) === i && t <= last);
  const looks = await Promise.all(candidates.map((t) => tiny(video, t)));
  const kept: number[] = [];
  const keptLooks: Buffer[] = [];
  const spare: number[] = [];
  // Moments spread through the recording: two a tenth of a second apart look the same to anyone.
  const gap = Math.min(1, d / (n * 2));
  candidates.forEach((t, i) => {
    const look = looks[i];
    if (!look) return;
    if (kept.length < n && !keptLooks.some((k) => alike(k, look)) && kept.every((k) => Math.abs(k - t) >= gap)) {
      kept.push(t);
      keptLooks.push(look);
    } else spare.push(t);
  });
  while (kept.length < Math.min(5, candidates.length) && spare.length) kept.push(spare.shift()!);
  return { duration: d, moments: kept.sort((a, b) => a - b) };
}

/** A small JPEG of one moment (cached), for the picker. */
export async function momentThumb(video: string, t: number, width: number): Promise<string> {
  const w = Math.max(60, Math.min(600, Math.round(width) || 240));
  const key = createHash("sha1").update(`${video}|${statSync(video).mtimeMs}|${t.toFixed(2)}|${w}`).digest("hex").slice(0, 20);
  const file = path.join(cacheDir("moments"), `${key}.jpg`);
  if (!existsSync(file)) {
    await run("ffmpeg", ["-v", "error", "-y", "-ss", t.toFixed(3), "-i", video, "-frames:v", "1", "-vf", `scale=${w}:-2`, "-q:v", "4", file], { timeoutMs: 20_000 });
    if (!existsSync(file)) throw new Error("That moment couldn't be read from the recording.");
  }
  return file;
}

/**
 * Save one moment at full size as a still beside the recording, with the capture's details
 * (which device made it) copied over. The first frame is the recording's own still.
 */
export async function saveStill(video: string, t: number): Promise<{ path: string; width?: number; height?: number }> {
  const own = firstFrame(video);
  const out = t <= 0.05 && existsSync(own) ? own : video.replace(/\.(mp4|mov)$/i, `.still-${Math.round(t * 1000)}.png`);
  if (!existsSync(out)) {
    await run("ffmpeg", ["-v", "error", "-y", "-ss", t.toFixed(3), "-i", video, "-frames:v", "1", out], { timeoutMs: 30_000 });
    if (!existsSync(out)) throw new Error("That moment couldn't be read from the recording.");
    if (existsSync(`${own}.json`)) copyFileSync(`${own}.json`, `${out}.json`);
  }
  return { path: out, ...(await imageSize(out).catch(() => ({}))) };
}

/** The recording a still (or the recording's own first frame) belongs to. */
export function recordingOf(still: string): string | undefined {
  const stem = still.replace(STILL, "").replace(/\.png$/i, "");
  return [".mp4", ".mov"].map((e) => stem + e).find((f) => existsSync(f));
}
