/**
 * A .fig import (or a paste: what Figma put on the clipboard, saved as .html) against Figma's own
 * picture of a frame (exported from Figma at 1x): the frame is imported into a scratch library,
 * drawn by the engine, and compared pixel by pixel. Writes figma.png, ours.png, diff.png and
 * side.png, and prints the share of pixels that differ.
 *
 *   npx tsx scripts/fig-compare.ts <file.fig | clipboard.html> <frame name> <figma export.png> [--page name] [--out dir]
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const args = process.argv.slice(2);
const flag = (name: string, d: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args.splice(i, 2)[1] : d;
};
const outRoot = flag("--out", mkdtempSync(path.join(os.tmpdir(), "fig-compare-")));
const page = flag("--page", "");
const [file, frame, ref] = args;
if (!file || !frame || !ref) {
  console.error("npx tsx scripts/fig-compare.ts <file.fig> <frame name> <figma export.png> [--page name] [--out dir]");
  process.exit(1);
}
process.env.SCREENSHOTTER_OUTPUT_DIR = path.join(outRoot, "library");
const { useLibrary } = await import("../src/util/files.js");
useLibrary(() => process.env.SCREENSHOTTER_OUTPUT_DIR!);
const { importFig } = await import("../src/board/fig-import.js");
const { getBoard } = await import("../src/board/store.js");
const { drawLayers } = await import("../src/board/render.js");
const { newPage, closeBrowser } = await import("../src/render/browser.js");

/** Compare two pictures in the browser: the score, and a heat map of where they differ. */
async function compare(a: Buffer, b: Buffer, dir: string) {
  const page = await newPage();
  try {
    await page.setContent("<body style='margin:0;background:#888'></body>");
    const r = await page.evaluate(
      async (A: string, B: string) => {
        const load = (src: string) => new Promise<HTMLImageElement>((ok, no) => Object.assign(new Image(), { onload: function (this: HTMLImageElement) { ok(this); }, onerror: no, src }));
        const [ia, ib] = await Promise.all([load(A), load(B)]);
        const w = ia.naturalWidth;
        const h = ia.naturalHeight;
        const c = (img: HTMLImageElement) => {
          const cv = Object.assign(document.createElement("canvas"), { width: w, height: h });
          const x = cv.getContext("2d")!;
          x.fillStyle = "#fff";
          x.fillRect(0, 0, w, h);
          x.drawImage(img, 0, 0, w, h);
          return x.getImageData(0, 0, w, h);
        };
        const da = c(ia).data;
        const db = c(ib).data;
        const out = Object.assign(document.createElement("canvas"), { width: w, height: h });
        const ox = out.getContext("2d")!;
        const heat = ox.createImageData(w, h);
        let off = 0;
        let sum = 0;
        for (let i = 0; i < da.length; i += 4) {
          const d = (Math.abs(da[i] - db[i]) + Math.abs(da[i + 1] - db[i + 1]) + Math.abs(da[i + 2] - db[i + 2])) / 3;
          sum += d;
          const bad = d > 40;
          if (bad) off++;
          const g = (da[i] + da[i + 1] + da[i + 2]) / 3;
          heat.data[i] = bad ? 255 : g * 0.35 + 160;
          heat.data[i + 1] = bad ? 40 : g * 0.35 + 160;
          heat.data[i + 2] = bad ? 60 : g * 0.35 + 160;
          heat.data[i + 3] = 255;
        }
        ox.putImageData(heat, 0, 0);
        // Rows that differ most, so the worst bands can be looked at.
        const band = 200;
        const bands: Array<[number, number]> = [];
        for (let y = 0; y < h; y += band) {
          let n = 0;
          for (let yy = y; yy < Math.min(h, y + band); yy++) for (let x = 0; x < w; x++) if (heat.data[(yy * w + x) * 4 + 1] === 40) n++;
          bands.push([y, n / (w * Math.min(band, h - y))]);
        }
        return { w, h, wb: ib.naturalWidth, hb: ib.naturalHeight, off: off / (w * h), mean: sum / (w * h), heat: out.toDataURL("image/png"), bands: bands.sort((p, q) => q[1] - p[1]).slice(0, 5) };
      },
      `data:image/png;base64,${a.toString("base64")}`,
      `data:image/png;base64,${b.toString("base64")}`,
    );
    writeFileSync(path.join(dir, "diff.png"), Buffer.from(r.heat.split(",")[1], "base64"));
    // Side by side: Figma, ours, the differences.
    await page.setViewport({ width: Math.min(r.w, 900) * 3 + 40, height: 800 });
    await page.setContent(
      `<body style="margin:0;display:flex;gap:20px;background:#555;align-items:flex-start">${[a, b].map((x) => `<img src="data:image/png;base64,${x.toString("base64")}" style="width:${Math.min(r.w, 900)}px">`).join("")}<img src="${r.heat}" style="width:${Math.min(r.w, 900)}px"></body>`,
      { waitUntil: "load" },
    );
    writeFileSync(path.join(dir, "side.png"), await page.screenshot({ fullPage: true, type: "png" }));
    return r;
  } finally {
    await page.close();
  }
}

const t0 = Date.now();
const r = file.endsWith(".html") ? await importFig(null, { html: readFileSync(file, "utf8") }, "studio") : await importFig(null, { file, figmaPage: page || undefined }, "studio");
const art = r.artboards.find((a) => a.name.trim().toLowerCase() === frame.trim().toLowerCase());
if (!art) throw new Error(`No frame "${frame}": ${r.artboards.map((a) => a.name).join(", ")}`);
const dir = path.join(outRoot, frame.replace(/[^\w-]+/g, "_"));
mkdirSync(dir, { recursive: true });
const theirs = readFileSync(ref);
const ours = (await drawLayers(getBoard(r.board), [art.id], { scale: 1, format: "png", transparent: false })).images[art.id];
writeFileSync(path.join(dir, "figma.png"), theirs);
writeFileSync(path.join(dir, "ours.png"), ours);
const c = await compare(theirs, ours, dir);
console.log(`${frame}: ${(c.off * 100).toFixed(2)}% of pixels differ (mean ${c.mean.toFixed(2)}), Figma ${c.w}×${c.h}, ours ${c.wb}×${c.hb}, ${((Date.now() - t0) / 1000).toFixed(1)}s`);
if (r.warnings.length) console.log(`  warnings: ${r.warnings.join(" | ")}`);
console.log(`  worst bands (y, share differing): ${c.bands.map(([y, s]: [number, number]) => `${y}:${(s * 100).toFixed(0)}%`).join(" ")}\n  ${dir}`);
await closeBrowser();
