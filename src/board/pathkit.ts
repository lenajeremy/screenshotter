/**
 * Skia's path library (PathKit, Google's, compiled to WebAssembly): what Figma itself draws shapes
 * with. It joins shapes (union, subtract, intersect, exclude) into the one outline Figma would
 * draw, for shapes Figma didn't store an outline for (everything copied to the clipboard). Loaded
 * the first time a Figma import needs it; when it can't load, the importer draws joined shapes by
 * layering their parts instead (see fig-convert).
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

/** The bits of PathKit used here. */
export interface SkPath {
  op(other: SkPath, op: unknown): SkPath | null;
  transform(...m: number[]): SkPath;
  setFillType(t: unknown): SkPath;
  getFillTypeString(): string;
  toSVGString(): string;
  copy(): SkPath;
  delete(): void;
}
export interface PathKit {
  FromSVGString(d: string): SkPath | null;
  NewPath(): SkPath;
  MakeFromOp(a: SkPath, b: SkPath, op: unknown): SkPath | null;
  PathOp: { UNION: unknown; DIFFERENCE: unknown; INTERSECT: unknown; XOR: unknown };
  FillType: { WINDING: unknown; EVENODD: unknown };
}

let kit: PathKit | null = null;
let loading: Promise<PathKit | null> | null = null;

/** PathKit, loaded once (null when it can't be). */
export function loadPathKit(): Promise<PathKit | null> {
  if (kit) return Promise.resolve(kit);
  loading ??= (async () => {
    // It adds process-wide handlers that rethrow any uncaught error (an Emscripten default): the
    // engine keeps its own, so those are taken off again.
    const before = { u: process.listeners("uncaughtException"), r: process.listeners("unhandledRejection") };
    try {
      const require = createRequire(import.meta.url);
      const main = require.resolve("pathkit-wasm/bin/pathkit.js");
      const init = require(main) as (o: { wasmBinary: Buffer }) => { ready?: () => Promise<PathKit> } & Promise<PathKit>;
      // Its bytes given to it, as it would otherwise try to fetch the file by URL.
      const started = init({ wasmBinary: readFileSync(path.join(path.dirname(main), "pathkit.wasm")) });
      kit = await (started.ready ? started.ready() : started);
      return kit;
    } catch {
      return null;
    } finally {
      for (const l of process.listeners("uncaughtException")) if (!before.u.includes(l)) process.off("uncaughtException", l);
      for (const l of process.listeners("unhandledRejection")) if (!before.r.includes(l)) process.off("unhandledRejection", l);
    }
  })();
  return loading;
}

/** PathKit if it's loaded already (the converter is synchronous: importFig loads it first). */
export const pathKit = () => kit;
