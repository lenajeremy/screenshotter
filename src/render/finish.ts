/**
 * Background finishes: print or paint the background (never the UI) as a risograph, newsprint,
 * halftone, one-bit dither, oil painting, watercolor or ink wash, or set it behind fluted glass.
 *
 * The background is rendered on its own, its pixels are processed in a browser canvas, and the
 * result replaces it as a flat image. Results are cached by background, size and finish.
 */
import { createHash } from "node:crypto";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { cacheDir } from "../util/files.js";
import { esc, type ResolvedBackground } from "./background.js";
import { newPage } from "./browser.js";
import { FINISHES, type BackgroundObject } from "./schema.js";

export type FinishStyle = (typeof FINISHES)[number];
export type FinishInput = NonNullable<BackgroundObject["finish"]>;

interface FinishOptions {
  style: FinishStyle;
  colors: string[];
  scale: number;
  amount: number;
}

const normalize = (f: FinishInput): FinishOptions =>
  typeof f === "string" ? { style: f, colors: [], scale: 1, amount: 1 } : { style: f.style, colors: f.colors ?? [], scale: f.scale ?? 1, amount: f.amount ?? 1 };

/** Apply a finish to a resolved background: returns the layers that replace its html and defs. */
export async function finishBackground(bg: ResolvedBackground, W: number, H: number, finish: FinishInput): Promise<{ html: string; defs: string }> {
  const opts = normalize(finish);
  const W0 = Math.round(W);
  const H0 = Math.round(H);
  const key = createHash("sha1").update(JSON.stringify([bg.html, bg.defs, W0, H0, opts, 3])).digest("hex").slice(0, 24);
  const out = path.join(cacheDir("finishes"), `${key}.png`);
  if (!existsSync(out)) {
    const page = await newPage();
    try {
      await page.setViewport({ width: W0, height: H0, deviceScaleFactor: 1 });
      // A file page, so the background can load local photos.
      const htmlFile = `${out}.html`;
      writeFileSync(
        htmlFile,
        `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;padding:0}#c{position:relative;width:${W0}px;height:${H0}px;overflow:hidden}.bg{position:absolute;inset:0;overflow:hidden}</style></head>` +
          `<body><svg width="0" height="0" style="position:absolute"><defs>${bg.defs}</defs></svg><div id="c">${bg.html}</div></body></html>`,
      );
      try {
        await page.goto(pathToFileURL(htmlFile).href, { waitUntil: "load", timeout: 60_000 });
      } finally {
        rmSync(htmlFile, { force: true });
      }
      await page.evaluate(async () => {
        await Promise.all(Array.from(document.images).map((img) => (img.complete ? Promise.resolve() : img.decode().catch(() => undefined))));
        const broken = Array.from(document.images).filter((img) => !img.naturalWidth);
        if (broken.length) throw new Error("The background image couldn't be loaded for its finish.");
      });
      const shot = (await page.screenshot({ type: "png", clip: { x: 0, y: 0, width: W0, height: H0 }, encoding: "base64" })) as string;
      const png = await page.evaluate(runFinish, `data:image/png;base64,${shot}`, opts);
      writeFileSync(out, Buffer.from(png, "base64"));
    } finally {
      await page.close().catch(() => undefined);
    }
  }
  return { html: `<div class="bg" style="background:url(&quot;${esc(pathToFileURL(out).href)}&quot;) 0 0 / 100% 100% no-repeat"></div>`, defs: "" };
}

/**
 * Runs in the page: decode the image, process its pixels, return the result as base64 PNG.
 * Self-contained (it's serialised into the browser), so every helper lives inside it.
 */
async function runFinish(src: string, o: FinishOptions): Promise<string> {
  const img = new Image();
  img.src = src;
  await img.decode();
  const W = img.naturalWidth;
  const H = img.naturalHeight;
  const N = W * H;
  const canvas = new OffscreenCanvas(W, H);
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(img, 0, 0);
  const image = ctx.getImageData(0, 0, W, H);
  const d = image.data;
  const orig = new Uint8ClampedArray(d);

  // ---- helpers
  const hex = (h: string | undefined, fallback: string): [number, number, number] => {
    const m = /^#?([0-9a-f]{6})$/i.exec((h ?? fallback).trim()) ?? /^#?([0-9a-f]{6})$/i.exec(fallback)!;
    const n = parseInt(m[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  };
  const clamp = (v: number, a = 0, b = 1) => (v < a ? a : v > b ? b : v);
  const smooth = (a: number, b: number, x: number) => {
    const t = clamp((x - a) / (b - a));
    return t * t * (3 - 2 * t);
  };
  let seed = 1234567;
  const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  // One unit ≈ 1px on a canvas whose short side is 1000px.
  const u = (Math.min(W, H) / 1000) * o.scale;

  /** Box blur of a single channel (w × h), repeated for a smoother, gaussian-like result. */
  const blur = (a: Float32Array, w: number, h: number, r: number, passes = 2): Float32Array => {
    r = Math.max(0, Math.round(r));
    if (!r) return a;
    let src = a;
    let tmp = new Float32Array(w * h);
    for (let p = 0; p < passes; p++) {
      const out = new Float32Array(w * h);
      for (let y = 0; y < h; y++) {
        let acc = 0;
        const row = y * w;
        for (let x = -r; x <= r; x++) acc += src[row + clamp(x, 0, w - 1)];
        for (let x = 0; x < w; x++) {
          tmp[row + x] = acc / (2 * r + 1);
          acc += src[row + Math.min(w - 1, x + r + 1)] - src[row + Math.max(0, x - r)];
        }
      }
      for (let x = 0; x < w; x++) {
        let acc = 0;
        for (let y = -r; y <= r; y++) acc += tmp[clamp(y, 0, h - 1) * w + x];
        for (let y = 0; y < h; y++) {
          out[y * w + x] = acc / (2 * r + 1);
          acc += tmp[Math.min(h - 1, y + r + 1) * w + x] - tmp[Math.max(0, y - r) * w + x];
        }
      }
      src = out;
      tmp = new Float32Array(w * h);
    }
    return src;
  };
  const channels = (px: Uint8ClampedArray, n: number) => {
    const r = new Float32Array(n);
    const g = new Float32Array(n);
    const b = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      r[i] = px[i * 4] / 255;
      g[i] = px[i * 4 + 1] / 255;
      b[i] = px[i * 4 + 2] / 255;
    }
    return { r, g, b };
  };
  const lumOf = (r: Float32Array, g: Float32Array, b: Float32Array) => {
    const l = new Float32Array(r.length);
    for (let i = 0; i < l.length; i++) l[i] = 0.299 * r[i] + 0.587 * g[i] + 0.114 * b[i];
    return l;
  };
  /** Smooth value noise in [0, 1], `cell` px across. */
  const noise = (w: number, h: number, cell: number) => {
    const raw = new Float32Array(w * h);
    for (let i = 0; i < raw.length; i++) raw[i] = rand();
    const n = blur(raw, w, h, cell, 2);
    let lo = 1;
    let hi = 0;
    for (const v of n) (lo = Math.min(lo, v)), (hi = Math.max(hi, v));
    for (let i = 0; i < n.length; i++) n[i] = (n[i] - lo) / (hi - lo || 1);
    return n;
  };
  const put = (i: number, r: number, g: number, b: number) => {
    d[i * 4] = r;
    d[i * 4 + 1] = g;
    d[i * 4 + 2] = b;
    d[i * 4 + 3] = 255;
  };
  /** Work at a reduced size (painterly finishes), then scale back up. */
  const reduced = (k: number) => {
    const w = Math.max(1, Math.round(W / k));
    const h = Math.max(1, Math.round(H / k));
    const c = new OffscreenCanvas(w, h);
    const x = c.getContext("2d")!;
    x.drawImage(img, 0, 0, w, h);
    return { w, h, c, x, px: x.getImageData(0, 0, w, h) };
  };
  const upscale = (c: OffscreenCanvas) => {
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(c, 0, 0, W, H);
    image.data.set(ctx.getImageData(0, 0, W, H).data);
  };
  /**
   * Kuwahara filter (flattens detail into painted patches while keeping edges): each pixel takes
   * the mean colour of whichever of its four quadrants varies least. Summed-area tables make each
   * quadrant O(1).
   */
  const kuwahara = (px: ImageData, w: number, h: number, r: number) => {
    const s = px.data;
    const W1 = w + 1;
    const sat = [0, 1, 2, 3].map(() => new Float64Array(W1 * (h + 1)));
    for (let y = 0; y < h; y++) {
      const rs = [0, 0, 0, 0];
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        const l = 0.299 * s[i] + 0.587 * s[i + 1] + 0.114 * s[i + 2];
        rs[0] += s[i];
        rs[1] += s[i + 1];
        rs[2] += s[i + 2];
        rs[3] += l * l;
        const j = (y + 1) * W1 + x + 1;
        for (let c = 0; c < 4; c++) sat[c][j] = sat[c][j - W1] + rs[c];
      }
    }
    const satL = new Float64Array(W1 * (h + 1));
    for (let y = 0; y < h; y++) {
      let rsum = 0;
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        rsum += 0.299 * s[i] + 0.587 * s[i + 1] + 0.114 * s[i + 2];
        const j = (y + 1) * W1 + x + 1;
        satL[j] = satL[j - W1] + rsum;
      }
    }
    const box = (t: Float64Array, x0: number, y0: number, x1: number, y1: number) => t[y1 * W1 + x1] - t[y0 * W1 + x1] - t[y1 * W1 + x0] + t[y0 * W1 + x0];
    const out = new Uint8ClampedArray(s.length);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let best = Infinity;
        let br = 0;
        let bg = 0;
        let bb = 0;
        for (const [dx, dy] of [
          [-1, -1],
          [1, -1],
          [-1, 1],
          [1, 1],
        ]) {
          const x0 = clamp(dx < 0 ? x - r : x, 0, w - 1);
          const x1 = clamp(dx < 0 ? x : x + r, 0, w - 1) + 1;
          const y0 = clamp(dy < 0 ? y - r : y, 0, h - 1);
          const y1 = clamp(dy < 0 ? y : y + r, 0, h - 1) + 1;
          const n = (x1 - x0) * (y1 - y0);
          const ml = box(satL, x0, y0, x1, y1) / n;
          const v = box(sat[3], x0, y0, x1, y1) / n - ml * ml;
          if (v < best) {
            best = v;
            br = box(sat[0], x0, y0, x1, y1) / n;
            bg = box(sat[1], x0, y0, x1, y1) / n;
            bb = box(sat[2], x0, y0, x1, y1) / n;
          }
        }
        const i = (y * w + x) * 4;
        out[i] = br;
        out[i + 1] = bg;
        out[i + 2] = bb;
        out[i + 3] = 255;
      }
    }
    return out;
  };
  /** Screen coordinates rotated into a halftone grid: returns the cell centre and distance to it. */
  const grid = (x: number, y: number, cell: number, angle: number) => {
    const ca = Math.cos(angle);
    const sa = Math.sin(angle);
    const gu = x * ca + y * sa;
    const gv = -x * sa + y * ca;
    const cu = (Math.floor(gu / cell) + 0.5) * cell;
    const cv = (Math.floor(gv / cell) + 0.5) * cell;
    return { cx: cu * ca - cv * sa, cy: cu * sa + cv * ca, dist: Math.hypot(gu - cu, gv - cv) };
  };

  const { r: R, g: G, b: B } = channels(orig, N);
  const L = lumOf(R, G, B);

  switch (o.style) {
    case "dither": {
      // One-bit error diffusion (Floyd–Steinberg) at a coarse dot, in two tones.
      const [dark, light] = [hex(o.colors[0], "#151515"), hex(o.colors[1], "#f2f0eb")];
      const dot = Math.max(1, Math.round(1.6 * u));
      const w = Math.ceil(W / dot);
      const h = Math.ceil(H / dot);
      const e = new Float32Array(w * h);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) e[y * w + x] = clamp((L[Math.min(H - 1, y * dot) * W + Math.min(W - 1, x * dot)] - 0.5) * 1.25 + 0.52);
      const bit = new Uint8Array(w * h);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const i = y * w + x;
          const v = e[i];
          const on = v > 0.5 ? 1 : 0;
          bit[i] = on;
          const err = v - on;
          if (x + 1 < w) e[i + 1] += (err * 7) / 16;
          if (y + 1 < h) {
            if (x > 0) e[i + w - 1] += (err * 3) / 16;
            e[i + w] += (err * 5) / 16;
            if (x + 1 < w) e[i + w + 1] += err / 16;
          }
        }
      }
      for (let y = 0; y < H; y++)
        for (let x = 0; x < W; x++) {
          const c = bit[((y / dot) | 0) * w + ((x / dot) | 0)] ? light : dark;
          put(y * W + x, c[0], c[1], c[2]);
        }
      break;
    }
    case "halftone": {
      // Large rotated dots in the picture's own colours, on a pale tint of it.
      const paper = hex(o.colors[0], "#f4f0e6");
      const cell = Math.max(5, 11 * u);
      const r = blur(R, W, H, cell / 2);
      const g = blur(G, W, H, cell / 2);
      const b = blur(B, W, H, cell / 2);
      for (let y = 0; y < H; y++)
        for (let x = 0; x < W; x++) {
          const q = grid(x, y, cell, Math.PI / 4);
          const j = clamp(Math.round(q.cy), 0, H - 1) * W + clamp(Math.round(q.cx), 0, W - 1);
          const l = 0.299 * r[j] + 0.587 * g[j] + 0.114 * b[j];
          const rad = cell * 0.5 * Math.sqrt(clamp(1 - l)) * 1.3;
          const cov = smooth(rad + 0.8, rad - 0.8, q.dist);
          const ink = [r[j] * 0.78, g[j] * 0.78, b[j] * 0.78];
          const base = [paper[0] / 255, paper[1] / 255, paper[2] / 255].map((p, k) => p * 0.82 + [r[j], g[j], b[j]][k] * 0.18);
          put(y * W + x, (base[0] + (ink[0] - base[0]) * cov) * 255, (base[1] + (ink[1] - base[1]) * cov) * 255, (base[2] + (ink[2] - base[2]) * cov) * 255);
        }
      break;
    }
    case "newsprint": {
      // A faded newspaper page: soft contrast, fine black dots, mottled ink and paper fibres.
      const paper = hex(o.colors[0], "#e9e3d5");
      const ink = [0.16, 0.155, 0.15];
      const cell = Math.max(3, 4.4 * u);
      const l = blur(L, W, H, cell / 2);
      const fibre = noise(W, H, 2 * u);
      const mottle = noise(W, H, 14 * u);
      for (let y = 0; y < H; y++)
        for (let x = 0; x < W; x++) {
          const i = y * W + x;
          const q = grid(x, y, cell, Math.PI / 4);
          const j = clamp(Math.round(q.cy), 0, H - 1) * W + clamp(Math.round(q.cx), 0, W - 1);
          const dark = clamp((1 - (0.14 + l[j] * 0.8)) * 1.05);
          const rad = cell * 0.5 * Math.sqrt(dark) * 1.28;
          const cov = smooth(rad + 0.6, rad - 0.6, q.dist) * (0.78 + 0.22 * mottle[i]);
          const pf = 0.955 + 0.045 * fibre[i];
          put(i, (paper[0] / 255) * pf * 255 * (1 - cov) + ink[0] * 255 * cov, (paper[1] / 255) * pf * 255 * (1 - cov) + ink[1] * 255 * cov, (paper[2] / 255) * pf * 255 * (1 - cov) + ink[2] * 255 * cov);
        }
      break;
    }
    case "risograph": {
      // Two inks on paper: a colour plate for mid-tones and a dark plate for shadows, each screened
      // with coarse riso grain, the dark plate a little out of register.
      const paper = hex(o.colors[2], "#f5f0e6");
      const inkA = hex(o.colors[0], "#ff4a9e");
      const inkB = hex(o.colors[1], "#23306b");
      const l = blur(L, W, H, 1.2 * u);
      const grainA = noise(W, H, 1.3 * u);
      const grainB = noise(W, H, 1.3 * u);
      const off = Math.round(3.5 * u);
      for (let y = 0; y < H; y++)
        for (let x = 0; x < W; x++) {
          const i = y * W + x;
          const dark = 1 - l[i];
          const jb = clamp(y - Math.round(off * 0.6), 0, H - 1) * W + clamp(x + off, 0, W - 1);
          const darkB = 1 - l[jb];
          const a = smooth(0.06, 0.72, dark);
          const b = smooth(0.5, 0.95, darkB);
          const covA = smooth(grainA[i] - 0.18, grainA[i] + 0.18, a) * 0.92;
          const covB = smooth(grainB[i] - 0.2, grainB[i] + 0.2, b) * 0.88;
          const mix = (k: number) => (paper[k] / 255) * (1 - covA * (1 - inkA[k] / 255)) * (1 - covB * (1 - inkB[k] / 255)) * 255;
          put(i, mix(0), mix(1), mix(2));
        }
      break;
    }
    case "oil": {
      // Painted patches (Kuwahara at half size), a little more colour, then impasto: the paint's
      // relief lit from the top left, with a canvas weave underneath.
      const k = 2;
      const s = reduced(k);
      const painted = kuwahara(s.px, s.w, s.h, Math.max(2, Math.round((5 * u) / k)));
      const second = new ImageData(painted, s.w, s.h);
      const repainted = kuwahara(second, s.w, s.h, Math.max(2, Math.round((3 * u) / k)));
      s.x.putImageData(new ImageData(repainted, s.w, s.h), 0, 0);
      upscale(s.c);
      const { r, g, b } = channels(d, N);
      const l = blur(lumOf(r, g, b), W, H, 0.8 * u, 1);
      const weave = noise(W, H, 1.2 * u);
      for (let y = 1; y < H - 1; y++)
        for (let x = 1; x < W - 1; x++) {
          const i = y * W + x;
          const gx = l[i + 1] - l[i - 1];
          const gy = l[i + W] - l[i - W];
          const light = 1 + clamp((-gx - gy) * 5.5, -0.22, 0.22) + (weave[i] - 0.5) * 0.05;
          const mean = (r[i] + g[i] + b[i]) / 3;
          const sat = (c: number) => clamp(mean + (c - mean) * 1.12);
          put(i, sat(r[i]) * light * 255, sat(g[i]) * light * 255, sat(b[i]) * light * 255);
        }
      break;
    }
    case "watercolor": {
      // Soft washes (flattened, posterised lightly), pigment pooling at the edges of each wash,
      // granulation in the paper, and the white of the paper showing through.
      const k = 2;
      const s = reduced(k);
      const flat = kuwahara(s.px, s.w, s.h, Math.max(2, Math.round((4 * u) / k)));
      s.x.putImageData(new ImageData(flat, s.w, s.h), 0, 0);
      upscale(s.c);
      const { r, g, b } = channels(d, N);
      const l = lumOf(r, g, b);
      const near = blur(l, W, H, 2 * u);
      const far = blur(l, W, H, 7 * u);
      const gran = noise(W, H, 1.1 * u);
      const bloom = noise(W, H, 40 * u);
      const paper = hex(o.colors[0], "#fbf8f1");
      for (let i = 0; i < N; i++) {
        const edge = clamp(Math.abs(near[i] - far[i]) * 5);
        const poster = (c: number) => {
          const q = Math.round(c * 6) / 6;
          return c * 0.55 + q * 0.45;
        };
        const pig = (1 - edge * 0.22) * (0.93 + gran[i] * 0.1) * (0.96 + bloom[i] * 0.06);
        const wash = (c: number, p: number) => clamp(poster(c) * pig * 0.8 + (p / 255) * 0.2 + 0.03);
        put(i, wash(r[i], paper[0]) * 255, wash(g[i], paper[1]) * 255, wash(b[i], paper[2]) * 255);
      }
      break;
    }
    case "ink": {
      // A sepia ink wash: the picture reduced to a few tones of ink that bleed at their edges.
      const paper = hex(o.colors[0], "#efe6d3");
      const ink = hex(o.colors[1], "#3b2a1d");
      const l = blur(L, W, H, 2.2 * u);
      const edgeN = blur(L, W, H, 0.8 * u, 1);
      const grain = noise(W, H, 1.1 * u);
      const drift = noise(W, H, 60 * u);
      for (let i = 0; i < N; i++) {
        const v = clamp(l[i] + (drift[i] - 0.5) * 0.08);
        // Four washes with soft steps between them.
        const steps = 3;
        const t = v * steps;
        const base = Math.floor(t);
        const frac = t - base;
        const q = (base + smooth(0.42, 0.58, frac)) / steps;
        const density = clamp((1 - q) * 1.08) * (0.88 + grain[i] * 0.14);
        const bleed = clamp(Math.abs(edgeN[i] - l[i]) * 6) * 0.25;
        const k = clamp(density + bleed);
        put(i, paper[0] + (ink[0] - paper[0]) * k, paper[1] + (ink[1] - paper[1]) * k, paper[2] + (ink[2] - paper[2]) * k);
      }
      break;
    }
    case "fluted-glass": {
      // Wide vertical flutes: each rib shows a flipped, squeezed slice of what's behind it,
      // frosted a little, with a lit edge on one side and shade on the other.
      const rib = Math.max(8, 34 * u);
      const r = blur(R, W, H, 2 * u);
      const g = blur(G, W, H, 2 * u);
      const b = blur(B, W, H, 2 * u);
      for (let x = 0; x < W; x++) {
        const t = (x % rib) / rib;
        const centre = Math.floor(x / rib) * rib + rib / 2;
        const sx = clamp(Math.round(centre - (t - 0.5) * rib * 1.5), 0, W - 1);
        const shade = 1 + 0.12 * Math.cos((t - 0.3) * Math.PI * 2) - 0.3 * smooth(0.78, 1, t);
        const lit = 0.16 * (1 - smooth(0.02, 0.12, t)) * smooth(0, 0.02, t) + 0.05 * (1 - Math.abs(t - 0.3) * 3.2 > 0 ? 1 - Math.abs(t - 0.3) * 3.2 : 0);
        for (let y = 0; y < H; y++) {
          const j = y * W + sx;
          put(y * W + x, clamp(r[j] * shade + lit) * 255, clamp(g[j] * shade + lit) * 255, clamp(b[j] * shade + lit) * 255);
        }
      }
      break;
    }
  }

  // Blend with the original when the finish is partial.
  if (o.amount < 1) {
    const a = clamp(o.amount);
    for (let i = 0; i < d.length; i += 4) for (let c = 0; c < 3; c++) d[i + c] = orig[i + c] + (d[i + c] - orig[i + c]) * a;
  }
  ctx.putImageData(image, 0, 0);
  const blob = await canvas.convertToBlob({ type: "image/png" });
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
