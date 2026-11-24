/**
 * Bakes Figma image paint adjustments (`paintFilter`: exposure, contrast, vibrance/saturation,
 * highlights, shadows, temperature, tint) and per-fill image opacity into cached PNGs so multi-fill
 * CSS blending (e.g. grayscale portrait + neon-lime MULTIPLY) matches Figma pixel-for-pixel.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { newPage } from "../render/browser.js";
import { libraryFolder } from "../util/files.js";
import type { FigDoc, FNode } from "./fig-convert.js";

export interface PaintAdjust {
  exposure: number;
  contrast: number;
  vibrance: number;
  saturation: number;
  highlights: number;
  shadows: number;
  temperature: number;
  tint: number;
  opacity: number;
}

const r3 = (n: number) => Math.round(n * 1000) / 1000;

/** Extract active Figma paint adjustments + opacity from an IMAGE or VIDEO paint, or null if untouched. */
export function paintAdjustOf(p: any): PaintAdjust | null {
  if (!p || (p.type !== "IMAGE" && p.type !== "VIDEO")) return null;
  const f = p.paintFilter ?? {};
  const adj: PaintAdjust = {
    exposure: r3(f.exposure ?? 0),
    contrast: r3(f.contrast ?? 0),
    vibrance: r3(f.vibrance ?? 0),
    saturation: r3(f.saturation ?? 0),
    highlights: r3(f.highlights ?? 0),
    shadows: r3(f.shadows ?? 0),
    temperature: r3(f.temperature ?? 0),
    tint: r3(f.tint ?? 0),
    opacity: r3(p.opacity ?? 1),
  };
  const active =
    Math.abs(adj.exposure) > 0.002 ||
    Math.abs(adj.contrast) > 0.002 ||
    Math.abs(adj.vibrance) > 0.002 ||
    Math.abs(adj.saturation) > 0.002 ||
    Math.abs(adj.highlights) > 0.002 ||
    Math.abs(adj.shadows) > 0.002 ||
    Math.abs(adj.temperature) > 0.002 ||
    Math.abs(adj.tint) > 0.002 ||
    adj.opacity < 0.998;
  return active ? adj : null;
}

export function hashHexOf(hash: Uint8Array | string | undefined): string {
  if (!hash) return "";
  if (typeof hash === "string") return hash;
  return Buffer.from(hash).toString("hex");
}

export function filteredImageKey(hex: string, adj: PaintAdjust): string {
  const sig = createHash("sha1").update(JSON.stringify(adj)).digest("hex").slice(0, 12);
  return `${hex}:${sig}`;
}

/** Collect and bake every adjusted image/video fill used in `trees` into cached PNGs in one browser pass. */
export async function bakeFilteredImages(d: FigDoc, trees: FNode[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const todo = new Map<string, { hex: string; adj: PaintAdjust; file: string; bytes: Buffer }>();
  const dir = path.join(libraryFolder(), "images", "figma");

  const inspectPaints = (list: any[] | undefined) => {
    for (const p of list ?? []) {
      if (!p || p.visible === false) continue;
      const adj = paintAdjustOf(p);
      if (!adj) continue;
      const hex = hashHexOf(p.image?.hash) || hashHexOf(p.imageThumbnail?.hash);
      if (!hex) continue;
      const key = filteredImageKey(hex, adj);
      if (out.has(key) || todo.has(key)) continue;
      const sig = key.split(":")[1];
      const file = path.join(dir, `${hex.slice(0, 20)}_${sig}.png`);
      if (existsSync(file)) {
        out.set(key, file);
        continue;
      }
      const bytes = d.images.get(hex);
      if (bytes) todo.set(key, { hex, adj, file, bytes });
    }
  };

  const walk = (n: FNode) => {
    if (n.visible === false) return;
    inspectPaints(n.fillPaints);
    inspectPaints(n.strokePaints);
    if (n.styleIdForFill) {
      const ref = n.styleIdForFill;
      const style = (ref.guid ? d.byId.get(`${ref.guid.sessionID}:${ref.guid.localID}`) : undefined) ?? (ref.assetRef?.key ? d.styles.get(ref.assetRef.key) : undefined);
      inspectPaints(style?.fillPaints);
    }
    for (const c of n.children ?? []) walk(c);
  };
  for (const t of trees) walk(t);

  if (!todo.size) return out;
  mkdirSync(dir, { recursive: true });

  const page = await newPage();
  try {
    await page.setContent("<!doctype html><html><body></body></html>");
    for (const [key, job] of todo) {
      const mime = job.bytes[0] === 0xff && job.bytes[1] === 0xd8 ? "image/jpeg" : job.bytes[0] === 0x52 && job.bytes[1] === 0x49 ? "image/webp" : "image/png";
      const dataUrl = `data:${mime};base64,${job.bytes.toString("base64")}`;
      const pngBase64: string | null = await page.evaluate(
        async (src: string, adj: PaintAdjust) => {
          const img = new Image();
          await new Promise<void>((ok, no) => {
            img.onload = () => ok();
            img.onerror = () => no(new Error("decode failed"));
            img.src = src;
          });
          const w = img.naturalWidth;
          const h = img.naturalHeight;
          if (!w || !h) return null;
          const cv = document.createElement("canvas");
          cv.width = w;
          cv.height = h;
          const ctx = cv.getContext("2d")!;
          ctx.drawImage(img, 0, 0);
          const id = ctx.getImageData(0, 0, w, h);
          const d = id.data;
          const expMul = Math.pow(2, adj.exposure * 1.15);
          const conMul = adj.contrast >= 0 ? 1 + adj.contrast * 1.15 : 1 + adj.contrast * 0.65;
          const satMul = Math.max(0, 1 + adj.vibrance + adj.saturation);
          const hl = adj.highlights;
          const sh = adj.shadows;
          const temp = adj.temperature * 0.18;
          const tint = adj.tint * 0.18;
          const op = adj.opacity;
          for (let i = 0; i < d.length; i += 4) {
            let r = d[i] / 255;
            let g = d[i + 1] / 255;
            let b = d[i + 2] / 255;
            // Exposure
            if (adj.exposure) {
              r *= expMul;
              g *= expMul;
              b *= expMul;
            }
            // Temperature & tint
            if (temp || tint) {
              r += temp + tint * 0.4;
              g -= tint * 0.6;
              b -= temp - tint * 0.4;
            }
            // Highlights & shadows (smooth tonal curves)
            if (hl || sh) {
              const l = Math.max(0, Math.min(1, 0.2126 * r + 0.7152 * g + 0.0722 * b));
              const sw = (1 - l) * (1 - l);
              const hw = l * l;
              const delta = sh * sw * 0.42 + hl * hw * 0.42;
              r += delta;
              g += delta;
              b += delta;
            }
            // Contrast
            if (adj.contrast) {
              r = (r - 0.5) * conMul + 0.5;
              g = (g - 0.5) * conMul + 0.5;
              b = (b - 0.5) * conMul + 0.5;
            }
            // Saturation / Figma vibrance slider (-1 = full grayscale)
            if (adj.vibrance || adj.saturation) {
              const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
              r = l + (r - l) * satMul;
              g = l + (g - l) * satMul;
              b = l + (b - l) * satMul;
            }
            d[i] = r <= 0 ? 0 : r >= 1 ? 255 : Math.round(r * 255);
            d[i + 1] = g <= 0 ? 0 : g >= 1 ? 255 : Math.round(g * 255);
            d[i + 2] = b <= 0 ? 0 : b >= 1 ? 255 : Math.round(b * 255);
            if (op < 0.998) d[i + 3] = Math.round(d[i + 3] * op);
          }
          ctx.putImageData(id, 0, 0);
          return cv.toDataURL("image/png").split(",")[1] ?? null;
        },
        dataUrl,
        job.adj,
      );
      if (pngBase64) {
        writeFileSync(job.file, Buffer.from(pngBase64, "base64"));
        out.set(key, job.file);
      }
    }
  } finally {
    await page.close().catch(() => undefined);
  }
  return out;
}
