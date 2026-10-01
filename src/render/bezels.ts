/**
 * Photographic device frames from Apple's product bezels (Apple Design Resources).
 *
 * Screenshotter doesn't ship or download them: Apple's license has to be accepted by the person
 * using them, and it only covers mock-ups of apps that run on Apple platforms. People download
 * the bezels from developer.apple.com/design/resources, open them (agreeing to the license), and
 * add the PNGs to their bezel folder; this module indexes that folder and works out, from each
 * image's transparency, where the screen opening is.
 */
import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { DEVICE_MODELS, norm, type ColorOption, type DeviceModel } from "../devices/catalog.js";
import { cacheDir } from "../util/files.js";
import { newPage } from "./browser.js";

export interface BezelArt {
  file: string;
  /** Image size in px. */
  width: number;
  height: number;
  /** The transparent screen opening, in image px, with its corner radius. */
  hole: { x: number; y: number; w: number; h: number; r: number };
  /** The artwork already draws the Dynamic Island / notch. */
  cutout: boolean;
  /** Frame colour sampled from the silhouette, for the 3D edge. */
  edge: string;
}

export interface BezelEntry {
  file: string;
  model: string;
  color: string;
  landscape: boolean;
}

export function bezelsDir(): string {
  return process.env.SCREENSHOTTER_BEZELS_DIR || path.join(os.homedir(), "Library", "Application Support", "Screenshotter", "Bezels");
}

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (name.startsWith(".")) continue;
    const p = path.join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (/\.png$/i.test(name)) out.push(p);
  }
  return out;
}

// "46 mm" and "46mm" are the same word.
const words = (s: string) =>
  s
    .toLowerCase()
    .replace(/(\d)\s+mm\b/g, "$1mm")
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

// Finishes are named with or without their material ("Natural" for "Natural Titanium").
const MATERIAL = /\s+(titanium|aluminum|aluminium|stainless steel)$/i;

// Every name and alias as a set of words, most specific first: "iPhone 17 Pro Max" is tried
// before "iPhone 17 Pro", and "MacBook Pro 16-inch" before the bare "MacBook Pro" alias.
const NEEDLES = DEVICE_MODELS.flatMap((m) => [m.name, ...(m.aliases ?? [])].map((n) => ({ model: m, words: words(n) }))).sort(
  (a, b) => b.words.length - a.words.length || b.words.join("").length - a.words.join("").length,
);

/** Whether a PNG is wider than it is tall, from its header. */
function pngIsWide(file: string): boolean {
  try {
    const fd = openSync(file, "r");
    const head = Buffer.alloc(24);
    readSync(fd, head, 0, 24, 0);
    closeSync(fd);
    return head.readUInt32BE(16) > head.readUInt32BE(20);
  } catch {
    return false;
  }
}

/**
 * Which model and colour a bezel file shows, from its path (file and folder names). Words are
 * matched, not a run of text, so Apple's "MacBook Pro M5 16-inch" is the 16-inch.
 */
export function classify(file: string, root = bezelsDir(), only?: string): BezelEntry | undefined {
  const rel = path.relative(root, file);
  const key = norm(rel.replace(/\.png$/i, ""));
  const have = new Set(words(rel.replace(/\.png$/i, "")));
  // `only`: the one model a set from Apple holds, for art whose name doesn't say which it is.
  const model = NEEDLES.find((n) => n.words.every((w) => have.has(w)))?.model ?? (only ? DEVICE_MODELS.find((m) => m.id === only) : undefined);
  if (!model) return undefined;
  const colors = [...model.colors].sort((a, b) => b.name.length - a.name.length);
  const color = colors.find((c) => key.includes(norm(c.name))) ?? colors.find((c) => MATERIAL.test(c.name) && key.includes(norm(c.name.replace(MATERIAL, ""))));
  if (!color) return undefined;
  // Orientation from the name, else (phones, tablets) from the picture: wider than tall is landscape.
  const landscape = /landscape/i.test(rel) || (!/portrait/i.test(rel) && model.family !== "mac" && pngIsWide(file));
  return { file, model: model.id, color: color.name, landscape };
}

let indexCache: { at: number; root: string; entries: BezelEntry[] } | undefined;

/** Every recognised bezel in the bezel folder (re-read at most every few seconds). */
export function listBezels(): BezelEntry[] {
  const root = bezelsDir();
  if (indexCache && indexCache.root === root && Date.now() - indexCache.at < 5000) return indexCache.entries;
  const entries = walk(root)
    .map((f) => classify(f, root))
    .filter((e): e is BezelEntry => Boolean(e));
  indexCache = { at: Date.now(), root, entries };
  return entries;
}

/** Models and colours that have bezels installed. */
export function bezelSummary(): { dir: string; count: number; models: Array<{ model: string; name: string; colors: string[] }> } {
  const entries = listBezels().filter((e) => !e.landscape);
  const byModel = new Map<string, Set<string>>();
  for (const e of entries) byModel.set(e.model, (byModel.get(e.model) ?? new Set()).add(e.color));
  return {
    dir: bezelsDir(),
    count: entries.length,
    models: [...byModel].map(([id, colors]) => ({ model: id, name: DEVICE_MODELS.find((m) => m.id === id)?.name ?? id, colors: [...colors] })),
  };
}

const analysisCache = new Map<string, BezelArt>();

// Bump the "v2" in the cache key whenever the analysis changes.
async function analyze(file: string): Promise<BezelArt | undefined> {
  const stat = statSync(file);
  const key = createHash("sha1").update(`v2:${file}:${stat.mtimeMs}:${stat.size}`).digest("hex").slice(0, 20);
  const mem = analysisCache.get(key);
  if (mem) return mem;
  const disk = path.join(cacheDir("bezels"), `${key}.json`);
  if (existsSync(disk)) {
    const art = { ...JSON.parse(readFileSync(disk, "utf8")), file } as BezelArt;
    analysisCache.set(key, art);
    return art;
  }
  const page = await newPage();
  try {
    const src = `data:image/png;base64,${readFileSync(file).toString("base64")}`;
    const found = await page.evaluate(async (src: string) => {
      const img = new Image();
      img.src = src;
      await img.decode();
      const W = img.width;
      const H = img.height;
      const canvas = new OffscreenCanvas(W, H);
      const ctx = canvas.getContext("2d")!;
      ctx.drawImage(img, 0, 0);
      const d = ctx.getImageData(0, 0, W, H).data;
      const alpha = (x: number, y: number) => d[(y * W + x) * 4 + 3];
      const clear = 24;
      const seen = new Uint8Array(W * H);
      const queue = new Int32Array(W * H);
      // The screen is the transparent area enclosed by the device: start from the middle (phones)
      // or a little higher (laptops, where the middle can be the hinge).
      for (const [sx, sy] of [
        [W >> 1, H >> 1],
        [W >> 1, Math.round(H * 0.42)],
        [W >> 1, Math.round(H * 0.3)],
      ]) {
        if (alpha(sx, sy) > clear) continue;
        seen.fill(0);
        let head = 0;
        let tail = 0;
        queue[tail++] = sy * W + sx;
        seen[sy * W + sx] = 1;
        let minX = sx, maxX = sx, minY = sy, maxY = sy;
        let open = false;
        while (head < tail) {
          const p = queue[head++];
          const x = p % W;
          const y = (p / W) | 0;
          if (x === 0 || y === 0 || x === W - 1 || y === H - 1) {
            open = true;
            break;
          }
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
          for (const q of [p - 1, p + 1, p - W, p + W]) {
            if (!seen[q] && d[q * 4 + 3] <= clear) {
              seen[q] = 1;
              queue[tail++] = q;
            }
          }
        }
        if (open || maxX - minX < W * 0.3) continue;
        // Corner radius: how far along the diagonal the opening starts.
        let k = 0;
        while (k < (maxX - minX) / 2 && !seen[(minY + k) * W + (minX + k)]) k++;
        const r = k / (1 - Math.SQRT1_2);
        // Island / notch drawn in the art: opaque dark pixels just inside the middle of an edge of
        // the opening. Portrait art has it at the top; landscape art on the left or right.
        const cx = (minX + maxX) >> 1;
        const cy = (minY + maxY) >> 1;
        const reach = Math.round(Math.min(maxX - minX, maxY - minY) * 0.1);
        const darkAt = (x: number, y: number) => {
          const i = (y * W + x) * 4;
          return d[i + 3] > 200 && d[i] < 45 && d[i + 1] < 45 && d[i + 2] < 45;
        };
        let cutout = false;
        for (const [x0, y0, dx, dy] of [
          [cx, minY, 0, 1],
          [minX, cy, 1, 0],
          [maxX, cy, -1, 0],
        ]) {
          let dark = 0;
          for (let t = 0; t < reach; t++) if (darkAt(x0 + dx * t, y0 + dy * t)) dark++;
          if (reach > 0 && dark / reach > 0.15) cutout = true;
        }
        // Frame colour: the outermost rim of the band, a few pixels in from the silhouette (deeper
        // in, the band turns into a polished highlight), along the left and top edges.
        const inset = Math.max(1, Math.round(Math.min(W, H) * 0.002));
        const samples: number[][] = [];
        const probe = (x: number, y: number, dx: number, dy: number, limit: number) => {
          let t = 0;
          while (t < limit && alpha(x + dx * t, y + dy * t) < 250) t++;
          const u = t + inset;
          if (t >= limit || u >= limit) return;
          const i = ((y + dy * u) * W + (x + dx * u)) * 4;
          samples.push([d[i], d[i + 1], d[i + 2]]);
        };
        for (const f of [0.3, 0.4, 0.5, 0.6, 0.7]) {
          probe(0, Math.round(H * f), 1, 0, minX);
          probe(Math.round(W * f), 0, 0, 1, minY);
        }
        samples.sort((a, b) => a[0] + a[1] + a[2] - (b[0] + b[1] + b[2]));
        const mid = samples[samples.length >> 1] ?? [40, 40, 42];
        const hex = "#" + mid.map((v) => v.toString(16).padStart(2, "0")).join("");
        return { width: W, height: H, hole: { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1, r }, cutout, edge: hex };
      }
      return null;
    }, src);
    if (!found) return undefined;
    writeFileSync(disk, JSON.stringify(found));
    const art = { ...found, file } as BezelArt;
    analysisCache.set(key, art);
    return art;
  } finally {
    await page.close().catch(() => undefined);
  }
}

/**
 * The installed bezel for this model and colour, if there is one. The art's screen opening has to
 * fit the screen: the same shape for the model's own art (so a screenshot is never stretched), and
 * the same size in pixels for art filed under a sibling (a foldable's folded and open states).
 */
export async function findBezel(model: DeviceModel, color: ColorOption | undefined, landscape = false): Promise<BezelArt | undefined> {
  if (!color) return undefined;
  const models = [model.id, ...(model.shareArt ?? [])];
  const entries = listBezels()
    .filter((e) => models.includes(e.model) && norm(e.color) === norm(color.name))
    .sort((a, b) => Number(b.model === model.id) - Number(a.model === model.id) || Number(b.landscape === landscape) - Number(a.landscape === landscape));
  const [sw, sh] = [Math.min(model.screen.width, model.screen.height), Math.max(model.screen.width, model.screen.height)];
  for (const e of entries) {
    if (e.landscape !== landscape && (e.landscape || e.model !== model.id)) continue;
    const art = await analyze(e.file);
    if (!art) continue;
    const [hw, hh] = [Math.min(art.hole.w, art.hole.h), Math.max(art.hole.w, art.hole.h)];
    const fits = e.model === model.id ? Math.abs(hw / hh - sw / sh) < 0.03 * (sw / sh) : Math.abs(hw - sw) < 0.02 * sw && Math.abs(hh - sh) < 0.02 * sh;
    if (fits) return art;
  }
  return undefined;
}

/**
 * Copy bezel PNGs (files, or folders searched recursively, such as a mounted bezel disk image)
 * into the bezel folder. Only images named after a known model and colour are kept.
 */
export function importBezels(paths: string[], o: { only?: string } = {}): { added: number; skipped: number; unknown: string[] } {
  const root = bezelsDir();
  mkdirSync(root, { recursive: true });
  let added = 0;
  let skipped = 0;
  const unknown: string[] = [];
  for (const p of paths) {
    if (!existsSync(p)) continue;
    const base = statSync(p).isDirectory() ? p : path.dirname(p);
    const files = statSync(p).isDirectory() ? walk(p) : [p];
    for (const f of files) {
      const hit = classify(f, base, o.only);
      if (!hit) {
        skipped++;
        if (unknown.length < 200) unknown.push(path.relative(base, f));
        continue;
      }
      const dest = path.join(root, path.relative(base, f));
      mkdirSync(path.dirname(dest), { recursive: true });
      copyFileSync(f, dest);
      added++;
    }
  }
  indexCache = undefined;
  return { added, skipped, unknown };
}

// ---------------------------------------------------------------------------------------------
// Getting the bezels from Apple. The person accepts Apple's license themselves: each disk image
// is opened with `open`, so macOS shows Apple's license window; nothing is imported until they
// agree and the volume mounts.

export const BEZEL_SETS = [
  { id: "iPhone-18", label: "iPhone 18 Pro and Pro Max", mb: 144, models: ["iphone-18-pro", "iphone-18-pro-max"] },
  { id: "iPhone-Duo", label: "iPhone Duo", mb: 331, models: ["iphone-duo", "iphone-duo-open"] },
  { id: "iPhone-17", label: "iPhone 17, 17 Pro, Air", mb: 265, models: ["iphone-17", "iphone-17-pro", "iphone-17-pro-max", "iphone-air"] },
  { id: "Apple-Watch-Series-11-2025", label: "Apple Watch Series 11", mb: 341, models: ["apple-watch-46mm", "apple-watch-42mm"] },
  { id: "Apple-Watch-Ultra-3-2025", label: "Apple Watch Ultra 3", mb: 314, models: ["apple-watch-ultra"] },
  { id: "MacBook-Pro-M5", label: "MacBook Pro", mb: 30, models: ["macbook-pro-14", "macbook-pro-16"] },
  { id: "MacBook-Air-M5", label: "MacBook Air", mb: 46, models: ["macbook-air-13", "macbook-air-15"] },
  { id: "iPad-Pro-(M5)", label: "iPad Pro", mb: 7, models: ["ipad-pro-13", "ipad-pro-11"] },
  { id: "iPad-Air-(M4)", label: "iPad Air", mb: 12, models: ["ipad-air-13", "ipad-air-11"] },
  { id: "iPad-mini-(A17-Pro)", label: "iPad mini", mb: 7, models: ["ipad-mini"] },
  { id: "iPad-(A16)", label: "iPad", mb: 10, models: ["ipad"] },
] as const;

/** Sets suggested when nothing is installed yet. */
export const SUGGESTED_SETS = ["iPhone-18", "iPhone-17", "MacBook-Pro-M5"];

// Which sets have been imported, so they're never downloaded twice.
const recordFile = () => path.join(bezelsDir(), ".installed.json");
function installedRecord(): Record<string, { at: string; images: number }> {
  try {
    return JSON.parse(readFileSync(recordFile(), "utf8"));
  } catch {
    return {};
  }
}

/** Each Apple set, whether it's installed (imported before, or its images are in the folder) and how many images it has. */
export function bezelSets() {
  const record = installedRecord();
  const entries = listBezels();
  return BEZEL_SETS.map((set) => {
    const images = entries.filter((e) => (set.models as readonly string[]).includes(e.model)).length;
    const covered = set.models.every((m) => entries.some((e) => e.model === m));
    return { id: set.id, label: set.label, mb: set.mb, installed: Boolean(record[set.id]) || covered, images };
  });
}

export interface BezelJob {
  running: boolean;
  step: string;
  progress?: number;
  error?: string;
  imported: number;
}

let job: BezelJob = { running: false, step: "", imported: 0 };
export const bezelJob = () => job;

async function download(url: string, file: string, onProgress: (p: number) => void): Promise<void> {
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`Apple's server said ${res.status} for ${path.basename(url)}`);
  const total = Number(res.headers.get("content-length") ?? 0);
  if (existsSync(file) && total && statSync(file).size === total) return;
  const { createWriteStream } = await import("node:fs");
  const out = createWriteStream(`${file}.part`);
  let got = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    got += value.length;
    if (!out.write(value)) await new Promise<void>((r) => out.once("drain", () => r()));
    if (total) onProgress(got / total);
  }
  await new Promise<void>((resolve, reject) => out.end((e?: Error | null) => (e ? reject(e) : resolve())));
  const { renameSync } = await import("node:fs");
  renameSync(`${file}.part`, file);
}

/**
 * Download the chosen sets from Apple, open each for the person to accept, then import. Sets that
 * are already installed are skipped unless `again` is set.
 */
export async function getAppleBezels(sets: string[], again = false): Promise<void> {
  if (job.running) return;
  job = { running: true, step: "Starting…", imported: 0 };
  const { run } = await import("../util/exec.js");
  const installed = new Set(bezelSets().filter((s) => s.installed).map((s) => s.id));
  // Sets whose images couldn't be placed: said at the end, the others still added.
  const failed: string[] = [];
  try {
    for (const id of sets) {
      const set = BEZEL_SETS.find((s) => s.id === id);
      if (!set || (installed.has(set.id) && !again)) continue;
      const dmg = path.join(cacheDir("bezel-downloads"), `Bezel-${set.id}.dmg`);
      job = { ...job, step: `Downloading ${set.label} from Apple (${set.mb} MB)…`, progress: 0 };
      await download(`https://devimages-cdn.apple.com/design/resources/download/Bezel-${encodeURIComponent(set.id).replace(/%28/g, "(").replace(/%29/g, ")")}.dmg`, dmg, (p) => (job = { ...job, progress: p }));
      const before = new Set(readdirSync("/Volumes"));
      job = { ...job, step: `Accept Apple's license for ${set.label} in the window that opened…`, progress: undefined };
      await run("open", [dmg]);
      // Wait for the volume to appear (it only mounts once the license is accepted).
      let volume: string | undefined;
      for (let i = 0; i < 600 && !volume; i++) {
        await new Promise((r) => setTimeout(r, 1000));
        volume = readdirSync("/Volumes").find((v) => !before.has(v));
      }
      if (!volume) throw new Error(`Apple's license for ${set.label} wasn't accepted, so nothing was added.`);
      job = { ...job, step: `Adding ${set.label}…` };
      const mount = path.join("/Volumes", volume);
      await new Promise((r) => setTimeout(r, 800));
      const { added, unknown } = importBezels([mount], { only: set.models.length === 1 ? set.models[0] : undefined });
      job = { ...job, imported: job.imported + added };
      await run("hdiutil", ["detach", "-quiet", mount]).catch(() => undefined);
      if (added) {
        writeFileSync(recordFile(), JSON.stringify({ ...installedRecord(), [set.id]: { at: new Date().toISOString(), images: added } }, null, 2));
        // The images are in the bezel folder now; the disk image can go.
        rmSync(dmg, { force: true });
      } else {
        // Keep the download (trying again won't fetch it twice), and say which files weren't placed.
        console.error(`Bezels: none of ${unknown.length} images in ${set.label} were recognised:\n  ${unknown.join("\n  ")}`);
        failed.push(`${set.label}: none of its ${unknown.length} images were recognised${unknown.length ? ` (such as “${path.basename(unknown[0])}”)` : ""}`);
      }
    }
    job = {
      ...job,
      running: false,
      step: job.imported ? `Added ${job.imported} bezel images.` : failed.length ? "" : "No bezel images were found.",
      progress: undefined,
      error: failed.length ? `${failed.join(". ")}. The file names are in the engine log; please send them over so it can be fixed.` : undefined,
    };
  } catch (e) {
    job = { ...job, running: false, step: "", progress: undefined, error: (e as Error).message };
  }
}
