import { findText } from "../native/ocr.js";
import { detectRow, type Box } from "./analyze.js";
import { luminance } from "./background.js";
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
  /** Loupe centre and diameter in screenshot px, and the point it magnifies. */
  loupe?: { cx: number; cy: number; d: number; tx: number; ty: number };
  /** Step markers: the label, where it sits against the box, its diameter and nudge (screenshot px). */
  step?: { label: string; at: NonNullable<HighlightInput["at"]>; d: number; dx: number; dy: number };
  /** Arrows: where the arrow starts relative to the box centre, its bend and thickness (screenshot px). */
  arrow?: { dx: number; dy: number; bend: number; width: number };
  /** Highlighters: the text sits on a dark background (the marker lightens instead of multiplying). */
  onDark?: boolean;
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
  let steps = 0;
  for (const h of requests) {
    let target: Box;
    let row: (Box & { color: string }) | undefined;
    let rowColor: string | undefined;
    const wantsRow = h.row ?? (h.style === "lift" || h.style === "blur-rest" || h.style === "spotlight" || h.style === "blur");
    if (h.text) {
      const t = await findText(file, h.text, h.match ?? 1);
      target = { x: t.x, y: t.y, width: t.width, height: t.height };
      if (wantsRow || (h.style === "lift" && h.breakout) || h.style === "highlighter") row = await detectRow(file, target);
      rowColor = row?.color;
      // A row that doesn't contain its own text was misread (a dimmed or busy screen): use the
      // text (its background colour is still right).
      const slack = 4;
      if (row && !(row.x <= target.x + slack && row.x + row.width >= target.x + target.width - slack && row.y <= target.y + slack && row.y + row.height >= target.y + target.height - slack)) row = undefined;
    } else if (h.rect) {
      const k = h.unit === "pt" ? ptToPx : 1;
      target = { x: h.rect.x * k, y: h.rect.y * k, width: h.rect.width * k, height: h.rect.height * k };
    } else {
      throw new Error(`A ${h.style} highlight needs "text" or "rect".`);
    }

    const marker = h.style === "step" || h.style === "arrow" || h.style === "highlighter";
    const pad = (h.padding ?? (h.style === "highlighter" ? 2 : marker ? 0 : 6)) * ptToPx;
    const radius = (h.radius ?? 14) * ptToPx;
    const base = {
      style: h.style,
      radius,
      dim: h.dim ?? (h.style === "outline" || h.style === "loupe" || marker || h.style === "blur" ? 0 : h.style === "spotlight" ? 0.55 : 0.45),
      wash: h.washColor ?? "#1c1c1e",
      color:
        h.color ??
        (h.style === "loupe" ? "#ffffff" : h.style === "step" || h.style === "arrow" ? "#ff3b30" : h.style === "highlighter" ? "#ffe14d" : "#0a84ff"),
    };
    const cx = target.x + target.width / 2;
    const cy = target.y + target.height / 2;

    if (h.style === "highlighter") {
      const onDark = (luminance(rowColor) ?? 1) < 0.25;
      out.push({ ...base, box: grow(target, pad), scale: 1, onDark });
      continue;
    }
    if (h.style === "loupe") {
      const d = (h.size ?? 120) * ptToPx;
      out.push({
        ...base,
        box: target,
        scale: h.scale ?? 1.8,
        loupe: { cx: cx + (h.offsetX ?? 0) * ptToPx, cy: cy + (h.offsetY ?? 0) * ptToPx, d, tx: cx, ty: cy },
      });
      continue;
    }
    if (h.style === "step") {
      steps++;
      const box = row && row.width > 0 ? row : target;
      out.push({ ...base, box, scale: 1, step: { label: h.label ?? String(steps), at: h.at ?? "right", d: (h.size ?? 30) * ptToPx, dx: (h.offsetX ?? 0) * ptToPx, dy: (h.offsetY ?? 0) * ptToPx } });
      continue;
    }
    if (h.style === "arrow") {
      const box = row && row.width > 0 ? row : target;
      out.push({ ...base, box, scale: 1, arrow: { dx: (h.offsetX ?? 120) * ptToPx, dy: (h.offsetY ?? -80) * ptToPx, bend: h.bend ?? 0.35, width: (h.size ?? 6) * ptToPx } });
      continue;
    }

    if (h.style === "lift" && h.breakout) {
      // A card wider than the device: the full screen width plus `breakout` on each side, filled
      // with the row's colour, with the real row (or element) shown in place.
      const src = row && row.height > 0 && row.width > 0 ? row : grow(target, pad);
      const wider = h.breakout * size.width;
      const box = { x: -pad - wider, y: src.y - pad, width: size.width + (pad + wider) * 2, height: src.height + pad * 2 };
      out.push({ ...base, box, crop: src, fill: rowColor ?? "#ffffff", scale: h.scale ?? 1.04 });
    } else if (row && row.height > 0 && row.width > 0) {
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
