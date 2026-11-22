/**
 * A .fig file imported into a scratch library (never the person's boards) and each frame drawn,
 * to look at next to Figma: npx tsx scripts/fig-render.ts <file.fig> [--scale 0.5] [--out dir] [--page name]
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const args = process.argv.slice(2);
const flag = (name: string, d: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args.splice(i, 2)[1] : d;
};
const scale = Number(flag("--scale", "0.5"));
const out = flag("--out", mkdtempSync(path.join(os.tmpdir(), "fig-render-")));
const page = flag("--page", "");
process.env.SCREENSHOTTER_OUTPUT_DIR = path.join(out, "library");
const { useLibrary } = await import("../src/util/files.js");
useLibrary(() => process.env.SCREENSHOTTER_OUTPUT_DIR!);
const { importFig } = await import("../src/board/fig-import.js");
const { getBoard } = await import("../src/board/store.js");
const { drawLayers } = await import("../src/board/render.js");
const { closeBrowser } = await import("../src/render/browser.js");
mkdirSync(out, { recursive: true });
const t0 = Date.now();
const r = await importFig(null, { file: args[0], figmaPage: page || undefined }, "studio");
console.log(`${r.name}: ${r.artboards.length} frames, ${r.layers} layers, ${r.pictures} pictures, ${r.fonts} font files, ${((Date.now() - t0) / 1000).toFixed(1)}s`);
if (r.warnings.length) console.log(`  warnings: ${r.warnings.join(" | ")}`);
const board = getBoard(r.board);
for (const a of r.artboards) {
  const img = (await drawLayers(board, [a.id], { scale, format: "png", transparent: false })).images[a.id];
  const file = path.join(out, `${a.name.replace(/[^\w-]+/g, "_")}.png`);
  writeFileSync(file, img);
  console.log(`  ${a.name} → ${file}`);
}
await closeBrowser();
