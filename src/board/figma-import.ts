/**
 * Figma onto a board: a file's frames (or one frame, from a link to it) as artboards of ordinary
 * layers, read through Figma's REST API with a personal access token.
 *
 * Each Figma node becomes HTML with inline styles, the same way a website comes in: auto layout as
 * flex (direction, gap, padding, alignment, wrap, fill and hug), everything else placed
 * absolutely; fills (solid, gradients, pictures), strokes, corner radii, shadows, blurs, opacity and
 * blend modes as CSS; text with its runs of styles; vectors and icons as SVG (Figma draws them).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { freeSpot, htmlToNodes, type Op } from "./core.js";
import { changeBoard, createBoard, getBoard } from "./store.js";
import { libraryFolder } from "../util/files.js";

type Progress = (fraction: number, step?: string) => void;

// ---------------------------------------------------------------------------------------------
// Figma's REST API: the parts read here (https://www.figma.com/developers/api)

interface Color { r: number; g: number; b: number; a: number }
interface Paint {
  type: "SOLID" | "GRADIENT_LINEAR" | "GRADIENT_RADIAL" | "GRADIENT_ANGULAR" | "GRADIENT_DIAMOND" | "IMAGE" | "EMOJI" | "VIDEO";
  visible?: boolean;
  opacity?: number;
  color?: Color;
  gradientHandlePositions?: { x: number; y: number }[];
  gradientStops?: { position: number; color: Color }[];
  scaleMode?: "FILL" | "FIT" | "TILE" | "STRETCH";
  imageRef?: string;
  blendMode?: string;
}
interface Effect { type: "DROP_SHADOW" | "INNER_SHADOW" | "LAYER_BLUR" | "BACKGROUND_BLUR"; visible?: boolean; radius: number; color?: Color; offset?: { x: number; y: number }; spread?: number }
interface TypeStyle {
  fontFamily?: string;
  fontWeight?: number;
  fontSize?: number;
  italic?: boolean;
  letterSpacing?: number;
  lineHeightPx?: number;
  lineHeightPercentFontSize?: number;
  lineHeightUnit?: "PIXELS" | "FONT_SIZE_%" | "INTRINSIC_%";
  textAlignHorizontal?: "LEFT" | "CENTER" | "RIGHT" | "JUSTIFIED";
  textAlignVertical?: "TOP" | "CENTER" | "BOTTOM";
  textCase?: "ORIGINAL" | "UPPER" | "LOWER" | "TITLE" | "SMALL_CAPS" | "SMALL_CAPS_FORCED";
  textDecoration?: "NONE" | "STRIKETHROUGH" | "UNDERLINE";
  textAutoResize?: "NONE" | "HEIGHT" | "WIDTH_AND_HEIGHT" | "TRUNCATE";
  fills?: Paint[];
}
export interface FigmaNode {
  id: string;
  name: string;
  type: string;
  visible?: boolean;
  children?: FigmaNode[];
  absoluteBoundingBox?: { x: number; y: number; width: number; height: number } | null;
  fills?: Paint[];
  strokes?: Paint[];
  strokeWeight?: number;
  individualStrokeWeights?: { top: number; right: number; bottom: number; left: number };
  strokeAlign?: "INSIDE" | "OUTSIDE" | "CENTER";
  strokeDashes?: number[];
  cornerRadius?: number;
  rectangleCornerRadii?: [number, number, number, number];
  effects?: Effect[];
  opacity?: number;
  blendMode?: string;
  clipsContent?: boolean;
  isMask?: boolean;
  layoutMode?: "NONE" | "HORIZONTAL" | "VERTICAL" | "GRID";
  layoutWrap?: "NO_WRAP" | "WRAP";
  primaryAxisAlignItems?: "MIN" | "CENTER" | "MAX" | "SPACE_BETWEEN";
  counterAxisAlignItems?: "MIN" | "CENTER" | "MAX" | "BASELINE";
  paddingLeft?: number;
  paddingRight?: number;
  paddingTop?: number;
  paddingBottom?: number;
  itemSpacing?: number;
  counterAxisSpacing?: number;
  layoutPositioning?: "AUTO" | "ABSOLUTE";
  layoutSizingHorizontal?: "FIXED" | "HUG" | "FILL";
  layoutSizingVertical?: "FIXED" | "HUG" | "FILL";
  layoutGrow?: number;
  layoutAlign?: "INHERIT" | "STRETCH" | "MIN" | "CENTER" | "MAX";
  characters?: string;
  style?: TypeStyle;
  characterStyleOverrides?: number[];
  styleOverrideTable?: Record<string, TypeStyle>;
}

const API = "https://api.figma.com/v1";

/** A Figma link's file key and (when it points at one) node id: figma.com/design/<key>/…?node-id=12-34. */
export function parseFigmaUrl(url: string): { key: string; node?: string } {
  let u: URL;
  try {
    u = new URL(/^https?:\/\//i.test(url.trim()) ? url.trim() : `https://${url.trim()}`);
  } catch {
    throw new Error("That isn't a Figma link. Copy it from Figma: Share › Copy link, or right-click a frame › Copy link to selection.");
  }
  if (!/(^|\.)figma\.com$/i.test(u.hostname)) throw new Error("That isn't a Figma link (it should be on figma.com).");
  const parts = u.pathname.split("/").filter(Boolean);
  const at = parts.findIndex((p) => ["file", "design", "proto", "board"].includes(p));
  if (at < 0 || !parts[at + 1]) throw new Error("That Figma link doesn't point at a file. Copy it from Figma: Share › Copy link.");
  // A branch of a file has a key of its own: /design/<file>/branch/<branch>/…
  const key = parts[at + 2] === "branch" && parts[at + 3] ? parts[at + 3] : parts[at + 1];
  const raw = u.searchParams.get("node-id");
  const node = raw ? decodeURIComponent(raw).replace(/-/g, ":") : undefined;
  return { key, node: node && node !== "0:1" ? node : undefined };
}

async function figma<T>(token: string, url: string, tries = 5): Promise<T> {
  // While developing the importer: Figma's answers kept on disk (SCREENSHOTTER_FIGMA_CACHE), so
  // running the same import again doesn't use up Figma's rate limit.
  const cacheDir = process.env.SCREENSHOTTER_FIGMA_CACHE;
  const cached = cacheDir ? path.join(cacheDir, `${createHash("sha1").update(url).digest("hex")}.json`) : "";
  if (cached && existsSync(cached)) return JSON.parse(readFileSync(cached, "utf8")) as T;
  const res = await fetch(url, { headers: { "X-Figma-Token": token } });
  // Too many requests: wait as long as Figma asks (a minute at most), then try again.
  if (res.status === 429 && tries > 1) {
    const wait = Math.min(60, Math.max(2, Number(res.headers.get("retry-after")) || 2 ** (6 - tries)));
    await new Promise((r) => setTimeout(r, wait * 1000));
    return figma<T>(token, url, tries - 1);
  }
  if (res.status === 403) throw new Error("Figma refused the token: make a new personal access token in Figma (Settings › Security › Personal access tokens) with read access to files, and paste it again.");
  if (res.status === 404) throw new Error("Figma couldn't find that file. Check the link, and that the token's account can open the file.");
  if (res.status === 429) throw new Error("Figma says too many requests: wait a minute and try again.");
  if (!res.ok) throw new Error(`Figma answered ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const body = (await res.json()) as T;
  if (cached) {
    mkdirSync(cacheDir!, { recursive: true });
    writeFileSync(cached, JSON.stringify(body));
  }
  return body;
}

// ---------------------------------------------------------------------------------------------
// Figma to HTML

const px = (n: number) => `${Math.round(n * 100) / 100}px`;
const clampByte = (v: number) => Math.max(0, Math.min(255, Math.round(v * 255)));
function rgba(c: Color | undefined, opacity = 1): string {
  if (!c) return "transparent";
  const a = Math.round((c.a ?? 1) * opacity * 1000) / 1000;
  return a >= 1 ? `rgb(${clampByte(c.r)}, ${clampByte(c.g)}, ${clampByte(c.b)})` : `rgba(${clampByte(c.r)}, ${clampByte(c.g)}, ${clampByte(c.b)}, ${a})`;
}
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const attr = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
const visible = <T extends { visible?: boolean }>(xs: T[] | undefined) => (xs ?? []).filter((x) => x.visible !== false);

const BLEND: Record<string, string> = {
  MULTIPLY: "multiply", SCREEN: "screen", OVERLAY: "overlay", DARKEN: "darken", LIGHTEN: "lighten", COLOR_DODGE: "color-dodge", COLOR_BURN: "color-burn",
  HARD_LIGHT: "hard-light", SOFT_LIGHT: "soft-light", DIFFERENCE: "difference", EXCLUSION: "exclusion", HUE: "hue", SATURATION: "saturation", COLOR: "color", LUMINOSITY: "luminosity",
};

/** A gradient's CSS, from its handles (the angle) and stops. */
function gradientCss(p: Paint): string | undefined {
  const stops = (p.gradientStops ?? []).map((s) => `${rgba(s.color, p.opacity ?? 1)} ${Math.round(s.position * 1000) / 10}%`).join(", ");
  if (!stops) return undefined;
  const [a, b] = p.gradientHandlePositions ?? [];
  if (p.type === "GRADIENT_LINEAR") {
    const deg = a && b ? Math.round((Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI + 90) : 180;
    return `linear-gradient(${deg}deg, ${stops})`;
  }
  if (p.type === "GRADIENT_RADIAL" || p.type === "GRADIENT_DIAMOND") return `radial-gradient(circle at ${a ? `${Math.round(a.x * 100)}% ${Math.round(a.y * 100)}%` : "center"}, ${stops})`;
  if (p.type === "GRADIENT_ANGULAR") return `conic-gradient(from 90deg at ${a ? `${Math.round(a.x * 100)}% ${Math.round(a.y * 100)}%` : "center"}, ${stops})`;
  return undefined;
}

interface Ctx {
  /** imageRef → local picture. */
  images: Record<string, string>;
  /** node id → its SVG, as Figma draws it (vectors, icons). */
  svgs: Record<string, string>;
  warnings: Set<string>;
}

/** The background of a frame or shape: its fills, topmost first (Figma lists them bottom up). */
function fillCss(fills: Paint[] | undefined, ctx: Ctx, out: Record<string, string>) {
  const layers: string[] = [];
  let color: string | undefined;
  const sizes: string[] = [];
  const list = visible(fills);
  for (let i = list.length - 1; i >= 0; i--) {
    const p = list[i];
    if (p.type === "SOLID") {
      // A solid under everything is the background colour; one above a picture is a flat layer.
      if (!layers.length && i === 0) color = rgba(p.color, p.opacity ?? 1);
      else layers.push(`linear-gradient(${rgba(p.color, p.opacity ?? 1)}, ${rgba(p.color, p.opacity ?? 1)})`), sizes.push("auto");
    } else if (p.type === "IMAGE") {
      const file = p.imageRef ? ctx.images[p.imageRef] : undefined;
      if (!file) {
        ctx.warnings.add("Some pictures couldn't be fetched from Figma; they're left empty.");
        continue;
      }
      layers.push(`url("${file}")`);
      sizes.push(p.scaleMode === "FIT" ? "contain" : p.scaleMode === "TILE" ? "auto" : p.scaleMode === "STRETCH" ? "100% 100%" : "cover");
    } else {
      const g = gradientCss(p);
      if (g) layers.push(g), sizes.push("auto");
    }
  }
  if (color) out.backgroundColor = color;
  if (layers.length) {
    out.backgroundImage = layers.join(", ");
    out.backgroundSize = sizes.join(", ");
    out.backgroundPosition = "center";
    out.backgroundRepeat = list.some((p) => p.type === "IMAGE" && p.scaleMode === "TILE") ? "repeat" : "no-repeat";
  }
}

function strokeCss(n: FigmaNode, out: Record<string, string>) {
  const s = visible(n.strokes).find((p) => p.type === "SOLID");
  if (!s || !(n.strokeWeight || n.individualStrokeWeights)) return;
  const color = rgba(s.color, s.opacity ?? 1);
  const style = n.strokeDashes?.length ? "dashed" : "solid";
  if (n.strokeAlign === "OUTSIDE" && !n.individualStrokeWeights) {
    out.outline = `${px(n.strokeWeight ?? 1)} ${style} ${color}`;
    return;
  }
  if (n.individualStrokeWeights) {
    const w = n.individualStrokeWeights;
    for (const [side, v] of [["Top", w.top], ["Right", w.right], ["Bottom", w.bottom], ["Left", w.left]] as const) if (v) out[`border${side}`] = `${px(v)} ${style} ${color}`;
  } else out.border = `${px(n.strokeWeight ?? 1)} ${style} ${color}`;
  out.boxSizing = "border-box";
}

function effectsCss(n: FigmaNode, out: Record<string, string>, text = false) {
  const shadows: string[] = [];
  for (const e of visible(n.effects)) {
    if (e.type === "DROP_SHADOW" || e.type === "INNER_SHADOW") {
      const s = `${e.type === "INNER_SHADOW" ? "inset " : ""}${px(e.offset?.x ?? 0)} ${px(e.offset?.y ?? 0)} ${px(e.radius)}${text ? "" : ` ${px(e.spread ?? 0)}`} ${rgba(e.color)}`;
      shadows.push(s);
    } else if (e.type === "LAYER_BLUR") out.filter = `blur(${px(e.radius / 2)})`;
    else if (e.type === "BACKGROUND_BLUR") out.backdropFilter = `blur(${px(e.radius / 2)})`;
  }
  if (shadows.length) {
    if (text) out.textShadow = shadows.filter((s) => !s.startsWith("inset")).join(", ");
    else out.boxShadow = shadows.join(", ");
  }
}

function radiusCss(n: FigmaNode, out: Record<string, string>) {
  if (n.rectangleCornerRadii?.some((r) => r)) out.borderRadius = n.rectangleCornerRadii.map(px).join(" ");
  else if (n.cornerRadius) out.borderRadius = px(n.cornerRadius);
}

const ALIGN: Record<string, string> = { MIN: "flex-start", CENTER: "center", MAX: "flex-end", SPACE_BETWEEN: "space-between", BASELINE: "baseline" };

/** A text style as CSS: font, size, weight, spacing, case, decoration and colour. */
function textCss(t: TypeStyle | undefined, out: Record<string, string>) {
  if (!t) return;
  if (t.fontFamily) out.fontFamily = /[\s,]/.test(t.fontFamily) ? `"${t.fontFamily}"` : t.fontFamily;
  if (t.fontSize) out.fontSize = px(t.fontSize);
  if (t.fontWeight) out.fontWeight = String(t.fontWeight);
  if (t.italic) out.fontStyle = "italic";
  if (t.letterSpacing) out.letterSpacing = px(t.letterSpacing);
  if (t.lineHeightUnit === "PIXELS" && t.lineHeightPx) out.lineHeight = px(t.lineHeightPx);
  else if (t.lineHeightUnit === "FONT_SIZE_%" && t.lineHeightPercentFontSize) out.lineHeight = String(Math.round(t.lineHeightPercentFontSize) / 100);
  if (t.textCase === "UPPER") out.textTransform = "uppercase";
  else if (t.textCase === "LOWER") out.textTransform = "lowercase";
  else if (t.textCase === "TITLE") out.textTransform = "capitalize";
  else if (t.textCase === "SMALL_CAPS" || t.textCase === "SMALL_CAPS_FORCED") out.fontVariant = "small-caps";
  if (t.textDecoration === "UNDERLINE") out.textDecoration = "underline";
  else if (t.textDecoration === "STRIKETHROUGH") out.textDecoration = "line-through";
  const fill = visible(t.fills).find((p) => p.type === "SOLID");
  if (fill) out.color = rgba(fill.color, fill.opacity ?? 1);
}

/**
 * A text layer's paint (on the layer, not in its text style): a colour, or a gradient or picture
 * shown through the letters.
 */
function textPaint(fills: Paint[] | undefined, ctx: Ctx, out: Record<string, string>) {
  const list = visible(fills);
  if (!list.length) return;
  if (list.length === 1 && list[0].type === "SOLID") {
    out.color = rgba(list[0].color, list[0].opacity ?? 1);
    return;
  }
  const bg: Record<string, string> = {};
  fillCss(list, ctx, bg);
  const layers = [bg.backgroundImage, bg.backgroundColor && `linear-gradient(${bg.backgroundColor}, ${bg.backgroundColor})`].filter(Boolean).join(", ");
  if (!layers) return;
  out.backgroundImage = layers;
  if (bg.backgroundSize) out.backgroundSize = `${bg.backgroundSize}${bg.backgroundColor ? ", auto" : ""}`;
  out.WebkitBackgroundClip = "text";
  out.backgroundClip = "text";
  out.color = "transparent";
  out.WebkitTextFillColor = "transparent";
}

const css = (o: Record<string, string>) =>
  Object.entries(o)
    .filter(([, v]) => v !== undefined && v !== "")
    .map(([k, v]) => `${k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}:${v.replace(/"/g, "'")}`)
    .join(";");

/** The words, with each run of a different style as a span. */
function textHtml(n: FigmaNode): string {
  const chars = n.characters ?? "";
  const overrides = n.characterStyleOverrides ?? [];
  const table = n.styleOverrideTable ?? {};
  const runs: { text: string; style: number }[] = [];
  for (let i = 0; i < chars.length; i++) {
    const s = overrides[i] ?? 0;
    if (runs.length && runs[runs.length - 1].style === s) runs[runs.length - 1].text += chars[i];
    else runs.push({ text: chars[i], style: s });
  }
  const words = (t: string) => esc(t).replace(/\n/g, "<br>");
  return runs
    .map((r) => {
      const t = r.style ? table[String(r.style)] : undefined;
      if (!t) return words(r.text);
      const o: Record<string, string> = {};
      textCss({ ...t, textAlignHorizontal: undefined }, o);
      return Object.keys(o).length ? `<span style="${attr(css(o))}">${words(r.text)}</span>` : words(r.text);
    })
    .join("");
}

const VECTORS = new Set(["VECTOR", "BOOLEAN_OPERATION", "STAR", "LINE", "REGULAR_POLYGON", "POLYGON"]);
/** A group made only of drawn shapes (an icon, a logo): drawn by Figma as one SVG. */
function onlyShapes(n: FigmaNode): boolean {
  const kids = visible(n.children);
  if (!kids.length) return false;
  return kids.every((c) => VECTORS.has(c.type) || ((c.type === "GROUP" || c.type === "FRAME" || c.type === "INSTANCE" || c.type === "COMPONENT") && !visible(c.fills).some((p) => p.type === "IMAGE") && (onlyShapes(c) || !visible(c.children).length) && !c.layoutMode) || (["ELLIPSE", "RECTANGLE"].includes(c.type) && !visible(c.fills).some((p) => p.type === "IMAGE")));
}
/** The nodes Figma should draw as SVG: vectors, and groups that are only shapes (small enough to be icons or logos). */
export function svgNodes(root: FigmaNode, out: string[] = []): string[] {
  for (const c of visible(root.children)) {
    if (c.isMask) continue;
    const box = c.absoluteBoundingBox;
    if (VECTORS.has(c.type) || (c.type !== "TEXT" && onlyShapes(c) && box && box.width <= 400 && box.height <= 400)) out.push(c.id);
    else svgNodes(c, out);
  }
  return out;
}

/** One node (and what's in it) as HTML. `parent` is its frame, for where it sits and how it's laid out. */
export function nodeHtml(n: FigmaNode, parent: FigmaNode | null, ctx: Ctx): string {
  if (n.visible === false || n.isMask) return "";
  const box = n.absoluteBoundingBox;
  if (!box) return "";
  const st: Record<string, string> = {};
  const inFlow = parent && parent.layoutMode && parent.layoutMode !== "NONE" && n.layoutPositioning !== "ABSOLUTE";
  const pbox = parent?.absoluteBoundingBox;
  // Where it sits: by its frame's auto layout, or placed by hand.
  if (parent && !inFlow && pbox) {
    st.position = "absolute";
    st.left = px(box.x - pbox.x);
    st.top = px(box.y - pbox.y);
  }
  // How big: fixed, hugging what's in it, or filling its frame (in auto layout).
  const row = parent?.layoutMode === "HORIZONTAL";
  const sizeH = n.layoutSizingHorizontal ?? (inFlow && (row ? n.layoutGrow : n.layoutAlign === "STRETCH") ? "FILL" : "FIXED");
  const sizeV = n.layoutSizingVertical ?? (inFlow && (!row ? n.layoutGrow : n.layoutAlign === "STRETCH") ? "FILL" : "FIXED");
  const isText = n.type === "TEXT";
  const auto = isText ? n.style?.textAutoResize : undefined;
  if (sizeH === "FILL" && inFlow) {
    if (row) (st.flexGrow = "1"), (st.flexBasis = "0");
    else st.alignSelf = "stretch";
  } else if (!(sizeH === "HUG" && n.layoutMode && n.layoutMode !== "NONE") && auto !== "WIDTH_AND_HEIGHT") st.width = px(box.width);
  if (sizeV === "FILL" && inFlow) {
    if (!row) (st.flexGrow = "1"), (st.flexBasis = "0");
    else st.alignSelf = "stretch";
  } else if (!(sizeV === "HUG" && n.layoutMode && n.layoutMode !== "NONE") && !(isText && (auto === "HEIGHT" || auto === "WIDTH_AND_HEIGHT"))) st.height = px(box.height);
  if (inFlow) st.flexShrink = "0";
  if (n.opacity !== undefined && n.opacity < 1) st.opacity = String(Math.round(n.opacity * 1000) / 1000);
  if (n.blendMode && BLEND[n.blendMode]) st.mixBlendMode = BLEND[n.blendMode];
  const name = ` data-name="${attr(n.name)}"`;

  // Drawn by Figma: vectors and icons.
  const svg = ctx.svgs[n.id];
  if (svg) {
    const fixed = svg.replace(/<svg\b([^>]*)>/i, (_m, a: string) => `<svg${a.replace(/\s(width|height)="[^"]*"/g, "")} width="${Math.round(box.width * 100) / 100}" height="${Math.round(box.height * 100) / 100}"${name} style="${attr(css(st))}">`);
    return fixed;
  }

  if (isText) {
    textCss(n.style, st);
    textPaint(n.fills, ctx, st);
    effectsCss(n, st, true);
    const align = n.style?.textAlignHorizontal;
    if (align && align !== "LEFT") st.textAlign = align === "JUSTIFIED" ? "justify" : align.toLowerCase();
    if (auto === "WIDTH_AND_HEIGHT") st.whiteSpace = "nowrap";
    if (auto === "TRUNCATE") (st.overflow = "hidden"), (st.textOverflow = "ellipsis");
    // Fixed-height text keeps its vertical alignment.
    const v = n.style?.textAlignVertical;
    if (st.height && v && v !== "TOP") {
      st.display = "flex";
      st.flexDirection = "column";
      st.justifyContent = v === "CENTER" ? "center" : "flex-end";
      return `<div${name} style="${attr(css(st))}"><span>${textHtml(n)}</span></div>`;
    }
    return `<p${name} style="${attr(css({ margin: "0", ...st }))}">${textHtml(n)}</p>`;
  }

  fillCss(n.fills, ctx, st);
  strokeCss(n, st);
  effectsCss(n, st);
  radiusCss(n, st);
  if (n.type === "ELLIPSE") st.borderRadius = "50%";
  if (n.clipsContent) st.overflow = "hidden";
  // Auto layout as flex.
  if (n.layoutMode === "HORIZONTAL" || n.layoutMode === "VERTICAL") {
    st.display = "flex";
    st.flexDirection = n.layoutMode === "HORIZONTAL" ? "row" : "column";
    if (n.layoutWrap === "WRAP") {
      st.flexWrap = "wrap";
      if (n.counterAxisSpacing) st.rowGap = px(n.counterAxisSpacing);
    }
    if (n.primaryAxisAlignItems === "SPACE_BETWEEN") st.justifyContent = "space-between";
    else {
      if (n.primaryAxisAlignItems && n.primaryAxisAlignItems !== "MIN") st.justifyContent = ALIGN[n.primaryAxisAlignItems];
      if (n.itemSpacing) st[n.layoutWrap === "WRAP" ? "columnGap" : "gap"] = px(n.itemSpacing);
    }
    st.alignItems = ALIGN[n.counterAxisAlignItems ?? "MIN"];
    const pad = [n.paddingTop, n.paddingRight, n.paddingBottom, n.paddingLeft].map((v) => v ?? 0);
    if (pad.some((v) => v)) st.padding = pad.map(px).join(" ");
    st.boxSizing = "border-box";
  }
  const kids = visible(n.children);
  // Placed by hand inside: this frame is what they're placed against.
  if (kids.some((c) => !(n.layoutMode && n.layoutMode !== "NONE") || c.layoutPositioning === "ABSOLUTE")) st.position ||= "relative";
  const inner = kids.map((c) => nodeHtml(c, n, ctx)).join("");
  const glassFx = (visible(n.effects) as any[]).find((e) => e.type === "GLASS");
  const glassAttr = glassFx
    ? ` data-glass="${attr(
        JSON.stringify({
          refraction: Math.round((glassFx.refraction ?? 0.8) * (glassFx.refraction > 1 ? 1 : 100)),
          depth: Math.round((glassFx.depth ?? 0.65) * (glassFx.depth > 1 ? 1 : 100)),
          dispersion: Math.round((glassFx.chromaticAberration ?? glassFx.dispersion ?? 0.5) * ((glassFx.chromaticAberration ?? glassFx.dispersion ?? 0.5) > 1 ? 1 : 100)),
          frost: Math.round(Math.min(100, (glassFx.radius ?? glassFx.frost ?? 0) * 2)),
          splay: Math.round((glassFx.splay ?? 0) * ((glassFx.splay ?? 0) > 1 ? 1 : 100)),
          lightAngle: Math.round(glassFx.specularAngle ?? glassFx.lightAngle ?? -60),
          lightIntensity: Math.round((glassFx.specularIntensity ?? glassFx.lightIntensity ?? 0.8) * ((glassFx.specularIntensity ?? glassFx.lightIntensity ?? 0.8) > 1 ? 1 : 100)),
        }),
      )}"`
    : "";
  return `<div${name}${glassAttr} style="${attr(css(st))}">${inner}</div>`;
}

// ---------------------------------------------------------------------------------------------
// Fetching a file and putting it on a board

export interface FigmaImportResult {
  board: string;
  name: string;
  artboards: { id: string; name: string }[];
  layers: number;
  pictures: number;
  warnings: string[];
}

const MAX_FRAMES = 12;

/** The frames to bring in: the one linked to, or the top-level frames of the file's first page. */
function framesOf(doc: FigmaNode, node?: string): FigmaNode[] {
  const find = (n: FigmaNode): FigmaNode | undefined => (n.id === node ? n : (n.children ?? []).map(find).find(Boolean));
  if (node) {
    const hit = find(doc);
    if (!hit) throw new Error("That frame isn't in the file any more.");
    // A page: its frames. A frame (or anything in one): itself.
    return hit.type === "CANVAS" ? visible(hit.children).filter((c) => c.absoluteBoundingBox) : [hit];
  }
  const page = visible(doc.children)[0];
  return visible(page?.children).filter((c) => c.absoluteBoundingBox && ["FRAME", "COMPONENT", "COMPONENT_SET", "INSTANCE", "SECTION", "GROUP"].includes(c.type));
}

/** Pictures Figma holds (image fills), downloaded into the library. */
async function fetchImages(token: string, key: string, refs: Set<string>): Promise<Record<string, string>> {
  if (!refs.size) return {};
  const got = await figma<{ meta?: { images?: Record<string, string> } }>(token, `${API}/files/${key}/images`);
  const dir = path.join(libraryFolder(), "images", "figma");
  mkdirSync(dir, { recursive: true });
  const out: Record<string, string> = {};
  await Promise.all(
    [...refs].map(async (ref) => {
      const url = got.meta?.images?.[ref];
      if (!url) return;
      const file = path.join(dir, `${createHash("sha1").update(ref).digest("hex").slice(0, 16)}.png`);
      if (!existsSync(file)) {
        const res = await fetch(url);
        if (!res.ok) return;
        writeFileSync(file, Buffer.from(await res.arrayBuffer()));
      }
      out[ref] = file;
    }),
  );
  return out;
}

/** Vectors and icons, as Figma draws them in SVG. */
async function fetchSvgs(token: string, key: string, ids: string[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (let i = 0; i < ids.length; i += 80) {
    const batch = ids.slice(i, i + 80);
    const got = await figma<{ images?: Record<string, string | null> }>(token, `${API}/images/${key}?ids=${encodeURIComponent(batch.join(","))}&format=svg&svg_include_id=false&svg_simplify_stroke=true`);
    await Promise.all(
      batch.map(async (id) => {
        const url = got.images?.[id];
        if (!url) return;
        const res = await fetch(url);
        if (res.ok) out[id] = (await res.text()).replace(/<\?xml[^>]*>\s*/i, "");
      }),
    );
  }
  return out;
}

const imageRefs = (n: FigmaNode, out = new Set<string>()) => {
  for (const p of visible(n.fills)) if (p.type === "IMAGE" && p.imageRef) out.add(p.imageRef);
  for (const c of n.children ?? []) imageRefs(c, out);
  return out;
};

/** Bring a Figma file (or one frame of it) onto a board: a new one named after the file, unless `boardId`. */
export async function importFigma(boardId: string | null | undefined, opts: { url: string; token?: string; page?: string }, by: "agent" | "studio", progress: Progress = () => undefined): Promise<FigmaImportResult> {
  const token = (opts.token || process.env.FIGMA_TOKEN || "").trim();
  if (!token) throw new Error("Figma needs a personal access token: make one in Figma (Settings › Security › Personal access tokens, with read access to files) and add it in Settings › Figma.");
  const { key, node } = parseFigmaUrl(opts.url);
  progress(0.05, "Reading the file from Figma");
  // Just the frames needed: the one linked to, or (from the file's outline) the first page's.
  let name = "";
  let ids: string[];
  let more = 0;
  if (node) ids = [node];
  else {
    const outline = await figma<{ name: string; document: FigmaNode }>(token, `${API}/files/${key}?depth=2`);
    name = outline.name;
    const all = framesOf(outline.document);
    more = Math.max(0, all.length - MAX_FRAMES);
    ids = all.slice(0, MAX_FRAMES).map((f) => f.id);
    if (!ids.length) throw new Error("There are no frames on the file's first page to bring in.");
  }
  const got = await figma<{ name: string; nodes: Record<string, { document: FigmaNode } | null> }>(token, `${API}/files/${key}/nodes?ids=${encodeURIComponent(ids.join(","))}`);
  name ||= got.name;
  const docs = ids.map((i) => got.nodes[i]?.document).filter((d): d is FigmaNode => Boolean(d));
  if (!docs.length) throw new Error("That frame isn't in the file any more.");
  // A link to a page brings its frames; a link to a frame (or anything in one), that.
  const frames = (node ? framesOf({ id: "root", name: "", type: "DOCUMENT", children: docs }, node) : docs).slice(0, MAX_FRAMES);
  if (!frames.length) throw new Error("There are no frames there to bring in.");
  const warnings = new Set<string>();
  if (more) warnings.add(`The page has ${MAX_FRAMES + more} frames: the first ${MAX_FRAMES} came in. Link to a frame to bring in another.`);
  progress(0.3, "Fetching pictures and icons");
  const refs = new Set<string>();
  for (const f of frames) imageRefs(f, refs);
  const [images, svgs] = await Promise.all([
    fetchImages(token, key, refs).catch((e) => (warnings.add(`Pictures: ${(e as Error).message}`), {} as Record<string, string>)),
    fetchSvgs(token, key, frames.flatMap((f) => svgNodes(f))).catch((e) => (warnings.add(`Icons: ${(e as Error).message}`), {} as Record<string, string>)),
  ]);
  progress(0.85, "Making the layers");
  const ctx: Ctx = { images, svgs, warnings };
  const id = boardId || createBoard(name || "Figma import", by).id;
  const board = getBoard(id);
  const pid = opts.page && board.pages.some((p) => p.id === opts.page) ? opts.page : board.pages[0].id;
  // The frames keep their places relative to each other, beside what's on the page already.
  const x0 = Math.min(...frames.map((f) => f.absoluteBoundingBox!.x));
  const y0 = Math.min(...frames.map((f) => f.absoluteBoundingBox!.y));
  const spot = freeSpot(board, pid, 0);
  const ops: Op[] = [];
  const artboards: { id: string; name: string }[] = [];
  let layers = 0;
  for (const f of frames) {
    const made = htmlToNodes(nodeHtml(f, null, ctx), { wholeSvg: true });
    for (const w of made.warnings) warnings.add(w);
    const root = made.roots[0];
    if (!root) continue;
    const s = made.nodes[root].style;
    delete s.position;
    s.left = px(spot.left + f.absoluteBoundingBox!.x - x0);
    s.top = px(spot.top + f.absoluteBoundingBox!.y - y0);
    for (const r of made.roots) made.nodes[r].parent = null;
    ops.push({ op: "add", nodes: made.nodes, ids: [root], parent: null, page: pid });
    artboards.push({ id: root, name: made.nodes[root].name });
    layers += Object.keys(made.nodes).length;
  }
  changeBoard(id, ops, by);
  progress(1, "Done");
  return { board: id, name, artboards, layers, pictures: Object.keys(images).length, warnings: [...warnings].slice(0, 12) };
}
