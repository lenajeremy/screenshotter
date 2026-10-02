/**
 * Set templates: a whole App Store listing in one go. Each builds five screens (a hero, three
 * features and a closing proof or summary) from your screenshots in order (reused when there are
 * fewer), your app's colours and your words, with placeholders that ask to be replaced where you
 * have none. Every template fits iPhone, iPad, iPhone Duo (open) and Mac screenshots: it takes the
 * App Store canvas for the first screenshot's kind and places the devices to suit; a few are made
 * for one kind. In the Studio's Templates panel (Whole sets) and to agents as apply_set_template.
 */
import type { BackgroundInput, DeviceInput, MockupInput } from "../render/schema.js";
import { device, paintingFor, recipeContext, textAccent, tone, type RecipeContext } from "./recipes.js";

/** What a set is built from: the screens' screenshots, the app's colours, and each screen's words. */
export interface SetContext extends RecipeContext {
  /** Each screen's words, in order: what the person has written so far. */
  words: Array<{ headline?: string; subheadline?: string }>;
}

/** The shape of screen a set is made for: iPhone Duo open is upright (duoTall) or held like a book (duoWide). */
export type Form = "phone" | "tablet" | "duoTall" | "duoWide" | "mac";

export interface SetTemplate {
  id: string;
  name: string;
  description: string;
  /** Made for these kinds of screenshot (it still fits the rest). Default: every kind. */
  forms?: Form[];
  build(ctx: SetContext): Array<{ name: string; scene: MockupInput }>;
}

type Shot = RecipeContext["shots"][number];

/** The five screens' jobs and their placeholder words, in store order. */
const ROLES = [
  { name: "Introduction", headline: "Say what it does,\n**in a few words**" },
  { name: "Feature", headline: "The **first thing**\nit does well" },
  { name: "Feature", headline: "**Another thing**\npeople love" },
  { name: "Feature", headline: "And **one more**\nreason" },
  { name: "Everything else", headline: "**Loved** by people\nlike you" },
];

/** A screen's words: the person's, else the role's placeholder. */
const wordsFor = (ctx: SetContext, i: number) => ({
  headline: ctx.words[i]?.headline || ROLES[i].headline,
  ...(ctx.words[i]?.subheadline ? { subheadline: ctx.words[i].subheadline } : {}),
});

const formOfShot = (s: Shot): Form =>
  s.kind === "duo" ? (s.width > s.height ? "duoWide" : "duoTall") : s.kind === "tablet" ? "tablet" : s.kind === "mac" || s.kind === "web" ? "mac" : "phone";

/** What the set is made for: its first screenshot's kind. */
export const formOf = (ctx: RecipeContext): Form => formOfShot(ctx.shots[0]);

/** Screen i's screenshot: those of the set's own kind in order, reused when there are fewer. */
function shotFor(ctx: SetContext, i: number): Shot {
  const same = ctx.shots.filter((s) => formOfShot(s) === formOf(ctx));
  const list = same.length ? same : ctx.shots;
  return list[i % list.length];
}

/** Each form's App Store canvas, and its size in pixels. */
const CANVAS: Record<Form, { canvas: string; landscape?: boolean; w: number; h: number }> = {
  phone: { canvas: "iphone-6.9", w: 1320, h: 2868 },
  tablet: { canvas: "ipad-13", w: 2064, h: 2752 },
  duoTall: { canvas: "ipad-13", w: 2064, h: 2752 },
  duoWide: { canvas: "ipad-13", landscape: true, w: 2752, h: 2064 },
  mac: { canvas: "mac", w: 2880, h: 1800 },
};

/**
 * Where the device sits under a headline, by form: its centre and height, and where its screen's top
 * corners are (half the screen's width, and the top's distance in from the device's top edge).
 */
const PLACE: Record<Form, { x: number; y: number; height: number; half: number; lid: number }> = {
  phone: { x: 0.5, y: 0.66, height: 0.72, half: 0.37, lid: 0.012 },
  tablet: { x: 0.5, y: 0.63, height: 0.64, half: 0.33, lid: 0.012 },
  duoTall: { x: 0.5, y: 0.63, height: 0.66, half: 0.32, lid: 0.012 },
  duoWide: { x: 0.5, y: 0.62, height: 0.64, half: 0.35, lid: 0.012 },
  mac: { x: 0.5, y: 0.62, height: 0.72, half: 0.29, lid: 0.03 },
};

const isPhone = (ctx: SetContext) => formOf(ctx) === "phone";
/** A landscape canvas (Mac, iPhone Duo held open like a book). */
const wide = (ctx: SetContext) => formOf(ctx) === "duoWide" || formOf(ctx) === "mac";

/**
 * The device on screen i. Overrides are written for a phone; on other devices the same idea is
 * scaled to fit: heights in proportion, turns softened, and nothing carried past an edge.
 */
function placed(ctx: SetContext, i: number, o: Partial<DeviceInput> = {}): DeviceInput {
  const form = formOf(ctx);
  const p = PLACE[form];
  const extra: Partial<DeviceInput> = { ...o };
  if (form !== "phone") {
    if (o.height !== undefined) extra.height = (o.height / PLACE.phone.height) * p.height;
    if (o.y !== undefined) extra.y = p.y + (o.y - PLACE.phone.y) * 0.8;
    if (typeof o.x === "number" && (o.x < 0.25 || o.x > 0.75)) delete extra.x;
    if (o.rotate) extra.rotate = o.rotate * 0.6;
    if (o.rotateY) extra.rotateY = o.rotateY * 0.6;
  }
  return device(shotFor(ctx, i), { x: p.x, y: p.y, anchor: "center", height: p.height, ...extra });
}

/** The headline at the top, sized for the canvas's shape. */
const top = (ctx: SetContext, size = 0.05) => {
  const k = { phone: 1, tablet: 1.04, duoTall: 1.04, duoWide: 1.32, mac: 1.38 }[formOf(ctx)];
  return { x: 0.5, y: wide(ctx) ? 0.065 : 0.06, anchor: "top" as const, headlineSize: size * k, width: wide(ctx) ? 0.7 : 0.86 };
};

/** Under the headline, above the device (canvas y). */
const underWords = (ctx: SetContext) => (wide(ctx) ? 0.27 : isPhone(ctx) ? 0.235 : 0.22);

/** An illustration (behind the devices and words unless z says otherwise). */
const art = (name: string, x: number, y: number, height: number, more: Record<string, unknown> = {}) => ({ src: `art:${name}`, x, y, height, z: 5, ...more });
/** A sticker, in front. */
const sticker = (name: string, x: number, y: number, height: number, rotate = 8) => ({ src: `sticker:${name}`, sticker: true, x, y, height, rotate });

/** Badges and stickers are sized for a phone; on bigger canvases they grow to match the words. */
const BADGE_SCALE: Record<Form, number> = { phone: 1, tablet: 1.15, duoTall: 1.15, duoWide: 1.4, mac: 1.45 };

/** Five screens of one look: `screen(i)` gives each its own parts. */
function fiveScreens(ctx: SetContext, base: Partial<MockupInput>, screen: (i: number) => Partial<MockupInput>): Array<{ name: string; scene: MockupInput }> {
  const { canvas, landscape } = CANVAS[formOf(ctx)];
  const k = BADGE_SCALE[formOf(ctx)];
  return ROLES.map((role, i) => {
    const own = screen(i);
    if (k !== 1) {
      own.shapes = own.shapes?.map((x) => (x.size ? { ...x, size: x.size * k } : x));
      own.images = own.images?.map((b) => (b.sticker ? { ...b, height: (b.height ?? 0.1) * k } : b));
    }
    const scene = {
      canvas,
      ...(landscape ? { landscape } : {}),
      layout: "custom",
      ...base,
      ...wordsFor(ctx, i),
      ...own,
      textStyle: { ...(base.textStyle ?? {}), ...(own.textStyle ?? {}) },
    } as MockupInput;
    return { name: role.name, scene };
  });
}

/** One backdrop laid across all five screens, each showing its slice. */
const across = (i: number) => ({ backgroundSpan: { count: ROLES.length, index: i } });

export const SET_TEMPLATES: SetTemplate[] = [
  {
    id: "clean",
    name: "Clean and bright",
    description: "Light grounds in your app's colour, upright devices, confident sans type, and a five-star close.",
    build(ctx) {
      const a = ctx.palette?.accent;
      const ground = (i: number): BackgroundInput => (a ? { type: "radial", colors: [tone(a, i % 2 ? 0.95 : 0.97, 0.45), tone(a, 0.88, 0.4)], x: 0.5, y: 0.2 } : "cream-grain");
      return fiveScreens(ctx, { effects: { grain: 0.04 }, textStyle: { font: "Inter Tight", headlineWeight: 700, letterSpacing: -0.03, color: "#101114", accentColor: textAccent(ctx, false), ...top(ctx) } }, (i) => ({
        background: ground(i),
        devices: [placed(ctx, i, { shadow: "studio" })],
        ...(i === 4 ? { shapes: [{ type: "rating", x: 0.5, y: underWords(ctx), size: 0.03, aspect: 4.4, value: 5, text: "4.9 · 2K ratings", fill: "#e39a17" }] } : {}),
      }));
    },
  },
  {
    id: "bold",
    name: "Bold colour",
    description: "One saturated backdrop across the whole set and tilted devices; on iPhone, a phone runs from the second screen into the third.",
    build(ctx) {
      const a = ctx.palette?.accent ?? "#5b5bd6";
      const background: BackgroundInput = { type: "mesh", colors: [tone(a, 0.42, 0.75), tone(a, 0.55, 0.85), tone(a, 0.3, 0.7), tone(a, 0.62, 0.7)], meshStyle: "diagonal" };
      const span = isPhone(ctx);
      return fiveScreens(ctx, { background, effects: { grain: 0.06 }, textStyle: { font: "Inter Tight", headlineWeight: 800, letterSpacing: -0.035, color: "#ffffff", accentColor: tone(a, 0.88, 0.9), ...top(ctx, 0.054) } }, (i) => ({
        ...across(i),
        // On iPhone the second screen's phone sits on its right edge, so it carries on into the third.
        devices: span && i === 2 ? [] : [placed(ctx, i, span && i === 1 ? { x: 1, y: 0.68, height: 0.74, rotate: -9, shadow: "strong" } : { rotate: i % 2 ? 6 : -6, shadow: "strong" })],
        ...(span && i === 2 ? { headline: ctx.words[2]?.headline || "Made for\n**both hands**", textStyle: { x: 0.62, y: 0.06, anchor: "top" as const, align: "center" as const, width: 0.7 } } : {}),
      }));
    },
  },
  {
    id: "dark",
    name: "Dark premium",
    description: "Deep studio grounds with one light, serif italic accents, film grain and a review to close.",
    build(ctx) {
      const a = ctx.palette?.accent;
      const background: BackgroundInput = a ? { type: "radial", colors: [tone(a, 0.2, 0.45), tone(a, 0.06, 0.3), "#050506"], x: 0.5, y: 0.22 } : "midnight";
      return fiveScreens(ctx, { background, effects: { grain: 0.1, vignette: 0.2 }, textStyle: { font: "Inter Tight", headlineWeight: 600, letterSpacing: -0.025, color: "#f5f5f7", accentFont: "Instrument Serif", accentItalic: true, accentWeight: 400, accentColor: textAccent(ctx, true), ...top(ctx) } }, (i) =>
        i === 4
          ? {
              headline: ctx.words[4]?.headline || "“The only app\nI **actually use**.”",
              subheadline: ctx.words[4]?.subheadline || "— Your reviewer, App Store",
              shapes: [{ type: "rating", x: 0.5, y: 0.045, size: 0.026, aspect: 3.6, value: 5, fill: "#f4c04e" }],
              textStyle: { font: "Fraunces", headlineWeight: 600, accentFont: undefined, y: 0.085 },
              devices: [placed(ctx, i, { y: 0.8, height: 0.66, shadow: "strong" })],
            }
          : { devices: [placed(ctx, i, { shadow: "strong", rotateY: i % 2 ? 12 : -12, rotateX: 4 })] },
      );
    },
  },
  {
    id: "playful",
    name: "Playful",
    description: "Bright pastel grounds, rounded type with a highlighter, stickers, and a NEW burst on the first screen.",
    build(ctx) {
      const grounds = ["coral-periwinkle", "peach-glow", "mint-sage", "lavender-mist", "peach"];
      const stickers = ["sparkles", "heart", "star", "bolt", "trophy"];
      return fiveScreens(ctx, { effects: { grain: 0.05 }, textStyle: { font: "Nunito", headlineWeight: 800, color: "#1d1d1f", accentMark: "highlight", accentColor: "#1d1d1f", accentMarkColor: "#ffd60a", ...top(ctx, 0.052) } }, (i) => ({
        background: grounds[i],
        devices: [placed(ctx, i, { rotate: i % 2 ? 5 : -5, shadow: "medium" })],
        images: [sticker(stickers[i], i % 2 ? 0.14 : 0.86, wide(ctx) ? 0.34 : 0.36, 0.085, i % 2 ? -10 : 10)],
        ...(i === 0 ? { shapes: [{ type: "burst", text: "NEW", fill: "#ff3b30", labelColor: "#ffffff", x: wide(ctx) ? 0.86 : 0.82, y: 0.6, size: 0.08, rotate: -10 }] } : {}),
      }));
    },
  },
  {
    id: "clay",
    name: "Clay studio",
    description: "Porcelain and sand clay devices on a muted ground in your app's colour, an editorial serif, calm and design-led.",
    build(ctx) {
      // A muted ground in the app's colour: porcelain clay needs something to stand out from.
      const a = ctx.palette?.accent;
      const background: BackgroundInput = a ? { type: "radial", colors: [tone(a, 0.86, 0.2), tone(a, 0.76, 0.18)], x: 0.5, y: 0.25 } : { type: "radial", colors: ["#d9d2c5", "#c2b8a6"], x: 0.5, y: 0.25 };
      return fiveScreens(ctx, { background, effects: { grain: 0.06 }, textStyle: { font: "Fraunces", headlineWeight: 600, color: "#22201c", accentItalic: true, accentColor: textAccent(ctx, false), ...top(ctx) } }, (i) => ({
        devices: [placed(ctx, i, { clay: i % 2 ? "sand" : "porcelain", shadow: "soft", rotate: i === 2 ? -4 : 0 })],
      }));
    },
  },
  {
    id: "gallery",
    name: "In the gallery",
    description: "Each screen over a painting that suits your app's colours, with white serif words.",
    build(ctx) {
      const painting = paintingFor(ctx.palette?.accent);
      const looks = [painting, ...["great-wave", "monet-bridge", "golden-sea", "misty-hills", "hollyhocks", "wisteria-plate"].filter((p) => p !== painting)];
      return fiveScreens(ctx, { effects: { grain: 0.05 }, textStyle: { font: "Fraunces", headlineWeight: 600, color: "#ffffff", accentItalic: true, shadow: true, ...top(ctx, 0.056) } }, (i) => ({
        background: { look: looks[i % looks.length], dim: 0.12 },
        devices: [placed(ctx, i, { y: 0.7, height: 0.78, shadow: "studio" })],
      }));
    },
  },
  {
    id: "scrapbook",
    name: "Scrapbook",
    description: "Warm paper, handwritten headlines, devices taped down with washi tape, doodled arrows and the odd sticker.",
    build(ctx) {
      const a = ctx.palette?.accent ?? "#e86a50";
      const tapes = ["#f4b8a6", "#a9dcc4", "#f7d774", "#bdb5f0", "#f4b8a6"];
      const doodles = ["arrow-swoosh", "stars-doodle", "hearts-doodle", "arrow-loop", "circle-scribble"];
      const p = PLACE[formOf(ctx)];
      return fiveScreens(ctx, { background: "#f3eadb", effects: { grain: 0.12 }, textStyle: { font: "Caveat", headlineWeight: 700, color: "#2b2622", accentColor: tone(a, 0.45, 0.7), accentMark: "squiggle", ...top(ctx, 0.068) } }, (i) => {
        const tilt = [-3, 3, -2, 4, -3][i];
        const corner = p.y - p.height / 2 + p.lid;
        return {
          devices: [placed(ctx, i, { rotate: tilt, shadow: "soft" })],
          images: [
            art("tape", p.x - p.half + 0.035, corner, 0.032, { rotate: -38, tint: tapes[i], opacity: 0.92, z: 20 }),
            art("tape", p.x + p.half - 0.035, corner, 0.032, { rotate: 36, tint: tapes[(i + 2) % 5], opacity: 0.92, z: 20 }),
            art(doodles[i], i % 2 ? 0.13 : 0.87, underWords(ctx) + 0.05, 0.07, { tint: "#2b2622", z: 25, flip: i % 2 === 1 }),
            ...(i === 0 || i === 3 ? [sticker(i ? "star" : "heart", i % 2 ? 0.88 : 0.12, 0.88, 0.07, i ? 12 : -12)] : []),
          ],
        };
      });
    },
  },
  {
    id: "memphis",
    name: "Memphis pop",
    description: "Sunny grounds, bold geometric shapes and squiggles behind tilted devices, and chunky type.",
    build(ctx) {
      const grounds = ["#ffe066", "#ffd6e0", "#c8f0e0", "#d7e3ff", "#ffe066"];
      const squiggles = ["#3db2ff", "#ff3d7f", "#5b5bd6", "#ff9f1c", "#34c759"];
      const ink = "#1d1d1f";
      return fiveScreens(ctx, { effects: { grain: 0.04 }, textStyle: { font: "Bricolage Grotesque", headlineWeight: 800, letterSpacing: -0.03, color: ink, accentColor: "#ff3d7f", ...top(ctx, 0.056) } }, (i) => ({
        background: grounds[i],
        devices: [placed(ctx, i, { rotate: [-7, 6, -5, 7, -6][i], shadow: "medium" })],
        images: [
          art("memphis", i % 2 ? 0.2 : 0.8, wide(ctx) ? 0.42 : 0.4, wide(ctx) ? 0.3 : 0.18, { rotate: i * 23 }),
          art("squiggle", i % 2 ? 0.8 : 0.2, wide(ctx) ? 0.86 : 0.9, 0.05, { tint: squiggles[i], rotate: -8 }),
          art("dots", i % 2 ? 0.86 : 0.14, wide(ctx) ? 0.7 : 0.62, wide(ctx) ? 0.16 : 0.1, { tint: ink, opacity: 0.55 }),
        ],
      }));
    },
  },
  {
    id: "notebook",
    name: "Doodle notebook",
    description: "Squared notebook paper, handwriting with a marker highlight, and blue-pen doodles pointing at your screens.",
    build(ctx) {
      // Squared paper in shares of the canvas, so the squares are the same in the Studio and the export.
      const { w, h } = CANVAS[formOf(ctx)];
      const cell = 1.9;
      const paper = `linear-gradient(rgba(64,104,170,.17) 6%, transparent 6%) 0 0 / 100% ${cell}%, linear-gradient(90deg, rgba(64,104,170,.17) 6%, transparent 6%) 0 0 / ${((cell * h) / w).toFixed(3)}% 100%, #fbfaf5`;
      const doodles: Array<[string, number, number, boolean]> = [
        ["arrow-loop", 0.15, 0.06, false],
        ["stars-doodle", 0.86, 0.04, false],
        ["arrow-swoosh", 0.86, 0.05, true],
        ["sparkles", 0.14, 0.04, false],
        ["hearts-doodle", 0.86, 0.04, false],
      ];
      return fiveScreens(ctx, { background: paper, effects: { grain: 0.05 }, textStyle: { font: "Caveat", headlineWeight: 700, color: "#22314d", accentColor: "#22314d", accentMark: "highlight", accentMarkColor: "#ffe14d", ...top(ctx, 0.068) } }, (i) => {
        const [name, x, dy, flip] = doodles[i];
        return {
          devices: [placed(ctx, i, { rotate: i % 2 ? 2 : -2, shadow: "soft" })],
          images: [
            art(name, x, underWords(ctx) + dy, 0.075, { tint: "#2f6fd6", z: 25, flip }),
            ...(i === 4 ? [art("underline", 0.5, underWords(ctx) - 0.01, 0.02, { tint: "#e2554f", z: 25 })] : []),
          ],
        };
      });
    },
  },
  {
    id: "garden",
    name: "Garden",
    description: "Soft blobs and leafy sprigs in your app's colour around upright devices, and a gentle serif: calm, for wellness and everyday apps.",
    build(ctx) {
      const a = ctx.palette?.accent ?? "#3fae73";
      // Leaves are always green; the blobs behind take the app's colour.
      const leaf = "#4f8a5b";
      const blob = tone(a, 0.85, 0.45);
      const blobs = ["blob-1", "blob-2", "blob-3", "blob-2", "blob-1"];
      const p = PLACE[formOf(ctx)];
      return fiveScreens(ctx, { background: tone(a, 0.95, 0.25), effects: { grain: 0.06 }, textStyle: { font: "Fraunces", headlineWeight: 600, color: "#1f2a24", accentItalic: true, accentColor: tone(a, 0.36, 0.6), ...top(ctx) } }, (i) => ({
        devices: [placed(ctx, i, { shadow: "soft" })],
        images: [
          art(blobs[i], i % 2 ? 0.42 : 0.58, p.y - 0.02, p.height * 0.8, { tint: blob, rotate: i * 40 }),
          // Sprigs growing out from behind the device, on alternating sides.
          art("leaf-sprig", i % 2 ? p.x + p.half - 0.01 : p.x - p.half + 0.01, p.y + p.height * 0.3, 0.24, { tint: leaf, rotate: i % 2 ? 14 : -14, flip: i % 2 === 1, z: 40 }),
          art("leaf-sprig", i % 2 ? p.x - p.half - 0.02 : p.x + p.half + 0.02, p.y - p.height * 0.28, 0.15, { tint: "#86b98a", rotate: i % 2 ? -160 : 160, flip: i % 2 === 0 }),
        ],
      }));
    },
  },
  {
    id: "party",
    name: "Confetti party",
    description: "Bold gradients and confetti everywhere, a party popper and trophy, laurels and a NEW burst: for a launch or a big update.",
    build(ctx) {
      const a = ctx.palette?.accent ?? "#a855f7";
      return fiveScreens(ctx, { effects: { grain: 0.05 }, textStyle: { font: "Bricolage Grotesque", headlineWeight: 800, letterSpacing: -0.03, color: "#ffffff", accentColor: "#ffe066", ...top(ctx, 0.054) } }, (i) => ({
        background: { type: "gradient", colors: [tone(a, 0.52 + (i % 2) * 0.06, 0.8), tone(a, 0.3, 0.75)], angle: 160 },
        // The last screen makes room for its award under the words.
        devices: [placed(ctx, i, i === 4 ? { y: 0.73, rotate: 0, shadow: "strong" } : { rotate: i % 2 ? 4 : -4, shadow: "strong" })],
        // Confetti bursting out from behind the device, clear of the words.
        images: [
          ...(i === 4 ? [] : [art("confetti-colour", 0.5, wide(ctx) ? 0.52 : 0.48, wide(ctx) ? 0.7 : 0.5, { rotate: i * 30, opacity: 0.95 })]),
          art("confetti-colour", 0.5, wide(ctx) ? 0.88 : 0.86, wide(ctx) ? 0.6 : 0.44, { rotate: i * 47 + 90, opacity: 0.9 }),
          ...(i === 1 ? [sticker("party", 0.86, underWords(ctx) + 0.12, 0.09, 12)] : i === 3 ? [sticker("trophy", 0.14, underWords(ctx) + 0.12, 0.09, -10)] : []),
        ],
        ...(i === 0 ? { shapes: [{ type: "burst", text: "NEW", fill: "#ffe066", labelColor: "#1d1d1f", x: wide(ctx) ? 0.86 : 0.84, y: 0.6, size: 0.085, rotate: 10 }] } : {}),
        ...(i === 4 ? { shapes: [{ type: "laurel", text: "App of the Day", fill: "#ffe066", x: 0.5, y: underWords(ctx) + (wide(ctx) ? 0.03 : 0.06), size: wide(ctx) ? 0.1 : 0.075, aspect: 2.6 }] } : {}),
      }));
    },
  },
  {
    id: "comic",
    name: "Comic pop",
    description: "Halftone colour, outlined comic lettering, speech bubbles and a POW burst: loud and fun.",
    build(ctx) {
      const grounds = ["#ffd23f", "#4dc9ff", "#ff5d73", "#7ee081", "#ffd23f"];
      const bubbles = ["So easy!", "Wow!", "No way!", "Love it!", "Yes!"];
      return fiveScreens(ctx, { textStyle: { font: "Bangers", headlineWeight: 400, letterSpacing: 0.02, color: "#ffffff", stroke: "#111111", strokeWidth: 0.12, accentColor: "#ffe14d", uppercase: true, ...top(ctx, 0.068) } }, (i) => ({
        background: { type: "solid", color: grounds[i], finish: { style: "halftone", scale: 0.7, amount: 0.45 } },
        devices: [placed(ctx, i, { rotate: i % 2 ? 6 : -6, shadow: "strong" })],
        shapes: [
          { type: "bubble", text: bubbles[i], fill: "#ffffff", labelColor: "#111111", stroke: "#111111", x: i % 2 ? 0.2 : 0.8, y: underWords(ctx) + 0.07, size: 0.065, aspect: 2.2, rotate: i % 2 ? -6 : 6 },
          ...(i === 0 ? [{ type: "burst" as const, text: "POW!", fill: "#ff3b30", labelColor: "#ffffff", x: 0.17, y: 0.8, size: 0.1, rotate: -12 }] : []),
        ],
      }));
    },
  },
  {
    id: "night",
    name: "Night sky",
    description: "A deep indigo sky across the set, full of stars, with a moon, a ringed planet, a rocket and clean modern type.",
    build(ctx) {
      const a = ctx.palette?.accent ?? "#8b7cf6";
      return fiveScreens(ctx, { background: { type: "radial", colors: [tone(a, 0.24, 0.55), "#0b0b1d", "#05050f"], x: 0.5, y: 0.25 }, effects: { grain: 0.05 }, textStyle: { font: "Space Grotesk", headlineWeight: 700, letterSpacing: -0.02, color: "#ffffff", accentColor: tone(a, 0.78, 0.9), ...top(ctx, 0.052) } }, (i) => ({
        ...across(i),
        devices: [placed(ctx, i, { shadow: "strong", rotate: i % 2 ? 3 : -3 })],
        images: [
          // On a wide canvas the sky fills it, behind the device, rather than sitting on the words.
          ...(wide(ctx)
            ? [art("stars-night", 0.5, 0.58, 0.84, { opacity: 0.85, flip: i % 2 === 1 })]
            : [art("stars-night", 0.5, 0.3, 0.3, { opacity: 0.9 }), art("stars-night", 0.5, 0.86, 0.28, { opacity: 0.7, flip: true, rotate: 180 })]),
          ...(i === 0 ? [art("moon-stars", 0.86, underWords(ctx) + 0.06, 0.09, { tint: "#ffe28a" })] : []),
          ...(i === 2 ? [art("planet", 0.15, underWords(ctx) + 0.07, 0.08, { tint: tone(a, 0.72, 0.8), rotate: -10 })] : []),
          ...(i === 4 ? [sticker("rocket", 0.86, underWords(ctx) + 0.08, 0.09, 10)] : []),
        ],
      }));
    },
  },
  {
    id: "desktop",
    name: "Desktop showcase",
    description: "For Mac apps: the MacBook large under the headline to open and close, and in between the words beside it, alternating sides.",
    forms: ["mac"],
    build(ctx) {
      const a = ctx.palette?.accent ?? "#5b5bd6";
      const dark = ctx.palette?.tone === "dark";
      const ground = (i: number): BackgroundInput => ({ type: "radial", colors: dark ? [tone(a, 0.24, 0.5), tone(a, 0.08, 0.35)] : [tone(a, 0.96, 0.5), tone(a, 0.86, 0.4)], x: i % 2 ? 0.25 : 0.75, y: 0.3 });
      return fiveScreens(ctx, { effects: { grain: 0.04 }, textStyle: { font: "Inter Tight", headlineWeight: 700, letterSpacing: -0.03, color: dark ? "#f5f5f7" : "#101114", accentColor: textAccent(ctx, dark) } }, (i) => {
        if (i === 0 || i === 4 || formOf(ctx) !== "mac") return { background: ground(i), devices: [placed(ctx, i, { y: 0.7, height: 0.8, shadow: "studio" })], textStyle: top(ctx, 0.055) };
        // Side by side: the words on one half, the MacBook on the other, running off its edge.
        const left = i % 2 === 1;
        return {
          background: ground(i),
          devices: [device(shotFor(ctx, i), { x: left ? 0.68 : 0.32, y: 0.54, anchor: "center", height: 0.8, shadow: "studio", span: false })],
          textStyle: { x: left ? 0.06 : 0.94, y: 0.5, anchor: "middle" as const, align: left ? ("left" as const) : ("right" as const), width: 0.3, headlineSize: 0.072 },
        };
      });
    },
  },
  {
    id: "tablet",
    name: "iPad spread",
    description: "For iPad apps (and iPhone Duo upright): big upright devices on calm tonal grounds, soft shapes behind, a gentle tilt.",
    forms: ["tablet", "duoTall"],
    build(ctx) {
      const a = ctx.palette?.accent ?? "#3fae73";
      const shapes = ["blob-1", "arch", "blob-2", "half-circle", "blob-3"];
      const p = PLACE[formOf(ctx)];
      return fiveScreens(ctx, { effects: { grain: 0.05 }, textStyle: { font: "Inter Tight", headlineWeight: 700, letterSpacing: -0.03, color: "#15161a", accentColor: textAccent(ctx, false), ...top(ctx) } }, (i) => ({
        background: { type: "radial", colors: [tone(a, 0.97, 0.3), tone(a, 0.91, 0.32)], x: 0.5, y: 0.2 },
        devices: [placed(ctx, i, { shadow: "studio", rotate: [0, -3, 3, -2, 0][i] })],
        images: [art(shapes[i], i % 2 ? p.x - p.half + 0.02 : p.x + p.half - 0.02, p.y + p.height * 0.18, p.height * 0.55, { tint: tone(a, 0.82, 0.5), rotate: i * 25 })],
      }));
    },
  },
  {
    id: "duo",
    name: "iPhone Duo showcase",
    description: "For apps on iPhone Duo: the open Duo held wide and upright side by side, close up and turned, on deep gradients.",
    forms: ["duoWide", "duoTall"],
    build(ctx) {
      const a = ctx.palette?.accent ?? "#4ade9b";
      const of = (want: Form) => ctx.shots.filter((s) => formOfShot(s) === want);
      const wideShots = of("duoWide");
      const tallShots = of("duoTall");
      const pick = (list: Shot[], i: number) => list[i % list.length] ?? shotFor(ctx, i);
      // Duo screenshots in the open Duo; anything else keeps its own device.
      const open = (s: Shot, o: Partial<DeviceInput>) => device(s, { ...(s.kind === "duo" ? { device: "iPhone Duo (open)" } : {}), anchor: "center", shadow: "studio", span: false, ...o });
      const W = wide(ctx);
      return fiveScreens(ctx, { background: { type: "radial", colors: [tone(a, 0.3, 0.55), tone(a, 0.1, 0.4), "#060708"], x: 0.5, y: 0.3 }, effects: { grain: 0.06 }, textStyle: { font: "Inter Tight", headlineWeight: 700, letterSpacing: -0.03, color: "#ffffff", accentColor: tone(a, 0.75, 0.85), ...top(ctx, 0.05) } }, (i) => {
        // Both ways at once: held like a book in front, upright behind.
        if (i === 2 && wideShots.length && tallShots.length)
          return {
            devices: W
              ? [open(pick(tallShots, i), { x: 0.72, y: 0.6, height: 0.66, rotate: 5, z: 1 }), open(pick(wideShots, i), { x: 0.38, y: 0.66, height: 0.5, rotate: -4, z: 2 })]
              : [open(pick(tallShots, i), { x: 0.64, y: 0.58, height: 0.5, rotate: 5, z: 1 }), open(pick(wideShots, i), { x: 0.42, y: 0.72, height: 0.3, rotate: -4, z: 2 })],
          };
        const own = formOf(ctx) === "duoWide" ? pick(wideShots, i) : pick(tallShots, i);
        const p = PLACE[formOf(ctx)];
        if (i === 4) return { devices: [open(own, { x: 0.5, y: p.y + 0.02, height: p.height * 0.98, rotateY: -16, rotateX: 6 })] };
        return { devices: [open(own, { x: 0.5, y: p.y, height: p.height, rotate: i === 0 ? 0 : i % 2 ? 3 : -3 })] };
      });
    },
  },
];

export function findSetTemplate(id: string): SetTemplate {
  const t = SET_TEMPLATES.find((x) => x.id === id);
  if (!t) throw new Error(`Unknown set template "${id}". Set templates: ${SET_TEMPLATES.map((x) => x.id).join(", ")}.`);
  return t;
}

/** Build a whole set from screenshots (in order) and each screen's words. */
export async function buildSetTemplate(id: string, devices: Array<{ screenshot: string; video?: string }>, words: SetContext["words"] = []) {
  const ctx = await recipeContext(devices, words[0] ?? {});
  return findSetTemplate(id).build({ ...ctx, words });
}

/** The form a set of screenshots makes (the first one's), so the templates made for it can come first. */
export async function formOfShots(devices: Array<{ screenshot: string }>): Promise<Form | undefined> {
  if (!devices.length) return undefined;
  return formOf(await recipeContext(devices.slice(0, 1), {}));
}

/**
 * Each screen as it renders on its own: with the devices of the screens either side that reach past
 * their edge (one screen over), as the Studio carries them across. For previews and agents.
 */
export function withSpill(screens: Array<{ name: string; scene: MockupInput }>): Array<{ name: string; scene: MockupInput }> {
  return screens.map((x, i) => {
    const spill = [i - 1, i + 1].flatMap((j) =>
      (screens[j]?.scene.devices ?? []).filter((d) => d.span !== false && typeof d.x === "number" && (d.x <= 0.2 || d.x >= 0.8)).map((d) => ({ ...d, x: (d.x as number) + (j - i) })),
    );
    return spill.length ? { ...x, scene: { ...x.scene, spill } } : x;
  });
}
