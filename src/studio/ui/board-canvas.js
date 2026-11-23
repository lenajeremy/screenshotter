// The board canvas: every artboard drawn as the real HTML and CSS it is, on an endless canvas you
// pan and zoom, with selection, moving, resizing and drawing new layers on top.
import { Component } from "preact";
import { Presence, PresenceBar, agentArtboards, colourOf } from "./board-presence.js";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { ancestors, cleanAttrs, fontFaceCss, fontFamilies, fontLinks, inFlow, instanceRootOf, isFlex, isGrid, mapCssUrls, newId, pxValue, rootOf, round, scaleOps, sizeWord, vectorFit, vectorTag, vectorTransform, videoSettings } from "./board-core.js";
import { loadMaskFonts, maskActive, maskCss, maskOf, maskRuns, onMaskFonts, styleText } from "./board-core.js";
import { mapSvgImages, shaderBoxStyle, svgImageAttrs } from "./board-core.js";
import { CANVAS_ONLY } from "./board-state.js";
import { B, bset, commit, currentPage, node, notify, onBoard, preview, select, sendLivePresence, useBoard, useMeasure } from "./board-state.js";
import { html } from "./controls.js";
import { Icon } from "./icons.js";
import { api, fileUrl, toast } from "./store.js";
import { openLayerMenu, startTextEdit } from "./board.js";
import { CommentLayer, closeThread, layersIn, startDraft } from "./board-comments.js";
import { GridOverlay, gridAddPlace, gridDrop, gridDropOps, inGrid, intoGridStyle, leaveGridOps, patchStyle, resizeInGrid } from "./board-grid.js";
import { ShaderCanvas } from "./board-shaders.js";
import { detachElementEffects, syncElementEffects } from "./board-effects.js";

export const canvasEl = { current: null };

export const srcUrl = (src) => (!src ? "" : /^(https?:|data:|blob:|\/api\/assets\/)/i.test(src) ? src : fileUrl(src));

// ---------------------------------------------------------------------------------------------
// Resolution-scaled image mipmaps: keep GPU decode memory tiny on image-heavy boards (like Figma
// files with hundreds of 4K PNGs), and upgrade visible images seamlessly once zooming settles.

const MIP_BUCKETS = [256, 512, 1024, 2048];
const mipRank = (w) => (w === 0 ? Infinity : w);
const neededMip = (px) => MIP_BUCKETS.find((b) => b >= px) ?? 0;
function withMip(url, w) {
  if (!w || !url) return url;
  if (!/^(\/file\?path=|\/api\/assets\/)/.test(url)) return url;
  if (/\.(svg|gif)(?:[?&]|$)/i.test(url)) return url;
  return `${url}${url.includes("?") ? "&" : "?"}w=${w}`;
}
/**
 * Whether a smaller copy can stand in for a layer's picture without changing how it's laid out: a
 * picture with no size of its own takes the file's (a 512 px copy would shrink it), and so does a
 * background sized `auto`.
 */
function mipSafe(n, kind) {
  const st = n.style ?? {};
  if (kind === "img") return pxValue(st.width) !== undefined && pxValue(st.height) !== undefined && !/^(none|scale-down)$/.test(st.objectFit ?? "");
  const size = (st.backgroundSize ?? "").trim();
  if (!size) return false;
  return size.split(/,(?![^(]*\))/).every((part) => !/^(auto(\s+auto)?)$/.test(part.trim()));
}
/**
 * The longest edge a layer's picture is drawn at, in screen pixels, in a box of `sw` by `sh`: more
 * than the box when it's cropped (object-fit: cover, a 250% background). `aspect` is the file's
 * width over height, once it's known; until then a cropped one is taken to be twice the box.
 */
function drawnEdge(entry, sw, sh) {
  const a = entry.aspect;
  const cover = () => {
    if (!a) return Math.max(sw, sh) * 2;
    const w = Math.max(sw, sh * a);
    return Math.max(w, w / a);
  };
  if (entry.kind === "img") return (entry.fit ?? "fill") === "cover" ? cover() : Math.max(sw, sh);
  let edge = 0;
  for (const part of (entry.size ?? "").split(/,(?![^(]*\))/)) {
    const t = part.trim();
    if (t === "cover") edge = Math.max(edge, cover());
    else if (t === "contain") edge = Math.max(edge, sw, sh);
    else {
      const [x, y] = t.split(/\s+/);
      const len = (v, box) => (!v || v === "auto" ? undefined : v.endsWith("%") ? (parseFloat(v) / 100) * box : parseFloat(v) * (B.view.z || 1));
      let w = len(x, sw), h = len(y, sh);
      if (w === undefined && h === undefined) return Infinity;
      if (w === undefined) w = a ? h * a : h * 2;
      if (h === undefined) h = a ? w / a : w * 2;
      edge = Math.max(edge, w, h);
    }
  }
  return edge || Math.max(sw, sh);
}
function initialMipFor(n) {
  const w = pxValue(n.style?.width) ?? 0;
  const h = pxValue(n.style?.height) ?? 0;
  const maxDim = Math.max(w, h);
  const dpr = typeof devicePixelRatio === "number" ? devicePixelRatio : 2;
  if (maxDim > 0 && maxDim * dpr <= 256) return 256;
  return 512;
}
/** Mounted raster image / background-image layers eligible for progressive mip upgrades. */
const mipNodes = new Map();
let mipUpgradesInFlight = 0;
const mipUpgradeQueue = [];
const pendingMipCommits = [];
let gestureUntil = 0;
let aspectSoon = 0;

function flushMipCommits() {
  if (performance.now() < gestureUntil || !pendingMipCommits.length) return;
  while (pendingMipCommits.length) {
    const job = pendingMipCommits.shift();
    const cur = mipNodes.get(job.id);
    if (cur && cur.el === job.el && cur.el.isConnected && mipRank(job.target) > mipRank(cur.mip)) {
      cur.mip = job.target;
      cur.upgrading = null;
      if (cur.kind === "img") cur.el.src = job.nextUrl;
      else cur.el.style.backgroundImage = mapCssUrls(cur.orig, (u) => withMip(srcUrl(u), job.target));
    }
  }
}

function pumpMipQueue() {
  if (performance.now() < gestureUntil) return;
  flushMipCommits();
  while (mipUpgradesInFlight < 4 && mipUpgradeQueue.length) {
    const job = mipUpgradeQueue.shift();
    if (!job) break;
    const entry = mipNodes.get(job.id);
    if (!entry || entry.el !== job.el || !entry.el.isConnected || mipRank(job.target) <= mipRank(entry.mip)) continue;
    mipUpgradesInFlight++;
    const nextUrl = job.kind === "img" ? withMip(srcUrl(job.orig), job.target) : null;
    const urls = [];
    if (nextUrl) urls.push(nextUrl);
    else mapCssUrls(job.orig, (u) => {
      const m = withMip(srcUrl(u), job.target);
      urls.push(m);
      return m;
    });
    Promise.all(
      urls.map(
        (u) =>
          new Promise((done) => {
            const im = new Image();
            im.decoding = "async";
            im.onload = () => (im.decode ? im.decode().then(done, done) : done());
            im.onerror = done;
            im.src = u;
          }),
      ),
    ).finally(() => {
      mipUpgradesInFlight--;
      // Never mutate DOM inside .bd-world mid-gesture: queue the swap until panning/pinching settles.
      pendingMipCommits.push({ id: job.id, el: job.el, target: job.target, nextUrl });
      if (performance.now() >= gestureUntil) flushMipCommits();
      pumpMipQueue();
    });
  }
}

function upgradeVisibleImages() {
  if (performance.now() < gestureUntil || !canvasEl.current) return;
  flushMipCommits();
  if (!mipNodes.size) return;
  const cr = getCanvasRect();
  if (!cr.width || !cr.height) return;
  const v = B.view;
  const dpr = typeof devicePixelRatio === "number" ? devicePixelRatio : 2;
  for (const [id, entry] of mipNodes) {
    if (entry.mip === 0 || !entry.el.isConnected) continue;
    const wb = worldRects.get(id);
    let sx, sy, sw, sh;
    if (wb) {
      sx = wb.x * v.z + v.x;
      sy = wb.y * v.z + v.y;
      sw = wb.width * v.z;
      sh = wb.height * v.z;
    } else {
      const r = entry.el.getBoundingClientRect();
      sx = r.left - cr.left;
      sy = r.top - cr.top;
      sw = r.width;
      sh = r.height;
    }
    if (sw <= 0 || sh <= 0) continue;
    if (sx + sw < -100 || sx > cr.width + 100 || sy + sh < -100 || sy > cr.height + 100) continue;
    if (!entry.aspect) {
      if (entry.kind === "img" && entry.el.naturalWidth && entry.el.naturalHeight) entry.aspect = entry.el.naturalWidth / entry.el.naturalHeight;
      else if (entry.kind === "bg" && !entry.probing && /cover|auto/.test(entry.size ?? "")) {
        // A background's shape isn't readable from its element: the copy already loaded says.
        entry.probing = true;
        let first = "";
        mapCssUrls(entry.orig, (u) => ((first ||= withMip(srcUrl(u), entry.mip)), u));
        const im = new Image();
        im.onload = () => {
          if (im.naturalWidth && im.naturalHeight) entry.aspect = im.naturalWidth / im.naturalHeight;
          clearTimeout(aspectSoon);
          aspectSoon = setTimeout(upgradeVisibleImages, 60);
        };
        im.src = first;
      }
    }
    const target = neededMip(drawnEdge(entry, sw, sh) * dpr);
    if (mipRank(target) <= mipRank(entry.mip)) continue;
    if (entry.upgrading === target) continue;
    entry.upgrading = target;
    mipUpgradeQueue.push({ id, el: entry.el, kind: entry.kind, orig: entry.orig, target });
  }
  pumpMipQueue();
}

// ---------------------------------------------------------------------------------------------
// Where things are (O(1) element index, cached canvas rect, cached world bounds)

const nodeEls = new Map();
function bindEl(id, el) {
  if (el) nodeEls.set(id, el);
  else nodeEls.delete(id);
}

/** The element drawing a layer (O(1) map lookup, querySelector fallback). */
export const elOf = (id) => {
  const hit = nodeEls.get(id);
  if (hit?.isConnected) return hit;
  return canvasEl.current?.querySelector(`[data-bid="${id}"]`) ?? null;
};

let canvasRect = null;
function refreshCanvasRect() {
  canvasRect = canvasEl.current?.isConnected ? canvasEl.current.getBoundingClientRect() : null;
  return canvasRect;
}
function getCanvasRect() {
  return canvasRect ?? refreshCanvasRect() ?? { left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0 };
}

/** World-space boxes cached after layout so pan/zoom overlays do zero DOM reads. */
const worldRects = new Map();
let rootsDirty = true;

function invalidateWorldCache(onlyIds) {
  if (onlyIds) {
    for (const id of onlyIds) worldRects.delete(id);
    return;
  }
  worldRects.clear();
  rootsDirty = true;
}

function measureRoots() {
  rootsDirty = false;
  const board = B.board;
  const page = currentPage();
  if (!board || !page || !canvasEl.current) return;
  const cr = refreshCanvasRect();
  const v = shown ?? B.view;
  if (!cr || !cr.width || !v.z) return;
  for (const id of page.children) {
    const n = board.nodes[id];
    if (!n || n.hidden) continue;
    const el = elOf(id);
    if (!el || el.dataset.virtual === "1" || el.dataset.lod === "1") {
      const b = rootBoxOf(board, id);
      if (b) worldRects.set(id, { x: b.x, y: b.y, width: b.width, height: b.height });
      continue;
    }
    const r = el.getBoundingClientRect();
    const box = {
      x: (r.left - cr.left - v.x) / v.z,
      y: (r.top - cr.top - v.y) / v.z,
      width: r.width / v.z,
      height: r.height / v.z,
    };
    worldRects.set(id, box);
    if (box.width > 0 && box.height > 0) knownRootBoxes.set(id, { ...box, nodeRef: n });
  }
}

// ---------------------------------------------------------------------------------------------
// Off-screen artboard virtualization + zoomed-out Bitmap LOD (Level of Detail)
//
// Multi-artboard pages with thousands to tens of thousands of layers only keep artboards near the
// viewport live in the DOM:
//   - "virtual": far off-screen artboards collapse to a single placeholder <div> (1 DOM node).
//   - "lod":     on-screen artboards zoomed tiny (<= 320 CSS px on 2x Retina) swap to a cached
//                server-rendered WebP snapshot (1 DOM node + <img>), hydrating seamlessly back to
//                live HTML/CSS DOM as soon as you zoom in, select, click, or an agent edits them.
// Transitions are deferred until gestures settle (with generous viewport & zoom hysteresis) so
// panning and pinching never pay DOM mount/unmount costs mid-frame.

const LOD_MAX_EDGE = 768;
const LOD_ENTER_PX = 640;
const LOD_LEAVE_PX = 768;
const LOD_MIN_DESCENDANTS = 12;
const COLD_LIVE_NODE_BUDGET = 4500;
const VIRT_ENTER_PAD = 0.85;
const VIRT_LEAVE_PAD = 1.45;

/** Measured world boxes of root artboards, kept across virtual/LOD transitions. */
const knownRootBoxes = new Map();
/** Server LOD metadata + client decode status per root artboard. */
const lodEntries = new Map();
/** Current display mode per root artboard: "live" | "lod" | "virtual". */
const rootModes = new Map();
/** Roots explicitly pinned live (e.g. double-clicked while in LOD, or targeted by fit()). */
const forceLiveRoots = new Set();
const lodWarmQueue = [];
let lodWarmInFlight = 0;
let lodMetaGen = 0;
let lodMetaSoon = 0;
let virtSoon = 0;
let lastReconcileView = null;
let lastCatchupAt = 0;
let virtListener = null;
let virtPageKey = "";

/** Read-only virtualization & LOD telemetry for diagnostics and tests. */
export const virtStats = { active: false, totalRoots: 0, live: 0, lod: 0, virtual: 0, totalNodes: 0, liveNodes: 0 };
if (typeof window !== "undefined") window.__glassineVirt = virtStats;

let pageVirtCache = null;
function countSubtree(nodes, id) {
  let n = 0;
  const stack = [id];
  while (stack.length) {
    const cur = nodes[stack.pop()];
    if (!cur || cur.hidden) continue;
    n++;
    if (cur.children) for (let i = 0; i < cur.children.length; i++) stack.push(cur.children[i]);
  }
  return n;
}
function getPageVirtInfo(board, page) {
  if (pageVirtCache && pageVirtCache.board === board && pageVirtCache.page === page) return pageVirtCache;
  const descCount = new Map();
  let totalNodes = 0;
  if (board && page) {
    for (const id of page.children) {
      const c = countSubtree(board.nodes, id);
      descCount.set(id, c);
      totalNodes += c;
    }
  }
  const rootCount = page?.children.length ?? 0;
  const active = rootCount >= 12 || (rootCount >= 4 && totalNodes >= 1200);
  pageVirtCache = { board, page, active, totalNodes, descCount };
  return pageVirtCache;
}

/** Exact (or best-known) world box for a root artboard without forcing DOM layout. */
function rootBoxOf(board, id) {
  const n = board?.nodes?.[id];
  if (!n || n.hidden) return null;
  const lx = pxValue(n.style?.left);
  const ty = pxValue(n.style?.top);
  const live = worldRects.get(id);
  const el = nodeEls.get(id);
  if (live && el?.isConnected && el.dataset.virtual !== "1" && el.dataset.lod !== "1") {
    return { x: lx ?? live.x, y: ty ?? live.y, width: live.width, height: live.height, exact: true };
  }
  const known = knownRootBoxes.get(id);
  if (known && known.width > 0 && known.height > 0) {
    return { x: lx ?? known.x, y: ty ?? known.y, width: known.width, height: known.height, exact: true };
  }
  const lod = lodEntries.get(id);
  if (lod && lod.width > 0 && lod.height > 0) {
    return { x: lx ?? 0, y: ty ?? 0, width: lod.width, height: lod.height, exact: true };
  }
  const sw = pxValue(n.style?.width);
  const sh = pxValue(n.style?.height);
  if (sw && sw > 0 && sh && sh > 0) {
    return { x: lx ?? 0, y: ty ?? 0, width: sw, height: sh, exact: true };
  }
  const w = sw && sw > 0 ? sw : 400;
  const h = sh && sh > 0 ? sh : Math.round(w * 1.5);
  return { x: lx ?? 0, y: ty ?? 0, width: w, height: h, exact: false };
}

function resetVirtualization() {
  clearTimeout(lodMetaSoon);
  clearTimeout(virtSoon);
  lodMetaGen++;
  knownRootBoxes.clear();
  lodEntries.clear();
  rootModes.clear();
  forceLiveRoots.clear();
  lodWarmQueue.length = 0;
  lastReconcileView = null;
  pageVirtCache = null;
  virtPageKey = "";
}

function isFreshLod(board, id, entry) {
  if (!entry || entry.failed) return false;
  const n = board.nodes[id];
  return Boolean(n && entry.nodeRef === n && entry.tokensRef === board.tokens && entry.fontsRef === board.fonts && entry.shadersRef === board.shaders);
}

function applyLodMetaItems(snapBoard, items) {
  let updated = false;
  for (const [id, item] of Object.entries(items ?? {})) {
    const n = snapBoard.nodes[id];
    if (!n) continue;
    const prev = lodEntries.get(id);
    const sameHash = prev && prev.hash === item.hash;
    const next = {
      hash: item.hash,
      url: item.url,
      width: item.width ?? (sameHash ? prev.width : 0),
      height: item.height ?? (sameHash ? prev.height : 0),
      ready: Boolean(item.ready || (sameHash && prev.ready)),
      warming: Boolean(sameHash && prev.warming && !item.ready),
      failed: false,
      nodeRef: n,
      tokensRef: snapBoard.tokens,
      fontsRef: snapBoard.fonts,
      shadersRef: snapBoard.shaders,
    };
    lodEntries.set(id, next);
    if (next.width > 0 && next.height > 0 && !knownRootBoxes.has(id)) {
      knownRootBoxes.set(id, { x: pxValue(n.style?.left) ?? 0, y: pxValue(n.style?.top) ?? 0, width: next.width, height: next.height, nodeRef: n });
      updated = true;
    }
    if (!sameHash || next.ready !== Boolean(prev?.ready)) updated = true;
  }
  return updated;
}

function syncLodMeta(board, page) {
  if (!board || !page) return;
  const info = getPageVirtInfo(board, page);
  if (!info.active) return;
  const roots = page.children.filter((id) => {
    const n = board.nodes[id];
    return n && !n.hidden && n.type === "frame" && (info.descCount.get(id) ?? 0) >= LOD_MIN_DESCENDANTS;
  });
  if (!roots.length) return;
  const gen = ++lodMetaGen;
  const snapBoard = board;
  api("/api/board/lod/meta", { id: board.id, roots, w: LOD_MAX_EDGE })
    .then((res) => {
      if (gen !== lodMetaGen || B.board !== snapBoard) return;
      if (applyLodMetaItems(snapBoard, res.items)) {
        if (performance.now() >= gestureUntil && !B.dragging) reconcileArtboardModes();
        else {
          clearTimeout(virtSoon);
          virtSoon = setTimeout(() => reconcileArtboardModes(), 190);
        }
      }
    })
    .catch(() => {
      if (gen !== lodMetaGen || B.board !== snapBoard) return;
      for (const id of roots) {
        const n = snapBoard.nodes[id];
        if (!n) continue;
        lodEntries.set(id, { hash: "", url: "", width: 0, height: 0, ready: false, warming: false, failed: true, nodeRef: n, tokensRef: snapBoard.tokens, fontsRef: snapBoard.fonts, shadersRef: snapBoard.shaders });
      }
      reconcileArtboardModes(true);
    });
}

function queueLodWarm(id, entry) {
  if (!entry || entry.ready || entry.warming || entry.failed) return;
  entry.warming = true;
  lodWarmQueue.push(id);
}

function pumpLodWarm() {
  if (performance.now() < gestureUntil || B.dragging || !B.board) return;
  while (lodWarmInFlight < 2 && lodWarmQueue.length) {
    const snapBoard = B.board;
    const gen = lodMetaGen;
    const batch = [];
    while (batch.length < 24 && lodWarmQueue.length) {
      const id = lodWarmQueue.shift();
      const entry = lodEntries.get(id);
      if (entry && !entry.ready && !entry.failed && isFreshLod(snapBoard, id, entry)) batch.push(id);
    }
    if (!batch.length) continue;
    lodWarmInFlight++;
    api("/api/board/lod/warm", { id: snapBoard.id, roots: batch, w: LOD_MAX_EDGE })
      .then((res) => {
        if (gen !== lodMetaGen || B.board !== snapBoard) return;
        const items = res.items ?? {};
        for (const id of batch) {
          const e = lodEntries.get(id);
          if (e) e.warming = false;
          if (e && !items[id]?.ready) e.failed = true;
        }
        applyLodMetaItems(snapBoard, items);
        if (performance.now() >= gestureUntil && !B.dragging) reconcileArtboardModes();
        else {
          clearTimeout(virtSoon);
          virtSoon = setTimeout(() => reconcileArtboardModes(), 190);
        }
      })
      .catch(() => {
        for (const id of batch) {
          const e = lodEntries.get(id);
          if (e) (e.warming = false), (e.failed = true);
        }
      })
      .finally(() => {
        lodWarmInFlight--;
        pumpLodWarm();
      });
  }
}

function pinnedRootsFor(board) {
  const pinned = new Set(forceLiveRoots);
  if (!board) return pinned;
  for (const id of B.sel) if (board.nodes[id]) pinned.add(rootOf(board, id));
  if (B.editing && board.nodes[B.editing]) pinned.add(rootOf(board, B.editing));
  if (B.drop?.into && board.nodes[B.drop.into]) pinned.add(rootOf(board, B.drop.into));
  const anchor = B.draft ?? (B.thread && (B.comments?.threads ?? []).find((t) => t.id === B.thread));
  if (anchor?.artboard && board.nodes[anchor.artboard]) pinned.add(rootOf(board, anchor.artboard));
  if (anchor?.layer && board.nodes[anchor.layer]) pinned.add(rootOf(board, anchor.layer));
  for (const id of agentArtboards().keys()) pinned.add(id);
  return pinned;
}

/**
 * Recompute each root artboard's display mode ("live" | "lod" | "virtual"). Returns true when any
 * root's mode or displayed LOD bitmap state changed (meaning BoardCanvas should re-render).
 */
function computeRootModes(board, page, view) {
  const info = getPageVirtInfo(board, page);
  if (!info.active || !board || !page) {
    const had = rootModes.size > 0;
    rootModes.clear();
    Object.assign(virtStats, { active: false, totalRoots: page?.children.length ?? 0, live: page?.children.length ?? 0, lod: 0, virtual: 0, totalNodes: info.totalNodes, liveNodes: info.totalNodes });
    return had;
  }
  const cr = getCanvasRect();
  const W = cr.width || 1440;
  const H = cr.height || 900;
  const dpr = typeof devicePixelRatio === "number" ? devicePixelRatio : 2;
  const pinned = pinnedRootsFor(board);
  const enterL = -W * VIRT_ENTER_PAD, enterR = W * (1 + VIRT_ENTER_PAD);
  const enterT = -H * VIRT_ENTER_PAD, enterB = H * (1 + VIRT_ENTER_PAD);
  const leaveL = -W * VIRT_LEAVE_PAD, leaveR = W * (1 + VIRT_LEAVE_PAD);
  const leaveT = -H * VIRT_LEAVE_PAD, leaveB = H * (1 + VIRT_LEAVE_PAD);

  let changed = false;
  let liveCount = 0, lodCount = 0, virtCount = 0, liveNodes = 0;
  const activeIds = new Set();
  // On massive boards (> 1.5x live node budget), zoomed-out LOD artboards go straight to LOD
  // silhouettes while their server batches render — never mounting thousands of cold DOM nodes.
  const massive = info.totalNodes > COLD_LIVE_NODE_BUDGET * 1.5;

  for (const id of page.children) {
    const n = board.nodes[id];
    if (!n || n.hidden) continue;
    activeIds.add(id);
    const prev = rootModes.get(id);
    const desc = info.descCount.get(id) ?? 1;
    let next = prev ?? "live";

    if (pinned.has(id) || n.type !== "frame") {
      next = "live";
    } else if (B.dragging && prev) {
      // Never churn DOM mounts/unmounts mid-drag.
      next = prev;
    } else {
      const box = rootBoxOf(board, id);
      const sx = box.x * view.z + view.x;
      const sy = box.y * view.z + view.y;
      const sw = box.width * view.z;
      const sh = box.height * view.z;
      const wasMounted = prev === "live" || prev === "lod";
      const padL = wasMounted ? leaveL : enterL;
      const padR = wasMounted ? leaveR : enterR;
      const padT = wasMounted ? leaveT : enterT;
      const padB = wasMounted ? leaveB : enterB;
      const onScreen = sx + sw >= padL && sx <= padR && sy + sh >= padT && sy <= padB;

      if (!onScreen && (box.exact || massive || liveNodes + desc > COLD_LIVE_NODE_BUDGET)) {
        next = "virtual";
      } else {
        const maxScreenPx = Math.max(sw, sh) * dpr;
        const lodLimit = prev === "lod" ? LOD_LEAVE_PX : LOD_ENTER_PX;
        const entry = lodEntries.get(id);
        const fresh = isFreshLod(board, id, entry);
        if (desc >= LOD_MIN_DESCENDANTS && maxScreenPx <= lodLimit && fresh) {
          if (entry.ready) {
            next = "lod";
          } else {
            queueLodWarm(id, entry);
            // Small/medium boards stay live while warming so there's zero blank flash; massive
            // boards (or artboards already in LOD) stay in lightweight LOD silhouettes.
            next = !massive && prev !== "lod" && liveNodes + desc <= COLD_LIVE_NODE_BUDGET ? "live" : "lod";
          }
        } else if (desc >= LOD_MIN_DESCENDANTS && maxScreenPx <= lodLimit && !entry && (massive || liveNodes + desc > COLD_LIVE_NODE_BUDGET)) {
          next = "lod";
        } else {
          next = "live";
        }
      }
    }

    if (next === "live") {
      liveCount++;
      liveNodes += desc;
    } else if (next === "lod") {
      lodCount++;
    } else {
      virtCount++;
    }

    const lodReadyKey = next === "lod" ? (lodEntries.get(id)?.ready ? lodEntries.get(id).url : "") : "";
    const prevKey = rootModes.get(`lod:${id}`);
    if (prev !== next || prevKey !== lodReadyKey) {
      rootModes.set(id, next);
      rootModes.set(`lod:${id}`, lodReadyKey);
      changed = true;
    }
  }

  for (const k of [...rootModes.keys()]) {
    if (k.startsWith("lod:")) {
      if (!activeIds.has(k.slice(4))) {
        rootModes.delete(k);
        changed = true;
      }
    } else if (!activeIds.has(k)) {
      rootModes.delete(k);
      changed = true;
    }
  }

  lastReconcileView = { x: view.x, y: view.y, z: view.z };
  Object.assign(virtStats, { active: true, totalRoots: activeIds.size, live: liveCount, lod: lodCount, virtual: virtCount, totalNodes: info.totalNodes, liveNodes });
  if (lodWarmQueue.length && !lodWarmInFlight) {
    if (performance.now() >= gestureUntil && !B.dragging) pumpLodWarm();
    else {
      clearTimeout(virtSoon);
      virtSoon = setTimeout(() => reconcileArtboardModes(), 190);
    }
  }
  return changed;
}

function reconcileArtboardModes(force = false) {
  if (!force && (B.dragging || performance.now() < gestureUntil)) return;
  const page = currentPage();
  if (!B.board || !page) return;
  const changed = computeRootModes(B.board, page, B.view);
  pumpLodWarm();
  if (changed) virtListener?.();
}

/** Force the root artboards of `ids` into live DOM (e.g. double-click on LOD or zoom-to-selection). */
function ensureLiveRoots(ids) {
  if (!B.board || !ids?.length) return false;
  let added = false;
  for (const id of ids) {
    if (!B.board.nodes[id]) continue;
    const r = rootOf(B.board, id);
    if (!forceLiveRoots.has(r)) {
      forceLiveRoots.add(r);
      added = true;
    }
  }
  if (added) reconcileArtboardModes(true);
  return added;
}

/** A screen point (client px) on the canvas, in board units. */
export function toWorld(clientX, clientY) {
  const r = getCanvasRect();
  const { x, y, z } = B.view;
  return { x: (clientX - r.left - x) / z, y: (clientY - r.top - y) / z };
}

/** A drag moves more than what's dragged (what's inside it, what flows after it): once it ends, every box is measured again. */
let wasDragging = false;
function afterDrag() {
  if (wasDragging && !B.dragging) invalidateWorldCache();
  wasDragging = Boolean(B.dragging);
}

/** A layer's box in board units (as drawn), or null if it isn't drawn. */
export function worldBox(id) {
  afterDrag();
  const n = node(id);
  const el = elOf(id);
  if (n && !n.parent && (!el || el.dataset.virtual === "1" || el.dataset.lod === "1")) {
    const rb = rootBoxOf(B.board, id);
    return rb ? { x: rb.x, y: rb.y, width: rb.width, height: rb.height } : null;
  }
  if (!B.dragging && B.editing !== id) {
    const cached = worldRects.get(id);
    if (cached) return cached;
  }
  if (!el) return null;
  const r = el.getBoundingClientRect();
  const c = getCanvasRect();
  const { x, y, z } = B.view;
  const box = { x: (r.left - c.left - x) / z, y: (r.top - c.top - y) / z, width: r.width / z, height: r.height / z };
  if (!B.dragging && B.editing !== id) worldRects.set(id, box);
  return box;
}

useMeasure((id) => worldBox(id));

/** A layer's box on screen, relative to the canvas. */
export function screenBox(id) {
  afterDrag();
  const n = node(id);
  const el = elOf(id);
  if (n && !n.parent && (!el || el.dataset.virtual === "1" || el.dataset.lod === "1")) {
    const rb = rootBoxOf(B.board, id);
    if (!rb) return null;
    const { x, y, z } = B.view;
    return { x: rb.x * z + x, y: rb.y * z + y, width: rb.width * z, height: rb.height * z };
  }
  if (!B.dragging && B.editing !== id) {
    const wb = worldRects.get(id);
    if (wb) {
      const { x, y, z } = B.view;
      return { x: wb.x * z + x, y: wb.y * z + y, width: wb.width * z, height: wb.height * z };
    }
  }
  if (!el) return null;
  const r = el.getBoundingClientRect();
  const c = getCanvasRect();
  const box = { x: r.left - c.left, y: r.top - c.top, width: r.width, height: r.height };
  if (!B.dragging && B.editing !== id) {
    const { x, y, z } = B.view;
    worldRects.set(id, { x: (box.x - x) / z, y: (box.y - y) / z, width: box.width / z, height: box.height / z });
  }
  return box;
}

/**
 * Glide the view to another place and zoom, as a Mac app does for its zoom commands (a quick
 * ease-out). Scrolling and pinching move it directly.
 */
let glide = 0;
/** The zoom a glide is zooming out to, while it does (see the camera). */
let gliding = null;
function setView(to, animate, ms = 220) {
  cancelAnimationFrame(glide);
  gliding = null;
  if (!animate) return bset({ view: to });
  const from = { ...B.view };
  const t0 = performance.now();
  // Zooming out: drawn at the zoom it ends at from the start, so the glide only scales a picture
  // that's sharp when it lands (zooming in, it's drawn sharp again as it goes; see the camera).
  if (to.z < from.z) {
    drawAtZoom(to);
    gliding = to.z;
    applyView();
  }
  const step = (now) => {
    const t = Math.min(1, (now - t0) / ms);
    // A quick ease-out for the zoom commands; a longer glide (following an agent) eases in and out.
    const k = ms > 300 ? (t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2) : 1 - (1 - t) ** 3;
    const z = from.z * (to.z / from.z) ** k;
    // The point under the middle of the canvas travels in a straight line while the zoom changes evenly.
    const c = getCanvasRect();
    const mid = (v) => ({ x: (c.width / 2 - v.x) / v.z, y: (c.height / 2 - v.y) / v.z });
    const a = mid(from);
    const b = mid(to);
    const m = { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k };
    bset({ view: t < 1 ? { z, x: c.width / 2 - m.x * z, y: c.height / 2 - m.y * z } : { x: to.x, y: to.y, z: to.z } });
    if (t < 1) glide = requestAnimationFrame(step);
    else (glide = 0), (gliding = null);
  };
  glide = requestAnimationFrame(step);
}

// ---------------------------------------------------------------------------------------------
// The camera: how the view reaches the screen
//
// The world (every artboard, as HTML) is drawn centered around the viewport center at a zoom of
// its own (`translate(cx, cy) scale(z) translate(-wx, -wy)`), keeping transformed coordinates near
// (0, 0) so even 256,000% zoom on a 100,000px artboard never hits fixed-point overflow.
// During a pan or pinch, .bd-camera carries the delta transform cheaply; when zooming stops,
// sharpen() commits the exact zoom to .bd-world and resets .bd-camera to `transform: none` so text
// and vectors render natively at full resolution without compositing-scale capping.

/** Zoom range: 0.2% (fits 200,000px Figma arenas) up to 256,000% (razor-sharp vectors & text). */
const MIN_ZOOM = 0.002;
const MAX_ZOOM = 2560;

/** The camera, world and pixel grid elements. */
const cam = { el: null, world: null, grid: null };
/** The view .bd-world is currently drawn at. */
let drawn = null;
/** The view last put on screen. */
let shown = null;
let sharpenSoon = 0;
/** How far .bd-camera scales the drawn world mid-pinch before re-rasterizing .bd-world. */
const SOFTEST = 2.0;
const SMALLEST = 0.45;
const px = (v) => Math.round(v * (typeof devicePixelRatio === "number" ? devicePixelRatio : 1)) / (typeof devicePixelRatio === "number" ? devicePixelRatio : 1);

function updatePixelGrid(v) {
  const g = cam.grid;
  if (!g) return;
  if (v.z < 8) {
    if (g.style.display !== "none") g.style.display = "none";
    return;
  }
  g.style.display = "block";
  g.style.backgroundSize = `${v.z}px ${v.z}px`;
  g.style.backgroundPosition = `${((v.x % v.z) + v.z) % v.z}px ${((v.y % v.z) + v.z) % v.z}px`;
  g.style.opacity = String(Math.min(1, (v.z - 8) / 8));
}

/** Draw the world at view `v`'s exact zoom, .bd-camera carrying only the delta. */
function drawAtZoom(v) {
  if (!cam.world) return;
  // At extreme zooms (> 64x) or huge pan offsets, center the transform around the viewport so
  // coordinates stay near (0, 0) and never overflow Blink's 32-bit fixed-point LayoutUnit limit.
  const huge = v.z > 64 || Math.abs(v.x) > 500_000 || Math.abs(v.y) > 500_000;
  if (huge) {
    const cr = getCanvasRect();
    const cx = Math.round(cr.width / 2);
    const cy = Math.round(cr.height / 2);
    const wx = (cx - v.x) / v.z;
    const wy = (cy - v.y) / v.z;
    drawn = { x: v.x, y: v.y, z: v.z, huge: true };
    cam.world.style.transform = `translate(${cx}px, ${cy}px) scale(${v.z}) translate(${-wx}px, ${-wy}px)`;
  } else {
    // Sub-pixel remainder stays on .bd-world so .bd-camera translates by whole screen pixels.
    drawn = { x: v.x - px(v.x), y: v.y - px(v.y), z: v.z, huge: false };
    cam.world.style.transform = `translate(${drawn.x}px, ${drawn.y}px) scale(${drawn.z})`;
  }
  // Never set will-change: transform on .bd-camera: in Chromium's GPU compositor (cc),
  // has_will_change_transform_hint locks PictureLayer raster scale to its initial ~1x scale and
  // makes zoomed text & vectors blurry until repainted. translate3d() on .bd-camera already keeps
  // the layer GPU-promoted for 120 fps pan/pinch while letting Blink re-rasterize crisp at any zoom.
  shown = null;
}

/** Put the view on screen: the camera moved and scaled over the world as drawn. */
export function applyView() {
  if (!cam.el?.isConnected || !cam.world) return false;
  const v = B.view;
  if (shown && shown.x === v.x && shown.y === v.y && shown.z === v.z && drawn) return false;
  let s = drawn ? v.z / drawn.z : 0;
  const tx0 = drawn ? v.x - s * drawn.x : 0;
  const ty0 = drawn ? v.y - s * drawn.y : 0;
  const needHuge = v.z > 64 || Math.abs(v.x) > 500_000 || Math.abs(v.y) > 500_000;
  // A glide zooming out to where it's drawn already only grows sharper on the way.
  if (!drawn || (s > SOFTEST && drawn.z !== gliding) || s < SMALLEST || drawn.huge !== needHuge || (drawn.huge && (Math.abs(tx0) > 16000 || Math.abs(ty0) > 16000))) {
    drawAtZoom(v);
    s = 1;
  }
  shown = { x: v.x, y: v.y, z: v.z };
  const tx = v.x - s * drawn.x;
  const ty = v.y - s * drawn.y;
  gestureUntil = performance.now() + 180;
  // Keep .bd-camera permanently promoted (never toggle transform:none) so frame 1 of pan/pinch
  // never stalls to allocate a new GPU backing layer.
  cam.el.style.transform = `translate3d(${tx}px, ${ty}px, 0) scale(${s})`;
  updatePixelGrid(v);
  clearTimeout(sharpenSoon);
  clearTimeout(virtSoon);
  // Only re-rasterize .bd-world when the zoom actually changed (s !== 1), never after a pure pan.
  if (s !== 1) sharpenSoon = setTimeout(sharpen, 130);
  else sharpenSoon = setTimeout(upgradeVisibleImages, 220);
  if (virtStats.active) {
    // Reconcile virtual/LOD artboards after the gesture settles; also catch up during long
    // continuous pans so we hydrate upcoming artboards before hitting the overscan edge.
    virtSoon = setTimeout(() => reconcileArtboardModes(), 190);
    if (lastReconcileView && !B.dragging) {
      const cr = getCanvasRect();
      const span = Math.min(cr.width || 900, cr.height || 600);
      const movedFar = Math.hypot(v.x - lastReconcileView.x, v.y - lastReconcileView.y) > span * 0.6;
      const zoomedFar = v.z / (lastReconcileView.z || 1) > 2.2 || v.z / (lastReconcileView.z || 1) < 0.45;
      if ((movedFar || zoomedFar) && performance.now() - lastCatchupAt > 320) {
        lastCatchupAt = performance.now();
        reconcileArtboardModes(true);
      }
    }
  }
  return true;
}
const camRef = (el) => {
  if (cam.el !== el) (cam.el = el), (shown = null);
};
const worldRef = (el) => {
  if (cam.world !== el) (cam.world = el), (drawn = shown = null);
};
const gridRef = (el) => {
  if (cam.grid !== el) cam.grid = el;
};

function sharpen() {
  drawn = null;
  applyView();
  upgradeVisibleImages();
  if (virtStats.active) {
    // Settling zoom commits cleanly: release temporary force-live pins and reconcile right away
    // instead of waiting another 190ms for the gesture timer.
    gestureUntil = 0;
    clearTimeout(virtSoon);
    if (forceLiveRoots.size) forceLiveRoots.clear();
    if (!B.dragging) reconcileArtboardModes(true);
  }
}
// The view goes on screen at each frame it changes, without drawing the canvas's layers again.
onBoard(() => applyView());

export function zoomTo(z, at, { animate = false } = {}) {
  const c = getCanvasRect();
  if (!c.width) return;
  const nz = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));
  const p = at ?? { x: c.width / 2, y: c.height / 2 };
  const { x, y, z: oz } = B.view;
  setView({ x: p.x - ((p.x - x) / oz) * nz, y: p.y - ((p.y - y) / oz) * nz, z: nz }, animate);
}
export const zoomBy = (k, at, opts) => zoomTo(B.view.z * k, at, opts);

/** Glide a point on the board (board units) to the middle of the canvas, `dx` px to one side, at the same zoom. */
export function centerOn(p, { dx = 0 } = {}) {
  const c = getCanvasRect();
  if (!c.width) return;
  const z = B.view.z;
  setView({ z, x: c.width / 2 + dx - p.x * z, y: c.height / 2 - p.y * z }, true);
}

/**
 * Frame a box (board units) for following an agent: big enough to read what it's doing, with the
 * place around it in view. A small change is zoomed in on (up to 1.5×), a big one fitted; the view
 * only moves when the box is out of view, too small to read, or most of the canvas away from it.
 * `zoom`: the person's own zoom while following (they zoomed in to watch closely): kept, and the
 * view goes to the change at that zoom (to `focus`, the agent's cursor, when the box won't fit).
 */
let followGlideUntil = 0;
/** Whether the view is moving because it's following an agent (not because the person moved it). */
export const followGliding = () => performance.now() < followGlideUntil;
export function frameBox(box, { ms = 650, zoom, focus } = {}) {
  const c = getCanvasRect();
  if (!c.width || !box) return;
  const pad = 96, top = 56;
  const W = c.width - pad * 2, H = c.height - pad * 2 - top;
  // Show at least a third of the canvas's worth around a small layer, so its place reads too.
  const w = Math.max(box.width, (W / 1.5) * 0.34), h = Math.max(box.height, (H / 1.5) * 0.34);
  const z = zoom ? Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoom)) : Math.max(MIN_ZOOM, Math.min(1.5, W / w, H / h));
  const { x, y, z: oz } = B.view;
  const s = { left: box.x * oz + x, top: box.y * oz + y, right: (box.x + box.width) * oz + x, bottom: (box.y + box.height) * oz + y };
  const inView = s.left >= 24 && s.top >= top && s.right <= c.width - 24 && s.bottom <= c.height - 24;
  const readable = box.width * oz >= Math.min(W * 0.18, box.width * z * 0.6) || oz >= z * 0.8;
  const near = Math.hypot((s.left + s.right) / 2 - c.width / 2, (s.top + s.bottom) / 2 - c.height / 2) < Math.min(c.width, c.height) * 0.3;
  if (zoom ? inView && Math.abs(oz - z) < 0.01 : inView && readable && (near || oz >= z * 0.8)) return;
  // At the person's zoom a big change may not fit: go to where the agent's cursor is in it.
  const fits = box.width * z <= c.width - 48 && box.height * z <= c.height - top - 48;
  const p = !fits && focus ? focus : { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  followGlideUntil = performance.now() + ms + 80;
  setView({ z, x: c.width / 2 - p.x * z, y: (c.height + top) / 2 - p.y * z }, true, ms);
}

/** Fit layers (default: everything on the page) in the canvas, gliding there unless `instant`. */
export function fit(ids, { instant = false } = {}) {
  const c = refreshCanvasRect();
  const page = currentPage();
  if (!c || !c.width || !page) return;
  const list = ids?.length ? ids : page.children;
  if (ids?.length && virtStats.active) ensureLiveRoots(ids);
  const boxes = list
    .map((id) => worldBox(id) ?? (B.board?.nodes[id] ? rootBoxOf(B.board, rootOf(B.board, id)) : null))
    .filter(Boolean);
  if (!boxes.length) return setView({ x: c.width / 2 - 200, y: 120, z: 1 }, !instant);
  const minX = Math.min(...boxes.map((b) => b.x));
  const minY = Math.min(...boxes.map((b) => b.y));
  const maxX = Math.max(...boxes.map((b) => b.x + b.width));
  const maxY = Math.max(...boxes.map((b) => b.y + b.height));
  const pad = 72;
  // The tool dock floats over the bottom of the canvas (50px, 16px up): what's fitted stays clear of it.
  const foot = 82;
  // 24px above the first artboard is its name.
  const room = c.height - pad - foot - 24;
  const z = Math.max(MIN_ZOOM, Math.min(ids?.length ? 4 : 1, (c.width - pad * 2) / Math.max(1, maxX - minX), room / Math.max(1, maxY - minY)));
  setView({ z, x: (c.width - (maxX - minX) * z) / 2 - minX * z, y: pad + 24 + (room - (maxY - minY) * z) / 2 - minY * z }, !instant);
}

// ---------------------------------------------------------------------------------------------
// Drawing the board

const loaded = new Set();
function useFonts(board, page) {
  useEffect(() => {
    if (!board || !page) return;
    // The board's own typefaces (a website's, brought in with it), from the library.
    const faces = fontFaceCss(board, srcUrl);
    let own = document.getElementById("bd-fonts");
    if (faces || own) {
      own ??= Object.assign(document.createElement("style"), { id: "bd-fonts" });
      if (!own.isConnected) document.head.appendChild(own);
      if (own.textContent !== faces) {
        own.textContent = faces;
        document.fonts.ready.then(notify);
      }
    }
    for (const href of fontLinks(fontFamilies(board, page.children), board.fonts)) {
      if (loaded.has(href)) continue;
      loaded.add(href);
      const l = document.createElement("link");
      l.rel = "stylesheet";
      l.href = href;
      l.onload = () => document.fonts.ready.then(notify);
      document.head.appendChild(l);
    }
    // Looked for again only when the layers change: not at every frame of a pan or a pinch.
  }, [board?.nodes, board?.tokens, board?.fonts, page]);
}

function svgMarkup(svg, overflow) {
  return (svg ?? "").replace(/^<svg\b/i, `<svg style="display:block;width:100%;height:100%${overflow ? `;overflow:${overflow}` : ""}"`);
}
const svgProps = (attrs) => Object.fromEntries(cleanAttrs(attrs));

/**
 * One layer, drawn as the HTML it is. A layer redraws only when it (or something inside it) changed:
 * every change gives the layers around it new objects, so an unchanged object means nothing to do.
 * Panning, zooming and dragging something else leave it alone.
 */
class Layer extends Component {
  el = null;
  mipInfo = null;
  setRef = (el) => {
    const id = this.props.n?.id;
    if (this.el && this.el !== el && id && nodeEls.get(id) === this.el) nodeEls.delete(id);
    this.el = el;
    if (id && el) {
      bindEl(id, el);
      this.syncMip();
      syncElementEffects(el, this.props.n, B.board);
    } else if (id) {
      mipNodes.delete(id);
    }
  };
  syncMip() {
    const id = this.props.n?.id;
    if (!id || !this.el) return;
    if (!this.mipInfo) {
      mipNodes.delete(id);
      return;
    }
    const cur = mipNodes.get(id);
    if (cur && cur.el === this.el && cur.orig === this.mipInfo.orig && cur.kind === this.mipInfo.kind) {
      cur.fit = this.mipInfo.fit;
      cur.size = this.mipInfo.size;
      return;
    }
    mipNodes.set(id, { el: this.el, kind: this.mipInfo.kind, orig: this.mipInfo.orig, mip: this.mipInfo.mip, fit: this.mipInfo.fit, size: this.mipInfo.size, upgrading: null });
  }
  componentDidUpdate() {
    this.syncMip();
    if (this.el) syncElementEffects(this.el, this.props.n, B.board);
  }
  componentWillUnmount() {
    const id = this.props.n?.id;
    if (this.el) detachElementEffects(this.el);
    if (id) {
      if (nodeEls.get(id) === this.el) nodeEls.delete(id);
      mipNodes.delete(id);
    }
    this.el = null;
  }
  shouldComponentUpdate(next) {
    return next.n !== this.props.n || next.editing !== this.props.editing || next.root !== this.props.root;
  }
  render({ n, root, editing }) {
    this.mipInfo = null;
    if (!n || n.hidden) return null;
    const id = n.id;
    const existingMip = mipNodes.get(id);
    const style = {};
    for (const [k, v] of Object.entries(n.style)) {
      if (v.includes("url(")) {
        if (k === "backgroundImage") {
          const mip = !mipSafe(n, "bg") ? 0 : existingMip && existingMip.kind === "bg" && existingMip.orig === v ? existingMip.mip : initialMipFor(n);
          let hasRaster = false;
          style[k] = mapCssUrls(v, (u) => {
            const full = srcUrl(u);
            const m = withMip(full, mip);
            if (m !== full) hasRaster = true;
            return m;
          });
          if (hasRaster || (existingMip && existingMip.kind === "bg" && existingMip.orig === v)) {
            this.mipInfo = { kind: "bg", orig: v, mip: hasRaster ? mip : 0, size: n.style.backgroundSize };
          }
        } else {
          style[k] = mapCssUrls(v, srcUrl);
        }
      } else {
        style[k] = v;
      }
    }
    if (root) style.position = "absolute";
    // A mask isn't drawn (its look masks the layers above it), but it's still there to pick; its words show faintly while typed.
    if (n.mask && maskActive(B.board, id)) style.opacity = editing === id ? "0.4" : "0";
    const attrs = { "data-bid": id, style, ref: this.setRef };
    if (n.type === "text") {
      if (editing === id) return html`<${EditableText} id=${id} style=${style} />`;
      return html`<div ...${attrs} dangerouslySetInnerHTML=${{ __html: n.text ?? "" }}></div>`;
    }
    if (n.type === "image") {
      const full = srcUrl(n.src);
      const mip = !mipSafe(n, "img") ? 0 : existingMip && existingMip.kind === "img" && existingMip.orig === n.src ? existingMip.mip : initialMipFor(n);
      const scaled = withMip(full, mip);
      if (scaled !== full) this.mipInfo = { kind: "img", orig: n.src, mip, fit: n.style.objectFit };
      return html`<img ...${attrs} src=${scaled} decoding="async" alt="" draggable=${false} />`;
    }
    // Its first frame (the still) until it's played: videos don't play on their own on the canvas.
    if (n.type === "video") return html`<video ...${attrs} src=${n.src ? srcUrl(n.src) : undefined} poster=${n.poster ? srcUrl(n.poster) : undefined} preload="metadata" playsinline draggable=${false}></video>`;
    const nodes = B.board.nodes;
    if (n.type === "svg") {
      // Its pictures (<image href>) load from the library as an image layer's do.
      if (n.svg) return html`<div ...${attrs} dangerouslySetInnerHTML=${{ __html: svgMarkup(mapSvgImages(n.svg, srcUrl), n.style.overflow) }}></div>`;
      // A vector in parts: each part is drawn (and picked) as its own element.
      const inner = { display: "block", width: "100%", height: "100%", ...(n.style.overflow ? { overflow: n.style.overflow } : {}) };
      return html`<div ...${attrs}><svg ...${svgProps(n.attrs)} style=${inner}>
        ${n.defs && html`<defs dangerouslySetInnerHTML=${{ __html: mapSvgImages(n.defs, srcUrl) }}></defs>`}
        ${(n.children ?? []).map((c) => html`<${Layer} key=${c} n=${nodes[c]} editing=${editing} />`)}
      </svg></div>`;
    }
    if (n.type === "vector") {
      const Tag = vectorTag(n.tag);
      const props = { ...svgProps(svgImageAttrs(Tag, n.attrs, srcUrl)), "data-bid": id, style, ref: this.setRef };
      if (Tag !== "g") return html`<${Tag} ...${props} dangerouslySetInnerHTML=${{ __html: mapSvgImages(n.text ?? "", srcUrl) }}></${Tag}>`;
      return html`<g ...${props}>${(n.children ?? []).map((c) => html`<${Layer} key=${c} n=${nodes[c]} editing=${editing} />`)}</g>`;
    }
    // A shader fill: drawn by the shader runtime on a canvas behind the frame's layers (board-shaders.js).
    if (n.shader) {
      Object.assign(style, shaderBoxStyle(style));
      return html`<div ...${attrs}><${ShaderCanvas} key=${"shader:" + id} n=${n} />${layersOf(n, nodes, editing)}</div>`;
    }
    return html`<div ...${attrs}>${layersOf(n, nodes, editing)}</div>`;
  }
}

class VirtualRoot extends Component {
  el = null;
  setRef = (el) => {
    const id = this.props.n?.id;
    if (this.el && this.el !== el && id && nodeEls.get(id) === this.el) nodeEls.delete(id);
    this.el = el;
    if (id && el) bindEl(id, el);
  };
  componentWillUnmount() {
    const id = this.props.n?.id;
    if (id && nodeEls.get(id) === this.el) nodeEls.delete(id);
    this.el = null;
  }
  shouldComponentUpdate(next) {
    return next.n !== this.props.n || next.box?.x !== this.props.box?.x || next.box?.y !== this.props.box?.y || next.box?.width !== this.props.box?.width || next.box?.height !== this.props.box?.height;
  }
  render({ n, box }) {
    if (!n || n.hidden || !box) return null;
    const style = {
      position: "absolute",
      left: `${box.x}px`,
      top: `${box.y}px`,
      width: `${box.width}px`,
      height: `${box.height}px`,
      background: n.style.backgroundColor || n.style.background || "var(--panel)",
      ...(n.style.borderRadius ? { borderRadius: n.style.borderRadius } : {}),
    };
    return html`<div class="bd-virtual" data-bid=${n.id} data-virtual="1" style=${style} ref=${this.setRef}></div>`;
  }
}

class LodRoot extends Component {
  el = null;
  setRef = (el) => {
    const id = this.props.n?.id;
    if (this.el && this.el !== el && id && nodeEls.get(id) === this.el) nodeEls.delete(id);
    this.el = el;
    if (id && el) bindEl(id, el);
  };
  componentWillUnmount() {
    const id = this.props.n?.id;
    if (id && nodeEls.get(id) === this.el) nodeEls.delete(id);
    this.el = null;
  }
  shouldComponentUpdate(next) {
    return (
      next.n !== this.props.n ||
      next.imgUrl !== this.props.imgUrl ||
      next.box?.x !== this.props.box?.x ||
      next.box?.y !== this.props.box?.y ||
      next.box?.width !== this.props.box?.width ||
      next.box?.height !== this.props.box?.height
    );
  }
  render({ n, box, imgUrl }) {
    if (!n || n.hidden || !box) return null;
    const style = {
      position: "absolute",
      left: `${box.x}px`,
      top: `${box.y}px`,
      width: `${box.width}px`,
      height: `${box.height}px`,
      ...(imgUrl ? {} : { background: n.style.backgroundColor || n.style.background || "var(--panel)" }),
      ...(n.style.borderRadius ? { borderRadius: n.style.borderRadius } : {}),
      ...(n.style.boxShadow ? { boxShadow: n.style.boxShadow } : {}),
    };
    return html`<div class="bd-lod" data-bid=${n.id} data-lod="1" style=${style} ref=${this.setRef}>
      ${imgUrl && html`<img class="bd-lod-img" src=${imgUrl} decoding="async" alt="" draggable=${false} />`}
    </div>`;
  }
}

/** A frame's layers: those a mask masks are drawn inside the elements that mask them, as exports draw them. */
function layersOf(n, nodes, editing) {
  const kids = n.children ?? [];
  const one = (c) => html`<${Layer} key=${c} n=${nodes[c]} editing=${editing} />`;
  if (!kids.some((c) => nodes[c]?.mask)) return kids.map(one);
  return maskRuns(B.board, kids).flatMap((r) => (r.mask ? [one(r.mask), html`<${MaskScope} key=${"mask:" + r.mask} mask=${r.mask} ids=${r.ids} editing=${editing} />`] : r.ids.map(one)));
}

/**
 * What a mask shows: its layers in an element over the frame (so they keep their places), inside one
 * on the mask's box carrying its look as CSS (maskCss in the core). It draws again when a web font
 * for a text mask arrives.
 */
function MaskScope({ mask, ids, editing }) {
  const [, redraw] = useState(0);
  useEffect(() => onMaskFonts(() => redraw((k) => k + 1)), []);
  // A token a vector or text mask uses is drawn into its picture: a change to the tokens draws it again.
  useBoard(CANVAS_ONLY);
  const nodes = B.board.nodes;
  const kids = ids.map((c) => html`<${Layer} key=${c} n=${nodes[c]} editing=${editing} />`);
  const css = ids.length && maskActive(B.board, mask) ? maskCss(B.board, mask, { src: srcUrl }) : null;
  if (!css) return kids;
  return html`<div data-mask-scope=${mask} style=${styleText(css.scope)}><div style=${styleText(css.box)}>${kids}</div></div>`;
}

/** Web fonts a text mask uses, fetched into its picture (an SVG drawn as an image can't load them itself). */
function useMaskFonts(board) {
  useEffect(() => {
    if (board && Object.values(board.nodes).some((n) => n.mask && n.type === "text")) loadMaskFonts(board).catch(() => undefined);
  }, [board?.nodes]);
}

/** A text layer being typed in: the browser edits it; the words go back on Escape or a click away. */
function EditableText({ id, style }) {
  const ref = useRef();
  useLayoutEffect(() => {
    const el = ref.current;
    el.innerHTML = node(id)?.text ?? "";
    el.focus();
    const r = document.createRange();
    r.selectNodeContents(el);
    const s = getSelection();
    s.removeAllRanges();
    s.addRange(r);
  }, [id]);
  useEffect(() => {
    const onSel = () => {
      const s = getSelection();
      const r = s.rangeCount ? s.getRangeAt(0) : null;
      const inside = r && ref.current?.contains(r.commonAncestorContainer);
      const was = Boolean(words.range && !words.range.collapsed);
      if (inside) words.range = r.cloneRange();
      // The canvas (the text's box grows as it's typed) and the panel's bold and italic follow;
      // the layer list and the rest of the editor don't, at every key and every pointer move.
      if (Boolean(words.range && !words.range.collapsed) !== was || inside) notify(["words"]);
    };
    document.addEventListener("selectionchange", onSel);
    return () => {
      document.removeEventListener("selectionchange", onSel);
      words.range = null;
    };
  }, [id]);
  return html`<div data-bid=${id} ref=${(el) => { ref.current = el; bindEl(id, el); }} style=${{ ...style, outline: "none", cursor: "text" }} contenteditable="true" spellcheck=${false}
    onBlur=${(e) => !e.relatedTarget?.closest?.(".bd-words") && finishText(id, ref.current)}
    onPointerDown=${(e) => e.stopPropagation()}
    onKeyDown=${(e) => {
      e.stopPropagation();
      // Enter or Escape that picks a Japanese, Chinese or Korean word belongs to the input method.
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key === "Escape" || (e.key === "Enter" && (e.metaKey || e.ctrlKey))) {
        e.preventDefault();
        ref.current.blur();
      } else if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        document.execCommand("insertLineBreak");
      }
    }}></div>`;
}

/** The words selected in the text being typed in, for the panel's bold, italic and colour. */
export const words = { range: null };

/** Style the selected words: bold, italic, underline, strikeThrough, or foreColor with a colour. */
export function styleWords(cmd, value) {
  const el = B.editing && elOf(B.editing);
  if (!el || !words.range) return;
  el.focus();
  const s = getSelection();
  s.removeAllRanges();
  s.addRange(words.range);
  document.execCommand("styleWithCSS", false, cmd === "foreColor");
  document.execCommand(cmd, false, value);
  if (s.rangeCount) words.range = s.getRangeAt(0).cloneRange();
  notify();
}
export const wordState = (cmd) => {
  try {
    return Boolean(words.range && !words.range.collapsed && document.queryCommandState(cmd));
  } catch {
    return false;
  }
};

export async function finishText(id, el) {
  if (B.editing !== id || !el) return;
  const { inlineHtml, parseHtml } = await import("./board-core.js");
  // New lines the browser made as <div>s become line breaks.
  const raw = el.innerHTML.replace(/<div>/gi, "<br>").replace(/<\/div>/gi, "");
  const text = inlineHtml(parseHtml(raw).children).replace(/^(<br>)+/, "");
  B.editing = null;
  if (text !== (node(id)?.text ?? "")) commit([{ op: "set", id, text: text || "Text" }], { label: "Typing" });
  else notify();
}

// ---------------------------------------------------------------------------------------------
// The canvas

export function BoardCanvas() {
  const ref = useRef();
  // The layers redraw for what they show: the view (the camera) and the pointer (the overlay) follow on their own.
  const b = useBoard(CANVAS_ONLY);
  const [, setVirtTick] = useState(0);
  const page = currentPage();
  const prevRef = useRef({ id: null, page: null, board: null });
  useFonts(b.board, page);
  useMaskFonts(b.board);
  useLayoutEffect(() => {
    canvasEl.current = ref.current;
    refreshCanvasRect();
    const prev = prevRef.current;
    const switched = prev.id !== b.id || prev.page !== b.page;
    const mutated = prev.board !== b.board;
    prevRef.current = { id: b.id, page: b.page, board: b.board };
    if (switched) {
      drawn = shown = null;
      invalidateWorldCache();
    } else if (mutated) {
      if (B.dragging) {
        // Dragging a layer: only clear cached boxes for the moved/resized layers, never all cullables.
        const touched = [];
        for (const id of B.sel) {
          touched.push(id, ...ancestors(b.board, id));
        }
        invalidateWorldCache(touched);
      } else {
        invalidateWorldCache();
      }
    }
    // A camera just made (the board opened): what's drawn over the design measures again with it.
    const moved = applyView();
    if (rootsDirty && b.board && page) measureRoots();
    if (moved) notify();
    if (switched) {
      setTimeout(upgradeVisibleImages, 260);
      syncLodMeta(b.board, page);
    } else if (mutated && !B.dragging && getPageVirtInfo(b.board, page).active) {
      clearTimeout(lodMetaSoon);
      lodMetaSoon = setTimeout(() => syncLodMeta(B.board, currentPage()), 750);
    }
  });
  // A board opens fitted to its first page (computed before first paint when layout is ready,
  // avoiding a wasted raster pass at the default zoom on huge 100,000px boards).
  useLayoutEffect(() => {
    if (B.view.fitPending) {
      B.view = { ...B.view, fitPending: false };
      if (ref.current?.getBoundingClientRect().width) {
        fit(undefined, { instant: true });
        applyView();
        if (B.board && page && getPageVirtInfo(B.board, page).active) {
          if (computeRootModes(B.board, page, B.view)) setVirtTick((t) => t + 1);
        }
      } else {
        requestAnimationFrame(() => fit(undefined, { instant: true }));
      }
    }
  }, [b.id, b.page]);
  useEffect(() => {
    virtListener = () => setVirtTick((t) => t + 1);
    const el = ref.current;
    let ro = null;
    const onResize = () => {
      refreshCanvasRect();
      if (virtStats.active) reconcileArtboardModes();
    };
    if (typeof ResizeObserver !== "undefined") {
      ro = new ResizeObserver(onResize);
      ro.observe(el);
    }
    window.addEventListener("resize", onResize);
    const wheel = (e) => {
      e.preventDefault();
      const r = getCanvasRect();
      if (e.ctrlKey || e.metaKey) zoomBy(Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.002)), { x: e.clientX - r.left, y: e.clientY - r.top });
      else bset({ view: { ...B.view, x: B.view.x - e.deltaX, y: B.view.y - e.deltaY } });
    };
    // Safari's own pinch.
    let g0 = 1;
    const gs = (e) => {
      e.preventDefault();
      g0 = 1;
    };
    const gc = (e) => {
      e.preventDefault();
      const r = getCanvasRect();
      zoomBy(e.scale / g0, { x: e.clientX - r.left, y: e.clientY - r.top });
      g0 = e.scale;
    };
    el.addEventListener("wheel", wheel, { passive: false });
    el.addEventListener("gesturestart", gs);
    el.addEventListener("gesturechange", gc);
    const fonts = () => {
      invalidateWorldCache();
      notify();
    };
    document.fonts.addEventListener?.("loadingdone", fonts);
    // A picture sized by its file moves what's around it when it arrives.
    let loadedSoon = 0;
    const loaded = (e) => {
      const t = e.target;
      if (!(t instanceof HTMLImageElement) || (t.style.width && t.style.height)) return;
      clearTimeout(loadedSoon);
      loadedSoon = setTimeout(() => (invalidateWorldCache(), notify()), 50);
    };
    el.addEventListener("load", loaded, true);
    return () => {
      virtListener = null;
      el.removeEventListener("load", loaded, true);
      clearTimeout(loadedSoon);
      ro?.disconnect();
      window.removeEventListener("resize", onResize);
      el.removeEventListener("wheel", wheel);
      el.removeEventListener("gesturestart", gs);
      el.removeEventListener("gesturechange", gc);
      document.fonts.removeEventListener?.("loadingdone", fonts);
      canvasRect = null;
      resetVirtualization();
      invalidateWorldCache();
      nodeEls.clear();
      mipNodes.clear();
      mipUpgradeQueue.length = 0;
      pendingMipCommits.length = 0;
    };
  }, []);
  // The view goes on screen before what's drawn over the design measures where things are.
  applyView();
  if (!b.board || !page) return html`<div class="bd-canvas" ref=${ref}></div>`;
  const pageKey = `${b.id}:${page.id}`;
  if (virtPageKey !== pageKey) {
    resetVirtualization();
    virtPageKey = pageKey;
  }
  const virtInfo = getPageVirtInfo(b.board, page);
  if (virtInfo.active) computeRootModes(b.board, page, B.view);
  else if (rootModes.size) {
    rootModes.clear();
    Object.assign(virtStats, { active: false, totalRoots: page.children.length, live: page.children.length, lod: 0, virtual: 0, totalNodes: virtInfo.totalNodes, liveNodes: virtInfo.totalNodes });
  }
  const tokens = Object.fromEntries(b.board.tokens.map((t) => [t.name, t.value]));
  return html`<div class="bd-canvas tool-${b.tool} ${spaceDown ? "panning" : ""}" ref=${ref}
      onPointerDown=${down} onDblClick=${dblclick} onContextMenu=${contextMenu} onPointerMove=${hoverMove} onPointerLeave=${() => (B.hover && bset({ hover: null }), B.live && sendLivePresence({ cursor: null }, { immediate: true }))}
      onClickCapture=${(e) => e.target.closest("a") && e.preventDefault()}
      onDragOver=${(e) => e.preventDefault()} onDrop=${dropFiles}>
    <div class="bd-camera" ref=${camRef}>
      <div class="bd-world" ref=${worldRef} style=${tokens}>
        ${page.children.map((id) => {
          const n = b.board.nodes[id];
          if (!n || n.hidden) return null;
          const mode = virtInfo.active ? rootModes.get(id) ?? "live" : "live";
          if (mode === "virtual") return html`<${VirtualRoot} key=${id} n=${n} box=${rootBoxOf(b.board, id)} />`;
          if (mode === "lod") {
            const entry = lodEntries.get(id);
            const imgUrl = isFreshLod(b.board, id, entry) && entry.ready ? entry.url : "";
            return html`<${LodRoot} key=${id} n=${n} box=${rootBoxOf(b.board, id)} imgUrl=${imgUrl} />`;
          }
          return html`<${Layer} key=${id} n=${n} root editing=${b.editing} />`;
        })}
      </div>
    </div>
    <div class="bd-pxgrid" ref=${gridRef}></div>
    <${Overlay} />
    <${Presence} />
    <${PresenceBar} />
    ${!page.children.length && html`<div class="bd-empty">
      <b>What are we making?</b>
      <button class="bd-ask" onClick=${() => (bset({ rightTab: "agent" }), setTimeout(() => document.querySelector(".ag-composer textarea")?.focus(), 80))}>
        <${Icon} n="spark" s=${16} /><span>Describe a screen to an agent…</span><kbd>↵</kbd>
      </button>
      <div class="bd-starts">
        <button onClick=${() => bset({ tool: "frame" })}><${Icon} n="frame" s=${14} />Draw a frame<kbd>F</kbd></button>
        <button onClick=${() => window.studio?.command("importWebsite")}><${Icon} n="globe" s=${14} />Import a website</button>
        <button onClick=${() => window.studio?.command("importFigma")}><${Icon} n="component" s=${14} />Import from Figma</button>
      </div>
    </div>`}
  </div>`;
}

// ---------------------------------------------------------------------------------------------
// What's drawn over the design: selection, handles, labels, guides

const HANDLES = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];
/** The tools that pick and move layers: Move, and Scale (whose handles scale instead of resizing). */
const picking = () => B.tool === "move" || B.tool === "scale";

function sizeLabel(id, box) {
  const z = B.view.z;
  if (node(id)?.type === "vector") return `${round(box.width / z, 1)} × ${round(box.height / z, 1)}`;
  const word = (axis, px) => {
    const w = sizeWord(B.board, id, axis);
    const v = Math.round(px / z);
    return w === "fit" ? `Hug ${v}` : w === "fill" ? `Fill ${v}` : w === "auto" ? `${v}` : /%$/.test(w) ? `${w} ${v}` : String(round(Number(w), 1)) === "NaN" ? `${v}` : w;
  };
  return `${word("width", box.width)} × ${word("height", box.height)}`;
}

function Overlay() {
  // It follows everything: the view, the pointer, the selection.
  const b = useBoard();
  const page = currentPage();
  if (!canvasEl.current || !page) return null;
  // Artboards (frames on the page) carry their names above them; a loose picture or shape doesn't.
  const roots = page.children.filter((id) => b.board.nodes[id] && !b.board.nodes[id].hidden && b.board.nodes[id].type === "frame");
  const one = b.sel.length === 1 ? b.sel[0] : null;
  // While something is being dragged, only what helps with it shows: the size while resizing.
  const busy = b.dragging;
  const hover = !busy && b.hover && !b.sel.includes(b.hover) ? screenBox(b.hover) : null;
  const sel = b.sel.map((id) => [id, screenBox(id)]).filter(([, r]) => r);
  const box = one ? screenBox(one) : null;
  const locked = one && node(one)?.locked;
  const movable = b.sel.length > 1 && !b.editing ? b.sel.filter((id) => !node(id)?.locked) : [];
  const group = movable.length > 1 ? unionOf(movable.map(screenBox).filter(Boolean)) : null;
  // Each agent marks the artboard it's on now (its latest move), in its own colour and with its name.
  const onIt = agentArtboards();
  const cr = getCanvasRect();
  return html`<div class="bd-overlay">
    ${roots.map((id) => {
      const r = screenBox(id);
      if (!r || r.x + r.width < -60 || r.x > cr.width + 60 || r.y + r.height < -60 || r.y - 26 > cr.height + 60) return null;
      const agent = onIt.get(id);
      const selected = b.sel.includes(id);
      // When dozens of artboards are zoomed tiny (< 28 px wide), skip unreadable overlapping labels unless selected/hovered/active.
      if (roots.length > 20 && r.width < 28 && !selected && b.hover !== id && !agent) return null;
      const writing = agent && !["look", "read"].includes(agent.doing);
      return html`<div key=${id} class="bd-label ${selected ? "on" : ""} ${agent ? "working" : ""}" style=${{ left: r.x + "px", top: r.y - 22 + "px", maxWidth: Math.max(40, r.width) + "px", "--c": agent ? colourOf(agent.key) : undefined }} data-label=${id}>
        ${agent && html`<span class="bd-agent"><i></i>${agent.name}</span>`}<span class="t">${b.board.nodes[id].name}</span></div>
        ${writing && html`<div class="bd-working" style=${{ left: r.x - 2 + "px", top: r.y - 2 + "px", width: r.width + 4 + "px", height: r.height + 4 + "px", "--c": colourOf(agent.key) }}></div>`}`;
    })}
    <${GridOverlay} />
    ${hover && html`<div class="bd-hover" style=${{ left: hover.x + "px", top: hover.y + "px", width: hover.width + "px", height: hover.height + "px" }}></div>`}
    ${sel.map(([id, r]) => html`<div key=${id} class="bd-sel ${node(id)?.locked ? "locked" : ""}" style=${{ left: r.x + "px", top: r.y + "px", width: r.width + "px", height: r.height + "px" }}></div>`)}
    ${!busy && html`<${MaskLines} />`}
    ${box && !locked && !b.editing && !busy &&
    HANDLES.map((h) => html`<div key=${h} class="bd-handle h-${h}" data-handle=${h} style=${{ left: box.x + (h.includes("w") ? 0 : h.includes("e") ? box.width : box.width / 2) + "px", top: box.y + (h.includes("n") ? 0 : h.includes("s") ? box.height : box.height / 2) + "px" }}></div>`)}
    ${box && !b.editing && (!busy || busy === "resize" || busy === "scale") && html`<div class="bd-size" style=${{ left: box.x + box.width / 2 + "px", top: box.y + box.height + 8 + "px" }}>${sizeLabel(one, box)}${busy === "scale" && b.scaling ? ` · ${Math.round(b.scaling * 100)}%` : ""}</div>`}
    ${group && html`<div class="bd-group" style=${{ left: group.x + "px", top: group.y + "px", width: group.width + "px", height: group.height + "px" }}></div>
      ${!busy && HANDLES.map((h) => html`<div key=${h} class="bd-handle h-${h}" data-handle=${h} data-group="1" style=${{ left: group.x + (h.includes("w") ? 0 : h.includes("e") ? group.width : group.width / 2) + "px", top: group.y + (h.includes("n") ? 0 : h.includes("s") ? group.height : group.height / 2) + "px" }}></div>`)}
      ${(!busy || busy === "resize" || busy === "scale") && html`<div class="bd-size" style=${{ left: group.x + group.width / 2 + "px", top: group.y + group.height + 8 + "px" }}>${Math.round(group.width / b.view.z)} × ${Math.round(group.height / b.view.z)}${busy === "scale" && b.scaling ? ` · ${Math.round(b.scaling * 100)}%` : ""}</div>`}`}
    ${box && !busy && !b.editing && node(one)?.type === "video" && html`<${VideoBadge} key=${one} id=${one} box=${box} />`}
    ${altDown && one && !busy && html`<${Distances} from=${one} to=${b.hover && b.hover !== one ? b.hover : node(one)?.parent} />`}
    ${b.drop?.line && html`<div class="bd-drop-line" style=${{ left: b.drop.line.x + "px", top: b.drop.line.y + "px", width: b.drop.line.width + "px", height: b.drop.line.height + "px" }}></div>`}
    ${b.drop?.into && (() => {
      const r = screenBox(b.drop.into);
      return r && html`<div class="bd-drop-into" style=${{ left: r.x + "px", top: r.y + "px", width: r.width + "px", height: r.height + "px" }}></div>`;
    })()}
    ${b.drop?.rect && html`<div class=${b.drop.kind === "marquee" ? "bd-marquee" : b.drop.kind === "comment" ? "bd-carea" : "bd-draw"} style=${{ left: b.drop.rect.x + "px", top: b.drop.rect.y + "px", width: b.drop.rect.width + "px", height: b.drop.rect.height + "px" }}></div>`}
    ${b.guides.map((g, i) => html`<div key=${i} class="bd-guide ${g.axis}" style=${g.axis === "x" ? { left: g.at + "px", top: g.from + "px", height: g.to - g.from + "px" } : { top: g.at + "px", left: g.from + "px", width: g.to - g.from + "px" }}></div>`)}
    <${CommentLayer} />
  </div>`;
}

// ---------------------------------------------------------------------------------------------
// Video, as Figma has it: the canvas shows a video's first frame; selected, it's marked "Video" and
// has a play button, to watch it right there. Its own settings (sound, loop) apply; selecting
// something else stops it and shows the first frame again.

/** Play or pause a video layer on the canvas. */
export function toggleVideo(id) {
  const v = elOf(id);
  const n = node(id);
  if (!v || !n || n.type !== "video") return;
  if (!v.paused) return v.pause();
  const s = videoSettings(n);
  v.muted = s.muted;
  v.loop = s.loop;
  v.play().catch(() => {
    v.muted = true;
    v.play().catch(() => {});
  });
}

/** A video layer's element and whether it's playing, kept up to date. */
export function useVideo(id) {
  const [, tick] = useState(0);
  useEffect(() => {
    const v = elOf(id);
    if (!v || v.tagName !== "VIDEO") return;
    const on = () => tick((t) => t + 1);
    const events = ["play", "pause", "ended", "timeupdate", "loadedmetadata", "seeked"];
    for (const e of events) v.addEventListener(e, on);
    return () => {
      for (const e of events) v.removeEventListener(e, on);
    };
  }, [id]);
  const v = elOf(id);
  return v && v.tagName === "VIDEO" ? v : null;
}

/** Back to the first frame, as it shows when it isn't being watched. */
function stillAgain(id) {
  const v = elOf(id);
  if (!v || v.tagName !== "VIDEO") return;
  if (!v.paused || v.currentTime > 0) {
    v.pause();
    v.load();
  }
}

function VideoBadge({ id, box }) {
  const v = useVideo(id);
  useEffect(() => () => stillAgain(id), [id]);
  const playing = Boolean(v && !v.paused);
  const big = box.width >= 90 && box.height >= 70;
  return html`<div class="bd-video-tag" style=${{ left: box.x + 8 + "px", top: box.y + 8 + "px" }}><${Icon} n="video" s=${11} />Video</div>
    <button class="bd-video-play ${playing ? "playing" : ""} ${big ? "" : "small"}" title=${playing ? "Pause" : "Play it here"} aria-label=${playing ? "Pause" : "Play"}
      style=${{ left: box.x + box.width / 2 + "px", top: box.y + box.height / 2 + "px" }}
      onPointerDown=${(e) => e.stopPropagation()} onDblClick=${(e) => e.stopPropagation()} onClick=${(e) => (e.stopPropagation(), toggleVideo(id))}>
      <${Icon} n=${playing ? "pause" : "play"} s=${big ? 18 : 12} />
    </button>`;
}

/** The outline of the mask over each selected (or hovered) layer it masks, as Figma shows it: what shows of them. */
function MaskLines() {
  const masks = new Set();
  for (const id of [...B.sel, B.hover]) {
    const m = id && !node(id)?.mask ? maskOf(B.board, id) : null;
    if (m && !B.sel.includes(m) && maskActive(B.board, m)) masks.add(m);
  }
  return [...masks].map((m) => {
    const r = screenBox(m);
    // Its corners as drawn, at the zoom.
    const radius = elOf(m) && node(m).type !== "text" ? getComputedStyle(elOf(m)).borderRadius.replace(/(-?[\d.]+)px/g, (_, v) => `${Number(v) * B.view.z}px`) : "";
    return r && html`<div key=${"ml" + m} class="bd-mask-line" style=${{ left: r.x + "px", top: r.y + "px", width: r.width + "px", height: r.height + "px", borderRadius: radius }}></div>`;
  });
}

const unionOf = (boxes) => {
  if (!boxes.length) return null;
  const x = Math.min(...boxes.map((r) => r.x));
  const y = Math.min(...boxes.map((r) => r.y));
  return { x, y, width: Math.max(...boxes.map((r) => r.x + r.width)) - x, height: Math.max(...boxes.map((r) => r.y + r.height)) - y };
};

/** ⌥ held: how far the selected layer is from another (or, inside it, from its edges). */
function Distances({ from, to }) {
  const a = from && screenBox(from);
  const b = to && screenBox(to);
  if (!a || !b) return null;
  const z = B.view.z;
  const lines = [];
  const inside = a.x >= b.x - 0.5 && a.y >= b.y - 0.5 && a.x + a.width <= b.x + b.width + 0.5 && a.y + a.height <= b.y + b.height + 0.5;
  const midY = a.y + a.height / 2;
  const midX = a.x + a.width / 2;
  const h = (x1, x2, y) => x2 - x1 > 0.5 && lines.push({ x: x1, y, w: x2 - x1, h: 0, v: (x2 - x1) / z });
  const v = (y1, y2, x) => y2 - y1 > 0.5 && lines.push({ x, y: y1, w: 0, h: y2 - y1, v: (y2 - y1) / z });
  if (inside) {
    h(b.x, a.x, midY);
    h(a.x + a.width, b.x + b.width, midY);
    v(b.y, a.y, midX);
    v(a.y + a.height, b.y + b.height, midX);
  } else {
    const oy = Math.max(a.y, b.y) < Math.min(a.y + a.height, b.y + b.height) ? (Math.max(a.y, b.y) + Math.min(a.y + a.height, b.y + b.height)) / 2 : midY;
    const ox = Math.max(a.x, b.x) < Math.min(a.x + a.width, b.x + b.width) ? (Math.max(a.x, b.x) + Math.min(a.x + a.width, b.x + b.width)) / 2 : midX;
    if (a.x + a.width <= b.x) h(a.x + a.width, b.x, oy);
    else if (b.x + b.width <= a.x) h(b.x + b.width, a.x, oy);
    if (a.y + a.height <= b.y) v(a.y + a.height, b.y, ox);
    else if (b.y + b.height <= a.y) v(b.y + b.height, a.y, ox);
  }
  return html`${!inside && html`<div class="bd-measure-box" style=${{ left: b.x + "px", top: b.y + "px", width: b.width + "px", height: b.height + "px" }}></div>`}
    ${lines.map((l, i) => html`<div key=${i} class="bd-measure ${l.h ? "v" : "h"}" style=${{ left: l.x + "px", top: l.y + "px", width: Math.max(1, l.w) + "px", height: Math.max(1, l.h) + "px" }}>
      <span style=${l.h ? { top: "50%", left: "6px" } : { left: "50%", top: "6px" }}>${Math.round(l.v)}</span></div>`)}`;
}

// ---------------------------------------------------------------------------------------------
// Pointer work

let spaceDown = false;
/** ⌥ held: distances from the selection to the layer under the pointer. */
let altDown = false;
addEventListener("keydown", (e) => {
  if (e.key === "Alt" && !altDown && B.id) {
    altDown = true;
    notify();
  }
});
addEventListener("keyup", (e) => {
  if (e.key === "Alt" && altDown) {
    altDown = false;
    notify();
  }
});
addEventListener("blur", () => {
  if (altDown) {
    altDown = false;
    notify();
  }
});
addEventListener("keydown", (e) => {
  if (e.code === "Space" && !e.repeat && B.id && !B.editing && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName ?? "") && !document.activeElement?.isContentEditable) {
    spaceDown = true;
    e.preventDefault();
    notify();
  }
});
addEventListener("keyup", (e) => {
  if (e.code === "Space" && spaceDown) {
    spaceDown = false;
    notify();
  }
});
// Space let go in another app (⌘Tab while panning) never reaches this one: leaving clears it.
addEventListener("blur", () => {
  if (!spaceDown) return;
  spaceDown = false;
  notify();
});

/**
 * Every layer under a point on screen, deepest (front-most) first, then the ones holding it: what
 * right-click → Select layer lists.
 */
export function layersAt(clientX, clientY) {
  const out = [];
  for (const el of document.elementsFromPoint(clientX, clientY)) {
    const h = el.closest?.("[data-bid]");
    if (!h || !h.closest(".bd-world")) continue;
    for (const id of [h.dataset.bid, ...ancestors(B.board, h.dataset.bid)]) if (node(id) && !out.includes(id)) out.push(id);
  }
  return out;
}

/** The deepest layer a press on `id` can pick (a locked one passes it to what holds it). */
const deepestFor = (id) => [id, ...ancestors(B.board, id)].find((x) => !node(x)?.locked) ?? null;

/** The layer a click on `id` (the deepest one hit) means, by how deep the selection already is. */
export function pickFor(e, id) {
  const board = B.board;
  const chain = [id, ...ancestors(board, id)].filter((x) => !board.nodes[x]?.locked || x === id);
  if (!chain.length) return null;
  if (e.metaKey || e.ctrlKey) return chain[0];
  // Keep to the level being worked at: a layer beside (or inside) what's selected.
  for (const s of B.sel) {
    const sn = node(s);
    if (!sn?.parent) continue;
    const at = chain.findIndex((x) => node(x)?.parent === sn.parent);
    if (at >= 0) return chain[at];
    const inside = chain.findIndex((x) => node(x)?.parent === s);
    if (inside >= 0) return chain[inside];
  }
  // Else what sits directly on the artboard (or the artboard, clicked on its own background).
  return chain.length >= 2 ? chain[chain.length - 2] : chain[0];
}

// Where the pointer last was, so holding ⌘ can show the deepest layer there without a move.
let pointer = null;
function hoverAt(clientX, clientY, deep) {
  const el = document.elementFromPoint(clientX, clientY);
  if (!el?.closest?.(".bd-canvas") || el.closest("[data-label]")) return;
  const hit = el.closest("[data-bid]");
  const id = hit ? (deep ? deepestFor(hit.dataset.bid) : pickFor({}, hit.dataset.bid)) : null;
  if (id !== B.hover) bset({ hover: id });
}
for (const [type, deep] of [["keydown", true], ["keyup", false]])
  addEventListener(type, (e) => {
    if ((e.key === "Meta" || e.key === "Control") && B.id && picking() && pointer && !B.dragging) hoverAt(pointer.x, pointer.y, deep);
  });

function hoverMove(e) {
  pointer = { x: e.clientX, y: e.clientY };
  if (B.live && canvasEl.current) {
    const w = toWorld(e.clientX, e.clientY);
    sendLivePresence({ cursor: { x: Math.round(w.x), y: Math.round(w.y) }, page: B.page, tool: B.tool });
  }
  if (e.buttons || (!picking() && B.tool !== "comment") || spaceDown) return;
  const hit = e.target.closest?.("[data-bid]");
  const label = e.target.closest?.("[data-label]");
  // With the comment tool, the layer a click would pin a comment to (until one is being written).
  const id = B.tool === "comment" ? (hit && !B.draft && !B.thread ? commentTarget(hit.dataset.bid) : null) : label ? label.dataset.label : hit ? pickFor(e, hit.dataset.bid) : null;
  if (id !== B.hover) bset({ hover: id });
}

/** The layer a comment is pinned to: the one right under the pointer (a vector part's whole vector). */
function commentTarget(id) {
  while (node(id)?.type === "vector" && node(id).parent) id = node(id).parent;
  return id;
}

/** The comment tool: a click pins a comment to the layer under it, a drag to the part of the artboard drawn over. */
function comment(e) {
  // A click away from an open thread only closes it.
  if (B.thread || B.draft) return closeThread();
  const c = canvasEl.current.getBoundingClientRect();
  const hit = e.target.closest?.("[data-bid]");
  const p0 = toWorld(e.clientX, e.clientY);
  let rect = null;
  drag(e, {
    threshold: 4,
    kind: "draw",
    move: (ev) => {
      rect = { x: Math.min(e.clientX, ev.clientX) - c.left, y: Math.min(e.clientY, ev.clientY) - c.top, width: Math.abs(ev.clientX - e.clientX), height: Math.abs(ev.clientY - e.clientY) };
      bset({ drop: { kind: "comment", rect }, hover: null });
    },
    up: (ev, moved) => {
      bset({ drop: null });
      if (moved && rect && rect.width > 6 && rect.height > 6) {
        const p1 = toWorld(ev.clientX, ev.clientY);
        const world = { x: Math.min(p0.x, p1.x), y: Math.min(p0.y, p1.y), width: Math.abs(p1.x - p0.x), height: Math.abs(p1.y - p0.y) };
        // The artboard it starts on (or covers most of), and the part of it inside the drag.
        const overlap = (id) => {
          const b = worldBox(id);
          if (!b) return 0;
          return Math.max(0, Math.min(b.x + b.width, world.x + world.width) - Math.max(b.x, world.x)) * Math.max(0, Math.min(b.y + b.height, world.y + world.height) - Math.max(b.y, world.y));
        };
        const art = currentPage().children.filter((id) => node(id)?.type === "frame" && !node(id).hidden && overlap(id) > 0).sort((a, b) => overlap(b) - overlap(a))[0];
        if (!art) return toast({ kind: "info", icon: "comment", title: "Comments go on an artboard", text: "Drag over part of an artboard, or click a layer.", timeout: 4000 });
        const ab = worldBox(art);
        const x = Math.max(world.x, ab.x);
        const y = Math.max(world.y, ab.y);
        const r = { x: x - ab.x, y: y - ab.y, width: Math.min(world.x + world.width, ab.x + ab.width) - x, height: Math.min(world.y + world.height, ab.y + ab.height) - y };
        return startDraft({ artboard: art, rect: r, layers: layersIn(art, { ...r, x, y }) });
      }
      if (!hit) return toast({ kind: "info", icon: "comment", title: "Comments go on a layer", text: "Click a layer, or drag over part of an artboard.", timeout: 4000 });
      const id = commentTarget(hit.dataset.bid);
      const box = worldBox(id);
      startDraft({ layer: id, at: box && box.width && box.height ? { x: (p0.x - box.x) / box.width, y: (p0.y - box.y) / box.height } : undefined });
    },
  });
}

/** Follow a press until it lets go. `kind` says what the drag is, so the overlay can step aside. */
function drag(e, { move, up, threshold = 3, kind = null }) {
  const x0 = e.clientX;
  const y0 = e.clientY;
  let live = threshold === 0;
  if (live && kind) B.dragging = kind;
  const onMove = (ev) => {
    if (!live && Math.hypot(ev.clientX - x0, ev.clientY - y0) < threshold) return;
    if (!live && kind) B.dragging = kind;
    live = true;
    move(ev);
  };
  const onUp = (ev) => {
    removeEventListener("pointermove", onMove);
    removeEventListener("pointerup", onUp);
    B.dragging = null;
    up(ev, live);
    notify();
  };
  addEventListener("pointermove", onMove);
  addEventListener("pointerup", onUp);
}

function down(e) {
  if (e.button === 2) return;
  const c = canvasEl.current;
  if (B.editing && e.target.closest?.(`[data-bid="${B.editing}"]`)) return;
  if (B.editing) finishText(B.editing, elOf(B.editing));
  document.activeElement?.blur?.();
  // Pan: the hand tool, space held, or the middle button.
  if (e.button === 1 || B.tool === "hand" || spaceDown) {
    e.preventDefault();
    const v0 = { ...B.view };
    c.classList.add("grabbing");
    return drag(e, {
      threshold: 0,
      kind: "pan",
      move: (ev) => bset({ view: { ...v0, x: v0.x + ev.clientX - e.clientX, y: v0.y + ev.clientY - e.clientY } }),
      up: () => c.classList.remove("grabbing"),
    });
  }
  if (B.tool === "comment") return comment(e);
  // Working on the design closes a comment's thread.
  if (B.thread || B.draft) closeThread();
  const handle = e.target.closest?.("[data-handle]");
  if (handle && B.tool === "scale") return scaleDrag(e, handle.dataset.group ? B.sel.filter((id) => !node(id)?.locked) : B.sel.slice(0, 1), handle.dataset.handle);
  if (handle && handle.dataset.group) return resizeMany(e, B.sel.filter((id) => !node(id)?.locked), handle.dataset.handle);
  if (handle && B.sel.length === 1) return resize(e, B.sel[0], handle.dataset.handle);
  if (B.tool === "frame" || B.tool === "rect" || B.tool === "text") return create(e);
  const label = e.target.closest?.("[data-label]");
  if (label) {
    const id = label.dataset.label;
    if (e.shiftKey) select(id, { toggle: true });
    else if (!B.sel.includes(id)) select(id);
    return moveLayers(e, B.sel.slice());
  }
  const hit = e.target.closest?.("[data-bid]");
  if (!hit) return marquee(e, null);
  if (hit.dataset.lod === "1" && (e.metaKey || e.ctrlKey)) {
    const cx = e.clientX, cy = e.clientY;
    ensureLiveRoots([hit.dataset.bid]);
    requestAnimationFrame(() => {
      const deep = document.elementFromPoint(cx, cy)?.closest?.("[data-bid]");
      const picked = deep ? deepestFor(deep.dataset.bid) : hit.dataset.bid;
      if (picked) select(picked);
    });
    return;
  }
  const id = pickFor(e, hit.dataset.bid);
  if (!id) return marquee(e, null);
  const n = node(id);
  // A press on an artboard's own background: click selects it, a drag selects what's inside.
  if (!n.parent && hit.dataset.bid === id && !B.sel.includes(id) && !e.shiftKey) return marquee(e, id);
  if (e.shiftKey) {
    select(id, { toggle: true });
    return;
  }
  if (!B.sel.includes(id)) select(id);
  if (n.locked) return;
  moveLayers(e, B.sel.filter((x) => !node(x)?.locked));
}

function marquee(e, root) {
  const c = canvasEl.current.getBoundingClientRect();
  const keep = e.shiftKey ? B.sel.slice() : [];
  if (!e.shiftKey && !root) select([]);
  drag(e, {
    kind: "marquee",
    move: (ev) => {
      const r = { x: Math.min(e.clientX, ev.clientX) - c.left, y: Math.min(e.clientY, ev.clientY) - c.top, width: Math.abs(ev.clientX - e.clientX), height: Math.abs(ev.clientY - e.clientY) };
      const candidates = root ? node(root).children ?? [] : currentPage().children;
      const hits = candidates.filter((id) => {
        const n = node(id);
        if (!n || n.hidden || n.locked) return false;
        const b = screenBox(id);
        return b && b.x < r.x + r.width && b.x + b.width > r.x && b.y < r.y + r.height && b.y + b.height > r.y;
      });
      B.drop = { kind: "marquee", rect: r };
      select([...new Set([...keep, ...hits])]);
    },
    up: (ev, moved) => {
      bset({ drop: null });
      if (!moved && root) select(root);
    },
  });
}

/** Where a free layer's left and top are now, in its parent's terms (measured if not written). */
export function placeOf(id) {
  const n = node(id);
  const l = pxValue(n.style.left);
  const t = pxValue(n.style.top);
  if (l !== undefined && t !== undefined) return { left: l, top: t };
  const me = worldBox(id);
  const p = n.parent ? worldBox(n.parent) : { x: 0, y: 0 };
  const pel = n.parent ? elOf(n.parent) : null;
  const cs = pel ? getComputedStyle(pel) : null;
  return { left: l ?? round(me.x - p.x - (cs ? parseFloat(cs.borderLeftWidth) || 0 : 0)), top: t ?? round(me.y - p.y - (cs ? parseFloat(cs.borderTopWidth) || 0 : 0)) };
}

const SNAP = 6;

// ---------------------------------------------------------------------------------------------
// A vector's parts: moved and resized in their own coordinates (see vectorFit in the core).

const isVector = (id) => node(id)?.type === "vector";

/**
 * How a vector part's coordinates sit on screen, measured once at the start of a drag: boxes in
 * client px turned into its own coordinates (`local`) or its parent's (`outer`, where its transform is written).
 */
export function vectorSpace(id) {
  const el = elOf(id);
  const svg = el?.ownerSVGElement;
  const ctm = el?.getCTM?.();
  if (!el || !svg || !ctm) return null;
  const sr = svg.getBoundingClientRect();
  const k = sr.width / (svg.clientWidth || sr.width / B.view.z || 1);
  const M = (m) => new DOMMatrix([m.a, m.b, m.c, m.d, m.e, m.f]);
  const toLocal = M(ctm).inverse();
  const own = el.transform?.baseVal?.consolidate?.()?.matrix;
  const toOuter = own ? M(ctm).multiply(M(own).inverse()).inverse() : toLocal;
  const map = (m, b) => {
    const pts = [
      [b.x, b.y],
      [b.x + b.width, b.y],
      [b.x, b.y + b.height],
      [b.x + b.width, b.y + b.height],
    ].map(([x, y]) => new DOMPoint((x - sr.left) / k, (y - sr.top) / k).matrixTransform(m));
    const xs = pts.map((p) => p.x);
    const ys = pts.map((p) => p.y);
    return { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };
  };
  const r = el.getBoundingClientRect();
  return { from: { x: r.left, y: r.top, width: r.width, height: r.height }, local: (b) => map(toLocal, b), outer: (b) => map(toOuter, b) };
}

/** The step that takes a vector part from its box on screen (client px) to another. */
export function vectorStep(n, space, to) {
  const fit = vectorFit(n, space.local(space.from), space.local(to));
  if (fit) return { op: "set", id: n.id, attrs: fit.attrs, ...(fit.tag ? { tag: fit.tag } : {}) };
  return { op: "set", id: n.id, attrs: { transform: vectorTransform(n.attrs?.transform, space.outer(space.from), space.outer(to)) } };
}

/** Steps that move layers by dx, dy board units: vector parts by their coordinates, the rest by left and top. */
export function shiftSteps(ids, dx, dy) {
  const z = B.view.z;
  return ids
    .map((id) => {
      const n = node(id);
      if (!n) return null;
      if (n.type === "vector") {
        const sp = vectorSpace(id);
        return sp && vectorStep(n, sp, { ...sp.from, x: sp.from.x + dx * z, y: sp.from.y + dy * z });
      }
      const at = placeOf(id);
      return { op: "set", id, style: { left: `${Math.round(at.left + dx)}px`, top: `${Math.round(at.top + dy)}px`, ...(n.parent && n.style.position !== "absolute" && n.style.position !== "fixed" ? { position: "absolute" } : {}) } };
    })
    .filter(Boolean);
}

/** Drag vector parts (and anything else picked with them) by the pointer. */
function moveVectors(e, ids) {
  const base = B.board;
  const z = B.view.z;
  const spaces = Object.fromEntries(ids.filter(isVector).map((id) => [id, vectorSpace(id)]).filter(([, sp]) => sp));
  const starts = Object.fromEntries(ids.filter((id) => !isVector(id) && !inFlow(base, id)).map((id) => [id, placeOf(id)]));
  let ops = [];
  drag(e, {
    kind: "move",
    move: (ev) => {
      const dx = ev.clientX - e.clientX;
      const dy = ev.clientY - e.clientY;
      ops = [
        ...Object.entries(spaces).map(([id, sp]) => vectorStep(base.nodes[id], sp, { ...sp.from, x: sp.from.x + dx, y: sp.from.y + dy })),
        ...Object.entries(starts).map(([id, at]) => ({ op: "set", id, style: { left: `${Math.round(at.left + dx / z)}px`, top: `${Math.round(at.top + dy / z)}px` } })),
      ];
      preview(base, ops);
    },
    up: (ev, moved) => {
      if (!moved || !ops.length) return notify();
      B.board = base;
      commit(ops, { label: "Move" });
    },
  });
}

function moveLayers(e, ids) {
  if (!ids.length) return;
  const base = B.board;
  const z = B.view.z;
  if (ids.some(isVector)) return moveVectors(e, ids);
  // One layer placed by its frame's flex layout is moved among its siblings instead.
  if (ids.length === 1 && inFlow(base, ids[0])) return reorder(e, ids[0]);
  const free = ids.filter((id) => !inFlow(base, id));
  const starts = Object.fromEntries(free.map((id) => [id, placeOf(id)]));
  // Edges to snap to: the other artboards (for artboards), else the parent's edges and centre.
  const lone = free.length === 1 ? free[0] : null;
  const loneBox = lone ? worldBox(lone) : null;
  const targets = { x: [], y: [] };
  if (lone) {
    const others = node(lone).parent ? [node(lone).parent] : currentPage().children.filter((x) => x !== lone);
    for (const o of others) {
      const b = worldBox(o);
      if (!b) continue;
      targets.x.push(b.x, b.x + b.width / 2, b.x + b.width);
      targets.y.push(b.y, b.y + b.height / 2, b.y + b.height);
    }
    for (const s of node(node(lone).parent ?? "")?.children ?? []) {
      if (s === lone) continue;
      const b = worldBox(s);
      if (!b) continue;
      targets.x.push(b.x, b.x + b.width);
      targets.y.push(b.y, b.y + b.height);
    }
  }
  let ops = [];
  drag(e, {
    kind: "move",
    move: (ev) => {
      let dx = (ev.clientX - e.clientX) / z;
      let dy = (ev.clientY - e.clientY) / z;
      const guides = [];
      if (loneBox && !ev.metaKey) {
        const snap = (pos, size, list) => {
          let best = null;
          for (const t of list)
            for (const [k, edge] of [[0, pos], [0.5, pos + size / 2], [1, pos + size]]) {
              const d = t - edge;
              if (Math.abs(d) * z <= SNAP && (!best || Math.abs(d) < Math.abs(best.d))) best = { d, t, k };
            }
          return best;
        };
        const sx = snap(loneBox.x + dx, loneBox.width, targets.x);
        const sy = snap(loneBox.y + dy, loneBox.height, targets.y);
        if (sx) dx += sx.d;
        if (sy) dy += sy.d;
        const c = canvasEl.current.getBoundingClientRect();
        const { x, y } = B.view;
        if (sx) guides.push({ axis: "x", at: sx.t * z + x, from: 0, to: c.height });
        if (sy) guides.push({ axis: "y", at: sy.t * z + y, from: 0, to: c.width });
      }
      dx = Math.round(dx);
      dy = Math.round(dy);
      ops = free.map((id) => ({ op: "set", id, style: { left: `${starts[id].left + dx}px`, top: `${starts[id].top + dy}px` } }));
      B.guides = guides;
      preview(base, ops);
    },
    up: (ev, moved) => {
      B.guides = [];
      if (!moved || !ops.length) return notify();
      B.board = base;
      commit(ops, { label: "Move" });
    },
  });
}

/**
 * Drag a layer along its flex frame: a line shows where it will go. Taken out past the frame's edge,
 * it goes into whichever frame it's over (at the pointer, if that frame isn't a flex one).
 */
function reorder(e, id) {
  const n = node(id);
  const el = elOf(id);
  el?.classList.add("bd-dragging");
  const c = canvasEl.current.getBoundingClientRect();
  let target = null;
  const kind = "move";
  const inside = (box, ev) => box && ev.clientX - c.left >= box.x && ev.clientX - c.left <= box.x + box.width && ev.clientY - c.top >= box.y && ev.clientY - c.top <= box.y + box.height;
  drag(e, {
    kind,
    move: (ev) => {
      let frameId = n.parent;
      if (!inside(screenBox(n.parent), ev)) {
        const f = frameAt(ev.clientX, ev.clientY, id);
        if (f) frameId = f;
      }
      const frame = node(frameId);
      // Over a grid: the cell under the pointer.
      if (isGrid(frame)) {
        const drop = gridDrop(frameId, ev.clientX, ev.clientY, id);
        target = drop && { grid: drop };
        return bset({ drop: drop ? { grid: frameId, cell: drop.rect, into: frameId !== n.parent ? frameId : null } : null });
      }
      if (!isFlex(frame)) {
        target = { parent: frameId, at: toWorld(ev.clientX, ev.clientY) };
        return bset({ drop: { into: frameId } });
      }
      const fRow = !(frame.style.flexDirection ?? "row").startsWith("column");
      const kids = (frame.children ?? []).filter((x) => x !== id && !node(x)?.hidden);
      const p = fRow ? ev.clientX - c.left : ev.clientY - c.top;
      let index = kids.length;
      let line = null;
      for (let i = 0; i < kids.length; i++) {
        const r = screenBox(kids[i]);
        if (r && p < (fRow ? r.x + r.width / 2 : r.y + r.height / 2)) {
          index = i;
          line = fRow ? { x: r.x - 2, y: r.y, width: 3, height: r.height } : { x: r.x, y: r.y - 2, width: r.width, height: 3 };
          break;
        }
      }
      if (!line) {
        const last = kids.length ? screenBox(kids[kids.length - 1]) : null;
        const fr = screenBox(frameId);
        line = last ? (fRow ? { x: last.x + last.width, y: last.y, width: 3, height: last.height } : { x: last.x, y: last.y + last.height, width: last.width, height: 3 }) : fr && { x: fr.x + 4, y: fr.y + 4, width: fRow ? 3 : fr.width - 8, height: fRow ? fr.height - 8 : 3 };
      }
      // Its index among all the frame's layers (hidden ones count too).
      const all = (frame.children ?? []).filter((x) => x !== id);
      target = { parent: frameId, index: index < kids.length ? all.indexOf(kids[index]) : all.length };
      bset({ drop: { line, into: frameId !== n.parent ? frameId : null } });
    },
    up: (ev, moved) => {
      el?.classList.remove("bd-dragging");
      bset({ drop: null });
      if (!moved || !target) return;
      if (target.grid) return commit(gridDropOps(target.grid, id), { label: "Move" });
      if (target.at) {
        // Into a frame laid out by hand: it sits where it was dropped.
        const fb = worldBox(target.parent);
        const me = worldBox(id);
        const ops = [{ op: "move", id, parent: target.parent }, { op: "set", id, style: { position: "absolute", left: `${Math.round(target.at.x - fb.x - me.width / 2)}px`, top: `${Math.round(target.at.y - fb.y - me.height / 2)}px` } }];
        if (!node(target.parent).style.position) ops.push({ op: "set", id: target.parent, style: { position: "relative" } });
        return commit([...ops, ...leaveGridOps(id, target.parent)], { label: "Move" });
      }
      const was = (node(n.parent).children ?? []).indexOf(id);
      if (target.parent === n.parent && target.index === was) return;
      commit([{ op: "move", id, parent: target.parent, index: target.index }, ...leaveGridOps(id, target.parent)], { label: "Move" });
    },
  });
}

/** A box on screen (client px) after dragging handle `h` by dx, dy, as drag-resizing makes it. */
function resized(b, h, dx, dy, keep) {
  let w = b.width + (h.includes("e") ? dx : h.includes("w") ? -dx : 0);
  let hh = b.height + (h.includes("s") ? dy : h.includes("n") ? -dy : 0);
  if (keep) {
    const k = Math.abs(w / Math.max(1e-6, b.width) - 1) > Math.abs(hh / Math.max(1e-6, b.height) - 1) ? w / Math.max(1e-6, b.width) : hh / Math.max(1e-6, b.height);
    w = b.width * k;
    hh = b.height * k;
  }
  w = Math.max(1, w);
  hh = Math.max(1, hh);
  return { x: h.includes("w") ? b.x + b.width - w : b.x, y: h.includes("n") ? b.y + b.height - hh : b.y, width: w, height: hh };
}

function resizeVector(e, id, h, keep = false) {
  const base = B.board;
  const sp = vectorSpace(id);
  if (!sp) return;
  let ops = [];
  drag(e, {
    threshold: 0,
    kind: "resize",
    move: (ev) => {
      ops = [vectorStep(base.nodes[id], sp, resized(sp.from, h, ev.clientX - e.clientX, ev.clientY - e.clientY, keep || (ev.shiftKey && h.length === 2)))];
      preview(base, ops);
    },
    up: (ev, moved) => {
      if (!moved || !ops.length) return;
      B.board = base;
      commit(ops, { label: "Resize" });
    },
  });
}

function resize(e, id, h, keep = false) {
  e.stopPropagation();
  if (isVector(id)) return resizeVector(e, id, h, keep);
  // In a grid: across its cells, a layer's span changes.
  if (!keep && inGrid(id) && resizeInGrid(e, id, h)) return;
  const base = B.board;
  const n = node(id);
  const box0 = worldBox(id);
  const free = !inFlow(base, id);
  const start = free ? placeOf(id) : null;
  const z = B.view.z;
  const ratio = box0.width / Math.max(1, box0.height);
  const parent = n.parent ? node(n.parent) : null;
  const parentRow = parent && isFlex(parent) && !(parent.style.flexDirection ?? "row").startsWith("column");
  let ops = [];
  drag(e, {
    threshold: 0,
    kind: "resize",
    move: (ev) => {
      const dx = (ev.clientX - e.clientX) / z;
      const dy = (ev.clientY - e.clientY) / z;
      let w = box0.width + (h.includes("e") ? dx : h.includes("w") ? -dx : 0);
      let hh = box0.height + (h.includes("s") ? dy : h.includes("n") ? -dy : 0);
      if (ev.shiftKey && h.length === 2) {
        if (Math.abs(dx) > Math.abs(dy)) hh = w / ratio;
        else w = hh * ratio;
      }
      w = Math.max(1, Math.round(w));
      hh = Math.max(1, Math.round(hh));
      const style = {};
      if (h.includes("e") || h.includes("w") || ev.shiftKey) {
        style.width = `${w}px`;
        // A layer that filled its row stops growing once it has a width of its own.
        if (parentRow && !free) Object.assign(style, { flexGrow: null, flexBasis: null, flex: null });
        if (parent && !parentRow && !free && n.style.alignSelf === "stretch") style.alignSelf = null;
      }
      if (h.includes("n") || h.includes("s") || ev.shiftKey) {
        style.height = `${hh}px`;
        if (parent && !parentRow && isFlex(parent) && !free) Object.assign(style, { flexGrow: null, flexBasis: null, flex: null });
      }
      if (free) {
        if (h.includes("w")) style.left = `${Math.round(start.left + box0.width - w)}px`;
        if (h.includes("n")) style.top = `${Math.round(start.top + box0.height - hh)}px`;
      }
      ops = [{ op: "set", id, style }];
      preview(base, ops);
    },
    up: (ev, moved) => {
      if (!moved || !ops.length) return;
      B.board = base;
      commit(ops, { label: "Resize" });
    },
  });
}

/** Resize several layers as one: each keeps its place and share of the box they make together. */
function resizeMany(e, ids, h, keep = false) {
  e.stopPropagation();
  const base = B.board;
  const top = ids.filter((id) => !ancestors(base, id).some((a) => ids.includes(a)));
  const boxes = Object.fromEntries(top.map((id) => [id, worldBox(id)]).filter(([, b]) => b));
  const list = Object.keys(boxes);
  if (!list.length) return;
  const g = unionOf(Object.values(boxes));
  const starts = Object.fromEntries(list.filter((id) => !inFlow(base, id) && !isVector(id)).map((id) => [id, placeOf(id)]));
  const spaces = Object.fromEntries(list.filter(isVector).map((id) => [id, vectorSpace(id)]).filter(([, sp]) => sp));
  const z = B.view.z;
  let ops = [];
  drag(e, {
    threshold: 0,
    kind: "resize",
    move: (ev) => {
      const dx = (ev.clientX - e.clientX) / z;
      const dy = (ev.clientY - e.clientY) / z;
      let w = Math.max(4, g.width + (h.includes("e") ? dx : h.includes("w") ? -dx : 0));
      let hh = Math.max(4, g.height + (h.includes("s") ? dy : h.includes("n") ? -dy : 0));
      if (keep || ev.shiftKey) {
        const k = Math.abs(w / g.width - 1) > Math.abs(hh / g.height - 1) ? w / g.width : hh / g.height;
        w = g.width * k;
        hh = g.height * k;
      }
      const sx = w / g.width;
      const sy = hh / g.height;
      const gx = h.includes("w") ? g.x + g.width - w : g.x;
      const gy = h.includes("n") ? g.y + g.height - hh : g.y;
      ops = list.map((id) => {
        const b = boxes[id];
        const n = node(id);
        if (n.type === "vector") {
          const sp = spaces[id];
          if (!sp) return null;
          // Its box in the group's new box, on screen.
          const nb = { x: gx + (b.x - g.x) * sx, y: gy + (b.y - g.y) * sy, width: b.width * sx, height: b.height * sy };
          const c = canvasEl.current.getBoundingClientRect();
          const { x: vx, y: vy } = B.view;
          return vectorStep(base.nodes[id], sp, { x: c.left + vx + nb.x * z, y: c.top + vy + nb.y * z, width: nb.width * z, height: nb.height * z });
        }
        const style = {};
        if (sx !== 1) style.width = `${Math.max(1, Math.round(b.width * sx))}px`;
        if (sy !== 1 && n.type !== "text") style.height = `${Math.max(1, Math.round(b.height * sy))}px`;
        if (starts[id]) {
          style.left = `${Math.round(starts[id].left + gx + (b.x - g.x) * sx - b.x)}px`;
          style.top = `${Math.round(starts[id].top + gy + (b.y - g.y) * sy - b.y)}px`;
        }
        return { op: "set", id, style };
      }).filter(Boolean);
      preview(base, ops);
    },
    up: (ev, moved) => {
      if (!moved || !ops.length) return;
      B.board = base;
      commit(ops, { label: "Resize" });
    },
  });
}

// ---------------------------------------------------------------------------------------------
// Scale (K): the selection made bigger or smaller with everything in it, type, padding, corners,
// borders and shadows too, as Figma's Scale tool does. Resizing only changes the box.

/** What a layer inherits that a scale has to carry, as drawn: its font size and letter spacing. */
function inheritedOf(id) {
  const el = elOf(id);
  if (!el) return {};
  const cs = getComputedStyle(el);
  const ls = parseFloat(cs.letterSpacing);
  return { fontSize: parseFloat(cs.fontSize) || undefined, letterSpacing: Number.isFinite(ls) && ls ? ls : undefined };
}

/**
 * Scaling the layers as they are now: `to(k, anchor)` shows them `k` times their size, the point of
 * their box at `anchor` ([0, 0] the top left, [0.5, 0.5] the centre) staying where it is; `done()`
 * keeps the last one as a step of undo. Layers in a layout keep their place in it.
 */
export function scalePlan(ids) {
  const base = B.board;
  const top = ids.filter((id) => base.nodes[id] && !ancestors(base, id).some((a) => ids.includes(a)));
  const boxes = Object.fromEntries(top.map((id) => [id, worldBox(id)]).filter(([, b]) => b && b.width > 0 && b.height > 0));
  const list = Object.keys(boxes);
  const g = list.length ? unionOf(Object.values(boxes)) : null;
  const starts = Object.fromEntries(list.filter((id) => !inFlow(base, id)).map((id) => [id, placeOf(id)]));
  const measured = Object.fromEntries(list.map((id) => [id, inheritedOf(id)]));
  let ops = [];
  return {
    box: g,
    to(k, [ax, ay] = [0, 0]) {
      if (!g) return;
      k = Math.max(0.01, k);
      const px = g.x + g.width * ax;
      const py = g.y + g.height * ay;
      ops = [];
      for (const id of list) {
        ops.push(...scaleOps(base, id, k, measured[id]));
        const s = starts[id];
        if (!s) continue;
        const b = boxes[id];
        ops.push({ op: "set", id, style: { left: `${round(s.left + px + (b.x - px) * k - b.x, 2)}px`, top: `${round(s.top + py + (b.y - py) * k - b.y, 2)}px` } });
      }
      B.scaling = k;
      preview(base, ops);
    },
    done() {
      B.scaling = null;
      if (!ops.length) return notify();
      B.board = base;
      commit(ops, { label: "Scale" });
    },
  };
}

/** Drag a handle with the Scale tool: in proportion, the opposite side staying put (⌥: the centre). */
function scaleDrag(e, ids, h) {
  e.stopPropagation();
  // A vector's parts live in their SVG's own coordinates: they resize, in proportion.
  if (ids.some(isVector)) return ids.length === 1 ? resize(e, ids[0], h, true) : resizeMany(e, ids, h, true);
  const plan = scalePlan(ids);
  const g = plan.box;
  if (!g) return;
  const own = ids.length === 1 ? pxValue(node(ids[0])?.style.width) : undefined;
  const z = B.view.z;
  drag(e, {
    threshold: 0,
    kind: "scale",
    move: (ev) => {
      const both = ev.altKey ? 2 : 1;
      const kx = (g.width + both * (h.includes("e") ? 1 : h.includes("w") ? -1 : 0) * ((ev.clientX - e.clientX) / z)) / g.width;
      const ky = (g.height + both * (h.includes("s") ? 1 : h.includes("n") ? -1 : 0) * ((ev.clientY - e.clientY) / z)) / g.height;
      const byX = h.length === 2 ? Math.abs(kx - 1) > Math.abs(ky - 1) : h === "e" || h === "w";
      // Whole pixels: the width its CSS gives it, or else the side being dragged.
      const k = own ? Math.round(own * (byX ? kx : ky)) / own : byX ? Math.round(g.width * kx) / g.width : Math.round(g.height * ky) / g.height;
      const anchor = ev.altKey ? [0.5, 0.5] : [h.includes("w") ? 1 : h.includes("e") ? 0 : 0.5, h.includes("n") ? 1 : h.includes("s") ? 0 : 0.5];
      plan.to(k, anchor);
    },
    up: (ev, moved) => (moved ? plan.done() : (B.scaling = null)),
  });
}

// ---------------------------------------------------------------------------------------------
// Drawing new layers

/** The frame a point is over (its deepest frame, not `except` or inside it), or null for the page. */
function frameAt(clientX, clientY, except) {
  const hits = document.elementsFromPoint(clientX, clientY);
  for (const el of hits) {
    const h = el.closest?.("[data-bid]");
    if (!h || !h.closest(".bd-world")) continue;
    let id = h.dataset.bid;
    // Nothing goes into a component's copy (only its component changes it): what's drawn or
    // dropped on one lands beside it, in the frame holding the copy.
    const copy = instanceRootOf(B.board, id);
    if (copy) id = node(copy)?.parent;
    while (id && (node(id)?.type !== "frame" || id === except || (except && ancestors(B.board, id).includes(except)))) id = node(id)?.parent;
    if (id && !node(id)?.locked) return id;
  }
  return null;
}

let counter = { frame: 0, rect: 0, text: 0 };

function create(e) {
  const tool = B.tool;
  const c = canvasEl.current.getBoundingClientRect();
  const p0 = toWorld(e.clientX, e.clientY);
  const into = frameAt(e.clientX, e.clientY);
  let rect = null;
  drag(e, {
    threshold: 2,
    kind: "draw",
    move: (ev) => {
      rect = { x: Math.min(e.clientX, ev.clientX) - c.left, y: Math.min(e.clientY, ev.clientY) - c.top, width: Math.abs(ev.clientX - e.clientX), height: Math.abs(ev.clientY - e.clientY) };
      bset({ drop: { kind: "draw", rect, into } });
    },
    up: (ev, moved) => {
      bset({ drop: null });
      const p1 = toWorld(ev.clientX, ev.clientY);
      const dragged = moved && rect && rect.width > 3 && rect.height > 3;
      const w = dragged ? Math.round(Math.abs(p1.x - p0.x)) : null;
      const h = dragged ? Math.round(Math.abs(p1.y - p0.y)) : null;
      const origin = { x: Math.round(Math.min(p0.x, p1.x)), y: Math.round(Math.min(p0.y, p1.y)) };
      const id = newId();
      let layer;
      if (tool === "text") {
        layer = { id, type: "text", name: "Text", parent: null, style: { fontSize: "16px", ...(into ? {} : { color: "#111111", fontFamily: "Inter, system-ui, sans-serif" }), ...(w ? { width: `${w}px` } : {}) }, text: "Text" };
      } else if (tool === "rect") {
        layer = { id, type: "frame", name: `Rectangle ${++counter.rect}`, parent: null, style: { width: `${w ?? 120}px`, height: `${h ?? 120}px`, backgroundColor: "#d9d9de", flexShrink: "0" }, children: [] };
      } else {
        const artboard = !into;
        layer = { id, type: "frame", name: artboard ? `Artboard ${++counter.frame}` : `Frame ${++counter.frame}`, parent: null, style: { display: "flex", flexDirection: "column", width: `${w ?? (artboard ? 390 : 160)}px`, height: `${h ?? (artboard ? 844 : 120)}px`, ...(artboard ? { backgroundColor: "#ffffff", overflow: "hidden" } : { flexShrink: "0" }) }, children: [] };
      }
      placeNew([layer], into, origin, ev);
      bset({ tool: "move" });
      if (tool === "text") startTextEdit(id);
    },
  });
}

/**
 * Put new layers (made with no parent) into a frame or on the page, at a point in board units: in a
 * flex frame they join its layout where the point is; elsewhere they sit at the point.
 */
export function placeNew(layers, into, at, ev) {
  const nodes = {};
  const tops = [];
  for (const l of layers) {
    nodes[l.id] = l;
    if (!l.parent) tops.push(l.id);
  }
  const ops = [];
  if (!into) {
    for (const id of tops) Object.assign(nodes[id].style, { left: `${Math.round(at.x)}px`, top: `${Math.round(at.y)}px` });
    ops.push({ op: "add", nodes, ids: tops, parent: null, page: currentPage().id });
  } else {
    const f = node(into);
    for (const id of tops) nodes[id] = { ...nodes[id], parent: into };
    if (isGrid(f)) {
      // In a grid: the cell under the point, for the first of them; the rest follow it.
      const spot = gridAddPlace(into, ev);
      for (const id of tops) intoGridStyle(nodes[id].style);
      if (spot) patchStyle(nodes[tops[0]].style, spot.style);
      ops.push({ op: "add", nodes, ids: tops, parent: into, index: spot?.reorder ? spot.index : undefined });
    } else if (isFlex(f)) {
      // Where among its layers the point falls.
      const row = !(f.style.flexDirection ?? "row").startsWith("column");
      const c = canvasEl.current.getBoundingClientRect();
      const px = ev ? (row ? ev.clientX - c.left : ev.clientY - c.top) : Infinity;
      let index = (f.children ?? []).length;
      (f.children ?? []).some((k, i) => {
        const r = screenBox(k);
        if (r && px < (row ? r.x + r.width / 2 : r.y + r.height / 2)) {
          index = i;
          return true;
        }
        return false;
      });
      ops.push({ op: "add", nodes, ids: tops, parent: into, index });
    } else {
      const fb = worldBox(into);
      const cs = getComputedStyle(elOf(into));
      for (const id of tops) Object.assign(nodes[id].style, { position: "absolute", left: `${Math.round(at.x - fb.x - (parseFloat(cs.borderLeftWidth) || 0))}px`, top: `${Math.round(at.y - fb.y - (parseFloat(cs.borderTopWidth) || 0))}px` });
      if (!f.style.position) ops.push({ op: "set", id: into, style: { position: "relative" } });
      ops.push({ op: "add", nodes, ids: tops, parent: into });
    }
  }
  if (commit(ops, { label: "Add" }) === false) return;
  select(tops);
  return tops;
}

// ---------------------------------------------------------------------------------------------
// Double-click and right-click

function dblclick(e) {
  if (!picking()) return;
  const hit = e.target.closest?.("[data-bid]");
  const label = e.target.closest?.("[data-label]");
  if (label) return bset({ renaming: label.dataset.label });
  if (!hit) return;
  if (hit.dataset.lod === "1") {
    const cx = e.clientX, cy = e.clientY;
    ensureLiveRoots([hit.dataset.bid]);
    requestAnimationFrame(() => {
      const deep = document.elementFromPoint(cx, cy)?.closest?.("[data-bid]");
      const target = deep ? deepestFor(deep.dataset.bid) : hit.dataset.bid;
      if (!target) return;
      select(target);
      if (node(target)?.type === "text") startTextEdit(target);
    });
    return;
  }
  // Straight to the deepest layer under the pointer, past every frame holding it (and into its words, if it's text).
  const target = deepestFor(hit.dataset.bid);
  if (!target) return;
  select(target);
  if (node(target)?.type === "text") startTextEdit(target);
}

function contextMenu(e) {
  e.preventDefault();
  const hit = e.target.closest?.("[data-bid]");
  const label = e.target.closest?.("[data-label]");
  const id = label ? label.dataset.label : hit ? pickFor(e, hit.dataset.bid) : null;
  if (id && !B.sel.includes(id)) select(id);
  openLayerMenu(e.clientX, e.clientY, { at: toWorld(e.clientX, e.clientY), stack: layersAt(e.clientX, e.clientY) });
}

async function dropFiles(e) {
  e.preventDefault();
  const asset = e.dataTransfer?.getData("text/x-board-asset");
  if (asset) {
    const { addAsset } = await import("./board-assets.js");
    return addAsset(JSON.parse(asset), { at: toWorld(e.clientX, e.clientY), into: frameAt(e.clientX, e.clientY), ev: e });
  }
  // A .fig file: its frames beside the artboards on this board.
  const fig = [...(e.dataTransfer?.files ?? [])].find((f) => /\.fig$/i.test(f.name));
  if (fig) return import("./imports.js").then((m) => m.importFigFile(fig, { board: B.id })).catch((err) => import("./store.js").then((st) => st.fail(err, "Couldn't bring the Figma file in")));
  const { addImages, isMedia } = await import("./board.js");
  const files = [...(e.dataTransfer?.files ?? [])].filter(isMedia);
  if (!files.length) return;
  addImages(files, { at: toWorld(e.clientX, e.clientY), into: frameAt(e.clientX, e.clientY), ev: e });
}

