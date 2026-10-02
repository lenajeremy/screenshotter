# What's new

## Unreleased

### Highlights
- **A set is one canvas.** Drag a device onto the gap between two screens and it's pulled to sit exactly across both: the seam lights up and says "Across 2 & 3", either way along the set. Drag it mostly onto the screen beside it and it moves there. No settings needed (hold ⌥ to place it freely); a device's **More options › Keep inside this screen** cuts it off at its own screen's edges instead.

## 0.11.4 · 2 October 2026

### Fixes
- The Templates panel's previews show in seconds with a new screenshot: they're drawn a few at a time, in the panel's order, instead of all sixteen sets at once (which showed nothing for about a minute, and could break some).

## 0.11.3 · 2 October 2026

### Fixes
- Dragging stickers, illustrations and your pictures onto the design works in the app again: the Mac app's web view could take the drag as a system image drag, so nothing landed.
- Deleting a picture never breaks a design any more: one a design uses (saved, or the one open) only leaves Your pictures, and its file stays so the design keeps it. Only pictures nothing uses are deleted.
- Applying a whole-set template keeps a size you chose yourself (square, 4:5…), as before 0.11.0. Only a store size of another shape (iPad screenshots on an iPhone canvas, say) takes the template's.
- Built-in stickers and illustrations no longer show as broken for a moment while a screen is laid out again.
- The list of your designs can no longer fail to load while a thumbnail is being drawn.

## 0.11.2 · 2 October 2026

### Highlights
- **Screens without a screenshot.** A screen can be just words, stickers and illustrations: it previews, exports as an image or video, and goes in a set like any other. **Just words and doodles** on the start screen begins one; a screen without a screenshot shows a small **Add a screenshot** button instead of asking for one.
- **Delete pictures you added.** In Images › Your pictures, hover a picture and click its ×, right-click it, or select it and press Delete. If a design uses it you're told which; **Undo** brings it back.

## 0.11.1 · 2 October 2026

### Highlights
- **Your app icon on the store page.** In **Preview the store page**, click the icon (or drop a picture on it) to use your app's own: one of your pictures, or a file. It's kept with the design, so each app keeps its own. Until you choose one, an app icon already on the design is used, else the app's initial.

### Fixes
- The Illustrations in the Images panel fit the panel again: wide ones no longer push the grid past its edge or over Badges.

## 0.11.0 · 2 October 2026

### Highlights
- **Squiggly underlines.** Accent words can now have a wavy, hand-drawn underline: Text › Accent › **Wavy**, next to Under. It follows the words onto every line, takes the mark colour, and draws in from the left in Animate. Scrapbook uses it.
- **Ten more whole sets.** Scrapbook (washi tape, handwriting, doodles), Memphis pop, Doodle notebook (squared paper and a marker), Garden (soft shapes and leafy sprigs), Confetti party (for a launch), Comic pop (halftone, outlined lettering, speech bubbles), Night sky (stars, a moon, a planet and a rocket), and three made for one kind of device: Desktop showcase for Mac apps, iPad spread, and iPhone Duo showcase (the open Duo held wide and upright, side by side).
- **Every set suits every device.** Whole sets now fit iPhone, iPad, iPhone Duo (upright, or held open like a book) and Mac screenshots: each takes the App Store canvas for your first screenshot and places the devices to suit, and the sets made for your kind of device come first.
- **Illustrations.** 31 drawings in Images › Illustrations to put behind or around your screens: blobs, squiggles, arrows, scribbles, stars, sparkles, washi tape, leaves, a moon, a planet, confetti and more. Most are line drawings that take your app's colour.
- **Colour any picture.** Images › Colour repaints an illustration, sticker or logo in one colour (and animates like the rest).

### Fixes
- Sets no longer flicker while their screens load or when you move between them, and a set whose screens were different sizes keeps them at one size.
- Applying a whole set for another shape of device (an iPad or Mac set on an iPhone design) takes that set's own canvas instead of squeezing it into the old one.
- Set previews in the Templates panel are the shape of their screens.

## 0.10.0 · 2 October 2026

### Highlights
- **Whole sets in one click.** Templates › **Whole sets** makes five screens in one look (a hero, three features and a close) from your screenshots in order and your words, previewed with your own screens: Clean and bright, Bold colour (one backdrop across the set and a phone that runs from screen to screen), Dark premium, Playful (stickers and a NEW burst), Clay studio and In the gallery. Undo goes back.
- **Your own templates.** **Save this design as a template…** keeps every screen's look (backdrops, layout, type, devices, badges, stickers and your logos) with its screenshots as slots, and its words as placeholders unless you keep them. Click it under **Your templates** to use it with any app's screenshots.
- **Share templates.** Each of your templates exports as one `.screenshotter-template` file with its pictures and photos inside; **Import a template…** adds one someone sent you.

### Agents
- `apply_set_template` makes a whole set from a built-in template or one the person saved, from screenshots and words, and shows it as a contact sheet; `list_templates` lists them.

## 0.9.0 · 2 October 2026

### Highlights
- **Updates, built in.** Screenshotter now checks for a new version once a day and offers it with its notes: one click downloads it, installs it and relaunches. **Screenshotter › Check for Updates…** looks right away. Every update is signed by us and notarized by Apple, and is checked before it installs. This version is the last you need to download by hand.
- **Drag in stickers, badges and awards.** Everything in the Images panel drags onto the design and lands where you let go (a click still adds it in its usual place).

## 0.8.0 · 2 October 2026

### Highlights
- **Stickers.** 24 ready-made stickers in the Images panel (a heart, stars, sparkles, a bolt, a flame, a crown, a trophy, a rocket, a check, a sun, a rainbow…), Screenshotter's own, with a die-cut white edge and a little tilt.
- **Badges with your words.** A "NEW" starburst, a "FREE" price tag, a "Try it free" ribbon and a speech bubble: shapes that hold your own words, fitted on one line or two, recoloured and animated like the rest. In Images › Badges, and Shapes › Badges and awards.
- **Ready-made awards and ratings.** App of the Day, Editors' Choice, #1 in a category, Featured, "Loved by" and five stars, in Images › Awards and ratings: placeholders for ones your app has really had.
- **Pictures go on looking right.** Images › Add as › **Auto** guesses what a picture is: a wide cut-out becomes a logo at the top, an opaque square an app icon, another cut-out a sticker, a photo a rounded card with a shadow.
- **SVGs everywhere.** SVG (and GIF) pictures come in however you add them: the Images panel, a drop anywhere, paste, Import… or opening one with Screenshotter from Finder. They always become image blocks, never screenshots.

### Fixes
- The code names in What's New show as code again.
- A badge's bar offers its colour and its words' colour, not a stroke.

## 0.7.0 · 2 October 2026

### Highlights
- **Clay.** Any installed device in one matte colour: Apple's own art recoloured (Porcelain, Sand, Sage, Sky, Slate, Ink or any colour), keeping its light and shade, with the screen and Dynamic Island untouched. Device › Style › Clay.
- **Image blocks.** Put logos, your app icon, stickers or any picture on a screen, from the new Images panel: drop them on the design, then move, size, turn and layer them. Round their corners, give them Apple's app-icon outline or a circle, a soft shadow, a sticker's die-cut white edge, soft focus or opacity. Every picture you add stays in the panel to use again.
- **Laurels and ratings.** An award wreath round your words, and a row of stars filled to your rating with a line under it, under Shapes › Awards and ratings. They recolour and animate like any shape.
- **Text emphasis.** Mark the **accent** words with a highlighter, an underline or a pill; underline, strike through or highlight a whole text; outline the letters; set the line height; and give a text's pill its own padding and corners. Under Emphasis in the text's panel.
- **Review and award templates.** A five-star review over your screen, and a laurel with stars above your headline, made from your screenshot and colours.
- **Export one screen's video.** Export › Video in a set exports all its screens, the one you're on, or the ones you pick, joined into one video or one video each.
- **It all animates.** Images move, scale, turn, fade and blur in videos; marks draw themselves in; a rating's stars fill up; a clay device can change colour part way.

### Devices
- **Screen only** (the card frame) has the device's own screen corners whenever the screenshot's device is known, in the render and on the canvas.

### Agents
- `clay` on a device; `images` on a scene; shapes of type `laurel` and `rating` (`text`, `caption`, `value`); text `accentMark`, `decoration`, `stroke`, `lineHeight`, `padding` and `radius`; animation values `mark` and `value`, and `color` for a clay device. `list_mockup_options` lists the clay tones; the design guide says when to use each (and to claim only real awards and ratings).
- `apply_recipe` has `review` and `award`. Sequences take a `name` for their file.

## 0.6.0 · 1 October 2026

### Highlights
- **Sets.** A design can be a whole App Store set: its screens sit side by side in Edit, numbered and named ("01 · Introduction"). Click one to edit it, drag one to put it elsewhere, double-click a name to rename it, and drop a screenshot on any of them. The same screens, in order, are the shots of its preview video in Animate.
- **Every size, in one design.** Every App Store slot (iPhone, iPad, Mac, Apple Watch, Apple TV, Vision Pro) and Google Play size is a preset. A switcher above the set holds the design's sizes: **+** makes every screen again at another size, an iPad set from the iPhone one, its devices swapped to iPads.
- **One picture across the set.** Lay one backdrop across every screen, each showing its slice (Backdrop › Across all screens), and drag a device past a screen's edge to carry it on into the next, so swiping through the screenshots on the App Store reads as one picture.
- **Copy style.** Copy one screen's backdrop, text style, film look, device look or device placement onto the others, at its size or every size.
- **Export the whole set.** Every screen of every size at full size, numbered in store order, with a contact sheet per size, in a folder per size or ready for fastlane. **Preview the store page** shows each size's screenshots in a row, the way the App Store does.
- **Apple's own devices.** Devices are Apple's product renders: the list shows the models whose art you've installed, in the finishes Apple drew. An Apple Watch can wear any band Apple shows it with (Sport Band, Sport Loop, Milanese Loop, Alpine Loop, Trail Loop, Ocean Band…).
- **Tilt you can see.** Edit shows a device's 3D tilt as it will render, and a tilted Apple Watch has a solid case with its band as a strap.
- **Ask AI with Codex.** Ask AI can use Codex as well as Claude Code.

### Sets
- An **Add screen** tile ends the row, and a single design offers **Add a screen** under it. Right-click a screen to rename, duplicate, move, copy its style, leave it out of the video or delete it.
- Zoom to the whole set (⇧⌘0) or the screen you're on (⌘0); with nothing selected, ← and → step between screens.
- In Preview, ← and → (or the arrows and dots) step through the set's screens, each previewed; the ones either side are made ready, so it's instant. **Whole set** shows every screen side by side, as the store shows them; click one to see it alone.
- The Edit row and the previews leave the App Store's gap between screenshots (about 4% of a screen's width), so the set looks as the store shows it. A device or backdrop across the set picks up exactly where the screen before ends, so none of it is hidden in the gap.
- Undo (⌘Z) goes back through the whole design, whichever screen a change was made on: copying a style, adding a size, moving or deleting a screen are steps like any other.
- The image size is the set's: choosing one, landscape or a custom width changes every screen.
- A screen can be left out of the video: it stays one of the screenshots, marked **No video**, and the screens either side join.
- A screen can be without a screenshot for a while (or be text alone): removing its last one no longer hides the set behind the start screen.
- Deleting a screenshot file from the library takes it off every screen and size that shows it, and says how many first.
- My designs shows a set as its first screens side by side, with how many screens and sizes it has.

### Devices
- Only Apple's art is used: a model you haven't installed is shown as an installed one of its family whose screen fits, else as its bare screen, and the device panel offers **Get Apple's device art…** when there's none.
- The watches are named by generation: Apple Watch Ultra 3 and Apple Watch Series 11 46mm and 42mm. Designs saved with their old names still open on them.
- Apple's Apple Watch Ultra 3 art now installs (its images were all skipped), and iPad Pro and iPad Air art is filed under the right models (it was taken for the plain iPad).
- Choosing a size swaps devices to an installed model of the size's kind.

### Agents
- `get_scene` and `save_scene` carry a set's screens, their names, every size and which screens are in the video; saving just the first screen keeps the others.
- `export_scene_set` exports a saved set: every screen of every size, by size or for fastlane, with its contact sheets.
- `list_mockup_options` lists the devices with Apple's art installed, with their finishes and Apple Watch bands; `band` picks one.

### Fixes
- Scrolling the size menu over the canvas scrolls the menu.
- Searchable menus put the cursor in their search box.
- The Screenshots panel's cards and the design switcher's columns line up again.

## 0.5.0 · 30 September 2026

### Highlights
- **Animate.** A new mode beside Edit and Preview, for videos: set when and how each thing appears, changes and leaves. The headline slides up, a second later the laptop and phone zoom in together, then an arrow draws itself. A timeline under the canvas has a row for each item and a bar for each animation; press Play, or drag the playhead, and the canvas shows it.
- **Anything can move.** Devices, the headline, extra text and shapes can fade, zoom, stretch in across or up, and slide in from any side, then change part way through: size, position, rotation, opacity, a device's 3D tilt and turn, a text's colour, a shape's fill, stroke and thickness, and an arrow's two ends and its curve.
- **A camera.** Camera is a row in the timeline: push in on the MacBook, glide to a detail on the phone, pull back. Drag a frame on the canvas to say what it should show, and a corner to zoom. It moves the whole picture, text included.
- **Text a word at a time.** A headline or label can arrive by word or by letter, with any of the entrances, a gap you choose between each.
- **Several things as one.** ⌘-click rows in the timeline to animate them together: a zoom or a turn is about their shared middle, so a laptop and phone arrive as one group. Or start them one by one.
- **Videos of several shots.** Put designs one after another, each with its own animations and length, joined by a cut, a crossfade, a push, a wipe, an iris or a zoom. The shot strip on the timeline works like pages in Canva.
- **Made for where it's going.** Export the video at the App Store's preview sizes for iPhone, iPad and Mac, following Apple's rules, and at 9:16, 4:5, 1:1 and 16:9, all at once. Each design fits whole into another shape, fills it, or is laid out again.
- **Loops and curves.** Things can keep moving for the whole video (float, pulse, sway, spin, orbit, figure-8, blink) or travel along a curve you draw, turning to face the way they go. Any change can repeat, or go back and forth.
- **The backdrop moves.** A slow push into a photo, a drift, breathing, a colour shift, a turn, or coming into focus, behind everything else.
- **Blur anything.** Text, the headline, shapes and devices can be soft, animate their blur, and come into focus as they arrive, even a word at a time.
- **Call-outs on cue, and rack focus.** Each lift, loupe or outline has its own row under its device: it appears and leaves when you say. A device's soft focus animates too, so focus can shift from the laptop to the phone.
- **Pick the still of a recording.** When you add a screen recording, choose which moment its device shows in images, from up to eight moments where the picture changes.

### Animate
- Camera moves chain: a second move glides from the first point to the next, and "Pull back to the whole design" ends it. Look at aims it at an item.
- By word or By letter, beside an entrance or exit for text. Punctuation stays with its word, and words never break across lines mid-reveal.
- Call-outs have rows of their own under their device. Appear or Disappear, when, how fast: a lift rises off the screen, a loupe grows, an outline fades in. Ones you don't time appear together, as before. ⌘-click several to bring them in one by one.
- Play through the whole video in Animate: with several shots, the strip becomes the video's timeline (each shot a filmstrip as long as it runs, transitions on the joins, one playhead), and the canvas plays every shot and draws each transition live, no export needed. Click the shot on screen to edit it.
- Shots: a strip at the top of the timeline. Add a shot (a copy of this one, or one of your designs), click one to edit it, right-click to move or remove it. The chip between two shots picks how the next comes in and how long that takes. Each shot's length is on the timeline. See all shots puts every shot's key moments on one sheet without rendering.
- Export › Video › Sizes: tick as many as you need. App Store previews are held to at least 15 seconds and warned past 30, at 30 fps, H.264, with the silent stereo track App Store Connect expects.
- For AI agents: create_sequence (shots, transitions, a size) and preview_sequence; `versions` on create_video and create_sequence make other sizes; `size: "app-store-iphone"` and friends follow Apple's rules.
- Loop, beside Enter, Change and Exit: pick Float, Pulse, Sway, Spin, Orbit, Figure-8, Blink or Your own curve. Its bar runs to the end of the video, marked at each play.
- Plays and Each time, on any Change: once, 2×, 3× or forever; start over or back and forth.
- Route, on a Change: Straight or Along a curve. Drag the numbered points on the canvas, add or remove them, bring it back round to the start, or have it face the way it's going.
- Backdrop, a row under Camera: Slow push, Drift, Breathe, Colour shift, Turn and Come into focus, then push in, aim, turn, shift the colour and blur it yourself.
- Blur, as an entrance or exit (with how soft it starts), in any Change, and in More options for text, the headline and shapes.
- Focus blur, in a device's Change: blur one device and sharpen another at the same moment to rack focus between them.
- Drag the grip on the timeline's top edge to make it taller or shorter; double-click it for the usual height.
- Seven easings, each shown as its curve: slow down, speed up, smooth, steady, overshoot, spring and bounce.
- Drag a bar to change when it happens; drag its right edge to change how long it takes.
- With a Change selected, the canvas shows its items as they end up: drag, resize or turn them, or pull an arrow's ends and middle, to set what the animation changes them to. The design itself stays as it is.
- Play this animation plays just the one you're editing. Space plays and pauses, ⌫ deletes the selected animation, ⌘3 opens Animate.
- Export video, on the timeline, renders it. The video runs as long as the animations need.
- Ask AI can write the timeline: "the headline first, then the phone slides in, then draw the arrow at 3 seconds".
- Ask AI watches the video. For an animated design it sees a contact sheet of the video's key moments (the start, the end of each animation, the middle of long ones, the settled end), and it can ask to see any moment it wants, to the millisecond, before it answers. It checks its own timeline the same way before you see it.
- For AI agents: `targets: "camera"` with `to: { zoom, x, y }`, `by: "word"` or `"letter"` on text, `"device-1/callout-2"` to time a call-out, `to: { blur }` on anything (and `blur` on texts, shapes and textStyle), `enter: "blur"`, `path` (loops and routes), `repeat` and `yoyo`, and `"backdrop"` as a target with zoom, x, y, rotate, blur and hue.
- For AI agents: preview_video shows the video at its key moments, at exact times or every second, in about a second without rendering it. create_video's filmstrip shows the key moments of an animated design.
- For AI agents: a scene's `animations` work in create_video, and travel with get_scene and save_scene. The design guide covers pacing.

### Ask AI
- Knows every shot of a video. Ask about or change any of them ("make shot 1's headline white", "copy this shot to the end with a push", "how many shots are there?"). It can add, copy, remove and reorder shots, carry something from one shot to another, and set lengths and transitions. The canvas shows the shot it changed, the strip highlights the ones it touched, and each change says which shot it was in.
- Revert puts back exactly what that reply changed, even from another shot. (Before, it could overwrite the shot on the canvas.)
- For AI agents: get_scene returns a video's shots, and save_scene can save them.
- Expand it into the right-hand panel (⇧⌘K, or the arrows in its header) for a roomier chat beside the canvas; shrink it back to a floating panel the same way. It remembers which you prefer.
- Quicker answers. It renders your design only when the request is about how it looks; a question or an exact edit ("make the headline blue") goes straight to Claude, which can still ask to see the design if it needs to. It checks its own render only when it can't tell from the settings how a change will look.

### Recordings
- Pick the still. It used to be the first frame, which is often blank. The app finds the moments where the picture changes and leaves out ones that look the same. Change it any time with Still, above the device or in its settings. Videos still play the whole recording.

### Workspace
- A tidier rail: each place is an icon in a pill with a one-word label, and the pill shows where you are. Text and Shapes are now two places, so shapes are one click away. My designs has its own icon.

## 0.4.0 · 30 September 2026

### Highlights
- **Easier from the first click.** A new design opens on one job: drop a screenshot. Or grab one from the iOS Simulator or a website, or try it with a sample.
- **Your first design in four steps.** Pick a starting design (six templates, each made from your screenshot), write your headline, export. A strip across the top shows where you are, and Skip hides it.
- **A calmer workspace.** The side panels start closed, so the design fills the window. The rail has five places: Screenshots, Templates, Backdrop, Text & shapes, and My designs.
- **The everyday edits, right on the design.** The bar above a selection now has Edit for text, Replace for a screenshot, and colour dots for text, fill and stroke. Duplicate and layer order are under ⋯.
- **Ask AI is faster, shows its work, and you can stop it.** It only makes a new AI image when you ask for one or nothing built in will do, and new images are about 2.5 times quicker. Every step is named and timed, Stop works at any step, and Use it now takes Claude's change without waiting for its check.

### Ask AI
- Faster. It makes a new AI image only when you ask for one, or when none of the looks, paintings, photos, gradients or colours can do what you asked, and it says why while the image is being made. "Make it better" or "a new backdrop" now uses a built-in backdrop, so it's done in seconds.
- New AI images are about 2.5 times quicker: Settings › AI backgrounds › New images is Fast by default (about half a minute with OpenAI, against a minute and a half at Best). Images you already have are kept either way.
- Reading your screenshots now happens while your design renders, not after.
- You can see what it's doing. Each step is named and timed as it happens: rendering your design, reading it, Claude designing the change, an image generator making a new AI backdrop, and Claude checking the render. Making an AI backdrop is the slow part (usually a minute or two), and now it says so.
- Stop at any step. Stop (or the send button, which turns into Stop while Claude works) ends it straight away and leaves your design as it was.
- Use it now: once Claude has made its change, put it on the canvas without waiting for it to check its own render. A backdrop image that's still being made appears on the canvas when it's ready.
- "Worked for…" under each reply lists every step with how long it took.
- AI backdrops now show on the canvas, not only in Preview.
- The same AI backdrop is never generated twice at once (for example by the check render and the canvas).
- Design it for me has a Stop button too, and says when it's making AI backdrops.

### Simpler settings
- Each panel shows the few settings you'll use most. The rest are under More options, which remembers whether you opened it.
- The button under the design shows the image size and opens its settings, including App Store sizes.
- Layers are now "In this design" in the image settings; everything you export is on the My designs page.
- Plainer words throughout: scenes are designs, the caption is the headline, and the JSON view is in Settings › For developers (⌥⌘J).

### Templates
- Designs are now called Templates. "Just rearrange" keeps your look and only moves the devices.
- The gallery and risograph templates now keep your headline.
- The first design is quicker: the Studio gets ready while you pick a screenshot.
- Fixed: picking a second template while the first was still loading could put the first one back.

### My designs
- The Scenes page is now My designs, with two shelves: your designs and what you've exported.

## 0.3.0 · 30 September 2026

### Highlights
- **Scenes, full window.** Every design you've made on one page, like a file browser: large previews grouped by when you last worked on them, or a list with devices, size and dates. Filter by iPhone, iPad, Mac, Watch or web, sort, and search by name, headline or device. Open it from the top of the left rail or with ⇧⌘O.
- **Designs.** A new tab of complete, proven designs made from your screen and its colours: bold hero, art director, in the gallery, risograph print, 3D tilt, depth of field, rising pair, staircase, mosaic, feature call-out, how-to and dissolve. One click, then make it yours.
- **Design it for me.** Claude makes three different designs from your screens, renders each, and you pick one.
- **Shapes.** Arrows, lines, circles, boxes, triangles, stars and number badges you can drop anywhere, each with its own fill and stroke. Drag to move, pull a corner or a side to resize, turn the handle to rotate; arrows have an end to drag at each tip and a handle to curve them. Clean, or hand-drawn like a marker.

### Scenes
- Rename right on the card, duplicate (⌘D) or delete (⌫); arrow keys move between scenes and Return opens one.
- Start from the Scenes page: a blank scene, your latest screen framed in a finished design, or three designs by Claude. Drop images on the page to start a new scene with them.
- The scene you have open is marked, and opening or renaming a scene no longer counts as editing it, so the order stays put.
- Sharper previews.

### Shapes
- The new Shapes tab: pick a colour, then drag a shape onto the design and drop it where you want it. It follows your pointer at its real size. Or click to add it in the middle.
- Optional: snap a mark to text on the screen. Pick the words and the mark lands on them and follows the device when it moves.
- Fill, stroke colour and width, dashed or dotted lines, corner radius, star points, opacity and a soft shadow, all in the right-hand panel.
- Ask AI can add and restyle shapes ("circle the price and point an arrow at it from the headline"), and so can agents through the MCP server.

### Workspace
- Focus mode (⌘\\, or the button in the canvas's top-right corner) hides both side panels so the design fills the window. Bring back just the left panel or just the inspector with the buttons in the canvas corners.
- Drag the edge of either side panel to make it wider or narrower; double-click the edge for the usual width. Your layout is remembered.
- Fixed: the Fade options on a device no longer run into each other.

### Designs
- A new scene's first screenshot starts from the bold hero design instead of a plain layout.
- For AI agents: apply_recipe builds any of these designs through the MCP server.

### For AI agents
- Agents can work on your Studio scenes: list_scenes and get_scene open them, and save_scene puts a design into your Scenes with every device, text and shape still editable by hand.
- An agent's save is a new scene unless you asked it to change one. If it changes the scene you have open, its version appears on your canvas with an Undo.
- Shapes work in every tool, including each screen of a set.

## 0.2.0 · 30 September 2026

### Highlights
- **Ask AI designs like an art director.** It works from a detailed design guide, sees your screenshot's colours and text, checks its own render and fixes what's off before you see it. Ask for "make it look amazing" and you get a real redesign.
- **House style.** Tell Ask AI what you like ("always Space Black phones") and it remembers. See and edit it in Settings › House style.
- **Print & paint backdrops.** Reprint or repaint any backdrop as a risograph, newsprint, halftone, one-bit dither, oil painting, watercolour or ink wash, or set it behind fluted glass. Your screenshots are never touched.
- **Paintings as backdrops.** 15 public-domain paintings and prints, including Hokusai's Great Wave, Monet's footbridge and Van Gogh's wheat field.

### Devices
- A rebuilt Apple Watch, true to Apple's product photos: the Digital Crown, the Ultra's orange Action button and crown guard, and band stubs, sized so the whole watch fits.
- iPhone Duo, folded and open.
- Get from Apple now includes iPhone Duo, Apple Watch Series 11 and Ultra 3, iPad Air, iPad mini and iPad. Sets you already have are marked Installed and never downloaded twice.
- Flat Apple Watches use Apple's own product art; tilted in 3D, MacBooks and watches use the drawn frame with real depth.
- The colour picker separates Apple finishes (photographic, when Apple's art is installed) from drawn colours.
- Blur a device to put it out of focus behind a sharp one, or fade it into the backdrop.

### Call-outs and mark-ups
- Numbered step markers and curved arrows for how-to images.
- Highlighter swipes, and blur for anything private.
- Lifted cards can break past both sides of the device.
- The loupe can sit beside the device and still magnify its target.

### Layouts and type
- New layouts: grid (a mosaic of screens), staircase and rising pairs.
- Any Google Font, a second font for the subheadline, and accent words with their own colour, font, weight or italic.
- Eight new soft backdrops: cream grain, peach glow, lavender mist, mint to sage, iridescent, coral and periwinkle, indigo fade and ember glow.

### Mac
- MacBook screens draw the real macOS menu bar with the app's name and menus.
- Menu bar app shots: a drawn menu bar with your app's status item, and its menu hanging below.

### Video
- Zooms that follow the action: several zooms in a row, gliding from one point to the next.
- A drawn cursor that moves, clicks and drags over the screen.

### Library
- Exports of the same scene stack into one card with their versions. View any version, or restore it as the working design.

### For AI agents
- New tools: crop_image, create_grid, design_guide, get_house_style, remember_style, record_web (a rehearsed click-through of a web page, with its cursor track) and record_mac.
- A camera zoom for close-ups, and a Claude Code skill and plugin with a design check after the first render.

## 0.1.0 · September 2026

### The first release
- Capture iPhone, iPad and Apple Watch apps from the Simulator, websites and Mac windows.
- Frame them in realistic iPhone, iPad, Apple Watch and MacBook frames, or Apple's own product art.
- Backdrops, captions, call-outs, 3D tilt, video with motion, App Store sets and the Studio desktop app with Ask AI.
