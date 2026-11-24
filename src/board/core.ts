/**
 * Boards: designs made of real HTML and CSS, laid out on pages of artboards, that agents and people
 * edit together. A board is a tree of layers (frames, text, images and vectors), each with its CSS.
 *
 * This module is pure (no Node or DOM APIs; its only import is the shader model beside it, as pure)
 * so the engine and the Studio's canvas share it: the canvas loads the compiled file as
 * /ui/board-core.js (and the shader model as /ui/shaders.js). Everything that changes a board goes
 * through `applyOps`, which also returns the steps that undo it.
 */
import { CUSTOM_SHADER, cleanShaderCode, scaledShader, shaderAttrs, shaderBoxStyle, shaderCanvas, shaderCode, shaderFromAttrs, shaderPresetName, shaderWords, presetOf, type BoardShader, type ShaderSpec } from "./shaders.js";
export * from "./shaders.js";
import { cleanEffects, effectsAttrs, effectsFromAttrs, effectsWords, scaledEffects, type LayerEffect } from "./effects.js";
export * from "./effects.js";

export type NodeType = "frame" | "text" | "image" | "svg" | "vector" | "video";

/** How a video plays in Preview (and the page it becomes): Figma's settings, autoplay, loop and sound. */
export interface VideoSettings {
  autoplay?: boolean;
  loop?: boolean;
  /** Sound off. */
  muted?: boolean;
}

/** A video's settings with the defaults filled in: like Figma, it autoplays and loops, with sound. */
export const videoSettings = (n: Pick<BoardNode, "video">): Required<VideoSettings> => ({
  autoplay: n.video?.autoplay ?? true,
  loop: n.video?.loop ?? true,
  muted: n.video?.muted ?? false,
});
/** CSS properties in camelCase ("backgroundColor", "--brand" for custom properties), values as CSS. */
export type Style = Record<string, string>;

export interface BoardNode {
  id: string;
  type: NodeType;
  name: string;
  /** The frame it sits in; null for a layer on the page itself (an artboard, usually). */
  parent: string | null;
  children?: string[];
  style: Style;
  /** A text layer's words, as inline HTML (<b>, <span style>, <br>…). */
  text?: string;
  /** An image layer's picture, or a video layer's video: a file path, a URL or a data: URI. */
  src?: string;
  /**
   * A video layer's still: a picture of its first frame. The canvas shows it until the video is
   * played (as Figma does), and pictures of the board (exports, thumbnails, screenshots) use it.
   */
  poster?: string;
  /** A video layer's playback in Preview. */
  video?: VideoSettings;
  /**
   * A vector drawn as one piece: its <svg> markup. Without it, an svg layer's parts (its shapes,
   * paths, groups and words) are vector layers of their own, inside it.
   */
  svg?: string;
  /** A part of a vector (inside an svg layer): its SVG element (rect, circle, path, g, text…). */
  tag?: string;
  /** SVG attributes: on an svg layer, its <svg>'s (viewBox, fill…); on a part, its element's (x, d, fill…). */
  attrs?: Record<string, string>;
  /** An svg layer's gradients, patterns, clip paths, masks, filters and symbols, as SVG markup. */
  defs?: string;
  /** A vector layer drawn from one of Screenshotter's shapes (arrow, star, badge…): its settings, which `svg` is drawn from. */
  shape?: Record<string, unknown>;
  hidden?: boolean;
  locked?: boolean;
  /** A component: the main one, which its copies follow. */
  isComponent?: boolean;
  /** A copy of a component (its top layer): the component it's a copy of. */
  instanceOf?: string;
  /** In a copy: the component's layer this one follows. */
  master?: string;
  /** In a copy: what was changed here ("style.color", "text"), which the component's changes leave alone. */
  overrides?: string[];
  /**
   * Used as a mask, as Figma has it: not drawn itself, it shows the layers above it in its frame (up
   * to the next mask) only where it is: by its alpha, its outline (vector) or its brightness (luminance).
   */
  mask?: MaskType;
  /** A frame's shader fill, drawn over its fills and behind its layers: a preset or code of its own, its parameters, speed and still (see shaders.ts). */
  shader?: ShaderSpec;
  /** Optical & layer effects (Liquid Glass, Pattern refraction, Lens distortion, Bloom, Gooey merge, etc., see effects.ts). */
  effects?: LayerEffect[];
}

export interface BoardPage {
  id: string;
  name: string;
  /** Its top-level layers, back to front. */
  children: string[];
}

/** A design token: a CSS custom property every layer can use as var(--name). */
export interface BoardToken {
  name: string;
  value: string;
}

/**
 * A typeface the board carries itself (a website's own fonts, brought in with it): its file is in
 * the library, so it draws the same on the canvas, in Preview and in exports, with no network.
 */
export interface BoardFont {
  family: string;
  /** "400", "700", "100 900" (a variable font's range)… */
  weight?: string;
  style?: string;
  /** "condensed", "semi-condensed", "expanded"… */
  stretch?: string;
  /** The font file (woff2, woff, ttf or otf), in the library. */
  src: string;
  unicodeRange?: string;
}

export interface Board {
  id: string;
  name: string;
  /** Goes up by one with every change, from whoever made it. */
  rev: number;
  pages: BoardPage[];
  nodes: Record<string, BoardNode>;
  tokens: BoardToken[];
  createdAt: string;
  updatedAt: string;
  /** Who made the last change. */
  by?: "agent" | "studio";
  /** Artboards an agent is working on, with when it last wrote to each. */
  working?: Record<string, string>;
  /** The agents that have worked on the board, by `BoardAgent.key`: who to tell about a comment. */
  agents?: Record<string, BoardAgent>;
  /** Typefaces the board carries (see BoardFont). */
  fonts?: BoardFont[];
  /** Shaders saved on the board as its own presets, to place again. */
  shaders?: BoardShader[];
}

/**
 * An agent that changed the board through the MCP. Agentman (the person's agent manager) knows it
 * by `session`, which is how a comment reaches it.
 */
export interface BoardAgent {
  /** Its Agentman session id when known ("claude:<uuid>"), else one made from its kind and folder. */
  key: string;
  /** Agentman's id for its session. */
  session?: string;
  /**
   * How `session` was worked out: from its own process (Claude Code's record of it), from the name
   * of the tmux pane Agentman runs it in, or as the only agent Agentman lists in its folder (a guess).
   */
  how?: "process" | "tmux" | "folder";
  /** claude, codex, cursor-cli, opencode…; "agent" when it can't be told. */
  kind: string;
  /** What the person calls it: Agentman's name for the session, else its kind and folder. */
  name: string;
  cwd?: string;
  firstAt: string;
  lastAt: string;
  /** The artboards it wrote to. */
  artboards: string[];
  /**
   * What it did last, for its cursor on the canvas: the layers it touched (or looked at), what it
   * was doing, and when.
   */
  last?: AgentTouch;
}

/** An agent's latest move on a board: changing layers, writing new ones, bringing in a site, or looking. */
export interface AgentTouch {
  at: string;
  ids: string[];
  doing: "edit" | "write" | "import" | "look" | "read";
}

// ---------------------------------------------------------------------------------------------
// Ids, names, numbers

const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
export function newId(length = 10): string {
  const bytes = new Uint8Array(length);
  globalThis.crypto.getRandomValues(bytes);
  let s = "";
  for (const b of bytes) s += ALPHABET[b % 36];
  return s;
}

/** A CSS length in px as a number, or undefined if it isn't one ("12px", "12", 12 → 12). */
export function pxValue(v: string | number | undefined | null): number | undefined {
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
  if (typeof v !== "string") return undefined;
  const m = /^\s*(-?\d*\.?\d+)(px)?\s*$/.exec(v);
  return m ? Number(m[1]) : undefined;
}

/** Properties whose bare numbers are CSS numbers, not pixels. */
const UNITLESS = new Set(["opacity", "zIndex", "fontWeight", "lineHeight", "flexGrow", "flexShrink", "flex", "order", "aspectRatio", "scale", "zoom", "gridRow", "gridColumn", "gridRowStart", "gridRowEnd", "gridColumnStart", "gridColumnEnd", "gridArea", "columnCount", "orphans", "widows", "fillOpacity", "strokeOpacity", "stopOpacity"]);

/** A value as CSS: numbers become px except where CSS takes a bare number. */
export function cssValue(prop: string, v: string | number): string {
  if (typeof v === "number") return UNITLESS.has(prop) || prop.startsWith("--") ? String(v) : `${round(v)}px`;
  return String(v).trim();
}

export const round = (n: number, places = 2) => Math.round(n * 10 ** places) / 10 ** places;

// ---------------------------------------------------------------------------------------------
// CSS text

export function kebab(k: string): string {
  if (k.startsWith("--")) return k;
  return k.replace(/^(webkit|moz|ms)(?=[A-Z])/, "-$1").replace(/[A-Z]/g, (c) => "-" + c.toLowerCase());
}

export function camel(k: string): string {
  k = k.trim();
  if (k.startsWith("--")) return k;
  return k
    .toLowerCase()
    .replace(/^-(webkit|moz|ms)-/, "$1-")
    .replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
}

/** "a: b; c: url(x;y)" → { a: "b", c: "url(x;y)" }, keeping semicolons inside brackets and quotes. */
export function parseStyle(text: string | undefined): Style {
  const out: Style = {};
  if (!text) return out;
  const parts: string[] = [];
  let depth = 0;
  let quote = "";
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === quote && text[i - 1] !== "\\") quote = "";
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === "(") depth++;
    else if (c === ")") depth = Math.max(0, depth - 1);
    else if (c === ";" && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  for (const p of parts) {
    const i = p.indexOf(":");
    if (i < 0) continue;
    const k = p.slice(0, i).trim();
    const v = p
      .slice(i + 1)
      .trim()
      .replace(/\s*!important$/i, "");
    if (k && v && !/expression\s*\(|javascript:/i.test(v)) out[camel(k)] = v;
  }
  return out;
}

export function styleText(s: Style | undefined): string {
  if (!s) return "";
  return Object.entries(s)
    .filter(([, v]) => v !== "" && v !== undefined && v !== null)
    .map(([k, v]) => `${kebab(k)}:${v}`)
    .join(";");
}

// ---------------------------------------------------------------------------------------------
// A small, forgiving HTML parser (agents write tidy HTML; this copes with the rest)

export interface HEl {
  tag: string;
  /** The tag as written, for SVG's camelCase elements (linearGradient, clipPath…). */
  raw: string;
  attrs: Record<string, string>;
  children: HNode[];
}
export type HNode = HEl | string;

const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);
const RAW_TEXT = new Set(["script", "style", "textarea", "title"]);
const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", copy: "©", reg: "®", trade: "™", hellip: "…", mdash: "—", ndash: "–",
  lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", bull: "•", middot: "·", times: "×", divide: "÷", deg: "°", plusmn: "±", larr: "←",
  rarr: "→", uarr: "↑", darr: "↓", harr: "↔", laquo: "«", raquo: "»", euro: "€", pound: "£", yen: "¥", cent: "¢", sect: "§", para: "¶",
  thinsp: " ", ensp: " ", emsp: " ", zwj: "‍", zwnj: "‌", check: "✓", star: "☆", hearts: "♥",
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

export function parseHtml(src: string): HEl {
  const root: HEl = { tag: "#root", raw: "#root", attrs: {}, children: [] };
  const stack: HEl[] = [root];
  const top = () => stack[stack.length - 1];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const lt = src.indexOf("<", i);
    if (lt < 0) {
      top().children.push(decodeEntities(src.slice(i)));
      break;
    }
    if (lt > i) top().children.push(decodeEntities(src.slice(i, lt)));
    i = lt;
    if (src.startsWith("<!--", i)) {
      const end = src.indexOf("-->", i + 4);
      i = end < 0 ? n : end + 3;
      continue;
    }
    if (src[i + 1] === "!" || src[i + 1] === "?") {
      const end = src.indexOf(">", i);
      i = end < 0 ? n : end + 1;
      continue;
    }
    if (src[i + 1] === "/") {
      const end = src.indexOf(">", i);
      const name = src.slice(i + 2, end < 0 ? n : end).trim().toLowerCase();
      i = end < 0 ? n : end + 1;
      const at = stack.map((e) => e.tag).lastIndexOf(name);
      if (at > 0) stack.length = at;
      continue;
    }
    if (!/[a-zA-Z]/.test(src[i + 1] ?? "")) {
      top().children.push("<");
      i++;
      continue;
    }
    // A start tag: its name, then attributes up to > or />.
    let j = i + 1;
    while (j < n && !/[\s/>]/.test(src[j])) j++;
    const raw = src.slice(i + 1, j);
    const tag = raw.toLowerCase();
    const attrs: Record<string, string> = {};
    let selfClosing = false;
    for (;;) {
      while (j < n && /\s/.test(src[j])) j++;
      if (j >= n) break;
      if (src[j] === ">") {
        j++;
        break;
      }
      if (src[j] === "/" && src[j + 1] === ">") {
        selfClosing = true;
        j += 2;
        break;
      }
      if (src[j] === "/") {
        j++;
        continue;
      }
      let k = j;
      while (k < n && !/[\s=/>]/.test(src[k])) k++;
      const name = src.slice(j, k);
      j = k;
      while (j < n && /\s/.test(src[j])) j++;
      let value = "";
      if (src[j] === "=") {
        j++;
        while (j < n && /\s/.test(src[j])) j++;
        const q = src[j];
        if (q === '"' || q === "'") {
          const end = src.indexOf(q, j + 1);
          value = src.slice(j + 1, end < 0 ? n : end);
          j = end < 0 ? n : end + 1;
        } else {
          let e = j;
          while (e < n && !/[\s>]/.test(src[e])) e++;
          value = src.slice(j, e);
          j = e;
        }
      }
      if (name) attrs[name] = decodeEntities(value);
    }
    i = j;
    const el: HEl = { tag, raw, attrs, children: [] };
    // A new <p> or <li> closes the one still open, as browsers do.
    if ((tag === "p" || tag === "li") && top().tag === tag) stack.pop();
    top().children.push(el);
    if (RAW_TEXT.has(tag) && !selfClosing) {
      const close = src.toLowerCase().indexOf(`</${tag}`, i);
      const body = src.slice(i, close < 0 ? n : close);
      if (body) el.children.push(tag === "textarea" || tag === "title" ? decodeEntities(body) : body);
      const end = close < 0 ? n : src.indexOf(">", close);
      i = end < 0 ? n : end + 1;
      continue;
    }
    if (!selfClosing && !VOID.has(tag)) stack.push(el);
  }
  return root;
}

const escText = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/ /g, "&nbsp;");
export const escAttr = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

/** Words people may style inside a text layer. Anything else is unwrapped to its words. */
const INLINE = new Set(["span", "a", "b", "strong", "i", "em", "u", "s", "del", "ins", "small", "sub", "sup", "mark", "code", "kbd", "abbr", "q", "time", "label", "br", "wbr", "font", "cite", "var", "samp", "bdi", "data"]);
const UNSAFE_SVG = new Set(["script", "foreignobject", "iframe", "object", "embed", "audio", "video", "animate", "set", "animatemotion", "animatetransform", "handler", "listener"]);

const safeAttr = (name: string, value: string) => !/^on/i.test(name) && !/^\s*javascript:/i.test(value) && !(/^(href|xlink:href)$/i.test(name) && /^\s*data:text\/html/i.test(value));

/** SVG markup with scripts, event handlers and foreign content taken out. */
export function serializeSvg(n: HNode): string {
  if (typeof n === "string") return escText(n);
  if (UNSAFE_SVG.has(n.tag)) return "";
  const attrs = Object.entries(n.attrs)
    .filter(([k, v]) => safeAttr(k, v))
    .map(([k, v]) => ` ${k}="${escAttr(v)}"`)
    .join("");
  const inner = n.children.map(serializeSvg).join("");
  if (n.tag === "style") return `<style>${n.children.filter((c) => typeof c === "string").join("").replace(/<\/?\w/g, "")}</style>`;
  return inner ? `<${n.raw}${attrs}>${inner}</${n.raw}>` : `<${n.raw}${attrs}/>`;
}

/**
 * An <svg>'s <style> rules written onto the elements they style, and the <style> taken out. A
 * stylesheet in an SVG applies to the whole page it's drawn in: two exports that both use
 * `.cls-1` (Illustrator's and Figma's habit) would colour each other, and a vector's parts keep no
 * class to be matched by. Simple selectors (tag, #id, .class, and those joined: `path.cls-1`) are
 * applied, in order of specificity, under each element's own style; anything else is left out and
 * said in `warnings`.
 */
export function inlineSvgStyles(el: HEl, warnings: string[] = []): HEl {
  const sheets: string[] = [];
  const gather = (e: HEl) => {
    for (const c of e.children) if (typeof c !== "string") (c.tag === "style" ? sheets.push(c.children.filter((x) => typeof x === "string").join("")) : gather(c));
  };
  gather(el);
  if (!sheets.length) return el;
  type Rule = { tag?: string; id?: string; classes: string[]; spec: number; order: number; style: Style };
  const rules: Rule[] = [];
  const skipped: string[] = [];
  const css = sheets.join("\n").replace(/\/\*[\s\S]*?\*\//g, "");
  let i = 0;
  while (i < css.length) {
    const open = css.indexOf("{", i);
    const semi = css.indexOf(";", i);
    const head = css.slice(i, open < 0 ? undefined : open).replace(/^[\s;]+/, "").trim();
    // @import and the like end at a semicolon; @media, @font-face and the like are a block, left out whole.
    if (/^@/.test(css.slice(i).trim()) && semi >= 0 && (open < 0 || semi < open)) {
      skipped.push(css.slice(i, semi).trim());
      i = semi + 1;
      continue;
    }
    if (open < 0) break;
    // To the brace that closes this one (j ends just past it).
    let depth = 1;
    let j = open + 1;
    for (; j < css.length && depth > 0; j++) depth += css[j] === "{" ? 1 : css[j] === "}" ? -1 : 0;
    const body = css.slice(open + 1, j - 1);
    i = j;
    if (head.startsWith("@")) {
      skipped.push(head);
      continue;
    }
    const style = parseStyle(body);
    for (const sel of head.split(",").map((x) => x.trim()).filter(Boolean)) {
      const m = /^(\*|[a-zA-Z][\w-]*)?(#[\w-]+)?((?:\.[\w-]+)*)$/.exec(sel);
      if (!m || (!m[1] && !m[2] && !m[3])) {
        skipped.push(sel);
        continue;
      }
      const tag = m[1] && m[1] !== "*" ? m[1].toLowerCase() : undefined;
      const classes = m[3] ? m[3].slice(1).split(".") : [];
      rules.push({ tag, id: m[2]?.slice(1), classes, spec: (m[2] ? 100 : 0) + classes.length * 10 + (tag ? 1 : 0), order: rules.length, style });
    }
  }
  rules.sort((a, b) => a.spec - b.spec || a.order - b.order);
  if (skipped.length) warnings.push(`Some of an <svg>'s <style> couldn't be written onto its parts and was left out: ${skipped.slice(0, 4).join(", ")}${skipped.length > 4 ? "…" : ""}.`);
  const apply = (e: HEl): HEl => {
    const classes = (e.attrs.class ?? "").split(/\s+/).filter(Boolean);
    const sheet: Style = {};
    for (const r of rules) {
      if ((r.tag && r.tag !== e.tag) || (r.id && r.id !== e.attrs.id) || r.classes.some((c) => !classes.includes(c))) continue;
      Object.assign(sheet, r.style);
    }
    const attrs = { ...e.attrs };
    if (Object.keys(sheet).length) attrs.style = styleText({ ...sheet, ...parseStyle(e.attrs.style) });
    return { ...e, attrs, children: e.children.filter((c) => typeof c === "string" || c.tag !== "style").map((c) => (typeof c === "string" ? c : apply(c))) };
  };
  return apply(el);
}

/** A text layer's inline HTML: styled runs and line breaks only, whitespace as the browser shows it. */
export function inlineHtml(nodes: HNode[]): string {
  const out = nodes.map(inlineOf).join("");
  return out.replace(/[ \t\r\n]+/g, " ").replace(/^ | $/g, "").replace(/ ?<br> ?/g, "<br>");
}

function inlineOf(n: HNode): string {
  if (typeof n === "string") return escText(n);
  if (n.tag === "br") return "<br>";
  if (n.tag === "script" || n.tag === "style") return "";
  const inner = n.children.map(inlineOf).join("");
  if (!INLINE.has(n.tag) || n.tag === "wbr") return inner;
  const style = styleText({ ...TAG_TEXT[n.tag], ...parseStyle(n.attrs.style) });
  const tag = n.tag === "font" ? "span" : n.tag;
  const href = tag === "a" && n.attrs.href && safeAttr("href", n.attrs.href) ? ` href="${escAttr(n.attrs.href)}"` : "";
  return `<${tag}${href}${style ? ` style="${escAttr(style)}"` : ""}>${inner}</${tag}>`;
}

// ---------------------------------------------------------------------------------------------
// Vectors: an <svg> read into layers of its own (groups, shapes, paths, words), as Paper does, so
// each part can be picked, moved, resized and restyled. Gradients, clip paths, masks, filters and
// symbols stay with the svg layer as its defs.

/** The SVG elements a vector's parts can be. */
export const VECTOR_TAGS = new Set(["g", "rect", "circle", "ellipse", "line", "polyline", "polygon", "path", "text", "use", "image", "svg"]);
const SVG_DRAWN = new Set([...VECTOR_TAGS, "a", "switch"]);
const SVG_DEFS = new Set(["defs", "lineargradient", "radialgradient", "pattern", "clippath", "mask", "filter", "marker", "symbol", "style"]);
const SVG_SKIP = new Set(["title", "desc", "metadata"]);
/** Attributes SVG spells in camelCase (setAttribute is case-sensitive), and the old xlink:href. */
const SVG_CASE: Record<string, string> = { viewbox: "viewBox", preserveaspectratio: "preserveAspectRatio", pathlength: "pathLength", textlength: "textLength", lengthadjust: "lengthAdjust", "xlink:href": "href" };
const VECTOR_NAMES: Record<string, string> = { g: "Group", a: "Group", switch: "Group", rect: "Rectangle", circle: "Circle", ellipse: "Ellipse", line: "Line", polyline: "Polyline", polygon: "Polygon", path: "Path", use: "Symbol", image: "Image", text: "Text", svg: "Vector" };
/** An SVG with more parts than this stays one layer (a detailed illustration, say). */
export const MAX_VECTOR_PARTS = 800;

export const vectorTag = (t: string | undefined) => (t && VECTOR_TAGS.has(t) ? t : "g");
export const vectorName = (tag: string | undefined) => VECTOR_NAMES[tag ?? ""] ?? "Vector";

const ATTR_NAME = /^[a-zA-Z_][-a-zA-Z0-9_:.]*$/;
/** An element's attributes that are safe to draw (no handlers, no script URLs, no style: that's CSS). */
export function cleanAttrs(attrs: Record<string, string> | undefined): [string, string][] {
  return Object.entries(attrs ?? {}).filter(([k, v]) => ATTR_NAME.test(k) && k.toLowerCase() !== "style" && typeof v === "string" && safeAttr(k, v));
}
export const attrText = (attrs: Record<string, string> | undefined) => cleanAttrs(attrs).map(([k, v]) => ` ${k}="${escAttr(v)}"`).join("");

/**
 * The pictures an SVG's <image> elements show (href, or the old xlink:href) passed through `fn`, as
 * an image layer's src is: a library file made a URL the page can load, or a file copied into the
 * library. A link inside the SVG (#id) stays as it is.
 */
export function mapSvgImages(markup: string, fn: (src: string) => string): string {
  if (!/<image\b/i.test(markup)) return markup;
  return markup.replace(/<image\b[^>]*>/gi, (tag) =>
    tag.replace(/(\s(?:xlink:)?href\s*=\s*)(["'])(.*?)\2/gi, (m, at: string, _q: string, v: string) => {
      const src = v.replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").trim();
      return !src || src.startsWith("#") ? m : `${at}"${escAttr(fn(src))}"`;
    }),
  );
}

/** A vector part's attributes with an <image>'s picture passed through `fn` (see mapSvgImages). */
export function svgImageAttrs(tag: string | undefined, attrs: Record<string, string> | undefined, fn: (src: string) => string): Record<string, string> | undefined {
  if (tag !== "image" || !attrs) return attrs;
  const out = { ...attrs };
  for (const k of ["href", "xlink:href"]) {
    const v = out[k]?.trim();
    if (v && !v.startsWith("#")) out[k] = fn(v);
  }
  return out;
}

function svgAttrs(attrs: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(attrs)) {
    const lk = k.toLowerCase();
    if (lk === "style" || lk === "class" || lk.startsWith("data-") || lk === "xmlns" || lk.startsWith("xmlns:") || !safeAttr(k, v)) continue;
    out[SVG_CASE[lk] ?? k] = v;
  }
  return out;
}

/** How many parts an <svg> would make. */
export function svgPartCount(el: HEl): number {
  let n = 0;
  for (const c of el.children) {
    if (typeof c === "string" || SVG_DEFS.has(c.tag) || UNSAFE_SVG.has(c.tag)) continue;
    if (SVG_DRAWN.has(c.tag)) n++;
    if (c.tag !== "text" && c.tag !== "svg") n += svgPartCount(c);
  }
  return n;
}

/** An <svg> as an svg layer (with `style`, its CSS) and a vector layer for each of its parts. */
export function svgNodes(el: HEl, parent: string | null, style: Style, name: string): { id: string; nodes: Record<string, BoardNode> } {
  const nodes: Record<string, BoardNode> = {};
  const defs: string[] = [];
  const id = newId();
  const attrs = svgAttrs(el.attrs);
  delete attrs.width;
  delete attrs.height;
  delete attrs.id;
  // Without a viewBox the drawing wouldn't scale with the layer: its size as written is its box.
  if (!attrs.viewBox) {
    const w = pxValue(el.attrs.width);
    const h = pxValue(el.attrs.height);
    if (w && h) attrs.viewBox = `0 0 ${w} ${h}`;
  }
  nodes[id] = { id, type: "svg", name, parent, style, attrs, children: [] };
  const walk = (e: HEl, p: string): string[] => {
    const kids: string[] = [];
    for (const c of e.children) {
      if (typeof c === "string" || UNSAFE_SVG.has(c.tag) || SVG_SKIP.has(c.tag)) continue;
      if (SVG_DEFS.has(c.tag)) {
        defs.push(c.tag === "defs" ? c.children.map(serializeSvg).join("") : serializeSvg(c));
        continue;
      }
      if (!SVG_DRAWN.has(c.tag)) continue;
      const tag = c.tag === "a" || c.tag === "switch" ? "g" : c.tag;
      const a = svgAttrs(c.attrs);
      if (c.tag === "a") delete a.href;
      const vid = newId();
      const leafInside = tag === "text" || tag === "svg";
      const inner = leafInside ? c.children.map(serializeSvg).join("") : "";
      const label = c.attrs["data-name"] || (tag === "text" ? plainText(inner).slice(0, 40) : "") || c.attrs.id || vectorName(tag);
      nodes[vid] = { id: vid, type: "vector", tag, name: label.slice(0, 60), parent: p, style: parseStyle(c.attrs.style), attrs: a, ...(leafInside ? { text: inner } : {}), ...(tag === "g" ? { children: [] } : {}) };
      if (tag === "g") nodes[vid].children = walk(c, vid);
      kids.push(vid);
    }
    return kids;
  };
  nodes[id].children = walk(el, id);
  if (defs.length) nodes[id].defs = defs.join("");
  return { id, nodes };
}

/** An svg layer's <svg> as one piece of markup (what flattening it keeps). */
export function svgMarkup(board: Board, id: string): string {
  const n = board.nodes[id];
  if (!n) return "";
  if (n.svg) return n.svg;
  return `<svg xmlns="http://www.w3.org/2000/svg"${attrText(n.attrs)}>${n.defs ? `<defs>${n.defs}</defs>` : ""}${(n.children ?? []).map((c) => nodeHtml(board, c)).join("")}</svg>`;
}

/** Steps that turn a vector drawn as one piece into a layer for each of its parts. */
export function splitSvgOps(board: Board, id: string): Op[] {
  const n = board.nodes[id];
  if (!n || n.type !== "svg" || !n.svg) throw new OpError("Only a vector drawn as one piece can be split into its parts.");
  const found = parseHtml(n.svg).children.find((c): c is HEl => typeof c !== "string" && c.tag === "svg");
  if (!found) throw new OpError("There's no <svg> in that vector.");
  const t = svgNodes(inlineSvgStyles(found), id, {}, n.name);
  const root = t.nodes[t.id];
  const parts = { ...t.nodes };
  delete parts[t.id];
  const kids = root.children ?? [];
  return [
    { op: "set", id, svg: null, shape: null, attrs: root.attrs ?? {}, defs: root.defs ?? null },
    ...(kids.length ? [{ op: "add" as const, nodes: parts, ids: kids, parent: id }] : []),
  ];
}

/** Steps that make a vector's parts one piece again (one layer, its SVG markup). */
export function flattenSvgOps(board: Board, id: string): Op[] {
  const n = board.nodes[id];
  if (!n || n.type !== "svg" || n.svg) throw new OpError("Only a vector in parts can be made one piece.");
  const markup = svgMarkup(board, id);
  return [
    ...(n.children?.length ? [{ op: "delete" as const, ids: n.children.slice() }] : []),
    { op: "set", id, svg: markup, attrs: Object.fromEntries(Object.keys(n.attrs ?? {}).map((k) => [k, null])), defs: null },
  ];
}

/** Whether a layer can sit in `parent` (null: on the page): a vector's parts only in a vector (or a group in one), everything else only in frames. */
export function canHold(parent: BoardNode | null | undefined, child: BoardNode): boolean {
  if (child.type === "vector") return Boolean(parent && ((parent.type === "svg" && !parent.svg) || (parent.type === "vector" && parent.tag === "g")));
  return !parent || parent.type === "frame";
}

// Moving and resizing a vector's parts: their own coordinates change (x and y, a path's points…),
// so the drawing stays crisp and strokes keep their width. What can't be (a group, words, units
// like %) gets a transform instead.

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

const fmt = (n: number) => String(round(n, 3) + 0);

interface PathSeg {
  c: string;
  a: number[];
}
const PATH_ARGS: Record<string, number> = { m: 2, l: 2, h: 1, v: 1, c: 6, s: 4, q: 4, t: 2, a: 7, z: 0 };

/** Path data as commands and their numbers (arc flags may be written run together: "a1 1 0 011 1"). */
export function parsePath(d: string): PathSeg[] {
  const out: PathSeg[] = [];
  let i = 0;
  const n = d.length;
  let cmd = "";
  const ws = () => {
    while (i < n && /[\s,]/.test(d[i])) i++;
  };
  const num = (): number | null => {
    ws();
    const m = /^[-+]?(?:\d*\.\d+|\d+\.?\d*)(?:[eE][-+]?\d+)?/.exec(d.slice(i, i + 40));
    if (!m) return null;
    i += m[0].length;
    return Number(m[0]);
  };
  const flag = (): number | null => {
    ws();
    if (d[i] === "0" || d[i] === "1") return Number(d[i++]);
    return null;
  };
  while (i < n) {
    ws();
    if (i >= n) break;
    if (/[a-zA-Z]/.test(d[i])) {
      cmd = d[i++];
      if (cmd.toLowerCase() === "z") {
        out.push({ c: cmd, a: [] });
        continue;
      }
    } else if (!cmd || cmd.toLowerCase() === "z") break;
    const lc = cmd.toLowerCase();
    const k = PATH_ARGS[lc];
    if (k === undefined) break;
    const args: number[] = [];
    for (let j = 0; j < k; j++) {
      const v = lc === "a" && (j === 3 || j === 4) ? flag() : num();
      if (v === null) return out;
      args.push(v);
    }
    out.push({ c: cmd, a: args });
    // More numbers after a move are lines.
    if (lc === "m") cmd = cmd === "m" ? "l" : "L";
  }
  return out;
}

/** Path data with every point moved by `map` (absolute points) and scaled by sx, sy (relative ones). */
export function mapPath(d: string, map: (x: number, y: number) => [number, number], sx: number, sy: number): string {
  return parsePath(d)
    .map((s, idx) => {
      const lc = s.c.toLowerCase();
      // A path's first move is absolute even when written in lower case.
      const rel = s.c === lc && !(idx === 0 && lc === "m");
      const P = (x: number, y: number): [number, number] => (rel ? [x * sx, y * sy] : map(x, y));
      const a = s.a;
      if (lc === "z") return s.c;
      if (lc === "h") return s.c + fmt(rel ? a[0] * sx : map(a[0], 0)[0]);
      if (lc === "v") return s.c + fmt(rel ? a[0] * sy : map(0, a[0])[1]);
      if (lc === "a") {
        const [x, y] = P(a[5], a[6]);
        return `${s.c}${fmt(Math.abs(a[0] * sx))} ${fmt(Math.abs(a[1] * sy))} ${fmt(a[2])} ${a[3]} ${sx * sy < 0 ? 1 - a[4] : a[4]} ${fmt(x)} ${fmt(y)}`;
      }
      const pts: number[] = [];
      for (let j = 0; j + 1 < a.length; j += 2) pts.push(...P(a[j], a[j + 1]));
      return s.c + pts.map(fmt).join(" ");
    })
    .join("");
}

const near1 = (k: number) => (Math.abs(k - 1) < 1e-6 ? 1 : k);

/**
 * A vector part's attributes after its box goes from `from` to `to` (both in its own coordinates):
 * moved, or stretched to the new size. Null when its own coordinates can't say it (a group, words
 * being resized, sizes in % or em): give it a transform with `vectorTransform` instead.
 */
export function vectorFit(n: BoardNode, from: Box, to: Box): { attrs: Record<string, string | null>; tag?: string } | null {
  const sx = near1(from.width > 1e-9 ? to.width / from.width : 1);
  const sy = near1(from.height > 1e-9 ? to.height / from.height : 1);
  const X = (x: number) => to.x + (x - from.x) * sx;
  const Y = (y: number) => to.y + (y - from.y) * sy;
  const a = n.attrs ?? {};
  // A number as written (px or bare), the default when it isn't written, undefined if it has units.
  const v = (k: string, d?: number): number | undefined => {
    const raw = a[k];
    if (raw === undefined) return d;
    const m = /^\s*(-?(?:\d*\.\d+|\d+\.?\d*)(?:e[-+]?\d+)?)(px)?\s*$/i.exec(raw);
    return m ? Number(m[1]) : undefined;
  };
  // Several numbers, or null if any has units.
  const many = (...ks: [string, number | undefined][]): number[] | null => {
    const out: number[] = [];
    for (const [k, d] of ks) {
      const x = v(k, d);
      if (x === undefined) return null;
      out.push(x);
    }
    return out;
  };
  const scaled = sx !== 1 || sy !== 1;
  switch (n.tag) {
    case "rect":
    case "image":
    case "use":
    case "svg": {
      const xy = many(["x", 0], ["y", 0]);
      const w = v("width");
      const h = v("height");
      if (!xy) return null;
      const [x, y] = xy;
      if (scaled && (w === undefined || h === undefined)) return null;
      return { attrs: { x: fmt(X(x)), y: fmt(Y(y)), ...(w !== undefined ? { width: fmt(Math.max(0, w * sx)) } : {}), ...(h !== undefined ? { height: fmt(Math.max(0, h * sy)) } : {}) } };
    }
    case "circle": {
      const c = many(["cx", 0], ["cy", 0], ["r", undefined]);
      if (!c) return null;
      const [cx, cy, r] = c;
      if (Math.abs(sx - sy) < 0.01) return { attrs: { cx: fmt(X(cx)), cy: fmt(Y(cy)), r: fmt(r * (sx + sy) / 2) } };
      return { tag: "ellipse", attrs: { cx: fmt(X(cx)), cy: fmt(Y(cy)), rx: fmt(r * sx), ry: fmt(r * sy), r: null } };
    }
    case "ellipse": {
      const c = many(["cx", 0], ["cy", 0], ["rx", undefined], ["ry", undefined]);
      if (!c) return null;
      const [cx, cy, rx, ry] = c;
      return { attrs: { cx: fmt(X(cx)), cy: fmt(Y(cy)), rx: fmt(rx * sx), ry: fmt(ry * sy) } };
    }
    case "line": {
      const p = many(["x1", 0], ["y1", 0], ["x2", 0], ["y2", 0]);
      if (!p) return null;
      return { attrs: { x1: fmt(X(p[0])), y1: fmt(Y(p[1])), x2: fmt(X(p[2])), y2: fmt(Y(p[3])) } };
    }
    case "polyline":
    case "polygon": {
      const nums = (a.points ?? "").match(/[-+]?(?:\d*\.\d+|\d+\.?\d*)(?:e[-+]?\d+)?/gi)?.map(Number) ?? [];
      if (nums.length < 2) return null;
      const out: string[] = [];
      for (let i = 0; i + 1 < nums.length; i += 2) out.push(`${fmt(X(nums[i]))},${fmt(Y(nums[i + 1]))}`);
      return { attrs: { points: out.join(" ") } };
    }
    case "path":
      return a.d ? { attrs: { d: mapPath(a.d, (x, y) => [X(x), Y(y)], sx, sy) } } : null;
    case "text": {
      // Words move by their x and y; resizing them (or words placed letter by letter) takes a transform.
      if (scaled || /\b(x|y|dx|dy)=/.test(n.text ?? "")) return null;
      const xy = many(["x", 0], ["y", 0]);
      if (!xy) return null;
      return { attrs: { x: fmt(X(xy[0])), y: fmt(Y(xy[1])) } };
    }
    default:
      return null;
  }
}

/**
 * A transform that takes a part's box from `from` to `to` (in the coordinates its transform is
 * written in, its parent's), put before the one it has. A move or resize just before is folded in.
 */
export function vectorTransform(old: string | undefined, from: Box, to: Box): string {
  let sx = near1(from.width > 1e-9 ? to.width / from.width : 1);
  let sy = near1(from.height > 1e-9 ? to.height / from.height : 1);
  let tx = to.x - from.x * sx;
  let ty = to.y - from.y * sy;
  let rest = (old ?? "").trim();
  const N = "(-?(?:\\d*\\.\\d+|\\d+\\.?\\d*)(?:e[-+]?\\d+)?)";
  const lead = new RegExp(`^translate\\(\\s*${N}(?:[\\s,]+${N})?\\s*\\)(?:\\s*scale\\(\\s*${N}(?:[\\s,]+${N})?\\s*\\))?`, "i").exec(rest);
  if (lead) {
    // T(t)·S(s) after T(a)·S(c) is T(t + s·a)·S(s·c).
    const ax = Number(lead[1]);
    const ay = Number(lead[2] ?? 0);
    const cx = lead[3] !== undefined ? Number(lead[3]) : 1;
    const cy = lead[3] !== undefined ? Number(lead[4] ?? lead[3]) : 1;
    tx += sx * ax;
    ty += sy * ay;
    sx *= cx;
    sy *= cy;
    rest = rest.slice(lead[0].length).trim();
  }
  sx = near1(sx);
  sy = near1(sy);
  const t = `translate(${fmt(tx)} ${fmt(ty)})${sx !== 1 || sy !== 1 ? ` scale(${fmt(sx)} ${fmt(sy)})` : ""}`;
  return rest ? `${t} ${rest}` : t;
}

/** Plain words of some HTML, for names and searches. */
export function plainText(html: string | undefined): string {
  return decodeEntities((html ?? "").replace(/<br\s*\/?>/gi, " ").replace(/<[^>]*>/g, "")).replace(/\s+/g, " ").trim();
}

// ---------------------------------------------------------------------------------------------
// HTML → layers

/** What a tag looks like when the HTML doesn't say (browsers' defaults that matter for a design). */
const TAG_TEXT: Record<string, Style> = {
  h1: { fontSize: "32px", fontWeight: "700" },
  h2: { fontSize: "24px", fontWeight: "700" },
  h3: { fontSize: "20px", fontWeight: "700" },
  h4: { fontSize: "16px", fontWeight: "700" },
  h5: { fontSize: "14px", fontWeight: "700" },
  h6: { fontSize: "12px", fontWeight: "700" },
  b: { fontWeight: "700" },
  strong: { fontWeight: "700" },
  i: { fontStyle: "italic" },
  em: { fontStyle: "italic" },
  u: { textDecoration: "underline" },
  s: { textDecoration: "line-through" },
  del: { textDecoration: "line-through" },
  code: { fontFamily: "ui-monospace, Menlo, monospace" },
  kbd: { fontFamily: "ui-monospace, Menlo, monospace" },
  small: { fontSize: "0.83em" },
  mark: { backgroundColor: "#fff3a3" },
  sub: { verticalAlign: "sub", fontSize: "0.75em" },
  sup: { verticalAlign: "super", fontSize: "0.75em" },
};

const SKIP = new Set(["script", "style", "head", "meta", "link", "title", "template", "noscript", "base"]);
const LAYER_NAMES: Record<string, string> = {
  header: "Header", nav: "Nav", footer: "Footer", main: "Main", section: "Section", aside: "Aside", article: "Article", form: "Form",
  button: "Button", a: "Link", ul: "List", ol: "List", li: "Item", figure: "Figure", table: "Table", label: "Label", hr: "Divider",
};
/** Displays that flow like a block (stacked) or inline (in a line of text): a frame takes these as a column. */
const FLOWING = new Set(["", "block", "inline", "inline-block", "list-item", "flow-root", "contents", "table", "table-row", "table-cell"]);

export interface Imported {
  /** The top-level layers, in order. */
  roots: string[];
  nodes: Record<string, BoardNode>;
  warnings: string[];
}

function isInlineOnly(el: HEl): boolean {
  return el.children.every((c) => typeof c === "string" || (INLINE.has(c.tag) && isInlineOnly(c)));
}
function hasWords(el: HEl): boolean {
  return el.children.some((c) => (typeof c === "string" ? c.trim() !== "" : hasWords(c)));
}

function nameFor(el: HEl, fallback: string, words?: string): string {
  const given = el.attrs["data-name"] || el.attrs["aria-label"] || el.attrs.alt || el.attrs.title || el.attrs.id;
  if (given) return given.slice(0, 60);
  if (words) return words.length > 40 ? words.slice(0, 39) + "…" : words;
  return LAYER_NAMES[el.tag] ?? fallback;
}

/**
 * Turn HTML into board layers. Inline styles (style="…") are the design: class names and <style>
 * blocks aren't read. Elements holding only words (and inline tags) become text layers; <img> an
 * image, <svg> a vector; everything else a frame. A frame that flowed as a block becomes a flex
 * column, so it can be edited like the rest (and looks the same).
 */
export function htmlToNodes(html: string, opts: { wholeSvg?: boolean } = {}): Imported {
  const doc = parseHtml(html);
  const nodes: Record<string, BoardNode> = {};
  const warnings: string[] = [];
  let classes = 0;
  let styles = 0;
  const findBody = (el: HEl): HEl | undefined => {
    for (const c of el.children) {
      if (typeof c === "string") continue;
      if (c.tag === "body") return c;
      const b = c.tag === "html" ? findBody(c) : undefined;
      if (b) return b;
    }
    return undefined;
  };
  const top = findBody(doc) ?? doc;

  const add = (node: Omit<BoardNode, "id">): string => {
    const id = newId();
    nodes[id] = { id, ...node };
    return id;
  };

  const convert = (el: HEl, parent: string | null, inFlowColumn: boolean): string | undefined => {
    if (SKIP.has(el.tag)) {
      if (el.tag === "style") styles++;
      return undefined;
    }
    if (el.tag === "br" || el.tag === "wbr") return undefined;
    if (el.attrs.class) classes++;
    const own = gridLonghands(parseStyle(el.attrs.style));
    if (own.display === "none") return undefined;
    // Something that sat in a line (inline, inline-block) keeps its own width when its parent becomes a column.
    const inlineLevel = INLINE.has(el.tag) ? !own.display || own.display.startsWith("inline") : (own.display ?? "").startsWith("inline");
    const style: Style = { ...own };
    if (inFlowColumn && inlineLevel && !style.alignSelf) style.alignSelf = "flex-start";

    // A shader: a frame with one (<div data-shader> as boards write it), or <canvas data-shader> (see
    // the Shaders section). With nothing else in it, it gets a size of its own; with layers, it's a
    // frame like any other, its shader behind them.
    let shader: ShaderSpec | undefined;
    if (isShaderElement(el)) {
      if (style.isolation === "isolate") delete style.isolation;
      const inner = shaderInner(el);
      if (el.tag === "canvas" || !inner.some((c) => typeof c !== "string" || c.trim())) return add(shaderLayer(el, parent, style, warnings));
      shader = shaderOf(el, warnings);
      el = { ...el, children: inner };
    }
    if (el.tag === "img") {
      if (!style.objectFit && style.width && style.height) style.objectFit = "cover";
      for (const k of ["width", "height"] as const) if (!style[k] && pxValue(el.attrs[k]) !== undefined) style[k] = `${pxValue(el.attrs[k])}px`;
      return add({ type: "image", name: nameFor(el, "Image"), parent, style, src: el.attrs.src ?? "" });
    }
    if (el.tag === "video") {
      // As HTML has it: autoplay, loop and muted when the tag says so. Its file is the src, or its first <source>.
      if (!style.objectFit && style.width && style.height) style.objectFit = "cover";
      for (const k of ["width", "height"] as const) if (!style[k] && pxValue(el.attrs[k]) !== undefined) style[k] = `${pxValue(el.attrs[k])}px`;
      const source = el.children.find((c): c is HEl => typeof c !== "string" && c.tag === "source" && Boolean(c.attrs.src));
      const has = (k: string) => k in el.attrs && el.attrs[k] !== "false";
      return add({
        type: "video",
        name: nameFor(el, "Video"),
        parent,
        style,
        src: el.attrs.src ?? source?.attrs.src ?? "",
        ...(el.attrs.poster ? { poster: el.attrs.poster } : {}),
        video: { autoplay: has("autoplay"), loop: has("loop"), muted: has("muted") },
      });
    }
    if (el.tag === "svg") {
      el = inlineSvgStyles(el, warnings);
      const view = (el.attrs.viewBox ?? el.attrs.viewbox ?? "").split(/[\s,]+/).map(Number);
      const w = pxValue(el.attrs.width) ?? (view.length === 4 && view[2] > 0 ? view[2] : 24);
      const h = pxValue(el.attrs.height) ?? (view.length === 4 && view[3] > 0 ? view[3] : 24);
      if (!style.width) style.width = `${w}px`;
      if (!style.height) style.height = `${h}px`;
      const name = nameFor(el, w <= 48 && h <= 48 ? "Icon" : "Vector");
      // Its parts become layers of their own, unless it has none to speak of (or far too many).
      const parts = svgPartCount(el);
      if (!opts.wholeSvg && parts > 0 && parts <= MAX_VECTOR_PARTS) {
        const t = svgNodes(el, parent, style, name);
        Object.assign(nodes, t.nodes);
        return t.id;
      }
      const attrs = { ...el.attrs };
      delete attrs.style;
      delete attrs.class;
      return add({ type: "svg", name, parent, style, svg: serializeSvg({ ...el, attrs }) });
    }
    if (el.tag === "input" || el.tag === "textarea" || el.tag === "select") {
      const words = el.attrs.value || (el.tag === "textarea" ? el.children.join("") : "") || el.attrs.placeholder || "";
      if (!el.attrs.value && el.attrs.placeholder && !style.color) style.color = "#9a9aa3";
      return add({ type: "text", name: nameFor(el, "Input"), parent, style, text: escText(words) });
    }
    if (el.tag === "hr") {
      return add({ type: "frame", name: nameFor(el, "Divider"), parent, style: { alignSelf: "stretch", height: "1px", backgroundColor: "#e4e4e7", flexShrink: "0", ...style }, children: [] });
    }
    // Words (with inline tags) are a text layer, unless the element lays its children out itself.
    const laysOut = /^(inline-)?(flex|grid)$/.test(own.display ?? "");
    if (!laysOut && !shader && isInlineOnly(el) && hasWords(el)) {
      const text = inlineHtml(el.children);
      return add({ type: "text", name: nameFor(el, "Text", plainText(text)), parent, style: { ...TAG_TEXT[el.tag], ...style }, text });
    }
    // A frame. Block flow becomes a column, so its children stack as they did.
    if (FLOWING.has(style.display ?? "")) {
      style.display = "flex";
      if (!style.flexDirection) style.flexDirection = "column";
    } else if (style.display === "inline-flex") style.display = "flex";
    else if (style.display === "inline-grid") style.display = "grid";
    const id = add({ type: "frame", name: nameFor(el, shader ? shaderName(el, shader) : "Frame"), parent, style, children: [], ...(shader ? { shader } : {}) });
    const column = style.display === "flex" && (style.flexDirection ?? "row").startsWith("column");
    const kids: string[] = [];
    // Words between blocks become text layers of their own.
    let run: HNode[] = [];
    const flush = () => {
      if (run.some((c) => (typeof c === "string" ? c.trim() : hasWords(c)))) {
        const text = inlineHtml(run);
        kids.push(add({ type: "text", name: nameFor({ tag: "span", raw: "span", attrs: {}, children: [] }, "Text", plainText(text)), parent: id, style: {}, text }));
      }
      run = [];
    };
    // In a flex or grid frame as written, every child is an item of its own; in block flow, words
    // and plain inline tags run together into one text layer, as they read.
    for (const c of el.children) {
      const plain = typeof c === "string" || (INLINE.has(c.tag) && isInlineOnly(c) && !c.attrs.style && c.tag !== "a");
      if (plain && !laysOut) {
        run.push(c);
        continue;
      }
      flush();
      if (typeof c === "string") {
        run.push(c);
        flush();
        continue;
      }
      // What a mask shows, as boards write it out: its layers are this frame's own.
      if (c.attrs["data-mask-scope"] !== undefined) {
        for (const inner of c.children) if (typeof inner !== "string") for (const g of inner.children) if (typeof g !== "string") kids.push(...[convert(g, id, column)].filter((x): x is string => Boolean(x)));
        continue;
      }
      const k = convert(c, id, column);
      if (k) {
        const fx = effectsFromAttrs(c.attrs, warnings);
        if (fx) nodes[k].effects = fx;
        kids.push(maskFromHtml(nodes[k], c));
      }
    }
    flush();
    nodes[id].children = kids;
    importCssMask(nodes, id);
    return id;
  };

  const roots: string[] = [];
  let loose: HNode[] = [];
  const flushLoose = () => {
    if (loose.some((c) => (typeof c === "string" ? c.trim() : hasWords(c)))) {
      const text = inlineHtml(loose);
      roots.push(add({ type: "text", name: plainText(text).slice(0, 40) || "Text", parent: null, style: {}, text }));
    }
    loose = [];
  };
  for (const c of top.children) {
    if (typeof c === "string" || (INLINE.has(c.tag) && isInlineOnly(c) && !c.attrs.style)) {
      loose.push(c);
      continue;
    }
    flushLoose();
    const id = convert(c, null, false);
    // (A mask written as a top-level element is one when the HTML goes into a frame.)
    if (id) {
      const fx = effectsFromAttrs(c.attrs, warnings);
      if (fx) nodes[id].effects = fx;
      roots.push(maskFromHtml(nodes[id], c));
    }
  }
  flushLoose();
  if (classes) warnings.push(`${classes} element${classes === 1 ? "" : "s"} had class names. Boards read inline styles only (style="…"), so those classes did nothing: give the styles inline.`);
  if (styles) warnings.push(`<style> blocks are not read: put each element's styles in its style attribute.`);
  return { roots, nodes, warnings };
}

// ---------------------------------------------------------------------------------------------
// Layers → HTML

export interface HtmlOptions {
  /** Put data-id (and data-name) on every element, so the HTML can be matched to layers. */
  ids?: boolean;
  /** Turn an image's src into a loadable URL (a file path becomes a file:// or /file URL). */
  src?: (src: string) => string;
  /** Keep a top-level layer's place on the page (left/top). Off, it starts at 0,0. */
  placed?: boolean;
  /** Include hidden layers (shown hidden). */
  hidden?: boolean;
  /** Draw a video as its still (its first frame), for pictures: exports, thumbnails, screenshots. */
  still?: boolean;
  /** Carry each shader's GLSL and what to draw it with, for a page that plays it (Preview, exports, Copy as HTML). */
  code?: boolean;
}

/** CSS with each url(…) passed through `fn` (a local path made a loadable URL). */
export function mapCssUrls(value: string, fn: (src: string) => string): string {
  return value.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g, (_, _q: string, src: string) => `url("${fn(src.trim())}")`);
}

export function nodeHtml(board: Board, id: string, opts: HtmlOptions = {}, depth = 0): string {
  const n = board.nodes[id];
  if (!n || (n.hidden && !opts.hidden)) return "";
  const style: Style = { ...n.style };
  if (opts.src) for (const [k, v] of Object.entries(style)) if (v.includes("url(")) style[k] = mapCssUrls(v, opts.src);
  if (n.parent === null && depth === 0 && !opts.placed) {
    delete style.left;
    delete style.top;
    if (style.position === "absolute") delete style.position;
  }
  if (n.hidden) style.display = "none";
  // A mask isn't drawn: its look is the mask of the layers after it (see childrenHtml).
  if (n.mask && maskActive(board, id)) style.visibility = "hidden";
  // A shader is drawn on a canvas behind the frame's layers: the frame holds it (see shaders.ts).
  if (n.shader && n.type === "frame") Object.assign(style, shaderBoxStyle(style));
  const css = styleText(style);
  const attrs = `${opts.ids ? ` data-id="${id}" data-name="${escAttr(n.name)}"${n.isComponent ? " data-component" : ""}${n.instanceOf ? ` data-copy-of="${n.instanceOf}"` : ""}` : ""}${n.mask ? ` data-mask="${n.mask}"` : ""}${effectsAttrs(n.effects)}${css ? ` style="${escAttr(css)}"` : ""}`;
  switch (n.type) {
    case "text":
      return `<div${attrs}>${n.text ?? ""}</div>`;
    case "image": {
      const src = n.src ? (opts.src ? opts.src(n.src) : n.src) : "";
      return `<img${attrs} src="${escAttr(src)}" alt="${escAttr(n.name)}">`;
    }
    case "video": {
      const url = (s: string | undefined) => (s ? (opts.src ? opts.src(s) : s) : "");
      if (opts.still) return n.poster ? `<img${attrs} src="${escAttr(url(n.poster))}" alt="${escAttr(n.name)}">` : `<div${attrs}></div>`;
      const v = videoSettings(n);
      return `<video${attrs} src="${escAttr(url(n.src))}"${n.poster ? ` poster="${escAttr(url(n.poster))}"` : ""}${v.autoplay ? " autoplay" : ""}${v.loop ? " loop" : ""}${v.muted ? " muted" : ""} playsinline preload="metadata"></video>`;
    }
    case "svg": {
      const inner = `display:block;width:100%;height:100%${n.style.overflow ? `;overflow:${n.style.overflow}` : ""}`;
      // Its pictures (<image href>) load as an image layer's do.
      const pics = (s: string) => (opts.src ? mapSvgImages(s, opts.src) : s);
      if (n.svg) return `<div${attrs}>${pics(n.svg).replace(/^<svg\b/i, `<svg style="${inner}"`)}</div>`;
      const kids = (n.children ?? []).map((c) => nodeHtml(board, c, opts, depth + 1)).join("");
      return `<div${attrs}><svg xmlns="http://www.w3.org/2000/svg"${attrText(n.attrs)} style="${inner}">${n.defs ? `<defs>${pics(n.defs)}</defs>` : ""}${kids}</svg></div>`;
    }
    case "vector": {
      const tag = vectorTag(n.tag);
      const inner = tag === "g" ? (n.children ?? []).map((c) => nodeHtml(board, c, opts, depth + 1)).join("") : opts.src ? mapSvgImages(n.text ?? "", opts.src) : (n.text ?? "");
      return `<${tag}${attrs}${attrText(opts.src ? svgImageAttrs(tag, n.attrs, opts.src) : n.attrs)}>${inner}</${tag}>`;
    }
    default:
      if (n.shader) return `<div${attrs}${shaderAttrs(n.shader, board.shaders, { code: opts.code })}>${shaderCanvas(n.shader)}${childrenHtml(board, n.children ?? [], opts, depth)}</div>`;
      return `<div${attrs}>${childrenHtml(board, n.children ?? [], opts, depth)}</div>`;
  }
}

/** The CSS every board is drawn with, in the Studio and in exports alike. */
export const BOARD_CSS =
  "*,*::before,*::after{box-sizing:border-box}img,video{display:block}" +
  // What a mask shows is drawn over the frame: clicks go through it to the layers it shows, and to those below.
  "[data-mask-scope]{pointer-events:none}[data-mask-scope]>*>*{pointer-events:auto}";

/** A token's name as CSS has it: "--brand" (a name given as "brand" gets its dashes). */
export const tokenName = (name: string) => (name.trim().startsWith("--") ? name.trim() : `--${name.trim()}`);

/**
 * Steps that rename a token and every var() that uses it, as one change: layers' CSS, coloured words,
 * vectors (attributes, gradients, markup), shapes' settings, and other tokens that point at it. They
 * are the component's own, not changes made in its copies, so copies keep following their component.
 */
export function renameTokenOps(board: Board, from: string, to: string): Op[] {
  const a = tokenName(from);
  const z = tokenName(to);
  const at = board.tokens.findIndex((t) => t.name === a);
  if (at < 0) throw new OpError(`There's no token ${a} on this board.`);
  if (!/^--[A-Za-z0-9_-]+$/.test(z)) throw new OpError(`"${to}" can't be a token name: use letters, digits, - and _.`);
  if (a === z) return [];
  if (board.tokens.some((t) => t.name === z)) throw new OpError(`There's a token ${z} already.`);
  // var(--brand) and var(--brand, …), but not var(--brand-2).
  const re = new RegExp(`var\\(\\s*${a.replace(/[-]/g, "\\-")}(?=\\s*[,)])`, "g");
  const swap = (v: string) => v.replace(re, `var(${z}`);
  const ops: Op[] = [{ op: "token", name: z, value: board.tokens[at].value, index: at }];
  for (const n of Object.values(board.nodes)) {
    const p: Extract<Op, { op: "set" }> = { op: "set", id: n.id, sync: true };
    for (const [k, v] of Object.entries(n.style)) if (swap(v) !== v) (p.style ??= {})[k] = swap(v);
    for (const [k, v] of Object.entries(n.attrs ?? {})) if (swap(v) !== v) (p.attrs ??= {})[k] = swap(v);
    for (const f of ["text", "svg", "defs"] as const) if (n[f] && swap(n[f]!) !== n[f]) p[f] = swap(n[f]!);
    if (n.shape && JSON.stringify(n.shape).includes("var(")) {
      const shape = Object.fromEntries(Object.entries(n.shape).map(([k, v]) => [k, typeof v === "string" ? swap(v) : v]));
      if (JSON.stringify(shape) !== JSON.stringify(n.shape)) p.shape = shape;
    }
    if (Object.keys(p).length > 3) ops.push(p);
  }
  for (const t of board.tokens) if (t.name !== a && swap(t.value) !== t.value) ops.push({ op: "token", name: t.name, value: swap(t.value) });
  ops.push({ op: "token", name: a, value: null });
  return ops;
}

// ---------------------------------------------------------------------------------------------
// Scale: a layer made bigger or smaller with everything in it (type, padding, gaps, corners,
// borders, shadows), as Figma's Scale tool does, where resizing only changes the box.

/** Properties that are one length (or a few), where a token can be scaled as calc(var(--x) * k). */
const LENGTH_PROP = /^(width|height|(min|max)(Width|Height)|left|top|right|bottom|inset|padding\w*|margin\w*|gap|rowGap|columnGap|fontSize|letterSpacing|wordSpacing|textIndent|border\w*Radius|border\w*Width|outlineWidth|outlineOffset|flexBasis)$/;
/** Where a layer sits in its parent: the one thing about the layer being scaled that stays (its corner is placed by whoever scales it). */
const PLACE_PROP = new Set(["left", "top", "right", "bottom", "inset"]);
const NUM = (n: number) => String(Math.round(n * 100) / 100);
/** var(--x) or var(--x, fallback), and calc(var(--x) * n) as written by an earlier scale. */
const VAR_RE = /calc\(\s*(var\(\s*(--[\w-]+)(?:\s*,[^()]*(?:\([^()]*\)[^()]*)*)?\))\s*\*\s*(\d*\.?\d+)\s*\)|var\(\s*(--[\w-]+)(?:\s*,[^()]*(?:\([^()]*\)[^()]*)*)?\)/g;

/**
 * Lengths in CSS text multiplied by `k`: numbers in px, pt or rem, not inside url(…), quotes or a
 * name (--gap-8px). Relative ones (em, %, vw) follow by themselves.
 */
export function scaleLengths(css: string, k: number): string {
  return css.replace(/url\([^)]*\)|"[^"]*"|'[^']*'|(?<![\w.-])(-?(?:\d+\.?\d*|\.\d+))(px|pt|rem)\b/gi, (m, n?: string, unit?: string) => (n === undefined ? m : `${NUM(Number(n) * k)}${unit}`));
}

/**
 * One property's value scaled by `k`. A token in a length (padding: var(--space)) becomes
 * calc(var(--space) * k), so it still follows the token; `own` are custom properties set inside
 * what's scaled, which scale where they're set instead.
 */
export function scaleCss(prop: string, value: string, k: number, own: Set<string> = new Set()): string {
  const kept: string[] = [];
  const hold = (s: string) => `\u0000${kept.push(s) - 1}\u0000`;
  const length = LENGTH_PROP.test(prop);
  const marked = value.replace(VAR_RE, (m, inner?: string, name1?: string, times?: string, name2?: string) => {
    const name = name1 ?? name2!;
    if (!length || own.has(name)) return hold(m);
    return hold(inner ? `calc(${inner} * ${NUM(Number(times) * k)})` : `calc(${m} * ${NUM(k)})`);
  });
  return scaleLengths(marked, k).replace(/\u0000(\d+)\u0000/g, (_, i: string) => kept[Number(i)]);
}

/** Inline HTML (a text layer's words) with the lengths in its style attributes scaled. */
function scaleInline(htmlText: string, k: number): string {
  return htmlText.replace(/(\sstyle=")([^"]*)(")/g, (_m, a: string, css: string, c: string) => {
    const plain = css.replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&amp;/g, "&");
    return a + escAttr(scaleLengths(plain, k)) + c;
  });
}

/** What a layer gets from outside it that a scale has to carry: type size, spacing, line height. */
export interface Inherited {
  /** The layer's font size in px, as drawn (the Studio measures it; otherwise worked out from the layers holding it). */
  fontSize?: number;
  /** Its letter spacing in px (inherited as a length, so it doesn't follow the font size). */
  letterSpacing?: number;
}

/** A length in px from CSS written in px or rem (rem as 16px). */
const absPx = (v: string | undefined) => {
  const m = v && /^\s*(-?\d*\.?\d+)(px|rem)?\s*$/i.exec(v);
  return m ? Number(m[1]) * (m[2]?.toLowerCase() === "rem" ? 16 : 1) : undefined;
};

/**
 * Steps that scale a layer and everything in it by `k` (1.5 is half as big again), as Figma's Scale
 * tool does: every length in its CSS, the type in its words, tokens through calc(). Where it sits
 * (left, top) stays: the caller places its anchor. A vector part (in an SVG's own coordinates) and
 * an SVG's insides follow their box, so only the box is scaled.
 */
export function scaleOps(board: Board, id: string, k: number, inherited: Inherited = {}): Op[] {
  const root = board.nodes[id];
  if (!root || !Number.isFinite(k) || k <= 0 || Math.abs(k - 1) < 1e-6) return [];
  const ids: string[] = [];
  const walk = (x: string) => {
    const n = board.nodes[x];
    if (!n) return;
    ids.push(x);
    if (n.type === "svg" || n.type === "vector") return;
    for (const c of n.children ?? []) walk(c);
  };
  walk(id);
  const own = new Set<string>();
  for (const x of ids) for (const p of Object.keys(board.nodes[x].style)) if (p.startsWith("--")) own.add(p);
  const ops: Array<Extract<Op, { op: "set" }>> = [];
  let words = false;
  let relative = false;
  for (const x of ids) {
    const n = board.nodes[x];
    if (n.type === "text") words = true;
    const style: Record<string, string> = {};
    for (const [p, v] of Object.entries(n.style)) {
      if (x === id && PLACE_PROP.has(p)) continue;
      if (typeof v !== "string") continue;
      if (/\d(em|ex|ch)\b/.test(v)) relative = true;
      const out = scaleCss(p, v, k, own);
      if (out !== v) style[p] = out;
    }
    const op: Extract<Op, { op: "set" }> = { op: "set", id: x, ...(Object.keys(style).length ? { style } : {}) };
    if (n.type === "text" && n.text) {
      const t = scaleInline(n.text, k);
      if (t !== n.text) op.text = t;
    }
    // A shader's lengths (a halftone's spacing, a dither's pixel) scale with it.
    if (n.shader) {
      const sh = scaledShader(n.shader, shaderCode(n.shader, board.shaders), k);
      if (sh) op.shader = sh;
    }
    if (n.effects) {
      const fx = scaledEffects(n.effects, k);
      if (fx) op.effects = fx;
    }
    if (op.style || op.text !== undefined || op.shader || op.effects) ops.push(op);
  }
  // Type and spacing the layer only inherits don't change with it: it gets them, scaled, of its own.
  if (words || relative) {
    const up = ancestors(board, id).map((a) => board.nodes[a]?.style ?? {});
    const first = (p: string) => up.find((s) => s[p] !== undefined)?.[p];
    if (ops[0]?.id !== id) ops.unshift({ op: "set", id });
    const set = ops[0];
    const mine = root.style;
    // No size of its own, or one relative to what it inherits (1.2em, 120%): written in px, scaled.
    if (absPx(mine.fontSize) === undefined && !/var\(/.test(mine.fontSize ?? "")) {
      const rel = /^\s*(\d*\.?\d+)(em|%)\s*$/.exec(mine.fontSize ?? "");
      const parent = absPx(first("fontSize")) ?? 16;
      const drawn = inherited.fontSize ?? (rel ? (parent * Number(rel[1])) / (rel[2] === "%" ? 100 : 1) : parent);
      (set.style ??= {}).fontSize = `${NUM(drawn * k)}px`;
    }
    if (mine.lineHeight === undefined) {
      const lh = absPx(first("lineHeight"));
      if (lh !== undefined) (set.style ??= {}).lineHeight = `${NUM(lh * k)}px`;
    }
    if (mine.letterSpacing === undefined) {
      const ls = inherited.letterSpacing ?? absPx(first("letterSpacing"));
      if (ls) (set.style ??= {}).letterSpacing = `${NUM(ls * k)}px`;
    }
    if (!set.style && set.text === undefined) ops.shift();
  }
  return ops;
}

export function tokenCss(board: Board): string {
  return board.tokens.map((t) => `${t.name}:${t.value}`).join(";");
}

const fontKey = (f: BoardFont) => [f.family.toLowerCase(), f.weight ?? "", f.style ?? "", f.stretch ?? "", f.unicodeRange ?? ""].join("|");
const FONT_FORMAT: Record<string, string> = { woff2: "woff2", woff: "woff", ttf: "truetype", otf: "opentype" };

/** The board's own typefaces as @font-face rules, their files from `src` (a URL the page can load). */
export function fontFaceCss(board: Board, src: (file: string) => string): string {
  const q = (v: string) => `"${v.replace(/["\\\n]/g, "")}"`;
  return (board.fonts ?? [])
    .map((f) => {
      const ext = /\.(\w+)(?:[?#]|$)/.exec(f.src)?.[1]?.toLowerCase() ?? "";
      const format = FONT_FORMAT[ext] ? ` format("${FONT_FORMAT[ext]}")` : "";
      const parts = [`font-family:${q(f.family)}`, `src:url(${q(src(f.src))})${format}`, `font-display:block`];
      if (f.weight && /^[\d\s]+$|^(normal|bold)$/.test(f.weight)) parts.push(`font-weight:${f.weight}`);
      if (f.style && /^(normal|italic|oblique)/.test(f.style)) parts.push(`font-style:${f.style}`);
      if (f.stretch && /^(ultra|extra|semi)?-?(condensed|expanded)|normal|\d+%$/.test(f.stretch)) parts.push(`font-stretch:${f.stretch}`);
      if (f.unicodeRange && /^[U+0-9A-Fa-f?,\s-]+$/.test(f.unicodeRange)) parts.push(`unicode-range:${f.unicodeRange}`);
      return `@font-face{${parts.join(";")}}`;
    })
    .join("");
}

/** The font families a set of layers uses (the first name of each font-family list). */
export function fontFamilies(board: Board, ids: string[]): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  const note = (family: string | undefined, weight: string | undefined) => {
    if (!family) return;
    const first = family.split(",")[0].trim().replace(/^["']|["']$/g, "");
    if (!first || GENERIC_FONTS.has(first.toLowerCase())) return;
    const set = out.get(first) ?? new Set<string>();
    if (weight && /^\d{3}$/.test(weight) && weight !== "400") set.add(weight);
    out.set(first, set);
  };
  const tokenFonts = new Map(board.tokens.map((t) => [t.name, t.value]));
  const resolve = (v: string | undefined) => (v && /^var\(--/.test(v) ? tokenFonts.get(/var\((--[^,)]+)/.exec(v)?.[1] ?? "") ?? v : v);
  const walk = (id: string, family?: string) => {
    const n = board.nodes[id];
    if (!n) return;
    const f = resolve(n.style.fontFamily) ?? family;
    if (n.type === "text") {
      note(f, resolve(n.style.fontWeight));
      for (const m of (n.text ?? "").matchAll(/font-family:\s*([^;"]+)/g)) note(m[1], undefined);
      for (const m of (n.text ?? "").matchAll(/font-weight:\s*(\d{3})/g)) note(f, m[1]);
    }
    for (const c of n.children ?? []) walk(c, f);
  };
  for (const id of ids) walk(id);
  return out;
}

export const GENERIC_FONTS = new Set([
  "serif", "sans-serif", "monospace", "cursive", "fantasy", "system-ui", "ui-sans-serif", "ui-serif", "ui-monospace", "ui-rounded", "-apple-system",
  "blinkmacsystemfont", "sf pro", "sf pro display", "sf pro text", "sf pro rounded", "sf mono", "new york", "helvetica", "helvetica neue", "arial",
  "menlo", "monaco", "courier", "courier new", "georgia", "times", "times new roman", "avenir", "avenir next", "futura", "gill sans", "optima",
  "palatino", "baskerville", "didot", "american typewriter", "inherit", "initial",
]);

/**
 * Google Fonts stylesheets for families the Mac may not have. A family Google doesn't know just doesn't
 * load. Families the board carries itself (`own`, from board.fonts) aren't asked for.
 */
export function fontLinks(families: Map<string, Set<string>>, own: BoardFont[] = []): string[] {
  const links: string[] = [];
  const carried = new Set(own.map((f) => f.family.toLowerCase()));
  for (const [family, weights] of families) {
    if (carried.has(family.toLowerCase())) continue;
    const name = encodeURIComponent(family).replace(/%20/g, "+");
    links.push(`https://fonts.googleapis.com/css2?family=${name}&display=block`);
    for (const w of weights) links.push(`https://fonts.googleapis.com/css2?family=${name}:wght@${w}&display=block`);
  }
  return links;
}

// ---------------------------------------------------------------------------------------------
// Looking around a board

export function pageOf(board: Board, id: string): BoardPage | undefined {
  const root = rootOf(board, id);
  return board.pages.find((p) => p.children.includes(root));
}

export function rootOf(board: Board, id: string): string {
  let n = board.nodes[id];
  let guard = 0;
  while (n?.parent && guard++ < 1000) n = board.nodes[n.parent];
  return n?.id ?? id;
}

export function ancestors(board: Board, id: string): string[] {
  const out: string[] = [];
  let n = board.nodes[id];
  let guard = 0;
  while (n?.parent && guard++ < 1000) {
    out.push(n.parent);
    n = board.nodes[n.parent];
  }
  return out;
}

/** A layer and everything inside it, depth first. */
export function subtree(board: Board, id: string): string[] {
  const out: string[] = [];
  const walk = (x: string) => {
    if (!board.nodes[x]) return;
    out.push(x);
    for (const c of board.nodes[x].children ?? []) walk(c);
  };
  walk(id);
  return out;
}

export function siblingsOf(board: Board, id: string): string[] {
  const n = board.nodes[id];
  if (!n) return [];
  return n.parent ? board.nodes[n.parent]?.children ?? [] : pageOf(board, id)?.children ?? [];
}

export const isFlex = (n: BoardNode | undefined) => Boolean(n && n.type === "frame" && (n.style.display === "flex" || n.style.display === "inline-flex"));
export const isGrid = (n: BoardNode | undefined) => Boolean(n && n.type === "frame" && (n.style.display === "grid" || n.style.display === "inline-grid"));

/** Whether a layer is placed by its parent's layout (flex or grid) rather than by its own left/top. */
export function inFlow(board: Board, id: string): boolean {
  const n = board.nodes[id];
  if (!n?.parent) return false;
  const p = board.nodes[n.parent];
  return (isFlex(p) || isGrid(p)) && n.style.position !== "absolute" && n.style.position !== "fixed";
}

/** A copy of a layer and everything in it, with new ids. */
export function cloneTree(board: Board, id: string, parent: string | null = null): { id: string; nodes: Record<string, BoardNode>; map: Record<string, string> } {
  const nodes: Record<string, BoardNode> = {};
  const map: Record<string, string> = {};
  const copy = (x: string, p: string | null): string => {
    const n = board.nodes[x];
    const nid = newId();
    map[x] = nid;
    nodes[nid] = { ...n, id: nid, parent: p, style: { ...n.style }, ...(n.children ? { children: [] } : {}), ...(n.attrs ? { attrs: { ...n.attrs } } : {}) };
    if (n.children) nodes[nid].children = n.children.filter((c) => board.nodes[c]).map((c) => copy(c, nid));
    return nid;
  };
  const root = copy(id, parent);
  return { id: root, nodes, map };
}

/** Where a new artboard of this size can go on a page without covering another: to the right of the rest. */
export function freeSpot(board: Board, pageId: string, width: number, gap = 120): { left: number; top: number } {
  const page = board.pages.find((p) => p.id === pageId);
  let right = -Infinity;
  let top = Infinity;
  for (const id of page?.children ?? []) {
    const s = board.nodes[id]?.style;
    if (!s) continue;
    const l = pxValue(s.left) ?? 0;
    const w = pxValue(s.width) ?? 400;
    right = Math.max(right, l + w);
    top = Math.min(top, pxValue(s.top) ?? 0);
  }
  void width;
  return Number.isFinite(right) ? { left: Math.round(right + gap), top: Math.round(top) } : { left: 0, top: 0 };
}

// ---------------------------------------------------------------------------------------------
// Changing a board: every change is a list of steps, and each step knows how to undo itself.

export type Op =
  /** Put new layers (`nodes` holds them and everything inside them) into a frame, or on a page. */
  /**
   * `place`: new artboards (on the page) go to the free space beside the others, found when the
   * change is applied (under the board's lock, against the board as it is then), so two agents
   * adding artboards at once don't put them on top of each other. Their places relative to each
   * other are kept.
   */
  | { op: "add"; nodes: Record<string, BoardNode>; ids: string[]; parent: string | null; page?: string; index?: number; sync?: boolean; place?: boolean }
  /** Change a layer: style properties (null removes one), its name, words, picture, vector, visibility or lock. */
  | {
      op: "set";
      id: string;
      style?: Record<string, string | null>;
      replaceStyle?: Style;
      name?: string;
      text?: string | null;
      src?: string | null;
      poster?: string | null;
      video?: VideoSettings | null;
      svg?: string | null;
      /** A vector part's SVG attributes (null removes one). */
      attrs?: Record<string, string | null>;
      defs?: string | null;
      tag?: string | null;
      shape?: Record<string, unknown> | null;
      hidden?: boolean | null;
      locked?: boolean | null;
      isComponent?: boolean | null;
      instanceOf?: string | null;
      master?: string | null;
      overrides?: string[] | null;
      /** Use the layer as a mask of this kind (null: an ordinary layer again). */
      mask?: MaskType | null;
      /** A frame's shader fill, whole (see shaders.ts); null takes it away. */
      shader?: ShaderSpec | null;
      /** Optical & layer effects (see effects.ts); null or empty removes them. */
      effects?: LayerEffect[] | null;
      /** Made by a component for its copies (so it doesn't count as a change made in a copy). */
      sync?: boolean;
    }
  | { op: "delete"; ids: string[]; sync?: boolean }
  /** Move a layer into another frame (or onto a page), at an index among its new siblings. */
  | { op: "move"; id: string; parent: string | null; page?: string; index?: number; sync?: boolean }
  | { op: "addPage"; page: BoardPage; index?: number }
  | { op: "setPage"; id: string; name: string }
  | { op: "deletePage"; id: string }
  | { op: "movePage"; id: string; index: number }
  /** Set a design token (null removes it). */
  | { op: "token"; name: string; value: string | null; index?: number }
  /** Add a typeface to the board, or (remove) take it off. One per family, weight, style and range. */
  | { op: "font"; font: BoardFont; remove?: boolean }
  /** Save a shader as one of the board's own presets, or change one (null code removes it). */
  | { op: "shaderPreset"; name: string; code: string | null; index?: number }
  | { op: "rename"; name: string }
  /** Mark artboards as being worked on by an agent (null clears them; no ids clears all). */
  | { op: "working"; ids?: string[]; at: string | null }
  /** Remember an agent that worked on the board (and on which artboards). */
  | { op: "agent"; agent: Omit<BoardAgent, "firstAt" | "lastAt" | "artboards" | "last">; artboards?: string[]; at: string; touch?: Omit<AgentTouch, "at"> }
  /** The whole design at once (how the Studio undoes a change an agent made). */
  | { op: "replace"; pages: BoardPage[]; nodes: Record<string, BoardNode>; tokens: BoardToken[]; name?: string; shaders?: BoardShader[] };

export class OpError extends Error {}

const misplaced = (n: BoardNode) =>
  n.type === "vector" ? `${n.name} is part of a vector: it can only go inside a vector layer (or a group in one).` : `Only a vector's parts (shapes, paths, groups) go inside a vector layer; ${n.name} can go in a frame.`;

export function applyOps(input: Board, ops: Op[]): { board: Board; inverse: Op[] } {
  const board: Board = { ...input, nodes: { ...input.nodes }, pages: input.pages.slice(), tokens: input.tokens.slice() };
  const copied = new Set<string>();
  const mut = (id: string): BoardNode => {
    const n = board.nodes[id];
    if (!n) throw new OpError(`There's no layer ${id}.`);
    if (!copied.has(id)) {
      board.nodes[id] = { ...n, style: { ...n.style }, ...(n.children ? { children: n.children.slice() } : {}), ...(n.attrs ? { attrs: { ...n.attrs } } : {}) };
      copied.add(id);
    }
    return board.nodes[id];
  };
  const pageCopied = new Set<string>();
  const mutPage = (id: string): BoardPage => {
    const i = board.pages.findIndex((p) => p.id === id);
    if (i < 0) throw new OpError(`There's no page ${id}.`);
    if (!pageCopied.has(id)) {
      board.pages[i] = { ...board.pages[i], children: board.pages[i].children.slice() };
      pageCopied.add(id);
    }
    return board.pages[i];
  };
  const pageFor = (id: string): BoardPage => {
    const root = rootOf(board, id);
    const p = board.pages.find((x) => x.children.includes(root));
    if (!p) throw new OpError(`Layer ${id} isn't on a page.`);
    return p;
  };
  /** The list a layer sits in, ready to change. */
  const listOf = (parent: string | null, page: string | undefined): string[] => {
    if (parent) {
      const p = mut(parent);
      const holds = p.type === "frame" || (p.type === "svg" && !p.svg) || (p.type === "vector" && p.tag === "g");
      if (!holds) throw new OpError(`Only frames hold layers; ${p.name} is ${p.type === "text" ? "text" : p.type === "image" ? "an image" : p.type === "svg" ? "a vector drawn as one piece (split it into its parts first)" : "a part of a vector"}.`);
      p.children ??= [];
      return p.children;
    }
    const pid = page ?? board.pages[0]?.id;
    if (!pid) throw new OpError("The board has no page.");
    return mutPage(pid).children;
  };
  const where = (id: string): { parent: string | null; page?: string; index: number } => {
    const n = board.nodes[id];
    if (n.parent) return { parent: n.parent, index: (board.nodes[n.parent].children ?? []).indexOf(id) };
    const p = pageFor(id);
    return { parent: null, page: p.id, index: p.children.indexOf(id) };
  };
  const inverse: Op[][] = [];

  for (const op of ops) {
    const undo: Op[] = [];
    switch (op.op) {
      case "add": {
        const list = listOf(op.parent, op.page);
        let at = op.index === undefined || op.index < 0 || op.index > list.length ? list.length : op.index;
        if (op.place && !op.parent) {
          const pid = op.page ?? board.pages[0]?.id;
          const roots = op.ids.map((id) => op.nodes[id]).filter(Boolean);
          const left0 = Math.min(...roots.map((n) => pxValue(n.style.left) ?? 0)), top0 = Math.min(...roots.map((n) => pxValue(n.style.top) ?? 0));
          const spot = pid ? freeSpot(board, pid, 0) : { left: left0, top: top0 };
          for (const n of roots) n.style = { ...n.style, left: `${Math.round(spot.left + (pxValue(n.style.left) ?? 0) - left0)}px`, top: `${Math.round(spot.top + (pxValue(n.style.top) ?? 0) - top0)}px` };
        }
        for (const [id, n] of Object.entries(op.nodes)) {
          if (board.nodes[id]) throw new OpError(`A layer ${id} is already on the board.`);
          board.nodes[id] = n;
        }
        const holder = op.parent ? board.nodes[op.parent] : null;
        for (const id of op.ids) {
          const n = board.nodes[id];
          if (!n) throw new OpError(`The layers to add don't include ${id}.`);
          if (board.nodes[id] !== op.nodes[id]) throw new OpError(`Layer ${id} isn't one of the new layers.`);
          if (!canHold(holder, n)) throw new OpError(misplaced(n));
          board.nodes[id] = { ...n, parent: op.parent };
          list.splice(at++, 0, id);
        }
        undo.push({ op: "delete", ids: op.ids.slice(), ...(op.sync ? { sync: true } : {}) });
        break;
      }
      case "set": {
        const n = mut(op.id);
        const back: Extract<Op, { op: "set" }> = { op: "set", id: op.id };
        if (op.replaceStyle) {
          back.replaceStyle = { ...n.style };
          n.style = { ...op.replaceStyle };
        }
        if (op.style) {
          // With the whole style replaced, putting that back is the undo.
          if (!op.replaceStyle) back.style = {};
          for (const [k, v] of Object.entries(op.style)) {
            if (back.style) back.style[k] = n.style[k] ?? null;
            if (v === null || v === undefined || v === "") delete n.style[k];
            else n.style[k] = String(v);
          }
        }
        if (op.attrs) {
          back.attrs = {};
          const a = { ...(n.attrs ?? {}) };
          for (const [k, v] of Object.entries(op.attrs)) {
            back.attrs[k] = a[k] ?? null;
            if (v === null || v === undefined) delete a[k];
            else a[k] = String(v);
          }
          n.attrs = a;
        }
        if (op.name !== undefined) {
          back.name = n.name;
          n.name = op.name.slice(0, 120) || n.name;
        }
        if (op.tag !== undefined && op.tag !== null && n.type === "vector") {
          back.tag = n.tag ?? null;
          n.tag = vectorTag(op.tag);
        }
        if (op.shader && n.type !== "frame") throw new OpError(`Only frames take a shader fill; ${n.name} is ${n.type === "text" ? "text" : n.type === "image" ? "a picture" : n.type === "video" ? "a video" : "a vector"} (put it in a frame with the shader).`);
        for (const k of ["text", "src", "poster", "video", "svg", "defs", "shape", "hidden", "locked", "isComponent", "instanceOf", "master", "overrides", "mask", "shader", "effects"] as const) {
          if (op[k] === undefined) continue;
          (back as Record<string, unknown>)[k] = n[k] ?? null;
          if (k === "effects") {
            const cleaned = op.effects ? cleanEffects(op.effects) : undefined;
            if (!cleaned) delete n.effects;
            else n.effects = cleaned;
          } else if (op[k] === null || op[k] === false || (Array.isArray(op[k]) && !(op[k] as string[]).length)) delete n[k];
          else (n as unknown as Record<string, unknown>)[k] = Array.isArray(op[k]) ? (op[k] as string[]).slice() : op[k];
        }
        if (op.sync) back.sync = true;
        undo.push(back);
        break;
      }
      case "delete": {
        // Only the outermost of the layers named: the rest go with them.
        const named = new Set(op.ids.filter((id) => board.nodes[id]));
        const tops = [...named].filter((id) => !ancestors(board, id).some((a) => named.has(a)));
        for (const id of tops) {
          const w = where(id);
          const ids = subtree(board, id);
          const nodes: Record<string, BoardNode> = {};
          for (const x of ids) nodes[x] = board.nodes[x];
          listOf(w.parent, w.page).splice(w.index, 1);
          for (const x of ids) {
            delete board.nodes[x];
            copied.delete(x);
          }
          undo.unshift({ op: "add", nodes, ids: [id], parent: w.parent, page: w.page, index: w.index, ...(op.sync ? { sync: true } : {}) });
        }
        break;
      }
      case "move": {
        const n = board.nodes[op.id];
        if (!n) throw new OpError(`There's no layer ${op.id}.`);
        if (op.parent && (op.parent === op.id || ancestors(board, op.parent).includes(op.id))) throw new OpError("A layer can't go inside itself.");
        if (!canHold(op.parent ? board.nodes[op.parent] : null, n)) throw new OpError(misplaced(n));
        const w = where(op.id);
        listOf(w.parent, w.page).splice(w.index, 1);
        const list = listOf(op.parent, op.parent ? undefined : op.page ?? w.page);
        const at = op.index === undefined || op.index < 0 || op.index > list.length ? list.length : op.index;
        list.splice(at, 0, op.id);
        mut(op.id).parent = op.parent;
        undo.push({ op: "move", id: op.id, parent: w.parent, page: w.page, index: w.index, ...(op.sync ? { sync: true } : {}) });
        break;
      }
      case "addPage": {
        if (board.pages.some((p) => p.id === op.page.id)) throw new OpError("That page is already there.");
        const at = op.index === undefined ? board.pages.length : Math.max(0, Math.min(board.pages.length, op.index));
        board.pages.splice(at, 0, { ...op.page, children: [] });
        pageCopied.add(op.page.id);
        // Its layers, if it came with some, are put on it by add steps.
        undo.push({ op: "deletePage", id: op.page.id });
        break;
      }
      case "setPage": {
        const p = mutPage(op.id);
        undo.push({ op: "setPage", id: op.id, name: p.name });
        p.name = op.name.slice(0, 80) || p.name;
        break;
      }
      case "deletePage": {
        if (board.pages.length <= 1) throw new OpError("A board keeps at least one page.");
        const i = board.pages.findIndex((p) => p.id === op.id);
        if (i < 0) throw new OpError(`There's no page ${op.id}.`);
        const page = board.pages[i];
        const nodes: Record<string, BoardNode> = {};
        for (const r of page.children) for (const x of subtree(board, r)) nodes[x] = board.nodes[x];
        for (const x of Object.keys(nodes)) delete board.nodes[x];
        board.pages.splice(i, 1);
        undo.push({ op: "addPage", page: { id: page.id, name: page.name, children: [] }, index: i });
        if (page.children.length) undo.push({ op: "add", nodes, ids: page.children.slice(), parent: null, page: page.id, index: 0 });
        break;
      }
      case "movePage": {
        const i = board.pages.findIndex((p) => p.id === op.id);
        if (i < 0) throw new OpError(`There's no page ${op.id}.`);
        const [p] = board.pages.splice(i, 1);
        board.pages.splice(Math.max(0, Math.min(board.pages.length, op.index)), 0, p);
        undo.push({ op: "movePage", id: op.id, index: i });
        break;
      }
      case "token": {
        const name = op.name.startsWith("--") ? op.name : `--${op.name}`;
        if (!/^--[A-Za-z0-9_-]+$/.test(name)) throw new OpError(`"${op.name}" can't be a token name: use letters, digits, - and _.`);
        const i = board.tokens.findIndex((t) => t.name === name);
        if (i >= 0) undo.push({ op: "token", name, value: board.tokens[i].value, index: i });
        else undo.push({ op: "token", name, value: null });
        if (op.value === null) {
          if (i >= 0) board.tokens.splice(i, 1);
        } else if (i >= 0) board.tokens[i] = { name, value: op.value };
        else board.tokens.splice(op.index ?? board.tokens.length, 0, { name, value: op.value });
        break;
      }
      case "font": {
        const f = op.font;
        if (!f?.family || !f.src) throw new OpError("A font needs a family and a file (src).");
        const fonts = (board.fonts ??= []);
        const same = (x: BoardFont) => fontKey(x) === fontKey(f);
        const i = fonts.findIndex(same);
        if (op.remove) {
          if (i >= 0) {
            undo.push({ op: "font", font: fonts[i] });
            fonts.splice(i, 1);
          }
        } else if (i < 0) {
          fonts.push({ ...f });
          undo.push({ op: "font", font: f, remove: true });
        }
        if (!fonts.length) delete board.fonts;
        break;
      }
      case "shaderPreset":
        undo.push(...shaderPresetStep(board, op));
        break;
      case "rename":
        undo.push({ op: "rename", name: board.name });
        board.name = op.name.slice(0, 120) || board.name;
        break;
      case "working": {
        // Not part of the design: nothing to undo.
        const w = { ...(board.working ?? {}) };
        if (op.at === null) {
          if (op.ids) for (const id of op.ids) delete w[id];
          else for (const k of Object.keys(w)) delete w[k];
        } else for (const id of op.ids ?? []) w[id] = op.at;
        board.working = w;
        break;
      }
      case "agent": {
        // Who worked here isn't part of the design either: undo leaves it alone.
        const all = { ...(board.agents ?? {}) };
        const was = all[op.agent.key];
        const artboards = [...new Set([...(was?.artboards ?? []), ...(op.artboards ?? [])])];
        all[op.agent.key] = { ...was, ...op.agent, firstAt: was?.firstAt ?? op.at, lastAt: op.at, artboards };
        if (op.touch) all[op.agent.key].last = { at: op.at, ids: op.touch.ids.filter((id) => board.nodes[id]).slice(0, 40), doing: op.touch.doing };
        board.agents = all;
        break;
      }
      case "replace":
        undo.push({ op: "replace", pages: board.pages.map((p) => ({ ...p, children: p.children.slice() })), nodes: { ...board.nodes }, tokens: board.tokens.slice(), name: board.name, ...(op.shaders ? { shaders: board.shaders?.slice() ?? [] } : {}) });
        if (!op.pages?.length) throw new OpError("A board keeps at least one page.");
        board.pages = op.pages.map((p) => ({ ...p, children: p.children.slice() }));
        board.nodes = { ...op.nodes };
        board.tokens = op.tokens.slice();
        if (op.name) board.name = op.name;
        if (op.shaders) {
          if (op.shaders.length) board.shaders = op.shaders.slice();
          else delete board.shaders;
        }
        copied.clear();
        pageCopied.clear();
        for (const p of board.pages) pageCopied.add(p.id);
        break;
      default:
        throw new OpError(`Unknown step ${(op as { op: string }).op}.`);
    }
    inverse.push(undo);
  }
  // Every layer around a changed one is a new object too, so a view can skip a layer (and all
  // inside it) whenever the object is the one it drew last time.
  for (const id of [...copied]) {
    let p = board.nodes[id]?.parent;
    let guard = 0;
    while (p && board.nodes[p] && !copied.has(p) && guard++ < 1000) {
      board.nodes[p] = { ...board.nodes[p] };
      copied.add(p);
      p = board.nodes[p].parent;
    }
  }
  return { board, inverse: inverse.reverse().flat() };
}

// ---------------------------------------------------------------------------------------------
// Components: a main layer and its copies. A copy is real layers (so it draws, exports and reads
// like any other), each linked to the component's layer it follows. A change to the component is
// made in every copy too, except where the copy was changed itself.

/** The component a layer is part of (itself or the nearest one around it). */
export function mainOf(board: Board, id: string): string | undefined {
  let n: BoardNode | undefined = board.nodes[id];
  let guard = 0;
  while (n && guard++ < 1000) {
    if (n.isComponent) return n.id;
    n = n.parent ? board.nodes[n.parent] : undefined;
  }
  return undefined;
}

/** The copy of a component a layer is part of (its top layer). */
export function instanceRootOf(board: Board, id: string): string | undefined {
  let n: BoardNode | undefined = board.nodes[id];
  let guard = 0;
  while (n && guard++ < 1000) {
    if (n.instanceOf) return n.id;
    n = n.parent ? board.nodes[n.parent] : undefined;
  }
  return undefined;
}

export const instancesOf = (board: Board, main: string) => Object.values(board.nodes).filter((n) => n.instanceOf === main).map((n) => n.id);

function followersMap(board: Board): Map<string, string[]> {
  const m = new Map<string, string[]>();
  for (const n of Object.values(board.nodes)) if (n.master) m.set(n.master, [...(m.get(n.master) ?? []), n.id]);
  return m;
}

/** Layers following `id` in copies: in a copy's tree, its layer for `id`. */
function followerIn(board: Board, root: string, master: string): string | undefined {
  if (board.nodes[root]?.master === master) return root;
  for (const x of subtree(board, root)) if (board.nodes[x].master === master) return x;
  return undefined;
}

/** A copy of a layer and what's inside it, each copy following the layer it was made from. */
function followingCopy(board: Board, id: string, parent: string | null, rootAsInstance?: string): { id: string; nodes: Record<string, BoardNode> } {
  const nodes: Record<string, BoardNode> = {};
  const copy = (x: string, p: string | null, top: boolean): string => {
    const n = board.nodes[x];
    const nid = newId();
    const { isComponent: _c, instanceOf: _i, overrides: _o, ...rest } = n;
    nodes[nid] = { ...rest, id: nid, parent: p, style: { ...n.style }, master: x, ...(top && rootAsInstance ? { instanceOf: rootAsInstance } : {}), ...(n.children ? { children: [] } : {}), ...(n.attrs ? { attrs: { ...n.attrs } } : {}) };
    if (n.children) nodes[nid].children = n.children.filter((c) => board.nodes[c]).map((c) => copy(c, nid, false));
    return nid;
  };
  return { id: copy(id, parent, true), nodes };
}

/** A new copy of a component. */
export function instanceTree(board: Board, main: string, parent: string | null): { id: string; nodes: Record<string, BoardNode> } {
  if (!board.nodes[main]?.isComponent) throw new OpError(`${board.nodes[main]?.name ?? main} isn't a component.`);
  const t = followingCopy(board, main, parent, main);
  const root = t.nodes[t.id];
  // Where the component sits isn't part of it.
  for (const k of PLACEMENT) delete root.style[k];
  return t;
}

/**
 * A copy for duplicating or pasting: a component's copy is a copy of the component (so it follows
 * it); anything else is copied as it is (copies of components inside it stay copies).
 */
export function copyTree(board: Board, id: string, parent: string | null): { id: string; nodes: Record<string, BoardNode> } {
  const n = board.nodes[id];
  if (n?.isComponent) {
    const t = instanceTree(board, id, parent);
    for (const k of PLACEMENT) if (n.style[k] !== undefined) t.nodes[t.id].style[k] = n.style[k];
    return t;
  }
  const t = cloneTree(board, id, parent);
  // A component inside what's copied comes out as a copy of it rather than a second component.
  for (const [orig, nid] of Object.entries(t.map)) {
    if (orig === id || !board.nodes[orig].isComponent) continue;
    const c = t.nodes[nid];
    delete c.isComponent;
    c.instanceOf = orig;
    const under = subtree(board, orig);
    for (const o of under) if (t.map[o]) t.nodes[t.map[o]].master = o;
  }
  return { id: t.id, nodes: t.nodes };
}

/** How a layer sits in its frame or on the page: never taken from a component by its copies. */
const PLACEMENT = ["left", "top", "right", "bottom", "position", "inset", "margin", "marginTop", "marginRight", "marginBottom", "marginLeft", "alignSelf", "flexGrow", "flexShrink", "flexBasis", "flex", "order", "zIndex", "transform", "rotate", "translate", "gridColumn", "gridRow", "gridArea", "justifySelf"];

const FIELDS = ["text", "src", "poster", "video", "svg", "defs", "tag", "shape", "hidden", "name", "mask", "shader", "effects"] as const;

/** The keys a set step changes, as overrides name them ("style.color", "text"). */
function changedKeys(before: BoardNode, op: Extract<Op, { op: "set" }>): string[] {
  const keys: string[] = [];
  if (op.replaceStyle) {
    for (const k of new Set([...Object.keys(before.style), ...Object.keys(op.replaceStyle)])) if (before.style[k] !== op.replaceStyle[k]) keys.push(`style.${k}`);
  }
  for (const k of Object.keys(op.style ?? {})) keys.push(`style.${k}`);
  for (const k of Object.keys(op.attrs ?? {})) keys.push(`attrs.${k}`);
  for (const f of FIELDS) if (op[f] !== undefined) keys.push(f);
  return keys;
}

const inCopyMessage = (board: Board, root: string) =>
  `This is a copy of the component “${board.nodes[board.nodes[root].instanceOf ?? ""]?.name ?? "?"}”: layers inside it can be changed or hidden, not added, moved or deleted. Change the component to change every copy, or detach this one.`;

/**
 * Steps as they are to be applied, components included: a change to a component is made in its
 * copies too (as steps of their own, so undo takes them back with it), a change made in a copy is
 * remembered as an override, and what can't be done in a copy (adding, moving or deleting what's
 * inside it) is refused.
 */
export function expandOps(input: Board, ops: Op[]): Op[] {
  const out: Op[] = [];
  let w = input;
  const run = (op: Op, depth: number) => {
    const pre = w;
    if (!op || depth > 8) return;
    const sync = "sync" in op && op.sync;
    // What can't be done inside a copy.
    if (!sync) {
      if (op.op === "add" && op.parent) {
        const r = instanceRootOf(pre, op.parent);
        // The Studio duplicates a layer inside a copy as more of that copy (every new layer follows
        // one); a copy of another component can't go in, as the copy's next repair would drop it.
        const nodes = Object.values(op.nodes);
        if (r && (!nodes.every((n) => n.master) || nodes.some((n) => n.instanceOf))) throw new OpError(inCopyMessage(pre, r));
      }
      // A copy of a component inside that component would hold a copy of itself, without end.
      if (op.op === "add") {
        // Up from each new copy: through the new layers holding it, then from where they land.
        const a = op;
        const holder = (x: string): string | null => {
          const p = a.nodes[x] ? a.nodes[x].parent : pre.nodes[x]?.parent;
          return a.nodes[x] && !(p && a.nodes[p]) ? a.parent : (p ?? null);
        };
        for (const n of Object.values(a.nodes)) {
          if (!n.instanceOf) continue;
          for (let x = holder(n.id), i = 0; x && i < 1000; x = holder(x), i++) if (x === n.instanceOf) throw new OpError(selfCopyMessage(pre, n.instanceOf));
        }
      }
      if (op.op === "move" && op.parent && pre.nodes[op.id]) {
        const holders = new Set([op.parent, ...ancestors(pre, op.parent)]);
        for (const x of subtree(pre, op.id)) {
          const m = pre.nodes[x].instanceOf;
          if (m && holders.has(m)) throw new OpError(selfCopyMessage(pre, m));
        }
      }
      if (op.op === "delete")
        for (const id of op.ids) {
          const r = pre.nodes[id] && instanceRootOf(pre, id);
          if (r && r !== id) throw new OpError(inCopyMessage(pre, r));
        }
      if (op.op === "move" && pre.nodes[op.id]) {
        const r = instanceRootOf(pre, op.id);
        if (r && r !== op.id) throw new OpError(inCopyMessage(pre, r));
        const into = op.parent ? instanceRootOf(pre, op.parent) : undefined;
        if (into) throw new OpError(inCopyMessage(pre, into));
      }
    }
    // A change made in a copy is remembered, so the component leaves it alone from now on.
    if (op.op === "set" && !sync && pre.nodes[op.id]?.master) {
      const n = pre.nodes[op.id];
      const isRoot = Boolean(n.instanceOf);
      const keys = changedKeys(n, op).filter((k) => !(isRoot && k.startsWith("style.") && PLACEMENT.includes(k.slice(6))));
      if (keys.length) op = { ...op, overrides: [...new Set([...(n.overrides ?? []), ...keys])] };
    }
    w = applyOps(w, [op]).board;
    out.push(op);
    for (const p of propagate(pre, w, op)) run(p, depth + 1);
  };
  for (const op of ops) run(op, 0);
  return out;
}

const selfCopyMessage = (board: Board, main: string) => `A copy of the component “${board.nodes[main]?.name ?? "?"}” can't go inside that component: it would hold a copy of itself.`;

/** Steps that make the copies of components going with `ids` (themselves, or inside them) ordinary layers. */
function detachGone(pre: Board, post: Board, ids: string[]): Op[] {
  const out: Op[] = [];
  for (const id of ids) {
    if (!pre.nodes[id]) continue;
    for (const c of subtree(pre, id)) {
      if (!pre.nodes[c].isComponent) continue;
      for (const r of instancesOf(post, c)) for (const x of subtree(post, r)) out.push({ op: "set", id: x, instanceOf: null, master: null, overrides: null, sync: true });
    }
  }
  return out;
}

/** The steps that bring a component's copies in line with a change to the component. */
function propagate(pre: Board, post: Board, op: Op): Op[] {
  const out: Op[] = [];
  const fol = followersMap(post);
  if (op.op === "set") {
    const main = mainOf(pre, op.id);
    if (!main) return out;
    const before = pre.nodes[op.id];
    const after = post.nodes[op.id];
    const isRoot = op.id === main;
    const keys = changedKeys(before, op).filter((k) => !(isRoot && k.startsWith("style.") && PLACEMENT.includes(k.slice(6))));
    if (!keys.length) return out;
    for (const y of fol.get(op.id) ?? []) {
      const yn = post.nodes[y];
      const skip = new Set(yn.overrides ?? []);
      const p: Extract<Op, { op: "set" }> = { op: "set", id: y, sync: true };
      for (const k of keys) {
        if (skip.has(k)) continue;
        if (k.startsWith("style.")) {
          p.style ??= {};
          p.style[k.slice(6)] = after.style[k.slice(6)] ?? null;
        } else if (k.startsWith("attrs.")) {
          p.attrs ??= {};
          p.attrs[k.slice(6)] = after.attrs?.[k.slice(6)] ?? null;
        } else if (k === "name") p.name = after.name;
        else (p as Record<string, unknown>)[k] = (after as unknown as Record<string, unknown>)[k] ?? null;
      }
      if (Object.keys(p).length > 3) out.push(p);
    }
    return out;
  }
  if (op.op === "add") {
    if (!op.parent || !mainOf(pre, op.parent)) return out;
    for (const q of fol.get(op.parent) ?? []) out.push(...copiesInto(post, op.ids, op.parent, q));
    return out;
  }
  if (op.op === "delete") {
    // A component deleted, or the artboard or frame holding one: its copies stay, as ordinary layers.
    out.push(...detachGone(pre, post, op.ids));
    for (const id of op.ids) {
      if (!pre.nodes[id]) continue;
      const main = mainOf(pre, id);
      if (!main || main === id) continue;
      const gone = (followersMap(pre).get(id) ?? []).filter((y) => post.nodes[y]);
      if (gone.length) out.push({ op: "delete", ids: gone, sync: true });
    }
    return out;
  }
  if (op.op === "deletePage") {
    // The same for a page that goes with components on it.
    const page = pre.pages.find((p) => p.id === op.id);
    return page ? detachGone(pre, post, page.children) : out;
  }
  if (op.op === "move") {
    const was = pre.nodes[op.id];
    if (!was) return out;
    const m0 = mainOf(pre, op.id);
    const m1 = mainOf(post, op.id);
    if (m0 && m0 === m1 && op.id !== m0) {
      // Within the component: the same move in every copy.
      for (const r of instancesOf(post, m0)) {
        const y = followerIn(post, r, op.id);
        const q = op.parent === m0 ? r : op.parent ? followerIn(post, r, op.parent) : undefined;
        if (!y || !q) continue;
        out.push({ op: "move", id: y, parent: q, index: mappedIndex(post, op.id, q, y), sync: true });
      }
      return out;
    }
    if (m0 && op.id !== m0) {
      const gone = (followersMap(pre).get(op.id) ?? []).filter((y) => post.nodes[y]);
      if (gone.length) out.push({ op: "delete", ids: gone, sync: true });
    }
    if (m1 && op.id !== m1 && op.parent) for (const q of fol.get(op.parent) ?? []) out.push(...copiesInto(post, [op.id], op.parent, q));
  }
  return out;
}

/** Where, among a copy's layers, the copy of a component's layer goes: after the copy of the one before it. */
function mappedIndex(board: Board, id: string, into: string, except?: string): number {
  const p = board.nodes[board.nodes[id].parent!];
  const at = (p.children ?? []).indexOf(id);
  const kids = (board.nodes[into].children ?? []).filter((c) => c !== except);
  for (let i = at - 1; i >= 0; i--) {
    const k = kids.findIndex((c) => board.nodes[c]?.master === p.children![i]);
    if (k >= 0) return k + 1;
  }
  return 0;
}

function copiesInto(board: Board, ids: string[], parent: string, into: string): Op[] {
  const ops: Op[] = [];
  for (const id of ids) {
    const t = followingCopy(board, id, into);
    ops.push({ op: "add", nodes: t.nodes, ids: [t.id], parent: into, index: mappedIndex(board, id, into), sync: true });
  }
  void parent;
  return ops;
}

/** Steps that make a copy's layer (and what's inside it) match the component again. */
export function resetOps(board: Board, id: string): Op[] {
  const ops: Op[] = [];
  for (const x of subtree(board, id)) {
    const n = board.nodes[x];
    if (!n.master || !n.overrides?.length) continue;
    const m = board.nodes[n.master];
    if (!m) continue;
    const p: Extract<Op, { op: "set" }> = { op: "set", id: x, overrides: null, sync: true };
    for (const k of n.overrides) {
      if (k.startsWith("style.")) {
        p.style ??= {};
        p.style[k.slice(6)] = m.style[k.slice(6)] ?? null;
      } else if (k.startsWith("attrs.")) {
        p.attrs ??= {};
        p.attrs[k.slice(6)] = m.attrs?.[k.slice(6)] ?? null;
      } else if (k === "name") p.name = m.name;
      else (p as Record<string, unknown>)[k] = (m as unknown as Record<string, unknown>)[k] ?? null;
    }
    ops.push(p);
  }
  return ops;
}

/**
 * Steps that bring every copy back in line with its component wherever it isn't its own: what a
 * change worked out from an older state of the board left behind (the Studio's, say, while an agent
 * placed another copy). A copy's own changes (its overrides) and where it sits are kept.
 */
export function reconcileOps(board: Board): Op[] {
  const ops: Op[] = [];
  const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  for (const n of Object.values(board.nodes)) {
    if (!n.master) continue;
    const m = board.nodes[n.master];
    if (!m) continue;
    const skip = new Set(n.overrides ?? []);
    const root = Boolean(n.instanceOf);
    const p: Extract<Op, { op: "set" }> = { op: "set", id: n.id, sync: true };
    for (const k of new Set([...Object.keys(m.style), ...Object.keys(n.style)])) {
      if (skip.has(`style.${k}`) || (root && PLACEMENT.includes(k))) continue;
      if (m.style[k] !== n.style[k]) (p.style ??= {})[k] = m.style[k] ?? null;
    }
    for (const k of new Set([...Object.keys(m.attrs ?? {}), ...Object.keys(n.attrs ?? {})])) {
      if (skip.has(`attrs.${k}`)) continue;
      if (m.attrs?.[k] !== n.attrs?.[k]) (p.attrs ??= {})[k] = m.attrs?.[k] ?? null;
    }
    for (const f of FIELDS) {
      if (skip.has(f) || (f === "name" && root)) continue;
      if (!same(m[f], n[f])) (p as Record<string, unknown>)[f] = m[f] ?? null;
    }
    if (Object.keys(p).length > 3) ops.push(p);
    if (m.children && n.children) {
      // Layers the component has that this copy lacks, and ones following a layer it no longer has here.
      const have = new Set(n.children.map((c) => board.nodes[c]?.master));
      for (const mc of m.children) {
        if (!board.nodes[mc] || have.has(mc)) continue;
        const t = followingCopy(board, mc, n.id);
        ops.push({ op: "add", nodes: t.nodes, ids: [t.id], parent: n.id, index: mappedIndex(board, mc, n.id), sync: true });
      }
      const gone = n.children.filter((c) => {
        const mm = board.nodes[c]?.master;
        return mm !== undefined && !m.children!.includes(mm);
      });
      if (gone.length) ops.push({ op: "delete", ids: gone, sync: true });
    }
  }
  return ops;
}

/** Steps that make a copy ordinary layers, no longer following its component. */
export function detachOps(board: Board, id: string): Op[] {
  return subtree(board, id)
    .filter((x) => board.nodes[x].master || board.nodes[x].instanceOf || board.nodes[x].overrides)
    .map((x) => ({ op: "set" as const, id: x, instanceOf: null, master: null, overrides: null, sync: true }));
}

/** Steps that make a frame a component. */
export function componentOps(board: Board, id: string): Op[] {
  const n = board.nodes[id];
  if (!n) throw new OpError(`There's no layer ${id}.`);
  if (n.type !== "frame") throw new OpError("Only a frame can be a component.");
  if (n.isComponent) return [];
  const r = instanceRootOf(board, id);
  if (r) throw new OpError("A layer in a copy of a component can't become a component: detach the copy first.");
  return [{ op: "set", id, isComponent: true }];
}

/** Steps that make a frame an ordinary frame again: its copies stay, as ordinary layers. */
export function uncomponentOps(board: Board, id: string): Op[] {
  const ops: Op[] = [{ op: "set", id, isComponent: null }];
  for (const r of instancesOf(board, id)) ops.push(...detachOps(board, r));
  return ops;
}

/** Steps that make new layers from HTML inside a frame (or on a page), and the new layers' ids. */
export function addHtmlOps(html: string, parent: string | null, opts: { page?: string; index?: number } = {}): { ops: Op[]; roots: string[]; nodes: Record<string, BoardNode>; warnings: string[] } {
  const got = htmlToNodes(html);
  for (const id of got.roots) got.nodes[id].parent = parent;
  return { ops: got.roots.length ? [{ op: "add", nodes: got.nodes, ids: got.roots, parent, page: opts.page, index: opts.index }] : [], ...got };
}

// ---------------------------------------------------------------------------------------------
// Describing a board in words, for agents

/** How big a layer says it is, as a person reads it: "320", "fit", "fill" or "50%". */
export function sizeWord(board: Board, id: string, axis: "width" | "height"): string {
  const n = board.nodes[id];
  if (!n) return "?";
  const s = n.style;
  const v = s[axis];
  const p = n.parent ? board.nodes[n.parent] : undefined;
  if (p && isFlex(p) && n.style.position !== "absolute") {
    const row = !(p.style.flexDirection ?? "row").startsWith("column");
    const main = (axis === "width") === row;
    if (main && (pxValue(s.flexGrow) ?? 0) > 0) return "fill";
    if (!main && !v && (s.alignSelf === "stretch" || (!s.alignSelf && (p.style.alignItems ?? "stretch") === "stretch")) && n.type !== "image" && n.type !== "video") return "fill";
  }
  if (p && isGrid(p) && !v && n.style.position !== "absolute" && n.style.position !== "fixed" && n.type !== "image" && n.type !== "video") {
    // In a grid a layer without a size of its own stretches across its cell, unless told otherwise.
    const own = axis === "width" ? s.justifySelf : s.alignSelf;
    const self = !own || own === "auto" ? (axis === "width" ? p.style.justifyItems : p.style.alignItems) : own;
    if (!self || self === "normal" || self === "stretch") return "fill";
  }
  if (!v || v === "auto" || v === "fit-content" || v === "max-content") return (n.type === "image" || n.type === "video") && !v ? "auto" : "fit";
  if (v === "100%") return "fill";
  const px = pxValue(v);
  return px !== undefined ? String(round(px, 1)) : v;
}

/** What a vector part's geometry says, for an outline: "x 10 y 20 120×40", "d (412 chars)"… */
function vectorSummary(n: BoardNode): string {
  const a = n.attrs ?? {};
  const keys: Record<string, string[]> = { rect: ["x", "y", "width", "height", "rx"], image: ["x", "y", "width", "height"], use: ["href", "x", "y", "width", "height"], circle: ["cx", "cy", "r"], ellipse: ["cx", "cy", "rx", "ry"], line: ["x1", "y1", "x2", "y2"], text: ["x", "y"], svg: ["x", "y", "width", "height"] };
  const bits = (keys[n.tag ?? ""] ?? []).filter((k) => a[k] !== undefined).map((k) => `${k}=${a[k]}`);
  if (a.d) bits.push(a.d.length > 60 ? `d=${a.d.slice(0, 57)}…` : `d=${a.d}`);
  if (a.points) bits.push(a.points.length > 50 ? `points=${a.points.slice(0, 47)}…` : `points=${a.points}`);
  for (const k of ["fill", "stroke", "stroke-width", "opacity", "transform"]) if (a[k] !== undefined) bits.push(`${k}=${a[k]}`);
  if (n.tag === "text") bits.push(JSON.stringify(plainText(n.text).slice(0, 60)));
  return bits.join(" ");
}

function describe(board: Board, id: string): string {
  const n = board.nodes[id];
  const s = n.style;
  if (n.type === "vector") return [`vector <${vectorTag(n.tag)}>`, JSON.stringify(n.name), `#${id}`, vectorSummary(n), n.hidden ? "hidden" : "", n.locked ? "locked" : ""].filter(Boolean).join(" ");
  const size = `${sizeWord(board, id, "width")}×${sizeWord(board, id, "height")}`;
  const bits: string[] = [n.type, JSON.stringify(n.name), `#${id}`, size];
  if (n.parent === null) bits.push(`at ${pxValue(s.left) ?? 0},${pxValue(s.top) ?? 0}`);
  if (isFlex(n)) bits.push(`flex ${(s.flexDirection ?? "row").startsWith("column") ? "column" : "row"}${s.gap ? ` gap ${s.gap}` : ""}`);
  else if (isGrid(n)) bits.push(gridSummary(s));
  if (n.parent && isGrid(board.nodes[n.parent]) && s.position !== "absolute" && cellSummary(s)) bits.push(cellSummary(s));
  if (s.position === "absolute") bits.push(`absolute ${s.left ?? "?"},${s.top ?? "?"}`);
  if (n.type === "text") {
    const words = plainText(n.text);
    bits.push(JSON.stringify(words.length > 60 ? words.slice(0, 59) + "…" : words));
  }
  if (n.type === "image") bits.push(`src ${(n.src ?? "").slice(0, 80)}`);
  if (n.type === "video") {
    const v = videoSettings(n);
    bits.push(`src ${(n.src ?? "").slice(0, 80)}`, [v.autoplay ? "autoplay" : "no autoplay", v.loop ? "loop" : "once", v.muted ? "no sound" : "sound"].join(" "));
  }
  if (n.type === "svg") bits.push(n.svg ? (n.shape ? `shape ${String(n.shape.type ?? "")}` : "one piece") : `in parts${n.attrs?.viewBox ? `, viewBox ${n.attrs.viewBox}` : ""}`);
  if (n.shader) bits.push(shaderWords(n.shader, board.shaders));
  if (n.effects?.length) {
    const ew = effectsWords(n.effects);
    if (ew) bits.push(ew);
  }
  if (n.mask) bits.push(maskWords(board, id));
  const maskedBy = maskOf(board, id);
  if (maskedBy) bits.push(`masked by #${maskedBy}${board.nodes[maskedBy]?.hidden ? " (mask hidden, so shown whole)" : ""}`);
  if (n.isComponent) bits.push("component");
  if (n.instanceOf) bits.push(`copy of component #${n.instanceOf}`);
  if (n.overrides?.length) bits.push(`changed in this copy: ${n.overrides.map((k) => k.replace(/^style\./, "")).join(", ")}`);
  if (n.hidden) bits.push("hidden");
  if (n.locked) bits.push("locked");
  return bits.join(" ");
}

/** An indented outline of a layer and what's inside it, `depth` levels down. */
export function treeText(board: Board, id: string, depth = 3): string {
  const lines: string[] = [];
  const walk = (x: string, level: number) => {
    const n = board.nodes[x];
    if (!n) return;
    lines.push(`${"  ".repeat(level)}${describe(board, x)}`);
    const kids = n.children ?? [];
    if (level + 1 >= depth && kids.length) {
      lines.push(`${"  ".repeat(level + 1)}… ${kids.length} layer${kids.length === 1 ? "" : "s"} inside`);
      return;
    }
    for (const c of kids) walk(c, level + 1);
  };
  walk(id, 0);
  return lines.join("\n");
}

/**
 * Who a comment goes to when the person doesn't say: in a thread, whoever was told or answered
 * before; else the agents that worked on its artboard; else the board's only agent. Keys, newest first.
 */
export function defaultRecipients(board: Board, artboard: string | undefined, messages: Array<{ by: string; to?: string[] }> = []): string[] {
  const agents = Object.values(board.agents ?? {}).sort((a, b) => b.lastAt.localeCompare(a.lastAt));
  const known = new Set(agents.map((a) => a.key));
  const before = [...new Set(messages.flatMap((m) => [...(m.to ?? []), ...(m.by !== "person" ? [m.by] : [])]))].filter((k) => known.has(k));
  if (before.length) return before;
  const here = agents.filter((a) => artboard && a.artboards.includes(artboard)).map((a) => a.key);
  if (here.length) return here;
  return agents.length === 1 ? [agents[0].key] : [];
}

export function emptyBoard(id: string, name: string, now: string): Board {
  return { id, name, rev: 0, pages: [{ id: newId(), name: "Page 1", children: [] }], nodes: {}, tokens: [], createdAt: now, updatedAt: now };
}

// ---------------------------------------------------------------------------------------------
// Grids: a frame laid out by CSS grid, edited as a design tool edits one. Its tracks (columns and
// rows) are read from grid-template-columns and -rows as written (fr, px, auto, min-content,
// max-content, minmax(), fit-content(), %, repeat(), line names) into a list to change, and written
// back as CSS a person would write. Shorthands (grid, grid-template, grid-area with slashes,
// place-*) come in as their longhands, so the panel and agents see one way of saying each thing.

/** One track of a grid: its size as CSS ("1fr", "240px", "minmax(120px, 1fr)") and the names of the line before it. */
export interface Track {
  size: string;
  names?: string[];
  /** repeat(auto-fill, …) or repeat(auto-fit, …): as many of `size` as fit the frame. */
  auto?: "auto-fill" | "auto-fit";
}
export interface TrackList {
  tracks: Track[];
  /** Names of the line after the last track. */
  end?: string[];
  /** A list that can't be edited track by track (subgrid, masonry, one var() for the lot): kept as written. */
  raw?: string;
}
export type TrackKind = "fr" | "px" | "auto" | "min-content" | "max-content" | "minmax" | "fit-content" | "percent" | "other";

/** CSS split at the top level on whitespace (or `sep`), keeping (…), […] and quotes whole. */
export function splitTop(text: string, sep: "space" | "," | "/" = "space"): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote = "";
  let cur = "";
  for (const c of text) {
    if (quote) {
      cur += c;
      if (c === quote) quote = "";
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === "(" || c === "[") depth++;
    else if (c === ")" || c === "]") depth = Math.max(0, depth - 1);
    const cut = depth === 0 && (sep === "space" ? /\s/.test(c) : c === sep);
    if (cut) {
      if (cur.trim()) out.push(cur.trim());
      else if (sep !== "space") out.push("");
      cur = "";
      continue;
    }
    cur += c;
  }
  if (cur.trim() || (sep !== "space" && out.length)) out.push(cur.trim());
  return out;
}

/** grid-template-columns (or -rows) as a list of tracks. repeat(n, …) is spelt out; repeat(auto-fill, …) is one track that repeats. */
export function parseTracks(value: string | null | undefined): TrackList {
  const text = (value ?? "").trim();
  if (!text || text === "none" || text === "initial" || text === "unset") return { tracks: [] };
  if (/^(subgrid|masonry|inherit|revert)\b/i.test(text) || /^var\([^)]*\)$/.test(text)) return { tracks: [], raw: text };
  const tracks: Track[] = [];
  let names: string[] | undefined;
  const push = (size: string, auto?: Track["auto"]) => {
    tracks.push({ size, ...(names?.length ? { names } : {}), ...(auto ? { auto } : {}) });
    names = undefined;
  };
  for (const part of splitTop(text)) {
    if (part.startsWith("[")) {
      names = [...(names ?? []), ...part.slice(1, -1).trim().split(/\s+/).filter(Boolean)];
      continue;
    }
    const rep = /^repeat\(([\s\S]*)\)$/i.exec(part);
    if (rep) {
      const [count, ...rest] = splitTop(rep[1], ",");
      const inner = rest.join(",").trim();
      const c = (count ?? "").trim().toLowerCase();
      if (c === "auto-fill" || c === "auto-fit") {
        push(inner, c);
        continue;
      }
      const n = Number(c);
      const list = parseTracks(inner);
      if (!Number.isInteger(n) || n < 1 || list.raw || !list.tracks.length || n * list.tracks.length > 1000) return { tracks: [], raw: text };
      for (let i = 0; i < n; i++) {
        for (const t of list.tracks) {
          if (t.names) names = [...(names ?? []), ...t.names];
          push(t.size);
        }
        if (list.end) names = [...(names ?? []), ...list.end];
      }
      continue;
    }
    push(part);
  }
  return { tracks, ...(names?.length ? { end: names } : {}) };
}

/** A list of tracks as CSS: repeat(3, 1fr) for a run of three or more alike (or every track alike), else spelt out. */
export function tracksCss(list: TrackList): string | null {
  if (list.raw) return list.raw;
  const t = list.tracks;
  if (!t.length) return null;
  const plain = (x: Track) => !x.names?.length && !x.auto;
  if (t.length > 1 && !list.end?.length && t.every((x) => plain(x) && x.size === t[0].size)) return `repeat(${t.length}, ${t[0].size})`;
  const bits: string[] = [];
  for (let i = 0; i < t.length; ) {
    const x = t[i];
    let j = i + 1;
    while (plain(x) && j < t.length && plain(t[j]) && t[j].size === x.size) j++;
    if (x.names?.length) bits.push(`[${x.names.join(" ")}]`);
    if (j - i >= 3) bits.push(`repeat(${j - i}, ${x.size})`);
    else for (let k = i; k < j; k++) bits.push(t[k].auto ? `repeat(${t[k].auto}, ${t[k].size})` : t[k].size);
    i = j;
  }
  if (list.end?.length) bits.push(`[${list.end.join(" ")}]`);
  return bits.join(" ");
}

export function trackKind(size: string): TrackKind {
  const s = size.trim().toLowerCase();
  if (/^\d*\.?\d+fr$/.test(s)) return "fr";
  if (pxValue(s) !== undefined) return "px";
  if (s === "auto") return "auto";
  if (s === "min-content" || s === "max-content") return s;
  if (/^minmax\(/.test(s)) return "minmax";
  if (/^fit-content\(/.test(s)) return "fit-content";
  if (/^\d*\.?\d+%$/.test(s)) return "percent";
  return "other";
}

/** The two sides of minmax(a, b) (or the limit of fit-content(x) as [x]), else null. */
export function trackArgs(size: string): string[] | null {
  const m = /^(minmax|fit-content)\(([\s\S]*)\)$/i.exec(size.trim());
  return m ? splitTop(m[2], ",").map((x) => x.trim()) : null;
}

/** A track's size, short, as the panel and the canvas show it: "1fr", "240", "Auto", "120–1fr", "≤ 320". */
export function trackLabel(t: Track | string): string {
  const size = typeof t === "string" ? t : t.size;
  const short = (v: string) => (pxValue(v) !== undefined ? String(round(pxValue(v)!, 1)) : v === "auto" ? "Auto" : v === "min-content" ? "Min" : v === "max-content" ? "Max" : v);
  if (typeof t !== "string" && t.auto) {
    const a = trackArgs(t.size);
    return `${t.auto === "auto-fit" ? "Fit" : "Fill"} ≥ ${short(a?.[0] ?? t.size)}`;
  }
  const kind = trackKind(size);
  if (kind === "minmax") {
    const [a, b] = trackArgs(size) ?? [];
    return `${short(a ?? "?")}–${short(b ?? "?")}`;
  }
  if (kind === "fit-content") return `≤ ${short(trackArgs(size)?.[0] ?? "?")}`;
  return short(size.trim());
}

/** grid-template-areas as rows of cell names ("." for none), or null when there are none. */
export function parseAreas(value: string | null | undefined): string[][] | null {
  const rows = [...(value ?? "").matchAll(/"([^"]*)"|'([^']*)'/g)].map((m) => (m[1] ?? m[2]).trim().split(/\s+/).filter(Boolean).map((c) => (/^\.+$/.test(c) ? "." : c)));
  return rows.length ? rows : null;
}

/** Rows of cell names as grid-template-areas, or null when every cell is empty. */
export function areasCss(rows: string[][] | null): string | null {
  if (!rows?.length || !rows.some((r) => r.some((c) => c && c !== "."))) return null;
  const w = Math.max(...rows.map((r) => r.length));
  return rows.map((r) => `"${Array.from({ length: w }, (_, i) => (r[i] && /^[A-Za-z_][\w-]*$/.test(r[i]) ? r[i] : ".")).join(" ")}"`).join(" ");
}

/** Where each named area is (lines from 1), and whether it's a rectangle (CSS ignores the whole list when one isn't). */
export function areaRects(rows: string[][] | null): Record<string, { column: number; row: number; columnSpan: number; rowSpan: number; ok: boolean }> {
  const cells: Record<string, [number, number][]> = {};
  (rows ?? []).forEach((r, y) => r.forEach((c, x) => c !== "." && (cells[c] ??= []).push([x, y])));
  const out: Record<string, { column: number; row: number; columnSpan: number; rowSpan: number; ok: boolean }> = {};
  for (const [name, list] of Object.entries(cells)) {
    const xs = list.map((c) => c[0]);
    const ys = list.map((c) => c[1]);
    const x0 = Math.min(...xs);
    const y0 = Math.min(...ys);
    const w = Math.max(...xs) - x0 + 1;
    const h = Math.max(...ys) - y0 + 1;
    out[name] = { column: x0 + 1, row: y0 + 1, columnSpan: w, rowSpan: h, ok: list.length === w * h };
  }
  return out;
}

/** Whether CSS will use these areas: every row as long as the others, every name a rectangle. */
export function areasValid(rows: string[][] | null): boolean {
  if (!rows?.length) return true;
  return rows.every((r) => r.length === rows[0].length) && Object.values(areaRects(rows)).every((a) => a.ok);
}

/** A grid's gaps between rows and between columns, as written ("" when none). */
export function gapsOf(style: Style): { row: string; column: string } {
  const g = splitTop(style.gap ?? style.gridGap ?? "");
  return { row: style.rowGap ?? style.gridRowGap ?? g[0] ?? "", column: style.columnGap ?? style.gridColumnGap ?? g[1] ?? g[0] ?? "" };
}

/** CSS for a grid's gaps: one gap when they're alike, "row column" when not. */
export function gapCss(row: string, column: string): Record<string, string | null> {
  const r = row.trim();
  const c = column.trim();
  const none = (v: string) => !v || pxValue(v) === 0;
  return { gap: none(r) && none(c) ? null : r === c ? r : `${r || "0px"} ${c || "0px"}`, rowGap: null, columnGap: null, gridGap: null, gridRowGap: null, gridColumnGap: null };
}

/** Where a layer sits in its grid on one axis: grid-column or grid-row read as a start line, a span and an end line. */
export interface Placement {
  start?: number | string;
  span?: number;
  end?: number | string;
}

export function parsePlacement(value: string | null | undefined): Placement {
  const text = (value ?? "").trim();
  if (!text || text === "auto") return {};
  const [a = "", b = ""] = text.split("/").map((x) => x.trim());
  const side = (x: string): { line?: number | string; span?: number } => {
    if (!x || x === "auto") return {};
    const m = /^span\s+(\d+)$/i.exec(x) ?? /^(\d+)\s+span$/i.exec(x);
    if (m) return { span: Math.max(1, Number(m[1])) };
    if (/^span\s+/i.test(x)) return { span: 1 };
    return /^-?\d+$/.test(x) ? { line: Number(x) } : { line: x };
  };
  const A = side(a);
  const Z = side(b);
  const out: Placement = {};
  if (A.line !== undefined) out.start = A.line;
  if (Z.line !== undefined) out.end = Z.line;
  const span = Z.span ?? A.span;
  if (span) out.span = span;
  return out;
}

/** A placement as grid-column or grid-row: "2", "span 2", "2 / span 3", "1 / -1"; null when it flows on its own. */
export function placementCss(p: Placement): string | null {
  const span = p.span && p.span > 1 ? p.span : undefined;
  if (p.start === undefined || p.start === "") {
    if (p.end !== undefined && p.end !== "") return `${span ? `span ${span}` : "auto"} / ${p.end}`;
    return span ? `span ${span}` : null;
  }
  if (p.end !== undefined && p.end !== "") return `${p.start} / ${p.end}`;
  return span ? `${p.start} / span ${span}` : String(p.start);
}

/** How many tracks a placement covers, when that can be told without drawing it. */
export function placementSpan(p: Placement): number {
  if (p.span) return p.span;
  if (typeof p.start === "number" && typeof p.end === "number" && p.start > 0 && p.end > p.start) return p.end - p.start;
  return 1;
}

/** A frame's own grid properties, and its layers' (where they sit in it), for taking them off. */
export const GRID_FRAME_KEYS = ["gridTemplateColumns", "gridTemplateRows", "gridTemplateAreas", "gridTemplate", "grid", "gridAutoFlow", "gridAutoRows", "gridAutoColumns", "justifyItems", "alignContent", "placeItems", "placeContent", "rowGap", "columnGap", "gridGap", "gridRowGap", "gridColumnGap"];
export const GRID_CHILD_KEYS = ["gridColumn", "gridRow", "gridArea", "gridColumnStart", "gridColumnEnd", "gridRowStart", "gridRowEnd", "justifySelf", "placeSelf"];

/** grid-template's parts: rows (with areas, when it has strings) and columns. */
function templateParts(value: string): { rows: string | null; columns: string | null; areas: string | null } {
  const v = value.trim();
  if (!v || v === "none") return { rows: null, columns: null, areas: null };
  const [rowsPart, colsPart = ""] = splitTop(v, "/");
  if (!/["']/.test(rowsPart)) return { rows: rowsPart.trim() || null, columns: colsPart.trim() || null, areas: null };
  // "a a" 100px "b b" 1fr: each string a row of areas, the size after it that row's.
  const areas: string[] = [];
  const rows: string[] = [];
  let names: string[] = [];
  let open = false;
  for (const part of splitTop(rowsPart)) {
    if (/^["']/.test(part)) {
      if (open) rows.push("auto");
      areas.push(part);
      if (names.length) rows.push(`[${names.join(" ")}]`);
      names = [];
      open = true;
    } else if (part.startsWith("[")) {
      if (open) names.push(part.slice(1, -1).trim());
      else rows.push(part);
    } else if (open) {
      rows.push(part);
      open = false;
    }
  }
  if (open) rows.push("auto");
  if (names.length) rows.push(`[${names.join(" ")}]`);
  return { rows: rows.join(" ") || null, columns: colsPart.trim() || null, areas: areas.join(" ") || null };
}

/**
 * CSS with grid shorthands written as their longhands: grid and grid-template as columns, rows,
 * areas and flow; grid-gap as gap; grid-area with slashes and the start/end longhands as
 * grid-row and grid-column; place-items, place-content and place-self as their two halves. Works on
 * a whole style or on a change to one (null removes, and a shorthand resets what it covers);
 * `base` is the layer's style as it is, for a change to one side of a line.
 */
export function normalizeGridStyle(style: Record<string, string | null>, base: Style = {}): Record<string, string | null> {
  const out: Record<string, string | null> = { ...style };
  const has = (k: string) => Object.prototype.hasOwnProperty.call(style, k);
  const take = (k: string) => {
    const v = out[k];
    delete out[k];
    return v === null || v === undefined ? null : String(v).trim();
  };
  if (has("grid")) {
    const v = take("grid");
    out.grid = null;
    Object.assign(out, { gridTemplateRows: null, gridTemplateColumns: null, gridTemplateAreas: null, gridAutoFlow: null, gridAutoRows: null, gridAutoColumns: null });
    if (v && v !== "none") {
      const [a, b = ""] = splitTop(v, "/");
      const flowIn = (s: string) => /\bauto-flow\b/.test(s);
      if (flowIn(a)) {
        // auto-flow [dense] <auto-rows> / <columns>
        const dense = /\bdense\b/.test(a);
        const sizes = a.replace(/\bauto-flow\b|\bdense\b/g, "").trim();
        Object.assign(out, { gridAutoFlow: dense ? "row dense" : null, gridAutoRows: sizes || null, gridTemplateColumns: b.trim() || null });
      } else if (flowIn(b)) {
        // <rows> / auto-flow [dense] <auto-columns>
        const dense = /\bdense\b/.test(b);
        const sizes = b.replace(/\bauto-flow\b|\bdense\b/g, "").trim();
        Object.assign(out, { gridAutoFlow: dense ? "column dense" : "column", gridAutoColumns: sizes || null, gridTemplateRows: a.trim() || null });
      } else {
        const t = templateParts(v);
        Object.assign(out, { gridTemplateRows: t.rows, gridTemplateColumns: t.columns, gridTemplateAreas: t.areas });
      }
    }
  }
  if (has("gridTemplate")) {
    const v = take("gridTemplate");
    out.gridTemplate = null;
    const t = templateParts(v ?? "");
    Object.assign(out, { gridTemplateRows: t.rows, gridTemplateColumns: t.columns, gridTemplateAreas: t.areas });
  }
  if (has("gridGap")) {
    const v = take("gridGap");
    out.gridGap = null;
    if (v || !has("gap")) out.gap = v;
  }
  for (const [old, now] of [["gridRowGap", "rowGap"], ["gridColumnGap", "columnGap"]] as const) {
    if (!has(old)) continue;
    const v = take(old);
    out[old] = null;
    if (v || !has(now)) out[now] = v;
  }
  for (const [short, a, b] of [["placeItems", "alignItems", "justifyItems"], ["placeContent", "alignContent", "justifyContent"], ["placeSelf", "alignSelf", "justifySelf"]] as const) {
    if (!has(short)) continue;
    const parts = splitTop(take(short) ?? "");
    out[short] = null;
    out[a] = parts[0] ?? null;
    out[b] = parts[1] ?? parts[0] ?? null;
  }
  if (has("gridArea") && /\//.test(String(style.gridArea ?? ""))) {
    const [rs = "auto", cs = "auto", re, ce] = splitTop(take("gridArea") ?? "", "/").map((x) => x.trim() || "auto");
    out.gridArea = null;
    const named = (x: string) => !/^(-?\d+|auto|span\b.*)$/i.test(x);
    const line = (s: string, e: string | undefined) => {
      const p = parsePlacement(`${s} / ${e ?? (named(s) ? s : "auto")}`);
      // One track ("1 / 2") reads as its line alone.
      return placementCss(typeof p.start === "number" && typeof p.end === "number" && p.start > 0 && p.end === p.start + 1 ? { start: p.start } : p);
    };
    out.gridRow = line(rs, re);
    out.gridColumn = line(cs, ce);
  }
  for (const axis of ["Row", "Column"] as const) {
    const sk = `grid${axis}Start`;
    const ek = `grid${axis}End`;
    if (!has(sk) && !has(ek)) continue;
    const was = parsePlacement(style[`grid${axis}`] ?? base[`grid${axis}`] ?? `${base[sk] ?? "auto"} / ${base[ek] ?? "auto"}`);
    // A span belongs to the side without a line ("span 2" alone is the start's).
    const wasText = (p: Placement, which: "start" | "end") => (which === "start" ? (p.start !== undefined ? String(p.start) : p.span ? `span ${p.span}` : "auto") : p.end !== undefined ? String(p.end) : p.span && p.start !== undefined ? `span ${p.span}` : "auto");
    const s = has(sk) ? take(sk) ?? "auto" : wasText(was, "start");
    const e = has(ek) ? take(ek) ?? "auto" : wasText(was, "end");
    out[sk] = null;
    out[ek] = null;
    out[`grid${axis}`] = placementCss(parsePlacement(`${s} / ${e}`));
  }
  // A bare number for a line is a line, not px.
  for (const k of ["gridRow", "gridColumn"]) if (typeof out[k] === "string" && /^-?\d+px$/.test(out[k]!)) out[k] = out[k]!.replace(/px$/, "");
  return out;
}

/** A whole style with its grid shorthands as longhands (and nothing removed left in). */
export function gridLonghands(style: Style): Style {
  if (!Object.keys(style).some((k) => k === "grid" || k.startsWith("gridTemplate") || /^grid(Row|Column)?Gap$|^grid(Row|Column)(Start|End)$|^place(Items|Content|Self)$/.test(k) || (k === "gridArea" && /\//.test(style[k])))) return style;
  const out: Style = {};
  for (const [k, v] of Object.entries(normalizeGridStyle(style))) if (v !== null && v !== undefined && v !== "") out[k] = v;
  return out;
}

/** Everything about a grid frame's layout, read from its CSS (shorthands too). */
export interface GridModel {
  columns: TrackList;
  rows: TrackList;
  areas: string[][] | null;
  flow: "row" | "column";
  dense: boolean;
  autoRows: string;
  autoColumns: string;
  rowGap: string;
  columnGap: string;
}

export function gridOf(style: Style): GridModel {
  const s = gridLonghands(style);
  const flow = (s.gridAutoFlow ?? "").toLowerCase();
  const gaps = gapsOf(s);
  return {
    columns: parseTracks(s.gridTemplateColumns),
    rows: parseTracks(s.gridTemplateRows),
    areas: parseAreas(s.gridTemplateAreas),
    flow: /\bcolumn\b/.test(flow) ? "column" : "row",
    dense: /\bdense\b/.test(flow),
    autoRows: s.gridAutoRows ?? "",
    autoColumns: s.gridAutoColumns ?? "",
    rowGap: gaps.row,
    columnGap: gaps.column,
  };
}

/**
 * The CSS that changes a grid frame's layout: what's given is written as longhands (a default as
 * none), and any shorthand the frame has is taken off (with what it said kept as longhands).
 */
export function gridPatch(style: Style, change: Partial<GridModel>): Record<string, string | null> {
  const now = gridOf(style);
  const m = { ...now, ...change };
  const patch: Record<string, string | null> = {};
  const longs = gridLonghands(style);
  // A shorthand on the frame goes: what it said stays, as longhands.
  if (longs !== style) {
    for (const k of Object.keys(style)) if (!(k in longs)) patch[k] = null;
    for (const [k, v] of Object.entries(longs)) if (style[k] !== v) patch[k] = v;
  }
  if ("columns" in change) patch.gridTemplateColumns = tracksCss(m.columns);
  if ("rows" in change) patch.gridTemplateRows = tracksCss(m.rows);
  if ("areas" in change) patch.gridTemplateAreas = areasCss(m.areas);
  if ("flow" in change || "dense" in change) patch.gridAutoFlow = m.flow === "row" && !m.dense ? null : `${m.flow}${m.dense ? " dense" : ""}`;
  if ("autoRows" in change) patch.gridAutoRows = m.autoRows.trim() || null;
  if ("autoColumns" in change) patch.gridAutoColumns = m.autoColumns.trim() || null;
  if ("rowGap" in change || "columnGap" in change) Object.assign(patch, gapCss(m.rowGap, m.columnGap));
  return patch;
}

/** A grid in words, for agents: "grid 3×2 · columns repeat(3, 1fr) · rows auto auto · gap 16px". */
export function gridSummary(style: Style): string {
  const g = gridOf(style);
  const count = (l: TrackList, word: string) => (l.raw ? `${word}s as written` : l.tracks.some((t) => t.auto) ? `as many ${word}s as fit` : `${l.tracks.length || 1} ${word}${l.tracks.length === 1 || !l.tracks.length ? "" : "s"}`);
  const bits = [`grid ${count(g.columns, "column")}${g.rows.tracks.length || g.rows.raw ? ` × ${count(g.rows, "row")}` : ""}`];
  bits.push(`columns ${tracksCss(g.columns) ?? "none (one, auto)"}`);
  if (g.rows.tracks.length || g.rows.raw) bits.push(`rows ${tracksCss(g.rows)}`);
  if (g.areas) bits.push(`areas ${areasCss(g.areas)}${areasValid(g.areas) ? "" : " (not rectangles: CSS ignores them)"}`);
  if (g.rowGap || g.columnGap) bits.push(`gap ${g.rowGap === g.columnGap ? g.rowGap : `${g.rowGap || 0} ${g.columnGap || 0}`}`);
  if (g.flow === "column" || g.dense) bits.push(`flow ${g.flow}${g.dense ? " dense" : ""}`);
  if (g.autoRows) bits.push(`new rows ${g.autoRows}`);
  if (g.autoColumns) bits.push(`new columns ${g.autoColumns}`);
  for (const k of ["justifyItems", "alignItems", "justifyContent", "alignContent"]) if (style[k]) bits.push(`${kebab(k)} ${style[k]}`);
  return bits.join(" · ");
}

/** Where a layer sits in its grid, in words: "cell column 2 / span 2, row 1", "area header". */
export function cellSummary(style: Style): string {
  const s = gridLonghands(style);
  const bits: string[] = [];
  if (s.gridArea) bits.push(`area ${s.gridArea}`);
  else {
    const c = placementCss(parsePlacement(s.gridColumn));
    const r = placementCss(parsePlacement(s.gridRow));
    if (c || r) bits.push(`cell${c ? ` column ${c}` : ""}${c && r ? "," : ""}${r ? ` row ${r}` : ""}`);
  }
  if (s.justifySelf) bits.push(`justify-self ${s.justifySelf}`);
  if (s.alignSelf) bits.push(`align-self ${s.alignSelf}`);
  return bits.join(" ");
}

/** A cell (or block of cells) of a grid, lines counted from 1. */
export interface GridCell {
  column: number;
  row: number;
  columnSpan: number;
  rowSpan: number;
}

/**
 * Where CSS's auto-placement puts items (row flow, `columns` wide, sparse or dense): each item's
 * cell, given its spans. Used to tell whether a layout needs its items placed by hand.
 */
export function autoPlace(spans: Array<{ columnSpan: number; rowSpan: number }>, columns: number, dense = false): GridCell[] {
  const taken = new Set<string>();
  const free = (c: number, r: number, cs: number, rs: number) => {
    if (c + cs - 1 > columns) return false;
    for (let y = r; y < r + rs; y++) for (let x = c; x < c + cs; x++) if (taken.has(`${x},${y}`)) return false;
    return true;
  };
  let col = 1;
  let row = 1;
  return spans.map(({ columnSpan, rowSpan }) => {
    // Dense: each item looks for room from the start again.
    if (dense) {
      col = 1;
      row = 1;
    }
    const cs = Math.min(Math.max(1, columnSpan), columns);
    for (let guard = 0; guard < 100000; guard++) {
      if (free(col, row, cs, rowSpan)) break;
      col++;
      if (col + cs - 1 > columns) {
        col = 1;
        row++;
      }
    }
    for (let y = row; y < row + rowSpan; y++) for (let x = col; x < col + cs; x++) taken.add(`${x},${y}`);
    const cell = { column: col, row, columnSpan: cs, rowSpan };
    col += cs;
    if (col > columns) {
      col = 1;
      row++;
    }
    return cell;
  });
}

/** What a set of layers laid out by position would be as a grid: tracks, gaps, reading order and cells. */
export interface GridPlan {
  columns: string[];
  rows: string[];
  columnGap: number;
  rowGap: number;
  /** The layers in reading order (left to right, top to bottom). */
  order: string[];
  cells: Record<string, GridCell>;
  /** Whether items must be placed by hand (auto-placement in reading order wouldn't put them there). */
  explicit: boolean;
}

/** Positions close together (within `tol`) as one, each cluster's smallest value. */
function clusters(values: number[], tol: number): number[] {
  const out: number[] = [];
  for (const v of [...values].sort((a, b) => a - b)) if (!out.length || v - out[out.length - 1] > tol) out.push(v);
  return out;
}
const median = (xs: number[]) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor((s.length - 1) / 2)];
};

/**
 * A grid that keeps layers where they are: columns start where layers' left edges line up, rows
 * where their tops do; a layer reaching across several takes them (a bento's tall card spans two
 * rows). Equal columns become 1fr each; unequal ones keep their widths. Boxes are in the frame's
 * own coordinates.
 */
export function planGrid(items: Array<{ id: string; box: Box }>): GridPlan {
  const list = items.filter((i) => i.box && Number.isFinite(i.box.x) && Number.isFinite(i.box.y));
  if (!list.length) return { columns: ["1fr"], rows: [], columnGap: 0, rowGap: 0, order: [], cells: {}, explicit: false };
  const tol = Math.max(4, Math.min(24, median(list.map((i) => Math.min(i.box.width, i.box.height))) * 0.2));
  const lefts = clusters(list.map((i) => i.box.x), tol);
  const tops = clusters(list.map((i) => i.box.y), tol);
  const index = (lines: number[], v: number) => {
    let k = 0;
    for (let j = 0; j < lines.length; j++) if (v >= lines[j] - tol) k = j;
    return k;
  };
  const cells: Record<string, GridCell> = {};
  for (const { id, box } of list) {
    const c = index(lefts, box.x);
    const r = index(tops, box.y);
    const c2 = Math.max(c, index(lefts, box.x + box.width - tol - 1));
    const r2 = Math.max(r, index(tops, box.y + box.height - tol - 1));
    cells[id] = { column: c + 1, row: r + 1, columnSpan: c2 - c + 1, rowSpan: r2 - r + 1 };
  }
  const order = list
    .slice()
    .sort((a, b) => cells[a.id].row - cells[b.id].row || cells[a.id].column - cells[b.id].column || a.box.x - b.box.x)
    .map((i) => i.id);
  const byId = Object.fromEntries(list.map((i) => [i.id, i.box]));
  // Gaps: from the end of what fills one track to the start of the next.
  const gapsBetween = (lines: number[], start: (b: Box) => number, size: (b: Box) => number, cell: (c: GridCell) => [number, number]) =>
    lines.slice(1).flatMap((line, j) => {
      const ends = list.filter((i) => cell(cells[i.id])[0] + cell(cells[i.id])[1] - 1 === j + 1).map((i) => start(i.box) + size(i.box));
      return ends.length ? [Math.max(0, line - Math.max(...ends))] : [];
    });
  let columnGap = Math.round(median(gapsBetween(lefts, (b) => b.x, (b) => b.width, (c) => [c.column, c.columnSpan])));
  let rowGap = Math.round(median(gapsBetween(tops, (b) => b.y, (b) => b.height, (c) => [c.row, c.rowSpan])));
  // One column (or row) has no gap of its own across: it takes the other, so the CSS says one gap.
  if (lefts.length === 1) columnGap = rowGap;
  if (tops.length === 1) rowGap = columnGap;
  const widths = lefts.map((left, j) => {
    const own = list.filter((i) => cells[i.id].column === j + 1 && cells[i.id].columnSpan === 1).map((i) => i.box.width);
    if (own.length) return Math.max(...own);
    return j + 1 < lefts.length ? Math.max(1, lefts[j + 1] - columnGap - left) : Math.max(1, ...list.filter((i) => cells[i.id].column + cells[i.id].columnSpan - 1 === j + 1).map((i) => byId[i.id].x + byId[i.id].width - left));
  });
  const even = widths.every((w) => Math.abs(w - widths[0]) <= Math.max(2, widths[0] * 0.08));
  const columns = even ? widths.map(() => "1fr") : widths.map((w) => `${Math.round(w)}px`);
  const rows = tops.map(() => "auto");
  const spans = order.map((id) => cells[id]);
  const auto = autoPlace(spans, lefts.length);
  const explicit = auto.some((c, k) => c.column !== spans[k].column || c.row !== spans[k].row);
  return { columns, rows, columnGap, rowGap, order, cells, explicit };
}

/** flex-start → start and the like: what a flex alignment is called in a grid. */
export const gridAlign = (v: string | undefined) => (v === "flex-start" ? "start" : v === "flex-end" ? "end" : v);

/**
 * The CSS that makes a flex frame a grid that looks the same: a row becomes a column per layer (a
 * layer that grows takes fr, the rest auto), a column a row per layer; alignment and gaps carry
 * over. Null for a flex frame that wraps: plan that from where its layers are (planGrid).
 */
export function flexToGrid(board: Board, id: string): { frame: Record<string, string | null>; children: Record<string, Record<string, string | null>> } | null {
  const n = board.nodes[id];
  if (!n || !isFlex(n) || (n.style.flexWrap ?? "nowrap").startsWith("wrap")) return null;
  const column = (n.style.flexDirection ?? "row").startsWith("column");
  const kids = (n.children ?? []).filter((c) => board.nodes[c] && !board.nodes[c].hidden && board.nodes[c].style.position !== "absolute" && board.nodes[c].style.position !== "fixed");
  const grow = (c: string) => pxValue(board.nodes[c].style.flexGrow) ?? (/^\s*\d/.test(board.nodes[c].style.flex ?? "") ? Number.parseFloat(board.nodes[c].style.flex!) : 0);
  const tracks = kids.map((c) => (grow(c) > 0 ? `${round(grow(c), 2)}fr` : "auto"));
  const stretchMain = tracks.some((t) => t.endsWith("fr"));
  const justify = gridAlign(n.style.justifyContent) ?? "start";
  const items = gridAlign(n.style.alignItems);
  const frame: Record<string, string | null> = {
    display: "grid",
    flexDirection: null,
    flexWrap: null,
    gridTemplateColumns: column ? "1fr" : tracksCss({ tracks: tracks.map((size) => ({ size })) }) ?? null,
    gridTemplateRows: column ? tracksCss({ tracks: tracks.map((size) => ({ size })) }) ?? null : null,
    ...(column ? { alignContent: stretchMain ? null : justify === "normal" ? "start" : justify, justifyContent: null } : { justifyContent: stretchMain ? null : justify === "normal" ? "start" : justify }),
    // The cross axis: a column's layers stretch across it (justify-items), a row's down it (align-items).
    ...(column ? { justifyItems: items && items !== "stretch" ? items : null, alignItems: null } : { alignItems: items && items !== "stretch" ? items : null }),
  };
  const children: Record<string, Record<string, string | null>> = {};
  for (const c of kids) {
    const s = board.nodes[c].style;
    const patch: Record<string, string | null> = { flexGrow: null, flexShrink: null, flexBasis: null, flex: null, order: null };
    if (s.alignSelf) {
      if (column) Object.assign(patch, { alignSelf: null, justifySelf: gridAlign(s.alignSelf) ?? null });
      else patch.alignSelf = gridAlign(s.alignSelf) ?? null;
    }
    // A layer that grew along the row filled its share: in its fr track it does by stretching.
    if (grow(c) > 0) patch[column ? "height" : "width"] = null;
    children[c] = patch;
  }
  return { frame, children };
}

// ---------------------------------------------------------------------------------------------
// Masks, as Figma has them. A layer used as a mask isn't drawn: its look (by its alpha, its outline
// or its brightness) shows the layers above it in its frame, up to the next mask, and hides the rest
// of them. "Above" is after it in the frame's list, as everywhere on a board.
//
// In HTML the mask stays where it is, hidden, and the layers it masks are drawn after it inside two
// elements made for the purpose: the first covers the frame (`position:absolute; inset:0`), so the
// layers keep the places their left and top give them; the second (static, so it never becomes what
// they're placed in) sits on the mask's box and carries the mask's look as CSS:
//   - a frame: its fills as mask-image layers (colours, gradients, pictures; mask-mode alpha or
//     luminance), its corners as clip-path: inset(0 round …); a vector mask is the clip-path alone;
//   - a picture: mask-image: url(…), sized and placed as its object-fit and object-position say;
//   - a vector: its SVG as a data: URL image (a vector mask makes every painted pixel solid);
//   - words: an SVG holding the text layer's own HTML and CSS in a foreignObject, so they wrap as
//     they do on the canvas (an SVG drawn as an image can't load fonts: web fonts are put inside it,
//     see loadMaskFonts);
//   - the mask's opacity as one more layer, intersected with the rest.
// That needs the mask's box to be known from its CSS: a mask is placed by hand (absolute, by left
// and top). In a flex or grid frame the mask and what it masks go in a "mask group", a frame of their
// own laid out by hand, which is one item of the layout (maskGroupOps).

export type MaskType = "alpha" | "vector" | "luminance";
export const MASK_TYPES: readonly MaskType[] = ["alpha", "vector", "luminance"];
export const isMaskType = (v: unknown): v is MaskType => typeof v === "string" && (MASK_TYPES as readonly string[]).includes(v);

/** Whether a layer's mask is at work: it's a mask, shown, and in a frame (not on the page, not in a vector). */
export function maskActive(board: Board, id: string): boolean {
  const n = board.nodes[id];
  if (!n?.mask || n.hidden || !n.parent) return false;
  return board.nodes[n.parent]?.type === "frame";
}

export interface MaskRun {
  /** The mask whose layers these are (shown or hidden); none for the layers below the first mask. */
  mask?: string;
  ids: string[];
}

/** A frame's layers in runs: those below any mask, then each mask with the layers it masks. */
export function maskRuns(board: Board, ids: string[]): MaskRun[] {
  const runs: MaskRun[] = [{ ids: [] }];
  for (const id of ids) {
    const n = board.nodes[id];
    if (!n) continue;
    if (n.mask) runs.push({ mask: id, ids: [] });
    else runs[runs.length - 1].ids.push(id);
  }
  return runs;
}

/** The mask a layer is under: the nearest mask below it in its frame (shown or not). */
export function maskOf(board: Board, id: string): string | undefined {
  const n = board.nodes[id];
  if (!n?.parent || n.mask) return undefined;
  const p = board.nodes[n.parent];
  if (p?.type !== "frame") return undefined;
  const kids = p.children ?? [];
  for (let i = kids.indexOf(id) - 1; i >= 0; i--) if (board.nodes[kids[i]]?.mask) return kids[i];
  return undefined;
}

/** The layers a mask masks: those above it in its frame, up to the next mask. */
export function maskedBy(board: Board, mask: string): string[] {
  const n = board.nodes[mask];
  if (!n?.mask || !n.parent) return [];
  return maskRuns(board, board.nodes[n.parent]?.children ?? []).find((r) => r.mask === mask)?.ids ?? [];
}

/** A frame's layers as HTML, the layers each mask masks drawn inside the elements that mask them. */
function childrenHtml(board: Board, kids: string[], opts: HtmlOptions, depth: number): string {
  const draw = (c: string) => nodeHtml(board, c, opts, depth + 1);
  if (!kids.some((c) => board.nodes[c]?.mask)) return kids.map(draw).join("");
  return maskRuns(board, kids)
    .map((r) => {
      const inner = r.ids.map(draw).join("");
      if (!r.mask) return inner;
      const css = maskActive(board, r.mask) && inner ? maskCss(board, r.mask, { src: opts.src }) : null;
      const m = draw(r.mask);
      if (!css) return m + inner;
      return `${m}<div data-mask-scope${opts.ids ? `="${r.mask}"` : ""} style="${escAttr(styleText(css.scope))}"><div style="${escAttr(styleText(css.box))}">${inner}</div></div>`;
    })
    .join("");
}

// ----- The mask's look as CSS

/** A list split at its top-level commas (not those inside brackets). */
function splitList(v: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of v) {
    if (ch === "(") depth++;
    else if (ch === ")") depth = Math.max(0, depth - 1);
    if (ch === "," && depth === 0) {
      out.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** Words of CSS split at top-level spaces, a "/" its own word. */
function splitWords(v: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  const push = () => {
    if (cur.trim()) out.push(cur.trim());
    cur = "";
  };
  for (const ch of v) {
    if (ch === "(") depth++;
    else if (ch === ")") depth = Math.max(0, depth - 1);
    if (depth === 0 && /\s/.test(ch)) push();
    else if (depth === 0 && ch === "/") {
      push();
      out.push("/");
    } else cur += ch;
  }
  push();
  return out;
}

/** Where the bracket opened at `i` closes. */
function closing(s: string, i: number): number {
  let d = 0;
  for (let j = i; j < s.length; j++) {
    if (s[j] === "(") d++;
    else if (s[j] === ")" && --d === 0) return j;
  }
  return s.length - 1;
}

const IMAGE_FN = /(?:url|(?:repeating-)?(?:linear|radial|conic)-gradient|-webkit-(?:linear|radial)-gradient|image-set|-webkit-image-set|cross-fade)\(/i;
const REPEATS = new Set(["repeat", "no-repeat", "repeat-x", "repeat-y", "space", "round"]);
const COLORISH = /^(#|rgba?\(|hsla?\(|hwb\(|lab\(|lch\(|oklab\(|oklch\(|color\(|color-mix\(|var\(|transparent$|currentcolor$|[a-z]+$)/i;
const POSITION_WORDS = new Set(["left", "right", "top", "bottom", "center"]);

interface Fill {
  image: string;
  size: string;
  position: string;
  repeat: string;
}

/** A frame's fills as CSS has them (top first), and its colour (drawn under them). */
function fillsOfStyle(s: Style): { fills: Fill[]; color?: string } {
  const at = (list: string[], i: number, d: string) => (list.length ? list[i % list.length] : d);
  const sizes = splitList(s.backgroundSize ?? "");
  const positions = splitList(s.backgroundPosition ?? "");
  const repeats = splitList(s.backgroundRepeat ?? "");
  let color = s.backgroundColor;
  const fills: Fill[] = [];
  if (s.backgroundImage) {
    splitList(s.backgroundImage).forEach((image, i) => {
      if (image !== "none") fills.push({ image, size: at(sizes, i, "auto"), position: at(positions, i, "0% 0%"), repeat: at(repeats, i, "repeat") });
    });
  } else if (s.background) {
    const layers = splitList(s.background);
    layers.forEach((layer, i) => {
      const m = IMAGE_FN.exec(layer);
      let image = "";
      let rest = layer;
      if (m) {
        const end = closing(layer, m.index + m[0].length - 1);
        image = layer.slice(m.index, end + 1);
        rest = `${layer.slice(0, m.index)} ${layer.slice(end + 1)}`;
      }
      const pos: string[] = [];
      const size: string[] = [];
      const rep: string[] = [];
      let inSize = false;
      for (const w of splitWords(rest)) {
        if (w === "/") inSize = true;
        else if (REPEATS.has(w)) rep.push(w);
        else if (/^(scroll|fixed|local|border-box|padding-box|content-box|text|none)$/i.test(w)) continue;
        else if (i === layers.length - 1 && !POSITION_WORDS.has(w) && !/^-?[\d.]/.test(w) && COLORISH.test(w)) color ??= w;
        else (inSize ? size : pos).push(w);
      }
      if (image) fills.push({ image, size: size.join(" ") || "auto", position: pos.join(" ") || "0% 0%", repeat: rep.join(" ") || "repeat" });
    });
  }
  return { fills, color: color && color !== "transparent" ? color : undefined };
}

const RADIUS_LONGHANDS = ["borderTopLeftRadius", "borderTopRightRadius", "borderBottomRightRadius", "borderBottomLeftRadius"] as const;

/** A layer's corners as clip-path's inset() has them after "round", or undefined for square ones. */
function cornersOf(s: Style): string | undefined {
  const four = (list: string[]): string[] => {
    const [a = "0", b = a, c = a, d = b] = list;
    return [a, b, c, d];
  };
  const short = splitWords(s.borderRadius ?? "");
  const slash = short.indexOf("/");
  const h = four(slash < 0 ? short : short.slice(0, slash));
  const v = slash < 0 ? h.slice() : four(short.slice(slash + 1));
  RADIUS_LONGHANDS.forEach((k, i) => {
    const w = splitWords(s[k] ?? "");
    if (!w.length) return;
    h[i] = w[0];
    v[i] = w[1] ?? w[0];
  });
  const zero = (x: string) => /^0(px|%|em|rem)?$/.test(x.trim());
  if ([...h, ...v].every(zero)) return undefined;
  const say = (list: string[]) => (list.every((x) => x === list[0]) ? list[0] : list.join(" "));
  return say(h) === say(v) ? say(h) : `${say(h)} / ${say(v)}`;
}

/** var(--x) (with fallbacks, and tokens that use tokens) replaced by the board's values: for a picture drawn outside the page. */
export function resolveTokens(value: string, tokens: BoardToken[]): string {
  if (!value.includes("var(")) return value;
  const map = new Map(tokens.map((t) => [t.name, t.value]));
  const once = (s: string): string => {
    let out = "";
    let i = 0;
    for (;;) {
      const at = s.indexOf("var(", i);
      if (at < 0) return out + s.slice(i);
      const end = closing(s, at + 3);
      const inner = s.slice(at + 4, end);
      const name = (splitList(inner)[0] ?? "").trim();
      const fallback = inner.includes(",") ? inner.slice(inner.indexOf(",") + 1).trim() : "";
      out += s.slice(i, at) + (map.get(name) ?? fallback);
      i = end + 1;
    }
  };
  let out = value;
  for (let k = 0; k < 8 && out.includes("var("); k++) out = once(out);
  return out;
}

/** SVG markup as a data: URL that's safe inside url("…") and an HTML attribute. */
export function svgDataUrl(svg: string): string {
  return `data:image/svg+xml,${svg.replace(/[^\x20-\x7e]|[%#"'<>(){}|\\^`[\]]/gu, (c) => (c.length === 1 && c.charCodeAt(0) < 128 ? `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}` : encodeURIComponent(c)))}`;
}

const cssUrl = (u: string) => `url("${u.replace(/["\\\n]/g, (c) => encodeURIComponent(c))}")`;
const NO_SIZE = /^(auto|fit-content|max-content|min-content|stretch|-webkit-fill-available)?$/;
const FITS: Record<string, string> = { fill: "100% 100%", cover: "cover", contain: "contain", none: "auto", "scale-down": "contain" };

/** What a layer passes down to its words that a picture of them must be told. */
const TEXT_INHERITED = ["fontFamily", "fontSize", "fontWeight", "fontStyle", "fontStretch", "fontVariant", "lineHeight", "letterSpacing", "wordSpacing", "color", "textAlign", "textTransform", "textIndent", "whiteSpace", "wordBreak", "overflowWrap", "direction", "fontFeatureSettings", "fontVariationSettings", "webkitFontSmoothing", "textRendering", "hyphens", "tabSize"];
/** Where and how big a layer is, and its opacity: the mask's box and its opacity layer say these. */
const MASK_PLACEMENT = /^(position|left|top|right|bottom|inset|width|height|(min|max)(Width|Height)|margin\w*|transform|rotate|translate|scale|opacity|zIndex|flex|flexGrow|flexShrink|flexBasis|alignSelf|justifySelf|placeSelf|order|grid(Area|Row|Column)\w*|mixBlendMode|visibility|display)$/;

/**
 * @font-face rules with their font files inside (data: URLs), by family (lower case): what a text
 * mask's picture needs, since an SVG drawn as an image can't load fonts. Filled by loadMaskFonts.
 */
export const MASK_FONTS = new Map<string, string>();
const maskFontListeners = new Set<() => void>();
/** Be told when fonts for text masks have arrived (to draw them again). Returns the way to stop. */
export function onMaskFonts(fn: () => void): () => void {
  maskFontListeners.add(fn);
  return () => void maskFontListeners.delete(fn);
}

const familyNames = (list: string | undefined) =>
  (list ?? "")
    .split(",")
    .map((f) => f.trim().replace(/^["']|["']$/g, ""))
    .filter(Boolean);

/** The font family a style gives: its own, or the one in its `font` shorthand (after the size). */
const familyOf = (s: Style | undefined): string | undefined =>
  s?.fontFamily ?? (s?.font ? /(?:^|\s)(?:[\d.]+(?:px|pt|r?em|%|v[wh]|ex|ch|cm|mm|in|pc|q)|(?:xx?-|x?x?-)?(?:small|large)|medium|smaller|larger)(?:\s*\/\s*\S+)?\s+(.+)$/i.exec(s.font)?.[1] : undefined);

/** A text layer's words as XHTML (what an SVG's foreignObject takes). */
function xhtml(nodes: HNode[]): string {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return nodes
    .map((c) => {
      if (typeof c === "string") return esc(c);
      if (c.tag === "br" || c.tag === "wbr") return `<${c.tag}/>`;
      const attrs = Object.entries(c.attrs)
        .filter(([k, v]) => ATTR_NAME.test(k) && safeAttr(k, v))
        .map(([k, v]) => ` ${k}="${escAttr(v).replace(/>/g, "&gt;")}"`)
        .join("");
      return `<${c.tag}${attrs}>${xhtml(c.children)}</${c.tag}>`;
    })
    .join("");
}

/** A text layer drawn as an SVG picture of its words, as the canvas lays them out. */
function textMaskSvg(board: Board, id: string, type: MaskType): string {
  const n = board.nodes[id];
  const style: Style = {};
  // Later wins, as in CSS: a property set again goes to the end (after a shorthand set before it).
  const put = (from: Style, keep: (k: string) => boolean = () => true) => {
    for (const [k, v] of Object.entries(from))
      if (keep(k)) {
        delete style[k];
        style[k] = v;
      }
  };
  put({ margin: "0", fontFamily: "Inter, system-ui, sans-serif", fontSize: "16px", color: "#000" });
  const up: Style = {};
  for (const a of ancestors(board, id)) {
    const s = board.nodes[a]?.style ?? {};
    // A `font` shorthand counts when nothing nearer set the type (it would undo what did).
    if (s.font && !["font", "fontFamily", "fontSize", "fontWeight", "fontStyle", "lineHeight"].some((k) => up[k] !== undefined)) up.font = s.font;
    for (const k of TEXT_INHERITED) if (s[k] !== undefined && up[k] === undefined) up[k] = s[k];
  }
  put(up);
  put(n.style, (k) => !MASK_PLACEMENT.test(k));
  const width = n.style.width && !NO_SIZE.test(n.style.width.trim());
  const height = n.style.height && !NO_SIZE.test(n.style.height.trim());
  put({ boxSizing: "border-box", width: width ? "100%" : "max-content", maxWidth: "100%", ...(height ? { height: "100%" } : {}) });
  if (type === "vector") put({ color: "#000", webkitTextFillColor: "#000", background: "none", backgroundImage: "none", textShadow: "none", filter: "none" });
  for (const [k, v] of Object.entries(style)) style[k] = resolveTokens(v, board.tokens);
  // A picture can't reach the system's UI font by these names.
  for (const k of ["fontFamily", "font"]) if (style[k]) style[k] = style[k].replace(/-apple-system|BlinkMacSystemFont/gi, "system-ui");
  const families = new Set(familyNames(familyOf(n.style) ? resolveTokens(familyOf(n.style)!, board.tokens) : style.fontFamily).map((f) => f.toLowerCase()));
  for (const m of (n.text ?? "").matchAll(/font-family:\s*([^;"]+)/gi)) for (const f of familyNames(resolveTokens(m[1], board.tokens))) families.add(f.toLowerCase());
  const faces = [...families].map((f) => MASK_FONTS.get(f) ?? "").join("");
  const words = xhtml(parseHtml(resolveTokens(n.text ?? "", board.tokens)).children);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="100%">${faces ? `<style>${faces}</style>` : ""}<foreignObject x="0" y="0" width="100%" height="100%"><div xmlns="http://www.w3.org/1999/xhtml" style="${escAttr(styleText(style))}">${words}</div></foreignObject></svg>`;
}

/** A vector layer as an SVG picture: its markup, sized by the box it's drawn in, tokens and colour filled in. */
function vectorMaskSvg(board: Board, id: string, type: MaskType): string {
  const n = board.nodes[id];
  const markup = resolveTokens(svgMarkup(board, id), board.tokens).trim();
  let color = n.style.color;
  for (const a of ancestors(board, id)) color ??= board.nodes[a]?.style.color;
  const open = /^<svg\b[^>]*>/i.exec(markup);
  if (!open) return "";
  // Its size is the box it's drawn in (mask-size), as an inline <svg> at 100% of its layer.
  let head = open[0].replace(/\s(width|height)="[^"]*"/gi, "").replace(/^<svg\b/i, '<svg width="100%" height="100%"');
  if (!/\sxmlns=/.test(head)) head = head.replace(/^<svg\b/i, '<svg xmlns="http://www.w3.org/2000/svg"');
  if (color) head = head.replace(/^<svg\b/i, `<svg style="color:${escAttr(resolveTokens(color, board.tokens))}"`);
  let body = markup.slice(open[0].length).replace(/<\/svg>\s*$/i, "");
  // A vector mask is its outline: every painted pixel counts as solid.
  if (type === "vector") body = `<defs><filter id="bd-solid" x="-50%" y="-50%" width="200%" height="200%"><feComponentTransfer><feFuncA type="linear" slope="255"/></feComponentTransfer></filter></defs><g filter="url(#bd-solid)">${body}</g>`;
  return `${head}${body}</svg>`;
}

export interface MaskCss {
  /** The element that covers the frame, holding what the mask shows. */
  scope: Style;
  /** The element inside it on the mask's box, with the mask's look as CSS. */
  box: Style;
}

/** The CSS that masks the layers above a mask (see the top of this section), or null if it isn't one. */
export function maskCss(board: Board, id: string, opts: { src?: (src: string) => string } = {}): MaskCss | null {
  const n = board.nodes[id];
  if (!n?.mask) return null;
  const type = n.mask;
  const s = n.style;
  // Where it is: left/top (or right/bottom) and its size, in its frame.
  const [it, ir = it, ib = it, il = ir] = splitWords(s.inset ?? "");
  const given = (v: string | undefined) => (v === undefined || NO_SIZE.test(v.trim()) ? undefined : v.trim());
  const L = given(s.left ?? il);
  const T = given(s.top ?? it);
  const R = given(s.right ?? ir);
  const Bm = given(s.bottom ?? ib);
  const W = given(s.width);
  const H = given(s.height);
  const scope: Style = { position: "absolute", inset: "0" };
  const box: Style = {};
  // Inside calc() a length needs its unit: a bare 0 there makes the whole calc() invalid (a mask at
  // the top of its frame then had no height, and showed nothing).
  const inCalc = (v: string) => (/^[+-]?(0+\.?0*|\.0+)$/.test(v.trim()) ? "0px" : v);
  if (L !== undefined) {
    box.marginLeft = L;
    if (W) box.width = W;
  } else if (R !== undefined) {
    if (W) Object.assign(box, { marginLeft: `calc(100% - ${inCalc(R)} - ${inCalc(W)})`, width: W });
    else box.marginRight = R;
  } else if (W) box.width = W;
  if (T !== undefined && !T.includes("%")) Object.assign(box, { marginTop: T, height: H ?? `calc(100% - ${inCalc(T)})` });
  else if (T !== undefined) {
    // A top in % is of the frame's height, which a margin can't say: a grid row can.
    Object.assign(scope, { display: "grid", gridTemplateRows: `${T} ${H ?? "1fr"}` });
    box.gridRow = "2";
  } else if (Bm !== undefined) {
    Object.assign(scope, { display: "flex", flexDirection: "column", justifyContent: "flex-end" });
    Object.assign(box, { flex: "none", marginBottom: Bm, height: H ?? "auto" });
  } else box.height = H ?? "100%";

  // Its look.
  interface Layer {
    image: string;
    size: string;
    position: string;
    repeat: string;
    composite: "add" | "intersect";
  }
  const layers: Layer[] = [];
  const whole = (image: string): Layer => ({ image, size: "100% 100%", position: "0% 0%", repeat: "no-repeat", composite: "add" });
  const NOTHING = "linear-gradient(transparent, transparent)";
  const corners = n.type === "frame" || n.type === "image" || n.type === "video" || n.type === "svg" ? cornersOf(s) : undefined;
  let clip = corners ? `inset(0 round ${corners})` : undefined;
  const map = (v: string) => (opts.src && v.includes("url(") ? mapCssUrls(v, opts.src) : v);
  if (type === "vector" && n.type !== "svg" && n.type !== "text") {
    // Its outline, corners and all; what it's filled with doesn't count.
    clip ??= "inset(0)";
  } else if (n.type === "frame") {
    const { fills, color } = fillsOfStyle(s);
    for (const f of fills) layers.push({ ...f, image: map(f.image), composite: "add" });
    if (color) layers.push(whole(`linear-gradient(${color}, ${color})`));
    if (!layers.length) layers.push(whole(NOTHING));
  } else if (n.type === "image" || n.type === "video") {
    const src = n.type === "video" ? n.poster : n.src;
    layers.push(src ? { image: cssUrl(opts.src ? opts.src(src) : src), size: FITS[s.objectFit ?? "fill"] ?? "100% 100%", position: s.objectPosition ?? "50% 50%", repeat: "no-repeat", composite: "add" } : whole(NOTHING));
  } else if (n.type === "svg") {
    const svg = vectorMaskSvg(board, id, type);
    layers.push(whole(svg ? cssUrl(svgDataUrl(svg)) : NOTHING));
  } else if (n.type === "text") {
    layers.push(whole(cssUrl(svgDataUrl(textMaskSvg(board, id, type)))));
  } else layers.push(whole(NOTHING));
  // Its opacity, over all of it.
  const op = s.opacity?.trim();
  if (layers.length && type !== "vector" && op && op !== "1" && op !== "100%") {
    const c = `rgb(255 255 255 / ${op})`;
    layers.unshift({ ...whole(`linear-gradient(${c}, ${c})`), composite: "intersect" });
  }
  if (layers.length) {
    const list = (k: keyof Layer) => layers.map((l) => l[k]).join(", ");
    const mode = type === "luminance" ? "luminance" : "alpha";
    Object.assign(box, {
      webkitMaskImage: list("image"),
      webkitMaskSize: list("size"),
      webkitMaskPosition: list("position"),
      webkitMaskRepeat: list("repeat"),
      webkitMaskComposite: layers.map((l) => (l.composite === "intersect" ? "source-in" : "source-over")).join(", "),
      maskImage: list("image"),
      maskSize: list("size"),
      maskPosition: list("position"),
      maskRepeat: list("repeat"),
      maskMode: layers.map(() => mode).join(", "),
      maskComposite: list("composite"),
    });
  }
  if (clip) Object.assign(box, { webkitClipPath: clip, clipPath: clip });
  return { scope, box };
}

/** How board_read describes a mask. */
function maskWords(board: Board, id: string): string {
  const n = board.nodes[id];
  const on = maskedBy(board, id);
  const bits = [`mask (${n.mask}) of ${on.length} layer${on.length === 1 ? "" : "s"} above it`];
  if (n.hidden) bits.push("hidden, so they're shown whole");
  const p = n.parent ? board.nodes[n.parent] : undefined;
  if (!p || p.type !== "frame") bits.push("not at work: a mask works inside a frame");
  else if (inFlow(board, id)) bits.push("in its frame's flex or grid flow, so its place isn't known from its CSS: give it position absolute with left and top, or make a mask group");
  return bits.join(", ");
}

// ----- HTML in

/** A layer written with data-mask (as boards write masks out) is a mask; the hiding its HTML had goes. */
function maskFromHtml(n: BoardNode, el: HEl): string {
  const v = el.attrs["data-mask"];
  if (v === undefined) return n.id;
  n.mask = isMaskType(v) ? v : "alpha";
  if (n.style.visibility === "hidden") delete n.style.visibility;
  return n.id;
}

const CSS_MASK_KEYS = ["mask", "maskImage", "maskSize", "maskPosition", "maskRepeat", "maskMode", "maskOrigin", "maskClip", "maskComposite", "maskType", "webkitMask", "webkitMaskImage", "webkitMaskSize", "webkitMaskPosition", "webkitMaskRepeat", "webkitMaskOrigin", "webkitMaskClip", "webkitMaskComposite", "webkitMaskSourceType"];

/**
 * A frame with a CSS mask (mask-image: a gradient or a picture) over layers it places by hand
 * becomes a mask group: the mask a layer of its own, under them. A mask over flowing layers stays
 * CSS (it draws the same; a mask layer needs the layers it masks placed by hand), as does one that
 * says more than a mask layer can (several images, composites, repeats, odd sizes).
 */
function importCssMask(nodes: Record<string, BoardNode>, id: string) {
  const f = nodes[id];
  const s = f.style;
  const image = s.maskImage ?? s.webkitMaskImage;
  if (!image || s.mask || s.webkitMask || s.maskComposite || s.webkitMaskComposite) return;
  const kids = (f.children ?? []).map((k) => nodes[k]).filter(Boolean);
  if (!kids.length || kids.some((k) => k.style.position !== "absolute" || k.mask)) return;
  const one = splitList(image);
  if (one.length !== 1) return;
  const size = (s.maskSize ?? s.webkitMaskSize ?? "auto").trim();
  const position = (s.maskPosition ?? s.webkitMaskPosition ?? "").trim();
  const repeat = (s.maskRepeat ?? s.webkitMaskRepeat ?? "").trim();
  const url = /^url\(\s*(['"]?)(.*?)\1\s*\)$/i.exec(one[0]);
  const gradient = /^(repeating-)?(linear|radial|conic)-gradient\(/i.test(one[0]);
  if (!url && !gradient) return;
  const fit = ({ auto: "fill", "100% 100%": "fill", cover: "cover", contain: "contain" } as Record<string, string>)[size];
  if (url ? !fit : size !== "auto" && size !== "100% 100%") return;
  if (gradient && position && !/^(0(px|%)? 0(px|%)?|center|50% 50%|left top|top left)$/.test(position)) return;
  if (url && repeat && repeat !== "no-repeat") return;
  const type: MaskType = /luminance/i.test(s.maskMode ?? s.webkitMaskSourceType ?? "") ? "luminance" : "alpha";
  const mid = newId();
  const place = { position: "absolute", left: "0px", top: "0px", width: "100%", height: "100%" };
  nodes[mid] = url
    ? { id: mid, type: "image", name: "Mask", parent: id, mask: type, src: url[2], style: { ...place, objectFit: fit!, ...(position ? { objectPosition: position } : {}) } }
    : { id: mid, type: "frame", name: "Mask", parent: id, mask: type, style: { ...place, backgroundImage: one[0] }, children: [] };
  f.children = [mid, ...(f.children ?? [])];
  for (const k of CSS_MASK_KEYS) delete s[k];
  if (!s.position) s.position = "relative";
}

// ----- Making and removing masks

function maskRefusal(board: Board, id: string): string | undefined {
  const n = board.nodes[id];
  if (!n) return `There's no layer ${id}.`;
  if (n.type === "vector") return `${n.name} is part of a vector: SVG has its own masks. Use the whole vector layer as the mask instead.`;
  if (!n.parent) return `${n.name} is on the page: a mask works inside a frame. Select it with the layers it should mask and use "Mask with selection" to put them in a mask group.`;
  return undefined;
}

/** Where a flex or grid layout puts an item: its cell, alignment, order, margins and flex sizing. */
const LAYOUT_PLACE = ["gridArea", "gridRow", "gridColumn", "gridRowStart", "gridRowEnd", "gridColumnStart", "gridColumnEnd", "justifySelf", "alignSelf", "placeSelf", "order", "margin", "marginTop", "marginRight", "marginBottom", "marginLeft", "flex", "flexGrow", "flexShrink", "flexBasis"];

/** A layer's box in its frame (left, top, width, height) as its CSS gives it, in px where it can tell. */
function boxFromStyle(n: BoardNode): Box {
  return { x: pxValue(n.style.left) ?? 0, y: pxValue(n.style.top) ?? 0, width: pxValue(n.style.width) ?? 100, height: pxValue(n.style.height) ?? 100 };
}

/**
 * Steps that make a layer a mask of the layers above it in its frame (or change its kind), or an
 * ordinary layer again (null). One placed by its frame's flex or grid layout goes into a mask group
 * of its own first, since a mask is placed by hand. `boxes` are layers' boxes in their frames as
 * drawn (the Studio measures them); without them their CSS says.
 */
export function maskOps(board: Board, id: string, type: MaskType | null, boxes: Record<string, Box> = {}): { ops: Op[]; group?: string } {
  if (type === null) return { ops: board.nodes[id]?.mask ? [{ op: "set", id, mask: null }] : [] };
  const why = maskRefusal(board, id);
  if (why) throw new OpError(why);
  const n = board.nodes[id];
  if (inFlow(board, id)) return maskGroupOps(board, [id], type, boxes);
  const ops: Op[] = [{ op: "set", id, mask: type }];
  // Its box must be in its CSS: one the flow placed (in a frame laid out by hand) is placed where it is now.
  const b = boxes[id];
  if (b && n.style.position !== "absolute" && n.style.position !== "fixed") ops.push({ op: "set", id, style: { position: "absolute", left: `${round(b.x)}px`, top: `${round(b.y)}px` } });
  return { ops };
}

/**
 * Steps that put layers side by side in one frame into a new "Mask group" frame, as Figma's "Use as
 * mask" does with several layers: the one at the back is the mask of the rest. The group is the
 * mask's box (what shows), placed where the mask was: in a flex or grid frame, as one item of the
 * layout. Inside it every layer is placed by hand where it was.
 */
export function maskGroupOps(board: Board, ids: string[], type: MaskType, boxes: Record<string, Box> = {}): { ops: Op[]; group: string } {
  const list = [...new Set(ids)].filter((x) => board.nodes[x]);
  if (!list.length) throw new OpError("Pick the layers to mask.");
  const parent = board.nodes[list[0]].parent;
  if (list.some((x) => board.nodes[x].parent !== parent)) throw new OpError("Pick layers side by side in one frame: the one at the back masks the rest.");
  for (const x of list) if (board.nodes[x].type === "vector") throw new OpError(maskRefusal(board, x)!);
  const sibs = siblingsOf(board, list[0]);
  const ordered = sibs.filter((x) => list.includes(x));
  const mask = ordered[0];
  const box = (x: string) => boxes[x] ?? boxFromStyle(board.nodes[x]);
  const mb = box(mask);
  const gid = newId();
  const p = parent ? board.nodes[parent] : null;
  const flowing = Boolean(p && (isFlex(p) || isGrid(p)) && inFlow(board, mask));
  const size = { width: `${round(mb.width)}px`, height: `${round(mb.height)}px` };
  // In a layout, the group takes the mask's place in it: its grid cell, its alignment, its order.
  const placed: Style = {};
  if (flowing) for (const k of LAYOUT_PLACE) if (board.nodes[mask].style[k] !== undefined) placed[k] = board.nodes[mask].style[k];
  const style: Style = flowing ? { position: "relative", flexShrink: "0", ...placed, ...size } : parent ? { position: "absolute", left: `${round(mb.x)}px`, top: `${round(mb.y)}px`, ...size } : { left: `${round(mb.x)}px`, top: `${round(mb.y)}px`, ...size };
  const page = parent ? undefined : pageOf(board, mask)?.id;
  const ops: Op[] = [{ op: "add", nodes: { [gid]: { id: gid, type: "frame", name: "Mask group", parent, style, children: [] } }, ids: [gid], parent, page, index: sibs.indexOf(mask) }];
  ordered.forEach((x, k) => {
    const b = box(x);
    ops.push({ op: "move", id: x, parent: gid, index: k });
    const unplace = Object.fromEntries(LAYOUT_PLACE.map((k) => [k, null]));
    ops.push({ op: "set", id: x, style: { ...unplace, position: "absolute", left: `${round(b.x - mb.x)}px`, top: `${round(b.y - mb.y)}px`, right: null, bottom: null, inset: null, ...(x === mask ? size : {}) } });
  });
  ops.push({ op: "set", id: mask, mask: type });
  return { ops, group: gid };
}

// ----- Fonts for text masks

type Fetcher = (url: string, init?: { headers?: Record<string, string> }) => Promise<{ ok: boolean; text(): Promise<string>; arrayBuffer(): Promise<ArrayBuffer> }>;
const FACE_RE = /@font-face\s*{[^}]*}/g;
const GOOGLE_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
const loadingFonts = new Map<string, Promise<void>>();

/** Whether a @font-face's unicode-range covers any of these characters (no range: it covers them all). */
function coversAny(face: string, chars: Set<number>): boolean {
  const m = /unicode-range:\s*([^;}]+)/i.exec(face);
  if (!m) return true;
  return m[1].split(",").some((r) => {
    const [a, b] = r.trim().replace(/^U\+/i, "").split("-");
    const lo = parseInt(a.replace(/\?/g, "0"), 16);
    const hi = b ? parseInt(b, 16) : parseInt(a.replace(/\?/g, "F"), 16);
    return [...chars].some((c) => c >= lo && c <= hi);
  });
}

/**
 * The web fonts (Google Fonts) a board's text masks use, fetched and put in MASK_FONTS with the font
 * files inside, so the pictures of their words use them. The Mac's own fonts need nothing. A font
 * that can't be had (offline, a name Google doesn't know) draws in the next font of its list.
 * Resolves true when it added any. `node`: asked from the engine (which says it's a browser, to be
 * given woff2 files).
 */
export async function loadMaskFonts(board: Board, fetcher: Fetcher = globalThis.fetch as unknown as Fetcher, opts: { node?: boolean } = {}): Promise<boolean> {
  const want = new Map<string, { weights: Set<string>; chars: Set<number> }>();
  for (const n of Object.values(board.nodes)) {
    if (n.type !== "text" || !n.mask || !n.parent) continue;
    let family = familyOf(n.style);
    let weight = n.style.fontWeight ?? (n.style.font ? /\b(bold|[1-9]00)\b/i.exec(n.style.font)?.[1] : undefined);
    for (const a of ancestors(board, n.id)) {
      family ??= familyOf(board.nodes[a]?.style);
      weight ??= board.nodes[a]?.style.fontWeight;
    }
    const words = plainText(n.text);
    const names = [...familyNames(resolveTokens(family ?? "Inter", board.tokens)), ...[...(n.text ?? "").matchAll(/font-family:\s*([^;"]+)/gi)].flatMap((m) => familyNames(resolveTokens(m[1], board.tokens)))];
    for (const name of names) {
      if (GENERIC_FONTS.has(name.toLowerCase()) || name.startsWith("-") || MASK_FONTS.has(name.toLowerCase())) continue;
      const w = want.get(name) ?? { weights: new Set(["400"]), chars: new Set<number>() };
      const fw = resolveTokens(weight ?? "400", board.tokens).trim();
      w.weights.add(fw === "bold" ? "700" : /^\d{3}$/.test(fw) ? fw : "400");
      for (const m of (n.text ?? "").matchAll(/font-weight:\s*(\d{3}|bold)/gi)) w.weights.add(m[1] === "bold" ? "700" : m[1]);
      if (/<(b|strong)\b/i.test(n.text ?? "")) w.weights.add("700");
      for (const ch of words) w.chars.add(ch.codePointAt(0)!);
      want.set(name, w);
    }
  }
  if (!want.size || typeof fetcher !== "function") return false;
  let added = false;
  const b64 = (buf: ArrayBuffer) => {
    const bytes = new Uint8Array(buf);
    let s = "";
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(s);
  };
  await Promise.all(
    [...want].map(([name, w]) => {
      const key = name.toLowerCase();
      const known = loadingFonts.get(key);
      if (known) return known;
      const job = (async () => {
        try {
          const weights = [...w.weights].sort();
          const url = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(name).replace(/%20/g, "+")}:ital,wght@${[0, 1].flatMap((i) => weights.map((x) => `${i},${x}`)).join(";")}&display=block`;
          const res = await fetcher(url, opts.node ? { headers: { "User-Agent": GOOGLE_UA } } : undefined);
          if (!res.ok) return;
          const css = await res.text();
          const faces = (css.match(FACE_RE) ?? []).filter((f) => coversAny(f, w.chars.size ? w.chars : new Set([65])));
          const out: string[] = [];
          for (const face of faces) {
            const src = /url\(\s*(['"]?)(https:[^'")]+)\1\s*\)(?:\s*format\(\s*['"]?([\w-]+)['"]?\s*\))?/i.exec(face);
            if (!src) continue;
            const file = await fetcher(src[2]);
            if (!file.ok) continue;
            const format = src[3] ?? (/\.woff2(\?|$)/.test(src[2]) ? "woff2" : /\.woff(\?|$)/.test(src[2]) ? "woff" : "truetype");
            const mime = format === "woff2" ? "font/woff2" : format === "woff" ? "font/woff" : "font/ttf";
            out.push(face.replace(/src:[^;}]+/i, `src:url(data:${mime};base64,${b64(await file.arrayBuffer())}) format("${format}")`));
          }
          if (out.length) {
            MASK_FONTS.set(key, out.join(""));
            added = true;
          }
        } catch {
          // Offline, or a font Google doesn't have: the words draw in the next font of their list.
        }
      })();
      loadingFonts.set(key, job);
      return job;
    }),
  );
  if (added) for (const fn of maskFontListeners) fn();
  return added;
}

// ---------------------------------------------------------------------------------------------
// Shaders: layers drawn live by the graphics card. The model (presets, parameters, HTML attributes)
// is in shaders.ts and the drawing in the Studio's board-shader-runtime.js; here is what needs a
// board: a frame's shader read from HTML, and the board's own presets.

const SHADER_SCRIPT = /^(x-shader\/x-fragment|x-shader\/fragment|x-shader|text\/x-glsl|x-glsl|glsl)$/i;
const isShaderScript = (c: HNode): c is HEl => typeof c !== "string" && c.tag === "script" && SHADER_SCRIPT.test((c.attrs.type ?? "").trim());

/** Whether an element has a shader: data-shader on it, or a canvas holding shader code. */
function isShaderElement(el: HEl): boolean {
  return el.attrs["data-shader"] !== undefined || (el.tag === "canvas" && el.children.some(isShaderScript));
}

/** A shader element's own layers: what's in it, less the canvas it's drawn on and its code. */
const shaderInner = (el: HEl): HNode[] => el.children.filter((c) => typeof c === "string" || (!isShaderScript(c) && !((c as HEl).tag === "canvas" && !isShaderElement(c as HEl))));

/** The shader an element has, from its attributes and the code in a <script> inside it. */
function shaderOf(el: HEl, warnings: string[]): ShaderSpec {
  const script = el.children.find(isShaderScript);
  const code = script ? script.children.filter((c): c is string => typeof c === "string").join("") : undefined;
  return shaderFromAttrs(el.attrs, code, warnings);
}

const shaderName = (el: HEl, shader: ShaderSpec) => (el.attrs["data-name"] || el.attrs["aria-label"] || el.attrs.title || presetOf(shader.preset)?.name || shader.preset || "Shader").slice(0, 60);

/** A frame with a shader and nothing else in it, from HTML: a size when nothing gives it one (a div would be 0 high). */
function shaderLayer(el: HEl, parent: string | null, style: Style, warnings: string[]): Omit<BoardNode, "id"> {
  const shader = shaderOf(el, warnings);
  // A canvas's own width and height attributes count, as an image's do.
  for (const k of ["width", "height"] as const) if (!style[k] && pxValue(el.attrs[k]) !== undefined) style[k] = `${pxValue(el.attrs[k])}px`;
  const has = (k: string) => style[k] !== undefined && style[k] !== "auto";
  if (!has("height") && !has("inset") && !(has("top") && has("bottom")) && !has("aspectRatio") && !has("flex") && !has("flexGrow")) {
    const w = pxValue(style.width);
    style.height = `${w ? Math.round(w * 0.75) : 300}px`;
  }
  if (!has("width") && !has("inset") && !(has("left") && has("right")) && (style.position === "absolute" || parent === null)) style.width = "400px";
  return { type: "frame", name: shaderName(el, shader), parent, style, children: [], shader };
}

/**
 * A board as an older Screenshotter kept it, brought up to date: a shader was a layer of its own
 * (type "shader"), and is now a frame's fill, so each becomes a frame with its shader. In place.
 */
export function upgradeBoard(b: Board): Board {
  for (const n of Object.values(b.nodes) as Array<Omit<BoardNode, "type"> & { type: string }>) {
    if (n.type !== "shader") continue;
    n.type = "frame";
    n.children ??= [];
  }
  return b;
}

/** Save, change or remove one of the board's own shader presets (on the board being changed); returns the step that undoes it. */
function shaderPresetStep(board: Board, op: Extract<Op, { op: "shaderPreset" }>): Op[] {
  const name = shaderPresetName(op.name);
  if (!name || name === CUSTOM_SHADER) throw new OpError(`"${op.name}" can't be a shader preset's name: use letters, digits and -.`);
  const list = (board.shaders ?? []).slice();
  const i = list.findIndex((s) => s.name === name);
  if (op.code !== null && i < 0 && presetOf(name)) throw new OpError(`"${name}" is one of the built-in shader presets: give yours another name.`);
  const undo: Op[] = [i >= 0 ? { op: "shaderPreset", name, code: list[i].code, index: i } : { op: "shaderPreset", name, code: null }];
  if (op.code === null) {
    if (i >= 0) list.splice(i, 1);
  } else {
    const code = cleanShaderCode(op.code);
    if (!code.trim()) throw new OpError("A shader preset needs its code.");
    if (i >= 0) list[i] = { name, code };
    else list.splice(Math.max(0, Math.min(list.length, op.index ?? list.length)), 0, { name, code });
  }
  if (list.length) board.shaders = list;
  else delete board.shaders;
  return undo;
}

/** The frames whose shader is one of the board's own presets. */
export const shaderUsers = (board: Board, name: string) => Object.values(board.nodes).filter((n) => n.shader?.preset === name).map((n) => n.id);

/**
 * Steps that save a frame's shader code as one of the board's own presets and make the frame use it
 * (keeping its code too, so it still draws if the preset is removed).
 */
export function saveShaderPresetOps(board: Board, id: string, name: string): Op[] {
  const n = board.nodes[id];
  if (!n?.shader) throw new OpError("Only a frame with a shader can save it as a shader preset.");
  const code = shaderCode(n.shader, board.shaders);
  if (!code) throw new OpError(`${n.name} has no shader code to save.`);
  const slug = shaderPresetName(name);
  return [
    { op: "shaderPreset", name: slug, code },
    { op: "set", id, shader: { ...n.shader, preset: slug, code } },
  ];
}
