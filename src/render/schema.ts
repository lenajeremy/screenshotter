import { z } from "zod";
import { ARROW_HEADS, DASHES, SHAPE_TYPES } from "./shapes.js";
import { EASES, EFFECTS, PATH_SHAPES, UNITS } from "./animate.js";

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

export const FINISHES = ["risograph", "newsprint", "halftone", "dither", "oil", "watercolor", "ink", "fluted-glass"] as const;

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
  finish: z
    .union([
      z.enum(FINISHES),
      z.object({
        style: z.enum(FINISHES),
        colors: z
          .array(z.string())
          .max(3)
          .optional()
          .describe("risograph: [colour ink, dark ink, paper]. dither: [dark, light]. ink: [paper, ink]. halftone, newsprint, watercolor: [paper]. Hex colours."),
        scale: z.number().positive().max(4).optional().describe("Size of the dots, grain, strokes or flutes. Default 1."),
        amount: z.number().min(0).max(1).optional().describe("Blend with the unfinished background (1 = the full finish). Default 1."),
      }),
    ])
    .optional()
    .describe(
      "Print or paint the background (never the UI): risograph (two inks with grain), newsprint (faded newspaper dots), halftone (large colour dots), dither (one-bit black and white), oil (thick paint), watercolor, ink (sepia ink wash) or fluted-glass (seen through wide ribbed glass). Works on photos, paintings, gradients and looks.",
    ),
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
    .enum(["lift", "outline", "blur-rest", "loupe", "spotlight", "blur", "highlighter", "step", "arrow"])
    .describe(
      "lift: pop the element (its row or card) out, scaled, over a dimmed screen. outline: ring around it. blur-rest: blur everything else. loupe: glass magnifier (move it beside the device with offsetX/offsetY; it still magnifies the target). spotlight: dim everything else. blur: blur the element itself, for anything private. highlighter: a marker swipe over text. step: a numbered marker on (or beside) the element, for how-to images. arrow: a thick curved arrow pointing at the element.",
    ),
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
  size: z.number().positive().optional().describe("loupe: diameter in points (default 120). step: marker diameter (default 30). arrow: line thickness (default 6)."),
  offsetX: z.number().optional().describe("Points. loupe: move it from the target (it can sit beside the device). step: nudge the marker. arrow: where the arrow starts, relative to the target's centre (default 120, up and to the right)."),
  offsetY: z.number().optional().describe("Points, positive is down. See offsetX. Arrow default -80."),
  label: z.string().max(4).optional().describe("step: the marker's number or letter. Default: 1, 2, 3… in the order steps are listed."),
  at: z.enum(["right", "left", "top", "bottom", "center"]).optional().describe("step: where the marker sits against the element. Default right."),
  bend: z.number().min(-1).max(1).optional().describe("arrow: curve, from -1 to 1 (0 is straight; the sign picks the side). Default 0.35."),
  breakout: z.number().min(0).max(0.5).optional().describe("lift: how far the lifted card reaches past each side of the screen, as a fraction of the screen width, for a card wider than the device (0.08 is a clear break). Default 0."),
});

const MenuBarShape = {
  app: z.string().max(40).optional().describe("App name, bold after the Apple menu. Default: the captured app (Safari for web pages)."),
  menus: z.array(z.string().max(24)).max(10).optional().describe("The app's menus. Default File, Edit, View, Window, Help."),
  style: z.enum(["light", "dark"]).optional().describe("light: dark text on a pale bar. dark: white text on a dark bar. Default: suits the capture."),
  time: z.string().max(40).optional().describe('The clock. Default "Wed Sep 23  9:41 AM".'),
  status: z.string().max(60).optional().describe("A menu bar app's status item, drawn highlighted as if its menu is open, e.g. \"Team standup · in 19m\"."),
  statusX: z.number().optional().describe("Where the status item's centre sits, as a fraction of the bar's width."),
};

/** A macOS menu bar drawn across the top of the canvas, for menu bar app shots. */
export const SceneMenuBarSchema = z
  .object({
    ...MenuBarShape,
    size: z.number().positive().max(0.3).optional().describe("Bar height as a fraction of canvas height. Default 0.034 (a whole desktop); 0.06–0.1 for a close, zoomed-in shot."),
  })
  .describe(
    "Draw a macOS menu bar across the top of the canvas: the Apple menu (and app menus if `app` is set), a highlighted `status` item, Control Center, Spotlight, Wi-Fi, battery and the clock. Put a menu bar app's captured menu or popover (frame \"none\") under the status item: devices without a y are hung just below the bar, centred under the status item.",
  );

export const DeviceInputSchema = z.object({
  screenshot: z
    .string()
    .optional()
    .describe("Path to the screenshot PNG/JPEG (e.g. from capture_screenshot or capture_web). Optional when `video` is given: the recording's first frame is used."),
  video: z.string().optional().describe("A screen recording (from record_simulator, or any MP4/MOV) to play inside the frame in create_video. Stills show its first frame unless `screenshot` is set."),
  frame: z
    .enum(["device", "browser", "window", "card", "none"])
    .optional()
    .describe("device: hardware mockup (default). browser: Safari-style window with address bar. window: macOS window. card: the screen only (UI-only), with the device's own screen corners when the capture's device is known, else gently rounded. none: the bare screenshot, square."),
  device: z
    .string()
    .optional()
    .describe("Hardware to draw, e.g. \"iPhone 17 Pro\", \"iPhone Air\", \"iPad Pro 13-inch\", \"MacBook Pro 14-inch\", \"Apple Watch Series 11 46mm\", or any simulator device type. Default: detected from the capture."),
  color: z.string().optional().describe("Frame finish: model colour (\"Cosmic Orange\"), generic finish (Black, Silver, White, Graphite, Natural, Gold, Blue, Orange) or any hex. Default Black."),
  buttons: z.boolean().optional().describe("Draw side buttons. Default true."),
  bezel: z
    .boolean()
    .optional()
    .describe("Use Apple's photographic product bezel for this model and colour when one is installed in the bezel folder. Default: yes, except for website captures (Apple's license covers mock-ups of apps for Apple platforms)."),
  side: z
    .enum(["front", "back"])
    .optional()
    .describe("iPhone: show the back instead of the screen (camera housing, lenses, logo, true to each model). Default front."),
  island: z.enum(["auto", "always", "never"]).optional().describe("Dynamic Island/notch overlay. auto draws it only if the capture lacks it."),
  menuBar: z
    .union([z.boolean(), z.object(MenuBarShape)])
    .optional()
    .describe("MacBook: the macOS menu bar drawn above an app or web capture (app name, menus, icons, clock). false for none. Full-screen Mac captures keep their own."),
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
  blur: z
    .number()
    .min(0)
    .optional()
    .describe("Soften the whole device as if the camera focused on something else (depth of field): a fraction of canvas width up to 0.5 (0.003 soft, 0.008 strong), or px above that. Keep the hero device sharp."),
  fade: z
    .union([
      z.number().min(0).max(1),
      z.object({
        edge: z.enum(["bottom", "top", "left", "right"]).optional().describe("Which edge dissolves. Default bottom."),
        extent: z.number().min(0).max(1).optional().describe("How much of the device fades, as a fraction of its size. Default 0.4."),
      }),
    ])
    .optional()
    .describe("Dissolve the device into the background from one edge: a number is how much of it fades from the bottom (0.4 = the lower 40%), or {edge, extent}. Best over dark or soft backgrounds."),
  highlights: z.array(HighlightSchema).optional().describe("Call out parts of the screen: lift a row, magnify with a loupe, outline, spotlight."),
  crop: z
    .object({ x: z.number().min(0), y: z.number().min(0), width: z.number().positive(), height: z.number().positive() })
    .optional()
    .describe("Use only this part of the screenshot (px). Mostly for card/none frames."),
  radius: z.number().min(0).optional().describe("Corner radius in canvas px for card/browser/window frames."),
  url: z.string().optional().describe("browser frame: address bar text."),
  title: z.string().optional().describe("window frame: title bar text."),
  chrome: z.enum(["light", "dark"]).optional().describe("browser/window chrome theme. Default light."),
  band: z
    .string()
    .optional()
    .describe("Apple Watch: the band, as Apple's art names it for the finish, e.g. \"Sport Band Black\", \"Sport Loop Forest\", \"Milanese Loop\", \"Alpine Loop Light Blue\" (list_mockup_options lists each finish's bands; part of a name, like \"Milanese\", is enough). Default: a Sport Band if the finish has one."),
  bandColor: z.string().optional().describe("Apple Watch band colour, or \"none\" (drawn watches only, a development option)."),
  clay: z
    .union([z.boolean(), z.string()])
    .optional()
    .describe("Clay: Apple's device art recoloured into one matte colour, keeping its own light and shade (the screen is untouched; tilted, its side is clay too). true for porcelain, a tone (porcelain, sand, sage, sky, slate, ink) or any colour. Calm, and it puts the attention on the app."),
  span: z
    .boolean()
    .optional()
    .describe("In a set of screens, a device with x and y carries on into the neighbouring screens where it reaches past an edge (Device Overflow), so swiping between them reads as one picture; false keeps it within its own screen. The Studio draws its continuation on the neighbours (`spill`)."),
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
  accentFont: z.string().optional().describe("Font for **accent** words. Default: textStyle.accentFont, else the text's own font."),
  accentWeight: z.number().optional().describe("Weight for **accent** words. Default: textStyle.accentWeight."),
  accentItalic: z.boolean().optional().describe("Set **accent** words in italic. Default: textStyle.accentItalic."),
  lineHeight: z.number().optional(),
  letterSpacing: z.number().optional().describe("Tracking in em, e.g. -0.02."),
  uppercase: z.boolean().optional(),
  opacity: z.number().optional(),
  rotate: z.number().optional(),
  shadow: z.union([z.boolean(), z.string()]).optional().describe("true for a soft shadow, or a CSS text-shadow."),
  blur: z.number().min(0).optional().describe("Soft focus: a fraction of the canvas width up to 0.5 (0.004 soft, 0.012 clearly out of focus), or px. For depth, or to push it back behind what matters."),
  background: z.string().optional().describe("Pill background, turning the text into a badge."),
  z: z.number().optional(),
});

// ---------------------------------------------------------------------------------------------
// Image blocks

export const ImageBlockSchema = z.object({
  src: z.string().describe("A PNG, JPEG, WebP, GIF or SVG: a path, or an https URL. A logo, the app icon, a sticker, a photo."),
  x: z.number().optional().describe("Centre x as a fraction of the canvas width. Default 0.5."),
  y: z.number().optional().describe("Centre y as a fraction of the canvas height. Default 0.5."),
  height: z.number().positive().max(5).optional().describe("Height as a fraction of the canvas height (the width follows the picture's shape). Default 0.12."),
  width: z.number().positive().max(5).optional().describe("Width as a fraction of the canvas width, instead of height. Both stretch it."),
  rotate: z.number().optional().describe("Degrees, clockwise."),
  opacity: z.number().min(0).max(1).optional(),
  radius: z.number().min(0).max(0.5).optional().describe("Corner radius as a share of the shorter side; 0.5 makes a circle or pill."),
  mask: z.enum(["icon", "circle"]).optional().describe("icon: Apple's app-icon outline (a continuous-cornered square), for an app icon. circle: round."),
  shadow: z.boolean().optional().describe("A soft shadow that follows the picture's outline."),
  sticker: z.boolean().optional().describe("A sticker: a die-cut white edge round the picture's outline, and a shadow."),
  flip: z.boolean().optional().describe("Mirror it left to right."),
  blur: z.number().min(0).optional().describe("Soft focus: a fraction of the canvas width up to 0.5 (0.004 soft), or px."),
  z: z.number().optional().describe("Stacking order; higher is in front. Default 35: in front of devices and text, behind shapes."),
});
export type ImageBlockInput = z.infer<typeof ImageBlockSchema>;

// ---------------------------------------------------------------------------------------------
// Shapes

const PointSchema = z.object({ x: z.number().describe("0 = left edge, 1 = right edge."), y: z.number().describe("0 = top edge, 1 = bottom edge.") });

export const ShapeInputSchema = z.object({
  type: z
    .enum(SHAPE_TYPES)
    .describe("arrow, line, ellipse (circles and ovals), rect (boxes, rounded or pill), triangle, star, badge (a filled circle with a number or letter, for steps)."),
  x: z.number().optional().describe("Box shapes: centre x as a fraction of the canvas width. Default 0.5 (ignored with `around`)."),
  y: z.number().optional().describe("Centre y as a fraction of the canvas height. Default 0.5."),
  size: z.number().positive().max(2).optional().describe("Box shapes: height as a fraction of the canvas height (badge default 0.045, ellipse 0.1)."),
  aspect: z.number().positive().max(40).optional().describe("Width ÷ height in pixels: 1 is a circle or square, 2 twice as wide. Default 1.5 for an ellipse, 1.7 for a rect."),
  rotate: z.number().optional().describe("Degrees, clockwise."),
  from: PointSchema.optional().describe("Arrow/line: where it starts (canvas fractions). With `around`, defaults to a spot beside the target."),
  to: PointSchema.optional().describe("Arrow/line: where it ends; the head goes here. With `around`, the edge of the target."),
  bend: z.number().min(-1).max(1).optional().describe("Arrow/line: how much it curves, -1 to 1 (0 straight, the sign picks the side). Default 0.3 for arrows."),
  head: z.enum(ARROW_HEADS).optional().describe("Arrow/line: where the arrowheads go. Default end for arrows, none for lines."),
  around: z
    .object({
      device: z.number().int().min(1).optional().describe("Which device, 1 = the first. Default 1."),
      text: z.string().describe("Visible text on that device's screen, found by on-device OCR, e.g. \"Allow\"."),
      match: z.number().int().min(1).optional().describe("Which match of the text, top to bottom. Default 1."),
      padding: z.number().min(0).optional().describe("Room around the text as a fraction of canvas height. Default 0.012."),
    })
    .optional()
    .describe(
      "Aim the shape at something on a screen, so it follows the device: an ellipse or rect goes around the text, a badge sits beside it (see `at`), an arrow or line ends at its edge. Works on flat devices; 3D tilt isn't followed.",
    ),
  at: z.enum(["right", "left", "top", "bottom"]).optional().describe("badge with `around`: which side of the target it sits on. Default right."),
  fill: z.string().optional().describe('Fill colour, or "none". Default none for outlines (ellipse, rect), yellow for triangle and star, red for badge.'),
  stroke: z.string().optional().describe('Stroke colour, or "none". Default red (#ff3b30) for arrows, lines and outlines; white for a badge ring.'),
  strokeWidth: z.number().min(0).optional().describe("Stroke width: a fraction of canvas height when < 1 (0.005 is a clear line), or px. Arrows also scale their heads with it."),
  dash: z.enum(DASHES).optional().describe("Stroke pattern. Default solid."),
  radius: z.number().min(0).max(0.5).optional().describe("rect: corner radius as a share of the shorter side; 0.5 makes a pill. Default 0.2."),
  points: z.number().int().min(3).max(12).optional().describe("star: number of points. Default 5."),
  label: z.string().max(4).optional().describe("badge: the number or letter. Default 1, 2, 3… in list order."),
  labelColor: z.string().optional().describe("badge: label colour. Default white."),
  sketch: z.boolean().optional().describe("Hand-drawn, like a marker: a ring that overshoots its start, edges that overshoot their corners, open arrowheads. Default false."),
  seed: z.number().int().optional().describe("sketch: pick a different wobble."),
  opacity: z.number().min(0).max(1).optional(),
  shadow: z.boolean().optional().describe("A soft drop shadow, to lift the shape off a busy backdrop."),
  blur: z.number().min(0).optional().describe("Soft focus: a fraction of the canvas width up to 0.5 (0.004 soft, 0.012 clearly out of focus), or px. For depth, or to push it back behind what matters."),
  z: z.number().optional().describe("Stacking order; higher is in front. Default 40, in front of devices and text."),
});

export const TextStyleSchema = z
  .object({
    font: z.string().optional().describe("Headline font (and the subheadline's unless subheadlineFont is set): sf-pro (default), sf-rounded, new-york, sf-mono, or a Google Fonts / installed family."),
    subheadlineFont: z.string().optional().describe("A different font for the subheadline, to pair with the headline's."),
    color: z.string().optional().describe("Default: black or white, whichever reads better on the background."),
    accentColor: z.string().optional().describe("Colour or CSS gradient for **accent** words in the caption (and extra text that doesn't set its own)."),
    accentFont: z.string().optional().describe("Font for **accent** words, e.g. an italic serif inside a sans headline."),
    accentWeight: z.number().optional().describe("Weight for **accent** words, e.g. 800 inside a 400 headline. Without accentColor, accentFont or accentWeight, accent words are just bold."),
    accentItalic: z.boolean().optional().describe("Set **accent** words in italic."),
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
    blur: z.number().min(0).optional().describe("Soft focus on the headline and subheadline: a fraction of the canvas width up to 0.5, or px."),
  })
  .optional()
  .describe("Headline/subheadline styling.");

// ---------------------------------------------------------------------------------------------

// ---------------------------------------------------------------------------------------------
// Animation (videos)

const AnimPointSchema = z.object({ x: z.number(), y: z.number() });
export const AnimPropsSchema = z
  .object({
    opacity: z.number().min(0).max(1).optional(),
    x: z.number().optional().describe("Its centre, as a fraction of the canvas width."),
    y: z.number().optional().describe("Its centre, as a fraction of the canvas height."),
    dx: z.number().optional().describe("Moved by this share of the canvas width."),
    dy: z.number().optional().describe("Moved by this share of the canvas height."),
    scale: z.number().min(0).max(20).optional().describe("Size: 1 is as designed."),
    scaleX: z.number().min(0).max(20).optional().describe("Width only: 1 is as designed."),
    scaleY: z.number().min(0).max(20).optional().describe("Height only: 1 is as designed."),
    rotate: z.number().optional().describe("Degrees turned, added to its own rotation."),
    rotateX: z.number().optional().describe("Devices: degrees of 3D tilt (top away), added to its own."),
    rotateY: z.number().optional().describe("Devices: degrees of 3D turn, added to its own."),
    color: z.string().optional().describe("Text: its colour."),
    fill: z.string().optional().describe("Shapes: fill colour (\"none\" for none)."),
    stroke: z.string().optional().describe("Shapes: stroke colour."),
    strokeWidth: z.number().min(0).optional().describe("Shapes: stroke width, as for the shape."),
    radius: z.number().min(0).max(0.5).optional().describe("Rectangles: corner radius."),
    start: AnimPointSchema.optional().describe("Lines and arrows: where it starts (its `from`), canvas fractions."),
    end: AnimPointSchema.optional().describe("Lines and arrows: where it ends (its `to`, the arrowhead)."),
    bend: z.number().min(-1).max(1).optional().describe("Lines and arrows: how far it bows."),
    zoom: z.number().min(1).max(8).optional().describe("The camera and the backdrop: how far it's pushed in (1 is as designed). Their x and y are the point it pushes toward."),
    blur: z.number().min(0).optional().describe("Soft focus, for anything (devices, text, shapes, the backdrop): a fraction of the canvas width up to 0.5 (0.004 soft, 0.012 clearly out of focus, 0.04 heavy), or px. 0 is sharp. Blurring one device while another sharpens racks focus between them."),
    hue: z.number().optional().describe("The backdrop: turn its colours round the colour wheel, in degrees (30 is a gentle shift, 180 the opposite colours)."),
  })
  .describe("Values to animate. Anything left out keeps its designed value.");

export const AnimationSchema = z
  .object({
    targets: z
      .union([z.string(), z.array(z.string()).min(1).max(20)])
      .describe(
        'What it animates: item ids as layout_mockup lists them ("device-1", "caption", "text-2", "shape-3"). Several move as one group: a zoom or turn is about their shared centre. Or "backdrop": `to: { zoom, x, y, rotate, blur, hue }` moves only the backdrop (a slow push into a photo, a drifting glow, a colour shift). Or "camera": `to: { zoom, x, y }` pushes the view in on a point (the whole picture, text included), glides to another, and `to: { zoom: 1 }` pulls back out. Or a device\'s call-out, "device-1/callout-2" (its highlights, counting from 1): `enter` or `exit` sets when it appears or leaves, arriving the way its style does (a lift rises, a loupe grows); call-outs not animated appear at video.highlight\'s time.',
      ),
    at: z.number().min(0).max(120).describe("Seconds after the video starts."),
    duration: z.number().min(0).max(30).optional().describe("Seconds. Default 0.6."),
    ease: z.enum(EASES).optional().describe("ease-out (default: fast, then settles), ease-in, ease-in-out, linear, back-out (overshoots a little), spring (overshoots and settles), bounce."),
    enter: z
      .enum(EFFECTS)
      .optional()
      .describe("An entrance: it isn't there until `at`, then arrives. fade, zoom (grows in), blur (comes into focus), scale-x / scale-y (stretches in across / up), slide-up / slide-down / slide-left / slide-right (the way it moves), none (just appears)."),
    exit: z.enum(EFFECTS).optional().describe("An exit: the same effects played out, leaving at `at`."),
    amount: z.number().optional().describe("For enter/exit: zoom's starting size (default 0.6), scale-x/scale-y's (default 0), blur's softness as a fraction of the canvas width (default 0.012), or a slide's distance as a share of the canvas (default 0.2)."),
    fade: z.boolean().optional().describe("Whether an enter/exit also fades. Default true."),
    from: AnimPropsSchema.optional().describe("Start from these values and animate to how it's designed: an entrance of your own. With `enter`, adds to the preset."),
    to: AnimPropsSchema.optional().describe("Animate from how it is to these values, and stay there: a change part way through."),
    by: z.enum(UNITS).optional().describe("Text only: animate it a word or a letter at a time, in reading order, rather than as one block. Works with enter, exit, from and to (opacity, scale, rotate, dx/dy)."),
    each: z.number().min(0).max(2).optional().describe("With `by`: seconds between each word (default 0.08) or letter (default 0.03) starting."),
    stagger: z.number().min(0).max(10).optional().describe("With several targets: seconds between each one starting, in the order given (zooms and turns stay about the shared centre)."),
    path: z
      .object({
        shape: z.enum(PATH_SHAPES).optional().describe("A ready-made loop that starts and ends where it is: circle (it hangs below), oval (flatter), figure-8 (crossing where it is)."),
        size: z.number().min(0.001).max(1).optional().describe("With shape: how big the loop is, a fraction of the canvas width. Default 0.04."),
        points: z.array(AnimPointSchema).max(12).optional().describe("A route of your own instead: points (canvas fractions) its centre passes through on a smooth curve, starting from where it is."),
        closed: z.boolean().optional().describe("With points: come back round to where it started. Shapes are loops anyway."),
        orient: z.boolean().optional().describe("Turn to face the way it's going (a paper plane, a car)."),
        reverse: z.boolean().optional().describe("Go round (or along) the other way."),
      })
      .optional()
      .describe("Travel along a curve: a Change whose item follows this route over `duration` (with `to`, both happen at once). With repeat: true and a loop it goes round for the whole video. Not for the camera, backdrop or call-outs."),
    repeat: z
      .union([z.number().int().min(1).max(200), z.literal(true)])
      .optional()
      .describe("A Change plays again: this many more times, or true to keep going until the video ends (a spin, a float, a pulse, a trip round a path). A looping clip runs at a steady speed unless `ease` says otherwise. Not for entrances or exits."),
    yoyo: z.boolean().optional().describe("With repeat: every other play runs backwards, so it goes there and back (a pulse, a sway, a breathing glow)."),
  })
  .refine((a) => a.enter || a.exit || a.from || a.to || a.path, { message: "An animation needs enter, exit, from, to or path." })
  .refine((a) => !(a.repeat && (a.enter || a.exit)), { message: "repeat is for Changes (to, from or path), not entrances or exits." });

export const LAYOUTS = ["hero", "hero-bleed", "text-bottom", "tilted", "floating", "duo", "trio", "split", "stack", "grid", "staircase", "rising", "custom"] as const;

export const MockupInputShape = {
  devices: z.array(DeviceInputSchema).max(8).describe("Screenshots to frame and place. Several make a multi-device composition (e.g. MacBook + iPhone). Empty is a screen of text and backdrop alone (a set's intro, say)."),
  canvas: z
    .union([z.string(), z.object({ width: z.number().int().min(64).max(8192), height: z.number().int().min(64).max(8192) })])
    .optional()
    .describe("Preset (\"iphone-6.9\", \"ipad-13\", \"16:9\", \"4:5\", \"9:16\", \"1:1\", \"og\"…), \"WIDTHxHEIGHT\", or {width,height}. Default: App Store size for the first device."),
  landscape: z.boolean().optional().describe("Swap the preset's width and height."),
  layout: z
    .enum(LAYOUTS)
    .optional()
    .describe("hero (caption top, device below), hero-bleed (big device cropped by the bottom edge), text-bottom, tilted (3D), floating (device only), duo, trio, split (caption beside devices), stack (overlapping multi-device), grid (a mosaic of screens in rows), staircase (screens stepping up to the right, each overlapping the next), rising (the same steps, counter-rotated), custom."),
  background: BackgroundSchema.optional(),
  backgroundSpan: z
    .object({
      count: z.number().int().min(2).max(20),
      index: z.number().int().min(0).max(19),
      gap: z.number().min(0).max(0.5).optional().describe("The space between screens as the store shows them, as a share of a screen's width (the App Store's is about 0.043): the panorama runs on behind it, so it meets itself across the gap."),
    })
    .optional()
    .describe("A backdrop laid across a set of screens side by side, one panorama: how many screens, and which this is (from 0); this screen shows its slice. The Studio sets it when a set's backdrop goes across the set."),
  spill: z
    .array(DeviceInputSchema)
    .max(16)
    .optional()
    .describe("Devices of the neighbouring screens that carry on into this one (`span`), in this screen's terms (x less 1 for the screen on the left, plus 1 for the one on the right). Drawn after this screen's own devices, not laid out. The Studio keeps it in step."),
  effects: EffectsSchema,
  headline: z.string().optional().describe("Main caption. **Accent** markup supported."),
  subheadline: z.string().optional(),
  textStyle: TextStyleSchema,
  texts: z.array(TextInputSchema).optional().describe("Extra free-positioned text (badges, ratings, labels)."),
  shapes: z
    .array(ShapeInputSchema)
    .max(40)
    .optional()
    .describe("Drawn shapes over the scene: arrows, lines, circles, boxes, stars and number badges, for pointing things out or decoration. Aim one at text on a screen with `around`."),
  images: z
    .array(ImageBlockSchema)
    .max(24)
    .optional()
    .describe("Image blocks: logos, the app icon, stickers, badges or any picture placed on the scene, in front of devices and text (z 35), behind shapes."),
  menuBar: SceneMenuBarSchema.optional(),
  animations: z
    .array(AnimationSchema)
    .max(80)
    .optional()
    .describe(
      "For videos (create_video, and Studio video exports): when and how each item appears, changes and leaves. Items not animated are there from the start. Example: the headline slides up at 1 s, the MacBook and iPhone zoom in together at 2.5 s, an arrow's end moves at 4 s. Still images show the design as it is.",
    ),
  camera: z
    .object({
      zoom: z.number().min(1).max(8).describe("How far to zoom in: 2 shows half the width and height."),
      x: z.number().min(0).max(1).optional().describe("The point to zoom into, as a fraction of the canvas width. Default 0.5."),
      y: z.number().min(0).max(1).optional().describe("As a fraction of the canvas height. Default 0.5."),
    })
    .optional()
    .describe("Zoom the scene (backdrop and devices) in on a point, rendered crisp, for a close-up of part of a device. The caption, extra text and menu bar stay put. Find the point from the entities' positions."),
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
export type ShapeInput = z.infer<typeof ShapeInputSchema>;
export type BackgroundInput = z.infer<typeof BackgroundSchema>;
export type BackgroundObject = z.infer<typeof BackgroundObjectSchema>;
export type EffectsInput = z.infer<typeof EffectsSchema>;
export type ShadowInput = z.infer<typeof ShadowSchema>;
export type HighlightInput = z.infer<typeof HighlightSchema>;
export type Layout = (typeof LAYOUTS)[number];
