// Boards in the Studio: the open board, what's selected, undo, and keeping in step with the board
// on disk, which agents change too (their changes show up within a second, as steps you can undo).
import { useEffect, useReducer, useRef } from "preact/hooks";
import { OpError, applyOps, expandOps, pxValue, rootOf } from "./board-core.js";
import { shapeInBox } from "./shapes.js";
import { S, api, fail, set, toast } from "./store.js";

/** The left panel's width as last dragged, if it was. */
function savedLeftWidth() {
  try {
    const w = Number(localStorage.getItem("board:left-w"));
    return w >= LEFT_MIN && w <= LEFT_MAX ? w : null;
  } catch {
    return null;
  }
}
/** How narrow and how wide the left panel can be dragged. */
export const LEFT_MIN = 240;
export const LEFT_MAX = 560;

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
  /** The width the left panel was dragged to (kept on this Mac), or null for the usual 248. */
  leftW: savedLeftWidth(),
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
  /** Live team sync state when this board belongs to a team, else null. */
  live: null,
  /** Live teammates currently in this team board room. */
  peers: [],
};

// Each component that draws from the board, and the keys of B it doesn't draw from (null: it
// draws from all of them). A frame in which only those keys changed (the view while panning, the
// layer under the pointer) leaves it alone: the panels don't redraw 60 times a second for nothing.
const listeners = new Map();
let frame = 0;
/** What changed since the last frame: every key (a change made to B directly), or these keys. */
let changedAll = false;
const changed = new Set();
/** Redraw at the next frame. `keys` names what changed; without it, anything may have. */
export function notify(keys) {
  if (keys) for (const k of keys) changed.add(k);
  else changedAll = true;
  if (frame) return;
  frame = requestAnimationFrame(() => {
    frame = 0;
    const all = changedAll;
    const keys = [...changed];
    changedAll = false;
    changed.clear();
    for (const [l, ignore] of listeners) if (all || !ignore || keys.some((k) => !ignore.has(k))) l();
  });
}
export function bset(patch) {
  const p = typeof patch === "function" ? patch(B) : patch;
  Object.assign(B, p);
  // bset({}) asks for a redraw of everything (something outside B changed).
  const keys = Object.keys(p ?? {});
  notify(keys.length ? keys : undefined);
}
/**
 * What (nearly) only the canvas draws from, changing many times a second as the pointer moves:
 * keys of B, and "words", the words picked in a text being typed in (for the inspector).
 */
export const CANVAS_ONLY = ["view", "hover", "guides", "drop", "words", "presence", "peers", "following"];
/**
 * Redraw the calling component whenever the board changes, except for changes to only the keys it
 * says it `ignore`s.
 */
export function useBoard(ignore) {
  const [, force] = useReducer((n) => n + 1, 0);
  useEffect(() => {
    listeners.set(force, ignore ? new Set(ignore) : null);
    return () => listeners.delete(force);
  }, []);
  return B;
}

/** Redraw the calling component only when `pick(B)` gives something else (the zoom shown as a percentage, say). */
export function useBoardPick(pick) {
  const [, force] = useReducer((n) => n + 1, 0);
  const fn = useRef(pick);
  fn.current = pick;
  const last = useRef();
  last.current = pick(B);
  useEffect(() => onBoard(() => fn.current(B) !== last.current && force()), []);
  return last.current;
}

/** Call `fn` (at most once a frame) whenever the board changes, for code outside components. Returns how to stop. */
export function onBoard(fn, ignore) {
  listeners.set(fn, ignore ? new Set(ignore) : null);
  return () => listeners.delete(fn);
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
  // A run of changes to one thing (a number scrubbed, a colour dragged) is saved a few times a
  // second, not at every step of the pointer.
  send(ops, { gather: Boolean(key) });
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
/** A save held back for a moment while a run of changes goes on. */
let gathering = 0;
const GATHER_MS = 120;

function send(ops, { gather = false } = {}) {
  if (!B.id || !ops.length) return;
  const last = queue[queue.length - 1];
  // Never added to the one on its way: it may be sent again as it was.
  if (last && last.id === B.id && !last.out) last.ops.push(...ops);
  else queue.push({ id: B.id, ops: [...ops], tries: 0 });
  // Scrubbing or dragging a colour changes the board at every event: the steps go out together,
  // GATHER_MS after the first, rather than a save (a read and a write of the whole board by the
  // engine) for each. Anything else goes at once, and takes what was gathered with it.
  if (gather) {
    gathering ||= setTimeout(() => {
      gathering = 0;
      flush();
    }, GATHER_MS);
    return;
  }
  clearTimeout(gathering);
  gathering = 0;
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
  // What was gathered meanwhile waits for its moment; anything else goes now.
  if (queue.length && !gathering) flush();
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
  delete fresh._team;
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
      ops: [{ op: "replace", pages: board.pages, nodes: board.nodes, tokens: board.tokens, name: board.name, shaders: board.shaders ?? [] }],
      inverse: [{ op: "replace", pages: before.pages, nodes: before.nodes, tokens: before.tokens, name: before.name, shaders: before.shaders ?? [] }],
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
      // The agents' latest moves, for their cursors: redrawn only when one moves.
      const presence = r.presence ?? [];
      const moved = presence.map((p) => `${p.key}@${p.at}:${p.state ?? ''}`).join();
      if (moved !== B.presenceAt) {
        B.presenceAt = moved;
        bset({ presence });
      }
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
// Live team sync (SSE from engine ← WebSocket to collaboration server)

let liveStream = null;
let presenceDraft = {};
let presenceTimer = 0;

function stopLiveStream() {
  if (liveStream) {
    liveStream.close();
    liveStream = null;
  }
  clearTimeout(presenceTimer);
  presenceTimer = 0;
  presenceDraft = {};
}

/** Send our live cursor, selection or page to teammates on the open team board. */
export function sendLivePresence(patch, { immediate = false } = {}) {
  if (!B.id || !B.live) return;
  presenceDraft = { ...presenceDraft, ...patch };
  const fire = () => {
    presenceTimer = 0;
    if (!B.id || !B.live) return;
    const p = { ...presenceDraft, page: B.page, selection: B.sel };
    fetch("/api/cloud/live/presence", {
      method: "POST",
      headers: { "x-screenshotter": "studio", "Content-Type": "application/json" },
      body: JSON.stringify({ id: B.id, p }),
    }).catch(() => undefined);
  };
  if (immediate) {
    clearTimeout(presenceTimer);
    fire();
  } else if (!presenceTimer) {
    presenceTimer = setTimeout(fire, 55);
  }
}

function connectLive(boardId, teamInfo) {
  stopLiveStream();
  B.live = { teamId: teamInfo?.teamId ?? "", teamName: teamInfo?.teamName ?? "", status: "connecting", you: null };
  B.peers = [];
  const es = new EventSource(`/api/cloud/live/stream?board=${encodeURIComponent(boardId)}`);
  liveStream = es;
  es.onmessage = (ev) => {
    if (B.id !== boardId) return;
    let m;
    try {
      m = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (m.t === "state" || m.t === "welcome") {
      B.live = {
        teamId: m.teamId || B.live?.teamId || "",
        teamName: m.teamName || B.live?.teamName || "",
        status: m.status || "connected",
        you: m.you ?? B.live?.you ?? null,
      };
      B.peers = Array.isArray(m.peers) ? m.peers : [];
      if (m.board && (!B.board || m.board.rev > B.board.rev)) {
        B.board = m.board;
        keepSelection();
        notify();
      } else {
        notify(["live", "peers"]);
      }
      if (m.status === "connected" || m.t === "welcome") sendLivePresence({ page: B.page, selection: B.sel }, { immediate: true });
    } else if (m.t === "status") {
      if (B.live) B.live = { ...B.live, status: m.status };
      notify(["live"]);
    } else if (m.t === "ops") {
      if (!B.board || !Array.isArray(m.ops)) return;
      try {
        const res = applyOps(B.board, m.ops);
        B.board = { ...res.board, rev: Math.max(B.board.rev + 1, m.rev ?? B.board.rev + 1), updatedAt: m.updatedAt || new Date().toISOString() };
        keepSelection();
        notify();
      } catch {
        reload({ quiet: true });
      }
    } else if (m.t === "ack") {
      if (B.board && typeof m.rev === "number" && m.rev > B.board.rev) {
        B.board = { ...B.board, rev: m.rev };
      }
    } else if (m.t === "reject" || m.t === "sync") {
      if (m.board) {
        B.board = m.board;
        B.future = [];
        keepSelection();
        notify();
      }
      if (m.t === "reject") toast({ kind: "info", title: "Board updated", text: m.reason || "A change conflicted with a teammate's edit.", timeout: 6000 });
    } else if (m.t === "joined" && m.peer) {
      B.peers = [...B.peers.filter((p) => p.id !== m.peer.id), m.peer];
      notify(["peers"]);
    } else if (m.t === "left" && m.peer) {
      B.peers = B.peers.filter((p) => p.id !== m.peer);
      if (B.following === `peer:${m.peer}`) B.following = null;
      notify(["peers", "following"]);
    } else if (m.t === "presence" && m.peer && m.p) {
      B.peers = B.peers.map((p) => (p.id === m.peer ? { ...p, presence: m.p } : p));
      notify(["peers"]);
    }
  };
  es.onerror = () => {
    if (B.id === boardId && B.live) {
      B.live = { ...B.live, status: "reconnecting" };
      notify(["live"]);
    }
  };
}

/** The boards open as tabs along the top, in the order they were opened; remembered between launches. */
function saveTabs(tabs) {
  set({ tabs });
  try {
    localStorage.setItem("board:tabs", JSON.stringify(tabs));
  } catch {}
}
export function noteTab(id, name) {
  const tabs = S.tabs ?? [];
  const i = tabs.findIndex((t) => t.id === id);
  if (i >= 0 && tabs[i].name === name) return;
  saveTabs(i < 0 ? [...tabs, { id, name }] : tabs.map((t, j) => (j === i ? { id, name } : t)));
}
export function dropTab(id) {
  saveTabs((S.tabs ?? []).filter((t) => t.id !== id));
}
export function restoreTabs() {
  try {
    const tabs = JSON.parse(localStorage.getItem("board:tabs") ?? "[]");
    if (Array.isArray(tabs)) set({ tabs: tabs.filter((t) => t && typeof t.id === "string").map((t) => ({ id: t.id, name: String(t.name ?? "Board") })) });
  } catch {}
}

function hydrateBoard(board, teamInfo) {
  const id = board.id;
  noteTab(id, board.name);
  const remembered = rememberedView(id);
  const clean = { ...board };
  const team = teamInfo || clean._team || null;
  delete clean._team;
  Object.assign(B, {
    id,
    board: clean,
    page: remembered?.page && clean.pages.some((p) => p.id === remembered.page) ? remembered.page : clean.pages[0]?.id,
    sel: [],
    hover: null,
    editing: null,
    renaming: null,
    past: [],
    future: [],
    tool: "move",
    working: [],
    drop: null,
    guides: [],
    open: new Set(),
    comments: { rev: 0, threads: [], agents: clean.agents ?? {} },
    thread: null,
    draft: null,
    talk: "",
    presence: [],
    presenceAt: "",
    peers: [],
    live: null,
    following: null,
  });
  if (remembered?.view) B.view = remembered.view;
  else B.view = { ...B.view, fitPending: true };
  set({ boardId: id });
  try {
    localStorage.setItem("board:last", id);
  } catch {}
  startPolling();
  loadComments();
  if (team) connectLive(id, team);
  else stopLiveStream();
  notify();
}

// ---------------------------------------------------------------------------------------------
// Opening and closing

export async function openBoard(id) {
  try {
    const board = await api(`/api/board?id=${encodeURIComponent(id)}`);
    // From another board (a new tab): close that one first, without showing Home in between.
    if (B.id && B.id !== board.id) closeBoard({ keepScreen: true });
    hydrateBoard(board, board._team);
  } catch (e) {
    // A board that's gone (deleted, or its team left) leaves the tabs too.
    dropTab(id);
    fail(e, "Couldn't open the board");
  }
}

export function openTeamBoardResult(res) {
  if (!res?.board) return;
  hydrateBoard(res.board, res.live);
}

export async function openTeamBoard(id, teamName) {
  try {
    const res = await api("/api/cloud/boards/open", { id, teamName });
    hydrateBoard(res.board, res.live);
  } catch (e) {
    fail(e, "Couldn't open the team board");
  }
}

/**
 * Swap the open board for another. The next board is loaded first, then the two change places in one
 * step, so nothing (Home) shows in between. Only the latest of several quick switches wins.
 */
let switching = 0;
export async function switchBoard(id) {
  if (!B.id) return openBoard(id);
  const mine = ++switching;
  let board;
  try {
    board = await api(`/api/board?id=${encodeURIComponent(id)}`);
  } catch (e) {
    if (mine !== switching) return;
    dropTab(id);
    fail(e, "Couldn't open the board");
    return;
  }
  if (mine !== switching) return;
  closeBoard({ keepScreen: true });
  hydrateBoard(board, board._team);
}

export function closeBoard({ toLibrary = true, keepScreen = false } = {}) {
  const closingId = B.id;
  const wasLive = Boolean(B.live);
  rememberView();
  clearInterval(poll);
  stopLiveStream();
  if (closingId && wasLive) api("/api/cloud/boards/close", { id: closingId }).catch(() => undefined);
  Object.assign(B, { id: null, board: null, sel: [], editing: null, past: [], future: [], thread: null, draft: null, comments: { rev: 0, threads: [], agents: {} }, live: null, peers: [] });
  // keepScreen: another board takes its place straight away (switchBoard), so Home never shows.
  if (keepScreen) return;
  try {
    localStorage.removeItem("board:last");
  } catch {}
  set({ boardId: null });
}

export async function newBoard(name) {
  try {
    const b = await api("/api/board/new", { name });
    await openBoard(b.id);
    // A new board starts with the agent's chat open: that's the quickest way to something on it.
    if (B.id === b.id) bset({ rightTab: "agent" });
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
  if (B.live) sendLivePresence({ selection: sel, page: B.page }, { immediate: true });
}

/** The artboards the selection is on (or all of the page's when nothing is selected). */
export function selectedArtboards() {
  const page = currentPage();
  if (!page) return [];
  if (!B.sel.length) return page.children.slice();
  return [...new Set(B.sel.map((id) => rootOf(B.board, id)))];
}

export { S };
