/**
 * Working with finished images: crop or zoom into part of one, and lay several out as a grid
 * (a contact sheet to compare variants, an App Store set side by side, or a screen mosaic).
 */
import path from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { outputPathFor, resolveUserPath } from "../util/files.js";
import { imageSize } from "../util/image.js";
import { averageColor } from "./analyze.js";
import { esc, resolveBackground } from "./background.js";
import { renderHtml } from "./mockup.js";
import { BackgroundSchema } from "./schema.js";

/** The format an output name asks for, if it has an image extension. */
function formatOf(output: string | undefined): "png" | "jpeg" | "webp" | undefined {
  const ext = output ? path.extname(output).slice(1).toLowerCase() : "";
  return ext === "jpg" || ext === "jpeg" ? "jpeg" : ext === "png" || ext === "webp" ? ext : undefined;
}

// ---------------------------------------------------------------------------------------------
// Crop and zoom

export const CropInputShape = {
  image: z.string().describe("The image to crop: a mockup, a screenshot or any PNG/JPEG."),
  rect: z
    .object({ x: z.number(), y: z.number(), width: z.number().positive(), height: z.number().positive() })
    .optional()
    .describe("The region to keep. Fractions of the image (0–1) unless unit is \"px\"."),
  unit: z.enum(["fraction", "px"]).optional().describe("Units of rect. Default fraction."),
  focus: z
    .object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) })
    .optional()
    .describe("Instead of rect: the point to zoom into, as fractions of the image."),
  zoom: z.number().min(1).max(20).optional().describe("With focus: how far to zoom in (2 keeps the middle half of each side). Default 2."),
  aspect: z.number().positive().optional().describe("With focus: the crop's width ÷ height. Default: the image's own."),
  width: z.number().int().min(16).max(8192).optional().describe("Output width in px; the crop is enlarged or reduced to it. Default: the crop's own pixels."),
  format: z.enum(["png", "jpeg", "webp"]).optional(),
  output: z.string().optional().describe("Output file or directory. Default ./screenshots/crops/."),
  preview: z.boolean().optional().describe("Return a preview image. Default true."),
};
const CropInputSchema = z.object(CropInputShape);
export type CropInput = z.infer<typeof CropInputSchema>;

export async function cropImage(raw: CropInput): Promise<{ path: string; width: number; height: number; rect: { x: number; y: number; width: number; height: number } }> {
  const input = CropInputSchema.parse(raw);
  const file = resolveUserPath(input.image);
  const { width: IW, height: IH } = await imageSize(file);
  // The region in image px.
  let r: { x: number; y: number; width: number; height: number };
  if (input.rect) {
    const k = input.unit === "px" ? [1, 1] : [IW, IH];
    r = { x: input.rect.x * k[0], y: input.rect.y * k[1], width: input.rect.width * k[0], height: input.rect.height * k[1] };
  } else {
    // The largest window of the wanted shape that fits the image, shrunk by the zoom.
    const zoom = input.zoom ?? 2;
    const aspect = input.aspect ?? IW / IH;
    const [baseW, baseH] = IW / IH > aspect ? [IH * aspect, IH] : [IW, IW / aspect];
    const w = baseW / zoom;
    const h = baseH / zoom;
    const f = input.focus ?? { x: 0.5, y: 0.5 };
    r = { x: f.x * IW - w / 2, y: f.y * IH - h / 2, width: w, height: h };
  }
  // Keep the region inside the image.
  r.width = Math.min(r.width, IW);
  r.height = Math.min(r.height, IH);
  r.x = Math.max(0, Math.min(IW - r.width, r.x));
  r.y = Math.max(0, Math.min(IH - r.height, r.y));
  const outW = input.width ?? Math.round(r.width);
  const outH = Math.max(1, Math.round((outW * r.height) / r.width));
  const k = outW / r.width;
  const format = input.format ?? formatOf(input.output) ?? (/\.jpe?g$/i.test(file) ? "jpeg" : "png");
  const out = outputPathFor(input.output, "crops", `${path.basename(file).replace(/\.[^.]+$/, "")}-crop`, format === "jpeg" ? "jpg" : format);
  const html =
    `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;background:transparent}#c{position:relative;width:${outW}px;height:${outH}px;overflow:hidden}</style></head>` +
    `<body><div id="c"><img src="${esc(pathToFileURL(file).href)}" style="position:absolute;left:${-r.x * k}px;top:${-r.y * k}px;width:${IW * k}px;height:${IH * k}px;max-width:none"></div></body></html>`;
  await renderHtml(html, out, outW, outH, { scale: 1, format, transparent: format !== "jpeg" });
  const round = (v: number) => Math.round(v * 10000) / 10000;
  return { path: out, width: outW, height: outH, rect: { x: round(r.x / IW), y: round(r.y / IH), width: round(r.width / IW), height: round(r.height / IH) } };
}

// ---------------------------------------------------------------------------------------------
// Grids

export const GridInputShape = {
  images: z.array(z.string()).min(1).max(60).describe("Images to lay out, in order: mockups, screenshots, crops."),
  columns: z.number().int().min(1).max(12).optional().describe("Images per row. Default: what suits the count (a set of 3–6 goes in one row)."),
  width: z.number().int().min(200).max(8192).optional().describe("Output width in px. Default 2400. The height follows from the rows."),
  gap: z.number().min(0).optional().describe("Space between images: a fraction of the width (≤ 0.2) or px. Default 0.016."),
  padding: z.number().min(0).optional().describe("Margin around the grid, like gap. Default 1.5 × gap."),
  radius: z.number().min(0).optional().describe("Corner radius of each image, as a fraction of its shorter side (≤ 0.5) or px. Default 0.03."),
  shadow: z.boolean().optional().describe("Soft shadow under each image. Default true."),
  fit: z
    .enum(["rows", "cells"])
    .optional()
    .describe("rows: every image whole, each row scaled to the full width (a contact sheet). cells: equal cells, images cropped to fill them (a mosaic). Default rows."),
  cellAspect: z.number().positive().optional().describe("cells: each cell's width ÷ height. Default: the first image's."),
  labels: z.array(z.string()).optional().describe("A caption under each image, in order."),
  background: BackgroundSchema.optional().describe("Behind the grid: any colour, gradient, look or photo. Default a soft light grey."),
  format: z.enum(["png", "jpeg", "webp"]).optional(),
  output: z.string().optional().describe("Output file or directory. Default ./screenshots/grids/."),
  preview: z.boolean().optional().describe("Return a preview image. Default true."),
};
const GridInputSchema = z.object(GridInputShape);
export type GridInput = z.infer<typeof GridInputSchema>;

export async function createGrid(raw: GridInput): Promise<{ path: string; width: number; height: number; warnings: string[] }> {
  const input = GridInputSchema.parse(raw);
  const files = input.images.map(resolveUserPath);
  const sizes = await Promise.all(files.map(imageSize));
  const n = files.length;
  const W = input.width ?? 2400;
  const px = (v: number | undefined, fallback: number) => (v === undefined ? fallback : v <= 0.2 ? v * W : v);
  const gap = px(input.gap, 0.016 * W);
  const pad = input.padding === undefined ? gap * 1.5 : px(input.padding, gap * 1.5);
  const cols = input.columns ?? (n <= 6 ? n : n <= 8 ? 4 : n <= 12 ? 4 : 5);
  const labelH = input.labels?.length ? Math.round(W * 0.016) * 2.2 : 0;
  const fontSize = Math.round(W * 0.0125);

  // Tile boxes, row by row.
  const tiles: Array<{ x: number; y: number; w: number; h: number; i: number }> = [];
  let y = pad;
  const inner = W - pad * 2;
  for (let start = 0; start < n; start += cols) {
    const row = [...Array(Math.min(cols, n - start)).keys()].map((k) => start + k);
    if (input.fit === "cells") {
      const aspect = input.cellAspect ?? sizes[0].width / sizes[0].height;
      const cw = (inner - gap * (cols - 1)) / cols;
      const ch = cw / aspect;
      // A short last row stays centred.
      let x = pad + ((cols - row.length) * (cw + gap)) / 2;
      for (const i of row) {
        tiles.push({ x, y, w: cw, h: ch, i });
        x += cw + gap;
      }
      y += ch + labelH + gap;
    } else {
      // Justified row: one height for the row, so the images fill the width exactly. A short last
      // row keeps the full rows' height rather than blowing up.
      const aspects = row.map((i) => sizes[i].width / sizes[i].height);
      let h = (inner - gap * (row.length - 1)) / aspects.reduce((a, b) => a + b, 0);
      const full = tiles.length ? tiles[tiles.length - 1].h : h;
      if (row.length < cols && start > 0) h = Math.min(h, full);
      const rowW = aspects.reduce((a, b) => a + b * h, 0) + gap * (row.length - 1);
      let x = pad + (inner - rowW) / 2;
      row.forEach((i, k) => {
        const w = aspects[k] * h;
        tiles.push({ x, y, w, h, i });
        x += w + gap;
      });
      y += h + labelH + gap;
    }
  }
  const H = Math.round(y - gap + pad);

  const warnings: string[] = [];
  const bg = await resolveBackground(input.background ?? "#eceef1", W, H, files[0], warnings, averageColor);
  const textColor = bg.tone === "dark" ? "rgba(255,255,255,.82)" : "rgba(0,0,0,.72)";
  const shadow = input.shadow === false ? "" : "box-shadow:0 10px 36px rgba(0,0,0,.16), 0 2px 6px rgba(0,0,0,.08);";
  const body = tiles
    .map((t) => {
      const r = input.radius === undefined ? Math.min(t.w, t.h) * 0.03 : input.radius <= 0.5 ? Math.min(t.w, t.h) * input.radius : input.radius;
      const label = input.labels?.[t.i];
      return (
        `<div style="position:absolute;left:${t.x}px;top:${t.y}px;width:${t.w}px;height:${t.h}px;border-radius:${r}px;overflow:hidden;${shadow}">` +
        `<img src="${esc(pathToFileURL(files[t.i]).href)}" style="width:100%;height:100%;object-fit:cover;display:block"></div>` +
        (label
          ? `<div style="position:absolute;left:${t.x}px;top:${t.y + t.h + labelH * 0.2}px;width:${t.w}px;text-align:center;font:500 ${fontSize}px -apple-system, system-ui, sans-serif;color:${textColor};white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(label)}</div>`
          : "")
      );
    })
    .join("");
  const format = input.format ?? formatOf(input.output) ?? "png";
  const out = outputPathFor(input.output, "grids", "grid", format === "jpeg" ? "jpg" : format);
  const html =
    `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0}#c{position:relative;width:${W}px;height:${H}px;overflow:hidden}.bg{position:absolute;inset:0;overflow:hidden}</style></head>` +
    `<body><svg width="0" height="0" style="position:absolute"><defs>${bg.defs}</defs></svg><div id="c">${bg.html}${body}</div></body></html>`;
  await renderHtml(html, out, W, H, { scale: 1, format, transparent: false });
  return { path: out, width: W, height: H, warnings };
}
