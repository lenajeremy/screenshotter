/**
 * Figma's own file format, read without Figma's API (which allows free accounts only a few reads a
 * month): a .fig file (File › Save local copy: a zip of canvas.fig and its pictures), or what Figma
 * puts on the clipboard when you copy (the same canvas data, inside HTML). Both are "fig-kiwi": a
 * schema and a message in the kiwi format, compressed. Decoded here into Figma's own nodes.
 */
import { inflateRawSync, zstdDecompressSync } from "node:zlib";
import { compileSchema, decodeBinarySchema } from "kiwi-schema";

export interface FigArchive {
  /** Figma's document: every node (nodeChanges) and the binary blobs its paths point into. */
  message: FigMessage;
  /** Pictures by their hash (hex), as image paints name them. */
  images: Map<string, Buffer>;
  /** The file's name, when the archive says. */
  name?: string;
}
export interface FigMessage {
  nodeChanges: any[];
  blobs?: Array<{ bytes: Uint8Array }>;
  [k: string]: unknown;
}

/** The files in a zip (stored or deflated): enough for Figma's .fig files. */
export function readZip(buf: Buffer): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  // The end of the central directory, from the end (a comment may follow it).
  let end = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 66000); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new Error("That file isn't a .fig file Figma saved (it's not a zip).");
  const count = buf.readUInt16LE(end + 10);
  let p = buf.readUInt32LE(end + 16);
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString("utf8");
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith("/")) continue;
    const dataAt = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(dataAt, dataAt + size);
    files.set(name, method === 8 ? inflateRawSync(raw) : Buffer.from(raw));
  }
  return files;
}

const unpack = (c: Uint8Array) => (c[0] === 0x28 && c[1] === 0xb5 && c[2] === 0x2f && c[3] === 0xfd ? zstdDecompressSync(c) : inflateRawSync(c));

/** A fig-kiwi archive: "fig-kiwi", a version, then length-prefixed chunks (schema, message, …). */
export function decodeFigKiwi(buf: Buffer): FigMessage {
  if (buf.subarray(0, 8).toString("latin1") !== "fig-kiwi") throw new Error("That isn't Figma's format (fig-kiwi).");
  const chunks: Buffer[] = [];
  for (let o = 12; o + 4 <= buf.length; ) {
    const n = buf.readUInt32LE(o);
    chunks.push(buf.subarray(o + 4, o + 4 + n));
    o += 4 + n;
  }
  if (chunks.length < 2) throw new Error("Figma's data was cut short.");
  const schema = compileSchema(decodeBinarySchema(unpack(chunks[0])));
  const message = schema.decodeMessage(unpack(chunks[1])) as FigMessage;
  if (!Array.isArray(message.nodeChanges)) throw new Error("Figma's data had no layers in it.");
  return message;
}

/** A .fig file: its canvas, and its pictures (images/<hash>). */
export function readFigFile(buf: Buffer): FigArchive {
  // An old .fig is the canvas on its own; a newer one is a zip with it inside.
  if (buf.subarray(0, 8).toString("latin1") === "fig-kiwi") return { message: decodeFigKiwi(buf), images: new Map() };
  const files = readZip(buf);
  const canvas = files.get("canvas.fig");
  if (!canvas) throw new Error("That .fig file has no canvas in it.");
  const images = new Map<string, Buffer>();
  for (const [name, data] of files) if (name.startsWith("images/")) images.set(name.slice(7), data);
  let name: string | undefined;
  try {
    name = (JSON.parse(files.get("meta.json")?.toString("utf8") ?? "{}") as { file_name?: string }).file_name;
  } catch {
    // No name: fine.
  }
  return { message: decodeFigKiwi(canvas), images, name };
}

/** Is this HTML what Figma puts on the clipboard? */
export const isFigmaClipboard = (html: string) => /\(figma\)[A-Za-z0-9+/=\s]+\(\/figma\)/.test(html);

/** What Figma copied: the canvas data from the clipboard's HTML (pictures aren't in it). */
export function readFigClipboard(html: string): FigArchive & { fileKey?: string } {
  const data = /\(figma\)([A-Za-z0-9+/=\s]+)\(\/figma\)/.exec(html)?.[1];
  if (!data) throw new Error("That isn't something copied from Figma.");
  let fileKey: string | undefined;
  try {
    const meta = /\(figmeta\)([A-Za-z0-9+/=\s]+)\(\/figmeta\)/.exec(html)?.[1];
    if (meta) fileKey = (JSON.parse(Buffer.from(meta, "base64").toString("utf8")) as { fileKey?: string }).fileKey;
  } catch {
    // No metadata: fine.
  }
  return { message: decodeFigKiwi(Buffer.from(data, "base64")), images: new Map(), fileKey };
}
