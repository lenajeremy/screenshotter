/**
 * Figma's nodes (from a .fig file or the clipboard) as board layers: HTML with inline styles that
 * the board reads like any other. Auto layout becomes flex; components are expanded with their
 * overrides; shapes and icons become SVG from the geometry Figma stores; paints, strokes, effects,
 * corners, clipping and text keep Figma's values.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { libraryFolder } from "../util/files.js";
import type { FigArchive } from "./fig-file.js";
import { ellipseOutline, lineOutline, networkOutline, rectOutline, starOutline, type Outline } from "./fig-geometry.js";
import { pathKit, type SkPath } from "./pathkit.js";

type G = { sessionID: number; localID: number };
type M = { m00: number; m01: number; m02: number; m10: number; m11: number; m12: number };
type Color = { r: number; g: number; b: number; a: number };
// Figma's nodes are loosely typed: these are the fields read here.
export type FNode = Record<string, any> & { id: string; key: string; type: string; children: FNode[] };

const gid = (g?: G | null) => (g ? `${g.sessionID}:${g.localID}` : "");
const ID: M = { m00: 1, m01: 0, m02: 0, m10: 0, m11: 1, m12: 0 };
const cmp = (a = "", b = "") => (a < b ? -1 : a > b ? 1 : 0);

// ---------------------------------------------------------------------------------------------
// The document: nodes by id, with their children in order

export interface FigDoc {
  byId: Map<string, FNode>;
  /** Shared styles by their key: what the clipboard points to them by. */
  styles: Map<string, FNode>;
  pages: FNode[];
  blob(i: number): Buffer | undefined;
  images: Map<string, Buffer>;
  name?: string;
}

export function figDoc(a: FigArchive): FigDoc {
  const byId = new Map<string, FNode>();
  const styles = new Map<string, FNode>();
  for (const raw of a.message.nodeChanges) {
    if (!raw.guid) continue;
    const node: FNode = { ...raw, id: gid(raw.guid), key: gid(raw.overrideKey ?? raw.guid), assetKey: raw.key, children: [] };
    byId.set(gid(raw.guid), node);
    if (raw.styleType && typeof raw.key === "string") styles.set(raw.key, node);
  }
  for (const n of byId.values()) {
    const p = n.parentIndex ? byId.get(gid(n.parentIndex.guid)) : undefined;
    if (p) p.children.push(n);
  }
  for (const n of byId.values()) n.children.sort((x, y) => cmp(x.parentIndex?.position, y.parentIndex?.position));
  const doc = [...byId.values()].find((n) => n.type === "DOCUMENT");
  const pages = (doc?.children ?? []).filter((c) => c.type === "CANVAS" && !c.internalOnly);
  const blobs = a.message.blobs ?? [];
  return { byId, styles, pages, blob: (i) => (blobs[i] ? Buffer.from(blobs[i].bytes) : undefined), images: a.images, name: a.name };
}

/** What was copied: the nodes whose parents aren't in the copy (or are a page). */
export function copiedRoots(d: FigDoc): FNode[] {
  return [...d.byId.values()]
    .filter((n) => {
      if (["DOCUMENT", "CANVAS"].includes(n.type)) return false;
      const p = n.parentIndex ? d.byId.get(gid(n.parentIndex.guid)) : undefined;
      return !p || (p.type === "CANVAS" && !p.internalOnly);
    })
    .sort((x, y) => cmp(x.parentIndex?.position, y.parentIndex?.position));
}

// ---------------------------------------------------------------------------------------------
// Components: an instance is its component's layers, with the instance's overrides

type Ov = { path: string[]; props: Record<string, any> };
const SKIP_FROM_SYMBOL = new Set(["guid", "id", "key", "parentIndex", "transform", "name", "children", "type", "symbolData", "derivedSymbolData", "overrideKey", "phase", "isPublishable", "componentKey", "sharedSymbolReference", "publishID", "symbolDescription", "componentPropDefs", "variantPropSpecs", "sortPosition", "version"]);
const ovProps = (o: Record<string, any>) => {
  const { guidPath: _g, ...rest } = o;
  return rest;
};

/** An override on a node: a style chosen in it replaces the paints (or type) the component had. */
function overrideWith(n: FNode, props: Record<string, any>) {
  if (props.styleIdForFill && !props.fillPaints) delete n.fillPaints;
  if (props.styleIdForStrokeFill && !props.strokePaints) delete n.strokePaints;
  Object.assign(n, props);
}

/** A copy of `n` with its instances expanded: the component's layers, overridden as the instance says. */
export function resolveTree(d: FigDoc, n: FNode, scope: Ov[] = [], prefix = "", depth = 0): FNode {
  const out: FNode = { ...n, id: prefix + n.id, children: [] };
  for (const o of scope) if (o.path.length === 1 && o.path[0] === n.key) overrideWith(out, o.props);
  if (out.type === "INSTANCE" && depth < 24) {
    const symId = gid(out.overriddenSymbolID ?? out.symbolData?.symbolID);
    const sym = d.byId.get(symId);
    // Overrides from instances around this one reach inside it by paths that start with it.
    const down = scope.filter((o) => o.path.length > 1 && o.path[0] === n.key).map((o) => ({ path: o.path.slice(1), props: o.props }));
    const own = [...(out.symbolData?.symbolOverrides ?? []), ...(out.derivedSymbolData ?? [])].map((o: any) => ({ path: (o.guidPath?.guids ?? []).map(gid), props: ovProps(o) }));
    const inner = [...own, ...down];
    if (sym) {
      const base: Record<string, any> = {};
      for (const [k, v] of Object.entries(sym)) if (!SKIP_FROM_SYMBOL.has(k)) base[k] = v;
      const mine: Record<string, any> = {};
      for (const [k, v] of Object.entries(out)) if (v !== undefined && k !== "children") mine[k] = v;
      Object.assign(out, base, mine);
      for (const o of inner) if (o.path.length === 1 && o.path[0] === sym.key) overrideWith(out, o.props);
      out.children = sym.children.map((c) => resolveTree(d, c, inner, `${out.id}/`, depth + 1));
      return out;
    }
  }
  out.children = n.children.map((c) => resolveTree(d, c, scope, prefix, depth + 1));
  return out;
}

// ---------------------------------------------------------------------------------------------
// Paint, geometry and text helpers

export interface Ctx {
  d: FigDoc;
  warnings: Set<string>;
  /** Font family → the weights and styles used ("400", "700i"). */
  fonts: Map<string, Set<string>>;
  /** Picture hash → file in the library. */
  pictures: Map<string, string>;
  uid: number;
}

const px = (n: number) => `${Math.round(n * 100) / 100}px`;
const num = (n: number) => String(Math.round(n * 1000) / 1000);
const byte = (v: number) => Math.max(0, Math.min(255, Math.round(v * 255)));
function rgba(c: Color | undefined, opacity = 1): string {
  if (!c) return "transparent";
  const a = Math.round((c.a ?? 1) * opacity * 1000) / 1000;
  return a >= 1 ? `rgb(${byte(c.r)}, ${byte(c.g)}, ${byte(c.b)})` : `rgba(${byte(c.r)}, ${byte(c.g)}, ${byte(c.b)}, ${a})`;
}
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const attr = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
const shown = (xs: any[] | undefined): any[] => (xs ?? []).filter((x) => x && x.visible !== false);
const css = (o: Record<string, string | undefined>) =>
  Object.entries(o)
    .filter(([, v]) => v !== undefined && v !== "")
    .map(([k, v]) => `${k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}:${String(v).replace(/"/g, "'")}`)
    .join(";");

/** A shared style a node points to: by its id in this file, or by its key (as the clipboard does). */
function styleNode(c: Ctx, ref: any): FNode | undefined {
  if (!ref) return undefined;
  const byId = ref.guid ? c.d.byId.get(gid(ref.guid)) : undefined;
  if (byId) return byId;
  const key = ref.assetRef?.key;
  return typeof key === "string" ? c.d.styles.get(key) : undefined;
}

/** A node's paints: its shared style's when it uses one this file holds, else its own. */
function paints(c: Ctx, n: FNode, which: "fill" | "stroke"): any[] {
  const ref = which === "fill" ? n.styleIdForFill : n.styleIdForStrokeFill;
  const style = styleNode(c, ref);
  // A colour style is a node whose fill is the style (a stroke style keeps it there too).
  const fromStyle = style?.fillPaints;
  if (fromStyle) return fromStyle;
  return (which === "fill" ? n.fillPaints : n.strokePaints) ?? [];
}

/** A 2×3 matrix's inverse. */
function invert(t: M): M {
  const det = t.m00 * t.m11 - t.m01 * t.m10 || 1e-9;
  return { m00: t.m11 / det, m01: -t.m01 / det, m02: (t.m01 * t.m12 - t.m11 * t.m02) / det, m10: -t.m10 / det, m11: t.m00 / det, m12: (t.m10 * t.m02 - t.m00 * t.m12) / det };
}
const apply = (t: M, x: number, y: number) => ({ x: t.m00 * x + t.m01 * y + t.m02, y: t.m10 * x + t.m11 * y + t.m12 });

/** A gradient's line (or ellipse) in the node's own pixels: Figma's paint transform maps the node to the gradient's unit square. */
function gradientGeometry(p: any, w: number, h: number) {
  const inv = invert(p.transform ?? ID);
  const at = (x: number, y: number) => {
    const q = apply(inv, x, y);
    return { x: q.x * w, y: q.y * h };
  };
  return { start: at(0, 0.5), end: at(1, 0.5), center: at(0.5, 0.5), rx: at(1, 0.5), ry: at(0.5, 1) };
}

function stopsCss(p: any, map: (t: number) => number = (t) => t) {
  return (p.stops ?? []).map((s: any) => `${rgba(s.color, p.opacity ?? 1)} ${Math.round(map(s.position) * 10000) / 100}%`).join(", ");
}

/** A gradient as CSS for a w×h box, the same line and stops as Figma's. */
function gradientCss(p: any, w: number, h: number): string | undefined {
  if (!p.stops?.length) return undefined;
  const g = gradientGeometry(p, w, h);
  if (p.type === "GRADIENT_LINEAR") {
    const dx = g.end.x - g.start.x;
    const dy = g.end.y - g.start.y;
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len;
    const uy = dy / len;
    // CSS's line runs through the centre, as long as the box projects onto it.
    const L = Math.abs(w * ux) + Math.abs(h * uy) || 1;
    const sx = w / 2 - (ux * L) / 2;
    const sy = h / 2 - (uy * L) / 2;
    const map = (t: number) => ((g.start.x + t * dx - sx) * ux + (g.start.y + t * dy - sy) * uy) / L;
    const deg = Math.round(((Math.atan2(uy, ux) * 180) / Math.PI + 90) * 100) / 100;
    return `linear-gradient(${deg}deg, ${stopsCss(p, map)})`;
  }
  const rx = Math.hypot(g.rx.x - g.center.x, g.rx.y - g.center.y);
  const ry = Math.hypot(g.ry.x - g.center.x, g.ry.y - g.center.y);
  if (p.type === "GRADIENT_ANGULAR") {
    const from = Math.round(((Math.atan2(g.rx.y - g.center.y, g.rx.x - g.center.x) * 180) / Math.PI + 90) * 100) / 100;
    return `conic-gradient(from ${from}deg at ${px(g.center.x)} ${px(g.center.y)}, ${stopsCss(p)})`;
  }
  return `radial-gradient(${px(rx)} ${px(ry)} at ${px(g.center.x)} ${px(g.center.y)}, ${stopsCss(p)})`;
}

const MIME: Array<[number[], string]> = [
  [[0x89, 0x50, 0x4e, 0x47], ".png"],
  [[0xff, 0xd8, 0xff], ".jpg"],
  [[0x47, 0x49, 0x46], ".gif"],
  [[0x52, 0x49, 0x46, 0x46], ".webp"],
];
/** A picture the file holds, saved into the library (once). */
function picture(c: Ctx, hash: Uint8Array | string | undefined): string | undefined {
  const hex = typeof hash === "string" ? hash : hash ? Buffer.from(hash).toString("hex") : "";
  if (!hex) return undefined;
  const have = c.pictures.get(hex);
  if (have) return have;
  const data = c.d.images.get(hex);
  if (!data) {
    c.warnings.add("Some pictures didn't come: copying from Figma doesn't carry them. Drop the .fig file instead (File › Save local copy), or add a Figma token in Settings so pastes can fetch them.");
    return undefined;
  }
  const ext = MIME.find(([sig]) => sig.every((b, i) => data[i] === b))?.[1] ?? ".png";
  const dir = path.join(libraryFolder(), "images", "figma");
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${hex.slice(0, 20)}${ext}`);
  if (!existsSync(file)) writeFileSync(file, data);
  c.pictures.set(hex, file);
  return file;
}

/** Fills as CSS backgrounds: the bottom solid as the colour, the rest as layers on top. */
function fillCss(c: Ctx, list: any[], w: number, h: number, out: Record<string, string>) {
  const layers: string[] = [];
  const sizes: string[] = [];
  const places: string[] = [];
  const repeats: string[] = [];
  const blends: string[] = [];
  let colour: string | undefined;
  const fills = shown(list);
  for (let i = fills.length - 1; i >= 0; i--) {
    const p = fills[i];
    const before = layers.length;
    paintLayer(p, i);
    // Each layer blends into what's under it as the paint says (a green multiplied over a photo).
    if (layers.length > before) blends.push(BLEND[p.blendMode] ?? "normal");
  }
  function paintLayer(p: any, i: number) {
    if (p.type === "SOLID") {
      if (i === 0 && !layers.length) colour = rgba(p.color, p.opacity ?? 1);
      else {
        const col = rgba(p.color, p.opacity ?? 1);
        layers.push(`linear-gradient(${col}, ${col})`);
        sizes.push("auto");
        places.push("0 0");
        repeats.push("no-repeat");
      }
    } else if (p.type === "IMAGE") {
      const file = picture(c, p.image?.hash);
      if (!file) return;
      layers.push(`url("${file}")`);
      const mode = p.imageScaleMode ?? "FILL";
      const t: M = p.transform ?? ID;
      if (mode === "STRETCH" && p.transform) {
        // A crop: the paint transform says which part of the picture shows.
        const sx = 1 / (t.m00 || 1);
        const sy = 1 / (t.m11 || 1);
        sizes.push(`${px(sx * w)} ${px(sy * h)}`);
        places.push(`${px(-t.m02 * sx * w)} ${px(-t.m12 * sy * h)}`);
        repeats.push("no-repeat");
      } else if (mode === "TILE") {
        const s = p.scale ?? 1;
        sizes.push(p.originalImageWidth ? `${px(p.originalImageWidth * s)} auto` : "auto");
        places.push("0 0");
        repeats.push("repeat");
      } else {
        sizes.push(mode === "FIT" ? "contain" : "cover");
        places.push("center");
        repeats.push("no-repeat");
      }
    } else if (p.type?.startsWith("GRADIENT")) {
      const g = gradientCss(p, w, h);
      if (g) {
        layers.push(g);
        sizes.push("auto");
        places.push("0 0");
        repeats.push("no-repeat");
      }
    }
  }
  if (colour) out.backgroundColor = colour;
  if (layers.length) {
    out.backgroundImage = layers.join(", ");
    out.backgroundSize = sizes.join(", ");
    out.backgroundPosition = places.join(", ");
    out.backgroundRepeat = repeats.join(", ");
    if (blends.some((b) => b !== "normal")) out.backgroundBlendMode = blends.join(", ");
  }
}

const BLEND: Record<string, string> = {
  MULTIPLY: "multiply", SCREEN: "screen", OVERLAY: "overlay", DARKEN: "darken", LIGHTEN: "lighten", COLOR_DODGE: "color-dodge", COLOR_BURN: "color-burn",
  HARD_LIGHT: "hard-light", SOFT_LIGHT: "soft-light", DIFFERENCE: "difference", EXCLUSION: "exclusion", HUE: "hue", SATURATION: "saturation", COLOR: "color", LUMINOSITY: "luminosity",
};

/** Shadows (strokes inside or outside, drop and inner shadows), blurs, corners, opacity, blend. */
function lookCss(c: Ctx, n: FNode, out: Record<string, string>, text = false) {
  const shadows: string[] = [];
  // Strokes, drawn as shadows so they take no room, as in Figma.
  const sp = shown(paints(c, n, "stroke")).filter((p) => p.type === "SOLID");
  const sw = n.strokeWeight ?? 0;
  if (!text && sp.length && (sw > 0 || n.borderStrokeWeightsIndependent)) {
    const col = rgba(sp[sp.length - 1].color, sp[sp.length - 1].opacity ?? 1);
    if (n.dashPattern?.length) out.outline = `${px(sw)} dashed ${col}`;
    else if (n.borderStrokeWeightsIndependent) {
      const t = n.borderTopWeight ?? 0;
      const r = n.borderRightWeight ?? 0;
      const b = n.borderBottomWeight ?? 0;
      const l = n.borderLeftWeight ?? 0;
      if (t) shadows.push(`inset 0 ${px(t)} 0 0 ${col}`);
      if (b) shadows.push(`inset 0 ${px(-b)} 0 0 ${col}`);
      if (l) shadows.push(`inset ${px(l)} 0 0 0 ${col}`);
      if (r) shadows.push(`inset ${px(-r)} 0 0 0 ${col}`);
    } else if (n.strokeAlign === "OUTSIDE") shadows.push(`0 0 0 ${px(sw)} ${col}`);
    else if (n.strokeAlign === "CENTER") shadows.push(`inset 0 0 0 ${px(sw / 2)} ${col}`, `0 0 0 ${px(sw / 2)} ${col}`);
    else shadows.push(`inset 0 0 0 ${px(sw)} ${col}`);
  }
  const fx: any[] = shown((styleNode(c, n.styleIdForEffect)?.effects ?? n.effects) as any[]);
  for (const e of [...fx].reverse()) {
    if (e.type === "DROP_SHADOW" || e.type === "INNER_SHADOW") {
      const s = `${e.type === "INNER_SHADOW" ? "inset " : ""}${px(e.offset?.x ?? 0)} ${px(e.offset?.y ?? 0)} ${px(e.radius ?? 0)}${text ? "" : ` ${px(e.spread ?? 0)}`} ${rgba(e.color)}`;
      if (!(text && e.type === "INNER_SHADOW")) shadows.push(s);
    } else if (e.type === "FOREGROUND_BLUR") out.filter = `blur(${px((e.radius ?? 0) / 2)})`;
    else if (e.type === "BACKGROUND_BLUR") out.backdropFilter = `blur(${px((e.radius ?? 0) / 2)})`;
  }
  if (shadows.length) out[text ? "textShadow" : "boxShadow"] = shadows.join(", ");
  if (!text) {
    if (n.rectangleCornerRadiiIndependent) {
      const r = [n.rectangleTopLeftCornerRadius, n.rectangleTopRightCornerRadius, n.rectangleBottomRightCornerRadius, n.rectangleBottomLeftCornerRadius].map((v) => v ?? 0);
      if (r.some((v) => v)) out.borderRadius = r.map(px).join(" ");
    } else if (n.cornerRadius) out.borderRadius = px(n.cornerRadius);
  }
  if (n.opacity !== undefined && n.opacity < 1) out.opacity = num(n.opacity);
  if (n.blendMode && BLEND[n.blendMode]) out.mixBlendMode = BLEND[n.blendMode];
}

/** Figma's stored path commands (0 close, 1 move, 2 line, 3 quadratic, 4 cubic; float32 points) as SVG. */
function pathData(buf: Buffer | undefined): string {
  if (!buf) return "";
  const out: string[] = [];
  let p = 0;
  const f = () => {
    const v = buf.readFloatLE(p);
    p += 4;
    return num(v);
  };
  try {
    while (p < buf.length) {
      const c = buf[p++];
      if (c === 0) out.push("Z");
      else if (c === 1) out.push(`M${f()} ${f()}`);
      else if (c === 2) out.push(`L${f()} ${f()}`);
      else if (c === 3) out.push(`Q${f()} ${f()} ${f()} ${f()}`);
      else if (c === 4) out.push(`C${f()} ${f()} ${f()} ${f()} ${f()} ${f()}`);
      else break;
    }
  } catch {
    // A path cut short: what was read.
  }
  return out.join("");
}

/** SVG for a paint: a colour, or a gradient defined in `defs`. */
function svgPaint(c: Ctx, p: any, w: number, h: number, defs: string[]): { fill: string; opacity?: number } | null {
  if (p.type === "SOLID") return { fill: rgba({ ...p.color, a: 1 }), opacity: (p.color?.a ?? 1) * (p.opacity ?? 1) };
  if (p.type?.startsWith("GRADIENT") && p.stops?.length) {
    const id = `g${c.uid++}`;
    const g = gradientGeometry(p, w, h);
    const stops = p.stops.map((s: any) => `<stop offset="${num(s.position)}" stop-color="${rgba({ ...s.color, a: 1 })}" stop-opacity="${num((s.color?.a ?? 1) * (p.opacity ?? 1))}"/>`).join("");
    if (p.type === "GRADIENT_LINEAR") defs.push(`<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="${num(g.start.x)}" y1="${num(g.start.y)}" x2="${num(g.end.x)}" y2="${num(g.end.y)}">${stops}</linearGradient>`);
    else {
      const t = invert(p.transform ?? ID);
      // The unit circle around (0.5, 0.5), carried into the node's pixels.
      defs.push(`<radialGradient id="${id}" gradientUnits="userSpaceOnUse" cx="0.5" cy="0.5" r="0.5" gradientTransform="matrix(${num(t.m00 * w)} ${num(t.m10 * h)} ${num(t.m01 * w)} ${num(t.m11 * h)} ${num(t.m02 * w)} ${num(t.m12 * h)})">${stops}</radialGradient>`);
    }
    return { fill: `url(#${id})` };
  }
  return null;
}

// Figma's outlines: the ones it stored (a .fig file has them), or rebuilt from the shape's settings
// when it didn't (the clipboard leaves them out). See fig-geometry.

const rebuilt = new WeakMap<object, Outline | null>();
/** A shape's outline from its settings (its vector network, its corners, its arc, its points). */
function outline(c: Ctx, n: FNode): Outline | null {
  if (rebuilt.has(n)) return rebuilt.get(n)!;
  const w = n.size?.x ?? 0;
  const h = n.size?.y ?? 0;
  let o: Outline | null = null;
  const vd = n.vectorData;
  if (vd?.vectorNetworkBlob !== undefined) {
    const buf = c.d.blob(vd.vectorNetworkBlob);
    const table = new Map<number, any>((vd.styleOverrideTable ?? []).map((t: any) => [t.styleID, t]));
    if (buf) o = networkOutline(buf, vd.normalizedSize, { x: w, y: h }, (sid) => table.get(sid)?.cornerRadius ?? n.cornerRadius ?? 0);
  } else if (n.type === "ROUNDED_RECTANGLE" || n.type === "RECTANGLE" || BOXES.has(n.type)) {
    const r = n.cornerRadius ?? 0;
    o = rectOutline(w, h, n.rectangleCornerRadiiIndependent ? [n.rectangleTopLeftCornerRadius ?? 0, n.rectangleTopRightCornerRadius ?? 0, n.rectangleBottomRightCornerRadius ?? 0, n.rectangleBottomLeftCornerRadius ?? 0] : [r, r, r, r]);
  } else if (n.type === "BOOLEAN_OPERATION") o = joinedOutline(c, n);
  else if (n.type === "ELLIPSE") o = ellipseOutline(w, h, n.arcData);
  else if (n.type === "STAR") o = starOutline(w, h, n.count ?? 5, n.starInnerScale ?? 0.382, n.cornerRadius ?? 0);
  else if (n.type === "REGULAR_POLYGON") o = starOutline(w, h, n.count ?? 3, null, n.cornerRadius ?? 0);
  else if (n.type === "LINE") o = lineOutline(w);
  rebuilt.set(n, o);
  return o;
}

const stored = (n: FNode) => Boolean((n.fillGeometry ?? []).length || (n.strokeGeometry ?? []).length);

const SKIA_OPS = { UNION: "UNION", SUBTRACT: "DIFFERENCE", INTERSECT: "INTERSECT", XOR: "XOR", EXCLUDE: "XOR" } as const;
/**
 * A boolean shape's one outline, its parts joined by Skia's path operations (as Figma joins them):
 * the first part, then each next one added, taken away, kept where they meet, or kept where they
 * don't. Null without PathKit, or when a part can't be read.
 */
function joinedOutline(c: Ctx, n: FNode): Outline | null {
  const PK = pathKit();
  if (!PK) return null;
  const made = new Set<SkPath>();
  const keep = (p: SkPath | null) => (p && made.add(p), p);
  try {
    const part = (k: FNode): SkPath | null => {
      let p: SkPath | null = null;
      for (const f of fillPaths(c, k)) {
        const q = keep(PK.FromSVGString(f.d));
        if (!q) return null;
        q.setFillType(f.rule === "ODD" || f.rule === "EVENODD" ? PK.FillType.EVENODD : PK.FillType.WINDING);
        p = p ? keep(PK.MakeFromOp(p, q, PK.PathOp.UNION)) : q;
        if (!p) return null;
      }
      if (!p) return null;
      const t: M = k.transform ?? ID;
      p.transform(t.m00, t.m01, t.m02, t.m10, t.m11, t.m12, 0, 0, 1);
      return p;
    };
    const op = PK.PathOp[SKIA_OPS[(n.booleanOperation ?? "UNION") as keyof typeof SKIA_OPS] ?? "UNION"];
    let acc: SkPath | null = null;
    for (const k of n.children) {
      // A part that draws nothing (hidden, or a line with no area) takes no part in the join.
      if (k.visible === false || !fillPaths(c, k).length) continue;
      const p = part(k);
      if (!p) return null;
      acc = acc ? keep(PK.MakeFromOp(acc, p, op)) : p;
      if (!acc) return null;
    }
    if (!acc) return null;
    const d = acc.toSVGString();
    const rule = /even/i.test(acc.getFillTypeString()) ? "ODD" : "NONZERO";
    return { fills: d ? [{ d, rule }] : [], stroke: d, closed: true, ends: [] };
  } catch {
    return null;
  } finally {
    for (const p of made) p.delete();
  }
}

/** A boolean shape Figma didn't store an outline for, and PathKit couldn't join: drawn from its parts (see booleanPaths). */
const composed = (c: Ctx, n: FNode) => n.type === "BOOLEAN_OPERATION" && !stored(n) && !outline(c, n);

/** The areas a shape fills, with their winding rules (and a vector region's own style). */
function fillPaths(c: Ctx, n: FNode): Array<{ d: string; rule: string; styleID?: number }> {
  if (stored(n)) return (n.fillGeometry ?? []).map((g: any) => ({ d: pathData(c.d.blob(g.commandsBlob)), rule: g.windingRule ?? "NONZERO" })).filter((g: { d: string }) => g.d);
  return (outline(c, n)?.fills ?? []).filter((f) => f.d);
}
const ruleAttr = (rule?: string) => (rule === "ODD" || rule === "EVENODD" ? ' fill-rule="evenodd"' : "");

/** Whether a shape's stroke goes all round it (so inside and outside mean something), or has ends. */
function closedShape(c: Ctx, n: FNode): boolean {
  if (n.type === "LINE") return false;
  if (stored(n)) return (n.fillGeometry ?? []).length > 0;
  return outline(c, n)?.closed ?? false;
}

const CAPS: Record<string, string> = { NONE: "butt", ROUND: "round", SQUARE: "square" };
const JOINS: Record<string, string> = { MITER: "miter", ROUND: "round", BEVEL: "bevel" };

/** A cap Figma draws itself at a line's end (an arrow, a dot), in the stroke's paint. */
function capShape(cap: string, at: { x: number; y: number }, dir: { x: number; y: number }, w: number, paint: string): string {
  const rot = (v: { x: number; y: number }, a: number) => ({ x: v.x * Math.cos(a) - v.y * Math.sin(a), y: v.x * Math.sin(a) + v.y * Math.cos(a) });
  const pt = (v: { x: number; y: number }) => `${num(v.x)} ${num(v.y)}`;
  const back = { x: -dir.x, y: -dir.y };
  const perp = { x: -dir.y, y: dir.x };
  const go = (k: number, v: { x: number; y: number }) => ({ x: at.x + v.x * k, y: at.y + v.y * k });
  switch (cap) {
    case "ROUND":
      return `<circle cx="${num(at.x)}" cy="${num(at.y)}" r="${num(w / 2)}" fill="${paint}"/>`;
    case "SQUARE": {
      const a = go(w / 2, perp);
      const b = go(-w / 2, perp);
      return `<path d="M${pt(a)}L${pt({ x: a.x + (dir.x * w) / 2, y: a.y + (dir.y * w) / 2 })}L${pt({ x: b.x + (dir.x * w) / 2, y: b.y + (dir.y * w) / 2 })}L${pt(b)}Z" fill="${paint}"/>`;
    }
    case "ARROW_LINES": {
      // Two arms back from the tip at 45°, 4.5 strokes long, with round ends (as Figma draws them).
      const a1 = go(4.5 * w, rot(back, Math.PI / 4));
      const a2 = go(4.5 * w, rot(back, -Math.PI / 4));
      return `<path d="M${pt(a1)}L${pt(at)}L${pt(a2)}" fill="none" stroke="${paint}" stroke-width="${num(w)}" stroke-linecap="round" stroke-linejoin="round"/>`;
    }
    case "ARROW_EQUILATERAL":
    case "TRIANGLE_FILLED": {
      const tip = go(1.5 * w, dir);
      const a = go(1.75 * w, perp);
      const b = go(-1.75 * w, perp);
      return `<path d="M${pt(tip)}L${pt({ x: a.x - dir.x * 1.5 * w, y: a.y - dir.y * 1.5 * w })}L${pt({ x: b.x - dir.x * 1.5 * w, y: b.y - dir.y * 1.5 * w })}Z" fill="${paint}"/>`;
    }
    case "DIAMOND_FILLED": {
      const k = 1.5 * w;
      return `<path d="M${pt(go(k, dir))}L${pt(go(k, perp))}L${pt(go(-k, dir))}L${pt(go(-k, perp))}Z" fill="${paint}"/>`;
    }
    case "CIRCLE_FILLED":
      return `<circle cx="${num(at.x)}" cy="${num(at.y)}" r="${num(1.5 * w)}" fill="${paint}"/>`;
    default:
      return "";
  }
}

/** A mask (in defs) showing what `content` paints white, over the whole plane. */
function maskOf(c: Ctx, defs: string[], content: string): string {
  const id = `k${c.uid++}`;
  defs.push(`<mask id="${id}" maskUnits="userSpaceOnUse" x="-100000" y="-100000" width="200000" height="200000">${content}</mask>`);
  return id;
}
const PLANE = `<rect x="-100000" y="-100000" width="200000" height="200000" fill="white"/>`;
const placed = (k: FNode, inner: string) => {
  const t: M = k.transform ?? ID;
  return `<g transform="matrix(${num(t.m00)} ${num(t.m10)} ${num(t.m01)} ${num(t.m11)} ${num(t.m02)} ${num(t.m12)})">${inner}</g>`;
};

/** A part's area painted in one colour, placed in its boolean (for masks). */
function partArea(c: Ctx, k: FNode, colour: string, defs: string[]): string {
  if (k.visible === false) return "";
  if (composed(c, k)) return placed(k, `<g mask="url(#${booleanArea(c, k, defs)})"><rect x="-100000" y="-100000" width="200000" height="200000" fill="${colour}"/></g>`);
  return placed(k, fillPaths(c, k).map((f) => `<path d="${f.d}"${ruleAttr(f.rule)} fill="${colour}"/>`).join(""));
}

/** A boolean shape's area, as a mask (union, subtract, intersect or exclude of its parts). */
function booleanArea(c: Ctx, n: FNode, defs: string[]): string {
  const parts = n.children.filter((k) => k.visible !== false);
  if (!parts.length) return maskOf(c, defs, "");
  const op = n.booleanOperation ?? "UNION";
  if (op === "UNION") return maskOf(c, defs, parts.map((k) => partArea(c, k, "white", defs)).join(""));
  if (op === "SUBTRACT") return maskOf(c, defs, partArea(c, parts[0], "white", defs) + parts.slice(1).map((k) => partArea(c, k, "black", defs)).join(""));
  let acc = maskOf(c, defs, partArea(c, parts[0], "white", defs));
  for (const k of parts.slice(1)) {
    const kArea = maskOf(c, defs, partArea(c, k, "white", defs));
    if (op === "INTERSECT") acc = maskOf(c, defs, `<g mask="url(#${kArea})"><g mask="url(#${acc})">${PLANE}</g></g>`);
    else {
      // Exclude: in one or the other, not both.
      const notK = maskOf(c, defs, PLANE + partArea(c, k, "black", defs));
      const notAcc = maskOf(c, defs, `${PLANE}<g mask="url(#${acc})"><rect x="-100000" y="-100000" width="200000" height="200000" fill="black"/></g>`);
      acc = maskOf(c, defs, `<g mask="url(#${notK})"><g mask="url(#${acc})">${PLANE}</g></g><g mask="url(#${notAcc})">${partArea(c, k, "white", defs)}</g>`);
    }
  }
  return acc;
}

/**
 * The edge of a boolean shape, `width` wide and white (for a mask): each part's own edge, kept only
 * where it's the edge of the whole (a union's parts' edges outside the others, and so on).
 */
function booleanEdge(c: Ctx, n: FNode, width: number, defs: string[]): string {
  const parts = n.children.filter((k) => k.visible !== false);
  const op = n.booleanOperation ?? "UNION";
  return parts
    .map((k, i) => {
      const own = composed(c, k) ? booleanEdge(c, k, width, defs) : `<path d="${outline(c, k)?.stroke ?? fillPaths(c, k).map((f) => f.d).join("")}" fill="none" stroke="white" stroke-width="${num(width)}" stroke-linejoin="${JOINS[n.strokeJoin] ?? "miter"}" stroke-miterlimit="4"/>`;
      const edge = placed(k, own);
      const others = parts.filter((_, j) => j !== i);
      if (op === "XOR" || op === "EXCLUDE" || !others.length) return edge;
      let keep: string;
      if (op === "UNION") keep = maskOf(c, defs, PLANE + others.map((o) => partArea(c, o, "black", defs)).join(""));
      else if (op === "SUBTRACT")
        keep = i === 0 ? maskOf(c, defs, PLANE + others.map((o) => partArea(c, o, "black", defs)).join("")) : maskOf(c, defs, partArea(c, parts[0], "white", defs) + others.slice(1).map((o) => partArea(c, o, "black", defs)).join(""));
      else keep = others.reduce((m, o) => maskOf(c, defs, `<g mask="url(#${m})">${partArea(c, o, "white", defs)}</g>`), maskOf(c, defs, PLANE));
      return `<g mask="url(#${keep})">${edge}</g>`;
    })
    .join("");
}

/** A boolean shape Figma didn't store: its fills over its area, its strokes along its edge. */
function booleanPaths(c: Ctx, n: FNode, defs: string[]): string {
  const w = n.size?.x ?? 0;
  const h = n.size?.y ?? 0;
  const area = booleanArea(c, n, defs);
  const box = (paint: string, opacity: number | undefined, mask: string) => `<rect x="-2" y="-2" width="${num(w + 4)}" height="${num(h + 4)}" fill="${paint}"${opacity !== undefined && opacity < 1 ? ` fill-opacity="${num(opacity)}"` : ""} mask="url(#${mask})"/>`;
  const out: string[] = [];
  for (const p of shown(paints(c, n, "fill"))) {
    const sp = svgPaint(c, p, w, h, defs);
    if (sp) out.push(box(sp.fill, sp.opacity, area));
  }
  const sw = n.strokeWeight ?? 1;
  const strokes = shown(paints(c, n, "stroke"));
  if (strokes.length && sw > 0) {
    const align = n.strokeAlign ?? "CENTER";
    const edge = booleanEdge(c, n, align === "CENTER" ? sw : 2 * sw, defs);
    const along = align === "INSIDE" ? `<g mask="url(#${area})">${edge}</g>` : align === "OUTSIDE" ? `<g mask="url(#${maskOf(c, defs, `${PLANE}<g mask="url(#${area})"><rect x="-100000" y="-100000" width="200000" height="200000" fill="black"/></g>`)})">${edge}</g>` : edge;
    const strokeArea = maskOf(c, defs, along);
    const pad = 2 * sw + 2;
    for (const p of strokes) {
      const sp = svgPaint(c, p, w, h, defs);
      if (sp) out.push(`<rect x="${num(-pad)}" y="${num(-pad)}" width="${num(w + 2 * pad)}" height="${num(h + 2 * pad)}" fill="${sp.fill}"${sp.opacity !== undefined && sp.opacity < 1 ? ` fill-opacity="${num(sp.opacity)}"` : ""} mask="url(#${strokeArea})"/>`);
    }
  }
  return out.join("");
}

/** A shape's paths (its fills, then its strokes, as Figma draws them), in its own coordinates. */
function shapePaths(c: Ctx, n: FNode, defs: string[]): string {
  if (composed(c, n)) return booleanPaths(c, n, defs);
  const w = n.size?.x ?? 0;
  const h = n.size?.y ?? 0;
  const out: string[] = [];
  const fills = fillPaths(c, n);
  const own = paints(c, n, "fill");
  const regionStyles = new Map<number, any>((n.vectorData?.styleOverrideTable ?? []).map((t: any) => [t.styleID, t]));
  for (const f of fills) {
    const rs = f.styleID ? regionStyles.get(f.styleID) : undefined;
    const list = rs?.fillPaints ?? styleNode(c, rs?.styleIdForFill)?.fillPaints ?? own;
    for (const p of shown(list)) {
      const sp = svgPaint(c, p, w, h, defs);
      if (sp) out.push(`<path d="${f.d}" fill="${sp.fill}"${sp.opacity !== undefined && sp.opacity < 1 ? ` fill-opacity="${num(sp.opacity)}"` : ""}${ruleAttr(f.rule)}/>`);
    }
  }
  const sw = n.strokeWeight ?? 1;
  const strokes = shown(paints(c, n, "stroke"));
  if (!strokes.length || !(sw > 0)) return out.join("");
  // Inside and outside strokes are a centred band twice as wide, cut to the shape (as Figma draws them).
  const closed = closedShape(c, n);
  const align = closed ? n.strokeAlign ?? "CENTER" : "CENTER";
  const area = fills.map((f) => `<path d="${f.d}"${ruleAttr(f.rule)}/>`).join("");
  let wrap = (x: string) => x;
  if (align === "INSIDE" && area) {
    const id = `i${c.uid++}`;
    defs.push(`<clipPath id="${id}">${area}</clipPath>`);
    wrap = (x) => `<g clip-path="url(#${id})">${x}</g>`;
  } else if (align === "OUTSIDE" && area) {
    const id = maskOf(c, defs, PLANE + fills.map((f) => `<path d="${f.d}"${ruleAttr(f.rule)} fill="black"/>`).join(""));
    wrap = (x) => `<g mask="url(#${id})">${x}</g>`;
  }
  const o = stored(n) ? null : outline(c, n);
  for (const p of strokes) {
    const sp = svgPaint(c, p, w, h, defs);
    if (!sp) continue;
    const op = sp.opacity !== undefined && sp.opacity < 1 ? sp.opacity : undefined;
    if (!o) {
      // Figma's own outline of the stroke, filled.
      for (const g of n.strokeGeometry ?? []) {
        const d = pathData(c.d.blob(g.commandsBlob));
        if (d) out.push(wrap(`<path d="${d}" fill="${sp.fill}"${op !== undefined ? ` fill-opacity="${num(op)}"` : ""}/>`));
      }
      continue;
    }
    if (!o.stroke) continue;
    // Rebuilt: the line, stroked; caps each end's own (a vertex can have an arrow, the other end not).
    const table = new Map<number, any>((n.vectorData?.styleOverrideTable ?? []).map((t: any) => [t.styleID, t]));
    const capAt = (sid?: number) => (sid ? table.get(sid)?.strokeCap : undefined) ?? n.strokeCap ?? "NONE";
    const caps = o.ends.map((e) => capAt(e.styleID));
    const same = caps.length && caps.every((k) => k === caps[0] && CAPS[k]);
    const width = align === "CENTER" ? sw : 2 * sw;
    const dash = (n.dashPattern ?? []).length ? ` stroke-dasharray="${n.dashPattern.map(num).join(" ")}"` : "";
    const g = `<g${op !== undefined ? ` opacity="${num(op)}"` : ""}><path d="${o.stroke}" fill="none" stroke="${sp.fill}" stroke-width="${num(width)}" stroke-linecap="${same ? CAPS[caps[0]] : "butt"}" stroke-linejoin="${JOINS[n.strokeJoin] ?? "miter"}" stroke-miterlimit="4"${dash}/>${same ? "" : o.ends.map((e, i) => capShape(caps[i], e.at, e.dir, sw, sp.fill)).join("")}</g>`;
    out.push(wrap(g));
  }
  return out.join("");
}

const VECTORISH = new Set(["VECTOR", "STAR", "LINE", "REGULAR_POLYGON", "BOOLEAN_OPERATION"]);
const BOXES = new Set(["FRAME", "SYMBOL", "INSTANCE", "SECTION"]);
const hasImage = (c: Ctx, n: FNode) => shown(paints(c, n, "fill")).some((p) => p.type === "IMAGE");
const autoLayout = (n: FNode) => n.stackMode === "HORIZONTAL" || n.stackMode === "VERTICAL";

/** A group made only of shapes (an icon, a logo): drawn as one SVG. */
function onlyShapes(c: Ctx, n: FNode): boolean {
  const kids = n.children.filter((k) => k.visible !== false);
  if (!kids.length || autoLayout(n) || hasImage(c, n)) return false;
  return kids.every((k) => VECTORISH.has(k.type) || ((k.type === "ELLIPSE" || k.type === "ROUNDED_RECTANGLE" || k.type === "RECTANGLE") && !hasImage(c, k)) || (BOXES.has(k.type) && onlyShapes(c, k)));
}

/** A node (and what's in it) as SVG elements, placed by its transform. */
function svgNode(c: Ctx, n: FNode, defs: string[]): string {
  if (n.visible === false) return "";
  const t: M = n.transform ?? ID;
  const tf = `matrix(${num(t.m00)} ${num(t.m10)} ${num(t.m01)} ${num(t.m11)} ${num(t.m02)} ${num(t.m12)})`;
  const op = n.opacity !== undefined && n.opacity < 1 ? ` opacity="${num(n.opacity)}"` : "";
  let inner = shapePaths(c, n, defs);
  if (n.children.length && n.type !== "BOOLEAN_OPERATION") {
    // A mask hides what follows it (in the same group) outside its shape.
    const parts: string[] = [];
    let clip = "";
    for (const k of n.children) {
      if (k.mask) {
        const id = `m${c.uid++}`;
        const kt: M = k.transform ?? ID;
        defs.push(`<clipPath id="${id}"><g transform="matrix(${num(kt.m00)} ${num(kt.m10)} ${num(kt.m01)} ${num(kt.m11)} ${num(kt.m02)} ${num(kt.m12)})">${fillPaths(c, k).map((g) => `<path d="${g.d}"${ruleAttr(g.rule)}/>`).join("")}</g></clipPath>`);
        clip = id;
        continue;
      }
      const s = svgNode(c, k, defs);
      parts.push(clip ? `<g clip-path="url(#${clip})">${s}</g>` : s);
    }
    const body = parts.join("");
    // A frame that clips: its own box clips what's in it.
    if (BOXES.has(n.type) && n.frameMaskDisabled === false && !n.resizeToFit) {
      const id = `c${c.uid++}`;
      defs.push(`<clipPath id="${id}"><rect width="${num(n.size?.x ?? 0)}" height="${num(n.size?.y ?? 0)}"/></clipPath>`);
      inner += `<g clip-path="url(#${id})">${body}</g>`;
    } else inner += body;
  }
  return `<g transform="${tf}"${op}>${inner}</g>`;
}

// ---------------------------------------------------------------------------------------------
// Text

const WEIGHTS: Array<[RegExp, number]> = [
  [/thin|hairline/i, 100],
  [/extra ?light|ultra ?light/i, 200],
  [/light/i, 300],
  [/medium/i, 500],
  [/semi ?bold|demi ?bold/i, 600],
  [/extra ?bold|ultra ?bold/i, 800],
  [/black|heavy/i, 900],
  [/bold/i, 700],
];
const weightOf = (style = "") => WEIGHTS.find(([re]) => re.test(style))?.[1] ?? 400;

const TEXT_KEYS = ["fontName", "fontSize", "lineHeight", "letterSpacing", "textCase", "textDecoration"];
/** A node's (or run's) type: its shared text style's when it uses one this file holds, else its own. */
function withTextStyle(c: Ctx, s: any): any {
  const style = styleNode(c, s?.styleIdForText);
  if (!style) return s;
  const out = { ...s };
  for (const k of TEXT_KEYS) if (style[k] !== undefined) out[k] = style[k];
  return out;
}

/** A run's text style as CSS: family, weight, size, spacing, line height, case, decoration, colour. */
function textStyleCss(c: Ctx, s0: any, out: Record<string, string>, base?: any) {
  const s = withTextStyle(c, s0);
  const fam = s.fontName?.family;
  if (fam) {
    const w = weightOf(s.fontName.style);
    const italic = /italic|oblique/i.test(s.fontName.style ?? "");
    out.fontFamily = /[\s,]/.test(fam) ? `"${fam}"` : fam;
    out.fontWeight = String(w);
    if (italic) out.fontStyle = "italic";
    else if (base) out.fontStyle = "normal";
    if (!c.fonts.has(fam)) c.fonts.set(fam, new Set());
    c.fonts.get(fam)!.add(`${w}${italic ? "i" : ""}`);
  }
  const size = s.fontSize ?? withTextStyle(c, base)?.fontSize;
  if (s.fontSize) out.fontSize = px(s.fontSize);
  if (s.letterSpacing && size) out.letterSpacing = s.letterSpacing.units === "PERCENT" ? px((s.letterSpacing.value / 100) * size) : px(s.letterSpacing.value);
  if (s.lineHeight && size) {
    const lh = s.lineHeight;
    if (lh.units === "PIXELS") out.lineHeight = px(lh.value);
    else if (lh.units === "PERCENT") out.lineHeight = lh.value === 100 ? "normal" : num(lh.value / 100);
    else if (lh.units === "RAW") out.lineHeight = num(lh.value);
  }
  if (s.textCase === "UPPER") out.textTransform = "uppercase";
  else if (s.textCase === "LOWER") out.textTransform = "lowercase";
  else if (s.textCase === "TITLE") out.textTransform = "capitalize";
  else if (s.textCase === "SMALL_CAPS" || s.textCase === "SMALL_CAPS_FORCED") out.fontVariant = "small-caps";
  if (s.textDecoration === "UNDERLINE") out.textDecoration = "underline";
  else if (s.textDecoration === "STRIKETHROUGH") out.textDecoration = "line-through";
  else if (base && s.textDecoration === "NONE") out.textDecoration = "none";
}

/** A text layer's paint: a colour, or a gradient or picture through the letters. */
function textPaintCss(c: Ctx, list: any[], w: number, h: number, out: Record<string, string>) {
  const fills = shown(list);
  if (!fills.length) return;
  if (fills.length === 1 && fills[0].type === "SOLID") {
    out.color = rgba(fills[0].color, fills[0].opacity ?? 1);
    return;
  }
  const bg: Record<string, string> = {};
  fillCss(c, fills, w, h, bg);
  const layers = [bg.backgroundImage, bg.backgroundColor && `linear-gradient(${bg.backgroundColor}, ${bg.backgroundColor})`].filter(Boolean).join(", ");
  if (!layers) return;
  out.backgroundImage = layers;
  out.WebkitBackgroundClip = "text";
  out.backgroundClip = "text";
  out.color = "transparent";
  out.WebkitTextFillColor = "transparent";
}

/**
 * Each line's own height, when the text's line height is "auto" and its lines differ (a 20px name
 * over an 18px role): Figma lays out each line by its own type, as it recorded.
 */
function lineHeights(n: FNode): { least: number; at: (i: number) => number | undefined } | null {
  const lines: any[] = n.derivedTextData?.baselines ?? [];
  const hs = lines.map((b) => b.lineHeight).filter((h) => typeof h === "number" && h > 0);
  if (hs.length < 2 || hs.every((h) => Math.abs(h - hs[0]) < 0.01)) return null;
  return {
    least: Math.min(...hs),
    at: (i) => lines.find((b) => i >= (b.firstCharacter ?? 0) && i < (b.endCharacter ?? Infinity))?.lineHeight,
  };
}

/** The words, each run of another style a span (and each line its own height, when `lines` says). */
function textHtml(c: Ctx, n: FNode, lines: ReturnType<typeof lineHeights> = null): string {
  const td = n.textData ?? {};
  const chars: string = td.characters ?? n.characters ?? "";
  const ids: number[] = td.characterStyleIDs ?? [];
  const table = new Map<number, any>((td.styleOverrideTable ?? []).map((s: any) => [s.styleID, s]));
  const runs: Array<{ text: string; id: number; lh?: number }> = [];
  for (let i = 0; i < chars.length; i++) {
    const id = ids[i] ?? 0;
    const lh = lines?.at(i);
    const last = runs[runs.length - 1];
    if (last && last.id === id && last.lh === lh) last.text += chars[i];
    else runs.push({ text: chars[i], id, lh });
  }
  const words = (t: string) => esc(t).replace(/\u2028|\n/g, "<br>");
  return runs
    .map((r) => {
      const s = r.id ? table.get(r.id) : undefined;
      const o: Record<string, string> = {};
      if (s) {
        textStyleCss(c, s, o, n);
        const sp = styleNode(c, s.styleIdForFill)?.fillPaints ?? s.fillPaints;
        if (sp) textPaintCss(c, sp, n.size?.x ?? 0, n.size?.y ?? 0, o);
      }
      if (r.lh) o.lineHeight = px(r.lh);
      return Object.keys(o).length ? `<span style="${attr(css(o))}">${words(r.text)}</span>` : words(r.text);
    })
    .join("");
}

// ---------------------------------------------------------------------------------------------
// Layers

const ALIGN: Record<string, string> = { MIN: "flex-start", CENTER: "center", MAX: "flex-end", BASELINE: "baseline", SPACE_EVENLY: "space-between", SPACE_BETWEEN: "space-between" };
const hugs = (v?: string) => v === "RESIZE_TO_FIT" || v === "RESIZE_TO_FIT_WITH_IMPLICIT_SIZE";

/** One node (and what's in it) as HTML. `parent` is the node it sits in (null for an artboard). */
export function nodeHtml(c: Ctx, n: FNode, parent: FNode | null): string {
  if (n.visible === false) return "";
  const w = n.size?.x ?? 0;
  const h = n.size?.y ?? 0;
  const t: M = n.transform ?? ID;
  const st: Record<string, string> = {};
  const inFlow = Boolean(parent && autoLayout(parent) && n.stackPositioning !== "ABSOLUTE");
  // Turned or flipped: where its box lands once turned (Figma lays a turned layer out by that box).
  const turned = Boolean(parent) && (Math.abs(t.m01) > 1e-4 || Math.abs(t.m10) > 1e-4 || t.m00 < 0 || t.m11 < 0);
  const bounds = turnedBounds(t, w, h);
  const drawnAsSvg = VECTORISH.has(n.type) || (n.type === "ELLIPSE" && !fullEllipse(n)) || (BOXES.has(n.type) && onlyShapes(c, n) && w <= 480 && h <= 480 && Boolean(parent));
  if (turned && drawnAsSvg) {
    // Shapes take the turn inside their SVG: their box is the turned shape's.
    if (parent && !inFlow) {
      st.position = "absolute";
      st.left = px(t.m02 + bounds.x);
      st.top = px(t.m12 + bounds.y);
    }
    return svgHtml(c, n, parent, st, inFlow, bounds, t);
  }
  if (parent && !inFlow) {
    st.position = "absolute";
    if (turned) {
      // Turned about its centre, so it stays where Figma has it.
      const cx = t.m02 + t.m00 * (w / 2) + t.m01 * (h / 2);
      const cy = t.m12 + t.m10 * (w / 2) + t.m11 * (h / 2);
      st.left = px(cx - w / 2);
      st.top = px(cy - h / 2);
    } else {
      st.left = px(t.m02);
      st.top = px(t.m12);
    }
  }
  if (turned) st.transform = `matrix(${num(t.m00)}, ${num(t.m10)}, ${num(t.m01)}, ${num(t.m11)}, 0, 0)`;
  // A layer turned (not just flipped) in auto layout takes the room of its turned box: it sits in a holder that size.
  const rotated = turned && (Math.abs(t.m01) > 1e-4 || Math.abs(t.m10) > 1e-4);
  if (rotated && inFlow) {
    // Placed so its centre is the holder's (turned about its centre, its turned box is the holder).
    const centred = { ...t, m02: bounds.w / 2 - (t.m00 * w + t.m01 * h) / 2, m12: bounds.h / 2 - (t.m10 * w + t.m11 * h) / 2 };
    const inner = nodeHtml(c, { ...n, transform: centred, stackChildPrimaryGrow: undefined, stackChildAlignSelf: undefined, stackPositioning: "ABSOLUTE" }, { ...(parent as FNode), stackMode: "NONE" });
    const hold: Record<string, string> = { position: "relative", width: px(bounds.w), height: px(bounds.h), flexShrink: "0" };
    return `<div data-name="${attr(n.name ?? n.type)}" style="${attr(css(hold))}">${inner}</div>`;
  }
  // Size: fixed, hugging what's in it, or filling its auto layout frame.
  let fixW = true;
  let fixH = true;
  const isText = n.type === "TEXT";
  if (autoLayout(n)) {
    const row = n.stackMode === "HORIZONTAL";
    // Left out, the main axis hugs (as Figma makes new auto layout); the cross axis is fixed.
    const primaryHug = n.stackPrimarySizing === undefined || hugs(n.stackPrimarySizing);
    if (primaryHug) row ? (fixW = false) : (fixH = false);
    if (hugs(n.stackCounterSizing)) row ? (fixH = false) : (fixW = false);
  }
  if (isText) {
    const auto = n.textAutoResize ?? "NONE";
    if (auto === "WIDTH_AND_HEIGHT") (fixW = false), (fixH = false), (st.whiteSpace = "nowrap");
    else if (auto === "HEIGHT") fixH = false;
  }
  if (inFlow && parent) {
    const row = parent.stackMode === "HORIZONTAL";
    // A negative gap (layers overlapping in auto layout), which CSS's gap can't be: a negative margin.
    if (parent.stackSpacing < 0 && parent.stackPrimaryAlignItems !== "SPACE_EVENLY") {
      const flow = parent.children.filter((k) => k.visible !== false && k.stackPositioning !== "ABSOLUTE");
      const i = flow.findIndex((k) => k.id === n.id);
      if (i > 0) {
        // Figma never pulls a layer back by more than the smaller of the two layers.
        const along = (k: FNode) => (row ? k.size?.x : k.size?.y) ?? 0;
        const overlap = Math.min(-parent.stackSpacing, along(n), along(flow[i - 1]));
        st[row ? "marginLeft" : "marginTop"] = px(-overlap);
      }
    }
    if (n.stackChildPrimaryGrow === 1) {
      // Fill: exactly the room left, as in Figma (CSS would keep it at least as wide as its content).
      st.flexGrow = "1";
      st.flexBasis = "0";
      st[row ? "minWidth" : "minHeight"] = "0";
      row ? (fixW = false) : (fixH = false);
    }
    if (n.stackChildAlignSelf === "STRETCH") {
      st.alignSelf = "stretch";
      row ? (fixH = false) : (fixW = false);
      // A layer that fills a column which hugs its content doesn't widen the column (in Figma the
      // others set its width); CSS would count its own content in.
      if (!row && hugs(parent.stackCounterSizing)) st.contain = "inline-size";
    }
    st.flexShrink = "0";
  }
  if (fixW) st.width = px(w);
  if (fixH) st.height = px(h);
  const name = ` data-name="${attr(n.name ?? n.type)}"`;
  const mask = n.mask ? " data-mask" : "";

  // Shapes and icons: SVG from Figma's own geometry.
  if (drawnAsSvg) return svgHtml(c, n, parent, st, inFlow, { x: 0, y: 0, w, h }, null);

  if (isText) {
    let perLine: ReturnType<typeof lineHeights> = null;
    textStyleCss(c, n, st);
    // Figma draws type without the Mac's extra weight (light words on dark looked bold beside it).
    st.WebkitFontSmoothing = "antialiased";
    // Figma's own line height for "auto", from how it laid the text out.
    const derived = n.derivedTextData?.baselines?.[0]?.lineHeight;
    perLine = st.lineHeight === "normal" ? lineHeights(n) : null;
    if (perLine) st.lineHeight = px(perLine.least);
    else if (st.lineHeight === "normal" && derived) st.lineHeight = px(derived);
    textPaintCss(c, paints(c, n, "fill"), w, h, st);
    lookCss(c, n, st, true);
    const align = n.textAlignHorizontal;
    if (align && align !== "LEFT") st.textAlign = align === "JUSTIFIED" ? "justify" : align.toLowerCase();
    if (n.textAutoResize === "TRUNCATE" || n.textTruncation === "ENABLED") (st.overflow = "hidden"), (st.textOverflow = "ellipsis");
    const v = n.textAlignVertical;
    if (st.height && v && v !== "TOP") {
      st.display = "flex";
      st.flexDirection = "column";
      st.justifyContent = v === "CENTER" ? "center" : "flex-end";
      return `<div${name}${mask} style="${attr(css(st))}"><span>${textHtml(c, n, perLine)}</span></div>`;
    }
    return `<p${name}${mask} style="${attr(css({ margin: "0", ...st }))}">${textHtml(c, n, perLine)}</p>`;
  }

  // Boxes: frames, components, rectangles, ellipses.
  fillCss(c, paints(c, n, "fill"), w, h, st);
  lookCss(c, n, st);
  if (n.type === "ELLIPSE") st.borderRadius = "50%";
  const box = BOXES.has(n.type);
  if (box && n.frameMaskDisabled === false && !n.resizeToFit) st.overflow = "hidden";
  if (autoLayout(n)) {
    const row = n.stackMode === "HORIZONTAL";
    st.display = "flex";
    st.flexDirection = row ? "row" : "column";
    if (n.stackWrap === "WRAP") {
      st.flexWrap = "wrap";
      if (n.stackCounterSpacing) st.rowGap = px(n.stackCounterSpacing);
      if (n.stackSpacing > 0 && n.stackPrimaryAlignItems !== "SPACE_EVENLY") st.columnGap = px(n.stackSpacing);
    } else if (n.stackSpacing > 0 && n.stackPrimaryAlignItems !== "SPACE_EVENLY") st.gap = px(n.stackSpacing);
    const jc = ALIGN[n.stackPrimaryAlignItems ?? "MIN"];
    if (jc && jc !== "flex-start") st.justifyContent = jc;
    st.alignItems = ALIGN[n.stackCounterAlignItems ?? "MIN"] ?? "flex-start";
    const pad = [n.stackVerticalPadding, n.stackPaddingRight, n.stackPaddingBottom, n.stackHorizontalPadding].map((v) => v ?? 0);
    if (pad.some((v) => v)) st.padding = pad.map(px).join(" ");
    st.boxSizing = "border-box";
  }
  const kids = n.children.filter((k) => k.visible !== false);
  if (kids.some((k) => !autoLayout(n) || k.stackPositioning === "ABSOLUTE")) st.position ||= "relative";
  return `<div${name}${mask} style="${attr(css(st))}">${kids.map((k) => nodeHtml(c, k, n)).join("")}</div>`;
}

/** The box a w×h layer covers once its transform's turn (no move) is applied. */
function turnedBounds(t: M, w: number, h: number) {
  const xs = [0, t.m00 * w, t.m01 * h, t.m00 * w + t.m01 * h];
  const ys = [0, t.m10 * w, t.m11 * h, t.m10 * w + t.m11 * h];
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

/** How far a shape's (or its parts') strokes can reach outside its box. */
function strokeReach(c: Ctx, n: FNode): number {
  let r = 0;
  const visit = (k: FNode) => {
    if (k.visible === false) return;
    // An inside stroke stays in; an open path's is centred whatever its alignment says, and its
    // ends may carry arrows.
    const sw = k.strokeWeight ?? 1;
    if (shown(paints(c, k, "stroke")).length && sw > 0 && !(k.strokeAlign === "INSIDE" && (BOXES.has(k.type) || closedShape(c, k)))) {
      const arrows = !BOXES.has(k.type) && !closedShape(c, k) && (/ARROW|FILLED/.test(k.strokeCap ?? "") || (k.vectorData?.styleOverrideTable ?? []).some((t: any) => /ARROW|FILLED/.test(t.strokeCap ?? "")));
      r = Math.max(r, sw * (arrows ? 4 : k.strokeJoin === "MITER" ? 2 : 1));
    }
    for (const x of k.children ?? []) visit(x);
  };
  visit(n);
  return r ? Math.ceil(r) + 1 : 0;
}

/** A whole ellipse (not an arc or a ring): a box with round corners does. */
const fullEllipse = (n: FNode) => n.type === "ELLIPSE" && !(n.arcData && (n.arcData.innerRadius || Math.abs((n.arcData.endingAngle ?? 6.2832) - (n.arcData.startingAngle ?? 0)) < 6.28));

/** A shape or icon as an SVG layer: its box `b` (the turned shape's, when `turn` is given). */
function svgHtml(c: Ctx, n: FNode, parent: FNode | null, st: Record<string, string>, inFlow: boolean, b: { x: number; y: number; w: number; h: number }, turn: M | null): string {
  const w = n.size?.x ?? 0;
  const h = n.size?.y ?? 0;
  if (inFlow && parent) {
    const row = parent.stackMode === "HORIZONTAL";
    if (n.stackChildPrimaryGrow === 1) (st.flexGrow = "1"), (st.flexBasis = "0");
    if (n.stackChildAlignSelf === "STRETCH") st.alignSelf = "stretch";
    st.flexShrink = "0";
    void row;
  }
  // Strokes reach past a shape's box (a line has no height at all): room for them, which takes no
  // room in the layout (a negative margin), so the shape sits where Figma lays it out.
  const pad = strokeReach(c, n);
  st.width = px(b.w + 2 * pad);
  st.height = px(b.h + 2 * pad);
  if (pad) {
    if (st.position === "absolute") {
      st.left = px(parseFloat(st.left) - pad);
      st.top = px(parseFloat(st.top) - pad);
    } else st.margin = `${px(-pad + (parseFloat(st.marginTop ?? "0") || 0))} ${px(-pad)} ${px(-pad)} ${px(-pad + (parseFloat(st.marginLeft ?? "0") || 0))}`;
    delete st.marginTop;
    delete st.marginLeft;
  }
  const defs: string[] = [];
  const own = BOXES.has(n.type) ? fillBox(c, n, w, h, defs) : "";
  let body = own + (BOXES.has(n.type) ? n.children.map((k) => svgNode(c, k, defs)).join("") : shapePaths(c, n, defs));
  if (turn) body = `<g transform="matrix(${num(turn.m00)} ${num(turn.m10)} ${num(turn.m01)} ${num(turn.m11)} ${num(-b.x)} ${num(-b.y)})">${body}</g>`;
  if (n.opacity !== undefined && n.opacity < 1) st.opacity = num(n.opacity);
  if (n.blendMode && BLEND[n.blendMode]) st.mixBlendMode = BLEND[n.blendMode];
  st.overflow = "visible";
  const name = ` data-name="${attr(n.name ?? n.type)}"`;
  return `<svg${name}${n.mask ? " data-mask" : ""} xmlns="http://www.w3.org/2000/svg" width="${num(b.w + 2 * pad)}" height="${num(b.h + 2 * pad)}" viewBox="${num(-pad)} ${num(-pad)} ${num(b.w + 2 * pad)} ${num(b.h + 2 * pad)}" fill="none" style="${attr(css(st))}">${defs.length ? `<defs>${defs.join("")}</defs>` : ""}${body}</svg>`;
}

/** A frame's own fill, as an SVG rectangle (when it's drawn as one SVG with what's in it). */
function fillBox(c: Ctx, n: FNode, w: number, h: number, defs: string[]): string {
  const r = n.cornerRadius ? ` rx="${num(n.cornerRadius)}"` : "";
  return shown(paints(c, n, "fill"))
    .map((p) => {
      const sp = svgPaint(c, p, w, h, defs);
      return sp ? `<rect width="${num(w)}" height="${num(h)}"${r} fill="${sp.fill}"${sp.opacity !== undefined && sp.opacity < 1 ? ` fill-opacity="${num(sp.opacity)}"` : ""}/>` : "";
    })
    .join("");
}

export function newCtx(d: FigDoc): Ctx {
  return { d, warnings: new Set(), fonts: new Map(), pictures: new Map(), uid: 0 };
}

/** A frame's absolute place on its page (to keep frames where they are relative to each other). */
export const placeOf = (n: FNode) => ({ x: n.transform?.m02 ?? 0, y: n.transform?.m12 ?? 0, w: n.size?.x ?? 0, h: n.size?.y ?? 0 });

/** A stable short hash, for ids. */
export const shortHash = (s: string) => createHash("sha1").update(s).digest("hex").slice(0, 10);
