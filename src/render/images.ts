/**
 * Image blocks: logos, the app icon, stickers or any picture placed on the scene like a shape —
 * moved, sized, turned and layered, with rounded corners or an app icon's outline, a shadow, a
 * sticker's die-cut white edge, soft focus and opacity.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const fileUrl = (p: string) => pathToFileURL(p).href;

/** Screenshotter's own stickers ("sticker:heart") and illustrations ("art:squiggle"), shipped with the Studio's UI. */
const STICKER_DIR = fileURLToPath(new URL("../studio/ui/stickers/", import.meta.url));
const ART_DIR = fileURLToPath(new URL("../studio/ui/art/", import.meta.url));

const namesIn = (dir: string) => {
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith(".svg"))
      .map((f) => f.slice(0, -4))
      .sort();
  } catch {
    return [];
  }
};
/** The names of the built-in stickers. */
export const stickerNames = () => namesIn(STICKER_DIR);
/** The names of the built-in illustrations. */
export const artNames = () => namesIn(ART_DIR);
/** Illustrations in their own colours; every other one is drawn in one ink, to tint. */
export const COLOURED_ART = ["confetti-colour", "memphis", "plant", "stars-night"];

/** A built-in sticker's or illustration's SVG ("sticker:heart", "art:squiggle"), or undefined. */
export function builtinSvg(src: string): { svg: string; mono: boolean } | undefined {
  const m = /^(sticker|art):([a-z0-9-]+)$/i.exec(src.trim());
  if (!m) return undefined;
  try {
    const art = m[1].toLowerCase() === "art";
    const name = m[2].toLowerCase();
    return { svg: readFileSync(path.join(art ? ART_DIR : STICKER_DIR, `${name}.svg`), "utf8"), mono: art && !COLOURED_ART.includes(name) };
  } catch {
    return undefined;
  }
}

/** Where a block's picture is: a built-in sticker or illustration, or a path. */
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


export const isImageFile = (file: string) => /\.(png|jpe?g|webp|gif|svg|heic|avif)$/i.test(path.basename(file));
