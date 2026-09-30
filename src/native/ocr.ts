import { createHash } from "node:crypto";
import { existsSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { run } from "../util/exec.js";
import { cacheDir } from "../util/files.js";

/** A line of text found in an image, in image pixels (top-left origin). */
export interface TextBox {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  confidence: number;
}

// Swift source for a tiny Vision OCR helper, compiled once with swiftc and cached.
const SOURCE = `// Prints the text Vision finds in an image as JSON: [{text, x, y, width, height, confidence}]
// in image pixels with a top-left origin. Usage: ocr <image> [fast]
import Foundation
import Vision
import AppKit

let args = CommandLine.arguments
guard args.count >= 2, let image = NSImage(contentsOfFile: args[1]),
      let cg = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
  FileHandle.standardError.write("cannot read image\\n".data(using: .utf8)!)
  exit(1)
}
let width = Double(cg.width), height = Double(cg.height)
let request = VNRecognizeTextRequest()
request.recognitionLevel = (args.count > 2 && args[2] == "fast") ? .fast : .accurate
request.usesLanguageCorrection = true
let handler = VNImageRequestHandler(cgImage: cg, options: [:])
do { try handler.perform([request]) } catch {
  FileHandle.standardError.write("\\(error)\\n".data(using: .utf8)!)
  exit(1)
}
var out: [[String: Any]] = []
for obs in request.results ?? [] {
  guard let top = obs.topCandidates(1).first else { continue }
  let b = obs.boundingBox
  out.append([
    "text": top.string,
    "x": (b.minX * width).rounded(),
    "y": ((1 - b.maxY) * height).rounded(),
    "width": (b.width * width).rounded(),
    "height": (b.height * height).rounded(),
    "confidence": Double(top.confidence),
  ])
}
let data = try JSONSerialization.data(withJSONObject: out, options: [])
FileHandle.standardOutput.write(data)
`;

let binary: Promise<string> | undefined;

/** Compile the helper ahead of time so the first capture doesn't wait for swiftc. */
export function warmUpOcr(): void {
  if (process.platform === "darwin") void ocrBinary().catch(() => undefined);
}

function ocrBinary(): Promise<string> {
  binary ??= (async () => {
    const id = createHash("sha256").update(SOURCE).digest("hex").slice(0, 12);
    const dir = cacheDir("bin");
    const bin = path.join(dir, `ocr-${id}`);
    if (!existsSync(bin)) {
      const src = path.join(dir, `ocr-${id}.swift`);
      writeFileSync(src, SOURCE);
      await run("xcrun", ["swiftc", "-O", src, "-o", bin], { timeoutMs: 300_000 });
    }
    return bin;
  })().catch((e) => {
    binary = undefined;
    throw new Error(`Text recognition needs Xcode's Swift compiler: ${(e as Error).message}`);
  });
  return binary;
}

const cache = new Map<string, TextBox[]>();

/** Recognise text in an image with Apple's Vision framework (on-device). */
export async function recognizeText(file: string): Promise<TextBox[]> {
  const key = `${file}:${statSync(file).mtimeMs}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const { stdout } = await run(await ocrBinary(), [file], { timeoutMs: 180_000 });
  const boxes = (JSON.parse(stdout) as TextBox[]).sort((a, b) => a.y - b.y || a.x - b.x);
  cache.set(key, boxes);
  return boxes;
}

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

/** Find the n-th (1-based, top to bottom) text box containing `query`. */
export async function findText(file: string, query: string, match = 1): Promise<TextBox> {
  const boxes = await recognizeText(file);
  const q = norm(query);
  const hits = boxes.filter((b) => norm(b.text).includes(q));
  if (!hits.length) {
    const seen = boxes.slice(0, 30).map((b) => `"${b.text}"`).join(", ");
    throw new Error(`Text "${query}" not found in ${path.basename(file)}. Visible text: ${seen}`);
  }
  if (match > hits.length) throw new Error(`Only ${hits.length} match(es) for "${query}", asked for #${match}.`);
  const hit = hits[match - 1];
  // Narrow a longer line down to the matched words, proportionally by character position.
  const idx = norm(hit.text).indexOf(q);
  if (idx > 0 || q.length < norm(hit.text).length) {
    const perChar = hit.width / Math.max(1, hit.text.length);
    return { ...hit, text: query, x: hit.x + idx * perChar, width: Math.max(perChar * q.length, 8) };
  }
  return hit;
}
