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
  /** Public-domain paintings and prints (from museum collections on Unsplash), grouped apart from photos. */
  painting?: boolean;
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

/** A public-domain painting or print, shown sharp, with a whisper of grain. */
const painting = (name: string, tone: Look["tone"], description: string, id: string, color: string, fallback: string[]): Look => ({
  ...photo(name, tone, description, id, color, {}, fallback, { grain: 0.06 }),
  painting: true,
});

const mesh = (name: string, tone: Look["tone"], description: string, colors: string[], extra: Partial<BackgroundObject> = {}, effects?: Look["effects"]): Look => ({
  name,
  tone,
  description,
  color: colors[0],
  background: { type: "mesh", colors, ...extra },
  effects,
});

/** A gradient written as CSS layers: soft glows in two corners over a three-colour sweep. */
const glow = (name: string, tone: Look["tone"], description: string, css: string, color: string): Look => ({
  name,
  tone,
  description,
  color,
  background: { type: "solid", color: css },
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

  // Public-domain paintings and prints
  painting("great-wave", "light", "Hokusai's Great Wave off Kanagawa (woodblock print, The Met).", "ZBH-w0cjl6E", "#d6ccb2", ["#efe6d2", "#2f4a6b", "#d9d2bf"]),
  painting("fuji-coast", "light", "Hokusai woodblock of Mount Fuji above a green coast (The Met).", "WHvWI3gS-Zo", "#c9d2c0", ["#e8e4d4", "#7fa7a0", "#2f4b5c"]),
  painting("woodblock-fuji", "light", "Japanese woodblock: Fuji under a red sky, a waterfall and reeds (Art Institute of Chicago).", "VBIBfUiKwlA", "#b9c7c3", ["#e7ddcb", "#c9564a", "#6f8fa0"]),
  painting("morning-glories", "light", "Japanese print of blue morning glories on cream (Art Institute of Chicago).", "X_0GzC-RKos", "#d5cfbd", ["#ece6d5", "#8fa9a2", "#9c8fb3"]),
  painting("hollyhocks", "light", "Japanese print of pink hollyhocks with teal leaves on cream (Cleveland Museum of Art).", "1J9LhQQTovI", "#d8d1c3", ["#ebe5d8", "#e4a7a0", "#3f6f73"]),
  painting("monet-bridge", "dark", "Monet's Japanese Footbridge over the water lilies (National Gallery of Art).", "Z-S0resW6gQ", "#4f6a3d", ["#2f4a2c", "#6f9a58", "#b7c98f"]),
  painting("monet-garden", "light", "Monet's garden at Argenteuil in bloom (National Gallery of Art).", "E-fUZYaqFRs", "#95a67e", ["#dfe3d0", "#9ab07a", "#c95a4a"]),
  painting("green-wheat", "light", "Van Gogh's green wheat field under swirling clouds (National Gallery of Art).", "nyhZogmvelI", "#9dbd7c", ["#e8f0e0", "#7fb45a", "#bcd6e8"]),
  painting("olive-grove", "light", "Van Gogh's olive grove under a mottled sky (The Met).", "uY5TBoq2H7U", "#8b8a5c", ["#d8d0a8", "#6f7c45", "#b7a36a"]),
  painting("golden-sea", "light", "Calm sea under a warm golden sky with pink clouds (The Met).", "2vLp5nTfsvc", "#d6b69c", ["#f1dcc8", "#d9a58a", "#8fa0b0"]),
  painting("lake-mountains", "light", "Hudson River School lake with trees and hazy mountains (The Met).", "9XpO8WsYNdI", "#a2a489", ["#e1dfcc", "#8a9a78", "#5f6a52"]),
  painting("misty-hills", "light", "Watercolour of misty green hills and pines (Europeana).", "a-REQ2_ooME", "#c3cdc6", ["#eef1ee", "#9fb6a6", "#6f8a78"]),
  painting("pastel-shore", "light", "Soft pastel painting of a shore and sky (Smithsonian).", "myKJLft6ZJ8", "#e3d6b4", ["#f3ead2", "#9ec3d6", "#e8c9a0"]),
  painting("iris-plate", "light", "Botanical plate of deep purple irises on white (The New York Public Library).", "IjFz-e6sMYg", "#eeede9", ["#f5f4f0", "#3d3a73", "#8fa888"]),
  painting("wisteria-plate", "light", "Botanical plate of purple wisteria (The New York Public Library).", "FazDueOXSC8", "#ecebe5", ["#f4f3ee", "#8f7fb8", "#8fa37a"]),

  // Procedural (work offline)
  glow("orchid", "dark", "Vivid pink sweeping into violet and deep indigo, a pink glow top left.", "radial-gradient(120% 90% at 0% 0%, #ff8fd1 0%, transparent 55%), radial-gradient(100% 100% at 100% 100%, #5a3bf0 0%, transparent 60%), linear-gradient(135deg, #f15bb5, #7b2ff7 60%, #2d1b9a)", "#7b2ff7"),
  glow("tangerine", "dark", "Vivid orange into coral and raspberry, a golden glow top right.", "radial-gradient(110% 90% at 100% 0%, #ffd36b 0%, transparent 55%), radial-gradient(100% 100% at 0% 100%, #ff4d4d 0%, transparent 60%), linear-gradient(135deg, #ff9f43, #ff5e62 55%, #c2185b)", "#ff5e62"),
  glow("lagoon", "dark", "Vivid aqua into teal and indigo, a mint glow top left.", "radial-gradient(110% 90% at 0% 0%, #8ff5d0 0%, transparent 55%), radial-gradient(100% 100% at 100% 100%, #1565c0 0%, transparent 60%), linear-gradient(135deg, #1de9b6, #00acc1 55%, #283593)", "#00acc1"),
  glow("cobalt", "dark", "Periwinkle into electric blue and navy, a lilac glow top right.", "radial-gradient(110% 90% at 100% 0%, #c6b8ff 0%, transparent 55%), radial-gradient(100% 100% at 0% 100%, #0d47a1 0%, transparent 60%), linear-gradient(135deg, #8c9eff, #3d5afe 55%, #1a237e)", "#3d5afe"),
  glow("fern", "dark", "Lime into leaf green and forest, a warm glow top left.", "radial-gradient(110% 90% at 0% 0%, #ffe0a3 0%, transparent 55%), radial-gradient(100% 100% at 100% 100%, #2e7d32 0%, transparent 60%), linear-gradient(135deg, #d4e157, #43a047 55%, #1b5e20)", "#43a047"),
  mesh("midnight", "dark", "Deep indigo with violet and cyan glows.", ["#0b1020", "#3b3bb3", "#7c3aed", "#0ea5e9"]),
  mesh("aurora", "dark", "Dark teal with green and violet aurora bands.", ["#06131f", "#10b981", "#22d3ee", "#6366f1"], { meshStyle: "aurora" }, { grain: 0.1 }),
  mesh("sunset", "light", "Peach, pink and lilac.", ["#fff1e6", "#fdba74", "#f472b6", "#a78bfa"]),
  mesh("pastel", "light", "Airy periwinkle, pink and sky.", ["#f8fafc", "#c7d2fe", "#fbcfe8", "#bae6fd"]),
  mesh("mint", "light", "Fresh mint and sky.", ["#f0fdf4", "#a7f3d0", "#bae6fd", "#d9f99d"]),
  mesh("peach", "light", "Soft peach and rose.", ["#fff7ed", "#fed7aa", "#fecdd3", "#fde68a"], { meshStyle: "orbs" }),
  mesh("ocean", "dark", "Navy with teal light.", ["#0b1a2e", "#0e7490", "#1d4ed8", "#22d3ee"], { meshStyle: "corner" }),
  mesh("ember", "dark", "Charcoal with orange and red embers.", ["#140c0a", "#ea580c", "#b91c1c", "#f59e0b"], { meshStyle: "corner" }, { grain: 0.12 }),
  // Soft grounds
  {
    name: "cream-grain",
    tone: "light",
    description: "Warm cream gradient with a paper grain; leaves room for a headline.",
    color: "#efe5d3",
    background: { type: "radial", colors: ["#f8f1e4", "#e8dcc6"], x: 0.3, y: 0.3 },
    effects: { grain: 0.2 },
  },
  {
    name: "peach-glow",
    tone: "light",
    description: "Soft peach glow.",
    color: "#f4c9b3",
    background: { type: "radial", colors: ["#fde7da", "#f6cdb7", "#eeb49b"], x: 0.5, y: 0.25 },
    effects: { grain: 0.08 },
  },
  mesh("lavender-mist", "light", "Pale lavender mist.", ["#f1edf8", "#ddd2f0", "#e9e1f6", "#cfc6ea"], { meshStyle: "field" }, { grain: 0.06 }),
  {
    name: "mint-sage",
    tone: "light",
    description: "Pale mint fading to sage.",
    color: "#d6e6d6",
    background: { type: "gradient", colors: ["#eef7f0", "#d5e7d6", "#b9d0bb"], angle: 180 },
    effects: { grain: 0.08 },
  },
  mesh("iridescent", "light", "Soft mint, lilac and blue iridescent light.", ["#eef8f4", "#b9ecd8", "#cdd3ff", "#f5d9ee"], { meshStyle: "aurora" }, { grain: 0.05 }),
  mesh("coral-periwinkle", "light", "Soft strokes of coral and periwinkle.", ["#fbe6da", "#f6956c", "#98a3f5", "#f7cbb8"], { meshStyle: "diagonal" }, { grain: 0.1 }),
  {
    name: "indigo-fade",
    tone: "dark",
    description: "Deep indigo fading to near black; pairs with fluted glass.",
    color: "#1b1846",
    background: { type: "gradient", colors: ["#2b2672", "#15123a", "#07061a"], angle: 180 },
  },
  {
    name: "ember-glow",
    tone: "dark",
    description: "Blurred orange sunset glow on black; screens can dissolve into it.",
    color: "#2a0e06",
    background: { type: "radial", colors: ["#e8742f", "#8a2a0c 32%", "#1c0804 62%", "#050303"], x: 0.5, y: 0.34 },
    effects: { grain: 0.1 },
  },
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
