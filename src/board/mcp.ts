/**
 * The board tools agents use: make a board, write HTML onto it, change layers, look at the result.
 * Every write lands in the person's Studio as they watch (the open board picks it up within a
 * second), marked as an agent's change so they can undo it.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { outputRoot, slug } from "../util/files.js";
import {
  addHtmlOps,
  canHold,
  flattenSvgOps,
  inlineHtml,
  parseHtml,
  serializeSvg,
  splitSvgOps,
  svgNodes,
  componentOps,
  copyTree,
  detachOps,
  instanceTree,
  resetOps,
  uncomponentOps,
  cssValue,
  freeSpot,
  newId,
  nodeHtml,
  pageOf,
  pxValue,
  rootOf,
  siblingsOf,
  sizeWord,
  treeText,
  type Board,
  type Op,
} from "./core.js";
import { drawLayers } from "./render.js";
import { deviceImage } from "./device.js";
import { builtinSvg, stickerNames, artNames } from "../render/images.js";
import { SHAPE_TYPES, shapeInBox } from "../render/shapes.js";
import { cacheDir } from "../util/files.js";
import { htmlToNodes, type BoardNode } from "./core.js";
import { cssWithPhotos, isUnsplash, placePhotos, unsplashPicture } from "./photos.js";
import { adoptImage, adoptImages, changeBoard, createBoard, findBoard, getBoard, listBoards, summarizeBoard } from "./store.js";
import { whoAmI, type AgentIdentity } from "./agentman.js";
import { describeAnchor, getComments, keysOf, reply, startThread, threadForAgent } from "./comments.js";

type Content = CallToolResult["content"];
const text = (value: unknown): Content[number] => ({ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) });

async function guard(fn: () => Promise<Content>): Promise<CallToolResult> {
  try {
    return { content: await fn() };
  } catch (e) {
    return { isError: true, content: [text(e instanceof Error ? e.message : String(e))] };
  }
}

export const BOARD_INSTRUCTIONS = `Boards (design and prototype UI before it's built): a board is a design made of real HTML and CSS, on pages of artboards, that the person watches you build live in the Studio and can edit after you. Use it to show a screen, a flow or a component before writing the code.
- board_create (or board_list to find one), then board_write_html to add an artboard: one top-level element with an explicit width and height (e.g. 390×844 for a phone screen, 1440×900 for desktop; height "fit-content" to grow with its content), styled inline. Then add to it piece by piece: target the artboard (or a frame in it) and write one visual group per call (a header, a card, a row), so the person sees it come together.
- Only inline styles count (style="…"): no classes, no <style> blocks, no scripts. Lay out with flexbox (display:flex, flex-direction, gap, padding, align-items); elements that flow as blocks become flex columns. Words go in text elements (p, h1–h6, span); <img src> takes a file path or URL; inline <svg> for icons.
- board_edit changes layers in place (styles, words, names, order, duplicates, deletes, tokens) without rewriting them; board_read shows the layer tree with ids (tree), the HTML (html) or the tokens.
- Look before you call it done: board_screenshot an artboard (or one layer) after each meaningful change. Fix overflow and alignment it shows. When you've finished, call board_done.
- Inline <svg> comes in as a vector layer with a layer for each part (groups, rects, circles, paths, lines, words), each with its SVG attributes; board_read tree lists them. board_edit vector sets a part's attributes (fill, stroke, d, cx…), text retypes an SVG <text>, and board_write_html with an svg layer (or a group in one) as the target adds SVG elements to it. split and flatten turn a vector drawn as one piece into parts and back.
- Tokens (board_edit token) are CSS custom properties every layer can use as var(--name): set colours, radii and spacing once and use them everywhere.
- Repeated pieces (a button, a list row, a card): build one, make it a component (board_edit component), and place copies of it (board_edit copy). Change the component to change them all; change a copy's words or colours for that copy alone.
- Real photos: <img src="unsplash:ramen bowl"> (or a CSS background of url(unsplash:skatepark)) puts in the top free Unsplash photo for those words, shaped to the layer; "unsplash:ramen bowl#2" takes the second. It searches with the key the person saved in Screenshotter's Settings › Photos, and the result names each photo's photographer: credit them where the design is shown.
- Screenshotter's own assets work here too: <img src="sticker:heart"> or "art:squiggle" (list_mockup_options names them) for its stickers and illustrations; board_edit shape for its arrows, badges, laurels and ratings; board_edit device to show a screenshot, or one of the board's artboards, in Apple's device frame. Blur and filters are CSS (filter, backdrop-filter).
- Comments: the person pins comments to layers or regions of a board and sends them to the agents that worked on it. One for you arrives as a message starting "(From Screenshotter)", with the board's and the comment's ids and the layers it's on. Make the change it asks for with the tools above, then answer in its thread with board_comment; the person sees your reply by the comment and resolves it when they're happy. board_comments lists the open ones for you.`;

const BoardRef = z.string().describe("The board's id (from board_list or board_create) or its name.");

/** <img src="sticker:heart"> and "art:squiggle" become the built-in pictures as vectors (one-ink art takes `color`). */
function inlineBuiltins(nodes: Record<string, BoardNode>, warnings: string[]) {
  for (const [id, n] of Object.entries(nodes)) {
    if (n.type !== "image" || !n.src || !/^(sticker|art):/i.test(n.src)) continue;
    const got = builtinSvg(n.src);
    if (!got) {
      warnings.push(`There's no ${n.src.startsWith("art") ? "illustration" : "sticker"} "${n.src}". Stickers: ${stickerNames().join(", ")}. Illustrations: ${artNames().join(", ")}.`);
      continue;
    }
    const svg = htmlToNodes(got.mono ? got.svg.replace(/#1d1d1f/gi, "currentColor") : got.svg, { wholeSvg: true });
    const v = svg.nodes[svg.roots[0]];
    const { src: _src, ...rest } = n;
    nodes[id] = { ...rest, type: "svg", svg: v.svg, style: { width: v.style.width, height: v.style.height, ...(got.mono ? { color: "#1d1d1f" } : {}), ...n.style } };
  }
}

/** The svg layer a vector's part is drawn in. */
function rootSvg(b: Board, id: string): string {
  let x = id;
  while (b.nodes[x]?.type === "vector" && b.nodes[x].parent) x = b.nodes[x].parent!;
  return x;
}

/** Where a new layer goes for board_edit: into a frame, before/after a layer, or on the page at x/y. */
function placeFor(b: Board, c: { into?: string; before?: string; after?: string; index?: number; x?: number; y?: number }, need: (id: string) => BoardNode) {
  const ref = c.before ?? c.after;
  if (ref) {
    const r = need(ref);
    return { parent: r.parent, index: siblingsOf(b, ref).indexOf(ref) + (c.after ? 1 : 0), page: r.parent ? undefined : pageOf(b, ref)?.id };
  }
  if (c.into && c.into !== "page") {
    if (need(c.into).type !== "frame") throw new Error(`${b.nodes[c.into].name} isn't a frame.`);
    return { parent: c.into, index: c.index, page: undefined };
  }
  return { parent: null, index: undefined, page: b.pages[0].id };
}

function placeInfo(b: Board, id: string) {
  const n = b.nodes[id];
  return `${n.name} (#${id}, ${sizeWord(b, id, "width")}×${sizeWord(b, id, "height")})`;
}

/**
 * The artboards a set of layers is on, marked as being worked on, and the agent remembered as
 * having worked on them (so a comment on them can reach it).
 */
function workingOps(b: Board, ids: string[], me: AgentIdentity): Op[] {
  const roots = [...new Set(ids.filter((id) => b.nodes[id]).map((id) => rootOf(b, id)))];
  const at = new Date().toISOString();
  return [...(roots.length ? [{ op: "working" as const, ids: roots, at }] : []), { op: "agent", agent: me, artboards: roots, at }];
}

const StyleValue = z.union([z.string(), z.number(), z.null()]);
const StyleMap = z.record(z.string(), StyleValue).describe('CSS properties in camelCase or kebab-case (backgroundColor or "background-color"), values as CSS ("12px", "#0a0a0b", "var(--brand)"). A bare number is px (except opacity, fontWeight, lineHeight, flexGrow, zIndex). null removes the property.');

const ChangeSchema = z.discriminatedUnion("do", [
  z.object({ do: z.literal("style"), ids: z.array(z.string()).min(1).describe("Layers to restyle."), style: StyleMap }),
  z.object({ do: z.literal("text"), id: z.string(), text: z.string().describe("The words, as inline HTML: <b>, <i>, <span style=\"…\">, <br>. For an SVG <text> part: its words (and <tspan>s).") }),
  z.object({
    do: z.literal("vector"),
    ids: z.array(z.string()).min(1).describe("Parts of a vector (or a vector layer, for its <svg>'s own attributes)."),
    attrs: z.record(z.string(), z.union([z.string(), z.number(), z.null()])).describe('SVG attributes as written in SVG: { "fill": "#ff3b30", "stroke-width": 2, "d": "M0 0L10 10", "cx": 40 }. null removes one.'),
  }),
  z.object({ do: z.literal("split"), id: z.string().describe("A vector drawn as one piece (a sticker, a shape, an older vector): a layer for each of its parts.") }),
  z.object({ do: z.literal("flatten"), id: z.string().describe("A vector in parts: one layer again, its parts as SVG markup.") }),
  z.object({ do: z.literal("rename"), id: z.string(), name: z.string() }),
  z.object({ do: z.literal("delete"), ids: z.array(z.string()).min(1) }),
  z.object({
    do: z.literal("duplicate"),
    id: z.string(),
    count: z.number().int().min(1).max(50).optional().describe("How many copies. Default 1."),
  }),
  z.object({
    do: z.literal("move"),
    id: z.string(),
    into: z.string().optional().describe('A frame to move it into (at the end, or at `index`), or "page" for the page itself.'),
    before: z.string().optional().describe("Put it just before this layer (in that layer's frame)."),
    after: z.string().optional().describe("Put it just after this layer."),
    index: z.number().int().min(0).optional(),
  }),
  z.object({ do: z.literal("visibility"), ids: z.array(z.string()).min(1), hidden: z.boolean() }),
  z.object({ do: z.literal("lock"), ids: z.array(z.string()).min(1), locked: z.boolean() }),
  z.object({ do: z.literal("image"), id: z.string(), src: z.string().describe('A file path or URL for the image layer, or "unsplash:<words>" for the top free Unsplash photo ("#2" for the second).') }),
  z.object({
    do: z.literal("artboard"),
    name: z.string(),
    width: z.number().positive(),
    height: z.union([z.number().positive(), z.literal("fit-content")]),
    x: z.number().optional(),
    y: z.number().optional(),
    style: StyleMap.optional(),
    page: z.string().optional().describe("The page's id. Default: the first page."),
  }),
  z.object({ do: z.literal("page"), name: z.string().describe("A new page's name, or the new name for `id`."), id: z.string().optional(), delete: z.boolean().optional() }),
  z.object({ do: z.literal("token"), name: z.string().describe('A CSS custom property name ("--brand" or "brand").'), value: z.string().nullable().describe("Its value, or null to remove it.") }),
  z.object({ do: z.literal("component"), id: z.string().describe("A frame to make a component (or, with remove, to make ordinary again)."), remove: z.boolean().optional() }),
  z.object({
    do: z.literal("copy"),
    of: z.string().describe("The component to make a copy of."),
    into: z.string().optional().describe('A frame to put the copy in (at the end, or at `index`), or "page". Default: beside the component.'),
    before: z.string().optional(),
    after: z.string().optional(),
    index: z.number().int().min(0).optional(),
    x: z.number().optional().describe("On the page: where its left edge goes."),
    y: z.number().optional(),
  }),
  z.object({
    do: z.literal("shape"),
    type: z.enum(SHAPE_TYPES).describe("One of Screenshotter's shapes: an arrow or line, an ellipse or box (outlines), a triangle, star, number badge, laurel, rating, burst, ribbon, bubble or tag."),
    width: z.number().positive(),
    height: z.number().positive(),
    into: z.string().optional().describe('A frame to put it in, or "page".'),
    before: z.string().optional(),
    after: z.string().optional(),
    index: z.number().int().min(0).optional(),
    x: z.number().optional().describe("Left edge: on the page, or inside a frame laid out by hand."),
    y: z.number().optional(),
    fill: z.string().optional(),
    stroke: z.string().optional(),
    strokeWidth: z.number().optional().describe("In px."),
    text: z.string().optional().describe("The words of a laurel, rating, burst, ribbon, bubble or tag."),
    label: z.string().optional().describe("A badge's number or letter."),
    labelColor: z.string().optional(),
    value: z.number().optional().describe("A rating's stars, 0–5."),
    head: z.enum(["end", "start", "both", "none"]).optional(),
    bend: z.number().min(-1).max(1).optional(),
    sketch: z.boolean().optional().describe("Hand-drawn."),
    name: z.string().optional(),
  }),
  z.object({
    do: z.literal("device"),
    screenshot: z.string().optional().describe("A screenshot to put in Apple's device frame (the model is detected from its size, or give `device`)."),
    artboard: z.string().optional().describe("Or an artboard on this board: it's drawn at 3× as the device's screen."),
    device: z.string().optional().describe('e.g. "iPhone 17 Pro".'),
    color: z.string().optional(),
    height: z.number().positive().optional().describe("The picture's height in px. Default 460."),
    into: z.string().optional(),
    before: z.string().optional(),
    after: z.string().optional(),
    x: z.number().optional(),
    y: z.number().optional(),
  }),
  z.object({ do: z.literal("detach"), id: z.string().describe("A copy of a component, to make ordinary layers.") }),
  z.object({ do: z.literal("reset"), id: z.string().describe("A copy (or a layer in one) to make match its component again.") }),
]);

function styleOf(map: Record<string, string | number | null>): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const [k0, v] of Object.entries(map)) {
    const k = k0.includes("-") && !k0.startsWith("--") ? k0.replace(/^-(webkit|moz|ms)-/, "$1-").replace(/-([a-z])/g, (_, c: string) => c.toUpperCase()) : k0;
    out[k] = v === null ? null : cssValue(k, v);
  }
  return out;
}

export function registerBoardTools(server: McpServer) {
  server.registerTool(
    "board_list",
    {
      title: "List boards",
      description: "The boards in the person's Studio (designs made of HTML and CSS), newest first, each with its pages and artboards (ids, names, sizes, positions).",
      inputSchema: {},
    },
    () => guard(async () => [text(listBoards().map(({ thumb: _t, ...b }) => b))]),
  );

  server.registerTool(
    "board_create",
    {
      title: "Make a board",
      description: "Make a new, empty board in the Studio (it appears under Boards, where the person can watch you work). Returns its id and its first page. Then add artboards with board_write_html.",
      inputSchema: { name: z.string().max(120).describe("What it's for, e.g. \"Onboarding flow\".") },
    },
    (a) =>
      guard(async () => {
        const b = createBoard(a.name, "agent");
        changeBoard(b.id, workingOps(b, [], await whoAmI()), "agent");
        return [text({ id: b.id, name: b.name, page: b.pages[0], note: "Empty. Add an artboard with board_write_html (no target) or board_edit { do: \"artboard\" }." })];
      }),
  );

  server.registerTool(
    "board_read",
    {
      title: "Read a board",
      description:
        "Look inside a board. `what`: \"overview\" (default: pages, artboards with sizes, tokens), \"tree\" (an outline of a layer or every artboard on a page, with ids, sizes as written (320, fit, fill) and layout; `measure` adds the sizes they really came out at), \"html\" (a layer and what's in it as HTML with inline styles and data-id on every element) or \"tokens\".",
      inputSchema: {
        board: BoardRef,
        what: z.enum(["overview", "tree", "html", "tokens"]).optional(),
        node: z.string().optional().describe("A layer's id, for tree and html. Default: every artboard on the page."),
        page: z.string().optional().describe("A page's id. Default: the first page."),
        depth: z.number().int().min(1).max(20).optional().describe("How many levels the tree goes down. Default 4."),
        measure: z.boolean().optional().describe("With tree: draw the board and add each layer's real box (x,y relative to its artboard, width×height). Slower."),
      },
    },
    (a) =>
      guard(async () => {
        const b = findBoard(a.board);
        const what = a.what ?? (a.node ? "tree" : "overview");
        const page = a.page ? b.pages.find((p) => p.id === a.page) : a.node ? pageOf(b, a.node) : b.pages[0];
        if (!page) throw new Error(`There's no page ${a.page} on this board.`);
        if (a.node && !b.nodes[a.node]) throw new Error(`There's no layer ${a.node} on this board.`);
        const ids = a.node ? [a.node] : page.children;
        if (what === "overview") {
          const s = summarizeBoard(b);
          return [text({ id: b.id, name: b.name, rev: b.rev, pages: s.pages, tokens: b.tokens, layers: s.layers, editedAt: b.updatedAt, lastEditBy: b.by })];
        }
        if (what === "tokens") return [text(b.tokens.length ? b.tokens : "No tokens yet. Add one with board_edit { do: \"token\", name, value }.")];
        if (what === "html") return [text(ids.map((id) => nodeHtml(b, id, { ids: true })).join("\n\n") || "The page is empty.")];
        let out = ids.map((id) => treeText(b, id, a.depth ?? 4)).join("\n\n") || "The page is empty.";
        if (a.measure && ids.length) {
          const { boxes } = await drawLayers(b, ids, { scale: 0.25 });
          out = out.replace(/#([a-z0-9]+) /g, (m, id: string) => (boxes[id] ? `${m}[${boxes[id].x},${boxes[id].y} ${boxes[id].width}×${boxes[id].height}] ` : m));
        }
        return [text(out)];
      }),
  );

  server.registerTool(
    "board_write_html",
    {
      title: "Write HTML onto a board",
      description:
        "Add layers to a board from HTML with inline styles. Without `target`, each top-level element becomes a new artboard on the page (give it a width and height; it's placed to the right of the others unless you pass x/y). With `target` (a frame's id), the HTML goes inside it (at the end, or at `index`); `position` \"before\"/\"after\" puts it beside the target instead, and \"replace\" swaps the target for it. Write one visual group per call (a header, a row, a card) so the person sees the design come together. Returns the new layers' ids and outline.",
      inputSchema: {
        board: BoardRef,
        html: z.string().min(1).max(400_000),
        target: z.string().optional().describe("The frame to write into (or beside, with position)."),
        position: z.enum(["inside", "before", "after", "replace"]).optional().describe("Where the HTML goes relative to target. Default inside."),
        index: z.number().int().min(0).optional().describe("With position inside: where among the frame's layers (0 = first). Default: last."),
        page: z.string().optional().describe("For new artboards: the page's id. Default: the first page."),
        x: z.number().optional().describe("For a new artboard: where its left edge goes on the page."),
        y: z.number().optional(),
        preview: z.boolean().optional().describe("Also return a picture of the artboard after the change. Default false."),
      },
    },
    (a) =>
      guard(async () => {
        const b = findBoard(a.board);
        const mode = a.position ?? "inside";
        let parent: string | null = null;
        let index: number | undefined;
        let page = a.page;
        const extra: Op[] = [];
        if (a.target) {
          const t = b.nodes[a.target];
          if (!t) throw new Error(`There's no layer ${a.target} on this board.`);
          const vectorish = (x: BoardNode | null | undefined) => Boolean(x && ((x.type === "svg" && !x.svg) || (x.type === "vector" && x.tag === "g")));
          if (vectorish(mode === "inside" ? t : t.parent ? b.nodes[t.parent] : null)) {
            // SVG into a vector: its elements become parts of it.
            const into = mode === "inside" ? t.id : t.parent!;
            const el = parseHtml(`<svg>${a.html}</svg>`).children.find((c): c is Exclude<typeof c, string> => typeof c !== "string" && c.tag === "svg");
            const got = el ? svgNodes(el, into, {}, "") : null;
            const kids = got ? got.nodes[got.id].children ?? [] : [];
            if (!got || !kids.length) throw new Error("Write SVG elements (rect, circle, path, g, text…) into a vector.");
            const nodes = { ...got.nodes };
            delete nodes[got.id];
            for (const k of kids) nodes[k] = { ...nodes[k], parent: into };
            const sibs = b.nodes[into].children ?? [];
            const at = mode === "inside" ? a.index : sibs.indexOf(t.id) + (mode === "after" ? 1 : 0);
            const ops: Op[] = [{ op: "add", nodes, ids: kids, parent: into, index: at }];
            if (got.nodes[got.id].defs) ops.push({ op: "set", id: rootSvg(b, into), defs: `${b.nodes[rootSvg(b, into)].defs ?? ""}${got.nodes[got.id].defs}` });
            if (mode === "replace") ops.push({ op: "delete", ids: [t.id] });
            const after = changeBoard(b.id, ops, "agent").board;
            changeBoard(b.id, workingOps(after, kids, await whoAmI()), "agent");
            return [text({ created: kids.map((id) => ({ id, name: after.nodes[id]?.name })), outline: kids.map((id) => treeText(after, id, 3)).join("\n") })];
          }
          if (mode === "inside") {
            if (t.type !== "frame") throw new Error(`${t.name} is ${t.type === "text" ? "a text layer" : t.type === "vector" ? "part of a vector" : `an ${t.type} layer`}, which can't hold layers: target its frame, or use position "after".`);
            parent = t.id;
            index = a.index;
          } else {
            parent = t.parent;
            const sibs = siblingsOf(b, t.id);
            index = sibs.indexOf(t.id) + (mode === "after" ? 1 : 0);
            if (!parent) page = pageOf(b, t.id)?.id;
            if (mode === "replace") extra.push({ op: "delete", ids: [t.id] });
          }
        } else if (page && !b.pages.some((p) => p.id === page)) throw new Error(`There's no page ${page} on this board.`);
        const made = addHtmlOps(a.html, parent, { page, index });
        if (!made.roots.length) throw new Error("The HTML had nothing to draw (no elements or words).");
        inlineBuiltins(made.nodes, made.warnings);
        const photos: string[] = [];
        await placePhotos(made.nodes, made.warnings, photos);
        adoptImages(made.nodes, made.warnings);
        // New artboards go where asked, else to the right of the others.
        if (!parent) {
          const pid = page ?? b.pages[0].id;
          let { left, top } = a.x !== undefined || a.y !== undefined ? { left: a.x ?? 0, top: a.y ?? 0 } : freeSpot(b, pid, 0);
          for (const id of made.roots) {
            const s = made.nodes[id].style;
            s.left = `${Math.round(left)}px`;
            s.top = `${Math.round(top)}px`;
            delete s.position;
            if (!s.width) made.warnings.push(`The artboard "${made.nodes[id].name}" has no width, so it's as wide as its content: give it one (e.g. width:390px).`);
            left += (pxValue(s.width) ?? 400) + 120;
          }
        }
        const ops: Op[] = [...made.ops, ...extra];
        // Replacing: the new layers go where the old one was, before it's removed.
        const changed = changeBoard(b.id, ops, "agent");
        const after = changed.board;
        changeBoard(b.id, workingOps(after, made.roots, await whoAmI()), "agent");
        const out: Content = [text({ created: made.roots.map((id) => ({ id, name: after.nodes[id]?.name })), outline: made.roots.map((id) => treeText(after, id, 4)).join("\n\n"), photos: photos.length ? [...new Set(photos)] : undefined, warnings: made.warnings.length ? made.warnings : undefined })];
        if (a.preview) {
          const root = rootOf(after, made.roots[0]);
          const { images } = await drawLayers(after, [root], { scale: 1, maxEdge: 1400 });
          if (images[root]) out.push({ type: "image", data: images[root].toString("base64"), mimeType: "image/png" });
        }
        return out;
      }),
  );

  server.registerTool(
    "board_edit",
    {
      title: "Change layers on a board",
      description:
        "Change a board in one go: a list of `changes`, applied together (the person can undo them as one step). Each is one of: style (set CSS on layers; null removes a property), text (a text layer's words, or an SVG <text>'s), vector (SVG attributes of a vector's parts: fill, stroke, d, cx…), split / flatten (a vector into a layer for each part, and back), rename, delete, duplicate (the copy goes right after the original; returns its id), move (into a frame or the page, or before/after a layer), visibility, lock, image (an image layer's picture), artboard (a new empty one, placed beside the others unless x/y), page (add a page, or rename/delete one by id), token (a CSS custom property for var(--name)), shape (one of Screenshotter's shapes, drawn to a box: arrows, stars, badges, laurels, ratings, ribbons…), device (a screenshot or one of the board's artboards in Apple's device frame, as a picture), component (make a frame a component), copy (a copy of a component, which follows it: change the component and every copy changes, except what was changed in that copy), detach (a copy becomes ordinary layers), reset (a copy matches its component again). Layers inside a copy can be restyled, retyped or hidden, not added, moved or deleted. Returns what each change did.",
      inputSchema: { board: BoardRef, changes: z.array(ChangeSchema).min(1).max(200) },
    },
    (a) =>
      guard(async () => {
        let b = findBoard(a.board);
        const ops: Op[] = [];
        const results: unknown[] = [];
        const photos: string[] = [];
        const photoWarnings: string[] = [];
        const touched: string[] = [];
        const need = (id: string) => {
          if (!b.nodes[id]) throw new Error(`There's no layer ${id} on this board.`);
          return b.nodes[id];
        };
        for (const c of a.changes) {
          switch (c.do) {
            case "style":
              for (const id of c.ids) need(id);
              for (const id of c.ids) {
                const style = styleOf(c.style);
                // url(unsplash:…) becomes a photo the layer's shape (each layer its own size).
                const n = b.nodes[id];
                const box = { width: pxValue(style.width ?? n.style.width) ?? 1200, height: pxValue(style.height ?? n.style.height) ?? 800 };
                for (const [k, v] of Object.entries(style)) {
                  if (!v || !/url\(\s*['"]?(unsplash:|https?:\/\/unsplash\.com\/photos\/)/i.test(v)) continue;
                  // A photo that can't be had leaves the property as it was (the warning says why).
                  const done = await cssWithPhotos(v, box, photoWarnings, photos);
                  if (done === null) delete style[k];
                  else style[k] = done;
                }
                ops.push({ op: "set", id, style });
              }
              touched.push(...c.ids);
              results.push({ styled: c.ids.length });
              break;
            case "text": {
              const n = need(c.id);
              const svgText = n.type === "vector" && n.tag === "text";
              if (n.type !== "text" && !svgText) throw new Error(`${n.name} isn't a text layer.`);
              // Only words and inline tags (or, in SVG, tspans) are kept: nothing that runs.
              const words = svgText ? parseHtml(c.text).children.map(serializeSvg).join("") : inlineHtml(parseHtml(c.text).children);
              ops.push({ op: "set", id: c.id, text: words });
              touched.push(c.id);
              results.push({ text: c.id });
              break;
            }
            case "vector": {
              for (const id of c.ids) {
                const n = need(id);
                if (n.type !== "vector" && !(n.type === "svg" && !n.svg)) throw new Error(`${n.name} isn't part of a vector${n.type === "svg" ? " (it's drawn as one piece: split it first)" : ""}.`);
              }
              const attrs = Object.fromEntries(Object.entries(c.attrs).map(([k, v]) => [k, v === null ? null : String(v)]));
              for (const id of c.ids) ops.push({ op: "set", id, attrs });
              touched.push(...c.ids);
              results.push({ vector: c.ids.length });
              break;
            }
            case "split":
              ops.push(...splitSvgOps(b, need(c.id).id));
              touched.push(c.id);
              results.push({ split: c.id });
              break;
            case "flatten":
              ops.push(...flattenSvgOps(b, need(c.id).id));
              touched.push(c.id);
              results.push({ flattened: c.id });
              break;
            case "rename":
              need(c.id);
              ops.push({ op: "set", id: c.id, name: c.name });
              results.push({ renamed: c.id });
              break;
            case "delete":
              for (const id of c.ids) need(id);
              ops.push({ op: "delete", ids: c.ids });
              results.push({ deleted: c.ids.length });
              break;
            case "duplicate": {
              const n = need(c.id);
              const copies: string[] = [];
              const sibs = siblingsOf(b, c.id);
              let at = sibs.indexOf(c.id) + 1;
              for (let k = 0; k < (c.count ?? 1); k++) {
                const clone = copyTree(b, c.id, n.parent);
                // A copied artboard goes beside the rest instead of on top of the original.
                if (!n.parent) {
                  const spot = freeSpot(b, pageOf(b, c.id)!.id, 0);
                  const shift = (pxValue(n.style.width) ?? 400) + 120;
                  clone.nodes[clone.id].style.left = `${spot.left + k * shift}px`;
                  clone.nodes[clone.id].style.top = n.style.top ?? "0px";
                }
                ops.push({ op: "add", nodes: clone.nodes, ids: [clone.id], parent: n.parent, page: n.parent ? undefined : pageOf(b, c.id)?.id, index: at++ });
                copies.push(clone.id);
              }
              touched.push(...copies);
              results.push({ duplicated: c.id, copies });
              break;
            }
            case "move": {
              need(c.id);
              const ref = c.before ?? c.after;
              if (ref) {
                const r = need(ref);
                const sibs = siblingsOf(b, ref).filter((x) => x !== c.id);
                const i = sibs.indexOf(ref) + (c.after ? 1 : 0);
                ops.push({ op: "move", id: c.id, parent: r.parent, page: r.parent ? undefined : pageOf(b, ref)?.id, index: i });
              } else if (c.into === "page") ops.push({ op: "move", id: c.id, parent: null, page: pageOf(b, c.id)?.id, index: c.index });
              else if (c.into) {
                const t = need(c.into);
                if (!canHold(t, need(c.id))) throw new Error(`${t.name} can't hold ${b.nodes[c.id].name}: frames hold layers, and a vector (or a group in one) holds a vector's parts.`);
                ops.push({ op: "move", id: c.id, parent: c.into, index: c.index });
              } else throw new Error("A move needs `into`, `before` or `after`.");
              touched.push(c.id);
              results.push({ moved: c.id });
              break;
            }
            case "visibility":
              for (const id of c.ids) need(id);
              for (const id of c.ids) ops.push({ op: "set", id, hidden: c.hidden ? true : null });
              results.push({ [c.hidden ? "hidden" : "shown"]: c.ids.length });
              break;
            case "lock":
              for (const id of c.ids) need(id);
              for (const id of c.ids) ops.push({ op: "set", id, locked: c.locked ? true : null });
              results.push({ [c.locked ? "locked" : "unlocked"]: c.ids.length });
              break;
            case "image": {
              const n = need(c.id);
              if (n.type !== "image") throw new Error(`${n.name} isn't an image layer.`);
              if (isUnsplash(c.src)) {
                const p = await unsplashPicture(c.src, { width: pxValue(n.style.width) ?? 1200, height: pxValue(n.style.height) ?? 800 });
                if (p.credit) photos.push(p.credit);
                ops.push({ op: "set", id: c.id, src: p.src });
                touched.push(c.id);
                results.push({ image: c.id });
                break;
              }
              const got = adoptImage(c.src);
              if (got.warning) throw new Error(got.warning);
              ops.push({ op: "set", id: c.id, src: got.src });
              touched.push(c.id);
              results.push({ image: c.id });
              break;
            }
            case "artboard": {
              const pid = c.page ?? b.pages[0].id;
              if (!b.pages.some((p) => p.id === pid)) throw new Error(`There's no page ${pid} on this board.`);
              const spot = c.x !== undefined || c.y !== undefined ? { left: c.x ?? 0, top: c.y ?? 0 } : freeSpot(b, pid, c.width);
              const id = newId();
              const style = { display: "flex", flexDirection: "column", backgroundColor: "#ffffff", overflow: "hidden", ...Object.fromEntries(Object.entries(styleOf(c.style ?? {})).filter(([, v]) => v !== null)), width: `${c.width}px`, height: c.height === "fit-content" ? "fit-content" : `${c.height}px`, left: `${Math.round(spot.left)}px`, top: `${Math.round(spot.top)}px` } as Record<string, string>;
              ops.push({ op: "add", nodes: { [id]: { id, type: "frame", name: c.name, parent: null, style, children: [] } }, ids: [id], parent: null, page: pid });
              // Later changes in this list can find it.
              b = { ...b, nodes: { ...b.nodes, [id]: { id, type: "frame", name: c.name, parent: null, style, children: [] } }, pages: b.pages.map((p) => (p.id === pid ? { ...p, children: [...p.children, id] } : p)) };
              touched.push(id);
              results.push({ artboard: id, name: c.name, at: [spot.left, spot.top] });
              break;
            }
            case "page":
              if (c.id && c.delete) {
                ops.push({ op: "deletePage", id: c.id });
                results.push({ deletedPage: c.id });
              } else if (c.id) {
                ops.push({ op: "setPage", id: c.id, name: c.name });
                results.push({ renamedPage: c.id });
              } else {
                const id = newId();
                ops.push({ op: "addPage", page: { id, name: c.name, children: [] } });
                results.push({ page: id, name: c.name });
              }
              break;
            case "token":
              ops.push({ op: "token", name: c.name, value: c.value });
              results.push({ token: c.name.startsWith("--") ? c.name : `--${c.name}`, value: c.value });
              break;
            case "component":
              need(c.id);
              ops.push(...(c.remove ? uncomponentOps(b, c.id) : componentOps(b, c.id)));
              // Copies made later in this list need it to be one already.
              b = { ...b, nodes: { ...b.nodes, [c.id]: { ...b.nodes[c.id], isComponent: c.remove ? undefined : true } } };
              results.push({ [c.remove ? "noLongerComponent" : "component"]: c.id });
              break;
            case "copy": {
              const m = need(c.of);
              if (!m.isComponent) throw new Error(`${m.name} isn't a component: make it one first with { do: "component", id }.`);
              let parent: string | null;
              let index: number | undefined;
              let page: string | undefined;
              const ref = c.before ?? c.after;
              if (ref) {
                const r = need(ref);
                parent = r.parent;
                index = siblingsOf(b, ref).indexOf(ref) + (c.after ? 1 : 0);
                page = parent ? undefined : pageOf(b, ref)?.id;
              } else if (c.into && c.into !== "page") {
                if (need(c.into).type !== "frame") throw new Error(`${b.nodes[c.into].name} isn't a frame.`);
                parent = c.into;
                index = c.index;
              } else if (c.into === "page" || !m.parent) {
                parent = null;
                page = pageOf(b, c.of)?.id;
              } else {
                parent = m.parent;
                index = siblingsOf(b, c.of).indexOf(c.of) + 1;
              }
              const t = instanceTree(b, c.of, parent);
              if (!parent) {
                const spot = c.x !== undefined || c.y !== undefined ? { left: c.x ?? 0, top: c.y ?? 0 } : freeSpot(b, page ?? b.pages[0].id, 0);
                Object.assign(t.nodes[t.id].style, { left: `${Math.round(spot.left)}px`, top: `${Math.round(spot.top)}px` });
              }
              ops.push({ op: "add", nodes: t.nodes, ids: [t.id], parent, page, index });
              touched.push(t.id);
              results.push({ copy: t.id, of: c.of });
              break;
            }
            case "shape": {
              const where = placeFor(b, c, need);
              const { do: _d, width, height, into: _i, before: _b, after: _a, index: _ix, x, y, name, ...settings } = c;
              const shape = { ...settings } as Record<string, unknown>;
              const id = newId();
              const style: Record<string, string> = { width: `${width}px`, height: `${height}px`, flexShrink: "0" };
              const parentFlex = where.parent ? b.nodes[where.parent]?.style.display === "flex" : false;
              if (!where.parent) Object.assign(style, { left: `${Math.round(x ?? freeSpot(b, where.page!, width).left)}px`, top: `${Math.round(y ?? 0)}px` });
              else if (!parentFlex || x !== undefined) Object.assign(style, { position: "absolute", left: `${Math.round(x ?? 0)}px`, top: `${Math.round(y ?? 0)}px` });
              const n: BoardNode = { id, type: "svg", name: name ?? c.type, parent: where.parent, shape, svg: shapeInBox(shape as never, width, height), style };
              ops.push({ op: "add", nodes: { [id]: n }, ids: [id], parent: where.parent, page: where.page, index: where.index });
              touched.push(id);
              results.push({ shape: id, type: c.type });
              break;
            }
            case "device": {
              let shot = c.screenshot;
              if (!shot && c.artboard) {
                need(c.artboard);
                const { images } = await drawLayers(b, [c.artboard], { scale: 3, format: "png", transparent: false });
                if (!images[c.artboard]) throw new Error("That artboard has no size to draw.");
                shot = path.join(cacheDir("board-artboards"), `${b.id}-${c.artboard}-${b.rev}.png`);
                writeFileSync(shot, images[c.artboard]);
              }
              if (!shot) throw new Error("A device needs a `screenshot` or an `artboard`.");
              const img = await deviceImage(path.resolve(shot), { device: c.device, color: c.color });
              const h = c.height ?? 460;
              const w = Math.round((img.width / img.height) * h);
              const where = placeFor(b, c, need);
              const id = newId();
              const style: Record<string, string> = { width: `${w}px`, height: `${Math.round(h)}px`, objectFit: "contain", flexShrink: "0" };
              if (!where.parent) Object.assign(style, { left: `${Math.round(c.x ?? freeSpot(b, where.page!, w).left)}px`, top: `${Math.round(c.y ?? 0)}px` });
              else if (c.x !== undefined) Object.assign(style, { position: "absolute", left: `${Math.round(c.x)}px`, top: `${Math.round(c.y ?? 0)}px` });
              ops.push({ op: "add", nodes: { [id]: { id, type: "image", name: c.device ?? "Device", parent: where.parent, src: img.path, style } }, ids: [id], parent: where.parent, page: where.page, index: where.index });
              touched.push(id);
              results.push({ device: id, picture: img.path });
              break;
            }
            case "detach":
              need(c.id);
              if (!b.nodes[c.id].instanceOf) throw new Error(`${b.nodes[c.id].name} isn't a copy of a component.`);
              ops.push(...detachOps(b, c.id));
              results.push({ detached: c.id });
              break;
            case "reset":
              need(c.id);
              ops.push(...resetOps(b, c.id));
              results.push({ reset: c.id });
              break;
          }
        }
        const changed = changeBoard(b.id, ops, "agent");
        changeBoard(b.id, workingOps(changed.board, touched, await whoAmI()), "agent");
        return [text({ results, rev: changed.board.rev, photos: photos.length ? [...new Set(photos)] : undefined, warnings: photoWarnings.length ? photoWarnings : undefined })];
      }),
  );

  server.registerTool(
    "board_screenshot",
    {
      title: "Look at a board",
      description:
        "A picture of a layer (usually an artboard), drawn exactly as the Studio shows it, to check your work: alignment, spacing, overflow, contrast. Default: every artboard on the first page. Pictures longer than `maxEdge` px are scaled down; use a layer inside an artboard to see small details up close.",
      inputSchema: {
        board: BoardRef,
        nodes: z.array(z.string()).max(8).optional().describe("Layers to picture. Default: the first page's artboards (up to 8)."),
        page: z.string().optional(),
        scale: z.number().min(0.25).max(3).optional().describe("Pixels per CSS pixel. Default 1 (2 for small layers)."),
        maxEdge: z.number().int().min(200).max(2400).optional().describe("Default 1400."),
        boxes: z.boolean().optional().describe("Also list where every layer inside came out (x,y relative to its artboard, width×height)."),
      },
    },
    (a) =>
      guard(async () => {
        const b = findBoard(a.board);
        const page = a.page ? b.pages.find((p) => p.id === a.page) : b.pages[0];
        const ids = a.nodes?.length ? a.nodes : (page?.children ?? []).slice(0, 8);
        if (!ids.length) throw new Error("The page is empty: there's nothing to picture yet.");
        const { images, boxes } = await drawLayers(b, ids, { scale: a.scale ?? 1, maxEdge: a.maxEdge ?? 1400 });
        const out: Content = [];
        for (const id of ids) {
          if (!images[id]) {
            out.push(text(`${b.nodes[id]?.name ?? id} (#${id}) has no size, so there's nothing to see: give it a width and height or some content.`));
            continue;
          }
          out.push(text(placeInfo(b, id) + (boxes[id] ? ` came out ${boxes[id].width}×${boxes[id].height}` : "")));
          out.push({ type: "image", data: images[id].toString("base64"), mimeType: "image/png" });
        }
        if (a.boxes) {
          const lines = ids.flatMap((id) => treeText(b, id, 20).split("\n")).map((l) => l.replace(/#([a-z0-9]+) /, (m, x: string) => (boxes[x] ? `${m}[${boxes[x].x},${boxes[x].y} ${boxes[x].width}×${boxes[x].height}] ` : m)));
          out.push(text(lines.join("\n")));
        }
        return out;
      }),
  );

  server.registerTool(
    "board_export",
    {
      title: "Export layers as images",
      description: "Save layers (usually artboards) as PNG or JPEG files, at 1×, 2× or 3×. Returns the files. Default: every artboard on the first page, in a folder named after the board.",
      inputSchema: {
        board: BoardRef,
        nodes: z.array(z.string()).optional(),
        page: z.string().optional(),
        scale: z.number().min(0.5).max(4).optional().describe("Default 2."),
        format: z.enum(["png", "jpeg"]).optional(),
        output: z.string().optional().describe("A folder. Default: <output>/boards/<board name>/."),
      },
    },
    (a) =>
      guard(async () => {
        const b = findBoard(a.board);
        const page = a.page ? b.pages.find((p) => p.id === a.page) : b.pages[0];
        const ids = a.nodes?.length ? a.nodes : page?.children ?? [];
        if (!ids.length) throw new Error("Nothing to export: the page is empty.");
        const format = a.format ?? "png";
        const { images } = await drawLayers(b, ids, { scale: a.scale ?? 2, format, transparent: format === "png" });
        const folder = a.output ? path.resolve(a.output) : path.join(outputRoot(), "boards", slug(b.name) || b.id);
        mkdirSync(folder, { recursive: true });
        const files: string[] = [];
        ids.forEach((id, i) => {
          if (!images[id]) return;
          const f = path.join(folder, `${String(i + 1).padStart(2, "0")} ${b.nodes[id].name.replace(/[/:\\]/g, "-")}.${format === "jpeg" ? "jpg" : "png"}`);
          writeFileSync(f, images[id]);
          files.push(f);
        });
        return [text({ files })];
      }),
  );

  server.registerTool(
    "board_done",
    {
      title: "Finish working on a board",
      description: "Call when you've finished with a board, so the person's canvas stops showing you at work on its artboards.",
      inputSchema: { board: BoardRef, artboards: z.array(z.string()).optional().describe("Only these artboards. Default: all.") },
    },
    (a) =>
      guard(async () => {
        const b = findBoard(a.board);
        changeBoard(b.id, [{ op: "working", ids: a.artboards, at: null }], "agent");
        return [text("Done.")];
      }),
  );

  server.registerTool(
    "board_comments",
    {
      title: "Read comments on boards",
      description:
        "The user's comments on boards: threads pinned to a layer or to a region of an artboard, each with what it's on (layer names and ids), its messages (from the user, you or another agent) and whether it's waiting on you. Default: the open threads addressed to you (or that you answered), on every board. A comment for you also arrives as a message from Screenshotter; answer it with board_comment.",
      inputSchema: {
        board: BoardRef.optional().describe("Only this board. Default: every board."),
        all: z.boolean().optional().describe("Every thread, not only those addressed to you."),
        resolved: z.boolean().optional().describe("Include resolved threads. Default false."),
      },
    },
    (a) =>
      guard(async () => {
        const me = await whoAmI();
        const boards = a.board ? [findBoard(a.board)] : listBoards().map((s) => getBoard(s.id));
        const out = [];
        for (const b of boards) {
          const mine = keysOf(b, me);
          const threads = getComments(b.id).threads.filter((t) => (a.resolved || !t.resolved) && (a.all || t.messages.some((m) => mine.has(m.by) || m.to?.some((k) => mine.has(k)))));
          if (threads.length) out.push({ board: b.id, name: b.name, threads: threads.map((t) => threadForAgent(b, t, mine)) });
        }
        return [text(out.length ? out : a.all ? "No comments." : "No open comments for you (all: true lists everyone's).")];
      }),
  );

  server.registerTool(
    "board_comment",
    {
      title: "Answer a comment on a board",
      description:
        "Reply in a comment's thread (the user sees it on the board in the Studio, by the comment), or start a thread of your own on a layer to point something out or ask about it. Only the user resolves comments. This only talks about the design: change it with board_edit or board_write_html first, then say what you did.",
      inputSchema: {
        board: BoardRef,
        comment: z.string().optional().describe("The comment's id (from the message you got, or board_comments)."),
        reply: z.string().max(8000).optional().describe("What to say in the thread."),
        on: z.string().optional().describe("Instead of `comment`: a layer's id, to start a new thread on it (its words in `reply`)."),
      },
    },
    (a) =>
      guard(async () => {
        const b = findBoard(a.board);
        const me = await whoAmI();
        // Whoever answers is one of the board's agents, so the person can write back to it.
        changeBoard(b.id, workingOps(b, [], me), "agent");
        const by = { by: me.key, name: me.name };
        if (a.on) {
          if (!a.reply?.trim()) throw new Error("Say what the new comment is about in `reply`.");
          const made = startThread(b.id, { layer: a.on }, { ...by, text: a.reply });
          return [text({ comment: made.thread.id, on: describeAnchor(getBoard(b.id), made.thread.anchor), note: "It's on the board in the Studio, by the layer." })];
        }
        if (!a.comment) throw new Error("Give the comment's id (`comment`), or a layer to start a thread on (`on`).");
        if (!a.reply?.trim()) throw new Error("Say something in `reply`. (Only the user resolves comments.)");
        const thread = reply(b.id, a.comment, { ...by, text: a.reply }).thread;
        return [text({ comment: a.comment, messages: thread.messages.length, note: "The user sees it on the board in the Studio, in the comment's thread, and resolves it when they're happy." })];
      }),
  );
}

