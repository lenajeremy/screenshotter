/**
 * Boards, end to end: the core (HTML in and out, every step undone exactly) and the agent tools
 * through a real MCP client over stdio, against the built server, in a scratch folder.
 *
 *   npm run build && npm run test:board
 */
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { OpError, applyOps, componentOps, detachOps, emptyBoard, expandOps, htmlToNodes, instanceTree, nodeHtml, parseStyle, resetOps, styleText, treeText, type Board, type Op } from "../src/board/core.js";

let failures = 0;
const check = (ok: unknown, what: string) => {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${what}`);
};

// ---------------------------------------------------------------------------------------------
// Core

const CARD = `<div style="display:flex;flex-direction:column;gap:12px;padding:24px;width:320px;border-radius:16px;background:#fff;box-shadow:0 8px 24px rgba(0,0,0,.12);font-family:Inter,sans-serif"><h2 style="margin:0;font-size:20px;font-weight:600;color:#111">Weekly report</h2><p style="margin:0;font-size:14px;line-height:20px;color:#555">Three projects shipped, <b>two</b> in review.</p><div style="display:flex;gap:8px"><span style="padding:8px 14px;border-radius:999px;background:#111;color:#fff;font-size:13px">Open</span><span style="padding:8px 14px;border-radius:999px;border:1px solid #ddd;font-size:13px">Later</span></div></div>`;
{
  const got = htmlToNodes(CARD);
  const root = got.nodes[got.roots[0]];
  check(got.roots.length === 1 && root.type === "frame" && root.children?.length === 3, "a card becomes one frame with three layers");
  const [h, p, row] = root.children!.map((id) => got.nodes[id]);
  check(h.type === "text" && h.text === "Weekly report" && h.style.fontWeight === "600", "a heading is a text layer, its own weight kept over the tag's");
  check(p.type === "text" && p.text === 'Three projects shipped, <b style="font-weight:700">two</b> in review.', "inline tags stay inside the words");
  check(row.type === "frame" && row.children?.length === 2 && row.children.every((c) => got.nodes[c].type === "text"), "the buttons are text layers in a row");
  check(row.style.display === "flex" && !row.style.flexDirection, "a flex row stays a row");
  const block = htmlToNodes(`<div><div style="height:10px"></div><p>Hi</p></div>`);
  check(block.nodes[block.roots[0]].style.display === "flex" && block.nodes[block.roots[0]].style.flexDirection === "column", "a block becomes a flex column");
  const icon = htmlToNodes(`<svg viewBox="0 0 24 24" onclick="x()"><path d="M0 0h24v24" /><script>bad()</script></svg>`);
  const svg = icon.nodes[icon.roots[0]];
  check(svg.type === "svg" && svg.style.width === "24px" && !/script|onclick/.test(svg.svg!) && /viewBox/.test(svg.svg!), "an svg is a vector, made safe, sized from its viewBox");
  check(htmlToNodes(`<div class="p-4">x</div>`).warnings.length === 1, "class names are warned about");
  check(styleText(parseStyle("background: url(data:image/png;base64,AA==); color: red")) === "background:url(data:image/png;base64,AA==);color:red", "styles with semicolons in url() survive");

  // Every step undoes exactly.
  let b: Board = emptyBoard("testboard", "Test", new Date().toISOString());
  const pid = b.pages[0].id;
  b = applyOps(b, [{ op: "add", nodes: got.nodes, ids: got.roots, parent: null, page: pid }]).board;
  const before = JSON.stringify(b);
  const id = got.roots[0];
  const steps = [
    { op: "set" as const, id, style: { padding: "40px", gap: null }, name: "Card" },
    { op: "move" as const, id: row.id, parent: id, index: 0 },
    { op: "delete" as const, ids: [h.id, p.id] },
    { op: "token" as const, name: "brand", value: "#4c8dff" },
    { op: "addPage" as const, page: { id: "p2page", name: "Two", children: [] } },
    { op: "rename" as const, name: "Renamed" },
  ];
  const { board: after, inverse } = applyOps(b, steps);
  check(after.nodes[id].children?.length === 1 && after.nodes[id].children![0] === row.id && after.tokens.length === 1 && after.pages.length === 2, "steps change the board");
  check(JSON.stringify(b) === before, "the board before is left as it was");
  const undone = applyOps(after, inverse).board;
  const canon = (v: unknown): unknown => (Array.isArray(v) ? v.map(canon) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, canon(x)])) : v);
  check(JSON.stringify(canon(undone)) === JSON.stringify(canon(JSON.parse(before))), "the inverse steps put it back exactly");
  const html = nodeHtml(b, id, { ids: true });
  check(html.includes(`data-id="${id}"`) && html.includes("Weekly report") && !html.includes("left:"), "a layer comes back out as HTML");
  check(treeText(b, id).split("\n").length === 6, "the outline lists every layer");
}

// ---------------------------------------------------------------------------------------------
// Components

{
  let b: Board = emptyBoard("compboard", "Components", new Date().toISOString());
  const page = b.pages[0].id;
  const run = (ops: Op[]) => {
    const r = applyOps(b, expandOps(b, ops));
    b = r.board;
    return r.inverse;
  };
  const got = htmlToNodes(`<div data-name="Screen" style="display:flex;flex-direction:column;gap:8px;width:390px;height:600px">${CARD}</div>`);
  run([{ op: "add", nodes: got.nodes, ids: got.roots, parent: null, page }]);
  const screen = got.roots[0];
  const card = b.nodes[screen].children![0];
  const [title, , row] = b.nodes[card].children!;
  run(componentOps(b, card));
  const copy = (n = 1) =>
    Array.from({ length: n }, () => {
      const t = instanceTree(b, card, screen);
      run([{ op: "add", nodes: t.nodes, ids: [t.id], parent: screen }]);
      return t.id;
    });
  const [c1, c2] = copy(2);
  const titleIn = (root: string) => b.nodes[root].children!.find((x) => b.nodes[x].master === title)!;
  check(b.nodes[c1].instanceOf === card && b.nodes[titleIn(c1)].text === "Weekly report", "a copy of a component has its layers, each following the component's");
  const before = JSON.stringify(b);
  const undo = run([{ op: "set", id: title, style: { color: "#ff3b30" } }]);
  check(b.nodes[titleIn(c1)].style.color === "#ff3b30" && b.nodes[titleIn(c2)].style.color === "#ff3b30", "a change to the component is made in every copy");
  b = applyOps(b, undo).board;
  check(JSON.stringify(b) === before, "undoing it takes it back in the copies too");
  run([{ op: "set", id: titleIn(c1), text: "Monthly report" }]);
  check(b.nodes[titleIn(c1)].overrides?.includes("text") === true, "a change made in a copy is remembered as the copy's own");
  run([{ op: "set", id: title, text: "Weekly digest", style: { fontSize: "22px" } }]);
  check(b.nodes[titleIn(c1)].text === "Monthly report" && b.nodes[titleIn(c1)].style.fontSize === "22px" && b.nodes[titleIn(c2)].text === "Weekly digest", "the component's change leaves a copy's own words alone, and changes the rest");
  const extra = htmlToNodes(`<p style="margin:0">Due Friday</p>`);
  extra.nodes[extra.roots[0]].parent = card;
  run([{ op: "add", nodes: extra.nodes, ids: extra.roots, parent: card, index: 1 }]);
  check([c1, c2].every((c) => b.nodes[b.nodes[c].children![1]].text === "Due Friday"), "a layer added to the component appears in every copy, in the same place");
  run([{ op: "move", id: row, parent: card, index: 0 }]);
  check([c1, c2].every((c) => b.nodes[b.nodes[c].children![0]].master === row), "a layer moved in the component moves in every copy");
  run([{ op: "delete", ids: [extra.roots[0]] }]);
  check([c1, c2].every((c) => b.nodes[c].children!.length === 3), "a layer deleted from the component goes from every copy");
  let refused = 0;
  for (const ops of [[{ op: "delete", ids: [titleIn(c1)] }], [{ op: "add", nodes: htmlToNodes("<p>x</p>").nodes, ids: [], parent: c1 }]] as Op[][]) {
    try {
      run(ops);
    } catch (e) {
      if (e instanceof OpError) refused++;
    }
  }
  check(refused === 2, "layers can't be deleted from, or added to, a copy");
  run(resetOps(b, c1));
  check(b.nodes[titleIn(c1)].text === "Weekly digest" && !b.nodes[titleIn(c1)].overrides, "reset makes a copy match its component again");
  run(detachOps(b, c2));
  run([{ op: "set", id: title, text: "Changed again" }]);
  check(b.nodes[titleIn(c1)].text === "Changed again" && !Object.values(b.nodes).some((n) => n.master && n.id.length && n.parent === c2) && b.nodes[c2].children!.every((x) => b.nodes[x].text !== "Changed again"), "a detached copy stops following");
  run([{ op: "delete", ids: [card] }]);
  check(!b.nodes[c1].instanceOf && b.nodes[c1].children!.every((x) => !b.nodes[x].master), "deleting the component leaves its copies as ordinary layers");
}

// ---------------------------------------------------------------------------------------------
// The tools, through MCP

const out = mkdtempSync(path.join(tmpdir(), "board-test-"));
const client = new Client({ name: "board-test", version: "0.0.0" });
await client.connect(
  new StdioClientTransport({
    command: "node",
    args: ["dist/index.js"],
    env: { ...(process.env as Record<string, string>), SCREENSHOTTER_OUTPUT_DIR: out, SCREENSHOTTER_STUDIO_FILE: path.join(out, "studio.json") },
  }),
);

async function call(name: string, args: Record<string, unknown>, expectError = false): Promise<{ json: any; text: string; images: Buffer[] }> {
  const r = (await client.callTool({ name, arguments: args }, undefined, { timeout: 120_000 })) as any;
  const text = r.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");
  const images = r.content.filter((c: any) => c.type === "image").map((c: any) => Buffer.from(c.data, "base64"));
  check(Boolean(r.isError) === expectError, `${name}${expectError ? " (refuses)" : ""}: ${text.replace(/\s+/g, " ").slice(0, 140)}`);
  let json: any;
  try {
    json = JSON.parse(r.content.find((c: any) => c.type === "text")?.text ?? "");
  } catch {}
  return { json, text, images };
}

const pngSize = (b: Buffer) => ({ width: b.readUInt32BE(16), height: b.readUInt32BE(20) });

const made = await call("board_create", { name: "Onboarding" });
const board = made.json.id;
const screen = await call("board_write_html", {
  board,
  html: `<div data-name="Welcome" style="width:390px;height:844px;background:#0a0a0b;color:#f4f4f5;font-family:Inter,sans-serif;padding:64px 24px 40px;display:flex;flex-direction:column;gap:16px"><h1 style="margin:0;font-size:34px;line-height:40px">Plan your week<br>in a minute</h1><p style="margin:0;color:#a1a1aa;font-size:16px">One list for everything you said you'd do.</p></div>`,
});
const art = screen.json.created[0].id;
check(screen.json.outline.includes("frame \"Welcome\"") && screen.json.outline.includes("390×844"), "the artboard is outlined with its size");
await call("board_write_html", { board, target: art, html: CARD });
const second = await call("board_write_html", { board, html: `<div data-name="Second" style="width:390px;height:844px;background:#fff"></div>` });
const tree = await call("board_read", { board, what: "tree", measure: true });
check(/Welcome.*\[0,0 390×844\]/.test(tree.text), "a measured tree has real boxes");
check(/"Second".*at 510,0/.test(tree.text), "a new artboard goes to the right of the others");
const card = /frame "Frame" #([a-z0-9]+) (\[[^\]]*\] )?320×fit/.exec(tree.text)?.[1];
check(card, "the card is in the tree");
const edit = await call("board_edit", {
  board,
  changes: [
    { do: "token", name: "brand", value: "#4c8dff" },
    { do: "style", ids: [card], style: { backgroundColor: "var(--brand)", borderRadius: 24, opacity: 0.9 } },
    { do: "rename", id: card, name: "Report card" },
    { do: "duplicate", id: card },
    { do: "artboard", name: "Third", width: 390, height: 844 },
  ],
});
check(edit.json.results[3].copies.length === 1 && edit.json.results[4].artboard, "edits run together and report new ids");
await call("board_edit", { board, changes: [{ do: "style", ids: ["nope"], style: { color: "red" } }] }, true);
await call("board_write_html", { board, target: second.json.created[0].id, html: "<p style=\"color:#111\">Hi</p>", position: "after" });
const comp = await call("board_edit", { board, changes: [{ do: "component", id: card }, { do: "copy", of: card }, { do: "style", ids: [card], style: { borderRadius: 8 } }] });
const copyId = comp.json.results[1].copy;
const copyHtml = await call("board_read", { board, what: "html", node: copyId });
check(copyHtml.text.includes(`data-copy-of="${card}"`) && copyHtml.text.includes("border-radius:8px"), "an agent makes a component and a copy, and the copy follows a change");
await call("board_write_html", { board, target: copyId, html: "<p>no</p>" }, true);
await call("board_edit", { board, changes: [{ do: "style", ids: [card], style: { borderRadius: 24 } }] });
const html = await call("board_read", { board, what: "html", node: card });
check(html.text.includes("background-color:var(--brand)") && html.text.includes("border-radius:24px") && html.text.includes("opacity:0.9"), "styles go on as CSS (numbers as px, except opacity)");
const shot = await call("board_screenshot", { board, nodes: [art] });
check(shot.images.length === 1 && pngSize(shot.images[0]).width === 390 && pngSize(shot.images[0]).height === 844, "the screenshot is the artboard's size");
writeFileSync(path.join(out, "welcome.png"), shot.images[0]);
const close = await call("board_screenshot", { board, nodes: [card], scale: 2 });
check(close.images.length === 1 && pngSize(close.images[0]).width === 640, "a layer is cut out of its artboard (its 320 px at 2×)");
const exp = await call("board_export", { board, scale: 1 });
check(exp.json.files.length === 4 && exp.json.files.every((f: string) => readFileSync(f).length > 100), "every artboard exports");
const list = await call("board_list", {});
check(list.json[0].working.length >= 1, "the artboards being worked on are listed");
await call("board_done", { board });
check((await call("board_list", {})).json[0].working.length === 0, "board_done clears them");
console.log(`\nFiles in ${out}`);

await client.close();
console.log(failures ? `\n${failures} failed` : "\nAll passed");
process.exit(failures ? 1 : 0);
