/**
 * Live optical & layer effects on boards: Figma-style Liquid Glass (refraction, depth, chromatic
 * dispersion, frost, splay, directional rim light), Pattern refraction, Lens distortion, Warp,
 * Moving blobs, Slice shift, Pixel stretch, Pixelate, Gooey merge, Bloom, Bokeh blur, Gradient map,
 * Color adjust, CRT screen, Outlines and Chromatic metal.
 *
 * Pure module (no Node or DOM APIs), shared between engine and Studio (/ui/effects.js). Drawn in
 * the browser and headless Chrome by src/studio/ui/board-effects-runtime.js via hardware-accelerated
 * SVG filter graphs (`backdrop-filter: url(#…)` for optical lenses over live layers behind a frame,
 * `filter: url(#…)` for layer effects) and specular rim lighting.
 */

export type EffectTarget = "behind" | "layer";

export type EffectType =
  | "glass"
  | "pattern-refraction"
  | "lens-distortion"
  | "warp"
  | "moving-blobs"
  | "slice-shift"
  | "pixel-stretch"
  | "gooey-merge"
  | "bloom"
  | "bokeh-blur"
  | "gradient-map"
  | "color-adjust"
  | "pixelate"
  | "crt-screen"
  | "outlines"
  | "chromatic-metal";

export type EffectCategory = "glass" | "distort" | "light" | "stylize";

export interface EffectParamDef {
  key: string;
  label: string;
  kind: "number" | "color" | "choice";
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  px?: boolean;
  options?: Array<{ value: string; label: string }>;
  default: number | string;
}

export interface EffectDef {
  type: EffectType;
  name: string;
  category: EffectCategory;
  blurb: string;
  defaultTarget: EffectTarget;
  /** Whether the user can switch between "Behind it" (backdrop) and "The layer". */
  switchableTarget?: boolean;
  params: EffectParamDef[];
}

export interface LayerEffect {
  type: EffectType;
  /** Whether the effect operates on what's behind the layer ("behind") or the layer itself ("layer"). */
  target?: EffectTarget;
  /** Disabled effects stay in the stack without drawing. */
  disabled?: boolean;
  [param: string]: unknown;
}

export const EFFECT_CATEGORIES: Array<{ id: EffectCategory; label: string }> = [
  { id: "glass", label: "Glass & refraction" },
  { id: "distort", label: "Distortion" },
  { id: "light", label: "Light & colour" },
  { id: "stylize", label: "Stylize" },
];

export const EFFECT_DEFS: EffectDef[] = [
  {
    type: "glass",
    name: "Glass",
    category: "glass",
    blurb: "Refractive liquid glass with bevel depth, rainbow dispersion, frost and directional rim light.",
    defaultTarget: "behind",
    params: [
      { key: "lightAngle", label: "Light angle", kind: "number", min: -180, max: 180, step: 1, unit: "°", default: -60 },
      { key: "lightIntensity", label: "Light", kind: "number", min: 0, max: 100, step: 1, unit: "%", default: 80 },
      { key: "refraction", label: "Refraction", kind: "number", min: 0, max: 100, step: 1, default: 80 },
      { key: "depth", label: "Depth", kind: "number", min: 0, max: 100, step: 1, default: 65 },
      { key: "dispersion", label: "Dispersion", kind: "number", min: 0, max: 100, step: 1, default: 50 },
      { key: "frost", label: "Frost", kind: "number", min: 0, max: 100, step: 1, default: 6 },
      { key: "splay", label: "Splay", kind: "number", min: 0, max: 100, step: 1, default: 0 },
    ],
  },
  {
    type: "pattern-refraction",
    name: "Pattern refraction",
    category: "glass",
    blurb: "Refracts what's behind or inside through lenticular, fluted, wave, ripple or mosaic glass ribs.",
    defaultTarget: "behind",
    switchableTarget: true,
    params: [
      {
        key: "pattern",
        label: "Pattern",
        kind: "choice",
        options: [
          { value: "lenticular", label: "Lenticular" },
          { value: "fluted", label: "Fluted" },
          { value: "waves", label: "Waves" },
          { value: "ripple", label: "Ripple" },
          { value: "mosaic", label: "Mosaic" },
          { value: "crosshatch", label: "Crosshatch" },
        ],
        default: "lenticular",
      },
      { key: "strength", label: "Strength", kind: "number", min: 0, max: 100, step: 1, default: 55 },
      { key: "smoothness", label: "Smoothness", kind: "number", min: 0, max: 100, step: 1, unit: "%", default: 15 },
      { key: "frost", label: "Frost", kind: "number", min: 0, max: 100, step: 1, unit: "%", default: 0 },
      { key: "dispersion", label: "Dispersion", kind: "number", min: 0, max: 100, step: 1, unit: "%", default: 25 },
      { key: "scale", label: "Scale", kind: "number", min: 2, max: 100, step: 1, unit: "%", default: 12 },
      { key: "angle", label: "Angle", kind: "number", min: -180, max: 180, step: 1, unit: "°", default: 45 },
    ],
  },
  {
    type: "lens-distortion",
    name: "Lens distortion",
    category: "glass",
    blurb: "Fisheye barrel or pincushion camera lens warp with lateral or radial chromatic aberration.",
    defaultTarget: "behind",
    switchableTarget: true,
    params: [
      { key: "distortion", label: "Distortion", kind: "number", min: -1, max: 1, step: 0.02, default: 0.5 },
      { key: "aberration", label: "Aberration", kind: "number", min: 0, max: 1, step: 0.02, default: 0.25 },
      { key: "centerX", label: "Center X", kind: "number", min: 0, max: 100, step: 1, unit: "%", default: 50 },
      { key: "centerY", label: "Center Y", kind: "number", min: 0, max: 100, step: 1, unit: "%", default: 50 },
      {
        key: "mode",
        label: "Mode",
        kind: "choice",
        options: [
          { value: "lateral", label: "Lateral" },
          { value: "radial", label: "Radial" },
        ],
        default: "lateral",
      },
    ],
  },
  {
    type: "warp",
    name: "Warp",
    category: "distort",
    blurb: "Concentric ripples, vortex swirls, liquid waves or bulges.",
    defaultTarget: "layer",
    switchableTarget: true,
    params: [
      {
        key: "style",
        label: "Style",
        kind: "choice",
        options: [
          { value: "ripple", label: "Ripple" },
          { value: "swirl", label: "Swirl" },
          { value: "wave", label: "Wave" },
          { value: "bulge", label: "Bulge" },
        ],
        default: "ripple",
      },
      { key: "strength", label: "Strength", kind: "number", min: 0, max: 100, step: 1, default: 55 },
      { key: "frequency", label: "Frequency", kind: "number", min: 1, max: 20, step: 0.5, default: 6 },
      { key: "centerX", label: "Center X", kind: "number", min: 0, max: 100, step: 1, unit: "%", default: 50 },
      { key: "centerY", label: "Center Y", kind: "number", min: 0, max: 100, step: 1, unit: "%", default: 50 },
      { key: "angle", label: "Angle", kind: "number", min: -180, max: 180, step: 1, unit: "°", default: 0 },
    ],
  },
  {
    type: "moving-blobs",
    name: "Moving blobs",
    category: "distort",
    blurb: "Organic domain-warped fluid blobs with chromatic prism edges.",
    defaultTarget: "layer",
    switchableTarget: true,
    params: [
      { key: "strength", label: "Strength", kind: "number", min: 0, max: 100, step: 1, default: 55 },
      { key: "scale", label: "Scale", kind: "number", min: 0.5, max: 12, step: 0.25, default: 3.5 },
      { key: "dispersion", label: "Dispersion", kind: "number", min: 0, max: 100, step: 1, unit: "%", default: 35 },
      { key: "seed", label: "Phase", kind: "number", min: 0, max: 100, step: 1, default: 12 },
    ],
  },
  {
    type: "slice-shift",
    name: "Slice shift",
    category: "distort",
    blurb: "Stepped diagonal or parallel prism slices shifting bands across the frame.",
    defaultTarget: "layer",
    switchableTarget: true,
    params: [
      { key: "slices", label: "Slices", kind: "number", min: 2, max: 40, step: 1, default: 10 },
      { key: "offset", label: "Offset", kind: "number", min: -100, max: 100, step: 1, default: 28 },
      { key: "angle", label: "Angle", kind: "number", min: -180, max: 180, step: 1, unit: "°", default: 45 },
      {
        key: "direction",
        label: "Pattern",
        kind: "choice",
        options: [
          { value: "parallel", label: "Parallel" },
          { value: "zigzag", label: "Zigzag" },
          { value: "random", label: "Jitter" },
        ],
        default: "parallel",
      },
      { key: "dispersion", label: "Dispersion", kind: "number", min: 0, max: 100, step: 1, unit: "%", default: 12 },
    ],
  },
  {
    type: "pixel-stretch",
    name: "Pixel stretch",
    category: "distort",
    blurb: "Stretches a column or row of pixels out into sleek motion streaks.",
    defaultTarget: "layer",
    switchableTarget: true,
    params: [
      { key: "position", label: "Split", kind: "number", min: 0, max: 100, step: 1, unit: "%", default: 50 },
      {
        key: "direction",
        label: "Direction",
        kind: "choice",
        options: [
          { value: "right", label: "Right" },
          { value: "left", label: "Left" },
          { value: "down", label: "Down" },
          { value: "up", label: "Up" },
        ],
        default: "right",
      },
      { key: "smoothness", label: "Soft edge", kind: "number", min: 0, max: 100, step: 1, unit: "%", default: 0 },
    ],
  },
  {
    type: "gooey-merge",
    name: "Gooey merge",
    category: "distort",
    blurb: "Melts nearby child shapes and text together like liquid metaballs.",
    defaultTarget: "layer",
    params: [
      { key: "blur", label: "Blur", kind: "number", min: 2, max: 40, step: 0.5, unit: "px", px: true, default: 10 },
      { key: "threshold", label: "Threshold", kind: "number", min: 10, max: 90, step: 1, unit: "%", default: 50 },
      { key: "sharpness", label: "Sharpness", kind: "number", min: 4, max: 40, step: 1, default: 18 },
    ],
  },
  {
    type: "bloom",
    name: "Bloom",
    category: "light",
    blurb: "Soft luminous halo radiating out from bright highlights.",
    defaultTarget: "layer",
    switchableTarget: true,
    params: [
      { key: "threshold", label: "Threshold", kind: "number", min: 0, max: 100, step: 1, unit: "%", default: 55 },
      { key: "intensity", label: "Intensity", kind: "number", min: 0, max: 200, step: 1, unit: "%", default: 95 },
      { key: "radius", label: "Radius", kind: "number", min: 2, max: 60, step: 1, unit: "px", px: true, default: 18 },
      { key: "tint", label: "Tint", kind: "color", default: "#ffffff" },
    ],
  },
  {
    type: "bokeh-blur",
    name: "Bokeh blur",
    category: "light",
    blurb: "Creamy out-of-focus camera lens blur that preserves bright specular bokeh.",
    defaultTarget: "layer",
    switchableTarget: true,
    params: [
      { key: "radius", label: "Radius", kind: "number", min: 2, max: 40, step: 0.5, unit: "px", px: true, default: 10 },
      { key: "boost", label: "Highlights", kind: "number", min: 0, max: 100, step: 1, unit: "%", default: 60 },
      { key: "threshold", label: "Threshold", kind: "number", min: 0, max: 100, step: 1, unit: "%", default: 65 },
    ],
  },
  {
    type: "gradient-map",
    name: "Gradient map",
    category: "light",
    blurb: "Maps shadows, midtones and highlights through a custom duotone or tritone palette.",
    defaultTarget: "layer",
    switchableTarget: true,
    params: [
      { key: "shadow", label: "Shadow", kind: "color", default: "#1b1464" },
      { key: "midtone", label: "Midtone", kind: "color", default: "#6d28d9" },
      { key: "highlight", label: "Highlight", kind: "color", default: "#f9a8d4" },
      { key: "mix", label: "Mix", kind: "number", min: 0, max: 100, step: 1, unit: "%", default: 100 },
    ],
  },
  {
    type: "color-adjust",
    name: "Color adjust",
    category: "light",
    blurb: "Exposure, contrast, saturation, warmth and tint grading.",
    defaultTarget: "layer",
    switchableTarget: true,
    params: [
      { key: "exposure", label: "Exposure", kind: "number", min: -100, max: 100, step: 1, default: 0 },
      { key: "contrast", label: "Contrast", kind: "number", min: -100, max: 100, step: 1, default: 15 },
      { key: "saturation", label: "Saturation", kind: "number", min: -100, max: 100, step: 1, default: 15 },
      { key: "temperature", label: "Warmth", kind: "number", min: -100, max: 100, step: 1, default: 0 },
      { key: "tint", label: "Tint", kind: "number", min: -100, max: 100, step: 1, default: 0 },
    ],
  },
  {
    type: "pixelate",
    name: "Pixelate",
    category: "stylize",
    blurb: "Crisp chunky mosaic pixelation.",
    defaultTarget: "layer",
    switchableTarget: true,
    params: [{ key: "size", label: "Pixel size", kind: "number", min: 2, max: 64, step: 1, unit: "px", px: true, default: 12 }],
  },
  {
    type: "crt-screen",
    name: "CRT screen",
    category: "stylize",
    blurb: "Retro RGB phosphor aperture grille, scanlines, subtle curvature and aberration.",
    defaultTarget: "layer",
    switchableTarget: true,
    params: [
      { key: "scale", label: "Pixel pitch", kind: "number", min: 2, max: 16, step: 1, unit: "px", px: true, default: 4 },
      { key: "scanlines", label: "Scanlines", kind: "number", min: 0, max: 100, step: 1, unit: "%", default: 55 },
      { key: "glow", label: "Glow", kind: "number", min: 0, max: 100, step: 1, unit: "%", default: 30 },
      { key: "curvature", label: "Curvature", kind: "number", min: 0, max: 100, step: 1, unit: "%", default: 18 },
      { key: "aberration", label: "Aberration", kind: "number", min: 0, max: 100, step: 1, unit: "%", default: 30 },
    ],
  },
  {
    type: "outlines",
    name: "Outlines",
    category: "stylize",
    blurb: "Crisp edge-detected outlines over a solid or transparent ground.",
    defaultTarget: "layer",
    switchableTarget: true,
    params: [
      { key: "thickness", label: "Thickness", kind: "number", min: 1, max: 8, step: 0.5, unit: "px", px: true, default: 2 },
      { key: "threshold", label: "Sensitivity", kind: "number", min: 0, max: 100, step: 1, unit: "%", default: 45 },
      { key: "color", label: "Ink", kind: "color", default: "#c4b5fd" },
      { key: "background", label: "Background", kind: "color", default: "#0b0b12" },
      { key: "mix", label: "Mix", kind: "number", min: 0, max: 100, step: 1, unit: "%", default: 100 },
    ],
  },
  {
    type: "chromatic-metal",
    name: "Chromatic metal",
    category: "stylize",
    blurb: "Turns shapes and text into embossed liquid chrome with iridescent rainbow sheen.",
    defaultTarget: "layer",
    params: [
      { key: "depth", label: "Bevel", kind: "number", min: 0, max: 100, step: 1, default: 65 },
      { key: "dispersion", label: "Dispersion", kind: "number", min: 0, max: 100, step: 1, unit: "%", default: 75 },
      { key: "shine", label: "Shine", kind: "number", min: 0, max: 100, step: 1, unit: "%", default: 85 },
      { key: "lightAngle", label: "Light angle", kind: "number", min: -180, max: 180, step: 1, unit: "°", default: -45 },
    ],
  },
];

export const effectDefOf = (type: string | undefined): EffectDef | undefined =>
  type ? EFFECT_DEFS.find((d) => d.type === type) : undefined;

export const EFFECT_TYPES = EFFECT_DEFS.map((d) => d.type);

/** Build a fresh default effect object for `type`. */
export function defaultEffect(type: EffectType, overrides: Record<string, unknown> = {}): LayerEffect {
  const def = effectDefOf(type) ?? EFFECT_DEFS[0];
  const out: LayerEffect = { type: def.type, target: def.defaultTarget };
  for (const p of def.params) out[p.key] = p.default;
  return cleanEffect({ ...out, ...overrides }) ?? out;
}

const isSafeColor = (v: unknown): v is string => {
  if (typeof v !== "string") return false;
  const s = v.trim();
  if (!s || s.length > 160 || /[;{}<>"'`\\]|url\(|expression/i.test(s)) return false;
  return /^#[0-9a-f]{3,8}$/i.test(s) || /^(rgba?|hsla?|hwb|lab|lch|oklab|oklch|color|color-mix)\([-\w\s.,%/+()#]*\)$/i.test(s) || /^[a-z]{3,30}$/i.test(s) || /^var\(\s*--[\w-]+\s*(,[^;{}<>"'`\\]*)?\)$/i.test(s);
};

/** Sanitize a single effect spec, filling defaults and clamping numbers into valid bounds. */
export function cleanEffect(raw: unknown): LayerEffect | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const rawType = typeof r.type === "string" ? r.type.trim().toLowerCase().replace(/[\s_]+/g, "-") : "";
  const def = effectDefOf(rawType);
  if (!def) return null;
  const out: LayerEffect = { type: def.type };
  const t = r.target === "behind" || r.target === "layer" ? r.target : def.defaultTarget;
  out.target = def.switchableTarget ? t : def.defaultTarget;
  if (r.disabled === true) out.disabled = true;
  for (const p of def.params) {
    const v = r[p.key];
    if (p.kind === "number") {
      const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v.trim().replace(/(px|%|°|deg)$/i, "")) : NaN;
      const clamped = Number.isFinite(n) ? Math.min(p.max ?? n, Math.max(p.min ?? n, n)) : Number(p.default);
      out[p.key] = Math.round(clamped * 1000) / 1000;
    } else if (p.kind === "color") {
      out[p.key] = isSafeColor(v) ? v.trim() : String(p.default);
    } else {
      const opts = p.options ?? [];
      const found = typeof v === "string" ? opts.find((o) => o.value.toLowerCase() === v.trim().toLowerCase()) : undefined;
      out[p.key] = found ? found.value : String(p.default);
    }
  }
  return out;
}

export function cleanEffects(raw: unknown): LayerEffect[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out = raw.slice(0, 8).map(cleanEffect).filter((x): x is LayerEffect => Boolean(x));
  return out.length ? out : undefined;
}

/** Scale px-valued effect parameters when the Scale tool scales a layer by `k`. */
export function scaledEffects(list: LayerEffect[] | undefined, k: number): LayerEffect[] | undefined {
  if (!list?.length || Math.abs(k - 1) < 1e-4) return undefined;
  let changed = false;
  const next = list.map((fx) => {
    const def = effectDefOf(fx.type);
    if (!def) return fx;
    const copy = { ...fx };
    for (const p of def.params) {
      if (!p.px) continue;
      const cur = Number(fx[p.key] ?? p.default);
      if (!Number.isFinite(cur)) continue;
      const v = Math.min(p.max ?? cur * k, Math.max(p.min ?? cur * k, Math.round(cur * k * 100) / 100));
      if (v !== cur) {
        copy[p.key] = v;
        changed = true;
      }
    }
    return copy;
  });
  return changed ? next : undefined;
}

const escAttr = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

/** HTML attributes carrying a layer's effects (`data-effects='[...]'`). */
export function effectsAttrs(list: LayerEffect[] | undefined): string {
  if (!list?.length) return "";
  return ` data-effects="${escAttr(JSON.stringify(list))}"`;
}

/** Parse `data-effects` or shorthand `data-glass` attributes from HTML. */
export function effectsFromAttrs(attrs: Record<string, string>, warnings: string[] = []): LayerEffect[] | undefined {
  const out: LayerEffect[] = [];
  if (attrs["data-glass"] !== undefined && attrs["data-glass"] !== "false") {
    const raw = attrs["data-glass"].trim();
    if (!raw || raw === "true") out.push(defaultEffect("glass"));
    else {
      try {
        out.push(defaultEffect("glass", JSON.parse(raw)));
      } catch {
        warnings.push(`data-glass isn't valid JSON: write data-glass or data-glass='{"refraction":100,"depth":100,"dispersion":100}'.`);
        out.push(defaultEffect("glass"));
      }
    }
  }
  if (attrs["data-effects"]) {
    try {
      const parsed = JSON.parse(attrs["data-effects"]);
      const cleaned = cleanEffects(Array.isArray(parsed) ? parsed : [parsed]);
      if (cleaned) out.push(...cleaned);
    } catch {
      warnings.push(`data-effects isn't valid JSON: write data-effects='[{"type":"glass","refraction":80}]'.`);
    }
  }
  return out.length ? out : undefined;
}

/** Concise outline summary for `board_read`. */
export function effectsWords(list: LayerEffect[] | undefined): string {
  if (!list?.length) return "";
  return list
    .filter((e) => !e.disabled)
    .map((e) => {
      const def = effectDefOf(e.type);
      if (!def) return e.type;
      const nonDefault = def.params
        .filter((p) => e[p.key] !== undefined && e[p.key] !== p.default)
        .slice(0, 4)
        .map((p) => `${p.key}=${e[p.key]}`);
      return `effect ${e.type}${e.target && e.target !== def.defaultTarget ? ` (${e.target})` : ""}${nonDefault.length ? ` (${nonDefault.join(", ")})` : ""}`;
    })
    .join(", ");
}

/** Catalog of all available effects and their params, for agents. */
export function effectsCatalog(): string {
  return EFFECT_DEFS.map((d) => {
    const ps = d.params.map((p) =>
      p.kind === "number"
        ? `${p.key} ${p.min}..${p.max} (${p.default}${p.unit ?? ""})`
        : p.kind === "color"
          ? `${p.key} colour (${p.default})`
          : `${p.key} ${(p.options ?? []).map((o) => o.value).join("|")} (${p.default})`,
    );
    return `- ${d.type} [${d.defaultTarget}${d.switchableTarget ? "|switchable" : ""}]: ${d.blurb} Params: ${ps.join(", ")}.`;
  }).join("\n");
}
