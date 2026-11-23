/**
 * The board every new account starts with: a walk through what the app is, how to use it and what's
 * coming. A lime cover with the way through, then a dark card for each thing to learn: the first six
 * over a real screenshot, the next ones showing the feature itself as live layers (shapes and stickers,
 * a shader under glass, a component with its copies and tokens), and a card for what's next. Agents'
 * sticky notes are stuck on some of them, the way agents leave notes on any board. It's all ordinary
 * layers, so the first thing to try is changing it.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { builtinSvg } from "../render/images.js";
import { shapeInBox } from "../render/shapes.js";
import { addHtmlOps, componentOps, htmlToNodes, instanceTree, newId, type Board, type BoardNode, type Op } from "./core.js";
import { defaultEffect } from "./effects.js";
import { adoptImages, changeBoard, createBoard } from "./store.js";

const here = path.dirname(fileURLToPath(import.meta.url));
/** The Studio's UI folder (its screenshots and icon), in a build (dist/studio/ui) or in the source. */
const UI = [path.join(here, "..", "studio", "ui"), path.join(here, "..", "..", "src", "studio", "ui")].find((p) => existsSync(path.join(p, "welcome"))) ?? "";

const FONT = "Geist, Inter, -apple-system, system-ui, sans-serif";
const MONO = "'Geist Mono', 'SF Mono', Menlo, monospace";
const CARD = "#121314";
const WELL = "#1b1c1e";
const INK = "#f4f4f2";
const BODY = "#c9c9c4";
const MUTE = "#8f8f8a";
const LIME = "#d7ff3f";
const LIME_INK = "#16190a";
const W = 560;
const H = 656;
const GAP = 64;
const ROW = H + 96;

const STEPS = [
  { n: "01", title: "Ask an agent for a design", shot: "agent" },
  { n: "02", title: "Draw it the way you know how", shot: "design" },
  { n: "03", title: "Comment where the work is", shot: "review" },
  { n: "04", title: "Start from what you have", shot: "import" },
  { n: "05", title: "Design together, live", shot: "team" },
  { n: "06", title: "Finish in your code", shot: "code" },
  { n: "07", title: "Shapes, stickers and notes", shot: "" },
  { n: "08", title: "Shaders and glass", shot: "" },
  { n: "09", title: "Components and tokens", shot: "" },
  { n: "10", title: "Preview it as a web page", shot: "" },
];
/** The card for what's next: after the cover and the steps. */
const NEXT = STEPS.length + 1;
const WELL_W = W - 20;
const WELL_H = Math.round(((W - 20) * 720) / 1152);

/** Where each card goes: rows of four, the cover first and what's next last. */
const at = (i: number) => ({ x: (i % 4) * (W + GAP), y: Math.floor(i / 4) * ROW });

const point = (text: string) =>
  `<div data-name="Point" style="display:flex;gap:10px;align-items:flex-start"><span data-name="Mark" style="width:6px;height:6px;margin-top:8px;border-radius:3px;background:${LIME};flex-shrink:0"></span><p data-name="Words" style="margin:0;font-size:14px;line-height:22px;color:${BODY}">${text}</p></div>`;

const keyChip = (keys: string, what: string) =>
  `<div data-name="Key" style="display:flex;align-items:center;gap:8px;height:30px;padding:0 10px 0 4px;border-radius:9px;background:${WELL}"><span data-name="Keys" style="display:flex;align-items:center;height:22px;padding:0 7px;border-radius:6px;background:#2a2b2e;font-size:12px;font-weight:600;color:${INK}">${keys}</span><span data-name="What" style="font-size:13px;color:${BODY}">${what}</span></div>`;

/** A card: the screenshot at the top in a rounded well, then its number, title, a line and what to do. */
const card = (i: number, step: (typeof STEPS)[number], lede: string, body: string, well?: string) => {
  const { x, y } = at(i);
  return `<div data-name="${step.n} · ${step.title}" style="left:${x}px;top:${y}px;width:${W}px;height:${H}px;display:flex;flex-direction:column;padding:10px;border-radius:22px;background:${CARD};font-family:${FONT};color:${INK};overflow:hidden">
    ${well ?? `<img data-name="Screenshot" src="${path.join(UI, "welcome", `${step.shot}.webp`)}" style="width:${WELL_W}px;height:${WELL_H}px;border-radius:12px;object-fit:cover;flex-shrink:0">`}
    <div data-name="Words" style="display:flex;flex-direction:column;gap:14px;padding:24px 22px 0">
      <span data-name="Number" style="font-size:13px;font-weight:600;color:${LIME};font-variant-numeric:tabular-nums">${step.n}</span>
      <h2 data-name="Title" style="margin:0;font-size:24px;line-height:28px;font-weight:600;letter-spacing:-0.02em;color:${INK}">${step.title}</h2>
      <p data-name="Lede" style="margin:0;font-size:14px;line-height:22px;color:${MUTE}">${lede}</p>
      ${body}
    </div>
  </div>`;
};

function cards(app: string): string[] {
  const [ask, draw, review, bring, together, code, shapes, shaders, components, preview] = STEPS;
  /** A well the size of a card's screenshot, for live layers placed by hand. */
  const well = (name: string, inner = "", extra = "") =>
    `<div data-name="${name}" ${extra} style="position:relative;width:${WELL_W}px;height:${WELL_H}px;border-radius:12px;background:${WELL};overflow:hidden;flex-shrink:0">${inner}</div>`;
  const label = (x: number, y: number, t: string) => `<span data-name="${t}" style="position:absolute;left:${x}px;top:${y}px;font-size:11px;font-weight:500;letter-spacing:0.02em;color:${MUTE}">${t}</span>`;
  const swatch = (x: number, token: string) =>
    `<div data-name="Token ${token}" style="position:absolute;left:${x}px;top:262px;display:flex;align-items:center;gap:8px"><div data-name="Swatch" style="width:22px;height:22px;border-radius:7px;background:var(--${token});box-shadow:inset 0 0 0 1px rgba(255,255,255,0.12)"></div><span data-name="Name" style="font-family:${MONO};font-size:12px;color:${BODY}">--${token}</span></div>`;
  const cover = `<div data-name="Start here" style="left:0px;top:0px;width:${W}px;height:${H}px;display:flex;flex-direction:column;justify-content:space-between;padding:44px 44px 40px;border-radius:22px;background:${LIME};font-family:${FONT};color:${LIME_INK}">
    <div data-name="Heading" style="display:flex;flex-direction:column;gap:18px">
      <img data-name="Icon" src="${path.join(UI, "icon.svg")}" style="width:44px;height:44px;border-radius:11px">
      <h1 data-name="Title" style="margin:0;font-size:44px;line-height:46px;font-weight:600;letter-spacing:-0.035em">Welcome to ${app}</h1>
      <p data-name="Lede" style="margin:0;font-size:16px;line-height:24px;color:rgba(22,25,10,0.72)">The design canvas you share with your team and your coding agents. Here's the way around, one card at a time.</p>
    </div>
    <div data-name="The way through" style="display:flex;flex-direction:column">${[...STEPS.map((s) => [s.n, s.title]), ["+", "What's coming"]]
      .map(([n, t]) => `<div data-name="${t}" style="display:flex;align-items:center;gap:16px;height:33px;box-shadow:inset 0 -1px 0 rgba(22,25,10,0.14)"><span data-name="Number" style="width:22px;font-size:13px;font-weight:600;font-variant-numeric:tabular-nums;color:rgba(22,25,10,0.55)">${n}</span><span data-name="Title" style="font-size:14px;font-weight:500">${t}</span></div>`)
      .join("")}</div>
    <p data-name="Yours" style="margin:0;font-size:13px;line-height:20px;color:rgba(22,25,10,0.62)">This board is yours. Change anything on it, or ask an agent to.</p>
  </div>`;
  const { x: nx, y: ny } = at(NEXT);
  const next = `<div data-name="What's coming" style="left:${nx}px;top:${ny}px;width:${W}px;height:${H}px;display:flex;flex-direction:column;justify-content:space-between;padding:44px 44px 40px;border-radius:22px;background:${CARD};font-family:${FONT};color:${INK}">
    <div data-name="Heading" style="display:flex;flex-direction:column;gap:14px">
      <span data-name="Number" style="font-size:13px;font-weight:600;color:${LIME}">Next</span>
      <h2 data-name="Title" style="margin:0;font-size:32px;line-height:36px;font-weight:600;letter-spacing:-0.03em">What's coming</h2>
      <p data-name="Lede" style="margin:0;font-size:14px;line-height:22px;color:${MUTE}">What we're building now, roughly in this order.</p>
    </div>
    <div data-name="Roadmap" style="display:flex;flex-direction:column">${[
      ["Selection and snapping", "Move, nest and space layers the way you expect"],
      ["Prototypes", "Click through your artboards, full screen"],
      ["React and Tailwind", "Copy any layer as a component"],
      ["Variants", "Component variants and properties"],
      ["Pen tool", "Draw paths, and edit their points"],
    ]
      .map(([t, d]) => `<div data-name="${t}" style="display:flex;flex-direction:column;gap:2px;padding:14px 0;box-shadow:inset 0 1px 0 rgba(255,255,255,0.08)"><span data-name="What" style="font-size:15px;font-weight:500;color:${INK}">${t}</span><span data-name="Detail" style="font-size:13px;line-height:20px;color:${MUTE}">${d}</span></div>`)
      .join("")}</div>
    <p data-name="Yours" style="margin:0;font-size:13px;line-height:20px;color:${MUTE}">You can delete this board whenever you like.</p>
  </div>`;
  return [
    cover,
    card(
      1,
      ask,
      `${app} works with the coding agents on your Mac: Claude Code, Codex, opencode and Antigravity, each with its own account.`,
      point("Open the chat with the spark button under the canvas, and pick an agent.") +
        `<div data-name="Try this prompt" style="display:flex;flex-direction:column;gap:6px;padding:14px 16px;border-radius:12px;background:${WELL}"><span data-name="Label" style="font-size:12px;color:${MUTE}">Try this prompt</span><p data-name="Prompt" style="margin:0;font-family:${MONO};font-size:13px;line-height:20px;color:${INK}">A sign-up screen for an iPhone app called Fern, for people who keep houseplants. Calm and warm, with one clear button.</p></div>`,
    ),
    card(
      2,
      draw,
      "Frames, auto layout, grids, components and tokens. Every layer has a name, and nothing on a board is a flat picture.",
      `<div data-name="Keys" style="display:flex;flex-wrap:wrap;gap:8px">${keyChip("F", "Frame")}${keyChip("R", "Rectangle")}${keyChip("T", "Text")}${keyChip("⇧A", "Auto layout")}${keyChip("C", "Comment")}${keyChip("⌘D", "Duplicate")}${keyChip("Space", "Pan")}${keyChip("⇧1", "Fit")}</div>`,
    ),
    card(
      3,
      review,
      "Pin a comment to any layer and send it to the agent that made it. It answers in the thread and makes the change.",
      point("Press C and click a layer to comment.") + point("Agents leave sticky notes, like the one on this card, to say what they're doing. Move them, change them, or delete them."),
    ),
    card(4, bring, "Bring in a live website or a Figma file, as layers you can change.", point("File › Import Website… (⇧⌘I), or paste a link onto the canvas.") + point("File › Import from Figma… (⇧⌘F): a .fig file, or a frame's link.")),
    card(5, together, "Put a board in a team and everyone edits it at once. You see each other's cursors, and each other's agents.", point("Start a team from Home, and invite people by email.") + point("Share, on any board, moves it into a team.")),
    card(6, code, "When a design is right, take it into your project.", point("Select a layer and open Code to copy its HTML and CSS.") + point("Or ask your agent to build it: it reads this board with the same tools it designs with.")),
    card(
      7,
      shapes,
      "Everything in this card is a real layer from the Assets panel: badges, ribbons, laurels, ratings, arrows and stickers. Sticky notes like the one on it come from there too.",
      point("Select one and change its words or colours on the right.") + point("Drag more in from Assets, on the left."),
      well("Shapes"),
    ),
    card(
      8,
      shaders,
      "Give any frame a live shader as its fill, drawn on the graphics card, and lay frosted glass over it.",
      point("Select the frame behind the glass, then pick another shader or change its colours in Fill.") + point("Effects adds glass, blur, grain and more to any layer."),
      well(
        "Shader",
        `<div data-name="Glass" style="position:absolute;left:130px;top:94px;width:280px;height:150px;display:flex;flex-direction:column;justify-content:center;gap:6px;padding:0 26px;border-radius:20px;background:rgba(255,255,255,0.08);box-shadow:inset 0 0 0 1px rgba(255,255,255,0.22)"><span data-name="Title" style="font-size:20px;font-weight:600;letter-spacing:-0.02em;color:#ffffff">Glass over a shader</span><span data-name="Sub" style="font-size:13px;line-height:19px;color:rgba(255,255,255,0.78)">Both are live. Select one and change it.</span></div>`,
        'data-shader="mesh-gradient"',
      ),
    ),
    card(
      9,
      components,
      "Make a layer a component and place copies of it. Change the main one and every copy follows; tokens hold colours by name.",
      point("Change the main button's corners or padding, and watch the copies.") + point("Change --brand in the Design panel's Tokens, and every layer using it changes."),
      well(
        "Components",
        label(32, 28, "MAIN COMPONENT") +
          label(278, 28, "COPIES") +
          `<div data-name="Button" style="position:absolute;left:32px;top:52px;display:flex;align-items:center;height:44px;padding:0 20px;border-radius:12px;background:var(--brand)"><span data-name="Label" style="font-size:15px;font-weight:600;white-space:nowrap;color:var(--brand-ink)">Get started</span></div>` +
          `<div data-name="Divider" style="position:absolute;left:32px;top:238px;width:476px;height:1px;background:rgba(255,255,255,0.08)"></div>` +
          swatch(32, "brand") +
          swatch(196, "brand-ink"),
      ),
    ),
    card(
      10,
      preview,
      "Press ▶ in the top bar to open a frame as a real web page in your browser, at its real size.",
      point("Narrow the window to see the design reflow.") + point("Export saves any layer as a PNG or JPEG, at any scale."),
      well(
        "Browser",
        `<div data-name="Window" style="position:absolute;left:26px;top:24px;width:488px;height:290px;display:flex;flex-direction:column;border-radius:12px;background:#2a2b2e;overflow:hidden;box-shadow:0 18px 40px rgba(0,0,0,0.45)"><div data-name="Bar" style="display:flex;align-items:center;gap:6px;height:30px;padding:0 12px;flex-shrink:0"><div data-name="Close" style="width:10px;height:10px;border-radius:5px;background:#ff5f57"></div><div data-name="Minimise" style="width:10px;height:10px;border-radius:5px;background:#febc2e"></div><div data-name="Zoom" style="width:10px;height:10px;border-radius:5px;background:#28c840"></div><div data-name="Address" style="margin-left:54px;display:flex;align-items:center;justify-content:center;width:240px;height:18px;border-radius:6px;background:#1c1d1f;font-size:10px;color:${MUTE}">Fern · Landing: desktop</div></div><img data-name="Page" src="${path.join(UI, "welcome", "page.webp")}" style="width:488px;height:260px;object-fit:cover;object-position:top;flex-shrink:0"></div>`,
      ),
    ),
    next,
  ];
}

/** A sticky note on the page, stuck over a card's top right corner. */
function note(card: number, text: string, caption: string, fill: string, attach: "tape" | "pin", seed: number): BoardNode {
  const { x, y } = at(card);
  const shape = { type: "note", text, caption, fill, labelColor: "#2b2719", attach, curl: true, seed };
  return { id: newId(), type: "svg", name: "Sticky note", parent: null, shape, svg: shapeInBox(shape as never, 210, 210), style: { left: `${x + W - 150}px`, top: `${y - 56}px`, width: "210px", height: "210px" } };
}

/** A shape layer placed by hand in a well. */
function shapeIn(parent: string, name: string, x: number, y: number, w: number, h: number, shape: Record<string, unknown>): BoardNode {
  return { id: newId(), type: "svg", name, parent, shape, svg: shapeInBox(shape as never, w, h), style: { position: "absolute", left: `${x}px`, top: `${y}px`, width: `${w}px`, height: `${h}px` } };
}

/** One of the built-in stickers, with its die-cut white edge, placed in a well. */
function stickerIn(parent: string, name: string, x: number, y: number, size: number): Record<string, BoardNode> {
  const got = builtinSvg(`sticker:${name}`);
  if (!got) return {};
  const made = htmlToNodes(got.svg, { wholeSvg: true });
  const root = made.nodes[made.roots[0]];
  root.parent = parent;
  root.name = `Sticker ${name}`;
  root.style = {
    position: "absolute",
    left: `${x}px`,
    top: `${y}px`,
    width: `${size}px`,
    height: `${size}px`,
    filter: "drop-shadow(2px 0 0 #fff) drop-shadow(-2px 0 0 #fff) drop-shadow(0 2px 0 #fff) drop-shadow(0 -2px 0 #fff) drop-shadow(0 6px 10px rgba(0,0,0,0.3))",
  };
  return made.nodes;
}

const add = (nodes: Record<string, BoardNode>, parent: string | null): Op => ({ op: "add", nodes, ids: Object.values(nodes).filter((n) => n.parent === parent).map((n) => n.id), parent });
const named = (b: Board, name: string) => Object.values(b.nodes).find((n) => n.name === name);

/** The live layers HTML can't say: shapes and stickers, the glass, tokens, and the button made a component. */
function liveOps(b: Board): Op[] {
  const ops: Op[] = [
    { op: "token", name: "--brand", value: LIME },
    { op: "token", name: "--brand-ink", value: LIME_INK },
  ];
  const shapes = named(b, "Shapes");
  if (shapes) {
    const id = shapes.id;
    const list = [
      shapeIn(id, "Burst", 28, 26, 108, 108, { type: "burst", fill: LIME, text: "NEW", labelColor: LIME_INK }),
      shapeIn(id, "Ribbon", 156, 36, 200, 48, { type: "ribbon", fill: "#ffd60a", text: "Try it free", labelColor: "#1d1d1f" }),
      shapeIn(id, "Laurel", 150, 112, 230, 92, { type: "laurel", fill: "#e9c46a", text: "App of the Day" }),
      shapeIn(id, "Drawn arrow", 52, 146, 96, 76, { type: "arrow", stroke: "#ff6b5f", strokeWidth: 4, head: "end", bend: 0.35, sketch: true, from: { x: 0.15, y: 0.15 }, to: { x: 0.88, y: 0.8 } }),
      shapeIn(id, "Number 1", 262, 246, 38, 38, { type: "badge", fill: "#ff3b30", stroke: "#ffffff", strokeWidth: 3, label: "1", labelColor: "#ffffff" }),
      shapeIn(id, "Number 2", 306, 246, 38, 38, { type: "badge", fill: "#0a84ff", stroke: "#ffffff", strokeWidth: 3, label: "2", labelColor: "#ffffff" }),
      shapeIn(id, "Rating", 366, 240, 150, 50, { type: "rating", fill: "#ffd60a", value: 5, text: "4.9 · 2K ratings" }),
    ];
    ops.push(add(Object.fromEntries(list.map((n) => [n.id, n])), id));
    for (const [name, x, y, size] of [["rocket", 30, 232, 68], ["heart", 110, 240, 56], ["sparkles", 180, 234, 62]] as const) {
      const nodes = stickerIn(id, name, x, y, size);
      if (Object.keys(nodes).length) ops.push(add(nodes, id));
    }
  }
  const glass = named(b, "Glass");
  if (glass) ops.push({ op: "set", id: glass.id, effects: [defaultEffect("glass")] });
  const button = named(b, "Button");
  if (button) ops.push(...componentOps(b, button.id));
  return ops;
}

/** Copies of the main button, each with its own words. */
function copyOps(b: Board): Op[] {
  const button = named(b, "Button");
  const well = named(b, "Components");
  if (!button?.isComponent || !well) return [];
  const ops: Op[] = [];
  for (const [i, words] of ["Download for Mac", "Start a team", "Sign up"].entries()) {
    const t = instanceTree(b, button.id, well.id);
    const root = t.nodes[t.id];
    root.style = { ...root.style, position: "absolute", left: "278px", top: `${52 + i * 60}px` };
    const label = Object.values(t.nodes).find((n) => n.type === "text");
    if (label) label.text = words;
    ops.push({ op: "add", nodes: t.nodes, ids: [t.id], parent: well.id });
  }
  return ops;
}

/** Makes the welcome board and returns it. */
export function createWelcomeBoard(appName = "Glassine") {
  let board = createBoard(`Welcome to ${appName}`, "studio");
  const page = board.pages[0].id;
  const ops: Op[] = [];
  for (const html of cards(appName)) {
    const made = addHtmlOps(html, null, { page });
    // The screenshots are copied into the library, so the board keeps them wherever the app goes.
    adoptImages(made.nodes);
    ops.push(...made.ops);
  }
  // Agents' notes, stuck on: the real thing, as an agent leaves on any board.
  const notes = [
    note(1, "Try the prompt below. I'll design it right here, on this board.", "Claude Code", "#ffe682", "tape", 3),
    note(3, "Comment on anything I make, and I'll fix it.", "Codex", "#ffc2c2", "pin", 4),
    note(7, "Select any of these and change it. They're all real layers.", "Claude Code", "#bfeaa3", "tape", 2),
    note(NEXT, "What should we build first? Tell us.", `The ${appName} team`, "#b0d8ff", "tape", 6),
  ];
  for (const n of notes) ops.push({ op: "add", nodes: { [n.id]: n }, ids: [n.id], parent: null, page });
  board = changeBoard(board.id, ops, "studio").board;
  board = changeBoard(board.id, liveOps(board), "studio").board;
  board = changeBoard(board.id, copyOps(board), "studio").board;
  return board;
}
