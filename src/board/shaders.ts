/**
 * Shaders on boards: a frame's fill drawn live by the graphics card (a WebGL fragment shader), as
 * mesh gradients, grain, liquid chrome, dither, halftone, light rays and so on. Any frame can have
 * one: it's drawn over the frame's own fills and behind its layers, so a shader frame lays out like
 * any other (a grid cell, an item in a stack) and holds words and pictures over its shader. It
 * plays on the canvas and in Preview, and pictures of the board show it frozen at its `time`.
 *
 * This module is the model: the presets, how a shader's parameters are declared and read, and how
 * a layer's shader is written in and out of HTML. It is pure (no imports), like the core that
 * re-exports it, so the Studio loads it too (as /ui/shaders.js). The drawing itself is done by
 * one small script, the same everywhere: src/studio/ui/board-shader-runtime.js.
 *
 * A shader's code is GLSL (OpenGL ES Shading Language 1.00, or 3.00 with `#version 300 es`), never
 * JavaScript: it only ever goes to the graphics card. The runtime gives it `uTime` (seconds),
 * `uRes` (the size it's drawn at, in pixels) and `uPx` (pixels per design pixel). Its own
 * parameters are uniforms declared with a comment the inspector turns into controls:
 *
 *   uniform float uWarp;    // @param 0..2 = 0.9            a number (a slider), "step 0.1" to step it
 *   uniform float uSpacing; // @param 4..40 = 11 px         a length in design px (the runtime gives it in drawn px)
 *   uniform int uLevels;    // @param 2..8 = 4              a whole number
 *   uniform vec3 uTint;     // @color = #ff5a1f "Tint"      a colour (vec4 gets its alpha too); a label in quotes
 *   uniform int uShape;     // @choice dots|lines = dots    one of some words (the uniform gets its index)
 *
 * A parameter's key is its uniform's name without the u: uWarp is "warp", uTint "tint".
 */

/** A frame's shader. */
export interface ShaderSpec {
  /** A built-in preset ("mesh-gradient") or one of the board's own, by name. */
  preset?: string;
  /** GLSL code of its own (a custom shader); with a preset, what it falls back on where the preset isn't known. */
  code?: string;
  /** Parameter values by key: numbers, colours as CSS (tokens too: "var(--brand)"), choices by their word. */
  params?: Record<string, number | string>;
  /** How fast it plays: 1 as made, 0.5 half as fast, 0 still. */
  speed?: number;
  /** The moment pictures of the board show (and the canvas, while paused), in seconds of the shader's time. */
  time?: number;
  /** Shows its still instead of playing. */
  paused?: boolean;
  /** How it mixes with the frame's fills under it (a CSS blend mode: "overlay" for grain over a photo). Normal when left out. */
  blend?: string;
}

/** A shader saved on a board as one of its own presets, to place again (like a token). */
export interface BoardShader {
  name: string;
  code: string;
}

export type ShaderParamKind = "number" | "color" | "choice";

export interface ShaderParam {
  /** Its key in a layer's params ("warp"). */
  key: string;
  /** Its uniform ("uWarp"). */
  uniform: string;
  label: string;
  kind: ShaderParamKind;
  glsl: "float" | "int" | "bool" | "vec3" | "vec4";
  min?: number;
  max?: number;
  step?: number;
  /** A length in design px: the shader gets it in drawn px, and the Scale tool scales it. */
  px?: boolean;
  options?: string[];
  default: number | string;
}

export interface ShaderPreset {
  id: string;
  name: string;
  /** What it is, in a line. */
  blurb: string;
  code: string;
  /** CSS a new layer of it starts with (film grain is laid over what's below it). */
  style?: Record<string, string>;
  /** How it blends with a frame's fills when it's given to one (film grain: Overlay). */
  blend?: string;
}

/** What the runtime gives every shader. */
export const SHADER_BUILTINS = ["uTime", "uRes", "uPx"] as const;
export const MAX_SHADER_CODE = 20_000;
/** The word a layer with code of its own has in data-shader. */
export const CUSTOM_SHADER = "custom";

// ---------------------------------------------------------------------------------------------
// The presets. Each is the same kind of code an agent writes, whole (it carries its own noise),
// so "Edit code" on one gives code that stands on its own.

const HASH = `float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }`;
const NOISE = `${HASH}
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
}
float fbm(vec2 p) {
  float v = 0.0, a = 0.5;
  for (int i = 0; i < 5; i++) { v += a * noise(p); p *= 2.0; a *= 0.5; }
  return v;
}`;

export const SHADER_PRESETS: ShaderPreset[] = [
  {
    id: "mesh-gradient",
    name: "Mesh gradient",
    blurb: "Four colours drift and melt into each other.",
    code: `// Mesh gradient: four colours that drift and melt into each other.
uniform vec3 uColor1; // @color = #ff6b3d "Colour 1"
uniform vec3 uColor2; // @color = #ffc94d "Colour 2"
uniform vec3 uColor3; // @color = #6b5cff "Colour 3"
uniform vec3 uColor4; // @color = #2ed1c7 "Colour 4"
uniform float uWarp; // @param 0..2 = 0.9 "Warp"
uniform float uSoftness; // @param 0..1 = 0.35 "Softness"
${NOISE}
void main() {
  vec2 uv = gl_FragCoord.xy / uRes;
  float t = uTime * 0.15 + 4.0;
  vec2 w = uv + uWarp * 0.22 * vec2(fbm(uv * 2.0 + t), fbm(uv * 2.0 - t + 5.0)) - uWarp * 0.11;
  vec2 p1 = vec2(0.2 + 0.15 * sin(t * 1.3), 0.3 + 0.2 * cos(t));
  vec2 p2 = vec2(0.8 + 0.1 * cos(t * 0.9), 0.25 + 0.15 * sin(t * 1.7));
  vec2 p3 = vec2(0.75 + 0.15 * sin(t * 1.1), 0.8 + 0.1 * cos(t * 1.4));
  vec2 p4 = vec2(0.25 + 0.12 * cos(t * 1.6), 0.78 + 0.15 * sin(t * 0.8));
  float k = 0.004 + uSoftness * uSoftness * 0.16;
  float d1 = 1.0 / (pow(distance(w, p1), 2.0) + k);
  float d2 = 1.0 / (pow(distance(w, p2), 2.0) + k);
  float d3 = 1.0 / (pow(distance(w, p3), 2.0) + k);
  float d4 = 1.0 / (pow(distance(w, p4), 2.0) + k);
  vec3 c = (uColor1 * d1 + uColor2 * d2 + uColor3 * d3 + uColor4 * d4) / (d1 + d2 + d3 + d4);
  gl_FragColor = vec4(c, 1.0);
}
`,
  },
  {
    id: "grain-gradient",
    name: "Grain gradient",
    blurb: "A slow wave of colour with film grain over it.",
    code: `// Grain gradient: a slow wave from shadow to light, with film grain over it.
uniform vec3 uShadow; // @color = #12173a "Shadow"
uniform vec3 uMiddle; // @color = #f27359 "Middle"
uniform vec3 uLight; // @color = #ffdb9e "Light"
uniform float uWave; // @param 0..1 = 0.3 "Wave"
uniform float uGrain; // @param 0..1 = 0.45 "Grain"
${HASH}
void main() {
  vec2 uv = gl_FragCoord.xy / uRes;
  float t = uTime * 0.6 + 1.0;
  float g = uv.y + uWave * 0.5 * sin(uv.x * 3.0 + t) + uWave * 0.15 * sin(uv.x * 7.0 - t * 1.3);
  vec3 c = mix(uShadow, uMiddle, smoothstep(0.05, 0.95, g));
  c = mix(c, uLight, smoothstep(0.65, 1.05, g) * 0.8);
  vec2 cell = floor(gl_FragCoord.xy / max(uPx, 1.0));
  c += (hash(cell + fract(uTime * 7.0) * 113.0) - 0.5) * uGrain * 0.38;
  gl_FragColor = vec4(c, 1.0);
}
`,
  },
  {
    id: "liquid-chrome",
    name: "Liquid chrome",
    blurb: "Bands of light folded over and over, like polished metal.",
    code: `// Liquid chrome: bands of light folded over and over, like polished metal.
uniform vec3 uMetal; // @color = #808fa8 "Metal"
uniform vec3 uTint; // @color = #523873 "Tint"
uniform float uFold; // @param 0..1.6 = 0.9 "Fold"
uniform float uScale; // @param 0.5..6 = 3 "Scale"
void main() {
  vec2 uv = (gl_FragCoord.xy - 0.5 * uRes) / uRes.y;
  float t = uTime * 0.35 + 2.0;
  vec2 p = uv * uScale;
  for (int i = 1; i < 8; i++) {
    float f = float(i);
    p += uFold * vec2(0.7 / f * sin(f * p.y + t + 0.3 * f), 0.5 / f * cos(f * p.x + t * 1.1));
  }
  float v = 0.5 + 0.5 * sin(p.x * 3.0 + p.y * 2.2);
  float w = 0.5 + 0.5 * sin(p.x * 1.3 - p.y * 2.7 + 1.7);
  vec3 c = uMetal * pow(v, 1.3) + vec3(1.0) * pow(v, 16.0) * 0.95 + vec3(0.05, 0.06, 0.09) * (1.0 - v);
  c += vec3(0.85, 0.9, 1.0) * pow(w, 24.0) * 0.5;
  c += uTint * (0.5 + 0.5 * sin(p.y * 3.0)) * 0.3;
  gl_FragColor = vec4(c, 1.0);
}
`,
  },
  {
    id: "dither",
    name: "Dither",
    blurb: "Moving clouds drawn in two colours, pixel by pixel.",
    code: `// Dither: moving clouds drawn with two colours, pixel by pixel (an 8×8 Bayer pattern).
uniform vec3 uInk; // @color = #1f1c2b "Ink"
uniform vec3 uPaper; // @color = #f0ebdb "Paper"
uniform float uPixel; // @param 1..12 = 3 step 1 px "Pixel"
uniform float uScale; // @param 0.5..8 = 3 "Scale"
${NOISE}
float bayer2(vec2 a) { a = floor(a); return fract(a.x / 2.0 + a.y * a.y * 0.75); }
float bayer4(vec2 a) { return bayer2(0.5 * a) * 0.25 + bayer2(a); }
float bayer8(vec2 a) { return bayer4(0.5 * a) * 0.25 + bayer2(a); }
void main() {
  float s = max(uPixel, 1.0);
  vec2 cell = floor(gl_FragCoord.xy / s);
  vec2 uv = cell * s / uRes;
  float t = uTime * 0.12 + 1.0;
  vec2 q = vec2(uv.x * uRes.x / uRes.y, uv.y) * uScale * 0.75;
  float v = smoothstep(0.28, 0.72, fbm(q + vec2(t, -t * 0.7)));
  float on = step(bayer8(cell), v);
  gl_FragColor = vec4(mix(uInk, uPaper, on), 1.0);
}
`,
  },
  {
    id: "halftone",
    name: "Halftone",
    blurb: "Ink dots on a screen that grow and shrink with the light.",
    code: `// Halftone: ink dots on an angled screen that grow and shrink with the light.
uniform vec3 uInk; // @color = #1c338c "Ink"
uniform vec3 uPaper; // @color = #f7f0de "Paper"
uniform float uSpacing; // @param 4..40 = 11 px "Spacing"
uniform float uAngle; // @param 0..90 = 30 step 1 "Angle"
uniform float uScale; // @param 0.5..6 = 2.4 "Scale"
${NOISE}
void main() {
  float s = max(uSpacing, 2.0);
  float a = radians(uAngle);
  mat2 r = mat2(cos(a), sin(a), -sin(a), cos(a));
  vec2 p = r * gl_FragCoord.xy;
  vec2 cell = (floor(p / s) + 0.5) * s;
  vec2 uv = (cell * r) / uRes;
  float t = uTime * 0.2 + 1.0;
  vec2 q = vec2(uv.x * uRes.x / uRes.y, uv.y);
  float v = 0.65 * fbm(q * uScale + vec2(t, t * 0.6)) + 0.45 * (1.0 - distance(uv, vec2(0.5 + 0.25 * sin(t * 1.3), 0.5)));
  float rad = s * 0.62 * clamp(v, 0.0, 1.0);
  float ink = 1.0 - smoothstep(rad - 0.75, rad + 0.75, distance(p, cell));
  gl_FragColor = vec4(mix(uPaper, uInk, ink), 1.0);
}
`,
  },
  {
    id: "light-rays",
    name: "Light rays",
    blurb: "Shafts of light sweeping slowly from above.",
    code: `// Light rays: shafts of light that sweep slowly down from above.
uniform vec3 uLight; // @color = #ffcc85 "Light"
uniform vec3 uSky; // @color = #090a14 "Sky"
uniform vec3 uGlow; // @color = #4059e6 "Glow"
uniform float uRays; // @param 0.5..3 = 1.4 "Rays"
uniform float uIntensity; // @param 0..2 = 1.15 "Intensity"
void main() {
  vec2 uv = (gl_FragCoord.xy - vec2(0.5 * uRes.x, uRes.y * 1.08)) / uRes.y;
  float t = uTime * 0.25 + 1.0;
  float a = atan(uv.x, -uv.y), r = length(uv);
  float rays = 0.5 + 0.5 * sin(a * uRays * 6.0 + sin(a * 3.0 + t) * 2.0 + t);
  rays *= 0.55 + 0.45 * sin(a * uRays * 11.0 - t * 1.3);
  float fall = exp(-r * 1.15);
  vec3 c = uSky + uLight * rays * fall * uIntensity + uGlow * fall * 0.25;
  gl_FragColor = vec4(c, 1.0);
}
`,
  },
  {
    id: "waves",
    name: "Waves",
    blurb: "Layers of sea rolling by, far ones above, near ones below.",
    code: `// Waves: layers of sea rolling by, the far ones high up, the near ones low and bright.
uniform vec3 uFar; // @color = #0b1e3f "Far"
uniform vec3 uNear; // @color = #2f7dff "Near"
uniform vec3 uCrest; // @color = #bfe6ff "Crest"
uniform float uLayers; // @param 2..10 = 6 step 1 "Layers"
uniform float uHeight; // @param 0..1 = 0.5 "Height"
uniform float uFrequency; // @param 0.5..6 = 2 "Frequency"
void main() {
  vec2 uv = gl_FragCoord.xy / uRes;
  float aspect = uRes.x / uRes.y;
  float t = uTime * 0.5 + 2.0;
  float edge = 1.5 / uRes.y;
  vec3 c = mix(uFar * 0.55, uFar * 0.9, uv.y);
  for (int i = 0; i < 10; i++) {
    float fi = float(i);
    if (fi >= uLayers) break;
    float k = fi / max(uLayers - 1.0, 1.0);
    float base = 0.82 - 0.72 * k;
    float x = uv.x * aspect * uFrequency;
    float y = base + uHeight * 0.07 * (sin(x * (1.0 + 0.25 * fi) + t * (0.6 + 0.5 * k) + fi * 1.7) + 0.5 * sin(x * 2.3 - t * 0.9 + fi * 2.9));
    float fill = smoothstep(y + edge, y - edge, uv.y);
    vec3 layer = mix(uFar, uNear, k);
    layer = mix(layer * 0.82, layer, smoothstep(y - 0.25, y, uv.y));
    layer = mix(layer, uCrest, smoothstep(y - 0.035, y, uv.y) * (0.15 + 0.45 * k));
    c = mix(c, layer, fill);
  }
  gl_FragColor = vec4(c, 1.0);
}
`,
  },
  {
    id: "aurora",
    name: "Aurora",
    blurb: "Curtains of northern light over a starry sky.",
    code: `// Aurora: curtains of northern light rippling over a starry sky.
uniform vec3 uSky; // @color = #050816 "Sky"
uniform vec3 uGlow1; // @color = #2bffb1 "Glow 1"
uniform vec3 uGlow2; // @color = #8a5cff "Glow 2"
uniform float uIntensity; // @param 0..2 = 1 "Intensity"
uniform float uStars; // @param 0..1 = 0.5 "Stars"
${NOISE}
void main() {
  vec2 uv = gl_FragCoord.xy / uRes;
  float x = uv.x * uRes.x / uRes.y;
  float t = uTime * 0.12 + 3.0;
  vec3 c = mix(uSky * 2.2 + vec3(0.01, 0.02, 0.04), uSky, smoothstep(0.0, 0.7, uv.y));
  vec2 sp = floor(gl_FragCoord.xy / max(2.0 * uPx, 1.0));
  float star = step(1.0 - 0.006 * uStars, hash(sp)) * (0.55 + 0.45 * sin(uTime * 2.0 + hash(sp + 7.0) * 6.28));
  c += vec3(star) * smoothstep(0.25, 0.9, uv.y);
  vec3 glow = vec3(0.0);
  for (int i = 0; i < 3; i++) {
    float fi = float(i);
    float yc = 0.3 + 0.13 * fi + 0.08 * sin(x * 1.4 + t * (1.0 + 0.3 * fi) + fi * 2.0) + 0.16 * (fbm(vec2(x * 0.7 + fi * 3.1, t * 0.5)) - 0.5);
    float d = uv.y - yc;
    // Bright along its lower edge, fading up into the sky (and a little below it).
    float curtain = exp(-max(d, 0.0) * (3.2 + 1.2 * fi)) * exp(-max(-d, 0.0) * 22.0);
    float streak = 0.25 + 0.75 * fbm(vec2(x * 9.0 + fi * 5.0 + t * 0.6, uv.y * 0.8 - t * 0.2));
    vec3 col = mix(uGlow1, uGlow2, clamp(d * 2.2 + fi * 0.3, 0.0, 1.0));
    glow += col * curtain * streak * (0.85 - 0.2 * fi);
  }
  c += glow * uIntensity;
  gl_FragColor = vec4(c, 1.0);
}
`,
  },
  {
    id: "contours",
    name: "Contours",
    blurb: "Lines of a topographic map, slowly shifting.",
    code: `// Contours: the lines of a topographic map, slowly shifting.
uniform vec3 uLines; // @color = #e9f0e6 "Lines"
uniform vec3 uGround; // @color = #17241f "Ground"
uniform float uDensity; // @param 4..40 = 14 step 1 "Density"
uniform float uThickness; // @param 0.5..4 = 1.2 px "Thickness"
uniform float uScale; // @param 0.5..6 = 1.5 "Scale"
${NOISE}
float height(vec2 q, float t) { return fbm(q + vec2(t, -t * 0.6)) + 0.35 * noise(q * 1.7 - t); }
void main() {
  vec2 q = gl_FragCoord.xy / uRes.y * uScale;
  float t = uTime * 0.05 + 1.0;
  float px = uScale / uRes.y;
  float h = height(q, t);
  float gx = height(q + vec2(px, 0.0), t) - h;
  float gy = height(q + vec2(0.0, px), t) - h;
  float v = h * uDensity;
  float slope = max(length(vec2(gx, gy)) * uDensity, 1e-4);
  float d = min(fract(v), 1.0 - fract(v)) / slope;
  float line = 1.0 - smoothstep(uThickness * 0.5, uThickness * 0.5 + 1.0, d);
  vec3 ground = uGround * (0.85 + 0.3 * h);
  gl_FragColor = vec4(mix(ground, uLines, line * 0.9), 1.0);
}
`,
  },
  {
    id: "film-grain",
    name: "Film grain",
    blurb: "Moving grain to lay over anything (blended as Overlay).",
    style: { mixBlendMode: "overlay" },
    blend: "overlay",
    code: `// Film grain: moving grain, see-through, to lay over other layers (blend mode Overlay suits it).
uniform float uAmount; // @param 0..1 = 0.5 "Amount"
uniform float uGrainSize; // @param 1..4 = 1 px "Size"
${HASH}
void main() {
  vec2 cell = floor(gl_FragCoord.xy / max(uGrainSize, 1.0));
  float n = hash(cell + fract(uTime * 7.0) * 113.0);
  gl_FragColor = vec4(vec3(n), uAmount);
}
`,
  },
  {
    id: "chromatic-metal",
    name: "Chromatic metal",
    blurb: "Liquid chrome with vivid spectral rainbow Fresnel dispersion.",
    code: `// Chromatic metal: liquid mercury folds with prismatic rainbow Fresnel bands.
uniform vec3 uShadow; // @color = #080a10 "Shadow"
uniform vec3 uHighlight; // @color = #ffffff "Highlight"
uniform float uDispersion; // @param 0..1 = 0.85 "Dispersion"
uniform float uScale; // @param 0.5..5 = 1.65 "Scale"
uniform float uWarp; // @param 0..2 = 0.9 "Warp"
uniform float uAngle; // @param -180..180 = -35 step 1 "Angle"
vec3 spectrum(float x) {
  return 0.5 + 0.5 * cos(6.28318 * (x + vec3(0.0, 0.33, 0.67)));
}
float field(vec2 p, float t) {
  vec2 q = p;
  for (int i = 1; i < 5; i++) {
    float fi = float(i);
    q += uWarp * 0.45 / fi * vec2(sin(fi * q.y + t + fi), cos(fi * q.x - t * 0.75 + fi * 1.4));
  }
  return 0.5 + 0.5 * sin(q.x * 2.0 + q.y * 1.6);
}
void main() {
  vec2 uv = (gl_FragCoord.xy - 0.5 * uRes) / min(uRes.x, uRes.y);
  float a = radians(uAngle);
  mat2 rot = mat2(cos(a), -sin(a), sin(a), cos(a));
  vec2 p = rot * uv * uScale;
  float t = uTime * 0.25 + 1.5;
  float eps = 0.02;
  float h = field(p, t);
  float hx = field(p + vec2(eps, 0.0), t) - h;
  float hy = field(p + vec2(0.0, eps), t) - h;
  vec3 n = normalize(vec3(-hx * 14.0, -hy * 14.0, 1.0));
  vec3 l = normalize(vec3(0.55, 0.7, 0.82));
  float diff = clamp(dot(n, l), 0.0, 1.0);
  float spec = pow(clamp(dot(reflect(-l, n), vec3(0.0, 0.0, 1.0)), 0.0, 1.0), 18.0);
  float band = smoothstep(0.26, 0.74, diff);
  vec3 c = mix(uShadow, uHighlight, pow(band, 0.9));
  // Vivid spectral rainbow fringe right along the dark-to-bright chrome horizon
  float rimBand = exp(-pow((diff - 0.48) * 4.4, 2.0));
  vec3 irid = spectrum(diff * 2.8 + h * 1.1 - 0.35);
  c = mix(c, irid * 1.25, rimBand * uDispersion);
  c += uHighlight * spec * 0.85;
  gl_FragColor = vec4(c, 1.0);
}
`,
  },
  {
    id: "glowing-particles",
    name: "Glowing particles",
    blurb: "Luminous soft bokeh orbs and sparkling dust drifting in depth.",
    code: `// Glowing particles: layered soft bokeh light orbs and sparkling micro-dust.
uniform vec3 uSky; // @color = #0c1242 "Backdrop"
uniform vec3 uColor1; // @color = #ff4de6 "Orb 1"
uniform vec3 uColor2; // @color = #48d8ff "Orb 2"
uniform vec3 uColor3; // @color = #ffe08a "Sparkle"
uniform float uDensity; // @param 0.5..2.5 = 1.1 "Density"
uniform float uGlow; // @param 0.2..2 = 1.25 "Glow"
${HASH}
vec3 orbLayer(vec2 uv, float scale, float t, float seed, float sizeMul) {
  vec2 gv = uv * scale;
  vec2 id = floor(gv);
  vec2 f = fract(gv) - 0.5;
  vec3 col = vec3(0.0);
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      vec2 offs = vec2(float(x), float(y));
      vec2 cid = id + offs;
      float h1 = hash(cid + seed);
      if (h1 > 0.62) continue;
      float h2 = hash(cid * 1.7 + seed + 19.3);
      float h3 = hash(cid * 2.3 + seed + 41.7);
      vec2 pos = offs + 0.36 * vec2(sin(t * (0.4 + h2 * 0.5) + h1 * 18.0), cos(t * (0.35 + h3 * 0.45) + h2 * 18.0));
      float d = length(f - pos);
      float rad = (0.14 + 0.32 * h3) * sizeMul;
      float core = exp(-d * d / (rad * rad * 0.38));
      float halo = exp(-d * d / (rad * rad * 1.5)) * 0.45;
      float pulse = 0.55 + 0.45 * sin(t * 1.3 + h1 * 30.0);
      vec3 c = h2 < 0.44 ? uColor1 : (h2 < 0.8 ? uColor2 : uColor3);
      col += c * (core + halo) * pulse;
    }
  }
  return col;
}
void main() {
  vec2 uv = (gl_FragCoord.xy - 0.5 * uRes) / uRes.y;
  float t = uTime * 0.5 + 3.0;
  vec3 c = mix(uSky * 0.72, uSky * 1.45, clamp(uv.y + 0.55, 0.0, 1.0));
  vec3 l1 = orbLayer(uv + vec2(t * 0.035, t * 0.02), 2.4 * uDensity, t, 1.0, 1.15);
  vec3 l2 = orbLayer(uv - vec2(t * 0.025, -t * 0.03), 5.0 * uDensity, t * 1.25, 17.0, 0.9);
  vec2 sp = floor(gl_FragCoord.xy / max(3.0 * uPx, 1.0));
  float spark = step(0.992, hash(sp)) * (0.45 + 0.55 * sin(t * 3.2 + hash(sp + 9.0) * 18.0));
  c += (l1 * 0.85 + l2 * 0.65) * uGlow + uColor3 * spark * 0.9;
  c = 1.0 - exp(-c * 1.2);
  gl_FragColor = vec4(c, 1.0);
}
`,
  },
  {
    id: "cmyk-halftone",
    name: "CMYK halftone",
    blurb: "Four-plate CMYK, RGB or monochrome halftone screen with dot, line and ring patterns.",
    code: `// CMYK halftone: four-angle print screen (Dot, Line or Ring) driven by flowing light.
uniform int uPattern; // @choice dot|line|ring = dot "Pattern"
uniform int uMode; // @choice cmyk|rgb|mono = cmyk "Color mode"
uniform float uDotSize; // @param 4..40 = 14 px "Dot size"
uniform float uDotScale; // @param 0.3..1.6 = 1.0 "Dot scale"
uniform float uSoftness; // @param 0..1 = 0.08 "Softness"
uniform float uRotation; // @param -180..180 = 0 step 1 "Rotation"
uniform vec3 uPaper; // @color = #fffdf6 "Paper"
${NOISE}
float screenDot(vec2 p, float ang, float s, float val) {
  float a = radians(ang + uRotation);
  mat2 r = mat2(cos(a), sin(a), -sin(a), cos(a));
  vec2 q = r * p;
  float soft = max(0.7, s * uSoftness * 0.45);
  if (uPattern == 1) {
    float d = abs(fract(q.y / s) - 0.5) * s;
    float w = s * 0.48 * uDotScale * val;
    return 1.0 - smoothstep(w - soft, w + soft, d);
  }
  vec2 cell = (floor(q / s) + 0.5) * s;
  float d = distance(q, cell);
  float rad = s * 0.56 * uDotScale * sqrt(clamp(val, 0.0, 1.0));
  if (uPattern == 2) {
    float ring = abs(d - rad * 0.72);
    return 1.0 - smoothstep(s * 0.12 - soft * 0.4, s * 0.12 + soft * 0.4, ring) * step(0.08, val);
  }
  return 1.0 - smoothstep(rad - soft, rad + soft, d);
}
void main() {
  float s = max(uDotSize, 3.0);
  vec2 uv = gl_FragCoord.xy / uRes;
  vec2 p = gl_FragCoord.xy - 0.5 * uRes;
  float t = uTime * 0.2 + 2.0;
  float n1 = fbm(uv * 2.6 + vec2(t, t * 0.5));
  float n2 = fbm(uv * 2.6 + vec2(-t * 0.7 + 4.1, t * 0.4));
  float n3 = fbm(uv * 2.2 + vec2(t * 0.4, -t * 0.8 + 8.3));
  vec3 src = vec3(
    smoothstep(0.22, 0.82, n1),
    smoothstep(0.22, 0.82, n2),
    smoothstep(0.22, 0.82, n3)
  );
  if (uMode == 1) {
    float r = screenDot(p, 15.0, s, src.r);
    float g = screenDot(p, 75.0, s, src.g);
    float b = screenDot(p, 45.0, s, src.b);
    gl_FragColor = vec4(vec3(r, g, b), 1.0);
    return;
  }
  if (uMode == 2) {
    float lum = dot(src, vec3(0.299, 0.587, 0.114));
    float k = screenDot(p, 45.0, s, 1.0 - lum);
    gl_FragColor = vec4(mix(uPaper, vec3(0.08, 0.08, 0.1), k), 1.0);
    return;
  }
  float kVal = 1.0 - max(src.r, max(src.g, src.b));
  float denom = max(1.0 - kVal, 0.001);
  float cVal = (1.0 - src.r - kVal) / denom;
  float mVal = (1.0 - src.g - kVal) / denom;
  float yVal = (1.0 - src.b - kVal) / denom;
  float cDot = screenDot(p, 15.0, s, cVal);
  float mDot = screenDot(p, 75.0, s, mVal);
  float yDot = screenDot(p, 0.0, s, yVal);
  float kDot = screenDot(p, 45.0, s, kVal * 0.85);
  vec3 col = uPaper;
  col *= mix(vec3(1.0), vec3(0.06, 0.78, 0.96), cDot);
  col *= mix(vec3(1.0), vec3(0.96, 0.14, 0.58), mDot);
  col *= mix(vec3(1.0), vec3(1.0, 0.9, 0.08), yDot);
  col *= mix(vec3(1.0), vec3(0.08, 0.08, 0.11), kDot);
  gl_FragColor = vec4(col, 1.0);
}
`,
  },
  {
    id: "pattern-refraction",
    name: "Pattern refraction",
    blurb: "Fluted and lenticular glass ribs bending colorful light and caustics.",
    code: `// Pattern refraction: fluted and lenticular glass ribs refracting flowing light with dispersion.
uniform int uPattern; // @choice lenticular|waves|ripple = waves "Pattern"
uniform vec3 uColor1; // @color = #0f3d56 "Deep"
uniform vec3 uColor2; // @color = #48d1b5 "Mid"
uniform vec3 uColor3; // @color = #f7e6a1 "Light"
uniform float uRibs; // @param 4..36 = 14 "Ribs"
uniform float uStrength; // @param 0..2 = 1.0 "Strength"
uniform float uDispersion; // @param 0..1 = 0.5 "Dispersion"
uniform float uAngle; // @param -180..180 = 35 step 1 "Angle"
${NOISE}
float fbm3(vec2 p) {
  float v = 0.0, a = 0.55;
  for (int i = 0; i < 3; i++) { v += a * noise(p); p = p * 2.02 + 13.7; a *= 0.5; }
  return v;
}
vec3 backdrop(vec2 uv, float t) {
  float n = fbm3(uv * 2.2 + vec2(t * 0.25, -t * 0.18));
  float n2 = fbm3(uv * 3.0 - vec2(t * 0.2, t * 0.25) + 4.2);
  vec3 c = mix(uColor1, uColor2, smoothstep(0.22, 0.72, n));
  return mix(c, uColor3, smoothstep(0.48, 0.88, n2));
}
void main() {
  vec2 uv = gl_FragCoord.xy / uRes;
  vec2 p = (gl_FragCoord.xy - 0.5 * uRes) / uRes.y;
  float a = radians(uAngle);
  mat2 rot = mat2(cos(a), -sin(a), sin(a), cos(a));
  vec2 q = rot * p;
  float t = uTime * 0.4 + 2.0;
  float coord = q.x * uRibs;
  if (uPattern == 1) coord += sin(q.y * 4.2 + t * 0.6) * 1.4;
  else if (uPattern == 2) coord = length(p) * uRibs - t * 0.4;
  float ph = fract(coord);
  float slope = (ph - 0.5) * 2.0;
  vec2 dir = uPattern == 2 ? normalize(p + vec2(1e-4)) : vec2(cos(a), sin(a));
  vec2 baseShift = dir * slope * 0.08 * uStrength;
  float disp = uDispersion * 0.025 * uStrength;
  vec3 c;
  c.r = backdrop(uv + baseShift - dir * disp, t).r;
  c.g = backdrop(uv + baseShift, t).g;
  c.b = backdrop(uv + baseShift + dir * disp, t).b;
  float spec = pow(max(0.0, 1.0 - abs(ph - 0.28) * 5.0), 3.0) * 0.35;
  float shade = 0.86 + 0.24 * sin(ph * 3.14159);
  c = c * shade + vec3(spec);
  gl_FragColor = vec4(c, 1.0);
}
`,
  },
  {
    id: "moving-blobs",
    name: "Moving blobs",
    blurb: "Organic chromatic fluid contours and iridescent liquid blobs.",
    code: `// Moving blobs: organic iridescent fluid contours flowing across the frame.
uniform vec3 uBase; // @color = #0c2233 "Base"
uniform vec3 uAccent; // @color = #25a7b8 "Accent"
uniform vec3 uLight; // @color = #f2f4f7 "Light"
uniform float uScale; // @param 0.5..6 = 2.4 "Scale"
uniform float uWarp; // @param 0..2 = 1.15 "Warp"
uniform float uIridescence; // @param 0..1 = 0.6 "Iridescence"
${NOISE}
float fbm4(vec2 p) {
  float v = 0.0, a = 0.52;
  for (int i = 0; i < 4; i++) { v += a * noise(p); p = p * 2.02 + 13.7; a *= 0.5; }
  return v;
}
vec3 spectrum(float x) { return 0.5 + 0.5 * cos(6.28318 * (x + vec3(0.0, 0.33, 0.67))); }
void main() {
  vec2 uv = (gl_FragCoord.xy - 0.5 * uRes) / uRes.y * uScale;
  float t = uTime * 0.18 + 3.0;
  vec2 w1 = vec2(fbm4(uv + t * 0.4), fbm4(uv + vec2(5.2, 1.3) - t * 0.3));
  vec2 w2 = vec2(fbm4(uv + uWarp * 2.2 * w1 + vec2(1.7, 9.2)), fbm4(uv + uWarp * 2.2 * w1 + vec2(8.3, 2.8)));
  float v = fbm4(uv + uWarp * 2.4 * w2);
  float rings = 0.5 + 0.5 * sin(v * 26.0);
  vec3 c = mix(uBase, uAccent, smoothstep(0.2, 0.72, v));
  c = mix(c, uLight, smoothstep(0.66, 0.88, v));
  float ridge = smoothstep(0.7, 0.98, rings) * 0.35;
  c = mix(c, spectrum(v * 3.0 + length(w2)), ridge * uIridescence);
  c += vec3(0.12) * pow(smoothstep(0.55, 0.95, w2.x), 3.0);
  gl_FragColor = vec4(c, 1.0);
}
`,
  },
  {
    id: "iridescent-glass",
    name: "Iridescent glass",
    blurb: "Thin-film soap-bubble and liquid-glass prism sheen (great standalone or blended).",
    code: `// Iridescent glass: silky thin-film interference rainbow pearl & liquid glass sheen.
uniform vec3 uBase; // @color = #e8efff "Glass tint"
uniform float uShift; // @param 0..2 = 0.75 "Prism shift"
uniform float uRipple; // @param 0..2 = 0.85 "Ripple"
uniform float uGloss; // @param 0..2 = 1.15 "Gloss"
vec3 thinFilm(float x) {
  return 0.62 + 0.36 * cos(6.28318 * (x + vec3(0.0, 0.27, 0.58)));
}
float glassH(vec2 p, float t) {
  float a = sin(p.x * 2.3 + t * 0.65) * cos(p.y * 2.1 - t * 0.5);
  float b = sin((p.x * 1.4 - p.y * 1.9) * 1.8 + t * 0.45);
  float c = cos(length(p - vec2(0.3 * sin(t * 0.4), 0.25 * cos(t * 0.35))) * 3.6 - t * 0.7);
  return (a * 0.45 + b * 0.32 + c * 0.23) * uRipple;
}
void main() {
  vec2 p = (gl_FragCoord.xy - 0.5 * uRes) / min(uRes.x, uRes.y) * 1.7;
  float t = uTime * 0.45 + 1.0;
  float eps = 0.025;
  float h = glassH(p, t);
  float gx = glassH(p + vec2(eps, 0.0), t) - h;
  float gy = glassH(p + vec2(0.0, eps), t) - h;
  vec3 n = normalize(vec3(-gx * 12.0, -gy * 12.0, 1.0));
  float fresnel = pow(1.0 - max(n.z, 0.0), 1.6);
  vec3 irid = thinFilm(h * 0.65 + fresnel * 1.25 + p.x * 0.18 + uShift * 0.5);
  vec3 l = normalize(vec3(-0.55, 0.72, 0.88));
  float spec = pow(max(dot(reflect(-l, n), vec3(0.0, 0.0, 1.0)), 0.0), 20.0);
  vec3 c = mix(uBase, irid, 0.38 + 0.56 * fresnel);
  c += vec3(1.0) * spec * 0.85 * uGloss;
  gl_FragColor = vec4(c, 1.0);
}
`,
  },
  {
    id: "caustics",
    name: "Water caustics",
    blurb: "Sunlit refractive light webs shimmering through clear water.",
    code: `// Water caustics: sunlit Voronoi optical light webs with subtle chromatic dispersion.
uniform vec3 uDeep; // @color = #062849 "Deep"
uniform vec3 uWater; // @color = #0ea5c6 "Water"
uniform vec3 uLight; // @color = #d8fbff "Light"
uniform float uScale; // @param 1..10 = 4.5 "Scale"
uniform float uIntensity; // @param 0.2..2 = 1.15 "Intensity"
uniform float uDispersion; // @param 0..1 = 0.35 "Dispersion"
${HASH}
float caustic(vec2 p, float t) {
  vec2 n = floor(p), f = fract(p);
  float md = 8.0, md2 = 8.0;
  for (int j = -1; j <= 1; j++) {
    for (int i = -1; i <= 1; i++) {
      vec2 g = vec2(float(i), float(j));
      float h = hash(n + g);
      float h2 = hash(n + g + 17.3);
      vec2 o = 0.5 + 0.42 * vec2(sin(t + h * 6.283), cos(t * 0.9 + h2 * 6.283));
      float d = length(g + o - f);
      if (d < md) { md2 = md; md = d; }
      else if (d < md2) { md2 = d; }
    }
  }
  return pow(clamp(1.0 - (md2 - md) * 2.4, 0.0, 1.0), 3.2);
}
void main() {
  vec2 uv = (gl_FragCoord.xy - 0.5 * uRes) / uRes.y * uScale;
  float t = uTime * 0.75 + 2.0;
  vec2 off = vec2(0.035, 0.02) * uDispersion;
  float sub = 0.55 * caustic(uv * 1.45 + 3.1, -t * 0.7);
  float r = caustic(uv + off, t) + sub;
  float g = caustic(uv, t) + sub;
  float b = caustic(uv - off, t) + sub;
  vec3 base = mix(uDeep, uWater, clamp(gl_FragCoord.y / uRes.y * 0.8 + 0.15, 0.0, 1.0));
  vec3 c = base + uLight * vec3(r, g, b) * 0.85 * uIntensity;
  gl_FragColor = vec4(c, 1.0);
}
`,
  },
  {
    id: "prism-voronoi",
    name: "Voronoi crystal",
    blurb: "Faceted refractive crystal glass cells with glowing bevel edges.",
    code: `// Voronoi crystal: faceted refractive crystal cells with glowing bevel edges.
uniform vec3 uBase; // @color = #14132e "Base"
uniform vec3 uFacet; // @color = #4c6ef5 "Facet"
uniform vec3 uEdge; // @color = #e0f2fe "Bevel"
uniform float uCells; // @param 2..12 = 5.5 "Cells"
uniform float uGloss; // @param 0..2 = 1.1 "Gloss"
${HASH}
void main() {
  vec2 p = (gl_FragCoord.xy - 0.5 * uRes) / uRes.y * uCells;
  float t = uTime * 0.35 + 1.5;
  vec2 n = floor(p), f = fract(p);
  float md = 8.0, md2 = 8.0;
  vec2 bestId = vec2(0.0);
  vec2 bestDiff = vec2(0.0);
  for (int j = -1; j <= 1; j++) {
    for (int i = -1; i <= 1; i++) {
      vec2 g = vec2(float(i), float(j));
      vec2 cid = n + g;
      float h1 = hash(cid), h2 = hash(cid + 31.7);
      vec2 o = 0.5 + 0.4 * vec2(sin(t + h1 * 6.283), cos(t * 0.85 + h2 * 6.283));
      vec2 diff = g + o - f;
      float d = length(diff);
      if (d < md) { md2 = md; md = d; bestId = cid; bestDiff = diff; }
      else if (d < md2) { md2 = d; }
    }
  }
  float h = hash(bestId + 7.1);
  float edge = 1.0 - smoothstep(0.02, 0.14, md2 - md);
  vec3 normal = normalize(vec3(bestDiff * 2.2, 1.0));
  float light = clamp(dot(normal, normalize(vec3(sin(t * 0.6), 0.7, 0.9))), 0.0, 1.0);
  vec3 prism = 0.5 + 0.5 * cos(6.28318 * (h + light * 0.4 + vec3(0.0, 0.33, 0.67)));
  vec3 c = mix(uBase, mix(uFacet, prism, 0.38), 0.35 + 0.65 * light);
  c += uEdge * (edge * 0.65 + pow(light, 10.0) * 0.5) * uGloss;
  gl_FragColor = vec4(c, 1.0);
}
`,
  },
  {
    id: "silk-folds",
    name: "Silk folds",
    blurb: "Velvety 3D-lit flowing silk fabric ribbons with soft specular sheen.",
    code: `// Silk folds: velvety 3D-lit flowing fabric folds with soft anisotropic sheen.
uniform vec3 uShadow; // @color = #170d2e "Shadow"
uniform vec3 uFabric; // @color = #7c3aed "Fabric"
uniform vec3 uSheen; // @color = #f5d0fe "Sheen"
uniform float uFolds; // @param 1..10 = 4.2 "Folds"
uniform float uSoftness; // @param 0.2..2 = 1.0 "Softness"
float foldH(vec2 p, float t) {
  float sw = sin(p.y * 1.8 - t * 0.45) * 0.55 + cos(p.x * 1.3 + p.y * 0.9 + t * 0.35) * 0.45;
  float a = sin(p.x * uFolds + sw * 2.1 + t * 0.55);
  float b = cos(p.y * uFolds * 0.55 - sw * 1.6 + t * 0.4);
  float c = sin((p.x - p.y * 0.65) * uFolds * 0.72 + t * 0.3);
  return a * 0.5 + b * 0.32 + c * 0.18;
}
void main() {
  vec2 p = (gl_FragCoord.xy - 0.5 * uRes) / uRes.y * 1.7;
  float t = uTime * 0.5 + 1.0;
  float eps = 0.03;
  float h = foldH(p, t);
  float dx = foldH(p + vec2(eps, 0.0), t) - h;
  float dy = foldH(p + vec2(0.0, eps), t) - h;
  vec3 n = normalize(vec3(-dx * 8.0 / uSoftness, -dy * 8.0 / uSoftness, 1.0));
  vec3 l = normalize(vec3(-0.5, 0.75, 0.85));
  float diff = clamp(dot(n, l) * 0.65 + 0.35, 0.0, 1.0);
  float spec = pow(clamp(dot(reflect(-l, n), vec3(0.0, 0.0, 1.0)), 0.0, 1.0), 10.0);
  float rim = pow(1.0 - max(n.z, 0.0), 2.4);
  vec3 c = mix(uShadow, uFabric, smoothstep(0.15, 0.88, diff));
  c = mix(c, uSheen, clamp(spec * 0.75 + rim * 0.42, 0.0, 1.0));
  gl_FragColor = vec4(c, 1.0);
}
`,
  },
  {
    id: "nebula-plasma",
    name: "Domain nebula",
    blurb: "Multi-octave domain-warped cosmic nebula clouds and stars.",
    code: `// Domain nebula: multi-octave domain-warped cosmic energy clouds and twinkling stars.
uniform vec3 uSpace; // @color = #05060f "Space"
uniform vec3 uCloud1; // @color = #4f46e5 "Cloud 1"
uniform vec3 uCloud2; // @color = #ec4899 "Cloud 2"
uniform vec3 uCore; // @color = #fde68a "Core"
uniform float uScale; // @param 0.5..5 = 2.0 "Scale"
uniform float uStars; // @param 0..1 = 0.6 "Stars"
${NOISE}
float fbm4(vec2 p) {
  float v = 0.0, a = 0.52;
  for (int i = 0; i < 4; i++) { v += a * noise(p); p = p * 2.02 + 13.7; a *= 0.5; }
  return v;
}
void main() {
  vec2 uv = (gl_FragCoord.xy - 0.5 * uRes) / uRes.y * uScale;
  float t = uTime * 0.12 + 4.0;
  vec2 q = vec2(fbm4(uv + t * 0.25), fbm4(uv + vec2(5.2, 1.3) - t * 0.2));
  vec2 r = vec2(fbm4(uv + 2.4 * q + vec2(1.7, 9.2) + t * 0.15), fbm4(uv + 2.4 * q + vec2(8.3, 2.8) - t * 0.12));
  float f = fbm4(uv + 2.2 * r);
  vec3 c = mix(uSpace, uCloud1, smoothstep(0.22, 0.68, f));
  c = mix(c, uCloud2, smoothstep(0.32, 0.78, length(q) * 0.9) * smoothstep(0.3, 0.85, f));
  c += uCore * pow(smoothstep(0.58, 0.94, f * r.x * 1.45), 2.4) * 1.2;
  vec2 sp = floor(gl_FragCoord.xy / max(2.0 * uPx, 1.0));
  float st = step(1.0 - 0.005 * uStars, hash(sp)) * (0.5 + 0.5 * sin(uTime * 2.5 + hash(sp + 5.0) * 12.0));
  c += vec3(st) * 0.9;
  gl_FragColor = vec4(c, 1.0);
}
`,
  },
  {
    id: "holo-foil",
    name: "Holographic foil",
    blurb: "Collectible trading-card diffraction grating foil with rainbow shimmer.",
    code: `// Holographic foil: micro-grating diffraction rainbow shimmer like a foil card.
uniform vec3 uMetal; // @color = #202430 "Metal"
uniform float uIntensity; // @param 0..2 = 1.15 "Rainbow"
uniform float uGrating; // @param 20..180 = 80 "Grating"
uniform float uAngle; // @param -180..180 = 32 step 1 "Angle"
${NOISE}
vec3 rainbow(float x) { return 0.5 + 0.5 * cos(6.28318 * (x + vec3(0.0, 0.33, 0.67))); }
void main() {
  vec2 uv = gl_FragCoord.xy / uRes;
  vec2 p = (gl_FragCoord.xy - 0.5 * uRes) / uRes.y;
  float a = radians(uAngle);
  mat2 rot = mat2(cos(a), -sin(a), sin(a), cos(a));
  vec2 q = rot * p;
  float t = uTime * 0.45 + 1.0;
  float warp = fbm(q * 2.2 + vec2(t * 0.3, -t * 0.2));
  float sheen = sin(q.x * 5.0 + warp * 4.5 + t * 1.6);
  float lines = 0.88 + 0.12 * sin((q.x + q.y * 0.15) * uGrating + warp * 6.0);
  vec3 foil = rainbow(q.x * 0.85 + warp * 0.95 + t * 0.25);
  float gleam = pow(clamp(0.5 + 0.5 * sheen, 0.0, 1.0), 3.0);
  vec3 c = uMetal * (0.65 + 0.55 * gleam) + foil * (0.28 + 0.72 * gleam) * uIntensity;
  c *= lines;
  c += vec3(1.0) * pow(gleam, 8.0) * 0.45;
  gl_FragColor = vec4(c, 1.0);
}
`,
  },
  {
    id: "hatching",
    name: "Cross-hatching",
    blurb: "Hand-drawn ink cross-hatching strokes shaded by shifting light.",
    code: `// Cross-hatching: hand-drawn pen-and-ink strokes shaded by animated light.
uniform vec3 uInk; // @color = #18181b "Ink"
uniform vec3 uPaper; // @color = #f7f3e8 "Paper"
uniform float uSpacing; // @param 4..24 = 9 px "Spacing"
uniform float uWeight; // @param 0.5..3 = 1.2 "Weight"
uniform float uAngle; // @param -90..90 = 35 step 1 "Angle"
${NOISE}
float hatch(vec2 p, float deg, float sp, float w) {
  float a = radians(deg);
  float u = p.x * cos(a) + p.y * sin(a);
  float v = -p.x * sin(a) + p.y * cos(a);
  float jitter = (noise(vec2(v / (sp * 3.0), floor(u / sp) * 1.7)) - 0.5) * 0.22;
  float d = abs(fract(u / sp + jitter) - 0.5) * sp;
  return 1.0 - smoothstep(w * 0.45, w * 0.45 + 0.9, d);
}
void main() {
  float sp = max(uSpacing, 3.0);
  vec2 uv = gl_FragCoord.xy / uRes;
  float t = uTime * 0.14 + 2.0;
  float lum = fbm(uv * 2.5 + vec2(t, -t * 0.6));
  lum = clamp(lum * 1.15 - 0.08 + 0.18 * (1.0 - distance(uv, vec2(0.5 + 0.2 * sin(t * 2.0), 0.5))), 0.0, 1.0);
  float ink = 0.0;
  if (lum < 0.76) ink = max(ink, hatch(gl_FragCoord.xy, uAngle, sp, uWeight));
  if (lum < 0.54) ink = max(ink, hatch(gl_FragCoord.xy, uAngle + 90.0, sp, uWeight));
  if (lum < 0.34) ink = max(ink, hatch(gl_FragCoord.xy, uAngle + 45.0, sp * 0.85, uWeight * 0.95));
  if (lum < 0.18) ink = max(ink, hatch(gl_FragCoord.xy, uAngle - 45.0, sp * 0.75, uWeight * 1.1));
  vec3 paper = uPaper * (0.97 + 0.06 * hash(floor(gl_FragCoord.xy / max(uPx, 1.0))));
  gl_FragColor = vec4(mix(paper, uInk, ink), 1.0);
}
`,
  },
  {
    id: "crt-scanlines",
    name: "CRT scanlines",
    blurb: "Retro RGB phosphor scanlines and subtle signal glitch (blends over layers).",
    style: { mixBlendMode: "overlay" },
    blend: "overlay",
    code: `// CRT scanlines: retro phosphor subpixels, scanlines and rolling sync bar (blends well as Overlay).
uniform vec3 uTint; // @color = #67e8f9 "Phosphor"
uniform float uPitch; // @param 2..12 = 4 px "Pitch"
uniform float uScanlines; // @param 0..1 = 0.65 "Scanlines"
uniform float uGlitch; // @param 0..1 = 0.3 "Glitch"
${HASH}
void main() {
  float p = max(uPitch, 2.0);
  vec2 uv = gl_FragCoord.xy / uRes;
  float row = floor(gl_FragCoord.y / p);
  float sub = mod(floor(gl_FragCoord.x / max(p * 0.5, 1.0)), 3.0);
  vec3 mask = sub < 0.5 ? vec3(1.0, 0.35, 0.35) : (sub < 1.5 ? vec3(0.35, 1.0, 0.35) : vec3(0.35, 0.35, 1.0));
  float scan = 1.0 - uScanlines * 0.55 * step(0.55, fract(gl_FragCoord.y / p));
  float bar = exp(-pow(fract(uv.y - uTime * 0.18) - 0.5, 2.0) * 80.0) * 0.25;
  float tear = step(1.0 - 0.08 * uGlitch, hash(vec2(row, floor(uTime * 10.0)))) * uGlitch * 0.4;
  float vig = smoothstep(0.95, 0.35, length(uv - 0.5) * 1.2);
  vec3 c = mix(vec3(0.5), uTint * mask, 0.55) * scan * (0.75 + 0.25 * vig) + vec3(bar + tear);
  gl_FragColor = vec4(c, 0.72);
}
`,
  },
  {
    id: "dot-matrix",
    name: "LED matrix",
    blurb: "Glowing LED dot-matrix grid pulsing with flowing light waves.",
    code: `// LED matrix: crisp glowing dot-matrix display pulsing with flowing light waves.
uniform vec3 uOff; // @color = #0b0d14 "Panel"
uniform vec3 uLow; // @color = #2563eb "Low"
uniform vec3 uHigh; // @color = #a3e635 "High"
uniform float uPitch; // @param 6..32 = 12 px "Pitch"
uniform float uGlow; // @param 0..1.5 = 0.65 "Glow"
${NOISE}
void main() {
  float s = max(uPitch, 4.0);
  vec2 cell = floor(gl_FragCoord.xy / s);
  vec2 f = fract(gl_FragCoord.xy / s) - 0.5;
  vec2 uv = (cell + 0.5) * s / uRes;
  float t = uTime * 0.55 + 1.0;
  float v = fbm(uv * 3.5 + vec2(t * 0.35, -t * 0.25));
  v = clamp(v * 1.15 + 0.2 * sin(uv.x * 8.0 + t * 2.0), 0.0, 1.0);
  float d = length(f);
  float led = 1.0 - smoothstep(0.28, 0.36, d);
  float halo = exp(-d * d * 7.0) * uGlow * v;
  vec3 lit = mix(uLow, uHigh, smoothstep(0.3, 0.85, v));
  vec3 c = mix(uOff, lit, led * (0.2 + 0.8 * v)) + lit * halo * 0.55;
  gl_FragColor = vec4(c, 1.0);
}
`,
  },
];

export const presetOf = (id: string | undefined) => (id ? SHADER_PRESETS.find((p) => p.id === id) : undefined);

// ---------------------------------------------------------------------------------------------
// Code and its parameters

/** GLSL as the graphics card takes it: printable ASCII only (anything else becomes a space), and no longer than it may be. */
export function cleanShaderCode(code: unknown): string {
  return String(code ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/[^\t\n\x20-\x7e]/g, " ")
    .slice(0, MAX_SHADER_CODE);
}

/** A uniform's key: its name without the u ("uWarp" → "warp", "uColor1" → "color1"). */
export const shaderKey = (uniform: string) => (/^u[A-Z0-9]/.test(uniform) ? uniform[1].toLowerCase() + uniform.slice(2) : uniform);

/** A key in words: "color1" → "Colour 1", "grainSize" → "Grain size". */
export function shaderLabel(key: string): string {
  const words = key
    .replace(/([a-z])([A-Z0-9])/g, "$1 $2")
    .replace(/_/g, " ")
    .toLowerCase()
    .replace(/\bcolor\b/g, "colour")
    .trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

const nice = (n: number) => {
  const p = 10 ** Math.floor(Math.log10(Math.max(1e-9, n)));
  const m = n / p;
  return (m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10) * p;
};
const DECL = /^\s*uniform\s+(?:(?:lowp|mediump|highp)\s+)?(float|int|bool|vec2|vec3|vec4|mat\d|sampler\w*)\s+(\w+)\s*;\s*(?:\/\/(.*))?$/;
const parsed = new Map<string, { params: ShaderParam[]; warnings: string[] }>();

/**
 * A shader's parameters, from the `// @param`, `// @color` and `// @choice` comments on its uniforms
 * (see the top of this file), and what's wrong with any of them.
 */
export function parseShaderParams(code: string): { params: ShaderParam[]; warnings: string[] } {
  const known = parsed.get(code);
  if (known) return known;
  const params: ShaderParam[] = [];
  const warnings: string[] = [];
  const lines = code.split("\n");
  lines.forEach((line, i) => {
    const m = DECL.exec(line);
    if (!m) return;
    const [, glsl, uniform, comment = ""] = m;
    if ((SHADER_BUILTINS as readonly string[]).includes(uniform)) return;
    const at = `Line ${i + 1} (${uniform})`;
    const tag = /@(param|colou?r|choice)\b(.*)$/.exec(comment);
    if (!tag) {
      warnings.push(`${at} has no // @param, @color or @choice comment, so it stays 0 and gets no control.`);
      return;
    }
    const rest = tag[2];
    const quoted = /"([^"]{1,40})"/.exec(rest);
    const key = shaderKey(uniform);
    const label = quoted?.[1] ?? shaderLabel(key);
    const plain = rest.replace(/"[^"]*"/g, " ");
    if (tag[1] === "param") {
      if (glsl !== "float" && glsl !== "int") return void warnings.push(`${at}: @param is for a float or an int, not a ${glsl}.`);
      const r = /(-?\d*\.?\d+)\s*\.\.\s*(-?\d*\.?\d+)/.exec(plain);
      if (!r) return void warnings.push(`${at}: @param needs its range, e.g. // @param 0..2 = 1.`);
      const min = Number(r[1]);
      const max = Number(r[2]);
      if (!(max > min)) return void warnings.push(`${at}: its range ${min}..${max} runs backwards.`);
      const d = /=\s*(-?\d*\.?\d+)/.exec(plain);
      const s = /\bstep\s+(\d*\.?\d+)/.exec(plain);
      const step = glsl === "int" ? Math.max(1, Math.round(Number(s?.[1] ?? 1))) : s ? Number(s[1]) : nice((max - min) / 100);
      const def = Math.min(max, Math.max(min, d ? Number(d[1]) : min));
      params.push({ key, uniform, label, kind: "number", glsl, min, max, step, ...(/\bpx\b/.test(plain) ? { px: true } : {}), default: glsl === "int" ? Math.round(def) : def });
    } else if (tag[1].startsWith("colo")) {
      if (glsl !== "vec3" && glsl !== "vec4") return void warnings.push(`${at}: @color is for a vec3 (or a vec4, with alpha), not a ${glsl}.`);
      const d = /=\s*(\S+)/.exec(plain);
      const def = d && isShaderColor(d[1]) ? d[1] : "#ffffff";
      if (d && !isShaderColor(d[1])) warnings.push(`${at}: "${d[1]}" isn't a colour; it starts white.`);
      params.push({ key, uniform, label, kind: "color", glsl, default: def });
    } else {
      if (glsl !== "int" && glsl !== "float") return void warnings.push(`${at}: @choice is for an int (or a float), which gets the index of the word picked.`);
      const o = /([\w-]+(?:\s*\|\s*[\w-]+)+)/.exec(plain);
      if (!o) return void warnings.push(`${at}: @choice needs its words, e.g. // @choice soft|hard = soft.`);
      const options = o[1].split("|").map((w) => w.trim());
      const d = /=\s*([\w-]+)/.exec(plain);
      params.push({ key, uniform, label, kind: "choice", glsl, options, default: d && options.includes(d[1]) ? d[1] : options[0] });
    }
  });
  const out = { params, warnings };
  if (parsed.size > 200) parsed.clear();
  parsed.set(code, out);
  return out;
}

/** A colour a parameter may take: hex, a CSS colour function, a colour's name, or a token (var(--name), with a fallback). */
export function isShaderColor(v: unknown): v is string {
  if (typeof v !== "string") return false;
  const s = v.trim();
  if (!s || s.length > 160 || /[;{}<>"'`\\]|url\(|expression/i.test(s)) return false;
  return /^#[0-9a-f]{3,8}$/i.test(s) || /^(rgba?|hsla?|hwb|lab|lch|oklab|oklch|color|color-mix)\([-\w\s.,%/+()#]*\)$/i.test(s) || /^[a-z]{3,30}$/i.test(s) || /^var\(\s*--[\w-]+\s*(,[^;{}<>"'`\\]*)?\)$/i.test(s);
}

/** A value for a parameter, made safe: a number in its range (whole for an int), a colour, one of its words. Undefined if it can't be one. */
export function shaderParamValue(p: ShaderParam, raw: unknown): number | string | undefined {
  if (p.kind === "number") {
    const n = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() !== "" ? Number(raw.trim().replace(/px$/, "")) : NaN;
    if (!Number.isFinite(n)) return undefined;
    const v = Math.min(p.max ?? n, Math.max(p.min ?? n, n));
    return p.glsl === "int" ? Math.round(v) : Math.round(v * 1e4) / 1e4;
  }
  if (p.kind === "color") return isShaderColor(raw) ? raw.trim() : undefined;
  const opts = p.options ?? [];
  if (typeof raw === "number" && Number.isInteger(raw) && raw >= 0 && raw < opts.length) return opts[raw];
  if (typeof raw !== "string") return undefined;
  return opts.find((o) => o.toLowerCase() === raw.trim().toLowerCase());
}

/** Every parameter's value: the layer's own where it's good, else the default. */
export function shaderValues(params: ShaderParam[], given: Record<string, unknown> = {}): Record<string, number | string> {
  const out: Record<string, number | string> = {};
  for (const p of params) out[p.key] = shaderParamValue(p, given[p.key] ?? given[p.uniform]) ?? p.default;
  return out;
}

/**
 * What the runtime sets each uniform to: numbers (choices as their index), lengths as "12px" (it
 * turns them into drawn pixels), colours as CSS (it resolves tokens where it draws).
 */
export function shaderUniforms(code: string, given: Record<string, unknown> = {}): Record<string, number | string> {
  const { params } = parseShaderParams(code);
  const values = shaderValues(params, given);
  const out: Record<string, number | string> = {};
  for (const p of params) {
    const v = values[p.key];
    if (p.kind === "choice") out[p.uniform] = Math.max(0, (p.options ?? []).indexOf(String(v)));
    else if (p.kind === "number" && p.px) out[p.uniform] = `${v}px`;
    else out[p.uniform] = v;
  }
  return out;
}

/**
 * A layer's params as they're kept: only known ones, each made safe, keys as the shader names them
 * (a uniform's name is taken as its key). What was left out is said in `warnings`.
 */
export function cleanShaderParams(code: string, given: Record<string, unknown> = {}, warnings: string[] = []): Record<string, number | string> {
  const { params } = parseShaderParams(code);
  const out: Record<string, number | string> = {};
  for (const [k, raw] of Object.entries(given)) {
    const p = params.find((x) => x.key === k || x.uniform === k || x.key === shaderKey(k));
    if (!p) {
      warnings.push(`The shader has no parameter "${k}"${params.length ? ` (it has ${params.map((x) => x.key).join(", ")})` : ""}.`);
      continue;
    }
    if (raw === null || raw === undefined) continue;
    const v = shaderParamValue(p, raw);
    if (v === undefined) warnings.push(`"${String(raw).slice(0, 60)}" isn't a value for ${p.key} (${p.kind === "number" ? `a number from ${p.min} to ${p.max}` : p.kind === "color" ? "a colour: #hex, rgb(), a name or var(--token)" : `one of ${(p.options ?? []).join(", ")}`}).`);
    else out[p.key] = v;
  }
  return out;
}

/** The GLSL a layer draws with: its board's preset of that name, else a built-in one, else its own code. */
export function shaderCode(spec: ShaderSpec | undefined, own: BoardShader[] = []): string | undefined {
  if (!spec) return undefined;
  if (spec.preset && spec.preset !== CUSTOM_SHADER) {
    const mine = own.find((s) => s.name === spec.preset);
    if (mine) return mine.code;
    const p = presetOf(spec.preset);
    if (p) return p.code;
  }
  return spec.code ? cleanShaderCode(spec.code) : undefined;
}

const finite = (v: unknown, lo: number, hi: number) => {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : undefined;
};

/** A name a board's own preset may have: lower case words joined by -, not "custom". */
export const shaderPresetName = (name: string) =>
  String(name ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);

/**
 * A shader as it may be kept on a layer, from anything (HTML, an agent, JSON): a preset's name, GLSL,
 * parameter values that are numbers or plain strings, speed, time and paused within reason.
 */
export function cleanShaderSpec(raw: unknown): ShaderSpec {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const out: ShaderSpec = {};
  if (typeof r.preset === "string" && r.preset.trim() && r.preset.trim() !== CUSTOM_SHADER) out.preset = shaderPresetName(r.preset);
  if (typeof r.code === "string" && r.code.trim()) out.code = cleanShaderCode(r.code);
  if (r.params && typeof r.params === "object") {
    const p: Record<string, number | string> = {};
    for (const [k, v] of Object.entries(r.params as Record<string, unknown>).slice(0, 64)) {
      if (!/^[A-Za-z_]\w{0,40}$/.test(k)) continue;
      if (typeof v === "number" && Number.isFinite(v)) p[k] = v;
      else if (typeof v === "string" && v.length <= 160 && !/[;{}<>"`\\]|url\(/i.test(v)) p[k] = v.trim();
    }
    if (Object.keys(p).length) out.params = p;
  }
  const speed = finite(r.speed, -10, 10);
  if (speed !== undefined && speed !== 1) out.speed = Math.round(speed * 1000) / 1000;
  const time = finite(r.time, -1e5, 1e5);
  if (time !== undefined && time !== 0) out.time = Math.round(time * 1000) / 1000;
  if (r.paused === true || r.paused === "true" || r.paused === "") out.paused = true;
  if (typeof r.blend === "string" && SHADER_BLENDS.includes(r.blend.trim().toLowerCase()) && r.blend.trim().toLowerCase() !== "normal") out.blend = r.blend.trim().toLowerCase();
  return out;
}

/** How a shader can mix with the fills under it: CSS's blend modes. */
export const SHADER_BLENDS = ["normal", "multiply", "screen", "overlay", "darken", "lighten", "color-dodge", "color-burn", "hard-light", "soft-light", "difference", "exclusion", "hue", "saturation", "color", "luminosity"];

/** A shader scaled with its layer (the Scale tool): its lengths in px grow or shrink with it. Undefined when nothing changes. */
export function scaledShader(spec: ShaderSpec, code: string | undefined, k: number): ShaderSpec | undefined {
  if (!code) return undefined;
  const lengths = parseShaderParams(code).params.filter((p) => p.px);
  if (!lengths.length) return undefined;
  const values = shaderValues(lengths, spec.params);
  const params = { ...(spec.params ?? {}) };
  for (const p of lengths) params[p.key] = Math.round(Number(values[p.key]) * k * 100) / 100;
  return { ...spec, params };
}

// ---------------------------------------------------------------------------------------------
// HTML in and out. A frame with a shader is written as
//   <div data-shader="mesh-gradient" data-params='{"warp":1.2}' data-speed="0.5" data-time="3" data-paused style="…"><canvas …></canvas>…its layers…</div>
// (data-shader="custom" and data-code="…GLSL…" for code of its own). The canvas, its first child, is
// what's drawn on: placed over the frame's box, behind its layers (the frame is its own stacking
// context, and a place for the canvas). <canvas data-shader> is read the same, as a frame with
// nothing in it, and code may come in a <script type="x-shader/x-fragment"> inside it.

const escAttr = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

/** A frame's shader as attributes (after its style), for nodeHtml. `code`: carry its GLSL and what to draw it with, for a page that plays it. */
export function shaderAttrs(spec: ShaderSpec | undefined, own: BoardShader[] = [], opts: { code?: boolean } = {}): string {
  const s = spec ?? {};
  const preset = s.preset ?? CUSTOM_SHADER;
  let out = ` data-shader="${escAttr(preset)}"`;
  if (s.params && Object.keys(s.params).length) out += ` data-params="${escAttr(JSON.stringify(s.params))}"`;
  if (s.speed !== undefined && s.speed !== 1) out += ` data-speed="${s.speed}"`;
  if (s.time) out += ` data-time="${s.time}"`;
  if (s.paused) out += " data-paused";
  if (s.blend) out += ` data-blend="${escAttr(s.blend)}"`;
  const code = shaderCode(s, own);
  const builtIn = preset !== CUSTOM_SHADER && !own.some((x) => x.name === preset) && presetOf(preset);
  // A custom shader's code always goes with it; a board's preset carries its code too, so it still
  // draws on a board that lacks the preset; a built-in one only when the page is to play it.
  if (code && (opts.code || !builtIn)) out += ` data-code="${escAttr(code)}"`;
  if (code && opts.code) out += ` data-uniforms="${escAttr(JSON.stringify(shaderUniforms(code, s.params)))}"`;
  return out;
}

/** The canvas a frame's shader is drawn on, as CSS: over the frame's box, behind its layers, never in the way of a click. */
export const SHADER_CANVAS_CSS = "position:absolute;left:0;top:0;z-index:-1;display:block;width:100%;height:100%;border-radius:inherit;pointer-events:none";

/** The canvas inside a frame with a shader, which the runtime draws on (blended with the frame's fills as the shader says). */
export const shaderCanvas = (spec?: ShaderSpec) => `<canvas style="${SHADER_CANVAS_CSS}${spec?.blend ? `;mix-blend-mode:${spec.blend}` : ""}"></canvas>`;
export const SHADER_CANVAS = shaderCanvas();

/**
 * What a frame with a shader adds to its own CSS: its own stacking context (so the canvas sits
 * behind its layers, over its fills) and, when it isn't placed already, a place for the canvas.
 */
export function shaderBoxStyle(style: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  if (!style.isolation || style.isolation === "auto") out.isolation = "isolate";
  if (!style.position || style.position === "static") out.position = "relative";
  return out;
}

/** A shader from an element's attributes (and the code in a <script> inside it), as written by boards or an agent. */
export function shaderFromAttrs(attrs: Record<string, string>, script: string | undefined, warnings: string[] = []): ShaderSpec {
  const raw: Record<string, unknown> = { preset: attrs["data-shader"], code: attrs["data-code"] ?? script };
  if (attrs["data-params"]) {
    try {
      raw.params = JSON.parse(attrs["data-params"]);
    } catch {
      warnings.push(`data-params isn't JSON: write it as data-params='{"warp": 1.2, "color1": "#ff5a1f"}'.`);
    }
  }
  if (attrs["data-speed"] !== undefined) raw.speed = attrs["data-speed"];
  if (attrs["data-time"] !== undefined) raw.time = attrs["data-time"];
  if (attrs["data-paused"] !== undefined && attrs["data-paused"] !== "false") raw.paused = true;
  if (attrs["data-blend"] !== undefined) raw.blend = attrs["data-blend"];
  const spec = cleanShaderSpec(raw);
  if (raw.params && typeof raw.params === "object")
    for (const [k, v] of Object.entries(raw.params as Record<string, unknown>)) if (spec.params?.[k] === undefined) warnings.push(`data-params "${k}" was left out: ${JSON.stringify(v)?.slice(0, 60)} isn't a value a shader parameter takes (a number, a colour, or a word).`);
  if (!spec.preset && !spec.code) warnings.push(`A shader needs a preset (data-shader="${SHADER_PRESETS[0].id}"; there are ${SHADER_PRESETS.map((p) => p.id).join(", ")}) or GLSL code (data-shader="custom" with data-code, or a <script type="x-shader/x-fragment"> inside it).`);
  return spec;
}

/** How board_read describes a frame's shader. */
export function shaderWords(spec: ShaderSpec | undefined, own: BoardShader[] = []): string {
  const s = spec ?? {};
  const mine = s.preset ? own.find((x) => x.name === s.preset) : undefined;
  const bits: string[] = [];
  if (mine) bits.push(`shader "${s.preset}" (this board's preset)`);
  else if (s.preset && presetOf(s.preset)) bits.push(`shader "${s.preset}" (preset)`);
  else if (s.code) bits.push(`shader of its own code (${s.code.split("\n").length} lines)${s.preset ? `, from the preset "${s.preset}" (not on this board)` : ""}`);
  else bits.push(`shader with no code (unknown preset "${s.preset ?? ""}")`);
  if (s.params && Object.keys(s.params).length) bits.push(`params ${Object.entries(s.params).map(([k, v]) => `${k}=${v}`).join(" ")}`);
  if (s.speed !== undefined && s.speed !== 1) bits.push(`speed ${s.speed}`);
  if (s.time) bits.push(`still at ${s.time}s`);
  if (s.paused) bits.push("paused");
  if (s.blend) bits.push(`blended as ${s.blend}`);
  return bits.join(", ");
}

/** The presets and their parameters, in words, for agents. */
export function shaderCatalog(own: BoardShader[] = []): string {
  const one = (id: string, blurb: string, code: string) => {
    const { params } = parseShaderParams(code);
    const list = params.map((p) => (p.kind === "number" ? `${p.key} ${p.min}..${p.max} (${p.default}${p.px ? " px" : ""})` : p.kind === "color" ? `${p.key} colour (${p.default})` : `${p.key} ${(p.options ?? []).join("|")} (${p.default})`));
    return `- ${id}: ${blurb} Params: ${list.join(", ") || "none"}.`;
  };
  const lines = SHADER_PRESETS.map((p) => one(p.id, p.blurb, p.code));
  if (own.length) lines.push("This board's own presets:", ...own.map((s) => one(s.name, "", s.code)));
  return lines.join("\n");
}
