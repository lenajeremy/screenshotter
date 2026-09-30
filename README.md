# Screenshotter

Screenshotter is an MCP server plus a desktop app (the Studio) that captures real app screens and turns them into marketing-ready images and videos. It supports:

- **Captures:** the iOS Simulator (iPhone, iPad, Apple Watch), web pages (real Mobile Safari or desktop Chrome), and Mac app windows.
- **Device frames:** iPhone (through iPhone 18 Pro, in its Black, Silver, Glacier and Burgundy finishes), iPad, Apple Watch, and MacBook in any finish, plus browser, window, and card frames. iPhones can show their back (camera housing, lenses, logo) as well as their screen. Frames tilt in 3D with real depth: shaded metal edges, buttons and Camera Control, and a MacBook's keyboard deck. With Apple's product bezels installed (see [Device art](#device-art)), frames use Apple's own renders.
- **Backgrounds:** named looks, gradients, any photo, Unsplash, or AI-generated images, with photo treatments such as motion blur, haze, bloom, and grain.
- **Highlights:** lift a row, magnify with a loupe, outline, or spotlight. Target them by the text on screen.
- **Captions:** headline and subheadline with accent words.
- **Output:** App Store sets, social sizes, and animated videos (MP4, MOV, WebM, GIF).

Agents such as Claude Code or Codex drive it through MCP tools. You can drive the same engine by hand in the **Studio**.

## Install

### Requirements

| Needed for | Requirement |
| --- | --- |
| MCP server and Studio | macOS, Node.js 20 or later |
| Desktop app | macOS 14+, and Xcode or its command line tools to build it |
| Ask AI (optional) | Claude Code signed in (run `claude` once), or an Anthropic API key |
| Simulator captures | Xcode with at least one iOS simulator runtime |
| Rendering | Google Chrome, or another Chromium browser (set `SCREENSHOTTER_CHROME_PATH`) |
| Videos | `ffmpeg` (`brew install ffmpeg`) |
| AI backgrounds (optional) | `OPENAI_API_KEY`, `GEMINI_API_KEY`, `REPLICATE_API_TOKEN` or `FAL_KEY` |
| Mac window captures (optional) | Screen Recording permission for the app that runs the server |

### 1. Build it

```bash
git clone <this repo> screenshotter && cd screenshotter
npm install
npm run build
```

### 2. Find the two paths you'll need

Every client below launches the server as `node <path to dist/index.js>`. Use absolute paths so it works no matter which folder the client starts in:

```bash
which node                       # e.g. /Users/you/.nvm/versions/node/v24.11.1/bin/node
echo "$(pwd)/dist/index.js"      # run inside the screenshotter folder
```

In the steps below, replace `NODE` and `SERVER` with those two values.

Captures and renders are saved to a `screenshots` folder inside whichever project the agent is working in. To keep them in one place instead, set `SCREENSHOTTER_OUTPUT_DIR` (shown in each example below).

### 3a. Claude Code

```bash
claude mcp add screenshotter --scope user -- NODE SERVER
```

- `--scope user` makes it available in every project; leave it out to add it to the current project only.
- Add environment variables with `-e`, before the `--`:
  ```bash
  claude mcp add screenshotter --scope user -e SCREENSHOTTER_OUTPUT_DIR=~/Pictures/Screenshotter -- NODE SERVER
  ```
- Check it: run `claude mcp list` in a terminal, or `/mcp` inside Claude Code. It should show `screenshotter … ✔ Connected`.
- Remove it: `claude mcp remove screenshotter --scope user`.

### 3b. Codex

```bash
codex mcp add screenshotter -- NODE SERVER
```

Then open `~/.codex/config.toml` and give it more time, because videos and a simulator's first boot can take longer than Codex's default tool timeout. The finished entry looks like this:

```toml
[mcp_servers.screenshotter]
command = "NODE"
args = ["SERVER"]
startup_timeout_sec = 30
tool_timeout_sec = 600

[mcp_servers.screenshotter.env]
SCREENSHOTTER_OUTPUT_DIR = "/Users/you/Pictures/Screenshotter"   # optional
```

Check it with `codex mcp list`, or `/mcp` inside Codex. Remove it with `codex mcp remove screenshotter`.

### 3c. OpenCode

Run `opencode mcp add` and follow the prompts (choose a **local** server with the command `NODE SERVER`), or add it by hand to `~/.config/opencode/opencode.json`, inside the existing `"mcp"` object:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "screenshotter": {
      "type": "local",
      "command": ["NODE", "SERVER"],
      "enabled": true,
      "environment": {
        "SCREENSHOTTER_OUTPUT_DIR": "/Users/you/Pictures/Screenshotter"
      }
    }
  }
}
```

Keep any servers that are already in that file. Check it with `opencode mcp list`. To turn it off without deleting it, set `"enabled": false`.

### Try it

Restart the client, then ask something like *"List my simulators and take a screenshot of Settings on the iPhone 17 Pro, then make an App Store mockup of it with the clouds look."* The first capture can take a little longer while the simulator boots.

### Other MCP clients

Any client that runs stdio servers works. For example, in Claude Desktop or Cursor:

```json
{
  "mcpServers": {
    "screenshotter": { "command": "node", "args": ["/absolute/path/to/screenshotter/dist/index.js"] }
  }
}
```

## Use it yourself: the Studio

The Studio is the same engine with a hand-made interface: a small Mac app, or the same interface in your browser.

### Install the desktop app

```bash
npm run app:build                      # makes build/Screenshotter.app
open build/Screenshotter.app           # try it
cp -R build/Screenshotter.app /Applications/   # keep it (optional)
```

The app is small (a native window around the Studio plus the engine) and uses the Node.js you already have. It finds Node the way your terminal does (Homebrew, nvm, Volta, asdf…). If it can't, it asks you to point at it. `npm run app:build -- --bundle-node` copies Node into the app instead (about 100 MB more), for Macs without Node. The build is signed for your Mac only; macOS may ask you to confirm the first time you open it (right-click → **Open**).

It reads your shell profile at launch, so `ANTHROPIC_API_KEY`, the AI-background keys and tools like `ffmpeg` and `claude` from `~/.zshrc` work without extra setup. Its engine runs on a private local port and stops when you quit the app.

### Or run it in the browser

```bash
npm run studio                             # opens http://127.0.0.1:4545
node dist/index.js studio --port 5000 --no-open
```

### How to use it

Three steps: **add a screenshot**, **make it yours**, **export**. The first screen walks you through it, a small checklist tracks your progress, and **Help** in the left rail explains everything again.

1. **Add a screenshot (Screens):** choose where the screen comes from:
   - **Simulator:** pick a device and an app, then **Capture**. **Record** grabs a 6-second clip that plays inside the frame in videos.
   - **Website:** type a URL. Desktop pages are captured at 3× after lazy images load, with cookie banners hidden.
   - **Mac app:** pick a window.
   - **Import:** drop image files or screen recordings (MP4, MOV) anywhere in the window, paste with ⌘V, or open them with Screenshotter from Finder. A recording plays inside the selected device (or the one whose screen shape matches it, or a new device), on the canvas and in exported videos. You can also attach one from a device's **Recording** settings.

   Click a screenshot to use it; drag it onto the design to add another device.
2. **Make it yours:**
   - **Edit** view shows where things go. Drag a device to move it, pull a corner to resize, and use the round handle above it to rotate. Pink guides snap to the centre and to other items; hold ⌥ to turn snapping off. Double-click any text to retype it.
   - The right-hand panel shows whatever you selected: its frame style, device colour, front or back (iPhones), Apple art or drawn frame, size and position, **focus** (blur a device so it sits out of focus behind a sharp one, or fade it into the backdrop), 3D angle, shadow, call-outs and a screen recording. With nothing selected, it shows settings for the whole image: size (App Store sizes, Story, Post, Square, Wide) and arrangement.
   - **Right-click** anything for its actions: a device (replace the screenshot, show its back, duplicate, arrange, delete), text, the canvas, a screenshot in the library or an export.
   - **Backdrop** has ready-made looks (photographic, public-domain paintings and prints such as Hokusai's *Great Wave* or Monet's footbridge, and soft gradients), your own colours or gradient, Unsplash photos, your own photo, or an AI-generated image, with photo adjustments and a film look. **Print & paint** reprints or repaints the backdrop (never your screenshots) as a risograph, newsprint, halftone, one-bit dither, oil painting, watercolour or ink wash, or sets it behind fluted glass.
   - **Shapes** adds arrows, lines, circles, boxes, triangles, stars and number badges. Pick a colour, then drag a shape onto the design and drop it where you want it (or click to add it in the middle). Drag to move it, pull a corner to scale it or a side to stretch it, and turn the round handle to rotate; an arrow or line has a handle at each end and one in the middle to curve it (Shift keeps it to 15° steps). The right-hand panel sets its fill, stroke colour and width, dashed or dotted lines, corners, opacity and shadow, and **Hand-drawn** redraws it like a marker. Optionally, **Snap to text on the screen** places a mark for you: pick the words to circle, box, point at or number, and the mark lands on them and follows the device until you drag it yourself.
   - **Text** holds the headline (put `**stars**` around words to colour them) and extra labels, badges and ratings. Enter finishes typing; Shift+Enter starts a new line. New labels go in free space, clear of the devices.
   - **Ask AI** (⌘K) opens a chat panel you can drag anywhere over the canvas. Ask for a change in plain language, such as *"tilt the phone 12° and use a warm sunset backdrop"*, then keep going: *"a little less"*, *"now match the accent to the app"*. Each reply builds on the conversation so far. While Claude works you see its steps: the preview it's looking at, what it found in the scene, and how long it's been thinking. Then it lists each change it made. Select something first to aim a request at it. Each AI change is one undo step (⌘Z) and has its own **Revert**; **+** starts a new chat. Claude designs from a detailed art-direction guide (composition, copy, type pairings, colour taken from your app's own palette, backdrops, finishes and call-outs), sees what's on your screen (its colours and its text, so it can point call-outs at the right thing), and checks its own render before you see it, fixing anything off. Open requests like *"make it look amazing"* get a proper redesign; specific ones change only what you asked. When you tell it what you like (*"always Space Black"*), it remembers: **Settings › House style** lists and edits what it remembers.
3. **Preview and export:**
   - **Preview** (⌘2) renders the finished image, with the real frame, lighting and effects. It re-renders automatically if you changed something.
   - **Export** saves a full-size PNG, JPEG or WebP, or a video (MP4, MOV, WebM, GIF) with gentle camera motion.
   - Drag the finished image straight into Finder, Slack or Figma, or use **Copy**. **Saved** lists everything you've exported; exports of the same scene stack into one card with its **versions**, and any version can be viewed or restored as the working design.

**Workspace:** the two side panels get out of the way when you want room. **Focus mode** (⌘\\, or the button in the canvas's top-right corner) hides both so the design fills the window; press it again to bring back what was open. The buttons in the canvas corners show or hide one panel at a time (⌥⌘S for the left panel, ⌥⌘I for the inspector on the right). Drag the edge of either panel to resize it, and double-click the edge for the usual width. The layout is remembered.

**Designs:** the **Designs** tab turns your screens into complete, proven designs in one click: bold hero, art director, in the gallery (a painting backdrop), risograph print, 3D tilt, depth of field, rising pair, staircase, mosaic, feature call-out, how-to and dissolve. Each uses your screenshot's own colours and keeps your words. **Design it for me** asks Claude for three different designs, each rendered, to pick from. A new scene's first screenshot starts from the bold hero rather than a plain layout.

**Scenes:** every design is saved as you work, along with its AI chat. **Scenes** (top of the left rail, or ⇧⌘O) opens them all, full window: large previews grouped by when you last edited them, a list view with devices, size and dates, filters for iPhone, iPad, Mac, Watch and web, sorting by last edited, date created or name, and search by name, headline or device. Click a scene to open it; right-click (or **…**) to rename, duplicate or delete it. Arrow keys move between scenes, Return opens one, ⌘D duplicates, ⌫ deletes and Esc goes back. Start a blank scene, frame your latest screen in a finished design, or have Claude design it, from the top of the page; dropping images on it starts a new scene with them. The arrow beside the scene name switches scenes quickly, typing over the name renames it, and ⌘S saves right away. Scenes live in the output folder under `.studio/scenes`.

The **</>** button shows the design as JSON: exactly what an AI agent sends to `create_mockup`. You can edit and apply it there.

**Agents and your scenes:** an agent using the MCP server can list your scenes, open one, and save a design back. What it saves is a new scene unless you asked it to change one in place; if that scene is open, the agent's version appears on your canvas within a few seconds with an **Undo** (it's one ordinary undo step), and a scene an agent adds is announced with an **Open** button. The agent finds your library by itself: the Studio notes which folder it's using each time it starts, and files an agent brings from elsewhere are copied into that folder.

Everything is saved in your output folder: `~/Pictures/Screenshotter` for the app (change it in **Settings**), or `./screenshots` / `SCREENSHOTTER_OUTPUT_DIR` for the browser Studio and the MCP server. Point the MCP server's `SCREENSHOTTER_OUTPUT_DIR` at the same folder and captures your agents take appear in the app too. The Studio and the MCP server take turns on the simulator, so you and an agent can work at the same time.

### Device art

Out of the box, devices are drawn by Screenshotter. For photographic frames, use Apple's own product bezels: **Settings › Device art › Get from Apple** downloads the sets you tick (iPhone 18, iPhone Duo, iPhone 17, Apple Watch Series 11 and Ultra 3, MacBook Pro, MacBook Air, iPad Pro, iPad Air, iPad mini, iPad) straight from [Apple Design Resources](https://developer.apple.com/design/resources/#product-bezels). macOS then shows Apple's license for each one; they're added only once you accept it. You can also download them yourself, open them, and choose **Add files…**. They're kept in `~/Library/Application Support/Screenshotter/Bezels` (or `SCREENSHOTTER_BEZELS_DIR`), and any device whose model and colour have a bezel uses it; switch a device back with **Art › Drawn** (`bezel: false`). Sets you already have are marked **Installed** and never downloaded again, and each disk image is deleted once it's imported. Tilted in 3D, MacBooks and Apple Watches use the drawn frame, which has real depth.

Screenshotter doesn't include or redistribute Apple's bezels: Apple's license doesn't allow it, and it has to be accepted by whoever uses them. It also only covers mock-ups of apps that run on Apple platforms, so website captures keep the drawn frames unless you set `bezel: true`.

### Ask AI setup

Ask AI uses Claude. With nothing to configure, it uses your signed-in **Claude Code** (run `claude` once in Terminal). It runs in an isolated session with no tools, no MCP servers and no project files. Or add an **Anthropic API key** in **Settings** (the app keeps it in your Keychain), or set `ANTHROPIC_API_KEY`. With a key it calls the Claude API directly, defaulting to `claude-opus-5-5`; pick another model in Settings or with `SCREENSHOTTER_EDIT_MODEL`.

Claude receives your instruction, the design settings, the current positions and a small preview render of the design (about 1400 px on the long side), so it can see spacing, contrast and what's on screen. Turn the preview off in **Settings › AI Edit** if you'd rather it only saw the settings. It never receives your files: screenshot, recording and font paths are replaced with placeholders, and it can only refer back to those placeholders. It replies with a short list of edits, which are checked against the design schema before they're applied, so anything you didn't ask about stays exactly as it was.

## How agents use it

A typical session is: capture, compose, look at the preview, and adjust. The scene is a set of entities: each device, the caption and each extra text. Every result, and `layout_mockup` without rendering, lists them with their resolved positions and sizes as canvas fractions. To move or resize one, set its properties: `devices[i].x`/`y` (centre), `height` and `rotate`; `textStyle.x`/`y` for the caption; `texts[i].x`/`y` for extra text. Every tool that makes an image returns a small preview, so the agent can check its work. Every output also gets a `.mockup.json` file next to it with the exact request, so a result can be tweaked and re-rendered.

Things you can ask for:

- *"Build my app for the iPhone 17 Pro simulator and make 5 App Store screenshots with headlines, pastel look, black frames."*
- *"Take a screenshot of the Today screen, lift the 'Add a task' row, and put it on the meadow-motion look at 16:9 for our changelog."*
- *"Make a 6-second video of the onboarding flow playing inside an iPhone on a cloud background."*
- *"Capture our landing page on desktop and iPhone and show them together, laptop behind phone."*

### Reaching a specific screen

Simulators can't be tapped from the command line, so agents reach screens with deep links (`url`), launch arguments (`launchArgs`, for example a demo-data or screenshot mode in your app), or environment variables (`launchEnv`).

Pass `grantPermissions: ["all"]` to pre-approve location, photos, contacts, calendar and similar prompts.

Notification prompts are different: `simctl` can't pre-grant them, and iOS keeps an unanswered prompt on screen over every app. Screenshotter never answers a prompt for you, but:

- If a prompt left over from **another** app covers the screen, the capture clears it by restarting SpringBoard (the home screen process), relaunches your app and captures again (`clearAlerts`, on by default). Nothing is granted or declined; that app will simply ask again the next time it opens.
- If the prompt comes from the app you're capturing, clearing would not help (it asks on every launch), so the result's `warnings` say so. The Studio shows an **Open Simulator** button: answer the prompt once there and iOS remembers it. Your own app can skip the prompt in a screenshot mode (`launchArgs`).

## Tools

| Tool | What it does |
| --- | --- |
| `list_simulators` | Available simulators, their state and runtime |
| `list_apps` | Installed apps and bundle ids on a simulator |
| `simulator_control` | Boot, shutdown, launch, terminate, open URL, install, appearance, status bar, location, permissions |
| `capture_screenshot` | Capture a simulator screen: status bar 9:41, full battery; waits until animations stop |
| `record_simulator` | Record the simulator screen, optionally opening deep links on a timeline |
| `capture_web` | Screenshot a URL: iPhone/iPad in real Mobile Safari, desktop in headless Chrome |
| `capture_mac` | Capture a Mac app window by name, or the whole screen |
| `record_web` | Rehearse, then record a click-through of a web page; returns the video, a still and a cursor track |
| `record_mac` | Record a Mac app's window (or the display) for a number of seconds |
| `find_text` | On-device OCR: every text line with pixel and point boxes |
| `layout_mockup` | Resolve a request into its entities (devices, caption, texts) with positions, without rendering |
| `create_mockup` | Compose one image: frames, background, effects, highlights, caption, shapes (arrows, circles, boxes, number badges; aimed at on-screen text with `around`) |
| `create_mockup_set` | A consistent series (such as a full App Store set) with a contact sheet |
| `create_video` | The same scene animated: motion, zooms that follow the action, a drawn cursor with clicks and drags, reveals, screen recordings in frames |
| `crop_image` | Crop or zoom into part of any image, optionally enlarged: detail shots, and checking details of a render |
| `create_grid` | Lay images out as a contact sheet or mosaic, with labels: compare variants, present a set |
| `design_guide` | The art-direction guide agents design by |
| `get_house_style` / `remember_style` | What the person likes, remembered between sessions (shared with the Studio's Ask AI) |
| `apply_recipe` | A complete, proven design (bold hero, art director, gallery painting, risograph, 3D tilt, depth of field, rising pair, staircase, mosaic, call-out, how-to, dissolve) built from your screenshots and their colours |
| `list_scenes` / `get_scene` | The designs saved in the Studio, and any one of them as a request an agent can change and render |
| `save_scene` | Put a design into the Studio's Scenes, editable there by hand. A new scene by default; replaces an existing one only with its id and `replace: true` |
| `list_mockup_options` | Devices and colours, looks, canvases, layouts, grades |

For Claude Code there's also a skill, `skills/screenshot-design/SKILL.md`: the design guide plus the working loop (capture, read the screen, compose, crop into details, compare variants in a grid, refine). Copy the `skills/screenshot-design` folder into `~/.claude/skills/` (or a project's `.claude/skills/`) to use it; `npm run skill` regenerates it from the guide.

The repository is also a Claude Code plugin (`.claude-plugin/plugin.json`): the MCP server, that skill, and a hook (`hooks/design-check.mjs`) that, the first time an agent renders in a session, hands it a short design checklist and your house style, and reminds it to zoom into details and compare variants before moving on. Build first (`npm run build`), then install it from this folder with Claude Code's plugin commands.

### Status bar

Simulator captures keep iOS's own status bar. By default the values are set with Apple's `simctl status_bar override` to 9:41, full signal, and a full battery. The clock is switched to 12-hour so it reads "9:41"; changing that reboots the simulator once. Pass `statusBar: false` to keep the live values, or `statusBar: { time: "10:09" }` to change them. Before launching an app, Screenshotter returns to the Home Screen, so iOS doesn't add a "◀ Previous App" back-link. watchOS has no status bar override, so watch faces show the real time.

## Examples

**A 16:9 hero with a lifted row on a motion-blurred photo:**

```json
{
  "devices": [{ "screenshot": "screenshots/raw/today.png", "highlights": [{ "style": "lift", "text": "Add a task" }] }],
  "canvas": "16:9",
  "layout": "hero-bleed",
  "background": "meadow-motion"
}
```

**An App Store screenshot with a tilted phone and accent words:**

```json
{
  "devices": [{ "screenshot": "screenshots/raw/home.png", "color": "Cosmic Orange" }],
  "layout": "tilted",
  "headline": "Everything, **in its place**",
  "subheadline": "Your day, planned in seconds.",
  "background": "clouds",
  "textStyle": { "accentColor": "#ea580c" },
  "effects": { "grain": 0.12, "grade": "warm-film" }
}
```

**A photo from Unsplash, or generated by AI, with treatment:**

```json
{ "background": { "unsplash": "misty mountains", "motionBlur": 0.06, "haze": 0.3 } }
{ "background": { "generate": "soft pastel sand dunes at golden hour", "blur": 0.004 } }
```

**A video with a screen recording and a camera zoom:**

```json
{
  "devices": [{ "screenshot": "recordings/app.png", "video": "recordings/app.mp4", "highlights": [{ "style": "loupe", "text": "00:40" }] }],
  "canvas": "9:16",
  "background": "sunset",
  "video": { "motion": "float", "zoom": { "start": 2, "end": 5 } }
}
```

## Options at a glance

- **Frames:** `device` (default), `browser` (address bar from `url`), `window` (`title`), `card`, `none`. Finishes are model colours such as *Burgundy*, *Glacier*, *Cosmic Orange* or *Deep Blue*, generic ones (*Black*, *Silver*, *White*, *Graphite*, *Natural*, *Gold*, *Blue*, *Orange*), or any hex. `side: "back"` shows an iPhone's back. `bezel` picks Apple's product art or the drawn frame. A device can take just a `video`: stills use its first frame. Devices newer than the catalog are drawn from Xcode's own device profiles.
- **Layouts:** `hero`, `hero-bleed`, `text-bottom`, `tilted`, `floating`, `duo`, `trio`, `split` (caption beside), `stack` (multi-device), `grid` (a mosaic of screens), `staircase` (screens stepping up), `rising` (the same, counter-rotated), `custom`. `camera: { zoom, x, y }` zooms the scene in on a point for a crisp close-up. Positions and sizes are fractions of the canvas, so they work on any size.
- **Looks:** photographic (`meadow-motion`, `lavender-motion`, `wheat-motion`, `ocean-motion`, `clouds`, `sky`, `dusk`, `dunes`, `forest-mist`, `aurora-night`, `city-bokeh`, `linen`, `palm-shadow`, `snow-dawn`), public-domain paintings and prints from museum collections (`great-wave`, `fuji-coast`, `woodblock-fuji`, `morning-glories`, `hollyhocks`, `monet-bridge`, `monet-garden`, `green-wheat`, `olive-grove`, `golden-sea`, `lake-mountains`, `misty-hills`, `pastel-shore`, `iris-plate`, `wisteria-plate`) and procedural (`cream-grain`, `peach-glow`, `lavender-mist`, `mint-sage`, `iridescent`, `coral-periwinkle`, `indigo-fade`, `ember-glow`, `midnight`, `aurora`, `sunset`, `pastel`, `mint`, `peach`, `ocean`, `ember`, `graphite`, `paper`, `studio-white`, `ink`). Photo and painting looks fall back to a gradient when offline.
- **Finishes:** `background.finish` prints or paints the backdrop: `risograph` (two inks, set with `colors`), `newsprint`, `halftone`, `dither`, `oil`, `watercolor`, `ink`, `fluted-glass`; `scale` and `amount` tune it.
- **Type:** any Google Fonts family for the caption and texts; `subheadlineFont` pairs a second face; **accent** words take their own `accentColor` (or gradient), `accentFont`, `accentWeight` and `accentItalic`.
- **Call-outs** (`highlights`): `lift` (with `breakout` for a card wider than the device), `loupe` (it can sit beside the device and still magnify its target), `outline`, `spotlight`, `blur-rest`, `blur` (hide something private), `highlighter`, numbered `step` markers and curved `arrow`s. Aim them by visible text or a rectangle.
- **Per device:** `blur` (soft focus), `fade` (dissolve into the backdrop), `menuBar` (MacBooks draw the macOS menu bar with the app's name and menus). A scene `menuBar` draws one across the top of the canvas for menu bar app shots.
- **Photo treatment:** `motionBlur` + `motionAngle`, `blur`, `haze`, `tint` + `tintAmount`, `brightness`, `contrast`, `saturation`, `bloom`, `halation`, `dim`, `zoom`, `focusX`/`focusY`. Blur amounts up to 0.5 are fractions of the canvas width; larger values are pixels.
- **Effects:** `grain` (background only by default, so captured UI stays clean), `vignette`, `edgeBlur`, `grade` (`airy`, `warm-film`, `cool-film`, `faded`, `cinematic`, `vivid`, `mono`, `noir`).
- **Shadows:** `none`, `soft`, `medium`, `strong`, `studio`, or `{ opacity, blur, offsetY, color: "auto" }`.
- **Canvases:** App Store sizes (`iphone-6.9`, `iphone-6.5`, `ipad-13`, …), `16:9`, `4:3`, `1:1`, `4:5`, `9:16`, `og`, `twitter`, `product-hunt`, or `"WIDTHxHEIGHT"`.

## Configuration

| Variable | Purpose |
| --- | --- |
| `SCREENSHOTTER_OUTPUT_DIR` | Where files go (default `./screenshots` in the working directory) |
| `SCREENSHOTTER_CHROME_PATH` | Chrome/Chromium executable if it isn't in `/Applications` |
| `SCREENSHOTTER_CACHE_DIR` | Photo, AI image and OCR helper cache (default `~/.cache/screenshotter`) |
| `SCREENSHOTTER_STUDIO_PORT` | Studio port (default 4545) |
| `SCREENSHOTTER_BEZELS_DIR` | Folder of Apple product bezels to use as device art (default `~/Library/Application Support/Screenshotter/Bezels`) |
| `OPENAI_API_KEY` / `GEMINI_API_KEY` / `REPLICATE_API_TOKEN` / `FAL_KEY` | AI background providers, used in that order |
| `SCREENSHOTTER_OPENAI_IMAGE_MODEL`, `SCREENSHOTTER_GEMINI_IMAGE_MODEL`, `SCREENSHOTTER_REPLICATE_MODEL`, `SCREENSHOTTER_FAL_MODEL` | Override the image model per provider (OpenAI defaults to `gpt-image-2`) |

## Troubleshooting

- **"No Chromium-based browser found":** install Google Chrome or set `SCREENSHOTTER_CHROME_PATH`.
- **The first capture is slow:** the simulator boots and, once, reboots to apply the 12-hour clock. Later captures take a few seconds.
- **A capture shows a blank or half-drawn screen:** captures wait until two consecutive frames match (small changes like a blinking cursor are ignored), for up to 10 seconds (`maxWaitMs`). Raise `waitMs` for apps that load data slowly. A typical capture takes 3–4 seconds.
- **Mac window capture fails:** grant Screen Recording to the terminal or app running the server (System Settings › Privacy & Security).
- **Tool calls time out in your client:** raise the client's MCP tool timeout. Video renders can take up to a minute.
- **Photos show up as gradients:** Unsplash couldn't be reached, so the look used its offline fallback. The result's `warnings` say so.
- **A permission alert appears in captures:** prompts from other apps are cleared automatically. One from the app you're capturing needs answering once in the Simulator window (Studio button, or `simulator_control` with `open_simulator_app`). In Xcode 27 simulators live in **DeviceHub** (Simulator.app is gone); Screenshotter opens whichever your active Xcode has.
- **Wrong format on disk:** the output format follows `format`, else the `output` file's extension (`.png`, `.jpg`, `.webp`; `.mp4`, `.mov`, `.webm`, `.gif` for videos). A conflicting extension is corrected.

## Website

`site/` is the website: `index.html` (a short page that sells the app), `features.html` (everything it does, in detail) and `changelog.html`, plus `site/assets/`. Every image on it is rendered by Screenshotter, from a made-up recipe app ("Mise") drawn in `site/demo/screens.ts`. Its food photos come from Unsplash: `site/demo/photos.ts` downloads them once into `site/demo/photos/`, with the photographers in `credits.json`. The three Studio screenshots (`ui-*.webp`) are captures of the Studio itself and are not re-rendered by `site:assets`.

```bash
npm run site:assets   # re-render the page's images and video with the engine
npm run app:dmg       # build the app and package it as site/downloads/Screenshotter.dmg
npm run site          # preview at http://127.0.0.1:4700
```

To publish, upload the `site/` folder to any static host (Vercel, Netlify, GitHub Pages, S3). It is set up for Vercel as the `screenshotter` project: `cd site && vercel deploy --prod` (`site/.vercelignore` leaves out `demo/`). The **Download** button links to `downloads/Screenshotter.dmg` next to the page. If you host the disk image elsewhere, such as a GitHub release, change that link in `site/index.html`.

**Signing.** `npm run app:build` and `npm run app:dmg` sign with your **Developer ID Application** certificate when one is in your keychain (Xcode › Settings › Accounts › Manage Certificates), with the hardened runtime, and sign the disk image too. Without one, the build is signed ad hoc. `SCREENSHOTTER_SIGN_IDENTITY` picks a different identity (part of its name), or `-` for ad hoc. A signed app that isn't notarized still makes macOS ask people to allow it (System Settings › Privacy & Security › **Open Anyway**) the first time; the page says so. To remove that step, save notarization credentials once with `xcrun notarytool store-credentials screenshotter --apple-id <your Apple ID> --team-id <TEAMID>` (it asks for an app-specific password from account.apple.com); from then on `npm run app:dmg` notarizes and staples the image. `SCREENSHOTTER_NOTARY_PROFILE` names a different profile.

## Development

```bash
npm run dev          # MCP server from source (tsx)
npm run studio:dev   # browser Studio from source (UI files in src/studio/ui reload on refresh)
npm run app:build    # build the desktop app into build/Screenshotter.app
npm run app:test     # Swift tests for the app shell (shell environment, Node lookup, title bar)
npm run app:check    # the app's bundled engine: UI, PNG, MP4, saved state, exits with the app
npm run test:studio  # Studio server and Ask AI tests (fake Claude, no simulator or account)
npm run smoke        # end-to-end test of every tool through a real MCP client (uses the simulator)
npm run test:edge    # rendering, format, lock and error-handling edge cases (no simulator needed)
```

The desktop app is a small AppKit window (`app/`) around the same web UI (`src/studio/ui`, plain ES modules with Preact and htm, no bundler). To run the app against your working copy instead of its bundled engine, start it from a terminal: `SCREENSHOTTER_ENGINE_DIR=$PWD build/Screenshotter.app/Contents/MacOS/Screenshotter`. Engine logs go to `~/Library/Logs/Screenshotter/engine.log`.
