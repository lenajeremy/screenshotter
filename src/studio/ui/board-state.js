// Boards in the Studio: the open board, what's selected, undo, and keeping in step with the board
// on disk, which agents change too (their changes show up within a second, as steps you can undo).
import { useEffect, useReducer } from "preact/hooks";
import { OpError, applyOps, expandOps, pxValue, rootOf } from "./board-core.js";
import { shapeInBox } from "./shapes.js";
import { S, api, fail, set, toast } from "./store.js";

export const B = {
  id: null,
  board: null,
  /** The page on show. */
  page: null,
  /** Selected layers, in the order picked. */
  sel: [],
  hover: null,
  /** move, hand, frame, rect, text */
  tool: "move",
  /** The canvas camera: screen = world × z + (x, y). */
  view: { x: 80, y: 80, z: 0.5 },
  /** The text layer being typed in. */
  editing: null,
  renaming: null,
  past: [],
  future: [],
  /** Layers open in the layer list. */
  open: new Set(),
  /** Artboards an agent is working on right now. */
  working: [],
  leftOpen: true,
  rightOpen: true,
  /** An insertion line or a drop target while dragging. */
  drop: null,
  guides: [],
  /** What's being dragged on the canvas: move, resize, scale, marquee, draw, pan. */
  dragging: null,
  /** How much the selection is being scaled right now (the Scale tool), or null. */
  scaling: null,
  /** The point of the selection that stays put when the Scale panel scales it: [0, 0] its top left. */
  scaleFrom: [0, 0],
  /** The board's comments and the agents who worked on it, kept apart from the design (and its undo). */
  comments: { rev: 0, threads: [], agents: {} },
  /** The comment thread open by its pin, or a new comment being written (its anchor). */
  thread: null,
  draft: null,
  showResolved: false,
  /** Changes when the comments or the board's agents do (from the server's poll answer). */
  talk: "",
};

const listeners = new Set();
let frame = 0;
export function notify() {
  if (frame) return;
  frame = requestAnimationFrame(() => {
    frame = 0;
    for (const l of listeners) l();
  });
}
export function bset(patch) {
  Object.assign(B, typeof patch === "function" ? patch(B) : patch);
  notify();
}
export function useBoard() {
  const [, force] = useReducer((n) => n + 1, 0);
  useEffect(() => {
    listeners.add(force);
    return () => listeners.delete(force);
  }, []);
  return B;
}

export const node = (id) => B.board?.nodes[id];
export const currentPage = () => B.board?.pages.find((p) => p.id === B.page) ?? B.board?.pages[0];

// ---------------------------------------------------------------------------------------------
// Shapes: a vector layer made from one of Screenshotter's shapes is drawn again whenever its
// settings or its size change, in the same step (so exports and agents see what the canvas shows).

let measure = () => null;
/** The canvas tells the board how big a layer is drawn (for a shape whose size isn't in px). */
export const useMeasure = (fn) => (measure = fn);

function withShapes(board, ops) {
  return ops.map((op) => {
    if (op.op === "add") {
      let changed = false;
      const nodes = { ...op.nodes };
      for (const [id, n] of Object.entries(nodes)) {
        if (!n.shape || n.svg) continue;
        nodes[id] = { ...n, svg: shapeInBox(n.shape, pxValue(n.style.width) ?? 120, pxValue(n.style.height) ?? 120) };
        changed = true;
      }
      return changed ? { ...op, nodes } : op;
    }
    if (op.op !== "set") return op;
    const n = board.nodes[op.id];
    const shape = op.shape === undefined ? n?.shape : op.shape;
    if (!shape || !n) return op;
    if (op.shape === undefined && !op.replaceStyle && !(op.style && ("width" in op.style || "height" in op.style))) return op;
    const style = op.replaceStyle ? { ...op.replaceStyle } : { ...n.style, ...Object.fromEntries(Object.entries(op.style ?? {}).filter(([, v]) => v != null)) };
    const box = measure(op.id);
    return { ...op, svg: shapeInBox(shape, pxValue(style.width) ?? box?.width ?? 120, pxValue(style.height) ?? box?.height ?? 120) };
  });
}

// ---------------------------------------------------------------------------------------------
// Changes: applied here at once, then sent to the board on disk in order.

const HISTORY = 100;
let lastKey = null;
let lastAt = 0;

/**
 * Change the board. `key` merges a run of changes to the same thing (a number being scrubbed, a
 * colour being dragged) into one step of undo.
 */
export function commit(ops, { key = null, label } = {}) {
  if (!B.board || !ops.length) return;
  let res;
  try {
    // Shapes are drawn to their new size, and components' copies follow, in the same step.
    ops = expandOps(B.board, withShapes(B.board, ops));
    res = applyOps(B.board, ops);
  } catch (e) {
    if (e instanceof OpError) toast({ kind: "info", title: "That can't be done here", text: e.message, timeout: 7000 });
    else fail(e, "Couldn't change the board");
    return false;
  }
  const now = Date.now();
  const top = B.past[B.past.length - 1];
  if (key && key === lastKey && top && now - lastAt < 1500) {
    B.past[B.past.length - 1] = { ops: [...top.ops, ...ops], inverse: [...res.inverse, ...top.inverse], label: top.label };
  } else {
    B.past.push({ ops, inverse: res.inverse, label });
    if (B.past.length > HISTORY) B.past.shift();
  }
  lastKey = key;
  lastAt = now;
  B.future = [];
  B.board = res.board;
  keepSelection();
  notify();
  send(ops);
  return true;
}

/** Show a change without keeping it (a drag in progress): `commit` the final one from `base`. */
export function preview(base, ops) {
  try {
    B.board = applyOps(base, expandOps(base, withShapes(base, ops))).board;
    notify();
  } catch {
    // A move that isn't possible yet (into itself): keep showing the last good one.
  }
}

export function undo() {
  step(B.past, B.future, "inverse", "ops");
}
export function redo() {
  step(B.future, B.past, "ops", "inverse");
}
function step(from, to, use, other) {
  const entry = from.pop();
  if (!entry || !B.board) return;
  try {
    const res = applyOps(B.board, entry[use]);
    B.board = res.board;
    to.push(entry);
    lastKey = null;
    keepSelection();
    notify();
    send(entry[use]);
  } catch (e) {
    // The layers it was about have gone (an agent deleted them): that step can't be undone.
    if (e instanceof OpError) {
      toast({ kind: "err", title: "Couldn't undo that", text: "What it changed isn't on the board any more." });
      notify();
    } else throw e;
  }
  void other;
}

function keepSelection() {
  const b = B.board;
  const sel = B.sel.filter((id) => b.nodes[id]);
  if (sel.length !== B.sel.length) B.sel = sel;
  if (B.editing && !b.nodes[B.editing]) B.editing = null;
  if (!b.pages.some((p) => p.id === B.page)) B.page = b.pages[0]?.id ?? null;
}

// ---------------------------------------------------------------------------------------------
// The board on disk

/**
 * Changes waiting to be saved, each with the board it was made on: opening another board while
 * one is still saving mustn't send the rest to the new one.
 */
let queue = [];
let sending = false;
let mineUntil = 0;

function send(ops) {
  if (!B.id || !ops.length) return;
  const last = queue[queue.length - 1];
  // Never added to the one on its way: it may be sent again as it was.
  if (last && last.id === B.id && !last.out) last.ops.push(...ops);
  else queue.push({ id: B.id, ops: [...ops], tries: 0 });
  flush();
}

/** What's still to be saved on the open board. */
const pendingHere = () => queue.filter((q) => q.id === B.id).flatMap((q) => q.ops);

/** Saves that didn't reach the engine (it's restarting, say) are tried again for about half a minute. */
const RETRIES = [500, 1000, 2000, 4000, 8000, 15000];

/** Post steps to the engine. An error says whether to try again: the engine couldn't be reached, rather than refused them. */
async function postOps(body) {
  let res;
  try {
    res = await fetch("/api/board/ops", { method: "POST", headers: { "x-screenshotter": "studio", "Content-Type": "application/json" }, body: JSON.stringify(body) });
  } catch {
    throw Object.assign(new Error("Lost connection to the Screenshotter engine."), { retry: true });
  }
  const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
  if (!res.ok || data?.error) throw Object.assign(new Error(data?.error || `HTTP ${res.status}`), { retry: res.status >= 502 });
  return data;
}

async function flush() {
  if (sending || !queue.length) return;
  sending = true;
  const item = queue[0];
  item.out = true;
  const { id, ops } = item;
  try {
    const r = await postOps({ id, ops, base: id === B.id ? B.board?.rev : undefined });
    queue.shift();
    if (id === B.id) {
      if (r.stale) await reload({ quiet: true });
      else if (B.board) B.board = { ...B.board, rev: r.rev, updatedAt: r.updatedAt };
      mineUntil = Date.now() + 400;
    }
  } catch (e) {
    if (e.retry && item.tries < RETRIES.length) {
      // Kept first in line (what comes after depends on it) and sent again in a moment.
      setTimeout(() => ((sending = false), flush()), RETRIES[item.tries++]);
      return;
    }
    // Refused, or the engine stayed away: this and every later change to that board are lost.
    const lost = queue.filter((q) => q.id === id);
    queue = queue.filter((q) => q.id !== id);
    fail(e, lost.length > 1 || ops.length > 1 ? "Couldn't save your last changes to the board" : "Couldn't save that change to the board");
    // Start again from what's on disk rather than drift from it.
    if (id === B.id) {
      forget(lost.flatMap((q) => q.ops));
      await reload({ quiet: true }).catch(() => undefined);
    }
  }
  sending = false;
  if (queue.length) flush();
}

/**
 * Changes that never reached the board leave undo: undoing one would undo something that isn't
 * there. Redo goes too, since it was made on top of them.
 */
function forget(ops) {
  const gone = new Set(ops);
  B.past = B.past.filter((e) => !e.ops.some((o) => gone.has(o)) && !e.inverse.some((o) => gone.has(o)));
  B.future = [];
  lastKey = null;
}

export const saving = () => sending || queue.length > 0;

/** Resolves once every change made so far is saved (or given up on), or after `ms`: the app waits for it before quitting. */
export function saved(ms = 8000) {
  const until = Date.now() + ms;
  return new Promise((done) => {
    const check = () => (!saving() || Date.now() > until ? done() : setTimeout(check, 50));
    check();
  });
}

// The window closing with changes still waiting: they go out as it closes, as far as the browser lets a page send then.
addEventListener("pagehide", () => {
  for (const q of queue) {
    if (q.out) continue;
    fetch("/api/board/ops", { method: "POST", keepalive: true, headers: { "x-screenshotter": "studio", "Content-Type": "application/json" }, body: JSON.stringify({ id: q.id, ops: q.ops }) }).catch(() => undefined);
  }
  queue = queue.filter((q) => q.out);
});

/** Load the board from disk. An agent's change becomes a step you can undo. */
async function reload({ quiet = false, agent = false } = {}) {
  if (!B.id) return;
  const fresh = await api(`/api/board?id=${encodeURIComponent(B.id)}`);
  if (fresh.id !== B.id) return;
  // Changes not sent yet go on top of it.
  let board = fresh;
  const pending = pendingHere();
  if (pending.length) {
    try {
      board = applyOps(fresh, pending).board;
    } catch {
      // Someone else changed the same layers meanwhile: what's still waiting can't go on top of it.
      const lost = queue.filter((q) => q.id === B.id && !q.out);
      queue = queue.filter((q) => q.id !== B.id || q.out);
      forget(lost.flatMap((q) => q.ops));
      toast({ kind: "info", title: "Some changes weren't saved", text: "An agent changed the same layers at the same moment, so the board shows their version.", timeout: 8000 });
    }
  }
  if (agent && B.board) {
    const before = B.board;
    B.past.push({
      ops: [{ op: "replace", pages: board.pages, nodes: board.nodes, tokens: board.tokens, name: board.name }],
      inverse: [{ op: "replace", pages: before.pages, nodes: before.nodes, tokens: before.tokens, name: before.name }],
      label: "An agent's change",
    });
    if (B.past.length > HISTORY) B.past.shift();
    B.future = [];
    lastKey = null;
  }
  B.board = board;
  keepSelection();
  notify();
  if (!quiet && agent) set({});
}

/** Told (before, after) whenever the comments are loaded again. */
export const commentListeners = new Set();

/** The board's comments and agents, which change apart from the design: the person's, or an agent's answer. */
export async function loadComments() {
  const id = B.id;
  if (!id) return;
  try {
    const c = await api(`/api/board/comments?id=${encodeURIComponent(id)}`);
    if (id !== B.id) return;
    const before = B.comments;
    const thread = B.thread && !c.threads.some((t) => t.id === B.thread) ? null : B.thread;
    bset({ comments: { rev: c.rev, threads: c.threads ?? [], agents: c.agents ?? {} }, thread });
    for (const l of commentListeners) l(before, B.comments);
  } catch {
    // The board went, or the engine is restarting: the next poll tries again.
  }
}

let poll = 0;
function startPolling() {
  clearInterval(poll);
  poll = setInterval(async () => {
    if (!B.id || document.visibilityState !== "visible" || saving() || Date.now() < mineUntil) return;
    try {
      const r = await api(`/api/board/rev?id=${encodeURIComponent(B.id)}`);
      const working = r.working ?? [];
      if (working.join() !== B.working.join()) bset({ working });
      if (r.talk !== undefined && r.talk !== B.talk) {
        B.talk = r.talk;
        loadComments();
      }
      if (B.board && r.rev > B.board.rev && !saving()) await reload({ agent: r.by === "agent" });
    } catch {
      // The board was deleted, or the engine is restarting: try again next time.
    }
  }, 700);
}

// ---------------------------------------------------------------------------------------------
// Opening and closing

export async function openBoard(id) {
  try {
    const board = await api(`/api/board?id=${encodeURIComponent(id)}`);
    const remembered = rememberedView(id);
    Object.assign(B, { id, board, page: remembered?.page && board.pages.some((p) => p.id === remembered.page) ? remembered.page : board.pages[0]?.id, sel: [], hover: null, editing: null, renaming: null, past: [], future: [], tool: "move", working: [], drop: null, guides: [], open: new Set(), comments: { rev: 0, threads: [], agents: board.agents ?? {} }, thread: null, draft: null, talk: "" });
    if (remembered?.view) B.view = remembered.view;
    else B.view = { ...B.view, fitPending: true };
    set({ boardId: id, scenesPage: false, scenesOpen: false });
    try {
      localStorage.setItem("board:last", id);
    } catch {}
    startPolling();
    loadComments();
    notify();
  } catch (e) {
    fail(e, "Couldn't open the board");
  }
}

export function closeBoard({ toLibrary = true } = {}) {
  rememberView();
  clearInterval(poll);
  Object.assign(B, { id: null, board: null, sel: [], editing: null, past: [], future: [], thread: null, draft: null, comments: { rev: 0, threads: [], agents: {} } });
  try {
    localStorage.removeItem("board:last");
  } catch {}
  set({ boardId: null, ...(toLibrary ? { scenesPage: true, libraryShelf: "boards" } : {}) });
}

export async function newBoard(name) {
  try {
    const b = await api("/api/board/new", { name });
    await openBoard(b.id);
    return b;
  } catch (e) {
    fail(e, "Couldn't make a board");
  }
}

function rememberedView(id) {
  try {
    return JSON.parse(localStorage.getItem(`board:view:${id}`) ?? "null");
  } catch {
    return null;
  }
}
export function rememberView() {
  if (!B.id) return;
  try {
    const { x, y, z } = B.view;
    localStorage.setItem(`board:view:${B.id}`, JSON.stringify({ view: { x, y, z }, page: B.page }));
  } catch {}
}
addEventListener("pagehide", rememberView);

// ---------------------------------------------------------------------------------------------
// Selection helpers

export function select(ids, { add = false, toggle = false } = {}) {
  let sel = Array.isArray(ids) ? ids : ids ? [ids] : [];
  if (toggle) {
    const now = new Set(B.sel);
    for (const id of sel) now.has(id) ? now.delete(id) : now.add(id);
    sel = [...now];
  } else if (add) sel = [...new Set([...B.sel, ...sel])];
  // Show where a selected layer is in the list.
  const open = new Set(B.open);
  for (const id of sel) {
    let n = node(id);
    while (n?.parent) {
      open.add(n.parent);
      n = node(n.parent);
    }
  }
  bset({ sel, editing: B.editing && sel.includes(B.editing) ? B.editing : null, open });
}

/** The artboards the selection is on (or all of the page's when nothing is selected). */
export function selectedArtboards() {
  const page = currentPage();
  if (!page) return [];
  if (!B.sel.length) return page.children.slice();
  return [...new Set(B.sel.map((id) => rootOf(B.board, id)))];
}

export { S };
