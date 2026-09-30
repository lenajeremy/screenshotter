import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { run } from "./exec.js";

export interface ImageSize {
  width: number;
  height: number;
}

/** Read PNG/JPEG dimensions straight from the file header, falling back to `sips`. */
export async function imageSize(file: string): Promise<ImageSize> {
  const header = readFileSync(file).subarray(0, 64 * 1024);
  // PNG: width/height live in the IHDR chunk.
  if (header.length > 24 && header.readUInt32BE(0) === 0x89504e47) {
    return { width: header.readUInt32BE(16), height: header.readUInt32BE(20) };
  }
  // JPEG: walk segments until a start-of-frame marker.
  if (header[0] === 0xff && header[1] === 0xd8) {
    let i = 2;
    while (i + 9 < header.length) {
      if (header[i] !== 0xff) break;
      const marker = header[i + 1];
      const len = header.readUInt16BE(i + 2);
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: header.readUInt16BE(i + 5), width: header.readUInt16BE(i + 7) };
      }
      i += 2 + len;
    }
  }
  const { stdout } = await run("sips", ["-g", "pixelWidth", "-g", "pixelHeight", file]);
  const width = Number(/pixelWidth:\s*(\d+)/.exec(stdout)?.[1]);
  const height = Number(/pixelHeight:\s*(\d+)/.exec(stdout)?.[1]);
  if (!width || !height) throw new Error(`Could not read image size of ${file}`);
  return { width, height };
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
