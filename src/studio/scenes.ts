/**
 * Saved scenes: every design in the Studio is a document in the output folder
 * (.studio/scenes/<id>.json), saved as you work, with a small thumbnail rendered in the background.
 */
import { randomBytes } from "node:crypto";
import { existsSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createMockup } from "../render/mockup.js";
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

export interface SceneSummary {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  devices: number;
  /** Thumbnail image, when one has been rendered. */
  thumb?: string;
}

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

export function listScenes(): SceneSummary[] {
  const out: SceneSummary[] = [];
  for (const f of readdirSync(dir())) {
    if (!f.endsWith(".json")) continue;
    const s = read(f.slice(0, -5));
    if (!s) continue;
    out.push({
      id: s.id,
      name: s.name,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
      devices: Array.isArray(s.scene?.devices) ? s.scene.devices.length : 0,
      thumb: existsSync(thumbFile(s.id)) ? thumbFile(s.id) : undefined,
    });
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
  const saved: SavedScene = { id, name, scene: input.scene as SavedScene["scene"], chat, createdAt: existing?.createdAt ?? now, updatedAt: now };
  write(saved);
  scheduleThumb(id);
  return { id, name, createdAt: saved.createdAt, updatedAt: now, devices: saved.scene.devices.length, thumb: existsSync(thumbFile(id)) ? thumbFile(id) : undefined };
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
    await createMockup({ ...(structuredClone(s.scene) as MockupInput), quality: "preview", format: "jpeg", jpegQuality: 78, deliveryWidth: 480, preview: false, output: tmp });
    renameSync(tmp, out);
  } catch {
    // A scene that can't render (a missing screenshot) just keeps its old thumbnail.
  } finally {
    rmSync(tmp, { force: true });
    rmSync(`${tmp}.mockup.json`, { force: true });
  }
}
