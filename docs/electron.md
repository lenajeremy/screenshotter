# The desktop app in Electron

The Mac app's shell moves from Swift + WKWebView (`app/`) to Electron (`desktop/`), so the
Studio, and above all the board canvas, runs in Chromium everywhere. Decided 2026-11-22 after the
canvas benchmark (`npm run bench:canvas`, results in `docs/perf/`): WebKit held 21–47 fps on
zooms and heavy boards where Chromium held 60, and capped high-zoom text rasterization; other
systems (Windows, Linux) come later.

Nothing in the Studio or the engine changes: the page and the engine are the same, the shell
around them is new. The canvas, the panels, the right-click menus the page draws all carry over.

## Running, building, checking

| | |
|---|---|
| `npm run desktop` | build, then run the app from this checkout (as "Glassine Dev": its own library, settings and Keychain items) |
| `npm run desktop:check` | the app on a throwaway library: engine, page, native calls, window, menus, links, quit, `mcp` |
| `npm run desktop:build` | `build/<name>.app` (`SCREENSHOTTER_APP_NAME=Glassine` for a separate copy) |
| `npx tsx scripts/desktop-check.ts --app` | the same checks on the built app |
| `npm run desktop:dmg` | tests, the app, a disk image, signed and notarized when the credentials are there, and the update feeds |
| `npx tsx scripts/canvas-bench.ts electron` | the canvas benchmark in the real Electron window |

Electron is a dev dependency (`node_modules/electron`, about 250 MB). If `npm install` skipped its
download: `node node_modules/electron/install.js`.

## What the shell does (desktop/main.js), as the Swift app did

- One window, no title bar of its own: the traffic lights sit in the Studio's 52 pt top bar, and
  the page's `[data-drag]` bars move the window (`-webkit-app-region` in styles.css, instead of
  reporting drag rectangles to the app). Closing the window keeps the app and engine running.
- The engine: `dist/index.js studio --watch-stdin`, run with Electron's own Node
  (`ELECTRON_RUN_AS_NODE`), so the app no longer carries a Node of its own; the person's shell
  environment (PATH, keys) read once from a login shell; a status page while it starts or if it
  fails; restarted from File › Restart Engine.
- The page's native calls (`window.glassine.native`, through `preload.cjs`; `store.js` `native`
  takes it, or the Swift web view's): settings, theme, Unsplash, Figma and cloud session tokens
  (Keychain, service `<name>.AI`, as before, through `/usr/bin/security`), the library folder,
  links, copying text and files, file pickers, the log. The colour picker uses Chromium's own
  EyeDropper.
- Menus as before, plus Edit's Cut, Copy, Paste and Select All (text fields need them in
  Electron), and a text menu (spelling, Look Up) on right-click in a field.
- ⌘V with Figma clipboard designs, pictures or files puts them on the board; `.fig` files and media
  opened from Finder or dropped on the Dock icon too (they wait until the page has loaded).
- Quitting gives the page up to 1.5 s to save its last edit.
- `<app> mcp`: the engine's MCP server for agents, as before.
- Updates: Electron's updater reads `site/desktop-feed.json` (written by
  `scripts/release-feed.mjs` beside Sparkle's appcast). Only the main app updates itself.

## Moving people over

The next release made with `npm run desktop:dmg` is offered by the Swift app's Sparkle feed as
usual (same bundle id, same Developer ID), so people on the Swift app get the Electron app with
their next update; from then on it updates from `desktop-feed.json`. Keep `app/` until that
release is out, then delete it with `build-app.mjs` and the Sparkle parts of the release scripts.

## Size

The app is about 283 MB on disk (Electron 250 MB, engine 30 MB), against 146 MB for the Swift
app (111 MB of which was its own Node). The app doesn't need Chrome installed for the canvas; the
engine still draws exports and thumbnails with the person's Chrome (moving those to Electron's
Chromium would drop that need).
