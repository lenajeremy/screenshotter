import { existsSync, writeFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { Family } from "../devices/catalog.js";
import { readSidecar, resolveColor, resolveDevice, type ResolvedDevice } from "../devices/resolve.js";
import { formatFor, outputPathFor, resolveUserPath } from "../util/files.js";
import { imageSize } from "../util/image.js";
import { analyzeScreenshot, averageColor } from "./analyze.js";
import { edgeBlurHtml, esc, gradeFor, grainHtml, px, quickTone, resolveBackground, vignetteHtml } from "./background.js";
import { newPage } from "./browser.js";
import { FRAME_CSS, MAC_MENU_BAR, measureFrame, renderFrame, screenRect, type FrameKind, type FrameOptions } from "./frame.js";
import { resolveHighlights } from "./highlights.js";
import { CANVAS_PRESETS, computeLayout, defaultCanvasFor, type DeviceSlot, type LayoutResult } from "./layouts.js";
import type { DeviceInput, EffectsInput, MockupInput, ShadowInput, TextInput } from "./schema.js";

export interface MockupResult {
  path: string;
  width: number;
  height: number;
  layout: string;
  background?: string;
  devices: Array<{ screenshot: string; frame: FrameKind; device?: string; color?: string; source?: ResolvedDevice["source"] }>;
  credits: string[];
  /** Where every element ended up, as canvas fractions; set these values to move things. */
  entities: SceneEntity[];
  warnings: string[];
}

const fileUrl = (p: string) => (/^https?:\/\//.test(p) ? p : pathToFileURL(resolveUserPath(p)).href);

// ---------------------------------------------------------------------------------------------
// Text

const FONT_SHORTCUTS: Record<string, string> = {
  "sf-pro": `-apple-system, "SF Pro Display", "SF Pro", system-ui, "Helvetica Neue", sans-serif`,
  system: `-apple-system, "SF Pro Display", "SF Pro", system-ui, "Helvetica Neue", sans-serif`,
  "sf-rounded": `ui-rounded, "SF Pro Rounded", -apple-system, system-ui, sans-serif`,
  "new-york": `ui-serif, "New York", Georgia, serif`,
  "sf-mono": `ui-monospace, "SF Mono", Menlo, monospace`,
};

function fontStack(font: string | undefined): { stack: string; family?: string } {
  if (!font) return { stack: FONT_SHORTCUTS["sf-pro"] };
  const shortcut = FONT_SHORTCUTS[font.toLowerCase()];
  if (shortcut) return { stack: shortcut };
  return { stack: `"${font.replace(/"/g, "")}", -apple-system, system-ui, sans-serif`, family: font };
}

/** Escape text and turn **accent** spans and newlines into markup. */
function richText(text: string, accent: string | undefined): string {
  // A trailing newline (Enter at the end of a text box) would add an empty line.
  return text
    .replace(/(\\n|\n|\s)+$/, "")
    .split(/\*\*(.+?)\*\*/g)
    .map((part, i) => {
      const safe = esc(part).replace(/\\n|\n/g, "<br>");
      if (i % 2 === 0) return safe;
      if (!accent) return `<strong>${safe}</strong>`;
      const style = /gradient\(/.test(accent)
        ? `background:${esc(accent)};-webkit-background-clip:text;background-clip:text;color:transparent`
        : `color:${esc(accent)}`;
      return `<span class="accent" style="${style}">${safe}</span>`;
    })
    .join("");
}

const sizePx = (size: number | undefined, H: number, fallback: number) => (size === undefined ? fallback : size < 1 ? size * H : size);

/** A text element: absolutely positioned on the canvas, or `flow` inside a stacked text block. */
function textHtml(t: TextInput, W: number, H: number, flow = false): string {
  const align = t.align ?? "center";
  const anchor = t.anchor ?? "top";
  const tx = align === "left" ? "0" : align === "right" ? "-100%" : "-50%";
  const ty = anchor === "top" ? "0" : anchor === "bottom" ? "-100%" : "-50%";
  const size = sizePx(t.size, H, W * 0.05);
  const shadow =
    t.shadow === true ? `text-shadow:0 ${px(size * 0.04)} ${px(size * 0.3)} rgba(0,0,0,.35);` : t.shadow ? `text-shadow:${esc(t.shadow)};` : "";
  const badge = t.background ? `background:${esc(t.background)};padding:${px(size * 0.35)} ${px(size * 0.8)};border-radius:${px(size * 2)};` : "";
  const box = flow
    ? `position:relative;width:100%;text-align:${align};`
    : `position:absolute;left:${px((t.x ?? 0.5) * W)};top:${px((t.y ?? 0.1) * H)};width:${px((t.width ?? 0.86) * W)};transform:translate(${tx},${ty}) rotate(${t.rotate ?? 0}deg);text-align:${align};z-index:${t.z ?? 30};`;
  const justify = align === "left" ? "flex-start" : align === "right" ? "flex-end" : "center";
  const style =
    `display:inline-block;font-family:${esc(fontStack(t.font).stack)};font-size:${px(size)};font-weight:${t.weight ?? 700};` +
    `color:${esc(t.color ?? "#fff")};line-height:${t.lineHeight ?? 1.08};letter-spacing:${t.letterSpacing ?? -0.02}em;` +
    `opacity:${t.opacity ?? 1};${t.uppercase ? "text-transform:uppercase;" : ""}${shadow}${badge}`;
  return `<div class="text" style="${box}display:flex;justify-content:${justify}"><div style="${style}">${richText(t.text, t.accentColor)}</div></div>`;
}

// ---------------------------------------------------------------------------------------------
// Shadows

function shadowFilter(shadow: ShadowInput | undefined, h: number, bgColor: string | undefined): { filter: string; studio: boolean } {
  const s = shadow ?? "medium";
  if (s === "none") return { filter: "", studio: false };
  const tint = bgColor ? `color-mix(in oklab, ${bgColor} 35%, #000)` : "#000";
  const layer = (x: number, y: number, blur: number, a: number, color = tint) =>
    `drop-shadow(${px(h * x)} ${px(h * y)} ${px(h * blur)} color-mix(in oklab, ${color} ${Math.round(a * 100)}%, transparent))`;
  if (typeof s === "object") {
    const color = !s.color || s.color === "auto" ? tint : s.color;
    const a = s.opacity ?? 0.3;
    const studio = s.style === "studio";
    const layers = [layer(0, (s.offsetY ?? 0.02) * 0.2, (s.blur ?? 0.05) * 0.16, Math.min(1, a * 0.8), color), layer(studio ? 0.02 : 0, s.offsetY ?? 0.02, s.blur ?? 0.05, a, color)];
    if (studio) layers.push(layer(0.035, 0.05, 0.09, a * 0.7, color));
    return { filter: layers.join(" "), studio };
  }
  const presets: Record<string, Array<[number, number, number, number]>> = {
    soft: [[0, 0.012, 0.03, 0.2]],
    medium: [
      [0, 0.004, 0.008, 0.22],
      [0, 0.025, 0.045, 0.3],
    ],
    strong: [
      [0, 0.008, 0.012, 0.32],
      [0, 0.045, 0.075, 0.45],
    ],
    studio: [
      [0, 0.004, 0.008, 0.24],
      [0.015, 0.025, 0.045, 0.28],
      [0.04, 0.06, 0.1, 0.26],
    ],
  };
  return { filter: presets[s].map(([x, y, b, a]) => layer(x, y, b, a)).join(" "), studio: s === "studio" };
}

// ---------------------------------------------------------------------------------------------
// Devices

interface Prepared {
  input: DeviceInput;
  file: string;
  size: { width: number; height: number };
  kind: FrameKind;
  family: Family | "flat";
  resolved?: ResolvedDevice;
  color?: { name: string; hex: string };
  options: FrameOptions;
}

/** Resolve one device input. `light` skips pixel analysis and OCR (layout-only requests). */
async function prepare(input: DeviceInput, light = false): Promise<Prepared> {
  const file = resolveUserPath(input.screenshot);
  if (!existsSync(file)) throw new Error(`Screenshot not found: ${file}`);
  const size = await imageSize(file);
  const sidecar = readSidecar(file);
  // Pick a frame that suits where the capture came from.
  const kind: FrameKind =
    input.frame ??
    (sidecar?.kind === "mac" && sidecar.app ? "none" : sidecar?.kind === "web" && !sidecar.deviceName ? "browser" : "device");

  let resolved: ResolvedDevice | undefined;
  let color: { name: string; hex: string } | undefined;
  let scale = sidecar?.scale ?? 2;
  if (kind === "device") {
    resolved = await resolveDevice(input.device, { path: file, ...size });
    color = resolveColor(resolved.model, input.color);
    scale = (resolved.model.screen.scale * Math.min(size.width, size.height)) / Math.min(resolved.model.screen.width, resolved.model.screen.height);
  } else if (sidecar?.deviceTypeIdentifier) {
    // A simulator capture shown without hardware: size chrome and highlights in its own points.
    const r = await resolveDevice(undefined, { path: file, ...size }).catch(() => undefined);
    if (r) scale = r.model.screen.scale;
  }

  const facts = resolved && !light ? await analyzeScreenshot(file, resolved.model, size) : { hasIsland: false, topSide: "left" as const };
  const highlights = !light && input.highlights?.length ? await resolveHighlights(file, size, scale, input.highlights) : [];
  const options: FrameOptions = {
    kind,
    model: resolved?.model,
    color: color?.hex ?? "#1f1f21",
    image: { url: fileUrl(file), width: size.width, height: size.height, crop: input.crop, scale, video: input.video ? fileUrl(input.video) : undefined },
    facts,
    island: input.island ?? "auto",
    buttons: input.buttons ?? true,
    glare: input.glare ?? false,
    studio: false,
    landscape: input.landscape,
    band: input.bandColor === "none" ? null : input.bandColor,
    highlights,
    url: input.url ?? (sidecar?.url ? sidecar.url.replace(/^https?:\/\//, "").replace(/\/$/, "") : undefined),
    title: input.title,
    chrome: input.chrome ?? "light",
    radius: input.radius,
    // A full-screen Mac capture brings its own menu bar; anything else sits below the notch.
    menuBar: !(sidecar?.kind === "mac" && !sidecar.app),
  };
  const family: Family | "flat" = kind === "device" ? resolved!.model.family : "flat";
  return { input, file, size, kind, family, resolved, color, options };
}

interface Placed {
  html: string;
  /** Axis-aligned box on the canvas (ignoring rotation), used for edge blur. */
  top: number;
  bottom: number;
}

/** Options for scenes that will be animated frame by frame (create_video). */
export interface SceneAnimation {
  /** Devices will tilt in 3D during the animation, so give them depth and perspective. */
  motion3d: boolean;
}

/** Where a device ends up on the canvas, in canvas px (centre, visual size) plus its rotation. */
interface Placement {
  unit: number;
  cx: number;
  cy: number;
  visW: number;
  visH: number;
  rotate: number;
  rotateX: number;
  rotateY: number;
  z: number;
}

function placement(d: Prepared, slot: DeviceSlot, W: number, H: number): Placement {
  const i = d.input;
  const m = measureFrame(d.options);
  let unit: number;
  const height = i.height ?? (i.width === undefined ? slot.height : undefined);
  const width = i.width ?? (i.height === undefined ? slot.width : undefined);
  if (height !== undefined) unit = (height * H) / m.visHeight;
  else if (width !== undefined) unit = (width * W) / m.visWidth;
  else unit = Math.min((slot.boxH * H) / m.visHeight, (slot.boxW * W) / m.visWidth);
  const visW = m.visWidth * unit;
  const visH = m.visHeight * unit;
  // An explicit y is the device's centre unless an anchor says otherwise; layout slots may
  // anchor by the top (e.g. hero-bleed) when the position comes from the layout.
  const anchor = i.anchor ?? (i.y !== undefined ? "center" : slot.anchor);
  const cx = (i.x ?? slot.x) * W;
  const y = (i.y ?? slot.y) * H;
  const cy = anchor === "top" ? y + visH / 2 : anchor === "bottom" ? y - visH / 2 : y;
  return {
    unit,
    cx,
    cy,
    visW,
    visH,
    rotate: i.rotate ?? slot.rotate,
    rotateX: i.rotateX ?? slot.rotateX,
    rotateY: i.rotateY ?? slot.rotateY,
    z: i.z ?? slot.z,
  };
}

function place(d: Prepared, p: Placement, bgColor: string | undefined, anim?: SceneAnimation): Placed {
  const { unit, cx, cy, visH, rotate, rotateX, rotateY } = p;
  const is3d = Math.abs(rotateX) > 0.01 || Math.abs(rotateY) > 0.01 || Boolean(anim?.motion3d);
  const shadow = shadowFilter(d.input.shadow, visH, bgColor);
  const frame = renderFrame({ ...d.options, studio: shadow.studio }, unit, is3d && d.kind !== "none");
  const perspective = d.input.perspective ?? Math.max(frame.width, frame.height) * 2.6;
  // Animated scenes add per-frame offsets through CSS variables set on .dev-wrap.
  const transform = anim
    ? `rotateZ(calc(${rotate}deg + var(--dr, 0deg))) rotateX(calc(${rotateX}deg + var(--drx, 0deg))) rotateY(calc(${rotateY}deg + var(--dry, 0deg))) rotateZ(${frame.turn}deg)`
    : `rotateZ(${rotate}deg) rotateX(${rotateX}deg) rotateY(${rotateY}deg) rotateZ(${frame.turn}deg)`;
  const html =
    `<div class="dev-wrap" style="left:${px(cx)};top:${px(cy)};z-index:${p.z};${anim ? "translate:var(--dx, 0px) var(--dy, 0px);" : ""}${shadow.filter ? `filter:${shadow.filter};` : ""}">` +
    `<div class="dev-stage" style="width:${px(frame.width)};height:${px(frame.height)};left:${px(-frame.width / 2)};top:${px(-frame.height / 2)};${is3d ? `perspective:${px(perspective)};` : ""}">` +
    `<div class="dev-rot" style="width:${px(frame.width)};height:${px(frame.height)};transform:${transform};${is3d ? "transform-style:preserve-3d;" : ""}">` +
    frame.html +
    `</div></div></div>`;
  return { html, top: cy - visH / 2, bottom: cy + visH / 2 };
}

// ---------------------------------------------------------------------------------------------
// Scene plan: every element resolved to a position, without rendering anything

/** One element of the scene as positioned on the canvas. All positions are canvas fractions. */
export interface SceneEntity {
  id: string;
  kind: "device" | "caption" | "text";
  /** Index into `devices` or `texts`. */
  index?: number;
  /** Devices: centre. Captions and texts: the anchor point (see align and anchor). */
  x: number;
  y: number;
  /** Devices: visual size. Captions and texts: box width (height depends on the text). */
  width: number;
  height?: number;
  rotate: number;
  rotateX?: number;
  rotateY?: number;
  z: number;
  anchor?: "top" | "middle" | "bottom";
  align?: "left" | "center" | "right";
  screenshot?: string;
  frame?: FrameKind;
  device?: string;
  color?: string;
  /** Screen area inside the device box, and the box's corner radius, as fractions of the box. */
  screen?: { x: number; y: number; width: number; height: number; radius: number };
  /** Laptops: the black menu-bar strip under the notch, as a fraction of the screen's height. */
  menuBar?: number;
  text?: string;
  subtext?: string;
  /** Font sizes as fractions of canvas height. */
  size?: number;
  subSize?: number;
  weight?: number;
  font?: string;
}

interface CaptionPlan {
  x: number;
  y: number;
  anchor: "top" | "middle" | "bottom";
  width: number;
  align: "left" | "center" | "right";
  headSize: number;
  subSize: number;
}

interface ScenePlan {
  prepared: Prepared[];
  warnings: string[];
  canvas: { width: number; height: number; name: string };
  layout: LayoutResult;
  placements: Placement[];
  caption?: CaptionPlan;
  headSize: number;
}

async function planScene(input: MockupInput, light = false): Promise<ScenePlan> {
  const warnings: string[] = [];
  const prepared = await Promise.all(input.devices.map((d) => prepare(d, light)));
  for (const d of prepared) {
    if (d.resolved?.source === "generic") {
      warnings.push(`${path.basename(d.file)}: couldn't identify the device from a ${d.size.width}×${d.size.height} image; drew a ${d.resolved.model.name}. Pass "device" to choose one.`);
    }
  }
  // Desktop windows or laptops alongside phones read best on a wide canvas.
  const mixedDesktop = prepared.length > 1 && prepared.some((d) => d.family === "mac" || d.family === "flat") && prepared.some((d) => d.family !== "mac" && d.family !== "flat");
  const canvas = resolveCanvas(input.canvas, input.landscape, mixedDesktop ? "16:9" : defaultCanvasFor(prepared[0].family));
  const W = canvas.width;
  const H = canvas.height;
  const style = input.textStyle ?? {};
  const hasText = Boolean(input.headline || input.subheadline);
  const families = prepared.map((d) => (d.family === "flat" ? "mac" : d.family)) as Family[];
  const layout = computeLayout(input.layout, W, H, families, hasText, style.position);
  const placements = prepared.map((d, i) => placement(d, layout.devices[i] ?? layout.devices[layout.devices.length - 1], W, H));

  const headSize = sizePx(style.headlineSize, H, layout.headlineSize);
  let caption: CaptionPlan | undefined;
  if (hasText) {
    const align = style.align ?? layout.text.align;
    const layoutX = align === layout.text.align ? layout.text.x : align === "left" ? 0.07 : align === "right" ? 0.93 : 0.5;
    caption = {
      x: style.x ?? layoutX,
      y: style.y ?? layout.text.y,
      anchor: style.anchor ?? (style.y !== undefined ? "top" : layout.text.anchor),
      width: style.width ?? layout.text.width,
      align,
      headSize,
      subSize: sizePx(style.subheadlineSize, H, Math.round(headSize * 0.46)),
    };
  }
  return { prepared, warnings, canvas, layout, placements, caption, headSize };
}

function menuBarFraction(d: Prepared): number | undefined {
  const m = d.resolved?.model;
  if (d.kind !== "device" || m?.family !== "mac" || !d.options.menuBar || d.options.island === "never") return undefined;
  return Math.round((MAC_MENU_BAR / (m.screen.height / m.screen.scale)) * 10000) / 10000;
}

function entitiesFor(input: MockupInput, plan: ScenePlan, textColor: string): SceneEntity[] {
  const { width: W, height: H } = plan.canvas;
  const round = (v: number) => Math.round(v * 10000) / 10000;
  const entities: SceneEntity[] = plan.prepared.map((d, i) => {
    const p = plan.placements[i];
    return {
      id: `device-${i + 1}`,
      kind: "device",
      index: i,
      x: round(p.cx / W),
      y: round(p.cy / H),
      width: round(p.visW / W),
      height: round(p.visH / H),
      rotate: p.rotate,
      rotateX: p.rotateX,
      rotateY: p.rotateY,
      z: p.z,
      screenshot: d.file,
      frame: d.kind,
      device: d.resolved?.model.name,
      color: d.color?.hex,
      screen: Object.fromEntries(Object.entries(screenRect(d.options)).map(([k, v]) => [k, round(v)])) as SceneEntity["screen"],
      menuBar: menuBarFraction(d),
    };
  });
  const style = input.textStyle ?? {};
  if (plan.caption) {
    const c = plan.caption;
    entities.push({
      id: "caption",
      kind: "caption",
      x: round(c.x),
      y: round(c.y),
      width: round(c.width),
      rotate: 0,
      z: 30,
      anchor: c.anchor,
      align: c.align,
      text: input.headline,
      subtext: input.subheadline,
      size: round(c.headSize / H),
      subSize: round(c.subSize / H),
      weight: style.headlineWeight ?? 700,
      color: style.color ?? textColor,
      font: fontStack(style.font).stack,
    });
  }
  (input.texts ?? []).forEach((t, i) =>
    entities.push({
      id: `text-${i + 1}`,
      kind: "text",
      index: i,
      x: round(t.x ?? 0.5),
      y: round(t.y ?? 0.1),
      width: round(t.width ?? 0.86),
      rotate: t.rotate ?? 0,
      z: t.z ?? 30,
      anchor: t.anchor ?? "top",
      align: t.align ?? "center",
      text: t.text,
      size: round(sizePx(t.size, H, Math.round(plan.headSize * 0.5)) / H),
      weight: t.weight ?? 700,
      color: t.color ?? textColor,
      font: fontStack(t.font).stack,
    }),
  );
  return entities;
}

export interface SceneLayout {
  canvas: { width: number; height: number; name: string };
  layout: string;
  entities: SceneEntity[];
  warnings: string[];
}

/**
 * Resolve where everything goes without rendering: canvas size, layout and every entity's
 * position and size. Fast (no photos, OCR or browser), for agents planning edits and for the
 * Studio's layout canvas.
 */
export async function layoutScene(input: MockupInput): Promise<SceneLayout> {
  const plan = await planScene(input, true);
  const tone = quickTone(input.background);
  const textColor = input.textStyle?.color ?? (tone === "light" ? "#0b0b0f" : "#ffffff");
  return { canvas: plan.canvas, layout: plan.layout.layout, entities: entitiesFor(input, plan, textColor), warnings: plan.warnings };
}

// ---------------------------------------------------------------------------------------------
// Page

function googleFontLinks(families: Map<string, Set<number>>, local: Set<string>): string {
  const links: string[] = [];
  for (const [family, weights] of families) {
    if (local.has(family.toLowerCase())) continue;
    for (const w of weights) {
      const q = `${encodeURIComponent(family).replace(/%20/g, "+")}:wght@${w}`;
      links.push(`<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=${q}&display=block">`);
    }
  }
  return links.join("");
}

export function resolveCanvas(canvas: MockupInput["canvas"], landscape: boolean | undefined, fallback: string) {
  let width: number;
  let height: number;
  let name: string;
  if (canvas && typeof canvas === "object") {
    ({ width, height } = canvas);
    name = `${width}x${height}`;
  } else {
    name = canvas ?? fallback;
    const custom = /^(\d+)\s*x\s*(\d+)$/i.exec(name);
    const preset = CANVAS_PRESETS[name.toLowerCase()];
    if (custom) {
      width = Number(custom[1]);
      height = Number(custom[2]);
    } else if (preset) {
      ({ width, height } = preset);
    } else {
      throw new Error(`Unknown canvas "${name}". Presets: ${Object.keys(CANVAS_PRESETS).join(", ")}, or "WIDTHxHEIGHT".`);
    }
  }
  if (landscape && height > width) [width, height] = [height, width];
  return { width, height, name };
}

export interface BuiltScene {
  html: string;
  width: number;
  height: number;
  layout: string;
  transparent: boolean;
  result: Omit<MockupResult, "path" | "width" | "height">;
}

/** Resolve everything in a mockup request and produce the page that renders it. */
export async function buildScene(input: MockupInput, anim?: SceneAnimation): Promise<BuiltScene> {
  const plan = await planScene(input);
  const { prepared, warnings, layout, caption } = plan;
  const W = plan.canvas.width;
  const H = plan.canvas.height;
  const style = input.textStyle ?? {};
  const hasText = Boolean(caption);

  const bg = await resolveBackground(input.background, W, H, prepared[0].file, warnings, averageColor);
  const effects: NonNullable<EffectsInput> = { ...bg.lookEffects, ...(input.effects ?? {}) };
  const textColor = style.color ?? (bg.tone === "light" ? "#0b0b0f" : "#ffffff");

  // Caption: headline + subheadline stacked in one block so they never overlap.
  const headSize = plan.headSize;
  let textBlock = "";
  if (caption) {
    const align = caption.align;
    const common = {
      align,
      font: style.font,
      letterSpacing: style.letterSpacing,
      uppercase: style.uppercase,
      accentColor: style.accentColor,
      color: textColor,
      shadow: style.shadow,
    };
    const lines: string[] = [];
    if (input.headline) lines.push(textHtml({ ...common, text: input.headline, size: caption.headSize, weight: style.headlineWeight ?? 700 }, W, H, true));
    if (input.subheadline) {
      lines.push(
        textHtml(
          {
            ...common,
            text: input.subheadline,
            size: caption.subSize,
            weight: style.subheadlineWeight ?? 500,
            opacity: 0.78,
            letterSpacing: style.letterSpacing ?? -0.005,
            lineHeight: 1.25,
          },
          W,
          H,
          true,
        ),
      );
    }
    const tx = align === "left" ? "0" : align === "right" ? "-100%" : "-50%";
    const ty = caption.anchor === "top" ? "0" : caption.anchor === "bottom" ? "-100%" : "-50%";
    textBlock =
      `<div class="text-block" style="left:${px(caption.x * W)};top:${px(caption.y * H)};width:${px(caption.width * W)};transform:translate(${tx},${ty});gap:${px(headSize * 0.28)};align-items:${align === "left" ? "flex-start" : align === "right" ? "flex-end" : "center"}">` +
      lines.join("") +
      `</div>`;
  }
  // Extra text shares the headline's star colour unless it sets its own.
  const extraTexts = (input.texts ?? []).map((t) => ({ ...t, color: t.color ?? textColor, accentColor: t.accentColor ?? style.accentColor, size: sizePx(t.size, H, Math.round(headSize * 0.5)) }));

  // Fonts to fetch from Google Fonts, with the weights actually used.
  const fontWeights = new Map<string, Set<number>>();
  const addFont = (font: string | undefined, weight: number) => {
    const family = fontStack(font).family;
    if (!family) return;
    if (!fontWeights.has(family)) fontWeights.set(family, new Set());
    fontWeights.get(family)!.add(weight);
  };
  if (hasText) {
    addFont(style.font, style.headlineWeight ?? 700);
    addFont(style.font, style.subheadlineWeight ?? 500);
  }
  for (const t of extraTexts) addFont(t.font, t.weight ?? 700);
  const localFonts = new Set((input.fonts ?? []).map((f) => f.family.toLowerCase()));
  const fontFaces = (input.fonts ?? [])
    .map((f) => `@font-face{font-family:"${f.family.replace(/"/g, "")}";src:url("${fileUrl(f.path)}");font-display:block;}`)
    .join("\n");

  const placed = prepared.map((d, i) => place(d, plan.placements[i], bg.color, anim));

  // Effects.
  const grade = gradeFor(effects.grade);
  const grainObj = typeof effects.grain === "number" ? { amount: effects.grain } : effects.grain;
  const grainScope = grainObj?.scope ?? "background";
  let edge = "";
  if (effects.edgeBlur) {
    const e = effects.edgeBlur === true ? {} : effects.edgeBlur;
    const mode = e.edges ?? "auto";
    const edges: Array<"top" | "bottom"> =
      mode === "both"
        ? ["top", "bottom"]
        : mode === "top" || mode === "bottom"
          ? [mode]
          : ([placed.some((p) => p.top < 0) ? "top" : undefined, placed.some((p) => p.bottom > H) ? "bottom" : undefined].filter(Boolean) as Array<"top" | "bottom">);
    edge = edgeBlurHtml(edges, e.extent ?? 0.25, e.amount ?? 0.012, W, H);
  }

  const bgGroup =
    `<div class="bg-group" style="${grade.filter && grade.scope === "background" ? `filter:${grade.filter};` : ""}">` +
    bg.html +
    (grade.scope === "background" ? grade.overlays : "") +
    vignetteHtml(effects.vignette) +
    (grainScope === "background" ? grainHtml(effects.grain, 4) : "") +
    `</div>`;
  let scene = `${bgGroup}${placed.map((p) => p.html).join("\n")}`;
  if (grade.scope === "all") scene = `<div class="scene" style="${grade.filter ? `filter:${grade.filter};` : ""}">${scene}${grade.overlays}</div>`;
  // Video camera moves (push-in, zoom) scale this wrapper; captions stay put above it.
  if (anim) scene = `<div id="stage" class="scene">${scene}</div>`;

  const html = `<!doctype html><html><head><meta charset="utf-8">
${googleFontLinks(fontWeights, localFonts)}
<style>
${fontFaces}
html,body{margin:0;padding:0;background:transparent;}
#canvas{position:relative;width:${W}px;height:${H}px;overflow:hidden;-webkit-font-smoothing:antialiased;text-rendering:geometricPrecision;}
.scene,.bg-group{position:absolute;inset:0;}
.bg{position:absolute;inset:0;overflow:hidden;}
.dev-wrap{position:absolute;width:0;height:0;}
.dev-stage,.dev-rot{position:absolute;}
.text-block{position:absolute;display:flex;flex-direction:column;z-index:30;}
.text>div{text-wrap:balance;}
.text-block,.text{opacity:var(--cap, 1);translate:0 calc((1 - var(--cap, 1)) * ${Math.round(H * 0.012)}px);}
.grain{background-position:var(--gx, 0px) var(--gy, 0px);}
${FRAME_CSS}
</style></head><body>
<svg width="0" height="0" style="position:absolute"><defs>${bg.defs}</defs></svg>
<div id="canvas">
${scene}
${edge}
${textBlock}
${extraTexts.map((t) => textHtml(t, W, H)).join("\n")}
${grainScope === "all" ? grainHtml(effects.grain, 50) : ""}
</div></body></html>`;

  return {
    html,
    width: W,
    height: H,
    layout: layout.layout,
    transparent: bg.transparent,
    result: {
      layout: layout.layout,
      background: bg.lookName,
      devices: prepared.map((d) => ({
        screenshot: d.file,
        frame: d.kind,
        device: d.resolved?.model.name,
        color: d.color?.name,
        source: d.resolved?.source,
      })),
      credits: bg.credits,
      entities: entitiesFor(input, plan, textColor),
      warnings,
    },
  };
}

export const IMAGE_FORMATS = ["png", "jpeg", "webp"] as const;

export async function createMockup(input: MockupInput): Promise<MockupResult> {
  const scene = await buildScene(input);
  const { html, width: W, height: H } = scene;
  const format = formatFor(input.format, input.output, IMAGE_FORMATS, "png", { jpg: "jpeg" });
  const out = outputPathFor(input.output, "mockups", `mockup-${scene.layout}`, format === "jpeg" ? "jpg" : format);
  const preview = input.quality === "preview";
  // Final size: delivery width if asked, half size for previews, else the canvas.
  const outW = input.deliveryWidth ?? (preview ? Math.round(W / 2) : W);
  const outH = Math.round((H * outW) / W);
  // Render at 2× for smooth edges (within a pixel budget), then resample once to the final size.
  const scale = preview ? outW / W : W * H <= 4_500_000 ? 2 : 1;
  await renderHtml(html, out, W, H, {
    scale,
    format,
    quality: input.jpegQuality,
    transparent: scene.transparent && format !== "jpeg",
    outWidth: outW,
    outHeight: outH,
  });

  // Keep the exact request next to the image so it can be tweaked and re-rendered.
  writeFileSync(`${out}.mockup.json`, JSON.stringify({ ...input, output: out }, null, 2));
  return { path: out, width: outW, height: outH, ...scene.result };
}

/**
 * Render a page to an image file. The page is captured at `scale`, then (if the size or format
 * needs it) resampled and encoded in the browser, so PNG, JPEG and WebP all come out at exactly
 * outWidth × outHeight with a single high-quality resample and a single encode.
 */
export async function renderHtml(
  html: string,
  out: string,
  W: number,
  H: number,
  opts: { scale: number; format: "png" | "jpeg" | "webp"; quality?: number; transparent: boolean; outWidth?: number; outHeight?: number },
): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), "screenshotter-"));
  const htmlFile = path.join(dir, "scene.html");
  await writeFile(htmlFile, html);
  if (process.env.SCREENSHOTTER_DEBUG_HTML) await writeFile(`${out}.html`, html);
  const outW = opts.outWidth ?? W;
  const outH = opts.outHeight ?? H;
  const quality = Math.min(100, Math.max(1, opts.quality ?? 92));
  const page = await newPage();
  try {
    await page.setViewport({ width: W, height: H, deviceScaleFactor: opts.scale });
    await page.goto(pathToFileURL(htmlFile).href, { waitUntil: "load", timeout: 90_000 });
    await page.evaluate(async () => {
      await Promise.race([document.fonts.ready, new Promise((r) => setTimeout(r, 8000))]);
      await Promise.all(Array.from(document.images).map((img) => (img.complete ? Promise.resolve() : img.decode().catch(() => undefined))));
      const broken = Array.from(document.images).filter((img) => !img.naturalWidth).map((img) => img.src.slice(0, 200));
      if (broken.length) throw new Error(`Could not load image(s): ${broken.join(", ")}`);
    });
    const clip = { x: 0, y: 0, width: W, height: H };
    const direct = Math.round(W * opts.scale) === outW && Math.round(H * opts.scale) === outH;
    if (direct) {
      await page.screenshot({
        path: out as `${string}.png`,
        type: opts.format,
        quality: opts.format === "png" ? undefined : quality,
        clip,
        omitBackground: opts.transparent,
        captureBeyondViewport: false,
      });
      return;
    }
    const raw = (await page.screenshot({ type: "png", encoding: "base64", clip, omitBackground: opts.transparent, captureBeyondViewport: false })) as string;
    // Resample + encode in a blank page so the scene's own layers don't get in the way.
    await page.goto("about:blank");
    const encoded = await page.evaluate(
      async (b64, w, h, mime, q) => {
        const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
        const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/png" }), { resizeWidth: w, resizeHeight: h, resizeQuality: "high" });
        const canvas = new OffscreenCanvas(w, h);
        const ctx = canvas.getContext("2d")!;
        if (mime === "image/jpeg") {
          ctx.fillStyle = "#fff";
          ctx.fillRect(0, 0, w, h);
        }
        ctx.drawImage(bitmap, 0, 0);
        const blob = await canvas.convertToBlob({ type: mime, quality: q / 100 });
        const buf = new Uint8Array(await blob.arrayBuffer());
        let bin = "";
        for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
        return { data: btoa(bin), type: blob.type };
      },
      raw,
      outW,
      outH,
      `image/${opts.format}`,
      quality,
    );
    if (encoded.type !== `image/${opts.format}`) throw new Error(`This browser can't encode ${opts.format} images.`);
    writeFileSync(out, Buffer.from(encoded.data, "base64"));
  } finally {
    await page.close().catch(() => undefined);
    await rm(dir, { recursive: true, force: true });
  }
}
