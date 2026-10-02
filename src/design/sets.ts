/**
 * Set templates: a whole App Store listing in one go. Each builds five screens (a hero, three
 * features and a closing proof or summary) from your screenshots in order (reused when there are
 * fewer), your app's colours and your words, with placeholders that ask to be replaced where you
 * have none. In the Studio's Templates panel (Whole sets) and to agents as apply_set_template.
 */
import type { BackgroundInput, DeviceInput, MockupInput } from "../render/schema.js";
import { CANVAS, darkUI, device, nth, paintingFor, recipeContext, textAccent, tone, type RecipeContext } from "./recipes.js";

/** What a set is built from: the screens' screenshots, the app's colours, and each screen's words. */
export interface SetContext extends RecipeContext {
  /** Each screen's words, in order: what the person has written so far. */
  words: Array<{ headline?: string; subheadline?: string }>;
}

export interface SetTemplate {
  id: string;
  name: string;
  description: string;
  build(ctx: SetContext): Array<{ name: string; scene: MockupInput }>;
}

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

const isPhone = (ctx: SetContext) => nth(ctx, 0).kind === "phone";

/** The device on a screen: a phone placed by hand under the headline; anything else laid out. */
function placed(ctx: SetContext, i: number, phone: Partial<DeviceInput>, other: Partial<DeviceInput> = {}): DeviceInput {
  const s = nth(ctx, i);
  return device(s, s.kind === "phone" ? { x: 0.5, y: 0.66, anchor: "center", height: 0.72, ...phone } : other);
}

/** Five screens of one look: `screen(i)` gives each its own parts. */
function fiveScreens(ctx: SetContext, base: Partial<MockupInput>, screen: (i: number) => Partial<MockupInput>): Array<{ name: string; scene: MockupInput }> {
  const s = nth(ctx, 0);
  return ROLES.map((role, i) => {
    const own = screen(i);
    const scene = {
      canvas: CANVAS[s.kind],
      layout: isPhone(ctx) ? "custom" : "hero",
      ...base,
      ...wordsFor(ctx, i),
      ...own,
      textStyle: { ...(base.textStyle ?? {}), ...(own.textStyle ?? {}) },
    } as MockupInput;
    return { name: role.name, scene };
  });
}

/** The headline at the top of a phone screen. */
const top = (ctx: SetContext, size = 0.05) => (isPhone(ctx) ? { x: 0.5, y: 0.06, anchor: "top" as const, headlineSize: size } : { headlineSize: size * 1.3 });

/** One backdrop laid across all five screens, each showing its slice. */
const across = (i: number) => ({ backgroundSpan: { count: ROLES.length, index: i } });

export const SET_TEMPLATES: SetTemplate[] = [
  {
    id: "clean",
    name: "Clean and bright",
    description: "Light grounds in your app's colour, upright phones, confident sans type, and a five-star close.",
    build(ctx) {
      const a = ctx.palette?.accent;
      const ground = (i: number): BackgroundInput =>
        a ? { type: "radial", colors: [tone(a, i % 2 ? 0.95 : 0.97, 0.45), tone(a, 0.88, 0.4)], x: 0.5, y: 0.2 } : "cream-grain";
      return fiveScreens(ctx, { effects: { grain: 0.04 }, textStyle: { font: "Inter Tight", headlineWeight: 700, letterSpacing: -0.03, color: "#101114", accentColor: textAccent(ctx, false), ...top(ctx) } }, (i) => ({
        background: ground(i),
        devices: [placed(ctx, i, { shadow: "studio" })],
        ...(i === 4 ? { shapes: [{ type: "rating", x: 0.5, y: 0.235, size: 0.03, aspect: 4.4, value: 5, text: "4.9 · 2K ratings", fill: "#e39a17" }] } : {}),
      }));
    },
  },
  {
    id: "bold",
    name: "Bold colour",
    description: "One saturated backdrop across the whole set, tilted phones, and one phone that runs from the second screen into the third.",
    build(ctx) {
      const a = ctx.palette?.accent ?? "#5b5bd6";
      const background: BackgroundInput = { type: "mesh", colors: [tone(a, 0.42, 0.75), tone(a, 0.55, 0.85), tone(a, 0.3, 0.7), tone(a, 0.62, 0.7)], meshStyle: "diagonal" };
      return fiveScreens(ctx, { background, effects: { grain: 0.06 }, textStyle: { font: "Inter Tight", headlineWeight: 800, letterSpacing: -0.035, color: "#ffffff", accentColor: tone(a, 0.88, 0.9), ...top(ctx, 0.054) } }, (i) => ({
        ...across(i),
        // The second screen's phone sits on its right edge, so it carries on into the third.
        devices: i === 2 ? [] : [placed(ctx, i, i === 1 ? { x: 1, y: 0.68, height: 0.74, rotate: -9, shadow: "strong" } : { rotate: i % 2 ? 6 : -6, shadow: "strong" })],
        ...(i === 2 ? { headline: ctx.words[2]?.headline || "Made for\n**both hands**", textStyle: { x: 0.62, y: 0.06, anchor: "top" as const, align: "center" as const, width: 0.7 } } : {}),
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
        images: [{ src: `sticker:${stickers[i]}`, sticker: true, x: i % 2 ? 0.16 : 0.84, y: 0.36, height: 0.085, rotate: i % 2 ? -10 : 10 }],
        ...(i === 0 ? { shapes: [{ type: "burst", text: "NEW", fill: "#ff3b30", labelColor: "#ffffff", x: 0.82, y: 0.6, size: 0.08, rotate: -10 }] } : {}),
      }));
    },
  },
  {
    id: "clay",
    name: "Clay studio",
    description: "Porcelain clay devices on warm paper, an editorial serif, calm and design-led.",
    build(ctx) {
      // A muted ground in the app's colour: porcelain clay needs something to stand out from.
      const a = ctx.palette?.accent;
      const background: BackgroundInput = a ? { type: "radial", colors: [tone(a, 0.86, 0.2), tone(a, 0.76, 0.18)], x: 0.5, y: 0.25 } : { type: "radial", colors: ["#d9d2c5", "#c2b8a6"], x: 0.5, y: 0.25 };
      return fiveScreens(ctx, { background, effects: { grain: 0.06 }, textStyle: { font: "Fraunces", headlineWeight: 600, color: "#22201c", accentItalic: true, accentColor: textAccent(ctx, false), ...top(ctx) } }, (i) => ({
        devices: [placed(ctx, i, { clay: i % 2 ? "sand" : "porcelain", shadow: "soft", rotate: i === 2 ? -4 : 0 }, { clay: "porcelain" })],
      }));
    },
  },
  {
    id: "gallery",
    name: "In the gallery",
    description: "Each screen over a painting that suits your app's colours, with white serif words.",
    build(ctx) {
      const painting = paintingFor(ctx.palette?.accent);
      const others = ["great-wave", "monet-bridge", "golden-sea", "misty-hills", "hollyhocks", "wisteria-plate"].filter((p) => p !== painting);
      const looks = [painting, ...others];
      return fiveScreens(ctx, { effects: { grain: 0.05 }, textStyle: { font: "Fraunces", headlineWeight: 600, color: "#ffffff", accentItalic: true, shadow: true, ...top(ctx, 0.056) } }, (i) => ({
        background: { look: looks[i % looks.length], dim: 0.12 },
        devices: [placed(ctx, i, { y: 0.7, height: 0.78, shadow: "studio" })],
      }));
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
