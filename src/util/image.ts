import { closeSync, openSync, readSync, statSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { run } from "./exec.js";

export interface ImageSize {
  width: number;
  height: number;
}

const sizeCache = new Map<string, ImageSize>();

/** Read PNG/JPEG/WebP dimensions straight from the file header (first 64 KB), falling back to `sips`. */
export async function imageSize(file: string): Promise<ImageSize> {
  const st = statSync(file);
  const key = `${file}|${st.mtimeMs}|${st.size}`;
  const hit = sizeCache.get(key);
  if (hit) return hit;

  const buf = Buffer.allocUnsafe(Math.min(st.size, 64 * 1024));
  const fd = openSync(file, "r");
  let read = 0;
  try {
    read = readSync(fd, buf, 0, buf.length, 0);
  } finally {
    closeSync(fd);
  }
  const header = buf.subarray(0, read);

  const remember = (s: ImageSize) => {
    if (sizeCache.size > 2000) sizeCache.clear();
    sizeCache.set(key, s);
    return s;
  };

  // PNG: width/height live in the IHDR chunk.
  if (header.length > 24 && header.readUInt32BE(0) === 0x89504e47) {
    return remember({ width: header.readUInt32BE(16), height: header.readUInt32BE(20) });
  }
  // JPEG: walk segments until a start-of-frame marker.
  if (header.length > 2 && header[0] === 0xff && header[1] === 0xd8) {
    let i = 2;
    while (i + 9 < header.length) {
      if (header[i] !== 0xff) break;
      const marker = header[i + 1];
      const len = header.readUInt16BE(i + 2);
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return remember({ height: header.readUInt16BE(i + 5), width: header.readUInt16BE(i + 7) });
      }
      i += 2 + len;
    }
  }
  // WebP: RIFF....WEBP followed by VP8X / VP8 / VP8L chunk.
  if (header.length >= 30 && header.toString("ascii", 0, 4) === "RIFF" && header.toString("ascii", 8, 12) === "WEBP") {
    const chunk = header.toString("ascii", 12, 16);
    if (chunk === "VP8X") {
      const width = 1 + (header[24] | (header[25] << 8) | (header[26] << 16));
      const height = 1 + (header[27] | (header[28] << 8) | (header[29] << 16));
      return remember({ width, height });
    }
    if (chunk === "VP8L" && header.length >= 25) {
      const bits = header.readUInt32LE(21);
      return remember({ width: 1 + (bits & 0x3fff), height: 1 + ((bits >> 14) & 0x3fff) });
    }
    if (chunk === "VP8 " && header.length >= 30) {
      return remember({ width: header.readUInt16LE(26) & 0x3fff, height: header.readUInt16LE(28) & 0x3fff });
    }
  }
  const { stdout } = await run("sips", ["-g", "pixelWidth", "-g", "pixelHeight", file]);
  const width = Number(/pixelWidth:\s*(\d+)/.exec(stdout)?.[1]);
  const height = Number(/pixelHeight:\s*(\d+)/.exec(stdout)?.[1]);
  if (!width || !height) throw new Error(`Could not read image size of ${file}`);
  return remember({ width, height });
}

/**
 * Produce a small JPEG preview (base64) so agents can look at a result without
 * pulling a multi-megabyte PNG into context.
 */
export async function previewBase64(file: string, maxEdge = 1000): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "screenshotter-preview-"));
  const out = path.join(dir, "preview.jpg");
  try {
    await run("sips", ["-s", "format", "jpeg", "-s", "formatOptions", "80", "-Z", String(maxEdge), file, "--out", out]);
    return (await readFile(out)).toString("base64");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
