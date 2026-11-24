/**
 * Synthesizes real OpenType CFF (.otf) subset fonts directly from Figma's stored glyph vector
 * outlines (`derivedTextData.glyphs`) when a design uses commercial/custom fonts that aren't on
 * Google Fonts and aren't installed locally.
 *
 * Because Figma stores every rendered glyph's normalized 1-em Y-up Bézier outline (`commandsBlob`)
 * and advance width inside `.fig` files, building an OpenType CFF font from those outlines keeps
 * every text layer 100% live & editable while rendering exact Figma letterforms and line wraps.
 */
import type { BoardFont } from "./core.js";
import type { FigDoc, FNode } from "./fig-convert.js";
import { saveAsset } from "./web-import.js";

// ---------------------------------------------------------------------------------------------
// Font style parsing (shared with fig-convert.ts)

const WEIGHTS: Array<[RegExp, number]> = [
  [/thin|hairline/i, 100],
  [/extra ?light|ultra ?light/i, 200],
  [/light/i, 300],
  [/medium/i, 500],
  [/semi ?bold|demi ?bold/i, 600],
  [/extra ?bold|ultra ?bold|heavy|dark/i, 800],
  [/black/i, 900],
  [/bold/i, 700],
];

export const fontWeightOf = (style = ""): number => WEIGHTS.find(([re]) => re.test(style))?.[1] ?? 400;

export const fontItalicOf = (style = ""): boolean => /italic|oblique/i.test(style);

const STRETCHES: Array<[RegExp, string, number]> = [
  [/ultra ?condensed|compressed/i, "ultra-condensed", 1],
  [/extra ?condensed/i, "extra-condensed", 2],
  [/semi ?condensed|compact|narrow/i, "semi-condensed", 4],
  [/condensed/i, "condensed", 3],
  [/ultra ?expanded|ultra ?extended/i, "ultra-expanded", 9],
  [/extra ?expanded|extra ?extended/i, "extra-expanded", 8],
  [/semi ?expanded|semi ?extended/i, "semi-expanded", 6],
  [/expanded|extended|wide/i, "expanded", 7],
];

export const fontStretchOf = (style = ""): string | undefined => STRETCHES.find(([re]) => re.test(style))?.[1];
const widthClassOf = (stretch?: string): number => STRETCHES.find(([, s]) => s === stretch)?.[2] ?? 5;

/** Generic CSS fallback family inferred from a typeface name (so missing glyphs never hit Times). */
export function fallbackFamilyOf(family: string): string {
  if (/mono|code|console|courier|terminal|supply|fira ?code|jetbrains|inconsolata/i.test(family)) return "ui-monospace, monospace";
  if (/serif|garamond|baskerville|caslon|didot|bodoni|times|georgia|recoleta|playfair|merriweather|lora|fraunces|instrument serif|crimson|eb |libre baskerville|source serif|acma/i.test(family) && !/sans/i.test(family)) {
    return "Georgia, serif";
  }
  if (/script|hand|cursive|brush|pacifico|dancing|caveat/i.test(family)) return "cursive";
  return "-apple-system, BlinkMacSystemFont, sans-serif";
}

// ---------------------------------------------------------------------------------------------
// Glyph outline decoding from Figma's commandsBlob

type Cmd =
  | { t: "M"; x: number; y: number }
  | { t: "L"; x: number; y: number }
  | { t: "Q"; cx: number; cy: number; x: number; y: number }
  | { t: "C"; c1x: number; c1y: number; c2x: number; c2y: number; x: number; y: number }
  | { t: "Z" };

function decodeGlyphCommands(buf: Buffer): Cmd[] {
  const out: Cmd[] = [];
  let p = 0;
  const f = () => {
    const v = buf.readFloatLE(p);
    p += 4;
    return v;
  };
  try {
    while (p < buf.length) {
      const c = buf[p++];
      if (c === 0) {
        if (out.length && out[out.length - 1].t !== "Z") out.push({ t: "Z" });
      } else if (c === 1) out.push({ t: "M", x: f(), y: f() });
      else if (c === 2) out.push({ t: "L", x: f(), y: f() });
      else if (c === 3) out.push({ t: "Q", cx: f(), cy: f(), x: f(), y: f() });
      else if (c === 4) out.push({ t: "C", c1x: f(), c1y: f(), c2x: f(), c2y: f(), x: f(), y: f() });
      else break;
    }
  } catch {
    // Truncated blob: keep what was read.
  }
  return out;
}

interface GlyphData {
  codepoint: number;
  advance: number;
  cmds: Cmd[];
}

interface FaceBucket {
  family: string;
  styleName: string;
  weight: number;
  italic: boolean;
  stretch?: string;
  glyphs: Map<number, GlyphData>;
  ascent: number;
  descent: number;
  lineHeight: number;
  spaceAdvances: number[];
}

// ---------------------------------------------------------------------------------------------
// Minimal, strict OpenType CFF (.otf) encoder (passes Chrome/OTS, CoreText, HarfBuzz, Skia)

const UPM = 1000;

/** Encode a signed integer in CFF Type 2 CharString format. */
function encodeT2Int(v: number, out: number[]) {
  const n = Math.max(-32768, Math.min(32767, Math.round(v)));
  if (n >= -107 && n <= 107) out.push(n + 139);
  else if (n >= 108 && n <= 1131) {
    const k = n - 108;
    out.push((k >> 8) + 247, k & 0xff);
  } else if (n >= -1131 && n <= -108) {
    const k = -n - 108;
    out.push((k >> 8) + 251, k & 0xff);
  } else {
    out.push(28, (n >> 8) & 0xff, n & 0xff);
  }
}

/** Encode a signed 32-bit integer in CFF DICT format. */
function encodeDictInt(v: number, out: number[]) {
  const n = Math.round(v);
  if (n >= -107 && n <= 107) out.push(n + 139);
  else if (n >= 108 && n <= 1131) {
    const k = n - 108;
    out.push((k >> 8) + 247, k & 0xff);
  } else if (n >= -1131 && n <= -108) {
    const k = -n - 108;
    out.push((k >> 8) + 251, k & 0xff);
  } else if (n >= -32768 && n <= 32767) {
    out.push(28, (n >> 8) & 0xff, n & 0xff);
  } else {
    out.push(29, (n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff);
  }
}

/** Always 5 bytes in CFF DICT (for patchable table offsets). */
function encodeDictInt32(v: number, out: number[]) {
  out.push(29, (v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff);
}

interface EncodedGlyph {
  charstring: Buffer;
  xMin: number;
  yMin: number;
  xMax: number;
  yMax: number;
  empty: boolean;
}

/** Convert normalized 1-em Figma glyph commands to a Type 2 CFF CharString in 1000 UPM space. */
function encodeCharString(cmds: Cmd[]): EncodedGlyph {
  const out: number[] = [];
  let cx = 0;
  let cy = 0;
  let sx = 0;
  let sy = 0;
  let xMin = Infinity;
  let yMin = Infinity;
  let xMax = -Infinity;
  let yMax = -Infinity;
  let hasPts = false;

  const track = (x: number, y: number) => {
    hasPts = true;
    if (x < xMin) xMin = x;
    if (x > xMax) xMax = x;
    if (y < yMin) yMin = y;
    if (y > yMax) yMax = y;
  };
  const S = (v: number) => Math.round(v * UPM);

  for (const c of cmds) {
    if (c.t === "M") {
      const x = S(c.x);
      const y = S(c.y);
      encodeT2Int(x - cx, out);
      encodeT2Int(y - cy, out);
      out.push(21); // rmoveto
      cx = sx = x;
      cy = sy = y;
      track(x, y);
    } else if (c.t === "L") {
      const x = S(c.x);
      const y = S(c.y);
      if (x !== cx || y !== cy) {
        encodeT2Int(x - cx, out);
        encodeT2Int(y - cy, out);
        out.push(5); // rlineto
        cx = x;
        cy = y;
        track(x, y);
      }
    } else if (c.t === "Q") {
      // Exact quadratic -> cubic Bézier degree elevation in integer UPM coordinates.
      const qx = S(c.cx);
      const qy = S(c.cy);
      const x = S(c.x);
      const y = S(c.y);
      const c1x = Math.round(cx + ((qx - cx) * 2) / 3);
      const c1y = Math.round(cy + ((qy - cy) * 2) / 3);
      const c2x = Math.round(x + ((qx - x) * 2) / 3);
      const c2y = Math.round(y + ((qy - y) * 2) / 3);
      encodeT2Int(c1x - cx, out);
      encodeT2Int(c1y - cy, out);
      encodeT2Int(c2x - c1x, out);
      encodeT2Int(c2y - c1y, out);
      encodeT2Int(x - c2x, out);
      encodeT2Int(y - c2y, out);
      out.push(8); // rrcurveto
      track(c1x, c1y);
      track(c2x, c2y);
      track(x, y);
      cx = x;
      cy = y;
    } else if (c.t === "C") {
      const c1x = S(c.c1x);
      const c1y = S(c.c1y);
      const c2x = S(c.c2x);
      const c2y = S(c.c2y);
      const x = S(c.x);
      const y = S(c.y);
      encodeT2Int(c1x - cx, out);
      encodeT2Int(c1y - cy, out);
      encodeT2Int(c2x - c1x, out);
      encodeT2Int(c2y - c1y, out);
      encodeT2Int(x - c2x, out);
      encodeT2Int(y - c2y, out);
      out.push(8); // rrcurveto
      track(c1x, c1y);
      track(c2x, c2y);
      track(x, y);
      cx = x;
      cy = y;
    } else if (c.t === "Z") {
      if (cx !== sx || cy !== sy) {
        encodeT2Int(sx - cx, out);
        encodeT2Int(sy - cy, out);
        out.push(5); // rlineto back to contour start
        cx = sx;
        cy = sy;
      }
    }
  }
  out.push(14); // endchar
  return {
    charstring: Buffer.from(out),
    xMin: hasPts ? xMin : 0,
    yMin: hasPts ? yMin : 0,
    xMax: hasPts ? xMax : 0,
    yMax: hasPts ? yMax : 0,
    empty: !hasPts,
  };
}

/** Build a CFF INDEX table from buffers. */
function cffIndex(items: Buffer[]): Buffer {
  const count = items.length;
  if (count === 0) return Buffer.from([0, 0]);
  const total = items.reduce((a, b) => a + b.length, 0);
  const offSize = total + 1 < 0x100 ? 1 : total + 1 < 0x10000 ? 2 : 4;
  const head = Buffer.alloc(3 + (count + 1) * offSize);
  head.writeUInt16BE(count, 0);
  head[2] = offSize;
  let off = 1;
  let pos = 3;
  const writeOff = (v: number) => {
    if (offSize === 1) head[pos++] = v;
    else if (offSize === 2) {
      head.writeUInt16BE(v, pos);
      pos += 2;
    } else {
      head.writeUInt32BE(v, pos);
      pos += 4;
    }
  };
  writeOff(off);
  for (const item of items) {
    off += item.length;
    writeOff(off);
  }
  return Buffer.concat([head, ...items]);
}

function buildCffTable(psName: string, encoded: EncodedGlyph[], bbox: [number, number, number, number]): Buffer {
  const header = Buffer.from([1, 0, 4, 4]);
  const nameIdx = cffIndex([Buffer.from(psName, "ascii")]);

  // Extra glyph names beyond CFF Standard Strings (SIDs 1..390) when font has > 390 glyphs.
  const extraStrings: Buffer[] = [];
  const charsetBuf = Buffer.alloc(1 + Math.max(0, encoded.length - 1) * 2);
  charsetBuf[0] = 0; // format 0
  for (let i = 1; i < encoded.length; i++) {
    let sid: number;
    if (i <= 390) sid = i;
    else {
      sid = 391 + extraStrings.length;
      extraStrings.push(Buffer.from(`g${i}`, "ascii"));
    }
    charsetBuf.writeUInt16BE(sid, 1 + (i - 1) * 2);
  }
  const stringIdx = cffIndex(extraStrings);
  const globalSubrIdx = cffIndex([]);
  const charStringsIdx = cffIndex(encoded.map((g) => g.charstring));
  // Private DICT: defaultWidthX=0, nominalWidthX=0
  const privateDict = Buffer.from([139, 20, 139, 21]);

  const makeTopDict = (charsetOff: number, charStringsOff: number, privateOff: number): Buffer => {
    const d: number[] = [];
    for (const v of bbox) encodeDictInt(v, d);
    d.push(5); // FontBBox
    encodeDictInt32(charsetOff, d);
    d.push(15); // charset
    encodeDictInt32(charStringsOff, d);
    d.push(17); // CharStrings
    encodeDictInt(privateDict.length, d);
    encodeDictInt32(privateOff, d);
    d.push(18); // Private
    return cffIndex([Buffer.from(d)]);
  };

  // Fixed-width 32-bit offsets mean the Top DICT INDEX size is constant across pass 1 and pass 2.
  const topDummy = makeTopDict(0, 0, 0);
  const charsetOff = header.length + nameIdx.length + topDummy.length + stringIdx.length + globalSubrIdx.length;
  const charStringsOff = charsetOff + charsetBuf.length;
  const privateOff = charStringsOff + charStringsIdx.length;
  const topIdx = makeTopDict(charsetOff, charStringsOff, privateOff);

  return Buffer.concat([header, nameIdx, topIdx, stringIdx, globalSubrIdx, charsetBuf, charStringsIdx, privateDict]);
}

function buildCmapTable(glyphs: GlyphData[]): Buffer {
  // Format 4 (BMP) + Format 12 (full Unicode when any codepoint > 0xFFFF)
  const bmp: Array<{ cp: number; gid: number }> = [];
  const all: Array<{ cp: number; gid: number }> = [];
  glyphs.forEach((g, idx) => {
    const gid = idx + 1; // 0 is .notdef
    all.push({ cp: g.codepoint, gid });
    if (g.codepoint <= 0xffff) bmp.push({ cp: g.codepoint, gid });
  });

  // Group contiguous BMP runs where cp and gid both increment by 1.
  const segs: Array<{ start: number; end: number; delta: number }> = [];
  for (const { cp, gid } of bmp) {
    const last = segs[segs.length - 1];
    if (last && cp === last.end + 1 && ((gid - cp) & 0xffff) === last.delta) last.end = cp;
    else segs.push({ start: cp, end: cp, delta: (gid - cp) & 0xffff });
  }
  segs.push({ start: 0xffff, end: 0xffff, delta: 1 });

  const segCount = segs.length;
  const segCountX2 = segCount * 2;
  const entrySelector = Math.floor(Math.log2(segCount));
  const searchRange = 2 * (1 << entrySelector);
  const rangeShift = segCountX2 - searchRange;
  const f4Len = 16 + segCount * 8;
  const f4 = Buffer.alloc(f4Len);
  f4.writeUInt16BE(4, 0);
  f4.writeUInt16BE(f4Len, 2);
  f4.writeUInt16BE(0, 4);
  f4.writeUInt16BE(segCountX2, 6);
  f4.writeUInt16BE(searchRange, 8);
  f4.writeUInt16BE(entrySelector, 10);
  f4.writeUInt16BE(rangeShift, 12);
  let p = 14;
  for (const s of segs) (f4.writeUInt16BE(s.end, p), (p += 2));
  f4.writeUInt16BE(0, p);
  p += 2;
  for (const s of segs) (f4.writeUInt16BE(s.start, p), (p += 2));
  for (const s of segs) (f4.writeUInt16BE(s.delta, p), (p += 2));
  for (let i = 0; i < segCount; i++) (f4.writeUInt16BE(0, p), (p += 2));

  const hasAstral = all.some((x) => x.cp > 0xffff);
  let f12: Buffer | null = null;
  if (hasAstral) {
    const groups: Array<{ start: number; end: number; gid: number }> = [];
    for (const { cp, gid } of all) {
      const last = groups[groups.length - 1];
      if (last && cp === last.end + 1 && gid === last.gid + (cp - last.start)) last.end = cp;
      else groups.push({ start: cp, end: cp, gid });
    }
    const f12Len = 16 + groups.length * 12;
    f12 = Buffer.alloc(f12Len);
    f12.writeUInt16BE(12, 0);
    f12.writeUInt16BE(0, 2);
    f12.writeUInt32BE(f12Len, 4);
    f12.writeUInt32BE(0, 8);
    f12.writeUInt32BE(groups.length, 12);
    let q = 16;
    for (const g of groups) {
      f12.writeUInt32BE(g.start, q);
      f12.writeUInt32BE(g.end, q + 4);
      f12.writeUInt32BE(g.gid, q + 8);
      q += 12;
    }
  }

  const records: Array<[number, number, "f4" | "f12"]> = hasAstral
    ? [
        [0, 3, "f4"],
        [0, 4, "f12"],
        [3, 1, "f4"],
        [3, 10, "f12"],
      ]
    : [
        [0, 3, "f4"],
        [3, 1, "f4"],
      ];
  const headerLen = 4 + records.length * 8;
  const f4Off = headerLen;
  const f12Off = headerLen + f4.length;
  const head = Buffer.alloc(headerLen);
  head.writeUInt16BE(0, 0);
  head.writeUInt16BE(records.length, 2);
  records.forEach(([plat, enc, which], i) => {
    const o = 4 + i * 8;
    head.writeUInt16BE(plat, o);
    head.writeUInt16BE(enc, o + 2);
    head.writeUInt32BE(which === "f4" ? f4Off : f12Off, o + 4);
  });
  return f12 ? Buffer.concat([head, f4, f12]) : Buffer.concat([head, f4]);
}

function buildNameTable(family: string, subfamily: string, psName: string): Buffer {
  const utf16be = (s: string) => {
    const b = Buffer.alloc(s.length * 2);
    for (let i = 0; i < s.length; i++) b.writeUInt16BE(s.charCodeAt(i), i * 2);
    return b;
  };
  const fullName = subfamily === "Regular" ? family : `${family} ${subfamily}`;
  const entries: Array<[number, Buffer]> = [
    [1, utf16be(family)],
    [2, utf16be(subfamily)],
    [3, utf16be(`Glassine:${psName}`)],
    [4, utf16be(fullName)],
    [5, utf16be("Version 1.0")],
    [6, utf16be(psName)],
  ];
  const strOffset = 6 + entries.length * 12;
  const head = Buffer.alloc(strOffset);
  head.writeUInt16BE(0, 0); // format
  head.writeUInt16BE(entries.length, 2);
  head.writeUInt16BE(strOffset, 4);
  let cur = 0;
  entries.forEach(([id, buf], i) => {
    const o = 6 + i * 12;
    head.writeUInt16BE(3, o); // Windows
    head.writeUInt16BE(1, o + 2); // Unicode BMP
    head.writeUInt16BE(0x0409, o + 4); // en-US
    head.writeUInt16BE(id, o + 6);
    head.writeUInt16BE(buf.length, o + 8);
    head.writeUInt16BE(cur, o + 10);
    cur += buf.length;
  });
  return Buffer.concat([head, ...entries.map(([, b]) => b)]);
}

function checksum(buf: Buffer): number {
  let sum = 0;
  const n = Math.ceil(buf.length / 4) * 4;
  for (let i = 0; i < n; i += 4) {
    const b0 = buf[i] ?? 0;
    const b1 = buf[i + 1] ?? 0;
    const b2 = buf[i + 2] ?? 0;
    const b3 = buf[i + 3] ?? 0;
    sum = (sum + (((b0 << 24) | (b1 << 16) | (b2 << 8) | b3) >>> 0)) >>> 0;
  }
  return sum >>> 0;
}

function pad4(buf: Buffer): Buffer {
  const rem = buf.length % 4;
  return rem ? Buffer.concat([buf, Buffer.alloc(4 - rem)]) : buf;
}

/** Build a complete OpenType CFF (.otf) binary from one face bucket. */
function buildOtf(face: FaceBucket): Buffer {
  const sorted = [...face.glyphs.values()].sort((a, b) => a.codepoint - b.codepoint);
  const notdef: EncodedGlyph = { charstring: Buffer.from([14]), xMin: 0, yMin: 0, xMax: 0, yMax: 0, empty: true };
  const encoded: EncodedGlyph[] = [notdef, ...sorted.map((g) => encodeCharString(g.cmds))];
  const advances: number[] = [500, ...sorted.map((g) => Math.max(0, Math.min(65535, Math.round(g.advance))))];

  let xMin = 0;
  let yMin = 0;
  let xMax = 0;
  let yMax = 0;
  let anyBox = false;
  let maxAdv = 500;
  let minLsb = 0;
  let minRsb = 0;
  let xMaxExtent = 0;
  let advSum = 0;
  let advCount = 0;

  for (let i = 0; i < encoded.length; i++) {
    const g = encoded[i];
    const adv = advances[i];
    if (adv > maxAdv) maxAdv = adv;
    if (i > 0 && adv > 0) {
      advSum += adv;
      advCount++;
    }
    if (!g.empty) {
      if (!anyBox) {
        xMin = g.xMin;
        yMin = g.yMin;
        xMax = g.xMax;
        yMax = g.yMax;
        minLsb = g.xMin;
        minRsb = adv - g.xMax;
        xMaxExtent = g.xMax;
        anyBox = true;
      } else {
        if (g.xMin < xMin) xMin = g.xMin;
        if (g.yMin < yMin) yMin = g.yMin;
        if (g.xMax > xMax) xMax = g.xMax;
        if (g.yMax > yMax) yMax = g.yMax;
        if (g.xMin < minLsb) minLsb = g.xMin;
        const rsb = adv - g.xMax;
        if (rsb < minRsb) minRsb = rsb;
        if (g.xMax > xMaxExtent) xMaxExtent = g.xMax;
      }
    }
  }
  const clamp16 = (v: number) => Math.max(-32768, Math.min(32767, Math.round(v)));
  const ascender = clamp16(Math.max(500, Math.min(1200, Math.round(face.ascent * UPM))));
  const descender = clamp16(Math.min(-100, Math.max(-500, Math.round(face.descent * UPM))));
  const totalLH = Math.round(face.lineHeight * UPM);
  const lineGap = clamp16(Math.max(0, totalLH - (ascender - descender)));
  const winAscent = Math.max(ascender, Math.min(30000, Math.max(0, yMax)));
  const winDescent = Math.max(-descender, Math.min(30000, Math.max(0, -yMin)));

  const psSafe = `${face.family}-${face.styleName || "Regular"}`.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 60) || "FigmaFont";
  const isBold = face.weight >= 700;
  const subfamily = isBold && face.italic ? "Bold Italic" : isBold ? "Bold" : face.italic ? "Italic" : "Regular";

  // 1. CFF
  const cff = buildCffTable(psSafe, encoded, [clamp16(xMin), clamp16(yMin), clamp16(xMax), clamp16(yMax)]);

  // 2. head (54 bytes)
  const head = Buffer.alloc(54);
  head.writeUInt16BE(1, 0);
  head.writeUInt16BE(0, 2);
  head.writeUInt32BE(0x00010000, 4); // fontRevision
  head.writeUInt32BE(0, 8); // checkSumAdjustment patched later
  head.writeUInt32BE(0x5f0f3cf5, 12); // magicNumber
  head.writeUInt16BE(0x000b, 16); // flags
  head.writeUInt16BE(UPM, 18);
  head.writeInt16BE(clamp16(xMin), 36);
  head.writeInt16BE(clamp16(yMin), 38);
  head.writeInt16BE(clamp16(xMax), 40);
  head.writeInt16BE(clamp16(yMax), 42);
  head.writeUInt16BE((isBold ? 1 : 0) | (face.italic ? 2 : 0), 44); // macStyle
  head.writeUInt16BE(8, 46); // lowestRecPPEM
  head.writeInt16BE(2, 48); // fontDirectionHint

  // 3. hhea (36 bytes)
  const hhea = Buffer.alloc(36);
  hhea.writeUInt16BE(1, 0);
  hhea.writeUInt16BE(0, 2);
  hhea.writeInt16BE(ascender, 4);
  hhea.writeInt16BE(descender, 6);
  hhea.writeInt16BE(lineGap, 8);
  hhea.writeUInt16BE(Math.min(65535, maxAdv), 10);
  hhea.writeInt16BE(clamp16(minLsb), 12);
  hhea.writeInt16BE(clamp16(minRsb), 14);
  hhea.writeInt16BE(clamp16(xMaxExtent), 16);
  hhea.writeInt16BE(1, 18); // caretSlopeRise
  hhea.writeUInt16BE(encoded.length, 34); // numberOfHMetrics

  // 4. maxp (6 bytes, CFF v0.5)
  const maxp = Buffer.alloc(6);
  maxp.writeUInt32BE(0x00005000, 0);
  maxp.writeUInt16BE(encoded.length, 4);

  // 5. hmtx
  const hmtx = Buffer.alloc(encoded.length * 4);
  for (let i = 0; i < encoded.length; i++) {
    hmtx.writeUInt16BE(advances[i], i * 4);
    hmtx.writeInt16BE(clamp16(encoded[i].empty ? 0 : encoded[i].xMin), i * 4 + 2);
  }

  // 6. OS/2 (version 4, 96 bytes)
  const os2 = Buffer.alloc(96);
  os2.writeUInt16BE(4, 0);
  os2.writeInt16BE(clamp16(advCount ? advSum / advCount : 500), 2);
  os2.writeUInt16BE(Math.max(100, Math.min(900, face.weight)), 4);
  os2.writeUInt16BE(widthClassOf(face.stretch), 6);
  os2.writeUInt16BE(0, 8); // fsType
  os2.writeInt16BE(650, 10);
  os2.writeInt16BE(600, 12);
  os2.writeInt16BE(0, 14);
  os2.writeInt16BE(75, 16);
  os2.writeInt16BE(650, 18);
  os2.writeInt16BE(600, 20);
  os2.writeInt16BE(0, 22);
  os2.writeInt16BE(350, 24);
  os2.writeInt16BE(50, 26); // yStrikeoutSize
  os2.writeInt16BE(280, 28); // yStrikeoutPosition
  os2.write("FIGM", 58, "ascii");
  const fsSel = (face.italic ? 1 : 0) | (isBold ? 32 : 0) | (!isBold && !face.italic ? 64 : 0) | 128; // + USE_TYPO_METRICS
  os2.writeUInt16BE(fsSel, 62);
  const firstCp = sorted.length ? Math.min(0xffff, sorted[0].codepoint) : 32;
  const lastCp = sorted.length ? Math.min(0xffff, sorted[sorted.length - 1].codepoint) : 32;
  os2.writeUInt16BE(firstCp, 64);
  os2.writeUInt16BE(lastCp, 66);
  os2.writeInt16BE(ascender, 68);
  os2.writeInt16BE(descender, 70);
  os2.writeInt16BE(lineGap, 72);
  os2.writeUInt16BE(Math.min(65535, winAscent), 74);
  os2.writeUInt16BE(Math.min(65535, winDescent), 76);
  os2.writeUInt32BE(1, 78); // ulCodePageRange1 (Latin 1)
  os2.writeUInt32BE(0, 82);
  const capH = face.glyphs.has(72) ? encodeCharString(face.glyphs.get(72)!.cmds).yMax : 700;
  const xH = face.glyphs.has(120) ? encodeCharString(face.glyphs.get(120)!.cmds).yMax : 500;
  os2.writeInt16BE(clamp16(xH > 100 ? xH : 500), 86);
  os2.writeInt16BE(clamp16(capH > 100 ? capH : 700), 88);
  os2.writeUInt16BE(0, 90); // usDefaultChar
  os2.writeUInt16BE(32, 92); // usBreakChar
  os2.writeUInt16BE(0, 94); // usMaxContext

  // 7. cmap
  const cmap = buildCmapTable(sorted);

  // 8. name
  const name = buildNameTable(face.family, subfamily, psSafe);

  // 9. post (version 3.0, 32 bytes)
  const post = Buffer.alloc(32);
  post.writeUInt32BE(0x00030000, 0);
  if (face.italic) post.writeInt32BE(-12 << 16, 4);
  post.writeInt16BE(-100, 8);
  post.writeInt16BE(50, 10);

  // Assemble SFNT tables sorted alphabetically by tag.
  const tables: Array<[string, Buffer]> = [
    ["CFF ", cff],
    ["OS/2", os2],
    ["cmap", cmap],
    ["head", head],
    ["hhea", hhea],
    ["hmtx", hmtx],
    ["maxp", maxp],
    ["name", name],
    ["post", post],
  ];
  const numTables = tables.length;
  const entrySelector = Math.floor(Math.log2(numTables));
  const searchRange = (1 << entrySelector) * 16;
  const rangeShift = numTables * 16 - searchRange;

  const dir = Buffer.alloc(12 + numTables * 16);
  dir.write("OTTO", 0, "ascii");
  dir.writeUInt16BE(numTables, 4);
  dir.writeUInt16BE(searchRange, 6);
  dir.writeUInt16BE(entrySelector, 8);
  dir.writeUInt16BE(rangeShift, 10);

  let offset = dir.length;
  const padded: Buffer[] = [];
  let headOffset = 0;
  tables.forEach(([tag, raw], i) => {
    const p = pad4(raw);
    const o = 12 + i * 16;
    dir.write(tag, o, "ascii");
    dir.writeUInt32BE(checksum(p), o + 4);
    dir.writeUInt32BE(offset, o + 8);
    dir.writeUInt32BE(raw.length, o + 12);
    if (tag === "head") headOffset = offset;
    offset += p.length;
    padded.push(p);
  });

  const full = Buffer.concat([dir, ...padded]);
  const adj = (0xb1b0afba - checksum(full)) >>> 0;
  full.writeUInt32BE(adj, headOffset + 8);
  return full;
}

// ---------------------------------------------------------------------------------------------
// Collecting glyph outlines from a FigDoc for missing (non-Google) font families

function applyTextCase(ch: string, textCase: string | undefined, prevChar: string): string {
  if (textCase === "UPPER") return ch.toUpperCase();
  if (textCase === "LOWER") return ch.toLowerCase();
  if (textCase === "TITLE" && (!prevChar || /[\s\-–—/(\[{]/.test(prevChar))) return ch.toUpperCase();
  return ch;
}

function resolveStyle(d: FigDoc, ref: any): FNode | undefined {
  if (!ref) return undefined;
  const byId = ref.guid ? d.byId.get(`${ref.guid.sessionID}:${ref.guid.localID}`) : undefined;
  if (byId) return byId;
  const key = ref.assetRef?.key;
  return typeof key === "string" ? d.styles.get(key) : undefined;
}

/**
 * Build OpenType CFF (.otf) BoardFonts from `derivedTextData.glyphs` for every font family in
 * `wantedFamilies` (case-insensitive) that wasn't available from Google Fonts.
 */
export function synthesizeFigFonts(d: FigDoc, wantedFamilies: Set<string>): BoardFont[] {
  if (!wantedFamilies.size) return [];
  const wantedLower = new Set([...wantedFamilies].map((f) => f.toLowerCase()));
  const buckets = new Map<string, FaceBucket>();

  const getBucket = (family: string, styleName: string, meta?: any): FaceBucket => {
    const weight = typeof meta?.fontWeight === "number" && meta.fontWeight >= 100 ? Math.round(meta.fontWeight / 100) * 100 : fontWeightOf(styleName);
    const italic = meta?.fontStyle === "ITALIC" || fontItalicOf(styleName);
    const stretch = fontStretchOf(styleName);
    const key = `${family.toLowerCase()}|${weight}|${italic ? "i" : "n"}|${stretch ?? ""}`;
    let b = buckets.get(key);
    if (!b) {
      b = {
        family,
        styleName,
        weight,
        italic,
        stretch,
        glyphs: new Map(),
        ascent: 0.8,
        descent: -0.2,
        lineHeight: typeof meta?.fontLineHeight === "number" && meta.fontLineHeight > 0.5 ? meta.fontLineHeight : 1.15,
        spaceAdvances: [],
      };
      buckets.set(key, b);
    }
    return b;
  };

  for (const n of d.byId.values()) {
    if (n.type !== "TEXT") continue;
    const glyphs: any[] = n.derivedTextData?.glyphs ?? [];
    if (!glyphs.length) continue;
    const td = n.textData ?? {};
    const chars: string = td.characters ?? n.characters ?? "";
    if (!chars.length) continue;
    const ids: number[] = td.characterStyleIDs ?? [];
    const table = new Map<number, any>((td.styleOverrideTable ?? []).map((s: any) => [s.styleID, s]));
    const baseStyle = resolveStyle(d, n.styleIdForText);
    const baseFont = baseStyle?.fontName ?? n.fontName;
    const baseCase = baseStyle?.textCase ?? n.textCase;
    const metaByKey = new Map<string, any>();
    for (const fm of n.derivedTextData?.fontMetaData ?? []) {
      if (fm?.key?.family) metaByKey.set(`${fm.key.family.toLowerCase()}|${(fm.key.style ?? "").toLowerCase()}`, fm);
    }
    const baseLine = n.derivedTextData?.baselines?.[0];

    for (let gi = 0; gi < glyphs.length; gi++) {
      const g = glyphs[gi];
      const idx = g.firstCharacter;
      if (typeof idx !== "number" || idx < 0 || idx >= chars.length) continue;

      const sid = ids[idx] ?? 0;
      const ov = sid ? table.get(sid) : undefined;
      const ovStyle = ov ? resolveStyle(d, ov.styleIdForText) : undefined;
      const fn = ovStyle?.fontName ?? ov?.fontName ?? baseFont;
      const family: string | undefined = fn?.family;
      if (!family || !wantedLower.has(family.toLowerCase())) continue;
      const styleName: string = fn?.style ?? "";
      const meta = metaByKey.get(`${family.toLowerCase()}|${styleName.toLowerCase()}`);
      const bucket = getBucket(family, styleName, meta);

      // Update ascent/descent estimate from Figma's own baseline metrics when available.
      if (baseLine && g.fontSize > 0 && baseLine.lineAscent > 0) {
        const asc = baseLine.lineAscent / g.fontSize;
        if (asc > 0.5 && asc < 1.2) {
          bucket.ascent = asc;
          bucket.descent = Math.min(-0.15, asc - bucket.lineHeight);
        }
      }

      // Skip multi-character ligatures (keep single-codepoint glyphs in cmap so 'f' isn't replaced by 'fi').
      const rawCp = chars.codePointAt(idx);
      if (rawCp === undefined) continue;
      const charLen = rawCp > 0xffff ? 2 : 1;
      const nextIdx = glyphs[gi + 1]?.firstCharacter;
      if (typeof nextIdx === "number" && nextIdx > idx + charLen) {
        // Check if the skipped characters are spaces (which may not emit glyphs of their own).
        const between = chars.slice(idx + charLen, nextIdx);
        if (between === " " && g.fontSize > 0 && glyphs[gi + 1]?.position && g.position && Math.abs(glyphs[gi + 1].position.y - g.position.y) < 1) {
          const spAdv = (glyphs[gi + 1].position.x - g.position.x) / g.fontSize - (g.advance ?? 0);
          if (spAdv > 0.1 && spAdv < 0.8) bucket.spaceAdvances.push(spAdv);
        } else if (!/^\s+$/.test(between)) {
          continue; // Ligature covering multiple non-space characters
        }
      }

      const rawCh = String.fromCodePoint(rawCp);
      if (rawCh === "\n" || rawCh === "\r" || rawCh === "\u2028" || rawCh === "\t") continue;
      const tCase = ovStyle?.textCase ?? ov?.textCase ?? baseCase;
      const mapped = applyTextCase(rawCh, tCase, idx > 0 ? chars[idx - 1] : "");
      // Some Unicode case mappings expand 1 char to 2 (e.g. ß -> SS); skip those.
      if ([...mapped].length !== 1) continue;
      const cp = mapped.codePointAt(0)!;
      if (bucket.glyphs.has(cp)) continue;

      const adv = Math.round((g.advance ?? 0.5) * UPM);
      if (cp === 32 || cp === 160) {
        bucket.glyphs.set(cp, { codepoint: cp, advance: adv > 0 ? adv : 280, cmds: [] });
        continue;
      }
      if (g.commandsBlob === undefined || g.commandsBlob === null) continue;
      const blob = d.blob(g.commandsBlob);
      if (!blob || !blob.length) continue;
      const cmds = decodeGlyphCommands(blob);
      if (!cmds.length) continue;
      bucket.glyphs.set(cp, { codepoint: cp, advance: adv, cmds });
    }
  }

  const out: BoardFont[] = [];
  for (const bucket of buckets.values()) {
    if (!bucket.glyphs.size) continue;
    // Always include space (U+0020) and NBSP (U+00A0) with accurate advance width.
    if (!bucket.glyphs.has(32)) {
      const sortedSp = bucket.spaceAdvances.slice().sort((a, b) => a - b);
      const spAdv = sortedSp.length ? sortedSp[Math.floor(sortedSp.length / 2)] : 0.27;
      bucket.glyphs.set(32, { codepoint: 32, advance: Math.round(spAdv * UPM), cmds: [] });
    }
    if (!bucket.glyphs.has(160)) {
      bucket.glyphs.set(160, { codepoint: 160, advance: bucket.glyphs.get(32)!.advance, cmds: [] });
    }
    const otf = buildOtf(bucket);
    const file = saveAsset(otf, "otf");
    out.push({
      family: bucket.family,
      weight: String(bucket.weight),
      ...(bucket.italic ? { style: "italic" } : {}),
      ...(bucket.stretch ? { stretch: bucket.stretch } : {}),
      src: file,
    });
  }
  return out;
}
