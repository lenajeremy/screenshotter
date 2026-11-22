// Figma's own data (as a .fig file and the clipboard hold it) drawn as layers, checked by pixel.
// What Figma puts on the clipboard has no outlines for its shapes and points to shared styles by
// key: this builds a small document like that by hand (a speech bubble made by joining a rounded
// rectangle and a triangle, with an inside stroke in a shared colour; a name in two styles; an
// arrow), draws it, and looks at the pixels. No Figma file, token or network needed.
//
//   npx tsx scripts/fig-test.ts        (UI_SHOTS=<folder> keeps the picture)
import { writeFileSync } from "node:fs";
import path from "node:path";
import { copiedRoots, figDoc, newCtx, nodeHtml, resolveTree } from "../src/board/fig-convert.js";
import { decodeNetwork, networkOutline, rectOutline } from "../src/board/fig-geometry.js";
import { closeBrowser, newPage } from "../src/render/browser.js";
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

// Drawn.
const d = figDoc({ message: { nodeChanges, blobs: blobs.map((bytes) => ({ bytes })) }, images: new Map() } as never);
const ctx = newCtx(d);
const [root] = copiedRoots(d);
const html = nodeHtml(ctx, resolveTree(d, root), null);
const page = await newPage();
await page.setViewport({ width: 320, height: 220, deviceScaleFactor: 1 });
await page.setContent(`<!doctype html><body style="margin:0">${html}</body>`, { waitUntil: "load" });
const png = Buffer.from(await page.screenshot({ type: "png", clip: { x: 0, y: 0, width: 320, height: 220 } }));
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

await closeBrowser();
if (failed) {
  console.log(`${failed} failed`);
  process.exit(1);
}
console.log("All passed");
