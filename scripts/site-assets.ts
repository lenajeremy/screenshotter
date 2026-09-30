/**
 * Render every image on the landing page with Screenshotter itself.
 *
 *   npx tsx scripts/site-assets.ts            # all assets
 *   npx tsx scripts/site-assets.ts hero looks # only jobs whose name starts with these words
 *
 * Mise's screens (site/demo/screens.ts, with real food photos from Unsplash) are drawn at device
 * resolution, then framed, lit and exported by the same engine the app and the MCP use.
 * Output: site/assets/*.webp|mp4.
 */
import { mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { closeBrowser } from "../src/render/browser.js";
import { createMockup, renderHtml } from "../src/render/mockup.js";
import type { MockupInput } from "../src/render/schema.js";
import { createVideo } from "../src/render/video.js";
import { ensurePhotos } from "../site/demo/photos.js";
import * as screens from "../site/demo/screens.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const demo = path.join(root, "site", "demo", "shots");
const out = path.join(root, "site", "assets");
mkdirSync(demo, { recursive: true });
mkdirSync(out, { recursive: true });
const only = process.argv.slice(2);
const want = (name: string) => !only.length || only.some((o) => name.startsWith(o));

// 1. Photos and screens → device-sized screenshots
await ensurePhotos(path.join(root, "site", "demo", "photos"));
const SCREENS: Record<string, { html: string; w: number; h: number; scale: number }> = {
  tonight: { html: screens.tonight(), w: 402, h: 874, scale: 3 },
  recipe: { html: screens.recipe(), w: 402, h: 874, scale: 3 },
  cook: { html: screens.cook(), w: 402, h: 874, scale: 3 },
  groceries: { html: screens.groceries(), w: 402, h: 874, scale: 3 },
  saved: { html: screens.saved(), w: 402, h: 874, scale: 3 },
  ipad: { html: screens.ipad(), w: 1032, h: 1376, scale: 2 },
  watch: { html: screens.watch(), w: 208, h: 248, scale: 2 },
  web: { html: screens.web(), w: 1512, h: 982, scale: 2 },
};
const shot = (n: keyof typeof SCREENS) => path.join(demo, `${n}.png`);
for (const [name, s] of Object.entries(SCREENS)) {
  const file = path.join(demo, `${name}.png`);
  await renderHtml(`<!doctype html><html>${s.html}</html>`, file, s.w, s.h, { scale: s.scale, format: "png", transparent: false, outWidth: s.w * s.scale, outHeight: s.h * s.scale });
}
console.log(`screens → ${path.relative(root, demo)}`);

// 2. Mockups. Art direction: dark, quiet backdrops so the app (and its food photos) carry the
// colour; one green accent that matches the app's tint.
const table = path.join(root, "site", "demo", "photos", "table.jpg");
const BG = {
  table: { photo: table, blur: 0.03, dim: 0.5 },
  warm: { type: "radial" as const, colors: ["#2d2926", "#0a0a0b"], x: 0.5, y: 0.28 },
  green: { type: "radial" as const, colors: ["#1e2c25", "#070908"], x: 0.5, y: 0.28 },
  graphite: "graphite",
};
const INK = { color: "#f5f5f7", accentColor: "#7ccf9d" };
const clear = { type: "transparent" as const };
const STORY = { canvas: { width: 1200, height: 1500 }, layout: "custom" as const };
const storyDevice = { x: 0.5, y: 0.6, anchor: "center" as const, height: 0.74 };
const storyText = { ...INK, x: 0.5, y: 0.075, anchor: "top" as const, headlineSize: 0.062 };
const offscreen = (file: string) => ({ screenshot: file, frame: "none" as const, height: 0.02, x: -2, y: -2, shadow: "none" as const });
const phone = "Deep Blue";

type Job = { name: string; input: Partial<MockupInput> & Pick<MockupInput, "devices">; width?: number };
const jobs: Job[] = [
  // Hero: two phones, transparent, so the page's own light plays behind them.
  { name: "hero-front", width: 900, input: { devices: [{ screenshot: shot("recipe"), color: phone, rotateY: -18, rotateX: 6, rotate: -3, x: 0.5, y: 0.5, anchor: "center", height: 0.84, shadow: "studio" }], canvas: "1100x1400", layout: "custom", background: clear } },
  { name: "hero-back", width: 760, input: { devices: [{ screenshot: shot("tonight"), color: phone, rotateY: 22, rotateX: 5, rotate: 4, x: 0.5, y: 0.5, anchor: "center", height: 0.84, shadow: "soft" }], canvas: "1100x1400", layout: "custom", background: clear } },

  // The five-step story, each layer on the same 1200 × 1500 canvas so they stack exactly.
  { name: "story-1-raw", width: 900, input: { ...STORY, devices: [{ screenshot: shot("tonight"), frame: "none", ...storyDevice, height: 0.66, shadow: "soft", radius: 30 }], background: clear } },
  { name: "story-2-device", width: 900, input: { ...STORY, devices: [{ screenshot: shot("tonight"), color: phone, ...storyDevice, shadow: "medium" }], background: clear } },
  { name: "story-3-backdrop", width: 900, input: { ...STORY, devices: [offscreen(shot("tonight"))], background: BG.table } },
  { name: "story-4-headline", width: 900, input: { ...STORY, devices: [offscreen(shot("tonight"))], background: clear, headline: "Dinner, **sorted.**", textStyle: storyText } },
  { name: "story-5-final", width: 900, input: { ...STORY, devices: [{ screenshot: shot("tonight"), color: phone, ...storyDevice, rotateY: -16, rotateX: 6, shadow: "studio" }], background: BG.table, headline: "Dinner, **sorted.**", textStyle: storyText, effects: { grain: 0.08, vignette: 0.25 } } },

  // Ask AI, before and after one sentence.
  { name: "ai-before", width: 720, input: { devices: [{ screenshot: shot("cook"), color: phone }], canvas: "1080x1350", layout: "hero", background: BG.graphite, headline: "Cook with both hands free", textStyle: { color: "#f5f5f7" } } },
  { name: "ai-after", width: 720, input: { devices: [{ screenshot: shot("cook"), color: phone, rotateY: -14, rotateX: 6, shadow: "studio" }], canvas: "1080x1350", layout: "hero", background: BG.table, headline: "Cook with **both hands** free", textStyle: INK, effects: { grain: 0.08, vignette: 0.2 } } },

  // Devices, transparent for the showcase.
  { name: "dev-mac", width: 1300, input: { devices: [{ screenshot: shot("web"), color: "Space Black", x: 0.5, y: 0.5, anchor: "center", height: 0.9, shadow: "soft" }], canvas: "1700x1150", layout: "custom", background: clear } },
  { name: "dev-ipad", width: 760, input: { devices: [{ screenshot: shot("ipad"), color: "Space Black", rotateY: 12, rotateX: 4, x: 0.5, y: 0.5, anchor: "center", height: 0.88, shadow: "soft" }], canvas: "1000x1150", layout: "custom", background: clear } },
  { name: "dev-iphone", width: 480, input: { devices: [{ screenshot: shot("recipe"), color: phone, rotateY: -14, rotateX: 5, x: 0.5, y: 0.5, anchor: "center", height: 0.9, shadow: "soft" }], canvas: "700x1200", layout: "custom", background: clear } },
  { name: "dev-watch", width: 360, input: { devices: [{ screenshot: shot("watch"), color: "Jet Black", rotateY: 16, x: 0.5, y: 0.5, anchor: "center", height: 0.34, shadow: "soft" }], canvas: "600x1500", layout: "custom", background: clear } },
  { name: "dev-browser", width: 1100, input: { devices: [{ screenshot: shot("web"), frame: "browser", url: "mise.app", chrome: "dark", x: 0.5, y: 0.5, anchor: "center", height: 0.86, shadow: "medium" }], canvas: "1700x1150", layout: "custom", background: clear } },

  // Call-outs, found by the words on screen.
  { name: "callout-lift", width: 620, input: { devices: [{ screenshot: shot("groceries"), color: phone, highlights: [{ style: "lift", text: "Fresh ramen noodles" }] }], canvas: "1080x1350", layout: "floating", background: BG.graphite } },
  { name: "callout-loupe", width: 620, input: { devices: [{ screenshot: shot("recipe"), color: phone, highlights: [{ style: "loupe", text: "6½ min", scale: 2.2 }] }], canvas: "1080x1350", layout: "floating", background: BG.warm } },
  { name: "callout-spotlight", width: 620, input: { devices: [{ screenshot: shot("cook"), color: phone, highlights: [{ style: "spotlight", text: "04:36" }] }], canvas: "1080x1350", layout: "floating", background: BG.green } },
];

// Backdrops: the same app on a handful of dark, tuned backdrops.
const BACKDROPS: Array<[string, keyof typeof SCREENS, unknown]> = [
  ["table", "recipe", BG.table],
  ["warm", "tonight", BG.warm],
  ["green", "cook", BG.green],
  ["graphite", "saved", BG.graphite],
  ["bokeh", "saved", { look: "city-bokeh", dim: 0.35, blur: 0.01 }],
  ["mesh", "cook", { type: "mesh", colors: ["#0b0d0c", "#1d2a23", "#12161c", "#0a0a0a"], meshStyle: "field" }],
  ["aurora", "groceries", { look: "aurora-night", dim: 0.4, saturation: 0.75 }],
  ["ink", "tonight", "ink"],
];
for (const [name, screen, bg] of BACKDROPS) {
  jobs.push({ name: `bg-${name}`, width: 520, input: { devices: [{ screenshot: shot(screen), color: phone }], canvas: "1080x1350", layout: "floating", background: bg as never, effects: { grain: 0.06 } } });
}

// An App Store set on one backdrop.
const SET: Array<[keyof typeof SCREENS, string, Partial<MockupInput>]> = [
  ["tonight", "Dinner, **sorted.**", {}],
  ["recipe", "Recipes worth **cooking tonight**", { layout: "hero-bleed" }],
  ["cook", "Cook with **both hands** free", { layout: "tilted" }],
  ["groceries", "Your list, **sorted by aisle**", {}],
  ["watch", "Timers on your **wrist**", {}],
];
SET.forEach(([screen, headline, extra], i) =>
  jobs.push({
    name: `set-${i + 1}`,
    width: 460,
    input: { devices: [{ screenshot: shot(screen), color: screen === "watch" ? "Jet Black" : phone }], canvas: "iphone-6.9", background: BG.table, headline, textStyle: INK, effects: { grain: 0.08, vignette: 0.2 }, ...extra },
  }),
);

let n = 0;
for (const job of jobs.filter((j) => want(j.name))) {
  const t = Date.now();
  const file = path.join(out, `${job.name}.webp`);
  await createMockup({ ...(job.input as MockupInput), format: "webp", jpegQuality: 86, deliveryWidth: job.width, preview: false, output: file });
  n++;
  console.log(`${job.name.padEnd(22)} ${String(Date.now() - t).padStart(5)} ms  ${(statSync(file).size / 1024).toFixed(0)} KB`);
}

// A short clip for the video tile.
if (want("video")) {
  const file = path.join(out, "video-drift.mp4");
  await createVideo({
    devices: [{ screenshot: shot("recipe"), color: phone }],
    canvas: "1080x1350",
    background: BG.table,
    headline: "Dinner, **sorted.**",
    textStyle: INK,
    effects: { vignette: 0.2 },
    format: "mp4",
    deliveryWidth: 540,
    preview: false,
    output: file,
    video: { duration: 6, fps: 30, motion: "drift" },
  } as never);
  console.log(`video-drift.mp4 ${(statSync(file).size / 1024).toFixed(0)} KB`);
}
await closeBrowser();
// The page needs the images, not the request files the engine writes beside them.
for (const f of readdirSync(out)) if (/\.mockup\.json$|\.filmstrip\.jpg$/.test(f)) rmSync(path.join(out, f));
console.log(`${n} images → ${path.relative(root, out)}`);
