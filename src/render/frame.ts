import type { DeviceModel } from "../devices/catalog.js";
import type { ChromeButton } from "../devices/profile.js";
import type { ResolvedHighlight } from "./highlights.js";

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
  menuBar?: boolean;
}

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
  if (m.family === "mac") {
    const lidW = sw + (m.bezel + m.frame) * 2;
    const lidH = sh + m.bezel + (m.chin ?? m.bezel) + m.frame * 2;
    const baseH = lidW * 0.028;
    return { width: lidW * 1.1, height: lidH + baseH, visWidth: lidW * 1.1, visHeight: lidH + baseH, turn: 0 };
  }
  const border = m.bezel + m.frame;
  const W = sw + border * 2;
  const H = sh + border * 2;
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
  if (model.family === "mac") {
    const lidW = sw + (model.bezel + model.frame) * 2;
    const side = (m.width - lidW) / 2 + model.bezel + model.frame;
    const top = model.bezel + model.frame;
    return { x: side / m.width, y: top / m.height, width: sw / m.width, height: sh / m.height, radius: (model.screen.cornerRadius + 12) / m.width };
  }
  const border = model.bezel + model.frame;
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

  for (const h of o.highlights) {
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
    if (h.style === "loupe" && h.loupe) {
      const d = h.loupe.d * s;
      const m = h.scale;
      const cx = X(h.loupe.cx);
      const cy = Y(h.loupe.cy);
      overlay +=
        `<div class="hlx" style="position:absolute;left:${f(cx - d / 2)};top:${f(cy - d / 2)};width:${f(d)};height:${f(d)};border-radius:50%;overflow:hidden;transform:scale(calc(0.85 + 0.15 * var(--hl, 1)));` +
        `background-color:#fff;background-image:url(&quot;${url}&quot;);background-size:${f(iw * m)} ${f(ih * m)};` +
        `background-position:${f(d / 2 - h.loupe.cx * s * m)} ${f(d / 2 - h.loupe.cy * s * m)};` +
        `box-shadow:0 0 0 ${f(3 * u)} ${esc(h.color)}, 0 ${f(10 * u)} ${f(30 * u)} rgba(0,0,0,.28), 0 ${f(2 * u)} ${f(6 * u)} rgba(0,0,0,.16)">` +
        `<div style="position:absolute;inset:0;border-radius:50%;background:radial-gradient(circle at 30% 25%, rgba(255,255,255,.35), rgba(255,255,255,0) 45%);box-shadow:inset 0 0 ${f(10 * u)} rgba(0,0,0,.18)"></div></div>`;
    }
  }
  return { clipped: wrap(clipped, false), overlay: overlay ? wrap(overlay, false) : "" };
}

// ---------------------------------------------------------------------------------------------
// Hardware

function protrusion(model: DeviceModel, b: ChromeButton): number {
  if (b.name.includes("crown")) return b.depth * 0.55;
  if (model.family === "watch") return 3;
  if (model.family === "ipad") return 1.8;
  return 2.3;
}

function buttonsHtml(model: DeviceModel, u: number, border: number, W: number, zShift: string): string {
  const out: string[] = [];
  for (const b of model.buttons) {
    const p = protrusion(model, b) * u;
    const tuck = 3 * u;
    const len = b.length * u;
    const crown = b.name.includes("crown");
    let style: string;
    if (b.side === "left" || b.side === "right") {
      const top = (border + b.offset) * u;
      style = `${b.side === "left" ? `left:${f(-p)}` : `right:${f(-p)}`};top:${f(top)};width:${f(p + tuck)};height:${f(len)}`;
    } else {
      const edge = (border + b.offset) * u;
      const left = b.align === "trailing" ? W - edge - len : edge;
      style = `${b.side === "top" ? `top:${f(-p)}` : `bottom:${f(-p)}`};left:${f(left)};height:${f(p + tuck)};width:${f(len)}`;
    }
    out.push(`<div class="btn${crown ? " crown" : ""} side-${b.side}" style="${style};border-radius:${f(Math.min(p, 6 * u))};${zShift}"></div>`);
  }
  return out.join("");
}

/**
 * The device's thickness in 3D: copies of its outline stacked behind the face. Each copy is a
 * full-size composited layer, so keep the count modest; at the tilts people use, ~1.5px spacing
 * reads as a solid edge.
 */
function slabs(radius: string, T: number, color: string): string {
  const n = Math.max(6, Math.min(24, Math.ceil(T / 1.5)));
  let out = "";
  for (let i = 1; i <= n; i++) {
    const t = i / n;
    const shade = Math.round(18 + 30 * Math.abs(t - 0.45) * 2);
    out += `<div class="slab" style="border-radius:${radius};transform:translateZ(${f(-T * t)});background:color-mix(in oklab, ${color}, black ${shade}%)"></div>`;
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

  let cutout = "";
  const drawIsland = o.island === "always" || (o.island === "auto" && !o.facts.hasIsland);
  if (model.cutout === "island" && drawIsland) {
    const iw = ISLAND.width * u;
    const ih = ISLAND.height * u;
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

  let band = "";
  if (model.family === "watch" && o.band !== null) {
    const bw = W * 0.74;
    const bl = H * 0.9;
    const bc = esc(o.band ?? "#2c2c2e");
    band =
      `<div class="band" style="--band:${bc};width:${f(bw)};height:${f(bl)};left:${f((W - bw) / 2)};top:${f(-bl + H * 0.2)};border-radius:${f(bw * 0.18)} ${f(bw * 0.18)} ${f(bw * 0.08)} ${f(bw * 0.08)};${zShift}"></div>` +
      `<div class="band" style="--band:${bc};width:${f(bw)};height:${f(bl)};left:${f((W - bw) / 2)};top:${f(H * 0.8)};border-radius:${f(bw * 0.08)} ${f(bw * 0.08)} ${f(bw * 0.18)} ${f(bw * 0.18)};${zShift}"></div>`;
  }

  const c = content(o, sw * u, sh * u, turn, u);
  const inset = model.bezel * u;
  const html =
    `<div class="device ${depth ? "d3" : ""} fam-${model.family} finish-${model.finish}${o.studio ? " studio" : ""}" style="--c:${esc(o.color)};--u:${u};width:${f(W)};height:${f(H)}">` +
    band +
    (depth ? slabs(f(outerR), T, "var(--c)") : "") +
    (o.buttons ? buttonsHtml(model, u, border, W, zShift) : "") +
    `<div class="face" style="border-radius:${f(outerR)}">` +
    (o.studio ? `<div class="key" style="border-radius:${f(outerR)}"></div>` : "") +
    `<div class="glass" style="inset:${f(model.frame * u)};border-radius:${f(glassR)}">` +
    camera +
    `<div class="screen" style="inset:${f(inset)};border-radius:${f(r * u)}">${c.clipped}${cutout}</div>` +
    (c.overlay ? `<div class="hl" style="inset:${f(inset)}">${c.overlay}</div>` : "") +
    (o.glare ? `<div class="glare" style="border-radius:${f(glassR)}"></div>` : "") +
    `</div></div></div>`;
  return { html, width: W, height: H, turn };
}

function laptop(o: FrameOptions, u: number): FrameOutput {
  const m = o.model!;
  const sw = m.screen.width / m.screen.scale;
  const sh = m.screen.height / m.screen.scale;
  const chin = m.chin ?? m.bezel;
  const lidW = (sw + (m.bezel + m.frame) * 2) * u;
  const lidH = (sh + m.bezel + chin + m.frame * 2) * u;
  const baseW = lidW * 1.1;
  const baseH = lidW * 0.028;
  const W = baseW;
  const H = lidH + baseH;
  const lidX = (W - lidW) / 2;
  const r = m.screen.cornerRadius * u;
  const bar = o.menuBar && o.island !== "never" ? MAC_MENU_BAR * u : 0;
  const c = content(o, sw * u, sh * u - bar, 0, u, bar > 0);
  const shot = bar
    ? `<div style="position:absolute;left:0;right:0;top:0;height:${f(bar)};background:#000"></div><div style="position:absolute;left:0;right:0;top:${f(bar)};bottom:0;overflow:hidden">${c.clipped}</div>`
    : c.clipped;
  const notch =
    o.island === "never"
      ? ""
      : `<div class="notch mac" style="top:0;left:50%;width:${f(MAC_NOTCH.width * u)};height:${f(MAC_NOTCH.height * u)};transform:translateX(-50%);border-radius:0 0 ${f(MAC_NOTCH.radius * u)} ${f(MAC_NOTCH.radius * u)};--ear:${f(4 * u)}"><div style="position:absolute;left:50%;top:50%;width:${f(5 * u)};height:${f(5 * u)};margin:${f(-2.5 * u)};border-radius:50%;background:#15181f;box-shadow:inset 0 0 0 ${f(1 * u)} #1f2430"></div></div>`;
  const html =
    `<div class="device fam-mac finish-${m.finish}${o.studio ? " studio" : ""}" style="--c:${esc(o.color)};--u:${u};width:${f(W)};height:${f(H)}">` +
    `<div class="face lid" style="left:${f(lidX)};top:0;width:${f(lidW)};height:${f(lidH)};border-radius:${f(r + 12 * u)} ${f(r + 12 * u)} ${f(8 * u)} ${f(8 * u)}">` +
    (o.studio ? `<div class="key" style="border-radius:inherit"></div>` : "") +
    `<div class="glass" style="inset:${f(m.frame * u)};border-radius:${f(r + 9 * u)} ${f(r + 9 * u)} ${f(5 * u)} ${f(5 * u)}">` +
    `<div class="screen" style="left:${f(m.bezel * u)};top:${f(m.bezel * u)};width:${f(sw * u)};height:${f(sh * u)};border-radius:${f(r)} ${f(r)} 0 0">${shot}${notch}</div>` +
    (c.overlay ? `<div class="hl" style="left:${f(m.bezel * u)};top:${f(m.bezel * u + bar)};width:${f(sw * u)};height:${f(sh * u - bar)}">${c.overlay}</div>` : "") +
    (o.glare ? `<div class="glare" style="border-radius:inherit"></div>` : "") +
    `</div></div>` +
    `<div class="mac-base" style="left:0;top:${f(lidH - 1)};width:${f(baseW)};height:${f(baseH)};border-radius:${f(1.5 * u)} ${f(1.5 * u)} ${f(baseH * 0.9)} ${f(baseH * 0.9)} / ${f(1.5 * u)} ${f(1.5 * u)} ${f(baseH)} ${f(baseH)}">` +
    `<div class="mac-scoop" style="left:50%;top:0;width:${f(lidW * 0.14)};height:${f(baseH * 0.42)};margin-left:${f(-lidW * 0.07)};border-radius:0 0 ${f(baseH * 0.5)} ${f(baseH * 0.5)}"></div></div>` +
    `</div>`;
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
  const R = o.radius ?? (o.kind === "none" ? 0 : o.kind === "card" ? Math.min(W, H) * 0.035 : 12 * u);
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

/** Render a frame at `u` rendered pixels per point. */
export function renderFrame(o: FrameOptions, u: number, depth: boolean): FrameOutput {
  if (o.kind !== "device") return flat(o, u, depth);
  if (o.model!.family === "mac") return laptop(o, u);
  return phoneLike(o, u, depth);
}

/** Shared CSS for every device on the page. */
export const FRAME_CSS = `
.device { position:absolute; left:0; top:0; }
.device.d3 { transform-style:preserve-3d; }
.device .face, .device .glass, .device .screen, .device .slab, .device .glare, .device .hl, .device .key, .device .bar { position:absolute; }
.device .slab { inset:0; }
.device .bar { left:0; right:0; top:0; }
.device .hl { pointer-events:none; }
.hlx { opacity:calc(var(--o, 1) * var(--hl, 1)); }
.device .face {
  inset:0;
  background:
    linear-gradient(135deg, rgba(255,255,255,.22), rgba(255,255,255,0) 28%, rgba(0,0,0,0) 62%, rgba(0,0,0,.18)),
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
    linear-gradient(var(--btn-dir, 90deg), color-mix(in oklab, var(--c), black 35%), color-mix(in oklab, var(--c), white 25%) 45%, var(--c) 70%, color-mix(in oklab, var(--c), black 30%));
}
.device .btn.side-top, .device .btn.side-bottom { --btn-dir: 180deg; }
.device .btn.side-right { --btn-dir: 270deg; }
.device .btn.crown {
  background:
    repeating-linear-gradient(0deg, rgba(0,0,0,.28) 0 calc(var(--u) * 1.1px), rgba(255,255,255,.18) calc(var(--u) * 1.1px) calc(var(--u) * 2.2px)),
    linear-gradient(270deg, color-mix(in oklab, var(--c), black 40%), color-mix(in oklab, var(--c), white 30%) 50%, color-mix(in oklab, var(--c), black 25%));
}
.device .band {
  position:absolute;
  background:
    linear-gradient(90deg, rgba(0,0,0,.35), rgba(255,255,255,.08) 20%, rgba(255,255,255,0) 50%, rgba(255,255,255,.06) 80%, rgba(0,0,0,.35)),
    var(--band);
}
.device .mac-base {
  position:absolute;
  background:
    linear-gradient(180deg, color-mix(in oklab, var(--c), white 45%) 0%, var(--c) 18%, color-mix(in oklab, var(--c), black 12%) 60%, color-mix(in oklab, var(--c), black 45%) 100%);
  box-shadow: inset 0 calc(var(--u) * .6px) 0 color-mix(in oklab, var(--c), white 60%);
}
.device .mac-scoop {
  position:absolute;
  background:linear-gradient(180deg, color-mix(in oklab, var(--c), black 38%), color-mix(in oklab, var(--c), black 12%));
}
`;
