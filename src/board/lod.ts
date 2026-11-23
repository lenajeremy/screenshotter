/**
 * Bitmap LOD (Level of Detail) snapshots for root artboards on large multi-artboard pages.
 *
 * When a page has dozens or hundreds of artboards (10k-100k+ layers) zoomed out on screen, rendering
 * every artboard's full DOM subtree at ~100 px tall is wasted work. This module renders lightweight
 * WebP bitmaps (<= 768 px longest edge, transparent corners preserved) in batched headless Chrome
 * passes (up to 24 artboards per page, 2 pages in parallel), cached on disk by each artboard's
 * content hash (excluding root left/top so dragging an artboard never invalidates its bitmap).
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ensureBoardTeamAssets } from "../cloud/client.js";
import { newPage } from "../render/browser.js";
import { scaledImage } from "../studio/assets.js";
import { cacheDir } from "../util/files.js";
import { BOARD_CSS, fontFaceCss, fontFamilies, fontLinks, mapCssUrls, nodeHtml, subtree, tokenCss, type Board } from "./core.js";
import { effectsScript, maskFontsFor, shaderScript } from "./render.js";
import { getBoard } from "./store.js";

const LOD_VERSION = "v1";
const LOD_BUCKETS = [512, 768];
const MAX_BATCH = 24;
const MAX_WORKERS = 2;
const COALESCE_MS = 25;

export function normalizeLodEdge(w: number | undefined): number {
  const n = Number(w) || 768;
  return LOD_BUCKETS.find((b) => b >= n) ?? 768;
}

export interface LodMeta {
  hash: string;
  ready: boolean;
  width?: number;
  height?: number;
  url: string;
}

interface DiskMeta {
  width: number;
  height: number;
  sw: number;
  sh: number;
}

function lodPaths(hash: string) {
  const dir = cacheDir("lod");
  return {
    webp: path.join(dir, `${hash}.webp`),
    meta: path.join(dir, `${hash}.json`),
  };
}

function readDiskMeta(hash: string): DiskMeta | null {
  const { webp, meta } = lodPaths(hash);
  if (!existsSync(webp) || !existsSync(meta)) return null;
  try {
    const parsed = JSON.parse(readFileSync(meta, "utf8")) as DiskMeta;
    if (typeof parsed.width === "number" && typeof parsed.height === "number" && parsed.width > 0 && parsed.height > 0) return parsed;
  } catch {
    // Corrupted meta; treat as cache miss.
  }
  return null;
}

/**
 * Content hash for one root artboard at `maxEdge`. Strips root `left` and `top` so moving an
 * artboard around the canvas keeps its cached bitmap valid.
 */
export function artboardLodHash(board: Board, rootId: string, maxEdge: number): string {
  const h = createHash("sha1");
  h.update(`${LOD_VERSION}|${maxEdge}|`);
  if (board.tokens?.length) h.update(JSON.stringify(board.tokens));
  h.update("|");
  if (board.fonts?.length) h.update(JSON.stringify(board.fonts));
  h.update("|");
  if (board.shaders?.length) h.update(JSON.stringify(board.shaders));
  const ids = subtree(board, rootId);
  for (const id of ids) {
    const n = board.nodes[id];
    if (!n || n.hidden) continue;
    h.update("\n");
    if (id === rootId) {
      const style: Record<string, string> = {};
      for (const [k, v] of Object.entries(n.style)) if (k !== "left" && k !== "top") style[k] = v;
      h.update(JSON.stringify({ t: n.type, s: style, c: n.children, tx: n.text, src: n.src, p: n.poster, svg: n.svg, d: n.defs, a: n.attrs, g: n.tag, m: n.mask, sh: n.shader, fx: n.effects }));
    } else {
      h.update(JSON.stringify({ t: n.type, s: n.style, c: n.children, tx: n.text, src: n.src, p: n.poster, svg: n.svg, d: n.defs, a: n.attrs, g: n.tag, m: n.mask, sh: n.shader, fx: n.effects }));
    }
  }
  return h.digest("hex").slice(0, 20);
}

/** Fast disk-only status check for a set of root artboards (zero Chrome). */
export function lodStatus(board: Board, roots: string[], maxEdge = 768): Record<string, LodMeta> {
  const edge = normalizeLodEdge(maxEdge);
  const out: Record<string, LodMeta> = {};
  for (const rootId of roots) {
    const n = board.nodes[rootId];
    if (!n || n.hidden || n.type !== "frame") continue;
    const hash = artboardLodHash(board, rootId, edge);
    const disk = readDiskMeta(hash);
    const url = `/api/board/lod?id=${encodeURIComponent(board.id)}&root=${encodeURIComponent(rootId)}&h=${hash}&w=${edge}`;
    out[rootId] = disk ? { hash, ready: true, width: disk.width, height: disk.height, url } : { hash, ready: false, url };
  }
  return out;
}

/** Direct disk lookup when the client already has a valid hash (fast path: zero board read). */
export function cachedLodFile(hash: string): string | null {
  if (!/^[a-f0-9]{20}$/.test(hash)) return null;
  const { webp } = lodPaths(hash);
  return existsSync(webp) ? webp : null;
}

// ---------------------------------------------------------------------------------------------
// Coalesced batched headless-Chrome LOD renderer (up to MAX_BATCH artboards/page, MAX_WORKERS pages)

interface PendingJob {
  boardId: string;
  board: Board;
  rootId: string;
  hash: string;
  maxEdge: number;
  resolve: (file: string | null) => void;
}

const inflight = new Map<string, Promise<string | null>>();
const pending: PendingJob[] = [];
let coalesceTimer: NodeJS.Timeout | null = null;
let activeWorkers = 0;

function scheduleDrain() {
  if (activeWorkers >= MAX_WORKERS) return;
  if (!coalesceTimer) {
    coalesceTimer = setTimeout(() => {
      coalesceTimer = null;
      while (activeWorkers < MAX_WORKERS && pending.length) void runWorker();
    }, COALESCE_MS);
  }
}

function enqueueLod(board: Board, rootId: string, edge: number): Promise<string | null> {
  const n = board.nodes[rootId];
  if (!n || n.hidden || n.type !== "frame") return Promise.resolve(null);
  const hash = artboardLodHash(board, rootId, edge);
  const hit = cachedLodFile(hash);
  if (hit) return Promise.resolve(hit);
  const running = inflight.get(hash);
  if (running) return running;

  const job = new Promise<string | null>((resolve) => {
    pending.push({ boardId: board.id, board, rootId, hash, maxEdge: edge, resolve });
    scheduleDrain();
  }).finally(() => inflight.delete(hash));
  inflight.set(hash, job);
  return job;
}

export function ensureLodFile(boardId: string, rootId: string, requestedHash?: string, maxEdge = 768): Promise<string | null> {
  const edge = normalizeLodEdge(maxEdge);
  if (requestedHash) {
    const hit = cachedLodFile(requestedHash);
    if (hit) return Promise.resolve(hit);
  }
  let board: Board;
  try {
    board = getBoard(boardId);
  } catch {
    return Promise.resolve(null);
  }
  return enqueueLod(board, rootId, edge);
}

/**
 * Render and cache LOD bitmaps for a batch of root artboards on one board, returning their updated
 * metadata (including exact measured natural dimensions).
 */
export async function warmLodBatch(boardId: string, roots: string[], maxEdge = 768): Promise<Record<string, LodMeta>> {
  const edge = normalizeLodEdge(maxEdge);
  const board = getBoard(boardId);
  const list = roots.slice(0, MAX_BATCH);
  await Promise.all(list.map((rootId) => enqueueLod(board, rootId, edge)));
  return lodStatus(board, list, edge);
}

async function runWorker() {
  if (activeWorkers >= MAX_WORKERS || !pending.length) return;
  activeWorkers++;
  try {
    while (pending.length) {
      const first = pending[0];
      const batch: PendingJob[] = [];
      for (let i = 0; i < pending.length && batch.length < MAX_BATCH; ) {
        if (pending[i].boardId === first.boardId && pending[i].maxEdge === first.maxEdge) {
          batch.push(pending.splice(i, 1)[0]);
        } else {
          i++;
        }
      }
      await renderBatch(batch);
    }
  } finally {
    activeWorkers--;
    if (pending.length) scheduleDrain();
  }
}

/** Collect local raster image paths inside a batch so we can swap in cached mipmaps before rendering. */
function collectLocalImages(board: Board, roots: string[], teamAssets: Map<string, string>): Set<string> {
  const files = new Set<string>();
  const add = (raw: string | undefined) => {
    if (!raw) return;
    const mapped = teamAssets.get(raw) ?? raw;
    if (/^(https?:|data:|blob:|file:)/i.test(mapped)) return;
    if (/\.(png|jpe?g|webp|heic)$/i.test(mapped) && existsSync(mapped)) files.add(mapped);
  };
  for (const rootId of roots) {
    for (const id of subtree(board, rootId)) {
      const n = board.nodes[id];
      if (!n || n.hidden) continue;
      add(n.src);
      add(n.poster);
      for (const v of Object.values(n.style)) {
        if (v.includes("url(")) {
          mapCssUrls(v, (u) => {
            add(u);
            return u;
          });
        }
      }
    }
  }
  return files;
}

async function renderBatch(batch: PendingJob[]) {
  const byHash = new Map<string, PendingJob[]>();
  for (const job of batch) {
    const hit = cachedLodFile(job.hash);
    if (hit) {
      job.resolve(hit);
      continue;
    }
    const list = byHash.get(job.hash);
    if (list) list.push(job);
    else byHash.set(job.hash, [job]);
  }
  if (!byHash.size) return;

  const unique = [...byHash.values()].map((list) => list[0]);
  const failAll = () => {
    for (const list of byHash.values()) for (const j of list) j.resolve(null);
  };

  const board = unique[0].board;
  const maxEdge = unique[0].maxEdge;
  const valid = unique.filter((j) => board.nodes[j.rootId] && !board.nodes[j.rootId].hidden);
  if (!valid.length) return failAll();

  const dir = await mkdtemp(path.join(tmpdir(), "glassine-lod-"));
  const file = path.join(dir, "batch.html");
  let page: Awaited<ReturnType<typeof newPage>> | null = null;
  try {
    const teamAssets = await ensureBoardTeamAssets(board).catch(() => new Map<string, string>());
    await maskFontsFor(board);

    const localImgs = collectLocalImages(board, valid.map((j) => j.rootId), teamAssets);
    const mipMap = new Map<string, string>();
    await Promise.all(
      [...localImgs].map(async (p) => {
        try {
          mipMap.set(p, await scaledImage(p, maxEdge));
        } catch {
          mipMap.set(p, p);
        }
      }),
    );

    const resolve = (s: string) => {
      const mapped = teamAssets.get(s) ?? s;
      if (/^(https?:|data:|blob:|file:)/i.test(mapped)) return mapped;
      const mip = mipMap.get(mapped) ?? mapped;
      return pathToFileURL(mip).href;
    };

    const roots = valid.map((j) => j.rootId);
    const links = fontLinks(fontFamilies(board, roots), board.fonts)
      .map((href) => `<link rel="stylesheet" href="${href}">`)
      .join("");
    const slots = valid
      .map((j) => `<div class="lod-slot" data-lod-hash="${j.hash}"><div class="lod-inner">${nodeHtml(board, j.rootId, { ids: true, src: resolve, still: true, code: true })}</div></div>`)
      .join("");
    const html = `<!doctype html><html><head><meta charset="utf-8">${shaderScript(board, roots, "still")}${effectsScript(board, roots)}${links}<style>${fontFaceCss(board, resolve)}${BOARD_CSS}html,body{margin:0;background:transparent}:root{${tokenCss(board)}}#bd-batch{position:relative}.lod-slot{position:relative;display:inline-block;vertical-align:top}.lod-inner>*{position:relative!important;left:auto!important;top:auto!important}</style></head><body><div id="bd-batch">${slots}</div></body></html>`;
    await writeFile(file, html);

    page = await newPage();
    await page.setViewport({ width: 1600, height: 1200, deviceScaleFactor: 1 });
    await page.goto(pathToFileURL(file).href, { waitUntil: "load", timeout: 45_000 });
    await page.evaluate(async () => {
      await Promise.race([document.fonts.ready, new Promise((r) => setTimeout(r, 4000))]);
      await Promise.all(Array.from(document.images).map((img) => (img.complete ? Promise.resolve() : img.decode().catch(() => undefined))));
    });
    await page.evaluate("(async () => { if (window.BoardShaders) await BoardShaders.ready(); if (window.BoardEffects) await BoardEffects.ready(); })()");

    // Pack scaled slots into a compact 2D grid (<= 3200px wide, well under Chromium's 16,384px
    // GPU texture height limit) so none of the 24 slots ever clip out of bounds.
    const layout = await page.evaluate((edge: number) => {
      const MAX_ROW_W = 3200;
      const GAP = 16;
      const out: Array<{ hash: string; width: number; height: number; sw: number; sh: number; x: number; y: number }> = [];
      let x = 0;
      let y = 0;
      let rowH = 0;
      let maxW = 100;
      for (const slot of Array.from(document.querySelectorAll<HTMLElement>(".lod-slot"))) {
        const inner = slot.firstElementChild as HTMLElement | null;
        const art = inner?.firstElementChild as HTMLElement | null;
        if (!inner || !art) continue;
        const r = art.getBoundingClientRect();
        const width = Math.round(r.width * 100) / 100;
        const height = Math.round(r.height * 100) / 100;
        if (width < 0.5 || height < 0.5) continue;
        const s = Math.min(1, edge / Math.max(width, height));
        const sw = Math.max(1, Math.round(width * s));
        const sh = Math.max(1, Math.round(height * s));
        if (x > 0 && x + sw > MAX_ROW_W) {
          x = 0;
          y += rowH + GAP;
          rowH = 0;
        }
        slot.style.cssText = `position:absolute;left:${x}px;top:${y}px;width:${sw}px;height:${sh}px;overflow:hidden`;
        inner.style.cssText = `transform-origin:0 0;transform:scale(${s});width:${width}px;height:${height}px`;
        out.push({ hash: slot.dataset.lodHash!, width, height, sw, sh, x, y });
        x += sw + GAP;
        maxW = Math.max(maxW, x);
        rowH = Math.max(rowH, sh);
      }
      const totalH = Math.max(100, y + rowH + GAP);
      document.body.style.minWidth = `${maxW}px`;
      document.body.style.minHeight = `${totalH}px`;
      return { items: out, maxW, totalH };
    }, maxEdge);

    // Resize viewport to encompass the compact 2D grid (always <= 3200x4800) so all clips capture cleanly.
    await page.setViewport({ width: Math.ceil(layout.maxW), height: Math.ceil(layout.totalH), deviceScaleFactor: 1 });
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));

    // Set transparent background ONCE via CDP (avoids 2x full-page repaints per clip) and use fast WebP encoding.
    const cdp = await page.createCDPSession();
    await cdp.send("Emulation.setDefaultBackgroundColorOverride", { color: { r: 0, g: 0, b: 0, a: 0 } });

    const done = new Set<string>();
    for (const item of layout.items) {
      try {
        const { data } = await cdp.send("Page.captureScreenshot", {
          format: "webp",
          quality: 85,
          clip: { x: item.x, y: item.y, width: item.sw, height: item.sh, scale: 1 },
          captureBeyondViewport: true,
          optimizeForSpeed: true,
        });
        const { webp, meta } = lodPaths(item.hash);
        const suffix = `${process.pid}.${Math.random().toString(36).slice(2, 6)}.tmp`;
        const tmpWebp = `${webp}.${suffix}`;
        const tmpMeta = `${meta}.${suffix}`;
        writeFileSync(tmpWebp, Buffer.from(data, "base64"));
        writeFileSync(tmpMeta, JSON.stringify({ width: item.width, height: item.height, sw: item.sw, sh: item.sh }));
        renameSync(tmpWebp, webp);
        renameSync(tmpMeta, meta);
        done.add(item.hash);
        for (const j of byHash.get(item.hash) ?? []) j.resolve(webp);
      } catch {
        for (const j of byHash.get(item.hash) ?? []) j.resolve(null);
        done.add(item.hash);
      }
    }
    await cdp.detach().catch(() => undefined);
    for (const [hash, list] of byHash) if (!done.has(hash)) for (const j of list) j.resolve(null);
  } catch {
    failAll();
  } finally {
    await page?.close().catch(() => undefined);
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}
