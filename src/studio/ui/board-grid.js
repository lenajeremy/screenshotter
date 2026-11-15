// Grids on boards: a frame laid out by CSS grid, edited as a design tool edits one. Turning a frame
// into a grid (and back), changing its tracks, and what the canvas draws over one: its tracks, gaps
// and lines, a header for each track (its size on hover, a menu on click), + at the edges to add a
// track, lines to drag between tracks, the cell a dragged layer will land in, and spans changed by
// dragging a layer's edge across cells.
import { useEffect, useState } from "preact/hooks";
import { GRID_CHILD_KEYS, GRID_FRAME_KEYS, ancestors, areaRects, autoPlace, flexToGrid, gapCss, gridAlign, gridOf, gridPatch, inFlow, isFlex, isGrid, newId, parsePlacement, placementCss, placementSpan, planGrid, pxValue, round, siblingsOf, sizeWord, trackKind, trackLabel, tracksCss } from "./board-core.js";
import { B, bset, commit, currentPage, node, notify, preview, select } from "./board-state.js";
import { canvasEl, elOf, worldBox } from "./board-canvas.js";
import { html } from "./controls.js";
import { Icon } from "./icons.js";
import { openMenu } from "./menu.js";
import { toast } from "./store.js";
import { setFlex } from "./board.js";

const sel = () => B.sel.filter((id) => node(id));
const absolute = (n) => n?.style.position === "absolute" || n?.style.position === "fixed";
const px = (v) => `${Math.round(v)}px`;
const nulls = (keys) => Object.fromEntries(keys.map((k) => [k, null]));
/** What a layer loses when it stops being placed by hand or by flex. */
const UNPLACED = { position: null, left: null, top: null, right: null, bottom: null, flexGrow: null, flexShrink: null, flexBasis: null, flex: null, order: null };

/** How a frame lays out its layers: "free" (where they're put), "flex" or "grid". */
export const layoutOf = (n) => (isGrid(n) ? "grid" : isFlex(n) ? "flex" : "free");

/** A grid frame's layers that it places (not hidden, not placed by hand). */
export const gridKids = (id) => (node(id)?.children ?? []).filter((c) => node(c) && !node(c).hidden && !absolute(node(c)));

/** Whether a layer is placed by its parent's grid. */
export const inGrid = (id) => {
  const n = node(id);
  return Boolean(n?.parent && isGrid(node(n.parent)) && !absolute(n));
};

/** Where a frame's content starts (inside its border and padding), in board units. */
function contentOrigin(id) {
  const fb = worldBox(id);
  const el = elOf(id);
  if (!fb || !el) return null;
  const cs = getComputedStyle(el);
  const f = (v) => parseFloat(v) || 0;
  return { x: fb.x + f(cs.borderLeftWidth) + f(cs.paddingLeft), y: fb.y + f(cs.borderTopWidth) + f(cs.paddingTop) };
}

/** Steps that put `order` first in a frame's list of layers, in that order. */
function orderOps(id, order) {
  let list = (node(id)?.children ?? []).slice();
  const ops = [];
  order.forEach((c, k) => {
    if (list[k] === c) return;
    list = list.filter((x) => x !== c);
    list.splice(k, 0, c);
    ops.push({ op: "move", id: c, parent: id, index: k });
  });
  return ops;
}

const hiddenFrame = () => toast({ kind: "info", title: "Show the frame first", text: "Its layers are placed from where they're drawn, and a hidden frame isn't drawn." });

/**
 * Steps that make a frame a grid that looks as it did: a flex row or column by CSS (a column per
 * layer), anything else from where its layers are drawn (planGrid), in reading order.
 */
export function toGridOps(id) {
  const n = node(id);
  if (!n || n.type !== "frame" || isGrid(n)) return [];
  const flex = flexToGrid(B.board, id);
  if (flex) return [{ op: "set", id, style: flex.frame }, ...Object.entries(flex.children).map(([c, style]) => ({ op: "set", id: c, style }))];
  const o = contentOrigin(id);
  if (!o) return hiddenFrame(), null;
  const kids = (n.children ?? []).filter((c) => node(c));
  const items = kids
    .filter((c) => !node(c).hidden)
    .map((c) => {
      const b = worldBox(c);
      return b && { id: c, box: { ...b, x: b.x - o.x, y: b.y - o.y } };
    })
    .filter(Boolean);
  // An empty frame starts as 2 × 2 (rows share its height when it has one).
  if (!items.length) return [{ op: "set", id, style: { display: "grid", flexDirection: null, flexWrap: null, gridTemplateColumns: "repeat(2, 1fr)", gridTemplateRows: `repeat(2, ${newTrackSize(id, "rows")})`, ...(n.style.gap ? {} : { gap: "16px" }) } }];
  const plan = planGrid(items);
  const fixed = plan.columns.some((t) => t.endsWith("px"));
  const style = {
    display: "grid",
    flexDirection: null,
    flexWrap: null,
    justifyContent: fixed ? "start" : null,
    gridTemplateColumns: tracksCss({ tracks: plan.columns.map((size) => ({ size })) }),
    alignContent: "start",
    // Layers keep the size they had: a free layout's don't stretch to their row.
    alignItems: isFlex(n) ? gridAlign(n.style.alignItems) ?? null : "start",
    ...gapCss(`${plan.rowGap}px`, `${plan.columnGap}px`),
  };
  const ops = [{ op: "set", id, style }, ...orderOps(id, [...plan.order, ...kids.filter((c) => !plan.order.includes(c))])];
  for (const c of kids) {
    const cell = plan.cells[c];
    const place = cell
      ? {
          gridColumn: placementCss(plan.explicit ? { start: cell.column, span: cell.columnSpan } : { span: cell.columnSpan }),
          gridRow: placementCss(plan.explicit ? { start: cell.row, span: cell.rowSpan } : { span: cell.rowSpan }),
        }
      : {};
    ops.push({ op: "set", id: c, style: { ...UNPLACED, ...place } });
  }
  return ops;
}

/** Steps that lay a grid's layers out by hand (each where it's drawn) or with flex, in reading order. */
export function fromGridOps(id, to) {
  const n = node(id);
  const fb = worldBox(id);
  const el = elOf(id);
  if (!n || !fb || !el) return hiddenFrame(), null;
  const kids = (n.children ?? []).filter((c) => node(c));
  const boxes = Object.fromEntries(kids.map((c) => [c, worldBox(c)]));
  const clearFrame = nulls(GRID_FRAME_KEYS);
  const clearKid = nulls(GRID_CHILD_KEYS);
  const ops = [];
  if (to === "free") {
    const cs = getComputedStyle(el);
    const bl = parseFloat(cs.borderLeftWidth) || 0;
    const bt = parseFloat(cs.borderTopWidth) || 0;
    ops.push({ op: "set", id, style: { ...clearFrame, display: null, gap: null, justifyContent: null, alignItems: null, position: n.style.position ?? (n.parent ? "relative" : null), width: px(fb.width), height: px(fb.height) } });
    for (const c of kids) {
      const cb = boxes[c];
      if (!cb) continue;
      ops.push({ op: "set", id: c, style: { ...clearKid, alignSelf: null, position: "absolute", left: px(cb.x - fb.x - bl), top: px(cb.y - fb.y - bt), width: px(cb.width), height: node(c).type === "text" ? node(c).style.height ?? null : px(cb.height) } });
    }
    return ops;
  }
  const o = contentOrigin(id);
  const placed = kids.filter((c) => boxes[c] && !node(c).hidden && !absolute(node(c)));
  const plan = planGrid(placed.map((c) => ({ id: c, box: { ...boxes[c], x: boxes[c].x - o.x, y: boxes[c].y - o.y } })));
  const g = gridOf(n.style);
  const wrap = plan.rows.length > 1 && plan.columns.length > 1;
  const row = plan.rows.length <= 1 || wrap;
  const flexAlign = (v) => (v === "start" ? "flex-start" : v === "end" ? "flex-end" : v);
  const gap = wrap ? gapCss(g.rowGap, g.columnGap).gap : row ? g.columnGap || null : g.rowGap || null;
  ops.push({ op: "set", id, style: { ...clearFrame, display: "flex", flexDirection: row ? null : "column", flexWrap: wrap ? "wrap" : null, gap, alignItems: flexAlign(n.style.alignItems) ?? null, justifyContent: null } });
  ops.push(...orderOps(id, [...plan.order, ...kids.filter((c) => !plan.order.includes(c))]));
  for (const c of kids) {
    const k = node(c);
    const style = { ...clearKid };
    const fills = !k.style.width && sizeWord(B.board, c, "width") === "fill";
    if (row && boxes[c] && fills) Object.assign(style, wrap ? { width: px(boxes[c].width) } : { flexGrow: "1", flexBasis: "0px" });
    if (!row && k.style.justifySelf) style.alignSelf = flexAlign(gridAlign(k.style.justifySelf));
    else if (row && k.style.alignSelf) style.alignSelf = flexAlign(k.style.alignSelf);
    ops.push({ op: "set", id: c, style });
  }
  return ops;
}

/** Lay frames out by hand ("free"), with flex or as a grid: one step of undo. */
export function setLayout(ids, kind) {
  const frames = ids.filter((id) => node(id)?.type === "frame" && layoutOf(node(id)) !== kind);
  if (!frames.length) return;
  // Free and flex swap as they always have.
  if (kind !== "grid" && frames.every((id) => !isGrid(node(id)))) return frames.forEach((id) => setFlex(id, kind === "flex"));
  const ops = [];
  for (const id of frames) {
    const now = layoutOf(node(id));
    const more = kind === "grid" ? toGridOps(id) : now === "grid" ? fromGridOps(id, kind) : null;
    if (more === null && (kind === "grid" || now === "grid")) return;
    if (more) ops.push(...more);
    else if (now !== "grid") {
      // Free ↔ flex among frames being made grids too: flex on, measured by the same rules.
      ops.push({ op: "set", id, style: { display: kind === "flex" ? "flex" : null, flexDirection: kind === "flex" ? node(id).style.flexDirection ?? "column" : null } });
    }
  }
  commit(ops, { label: kind === "grid" ? "Grid" : kind === "flex" ? "Add flex" : "Free layout" });
}

/** ⇧G: the selected frame becomes a grid; anything else is wrapped in one. */
export function gridShortcut() {
  const s = sel();
  const one = s.length === 1 ? node(s[0]) : null;
  if (one?.type === "frame" && !isGrid(one)) return setLayout([one.id], "grid");
  if (one && isGrid(one)) return;
  wrapInGrid();
}

/** Put the selected layers (side by side in one frame) into a new grid that keeps them where they are. */
export function wrapInGrid() {
  const s = sel();
  const ids = s.filter((id) => !ancestors(B.board, id).some((a) => s.includes(a)));
  if (!ids.length) return;
  if (ids.some((id) => node(id).type === "vector")) return toast({ kind: "info", title: "Parts of a vector stay in their vector", text: "Group them instead (⌥⌘G)." });
  const parent = node(ids[0]).parent;
  if (ids.some((id) => node(id).parent !== parent)) return toast({ kind: "err", title: "Pick layers in the same frame", text: "Only layers side by side can go into one grid." });
  const sibs = siblingsOf(B.board, ids[0]);
  const ordered = sibs.filter((x) => ids.includes(x));
  const boxes = Object.fromEntries(ordered.map((x) => [x, worldBox(x)]));
  const drawn = ordered.filter((x) => boxes[x]);
  if (!drawn.length) return toast({ kind: "info", title: "Show the layers first", text: "Hidden layers have no place to wrap a grid round." });
  const minX = Math.min(...drawn.map((x) => boxes[x].x));
  const minY = Math.min(...drawn.map((x) => boxes[x].y));
  const plan = planGrid(drawn.map((x) => ({ id: x, box: { ...boxes[x], x: boxes[x].x - minX, y: boxes[x].y - minY } })));
  const id = newId();
  const flowing = parent && inFlow(B.board, ordered[0]);
  const style = { display: "grid", gridTemplateColumns: tracksCss({ tracks: plan.columns.map((size) => ({ size })) }), alignItems: "start" };
  const gaps = gapCss(`${plan.rowGap}px`, `${plan.columnGap}px`);
  if (gaps.gap) style.gap = gaps.gap;
  if (plan.columns.some((t) => t.endsWith("px"))) style.justifyContent = "start";
  if (!flowing) {
    const pb = parent ? worldBox(parent) : { x: 0, y: 0 };
    Object.assign(style, parent ? { position: "absolute" } : {}, { left: px(minX - pb.x), top: px(minY - pb.y) });
  }
  const ops = [{ op: "add", nodes: { [id]: { id, type: "frame", name: "Grid", parent, style, children: [] } }, ids: [id], parent, page: parent ? undefined : currentPage().id, index: sibs.indexOf(ordered[0]) }];
  [...plan.order, ...ordered.filter((x) => !plan.order.includes(x))].forEach((x, k) => {
    ops.push({ op: "move", id: x, parent: id, index: k });
    const cell = plan.cells[x];
    const place = cell ? { gridColumn: placementCss(plan.explicit ? { start: cell.column, span: cell.columnSpan } : { span: cell.columnSpan }), gridRow: placementCss(plan.explicit ? { start: cell.row, span: cell.rowSpan } : { span: cell.rowSpan }) } : {};
    ops.push({ op: "set", id: x, style: { ...UNPLACED, ...nulls(GRID_CHILD_KEYS), ...place } });
  });
  commit(ops, { label: "Wrap in grid" });
  select(id);
}

// ---------------------------------------------------------------------------------------------
// Tracks: added, removed, moved and resized. Layers placed by hand keep to their tracks (a column
// added before one moves it along), and named areas keep their shape.

export const AXES = {
  columns: { word: "column", Word: "Column", line: "gridColumn", before: "left", after: "right", Before: "Left", After: "Right" },
  rows: { word: "row", Word: "Row", line: "gridRow", before: "above", after: "below", Before: "Up", After: "Down" },
};

/** What a new row is: a share of the frame's height when it has one, else as tall as what's in it. */
const newTrackSize = (id, axis) => (axis === "columns" ? "1fr" : pxValue(node(id)?.style.height) !== undefined ? "1fr" : "auto");

/** Steps that move layers placed by hand (by number) along with their tracks: `map` takes a line (1-based) to its new number, or null when its track went. */
function followTracks(id, axis, map, widen) {
  const ops = [];
  const key = AXES[axis].line;
  for (const c of node(id)?.children ?? []) {
    const k = node(c);
    if (!k) continue;
    const p = parsePlacement(k.style[key]);
    if (typeof p.start !== "number" || p.start < 1) continue;
    const start = map(p.start);
    let span = placementSpan(p);
    if (widen) span = widen(p.start, span);
    const next = placementCss({ start: start ?? p.start, span: Math.max(1, span) });
    if (next !== k.style[key]) ops.push({ op: "set", id: c, style: { [key]: next } });
  }
  return ops;
}

/** Areas with a column (or row) of empty cells put in at `at`, or the one at `at` taken out. */
function areasWith(areas, axis, at, remove = false) {
  if (!areas) return areas;
  if (axis === "columns") return areas.map((r) => {
    const x = r.slice();
    if (remove) x.splice(at, 1);
    else x.splice(at, 0, ".");
    return x;
  });
  const x = areas.map((r) => r.slice());
  if (remove) x.splice(at, 1);
  else x.splice(at, 0, Array(areas[0]?.length ?? 1).fill("."));
  return x;
}

/** Steps that put a new track at `at` (0 = first) in a grid frame. */
export function insertTrackOps(id, axis, at, size) {
  const n = node(id);
  const g = gridOf(n.style);
  const tracks = g[axis].tracks.slice();
  const like = tracks[at - 1] ?? tracks[at];
  tracks.splice(at, 0, { size: size ?? (like && !like.auto ? like.size : newTrackSize(id, axis)) });
  return [
    { op: "set", id, style: gridPatch(n.style, { [axis]: { ...g[axis], tracks }, ...(g.areas ? { areas: areasWith(g.areas, axis, at) } : {}) }) },
    ...followTracks(id, axis, (s) => (s > at ? s + 1 : s), (s, span) => (s <= at && s + span - 1 > at ? span + 1 : span)),
  ];
}

/** Steps that take track `i` (0 = first) out of a grid frame. */
export function removeTrackOps(id, axis, i) {
  const n = node(id);
  const g = gridOf(n.style);
  const tracks = g[axis].tracks.slice();
  tracks.splice(i, 1);
  return [
    { op: "set", id, style: gridPatch(n.style, { [axis]: { ...g[axis], tracks }, ...(g.areas ? { areas: areasWith(g.areas, axis, i, true) } : {}) }) },
    ...followTracks(id, axis, (s) => (s > i + 1 ? s - 1 : Math.min(s, Math.max(1, tracks.length))), (s, span) => (s <= i + 1 && s + span - 1 >= i + 1 ? Math.max(1, span - 1) : span)),
  ];
}

/** Steps that move track `i` to `j` (layers in it go with it). */
export function moveTrackOps(id, axis, i, j) {
  const n = node(id);
  const g = gridOf(n.style);
  const tracks = g[axis].tracks.slice();
  if (j < 0 || j >= tracks.length || i === j) return [];
  const [t] = tracks.splice(i, 1);
  tracks.splice(j, 0, t);
  // Where each old track (1-based) is now.
  const order = g[axis].tracks.map((_, k) => k);
  order.splice(j, 0, order.splice(i, 1)[0]);
  const where = (s) => order.indexOf(s - 1) + 1 || s;
  let areas = g.areas;
  if (areas) {
    const pick = (row) => order.map((k) => row[k] ?? ".");
    areas = axis === "columns" ? areas.map(pick) : order.map((k) => areas[k] ?? Array(areas[0].length).fill("."));
  }
  return [{ op: "set", id, style: gridPatch(n.style, { [axis]: { ...g[axis], tracks }, ...(g.areas ? { areas } : {}) }) }, ...followTracks(id, axis, where)];
}

/** The step that gives track `i` a new size (CSS). */
export function trackSizeOps(id, axis, i, size) {
  const n = node(id);
  const g = gridOf(n.style);
  const tracks = g[axis].tracks.map((t, k) => (k === i ? { ...t, size } : t));
  return [{ op: "set", id, style: gridPatch(n.style, { [axis]: { ...g[axis], tracks } }) }];
}

/** Steps that give a grid `count` tracks on an axis (new ones like the last, extra ones off the end). */
export function trackCountOps(id, axis, count) {
  const n = node(id);
  const g = gridOf(n.style);
  const now = g[axis].tracks.filter((t) => !t.auto);
  count = Math.max(axis === "columns" ? 1 : 0, Math.min(48, Math.round(count)));
  if (g[axis].tracks.some((t) => t.auto) || g[axis].raw) {
    // Out of auto-fill (or a list as written): that many equal tracks.
    return [{ op: "set", id, style: gridPatch(n.style, { [axis]: { tracks: Array.from({ length: count }, () => ({ size: newTrackSize(id, axis) })) } }) }];
  }
  if (count === now.length) return [];
  const tracks = now.slice(0, count);
  const like = now[now.length - 1]?.size ?? newTrackSize(id, axis);
  while (tracks.length < count) tracks.push({ size: like });
  let areas = g.areas;
  if (areas) {
    if (axis === "columns") areas = areas.map((r) => Array.from({ length: count }, (_, k) => r[k] ?? "."));
    else areas = Array.from({ length: count }, (_, k) => areas[k] ?? Array(areas[0].length).fill("."));
  }
  return [{ op: "set", id, style: gridPatch(n.style, { [axis]: { ...g[axis], tracks }, ...(g.areas ? { areas: count ? areas : null } : {}) }) }];
}

/** Steps that make a grid's columns as many as fit, each at least `min` px (or fixed again, `count` of them). */
export function autoFillOps(id, axis, on, { min = 200, mode = "auto-fill", count } = {}) {
  const n = node(id);
  if (on) return [{ op: "set", id, style: gridPatch(n.style, { [axis]: { tracks: [{ size: `minmax(${Math.round(min)}px, 1fr)`, auto: mode }] } }) }];
  return [{ op: "set", id, style: gridPatch(n.style, { [axis]: { tracks: Array.from({ length: Math.max(1, count ?? 3) }, () => ({ size: "1fr" })) } }) }];
}

/** Commit the same kind of track change on several grid frames as one step. */
export function changeGrids(ids, make, opts) {
  const ops = ids.filter((id) => isGrid(node(id))).flatMap((id) => make(id) ?? []);
  if (ops.length) commit(ops, opts);
}

// ---------------------------------------------------------------------------------------------
// Where a grid is drawn: its tracks as the browser worked them out, in screen px over the canvas.

/** A grid frame's tracks as drawn: content box, columns and rows ({a, b} edges and px size), gaps. */
export function gridGeometry(id) {
  const n = node(id);
  const el = elOf(id);
  const cv = canvasEl.current;
  if (!n || !isGrid(n) || !el || !cv) return null;
  const cs = getComputedStyle(el);
  if (!/grid/.test(cs.display)) return null;
  const r = el.getBoundingClientRect();
  const c = cv.getBoundingClientRect();
  const z = B.view.z;
  const f = (v) => parseFloat(v) || 0;
  const sizes = (v) => (v && v !== "none" ? v.replace(/\[[^\]]*\]/g, " ").trim().split(/\s+/).filter(Boolean).map(f) : []);
  const innerW = el.clientWidth - f(cs.paddingLeft) - f(cs.paddingRight);
  const innerH = el.clientHeight - f(cs.paddingTop) - f(cs.paddingBottom);
  const colGap = f(cs.columnGap);
  const rowGap = f(cs.rowGap);
  const lay = (list, gap, space, how) => {
    if (!list.length) list = [space];
    const used = list.reduce((a, b) => a + b, 0) + gap * (list.length - 1);
    const free = space - used;
    const h = (how || "normal").replace(/^(safe|unsafe)\s+/, "");
    let off = 0;
    let extra = 0;
    if (h === "center") off = free / 2;
    else if (/^(end|flex-end|right|bottom)$/.test(h)) off = free;
    else if (free > 0 && h === "space-between" && list.length > 1) extra = free / (list.length - 1);
    else if (free > 0 && h === "space-around") (extra = free / list.length), (off = extra / 2);
    else if (free > 0 && h === "space-evenly") (extra = free / (list.length + 1)), (off = extra);
    let at = off;
    return list.map((s) => {
      const t = { start: at, size: s };
      at += s + gap + extra;
      return t;
    });
  };
  const x0 = r.left - c.left + (f(cs.borderLeftWidth) + f(cs.paddingLeft)) * z;
  const y0 = r.top - c.top + (f(cs.borderTopWidth) + f(cs.paddingTop)) * z;
  const model = gridOf(n.style);
  const cols = lay(sizes(cs.gridTemplateColumns), colGap, innerW, cs.justifyContent).map((t) => ({ a: x0 + t.start * z, b: x0 + (t.start + t.size) * z, size: t.size }));
  const rows = lay(sizes(cs.gridTemplateRows), rowGap, innerH, cs.alignContent).map((t) => ({ a: y0 + t.start * z, b: y0 + (t.start + t.size) * z, size: t.size }));
  const explicit = (l, drawn) => (l.raw || l.tracks.some((t) => t.auto) ? drawn : l.tracks.length);
  return {
    id,
    z,
    model,
    box: { x: r.left - c.left, y: r.top - c.top, width: r.width, height: r.height },
    content: { x: x0, y: y0, width: innerW * z, height: innerH * z },
    cols,
    rows,
    colGap: colGap * z,
    rowGap: rowGap * z,
    explicitCols: explicit(model.columns, cols.length),
    explicitRows: explicit(model.rows, rows.length),
  };
}

/** The track (0-based) a point falls in: gaps go to the nearer side. */
function trackAt(tracks, p) {
  for (let i = 0; i < tracks.length; i++) {
    const next = tracks[i + 1];
    if (!next || p < (tracks[i].b + next.a) / 2) return i;
  }
  return Math.max(0, tracks.length - 1);
}

/** Where a layer sits in a grid as drawn: its cell (lines from 1) and spans. */
export function childCell(cid, geo) {
  const k = node(cid);
  const pc = parsePlacement(k.style.gridColumn);
  const pr = parsePlacement(k.style.gridRow);
  const area = k.style.gridArea && areaRects(geo.model.areas)[k.style.gridArea];
  if (area) return { column: area.column, row: area.row, columnSpan: area.columnSpan, rowSpan: area.rowSpan, explicit: true };
  const el = elOf(cid);
  const c = canvasEl.current.getBoundingClientRect();
  const r = el?.getBoundingClientRect();
  const fromBox = (tracks, edge) => trackAt(tracks, edge) + 1;
  const column = typeof pc.start === "number" && pc.start > 0 ? pc.start : r ? fromBox(geo.cols, r.left - c.left + 1) : 1;
  const row = typeof pr.start === "number" && pr.start > 0 ? pr.start : r ? fromBox(geo.rows, r.top - c.top + 1) : 1;
  return { column, row, columnSpan: placementSpan(pc), rowSpan: placementSpan(pr), explicit: typeof pc.start === "number" || typeof pr.start === "number" };
}

/** A block of cells on screen (lines from 1); cells past the drawn ones get the last one's size. */
export function cellRect(geo, { column, row, columnSpan = 1, rowSpan = 1 }) {
  const edge = (tracks, i, gap, fallback) => {
    if (tracks[i]) return tracks[i];
    const last = tracks[tracks.length - 1] ?? { a: fallback, b: fallback + 40 * geo.z };
    const size = Math.max(24 * geo.z, last.b - last.a);
    const k = i - (tracks.length - 1);
    return { a: last.b + gap + (k - 1) * (size + gap), b: last.b + gap + (k - 1) * (size + gap) + size };
  };
  const c0 = edge(geo.cols, column - 1, geo.colGap, geo.content.x);
  const c1 = edge(geo.cols, column - 1 + columnSpan - 1, geo.colGap, geo.content.x);
  const r0 = edge(geo.rows, row - 1, geo.rowGap, geo.content.y);
  const r1 = edge(geo.rows, row - 1 + rowSpan - 1, geo.rowGap, geo.content.y);
  return { x: c0.a, y: r0.a, width: c1.b - c0.a, height: r1.b - r0.a };
}

// ---------------------------------------------------------------------------------------------
// Dropping a layer on a grid: the cell under the pointer. In a grid that places its layers itself
// (the usual card grid) the layer takes the place in the order that lands it there, so nothing is
// pinned; in one placed by hand it's pinned to the cell, and a layer pinned there swaps with it.

/**
 * Where a layer dropped at a point lands in a grid: `{ grid, cell, rect, index, style, swap }`.
 * `moving` is a layer being moved (null for new ones), `spans` its spans.
 */
export function gridDrop(gridId, clientX, clientY, moving = null, spans = null) {
  const geo = gridGeometry(gridId);
  if (!geo) return null;
  const cv = canvasEl.current.getBoundingClientRect();
  const x = clientX - cv.left;
  const y = clientY - cv.top;
  const g = geo.model;
  const kids = gridKids(gridId).filter((c) => c !== moving);
  const mine = moving ? node(moving) : null;
  const span = spans ?? (mine ? { columnSpan: placementSpan(parsePlacement(mine.style.gridColumn)), rowSpan: placementSpan(parsePlacement(mine.style.gridRow)) } : { columnSpan: 1, rowSpan: 1 });
  const columns = Math.max(1, geo.explicitCols || geo.cols.length);
  let column = trackAt(geo.cols, x) + 1;
  let row = trackAt(geo.rows, y) + 1;
  // Below the last row: a new one (rows come as they're needed).
  const last = geo.rows[geo.rows.length - 1];
  if (last && y > last.b + Math.max(geo.rowGap, 6) && g.flow === "row") row = geo.rows.length + 1;
  const columnSpan = Math.min(span.columnSpan, columns);
  column = Math.min(column, Math.max(1, columns - columnSpan + 1));
  const cell = { column, row, columnSpan, rowSpan: span.rowSpan };
  const rect = cellRect(geo, cell);
  const list = (node(gridId).children ?? []).filter((c) => c !== moving);
  const sameParent = mine?.parent === gridId;
  const pinned = (c) => {
    const s = node(c).style;
    return Boolean(s.gridArea) || typeof parsePlacement(s.gridColumn).start === "number" || typeof parsePlacement(s.gridRow).start === "number";
  };
  const free = { ...UNPLACED, gridArea: null };
  // A grid that places its layers itself: the place in the order that puts this one in that cell.
  if (!kids.some(pinned) && kids.length <= 300) {
    const spansOf = (c) => ({ columnSpan: Math.min(columns, placementSpan(parsePlacement(node(c).style.gridColumn))), rowSpan: placementSpan(parsePlacement(node(c).style.gridRow)) });
    const transpose = g.flow === "column";
    const count = transpose ? Math.max(1, geo.explicitRows || geo.rows.length) : columns;
    for (let k = 0; k <= kids.length; k++) {
      const seq = [...kids.slice(0, k).map(spansOf), { columnSpan, rowSpan: span.rowSpan }, ...kids.slice(k).map(spansOf)];
      const placed = autoPlace(transpose ? seq.map((s) => ({ columnSpan: s.rowSpan, rowSpan: s.columnSpan })) : seq, count, g.dense);
      const at = transpose ? { column: placed[k].row, row: placed[k].column } : placed[k];
      if (at.column === column && at.row === row) {
        const index = k < kids.length ? list.indexOf(kids[k]) : list.length;
        const style = { ...free, gridColumn: placementCss({ span: columnSpan }), gridRow: placementCss({ span: span.rowSpan }) };
        return { grid: gridId, cell, rect, index, style, reorder: true };
      }
    }
  }
  // Pinned to the cell; one pinned there already takes the moving layer's old cell.
  const style = { ...free, gridColumn: placementCss({ start: column, span: columnSpan }), gridRow: placementCss({ start: row, span: span.rowSpan }) };
  let swap = null;
  if (mine && sameParent && kids.some(pinned)) {
    const old = childCell(moving, geo);
    const there = kids.find((c) => {
      if (!pinned(c)) return false;
      const k = childCell(c, geo);
      return column >= k.column && column < k.column + k.columnSpan && row >= k.row && row < k.row + k.rowSpan;
    });
    if (there && !node(there).style.gridArea) {
      const k = childCell(there, geo);
      swap = { id: there, style: { gridColumn: placementCss({ start: old.column, span: k.columnSpan }), gridRow: placementCss({ start: old.row, span: k.rowSpan }) } };
    }
  }
  return { grid: gridId, cell, rect, style, swap, reorder: false };
}

/** The steps a drop makes: the layer into its place, pinned or in order, and a swap if there's one. */
export function gridDropOps(drop, id) {
  const n = node(id);
  const ops = [];
  const kids = (node(drop.grid).children ?? []).filter((c) => c !== id);
  const was = (node(drop.grid).children ?? []).indexOf(id);
  const index = drop.reorder ? drop.index : n.parent === drop.grid ? Math.max(0, was) : kids.length;
  if (n.parent !== drop.grid || index !== was) ops.push({ op: "move", id, parent: drop.grid, index: Math.min(index, kids.length) });
  ops.push({ op: "set", id, style: drop.style });
  if (drop.swap) ops.push({ op: "set", id: drop.swap.id, style: drop.swap.style });
  return ops;
}

/** A patch (null removes) applied to a new layer's style in place. */
export const patchStyle = (s, patch) => {
  for (const [k, v] of Object.entries(patch)) {
    if (v === null || v === undefined) delete s[k];
    else s[k] = v;
  }
  return s;
};

/** Steps that take a layer's grid placement off when it leaves a grid for another kind of frame. */
export const leaveGridOps = (id, to) => {
  const from = node(id)?.parent;
  return from && from !== to && isGrid(node(from)) && !isGrid(node(to)) ? [{ op: "set", id, style: nulls(GRID_CHILD_KEYS) }] : [];
};

/** For new layers put in a grid at a point: where the first goes (its index and placement). */
export function gridAddPlace(gridId, ev) {
  if (!ev) return null;
  return gridDrop(gridId, ev.clientX, ev.clientY, null);
}

/** A layer's own position styles off when it goes into a grid (where it sits is its cell). */
export const intoGridStyle = (s) => {
  delete s.left;
  delete s.top;
  if (s.position === "absolute") delete s.position;
  // A pinned cell from another grid would put it on top of a layer here.
  for (const k of ["gridColumn", "gridRow"]) {
    const p = parsePlacement(s[k]);
    if (typeof p.start === "number" || typeof p.start === "string") s[k] = placementCss({ span: placementSpan(p) }) ?? undefined;
    if (s[k] === undefined) delete s[k];
  }
  delete s.gridArea;
};

// ---------------------------------------------------------------------------------------------
// Dragging on a grid: a layer's edge across cells (its span), and the line between two tracks.

function follow(e, kind, { move, up }) {
  const x0 = e.clientX;
  const y0 = e.clientY;
  let live = false;
  const onMove = (ev) => {
    if (!live && Math.hypot(ev.clientX - x0, ev.clientY - y0) < 2) return;
    if (!live) B.dragging = kind;
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

/**
 * Resize a layer in a grid by a handle: across cells, its span changes (snapping to the tracks); a
 * layer with a size of its own resizes as usual inside its cells, and fills them once it's dragged
 * into another.
 */
export function resizeInGrid(e, id, h) {
  e.stopPropagation();
  const n = node(id);
  const geo = gridGeometry(n.parent);
  if (!geo) return false;
  const base = B.board;
  const cell = childCell(id, geo);
  const box0 = worldBox(id);
  const z = B.view.z;
  const c = canvasEl.current.getBoundingClientRect();
  const fillX = sizeWord(base, id, "width") === "fill";
  const fillY = sizeWord(base, id, "height") === "fill";
  const pinned = { x: typeof parsePlacement(n.style.gridColumn).start === "number", y: typeof parsePlacement(n.style.gridRow).start === "number" };
  const columns = geo.explicitCols || geo.cols.length;
  // The last track (0-based) whose middle the pointer is past, from `from` on.
  const reach = (tracks, p, from) => {
    let k = from;
    for (let i = from + 1; i < tracks.length; i++) if (p > (tracks[i].a + tracks[i].b) / 2) k = i;
    return k;
  };
  const back = (tracks, p, to) => {
    let k = to;
    for (let i = to - 1; i >= 0; i--) if (p < (tracks[i].a + tracks[i].b) / 2) k = i;
    return k;
  };
  let ops = [];
  follow(e, "resize", {
    move: (ev) => {
      const x = ev.clientX - c.left;
      const y = ev.clientY - c.top;
      const style = {};
      for (const axis of ["x", "y"]) {
        const tracks = axis === "x" ? geo.cols : geo.rows;
        const startKey = axis === "x" ? "column" : "row";
        const spanKey = axis === "x" ? "columnSpan" : "rowSpan";
        const hiEdge = axis === "x" ? "e" : "s";
        const loEdge = axis === "x" ? "w" : "n";
        const fills = axis === "x" ? fillX : fillY;
        const p = axis === "x" ? x : y;
        let start = cell[startKey] - 1;
        let end = start + cell[spanKey] - 1;
        if (!h.includes(hiEdge) && !h.includes(loEdge)) continue;
        if (h.includes(hiEdge)) {
          const k = reach(tracks, p, start);
          end = fills ? k : Math.max(end, k);
        } else {
          const k = back(tracks, p, end);
          start = fills ? k : Math.min(start, k);
        }
        if (axis === "x") end = Math.min(end, columns - 1);
        const changed = start !== cell[startKey] - 1 || end - start + 1 !== cell[spanKey];
        const lineKey = axis === "x" ? "gridColumn" : "gridRow";
        const sizeKey = axis === "x" ? "width" : "height";
        if (changed) {
          style[lineKey] = placementCss(pinned[axis] || start !== cell[startKey] - 1 ? { start: start + 1, span: end - start + 1 } : { span: end - start + 1 });
          // Dragged into more cells: it fills them.
          if (!fills) style[sizeKey] = null;
        } else if (!fills) {
          const d = (axis === "x" ? ev.clientX - e.clientX : ev.clientY - e.clientY) / z;
          const size = (axis === "x" ? box0.width : box0.height) + (h.includes(hiEdge) ? d : -d);
          style[sizeKey] = px(Math.max(1, size));
        }
      }
      ops = Object.keys(style).length ? [{ op: "set", id, style }] : [];
      bset({ drop: { grid: n.parent, cellOf: id } });
      preview(base, ops);
    },
    up: (ev, moved) => {
      bset({ drop: null });
      if (!moved || !ops.length) return notify();
      B.board = base;
      commit(ops, { label: "Resize" });
    },
  });
  return true;
}

/** Drag the line after track `i`: a px track resizes, two fr tracks share their space anew, else the track becomes px. */
function dragLine(e, gridId, axis, i) {
  e.stopPropagation();
  e.preventDefault();
  const geo = gridGeometry(gridId);
  const n = node(gridId);
  if (!geo || !n) return;
  const g = gridOf(n.style);
  const list = g[axis].tracks;
  if (g[axis].raw || list.some((t) => t.auto) || i + 1 >= list.length) return;
  const drawn = axis === "columns" ? geo.cols : geo.rows;
  const a = drawn[i].size;
  const b = drawn[i + 1].size;
  const ka = trackKind(list[i].size);
  const kb = trackKind(list[i + 1].size);
  const base = B.board;
  let ops = [];
  follow(e, "resize", {
    move: (ev) => {
      const d = (axis === "columns" ? ev.clientX - e.clientX : ev.clientY - e.clientY) / geo.z;
      let tracks;
      if (ka === "fr" && kb === "fr") {
        const fa = parseFloat(list[i].size);
        const fb = parseFloat(list[i + 1].size);
        const share = Math.max(0.05, Math.min(0.95, (a + d) / Math.max(1, a + b)));
        tracks = list.map((t, k) => (k === i ? { ...t, size: `${round((fa + fb) * share, 2)}fr` } : k === i + 1 ? { ...t, size: `${round((fa + fb) * (1 - share), 2)}fr` } : t));
      } else if (ka !== "px" && kb === "px") tracks = list.map((t, k) => (k === i + 1 ? { ...t, size: px(Math.max(0, b - d)) } : t));
      else tracks = list.map((t, k) => (k === i ? { ...t, size: px(Math.max(0, a + d)) } : t));
      ops = [{ op: "set", id: gridId, style: gridPatch(n.style, { [axis]: { ...g[axis], tracks } }) }];
      preview(base, ops);
    },
    up: (ev, moved) => {
      if (!moved || !ops.length) return notify();
      B.board = base;
      commit(ops, { label: "Resize track" });
    },
  });
}

// ---------------------------------------------------------------------------------------------
// A track's menu (a click on its header on the canvas): its size, and putting tracks in and out.

export function trackMenu(x, y, gridId, axis, i) {
  const n = node(gridId);
  const g = gridOf(n.style);
  const geo = gridGeometry(gridId);
  const list = g[axis].tracks;
  const A = AXES[axis];
  const run = (ops, label) => ops?.length && commit(ops, { label });
  if (g[axis].raw) return openMenu(x, y, [{ label: `${A.Word}s are written as ${g[axis].raw}: change them under CSS`, disabled: true }]);
  const auto = list.find((t) => t.auto);
  const drawn = (axis === "columns" ? geo?.cols : geo?.rows)?.[i]?.size;
  const implicit = !auto && i >= list.length;
  if (auto || implicit) {
    const key = axis === "columns" ? "autoColumns" : "autoRows";
    return openMenu(x, y, [
      auto && { label: `As many ${A.word}s as fit, each at least ${trackLabel(auto).replace(/^\w+ ≥ /, "")}`, disabled: true },
      implicit && { label: `Made as needed: ${g[key] || "auto"}`, disabled: true },
      implicit && { label: `New ${A.word}s hug what's in them`, icon: !g[key] || g[key] === "auto" ? "check" : undefined, run: () => run([{ op: "set", id: gridId, style: gridPatch(n.style, { [key]: "" }) }], "Grid") },
      implicit && drawn && { label: `New ${A.word}s ${Math.round(drawn)} px`, run: () => run([{ op: "set", id: gridId, style: gridPatch(n.style, { [key]: px(drawn) }) }], "Grid") },
      "-",
      { label: `Make ${geo ? (axis === "columns" ? geo.cols.length : geo.rows.length) : 3} ${A.word}s of my own`, icon: "grid", run: () => run(trackCountOps(gridId, axis, axis === "columns" ? geo?.cols.length ?? 3 : geo?.rows.length ?? 1), "Grid") },
    ]);
  }
  const t = list[i];
  const kind = trackKind(t.size);
  const size = (s, label = "Grid") => run(trackSizeOps(gridId, axis, i, s), label);
  openMenu(x, y, [
    { label: `Fill${kind === "fr" ? ` · ${t.size}` : " (1fr)"}`, icon: kind === "fr" ? "check" : undefined, run: () => kind !== "fr" && size("1fr") },
    { label: `Fixed${drawn ? ` · ${Math.round(drawn)} px` : ""}`, icon: kind === "px" ? "check" : undefined, run: () => drawn && size(px(drawn)) },
    { label: "Hug what's in it (auto)", icon: kind === "auto" ? "check" : undefined, run: () => size("auto") },
    { label: "Min content", icon: kind === "min-content" ? "check" : undefined, run: () => size("min-content") },
    { label: "Max content", icon: kind === "max-content" ? "check" : undefined, run: () => size("max-content") },
    drawn && { label: `At least ${Math.round(drawn)} px, then fill`, icon: kind === "minmax" ? "check" : undefined, run: () => size(`minmax(${Math.round(drawn)}px, 1fr)`) },
    "-",
    { label: `Add a ${A.word} ${A.before}`, icon: "plus", run: () => run(insertTrackOps(gridId, axis, i), `Add a ${A.word}`) },
    { label: `Add a ${A.word} ${A.after}`, icon: "plus", run: () => run(insertTrackOps(gridId, axis, i + 1), `Add a ${A.word}`) },
    { label: `Move ${A.before}`, icon: axis === "columns" ? "left" : "up", disabled: i === 0, run: () => run(moveTrackOps(gridId, axis, i, i - 1), `Move a ${A.word}`) },
    { label: `Move ${A.after}`, icon: axis === "columns" ? "right" : "down", disabled: i >= list.length - 1, run: () => run(moveTrackOps(gridId, axis, i, i + 1), `Move a ${A.word}`) },
    { label: `Select what's in this ${A.word}`, icon: "layers", run: () => geo && select(gridKids(gridId).filter((c) => {
      const k = childCell(c, geo);
      const s = axis === "columns" ? k.column : k.row;
      const span = axis === "columns" ? k.columnSpan : k.rowSpan;
      return i + 1 >= s && i + 1 < s + span;
    })) },
    "-",
    { label: `Delete ${A.word}`, icon: "trash", danger: true, disabled: axis === "columns" && list.length <= 1, run: () => run(removeTrackOps(gridId, axis, i), `Delete a ${A.word}`) },
  ]);
}

// ---------------------------------------------------------------------------------------------
// Drawn over the canvas: a grid's tracks, gaps and lines while it (or a layer in it) is selected, or
// something is dragged over it; headers and + buttons on a selected grid.

/** The grid to show, and why: the selected grid frame, the grid round the selection, or the one dragged over. */
function shownGrid() {
  const d = B.drop;
  if (d?.grid && isGrid(node(d.grid))) return { id: d.grid, mode: "drop" };
  if (d?.into && isGrid(node(d.into))) return { id: d.into, mode: "drop" };
  if (B.editing || !B.sel.length) return null;
  const list = B.sel.map(node).filter(Boolean);
  if (list.length === 1 && isGrid(list[0]) && !list[0].hidden) return { id: list[0].id, mode: "frame" };
  const p = list[0]?.parent;
  if (p && isGrid(node(p)) && list.every((n) => n.parent === p)) return { id: p, mode: "child" };
  return null;
}

export function GridOverlay() {
  const [hot, setHot] = useState(null);
  const shown = shownGrid();
  const id = shown?.id;
  const geo = id ? gridGeometry(id) : null;
  // Which track the pointer is over (inside the grid or on a header): its size shows.
  useEffect(() => {
    if (!id) return;
    const onMove = (e) => {
      const g = gridGeometry(id);
      const c = canvasEl.current?.getBoundingClientRect();
      if (!g || !c) return;
      const x = e.clientX - c.left;
      const y = e.clientY - c.top;
      const inside = x >= g.content.x && x <= g.content.x + g.content.width && y >= g.content.y && y <= g.content.y + g.content.height;
      const head = e.target?.closest?.("[data-track]");
      const next = head ? `${head.dataset.axis}:${head.dataset.track}` : inside && !B.dragging ? `cell:${trackAt(g.cols, x)}:${trackAt(g.rows, y)}` : null;
      setHot((h) => (h === next ? h : next));
    };
    addEventListener("pointermove", onMove);
    return () => removeEventListener("pointermove", onMove);
  }, [id]);
  if (!geo || geo.box.width < 6 || geo.box.height < 6) return null;
  const { cols, rows, content } = geo;
  const n = node(id);
  const busy = B.dragging && B.dragging !== "resize";
  const editing = shown.mode === "frame" && !B.dragging && !n.locked;
  const hotCol = hot?.startsWith("cell:") ? Number(hot.split(":")[1]) : hot?.startsWith("columns:") ? Number(hot.split(":")[1]) : -1;
  const hotRow = hot?.startsWith("cell:") ? Number(hot.split(":")[2]) : hot?.startsWith("rows:") ? Number(hot.split(":")[1]) : -1;
  const lines = [];
  const gaps = [];
  cols.forEach((t, i) => {
    const implicit = i >= geo.explicitCols;
    lines.push(html`<div key=${"cl" + i} class="bd-grid-line v ${implicit ? "implicit" : ""}" style=${{ left: t.a + "px", top: content.y + "px", height: Math.max(0, rowsBottom(geo) - content.y) + "px" }}></div>`);
    lines.push(html`<div key=${"cr" + i} class="bd-grid-line v ${implicit ? "implicit" : ""}" style=${{ left: t.b + "px", top: content.y + "px", height: Math.max(0, rowsBottom(geo) - content.y) + "px" }}></div>`);
    const next = cols[i + 1];
    if (next && next.a - t.b >= 2) gaps.push(html`<div key=${"cg" + i} class="bd-grid-gap" style=${{ left: t.b + "px", top: content.y + "px", width: next.a - t.b + "px", height: Math.max(0, rowsBottom(geo) - content.y) + "px" }}></div>`);
  });
  rows.forEach((t, i) => {
    const implicit = i >= geo.explicitRows;
    lines.push(html`<div key=${"rt" + i} class="bd-grid-line h ${implicit ? "implicit" : ""}" style=${{ top: t.a + "px", left: content.x + "px", width: Math.max(0, colsRight(geo) - content.x) + "px" }}></div>`);
    lines.push(html`<div key=${"rb" + i} class="bd-grid-line h ${implicit ? "implicit" : ""}" style=${{ top: t.b + "px", left: content.x + "px", width: Math.max(0, colsRight(geo) - content.x) + "px" }}></div>`);
    const next = rows[i + 1];
    if (next && next.a - t.b >= 2) gaps.push(html`<div key=${"rg" + i} class="bd-grid-gap" style=${{ top: t.b + "px", left: content.x + "px", height: next.a - t.b + "px", width: Math.max(0, colsRight(geo) - content.x) + "px" }}></div>`);
  });
  // The selected layers' cells, the cell a drop lands in, and named areas.
  const marks = [];
  if (shown.mode === "child" && !B.dragging) {
    for (const s of B.sel) if (gridKids(id).includes(s)) marks.push(cellRect(geo, childCell(s, geo)));
  }
  const d = B.drop;
  const target = d?.cell ?? (d?.cellOf && node(d.cellOf) ? cellRect(geo, childCell(d.cellOf, geo)) : null);
  const areas = Object.entries(areaRects(geo.model.areas));
  const roomy = Math.min(...cols.map((t) => t.b - t.a), ...rows.map((t) => t.b - t.a)) >= 14;
  // Far out, a grid is small on screen: only its lines show, so headers and buttons don't crowd it.
  const headed = geo.box.width >= 110 && geo.box.height >= 56 && Math.min(...cols.map((t) => t.b - t.a), ...rows.map((t) => t.b - t.a)) >= 6;
  // Headers sit outside the frame: above its columns (above an artboard's name), left of its rows.
  const headTop = geo.box.y - (n.parent ? 14 : 36);
  const headLeft = geo.box.x - 14;
  const label = (axis, i) => {
    const list = geo.model[axis].tracks;
    const t = list[i] ?? list.find((x) => x.auto);
    const drawn = Math.round((axis === "columns" ? cols : rows)[i].size);
    if (!t) return `Auto · ${drawn}`;
    const own = trackLabel(t);
    return trackKind(t.size) === "px" && !t.auto ? own : `${own} · ${drawn}`;
  };
  return html`<div class="bd-grid ${shown.mode}">
    ${gaps}${lines}
    ${marks.map((r, k) => html`<div key=${"m" + k} class="bd-grid-cell" style=${{ left: r.x + "px", top: r.y + "px", width: r.width + "px", height: r.height + "px" }}></div>`)}
    ${target && html`<div class="bd-grid-target" style=${{ left: target.x + "px", top: target.y + "px", width: target.width + "px", height: target.height + "px" }}></div>`}
    ${roomy && !busy && areas.map(([name, a]) => {
      const r = cellRect(geo, a);
      return html`<div key=${"a" + name} class="bd-grid-area ${a.ok ? "" : "bad"}" style=${{ left: r.x + 3 + "px", top: r.y + 3 + "px", maxWidth: Math.max(0, r.width - 6) + "px" }}>${name}</div>`;
    })}
    ${!busy && headed && (editing || hotCol >= 0) && cols.map((t, i) => html`<div key=${"hc" + i} data-track=${i} data-axis="columns" class="bd-grid-head at-col ${i === hotCol ? "hot" : ""} ${i >= geo.explicitCols ? "implicit" : ""} ${editing ? "live" : ""}"
        style=${{ left: t.a + "px", top: headTop + "px", width: Math.max(2, t.b - t.a) + "px" }}
        title=${editing ? `Column ${i + 1}: click for its size and more` : ""}
        onPointerDown=${(e) => e.stopPropagation()}
        onClick=${(e) => editing && trackMenu(e.clientX, e.clientY, id, "columns", i)}>
        ${i === hotCol && html`<span class="tag">${label("columns", i)}</span>`}
      </div>`)}
    ${!busy && headed && (editing || hotRow >= 0) && rows.map((t, i) => html`<div key=${"hr" + i} data-track=${i} data-axis="rows" class="bd-grid-head at-row ${i === hotRow ? "hot" : ""} ${i >= geo.explicitRows ? "implicit" : ""} ${editing ? "live" : ""}"
        style=${{ top: t.a + "px", left: headLeft + "px", height: Math.max(2, t.b - t.a) + "px" }}
        title=${editing ? `Row ${i + 1}: click for its size and more` : ""}
        onPointerDown=${(e) => e.stopPropagation()}
        onClick=${(e) => editing && trackMenu(e.clientX, e.clientY, id, "rows", i)}>
        ${i === hotRow && html`<span class="tag">${label("rows", i)}</span>`}
      </div>`)}
    ${editing && roomy && cols.slice(0, -1).map((t, i) => i + 1 < geo.explicitCols && html`<div key=${"lc" + i} class="bd-grid-drag v" title="Drag to resize the columns either side"
        style=${{ left: (t.b + cols[i + 1].a) / 2 + "px", top: content.y + "px", height: Math.max(0, rowsBottom(geo) - content.y) + "px" }}
        onPointerDown=${(e) => dragLine(e, id, "columns", i)}></div>`)}
    ${editing && roomy && rows.slice(0, -1).map((t, i) => i + 1 < geo.explicitRows && html`<div key=${"lr" + i} class="bd-grid-drag h" title="Drag to resize the rows either side"
        style=${{ top: (t.b + rows[i + 1].a) / 2 + "px", left: content.x + "px", width: Math.max(0, colsRight(geo) - content.x) + "px" }}
        onPointerDown=${(e) => dragLine(e, id, "rows", i)}></div>`)}
    ${editing && headed && html`<button class="bd-grid-add at-col" title="Add a column" aria-label="Add a column" style=${{ left: Math.max(colsRight(geo), geo.box.x + geo.box.width) + 6 + "px", top: headTop - 5 + "px" }}
        onPointerDown=${(e) => e.stopPropagation()}
        onClick=${() => commit(geo.model.columns.tracks.some((t) => t.auto) ? trackCountOps(id, "columns", cols.length + 1) : insertTrackOps(id, "columns", geo.model.columns.tracks.length), { label: "Add a column" })}><${Icon} n="plus" s=${11} w=${2.2} /></button>
      <button class="bd-grid-add at-row" title="Add a row" aria-label="Add a row" style=${{ top: Math.max(rowsBottom(geo), geo.box.y + geo.box.height) + 6 + "px", left: headLeft - 5 + "px" }}
        onPointerDown=${(e) => e.stopPropagation()}
        onClick=${() => commit(geo.model.rows.tracks.length ? insertTrackOps(id, "rows", geo.model.rows.tracks.length) : trackCountOps(id, "rows", rows.length + 1), { label: "Add a row" })}><${Icon} n="plus" s=${11} w=${2.2} /></button>`}
  </div>`;
}

const rowsBottom = (geo) => Math.max(geo.content.y + geo.content.height, geo.rows[geo.rows.length - 1]?.b ?? 0);
const colsRight = (geo) => Math.max(geo.content.x + geo.content.width, geo.cols[geo.cols.length - 1]?.b ?? 0);
