/**
 * Chats with agents about a board. A chat is a thread kept in the library
 * (.studio/chats/<id>.json): the person's messages and the agent's replies, each reply with the
 * steps it took. Each message runs one turn of the agent (a process of its own), resumed from the
 * agent's own session so it remembers the conversation.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { libraryFolder } from "../util/files.js";
import { getBoard } from "../board/store.js";
import { AGENTS, type AgentId, commandFor, findBin, readLine, toolLabel } from "./agents.js";

export type Part = { kind: "text"; id: string; text: string } | { kind: "tool"; id: string; label: string; name: string };
export interface UserMessage {
  id: string;
  role: "user";
  text: string;
  at: string;
}
export interface AgentMessage {
  id: string;
  role: "agent";
  agent: AgentId;
  parts: Part[];
  status: "working" | "done" | "stopped" | "error";
  error?: string;
  startedAt: string;
  endedAt?: string;
}
export interface Thread {
  id: string;
  board: string;
  agent: AgentId;
  title: string;
  /** The agent's own session, to resume. */
  session?: string;
  createdAt: string;
  updatedAt: string;
  messages: Array<UserMessage | AgentMessage>;
  /** Goes up with every change, for the app to see what's new. */
  rev: number;
}

const dir = () => path.join(libraryFolder(), ".studio", "chats");
const file = (id: string) => path.join(dir(), `${id.replace(/[^a-z0-9]/gi, "")}.json`);
const now = () => new Date().toISOString();
const newId = () => randomBytes(6).toString("hex");

/** Threads being run, kept in memory as they change (saved a moment later). */
const live = new Map<string, { thread: Thread; child?: ChildProcess; saveTimer?: NodeJS.Timeout; stopped?: boolean }>();

function save(t: Thread) {
  mkdirSync(dir(), { recursive: true });
  const f = file(t.id);
  writeFileSync(`${f}.tmp`, JSON.stringify(t));
  renameSync(`${f}.tmp`, f);
}
function saveSoon(t: Thread) {
  const l = live.get(t.id);
  if (!l) return save(t);
  clearTimeout(l.saveTimer);
  l.saveTimer = setTimeout(() => save(t), 400);
}

export function getThread(id: string): Thread {
  const l = live.get(id);
  if (l) return l.thread;
  try {
    return JSON.parse(readFileSync(file(id), "utf8")) as Thread;
  } catch {
    throw new Error("That chat isn't there any more.");
  }
}

/** A board's chats, the newest first. */
export function listThreads(board: string): Array<Pick<Thread, "id" | "agent" | "title" | "updatedAt"> & { working: boolean }> {
  let names: string[] = [];
  try {
    names = readdirSync(dir()).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  const out = [];
  for (const n of names) {
    try {
      const t = live.get(n.slice(0, -5))?.thread ?? (JSON.parse(readFileSync(path.join(dir(), n), "utf8")) as Thread);
      if (t.board !== board) continue;
      const last = t.messages[t.messages.length - 1];
      out.push({ id: t.id, agent: t.agent, title: t.title, updatedAt: t.updatedAt, working: last?.role === "agent" && last.status === "working" });
    } catch {
      // A chat half written: next time.
    }
  }
  return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function deleteThread(id: string) {
  stop(id);
  live.delete(id);
  rmSync(file(id), { force: true });
}

/** What the agent is told about where it is: the board, the page, what's selected. */
function contextFor(board: string, page?: string, selection?: string[]): string {
  const b = getBoard(board);
  const pg = b.pages.find((p) => p.id === page) ?? b.pages[0];
  const sel = (selection ?? []).filter((id) => b.nodes[id]).slice(0, 12);
  return [
    `You're designing in Screenshotter, a canvas of artboards made of real HTML and CSS. The person is looking at the board "${b.name}" (id ${b.id}), on its page "${pg?.name}" (id ${pg?.id}).`,
    sel.length ? `They've selected: ${sel.map((id) => `"${b.nodes[id].name ?? b.nodes[id].type}" (${id})`).join(", ")}. "This" or "it" most likely means that.` : "Nothing is selected.",
    "Use the screenshotter tools (board_read, board_write_html, board_edit, board_screenshot and the rest) to look at the board and change it: the person watches every change land on the canvas. Work on this board unless they ask for another. Don't change files on disk.",
    "Look at your work with board_screenshot before you finish, and fix what's off. When you're done, call board_done, then answer in one or two short plain sentences: what you changed, and anything they should decide.",
  ].join("\n\n");
}

export interface SendOptions {
  thread?: string;
  board: string;
  agent: AgentId;
  text: string;
  page?: string;
  selection?: string[];
}

/** Send a message: a new chat (no `thread`) or the next turn of one. Returns the thread. */
export function send(o: SendOptions): Thread {
  if (!AGENTS[o.agent]) throw new Error(`There's no agent "${o.agent}".`);
  const bin = findBin(AGENTS[o.agent].bin);
  if (!bin) throw new Error(`${AGENTS[o.agent].label} isn't installed on this Mac.`);
  const text = o.text.trim();
  if (!text) throw new Error("Say what you'd like changed.");
  let t: Thread;
  if (o.thread) {
    t = getThread(o.thread);
    const last = t.messages[t.messages.length - 1];
    if (last?.role === "agent" && last.status === "working") throw new Error("The agent is still working on the last message. Stop it first, or wait.");
    // Switching agents mid-chat starts that agent's own conversation.
    if (t.agent !== o.agent) {
      t.agent = o.agent;
      t.session = undefined;
    }
  } else {
    const at = now();
    t = { id: newId(), board: o.board, agent: o.agent, title: text.replace(/\s+/g, " ").slice(0, 60), createdAt: at, updatedAt: at, messages: [], rev: 0 };
  }
  const user: UserMessage = { id: newId(), role: "user", text, at: now() };
  const reply: AgentMessage = { id: newId(), role: "agent", agent: o.agent, parts: [], status: "working", startedAt: now() };
  t.messages.push(user, reply);
  t.updatedAt = now();
  t.rev++;
  live.set(t.id, { thread: t });
  save(t);
  run(t, reply, { bin, prompt: text, context: contextFor(t.board, o.page, o.selection) });
  return t;
}

function run(t: Thread, reply: AgentMessage, o: { bin: string; prompt: string; context: string }) {
  const cwd = path.join(dir(), "work", t.id);
  const { args } = commandFor({ agent: t.agent, bin: o.bin, prompt: o.prompt, context: o.context, session: t.session, cwd, identity: { key: `chat:${t.id}`, name: AGENTS[t.agent].label, kind: t.agent === "agy" ? "antigravity" : t.agent } });
  const child = spawn(o.bin, args, { cwd, env: { ...process.env, NO_COLOR: "1" }, stdio: ["ignore", "pipe", "pipe"] });
  const l = live.get(t.id)!;
  l.child = child;
  const state: Record<string, unknown> = {};
  // What it printed, kept beside the chat for when something needs explaining.
  const raw = createWriteStream(path.join(cwd, "last-run.jsonl"));
  child.stdout.pipe(raw);
  let buf = "";
  let err = "";
  let ended = false;
  const changed = () => {
    t.rev++;
    t.updatedAt = now();
    saveSoon(t);
  };
  const finish = (status: AgentMessage["status"], error?: string) => {
    if (ended) return;
    ended = true;
    reply.status = status;
    if (error) reply.error = error;
    reply.endedAt = now();
    changed();
    const cur = live.get(t.id);
    if (cur) {
      clearTimeout(cur.saveTimer);
      save(t);
      live.delete(t.id);
    }
  };
  const apply = (e: ReturnType<typeof readLine>[number]) => {
    if (e.kind === "session") t.session = e.id;
    else if (e.kind === "text") {
      let p = reply.parts.find((x): x is Extract<Part, { kind: "text" }> => x.kind === "text" && x.id === e.part);
      if (!p) reply.parts.push((p = { kind: "text", id: e.part, text: "" }));
      p.text = e.text != null ? e.text : p.text + (e.delta ?? "");
    } else if (e.kind === "tool") {
      // The agent's own bookkeeping (finding its tools, its to-do list) isn't a step worth showing.
      const label = toolLabel(e.name, e.input);
      if (label) reply.parts.push({ kind: "tool", id: e.id, name: e.name, label });
    }
    else if (e.kind === "done") finish("done");
    else if (e.kind === "error") finish("error", e.message.slice(0, 600));
    changed();
  };
  child.stdout.on("data", (d: Buffer) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line) for (const e of readLine(t.agent, line, state)) apply(e);
    }
  });
  child.stderr.on("data", (d: Buffer) => (err = (err + d.toString()).slice(-4000)));
  child.on("error", (e) => finish("error", e.message));
  child.on("close", (code, signal) => {
    if (buf.trim()) for (const e of readLine(t.agent, buf.trim(), state)) apply(e);
    if (ended) return;
    if (signal || l.stopped) return finish("stopped");
    if (code === 0) return finish("done");
    finish("error", explain(t.agent, err));
  });
}

/** A failed run, said plainly (signing in is the usual one). */
function explain(agent: AgentId, err: string): string {
  const name = AGENTS[agent].label;
  if (/not logged in|log ?in|unauthori[sz]ed|401|authenticat|credential|sign in/i.test(err)) return `${name} isn't signed in. Open it in Terminal once to sign in, then try again.`;
  if (/rate limit|usage limit|quota|429/i.test(err)) return `${name} says you've reached your usage limit for now. Try again later, or switch to another agent.`;
  const last = err.trim().split("\n").filter(Boolean).slice(-2).join(" ").slice(0, 300);
  return `${name} stopped${last ? `: ${last}` : "."}`;
}

/** Stop the turn being run. */
export function stop(id: string) {
  const l = live.get(id);
  if (!l?.child) return;
  l.stopped = true;
  l.child.kill("SIGTERM");
  setTimeout(() => l.child && !l.child.killed && l.child.kill("SIGKILL"), 3000).unref?.();
}

/** Stop every turn (the engine is quitting). */
export function stopAll() {
  for (const id of live.keys()) stop(id);
}
