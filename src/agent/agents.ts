/**
 * The coding agents the app can talk to, on the person's own subscriptions: Claude Code, Codex,
 * opencode and Antigravity (agy), each run headless for one turn of a chat, with Screenshotter's
 * MCP server (this engine) as its tools. What each prints is read into one shape: the session to
 * resume next time, words as they're written, and the tools it used.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { libraryFolder } from "../util/files.js";

export type AgentId = "claude" | "codex" | "opencode" | "agy";

export const AGENTS: Record<AgentId, { label: string; bin: string }> = {
  claude: { label: "Claude Code", bin: "claude" },
  codex: { label: "Codex", bin: "codex" },
  opencode: { label: "opencode", bin: "opencode" },
  agy: { label: "Antigravity", bin: "agy" },
};
export const AGENT_IDS = Object.keys(AGENTS) as AgentId[];

/** Where a program is: on the PATH, or where its installer usually puts it. */
export function findBin(bin: string): string | undefined {
  const home = os.homedir();
  const dirs = [
    ...(process.env.PATH ?? "").split(":"),
    path.join(home, ".local/bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    path.join(home, ".npm-global/bin"),
    path.join(home, ".bun/bin"),
    path.join(home, ".opencode/bin"),
    path.join(home, ".claude/local"),
  ].filter(Boolean);
  for (const d of dirs) {
    const p = path.join(d, bin);
    if (existsSync(p)) return p;
  }
  return undefined;
}

/** The agents on this Mac, in the order they're offered. */
export function installedAgents(): { id: AgentId; label: string; path: string }[] {
  return AGENT_IDS.flatMap((id) => {
    const p = findBin(AGENTS[id].bin);
    return p ? [{ id, label: AGENTS[id].label, path: p }] : [];
  });
}

/** This engine as an MCP server: the same Node, the built entry beside this file. */
function mcpServer(identity: { key: string; name: string; kind: string }) {
  const here = fileURLToPath(import.meta.url);
  const entry = here.endsWith(".ts") ? path.resolve(path.dirname(here), "../../dist/index.js") : path.resolve(path.dirname(here), "../index.js");
  const env: Record<string, string> = { SCREENSHOTTER_OUTPUT_DIR: libraryFolder(), SCREENSHOTTER_AGENT_IDENTITY: JSON.stringify(identity) };
  for (const k of ["SCREENSHOTTER_STUDIO_FILE", "SCREENSHOTTER_AGENTMAN_SOCKET", "SCREENSHOTTER_CHROME_PATH", "SCREENSHOTTER_CACHE_DIR", "FIGMA_TOKEN", "UNSPLASH_ACCESS_KEY", "SCREENSHOTTER_NO_KEYCHAIN"]) {
    if (process.env[k]) env[k] = process.env[k]!;
  }
  return { command: process.execPath, args: [entry], env };
}

export interface RunSpec {
  agent: AgentId;
  bin: string;
  /** What the person wrote, with the context in front on a new conversation. */
  prompt: string;
  /** About the board and how to work (Claude Code takes it as its system prompt). */
  context: string;
  session?: string;
  /** The chat's own folder: agents keep their sessions by folder, so it stays the same. */
  cwd: string;
  identity: { key: string; name: string; kind: string };
}

const toml = (s: string) => JSON.stringify(s);

/** Screenshotter's MCP tools (the ones an agent may use without asking). */
export const BOARD_TOOLS = ["board_list", "board_create", "board_read", "board_write_html", "board_edit", "board_screenshot", "board_export", "board_import_website", "board_import_figma", "board_comment", "board_comments", "board_done"];

/** The command line for one turn. */
export function commandFor(o: RunSpec): { args: string[] } {
  mkdirSync(o.cwd, { recursive: true });
  const server = mcpServer(o.identity);
  const first = o.session ? o.prompt : `${o.context}\n\n${o.prompt}`;
  switch (o.agent) {
    case "claude":
      return {
        args: [
          "-p",
          o.prompt,
          "--output-format",
          "stream-json",
          "--verbose",
          "--include-partial-messages",
          "--strict-mcp-config",
          "--mcp-config",
          JSON.stringify({ mcpServers: { screenshotter: { type: "stdio", ...server } } }),
          "--allowedTools",
          "mcp__screenshotter",
          "--append-system-prompt",
          o.context,
          ...(o.session ? ["--resume", o.session] : []),
        ],
      };
    case "codex": {
      const cfg = [
        `mcp_servers.screenshotter.command=${toml(server.command)}`,
        `mcp_servers.screenshotter.args=[${server.args.map(toml).join(",")}]`,
        `mcp_servers.screenshotter.env={${Object.entries(server.env)
          .map(([k, v]) => `${k}=${toml(v)}`)
          .join(",")}}`,
        // Its own board tools need no asking; anything else stays read-only.
        `mcp_servers.screenshotter.default_tools_approval_mode="approve"`,
        `approval_policy="never"`,
      ].flatMap((c) => ["-c", c]);
      const common = ["--json", "--skip-git-repo-check", "-s", "read-only", ...cfg];
      return { args: o.session ? ["exec", "resume", ...common, o.session, o.prompt] : ["exec", ...common, "-C", o.cwd, first] };
    }
    case "opencode":
      // Its MCP servers come from the folder's own config, kept beside the chat.
      writeFileSync(
        path.join(o.cwd, "opencode.json"),
        JSON.stringify({ $schema: "https://opencode.ai/config.json", mcp: { screenshotter: { type: "local", command: [server.command, ...server.args], environment: server.env, enabled: true } } }, null, 2),
      );
      // A server of its own (--standalone): the shared one doesn't read this folder's config.
      return { args: ["run", "--standalone", "--format", "json", "--auto", ...(o.session ? ["--session", o.session] : []), first] };
    case "agy": {
      // Its MCP servers are the person's own (mcp_config.json); its board tools are allowed for
      // this run only (settings passed here are never saved).
      const allow = BOARD_TOOLS.map((t) => `mcp(screenshotter/${t})`);
      return { args: ["-p", first, "--output-format", "stream-json", "--settings", JSON.stringify({ permissions: { allow } }), ...(o.session ? ["--conversation", o.session] : [])] };
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Reading what they print

export type AgentEvent =
  | { kind: "session"; id: string }
  /** Words as they come: `part` says which run of words (a new one starts after a tool). */
  | { kind: "text"; part: string; delta?: string; text?: string }
  | { kind: "tool"; id: string; name: string; input?: unknown }
  | { kind: "done" }
  | { kind: "error"; message: string };

/** One line of output, as events. `state` carries what a reader needs between lines. */
export function readLine(agent: AgentId, line: string, state: Record<string, unknown>): AgentEvent[] {
  let j: any;
  try {
    j = JSON.parse(line);
  } catch {
    return [];
  }
  const out: AgentEvent[] = [];
  if (agent === "claude") {
    if (j.session_id && !state.session) {
      state.session = j.session_id;
      out.push({ kind: "session", id: j.session_id });
    }
    if (j.type === "stream_event") {
      const e = j.event ?? {};
      if (e.type === "message_start") state.msg = e.message?.id ?? String(Math.random());
      if (e.type === "content_block_delta" && e.delta?.type === "text_delta") {
        state.streamed = true;
        out.push({ kind: "text", part: `${state.msg}:${e.index ?? 0}`, delta: e.delta.text });
      }
    } else if (j.type === "assistant") {
      const id = j.message?.id ?? "m";
      (j.message?.content ?? []).forEach((c: any, i: number) => {
        if (c.type === "tool_use") out.push({ kind: "tool", id: c.id ?? `${id}:${i}`, name: c.name, input: c.input });
        // Words not already streamed (partial messages off): the whole run at once.
        else if (c.type === "text" && c.text && !state.streamed) out.push({ kind: "text", part: `${id}:${i}`, text: c.text });
      });
    } else if (j.type === "result") {
      out.push(j.is_error || j.subtype !== "success" ? { kind: "error", message: String(j.result || j.subtype || "The agent stopped.") } : { kind: "done" });
    }
  } else if (agent === "codex") {
    if (j.type === "thread.started" && j.thread_id) out.push({ kind: "session", id: j.thread_id });
    const it = j.item;
    if (it && (j.type === "item.started" || j.type === "item.completed")) {
      if (it.type === "agent_message" && j.type === "item.completed") out.push({ kind: "text", part: it.id, text: it.text ?? "" });
      else if (it.type === "mcp_tool_call" && j.type === "item.started") out.push({ kind: "tool", id: it.id, name: it.tool ?? it.name ?? "tool", input: it.arguments });
      else if (it.type === "command_execution" && j.type === "item.started") out.push({ kind: "tool", id: it.id, name: "shell", input: it.command });
      else if (it.type === "web_search" && j.type === "item.started") out.push({ kind: "tool", id: it.id, name: "web_search" });
    }
    if (j.type === "turn.completed") out.push({ kind: "done" });
    if (j.type === "turn.failed" || j.type === "error") out.push({ kind: "error", message: String(j.error?.message ?? j.message ?? "Codex stopped.") });
  } else if (agent === "opencode") {
    if (j.sessionID && !state.session) {
      state.session = j.sessionID;
      out.push({ kind: "session", id: j.sessionID });
    }
    const p = j.part ?? {};
    if (j.type === "text" && p.text != null) out.push({ kind: "text", part: p.id ?? "t", text: p.text });
    else if (p.type === "tool" || j.type === "tool_use" || j.type === "tool") {
      if (!(state.tools as Set<string> | undefined)?.has(p.id)) {
        ((state.tools as Set<string>) ??= new Set()).add(p.id);
        // opencode calls MCP tools from code (its execute tool): name the tool the code calls.
        const code = String(p.state?.input?.code ?? "");
        const called = /tools\.screenshotter\.(\w+)/.exec(code)?.[1];
        if (p.tool === "execute" && !called) return out;
        out.push({ kind: "tool", id: p.id ?? String(Math.random()), name: called ?? p.tool ?? p.name ?? "tool", input: p.state?.input });
      }
    } else if (j.type === "error") out.push({ kind: "error", message: String(j.error?.data?.message ?? j.error?.message ?? j.message ?? "opencode stopped.") });
  } else if (agent === "agy") {
    const sid = j.conversation_id ?? j.step_update?.conversation_id ?? j.result?.conversation_id;
    if (sid && !state.session) {
      state.session = sid;
      out.push({ kind: "session", id: sid });
    }
    const s = j.step_update;
    if (s) {
      const step = `step${s.step_index}`;
      if (s.step_type === "agent_response") {
        if (s.text_delta) out.push({ kind: "text", part: step, delta: s.text_delta });
      } else if (s.step_type && s.step_type !== "user_input" && !(state.tools as Set<string> | undefined)?.has(step)) {
        ((state.tools as Set<string>) ??= new Set()).add(step);
        const params = s.tool_info?.parameters ?? {};
        // Reading its own notes on a server's tools is how it finds them: not a step to show.
        if (s.tool_name === "read_file" && /antigravity-cli\/mcp\//.test(String(params.Path ?? ""))) return out;
        const name = s.tool_name === "call_mcp_tool" ? (params.ToolName ?? "tool") : (s.tool_name ?? s.step_type);
        out.push({ kind: "tool", id: step, name, input: params.Arguments ?? params });
      }
    }
    if (j.event === "result" && j.result) out.push(/SUCCESS/i.test(j.result.status ?? "") ? { kind: "done" } : { kind: "error", message: String(j.result.error ?? j.result.status ?? "Antigravity stopped.") });
  }
  return out;
}

/** What a tool did, in a few words for the chat. */
export function toolLabel(name: string, input?: any): string {
  const n = name.replace(/^mcp__screenshotter__|^screenshotter[_.:]+/i, "");
  const what = (s?: string) => (s ? ` ${s}` : "");
  switch (n) {
    case "board_read":
      return "Read the board";
    case "board_write_html":
      return "Wrote layers";
    case "board_edit":
      return `Changed ${Array.isArray(input?.changes) && input.changes.length > 1 ? `${input.changes.length} things` : "layers"}`;
    case "board_screenshot":
      return "Looked at it";
    case "board_export":
      return "Exported images";
    case "board_import_website":
      return `Brought in${what(input?.url)}`;
    case "board_import_figma":
      return "Brought in a Figma file";
    case "board_create":
      return "Made a board";
    case "board_list":
      return "Listed the boards";
    case "board_comment":
    case "board_comments":
      return "Read the comments";
    case "board_done":
      return "Finished";
    case "shell":
    case "bash":
      return "Ran a command";
    case "ToolSearch":
    case "TodoWrite":
      return "";
    case "web_search":
    case "WebSearch":
      return "Searched the web";
    case "WebFetch":
      return "Read a web page";
    case "Read":
    case "read_file":
      return "Read a file";
    default:
      return `Used ${n.replace(/_/g, " ")}`;
  }
}
