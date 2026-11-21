# Screenshotter

Design with your agent. A board is a canvas of artboards made of real HTML and CSS: you and your agent (Claude Code, Codex, Cursor, or any MCP client) work on the same one, and you watch each change land as it's made. Bring in your website or a Figma file as layers to start from, then ask for what you want.

- **Bring in your website:** a page comes onto a board as ordinary layers (its layout, words, pictures, vectors and fonts), as the browser draws it at the width you pick.
- **Bring in a Figma file:** its frames, or one frame from its link, as layers: auto layout as flex, fills, strokes, radii, shadows, text with its styles, pictures, and vectors as SVG.
- **Your agent on the canvas:** it writes HTML onto the board, reads it back, takes screenshots of its work, and answers your comments. Several agents can work on one board at once. Follow one to watch it work.
- **Yours to change:** everything an agent makes is ordinary layers you can select, edit, undo and export.

## Install

Put **Screenshotter.app** in Applications and open it. The app is also the MCP server (`Screenshotter mcp` runs it on the Node.js inside the app), so there is nothing else to install. The first screen shows how to connect your agent, and says so when it's connected. By hand:

```bash
claude mcp add screenshotter --scope user -- /Applications/Screenshotter.app/Contents/MacOS/Screenshotter mcp
codex mcp add screenshotter -- /Applications/Screenshotter.app/Contents/MacOS/Screenshotter mcp
```

In Cursor or any other client, add a server that runs `/Applications/Screenshotter.app/Contents/MacOS/Screenshotter` with the one argument `mcp`.

**Figma** needs a personal access token: in Figma, Settings › Security › Personal access tokens › Generate, with read access to files. Paste it the first time you import (or in Settings › Figma & photos); the app keeps it in your Keychain. Agents can import too (`board_import_figma`), with the token from the app or `FIGMA_TOKEN`.

### From source

Needs macOS, Node.js 20 or later, and Google Chrome (or another Chromium browser) for drawing boards and reading websites.

```bash
npm install && npm run build
claude mcp add screenshotter --scope user -- node "$PWD/dist/index.js"
npm run studio       # the app's UI in your browser, at http://127.0.0.1:4545
```

## Boards

A **board** is a design canvas made of real HTML and CSS: pages of artboards (a phone screen, a desktop page, a card), each a tree of layers (frames, text, images and vectors) with its own CSS. It's where an agent can prototype a screen or a flow for you to see before anything is built, and where you can change it after. Home lists them; **New board** starts one.

- **The canvas** draws every artboard as the HTML it is, on an endless canvas: scroll or drag with space held (or **H**) to pan, pinch or ⌘-scroll to zoom, ⇧0 for 100%, ⇧1 to fit the page, ⇧2 to zoom to the selection.
- **The scratchpad** is one board that's always there, for trying things out without making a new board each time: a page per try. Tell an agent to "use a new page in my scratchpad" and it adds one named for the try (`board_create` with `scratchpad: true`). It can't be deleted; its pages can.
- **Selecting:** a click picks the layer sitting on the artboard; double-click goes straight to the deepest layer under the pointer, however nested (and into its words, if it's text); hold **⌘** to see which layer that is, and ⌘-click picks it; right-click → **Select layer…** lists every layer under the pointer, deepest first; **Esc** and **Enter** select the parent and the children; **Tab** steps through siblings. **⌘\** hides or shows both side panels. A click on an artboard's background selects it, a drag there selects what's inside, and its name above it moves it.
- **Changing things:** drag to move (artboards snap to each other), drag a layer along its flex row or column to reorder it, or past its frame's edge into another frame; the handles resize. The **Scale** tool (**K**), as in Figma, makes the handles scale instead: the layer grows or shrinks with everything in it, type, padding, gaps, corners, borders and shadows too, in proportion, the opposite side staying put (⌥ scales from the centre). Its panel scales by a percentage or to a width or height, from any of nine points. **F**, **R** and **T** draw a frame (an artboard on the empty canvas; the right panel offers phone, tablet, desktop, watch, App Store and social sizes), a rectangle and text. Pictures come from **⇧⌘K**, a drop or a paste.
- **The layer list** opens frames, renames (double-click or ⌘R), hides (⇧⌘H), locks (⇧⌘L) and moves layers by dragging, into a frame or between layers.
- **The right panel** is the layer's CSS in words: position, size (**Fixed**, **Fit**, **Fill** or **Relative** for each side), flex (direction, the alignment pad, gap, padding, wrap, spread), absolute position, clip, opacity and blend, corners, fills (solid colours, linear, radial and conic gradients, and pictures, stacked), border and outline, shadows (outside or inside), **filters** (blur, brightness, contrast, grayscale, hue, invert, saturation, sepia, on the layer or behind it, for frosted glass), type and the picture, and **selection colours** (every colour in the selection, to change them all at once). Each fill, shadow and filter is one row; click it to edit it in a popover. **CSS** at the bottom edits all of it as text. With nothing selected it shows the board's **tokens** (CSS custom properties any layer can use as `var(--name)`), with how many layers use each (click the number to select them); click a token's name to rename it, and every `var()` that uses it follows. Every colour field on a board offers the board's colour tokens under its picker: pick one and the field uses it, showing the token's name, or **Make a token** from the colour you've picked.
- **Grids:** a frame lays its layers out freely, with flex or as a CSS grid: pick **Free | Flex | Grid** in the panel, press **⇧G** (a grid of the frame, or round the selection, keeping every layer where it is) and **⌥⇧G** to go back. The **Grid** section sets the columns and rows (how many, and each track as Fill, Fixed, Hug, Min or Max content, a range, or any CSS), gaps, padding, where layers sit in their cells, the flow, the size of new rows, and named areas, with a columns × rows picker and layouts to start from (sidebar and main, cards that wrap, bento). On the canvas a selected grid shows its tracks and gaps, each track's size on hover and its menu on a click, **+** at the edges and lines to drag between tracks; drag a layer to another cell, or its edge across cells to span them. **In the grid** sets a layer's column, row, span and area, and whether it fills its cell.
- **Vectors in parts**: an SVG on a board is a vector layer with a layer for each of its parts (groups, rectangles, circles, paths, lines, words), as in Paper. Double-click (or ⌘-click) into it to pick one; drag or resize it and its own coordinates change, so strokes stay crisp; the panel sets its fill, stroke, opacity and words, and lists its SVG attributes. ⌥⌘G groups parts, ⇧⌘G ungroups. **Split into layers** takes a one-piece vector (a sticker, a shape) apart; **Make one piece** puts it back.
- **Assets** (beside Layers) brings in the board's components, shapes (rectangles, circles and pills as frames; arrows, drawn arrows and circles, boxes, triangles, stars, number badges, bursts, ribbons, tags, bubbles, laurels and ratings as shapes you can still restyle), its stickers and illustrations (the one-ink ones take any colour), and your pictures. Click one to add it to the selected frame, or drag it onto the canvas.
- **Lining up:** with layers placed by hand selected (or one inside its frame), the row at the top of **Layout** aligns their left edges, centres, right edges, tops, middles or bottoms (⌥A ⌥H ⌥D ⌥W ⌥V ⌥S), and spaces three or more evenly (⌥⇧H, ⌥⇧V). Several selected layers get one box with handles that resizes them together (⇧ keeps the shape). Hold ⌥ with a layer selected to see its distance to the one under the pointer, or to the edges of its frame.
- **Words:** while typing in a text, select some words and **Text** offers bold, italic, underline, strikethrough and a colour for just those (⌘B, ⌘I and ⌘U work too).
- **Components:** make a frame a component (⌥⌘K, or right-click) and place copies of it (from **Components** on the left, the right panel, or by duplicating or pasting the component). Change the component and every copy changes; change a copy's words, colours or anything else and that copy keeps the change, until you **Reset** it. Layers inside a copy can be changed or hidden but not added, moved or deleted; **Detach** (⌥⌘B) makes a copy ordinary layers again.
- **Commands:** copy and paste (layers copy as HTML, and HTML from anywhere pastes as layers), duplicate (⌘D), wrap in a flex frame (⇧A) or a plain frame (⌥⌘G), ungroup (⇧⌘G), add or remove flex keeping every layer where it is (⇧A / ⌥⇧A), copy and paste styles (⌥⌘C / ⌥⌘V), bring forward and back (] [ ⌘] ⌘[).
- **Export** saves the artboards (or the selection) as PNG or JPEG at 1×, 2× or 3×, or copies them as HTML.
- **Video:** drop an MP4, MOV or WebM on the canvas, paste one, or pick one with the image tool (⇧⌘K). As in Figma, the canvas shows its first frame rather than playing it; select it and it's marked **Video** with a play button, to watch it right there (selecting something else stops it). Its panel has a player (play, scrub, or type a time to jump to it), Fill, Fit or Stretch, and how it plays in Preview: **Autoplay**, **Loop** and **Sound**, all on to start with. In Preview it's a real video (one with sound starts silent if the browser won't play sound before a click); exports, thumbnails and agents' screenshots show its first frame. Agents write `<video src autoplay loop muted>`.
- **Preview** (beside Export, ⌥⌘P, or right-click) opens the selected frame (or the frame round a selected text or picture; with nothing selected, the page's first artboard) as a real web page in your browser, to scroll, click links, select text, resize and inspect. A desktop-size frame (1024 px or wider) is the page and fills the window; a phone, a card or anything smaller keeps its size, centred. Neither is ever wider than the window, so a narrower one shows how it reflows; it keeps the fonts and colours it takes from the frames round it; and it follows the board, redrawing within a second of any change, yours or an agent's. Boards keep inline styles only, so there are no hover effects or working form fields.
- **Comments:** press **C**, then click a layer to pin a comment to it, or drag over part of an artboard to comment on that area. A comment is just a comment until you tag an agent in it with **@** and its name (any of the board's agents, or another agent Agentman runs, which then joins the board): the agents you tag get it through Agentman, your agent manager, and answer. It lands in the agent's own chat, so you see it and its answer in Agentman too. In a thread, tag an agent again to send it your reply. While the agent is working on it, the thread (and its pin) shows so. The agent answers in the thread, usually after changing the design, and its reply shows by the pin. Each message says whether it reached the agent, is waiting for the agent's turn to end, or couldn't be sent and why (Agentman isn't running, the agent's session has ended, it's waiting on a question), with **Try again**. Only you resolve a thread (✓; **Reopen** opens it again), or delete it; **Comments** (beside Layers and Assets) lists them all, and the agents who've worked on the board. Comments aren't part of the design, so undo leaves them alone.

Boards save as you go. An agent's change appears on your canvas within a second, as one step you can undo, and the artboards it's working on are outlined with an **Agent** label until it's done.

Everything is saved in your output folder: `~/Pictures/Screenshotter` for the app (change it in **Settings**), or `./screenshots` / `SCREENSHOTTER_OUTPUT_DIR` for the browser Studio and the MCP server. Point the MCP server's `SCREENSHOTTER_OUTPUT_DIR` at the same folder and captures your agents take appear in the app too. The Studio and the MCP server take turns on the simulator, so you and an agent can work at the same time.

Everything is saved in your library folder: `~/Pictures/Screenshotter` for the app (change it in **Settings**), or `./screenshots` / `SCREENSHOTTER_OUTPUT_DIR` for the browser UI and the MCP server. Point the MCP server's `SCREENSHOTTER_OUTPUT_DIR` at the same folder and your agents' boards appear in the app.

## Tools

| Tool | What it does |
| --- | --- |
| `board_list`, `board_create` | List boards; make one (or a new page on the scratchpad) |
| `board_write_html` | Write HTML and CSS onto a board as layers, one visual group at a time |
| `board_edit` | Change layers, tokens, components, copies, shapes, shaders and pages |
| `board_read` | Read a board back: its tree (with measurements), HTML, tokens |
| `board_screenshot`, `board_export` | See an artboard or a layer; export PNG or JPEG |
| `board_import_website`, `board_import_figma` | Bring a website or a Figma file onto a board as layers |
| `board_comment`, `board_comments`, `board_done` | Answer comments, read them, say the work is finished |

## Configuration

| Variable | Purpose |
| --- | --- |
| `SCREENSHOTTER_OUTPUT_DIR` | The library: where boards and their pictures go (default `./screenshots` in the working directory) |
| `SCREENSHOTTER_CHROME_PATH` | Chrome/Chromium executable if it isn't in `/Applications` |
| `SCREENSHOTTER_CACHE_DIR` | Photo and helper cache (default `~/.cache/screenshotter`) |
| `SCREENSHOTTER_STUDIO_PORT` | The browser UI's port (default 4545) |
| `SCREENSHOTTER_AGENTMAN_SOCKET` | Agentman's socket, which board comments reach agents through (default `AGENTMAN_SOCKET`, else `~/.agentman/am.sock`) |
| `FIGMA_TOKEN` | Figma personal access token, for imports |
| `UNSPLASH_ACCESS_KEY` | Unsplash key, for `unsplash:` photos on boards |

## Troubleshooting

- **"No Chromium-based browser found":** install Google Chrome or set `SCREENSHOTTER_CHROME_PATH`.
- **"Figma refused the token":** make a new personal access token with read access to files, and paste it again.
- **The first screen says "Waiting for your agent" after setup:** start a new session of your agent; it connects when the session starts.
- **Tool calls time out in your client:** raise the client's MCP tool timeout. Imports can take up to a minute.

## Releases

```bash
npm run app:dmg       # check, build, sign and notarize the app as site/downloads/Screenshotter.dmg
```

**Updates.** The app checks `site/appcast.xml` (Sparkle) once a day and on **Check for Updates…**. When `npm run app:dmg` notarizes a release, it also signs the disk image with the update key in your keychain (Sparkle's `generate_keys` made it; `app/.build/artifacts/sparkle/Sparkle/bin/generate_keys -p` prints its public half, which `scripts/build-app.mjs` puts in the app), copies it to `site/downloads/Screenshotter-<version>.dmg` and writes the feed with that version's notes from this changelog (`npm run release:feed` does just that step). Deploying the site publishes the update. Keep the key: without it no later release can update the apps already out there (`generate_keys -x` exports it for safekeeping).

**Signing.** `npm run app:build` and `npm run app:dmg` sign with your **Developer ID Application** certificate when one is in your keychain (Xcode › Settings › Accounts › Manage Certificates), with the hardened runtime, and sign the disk image too. Without one, the build is signed ad hoc. `SCREENSHOTTER_SIGN_IDENTITY` picks a different identity (part of its name), or `-` for ad hoc. A signed app that isn't notarized still makes macOS ask people to allow it (System Settings › Privacy & Security › **Open Anyway**) the first time. To remove that step, give `npm run app:dmg` notarytool credentials and it notarizes and staples the image: a profile you've already saved (`SCREENSHOTTER_NOTARY_PROFILE=<name>`; the default is `screenshotter`), an App Store Connect API key (`SCREENSHOTTER_NOTARY_KEY=<AuthKey_….p8>`, `SCREENSHOTTER_NOTARY_KEY_ID`, and `SCREENSHOTTER_NOTARY_ISSUER` for a team key), or a new profile from `xcrun notarytool store-credentials screenshotter --apple-id <your Apple ID> --team-id <TEAMID>` (it asks for an app-specific password from account.apple.com).

## Development

```bash
npm run dev          # MCP server from source (tsx)
npm run studio:dev   # the UI in your browser, from source (files in src/studio/ui reload on refresh)
npm run app:build    # build the desktop app into build/Screenshotter.app
npm run app:test     # Swift tests for the app shell
npm run app:check    # the app's bundled engine: UI, a board drawn and exported, video stills, exits with the app
npm run test:board   # boards: the model, operations, drawing and exports
npm run test:figma   # Figma import, on a sample file (no token needed)
npm run test:agents  # six agents' MCP servers editing one board at once
npm run test:ui      # the app as people use it, in Chromium and WebKit (npx playwright install chromium webkit once)
```

`npm run app:dmg` runs `test:board`, `test:figma` and `test:ui` against a throwaway library before it builds anything, and stops at a failure (`SCREENSHOTTER_SKIP_TESTS=1` skips them).

The desktop app is a small AppKit window (`app/`) around the same web UI (`src/studio/ui`, plain ES modules with Preact and htm, no bundler). To run the app against your working copy instead of its bundled engine, start it from a terminal: `SCREENSHOTTER_ENGINE_DIR=$PWD build/Screenshotter.app/Contents/MacOS/Screenshotter`. Engine logs go to `~/Library/Logs/Screenshotter/engine.log`.
