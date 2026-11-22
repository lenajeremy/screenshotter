/**
 * Shapes' outlines when Figma didn't store them. A .fig file keeps every shape's drawn outline
 * (fillGeometry, strokeGeometry), but what Figma puts on the clipboard leaves them out: vectors
 * carry only their vector network (the points and curves you edit), and ellipses, stars, polygons,
 * lines and rectangles only their size and settings. This rebuilds the outlines from those, in the
 * shape's own pixels, as SVG path data: the fill (by region, with its winding rule) and the line a
 * stroke follows (drawn with SVG's stroke; see fig-convert for Figma's inside and outside strokes).
 */

export interface Pt {
  x: number;
  y: number;
}
export interface FillPath {
  d: string;
  /** NONZERO or ODD, as Figma names them. */
  rule: string;
  /** The vector's own style for this region (its fills), when it has one. */
  styleID?: number;
}
export interface Outline {
  fills: FillPath[];
  /** The line the stroke follows: every segment, joined where they meet. */
  stroke: string;
  /** Whether the stroke's line is closed all round (a shape), or has ends (where caps go). */
  closed: boolean;
  /** Ends of open lines, for caps: the point, and the direction the line leaves it in. */
  ends: Array<{ at: Pt; dir: Pt; styleID?: number }>;
}

const r3 = (n: number) => String(Math.round(n * 1000) / 1000);
const P = (p: Pt) => `${r3(p.x)} ${r3(p.y)}`;

// ---------------------------------------------------------------------------------------------
// Vector networks

interface Seg {
  a: number;
  b: number;
  ta: Pt;
  tb: Pt;
  styleID: number;
}
interface Net {
  v: Array<Pt & { styleID: number }>;
  s: Seg[];
  regions: Array<{ styleID: number; rule: string; loops: number[][] }>;
}

/**
 * Figma's vector network blob: counts of vertices, segments and regions (u32 each), then each
 * vertex (style u32, x f32, y f32), each segment (style u32, start u32, start tangent f32 f32,
 * end u32, end tangent f32 f32), and each region (style << 1 | nonzero as one u32, its loop count, then
 * each loop: its segment count and the segments' indices).
 */
export function decodeNetwork(buf: Buffer): Net | null {
  try {
    let p = 0;
    const u = () => {
      const v = buf.readUInt32LE(p);
      p += 4;
      return v;
    };
    const f = () => {
      const v = buf.readFloatLE(p);
      p += 4;
      return v;
    };
    const nv = u();
    const ns = u();
    const nr = u();
    if (nv > 1e6 || ns > 1e6 || nr > 1e5) return null;
    const v: Net["v"] = [];
    for (let i = 0; i < nv; i++) {
      const styleID = u();
      v.push({ styleID, x: f(), y: f() });
    }
    const s: Seg[] = [];
    for (let i = 0; i < ns; i++) {
      const styleID = u();
      const a = u();
      const ta = { x: f(), y: f() };
      const b = u();
      const tb = { x: f(), y: f() };
      s.push({ a, b, ta, tb, styleID });
    }
    const regions: Net["regions"] = [];
    for (let i = 0; i < nr; i++) {
      const packed = u();
      const styleID = packed >> 1;
      const flags = (packed & 1) | (u() << 1);
      const loops: number[][] = [];
      for (let l = 0; l < flags >> 1; l++) {
        const n = u();
        const loop: number[] = [];
        for (let k = 0; k < n; k++) loop.push(u());
        loops.push(loop);
      }
      regions.push({ styleID, rule: flags & 1 ? "NONZERO" : "ODD", loops });
    }
    return { v, s, regions };
  } catch {
    return null;
  }
}

/** One piece of a path: a straight line or a cubic curve, from `p0` to `p3`. */
interface Piece {
  p0: Pt;
  c1: Pt;
  c2: Pt;
  p3: Pt;
  line: boolean;
}
const isZero = (t: Pt) => Math.abs(t.x) < 1e-6 && Math.abs(t.y) < 1e-6;
const sub = (a: Pt, b: Pt) => ({ x: a.x - b.x, y: a.y - b.y });
const add = (a: Pt, b: Pt) => ({ x: a.x + b.x, y: a.y + b.y });
const mul = (a: Pt, k: number) => ({ x: a.x * k, y: a.y * k });
const len = (a: Pt) => Math.hypot(a.x, a.y);
const unit = (a: Pt) => {
  const l = len(a) || 1;
  return { x: a.x / l, y: a.y / l };
};

/** A segment as a piece, scaled from the network's size into the shape's, run either way. */
function piece(net: Net, sg: Seg, k: Pt, reverse: boolean): Piece {
  const A = { x: net.v[sg.a].x * k.x, y: net.v[sg.a].y * k.y };
  const B = { x: net.v[sg.b].x * k.x, y: net.v[sg.b].y * k.y };
  const CA = { x: A.x + sg.ta.x * k.x, y: A.y + sg.ta.y * k.y };
  const CB = { x: B.x + sg.tb.x * k.x, y: B.y + sg.tb.y * k.y };
  // A curve whose handles lie on its own chord is a straight line (and its corners round like one).
  const chord = sub(B, A);
  const l2 = chord.x * chord.x + chord.y * chord.y;
  const onChord = (q: Pt) => {
    const v = sub(q, A);
    const t = (v.x * chord.x + v.y * chord.y) / (l2 || 1);
    return Math.abs(v.x * chord.y - v.y * chord.x) <= 1e-3 * l2 && t >= -1e-6 && t <= 1 + 1e-6;
  };
  const line = (isZero(sg.ta) && isZero(sg.tb)) || (l2 > 0 && onChord(CA) && onChord(CB));
  return reverse ? { p0: B, c1: CB, c2: CA, p3: A, line } : { p0: A, c1: CA, c2: CB, p3: B, line };
}

/**
 * Pieces in order as SVG path data, with straight corners rounded by `radius` (Figma's corner
 * radius: an arc that meets both sides, made smaller when the sides are too short for it).
 */
function piecesPath(pieces: Piece[], closed: boolean, radius: (i: number) => number): string {
  if (!pieces.length) return "";
  const n = pieces.length;
  // Each corner (the start of piece i, where piece i-1 ends) that can be rounded: how far back it's cut.
  const cut = new Array<number>(n).fill(0);
  const rad = new Array<number>(n).fill(0);
  for (let i = 0; i < n; i++) {
    if (!closed && i === 0) continue;
    const r = radius(i);
    if (!(r > 0)) continue;
    const prev = pieces[(i - 1 + n) % n];
    const cur = pieces[i];
    if (!prev.line || !cur.line) continue;
    const u1 = unit(sub(prev.p0, cur.p0));
    const u2 = unit(sub(cur.p3, cur.p0));
    const cos = Math.max(-1, Math.min(1, u1.x * u2.x + u1.y * u2.y));
    const theta = Math.acos(cos);
    if (theta < 1e-3 || Math.PI - theta < 1e-3) continue;
    cut[i] = r / Math.tan(theta / 2);
    rad[i] = r;
  }
  // A side shared by two rounded corners gives each at most its half (Figma shrinks the radius to fit).
  const lens = pieces.map((p) => len(sub(p.p3, p.p0)));
  for (let i = 0; i < n; i++) {
    if (!cut[i]) continue;
    const prevLen = lens[(i - 1 + n) % n];
    const curLen = lens[i];
    const prevShare = cut[(i - 1 + n) % n] && (closed || i - 1 > 0) ? prevLen / 2 : prevLen;
    const curShare = cut[(i + 1) % n] && (closed || i + 1 < n) ? curLen / 2 : curLen;
    const max = Math.min(prevShare, curShare);
    if (cut[i] > max) {
      rad[i] *= max / cut[i];
      cut[i] = max;
    }
  }
  const out: string[] = [];
  const startOf = (i: number) => (cut[i] ? add(pieces[i].p0, mul(unit(sub(pieces[i].p3, pieces[i].p0)), cut[i])) : pieces[i].p0);
  const endOf = (i: number) => {
    const nx = (i + 1) % n;
    if (!(closed || i + 1 < n) || !cut[nx]) return pieces[i].p3;
    return add(pieces[i].p3, mul(unit(sub(pieces[i].p0, pieces[i].p3)), cut[nx]));
  };
  const corner = (i: number) => {
    // The arc round corner i, from the end of the piece before it to the start of piece i.
    const prev = (i - 1 + n) % n;
    const V = pieces[i].p0;
    const a = endOf(prev);
    const b = startOf(i);
    const u1 = unit(sub(pieces[prev].p0, V));
    const u2 = unit(sub(pieces[i].p3, V));
    const theta = Math.acos(Math.max(-1, Math.min(1, u1.x * u2.x + u1.y * u2.y)));
    const phi = Math.PI - theta;
    const h = (4 / 3) * Math.tan(phi / 4) * rad[i];
    const c1 = add(a, mul(unit(sub(V, a)), h));
    const c2 = add(b, mul(unit(sub(V, b)), h));
    out.push(`C${P(c1)} ${P(c2)} ${P(b)}`);
  };
  out.push(`M${P(startOf(0))}`);
  for (let i = 0; i < n; i++) {
    const p = pieces[i];
    const e = endOf(i);
    if (p.line) out.push(`L${P(e)}`);
    else out.push(`C${P(p.c1)} ${P(p.c2)} ${P(e)}`);
    if (i + 1 < n && cut[i + 1]) corner(i + 1);
  }
  if (closed) {
    if (cut[0]) corner(0);
    out.push("Z");
  }
  return out.join("");
}

/**
 * A vector's outline from its network, scaled from the size it was drawn at to the layer's size.
 * `radiusOf` gives a vertex's corner radius (the vector's own, or its vertex style's).
 */
export function networkOutline(buf: Buffer, normalized: Pt | undefined, size: Pt, radiusOf: (styleID: number) => number): Outline | null {
  const net = decodeNetwork(buf);
  if (!net) return null;
  const k = { x: normalized?.x ? size.x / normalized.x : 1, y: normalized?.y ? size.y / normalized.y : 1 };
  const vertexRadius = (vi: number) => radiusOf(net.v[vi]?.styleID ?? 0);

  // A loop of segments in order, each run the way that meets the one before.
  const loopPieces = (loop: number[]): { pieces: Piece[]; verts: number[] } => {
    const pieces: Piece[] = [];
    const verts: number[] = [];
    let at = -1;
    for (let i = 0; i < loop.length; i++) {
      const sg = net.s[loop[i]];
      if (!sg) continue;
      let reverse = false;
      if (at < 0) {
        // The first runs toward the one after it.
        const nx = net.s[loop[(i + 1) % loop.length]];
        reverse = Boolean(nx && (sg.a === nx.a || sg.a === nx.b) && !(sg.b === nx.a || sg.b === nx.b));
      } else reverse = sg.b === at && sg.a !== at;
      pieces.push(piece(net, sg, k, reverse));
      verts.push(reverse ? sg.b : sg.a);
      at = reverse ? sg.a : sg.b;
    }
    return { pieces, verts };
  };

  const fills: FillPath[] = net.regions.map((rg) => ({
    rule: rg.rule,
    styleID: rg.styleID || undefined,
    d: rg.loops
      .map((loop) => {
        const { pieces, verts } = loopPieces(loop);
        return piecesPath(pieces, true, (i) => vertexRadius(verts[i]));
      })
      .join(""),
  }));

  // The stroke: segments chained into runs through vertices where exactly two meet.
  const deg = new Map<number, number>();
  for (const sg of net.s) {
    deg.set(sg.a, (deg.get(sg.a) ?? 0) + 1);
    deg.set(sg.b, (deg.get(sg.b) ?? 0) + 1);
  }
  const used = new Set<number>();
  const runs: string[] = [];
  const ends: Outline["ends"] = [];
  let allClosed = net.s.length > 0;
  const nextFrom = (vtx: number) => {
    if (deg.get(vtx) !== 2) return -1;
    return net.s.findIndex((sg, i) => !used.has(i) && (sg.a === vtx || sg.b === vtx));
  };
  const chain = (start: number) => {
    const pieces: Piece[] = [];
    const verts: number[] = [];
    // Walk back first, to begin at an end when there is one.
    let first = start;
    let from = net.s[start].a;
    const seen = new Set<number>([start]);
    for (;;) {
      if (deg.get(from) !== 2) break;
      const j = net.s.findIndex((sg, i) => !seen.has(i) && !used.has(i) && (sg.a === from || sg.b === from));
      if (j < 0) break;
      seen.add(j);
      first = j;
      from = net.s[j].a === from ? net.s[j].b : net.s[j].a;
    }
    let at = from;
    let i = first;
    while (i >= 0 && !used.has(i)) {
      used.add(i);
      const sg = net.s[i];
      const reverse = sg.b === at && sg.a !== at;
      pieces.push(piece(net, sg, k, reverse));
      verts.push(reverse ? sg.b : sg.a);
      at = reverse ? sg.a : sg.b;
      i = nextFrom(at);
    }
    const closed = pieces.length > 1 && Math.abs(pieces[0].p0.x - pieces[pieces.length - 1].p3.x) < 1e-4 && Math.abs(pieces[0].p0.y - pieces[pieces.length - 1].p3.y) < 1e-4 && deg.get(verts[0]) === 2;
    if (!closed) {
      allClosed = false;
      const p0 = pieces[0];
      const pl = pieces[pieces.length - 1];
      const d0 = sub(p0.line || isZero(sub(p0.c1, p0.p0)) ? p0.p3 : p0.c1, p0.p0);
      const dl = sub(pl.line || isZero(sub(pl.c2, pl.p3)) ? pl.p0 : pl.c2, pl.p3);
      ends.push({ at: p0.p0, dir: unit(mul(d0, -1)), styleID: net.v[verts[0]]?.styleID });
      ends.push({ at: pl.p3, dir: unit(mul(dl, -1)), styleID: net.v[at]?.styleID });
    }
    runs.push(piecesPath(pieces, closed, (q) => vertexRadius(verts[q])));
  };
  // Runs with ends first, so each starts at one; then the loops that are left.
  for (let i = 0; i < net.s.length; i++) if (!used.has(i) && (deg.get(net.s[i].a) !== 2 || deg.get(net.s[i].b) !== 2)) chain(i);
  for (let i = 0; i < net.s.length; i++) if (!used.has(i)) chain(i);
  // A network without regions is filled where its lines close (as Figma fills one drawn with the pen).
  if (!net.regions.length && runs.length) fills.push({ rule: "NONZERO", d: runs.join("") });
  return { fills, stroke: runs.join(""), closed: allClosed, ends };
}

// ---------------------------------------------------------------------------------------------
// Shapes from their settings

/** A closed polygon's path, its corners rounded by `r`. */
function polygonPath(pts: Pt[], r: number): string {
  const pieces: Piece[] = pts.map((p, i) => {
    const q = pts[(i + 1) % pts.length];
    return { p0: p, c1: p, c2: q, p3: q, line: true };
  });
  return piecesPath(pieces, true, () => r);
}

export function rectOutline(w: number, h: number, radii: [number, number, number, number]): Outline {
  const max = Math.min(w, h) / 2;
  const [tl, tr, br, bl] = radii.map((r) => Math.max(0, Math.min(r || 0, max)));
  const k = 0.5522847498;
  const d =
    `M${P({ x: tl, y: 0 })}L${P({ x: w - tr, y: 0 })}` +
    (tr ? `C${P({ x: w - tr + tr * k, y: 0 })} ${P({ x: w, y: tr - tr * k })} ${P({ x: w, y: tr })}` : "") +
    `L${P({ x: w, y: h - br })}` +
    (br ? `C${P({ x: w, y: h - br + br * k })} ${P({ x: w - br + br * k, y: h })} ${P({ x: w - br, y: h })}` : "") +
    `L${P({ x: bl, y: h })}` +
    (bl ? `C${P({ x: bl - bl * k, y: h })} ${P({ x: 0, y: h - bl + bl * k })} ${P({ x: 0, y: h - bl })}` : "") +
    `L${P({ x: 0, y: tl })}` +
    (tl ? `C${P({ x: 0, y: tl - tl * k })} ${P({ x: tl - tl * k, y: 0 })} ${P({ x: tl, y: 0 })}` : "") +
    "Z";
  return { fills: [{ d, rule: "NONZERO" }], stroke: d, closed: true, ends: [] };
}

/** An arc of the ellipse in the box, from angle a0 to a1 (radians, clockwise from 3 o'clock), as cubic pieces. */
function arcPieces(cx: number, cy: number, rx: number, ry: number, a0: number, a1: number): string {
  const out: string[] = [];
  const n = Math.max(1, Math.ceil(Math.abs(a1 - a0) / (Math.PI / 2) - 1e-9));
  const step = (a1 - a0) / n;
  const h = (4 / 3) * Math.tan(step / 4);
  for (let i = 0; i < n; i++) {
    const s = a0 + i * step;
    const e = s + step;
    const p1 = { x: cx + rx * (Math.cos(s) - h * Math.sin(s)), y: cy + ry * (Math.sin(s) + h * Math.cos(s)) };
    const p2 = { x: cx + rx * (Math.cos(e) + h * Math.sin(e)), y: cy + ry * (Math.sin(e) - h * Math.cos(e)) };
    out.push(`C${P(p1)} ${P(p2)} ${P({ x: cx + rx * Math.cos(e), y: cy + ry * Math.sin(e) })}`);
  }
  return out.join("");
}

export function ellipseOutline(w: number, h: number, arc?: { startingAngle?: number; endingAngle?: number; innerRadius?: number }): Outline {
  const cx = w / 2;
  const cy = h / 2;
  const start = arc?.startingAngle ?? 0;
  let end = arc?.endingAngle ?? Math.PI * 2;
  if (end < start) end += Math.PI * 2;
  const inner = Math.max(0, Math.min(1, arc?.innerRadius ?? 0));
  const full = end - start >= Math.PI * 2 - 1e-4;
  const at = (a: number, k: number) => ({ x: cx + cx * k * Math.cos(a), y: cy + cy * k * Math.sin(a) });
  let d: string;
  let rule = "NONZERO";
  if (full) {
    d = `M${P(at(start, 1))}${arcPieces(cx, cy, cx, cy, start, start + Math.PI * 2)}Z`;
    if (inner > 0) {
      d += `M${P(at(start, inner))}${arcPieces(cx, cy, cx * inner, cy * inner, start, start + Math.PI * 2)}Z`;
      rule = "ODD";
    }
  } else if (inner > 0) {
    d = `M${P(at(start, 1))}${arcPieces(cx, cy, cx, cy, start, end)}L${P(at(end, inner))}${arcPieces(cx, cy, cx * inner, cy * inner, end, start)}Z`;
  } else {
    d = `M${P({ x: cx, y: cy })}L${P(at(start, 1))}${arcPieces(cx, cy, cx, cy, start, end)}Z`;
  }
  return { fills: [{ d, rule }], stroke: d, closed: true, ends: [] };
}

/** A regular polygon or star with its points round the ellipse in the box, the first at 12 o'clock. */
export function starOutline(w: number, h: number, count: number, innerScale: number | null, radius: number): Outline {
  const n = Math.max(3, Math.round(count || 3));
  const pts: Pt[] = [];
  const cx = w / 2;
  const cy = h / 2;
  for (let i = 0; i < n; i++) {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / n;
    pts.push({ x: cx + cx * Math.cos(a), y: cy + cy * Math.sin(a) });
    if (innerScale !== null) {
      const b = a + Math.PI / n;
      pts.push({ x: cx + cx * innerScale * Math.cos(b), y: cy + cy * innerScale * Math.sin(b) });
    }
  }
  const d = polygonPath(pts, radius);
  return { fills: [{ d, rule: "NONZERO" }], stroke: d, closed: true, ends: [] };
}

export function lineOutline(w: number): Outline {
  const d = `M0 0L${r3(w)} 0`;
  return { fills: [], stroke: d, closed: false, ends: [{ at: { x: 0, y: 0 }, dir: { x: -1, y: 0 } }, { at: { x: w, y: 0 }, dir: { x: 1, y: 0 } }] };
}
