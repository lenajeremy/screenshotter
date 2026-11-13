/**
 * The Studio as people use it, in Chromium and in WebKit (the engine of the Mac app's web view):
 * adding and dragging pictures, colour, accent marks, the store page icon, deleting pictures,
 * designs without a screenshot, exports, templates, devices carrying on across screens and moving
 * through a set. Each check watches
 * for page errors and failed requests too. It starts its own Studio on a free port with a
 * throwaway library, so it never touches yours.
 *
 *   npm run test:ui                       both engines
 *   npm run test:ui -- webkit             one engine (chromium or webkit)
 *
 * Needs Playwright's browsers once: npx playwright install chromium webkit
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium, webkit, type Browser, type Page } from "playwright";
// Tests never ask the Keychain (macOS would ask the person to allow it).
process.env.SCREENSHOTTER_NO_KEYCHAIN = "1";

// A library of its own, set before the Studio's modules read where the library is.
const tmp = mkdtempSync(path.join(os.tmpdir(), "screenshotter-ui-"));
const LIB = path.join(tmp, "library");
mkdirSync(path.join(LIB, "images"), { recursive: true });
writeFileSync(path.join(tmp, "studio.json"), JSON.stringify({ folder: LIB }));
process.env.SCREENSHOTTER_STUDIO_FILE = path.join(tmp, "studio.json");
process.env.SCREENSHOTTER_SEEN_FILE = path.join(tmp, "seen.json");
process.env.SCREENSHOTTER_STYLE_FILE = path.join(tmp, "style.json");
process.env.SCREENSHOTTER_OUTPUT_DIR = LIB;
// Comments go to agents through Agentman: here, a stand-in, never the person's real one.
const AM_SOCKET = path.join(tmp, "am.sock");
process.env.SCREENSHOTTER_AGENTMAN_SOCKET = AM_SOCKET;
const AGENT = "claude:ui-test-agent";
const { fakeAgentman } = await import("./fake-agentman.js");
const agentman = await fakeAgentman(AM_SOCKET, [
  { id: AGENT, kind: "claude", name: "Design agent", cwd: tmp, state: "idle", inject: "tmux" },
  { id: "codex:helper", kind: "codex", name: "Helper", cwd: "/tmp/helper-app", state: "idle", inject: "tmux" },
]);

const { startStudio } = await import("../src/studio/server.js");
const { encodePng } = await import("../src/util/png.js");
const { renderHtml } = await import("../src/render/mockup.js");
const { closeBrowser } = await import("../src/render/browser.js");
const boards = await import("../src/board/store.js");
const boardCore = await import("../src/board/core.js");
const talk = await import("../src/board/comments.js");

const shot = path.join(LIB, "phone.png");
const ipad = path.join(LIB, "ipad.png");
const unused = path.join(LIB, "images", "unused-pic.png");
const used = path.join(LIB, "images", "used-pic.png");

/** A flat picture of one colour. */
const flat = (file: string, w: number, h: number, [r, g, b]: number[]) => {
  const rgba = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i++) rgba.set([r, g, b, 255], i * 4);
  writeFileSync(file, encodePng({ width: w, height: h, rgba }));
};

/** The library as each engine's run starts: a phone screenshot, an iPad one and two pictures. */
async function fixtures() {
  if (!existsSync(shot)) {
    const rows = Array.from({ length: 8 }, (_, i) => `<div style="height:52px;margin:0 16px 8px;border-radius:14px;background:#fff;display:flex;align-items:center;padding:0 14px">Row ${i + 1}</div>`).join("");
    await renderHtml(`<!doctype html><body style="margin:0;width:402px;height:874px;background:#f2f2f7;font:17px -apple-system"><div style="height:120px"></div>${rows}</body>`, shot, 402, 874, { scale: 3, format: "png", transparent: false, outWidth: 1206, outHeight: 2622 });
  }
  if (!existsSync(ipad)) flat(ipad, 2064, 2752, [230, 240, 250]);
  flat(unused, 400, 400, [20, 120, 220]);
  flat(used, 400, 400, [220, 60, 90]);
  rmSync(path.join(LIB, "images", ".hidden.json"), { force: true });
}

const server = await startStudio(0, false);
const BASE = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}/`;

type Check = (page: Page) => Promise<string>;
const S = <T, A>(page: Page, fn: (arg: A) => T | Promise<T>, arg?: A) => page.evaluate(fn as never, arg) as Promise<T>;
/** Put a design on the canvas (as if opened), with the guide and selection cleared. */
const setDesign = (page: Page, patch: Record<string, unknown>) =>
  S(page, async (patch: Record<string, unknown>) => {
    const st = await import("/ui/store.js" as string);
    st.set({ guide: null, selected: null, past: [], future: [], ...patch });
    st.scheduleLayout(0);
  }, patch);
const listed = async (p: string) => ((await (await fetch(BASE + "api/images")).json()).images as Array<{ path: string }>).some((x) => x.path === p);
/** Pictures drawn on the screen being edited (loaded, and not collapsed to nothing). */
const shownOnCanvas = (page: Page) =>
  S(page, () => [...document.querySelectorAll(".stage .artboard .image-body > *")].filter((el) => el.getBoundingClientRect().width > 2 && (el.tagName !== "IMG" || (el as HTMLImageElement).naturalWidth > 0)).length);
/** Press on a panel tile and drag it to the middle of the screen being edited. */
async function dragToCanvas(page: Page, selector: string) {
  const tile = page.locator(selector);
  await tile.scrollIntoViewIfNeeded();
  const b = (await tile.boundingBox())!;
  const a = (await page.locator(".stage .artboard").first().boundingBox())!;
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await page.mouse.down();
  for (let i = 1; i <= 12; i++) await page.mouse.move(b.x + (a.x + a.width * 0.5 - b.x) * (i / 12), b.y + (a.y + a.height * 0.5 - b.y) * (i / 12));
  await page.mouse.up();
  await page.waitForTimeout(900);
}
const waitIdle = (page: Page) => S(page, async () => {
  const st = await import("/ui/store.js" as string);
  for (let i = 0; i < 300 && st.S.rendering; i++) await new Promise((r) => setTimeout(r, 400));
});
const toasts = (page: Page) => S(page, async () => (await import("/ui/store.js" as string)).S.toasts.map((t: { title: string; text?: string }) => `${t.title} ${t.text ?? ""}`).join(" | "));
const undoToast = (page: Page) => S(page, () => ([...document.querySelectorAll(".toast .ta button")].find((b) => b.textContent === "Undo") as HTMLButtonElement | undefined)?.click());

const phone = (extra: Record<string, unknown> = {}) => ({ devices: [{ screenshot: shot }], background: "cream-grain", ...extra });

/** A board with one phone artboard (a column of three rows and a button), open on the page. */
async function openTestBoard(page: Page) {
  const row = (t: string) => `<div data-name="Row ${t}" style="display:flex;align-items:center;gap:12px;padding:14px;border-radius:14px;background:#fff"><div style="width:36px;height:36px;border-radius:10px;background:#eee"></div><span style="font-size:16px;font-weight:600">${t}</span></div>`;
  const b = boards.createBoard("UI test board", "studio");
  const made = boardCore.addHtmlOps(`<div data-name="Phone" style="width:390px;height:844px;background:#f6f5f2;font-family:Inter,sans-serif;padding:60px 20px;display:flex;flex-direction:column;gap:16px"><h1 style="margin:0;font-size:30px">Today</h1><div data-name="List" style="display:flex;flex-direction:column;gap:10px">${row("One")}${row("Two")}${row("Three")}</div><button style="margin-top:auto;height:52px;border-radius:999px;background:#111;color:#fff">Add</button></div>`, null, { page: b.pages[0].id });
  boards.changeBoard(b.id, made.ops, "studio");
  await S(page, async (id: string) => (await import("/ui/board-state.js" as string)).openBoard(id), b.id);
  await page.waitForSelector(".bd-world [data-bid]");
  await page.waitForTimeout(900);
  const byName = (name: string) => Object.values(boards.getBoard(b.id).nodes).find((n) => n.name === name)!.id;
  return { id: b.id, byName };
}
const boardSel = (page: Page) => S(page, async () => {
  const m = await import("/ui/board-state.js" as string);
  return m.B.sel.map((id: string) => m.B.board.nodes[id].name).join(",");
});
const boxOf = async (page: Page, id: string) => (await page.locator(`.bd-world [data-bid="${id}"]`).boundingBox())!;

const CHECKS: Record<string, Check> = {
  async "a board draws its HTML, lists its layers and fits its panels"(page) {
    const t = await openTestBoard(page);
    const drawn = await S(page, () => document.querySelectorAll(".bd-world [data-bid]").length);
    const layers = await S(page, () => document.querySelectorAll(".bd-rows .bd-row").length);
    const list = await boxOf(page, t.byName("List"));
    await page.mouse.click(list.x + 30, list.y + 20);
    await page.waitForTimeout(400);
    const picked = await boardSel(page);
    // Every control in the right panel stays inside it.
    const spill = await S(page, () => {
      const p = document.querySelector(".bd-right")!.getBoundingClientRect();
      return [...document.querySelectorAll(".bd-right .num, .bd-right .dd-btn, .bd-right .seg, .bd-right .input, .bd-right .color-field")].filter((el) => {
        const r = el.getBoundingClientRect();
        return r.width && (r.right > p.right - 4 || r.left < p.left + 4);
      }).length;
    });
    const labels = await S(page, () => [...document.querySelectorAll(".bd-right .num")].filter((n) => {
      const sc = n.querySelector(".scrub")!.getBoundingClientRect();
      const inp = n.querySelector("input")!.getBoundingClientRect();
      return sc.right > inp.left + 1;
    }).length);
    if (drawn !== 13) return `${drawn} layers drawn, not 13`;
    if (layers < 1) return "no layers listed";
    if (picked !== "List") return `a click picked ${picked}, not the layer on the artboard (List)`;
    return spill || labels ? `${spill} controls run out of the panel, ${labels} labels overlap their values` : "ok";
  },
  async "on a board, double-click goes in, a drag reorders a flex row and undo puts it back"(page) {
    const t = await openTestBoard(page);
    const one = await boxOf(page, t.byName("Row One"));
    await page.mouse.click(one.x + 60, one.y + 10);
    await page.mouse.dblclick(one.x + 60, one.y + 10);
    await page.waitForTimeout(300);
    const deeper = await boardSel(page);
    const three = await boxOf(page, t.byName("Row Three"));
    await page.mouse.move(one.x + 200, one.y + one.height / 2);
    await page.mouse.down();
    for (let i = 1; i <= 12; i++) await page.mouse.move(one.x + 200, one.y + one.height / 2 + ((three.y + three.height - 4 - one.y - one.height / 2) * i) / 12);
    await page.mouse.up();
    await page.waitForTimeout(900);
    const order = () => boards.getBoard(t.id).nodes[t.byName("List")].children!.map((c) => boards.getBoard(t.id).nodes[c].name).join(",");
    const after = order();
    await page.keyboard.press("Meta+z");
    await page.waitForTimeout(900);
    const undone = order();
    if (deeper !== "Row One") return `double-click selected ${deeper}`;
    if (after !== "Row Two,Row Three,Row One") return `after the drag: ${after}`;
    return undone === "Row One,Row Two,Row Three" ? "ok" : `after undo: ${undone}`;
  },
  async "on a board, deep layers are easy to reach: double-click, ⌘, right-click → Select layer, and ⌘\\ clears the panels"(page) {
    const t = await openTestBoard(page);
    const st = async () => S(page, async () => {
      const m = await import("/ui/board-state.js" as string);
      return { sel: m.B.sel.map((id: string) => m.B.board.nodes[id].name).join(), hover: m.B.hover ? m.B.board.nodes[m.B.hover].name : null, editing: Boolean(m.B.editing), left: m.B.leftOpen, right: m.B.rightOpen };
    });
    // Double-click goes straight to the deepest layer, three frames down, and into its words.
    const two = await boxOf(page, t.byName("Two"));
    await page.mouse.dblclick(two.x + 8, two.y + two.height / 2);
    await page.waitForTimeout(300);
    const a = await st();
    if (a.sel !== "Two" || !a.editing) return `double-click selected ${a.sel} (typing: ${a.editing})`;
    await page.keyboard.press("Escape");
    // Holding ⌘ shows the deepest layer under the pointer before any click.
    const row3 = t.byName("Row Three");
    const icon = boards.getBoard(t.id).nodes[row3].children![0];
    const ib = await boxOf(page, icon);
    await page.mouse.move(ib.x + ib.width / 2, ib.y + ib.height / 2, { steps: 3 });
    await page.keyboard.down("Meta");
    await page.waitForTimeout(150);
    const held = await st();
    await page.keyboard.up("Meta");
    if (held.hover !== boards.getBoard(t.id).nodes[icon].name) return `with ⌘ held, the pointer shows ${held.hover}`;
    // Right-click lists every layer under the pointer, deepest first; picking one selects it.
    await page.mouse.click(ib.x + ib.width / 2, ib.y + ib.height / 2, { button: "right" });
    await page.locator(".ctx-item", { hasText: "Select layer…" }).click();
    await page.waitForTimeout(150);
    const listed = await S(page, () => [...document.querySelectorAll(".ctx-item .ctx-label")].map((x) => x.textContent).join(","));
    if (!listed.startsWith("Frame,Row Three,List,Phone")) return `Select layer lists ${listed}`;
    await page.locator(".ctx-item", { hasText: "Row Three" }).click();
    await page.waitForTimeout(150);
    const picked = await st();
    if (picked.sel !== "Row Three") return `Select layer picked ${picked.sel}`;
    // ⌘\ hides both panels, and brings both back.
    await page.keyboard.press("Meta+Backslash");
    await page.waitForTimeout(200);
    const hidden = await st();
    await page.keyboard.press("Meta+Backslash");
    await page.waitForTimeout(200);
    const shown = await st();
    return !hidden.left && !hidden.right && shown.left && shown.right ? "ok" : `⌘\\: hidden ${hidden.left}/${hidden.right}, shown ${shown.left}/${shown.right}`;
  },
  async "a video shows its first frame, plays from its button, and stops when let go"(page) {
    const t = await openTestBoard(page);
    // A clip each engine can play: H.264 where it can, else VP8 WebM (Playwright's Chromium has no H.264).
    const { execFileSync } = await import("node:child_process");
    const mp4 = path.join(LIB, "clip.mp4");
    const webm = path.join(LIB, "clip.webm");
    const still = path.join(LIB, "clip.jpg");
    if (!existsSync(webm)) {
      execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=15", "-t", "3", "-c:v", "libx264", "-pix_fmt", "yuv420p", mp4]);
      execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=15", "-t", "3", "-c:v", "libvpx", "-b:v", "400k", webm]);
      execFileSync("ffmpeg", ["-v", "error", "-y", "-i", mp4, "-frames:v", "1", still]);
    }
    const h264 = await S(page, () => document.createElement("video").canPlayType('video/mp4; codecs="avc1.42E01E"'));
    const id = boardCore.newId();
    const phoneId = t.byName("Phone");
    boards.changeBoard(t.id, [{ op: "add", nodes: { [id]: { id, type: "video", name: "Clip", parent: phoneId, src: h264 ? mp4 : webm, poster: still, video: { autoplay: true, loop: true, muted: true }, style: { width: "300px", height: "170px", objectFit: "cover", flexShrink: "0" } } }, ids: [id], parent: phoneId, index: 1 }], "agent");
    await page.waitForSelector(`.bd-world [data-bid="${id}"]`, { timeout: 5000 });
    const state = () => S(page, (vid: string) => {
      const v = document.querySelector(`[data-bid="${vid}"]`) as HTMLVideoElement;
      return { tag: v.tagName, paused: v.paused, poster: Boolean(v.getAttribute("poster")), at: v.currentTime };
    }, id);
    const first = await state();
    if (first.tag !== "VIDEO" || !first.paused || !first.poster) return `on the canvas it's ${JSON.stringify(first)}, not its still`;
    await S(page, async (vid: string) => (await import("/ui/board-state.js" as string)).select(vid), id);
    await page.waitForTimeout(300);
    const marks = await S(page, () => `${document.querySelector(".bd-video-tag")?.textContent ?? ""}|${Boolean(document.querySelector(".bd-video-play"))}`);
    if (marks !== "Video|true") return `selected, it shows "${marks}"`;
    await page.click(".bd-video-play");
    await page.waitForTimeout(1200);
    const playing = await state();
    if (playing.paused || playing.at <= 0) return `after play it's ${JSON.stringify(playing)}`;
    const dur = await S(page, () => document.querySelector(".bd-dur")?.textContent ?? "");
    if (dur !== "/ 0:03") return `the panel's player says ${dur}`;
    // How it plays in Preview: Figma's switches.
    await page.locator(".bd-video-opts .switch", { hasText: "Loop" }).click();
    await page.waitForTimeout(900);
    const loop = boards.getBoard(t.id).nodes[id].video?.loop;
    if (loop !== false) return `turning Loop off left it ${loop}`;
    // Let go of it, and it's its first frame again.
    await S(page, async (pid: string) => (await import("/ui/board-state.js" as string)).select(pid), phoneId);
    await page.waitForTimeout(400);
    const after = await state();
    return after.paused && after.at === 0 ? "ok" : `after letting go it's ${JSON.stringify(after)}`;
  },
  async "Preview opens a frame as a live web page"(page) {
    const t = await openTestBoard(page);
    await S(page, () => {
      const w = window as unknown as { __opened: string[]; open: (u: string) => null };
      w.__opened = [];
      w.open = (u: string) => (w.__opened.push(u), null);
    });
    const opened = () => S(page, () => (window as unknown as { __opened: string[] }).__opened.slice(-1)[0] ?? "");
    // The button previews the selected frame, at its width on the canvas.
    await S(page, async (id: string) => (await import("/ui/board-state.js" as string)).select(id), t.byName("List"));
    await page.click(".bd-preview");
    const a = new URL(await opened());
    if (a.pathname !== "/board/preview" || a.searchParams.get("node") !== t.byName("List") || a.searchParams.get("w") !== "350") return `the button opened ${a.href}`;
    // ⌥⌘P with words selected previews the frame round them.
    const words = boards.getBoard(t.id).nodes[t.byName("Row Two")].children!.find((c) => boards.getBoard(t.id).nodes[c].type === "text")!;
    await S(page, async (id: string) => (await import("/ui/board-state.js" as string)).select(id), words);
    await page.keyboard.press("Meta+Alt+KeyP");
    const b = new URL(await opened());
    if (b.searchParams.get("node") !== t.byName("Row Two")) return `⌥⌘P opened ${b.href}`;
    // The page: the frame alone, its parents' font, its own width, and it follows the board.
    const ctx = await page.context().browser()!.newContext();
    const view = await ctx.newPage();
    try {
      await view.goto(a.href);
      const got = await view.evaluate(() => {
        const f = document.getElementById("bd-frame")!;
        return `${document.title}|${getComputedStyle(f).fontFamily.split(",")[0]}|${f.getBoundingClientRect().width}|${f.innerText.replace(/\s+/g, " ").trim()}`;
      });
      if (got !== "List · UI test board|Inter|350|One Two Three") return `the preview shows "${got}"`;
      const one = boards.getBoard(t.id).nodes[t.byName("Row One")].children!.find((c) => boards.getBoard(t.id).nodes[c].type === "text")!;
      boards.changeBoard(t.id, [{ op: "set", id: one, text: "Uno" }], "agent");
      await view.waitForFunction(() => document.getElementById("bd-frame")?.innerText.includes("Uno"), null, { timeout: 5000 }).catch(() => {});
      const after = await view.evaluate(() => document.getElementById("bd-frame")?.innerText.replace(/\s+/g, " ").trim());
      if (after !== "Uno Two Three") return `after a change the preview shows "${after}"`;
      // A desktop-size frame is the page: it fills the window, with no backdrop round it.
      boards.changeBoard(t.id, [{ op: "set", id: t.byName("Phone"), style: { width: "1200px" } }], "agent");
      await view.goto(`${a.origin}/board/preview?board=${t.id}&node=${t.byName("Phone")}&w=1200`);
      const wide = await view.evaluate(() => `${document.getElementById("bd-frame")!.firstElementChild!.getBoundingClientRect().width}/${innerWidth} ${getComputedStyle(document.body).paddingTop}`);
      if (wide !== `${await view.evaluate(() => innerWidth)}/${await view.evaluate(() => innerWidth)} 0px`) return `a desktop-size frame is ${wide} wide`;
      const gone = await view.goto(a.href.replace(/node=[^&]+/, "node=nope"));
      if (gone?.status() !== 404) return `a frame that isn't there gives ${gone?.status()}`;
    } finally {
      await ctx.close();
    }
    return "ok";
  },
  async "on a board, the frame tool draws an artboard and text is typed in place"(page) {
    const t = await openTestBoard(page);
    const c = (await page.locator(".bd-canvas").boundingBox())!;
    const phone = await boxOf(page, t.byName("Phone"));
    await page.keyboard.press("f");
    const x0 = phone.x + phone.width + 80;
    await page.mouse.move(x0, c.y + 120);
    await page.mouse.down();
    await page.mouse.move(x0 + 60, c.y + 180, { steps: 5 });
    await page.mouse.move(x0 + 120, c.y + 240, { steps: 5 });
    await page.mouse.up();
    await page.waitForTimeout(700);
    const roots = boards.getBoard(t.id).pages[0].children.length;
    const list = await boxOf(page, t.byName("List"));
    await page.keyboard.press("t");
    await page.mouse.click(list.x + 40, list.y + list.height + 30);
    await page.waitForTimeout(300);
    await page.keyboard.press("Meta+a");
    await page.keyboard.type("Hello board");
    await page.keyboard.press("Escape");
    await page.waitForTimeout(900);
    const texts = Object.values(boards.getBoard(t.id).nodes).filter((n) => n.type === "text" && n.text === "Hello board");
    if (roots !== 2) return `${roots} artboards after drawing one`;
    if (texts.length !== 1) return "the typed text wasn't saved";
    return texts[0].parent === t.byName("Phone") ? "ok" : "the text didn't land in the artboard's flex column";
  },
  async "on a board, a comment pins to a layer, reaches its agent, shows the reply and resolves"(page) {
    const t = await openTestBoard(page);
    const phone = t.byName("Phone");
    const row = t.byName("Row Two");
    // An agent worked on the artboard: the Studio learns it with its next poll.
    boards.changeBoard(t.id, [{ op: "agent", agent: { key: AGENT, session: AGENT, how: "process", kind: "claude", name: "Design agent", cwd: tmp }, artboards: [phone], at: new Date().toISOString() }], "agent");
    await page.waitForTimeout(1200);
    await page.keyboard.press("c");
    const r = await boxOf(page, row);
    await page.mouse.click(r.x + r.width - 18, r.y + 8);
    await page.waitForSelector(".bd-thread textarea");
    if (await S(page, () => Boolean(document.querySelector(".bd-thread .bd-to")))) return "the comment box has a To row";
    // Only a tagged agent gets it: @ and its name.
    await page.keyboard.type("@Des");
    await page.waitForSelector(".bd-picker button", { timeout: 6000 });
    await page.keyboard.press("Enter");
    await page.keyboard.type("make this row taller");
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => document.querySelector(".bd-thread .bd-sent")?.textContent?.startsWith("Sent to Design agent"), null, { timeout: 8000 }).catch(() => undefined);
    const thread = talk.getComments(t.id).threads[0];
    if (!thread || thread.anchor.layer !== row) return `the comment is on ${thread?.anchor.layer ? boards.getBoard(t.id).nodes[thread.anchor.layer]?.name : "nothing"}, not Row Two`;
    const sent = agentman.sent.find((s) => s.text.includes(thread.id));
    if (!sent || sent.sessionId !== AGENT || !sent.text.includes(`#${row}`) || !sent.text.includes("> @Design agent make this row taller")) return "Agentman wasn't handed the comment, with its layer, for the agent";
    const shown = await S(page, () => document.querySelector(".bd-thread .bd-sent")?.textContent ?? "");
    if (!shown.startsWith("Sent to Design agent")) return `the thread says "${shown}", not that it was sent`;
    // While Agentman says the agent is busy, the thread shows it at work.
    agentman.sessions[0].state = "busy";
    const working = await page.waitForFunction(() => document.querySelector(".bd-thread .bd-working-on")?.textContent?.includes("Design agent is working on it") && document.querySelector(".bd-thread .bd-dots"), null, { timeout: 9000 }).then(() => true, () => false);
    if (!working) return "the thread didn't show the agent at work";
    // The agent answers (as board_comment does); the open thread shows it within a poll or two.
    talk.reply(t.id, thread.id, { text: "Done: 72px tall now.", by: AGENT, name: "Design agent" });
    const replied = await page.waitForFunction(() => [...document.querySelectorAll(".bd-thread .bd-msg .txt")].some((x) => x.textContent === "Done: 72px tall now."), null, { timeout: 5000 }).then(() => true, () => false);
    if (!replied) return "the agent's reply didn't show in the thread";
    agentman.sessions[0].state = "idle";
    if (await S(page, () => Boolean(document.querySelector(".bd-thread .bd-working-on")))) return "the agent still shows at work after it answered";
    // Comments aren't the design: undo leaves them alone.
    await page.keyboard.press("Escape");
    await page.keyboard.press("Meta+z");
    await page.waitForTimeout(300);
    if (talk.getComments(t.id).threads[0]?.messages.length !== 2) return "undo touched the comment";
    await page.click(`.bd-pin[data-thread="${thread.id}"]`);
    await page.click(".bd-thread header button[title='Resolve']");
    await page.waitForTimeout(400);
    const resolved = Boolean(talk.getComments(t.id).threads[0].resolved);
    // A resolved thread opens again with a word, not another check mark.
    await page.click('.bd-left-tabs [data-tab="comments"]');
    await S(page, async (id: string) => (await import("/ui/board-comments.js" as string)).openThread(id), thread.id);
    await page.waitForTimeout(300);
    const reopen = await S(page, () => document.querySelector(".bd-thread header .bd-reopen")?.textContent ?? "");
    if (reopen !== "Reopen") return `a resolved thread offers "${reopen}" to open it again`;
    await page.keyboard.press("Escape");
    await page.click('.bd-left-tabs [data-tab="layers"]').catch(() => undefined);
    const pinGone = await S(page, (id: string) => !document.querySelector(`.bd-pin[data-thread="${id}"]`), thread.id);
    await page.click('.bd-left-tabs [data-tab="comments"]');
    const listed = await S(page, () => document.querySelectorAll(".bd-crow").length);
    return resolved && pinGone && listed === 0 ? "ok" : `resolved: ${resolved}, pin hidden: ${pinGone}, open comments listed: ${listed}`;
  },
  async "on a board, @ tags an agent in the words, even one from Agentman that hasn't worked here"(page) {
    const t = await openTestBoard(page);
    await page.keyboard.press("c");
    const r = await boxOf(page, t.byName("Row One"));
    await page.mouse.click(r.x + r.width - 18, r.y + 8);
    await page.waitForSelector(".bd-thread textarea");
    await page.keyboard.type("Hey @Hel");
    await page.waitForSelector(".bd-picker button", { timeout: 6000 });
    const listed = await S(page, () => [...document.querySelectorAll(".bd-picker button .nm")].map((x) => x.textContent).join());
    if (listed !== "Helper") return `typing @Hel lists "${listed}", not Agentman's Helper`;
    await page.keyboard.press("Enter");
    await page.keyboard.type("can you tidy this row?");
    // The tag is green while it's being written, not only once it's sent.
    const inBox = await S(page, () => {
      const m = document.querySelector(".bd-compose-mirror .bd-mention");
      return m ? `${m.textContent} ${getComputedStyle(m).color}` : "";
    });
    if (inBox !== "@Helper rgb(74, 222, 128)") return `while typing, the tag shows as "${inBox}"`;
    const typed = await S(page, () => (document.querySelector(".bd-thread textarea") as HTMLTextAreaElement).value);
    const button = await S(page, () => document.querySelector(".bd-compose .bd-send")?.getAttribute("aria-label") ?? "");
    const to = await S(page, () => document.querySelector(".bd-compose-row .to")?.textContent ?? "");
    if (typed !== "Hey @Helper can you tidy this row?" || button !== "Send" || to !== "To Helper") return `the words are "${typed}", the button says "${button}", "${to}"`;
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => document.querySelector(".bd-thread .bd-sent")?.textContent?.startsWith("Sent to Helper"), null, { timeout: 8000 }).catch(() => undefined);
    const sent = agentman.sent.find((x) => x.sessionId === "codex:helper");
    const onBoard = boards.getBoard(t.id).agents?.["codex:helper"]?.name;
    const mark = await S(page, () => {
      const m = document.querySelector(".bd-thread .bd-msg .bd-mention");
      return m ? `${m.textContent} ${getComputedStyle(m).color}` : "";
    });
    if (!sent?.text.includes("Hey @Helper can you tidy this row?") || onBoard !== "Helper" || mark !== "@Helper rgb(74, 222, 128)") return `sent: ${Boolean(sent)}, on the board as: ${onBoard}, marked: "${mark}"`;
    // An agent's answer in Markdown reads as it was meant: a list, bold, code, a link, nothing that runs.
    const th = talk.getComments(t.id).threads.find((x) => x.messages.some((m) => m.text.includes("tidy this row")))!;
    talk.reply(t.id, th.id, { by: "codex:helper", name: "Helper", text: "Tidied:\n\n1. **Spacing** to `16px`\n2. A [guide](https://example.com) and <img src=x onerror=alert(1)>" });
    const md = await page.waitForFunction(() => {
      const last = [...document.querySelectorAll(".bd-thread .bd-md")].pop();
      return last && last.querySelectorAll("ol li").length === 2 ? { b: last.querySelector("b")?.textContent, code: last.querySelector("code")?.textContent, a: last.querySelector("a")?.getAttribute("target"), img: Boolean(last.querySelector("img")) } : null;
    }, null, { timeout: 6000 }).then((h) => h.jsonValue(), () => null);
    return md && md.b === "Spacing" && md.code === "16px" && md.a === "_blank" && !md.img ? "ok" : `the Markdown reply drew ${JSON.stringify(md)}`;
  },
  async "on a board, changes still being saved go to their own board when another is opened"(page) {
    const t = await openTestBoard(page);
    const other = boards.createBoard("The other board", "studio");
    // The first save takes a while, so the second change waits in line behind it.
    let held = false;
    await page.route("**/api/board/ops", async (route) => {
      if (!held) {
        held = true;
        await new Promise((r) => setTimeout(r, 1500));
      }
      await route.continue();
    });
    await S(page, async () => {
      const s = await import("/ui/board-state.js" as string);
      s.commit([{ op: "rename", name: "First name" }]);
      s.commit([{ op: "rename", name: "Second name" }]);
    });
    await S(page, async (id: string) => (await import("/ui/board-state.js" as string)).openBoard(id), other.id);
    await page.waitForTimeout(3500);
    await page.unroute("**/api/board/ops");
    const a = boards.getBoard(t.id).name;
    const b = boards.getBoard(other.id).name;
    return a === "Second name" && b === "The other board" ? "ok" : `the first board is "${a}", the other "${b}"`;
  },
  async "on a board, one agent answering doesn't hide another still at work"(page) {
    const t = await openTestBoard(page);
    const at = new Date().toISOString();
    boards.changeBoard(t.id, [
      { op: "agent", agent: { key: AGENT, session: AGENT, how: "process", kind: "claude", name: "Design agent", cwd: tmp }, artboards: [t.byName("Phone")], at },
      { op: "agent", agent: { key: "codex:helper", session: "codex:helper", how: "tmux", kind: "codex", name: "Helper", cwd: "/tmp/helper-app" }, artboards: [], at },
    ], "agent");
    const th = talk.startThread(t.id, { layer: t.byName("Row One") }, { text: "@Design agent @Helper both of you", by: "person", to: [AGENT, "codex:helper"] });
    await talk.deliver(t.id, th.thread.id, th.message.id);
    talk.reply(t.id, th.thread.id, { text: "Done my part.", by: AGENT, name: "Design agent" });
    agentman.sessions[1].state = "busy";
    await page.waitForTimeout(1200);
    await S(page, async (id: string) => (await import("/ui/board-comments.js" as string)).openThread(id), th.thread.id);
    const shown = await page.waitForFunction(() => [...document.querySelectorAll(".bd-thread .bd-working-on")].map((x) => x.textContent).join("|"), null, { timeout: 9000 }).then((h) => h.jsonValue(), () => "");
    agentman.sessions[1].state = "idle";
    return /Helper is working on it/.test(String(shown)) && !/Design agent is working/.test(String(shown)) ? "ok" : `the thread shows "${shown}"`;
  },
  async "on a board, a token is renamed from the token list, everywhere it's used, and undone in one step"(page) {
    const t = await openTestBoard(page);
    const phone = t.byName("Phone");
    boards.changeBoard(t.id, [{ op: "token", name: "--brand", value: "#ff3b30" }, { op: "set", id: phone, style: { backgroundColor: "var(--brand)" } }], "agent");
    await page.waitForTimeout(1500);
    await S(page, async () => (await import("/ui/board-state.js" as string)).select([]));
    await page.waitForTimeout(300);
    await page.locator(".bd-token button.bd-token-name", { hasText: "brand" }).click();
    await page.locator("input.bd-token-name").fill("primary");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(900);
    const b = boards.getBoard(t.id);
    const renamed = b.tokens.map((x) => x.name).join() === "--primary" && b.nodes[phone].style.backgroundColor === "var(--primary)";
    const drawn = await S(page, (id: string) => getComputedStyle(document.querySelector(`.bd-world [data-bid="${id}"]`)!).backgroundColor, phone);
    await page.keyboard.press("Meta+z");
    await page.waitForTimeout(900);
    const back = boards.getBoard(t.id);
    const undone = back.tokens.map((x) => x.name).join() === "--brand" && back.nodes[phone].style.backgroundColor === "var(--brand)";
    return renamed && drawn === "rgb(255, 59, 48)" && undone ? "ok" : `renamed: ${renamed}, drawn ${drawn}, undone: ${undone}`;
  },
  async "on a board, dragging with the comment tool comments on that part of the artboard"(page) {
    const t = await openTestBoard(page);
    await page.keyboard.press("c");
    const list = await boxOf(page, t.byName("List"));
    await page.mouse.move(list.x - 6, list.y - 6);
    await page.mouse.down();
    for (let i = 1; i <= 8; i++) await page.mouse.move(list.x - 6 + ((list.width + 12) * i) / 8, list.y - 6 + ((list.height + 12) * i) / 8);
    await page.mouse.up();
    await page.waitForSelector(".bd-thread textarea");
    const note = await S(page, () => document.querySelector(".bd-compose .bd-sent")?.textContent ?? "");
    await page.keyboard.type("Too much space between the rows");
    await page.click(".bd-compose .bd-send");
    await page.waitForTimeout(500);
    const th = talk.getComments(t.id).threads[0];
    const layers = (th?.anchor.layers ?? []).map((id) => boards.getBoard(t.id).nodes[id]?.name).join();
    if (!th?.anchor.rect || th.anchor.artboard !== t.byName("Phone")) return "the region wasn't saved on the artboard";
    if (layers !== "List") return `the region covers ${layers || "nothing"}, not List`;
    if (note || th.messages[0].to?.length) return "with no agent tagged, it should be just a comment";
    const area = await S(page, () => Boolean(document.querySelector(".bd-carea")));
    return area ? "ok" : "the region isn't outlined while its thread is open";
  },
  async "an agent's change to an open board shows up and undoes"(page) {
    const t = await openTestBoard(page);
    const made = boardCore.addHtmlOps(`<div data-name="From the agent" style="padding:16px;background:#111;color:#fff;border-radius:14px">Hi</div>`, t.byName("Phone"), {});
    boards.changeBoard(t.id, made.ops, "agent");
    await page.waitForTimeout(1800);
    const shown = await S(page, async (id: string) => Boolean(document.querySelector(`.bd-world [data-bid="${id}"]`)), made.roots[0]);
    await page.keyboard.press("Meta+z");
    await page.waitForTimeout(1200);
    const gone = !boards.getBoard(t.id).nodes[made.roots[0]];
    return shown && gone ? "ok" : `shown: ${shown}, undone on disk: ${gone}`;
  },
  async "on a board, a component's copies follow it, and what's inside a copy stays put"(page) {
    const t = await openTestBoard(page);
    const one = t.byName("Row One");
    await S(page, async (id: string) => (await import("/ui/board-state.js" as string)).select(id), one);
    await page.keyboard.press("Meta+Alt+k");
    await page.waitForTimeout(200);
    await S(page, async (id: string) => {
      const b = await import("/ui/board.js" as string);
      b.placeCopy(id);
    }, one);
    await page.waitForTimeout(700);
    const nodes = () => Object.values(boards.getBoard(t.id).nodes);
    const copy = nodes().find((n) => n.instanceOf === one);
    if (!boards.getBoard(t.id).nodes[one].isComponent || !copy) return "no component or no copy";
    const words = nodes().find((n) => n.parent === one && n.type === "text")!;
    await S(page, async (id: string) => (await import("/ui/board-state.js" as string)).commit([{ op: "set", id, text: "Uno" }]), words.id);
    await page.waitForTimeout(800);
    const copyWords = nodes().find((n) => n.parent === copy.id && n.type === "text")!;
    await S(page, async (id: string) => {
      const s = await import("/ui/board-state.js" as string);
      s.select(id);
      (await import("/ui/board.js" as string)).deleteSelection();
    }, copyWords.id);
    await page.waitForTimeout(600);
    const kept = Boolean(boards.getBoard(t.id).nodes[copyWords.id]);
    await page.locator(".bd-left-tabs button", { hasText: "Assets" }).click();
    await page.waitForTimeout(300);
    const icons = await S(page, () => [...document.querySelectorAll(".bd-assets .bd-asset.row")].length);
    if (copyWords.text !== "Uno") return `the copy says ${copyWords.text}`;
    if (!kept) return "a layer inside the copy was deleted";
    return icons === 1 ? "ok" : `${icons} components listed`;
  },
  async "on a board, artboards line up and resize together"(page) {
    const t = await openTestBoard(page);
    const made = boardCore.addHtmlOps(`<div data-name="Second" style="width:200px;height:300px;background:#fff"></div>`, null, { page: boards.getBoard(t.id).pages[0].id });
    boards.changeBoard(t.id, [...made.ops, { op: "set", id: made.roots[0], style: { left: "500px", top: "120px" } }], "studio");
    await page.waitForTimeout(1500);
    await S(page, async () => {
      const s = await import("/ui/board-state.js" as string);
      s.select(s.currentPage().children.slice());
    });
    await page.waitForTimeout(300);
    await page.locator('.bd-align button[title^="Align tops"]').click();
    await page.waitForTimeout(800);
    const tops = boards.getBoard(t.id).pages[0].children.map((id) => parseFloat(boards.getBoard(t.id).nodes[id].style.top ?? "0"));
    const se = (await page.locator('.bd-handle.h-se[data-group]').boundingBox())!;
    const widths0 = boards.getBoard(t.id).pages[0].children.map((id) => parseFloat(boards.getBoard(t.id).nodes[id].style.width!));
    await page.mouse.move(se.x + 4, se.y + 4);
    await page.mouse.down();
    await page.mouse.move(se.x + 60, se.y + 4, { steps: 6 });
    await page.mouse.up();
    await page.waitForTimeout(800);
    const widths = boards.getBoard(t.id).pages[0].children.map((id) => parseFloat(boards.getBoard(t.id).nodes[id].style.width!));
    if (new Set(tops).size !== 1) return `tops after aligning: ${tops}`;
    return widths.every((w, i) => w > widths0[i]) ? "ok" : `widths ${widths0} → ${widths}`;
  },
  async "on a board, the Scale tool (K) scales a layer with everything in it, and ⌘\\ hides the panels"(page) {
    const t = await openTestBoard(page);
    const phone = t.byName("Phone");
    const title = boards.getBoard(t.id).nodes[phone].children!.find((c) => boards.getBoard(t.id).nodes[c].type === "text")!;
    const row = t.byName("Row One");
    await S(page, async (id: string) => (await import("/ui/board-state.js" as string)).select(id), phone);
    await page.keyboard.press("k");
    await page.waitForTimeout(300);
    const tool = await S(page, async () => (await import("/ui/board-state.js" as string)).B.tool);
    if (tool !== "scale") return `K picked ${tool}`;
    if (!(await page.locator(".bd-right section", { has: page.locator("h3", { hasText: "Scale" }) }).count())) return "no Scale panel with the Scale tool";
    // A corner handle, dragged out: the artboard, its type and its spacing all grow by the same amount.
    const se = (await page.locator(".bd-handle.h-se").boundingBox())!;
    await page.mouse.move(se.x + 4, se.y + 4);
    await page.mouse.down();
    await page.mouse.move(se.x + 4 + (await boxOf(page, phone)).width / 2, se.y + 4, { steps: 8 });
    await page.mouse.up();
    await page.waitForTimeout(800);
    let n = boards.getBoard(t.id).nodes;
    const k = parseFloat(n[phone].style.width!) / 390;
    const font = parseFloat(n[title].style.fontSize!) / 30;
    const pad = n[row].style.padding;
    if (Math.abs(k - 1.5) > 0.05) return `scaled by ${k}, not about 1.5`;
    if (Math.abs(font - k) > 0.02) return `type scaled by ${font}, the artboard by ${k}`;
    if (Math.abs(parseFloat(pad!) / 14 - k) > 0.02) return `a row's padding is ${pad}`;
    if (Math.abs(parseFloat(n[phone].style.height!) / 844 - k) > 0.02) return `height ${n[phone].style.height}`;
    // The panel: back to two thirds of that, by typing a percentage.
    const field = page.locator(".bd-scale-row .num input");
    await field.click();
    await field.fill("50");
    await field.press("Enter");
    await page.waitForTimeout(800);
    n = boards.getBoard(t.id).nodes;
    if (Math.abs(parseFloat(n[phone].style.width!) - 390 * k * 0.5) > 1) return `50% made it ${n[phone].style.width}`;
    // Each scale is one step of undo.
    await page.locator(".bd-stage").hover();
    await page.keyboard.press("Meta+z");
    await page.waitForTimeout(800);
    n = boards.getBoard(t.id).nodes;
    if (Math.abs(parseFloat(n[phone].style.width!) / 390 - k) > 0.01) return `undo left it at ${n[phone].style.width}`;
    // ⌘\ puts both side panels away and back; ⌘K doesn't any more.
    const panels = () => S(page, async () => {
      const m = await import("/ui/board-state.js" as string);
      return `${m.B.leftOpen}/${m.B.rightOpen}`;
    });
    await page.keyboard.press("Meta+k");
    await page.waitForTimeout(200);
    if ((await panels()) !== "true/true") return `⌘K changed the panels: ${await panels()}`;
    await page.keyboard.press("Meta+Backslash");
    await page.waitForTimeout(200);
    const hidden = await panels();
    await page.keyboard.press("Meta+Backslash");
    await page.waitForTimeout(200);
    return hidden === "false/false" && (await panels()) === "true/true" ? "ok" : `⌘\\ gave ${hidden}, then ${await panels()}`;
  },
  async "on a board, assets from the rest of the app go into the selected frame, and filters apply"(page) {
    const t = await openTestBoard(page);
    const phone = t.byName("Phone");
    await S(page, async (id: string) => (await import("/ui/board-state.js" as string)).select(id), phone);
    await page.locator(".bd-left-tabs button", { hasText: "Assets" }).click();
    await page.waitForTimeout(400);
    await page.locator(".bd-asset.shape", { hasText: "Star" }).click();
    await page.waitForTimeout(400);
    await S(page, async (id: string) => (await import("/ui/board-state.js" as string)).select(id), phone);
    await page.locator(".bd-asset-grid.icons .bd-asset").first().click();
    await page.waitForTimeout(900);
    const kids = boards.getBoard(t.id).nodes[phone].children!.map((c) => boards.getBoard(t.id).nodes[c]);
    const star = kids.find((n) => n.name === "Star");
    const sticker = kids.find((n) => n.type === "svg" && !n.shape);
    if (!star?.shape || !star.svg?.includes("<svg")) return "the star didn't land in the artboard as a shape";
    if (!sticker) return "the sticker didn't land in the artboard";
    await S(page, async (id: string) => (await import("/ui/board-state.js" as string)).select(id), star.id);
    await page.waitForTimeout(300);
    await page.locator(".bd-right section", { has: page.locator("h3", { hasText: "Filters" }) }).locator(".section-head .icon-btn").click();
    await page.waitForTimeout(800);
    const f = boards.getBoard(t.id).nodes[star.id].style.filter;
    const drawn = await S(page, async (id: string) => getComputedStyle(document.querySelector(`.bd-world [data-bid="${id}"]`)!).filter, star.id);
    return f === "blur(4px)" && /blur/.test(drawn) ? "ok" : `filter ${f}, drawn ${drawn}`;
  },
  async "on a board, an svg's parts are layers: picked, dragged, resized and painted in their own coordinates"(page) {
    const b = boards.createBoard("Vector test", "studio");
    const made = boardCore.addHtmlOps(`<div data-name="Card" style="width:360px;height:240px;background:#fff;position:relative"><svg data-name="Art" style="position:absolute;left:20px;top:20px;width:320px;height:200px" viewBox="0 0 160 100"><rect data-name="Box" x="10" y="10" width="40" height="30" fill="#0a84ff"/><g data-name="Pair" transform="translate(80 20)"><circle data-name="Dot" cx="10" cy="10" r="10" fill="#ff3b30"/></g></svg></div>`, null, { page: b.pages[0].id });
    boards.changeBoard(b.id, made.ops, "studio");
    await S(page, async (id: string) => (await import("/ui/board-state.js" as string)).openBoard(id), b.id);
    await page.waitForSelector(".bd-world [data-bid]");
    await page.waitForTimeout(900);
    const id = (name: string) => Object.values(boards.getBoard(b.id).nodes).find((n) => n.name === name)!.id;
    const box = await boxOf(page, id("Box"));
    // ⌘-click goes straight to the part; dragging moves it by its own x and y (the svg is drawn at 2×).
    await page.keyboard.down("Meta");
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await page.keyboard.up("Meta");
    await page.waitForTimeout(300);
    if ((await boardSel(page)) !== "Box") return `⌘-click picked ${await boardSel(page)}`;
    const z = await S(page, async () => (await import("/ui/board-state.js" as string)).B.view.z);
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 20 * z, box.y + box.height / 2 + 10 * z, { steps: 6 });
    await page.mouse.up();
    await page.waitForTimeout(500);
    const moved = boards.getBoard(b.id).nodes[id("Box")].attrs!;
    if (Math.abs(Number(moved.x) - 20) > 0.6 || Math.abs(Number(moved.y) - 15) > 0.6) return `the rect went to ${moved.x},${moved.y}, not 20,15`;
    // Its east handle stretches its width.
    const h = await page.locator('.bd-handle[data-handle="e"]').boundingBox();
    await page.mouse.move(h!.x + h!.width / 2, h!.y + h!.height / 2);
    await page.mouse.down();
    await page.mouse.move(h!.x + h!.width / 2 + 20 * z, h!.y + h!.height / 2, { steps: 6 });
    await page.mouse.up();
    await page.waitForTimeout(500);
    const wide = boards.getBoard(b.id).nodes[id("Box")].attrs!;
    if (Math.abs(Number(wide.width) - 50) > 0.6) return `the rect is ${wide.width} wide after resizing, not 50`;
    // A group moves by a transform, folded into the one it had.
    await S(page, async (g: string) => (await import("/ui/board-state.js" as string)).select(g), id("Pair"));
    await page.waitForTimeout(300);
    await page.keyboard.press("Shift+ArrowRight");
    await page.waitForTimeout(500);
    const t = boards.getBoard(b.id).nodes[id("Pair")].attrs!.transform;
    if (t !== "translate(85 20)") return `the group's transform is ${t}`;
    // The panel paints a part.
    await S(page, async (g: string) => (await import("/ui/board-state.js" as string)).select(g), id("Dot"));
    await page.waitForTimeout(300);
    const panel = await S(page, () => [...document.querySelectorAll(".bd-right h3")].map((e) => e.textContent).join(","));
    if (!/Layout/.test(panel) || !/Paint/.test(panel)) return `the panel for a part shows ${panel}`;
    await page.locator(".bd-paint").first().locator(":scope > .icon-btn").click();
    await page.waitForTimeout(500);
    const fill = boards.getBoard(b.id).nodes[id("Dot")].attrs!.fill;
    const drawn = await S(page, (d: string) => document.querySelector(`.bd-world [data-bid="${d}"]`)!.getAttribute("fill"), id("Dot"));
    return fill === "none" && drawn === "none" ? "ok" : `fill ${fill}, drawn ${drawn}`;
  },
  async "pasting HTML onto a board makes layers"(page) {
    const t = await openTestBoard(page);
    await page.locator(".bd-row", { hasText: "Phone" }).first().click();
    await page.waitForTimeout(200);
    await S(page, () => {
      const dt = new DataTransfer();
      dt.setData("text/plain", '<div style="display:flex;gap:8px"><span style="padding:6px 10px;background:#eee">A</span><span style="padding:6px 10px">B</span></div>');
      window.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true }));
    });
    await page.waitForTimeout(900);
    const phone = boards.getBoard(t.id).nodes[t.byName("Phone")];
    const pasted = boards.getBoard(t.id).nodes[phone.children![phone.children!.length - 1]];
    return pasted.type === "frame" && pasted.children?.length === 2 ? "ok" : `pasted: ${pasted.type} with ${pasted.children?.length ?? 0} layers`;
  },
  async "on a board, a fill takes a token from the picker, shows its name and draws its colour"(page) {
    const t = await openTestBoard(page);
    const phone = t.byName("Phone");
    // A token that is another token, so the panel and the canvas both resolve it through two.
    await S(page, async () => (await import("/ui/board-state.js" as string)).commit([{ op: "token", name: "--brand", value: "#ff3366" }, { op: "token", name: "--accent", value: "var(--brand)" }]));
    await S(page, async (id: string) => (await import("/ui/board-state.js" as string)).select(id), phone);
    await page.waitForTimeout(300);
    const fill = page.locator(".bd-right section", { has: page.locator("h3", { hasText: /^Fill$/ }) });
    await fill.locator(".bd-prow-main").first().click();
    await page.waitForTimeout(300);
    await page.locator(".pop .cp-token", { hasText: "accent" }).click();
    await page.waitForTimeout(900);
    const saved = boards.getBoard(t.id).nodes[phone].style.backgroundColor;
    const label = (await fill.locator(".bd-prow-main .lbl").first().textContent())?.trim();
    const swatch = await fill.locator(".bd-prow-main .bd-swatch").first().evaluate((el) => getComputedStyle(el).backgroundImage);
    const on = (await page.locator(".pop .cp-token.on").textContent())?.trim();
    const drawn = await S(page, (id: string) => getComputedStyle(document.querySelector(`.bd-world [data-bid="${id}"]`)!).backgroundColor, phone);
    if (saved !== "var(--accent)") return `the fill was saved as ${saved}`;
    if (label !== "accent") return `the fill's row says "${label}", not the token's name`;
    if (!swatch.includes("rgb(255, 51, 102)")) return `the row's swatch is ${swatch.slice(0, 80)}`;
    if (on !== "accent") return `the picker marks ${on ?? "no token"} as the one in use`;
    return drawn === "rgb(255, 51, 102)" ? "ok" : `the canvas draws ${drawn}`;
  },
  async "on a board, a colour becomes a token in one step, and the token list counts and selects its layers"(page) {
    const t = await openTestBoard(page);
    const one = t.byName("Row One");
    const two = t.byName("Row Two");
    await S(page, async (id: string) => (await import("/ui/board-state.js" as string)).select(id), one);
    await page.waitForTimeout(300);
    const fill = page.locator(".bd-right section", { has: page.locator("h3", { hasText: /^Fill$/ }) });
    await fill.locator(".bd-prow-main").first().click();
    await page.waitForTimeout(300);
    await page.locator(".pop .cp-make").click();
    await page.locator(".pop .cp-tokens input").fill("card");
    await page.locator(".pop .cp-tokens input").press("Enter");
    await page.waitForTimeout(900);
    const made = boards.getBoard(t.id);
    const token = made.tokens.find((x) => x.name === "--card");
    if (token?.value !== "#ffffff") return `the token is ${JSON.stringify(token)}`;
    if (made.nodes[one].style.backgroundColor !== "var(--card)") return `the row's fill is ${made.nodes[one].style.backgroundColor}`;
    await page.keyboard.press("Escape");
    await S(page, async () => (await import("/ui/board-state.js" as string)).undo());
    await page.waitForTimeout(900);
    const undone = boards.getBoard(t.id);
    if (undone.tokens.length || undone.nodes[one].style.backgroundColor) return `one undo left ${undone.tokens.length} token(s) and the fill ${undone.nodes[one].style.backgroundColor}`;
    await S(page, async (id: string) => {
      const s = await import("/ui/board-state.js" as string);
      s.redo();
      s.commit([{ op: "set", id, style: { background: null, backgroundColor: "var(--card)" } }]);
      s.select([]);
    }, two);
    await page.waitForTimeout(600);
    const row = page.locator(".bd-right .bd-token", { has: page.locator("code", { hasText: /^card$/ }) });
    const count = (await row.locator(".bd-uses").textContent())?.trim();
    await row.locator(".bd-uses").click();
    await page.waitForTimeout(300);
    const picked = (await boardSel(page)).split(",").sort().join(",");
    if (count !== "2×") return `the token list says ${count} layers use it`;
    return picked === "Row One,Row Two" ? "ok" : `a click on the count selected ${picked || "nothing"}`;
  },
  async "the Images panel's grids fit the panel"(page) {
    await setDesign(page, { shots: null, groups: null, scene: phone(), leftTab: "images", leftOpen: true });
    await page.waitForTimeout(1200);
    return S(page, () => {
      const bad: string[] = [];
      for (const g of document.querySelectorAll(".panel.left .sticker-grid, .panel.left .image-grid")) {
        const r = g.getBoundingClientRect();
        for (const t of g.querySelectorAll(":scope > button, :scope > .image-tile")) {
          const k = t.getBoundingClientRect();
          if (k.right > r.right + 1 || k.left < r.left - 1) bad.push(`${g.className}: a tile runs past the edge`);
        }
        const next = g.parentElement?.nextElementSibling?.getBoundingClientRect();
        if (next && next.top < r.bottom - 1) bad.push(`${g.className}: overlaps what follows`);
      }
      return bad.length ? [...new Set(bad)].join("; ") : "ok";
    });
  },
  async "clicking a sticker, an illustration and a picture adds each"(page) {
    await setDesign(page, { shots: null, groups: null, scene: phone(), leftTab: "images", leftOpen: true });
    await page.waitForTimeout(1200);
    for (const sel of [".sticker-grid:not(.art-grid) button >> nth=2", ".art-grid button >> nth=4", ".image-grid .image-tile > button:first-child >> nth=0"]) {
      await page.locator(sel).scrollIntoViewIfNeeded();
      await page.locator(sel).click();
      await page.waitForTimeout(800);
    }
    await page.waitForTimeout(1000);
    const n = await S(page, async () => ((await import("/ui/store.js" as string)).S.scene.images ?? []).length);
    const shown = await shownOnCanvas(page);
    return n === 3 && shown === 3 ? "ok" : `${n} added, ${shown} shown`;
  },
  async "dragging a sticker, an illustration and a picture onto a blank screen of a square set lands each"(page) {
    const full = phone({ canvas: "1:1", layout: "custom", headline: "Hi" });
    const blank = { devices: [], background: "cream-grain", canvas: "1:1", layout: "custom" };
    await setDesign(page, { shots: [full, full, blank].map((scene) => ({ scene })), shot: 2, groups: null, scene: blank, leftTab: "images", leftOpen: true });
    await page.waitForTimeout(1800);
    for (const sel of [".sticker-grid:not(.art-grid) button >> nth=5", ".art-grid button >> nth=2", ".image-grid .image-tile > button:first-child >> nth=0"]) await dragToCanvas(page, sel);
    await page.waitForTimeout(1000);
    const imgs = await S(page, async () => ((await import("/ui/store.js" as string)).S.scene.images ?? []) as Array<{ x: number; y: number; src: string }>);
    const shown = await shownOnCanvas(page);
    const inside = imgs.every((b) => b.x > 0 && b.x < 1 && b.y > 0 && b.y < 1);
    const builtIns = imgs.slice(0, 2).every((b) => /^(sticker|art):/.test(b.src));
    const ghost = await S(page, () => Boolean(document.querySelector(".shape-ghost")));
    return imgs.length === 3 && shown === 3 && inside && builtIns && !ghost ? "ok" : `${imgs.length} added (${imgs.map((b) => b.src.split("/").pop()).join(", ")}), ${shown} shown, inside ${inside}, ghost left ${ghost}`;
  },
  async "an illustration takes its colour"(page) {
    await setDesign(page, { shots: null, groups: null, scene: phone({ images: [{ src: "art:blob-1", x: 0.3, y: 0.3, height: 0.2, tint: "#ff0000" }] }) });
    await page.waitForTimeout(1500);
    return S(page, () => {
      const t = document.querySelector(".stage .artboard .image-body .tinted");
      if (!t) return "no coloured layer";
      const cs = getComputedStyle(t);
      const mask = cs.webkitMaskImage || cs.maskImage || "";
      return /255, 0, 0/.test(cs.backgroundColor) && mask.includes("url") && t.getBoundingClientRect().width > 4 ? "ok" : `colour ${cs.backgroundColor}, mask ${mask.slice(0, 40)}`;
    });
  },
  async "the squiggly underline draws, and Wavy underline is the headline's Accent"(page) {
    await setDesign(page, { shots: null, groups: null, scene: phone({ headline: "Say it **wavy**", textStyle: { accentMark: "squiggle", accentColor: "#e0662a" } }), selected: "caption", rightOpen: true });
    await page.waitForTimeout(1500);
    return S(page, () => {
      const mark = [...document.querySelectorAll<HTMLElement>(".stage .artboard .mark")].some((x) => (x.style.backgroundImage || "").includes("svg"));
      // Accent is a dropdown now: its button shows the mark in use.
      const wavy = [...document.querySelectorAll(".panel.right .dd-btn")].some((b) => b.textContent?.trim() === "Wavy underline");
      return mark && wavy ? "ok" : `mark ${mark}, Wavy underline shown ${wavy}`;
    });
  },
  async "the store page's app icon can be chosen, and is still there after a reload"(page) {
    await setDesign(page, { shots: null, groups: null, sceneName: "Icon test", appIcon: null, scene: phone({ headline: "Hi" }) });
    await page.waitForTimeout(800);
    await S(page, async () => (await import("/ui/store.js" as string)).set({ modal: { kind: "storePage" } }));
    await page.waitForTimeout(700);
    await page.locator(".stp-icon").click();
    await page.waitForTimeout(700);
    await page.locator(".stp-icon-menu .pics button >> nth=0").click();
    await page.waitForTimeout(700);
    const before = await S(page, () => ((document.querySelector(".stp-icon img") as HTMLImageElement | null)?.naturalWidth ?? 0) > 0);
    await S(page, async () => {
      const st = await import("/ui/store.js" as string);
      st.set({ modal: null });
      await st.flushPersist?.();
      await st.saveSceneNow();
    });
    await page.waitForTimeout(1000);
    await page.reload({ waitUntil: "networkidle" });
    await page.waitForTimeout(1500);
    await S(page, async () => (await import("/ui/store.js" as string)).set({ modal: { kind: "storePage" } }));
    await page.waitForTimeout(900);
    const after = await S(page, () => ((document.querySelector(".stp-icon img") as HTMLImageElement | null)?.naturalWidth ?? 0) > 0);
    return before && after ? "ok" : `shown ${before}, after a reload ${after}`;
  },
  async "deleting an unused picture deletes it; Undo brings it back"(page) {
    await setDesign(page, { shots: null, groups: null, scene: phone(), appIcon: null, leftTab: "images", leftOpen: true });
    await page.waitForTimeout(900);
    await S(page, async (p: string) => (await import("/ui/actions.js" as string)).deletePicture(p), unused);
    await page.waitForTimeout(700);
    const gone = !existsSync(unused) && !(await listed(unused));
    await undoToast(page);
    await page.waitForTimeout(700);
    const back = existsSync(unused) && (await listed(unused));
    return gone && back ? "ok" : `deleted ${gone}, back ${back}`;
  },
  async "deleting a picture the open design uses keeps it on the design; Undo lists it again"(page) {
    await setDesign(page, { shots: null, groups: null, sceneId: null, scene: phone({ images: [{ src: used, x: 0.5, y: 0.2, height: 0.1 }] }), leftTab: "images", leftOpen: true });
    await page.waitForTimeout(1400);
    await S(page, async (p: string) => (await import("/ui/actions.js" as string)).deletePicture(p), used);
    await page.waitForTimeout(1400);
    const inList = await listed(used);
    const said = await toasts(page);
    const shown = await S(page, () => [...document.querySelectorAll<HTMLImageElement>(".stage .artboard .image-body img")].some((i) => i.naturalWidth > 0));
    await undoToast(page);
    await page.waitForTimeout(700);
    const relisted = await listed(used);
    return existsSync(used) && !inList && shown && /Removed/.test(said) && relisted ? "ok" : `file ${existsSync(used)}, listed ${inList}, on the design ${shown}, "${said.slice(0, 70)}", listed after Undo ${relisted}`;
  },
  async "a design of just words and doodles starts, exports and shows its finished look"(page) {
    await S(page, async () => (await import("/ui/actions.js" as string)).newScene());
    await page.waitForTimeout(1000);
    const welcome = await S(page, () => Boolean(document.querySelector(".welcome")));
    await page.locator(".welcome-alt .alt", { hasText: "Start with text" }).click();
    await page.waitForTimeout(1600);
    const r = await S(page, async () => {
      const st = await import("/ui/store.js" as string);
      const a = await import("/ui/actions.js" as string);
      const exportOn = !([...document.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Export") as HTMLButtonElement | undefined)?.disabled;
      // Its headline is the stand-in, so Export asks first; going ahead exports it as it is.
      const going = a.exportImage();
      await new Promise((r) => setTimeout(r, 400));
      const asked = st.S.modal?.kind === "confirm" && /placeholder/i.test(st.S.modal.title);
      ([...document.querySelectorAll(".sheet-foot button")].find((b) => b.textContent?.includes("Export anyway")) as HTMLButtonElement | undefined)?.click();
      await going;
      for (let i = 0; i < 100 && st.S.rendering; i++) await new Promise((r) => setTimeout(r, 400));
      const exported = asked && st.S.toasts.some((t: { title: string }) => /exported/i.test(t.title));
      // The editor stays put; the finished look settles over the design.
      let finished = false;
      for (let i = 0; i < 60 && !finished; i++) {
        await new Promise((r) => setTimeout(r, 400));
        finished = Boolean(document.querySelector(".stage .artboard > img.finished.on"));
      }
      return { exportOn, exported, finished, stayed: !st.S.modal, layout: Boolean(st.S.layout) };
    });
    return welcome && r.exportOn && r.exported && r.finished && r.stayed && r.layout ? "ok" : `start screen ${welcome}, ${JSON.stringify(r)}`;
  },
  async "the first screenshot of a new design offers starting designs; picking one goes to the editor"(page) {
    await S(page, async () => (await import("/ui/actions.js" as string)).newScene());
    await page.waitForTimeout(800);
    await S(page, async (p: string) => (await import("/ui/actions.js" as string)).addDevice(p), shot);
    await page.locator(".start-pick .pick-card").first().waitFor({ timeout: 20000 });
    const cards = await page.locator(".start-pick .pick-card").count();
    await page.waitForFunction(() => !(window as any).studio.state.designing, null, { timeout: 30000 });
    await page.locator(".start-pick .pick-card", { hasText: "Tilted" }).click();
    await page.waitForFunction(() => !(window as any).studio.state.starting, null, { timeout: 30000 });
    await page.waitForTimeout(800);
    const r = await S(page, () => ({ canvas: Boolean(document.querySelector(".stage .artboard")), pick: Boolean(document.querySelector(".start-pick")), tilted: (window as any).studio.state.scene.layout === "tilted" }));
    return cards >= 6 && r.canvas && !r.pick && r.tilted ? "ok" : `${cards} cards, ${JSON.stringify(r)}`;
  },
  async "a design of just words comes back after a reload"(page) {
    await S(page, async () => (await import("/ui/actions.js" as string)).newScene());
    await page.waitForTimeout(800);
    await page.locator(".welcome-alt .alt", { hasText: "Start with text" }).click();
    await page.waitForTimeout(1400);
    await S(page, async () => (await import("/ui/store.js" as string)).flushPersist?.());
    await page.waitForTimeout(900);
    await page.reload({ waitUntil: "networkidle" });
    await page.waitForTimeout(1800);
    return S(page, async () => {
      const st = await import("/ui/store.js" as string);
      const welcome = Boolean(document.querySelector(".welcome"));
      return st.S.scene.headline && st.S.layout && !welcome ? "ok" : `headline ${Boolean(st.S.scene.headline)}, laid out ${Boolean(st.S.layout)}, start screen ${welcome}`;
    });
  },
  async "a set with a phone screen, a words screen and a blank screen exports, and a words screen exports as a video"(page) {
    const words = { devices: [], background: "cream-grain", canvas: "1:1", layout: "custom", headline: "Just **words**", textStyle: { accentMark: "squiggle" }, images: [{ src: "art:arrow-loop", x: 0.3, y: 0.6, height: 0.1 }] };
    const blank = { devices: [], background: "cream-grain", canvas: "1:1", layout: "custom" };
    await setDesign(page, { sceneName: "Set export", shots: [phone({ canvas: "1:1", layout: "custom", headline: "One" }), words, blank].map((scene) => ({ scene })), shot: 1, groups: null, scene: words });
    await page.waitForTimeout(1400);
    await S(page, async () => (await import("/ui/actions.js" as string)).exportWholeSet());
    await waitIdle(page);
    const set = await toasts(page);
    await S(page, async () => {
      const st = await import("/ui/store.js" as string);
      st.set({ toasts: [], exportOpts: { ...st.S.exportOpts, video: { ...st.S.exportOpts.video, screens: "this" } } });
      await (await import("/ui/actions.js" as string)).exportVideo();
    });
    await waitIdle(page);
    const video = await toasts(page);
    const ok = /export/i.test(set) && !/nothing to export|couldn/i.test(set) && /video exported/i.test(video);
    return ok ? "ok" : `set: "${set.slice(0, 90)}", video: "${video.slice(0, 90)}"`;
  },
  async "a whole-set template keeps a square set square; iPad screenshots on an iPhone canvas get the iPad canvas"(page) {
    const sq = phone({ canvas: "1:1", layout: "custom" });
    await setDesign(page, { shots: [sq, sq].map((scene) => ({ scene })), shot: 0, groups: null, scene: sq });
    await page.waitForTimeout(700);
    const apply = (id: string) => S(page, async (id: string) => {
      const st = await import("/ui/store.js" as string);
      await (await import("/ui/actions.js" as string)).applySetTemplate(id);
      await new Promise((r) => setTimeout(r, 1200));
      return [st.S.scene.canvas, st.S.shots?.length];
    }, id);
    const square = await apply("clean");
    await setDesign(page, { shots: null, groups: null, scene: { devices: [{ screenshot: ipad }], background: "cream-grain", canvas: "iphone-6.9" } });
    await page.waitForTimeout(700);
    const tablet = await apply("tablet");
    return square[0] === "1:1" && square[1] === 5 && tablet[0] === "ipad-13" ? "ok" : `square set → ${square}, iPad screenshots → ${tablet}`;
  },
  async "the Templates panel's set previews load, with the ones made for the screenshot first"(page) {
    await setDesign(page, { shots: null, groups: null, scene: { devices: [{ screenshot: ipad }], background: "cream-grain", canvas: "ipad-13" }, leftTab: "designs", leftOpen: true });
    // Which screenshot it is (iPad here) comes from the engine: give it a moment to reorder them.
    let first = "";
    const f0 = Date.now();
    while (!/iPad spread/.test(first) && Date.now() - f0 < 15_000) {
      await page.waitForTimeout(250);
      first = await S(page, () => document.querySelector(".set-template b")?.textContent ?? "");
    }
    if (process.env.UI_TEST_TIMES) console.log(`    (made-for order: ${Date.now() - f0} ms)`);
    // Each preview draws five screens, and all sixteen are asked for at once: give them time.
    const t0 = Date.now();
    let loaded = 0;
    while (loaded < 2 && Date.now() - t0 < 150_000) {
      await page.waitForTimeout(1000);
      loaded = await S(page, () => [...document.querySelectorAll<HTMLImageElement>(".set-template .strip img")].slice(0, 3).filter((i) => i.naturalWidth > 0).length);
    }
    if (process.env.UI_TEST_TIMES) console.log(`    (previews: ${Math.round((Date.now() - t0) / 1000)} s)`);
    return /iPad spread/.test(first) && loaded >= 2 ? "ok" : `first "${first}", ${loaded} previews loaded in ${Math.round((Date.now() - t0) / 1000)} s`;
  },
  async "a device dragged onto a seam sits across both screens; dragged onto the next screen it moves there"(page) {
    const scenes = [0, 1, 2].map((i) => ({ devices: i === 1 ? [{ screenshot: shot, x: 0.5, y: 0.55, height: 0.7, anchor: "center" }] : [], background: "cream-grain", canvas: "iphone-6.9", layout: "custom", headline: `Screen ${i + 1}` }));
    await setDesign(page, { shots: scenes.map((scene) => ({ scene })), shot: 1, groups: null, scene: scenes[1], leftOpen: false, selected: null });
    await page.waitForTimeout(2000);
    const state = () => S(page, async () => {
      const st = await import("/ui/store.js" as string);
      const shots = st.allShots() as Array<{ scene: { devices: Array<{ x: number }>; spill?: Array<{ x: number }> } }>;
      return { shot: st.S.shot, devices: shots.map((x) => x.scene.devices.map((d) => d.x)), spill: shots.map((x) => (x.scene.spill ?? []).map((d) => d.x)) };
    });
    /** Drag the device on the canvas by a share of the screen's width, reading the seam label just before letting go. */
    const drag = async (by: number) => {
      const dev = (await page.locator(".stage .artboard .ent-device").first().boundingBox())!;
      const board = (await page.locator(".stage .artboard").first().boundingBox())!;
      const sx = dev.x + dev.width / 2;
      const sy = dev.y + dev.height / 2;
      await page.mouse.move(sx, sy);
      await page.mouse.down();
      for (let k = 1; k <= 14; k++) await page.mouse.move(sx + board.width * by * (k / 14), sy);
      await page.waitForTimeout(150);
      const label = await S(page, () => document.querySelector(".seam-label")?.textContent ?? "");
      await page.mouse.up();
      await page.waitForTimeout(1800);
      return label;
    };
    // Near the left seam (not exactly on it): it's pulled across it, and says so.
    const label = await drag(-0.47);
    const across = await state();
    const onSeam = across.shot === 1 && across.devices[1][0] === 0 && across.spill[0].some((x) => Math.abs(x - 1) < 0.01);
    // Now well onto the next screen: it moves there, and that screen opens with it.
    await drag(1.45);
    const moved = await state();
    const handed = moved.shot === 2 && moved.devices[1].length === 0 && moved.devices[2].length === 1 && Math.abs(moved.devices[2][0] - 0.5) < 0.15;
    return /Across 1 & 2/.test(label) && onSeam && handed ? "ok" : `label "${label}", across ${JSON.stringify(across)}, moved ${JSON.stringify(moved)}`;
  },
  async "the scratchpad comes first among the boards, and stays"(page) {
    boards.createBoard("A newer board", "studio");
    await S(page, async () => {
      const st = await import("/ui/store.js" as string);
      st.set({ libraryShelf: "boards" });
      (await import("/ui/scenes.js" as string)).openScenesPage();
    });
    await page.locator('.sp-shelves [role="tab"]', { hasText: "Boards" }).click();
    await page.waitForSelector(".bd-card");
    const first = await S(page, () => {
      const c = document.querySelector(".bd-card")!;
      return `${c.getAttribute("data-board")} ${c.querySelector(".sp-badge.scratch")?.textContent ?? ""}`;
    });
    if (first !== "scratchpad Scratchpad") return `the first board is "${first}"`;
    await page.locator('.bd-card[data-board="scratchpad"] .sp-more').click();
    await page.waitForTimeout(200);
    const items = await S(page, () => [...document.querySelectorAll(".ctx-item .ctx-label")].map((x) => x.textContent).join(","));
    await page.keyboard.press("Escape");
    return items === "Open,Rename,Duplicate" ? "ok" : `its menu has ${items}`;
  },
  async "My designs' list lines up in columns, and the store page keeps its own layout"(page) {
    // Two saved designs, so the list has rows.
    for (const name of ["List test A", "List test B"]) {
      await setDesign(page, { shots: null, groups: null, sceneId: null, sceneName: name, scene: phone({ headline: name }) });
      await S(page, async () => (await import("/ui/store.js" as string)).saveSceneNow());
      await page.waitForTimeout(500);
    }
    await S(page, async () => {
      const st = await import("/ui/store.js" as string);
      st.set({ scenesPrefs: { ...st.S.scenesPrefs, layout: "list" } });
      (await import("/ui/scenes.js" as string)).openScenesPage();
    });
    await page.waitForTimeout(1800);
    const list = await S(page, () => {
      const rows = [...document.querySelectorAll(".sp-list .sp-row")];
      if (rows.length < 3) return `only ${rows.length} rows`;
      if (getComputedStyle(rows[0]).display !== "grid") return `rows are laid out as ${getComputedStyle(rows[0]).display}, not a grid`;
      // Each column starts where its heading does, on every row.
      const lefts = rows.map((r) => [...r.children].map((c) => Math.round(c.getBoundingClientRect().left)));
      const off = lefts.slice(1).find((row) => row.some((x, i) => Math.abs(x - lefts[0][i]) > 2));
      return off ? `columns don't line up: heading ${lefts[0]} vs row ${off}` : "ok";
    });
    const heading = await S(page, () => {
      const h = document.querySelector(".sp-head");
      return h ? getComputedStyle(h).display : "none";
    });
    await S(page, async () => (await import("/ui/scenes.js" as string)).closeScenesPage());
    await setDesign(page, { shots: null, groups: null, scene: phone({ headline: "Hi" }) });
    await page.waitForTimeout(600);
    await S(page, async () => (await import("/ui/store.js" as string)).set({ modal: { kind: "storePage" } }));
    await page.waitForTimeout(800);
    const store = await S(page, () => {
      const row = document.querySelector(".store-page .stp-row");
      const head = document.querySelector(".store-page .stp-head");
      return row && head && getComputedStyle(row).display === "flex" && getComputedStyle(head).display === "flex" ? "ok" : "the store page lost its layout";
    });
    return list === "ok" && heading !== "flex" && store === "ok" ? "ok" : `list: ${list}; Scenes heading laid out as ${heading}; store: ${store}`;
  },
  async "moving between the screens of a set, every screen keeps its device"(page) {
    const sc = (i: number) => phone({ canvas: "1:1", layout: "custom", headline: `S${i}` });
    await setDesign(page, { shots: [0, 1, 2, 3].map((i) => ({ scene: sc(i) })), shot: 0, groups: null, scene: sc(0), leftOpen: false });
    await page.waitForTimeout(2200);
    for (const to of [2, 3, 0]) {
      await S(page, async (to: number) => (await import("/ui/actions.js" as string)).goToShot(to), to);
      await page.waitForTimeout(1100);
    }
    const counts = await S(page, () => [...document.querySelectorAll(".ghost-wrap.set")].map((g) => g.querySelectorAll("img").length));
    return counts.length === 3 && counts.every((c) => c > 0) ? "ok" : `pictures on the other screens: ${counts}`;
  },
  async "typing in a slider's box uses the units it shows, and words that aren't a value keep it"(page) {
    await setDesign(page, { shots: null, groups: null, scene: phone({ layout: "custom", texts: [{ text: "Hello", x: 0.5, y: 0.2, size: 0.05 }] }), selected: "text-1", rightOpen: true });
    await page.waitForTimeout(1500);
    const field = page.locator(".panel.right .row", { has: page.locator("label", { hasText: /^Size$/ }) }).locator("input.val").first();
    const size = () => S(page, async () => {
      const st = await import("/ui/store.js" as string);
      return { size: st.S.scene.texts?.[0]?.size as number, h: st.S.layout.canvas.height as number };
    });
    // Shown in pixels: 100 is 100 px, not the most the slider goes to.
    await field.fill("100");
    await field.press("Enter");
    await page.waitForTimeout(500);
    const a = await size();
    const shown = await field.inputValue();
    // Words that aren't a size leave it as it was.
    await field.fill("bigger");
    await field.press("Enter");
    await page.waitForTimeout(500);
    const b = await size();
    const back = await field.inputValue();
    const px = Math.round(a.size * a.h);
    return Math.abs(px - 100) <= 2 && shown === `${px} px` && b.size === a.size && back === shown ? "ok" : `typing 100 made it ${px} px (box "${shown}"); "bigger" left ${Math.round(b.size * b.h)} px (box "${back}")`;
  },
  async "after undoing an added shape nothing stays selected, and Delete on a stale selection is safe"(page) {
    await setDesign(page, { shots: null, groups: null, scene: phone() });
    await page.waitForTimeout(1000);
    const r = await S(page, async () => {
      const st = await import("/ui/store.js" as string);
      (await import("/ui/actions.js" as string)).addShape("box");
      await new Promise((r) => setTimeout(r, 300));
      const picked = st.S.selected;
      st.undo();
      await new Promise((r) => setTimeout(r, 300));
      return { picked, after: st.S.selected, shapes: (st.S.scene.shapes ?? []).length };
    });
    await page.keyboard.press("Delete");
    // Even a selection left pointing at nothing (set by hand here) doesn't make Delete throw.
    await S(page, async () => (await import("/ui/store.js" as string)).set({ selected: "image-3" }));
    await page.waitForTimeout(100);
    await page.keyboard.press("Delete");
    await page.waitForTimeout(300);
    const devices = await S(page, async () => (await import("/ui/store.js" as string)).S.scene.devices.length);
    return String(r.picked).startsWith("shape-") && r.after === null && r.shapes === 0 && devices === 1 ? "ok" : `added ${r.picked}, after undo selected ${r.after} with ${r.shapes} shapes, ${devices} devices left`;
  },
  async "Escape mid-drag puts a device back, Delete waits for the drag, and a lost mouse-up ends it"(page) {
    await setDesign(page, { shots: null, groups: null, scene: phone({ layout: "custom", devices: [{ screenshot: shot, x: 0.5, y: 0.55, height: 0.6, anchor: "center" }] }) });
    await page.waitForTimeout(1500);
    const xs = () => S(page, async () => (await import("/ui/store.js" as string)).S.scene.devices.map((d: { x: number }) => d.x) as number[]);
    const board = (await page.locator(".stage .artboard").first().boundingBox())!;
    const dev = (await page.locator(".stage .artboard .ent-device").first().boundingBox())!;
    const [sx, sy] = [dev.x + dev.width / 2, dev.y + dev.height / 2];
    const x0 = (await xs())[0];
    // Escape: nothing is written, and the device stays selected.
    await page.mouse.move(sx, sy);
    await page.mouse.down();
    await page.mouse.move(sx + 60, sy, { steps: 6 });
    await page.keyboard.press("Escape");
    await page.mouse.move(sx + 120, sy, { steps: 4 });
    await page.mouse.up();
    await page.waitForTimeout(600);
    const esc = await xs();
    const sel = await S(page, async () => (await import("/ui/store.js" as string)).S.selected);
    if (esc[0] !== x0 || sel !== "device-1") return `after Escape the device is at ${esc[0]} (was ${x0}), selected ${sel}`;
    // Delete mid-drag: ignored; the device lands where it's let go.
    await page.mouse.move(sx, sy);
    await page.mouse.down();
    await page.mouse.move(sx + 60, sy, { steps: 6 });
    await page.keyboard.press("Delete");
    await page.mouse.up();
    await page.waitForTimeout(800);
    const del = await xs();
    if (del.length !== 1 || del[0] <= x0) return `Delete mid-drag left ${del.length} device(s), at ${del}`;
    // The window loses focus mid-drag (⌘Tab), so the mouse-up never comes: the drag ends there.
    const d2 = (await page.locator(".stage .artboard .ent-device").first().boundingBox())!;
    const [tx, ty] = [d2.x + d2.width / 2, d2.y + d2.height / 2];
    await page.mouse.move(tx, ty);
    await page.mouse.down();
    await page.mouse.move(tx - 40, ty, { steps: 5 });
    await S(page, () => window.dispatchEvent(new Event("blur")));
    await page.mouse.move(tx - 160, ty, { steps: 5 });
    await page.waitForTimeout(300);
    const lost = await xs();
    await page.mouse.up();
    const by = (lost[0] - del[0]) * board.width;
    return by < -15 && by > -90 ? "ok" : `after a lost mouse-up the device moved ${Math.round(by)} px (by 40 when the window lost focus, 160 by the end)`;
  },
  async "Space and Tab are the canvas's only while no control has the keyboard"(page) {
    await setDesign(page, { shots: null, groups: null, scene: phone({ headline: "Hi" }), selected: null });
    await page.waitForTimeout(1500);
    const st = () => S(page, async () => {
      const s = (await import("/ui/store.js" as string)).S;
      return { sel: s.selected as string | null, ids: s.layout.entities.map((e: { id: string }) => e.id) as string[], space: Boolean(document.querySelector(".viewport.space")), zoom: document.querySelector(".zoom-ctl .pct")?.textContent ?? "" };
    });
    // Nothing focused: Tab steps through the canvas's items, and past the last one lets go of them.
    await S(page, () => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.press("Tab");
    const first = await st();
    for (let i = 1; i < first.ids.length; i++) await page.keyboard.press("Tab");
    const last = await st();
    await page.keyboard.press("Tab");
    const out = await st();
    if (first.sel !== first.ids[0] || last.sel !== first.ids[first.ids.length - 1] || out.sel !== null) return `Tab selected ${first.sel}, then ${last.sel}, then ${out.sel} (items ${first.ids})`;
    // A button with the keyboard keeps Space (it presses it, rather than panning) and Tab (focus moves on).
    await S(page, async () => {
      (document.activeElement as HTMLElement | null)?.blur();
      (await import("/ui/store.js" as string)).set({ selected: "device-1" });
    });
    await page.keyboard.press("Shift");
    await page.focus('.zoom-ctl button[title^="Zoom in"]');
    const visible = await S(page, () => document.activeElement!.matches(":focus-visible"));
    const z0 = await st();
    await page.keyboard.down("Space");
    const held = await st();
    await page.keyboard.up("Space");
    await page.waitForTimeout(200);
    const z1 = await st();
    await page.keyboard.press("Tab");
    const tabbed = await st();
    if (!visible) return "the zoom button, focused after a key, isn't :focus-visible";
    if (held.space || z1.zoom === z0.zoom) return `with the zoom button focused, Space ${held.space ? "panned" : "didn't pan"} and the zoom went ${z0.zoom} → ${z1.zoom}`;
    if (tabbed.sel !== "device-1") return `with a button focused, Tab changed the selection to ${tabbed.sel}`;
    // Nothing focused again: Space pans, and switching to another app mid-pan lets go of it.
    await S(page, () => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.down("Space");
    await page.waitForTimeout(100);
    const panning = await st();
    await S(page, () => window.dispatchEvent(new Event("blur")));
    await page.waitForTimeout(100);
    const after = await st();
    await page.keyboard.up("Space");
    return panning.space && !after.space ? "ok" : `Space with nothing focused: pan ${panning.space}; after the window lost focus: still ${after.space}`;
  },
  async "Enter while composing Japanese keeps the text being edited, and emptying a text lets go of it"(page) {
    await setDesign(page, { shots: null, groups: null, scene: phone({ layout: "custom", texts: [{ text: "First", x: 0.5, y: 0.2 }, { text: "Second", x: 0.5, y: 0.35 }] }), selected: "text-1" });
    await page.waitForTimeout(1500);
    await S(page, async () => (await import("/ui/canvas.js" as string)).canvasApi.editText("text-1"));
    await page.waitForSelector(".stage .editing[contenteditable]");
    // The Enter that confirms a word in an input method: isComposing, or Safari's keyCode 229.
    await S(page, () => {
      const el = document.querySelector(".stage .editing[contenteditable]")!;
      el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true, cancelable: true }));
      const safari = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
      Object.defineProperty(safari, "keyCode", { value: 229 });
      el.dispatchEvent(safari);
    });
    await page.waitForTimeout(200);
    const still = await S(page, () => Boolean(document.querySelector(".stage .editing[contenteditable]")));
    // Emptied (its words are all selected as editing starts) and finished: it goes, and nothing is left selected.
    await page.keyboard.press("Backspace");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(600);
    const r = await S(page, async () => {
      const s = (await import("/ui/store.js" as string)).S;
      return { texts: (s.scene.texts ?? []).map((t: { text: string }) => t.text).join(), sel: s.selected };
    });
    return still && r.texts === "Second" && r.sel === null ? "ok" : `editing after a composing Enter: ${still}; texts "${r.texts}", selected ${r.sel}`;
  },
  async "the set row never draws another design's screens, and says when it can't draw one"(page) {
    const a = (i: number) => phone({ canvas: "1:1", layout: "custom", headline: `A${i}` });
    await setDesign(page, { shots: [0, 1, 2].map((i) => ({ scene: a(i) })), shot: 0, groups: null, scene: a(0), leftOpen: false });
    await page.waitForTimeout(2200);
    const drawn = await S(page, () => document.querySelectorAll(".ghost-wrap.set img").length);
    // The next design's other screens can't be laid out (the engine is away for them).
    await page.route("**/api/layout", (route) => (/"B[12]"/.test(route.request().postData() ?? "") ? route.abort() : route.continue()));
    const b = (i: number) => ({ devices: [{ screenshot: unused }], background: "cream-grain", canvas: "1:1", layout: "custom", headline: `B${i}` });
    await setDesign(page, { shots: [0, 1, 2].map((i) => ({ scene: b(i) })), shot: 0, groups: null, scene: b(0) });
    await page.waitForTimeout(2200);
    const r = await S(page, () => ({ stale: [...document.querySelectorAll<HTMLImageElement>(".ghost-wrap.set img")].filter((i) => i.src.includes("phone.png")).length, tiles: document.querySelectorAll(".set-unshown").length }));
    await page.unroute("**/api/layout");
    if (!drawn) return "the first design's other screens weren't drawn";
    return !r.stale && r.tiles === 2 ? "ok" : `${r.stale} pictures of the first design's screens in the row, ${r.tiles} "couldn't show" tiles`;
  },
};

const engines = { chromium, webkit } as const;
const asked = process.argv.slice(2).filter((a) => a in engines) as Array<keyof typeof engines>;
let failed = 0;
try {
  for (const name of asked.length ? asked : (["chromium", "webkit"] as const)) {
    await fixtures();
    let browser: Browser;
    try {
      browser = await engines[name].launch();
    } catch (e) {
      console.error(`Can't start ${name}: run npx playwright install chromium webkit\n${(e as Error).message.split("\n")[0]}`);
      failed++;
      continue;
    }
    for (const [title, check] of Object.entries(CHECKS)) {
      // UI_ONLY="some words" runs just the checks whose titles match.
      if (process.env.UI_ONLY && !new RegExp(process.env.UI_ONLY, "i").test(title)) continue;
      const problems: string[] = [];
      const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
      page.on("pageerror", (e) => problems.push(`page error: ${e.message}`));
      // The backdrop's still is drawn on demand and may be refused for an unknown look: not a fault.
      page.on("response", (r) => r.status() >= 400 && !r.url().includes("/api/bg-preview") && problems.push(`${r.status()} ${decodeURIComponent(r.url()).replace(tmp, "…").slice(-80)}`));
      let result: string;
      try {
        await page.goto(BASE, { waitUntil: "networkidle" });
        await page.waitForTimeout(400);
        result = await check(page);
      } catch (e) {
        result = `threw: ${(e as Error).message.split("\n")[0]}`;
      }
      await page.close();
      const ok = result === "ok" && !problems.length;
      if (!ok) failed++;
      console.log(`${ok ? "PASS" : "FAIL"} ${name.padEnd(8)} ${title}${result === "ok" ? "" : ` — ${result}`}${problems.length ? ` — ${[...new Set(problems)].slice(0, 3).join(" | ")}` : ""}`);
    }
    await browser.close();
  }
} finally {
  server.close();
  await agentman.close();
  await closeBrowser();
  rmSync(tmp, { recursive: true, force: true });
}
console.log(failed ? `\n${failed} UI check${failed === 1 ? "" : "s"} failed.` : `\nAll UI checks passed.`);
process.exit(failed ? 1 : 0);
