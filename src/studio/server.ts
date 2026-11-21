import { createReadStream, createWriteStream, existsSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { pipeline } from "node:stream/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { getBrowser } from "../render/browser.js";
import { COLOURED_ART, artNames, stickerNames, svgSize } from "../render/images.js";
import { setImageQuality } from "../render/photos.js";
import { run } from "../util/exec.js";
import { cacheDir, ensureDir, outputRoot, slug, timestamp } from "../util/files.js";
import { noteStudioFolder } from "../util/studio.js";
import { boardFile, changeBoard, commentsFile, createBoard, deleteBoard, duplicateBoard, getBoard, listBoards, summarizeBoard, validBoardId, workingNow } from "../board/store.js";
import { scheduleBoardThumb } from "../board/thumbs.js";
import { drawLayers, maskFontsFor, previewDocument } from "../board/render.js";
import { importWebsite } from "../board/web-import.js";
import { importFigma } from "../board/figma-import.js";
import { connectedAgents } from "../board/agents-live.js";
import { VIDEO_EXT, videoStill } from "../board/video.js";
import { mediaInfo } from "../util/media.js";
import type { Op } from "../board/core.js";
import { liveSessions } from "../board/agentman.js";
import { agentsNow, bringIn, deliver, deliverBatch, editPending, getComments, markBatchSending, markSending, remove, reply, sendPending, setResolved, startThread, type AnchorInput } from "../board/comments.js";
import { imageSize } from "../util/image.js";
import { loadState, saveState, searchUnsplash, thumbnail } from "./assets.js";

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

/**
 * A file streamed as the answer. One that goes (or can't be read) between being found and being
 * read ends the answer there, instead of an unhandled stream error taking the engine down.
 */
function stream(res: http.ServerResponse, file: string, range?: { start: number; end: number }) {
  const s = createReadStream(file, range);
  s.on("error", () => res.destroy());
  res.on("close", () => s.destroy());
  s.pipe(res);
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
const jobs = new Map<string, { started: number; fraction: number; at: number; step?: string }>();
function jobProgress(url: URL): ((f: number, step?: string) => void) | undefined {
  const id = url.searchParams.get("job");
  if (!id || !/^[a-z0-9]{4,32}$/i.test(id)) return undefined;
  const now = Date.now();
  jobs.set(id, { started: now, fraction: 0, at: now });
  // Forgotten a while after they stop moving.
  for (const [k, j] of jobs) if (now - j.at > 10 * 60_000) jobs.delete(k);
  return (f, step) => {
    const j = jobs.get(id);
    if (j) Object.assign(j, { fraction: Math.max(j.fraction, Math.min(1, f)), at: Date.now(), ...(step ? { step } : {}) });
  };
}

/** Exports copied out of the library (Save to), which Show in Finder may point at. */
const copiedOut = new Set<string>();

function allowedFile(p: string): boolean {
  const resolved = path.resolve(p);
  return [outputRoot(), cacheDir("")].some((root) => resolved === root || resolved.startsWith(root + path.sep));
}

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
  const usedIn = boardsUsing(file);
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

/** The boards (by name) that use a picture, so deleting it from the list never breaks one. */
function boardsUsing(file: string): string[] {
  return listBoards()
    .filter((b) => {
      try {
        return readFileSync(boardFile(b.id), "utf8").includes(JSON.stringify(file).slice(1, -1));
      } catch {
        return false;
      }
    })
    .map((b) => b.name);
}

/**
 * What the Studio polls an open board for (every 0.7 s): its revision, who made it, the artboards
 * agents are working on, and `talk`, which changes with the comments and the agents who worked
 * there (so the Studio fetches those again). Kept while neither the board's file nor its comments'
 * changed: reading and parsing a big board at every poll cost the engine far more than the answer.
 */
type Presence = { key: string; name: string; kind: string; at: string; ids: string[]; doing: string; session?: string; state?: string; activeAt?: number };

/**
 * What Agentman says each session is doing (busy, idle, waiting_input, ended), so an agent between
 * board moves (thinking, rendering, running a command) stays on the board instead of dropping out.
 * Refreshed in the background: the poll never waits on Agentman, it answers with the last word.
 */
let sessionStates = new Map<string, { state?: string; lastActivityAt?: number }>();
let statesAsked = 0;
function refreshSessionStates() {
  if (Date.now() - statesAsked < 1500) return;
  statesAsked = Date.now();
  liveSessions()
    .then((ss) => { sessionStates = new Map(ss.map((x) => [x.id, { state: x.state, lastActivityAt: x.lastActivityAt }])); })
    .catch(() => { sessionStates = new Map(); });
}
const revs = new Map<string, { key: string; rev: number; by?: string; updatedAt: string; working: Record<string, string> | undefined; talk: string; presence: Presence[] }>();
function boardRev(id: string | null) {
  if (!validBoardId(id)) throw new Error("Unknown board");
  const stamp = (f: string) => {
    try {
      const s = statSync(f);
      return `${s.ino}:${s.size}:${s.mtimeMs}`;
    } catch {
      return "";
    }
  };
  const key = `${stamp(boardFile(id))}|${stamp(commentsFile(id))}`;
  let c = revs.get(id);
  if (!c || c.key !== key || key.startsWith("|")) {
    const b = getBoard(id);
    const agents = Object.values(b.agents ?? {});
    // Each agent's latest move, for its cursor in the Studio (the most recent few; the Studio lets old ones go).
    const presence = agents
      .filter((a) => a.last)
      .map((a) => ({ key: a.key, name: a.name, kind: a.kind, session: a.session, ...a.last! }))
      .sort((x, y) => y.at.localeCompare(x.at))
      .slice(0, 8);
    c = { key, rev: b.rev, by: b.by, updatedAt: b.updatedAt, working: b.working, talk: `${getComments(b.id).rev}:${agents.length}:${agents.reduce((n, a) => n + a.artboards.length, 0)}`, presence };
    revs.set(id, c);
  }
  // Who is at work is read against the clock each time: it lapses without the file changing.
  refreshSessionStates();
  const presence = c.presence.map((p) => {
    const s = p.session ? sessionStates.get(p.session) : undefined;
    return s ? { ...p, state: s.state, activeAt: s.lastActivityAt } : p;
  });
  return { rev: c.rev, by: c.by, updatedAt: c.updatedAt, working: workingNow(c.working), talk: c.talk, presence };
}

const CommentSchema = z.discriminatedUnion("do", [
  z.object({ do: z.literal("new"), id: z.string(), anchor: z.custom<AnchorInput>((v) => typeof v === "object" && v !== null), text: z.string(), to: z.array(z.string()).optional(), pending: z.boolean().optional() }),
  z.object({ do: z.literal("reply"), id: z.string(), comment: z.string(), text: z.string(), to: z.array(z.string()).optional(), pending: z.boolean().optional() }),
  z.object({ do: z.literal("edit"), id: z.string(), comment: z.string(), message: z.string(), text: z.string(), to: z.array(z.string()).optional() }),
  z.object({ do: z.literal("send"), id: z.string(), to: z.array(z.string()) }),
  z.object({ do: z.literal("resolve"), id: z.string(), comment: z.string(), resolved: z.boolean() }),
  z.object({ do: z.literal("delete"), id: z.string(), comment: z.string(), message: z.string().optional() }),
  z.object({ do: z.literal("retry"), id: z.string(), comment: z.string(), message: z.string(), agents: z.array(z.string()).min(1) }),
]);

/**
 * The person's comments on a board. Each is saved before anything is sent: pending ones wait until
 * the person sends them all (`send`), then each agent is told once, with its whole list, through
 * Agentman, once the answer has gone back; how that went is kept with each comment (the Studio's
 * polling shows it).
 */
async function commentRoute(body: unknown) {
  const a = CommentSchema.parse(body);
  const tell = (thread: string, message: string, only?: string[]) => void deliver(a.id, thread, message, only);
  // An agent tagged who hasn't worked here joins the board first, so the comment can reach it.
  if (a.do !== "resolve" && a.do !== "delete" && a.do !== "retry" && a.to?.length) await bringIn(a.id, a.to);
  switch (a.do) {
    case "new": {
      const r = startThread(a.id, a.anchor, { text: a.text, by: "person", to: a.to, pending: a.pending });
      if (!a.pending) tell(r.thread.id, r.message.id);
      return { thread: r.thread, rev: r.rev };
    }
    case "reply": {
      const r = reply(a.id, a.comment, { text: a.text, by: "person", to: a.to, pending: a.pending });
      if (!a.pending) tell(r.thread.id, r.message.id);
      return { thread: r.thread, rev: r.rev };
    }
    case "edit":
      return editPending(a.id, a.comment, a.message, a.text, a.to);
    case "send": {
      const r = sendPending(a.id, a.to);
      void deliverBatch(a.id, r.batch);
      return r;
    }
    case "resolve":
      return setResolved(a.id, a.comment, a.resolved, "person");
    case "delete":
      return remove(a.id, a.comment, a.message);
    case "retry": {
      // Sent with others: whatever of that send didn't reach the agent goes again, together.
      const batch = getComments(a.id).threads.find((t) => t.id === a.comment)?.messages.find((m) => m.id === a.message)?.batch;
      if (batch) {
        const messages = markBatchSending(a.id, batch, a.agents);
        if (messages.length) void deliverBatch(a.id, batch, { agents: a.agents, messages });
      } else {
        const keys = markSending(a.id, a.comment, a.message, a.agents);
        tell(a.comment, a.message, keys);
      }
      return { rev: getComments(a.id).rev };
    }
  }
}

/** What the board's Assets panel offers: the built-in stickers and illustrations. */
function options() {
  return {
    outputRoot: outputRoot(),
    stickers: stickerNames(),
    art: artNames(),
    colouredArt: COLOURED_ART,
    // Unsplash's photo search has an access key to use (UNSPLASH_ACCESS_KEY).
    unsplashKey: Boolean(process.env.UNSPLASH_ACCESS_KEY?.trim()),
  };
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
    // The saved theme goes on the page itself, so the first frame is already the right colours.
    const theme = (loadState() as { ui?: { theme?: unknown } })?.ui?.theme;
    const pref = theme === "light" || theme === "dark" ? theme : "system";
    res.end(readFileSync(path.join(uiDir(), "index.html"), "utf8").replace('<html lang="en">', `<html lang="en" data-theme-pref="${pref}">`));
    return;
  }
  // The canvas draws shapes with the engine's own code: its compiled module (from the build when
  // running from source).
  // The engine's pure modules (shapes, animation), so the canvas draws and animates with the same code.
  const engineModule = /^\/ui\/(shapes)\.js$/.exec(url.pathname);
  if (req.method === "GET" && engineModule) {
    const name = `${engineModule[1]}.js`;
    const file = [path.join(here, "..", "render", name), path.join(here, "..", "..", "dist", "render", name)].find((f) => existsSync(f));
    if (!file) throw new HttpError(404, "Not found");
    res.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "no-cache" });
    res.end(readFileSync(file, "utf8").replace(/\n\/\/# sourceMappingURL=.*$/, ""));
    return;
  }
  // Boards: the canvas works on boards with the engine's own core (HTML in and out, every change).
  // (and its shader model, which it imports as ./shaders.js).
  if (req.method === "GET" && (url.pathname === "/ui/board-core.js" || url.pathname === "/ui/shaders.js")) {
    const name = url.pathname === "/ui/shaders.js" ? "shaders.js" : "core.js";
    const file = [path.join(here, "..", "board", name), path.join(here, "..", "..", "dist", "board", name)].find((f) => existsSync(f));
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
    stream(res, file);
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
    stream(res, file);
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/unsplash") {
    const q = (url.searchParams.get("q") ?? "").trim();
    if (!q) throw new HttpError(400, "Search for something");
    return send(200, await searchUnsplash(q, Number(url.searchParams.get("page") ?? 1) || 1));
  }
  if (req.method === "GET" && url.pathname === "/api/state") return send(200, loadState());
  if (req.method === "GET" && url.pathname === "/api/boards") {
    const list = listBoards();
    // Boards an agent changed since their thumbnail was drawn get a new one.
    for (const b of list) if (!b.damaged && (!b.thumb || Date.parse(b.updatedAt) > (b.thumbAt ?? 0))) scheduleBoardThumb(b.id, 400);
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
    await maskFontsFor(b);
    return page(200, previewDocument(b, id, { width: Number(url.searchParams.get("w")) || undefined, src }));
  }
  // The agents connected now (onboarding shows when yours is), and whether Figma has a token.
  if (req.method === "GET" && url.pathname === "/api/agents-connected") return send(200, { agents: connectedAgents() });
  if (req.method === "GET" && url.pathname === "/api/figma") return send(200, { hasToken: Boolean(process.env.FIGMA_TOKEN?.trim()) });
  if (req.method === "GET" && url.pathname === "/api/board/rev") return send(200, boardRev(url.searchParams.get("id")));
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
    return send(200, { fraction: j.fraction, step: j.step, elapsed, left: j.fraction > 0.02 && j.fraction < 1 ? (elapsed * (1 - j.fraction)) / j.fraction : null });
  }
  if (req.method === "GET" && url.pathname === "/file") {
    const p = url.searchParams.get("path") ?? "";
    if (!allowedFile(p) || !existsSync(p)) throw new HttpError(404, "Not found");
    const stat = statSync(p);
    const type = MIME[path.extname(p).toLowerCase()] ?? "application/octet-stream";
    // One range: "bytes=10-20", "bytes=10-" (to the end) or "bytes=-500" (the last 500). Several, or
    // a malformed one, get the whole file.
    const range = req.headers.range && /^bytes=(\d*)-(\d*)$/.exec(req.headers.range.trim());
    if (range && (range[1] || range[2])) {
      const suffix = !range[1];
      const start = suffix ? Math.max(0, stat.size - Number(range[2])) : Number(range[1]);
      const end = suffix || !range[2] ? stat.size - 1 : Math.min(Number(range[2]), stat.size - 1);
      if (start >= stat.size || start > end) {
        res.writeHead(416, { "Content-Range": `bytes */${stat.size}` });
        res.end();
        return;
      }
      res.writeHead(206, { "Content-Type": type, "Content-Range": `bytes ${start}-${end}/${stat.size}`, "Accept-Ranges": "bytes", "Content-Length": end - start + 1 });
      stream(res, p, { start, end });
      return;
    }
    res.writeHead(200, { "Content-Type": type, "Content-Length": stat.size, "Accept-Ranges": "bytes", "Cache-Control": "no-cache" });
    stream(res, p);
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/options") return send(200, options());
  if (req.method === "GET" && url.pathname === "/api/images") return send(200, { images: imageLibrary() });
  if (req.method !== "POST") throw new HttpError(404, "Not found");
  // A custom header can't be sent cross-site without a CORS preflight, which this server never
  // grants, so other web pages can't drive it.
  if (req.headers["x-screenshotter"] !== "studio") throw new HttpError(403, "Missing studio header");

  switch (url.pathname) {
    case "/api/state": {
      const state = await json<{ ui?: { imageQuality?: unknown } }>(req);
      saveState(state);
      setImageQuality(state?.ui?.imageQuality);
      return send(200, { ok: true });
    }
    case "/api/images/delete": {
      const b = await json<{ path: string; inUse?: boolean }>(req);
      return send(200, deletePicture(b.path, b.inUse === true));
    }
    case "/api/images/restore":
      restorePicture((await json<{ path: string }>(req)).path);
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
    case "/api/board/import-website": {
      // A website onto a board (a new one, without `id`), as layers: it takes a while, so it says how far it's got.
      const a = z.object({ id: z.string().optional(), url: z.string(), width: z.number().optional(), fullPage: z.boolean().optional(), page: z.string().optional() }).parse(await json(req));
      const progress = jobProgress(url);
      return send(200, await importWebsite(a.id || null, { url: a.url, width: a.width, fullPage: a.fullPage, page: a.page }, "studio", (f, step) => progress?.(f, step)));
    }
    case "/api/board/import-figma": {
      // A Figma file (or one frame of it) onto a board (a new one, without `id`), as layers.
      const a = z.object({ id: z.string().optional(), url: z.string(), token: z.string().optional(), page: z.string().optional() }).parse(await json(req));
      const progress = jobProgress(url);
      return send(200, await importFigma(a.id || null, { url: a.url, token: a.token, page: a.page }, "studio", (f, step) => progress?.(f, step)));
    }
    case "/api/figma-token": {
      // The token for this run (the Mac app keeps it in the Keychain for the next).
      const { token } = await json<{ token?: string }>(req);
      if (token?.trim()) process.env.FIGMA_TOKEN = token.trim();
      else delete process.env.FIGMA_TOKEN;
      return send(200, { hasToken: Boolean(process.env.FIGMA_TOKEN) });
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
    case "/api/board/export": {
      const a = await json<{ id: string; nodes: string[]; scale?: number; format?: "png" | "jpeg" }>(req);
      const b = getBoard(a.id);
      const format = a.format === "jpeg" ? "jpeg" : "png";
      const { images } = await drawLayers(b, a.nodes, { scale: Math.max(0.5, Math.min(4, a.scale ?? 2)), format, transparent: format === "png" });
      const folder = ensureDir(path.join(outputRoot(), "boards", slug(b.name) || b.id));
      const files: string[] = [];
      const taken = new Map<string, number>();
      for (const id of a.nodes) {
        if (!images[id]) continue;
        // Two artboards called the same (a duplicate keeps its name) go to "Name" and "Name 2".
        const name = (b.nodes[id]?.name ?? id).replace(/[/:\\]/g, "-");
        const n = (taken.get(name.toLowerCase()) ?? 0) + 1;
        taken.set(name.toLowerCase(), n);
        const f = path.join(folder, `${name}${n > 1 ? ` ${n}` : ""}${a.scale && a.scale !== 1 ? ` @${a.scale}x` : ""}.${format === "jpeg" ? "jpg" : "png"}`);
        writeFileSync(f, images[id]);
        files.push(f);
      }
      return send(200, { files });
    }
    case "/api/upload":
      return send(200, await upload(req, url));
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

/** Save a picture (images/) or a video (videos/, with its first frame as its still) into the library, streamed to disk. */
async function upload(req: http.IncomingMessage, url: URL) {
  const raw = url.searchParams.get("name") ?? "upload";
  const ext = (path.extname(raw).toLowerCase() || ".png").replace(/[^.a-z0-9]/g, "");
  const video = url.searchParams.get("kind") === "video";
  if (video && !VIDEO_EXT.test(ext)) throw new HttpError(400, "Add an MP4, MOV or WebM video");
  if (!video && ![".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg"].includes(ext)) throw new HttpError(400, "Add a PNG, JPEG, WebP, GIF or SVG");
  const file = path.join(ensureDir(path.join(outputRoot(), video ? "videos" : "images")), `${slug(path.parse(raw).name)}-${timestamp()}${ext}`);
  const declared = Number(req.headers["content-length"] ?? 0);
  if (declared > UPLOAD_LIMIT) throw new HttpError(413, "That file is larger than 4 GB");
  try {
    await pipeline(req, createWriteStream(file));
  } catch (e) {
    rmSync(file, { force: true });
    throw e;
  }
  if (video) {
    const info = await mediaInfo(file).catch(() => undefined);
    return { path: file, poster: await videoStill(file), width: info?.width, height: info?.height, length: info?.length };
  }
  if (ext === ".svg") return { path: file, ...(svgSize(readFileSync(file, "utf8")) ?? {}) };
  return { path: file, ...(await imageSize(file).catch(() => ({}))) };
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
  // Start the renderer now, so the first board doesn't wait for it.
  void getBrowser().catch(() => undefined);
  // Settings › AI pictures: Fast or Best, as last saved.
  setImageQuality((loadState() as { ui?: { imageQuality?: unknown } })?.ui?.imageQuality);
  console.error(`Screenshotter Studio running at ${url} (output: ${outputRoot()})`);
  console.error(`SCREENSHOTTER_STUDIO_PORT=${port}`);
  if (open) await run("open", [url]).catch(() => undefined);
  return server;
}
