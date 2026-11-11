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
import { OpError, applyOps, componentOps, detachOps, emptyBoard, expandOps, flattenSvgOps, htmlToNodes, instanceTree, mapPath, nodeHtml, parseHtml, parsePath, parseStyle, resetOps, splitSvgOps, styleText, treeText, vectorFit, vectorTransform, type Board, type Op } from "../src/board/core.js";

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
  const part = icon.nodes[svg.children![0]];
  check(svg.type === "svg" && svg.style.width === "24px" && !svg.svg && svg.attrs?.viewBox === "0 0 24 24" && !svg.attrs.onclick && svg.children?.length === 1, "an svg is a vector in parts, made safe, sized from its viewBox");
  check(part.type === "vector" && part.tag === "path" && part.attrs?.d === "M0 0h24v24" && part.name === "Path", "its path is a part of its own, with its attributes");

  // Vectors: parts, defs, words, groups; HTML out and back.
  const art = htmlToNodes(`<svg width="100" height="50" fill="none"><defs><linearGradient id="g"><stop offset="0" stop-color="#f00"/></linearGradient></defs><g transform="translate(5 5)" onclick="x()"><rect x="0" y="0" width="20" height="10" rx="2" fill="url(#g)"/><circle cx="40" cy="20" r="8" stroke="#000"/></g><text x="60" y="30" font-size="12">Hi <tspan fill="red">there</tspan></text><a href="javascript:bad()"><path d="m10 40l20 0"/></a></svg>`);
  const av = art.nodes[art.roots[0]];
  const kids = av.children!.map((c) => art.nodes[c]);
  check(av.attrs?.viewBox === "0 0 100 50" && av.attrs.fill === "none" && /linearGradient/.test(av.defs ?? ""), "an svg without a viewBox gets one from its size; its gradients go in its defs");
  check(kids.map((k) => k.tag).join() === "g,text,g" && art.nodes[kids[0].children![1]].tag === "circle" && !kids[0].attrs?.onclick && !kids[2].attrs?.href, "groups hold their parts; links become groups; handlers and script links go");
  check(kids[1].name === "Hi there" && /<tspan fill="red">there<\/tspan>/.test(kids[1].text ?? ""), "SVG words are a part named by what they say, tspans kept");
  const vb = { ...emptyBoard("v", "V", "now"), nodes: art.nodes };
  vb.pages[0].children = art.roots;
  const out = nodeHtml(vb, art.roots[0], { ids: true });
  check(/<svg xmlns="http:\/\/www.w3.org\/2000\/svg"[^>]* viewBox="0 0 100 50"/.test(out) && /<rect data-id="[a-z0-9]+"[^>]* rx="2" fill="url\(#g\)"/.test(out) && /<defs><linearGradient/.test(out), "a vector in parts comes out as one <svg>, each part with its id");
  const back = htmlToNodes(nodeHtml(vb, art.roots[0]));
  check(Object.values(back.nodes).filter((n) => n.type === "vector").length === Object.values(art.nodes).filter((n) => n.type === "vector").length, "and reads back in the same parts");
  const whole = htmlToNodes(`<svg viewBox="0 0 10 10"><path d="M0 0"/></svg>`, { wholeSvg: true });
  check(Boolean(whole.nodes[whole.roots[0]].svg) && !whole.nodes[whole.roots[0]].children, "a sticker can come in as one piece");

  // Geometry: parts move and resize in their own coordinates.
  const rect = { ...art.nodes[kids[0].children![0]] };
  const fitR = vectorFit(rect, { x: 0, y: 0, width: 20, height: 10 }, { x: 10, y: 5, width: 40, height: 10 });
  check(fitR?.attrs.x === "10" && fitR.attrs.y === "5" && fitR.attrs.width === "40" && fitR.attrs.height === "10", "a rect resized: x, y, width, height");
  const circ = art.nodes[kids[0].children![1]];
  const c1 = vectorFit(circ, { x: 32, y: 12, width: 16, height: 16 }, { x: 34, y: 12, width: 16, height: 16 });
  const c2 = vectorFit(circ, { x: 32, y: 12, width: 16, height: 16 }, { x: 32, y: 12, width: 32, height: 16 });
  check(c1?.attrs.cx === "42" && c1.attrs.r === "8" && c2?.tag === "ellipse" && c2.attrs.rx === "16" && c2.attrs.ry === "8" && c2.attrs.r === null, "a circle moves by its centre; stretched, it becomes an ellipse");
  check(parsePath("M0 0a5 5 0 011 1z").map((x) => x.c + x.a.join(",")).join(" ") === "M0,0 a5,5,0,0,1,1,1 z", "path data reads run-together arc flags");
  check(mapPath("M10 10l5 0H30v5", (x, y) => [x * 2, y + 1], 2, 1) === "M20 11l10 0H60v5", "a path's absolute points map, its relative ones scale");
  check(vectorFit({ ...circ, tag: "path", attrs: { d: "m10 40l20 0" } }, { x: 10, y: 40, width: 20, height: 0 }, { x: 15, y: 50, width: 20, height: 0 })?.attrs.d === "m15 50l20 0", "a path moves: its first move is absolute even in lower case");
  check(vectorFit(kids[0], { x: 0, y: 0, width: 10, height: 10 }, { x: 5, y: 0, width: 10, height: 10 }) === null, "a group can't move by its own coordinates…");
  check(vectorTransform("translate(5 5)", { x: 0, y: 0, width: 10, height: 10 }, { x: 3, y: 4, width: 10, height: 10 }) === "translate(8 9)", "…so it gets a transform, a move folded into the one before");
  check(vectorTransform("rotate(10)", { x: 0, y: 0, width: 10, height: 10 }, { x: 0, y: 0, width: 20, height: 10 }) === "translate(0 0) scale(2 1) rotate(10)", "a resize goes before the transform it had");

  // Split into parts and back to one piece.
  let sb = applyOps(emptyBoard("s", "S", "now"), [{ op: "add", nodes: { a: { id: "a", type: "frame", name: "A", parent: null, style: {}, children: [] }, v: { id: "v", type: "svg", name: "Star", parent: "a", style: { width: "20px", height: "20px" }, svg: `<svg viewBox="0 0 20 20"><circle cx="10" cy="10" r="5" fill="#ff0"/><path d="M0 0h4"/></svg>` } }, ids: ["a"], parent: null }]).board;
  sb.nodes.a.children = ["v"];
  sb = applyOps(sb, splitSvgOps(sb, "v")).board;
  check(!sb.nodes.v.svg && sb.nodes.v.attrs?.viewBox === "0 0 20 20" && sb.nodes.v.children?.length === 2 && sb.nodes[sb.nodes.v.children[0]].tag === "circle", "a vector in one piece splits into its parts");
  const moved = applyOps(sb, [{ op: "set", id: sb.nodes.v.children![0], attrs: { fill: "#f00" } }]).board;
  sb = applyOps(moved, flattenSvgOps(moved, "v")).board;
  check(Boolean(sb.nodes.v.svg) && /<circle cx="10" cy="10" r="5" fill="#f00"/.test(sb.nodes.v.svg!) && !sb.nodes.v.children?.length && !sb.nodes.v.attrs?.viewBox, "and back into one piece, with the change made to a part");
  let refused = "";
  try {
    applyOps(moved, [{ op: "move", id: moved.nodes.v.children![0], parent: "a" }]);
  } catch (e) {
    refused = e instanceof OpError ? e.message : "";
  }
  let refused2 = "";
  try {
    applyOps(moved, [{ op: "add", nodes: { f: { id: "f", type: "frame", name: "F", parent: null, style: {}, children: [] } }, ids: ["f"], parent: "v" }]);
  } catch (e) {
    refused2 = e instanceof OpError ? e.message : "";
  }
  check(/part of a vector/.test(refused) && /Only a vector's parts/.test(refused2), "a part can't leave its vector, and a frame can't go into one");
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
const assets = await call("board_write_html", { board, target: art, html: `<div style="display:flex;gap:8px"><img src="sticker:heart" style="width:48px;height:48px"><img src="art:squiggle" style="color:#ff3b30;width:120px;height:30px"></div>` });
const row = assets.json.created[0].id;
const rowHtml = await call("board_read", { board, what: "html", node: row });
check((rowHtml.text.match(/<svg/g) ?? []).length === 2 && rowHtml.text.includes("currentColor") && !rowHtml.text.includes("sticker:"), "stickers and illustrations in an agent's HTML come in as vectors (one-ink art takes its colour)");
const shaped = await call("board_edit", { board, changes: [{ do: "shape", type: "burst", width: 120, height: 120, into: row, fill: "#ff3b30", text: "NEW", labelColor: "#fff" }, { do: "shape", type: "arrow", width: 160, height: 90, x: 1200, y: 40, stroke: "#0a84ff", strokeWidth: 5 }] });
check(shaped.json.results.every((r: any) => r.shape), "an agent adds Screenshotter's shapes, in a frame or on the page");
const dev = await call("board_edit", { board, changes: [{ do: "device", artboard: second.json.created[0].id, height: 300, x: 1500, y: 0 }] });
check(dev.json.results[0].device && dev.json.results[0].picture.endsWith(".png"), "an agent puts an artboard in a device frame");
const logo = await call("board_write_html", { board, target: art, html: `<svg width="64" height="64" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#111"/><circle cx="16" cy="16" r="6" fill="#d2ff4d"/><text x="16" y="28" text-anchor="middle" font-size="5" fill="#fff">GO</text></svg>` });
const logoId = logo.json.created[0].id;
const parts = await call("board_read", { board, what: "tree", node: logoId });
check(/vector <rect> "Rectangle"/.test(parts.text) && /vector <circle> "Circle" #[a-z0-9]+ cx=16 cy=16 r=6 fill=#d2ff4d/.test(parts.text) && /vector <text> "GO"/.test(parts.text), "an agent's SVG reads back as parts, each with its attributes");
const circleId = /vector <circle> "Circle" #([a-z0-9]+)/.exec(parts.text)![1];
const textId = /vector <text> "GO" #([a-z0-9]+)/.exec(parts.text)![1];
const vedit = await call("board_edit", { board, changes: [{ do: "vector", ids: [circleId], attrs: { fill: "#ff3b30", r: 9 } }, { do: "text", id: textId, text: "GO<script>x()</script>" }] });
const after = await call("board_read", { board, what: "html", node: logoId });
check(/<circle[^>]* r="9" fill="#ff3b30"/.test(after.text) && /GO<\/text>/.test(after.text) && !/script/.test(after.text), "an agent changes a part's attributes and retypes SVG words (nothing that runs is kept)");
const added = await call("board_write_html", { board, target: logoId, html: `<path d="M4 4L28 28" stroke="#fff" stroke-width="2"/>` });
check(added.json.created.length === 1 && /vector <path>/.test(added.json.outline), "an agent writes SVG elements into a vector");
const flat = await call("board_edit", { board, changes: [{ do: "flatten", id: logoId }] });
const flatTree = await call("board_read", { board, what: "tree", node: logoId });
const split = await call("board_edit", { board, changes: [{ do: "split", id: logoId }] });
const splitTree = await call("board_read", { board, what: "tree", node: logoId });
check(/one piece/.test(flatTree.text) && (splitTree.text.match(/vector </g) ?? []).length === 4, "an agent flattens a vector to one piece and splits it into parts again");
const html = await call("board_read", { board, what: "html", node: card });
check(html.text.includes("background-color:var(--brand)") && html.text.includes("border-radius:24px") && html.text.includes("opacity:0.9"), "styles go on as CSS (numbers as px, except opacity)");
const shot = await call("board_screenshot", { board, nodes: [art] });
check(shot.images.length === 1 && pngSize(shot.images[0]).width === 390 && pngSize(shot.images[0]).height === 844, "the screenshot is the artboard's size");
writeFileSync(path.join(out, "welcome.png"), shot.images[0]);
const close = await call("board_screenshot", { board, nodes: [card], scale: 2 });
check(close.images.length === 1 && pngSize(close.images[0]).width === 640, "a layer is cut out of its artboard (its 320 px at 2×)");
const exp = await call("board_export", { board, scale: 1 });
check(exp.json.files.length === 6 && exp.json.files.every((f: string) => readFileSync(f).length > 100), "every artboard exports");
const list = await call("board_list", {});
check(list.json[0].working.length >= 1, "the artboards being worked on are listed");
await call("board_done", { board });
check((await call("board_list", {})).json[0].working.length === 0, "board_done clears them");
console.log(`\nFiles in ${out}`);

await client.close();
console.log(failures ? `\n${failures} failed` : "\nAll passed");
process.exit(failures ? 1 : 0);
