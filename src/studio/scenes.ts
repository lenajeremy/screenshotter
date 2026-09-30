/**
 * Saved scenes: every design in the Studio is a document in the output folder
 * (.studio/scenes/<id>.json), saved as you work, with a small thumbnail rendered in the background.
 */
import { randomBytes } from "node:crypto";
import { existsSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { type Family, findModel } from "../devices/catalog.js";
import { readSidecar } from "../devices/resolve.js";
import { defaultCanvasFor } from "../render/layouts.js";
import { createMockup, resolveCanvas } from "../render/mockup.js";
import type { MockupInput } from "../render/schema.js";
import { ensureDir, outputRoot } from "../util/files.js";

export interface SavedScene {
  id: string;
  name: string;
  scene: MockupInput | { devices: never[]; [k: string]: unknown };
  /** The Ask AI conversation that goes with this scene. */
  chat?: unknown[];
  createdAt: string;
  updatedAt: string;
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
}

const THUMB_WIDTH = 640;

const dir = () => ensureDir(path.join(outputRoot(), ".studio", "scenes"));
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
export function saveScene(input: { id?: unknown; name?: unknown; scene: unknown; chat?: unknown }): SceneSummary {
  if (!input.scene || typeof input.scene !== "object" || !Array.isArray((input.scene as { devices?: unknown }).devices)) throw new Error("A scene needs a devices array");
  const now = new Date().toISOString();
  const existing = validId(input.id) ? read(input.id) : undefined;
  const id = existing?.id ?? randomBytes(8).toString("hex");
  const name = (typeof input.name === "string" && input.name.trim().slice(0, 120)) || existing?.name || "Untitled scene";
  const chat = Array.isArray(input.chat) ? input.chat.slice(-60) : existing?.chat;
  // Only a change to the design counts as an edit: not a rename, nor saving it unchanged (switching
  // scenes, opening the Scenes page), so the list keeps its order.
  const changed = !existing || JSON.stringify(existing.scene) !== JSON.stringify(input.scene);
  const saved: SavedScene = { id, name, scene: input.scene as SavedScene["scene"], chat, createdAt: existing?.createdAt ?? now, updatedAt: changed ? now : existing.updatedAt };
  write(saved);
  if (changed || !existsSync(thumbFile(id))) scheduleThumb(id);
  return summarize(saved);
}

export function deleteScene(id: unknown) {
  if (!validId(id)) throw new Error("Unknown scene");
  rmSync(file(id), { force: true });
  rmSync(thumbFile(id), { force: true });
}

export function duplicateScene(id: unknown): SceneSummary {
  const s = getScene(id);
  const copy = saveScene({ name: `${s.name} copy`, scene: structuredClone(s.scene), chat: s.chat });
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
