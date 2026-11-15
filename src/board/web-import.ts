/**
 * Bringing a website onto a board: the page is opened in a browser of its own, read as it's drawn
 * (web-snapshot.ts), and becomes an artboard of ordinary layers, with its pictures and typefaces
 * copied into the library, so the person (or their agents) can change it like anything else.
 *
 * The browser here is not the engine's usual one: that one draws our own boards with web security
 * off. A website is someone else's code, so it runs with security on, can't read files, and can't
 * reach this Mac's own services or its network, apart from the site asked for (so a site running
 * on localhost can still be brought in).
 */
import { createHash } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import { findChrome } from "../render/browser.js";
import { freeSpot, htmlToNodes, type BoardFont, type Op } from "./core.js";
import { assetDir, changeBoard, createBoard, getBoard } from "./store.js";
import { SNAPSHOT } from "./web-snapshot.js";

export interface WebImportOptions {
  url: string;
  /** The window's width the page is read at (its breakpoints follow it). */
  width?: number;
  /** The whole page (the default), or just the first screen. */
  fullPage?: boolean;
}

export interface WebImportResult {
  board: string;
  artboard: string;
  name: string;
  layers: number;
  pictures: number;
  fonts: number;
  warnings: string[];
}

type Progress = (fraction: number, step: string) => void;

interface SnapNode {
  tag: string;
  name?: string;
  style?: Record<string, string>;
  attrs?: Record<string, string | null>;
  children?: Array<SnapNode | string>;
  markup?: string;
}

interface Face {
  family: string;
  weight: string;
  style: string;
  unicodeRange: string;
  src: string;
  base: string;
}

interface Snapshot {
  root: SnapNode;
  width: number;
  height: number;
  title: string;
  warnings: string[];
  shots: number;
  faces: Face[];
  unread: string[];
  families: string[];
  count: number;
}

export const IMPORT_WIDTHS = { desktop: 1440, tablet: 834, phone: 390 } as const;

/** What the person typed, as a web address: "example.com" is https://example.com/. */
export function websiteUrl(input: string): URL {
  const t = String(input ?? "").trim();
  if (!t) throw new Error("Type the website's address, like example.com.");
  let u: URL;
  try {
    u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(t) ? t : `https://${t}`);
  } catch {
    throw new Error(`"${t.slice(0, 80)}" isn't a web address. Try one like example.com.`);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("Only web pages (http or https) can be brought in.");
  return u;
}

/** A host on this Mac or its local network, which a page from elsewhere mustn't reach. */
export function privateHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h === "0.0.0.0" || h === "::" || h === "::1") return true;
  const v4 = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(h);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return a === 127 || a === 10 || a === 0 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
  }
  return /^(fc|fd|fe80)/.test(h) || h.startsWith("::ffff:");
}

const EXT: Record<string, string> = {
  "image/png": "png", "image/jpeg": "jpg", "image/jpg": "jpg", "image/gif": "gif", "image/webp": "webp", "image/avif": "avif", "image/svg+xml": "svg",
  "image/x-icon": "ico", "image/vnd.microsoft.icon": "ico", "font/woff2": "woff2", "font/woff": "woff", "application/font-woff": "woff", "font/ttf": "ttf",
  "font/otf": "otf", "application/x-font-ttf": "ttf", "application/x-font-otf": "otf", "application/font-sfnt": "ttf",
};
const KNOWN = /\.(png|jpe?g|gif|webp|avif|svg|ico|woff2?|ttf|otf)$/i;

function extOf(url: string, type?: string): string {
  const t = (type ?? "").split(";")[0].trim().toLowerCase();
  if (EXT[t]) return EXT[t];
  const m = KNOWN.exec(new URL(url, "https://x/").pathname);
  return m ? m[1].toLowerCase().replace("jpeg", "jpg") : "bin";
}

/** Keep bytes in the library, by their contents (the same picture once). */
function saveAsset(buf: Buffer, ext: string): string {
  const hash = createHash("sha1").update(buf).digest("hex").slice(0, 16);
  const out = path.join(assetDir(), `${hash}.${ext}`);
  if (!existsSync(out)) writeFileSync(out, buf);
  return out;
}

const LIMIT = 25 * 1024 * 1024;

/** A file the page loaded (kept as it came in), else fetched now as the page would have. */
async function getFile(url: string, got: Map<string, { buf: Buffer; type?: string }>, page: URL, ua: string): Promise<{ buf: Buffer; type?: string } | null> {
  const had = got.get(url);
  if (had) return had;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (!/^https?:$/.test(u.protocol) || (privateHost(u.hostname) && u.origin !== page.origin)) return null;
  try {
    const r = await fetch(u, { headers: { "User-Agent": ua, Referer: page.href, Origin: page.origin }, signal: AbortSignal.timeout(15_000), redirect: "follow" });
    if (!r.ok) return null;
    const len = Number(r.headers.get("content-length") ?? 0);
    if (len > LIMIT) return null;
    const buf = Buffer.from(await r.arrayBuffer());
    return buf.length > LIMIT ? null : { buf, type: r.headers.get("content-type") ?? undefined };
  } catch {
    return null;
  }
}

/** Run jobs a few at a time. */
async function inTurn<T>(items: T[], n: number, job: (item: T, i: number) => Promise<void>) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      await job(items[i], i);
    }
  }));
}

const CSS_URL = /url\(\s*(['"]?)([^'")]+)\1\s*\)/g;

/** A typeface's ranges: does it hold Latin letters (A, or the accented ones)? Faces for other scripts stay behind. */
function forLatin(range: string): boolean {
  if (!range.trim()) return true;
  for (const part of range.split(",")) {
    const m = /U\+([0-9A-F?]+)(?:-([0-9A-F]+))?/i.exec(part.trim());
    if (!m) continue;
    const lo = parseInt(m[1].replace(/\?/g, "0"), 16);
    const hi = m[2] ? parseInt(m[2], 16) : parseInt(m[1].replace(/\?/g, "F"), 16);
    if ((lo <= 0x41 && hi >= 0x41) || (lo <= 0x100 && hi >= 0x100)) return true;
  }
  return false;
}

/** @font-face rules in a stylesheet's text (one the page couldn't read itself), and the sheets it @imports. */
function facesIn(css: string, base: string): { faces: Face[]; imports: string[] } {
  const faces: Face[] = [];
  for (const m of css.matchAll(/@font-face\s*{([^}]*)}/gi)) {
    const get = (p: string) => new RegExp(`(?:^|[;{\\s])${p}\\s*:\\s*([^;]+)`, "i").exec(m[1])?.[1].trim() ?? "";
    faces.push({ family: get("font-family").replace(/^["']|["']$/g, ""), weight: get("font-weight"), style: get("font-style"), unicodeRange: get("unicode-range"), src: get("src"), base });
  }
  const imports = [...css.matchAll(/@import\s+(?:url\(\s*)?['"]?([^'")\s;]+)/gi)].map((m) => new URL(m[1], base).href);
  return { faces, imports };
}

/** The best file a face offers: woff2, then woff, then the rest. */
function bestSrc(face: Face): string | null {
  const all = [...face.src.matchAll(/url\(\s*(['"]?)([^'")]+)\1\s*\)\s*(?:format\(\s*['"]?([\w-]+)['"]?\s*\))?/g)].map((m) => ({ url: m[2], format: (m[3] ?? "").toLowerCase() }));
  if (!all.length) return null;
  const rank = (f: { url: string; format: string }) => {
    const k = f.format || (/\.woff2(\?|$)/i.test(f.url) ? "woff2" : /\.woff(\?|$)/i.test(f.url) ? "woff" : "");
    return ({ woff2: 0, woff: 1, truetype: 2, opentype: 3 } as Record<string, number>)[k] ?? 4;
  };
  const pick = all.sort((a, b) => rank(a) - rank(b))[0].url;
  if (/^data:/i.test(pick)) return pick;
  try {
    return new URL(pick, face.base).href;
  } catch {
    return null;
  }
}

const escText = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escAttr = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
const styleText = (style: Record<string, string> = {}) =>
  Object.entries(style)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => `${k}:${v}`)
    .join(";");

/** A wrapper that does nothing (no box, no paint, one child) is left out, so the layers stay shallow. */
function unwrap(n: SnapNode): SnapNode {
  for (;;) {
    const kids = n.children ?? [];
    if (n.tag !== "div" || kids.length !== 1 || typeof kids[0] === "string" || Object.keys(n.style ?? {}).length || n.attrs) return n;
    const only = kids[0] as SnapNode;
    if (only.tag !== "div" && only.tag !== "a") return n;
    if (!only.name && n.name) only.name = n.name;
    n = only;
  }
}

function toHtml(n: SnapNode | string): string {
  if (typeof n === "string") return escText(n);
  if (n.tag === "svg") {
    const style = styleText(n.style);
    return (n.markup ?? "").replace(/^<svg\b([^>]*?)\sstyle="([^"]*)"/, (_m, before: string, own: string) => `<svg${before} style="${escAttr(own)};${escAttr(style)}"${n.name ? ` data-name="${escAttr(n.name)}"` : ""}`);
  }
  const attrs = Object.entries(n.attrs ?? {})
    .filter(([, v]) => v !== null && v !== undefined)
    .map(([k, v]) => (v === "" && /^(muted|loop|autoplay|playsinline)$/.test(k) ? ` ${k}` : v ? ` ${k}="${escAttr(String(v))}"` : ""))
    .join("");
  const named = n.name ? ` data-name="${escAttr(n.name)}"` : "";
  const style = styleText(n.style);
  const open = `<${n.tag}${named}${attrs}${style ? ` style="${escAttr(style)}"` : ""}>`;
  if (n.tag === "img") return open;
  return `${open}${(n.children ?? []).map((c) => toHtml(typeof c === "string" ? c : unwrap(c))).join("")}</${n.tag}>`;
}

function walkTree(n: SnapNode, fn: (n: SnapNode) => void) {
  fn(n);
  for (const c of n.children ?? []) if (typeof c !== "string") walkTree(c, fn);
}

async function launch(): Promise<Browser> {
  return puppeteer.launch({
    executablePath: findChrome(),
    headless: true,
    args: ["--no-first-run", "--no-default-browser-check", "--hide-scrollbars", "--force-color-profile=srgb", "--font-render-hinting=none", "--mute-audio"],
  });
}

/** Read a website as it's drawn at `width`, with its pictures and typefaces brought into the library. */
export async function snapshotWebsite(opts: WebImportOptions, progress: Progress = () => undefined): Promise<{ html: string; title: string; width: number; height: number; fonts: BoardFont[]; pictures: number; warnings: string[] }> {
  const url = websiteUrl(opts.url);
  const width = Math.round(Math.min(2560, Math.max(320, opts.width ?? IMPORT_WIDTHS.desktop)));
  const fullPage = opts.fullPage !== false;
  const warnings: string[] = [];
  progress(0.03, `Opening ${url.hostname}`);
  const browser = await launch();
  try {
    const context = await browser.createBrowserContext();
    const page: Page = await context.newPage();
    const ua = (await browser.userAgent()).replace(/HeadlessChrome/g, "Chrome");
    await page.setUserAgent(ua);
    await page.setViewport({ width, height: width >= 1024 ? 900 : width >= 700 ? 1112 : 844, deviceScaleFactor: 1, isMobile: width < 700, hasTouch: width < 700 });
    // Only the web, and nothing on this Mac or its network but the site itself.
    await page.setRequestInterception(true);
    page.on("request", (req) => {
      let u: URL;
      try {
        u = new URL(req.url());
      } catch {
        return void req.abort().catch(() => undefined);
      }
      if (u.protocol === "data:" || u.protocol === "blob:") return void req.continue().catch(() => undefined);
      if (!/^https?:$/.test(u.protocol) || (privateHost(u.hostname) && u.origin !== url.origin)) return void req.abort().catch(() => undefined);
      req.continue().catch(() => undefined);
    });
    // Pictures, typefaces and stylesheets as the page loads them, so they aren't fetched twice.
    const got = new Map<string, { buf: Buffer; type?: string }>();
    page.on("response", (res) => {
      const kind = res.request().resourceType();
      if (kind !== "image" && kind !== "font" && kind !== "stylesheet") return;
      res.buffer().then(
        (buf) => buf.length <= LIMIT && got.set(res.url(), { buf, type: res.headers()["content-type"] }),
        () => undefined,
      );
    });
    let answer;
    try {
      answer = await page.goto(url.href, { waitUntil: "networkidle2", timeout: 45_000 });
    } catch (e) {
      // Some sites never go quiet: what's there after the wait is what's taken.
      if (!/timeout/i.test(String(e))) throw new Error(`Couldn't open ${url.hostname}: ${(e as Error).message.replace(/^net::/, "")}`);
    }
    if (answer && answer.status() >= 400) throw new Error(`${url.hostname} answered ${answer.status()}${answer.status() === 403 ? ": it may not let browsers like this one in" : ""}.`);
    progress(0.3, "Scrolling through it");
    // Down the page and back, so pictures and sections that wait to be scrolled to are drawn.
    await page.evaluate(`(async () => { const max = Math.min(document.documentElement.scrollHeight, 16000); for (let y = 0; y < max; y += innerHeight * 0.75) { scrollTo(0, y); await new Promise((r) => setTimeout(r, 140)); } scrollTo(0, 0); await new Promise((r) => setTimeout(r, 350)); })()`);
    await page.waitForNetworkIdle({ idleTime: 500, timeout: 10_000 }).catch(() => undefined);
    await page.evaluate("document.fonts.ready.then(() => true)").catch(() => undefined);
    progress(0.5, "Reading the layout");
    const snap = (await page.evaluate(`${SNAPSHOT}(${JSON.stringify({ fullPage, maxNodes: 6000, maxHeight: 16000 })})`)) as Snapshot;
    warnings.push(...snap.warnings);

    // What can't be layers (a <canvas>, an iframe, a native control): a picture of itself.
    const shots = new Map<string, string>();
    for (let i = 0; i < snap.shots; i++) {
      const el = await page.$(`[data-ss-shot="${i}"]`);
      try {
        const buf = el ? Buffer.from(await el.screenshot({ type: "png", omitBackground: true })) : null;
        if (buf) shots.set(`shot:${i}`, saveAsset(buf, "png"));
      } catch {
        // Off the page, or not drawn: it's left empty.
      }
    }

    // Pictures: into the library, so the board has them for good.
    progress(0.6, "Copying pictures");
    const urls = new Set<string>();
    walkTree(snap.root, (n) => {
      for (const k of ["src", "poster"]) {
        const v = n.attrs?.[k];
        if (v && /^https?:/.test(v) && !(n.tag === "video" && k === "src")) urls.add(v);
      }
      for (const v of Object.values(n.style ?? {})) for (const m of v.matchAll(CSS_URL)) if (/^https?:/.test(m[2])) urls.add(m[2]);
    });
    const local = new Map<string, string>();
    const list = [...urls].slice(0, 600);
    let done = 0;
    await inTurn(list, 8, async (u) => {
      const f = await getFile(u, got, url, ua);
      if (f) local.set(u, saveAsset(f.buf, extOf(u, f.type)));
      progress(0.6 + 0.25 * (++done / list.length), `Copying pictures (${done} of ${list.length})`);
    });
    const missed = list.length - local.size;
    if (missed) warnings.push(`${missed} picture${missed === 1 ? "" : "s"} couldn't be copied, so ${missed === 1 ? "it stays" : "they stay"} linked to the site.`);
    walkTree(snap.root, (n) => {
      if (n.attrs?.src) n.attrs.src = shots.get(n.attrs.src) ?? local.get(n.attrs.src) ?? (n.attrs.src.startsWith("shot:") ? "" : n.attrs.src);
      if (n.attrs?.poster) n.attrs.poster = local.get(n.attrs.poster) ?? n.attrs.poster;
      if (n.attrs && n.tag === "img" && !n.attrs.src) n.attrs.src = null;
      for (const [k, v] of Object.entries(n.style ?? {})) if (v.includes("url(")) n.style![k] = v.replace(CSS_URL, (m, _q, u: string) => (local.has(u) ? `url("${local.get(u)}")` : m));
    });

    // Typefaces the page uses, from its own stylesheets and the ones it loads from elsewhere.
    progress(0.86, "Copying fonts");
    const faces = [...snap.faces];
    const sheets = [...new Set(snap.unread)];
    for (let i = 0; i < sheets.length && i < 40; i++) {
      const f = await getFile(sheets[i], got, url, ua);
      if (!f) continue;
      const found = facesIn(f.buf.toString("utf8"), sheets[i]);
      faces.push(...found.faces);
      for (const imp of found.imports) if (!sheets.includes(imp)) sheets.push(imp);
    }
    const used = new Set(snap.families.map((f) => f.toLowerCase()));
    const fonts: BoardFont[] = [];
    const seen = new Set<string>();
    for (const face of faces) {
      if (!face.family || !used.has(face.family.toLowerCase()) || !forLatin(face.unicodeRange)) continue;
      const key = [face.family.toLowerCase(), face.weight, face.style, face.unicodeRange].join("|");
      if (seen.has(key) || fonts.length >= 48) continue;
      seen.add(key);
      const src = bestSrc(face);
      if (!src) continue;
      let file: string | undefined;
      if (/^data:/i.test(src)) {
        const m = /^data:([^;,]+)?(;base64)?,(.*)$/i.exec(src);
        if (m) file = saveAsset(Buffer.from(decodeURIComponent(m[3]), m[2] ? "base64" : "utf8"), extOf("x.woff2", m[1]));
      } else {
        const got2 = await getFile(src, got, url, ua);
        if (got2) file = saveAsset(got2.buf, extOf(src, got2.type));
      }
      if (file) fonts.push({ family: face.family, ...(face.weight && face.weight !== "normal" ? { weight: face.weight } : {}), ...(face.style && face.style !== "normal" ? { style: face.style } : {}), ...(face.unicodeRange ? { unicodeRange: face.unicodeRange } : {}), src: file });
    }
    const html = toHtml(unwrap(snap.root));
    return { html, title: snap.title, width: snap.width, height: snap.height, fonts, pictures: local.size + shots.size, warnings };
  } finally {
    await browser.close().catch(() => undefined);
  }
}

/**
 * Bring a website onto a board, as a new artboard beside the others (or onto a new board named
 * after the site, with `board` left out). One step to undo.
 */
export async function importWebsite(boardId: string | null | undefined, opts: WebImportOptions & { page?: string }, by: "agent" | "studio", progress: Progress = () => undefined): Promise<WebImportResult> {
  const snap = await snapshotWebsite(opts, progress);
  progress(0.95, "Making the layers");
  const host = websiteUrl(opts.url).hostname.replace(/^www\./, "");
  const id = boardId || createBoard(snap.title || host, by).id;
  const board = getBoard(id);
  const pid = opts.page && board.pages.some((p) => p.id === opts.page) ? opts.page : board.pages[0].id;
  const got = htmlToNodes(snap.html, { wholeSvg: true });
  if (!got.roots.length) throw new Error(`${host} had nothing to draw.`);
  const root = got.roots[0];
  const spot = freeSpot(board, pid, snap.width);
  const rs = got.nodes[root].style;
  rs.left = `${Math.round(spot.left)}px`;
  rs.top = `${Math.round(spot.top)}px`;
  delete rs.position;
  got.nodes[root].name = (snap.title || host).slice(0, 60);
  for (const r of got.roots) got.nodes[r].parent = null;
  const have = new Set((board.fonts ?? []).map((f) => [f.family.toLowerCase(), f.weight ?? "", f.style ?? "", f.unicodeRange ?? ""].join("|")));
  const ops: Op[] = [
    ...snap.fonts.filter((f) => !have.has([f.family.toLowerCase(), f.weight ?? "", f.style ?? "", f.unicodeRange ?? ""].join("|"))).map((font) => ({ op: "font" as const, font })),
    { op: "add", nodes: got.nodes, ids: [root], parent: null, page: pid },
  ];
  changeBoard(id, ops, by);
  progress(1, "Done");
  return { board: id, artboard: root, name: got.nodes[root].name, layers: Object.keys(got.nodes).length, pictures: snap.pictures, fonts: snap.fonts.length, warnings: [...snap.warnings, ...got.warnings].slice(0, 12) };
}
