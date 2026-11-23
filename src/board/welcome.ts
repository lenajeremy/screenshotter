/**
 * The board every new account starts with: four artboards that say what Glassine is and how to
 * use it, made of the same layers as any design, so the first thing to try is changing them.
 */
import { addHtmlOps } from "./core.js";
import { changeBoard, createBoard } from "./store.js";

const FONT = "Inter, -apple-system, 'SF Pro Text', system-ui, sans-serif";
const INK = "#141412";
const MUTE = "#6b6b63";
const PAPER = "#fbfaf7";
const LIME = "#d7ff3f";

const key = (k: string) => `<span data-name="Key ${k}" style="display:flex;align-items:center;justify-content:center;min-width:26px;height:26px;padding:0 7px;border-radius:7px;background:#fff;box-shadow:0 0 0 1px #dedbd1, 0 1px 0 #dedbd1;font-size:12px;font-weight:600;color:${INK}">${k}</span>`;

const row = (keys: string[], what: string) =>
  `<div data-name="Shortcut" style="display:flex;align-items:center;justify-content:space-between;height:44px;border-top:1px solid #e9e6dc"><span data-name="What" style="font-size:15px;color:${INK}">${what}</span><div data-name="Keys" style="display:flex;gap:6px">${keys.map(key).join("")}</div></div>`;

const step = (n: number, title: string, text: string) =>
  `<div data-name="Step ${n}" style="display:flex;flex-direction:column;gap:10px;padding:22px;border-radius:16px;background:#fff;box-shadow:0 0 0 1px #e9e6dc"><span data-name="Number" style="display:flex;align-items:center;justify-content:center;width:28px;height:28px;border-radius:999px;background:${INK};color:#fff;font-size:13px;font-weight:600">${n}</span><span data-name="Title" style="font-size:17px;font-weight:600;letter-spacing:-0.01em;color:${INK}">${title}</span><span data-name="Text" style="font-size:14px;line-height:21px;color:${MUTE}">${text}</span></div>`;

const page = (name: string, x: number, eyebrow: string, title: string, lede: string, body: string) =>
  `<div data-name="${name}" style="left:${x}px;top:0px;width:960px;height:640px;display:flex;flex-direction:column;gap:28px;padding:56px 64px;background:${PAPER};font-family:${FONT};color:${INK}">
    <div data-name="Heading" style="display:flex;flex-direction:column;gap:12px">
      <span data-name="Eyebrow" style="align-self:flex-start;padding:4px 10px;border-radius:999px;background:${LIME};font-size:12px;font-weight:600;color:#16190a">${eyebrow}</span>
      <h1 data-name="Title" style="margin:0;font-size:44px;line-height:48px;font-weight:700;letter-spacing:-0.03em">${title}</h1>
      <p data-name="Lede" style="margin:0;width:620px;font-size:17px;line-height:26px;color:${MUTE}">${lede}</p>
    </div>
    ${body}
  </div>`;

function artboards(): string[] {
  return [
    page(
      "1 · Welcome",
      0,
      "Start here",
      "Welcome to Glassine",
      "A canvas where you, your team and your agents design together. Everything on it is real HTML and CSS, so what you design is what gets built.",
      `<div data-name="Steps" style="display:grid;grid-template-columns:repeat(3,1fr);gap:16px">${step(1, "Ask an agent", "Open the chat and describe a screen. It lands here as layers you can change.")}${step(2, "Change anything", "Click a layer and edit it in the Design panel, or drag it on the canvas.")}${step(3, "Share it", "Move a board into a team and design in it together, live.")}</div>`,
    ),
    page(
      "2 · Design with an agent",
      1040,
      "Agents",
      "Say what you want",
      "Glassine works with the coding agents already on your Mac. Select a layer first and the agent changes that layer; select nothing and it designs something new.",
      `<div data-name="Prompts" style="display:flex;flex-direction:column;gap:10px">${["A sign-up screen for an iPhone app", "Make this hero feel calmer", "Three colour directions for this page, side by side"].map((t) => `<div data-name="Prompt" style="display:flex;align-items:center;height:52px;padding:0 18px;border-radius:14px;background:#fff;box-shadow:0 0 0 1px #e9e6dc;font-size:16px;color:${INK}">${t}</div>`).join("")}</div>
       <p data-name="Note" style="margin:0;font-size:14px;line-height:21px;color:${MUTE}">Each change an agent makes is its own undo step. Press ⌘Z to take one back.</p>`,
    ),
    page(
      "3 · Design it yourself",
      2080,
      "Tools",
      "The keys worth knowing",
      "The tools sit at the bottom of the canvas. These shortcuts are the same as in the design tool you already use.",
      `<div data-name="Shortcuts" style="display:grid;grid-template-columns:1fr 1fr;gap:0 48px">${row(["V"], "Move and select")}${row(["F"], "Draw a frame")}${row(["R"], "Rectangle")}${row(["T"], "Text")}${row(["C"], "Comment")}${row(["Space"], "Pan the canvas")}${row(["⇧", "A"], "Auto layout")}${row(["⌘", "D"], "Duplicate")}${row(["⇧", "1"], "Fit the page")}${row(["⌘", "Z"], "Undo")}</div>`,
    ),
    page(
      "4 · Bring your team",
      3120,
      "Teams",
      "Better with other people",
      "Boards in a team are edited together, live: you see each other's cursors, and anyone's agent can work on the same design.",
      `<div data-name="How" style="display:grid;grid-template-columns:repeat(3,1fr);gap:16px">${step(1, "Start a team", "From Home, add a team and invite people by email.")}${step(2, "Move a board in", "Share, on any board, puts it in the team.")}${step(3, "Comment", "Press C and click a layer. Add @ to bring an agent in.")}</div>
       <p data-name="Note" style="margin:0;font-size:14px;line-height:21px;color:${MUTE}">You can delete this board whenever you like. It's yours.</p>`,
    ),
  ];
}

/** Makes the welcome board and returns it. */
export function createWelcomeBoard(appName = "Glassine") {
  let board = createBoard(`Welcome to ${appName}`, "studio");
  for (const html of artboards()) {
    const made = addHtmlOps(html, null, { page: board.pages[0].id });
    board = changeBoard(board.id, made.ops, "studio").board;
  }
  return board;
}
