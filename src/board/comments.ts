/**
 * Comments on a board: threads pinned to a layer, or to a region of an artboard, between the person
 * and the agents that worked on it. They live beside the board (comments/<id>.json), not in it, so
 * undoing the design never touches them, and they're written under their own lock, as the board is.
 *
 * What the person writes goes to the agents it names through Agentman (it lands in each agent's own
 * chat, so the agent's answer shows in Agentman too). Agents answer with board_comment, which adds
 * to the thread here, and the Studio picks it up as it does an agent's change to the design.
 */
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { listSessions, liveSessions, sendToAgent, sessionInFolder, type AgentmanSession } from "./agentman.js";
import { defaultRecipients, newId, pageOf, plainText, rootOf, round, subtree, type Board, type BoardAgent } from "./core.js";
import { changeBoard, commentsFile, getBoard, validBoardId, withFileLock } from "./store.js";

export interface CommentAnchor {
  page: string;
  /** The artboard it's on. */
  artboard: string;
  /** The layer it's pinned to (the artboard itself, or a layer inside it). */
  layer?: string;
  /** Or a region of the artboard, in the artboard's own coordinates, and the layers inside it. */
  rect?: { x: number; y: number; width: number; height: number };
  layers?: string[];
  /** Where on the layer the pin sits, as fractions of its box. */
  at?: { x: number; y: number };
  /** The layers' names when the comment was made, for when they've gone. */
  names: Record<string, string>;
}

export type DeliveryStatus = "sending" | "delivered" | "queued" | "failed";

export interface Delivery {
  status: DeliveryStatus;
  error?: string;
  at: string;
  /** The Agentman session it went to. */
  session?: string;
  /** The session was the only agent in the agent's folder: probably right, not certain. */
  guess?: boolean;
}

export interface CommentMessage {
  id: string;
  /** "person", or the key of the agent (on the board) that wrote it. */
  by: string;
  /** The agent's name as it wrote. */
  name?: string;
  text: string;
  createdAt: string;
  /** The agents told about it, by key. */
  to?: string[];
  /** How telling each of them went. */
  delivery?: Record<string, Delivery>;
}

export interface CommentThread {
  id: string;
  anchor: CommentAnchor;
  messages: CommentMessage[];
  resolved?: { at: string; by: string };
  createdAt: string;
  updatedAt: string;
}

export interface BoardComments {
  rev: number;
  threads: CommentThread[];
}

const MAX_TEXT = 8000;

function read(id: string): BoardComments {
  try {
    const c = JSON.parse(readFileSync(commentsFile(id), "utf8"));
    if (Array.isArray(c?.threads)) return { rev: Number(c.rev) || 0, threads: c.threads };
  } catch {}
  return { rev: 0, threads: [] };
}

export function getComments(id: unknown): BoardComments {
  if (!validBoardId(id)) throw new Error("Unknown board");
  return read(id);
}

/** Change a board's comments under their lock; every change goes up a revision, so the Studio sees it. */
export function changeComments<T>(id: string, fn: (c: BoardComments) => T): { comments: BoardComments; result: T } {
  if (!validBoardId(id)) throw new Error("Unknown board");
  const file = commentsFile(id);
  return withFileLock(file, () => {
    const c = read(id);
    const result = fn(c);
    c.rev += 1;
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(c));
    renameSync(tmp, file);
    return { comments: c, result };
  });
}

const threadIn = (c: BoardComments, id: string) => {
  const t = c.threads.find((x) => x.id === id);
  if (!t) throw new Error(`There's no comment ${id} on this board (it may have been deleted). board_comments lists them.`);
  return t;
};

const cleanText = (text: unknown) => {
  const t = String(text ?? "").replace(/\r\n?/g, "\n").trim();
  if (!t) throw new Error("Write something first.");
  return t.slice(0, MAX_TEXT);
};

// ---------------------------------------------------------------------------------------------
// Anchors

export interface AnchorInput {
  layer?: string;
  artboard?: string;
  rect?: { x: number; y: number; width: number; height: number };
  layers?: string[];
  at?: { x: number; y: number };
}

const finite = (n: unknown) => typeof n === "number" && Number.isFinite(n);

/** An anchor checked against the board: the layer (or artboard and region) must be on it. */
export function anchorFor(board: Board, a: AnchorInput): CommentAnchor {
  const names: Record<string, string> = {};
  const name = (id: string) => (names[id] = board.nodes[id]?.name ?? id);
  if (a.layer) {
    if (!board.nodes[a.layer]) throw new Error(`There's no layer ${a.layer} on this board.`);
    const artboard = rootOf(board, a.layer);
    name(a.layer);
    name(artboard);
    const at = a.at && finite(a.at.x) && finite(a.at.y) ? { x: round(Math.min(1, Math.max(0, a.at.x)), 4), y: round(Math.min(1, Math.max(0, a.at.y)), 4) } : undefined;
    return { page: pageOf(board, artboard)?.id ?? board.pages[0].id, artboard, layer: a.layer, ...(at ? { at } : {}), names };
  }
  const r = a.rect;
  if (!a.artboard || !board.nodes[a.artboard] || !r || ![r.x, r.y, r.width, r.height].every(finite)) throw new Error("A comment goes on a layer, or on a region (an artboard and a rect in it).");
  const artboard = rootOf(board, a.artboard);
  const inside = new Set(subtree(board, artboard));
  const layers = [...new Set(a.layers ?? [])].filter((id) => inside.has(id)).slice(0, 40);
  name(artboard);
  for (const id of layers) name(id);
  const rect = { x: Math.round(r.x), y: Math.round(r.y), width: Math.max(1, Math.round(r.width)), height: Math.max(1, Math.round(r.height)) };
  return { page: pageOf(board, artboard)?.id ?? board.pages[0].id, artboard, rect, layers, names };
}

const layerRef = (board: Board, a: CommentAnchor, id: string) => {
  const n = board.nodes[id];
  return n ? `"${n.name}" (#${id})` : `"${a.names[id] ?? id}" (#${id}, deleted since)`;
};

/** What a comment is on, in words, with every layer's id. */
export function describeAnchor(board: Board, a: CommentAnchor): string {
  const art = layerRef(board, a, a.artboard);
  if (a.layer && a.layer !== a.artboard) {
    const n = board.nodes[a.layer];
    const what = n ? (n.type === "text" ? `the text ${layerRef(board, a, a.layer)}, which says "${plainText(n.text).slice(0, 80)}"` : `the layer ${layerRef(board, a, a.layer)}`) : `the layer ${layerRef(board, a, a.layer)}`;
    return `${what}, on the artboard ${art}`;
  }
  if (a.layer) return `the artboard ${art} as a whole`;
  const r = a.rect!;
  const layers = a.layers ?? [];
  const covering = layers.length ? `, covering ${layers.slice(0, 8).map((id) => layerRef(board, a, id)).join(", ")}${layers.length > 8 ? ` and ${layers.length - 8} more` : ""}` : "";
  return `a region of the artboard ${art} (x ${r.x}, y ${r.y}, ${r.width}×${r.height} in the artboard's coordinates)${covering}`;
}

// ---------------------------------------------------------------------------------------------
// Threads

const now = () => new Date().toISOString();

export interface Post {
  text: string;
  /** "person" or an agent's key. */
  by: string;
  name?: string;
  /** Agents to tell (keys); left out, the comment goes to the usual ones (see defaultRecipients). */
  to?: string[];
}

function message(board: Board, p: Post): CommentMessage {
  const at = now();
  const to = p.by === "person" ? [...new Set(p.to ?? [])].filter((k) => board.agents?.[k]) : [];
  return {
    id: newId(10),
    by: p.by,
    ...(p.name ? { name: p.name.slice(0, 80) } : {}),
    text: cleanText(p.text),
    createdAt: at,
    ...(to.length ? { to, delivery: Object.fromEntries(to.map((k) => [k, { status: "sending" as const, at }])) } : {}),
  };
}

export function startThread(boardId: string, anchor: AnchorInput, p: Post) {
  const board = getBoard(boardId);
  const a = anchorFor(board, anchor);
  const m = message(board, { ...p, to: p.to ?? defaultRecipients(board, a.artboard) });
  const at = m.createdAt;
  const thread: CommentThread = { id: newId(10), anchor: a, messages: [m], createdAt: at, updatedAt: at };
  const { comments } = changeComments(boardId, (c) => c.threads.push(thread));
  return { thread, message: m, rev: comments.rev };
}

export function reply(boardId: string, threadId: string, p: Post) {
  const board = getBoard(boardId);
  const before = threadIn(read(boardId), threadId);
  const m = message(board, { ...p, to: p.to ?? defaultRecipients(board, before.anchor.artboard, before.messages) });
  const { comments, result } = changeComments(boardId, (c) => {
    const t = threadIn(c, threadId);
    t.messages.push(m);
    t.updatedAt = m.createdAt;
    // Answering a resolved comment opens it again.
    delete t.resolved;
    return t;
  });
  return { thread: result, message: m, rev: comments.rev };
}

/**
 * Agents the person tagged who haven't worked on the board: Agentman's sessions by their ids. They
 * join the board's agents, so the comment can go to them and they show by name.
 */
export async function bringIn(boardId: string, keys: string[] | undefined): Promise<void> {
  const board = getBoard(boardId);
  const missing = [...new Set(keys ?? [])].filter((k) => !board.agents?.[k]);
  if (!missing.length) return;
  let sessions: AgentmanSession[] = [];
  try {
    sessions = await liveSessions();
  } catch {
    return;
  }
  const at = now();
  const ops = sessions
    .filter((s) => missing.includes(s.id) && s.state !== "ended")
    .map((s) => ({ op: "agent" as const, agent: { key: s.id, session: s.id, kind: s.kind || "agent", name: s.name || s.id, cwd: s.cwd }, at }));
  if (ops.length) changeBoard(boardId, ops, "studio", undefined, { expand: false });
}

/**
 * What the board's agents are doing now, by Agentman (busy, idle, waiting_input, ended), and the
 * other agents it runs, to tag. Empty when Agentman isn't running.
 */
export async function agentsNow(boardId: string): Promise<{ states: Record<string, string>; others: { key: string; name: string; kind: string; folder: string; state?: string }[]; agentman: boolean }> {
  const board = getBoard(boardId);
  let sessions: AgentmanSession[];
  try {
    sessions = await liveSessions();
  } catch {
    return { states: {}, others: [], agentman: false };
  }
  const states: Record<string, string> = {};
  for (const a of Object.values(board.agents ?? {})) {
    const s = a.session ? sessions.find((x) => x.id === a.session) : undefined;
    if (s?.state) states[a.key] = s.state;
  }
  const taken = new Set(Object.values(board.agents ?? {}).flatMap((a) => [a.key, a.session]));
  const others = sessions
    .filter((s) => s.state !== "ended" && !taken.has(s.id))
    .map((s) => ({ key: s.id, name: s.name || s.id, kind: s.kind, folder: s.cwd ? path.basename(s.cwd) : "", state: s.state }));
  return { states, others, agentman: true };
}

/** Resolving is the person's call: they asked, they say when it's done. */
export function setResolved(boardId: string, threadId: string, resolved: boolean, by: string) {
  const { comments, result } = changeComments(boardId, (c) => {
    const t = threadIn(c, threadId);
    if (resolved) t.resolved = { at: now(), by };
    else delete t.resolved;
    t.updatedAt = now();
    return t;
  });
  return { thread: result, rev: comments.rev };
}

/** Delete a thread, or one message in it (the first message is the comment: deleting it deletes the thread). */
export function remove(boardId: string, threadId: string, messageId?: string) {
  const { comments } = changeComments(boardId, (c) => {
    const t = threadIn(c, threadId);
    const i = messageId ? t.messages.findIndex((m) => m.id === messageId) : 0;
    if (i < 0) throw new Error("That reply isn't in the thread any more.");
    if (i === 0) c.threads = c.threads.filter((x) => x !== t);
    else t.messages.splice(i, 1);
  });
  return { rev: comments.rev };
}

// ---------------------------------------------------------------------------------------------
// Telling agents

const quote = (text: string) =>
  text
    .split("\n")
    .map((l) => `> ${l}`)
    .join("\n");

const short = (text: string, n = 220) => {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/** Who wrote a message, as the agent `to` reads it. */
function authorFor(board: Board, m: CommentMessage, to: string): string {
  if (m.by === "person") return "The user";
  if (m.by === to) return "You";
  return board.agents?.[m.by]?.name ?? m.name ?? "Another agent";
}

/** The message an agent gets: where the comment is, what it says, and how to answer. */
export function messageFor(board: Board, thread: CommentThread, m: CommentMessage, to: string): string {
  const first = thread.messages[0]?.id === m.id;
  const where = `the board "${board.name}" (id ${board.id})`;
  const lines = [
    first ? `(From Screenshotter) The user left a comment for you on ${where}, comment ${thread.id}:` : `(From Screenshotter) The user replied on comment ${thread.id}, on ${where}:`,
    "",
    quote(m.text),
    "",
  ];
  const earlier = thread.messages.slice(0, thread.messages.findIndex((x) => x.id === m.id)).slice(-4);
  if (earlier.length) {
    lines.push("The thread before this:", ...earlier.map((x) => `- ${authorFor(board, x, to)}: ${short(x.text)}`), "");
  }
  lines.push(
    `It's on ${describeAnchor(board, thread.anchor)}.`,
    "",
    `Answer in the thread with Screenshotter's MCP tool board_comment { board: "${board.id}", comment: "${thread.id}", reply: "…" }; the user sees your reply on the board in the Studio. If the comment asks for a change, make it on the board (board_read, board_edit, board_write_html), look at it with board_screenshot, then reply saying what you changed. The user resolves the comment when they're happy with it.`,
  );
  return lines.join("\n");
}

const FRIENDLY: Array<[RegExp, string]> = [
  [/answer the pending question/i, "it's waiting on a question: answer it in Agentman, then try again"],
  [/unknown session|no such session|session not found/i, "Agentman doesn't know that agent's session any more"],
];
const friendly = (e: string) => FRIENDLY.find(([re]) => re.test(e))?.[1] ?? e;

/** Which Agentman session to send to, or why there's none. */
function sessionFor(agent: BoardAgent | undefined, sessions: AgentmanSession[] | null, down: string | null): { session?: string; guess?: boolean; error?: string } {
  if (!agent) return { error: "That agent isn't on this board any more" };
  if (!sessions) return { error: down ?? "Agentman isn't running" };
  const listed = agent.session ? sessions.find((s) => s.id === agent.session) : undefined;
  if (listed) {
    if (listed.state === "ended") return { error: "its session has ended" };
    return { session: listed.id, guess: agent.how === "folder" };
  }
  // Not listed by its id (or it had none): the only agent of its kind in its folder, if there's one.
  const { session, count } = sessionInFolder(sessions, agent.kind, agent.cwd);
  if (session) return { session: session.id, guess: true };
  const folder = agent.cwd ? path.basename(agent.cwd) : "its folder";
  if (count > 1) return { error: `Agentman lists ${count} agents in ${folder}, and can't tell which one worked here` };
  return { error: agent.session ? "Agentman doesn't list its session (it may have ended)" : `Agentman doesn't list an agent in ${folder}` };
}

/**
 * Send a message to the agents it names (or just `only` of them, to try again), and keep how each
 * went with it. The comment is saved first, whatever happens here.
 */
export async function deliver(boardId: string, threadId: string, messageId: string, only?: string[]): Promise<void> {
  const thread = read(boardId).threads.find((t) => t.id === threadId);
  const m = thread?.messages.find((x) => x.id === messageId);
  if (!thread || !m?.to?.length) return;
  const keys = only?.length ? m.to.filter((k) => only.includes(k)) : m.to;
  if (!keys.length) return;
  const results: Record<string, Delivery> = {};
  try {
    const board = getBoard(boardId);
    let sessions: AgentmanSession[] | null = null;
    let down: string | null = null;
    try {
      sessions = await listSessions();
    } catch (e) {
      down = (e as Error).message;
    }
    for (const key of keys) {
      const s = sessionFor(board.agents?.[key], sessions, down);
      if (!s.session) {
        results[key] = { status: "failed", error: s.error, at: now() };
        continue;
      }
      const sent = await sendToAgent(s.session, messageFor(board, thread, m, key), `screenshotter-${m.id}`);
      results[key] = { status: sent.status, ...(sent.error ? { error: friendly(sent.error) } : {}), at: now(), session: s.session, ...(s.guess ? { guess: true } : {}) };
    }
  } catch (e) {
    // Never left "sending": whoever wasn't reached is marked so, with why.
    for (const key of keys) results[key] ??= { status: "failed", error: (e as Error).message, at: now() };
  }
  try {
    changeComments(boardId, (c) => {
      const t = c.threads.find((x) => x.id === threadId);
      const mm = t?.messages.find((x) => x.id === messageId);
      if (mm) mm.delivery = { ...(mm.delivery ?? {}), ...results };
    });
  } catch {
    // The board went while it was being sent.
  }
}

/** Mark recipients as being sent to again, before `deliver` tries them. */
export function markSending(boardId: string, threadId: string, messageId: string, keys: string[]) {
  return changeComments(boardId, (c) => {
    const m = threadIn(c, threadId).messages.find((x) => x.id === messageId);
    if (!m) throw new Error("That reply isn't in the thread any more.");
    const want = keys.filter((k) => m.to?.includes(k));
    m.delivery = { ...(m.delivery ?? {}), ...Object.fromEntries(want.map((k) => [k, { status: "sending" as const, at: now() }])) };
    return want;
  }).result;
}

// ---------------------------------------------------------------------------------------------
// For agents: threads as an agent reads them

/** The keys an agent may have on a board: its own, and any other with the same session. */
export function keysOf(board: Board, me: { key: string; session?: string }): Set<string> {
  const keys = new Set([me.key]);
  for (const a of Object.values(board.agents ?? {})) if (me.session && a.session === me.session) keys.add(a.key);
  return keys;
}

export function threadForAgent(board: Board, t: CommentThread, mine: Set<string>) {
  const last = t.messages[t.messages.length - 1];
  const whose = (m: CommentMessage) => (m.by === "person" ? "user" : mine.has(m.by) ? "you" : board.agents?.[m.by]?.name ?? m.name ?? "another agent");
  const lastFromMe = [...t.messages].reverse().findIndex((m) => mine.has(m.by));
  const after = lastFromMe < 0 ? t.messages : t.messages.slice(t.messages.length - lastFromMe);
  return {
    comment: t.id,
    on: describeAnchor(board, t.anchor),
    anchor: { artboard: t.anchor.artboard, ...(t.anchor.layer ? { layer: t.anchor.layer } : {}), ...(t.anchor.rect ? { rect: t.anchor.rect, layers: t.anchor.layers } : {}) },
    ...(t.resolved ? { resolved: true } : {}),
    // The user wrote to this agent after it last answered.
    waitingOnYou: !t.resolved && last?.by === "person" && after.some((m) => m.by === "person" && m.to?.some((k) => mine.has(k))),
    messages: t.messages.map((m) => ({ id: m.id, from: whose(m), text: m.text, at: m.createdAt, ...(m.to?.length ? { to: m.to.map((k) => (mine.has(k) ? "you" : board.agents?.[k]?.name ?? k)) } : {}) })),
  };
}
