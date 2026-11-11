/**
 * Boards: designs made of real HTML and CSS, laid out on pages of artboards, that agents and people
 * edit together. A board is a tree of layers (frames, text, images and vectors), each with its CSS.
 *
 * This module is pure (no imports, no Node or DOM APIs) so the engine and the Studio's canvas share
 * it: the canvas loads the compiled file as /ui/board-core.js. Everything that changes a board goes
 * through `applyOps`, which also returns the steps that undo it.
 */

export type NodeType = "frame" | "text" | "image" | "svg";
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
  /** An image layer's picture: a file path, a URL or a data: URI. */
  src?: string;
  /** A vector layer's <svg> markup. */
  svg?: string;
  hidden?: boolean;
  locked?: boolean;
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
const UNITLESS = new Set(["opacity", "zIndex", "fontWeight", "lineHeight", "flexGrow", "flexShrink", "flex", "order", "aspectRatio", "scale", "zoom", "gridRow", "gridColumn", "columnCount", "orphans", "widows", "fillOpacity", "strokeOpacity", "stopOpacity"]);

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
export function htmlToNodes(html: string): Imported {
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
    const own = parseStyle(el.attrs.style);
    if (own.display === "none") return undefined;
    // Something that sat in a line (inline, inline-block) keeps its own width when its parent becomes a column.
    const inlineLevel = INLINE.has(el.tag) ? !own.display || own.display.startsWith("inline") : (own.display ?? "").startsWith("inline");
    const style: Style = { ...own };
    if (inFlowColumn && inlineLevel && !style.alignSelf) style.alignSelf = "flex-start";

    if (el.tag === "img") {
      if (!style.objectFit && style.width && style.height) style.objectFit = "cover";
      for (const k of ["width", "height"] as const) if (!style[k] && pxValue(el.attrs[k]) !== undefined) style[k] = `${pxValue(el.attrs[k])}px`;
      return add({ type: "image", name: nameFor(el, "Image"), parent, style, src: el.attrs.src ?? "" });
    }
    if (el.tag === "svg") {
      const view = (el.attrs.viewBox ?? el.attrs.viewbox ?? "").split(/[\s,]+/).map(Number);
      const w = pxValue(el.attrs.width) ?? (view.length === 4 && view[2] > 0 ? view[2] : 24);
      const h = pxValue(el.attrs.height) ?? (view.length === 4 && view[3] > 0 ? view[3] : 24);
      if (!style.width) style.width = `${w}px`;
      if (!style.height) style.height = `${h}px`;
      const attrs = { ...el.attrs };
      delete attrs.style;
      delete attrs.class;
      return add({ type: "svg", name: nameFor(el, w <= 48 && h <= 48 ? "Icon" : "Vector"), parent, style, svg: serializeSvg({ ...el, attrs }) });
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
    if (!laysOut && isInlineOnly(el) && hasWords(el)) {
      const text = inlineHtml(el.children);
      return add({ type: "text", name: nameFor(el, "Text", plainText(text)), parent, style: { ...TAG_TEXT[el.tag], ...style }, text });
    }
    // A frame. Block flow becomes a column, so its children stack as they did.
    if (FLOWING.has(style.display ?? "")) {
      style.display = "flex";
      if (!style.flexDirection) style.flexDirection = "column";
    } else if (style.display === "inline-flex") style.display = "flex";
    else if (style.display === "inline-grid") style.display = "grid";
    const id = add({ type: "frame", name: nameFor(el, "Frame"), parent, style, children: [] });
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
      const k = convert(c, id, column);
      if (k) kids.push(k);
    }
    flush();
    nodes[id].children = kids;
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
    if (id) roots.push(id);
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
}

export function nodeHtml(board: Board, id: string, opts: HtmlOptions = {}, depth = 0): string {
  const n = board.nodes[id];
  if (!n || (n.hidden && !opts.hidden)) return "";
  const style: Style = { ...n.style };
  if (n.parent === null && depth === 0 && !opts.placed) {
    delete style.left;
    delete style.top;
    if (style.position === "absolute") delete style.position;
  }
  if (n.hidden) style.display = "none";
  const css = styleText(style);
  const attrs = `${opts.ids ? ` data-id="${id}" data-name="${escAttr(n.name)}"` : ""}${css ? ` style="${escAttr(css)}"` : ""}`;
  switch (n.type) {
    case "text":
      return `<div${attrs}>${n.text ?? ""}</div>`;
    case "image": {
      const src = n.src ? (opts.src ? opts.src(n.src) : n.src) : "";
      return `<img${attrs} src="${escAttr(src)}" alt="${escAttr(n.name)}">`;
    }
    case "svg":
      return `<div${attrs}>${(n.svg ?? "").replace(/^<svg\b/i, '<svg style="display:block;width:100%;height:100%"')}</div>`;
    default:
      return `<div${attrs}>${(n.children ?? []).map((c) => nodeHtml(board, c, opts, depth + 1)).join("")}</div>`;
  }
}

/** The CSS every board is drawn with, in the Studio and in exports alike. */
export const BOARD_CSS = "*,*::before,*::after{box-sizing:border-box}img{display:block}";

export function tokenCss(board: Board): string {
  return board.tokens.map((t) => `${t.name}:${t.value}`).join(";");
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

/** Google Fonts stylesheets for families the Mac may not have. A family Google doesn't know just doesn't load. */
export function fontLinks(families: Map<string, Set<string>>): string[] {
  const links: string[] = [];
  for (const [family, weights] of families) {
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
    nodes[nid] = { ...n, id: nid, parent: p, style: { ...n.style }, ...(n.children ? { children: [] } : {}) };
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
  | { op: "add"; nodes: Record<string, BoardNode>; ids: string[]; parent: string | null; page?: string; index?: number }
  /** Change a layer: style properties (null removes one), its name, words, picture, vector, visibility or lock. */
  | { op: "set"; id: string; style?: Record<string, string | null>; replaceStyle?: Style; name?: string; text?: string | null; src?: string | null; svg?: string | null; hidden?: boolean | null; locked?: boolean | null }
  | { op: "delete"; ids: string[] }
  /** Move a layer into another frame (or onto a page), at an index among its new siblings. */
  | { op: "move"; id: string; parent: string | null; page?: string; index?: number }
  | { op: "addPage"; page: BoardPage; index?: number }
  | { op: "setPage"; id: string; name: string }
  | { op: "deletePage"; id: string }
  | { op: "movePage"; id: string; index: number }
  /** Set a design token (null removes it). */
  | { op: "token"; name: string; value: string | null; index?: number }
  | { op: "rename"; name: string }
  /** Mark artboards as being worked on by an agent (null clears them; no ids clears all). */
  | { op: "working"; ids?: string[]; at: string | null };

export class OpError extends Error {}

export function applyOps(input: Board, ops: Op[]): { board: Board; inverse: Op[] } {
  const board: Board = { ...input, nodes: { ...input.nodes }, pages: input.pages.slice(), tokens: input.tokens.slice() };
  const copied = new Set<string>();
  const mut = (id: string): BoardNode => {
    const n = board.nodes[id];
    if (!n) throw new OpError(`There's no layer ${id}.`);
    if (!copied.has(id)) {
      board.nodes[id] = { ...n, style: { ...n.style }, ...(n.children ? { children: n.children.slice() } : {}) };
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
      if (p.type !== "frame") throw new OpError(`Only frames hold layers; ${p.name} is ${p.type === "text" ? "text" : `a${p.type === "image" ? "n image" : " vector"}`}.`);
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
        for (const [id, n] of Object.entries(op.nodes)) {
          if (board.nodes[id]) throw new OpError(`A layer ${id} is already on the board.`);
          board.nodes[id] = n;
        }
        for (const id of op.ids) {
          const n = board.nodes[id];
          if (!n) throw new OpError(`The layers to add don't include ${id}.`);
          if (board.nodes[id] !== op.nodes[id]) throw new OpError(`Layer ${id} isn't one of the new layers.`);
          board.nodes[id] = { ...n, parent: op.parent };
          list.splice(at++, 0, id);
        }
        undo.push({ op: "delete", ids: op.ids.slice() });
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
        if (op.name !== undefined) {
          back.name = n.name;
          n.name = op.name.slice(0, 120) || n.name;
        }
        for (const k of ["text", "src", "svg", "hidden", "locked"] as const) {
          if (op[k] === undefined) continue;
          (back as Record<string, unknown>)[k] = n[k] ?? null;
          if (op[k] === null || op[k] === false) delete n[k];
          else (n as unknown as Record<string, unknown>)[k] = op[k];
        }
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
          undo.unshift({ op: "add", nodes, ids: [id], parent: w.parent, page: w.page, index: w.index });
        }
        break;
      }
      case "move": {
        const n = board.nodes[op.id];
        if (!n) throw new OpError(`There's no layer ${op.id}.`);
        if (op.parent && (op.parent === op.id || ancestors(board, op.parent).includes(op.id))) throw new OpError("A layer can't go inside itself.");
        const w = where(op.id);
        listOf(w.parent, w.page).splice(w.index, 1);
        const list = listOf(op.parent, op.parent ? undefined : op.page ?? w.page);
        const at = op.index === undefined || op.index < 0 || op.index > list.length ? list.length : op.index;
        list.splice(at, 0, op.id);
        mut(op.id).parent = op.parent;
        undo.push({ op: "move", id: op.id, parent: w.parent, page: w.page, index: w.index });
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
      default:
        throw new OpError(`Unknown step ${(op as { op: string }).op}.`);
    }
    inverse.push(undo);
  }
  return { board, inverse: inverse.reverse().flat() };
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
    if (!main && !v && (s.alignSelf === "stretch" || (!s.alignSelf && (p.style.alignItems ?? "stretch") === "stretch")) && n.type !== "image") return "fill";
  }
  if (!v || v === "auto" || v === "fit-content" || v === "max-content") return n.type === "image" && !v ? "auto" : "fit";
  if (v === "100%") return "fill";
  const px = pxValue(v);
  return px !== undefined ? String(round(px, 1)) : v;
}

function describe(board: Board, id: string): string {
  const n = board.nodes[id];
  const s = n.style;
  const size = `${sizeWord(board, id, "width")}×${sizeWord(board, id, "height")}`;
  const bits: string[] = [n.type, JSON.stringify(n.name), `#${id}`, size];
  if (n.parent === null) bits.push(`at ${pxValue(s.left) ?? 0},${pxValue(s.top) ?? 0}`);
  if (isFlex(n)) bits.push(`flex ${(s.flexDirection ?? "row").startsWith("column") ? "column" : "row"}${s.gap ? ` gap ${s.gap}` : ""}`);
  else if (isGrid(n)) bits.push("grid");
  if (s.position === "absolute") bits.push(`absolute ${s.left ?? "?"},${s.top ?? "?"}`);
  if (n.type === "text") {
    const words = plainText(n.text);
    bits.push(JSON.stringify(words.length > 60 ? words.slice(0, 59) + "…" : words));
  }
  if (n.type === "image") bits.push(`src ${(n.src ?? "").slice(0, 80)}`);
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

export function emptyBoard(id: string, name: string, now: string): Board {
  return { id, name, rev: 0, pages: [{ id: newId(), name: "Page 1", children: [] }], nodes: {}, tokens: [], createdAt: now, updatedAt: now };
}
