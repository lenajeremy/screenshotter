import path from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { ensureDir, outputRoot, resolveUserPath, slug, timestamp } from "../util/files.js";
import { createMockup, renderHtml, type MockupResult } from "./mockup.js";
import { DeviceInputSchema, MockupInputShape, TextInputSchema, type MockupInput } from "./schema.js";

const ScreenSchema = z.object({
  screenshot: z.string().optional().describe("Screenshot for a single-device screen."),
  devices: z.array(DeviceInputSchema).optional().describe("Use instead of `screenshot` for multi-device screens."),
  headline: z.string().optional(),
  subheadline: z.string().optional(),
  layout: MockupInputShape.layout,
  background: MockupInputShape.background,
  textStyle: MockupInputShape.textStyle,
  texts: z.array(TextInputSchema).optional(),
  deviceOverrides: DeviceInputSchema.omit({ screenshot: true })
    .partial()
    .optional()
    .describe("Device settings for this screen only, e.g. {rotateY:-20} or {color:\"Silver\"}."),
});

export const MockupSetShape = {
  name: z.string().optional().describe("Folder name for the set, e.g. \"app-store-en\"."),
  screens: z.array(ScreenSchema).min(1).max(12).describe("One entry per output image, in order."),
  deviceDefaults: DeviceInputSchema.omit({ screenshot: true })
    .partial()
    .optional()
    .describe("Applied to every device unless a screen overrides it (e.g. {device:\"iPhone 17 Pro\", color:\"Silver\", shadow:\"strong\"})."),
  canvas: MockupInputShape.canvas,
  landscape: MockupInputShape.landscape,
  layout: MockupInputShape.layout,
  background: MockupInputShape.background,
  effects: MockupInputShape.effects,
  textStyle: MockupInputShape.textStyle,
  fonts: MockupInputShape.fonts,
  output: z.string().optional().describe("Directory for the set. Default: ./screenshots/sets/<name>-<timestamp>/."),
  format: MockupInputShape.format,
  quality: MockupInputShape.quality,
  jpegQuality: MockupInputShape.jpegQuality,
  deliveryWidth: MockupInputShape.deliveryWidth,
  preview: z.boolean().optional().describe("Return a contact sheet of the whole set. Default true."),
};

export const MockupSetSchema = z.object(MockupSetShape);
export type MockupSetInput = z.infer<typeof MockupSetSchema>;

export interface MockupSetResult {
  directory: string;
  files: MockupResult[];
  contactSheet: string;
}

export async function createMockupSet(input: MockupSetInput): Promise<MockupSetResult> {
  const name = input.name ?? "set";
  const dir = ensureDir(
    input.output ? resolveUserPath(input.output) : path.join(outputRoot(), "sets", `${slug(name)}-${timestamp()}`),
  );
  const ext = input.format === "jpeg" ? "jpg" : (input.format ?? "png");
  const files: MockupResult[] = [];

  for (const [i, screen] of input.screens.entries()) {
    const devices = (screen.devices ?? (screen.screenshot ? [{ screenshot: screen.screenshot }] : [])).map((d) => ({
      ...input.deviceDefaults,
      ...screen.deviceOverrides,
      ...d,
    }));
    if (!devices.length) throw new Error(`Screen ${i + 1} needs a "screenshot" or "devices".`);
    const mockup: MockupInput = {
      devices,
      canvas: input.canvas,
      landscape: input.landscape,
      layout: screen.layout ?? input.layout,
      background: screen.background ?? input.background,
      effects: input.effects,
      headline: screen.headline,
      subheadline: screen.subheadline,
      textStyle: { ...input.textStyle, ...screen.textStyle },
      texts: screen.texts,
      fonts: input.fonts,
      format: input.format,
      quality: input.quality,
      jpegQuality: input.jpegQuality,
      deliveryWidth: input.deliveryWidth,
      output: path.join(dir, `${String(i + 1).padStart(2, "0")}-${slug(screen.headline ?? `screen-${i + 1}`)}.${ext}`),
    };
    files.push(await createMockup(mockup));
  }

  const contactSheet = path.join(dir, "contact-sheet.png");
  await renderContactSheet(files, contactSheet);
  return { directory: dir, files, contactSheet };
}

/** All images of the set side by side, the way they appear on an App Store product page. */
async function renderContactSheet(files: MockupResult[], out: string): Promise<void> {
  const tileH = 1100;
  const gap = 40;
  const tiles = files.map((f) => ({ w: Math.round((f.width / f.height) * tileH), url: pathToFileURL(f.path).href }));
  const W = tiles.reduce((s, t) => s + t.w, 0) + gap * (tiles.length + 1);
  const H = tileH + gap * 2;
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;background:#e9e9ee;}
#c{display:flex;gap:${gap}px;padding:${gap}px;width:${W}px;height:${H}px;box-sizing:border-box;}
img{height:${tileH}px;border-radius:24px;box-shadow:0 8px 30px rgba(0,0,0,.18);}
</style></head><body><div id="c">${tiles.map((t) => `<img src="${t.url}" style="width:${t.w}px">`).join("")}</div></body></html>`;
  await renderHtml(html, out, W, H, { scale: 1, format: "png", transparent: false });
}
