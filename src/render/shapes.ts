/**
 * Shapes: arrows, lines, ellipses, rectangles, triangles, stars, number badges, award laurels and
 * star ratings drawn over the scene, clean or hand-drawn. Pure geometry and SVG with no imports, so the Studio canvas draws them
 * with this same code (the server hands the compiled file to the browser as /ui/shapes.js).
 */

export const SHAPE_TYPES = ["arrow", "line", "ellipse", "rect", "triangle", "star", "badge", "laurel", "rating"] as const;
export type ShapeType = (typeof SHAPE_TYPES)[number];
export const ARROW_HEADS = ["end", "start", "both", "none"] as const;
export const DASHES = ["solid", "dashed", "dotted"] as const;

export interface Point {
  x: number;
  y: number;
}

/** A shape with everything settled. Positions are canvas fractions (x of the width, y of the height). */
export interface ShapeSpec {
  type: ShapeType;
  /** Box shapes: centre, height (a fraction of the canvas height), width ÷ height in pixels, rotation. */
  x: number;
  y: number;
  size: number;
  aspect: number;
  rotate: number;
  /** Lines and arrows: the two ends, how far the line bows (-1 to 1) and where the heads go. */
  from: Point;
  to: Point;
  bend: number;
  head: (typeof ARROW_HEADS)[number];
  /** Colours ("none" for no fill or no stroke) and the stroke's width as a fraction of the canvas height. */
  fill: string;
  stroke: string;
  strokeWidth: number;
  dash: (typeof DASHES)[number];
  /** Rectangles: corner radius as a share of the shorter side (0.5 makes a pill). */
  radius: number;
  /** Stars: how many points. */
  points: number;
  /** Badges: the number or letter, and its colour (a laurel's and a rating's words too). */
  label: string;
  labelColor: string;
  /** Laurels: the words inside the wreath (\n breaks a line). Ratings: the line under the stars. */
  text: string;
  /** Laurels: a smaller line under the words. */
  caption: string;
  /** Ratings: how many of the five stars are filled, e.g. 4.8. */
  value: number;
  /** Hand-drawn: a marker's wobble, overshoot and open ends. `seed` picks the wobble. */
  sketch: boolean;
  seed: number;
  opacity: number;
  shadow: boolean;
  /** Soft focus: a fraction of the canvas width up to 0.5, or px. */
  blur: number;
}

/** What each type looks like when nothing is said: red marks for pointing, warm fills for decoration. */
export const SHAPE_DEFAULTS: Record<ShapeType, Partial<ShapeSpec>> = {
  arrow: { stroke: "#ff3b30", fill: "none", strokeWidth: 0.006, head: "end", bend: 0.3 },
  line: { stroke: "#ff3b30", fill: "none", strokeWidth: 0.005, head: "none", bend: 0 },
  ellipse: { stroke: "#ff3b30", fill: "none", strokeWidth: 0.005, size: 0.1, aspect: 1.5 },
  rect: { stroke: "#ff3b30", fill: "none", strokeWidth: 0.005, size: 0.09, aspect: 1.7, radius: 0.2 },
  triangle: { fill: "#ffd60a", stroke: "none", strokeWidth: 0.005, size: 0.07, aspect: 1.1 },
  star: { fill: "#ffd60a", stroke: "none", strokeWidth: 0.005, size: 0.07, aspect: 1, points: 5 },
  badge: { fill: "#ff3b30", stroke: "#ffffff", strokeWidth: 0.0035, size: 0.045, aspect: 1, label: "1", labelColor: "#ffffff" },
  laurel: { fill: "#e9c46a", stroke: "none", size: 0.085, aspect: 2.5, text: "App of the Day" },
  rating: { fill: "#ffd60a", stroke: "none", size: 0.06, aspect: 3.4, value: 5 },
};

export const isLine = (t: ShapeType) => t === "arrow" || t === "line";

type Loose = Partial<Omit<ShapeSpec, "from" | "to">> & { type: ShapeType; from?: Partial<Point>; to?: Partial<Point> };

/** Fill in every property a shape leaves out. `index` numbers badges and seeds the hand-drawn wobble. */
export function shapeSpec(input: Loose, index = 0): ShapeSpec {
  const d = SHAPE_DEFAULTS[input.type] ?? {};
  const pick = <K extends keyof ShapeSpec>(k: K, fallback: ShapeSpec[K]): ShapeSpec[K] => (input[k] ?? d[k] ?? fallback) as ShapeSpec[K];
  const x = input.x ?? 0.5;
  const y = input.y ?? 0.5;
  // A line without ends runs through its centre, rising to the right.
  const from = { x: input.from?.x ?? x - 0.12, y: input.from?.y ?? y + 0.05 };
  const to = { x: input.to?.x ?? x + 0.12, y: input.to?.y ?? y - 0.05 };
  return {
    type: input.type,
    x,
    y,
    size: pick("size", 0.08),
    aspect: input.type === "badge" ? Math.max(1, pick("aspect", 1)) : pick("aspect", 1),
    rotate: pick("rotate", 0),
    from,
    to,
    bend: Math.max(-1, Math.min(1, pick("bend", 0))),
    head: pick("head", "none"),
    fill: pick("fill", "none"),
    stroke: pick("stroke", "none"),
    strokeWidth: pick("strokeWidth", 0.005),
    dash: pick("dash", "solid"),
    radius: Math.max(0, Math.min(0.5, pick("radius", 0))),
    points: Math.max(3, Math.min(12, Math.round(pick("points", 5)))),
    label: input.label ?? d.label ?? String(index + 1),
    // A laurel's and a rating's words are the wreath's or the stars' colour unless set.
    labelColor: input.labelColor ?? (input.type === "laurel" || input.type === "rating" ? (input.fill ?? d.fill ?? "#ffffff") : (d.labelColor ?? "#ffffff")),
    text: input.text ?? d.text ?? "",
    caption: input.caption ?? "",
    value: Math.max(0, Math.min(5, pick("value", 5))),
    sketch: pick("sketch", false),
    seed: pick("seed", index + 1),
    opacity: pick("opacity", 1),
    shadow: pick("shadow", false),
    blur: Math.max(0, pick("blur", 0)),
  };
}

// ---------------------------------------------------------------------------------------------
// Geometry

const f = (n: number) => Math.round(n * 10) / 10;
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** A small, repeatable random sequence, so a hand-drawn shape keeps its wobble between renders. */
function random(seed: number) {
  let a = (Math.imul(seed | 0, 2654435761) >>> 0) || 1;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A line's ends in pixels, and the control point of its curve. */
export function lineGeometry(s: ShapeSpec, W: number, H: number) {
  const A = { x: s.from.x * W, y: s.from.y * H };
  const B = { x: s.to.x * W, y: s.to.y * H };
  const L = Math.hypot(B.x - A.x, B.y - A.y) || 1;
  const n = { x: -(B.y - A.y) / L, y: (B.x - A.x) / L };
  const M = { x: (A.x + B.x) / 2, y: (A.y + B.y) / 2 };
  const C = { x: M.x + n.x * s.bend * L * 0.5, y: M.y + n.y * s.bend * L * 0.5 };
  return { A, B, C, L, n, M };
}

/** The middle of a line's curve, in pixels: where the Studio puts its bend handle. */
export function curveMid(s: ShapeSpec, W: number, H: number): Point {
  const { A, B, C } = lineGeometry(s, W, H);
  return { x: 0.25 * A.x + 0.5 * C.x + 0.25 * B.x, y: 0.25 * A.y + 0.5 * C.y + 0.25 * B.y };
}

/** The bend that puts the middle of the curve at `p` (pixels). */
export function bendThrough(s: ShapeSpec, p: Point, W: number, H: number): number {
  const { L, n, M } = lineGeometry(s, W, H);
  const off = (p.x - M.x) * n.x + (p.y - M.y) * n.y;
  return Math.max(-1, Math.min(1, Math.round((off / (L / 4)) * 100) / 100));
}

/** A box shape's size in pixels. */
export function boxSize(s: ShapeSpec, H: number) {
  const h = s.size * H;
  return { w: h * s.aspect, h };
}

const strokeWidthPx = (s: ShapeSpec, H: number) => (s.strokeWidth < 1 ? s.strokeWidth * H : s.strokeWidth);

function dashAttr(s: ShapeSpec, sw: number) {
  if (s.dash === "dashed") return ` stroke-dasharray="${f(sw * 2.6)} ${f(sw * 2)}"`;
  if (s.dash === "dotted") return ` stroke-dasharray="0.01 ${f(sw * 2)}"`;
  return "";
}

const pathOf = (pts: Point[], closed = false) => `M${pts.map((p) => `${f(p.x)} ${f(p.y)}`).join("L")}${closed ? "Z" : ""}`;

/** A marker ring: once round and a little more, drifting outward, with a gentle wobble. */
function sketchEllipse(w: number, h: number, rnd: () => number): string {
  const start = -Math.PI * (0.55 + rnd() * 0.15);
  const sweep = Math.PI * 2 * (1.07 + rnd() * 0.06);
  const phase = rnd() * Math.PI * 2;
  const drift = 0.05 + rnd() * 0.04;
  const pts: Point[] = [];
  const n = 84;
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const a = start + sweep * t;
    const k = 1 - drift / 2 + drift * t + 0.022 * Math.sin(a * 2 + phase);
    pts.push({ x: w / 2 + (w / 2) * k * Math.cos(a), y: h / 2 + (h / 2) * k * Math.sin(a) });
  }
  return pathOf(pts);
}

/** Each edge of a polygon drawn as its own slightly bowed stroke, overshooting the corners. */
function sketchPolygon(v: Point[], rnd: () => number, scale: number): string {
  let d = "";
  for (let i = 0; i < v.length; i++) {
    const a = v[i];
    const b = v[(i + 1) % v.length];
    const L = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    const u = { x: (b.x - a.x) / L, y: (b.y - a.y) / L };
    const nrm = { x: -u.y, y: u.x };
    const o1 = (0.01 + rnd() * 0.05) * L;
    const o2 = (0.01 + rnd() * 0.05) * L;
    const j = () => (rnd() - 0.5) * scale * 0.05;
    const p = { x: a.x - u.x * o1 + nrm.x * j(), y: a.y - u.y * o1 + nrm.y * j() };
    const q = { x: b.x + u.x * o2 + nrm.x * j(), y: b.y + u.y * o2 + nrm.y * j() };
    const bow = (rnd() - 0.5) * Math.min(L * 0.06, scale * 0.06);
    const c = { x: (p.x + q.x) / 2 + nrm.x * bow, y: (p.y + q.y) / 2 + nrm.y * bow };
    d += `M${f(p.x)} ${f(p.y)}Q${f(c.x)} ${f(c.y)} ${f(q.x)} ${f(q.y)}`;
  }
  return d;
}

/** A leaf: an almond from `base`, `len` long and `wid` wide, pointing along the angle `a` (radians). */
function leaf(base: Point, a: number, len: number, wid: number): string {
  const ux = Math.cos(a);
  const uy = Math.sin(a);
  const tip = { x: base.x + ux * len, y: base.y + uy * len };
  const mid = { x: base.x + ux * len * 0.5, y: base.y + uy * len * 0.5 };
  const nx = -uy * wid;
  const ny = ux * wid;
  return `M${f(base.x)} ${f(base.y)}Q${f(mid.x + nx)} ${f(mid.y + ny)} ${f(tip.x)} ${f(tip.y)}Q${f(mid.x - nx)} ${f(mid.y - ny)} ${f(base.x)} ${f(base.y)}Z`;
}

/**
 * One branch of a laurel, the left one, in a bw×h box: a stem curving up from the bottom middle, with
 * leaves along it, the outer ones larger, all getting smaller towards the top.
 */
function laurelBranch(bw: number, h: number): string {
  const A = { x: bw * 0.95, y: h * 0.97 };
  const C = { x: -bw * 0.12, y: h * 0.6 };
  const B = { x: bw * 0.45, y: h * 0.04 };
  const at = (t: number) => ({ x: (1 - t) ** 2 * A.x + 2 * (1 - t) * t * C.x + t * t * B.x, y: (1 - t) ** 2 * A.y + 2 * (1 - t) * t * C.y + t * t * B.y });
  const dir = (t: number) => Math.atan2(2 * (1 - t) * (C.y - A.y) + 2 * t * (B.y - C.y), 2 * (1 - t) * (C.x - A.x) + 2 * t * (B.x - C.x));
  let d = `M${f(A.x)} ${f(A.y)}Q${f(C.x)} ${f(C.y)} ${f(B.x)} ${f(B.y)}`;
  const stem = d;
  d = "";
  const n = 7;
  for (let i = 0; i < n; i++) {
    const t = 0.1 + (i * 0.84) / (n - 1);
    const p = at(t);
    const a = dir(t);
    const len = h * (0.21 - 0.07 * t);
    // The outer leaf leans away from the wreath's middle, the inner one towards it.
    d += leaf(p, a - 0.62, len, len * 0.3);
    if (i > 0) d += leaf(p, a + 0.6, len * 0.78, len * 0.78 * 0.3);
  }
  // The tip: one leaf carrying on along the stem.
  d += leaf(B, dir(1), h * 0.13, h * 0.13 * 0.3);
  return `<path d="${stem}" fill="none" stroke="currentColor" stroke-width="${f(h * 0.016)}" stroke-linecap="round"/><path d="${d}"/>`;
}

/** Words as given with \n, else every way to set them in one or two lines (split nearest the middle). */
function lineChoices(text: string): string[][] {
  const given = text.split(/\\n|\n/).map((l) => l.trim()).filter(Boolean);
  if (given.length !== 1) return [given.slice(0, 3)];
  const words = given[0].split(/\s+/).filter(Boolean);
  if (words.length < 2) return [given];
  // The break nearest the middle of the characters.
  const total = words.join(" ").length;
  let best = 1;
  let bestGap = Infinity;
  for (let k = 1; k < words.length; k++) {
    const gap = Math.abs(words.slice(0, k).join(" ").length - total / 2);
    if (gap < bestGap) {
      bestGap = gap;
      best = k;
    }
  }
  return [given, [words.slice(0, best).join(" "), words.slice(best).join(" ")]];
}

const TEXT_FONT = "'SF Pro Display','SF Pro Text',-apple-system,system-ui,'Helvetica Neue',sans-serif";
/** Roughly how wide text is, in ems per character, for fitting it in a space. */
const EM_PER_CHAR = 0.56;

/** A laurel: the two branches, and the words (and caption) between them, fitted to the space. */
function laurelSvg(s: ShapeSpec, w: number, h: number): string {
  const bw = Math.min(h * 0.62, w * 0.3);
  const branch = laurelBranch(bw, h);
  const room = w - bw * 1.9;
  // One line or two, whichever lets the words be bigger.
  const fit = (ls: string[]) => Math.min(h * (ls.length > 2 ? 0.17 : ls.length > 1 ? 0.22 : 0.27), room / (Math.max(1, ...ls.map((l) => l.length)) * EM_PER_CHAR));
  const ls = lineChoices(s.text).reduce((a, b) => (fit(b) > fit(a) * 1.08 ? b : a));
  const size = fit(ls);
  const capLong = Math.max(1, s.caption.length);
  const cap = s.caption ? Math.min(h * 0.13, room / (capLong * EM_PER_CHAR * 0.9)) : 0;
  const block = ls.length * size * 1.08 + (cap ? cap * 1.45 : 0);
  let y = h / 2 - block / 2;
  let words = "";
  for (const l of ls) {
    words += `<text x="${f(w / 2)}" y="${f(y + size * 0.84)}" text-anchor="middle" font-family="${TEXT_FONT}" font-weight="700" font-size="${f(size)}" letter-spacing="-0.01em" fill="${esc(s.labelColor)}">${esc(l)}</text>`;
    y += size * 1.08;
  }
  if (cap) words += `<text x="${f(w / 2)}" y="${f(y + cap * 1.2)}" text-anchor="middle" font-family="${TEXT_FONT}" font-weight="500" font-size="${f(cap)}" letter-spacing="0.02em" fill="${esc(s.labelColor)}" opacity="0.85">${esc(s.caption)}</text>`;
  return `<g fill="${esc(s.fill)}" color="${esc(s.fill)}">${branch}<g transform="translate(${f(w)} 0) scale(-1 1)">${branch}</g></g>${words}`;
}

let clips = 0;

/** A rating: five stars filled to `value`, the rest faint, and a line of words under them. */
function ratingSvg(s: ShapeSpec, w: number, h: number): string {
  const hasText = Boolean(s.text);
  const star = Math.min(h * (hasText ? 0.58 : 0.92), w / 5.6);
  const gap = star * 0.14;
  const row = star * 5 + gap * 4;
  const x0 = (w - row) / 2;
  const y0 = hasText ? h * 0.04 : (h - star) / 2;
  const pts = starPoints(star, star, 5);
  let body = "";
  for (let i = 0; i < 5; i++) {
    const x = x0 + i * (star + gap);
    const d = pathOf(pts.map((p) => ({ x: p.x + x, y: p.y + y0 })), true);
    const full = Math.max(0, Math.min(1, s.value - i));
    if (full < 1) body += `<path d="${d}" fill="${esc(s.fill)}" opacity="0.28"/>`;
    if (full >= 1) body += `<path d="${d}" fill="${esc(s.fill)}"/>`;
    else if (full > 0) {
      const id = `rate${++clips}`;
      body += `<clipPath id="${id}"><rect x="${f(x)}" y="${f(y0 - 1)}" width="${f(star * full)}" height="${f(star + 2)}"/></clipPath><path d="${d}" fill="${esc(s.fill)}" clip-path="url(#${id})"/>`;
    }
  }
  if (hasText) {
    const size = Math.min(h * 0.27, w / (Math.max(1, s.text.length) * EM_PER_CHAR * 0.95));
    body += `<text x="${f(w / 2)}" y="${f(y0 + star + (h - y0 - star) * 0.5 + size * 0.36)}" text-anchor="middle" font-family="${TEXT_FONT}" font-weight="600" font-size="${f(size)}" fill="${esc(s.labelColor)}">${esc(s.text)}</text>`;
  }
  return body;
}

function starPoints(w: number, h: number, n: number): Point[] {
  const pts: Point[] = [];
  for (let i = 0; i < n * 2; i++) {
    const r = i % 2 ? 0.46 : 1;
    const a = -Math.PI / 2 + (i * Math.PI) / n;
    pts.push({ x: w / 2 + (w / 2) * r * Math.cos(a), y: h / 2 + (h / 2) * r * Math.sin(a) + h * 0.04 });
  }
  return pts;
}

export interface ShapeRender {
  /** Where the SVG sits on the canvas (pixels) and its rotation about its centre. */
  left: number;
  top: number;
  width: number;
  height: number;
  rotate: number;
  /** A drop shadow for the CSS `filter`, when the shape has one. */
  filter?: string;
  svg: string;
}

/**
 * Draw a shape for a W×H canvas. `hit` (pixels) adds a wide invisible stroke along the shape, so a
 * thin line is easy to grab in an editor.
 */
export function renderShape(s: ShapeSpec, W: number, H: number, opts: { hit?: number } = {}): ShapeRender {
  const sw = strokeWidthPx(s, H);
  const rnd = random(s.seed);
  const stroke = s.stroke !== "none" && sw > 0;
  const fill = s.fill !== "none";
  const strokeAttrs = stroke ? `stroke="${esc(s.stroke)}" stroke-width="${f(sw)}" stroke-linecap="round" stroke-linejoin="round"${dashAttr(s, sw)}` : `stroke="none"`;
  const soft = !s.blur ? 0 : s.blur <= 0.5 ? s.blur * W : s.blur;
  const filter = [s.shadow ? `drop-shadow(0 ${f(H * 0.004)}px ${f(H * 0.01)}px rgba(0,0,0,0.35))` : "", soft > 0.05 ? `blur(${f(soft)}px)` : ""].filter(Boolean).join(" ") || undefined;
  const hitPath = (d: string, closedFill = false) =>
    opts.hit ? `<path class="hit" d="${d}" fill="${closedFill ? "transparent" : "none"}" stroke="transparent" stroke-width="${f(Math.max(opts.hit, sw))}" pointer-events="${closedFill ? "all" : "stroke"}"/>` : "";
  let body = "";

  if (isLine(s.type)) {
    const { A, B, C } = lineGeometry(s, W, H);
    const headLen = Math.max(sw * 4.2, H * 0.012);
    const headW = headLen * 0.62;
    const ends = { start: s.head === "start" || s.head === "both", end: s.head === "end" || s.head === "both" };
    const unit = (p: Point, q: Point) => {
      const L = Math.hypot(p.x - q.x, p.y - q.y) || 1;
      return { x: (p.x - q.x) / L, y: (p.y - q.y) / L };
    };
    // Tangents at the ends point away from the curve's control point.
    const dEnd = unit(B, C.x === B.x && C.y === B.y ? A : C);
    const dStart = unit(A, C.x === A.x && C.y === A.y ? B : C);
    let a = A;
    let b = B;
    const heads: string[] = [];
    const head = (tip: Point, d: Point) => {
      const base = { x: tip.x - d.x * headLen, y: tip.y - d.y * headLen };
      const n = { x: -d.y, y: d.x };
      if (s.sketch) {
        // A marker's open chevron, one stroke each side.
        const wing = (k: number) => {
          const ang = 0.5 + (rnd() - 0.5) * 0.12;
          const c = Math.cos(ang * k);
          const si = Math.sin(ang * k);
          const back = { x: -(d.x * c - d.y * si), y: -(d.x * si + d.y * c) };
          const len = headLen * (1.05 + rnd() * 0.15);
          return `M${f(tip.x)} ${f(tip.y)}L${f(tip.x + back.x * len)} ${f(tip.y + back.y * len)}`;
        };
        heads.push(`<path d="${wing(1)}${wing(-1)}" fill="none" ${strokeAttrs.replace(/ stroke-dasharray="[^"]*"/, "")}/>`);
      } else {
        const pts = [tip, { x: base.x + n.x * headW, y: base.y + n.y * headW }, { x: base.x - n.x * headW, y: base.y - n.y * headW }];
        heads.push(`<path d="${pathOf(pts, true)}" fill="${esc(s.stroke)}" stroke="${esc(s.stroke)}" stroke-width="${f(sw * 0.5)}" stroke-linejoin="round"/>`);
      }
      // The line stops inside a solid head, so its round cap never pokes past the tip.
      return s.sketch ? tip : { x: tip.x - d.x * headLen * 0.8, y: tip.y - d.y * headLen * 0.8 };
    };
    if (stroke && ends.end) b = head(B, dEnd);
    if (stroke && ends.start) a = head(A, dStart);
    let c = C;
    if (s.sketch) {
      const L = Math.hypot(B.x - A.x, B.y - A.y);
      const j = (rnd() - 0.5) * L * 0.05;
      c = { x: C.x + (-(B.y - A.y) / (L || 1)) * j, y: C.y + ((B.x - A.x) / (L || 1)) * j };
    }
    const d = `M${f(a.x)} ${f(a.y)}Q${f(c.x)} ${f(c.y)} ${f(b.x)} ${f(b.y)}`;
    // The box around the whole curve, with room for the stroke and heads.
    const xs = [A.x, B.x];
    const ys = [A.y, B.y];
    for (let i = 1; i < 16; i++) {
      const t = i / 16;
      xs.push((1 - t) ** 2 * A.x + 2 * (1 - t) * t * C.x + t * t * B.x);
      ys.push((1 - t) ** 2 * A.y + 2 * (1 - t) * t * C.y + t * t * B.y);
    }
    const pad = Math.max(headLen, sw * 2, opts.hit ?? 0) + 2;
    const left = Math.min(...xs) - pad;
    const top = Math.min(...ys) - pad;
    const width = Math.max(...xs) - Math.min(...xs) + pad * 2;
    const height = Math.max(...ys) - Math.min(...ys) + pad * 2;
    body = (stroke ? `<path d="${d}" fill="none" ${strokeAttrs}/>` + heads.join("") : "") + hitPath(d);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${f(width)}" height="${f(height)}" viewBox="${f(left)} ${f(top)} ${f(width)} ${f(height)}" style="display:block;overflow:visible"><g opacity="${s.opacity}">${body}</g></svg>`;
    return { left, top, width, height, rotate: 0, filter, svg };
  }

  const { w, h } = boxSize(s, H);
  const scale = Math.min(w, h);
  let outline = "";
  let fillShape = "";
  switch (s.type) {
    case "ellipse": {
      fillShape = `<ellipse cx="${f(w / 2)}" cy="${f(h / 2)}" rx="${f(w / 2)}" ry="${f(h / 2)}"`;
      outline = s.sketch ? `<path d="${sketchEllipse(w, h, rnd)}"` : fillShape;
      break;
    }
    case "rect":
    case "badge": {
      const r = s.type === "badge" ? h / 2 : s.radius * scale;
      fillShape = `<rect x="0" y="0" width="${f(w)}" height="${f(h)}" rx="${f(r)}"`;
      const corners = [
        { x: 0, y: 0 },
        { x: w, y: 0 },
        { x: w, y: h },
        { x: 0, y: h },
      ];
      outline = s.sketch && s.type === "rect" ? `<path d="${sketchPolygon(corners, rnd, scale)}"` : s.sketch ? `<path d="${sketchEllipse(w, h, rnd)}"` : fillShape;
      break;
    }
    case "triangle": {
      const v = [
        { x: w / 2, y: 0 },
        { x: w, y: h },
        { x: 0, y: h },
      ];
      fillShape = `<path d="${pathOf(v, true)}"`;
      outline = s.sketch ? `<path d="${sketchPolygon(v, rnd, scale)}"` : fillShape;
      break;
    }
    case "star": {
      const v = starPoints(w, h, s.points);
      fillShape = `<path d="${pathOf(v, true)}"`;
      outline = s.sketch ? `<path d="${sketchPolygon(v, rnd, scale * 0.6)}"` : fillShape;
      break;
    }
    case "laurel":
    case "rating": {
      // Drawn whole: the wreath or stars, and their words, in the fill colour.
      body = s.type === "laurel" ? laurelSvg(s, w, h) : ratingSvg(s, w, h);
      if (opts.hit) body += `<rect class="hit" x="0" y="0" width="${f(w)}" height="${f(h)}" fill="transparent" stroke="none" pointer-events="all"/>`;
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${f(w)}" height="${f(h)}" viewBox="0 0 ${f(w)} ${f(h)}" style="display:block;overflow:visible"><g opacity="${s.opacity}">${body}</g></svg>`;
      return { left: s.x * W - w / 2, top: s.y * H - h / 2, width: w, height: h, rotate: s.rotate, filter, svg };
    }
  }
  // Hand-drawn: the fill sits a touch off the outline, like a marker's colour inside a pen line.
  const nudge = s.sketch ? ` transform="translate(${f(scale * 0.02)} ${f(scale * 0.025)})"` : "";
  if (fill) body += `${fillShape} fill="${esc(s.fill)}" stroke="none"${outline === fillShape ? "" : nudge}/>`;
  if (stroke) body += `${outline} fill="none" ${strokeAttrs}/>`;
  if (s.type === "badge" && s.label) {
    const size = h * (s.label.length > 2 ? 0.42 : 0.56);
    body += `<text x="${f(w / 2)}" y="${f(h / 2)}" text-anchor="middle" dominant-baseline="central" font-family="'SF Pro Rounded','SF Pro Display',-apple-system,system-ui,sans-serif" font-weight="700" font-size="${f(size)}" fill="${esc(s.labelColor)}">${esc(s.label)}</text>`;
  }
  const hitD = s.type === "ellipse" || s.type === "badge" ? `M0 ${f(h / 2)}A${f(w / 2)} ${f(h / 2)} 0 1 0 ${f(w)} ${f(h / 2)}A${f(w / 2)} ${f(h / 2)} 0 1 0 0 ${f(h / 2)}Z` : s.type === "rect" ? `M0 0H${f(w)}V${f(h)}H0Z` : "";
  body += hitD ? hitPath(hitD, fill || s.type === "badge") : opts.hit ? `${fillShape} fill="transparent" stroke="transparent" stroke-width="${f(Math.max(opts.hit, sw))}" pointer-events="all" class="hit"/>` : "";
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${f(w)}" height="${f(h)}" viewBox="0 0 ${f(w)} ${f(h)}" style="display:block;overflow:visible"><g opacity="${s.opacity}">${body}</g></svg>`;
  return { left: s.x * W - w / 2, top: s.y * H - h / 2, width: w, height: h, rotate: s.rotate, filter, svg };
}

/** The shape as an absolutely positioned element of a W×H page (`id` marks it for animation). */
export function shapeHtml(s: ShapeSpec, W: number, H: number, z: number, id?: string): string {
  const r = renderShape(s, W, H);
  const style = [
    "position:absolute",
    `left:${f(r.left)}px`,
    `top:${f(r.top)}px`,
    `width:${f(r.width)}px`,
    `height:${f(r.height)}px`,
    `z-index:${z}`,
    r.rotate ? `transform:rotate(${r.rotate}deg)` : "",
    r.filter ? `filter:${r.filter}` : "",
    "overflow:visible",
  ]
    .filter(Boolean)
    .join(";");
  return `<div class="shape"${id ? ` data-ent="${esc(id)}"` : ""} style="${style}">${r.svg}</div>`;
}
