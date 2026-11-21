// The Figma importer's conversion, on a sample in Figma's REST format: no token or network needed.
// Checks the layers it makes, and draws the result (UI_SHOTS=<folder> keeps a picture).
import { strict as assert } from "node:assert";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { htmlToNodes } from "../src/board/core.js";
import { nodeHtml, parseFigmaUrl, svgNodes, type FigmaNode } from "../src/board/figma-import.js";
import { closeBrowser, getBrowser } from "../src/render/browser.js";

const C = (r: number, g: number, b: number, a = 1) => ({ r, g, b, a });
const box = (x: number, y: number, width: number, height: number) => ({ x, y, width, height });
const text = (id: string, name: string, chars: string, b: ReturnType<typeof box>, style: object, extra: Partial<FigmaNode> = {}): FigmaNode => ({
  id, name, type: "TEXT", characters: chars, absoluteBoundingBox: b, style: { fontFamily: "Inter", fontWeight: 400, fontSize: 16, lineHeightUnit: "INTRINSIC_%", textAutoResize: "HEIGHT", fills: [{ type: "SOLID", color: C(0.1, 0.1, 0.12) }], ...style } as never, fills: [{ type: "SOLID", color: C(0.1, 0.1, 0.12) }], ...extra,
});
// A card in auto layout: a heading with a bold run, a line of copy, two buttons (one filling the row), an icon, and a badge placed by hand.
const frame: FigmaNode = {
  id: "1:1", name: "Pricing card", type: "FRAME", absoluteBoundingBox: box(100, 200, 420, 360),
  fills: [{ type: "SOLID", color: C(1, 1, 1) }], cornerRadius: 24, clipsContent: true,
  effects: [{ type: "DROP_SHADOW", radius: 30, color: C(0, 0, 0, 0.12), offset: { x: 0, y: 12 }, spread: -4 }],
  layoutMode: "VERTICAL", itemSpacing: 16, paddingTop: 32, paddingRight: 32, paddingBottom: 32, paddingLeft: 32, primaryAxisAlignItems: "MIN", counterAxisAlignItems: "MIN",
  children: [
    { id: "1:2", name: "Icon", type: "VECTOR", absoluteBoundingBox: box(132, 232, 32, 32), fills: [{ type: "SOLID", color: C(0.2, 0.4, 1) }] },
    text("1:3", "Title", "Pro plan for teams", box(132, 280, 356, 34), { fontFamily: "Inter Tight", fontWeight: 600, fontSize: 28, letterSpacing: -0.5 }, { characterStyleOverrides: [0, 0, 0, 0, 1, 1, 1, 1], styleOverrideTable: { "1": { fontWeight: 800, fills: [{ type: "SOLID", color: C(0.2, 0.4, 1) }] } as never }, layoutSizingHorizontal: "FILL" }),
    text("1:4", "Copy", "Everything in Free, plus\nteam workspaces.", box(132, 330, 356, 44), { fontSize: 15, lineHeightUnit: "PIXELS", lineHeightPx: 22, fills: [{ type: "SOLID", color: C(0.35, 0.36, 0.4) }] }),
    {
      id: "1:5", name: "Buttons", type: "FRAME", absoluteBoundingBox: box(132, 390, 356, 48), layoutMode: "HORIZONTAL", itemSpacing: 10, counterAxisAlignItems: "CENTER", layoutSizingHorizontal: "FILL", layoutSizingVertical: "HUG", fills: [],
      children: [
        { id: "1:6", name: "Primary", type: "FRAME", absoluteBoundingBox: box(132, 390, 200, 48), layoutMode: "HORIZONTAL", primaryAxisAlignItems: "CENTER", counterAxisAlignItems: "CENTER", layoutSizingHorizontal: "FILL", layoutSizingVertical: "FIXED", cornerRadius: 999,
          fills: [{ type: "GRADIENT_LINEAR", gradientHandlePositions: [{ x: 0, y: 0.5 }, { x: 1, y: 0.5 }, { x: 0, y: 1 }], gradientStops: [{ position: 0, color: C(0.2, 0.4, 1) }, { position: 1, color: C(0.5, 0.3, 1) }] }],
          children: [text("1:7", "Label", "Start free trial", box(180, 404, 104, 20), { fontWeight: 600, fontSize: 15, textAutoResize: "WIDTH_AND_HEIGHT", fills: [{ type: "SOLID", color: C(1, 1, 1) }] })] },
        { id: "1:8", name: "Secondary", type: "FRAME", absoluteBoundingBox: box(342, 390, 146, 48), layoutMode: "HORIZONTAL", primaryAxisAlignItems: "CENTER", counterAxisAlignItems: "CENTER", layoutSizingHorizontal: "FIXED", cornerRadius: 999, fills: [],
          strokes: [{ type: "SOLID", color: C(0.85, 0.86, 0.9) }], strokeWeight: 1.5, strokeAlign: "OUTSIDE",
          children: [text("1:9", "Label", "Talk to us", box(380, 404, 70, 20), { fontWeight: 500, fontSize: 15, textAutoResize: "WIDTH_AND_HEIGHT" })] },
      ],
    } as FigmaNode,
    { id: "1:10", name: "Badge", type: "FRAME", layoutPositioning: "ABSOLUTE", absoluteBoundingBox: box(420, 224, 72, 26), cornerRadius: 999, fills: [{ type: "SOLID", color: C(1, 0.85, 0.2) }], layoutMode: "HORIZONTAL", primaryAxisAlignItems: "CENTER", counterAxisAlignItems: "CENTER",
      children: [text("1:11", "Badge text", "POPULAR", box(430, 230, 52, 14), { fontSize: 10, fontWeight: 700, letterSpacing: 0.8, textCase: "UPPER", textAutoResize: "WIDTH_AND_HEIGHT" })] },
  ],
};
const svgs = { "1:2": '<svg width="32" height="32" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg"><rect width="32" height="32" rx="9" fill="#3366FF"/><path d="M10 16.5l4 4 8-9" stroke="white" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>' };

// Links
assert.deepEqual(parseFigmaUrl("https://www.figma.com/design/AbC123xyz/Landing?node-id=12-34&t=x"), { key: "AbC123xyz", node: "12:34" });
assert.deepEqual(parseFigmaUrl("figma.com/file/AbC123xyz/Landing"), { key: "AbC123xyz", node: undefined });
assert.deepEqual(parseFigmaUrl("https://www.figma.com/design/AbC/branch/BrAnCh/Landing?node-id=0-1"), { key: "BrAnCh", node: undefined });
assert.throws(() => parseFigmaUrl("https://example.com/x"));
assert.deepEqual(svgNodes(frame), ["1:2"]);

const warnings = new Set<string>();
const html = nodeHtml(frame, null, { images: {}, svgs, warnings });
const got = htmlToNodes(html, { wholeSvg: true });
const n = (name: string) => Object.values(got.nodes).find((x) => x.name === name)!;
const card = n("Pricing card");
assert.equal(card.style.display, "flex");
assert.equal(card.style.flexDirection, "column");
assert.equal(card.style.gap, "16px");
assert.equal(card.style.padding, "32px 32px 32px 32px");
assert.equal(card.style.borderRadius, "24px");
assert.match(card.style.boxShadow ?? "", /0px 12px 30px -4px rgba\(0, 0, 0, 0\.12\)/);
assert.equal(n("Buttons").style.alignSelf, "stretch");
assert.equal(n("Primary").style.flexGrow, "1");
assert.match(n("Primary").style.backgroundImage ?? "", /linear-gradient\(90deg/);
assert.match(n("Secondary").style.outline ?? "", /1\.5px solid/);
assert.equal(n("Badge").style.position, "absolute");
assert.equal(n("Badge").style.left, "320px");
assert.equal(n("Icon").type, "svg");
const title = n("Title");
assert.equal(title.type, "text");
assert.match(title.text ?? "", /font-weight:\s*800/);
assert.equal(title.style.fontFamily, "'Inter Tight'");
assert.equal(n("Copy").style.lineHeight, "22px");
console.log("PASS Figma links, vectors, auto layout, fills, strokes, effects and text runs");

// A picture of it, to look at.
const dir = process.env.UI_SHOTS;
if (dir) {
  const page = await (await getBrowser()).newPage();
  await page.setViewport({ width: 620, height: 520, deviceScaleFactor: 2 });
  await page.setContent(`<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=Inter+Tight:wght@600;800&display=block" rel="stylesheet"><body style="margin:0;padding:60px 100px;background:#eef0f4;font-family:Inter">${html}</body>`, { waitUntil: "networkidle0" });
  await page.screenshot({ path: path.join(dir, "figma-card.png") });
  writeFileSync(path.join(dir, "figma-card.html"), html);
  await page.close();
  await closeBrowser();
}
