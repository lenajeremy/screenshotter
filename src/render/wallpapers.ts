/**
 * macOS's own wallpapers as backdrops: the ones this Mac has (Apple's pictures, read where macOS
 * keeps them, never copied into the app), as `macos:<name>`, e.g. "macos:Sonoma". The rest of
 * Apple's set is listed too: System Settings › Wallpaper downloads any of them, and then it's here.
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { run } from "../util/exec.js";
import { cacheDir } from "../util/files.js";

const FOLDER = "/System/Library/Desktop Pictures";
/** Where wallpapers downloaded from System Settings go. */
const DOWNLOADS = "/System/Library/AssetsV2/com_apple_MobileAsset_DesktopPicture";

export interface Wallpaper {
  name: string;
  /** The picture itself, when this Mac has it. */
  file?: string;
  /** Apple's small picture of it (there even before it's downloaded). */
  thumb?: string;
}

/** Every heic under a folder (the downloaded ones sit a few folders down). */
function heics(dir: string, depth = 4): string[] {
  if (!existsSync(dir) || depth < 0) return [];
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...heics(p, depth - 1));
    else if (/\.heic$/i.test(e.name)) out.push(p);
  }
  return out;
}

let listed: { at: number; list: Wallpaper[] } | null = null;

/** The wallpapers, in Apple's order (newest first), those on this Mac before the rest. */
export async function macWallpapers(): Promise<Wallpaper[]> {
  if (listed && Date.now() - listed.at < 30_000) return listed.list;
  if (!existsSync(FOLDER)) return [];
  const names = readdirSync(FOLDER).filter((f) => /\.(heic|madesktop)$/i.test(f));
  const downloaded = new Map(heics(DOWNLOADS).map((f) => [path.basename(f, path.extname(f)).toLowerCase(), f]));
  let order: string[] = [];
  try {
    const { stdout } = await run("plutil", ["-convert", "json", "-o", "-", path.join(FOLDER, ".orderedPictures.plist")], { timeoutMs: 5000 });
    order = (JSON.parse(stdout) as string[]).map((f) => f.replace(/\.(heic|madesktop)$/i, ""));
  } catch {
    // No order: alphabetical.
  }
  const list: Wallpaper[] = names.map((f) => {
    const name = f.replace(/\.(heic|madesktop)$/i, "");
    const own = /\.heic$/i.test(f) ? path.join(FOLDER, f) : downloaded.get(name.toLowerCase());
    const thumb = path.join(FOLDER, ".thumbnails", `${name}.heic`);
    return { name, file: own, thumb: existsSync(thumb) ? thumb : own };
  });
  const rank = (w: Wallpaper) => (order.includes(w.name) ? order.indexOf(w.name) : order.length);
  list.sort((a, b) => Number(!a.file) - Number(!b.file) || rank(a) - rank(b) || a.name.localeCompare(b.name));
  listed = { at: Date.now(), list };
  return list;
}

/** A wallpaper by name, case aside. */
export async function findWallpaper(name: string): Promise<Wallpaper | undefined> {
  const key = name.trim().toLowerCase();
  return (await macWallpapers()).find((w) => w.name.toLowerCase() === key);
}

const converting = new Map<string, Promise<string>>();

/**
 * A HEIC picture as a JPEG the renderer can draw (Chromium can't read HEIC), at most `max` pixels
 * across, made once and kept.
 */
export function asJpeg(file: string, max = 4096): Promise<string> {
  const st = statSync(file);
  const out = path.join(cacheDir("wallpapers"), `${createHash("sha1").update(`${file}:${st.size}:${st.mtimeMs}:${max}`).digest("hex").slice(0, 16)}.jpg`);
  if (existsSync(out)) return Promise.resolve(out);
  let p = converting.get(out);
  if (!p) {
    p = run("sips", ["-s", "format", "jpeg", "-s", "formatOptions", "88", "-Z", String(max), file, "--out", out], { timeoutMs: 60_000 }).then(() => {
      if (!existsSync(out)) throw new Error(`Couldn't read the wallpaper ${path.basename(file)}`);
      return out;
    });
    converting.set(out, p);
    p.finally(() => converting.delete(out)).catch(() => undefined);
  }
  return p;
}

/** The file a `macos:<name>` backdrop draws. */
export async function wallpaperFile(name: string): Promise<string> {
  const w = await findWallpaper(name);
  if (!w) throw new Error(`There's no macOS wallpaper called "${name}".`);
  if (!w.file) throw new Error(`This Mac doesn't have the "${w.name}" wallpaper yet. Choose it once in System Settings › Wallpaper to download it, then it's here.`);
  return asJpeg(w.file);
}
