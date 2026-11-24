// Figma's own data (as a .fig file and the clipboard hold it) drawn as layers, checked by pixel.
// What Figma puts on the clipboard has no outlines for its shapes and points to shared styles by
// key: this builds a small document like that by hand (a speech bubble made by joining a rounded
// rectangle and a triangle, with an inside stroke in a shared colour; a name in two styles; an
// arrow), draws it, and looks at the pixels. No Figma file, token or network needed.
//
//   npx tsx scripts/fig-test.ts        (UI_SHOTS=<folder> keeps the picture)
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { copiedRoots, figDoc, newCtx, nodeHtml, placeOf, resolveTree } from "../src/board/fig-convert.js";
import { synthesizeFigFonts } from "../src/board/fig-fonts.js";
import { decodeNetwork, networkOutline, rectOutline } from "../src/board/fig-geometry.js";
import { loadPathKit } from "../src/board/pathkit.js";
import { closeBrowser, newPage } from "../src/render/browser.js";
import { useLibrary } from "../src/util/files.js";
import { decodePng, pixelAt } from "../src/util/png.js";

let failed = 0;
const check = (ok: unknown, what: string) => {
  console.log(`${ok ? "PASS" : "FAIL"} ${what}`);
  if (!ok) failed++;
};

// A vector network blob as Figma writes one (see fig-geometry's decodeNetwork).
function network(v: Array<[number, number, number?]>, s: Array<[number, number, [number, number]?, [number, number]?]>, loops: number[][]): Uint8Array {
  const words: Array<["u" | "f", number]> = [["u", v.length], ["u", s.length], ["u", loops.length ? 1 : 0]];
  for (const [x, y, style] of v) words.push(["u", style ?? 0], ["f", x], ["f", y]);
  for (const [a, b, ta, tb] of s) words.push(["u", 0], ["u", a], ["f", ta?.[0] ?? 0], ["f", ta?.[1] ?? 0], ["u", b], ["f", tb?.[0] ?? 0], ["f", tb?.[1] ?? 0]);
  if (loops.length) {
    words.push(["u", 1], ["u", loops.length]);
    for (const l of loops) words.push(["u", l.length], ...l.map((i): ["u", number] => ["u", i]));
  }
  const buf = Buffer.alloc(words.length * 4);
  words.forEach(([t, x], i) => (t === "u" ? buf.writeUInt32LE(x, i * 4) : buf.writeFloatLE(x, i * 4)));
  return new Uint8Array(buf);
}
// Figma's stored path commands (1 move, 2 line, 0 close; float32 points).
function commands(polys: Array<Array<[number, number]>>): Uint8Array {
  const parts: Buffer[] = [];
  for (const poly of polys) {
    poly.forEach(([x, y], i) => {
      const b = Buffer.alloc(9);
      b[0] = i ? 2 : 1;
      b.writeFloatLE(x, 1);
      b.writeFloatLE(y, 5);
      parts.push(b);
    });
    parts.push(Buffer.from([0]));
  }
  return new Uint8Array(Buffer.concat(parts));
}

const C = (r: number, g: number, b: number) => ({ r: r / 255, g: g / 255, b: b / 255, a: 1 });
const solid = (c: ReturnType<typeof C>) => [{ type: "SOLID", color: c, opacity: 1, visible: true }];
const T = (x: number, y: number, flip = false) => (flip ? { m00: -1, m01: 0, m02: x, m10: 0, m11: -1, m12: y } : { m00: 1, m01: 0, m02: x, m10: 0, m11: 1, m12: y });
const G = (n: number) => ({ sessionID: 1, localID: n });
const at = (parent: number, position: string) => ({ guid: G(parent), position });
const GREEN = C(185, 255, 102);
const DARK = C(25, 26, 35);
const green = { assetRef: { key: "green-style-key", version: "1:1" } };

const blobs = [
  // 0: the bubble's rectangle, its bottom edge stored as a straight curve (as Figma does).
  network([[0, 0], [200, 0], [200, 100], [0, 100]], [[0, 1], [1, 2], [2, 3, [-60, 0], [60, 0]], [3, 0]], [[0, 1, 2, 3]]),
  // 1: an arrow: a line with an arrow cap at its end (vertex style 1).
  network([[0, 0, 2], [100, 0, 1]], [[0, 1]], []),
  // 2, 3: a box with the outlines Figma stored: its square, and its inside stroke as Figma keeps it
  // (a centred band twice the stroke's width, cut to the shape when drawn).
  commands([[[0, 0], [40, 0], [40, 40], [0, 40]]]),
  commands([[[-4, -4], [44, -4], [44, 44], [-4, 44]], [[4, 4], [4, 36], [36, 36], [36, 4]]]),
];
const nodeChanges = [
  { guid: G(0), type: "DOCUMENT", name: "Document" },
  { guid: G(1), type: "CANVAS", name: "Page 1", parentIndex: at(0, "a") },
  { guid: G(2), type: "CANVAS", name: "Internal Only Canvas", internalOnly: true, parentIndex: at(0, "b") },
  { guid: G(3), type: "ROUNDED_RECTANGLE", name: "Green", styleType: "FILL", key: "green-style-key", fillPaints: solid(GREEN), size: { x: 10, y: 10 }, parentIndex: at(2, "a") },
  { guid: G(10), type: "FRAME", name: "Card", size: { x: 320, y: 220 }, transform: T(0, 0), fillPaints: solid(DARK), frameMaskDisabled: false, parentIndex: at(1, "a") },
  // The bubble: a union with no outline stored, its stroke's colour a shared style (by key).
  { guid: G(11), type: "BOOLEAN_OPERATION", name: "Bubble", booleanOperation: "UNION", size: { x: 200, y: 120 }, transform: T(20, 20), fillPaints: solid(DARK), strokePaints: solid(C(255, 255, 255)), styleIdForStrokeFill: green, strokeWeight: 2, strokeAlign: "INSIDE", strokeJoin: "MITER", parentIndex: at(10, "a") },
  { guid: G(12), type: "VECTOR", name: "Rectangle", size: { x: 200, y: 100 }, transform: T(0, 0), cornerRadius: 20, fillPaints: solid(C(255, 0, 0)), strokePaints: solid(C(255, 0, 0)), strokeWeight: 2, vectorData: { vectorNetworkBlob: 0, normalizedSize: { x: 200, y: 100 } }, parentIndex: at(11, "a") },
  // The tail: a triangle turned upside down, reaching 10px into the rectangle.
  { guid: G(13), type: "REGULAR_POLYGON", name: "Tail", count: 3, size: { x: 40, y: 30 }, transform: T(70, 120, true), fillPaints: solid(C(255, 0, 0)), parentIndex: at(11, "b") },
  // A name over a role: the first line green by a shared style (by key), each line its own height.
  {
    guid: G(20), type: "TEXT", name: "Name", size: { x: 120, y: 41 }, transform: T(30, 160), fillPaints: solid(C(255, 255, 255)), fontSize: 16, fontName: { family: "Helvetica", style: "Regular" }, lineHeight: { value: 100, units: "PERCENT" }, textAutoResize: "WIDTH_AND_HEIGHT",
    textData: { characters: "John\nRole here", characterStyleIDs: [4, 4, 4, 4, 4], styleOverrideTable: [{ styleID: 4, styleIdForFill: green, fontSize: 18 }] },
    derivedTextData: { baselines: [{ lineY: 0, lineHeight: 22, lineAscent: 17, firstCharacter: 0, endCharacter: 5 }, { lineY: 22, lineHeight: 19, lineAscent: 15, firstCharacter: 5, endCharacter: 14 }] },
    parentIndex: at(10, "b"),
  },
  // An arrow: its cap from its end point's own style.
  { guid: G(30), type: "VECTOR", name: "Arrow", size: { x: 40, y: 0 }, transform: T(250, 60), strokePaints: solid(C(255, 255, 255)), strokeWeight: 3, strokeAlign: "INSIDE", strokeJoin: "MITER", vectorData: { vectorNetworkBlob: 1, normalizedSize: { x: 100, y: 0 }, styleOverrideTable: [{ styleID: 1, strokeCap: "ARROW_LINES" }, { styleID: 2, strokeCap: "ROUND" }] }, parentIndex: at(10, "c") },
  // A box with stored outlines and an inside stroke.
  { guid: G(40), type: "VECTOR", name: "Box", size: { x: 40, y: 40 }, transform: T(250, 140), fillPaints: solid(C(60, 60, 70)), strokePaints: solid(GREEN), strokeWeight: 4, strokeAlign: "INSIDE", fillGeometry: [{ windingRule: "NONZERO", commandsBlob: 2 }], strokeGeometry: [{ windingRule: "NONZERO", commandsBlob: 3 }], parentIndex: at(10, "d") },
];

// The geometry on its own.
const net = decodeNetwork(Buffer.from(blobs[0]));
check(net?.v.length === 4 && net.s.length === 4 && net.regions[0]?.loops[0]?.length === 4 && net.regions[0].rule === "NONZERO", "a vector network blob reads back: 4 points, 4 segments, one region of one loop");
const rounded = networkOutline(Buffer.from(blobs[0]), { x: 200, y: 100 }, { x: 200, y: 100 }, () => 20);
check((rounded?.fills[0].d.match(/C/g) ?? []).length === 4, `every corner of a rectangle is rounded, a straight edge stored as a curve too (${rounded?.fills[0].d})`);
check(rectOutline(10, 10, [50, 0, 0, 0]).fills[0].d.startsWith("M5 0"), "a corner radius larger than the box is made to fit");

// Joined shapes without a stored outline, at the bottom: cut out, kept where they meet, kept where
// they don't, and a union of two halves that only touch (one outline, no seam down the middle).
let next = 200;
const joined = (op: string, x: number, parts: Array<[string, number, number, number, number]>, stroke = false) => {
  const b = next++;
  nodeChanges.push({ guid: G(b), type: "BOOLEAN_OPERATION", name: op, booleanOperation: op, size: { x: 60, y: 60 }, transform: T(x, 225), fillPaints: solid(C(0, 0, 200)), ...(stroke ? { strokePaints: solid(C(230, 0, 0)), strokeWeight: 3, strokeAlign: "INSIDE", strokeJoin: "MITER" } : {}), parentIndex: at(10, `z${b}`) } as never);
  parts.forEach(([type, px, py, w, h], i) => nodeChanges.push({ guid: G(next++), type, name: `${op} ${i}`, size: { x: w, y: h }, transform: T(px, py), fillPaints: solid(C(0, 200, 0)), parentIndex: at(b, String.fromCharCode(97 + i)) } as never));
};
(nodeChanges[4] as { size: { x: number; y: number } }).size.y = 300;
joined("SUBTRACT", 10, [["RECTANGLE", 0, 0, 60, 60], ["ELLIPSE", 15, 15, 30, 30]]);
joined("INTERSECT", 90, [["RECTANGLE", 0, 0, 40, 40], ["RECTANGLE", 20, 20, 40, 40]]);
joined("XOR", 170, [["RECTANGLE", 0, 0, 40, 40], ["RECTANGLE", 20, 20, 40, 40]]);
joined("UNION", 250, [["RECTANGLE", 0, 0, 30, 60], ["RECTANGLE", 30, 0, 30, 60]], true);

// Drawn.
const handlers = () => process.listeners("uncaughtException").length + process.listeners("unhandledRejection").length;
const had = handlers();
const pk = await loadPathKit();
check(Boolean(pk) && handlers() === had, `Skia's path library (PathKit) loads, and leaves the engine's error handling as it was (${had} handlers before, ${handlers()} after)`);
const d = figDoc({ message: { nodeChanges, blobs: blobs.map((bytes) => ({ bytes })) }, images: new Map() } as never);
const ctx = newCtx(d);
const [root] = copiedRoots(d);
const html = nodeHtml(ctx, resolveTree(d, root), null);
const page = await newPage();
await page.setViewport({ width: 320, height: 300, deviceScaleFactor: 1 });
await page.setContent(`<!doctype html><body style="margin:0">${html}</body>`, { waitUntil: "load" });
const png = Buffer.from(await page.screenshot({ type: "png", clip: { x: 0, y: 0, width: 320, height: 300 } }));
await page.close();
if (process.env.UI_SHOTS) writeFileSync(path.join(process.env.UI_SHOTS, "fig-test.png"), png);
const img = decodePng(png);
const px = (x: number, y: number) => pixelAt(img, x, y);
const near = (p: number[], c: ReturnType<typeof C>, tol = 40) => Math.abs(p[0] - c.r * 255) + Math.abs(p[1] - c.g * 255) + Math.abs(p[2] - c.b * 255) <= tol;
const any = (x0: number, y0: number, x1: number, y1: number, ok: (p: number[]) => boolean) => {
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (ok(px(x, y))) return true;
  return false;
};
const isGreen = (p: number[]) => near(p, GREEN, 90);
const isRed = (p: number[]) => p[0] > 150 && p[1] < 80 && p[2] < 80;

check(near(px(120, 70), DARK) && !any(20, 20, 220, 140, isRed), "the bubble is filled with its own colour, its parts' own fills left out (as Figma joins shapes)");
check(isGreen(px(120, 20)) && !isGreen(px(120, 18)), "its stroke is drawn inside its edge, in the colour of the shared style it points to by key");
check(!any(215, 112, 219, 119, isGreen) && any(205, 105, 218, 118, isGreen), "its bottom corners are rounded too (the bottom edge was stored as a curve)");
check(!any(63, 115, 77, 121, isGreen), "no line across where the tail joins: the stroke follows the joined shape's edge");
check(any(56, 124, 64, 132, isGreen) && any(76, 124, 84, 132, isGreen) && !any(66, 124, 74, 130, isGreen), "the tail's sides carry the stroke");
check(any(30, 160, 80, 180, isGreen) && !any(30, 184, 110, 200, isGreen), "the name's first line is green from its shared style, the second keeps the text's white");
check(any(240, 58, 260, 62, (p) => p[0] > 200 && p[1] > 200 && p[2] > 200) && any(278, 50, 284, 54, (p) => p[0] > 200), "the arrow has its shaft and the arrowhead's arms (a cap set on its end point)");
check(isGreen(px(251, 160)) && !isGreen(px(248, 160)), "a stored inside stroke stays inside the shape (Figma keeps it twice as wide, cut to the shape)");

const blue = (x: number, y: number) => { const [r, g, b] = px(x, y); return b > 150 && r < 60 && g < 60; };
const red = (x: number, y: number) => { const [r, g, b] = px(x, y); return r > 180 && g < 70 && b < 70; };
check(blue(13, 228) && !blue(40, 255), "subtract: a square with a round hole cut out of it");
check(blue(120, 255) && !blue(95, 230) && !blue(145, 280), "intersect: only where both squares are");
check(blue(175, 230) && blue(225, 280) && !blue(200, 255), "exclude: each square, but not where they overlap");
check(red(251, 255) && red(308, 255) && red(280, 226) && !red(279, 255) && !red(281, 255) && blue(280, 255), "union of two halves that only touch: one outline, stroked all round, no line down the middle");
const svgs = html.match(/<svg[\s\S]*?<\/svg>/g) ?? [];
check(svgs.every((x) => !x.includes("<mask")), "joined shapes are one path each (no stacks of masks): lighter to draw, editable as one vector");

// ---------------------------------------------------------------------------------------------
// Regression checks: root flips, componentPropAssignments, SPACE_BETWEEN gap, symmetric padding,
// stackReverseZIndex, pass-through LINEAR_DODGE group, gradient strokes, VIDEO poster, radial blur
// masking, GLASS kiwi mapping, and OpenType .otf font synthesis from derivedTextData.glyphs.
{
  const scratch = mkdtempSync(path.join(os.tmpdir(), "fig-test-lib-"));
  useLibrary(() => scratch);
  const posterHash = new Uint8Array(20).fill(0xab);
  const posterHex = Buffer.from(posterHash).toString("hex");
  // Minimal valid 1x1 PNG
  const tinyPng = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a8b8AAAAASUVORK5CYII=", "base64");
  // Glyph outline for 'A': a solid square [0.1..0.7] x [0.0..0.7] in normalized 1-em Y-up coordinates
  const glyphBlob = commands([[[0.1, 0], [0.7, 0], [0.7, 0.7], [0.1, 0.7]]]);
  const rNodes: any[] = [
    { guid: G(0), type: "DOCUMENT", name: "Doc" },
    { guid: G(1), type: "CANVAS", name: "Page 1", parentIndex: at(0, "a") },
    // Flipped root frame (m11: -1) with child at y=90 (m11: -1) -> should land upright at top=10
    { guid: G(50), type: "FRAME", name: "Flipped", size: { x: 200, y: 100 }, transform: { m00: 1, m01: 0, m02: 10, m10: 0, m11: -1, m12: 150 }, fillPaints: solid(DARK), parentIndex: at(1, "a") },
    { guid: G(51), type: "RECTANGLE", name: "TopBox", size: { x: 40, y: 20 }, transform: { m00: 1, m01: 0, m02: 15, m10: 0, m11: -1, m12: 90 }, fillPaints: solid(GREEN), parentIndex: at(50, "a") },
    // Symbol + Instance with componentPropAssignments (TEXT_DATA + VISIBLE)
    { guid: G(60), type: "SYMBOL", name: "BadgeSym", size: { x: 100, y: 30 }, transform: T(0, 0), componentPropDefs: [{ id: G(900), name: "Label", type: "TEXT", initialValue: { textValue: { characters: "Default" } } }, { id: G(901), name: "ShowDot", type: "BOOL", initialValue: { boolValue: true } }], parentIndex: at(1, "b") },
    { guid: G(61), type: "TEXT", name: "Lbl", size: { x: 80, y: 20 }, transform: T(0, 0), fontSize: 16, fontName: { family: "CustomSynth", style: "Compact Dark" }, textData: { characters: "Default" }, componentPropRefs: [{ defID: G(900), componentPropNodeField: "TEXT_DATA" }], parentIndex: at(60, "a") },
    { guid: G(62), type: "ELLIPSE", name: "Dot", size: { x: 8, y: 8 }, transform: T(85, 5), fillPaints: solid(GREEN), componentPropRefs: [{ defID: G(901), componentPropNodeField: "VISIBLE" }], parentIndex: at(60, "b") },
    {
      guid: G(70), type: "FRAME", name: "Stage", size: { x: 400, y: 300 }, transform: T(300, 0), fillPaints: solid(DARK), parentIndex: at(1, "c"),
    },
    {
      guid: G(71), type: "INSTANCE", name: "BadgeInst", size: { x: 100, y: 30 }, transform: T(0, 0), symbolData: { symbolID: G(60) },
      componentPropAssignments: [
        { defID: G(900), value: { textValue: { characters: "Overridden" } } },
        { defID: G(901), value: { boolValue: false } },
      ],
      parentIndex: at(70, "a"),
    },
    // Auto-layout with SPACE_BETWEEN + stale stackSpacing=83 + symmetric padding + stackReverseZIndex
    {
      guid: G(72), type: "FRAME", name: "Row", size: { x: 300, y: 40 }, transform: T(0, 40), stackMode: "HORIZONTAL", stackPrimarySizing: "FIXED", stackPrimaryAlignItems: "SPACE_BETWEEN", stackSpacing: 83, stackHorizontalPadding: 16, stackVerticalPadding: 8, stackReverseZIndex: true,
      strokeWeight: 2, strokeAlign: "INSIDE", cornerRadius: 12,
      strokePaints: [{ type: "GRADIENT_LINEAR", opacity: 1, visible: true, stops: [{ color: GREEN, position: 0 }, { color: C(255, 0, 255), position: 1 }], transform: { m00: 1, m01: 0, m02: 0, m10: 0, m11: 1, m12: 0 } }],
      effects: [{ type: "GLASS", visible: true, radius: 6, refractionRadius: 20, refractionIntensity: 0.42, chromaticAberration: 0.4, specularAngle: 315, specularIntensity: 0.8 }],
      parentIndex: at(70, "b"),
    },
    { guid: G(73), type: "RECTANGLE", name: "A", size: { x: 40, y: 20 }, transform: T(0, 0), fillPaints: solid(GREEN), parentIndex: at(72, "a") },
    { guid: G(74), type: "RECTANGLE", name: "B", size: { x: 40, y: 20 }, transform: T(0, 0), fillPaints: solid(GREEN), parentIndex: at(72, "b") },
    // Rotated pass-through group with LINEAR_DODGE child + VIDEO paint
    { guid: G(75), type: "FRAME", name: "BlendGroup", resizeToFit: true, frameMaskDisabled: false, size: { x: 80, y: 80 }, transform: { m00: 0, m01: 1, m02: 100, m10: -1, m11: 0, m12: 200 }, parentIndex: at(70, "c") },
    { guid: G(76), type: "ROUNDED_RECTANGLE", name: "Glow", size: { x: 80, y: 80 }, transform: T(0, 0), blendMode: "LINEAR_DODGE", fillPaints: [{ type: "VIDEO", visible: true, opacity: 1, image: { hash: posterHash }, imageScaleMode: "FILL" }], parentIndex: at(75, "a") },
    // 90°-rotated radial gradient with alpha=0 center + BACKGROUND_BLUR
    {
      guid: G(77), type: "ROUNDED_RECTANGLE", name: "Vignette", size: { x: 400, y: 200 }, transform: T(0, 100),
      fillPaints: [{ type: "GRADIENT_RADIAL", opacity: 1, visible: true, stops: [{ color: { r: 1, g: 1, b: 1, a: 0 }, position: 0.5 }, { color: { r: 1, g: 1, b: 1, a: 1 }, position: 1 }], transform: { m00: 0, m01: 1, m02: 0, m10: -0.5, m11: 0, m12: 0.75 } }],
      effects: [{ type: "BACKGROUND_BLUR", visible: true, radius: 40 }, { type: "FOREGROUND_BLUR", visible: true, radius: 60 }],
      parentIndex: at(70, "d"),
    },
    // Text node with stored glyph outline for OpenType synthesis test
    {
      guid: G(78), type: "TEXT", name: "SynthSample", size: { x: 100, y: 40 }, transform: T(20, 200), fontSize: 32, fontName: { family: "CustomSynth", style: "Compact Dark" },
      fillPaints: solid(C(255, 255, 255)), textData: { characters: "AAA" },
      derivedTextData: {
        fontMetaData: [{ key: { family: "CustomSynth", style: "Compact Dark" }, fontWeight: 800, fontStyle: "NORMAL", fontLineHeight: 1.2 }],
        baselines: [{ lineY: 0, lineHeight: 38, lineAscent: 28, width: 70, firstCharacter: 0, endCharacter: 3 }],
        glyphs: [{ commandsBlob: 0, position: { x: 0, y: 28 }, fontSize: 32, firstCharacter: 0, advance: 0.75, rotation: 0 }],
      },
      parentIndex: at(70, "e"),
    },
  ];
  const rd = figDoc({ message: { nodeChanges: rNodes, blobs: [{ bytes: glyphBlob }] }, images: new Map([[posterHex, tinyPng]]) } as never);
  const rctx = newCtx(rd);
  const flippedNode = rd.byId.get("1:50")!;
  const fplace = placeOf(flippedNode);
  check(fplace.x === 10 && fplace.y === 50 && fplace.w === 200 && fplace.h === 100, `flipped root frame placeOf returns upright top-left (${fplace.x},${fplace.y})`);
  const flippedHtml = nodeHtml(rctx, resolveTree(rd, flippedNode), null);
  check(flippedHtml.includes("top:10px") && !flippedHtml.includes("matrix(1, 0, 0, -1"), "flipped root frame normalizes children upright at top:10px");

  const stageHtml = nodeHtml(rctx, resolveTree(rd, rd.byId.get("1:70")!), null);
  check(stageHtml.includes("Overridden") && !stageHtml.includes("Default") && !stageHtml.includes('data-name="Dot"'), "componentPropAssignments updates TEXT_DATA and hides VISIBLE=false children");
  check(stageHtml.includes("justify-content:space-between") && !stageHtml.includes("gap:83px"), "SPACE_BETWEEN ignores stale stackSpacing");
  check(stageHtml.includes("padding:8px 16px 8px 16px"), "symmetric auto-layout padding fills missing right/bottom from left/top");
  check(stageHtml.includes("isolation:isolate") && stageHtml.includes("z-index:2") && stageHtml.includes("z-index:1"), "stackReverseZIndex isolates parent and reverses child z-index");
  check(stageHtml.includes("mask-composite:exclude"), "gradient stroke on rounded frame emits CSS mask-composite overlay");
  check(stageHtml.includes('data-glass="{&quot;refraction&quot;:42,&quot;depth&quot;:50,&quot;dispersion&quot;:40,&quot;frost&quot;:12,&quot;splay&quot;:0,&quot;lightAngle&quot;:-45,&quot;lightIntensity&quot;:80}"'), "GLASS kiwi fields map refractionIntensity/refractionRadius/specularAngle accurately");
  check(stageHtml.includes("mix-blend-mode:plus-lighter") && stageHtml.includes('data-name="BlendGroup" style="position:absolute;left:0px;top:0px;width:0px;height:0px;overflow:visible"'), "rotated pass-through group pushes transform onto LINEAR_DODGE children without isolating blend");
  check(stageHtml.includes(posterHex.slice(0, 20)), "VIDEO paint extracts and renders its poster image hash");
  check(stageHtml.includes("radial-gradient(400px 100px") && stageHtml.includes("mask-image:radial-gradient"), "90°-rotated radial gradient keeps true axes (400x100, not swapped 100x400) and masks BACKGROUND_BLUR where center alpha is 0");

  // Synthesize .otf font from derivedTextData.glyphs and verify Chrome's OTS sanitizer loads it cleanly
  const synthFonts = synthesizeFigFonts(rd, new Set(["CustomSynth"]));
  check(synthFonts.length === 1 && synthFonts[0].weight === "800" && synthFonts[0].stretch === "semi-condensed", `synthesized .otf face preserves fontMetaData weight and stretch (${JSON.stringify(synthFonts[0])})`);
  const otfBytes = readFileSync(synthFonts[0].src);
  check(otfBytes.subarray(0, 4).toString("ascii") === "OTTO", "synthesized font has valid OpenType CFF (OTTO) header");
  const fp = await newPage();
  const fDataUrl = `data:font/otf;base64,${otfBytes.toString("base64")}`;
  await fp.setContent(`<!doctype html><style>@font-face{font-family:"CustomSynth";src:url("${fDataUrl}") format("opentype");font-weight:800;font-stretch:semi-condensed;font-display:block}</style><body style="margin:0;background:#fff"><div style="font-family:'CustomSynth';font-weight:800;font-stretch:semi-condensed;font-size:48px;color:#000">AAA</div></body>`, { waitUntil: "load" });
  const fontLoaded = await fp.evaluate(async () => {
    await document.fonts.ready;
    return [...document.fonts].every((f) => f.status === "loaded");
  });
  const fshot = decodePng(Buffer.from(await fp.screenshot({ type: "png", clip: { x: 0, y: 0, width: 120, height: 60 } })));
  await fp.close();
  let darkPx = 0;
  for (let y = 0; y < 60; y++) for (let x = 0; x < 120; x++) if (pixelAt(fshot, x, y)[0] < 50) darkPx++;
  check(fontLoaded && darkPx > 400, `Chrome/OTS loads synthesized .otf font cleanly and draws glyph pixels (loaded=${fontLoaded}, darkPx=${darkPx})`);
  rmSync(scratch, { recursive: true, force: true });
}

await closeBrowser();
if (failed) {
  console.log(`${failed} failed`);
  process.exit(1);
}
console.log("All passed");
