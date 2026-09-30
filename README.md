# Screenshotter

Screenshotter is an MCP server plus a desktop app (the Studio) that captures real app screens and turns them into marketing-ready images and videos. It supports:

- **Captures:** the iOS Simulator (iPhone, iPad, Apple Watch), web pages (real Mobile Safari or desktop Chrome), and Mac app windows.
- **Device frames:** iPhone, iPad, Apple Watch, and MacBook in any finish, plus browser, window, and card frames. Frames tilt in 3D and several can share one scene.
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
   - **Website:** type a URL.
   - **Mac app:** pick a window.
   - **Import:** drop image files or screen recordings (MP4, MOV) anywhere in the window, paste with ⌘V, or open them with Screenshotter from Finder. A recording plays inside the selected device (or the one whose screen shape matches it, or a new device), on the canvas and in exported videos. You can also attach one from a device's **Recording** settings.

   Click a screenshot to use it; drag it onto the design to add another device.
2. **Make it yours:**
   - **Edit** view shows where things go. Drag a device to move it, pull a corner to resize, and use the round handle above it to rotate. Pink guides snap to the centre and to other items; hold ⌥ to turn snapping off. Double-click any text to retype it.
   - The right-hand panel shows whatever you selected: its frame style, device colour, size and position, 3D angle, shadow, and call-outs (lift, magnify or spotlight part of the screen). With nothing selected, it shows settings for the whole image: size (App Store sizes, Story, Post, Square, Wide) and arrangement.
   - **Backdrop** has ready-made looks (photographic and gradient), your own colours or gradient, Unsplash photos, your own photo, or an AI-generated image, with photo adjustments and a film look.
   - **Text** holds the headline (put `**stars**` around words to colour them) and extra labels, badges and ratings. Enter finishes typing; Shift+Enter starts a new line. New labels go in free space, clear of the devices.
   - **Ask AI** (⌘K) takes a plain-language request, such as *"tilt the phone 12° and use a warm sunset backdrop"*. Select something first to aim the request at it. Each AI change is one undo step (⌘Z).
3. **Preview and export:**
   - **Preview** (⌘2) renders the finished image, with the real frame, lighting and effects. It re-renders automatically if you changed something.
   - **Export** saves a full-size PNG, JPEG or WebP, or a video (MP4, MOV, WebM, GIF) with gentle camera motion.
   - Drag the finished image straight into Finder, Slack or Figma, or use **Copy**. **Saved** lists everything you've exported.

The **</>** button shows the design as JSON: exactly what an AI agent sends to `create_mockup`. You can edit and apply it there.

Everything is saved in your output folder: `~/Pictures/Screenshotter` for the app (change it in **Settings**), or `./screenshots` / `SCREENSHOTTER_OUTPUT_DIR` for the browser Studio and the MCP server. Point the MCP server's `SCREENSHOTTER_OUTPUT_DIR` at the same folder and captures your agents take appear in the app too. The Studio and the MCP server take turns on the simulator, so you and an agent can work at the same time.

### Ask AI setup

Ask AI uses Claude. With nothing to configure, it uses your signed-in **Claude Code** (run `claude` once in Terminal). It runs in an isolated session with no tools, no MCP servers and no project files. Or add an **Anthropic API key** in **Settings** (the app keeps it in your Keychain), or set `ANTHROPIC_API_KEY`. With a key it calls the Claude API directly, defaulting to `claude-opus-5-5`; pick another model in Settings or with `SCREENSHOTTER_EDIT_MODEL`.

Claude receives your instruction, the design settings and the current positions. It does **not** receive your images: screenshot, recording and font paths are replaced with placeholders, and it can only refer back to those placeholders. It replies with a short list of edits, which are checked against the design schema before they're applied, so anything you didn't ask about stays exactly as it was.

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
| `find_text` | On-device OCR: every text line with pixel and point boxes |
| `layout_mockup` | Resolve a request into its entities (devices, caption, texts) with positions, without rendering |
| `create_mockup` | Compose one image: frames, background, effects, highlights, caption |
| `create_mockup_set` | A consistent series (such as a full App Store set) with a contact sheet |
| `create_video` | The same scene animated: motion, zoom to a highlight, reveals, screen recordings in frames |
| `list_mockup_options` | Devices and colours, looks, canvases, layouts, grades |

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

- **Frames:** `device` (default), `browser` (address bar from `url`), `window` (`title`), `card`, `none`. Finishes are model colours such as *Cosmic Orange* or *Deep Blue*, generic ones (*Black*, *Silver*, *White*, *Graphite*, *Natural*, *Gold*, *Blue*, *Orange*), or any hex. Devices newer than the catalog, such as iPhone 18 Pro, are drawn from Xcode's own device profiles.
- **Layouts:** `hero`, `hero-bleed`, `text-bottom`, `tilted`, `floating`, `duo`, `trio`, `split` (caption beside), `stack` (multi-device), `custom`. Positions and sizes are fractions of the canvas, so they work on any size.
- **Looks:** photographic (`meadow-motion`, `lavender-motion`, `wheat-motion`, `ocean-motion`, `clouds`, `sky`, `dusk`, `dunes`, `forest-mist`, `aurora-night`, `city-bokeh`, `linen`, `palm-shadow`, `snow-dawn`) and procedural (`midnight`, `aurora`, `sunset`, `pastel`, `mint`, `peach`, `ocean`, `ember`, `graphite`, `paper`, `studio-white`, `ink`). Photo looks fall back to a gradient when offline.
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
| `OPENAI_API_KEY` / `GEMINI_API_KEY` / `REPLICATE_API_TOKEN` / `FAL_KEY` | AI background providers, used in that order |
| `SCREENSHOTTER_OPENAI_IMAGE_MODEL`, `SCREENSHOTTER_GEMINI_IMAGE_MODEL`, `SCREENSHOTTER_REPLICATE_MODEL`, `SCREENSHOTTER_FAL_MODEL` | Override the image model per provider |

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

`site/` is the landing page: one HTML file plus `site/assets/`. Every image on it is rendered by Screenshotter, from a made-up recipe app ("Mise") drawn in `site/demo/screens.ts`. Its food photos come from Unsplash: `site/demo/photos.ts` downloads them once into `site/demo/photos/`, with the photographers in `credits.json`. The three Studio screenshots (`ui-*.webp`) are captures of the Studio itself and are not re-rendered by `site:assets`.

```bash
npm run site:assets   # re-render the page's images and video with the engine
npm run app:dmg       # build the app and package it as site/downloads/Screenshotter.dmg
npm run site          # preview at http://127.0.0.1:4700
```

To publish, upload the `site/` folder to any static host (Vercel, Netlify, GitHub Pages, S3). It is set up for Vercel as the `screenshotter` project: `cd site && vercel deploy --prod` (`site/.vercelignore` leaves out `demo/`). The **Download** button links to `downloads/Screenshotter.dmg` next to the page. If you host the disk image elsewhere, such as a GitHub release, change that link in `site/index.html`.

The app is signed ad hoc, so macOS asks people to allow it (System Settings › Privacy & Security › **Open Anyway**) the first time they open it; the page says so. To remove that step, sign the app with an Apple Developer ID and notarize the disk image before you publish it.

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
