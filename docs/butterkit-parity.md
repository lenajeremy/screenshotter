# ButterKit parity

What [ButterKit](https://www.butterkit.app) does, where Screenshotter stands on each item, and the order we're building the missing pieces in. Researched on 1 October 2026 from ButterKit's site, docs, pricing, roadmap, MCP tool reference, all 32 release notes (v1.0.4 to v2.5) and the clips on its landing and Motion pages.

Status: **have**, **partly** or **missing** in Screenshotter. Tick items off as they ship, and note the version.

## 1. Projects and canvas

- A project (`.butterkit` file) holds a whole screenshot set: many artboards side by side on one canvas, grouped by size ("iPhone 6.9" for App Store · 1290 × 2796 · 9 artboards") and numbered in store order ("01 · Introduction", "02 · Bottom"). **Have** (phase 1): a design's screens side by side, numbered and named, at one or several sizes.
- Artboard list: add (with a menu of artboard types), rename on the canvas, reorder, duplicate, delete with a confirmation, copy and paste between projects. **Have**: add, rename, reorder, duplicate, delete (with Undo); not copy and paste between designs.
- "Copy Style to…" for text blocks, and copying 3D devices, to other artboards. **Have**: Copy style (backdrop, text, film look, device look and placement) to the size's screens or every size.
- Size presets for every App Store slot, landscape included, plus Apple Watch, Apple TV, Vision Pro and Google Play. Changing a preset swaps the device. **Have.**
- Infinite canvas with trackpad and middle-mouse navigation, ⌘1 to ⌘4 for inspector tabs, undo and redo, light and dark modes, the interface in 5 languages, recent projects on launch, toasts and macOS notifications. **Partly**: dark only, English only.
- App Store preview: a mock product page for each device (iPhone, iPad, Mac) and language, with arrows to page through. **Have**, per size; languages come with phase 2.

## 2. Capture and import

- Capture Tool: a floating panel that follows the Simulator window (or Xcode 27's Device Hub). It picks the app, the app's language (read from its String Catalog) and the target artboard, captures in one click (the button turns green), then moves on to the next artboard. **Partly**: we capture from the Screenshots panel, with deep links and launch arguments; no floating tool, no language switch, no Device Hub.
- Drag a PNG or JPG onto a device. **Have.**
- Link a folder (for example Fastlane's output): matches files by language folder, then device folder, then the number at the end of the filename; watches for changes; shows a summary of what matched. **Missing.**
- A guide to automating capture with Fastlane snapshot. **Missing.**

## 3. Devices

- Real-time 3D models (Metal and RealityKit): free X, Y and Z rotation, scale, X, Y and Z offset, HDR lighting. **Partly**: Apple's art tilted in perspective with an extruded body; real 3D models are an open decision.
- Device styles: Realistic, Clay (any colour), UI only. **Partly**: Apple's art (realistic), browser, window, card and no frame; no clay.
- Realistic materials and colours, a camera cutout (notch) toggle, iPhone Duo's hinge. **Partly**: colours and the Dynamic Island setting.
- Models: iPhone 17 Pro Max, 18 Pro Max, Duo, 15 Pro Max; iPad Pro 11" and 12.9"; MacBook Pro 16"; Apple Watch Series 11 and Ultra; Vision Pro; Pixel 10 Pro; a generic device. **Partly**: no Vision Pro, Pixel or generic device.
- 3D drop shadows. **Partly**: 2D shadows.
- Device Overflow: one device spanning neighbouring artboards. **Have** (0.6.0): "Carry on into the next screens"; the neighbours draw its continuation behind their own devices.
- Callouts: a region of the screenshot raised as its own 3D plane, with altitude, scale, corner radius and a border; different per language. **Have** in 2D (lift, breakout, loupe, outline, spotlight); **missing** per language.

## 4. Text and images

- Text blocks with roles (title, subtitle), Markdown bold and italic. **Have.**
- Fit on 1 line (auto-shrink), line height, ligatures, independent left and right padding, decoration (italic, underline, strikethrough), stroke colour and width, shadows, a character counter, drag to reposition. **Partly**: shadow, weight, tracking, uppercase, blur.
- Text backgrounds (badges, pills, highlights) that resize and reflow for each translation. **Partly**: a badge preset.
- "Do Not Translate" toggle per text block. **Missing.**
- Image blocks: logos, award laurels, badges, stickers, with position, scale, opacity, rotation and order; a different image per language. **Missing.**
- Fonts: system fonts, bundled Google Fonts (Inter, Fraunces and others), and any font installed on the Mac. **Have.**

## 5. Backgrounds

- Solid colour, gradient, image. **Have**, and ahead: looks, paintings, photos, print finishes, AI images.
- Seamless panoramic background: one ultra-wide image sliced across a group of artboards. **Have** (0.6.0): Backdrop › Across the set.
- Background overrides per language. **Missing.**

## 6. Templates

- Bundled templates; a gallery on the website filtered by platform, orientation and category; free downloadable templates (MIT licence, editable SVG backgrounds); device add-ons; saving your own templates. **Partly**: our templates are generated from the person's own screenshot (they don't do that), but there's no gallery, no save-as-template and no sharing.

## 7. Localization (missing entirely)

- A Localizations panel; variant artboards per language that inherit from the source and can override text, size, padding, background, images and callouts.
- Translation engines: on-device (Apple's Translation framework, about 19 languages, free, offline), cloud with your own key (OpenAI, Gemini, Claude, OpenRouter, any OpenAI-compatible endpoint such as Ollama or LM Studio), and manual.
- All 50 App Store Connect languages; market-size data when adding a language.
- Delta translation (only changed text is re-translated); translation instructions per project (tone, capitalisation, words never to translate).

## 8. App Store metadata (missing)

- Description, promotional text, What's New, keywords and subtitle per language, with character limits and emoji checks, translated with the screenshots.

## 9. Publish

- Export: pick artboards, scale, transparent background, anti-aliasing, organised folders. **Partly**: the whole set at full size in folders by size or for fastlane, PNG or JPEG; no picking artboards, scale or anti-aliasing options.
- Upload to App Store Connect through Apple's API: an API key (issuer ID, key ID, `.p8`) in the Keychain, a connection test, choice of app, version, device and languages, screenshots in the right display-size slots and in order, retries, batching, a live log, metadata that never overwrites fields left empty, uploads to rejected versions, Product Page Headers. **Missing.**

## 10. AI agents (MCP)

- 42 tools in 5 groups: Document (list, open, create, snapshot, save, close), Design (artboards, templates, size presets, background, text blocks, image blocks, devices, screenshot folder), Export (export artboards, preview render), Localization (languages, translation, metadata), App Store Connect (credentials, apps, versions, upload screenshots, upload metadata). An agent import folder for images; an `--auto-launch` flag. **Partly**: our 27 tools are strong on capture and design but have nothing for sets, languages or App Store Connect.

## 11. Motion (a separate beta app)

- Screen recordings turned into product videos: new screen recording, a media library, a scene strip, a layer timeline (logo, text, intro and outro, callouts, the recording "take" at adjustable speed, narration), a music track with bundled music, an animated "Dynamic Gradient" background (noise, speed, randomize), Text Left and Text Right layouts, 3D device frames, export. **Partly**: Animate covers the timeline, shots, devices and camera; no audio, intro and outro presets, playback speed or animated gradient.

## 12. Business and site

- Free with a watermark; Pro $99 once (5 Macs) or $39 a year as a supporter; Mac App Store and direct sales; 14-day refund; education discount; affiliates and a free-licence programme; in-app updates; optional diagnostics.
- Docs, a changelog with RSS, a public roadmap, comparison pages, guides (screenshot sizes, design cheatsheet), a reviews page, a press kit, Discord and a subreddit.

## Where Screenshotter is already ahead

- Ask AI with vision (Claude or Codex) and Design it for me.
- Templates built from the person's own screenshot.
- Art-directed backdrops, print finishes and AI images.
- Highlights aimed at text found on the screen; shapes and arrows.
- Capture from websites and Mac apps, not just the Simulator.
- App Store preview videos built into the same app.
- A remembered house style.

## The plan

In dependency order. Each phase lists what "done" means.

1. **Sets** (the foundation; everything below needs it). *Done on 1 October 2026.* A project of artboards on one canvas, grouped by size and numbered in store order; add, rename, reorder, duplicate and delete; copy style across artboards; the full App Store size matrix (landscape, Watch, Apple TV, Vision Pro, Google Play); batch export into Fastlane-style folders; the App Store page preview; MCP tools for sets.
2. **Localization.** *Next: see "Phase 2 in detail" below.* Variant artboards with inheritance and overrides; translation through Claude Code, Codex or an API key, plus Apple's on-device translation through the Swift app; manual mode; Do Not Translate; translation instructions; delta translation; fit-to-one-line and reflowing text; per-language images; capturing each language by relaunching the app in the Simulator in that language.
3. **App Store Connect.** The API key in the Keychain; apps and versions; screenshots uploaded into the right slots in order, plus app preview videos (ButterKit doesn't); a metadata editor with limits and validation; translating and uploading metadata.
4. **Automation.** A floating Capture Tool that follows the Simulator; a linked Fastlane folder that's watched for changes; MCP tools for languages and App Store Connect; a command-line tool for CI.
5. **Design parity.** Clay and UI-only styles; image blocks (logos, laurels, stickers); text stroke, decoration, padding, line height and pills; panoramic backgrounds; Device Overflow; more device models (Vision Pro, Apple TV, Pixel, generic); review and award templates. Real 3D devices is a separate decision: it needs 3D models we can license or build, and a WebGL renderer.
6. **Templates and business.** A template gallery; saving and sharing templates; a free tier with a watermark and a Pro licence; in-app updates; docs, changelog, roadmap and comparison pages.

Motion's extras (music, narration, intro and outro presets, animated gradients, playback speed) can follow phase 3, building on Animate.

## Phase 1 in detail: Sets

Decided on 1 October 2026: **one list, two uses.** A design's screens are its App Store screenshots in Edit, and the same screens play in order as its preview video in Animate (each with its length and transition). A screen can be left out of the video. Existing multi-shot videos are sets already.

A design holds one list of screens per size ("iPhone 6.9″", "iPad 13″", "Apple Watch"). In the Studio the active size's screens are `S.shots` (the screen being edited is `S.scene`), so Animate, the video export and multi-shot Ask AI work as before; the other sizes wait in `S.groups`. On disk, `scene` and `shots` stay the first size (older readers and agents keep working) and `groups` holds every size.

Steps, each shipped and tested on its own:

1. **Sizes.** Every App Store slot as a preset: iPhone, iPad, Mac, Apple Watch, Apple TV, Vision Pro, Google Play, portrait and landscape. Choosing a size swaps the device to match. *Done (88d2610).*
2. **The set on the canvas.** In Edit, every screen of the size side by side, labelled "01 · Name"; click one to edit it; "Fit the set" and "Fit this screen"; an "Add screen" tile; a menu on each screen to rename, duplicate, move and delete; ← and → (with nothing selected) to step through. *Done (45eeb85).* "Leave out of the video" shipped with step 5.
3. **Sizes in one design.** A size switcher above the set; "Add a size" makes the whole set again at that size (devices swapped to suit); remove a size. In a set the image size is the set's: changing it changes every screen. *Done.*
4. **Copy style.** Backdrop, text style, device and film look onto every screen of the set (or of every size). *Done*: from a screen's menu or the inspector; devices only within a size. Landscape and custom sizes also change the whole set.
5. **Export the set.** Every screen of every size in one go, into folders by language and size with numbered filenames, plus a contact sheet per size; and the App Store page preview. *Done*: Export → Set, "By size" (`en-US/iPhone 6.9/01 Introduction.png`) or "fastlane" (`screenshots/en-US/iPhone 6.9 - 01 Introduction.png`), PNG or JPEG at full size; "Preview the store page" shows each size's row on a sketch of the product page. A screen can be left out of the video (its menu, on the canvas or Animate's strip): it takes no time, the screens either side join with the later one's transition, and Ask AI and agents see the flag (`video: false`).
6. **Agents.** `get_scene` and `save_scene` carry sizes and screen names; a tool to export a saved design's whole set. *Done*: `list_scenes` counts screens and sizes, `get_scene` returns every size, `save_scene` takes `sizes` and names (saving just the first screen keeps the other sizes; a copy keeps them too), and `export_scene_set` exports a saved set by size or for fastlane, returning its contact sheets.

## Phase 2 in detail: Localization

A design gets **languages**. The first is the source (the words as written); every other language holds its own words for each screen, and anything else it overrides (a screenshot captured in that language, a smaller headline, another backdrop). Words are kept per screen and shared by every size, since sizes are copies of the same screens, so the German headline of screen 3 is the same on iPhone, iPad and Watch. On disk the source stays where it is (`scene`, `shots`, `groups`), so older readers and agents keep working, and `languages` holds the rest.

Steps, each shipped and tested on its own:

1. **Languages in a design.** Add and remove languages from all 50 App Store Connect languages, with the biggest markets first; a language switcher beside the size switcher; the canvas, Preview and the store page preview show the chosen language; editing a text in a language changes that language only, and the source's change is marked for translation everywhere else.
2. **Translate.** Every text of every screen at once, into one language or all, through the engine Ask AI already uses (Claude Code or Codex: no new setup), with manual editing always; then Apple's on-device translation through the Mac app, and an API key (OpenAI, Claude, Gemini, OpenRouter or any OpenAI-compatible endpoint) as options. Only what changed is translated again; translation instructions per design (tone, capitalisation, words never to translate); **Do Not Translate** per text.
3. **Text that fits.** Fit to one line (shrink to fit), and longer languages reflowing within the text's box, with a warning on any screen where a translation still doesn't fit.
4. **Screenshots in every language.** Capture each screen in each language by relaunching the app in the Simulator in that language (`-AppleLanguages`, `-AppleLocale`), filed under the language; a per-language screenshot, image or backdrop on any screen.
5. **Export every language.** The set export's language folders filled for every language (by size, or fastlane's `screenshots/<language>/`), contact sheets per language, and the store page preview per language.
6. **Agents.** MCP tools to list, add and translate a design's languages and read or write its words, and `export_scene_set` for any or every language.

## Open decisions

- Real 3D devices: likely needed for tilt to look right (Jeremiah, 1 October 2026). Until then, devices are Apple's own art only: the device list shows the models whose art is installed, the drawn frames are off (`SCREENSHOTTER_DRAWN_FRAMES=1` brings them back for development), and a tilted device is its art in perspective with a body extruded from its silhouette (a watch's case alone, its band a flat strap).
- Mac App Store or direct sales only (the store needs sandboxing and a bundled Node).
