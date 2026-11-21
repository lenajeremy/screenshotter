/** Small helpers the app needs: thumbnails, Unsplash search, saved state. */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { run } from "../util/exec.js";
import { cacheDir, outputRoot } from "../util/files.js";
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

/** A JPEG thumbnail of an image, cached by path + modification time. */
export async function thumbnail(file: string, edge: number): Promise<string> {
  const size = Math.max(64, Math.min(1200, Math.round(edge / 40) * 40));
  const stat = statSync(file);
  const out = path.join(cacheDir("thumbs"), `${hash(`${file}|${stat.mtimeMs}|${stat.size}`)}-${size}.jpg`);
  if (existsSync(out)) return out;
  return once(out, async () => {
    const tmp = `${out}.${process.pid}.tmp.jpg`;
    await run("sips", ["-s", "format", "jpeg", "-s", "formatOptions", "78", "-Z", String(size), file, "--out", tmp]);
    renameSync(tmp, out);
    return out;
  });
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
