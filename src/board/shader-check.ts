/**
 * Shader code compiled where it will run, as an agent writes it: in headless Chrome, by the same
 * runtime the canvas uses, so errors come back with the lines they're on before the person sees
 * them on the board. Results are kept by code, so a shader is compiled once.
 */
import { newPage } from "../render/browser.js";
import { shaderRuntime } from "./render.js";

export interface ShaderError {
  /** The line of the code as written (null: not one of its lines). */
  line: number | null;
  message: string;
}

const known = new Map<string, ShaderError[]>();

/** Each code's errors (none: it compiles), or why it couldn't be compiled here at all. */
export async function compileShaders(codes: string[]): Promise<Map<string, ShaderError[]> | { unavailable: string }> {
  const want = [...new Set(codes)].filter((c) => !known.has(c));
  if (want.length) {
    const runtime = shaderRuntime();
    if (!runtime) return { unavailable: "the shader runtime wasn't found" };
    let page: Awaited<ReturnType<typeof newPage>> | undefined;
    try {
      page = await newPage();
      await page.setContent(`<!doctype html><html><head><script>${runtime.replace(/<\/script/gi, "<\\/script")}</script></head><body></body></html>`);
      // A string, not a function: nothing of this module's (or tsx's) goes into the page.
      const got = (await page.evaluate(`(${JSON.stringify(want)}).map((c) => BoardShaders.compile(c))`)) as Array<{ ok: boolean; errors: ShaderError[]; webgl: number }>;
      if (got.some((g) => !g.webgl)) return { unavailable: "headless Chrome has no WebGL on this Mac" };
      if (known.size > 300) known.clear();
      want.forEach((c, i) => known.set(c, got[i].errors));
    } catch (e) {
      return { unavailable: (e as Error).message.split("\n")[0] };
    } finally {
      await page?.close().catch(() => undefined);
    }
  }
  return new Map(codes.map((c) => [c, known.get(c) ?? []]));
}

/** Errors as an agent reads them: "line 4: 'oops' : undeclared identifier". */
export const errorWords = (errors: ShaderError[]) => errors.map((e) => (e.line ? `line ${e.line}: ${e.message}` : e.message));
