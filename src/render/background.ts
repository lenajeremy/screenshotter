import { pathToFileURL } from "node:url";
import { LOOKS, findLook, type Look } from "./looks.js";
import { generateImage, madeImage, pendingImage, resolvePhoto, type Photo } from "./photos.js";
import type { BackgroundInput, BackgroundObject, EffectsInput } from "./schema.js";

export const px = (n: number) => `${Math.round(n * 100) / 100}px`;
export const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// ---------------------------------------------------------------------------------------------
// Colour helpers

export function parseColor(input: string | undefined): [number, number, number] | undefined {
  if (!input) return undefined;
  const s = input.trim();
  const hex = /#([0-9a-f]{3,8})\b/i.exec(s)?.[1];
  if (hex) {
    const full = hex.length <= 4 ? hex.split("").map((ch) => ch + ch).join("") : hex;
    return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16)) as [number, number, number];
  }
  const rgb = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/i.exec(s);
  if (rgb) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])];
  const named: Record<string, [number, number, number]> = { white: [255, 255, 255], black: [0, 0, 0] };
  return named[s.toLowerCase()];
}

export function luminance(color: string | undefined): number | undefined {
  const c = parseColor(color);
  if (!c) return undefined;
  const lin = (v: number) => {
    const x = v / 255;
    return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
}

/** Deterministic pseudo-random numbers so a seed always gives the same mesh. */
function rng(seed: number) {
  let a = seed >>> 0 || 1;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------------------------

export interface ResolvedBackground {
  /** Layers placed inside the background group. */
  html: string;
  /** SVG <filter> definitions the layers reference. */
  defs: string;
  tone: "light" | "dark";
  /** Representative colour (auto shadows, text contrast). */
  color?: string;
  credits: string[];
  /** Effects the look brings along (user effects override these). */
  lookEffects: NonNullable<EffectsInput>;
  transparent: boolean;
  lookName?: string;
}

let filterCounter = 0;

// CSS named colours, so a single word can be told apart from a (mistyped) look name.
const CSS_NAMED_COLORS = new Set(
  (
    "aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown burlywood cadetblue " +
    "chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan darkgoldenrod darkgray darkgreen darkgrey " +
    "darkkhaki darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen darkslateblue darkslategray " +
    "darkslategrey darkturquoise darkviolet deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite forestgreen " +
    "fuchsia gainsboro ghostwhite gold goldenrod gray green greenyellow grey honeydew hotpink indianred indigo ivory khaki " +
    "lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan lightgoldenrodyellow lightgray lightgreen " +
    "lightgrey lightpink lightsalmon lightseagreen lightskyblue lightslategray lightslategrey lightsteelblue lightyellow lime " +
    "limegreen linen magenta maroon mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue " +
    "mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream mistyrose moccasin navajowhite navy oldlace olive " +
    "olivedrab orange orangered orchid palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum " +
    "powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown seagreen seashell sienna silver skyblue " +
    "slateblue slategray slategrey snow springgreen steelblue tan teal thistle tomato turquoise violet wheat white whitesmoke " +
    "yellow yellowgreen transparent"
  ).split(" "),
);

const looksLikeCss = (s: string) =>
  /^#[0-9a-f]{3,8}$/i.test(s) ||
  /^(rgba?|hsla?|hwb|lab|lch|oklab|oklch|color|color-mix|var)\(/i.test(s) ||
  /gradient\(|url\(/i.test(s) ||
  CSS_NAMED_COLORS.has(s.toLowerCase());

function unknownLook(name: string): Error {
  const n = name.toLowerCase().trim();
  const close = LOOKS.map((l) => l.name).filter((l) => l.includes(n) || n.includes(l) || l.split("-")[0] === n.split("-")[0]);
  const hint = close.length ? ` Did you mean ${close.map((c) => `"${c}"`).join(" or ")}?` : "";
  return new Error(`Unknown look "${name}".${hint} Looks: ${LOOKS.map((l) => l.name).join(", ")}. Or pass a CSS colour or gradient.`);
}

/**
 * Turn any background input into one object. `look` is the named preset (its effects and name
 * still apply); `source` is set only when that look also supplies the image, so its tone,
 * colour and offline fallback describe what's actually on screen.
 */
function normalize(input: BackgroundInput | undefined): { bg: BackgroundObject; look?: Look; source?: Look } {
  if (input === undefined) return normalize("midnight");
  if (typeof input === "string") {
    const s = input.trim();
    const look = findLook(s);
    if (look) return { bg: { ...look.background }, look, source: look };
    if (!looksLikeCss(s)) throw unknownLook(s);
    return { bg: { type: "solid", color: s } };
  }
  if (input.look) {
    const look = findLook(input.look);
    if (!look) throw unknownLook(input.look);
    const { look: _ignored, ...rest } = input;
    const overrides = Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined));
    // A new image source replaces the look's own source (photo or gradient) rather than mixing.
    const newSource = Boolean(overrides.photo || overrides.unsplash || overrides.generate || overrides.colors || overrides.color || overrides.type);
    const base = newSource ? { ...look.background, photo: undefined, type: undefined, colors: undefined, color: undefined } : look.background;
    return { bg: { ...base, ...overrides }, look, source: newSource ? undefined : look };
  }
  return { bg: input };
}

/** Light or dark, judged without loading anything (for layout-only requests). */
export function quickTone(input: BackgroundInput | undefined): "light" | "dark" | undefined {
  const { bg, source } = normalize(input);
  if (source) return source.tone;
  const colors = bg.colors ?? (bg.color ? [bg.color] : []);
  const ls = colors.map((c) => luminance(c)).filter((l): l is number => l !== undefined);
  if (!ls.length) return undefined;
  return ls.reduce((a, b) => a + b, 0) / ls.length > 0.42 ? "light" : "dark";
}

function inferType(bg: BackgroundObject): NonNullable<BackgroundObject["type"]> {
  if (bg.type) return bg.type;
  if (bg.photo || bg.unsplash || bg.generate) return "photo";
  if (bg.colors?.length) return "gradient";
  return "solid";
}

function meshHtml(bg: BackgroundObject): string {
  const [base, ...glows] = bg.colors?.length ? bg.colors : ["#0b1020", "#3b3bb3", "#7c3aed", "#0ea5e9"];
  const rand = rng(bg.seed ?? 7);
  const jitter = (v: number, amt = 10) => v + (bg.seed === undefined ? 0 : (rand() - 0.5) * amt * 2);
  const style = bg.meshStyle ?? "field";
  let layers: string[];
  switch (style) {
    case "orbs": {
      const spots = [[25, 22], [78, 40], [35, 78], [80, 92]];
      layers = glows.map((c, i) => {
        const [x, y] = spots[i % spots.length];
        return `radial-gradient(circle at ${jitter(x)}% ${jitter(y)}%, ${esc(c)} 0%, ${esc(c)} 18%, transparent 46%)`;
      });
      break;
    }
    case "aurora": {
      layers = glows.map((c, i) => {
        const y = 18 + i * 22;
        return `radial-gradient(ellipse 120% 22% at ${jitter(30 + i * 20)}% ${jitter(y)}%, ${esc(c)} 0%, transparent 70%)`;
      });
      return `<div class="bg" style="background:${esc(base)}"><div style="position:absolute;inset:-25%;transform:rotate(-18deg);filter:blur(24px);background:${layers.join(", ")}"></div></div>`;
    }
    case "corner": {
      const spots = [[0, 0], [100, 0], [100, 100], [0, 100]];
      layers = glows.map((c, i) => {
        const [x, y] = spots[i % spots.length];
        return `radial-gradient(ellipse 80% 60% at ${jitter(x, 6)}% ${jitter(y, 6)}%, ${esc(c)} 0%, transparent 70%)`;
      });
      break;
    }
    case "diagonal": {
      layers = [
        ...glows.slice(1).map((c, i) => `radial-gradient(ellipse 70% 50% at ${jitter(70 - i * 30)}% ${jitter(30 + i * 40)}%, ${esc(c)} 0%, transparent 70%)`),
        `linear-gradient(${bg.angle ?? 150}deg, ${esc(base)} 0%, ${esc(glows[0] ?? base)} 100%)`,
      ];
      return `<div class="bg" style="background:${layers.join(", ")}"></div>`;
    }
    default: {
      const spots = [[18, 12], [86, 22], [12, 72], [82, 88], [50, 45], [30, 100]];
      layers = glows.map((c, i) => {
        const [x, y] = spots[i % spots.length];
        return `radial-gradient(ellipse 70% 55% at ${jitter(x)}% ${jitter(y)}%, ${esc(c)} 0%, transparent 70%)`;
      });
    }
  }
  return `<div class="bg" style="background:${[...layers, esc(base)].join(", ")}"></div>`;
}

/** A photo filling the canvas, with every treatment the background object asks for. */
function photoHtml(src: string, bg: BackgroundObject, W: number, H: number): { html: string; defs: string } {
  const url = esc(pathToFileURL(src).href);
  const fx = (bg.focusX ?? 0.5) * 100;
  const fy = (bg.focusY ?? 0.5) * 100;
  const zoom = Math.max(1, bg.zoom ?? 1);
  // Values up to 0.5 are fractions of the canvas width; larger values are pixels.
  const toPx = (v: number | undefined) => (v === undefined || v <= 0 ? 0 : v <= 0.5 ? v * W : v);
  const motion = toPx(bg.motionBlur) / 2;
  const blur = toPx(bg.blur) / 2;
  const angle = bg.motionAngle ?? 0;
  const rad = (Math.abs(angle) * Math.PI) / 180;
  // Scale up so rotation and blur never reveal the edges.
  const cover = motion ? Math.cos(rad) + Math.sin(rad) * Math.max(W / H, H / W) : 1;
  const margin = 1 + (6 * Math.max(motion, blur)) / Math.min(W, H);
  const scale = Math.max(cover, 1) * margin;

  let defs = "";
  const cssFilters: string[] = [];
  if (motion) {
    const id = `mb${++filterCounter}`;
    defs += `<filter id="${id}" x="-20%" y="-20%" width="140%" height="140%" color-interpolation-filters="sRGB"><feGaussianBlur stdDeviation="${motion.toFixed(1)} 0" edgeMode="duplicate"/></filter>`;
    cssFilters.push(`url(#${id})`);
  }
  if (blur) cssFilters.push(`blur(${px(blur)})`);
  if (bg.brightness !== undefined) cssFilters.push(`brightness(${bg.brightness})`);
  if (bg.contrast !== undefined) cssFilters.push(`contrast(${bg.contrast})`);
  if (bg.saturation !== undefined) cssFilters.push(`saturate(${bg.saturation})`);

  const img = (extraFilter = "", extraStyle = "") =>
    `<div style="position:absolute;inset:0;transform:rotate(${angle}deg) scale(${scale.toFixed(4)});${cssFilters.length || extraFilter ? `filter:${[...cssFilters, extraFilter].filter(Boolean).join(" ")};` : ""}${extraStyle}">` +
    `<div style="position:absolute;inset:0;transform:rotate(${-angle}deg)">` +
    `<img src="${url}" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover;object-position:${fx}% ${fy}%;transform:scale(${zoom});transform-origin:${fx}% ${fy}%">` +
    `</div></div>`;

  let html = `<div class="bg" style="background:#777">${img()}</div>`;

  // Bloom and halation: blurred copies of only the highlights, screened back on top.
  const glow = (amount: number, color: string, radius: number) => {
    const id = `gl${++filterCounter}`;
    const c = parseColor(color) ?? [255, 255, 255];
    const [r, g, b] = c.map((v) => (v / 255).toFixed(3));
    defs +=
      `<filter id="${id}" x="-10%" y="-10%" width="120%" height="120%" color-interpolation-filters="sRGB">` +
      `<feColorMatrix type="matrix" values="0.3 0.59 0.11 0 0 0.3 0.59 0.11 0 0 0.3 0.59 0.11 0 0 0 0 0 1 0"/>` +
      `<feComponentTransfer><feFuncR type="linear" slope="4" intercept="-2.9"/><feFuncG type="linear" slope="4" intercept="-2.9"/><feFuncB type="linear" slope="4" intercept="-2.9"/></feComponentTransfer>` +
      `<feColorMatrix type="matrix" values="${r} 0 0 0 0 0 ${g} 0 0 0 0 0 ${b} 0 0 0 0 0 1 0"/>` +
      `<feGaussianBlur stdDeviation="${radius.toFixed(1)}"/></filter>`;
    html += `<div class="bg" style="mix-blend-mode:screen;opacity:${Math.min(1, amount * 1.4)}">${img(`url(#${id})`)}</div>`;
  };
  if (bg.bloom) glow(bg.bloom, "#ffffff", W * 0.02);
  if (bg.halation) glow(bg.halation, bg.halationColor ?? "#ff7a3d", W * 0.006);

  if (bg.tint) {
    html += `<div class="bg" style="background:${esc(bg.tint)};opacity:${bg.tintAmount ?? 0.15}"></div>`;
  }
  if (bg.haze) {
    const c = esc(bg.hazeColor ?? "#f3eed2");
    html += `<div class="bg" style="background:linear-gradient(180deg, ${c} 0%, color-mix(in oklab, ${c} 55%, transparent) 100%);opacity:${(bg.haze * 0.55).toFixed(3)}"></div>`;
  }
  if (bg.dim) html += `<div class="bg" style="background:#000;opacity:${bg.dim}"></div>`;
  return { html, defs };
}

/** The AI image options of a backdrop that uses one. */
function generateOptions(bg: BackgroundInput | undefined) {
  if (!bg || typeof bg !== "object" || !bg.generate) return undefined;
  const g = typeof bg.generate === "string" ? { prompt: bg.generate } : bg.generate;
  return { ...g, seed: bg.seed };
}

/** For an AI backdrop whose image isn't made yet: who will make it, and from what prompt. */
export function pendingBackdrop(bg: BackgroundInput | undefined, W: number, H: number): { provider: string; prompt: string } | undefined {
  const g = generateOptions(bg);
  const pending = g && pendingImage(g, W, H);
  return pending && g ? { provider: pending.provider, prompt: g.prompt } : undefined;
}

/** An AI backdrop's image if it's made (or being made: then wait). Never starts one. */
export async function madeBackdrop(bg: BackgroundInput | undefined, W: number, H: number): Promise<string | undefined> {
  const g = generateOptions(bg);
  return g ? madeImage(g, W, H) : undefined;
}

async function photoSource(bg: BackgroundObject, W: number, H: number, firstScreenshot: string | undefined, type: string): Promise<Photo> {
  if (type === "blur") {
    const path = bg.screenshot ?? firstScreenshot;
    if (!path) throw new Error("A blurred-screenshot backdrop needs a screenshot: this screen has none.");
    return { path };
  }
  if (bg.generate) {
    const g = typeof bg.generate === "string" ? { prompt: bg.generate } : bg.generate;
    return generateImage({ ...g, seed: bg.seed }, W, H);
  }
  if (bg.unsplash) return resolvePhoto(`unsplash:search:${bg.unsplash}`, { width: W, height: H }, bg.seed ?? 0);
  return resolvePhoto(bg.photo!, { width: W, height: H }, bg.seed ?? 0);
}

export async function resolveBackground(
  input: BackgroundInput | undefined,
  W: number,
  H: number,
  firstScreenshot: string | undefined,
  warnings: string[],
  averageColor: (file: string) => Promise<string | undefined>,
): Promise<ResolvedBackground> {
  const { bg, look: preset, source: look } = normalize(input);
  const type = inferType(bg);
  const lookEffects = preset?.effects ?? {};
  const base = { lookEffects, credits: [] as string[], defs: "", transparent: false, lookName: preset?.name };

  const toneFrom = (color: string | undefined, fallback: "light" | "dark" = "dark") => {
    const l = luminance(color);
    return l === undefined ? fallback : l > 0.42 ? "light" : "dark";
  };
  const avg = (colors: string[]) => {
    const ls = colors.map(luminance).filter((l): l is number => l !== undefined);
    return ls.length ? ls.reduce((a, b) => a + b, 0) / ls.length : undefined;
  };

  switch (type) {
    case "transparent":
      return { ...base, html: "", tone: look?.tone ?? "light", transparent: true };
    case "solid": {
      const color = bg.color ?? "#111";
      // Anything that isn't a plain colour (gradients, url(...)) is passed through as CSS.
      return { ...base, html: `<div class="bg" style="background:${esc(color)}"></div>`, tone: look?.tone ?? toneFrom(color), color: parseColor(color) ? color : undefined };
    }
    case "gradient": {
      const colors = bg.colors ?? ["#1e293b", "#0f172a"];
      const l = avg(colors);
      return {
        ...base,
        html: `<div class="bg" style="background:linear-gradient(${bg.angle ?? 160}deg, ${esc(colors.join(", "))})"></div>`,
        tone: look?.tone ?? (l !== undefined && l > 0.42 ? "light" : "dark"),
        color: colors[0],
      };
    }
    case "radial": {
      const colors = bg.colors?.length === 1 ? [bg.colors[0], bg.colors[0]] : (bg.colors ?? ["#333", "#111"]);
      const l = avg(colors);
      return {
        ...base,
        html: `<div class="bg" style="background:radial-gradient(circle at ${(bg.x ?? 0.5) * 100}% ${(bg.y ?? 0.3) * 100}%, ${esc(colors.join(", "))})"></div>`,
        tone: look?.tone ?? (l !== undefined && l > 0.42 ? "light" : "dark"),
        color: colors[colors.length - 1].split(" ")[0],
      };
    }
    case "mesh": {
      const colors = bg.colors ?? [];
      return { ...base, html: meshHtml(bg), tone: look?.tone ?? toneFrom(colors[0]), color: colors[0] ?? look?.color };
    }
    case "photo":
    case "blur": {
      let photo: Photo;
      try {
        photo = await photoSource(bg, W, H, firstScreenshot, type);
      } catch (e) {
        if (look?.fallback) {
          warnings.push(`Couldn't load the "${look.name}" photo (${(e as Error).message}); used its offline gradient instead.`);
          return { ...base, html: meshHtml(look.fallback), tone: look.tone, color: look.color };
        }
        throw e;
      }
      const treated: BackgroundObject =
        type === "blur"
          ? { blur: bg.blur ?? 0.035, saturation: bg.saturation ?? 1.4, dim: bg.dim ?? 0.2, ...bg, photo: undefined }
          : bg;
      const { html, defs } = photoHtml(photo.path, treated, W, H);
      const color = look?.color ?? photo.color ?? (await averageColor(photo.path));
      let tone = look?.tone ?? toneFrom(color);
      if (treated.dim && treated.dim > 0.35) tone = "dark";
      if (treated.haze && treated.haze > 0.6) tone = "light";
      return { ...base, html, defs, tone, color, credits: photo.credit ? [photo.credit] : [] };
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Effects

type Effects = NonNullable<EffectsInput>;

export function grainHtml(grain: Effects["grain"], z: number): string {
  if (!grain) return "";
  const g = typeof grain === "number" ? { amount: grain } : grain;
  if (!g.amount) return "";
  const size = 220 * (g.size ?? 1);
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='${size}' height='${size}'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='${(0.9 / (g.size ?? 1)).toFixed(3)}' numOctaves='3' stitchTiles='stitch'/><feColorMatrix values='0 0 0 0 .5 0 0 0 0 .5 0 0 0 0 .5 0 0 0 1 0'/></filter><rect width='100%' height='100%' filter='url(%23n)'/></svg>`;
  return `<div class="bg grain" style="z-index:${z};opacity:${Math.min(1, g.amount * 0.9).toFixed(3)};mix-blend-mode:overlay;background-size:${size}px ${size}px;background-image:url(&quot;data:image/svg+xml;utf8,${svg}&quot;)"></div>`;
}

export function vignetteHtml(v: Effects["vignette"]): string {
  if (!v) return "";
  const o = typeof v === "number" ? { amount: v } : v;
  if (!o.amount) return "";
  const shape = (o.roundness ?? 0) > 0.5 ? "circle" : "ellipse";
  return `<div class="bg" style="z-index:2;background:radial-gradient(${shape} at 50% 48%, transparent ${Math.round(58 - o.amount * 18)}%, rgba(0,0,0,${(o.amount * 0.7).toFixed(3)}) 100%)"></div>`;
}

/** Progressive blur bands along the top and/or bottom edges. */
export function edgeBlurHtml(edges: Array<"top" | "bottom">, extent: number, amount: number, W: number, H: number): string {
  return edges
    .map((edge) => {
      const h = extent * H;
      const dir = edge === "bottom" ? "to top" : "to bottom";
      const pos = edge === "bottom" ? `bottom:0` : `top:0`;
      // Three stacked bands give a smoother ramp than one mask.
      return [1, 0.6, 0.3]
        .map((k, i) => {
          const bh = h * (1 - i * 0.3);
          return `<div style="position:absolute;left:0;right:0;${pos};height:${px(bh)};z-index:26;backdrop-filter:blur(${px(amount * W * k)});-webkit-backdrop-filter:blur(${px(amount * W * k)});mask-image:linear-gradient(${dir}, #000 ${i === 0 ? 20 : 0}%, transparent 100%);-webkit-mask-image:linear-gradient(${dir}, #000 ${i === 0 ? 20 : 0}%, transparent 100%)"></div>`;
        })
        .join("");
    })
    .join("");
}

interface GradeSpec {
  filter: string[];
  overlays: Array<{ color: string; blend: string; opacity: number }>;
}

const GRADE_PRESETS: Record<string, GradeSpec> = {
  none: { filter: [], overlays: [] },
  airy: { filter: ["brightness(1.05)", "contrast(0.93)", "saturate(0.92)"], overlays: [{ color: "#ffffff", blend: "soft-light", opacity: 0.18 }] },
  "warm-film": { filter: ["sepia(0.12)", "contrast(1.04)", "saturate(1.04)"], overlays: [{ color: "#ffa25c", blend: "soft-light", opacity: 0.2 }] },
  "cool-film": { filter: ["contrast(1.05)", "saturate(0.9)"], overlays: [{ color: "#5b9dff", blend: "soft-light", opacity: 0.2 }] },
  faded: { filter: ["contrast(0.86)", "saturate(0.82)", "brightness(1.04)"], overlays: [{ color: "#3a3a3a", blend: "lighten", opacity: 1 }] },
  cinematic: {
    filter: ["contrast(1.12)", "saturate(1.08)"],
    overlays: [
      { color: "#08707a", blend: "soft-light", opacity: 0.22 },
      { color: "#ff9a3c", blend: "overlay", opacity: 0.08 },
    ],
  },
  vivid: { filter: ["saturate(1.28)", "contrast(1.06)"], overlays: [] },
  mono: { filter: ["grayscale(1)", "contrast(1.05)"], overlays: [] },
  noir: { filter: ["grayscale(1)", "contrast(1.35)", "brightness(0.92)"], overlays: [] },
};

/** CSS filter + overlay layers for a colour grade. */
export function gradeFor(grade: Effects["grade"]): { filter: string; overlays: string; scope: "background" | "all" } {
  if (!grade) return { filter: "", overlays: "", scope: "background" };
  const g = typeof grade === "string" ? { preset: grade } : grade;
  const preset = GRADE_PRESETS[g.preset ?? "none"] ?? GRADE_PRESETS.none;
  const filter = [...preset.filter];
  const overlays = [...preset.overlays];
  if (g.exposure) filter.push(`brightness(${(2 ** g.exposure).toFixed(3)})`);
  if (g.contrast !== undefined) filter.push(`contrast(${g.contrast})`);
  if (g.saturation !== undefined) filter.push(`saturate(${g.saturation})`);
  if (g.temperature) overlays.push({ color: g.temperature > 0 ? "#ff9a3c" : "#3c8cff", blend: "soft-light", opacity: Math.min(1, Math.abs(g.temperature) * 0.4) });
  if (g.tint) overlays.push({ color: g.tint > 0 ? "#ff3cc8" : "#3cff6e", blend: "soft-light", opacity: Math.min(1, Math.abs(g.tint) * 0.25) });
  if (g.fade) {
    const v = Math.round(g.fade * 70);
    overlays.push({ color: `rgb(${v},${v},${v})`, blend: "lighten", opacity: 1 });
  }
  return {
    filter: filter.join(" "),
    overlays: overlays.map((o) => `<div class="bg" style="z-index:3;background:${esc(o.color)};mix-blend-mode:${o.blend};opacity:${o.opacity}"></div>`).join(""),
    scope: g.scope ?? "background",
  };
}
