/**
 * Unsplash photos on boards. An agent writes "unsplash:<words>" where a picture goes (an <img>'s
 * src, or url(unsplash:<words>) in CSS such as a background), and gets the top free photo for those
 * words in the layer's shape: landscape, portrait or square. "#2" takes the second photo, and an
 * Unsplash photo's id or page names one. The search uses the key saved in Settings › Photos.
 */
import { resolvePhoto } from "../render/photos.js";
import { adoptImage } from "./store.js";
import { pxValue, type BoardNode } from "./core.js";

const PHOTO_ID = /^[A-Za-z0-9_-]{11}$/;

export const isUnsplash = (ref: string) => /^\s*unsplash:/i.test(ref) || /unsplash\.com\/photos\//i.test(ref);

/**
 * What an "unsplash:…" source asks for, as the photo code takes it: a search ("unsplash:search:…")
 * or a photo by its id, and which result (0 = the first).
 */
export function unsplashRef(ref: string): { ref: string; pick: number } {
  const r = ref.trim();
  if (!/^unsplash:/i.test(r)) return { ref: r, pick: 0 };
  let words = r.slice("unsplash:".length).trim();
  let pick = 0;
  const n = /\s*#(\d+)$/.exec(words);
  if (n) {
    pick = Math.max(0, Number(n[1]) - 1);
    words = words.slice(0, n.index).trim();
  }
  if (words.startsWith("search:")) return { ref: `unsplash:${words}`, pick };
  // An id is 11 characters with capitals, digits, - or _ in it ("TWTxHN2QIGc"); a word that long isn't.
  if (PHOTO_ID.test(words) && /[A-Z0-9_-]/.test(words)) return { ref: `unsplash:${words}`, pick: 0 };
  return { ref: `unsplash:search:${words.replace(/[-_]+/g, " ")}`, pick };
}

/** The photo for a source, in the board's own pictures, and who took it. */
export async function unsplashPicture(ref: string, box: { width: number; height: number }): Promise<{ src: string; credit?: string }> {
  const r = unsplashRef(ref);
  // Twice the layer's size, so it's sharp on a Retina screen and in 2× exports.
  const photo = await resolvePhoto(r.ref, { width: box.width * 2, height: box.height * 2 }, r.pick);
  return { src: adoptImage(photo.path).src, credit: photo.credit };
}

const CSS_UNSPLASH = /url\(\s*(['"]?)((?:unsplash:|https?:\/\/unsplash\.com\/photos\/)[^'")]+)\1\s*\)/gi;

/**
 * CSS with each url(unsplash:…) made the photo's file; null when one couldn't be had (the search
 * is used up for the hour, say), so the layer keeps what it had rather than losing its picture.
 */
export async function cssWithPhotos(
  value: string,
  box: { width: number; height: number },
  warnings: string[],
  credits: string[],
  picture: typeof unsplashPicture = unsplashPicture,
): Promise<string | null> {
  let out = value;
  let failed = false;
  for (const m of [...value.matchAll(CSS_UNSPLASH)]) {
    try {
      const p = await picture(m[2], box);
      out = out.replace(m[0], `url("${p.src}")`);
      if (p.credit) credits.push(p.credit);
    } catch (e) {
      warnings.push(`${m[2]}: ${(e as Error).message} The layer keeps what it had.`);
      failed = true;
    }
  }
  return failed ? null : out;
}

const boxOf = (n: BoardNode) => ({ width: pxValue(n.style.width) ?? 1200, height: pxValue(n.style.height) ?? 800 });

/** New layers' Unsplash sources made photos (the ones that can't be are left empty, with why). */
export async function placePhotos(nodes: Record<string, BoardNode>, warnings: string[], credits: string[]): Promise<void> {
  for (const n of Object.values(nodes)) {
    if (n.type === "image" && n.src && isUnsplash(n.src)) {
      try {
        const p = await unsplashPicture(n.src, boxOf(n));
        n.src = p.src;
        if (p.credit) credits.push(p.credit);
      } catch (e) {
        warnings.push(`${n.src}: ${(e as Error).message}`);
        n.src = "";
      }
    }
    for (const [k, v] of Object.entries(n.style)) {
      if (!/url\(\s*['"]?(unsplash:|https?:\/\/unsplash\.com\/photos\/)/i.test(v)) continue;
      const done = await cssWithPhotos(v, boxOf(n), warnings, credits);
      if (done === null) delete n.style[k];
      else n.style[k] = done;
    }
  }
}
