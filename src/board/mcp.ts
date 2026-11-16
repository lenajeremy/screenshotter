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
import { outputRoot, resolveUserPath, slug } from "../util/files.js";
import {
  applyOps,
  expandOps,
  renameTokenOps,
  tokenName,
  addHtmlOps,
  canHold,
  flattenSvgOps,
  inlineHtml,
  inlineSvgStyles,
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
  maskOps,
  maskGroupOps,
  inFlow,
  isFlex,
  isGrid,
  cssValue,
  freeSpot,
  newId,
  nodeHtml,
  pageOf,
  pxValue,
  rootOf,
  scaleOps,
  siblingsOf,
  sizeWord,
  treeText,
  type Board,
  type Op,
  type AgentTouch,
} from "./core.js";
import { drawLayers } from "./render.js";
import { deviceImage } from "./device.js";
import { builtinSvg, stickerNames, artNames } from "../render/images.js";
import { SHAPE_TYPES, shapeInBox } from "../render/shapes.js";
import { cacheDir } from "../util/files.js";
import { htmlToNodes, normalizeGridStyle, type BoardNode } from "./core.js";
import { cssWithPhotos, isUnsplash, placePhotos, unsplashPicture } from "./photos.js";
import { adoptCssPictures, adoptImage, adoptImages, changeBoard, createBoard, findBoard, getBoard, listBoards, scratchPage, summarizeBoard } from "./store.js";
import { addVideoStills } from "./video.js";
import { whoAmI, type AgentIdentity } from "./agentman.js";
import { importWebsite } from "./web-import.js";
import { describeAnchor, getComments, keysOf, reply, sentOnly, startThread, threadForAgent } from "./comments.js";
import { SHADER_PRESETS, cleanShaderCode, cleanShaderParams, cleanShaderSpec, parseShaderParams, presetOf, shaderCatalog, shaderCode, shaderKey, shaderPresetName, shaderUsers, shaderValues, type ShaderSpec } from "./core.js";
import { compileShaders, errorWords } from "./shader-check.js";

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
- Only inline styles count (style="…"): no classes, no <style> blocks, no scripts. Lay out with flexbox for one direction (a row of buttons, a stack of sections: display:flex, flex-direction, gap, padding, align-items) and CSS grid for two (cards in rows and columns, galleries, dashboards, bento layouts, a sidebar beside the main column, a form's labels and fields lined up): display:grid with grid-template-columns (repeat(3, 1fr); 240px 1fr; repeat(auto-fill, minmax(200px, 1fr)) for cards that wrap), gap, and on a child grid-column / grid-row (span 2, 1 / -1, 2 / span 3) or grid-template-areas with grid-area names. Grids are first-class: the person edits their tracks, gaps and cells in the panel and on the canvas, and board_read's tree describes them; shorthands (grid, grid-template, grid-area with slashes, place-*) are kept as their longhands. Elements that flow as blocks become flex columns. Words go in text elements (p, h1–h6, span); <img src> takes a file path or URL; inline <svg> for icons.
- The scratchpad: the person keeps one board, "scratchpad", for trying things out. When they say to use their scratchpad (or it's a quick experiment, not a design to keep), call board_create with scratchpad: true: it adds a page named for the try to the scratchpad instead of making a board. Pass that page's id as \`page\` when you write artboards.
- board_edit changes layers in place (styles, words, names, order, duplicates, deletes, tokens, scale: a layer bigger or smaller with its type and spacing) without rewriting them; board_read shows the layer tree with ids (tree), the HTML (html) or the tokens.
- Look before you call it done: board_screenshot an artboard (or one layer) after each meaningful change. Fix overflow and alignment it shows. When you've finished, call board_done.
- Inline <svg> comes in as a vector layer with a layer for each part (groups, rects, circles, paths, lines, words), each with its SVG attributes; board_read tree lists them. board_edit vector sets a part's attributes (fill, stroke, d, cx…), text retypes an SVG <text>, and board_write_html with an svg layer (or a group in one) as the target adds SVG elements to it. split and flatten turn a vector drawn as one piece into parts and back.
- An existing website: board_import_website brings a page onto a board as an artboard of ordinary layers (its layout, words, pictures and fonts, read as the browser draws it at the width you give), ready to change with board_edit like anything else. Use it to redesign or extend a real site from where it is, rather than rebuilding it by hand.
- Tokens (board_edit token; rename renames one everywhere it's used) are CSS custom properties every layer can use as var(--name): set colours, radii and spacing once and use them everywhere.
- Repeated pieces (a button, a list row, a card): build one, make it a component (board_edit component), and place copies of it (board_edit copy). Change the component to change them all; change a copy's words or colours for that copy alone.
- Masks, as in Figma: a layer used as a mask isn't drawn; the layers above it in its frame (after it, up to the next mask) show only where it is. Write one with data-mask on the element, at the back, with the layers to mask after it: <div style="position:relative;width:320px;height:320px"><div data-mask style="position:absolute;left:0;top:0;width:320px;height:320px;border-radius:50%;background:#000"></div><img style="position:absolute;left:0;top:0;width:320px;height:320px;object-fit:cover" src="…"></div>. Any layer can be the mask: a frame (its corners and fills: a gradient to transparent fades what's above it), a picture (its see-through parts), an svg, or words (the photo shows through the letters). data-mask="vector" masks by its outline, data-mask="luminance" by its brightness (white shows, black hides); plain data-mask is alpha. A mask and what it masks are placed by hand (position:absolute, left, top, width, height): in a flex or grid frame they go in a frame of their own (a mask group), which is one item of the layout. board_edit mask makes one from existing layers (several ids: a new mask group, the one at the back masking the rest), changes its type, or removes it; board_read tree marks masks and what each masks; hiding a mask shows its layers whole.
- Video: <video src="/path/to/clip.mp4" autoplay loop muted style="width:…;height:…"> puts in a video layer (MP4, MOV or WebM; the attributes are how it plays in Preview, as HTML has them). Like Figma, the canvas shows its first frame until the person presses play, and board_screenshot and exports show that frame too. The person's screen recordings and exported videos are in Screenshotter's library folder (recordings/ and videos/). board_edit image with a video file replaces a video layer's video.
- Real photos: <img src="unsplash:ramen bowl"> (or a CSS background of url(unsplash:skatepark)) puts in the top free Unsplash photo for those words, shaped to the layer; "unsplash:ramen bowl#2" takes the second. It searches with the key the person saved in Screenshotter's Settings › Photos, and the result names each photo's photographer: credit them where the design is shown.
- Screenshotter's own assets work here too: <img src="sticker:heart"> or "art:squiggle" (list_mockup_options names them) for its stickers and illustrations; board_edit shape for its arrows, badges, laurels and ratings; board_edit device to show a screenshot, or one of the board's artboards, in Apple's device frame. Blur and filters are CSS (filter, backdrop-filter).
- Shaders: live graphics drawn by the GPU (WebGL fragment shaders), as a frame's fill: a moving hero backdrop, a texture, or a finish laid over a picture. Any frame can have one, drawn over its CSS fills and behind its layers, so a shader frame lays out like any frame (a grid cell, an item in a stack) and holds words and pictures over its shader. Built-in presets: ${SHADER_PRESETS.map((p) => p.id).join(", ")} (film-grain is see-through: as a fill it blends as Overlay with the frame's fills under it, a photo say). In HTML: <section data-shader="aurora" data-params='{"intensity":1.3}' style="display:flex;flex-direction:column;justify-content:center;padding:64px;height:560px;border-radius:24px"><h1 style="color:#fff">…</h1></section>, or one with nothing in it as a layer of its own (<div data-shader="mesh-gradient" style="width:400px;height:300px"></div>; <canvas data-shader="…"> works too); data-blend="overlay" mixes it with the frame's own fills. board_edit { do: "shader", id: aFrame, preset: "mesh-gradient", params: { color1: "var(--brand)", warp: 1.2 } } gives a frame one (or changes it; remove: true takes it away); without id it adds a new frame with one (into, width, height). board_read what "shaders" lists every preset's params (numbers with their ranges, colours, choices). It plays on the canvas and in Preview; board_screenshot and exports show it frozen at its time (time / data-time, in seconds): pick a moment that looks good. Writing your own: board_edit { do: "shader", code } or <canvas data-shader="custom"><script type="x-shader/x-fragment">…</script></canvas>. It's GLSL ES 1.00 (or "#version 300 es" first): a main() that sets gl_FragColor (Shadertoy's mainImage, iTime and iResolution work too), given uniform float uTime (seconds), vec2 uRes (the size drawn, in pixels) and float uPx (pixels per design pixel: gl_FragCoord.xy / uPx is in the design's px); precision is set for you. Declare each parameter as a uniform with a comment and the person gets a slider, a colour picker (with the board's tokens) or a choice for it: "uniform float uWarp; // @param 0..2 = 1", "uniform float uSpacing; // @param 4..40 = 12 px" (a length in design px, given to you in drawn px), "uniform vec3 uTint; // @color = #ff5a1f", "uniform int uMode; // @choice soft|hard = soft"; its key in params is its name without the u (warp, tint). Your code is compiled as you write it and errors come back with their line numbers: fix them and send the code again (until then the layer shows the error). savePreset keeps a good one on the board to place again by name. Keep shaders light (a few noise octaves, short loops): one too slow to play is stopped at its still and says so.
- Comments: the person pins comments to layers or regions of a board and sends them to the agents that worked on it. One for you arrives as a message starting "(From Screenshotter)", with the board's and the comment's ids and the layers it's on. The person usually sends several at once, as one numbered list: make every change it asks for with the tools above, then answer each in its thread (board_comment's \`replies\` answers them all in one call); the person sees your reply by the comment and resolves it when they're happy. board_comments lists the open ones for you.`;

const BoardRef = z.string().describe("The board's id (from board_list or board_create) or its name; \"scratchpad\" is the person's scratchpad.");

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
/**
 * The agent at work: the artboards it's on (they glow in the Studio), and what it just did, for its
 * cursor there (`doing`, with the layers it touched; a look leaves the artboards it wrote to alone).
 */
function workingOps(b: Board, ids: string[], me: AgentIdentity, doing: AgentTouch["doing"] = "edit"): Op[] {
  const there = ids.filter((id) => b.nodes[id]);
  const roots = [...new Set(there.map((id) => rootOf(b, id)))];
  const at = new Date().toISOString();
  const looking = doing === "look" || doing === "read";
  const touch = there.length ? { touch: { ids: there.slice(0, 40), doing } } : {};
  return [...(roots.length && !looking ? [{ op: "working" as const, ids: roots, at }] : []), { op: "agent", agent: me, artboards: looking ? [] : roots, at, ...touch }];
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
  z.object({
    do: z.literal("scale"),
    ids: z.array(z.string()).min(1).describe("Layers to scale, each with everything in it."),
    by: z.number().positive().max(20).describe("How much: 1.5 is half as big again, 0.5 half the size."),
  }),
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
  z.object({ do: z.literal("image"), id: z.string(), src: z.string().describe('A file path or URL for the image layer, or "unsplash:<words>" for the top free Unsplash photo ("#2" for the second). On a video layer: a video file (MP4, MOV or WebM).') }),
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
  z.object({
    do: z.literal("token"),
    name: z.string().describe('A CSS custom property name ("--brand" or "brand").'),
    value: z.string().nullable().optional().describe("Its value, or null to remove it."),
    rename: z.string().optional().describe("A new name for it: every var() that uses it, on every layer and token, is changed to the new name."),
  }),
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
  z.object({
    do: z.literal("mask"),
    ids: z.array(z.string()).min(1).describe("One layer: it becomes a mask of the layers above it (after it) in its frame. Several side by side in one frame: they go into a new mask group, the one at the back masking the rest."),
    type: z.enum(["alpha", "vector", "luminance"]).optional().describe("alpha (default): by its opacity, so a gradient to transparent fades what it masks; vector: by its outline; luminance: by its brightness (white shows, black hides)."),
    remove: z.boolean().optional().describe("Make the masks ordinary layers again (what they hid shows)."),
  }),
  z.object({
    do: z.literal("shader"),
    id: z.string().optional().describe("A frame to give a shader fill, or whose shader to change. Without it, a new frame with a shader is added (where into/before/after or x/y say, width × height)."),
    remove: z.boolean().optional().describe("Take the frame's shader away (its fills and layers stay)."),
    blend: z.enum(["normal", "multiply", "screen", "overlay", "darken", "lighten", "color-dodge", "color-burn", "hard-light", "soft-light", "difference", "exclusion", "hue", "saturation", "color", "luminosity"]).optional().describe("How the shader mixes with the frame's fills under it: overlay lays grain over a photo fill. Normal by default."),
    preset: z.string().optional().describe(`A built-in preset (${SHADER_PRESETS.map((p) => p.id).join(", ")}) or one of the board's own; board_read what "shaders" lists their params.`),
    code: z.string().max(20_000).optional().describe("GLSL fragment shader code of its own (see the instructions: uTime, uRes, uPx, and // @param, @color, @choice comments for parameters)."),
    params: z.record(z.string(), z.union([z.string(), z.number(), z.null()])).optional().describe('Parameter values by key: numbers, colours (#hex, rgb(), a name, var(--token)), choices by their word. null puts one back to its default.'),
    speed: z.number().min(-10).max(10).optional().describe("1 as made, 0.5 half as fast, 0 still."),
    time: z.number().min(-100_000).max(100_000).optional().describe("The moment (seconds) pictures of the board show, and the canvas while paused."),
    paused: z.boolean().optional().describe("Show its still instead of playing."),
    savePreset: z.string().optional().describe("Also save its code as one of the board's own presets by this name (place it again with preset)."),
    deletePreset: z.string().optional().describe("Remove one of the board's own presets (alone in a change; layers using it keep its code)."),
    width: z.number().positive().optional().describe("A new layer's width in px. Default 400."),
    height: z.number().positive().optional().describe("A new layer's height in px. Default 300."),
    into: z.string().optional().describe('A frame to put a new one in, or "page".'),
    before: z.string().optional(),
    after: z.string().optional(),
    index: z.number().int().min(0).optional(),
    x: z.number().optional().describe("Left edge: on the page, or inside a frame laid out by hand."),
    y: z.number().optional(),
    name: z.string().optional(),
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

type ShaderChange = Extract<z.infer<typeof ChangeSchema>, { do: "shader" }>;

/**
 * board_edit's shader change: a frame given a shader fill (a new frame, or one there), a change to
 * one (its preset, code, params, speed, time, paused, blend), the shader taken away, or one of the
 * board's own presets saved or removed. Its own code is compiled where
 * it will run, and errors come back by line.
 */
async function shaderChange(b: Board, c: ShaderChange, ops: Op[], need: (id: string) => BoardNode, touched: string[]): Promise<Record<string, unknown>> {
  if (c.deletePreset !== undefined) {
    const name = shaderPresetName(c.deletePreset);
    if (!b.shaders?.some((s) => s.name === name)) throw new Error(`There's no shader preset "${name}" on this board${b.shaders?.length ? ` (it has ${b.shaders.map((s) => s.name).join(", ")})` : ""}.`);
    const users = shaderUsers(b, name);
    // The layers using it keep drawing the same: its code goes with each.
    for (const id of users) ops.push({ op: "set", id, shader: { ...b.nodes[id].shader, code: shaderCode(b.nodes[id].shader, b.shaders) } });
    ops.push({ op: "shaderPreset", name, code: null });
    return { deletedPreset: name, layersKeepItsCode: users };
  }
  const n = c.id ? need(c.id) : undefined;
  if (n && n.type !== "frame") throw new Error(`Only frames take a shader fill; ${n.name} is ${n.type === "text" ? "text" : n.type === "image" ? "a picture" : n.type === "video" ? "a video" : "a vector"}. Give its frame the shader, or leave out id to add a new one.`);
  if (c.remove) {
    if (!n) throw new Error("remove takes the shader from a frame: name it with id.");
    if (!n.shader) throw new Error(`${n.name} has no shader to remove.`);
    ops.push({ op: "set", id: n.id, shader: null });
    touched.push(n.id);
    return { removedShader: n.id };
  }
  const was: ShaderSpec = n?.shader ?? {};
  let spec: ShaderSpec = { ...was };
  if (c.preset !== undefined) {
    const p = shaderPresetName(c.preset);
    if (!presetOf(p) && !b.shaders?.some((s) => s.name === p)) throw new Error(`There's no shader preset "${c.preset}". Built in: ${SHADER_PRESETS.map((x) => x.id).join(", ")}${b.shaders?.length ? `; this board's own: ${b.shaders.map((s) => s.name).join(", ")}` : ""}.`);
    spec = { ...spec, preset: p };
    delete spec.code;
    // A preset given to a frame brings how it blends (film grain: Overlay), unless that's said too.
    if (presetOf(p)?.blend && c.blend === undefined && !was.preset) spec.blend = presetOf(p)!.blend;
  }
  if (c.code !== undefined) {
    spec = { ...spec, code: cleanShaderCode(c.code) };
    if (c.preset === undefined) delete spec.preset;
  }
  if (!spec.preset && !spec.code) spec.preset = SHADER_PRESETS[0].id;
  const code = shaderCode(spec, b.shaders) ?? "";
  const declared = parseShaderParams(code);
  const warnings: string[] = [];
  // Values the code still has a parameter for are kept; new ones are made safe; null resets one.
  const sameCode = code === (shaderCode(was, b.shaders) ?? "");
  const params: Record<string, number | string> = {};
  for (const [k, v] of Object.entries(was.params ?? {})) if (sameCode || declared.params.some((p) => p.key === k)) params[k] = v;
  for (const [k, v] of Object.entries(c.params ?? {})) if (v === null) delete params[shaderKey(k)];
  Object.assign(params, cleanShaderParams(code, Object.fromEntries(Object.entries(c.params ?? {}).filter(([, v]) => v !== null)), warnings));
  spec.params = params;
  if (c.speed !== undefined) spec.speed = c.speed;
  if (c.time !== undefined) spec.time = c.time;
  if (c.paused !== undefined) spec.paused = c.paused;
  if (c.blend !== undefined) spec.blend = c.blend;
  spec = cleanShaderSpec(spec);
  // Its own code (or one of the board's presets) is compiled where it will run; the built-in ones are known good.
  const own = !presetOf(spec.preset) || Boolean(b.shaders?.some((s) => s.name === spec.preset));
  let errors: string[] | undefined;
  if (own && code) {
    warnings.push(...declared.warnings);
    const got = await compileShaders([code]);
    if ("unavailable" in got) warnings.push(`It couldn't be compiled here to check it (${got.unavailable}); the canvas shows any error.`);
    else if (got.get(code)?.length) errors = errorWords(got.get(code)!);
  }
  if (c.savePreset) {
    const slug = shaderPresetName(c.savePreset);
    ops.push({ op: "shaderPreset", name: slug, code });
    spec = { ...spec, preset: slug, code };
  }
  let id: string;
  if (n) {
    id = n.id;
    const size = { ...(c.width ? { width: `${c.width}px` } : {}), ...(c.height ? { height: `${c.height}px` } : {}) };
    ops.push({ op: "set", id, shader: spec, ...(c.name ? { name: c.name } : {}), ...(Object.keys(size).length ? { style: size } : {}) });
  } else {
    const where = placeFor(b, c, need);
    id = newId();
    const w = c.width ?? 400;
    const h = c.height ?? 300;
    const style: Record<string, string> = { width: `${w}px`, height: `${h}px`, flexShrink: "0", ...(presetOf(spec.preset)?.style ?? {}) };
    const holder = where.parent ? b.nodes[where.parent] : undefined;
    const laidOut = isFlex(holder) || isGrid(holder);
    if (!where.parent) Object.assign(style, { left: `${Math.round(c.x ?? freeSpot(b, where.page!, w).left)}px`, top: `${Math.round(c.y ?? 0)}px` });
    else if (!laidOut || c.x !== undefined || c.y !== undefined) {
      Object.assign(style, { position: "absolute", left: `${Math.round(c.x ?? 0)}px`, top: `${Math.round(c.y ?? 0)}px` });
      if (holder && !holder.style.position) ops.push({ op: "set", id: holder.id, style: { position: "relative" } });
    }
    // A layer of its own: a preset's look (film grain blended over what's below it) is its CSS.
    if (presetOf(spec.preset)?.style && c.blend === undefined) delete spec.blend;
    ops.push({ op: "add", nodes: { [id]: { id, type: "frame", name: c.name ?? presetOf(spec.preset)?.name ?? spec.preset ?? "Shader", parent: where.parent, shader: spec, style, children: [] } }, ids: [id], parent: where.parent, page: where.page, index: where.index });
  }
  touched.push(id);
  return {
    shader: id,
    preset: spec.preset ?? "custom",
    params: shaderValues(declared.params, spec.params),
    ...(errors ? { errors, fix: "It doesn't compile, so the layer shows this error on the canvas: fix the lines named and send the code again." } : {}),
    ...(warnings.length ? { warnings } : {}),
  };
}

/**
 * Shaders an agent wrote as HTML: their params made safe against what the shader declares,
 * and their own code compiled where it will run. Returns the ones that don't compile, with why.
 */
async function checkShaders(b: Board, nodes: Record<string, BoardNode>, warnings: string[]): Promise<Array<{ id: string; name: string; errors: string[] }>> {
  const list = Object.values(nodes).filter((n) => n.shader);
  const own: string[] = [];
  for (const n of list) {
    const code = shaderCode(n.shader, b.shaders);
    if (!code) {
      warnings.push(`The shader "${n.name}" has nothing to draw: "${n.shader?.preset ?? ""}" isn't a preset (${SHADER_PRESETS.map((p) => p.id).join(", ")}) and it has no code.`);
      continue;
    }
    const said: string[] = [];
    const params = cleanShaderParams(code, n.shader?.params ?? {}, said);
    n.shader = { ...n.shader, params };
    if (!Object.keys(params).length) delete n.shader.params;
    warnings.push(...said.map((w) => `"${n.name}": ${w}`));
    if (presetOf(n.shader.preset) && !b.shaders?.some((s) => s.name === n.shader?.preset)) continue;
    own.push(code);
    warnings.push(...parseShaderParams(code).warnings.map((w) => `"${n.name}": ${w}`));
  }
  if (!own.length) return [];
  const got = await compileShaders(own);
  if ("unavailable" in got) {
    warnings.push(`Shader code couldn't be compiled here to check it (${got.unavailable}); the canvas shows any error.`);
    return [];
  }
  const failing: Array<{ id: string; name: string; errors: string[] }> = [];
  for (const n of list) {
    const code = shaderCode(n.shader, b.shaders);
    const errs = code ? got.get(code) : undefined;
    if (errs?.length) failing.push({ id: n.id, name: n.name, errors: errorWords(errs) });
  }
  return failing;
}

export function registerBoardTools(server: McpServer) {
  server.registerTool(
    "board_list",
    {
      title: "List boards",
      description: "The boards in the person's Studio (designs made of HTML and CSS): their scratchpad first, then newest first, each with its pages and artboards (ids, names, sizes, positions).",
      inputSchema: {},
    },
    () => guard(async () => [text(listBoards().map(({ thumb: _t, ...b }) => b))]),
  );

  server.registerTool(
    "board_create",
    {
      title: "Make a board",
      description:
        "Make a new, empty board in the Studio (it appears under Boards, where the person can watch you work). Returns its id and its first page. Then add artboards with board_write_html. With scratchpad: true, it adds a new page to the person's scratchpad instead (one board that's always there for trying things out): use that when they ask you to use their scratchpad.",
      inputSchema: {
        name: z.string().max(120).describe("What it's for, e.g. \"Onboarding flow\" (with scratchpad, the new page's name)."),
        scratchpad: z.boolean().optional().describe("A new page on the person's scratchpad, not a new board."),
      },
    },
    (a) =>
      guard(async () => {
        if (a.scratchpad) {
          const { board, page } = scratchPage(a.name, "agent");
          changeBoard(board.id, workingOps(board, [], await whoAmI()), "agent");
          return [text({ id: board.id, name: board.name, page, note: `A new page on the scratchpad. Pass page: "${page.id}" to board_write_html (no target) for its artboards: without it they go on the first page.` })];
        }
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
        "Look inside a board. `what`: \"overview\" (default: pages, artboards with sizes, tokens), \"tree\" (an outline of a layer or every artboard on a page, with ids, sizes as written (320, fit, fill) and layout; `measure` adds the sizes they really came out at), \"html\" (a layer and what's in it as HTML with inline styles and data-id on every element), \"tokens\", or \"shaders\" (the shader presets, built in and the board's own, with their params).",
      inputSchema: {
        board: BoardRef,
        what: z.enum(["overview", "tree", "html", "tokens", "shaders"]).optional(),
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
          return [text({ id: b.id, name: b.name, rev: b.rev, pages: s.pages, tokens: b.tokens, ...(b.shaders?.length ? { shaderPresets: b.shaders.map((x) => x.name) } : {}), layers: s.layers, editedAt: b.updatedAt, lastEditBy: b.by })];
        }
        if (what === "tokens") return [text(b.tokens.length ? b.tokens : "No tokens yet. Add one with board_edit { do: \"token\", name, value }.")];
        if (what === "shaders") return [text(`Shader presets (board_edit { do: "shader", preset, params }, or <div data-shader="…" data-params='{…}'>). Each param: its range and default, or "colour", or its words.\n${shaderCatalog(b.shaders ?? [])}`)];
        if (what === "html") return [text(ids.map((id) => nodeHtml(b, id, { ids: true })).join("\n\n") || "The page is empty.")];
        let out = ids.map((id) => treeText(b, id, a.depth ?? 4)).join("\n\n") || "The page is empty.";
        if (a.measure && ids.length) {
          const { boxes } = await drawLayers(b, ids, { scale: 0.25 });
          // A grid also says the tracks it was drawn with, in px.
          const drawn = (v: string | undefined) => (v ?? "").replace(/\[[^\]]*\]\s*/g, "").replace(/(\d+(?:\.\d+)?)px/g, (_, n: string) => String(Math.round(Number(n) * 10) / 10)).trim();
          const tracks = (id: string) => (boxes[id].columns ? ` · drawn columns ${drawn(boxes[id].columns)} rows ${drawn(boxes[id].rows) || "none"}` : "");
          out = out.replace(/#([a-z0-9]+) /g, (m, id: string) => (boxes[id] ? `${m}[${boxes[id].x},${boxes[id].y} ${boxes[id].width}×${boxes[id].height}${tracks(id)}] ` : m));
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
            const got = el ? svgNodes(inlineSvgStyles(el), into, {}, "") : null;
            const kids = got ? got.nodes[got.id].children ?? [] : [];
            if (!got || !kids.length) throw new Error("Write SVG elements (rect, circle, path, g, text…) into a vector.");
            // Pictures (<image href>) are copied into the library, as an <img>'s are.
            const warnings: string[] = [];
            adoptImages(got.nodes, warnings);
            const nodes = { ...got.nodes };
            delete nodes[got.id];
            for (const k of kids) nodes[k] = { ...nodes[k], parent: into };
            const sibs = b.nodes[into].children ?? [];
            const at = mode === "inside" ? a.index : sibs.indexOf(t.id) + (mode === "after" ? 1 : 0);
            const ops: Op[] = [{ op: "add", nodes, ids: kids, parent: into, index: at }];
            if (got.nodes[got.id].defs) ops.push({ op: "set", id: rootSvg(b, into), defs: `${b.nodes[rootSvg(b, into)].defs ?? ""}${got.nodes[got.id].defs}` });
            if (mode === "replace") ops.push({ op: "delete", ids: [t.id] });
            const after = changeBoard(b.id, ops, "agent").board;
            changeBoard(b.id, workingOps(after, kids, await whoAmI(), "write"), "agent");
            return [text({ created: kids.map((id) => ({ id, name: after.nodes[id]?.name })), outline: kids.map((id) => treeText(after, id, 3)).join("\n"), warnings: warnings.length ? warnings : undefined })];
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
        await addVideoStills(made.nodes, made.warnings);
        const shaderErrors = await checkShaders(b, made.nodes, made.warnings);
        // New artboards go where asked, else to the right of the others.
        if (!parent) {
          const pid = page ?? b.pages[0].id;
          const was = mode === "replace" && a.target && !b.nodes[a.target]?.parent ? b.nodes[a.target] : undefined;
          // An artboard being replaced keeps its place; any other new one goes where asked, else beside the others.
          let { left, top } =
            a.x !== undefined || a.y !== undefined ? { left: a.x ?? 0, top: a.y ?? 0 } : was ? { left: pxValue(was.style.left) ?? 0, top: pxValue(was.style.top) ?? 0 } : freeSpot(b, pid, 0);
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
        changeBoard(b.id, workingOps(after, made.roots, await whoAmI(), "write"), "agent");
        for (const id of Object.keys(made.nodes)) {
          const m = after.nodes[id];
          if (m?.mask && !m.parent) made.warnings.push(`"${m.name}" has data-mask but sits on the page: a mask works inside a frame, at the back of the layers it masks.`);
          else if (m?.mask && inFlow(after, id)) made.warnings.push(`The mask "${m.name}" (#${id}) is placed by its frame's flex or grid layout, so where it is can't be told from its CSS: give it position:absolute with left, top, width and height (and the layers it masks too), or board_edit mask it with them to make a mask group.`);
        }
        changeBoard(b.id, workingOps(after, made.roots, await whoAmI(), "write"), "agent");
        const out: Content = [
          text({
            created: made.roots.map((id) => ({ id, name: after.nodes[id]?.name })),
            outline: made.roots.map((id) => treeText(after, id, 4)).join("\n\n"),
            photos: photos.length ? [...new Set(photos)] : undefined,
            shaderErrors: shaderErrors.length ? { layers: shaderErrors, fix: "These don't compile, so each shows its error on the canvas: fix the lines named and send the code again (board_edit { do: \"shader\", id, code })." } : undefined,
            warnings: made.warnings.length ? made.warnings : undefined,
          }),
        ];
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
        "Change a board in one go: a list of `changes`, applied together (the person can undo them as one step). Each is one of: style (set CSS on layers; null removes a property), text (a text layer's words, or an SVG <text>'s), vector (SVG attributes of a vector's parts: fill, stroke, d, cx…), scale (layers bigger or smaller with everything in them, type, padding, gaps, corners, borders and shadows too, as Figma's Scale tool does; style width/height only resizes the box; the top left stays put), split / flatten (a vector into a layer for each part, and back), rename, delete, duplicate (the copy goes right after the original; returns its id), move (into a frame or the page, or before/after a layer), visibility, lock, image (an image layer's picture), artboard (a new empty one, placed beside the others unless x/y), page (add a page, or rename/delete one by id), token (a CSS custom property for var(--name)), shape (one of Screenshotter's shapes, drawn to a box: arrows, stars, badges, laurels, ratings, ribbons…), device (a screenshot or one of the board's artboards in Apple's device frame, as a picture), component (make a frame a component), copy (a copy of a component, which follows it: change the component and every copy changes, except what was changed in that copy), detach (a copy becomes ordinary layers), reset (a copy matches its component again), mask (Figma's Use as mask: a layer masks the layers above it in its frame; several go into a mask group; remove undoes it), shader (a live GPU shader as a frame's fill: given to a frame with id, or a new frame with one; a preset or code of its own, or a change to its preset, code, params, speed, time, paused or blend; remove takes it away; its own code comes back compiled, errors by line). Layers inside a copy can be restyled, retyped or hidden, not added, moved or deleted. Returns what each change did.",
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
        let applied = 0;
        for (const c of a.changes) {
          switch (c.do) {
            case "style":
              for (const id of c.ids) need(id);
              for (const id of c.ids) {
                // Grid shorthands as longhands (one side of a line keeps the other side the layer has).
                const style = normalizeGridStyle(styleOf(c.style), b.nodes[id].style);
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
                adoptCssPictures(style, photoWarnings);
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
            case "scale": {
              for (const id of c.ids) need(id);
              // `b` already has this call's earlier changes (they're applied as each one is read).
              for (const id of c.ids) ops.push(...scaleOps(b, id, c.by));
              results.push({ scaled: c.ids.length, by: c.by });
              break;
            }
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
              if (n.type === "video") {
                // A new video: in the library, with its own first frame as its still.
                const got = adoptImage(c.src);
                if (got.warning) throw new Error(got.warning);
                const one: Record<string, BoardNode> = { [n.id]: { ...n, src: got.src, poster: undefined, style: { ...n.style } } };
                await addVideoStills(one);
                ops.push({ op: "set", id: c.id, src: got.src, poster: one[n.id].poster ?? null });
                touched.push(c.id);
                results.push({ video: c.id });
                break;
              }
              if (n.type !== "image") throw new Error(`${n.name} isn't an image or video layer.`);
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
              const style = { display: "flex", flexDirection: "column", backgroundColor: "#ffffff", overflow: "hidden", ...Object.fromEntries(Object.entries(normalizeGridStyle(styleOf(c.style ?? {}))).filter(([, v]) => v !== null)), width: `${c.width}px`, height: c.height === "fit-content" ? "fit-content" : `${c.height}px`, left: `${Math.round(spot.left)}px`, top: `${Math.round(spot.top)}px` } as Record<string, string>;
              ops.push({ op: "add", nodes: { [id]: { id, type: "frame", name: c.name, parent: null, style, children: [] } }, ids: [id], parent: null, page: pid });
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
              if (c.rename !== undefined) {
                ops.push(...renameTokenOps(b, c.name, c.rename));
                if (c.value !== undefined) ops.push({ op: "token", name: tokenName(c.rename), value: c.value });
                results.push({ token: tokenName(c.name), renamed: tokenName(c.rename) });
                break;
              }
              if (c.value === undefined) throw new Error(`Give the token ${tokenName(c.name)} a value (null removes it), or a new name with rename.`);
              ops.push({ op: "token", name: c.name, value: c.value });
              results.push({ token: tokenName(c.name), value: c.value });
              break;
            case "component":
              need(c.id);
              ops.push(...(c.remove ? uncomponentOps(b, c.id) : componentOps(b, c.id)));
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
              const img = await deviceImage(resolveUserPath(shot), { device: c.device, color: c.color });
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
            case "mask": {
              for (const id of c.ids) need(id);
              if (c.remove) {
                for (const id of c.ids) ops.push(...maskOps(b, id, null).ops);
                results.push({ unmasked: c.ids.length });
                break;
              }
              const made = c.ids.length > 1 ? maskGroupOps(b, c.ids, c.type ?? "alpha") : maskOps(b, c.ids[0], c.type ?? "alpha");
              ops.push(...made.ops);
              touched.push(...c.ids);
              // The one at the back is the mask.
              const order = siblingsOf(b, c.ids[0]);
              const mask = c.ids.slice().sort((x, y) => order.indexOf(x) - order.indexOf(y))[0];
              results.push({ mask, type: c.type ?? "alpha", ...(made.group ? { group: made.group } : {}) });
              break;
            }
            case "shader": {
              results.push(await shaderChange(b, c, ops, need, touched));
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
          // Later changes in the batch work from this one: a copy placed after its component was
          // restyled takes the new style, and layers made earlier in the batch can be found.
          if (ops.length > applied) {
            b = applyOps(b, expandOps(b, ops.slice(applied))).board;
            applied = ops.length;
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
        // Its cursor goes to what it's looking at.
        changeBoard(b.id, workingOps(b, ids, await whoAmI(), "look"), "agent");
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
        const boards = a.board ? [findBoard(a.board)] : listBoards().filter((s) => !s.damaged).map((s) => getBoard(s.id));
        const out = [];
        for (const b of boards) {
          const mine = keysOf(b, me);
          const threads = sentOnly(getComments(b.id)).threads.filter((t) => (a.resolved || !t.resolved) && (a.all || t.messages.some((m) => mine.has(m.by) || m.to?.some((k) => mine.has(k)))));
          if (threads.length) out.push({ board: b.id, name: b.name, threads: threads.map((t) => threadForAgent(b, t, mine)) });
        }
        return [text(out.length ? out : a.all ? "No comments." : "No open comments for you (all: true lists everyone's).")];
      }),
  );

  server.registerTool(
    "board_import_website",
    {
      title: "Bring a website onto a board",
      description:
        "Open a website and put it on a board as an artboard of ordinary layers: its layout (flex, grid, positions), words, pictures, vectors and fonts, as the browser draws it at `width` (its breakpoints follow). The pictures and fonts are copied onto the Mac, so it keeps working offline. Then change it with board_edit, board_write_html and the rest like any artboard. Leave out `board` to make a new board named after the site. Takes 5–40 seconds.",
      inputSchema: {
        url: z.string().describe("The page's address, e.g. example.com or https://example.com/pricing."),
        board: BoardRef.optional().describe("The board to put it on; left out, a new board named after the site."),
        page: z.string().optional().describe("The page of the board to put it on (its id); default the first."),
        width: z.number().int().min(320).max(2560).optional().describe("The window width to read it at: 1440 desktop (default), 834 tablet, 390 phone."),
        fullPage: z.boolean().optional().describe("The whole page (default), or false for just the first screen."),
      },
    },
    (a) =>
      guard(async () => {
        const b = a.board ? findBoard(a.board) : null;
        const me = await whoAmI();
        const r = await importWebsite(b?.id ?? null, { url: a.url, width: a.width, fullPage: a.fullPage, page: a.page }, "agent");
        changeBoard(r.board, workingOps(getBoard(r.board), [r.artboard], me, "import"), "agent");
        return [text({ ...r, note: `It's on the board as the artboard ${r.artboard}. board_read it (tree) to find the layers, board_screenshot it to see it.` })];
      }),
  );

  server.registerTool(
    "board_comment",
    {
      title: "Answer a comment on a board",
      description:
        "Reply in a comment's thread (the user sees it on the board in the Studio, by the comment), or start a thread of your own on a layer to point something out or ask about it. When the user sent several comments at once, `replies` answers them all in one call. Only the user resolves comments. This only talks about the design: change it with board_edit or board_write_html first, then say what you did.",
      inputSchema: {
        board: BoardRef,
        comment: z.string().optional().describe("The comment's id (from the message you got, or board_comments)."),
        reply: z.string().max(8000).optional().describe("What to say in the thread."),
        on: z.string().optional().describe("Instead of `comment`: a layer's id, to start a new thread on it (its words in `reply`)."),
        replies: z
          .array(z.object({ comment: z.string(), reply: z.string().max(8000) }))
          .max(60)
          .optional()
          .describe("Instead of `comment` and `reply`: an answer for each of several comments (the user sent them together)."),
      },
    },
    (a) =>
      guard(async () => {
        const b = findBoard(a.board);
        const me = await whoAmI();
        // Whoever answers is one of the board's agents, so the person can write back to it.
        changeBoard(b.id, workingOps(b, [], me), "agent");
        const by = { by: me.key, name: me.name };
        if (a.replies?.length) {
          if (a.comment || a.on) throw new Error("Use `replies` on its own, or `comment` and `reply` for one comment.");
          const done: string[] = [];
          const failed: { comment: string; error: string }[] = [];
          for (const r of a.replies) {
            try {
              if (!r.reply.trim()) throw new Error("Say something in its `reply`.");
              reply(b.id, r.comment, { ...by, text: r.reply });
              done.push(r.comment);
            } catch (e) {
              failed.push({ comment: r.comment, error: (e as Error).message });
            }
          }
          if (!done.length) throw new Error(failed.map((f) => `${f.comment}: ${f.error}`).join(" "));
          return [text({ answered: done, ...(failed.length ? { failed } : {}), note: "The user sees each answer by its comment in the Studio, and resolves it when they're happy." })];
        }
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

