import type { DeviceModel } from "../devices/catalog.js";
import type { ChromeButton } from "../devices/profile.js";
import { BACK_CSS, backHtml, housingOutline } from "./back.js";
import { luminance } from "./background.js";
import { drawnFrames } from "./bezels.js";
import { menuBarHtml, type MenuBarSpec } from "./menubar.js";
import type { ResolvedHighlight } from "./highlights.js";

/** Apple Watch band stubs: each shows this fraction of the case height above and below it. */
export const WATCH_BAND = 0.26;
const showsBand = (o: FrameOptions) => o.model?.family === "watch" && o.band !== null && !o.bezel;

/** The band colour when none is given: a trail-loop grey for Ultra, else a sport band that suits the case. */
export function defaultBand(model: DeviceModel, color: string): string {
  if (model.id.includes("ultra")) return "#9e9a93";
  return (luminance(color) ?? 0) > 0.35 ? "#d9d6cf" : "#2c2c2e";
}

export type IslandMode = "auto" | "always" | "never";
export type FrameKind = "device" | "browser" | "window" | "card" | "none";

/** What the screenshot already contains, from `analyzeScreenshot`. */
export interface ScreenshotFacts {
  /** The capture already shows a Dynamic Island (simulator captures do; device captures don't). */
  hasIsland: boolean;
  /** For landscape captures: the side of the image the top of the device is on. */
  topSide: "left" | "right";
}

export interface ImageRef {
  url: string;
  width: number;
  height: number;
  /** Source crop in image px. */
  crop?: { x: number; y: number; width: number; height: number };
  /** Image pixels per point (for chrome sizing on flat frames). */
  scale: number;
  /** Optional screen recording to play in place of the image (video renders). */
  video?: string;
}

export interface FrameOptions {
  kind: FrameKind;
  model?: DeviceModel;
  color: string;
  image: ImageRef;
  facts: ScreenshotFacts;
  island: IslandMode;
  buttons: boolean;
  glare: boolean;
  studio: boolean;
  /** Force orientation; default follows the image. */
  landscape?: boolean;
  band?: string | null;
  highlights: ResolvedHighlight[];
  url?: string;
  title?: string;
  chrome: "light" | "dark";
  /** Corner radius in rendered px for flat frames. */
  radius?: number;
  /**
   * Laptops: keep a black menu-bar strip under the notch and show the capture below it, the way
   * a notched Mac shows a full-screen app. Off for full-screen Mac captures, which have their own
   * menu bar.
   */
  /** Laptops: the macOS menu bar drawn above the capture (true for the defaults). */
  menuBar?: boolean | MenuBarSpec;
  /** Phones: show the back (camera housing, logo) instead of the screen. */
  back?: boolean;
  /** A photographic frame (an installed Apple product bezel) to use instead of the drawn one. */
  bezel?: BezelRef;
}

/** An installed product bezel: the image, and where its transparent screen opening is (image px). */
export interface BezelRef {
  url: string;
  /** The image on disk (for the Studio's canvas). */
  file?: string;
  width: number;
  height: number;
  hole: { x: number; y: number; w: number; h: number; r: number };
  /** The art already draws the Dynamic Island or notch. */
  cutout: boolean;
  /** Frame colour for the 3D edge. */
  edge: string;
}

/** Points per bezel-image pixel: the opening is exactly the screen. */
function bezelScale(o: FrameOptions): number {
  const m = o.model!;
  return m.screen.width / m.screen.scale / o.bezel!.hole.w;
}

/**
 * Product art is used flat. Tilted in 3D, a MacBook keeps the drawn body (it has a real keyboard
 * deck) and so does an Apple Watch (its crown, buttons and band stubs have depth).
 */
const usesBezel = (o: FrameOptions, depth = false) =>
  o.kind === "device" && Boolean(o.bezel) && !o.back && !(depth && drawnFrames() && (o.model?.family === "mac" || o.model?.family === "watch"));

/** Size of the frame in points, before choosing a render scale. */
export interface FrameMeasure {
  width: number;
  height: number;
  /** Visual size after turning to landscape. */
  visWidth: number;
  visHeight: number;
  /** Degrees the upright device is turned to show a landscape capture. */
  turn: number;
}

export interface FrameOutput {
  html: string;
  width: number;
  height: number;
  turn: number;
}

// Dynamic Island geometry in points (measured from simulator captures).
export const ISLAND = { width: 125.33, height: 36.67 };
export const islandTop = (screenWidthPt: number) => (screenWidthPt >= 400 ? 14 : 11.33);
const PHONE_NOTCH = { width: 162, height: 33, radius: 21 };
const MAC_NOTCH = { width: 186, height: 32, radius: 9 };
/** Menu bar height on a notched MacBook, in points. */
export const MAC_MENU_BAR = 37;

const f = (n: number) => `${Math.round(n * 100) / 100}px`;
/** A number for SVG geometry (no unit). */
const f2 = (n: number) => `${Math.round(n * 100) / 100}`;
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

const WINDOW_BAR = 30;
const BROWSER_BAR = 52;
const FLAT_DEPTH = 6;

function croppedSize(image: ImageRef) {
  return image.crop ? { w: image.crop.width, h: image.crop.height } : { w: image.width, h: image.height };
}

function orientation(o: FrameOptions): { landscape: boolean; turn: number } {
  const m = o.model!;
  const portraitModel = m.screen.width < m.screen.height;
  const { w, h } = croppedSize(o.image);
  const landscape = o.landscape ?? (portraitModel && w > h);
  if (!landscape || !portraitModel || m.family === "mac") return { landscape: false, turn: 0 };
  return { landscape: true, turn: o.facts.topSide === "left" ? -90 : 90 };
}

export function measureFrame(o: FrameOptions): FrameMeasure {
  if (o.kind !== "device") {
    const { w, h } = croppedSize(o.image);
    const cw = w / o.image.scale;
    const ch = h / o.image.scale;
    const bar = o.kind === "window" ? WINDOW_BAR : o.kind === "browser" ? BROWSER_BAR : 0;
    return { width: cw, height: ch + bar, visWidth: cw, visHeight: ch + bar, turn: 0 };
  }
  const m = o.model!;
  const sw = m.screen.width / m.screen.scale;
  const sh = m.screen.height / m.screen.scale;
  if (usesBezel(o)) {
    const k = bezelScale(o);
    const bw = o.bezel!.width * k;
    const bh = o.bezel!.height * k;
    const { landscape, turn } = m.family === "mac" ? { landscape: false, turn: 0 } : orientation(o);
    return { width: bw, height: bh, visWidth: landscape ? bh : bw, visHeight: landscape ? bw : bh, turn };
  }
  if (m.family === "mac") {
    const lidW = sw + (m.bezel + m.frame) * 2;
    const lidH = sh + m.bezel + (m.chin ?? m.bezel) + m.frame * 2;
    const baseH = lidW * 0.028;
    return { width: lidW * 1.1, height: lidH + baseH, visWidth: lidW * 1.1, visHeight: lidH + baseH, turn: 0 };
  }
  const border = m.bezel + m.frame;
  const W = sw + border * 2;
  const H = sh + border * 2;
  // A watch is sized with its band stubs, so the whole watch fits where it's placed.
  if (showsBand(o)) {
    const total = H * (1 + WATCH_BAND * 2);
    return { width: W, height: total, visWidth: W, visHeight: total, turn: 0 };
  }
  const { landscape, turn } = orientation(o);
  return { width: W, height: H, visWidth: landscape ? H : W, visHeight: landscape ? W : H, turn };
}

/**
 * Where the screen sits inside the frame's visual box, and the box's corner radius, all as
 * fractions of the box. Used to draw lightweight outlines (the Studio layout canvas).
 */
export function screenRect(o: FrameOptions): { x: number; y: number; width: number; height: number; radius: number } {
  const m = measureFrame(o);
  if (o.kind !== "device") {
    const bar = o.kind === "window" ? WINDOW_BAR : o.kind === "browser" ? BROWSER_BAR : 0;
    const radius = o.kind === "none" ? 0 : o.kind === "card" ? 0.035 * Math.min(m.width, m.height) : 12;
    return { x: 0, y: bar / m.height, width: 1, height: (m.height - bar) / m.height, radius: radius / m.width };
  }
  const model = o.model!;
  const sw = model.screen.width / model.screen.scale;
  const sh = model.screen.height / model.screen.scale;
  if (usesBezel(o)) {
    const b = o.bezel!;
    const turned = m.turn !== 0;
    const [bw, bh] = turned ? [b.height, b.width] : [b.width, b.height];
    const h = turned ? { x: b.hole.y, y: b.width - b.hole.x - b.hole.w, w: b.hole.h, h: b.hole.w } : b.hole;
    return { x: h.x / bw, y: h.y / bh, width: h.w / bw, height: h.h / bh, radius: b.hole.r / bw };
  }
  if (model.family === "mac") {
    const lidW = sw + (model.bezel + model.frame) * 2;
    const side = (m.width - lidW) / 2 + model.bezel + model.frame;
    const top = model.bezel + model.frame;
    return { x: side / m.width, y: top / m.height, width: sw / m.width, height: sh / m.height, radius: (model.screen.cornerRadius + 12) / m.width };
  }
  const border = model.bezel + model.frame;
  if (showsBand(o)) {
    const caseH = sh + border * 2;
    const stub = caseH * WATCH_BAND;
    return { x: border / m.width, y: (stub + border) / m.height, width: sw / m.width, height: sh / m.height, radius: (model.screen.cornerRadius + border) / m.width };
  }
  const turned = m.turn !== 0;
  const [boxW, boxH] = turned ? [m.height, m.width] : [m.width, m.height];
  const [scrW, scrH] = turned ? [sh, sw] : [sw, sh];
  return {
    x: border / boxW,
    y: border / boxH,
    width: scrW / boxW,
    height: scrH / boxH,
    radius: (model.screen.cornerRadius + border) / boxW,
  };
}

// ---------------------------------------------------------------------------------------------
// Screen content: the image plus highlight overlays, shared by every frame kind

interface Content {
  /** Goes inside the clipped screen. */
  clipped: string;
  /** Goes in an unclipped layer on top of the same area (lifts, loupes). */
  overlay: string;
}

function content(o: FrameOptions, boxW: number, boxH: number, turn: number, u: number, keepTop = false): Content {
  const img = o.image;
  const crop = img.crop ?? { x: 0, y: 0, width: img.width, height: img.height };
  // Content box in the image's own orientation.
  const cw = turn ? boxH : boxW;
  const ch = turn ? boxW : boxH;
  const s = Math.max(cw / crop.width, ch / crop.height);
  const ox = (cw - crop.width * s) / 2 - crop.x * s;
  // Cropping to fit: from the centre, or from the bottom so the top (a page's nav) stays.
  const oy = (keepTop ? 0 : (ch - crop.height * s) / 2) - crop.y * s;
  const iw = img.width * s;
  const ih = img.height * s;
  const url = esc(img.url);
  const wrap = (inner: string, clip: boolean) =>
    turn
      ? `<div style="position:absolute;left:50%;top:50%;width:${f(cw)};height:${f(ch)};transform:translate(-50%,-50%) rotate(${-turn}deg);${clip ? "overflow:hidden;" : ""}">${inner}</div>`
      : `<div style="position:absolute;inset:0;${clip ? "overflow:hidden;" : ""}">${inner}</div>`;

  const placeStyle = `position:absolute;left:${f(ox)};top:${f(oy)};width:${f(iw)};height:${f(ih)}`;
  let clipped = img.video
    ? `<video class="shot" src="${esc(img.video)}" poster="${url}" muted playsinline preload="auto" style="${placeStyle};object-fit:fill"></video>`
    : `<img class="shot" src="${url}" style="${placeStyle}">`;
  let overlay = "";
  const X = (v: number) => ox + v * s;
  const Y = (v: number) => oy + v * s;
  const clip = (bx: number, by: number) =>
    `background-image:url(&quot;${url}&quot;);background-size:${f(iw)} ${f(ih)};background-position:${f(-bx * s)} ${f(-by * s)};`;

  // Each call-out's elements say which call-out they are, so a video can bring each in on its own.
  const tag = (html: string, k: number) => html.replace(/class="hlx/g, `data-callout="${k}" class="hlx`);
  for (const [k, h] of o.highlights.entries()) {
    const c0 = clipped.length;
    const v0 = overlay.length;
    const b = h.box;
    if (h.style === "blur-rest") {
      clipped += `<img class="hlx" src="${url}" style="position:absolute;left:${f(ox)};top:${f(oy)};width:${f(iw)};height:${f(ih)};filter:blur(${f(5 * u)})">`;
    }
    if ((h.style === "lift" || h.style === "blur-rest") && h.dim > 0) {
      clipped += `<div class="hlx" style="position:absolute;inset:0;background:${esc(h.wash)};--o:${h.dim}"></div>`;
    }
    if (h.style === "spotlight") {
      clipped += `<div class="hlx" style="position:absolute;left:${f(X(b.x))};top:${f(Y(b.y))};width:${f(b.width * s)};height:${f(b.height * s)};border-radius:${f(h.radius * s)};box-shadow:0 0 0 ${f(4 * (cw + ch))} color-mix(in oklab, ${esc(h.wash)} ${Math.round(h.dim * 100)}%, transparent)"></div>`;
    }
    if (h.style === "lift" || h.style === "blur-rest") {
      const shadow = h.style === "lift" ? `box-shadow:0 ${f(6 * u)} ${f(22 * u)} rgba(0,0,0,.22), 0 ${f(1 * u)} ${f(3 * u)} rgba(0,0,0,.12);` : "";
      const base = `position:absolute;left:${f(X(b.x))};top:${f(Y(b.y))};width:${f(b.width * s)};height:${f(b.height * s)};border-radius:${f(h.radius * s)};transform:scale(calc(1 + ${(h.scale - 1).toFixed(4)} * var(--hl, 1)));${shadow}`;
      if (h.crop && h.fill) {
        const c = h.crop;
        overlay +=
          `<div class="hlx" style="${base}background:${esc(h.fill)};overflow:hidden">` +
          `<div style="position:absolute;left:${f((c.x - b.x) * s)};top:${f((c.y - b.y) * s)};width:${f(c.width * s)};height:${f(c.height * s)};border-radius:${f(h.radius * s * 0.8)};${clip(c.x, c.y)}"></div></div>`;
      } else {
        overlay += `<div class="hlx" style="${base}${clip(b.x, b.y)}"></div>`;
      }
    }
    if (h.style === "outline") {
      overlay += `<div class="hlx" style="position:absolute;left:${f(X(b.x))};top:${f(Y(b.y))};width:${f(b.width * s)};height:${f(b.height * s)};border-radius:${f(h.radius * s)};box-shadow:0 0 0 ${f(2.5 * u)} ${esc(h.color)}, 0 0 ${f(14 * u)} color-mix(in oklab, ${esc(h.color)} 55%, transparent)"></div>`;
      if (h.dim > 0) {
        clipped += `<div class="hlx" style="position:absolute;left:${f(X(b.x))};top:${f(Y(b.y))};width:${f(b.width * s)};height:${f(b.height * s)};border-radius:${f(h.radius * s)};box-shadow:0 0 0 ${f(4 * (cw + ch))} color-mix(in oklab, ${esc(h.wash)} ${Math.round(h.dim * 100)}%, transparent)"></div>`;
      }
    }
    if (h.style === "blur") {
      // Private: the element itself, heavily blurred inside its own outline.
      clipped +=
        `<div class="hlx" style="position:absolute;left:${f(X(b.x))};top:${f(Y(b.y))};width:${f(b.width * s)};height:${f(b.height * s)};border-radius:${f(h.radius * s)};overflow:hidden">` +
        `<img src="${url}" style="position:absolute;left:${f(-b.x * s)};top:${f(-b.y * s)};width:${f(iw)};height:${f(ih)};filter:blur(${f(9 * u)}) saturate(.9)"></div>`;
    }
    if (h.style === "highlighter") {
      // A marker swipe: a touch wider and shorter than the text, slightly off level, multiplied in.
      const th = b.height * s;
      // Multiplied in on light screens; on dark ones it lightens, so it shows and the text still reads.
      const blend = h.onDark ? "opacity:.42;mix-blend-mode:screen" : "opacity:.82;mix-blend-mode:multiply";
      clipped += `<div class="hlx" style="position:absolute;left:${f(X(b.x) - th * 0.18)};top:${f(Y(b.y) + th * 0.1)};width:${f(b.width * s + th * 0.36)};height:${f(th * 0.86)};background:${esc(h.color)};${blend};border-radius:${f(th * 0.18)} ${f(th * 0.3)} ${f(th * 0.22)} ${f(th * 0.34)};transform:rotate(-1.2deg)"></div>`;
    }
    if (h.style === "step" && h.step) {
      const st = h.step;
      const d = st.d * s;
      const gap = d * 0.25;
      const [bx, by, bw2, bh2] = [X(b.x), Y(b.y), b.width * s, b.height * s];
      const pos = {
        right: [bx + bw2 + gap + d / 2, by + bh2 / 2],
        left: [bx - gap - d / 2, by + bh2 / 2],
        top: [bx + bw2 / 2, by - gap - d / 2],
        bottom: [bx + bw2 / 2, by + bh2 + gap + d / 2],
        center: [bx + bw2 / 2, by + bh2 / 2],
      }[st.at];
      const mx = pos[0] + st.dx * s;
      const my = pos[1] + st.dy * s;
      overlay +=
        `<div class="hlx step" style="position:absolute;left:${f(mx - d / 2)};top:${f(my - d / 2)};width:${f(d)};height:${f(d)};border-radius:50%;background:${esc(h.color)};` +
        `box-shadow:0 0 0 ${f(d * 0.07)} #fff, 0 ${f(d * 0.12)} ${f(d * 0.35)} rgba(0,0,0,.28);display:grid;place-items:center;` +
        `font:700 ${f(d * 0.56)} -apple-system, 'SF Pro Rounded', system-ui, sans-serif;color:#fff;font-variant-numeric:tabular-nums">${esc(st.label)}</div>`;
    }
    if (h.style === "arrow" && h.arrow) {
      const a = h.arrow;
      const w = a.width * s;
      const [bx, by, bw2, bh2] = [X(b.x), Y(b.y), b.width * s, b.height * s];
      const c = { x: bx + bw2 / 2, y: by + bh2 / 2 };
      const start = { x: c.x + a.dx * s, y: c.y + a.dy * s };
      // The tip stops just short of the element's edge, on the line from its centre to the start.
      const vx = start.x - c.x;
      const vy = start.y - c.y;
      const len = Math.hypot(vx, vy) || 1;
      const t = Math.min(bw2 / 2 / Math.max(Math.abs(vx), 1e-6), bh2 / 2 / Math.max(Math.abs(vy), 1e-6));
      const tip = { x: c.x + vx * t + (vx / len) * w * 1.2, y: c.y + vy * t + (vy / len) * w * 1.2 };
      const span = Math.hypot(start.x - tip.x, start.y - tip.y);
      const mid = { x: (start.x + tip.x) / 2 - ((tip.y - start.y) / span) * a.bend * span * 0.5, y: (start.y + tip.y) / 2 + ((tip.x - start.x) / span) * a.bend * span * 0.5 };
      // The head points along the curve's last stretch; the line stops inside it.
      const hx = tip.x - mid.x;
      const hy = tip.y - mid.y;
      const hl = Math.hypot(hx, hy) || 1;
      const [ux, uy] = [hx / hl, hy / hl];
      const head = w * 3.6;
      const half = w * 2.1;
      const baseX = tip.x - ux * head;
      const baseY = tip.y - uy * head;
      const endX = tip.x - ux * head * 0.7;
      const endY = tip.y - uy * head * 0.7;
      overlay +=
        `<svg class="hlx" style="position:absolute;left:0;top:0;overflow:visible;filter:drop-shadow(0 ${f(w * 0.3)} ${f(w * 0.6)} rgba(0,0,0,.22))" width="1" height="1">` +
        `<path d="M${f2(start.x)} ${f2(start.y)} Q${f2(mid.x)} ${f2(mid.y)} ${f2(endX)} ${f2(endY)}" fill="none" stroke="${esc(h.color)}" stroke-width="${f2(w)}" stroke-linecap="round"/>` +
        `<path d="M${f2(tip.x)} ${f2(tip.y)} L${f2(baseX - uy * half)} ${f2(baseY + ux * half)} Q${f2(baseX + ux * head * 0.12)} ${f2(baseY + uy * head * 0.12)} ${f2(baseX + uy * half)} ${f2(baseY - ux * half)} Z" fill="${esc(h.color)}" stroke="${esc(h.color)}" stroke-width="${f2(w * 0.5)}" stroke-linejoin="round"/>` +
        `</svg>`;
    }
    if (h.style === "loupe" && h.loupe) {
      const d = h.loupe.d * s;
      const m = h.scale;
      const cx = X(h.loupe.cx);
      const cy = Y(h.loupe.cy);
      overlay +=
        `<div class="hlx" style="position:absolute;left:${f(cx - d / 2)};top:${f(cy - d / 2)};width:${f(d)};height:${f(d)};border-radius:50%;overflow:hidden;transform:scale(calc(0.85 + 0.15 * var(--hl, 1)));` +
        `background-color:#fff;background-image:url(&quot;${url}&quot;);background-size:${f(iw * m)} ${f(ih * m)};` +
        `background-position:${f(d / 2 - h.loupe.tx * s * m)} ${f(d / 2 - h.loupe.ty * s * m)};` +
        `box-shadow:0 0 0 ${f(3 * u)} ${esc(h.color)}, 0 ${f(10 * u)} ${f(30 * u)} rgba(0,0,0,.28), 0 ${f(2 * u)} ${f(6 * u)} rgba(0,0,0,.16)">` +
        `<div style="position:absolute;inset:0;border-radius:50%;background:radial-gradient(circle at 30% 25%, rgba(255,255,255,.35), rgba(255,255,255,0) 45%);box-shadow:inset 0 0 ${f(10 * u)} rgba(0,0,0,.18)"></div></div>`;
    }
    clipped = clipped.slice(0, c0) + tag(clipped.slice(c0), k);
    overlay = overlay.slice(0, v0) + tag(overlay.slice(v0), k);
  }
  return { clipped: wrap(clipped, false), overlay: overlay ? wrap(overlay, false) : "" };
}

// ---------------------------------------------------------------------------------------------
// Hardware

/**
 * Apple Watch hardware, placed like Apple's product shots: the Digital Crown a quarter of the way
 * down the right side (a knurled cylinder with a neck and a chamfered cap), the flush side button
 * below it and, on Ultra, the crown guard, the orange ring on the crown and the orange Action
 * button on the left. Sizes are fractions of the case; parts tuck under the case edge.
 */
function watchParts(model: DeviceModel, W: number, H: number, T: number, depth: boolean): string {
  const z = depth ? `transform:translateZ(${f(-T * 0.5)});` : "";
  const part = (cls: string, box: string) => `<div class="wp ${cls}" style="${box};${z}"></div>`;
  if (model.id.includes("ultra")) {
    return (
      part("guard", `right:${f(-W * 0.036)};top:${f(H * 0.19)};width:${f(W * 0.07)};height:${f(H * 0.61)};border-radius:${f(W * 0.034)}`) +
      part("crown ultra", `right:${f(-W * 0.098)};top:${f(H * 0.245)};width:${f(W * 0.09)};height:${f(H * 0.225)};border-radius:${f(W * 0.014)}`) +
      part("button", `right:${f(-W * 0.052)};top:${f(H * 0.545)};width:${f(W * 0.04)};height:${f(H * 0.2)};border-radius:${f(W * 0.02)}`) +
      part("action", `left:${f(-W * 0.03)};top:${f(H * 0.3)};width:${f(W * 0.05)};height:${f(H * 0.235)};border-radius:${f(W * 0.022)}`)
    );
  }
  return (
    part("crown", `right:${f(-W * 0.066)};top:${f(H * 0.235)};width:${f(W * 0.085)};height:${f(H * 0.195)};border-radius:${f(W * 0.012)}`) +
    part("button", `right:${f(-W * 0.017)};top:${f(H * 0.54)};width:${f(W * 0.035)};height:${f(H * 0.25)};border-radius:${f(W * 0.017)}`)
  );
}

function protrusion(model: DeviceModel, b: ChromeButton): number {
  if (b.name.includes("crown")) return b.depth * 0.55;
  if (model.family === "watch") return 3;
  if (model.family === "ipad") return 1.8;
  return 2.3;
}

function buttonsHtml(model: DeviceModel, u: number, border: number, W: number, H: number, T: number, depth: boolean, back: boolean): string {
  // Seen from behind, left and right swap.
  const side = (s: ChromeButton["side"]) => (back ? (s === "left" ? "right" : s === "right" ? "left" : s) : s);
  // In 3D a button is a real box across the middle of the band: two end caps (its outline at the
  // front and back of the button) joined by its outward face, turned to face sideways.
  const z0 = 0.22;
  const z1 = 0.78;
  const tab = (style: string, radius: number, cls: string, s: ChromeButton["side"], out = 0) => {
    const body = `<div class="btn ${cls}" style="${style};border-radius:${f(radius)}`;
    if (!depth) return `${body}"></div>`;
    let html = `${body};--shade:.22;transform:translateZ(${f(-T * z0)})"></div>` + `${body};--shade:.3;transform:translateZ(${f(-T * z1)})"></div>`;
    if (s === "left" || s === "right") {
      // The outward face: D wide (the button's span through the body), standing on the outer edge.
      const D = T * (z1 - z0);
      const m = /top:([\d.]+)px;.*height:([\d.]+)px/.exec(style);
      if (m) {
        const x = s === "right" ? W + out : -out;
        const start = s === "right" ? z0 : z1;
        html += `<div class="btn-face ${cls}" style="left:${f(x)};top:${m[1]}px;width:${f(D)};height:${m[2]}px;border-radius:${f(radius)};transform-origin:0 50%;transform:translateZ(${f(-T * start)}) rotateY(${s === "right" ? 90 : -90}deg)"></div>`;
      }
    }
    return html;
  };
  const out: string[] = [];
  for (const b of model.buttons) {
    const s = side(b.side);
    const p = protrusion(model, b) * u;
    const tuck = 3 * u;
    const len = b.length * u;
    const crown = b.name.includes("crown");
    let style: string;
    if (s === "left" || s === "right") {
      const top = (border + b.offset) * u;
      style = `${s === "left" ? `left:${f(-p)}` : `right:${f(-p)}`};top:${f(top)};width:${f(p + tuck)};height:${f(len)}`;
    } else {
      const edge = (border + b.offset) * u;
      const trailing = (b.align === "trailing") !== back;
      const left = trailing ? W - edge - len : edge;
      style = `${s === "top" ? `top:${f(-p)}` : `bottom:${f(-p)}`};left:${f(left)};height:${f(p + tuck)};width:${f(len)}`;
    }
    out.push(tab(style, Math.min(p, 6 * u), `side-${s}${crown ? " crown" : ""}`, s, p));
  }
  // Camera Control: sapphire, nearly flush, two-thirds of the way down the right side.
  if (model.cameraControl && model.family === "iphone") {
    const s = side("right");
    const len = model.cameraControl.length * u;
    const p = 0.9 * u;
    const style = `${s === "left" ? `left:${f(-p)}` : `right:${f(-p)}`};top:${f(model.cameraControl.at * H - len / 2)};width:${f(p + 3 * u)};height:${f(len)}`;
    out.push(tab(style, p, `cc side-${s}`, s, p));
  }
  return out.join("");
}

/**
 * The device's thickness in 3D: copies of its outline stacked behind the face. Each copy is a
 * full-size composited layer, so keep the count modest; at the tilts people use, ~1.5px spacing
 * reads as a solid edge. Only a sliver of each copy shows, at the outline, so each is shaded for
 * where it sits: a dark line at the cover glass, a bright band where the metal rounds toward the
 * light, falling off toward the back; lighter on the top and left sides than on the others.
 */
function slabs(radius: string, T: number, color: string, opts: { antenna?: number[]; back?: boolean; u?: number } = {}): string {
  const n = Math.max(6, Math.min(24, Math.ceil(T / 1.5)));
  const al = (opts.u ?? 1) * 0.7;
  const lines = (opts.antenna ?? [])
    .map((a) => `linear-gradient(180deg, transparent calc(${a * 100}% - ${f(al)}), rgba(0,0,0,.4) calc(${a * 100}% - ${f(al)}) calc(${a * 100}% + ${f(al)}), transparent calc(${a * 100}% + ${f(al)}))`)
    .join(", ");
  const sides =
    "linear-gradient(90deg, rgba(255,255,255,.24), rgba(255,255,255,0) 9%, rgba(0,0,0,0) 91%, rgba(0,0,0,.3)), " +
    "linear-gradient(180deg, rgba(255,255,255,.2), rgba(255,255,255,0) 7%, rgba(0,0,0,0) 93%, rgba(0,0,0,.28))";
  let out = "";
  for (let i = 1; i <= n; i++) {
    const t = i / n;
    // Distance from the cover glass (0) to the far side (1).
    const p = opts.back ? 1 - t + 1 / n : t;
    let base: string;
    if (p <= 0.07) base = "#0d0d0f";
    else {
      const light = 0.32 * Math.exp(-(((p - 0.2) / 0.11) ** 2)) - 0.26 * Math.min(1, Math.max(0, (p - 0.62) / 0.38)) ** 1.4;
      const pct = Math.round(Math.abs(light) * 100);
      base = light >= 0 ? `color-mix(in oklab, ${color}, white ${pct}%)` : `color-mix(in oklab, ${color}, black ${pct}%)`;
    }
    out += `<div class="slab" style="border-radius:${radius};transform:translateZ(${f(-T * t)});background:${lines ? lines + ", " : ""}${sides}, ${base}"></div>`;
  }
  return out;
}

/** The camera housing standing proud of the back in 3D: behind the phone, or toward the viewer. */
function housingSlabs(model: DeviceModel, W: number, R: number, T: number, u: number, back: boolean): string {
  const h = housingOutline(model, W, R);
  if (!h) return "";
  const P = 8 * u;
  const K = 4;
  let out = "";
  for (let k = 1; k <= K; k++) {
    // From the back: the walls under the lifted housing. From the front: the bump behind the phone.
    const z = back ? (P * (k - 1)) / K : -T - (P * k) / K;
    const x = back ? h.x : W - h.x - h.w;
    out += `<div class="slab housing" style="inset:auto;left:${f(x)};top:${f(h.y)};width:${f(h.w)};height:${f(h.h)};border-radius:${h.radius};transform:translateZ(${f(z)});background:color-mix(in oklab, var(--c), black ${16 + k * 4}%)"></div>`;
  }
  return out;
}

function phoneLike(o: FrameOptions, u: number, depth: boolean): FrameOutput {
  const model = o.model!;
  const sw = model.screen.width / model.screen.scale;
  const sh = model.screen.height / model.screen.scale;
  const { turn } = orientation(o);
  const r = model.screen.cornerRadius;
  const border = model.bezel + model.frame;
  const W = (sw + border * 2) * u;
  const H = (sh + border * 2) * u;
  const outerR = (r + border) * u;
  const glassR = (r + model.bezel) * u;
  const T = model.thickness * u;
  const zShift = depth ? `transform:translateZ(${f(-T * 0.5)})` : "";
  const back = Boolean(o.back) && model.family === "iphone";

  let cutout = "";
  const drawIsland = o.island === "always" || (o.island === "auto" && !o.facts.hasIsland);
  if (model.cutout === "island" && drawIsland) {
    const iw = (model.island ?? ISLAND).width * u;
    const ih = (model.island ?? ISLAND).height * u;
    cutout = `<div class="island" style="top:${f(islandTop(sw) * u)};left:50%;width:${f(iw)};height:${f(ih)};transform:translateX(-50%);border-radius:${f(ih)}"></div>`;
  } else if (model.cutout === "notch" && o.island !== "never") {
    cutout = `<div class="notch" style="top:0;left:50%;width:${f(PHONE_NOTCH.width * u)};height:${f(PHONE_NOTCH.height * u)};transform:translateX(-50%);border-radius:0 0 ${f(PHONE_NOTCH.radius * u)} ${f(PHONE_NOTCH.radius * u)};--ear:${f(6 * u)}"></div>`;
  }

  let camera = "";
  if (model.family === "ipad") {
    const d = 5 * u;
    const inset = (model.bezel / 2) * u - d / 2;
    camera =
      model.camera === "short-edge"
        ? `<div class="camera" style="width:${f(d)};height:${f(d)};top:${f(inset)};left:50%;margin-left:${f(-d / 2)}"></div>`
        : `<div class="camera" style="width:${f(d)};height:${f(d)};right:${f(inset)};top:50%;margin-top:${f(-d / 2)}"></div>`;
  }

  // Watch: the case sits between two band stubs, the part of the band a product shot shows. Each
  // stub tucks under the case, darkens where it meets it, and curves away (darker) at its far end.
  let band = "";
  let caseTop = 0;
  if (showsBand(o)) {
    caseTop = H * WATCH_BAND;
    const bw = W * (model.id.includes("ultra") ? 0.72 : 0.64);
    const L = H * WATCH_BAND;
    const under = H * 0.12;
    const bc = esc(o.band ?? defaultBand(model, o.color));
    const stub = (top: number, far: "top" | "bottom") => {
      const toFar = far === "top" ? "0deg" : "180deg";
      const r = bw * 0.07;
      // The band curves away from the viewer: a touch narrower and darker at its far end.
      const taper = far === "top" ? "polygon(3% 0, 97% 0, 100% 100%, 0 100%)" : "polygon(0 0, 100% 0, 97% 100%, 3% 100%)";
      return (
        `<div class="band" style="--band:${bc};width:${f(bw)};height:${f(L + under)};left:${f((W - bw) / 2)};top:${f(top)};` +
        `border-radius:${far === "top" ? `${f(r)} ${f(r)} 0 0` : `0 0 ${f(r)} ${f(r)}`};clip-path:${taper};${zShift}">` +
        `<div style="position:absolute;inset:0;border-radius:inherit;background:linear-gradient(${toFar}, rgba(0,0,0,.26) 0%, rgba(0,0,0,0) 12%, rgba(0,0,0,0) 86%, rgba(0,0,0,.24) 100%)"></div></div>`
      );
    };
    band = stub(0, "top") + stub(caseTop + H - under, "bottom");
  }

  // Antenna lines break the metal band on the long sides.
  const antenna = (model.antenna ?? [])
    .map((a) => ["left", "right"].map((side) => `<div class="antenna" style="${side}:0;top:${f(a * H - 0.7 * u)};width:${f(model.frame * u)};height:${f(1.4 * u)}"></div>`).join(""))
    .join("");
  const edge =
    (depth ? slabs(f(outerR), T, "var(--c)", { antenna: model.antenna, back, u }) + housingSlabs(model, W, outerR, T, u, back) : "") +
    (o.buttons ? (model.family === "watch" ? watchParts(model, W, H, T, depth) : buttonsHtml(model, u, border, W, H, T, depth, back)) : "");
  const open = `<div class="device ${depth ? "d3" : ""} fam-${model.family} finish-${model.finish}${model.id.includes("watch-ultra") ? " watch-ultra" : ""}${back ? " back" : ""}${o.studio ? " studio" : ""}" style="--c:${esc(o.color)};--u:${u};--rise:${f(8 * u)};width:${f(W)};height:${f(H)}">`;
  if (back) {
    const html =
      open +
      edge +
      `<div class="face back" style="border-radius:${f(outerR)}">` +
      (o.studio ? `<div class="key" style="border-radius:${f(outerR)}"></div>` : "") +
      backHtml(model, W, H, outerR, model.frame * u) +
      `</div></div>`;
    return { html, width: W, height: H, turn };
  }

  const c = content(o, sw * u, sh * u, turn, u);
  const inset = model.bezel * u;
  const body =
    edge +
    `<div class="face" style="border-radius:${f(outerR)}">` +
    antenna +
    (o.studio ? `<div class="key" style="border-radius:${f(outerR)}"></div>` : "") +
    `<div class="glass" style="inset:${f(model.frame * u)};border-radius:${f(glassR)}">` +
    camera +
    `<div class="screen" style="inset:${f(inset)};border-radius:${f(r * u)}">${c.clipped}${cutout}</div>` +
    (c.overlay ? `<div class="hl" style="inset:${f(inset)}">${c.overlay}</div>` : "") +
    (o.glare ? `<div class="glare" style="border-radius:${f(glassR)}"></div>` : "") +
    `</div></div>`;
  if (band) {
    // The frame box holds the band stubs too; the case sits between them.
    const total = H + caseTop * 2;
    const html =
      open.replace(`height:${f(H)}"`, `height:${f(total)}"`) +
      band +
      `<div class="watch-case" style="left:0;top:${f(caseTop)};width:${f(W)};height:${f(H)}">${body}</div></div>`;
    return { html, width: W, height: total, turn };
  }
  return { html: open + body + `</div>`, width: W, height: H, turn };
}

/**
 * A MacBook keyboard, laid out in key units like the real one (US layout): function row, five
 * rows and the inverted-T arrows. `w` is the keyboard's width in px.
 */
function keyboardHtml(w: number): { html: string; height: number } {
  const rows: Array<Array<number | [number, "arrows"]>> = [
    [1.55, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
    [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1.55],
    [1.55, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
    [1.8, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1.75],
    [2.3, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 2.25],
    [1, 1, 1, 1.25, 5.1, 1.25, 1, [3, "arrows"]],
  ];
  const gap = 0.13;
  const units = 14.55 + 13 * gap;
  const k = w / units;
  let y = 0;
  let html = "";
  rows.forEach((row, ri) => {
    const h = (ri === 0 ? 0.55 : 1) * k;
    const total = row.reduce<number>((a, x) => a + (Array.isArray(x) ? x[0] : x), 0) + (row.length - 1) * gap;
    const stretch = (units - (row.length - 1) * gap) / (total - (row.length - 1) * gap);
    let x = 0;
    for (const key of row) {
      const kw = (Array.isArray(key) ? key[0] : key) * stretch * k;
      if (Array.isArray(key)) {
        // ← ↑↓ →: three half-height keys along the bottom, with ↑ above ↓.
        const aw = (kw - 2 * gap * k) / 3;
        const hh = (h - gap * k * 0.5) / 2;
        html += `<i style="left:${f(x)};top:${f(y + h - hh)};width:${f(aw)};height:${f(hh)}"></i>`;
        html += `<i style="left:${f(x + aw + gap * k)};top:${f(y)};width:${f(aw)};height:${f(hh)}"></i>`;
        html += `<i style="left:${f(x + aw + gap * k)};top:${f(y + h - hh)};width:${f(aw)};height:${f(hh)}"></i>`;
        html += `<i style="left:${f(x + 2 * (aw + gap * k))};top:${f(y + h - hh)};width:${f(aw)};height:${f(hh)}"></i>`;
      } else {
        html += `<i style="left:${f(x)};top:${f(y)};width:${f(kw)};height:${f(h)}"></i>`;
      }
      x += kw + gap * k;
    }
    y += h + gap * k;
  });
  return { html, height: y - gap * k };
}

function laptop(o: FrameOptions, u: number, depth: boolean): FrameOutput {
  const m = o.model!;
  const sw = m.screen.width / m.screen.scale;
  const sh = m.screen.height / m.screen.scale;
  const chin = m.chin ?? m.bezel;
  const lidW = (sw + (m.bezel + m.frame) * 2) * u;
  const lidH = (sh + m.bezel + chin + m.frame * 2) * u;
  // Seen straight on, the base reads a little wider than the lid (it's nearer the camera); in 3D,
  // perspective does that for real, so the body is drawn at its true width.
  const baseW = lidW * 1.1;
  const baseH = lidW * 0.028;
  const W = baseW;
  const H = lidH + baseH;
  const lidX = (W - lidW) / 2;
  const r = m.screen.cornerRadius * u;
  const lidR = `${f(r + 12 * u)} ${f(r + 12 * u)} ${f(8 * u)} ${f(8 * u)}`;
  const bar = o.menuBar && o.island !== "never" ? MAC_MENU_BAR * u : 0;
  const c = content(o, sw * u, sh * u - bar, 0, u, bar > 0);
  const shot = bar ? macMenuBar(o, sw * u, bar, u) + `<div style="position:absolute;left:0;right:0;top:${f(bar)};bottom:0;overflow:hidden">${c.clipped}</div>` : c.clipped;
  const notch =
    o.island === "never"
      ? ""
      : `<div class="notch mac" style="top:0;left:50%;width:${f(MAC_NOTCH.width * u)};height:${f(MAC_NOTCH.height * u)};transform:translateX(-50%);border-radius:0 0 ${f(MAC_NOTCH.radius * u)} ${f(MAC_NOTCH.radius * u)};--ear:${f(4 * u)}"><div style="position:absolute;left:50%;top:50%;width:${f(5 * u)};height:${f(5 * u)};margin:${f(-2.5 * u)};border-radius:50%;background:#15181f;box-shadow:inset 0 0 0 ${f(1 * u)} #1f2430"></div></div>`;
  const lid =
    `<div class="face lid" style="left:${f(lidX)};top:0;width:${f(lidW)};height:${f(lidH)};border-radius:${lidR}">` +
    (o.studio ? `<div class="key" style="border-radius:inherit"></div>` : "") +
    `<div class="glass mac" style="inset:${f(m.frame * u)};border-radius:${f(r + 9 * u)} ${f(r + 9 * u)} ${f(5 * u)} ${f(5 * u)}">` +
    `<div class="screen" style="left:${f(m.bezel * u)};top:${f(m.bezel * u)};width:${f(sw * u)};height:${f(sh * u)};border-radius:${f(r)} ${f(r)} 0 0">${shot}${notch}</div>` +
    (c.overlay ? `<div class="hl" style="left:${f(m.bezel * u)};top:${f(m.bezel * u + bar)};width:${f(sw * u)};height:${f(sh * u - bar)}">${c.overlay}</div>` : "") +
    (o.glare ? `<div class="glare" style="border-radius:inherit"></div>` : "") +
    `</div></div>`;
  const open = `<div class="device fam-mac finish-${m.finish}${depth ? " d3" : ""}${o.studio ? " studio" : ""}" style="--c:${esc(o.color)};--u:${u};width:${f(W)};height:${f(H)}">`;

  if (!depth) {
    const foot = (x: number) => `<div class="mac-foot" style="left:${f(x)};top:${f(H - 0.6 * u)};width:${f(lidW * 0.07)};height:${f(2.2 * u)}"></div>`;
    const html =
      open +
      foot(lidX + lidW * 0.06) +
      foot(lidX + lidW * 0.87) +
      lid +
      `<div class="mac-base" style="left:0;top:${f(lidH - 1)};width:${f(baseW)};height:${f(baseH)};border-radius:${f(1.5 * u)} ${f(1.5 * u)} ${f(baseH * 0.9)} ${f(baseH * 0.9)} / ${f(1.5 * u)} ${f(1.5 * u)} ${f(baseH)} ${f(baseH)}">` +
      `<div class="mac-hinge" style="left:${f(lidX - (W - baseW) / 2 + lidW * 0.02)};width:${f(lidW * 0.96)};height:${f(baseH * 0.26)}"></div>` +
      `<div class="mac-scoop" style="left:50%;top:0;width:${f(lidW * 0.14)};height:${f(baseH * 0.42)};margin-left:${f(-lidW * 0.07)};border-radius:0 0 ${f(baseH * 0.5)} ${f(baseH * 0.5)}"></div></div>` +
      `</div>`;
    return { html, width: W, height: H, turn: 0 };
  }

  // 3D: the lid has thickness, and the body is a real slab: the keyboard deck runs from the
  // hinge toward the viewer, with the front edge (and its thumb scoop) at the far end.
  const D = lidW * 0.708; // depth of the body, 221 of 312.6 mm on a 14-inch MacBook Pro
  const lidT = lidW * 0.016;
  let lidEdge = "";
  const n = 7;
  for (let i = 1; i <= n; i++) {
    const t = i / n;
    const shade = Math.round(12 + 26 * t);
    lidEdge += `<div class="slab" style="inset:auto;left:${f(lidX)};top:0;width:${f(lidW)};height:${f(lidH)};border-radius:${lidR};transform:translateZ(${f(-lidT * t)});background:linear-gradient(90deg, rgba(255,255,255,.2), rgba(255,255,255,0) 6%, rgba(0,0,0,0) 94%, rgba(0,0,0,.28)), color-mix(in oklab, var(--c), black ${shade}%)"></div>`;
  }
  const pro = /pro/i.test(m.name);
  const kbW = lidW * (pro ? 0.775 : 0.86);
  const kb = keyboardHtml(kbW);
  const kbTop = D * 0.055;
  const tpW = lidW * 0.48;
  const tpTop = kbTop + kb.height + D * 0.045;
  const tpH = D * 0.93 - tpTop;
  const grille = (x: number) => `<div class="mac-grille" style="left:${f(x)};top:${f(kbTop)};width:${f((lidW - kbW) / 2 - lidW * 0.035)};height:${f(kb.height)}"></div>`;
  const deck =
    `<div class="mac-deck" style="left:${f(lidX)};top:${f(lidH)};width:${f(lidW)};height:${f(D)}">` +
    `<div class="mac-deck-hinge" style="height:${f(D * 0.028)}"></div>` +
    (pro ? grille(lidW * 0.02) + grille(lidX * 0 + lidW - lidW * 0.02 - ((lidW - kbW) / 2 - lidW * 0.035)) : "") +
    `<div class="mac-keys" style="left:${f((lidW - kbW) / 2)};top:${f(kbTop)};width:${f(kbW)};height:${f(kb.height)}">${kb.html}</div>` +
    `<div class="mac-trackpad" style="left:${f((lidW - tpW) / 2)};top:${f(tpTop)};width:${f(tpW)};height:${f(tpH)};border-radius:${f(tpW * 0.03)}"></div>` +
    `</div>`;
  const lip =
    `<div class="mac-base" style="left:${f(lidX)};top:${f(lidH)};width:${f(lidW)};height:${f(baseH)};border-radius:0 0 ${f(baseH * 0.6)} ${f(baseH * 0.6)};transform:translateZ(${f(D)})">` +
    `<div class="mac-scoop" style="left:50%;top:0;width:${f(lidW * 0.14)};height:${f(baseH * 0.42)};margin-left:${f(-lidW * 0.07)};border-radius:0 0 ${f(baseH * 0.5)} ${f(baseH * 0.5)}"></div></div>`;
  const sides =
    `<div class="mac-side" style="left:${f(lidX)};top:${f(lidH)};width:${f(D)};height:${f(baseH)};transform-origin:0 0;transform:rotateY(-90deg)"></div>` +
    `<div class="mac-side" style="left:${f(lidX + lidW - D)};top:${f(lidH)};width:${f(D)};height:${f(baseH)};transform-origin:100% 0;transform:rotateY(90deg)"></div>` +
    `<div class="mac-bottom" style="left:${f(lidX)};top:${f(lidH + baseH)};width:${f(lidW)};height:${f(D)}"></div>`;
  const html = open + lidEdge + lid + sides + deck + lip + `</div>`;
  return { html, width: W, height: H, turn: 0 };
}

// ---------------------------------------------------------------------------------------------
// Flat frames: browser, window, card, none

function trafficLights(u: number, cy: number): string {
  const colors = ["#ff5f57", "#febc2e", "#28c840"];
  return colors
    .map((c, i) => `<div style="position:absolute;left:${f((20 + i * 20 - 6) * u)};top:${f(cy - 6 * u)};width:${f(12 * u)};height:${f(12 * u)};border-radius:50%;background:${c};box-shadow:inset 0 0 0 ${f(0.5 * u)} rgba(0,0,0,.18)"></div>`)
    .join("");
}

function flat(o: FrameOptions, u: number, depth: boolean): FrameOutput {
  const { w, h } = croppedSize(o.image);
  const cw = (w / o.image.scale) * u;
  const ch = (h / o.image.scale) * u;
  const dark = o.chrome === "dark";
  const bar = (o.kind === "window" ? WINDOW_BAR : o.kind === "browser" ? BROWSER_BAR : 0) * u;
  const W = cw;
  const H = ch + bar;
  // A device shown without its hardware (no Apple art) keeps its screen's own rounded corners.
  const R = o.radius ?? (o.kind === "card" && o.model ? o.model.screen.cornerRadius * u : o.kind === "none" ? 0 : o.kind === "card" ? Math.min(W, H) * 0.035 : 12 * u);
  const c = content(o, cw, ch, 0, u);
  const barBg = dark ? "#2a2a2c" : "#f3f3f5";
  const ink = dark ? "#e6e6e8" : "#3a3a3c";
  const faint = dark ? "#8e8e93" : "#8a8a8e";

  let chrome = "";
  if (o.kind === "window") {
    chrome =
      `<div class="bar" style="height:${f(bar)};background:${barBg};border-bottom:${f(0.5 * u)} solid ${dark ? "#000" : "#d9d9dd"}">` +
      trafficLights(u, bar / 2) +
      (o.title ? `<div style="position:absolute;left:0;right:0;top:0;height:${f(bar)};line-height:${f(bar)};text-align:center;font:600 ${f(13 * u)} -apple-system,system-ui,sans-serif;color:${ink}">${esc(o.title)}</div>` : "") +
      `</div>`;
  } else if (o.kind === "browser") {
    const fieldW = Math.min(W * 0.5, 560 * u);
    const chevron = (x: number, flip: boolean) =>
      `<svg style="position:absolute;left:${f(x)};top:${f(bar / 2 - 8 * u)}" width="${f(16 * u)}" height="${f(16 * u)}" viewBox="0 0 16 16"><path d="${flip ? "M6 3l5 5-5 5" : "M10 3L5 8l5 5"}" fill="none" stroke="${faint}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
    const icon = (x: number, path: string) =>
      `<svg style="position:absolute;right:${f(x)};top:${f(bar / 2 - 9 * u)}" width="${f(18 * u)}" height="${f(18 * u)}" viewBox="0 0 18 18"><path d="${path}" fill="none" stroke="${faint}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
    chrome =
      `<div class="bar" style="height:${f(bar)};background:${barBg};border-bottom:${f(0.5 * u)} solid ${dark ? "#000" : "#dcdce0"}">` +
      trafficLights(u, bar / 2) +
      chevron(86 * u, false) +
      chevron(110 * u, true) +
      `<div style="position:absolute;left:50%;top:${f(bar / 2 - 16 * u)};width:${f(fieldW)};height:${f(32 * u)};margin-left:${f(-fieldW / 2)};border-radius:${f(10 * u)};background:${dark ? "#3a3a3c" : "#e6e6ea"};display:flex;align-items:center;justify-content:center;gap:${f(6 * u)};font:500 ${f(13 * u)} -apple-system,system-ui,sans-serif;color:${ink}">` +
      (o.url
        ? `<svg width="${f(10 * u)}" height="${f(12 * u)}" viewBox="0 0 10 12"><rect x="1" y="5" width="8" height="6.5" rx="1.5" fill="${faint}"/><path d="M3 5V3.5a2 2 0 014 0V5" fill="none" stroke="${faint}" stroke-width="1.4"/></svg>` +
          `<span>${esc(o.url)}</span>`
        : "") +
      `</div>` +
      icon(62 * u, "M9 3v9M5.5 6.5L9 3l3.5 3.5M4 10v4.5h10V10") +
      icon(34 * u, "M9 3.5v11M3.5 9h11") +
      icon(8 * u, "M4 4h7.5v7.5H4zM6.5 6.5v8h8v-8") +
      `</div>`;
  }

  const bodyBg = dark ? "#1c1c1e" : "#ffffff";
  const border = o.kind === "none" ? "" : `box-shadow:inset 0 0 0 ${f(0.5 * u)} ${dark ? "rgba(255,255,255,.14)" : "rgba(0,0,0,.14)"};`;
  const T = FLAT_DEPTH * u;
  const html =
    `<div class="device flat${depth ? " d3" : ""}" style="--c:${dark ? "#1c1c1e" : "#d9d9de"};--u:${u};width:${f(W)};height:${f(H)}">` +
    (depth && o.kind !== "none" ? slabs(f(R), T, "var(--c)") : "") +
    `<div class="face flat-face" style="border-radius:${f(R)};background:${bodyBg};overflow:hidden">` +
    chrome +
    `<div class="screen" style="left:0;top:${f(bar)};width:${f(cw)};height:${f(ch)}">${c.clipped}</div>` +
    `<div style="position:absolute;inset:0;border-radius:${f(R)};pointer-events:none;${border}"></div>` +
    `</div>` +
    (c.overlay ? `<div class="hl" style="left:0;top:${f(bar)};width:${f(cw)};height:${f(ch)}">${c.overlay}</div>` : "") +
    `</div>`;
  return { html, width: W, height: H, turn: 0 };
}

/**
 * A frame made from an installed product bezel: the screenshot sits in the art's transparent
 * opening, under the art. In 3D the device's thickness is the art's own silhouette (used as a
 * mask) extruded behind it and tinted with the frame colour, so edges and buttons line up exactly.
 */
function bezelFrame(o: FrameOptions, u: number, depth: boolean): FrameOutput {
  const m = o.model!;
  const b = o.bezel!;
  const k = bezelScale(o) * u; // rendered px per image px
  const W = b.width * k;
  const H = b.height * k;
  const turn = m.family === "mac" ? 0 : orientation(o).turn;
  // A pixel of overlap hides the art's anti-aliased edge.
  const pad = Math.max(1, k * 1.5);
  const hx = b.hole.x * k - pad;
  const hy = b.hole.y * k - pad;
  const hw = b.hole.w * k + pad * 2;
  const hh = b.hole.h * k + pad * 2;
  const hr = b.hole.r * k;
  const sw = m.screen.width / m.screen.scale;
  const mac = m.family === "mac";
  const bar = mac && o.menuBar && o.island !== "never" ? MAC_MENU_BAR * u + pad : 0;
  const c = content(o, hw, hh - bar, turn, u, bar > 0);
  const shot = bar ? macMenuBar(o, hw, bar, u) + `<div style="position:absolute;left:0;right:0;top:${f(bar)};bottom:0;overflow:hidden">${c.clipped}</div>` : c.clipped;
  let cutout = "";
  if (!b.cutout && o.island !== "never") {
    if (mac) {
      cutout = `<div class="notch mac" style="top:${f(pad)};left:50%;width:${f(MAC_NOTCH.width * u)};height:${f(MAC_NOTCH.height * u)};transform:translateX(-50%);border-radius:0 0 ${f(MAC_NOTCH.radius * u)} ${f(MAC_NOTCH.radius * u)};--ear:${f(4 * u)}"></div>`;
    } else if (m.cutout === "island" && (o.island === "always" || !o.facts.hasIsland)) {
      const iw = (m.island ?? ISLAND).width * u;
      const ih = (m.island ?? ISLAND).height * u;
      cutout = `<div class="island" style="top:${f(pad + islandTop(sw) * u)};left:50%;width:${f(iw)};height:${f(ih)};transform:translateX(-50%);border-radius:${f(ih)}"></div>`;
    }
  }
  let edge = "";
  // Tilted, an iPhone or iPad gets its thickness from its own silhouette. A watch's art includes its
  // band and a MacBook's is the open laptop, so their silhouettes can't be extruded: they tilt flat.
  if (depth && (drawnFrames() || m.family === "iphone" || m.family === "ipad")) {
    const T = m.thickness * u;
    const n = Math.max(6, Math.min(24, Math.ceil(T / 1.5)));
    const mask = `-webkit-mask:url(&quot;${esc(b.url)}&quot;) 0 0 / 100% 100% no-repeat;mask:url(&quot;${esc(b.url)}&quot;) 0 0 / 100% 100% no-repeat;`;
    for (let i = 1; i <= n; i++) {
      const t = i / n;
      const light = 0.3 * Math.exp(-(((t - 0.2) / 0.11) ** 2)) - 0.26 * Math.min(1, Math.max(0, (t - 0.62) / 0.38)) ** 1.4;
      const pct = Math.round(Math.abs(light) * 100);
      const base = t <= 0.06 ? "#0d0d0f" : `color-mix(in oklab, var(--c), ${light >= 0 ? "white" : "black"} ${pct}%)`;
      edge += `<div class="slab" style="${mask}transform:translateZ(${f(-T * t)});background:linear-gradient(90deg, rgba(255,255,255,.22), rgba(255,255,255,0) 9%, rgba(0,0,0,0) 91%, rgba(0,0,0,.3)), ${base}"></div>`;
    }
  }
  const html =
    `<div class="device bezel fam-${m.family}${depth ? " d3" : ""}" style="--c:${esc(b.edge)};--u:${u};width:${f(W)};height:${f(H)}">` +
    edge +
    `<div class="screen" style="left:${f(hx)};top:${f(hy)};width:${f(hw)};height:${f(hh)};border-radius:${f(hr)};corner-shape:superellipse(1.35)">${shot}${cutout}</div>` +
    (c.overlay ? `<div class="hl" style="left:${f(hx)};top:${f(hy + bar)};width:${f(hw)};height:${f(hh - bar)}">${c.overlay}</div>` : "") +
    `<img class="bezel-art" src="${esc(b.url)}" style="left:0;top:0;width:${f(W)};height:${f(H)}">` +
    (o.glare ? `<div class="glare" style="left:${f(hx)};top:${f(hy)};width:${f(hw)};height:${f(hh)};border-radius:${f(hr)}"></div>` : "") +
    `</div>`;
  return { html, width: W, height: H, turn };
}

/** The macOS menu bar across the top of a MacBook's screen, beside the notch, with 13pt text. */
function macMenuBar(o: FrameOptions, W: number, H: number, u: number): string {
  const spec: MenuBarSpec = typeof o.menuBar === "object" ? o.menuBar : {};
  const background = spec.style === "dark" ? "#141417" : "#e9e8ee";
  return menuBarHtml(spec, W, H, 13 * u, { notch: MAC_NOTCH.width * u, background });
}

/** Render a frame at `u` rendered pixels per point. */
export function renderFrame(o: FrameOptions, u: number, depth: boolean): FrameOutput {
  if (o.kind !== "device") return flat(o, u, depth);
  if (usesBezel(o, depth)) return bezelFrame(o, u, depth);
  if (o.model!.family === "mac") return laptop(o, u, depth);
  return phoneLike(o, u, depth);
}

/** Shared CSS for every device on the page. */
export const FRAME_CSS = BACK_CSS + `
.device { position:absolute; left:0; top:0; }
.device.d3 { transform-style:preserve-3d; }
.device .face, .device .glass, .device .screen, .device .slab, .device .glare, .device .hl, .device .key, .device .bar { position:absolute; }
/* Apple's corners are continuous curves, not circular arcs. */
.device:not(.flat) .face, .device:not(.flat) .glass, .device:not(.flat) .screen, .device:not(.flat) .slab, .device:not(.flat) .glare, .device .back-glass, .device .back-window { corner-shape: superellipse(1.35); }
.device .slab { inset:0; }
.device .bar { left:0; right:0; top:0; }
.device .hl { pointer-events:none; }
.hlx { opacity:calc(var(--o, 1) * var(--hl, 1)); }
.device .face {
  inset:0;
  /* Light from the top left runs around the band: bright there, darkest at the bottom right. */
  background:
    linear-gradient(90deg, rgba(255,255,255,0) 0, rgba(255,255,255,.22) calc(var(--u) * 1.2px), rgba(255,255,255,0) calc(var(--u) * 3px), rgba(255,255,255,0) calc(100% - var(--u) * 3px), rgba(255,255,255,.12) calc(100% - var(--u) * 1.2px), rgba(255,255,255,0) 100%),
    conic-gradient(from 315deg at 50% 50%, rgba(255,255,255,.3), rgba(255,255,255,.06) 60deg, rgba(0,0,0,.18) 170deg, rgba(255,255,255,.1) 235deg, rgba(0,0,0,.05) 290deg, rgba(255,255,255,.3)),
    var(--c);
  box-shadow:
    inset 0 0 0 calc(var(--u) * .7px) color-mix(in oklab, var(--c), black 42%),
    inset 0 0 calc(var(--u) * 1.4px) calc(var(--u) * 1.8px) color-mix(in oklab, var(--c), white 38%),
    inset 0 0 calc(var(--u) * 1px) calc(var(--u) * 3.6px) color-mix(in oklab, var(--c), black 8%);
}
.device.flat .face { box-shadow:none; }
.device.finish-titanium .face {
  box-shadow:
    inset 0 0 0 calc(var(--u) * .7px) color-mix(in oklab, var(--c), black 38%),
    inset 0 0 calc(var(--u) * 1.6px) calc(var(--u) * 1.6px) color-mix(in oklab, var(--c), white 26%),
    inset 0 0 calc(var(--u) * 1px) calc(var(--u) * 3.6px) color-mix(in oklab, var(--c), black 6%);
}
.device.finish-polished .face {
  background:
    linear-gradient(135deg, rgba(255,255,255,.45), rgba(255,255,255,0) 22%, rgba(0,0,0,0) 55%, rgba(0,0,0,.28)),
    var(--c);
  box-shadow:
    inset 0 0 0 calc(var(--u) * .7px) color-mix(in oklab, var(--c), black 50%),
    inset 0 0 calc(var(--u) * 1px) calc(var(--u) * 1.8px) color-mix(in oklab, var(--c), white 60%),
    inset 0 0 calc(var(--u) * 1px) calc(var(--u) * 3.8px) color-mix(in oklab, var(--c), black 12%);
}
.device.fam-mac .face.lid { inset:auto; }
.device .key { inset:0; background:linear-gradient(135deg, rgba(255,255,255,.55) 0%, rgba(255,255,255,0) 35%); mix-blend-mode:soft-light; }
.device .glass {
  background:#030304;
  box-shadow:
    0 0 0 calc(var(--u) * .6px) color-mix(in oklab, var(--c), black 60%),
    inset 0 0 0 calc(var(--u) * .5px) rgba(255,255,255,.07);
}
.device .screen { overflow:hidden; background:#000; }
.device.flat .screen { background:transparent; }
.device .screen img { display:block; max-width:none; }
.device .island, .device .notch { position:absolute; background:#000; z-index:2; }
.device .notch::before, .device .notch::after {
  content:""; position:absolute; top:0; width:var(--ear); height:var(--ear);
}
.device .notch::before { left:calc(var(--ear) * -1); background:radial-gradient(circle at 0 100%, transparent calc(var(--ear) - .5px), #000 var(--ear)); }
.device .notch::after { right:calc(var(--ear) * -1); background:radial-gradient(circle at 100% 100%, transparent calc(var(--ear) - .5px), #000 var(--ear)); }
.device .camera { position:absolute; border-radius:50%; background:radial-gradient(circle at 35% 35%, #2a3140, #0a0b0f 60%); box-shadow:0 0 0 calc(var(--u) * .8px) #16171b; }
.device .glare {
  inset:0; pointer-events:none;
  background:linear-gradient(115deg, rgba(255,255,255,.13) 0%, rgba(255,255,255,.05) 38%, rgba(255,255,255,0) 38.2%);
}
.device .btn {
  position:absolute;
  background:
    linear-gradient(var(--btn-dir, 90deg), color-mix(in oklab, var(--c), black 38%), color-mix(in oklab, var(--c), white 30%) 42%, var(--c) 68%, color-mix(in oklab, var(--c), black 32%));
}
/* Layers toward the front and back of a 3D button sit in the band's shadow. */
.device .btn::after { content:""; position:absolute; inset:0; border-radius:inherit; background:rgba(0,0,0,var(--shade, 0)); }
.device .btn.cc {
  background: linear-gradient(var(--btn-dir, 90deg), #08090b, #3d414c 40%, #1e2026 68%, #0a0a0c);
  box-shadow: inset 0 0 0 calc(var(--u) * .45px) color-mix(in oklab, var(--c), black 15%);
}
/* A 3D button's outward face: lit across its width like the band's rounded profile. */
.device .btn-face {
  position:absolute;
  background: linear-gradient(90deg, color-mix(in oklab, var(--c), black 30%), color-mix(in oklab, var(--c), white 18%) 30%, var(--c) 62%, color-mix(in oklab, var(--c), black 28%));
  box-shadow: inset 0 calc(var(--u) * .5px) 0 color-mix(in oklab, var(--c), white 30%), inset 0 calc(var(--u) * -.5px) 0 color-mix(in oklab, var(--c), black 35%);
}
.device .btn-face.cc { background: linear-gradient(90deg, #0b0c0e, #454a56 35%, #22252c 65%, #0b0b0d); box-shadow: 0 0 0 calc(var(--u) * .5px) color-mix(in oklab, var(--c), black 10%); }
.device .bezel-art { position:absolute; pointer-events:none; }
.device.bezel .glare { position:absolute; }
.device .antenna { position:absolute; background:color-mix(in oklab, var(--c), black 38%); opacity:.55; }
.device.back .face { box-shadow: inset 0 0 0 calc(var(--u) * .6px) color-mix(in oklab, var(--c), black 35%); }
.device .btn.side-top, .device .btn.side-bottom { --btn-dir: 180deg; }
.device .btn.side-right { --btn-dir: 270deg; }
.device .btn.crown {
  background:
    repeating-linear-gradient(0deg, rgba(0,0,0,.28) 0 calc(var(--u) * 1.1px), rgba(255,255,255,.18) calc(var(--u) * 1.1px) calc(var(--u) * 2.2px)),
    linear-gradient(270deg, color-mix(in oklab, var(--c), black 40%), color-mix(in oklab, var(--c), white 30%) 50%, color-mix(in oklab, var(--c), black 25%));
}
.device .watch-case { position:absolute; transform-style:preserve-3d; }
/* A sport band seen from the front: a soft matte roll across its width. */
.device .band {
  position:absolute;
  background:
    linear-gradient(90deg, rgba(0,0,0,.24), rgba(255,255,255,.07) 14%, rgba(255,255,255,.1) 40%, rgba(255,255,255,0) 62%, rgba(0,0,0,.05) 84%, rgba(0,0,0,.28)),
    var(--band);
}
.device .wp { position:absolute; }
/* The crown: its neck in shadow next to the case, knurling across the cylinder, a bright chamfer at the cap. */
.device .wp.crown {
  background:
    linear-gradient(90deg, rgba(0,0,0,.5) 0 22%, rgba(0,0,0,0) 30%, rgba(0,0,0,0) 84%, rgba(255,255,255,.4) 87%, rgba(0,0,0,.18) 93%, rgba(0,0,0,.35) 100%),
    repeating-linear-gradient(180deg, rgba(0,0,0,.3) 0 calc(var(--u) * .8px), rgba(255,255,255,.14) calc(var(--u) * .8px) calc(var(--u) * 1.6px)),
    linear-gradient(180deg, color-mix(in oklab, var(--c), white 50%), var(--c) 32%, color-mix(in oklab, var(--c), black 28%) 72%, color-mix(in oklab, var(--c), black 55%));
}
.device .wp.crown.ultra {
  background:
    linear-gradient(90deg, rgba(0,0,0,.45) 0 26%, rgba(0,0,0,0) 32%, rgba(0,0,0,0) 76%, #ff6a2b 76% 84%, rgba(255,255,255,.35) 86%, rgba(0,0,0,.3) 100%),
    repeating-linear-gradient(180deg, rgba(0,0,0,.34) 0 calc(var(--u) * 1.4px), rgba(255,255,255,.14) calc(var(--u) * 1.4px) calc(var(--u) * 2.8px)),
    linear-gradient(180deg, color-mix(in oklab, var(--c), white 45%), var(--c) 32%, color-mix(in oklab, var(--c), black 30%) 72%, color-mix(in oklab, var(--c), black 55%));
}
.device .wp.button {
  background: linear-gradient(180deg, color-mix(in oklab, var(--c), white 40%), var(--c) 38%, color-mix(in oklab, var(--c), black 38%));
  box-shadow: inset calc(var(--u) * -.6px) 0 0 color-mix(in oklab, var(--c), black 30%);
}
.device .wp.guard {
  background: linear-gradient(90deg, color-mix(in oklab, var(--c), black 25%), color-mix(in oklab, var(--c), white 30%) 50%, var(--c) 72%, color-mix(in oklab, var(--c), black 40%));
}
.device .wp.action { background: linear-gradient(180deg, #ff9d66, #ff5f1f 42%, #b93a0a); }
/* The watch's glass runs almost to the edge: a hairline of metal, then a softly lit curved rim. */
.device.fam-watch .face { box-shadow: inset 0 0 0 calc(var(--u) * .6px) color-mix(in oklab, var(--c), white 35%); }
.device.fam-watch .glass {
  background:#020203;
  box-shadow:
    0 0 0 calc(var(--u) * .5px) color-mix(in oklab, var(--c), black 55%),
    inset 0 0 0 calc(var(--u) * 1.1px) rgba(255,255,255,.08),
    inset 0 0 calc(var(--u) * 7px) rgba(255,255,255,.05);
}
.device.fam-watch .glass::after { content:""; position:absolute; inset:0; border-radius:inherit; pointer-events:none; background:linear-gradient(135deg, rgba(255,255,255,.07), rgba(255,255,255,0) 32%); }
/* Ultra: a flat sapphire inside a raised titanium rim with a bright inner chamfer. */
.device.watch-ultra .glass {
  box-shadow:
    0 0 0 calc(var(--u) * 1.5px) color-mix(in oklab, var(--c), white 45%),
    0 0 0 calc(var(--u) * 3.2px) color-mix(in oklab, var(--c), black 14%),
    inset 0 0 0 calc(var(--u) * 1px) rgba(255,255,255,.06);
}
.device .mac-base {
  position:absolute;
  background:
    linear-gradient(180deg, color-mix(in oklab, var(--c), white 45%) 0%, var(--c) 18%, color-mix(in oklab, var(--c), black 12%) 60%, color-mix(in oklab, var(--c), black 45%) 100%);
  box-shadow: inset 0 calc(var(--u) * .6px) 0 color-mix(in oklab, var(--c), white 60%);
}
/* The lid's glass bezel catches a soft reflection from the top left. */
.device .glass.mac { background: linear-gradient(160deg, #111114, #030304 30%, #030304 75%, #0a0a0c); }
.device .mac-hinge { position:absolute; top:0; background:linear-gradient(180deg, #050506, color-mix(in oklab, var(--c), black 55%)); border-radius:0 0 calc(var(--u) * 2px) calc(var(--u) * 2px); }
.device .mac-foot { position:absolute; border-radius:50%; background:rgba(0,0,0,.55); filter:blur(calc(var(--u) * .6px)); }
.device .mac-deck, .device .mac-side, .device .mac-bottom { position:absolute; }
/* The deck lies flat, from the hinge toward the viewer; seen from below, the bottom case shows. */
.device .mac-deck {
  transform-origin:50% 0; transform:rotateX(90deg); backface-visibility:hidden;
  background:
    radial-gradient(90% 70% at 30% 20%, rgba(255,255,255,.14), rgba(255,255,255,0) 60%),
    linear-gradient(180deg, color-mix(in oklab, var(--c), black 8%), var(--c) 30%, color-mix(in oklab, var(--c), white 6%));
  box-shadow: inset 0 0 0 calc(var(--u) * .8px) color-mix(in oklab, var(--c), black 20%);
  border-radius:0 0 calc(var(--u) * 10px) calc(var(--u) * 10px);
}
.device .mac-deck > * { position:absolute; }
.device .mac-deck-hinge { left:3%; right:3%; top:0; background:linear-gradient(180deg, #030304, #121214); border-radius:0 0 calc(var(--u) * 3px) calc(var(--u) * 3px); }
.device .mac-keys { background:color-mix(in oklab, var(--c), black 30%); border-radius:calc(var(--u) * 3px); box-shadow: 0 0 0 calc(var(--u) * 1.2px) color-mix(in oklab, var(--c), black 30%); }
.device .mac-keys i {
  position:absolute; border-radius:calc(var(--u) * 1.6px);
  background: linear-gradient(180deg, #202023, #0d0d0f);
  box-shadow: inset 0 calc(var(--u) * .4px) 0 rgba(255,255,255,.08), 0 calc(var(--u) * .4px) calc(var(--u) * .6px) rgba(0,0,0,.4);
}
.device .mac-grille { background: radial-gradient(circle, rgba(0,0,0,.5) 0 34%, rgba(0,0,0,0) 40%) 0 0 / calc(var(--u) * 3.2px) calc(var(--u) * 3.2px); border-radius:calc(var(--u) * 2px); }
.device .mac-trackpad {
  background: linear-gradient(170deg, color-mix(in oklab, var(--c), white 7%), color-mix(in oklab, var(--c), black 4%));
  box-shadow: 0 0 0 calc(var(--u) * .7px) color-mix(in oklab, var(--c), black 22%), inset 0 calc(var(--u) * .6px) 0 rgba(255,255,255,.12);
}
.device .mac-side { background: linear-gradient(180deg, color-mix(in oklab, var(--c), white 20%), color-mix(in oklab, var(--c), black 30%)); }
/* The underside: darker aluminium, four rubber feet, lighter toward the front edge. */
.device .mac-bottom {
  transform-origin:50% 0; transform:rotateX(90deg);
  background:
    radial-gradient(closest-side, rgba(10,10,12,.9), rgba(10,10,12,.9) 70%, rgba(10,10,12,0)) 7% 9% / 7% 9% no-repeat,
    radial-gradient(closest-side, rgba(10,10,12,.9), rgba(10,10,12,.9) 70%, rgba(10,10,12,0)) 93% 9% / 7% 9% no-repeat,
    radial-gradient(closest-side, rgba(10,10,12,.9), rgba(10,10,12,.9) 70%, rgba(10,10,12,0)) 7% 91% / 7% 9% no-repeat,
    radial-gradient(closest-side, rgba(10,10,12,.9), rgba(10,10,12,.9) 70%, rgba(10,10,12,0)) 93% 91% / 7% 9% no-repeat,
    linear-gradient(180deg, color-mix(in oklab, var(--c), black 42%), color-mix(in oklab, var(--c), black 22%));
  border-radius:0 0 calc(var(--u) * 10px) calc(var(--u) * 10px);
  box-shadow: inset 0 0 0 calc(var(--u) * 1px) color-mix(in oklab, var(--c), black 50%);
}
.device .mac-scoop {
  position:absolute;
  background:linear-gradient(180deg, color-mix(in oklab, var(--c), black 38%), color-mix(in oklab, var(--c), black 12%));
}
`;
