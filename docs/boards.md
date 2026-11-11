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
  - Five board checks in `npm run test:ui`, in Chromium and WebKit.

**Decisions:**

- The design is HTML and CSS, not a vector format. The browser engine does the layout, the text and the drawing, an agent writes it fluently, and code comes out of it nearly as is.
- Tool names start with `board_` because they share the server with 30 other tools. Edits are batched in `board_edit` to keep the tool count down.
- The Studio and agents both write the file on disk under a lock. An agent's change reaches the open board by polling (every 700 ms), and undoing it replaces the whole board.

## Next, in rough order

1. **Released app.** The board tools reach agents once a release ships them: the installed app's MCP is the released one.
2. **Editing depth:**
   - align and distribute
   - resizing several layers at once
   - ⌥-hover distances
   - smart guides inside frames
   - styling a run of words (bold, italic, colour) from the panel
   - stacked fills and shadows with their own controls
   - a gradient editor
3. **Code out:** copy as JSX or Tailwind (Paper has Tailwind and React CSS). `board_read` gets a `jsx` view.
4. **Components:** a frame made reusable, with instances and overrides. Paper has none yet.
5. **Prototype mode:** click through artboards linked by layers, full screen.
6. **Comments** pinned to layers, which agents can read and resolve.
7. **Pen tool** and vector editing.
8. **Speed:** memoised layers for boards with thousands of layers.
