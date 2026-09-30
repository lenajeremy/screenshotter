import { findText } from "../native/ocr.js";
import { detectRow, type Box } from "./analyze.js";
import type { HighlightInput } from "./schema.js";

/** A highlight resolved to screenshot pixels, ready to draw. */
export interface ResolvedHighlight {
  style: HighlightInput["style"];
  /** Element box in screenshot px (padding applied). */
  box: Box;
  /** For row lifts: the part of the screenshot shown inside `box`, and the fill around it. */
  crop?: Box;
  fill?: string;
  radius: number;
  scale: number;
  dim: number;
  wash: string;
  color: string;
  /** Loupe centre and diameter in screenshot px. */
  loupe?: { cx: number; cy: number; d: number };
}

/**
 * Turn highlight requests (by text or rectangle) into pixel geometry.
 * `ptToPx` converts points to screenshot pixels for padding, radius and loupe size.
 */
export async function resolveHighlights(
  file: string,
  size: { width: number; height: number },
  ptToPx: number,
  requests: HighlightInput[],
): Promise<ResolvedHighlight[]> {
  const out: ResolvedHighlight[] = [];
  for (const h of requests) {
    let target: Box;
    let row: (Box & { color: string }) | undefined;
    const wantsRow = h.row ?? (h.style === "lift" || h.style === "blur-rest" || h.style === "spotlight");
    if (h.text) {
      const t = await findText(file, h.text, h.match ?? 1);
      target = { x: t.x, y: t.y, width: t.width, height: t.height };
      if (wantsRow) row = await detectRow(file, target);
    } else if (h.rect) {
      const k = h.unit === "pt" ? ptToPx : 1;
      target = { x: h.rect.x * k, y: h.rect.y * k, width: h.rect.width * k, height: h.rect.height * k };
    } else {
      throw new Error(`A ${h.style} highlight needs "text" or "rect".`);
    }

    const pad = (h.padding ?? 6) * ptToPx;
    const radius = (h.radius ?? 14) * ptToPx;
    const base = {
      style: h.style,
      radius,
      dim: h.dim ?? (h.style === "outline" || h.style === "loupe" ? 0 : h.style === "spotlight" ? 0.55 : 0.45),
      wash: h.washColor ?? "#1c1c1e",
      color: h.color ?? (h.style === "loupe" ? "#ffffff" : "#0a84ff"),
    };

    if (h.style === "loupe") {
      const d = (h.size ?? 120) * ptToPx;
      out.push({
        ...base,
        box: target,
        scale: h.scale ?? 1.8,
        loupe: {
          cx: target.x + target.width / 2 + (h.offsetX ?? 0) * ptToPx,
          cy: target.y + target.height / 2 + (h.offsetY ?? 0) * ptToPx,
          d,
        },
      });
      continue;
    }

    if (row && row.height > 0 && row.width > 0) {
      // Rows that span (nearly) the whole screen lift as a full-width band filled with the row
      // colour, with the real card shown in place; narrower cards (iPad, web) lift on their own.
      const fullWidth = row.width >= size.width * 0.8;
      const band: Box = fullWidth ? { x: -pad, y: row.y - pad, width: size.width + pad * 2, height: row.height + pad * 2 } : grow(row, pad);
      out.push({ ...base, box: h.style === "lift" ? band : grow(row, pad), crop: row, fill: row.color, scale: h.scale ?? (h.style === "lift" ? 1.06 : 1) });
    } else {
      out.push({ ...base, box: grow(target, pad), scale: h.scale ?? (h.style === "lift" ? 1.06 : 1) });
    }
  }
  return out;
}

const grow = (b: Box, p: number): Box => ({ x: b.x - p, y: b.y - p, width: b.width + p * 2, height: b.height + p * 2 });
