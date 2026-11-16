/**
 * Boards, end to end: the core (HTML in and out, every step undone exactly) and the agent tools
 * through a real MCP client over stdio, against the built server, in a scratch folder.
 *
 *   npm run build && npm run test:board
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
// Tests never ask the Keychain (macOS would ask the person to allow it).
process.env.SCREENSHOTTER_NO_KEYCHAIN = "1";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fakeAgentman } from "./fake-agentman.js";
import { sendableText, sessionInFolder } from "../src/board/agentman.js";
import { OpError, addHtmlOps, applyOps, componentOps, defaultRecipients, detachOps, emptyBoard, expandOps, flattenSvgOps, htmlToNodes, instanceTree, mapPath, nodeHtml, parseHtml, parsePath, parseStyle, resetOps, splitSvgOps, styleText, treeText, vectorFit, vectorTransform, type Board, type Op } from "../src/board/core.js";

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
  {
    // Video: as HTML has it coming in; as Figma's playback (autoplay, loop, sound) when unset.
    const { videoSettings } = await import("../src/board/core.js");
    const a = htmlToNodes('<video src="/x/clip.mp4" autoplay loop muted style="width:320px;height:180px"></video>');
    const va = a.nodes[a.roots[0]];
    check(va.type === "video" && va.src === "/x/clip.mp4" && va.style.objectFit === "cover" && va.video?.autoplay === true && va.video.loop === true && va.video.muted === true, "a <video> is a video layer, playing as its attributes say");
    const b2 = htmlToNodes('<video style="width:320px;height:180px"><source src="/x/clip.webm" type="video/webm"></video>');
    const vb = b2.nodes[b2.roots[0]];
    check(vb.src === "/x/clip.webm" && vb.video?.autoplay === false && vb.video.loop === false && vb.video.muted === false, "its file can come from a <source>; no attributes, no autoplay");
    const d = videoSettings({});
    check(d.autoplay && d.loop && !d.muted, "unset, a video autoplays and loops with sound, as Figma's do");
    const vb2 = { ...emptyBoard("vid", "Video", new Date().toISOString()) };
    vb2.nodes = { v1: { id: "v1", type: "video", name: "Clip", parent: null, style: { width: "320px", height: "180px" }, src: "/x/clip.mp4", poster: "/x/clip.jpg", video: { autoplay: true, loop: false, muted: true } } };
    vb2.pages[0].children = ["v1"];
    const live = nodeHtml(vb2, "v1");
    const still = nodeHtml(vb2, "v1", { still: true });
    check(/^<video\b/.test(live) && / poster="\/x\/clip\.jpg" autoplay muted playsinline/.test(live) && !/ loop/.test(live), `as HTML it's a <video> with its settings (${live.slice(0, 160)})`);
    check(/^<img\b[^>]* src="\/x\/clip\.jpg"/.test(still), "in pictures of the board it's its still");
    const set = applyOps(vb2, [{ op: "set", id: "v1", video: { autoplay: false, loop: true, muted: false }, poster: "/x/other.jpg" }]);
    const back = applyOps(set.board, set.inverse).board.nodes.v1;
    check(set.board.nodes.v1.video?.loop === true && set.board.nodes.v1.poster === "/x/other.jpg" && back.video?.loop === false && back.poster === "/x/clip.jpg", "its playback and still change, and undo");
  }
  check(part.type === "vector" && part.tag === "path" && part.attrs?.d === "M0 0h24v24" && part.name === "Path", "its path is a part of its own, with its attributes");

  // Unsplash sources on boards: words are a search ("#2" the second photo); an id names one photo.
  const { unsplashRef, isUnsplash } = await import("../src/board/photos.js");
  check(unsplashRef("unsplash:ramen bowl").ref === "unsplash:search:ramen bowl" && unsplashRef("unsplash:ramen bowl #2").pick === 1 && unsplashRef("unsplash:skateboards").ref === "unsplash:search:skateboards", "unsplash:<words> is a search, and #2 takes the second photo");
  check(unsplashRef("unsplash:TWTxHN2QIGc").ref === "unsplash:TWTxHN2QIGc" && isUnsplash("https://unsplash.com/photos/ramen-dish-TWTxHN2QIGc") && !isUnsplash("/Users/me/a.png"), "an id or a photo's page names one photo");
  const { cssWithPhotos } = await import("../src/board/photos.js");
  const warned: string[] = [];
  const credited: string[] = [];
  const box = { width: 400, height: 225 };
  const placed = await cssWithPhotos("url(unsplash:ramen) center / cover", box, warned, credited, async () => ({ src: "/lib/ramen.jpg", credit: "Photo by A" }));
  const used = await cssWithPhotos("url(unsplash:mars rover) center / cover", box, warned, credited, async () => {
    throw new Error("This Unsplash key's searches are used up for the hour.");
  });
  check(placed === 'url("/lib/ramen.jpg") center / cover' && credited.join() === "Photo by A", "url(unsplash:…) becomes the photo's file, with its credit");
  check(used === null && /used up/.test(warned.join()) && /keeps what it had/.test(warned.join()), "a photo that can't be had leaves the layer as it was, and says why");
  const { unsplashKey } = await import("../src/util/keys.js");
  const savedKey = process.env.UNSPLASH_ACCESS_KEY;
  process.env.UNSPLASH_ACCESS_KEY = " k-from-the-app ";
  const fromApp = await unsplashKey();
  delete process.env.UNSPLASH_ACCESS_KEY;
  const none = await unsplashKey();
  if (savedKey !== undefined) process.env.UNSPLASH_ACCESS_KEY = savedKey;
  check(fromApp === "k-from-the-app" && none === undefined, "the Unsplash key comes from the app when it hands one over; tests never ask the Keychain");

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

// Renaming a token renames every var() that uses it, as one change, and copies keep following.
{
  const { renameTokenOps } = await import("../src/board/core.js");
  let b = emptyBoard("t", "T", "now");
  const run = (ops: Op[]) => {
    const r = applyOps(b, expandOps(b, ops));
    b = r.board;
    return r.inverse;
  };
  run([
    { op: "token", name: "--brand", value: "#ff3b30" },
    { op: "token", name: "--brand-2", value: "#0a84ff" },
    { op: "token", name: "--accent", value: "var(--brand)" },
  ]);
  const got = htmlToNodes(`<div data-name="Card" style="display:flex;background:var(--brand);border:2px solid var(--brand-2);color:var(--brand, red)"><p style="margin:0">Hi <span style="color:var(--brand)">there</span></p><svg viewBox="0 0 10 10"><defs><linearGradient id="g"><stop offset="0" style="stop-color:var(--brand)"/></linearGradient></defs><circle cx="5" cy="5" r="4" fill="var(--brand)"/></svg></div>`);
  run([{ op: "add", nodes: got.nodes, ids: got.roots, parent: null, page: b.pages[0].id }]);
  const card = got.roots[0];
  run(componentOps(b, card));
  const t = instanceTree(b, card, null);
  run([{ op: "add", nodes: t.nodes, ids: [t.id], parent: null, page: b.pages[0].id }]);
  const before = JSON.stringify(b);
  const undo = run(renameTokenOps(b, "brand", "primary"));
  const all = JSON.stringify(b.nodes);
  check(b.tokens.map((x) => x.name).join() === "--primary,--brand-2,--accent" && b.tokens[2].value === "var(--primary)", "renaming a token keeps its place, and tokens that point at it follow");
  check(!all.includes("var(--brand)") && !all.includes("var(--brand,") && all.includes("var(--brand-2)") && all.includes("var(--primary, red)"), "every var() using it is renamed (styles, words, vector attributes, gradients), and not a token whose name starts the same");
  check(!Object.values(b.nodes).some((n) => n.overrides?.length), "renaming isn't a change made in the component's copies");
  b = applyOps(b, undo).board;
  check(JSON.stringify(b) === before, "undoing it puts every name back");
  let refused = "";
  try {
    renameTokenOps(b, "brand", "brand-2");
  } catch (e) {
    refused = (e as Error).message;
  }
  check(/already/.test(refused), "a token can't be renamed to one that's there already");
}

// Who worked on a board is kept on it, but it isn't the design: undo leaves it be.
{
  const at = "2026-11-11T10:00:00.000Z";
  let b = applyOps(emptyBoard("w", "W", "now"), [{ op: "add", nodes: { a: { id: "a", type: "frame", name: "A", parent: null, style: {}, children: [] } }, ids: ["a"], parent: null }]).board;
  const step = applyOps(b, [{ op: "agent", agent: { key: "claude:1", session: "claude:1", how: "process", kind: "claude", name: "Design" }, artboards: ["a"], at }]);
  b = step.board;
  check(step.inverse.length === 0 && b.agents?.["claude:1"]?.artboards.join() === "a" && b.agents["claude:1"].firstAt === at, "an agent is remembered with the artboards it worked on, and there's nothing to undo");
  b = applyOps(b, [{ op: "agent", agent: { key: "claude:1", session: "claude:1", how: "process", kind: "claude", name: "Design" }, artboards: ["b"], at: "2026-11-11T11:00:00.000Z" }]).board;
  check(b.agents!["claude:1"].artboards.join() === "a,b" && b.agents!["claude:1"].firstAt === at, "working again adds artboards and keeps when it first came");
  const undone = applyOps(b, [{ op: "replace", pages: b.pages, nodes: {}, tokens: [] }]).board;
  check(undone.agents === b.agents, "undoing the design (as the Studio undoes an agent's change) keeps the agents");
  const two = applyOps(b, [{ op: "agent", agent: { key: "codex:2", kind: "codex", name: "Other" }, artboards: ["c"], at: "2026-11-11T12:00:00.000Z" }]).board;
  check(defaultRecipients(two, "a").join() === "claude:1" && defaultRecipients(two, "z").length === 0 && defaultRecipients(b, "z").join() === "claude:1", "a comment goes to who worked on its artboard, else the board's only agent");
  check(defaultRecipients(two, "a", [{ by: "codex:2" }]).join() === "codex:2", "a reply goes to who's already in the thread");
}
{
  const sessions = [
    { id: "claude:x", kind: "claude", name: "X", cwd: "/work/app" },
    { id: "claude:y", kind: "claude", name: "Y", cwd: "/work/app" },
    { id: "codex:z", kind: "codex", name: "Z", cwd: "/work/app" },
  ];
  check(sessionInFolder(sessions, "codex", "/work/app").session?.id === "codex:z" && sessionInFolder(sessions, "claude", "/work/app").count === 2 && !sessionInFolder(sessions, "claude", "/work/app").session, "an agent found by its folder: only when it's the one agent of its kind there");
  check(sendableText("a\r\nb\u0007c‮") === "a\nbc", "a message to Agentman carries no terminal control characters");
}

// ---------------------------------------------------------------------------------------------
// Grids: tracks read and written as a person writes them, shorthands as longhands, a layout
// turned into a grid where its layers are, and grids through scale, components and undo.
{
  const g = await import("../src/board/core.js");
  const t3 = g.parseTracks("repeat(3, 1fr)");
  check(t3.tracks.length === 3 && t3.tracks.every((t) => t.size === "1fr") && g.tracksCss(t3) === "repeat(3, 1fr)", "repeat(3, 1fr) is three tracks, and written back as it was");
  const named = g.parseTracks("[full-start] 240px [main-start] repeat(2, minmax(100px, 1fr)) [main-end]");
  check(named.tracks.length === 3 && named.tracks[0].names?.join() === "full-start" && named.tracks[1].names?.join() === "main-start" && named.tracks[2].size === "minmax(100px, 1fr)" && named.end?.join() === "main-end", "line names stay with their lines, and minmax() is one track");
  check(g.tracksCss(named) === "[full-start] 240px [main-start] minmax(100px, 1fr) minmax(100px, 1fr) [main-end]", `named lines are written back (${g.tracksCss(named)})`);
  const fill = g.parseTracks("repeat(auto-fill, minmax(200px, 1fr))");
  check(fill.tracks.length === 1 && fill.tracks[0].auto === "auto-fill" && fill.tracks[0].size === "minmax(200px, 1fr)" && g.tracksCss(fill) === "repeat(auto-fill, minmax(200px, 1fr))" && g.trackLabel(fill.tracks[0]) === "Fill ≥ 200", "repeat(auto-fill, …) is one track that repeats as many times as fit");
  check(g.tracksCss({ tracks: ["240px", "1fr", "1fr", "1fr"].map((size) => ({ size })) }) === "240px repeat(3, 1fr)" && g.tracksCss({ tracks: ["1fr", "2fr"].map((size) => ({ size })) }) === "1fr 2fr", "a run of three alike is repeat(), two different tracks are spelt out");
  check(g.parseTracks("subgrid").raw === "subgrid" && g.tracksCss(g.parseTracks("subgrid")) === "subgrid", "what can't be edited track by track is kept as written");
  check(["1fr", "240px", "auto", "min-content", "max-content", "minmax(1px, 2fr)", "fit-content(300px)", "25%", "calc(10px + 1em)"].map(g.trackKind).join() === "fr,px,auto,min-content,max-content,minmax,fit-content,percent,other", "every kind of track size is told apart");
  check(["minmax(120px, 1fr)", "fit-content(320px)", "auto", "240px"].map((x) => g.trackLabel(x)).join("|") === "120–1fr|≤ 320|Auto|240", "track sizes read short");

  // Shorthands come in as longhands.
  const sh = g.normalizeGridStyle({ display: "grid", grid: "auto-flow dense 120px / repeat(3, 1fr)" });
  check(sh.gridAutoFlow === "row dense" && sh.gridAutoRows === "120px" && sh.gridTemplateColumns === "repeat(3, 1fr)" && sh.grid === null, "grid: auto-flow dense 120px / … is its flow, new rows and columns");
  const sh2 = g.normalizeGridStyle({ grid: "100px 1fr / auto-flow 200px" });
  check(sh2.gridAutoFlow === "column" && sh2.gridAutoColumns === "200px" && sh2.gridTemplateRows === "100px 1fr", "grid: rows / auto-flow … flows by column");
  const tpl = g.gridLonghands({ display: "grid", gridTemplate: `"head head" 80px "side main" 1fr / 240px 1fr` });
  check(tpl.gridTemplateRows === "80px 1fr" && tpl.gridTemplateColumns === "240px 1fr" && tpl.gridTemplateAreas === `"head head" "side main"` && !("gridTemplate" in tpl), `grid-template with areas is its rows, columns and areas (${JSON.stringify(tpl)})`);
  const area = g.normalizeGridStyle({ gridArea: "1 / 2 / 3 / 4", placeSelf: "center end", placeItems: "center" });
  check(area.gridRow === "1 / 3" && area.gridColumn === "2 / 4" && area.alignSelf === "center" && area.justifySelf === "end" && area.alignItems === "center" && area.justifyItems === "center", "grid-area with slashes is its row and column, place-* its two halves");
  check(g.normalizeGridStyle({ gridArea: "header" }).gridArea === "header", "a named grid-area stays");
  const se = g.normalizeGridStyle({ gridColumnStart: "2" }, { gridColumn: "1 / span 3" });
  check(se.gridColumn === "2 / span 3" && se.gridColumnStart === null, `a change to one side of a line keeps the other (${se.gridColumn})`);
  check(g.normalizeGridStyle({ gridColumnStart: "2" }, { gridColumn: "span 3" }).gridColumn === "2", "a start line replaces a span written on the start side, as CSS has it");
  check(g.normalizeGridStyle({ gridGap: "12px 20px" }).gap === "12px 20px", "grid-gap is gap");

  // Lines, spans and gaps.
  check(JSON.stringify(g.parsePlacement("2 / span 3")) === '{"start":2,"span":3}' && JSON.stringify(g.parsePlacement("span 2")) === '{"span":2}' && JSON.stringify(g.parsePlacement("1 / -1")) === '{"start":1,"end":-1}', "grid-column reads as a start, a span and an end");
  check(g.placementCss({ start: 2, span: 3 }) === "2 / span 3" && g.placementCss({ span: 2 }) === "span 2" && g.placementCss({ start: 3 }) === "3" && g.placementCss({}) === null && g.placementSpan(g.parsePlacement("2 / 5")) === 3, "and is written back the same way");
  check(JSON.stringify(g.gapsOf({ gap: "12px 20px" })) === '{"row":"12px","column":"20px"}' && JSON.stringify(g.gapsOf({ gap: "8px", columnGap: "4px" })) === '{"row":"8px","column":"4px"}', "gaps read from gap and its longhands");
  check(g.gapCss("16px", "16px").gap === "16px" && g.gapCss("12px", "24px").gap === "12px 24px" && g.gapCss("0px", "").gap === null, "gaps write as one value when they're alike");

  // Areas.
  const rows = g.parseAreas(`"head head" "side main" ". foot"`)!;
  const rects = g.areaRects(rows);
  check(rows.length === 3 && rects.head.columnSpan === 2 && rects.main.column === 2 && rects.foot.row === 3 && g.areasValid(rows), "named areas are where they're written, each a rectangle");
  check(!g.areasValid(g.parseAreas(`"a b" "b a"`)) && g.areasCss([["a", "."], [".", "."]]) === `"a ." ". ."` && g.areasCss([[".", "."]]) === null, "areas that aren't rectangles are told, and empty areas write nothing");

  // A frame's grid changed through gridPatch: shorthands go, what they said stays.
  const patched = g.gridPatch({ display: "grid", gridTemplate: "auto auto / 1fr 1fr" }, { columns: { tracks: [{ size: "1fr" }, { size: "2fr" }, { size: "1fr" }] } });
  check(patched.gridTemplate === null && patched.gridTemplateRows === "auto auto" && patched.gridTemplateColumns === "1fr 2fr 1fr", `changing columns takes off grid-template and keeps its rows (${JSON.stringify(patched)})`);
  const flowP = g.gridPatch({ display: "grid" }, { flow: "column", dense: true, rowGap: "8px", columnGap: "12px" });
  check(flowP.gridAutoFlow === "column dense" && flowP.gap === "8px 12px", "flow and gaps are written as CSS has them");

  // Laid out by position, then as a grid.
  const box = (x: number, y: number, w: number, h: number) => ({ x, y, width: w, height: h });
  const six = [0, 1, 2, 3, 4, 5].map((i) => ({ id: `c${i}`, box: box((i % 3) * 116, Math.floor(i / 3) * 124, 100, 100) })).reverse();
  const plan = g.planGrid(six);
  check(plan.columns.join() === "1fr,1fr,1fr" && plan.rows.length === 2 && plan.columnGap === 16 && plan.rowGap === 24 && plan.order.join() === "c0,c1,c2,c3,c4,c5" && !plan.explicit, `six cards in two rows become a 3×2 grid in reading order (${JSON.stringify(plan)})`);
  const bento = g.planGrid([{ id: "big", box: box(0, 0, 200, 410) }, { id: "s1", box: box(210, 0, 120, 200) }, { id: "s2", box: box(210, 210, 120, 200) }]);
  check(bento.cells.big.rowSpan === 2 && bento.cells.s2.column === 2 && bento.cells.s2.row === 2 && !bento.explicit && bento.columns.join() === "200px,120px", `a tall card beside two short ones spans two rows (${JSON.stringify(bento)})`);
  const hole = g.planGrid([{ id: "a", box: box(0, 0, 100, 100) }, { id: "b", box: box(220, 0, 100, 100) }, { id: "c", box: box(110, 110, 100, 100) }]);
  check(hole.explicit && hole.cells.b.column === 3 && hole.cells.c.column === 2, "layers that leave holes are placed by hand");
  const ap = g.autoPlace([{ columnSpan: 2, rowSpan: 1 }, { columnSpan: 1, rowSpan: 1 }, { columnSpan: 2, rowSpan: 1 }], 3);
  check(ap.map((c) => `${c.column},${c.row}`).join(" ") === "1,1 3,1 1,2", "auto-placement is CSS's: an item too wide for what's left goes to the next row");

  // From flex.
  const fb = emptyBoard("fg", "Flex to grid", new Date().toISOString());
  const fmade = addHtmlOps(`<div data-name="Bar" style="display:flex;gap:12px;align-items:center;width:600px"><span>Logo</span><div data-name="Spacer" style="flex-grow:1;height:4px"></div><span style="align-self:flex-end">Menu</span></div>`, null, { page: fb.pages[0].id });
  const fboard = applyOps(fb, fmade.ops).board;
  const bar = fmade.roots[0];
  const conv = g.flexToGrid(fboard, bar)!;
  const spacer = Object.values(fboard.nodes).find((n) => n.name === "Spacer")!.id;
  const menu = fboard.nodes[bar].children![2];
  check(conv.frame.display === "grid" && conv.frame.gridTemplateColumns === "auto 1fr auto" && conv.frame.alignItems === "center" && conv.children[spacer].flexGrow === null && conv.children[menu].alignSelf === "end", `a flex row is a grid of a column per layer, the one that grew 1fr (${JSON.stringify(conv.frame)})`);
  check(g.flexToGrid({ ...fboard, nodes: { ...fboard.nodes, [bar]: { ...fboard.nodes[bar], style: { ...fboard.nodes[bar].style, flexWrap: "wrap" } } } }, bar) === null, "a flex frame that wraps is planned from where its layers are");

  // HTML in: grid as written, shorthands as longhands; read back in words.
  const gh = htmlToNodes(`<div data-name="Cards" style="display:inline-grid;grid-template:auto / repeat(3, 1fr);gap:16px;place-items:start"><div data-name="Wide" style="grid-area:1 / 1 / 2 / 3;height:40px"></div><div data-name="One" style="height:40px"></div><p>Words</p></div>`);
  const cards = gh.nodes[gh.roots[0]];
  const wide = Object.values(gh.nodes).find((n) => n.name === "Wide")!;
  check(cards.style.display === "grid" && cards.style.gridTemplateColumns === "repeat(3, 1fr)" && cards.style.gridTemplateRows === "auto" && !cards.style.gridTemplate && cards.style.justifyItems === "start" && cards.children!.length === 3, `a grid comes in as a grid frame, its shorthands as longhands (${JSON.stringify(cards.style)})`);
  check(wide.style.gridColumn === "1 / 3" && wide.style.gridRow === "1" && !wide.style.gridArea, "a layer's grid-area becomes its row and column");
  const hb = emptyBoard("gh", "Grid HTML", new Date().toISOString());
  const hboard = applyOps(hb, addHtmlOps(`<div data-name="Cards" style="display:grid;grid-template-columns:repeat(3, 1fr);gap:16px;width:600px"><div data-name="Wide" style="grid-column:span 2;height:40px"></div><div data-name="One" style="height:40px;justify-self:center;width:80px"></div></div>`, null, { page: hb.pages[0].id }).ops).board;
  const cardsId = Object.values(hboard.nodes).find((n) => n.name === "Cards")!.id;
  const tree = treeText(hboard, cardsId);
  check(/grid 3 columns · columns repeat\(3, 1fr\) · gap 16px/.test(tree) && /"Wide" #\w+ fill×40 .*cell column span 2/.test(tree) && /"One" #\w+ 80×40 .*justify-self center/.test(tree), `board_read's tree says the grid and where each layer sits:\n${tree}`);
  const sw = await import("../src/board/core.js");
  check(sw.sizeWord(hboard, Object.values(hboard.nodes).find((n) => n.name === "Wide")!.id, "width") === "fill", "a layer without a width fills its cell");
  check(/grid-template-columns:repeat\(3, 1fr\)/.test(nodeHtml(hboard, cardsId)) && /grid-column:span 2/.test(nodeHtml(hboard, cardsId)), "HTML out keeps the grid as it is");

  // Scale: gaps, padding and px tracks grow; fr, auto and spans don't change.
  const sb = { ...hboard, nodes: { ...hboard.nodes, [cardsId]: { ...hboard.nodes[cardsId], style: { ...hboard.nodes[cardsId].style, gap: "16px 24px", padding: "20px", gridTemplateColumns: "240px repeat(2, minmax(100px, 1fr))", gridAutoRows: "minmax(80px, auto)" } } } };
  const scaled = applyOps(sb, sw.scaleOps(sb, cardsId, 1.5)).board.nodes[cardsId].style;
  const wideScaled = applyOps(sb, sw.scaleOps(sb, cardsId, 1.5)).board.nodes[Object.values(hboard.nodes).find((n) => n.name === "Wide")!.id].style;
  check(scaled.gap === "24px 36px" && scaled.padding === "30px" && scaled.gridTemplateColumns === "360px repeat(2, minmax(150px, 1fr))" && scaled.gridAutoRows === "minmax(120px, auto)" && wideScaled.gridColumn === "span 2" && wideScaled.height === "60px", `the Scale tool scales a grid's gaps, padding and px tracks (${JSON.stringify(scaled)})`);

  // Undo puts a grid back exactly.
  const ch = applyOps(hboard, [{ op: "set", id: cardsId, style: g.gridPatch(hboard.nodes[cardsId].style, { columns: g.parseTracks("1fr 2fr"), rowGap: "4px", columnGap: "8px" }) }]);
  const back = applyOps(ch.board, ch.inverse).board.nodes[cardsId].style;
  check(ch.board.nodes[cardsId].style.gridTemplateColumns === "1fr 2fr" && JSON.stringify(back) === JSON.stringify(hboard.nodes[cardsId].style), "a change to a grid undoes exactly");

  // Components: a grid component's copies follow its tracks; where a copy sits in a grid is its own.
  let cb = applyOps(hboard, componentOps(hboard, cardsId)).board;
  const holder = htmlToNodes(`<div data-name="Page" style="display:grid;grid-template-columns:1fr 1fr;width:900px"></div>`);
  cb = applyOps(cb, [{ op: "add", nodes: holder.nodes, ids: holder.roots, parent: null, page: cb.pages[0].id }]).board;
  const inst = instanceTree(cb, cardsId, holder.roots[0]);
  inst.nodes[inst.id].style.gridColumn = "2";
  cb = applyOps(cb, expandOps(cb, [{ op: "add", nodes: inst.nodes, ids: [inst.id], parent: holder.roots[0] }])).board;
  const steps = expandOps(cb, [{ op: "set", id: cardsId, style: { gridTemplateColumns: "repeat(4, 1fr)", gridColumn: "1 / -1" } }]);
  cb = applyOps(cb, steps).board;
  check(cb.nodes[inst.id].style.gridTemplateColumns === "repeat(4, 1fr)" && cb.nodes[inst.id].style.gridColumn === "2", "a copy of a grid component follows its tracks, and keeps its own cell");
}

// Masks, as Figma has them, in HTML and CSS
{
  const m = await import("../src/board/core.js");
  const fresh = (htmlText: string) => {
    const b = emptyBoard("masks", "Masks", new Date().toISOString());
    const made = addHtmlOps(htmlText, null, { page: b.pages[0].id });
    return { board: applyOps(b, made.ops).board, root: made.roots[0] };
  };
  const named = (b: Board, name: string) => Object.values(b.nodes).find((n) => n.name === name)!.id;
  const CARD_M = `<div data-name="Card" style="position:relative;width:400px;height:400px;background:#fff"><div data-name="Below" style="position:absolute;left:0;top:0;width:40px;height:40px;background:#00f"></div><div data-name="Shape" data-mask style="position:absolute;left:100px;top:100px;width:200px;height:200px;border-radius:50%;background:#000"></div><div data-name="Photo" style="position:absolute;left:0;top:0;width:400px;height:400px;background:#f00"></div><div data-name="Hole" data-mask="luminance" style="position:absolute;left:0;top:300px;width:100px;height:100px;background:linear-gradient(#fff, #000)"></div><div data-name="Over" style="position:absolute;left:0;top:300px;width:100px;height:100px;background:#0f0"></div></div>`;
  const { board: mb, root } = fresh(CARD_M);
  const [shape, photo, below, hole, over] = ["Shape", "Photo", "Below", "Hole", "Over"].map((x) => named(mb, x));
  check(mb.nodes[shape].mask === "alpha" && mb.nodes[hole].mask === "luminance" && !mb.nodes[photo].mask, "data-mask makes a layer a mask (alpha unless it says luminance or vector)");
  check(m.maskOf(mb, photo) === shape && m.maskOf(mb, over) === hole && !m.maskOf(mb, below) && !m.maskOf(mb, shape) && m.maskedBy(mb, shape).join() === photo, "a mask masks the layers above it in its frame, up to the next mask");
  const out = nodeHtml(mb, root, { ids: true });
  const scope = out.indexOf("data-mask-scope");
  check(/data-mask="alpha" style="[^"]*visibility:hidden/.test(out) && scope > out.indexOf(`data-id="${shape}"`) && out.indexOf(`data-id="${photo}"`) > scope && out.indexOf(`data-id="${below}"`) < scope, "as HTML the mask is there but hidden, and what it masks is drawn inside the element that masks it; what's below isn't");
  check((out.match(/data-mask-scope/g) ?? []).length === 2 && /mask-mode:luminance/.test(out) && /-webkit-mask-image:linear-gradient\(#fff, #000\)/.test(out), "each mask has its own; a luminance mask's fill is its mask image, by brightness");
  const css = m.maskCss(mb, shape)!;
  check(css.scope.position === "absolute" && css.scope.inset === "0" && css.box.marginLeft === "100px" && css.box.marginTop === "100px" && css.box.width === "200px" && css.box.height === "200px", "the element that masks sits on the mask's box, inside one over the whole frame");
  check(css.box.clipPath === "inset(0 round 50%)" && css.box.webkitClipPath === css.box.clipPath && css.box.maskImage === "linear-gradient(#000, #000)" && css.box.webkitMaskImage === css.box.maskImage, "a frame's corners are a clip-path and its fill a mask image, with the -webkit- spellings too");
  const back = htmlToNodes(out);
  const rb = back.nodes[back.roots[0]];
  const kids = rb.children!.map((c) => back.nodes[c]);
  check(kids.map((k) => `${k.name}${k.mask ? `:${k.mask}` : ""}`).join() === "Below,Shape:alpha,Photo,Hole:luminance,Over" && !kids[1].style.visibility, "the HTML read back is the same layers: the mask a mask again, the elements that masked gone");
  const off = applyOps(mb, [{ op: "set", id: shape, hidden: true }]).board;
  check((nodeHtml(off, root).match(/data-mask-scope/g) ?? []).length === 1 && nodeHtml(off, root).indexOf(`data-id="${photo}"`) < nodeHtml(off, root).indexOf("data-mask-scope"), "a hidden mask masks nothing: its layers are drawn whole");
  // Kinds of mask.
  const kinds = fresh(
    `<div data-name="K" style="position:relative;width:600px;height:200px"><img data-name="Pic" data-mask src="/x/star.png" style="position:absolute;left:0;top:0;width:200px;height:200px;object-fit:cover;opacity:0.5"><div data-name="A" style="position:absolute;left:0;top:0;width:200px;height:200px;background:red"></div><svg data-name="Vec" data-mask="vector" style="position:absolute;left:200px;top:0;width:200px;height:200px;color:var(--ink)" viewBox="0 0 10 10"><circle cx="5" cy="5" r="5" fill="currentColor" fill-opacity="0.2"/></svg><div data-name="B" style="position:absolute;left:200px;top:0;width:200px;height:200px;background:red"></div><p data-name="Words" data-mask style="position:absolute;left:400px;top:0;width:200px;margin:0;font:700 60px/64px var(--face)">Big &amp; bold<br>words</p><div data-name="C" style="position:absolute;left:400px;top:0;width:200px;height:200px;background:red"></div><div data-name="Box" data-mask="vector" style="position:absolute;right:10px;bottom:10px;width:50px;height:50px;border-radius:8px 4px"></div><div data-name="D" style="position:absolute;left:0;top:0;width:600px;height:200px;background:red"></div></div>`,
  );
  const kb = { ...kinds.board, tokens: [{ name: "--ink", value: "#123456" }, { name: "--face", value: "Futura, sans-serif" }] };
  const pic = m.maskCss(kb, named(kb, "Pic"), { src: (s) => `file://${s}` })!;
  check(pic.box.maskImage === 'linear-gradient(rgb(255 255 255 / 0.5), rgb(255 255 255 / 0.5)), url("file:///x/star.png")' && pic.box.maskSize === "100% 100%, cover" && pic.box.maskComposite === "intersect, add" && pic.box.webkitMaskComposite === "source-in, source-over", "a picture masks by its alpha as object-fit places it, its opacity intersected over it");
  const vec = decodeURIComponent(m.maskCss(kb, named(kb, "Vec"))!.box.maskImage);
  check(vec.includes('<svg style="color:#123456"') && vec.includes('feFuncA type="linear" slope="255"') && vec.includes('width="100%" height="100%"'), "a vector mask is its SVG as a picture, its colour token filled in, every painted pixel made solid");
  const words = decodeURIComponent(m.maskCss(kb, named(kb, "Words"))!.box.maskImage);
  check(words.includes('<foreignObject x="0" y="0" width="100%" height="100%"><div xmlns="http://www.w3.org/1999/xhtml"') && words.includes("font:700 60px/64px Futura, sans-serif") && words.includes("Big &amp; bold<br/>words</div>"), "words mask as their own HTML and CSS in an SVG picture, tokens filled in, as XHTML");
  const box = m.maskCss(kb, named(kb, "Box"))!;
  check(!box.box.maskImage && box.box.clipPath === "inset(0 round 8px 4px 8px 4px)" && box.box.marginLeft === "calc(100% - 10px - 50px)" && box.box.marginBottom === "10px" && box.scope.justifyContent === "flex-end", "a vector mask of a frame is its outline, placed from the right and bottom");
  check(m.resolveTokens("var(--a, 3px) var(--b)", [{ name: "--b", value: "var(--a, 9px)" }]) === "3px 9px", "tokens resolve through fallbacks and other tokens");
  // CSS masks it can say as a mask layer become one; others stay CSS.
  const cssMask = htmlToNodes(`<div style="position:relative;width:200px;height:200px;mask-image:linear-gradient(#000, transparent)"><img src="/x/a.png" style="position:absolute;left:0;top:0;width:200px;height:200px"></div>`);
  const cm = cssMask.nodes[cssMask.roots[0]];
  const first = cssMask.nodes[cm.children![0]];
  check(first.mask === "alpha" && first.style.backgroundImage === "linear-gradient(#000, transparent)" && !cm.style.maskImage && cm.children!.length === 2, "a CSS gradient mask over layers placed by hand becomes a mask layer under them");
  const lum = htmlToNodes(`<div style="position:relative;width:200px;height:200px;-webkit-mask-image:url(/x/m.png);-webkit-mask-size:cover;mask-mode:luminance"><div style="position:absolute;left:0;top:0;width:200px;height:200px;background:red"></div></div>`);
  const lm = lum.nodes[lum.nodes[lum.roots[0]].children![0]];
  check(lm.type === "image" && lm.src === "/x/m.png" && lm.style.objectFit === "cover" && lm.mask === "luminance", "a CSS picture mask becomes a picture mask layer, sized as it was");
  const flowing = htmlToNodes(`<div style="width:200px;mask-image:linear-gradient(#000, transparent)"><p>Words that flow</p></div>`);
  check(flowing.nodes[flowing.roots[0]].style.maskImage === "linear-gradient(#000, transparent)" && !Object.values(flowing.nodes).some((n) => n.mask), "a CSS mask over flowing layers stays CSS (it draws as written)");
  // Making and removing masks: one layer, several (a mask group), in a flex frame, and undo.
  const plain = fresh(`<div data-name="P" style="position:relative;width:300px;height:300px"><div data-name="S" style="position:absolute;left:20px;top:30px;width:100px;height:80px;background:#000"></div><div data-name="T" style="position:absolute;left:50px;top:60px;width:200px;height:200px;background:red"></div><div data-name="R" style="display:flex;position:absolute;left:0;top:200px;width:300px;height:100px"><div data-name="F1" style="width:60px;height:60px;background:#000"></div><div data-name="F2" style="width:60px;height:60px"></div></div></div>`);
  const pb = plain.board;
  const [S1, T1, F1] = ["S", "T", "F1"].map((x) => named(pb, x));
  const one = m.maskOps(pb, S1, "vector");
  const put = applyOps(pb, one.ops);
  check(put.board.nodes[S1].mask === "vector" && JSON.stringify(applyOps(put.board, put.inverse).board.nodes) === JSON.stringify(pb.nodes), "Use as mask makes a layer a mask, and undo puts it back exactly");
  check(m.maskOps(put.board, S1, null).ops.length === 1 && !applyOps(put.board, m.maskOps(put.board, S1, null).ops).board.nodes[S1].mask, "a mask is made an ordinary layer again");
  let refused = "";
  try {
    m.maskOps(pb, plain.root, "alpha");
  } catch (e) {
    refused = e instanceof OpError ? e.message : "";
  }
  check(/inside a frame/.test(refused), "a layer on the page can't be a mask on its own");
  const grouped = m.maskGroupOps(pb, [T1, S1], "alpha");
  const g = applyOps(pb, grouped.ops);
  const gn = g.board.nodes[grouped.group];
  check(gn.name === "Mask group" && gn.children!.join() === `${S1},${T1}` && gn.style.left === "20px" && gn.style.top === "30px" && gn.style.width === "100px" && g.board.nodes[T1].style.left === "30px" && g.board.nodes[S1].style.left === "0px" && g.board.nodes[S1].mask === "alpha", "Mask with selection makes a mask group on the mask's box, the one at the back the mask, the rest where they were");
  check(JSON.stringify(applyOps(g.board, g.inverse).board.nodes) === JSON.stringify(pb.nodes), "and undo takes it all back");
  const inFlex = m.maskOps(pb, F1, "alpha");
  const fg = applyOps(pb, inFlex.ops).board;
  check(Boolean(inFlex.group) && fg.nodes[inFlex.group!].parent === named(pb, "R") && fg.nodes[inFlex.group!].style.position === "relative" && fg.nodes[F1].style.position === "absolute" && fg.nodes[F1].mask === "alpha" && !m.inFlow(fg, F1), "a mask in a flex frame goes in a mask group of its own, which is an item of the flex layout");
  const gridded = fresh(`<div data-name="G" style="display:grid;grid-template-columns:100px 100px;width:200px;height:100px"><div data-name="A1" style="height:100px;background:#eee"></div><div data-name="Spot" style="grid-column:2;grid-row:1;justify-self:center;width:80px;height:80px;border-radius:50%;background:#000"></div></div>`);
  const spot = named(gridded.board, "Spot");
  const inGrid = m.maskOps(gridded.board, spot, "alpha", { [spot]: { x: 110, y: 0, width: 80, height: 80 } });
  const gg = applyOps(gridded.board, inGrid.ops).board;
  const cell = gg.nodes[inGrid.group!].style;
  check(cell.gridColumn === "2" && cell.gridRow === "1" && cell.justifySelf === "center" && cell.width === "80px" && !gg.nodes[spot].style.gridColumn && gg.nodes[spot].style.left === "0px", "in a grid, the mask group takes the mask's cell and alignment; the mask, inside it, is placed by hand");
  // Duplicates, scaling, components.
  const dup = m.copyTree(put.board, S1, plain.root);
  check(dup.nodes[dup.id].mask === "vector", "a duplicate of a mask is a mask");
  const scaled = applyOps(put.board, m.scaleOps(put.board, plain.root, 2)).board;
  check(scaled.nodes[S1].style.width === "200px" && scaled.nodes[S1].style.left === "40px" && m.maskCss(scaled, S1)!.box.marginLeft === "40px", "scaling a frame scales its mask's box with everything else");
  const comp = applyOps(put.board, componentOps(put.board, plain.root)).board;
  const inst = instanceTree(comp, plain.root, null);
  const withCopy = applyOps(comp, [{ op: "add", nodes: inst.nodes, ids: [inst.id], parent: null, page: comp.pages[0].id }]).board;
  const copyOfS = Object.values(withCopy.nodes).find((n) => n.master === S1)!.id;
  const changed = applyOps(withCopy, expandOps(withCopy, [{ op: "set", id: S1, mask: "luminance" }])).board;
  check(withCopy.nodes[copyOfS].mask === "vector" && changed.nodes[copyOfS].mask === "luminance", "a component's copies follow its masks");
  // A text mask's web font, fetched (here from a stand-in for Google Fonts) into the mask's picture,
  // since an SVG drawn as an image can't load fonts itself.
  {
    const fb = fresh(`<div style="position:relative;width:300px;height:100px"><p data-name="Logo" data-mask style="position:absolute;left:0;top:0;margin:0;font-family:'Brand Sans',sans-serif;font-weight:700">Hi</p><div style="position:absolute;left:0;top:0;width:300px;height:100px;background:red"></div></div>`);
    const asked: string[] = [];
    const fakeFetch = async (url: string) => {
      asked.push(url);
      const css = "/* latin */ @font-face { font-family: 'Brand Sans'; font-weight: 700; src: url(https://fonts.gstatic.com/brand.woff2) format('woff2'); unicode-range: U+0000-00FF; } /* greek */ @font-face { font-family: 'Brand Sans'; src: url(https://fonts.gstatic.com/greek.woff2) format('woff2'); unicode-range: U+0370-03FF; }";
      return { ok: true, text: async () => css, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer };
    };
    const added = await m.loadMaskFonts(fb.board, fakeFetch);
    const svg = decodeURIComponent(m.maskCss(fb.board, named(fb.board, "Logo"))!.box.maskImage);
    check(added && asked.some((u) => /family=Brand\+Sans:ital,wght@0,400;0,700;1,400;1,700/.test(u)) && asked.includes("https://fonts.gstatic.com/brand.woff2") && !asked.includes("https://fonts.gstatic.com/greek.woff2") && svg.includes("src:url(data:font/woff2;base64,AQID)"), "a text mask's web font is fetched (only the parts its words need) and put inside its picture");
    // Type written with the font shorthand: its family and weight count, and a size of the layer's own wins over one it inherits.
    const sh = fresh(`<div style="position:relative;width:300px;height:100px;font:500 14px/1.2 -apple-system, sans-serif"><p data-name="Big" data-mask style="position:absolute;left:0;top:0;margin:0;font:900 90px/1 'Other Face', Helvetica">Go</p><p data-name="Small" data-mask style="position:absolute;left:0;top:0;margin:0;font-size:20px">Go</p><div style="position:absolute"></div></div>`);
    const asked2: string[] = [];
    await m.loadMaskFonts(sh.board, async (u: string) => (asked2.push(u), { ok: false, text: async () => "", arrayBuffer: async () => new ArrayBuffer(0) }));
    const small = decodeURIComponent(m.maskCss(sh.board, named(sh.board, "Small"))!.box.maskImage);
    check(asked2.length === 1 && /family=Other\+Face:ital,wght@0,400;0,900/.test(asked2[0]) && /font:500 14px\/1\.2 system-ui, sans-serif;font-size:20px/.test(small), "a text mask's type in the font shorthand: its family and weight are fetched, and its own size wins over the inherited shorthand");
  }
  check(/mask \(vector\) of 2 layers above it/.test(treeText(put.board, plain.root)) && new RegExp(`masked by #${S1}`).test(treeText(put.board, plain.root)), "the outline says what's a mask and what it masks");
}

// A vector's own pictures (<image href="/a/file.png">) go through the same `src` as image layers'
// (the Studio serves only /file?path=…), in its parts, its defs and an svg kept as one piece.
{
  const m = await import("../src/board/core.js");
  const src = (s: string) => `/file?path=${encodeURIComponent(s)}`;
  const parts = addHtmlOps(`<svg data-name="Pics" viewBox="0 0 100 100" style="width:100px;height:100px"><defs><pattern id="p" width="1" height="1"><image xlink:href="/lib/tile.png" width="10" height="10"/></pattern></defs><image href="/lib/a b.png" width="50" height="50"/><use href="#p"/><rect fill="url(#p)" width="10" height="10"/></svg>`, null, {});
  const pb: Board = { ...emptyBoard("pics", "Pics", new Date().toISOString()), nodes: parts.nodes };
  const root = parts.roots[0];
  pb.nodes[root].parent = null;
  const out = nodeHtml(pb, root, { src });
  check(out.includes(`href="/file?path=%2Flib%2Fa%20b.png"`) && out.includes(`xlink:href="/file?path=%2Flib%2Ftile.png"`) && out.includes(`<use href="#p"`), `an <image>'s href and xlink:href load through src, in a part and in defs; a link inside the SVG stays (${out.slice(0, 400)})`);
  check(nodeHtml(pb, root).includes(`href="/lib/a b.png"`) && pb.nodes[Object.keys(pb.nodes).find((k) => pb.nodes[k].tag === "image")!].attrs!.href === "/lib/a b.png", "without src (board_read) the paths are as written, and the layer keeps them");
  const whole = m.mapSvgImages(`<svg><image x="0" xlink:href='/lib/c&amp;d.png'/><image href="https://x.test/e.png"/><image href="data:image/png;base64,AA"/></svg>`, (s) => (/^(https?:|data:)/.test(s) ? s : src(s)));
  check(whole.includes(`xlink:href="/file?path=%2Flib%2Fc%26d.png"`) && whole.includes(`href="https://x.test/e.png"`) && whole.includes(`href="data:image/png;base64,AA"`), `an svg kept as one piece has its pictures mapped too, entities read and quotes either way (${whole})`);
}

// ---------------------------------------------------------------------------------------------
// Shaders: the model (presets, parameters, HTML in and out, steps and undo, components, scale),
// code compiled where it runs (errors by line), and pictures of them (not blank, the same at the
// same moment, tokens resolved where they're drawn).
{
  const sh = await import("../src/board/core.js");
  const { decodePng, pixelAt } = await import("../src/util/png.js");
  const { drawLayers } = await import("../src/board/render.js");
  const { compileShaders } = await import("../src/board/shader-check.js");

  // Parameters, as the comments on uniforms declare them.
  const CODE = [
    "uniform float uWarp; // @param 0..2 = 0.9 \"Warp it\"",
    "uniform float uSpacing; // @param 4..40 = 11 px",
    "uniform int uLevels; // @param 2..8 = 4",
    "uniform vec3 uTint; // @colour = #ff5a1f",
    "uniform vec4 uGlow; // @color = var(--brand)",
    "uniform int uMode; // @choice soft|hard|wild = hard",
    "uniform float uLonely;",
    "uniform vec3 uWrong; // @param 0..1 = 0",
    "void main() { gl_FragColor = vec4(uTint * uWarp, 1.0); }",
  ].join("\n");
  const parsed = sh.parseShaderParams(CODE);
  const p = Object.fromEntries(parsed.params.map((x) => [x.key, x]));
  check(parsed.params.length === 6 && p.warp.label === "Warp it" && p.warp.min === 0 && p.warp.max === 2 && p.warp.default === 0.9 && p.warp.step === 0.02, "a @param is a number with its range, default, step and label");
  check(p.spacing.px === true && p.levels.glsl === "int" && p.levels.step === 1 && p.tint.kind === "color" && p.tint.default === "#ff5a1f" && p.tint.label === "Tint" && p.glow.default === "var(--brand)", "px lengths, whole numbers and colours (tokens too) are read");
  check(p.mode.kind === "choice" && p.mode.options?.join() === "soft,hard,wild" && p.mode.default === "hard", "a @choice has its words and default");
  check(parsed.warnings.some((w) => /Line 7 \(uLonely\)/.test(w)) && parsed.warnings.some((w) => /Line 8 \(uWrong\).*not a vec3/.test(w)), `uniforms without a comment, or with the wrong one, are said by line (${parsed.warnings.join(" | ")})`);
  // Every preset declares its parameters cleanly, and its defaults are good values.
  const bad = sh.SHADER_PRESETS.filter((pr) => {
    const r = sh.parseShaderParams(pr.code);
    return r.warnings.length || r.params.length < 2 || r.params.some((x) => sh.shaderParamValue(x, x.default) === undefined);
  });
  check(sh.SHADER_PRESETS.length >= 8 && ["mesh-gradient", "grain-gradient", "liquid-chrome", "dither", "halftone", "light-rays", "waves", "aurora"].every((id) => sh.presetOf(id)) && !bad.length, `${sh.SHADER_PRESETS.length} presets, each with its parameters (${bad.map((x) => x.id).join(", ") || "all clean"})`);

  // Values made safe.
  check(sh.shaderParamValue(p.warp, 9) === 2 && sh.shaderParamValue(p.warp, "1.25") === 1.25 && sh.shaderParamValue(p.levels, 3.6) === 4 && sh.shaderParamValue(p.warp, "lots") === undefined && sh.shaderParamValue(p.warp, Infinity) === undefined, "numbers are clamped to their range, whole for an int, and nonsense refused");
  const colours = ["#abc", "rgb(10 20 30 / 50%)", "oklch(70% 0.2 30)", "var(--brand, #000)", "rebeccapurple"];
  const evil = ["red;background:url(x)", '"><script>alert(1)</script>', "url(javascript:alert(1))", "expression(alert(1))", "var(--a);x:y"];
  check(colours.every((c) => sh.shaderParamValue(p.tint, c) === c) && evil.every((c) => sh.shaderParamValue(p.tint, c) === undefined), "colours are CSS colours or tokens, and nothing else gets through");
  check(sh.shaderParamValue(p.mode, "WILD") === "wild" && sh.shaderParamValue(p.mode, 0) === "soft" && sh.shaderParamValue(p.mode, "loud") === undefined, "a choice is one of its words (or their index)");
  const u = sh.shaderUniforms(CODE, { warp: 1.5, mode: "wild", spacing: 20, tint: "var(--brand)" });
  check(u.uWarp === 1.5 && u.uMode === 2 && u.uSpacing === "20px" && u.uTint === "var(--brand)" && u.uLevels === 4 && u.uGlow === "var(--brand)", `uniforms: choices by index, lengths as px, colours as CSS (${JSON.stringify(u)})`);
  const warned: string[] = [];
  const kept = sh.cleanShaderParams(CODE, { uWarp: 3, ghost: 1, tint: "red;x:y", mode: "soft" }, warned);
  check(kept.warp === 2 && kept.mode === "soft" && !("ghost" in kept) && !("tint" in kept) && warned.some((w) => /no parameter "ghost"/.test(w)) && warned.some((w) => /isn't a value for tint/.test(w)), "unknown params and bad values are left out, and said");
  const spec = sh.cleanShaderSpec({ preset: "Mesh Gradient", code: "x\u0000yé", params: { a: 1, "b c": 2, d: "</script>", e: { x: 1 } }, speed: 99, time: "3", paused: "true" });
  check(spec.preset === "mesh-gradient" && spec.code === "x y " && JSON.stringify(spec.params) === '{"a":1}' && spec.speed === 10 && spec.time === 3 && spec.paused === true, `a shader is kept clean whatever it came from (${JSON.stringify(spec)})`);

  // HTML in and out.
  const wrote = htmlToNodes(`<div style="position:relative;width:600px;height:400px"><div data-shader="halftone" data-params='{"spacing":14,"ink":"var(--brand)"}' data-speed="0.5" data-time="2.5" data-paused style="position:absolute;inset:0;border-radius:24px"></div><canvas data-shader="custom" data-name="Mine" width="200" height="100"><script type="x-shader/x-fragment">uniform vec3 uTint; // @color = #00ff00
void main() { gl_FragColor = vec4(uTint, 1.0); }</script></canvas><canvas data-shader="aurora" data-params="{oops"></canvas></div>`);
  const kids = wrote.nodes[wrote.roots[0]].children!.map((id) => wrote.nodes[id]);
  const [ht, mine, broken] = kids;
  check(ht.type === "shader" && ht.shader?.preset === "halftone" && ht.shader.params?.spacing === 14 && ht.shader.speed === 0.5 && ht.shader.time === 2.5 && ht.shader.paused === true && ht.style.inset === "0" && !ht.style.height, "<div data-shader> is a shader layer with its params, speed, time and pause, sized by its CSS");
  check(mine.type === "shader" && !mine.shader?.preset && /gl_FragColor = vec4\(uTint/.test(mine.shader?.code ?? "") && mine.style.width === "200px" && mine.style.height === "100px" && mine.name === "Mine", "<canvas data-shader=custom> takes its GLSL from a script inside it, and its size from its attributes");
  check(broken.type === "shader" && broken.shader?.preset === "aurora" && broken.style.height === "300px" && wrote.warnings.some((w) => /data-params isn't JSON/.test(w)), "bad data-params is said, and a shader sized by nothing gets a size");
  let sb: Board = emptyBoard("shaderboard", "Shaders", new Date().toISOString());
  sb.tokens = [{ name: "--brand", value: "#ff0000" }];
  sb = applyOps(sb, [{ op: "add", nodes: wrote.nodes, ids: wrote.roots, parent: null, page: sb.pages[0].id }]).board;
  const frame = wrote.roots[0];
  const plain = nodeHtml(sb, frame);
  const played = nodeHtml(sb, frame, { code: true });
  check(/<div data-shader="halftone" data-params="\{&quot;spacing&quot;:14,&quot;ink&quot;:&quot;var\(--brand\)&quot;\}" data-speed="0.5" data-time="2.5" data-paused style="[^"]*"|<div style="[^"]*" data-shader="halftone"/.test(plain) && !/data-shader="halftone"[^>]*data-code/.test(plain) && /data-shader="custom"[^>]*data-code="uniform vec3 uTint/.test(plain) && /<canvas style="display:block;width:100%;height:100%;border-radius:inherit"><\/canvas>/.test(plain), "out as HTML: a preset by name, code of its own carried, a canvas inside each");
  check(/data-shader="halftone"[^>]*data-code="[^"]*uSpacing[^"]*" data-uniforms="\{&quot;uInk&quot;:&quot;var\(--brand\)&quot;[^"]*uSpacing&quot;:&quot;14px/.test(played), "for a page that plays it, each carries its GLSL and its uniforms");
  const round = htmlToNodes(plain);
  const back = Object.values(round.nodes).filter((n) => n.type === "shader");
  check(back.length === 3 && JSON.stringify(back.map((n) => n.shader)) === JSON.stringify([ht.shader, mine.shader, broken.shader]), "HTML out comes back in as the same shaders");
  const sneaky = { ...sb, nodes: { ...sb.nodes, [mine.id]: { ...mine, shader: { code: 'void main(){} // </script><script>alert(1)</script>"><img src=x onerror=alert(1)>' } } } };
  const safe = nodeHtml(sneaky, mine.id, { code: true });
  check(!/<script|<img/i.test(safe) && /&lt;\/script>/.test(safe), "code can't break out of its attribute: no script or element gets through");

  // Steps, undo, a board's own presets.
  const set = applyOps(sb, [{ op: "set", id: ht.id, shader: { preset: "dither", params: { pixel: 4 } } }]);
  check(set.board.nodes[ht.id].shader?.preset === "dither" && applyOps(set.board, set.inverse).board.nodes[ht.id].shader?.preset === "halftone", "a shader changes as one step, and undoes");
  const saved = applyOps(sb, sh.saveShaderPresetOps(sb, mine.id, "Green Glow"));
  check(saved.board.shaders?.[0]?.name === "green-glow" && saved.board.nodes[mine.id].shader?.preset === "green-glow" && sh.shaderUsers(saved.board, "green-glow").join() === mine.id && !applyOps(saved.board, saved.inverse).board.shaders, "a shader saved as the board's own preset is used by its layer, and undoes");
  let refused = "";
  try {
    applyOps(sb, [{ op: "shaderPreset", name: "aurora", code: "void main(){}" }]);
  } catch (e) {
    refused = (e as Error).message;
  }
  check(/built-in/.test(refused), "a board's preset can't take a built-in one's name");
  const edited = applyOps(saved.board, [{ op: "shaderPreset", name: "green-glow", code: "void main() { gl_FragColor = vec4(0.0, 0.0, 1.0, 1.0); }" }]).board;
  check(/0\.0, 0\.0, 1\.0/.test(sh.shaderCode(edited.nodes[mine.id].shader, edited.shaders) ?? "") && /uTint/.test(sh.shaderCode(edited.nodes[mine.id].shader, []) ?? ""), "editing the board's preset changes its layers; without it, a layer falls back on its own code");
  const replaced = applyOps(saved.board, [{ op: "replace", pages: sb.pages, nodes: sb.nodes, tokens: sb.tokens, shaders: [] }]);
  check(!replaced.board.shaders && applyOps(replaced.board, replaced.inverse).board.shaders?.length === 1, "replacing the whole board takes its presets with it, and undoes");
  check(/shader "halftone" \(preset\), params spacing=14 ink=var\(--brand\), speed 0.5, still at 2.5s, paused/.test(treeText(sb, frame)) && /shader of its own code \(2 lines\)/.test(treeText(sb, frame)), "the outline says what each shader is");

  // Components and the Scale tool.
  let cb: Board = { ...sb };
  cb = applyOps(cb, [{ op: "set", id: frame, isComponent: true }]).board;
  const copy = instanceTree(cb, frame, null);
  cb = applyOps(cb, [{ op: "add", nodes: copy.nodes, ids: [copy.id], parent: null, page: cb.pages[0].id }]).board;
  const follower = Object.values(cb.nodes).find((n) => n.master === ht.id)!;
  cb = applyOps(cb, expandOps(cb, [{ op: "set", id: ht.id, shader: { preset: "halftone", params: { spacing: 20 } } }])).board;
  const follows = cb.nodes[follower.id].shader?.params?.spacing === 20;
  cb = applyOps(cb, expandOps(cb, [{ op: "set", id: follower.id, shader: { preset: "waves" } }])).board;
  cb = applyOps(cb, expandOps(cb, [{ op: "set", id: ht.id, shader: { preset: "halftone", params: { spacing: 30 } } }])).board;
  check(follows && cb.nodes[follower.id].shader?.preset === "waves" && cb.nodes[follower.id].overrides?.includes("shader"), "a component's copies follow its shader, until a copy changes its own");
  const { scaleOps } = await import("../src/board/core.js");
  const sized = applyOps(sb, [{ op: "set", id: ht.id, style: { inset: null, width: "300px", height: "200px" } }]).board;
  const scaled = applyOps(sized, scaleOps(sized, ht.id, 2)).board.nodes[ht.id];
  check(scaled.style.width === "600px" && scaled.shader?.params?.spacing === 28 && scaled.shader.params.ink === "var(--brand)", "the Scale tool scales a shader's box and its lengths in px");
  // Masked: drawn inside what masks it, as any layer.
  const masked = htmlToNodes(`<div style="position:relative;width:200px;height:200px"><div data-mask style="position:absolute;left:0;top:0;width:200px;height:200px;border-radius:50%;background:#000"></div><div data-shader="mesh-gradient" style="position:absolute;left:0;top:0;width:200px;height:200px"></div></div>`);
  let mb: Board = emptyBoard("maskshader", "Masked", new Date().toISOString());
  mb = applyOps(mb, [{ op: "add", nodes: masked.nodes, ids: masked.roots, parent: null, page: mb.pages[0].id }]).board;
  check(/data-mask-scope[^>]*><div style="[^"]*mask-image[^"]*"><div[^>]*data-shader="mesh-gradient"/.test(nodeHtml(mb, masked.roots[0])), "a shader above a mask is drawn inside what masks it");

  // Compiled where it runs: errors by the line they're on.
  const good = "uniform vec3 uTint; // @color = #ff0000\nvoid main() {\n  gl_FragColor = vec4(uTint, 1.0);\n}";
  const oops = "uniform vec3 uTint; // @color = #ff0000\nvoid main() {\n  float a = 1.0;\n  gl_FragColor = vec4(oops, 1.0);\n}";
  const v3 = "#version 300 es\nout vec4 colour;\nvoid main() {\n  colour = vec4(nope);\n}";
  const toy = "void mainImage(out vec4 c, in vec2 p) { c = vec4(p / iResolution.xy, sin(iTime), 1.0); }";
  const compiled = await compileShaders([good, oops, v3, toy, "", ...sh.SHADER_PRESETS.map((x) => x.code)]);
  if ("unavailable" in compiled) check(false, `shaders compile in headless Chrome (${compiled.unavailable})`);
  else {
    const e = (c: string) => compiled.get(c) ?? [];
    check(!e(good).length && !e(toy).length, "good code compiles, Shadertoy's mainImage too");
    check(e(oops)[0]?.line === 4 && /oops/.test(e(oops)[0].message), `an error names the line it's on (${JSON.stringify(e(oops))})`);
    check(e(v3)[0]?.line === 4 && /nope/.test(e(v3)[0].message), `GLSL 3.00 compiles in WebGL 2, its errors on their lines too (${JSON.stringify(e(v3))})`);
    check(/no shader code/.test(e("")[0]?.message ?? ""), "no code at all is said");
    check(sh.SHADER_PRESETS.every((x) => !e(x.code).length), `every preset compiles (${sh.SHADER_PRESETS.filter((x) => e(x.code).length).map((x) => `${x.id}: ${JSON.stringify(e(x.code))}`).join("; ")})`);
  }

  // Pictures: not blank, the same at the same moment, another moment another picture, tokens resolved.
  const pic = htmlToNodes(`<div data-name="Art" style="width:240px;height:160px;display:flex;background:#fff"><div data-shader="mesh-gradient" data-time="4" style="width:120px;height:160px;flex-shrink:0"></div><div data-shader="custom" data-code="uniform vec3 uTint; // @color = #00ff00
void main() { gl_FragColor = vec4(uTint, 1.0); }" data-params='{"tint":"var(--brand)"}' style="width:60px;height:160px;flex-shrink:0"></div><div data-shader="custom" data-code="void main() { gl_FragColor = vec4(oops); }" style="width:60px;height:160px;flex-shrink:0"></div></div>`);
  let pb: Board = emptyBoard("pics", "Pictures", new Date().toISOString());
  pb.tokens = [{ name: "--brand", value: "#0000ff" }];
  pb = applyOps(pb, [{ op: "add", nodes: pic.nodes, ids: pic.roots, parent: null, page: pb.pages[0].id }]).board;
  const art = pic.roots[0];
  const [mesh, tinted, failing] = pb.nodes[art].children!;
  const shot1 = decodePng((await drawLayers(pb, [art], { scale: 1 })).images[art]);
  const shot2 = decodePng((await drawLayers(pb, [art], { scale: 1 })).images[art]);
  const later = applyOps(pb, [{ op: "set", id: mesh, shader: { preset: "mesh-gradient", time: 9 } }]).board;
  const shot3 = decodePng((await drawLayers(later, [art], { scale: 1 })).images[art]);
  const meshPixels = (f: ReturnType<typeof decodePng>) => {
    const seen = new Set<string>();
    for (let y = 4; y < 156; y += 6) for (let x = 4; x < 116; x += 6) seen.add(pixelAt(f, x, y).slice(0, 3).map((v) => v >> 3).join());
    return seen;
  };
  const same = Buffer.compare(shot1.rgba, shot2.rgba) === 0;
  const differs = [...meshPixels(shot1)].join("|") !== [...meshPixels(shot3)].join("|");
  check(meshPixels(shot1).size > 20, `a shader in a picture isn't blank (${meshPixels(shot1).size} colours)`);
  check(same && differs, "drawn twice at its time it's the same picture; at another time, another");
  const tint = pixelAt(shot1, 150, 80);
  check(tint[2] > 240 && tint[0] < 20 && tint[1] < 20, `a colour param that's a token is drawn in the token's colour (${tint})`);
  const recoloured = applyOps(pb, [{ op: "token", name: "--brand", value: "#ff8800" }]).board;
  const tint2 = pixelAt(decodePng((await drawLayers(recoloured, [art], { scale: 1 })).images[art]), 150, 80);
  check(tint2[0] > 240 && tint2[1] > 120 && tint2[1] < 150 && tint2[2] < 20, `change the token and the shader follows (${tint2})`);
  const card = pixelAt(shot1, 215, 20);
  check(card[0] > 20 && card[0] > card[2] && card[3] === 255, `a shader that doesn't compile shows its error card, and the rest of the board still draws (${card})`);
  const two = decodePng((await drawLayers(pb, [art], { scale: 2 })).images[art]);
  check(two.width === 480 && meshPixels(two).size > 0 && pixelAt(two, 300, 160)[2] > 240, "at 2× the shaders are drawn at 2×");
  void tinted;
  void failing;
}

// ---------------------------------------------------------------------------------------------
// The tools, through MCP

const out = mkdtempSync(path.join(tmpdir(), "board-test-"));
// A stand-in for Agentman, so nothing here reaches the person's real agents. The MCP server finds
// its agent as it would under Claude Code: a record of the session kept under this process's id.
const socket = path.join(out, "am.sock");
process.env.SCREENSHOTTER_AGENTMAN_SOCKET = socket;
process.env.SCREENSHOTTER_OUTPUT_DIR = out;
const AGENT = "claude:test-session-1";
const fake = await fakeAgentman(socket, [
  { id: AGENT, kind: "claude", name: "Design agent", cwd: process.cwd(), state: "idle", inject: "tmux" },
  { id: "claude:someone-else", kind: "claude", name: "Another agent", cwd: "/elsewhere", state: "idle", inject: "hook" },
]);
const claudeDir = path.join(out, "claude");
mkdirSync(path.join(claudeDir, "sessions"), { recursive: true });
writeFileSync(path.join(claudeDir, "sessions", `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: "test-session-1", cwd: process.cwd(), name: "design-agent", kind: "interactive" }));
const client = new Client({ name: "board-test", version: "0.0.0" });
await client.connect(
  new StdioClientTransport({
    command: "node",
    args: ["dist/index.js"],
    env: { ...(process.env as Record<string, string>), SCREENSHOTTER_OUTPUT_DIR: out, SCREENSHOTTER_STUDIO_FILE: path.join(out, "studio.json"), SCREENSHOTTER_AGENTMAN_SOCKET: socket, CLAUDE_CONFIG_DIR: claudeDir },
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
const toScale = await call("board_write_html", { board, html: `<div data-name="Snippet" style="width:420px;padding:16px 20px;border-radius:var(--radius, 12px);border:1px solid #333;background:#1d1b16;box-shadow:0 2px 8px rgba(0,0,0,.3)"><p style="margin:0;font-size:13px">TodoList.tsx</p><p style="margin:12px 0 0">const <span style="font-size:14px">todos</span></p></div>` });
const snip = toScale.json.created[0].id;
await call("board_edit", { board, changes: [{ do: "style", ids: [snip], style: { gap: 10 } }, { do: "scale", ids: [snip], by: 2 }] });
const snipHtml = (await call("board_read", { board, what: "html", node: snip })).text;
check(
  ["width:840px", "padding:32px 40px", "border-radius:calc(var(--radius, 12px) * 2)", "border:2px solid #333", "box-shadow:0 4px 16px", "font-size:26px", "margin:24px 0 0", "font-size:28px", "gap:20px", "font-size:32px"].every((s) => snipHtml.includes(s)),
  "board_edit scale grows a layer with everything in it: type, padding, borders, shadows, tokens, and its inherited type size",
);
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
{
  // Around the frame is see-through, not white, so the device sits on whatever is behind it.
  const { readBmp } = await import("../src/util/png.js");
  const { execFileSync } = await import("node:child_process");
  const bmp = path.join(out, "device.bmp");
  execFileSync("sips", ["-s", "format", "bmp", dev.json.results[0].picture, "--out", bmp], { stdio: "ignore" });
  const f = readBmp(readFileSync(bmp));
  const alpha = (x: number, y: number) => f.rgba[(y * f.width + x) * 4 + 3];
  check(alpha(2, 2) === 0 && alpha(f.width - 3, f.height - 3) === 0 && alpha(f.width >> 1, f.height >> 1) === 255, `a device picture is see-through round the frame (corner alpha ${alpha(2, 2)}, middle ${alpha(f.width >> 1, f.height >> 1)})`);
}
// In one batch, each change works from the ones before it: a copy placed after its component was restyled has the new style.
const pillMade = await call("board_write_html", { board, target: art, html: `<div data-name="Pill" style="display:flex;padding:6px 12px;background:#dddddd"><span>Pill</span></div>` });
const pill = pillMade.json.created[0].id;
const batch = await call("board_edit", { board, changes: [{ do: "component", id: pill }, { do: "style", ids: [pill], style: { background: "#ff3b30" } }, { do: "copy", of: pill, into: art }] });
const pillCopy = await call("board_read", { board, what: "html", node: batch.json.results[2].copy });
check(/background:#ff3b30/.test(pillCopy.text), "in one board_edit, a copy placed after its component was restyled has the new style");
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
const renamed = await call("board_edit", { board, changes: [{ do: "token", name: "brand", rename: "primary" }] });
const tokensNow = await call("board_read", { board, what: "tokens" });
const cardHtml = await call("board_read", { board, what: "html", node: card });
check(renamed.json.results[0].renamed === "--primary" && /--primary/.test(tokensNow.text) && !/"--brand"/.test(tokensNow.text) && /var\(--primary\)/.test(cardHtml.text), "an agent renames a token, and the layers using it follow");
const shot = await call("board_screenshot", { board, nodes: [art] });
check(shot.images.length === 1 && pngSize(shot.images[0]).width === 390 && pngSize(shot.images[0]).height === 844, "the screenshot is the artboard's size");
writeFileSync(path.join(out, "welcome.png"), shot.images[0]);
const close = await call("board_screenshot", { board, nodes: [card], scale: 2 });
check(close.images.length === 1 && pngSize(close.images[0]).width === 640, "a layer is cut out of its artboard (its 320 px at 2×)");
const exp = await call("board_export", { board, scale: 1 });
check(exp.json.files.length === 7 && exp.json.files.every((f: string) => readFileSync(f).length > 100), "every artboard exports");
const list = await call("board_list", {});
check(list.json.find((x: any) => x.id === board).working.length >= 1, "the artboards being worked on are listed");
await call("board_done", { board });
check((await call("board_list", {})).json.find((x: any) => x.id === board).working.length === 0, "board_done clears them");

// Videos: an agent writes <video>; it's copied into the library with its first frame as its still.
{
  const { execFileSync } = await import("node:child_process");
  const clip = path.join(out, "clip.mp4");
  execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=15", "-t", "2", "-c:v", "libx264", "-pix_fmt", "yuv420p", clip]);
  const made = await call("board_write_html", { board, html: `<video data-name="Clip" src="${clip}" autoplay loop muted style="width:320px;height:180px;border-radius:10px"></video>` });
  const vid = made.json.created[0].id;
  const nb = (await import("../src/board/store.js")).getBoard(board);
  const v = nb.nodes[vid];
  const { existsSync } = await import("node:fs");
  check(v.type === "video" && existsSync(v.src!) && v.src!.endsWith(".mp4") && Boolean(v.poster?.endsWith(".still.jpg")) && existsSync(v.poster!), "a video an agent writes gets its first frame as its still");
  const tree = await call("board_read", { board, node: vid, what: "tree" });
  check(/video "Clip" .*autoplay loop no sound/.test(tree.text), "board_read says it's a video, and how it plays");
  const pic = await call("board_screenshot", { board, nodes: [vid] });
  check(pic.images.length === 1, "board_screenshot draws it (as its still)");
  const clip2 = path.join(mkdtempSync(path.join(tmpdir(), "board-clip-")), "clip2.mp4");
  execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=320x180:rate=15", "-t", "1", "-c:v", "libx264", "-pix_fmt", "yuv420p", clip2]);
  await call("board_edit", { board, changes: [{ do: "image", id: vid, src: clip2 }] });
  const v2 = (await import("../src/board/store.js")).getBoard(board).nodes[vid];
  check(v2.src !== v.src && v2.src!.startsWith(out) && v2.poster !== v.poster && existsSync(v2.poster!), "board_edit image swaps a video layer's video (copied into the library from outside it), and its still");
  await call("board_edit", { board, changes: [{ do: "delete", ids: [vid] }] });
}

// The scratchpad: one board that's always there, a new page for each try.
{
  check((await call("board_list", {})).json[0].id === "scratchpad", "board_list has the scratchpad, first");
  const one = await call("board_create", { name: "Try buttons", scratchpad: true });
  const two = await call("board_create", { name: "Try cards", scratchpad: true });
  check(one.json.id === "scratchpad" && one.json.page.name === "Try buttons" && two.json.page.name === "Try cards" && two.json.page.id !== one.json.page.id, "board_create with scratchpad adds a page named for the try");
  const art = await call("board_write_html", { board: "my scratchpad", page: two.json.page.id, html: '<div style="width:300px;height:200px;background:#eee"></div>' });
  const sp = (await call("board_read", { board: "Scratchpad" })).json;
  check(sp.pages.length === 2 && sp.pages[0].name === "Try buttons" && sp.pages[1].artboards.length === 1 && sp.pages[0].artboards.length === 0 && art.json.created?.length === 1, "the first try takes its empty first page; an artboard lands on the try's page; \"my scratchpad\" finds it");
}

// Masks, by agents: written as HTML (data-mask), made, changed and removed with board_edit, read
// back, and drawn by the engine as the canvas draws them.
{
  const { decodePng, pixelAt } = await import("../src/util/png.js");
  const mk = await call("board_create", { name: "Masks" });
  const mbId = mk.json.id;
  const art = (await call("board_write_html", { board: mbId, html: `<div data-name="Masked" style="position:relative;width:300px;height:300px;background:#fff"></div>` })).json.created[0].id;
  const wrote = await call("board_write_html", { board: mbId, target: art, html: `<div data-name="Disc" data-mask style="position:absolute;left:50px;top:50px;width:200px;height:200px;border-radius:50%;background:#000"></div><div data-name="Fill" style="position:absolute;left:0;top:0;width:300px;height:300px;background:#ff0000"></div>` });
  const [disc, fill] = wrote.json.created.map((c: { id: string }) => c.id);
  check(/mask \(alpha\) of 1 layer above it/.test(wrote.json.outline) && new RegExp(`masked by #${disc}`).test(wrote.json.outline), "an agent writes a mask with data-mask, and the outline says what it masks");
  const red = (p: number[]) => p[0] > 200 && p[1] < 60 && p[2] < 60;
  const white = (p: number[]) => p[0] > 230 && p[1] > 230 && p[2] > 230;
  const look = async () => {
    const shot = await call("board_screenshot", { board: mbId, nodes: [art], scale: 1 });
    const f = decodePng(shot.images[0]);
    return { centre: pixelAt(f, 150, 150), corner: pixelAt(f, 12, 12), edge: pixelAt(f, 150, 46) };
  };
  let seen = await look();
  check(red(seen.centre) && white(seen.corner) && white(seen.edge), `board_screenshot draws the mask: the disc shows the fill, the rest is clipped (${seen.centre.join()} / ${seen.corner.join()})`);
  const html = await call("board_read", { board: mbId, node: art, what: "html" });
  check(/data-mask="alpha"/.test(html.text) && /data-mask-scope="/.test(html.text) && /mask-image/.test(html.text), "board_read html shows the mask and the element that masks");
  await call("board_edit", { board: mbId, changes: [{ do: "mask", ids: [disc], type: "luminance" }] });
  seen = await look();
  check(white(seen.centre), "board_edit mask changes its type: a black luminance mask shows nothing");
  await call("board_edit", { board: mbId, changes: [{ do: "mask", ids: [disc], remove: true }] });
  seen = await look();
  check(red(seen.corner), "board_edit mask with remove: what it hid shows again");
  const grouped = await call("board_edit", { board: mbId, changes: [{ do: "mask", ids: [fill, disc], type: "alpha" }] });
  const group = grouped.json.results[0].group;
  const tree = await call("board_read", { board: mbId, node: art, what: "tree" });
  check(grouped.json.results[0].mask === disc && /frame "Mask group"/.test(tree.text) && tree.text.indexOf(`#${group}`) >= 0 && /mask \(alpha\)/.test(tree.text), "board_edit mask with several layers makes a mask group, the one at the back the mask");
  seen = await look();
  check(red(seen.centre) && white(seen.corner), "and the mask group draws masked");
  await call("board_edit", { board: mbId, changes: [{ do: "mask", ids: [art] }] }, true);
  // A picture's clear parts mask too, its file loaded by the engine's browser.
  const { encodePng } = await import("../src/util/png.js");
  const halfPng = path.join(out, "half-clear.png");
  const px = Buffer.alloc(40 * 40 * 4);
  for (let i = 0; i < 40 * 40; i++) px.set([0, 0, 0, i % 40 < 20 ? 255 : 0], i * 4);
  writeFileSync(halfPng, encodePng({ width: 40, height: 40, rgba: px }));
  const picArt = (await call("board_write_html", { board: mbId, html: `<div data-name="Picture mask" style="position:relative;width:200px;height:200px;background:#fff"><img data-mask src="${halfPng}" style="position:absolute;left:0;top:0;width:200px;height:200px"><div style="position:absolute;left:0;top:0;width:200px;height:200px;background:#ff0000"></div></div>` })).json.created[0].id;
  const picShot = decodePng((await call("board_screenshot", { board: mbId, nodes: [picArt], scale: 1 })).images[0]);
  check(red(pixelAt(picShot, 50, 100)) && white(pixelAt(picShot, 150, 100)), "a picture used as a mask hides what it masks under its clear half, in board_screenshot");
  const flex = (await call("board_write_html", { board: mbId, html: `<div data-name="Flexy" style="width:300px;height:300px;display:flex;flex-direction:column"></div>` })).json.created[0].id;
  const warned = await call("board_write_html", { board: mbId, target: flex, html: `<div data-mask style="width:100px;height:100px;background:#000"></div><div style="width:100px;height:100px;background:red"></div>` });
  check((warned.json.warnings ?? []).some((w: string) => /flex or grid layout/.test(w)), "a mask an agent leaves in a flex layout's flow comes with a warning of what to do");
}

// Luminance masks (a gradient and a photo), a mask over a group that has a mask of its own, and a
// vector's own picture, written by an agent and drawn by the engine. scripts/ui-test.ts checks the
// same on the canvas and in Preview, in both engines.
{
  const { decodePng, encodePng, pixelAt } = await import("../src/util/png.js");
  const store = await import("../src/board/store.js");
  // Pictures from outside the library, as an agent's would be.
  const elsewhere = mkdtempSync(path.join(tmpdir(), "board-test-pics-"));
  const picture = (name: string, w: number, h: number, at: (x: number) => number[]) => {
    const px = Buffer.alloc(w * h * 4);
    for (let i = 0; i < w * h; i++) px.set([...at(i % w), 255], i * 4);
    writeFileSync(path.join(elsewhere, name), encodePng({ width: w, height: h, rgba: px }));
    return path.join(elsewhere, name);
  };
  const photo = picture("photo.png", 120, 96, () => [255, 0, 0]);
  const bright = picture("half-bright.png", 60, 48, (x) => (x < 30 ? [255, 255, 255] : [0, 0, 0]));
  const star = `<svg data-name="Star" data-mask="vector" style="position:absolute;left:0;top:0;width:240px;height:240px" viewBox="0 0 240 240"><polygon points="120,0 150,90 240,90 165,145 195,240 120,180 45,240 75,145 0,90 90,90" fill="#000"/></svg>`;
  const mk = await call("board_create", { name: "More masks" });
  const id = mk.json.id;
  const wrote = await call("board_write_html", {
    board: id,
    html:
      `<div data-name="Kinds" style="position:relative;width:1120px;height:240px;background:#fff">` +
      `<div data-name="Fade" style="position:absolute;left:0;top:0;width:300px;height:240px"><div data-mask="luminance" style="position:absolute;left:0;top:0;width:300px;height:240px;background:linear-gradient(90deg,#fff,#000)"></div><img src="${photo}" style="position:absolute;left:0;top:0;width:300px;height:240px;object-fit:cover"></div>` +
      `<div data-name="Bright" style="position:absolute;left:310px;top:0;width:300px;height:240px"><img data-mask="luminance" src="${bright}" style="position:absolute;left:0;top:0;width:300px;height:240px;object-fit:cover"><img src="${photo}" style="position:absolute;left:0;top:0;width:300px;height:240px;object-fit:cover"></div>` +
      `<div data-name="Nested" style="position:absolute;left:620px;top:0;width:240px;height:240px"><div data-mask style="position:absolute;left:20px;top:20px;width:200px;height:200px;border-radius:50%;background:#000"></div><div data-name="Group" style="position:absolute;left:0;top:0;width:240px;height:240px">${star}<img src="${photo}" style="position:absolute;left:0;top:0;width:240px;height:240px;object-fit:cover"></div></div>` +
      `<svg data-name="Framed" style="position:absolute;left:880px;top:0;width:240px;height:240px" viewBox="0 0 240 240"><image href="${photo}" x="0" y="0" width="240" height="240" preserveAspectRatio="none"/></svg>` +
      `</div>`,
  });
  const art = wrote.json.created[0].id;
  const b = store.getBoard(id);
  const href = Object.values(b.nodes).find((n) => n.tag === "image")?.attrs?.href ?? "";
  check(href.startsWith(path.resolve(out)) && href !== photo, `board_write_html copies a vector's picture into the library, as it does an <img>'s (${href})`);
  const into = await call("board_write_html", { board: id, target: Object.values(b.nodes).find((n) => n.name === "Framed")!.id, html: `<image href="${bright}" width="10" height="10"/><image href="${path.join(elsewhere, "missing.png")}" width="10" height="10"/>` });
  const added = into.json.created.map((c: { id: string }) => store.getBoard(id).nodes[c.id].attrs?.href ?? "");
  check(added[0].startsWith(path.resolve(out)) && /no picture at .*missing\.png/.test((into.json.warnings ?? []).join()), "SVG written into a vector has its pictures copied in too, and a missing one is said");
  await call("board_edit", { board: id, changes: [{ do: "delete", ids: into.json.created.map((c: { id: string }) => c.id) }] });
  const shot = decodePng((await call("board_screenshot", { board: id, nodes: [art], scale: 1 })).images[0]);
  const g = (x: number, y: number) => pixelAt(shot, x, y)[1];
  const red = (x: number, y: number) => pixelAt(shot, x, y)[0] > 200 && g(x, y) < 60;
  const white = (x: number, y: number) => pixelAt(shot, x, y)[0] > 230 && g(x, y) > 230;
  check(red(10, 120) && g(150, 120) > 90 && g(150, 120) < 170 && white(290, 120), `a luminance gradient fades the photo out from left to right (${[10, 150, 290].map((x) => pixelAt(shot, x, 120).slice(0, 3).join(",")).join(" / ")})`);
  check(red(310 + 60, 120) && white(310 + 240, 120), "a photo used as a luminance mask shows the photo over it where it's bright, and nothing where it's dark");
  check(red(620 + 120, 120) && white(620 + 60, 60) && white(620 + 225, 94) && white(620 + 68, 214), "a mask over a group clips the group's own masked layers: the star, its points cut off by the circle");
  check(red(880 + 120, 120), "a vector's picture draws in exports");
}

// ---------------------------------------------------------------------------------------------
// Comments: who worked on a board, and comments that reach them through (a stand-in for) Agentman

{
  const store = await import("../src/board/store.js");
  let kept = "";
  try {
    store.deleteBoard("scratchpad");
  } catch (e) {
    kept = (e as Error).message;
  }
  check(/always there/.test(kept), "the scratchpad can't be deleted (its pages can)");

  // A board whose file is damaged is listed as that (not dropped), can't be opened, and can be deleted.
  const { readdirSync, existsSync, utimesSync } = await import("node:fs");
  const broken = store.createBoard("Broken", "studio");
  writeFileSync(store.boardFile(broken.id), '{"pages": [');
  const row = store.listBoards().find((x) => x.id === broken.id);
  let unreadable = "";
  try {
    store.getBoard(broken.id);
  } catch (e) {
    unreadable = (e as Error).message;
  }
  check(row?.damaged === true && /damaged/.test(unreadable), "a damaged board is listed as damaged, and opening it says why");
  store.deleteBoard(broken.id);
  check(!existsSync(store.boardFile(broken.id)), "a damaged board can be deleted");
  // A damaged scratchpad is kept aside and a fresh one made, never written over.
  const spFile = store.boardFile("scratchpad");
  const spText = readFileSync(spFile, "utf8");
  writeFileSync(spFile, "not json");
  const fresh = store.scratchpad();
  const aside = readdirSync(path.dirname(spFile)).filter((f) => f.startsWith("scratchpad.json.damaged-"));
  check(fresh.pages.length === 1 && aside.length === 1 && readFileSync(path.join(path.dirname(spFile), aside[0]), "utf8") === "not json", "a damaged scratchpad is kept aside and a new one takes its place");
  writeFileSync(spFile, spText);
  // Locks: one left by a process that's gone is cleared at once; a live one isn't taken, however old.
  const lockBoard = store.createBoard("Locks", "studio");
  const lock = `${store.boardFile(lockBoard.id)}.lock`;
  mkdirSync(lock);
  writeFileSync(path.join(lock, "owner"), "999999:dead");
  const t0 = Date.now();
  store.changeBoard(lockBoard.id, [{ op: "rename", name: "Locks 2" }], "studio");
  check(Date.now() - t0 < 1000 && !existsSync(lock), "a lock left by a process that's gone is cleared");
  mkdirSync(lock);
  writeFileSync(path.join(lock, "owner"), `${process.pid}:other`);
  utimesSync(lock, new Date(Date.now() - 20_000), new Date(Date.now() - 20_000));
  let busy = "";
  try {
    store.changeBoard(lockBoard.id, [{ op: "rename", name: "Locks 3" }], "studio");
  } catch (e) {
    busy = (e as Error).message;
  }
  check(/busy/.test(busy) && readFileSync(path.join(lock, "owner"), "utf8").endsWith(":other"), "a slow change by a live process keeps its lock");
  rmSync(lock, { recursive: true, force: true });
  store.deleteBoard(lockBoard.id);

  // An SVG's <style> is written onto its parts: two exports using the same class names don't colour each other.
  const svgIn = (fill: string) => `<svg viewBox="0 0 10 10" width="40" height="40"><style>.cls-1{fill:${fill}}</style><rect class="cls-1" width="10" height="10"/></svg>`;
  const two = htmlToNodes(`<div>${svgIn("#ff0000")}${svgIn("#00ff00")}</div>`);
  const rects = Object.values(two.nodes).filter((n) => n.tag === "rect").map((n) => n.style.fill);
  const whole = htmlToNodes(svgIn("#0000ff"), { wholeSvg: true });
  const svgText = Object.values(whole.nodes)[0].svg ?? "";
  check(rects.join() === "#ff0000,#00ff00" && !Object.values(two.nodes).some((n) => /<style/.test(n.defs ?? "")) && !/<style/.test(svgText) && /style="fill:#0000ff"/.test(svgText), "an SVG's <style> rules are written onto its parts, not left to style the whole page");
  const talk = await import("../src/board/comments.js");
  const b0 = store.getBoard(board);
  const agent = b0.agents?.[AGENT];
  check(agent?.session === AGENT && agent.how === "process" && agent.name === "Design agent" && agent.artboards.includes(art), "an agent's changes record it on the board: its Agentman session (from its own process), the name Agentman shows and its artboards");
  check(b0.rev === store.getBoard(board).rev, "recording it doesn't count as a change to the design");
  const titleId = b0.nodes[art].children![0];

  // The person comments on a layer, as the Studio does: it's saved, then sent.
  const first = talk.startThread(board, { layer: titleId, at: { x: 0.9, y: 0.1 } }, { text: "Make the title bigger\nand bolder.", by: "person" });
  const cid = first.thread.id;
  check(first.message.to?.join() === AGENT && first.message.delivery?.[AGENT].status === "sending", "a comment goes to the agent that worked on its artboard, marked as being sent");
  await talk.deliver(board, cid, first.message.id);
  const sent = fake.sent[fake.sent.length - 1];
  check(sent?.sessionId === AGENT && sent.text.startsWith("(From Screenshotter)") && sent.text.includes(`"${b0.name}" (id ${board})`) && sent.text.includes(`comment ${cid}`), "it reaches the agent through Agentman, from Screenshotter, with the board and the comment");
  check(sent.text.includes(`#${titleId}`) && sent.text.includes(`#${art}`) && sent.text.includes("> Make the title bigger\n> and bolder.") && /board_comment \{ board: "[a-z0-9]+", comment: "[a-z0-9]+", reply/.test(sent.text), "with the layer it's on (names and ids), the words, and how to answer");
  check(!/resolve: true/.test(sent.text) && /The user resolves the comment/.test(sent.text), "and that the user, not the agent, resolves it");
  check(fake.badFrames.length === 0 && fake.requests.some((r) => r.type === "list_sessions"), "every request is one v2 envelope a line, addressed to the daemon (the stand-in's other events are skipped)");
  check(talk.getComments(board).threads[0].messages[0].delivery?.[AGENT].status === "delivered", "the comment says it was delivered");

  // The agent answers through the MCP.
  const mine = await call("board_comments", {});
  const listed = mine.json?.[0]?.threads?.[0];
  check(listed?.comment === cid && listed.waitingOnYou === true && listed.anchor.layer === titleId && listed.messages[0].from === "user", "board_comments lists it for the agent, waiting on it");
  await call("board_comment", { board, comment: cid, reply: "Done: 40px, weight 700.", resolve: true });
  const t1 = talk.getComments(board).threads.find((t) => t.id === cid)!;
  check(t1.messages[1]?.by === AGENT && t1.messages[1].name === "Design agent" && t1.messages[1].text === "Done: 40px, weight 700." && !t1.resolved, "board_comment replies in the thread; an agent can't resolve it");
  await call("board_comment", { board, comment: cid }, true);
  talk.setResolved(board, cid, true, "person");
  check((await call("board_comments", {})).text.includes("No open comments"), "a resolved comment no longer waits on anyone");
  await call("board_comment", { board, comment: "nope" + cid, reply: "?" }, true);
  const own = await call("board_comment", { board, on: art, reply: "Should the list scroll under the header?" });
  check(Boolean(own.json?.comment) && talk.getComments(board).threads.some((t) => t.id === own.json.comment && t.anchor.layer === art && t.messages[0].by === AGENT), "an agent can start a thread on a layer");

  // The person tags an agent that hasn't worked here, from Agentman's list: it joins the board.
  const now0 = await talk.agentsNow(board);
  check(now0.agentman && now0.states[AGENT] === "idle" && now0.others.some((o) => o.key === "claude:someone-else" && o.name === "Another agent" && o.folder === "elsewhere"), "the Studio sees what the board's agents are doing, and Agentman's other agents to tag");
  await talk.bringIn(board, ["claude:someone-else", "claude:not-running"]);
  const joined = store.getBoard(board).agents ?? {};
  check(joined["claude:someone-else"]?.session === "claude:someone-else" && joined["claude:someone-else"].name === "Another agent" && !joined["claude:not-running"], "a tagged agent from Agentman joins the board (one Agentman doesn't run doesn't)");
  check(!(await talk.agentsNow(board)).others.some((o) => o.key === "claude:someone-else"), "and is no longer listed as another agent");

  // The person replies; the agent is waiting on a question in Agentman, so it can't take it yet.
  fake.sessions[0].question = { id: "q1" };
  const second = talk.reply(board, cid, { text: "Bigger still", by: "person" });
  check(!second.thread.resolved && second.message.to?.join() === AGENT, "a reply opens a resolved comment again and goes to who was in the thread");

  // Two agents tagged: one answering doesn't end the wait on the other.
  const both = talk.startThread(board, { layer: titleId }, { text: "Both of you, look at this", by: "person", to: [AGENT, "claude:someone-else"] });
  talk.reply(board, both.thread.id, { text: "Looked.", by: "claude:someone-else", name: "Another agent" });
  const tb = talk.getComments(board).threads.find((t) => t.id === both.thread.id)!;
  check(talk.threadForAgent(store.getBoard(board), tb, new Set([AGENT])).waitingOnYou === true && talk.threadForAgent(store.getBoard(board), tb, new Set(["claude:someone-else"])).waitingOnYou === false, "with two agents tagged, one answering doesn't end the wait on the other");

  // The Studio works out how a component change reaches its copies before it sends it; a copy an agent
  // placed meanwhile still gets the change, and copies keep their own.
  {
    const made = addHtmlOps(`<div data-name="Chip" style="display:flex;padding:6px 10px;background:#eeeeee"><span style="color:#111111">New</span></div>`, art);
    store.changeBoard(board, made.ops, "agent");
    const chip = made.roots[0];
    store.changeBoard(board, componentOps(store.getBoard(board), chip), "agent");
    const place = () => {
      const t = instanceTree(store.getBoard(board), chip, art);
      store.changeBoard(board, [{ op: "add", nodes: t.nodes, ids: [t.id], parent: art }], "agent");
      return t.id;
    };
    const firstCopy = place();
    store.changeBoard(board, [{ op: "set", id: firstCopy, style: { background: "#000000" } }], "agent");
    const studioSaw = store.getBoard(board);
    const studioOps = expandOps(studioSaw, [{ op: "set", id: chip, style: { background: "#ffd93d", borderRadius: "999px" } }]);
    const late = place();
    const saved = store.changeBoard(board, studioOps, "studio", studioSaw.rev, { expand: false, reconcile: true });
    const now = store.getBoard(board);
    check(now.nodes[late].style.background === "#ffd93d" && now.nodes[late].style.borderRadius === "999px" && saved.repaired === true && saved.stale, "a copy an agent placed while the Studio's change to its component was on its way still gets the change");
    check(now.nodes[firstCopy].style.background === "#000000" && now.nodes[firstCopy].style.borderRadius === "999px", "and a copy's own changes are kept");
  }
  await talk.deliver(board, cid, second.message.id);
  const refused = talk.getComments(board).threads.find((t) => t.id === cid)!.messages[2].delivery?.[AGENT];
  check(refused?.status === "failed" && /question/.test(refused.error ?? ""), "when Agentman can't hand it over, the comment says why");
  fake.sessions[0].question = undefined;
  talk.markSending(board, cid, second.message.id, [AGENT]);
  await talk.deliver(board, cid, second.message.id, [AGENT]);
  check(talk.getComments(board).threads.find((t) => t.id === cid)!.messages[2].delivery?.[AGENT].status === "delivered" && fake.sent[fake.sent.length - 1].text.includes("The thread before this:\n- The user: Make the title bigger and bolder.\n- You: Done: 40px"), "trying again delivers it, with the thread so far");

  // A region, and an agent Agentman doesn't know.
  const region = talk.startThread(board, { artboard: art, rect: { x: 10, y: 20, width: 300, height: 120 }, layers: [titleId, "not-a-layer"] }, { text: "Too much space here", by: "person", to: [] });
  check(!region.message.to && region.thread.anchor.layers?.join() === titleId && talk.describeAnchor(store.getBoard(board), region.thread.anchor).includes("x 10, y 20, 300×120"), "a region keeps its rect in the artboard's terms and the layers inside it; with no one to tell, it's a note");
  store.changeBoard(board, [{ op: "agent", agent: { key: "local:codex:/nowhere", kind: "codex", name: "Codex in nowhere", cwd: "/nowhere" }, artboards: [art], at: new Date().toISOString() }], "agent");
  const lost = talk.reply(board, region.thread.id, { text: "Codex, take this one", by: "person", to: ["local:codex:/nowhere"] });
  await talk.deliver(board, region.thread.id, lost.message.id);
  const why = talk.getComments(board).threads.find((t) => t.id === region.thread.id)!.messages[1].delivery?.["local:codex:/nowhere"];
  check(why?.status === "failed" && /doesn't list an agent in nowhere/.test(why.error ?? ""), "an agent with no session Agentman knows: the comment is kept and says so");

  // Agentman isn't running.
  process.env.SCREENSHOTTER_AGENTMAN_SOCKET = path.join(out, "no-agentman.sock");
  const offline = talk.reply(board, cid, { text: "Hello?", by: "person" });
  await talk.deliver(board, cid, offline.message.id);
  const down = talk.getComments(board).threads.find((t) => t.id === cid)!.messages.find((m) => m.id === offline.message.id)!;
  check(down.text === "Hello?" && down.delivery?.[AGENT].status === "failed" && down.delivery[AGENT].error === "Agentman isn't running", "with Agentman not running, the comment is still saved, and says so");
  process.env.SCREENSHOTTER_AGENTMAN_SOCKET = socket;

  // Comments aren't the design: changing (and undoing) the board leaves them be.
  const before = talk.getComments(board).rev;
  const threadCount = talk.getComments(board).threads.length;
  const ch = store.changeBoard(board, [{ op: "set", id: titleId, name: "Headline" }], "studio");
  store.changeBoard(board, ch.inverse, "studio");
  check(talk.getComments(board).rev === before && talk.getComments(board).threads.length === threadCount, "changing and undoing the design leaves the comments as they were");
  talk.remove(board, region.thread.id);
  check(talk.getComments(board).threads.length === threadCount - 1, "deleting a comment deletes its thread");
  check(fake.sent.every((s) => s.sessionId === AGENT), "nothing went to an agent no one named");

  // Sending several at once: comments wait on the board (pending) until the person sends them, then
  // each agent gets one message with all of its, not one per comment while it works on the last.
  {
    const msgOf = (id: string) => talk.getComments(board).threads.flatMap((t) => t.messages).find((m) => m.id === id)!;
    const sentBefore = fake.sent.length;
    const p1 = talk.startThread(board, { layer: titleId }, { text: "Tighten the title", by: "person", to: [], pending: true });
    const p2 = talk.startThread(board, { artboard: art, rect: { x: 0, y: 0, width: 100, height: 50 } }, { text: "Less space up here", by: "person", pending: true });
    const p3 = talk.reply(board, cid, { text: "And make it navy", by: "person", pending: true });
    check(p1.message.pending === true && !p1.message.delivery && !p2.message.to && p3.message.pending === true && fake.sent.length === sentBefore, "a pending comment is kept on the board and sent to no one yet");
    check(talk.pendingOf(talk.getComments(board)).map((x) => x.message.id).join() === [p1.message.id, p2.message.id, p3.message.id].join(), "the pending comments are listed in the order they were written");
    const seen = await call("board_comments", { all: true });
    check(!seen.text.includes("Tighten the title") && !seen.text.includes("And make it navy") && seen.text.includes("Make the title bigger"), "agents don't see what the person hasn't sent");
    // The agent answers the thread while the reply waits; the person changes a pending comment.
    talk.reply(board, cid, { text: "Bolder now.", by: AGENT, name: "Design agent" });
    talk.editPending(board, p1.thread.id, p1.message.id, "Tighten the title's letter spacing");
    let sentAlready = "";
    try {
      talk.editPending(board, cid, first.message.id, "Changed");
    } catch (e) {
      sentAlready = (e as Error).message;
    }
    check(msgOf(p1.message.id).text === "Tighten the title's letter spacing" && /has been sent/.test(sentAlready), "a pending comment can be changed; a sent one can't");
    const r = talk.sendPending(board, [AGENT]);
    await talk.deliverBatch(board, r.batch);
    const out1 = fake.sent.slice(sentBefore);
    check(r.count === 3 && out1.length === 1 && out1[0].sessionId === AGENT, "sending them is one message to the agent, with all three");
    const said = out1[0]?.text ?? "";
    check(
      said.startsWith("(From Screenshotter)") && said.includes("sent you 3 comments at once") && said.includes(`\n1. Comment ${p1.thread.id}, on the text`) && said.includes(`\n3. A reply on comment ${cid}`) && said.includes("> Tighten the title's letter spacing") && said.includes("- You: Bolder now.") && said.includes("x 0, y 0, 100×50"),
      "it's a numbered list: each comment with where it is, and a reply with the thread before it",
    );
    check(/board_comment \{ board: "[a-z0-9]+", replies: \[\{ comment: "[a-z0-9]+", reply: "…" \}/.test(said), "and it says how to answer them all in one call");
    const thread = talk.getComments(board).threads.find((t) => t.id === cid)!;
    const last = thread.messages[thread.messages.length - 1];
    check(last.id === p3.message.id && !last.pending && last.batch === r.batch && last.to?.join() === AGENT && last.delivery?.[AGENT].status === "delivered", "a reply that waited goes out after what was said meanwhile, marked delivered");
    check(talk.pendingOf(talk.getComments(board)).length === 0 && msgOf(p2.message.id).delivery?.[AGENT].status === "delivered", "nothing is left waiting, and each comment says it was delivered");
    const answered = await call("board_comment", { board, replies: [{ comment: p1.thread.id, reply: "Tightened to -0.02em." }, { comment: p2.thread.id, reply: "Halved the padding." }, { comment: "nope", reply: "?" }] });
    const t1 = talk.getComments(board).threads.find((t) => t.id === p1.thread.id)!;
    check(answered.json?.answered?.length === 2 && answered.json.failed?.[0]?.comment === "nope" && t1.messages[1]?.by === AGENT && t1.messages[1].text === "Tightened to -0.02em.", "board_comment's replies answers several comments in one call, and says which it couldn't");

    // A comment that tags an agent goes to it; the rest go to who the person picked.
    let nothing = "";
    try {
      talk.sendPending(board, [AGENT]);
    } catch (e) {
      nothing = (e as Error).message;
    }
    const lonely = talk.startThread(board, { layer: titleId }, { text: "Who gets this?", by: "person", pending: true });
    let noOne = "";
    try {
      talk.sendPending(board, []);
    } catch (e) {
      noOne = (e as Error).message;
    }
    check(/nothing waiting/.test(nothing) && /Pick the agents/.test(noOne) && msgOf(lonely.message.id).pending === true, "with nothing waiting, or no one to send to, nothing is sent and the comments stay");
    talk.remove(board, lonely.thread.id);

    // Agentman isn't running: the whole send says so, and trying again sends it as one message.
    process.env.SCREENSHOTTER_AGENTMAN_SOCKET = path.join(out, "no-agentman.sock");
    const q1 = talk.reply(board, p1.thread.id, { text: "Also lighter", by: "person", pending: true });
    const q2 = talk.reply(board, p2.thread.id, { text: "Even less", by: "person", pending: true });
    const r2 = talk.sendPending(board, [AGENT]);
    await talk.deliverBatch(board, r2.batch);
    const bothFailed = [q1, q2].every((q) => msgOf(q.message.id).delivery?.[AGENT].status === "failed");
    process.env.SCREENSHOTTER_AGENTMAN_SOCKET = socket;
    const n0 = fake.sent.length;
    const again = talk.markBatchSending(board, r2.batch, [AGENT]);
    await talk.deliverBatch(board, r2.batch, { agents: [AGENT], messages: again });
    const retried = fake.sent.slice(n0);
    check(
      bothFailed && again.length === 2 && retried.length === 1 && retried[0].text.includes("> Also lighter") && retried[0].text.includes("> Even less") && [q1, q2].every((q) => msgOf(q.message.id).delivery?.[AGENT].status === "delivered"),
      "a send that didn't reach the agent goes again as one message, and both comments say delivered",
    );
  }
}
await fake.close();

// ---------------------------------------------------------------------------------------------
// Fixes from the 0.14 review: copies of components in the wrong place, components that go with
// their artboard, batches that scale, replaced artboards, and pictures CSS points at.
{
  const store = await import("../src/board/store.js");
  const nb = await call("board_create", { name: "Review fixes" });
  const rb = nb.json.id;
  const cards = await call("board_write_html", { board: rb, html: `<div data-name="Parts" style="width:400px;height:300px;background:#fff;position:relative"><div data-name="Card" style="width:200px;height:120px;background:#eee;display:flex"><p style="margin:0">Card</p></div></div>` });
  const partsArt = cards.json.created[0].id;
  const cardId = Object.values(store.getBoard(rb).nodes).find((n) => n.name === "Card")!.id;
  const elsewhere = await call("board_write_html", { board: rb, html: `<div data-name="Screen" style="width:400px;height:600px;background:#fafafa"></div>` });
  const screenArt = elsewhere.json.created[0].id;
  const placed = await call("board_edit", { board: rb, changes: [{ do: "component", id: cardId }, { do: "copy", of: cardId, into: screenArt }] });
  const copy = placed.json.results[1].copy;
  const layers = Object.keys(store.getBoard(rb).nodes).length;
  await call("board_edit", { board: rb, changes: [{ do: "copy", of: cardId, into: cardId }] }, true);
  await call("board_edit", { board: rb, changes: [{ do: "move", id: copy, into: cardId }] }, true);
  check(Object.keys(store.getBoard(rb).nodes).length === layers, "a copy of a component can't go inside that component (it would hold a copy of itself)");
  // Deleting the artboard that holds the component: its copy becomes ordinary layers, not stuck.
  await call("board_edit", { board: rb, changes: [{ do: "delete", ids: [partsArt] }] });
  const after = store.getBoard(rb);
  check(after.nodes[copy] && !after.nodes[copy].instanceOf && !Object.values(after.nodes).some((n) => n.master), "deleting the artboard that holds a component leaves its copies as ordinary layers");
  await call("board_write_html", { board: rb, target: copy, html: "<p>Now it can hold this</p>" });
  // A change that adds layers, then a scale, in one batch.
  const both = await call("board_edit", { board: rb, changes: [{ do: "artboard", name: "Extra", width: 200, height: 200 }, { do: "scale", ids: [screenArt], by: 0.5 }] });
  check(both.json?.results?.[1]?.scaled === 1 && store.getBoard(rb).nodes[screenArt].style.width === "200px", "a scale after a change that adds layers, in the same batch, works");
  // Replacing an artboard keeps it where it was.
  const at = { left: store.getBoard(rb).nodes[screenArt].style.left, top: store.getBoard(rb).nodes[screenArt].style.top };
  const replaced = await call("board_write_html", { board: rb, target: screenArt, position: "replace", html: `<div data-name="Screen 2" style="width:300px;height:500px;background:#000"></div>` });
  const nn = store.getBoard(rb).nodes[replaced.json.created[0].id];
  check(nn.style.left === at.left && nn.style.top === at.top, "an artboard replaced through board_write_html keeps its place");
  // A picture CSS points at, from outside the library, is copied in like an image layer's.
  const outside = path.join(mkdtempSync(path.join(tmpdir(), "outside-")), "pic.png");
  writeFileSync(outside, readFileSync(path.join(out, "welcome.png")));
  const bg = await call("board_write_html", { board: rb, html: `<div data-name="Backdrop" style="width:300px;height:300px;background-image:url(${outside})"></div>` });
  const bgStyle = store.getBoard(rb).nodes[bg.json.created[0].id].style.backgroundImage ?? "";
  check(bgStyle.includes(path.join(".studio", "boards", "assets")) && !bgStyle.includes(outside), "a CSS picture from outside the library is copied into it");
}
// ---------------------------------------------------------------------------------------------
// Grids through the tools: written with shorthands, stored as longhands, described, measured with
// their tracks as drawn, changed one side of a line at a time, and drawn as the CSS says.
{
  const store = await import("../src/board/store.js");
  const gb = (await call("board_create", { name: "Grid tools" })).json.id;
  const w = await call("board_write_html", {
    board: gb,
    html: `<div data-name="Gallery" style="display:grid;grid-template:auto / repeat(3, 1fr);gap:16px;padding:20px;width:600px;background:#fff"><div data-name="Banner" style="grid-area:1 / 1 / 2 / -1;height:60px;background:#111"></div><div data-name="A" style="height:100px;background:#e33"></div><div data-name="B" style="height:100px;background:#3a3"></div><div data-name="C" style="height:100px;background:#33e"></div><div data-name="D" style="grid-column:2 / span 2;height:100px;background:#999"></div></div>`,
  });
  const art = w.json.created[0].id;
  const by = (name: string) => Object.values(store.getBoard(gb).nodes).find((n) => n.name === name)!;
  const gs = store.getBoard(gb).nodes[art].style;
  check(gs.display === "grid" && gs.gridTemplateColumns === "repeat(3, 1fr)" && gs.gridTemplateRows === "auto" && !gs.gridTemplate && by("Banner").style.gridColumn === "1 / -1" && by("Banner").style.gridRow === "1", "board_write_html keeps a grid, its shorthands as longhands");
  check(/grid 3 columns × 1 row · columns repeat\(3, 1fr\) · rows auto · gap 16px/.test(w.json.outline) && /"D" #\w+ fill×100 .*cell column 2 \/ span 2/.test(w.json.outline), `the outline says the grid and each layer's cell:\n${w.json.outline}`);
  const m = await call("board_read", { board: gb, node: art, what: "tree", measure: true });
  const at = (name: string) => new RegExp(`"${name}" #\\w+ \\[([\\d.]+),([\\d.]+) ([\\d.]+)×([\\d.]+)`).exec(m.text)?.slice(1).map(Number) ?? [];
  // 600 wide, 20 padding: 560 inside, two 16px gaps, three 176px columns.
  check(/drawn columns 176 176 176 rows 60 100 100/.test(m.text), `measuring a grid says its tracks as drawn:\n${m.text}`);
  check(at("A").join() === "20,96,176,100" && at("C").join() === "404,96,176,100" && at("D").join() === "212,212,368,100" && at("Banner").join() === "20,20,560,60", `layers are drawn in their cells (${["A", "C", "D", "Banner"].map((n) => `${n} ${at(n).join(",")}`).join("; ")})`);
  await call("board_edit", { board: gb, changes: [{ do: "style", ids: [art], style: { grid: "auto-flow dense 120px / 1fr 2fr" } }, { do: "style", ids: [by("D").id], style: { "grid-column-start": 1 } }, { do: "style", ids: [by("A").id], style: { "place-self": "center", gridRow: 3 } }] });
  const g2 = store.getBoard(gb).nodes[art].style;
  check(g2.gridTemplateColumns === "1fr 2fr" && g2.gridAutoFlow === "row dense" && g2.gridAutoRows === "120px" && !g2.gridTemplateRows && !g2.grid, `board_edit's grid shorthand becomes longhands and resets what it covers (${JSON.stringify(g2)})`);
  check(by("D").style.gridColumn === "1 / span 2" && by("A").style.alignSelf === "center" && by("A").style.justifySelf === "center" && by("A").style.gridRow === "3", `one side of a line changes, keeping the span; place-self and a number line come in as CSS (${by("D").style.gridColumn}, ${by("A").style.gridRow})`);
  const shot = await call("board_screenshot", { board: gb, nodes: [art] });
  check(shot.images.length === 1 && pngSize(shot.images[0]).width >= 600, "a grid artboard draws");
  await call("board_edit", { board: gb, changes: [{ do: "scale", ids: [art], by: 2 }] });
  const g3 = store.getBoard(gb).nodes[art].style;
  check(g3.gap === "32px" && g3.padding === "40px" && g3.gridAutoRows === "240px" && g3.gridTemplateColumns === "1fr 2fr" && g3.width === "1200px", `scale doubles a grid's gaps, padding and px tracks (${JSON.stringify(g3)})`);
}
// A text mask at the very top of its frame (top: 0) gets a real height: a bare 0 inside calc() made
// the whole calc() invalid, so the mask showed nothing.
{
  const got = htmlToNodes(`<div style="position:relative;width:400px;height:120px"><span data-mask style="position:absolute;left:0;top:0;width:400px;font-size:100px;line-height:120px">KILN</span><div style="position:absolute;left:0;top:0;width:400px;height:120px;background:#f60"></div></div>`);
  const board: Board = { ...emptyBoard("m0", "Mask at 0", new Date().toISOString()), nodes: got.nodes };
  board.pages[0].children = got.roots;
  for (const id of got.roots) got.nodes[id].parent = null;
  const out = nodeHtml(board, got.roots[0], {});
  check(/data-mask-scope/.test(out) && !/calc\([^)]*- 0[;)\s]/.test(out) && /calc\(100% - 0px\)/.test(out), "a mask at the top of its frame writes a valid height (calc with 0px, not a bare 0)");
}

// Agents' cursors: each agent's latest move on a board (what it touched, what it was doing), from
// the tools it uses; a look leaves the artboards it wrote to as they were.
{
  const store = await import("../src/board/store.js");
  const made = await call("board_create", { name: "Presence" });
  const pid = made.json.id;
  await call("board_write_html", { board: pid, html: `<div data-name="Screen" style="width:390px;height:400px;background:#fff"><p data-name="Title" style="margin:0">Hi</p></div>` });
  let b = store.getBoard(pid);
  const screen = Object.values(b.nodes).find((n) => n.name === "Screen")!.id;
  const title = Object.values(b.nodes).find((n) => n.type === "text")!.id;
  const me = () => Object.values(store.getBoard(pid).agents ?? {}).find((a) => a.key === AGENT)?.last;
  check(me()?.doing === "write" && me()?.ids.includes(screen), "writing an artboard is the agent's last move, on that artboard");
  await call("board_edit", { board: pid, changes: [{ do: "style", ids: [title], style: { color: "#ff3b30" } }] });
  check(me()?.doing === "edit" && me()?.ids.join() === title, "changing a layer is its last move, on that layer");
  const wrote = store.getBoard(pid).agents?.[AGENT]?.artboards.join();
  await call("board_screenshot", { board: pid, nodes: [title] });
  b = store.getBoard(pid);
  check(me()?.doing === "look" && me()?.ids.join() === title && b.agents?.[AGENT]?.artboards.join() === wrote, "a screenshot is a look at that layer, and doesn't count as writing");
}

// A website brought onto a board: a page served here with the awkward parts in it, read at 1200
// wide, and checked layer by layer and against the page itself.
{
  const http = await import("node:http");
  const { existsSync, readdirSync } = await import("node:fs");
  const { encodePng } = await import("../src/util/png.js");
  const { importWebsite, privateHost, websiteUrl } = await import("../src/board/web-import.js");
  const { drawLayers } = await import("../src/board/render.js");
  const { newPage } = await import("../src/render/browser.js");
  const store = await import("../src/board/store.js");
  const supp = "/System/Library/Fonts/Supplemental";
  const fontFile = path.join(supp, readdirSync(supp).find((f) => /^Courier New\.ttf$|^Andale Mono\.ttf$/.test(f)) ?? readdirSync(supp).find((f) => f.endsWith(".ttf"))!);
  const rgba = Buffer.alloc(64 * 64 * 4);
  for (let i = 0; i < rgba.length; i += 4) rgba.set([42, 157, 143, 255], i);
  const png = encodePng({ width: 64, height: 64, rgba });
  // Somewhere else on this Mac that the page asks for: it must never be reached.
  let elsewhere = 0;
  const other = http.createServer((_q, r) => (elsewhere++, r.end("no")));
  await new Promise<void>((done) => other.listen(0, "127.0.0.1", done));
  const otherPort = (other.address() as import("node:net").AddressInfo).port;
  const page = `<!doctype html><html><head><title>Fixture shop</title><meta name="viewport" content="width=device-width, initial-scale=1"><style>
    @font-face { font-family: "Fixture Sans"; src: url(/font.ttf) format("truetype"); font-weight: 400; }
    body { margin: 0; font-family: "Fixture Sans", sans-serif; color: #222; background: #fafaf7; }
    .top { position: fixed; top: 0; left: 0; right: 0; height: 56px; background: #111; color: #fff; display: flex; align-items: center; padding: 0 24px; z-index: 5; }
    .skip { position: absolute; top: -100px; left: 0; }
    .hero { margin-top: 56px; min-height: 420px; display: flex; flex-direction: column; justify-content: center; padding: 0 48px; background: linear-gradient(135deg, #ffd6a5, #fdffb6); }
    .hero h1 { font-size: 48px; margin: 0; }
    .cards { display: grid; grid-template-columns: repeat(3, 1fr); gap: 20px; padding: 40px 48px; }
    .card { background: #fff; border-radius: 16px; box-shadow: 0 4px 20px rgba(0,0,0,.08); padding: 20px; }
    .card::before { content: "★"; color: #e76f51; }
    .pic { height: 140px; background: url(/pic.png) center / cover; border-radius: 10px; }
    .c { fill: #2a9d8f; }
    .hidden { display: none; }
    .sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
    .reveal { opacity: 0; transform: translateY(20px); font-size: 20px; padding: 0 48px; }
  </style></head><body>
    <a class="skip" href="#main">Skip to content</a>
    <header class="top"><span>Fixture</span></header>
    <section class="hero"><h1>Hello from the fixture</h1><p>Words <b>bold</b> and <a href="/about">a link</a>.</p></section>
    <div class="cards">
      <div class="card"><div class="pic"></div><h3>One</h3><img src="/pic.png" width="40" height="40" alt="Logo"></div>
      <div class="card"><h3>Two</h3><svg viewBox="0 0 10 10" width="24" height="24"><circle class="c" cx="5" cy="5" r="4"/></svg></div>
      <div class="card"><h3>Three</h3><canvas width="60" height="30"></canvas></div>
    </div>
    <p class="hidden">Never shown</p><span class="sr">Screen reader only</span><p class="reveal">Revealed later</p>
    <img src="http://127.0.0.1:${otherPort}/x.png" alt="Elsewhere" width="10" height="10">
    <script>const c = document.querySelector("canvas").getContext("2d"); c.fillStyle = "#e63946"; c.fillRect(0, 0, 60, 30);</script>
  </body></html>`;
  const site = http.createServer((q, r) => {
    if (q.url === "/pic.png") return r.writeHead(200, { "Content-Type": "image/png" }), r.end(png);
    if (q.url === "/font.ttf") return r.writeHead(200, { "Content-Type": "font/ttf" }), r.end(readFileSync(fontFile));
    r.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    r.end(page);
  });
  await new Promise<void>((done) => site.listen(0, "127.0.0.1", done));
  const siteUrl = `http://127.0.0.1:${(site.address() as import("node:net").AddressInfo).port}/`;

  check(websiteUrl("example.com/pricing").href === "https://example.com/pricing" && privateHost("192.168.1.4") && privateHost("localhost") && !privateHost("example.com"), "a typed address becomes https, and this Mac's network is told apart from the web");
  let refused = "";
  try {
    websiteUrl("file:///etc/passwd");
  } catch (e) {
    refused = (e as Error).message;
  }
  check(/Only web pages/.test(refused), "only web pages can be brought in, never files");

  const shop = store.createBoard("Shop", "studio");
  const steps: number[] = [];
  const r = await importWebsite(shop.id, { url: siteUrl, width: 1200 }, "studio", (f) => steps.push(f));
  const b = store.getBoard(r.board);
  const nodes = Object.values(b.nodes);
  const textOf = (t: string) => nodes.find((n) => n.type === "text" && plainOf(n.text).includes(t));
  const plainOf = (t?: string) => (t ?? "").replace(/<[^>]+>/g, "");
  const root = b.nodes[r.artboard];
  check(r.board === shop.id && root && !root.parent && root.style.width === "1200px" && root.name === "Fixture shop" && steps.at(-1) === 1, "a website lands on the board as one artboard, as wide as it was read and named after the page");
  check(textOf("Hello from the fixture")?.style.fontSize === "48px", "its words come in as text layers with their type");
  const grid = nodes.find((n) => n.style.display === "grid");
  check(Boolean(grid) && grid!.style.columnGap === "20px" && nodes.filter((n) => n.parent === grid!.id).length === 3, "its layout comes too: the cards' grid, its gap and its three cards");
  check(Boolean(textOf("★")), "a ::before with words in it becomes a layer");
  const header = nodes.find((n) => n.type === "text" && plainOf(n.text) === "Fixture");
  const bar = header && b.nodes[header.parent!];
  check(bar?.style.position === "absolute" && bar.style.top === "0px", "a fixed header sits where it shows, at the top");
  check(!textOf("Skip to content") && !textOf("Never shown") && !textOf("Screen reader only"), "what isn't drawn (a skip link off the page, display:none, screen-reader-only words) stays behind");
  const reveal = textOf("Revealed later");
  check(Boolean(reveal) && reveal!.style.opacity !== "0", "words waiting for a scroll animation come in shown");
  const lib = path.resolve(out);
  const pics = nodes.filter((n) => n.type === "image");
  const logo = pics.find((n) => n.name?.includes("Logo"));
  check(Boolean(logo?.src?.startsWith(lib)) && existsSync(logo!.src!), "a picture is copied into the library");
  const bg = nodes.find((n) => /url\(/.test(n.style.backgroundImage ?? ""));
  check(Boolean(bg) && bg!.style.backgroundImage!.includes(lib), "a CSS background picture is copied too");
  const vec = nodes.find((n) => n.type === "svg" || n.type === "vector");
  check(Boolean(vec) && /42, 157, 143|2a9d8f/i.test(JSON.stringify(vec)), "an SVG keeps the colours its stylesheet gave it");
  check(pics.some((n) => n.src?.startsWith(lib) && n.style.width === "60px" && n.style.height === "30px"), "a <canvas> comes in as a picture of itself");
  check((b.fonts ?? []).some((f) => f.family === "Fixture Sans" && existsSync(f.src) && f.src.startsWith(lib)), "the page's own font is copied and carried by the board");
  check(elsewhere === 0, "the page couldn't reach anything else on this Mac");
  // Drawn back out, it looks like the page.
  const drawn = await drawLayers(b, [r.artboard], { scale: 1 });
  const p = await newPage();
  await p.setViewport({ width: 1200, height: 900 });
  await p.goto(siteUrl, { waitUntil: "networkidle0" });
  const real = Buffer.from(await p.screenshot({ fullPage: true, type: "png" }));
  const diff = await p.evaluate(async (a: string, c: string) => {
    const load = (src: string) => new Promise<HTMLImageElement>((ok) => { const i = new Image(); i.onload = () => ok(i); i.src = src; });
    const [x, y] = await Promise.all([load(a), load(c)]);
    const w = Math.min(x.width, y.width), h = Math.min(x.height, y.height);
    const px = (img: HTMLImageElement) => { const cv = document.createElement("canvas"); cv.width = w; cv.height = h; const g = cv.getContext("2d")!; g.drawImage(img, 0, 0); return g.getImageData(0, 0, w, h).data; };
    const pa = px(x), pb = px(y);
    let sum = 0;
    for (let i = 0; i < pa.length; i += 4) sum += (Math.abs(pa[i] - pb[i]) + Math.abs(pa[i + 1] - pb[i + 1]) + Math.abs(pa[i + 2] - pb[i + 2])) / 3;
    return { mean: sum / (w * h), sizes: [x.width, x.height, y.width, y.height] };
  }, `data:image/png;base64,${real.toString("base64")}`, `data:image/png;base64,${drawn.images[r.artboard].toString("base64")}`);
  await p.close();
  check(diff.mean < 6 && Math.abs(diff.sizes[1] - diff.sizes[3]) <= 2, `drawn back out, it matches the page (mean difference ${diff.mean.toFixed(2)} of 255, heights ${diff.sizes[1]} and ${diff.sizes[3]})`);
  // Agents bring sites in too, onto a new board named after it.
  const viaAgent = await call("board_import_website", { url: siteUrl, width: 390, fullPage: false });
  const made = viaAgent.json && store.getBoard(viaAgent.json.board);
  check(made?.name === "Fixture shop" && made.nodes[viaAgent.json.artboard]?.style.width === "390px", `board_import_website makes a board named after the site, read at the width asked for (${made?.name}, ${made?.nodes[viaAgent.json.artboard]?.style.width})`);
  const undo = store.changeBoard(shop.id, [{ op: "delete", ids: [r.artboard] }], "studio");
  check(!store.getBoard(shop.id).nodes[r.artboard] && undo.inverse.length > 0, "the imported artboard is an ordinary one: it deletes and undoes like any");
  site.close();
  other.close();
}

// Shaders through the tools: added and changed, own code compiled with errors by line, saved as the
// board's preset, written as HTML, read back, and pictured at its time.
{
  const { decodePng, pixelAt } = await import("../src/util/png.js");
  const sb = (await call("board_create", { name: "Shader tools" })).json.id;
  const art = (await call("board_write_html", { board: sb, html: `<div data-name="Hero" style="width:400px;height:300px;position:relative;background:#111"></div>` })).json.created[0].id;
  const added = await call("board_edit", { board: sb, changes: [{ do: "token", name: "--brand", value: "#2f7dff" }, { do: "shader", preset: "mesh-gradient", into: art, x: 0, y: 0, width: 400, height: 300, params: { color1: "var(--brand)", warp: 5, nope: 1 }, time: 4 }] });
  const r = added.json.results[1];
  check(r?.shader && r.params.warp === 2 && r.params.color1 === "var(--brand)" && r.warnings?.some((w: string) => /nope/.test(w)), `board_edit adds a shader layer, its params made safe and what was left out said (${JSON.stringify(r)})`);
  const tree = await call("board_read", { board: sb, node: art });
  check(/shader "mesh-gradient" \(preset\), params color1=var\(--brand\) warp=2, still at 4s/.test(tree.text), "board_read describes it");
  const broken = await call("board_edit", { board: sb, changes: [{ do: "shader", id: r.shader, code: "uniform float uGlow; // @param 0..1 = 0.5\nvoid main() {\n  gl_FragColor = vec4(vec3(uGlow) * missing, 1.0);\n}" }] });
  const br = broken.json.results[0];
  check(br.errors?.some((e: string) => /^line 3: .*missing/.test(e)) && /fix/.test(br.fix), `its own code that doesn't compile comes back with errors by line (${JSON.stringify(br.errors)})`);
  const fixed = await call("board_edit", { board: sb, changes: [{ do: "shader", id: r.shader, code: "uniform float uGlow; // @param 0..1 = 0.5\nuniform vec3 uTint; // @color = #ff3b30\nvoid main() {\n  gl_FragColor = vec4(uTint * (0.5 + uGlow), 1.0);\n}", params: { glow: 0.5 }, savePreset: "Red Glow" }] });
  check(!fixed.json.results[0].errors && fixed.json.results[0].preset === "red-glow", "fixed, it compiles, and is saved as the board's own preset");
  const listed = await call("board_read", { board: sb, what: "shaders" });
  check(/- red-glow: .*glow 0\.\.1/.test(listed.text) && /- halftone: .*spacing 4\.\.40 \(11 px\)/.test(listed.text), "board_read lists the presets, the board's own too, with their params");
  const shot = await call("board_screenshot", { board: sb, nodes: [art] });
  const mid = pixelAt(decodePng(shot.images[0]), 200, 150);
  check(mid[0] > 240 && mid[1] > 40 && mid[1] < 80 && mid[2] < 70, `board_screenshot draws the shader (${mid})`);
  const viaHtml = await call("board_write_html", {
    board: sb,
    target: art,
    html: `<canvas data-shader="custom" data-name="Bad" style="position:absolute;left:0;top:0;width:100px;height:100px"><script type="x-shader/x-fragment">void main() {\n  gl_FragColor = vec4(huh);\n}</script></canvas><div data-shader="waves" data-params='{"layers":40,"far":"red;x"}' style="position:absolute;left:100px;top:0;width:100px;height:100px"></div>`,
  });
  check(viaHtml.json.shaderErrors?.layers?.[0]?.name === "Bad" && /^line 2: .*huh/.test(viaHtml.json.shaderErrors.layers[0].errors[0]), `board_write_html compiles an agent's shader code and says what's wrong, by line (${JSON.stringify(viaHtml.json.shaderErrors)})`);
  check(viaHtml.json.warnings?.some((w: string) => /"far" was left out/.test(w)), "and makes its params safe, saying what it left out");
  const html = await call("board_read", { board: sb, node: art, what: "html" });
  check(/data-shader="waves" data-params="\{&quot;layers&quot;:10\}"/.test(html.text) && /data-shader="red-glow"/.test(html.text), "board_read html writes shaders as data-shader with their params");
  const del = await call("board_edit", { board: sb, changes: [{ do: "shader", deletePreset: "red-glow" }] });
  const after = await call("board_screenshot", { board: sb, nodes: [art] });
  const still = pixelAt(decodePng(after.images[0]), 200, 150);
  check(del.json.results[0].layersKeepItsCode?.includes(r.shader) && still[0] > 240 && still[1] < 80, "a board's preset removed, the layers using it keep its code and draw the same");
  const refused = await call("board_edit", { board: sb, changes: [{ do: "shader", preset: "lava-lamp" }] }, true);
  check(/There's no shader preset "lava-lamp"\. Built in: mesh-gradient/.test(refused.text), "an unknown preset is refused, with the ones there are");
}

console.log(`\nFiles in ${out}`);

await client.close();
console.log(failures ? `\n${failures} failed` : "\nAll passed");
process.exit(failures ? 1 : 0);
