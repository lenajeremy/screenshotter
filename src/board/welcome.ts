/**
 * The board every new account starts with: a walk through what the app is, how to use it and what's
 * coming, laid out as numbered columns on one sheet (after Paper's welcome file). Each column is one
 * thing to learn, with real screenshots of the app, a prompt to try and a tip. It's made of ordinary
 * layers, so the first thing to try is changing it.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { shapeInBox } from "../render/shapes.js";
import { addHtmlOps, newId, type BoardNode } from "./core.js";
import { adoptImages, changeBoard, createBoard } from "./store.js";

const here = path.dirname(fileURLToPath(import.meta.url));
/** The screenshots, beside the Studio's UI in a build (dist/studio/ui/welcome) and in the source. */
const ART = [path.join(here, "..", "studio", "ui", "welcome"), path.join(here, "..", "..", "src", "studio", "ui", "welcome")].find((p) => existsSync(p)) ?? "";

const FONT = "Inter, -apple-system, 'SF Pro Text', system-ui, sans-serif";
const MONO = "'SF Mono', Menlo, monospace";
const INK = "#121211";
const BODY = "#3b3b37";
const MUTE = "#6e6e68";
const SHEET = "#8c8c88";
const CARD = "#f7f7f5";
const LINE = "#e4e3de";
const COL = 400;
const INNER = COL - 64;

/** A screenshot of the app, `h` tall at the column's width. */
const shot = (file: string, h: number, alt: string) =>
  `<img data-name="${alt}" src="${path.join(ART, `${file}.webp`)}" style="width:${INNER}px;height:${h}px;border-radius:10px;object-fit:cover;box-shadow:0 0 0 1px rgba(0,0,0,0.08), 0 1px 2px rgba(0,0,0,0.06)">`;

/** A numbered step: its number in a small black square, then what to do, then (if any) its picture. */
const step = (n: number, text: string, extra = "") =>
  `<div data-name="Step ${n}" style="display:flex;flex-direction:column;gap:12px">
    <div data-name="Number" style="display:flex;align-items:center;justify-content:center;width:18px;height:18px;border-radius:4px;background:${INK};color:#ffffff;font-size:10px;font-weight:600">${n}</div>
    <p data-name="What to do" style="margin:0;font-size:13px;line-height:20px;color:${BODY}">${text}</p>
    ${extra}
  </div>`;

/** A white card: a prompt to try, or a tip. */
const card = (label: string, text: string, mono = false) =>
  `<div data-name="${label}" style="display:flex;flex-direction:column;gap:10px;padding:18px;border-radius:10px;background:#ffffff;box-shadow:0 0 0 1px ${LINE}">
    <span data-name="Label" style="font-size:13px;font-weight:600;color:${INK}">${label}</span>
    <p data-name="Words" style="margin:0;font-family:${mono ? MONO : FONT};font-size:${mono ? 12 : 13}px;line-height:${mono ? 19 : 20}px;color:${BODY}">${text}</p>
  </div>`;

const key = (k: string) =>
  `<span data-name="Key ${k}" style="display:flex;align-items:center;justify-content:center;min-width:24px;height:24px;padding:0 6px;border-radius:6px;background:#ffffff;box-shadow:0 0 0 1px ${LINE}, 0 1px 0 ${LINE};font-size:11px;font-weight:600;color:${INK}">${k}</span>`;
const shortcut = (keys: string[], what: string) =>
  `<div data-name="Shortcut" style="display:flex;align-items:center;justify-content:space-between;height:38px;box-shadow:inset 0 1px 0 ${LINE}"><span data-name="What" style="font-size:13px;color:${BODY}">${what}</span><div data-name="Keys" style="display:flex;gap:4px">${keys.map(key).join("")}</div></div>`;

/** One column: its number above it on the sheet, then the card with its letter, title, lede and steps. */
const column = (n: string, letter: string, title: string, lede: string, body: string) =>
  `<div data-name="${n} · ${title}" style="display:flex;flex-direction:column;gap:12px;width:${COL}px;flex-shrink:0">
    <span data-name="Number" style="font-size:13px;color:rgba(255,255,255,0.78)">${n}</span>
    <div data-name="Card" style="display:flex;flex-direction:column;gap:28px;padding:36px 32px 44px;background-color:${CARD};background-image:linear-gradient(rgba(0,0,0,0.035) 1px, transparent 1px), linear-gradient(90deg, rgba(0,0,0,0.035) 1px, transparent 1px);background-size:24px 24px">
      <div data-name="Heading" style="display:flex;flex-direction:column;gap:12px">
        <span data-name="Letter" style="font-size:24px;line-height:28px;font-weight:600;color:${INK}">${letter}</span>
        <h2 data-name="Title" style="margin:0;font-size:16px;line-height:22px;font-weight:600;letter-spacing:-0.01em;color:${INK}">${title}</h2>
        <p data-name="Lede" style="margin:0;font-size:13px;line-height:20px;color:${MUTE}">${lede}</p>
      </div>
      ${body}
    </div>
  </div>`;

function sheet(app: string): string {
  const columns = [
    column(
      "1",
      "A",
      "Design with your agent",
      `${app} works with the coding agents already on your Mac: Claude Code, Codex, opencode, Antigravity, or any agent that speaks MCP. They use their own accounts.`,
      step(1, "Open the chat with the spark button at the bottom of the canvas, and pick an agent.", shot("chat", 579, "The agent's chat")) +
        step(2, "Describe what you want, in your own words.", card("Try this prompt", "Design a sign-up screen for an iPhone app called Fern, for people who keep houseplants. Calm and warm, easy to read, with one clear button.", true)) +
        step(3, "It designs on this board while you watch. Follow its cursor, and undo any step it took.", shot("follow", 176, "Following an agent")) +
        card("Tip", "Select a layer before you ask, and the agent changes only that layer."),
    ),
    column(
      "2",
      "B",
      "Draw it yourself",
      "Frames, auto layout, grids, components and tokens, as in the design tool you know. Every layer has a name, and nothing on a board is a flat picture.",
      step(1, "Select a layer to change its size, layout, fill and type in the Design panel on the right.", shot("design", 324, "The Design panel")) +
        step(
          2,
          "The keys worth knowing:",
          `<div data-name="Shortcuts" style="display:flex;flex-direction:column">${shortcut(["V"], "Move and select")}${shortcut(["F"], "Draw a frame")}${shortcut(["R"], "Rectangle")}${shortcut(["T"], "Text")}${shortcut(["C"], "Comment")}${shortcut(["Space"], "Pan the canvas")}${shortcut(["⇧", "A"], "Auto layout")}${shortcut(["⌘", "D"], "Duplicate")}${shortcut(["⇧", "1"], "Fit the page")}${shortcut(["⌘", "Z"], "Undo")}</div>`,
        ),
    ),
    column(
      "3",
      "C",
      "Review it where it is",
      "Comments sit on the layers they're about. Send them to the agent that made the work: it answers in the thread and makes the change.",
      step(1, "Press C, click a layer, and write.", shot("review", 277, "A comment and the agent's answer")) +
        step(2, "Agents leave sticky notes beside their work to say what they're doing. A note is a layer: move it, change it, or delete it.", `<div data-name="Note slot" style="display:flex;justify-content:center;padding:8px 0 4px"></div>`),
    ),
    column(
      "4",
      "D",
      "Bring what you have",
      "Start from a live website or a Figma file. Either comes in as layers you can change.",
      step(1, "File › Import Website… (⇧⌘I), or paste a link onto the canvas.", shot("import", 250, "Importing a website")) +
        step(2, "File › Import from Figma… (⇧⌘F) takes a .fig file (in Figma, File › Save local copy) or a frame's link.") +
        card("Tip", "Only bring in sites and files you have the right to use."),
    ),
    column(
      "5",
      "E",
      "Design together",
      "Boards in a team are edited together, live. You see each other's cursors, and each other's agents at work.",
      step(1, "Start a team from Home and invite people by email.", shot("team", 371, "Sharing a board with a team")) + step(2, "Share, on any board, puts it in a team. Anyone on the team can edit it."),
    ),
    column(
      "6",
      "F",
      "Hand it to code",
      "When a design is right, take it into your project.",
      step(1, "Select a layer and open Code in the right panel to copy its HTML and CSS.", shot("code", 241, "The Code tab")) +
        step(2, "Or ask your coding agent to build it: it reads this board with the same tools it designs with."),
    ),
    column(
      "+",
      "+",
      "What's next",
      "What we're working on now:",
      `<div data-name="Roadmap" style="display:flex;flex-direction:column;gap:12px">${[
        "Selection, snapping and spacing that work the way you expect",
        "Prototypes: click through your artboards, full screen",
        "Copy as React or Tailwind",
        "Component variants and properties",
        "A pen tool, for drawing and editing paths",
      ]
        .map((t) => `<p data-name="Item" style="margin:0;font-size:13px;line-height:20px;color:${BODY}">– ${t}</p>`)
        .join("")}</div>
      <p data-name="Yours" style="margin:0;font-size:13px;line-height:20px;color:${MUTE}">This board is yours to keep, change or delete.</p>`,
    ),
  ];
  return `<div data-name="Welcome to ${app}" style="left:0px;top:0px;width:${COL * 7 + 24 * 6 + 128}px;height:fit-content;display:flex;flex-direction:column;gap:48px;padding:64px 64px 80px;background:${SHEET};font-family:${FONT};color:${INK}">
    <h1 data-name="Title" style="margin:0;font-size:40px;line-height:46px;font-weight:500;letter-spacing:-0.025em;color:#ffffff">Welcome to ${app}<br><span style="color:rgba(255,255,255,0.66)">This board is yours. Change anything on it, or ask an agent to.</span></h1>
    <div data-name="Columns" style="display:flex;align-items:flex-start;gap:24px">${columns.join("")}</div>
  </div>`;
}

/** Makes the welcome board and returns it. */
export function createWelcomeBoard(appName = "Glassine") {
  let board = createBoard(`Welcome to ${appName}`, "studio");
  const made = addHtmlOps(sheet(appName), null, { page: board.pages[0].id });
  // The screenshots are copied into the library, so the board keeps them wherever the app goes.
  adoptImages(made.nodes);
  board = changeBoard(board.id, made.ops, "studio").board;
  // A sticky note from an agent, in its place in the review column: the real thing, not a picture of one.
  const slot = Object.values(board.nodes).find((n) => n.name === "Note slot");
  if (slot) {
    const id = newId();
    const shape = { type: "note", text: "Three hero variations below. B keeps the photo.", caption: "Claude Code", fill: "#ffe682", labelColor: "#2b2719", attach: "tape", curl: true, seed: 3 };
    const note: BoardNode = { id, type: "svg", name: "Sticky note", parent: slot.id, shape, svg: shapeInBox(shape as never, 220, 220), style: { width: "220px", height: "220px", flexShrink: "0" } };
    board = changeBoard(board.id, [{ op: "add", nodes: { [id]: note }, ids: [id], parent: slot.id, index: 0 }], "studio").board;
  }
  return board;
}
