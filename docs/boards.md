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
  - `board_comments`, `board_comment` (see Comments below)
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
  - Ten board checks in `npm run test:ui`, in Chromium and WebKit (drawing, picking, reordering, tools, agent changes, components, align and resize, assets and filters, paste, and two for tokens in the panel).

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
- **Since (that evening): tokens in the panel.** They always worked in drawing (on `.bd-world` in the Studio, on `:root` in exports); now the panel uses them too.
  - Every colour field and picker on a board (fills and gradient stops, border, outline, shadow, text, the selected words, a part's paint, a shape's fill and stroke, selection colours) lists the board's colour tokens as chips: a token whose value is a colour, or a `var()` that comes to one. Picking one writes `var(--name)`; picking a plain colour replaces it.
  - A field, a fill or shadow row and the selection colours show a token by its name, with its swatch resolved through the board's tokens (nested ones and fallbacks too), gradients included.
  - **Make a token** in the picker names the colour, adds the token and uses it, as one step of undo.
  - The token list counts the layers using each token; a click on the count selects them.
  - Only boards get this: `ColorButton` and `ColorPicker` (`controls.js`) take `tokens` and `onMakeToken` props, which the design editor doesn't pass.
- **Comments** (same day, `src/board/comments.ts`, `agentman.ts`, `studio/ui/board-comments.js`):
  - **Who worked on a board:** every change an agent makes through the MCP records it in `board.agents` (an `agent` step, like `working`: not part of the design, nothing to undo, no new revision): its Agentman session id, how that was found, its kind, its name, when, and its artboards.
  - **Finding the agent's session** (once per MCP server, which lives as long as its agent): walk up the process tree; an ancestor with `~/.claude/sessions/<pid>.json` (or under `CLAUDE_CONFIG_DIR`) is a Claude Code session, `claude:<sessionId>`. Else the tmux pane's name when Agentman runs the agent (`agentman-claude-<uuid>`, `agentman-codex-…`). Else the only agent of its kind Agentman lists in the MCP server's folder, marked as a guess (`how: "folder"`); with two there, none is picked. Agentman's own name for the session is used when it's running.
  - **Storage:** `<library>/.studio/boards/comments/<id>.json`, under its own lock, with a revision the Studio polls (`talk` in `/api/board/rev`). Threads have an anchor (a layer and the point on it clicked, or an artboard, a rect in its coordinates and the layers mostly inside it, with every name as it was), messages (the person's or an agent's), resolved, and for each of the person's messages who it went to and how that went (sending, delivered, queued, failed with why).
  - **Sending:** the Studio server saves the comment, answers, then sends `send_message` to each recipient's session over Agentman's socket (`~/.agentman/am.sock`; `SCREENSHOTTER_AGENTMAN_SOCKET` points elsewhere, which every test does). The message starts `(From Screenshotter)` and gives the board's name and id, the comment's id, what it's on (layer names and ids), the words, the thread so far for a reply, and how to answer (`board_comment`). Who it goes to: who was in the thread, else the agents that worked on its artboard, else the board's only agent (`defaultRecipients` in the core, used by both sides).
  - **Agents:** `board_comments` (open threads for me, or all, on one board or every one, with `waitingOnYou`) and `board_comment` (reply, resolve or reopen, or start a thread on a layer).
  - **Studio:** a comment tool (**C**): click pins to the layer under the pointer, drag comments on a region. Pins (the message count; a lime dot for an agent's unseen answer, amber for a message that didn't reach someone), a thread card by its pin (replies, resolve, delete, how each message was sent, **Try again**), **To** chips and an @ picker of the board's agents, a toast when an agent answers, and a **Comments** tab with the agents who worked on the board.
  - **Tests:** a stand-in Agentman (`scripts/fake-agentman.ts`) for `test:board` (finding the session from the process, delivery, refusals, Agentman not running, the tools) and two checks in `test:ui` (pin, send, reply, resolve; a region).
  - **Limits:** an agent started outside Agentman that isn't Claude Code, and shares its folder with another agent of its kind, can't be told apart (its comments say so). A Claude session Agentman didn't start gets messages only when its turn ends (Agentman's hook delivery, shown as "gets it when its turn ends"). Agentman refuses messages while the agent waits on a question; the comment says to answer it, then Try again.

- **Preview** (12 November): **Preview** in the top bar (⌥⌘P, or right-click) opens a frame as a web page in the browser (`GET /board/preview?board=…&node=…&w=…`, `previewDocument` in `render.ts`). The selected frame, or the frame round a selected leaf, or the page's first artboard. It takes its parents' inherited type and colour, fills the window when it's desktop-size (1024 px or wider), else keeps its designed width (`w`, measured on the canvas, when its own width isn't in px), never past the window, and polls `/api/board/rev` every second, swapping in the new frame when the board changes. In the app it opens in the default browser through `openURL`. Inline styles only, so no :hover or working inputs yet.
- **Comments, round two** (12 November, from the user's first use): an agent at work on a thread shows as "… is working on it" with moving dots, and a ring on the pin (the Studio asks Agentman for its agents' states every 2.5 s while a thread waits: `GET /api/board/agents`). @name stays in the words, marked, and can tag any agent Agentman runs (it joins the board's agents). Only the person resolves; agents reply. A resolved thread offers **Reopen**, not a second check mark. There's no To row and no default recipient: a comment reaches only the agents @-tagged in it (the user: "i just want to add a comment... if i tag an agent, i want it to respond").

- **Renaming tokens** (12 November): click a token's name in the list (or an agent's board_edit token with rename). `renameTokenOps` renames every `var()` using it, in layers' CSS, words, vector attributes and gradients, shapes and other tokens, as one step; the steps are the component's own (sync), so copies don't take them as their own changes.

**Decisions:**

- The design is HTML and CSS, not a vector format. The browser engine does the layout, the text and the drawing, an agent writes it fluently, and code comes out of it nearly as is.
- Tool names start with `board_` because they share the server with 30 other tools. Edits are batched in `board_edit` to keep the tool count down.
- The Studio and agents both write the file on disk under a lock. An agent's change reaches the open board by polling (every 700 ms), and undoing it replaces the whole board.
- Components: the Studio expands its own changes (so a change to a component shows in its copies straight away) and sends the result. The server expands only agents' changes, so nothing is expanded twice.
- An SVG's parts are layers, not one piece of markup, so they can be picked and changed one at a time (as in Paper). Parts can only sit in a vector and nothing else can go in one; one with more than 800 parts stays one piece.
- Only the person resolves a comment: they asked, so they say when it's done (the user's call, 12 November).
- Blue is for selection only, as in the rest of the Studio; everything else on boards is neutral. On 11 November the user compared lime for selection and chose blue (lime is hard to see on light designs and already marks agent work).

## Next, in rough order

1. **Released app.** The board tools reach agents once a release ships them: the installed app's MCP is the released one.
2. **Comments, next:** mentions of other agents by an agent, editing a sent message, and comments in exports or the device frame.
3. **Code out:** copy as JSX or Tailwind (Paper has Tailwind and React CSS). `board_read` gets a `jsx` view.
4. **Prototype mode:** click through artboards linked by layers, full screen.
5. **More editing:**
   - smart guides inside frames
   - component variants and properties
   - per-fill visibility
6. **Pen tool**: drawing paths, and editing a path's points.
7. **Speed:** memoised layers for boards with thousands of layers.
