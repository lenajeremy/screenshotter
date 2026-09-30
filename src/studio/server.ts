import { createReadStream, createWriteStream, existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { pipeline } from "node:stream/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { marked } from "marked";
import { z } from "zod";
import { captureMac, listMacWindows } from "../capture/mac.js";
import { captureWeb, WEB_VIEWPORTS } from "../capture/web.js";
import { DEVICE_MODELS, GENERIC_COLORS, findModel } from "../devices/catalog.js";
import { recognizeText } from "../native/ocr.js";
import { CANVAS_PRESETS } from "../render/layouts.js";
import { LOOKS } from "../render/looks.js";
import { createMockup, layoutScene } from "../render/mockup.js";
import { cacheDir } from "../util/files.js";
import { GRADES, LAYOUTS, MockupInputSchema } from "../render/schema.js";
import { createVideo, VideoInputSchema } from "../render/video.js";
import { captureScreenshot } from "../simulator/capture.js";
import { recordSimulator } from "../simulator/record.js";
import * as sim from "../simulator/simctl.js";
import { run } from "../util/exec.js";
import { ensureDir, outputRoot, slug, timestamp } from "../util/files.js";
import { imageSize } from "../util/image.js";
import { aiStatus, editScene, AIEditSchema } from "./ai.js";
import { backgroundPreview, loadState, lookThumbnail, saveState, searchUnsplash, thumbnail } from "./assets.js";
import { houseStyle, updateHouseStyle } from "../util/style.js";
import { SUGGESTED_SETS, bezelJob, bezelSets, bezelSummary, bezelsDir, getAppleBezels, importBezels } from "../render/bezels.js";
import { deleteScene, duplicateScene, getScene, listScenes, saveScene } from "./scenes.js";
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

function allowedFile(p: string): boolean {
  const resolved = path.resolve(p);
  return [outputRoot(), cacheDir(""), bezelsDir()].some((root) => resolved === root || resolved.startsWith(root + path.sep));
}

/** The Studio scene an export came from, kept in its request sidecar, for the library's history. */
function exportScene(file: string): { id: string; name: string } | undefined {
  try {
    const meta = JSON.parse(readFileSync(`${file}.mockup.json`, "utf8")) as { studio?: { sceneId?: string; sceneName?: string } };
    return meta.studio?.sceneId ? { id: meta.studio.sceneId, name: meta.studio.sceneName ?? "Untitled scene" } : undefined;
  } catch {
    return undefined;
  }
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

/** Recent files the studio can show: captures, uploads, renders. */
function recentFiles(): Array<{ path: string; kind: string; mtime: number; scene?: { id: string; name: string } }> {
  const out: Array<{ path: string; kind: string; mtime: number; scene?: { id: string; name: string } }> = [];
  for (const kind of ["raw", "uploads", "mockups", "videos", "recordings"]) {
    const dir = path.join(outputRoot(), kind);
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) {
      if (!/\.(png|jpe?g|webp|mp4|mov|webm|gif)$/i.test(f) || /\.(tmp|page)\.png$|\.poster\.|\.filmstrip\./.test(f)) continue;
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
function prunePreviews(dir: string, keep = 6) {
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
    devices: DEVICE_MODELS.map((m) => ({ name: m.name, family: m.family, colors: m.colors })),
    extraDevices,
    genericColors: GENERIC_COLORS,
    looks: LOOKS.map((l) => ({ name: l.name, tone: l.tone, description: l.description, color: l.color, photo: Boolean(l.background.photo), painting: Boolean(l.painting), colors: l.background.colors ?? l.fallback?.colors ?? [l.color] })),
    canvases: CANVAS_PRESETS,
    layouts: LAYOUTS,
    grades: GRADES,
    webViewports: Object.keys(WEB_VIEWPORTS),
    bezels: bezelSummary(),
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
    if (bg && typeof bg === "object" && "generate" in bg) throw new HttpError(400, "AI backgrounds are generated when rendering");
    const file = await backgroundPreview(bg, Number(url.searchParams.get("w") ?? 360), Number(url.searchParams.get("h") ?? 480));
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
  if (req.method === "GET" && url.pathname === "/api/house-style") return send(200, { notes: houseStyle() });
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
      res.writeHead(200, { "Content-Type": "application/x-ndjson", "Cache-Control": "no-store" });
      const line = (o: unknown) => res.write(JSON.stringify(o) + "\n");
      try {
        const result = await editScene(input, (p) => line({ type: "progress", ...p }));
        line({ type: "result", ...result });
      } catch (e) {
        line({ type: "error", error: e instanceof z.ZodError ? e.issues.map((i) => i.message).join("; ") : (e as Error).message });
      }
      res.end();
      return;
    }
    case "/api/state":
      saveState(await json(req));
      return send(200, { ok: true });
    case "/api/scenes/save":
      return send(200, saveScene(await json(req)));
    case "/api/scenes/delete":
      deleteScene((await json<{ id: string }>(req)).id);
      return send(200, { ok: true });
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
      const result = await createVideo(VideoInputSchema.parse(await json(req)));
      tagExport(result.path, url);
      return send(200, result);
    }
    case "/api/delete": {
      const { path: p } = await json<{ path: string }>(req);
      if (!p || !allowedFile(p) || !existsSync(p)) throw new HttpError(404, "Not found");
      const root = path.resolve(outputRoot());
      if (!path.resolve(p).startsWith(root + path.sep)) throw new HttpError(403, "Only files in the output folder can be deleted");
      return send(200, { deleted: deleteWithCompanions(p) });
    }
    case "/api/open-simulator": {
      const { simulator } = await json<{ simulator?: string }>(req);
      const s = await sim.resolveSimulator({ simulator: simulator || undefined });
      await sim.bootSimulator(s.udid, false, s.state);
      const app = await sim.showSimulator(s.udid);
      return send(200, { ok: true, simulator: s.name, app });
    }
    case "/api/reveal": {
      const { path: p } = await json<{ path: string }>(req);
      if (!allowedFile(p)) throw new HttpError(404, "Not found");
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
 * backdrops/ so they don't show up as screens. A recording gets a poster frame next to it
 * (same name, .png), which the library shows and the canvas uses until the video plays.
 */
async function upload(req: http.IncomingMessage, url: URL) {
  const raw = url.searchParams.get("name") ?? "upload";
  const ext = (path.extname(raw).toLowerCase() || ".png").replace(/[^.a-z0-9]/g, "");
  if (![".png", ".jpg", ".jpeg", ".webp", ".mp4", ".mov"].includes(ext)) throw new HttpError(400, "Upload a PNG, JPEG, WebP, MP4 or MOV");
  const folder = url.searchParams.get("kind") === "backdrop" ? "backdrops" : "uploads";
  const file = path.join(ensureDir(path.join(outputRoot(), folder)), `${slug(path.parse(raw).name)}-${timestamp()}${ext}`);
  const declared = Number(req.headers["content-length"] ?? 0);
  if (declared > UPLOAD_LIMIT) throw new HttpError(413, "That file is larger than 4 GB");
  try {
    await pipeline(req, createWriteStream(file));
  } catch (e) {
    rmSync(file, { force: true });
    throw e;
  }
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
  console.error(`Screenshotter Studio running at ${url} (output: ${outputRoot()})`);
  console.error(`SCREENSHOTTER_STUDIO_PORT=${port}`);
  if (open) await run("open", [url]).catch(() => undefined);
  return server;
}
