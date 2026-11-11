# Boards

A board is a design canvas made of real HTML and CSS, in the spirit of [Paper](https://paper.design): pages of artboards, each a tree of layers (frames, text, images, vectors) with its own CSS. People draw and edit on it in the Studio; agents write HTML onto it through the MCP, and the person watches the design come together. The point: an agent can prototype a screen or a flow, and you see it before anything is built.

## Where we are (11 November 2026)

**Done:**

- **The model** (`src/board/core.ts`). It's pure, so the engine and the Studio share it: the Studio loads it as `/ui/board-core.js`.
  - An HTML reader: inline styles only; block flow becomes flex columns; words become text layers; SVG is made safe.
  - HTML out.
  - Every change is a list of steps that also returns the steps that undo it.
- **Storage** (`src/board/store.ts`): `<library>/.studio/boards/<id>.json`. Changes are applied under a lock, so the Studio and an agent never overwrite each other. Pictures from outside the library are copied into `boards/assets`.
- **Drawing** (`src/board/render.ts`): headless Chrome draws a layer inside its whole artboard, then cuts it out. Used for agents' screenshots, exports and thumbnails.
- **Agent tools** (`src/board/mcp.ts`):
  - `board_list`, `board_create`, `board_read` (overview, tree, measured tree, HTML, tokens)
  - `board_write_html`, `board_edit` (batch: style, text, rename, delete, duplicate, move, visibility, lock, image, artboard, page, token)
  - `board_screenshot`, `board_export`, `board_done`
- **The Studio editor** (`src/studio/ui/board*.js`):
  - **Library:** a Boards shelf with thumbnails, an "agent at work" badge, and New board.
  - **Canvas:** the real HTML on an endless canvas. Pick, go in and out, and ⌘-click to go deep. Move with snapping, reorder inside flex and drag out into another frame, resize. Frame, rectangle and text tools, plus images.
  - **Panels:** pages, and a layer list with drag to reorder and nest.
  - **The right panel:**
    - layout and size (Fixed, Fit, Fill or Relative)
    - flex
    - absolute position, clip
    - look: opacity, blend, corners
    - fill, border, shadow, type, image
    - raw CSS
    - tokens
    - artboard sizes
  - **Commands:** copy and paste as HTML, wrap and ungroup, add or remove flex, copy and paste styles, reorder, export, and put an artboard in a device frame (it becomes a Screenshotter design).
  - **Agents:** their changes show up within a second as undoable steps, with the artboards they're working on marked.
- **Tests:**
  - `npm run test:board`: the core and every tool through MCP.
  - Seven board checks in `npm run test:ui`, in Chromium and WebKit (drawing, picking, reordering, tools, agent changes, components, align and resize, paste).

- **Since (same day):**
  - align and distribute, resizing several layers together, ⌥ distances
  - bold, italic, underline, strikethrough and a colour for selected words
  - stacked fills (solid, linear, radial, conic, picture) with a gradient editor, and lists of shadows
  - **Components** (`expandOps` in the core):
    - Copies are real layers that follow the component's layers through `master`.
    - A copy's own changes are kept as `overrides`.
    - Nothing can be added to, moved inside or deleted from a copy.
    - Reset and detach.
    - Agents get component, copy, detach and reset in `board_edit`.

- **Since (later the same day):**
  - **Assets tab:** components, the app's shapes, stickers, illustrations, devices (Apple's frame round a screenshot or an artboard, via `board/device.ts`), pictures, screenshots and backdrops. Click to add to the selected frame, or drag onto the canvas.
  - **The panel, Paper's way:** filters (layer and backdrop), outline, selection colours. Fills, shadows and filters are rows with popover editors.
  - **Speed:** layers redraw only when they change (every change gives the layers round it new objects); the canvas goes on the GPU while it moves. About 1–2 ms of work a frame on 1,800 layers.
  - **Agents:** `sticker:`/`art:` image sources, and `shape` and `device` changes.

- **Vectors in parts** (12 November): an `<svg>` is an svg layer holding a `vector` layer per part (`tag` and `attrs`; gradients and the like in the svg layer's `defs`). Parts move and resize by their own coordinates (`vectorFit`), else by a transform (`vectorTransform`). Agents get `vector`, `split` and `flatten` in `board_edit`, and write SVG into a vector with `board_write_html`. Stickers, illustrations and shapes stay one piece until split.

**Decisions:**

- The design is HTML and CSS, not a vector format. The browser engine does the layout, the text and the drawing, an agent writes it fluently, and code comes out of it nearly as is.
- Tool names start with `board_` because they share the server with 30 other tools. Edits are batched in `board_edit` to keep the tool count down.
- The Studio and agents both write the file on disk under a lock. An agent's change reaches the open board by polling (every 700 ms), and undoing it replaces the whole board.
- Components: the Studio expands its own changes (so a change to a component shows in its copies straight away) and sends the result. The server expands only agents' changes, so nothing is expanded twice.
- An SVG's parts are layers, not one piece of markup, so they can be picked and changed one at a time (as in Paper). Parts can only sit in a vector and nothing else can go in one; one with more than 800 parts stays one piece.
- Blue is for selection only, as in the rest of the Studio; everything else on boards is neutral. On 11 November the user compared lime for selection and chose blue (lime is hard to see on light designs and already marks agent work).

## Next, in rough order

1. **Released app.** The board tools reach agents once a release ships them: the installed app's MCP is the released one.
2. **Comments** pinned to layers, which agents can read and resolve.
3. **Code out:** copy as JSX or Tailwind (Paper has Tailwind and React CSS). `board_read` gets a `jsx` view.
4. **Prototype mode:** click through artboards linked by layers, full screen.
5. **More editing:**
   - smart guides inside frames
   - component variants and properties
   - per-fill visibility
6. **Pen tool**: drawing paths, and editing a path's points.
7. **Speed:** memoised layers for boards with thousands of layers.
