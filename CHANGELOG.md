# What's new

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
