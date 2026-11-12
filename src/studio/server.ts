import { createHash } from "node:crypto";
import { copyFileSync, createReadStream, createWriteStream, existsSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { pipeline } from "node:stream/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { marked } from "marked";
import { z } from "zod";
import { captureMac, listMacWindows } from "../capture/mac.js";
import { captureWeb, WEB_VIEWPORTS } from "../capture/web.js";
import { DEVICE_MODELS, GENERIC_COLORS, findModel } from "../devices/catalog.js";
import { recognizeText, warmUpOcr } from "../native/ocr.js";
import { getBrowser } from "../render/browser.js";
import { COLOURED_ART, artNames, stickerNames, svgSize } from "../render/images.js";
import { CLAY_TONES } from "../render/frame.js";
import { CANVAS_PRESETS } from "../render/layouts.js";
import { LOOKS } from "../render/looks.js";
import { createMockup, layoutScene, renderHtml } from "../render/mockup.js";
import { exportSet } from "../render/set.js";
import { cacheDir } from "../util/files.js";
import { GRADES, LAYOUTS, MockupInputSchema, type BackgroundInput, type MockupInput } from "../render/schema.js";
import { madeBackdrop } from "../render/background.js";
import { setImageQuality } from "../render/photos.js";
import { STILL, isRecording, momentThumb, saveStill, stillMoments } from "./stills.js";
import { waveform } from "./waveform.js";
import { asJpeg, downloadWallpaper, findWallpaper, macWallpapers } from "../render/wallpapers.js";
import { createVideo, mediaLength, VideoInputSchema } from "../render/video.js";
import { createSequence, sequenceStoryboard, SequenceInputSchema } from "../render/sequence.js";
import { captureScreenshot } from "../simulator/capture.js";
import { recordSimulator } from "../simulator/record.js";
import * as sim from "../simulator/simctl.js";
import { run } from "../util/exec.js";
import { ensureDir, outputRoot, slug, timestamp } from "../util/files.js";
import { noteStudioFolder } from "../util/studio.js";
import { changeBoard, createBoard, deleteBoard, duplicateBoard, getBoard, listBoards, summarizeBoard } from "../board/store.js";
import { scheduleBoardThumb } from "../board/thumbs.js";
import { drawLayers, previewDocument } from "../board/render.js";
import { deviceImage } from "../board/device.js";
import type { Op } from "../board/core.js";
import { agentsNow, bringIn, deliver, getComments, markSending, remove, reply, setResolved, startThread, type AnchorInput } from "../board/comments.js";
import { imageSize } from "../util/image.js";
import { aiStatus, designDirections, editScene, AIEditSchema, StoppedError } from "./ai.js";
import { RECIPES, buildRecipe } from "../design/recipes.js";
import { SET_TEMPLATES, buildSetTemplate, formOfShots, withSpill } from "../design/sets.js";
import { deleteTemplate, exportTemplate, fillTemplate, importTemplate, listTemplates, loadTemplate, renameTemplate, saveTemplate } from "./templates.js";
import { backgroundPreview, loadState, lookThumbnail, saveState, searchUnsplash, thumbnail } from "./assets.js";
import { houseStyle, updateHouseStyle } from "../util/style.js";
import { SUGGESTED_SETS, bezelJob, bezelSets, bezelSummary, bezelsDir, getAppleBezels, importBezels } from "../render/bezels.js";
import { deleteScene, duplicateScene, getScene, listScenes, saveScene, scenesUsing } from "./scenes.js";
import { markSeen, whatsNew } from "./whatsnew.js";

const here = path.dirname(fileURLToPath(import.meta.url));

function findAsset(name: string): string {
  const candidates = [path.join(here, name), path.join(here, "..", "..", "src", "studio", name), path.join(here, "..", "..", name)];
  const hit = candidates.find((p) => existsSync(p));
  if (!hit) throw new Error(`Missing studio asset ${name}`);
  return hit;
}

/** This build's version, from its package.json. */
let appVersion: string | undefined;
function version(): string {
  if (!appVersion) {
    try {
      appVersion = (JSON.parse(readFileSync(findAsset("package.json"), "utf8")) as { version?: string }).version ?? "0.0.0";
    } catch {
      appVersion = "0.0.0";
    }
  }
  return appVersion;
}

/** The Studio UI folder: dist/studio/ui when built, src/studio/ui when run with tsx. */
function uiDir(): string {
  const candidates = [path.join(here, "ui"), path.join(here, "..", "..", "src", "studio", "ui")];
  const hit = candidates.find((p) => existsSync(path.join(p, "index.html")));
  if (!hit) throw new Error("Missing Studio UI. Run npm run build.");
  return hit;
}
/** Preact and htm, served from the build (dist/studio/ui/vendor) or straight from node_modules. */
const VENDOR: Record<string, string> = {
  "preact.js": "preact/dist/preact.module.js",
  "hooks.js": "preact/hooks/dist/hooks.module.js",
  "htm.js": "htm/dist/htm.module.js",
};
function vendorFile(name: string): string | undefined {
  const built = path.join(uiDir(), "vendor", name);
  if (existsSync(built)) return built;
  const rel = VENDOR[name];
  if (!rel) return undefined;
  for (const base of [path.join(here, "..", "..", "node_modules"), path.join(process.cwd(), "node_modules")]) {
    if (existsSync(path.join(base, rel))) return path.join(base, rel);
  }
  return undefined;
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".json": "application/json",
};

/** Aborts when the Studio drops a streamed request before it's answered: its Stop button. */
function stopOnClose(res: http.ServerResponse): AbortController {
  const stop = new AbortController();
  res.on("close", () => {
    if (!res.writableFinished) stop.abort();
  });
  return stop;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function body(req: http.IncomingMessage, limit = 60 * 1024 * 1024): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, "Upload too large");
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

async function json<T>(req: http.IncomingMessage): Promise<T> {
  const raw = (await body(req)).toString("utf8");
  try {
    return raw ? JSON.parse(raw) : ({} as T);
  } catch {
    throw new HttpError(400, "Body must be JSON");
  }
}

/** Exports under way that the Studio asked to follow (`job` in the request): how far along each is. */
const jobs = new Map<string, { started: number; fraction: number; at: number }>();
function jobProgress(url: URL): ((f: number) => void) | undefined {
  const id = url.searchParams.get("job");
  if (!id || !/^[a-z0-9]{4,32}$/i.test(id)) return undefined;
  const now = Date.now();
  jobs.set(id, { started: now, fraction: 0, at: now });
  // Forgotten a while after they stop moving.
  for (const [k, j] of jobs) if (now - j.at > 10 * 60_000) jobs.delete(k);
  return (f) => {
    const j = jobs.get(id);
    if (j) Object.assign(j, { fraction: Math.max(j.fraction, Math.min(1, f)), at: Date.now() });
  };
}

/** Exports copied out of the library (Save to), which Show in Finder may point at. */
const copiedOut = new Set<string>();

function allowedFile(p: string): boolean {
  const resolved = path.resolve(p);
  // The bundled sample too (read only), so templates can show previews before there's a screenshot.
  return [outputRoot(), cacheDir(""), bezelsDir(), path.join(uiDir(), "sample")].some((root) => resolved === root || resolved.startsWith(root + path.sep));
}

/** The Studio scene an export came from, kept in its request sidecar, for the library's history. */
function exportScene(file: string): { id: string; name: string } | undefined {
  try {
    const meta = JSON.parse(readFileSync(`${file}.mockup.json`, "utf8")) as { studio?: { sceneId?: string; sceneName?: string } };
    return meta.studio?.sceneId ? { id: meta.studio.sceneId, name: meta.studio.sceneName ?? "Untitled design" } : undefined;
  } catch {
    return undefined;
  }
}

const shotThumbs = new Map<string, Promise<string | undefined>>();
async function shotThumb(scene: z.infer<typeof MockupInputSchema>, width = 240): Promise<string | undefined> {
  const key = createHash("sha1").update(JSON.stringify(scene) + (width === 240 ? "" : `@${width}`)).digest("hex");
  if (!shotThumbs.has(key)) {
    if (shotThumbs.size > 200) shotThumbs.delete(shotThumbs.keys().next().value!);
    const out = path.join(cacheDir("shot-thumbs"), `${key}.jpg`);
    shotThumbs.set(
      key,
      (existsSync(out) ? Promise.resolve() : createMockup({ ...scene, quality: "preview", format: "jpeg", jpegQuality: width > 240 ? 82 : 72, deliveryWidth: width, preview: false, output: out }).then(() => undefined))
        .then(() => `data:image/jpeg;base64,${readFileSync(out).toString("base64")}`)
        .catch(() => undefined),
    );
  }
  return shotThumbs.get(key);
}

function tagExport(file: string, url: URL) {
  const sceneId = url.searchParams.get("scene");
  if (!sceneId || !existsSync(`${file}.mockup.json`)) return;
  try {
    const meta = JSON.parse(readFileSync(`${file}.mockup.json`, "utf8"));
    meta.studio = { sceneId, sceneName: url.searchParams.get("name") ?? undefined };
    writeFileSync(`${file}.mockup.json`, JSON.stringify(meta, null, 2));
  } catch {
    // An export without history is still an export.
  }
}

/**
 * Template previews are drawn three at a time, in the order they're asked for. The Templates panel asks
 * for every one at once (sixteen sets of five screens, and the single screens); drawn all together,
 * none finishes until the end and some time out. The same preview asked for twice is drawn once.
 */
const PREVIEW_SLOTS = 3;
let previewsRunning = 0;
const previewsWaiting: Array<() => void> = [];
const previewsDrawing = new Map<string, Promise<void>>();
function drawPreview(file: string, draw: () => Promise<void>): Promise<void> {
  if (existsSync(file)) return Promise.resolve();
  const busy = previewsDrawing.get(file);
  if (busy) return busy;
  const job = (async () => {
    // A slot, or wait for one to be handed over.
    if (previewsRunning < PREVIEW_SLOTS) previewsRunning++;
    else await new Promise<void>((go) => previewsWaiting.push(go));
    try {
      if (!existsSync(file)) await draw();
    } finally {
      const next = previewsWaiting.shift();
      if (next) next();
      else previewsRunning--;
      previewsDrawing.delete(file);
    }
  })();
  previewsDrawing.set(file, job);
  return job;
}

/** A set template as a strip of its screens, side by side, for the Templates panel. */
async function setTemplateStrip(id: string, body: { devices: Array<{ screenshot: string; video?: string }>; words?: Array<{ headline?: string; subheadline?: string }> }, w: number, file: string) {
  await screensStrip(withSpill(await buildSetTemplate(id, body.devices, body.words ?? [])), w, file);
}

/** Screens side by side, small, as one picture. */
async function screensStrip(screens: Array<{ scene: MockupInput }>, w: number, file: string) {
  const each = Math.round((w - 4 * 6) / screens.length);
  const tiles: string[] = [];
  let ratio = 0;
  for (const [i, x] of screens.entries()) {
    // Strips render side by side: each one's screens get names of their own.
    const out = path.join(cacheDir("set-template-previews"), `tile-${path.basename(file, ".jpg")}-${i}.jpg`);
    await createMockup({ ...x.scene, quality: "preview", format: "jpeg", jpegQuality: 80, deliveryWidth: each * 2, preview: false, output: out });
    // As tall as the tallest screen (iPhone, iPad, iPhone Duo held open, Mac).
    const size = await imageSize(out).catch(() => undefined);
    if (size) ratio = Math.max(ratio, size.height / size.width);
    tiles.push(`<img src="data:image/jpeg;base64,${readFileSync(out).toString("base64")}" style="width:${each}px;display:block;border-radius:${Math.round(each * 0.05)}px">`);
    rmSync(out, { force: true });
    rmSync(`${out}.mockup.json`, { force: true });
  }
  const h = Math.round(each * (ratio || 2.17));
  await renderHtml(`<!doctype html><body style="margin:0;background:#16161a;display:flex;gap:6px;align-items:flex-start">${tiles.join("")}</body>`, file, w, h, { scale: 1, format: "jpeg", quality: 82, transparent: false });
}

/** The pictures added as image blocks (logos, icons, stickers), newest first; not ones taken out of the list. */
function imageLibrary(): Array<{ path: string; mtime: number }> {
  const dir = path.join(outputRoot(), "images");
  if (!existsSync(dir)) return [];
  const hidden = new Set(hiddenPictures());
  return readdirSync(dir)
    .filter((f) => /\.(png|jpe?g|webp|gif|svg)$/i.test(f) && !hidden.has(f))
    .map((f) => ({ path: path.join(dir, f), mtime: statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, 120);
}

/**
 * Deleting a picture you added. One that a design uses (a saved one, or the one open) only leaves
 * the list (images/.hidden.json): its file stays, so no design loses it. Any other moves aside
 * (images/.deleted) so Undo can bring it back, and goes for good after 30 days. Only pictures in
 * the library's images folder.
 */
const imagesDir = () => path.join(outputRoot(), "images");
const deletedDir = () => ensureDir(path.join(imagesDir(), ".deleted"));
const hiddenFile = () => path.join(imagesDir(), ".hidden.json");
function hiddenPictures(): string[] {
  try {
    const list = JSON.parse(readFileSync(hiddenFile(), "utf8"));
    return Array.isArray(list) ? list.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}
const setHidden = (names: string[]) => writeFileSync(hiddenFile(), JSON.stringify([...new Set(names)], null, 1));
function libraryPicture(p: unknown): string {
  if (typeof p !== "string" || path.dirname(path.resolve(p)) !== path.resolve(imagesDir()) || !/\.(png|jpe?g|webp|gif|svg)$/i.test(p)) throw new HttpError(403, "Only pictures you added can be deleted");
  return path.resolve(p);
}
function deletePicture(p: unknown, inUse = false): { usedIn: string[]; kept: boolean } {
  const file = libraryPicture(p);
  if (!existsSync(file)) throw new HttpError(404, "That picture isn't there any more");
  const usedIn = scenesUsing(file);
  if (usedIn.length || inUse) {
    setHidden([...hiddenPictures(), path.basename(file)]);
    return { usedIn, kept: true };
  }
  const cutoff = Date.now() - 30 * 24 * 3600 * 1000;
  for (const f of readdirSync(deletedDir())) if (statSync(path.join(deletedDir(), f)).mtimeMs < cutoff) rmSync(path.join(deletedDir(), f), { force: true });
  renameSync(file, path.join(deletedDir(), path.basename(file)));
  return { usedIn, kept: false };
}
function restorePicture(p: unknown): void {
  const file = libraryPicture(p);
  const name = path.basename(file);
  const hidden = hiddenPictures();
  if (hidden.includes(name)) return setHidden(hidden.filter((x) => x !== name));
  const kept = path.join(deletedDir(), name);
  if (!existsSync(kept)) throw new HttpError(404, "That picture can't be brought back");
  renameSync(kept, file);
}

/** Recent files the studio can show: captures, uploads, renders. */
function recentFiles(): Array<{ path: string; kind: string; mtime: number; scene?: { id: string; name: string } }> {
  const out: Array<{ path: string; kind: string; mtime: number; scene?: { id: string; name: string } }> = [];
  for (const kind of ["raw", "uploads", "mockups", "videos", "recordings"]) {
    const dir = path.join(outputRoot(), kind);
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) {
      if (!/\.(png|jpe?g|webp|mp4|mov|webm|gif)$/i.test(f) || /\.(tmp|page)\.png$|\.poster\.|\.filmstrip\./.test(f) || STILL.test(f)) continue;
      const p = path.join(dir, f);
      out.push({ path: p, kind, mtime: statSync(p).mtimeMs, scene: kind === "mockups" || kind === "videos" ? exportScene(p) : undefined });
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime).slice(0, 80);
}

/**
 * Delete a capture or render together with the files that belong to it: its metadata, the
 * request that made it, and for recordings the video/poster pair.
 */
function deleteWithCompanions(file: string): string[] {
  const parsed = path.parse(file);
  const stem = path.join(parsed.dir, parsed.name);
  const candidates = new Set([file, `${file}.json`, `${file}.mockup.json`, `${file}.html`]);
  if (/\.(mp4|mov|webm|gif)$/i.test(file)) {
    for (const extra of [".png", ".png.json", ".poster.jpg", ".filmstrip.jpg"]) candidates.add(stem + extra);
    // The stills picked from it for designs.
    for (const f of readdirSync(parsed.dir)) if (f.startsWith(`${parsed.name}.still-`)) candidates.add(path.join(parsed.dir, f));
  }
  // A recording's poster frame and the recording are one item in the library.
  if (/\.png$/i.test(file) && (parsed.dir.endsWith(`${path.sep}recordings`) || parsed.dir.endsWith(`${path.sep}uploads`))) {
    for (const ext of [".mp4", ".mov"]) if (existsSync(stem + ext)) candidates.add(stem + ext);
  }
  const deleted: string[] = [];
  for (const f of candidates) {
    if (existsSync(f) && allowedFile(f)) {
      rmSync(f, { force: true });
      deleted.push(f);
    }
  }
  return deleted;
}

/** Keep only the newest few live-preview renders. */
/** Previews are kept for a while: flipping through a set's screens in Preview reuses them (the Studio remembers 20). */
function prunePreviews(dir: string, keep = 24) {
  const files = readdirSync(dir)
    .filter((f) => f.startsWith("preview-"))
    .map((f) => ({ f, t: statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  for (const { f } of files.slice(keep * 2)) rmSync(path.join(dir, f), { force: true });
}

async function options() {
  let simulators: sim.Simulator[] = [];
  let extraDevices: string[] = [];
  try {
    simulators = await sim.listSimulators();
    extraDevices = (await sim.listDeviceTypes())
      .filter((t) => ["iPhone", "iPad", "Apple Watch"].includes(t.productFamily) && !findModel(t.name))
      .map((t) => t.name);
  } catch {
    // No Xcode: studio still renders mockups from uploads and web captures.
  }
  return {
    outputRoot: outputRoot(),
    ai: aiStatus(),
    simulators,
    devices: DEVICE_MODELS.map((m) => ({ name: m.name, aliases: m.aliases, family: m.family, colors: m.colors })),
    extraDevices,
    genericColors: GENERIC_COLORS,
    looks: LOOKS.map((l) => ({ name: l.name, tone: l.tone, description: l.description, color: l.color, photo: Boolean(l.background.photo), painting: Boolean(l.painting), colors: l.background.colors ?? l.fallback?.colors ?? [l.color], css: l.background.type === "solid" ? l.background.color : undefined })),
    canvases: CANVAS_PRESETS,
    layouts: LAYOUTS,
    grades: GRADES,
    webViewports: Object.keys(WEB_VIEWPORTS),
    bezels: bezelSummary(),
    clayTones: CLAY_TONES,
    stickers: stickerNames(),
    art: artNames(),
    colouredArt: COLOURED_ART,
    // Unsplash's photo search has an access key to use (UNSPLASH_ACCESS_KEY).
    unsplashKey: Boolean(process.env.UNSPLASH_ACCESS_KEY?.trim()),
    // The built-in sample screenshot, for template previews before there's a screenshot of your own.
    sample: existsSync(path.join(uiDir(), "sample", "mise-tonight.png")) ? path.join(uiDir(), "sample", "mise-tonight.png") : undefined,
    aiProviders: [
      process.env.OPENAI_API_KEY && "openai",
      (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || process.env.GOOGLE_GENERATIVE_AI_API_KEY) && "gemini",
      process.env.REPLICATE_API_TOKEN && "replicate",
      process.env.FAL_KEY && "fal",
    ].filter(Boolean),
  };
}

const CaptureSimSchema = z.object({
  simulator: z.string().optional(),
  bundleId: z.string().optional(),
  url: z.string().optional(),
  appearance: z.enum(["light", "dark"]).optional(),
  statusBar: z.object({ time: z.string().optional() }).optional(),
  grantPermissions: z.array(z.enum(sim.PRIVACY_SERVICES)).optional(),
  duration: z.number().optional(),
});

const CommentSchema = z.discriminatedUnion("do", [
  z.object({ do: z.literal("new"), id: z.string(), anchor: z.custom<AnchorInput>((v) => typeof v === "object" && v !== null), text: z.string(), to: z.array(z.string()).optional() }),
  z.object({ do: z.literal("reply"), id: z.string(), comment: z.string(), text: z.string(), to: z.array(z.string()).optional() }),
  z.object({ do: z.literal("resolve"), id: z.string(), comment: z.string(), resolved: z.boolean() }),
  z.object({ do: z.literal("delete"), id: z.string(), comment: z.string(), message: z.string().optional() }),
  z.object({ do: z.literal("retry"), id: z.string(), comment: z.string(), message: z.string(), agents: z.array(z.string()).min(1) }),
]);

/**
 * The person's comments on a board. Each is saved before anything is sent; the agents it names are
 * told through Agentman once the answer has gone back, and how that went is kept with the comment
 * (the Studio's polling shows it).
 */
async function commentRoute(body: unknown) {
  const a = CommentSchema.parse(body);
  const tell = (thread: string, message: string, only?: string[]) => void deliver(a.id, thread, message, only);
  // An agent tagged who hasn't worked here joins the board first, so the comment can reach it.
  if ((a.do === "new" || a.do === "reply") && a.to?.length) await bringIn(a.id, a.to);
  switch (a.do) {
    case "new": {
      const r = startThread(a.id, a.anchor, { text: a.text, by: "person", to: a.to });
      tell(r.thread.id, r.message.id);
      return { thread: r.thread, rev: r.rev };
    }
    case "reply": {
      const r = reply(a.id, a.comment, { text: a.text, by: "person", to: a.to });
      tell(r.thread.id, r.message.id);
      return { thread: r.thread, rev: r.rev };
    }
    case "resolve":
      return setResolved(a.id, a.comment, a.resolved, "person");
    case "delete":
      return remove(a.id, a.comment, a.message);
    case "retry": {
      const keys = markSending(a.id, a.comment, a.message, a.agents);
      tell(a.comment, a.message, keys);
      return { rev: getComments(a.id).rev };
    }
  }
}

async function route(req: http.IncomingMessage, res: http.ServerResponse, port: number): Promise<void> {
  // Only answer requests addressed to this machine by name. A web page on another domain that
  // resolves to 127.0.0.1 (DNS rebinding) would carry its own Host and is refused.
  const host = (req.headers.host ?? "").toLowerCase();
  if (![`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`].includes(host)) throw new HttpError(403, "Unexpected Host header");
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
  const send = (status: number, payload: unknown) => {
    res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify(payload));
  };

  if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    res.end(readFileSync(path.join(uiDir(), "index.html")));
    return;
  }
  // The canvas draws shapes with the engine's own code: its compiled module (from the build when
  // running from source).
  // The engine's pure modules (shapes, animation), so the canvas draws and animates with the same code.
  const engineModule = /^\/ui\/(shapes|animate|cursor|cuts)\.js$/.exec(url.pathname);
  if (req.method === "GET" && engineModule) {
    const name = `${engineModule[1]}.js`;
    const file = [path.join(here, "..", "render", name), path.join(here, "..", "..", "dist", "render", name)].find((f) => existsSync(f));
    if (!file) throw new HttpError(404, "Not found");
    res.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "no-cache" });
    res.end(readFileSync(file, "utf8").replace(/\n\/\/# sourceMappingURL=.*$/, ""));
    return;
  }
  // Boards: the canvas works on boards with the engine's own core (HTML in and out, every change).
  if (req.method === "GET" && url.pathname === "/ui/board-core.js") {
    const file = [path.join(here, "..", "board", "core.js"), path.join(here, "..", "..", "dist", "board", "core.js")].find((f) => existsSync(f));
    if (!file) throw new HttpError(404, "Not found");
    res.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "no-cache" });
    res.end(readFileSync(file, "utf8").replace(/\n\/\/# sourceMappingURL=.*$/, ""));
    return;
  }
  if (req.method === "GET" && url.pathname.startsWith("/ui/")) {
    const rel = decodeURIComponent(url.pathname.slice(4));
    const file = rel.startsWith("vendor/") ? vendorFile(rel.slice(7)) : path.join(uiDir(), rel);
    const root = uiDir();
    if (!file || (!rel.startsWith("vendor/") && !path.resolve(file).startsWith(root + path.sep)) || !existsSync(file) || !statSync(file).isFile()) {
      throw new HttpError(404, "Not found");
    }
    res.writeHead(200, { "Content-Type": MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream", "Cache-Control": "no-cache" });
    createReadStream(file).pipe(res);
    return;
  }
  if (req.method === "GET" && url.pathname === "/thumb") {
    const p = url.searchParams.get("path") ?? "";
    if (!allowedFile(p) || !existsSync(p)) throw new HttpError(404, "Not found");
    let file = p;
    if (/\.(png|jpe?g|webp|gif|heic)$/i.test(p)) {
      try {
        file = await thumbnail(p, Number(url.searchParams.get("w") ?? 360) || 360);
      } catch {
        // Unreadable by sips: fall back to the original.
      }
    }
    res.writeHead(200, { "Content-Type": MIME[path.extname(file).toLowerCase()] ?? "image/jpeg", "Cache-Control": "max-age=86400" });
    createReadStream(file).pipe(res);
    return;
  }
  // A file's sound as a waveform, for the timeline's Sound row.
  if (req.method === "GET" && url.pathname === "/api/waveform") {
    const file = url.searchParams.get("path") ?? "";
    if (!allowedFile(file) || !existsSync(file)) throw new HttpError(404, "Not found");
    return send(200, await waveform(file));
  }
  // How long a video runs, for the timeline's Footage row.
  if (req.method === "GET" && url.pathname === "/api/media-length") {
    const file = url.searchParams.get("path") ?? "";
    if (!allowedFile(file) || !existsSync(file)) throw new HttpError(404, "Not found");
    return send(200, { duration: await mediaLength(file) });
  }
  // A recording's moments to pick its still from, and a small picture of each.
  if (req.method === "GET" && url.pathname === "/api/moments") {
    const video = url.searchParams.get("path") ?? "";
    if (!allowedFile(video) || !isRecording(video) || !existsSync(video)) throw new HttpError(404, "Not found");
    const { duration, moments } = await stillMoments(video, Math.min(8, Math.max(5, Number(url.searchParams.get("n") ?? 8) || 8)));
    return send(200, { duration, moments: moments.map((t) => ({ t, thumb: `/api/moment?path=${encodeURIComponent(video)}&t=${t}&w=240` })) });
  }
  if (req.method === "GET" && url.pathname === "/api/moment") {
    const video = url.searchParams.get("path") ?? "";
    const t = Number(url.searchParams.get("t") ?? 0);
    if (!allowedFile(video) || !isRecording(video) || !existsSync(video) || !Number.isFinite(t) || t < 0) throw new HttpError(404, "Not found");
    const file = await momentThumb(video, t, Number(url.searchParams.get("w") ?? 240));
    res.writeHead(200, { "Content-Type": "image/jpeg", "Cache-Control": "max-age=86400" });
    createReadStream(file).pipe(res);
    return;
  }
  // macOS's own wallpapers: those on this Mac, and the rest of Apple's set to download.
  if (req.method === "GET" && url.pathname === "/api/wallpapers") {
    return send(200, (await macWallpapers()).map((w) => ({ name: w.name, here: Boolean(w.file), download: w.download, thumb: w.thumb || w.file ? `/api/wallpaper-thumb?name=${encodeURIComponent(w.name)}` : null })));
  }
  if (req.method === "GET" && url.pathname === "/api/wallpaper-thumb") {
    const w = await findWallpaper(url.searchParams.get("name") ?? "");
    const src = w?.file ?? w?.thumb;
    if (!src) throw new HttpError(404, "Not found");
    const file = await asJpeg(src, 480);
    res.writeHead(200, { "Content-Type": "image/jpeg", "Cache-Control": "max-age=86400" });
    createReadStream(file).pipe(res);
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/look-thumb") {
    const file = await lookThumbnail(url.searchParams.get("name") ?? "");
    res.writeHead(200, { "Content-Type": "image/jpeg", "Cache-Control": "max-age=86400" });
    createReadStream(file).pipe(res);
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/bg-preview") {
    let bg: unknown;
    try {
      bg = JSON.parse(url.searchParams.get("bg") ?? "");
    } catch {
      throw new HttpError(400, "bg must be JSON");
    }
    const w = Number(url.searchParams.get("w") ?? 360);
    const h = Number(url.searchParams.get("h") ?? 480);
    // An AI backdrop shows once its image is made (waiting if it's being made); the canvas never
    // starts a generation, since each one costs.
    if (bg && typeof bg === "object" && "generate" in bg && !(await madeBackdrop(bg as BackgroundInput, w, h))) throw new HttpError(404, "AI backgrounds are generated when rendering");
    const file = await backgroundPreview(bg, w, h);
    res.writeHead(200, { "Content-Type": "image/jpeg", "Cache-Control": "max-age=86400" });
    createReadStream(file).pipe(res);
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/unsplash") {
    const q = (url.searchParams.get("q") ?? "").trim();
    if (!q) throw new HttpError(400, "Search for something");
    return send(200, await searchUnsplash(q, Number(url.searchParams.get("page") ?? 1) || 1));
  }
  if (req.method === "GET" && url.pathname === "/api/state") return send(200, loadState());
  if (req.method === "GET" && url.pathname === "/api/scenes") return send(200, listScenes());
  if (req.method === "GET" && url.pathname === "/api/scene") return send(200, getScene(url.searchParams.get("id")));
  if (req.method === "GET" && url.pathname === "/api/boards") {
    const list = listBoards();
    // Boards an agent changed since their thumbnail was drawn get a new one.
    for (const b of list) if (!b.thumb || Date.parse(b.updatedAt) > (b.thumbAt ?? 0)) scheduleBoardThumb(b.id, 400);
    return send(200, list);
  }
  if (req.method === "GET" && url.pathname === "/api/board") return send(200, getBoard(url.searchParams.get("id")));
  if (req.method === "GET" && url.pathname === "/board/preview") {
    // A frame as a web page, to open in a browser: /board/preview?board=…&node=…&w=<its width on the canvas>
    const b = getBoard(url.searchParams.get("board"));
    const id = url.searchParams.get("node") ?? "";
    const page = (status: number, body: string) => {
      res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(body);
    };
    if (!b.nodes[id]) return page(404, `<!doctype html><html><head><meta charset="utf-8"><title>Preview</title></head><body style="margin:0;min-height:100vh;display:grid;place-items:center;font:14px system-ui;color:#666;background:#e9e9ec">That frame isn't on the board any more.</body></html>`);
    const src = (s: string) => (/^(https?:|data:|blob:)/i.test(s) ? s : `/file?path=${encodeURIComponent(s.replace(/^file:\/\//, ""))}`);
    return page(200, previewDocument(b, id, { width: Number(url.searchParams.get("w")) || undefined, src }));
  }
  if (req.method === "GET" && url.pathname === "/api/board/rev") {
    const b = getBoard(url.searchParams.get("id"));
    // `talk` changes with the comments and the agents who worked here, so the Studio fetches those again.
    const agents = Object.values(b.agents ?? {});
    const talk = `${getComments(b.id).rev}:${agents.length}:${agents.reduce((n, a) => n + a.artboards.length, 0)}`;
    return send(200, { rev: b.rev, by: b.by, updatedAt: b.updatedAt, working: summarizeBoard(b).working, talk });
  }
  if (req.method === "GET" && url.pathname === "/api/board/agents") {
    return send(200, await agentsNow(url.searchParams.get("id") ?? ""));
  }
  if (req.method === "GET" && url.pathname === "/api/board/comments") {
    const b = getBoard(url.searchParams.get("id"));
    return send(200, { ...getComments(b.id), agents: b.agents ?? {} });
  }
  if (req.method === "GET" && url.pathname === "/api/progress") {
    // How far along an export is, and about how long it has to go (from how fast it's been).
    const j = jobs.get(url.searchParams.get("job") ?? "");
    if (!j) return send(200, { fraction: null });
    const elapsed = (Date.now() - j.started) / 1000;
    return send(200, { fraction: j.fraction, elapsed, left: j.fraction > 0.02 && j.fraction < 1 ? (elapsed * (1 - j.fraction)) / j.fraction : null });
  }
  if (req.method === "GET" && url.pathname === "/api/ai-status") return send(200, aiStatus());
  if (req.method === "GET" && url.pathname === "/docs") {
    const md = readFileSync(findAsset("README.md"), "utf8");
    // Give headings ids so the nav and in-page links work.
    const html = (await marked.parse(md)).replace(/<h([23])>(.*?)<\/h\1>/g, (_m, level: string, inner: string) => {
      const id = inner.replace(/<[^>]+>/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
      return `<h${level} id="${id}">${inner}</h${level}>`;
    });
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(readFileSync(findAsset("docs.html"), "utf8").replace("<!--CONTENT-->", html));
    return;
  }
  if (req.method === "GET" && url.pathname === "/file") {
    const p = url.searchParams.get("path") ?? "";
    if (!allowedFile(p) || !existsSync(p)) throw new HttpError(404, "Not found");
    const stat = statSync(p);
    const type = MIME[path.extname(p).toLowerCase()] ?? "application/octet-stream";
    const range = req.headers.range && /bytes=(\d*)-(\d*)/.exec(req.headers.range);
    if (range) {
      const start = Number(range[1] || 0);
      const end = range[2] ? Number(range[2]) : stat.size - 1;
      res.writeHead(206, { "Content-Type": type, "Content-Range": `bytes ${start}-${end}/${stat.size}`, "Accept-Ranges": "bytes", "Content-Length": end - start + 1 });
      createReadStream(p, { start, end }).pipe(res);
      return;
    }
    res.writeHead(200, { "Content-Type": type, "Content-Length": stat.size, "Accept-Ranges": "bytes", "Cache-Control": "no-cache" });
    createReadStream(p).pipe(res);
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/options") return send(200, await options());
  if (req.method === "GET" && url.pathname === "/api/files") return send(200, recentFiles());
  if (req.method === "GET" && url.pathname === "/api/whats-new") {
    let file = "";
    try {
      file = findAsset("CHANGELOG.md");
    } catch {
      // No changelog in this build: nothing to show.
    }
    return send(200, whatsNew(file, version()));
  }
  if (req.method === "GET" && url.pathname === "/api/recipes") return send(200, RECIPES.map(({ id, name, description, screens, wide }) => ({ id, name, description, screens, ...(wide ? { wide } : {}) })));
  // A small render of a recipe with your own screens, cached by recipe, screens and words.
  if (req.method === "GET" && url.pathname === "/api/recipe-preview") {
    let body: { devices: Array<{ screenshot: string; video?: string }>; headline?: string; subheadline?: string };
    try {
      body = JSON.parse(url.searchParams.get("body") ?? "");
    } catch {
      throw new HttpError(400, "body must be JSON");
    }
    const id = url.searchParams.get("id") ?? "";
    if (!body.devices?.length || body.devices.some((d) => !allowedFile(d.screenshot))) throw new HttpError(403, "Screenshots must be in the output folder");
    const w = Math.max(160, Math.min(800, Number(url.searchParams.get("w") ?? 360)));
    const stamp = body.devices.map((d) => (existsSync(d.screenshot) ? statSync(d.screenshot).mtimeMs : 0)).join(",");
    const file = path.join(cacheDir("recipe-previews"), `${createHash("sha1").update(JSON.stringify([id, body, w, stamp, 2])).digest("hex").slice(0, 20)}.jpg`);
    await drawPreview(file, async () => {
      const scene = await buildRecipe(id, body.devices, body);
      await createMockup({ ...scene, quality: "preview", format: "jpeg", jpegQuality: 82, deliveryWidth: w, preview: false, output: file });
      rmSync(`${file}.mockup.json`, { force: true });
    });
    res.writeHead(200, { "Content-Type": "image/jpeg", "Cache-Control": "max-age=3600" });
    createReadStream(file).pipe(res);
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/set-templates") return send(200, SET_TEMPLATES.map(({ id, name, description, forms }) => ({ id, name, description, ...(forms ? { forms } : {}) })));
  if (req.method === "GET" && url.pathname === "/api/set-form") {
    // What the first screenshot is (iPhone, iPad, iPhone Duo open either way, Mac), so the sets made for it come first.
    const shot = url.searchParams.get("shot") ?? "";
    if (!allowedFile(shot)) throw new HttpError(403, "Screenshots must be in the output folder");
    return send(200, { form: await formOfShots([{ screenshot: shot }]) });
  }
  if (req.method === "GET" && url.pathname === "/api/my-templates") return send(200, { templates: listTemplates() });
  if (req.method === "GET" && url.pathname === "/api/my-template-preview") {
    // One of your templates as a strip, filled with the open design's screenshots (or the sample's).
    let body: { devices?: Array<{ screenshot: string; video?: string }>; words?: Array<{ headline?: string; subheadline?: string }> } = {};
    try {
      body = JSON.parse(url.searchParams.get("body") ?? "{}");
    } catch {
      throw new HttpError(400, "body must be JSON");
    }
    const id = url.searchParams.get("id") ?? "";
    const devices = body.devices?.length && body.devices.every((d) => allowedFile(d.screenshot)) ? body.devices : [{ screenshot: path.join(uiDir(), "sample", "mise-tonight.png") }];
    const t = loadTemplate(id);
    const w = Math.max(320, Math.min(1200, Number(url.searchParams.get("w") ?? 640)));
    const stamp = devices.map((d) => (existsSync(d.screenshot) ? statSync(d.screenshot).mtimeMs : 0)).join(",");
    const file = path.join(cacheDir("set-template-previews"), `${createHash("sha1").update(JSON.stringify(["mine", t, devices, body.words, w, stamp])).digest("hex").slice(0, 20)}.jpg`);
    await drawPreview(file, () => screensStrip(withSpill(fillTemplate(t, devices, body.words ?? [])), w, file));
    res.writeHead(200, { "Content-Type": "image/jpeg", "Cache-Control": "max-age=600" });
    createReadStream(file).pipe(res);
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/set-template-preview") {
    // A whole set as one strip of small screens, made from the person's screenshots.
    let body: { devices: Array<{ screenshot: string; video?: string }>; words?: Array<{ headline?: string; subheadline?: string }> };
    try {
      body = JSON.parse(url.searchParams.get("body") ?? "");
    } catch {
      throw new HttpError(400, "body must be JSON");
    }
    const id = url.searchParams.get("id") ?? "";
    if (!body.devices?.length || body.devices.some((d) => !allowedFile(d.screenshot))) throw new HttpError(403, "Screenshots must be in the output folder");
    const w = Math.max(320, Math.min(1200, Number(url.searchParams.get("w") ?? 640)));
    const stamp = body.devices.map((d) => (existsSync(d.screenshot) ? statSync(d.screenshot).mtimeMs : 0)).join(",");
    const file = path.join(cacheDir("set-template-previews"), `${createHash("sha1").update(JSON.stringify([id, body, w, stamp, 1])).digest("hex").slice(0, 20)}.jpg`);
    await drawPreview(file, () => setTemplateStrip(id, body, w, file));
    res.writeHead(200, { "Content-Type": "image/jpeg", "Cache-Control": "max-age=3600" });
    createReadStream(file).pipe(res);
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/house-style") return send(200, { notes: houseStyle() });
  if (req.method === "GET" && url.pathname === "/api/images") return send(200, { images: imageLibrary() });
  if (req.method === "GET" && url.pathname === "/api/bezels") return send(200, { ...bezelSummary(), sets: bezelSets(), suggested: SUGGESTED_SETS, job: bezelJob() });
  if (req.method === "GET" && url.pathname === "/api/apps") {
    const { s, all } = await sim.withSimulatorLock(async () => {
      const s = await sim.resolveSimulator({ simulator: url.searchParams.get("simulator") || undefined });
      await sim.bootSimulator(s.udid, false, s.state);
      return { s, all: await sim.listApps(s.udid, true) };
    });
    const apps = all.filter((a) => url.searchParams.get("system") === "1" || a.type !== "System");
    return send(200, { simulator: s, apps });
  }
  if (req.method === "GET" && url.pathname === "/api/mac-windows") return send(200, await listMacWindows());
  if (req.method === "GET" && url.pathname === "/api/text") {
    const p = url.searchParams.get("path") ?? "";
    if (!allowedFile(p)) throw new HttpError(404, "Not found");
    return send(200, await recognizeText(p));
  }

  if (req.method !== "POST") throw new HttpError(404, "Not found");
  // A custom header can't be sent cross-site without a CORS preflight, which this server never
  // grants, so other web pages can't drive the simulator or render through it.
  if (req.headers["x-screenshotter"] !== "studio") throw new HttpError(403, "Missing studio header");

  switch (url.pathname) {
    case "/api/ai-edit": {
      const input = AIEditSchema.parse(await json(req));
      if (url.searchParams.get("stream") !== "1") return send(200, await editScene(input));
      // Streamed: one JSON object per line: progress steps as they happen, then the result.
      // Stop in the Studio closes the request, which stops the edit at whatever step it's on.
      const stop = stopOnClose(res);
      res.writeHead(200, { "Content-Type": "application/x-ndjson", "Cache-Control": "no-store" });
      const line = (o: unknown) => !res.destroyed && res.write(JSON.stringify(o) + "\n");
      try {
        const result = await editScene(input, (p) => line({ type: "progress", ...p }), stop.signal);
        line({ type: "result", ...result });
      } catch (e) {
        if (!(e instanceof StoppedError)) line({ type: "error", error: e instanceof z.ZodError ? e.issues.map((i) => i.message).join("; ") : (e as Error).message });
      }
      res.end();
      return;
    }
    case "/api/ai-directions": {
      const input = AIEditSchema.parse({ instruction: "Design it for me", ...(await json<object>(req)) });
      const stop = stopOnClose(res);
      res.writeHead(200, { "Content-Type": "application/x-ndjson", "Cache-Control": "no-store" });
      const line = (o: unknown) => !res.destroyed && res.write(JSON.stringify(o) + "\n");
      try {
        const result = await designDirections(input, (p) => line({ type: "progress", ...p }), stop.signal);
        line({ type: "result", ...result });
      } catch (e) {
        if (!(e instanceof StoppedError)) line({ type: "error", error: e instanceof z.ZodError ? e.issues.map((i) => i.message).join("; ") : (e as Error).message });
      }
      res.end();
      return;
    }
    case "/api/my-template/save": {
      const { name, screens, keepWords } = await json<{ name: string; screens: Array<{ name?: string; scene: unknown }>; keepWords?: boolean }>(req);
      if (!Array.isArray(screens) || !screens.length) throw new HttpError(400, "Nothing to save");
      const t = saveTemplate(String(name ?? ""), screens.map((x) => ({ name: x.name, scene: MockupInputSchema.parse(x.scene) })), Boolean(keepWords));
      return send(200, { id: t.id, name: t.name, screens: t.screens.length });
    }
    case "/api/my-template": {
      const { id, devices, words } = await json<{ id: string; devices: Array<{ screenshot: string; video?: string }>; words?: Array<{ headline?: string; subheadline?: string }> }>(req);
      if (!Array.isArray(devices) || !devices.length) throw new HttpError(400, "Add a screenshot first: templates use your screens.");
      for (const d of devices) if (!allowedFile(d.screenshot)) throw new HttpError(403, "Screenshots must be in the output folder");
      return send(200, { screens: fillTemplate(loadTemplate(id), devices, words ?? []) });
    }
    case "/api/my-template/rename": {
      const { id, name } = await json<{ id: string; name: string }>(req);
      renameTemplate(id, String(name ?? ""));
      return send(200, { ok: true });
    }
    case "/api/my-template/delete": {
      const { id } = await json<{ id: string }>(req);
      deleteTemplate(id);
      return send(200, { ok: true });
    }
    case "/api/my-template/export": {
      const { id } = await json<{ id: string }>(req);
      return send(200, { path: exportTemplate(id) });
    }
    case "/api/my-template/import": {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const t = importTemplate(Buffer.concat(chunks).toString("utf8"));
      return send(200, { id: t.id, name: t.name, screens: t.screens.length });
    }
    case "/api/set-template": {
      const { id, devices, words } = await json<{ id: string; devices: Array<{ screenshot: string; video?: string }>; words?: Array<{ headline?: string; subheadline?: string }> }>(req);
      if (!Array.isArray(devices) || !devices.length) throw new HttpError(400, "Add a screenshot first: templates use your screens.");
      for (const d of devices) if (!allowedFile(d.screenshot)) throw new HttpError(403, "Screenshots must be in the output folder");
      return send(200, { screens: await buildSetTemplate(id, devices, words ?? []) });
    }
    case "/api/recipe": {
      const { id, devices, headline, subheadline } = await json<{ id: string; devices: Array<{ screenshot: string; video?: string }>; headline?: string; subheadline?: string }>(req);
      if (!Array.isArray(devices) || !devices.length) throw new HttpError(400, "Add a screenshot first: recipes use your screens.");
      for (const d of devices) if (!allowedFile(d.screenshot)) throw new HttpError(403, "Screenshots must be in the output folder");
      return send(200, { scene: await buildRecipe(id, devices, { headline, subheadline }) });
    }
    case "/api/sample": {
      // The sample screenshot joins the person's own, so it behaves like any other.
      const src = path.join(uiDir(), "sample", "mise-tonight.png");
      if (!existsSync(src)) throw new HttpError(404, "The sample screenshot is missing from this build");
      const dest = path.join(ensureDir(path.join(outputRoot(), "uploads")), "sample-recipe-app.png");
      if (!existsSync(dest)) copyFileSync(src, dest);
      return send(200, { path: dest });
    }
    case "/api/still": {
      const { video, t } = await json<{ video?: string; t?: number }>(req);
      if (!video || !allowedFile(video) || !isRecording(video) || !existsSync(video)) throw new HttpError(403, "Recordings must be in the output folder");
      if (typeof t !== "number" || !Number.isFinite(t) || t < 0) throw new HttpError(400, "t must be a time in seconds");
      return send(200, await saveStill(video, t));
    }
    case "/api/state": {
      const state = await json<{ ui?: { imageQuality?: unknown } }>(req);
      saveState(state);
      setImageQuality(state?.ui?.imageQuality);
      return send(200, { ok: true });
    }
    case "/api/scenes/save":
      return send(200, saveScene(await json(req)));
    case "/api/images/delete": {
      const b = await json<{ path: string; inUse?: boolean }>(req);
      return send(200, deletePicture(b.path, b.inUse === true));
    }
    case "/api/images/restore":
      restorePicture((await json<{ path: string }>(req)).path);
      return send(200, { ok: true });
    case "/api/scenes/delete":
      deleteScene((await json<{ id: string }>(req)).id);
      return send(200, { ok: true });
    case "/api/board/new": {
      const b = createBoard((await json<{ name?: string }>(req)).name, "studio");
      return send(200, b);
    }
    case "/api/board/ops": {
      const b = await json<{ id: string; ops: Op[]; base?: number }>(req);
      // The Studio sends steps with components' copies already worked out.
      // A copy placed meanwhile (by an agent) that they didn't know of is brought in line too.
      const changed = changeBoard(b.id, b.ops, "studio", b.base, { expand: false, reconcile: true });
      if (!b.ops.every((o) => o.op === "working" || o.op === "agent")) scheduleBoardThumb(b.id);
      return send(200, { rev: changed.board.rev, updatedAt: changed.board.updatedAt, stale: changed.stale || Boolean(changed.repaired) });
    }
    case "/api/board/comment":
      return send(200, await commentRoute(await json(req)));
    case "/api/board/delete":
      deleteBoard((await json<{ id: string }>(req)).id);
      return send(200, { ok: true });
    case "/api/board/duplicate": {
      const copy = duplicateBoard((await json<{ id: string }>(req)).id);
      scheduleBoardThumb(copy.id, 200);
      return send(200, summarizeBoard(copy));
    }
    case "/api/board/device": {
      // A screenshot, or one of the board's artboards drawn at 3x, in a device frame.
      const a = await json<{ screenshot?: string; board?: string; node?: string; device?: string; color?: string; clay?: string }>(req);
      let shot = a.screenshot;
      if (!shot && a.board && a.node) {
        const b = getBoard(a.board);
        const { images } = await drawLayers(b, [a.node], { scale: 3, format: "png", transparent: false });
        if (!images[a.node]) throw new HttpError(400, "That artboard has no size to draw.");
        shot = path.join(cacheDir("board-artboards"), `${b.id}-${a.node}-${b.rev}.png`);
        writeFileSync(shot, images[a.node]);
      }
      if (!shot) throw new HttpError(400, "Give a screenshot, or a board and an artboard");
      return send(200, await deviceImage(shot, { device: a.device, color: a.color, clay: a.clay }));
    }
    case "/api/board/backdrop": {
      const a = await json<{ background: unknown; width?: number; height?: number }>(req);
      return send(200, { path: await backgroundPreview(a.background, a.width ?? 800, a.height ?? 1000) });
    }
    case "/api/board/export": {
      const a = await json<{ id: string; nodes: string[]; scale?: number; format?: "png" | "jpeg" }>(req);
      const b = getBoard(a.id);
      const format = a.format === "jpeg" ? "jpeg" : "png";
      const { images } = await drawLayers(b, a.nodes, { scale: Math.max(0.5, Math.min(4, a.scale ?? 2)), format, transparent: format === "png" });
      const folder = ensureDir(path.join(outputRoot(), "boards", slug(b.name) || b.id));
      const files: string[] = [];
      for (const id of a.nodes) {
        if (!images[id]) continue;
        const f = path.join(folder, `${(b.nodes[id]?.name ?? id).replace(/[/:\\]/g, "-")}${a.scale && a.scale !== 1 ? ` @${a.scale}x` : ""}.${format === "jpeg" ? "jpg" : "png"}`);
        writeFileSync(f, images[id]);
        files.push(f);
      }
      return send(200, { files });
    }
    case "/api/scenes/duplicate":
      return send(200, duplicateScene((await json<{ id: string }>(req)).id));
    case "/api/capture/simulator": {
      const a = CaptureSimSchema.parse(await json(req));
      return send(200, await captureScreenshot(a));
    }
    case "/api/capture/web":
      return send(200, await captureWeb(await json(req)));
    case "/api/capture/mac":
      return send(200, await captureMac(await json(req)));
    case "/api/record": {
      const a = CaptureSimSchema.parse(await json(req));
      return send(200, await recordSimulator(a));
    }
    case "/api/upload":
      return send(200, await upload(req, url));
    case "/api/bezels/get": {
      const { sets } = await json<{ sets: string[] }>(req);
      if (!Array.isArray(sets) || !sets.length) throw new HttpError(400, "Choose which devices to get");
      if (process.platform !== "darwin") throw new HttpError(400, "Apple's bezels come as macOS disk images");
      void getAppleBezels(sets);
      return send(200, { job: bezelJob() });
    }
    case "/api/whats-new/seen":
      markSeen(version());
      return send(200, { seen: version() });
    case "/api/house-style": {
      const { add, remove } = await json<{ add?: string[]; remove?: string[] }>(req);
      return send(200, { notes: updateHouseStyle({ add: Array.isArray(add) ? add.map(String) : undefined, remove: Array.isArray(remove) ? remove.map(String) : undefined }) });
    }
    case "/api/bezels/import": {
      const { paths } = await json<{ paths: string[] }>(req);
      if (!Array.isArray(paths) || !paths.length) throw new HttpError(400, "Choose bezel images or a folder of them");
      return send(200, { ...importBezels(paths), ...bezelSummary() });
    }
    case "/api/mockup": {
      const input = MockupInputSchema.parse(await json(req));
      if (input.quality === "preview" && !input.output) {
        const dir = ensureDir(path.join(outputRoot(), "studio"));
        prunePreviews(dir);
        input.output = path.join(dir, `preview-${timestamp()}.${input.format === "jpeg" ? "jpg" : (input.format ?? "png")}`);
      }
      const result = await createMockup(input);
      tagExport(result.path, url);
      return send(200, result);
    }
    case "/api/layout":
      return send(200, await layoutScene(MockupInputSchema.parse(await json(req))));
    case "/api/video": {
      const result = await createVideo(VideoInputSchema.parse(await json(req)), { progress: jobProgress(url) });
      tagExport(result.path, url);
      result.versions?.forEach((v) => tagExport(v.path, url));
      return send(200, result);
    }
    case "/api/sequence": {
      const result = await createSequence(SequenceInputSchema.parse(await json(req)), { progress: jobProgress(url) });
      tagExport(result.path, url);
      result.versions?.forEach((v) => tagExport(v.path, url));
      return send(200, result);
    }
    case "/api/export-set": {
      // Every screen of every size of the design, into numbered files with a contact sheet per size.
      const body = await json<{ name?: unknown; sizes?: Array<{ label?: unknown; screens?: Array<{ scene?: unknown; name?: unknown }> }>; folders?: unknown; format?: unknown; jpegQuality?: unknown; contactSheets?: unknown }>(req);
      if (!Array.isArray(body.sizes) || !body.sizes.some((x) => x.screens?.length)) throw new HttpError(400, "Nothing to export: add a screenshot first");
      const sizes = body.sizes
        .filter((x) => Array.isArray(x.screens) && x.screens.length)
        .map((x) => ({ label: String(x.label ?? "Size"), screens: x.screens!.map((sc) => ({ scene: MockupInputSchema.parse(sc.scene), name: typeof sc.name === "string" ? sc.name : undefined })) }));
      const jpegQuality = typeof body.jpegQuality === "number" ? Math.min(100, Math.max(40, Math.round(body.jpegQuality))) : undefined;
      const result = await exportSet({ name: typeof body.name === "string" ? body.name : "Design", sizes, folders: body.folders === "fastlane" ? "fastlane" : "size", format: body.format === "jpeg" ? "jpeg" : "png", jpegQuality, contactSheets: body.contactSheets !== false });
      result.sizes.forEach((x) => x.files.forEach((f) => tagExport(f.path, url)));
      return send(200, result);
    }
    case "/api/sequence-board":
      return send(200, await sequenceStoryboard(SequenceInputSchema.parse(await json(req))));
    case "/api/shot-thumb": {
      // A small picture of a shot for the shot strip, remembered by its contents.
      const scene = MockupInputSchema.parse(await json(req));
      const w = Number(url.searchParams.get("w"));
      return send(200, { image: await shotThumb(scene, Number.isFinite(w) && w > 0 ? Math.min(900, Math.max(120, Math.round(w))) : 240) });
    }
    case "/api/delete": {
      const { path: p } = await json<{ path: string }>(req);
      if (!p || !allowedFile(p) || !existsSync(p)) throw new HttpError(404, "Not found");
      const root = path.resolve(outputRoot());
      if (!path.resolve(p).startsWith(root + path.sep)) throw new HttpError(403, "Only files in the output folder can be deleted");
      return send(200, { deleted: deleteWithCompanions(p) });
    }
    case "/api/wallpaper-download": {
      // One of Apple's wallpapers, from Apple, kept on this Mac.
      const { name } = await json<{ name: string }>(req);
      if (typeof name !== "string" || !name.trim()) throw new HttpError(400, "Which wallpaper?");
      await downloadWallpaper(name);
      return send(200, { ok: true });
    }
    case "/api/open-simulator": {
      const { simulator } = await json<{ simulator?: string }>(req);
      const s = await sim.resolveSimulator({ simulator: simulator || undefined });
      await sim.bootSimulator(s.udid, false, s.state);
      const app = await sim.showSimulator(s.udid);
      return send(200, { ok: true, simulator: s.name, app });
    }
    case "/api/copy-to": {
      // A finished export copied where the capture bar's Save to says (the Desktop, a folder),
      // named like macOS names its own, never over another file.
      const { path: p, dir, name } = await json<{ path: string; dir: string; name?: string }>(req);
      if (!allowedFile(p) || !existsSync(p)) throw new HttpError(404, "Not found");
      if (typeof dir !== "string" || !path.isAbsolute(dir) || !existsSync(dir) || !statSync(dir).isDirectory()) throw new HttpError(400, "That folder isn't there any more");
      const ext = path.extname(p);
      const stem = (typeof name === "string" && name.trim() ? name.trim() : path.basename(p, ext)).replace(/[/:]/g, "-").slice(0, 120);
      let dest = path.join(dir, stem + ext);
      for (let n = 2; existsSync(dest); n++) dest = path.join(dir, `${stem} ${n}${ext}`);
      copyFileSync(p, dest);
      copiedOut.add(dest);
      return send(200, { path: dest });
    }
    case "/api/reveal": {
      const { path: p } = await json<{ path: string }>(req);
      if (!allowedFile(p) && !copiedOut.has(p)) throw new HttpError(404, "Not found");
      await run("open", ["-R", p]);
      return send(200, { ok: true });
    }
    default:
      throw new HttpError(404, "Not found");
  }
}

const UPLOAD_LIMIT = 4 * 1024 * 1024 * 1024;

/**
 * Save an upload into the output folder, streamed to disk so long screen recordings fit.
 * Screenshots and recordings go to uploads/ (the library); `kind=backdrop` photos go to
 * backdrops/ and `kind=image` pictures (logos, icons, stickers) to images/, so they don't show up
 * as screens. A recording gets a poster frame next to it
 * (same name, .png), which the library shows and the canvas uses until the video plays.
 */
async function upload(req: http.IncomingMessage, url: URL) {
  const raw = url.searchParams.get("name") ?? "upload";
  const ext = (path.extname(raw).toLowerCase() || ".png").replace(/[^.a-z0-9]/g, "");
  // An SVG or GIF is never a screenshot: whichever way it arrives, it's a picture for an image block.
  const kind = [".svg", ".gif"].includes(ext) && url.searchParams.get("kind") !== "backdrop" ? "image" : url.searchParams.get("kind");
  if (kind === "image" ? ![".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg"].includes(ext) : ![".png", ".jpg", ".jpeg", ".webp", ".mp4", ".mov"].includes(ext))
    throw new HttpError(400, kind === "image" ? "Add a PNG, JPEG, WebP, GIF or SVG" : "Upload a PNG, JPEG, WebP, MP4 or MOV");
  const folder = kind === "backdrop" ? "backdrops" : kind === "image" ? "images" : "uploads";
  const file = path.join(ensureDir(path.join(outputRoot(), folder)), `${slug(path.parse(raw).name)}-${timestamp()}${ext}`);
  const declared = Number(req.headers["content-length"] ?? 0);
  if (declared > UPLOAD_LIMIT) throw new HttpError(413, "That file is larger than 4 GB");
  try {
    await pipeline(req, createWriteStream(file));
  } catch (e) {
    rmSync(file, { force: true });
    throw e;
  }
  if (ext === ".svg") return { path: file, ...(svgSize(readFileSync(file, "utf8")) ?? {}) };
  if (![".mp4", ".mov"].includes(ext)) return { path: file, ...(await imageSize(file).catch(() => ({}))) };
  const poster = file.replace(/\.(mp4|mov)$/i, ".png");
  try {
    // The first frame, as the device shows it until the recording plays.
    await run("ffmpeg", ["-v", "error", "-y", "-i", file, "-frames:v", "1", poster], { timeoutMs: 30_000 });
    return { path: file, poster, ...(await imageSize(poster)) };
  } catch {
    // No ffmpeg: the recording still works once attached to a device with a screenshot.
    return { path: file };
  }
}

export async function startStudio(port = Number(process.env.SCREENSHOTTER_STUDIO_PORT ?? 4545), open = true): Promise<http.Server> {
  const server = http.createServer((req, res) => {
    route(req, res, port).catch((e) => {
      const status = e instanceof HttpError ? e.status : e instanceof z.ZodError ? 400 : 500;
      const message = e instanceof z.ZodError ? e.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") : (e as Error).message;
      if (!res.headersSent) res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: message }));
    });
  });
  server.requestTimeout = 0;
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`Invalid port "${port}". Use --port <0-65535> (0 picks a free port).`);
  await new Promise<void>((resolve, reject) => {
    server.once("error", (e: NodeJS.ErrnoException) =>
      reject(e.code === "EADDRINUSE" ? new Error(`Port ${port} is already in use (is the studio already running?). Try --port ${port + 1}.`) : e),
    );
    server.listen(port, "127.0.0.1", () => {
      port = (server.address() as import("node:net").AddressInfo).port;
      resolve();
    });
  });
  const url = `http://127.0.0.1:${port}`;
  // Agents using the MCP server find this Studio's library through this note.
  noteStudioFolder(outputRoot());
  // Start the renderer and the text helper now, so the first design doesn't wait for them.
  void getBrowser().catch(() => undefined);
  warmUpOcr();
  // Settings › AI backdrops: Fast or Best, as the Studio last saved it.
  setImageQuality((loadState() as { ui?: { imageQuality?: unknown } })?.ui?.imageQuality);
  console.error(`Screenshotter Studio running at ${url} (output: ${outputRoot()})`);
  console.error(`SCREENSHOTTER_STUDIO_PORT=${port}`);
  if (open) await run("open", [url]).catch(() => undefined);
  return server;
}
