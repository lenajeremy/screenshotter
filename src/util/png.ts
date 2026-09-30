import { crc32, deflateSync } from "node:zlib";

/** A decoded image: width × height RGBA pixels, rows top to bottom. */
export interface Frame {
  width: number;
  height: number;
  rgba: Buffer;
}

const byteIndex = (mask: number) => (mask ? Math.log2(mask & -mask) / 8 : -1);

/**
 * Decode an uncompressed 24/32-bit BMP (what `simctl io screenshot --type=bmp` writes). Raw
 * pixels make it much cheaper to capture than PNG and trivial to compare.
 */
export function readBmp(buf: Buffer): Frame {
  if (buf.toString("ascii", 0, 2) !== "BM") throw new Error("Not a BMP file");
  const offset = buf.readUInt32LE(10);
  const headerSize = buf.readUInt32LE(14);
  const width = buf.readInt32LE(18);
  const rawHeight = buf.readInt32LE(22);
  const bpp = buf.readUInt16LE(28);
  const compression = buf.readUInt32LE(30);
  if (bpp !== 32 && bpp !== 24) throw new Error(`Unsupported BMP depth ${bpp}`);
  const height = Math.abs(rawHeight);
  const topDown = rawHeight < 0;
  // Channel byte positions: from bit masks when present, else the standard BGR(A) order.
  let [ri, gi, bi, ai] = [2, 1, 0, bpp === 32 ? 3 : -1];
  if ((compression === 3 || compression === 6) && headerSize >= 52) {
    ri = byteIndex(buf.readUInt32LE(54));
    gi = byteIndex(buf.readUInt32LE(58));
    bi = byteIndex(buf.readUInt32LE(62));
    ai = headerSize >= 56 ? byteIndex(buf.readUInt32LE(66)) : -1;
  }
  const bytes = bpp / 8;
  const rowSize = Math.ceil((bpp * width) / 32) * 4;
  const rgba = Buffer.allocUnsafe(width * height * 4);
  for (let y = 0; y < height; y++) {
    let src = offset + (topDown ? y : height - 1 - y) * rowSize;
    let dst = y * width * 4;
    for (let x = 0; x < width; x++, src += bytes, dst += 4) {
      rgba[dst] = buf[src + ri];
      rgba[dst + 1] = buf[src + gi];
      rgba[dst + 2] = buf[src + bi];
      rgba[dst + 3] = ai >= 0 ? buf[src + ai] : 255;
    }
  }
  return { width, height, rgba };
}

function chunk(type: string, data: Buffer): Buffer {
  const out = Buffer.allocUnsafe(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

/** Encode RGBA pixels as an sRGB PNG, the same flavour simctl writes. */
export function encodePng(frame: Frame): Buffer {
  const { width, height, rgba } = frame;
  const stride = width * 4;
  // "Up" filter on every row: screenshots are full of flat areas, so it compresses well and fast.
  const raw = Buffer.allocUnsafe((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const dst = y * (stride + 1);
    const row = y * stride;
    if (y === 0) {
      raw[dst] = 0;
      rgba.copy(raw, dst + 1, row, row + stride);
      continue;
    }
    raw[dst] = 2;
    for (let i = 0; i < stride; i++) raw[dst + 1 + i] = (rgba[row + i] - rgba[row - stride + i]) & 0xff;
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("sRGB", Buffer.from([0])),
    chunk("IDAT", deflateSync(raw, { level: 5 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Fraction of sampled pixels that differ noticeably between two frames (1 if sizes differ). */
export function frameDifference(a: Frame, b: Frame, step = 5): number {
  if (a.width !== b.width || a.height !== b.height) return 1;
  let differ = 0;
  let total = 0;
  for (let y = 0; y < a.height; y += step) {
    for (let x = 0; x < a.width; x += step) {
      const i = (y * a.width + x) * 4;
      const d = Math.abs(a.rgba[i] - b.rgba[i]) + Math.abs(a.rgba[i + 1] - b.rgba[i + 1]) + Math.abs(a.rgba[i + 2] - b.rgba[i + 2]);
      if (d > 24) differ++;
      total++;
    }
  }
  return differ / total;
}

/**
 * True when the screen below the status bar is (almost) a single colour: an app that is still
 * starting up. Genuinely sparse screens still have some content and don't count.
 */
export function isBlankFrame(f: Frame, step = 6): boolean {
  const counts = new Map<number, number>();
  let total = 0;
  for (let y = Math.floor(f.height * 0.08); y < f.height; y += step) {
    for (let x = 0; x < f.width; x += step) {
      const i = (y * f.width + x) * 4;
      const key = ((f.rgba[i] >> 3) << 10) | ((f.rgba[i + 1] >> 3) << 5) | (f.rgba[i + 2] >> 3);
      counts.set(key, (counts.get(key) ?? 0) + 1);
      total++;
    }
  }
  const dominant = Math.max(...counts.values());
  return dominant / total > 0.992;
}
