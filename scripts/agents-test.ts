// Several agents editing one board at once, each its own MCP server process (as each agent runs
// one): they each add an artboard, append layers to one shared frame, restyle one shared layer
// (each its own property) and rename their artboard, all at the same time. Nothing may be lost,
// nothing may fail, and artboards added at the same moment may not land on top of each other.
// K agents (default 6), N rounds each (default 15): K=8 N=40 npm run test:agents
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import fs from "node:fs";
import path from "node:path";
const K = Number(process.env.K ?? 6), N = Number(process.env.N ?? 15);
const lib = fs.mkdtempSync(path.join((await import("node:os")).tmpdir(), "screenshotter-agents-"));
const env = { ...process.env, SCREENSHOTTER_OUTPUT_DIR: lib, SCREENSHOTTER_STUDIO_FILE: path.join(lib, "studio.json"), SCREENSHOTTER_SEEN_FILE: path.join(lib, "seen.json"), SCREENSHOTTER_STYLE_FILE: path.join(lib, "style.json"), SCREENSHOTTER_AGENTMAN_SOCKET: path.join(lib, "no-agentman.sock"), SCREENSHOTTER_NO_KEYCHAIN: "1" } as Record<string, string>;
const connect = async (i: number) => { const c = new Client({ name: `agent-${i}`, version: "1" }); await c.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(path.dirname(new URL(import.meta.url).pathname), "..", "dist", "index.js")], env, stderr: "ignore" })); return c; };
const json = (r: any) => JSON.parse(r.content.find((x: any) => x.type === "text").text);
const agents = await Promise.all(Array.from({ length: K }, (_, i) => connect(i)));
const call = (c: Client, name: string, args: any) => c.callTool({ name, arguments: args }, undefined, { timeout: 60000 });
const board = json(await call(agents[0], "board_create", { name: "Many agents" })).id;
const shared = json(await call(agents[0], "board_write_html", { board, html: `<div data-name="Shared" style="width:800px;height:fit-content;padding:40px;display:flex;flex-direction:column;gap:8px"><h1 style="margin:0">Shared title</h1><div data-name="Stack" style="display:flex;flex-direction:column;gap:4px"></div></div>` }));
const treeR: any = await call(agents[0], "board_read", { board, what: "tree" });
const outline: string = treeR.content.find((x: any) => x.type === "text").text;
const idOf = (name: string) => (outline.match(new RegExp(`"${name}" #([a-z0-9]+)`)) ?? [])[1];
const stack = idOf("Stack"), title = idOf("Shared title");
const errors: string[] = [];
const t0 = Date.now();
await Promise.all(agents.map(async (c, i) => {
  try {
    const mine = json(await call(c, "board_write_html", { board, html: `<div data-name="Agent ${i}" style="width:400px;height:300px;padding:20px"><h2 style="margin:0">Agent ${i}</h2></div>` })).created[0].id;
    for (let j = 0; j < N; j++) {
      const r = await Promise.allSettled([
        call(c, "board_write_html", { board, target: stack, html: `<div data-name="a${i}-${j}" style="height:10px;background:#ccc"></div>` }),
        call(c, "board_edit", { board, changes: [{ do: "style", ids: [title], style: { [`--a${i}`]: String(j) } }] }),
        call(c, "board_edit", { board, changes: [{ do: "rename", id: mine, name: `Agent ${i} · ${j}` }] }),
      ]);
      for (const x of r) { if (x.status === "rejected") errors.push(`${i}/${j}: ${String(x.reason).slice(0, 120)}`); else if ((x.value as any).isError) errors.push(`${i}/${j}: ${JSON.stringify((x.value as any).content).slice(0, 160)}`); }
    }
  } catch (e) { errors.push(`${i}: ${String(e).slice(0, 160)}`); }
}));
const secs = ((Date.now() - t0) / 1000).toFixed(1);
// Check the board on disk
const b = JSON.parse(fs.readFileSync(path.join(lib, ".studio", "boards", `${board}.json`), "utf8"));
const kids = (b.nodes[stack].children ?? []).map((id: string) => b.nodes[id].name);
const want = Array.from({ length: K }, (_, i) => Array.from({ length: N }, (_, j) => `a${i}-${j}`)).flat();
const missing = want.filter((w) => !kids.includes(w));
const st = b.nodes[title].style;
const props = Array.from({ length: K }, (_, i) => st[`--a${i}`]);
const arts = b.pages[0].children.map((id: string) => b.nodes[id]).filter((n: any) => /^Agent/.test(n.name));
const lefts = arts.map((n: any) => `${n.style.left}`);
const overlaps = arts.filter((n: any, k: number) => arts.some((m: any, q: number) => q !== k && Math.abs(parseFloat(m.style.left) - parseFloat(n.style.left)) < 400 && Math.abs(parseFloat(m.style.top ?? "0") - parseFloat(n.style.top ?? "0")) < 300)).length;
console.log(JSON.stringify({ agents: K, rounds: N, secs, calls: K * (1 + N * 3), errors: errors.length, firstErrors: errors.slice(0, 4), stackChildren: kids.length, wanted: want.length, missing: missing.length, sharedProps: props, artboards: arts.map((n: any) => n.name), lefts, overlapping: overlaps, rev: b.rev }, null, 1));
await Promise.all(agents.map((c) => c.close()));
fs.rmSync(lib, { recursive: true, force: true });
const ok = !errors.length && !missing.length && props.every((p) => p === String(N - 1)) && arts.length === K && !overlaps;
console.log(ok ? "PASS several agents on one board" : "FAIL several agents on one board");
process.exit(ok ? 0 : 1);
