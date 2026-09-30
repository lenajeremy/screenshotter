import { createHash } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { cacheDir, resolveUserPath } from "../util/files.js";

/** A background photo on disk, with attribution when it came from a service. */
export interface Photo {
  path: string;
  /** Dominant colour when known (Unsplash reports one), used for auto shadows and text. */
  color?: string;
  credit?: string;
}

export { cacheDir };

const hash = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 20);

const IMAGE_EXT: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "image/avif": ".avif",
  "image/heic": ".heic",
};

/** Download an image; refuses anything that isn't one. Returns its content type. */
async function download(url: string, file: string, headers: Record<string, string> = {}): Promise<string> {
  const res = await fetch(url, { headers: { "User-Agent": "screenshotter-mcp", ...headers }, redirect: "follow", signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`Download failed (${res.status}) for ${url}`);
  const type = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (!type.startsWith("image/")) throw new Error(`${url} is not an image (content type "${type || "unknown"}").`);
  writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  return type;
}

function readMeta(file: string): Omit<Photo, "path"> {
  try {
    return JSON.parse(readFileSync(`${file}.json`, "utf8"));
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------------------------
// Unsplash (public web endpoints; no API key needed)

async function unsplashById(id: string, width: number): Promise<Photo> {
  const w = width > 2400 ? 3200 : 2400;
  const file = path.join(cacheDir("unsplash"), `${id}-${w}.jpg`);
  if (!existsSync(file)) {
    await download(`https://unsplash.com/photos/${encodeURIComponent(id)}/download?force=true&w=${w}`, file);
    try {
      const res = await fetch(`https://unsplash.com/napi/photos/${encodeURIComponent(id)}`, {
        headers: { Accept: "application/json" },
      });
      if (res.ok) {
        const meta = (await res.json()) as any;
        writeFileSync(
          `${file}.json`,
          JSON.stringify({ color: meta.color, credit: `Photo by ${meta.user?.name} on Unsplash (${meta.links?.html ?? `https://unsplash.com/photos/${id}`})` }),
        );
      }
    } catch {
      // Attribution is best-effort.
    }
  }
  return { path: file, ...readMeta(file) };
}

/** Search Unsplash and take the `pick`-th result (0-based) that suits the canvas orientation. */
async function unsplashSearch(query: string, orientation: "landscape" | "portrait" | "squarish", pick: number, width: number): Promise<Photo> {
  const key = hash(`${query}|${orientation}|${pick}`);
  const cached = path.join(cacheDir("unsplash"), `search-${key}.txt`);
  let id = existsSync(cached) ? readFileSync(cached, "utf8").trim() : "";
  if (!id) {
    const url = `https://unsplash.com/napi/search/photos?query=${encodeURIComponent(query)}&per_page=20&orientation=${orientation}`;
    const res = await fetch(url, { headers: { Accept: "application/json", "User-Agent": "screenshotter-mcp" } });
    if (!res.ok) throw new Error(`Unsplash search failed (${res.status}). Pass a photo id with "unsplash:<id>" instead.`);
    const results = (((await res.json()) as any).results ?? []).filter((r: any) => !r.premium && !r.plus);
    if (!results.length) throw new Error(`Unsplash found no free photos for "${query}".`);
    id = results[pick % results.length].id;
    writeFileSync(cached, id);
  }
  return unsplashById(id, width);
}

// ---------------------------------------------------------------------------------------------
// AI image generation

export interface GenerateOptions {
  prompt: string;
  provider?: "openai" | "gemini" | "replicate" | "fal";
  model?: string;
  /** Keep the prompt exactly as written (no background-friendly suffix). */
  raw?: boolean;
  /** Different number → different image for the same prompt. */
  seed?: number;
}

const PROMPT_SUFFIX =
  ". Use as a wide background image for product marketing: no text, no logos, no devices, no UI, soft natural light, uncluttered composition.";

function availableProvider(): GenerateOptions["provider"] | undefined {
  if (process.env.OPENAI_API_KEY) return "openai";
  if (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || process.env.GOOGLE_GENERATIVE_AI_API_KEY) return "gemini";
  if (process.env.REPLICATE_API_TOKEN) return "replicate";
  if (process.env.FAL_KEY) return "fal";
  return undefined;
}

type Aspect = { ratio: string; w: number; h: number };
function aspectFor(width: number, height: number): Aspect {
  const r = width / height;
  const options: Aspect[] = [
    { ratio: "9:16", w: 9, h: 16 },
    { ratio: "2:3", w: 2, h: 3 },
    { ratio: "3:4", w: 3, h: 4 },
    { ratio: "1:1", w: 1, h: 1 },
    { ratio: "4:3", w: 4, h: 3 },
    { ratio: "3:2", w: 3, h: 2 },
    { ratio: "16:9", w: 16, h: 9 },
  ];
  return options.reduce((best, o) => (Math.abs(Math.log(o.w / o.h / r)) < Math.abs(Math.log(best.w / best.h / r)) ? o : best));
}

async function generateOpenAI(prompt: string, aspect: Aspect, model?: string): Promise<Buffer> {
  const size = aspect.w === aspect.h ? "1024x1024" : aspect.w > aspect.h ? "1536x1024" : "1024x1536";
  const res = await fetch("https://api.openai.com/v1/images/generations", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    body: JSON.stringify({
      model: model ?? process.env.SCREENSHOTTER_OPENAI_IMAGE_MODEL ?? "gpt-image-1",
      prompt,
      size,
      quality: "high",
      n: 1,
    }),
  });
  const body = (await res.json()) as any;
  if (!res.ok) throw new Error(`OpenAI image generation failed: ${body?.error?.message ?? res.status}`);
  const item = body.data?.[0];
  if (item?.b64_json) return Buffer.from(item.b64_json, "base64");
  if (item?.url) return Buffer.from(await (await fetch(item.url)).arrayBuffer());
  throw new Error("OpenAI returned no image.");
}

async function generateGemini(prompt: string, aspect: Aspect, model?: string): Promise<Buffer> {
  const key = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY ?? process.env.GOOGLE_GENERATIVE_AI_API_KEY;
  const m = model ?? process.env.SCREENSHOTTER_GEMINI_IMAGE_MODEL ?? "gemini-2.5-flash-image";
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": key! },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { responseModalities: ["IMAGE"], imageConfig: { aspectRatio: aspect.ratio } },
    }),
  });
  const body = (await res.json()) as any;
  if (!res.ok) throw new Error(`Gemini image generation failed: ${body?.error?.message ?? res.status}`);
  const parts = body.candidates?.[0]?.content?.parts ?? [];
  const data = parts.find((p: any) => p.inlineData?.data)?.inlineData?.data;
  if (!data) throw new Error("Gemini returned no image.");
  return Buffer.from(data, "base64");
}

async function generateReplicate(prompt: string, aspect: Aspect, model?: string): Promise<Buffer> {
  const m = model ?? process.env.SCREENSHOTTER_REPLICATE_MODEL ?? "black-forest-labs/flux-1.1-pro";
  const res = await fetch(`https://api.replicate.com/v1/models/${m}/predictions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.REPLICATE_API_TOKEN}`,
      Prefer: "wait",
    },
    body: JSON.stringify({ input: { prompt, aspect_ratio: aspect.ratio, output_format: "png" } }),
  });
  let body = (await res.json()) as any;
  if (!res.ok) throw new Error(`Replicate generation failed: ${body?.detail ?? res.status}`);
  for (let i = 0; i < 60 && body.status !== "succeeded"; i++) {
    if (body.status === "failed" || body.status === "canceled") throw new Error(`Replicate generation ${body.status}: ${body.error ?? ""}`);
    await new Promise((r) => setTimeout(r, 2000));
    body = await (await fetch(body.urls.get, { headers: { Authorization: `Bearer ${process.env.REPLICATE_API_TOKEN}` } })).json();
  }
  const url = Array.isArray(body.output) ? body.output[0] : body.output;
  if (!url) throw new Error("Replicate returned no image.");
  return Buffer.from(await (await fetch(url, { signal: AbortSignal.timeout(120_000) })).arrayBuffer());
}

async function generateFal(prompt: string, aspect: Aspect, model?: string): Promise<Buffer> {
  const m = model ?? process.env.SCREENSHOTTER_FAL_MODEL ?? "fal-ai/flux/dev";
  const size =
    aspect.w === aspect.h ? "square_hd" : aspect.w > aspect.h ? (aspect.w / aspect.h > 1.5 ? "landscape_16_9" : "landscape_4_3") : aspect.h / aspect.w > 1.5 ? "portrait_16_9" : "portrait_4_3";
  const res = await fetch(`https://fal.run/${m}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Key ${process.env.FAL_KEY}` },
    body: JSON.stringify({ prompt, image_size: size, num_images: 1 }),
  });
  const body = (await res.json()) as any;
  if (!res.ok) throw new Error(`fal generation failed: ${body?.detail ?? res.status}`);
  const url = body.images?.[0]?.url;
  if (!url) throw new Error("fal returned no image.");
  return Buffer.from(await (await fetch(url)).arrayBuffer());
}

export async function generateImage(opts: GenerateOptions, width: number, height: number): Promise<Photo> {
  const provider = opts.provider ?? availableProvider();
  if (!provider) {
    throw new Error(
      "AI backgrounds need an image API key in the MCP server's environment: OPENAI_API_KEY, GEMINI_API_KEY, REPLICATE_API_TOKEN or FAL_KEY. " +
        "Alternatively generate an image with another tool and pass its path as `photo`.",
    );
  }
  const aspect = aspectFor(width, height);
  const prompt = opts.raw ? opts.prompt : `${opts.prompt.replace(/[.\s]+$/, "")}${PROMPT_SUFFIX}`;
  const file = path.join(cacheDir("generated"), `${hash(`${provider}|${opts.model ?? ""}|${aspect.ratio}|${prompt}|${opts.seed ?? 0}`)}.png`);
  if (!existsSync(file)) {
    const run = { openai: generateOpenAI, gemini: generateGemini, replicate: generateReplicate, fal: generateFal }[provider];
    writeFileSync(file, await run(prompt, aspect, opts.model));
    writeFileSync(`${file}.json`, JSON.stringify({ credit: `AI generated (${provider}): ${opts.prompt}` }));
  }
  return { path: file, ...readMeta(file) };
}

// ---------------------------------------------------------------------------------------------

/**
 * Resolve a photo reference to a local file. Accepts a path, an http(s) URL,
 * "unsplash:<photo id>", or "unsplash:search:<query>".
 */
export async function resolvePhoto(ref: string, canvas: { width: number; height: number }, pick = 0): Promise<Photo> {
  const orientation = canvas.width > canvas.height * 1.15 ? "landscape" : canvas.height > canvas.width * 1.15 ? "portrait" : "squarish";
  const width = Math.max(canvas.width, canvas.height);
  if (ref.startsWith("unsplash:search:")) return unsplashSearch(ref.slice("unsplash:search:".length), orientation, pick, width);
  if (ref.startsWith("unsplash:")) return unsplashById(ref.slice("unsplash:".length), width);
  const unsplashPage = /unsplash\.com\/photos\/(?:[^/?#]*-)?([A-Za-z0-9_-]{11})(?:[/?#]|$)/.exec(ref);
  if (unsplashPage) return unsplashById(unsplashPage[1], width);
  if (/^https?:\/\//.test(ref)) {
    // Cache under the content type's extension so the renderer recognises the format.
    const dir = cacheDir("remote");
    const existing = Object.values(IMAGE_EXT).map((ext) => path.join(dir, `${hash(ref)}${ext}`)).find((f) => existsSync(f));
    if (existing) return { path: existing };
    const tmp = path.join(dir, `${hash(ref)}.download`);
    const type = await download(ref, tmp);
    const file = path.join(dir, `${hash(ref)}${IMAGE_EXT[type] ?? ".jpg"}`);
    renameSync(tmp, file);
    return { path: file };
  }
  const file = resolveUserPath(ref);
  if (!existsSync(file)) throw new Error(`Background photo not found: ${file}`);
  return { path: file };
}
