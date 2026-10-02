/**
 * Image blocks: logos, the app icon, stickers or any picture placed on the scene like a shape —
 * moved, sized, turned and layered, with rounded corners or an app icon's outline, a shadow, a
 * sticker's die-cut white edge, soft focus and opacity.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { resolveUserPath } from "../util/files.js";
import { imageSize } from "../util/image.js";
import type { ImageBlockInput } from "./schema.js";

const fileUrl = (p: string) => pathToFileURL(p).href;

/** An image block with everything settled. Positions and sizes are canvas fractions. */
export interface ImageBlock {
  /** The file on disk (or the URL it was given). */
  file: string;
  url: string;
  /** Its centre, and its box: width as a fraction of the canvas width, height of the height. */
  x: number;
  y: number;
  width: number;
  height: number;
  rotate: number;
  opacity: number;
  /** Corner radius as a share of the shorter side (0.5 is a circle or pill). */
  radius: number;
  mask?: "icon" | "circle";
  shadow: boolean;
  sticker: boolean;
  flip: boolean;
  /** Soft focus: a fraction of the canvas width up to 0.5, or px. */
  blur: number;
  z: number;
}

/** Image blocks sit in front of devices and text, behind shapes (which point at things). */
export const IMAGE_Z = 35;

/** An SVG's own size, from its width and height or its viewBox. */
export function svgSize(svg: string): { width: number; height: number } | undefined {
  const tag = /<svg\b[^>]*>/i.exec(svg)?.[0];
  if (!tag) return undefined;
  const num = (name: string) => {
    const m = new RegExp(`\\b${name}\\s*=\\s*["']\\s*([\\d.]+)(px)?\\s*["']`, "i").exec(tag);
    return m ? Number(m[1]) : undefined;
  };
  const w = num("width");
  const h = num("height");
  if (w && h) return { width: w, height: h };
  const vb = /viewBox\s*=\s*["']\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(tag);
  if (vb) return { width: Number(vb[1]), height: Number(vb[2]) };
  return undefined;
}

async function naturalSize(file: string): Promise<{ width: number; height: number }> {
  if (/\.svg$/i.test(file)) return svgSize(readFileSync(file, "utf8")) ?? { width: 1, height: 1 };
  return imageSize(file);
}

/** Settle every image block: find its file, read its size and fill in what it leaves out. */
export async function resolveImages(input: { images?: ImageBlockInput[] }, W: number, H: number, warnings: string[]): Promise<ImageBlock[]> {
  const out: ImageBlock[] = [];
  for (const [i, b] of (input.images ?? []).entries()) {
    const remote = /^(https?:|data:)/.test(b.src);
    const file = remote ? b.src : resolveUserPath(b.src);
    if (!remote && !existsSync(file)) {
      warnings.push(`image ${i + 1} wasn't found (${b.src}), so it's left out.`);
      continue;
    }
    // A remote picture's size isn't known until it loads: it's laid out square unless both sides are given.
    const nat = remote ? { width: 1, height: 1 } : await naturalSize(file).catch(() => ({ width: 1, height: 1 }));
    const ratio = nat.width / nat.height; // width ÷ height in pixels
    let height: number;
    let width: number;
    if (b.height !== undefined && b.width !== undefined) {
      height = b.height;
      width = b.width;
    } else if (b.width !== undefined) {
      width = b.width;
      height = (width * W) / ratio / H;
    } else {
      height = b.height ?? 0.12;
      width = (height * H * ratio) / W;
    }
    out.push({
      file,
      url: remote ? b.src : fileUrl(file),
      x: b.x ?? 0.5,
      y: b.y ?? 0.5,
      width,
      height,
      rotate: b.rotate ?? 0,
      opacity: b.opacity ?? 1,
      radius: Math.max(0, Math.min(0.5, b.radius ?? 0)),
      mask: b.mask,
      shadow: b.shadow ?? false,
      sticker: b.sticker ?? false,
      flip: b.flip ?? false,
      blur: Math.max(0, b.blur ?? 0),
      z: b.z ?? IMAGE_Z,
    });
  }
  return out;
}

const f = (n: number) => Math.round(n * 100) / 100;
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

/**
 * The CSS for a block's look at w×h pixels (on a W-wide canvas): its corners, and the filter that
 * draws a sticker's white edge and shadows. Shared with the Studio's canvas, so they match.
 */
export function imageLook(b: Pick<ImageBlock, "radius" | "mask" | "shadow" | "sticker" | "blur">, w: number, h: number, W: number) {
  const short = Math.min(w, h);
  // Apple's app icon: a continuous-cornered square. A circle. Or plain rounded corners.
  const corners = b.mask === "icon" ? "border-radius:22.4%;corner-shape:superellipse(1.35)" : b.mask === "circle" ? "border-radius:50%" : b.radius ? `border-radius:${f(b.radius * short)}px` : "";
  const filters: string[] = [];
  if (b.sticker) {
    // Four white shadows, each building on the last, make an edge that follows the picture's outline.
    const t = f(Math.max(2, short * 0.035));
    filters.push(`drop-shadow(${t}px 0 0 #fff)`, `drop-shadow(-${t}px 0 0 #fff)`, `drop-shadow(0 ${t}px 0 #fff)`, `drop-shadow(0 -${t}px 0 #fff)`);
  }
  if (b.shadow || b.sticker) filters.push(`drop-shadow(0 ${f(short * 0.03)}px ${f(short * 0.06)}px rgba(0,0,0,${b.sticker ? 0.28 : 0.35}))`);
  const soft = !b.blur ? 0 : b.blur <= 0.5 ? b.blur * W : b.blur;
  // A video's animated focus comes from --ablur; otherwise it's the block's own.
  filters.push(`blur(var(--ablur, ${f(soft)}px))`);
  return { corners, filter: filters.join(" ") };
}

/** The block as an absolutely positioned element of a W×H page (`id` marks it for animation). */
export function imageBlockHtml(b: ImageBlock, W: number, H: number, id: string): string {
  const w = b.width * W;
  const h = b.height * H;
  const look = imageLook(b, w, h, W);
  const wrap = [
    "position:absolute",
    `left:${f(b.x * W - w / 2)}px`,
    `top:${f(b.y * H - h / 2)}px`,
    `width:${f(w)}px`,
    `height:${f(h)}px`,
    `z-index:${b.z}`,
    b.rotate ? `transform:rotate(${b.rotate}deg)` : "",
    `opacity:calc(${b.opacity} * var(--ao, 1))`,
    look.filter ? `filter:${look.filter}` : "",
  ]
    .filter(Boolean)
    .join(";");
  const img = ["display:block", "width:100%", "height:100%", "object-fit:fill", look.corners, b.flip ? "transform:scaleX(-1)" : ""].filter(Boolean).join(";");
  return `<div class="image-block" data-ent="${esc(id)}" style="${wrap}"><img src="${esc(b.url)}" style="${img}"></div>`;
}

/** Whether a file looks like a picture an image block can show. */
export const isImageFile = (file: string) => /\.(png|jpe?g|webp|gif|svg|heic|avif)$/i.test(path.basename(file));
