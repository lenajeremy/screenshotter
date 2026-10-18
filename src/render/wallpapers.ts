/**
 * macOS's own wallpapers as backdrops (`macos:<name>`, e.g. "macos:Sonoma"). Those macOS keeps where
 * any app can read them are used as they are. The rest of Apple's set (macOS's catalog of them lists
 * where each lives on Apple's servers) downloads from Apple the first time it's chosen, onto this Mac
 * only, and stays for use offline. None is ever shipped in the app. (The ones System Settings
 * downloads go to a private folder no other app can read, so Screenshotter fetches its own copy.)
 */
import { createHash } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { run } from "../util/exec.js";
import { cacheDir } from "../util/files.js";

const FOLDER = "/System/Library/Desktop Pictures";
/** macOS's catalog of Apple's wallpapers: each one's name, size and place on Apple's servers. */
const CATALOG = "/System/Library/AssetsV2/com_apple_MobileAsset_DesktopPicture/com_apple_MobileAsset_DesktopPicture.xml";

export interface Wallpaper {
  name: string;
  /** The picture itself, when this Mac has it (macOS's own, or one downloaded from Apple). */
  file?: string;
  /** Apple's small picture of it (there even before it's downloaded). */
  thumb?: string;
  /** Bytes to download it, when it isn't here yet and Apple has it. */
  download?: number;
}

interface CatalogEntry {
  url: string;
  size: number;
  sha1?: string;
}

const unescape = (v: string) => v.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'");

let catalogCache: { stamp: number; map: Map<string, CatalogEntry> } | null = null;
/** Apple's wallpapers by name (lower case), from macOS's catalog. Empty when there's none. */
function catalog(): Map<string, CatalogEntry> {
  if (!existsSync(CATALOG)) return new Map();
  const stamp = statSync(CATALOG).mtimeMs;
  if (catalogCache?.stamp === stamp) return catalogCache.map;
  const map = new Map<string, CatalogEntry>();
  const xml = readFileSync(CATALOG, "utf8");
  for (const block of xml.split("<dict>").slice(1)) {
    const v: Record<string, string> = {};
    for (const m of block.matchAll(/<key>([^<]+)<\/key>\s*<(string|integer|data)>([\s\S]*?)<\/\2>/g)) v[m[1]] = unescape(m[3].trim());
    if (!v.DesktopPictureID || !v.__BaseURL || !v.__RelativePath) continue;
    map.set(v.DesktopPictureID.toLowerCase(), {
      url: v.__BaseURL + v.__RelativePath,
      size: Number(v._DownloadSize) || 0,
      sha1: v._Measurement ? Buffer.from(v._Measurement.replace(/\s+/g, ""), "base64").toString("hex") : undefined,
    });
  }
  catalogCache = { stamp, map };
  return map;
}

/** Where wallpapers downloaded from Apple are kept. */
const own = () => cacheDir(path.join("wallpapers", "apple"));
const ownFile = (name: string) => path.join(own(), `${name.replace(/[/:]/g, "-")}.heic`);

let listed: { at: number; list: Wallpaper[] } | null = null;

/** The wallpapers, in Apple's order (newest first): those on this Mac, then the rest of Apple's. */
export async function macWallpapers(): Promise<Wallpaper[]> {
  if (listed && Date.now() - listed.at < 5_000) return listed.list;
  const files = existsSync(FOLDER) ? readdirSync(FOLDER).filter((f) => /\.(heic|madesktop)$/i.test(f)) : [];
  const apple = catalog();
  let order: string[] = [];
  try {
    const { stdout } = await run("plutil", ["-convert", "json", "-o", "-", path.join(FOLDER, ".orderedPictures.plist")], { timeoutMs: 5000 });
    order = (JSON.parse(stdout) as string[]).map((f) => f.replace(/\.(heic|madesktop)$/i, ""));
  } catch {
    // No order: alphabetical.
  }
  const names = new Map<string, string>();
  for (const f of files) {
    const name = f.replace(/\.(heic|madesktop)$/i, "");
    names.set(name.toLowerCase(), name);
  }
  // Apple's catalog names some that aren't in the folder at all.
  const xml = existsSync(CATALOG) ? readFileSync(CATALOG, "utf8") : "";
  for (const m of xml.matchAll(/<key>DesktopPictureID<\/key>\s*<string>([^<]+)<\/string>/g)) {
    const name = unescape(m[1]);
    if (!names.has(name.toLowerCase())) names.set(name.toLowerCase(), name);
  }
  const list: Wallpaper[] = [];
  for (const [key, name] of names) {
    const system = path.join(FOLDER, `${name}.heic`);
    const file = existsSync(system) ? system : existsSync(ownFile(name)) ? ownFile(name) : undefined;
    const entry = apple.get(key);
    // One this Mac can't have (not here, and Apple doesn't offer it): left out.
    if (!file && !entry) continue;
    const thumb = path.join(FOLDER, ".thumbnails", `${name}.heic`);
    list.push({ name, file, thumb: existsSync(thumb) ? thumb : file, download: file ? undefined : entry?.size });
  }
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

const downloading = new Map<string, Promise<string>>();

/** Download one of Apple's wallpapers from Apple (checked against the catalog), keeping it here. */
export function downloadWallpaper(name: string): Promise<string> {
  const key = name.trim().toLowerCase();
  let p = downloading.get(key);
  if (!p) {
    p = fetchWallpaper(name).finally(() => {
      downloading.delete(key);
      listed = null;
    });
    downloading.set(key, p);
  }
  return p;
}

async function fetchWallpaper(name: string): Promise<string> {
  const w = await findWallpaper(name);
  if (w?.file) return w.file;
  const entry = catalog().get(name.trim().toLowerCase());
  if (!w || !entry) throw new Error(`Apple doesn't offer a wallpaper called "${name}".`);
  const work = path.join(own(), `.${createHash("sha1").update(w.name).digest("hex").slice(0, 10)}`);
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  try {
    let res: Response;
    try {
      res = await fetch(entry.url, { signal: AbortSignal.timeout(10 * 60_000) });
    } catch {
      throw new Error(`Couldn't download "${w.name}" from Apple. Check your internet connection and try again.`);
    }
    if (!res.ok || !res.body) throw new Error(`Apple's server didn't send "${w.name}" (${res.status}). Try again later.`);
    const zip = path.join(work, "asset.zip");
    const hash = createHash("sha1");
    const body = Readable.fromWeb(res.body as never);
    body.on("data", (d: Buffer) => hash.update(d));
    await pipeline(body, createWriteStream(zip));
    if (entry.sha1 && hash.digest("hex") !== entry.sha1) throw new Error(`"${w.name}" didn't download properly (it isn't the file Apple lists). Try again.`);
    await run("ditto", ["-x", "-k", zip, work], { timeoutMs: 120_000 });
    const data = path.join(work, "AssetData");
    const heic = existsSync(data) ? readdirSync(data).find((f) => /\.heic$/i.test(f)) : undefined;
    if (!heic) throw new Error(`"${w.name}" came without its picture.`);
    renameSync(path.join(data, heic), ownFile(w.name));
    return ownFile(w.name);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
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

/** The file a `macos:<name>` backdrop draws (downloading it from Apple first if it isn't here). */
export async function wallpaperFile(name: string): Promise<string> {
  const w = await findWallpaper(name);
  if (!w) throw new Error(`There's no macOS wallpaper called "${name}".`);
  return asJpeg(w.file ?? (await downloadWallpaper(w.name)));
}
