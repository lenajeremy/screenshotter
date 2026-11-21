/**
 * The agents connected right now: each MCP server (one per agent session) notes itself in the
 * library while it runs (.studio/agents/<pid>.json), with the agent's name as it introduced itself.
 * The app shows them during onboarding ("Claude Code is connected") before any board exists.
 */
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { libraryFolder } from "../util/files.js";

const dir = () => path.join(libraryFolder(), ".studio", "agents");
const mine = () => path.join(dir(), `${process.pid}.json`);

/** What an agent calls itself (its MCP client name), as people know it. */
export function agentLabel(client: string | undefined): string {
  const c = (client ?? "").toLowerCase();
  if (c.includes("claude")) return "Claude Code";
  if (c.includes("codex")) return "Codex";
  if (c.includes("cursor")) return "Cursor";
  if (c.includes("windsurf") || c.includes("codeium")) return "Windsurf";
  if (c.includes("zed")) return "Zed";
  if (c.includes("vscode") || c.includes("copilot")) return "VS Code";
  if (c.includes("gemini")) return "Gemini";
  if (c.includes("opencode")) return "opencode";
  return client ? client.replace(/[-_]/g, " ") : "An agent";
}

/** This MCP server's agent is connected (called once the agent has introduced itself). */
export function noteConnected(client: { name?: string; version?: string } | undefined) {
  try {
    mkdirSync(dir(), { recursive: true });
    writeFileSync(mine(), JSON.stringify({ pid: process.pid, client: client?.name ?? "", label: agentLabel(client?.name), since: new Date().toISOString() }));
  } catch {
    // No library yet: nothing to show.
  }
}
export function noteGone() {
  rmSync(mine(), { force: true });
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
};

/** The agents connected now, the most recent first (notes of ones that ended are cleared). */
export function connectedAgents(): { label: string; client: string; since: string }[] {
  let files: string[] = [];
  try {
    files = readdirSync(dir()).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  const out: { label: string; client: string; since: string }[] = [];
  for (const f of files) {
    try {
      const a = JSON.parse(readFileSync(path.join(dir(), f), "utf8")) as { pid: number; label: string; client: string; since: string };
      if (alive(a.pid)) out.push({ label: a.label, client: a.client, since: a.since });
      else rmSync(path.join(dir(), f), { force: true });
    } catch {
      // A note half written: next time.
    }
  }
  return out.sort((a, b) => b.since.localeCompare(a.since));
}
