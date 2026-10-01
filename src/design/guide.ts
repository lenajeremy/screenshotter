/**
 * How to design screenshots that sell: the design guide both agents follow, Ask AI in the Studio
 * and any agent using the MCP server (as the `design_guide` tool and the Claude Code skill).
 * Everything here is expressed in the scene's own fields, so it applies to create_mockup requests
 * and to Ask AI's edits alike.
 */
export const DESIGN_GUIDE = `# Designing screenshots that sell

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
- **Make the device big.** On a portrait App Store canvas a single phone should be 60–80% of the canvas height (\`height\` 0.6–0.8), or larger and bleeding off the bottom (\`height\` 0.85–1.1 with \`y\` so 10–30% runs off). A small phone floating in empty space is the most common amateur tell.
- **Bleed on purpose.** Cropping a device at an edge makes it bigger and reads as confident. Crop the part that says least, usually the bottom of the screen. \`effects.edgeBlur\` softens the cut.
- **Leave room for the words.** Captions sit in the top 25–35% of a portrait canvas; keep 6% margins; the headline must never touch or overlap the device.
- **Balance.** Centre heroes. Off-centre (device \`x\` 0.3–0.35 or 0.65–0.7) leaves open space for a headline on wide canvases.
- **Depth.** Overlap devices (\`z\`), vary their size, blur the one behind (\`blur\` 0.003–0.006), use \`shadow\` "studio" on light backdrops.
- **Patterns that work** (set these fields):
  - *Hero*: layout "hero", one device, headline on top.
  - *Hero bleed*: layout "hero-bleed", or \`height\` 0.95, \`y\` 0.78: a huge phone rising from the bottom edge.
  - *Tilted*: \`rotateY\` −14 to −22, \`rotateX\` 5–8, \`rotate\` −3; turn the device toward the headline or the centre.
  - *Duo / staircase / rising*: two or three screens that tell a sequence (list → detail). layout "staircase" steps them up, "rising" counter-rotates them.
  - *Split*: layout "split" on wide canvases: words on one side, device on the other.
  - *Ecosystem*: MacBook + iPhone (layout "stack"), iPhone + Watch with the watch lifted in front (\`z\`, \`rotateY\` 15–25).
  - *Depth of field*: a large device behind with \`blur\`, a sharp device in front.
  - *Dissolve*: \`fade\` 0.35–0.5 on devices over a dark backdrop; screens melt into the dark.
  - *Close-up*: \`camera\` { zoom 2–3, x, y } onto one part of a device (a widget, a chart, a menu).
  - *Mosaic*: layout "grid" with 4–9 screens: "everything in one app", a closing image.
  - *Menu bar app*: a scene \`menuBar\` with \`status\`, the app's menu (frame "none") hung under it.
- **Rhythm across a set.** Never use the same layout twice in a row. Alternate centred and off-centre, upright and tilted, one device and two, light and dark backdrops.

## 4. Words

- **One idea per headline.** Never two ideas joined by "and". Short, common words.
- **2–5 words per line, at most 3 lines**, broken by hand with \\n so each line is a phrase. No orphans (one word alone on a line).
- **Benefit, not feature.** "Know where every dollar goes", not "Transaction categorisation". Three reliable shapes: paint a moment ("Dinner, decided."), state an outcome ("Your money, finally clear."), kill a pain ("Never miss a refill again.").
- **Emphasise one phrase** with **double asterisks**: the benefit word. Style it (see Typography).
- **Subheadline** only if it adds a fact the headline can't hold; a short line, lighter weight.
- **Eyebrow labels**: a small uppercase pill above the headline (\`texts\` with \`background\`, \`uppercase\`, \`letterSpacing\` 0.08–0.14, \`size\` 0.016–0.02) for category or "NEW".
- **Proof** (ratings, awards, press quotes, user counts) only when the person supplied it; never invent it. Put it on the first image only: "★★★★★ 4.9 · 12K ratings" as a small text.
- **Never** "Download now", prices or UI instructions in marketing headlines. The store already has the button.
- **Size**: \`textStyle.headlineSize\` 0.042–0.06 of canvas height on portrait App Store canvases (big enough to read at thumbnail size), 0.07–0.1 on 16:9. Weight 600–800 for sans headlines. \`letterSpacing\` −0.02 to −0.035 for display sizes.
- **Keep the person's words** when they wrote them. Rewrite only when asked, or when the copy clearly breaks these rules, and say so.

## 5. Typography

- **Built in**: "sf-pro" (neutral, native), "sf-rounded" (friendly, health, kids), "new-york" (editorial serif), "sf-mono" (technical labels).
- **Any Google Fonts family** by name. Pairings that work:
  - Modern product: "Inter Tight" 600–700; accent in "Instrument Serif" italic.
  - Premium, editorial, lifestyle, food: "Fraunces" 500–600, or "Playfair Display" 600; subheadline "Inter".
  - Tech, developer, fintech: "Space Grotesk" 600 or "Geist" 600; labels "Geist Mono" or "JetBrains Mono".
  - Friendly, playful: "Bricolage Grotesque" 700, "Nunito" 800, "Unbounded" 600.
  - Bold, sporty, loud: "Anton" or "Bebas Neue" (single-weight: use weight 400) with \`uppercase\`.
  - Luxury, calm: "Cormorant Garamond" 600, or "Instrument Serif" 400 for the whole headline.
  - Handwritten accent, sparingly: "Caveat" 600.
- **Single-weight faces** (Anton, Bebas Neue, Archivo Black, Instrument Serif, DM Serif Display) only have 400: set that weight.
- **Emphasis techniques** for the **accent** phrase:
  - Colour: \`textStyle.accentColor\` (the app's accent, adjusted for contrast), or a CSS gradient.
  - Weight contrast: \`headlineWeight\` 400 with \`accentWeight\` 800 (and no accent colour).
  - Serif italic in a sans headline: \`accentFont\` "Instrument Serif", \`accentItalic\` true, \`accentWeight\` 400: elegant and very current.
- **At most two families** (plus a mono for tiny labels). \`subheadlineFont\` pairs a different face under the headline.

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
- **Contrast**: headline and accent colours need at least 4.5:1 against what's behind them. On photos and paintings, pick a calm area for the words, or add \`textStyle.shadow\`, \`dim\` or \`haze\` to the photo.
- **Device finish echoes the palette**: warm backdrops with warm finishes (Cosmic Orange, Burgundy, Light Gold, Natural), cool with cool (Deep Blue, Glacier, Sky Blue), Silver or White on light, Black on dark. Use the model's own colour names.

## 7. Backdrops

- **Looks** (\`background: "<name>"\`): photographic (meadow-motion, clouds, dusk, dunes, forest-mist, city-bokeh…), public-domain paintings and prints (great-wave, fuji-coast, woodblock-fuji, morning-glories, hollyhocks, monet-bridge, monet-garden, green-wheat, olive-grove, golden-sea, lake-mountains, misty-hills, pastel-shore, iris-plate, wisteria-plate) and soft grounds (cream-grain, peach-glow, lavender-mist, mint-sage, iridescent, coral-periwinkle, indigo-fade, ember-glow, midnight, aurora, paper, studio-white…). The looks list gives each one's tone.
- **Colours**: \`{ color }\`, \`{ colors, angle }\` (gradient), \`{ type: "radial", colors, x, y }\` (a glow), \`{ type: "mesh", colors, meshStyle }\`.
- **Photos**: \`{ unsplash: "search words" }\` describes a place; pick with \`seed\`. Treat it so it stays behind the UI: \`blur\` 0.002–0.006, \`motionBlur\` 0.05–0.08 (a sense of speed), \`haze\` 0.2–0.4 (airy, lifts text contrast), \`dim\` 0.1–0.3 (for white text), \`tint\` + \`tintAmount\` (pull it into the palette).
- **AI images** (\`{ generate: "prompt" }\`) only when the person asks for a generated image, or when nothing built in can meet the request (no look, painting, Unsplash photo, gradient or colour fits). A new image takes half a minute or more and costs money; everything above is instant. Keep an existing generated backdrop as it is unless asked: changing its prompt or seed makes a new one. Write the prompt like a photographer's brief: subject and material, light, palette taken from the app, camera and composition, with empty space where the words go. For example: "Soft studio still life of frosted glass shards and smooth pebbles in icy blue and silver, diffuse top light, shallow depth of field, calm negative space in the upper third". Text, logos and devices are excluded automatically. Generation takes time; say so, and use \`seed\` for a variant.
- **Finishes** (\`background.finish\`) reprint or repaint the backdrop, never the UI:
  - risograph: bold, indie, playful (\`colors\` sets the two inks; match the app's accent).
  - newsprint: editorial, news, reading.
  - halftone: retro-pop, music, events.
  - dither: technical, indie, developer tools.
  - oil: food, lifestyle, craft.
  - watercolor: wellness, travel, journaling.
  - ink: calm, minimal, reading, tea.
  - fluted-glass: premium dark tech (pairs with indigo-fade or midnight).
  A finish on a painting or a photo is the most striking; on a plain gradient only fluted glass makes sense.

## 8. Effects

- \`effects.grain\` 0.08–0.2 (a filmic, premium texture; background only by default). \`vignette\` 0.2–0.35 on dark, moody images. \`grade\` presets (warm-film, cool-film, cinematic, faded, vivid, mono, noir) colour the backdrop only.
- \`edgeBlur\` wherever a device bleeds off an edge.
- \`shadow\`: "soft" on busy photos, "medium" by default, "studio" for a product-shot feel on light grounds.
- \`glare\` adds a subtle reflection; use it on one device at most.
- Don't stack effects: at most two at a noticeable strength.

## 9. 3D

- Tilt to add energy, and turn the device **toward** the headline or the centre: \`rotateY\` ±10–25, \`rotateX\` 4–10, optional \`rotate\` ±3–8.
- Keep text-heavy screens readable: under 15° when the UI must be read.
- Counter-rotated pairs (one −7°, one +6°) feel dynamic without chaos.
- Devices are Apple's own product art, flat or tilted in 3D. Only the models list_mockup_options lists are installed; another is shown as an installed one of its family (or as its bare screen).

## 10. Callouts

Use a callout when an image is about **one thing on the screen**. It's the fastest way to make a feature obvious. Pair it with a headline that names the same thing. Target by \`text\`, copied exactly from the visible text (use \`match\` for repeats and \`row: false\` to target only the words), or by \`rect\`.
- **lift**: pull one row or card forward over a dimmed screen. \`breakout\` 0.06–0.1 makes a card wider than the device (very effective). \`scale\` 1.04–1.1, \`dim\` 0.35–0.55.
- **loupe**: magnify a small value (a price, a timer, a chip). Move it beside the device with \`offsetX\`/\`offsetY\`; it still magnifies the target. \`scale\` 1.8–2.5, \`size\` 100–140.
- **spotlight** / **blur-rest**: one area in focus on a busy screen.
- **outline**: a tutorial ring around a control.
- **blur**: hide something private (an account number, a name).
- **highlighter**: a marker swipe over a number or phrase.
- **step** (1, 2, 3…) and **arrow**: how-to images. Markers sit beside their target (\`at\`), arrows start outside the device (\`offsetX\`, \`offsetY\`) and curve (\`bend\`) to the control.
Marketing images: one or two callouts. How-to images: up to three steps and an arrow. Callouts fade in on video.

### Shapes: marks you can place anywhere

\`shapes\` are drawn over the scene and the person can drag, resize and recolour each one afterwards. Types: \`arrow\`, \`line\`, \`ellipse\`, \`rect\`, \`triangle\`, \`star\`, \`badge\` (a number in a circle). Each has a \`fill\` and a \`stroke\` (a colour, or "none"), \`strokeWidth\` (0.004–0.008 of the canvas height reads well), \`dash\`, \`opacity\` and \`shadow\`.
- **Aim, don't guess.** To mark something on a screen, give \`around: { device, text }\` with the text copied exactly from the screen's visible text. An ellipse or rect goes around it, a badge sits beside it (\`at\`), and an arrow ends at its edge, starting beside the device unless you set \`from\`. The mark follows the device when it moves. \`around\` doesn't follow 3D tilt: on a tilted device use a callout instead.
- **Free shapes** take \`x\`, \`y\` (centre), \`size\` (height as a fraction of canvas height) and \`aspect\` (width ÷ height: 1 is a circle or square); arrows and lines take \`from\` and \`to\`, with \`bend\` to curve. Take positions from the entities, never from a guess.
- **\`sketch: true\`** draws it like a marker: a ring that overshoots, open arrowheads. It feels human and friendly, and suits tutorials, launch posts and social images. Clean shapes suit App Store sets and anything premium. Don't mix the two in one image.
- **An arrow from the headline to the thing it names** is the strongest use: \`from\` just under the caption, \`around\` the feature, \`bend\` 0.25–0.45.
- **Steps**: badges 1, 2, 3 beside their targets, in reading order; add one arrow at most.
- **Colour**: one mark colour for the whole image, picked to stand out from both the backdrop and the screen: the app's accent if it contrasts, else a clear red (#ff3b30), yellow (#ffd60a) on dark, or white with \`shadow\`. A white \`stroke\` ring on a badge keeps it readable over any screen.
- **Decoration** (a star or a few small circles near a headline, a pill behind a word) is rare: one to three small shapes in the palette, never competing with the device. When in doubt, leave it out.
- Callouts or shapes? Callouts change the screen itself (lift a card, magnify, dim the rest). Shapes sit on top and can go anywhere, including outside the device. Use whichever says it with less.

## 11. Devices and special shots

- Pick the newest installed hardware that matches the capture unless the person asks otherwise. For an Apple Watch, \`band\` picks the band from the finish's list (a Sport Band by default): match it to the app's palette.
- Web pages: a browser frame (\`frame: "browser"\`, \`chrome\` light or dark) or a MacBook. Mac apps: a MacBook, whose screen draws the macOS menu bar with the app's name and menus, or a window frame.
- Menu bar apps: scene \`menuBar\` { status, size } and the captured menu with \`frame: "none"\`; \`size\` 0.06–0.1 for a close, readable shot.
- Close-ups: \`camera\` { zoom, x, y }, focused on a point taken from the entities' positions.

## 12. Animation (videos)

\`animations\` on a scene say when and how each item appears, changes and leaves in a video (create_video, and the Studio's video export). Still images ignore them. Items not animated are there from the start.

- **Targets** are item ids as the layout lists them: \`"device-1"\`, \`"caption"\`, \`"text-2"\`, \`"shape-1"\`. Several in one animation move as a group: \`{ targets: ["device-1", "device-2"], at: 2.5, enter: "zoom" }\` zooms a laptop and phone in together from their shared centre. \`stagger\` starts them one after another.
- **Entrances** (\`enter\`): fade, zoom, scale-x, scale-y, slide-up, slide-down, slide-left, slide-right (the way it moves), none. \`amount\` sets zoom's starting size or a slide's distance. \`exit\` plays the same effects out.
- **Changes** (\`to\`): animate to new values and stay there. Anything: opacity, scale, scaleX, scaleY, rotate, dx/dy (move by a share of the canvas), x/y (move its centre there). Devices: rotateX (tilt), rotateY (turn). Text: color. Shapes: fill, stroke, strokeWidth, radius; lines and arrows: start, end (its two ends) and bend. \`from\` is the reverse: start from these values and arrive at the design.
- **The camera** is a target too: \`{ targets: "camera", at: 3, duration: 1, to: { zoom: 2.5, x: 0.8, y: 0.6 } }\` pushes in on a point (canvas fractions, taken from the entities), another such move glides from there to the next point, and \`to: { zoom: 1 }\` pulls back. It moves the whole picture, text included. Use it to go from the whole design into a detail on a screen: the row, number or button the headline is about. Hold each close-up for a second or more; two or three moves in a video, not more.
- **Call-outs on cue**: a device's highlights are targets too, \`"device-1/callout-2"\` (its highlights, counting from 1). \`{ targets: "device-1/callout-1", at: 2.4, enter: "fade" }\` brings the lift, loupe or outline in when the story reaches it (it arrives the way its style does: a lift rises, a loupe grows); \`exit\` takes it away. Several in one animation with \`stagger\` walk through them in turn. Call-outs you don't time appear together a quarter of the way in.
- **Loops**: a Change with \`repeat: true\` keeps going for the whole video. A float, \`{ targets: "device-1", at: 1, duration: 1.6, to: { dy: -0.012 }, repeat: true, yoyo: true }\`; a pulse on a badge, \`to: { scale: 1.08 }\` with \`yoyo\`; a slow spin on a star, \`to: { rotate: 360 }\` over 6 s. Loops are ambience: one or two small ones, on decoration or the hero device, never on the words the viewer is reading.
- **Along a curve**: \`path\` sends an item along a route from where it is: \`{ shape: "circle", size: 0.03 }\` (an orbit; also "oval" and "figure-8") or \`{ points: [{ x, y }, …] }\` through points on a smooth curve (\`closed\` comes back round; \`orient\` turns it to face the way it goes, like a paper plane). With \`repeat: true\` a loop goes round for the whole video.
- **The backdrop** moves on its own: \`{ targets: "backdrop", at: 0, duration: 6, to: { zoom: 1.15 } }\` is a slow push into a photo (the Ken Burns look), \`x\`/\`y\` aim it, \`rotate\` turns it, \`hue\` shifts its colours (30 is gentle) and \`blur\` softens it; \`from: { blur: 0.02 }\` brings it into focus. Slow and steady: it should be felt more than seen.
- **Blur**: anything can be soft (\`blur\` on a text, a shape, a device or the headline's textStyle) and anything's blur animates. \`enter: "blur"\` brings text into focus, beautiful \`by: "word"\`.
- **Rack focus**: a device's \`blur\` animates. Two Changes at the same moment, \`{ targets: "device-1", to: { blur: 0.012 } }\` and \`{ targets: "device-2", to: { blur: 0 } }\`, shift the eye from the laptop to the phone (start device-2 with its own \`blur\` so it begins soft). Use it once, when the story moves from one screen to the other.
- **Text by word or letter**: \`by: "word"\` (or \`"letter"\`) on a text's entrance brings it in a piece at a time, \`each\` seconds apart (default 0.08 per word, 0.03 per letter): \`{ targets: "caption", at: 0.3, enter: "slide-up", by: "word" }\`. Words suit headlines; letters suit short labels and numbers. Keep the whole reveal under about 1.5 s.
- **Timing**: \`at\` (seconds), \`duration\` (default 0.6), \`ease\`: ease-out (default), ease-in, ease-in-out, linear, back-out (a little overshoot), spring, bounce.
- **Pacing that works**: open on the backdrop; headline in by 0.3–0.6 s; the hero device 0.4–0.8 s later (zoom or slide-up, 0.7–0.9 s, back-out for energy or ease-out for calm); supporting devices, call-outs and shapes after, 0.3–0.6 s apart. One idea per beat, nothing moving while the viewer should be reading, and leave a second at the end. Draw an arrow by animating its \`end\` from its start point; grow a circle around something with \`enter: "zoom"\`.
- **Look at it.** preview_video returns the video's frames at its key moments (each animation's end, the middle of long ones, the settled end) in about a second, without rendering the video. Check each one: nothing alone on an empty frame, nothing half out of frame, each close-up on its subject. create_video's filmstrip shows the same moments.
- The video runs long enough for the animations to finish unless \`video.duration\` says otherwise.
- **Several shots** (create_sequence): one idea a shot, 2 to 4 seconds each, the first shot the strongest (it's the App Store's poster, and what people see before they scroll). Let each shot's animations land in its first second or so, then hold. Transitions: a crossfade by default; a push when one shot follows from the last (the next screen, the next step); a cut for rhythm; through black between chapters; an iris or zoom once, at most. Keep one backdrop family across shots so it feels like one film. preview_sequence shows every shot's key moments before rendering.
- **Sizes**: an App Store preview is 886×1920 for iPhone, 1200×1600 for iPad, 1920×1080 for Mac, 15 to 30 seconds (\`size: "app-store-iphone"\` and the like follow Apple's rules). Design at the shape you'll use most; \`versions\` makes the rest (9:16 for Reels and TikTok, 4:5 for feeds, 1:1, 16:9). A hand-placed design fits whole into another shape; an automatic layout is laid out again.

## 13. Sets

- **Arc**: 1 hero (the main outcome, plus any real proof) → 2 what makes it different → 3–N one feature each, most important first → last: everything else (a mosaic with layout "grid", or a short feature list).
- **Consistent**: the same fonts, palette, backdrop family and device finish across the set; vary layout and composition.
- A backdrop or a device can cross from one image into the next for a panorama, but every image must still work alone.

## 14. Check your work

Before you call it done, look at the render and fix anything that fails:
- Headline readable at thumbnail size? Not touching the device? No orphan words? At most three lines?
- Is the device big enough, with no dead band over about 20% of the canvas?
- Does the backdrop belong to the app's colours, and stay behind the UI?
- Does every colour pass contrast, especially the accent words?
- Is there one clear hero and one clear idea?
- Are callouts and shapes on the right element (an arrow's head on its target, a ring around all of it), and does the headline name it?
- Did you keep what the person asked to keep, and follow the house style?
- Nothing invented: no fake ratings, awards, quotes or UI.

## 15. Turning vague requests into settings

- **"Make it pop" / "more striking"**: bigger device (bleed), bolder headline (weight 700–800, larger), one saturated accent, a stronger backdrop (colour block or a photo), a callout on the key element.
- **"More premium" / "more Apple"**: fewer elements, more space, a neutral or dark studio backdrop, grain 0.1, a silver or black device, serif-italic or tight-sans type, a studio shadow, no clutter.
- **"More playful"**: a saturated colour block or coral-periwinkle, rounded or chunky type, a counter-rotated pair or tilt, an eyebrow pill, a finish like risograph.
- **"Cleaner" / "simpler"**: remove extra texts and effects, one device upright, a calm backdrop, more margin.
- **"More dramatic"**: dark backdrop with one light (ember-glow, midnight), vignette, 3D tilt, dissolve, a close-up.
- **"Warmer" / "cooler"**: grade warm-film or cool-film, a backdrop in that temperature, a matching device finish.
- **"Match the app"**: backdrop from the app's own palette (tonal), the accent from its accent colour, fonts that echo its UI.
- **"Better" / "redesign it" / "make it amazing"**: you have licence to redesign. Apply this whole guide, keep the person's screenshots and words, and explain the idea in one sentence.
`;
