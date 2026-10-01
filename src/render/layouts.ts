import type { Family } from "../devices/catalog.js";
import type { Layout } from "./schema.js";

export interface CanvasPreset {
  width: number;
  height: number;
  label: string;
  /** Which store slot it fills, if any. */
  store?: "app-store" | "google-play";
  /** What it's for: a device family (a size for it swaps the devices to match), or another platform. */
  platform?: Family | "tv" | "vision" | "android";
  /** A short name for pickers and set headings ("iPhone 6.9″"). */
  short?: string;
}

export const CANVAS_PRESETS: Record<string, CanvasPreset> = {
  // App Store slots, as Apple lists them (July 2026). Every one but Apple Watch also takes landscape.
  "iphone-6.9": { width: 1320, height: 2868, label: "App Store iPhone 6.9\" (required for iPhone apps)", store: "app-store", platform: "iphone", short: "iPhone 6.9″" },
  "iphone-6.9-alt": { width: 1290, height: 2796, label: "App Store iPhone 6.9\" (alternate)", store: "app-store", platform: "iphone", short: "iPhone 6.9″ (1290)" },
  "iphone-6.9-1260": { width: 1260, height: 2736, label: "App Store iPhone 6.9\" (third size)", store: "app-store", platform: "iphone", short: "iPhone 6.9″ (1260)" },
  "iphone-6.5": { width: 1284, height: 2778, label: "App Store iPhone 6.5\" (instead of 6.9\")", store: "app-store", platform: "iphone", short: "iPhone 6.5″" },
  "iphone-6.5-alt": { width: 1242, height: 2688, label: "App Store iPhone 6.5\" (alternate)", store: "app-store", platform: "iphone", short: "iPhone 6.5″ (1242)" },
  "iphone-6.3": { width: 1206, height: 2622, label: "App Store iPhone 6.3\" (optional; scaled from 6.9\")", store: "app-store", platform: "iphone", short: "iPhone 6.3″" },
  "iphone-6.1": { width: 1179, height: 2556, label: "App Store iPhone 6.1\" (optional; scaled from 6.9\")", store: "app-store", platform: "iphone", short: "iPhone 6.1″" },
  "iphone-5.5": { width: 1242, height: 2208, label: "App Store iPhone 5.5\" (optional; scaled from 6.9\")", store: "app-store", platform: "iphone", short: "iPhone 5.5″" },
  "ipad-13": { width: 2064, height: 2752, label: "App Store iPad 13\" (required for iPad apps)", store: "app-store", platform: "ipad", short: "iPad 13″" },
  "ipad-12.9": { width: 2048, height: 2732, label: "App Store iPad 13\" (alternate) and 12.9\"", store: "app-store", platform: "ipad", short: "iPad 12.9″" },
  "ipad-11": { width: 1668, height: 2420, label: "App Store iPad 11\" (optional; scaled from 13\")", store: "app-store", platform: "ipad", short: "iPad 11″" },
  mac: { width: 2880, height: 1800, label: "Mac App Store 16:10", store: "app-store", platform: "mac", short: "Mac" },
  "mac-1440": { width: 1440, height: 900, label: "Mac App Store 16:10 (1440 × 900)", store: "app-store", platform: "mac", short: "Mac (1440)" },
  "watch-ultra-3": { width: 422, height: 514, label: "App Store Apple Watch Ultra 3", store: "app-store", platform: "watch", short: "Watch Ultra 3" },
  "watch-ultra": { width: 410, height: 502, label: "App Store Apple Watch Ultra and Ultra 2", store: "app-store", platform: "watch", short: "Watch Ultra" },
  "watch-11": { width: 416, height: 496, label: "App Store Apple Watch Series 11 and 10", store: "app-store", platform: "watch", short: "Watch Series 11" },
  "watch-9": { width: 396, height: 484, label: "App Store Apple Watch Series 9, 8 and 7", store: "app-store", platform: "watch", short: "Watch Series 9" },
  "apple-tv": { width: 3840, height: 2160, label: "App Store Apple TV 4K", store: "app-store", platform: "tv", short: "Apple TV" },
  "apple-tv-hd": { width: 1920, height: 1080, label: "App Store Apple TV HD", store: "app-store", platform: "tv", short: "Apple TV HD" },
  "vision-pro": { width: 3840, height: 2160, label: "App Store Apple Vision Pro", store: "app-store", platform: "vision", short: "Vision Pro" },
  "app-store": { width: 1320, height: 2868, label: "Alias of iphone-6.9", platform: "iphone" },
  // Google Play: phone and tablet screenshots (16:9 or 9:16), and the feature graphic.
  "play-phone": { width: 1080, height: 1920, label: "Google Play phone screenshot", store: "google-play", platform: "android", short: "Play phone" },
  "play-tablet-7": { width: 1200, height: 1920, label: "Google Play 7\" tablet screenshot", store: "google-play", platform: "android", short: "Play 7″ tablet" },
  "play-tablet-10": { width: 1600, height: 2560, label: "Google Play 10\" tablet screenshot", store: "google-play", platform: "android", short: "Play 10″ tablet" },
  "play-feature": { width: 1024, height: 500, label: "Google Play feature graphic", store: "google-play", platform: "android", short: "Play feature graphic" },
  // Everywhere else.
  "16:9": { width: 2560, height: 1440, label: "16:9 landscape (web, video, keynote)", short: "Wide 16:9" },
  "16:10": { width: 2560, height: 1600, label: "16:10 landscape", short: "Wide 16:10" },
  "4:3": { width: 2048, height: 1536, label: "4:3 landscape", short: "4:3" },
  "3:2": { width: 2400, height: 1600, label: "3:2 landscape", short: "3:2" },
  "1:1": { width: 2048, height: 2048, label: "Square", short: "Square" },
  "4:5": { width: 1600, height: 2000, label: "4:5 portrait (Instagram feed)", short: "Post 4:5" },
  "9:16": { width: 1440, height: 2560, label: "9:16 portrait (stories, reels, TikTok)", short: "Story 9:16" },
  square: { width: 1080, height: 1080, label: "Square social post", short: "Square 1080" },
  portrait: { width: 1080, height: 1350, label: "4:5 social post", short: "Post 1080" },
  story: { width: 1080, height: 1920, label: "9:16 story", short: "Story 1080" },
  landscape: { width: 1920, height: 1080, label: "1080p landscape", short: "1080p" },
  og: { width: 1200, height: 630, label: "Open Graph / link preview", short: "Link preview" },
  twitter: { width: 1600, height: 900, label: "X/Twitter card", short: "X card" },
  "product-hunt": { width: 1270, height: 760, label: "Product Hunt gallery", short: "Product Hunt" },
};

export function defaultCanvasFor(family: Family | "flat"): string {
  if (family === "ipad") return "ipad-13";
  if (family === "watch") return "4:5";
  if (family === "mac" || family === "flat") return "16:9";
  return "iphone-6.9";
}

/** Where a device goes, as fractions of the canvas. */
export interface DeviceSlot {
  x: number;
  y: number;
  /** Fit inside boxW × boxH unless width/height pins one dimension. */
  boxW: number;
  boxH: number;
  width?: number;
  height?: number;
  anchor: "center" | "top" | "bottom";
  rotate: number;
  rotateX: number;
  rotateY: number;
  z: number;
}

export interface TextSlot {
  x: number;
  y: number;
  anchor: "top" | "middle" | "bottom";
  align: "left" | "center" | "right";
  width: number;
}

export interface LayoutResult {
  layout: Layout;
  devices: DeviceSlot[];
  text: TextSlot;
  /** Headline size in px; subheadline scales from it. */
  headlineSize: number;
}

const slot = (x: number, y: number, boxW: number, boxH: number, extra: Partial<DeviceSlot> = {}): DeviceSlot => ({
  x,
  y,
  boxW,
  boxH,
  anchor: "center",
  rotate: 0,
  rotateX: 0,
  rotateY: 0,
  z: 10,
  ...extra,
});

/** Spread n devices in a row across [from, to]. */
function row(n: number, from: number, to: number, y: number, boxH: number): DeviceSlot[] {
  const span = to - from;
  const boxW = (span / n) * 1.02;
  return Array.from({ length: n }, (_, i) => slot(from + (span * (i + 0.5)) / n, y, boxW, boxH, { z: 10 + Math.min(i, 15) }));
}

/** Overlapping multi-device arrangement: laptop at the back, tablet, phone and watch in front. */
function stack(families: Family[], area: { x0: number; x1: number; y0: number; y1: number }, tall = false): DeviceSlot[] {
  const w = area.x1 - area.x0;
  const h = area.y1 - area.y0;
  const at = (fx: number, fy: number, bw: number, bh: number, z: number) => slot(area.x0 + w * fx, area.y0 + h * fy, w * bw, h * bh, { z });
  const hasMac = families.includes("mac");
  const hasPad = families.includes("ipad");
  const seen: Record<string, number> = {};
  if (tall) {
    // Portrait canvas: wide devices on top, phones and watches overlapping below.
    return families.map((fam) => {
      const k = (seen[fam] = (seen[fam] ?? -1) + 1);
      const nudge = k * 0.12;
      switch (fam) {
        case "mac":
          return at(0.5, 0.3 + nudge, 1.02, 0.46, 10 + k);
        case "ipad":
          return hasMac ? at(0.3 + nudge, 0.66, 0.5, 0.5, 13 + k) : at(0.42 + nudge, 0.45, 0.8, 0.7, 13 + k);
        case "watch":
          return at(0.2 + nudge, 0.8, 0.3, 0.22, 19 + k);
        default:
          return hasMac || hasPad ? at(0.72 - nudge, 0.7, 0.44, 0.58, 16 + k) : at(0.62 + nudge, 0.55, 0.5, 0.8, 16 + k);
      }
    });
  }
  return families.map((fam) => {
    const k = (seen[fam] = (seen[fam] ?? -1) + 1);
    const nudge = k * 0.1;
    switch (fam) {
      case "mac":
        return at(0.53 + nudge, 0.47, 0.8, 0.86, 10 + k);
      case "ipad":
        return hasMac ? at(0.24 + nudge, 0.66, 0.34, 0.62, 13 + k) : at(0.4 + nudge, 0.5, 0.62, 0.86, 13 + k);
      case "watch":
        return at(hasMac || hasPad ? 0.06 + nudge : 0.25 + nudge, 0.72, 0.16, 0.3, 19 + k);
      default:
        return hasMac || hasPad ? at(0.84 - nudge, 0.68, 0.2, 0.62, 16 + k) : at(0.6 + nudge, 0.55, 0.36, 0.84, 16 + k);
    }
  });
}

export function computeLayout(
  requested: Layout | undefined,
  width: number,
  height: number,
  families: Family[],
  hasText: boolean,
  position: "top" | "bottom" | "left" | "right" = "top",
): LayoutResult {
  const ratio = height / width;
  const shape = ratio > 1.15 ? "portrait" : ratio < 0.87 ? "landscape" : "square";
  const n = Math.max(1, families.length);
  const mixed = new Set(families).size > 1 || families.includes("mac");
  const side = (position === "left" || position === "right") && shape !== "portrait";

  let layout: Layout =
    requested ?? (n > 1 && mixed ? "stack" : side || (shape === "landscape" && hasText) ? "split" : hasText ? "hero" : "floating");
  if (layout === "hero" && n === 2 && !mixed) layout = "duo";
  if (layout === "hero" && n >= 3 && !mixed) layout = "trio";
  if (layout === "hero" && position === "bottom") layout = "text-bottom";
  if (layout === "split" && shape === "portrait") layout = "hero";

  const headlineSize = Math.round(shape === "portrait" ? width * 0.074 : shape === "landscape" ? height * 0.075 : width * 0.066);
  const topText: TextSlot = { x: 0.5, y: shape === "portrait" ? 0.058 : 0.07, anchor: "top", align: "center", width: 0.86 };
  const bottomText: TextSlot = { ...topText, y: shape === "portrait" ? 0.95 : 0.93, anchor: "bottom" };
  const text = position === "bottom" || layout === "text-bottom" ? bottomText : topText;
  const up = text.anchor === "bottom";
  const shift = (y: number) => (up ? 1 - y : y);
  const textBand = hasText ? 1 : 0;

  // Caption beside the devices (split), on either side.
  if (layout === "split") {
    const right = position === "right";
    const splitText: TextSlot = { x: right ? 0.93 : 0.07, y: 0.5, anchor: "middle", align: right ? "right" : "left", width: 0.38 };
    const area = right ? { x0: 0.03, x1: 0.55, y0: 0.06, y1: 0.97 } : { x0: 0.45, x1: 0.97, y0: 0.06, y1: 0.97 };
    const devices =
      mixed || n > 1
        ? mixed
          ? stack(families, area)
          : row(n, area.x0, area.x1, 0.54, 0.84)
        : [slot((area.x0 + area.x1) / 2, 0.53, area.x1 - area.x0 - 0.04, 0.88)];
    return { layout, devices, text: splitText, headlineSize };
  }

  // Screens stepping up to the right, each in front of the one before and overlapping it by about
  // a third; `rising` counter-rotates them. They may run off the bottom edge.
  if (layout === "staircase" || layout === "rising") {
    const wide = shape === "landscape";
    // Big screens that run off the bottom edge: the steps read as a sequence, not a gallery.
    const h = hasText ? (wide ? 0.82 : 0.62) : wide ? 0.9 : 0.7;
    const spread = Math.min(wide ? 0.34 : 0.4, (wide ? 0.13 : 0.38) * (n - 1));
    const step = (wide ? 0.07 : 0.05) * (n > 1 ? 2 / n : 0);
    const base = hasText ? (up ? 0.4 : wide ? 0.62 : 0.7) : 0.56;
    const devices = Array.from({ length: n }, (_, i) => {
      const t = n > 1 ? i / (n - 1) : 0.5;
      const rotate = layout === "rising" ? (t < 0.5 ? -7 : t > 0.5 ? 6 : 0) : 0;
      return slot(0.5 - spread / 2 + spread * t, base + step * ((n - 1) / 2 - i), 0.8, h, { rotate, z: 10 + i });
    });
    return { layout, devices, text, headlineSize };
  }

  // A mosaic: equal cells in rows under (or above) the caption, a short last row centred.
  if (layout === "grid") {
    const cols = n <= 2 ? n : n <= 4 ? (shape === "portrait" ? 2 : n) : n <= 6 ? 3 : n <= 8 ? 4 : Math.ceil(Math.sqrt(n * 1.6));
    const rows = Math.ceil(n / cols);
    const area = hasText ? (up ? { y0: 0.03, y1: 0.8 } : { y0: 0.22, y1: 0.97 }) : { y0: 0.04, y1: 0.96 };
    const cw = 0.92 / cols;
    // Rows only as tall as the devices need at the cell width (a phone is about half as wide as
    // it is tall), with the whole block centred in the space.
    const aspect = Math.max(...families.map((f) => ({ iphone: 0.48, ipad: 0.74, watch: 0.62, mac: 1.5 })[f] ?? 0.6));
    const need = ((cw * 0.9 * width) / aspect / height) * 1.08;
    const rh = Math.min((area.y1 - area.y0) / rows, need);
    // With a caption, most of the spare room goes on the far side from it, so the screens sit
    // close under (or above) the words.
    const slack = area.y1 - area.y0 - rh * rows;
    const top = area.y0 + slack * (hasText ? (up ? 0.72 : 0.28) : 0.5);
    const devices = Array.from({ length: n }, (_, i) => {
      const row = Math.floor(i / cols);
      const inRow = Math.min(cols, n - row * cols);
      const col = i % cols;
      return slot(0.04 + (cols - inRow) * (cw / 2) + cw * (col + 0.5), top + rh * (row + 0.5), cw * 0.9, rh * 0.92, { z: 10 + i });
    });
    return { layout, devices, text, headlineSize };
  }

  if (layout === "stack") {
    const area = hasText ? (up ? { x0: 0.04, x1: 0.96, y0: 0.04, y1: 0.8 } : { x0: 0.04, x1: 0.96, y0: 0.22, y1: 0.98 }) : { x0: 0.04, x1: 0.96, y0: 0.05, y1: 0.95 };
    return { layout, devices: stack(families, area, shape === "portrait"), text, headlineSize };
  }

  if (shape === "landscape") {
    switch (layout) {
      case "hero-bleed":
        // Big device anchored near the top, running off the bottom edge.
        return {
          layout,
          devices: n === 1 ? [slot(0.5, hasText ? 0.24 : 0.035, 0.9, 2, { anchor: "top", width: families[0] === "mac" ? 0.8 : families[0] === "ipad" ? 0.55 : 0.33 })] : row(n, 0.08, 0.92, 0.62, 1.1),
          text,
          headlineSize,
        };
      case "tilted": {
        const devices = n === 1 ? [slot(0.5, hasText ? 0.6 : 0.52, 0.5, hasText ? 0.7 : 0.86)] : row(n, 0.08, 0.92, 0.58, 0.72);
        devices.forEach((d) => Object.assign(d, { rotateY: -18, rotateX: 8, rotate: -3 }));
        return { layout, devices, text, headlineSize };
      }
      default: {
        const y = hasText ? shift(0.6) : 0.5;
        return { layout, devices: n === 1 ? [slot(0.5, y, 0.8, hasText ? 0.7 : 0.86)] : row(n, 0.08, 0.92, y, hasText ? 0.7 : 0.86), text, headlineSize };
      }
    }
  }

  switch (layout) {
    case "hero-bleed":
      return { layout, devices: [slot(0.5, shift(textBand ? 0.26 : 0.05), 0.92, 2, { anchor: up ? "bottom" : "top", width: 0.82 })], text, headlineSize };
    case "text-bottom":
    case "hero":
      return {
        layout,
        devices: n === 1 ? [slot(0.5, textBand ? shift(0.615) : 0.5, 0.86, textBand ? 0.7 : 0.86)] : row(n, 0.05, 0.95, shift(0.62), 0.66),
        text,
        headlineSize,
      };
    case "tilted":
      return {
        layout,
        devices:
          n === 1
            ? [slot(0.52, textBand ? shift(0.6) : 0.52, 0.9, textBand ? 0.72 : 0.84, { rotateY: -18, rotateX: 8, rotate: -4 })]
            : row(n, 0.05, 0.95, shift(0.62), 0.64).map((d) => ({ ...d, rotateY: -18, rotateX: 8, rotate: -4 })),
        text,
        headlineSize,
      };
    case "duo": {
      const y = textBand ? shift(0.63) : 0.52;
      const h = textBand ? 0.6 : 0.74;
      const devices = [slot(0.34, y, 0.62, h, { rotate: -7, z: 10 }), slot(0.66, y + 0.035 * (up ? -1 : 1), 0.62, h, { rotate: 7, z: 11 })];
      return { layout, devices: devices.slice(0, n).concat(row(Math.max(0, n - 2), 0.1, 0.9, y, h * 0.8)), text, headlineSize };
    }
    case "trio": {
      const y = textBand ? shift(0.64) : 0.53;
      const h = textBand ? 0.62 : 0.74;
      const devices = [slot(0.5, y, 0.6, h, { z: 12 }), slot(0.2, y + 0.03, 0.5, h * 0.86, { rotate: -8, z: 10 }), slot(0.8, y + 0.03, 0.5, h * 0.86, { rotate: 8, z: 11 })];
      return { layout, devices: devices.slice(0, n).concat(row(Math.max(0, n - 3), 0.1, 0.9, y, h * 0.7)), text, headlineSize };
    }
    case "floating":
      return {
        layout,
        devices: n === 1 ? [slot(0.5, textBand ? shift(0.6) : 0.5, 0.86, textBand ? 0.72 : 0.84)] : row(n, 0.05, 0.95, 0.52, 0.7),
        text,
        headlineSize,
      };
    default:
      return { layout, devices: Array.from({ length: n }, (_, i) => slot(0.5, 0.5, 0.9, 0.8, { z: 10 + i })), text, headlineSize };
  }
}
