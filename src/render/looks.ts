import type { BackgroundObject, EffectsInput } from "./schema.js";

export interface Look {
  name: string;
  tone: "light" | "dark";
  description: string;
  background: BackgroundObject;
  effects?: NonNullable<EffectsInput>;
  /** Used when the photo can't be downloaded. */
  fallback?: BackgroundObject;
  /** Colour for auto shadows and contrast decisions. */
  color: string;
}

const photo = (
  name: string,
  tone: Look["tone"],
  description: string,
  id: string,
  color: string,
  treatment: Partial<BackgroundObject>,
  fallback: string[],
  effects: Look["effects"] = { grain: 0.12 },
): Look => ({
  name,
  tone,
  description,
  color,
  background: { photo: `unsplash:${id}`, ...treatment },
  fallback: { type: "mesh", colors: fallback },
  effects,
});

const mesh = (name: string, tone: Look["tone"], description: string, colors: string[], extra: Partial<BackgroundObject> = {}, effects?: Look["effects"]): Look => ({
  name,
  tone,
  description,
  color: colors[0],
  background: { type: "mesh", colors, ...extra },
  effects,
});

export const LOOKS: Look[] = [
  // Photographic
  photo("meadow-motion", "light", "Wildflower meadow streaked with horizontal motion blur, warm haze.", "lpHm3TXzWeA", "#8b9a6a", { motionBlur: 0.07, haze: 0.45, tint: "#d8c4b0", tintAmount: 0.12, saturation: 0.92, brightness: 1.12 }, ["#dfe5cf", "#9fb37a", "#b9c7e8", "#f3eed2"]),
  photo("lavender-motion", "light", "Lavender field with motion blur.", "nD9tEn63suc", "#8a78b8", { motionBlur: 0.06, haze: 0.25, saturation: 0.9 }, ["#e8e0f5", "#9d8cd0", "#f0c8dc", "#c9d3f2"]),
  photo("wheat-motion", "light", "Golden wheat with motion blur, late-summer warmth.", "cUY7u2Fskk4", "#b08850", { motionBlur: 0.06, haze: 0.25, tint: "#f1dcb8", tintAmount: 0.12 }, ["#f4e7cf", "#d9b47a", "#f7d9a8", "#fff4e0"]),
  photo("ocean-motion", "dark", "Turquoise surf, blurred with motion.", "4wFqHZ1ONnM", "#2f6e7e", { motionBlur: 0.05, saturation: 0.95 }, ["#0f3b4a", "#1d7f94", "#9ad7e0", "#0b2a36"]),
  photo("clouds", "light", "Soft pink-and-blue cloudscape.", "v9bnfMCyKbg", "#c9b7c8", { blur: 0.004, haze: 0.3, saturation: 0.9 }, ["#f3e6ef", "#c9d8f0", "#f5cddd", "#e9eef8"]),
  photo("sky", "light", "Bright blue sky with white clouds.", "jYBn4m3sW0", "#8fb6d9", { blur: 0.003, haze: 0.2 }, ["#dbeafe", "#93c5fd", "#e0f2fe", "#f8fafc"]),
  photo("dusk", "dark", "Violet dusk clouds.", "Qi8CvonsYnM", "#4a3a6a", { blur: 0.004, dim: 0.1 }, ["#2a2140", "#6b4a8a", "#e08aa8", "#1a1530"]),
  photo("dunes", "light", "Warm sand dunes in soft light.", "HEf0fKgJA1Q", "#c49668", { blur: 0.003, haze: 0.2 }, ["#f3e1c7", "#d4a373", "#f7e7d0", "#e9c9a0"]),
  photo("forest-mist", "dark", "Moody pine forest in fog.", "SrASYZZpyjw", "#3c4a44", { blur: 0.003, dim: 0.12, saturation: 0.85 }, ["#1f2a26", "#4b5e55", "#8fa39a", "#12181a"]),
  photo("aurora-night", "dark", "Northern lights over a treeline.", "62V7ntlKgL8", "#123a3a", { blur: 0.003, dim: 0.1 }, ["#06131f", "#10b981", "#22d3ee", "#312e81"]),
  photo("city-bokeh", "dark", "Warm out-of-focus city lights.", "FABH5NJEMGM", "#2a1a10", { blur: 0.006, dim: 0.15 }, ["#120c08", "#b45309", "#f59e0b", "#1e293b"]),
  photo("linen", "light", "Warm natural linen texture.", "ZToHTyQO008", "#d6b98c", { blur: 0.0015, haze: 0.15, saturation: 0.85 }, ["#efe3cc", "#dcc39a", "#f5ecdb"], { grain: 0.18 }),
  photo("palm-shadow", "light", "Sunlit sand with palm-leaf shadows.", "kGXST_-n36w", "#c4a27a", { blur: 0.002, haze: 0.15 }, ["#f1e2cc", "#caa77e", "#f6ead8"]),
  photo("snow-dawn", "light", "Snowy hills at pastel sunrise.", "e62AeaW8Ks8", "#d8c6c0", { blur: 0.003, haze: 0.2 }, ["#f7ecea", "#d9c2d0", "#c8d6ea", "#fff8f2"]),

  // Procedural (work offline)
  mesh("midnight", "dark", "Deep indigo with violet and cyan glows.", ["#0b1020", "#3b3bb3", "#7c3aed", "#0ea5e9"]),
  mesh("aurora", "dark", "Dark teal with green and violet aurora bands.", ["#06131f", "#10b981", "#22d3ee", "#6366f1"], { meshStyle: "aurora" }, { grain: 0.1 }),
  mesh("sunset", "light", "Peach, pink and lilac.", ["#fff1e6", "#fdba74", "#f472b6", "#a78bfa"]),
  mesh("pastel", "light", "Airy periwinkle, pink and sky.", ["#f8fafc", "#c7d2fe", "#fbcfe8", "#bae6fd"]),
  mesh("mint", "light", "Fresh mint and sky.", ["#f0fdf4", "#a7f3d0", "#bae6fd", "#d9f99d"]),
  mesh("peach", "light", "Soft peach and rose.", ["#fff7ed", "#fed7aa", "#fecdd3", "#fde68a"], { meshStyle: "orbs" }),
  mesh("ocean", "dark", "Navy with teal light.", ["#0b1a2e", "#0e7490", "#1d4ed8", "#22d3ee"], { meshStyle: "corner" }),
  mesh("ember", "dark", "Charcoal with orange and red embers.", ["#140c0a", "#ea580c", "#b91c1c", "#f59e0b"], { meshStyle: "corner" }, { grain: 0.12 }),
  {
    name: "graphite",
    tone: "dark",
    description: "Studio graphite spotlight.",
    color: "#2a2a2c",
    background: { type: "radial", colors: ["#4a4a4e", "#1c1c1e 70%"], x: 0.5, y: 0.35 },
    effects: { grain: 0.1, vignette: 0.3 },
  },
  {
    name: "paper",
    tone: "light",
    description: "Warm off-white paper with grain.",
    color: "#f3efe7",
    background: { type: "radial", colors: ["#faf7f1", "#ece6da"], x: 0.5, y: 0.3 },
    effects: { grain: 0.22 },
  },
  {
    name: "studio-white",
    tone: "light",
    description: "Clean white sweep for product shots.",
    color: "#f2f2f4",
    background: { type: "radial", colors: ["#ffffff", "#e7e7ec"], x: 0.5, y: 0.4 },
  },
  {
    name: "ink",
    tone: "dark",
    description: "Near-black with film grain.",
    color: "#0a0a0b",
    background: { type: "radial", colors: ["#1a1a1c", "#050506"], x: 0.5, y: 0.35 },
    effects: { grain: 0.2 },
  },
];

export function findLook(name: string): Look | undefined {
  const n = name.toLowerCase().trim();
  return LOOKS.find((l) => l.name === n);
}
