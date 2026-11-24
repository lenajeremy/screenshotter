# Selection, dragging and spacing: plan

Asked 2026-11-23: make clicking, dragging and dropping layers easy to understand, after Paper
(app.paper.design). Copy how Paper behaves, not how it looks (Glassine keeps its own style).

## How Paper behaves (studied in its web app, file "Paper tour (scratch)")

| Action | Paper |
| --- | --- |
| Click on a deep layer | selects the outermost layer inside the artboard |
| Click again on it | stays (doesn't go deeper) |
| Double-click | one level deeper (card → its button row), never straight to the deepest |
| Double-click a selected text | edits its words |
| Click once inside a frame (a child selected) | selects at that level: siblings directly |
| Click empty artboard space | selects nothing; an artboard is picked by its name label |
| Press and drag a layer not selected | selects it and moves it, one gesture |
| Drop over a frame nested inside a flex frame | goes into the nested frame (deepest frame under the pointer), at the slot under the pointer |
| Drop on a frame laid out by hand | becomes its child where dropped |
| Drop off every artboard | becomes a layer of its own on the page |
| Leaving a flex frame | a Fill width becomes the fixed width it had, so it looks the same |
| Entering a flex frame | joins the flow (its position is dropped), keeps its own size |
| Selected flex frame | padding handles (short blue bars mid-side), gap handles (short pink bars between children), dashed distances to the parent's edges, size label "320 × Fit 287" |
| Resizing / moving | red guides with end marks when an edge or centre lines up |

## What Glassine does today (src/studio/ui/board-canvas.js)

- `pickFor`: first click picks the layer on the artboard, then keeps to the level being worked at;
  ⌘-click picks the deepest. (Matches Paper.) A click on an artboard's own background selects it.
- `dblclick`: straight to the deepest layer (and into its words). Paper goes one level at a time.
- `moveLayers` → `reorder` for one layer in flow: looks for another frame only once the pointer is
  outside its own parent, so a frame nested in the same flex frame can't take it; over empty canvas
  it stays put. Free layers (absolute, or loose on a page) are moved, never re-parented.
- Leaving flow doesn't freeze a Fill size; entering flow doesn't clear left/top/position.
- Snapping: one free layer, to its parent's edges and centre and its siblings' edges.
- No padding or gap handles on the canvas.

## Plan

1. Double-click one level deeper (a selected text: edit it). ⌘-click and ⌘-double-click stay deepest.
2. One drag for every layer, in flow or free, one or many: each move finds the drop target, the
   deepest frame under the pointer (not the dragged layers, not inside a component copy, not locked),
   or the page. Flex or grid target: the slot line. Frame laid out by hand: placed where dropped,
   keeping the grab offset. Page: a layer of its own. Same free parent: moved, with snapping.
   Artboards (top-level frames) are only moved, never nested.
3. Sizes survive the move: leaving flow, a size the layout gave (fill, stretch, %) becomes px;
   entering flow, position/left/top go. Grid placement goes when leaving a grid (leaveGridOps).
4. Snapping and guides: siblings' and parent's edges and centres, guides with the distance.
5. Spacing handles on a selected flex frame: drag padding (⌥ both sides) and the gap, with the value
   shown while dragging.
6. UI checks for each, then the app rebuilt and installed.

## Done (2026-11-23)

- 1, 2 and 3 (commit 507cd1d). Decisions made on the way:
  - Nearly every Glassine frame is a flex column (block divs and the frame tool both make them), so
    "a frame laid out by hand" means one whose layers are all placed by hand (most artboards): it
    takes a drop where it's dropped; a frame whose layers flow, or an empty one, takes it into its flow.
  - A frame beside the dragged layer in the same flex/grid frame takes it only after a 380 ms rest over
    its middle (edges: beside it), so dragging along a row reorders instead of nesting.
  - Double-click: one level deeper for frames, but straight into words on text (the earlier "reach deep
    layers" fix, d5c8aad, was for that); ⌘ still deepest.
  - Artboards (top-level frames) go into another frame only if they fit in it.
  - ⌥ while dragging keeps a layer in its frame.
- 5 (commit 671fb38): pink padding and gap handles on a selected flex frame, drawn under the resize
  handles; value shown on hover and while dragging.

## Done (2026-11-24)

- Paper-parity hover, nested navigation, drag/drop, guides & spacing polish:
  - Ancestor-scope picking (`pickFor`): every artboard root and every ancestor of the current selection is an open container, so siblings and ancestors' siblings (uncles) are directly hoverable and clickable in one click, while clicking inside a selected frame keeps it targeted for dragging.
  - Hovering a container frame shows dashed outlines of its direct visible children; selecting a nested layer shows a dashed scope outline around its immediate nested parent; selecting a free child shows subtle dashed pin lines to its parent's anchored edges.
  - Empty background inside a populated artboard doesn't flash a hover ring and deselects on click (dragging still marquee-selects children); artboards are picked by their title label (empty 0-child frames still select on click).
  - Selection chrome refined to 4 crisp corner squares + 4 full-edge transparent resize strips, keeping small layers and padding handles uncluttered.
  - `Shift+Enter` selects parent(s); `Enter` enters visible unlocked children of selected container(s); `Tab`/`Shift+Tab` skips hidden siblings; `Escape` cancels any in-progress drag cleanly.
  - Unclipped floating overlay ghosts (`.bd-ghost`) replace `el.style.translate`, with target-container name badges (`.bd-drop-tag`) and gap-centered flex insertion lines (suppressing no-op markers).
  - Bounded smart snapping guides with anchor dots, equal-spacing snapping with twin distance pills, and live neighbour distances — working on both same-parent moves, cross-frame free drops, and resizing.
  - Multi-layer drops into grid frames append cleanly into flow cells.
  - `⌥` measurement upgraded with dashed alignment extension lines and edge offsets for side-by-side / stacked layers.
  - Refined blue padding & pink gap handles with smaller minimum threshold (8px) and multi-side highlighting for `⌥`/`⇧` drags.
