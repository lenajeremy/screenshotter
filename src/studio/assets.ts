/** Small helpers the app needs: thumbnails, Unsplash search, saved state. */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { run } from "../util/exec.js";
import { cacheDir, outputRoot } from "../util/files.js";
import { imageSize } from "../util/image.js";
import { unsplashResults } from "../render/photos.js";

const hash = (s: string) => createHash("sha1").update(s).digest("hex").slice(0, 16);

/** One in-flight job per key, so a grid of 40 tiles asking at once doesn't start 40 `sips`. */
const inflight = new Map<string, Promise<string>>();
function once(key: string, make: () => Promise<string>): Promise<string> {
  const running = inflight.get(key);
  if (running) return running;
  const job = make().finally(() => inflight.delete(key));
  inflight.set(key, job);
  return job;
}

/** Cap concurrent `sips` resizes so opening a board with 150 large photos stays responsive. */
const MAX_RESIZE = Math.max(6, Math.min(10, os.cpus().length));
let resizing = 0;
const resizeQueue: Array<() => void> = [];
async function withResizeSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (resizing >= MAX_RESIZE) await new Promise<void>((ok) => resizeQueue.push(ok));
  resizing++;
  try {
    return await fn();
  } finally {
    resizing--;
    resizeQueue.shift()?.();
  }
}

/** A JPEG thumbnail of an image, cached by path + modification time. */
export async function thumbnail(file: string, edge: number): Promise<string> {
  const size = Math.max(64, Math.min(1200, Math.round(edge / 40) * 40));
  const stat = statSync(file);
  const out = path.join(cacheDir("thumbs"), `${hash(`${file}|${stat.mtimeMs}|${stat.size}`)}-${size}.jpg`);
  if (existsSync(out)) return out;
  return once(out, () =>
    withResizeSlot(async () => {
      if (existsSync(out)) return out;
      const tmp = `${out}.${process.pid}.tmp.jpg`;
      await run("sips", ["-s", "format", "jpeg", "-s", "formatOptions", "78", "-Z", String(size), file, "--out", tmp]);
      renameSync(tmp, out);
      return out;
    }),
  );
}

const MIP_BUCKETS = [256, 512, 1024, 2048];
/**
 * A canvas mipmap of a raster image (longest edge capped to a power-of-2 bucket), preserving alpha
 * for PNG/WebP/HEIC and JPEG for JPEG. Tiny files or images already at/under the bucket return
 * the original untouched. Cached on disk by path + mtime + size.
 */
export async function scaledImage(file: string, maxEdge: number): Promise<string> {
  if (!/\.(png|jpe?g|webp|heic)$/i.test(file)) return file;
  const bucket = MIP_BUCKETS.find((b) => b >= maxEdge);
  if (!bucket) return file;
  const stat = statSync(file);
  if (stat.size < 65_536) return file;
  try {
    const dim = await imageSize(file);
    if (Math.max(dim.width, dim.height) <= bucket) return file;
  } catch {
    return file;
  }
  const jpeg = /\.jpe?g$/i.test(file);
  const ext = jpeg ? ".jpg" : ".png";
  const out = path.join(cacheDir("mips"), `${hash(`${file}|${stat.mtimeMs}|${stat.size}`)}-${bucket}${ext}`);
  if (existsSync(out)) return out;
  return once(out, () =>
    withResizeSlot(async () => {
      if (existsSync(out)) return out;
      const tmp = `${out}.${process.pid}.tmp${ext}`;
      const args = jpeg
        ? ["-s", "format", "jpeg", "-s", "formatOptions", "88", "-Z", String(bucket), file, "--out", tmp]
        : ["-s", "format", "png", "-Z", String(bucket), file, "--out", tmp];
      await run("sips", args);
      renameSync(tmp, out);
      return out;
    }),
  );
}

export interface UnsplashHit {
  id: string;
  thumb: string;
  color?: string;
  author?: string;
  description?: string;
  width: number;
  height: number;
}

const searches = new Map<string, { at: number; hits: UnsplashHit[] }>();
/** Free Unsplash photos for a query, for the background picker. */
export async function searchUnsplash(query: string, page = 1): Promise<UnsplashHit[]> {
  const key = `${query.toLowerCase()}|${page}`;
  const cached = searches.get(key);
  if (cached && Date.now() - cached.at < 30 * 60_000) return cached.hits;
  const hits: UnsplashHit[] = (await unsplashResults(query, { perPage: 24, page }))
    .filter((r) => r.urls?.small)
    .map((r) => ({
      id: r.id,
      thumb: r.urls.small,
      color: r.color,
      author: r.user?.name,
      description: r.alt_description ?? r.description ?? undefined,
      width: r.width,
      height: r.height,
    }));
  searches.set(key, { at: Date.now(), hits });
  return hits;
}

// ---------------------------------------------------------------------------------------------
// Saved Studio state (the current scene and a few preferences), kept next to the output so it
// survives restarts and port changes.

function stateFile(): string {
  const dir = path.join(outputRoot(), ".studio");
  mkdirSync(dir, { recursive: true });
  return path.join(dir, "state.json");
}

export function loadState(): unknown {
  try {
    return JSON.parse(readFileSync(stateFile(), "utf8"));
  } catch {
    return {};
  }
}

export function saveState(state: unknown): void {
  const file = stateFile();
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(state));
  renameSync(tmp, file);
}
