/**
 * Your own templates: a design saved as a reusable look. Every screen keeps its backdrop, layout,
 * type, devices, badges, stickers and pictures; its screenshots become slots (filled with another
 * app's screenshots, in order, when it's applied) and its words become placeholders unless they're
 * kept. Saved in the library's .studio/templates; shared as one .screenshotter-template file with
 * its pictures and photos inside.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { MockupInput } from "../render/schema.js";
import { ensureDir, slug, timestamp } from "../util/files.js";
import { libraryFolder } from "./scenes.js";

export interface SavedTemplate {
  id: string;
  name: string;
  created: string;
  /** The screens, their screenshots replaced by "slot:N" (N in order of appearance). */
  screens: Array<{ name?: string; scene: MockupInput }>;
  /** How many screenshots it was made with. */
  slots: number;
}

const SLOT = /^slot:(\d+)$/;
// In the Studio's library, like its scenes, so agents find the person's templates too.
const outputRoot = () => libraryFolder();
const dir = () => ensureDir(path.join(outputRoot(), ".studio", "templates"));
const fileOf = (id: string) => path.join(dir(), `${id.replace(/[^a-z0-9-]/gi, "")}.json`);

/** The words a template keeps for a screen when the person's own aren't kept. */
const PLACEHOLDER = "Say what it does,\n**in a few words**";

/** A design as a template: screenshots become slots; words become placeholders unless kept. */
export function saveTemplate(name: string, screens: Array<{ name?: string; scene: MockupInput }>, keepWords = false): SavedTemplate {
  const slots = new Map<string, number>();
  const slotOf = (p: string) => {
    if (!slots.has(p)) slots.set(p, slots.size);
    return `slot:${slots.get(p)}`;
  };
  const out = screens.map((x) => {
    const scene = structuredClone(x.scene) as MockupInput;
    scene.devices = (scene.devices ?? []).map((d) => {
      const { video: _v, ...rest } = d;
      return { ...rest, screenshot: d.screenshot ? slotOf(d.screenshot) : undefined } as typeof d;
    });
    // A neighbour's device carrying on: the Studio works it out again from the screens.
    delete (scene as { spill?: unknown }).spill;
    if (!keepWords) {
      if (scene.headline) scene.headline = PLACEHOLDER;
      if (scene.subheadline) scene.subheadline = "A short line with the detail";
    }
    return { ...(x.name ? { name: x.name } : {}), scene };
  });
  const id = `${slug(name).slice(0, 40) || "template"}-${timestamp().replace(/-/g, "")}`;
  const t: SavedTemplate = { id, name: name.trim() || "My template", created: new Date().toISOString(), screens: out, slots: Math.max(1, slots.size) };
  writeFileSync(fileOf(id), JSON.stringify(t, null, 1));
  return t;
}

export function listTemplates(): Array<Omit<SavedTemplate, "screens"> & { screens: number }> {
  const d = dir();
  return readdirSync(d)
    .filter((f) => f.endsWith(".json"))
    .flatMap((f) => {
      try {
        const t = JSON.parse(readFileSync(path.join(d, f), "utf8")) as SavedTemplate;
        return [{ id: t.id, name: t.name, created: t.created, slots: t.slots, screens: t.screens.length }];
      } catch {
        return [];
      }
    })
    .sort((a, b) => b.created.localeCompare(a.created));
}

export function loadTemplate(id: string): SavedTemplate {
  const f = fileOf(id);
  if (!existsSync(f)) throw new Error(`No template "${id}"`);
  return JSON.parse(readFileSync(f, "utf8")) as SavedTemplate;
}

export function renameTemplate(id: string, name: string): void {
  const t = loadTemplate(id);
  t.name = name.trim() || t.name;
  writeFileSync(fileOf(id), JSON.stringify(t, null, 1));
}

export function deleteTemplate(id: string): void {
  rmSync(fileOf(id), { force: true });
}

/**
 * A template filled in: slot N takes screenshot N (the first ones again when there are fewer), and
 * each screen takes the person's words where they have some.
 */
export function fillTemplate(t: SavedTemplate, devices: Array<{ screenshot: string; video?: string }>, words: Array<{ headline?: string; subheadline?: string }> = []) {
  if (!devices.length) throw new Error("Add a screenshot first: templates use your screens.");
  return t.screens.map((x, i) => {
    const scene = structuredClone(x.scene) as MockupInput;
    scene.devices = (scene.devices ?? []).map((d) => {
      const m = SLOT.exec(d.screenshot ?? "");
      if (!m) return d;
      const src = devices[Number(m[1]) % devices.length];
      return { ...d, screenshot: src.screenshot, ...(src.video ? { video: src.video } : {}) };
    });
    if (words[i]?.headline) scene.headline = words[i].headline;
    if (words[i]?.subheadline) scene.subheadline = words[i].subheadline;
    return { name: x.name ?? "", scene };
  });
}

// ---------------------------------------------------------------------------------------------
// Sharing: one file with the pictures and photos it uses inside.

const MIME: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif", ".svg": "image/svg+xml" };

/** Every local picture a template uses (image blocks, photo backdrops), by path. */
function assetPaths(t: SavedTemplate): string[] {
  const out = new Set<string>();
  for (const x of t.screens) {
    for (const b of x.scene.images ?? []) if (!/^(sticker:|https?:|data:)/.test(b.src) && existsSync(b.src)) out.add(b.src);
    const bg = x.scene.background;
    if (bg && typeof bg === "object" && typeof (bg as { photo?: string }).photo === "string") {
      const p = (bg as { photo: string }).photo;
      if (!/^(unsplash:|https?:|data:)/.test(p) && existsSync(p)) out.add(p);
    }
  }
  return [...out];
}

/** Write a template as a file to share: its pictures and photos packed in. Returns the file. */
export function exportTemplate(id: string): string {
  const t = loadTemplate(id);
  const assets: Record<string, { name: string; type: string; data: string }> = {};
  assetPaths(t).forEach((p, i) => {
    assets[p] = { name: `asset-${i}${path.extname(p).toLowerCase()}`, type: MIME[path.extname(p).toLowerCase()] ?? "application/octet-stream", data: readFileSync(p).toString("base64") };
  });
  const swap = (p: string) => (assets[p] ? `asset:${assets[p].name}` : p);
  const screens = t.screens.map((x) => {
    const scene = structuredClone(x.scene) as MockupInput;
    scene.images = scene.images?.map((b) => ({ ...b, src: swap(b.src) }));
    if (scene.background && typeof scene.background === "object" && typeof (scene.background as { photo?: string }).photo === "string") {
      scene.background = { ...scene.background, photo: swap((scene.background as { photo: string }).photo) } as typeof scene.background;
    }
    return { ...x, scene };
  });
  const file = path.join(ensureDir(path.join(outputRoot(), "templates")), `${t.name.replace(/[/:\\]/g, "-")}.screenshotter-template`);
  writeFileSync(file, JSON.stringify({ format: "screenshotter-template", version: 1, template: { ...t, screens }, assets: Object.fromEntries(Object.values(assets).map((a) => [a.name, { type: a.type, data: a.data }])) }));
  return file;
}

/** Add a shared template: its pictures go into the library (images/, backdrops/). */
export function importTemplate(text: string): SavedTemplate {
  let doc: { format?: string; template?: SavedTemplate; assets?: Record<string, { type: string; data: string }> };
  try {
    doc = JSON.parse(text);
  } catch {
    throw new Error("That isn't a Screenshotter template.");
  }
  if (doc.format !== "screenshotter-template" || !doc.template?.screens?.length) throw new Error("That isn't a Screenshotter template.");
  const t = doc.template;
  const stamp = timestamp();
  const written: Record<string, string> = {};
  const place = (ref: string, folder: string) => {
    const m = /^asset:(.+)$/.exec(ref);
    const a = m && doc.assets?.[m[1]];
    if (!m || !a) return ref;
    if (!written[m[1]]) {
      const out = path.join(ensureDir(path.join(outputRoot(), folder)), `${slug(t.name).slice(0, 30)}-${stamp}-${path.basename(m[1])}`);
      writeFileSync(out, Buffer.from(a.data, "base64"));
      written[m[1]] = out;
    }
    return written[m[1]];
  };
  const screens = t.screens.map((x) => {
    const scene = structuredClone(x.scene) as MockupInput;
    scene.images = scene.images?.map((b) => ({ ...b, src: place(b.src, "images") }));
    if (scene.background && typeof scene.background === "object" && typeof (scene.background as { photo?: string }).photo === "string") {
      scene.background = { ...scene.background, photo: place((scene.background as { photo: string }).photo, "backdrops") } as typeof scene.background;
    }
    return { ...x, scene };
  });
  const id = `${slug(t.name).slice(0, 40) || "template"}-${stamp.replace(/-/g, "")}`;
  const saved: SavedTemplate = { ...t, id, created: new Date().toISOString(), screens };
  mkdirSync(dir(), { recursive: true });
  writeFileSync(fileOf(id), JSON.stringify(saved, null, 1));
  return saved;
}
