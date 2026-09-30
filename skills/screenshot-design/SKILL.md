---
name: screenshot-design
description: Design App Store screenshots, product mockups, help-centre images and launch visuals with the Screenshotter MCP server. Use whenever you capture app or web screens and turn them into marketing images, device mockups, screenshot sets, how-to images or product videos, or when asked to make mockups look better.
---

# Screenshot design with Screenshotter

You have the Screenshotter MCP tools. Use them like a designer who checks their own work: look at every render, zoom into details, compare variants side by side, and refine until it's right.

## The loop

1. **Know the person.** Call `get_house_style` and follow it. `list_mockup_options` lists devices, finishes, looks (photographic, paintings, soft grounds), canvases, layouts and grades.
2. **Capture the real screen.** `capture_screenshot` (simulator; deep links or launch arguments reach a screen), `capture_web`, `capture_mac`. For motion: `record_simulator`, `record_web` (a rehearsed click-through that returns a cursor track) and `record_mac`.
3. **Read the screen.** Look at the capture. `find_text` lists its visible text: the words you can aim a callout at. Note its colours: the accent is your accent.
4. **Compose.** Start from a proven design with `apply_recipe` when one fits, or write the scene yourself with `create_mockup` and a clear idea (see the guide). `layout_mockup` shows where everything lands without rendering. For a whole set, `create_mockup_set`.
5. **Check.** Look at the preview. Then zoom in: `crop_image` with a `focus` and `zoom` on the headline edges, the callout, the device edge. Anything off (text touching the device, weak contrast, a callout on the wrong row), fix it and render again.
6. **Compare.** When the direction isn't obvious, render two or three variants (backdrop, layout, type) and lay them side by side with `create_grid` (with `labels`). Pick the strongest, say why, and refine it.
7. **Remember.** When the person states a preference ("always Space Black", "less text"), save it with `remember_style`.

Everything is a scene of entities (devices, the caption, texts) with positions as fractions of the canvas; every result lists them. Each output has a `.mockup.json` next to it with the exact request, so you can re-render with small changes.

# Designing screenshots that sell

You are the art director. The person brings a real app screen; you turn it into an image that stops a thumb mid-scroll and makes the app's value obvious in a second. The difference between an amateur mockup and a great one is rarely the tool: it's one clear idea, big confident type, a colour world that belongs to the app, and a composition with a single hero. Work like a designer: look, decide, compose, check, refine.

## 1. Know what you're making

- **App Store screenshots are ads.** Most people never scroll past the first image; they decide in about three seconds, often from a thumbnail in search results. Each image sells one outcome. The first image carries the whole app.
- **Help-centre and how-to images** explain a step. Clarity beats mood: a clean backdrop, the screen large, a callout on the exact control, numbered steps and an arrow when there's a sequence. Keep the whole set consistent.
- **Launch and social images** (16:9, 4:5, square) sell a feeling: depth, a striking backdrop, few or no words, often two devices or a close-up.

## 2. Look before you design

Before changing anything, read the brief from what you have:
- **The preview**: what the person sees now. Name what's weak (small device, empty space, timid type, a backdrop that fights the UI, no hierarchy).
- **The screen facts**: each screenshot's palette (its dominant colours and its accent, usually the brand colour), whether the UI is dark or light, and the words visible on screen (what it shows, and the exact text you can aim a callout at).
- **The house style**: remembered preferences. Follow them unless asked otherwise.
- **The category**, from the screen itself: finance, fitness, tasks, food, travel, social, a developer tool…

Then decide, in this order: **the one idea → the hero → the words → the colour world → the backdrop → finish and effects → one callout or accent**. Every choice should serve the one idea.

## 3. Composition

- **One hero.** One element is clearly the most important (usually the device, sometimes the headline); everything else supports it. At most three layers: backdrop → device(s) → words, plus one accent.
- **Make the device big.** On a portrait App Store canvas a single phone should be 60–80% of the canvas height (`height` 0.6–0.8), or larger and bleeding off the bottom (`height` 0.85–1.1 with `y` so 10–30% runs off). A small phone floating in empty space is the most common amateur tell.
- **Bleed on purpose.** Cropping a device at an edge makes it bigger and reads as confident. Crop the part that says least, usually the bottom of the screen. `effects.edgeBlur` softens the cut.
- **Leave room for the words.** Captions sit in the top 25–35% of a portrait canvas; keep 6% margins; the headline must never touch or overlap the device.
- **Balance.** Centre heroes. Off-centre (device `x` 0.3–0.35 or 0.65–0.7) leaves open space for a headline on wide canvases.
- **Depth.** Overlap devices (`z`), vary their size, blur the one behind (`blur` 0.003–0.006), use `shadow` "studio" on light backdrops.
- **Patterns that work** (set these fields):
  - *Hero*: layout "hero", one device, headline on top.
  - *Hero bleed*: layout "hero-bleed", or `height` 0.95, `y` 0.78: a huge phone rising from the bottom edge.
  - *Tilted*: `rotateY` −14 to −22, `rotateX` 5–8, `rotate` −3; turn the device toward the headline or the centre.
  - *Duo / staircase / rising*: two or three screens that tell a sequence (list → detail). layout "staircase" steps them up, "rising" counter-rotates them.
  - *Split*: layout "split" on wide canvases: words on one side, device on the other.
  - *Ecosystem*: MacBook + iPhone (layout "stack"), iPhone + Watch with the watch lifted in front (`z`, `rotateY` 15–25).
  - *Depth of field*: a large device behind with `blur`, a sharp device in front.
  - *Dissolve*: `fade` 0.35–0.5 on devices over a dark backdrop; screens melt into the dark.
  - *Close-up*: `camera` { zoom 2–3, x, y } onto one part of a device (a widget, a chart, a menu).
  - *Mosaic*: layout "grid" with 4–9 screens: "everything in one app", a closing image.
  - *Menu bar app*: a scene `menuBar` with `status`, the app's menu (frame "none") hung under it.
- **Rhythm across a set.** Never use the same layout twice in a row. Alternate centred and off-centre, upright and tilted, one device and two, light and dark backdrops.

## 4. Words

- **One idea per headline.** Never two ideas joined by "and". Short, common words.
- **2–5 words per line, at most 3 lines**, broken by hand with \n so each line is a phrase. No orphans (one word alone on a line).
- **Benefit, not feature.** "Know where every dollar goes", not "Transaction categorisation". Three reliable shapes: paint a moment ("Dinner, decided."), state an outcome ("Your money, finally clear."), kill a pain ("Never miss a refill again.").
- **Emphasise one phrase** with **double asterisks**: the benefit word. Style it (see Typography).
- **Subheadline** only if it adds a fact the headline can't hold; a short line, lighter weight.
- **Eyebrow labels**: a small uppercase pill above the headline (`texts` with `background`, `uppercase`, `letterSpacing` 0.08–0.14, `size` 0.016–0.02) for category or "NEW".
- **Proof** (ratings, awards, press quotes, user counts) only when the person supplied it; never invent it. Put it on the first image only: "★★★★★ 4.9 · 12K ratings" as a small text.
- **Never** "Download now", prices or UI instructions in marketing headlines. The store already has the button.
- **Size**: `textStyle.headlineSize` 0.042–0.06 of canvas height on portrait App Store canvases (big enough to read at thumbnail size), 0.07–0.1 on 16:9. Weight 600–800 for sans headlines. `letterSpacing` −0.02 to −0.035 for display sizes.
- **Keep the person's words** when they wrote them. Rewrite only when asked, or when the copy clearly breaks these rules, and say so.

## 5. Typography

- **Built in**: "sf-pro" (neutral, native), "sf-rounded" (friendly, health, kids), "new-york" (editorial serif), "sf-mono" (technical labels).
- **Any Google Fonts family** by name. Pairings that work:
  - Modern product: "Inter Tight" 600–700; accent in "Instrument Serif" italic.
  - Premium, editorial, lifestyle, food: "Fraunces" 500–600, or "Playfair Display" 600; subheadline "Inter".
  - Tech, developer, fintech: "Space Grotesk" 600 or "Geist" 600; labels "Geist Mono" or "JetBrains Mono".
  - Friendly, playful: "Bricolage Grotesque" 700, "Nunito" 800, "Unbounded" 600.
  - Bold, sporty, loud: "Anton" or "Bebas Neue" (single-weight: use weight 400) with `uppercase`.
  - Luxury, calm: "Cormorant Garamond" 600, or "Instrument Serif" 400 for the whole headline.
  - Handwritten accent, sparingly: "Caveat" 600.
- **Single-weight faces** (Anton, Bebas Neue, Archivo Black, Instrument Serif, DM Serif Display) only have 400: set that weight.
- **Emphasis techniques** for the **accent** phrase:
  - Colour: `textStyle.accentColor` (the app's accent, adjusted for contrast), or a CSS gradient.
  - Weight contrast: `headlineWeight` 400 with `accentWeight` 800 (and no accent colour).
  - Serif italic in a sans headline: `accentFont` "Instrument Serif", `accentItalic` true, `accentWeight` 400: elegant and very current.
- **At most two families** (plus a mono for tiny labels). `subheadlineFont` pairs a different face under the headline.

## 6. Colour

- **Start from the screenshot.** Its accent is your accent; its tone decides the backdrop's tone.
- **Colour worlds that work:**
  - *Tonal*: the backdrop is a deep or pale version of the app's own colour (a green app on deep forest or pale mint).
  - *Warm neutral*: cream, paper, stone ("cream-grain", "paper", "linen") lets a colourful UI sing.
  - *Dark studio*: near-black with one coloured light ("midnight", "ember-glow", "graphite") for dark UIs, pro and developer apps.
  - *Bold colour block*: one saturated colour per image (playful, social, fitness), text white or near-black.
  - *Photographic or painted*: when the app is about a place, food, calm or taste.
- **Dark UI** reads best on dark or rich backdrops; **light UI** on soft light or bold colour. Avoid grey UI on grey.
- **One accent hue.** Everything else neutral or tonal. No rainbows.
- **Contrast**: headline and accent colours need at least 4.5:1 against what's behind them. On photos and paintings, pick a calm area for the words, or add `textStyle.shadow`, `dim` or `haze` to the photo.
- **Device finish echoes the palette**: warm backdrops with warm finishes (Cosmic Orange, Burgundy, Light Gold, Natural), cool with cool (Deep Blue, Glacier, Sky Blue), Silver or White on light, Black on dark. Use the model's own colour names.

## 7. Backdrops

- **Looks** (`background: "<name>"`): photographic (meadow-motion, clouds, dusk, dunes, forest-mist, city-bokeh…), public-domain paintings and prints (great-wave, fuji-coast, woodblock-fuji, morning-glories, hollyhocks, monet-bridge, monet-garden, green-wheat, olive-grove, golden-sea, lake-mountains, misty-hills, pastel-shore, iris-plate, wisteria-plate) and soft grounds (cream-grain, peach-glow, lavender-mist, mint-sage, iridescent, coral-periwinkle, indigo-fade, ember-glow, midnight, aurora, paper, studio-white…). The looks list gives each one's tone.
- **Colours**: `{ color }`, `{ colors, angle }` (gradient), `{ type: "radial", colors, x, y }` (a glow), `{ type: "mesh", colors, meshStyle }`.
- **Photos**: `{ unsplash: "search words" }` describes a place; pick with `seed`. Treat it so it stays behind the UI: `blur` 0.002–0.006, `motionBlur` 0.05–0.08 (a sense of speed), `haze` 0.2–0.4 (airy, lifts text contrast), `dim` 0.1–0.3 (for white text), `tint` + `tintAmount` (pull it into the palette).
- **AI images** (`{ generate: "prompt" }`) when a provider is available and nothing in the looks fits. Write the prompt like a photographer's brief: subject and material, light, palette taken from the app, camera and composition, with empty space where the words go. For example: "Soft studio still life of frosted glass shards and smooth pebbles in icy blue and silver, diffuse top light, shallow depth of field, calm negative space in the upper third". Text, logos and devices are excluded automatically. Generation takes time; say so, and use `seed` for a variant.
- **Finishes** (`background.finish`) reprint or repaint the backdrop, never the UI:
  - risograph: bold, indie, playful (`colors` sets the two inks; match the app's accent).
  - newsprint: editorial, news, reading.
  - halftone: retro-pop, music, events.
  - dither: technical, indie, developer tools.
  - oil: food, lifestyle, craft.
  - watercolor: wellness, travel, journaling.
  - ink: calm, minimal, reading, tea.
  - fluted-glass: premium dark tech (pairs with indigo-fade or midnight).
  A finish on a painting or a photo is the most striking; on a plain gradient only fluted glass makes sense.

## 8. Effects

- `effects.grain` 0.08–0.2 (a filmic, premium texture; background only by default). `vignette` 0.2–0.35 on dark, moody images. `grade` presets (warm-film, cool-film, cinematic, faded, vivid, mono, noir) colour the backdrop only.
- `edgeBlur` wherever a device bleeds off an edge.
- `shadow`: "soft" on busy photos, "medium" by default, "studio" for a product-shot feel on light grounds.
- `glare` adds a subtle reflection; use it on one device at most.
- Don't stack effects: at most two at a noticeable strength.

## 9. 3D

- Tilt to add energy, and turn the device **toward** the headline or the centre: `rotateY` ±10–25, `rotateX` 4–10, optional `rotate` ±3–8.
- Keep text-heavy screens readable: under 15° when the UI must be read.
- Counter-rotated pairs (one −7°, one +6°) feel dynamic without chaos.
- In 3D, MacBooks and Watches use drawn frames (with real depth); flat, they use Apple's own art when installed.

## 10. Callouts

Use a callout when an image is about **one thing on the screen**. It's the fastest way to make a feature obvious. Pair it with a headline that names the same thing. Target by `text`, copied exactly from the visible text (use `match` for repeats and `row: false` to target only the words), or by `rect`.
- **lift**: pull one row or card forward over a dimmed screen. `breakout` 0.06–0.1 makes a card wider than the device (very effective). `scale` 1.04–1.1, `dim` 0.35–0.55.
- **loupe**: magnify a small value (a price, a timer, a chip). Move it beside the device with `offsetX`/`offsetY`; it still magnifies the target. `scale` 1.8–2.5, `size` 100–140.
- **spotlight** / **blur-rest**: one area in focus on a busy screen.
- **outline**: a tutorial ring around a control.
- **blur**: hide something private (an account number, a name).
- **highlighter**: a marker swipe over a number or phrase.
- **step** (1, 2, 3…) and **arrow**: how-to images. Markers sit beside their target (`at`), arrows start outside the device (`offsetX`, `offsetY`) and curve (`bend`) to the control.
Marketing images: one or two callouts. How-to images: up to three steps and an arrow. Callouts fade in on video.

### Shapes: marks you can place anywhere

`shapes` are drawn over the scene and the person can drag, resize and recolour each one afterwards. Types: `arrow`, `line`, `ellipse`, `rect`, `triangle`, `star`, `badge` (a number in a circle). Each has a `fill` and a `stroke` (a colour, or "none"), `strokeWidth` (0.004–0.008 of the canvas height reads well), `dash`, `opacity` and `shadow`.
- **Aim, don't guess.** To mark something on a screen, give `around: { device, text }` with the text copied exactly from the screen's visible text. An ellipse or rect goes around it, a badge sits beside it (`at`), and an arrow ends at its edge, starting beside the device unless you set `from`. The mark follows the device when it moves. `around` doesn't follow 3D tilt: on a tilted device use a callout instead.
- **Free shapes** take `x`, `y` (centre), `size` (height as a fraction of canvas height) and `aspect` (width ÷ height: 1 is a circle or square); arrows and lines take `from` and `to`, with `bend` to curve. Take positions from the entities, never from a guess.
- **`sketch: true`** draws it like a marker: a ring that overshoots, open arrowheads. It feels human and friendly, and suits tutorials, launch posts and social images. Clean shapes suit App Store sets and anything premium. Don't mix the two in one image.
- **An arrow from the headline to the thing it names** is the strongest use: `from` just under the caption, `around` the feature, `bend` 0.25–0.45.
- **Steps**: badges 1, 2, 3 beside their targets, in reading order; add one arrow at most.
- **Colour**: one mark colour for the whole image, picked to stand out from both the backdrop and the screen: the app's accent if it contrasts, else a clear red (#ff3b30), yellow (#ffd60a) on dark, or white with `shadow`. A white `stroke` ring on a badge keeps it readable over any screen.
- **Decoration** (a star or a few small circles near a headline, a pill behind a word) is rare: one to three small shapes in the palette, never competing with the device. When in doubt, leave it out.
- Callouts or shapes? Callouts change the screen itself (lift a card, magnify, dim the rest). Shapes sit on top and can go anywhere, including outside the device. Use whichever says it with less.

## 11. Devices and special shots

- Pick the newest hardware that matches the capture unless the person asks otherwise. `side: "back"` shows an iPhone's back, for hardware and colour shots.
- Web pages: a browser frame (`frame: "browser"`, `chrome` light or dark) or a MacBook. Mac apps: a MacBook, whose screen draws the macOS menu bar with the app's name and menus, or a window frame.
- Menu bar apps: scene `menuBar` { status, size } and the captured menu with `frame: "none"`; `size` 0.06–0.1 for a close, readable shot.
- Close-ups: `camera` { zoom, x, y }, focused on a point taken from the entities' positions.

## 12. Sets

- **Arc**: 1 hero (the main outcome, plus any real proof) → 2 what makes it different → 3–N one feature each, most important first → last: everything else (a mosaic with layout "grid", or a short feature list).
- **Consistent**: the same fonts, palette, backdrop family and device finish across the set; vary layout and composition.
- A backdrop or a device can cross from one image into the next for a panorama, but every image must still work alone.

## 13. Check your work

Before you call it done, look at the render and fix anything that fails:
- Headline readable at thumbnail size? Not touching the device? No orphan words? At most three lines?
- Is the device big enough, with no dead band over about 20% of the canvas?
- Does the backdrop belong to the app's colours, and stay behind the UI?
- Does every colour pass contrast, especially the accent words?
- Is there one clear hero and one clear idea?
- Are callouts and shapes on the right element (an arrow's head on its target, a ring around all of it), and does the headline name it?
- Did you keep what the person asked to keep, and follow the house style?
- Nothing invented: no fake ratings, awards, quotes or UI.

## 14. Turning vague requests into settings

- **"Make it pop" / "more striking"**: bigger device (bleed), bolder headline (weight 700–800, larger), one saturated accent, a stronger backdrop (colour block or a photo), a callout on the key element.
- **"More premium" / "more Apple"**: fewer elements, more space, a neutral or dark studio backdrop, grain 0.1, a silver or black device, serif-italic or tight-sans type, a studio shadow, no clutter.
- **"More playful"**: a saturated colour block or coral-periwinkle, rounded or chunky type, a counter-rotated pair or tilt, an eyebrow pill, a finish like risograph.
- **"Cleaner" / "simpler"**: remove extra texts and effects, one device upright, a calm backdrop, more margin.
- **"More dramatic"**: dark backdrop with one light (ember-glow, midnight), vignette, 3D tilt, dissolve, a close-up.
- **"Warmer" / "cooler"**: grade warm-film or cool-film, a backdrop in that temperature, a matching device finish.
- **"Match the app"**: backdrop from the app's own palette (tonal), the accent from its accent colour, fonts that echo its UI.
- **"Better" / "redesign it" / "make it amazing"**: you have licence to redesign. Apply this whole guide, keep the person's screenshots and words, and explain the idea in one sentence.
