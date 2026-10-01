/**
 * Saved scenes: every design in the Studio is a document in the output folder
 * (.studio/scenes/<id>.json), saved as you work, with a small thumbnail rendered in the background.
 */
import { createHash, randomBytes } from "node:crypto";
import { copyFileSync, existsSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { type Family, findModel } from "../devices/catalog.js";
import { readSidecar } from "../devices/resolve.js";
import { CANVAS_PRESETS, defaultCanvasFor } from "../render/layouts.js";
import { createMockup, resolveCanvas } from "../render/mockup.js";
import type { MockupInput } from "../render/schema.js";
import { cacheDir, ensureDir, outputRoot, resolveUserPath, slug } from "../util/files.js";

export interface SavedScene {
  id: string;
  name: string;
  scene: MockupInput | { devices: never[]; [k: string]: unknown };
  /** The Ask AI conversation that goes with this scene. */
  chat?: unknown[];
  /**
   * A video of several shots: each one's length and how it comes in, and (after the first, which is
   * `scene`) its scene. Absent for a single design.
   */
  shots?: Array<{ scene?: unknown; name?: string; length?: number; transition?: { type: string; duration?: number } }>;
  /**
   * A design made at several sizes (iPhone, iPad, Apple Watch…): each size's screens, every one with
   * its scene. The first is the same as `scene` and `shots`. Absent for a design at one size.
   */
  groups?: SavedGroup[];
  createdAt: string;
  updatedAt: string;
  /** Set when the last change came from an agent (the MCP server), so the Studio can pick it up. */
  by?: "agent";
}

export interface SavedGroup {
  name?: string;
  shots: Array<{ scene: unknown; name?: string; length?: number; transition?: { type: string; duration?: number } }>;
}

/** What a scene shows, for filtering: a device family, or a website in a browser frame. */
export type SceneKind = Family | "web";

export interface SceneSummary {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  devices: number;
  /** The kinds of device in it, in order, without repeats. */
  kinds: SceneKind[];
  /** The devices as the scene names them ("iPhone 17 Pro"). */
  deviceNames: string[];
  /** The caption as plain text. */
  headline?: string;
  /** Canvas size in pixels, when it can be told without laying the scene out. */
  size?: { width: number; height: number };
  /** Thumbnail image, when one has been rendered, and when (ms), so cached copies refresh. */
  thumb?: string;
  thumbAt?: number;
  /** "agent" when the last change was saved through the MCP server. */
  by?: "agent";
  /** How many shots, when it's a video of several. */
  shots?: number;
  /** How many sizes, when it's made at several. */
  sizes?: number;
}

const THUMB_WIDTH = 640;

// The library's folder: the Studio's own output folder. The MCP server points this at the Studio's.
let library: () => string = outputRoot;
export function useLibrary(folder: () => string) {
  library = folder;
}
export const libraryFolder = () => library();

const dir = () => ensureDir(path.join(library(), ".studio", "scenes"));
const file = (id: string) => path.join(dir(), `${id}.json`);
const thumbFile = (id: string) => path.join(dir(), `${id}.jpg`);
const validId = (id: unknown): id is string => typeof id === "string" && /^[a-z0-9]{6,32}$/.test(id);

function read(id: string): SavedScene | undefined {
  try {
    return JSON.parse(readFileSync(file(id), "utf8"));
  } catch {
    return undefined;
  }
}

function write(s: SavedScene) {
  // Write then rename, so a crash mid-write never leaves a half file.
  const tmp = `${file(s.id)}.tmp`;
  writeFileSync(tmp, JSON.stringify(s, null, 2));
  renameSync(tmp, file(s.id));
}

type SceneDevice = { device?: string; frame?: string; screenshot?: string };

/** What a device shows and what to call it. A device left to detection is told by its capture's notes. */
function describe(d: SceneDevice): { kind?: SceneKind; name: string } {
  if (d.frame === "browser") return { kind: "web", name: "Browser" };
  if (d.frame === "window") return { kind: "mac", name: "Mac window" };
  if (d.device && (!d.frame || d.frame === "device")) return { kind: findModel(d.device)?.family, name: d.device };
  const notes = d.screenshot ? readSidecar(d.screenshot) : undefined;
  const model = notes?.deviceName ? findModel(notes.deviceName) : undefined;
  const kind: SceneKind | undefined = model?.family ?? (notes?.kind === "web" ? "web" : notes?.kind === "mac" ? "mac" : undefined);
  // A bare screenshot or card still counts as the platform it was captured on.
  if (d.frame && d.frame !== "device") return { kind, name: d.frame === "card" ? "Card" : "Screenshot" };
  if (model) return { kind, name: model.name };
  if (notes?.kind === "web") return { kind, name: "Browser" };
  if (notes?.kind === "mac") return { kind, name: notes.app ?? "Mac" };
  return { name: "Device" };
}

function summarize(s: SavedScene): SceneSummary {
  const sc = s.scene as Partial<MockupInput> & { devices: SceneDevice[] };
  const devices: SceneDevice[] = Array.isArray(sc?.devices) ? sc.devices : [];
  const described = devices.map(describe);
  const kinds = described.map((d) => d.kind);
  let size: SceneSummary["size"];
  try {
    // With no canvas set, the engine picks one from the first device (16:9 for a Mac with a phone).
    const desktop = kinds.some((k) => k === "mac" || k === "web");
    const mixed = devices.length > 1 && desktop && kinds.some((k) => k && k !== "mac" && k !== "web");
    const first = kinds[0] === "web" ? "flat" : kinds[0];
    if (sc.canvas || first) {
      const c = resolveCanvas(sc.canvas, sc.landscape, mixed ? "16:9" : defaultCanvasFor(first ?? "iphone"));
      size = { width: c.width, height: c.height };
    }
  } catch {
    // An unknown preset: leave the size out.
  }
  const thumb = thumbFile(s.id);
  const thumbAt = existsSync(thumb) ? statSync(thumb).mtimeMs : undefined;
  return {
    id: s.id,
    name: s.name,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
    devices: devices.length,
    kinds: [...new Set(kinds.filter((k): k is SceneKind => Boolean(k)))],
    deviceNames: described.map((d) => d.name),
    headline: typeof sc.headline === "string" ? sc.headline.replace(/\*\*/g, "").replace(/\s+/g, " ").trim() || undefined : undefined,
    size,
    thumb: thumbAt ? thumb : undefined,
    thumbAt: thumbAt ? Math.round(thumbAt) : undefined,
    by: s.by,
    shots: s.shots && s.shots.length > 1 ? s.shots.length : undefined,
    sizes: s.groups && s.groups.length > 1 ? s.groups.length : undefined,
  };
}

// Scenes with devices but no thumbnail (imported, or saved before thumbnails) get one, once per run.
const thumbTried = new Set<string>();

export function listScenes(): SceneSummary[] {
  const out: SceneSummary[] = [];
  for (const f of readdirSync(dir())) {
    if (!f.endsWith(".json")) continue;
    const s = read(f.slice(0, -5));
    if (!s) continue;
    const summary = summarize(s);
    if (summary.devices && !summary.thumb && !thumbTried.has(s.id)) {
      thumbTried.add(s.id);
      scheduleThumb(s.id, 400);
    }
    out.push(summary);
  }
  return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function getScene(id: unknown): SavedScene {
  if (!validId(id)) throw new Error("Unknown scene");
  const s = read(id);
  if (!s) throw new Error("That scene no longer exists");
  return s;
}

/** Save a scene: a new document when `id` is missing, else an update. Returns its summary. */
type Shot = SavedGroup["shots"][number];

/** A design's screens at its first size, each with its scene: `scene` and the rest of `shots`. */
export function firstScreens(s: Pick<SavedScene, "scene" | "shots">): Shot[] {
  return s.shots && s.shots.length > 1 ? s.shots.map((x, i) => ({ ...x, scene: i === 0 ? s.scene : x.scene }) as Shot) : [{ scene: s.scene }];
}

/** Sizes with the first one's screens replaced (what saving `scene` and `shots` changes). */
export function withFirstSize(groups: SavedGroup[], scene: unknown, shots?: SavedScene["shots"]): SavedGroup[] {
  return [{ ...groups[0], shots: firstScreens({ scene: scene as SavedScene["scene"], shots }) }, ...groups.slice(1)];
}

/** What a size is called: its image size's short name ("iPad 13″"), its pixels, or "Auto size". */
export function sizeLabel(scene: unknown): string {
  const c = (scene as { canvas?: unknown } | undefined)?.canvas;
  if (typeof c === "string" && CANVAS_PRESETS[c]) return CANVAS_PRESETS[c].short ?? CANVAS_PRESETS[c].label;
  if (typeof c === "string" && /^\d+x\d+$/.test(c)) return c.replace("x", " × ");
  if (c && typeof c === "object" && "width" in c && "height" in c) return `${(c as { width: number }).width} × ${(c as { height: number }).height}`;
  return "Auto size";
}

/** Every size of a saved design, each with its screens in store order (one size when it has no others). */
export function sceneSizes(s: SavedScene): Array<{ label: string; screens: Shot[] }> {
  const groups = s.groups && s.groups.length > 1 ? s.groups : [{ shots: firstScreens(s) }];
  return groups.map((g) => ({ label: g.name ?? sizeLabel(g.shots[0]?.scene), screens: g.shots }));
}

/** Sizes as sent: at most 12, each with its screens (at most 20), every screen with a scene. */
function cleanGroups(raw: unknown[]): SavedGroup[] {
  return raw
    .slice(0, 12)
    .filter((g): g is { name?: unknown; shots: unknown[] } => Boolean(g) && typeof g === "object" && Array.isArray((g as { shots?: unknown }).shots))
    .map((g) => ({
      ...(typeof g.name === "string" && g.name.trim() ? { name: g.name.trim().slice(0, 80) } : {}),
      shots: g.shots.slice(0, 20).filter((x): x is SavedGroup["shots"][number] => Boolean(x) && typeof x === "object" && Boolean((x as { scene?: unknown }).scene)),
    }))
    .filter((g) => g.shots.length);
}

export function saveScene(input: { id?: unknown; name?: unknown; scene: unknown; chat?: unknown; shots?: unknown; groups?: unknown; by?: "agent" }): SceneSummary {
  if (!input.scene || typeof input.scene !== "object" || !Array.isArray((input.scene as { devices?: unknown }).devices)) throw new Error("A scene needs a devices array");
  const now = new Date().toISOString();
  const existing = validId(input.id) ? read(input.id) : undefined;
  const id = existing?.id ?? randomBytes(8).toString("hex");
  const name = (typeof input.name === "string" && input.name.trim().slice(0, 120)) || existing?.name || "Untitled design";
  const chat = Array.isArray(input.chat) ? input.chat.slice(-60) : existing?.chat;
  // Only a change to the design counts as an edit: not a rename, nor saving it unchanged (switching
  // scenes, opening the Scenes page), so the list keeps its order.
  // Shots: as sent, cleared with null (a single design again), else kept (an agent saving the first).
  const shots = input.shots === null ? undefined : Array.isArray(input.shots) && input.shots.length > 1 ? (input.shots.slice(0, 20) as SavedScene["shots"]) : Array.isArray(input.shots) ? undefined : existing?.shots;
  // Sizes: as sent, cleared with null, else kept; saving just the first size (an agent sending
  // `scene` and `shots`) replaces that one and keeps the others.
  let groups = input.groups === null ? undefined : Array.isArray(input.groups) ? cleanGroups(input.groups) : existing?.groups;
  if (groups && groups.length < 2) groups = undefined;
  if (groups && input.groups === undefined) groups = withFirstSize(groups, input.scene, shots);
  const changed =
    !existing ||
    JSON.stringify(existing.scene) !== JSON.stringify(input.scene) ||
    JSON.stringify(existing.shots ?? null) !== JSON.stringify(shots ?? null) ||
    JSON.stringify(existing.groups ?? null) !== JSON.stringify(groups ?? null);
  // Who made the last change: the Studio's own saves clear an agent's mark.
  const by = changed ? input.by : existing.by;
  const saved: SavedScene = { id, name, scene: input.scene as SavedScene["scene"], chat, shots, groups, createdAt: existing?.createdAt ?? now, updatedAt: changed ? now : existing.updatedAt, by };
  write(saved);
  if (changed || !existsSync(thumbFile(id))) scheduleThumb(id);
  return summarize(saved);
}

export function deleteScene(id: unknown) {
  if (!validId(id)) throw new Error("Unknown scene");
  rmSync(file(id), { force: true });
  rmSync(thumbFile(id), { force: true });
}

/** A scene by id, or by name: the exact name, else the only one containing the words. */
export function findScene(ref: { id?: string; name?: string }): SavedScene {
  if (ref.id) return getScene(ref.id);
  const q = (ref.name ?? "").trim().toLowerCase();
  if (!q) throw new Error("Give the scene's id or its name.");
  const all = listScenes();
  const exact = all.filter((x) => x.name.toLowerCase() === q);
  const hits = exact.length ? exact : all.filter((x) => x.name.toLowerCase().includes(q));
  if (hits.length === 1) return getScene(hits[0].id);
  if (!hits.length) throw new Error(`No scene named "${ref.name}". Scenes: ${all.slice(0, 20).map((x) => `"${x.name}"`).join(", ") || "none yet"}.`);
  throw new Error(`${hits.length} scenes match "${ref.name}": ${hits.map((x) => `"${x.name}" (${x.id})`).join(", ")}. Use an id.`);
}

/**
 * Bring the files a scene uses into the library's folder (the Studio only shows files from there):
 * screenshots and recordings into uploads/, a backdrop photo into backdrops/, fonts into fonts/.
 * A file already inside stays where it is. Returns the scene with its paths updated.
 */
export function adoptFiles<T extends Record<string, unknown>>(scene: T): { scene: T; copied: string[] } {
  const root = path.resolve(library());
  const cache = path.resolve(cacheDir(""));
  const copied: string[] = [];
  const inside = (p: string) => [root, cache].some((r) => p === r || p.startsWith(r + path.sep));
  const adopt = (value: unknown, folder: string): unknown => {
    if (typeof value !== "string" || !value || /^(https?:|unsplash:|data:|asset:)/i.test(value)) return value;
    const src = resolveUserPath(value);
    if (!existsSync(src) || !statSync(src).isFile()) return value;
    if (inside(src)) return src;
    const st = statSync(src);
    const tag = createHash("sha1").update(`${src}:${st.size}:${st.mtimeMs}`).digest("hex").slice(0, 8);
    const dest = path.join(ensureDir(path.join(root, folder)), `${slug(path.parse(src).name)}-${tag}${path.extname(src).toLowerCase()}`);
    if (!existsSync(dest)) {
      copyFileSync(src, dest);
      // A capture's notes (device, scale, app) travel with it.
      if (existsSync(`${src}.json`)) copyFileSync(`${src}.json`, `${dest}.json`);
      copied.push(dest);
    }
    return dest;
  };
  const out = structuredClone(scene) as Record<string, unknown>;
  if (Array.isArray(out.devices)) {
    out.devices = out.devices.map((d: Record<string, unknown>) => ({
      ...d,
      ...(d.screenshot !== undefined ? { screenshot: adopt(d.screenshot, "uploads") } : {}),
      ...(d.video !== undefined ? { video: adopt(d.video, "uploads") } : {}),
    }));
  }
  const bg = out.background as Record<string, unknown> | string | undefined;
  if (bg && typeof bg === "object" && bg.photo !== undefined) out.background = { ...bg, photo: adopt(bg.photo, "backdrops") };
  if (Array.isArray(out.fonts)) out.fonts = out.fonts.map((f: Record<string, unknown>) => ({ ...f, path: adopt(f.path, "fonts") }));
  return { scene: out as T, copied };
}

export function duplicateScene(id: unknown): SceneSummary {
  const s = getScene(id);
  const copy = saveScene({ name: `${s.name} copy`, scene: structuredClone(s.scene), chat: s.chat, shots: s.shots ? structuredClone(s.shots) : undefined });
  return copy;
}

// ---------------------------------------------------------------------------------------------
// Thumbnails: rendered a few seconds after the last save, one at a time.

const pending = new Map<string, NodeJS.Timeout>();
let queue: Promise<void> = Promise.resolve();

function scheduleThumb(id: string, delay = 3000) {
  clearTimeout(pending.get(id));
  pending.set(
    id,
    setTimeout(() => {
      pending.delete(id);
      queue = queue.then(() => renderThumb(id)).catch(() => undefined);
    }, delay),
  );
}

/** Render a scene's thumbnail now (after anything already queued) and return its path, if it rendered. */
export async function sceneThumb(id: string): Promise<string | undefined> {
  clearTimeout(pending.get(id));
  pending.delete(id);
  queue = queue.then(() => renderThumb(id)).catch(() => undefined);
  await queue;
  return existsSync(thumbFile(id)) ? thumbFile(id) : undefined;
}

async function renderThumb(id: string) {
  const s = read(id);
  if (!s) return;
  const out = thumbFile(id);
  if (!s.scene.devices.length) {
    rmSync(out, { force: true });
    return;
  }
  const tmp = path.join(dir(), `${id}.tmp.jpg`);
  try {
    await createMockup({ ...(structuredClone(s.scene) as MockupInput), quality: "preview", format: "jpeg", jpegQuality: 78, deliveryWidth: THUMB_WIDTH, preview: false, output: tmp });
    renameSync(tmp, out);
  } catch {
    // A scene that can't render (a missing screenshot) just keeps its old thumbnail.
  } finally {
    rmSync(tmp, { force: true });
    rmSync(`${tmp}.mockup.json`, { force: true });
  }
}
