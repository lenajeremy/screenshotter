/**
 * Agentman, the person's agent manager: a daemon on this Mac that knows every coding agent they
 * have open and can type a message into any of them. A comment on a board reaches the agents that
 * worked on it this way, and the agent's answer shows in Agentman as part of that agent's chat.
 *
 * The daemon listens on a Unix socket (~/.agentman/am.sock, readable by this user only), one JSON
 * envelope a line each way. Events for other apps come down the same connection, so only the
 * envelope that answers ours (its replyTo) counts.
 */
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/** Where the daemon listens. Tests point this at a stand-in so they never reach the person's real agents. */
export const agentmanSocket = () => process.env.SCREENSHOTTER_AGENTMAN_SOCKET || process.env.AGENTMAN_SOCKET || path.join(os.homedir(), ".agentman", "am.sock");

export interface AgentmanSession {
  /** "<kind>:<its own id>", e.g. "claude:7f3c…". */
  id: string;
  kind: string;
  name: string;
  cwd: string;
  state?: string;
  inject?: string;
  question?: unknown;
  lastActivityAt?: number;
}

export interface SendResult {
  status: "delivered" | "queued" | "failed";
  error?: string;
}

const clean = (e: unknown) => String(e ?? "").replace(/^daemon:\s*/, "");

/** One request, on a connection of its own. */
export function agentmanCall(payload: Record<string, unknown>, timeoutMs = 4000): Promise<Record<string, any>> {
  return new Promise((resolve, reject) => {
    const id = `screenshotter-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const sock = net.createConnection(agentmanSocket());
    sock.setEncoding("utf8");
    let buf = "";
    let done = false;
    const finish = (err: Error | null, value?: Record<string, any>) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      sock.destroy();
      if (err) reject(err);
      else resolve(value ?? {});
    };
    const timer = setTimeout(() => finish(new Error("Agentman didn't answer in time")), timeoutMs);
    sock.on("connect", () => sock.write(`${JSON.stringify({ v: 2, id, to: "daemon", payload })}\n`));
    sock.on("data", (chunk: string) => {
      buf += chunk;
      for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        try {
          const env = JSON.parse(line);
          if (env?.replyTo === id) return finish(null, env.payload ?? {});
        } catch {
          // Not a frame: skip it.
        }
      }
    });
    sock.on("error", (e: NodeJS.ErrnoException) =>
      finish(new Error(e.code === "ENOENT" || e.code === "ECONNREFUSED" ? "Agentman isn't running" : `Couldn't reach Agentman (${e.code ?? e.message})`)),
    );
    sock.on("close", () => finish(new Error("Agentman closed the connection before answering")));
  });
}

export async function listSessions(timeoutMs = 3000): Promise<AgentmanSession[]> {
  const e = await agentmanCall({ type: "list_sessions" }, timeoutMs);
  if (e.type === "error") throw new Error(clean(e.error) || "Agentman couldn't list its agents");
  return Array.isArray(e.sessions) ? e.sessions : [];
}

/** The sessions, asked again only when the last answer is older than `maxAgeMs` (the Studio polls this). */
let recent: { at: number; sessions: Promise<AgentmanSession[]> } | null = null;
export function liveSessions(maxAgeMs = 1500): Promise<AgentmanSession[]> {
  if (!recent || Date.now() - recent.at > maxAgeMs) {
    const sessions = listSessions(2500);
    recent = { at: Date.now(), sessions };
    sessions.catch(() => (recent = null));
  }
  return recent.sessions;
}

/**
 * Agentman takes no terminal control characters (it types the message into the agent's prompt)
 * and nothing over 64 KB.
 */
export function sendableText(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f‎‏؜‪-‮⁦-⁩]/g, "")
    .slice(0, 60_000);
}

/** Type a message into an agent's chat, as Agentman does for the person. */
export async function sendToAgent(sessionId: string, text: string, clientId?: string): Promise<SendResult> {
  try {
    // Typing it into a terminal agent can take a few seconds.
    const e = await agentmanCall({ type: "send_message", sessionId, text: sendableText(text), ...(clientId ? { clientId: clientId.slice(0, 200) } : {}) }, 20_000);
    if (e.type === "error") return { status: "failed", error: clean(e.error) || "Agentman refused the message" };
    if (e.status === "failed") return { status: "failed", error: clean(e.error) || "The agent didn't take the message" };
    return { status: e.status === "queued" ? "queued" : "delivered" };
  } catch (err) {
    return { status: "failed", error: (err as Error).message };
  }
}

// ---------------------------------------------------------------------------------------------
// Which agent is this? The MCP server runs as a child of the agent that uses it, and nothing tells
// it the agent's Agentman session, so it looks: its own ancestors first, then the tmux pane it
// runs in, and last the agents Agentman lists in its folder.

export interface AgentIdentity {
  key: string;
  session?: string;
  how?: "process" | "tmux" | "folder";
  kind: string;
  name: string;
  cwd?: string;
}

/** The processes above this one, nearest first, with their command names. */
async function ancestors(): Promise<Array<{ pid: number; comm: string }>> {
  const out: Array<{ pid: number; comm: string }> = [];
  try {
    const { stdout } = await run("ps", ["-axo", "pid=,ppid=,comm="], { timeout: 3000, maxBuffer: 8 * 1024 * 1024 });
    const table = new Map<number, { ppid: number; comm: string }>();
    for (const line of stdout.split("\n")) {
      const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
      if (m) table.set(Number(m[1]), { ppid: Number(m[2]), comm: m[3].trim() });
    }
    let pid = process.ppid;
    for (let i = 0; i < 40 && pid > 1; i++) {
      const p = table.get(pid);
      out.push({ pid, comm: p?.comm ?? "" });
      if (!p) break;
      pid = p.ppid;
    }
  } catch {
    // No ps: the direct parent is still known.
    if (!out.length) out.push({ pid: process.ppid, comm: "" });
  }
  return out;
}

/** Claude Code keeps a record of each running session by its process id. */
function claudeSessionOf(pid: number): { sessionId: string; name?: string; cwd?: string } | undefined {
  const home = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
  try {
    const s = JSON.parse(readFileSync(path.join(home, "sessions", `${pid}.json`), "utf8"));
    if (typeof s?.sessionId === "string" && s.sessionId) return { sessionId: s.sessionId, name: typeof s.name === "string" ? s.name : undefined, cwd: typeof s.cwd === "string" ? s.cwd : undefined };
  } catch {}
  return undefined;
}

const KINDS: Array<[RegExp, string]> = [
  [/(^|\/)claude(\.exe)?$/i, "claude"],
  [/(^|\/)codex(\.[cm]?js)?$/i, "codex"],
  [/(^|\/)cursor-agent$/i, "cursor-cli"],
  [/(^|\/)opencode$/i, "opencode"],
  [/(^|\/)kiro(-cli)?$/i, "kiro"],
  [/(^|\/)(agy|antigravity)$/i, "antigravity"],
];

const KIND_NAMES: Record<string, string> = { claude: "Claude", codex: "Codex", "cursor-cli": "Cursor", opencode: "OpenCode", kiro: "Kiro", antigravity: "Antigravity", muse: "Muse", agent: "Agent" };
export const kindName = (kind: string) => KIND_NAMES[kind] ?? kind.charAt(0).toUpperCase() + kind.slice(1);

/** The tmux session this process runs in, when there is one. */
async function tmuxSessionName(): Promise<string | undefined> {
  const pane = process.env.TMUX_PANE;
  if (!pane || !process.env.TMUX) return undefined;
  try {
    const { stdout } = await run("tmux", ["display-message", "-p", "-t", pane, "#S"], { timeout: 2000 });
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

/** Agentman's own name for a session (what the person sees there), if it's running. */
async function sessionsOrNone(): Promise<AgentmanSession[] | undefined> {
  try {
    return await listSessions(1500);
  } catch {
    return undefined;
  }
}

/** A session id for an agent found by its folder: only when Agentman lists exactly one such agent there. */
export function sessionInFolder(sessions: AgentmanSession[], kind: string, cwd: string | undefined): { session?: AgentmanSession; count: number } {
  if (!cwd) return { count: 0 };
  const same = (a: string) => path.resolve(a) === path.resolve(cwd);
  const here = sessions.filter((s) => s.cwd && same(s.cwd) && s.state !== "ended" && (kind === "agent" || s.kind === kind));
  return { session: here.length === 1 ? here[0] : undefined, count: here.length };
}

export async function findIdentity(): Promise<AgentIdentity> {
  const chain = await ancestors();
  let kind = "agent";
  for (const p of chain) {
    const hit = KINDS.find(([re]) => re.test(p.comm));
    if (hit) {
      kind = hit[1];
      break;
    }
  }
  if (kind === "agent" && process.env.CLAUDECODE) kind = "claude";
  let found: Omit<AgentIdentity, "key" | "name"> & { name?: string } = { kind, cwd: process.cwd() };

  // 1. Claude Code: an ancestor's record says which session it is.
  for (const p of chain) {
    const s = claudeSessionOf(p.pid);
    if (s) {
      found = { session: `claude:${s.sessionId}`, how: "process", kind: "claude", name: s.name, cwd: s.cwd ?? found.cwd };
      break;
    }
  }
  // 2. An agent Agentman started in tmux: the pane's name holds the session.
  if (!found.session) {
    const pane = await tmuxSessionName();
    const m = pane && /^agentman-([a-z-]+?)-(.+)$/.exec(pane);
    if (m && m[1] === "claude") found = { ...found, session: `claude:${m[2]}`, how: "tmux", kind: "claude" };
    else if (m && m[1] === "codex") found = { ...found, session: `codex:tmux-${pane}`, how: "tmux", kind: "codex" };
    else if (m && KIND_NAMES[m[1]]) found = { ...found, kind: m[1] };
  }
  const sessions = await sessionsOrNone();
  if (sessions) {
    const known = found.session ? sessions.find((s) => s.id === found.session) : undefined;
    if (known) found = { ...found, name: known.name || found.name, kind: known.kind || found.kind };
    else {
      // 3. The only agent of its kind Agentman lists in this folder (a guess: two could share one).
      const { session } = sessionInFolder(sessions, found.kind, found.cwd);
      if (session && (!found.session || found.how === "tmux")) found = { ...found, session: session.id, how: "folder", kind: session.kind || found.kind, name: session.name || found.name };
    }
  }
  const name = found.name?.trim() || `${kindName(found.kind)}${found.cwd ? ` in ${path.basename(found.cwd)}` : ""}`;
  const key = found.session ?? `local:${found.kind}:${found.cwd ?? "?"}`;
  return { key, name: name.slice(0, 80), kind: found.kind, ...(found.session ? { session: found.session, how: found.how } : {}), ...(found.cwd ? { cwd: found.cwd } : {}) };
}

let me: Promise<AgentIdentity> | undefined;
/**
 * This MCP server's agent, worked out once: the server lives as long as its agent's session. A
 * guess from the folder is tried again later, in case Agentman wasn't running the first time.
 */
export function whoAmI(): Promise<AgentIdentity> {
  me ??= findIdentity().then((id) => {
    if (!id.session || id.how === "folder") setTimeout(() => (me = undefined), 60_000).unref?.();
    return id;
  });
  return me;
}
