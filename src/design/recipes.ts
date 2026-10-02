/**
 * Recipes: complete designs that adapt to your own screenshots. Each one is a composition that
 * works (the ones on Screenshotter's own site), built from your screens, your headline and your
 * app's colours, so a good-looking image is one click away. Available in the Studio's Designs
 * panel and to agents as the apply_recipe tool.
 */
import { readSidecar } from "../devices/resolve.js";
import { recognizeText } from "../native/ocr.js";
import { imageSize } from "../util/image.js";
import { resolveUserPath } from "../util/files.js";
import { screenshotPalette, type Palette } from "../render/analyze.js";
import type { BackgroundInput, DeviceInput, MockupInput } from "../render/schema.js";

export type ShotKind = "phone" | "tablet" | "duo" | "mac" | "web" | "watch" | "other";

export interface RecipeContext {
  shots: Array<{ path: string; video?: string; kind: ShotKind; width: number; height: number }>;
  palette?: Palette;
  /** Text lines on the first screen, top to bottom, positions as fractions of it. */
  lines: Array<{ text: string; x: number; y: number }>;
  headline?: string;
  subheadline?: string;
}

export interface Recipe {
  id: string;
  name: string;
  description: string;
  /** Screens it needs at least (the first one is reused when there are fewer). */
  screens: number;
  build(ctx: RecipeContext): MockupInput;
}

// ---------------------------------------------------------------------------------------------
// Colour

function hsl(hex: string): [number, number, number] {
  const n = parseInt(hex.replace("#", "").slice(0, 6), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => v / 255);
  const mx = Math.max(r, g, b);
  const mn = Math.min(r, g, b);
  const l = (mx + mn) / 2;
  if (mx === mn) return [0, 0, l];
  const d = mx - mn;
  const s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
  const h = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, s, l];
}

function hex([h, s, l]: [number, number, number]): string {
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return "#" + [f(0), f(8), f(4)].map((v) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, "0")).join("");
}

/** The app's accent at a given lightness and saturation (keeps its hue). */
export const tone = (accent: string, l: number, s?: number) => {
  const [h, sat] = hsl(accent);
  return hex([h, s ?? Math.max(0.25, sat), l]);
};

const isWarm = (accent?: string) => {
  if (!accent) return true;
  const [h, s] = hsl(accent);
  return s < 0.15 || h < 70 || h > 300;
};

/** A painting whose colours sit with the app's accent. */
export function paintingFor(accent?: string): string {
  if (!accent) return "misty-hills";
  const [h, s] = hsl(accent);
  if (s < 0.2) return "misty-hills";
  if (h < 20 || h >= 330) return "hollyhocks";
  if (h < 70) return "golden-sea";
  if (h < 165) return "monet-bridge";
  if (h < 250) return "great-wave";
  return "wisteria-plate";
}

// ---------------------------------------------------------------------------------------------
// Building blocks

export const CANVAS: Record<ShotKind, string> = { phone: "iphone-6.9", tablet: "ipad-13", duo: "ipad-13", mac: "16:9", web: "16:9", watch: "1080x1350", other: "4:5" };

export function device(shot: RecipeContext["shots"][number], extra: Partial<DeviceInput> = {}): DeviceInput {
  const d: DeviceInput = { screenshot: shot.path, ...extra };
  if (shot.video) d.video = shot.video;
  if (shot.kind === "web" && !extra.frame && !extra.device) d.device = "MacBook Pro 14-inch";
  return d;
}

/** The nth screen, reusing earlier ones when there are fewer. */
export const nth = (ctx: RecipeContext, i: number) => ctx.shots[i % ctx.shots.length];

/** The caption: the person's words, or a placeholder that asks to be replaced. */
const words = (ctx: RecipeContext, fallback: string) => ({ headline: ctx.headline ?? fallback, ...(ctx.subheadline ? { subheadline: ctx.subheadline } : {}) });

/** Accent colour for text: the app's accent, lightened on dark grounds and deepened on light ones. */
export const textAccent = (ctx: RecipeContext, dark: boolean) => (ctx.palette?.accent ? tone(ctx.palette.accent, dark ? 0.68 : 0.42, 0.75) : dark ? "#d2ff4d" : "#e0662a");

/** A phone over a painting: huge when it has the image to itself, a little lower when there's a headline. */
const overPainting = (ctx: RecipeContext): Partial<DeviceInput> =>
  ctx.headline ? { x: 0.5, y: 0.74, anchor: "center", height: 0.9 } : { x: 0.5, y: 0.66, anchor: "center", height: 0.98 };

/** The person's words over a painting: a serif in white, with a soft shadow to hold on any picture. */
function paintingWords(ctx: RecipeContext, phone: boolean): Partial<MockupInput> {
  if (!ctx.headline) return {};
  return {
    headline: ctx.headline,
    ...(ctx.subheadline ? { subheadline: ctx.subheadline } : {}),
    textStyle: { font: "Fraunces", headlineWeight: 600, headlineSize: phone ? 0.058 : 0.075, color: "#ffffff", accentItalic: true, shadow: true, ...(phone ? { y: 0.06, anchor: "top" as const } : {}) },
  };
}

/** A line worth pointing at: a real phrase in the middle of the screen. */
function focusLine(ctx: RecipeContext, offset = 0): string | undefined {
  const good = ctx.lines.filter((l) => l.y > 0.18 && l.y < 0.82 && l.text.trim().length >= 6 && /[a-z]/.test(l.text) && !/^\d/.test(l.text.trim()));
  return good[Math.min(good.length - 1, Math.floor(good.length * 0.35) + offset)]?.text.trim();
}

export const darkUI = (ctx: RecipeContext) => ctx.palette?.tone !== "light";

// ---------------------------------------------------------------------------------------------
// Recipes

export const RECIPES: Recipe[] = [
  {
    id: "bold-hero",
    name: "Bold hero",
    description: "A huge screen rising from the bottom over a glow in your app's colour, with big confident type.",
    screens: 1,
    build(ctx) {
      const s = nth(ctx, 0);
      const dark = darkUI(ctx);
      const a = ctx.palette?.accent;
      const background: BackgroundInput = a
        ? dark
          ? { type: "radial", colors: [tone(a, 0.3, 0.55), tone(a, 0.1, 0.4), "#050506"], x: 0.5, y: 0.28 }
          : { type: "radial", colors: [tone(a, 0.95, 0.5), tone(a, 0.86, 0.45)], x: 0.5, y: 0.25 }
        : dark
          ? "midnight"
          : "cream-grain";
      const phone = s.kind === "phone";
      return {
        canvas: CANVAS[s.kind],
        layout: phone ? "custom" : "hero",
        background,
        effects: { grain: 0.08, edgeBlur: phone },
        devices: [device(s, phone ? { x: 0.5, y: 0.72, anchor: "center", height: 0.92, shadow: dark ? "strong" : "studio" } : { shadow: dark ? "strong" : "studio" })],
        ...words(ctx, "Say what it does,\n**in a few words**"),
        textStyle: { font: "Inter Tight", headlineWeight: 700, headlineSize: phone ? 0.052 : 0.075, letterSpacing: -0.03, accentColor: textAccent(ctx, dark), color: dark ? "#ffffff" : "#101114" },
      };
    },
  },
  {
    id: "art-director",
    name: "Art director",
    description: "Editorial serif with an italic accent, a warm or deep studio backdrop, film grain.",
    screens: 1,
    build(ctx) {
      const s = nth(ctx, 0);
      const dark = darkUI(ctx);
      const warm = isWarm(ctx.palette?.accent);
      const phone = s.kind === "phone";
      return {
        canvas: CANVAS[s.kind],
        layout: phone ? "custom" : "hero",
        background: dark ? (warm ? "ember-glow" : "indigo-fade") : "cream-grain",
        effects: { grain: 0.1, ...(dark ? { vignette: 0.25 } : {}), edgeBlur: phone },
        devices: [device(s, phone ? { x: 0.5, y: 0.7, anchor: "center", height: 0.88, shadow: "strong" } : { shadow: "strong" })],
        ...words(ctx, "The whole story,\n**beautifully told.**"),
        textStyle: {
          font: "Fraunces",
          subheadlineFont: "Inter",
          headlineWeight: 600,
          headlineSize: phone ? 0.046 : 0.08,
          letterSpacing: -0.025,
          accentItalic: true,
          accentColor: dark ? (warm ? "#f5a85c" : "#b9b4ff") : textAccent(ctx, false),
          color: dark ? "#fbf3e8" : "#1d1a16",
        },
      };
    },
  },
  {
    id: "gallery",
    name: "In the gallery",
    description: "A public-domain painting in your app's colours behind a big screen.",
    screens: 1,
    build(ctx) {
      const s = nth(ctx, 0);
      const phone = s.kind === "phone";
      return {
        canvas: phone ? "1080x1350" : CANVAS[s.kind],
        layout: phone ? "custom" : ctx.headline ? "hero" : "floating",
        background: paintingFor(ctx.palette?.accent),
        effects: { edgeBlur: phone },
        devices: [device(s, phone ? overPainting(ctx) : {})],
        ...paintingWords(ctx, phone),
      };
    },
  },
  {
    id: "risograph",
    name: "Risograph print",
    description: "A painting reprinted in two inks, one of them your app's colour.",
    screens: 1,
    build(ctx) {
      const s = nth(ctx, 0);
      const phone = s.kind === "phone";
      const ink = ctx.palette?.accent ? tone(ctx.palette.accent, 0.58, 0.85) : "#ff4a9e";
      return {
        canvas: phone ? "1080x1350" : CANVAS[s.kind],
        layout: phone ? "custom" : ctx.headline ? "hero" : "floating",
        background: { look: paintingFor(ctx.palette?.accent), finish: { style: "risograph", colors: [ink, "#1f2a5c"] } },
        devices: [device(s, phone ? overPainting(ctx) : {})],
        ...paintingWords(ctx, phone),
      };
    },
  },
  {
    id: "tilted",
    name: "Tilted in 3D",
    description: "The screen turned toward the headline on a clean studio ground.",
    screens: 1,
    build(ctx) {
      const s = nth(ctx, 0);
      const dark = darkUI(ctx);
      return {
        canvas: CANVAS[s.kind],
        layout: "tilted",
        background: dark ? "graphite" : "studio-white",
        devices: [device(s, { shadow: "studio" })],
        ...words(ctx, "Built for\n**the way you work**"),
        textStyle: { font: "Inter Tight", headlineWeight: 700, headlineSize: s.kind === "phone" ? 0.05 : 0.075, letterSpacing: -0.03, accentColor: textAccent(ctx, dark) },
      };
    },
  },
  {
    id: "depth",
    name: "Depth of field",
    description: "A big screen softly out of focus behind a sharp phone.",
    screens: 1,
    build(ctx) {
      const phoneShot = ctx.shots.find((s) => s.kind === "phone") ?? nth(ctx, 0);
      const wideShot = ctx.shots.find((s) => s.kind === "mac" || s.kind === "web" || s.kind === "tablet");
      const back = wideShot
        ? device(wideShot, { ...(wideShot.kind === "tablet" ? {} : { device: "MacBook Pro 14-inch" }), x: 0.62, y: 0.6, anchor: "center", height: 1.2, blur: 0.006, z: 1 })
        : device(phoneShot, { x: 0.66, y: 0.56, anchor: "center", height: 1.45, rotate: 8, blur: 0.007, z: 1 });
      return {
        canvas: "16:9",
        layout: "custom",
        background: darkUI(ctx) ? "graphite" : "cream-grain",
        devices: [back, device(phoneShot, { x: 0.27, y: 0.7, anchor: "center", height: 1.02, rotate: -6, z: 5 })],
      };
    },
  },
  {
    id: "rising",
    name: "Rising pair",
    description: "Two screens stepping up, counter-rotated, running off the bottom.",
    screens: 2,
    build(ctx) {
      return {
        canvas: "iphone-6.9",
        layout: "rising",
        background: darkUI(ctx) ? "midnight" : "peach-glow",
        devices: [device(nth(ctx, 0)), device(nth(ctx, 1))],
        ...words(ctx, "From plan\n**to done**"),
        textStyle: { font: "Inter Tight", headlineWeight: 700, headlineSize: 0.05, letterSpacing: -0.03, accentColor: textAccent(ctx, darkUI(ctx)) },
      };
    },
  },
  {
    id: "staircase",
    name: "Staircase",
    description: "Screens stepping up to the right over a halftone-printed painting.",
    screens: 2,
    build(ctx) {
      return {
        canvas: "16:9",
        layout: "staircase",
        background: { look: paintingFor(ctx.palette?.accent), finish: "halftone" },
        devices: [0, 1, 2].slice(0, Math.max(2, Math.min(3, ctx.shots.length))).map((i) => device(nth(ctx, i))),
      };
    },
  },
  {
    id: "mosaic",
    name: "Mosaic",
    description: "Every screen side by side, for the last image of a set or a launch post.",
    screens: 3,
    build(ctx) {
      const n = Math.max(3, Math.min(6, ctx.shots.length));
      return {
        canvas: "16:9",
        layout: "grid",
        background: darkUI(ctx) ? "graphite" : "paper",
        devices: Array.from({ length: n }, (_, i) => device(nth(ctx, i))),
      };
    },
  },
  {
    id: "review",
    name: "Five-star review",
    description: "A review in big serif type under five stars, the reviewer's name beneath, your screen rising from the bottom. Put in a real review.",
    screens: 1,
    build(ctx) {
      const s = nth(ctx, 0);
      const dark = darkUI(ctx);
      const a = ctx.palette?.accent;
      const phone = s.kind === "phone";
      const gold = dark ? "#f4c04e" : "#e39a17";
      const background: BackgroundInput = a
        ? dark
          ? { type: "radial", colors: [tone(a, 0.2, 0.4), "#0a0a0c"], x: 0.5, y: 0.2 }
          : { type: "radial", colors: [tone(a, 0.97, 0.35), tone(a, 0.9, 0.3)], x: 0.5, y: 0.2 }
        : dark
          ? "midnight"
          : "cream-grain";
      return {
        canvas: CANVAS[s.kind],
        layout: "custom",
        background,
        effects: { grain: 0.06 },
        devices: [device(s, phone ? { x: 0.5, y: 0.84, anchor: "center", height: 0.7, shadow: dark ? "strong" : "studio" } : { x: 0.5, y: 0.76, anchor: "center", height: 0.52, shadow: "soft" })],
        shapes: [{ type: "rating", x: 0.5, y: phone ? 0.075 : 0.09, size: phone ? 0.03 : 0.045, aspect: 3.6, value: 5, fill: gold }],
        headline: ctx.headline ?? "“The only recipe app\nI **actually use**.”",
        subheadline: ctx.subheadline ?? "— Your reviewer, App Store",
        textStyle: {
          font: "Fraunces",
          headlineWeight: 600,
          headlineSize: phone ? 0.044 : 0.06,
          accentItalic: true,
          accentColor: textAccent(ctx, dark),
          color: dark ? "#ffffff" : "#15161a",
          x: 0.5,
          y: phone ? 0.115 : 0.15,
          anchor: "top",
          width: 0.84,
        },
      };
    },
  },
  {
    id: "award",
    name: "Award",
    description: "A laurel with your award and a row of stars above your headline and screen. Change the words to an award or rating you've really had.",
    screens: 1,
    build(ctx) {
      const s = nth(ctx, 0);
      const dark = darkUI(ctx);
      const a = ctx.palette?.accent;
      const phone = s.kind === "phone";
      const gold = dark ? "#e9c46a" : "#b8861c";
      const background: BackgroundInput = a
        ? dark
          ? { type: "radial", colors: [tone(a, 0.26, 0.5), tone(a, 0.08, 0.35), "#050506"], x: 0.5, y: 0.18 }
          : { type: "radial", colors: [tone(a, 0.96, 0.45), tone(a, 0.88, 0.4)], x: 0.5, y: 0.18 }
        : dark
          ? "midnight"
          : "cream-grain";
      return {
        canvas: CANVAS[s.kind],
        layout: "custom",
        background,
        effects: { grain: 0.06 },
        devices: [device(s, phone ? { x: 0.5, y: 0.81, anchor: "center", height: 0.66, shadow: dark ? "strong" : "studio" } : { x: 0.5, y: 0.75, anchor: "center", height: 0.5, shadow: "soft" })],
        shapes: [
          { type: "laurel", x: 0.5, y: phone ? 0.085 : 0.11, size: phone ? 0.075 : 0.11, aspect: 2.6, text: "App of the Day", fill: gold },
          { type: "rating", x: 0.5, y: phone ? 0.165 : 0.24, size: phone ? 0.034 : 0.05, aspect: 4.4, value: 5, text: "4.9 · 2K ratings", fill: gold },
        ],
        ...words(ctx, "Say what it does,\n**in a few words**"),
        textStyle: {
          font: "Inter Tight",
          headlineWeight: 700,
          headlineSize: phone ? 0.046 : 0.065,
          letterSpacing: -0.03,
          accentColor: textAccent(ctx, dark),
          color: dark ? "#ffffff" : "#101114",
          x: 0.5,
          y: phone ? 0.205 : 0.3,
          anchor: "top",
        },
      };
    },
  },
  {
    id: "callout",
    name: "Feature call-out",
    description: "One row lifted onto a card wider than the phone, with a headline that names it.",
    screens: 1,
    build(ctx) {
      const s = nth(ctx, 0);
      const line = focusLine(ctx);
      const dark = darkUI(ctx);
      return {
        canvas: s.kind === "phone" ? "1080x1350" : CANVAS[s.kind],
        layout: "custom",
        background: dark ? "coral-periwinkle" : "lavender-mist",
        devices: [device(s, { x: 0.5, y: 0.73, anchor: "center", height: 0.98, rotate: -4, ...(line ? { highlights: [{ style: "lift", text: line, breakout: 0.08 }] } : {}) })],
        ...words(ctx, "The one thing\n**worth showing**"),
        textStyle: { font: "Inter Tight", headlineWeight: 700, headlineSize: 0.05, letterSpacing: -0.03, color: "#15151a", accentColor: textAccent(ctx, false) },
      };
    },
  },
  {
    id: "how-to",
    name: "How-to",
    description: "Numbered steps and an arrow on the screen, with instructions beside it.",
    screens: 1,
    build(ctx) {
      const s = nth(ctx, 0);
      const first = focusLine(ctx, 0);
      const second = focusLine(ctx, 2) ?? focusLine(ctx, 1);
      const highlights: DeviceInput["highlights"] = [
        ...(first ? [{ style: "step" as const, text: first, at: "right" as const }] : []),
        ...(second && second !== first ? [{ style: "step" as const, text: second, at: "right" as const }, { style: "arrow" as const, text: second, offsetX: 170, offsetY: -110, bend: -0.3 }] : []),
      ];
      return {
        canvas: "16:9",
        layout: "custom",
        background: { colors: ["#f5f8ff", "#e1e9f8"], angle: 160 },
        devices: [device(s, { x: 0.68, y: 0.52, anchor: "center", height: 1.1, shadow: "studio", ...(highlights.length ? { highlights } : {}) })],
        headline: ctx.headline ?? "Here's how\n**it works**",
        ...(ctx.subheadline ? { subheadline: ctx.subheadline } : { subheadline: "Say what happens next in a sentence." }),
        textStyle: { font: "sf-pro", color: "#0b1220", accentColor: "#0a6cff", headlineSize: 0.07, subheadlineSize: 0.028, headlineWeight: 700, align: "left", x: 0.07, y: 0.52, anchor: "middle", width: 0.4, letterSpacing: -0.02 },
        texts: [{ text: "How to", x: 0.07, y: 0.33, align: "left", anchor: "bottom", size: 0.022, weight: 700, color: "#0a6cff", letterSpacing: 0.1, uppercase: true, background: "#d8e5ff" }],
      };
    },
  },
  {
    id: "dissolve",
    name: "Dissolve",
    description: "Two screens melting into the dark over an ember glow.",
    screens: 1,
    build(ctx) {
      return {
        canvas: "16:9",
        layout: "custom",
        background: isWarm(ctx.palette?.accent) ? "ember-glow" : "indigo-fade",
        effects: { grain: 0.1 },
        devices: [
          device(nth(ctx, 0), { x: 0.4, y: 0.62, anchor: "center", height: 0.95, fade: 0.45, z: 1 }),
          device(nth(ctx, 1), { x: 0.6, y: 0.7, anchor: "center", height: 0.95, fade: 0.45, z: 2 }),
        ],
      };
    },
  },
];

// ---------------------------------------------------------------------------------------------

function kindOf(file: string, size: { width: number; height: number }): ShotKind {
  const sidecar = readSidecar(file);
  const r = size.width / size.height;
  // iPhone Duo open: its 1878 × 2670 inner screen, upright or held like a book.
  const [a, b] = [Math.min(size.width, size.height), Math.max(size.width, size.height)];
  if (Math.abs(a / b - 1878 / 2670) < 0.012 && b >= 1300) return "duo";
  if (sidecar?.kind === "web" && r > 1.1) return "web";
  if (sidecar?.kind === "mac") return "mac";
  if (r > 1.1) return "mac";
  if (r > 0.78 && size.width < 700) return "watch";
  if (r > 0.6) return "tablet";
  return "phone";
}

/** What a recipe needs to know about the screens: their shape, the first one's colours and words. */
export async function recipeContext(devices: Array<{ screenshot: string; video?: string }>, words: { headline?: string; subheadline?: string } = {}): Promise<RecipeContext> {
  const shots = await Promise.all(
    devices.map(async (d) => {
      const file = resolveUserPath(d.screenshot);
      const size = await imageSize(file);
      return { path: file, video: d.video, kind: kindOf(file, size), ...size };
    }),
  );
  if (!shots.length) throw new Error("A recipe needs at least one screenshot.");
  const withTimeout = <T,>(p: Promise<T>, ms: number) => Promise.race([p, new Promise<undefined>((r) => setTimeout(() => r(undefined), ms))]);
  const [palette, boxes] = await Promise.all([
    // Quick once the browser and the text helper are running; the limits cover a cold start, since a
    // design without the app's own colours is a poor first impression.
    withTimeout(screenshotPalette(shots[0].path).catch(() => undefined), 20000),
    withTimeout(recognizeText(shots[0].path).catch(() => undefined), 12000),
  ]);
  const lines = (boxes ?? []).sort((a, b) => a.y - b.y).map((t) => ({ text: t.text, x: t.x / shots[0].width, y: t.y / shots[0].height }));
  return { shots, palette, lines, headline: words.headline || undefined, subheadline: words.subheadline || undefined };
}

export function findRecipe(id: string): Recipe {
  const r = RECIPES.find((x) => x.id === id);
  if (!r) throw new Error(`Unknown recipe "${id}". Recipes: ${RECIPES.map((x) => x.id).join(", ")}.`);
  return r;
}

export async function buildRecipe(id: string, devices: Array<{ screenshot: string; video?: string }>, words: { headline?: string; subheadline?: string } = {}): Promise<MockupInput> {
  return findRecipe(id).build(await recipeContext(devices, words));
}
