/**
 * Shapes: arrows, lines, ellipses, rectangles, triangles, stars and number badges drawn over the
 * scene, clean or hand-drawn. Pure geometry and SVG with no imports, so the Studio canvas draws them
 * with this same code (the server hands the compiled file to the browser as /ui/shapes.js).
 */

export const SHAPE_TYPES = ["arrow", "line", "ellipse", "rect", "triangle", "star", "badge"] as const;
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
  /** Badges: the number or letter, and its colour. */
  label: string;
  labelColor: string;
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
    labelColor: pick("labelColor", "#ffffff"),
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
