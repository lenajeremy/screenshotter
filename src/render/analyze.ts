import { readFileSync, statSync } from "node:fs";
import type { DeviceModel } from "../devices/catalog.js";
import { newPage } from "./browser.js";
import { ISLAND, islandTop, type ScreenshotFacts } from "./frame.js";

const cache = new Map<string, ScreenshotFacts>();

/**
 * Look at the capture's pixels: does it already contain a Dynamic Island (simulator captures
 * do, captures from a real device don't), and which way is a landscape capture facing?
 */
export async function analyzeScreenshot(
  file: string,
  model: DeviceModel,
  size: { width: number; height: number },
): Promise<ScreenshotFacts> {
  const fallback: ScreenshotFacts = { hasIsland: false, topSide: "left" };
  if (model.cutout !== "island") return fallback;
  const key = `${file}:${statSync(file).mtimeMs}:${model.id}`;
  const cached = cache.get(key);
  if (cached) return cached;

  const sw = model.screen.width / model.screen.scale;
  const landscape = size.width > size.height;
  // Probe points in screenshot pixels, scaled in case the capture was resized.
  const k = Math.min(size.width, size.height) / (sw * model.screen.scale);
  const px = (pt: number) => pt * model.screen.scale * k;
  const probe = {
    across: px(islandTop(sw) + ISLAND.height / 2),
    half: px(ISLAND.width * 0.3),
  };

  const page = await newPage();
  try {
    const data = readFileSync(file).toString("base64");
    const mime = file.toLowerCase().endsWith(".png") ? "image/png" : "image/jpeg";
    const result = await page.evaluate(
      async (src, landscape, probe) => {
        const img = new Image();
        img.src = src;
        await img.decode();
        const canvas = new OffscreenCanvas(img.width, img.height);
        const ctx = canvas.getContext("2d")!;
        ctx.drawImage(img, 0, 0);
        const px = ctx.getImageData(0, 0, img.width, img.height).data;
        const black = (x: number, y: number) => {
          const i = (Math.round(y) * img.width + Math.round(x)) * 4;
          return px[i] < 10 && px[i + 1] < 10 && px[i + 2] < 10;
        };
        // Fraction of black pixels along a short line through where the island would be.
        const line = (cx: number, cy: number, vertical: boolean) => {
          let hits = 0;
          const steps = 24;
          for (let s = 0; s <= steps; s++) {
            const t = -probe.half + (2 * probe.half * s) / steps;
            if (black(vertical ? cx : cx + t, vertical ? cy + t : cy)) hits++;
          }
          return hits / (steps + 1);
        };
        if (!landscape) return { top: line(img.width / 2, probe.across, false), left: 0, right: 0 };
        return {
          top: 0,
          left: line(probe.across, img.height / 2, true),
          right: line(img.width - probe.across, img.height / 2, true),
        };
      },
      `data:${mime};base64,${data}`,
      landscape,
      probe,
    );
    const facts: ScreenshotFacts = landscape
      ? {
          hasIsland: Math.max(result.left, result.right) > 0.9,
          topSide: result.right > result.left + 0.2 ? "right" : "left",
        }
      : { hasIsland: result.top > 0.9, topSide: "left" };
    cache.set(key, facts);
    return facts;
  } catch {
    return fallback;
  } finally {
    await page.close().catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------------------------
// Pixel helpers for backgrounds and highlights

async function withImage<T, A extends unknown[]>(
  file: string,
  fn: (src: string, ...args: A) => Promise<T>,
  ...args: A
): Promise<T> {
  const page = await newPage();
  try {
    const lower = file.toLowerCase();
    const mime = lower.endsWith(".png") ? "image/png" : lower.endsWith(".webp") ? "image/webp" : "image/jpeg";
    const src = `data:${mime};base64,${readFileSync(file).toString("base64")}`;
    return (await page.evaluate(fn as any, src, ...args)) as T;
  } finally {
    await page.close().catch(() => undefined);
  }
}

const avgCache = new Map<string, string | undefined>();

/** Average colour of an image as #rrggbb. */
export async function averageColor(file: string): Promise<string | undefined> {
  const key = `${file}:${statSync(file).mtimeMs}`;
  if (avgCache.has(key)) return avgCache.get(key);
  let result: string | undefined;
  try {
    result = await withImage(file, async (src: string) => {
      const img = new Image();
      img.src = src;
      await img.decode();
      const c = new OffscreenCanvas(16, 16);
      const ctx = c.getContext("2d")!;
      ctx.drawImage(img, 0, 0, 16, 16);
      const d = ctx.getImageData(0, 0, 16, 16).data;
      let r = 0, g = 0, b = 0;
      for (let i = 0; i < d.length; i += 4) {
        r += d[i];
        g += d[i + 1];
        b += d[i + 2];
      }
      const n = d.length / 4;
      const hex = (v: number) => Math.round(v / n).toString(16).padStart(2, "0");
      return `#${hex(r)}${hex(g)}${hex(b)}`;
    });
  } catch {
    result = undefined;
  }
  avgCache.set(key, result);
  return result;
}

export interface Palette {
  /** Dominant colours, most common first, with their share of the image (0–1). */
  colors: Array<{ hex: string; share: number }>;
  /** The most saturated colour that's used a fair amount: usually the app's accent/brand colour. */
  accent?: string;
  /** Whether the UI is mostly dark or light. */
  tone: "dark" | "light";
}

const paletteCache = new Map<string, Palette | undefined>();

/**
 * The colours of a screenshot, for design decisions: its dominant colours, its accent (the most
 * saturated colour with a real presence) and whether the UI is dark or light.
 */
export function screenshotPalette(file: string): Promise<Palette | undefined> {
  // Callers asking about the same screenshot at once share one reading.
  const key = `${file}:${statSync(file).mtimeMs}`;
  let job = paletteJobs.get(key);
  if (!job) {
    job = readPalette(file).finally(() => paletteJobs.delete(key));
    paletteJobs.set(key, job);
  }
  return job;
}
const paletteJobs = new Map<string, Promise<Palette | undefined>>();

async function readPalette(file: string): Promise<Palette | undefined> {
  const key = `${file}:${statSync(file).mtimeMs}`;
  if (paletteCache.has(key)) return paletteCache.get(key);
  let result: Palette | undefined;
  try {
    result = await withImage(file, async (src: string) => {
      const img = new Image();
      img.src = src;
      await img.decode();
      const w = 72;
      const h = Math.max(1, Math.round((w * img.height) / img.width));
      const c = new OffscreenCanvas(w, h);
      const ctx = c.getContext("2d")!;
      ctx.drawImage(img, 0, 0, w, h);
      const d = ctx.getImageData(0, 0, w, h).data;
      // Bucket colours (5 bits per channel), then merge buckets that look alike.
      const buckets = new Map<number, { r: number; g: number; b: number; n: number }>();
      let lum = 0;
      for (let i = 0; i < d.length; i += 4) {
        const [r, g, b] = [d[i], d[i + 1], d[i + 2]];
        lum += 0.2126 * r + 0.7152 * g + 0.0722 * b;
        const k = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
        const e = buckets.get(k) ?? { r: 0, g: 0, b: 0, n: 0 };
        e.r += r;
        e.g += g;
        e.b += b;
        e.n++;
        buckets.set(k, e);
      }
      const total = d.length / 4;
      const groups: Array<{ r: number; g: number; b: number; n: number }> = [];
      for (const e of [...buckets.values()].sort((a, b) => b.n - a.n)) {
        const c0 = { r: e.r / e.n, g: e.g / e.n, b: e.b / e.n };
        const near = groups.find((g) => Math.hypot(g.r / g.n - c0.r, g.g / g.n - c0.g, g.b / g.n - c0.b) < 34);
        if (near) {
          near.r += e.r;
          near.g += e.g;
          near.b += e.b;
          near.n += e.n;
        } else groups.push({ ...e });
      }
      groups.sort((a, b) => b.n - a.n);
      const hex = (g: { r: number; g: number; b: number; n: number }) =>
        "#" + [g.r, g.g, g.b].map((v) => Math.round(v / g.n).toString(16).padStart(2, "0")).join("");
      const sat = (g: { r: number; g: number; b: number; n: number }) => {
        const [r, gg, b] = [g.r / g.n, g.g / g.n, g.b / g.n];
        const mx = Math.max(r, gg, b);
        const mn = Math.min(r, gg, b);
        return mx === 0 ? 0 : (mx - mn) / mx;
      };
      const colors = groups.slice(0, 6).map((g) => ({ hex: hex(g), share: Math.round((g.n / total) * 1000) / 1000 }));
      const accent = groups.filter((g) => g.n / total > 0.004 && sat(g) > 0.35).sort((a, b) => sat(b) * Math.sqrt(b.n) - sat(a) * Math.sqrt(a.n))[0];
      return { colors, accent: accent ? hex(accent) : undefined, tone: lum / total / 255 > 0.45 ? "light" : "dark" } as Palette;
    });
  } catch {
    result = undefined;
  }
  paletteCache.set(key, result);
  return result;
}

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Grow a text box to the row or card that contains it by walking outwards until the
 * background colour changes. Returns the card box and its fill colour.
 */
export async function detectRow(file: string, box: Box): Promise<(Box & { color: string }) | undefined> {
  try {
    return await withImage(
      file,
      async (src: string, b: Box) => {
        const img = new Image();
        img.src = src;
        await img.decode();
        const W = img.width;
        const H = img.height;
        const c = new OffscreenCanvas(W, H);
        const ctx = c.getContext("2d")!;
        ctx.drawImage(img, 0, 0);
        const d = ctx.getImageData(0, 0, W, H).data;
        const at = (x: number, y: number) => {
          const i = (Math.max(0, Math.min(H - 1, Math.round(y))) * W + Math.max(0, Math.min(W - 1, Math.round(x)))) * 4;
          return [d[i], d[i + 1], d[i + 2]];
        };
        const diff = (a: number[], q: number[]) => Math.abs(a[0] - q[0]) + Math.abs(a[1] - q[1]) + Math.abs(a[2] - q[2]);
        const cy = b.y + b.height / 2;
        // Sample the row colour just right of the text, then left of it and above/below;
        // the most common of these is the row background (icons and chevrons are outliers).
        const candidates = [
          [b.x + b.width + Math.max(6, b.height * 0.4), cy],
          [b.x + b.width + b.height * 1.2, cy],
          [b.x - Math.max(4, b.height * 0.25), cy],
          [b.x + b.width / 2, b.y - Math.max(3, b.height * 0.2)],
          [b.x + b.width / 2, b.y + b.height + Math.max(3, b.height * 0.2)],
        ].filter(([x, y]) => x >= 0 && x < W && y >= 0 && y < H);
        const colors = candidates.map(([x, y]) => at(x, y));
        let bg = colors[0];
        let best = -1;
        for (const c of colors) {
          const votes = colors.filter((o) => diff(o, c) < 18).length;
          if (votes > best) {
            best = votes;
            bg = c;
          }
        }
        const probeX = candidates[colors.findIndex((c) => diff(c, bg) < 18)]?.[0] ?? b.x + b.width + 6;
        const same = (x: number, y: number) => diff(at(x, y), bg) < 18;
        const maxV = b.height * 3.2;
        let top = b.y;
        while (top > 0 && b.y - top < maxV && same(probeX, top - 1)) top--;
        let bottom = b.y + b.height;
        while (bottom < H - 1 && bottom - (b.y + b.height) < maxV && same(probeX, bottom + 1)) bottom++;
        // No edge found (plain list, no card): keep the row to the text with a little air.
        if (b.y - top >= maxV) top = Math.max(0, b.y - b.height * 0.6);
        if (bottom - (b.y + b.height) >= maxV) bottom = Math.min(H - 1, b.y + b.height * 1.6);
        const scanY = top + Math.max(3, (bottom - top) * 0.14);
        let left = probeX;
        while (left > 0 && same(left - 1, scanY)) left--;
        let right = probeX;
        while (right < W - 1 && same(right + 1, scanY)) right++;
        const hex = (v: number) => v.toString(16).padStart(2, "0");
        return { x: left, y: top, width: right - left, height: bottom - top, color: `#${hex(bg[0])}${hex(bg[1])}${hex(bg[2])}` };
      },
      box,
    );
  } catch {
    return undefined;
  }
}
