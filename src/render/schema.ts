import { z } from "zod";

// ---------------------------------------------------------------------------------------------
// Background

export const TreatmentShape = {
  blur: z.number().min(0).optional().describe("Gaussian blur: a fraction of canvas width up to 0.5 (0.01 = soft, 0.04 = heavy), or px above that."),
  motionBlur: z.number().min(0).optional().describe("Directional motion blur: a fraction of canvas width up to 0.5 (0.05–0.09 gives the streaked 'meadow-motion' look), or px above that."),
  motionAngle: z.number().optional().describe("Motion blur direction in degrees (0 = horizontal)."),
  brightness: z.number().optional().describe("1 = unchanged."),
  contrast: z.number().optional().describe("1 = unchanged."),
  saturation: z.number().optional().describe("1 = unchanged, 0 = greyscale."),
  tint: z.string().optional().describe("Colour washed over the photo."),
  tintAmount: z.number().min(0).max(1).optional().describe("Opacity of the tint wash (0–1). Default 0.15 when tint is set."),
  haze: z.number().min(0).max(1).optional().describe("Atmospheric haze (0–1), lighter towards the top."),
  hazeColor: z.string().optional().describe("Haze colour. Default warm white #f3eed2."),
  bloom: z.number().min(0).max(1).optional().describe("Glow around bright areas (0–1)."),
  halation: z.number().min(0).max(1).optional().describe("Film-style coloured glow around highlights (0–1)."),
  halationColor: z.string().optional().describe("Default #ff7a3d."),
  dim: z.number().min(0).max(1).optional().describe("Darken with black (0–1)."),
};

export const BackgroundObjectSchema = z.object({
  look: z.string().optional().describe("Named preset (see list_mockup_options), e.g. \"meadow-motion\", \"clouds\", \"midnight\". Other fields override it."),
  type: z
    .enum(["solid", "gradient", "radial", "mesh", "photo", "blur", "transparent"])
    .optional()
    .describe("Usually inferred: photo/unsplash/generate → photo, colors → gradient, color → solid."),
  color: z.string().optional(),
  colors: z.array(z.string()).optional().describe("Gradient/mesh colours. For mesh the first is the base."),
  angle: z.number().optional().describe("Linear gradient angle, CSS degrees. Default 160."),
  x: z.number().optional().describe("Radial centre x (0–1)."),
  y: z.number().optional().describe("Radial centre y (0–1)."),
  meshStyle: z.enum(["field", "orbs", "aurora", "corner", "diagonal"]).optional(),
  seed: z.number().optional().describe("Varies mesh layout, Unsplash search pick and AI generation."),
  photo: z
    .string()
    .optional()
    .describe("Local path, https URL, Unsplash photo URL, \"unsplash:<photo id>\" or \"unsplash:search:<query>\"."),
  unsplash: z.string().optional().describe("Search Unsplash for this query and use a matching free photo (pick with `seed`)."),
  generate: z
    .union([
      z.string(),
      z.object({
        prompt: z.string(),
        provider: z.enum(["openai", "gemini", "replicate", "fal"]).optional(),
        model: z.string().optional(),
        raw: z.boolean().optional().describe("Send the prompt verbatim, without the background-friendly suffix."),
      }),
    ])
    .optional()
    .describe("AI-generate the background from a prompt (needs OPENAI_API_KEY, GEMINI_API_KEY, REPLICATE_API_TOKEN or FAL_KEY). Cached per prompt."),
  screenshot: z.string().optional().describe("type \"blur\": image to blur. Default: first device's screenshot."),
  zoom: z.number().min(1).optional().describe("Photo zoom; 1 = cover (minimum)."),
  focusX: z.number().optional().describe("Photo focus point x (0–1). Default 0.5."),
  focusY: z.number().optional().describe("Photo focus point y (0–1). Default 0.5."),
  ...TreatmentShape,
});

export const BackgroundSchema = z
  .union([
    z.string().describe("A look name (\"meadow-motion\"), a CSS colour, or any CSS background value."),
    BackgroundObjectSchema,
  ])
  .describe("Canvas background: a look, colour, gradient, mesh, photo (local/Unsplash/AI) with photo treatment, or transparent.");

// ---------------------------------------------------------------------------------------------
// Effects

export const GRADES = ["none", "airy", "warm-film", "cool-film", "faded", "cinematic", "vivid", "mono", "noir"] as const;

export const EffectsSchema = z
  .object({
    grain: z
      .union([
        z.number(),
        z.object({
          amount: z.number().describe("0–1. 0.15 is subtle, 0.4 is strong."),
          size: z.number().optional().describe("Grain cell size multiplier. Default 1."),
          scope: z.enum(["background", "all"]).optional().describe("\"background\" keeps captured UI clean (default)."),
        }),
      ])
      .optional(),
    vignette: z
      .union([z.number(), z.object({ amount: z.number(), roundness: z.number().optional().describe("0 = follows the canvas shape, 1 = circular.") })])
      .optional(),
    edgeBlur: z
      .union([
        z.boolean(),
        z.object({
          edges: z.enum(["auto", "top", "bottom", "both"]).optional().describe("\"auto\" blurs edges a device bleeds off."),
          extent: z.number().optional().describe("Height of the blur band as a fraction of canvas height. Default 0.25."),
          amount: z.number().optional().describe("Blur strength as a fraction of canvas width. Default 0.012."),
        }),
      ])
      .optional()
      .describe("Progressive blur where devices run off the canvas edge."),
    grade: z
      .union([
        z.enum(GRADES),
        z.object({
          preset: z.enum(GRADES).optional(),
          exposure: z.number().optional().describe("Stops, e.g. 0.3."),
          temperature: z.number().optional().describe("-1 (cool) … 1 (warm)."),
          tint: z.number().optional().describe("-1 (green) … 1 (magenta)."),
          contrast: z.number().optional().describe("1 = unchanged."),
          saturation: z.number().optional().describe("1 = unchanged."),
          fade: z.number().optional().describe("Lift blacks 0–1."),
          scope: z.enum(["background", "all"]).optional().describe("Default \"background\" (captured UI stays true to colour)."),
        }),
      ])
      .optional()
      .describe("Colour grade."),
  })
  .optional();

// ---------------------------------------------------------------------------------------------
// Devices

export const ShadowSchema = z
  .union([
    z.enum(["none", "soft", "medium", "strong", "studio"]),
    z.object({
      style: z.enum(["classic", "studio"]).optional().describe("studio adds a key light from the top left and a longer cast shadow."),
      opacity: z.number().optional().describe("0–1. Default 0.3."),
      blur: z.number().optional().describe("Blur radius × device height. Default 0.05."),
      offsetY: z.number().optional().describe("Offset × device height. Default 0.02."),
      color: z.string().optional().describe("\"auto\" (default: tinted from the background) or any CSS colour."),
    }),
  ])
  .describe("Shadow under the device. Default \"medium\".");

export const HighlightSchema = z.object({
  style: z
    .enum(["lift", "outline", "blur-rest", "loupe", "spotlight"])
    .describe("lift: pop the element out, scaled, over a dimmed screen. outline: ring around it. blur-rest: blur everything else. loupe: circular magnifier. spotlight: dim everything else."),
  text: z.string().optional().describe("Find the target by visible text (on-device OCR), e.g. \"Add a task\"."),
  match: z.number().int().min(1).optional().describe("Which match of `text` to use (1 = first, top to bottom)."),
  rect: z
    .object({ x: z.number(), y: z.number(), width: z.number().positive(), height: z.number().positive() })
    .optional()
    .describe("Target rectangle in screenshot coordinates (see unit)."),
  unit: z.enum(["px", "pt"]).optional().describe("Units of rect: screenshot pixels (default) or points."),
  row: z.boolean().optional().describe("Grow a text target to its whole row/card (detected from the pixels). Default true for lift, blur-rest and spotlight."),
  padding: z.number().min(0).optional().describe("Extra space around the target in points. Default 6."),
  radius: z.number().min(0).optional().describe("Corner radius in points. Default 14."),
  scale: z.number().positive().max(6).optional().describe("lift: scale (default 1.06). loupe: magnification (default 1.8)."),
  dim: z.number().min(0).max(1).optional().describe("How strongly the rest of the screen is pushed back (0–1)."),
  washColor: z.string().optional().describe("Colour of that push-back wash. Default #1c1c1e."),
  color: z.string().optional().describe("Outline / loupe ring colour. Default white for loupe, #0a84ff for outline."),
  size: z.number().positive().optional().describe("Loupe diameter in points. Default 120."),
  offsetX: z.number().optional().describe("Move the loupe from the target centre (points)."),
  offsetY: z.number().optional(),
});

export const DeviceInputSchema = z.object({
  screenshot: z.string().describe("Path to the screenshot PNG/JPEG (e.g. from capture_screenshot or capture_web). For videos, the recording's poster frame."),
  video: z.string().optional().describe("create_video only: a screen recording (from record_simulator) to play inside the frame."),
  frame: z
    .enum(["device", "browser", "window", "card", "none"])
    .optional()
    .describe("device: hardware mockup (default). browser: Safari-style window with address bar. window: macOS window. card: rounded card. none: the bare screenshot."),
  device: z
    .string()
    .optional()
    .describe("Hardware to draw, e.g. \"iPhone 17 Pro\", \"iPhone Air\", \"iPad Pro 13-inch\", \"MacBook Pro 14-inch\", \"Apple Watch 46mm\", or any simulator device type. Default: detected from the capture."),
  color: z.string().optional().describe("Frame finish: model colour (\"Cosmic Orange\"), generic finish (Black, Silver, White, Graphite, Natural, Gold, Blue, Orange) or any hex. Default Black."),
  buttons: z.boolean().optional().describe("Draw side buttons. Default true."),
  island: z.enum(["auto", "always", "never"]).optional().describe("Dynamic Island/notch overlay. auto draws it only if the capture lacks it."),
  landscape: z.boolean().optional().describe("Force landscape/portrait. Default: follows the screenshot."),
  x: z.number().optional().describe("Horizontal position as a fraction of canvas width (0 left, 1 right). May bleed outside 0–1."),
  y: z.number().optional().describe("Vertical position of the device's centre as a fraction of canvas height (0 top, 1 bottom)."),
  anchor: z.enum(["center", "top", "bottom"]).optional().describe("Which part of the device sits at y. Default center when you give y."),
  height: z.number().positive().max(5).optional().describe("Device height as a fraction of canvas height."),
  width: z.number().positive().max(5).optional().describe("Device width as a fraction of canvas width (used when height isn't set)."),
  rotate: z.number().optional().describe("2D rotation, degrees clockwise."),
  rotateX: z.number().optional().describe("3D tilt, degrees. Positive leans the top away."),
  rotateY: z.number().optional().describe("3D turn, degrees. Positive turns the right edge away."),
  perspective: z.number().positive().optional().describe("3D perspective in px; smaller is more dramatic."),
  shadow: ShadowSchema.optional(),
  z: z.number().optional().describe("Stacking order; higher is in front."),
  glare: z.boolean().optional().describe("Subtle diagonal glass reflection."),
  highlights: z.array(HighlightSchema).optional().describe("Call out parts of the screen: lift a row, magnify with a loupe, outline, spotlight."),
  crop: z
    .object({ x: z.number().min(0), y: z.number().min(0), width: z.number().positive(), height: z.number().positive() })
    .optional()
    .describe("Use only this part of the screenshot (px). Mostly for card/none frames."),
  radius: z.number().min(0).optional().describe("Corner radius in canvas px for card/browser/window frames."),
  url: z.string().optional().describe("browser frame: address bar text."),
  title: z.string().optional().describe("window frame: title bar text."),
  chrome: z.enum(["light", "dark"]).optional().describe("browser/window chrome theme. Default light."),
  bandColor: z.string().optional().describe("Apple Watch band colour, or \"none\"."),
});

// ---------------------------------------------------------------------------------------------
// Text

export const TextInputSchema = z.object({
  text: z.string().describe("Text. Wrap words in **double asterisks** for the accent colour; \\n breaks lines."),
  x: z.number().optional().describe("Anchor x (0–1). Default 0.5."),
  y: z.number().optional().describe("Anchor y (0–1). Default 0.1."),
  align: z.enum(["left", "center", "right"]).optional(),
  anchor: z.enum(["top", "middle", "bottom"]).optional().describe("Which edge of the text box sits on y. Default top."),
  width: z.number().positive().optional().describe("Max width as a fraction of canvas width. Default 0.86."),
  size: z.number().positive().optional().describe("Font size: canvas px, or a fraction of canvas height when < 1 (e.g. 0.05)."),
  weight: z.number().optional(),
  font: z.string().optional().describe("sf-pro (default), sf-rounded, new-york, sf-mono, or an installed/Google Fonts family."),
  color: z.string().optional(),
  accentColor: z.string().optional().describe("Colour or CSS gradient for **accent** words. Default: textStyle.accentColor; without either, accent words are just bold."),
  lineHeight: z.number().optional(),
  letterSpacing: z.number().optional().describe("Tracking in em, e.g. -0.02."),
  uppercase: z.boolean().optional(),
  opacity: z.number().optional(),
  rotate: z.number().optional(),
  shadow: z.union([z.boolean(), z.string()]).optional().describe("true for a soft shadow, or a CSS text-shadow."),
  background: z.string().optional().describe("Pill background, turning the text into a badge."),
  z: z.number().optional(),
});

export const TextStyleSchema = z
  .object({
    font: z.string().optional(),
    color: z.string().optional().describe("Default: black or white, whichever reads better on the background."),
    accentColor: z.string().optional(),
    headlineSize: z.number().positive().optional().describe("px, or fraction of canvas height when < 1."),
    subheadlineSize: z.number().positive().optional().describe("px, or fraction of canvas height when < 1."),
    headlineWeight: z.number().optional(),
    subheadlineWeight: z.number().optional(),
    align: z.enum(["left", "center", "right"]).optional(),
    position: z.enum(["top", "bottom", "left", "right"]).optional().describe("Where the caption sits relative to the devices."),
    x: z.number().optional().describe("Place the caption block exactly: x of its anchor as a fraction of canvas width (the left edge for left-aligned text, the centre for centred, the right edge for right-aligned). Overrides position."),
    y: z.number().optional().describe("y of the caption block's anchor as a fraction of canvas height."),
    anchor: z.enum(["top", "middle", "bottom"]).optional().describe("Which edge of the caption block sits on y. Default top."),
    width: z.number().positive().optional().describe("Caption block width as a fraction of canvas width."),
    letterSpacing: z.number().optional(),
    uppercase: z.boolean().optional(),
    shadow: z.union([z.boolean(), z.string()]).optional().describe("Text shadow for busy photo backgrounds."),
  })
  .optional()
  .describe("Headline/subheadline styling.");

// ---------------------------------------------------------------------------------------------

export const LAYOUTS = ["hero", "hero-bleed", "text-bottom", "tilted", "floating", "duo", "trio", "split", "stack", "custom"] as const;

export const MockupInputShape = {
  devices: z.array(DeviceInputSchema).min(1).max(8).describe("Screenshots to frame and place. Several make a multi-device composition (e.g. MacBook + iPhone)."),
  canvas: z
    .union([z.string(), z.object({ width: z.number().int().min(64).max(8192), height: z.number().int().min(64).max(8192) })])
    .optional()
    .describe("Preset (\"iphone-6.9\", \"ipad-13\", \"16:9\", \"4:5\", \"9:16\", \"1:1\", \"og\"…), \"WIDTHxHEIGHT\", or {width,height}. Default: App Store size for the first device."),
  landscape: z.boolean().optional().describe("Swap the preset's width and height."),
  layout: z
    .enum(LAYOUTS)
    .optional()
    .describe("hero (caption top, device below), hero-bleed (big device cropped by the bottom edge), text-bottom, tilted (3D), floating (device only), duo, trio, split (caption beside devices), stack (overlapping multi-device), custom."),
  background: BackgroundSchema.optional(),
  effects: EffectsSchema,
  headline: z.string().optional().describe("Main caption. **Accent** markup supported."),
  subheadline: z.string().optional(),
  textStyle: TextStyleSchema,
  texts: z.array(TextInputSchema).optional().describe("Extra free-positioned text (badges, ratings, labels)."),
  fonts: z.array(z.object({ family: z.string(), path: z.string() })).optional().describe("Register local font files."),
  output: z.string().optional().describe("Output file or directory. Default ./screenshots/mockups/."),
  format: z.enum(["png", "jpeg", "webp"]).optional(),
  quality: z.enum(["preview", "final"]).optional().describe("preview renders fast at half resolution. Default final."),
  jpegQuality: z.number().min(1).max(100).optional(),
  deliveryWidth: z.number().int().min(16).max(8192).optional().describe("Resize the final image to this width (keeps aspect)."),
  preview: z.boolean().optional().describe("Return a small preview image. Default true."),
};

export const MockupInputSchema = z.object(MockupInputShape);
export type MockupInput = z.infer<typeof MockupInputSchema>;
export type DeviceInput = z.infer<typeof DeviceInputSchema>;
export type TextInput = z.infer<typeof TextInputSchema>;
export type BackgroundInput = z.infer<typeof BackgroundSchema>;
export type BackgroundObject = z.infer<typeof BackgroundObjectSchema>;
export type EffectsInput = z.infer<typeof EffectsSchema>;
export type ShadowInput = z.infer<typeof ShadowSchema>;
export type HighlightInput = z.infer<typeof HighlightSchema>;
export type Layout = (typeof LAYOUTS)[number];
