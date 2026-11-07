# UI and UX audit: the Studio and the capture UI

Pass 1 of 2: what's wrong, what's good and what to change. Pass 2 fixes it, in the order at the end.

**Status (pass 2, 7 November 2026): every finding has been addressed.** Screenshots after each fix are the `ui-audit/after-*.jpg` files. Not done: dragging gradient stops (part of U15), because gradients don't store stop positions, so the format the renderer and MCP tools share would have to change. Also unchanged: landscape starting designs still sit letterboxed in their portrait cards (U2).

**How it was checked (7 November 2026, 0.12.0 plus `main`).** A separate Studio was run with its own library and notes, so the real library wasn't touched. It was screenshotted in WebKit, the Mac app's engine:
- **Window sizes:** 1440×900, the app's default 1360×880, and the small 1280×800 and 1024×720 (the window's minimum is 1040×660).
- **Mac-only parts:** shown by faking the native bridge.
- **Recording editor:** opened on 12 s of a real recording, with a generated cursor log and a stand-in webcam clip.
- **Native capture UI:** drawn with `--ui-snapshots`.
- **Ask AI:** conversations and progress were faked through the store; nothing called a model.

Screenshots are in [`ui-audit/`](ui-audit/). Each finding has an ID (B for bugs, U for flows and structure, V for the visual system, N for the native UI), a priority and the shot it comes from.

**Priority:** **P0** is broken or plainly wrong; fix first. **P1** is confusing or slows people down. **P2** is polish.

---

## What's good (keep it)

- **The recording editor is the best screen** ([81](ui-audit/81-rec-editor.jpg)).
  - The Look, Webcam, Cursor and Zoom groups read clearly, and the waveform, zoom bars and "Cut at the playhead" work like Screen Studio.
  - The camera move inspector, with "Look at", "Pull back to the whole design" and easing curves drawn as pictures, is excellent ([86](ui-audit/86-rec-zoom-selected.jpg)).
- **The Export popover** is compact, its sizes are cards you tick, and it has one clear primary button ([32](ui-audit/32-export.jpg), [89](ui-audit/89-rec-export.jpg)).
- **Copy style** is a clear dialog: checkboxes with a line each, and "Copy to 2 screens" ([92](ui-audit/92-copy-style.jpg)).
- **Backgrounds › Looks** shows real macOS wallpaper thumbnails in groups, two rows each, with "Show all" ([95](ui-audit/95-bg-looks.jpg)).
- **The Shapes panel** is a visual grid with a colour row above it ([60](ui-audit/S-7a.jpg) is the contact sheet).
- **The start screen's drop zone** is clear, and so is "Or use a screenshot you already have" ([01](ui-audit/01-boot.jpg)).
- **Ask AI's progress** works well: steps with ticks and timings, a running total and Stop ([100/101](ui-audit/101-ai-thread.jpg)).
- **The context menu** has the right items with their shortcuts ([57](ui-audit/57-context-menu.jpg)).
- **The native countdown, the saving and failed panels, and the compact capture bar** are tidy ([N](ui-audit/N-native.jpg)).
- **The dark theme is consistent:** radii, borders and spacing mostly agree everywhere.

---

## P0: bugs to fix first

**B1 · Dropdowns and popovers are see-through.**
- **Wrong:**
  - In the device dropdown, the "Black" label, the Size slider, "92%" and the tilt pad show through the list ([z-69](ui-audit/z-69-dropdown.jpg)).
  - The Export popovers show the inspector text behind them ([32](ui-audit/32-export.jpg), [98](ui-audit/98-export-set.jpg)).
- **Fix:** an opaque surface for every popover, dropdown and menu (the shared `Popover` in controls.js), with a real shadow.

**B2 · Escape doesn't close Help or Settings.**
- **Wrong:** tested; both stay open after Escape. Only × or a click outside closes them.
- **Fix:** Escape closes any modal. Keep focus inside an open modal and give it back when it closes.

**B3 · The timeline's hint runs through the Motion bar.**
- **Wrong:** "Move the playhead to when something should happen…" is drawn on top of the "Subtle" bar ([33](ui-audit/33-timeline.jpg)).
- **Fix:** show the hint only on empty rows, in the space under the rows, never under a bar.

**B4 · The Emphasis › Accent buttons overlap.**
- **Wrong:** None, Marker, Under, Wavy and Pill are squeezed into one row and read "NoneMarkeUnder Wavy Pill" ([09](ui-audit/09-headline-selected.jpg)).
- **Fix:** a dropdown, or small picture tiles in two rows.

**B5 · The start screen's buttons don't fit at the app's default window size.**
- **Wrong:** at 1360×880 in the Mac app, five buttons run under the inspector and "Try a sample" is cut off ([z-120](ui-audit/z-120-chips.jpg)).
- **Fix:** wrap them, or have fewer of them (see U1).

**B6 · Editing the headline on the canvas shows raw markup.**
- **Wrong:** double-clicking shows `**in a few words**` with the asterisks. The accent colour disappears and the text reflows to three lines ([10](ui-audit/10-headline-editing.jpg)).
- **Fix:** edit the text as it looks. Colouring words is a selection plus a colour button (see U4).

**B7 · The "Add them" buttons in Screenshots touch each other.**
- **Wrong:** In a device, No frame and Rounded run into each other ([20](ui-audit/20-left-screenshots.jpg)).
- **Fix:** equal-width segments with padding, or a dropdown.

**B8 · Recording designs have two "▶ Recording" labels.**
- **Wrong:** one sits on the webcam bubble inside the design, the other under it ([81](ui-audit/81-rec-editor.jpg)).
- **Fix:** at most one label, outside the image, and only on hover.

**B9 · Rail tooltips cover the panel they open.**
- **Wrong:** opening Screenshots, Templates, Backgrounds or Elements leaves the tooltip over the panel's title or first line ([20](ui-audit/20-left-screenshots.jpg), [21](ui-audit/21-left-templates.jpg), [22](ui-audit/22-left-backgrounds.jpg), [23](ui-audit/23-left-elements.jpg)).
- **Fix:** no tooltip while that item's panel is open. Rail tooltips should only add a short delay.

**B10 · The timeline breaks at small window sizes.**
- **Wrong:** at 1024 to 1280 wide, the header clips (zoom "1." cut off), the time wraps onto two lines, and the hint runs over the + buttons ([112](ui-audit/112-small-1024-timeline.jpg)).
- **Fix:** a responsive header that hides labels before controls, and a minimum row-label width.

**B11 · Labels get cut short.**
- **Where:**
  - zoom bars read "1.8…" and "Pull …" ([81](ui-audit/81-rec-editor.jpg))
  - the device dropdown reads "Match the screenshot i…" ([08](ui-audit/08-device-selected.jpg))
  - wallpaper names read "Meadow Mo…" and "Big Sur Gra…" ([95](ui-audit/95-bg-looks.jpg))
  - the panel after a recording reads "…in Screenshotter › reco…" ([N](ui-audit/N-native.jpg))
- **Fix:** bars show an icon and the value (e.g. a zoom icon and 1.8×); short labels ("Auto (iPhone 18 Pro)"); the full name on hover.

**B12 · New items land on top of the headline.**
- **Wrong:** a label from Elements and a heart sticker both land on the headline text ([z-130-132](ui-audit/z-130-132.jpg)).
- **Fix:** place new items in free space: the biggest empty area that isn't text or the device, otherwise beside the selection.

**B13 · Font says "Choose…" for a headline that clearly has a font.**
- **Wrong:** extra text shows "SF Pro" ([09](ui-audit/09-headline-selected.jpg) against [67](ui-audit/S-7b.jpg)).
- **Fix:** always show the font in use, e.g. "SF Pro (default)".

**B14 · Labels have inconsistent capitals.**
- **Wrong:**
  - Shadow is "none soft medium strong studio" in the device's More options, but "None Soft Medium Strong" for a recording ([70](ui-audit/70-device-more-options.jpg) against [81](ui-audit/81-rec-editor.jpg)).
  - The colour grades are lowercase too.
- **Fix:** Title Case for every option label.

---

## P1: flows and structure

### Getting started

**U1 · On the start screen, the whole inspector is open for a design that doesn't exist.**
- **Wrong:** Background, Image size, Screens and Motion all show before there's anything to change ([01](ui-audit/01-boot.jpg)). Export also looks available.
- **Fix:** hide the right panel, and disable Export and Ask AI, until there's a screenshot. The start screen then has room for the drop zone and three clear ways in (see Replit Design's and MagicPath's start screens on Mobbin: [Replit](https://mobbin.com/screens/3360baaf-e747-4aac-893a-d8328e32d855), [MagicPath](https://mobbin.com/screens/03bae368-e19d-4c95-b51e-cc418d58f341)).

**U2 · "Pick how it starts" is uneven and slow.**
- **Wrong:**
  - Previews are different sizes: Depth of field and Dissolve float small in tall cards.
  - One stays blank for seconds (Feature call-out).
  - The inspector stays open behind it, full of settings.
  - "Keep the first one ↵" is an odd main action ([03](ui-audit/03-after-pick-2s.jpg)).
- **Fix:** the same aspect ratio for every preview, with a skeleton while each draws. Hide the inspector. Make "Use Bold hero" the primary, named after the selected card.

**U3 · Placeholder words look like a real headline.**
- **Wrong:**
  - Every starting design says "Say what it does, in a few words" in full headline style ([07](ui-audit/07-editor-default.jpg)).
  - New screens in a set copy it ([90](ui-audit/90-set-view.jpg)).
  - It gets exported.
- **Fix:** either style it as a placeholder ("Click to write your headline", dimmed, not exported), or ask for the headline once when the first screenshot comes in. Add screen should start each new screen's headline empty.

**U4 · Colouring words means typing `**stars**`.**
- **Wrong:**
  - The Words field shows the markup.
  - The setting is called "Star colour".
  - A paragraph explains the syntax ([09](ui-audit/09-headline-selected.jpg)).
  - "Colour selected words" uses the AI sparkle icon, though it isn't AI.
- **Fix:** select words, then an "Accent colour" button (a palette icon). Store the markup without showing it. Rename "Star colour" to "Accent colour".

**U5 · A recording opens differently depending on where it comes from.**
- **Wrong:**
  - From the start screen, a recording goes into a MacBook frame with the placeholder headline, and the "Pick the still" sheet opens by itself ([42](ui-audit/42-recording-editor.jpg)).
  - From the capture bar, the same recording opens in the Screen Studio look: 5% padding, 3% corners and a shadow on a wallpaper ([81](ui-audit/81-rec-editor.jpg)).
- **Fix:** one default for recordings, the Screen Studio look, wherever they come from. That's the "pretty defaults" rule: recordings and screenshots open framed on a wallpaper.

**U6 · "Pick the still" offers frames 0.1 s apart that look the same.**
- **Wrong:** see [42](ui-audit/42-recording-editor.jpg).
- **Fix:** don't open it by itself. When it is opened, offer moments spread across the recording (scene changes) and a scrubber.

### The inspector and panels

**U7 · Every item has the Animation section, even in a still design.**
- **Wrong:** "Comes in / Keeps moving / Changes part way / Leaves", each with "None +", plus a footnote, is on the device, the headline, text, shapes and stickers ([08](ui-audit/08-device-selected.jpg), [S-7b](ui-audit/S-7b.jpg)).
- **Fix:** one collapsed "Animate" row that opens the timeline's + at the playhead. Show the four rows only once the item has an animation or the timeline is open. Subframe shows sections only when you add them ([Subframe](https://mobbin.com/screens/e6f9d7cf-8cb4-4451-9062-d96cca220434)).

**U8 · The same thing is edited in two places.**
- **Wrong:**
  - The headline's words are in Elements › Text and in the headline inspector ([23](ui-audit/23-left-elements.jpg) against [09](ui-audit/09-headline-selected.jpg)).
  - The background is in the Backgrounds panel, and also on the inspector's Background card with "Adjust the photo".
  - The Backgrounds panel even says "Its effects are in the settings on the right" ([22](ui-audit/22-left-backgrounds.jpg)).
- **Fix:** a single rule: **the left side adds and picks, the right side adjusts.**
  - Elements › Text only adds text.
  - Backgrounds picks a background; its adjustments live under Background on the right.

**U9 · Size controls are spread over four things.**
- **Wrong:**
  - Image size tiles, "All sizes: Every store slot…", "Also at: Add a size…" and Landscape ([07](ui-audit/07-editor-default.jpg)).
  - A 4K recording shows App Store sizes in its inspector ([83](ui-audit/S-8a.jpg)).
- **Fix:** one Size control (presets, with the current size shown as pixels) and "+ Another size" below it. For recordings, choose sizes in Export only.

**U10 · The Motion presets look identical.**
- **Wrong:** Still, Subtle, Float, Drift and Push in all use the same phone outline ([01](ui-audit/01-boot.jpg)).
- **Fix:** a different glyph for each, and a short looped preview on hover.

**U11 · The tilt pad is a riddle, and it appears twice.**
- **Wrong:**
  - A tiny phone in a box, with "tilt 0°" and "turn 0°" in small monospace ([08](ui-audit/08-device-selected.jpg)).
  - "3D ↕ 0° ↔ 0°" again under More options ([70](ui-audit/70-device-more-options.jpg)).
- **Fix:** label the pad "Drag to tilt" with a reset button, keep it in one place, and put the exact numbers under it.

**U12 · Selecting the webcam opens the device inspector.**
- **Wrong:**
  - The webcam gets frame styles (Device, Browser, Window…), the tilt pad and Animation ([84](ui-audit/84-rec-webcam-selected.jpg)).
  - Its real settings (shape, size, ring) are in the Recording inspector.
- **Fix:** a Webcam inspector with shape, size, ring, mirror and position, and no device frames.

**U13 · Helper paragraphs sit under almost every heading.**
- **Examples:**
  - "Click anything in the design to change it…" is always on the Whole image panel.
  - The Webcam, Sound and Footage sections each have a paragraph.
  - Every left panel opens with two or three lines of explanation ([87](ui-audit/87-rec-sound-selected.jpg), [S-8b](ui-audit/S-8b.jpg)).
- **Fix:** one line at most, or an (i) with a tooltip. Show first-run explanations once, then hide them.

**U14 · The rail changes on recordings.**
- **Wrong:** Screenshots and Templates disappear for a recording with no explanation, so a screenshot can't be added to it ([81](ui-audit/81-rec-editor.jpg)).
- **Fix:** keep the rail the same everywhere. Disable what doesn't apply, with a tooltip saying why.

**U15 · The Backgrounds panel has small problems.**
- **Wrong:**
  - "Transparent" at the top right is an action that looks like a label ([22](ui-audit/22-left-backgrounds.jpg)).
  - Without an Unsplash key, the Photos tab shows search and suggestions that can't work, with no message ([97](ui-audit/97-bg-photos.jpg)).
  - The disabled "Use this prompt" in AI image is olive and looks half on.
  - "Generated with openai" is lowercase ([56](ui-audit/56-bg-ai.jpg)).
  - Gradient stops have no bar to drag them on ([22](ui-audit/22-left-backgrounds.jpg)).
- **Fix:**
  - a "None (transparent)" tile in Colours
  - an empty state for Photos that explains the key, with a button that opens Settings › Photos
  - a neutral disabled style
  - "OpenAI"
  - a gradient bar with stops you can drag

**U16 · Templates counts disagree.**
- **Wrong:** the heading says "Templates 14" and the first group says "Whole sets 16" ([21](ui-audit/21-left-templates.jpg)).
- **Fix:** one count, or none.

**U17 · The timeline rows have the wrong icons.**
- **Wrong:** Recording and Webcam both use a phone icon ([81](ui-audit/81-rec-editor.jpg)).
- **Fix:** a screen icon and a camera icon.

**U18 · A still design has a footage filmstrip.**
- **Wrong:** in a design that doesn't move, the Footage row shows the screenshot repeated as frames ([33](ui-audit/33-timeline.jpg)).
- **Fix:** one block with the design's length.

### The canvas

**U19 · It's hard to see where the image ends.**
- **Wrong:**
  - A phone that runs off the bottom is drawn past the edge, only slightly dimmed, so the design looks cut off ([07](ui-audit/07-editor-default.jpg)).
  - In a set, the selected screen's device draws outside its screen while the others are clipped ([90](ui-audit/90-set-view.jpg)).
- **Fix:** dim everything outside the image to about 40%, outline the image's edge, and clip every screen in a set the same way.

### Ask AI

**U20 · The floating Ask AI panel covers the design.**
- **Wrong:** it sits over the design and the Timeline button ([31](ui-audit/31-ask-ai-typed.jpg)).
- **Fix:** open it docked in the right panel by default (docking already exists, ⇧⌘K), or use a prompt bar under the canvas that never covers the image (as [Recraft](https://mobbin.com/screens/70c830c9-3595-44cb-95dc-43d7c47e9b6c) does).

**U21 · Ask AI shows raw operations.**
- **Wrong:** results read "rotateY device-1 −12" and "background scene sunset" ([101](ui-audit/101-ai-thread.jpg)).
- **Fix:** plain summaries: "Tilted the iPhone 12°", "Background: Sunset".

**U22 · Naming is inconsistent.**
- **Wrong:** Settings calls Ask AI "AI Edit" ([26](ui-audit/26-settings.jpg)).
- **Fix:** "Ask AI" everywhere.

### Exporting and feedback

**U23 · One export shows three progress indicators.**
- **Wrong:** a pill in the top bar, a progress line under it and a floating card all show at once ([104](ui-audit/104-exporting.jpg)).
- **Fix:** keep the floating card, with its percent and time left. The Export button shows a spinner.

**U24 · Toasts cover the inspector.**
- **Wrong:** they stack at the bottom right over the settings ([103](ui-audit/103-toasts.jpg), [89](ui-audit/89-rec-export.jpg)).
- **Fix:** put them at the bottom centre of the canvas, or near the top right under the toolbar, and fold more than two into one.

**U25 · Exported files are named after the headline.**
- **Wrong:** "01 Say what it does, in a few words.png" ([98](ui-audit/98-export-set.jpg)).
- **Fix:** "01.png", or "<App name> 01.png".

**U26 · The store page preview treats the design name as the app.**
- **Wrong:** it shows "Untitled design" with a lime "U" icon ([93](ui-audit/93-store-page.jpg)).
- **Fix:** ask once for the app's name and icon (filled in from the app's bundle where possible) and keep them on the design.

### Pages and dialogs

**U27 · Settings is a long scroll of paragraphs.**
- **Wrong:**
  - Developer instructions appear: "start the Studio with `ANTHROPIC_API_KEY` set", and how to make an Unsplash developer app.
  - The full device list is in Settings ([26](ui-audit/26-settings.jpg), [124](ui-audit/124-native-settings-end.jpg)).
  - Shortcuts still lists "Edit / Preview ⌘1 / ⌘2", which 0.12 removed.
- **Fix:**
  - sections: General, Ask AI, Photos and AI images, Devices, Shortcuts
  - one line under each setting, with the details behind "Learn more"
  - shortcuts that match the current app

**U28 · My designs drops the rail, and has too many controls for a few designs.**
- **Wrong:**
  - "Back to design" moves to the top right.
  - Tabs, filter chips, sort and a view toggle all show with a single design ([24](ui-audit/24-my-designs.jpg)).
  - The heading is serif.
- **Fix:** keep the rail with My designs selected. Put back at the top left. Show filters and sort from about 8 designs on.

**U29 · Help numbers some steps and not others.**
- **Wrong:** "1 · Add a screenshot… 2 · Pick a look… 3 · Make it yours", then three unnumbered steps, then "4 · Export" ([25](ui-audit/25-help.jpg)).
- **Fix:** four numbered steps, then a short "Also" list.

**U30 · What's new is a wall of text.**
- **Wrong:** every paragraph of the release notes is in one modal ([94](ui-audit/94-whats-new.jpg)).
- **Fix:** three to five headline bullets with a picture each, and "See everything" linking to the site's changelog.

**U31 · The start screen's wording is vague.**
- **Wrong:** "Just words and doodles" doesn't say what it does ([01](ui-audit/01-boot.jpg)).
- **Fix:** "Start with text".

---

## P1: the visual system

**V1 · Too many accent colours.**
- **Now:**
  - lime for primary buttons and selected options
  - purple for selection boxes, focus rings and the dropdown highlight
  - a pink-to-purple gradient for Ask AI and sparkle icons
  - pink for the playhead
  - orange for camera bars
  - teal for motion bars
  - blue for the sound waveform
- **Fix:**
  - lime is the one accent: primary actions and the selected state
  - selection boxes and focus are white or a single neutral blue
  - timeline bars are muted, one tint per row type
  - Ask AI gets no gradient

**V2 · Two type voices.**
- **Wrong:** serif italic gradient headings ("Make your app look *incredible.*", "Pick how it *starts.*", "My designs") sit next to the sans interface ([01](ui-audit/01-boot.jpg), [03](ui-audit/03-after-pick-2s.jpg), [24](ui-audit/24-my-designs.jpg)).
- **Fix:** sans everywhere, with no gradient text. This matches the new website.

**V3 · More than one primary button on screen.**
- **Wrong:**
  - Export and Capture in the Screenshots panel are both lime ([20](ui-audit/20-left-screenshots.jpg)).
  - Ask AI's "Design it" is lime while Export is too.
- **Fix:** one lime button per view. Capture becomes the panel's primary only while the editor is empty.

**V4 · Disabled buttons look tinted, not disabled.**
- **Wrong:** a disabled Export is olive, and so is "Use this prompt" ([01](ui-audit/01-boot.jpg), [56](ui-audit/56-bg-ai.jpg)).
- **Fix:** a neutral grey for every disabled button.

**V5 · Monospace in odd places.**
- **Wrong:** hex values, timings and tilt labels are monospace, but so are some file paths, while other numbers aren't.
- **Fix:** monospace only for times and numbers that change while you watch them. Hex values go in the sans font.

**V6 · The top-right panel toggles are unclear.**
- **Wrong:** two similar icons with no labels.
- **Fix:** tooltips with their shortcuts, and a clearer pressed state.

---

## P1: native capture UI

Drawn with `--ui-snapshots` ([N](ui-audit/N-native.jpg)).

**N1 · The record button clashes.** It's a red dot on a lime button. In Record mode, use a red record button; keep lime for the screenshot shutter.

**N2 · The camera style panel looks like a different app.**
- **Wrong:** a square-cornered system-grey sheet with checkboxes and plain segmented controls, unlike every other HUD.
- **Fix:** the HUD style: dark, rounded, toggles, and the corner-position picture buttons made clearer.

**N3 · The after-capture panel shows internal names and only icons.**
- **Wrong:**
  - "in Screenshotter › raw" shows the folder name.
  - Copy, Save to…, Show in Finder and Delete are icons only.
  - The thumbnail is small inside a big grey area.
- **Fix:**
  - "in Screenshots"
  - labels (or tooltips) for Copy and Save
  - the thumbnail filling its area

**N4 · The recording pill puts Discard next to Stop.**
- **Wrong:** the trash button sits right beside Stop, so one slip loses the recording.
- **Fix:** move Discard into the ⋯ menu, or space it apart and ask before discarding.

**N5 · The capture bar's icons don't explain themselves.**
- **Wrong:** Save to and Open in Screenshotter are unclear icons. The icons name themselves on hover, but not at first glance.
- **Fix:** keep the icons, and add a short label to the two that aren't obvious (as ⌘⇧5 does with "Options").

---

## Not covered by this pass

- **The live Mac window:** its traffic lights and menus. The top bar's 84 px reserved for the traffic lights was checked by faking the native class.
- **The live camera bubble and its hover controls.**
- **The menu bar menu:** idle or recording.
- **The area and window pickers:** hover states.
- **System alerts:** permission alerts, and the update and About windows.
- **Accessibility:** keyboard focus order and VoiceOver.
- **Badges:** a badge couldn't be added through the Pictures panel in the test, so there's no finding about badges.

## Fix order for pass 2

1. **Bugs (B1–B14).** These are small, separate fixes. Check each in WebKit (`npm run test:ui`).
2. **The visual system (V1–V6).** This is one pass over styles.css: accent colours, type, primary and disabled buttons. It sets the look for everything after it.
3. **The inspector and panels (U7–U18).** Show sections only when they're needed, keep one place to edit each thing, use one size control, make accent words a selection, and give the webcam its own inspector.
4. **The flows (U1–U6, U19–U31).** The start screen and "Pick how it starts", the same recording default everywhere, Ask AI docked, one export progress, toasts, Settings, My designs, Help and What's new.
5. **The native UI (N1–N5).** Use `--ui-snapshots` for before and after.

Every step gets before and after screenshots from the same setup. The capture scripts are in [`ui-audit/scripts/`](ui-audit/scripts/):
- `shoot.mjs` drives a separate Studio in WebKit. Start it on port 4790 with all four `SCREENSHOTTER_*` file variables pointing at a scratch folder.
- The `flow*.mjs` files open each state through `/ui/store.js`, `/ui/actions.js` and `window.studio.command`.
- `sheet.py` makes 2×2 contact sheets.

Their output folders and library paths are hard-coded to this audit's scratch folder, so change them before you run them.
