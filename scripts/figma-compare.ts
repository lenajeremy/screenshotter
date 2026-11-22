/**
 * How close a Figma import comes to Figma itself. For each frame link: Figma's own render (its
 * images API), the frame imported onto a board in a scratch library, and that drawn by the engine,
 * compared pixel by pixel. Writes figma.png, ours.png, diff.png and side.png per frame, and prints
 * a score (the share of pixels that differ noticeably).
 *
 *   FIGMA_TOKEN=… npx tsx scripts/figma-compare.ts <frame link> [more links] [--scale 0.5] [--out dir]
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const args = process.argv.slice(2);
const flag = (name: string, d: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args.splice(i, 2)[1] : d;
};
const scale = Number(flag("--scale", "0.5"));
const outRoot = flag("--out", mkdtempSync(path.join(os.tmpdir(), "figma-compare-")));
const token = process.env.FIGMA_TOKEN?.trim();
if (!token || !args.length) {
  console.error("FIGMA_TOKEN=… npx tsx scripts/figma-compare.ts <frame link> [more links] [--scale 0.5] [--out dir]");
  process.exit(1);
}
// A library of its own, so the person's boards are never touched.
process.env.SCREENSHOTTER_OUTPUT_DIR = path.join(outRoot, "library");
const { useLibrary } = await import("../src/util/files.js");
useLibrary(() => process.env.SCREENSHOTTER_OUTPUT_DIR!);
const { importFigma, parseFigmaUrl } = await import("../src/board/figma-import.js");
const { getBoard } = await import("../src/board/store.js");
const { drawLayers } = await import("../src/board/render.js");
const { newPage, closeBrowser } = await import("../src/render/browser.js");

/** Figma's own picture of the frame (kept in the cache folder, so it's asked for once). */
async function figmaPng(key: string, node: string): Promise<Buffer> {
  const keep = path.join(process.env.SCREENSHOTTER_FIGMA_CACHE ?? outRoot, `render-${key}-${node.replace(/\W/g, "-")}-${scale}.png`);
  if (existsSync(keep)) return readFileSync(keep);
  for (let tries = 6; ; tries--) {
    const r = await fetch(`https://api.figma.com/v1/images/${key}?ids=${encodeURIComponent(node)}&format=png&scale=${scale}&use_absolute_bounds=true`, { headers: { "X-Figma-Token": token! } });
    if (r.status === 429 && tries > 1) {
      const wait = Math.min(60, Number(r.headers.get("retry-after")) || 20);
      console.log(`  Figma's rate limit: waiting ${wait}s`);
      await new Promise((ok) => setTimeout(ok, wait * 1000));
      continue;
    }
    const j = (await r.json()) as { images?: Record<string, string>; err?: string };
    const url = j.images?.[node];
    if (!url) throw new Error(`Figma didn't render ${node}: ${j.err ?? r.status}`);
    const png = Buffer.from(await (await fetch(url)).arrayBuffer());
    mkdirSync(path.dirname(keep), { recursive: true });
    writeFileSync(keep, png);
    return png;
  }
}

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

for (const link of args) {
  const { key, node } = parseFigmaUrl(link);
  if (!node) {
    console.error(`${link}: link to a frame (it needs ?node-id=…)`);
    continue;
  }
  const dir = path.join(outRoot, node.replace(/[^0-9a-z]+/gi, "-"));
  mkdirSync(dir, { recursive: true });
  const t0 = Date.now();
  const [theirs, imported] = await Promise.all([figmaPng(key, node), importFigma(null, { url: link, token }, "studio")]);
  const board = getBoard(imported.board);
  const art = imported.artboards[0].id;
  const ours = (await drawLayers(board, [art], { scale, format: "png", transparent: false })).images[art];
  writeFileSync(path.join(dir, "figma.png"), theirs);
  writeFileSync(path.join(dir, "ours.png"), ours);
  const r = await compare(theirs, ours, dir);
  console.log(
    `${imported.name} › ${imported.artboards[0].name}: ${(r.off * 100).toFixed(1)}% of pixels differ (mean ${r.mean.toFixed(1)}), Figma ${r.w}×${r.h}, ours ${r.wb}×${r.hb}, ${imported.layers} layers, ${((Date.now() - t0) / 1000).toFixed(0)}s` +
      (imported.warnings.length ? `\n  warnings: ${imported.warnings.join(" | ")}` : "") +
      `\n  worst bands (y at this scale, share differing): ${r.bands.map(([y, s]) => `${y}:${(s * 100).toFixed(0)}%`).join(" ")}\n  ${dir}`,
  );
}
await closeBrowser();
