/**
 * The Studio as people use it, in Chromium (the Electron desktop app's engine), with optional WebKit
 * (Safari): adding and dragging pictures, colour, accent marks, the store page icon, deleting
 * pictures, designs without a screenshot, exports, templates, devices carrying on across screens
 * and moving through a set. Each check watches for page errors and failed requests too. It starts
 * its own Studio on a free port with a throwaway library, so it never touches yours.
 *
 *   npm run test:ui                       Chromium (default)
 *   npm run test:ui -- webkit             WebKit (Safari)
 *   npm run test:ui -- chromium webkit    both engines
 *
 * Needs Playwright's browser once: npx playwright install chromium
 */
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium, webkit, type Browser, type Page } from "playwright";
// Tests never ask the Keychain (macOS would ask the person to allow it).
process.env.SCREENSHOTTER_NO_KEYCHAIN = "1";
// The checks drive the Studio itself, not the sign-in screen.
process.env.SCREENSHOTTER_NO_ACCOUNT = "1";

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
const { decodePng, pixelAt } = await import("../src/util/png.js");
const { closeBrowser } = await import("../src/render/browser.js");
const boards = await import("../src/board/store.js");
const boardCore = await import("../src/board/core.js");
const talk = await import("../src/board/comments.js");

/** UI_SHOTS=<folder> keeps a picture of the window at the moments checks call `picture`, to look at. */
async function picture(page: Page, name: string) {
  const dir = process.env.UI_SHOTS;
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  const engine = page.context().browser()?.browserType().name() ?? "browser";
  await page.screenshot({ path: path.join(dir, `${engine}-${name}.png`) });
}

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
  if (!existsSync(shot)) flat(shot, 1206, 2622, [242, 242, 247]);
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

/**
 * What's wrong with the colours of the screen showing: words that don't stand out from what's
 * behind them (4.5:1, or 3:1 for large words; what can't be used yet is let off, as WCAG does),
 * and big surfaces still in the other theme's colours (a dark panel left in light mode, or a white
 * one in dark). The design being made (artboards, a board's layers, thumbnails, words on photos)
 * isn't the app's and is left out.
 */
const themeAudit = async (page: Page) => {
  // tsx names inner functions with a helper the page doesn't have.
  await page.evaluate("globalThis.__name = globalThis.__name || ((f) => f)");
  return S(page, () => {
    const theme = document.documentElement.dataset.theme;
    const DESIGN = ".artboard, .demo-ab, .bd-world, .bd-card .art, .sp-thumb, .sp-mini, .shot, .look, .image-tile, .scene-thumb, .tl-clip, .clip-frames, .bezel-set, .sticker-grid, .recipe-img, .set-template, .frame-opt, .shape-prev, .work-shot, .stp-shot, .bd-asset, .bd-swatch, .chip-color, .swatch, .cp-sv, .cp-hue, .cp-presets, .tint, .bd-tints, iframe, video, canvas, img, svg";
    const rgba = (c: string): number[] | null => {
      const m = /rgba?\(([^)]+)\)/.exec(c);
      if (!m) return null;
      const p = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
      return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1];
    };
    const over = (top: number[], under: number[]) => [0, 1, 2].map((i) => top[i] * top[3] + under[i] * (1 - top[3])).concat(1);
    const lum = (c: number[]) => {
      const ch = (v: number) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
      return 0.2126 * ch(c[0]) + 0.7152 * ch(c[1]) + 0.0722 * ch(c[2]);
    };
    const ratio = (a: number[], b: number[]) => {
      const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
      return (x + 0.05) / (y + 0.05);
    };
    const probe = document.createElement("i");
    probe.style.color = "var(--text-off)";
    document.body.append(probe);
    const off = getComputedStyle(probe).color;
    probe.style.color = "var(--win)";
    const page0 = rgba(getComputedStyle(probe).color)!;
    probe.remove();
    /** What's behind an element: its own and its holders' backgrounds, laid over each other (null over a picture). */
    const behind = (el: Element | null): number[] | null => {
      const layers: number[][] = [];
      for (let e = el; e; e = e.parentElement) {
        const cs = getComputedStyle(e);
        const bg = rgba(cs.backgroundColor);
        if (bg && bg[3] > 0) layers.push(bg);
        if (bg && bg[3] >= 0.99) break;
        if (cs.backgroundImage !== "none" && !/gradient/.test(cs.backgroundImage)) return null;
      }
      return layers.reverse().reduce((under, top) => over(top, under), page0);
    };
    const opacity = (el: Element) => {
      let o = 1;
      for (let e: Element | null = el; e; e = e.parentElement) o *= Number(getComputedStyle(e).opacity);
      return o;
    };
    const name = (el: Element) => {
      const bits: string[] = [];
      for (let e: Element | null = el; e && bits.length < 3 && e !== document.body; e = e.parentElement) bits.unshift(e.tagName.toLowerCase() + (e.classList.length ? "." + [...e.classList].slice(0, 2).join(".") : ""));
      return bits.join(" > ");
    };
    const issues: string[] = [];
    const seen = new Set<string>();
    const note = (key: string, line: string) => {
      if (seen.has(key) || issues.length >= 40) return;
      seen.add(key);
      issues.push(line);
    };
    for (const el of document.querySelectorAll("body *")) {
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1 || r.bottom < 0 || r.right < 0 || r.top > innerHeight || r.left > innerWidth) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility === "hidden" || cs.display === "none") continue;
      if (el.closest(DESIGN)) continue;
      // Words.
      const words = [...el.childNodes].filter((n) => n.nodeType === 3 && n.textContent!.trim()).map((n) => n.textContent!.trim()).join(" ");
      if (words && !el.closest(":disabled, [aria-disabled='true']") && cs.color !== off) {
        const o = opacity(el);
        const bg = behind(el);
        const fg = rgba(cs.color);
        if (bg && fg && o > 0.05) {
          const k = ratio(over([fg[0], fg[1], fg[2], fg[3] * o], bg), bg);
          const size = parseFloat(cs.fontSize);
          const need = size >= 18.5 || (size >= 14 && Number(cs.fontWeight) >= 600) ? 3 : 4.5;
          if (k < need) note(`${name(el)}|${cs.color}`, `"${words.slice(0, 30)}" ${k.toFixed(2)}:1 (${name(el)})`);
        }
      }
      // Surfaces in the other theme's colours.
      const bg = rgba(cs.backgroundColor);
      if (bg && bg[3] >= 0.6 && r.width * r.height >= 4000 && !el.closest(".store-page, .btn.primary, .bd-sendbar-send, .tl-play")) {
        const L = lum(bg);
        if (theme === "light" ? L < 0.1 : L > 0.7) note(`surface ${name(el)}`, `a ${theme === "light" ? "dark" : "light"} surface ${cs.backgroundColor} (${name(el)}, ${Math.round(r.width)}×${Math.round(r.height)})`);
      }
    }
    return issues;
  });
};

/** Every screen of the app, one at a time, for the theme check: each a name and how to get there. */
const store = async (page: Page, patch: Record<string, unknown>) => S(page, async (p: Record<string, unknown>) => (await import("/ui/store.js" as string)).set(p), patch);
const SCREENS: Array<[string, (page: Page) => Promise<unknown>]> = [
  ["home", (page) => store(page, { modal: null })],
  ["confirm", (page) => store(page, { modal: { kind: "confirm", title: "Delete this board?", text: "The board and every artboard on it are removed.", confirm: "Delete", danger: true } })],
  ["menu", (page) => S(page, async () => {
    const st = await import("/ui/store.js" as string);
    st.set({ modal: null });
    (await import("/ui/menu.js" as string)).openMenu(400, 300, [{ label: "Duplicate", icon: "duplicate", kbd: "⌘D", run: () => undefined }, "-", { label: "Delete", icon: "trash", danger: true, run: () => undefined }]);
  })],
  ["toasts", (page) => S(page, async () => {
    const st = await import("/ui/store.js" as string);
    st.set({ menu: null });
    st.toast({ kind: "ok", title: "Exported 3 images", text: "In the library's exports", timeout: 0 });
    st.toast({ kind: "err", title: "Couldn't export", text: "The disk is full", timeout: 0 });
  })],
  ...(["general", "agents", "keys", "shortcuts"] as const).map((tab): [string, (page: Page) => Promise<unknown>] => [
    `settings-${tab}`,
    (page) => S(page, async (t: string) => {
      // The sheet takes its tab as it opens.
      const st = await import("/ui/store.js" as string);
      st.set({ toasts: [], modal: null });
      await new Promise((r) => setTimeout(r, 50));
      st.set({ modal: { kind: "settings", tab: t } });
    }, tab),
  ]),
  ["import-website", (page) => S(page, async () => (await import("/ui/web-import.js" as string)).openImportWebsite({ url: "example.com" }))],
  ["import-figma", (page) => S(page, async () => (await import("/ui/imports.js" as string)).openImportFigma({ url: "https://www.figma.com/design/abc/Landing" }))],
];

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
/** A board with a desktop artboard holding a 3-column grid of six cards and a flex tray beside it, open on the page. */
async function openGridBoard(page: Page) {
  const card = (t: string, color: string) => `<div data-name="Card ${t}" style="height:90px;border-radius:12px;background:${color};display:flex;align-items:center;justify-content:center"><span style="font-size:15px;font-weight:600;color:#fff">${t}</span></div>`;
  const b = boards.createBoard("Grid board", "studio");
  const made = boardCore.addHtmlOps(
    `<div data-name="Desk" style="width:900px;height:560px;background:#f6f5f2;font-family:Inter,sans-serif;padding:40px;display:flex;gap:32px;align-items:flex-start"><div data-name="Cards" style="display:grid;grid-template-columns:repeat(3, 1fr);gap:16px;width:540px;padding:16px;background:#fff;border-radius:16px">${["One", "Two", "Three", "Four", "Five", "Six"].map((t, i) => card(t, ["#1f6feb", "#8957e5", "#d1242f", "#1a7f37", "#bf8700", "#57606a"][i])).join("")}</div><div data-name="Tray" style="display:flex;flex-direction:column;gap:10px;width:200px"><div data-name="Chip" style="height:60px;border-radius:10px;background:#0a0a0a"></div></div></div>`,
    null,
    { page: b.pages[0].id },
  );
  boards.changeBoard(b.id, made.ops, "studio");
  await S(page, async (id: string) => (await import("/ui/board-state.js" as string)).openBoard(id), b.id);
  await page.waitForSelector(".bd-world [data-bid]");
  await page.waitForTimeout(900);
  const byName = (name: string) => Object.values(boards.getBoard(b.id).nodes).find((n) => n.name === name)!.id;
  return { id: b.id, byName };
}
/** An artboard laid out by hand holding a flex column (a stretched title, a flex box with a layer and words in it, a footer) and a loose layer. */
const DRAG_STAGE = `<div data-name="Stage" style="position:relative;width:800px;height:600px;background:#ffffff"><div data-name="Column" style="position:absolute;left:40px;top:40px;width:320px;display:flex;flex-direction:column;gap:12px;padding:16px;background:#eeeeee"><div data-name="Title" style="height:40px;background:#ff9999"></div><div data-name="Box" style="display:flex;align-items:center;gap:8px;padding:8px;height:60px;background:#99ccff"><div data-name="Inner" style="width:40px;height:40px;background:#003366"></div><p data-name="Words" style="margin:0;font-size:14px">Some words</p></div><div data-name="Footer" style="height:30px;background:#99cc99"></div></div><div data-name="Loose" style="position:absolute;left:500px;top:300px;width:80px;height:50px;background:#ffcc33"></div></div>`;

/** A board with one artboard written from `html`, open on the page; `byName` finds a layer's id. */
async function openMaskBoard(page: Page, htmlText: string) {
  const b = boards.createBoard("Mask test board", "studio");
  const made = boardCore.addHtmlOps(htmlText, null, { page: b.pages[0].id });
  boards.changeBoard(b.id, made.ops, "studio");
  await S(page, async (id: string) => (await import("/ui/board-state.js" as string)).openBoard(id), b.id);
  await page.waitForSelector(".bd-world [data-bid]");
  await page.waitForTimeout(900);
  const byName = (name: string) => Object.values(boards.getBoard(b.id).nodes).find((n) => n.name === name)!.id;
  return { id: b.id, byName };
}
/** The canvas's commit, for setting up a board as a person would have left it. */
const commitOps = (page: Page, ops: unknown[]) => S(page, async (ops: unknown[]) => (await import("/ui/board-state.js" as string)).commit(ops, { label: "Test" }), ops);
const childNames = (t: { id: string }, id: string) => (boards.getBoard(t.id).nodes[id].children ?? []).map((c) => boards.getBoard(t.id).nodes[c].name).join(",");

/** A pixel's colour, in words: red, blue, white, faded (red seen through partly), or its numbers. */
const colorName = ([r, g, b]: number[], faded = false) =>
  r > 200 && g < 80 && b < 80 ? "red" : r > 225 && g > 225 && b > 225 ? "white" : b > 200 && r < 80 && g < 80 ? "blue" : faded && r > 200 && g >= 80 && g <= 225 && Math.abs(g - b) < 30 ? "faded" : `rgb(${r},${g},${b})`;

/** The colours on screen at points of a layer `w` px wide (in its own px, from its top left). */
async function colorsAt(page: Page, id: string, w: number, pts: Array<[number, number]>, faded = false) {
  const box = await boxOf(page, id);
  const k = box.width / w;
  const f = decodePng(await page.screenshot());
  return pts.map(([x, y]) => colorName(pixelAt(f, box.x + x * k, box.y + y * k), faded));
}

/** How much of a part of a layer (x, y, width, height in its own px) shows red on screen. */
async function redShare(page: Page, id: string, w: number, [x0, y0, rw, rh]: number[]) {
  const box = await boxOf(page, id);
  const k = box.width / w;
  const f = decodePng(await page.screenshot());
  let red = 0;
  let all = 0;
  for (let y = y0; y < y0 + rh; y += 2)
    for (let x = x0; x < x0 + rw; x += 2) {
      all++;
      red += colorName(pixelAt(f, box.x + x * k, box.y + y * k)) === "red" ? 1 : 0;
    }
  return red / all;
}

const boardSel = (page: Page) => S(page, async () => {
  const m = await import("/ui/board-state.js" as string);
  return m.B.sel.map((id: string) => m.B.board.nodes[id].name).join(",");
});
const boxOf = async (page: Page, id: string) => (await page.locator(`.bd-world [data-bid="${id}"]`).boundingBox())!;

const bstate = (page: Page) => S(page, async () => {
  const m = await import("/ui/board-state.js" as string);
  return { sel: m.B.sel.map((id: string) => m.B.board.nodes[id]?.name ?? `?${id}`).join(","), editing: m.B.editing, past: m.B.past.map((e: { label: string }) => e.label).join("|"), future: m.B.future.length };
});
const textOf = (t: { id: string }, id: string) => boards.getBoard(t.id).nodes[id].text;
const styleOf = (t: { id: string }, id: string) => boards.getBoard(t.id).nodes[id].style;
const nodeOf = (t: { id: string }, id: string) => boards.getBoard(t.id).nodes[id];
const sel = (page: Page, ids: string[]) => S(page, async (ids: string[]) => (await import("/ui/board-state.js" as string)).select(ids), ids);

/** How many times each named component drew while `act` ran (and for two frames after). */
async function drawsDuring(page: Page, names: string[], act: () => Promise<unknown>): Promise<Record<string, number>> {
  await S(page, async (names: string[]) => {
    const { options } = await import("/ui/vendor/preact.js" as string);
    const w = window as unknown as { __draws: Record<string, number> | null; __drawHook?: boolean };
    w.__draws = Object.fromEntries(names.map((n) => [n, 0]));
    if (w.__drawHook) return;
    w.__drawHook = true;
    // Preact calls options.__r just before a component's render function runs.
    const prev = options.__r;
    options.__r = (v: { type: unknown }) => {
      const n = typeof v.type === "function" ? (v.type as { name: string }).name : "";
      if (w.__draws && n in w.__draws) w.__draws[n]++;
      prev?.(v);
    };
  }, names);
  await act();
  return S(page, async () => {
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const w = window as unknown as { __draws: Record<string, number> | null };
    const d = w.__draws!;
    w.__draws = null;
    return d;
  });
}

/** The shader runtime's frame-time budget: high, so a software GPU (Chromium's here) never trips the guard; tiny, to trip it. */
const shaderBudget = (page: Page, ms: number) => page.evaluate(`globalThis.BoardShaders && BoardShaders.configure({ budget: ${ms} })`);
/** How many frames each shader on the canvas has drawn, by layer id. */
const layerFrames = (page: Page, ids: string[]) =>
  S(page, (ids: string[]) => {
    const out: Record<string, number> = {};
    for (const l of (globalThis as unknown as { BoardShaders: { stats(): { layers: Array<{ layer: string | null; frames: number }> } } }).BoardShaders.stats().layers) if (l.layer && ids.includes(l.layer)) out[l.layer] = l.frames;
    return out;
  }, ids);
/** The size a frame's shader canvas is drawn at, in pixels. */
const canvasSize = (page: Page, id: string) => S(page, (id: string) => ({ width: (document.querySelector(`canvas[data-layer="${id}"]`) as HTMLCanvasElement).width, height: (document.querySelector(`canvas[data-layer="${id}"]`) as HTMLCanvasElement).height }), id);
/** A few of a frame's shader pixels, as text to compare. */
const canvasPixels = (page: Page, id: string) =>
  S(page, (id: string) => {
    const c = document.querySelector(`canvas[data-layer="${id}"]`) as HTMLCanvasElement;
    const g = c.getContext("2d")!;
    const out: number[] = [];
    for (const [fx, fy] of [[0.2, 0.2], [0.5, 0.5], [0.8, 0.7], [0.3, 0.8]]) out.push(...g.getImageData(Math.floor(c.width * fx), Math.floor(c.height * fy), 1, 1).data);
    return out.join(",");
  }, id);

const CHECKS: Record<string, Check> = {
  // From the 0.14 review of the board editor.
  async "board review: typing then clicking another layer row keeps the words"(page) {
    const t = await openTestBoard(page);
    const two = await boxOf(page, t.byName("Two"));
    await page.mouse.dblclick(two.x + 8, two.y + two.height / 2);
    await page.waitForTimeout(300);
    await page.keyboard.type("Hello");
    await page.waitForTimeout(100);
    // Click the List row in the layer list.
    await page.locator(`.bd-rows .bd-row[data-lid="${t.byName("List")}"]`).click();
    await page.waitForTimeout(1200);
    const after = textOf(t, t.byName("Two"));
    const st = await bstate(page);
    return after === "Hello" ? "ok" : `text on disk is ${JSON.stringify(after)} (sel ${st.sel}, past ${st.past})`;
  },
  // From the 0.14 review of the board editor.
  async "board review: a width typed then a click on another layer row goes to the first layer"(page) {
    const t = await openTestBoard(page);
    await S(page, async (id: string) => (await import("/ui/board-state.js" as string)).select(id), t.byName("Row One"));
    await page.waitForTimeout(300);
    const st0 = await bstate(page);
    const w = page.locator('.bd-right .num[title="Opacity"] input').first();
    await w.click();
    await page.keyboard.press("Meta+a");
    await page.keyboard.type("40");
    await page.locator(`.bd-rows .bd-row[data-lid="${t.byName("Row Two")}"]`).click();
    await page.waitForTimeout(1200);
    const one = styleOf(t, t.byName("Row One")).opacity;
    const two = styleOf(t, t.byName("Row Two")).opacity;
    return one === "0.4" && two === undefined ? "ok" : `selected ${st0.sel}; Row One opacity ${one}, Row Two opacity ${two}`;
  },
  // From the 0.14 review of the board editor.
  async "board review: escape in a layer rename keeps the old name"(page) {
    const t = await openTestBoard(page);
    await sel(page, [t.byName("List")]);
    await page.waitForTimeout(200);
    await page.keyboard.press("Meta+r");
    await page.waitForTimeout(200);
    await page.keyboard.type("Renamed");
    await page.keyboard.press("Escape");
    await page.waitForTimeout(1200);
    const name = nodeOf(t, t.byName("List")).name;
    return name === "List" ? "ok" : `after Escape the layer is called ${name}`;
  },
  // From the 0.14 review of the board editor.
  async "board review: drawing a rectangle over a copy of a component"(page) {
    const t = await openTestBoard(page);
    const one = t.byName("Row One");
    await S(page, async (id: string) => {
      const m = await import("/ui/board-state.js" as string);
      const b = await import("/ui/board.js" as string);
      m.select(id);
      b.makeComponent();
      b.placeCopy(id);
    }, one);
    await page.waitForTimeout(800);
    const copy = Object.values(boards.getBoard(t.id).nodes).find((n) => n.instanceOf === one);
    if (!copy) return "no copy made";
    const cb = await boxOf(page, copy.id);
    await page.keyboard.press("r");
    await page.mouse.move(cb.x + 10, cb.y + 5);
    await page.mouse.down();
    await page.mouse.move(cb.x + 40, cb.y + 30, { steps: 5 });
    await page.mouse.up();
    await page.waitForTimeout(900);
    const st = await bstate(page);
    const rects = Object.values(boards.getBoard(t.id).nodes).filter((n) => /^Rectangle/.test(n.name)).length;
    const msg = await toasts(page);
    return rects === 1 ? "ok" : `no rectangle drawn (sel ${st.sel}); toasts: ${msg.slice(0, 160)}`;
  },
  // From the 0.14 review of the board editor.
  async "board review: a layer copied out of a component's copy and pasted on the page no longer follows the component"(page) {
    const t = await openTestBoard(page);
    const one = t.byName("Row One");
    const out = await S(page, async (id: string) => {
      const m = await import("/ui/board-state.js" as string);
      const b = await import("/ui/board.js" as string);
      m.select(id);
      b.makeComponent();
      b.placeCopy(id);
      await new Promise((r) => setTimeout(r, 300));
      const copy = Object.values(m.B.board.nodes).find((n: any) => n.instanceOf === id) as any;
      const words = copy.children.map((c: string) => m.B.board.nodes[c]).find((n: any) => n.type === "text");
      m.select(words.id);
      await new Promise((r) => setTimeout(r, 100));
      const dt = new DataTransfer();
      window.dispatchEvent(new ClipboardEvent("copy", { clipboardData: dt, bubbles: true, cancelable: true }));
      m.select([]);
      await new Promise((r) => setTimeout(r, 100));
      window.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
      await new Promise((r) => setTimeout(r, 300));
      const pasted = m.B.sel[0];
      // Change the component's own words.
      const mainWords = m.B.board.nodes[id].children.map((c: string) => m.B.board.nodes[c]).find((n: any) => n.type === "text");
      m.commit([{ op: "set", id: mainWords.id, text: "Changed in the component" }], { label: "Typing" });
      await new Promise((r) => setTimeout(r, 300));
      const p = m.B.board.nodes[pasted];
      return { pasted: Boolean(p), parent: p?.parent ?? null, master: p?.master ?? null, text: p?.text, html: dt.getData("text/html").slice(0, 40) };
    }, one);
    return out.pasted && out.parent === null && out.text !== "Changed in the component" ? "ok" : `pasted on the page: ${JSON.stringify(out)}`;
  },
  // From the 0.14 review of the board editor.
  async "board review: a hidden layer wrapped with shift-A"(page) {
    const t = await openTestBoard(page);
    const two = t.byName("Row Two");
    await sel(page, [two]);
    await page.keyboard.press("Meta+Shift+h");
    await page.waitForTimeout(900);
    const hidden = nodeOf(t, two).hidden;
    await page.locator(`.bd-rows .bd-row[data-lid="${two}"]`).click();
    await page.waitForTimeout(200);
    await page.keyboard.press("Shift+a");
    await page.waitForTimeout(900);
    const p = nodeOf(t, two).parent;
    // Wrapping only a hidden layer says to show it first, and changes nothing (no error either).
    return hidden && nodeOf(t, p!).name === "List" ? "ok" : `hidden ${hidden}; parent now ${nodeOf(t, p!).name}`;
  },
  // From the 0.14 review of the board editor.
  async "board review: remove flex on a hidden flex frame"(page) {
    const t = await openTestBoard(page);
    const list = t.byName("List");
    await sel(page, [list]);
    await page.keyboard.press("Meta+Shift+h");
    await page.waitForTimeout(900);
    await page.locator('.bd-right button[title^="Remove flex"]').click();
    await page.waitForTimeout(900);
    // A hidden frame keeps its flex (there's nothing drawn to place its layers from), without an error.
    return nodeOf(t, list).style.display === "flex" ? "ok" : `display now ${nodeOf(t, list).style.display}`;
  },
  // From the 0.14 review of the board editor.
  async "board review: absolute position ticked on a hidden layer in a flex frame"(page) {
    const t = await openTestBoard(page);
    const two = t.byName("Row Two");
    await sel(page, [two]);
    await page.keyboard.press("Meta+Shift+h");
    await page.waitForTimeout(900);
    await page.locator('.bd-right label.bd-check', { hasText: "Absolute position" }).locator("input").click();
    await page.waitForTimeout(900);
    return nodeOf(t, two).style.position === "absolute" ? "ok" : `position now ${nodeOf(t, two).style.position}`;
  },
  // From the 0.14 review of the board editor.
  async "board review: the app's Duplicate menu command while typing in a text layer"(page) {
    const t = await openTestBoard(page);
    const two = await boxOf(page, t.byName("Two"));
    await page.mouse.dblclick(two.x + 8, two.y + two.height / 2);
    await page.waitForTimeout(300);
    await page.keyboard.type("Hello");
    // What Edit > Duplicate (⌘D) sends when the page leaves the key alone, as it does while typing.
    await S(page, () => (window as any).studio.command("duplicate"));
    await page.waitForTimeout(1200);
    const texts = Object.values(boards.getBoard(t.id).nodes).filter((n) => n.type === "text" && /Two|Hello/.test(n.text ?? "")).map((n) => n.text);
    // The menu's Duplicate does nothing while typing: the words stay in the one text being edited.
    return texts.length === 1 ? "ok" : `texts now: ${JSON.stringify(texts)}`;
  },
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
  async "on a board, padding and corners show each side when the sides differ, and two fields (or one) when they match"(page) {
    const t = await openTestBoard(page);
    const list = t.byName("List");
    const fields = () => S(page, () => ({ pads: [...document.querySelectorAll(".bd-pads .num, .bd-pads input")].length, four: document.querySelector(".bd-pads")?.classList.contains("four"), radius: document.querySelector(".bd-radius")?.classList.contains("four"),
      values: [...document.querySelectorAll(".bd-pads input")].map((i) => (i as HTMLInputElement).value) }));
    boards.changeBoard(t.id, [{ op: "set", id: list, style: { ...boards.getBoard(t.id).nodes[list].style, padding: "0px 0px 18px 0px", borderRadius: "12px" } }], "agent");
    await page.waitForTimeout(1200);
    await sel(page, [list]);
    await page.waitForTimeout(300);
    const uneven = await fields();
    if (!uneven.four) return `uneven padding shows ${JSON.stringify(uneven)}`;
    if (!uneven.values.includes("18")) return `the bottom padding isn't shown: ${uneven.values.join(",")}`;
    await picture(page, "padding-each-side");
    boards.changeBoard(t.id, [{ op: "set", id: list, style: { ...boards.getBoard(t.id).nodes[list].style, padding: "10px 16px", borderRadius: "4px 4px 12px 12px" } }], "agent");
    await page.waitForTimeout(1200);
    await sel(page, [t.byName("Phone")]);
    await page.waitForTimeout(200);
    await sel(page, [list]);
    await page.waitForTimeout(300);
    const even = await fields();
    if (even.four) return "even padding still shows each side";
    if (!even.radius) return "corners that differ don't show each corner";
    await picture(page, "padding-two-fields");
    return "ok";
  },
  async "selection: a double-click goes one level deeper at a time; on words it goes straight into them"(page) {
    const t = await openMaskBoard(page, DRAG_STAGE);
    const inner = await boxOf(page, t.byName("Inner"));
    const names = () => S(page, async () => { const m = await import("/ui/board-state.js" as string); return { sel: m.B.sel.map((id: string) => m.B.board.nodes[id].name).join(), editing: Boolean(m.B.editing) }; });
    await page.mouse.click(inner.x + 20, inner.y + 20);
    const first = (await names()).sel;
    await page.mouse.dblclick(inner.x + 20, inner.y + 20);
    await page.waitForTimeout(250);
    const second = (await names()).sel;
    await page.mouse.dblclick(inner.x + 20, inner.y + 20);
    await page.waitForTimeout(250);
    const third = (await names()).sel;
    await sel(page, []);
    const words = await boxOf(page, t.byName("Words"));
    await page.mouse.dblclick(words.x + 6, words.y + words.height / 2);
    await page.waitForTimeout(300);
    const w = await names();
    await page.keyboard.press("Escape");
    boards.deleteBoard(t.id);
    return first === "Column" && second === "Box" && third === "Inner" && w.sel === "Words" && w.editing ? "ok" : `click: ${first}, then ${second}, then ${third}; on the words: ${w.sel} (typing: ${w.editing})`;
  },
  async "dragging: out of a flex frame onto its artboard, into a frame inside the same flex frame, off the artboard, and a loose layer into the flow"(page) {
    const drag = async (from: { x: number; y: number }, to: { x: number; y: number }, rest = 0) => {
      await page.mouse.move(from.x, from.y);
      await page.mouse.down();
      for (let k = 1; k <= 12; k++) await page.mouse.move(from.x + ((to.x - from.x) * k) / 12, from.y + ((to.y - from.y) * k) / 12);
      if (rest) {
        await page.waitForTimeout(rest);
        await page.mouse.move(to.x + 1, to.y + 1);
      }
      await page.waitForTimeout(100);
      await page.mouse.up();
      await page.waitForTimeout(600);
    };
    const mid = (b: { x: number; y: number; width: number; height: number }) => ({ x: b.x + b.width / 2, y: b.y + b.height / 2 });
    const t = await openMaskBoard(page, DRAG_STAGE);
    const stage = t.byName("Stage");
    const column = t.byName("Column");
    const box = t.byName("Box");
    const title = t.byName("Title");
    const footer = t.byName("Footer");
    const loose = t.byName("Loose");
    // Room around the artboard to drop things off it.
    await S(page, async () => { const m = await import("/ui/board-state.js" as string); m.bset({ view: { ...m.B.view, z: m.B.view.z * 0.6 } }); });
    await page.waitForTimeout(400);
    const sb = await boxOf(page, stage);
    const canvas = (await page.locator(".bd-canvas").boundingBox())!;
    const k = sb.width / 800;
    // 1. The title (as wide as the column, by stretching) out onto open artboard space: same size, where dropped.
    await sel(page, [title]);
    await page.waitForTimeout(200);
    const tb = await boxOf(page, title);
    await drag({ x: tb.x + 20, y: tb.y + 10 }, { x: sb.x + 470 * k, y: sb.y + 480 * k });
    const t1 = nodeOf(t, title);
    const out = t1.parent === stage && t1.style.position === "absolute" && t1.style.width === "288px" && Math.abs(parseFloat(t1.style.left!) - (470 - 20 / k)) <= 3 && Math.abs(parseFloat(t1.style.top!) - (480 - 10 / k)) <= 3;
    // 2. The footer onto the box beside it in the same column, resting there a moment: into the box.
    await sel(page, [footer]);
    await page.waitForTimeout(200);
    const fb = await boxOf(page, footer);
    await drag({ x: fb.x + 30, y: fb.y + fb.height / 2 }, mid(await boxOf(page, box)), 600);
    // It filled the column's width; in the box (a row) it fills along the row, so it still shows.
    const footerDrawn = await boxOf(page, footer);
    const nested = nodeOf(t, footer).parent === box && footerDrawn.width > 20;
    // 3. The loose layer off the artboard: a layer of its own on the page, the same size.
    const lb = await boxOf(page, loose);
    await sel(page, [loose]);
    await page.waitForTimeout(200);
    await drag(mid(lb), { x: Math.min(sb.x + sb.width + 80, canvas.x + canvas.width - 30), y: lb.y + lb.height / 2 });
    const l1 = nodeOf(t, loose);
    const onPage = l1.parent === null && boards.getBoard(t.id).pages[0].children.includes(loose) && l1.style.width === "80px" && !l1.style.position;
    // 4. Back from the page into the column's flow, between its layers: it joins the flow.
    const lb2 = await boxOf(page, loose);
    const cb = await boxOf(page, column);
    const bx = await boxOf(page, box);
    await sel(page, [loose]);
    await page.waitForTimeout(200);
    await drag(mid(lb2), { x: cb.x + cb.width / 2, y: bx.y - 3 });
    const l2 = nodeOf(t, loose);
    const joined = l2.parent === column && !l2.style.position && !l2.style.left && childNames(t, column).startsWith("Loose");
    const drawn = await boxOf(page, loose);
    await picture(page, "drag-into-flow");
    const name = (id: string | null) => (id ? boards.getBoard(t.id).nodes[id]?.name : "the page");
    const verdict = !out
      ? `out onto the artboard: in ${name(t1.parent)}, ${JSON.stringify({ position: t1.style.position, width: t1.style.width, left: t1.style.left, top: t1.style.top })}`
      : !nested
        ? `the footer went into ${name(nodeOf(t, footer).parent)}, not the box beside it`
        : !onPage
          ? `off the artboard: in ${name(l1.parent)}, width ${l1.style.width}, position ${l1.style.position}`
          : !joined
            ? `into the flow: in ${name(l2.parent)}, position ${l2.style.position}, order ${childNames(t, column)}`
            : Math.abs(drawn.width - 80 * k) <= 2
              ? "ok"
              : `it joined the flow ${drawn.width / k}px wide`;
    boards.deleteBoard(t.id);
    return verdict;
  },
  async "spacing: a selected flex frame shows its padding and gaps on the canvas, and dragging them changes them"(page) {
    const t = await openMaskBoard(page, DRAG_STAGE);
    const column = t.byName("Column");
    await sel(page, [column]);
    await page.waitForTimeout(400);
    const handles = await S(page, () => [...document.querySelectorAll(".bd-space-h")].map((h) => (h as HTMLElement).dataset.space));
    const pads = handles.filter((h) => h!.startsWith("pad-")).sort().join();
    const gaps = handles.filter((h) => h === "gap").length;
    const k = (await boxOf(page, t.byName("Stage"))).width / 800;
    const pull = async (sel: string, dx: number, dy: number, mod?: string) => {
      const h = (await page.locator(sel).first().boundingBox())!;
      await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2);
      if (mod) await page.keyboard.down(mod);
      await page.mouse.down();
      await page.mouse.move(h.x + h.width / 2 + dx / 2, h.y + h.height / 2 + dy / 2);
      await page.mouse.move(h.x + h.width / 2 + dx, h.y + h.height / 2 + dy);
      await page.waitForTimeout(80);
      const shown = await S(page, () => document.querySelector(".bd-space.on .bd-space-v")?.textContent ?? "");
      await page.mouse.up();
      if (mod) await page.keyboard.up(mod);
      await page.waitForTimeout(400);
      return shown;
    };
    // Hovered: its space shaded and its size shown.
    const g = (await page.locator('.bd-space-h[data-space="gap"]').first().boundingBox())!;
    await page.mouse.move(g.x + g.width / 2, g.y + g.height / 2);
    await page.waitForTimeout(250);
    await picture(page, "spacing-gap-hover");
    const shownGap = await pull('.bd-space-h[data-space="gap"]', 0, 8 * k);
    const gap = styleOf(t, column).gap;
    const shownPad = await pull('.bd-space-h[data-space="pad-top"]', 0, 10 * k, "Alt");
    const st = styleOf(t, column);
    boards.deleteBoard(t.id);
    if (pads !== "pad-bottom,pad-left,pad-right,pad-top" || gaps !== 2) return `handles: ${handles.join()}`;
    if (gap !== "20px" || shownGap !== "20") return `the gap after dragging: ${gap} (shown ${shownGap})`;
    return st.paddingTop === "26px" && st.paddingBottom === "26px" && st.paddingLeft === "16px" && shownPad === "26" ? "ok" : `padding after an ⌥-drag of the top: ${st.paddingTop} ${st.paddingRight} ${st.paddingBottom} ${st.paddingLeft} (shown ${shownPad})`;
  },
  async "selection: Paper-style hover children, parent scope, uncle clicks, empty artboard deselect, Shift+Enter, and ⌥ alignment offsets"(page) {
    const t = await openMaskBoard(page, DRAG_STAGE);
    const stage = t.byName("Stage");
    const column = t.byName("Column");
    const title = t.byName("Title");
    const inner = t.byName("Inner");
    const loose = t.byName("Loose");
    const state = () => S(page, async () => {
      const m = await import("/ui/board-state.js" as string);
      return {
        sel: m.B.sel.map((id: string) => m.B.board.nodes[id]?.name ?? null).join(","),
        hover: m.B.hover ? m.B.board.nodes[m.B.hover]?.name ?? null : null,
        hoverKids: document.querySelectorAll(".bd-hover-child").length,
        parentScopes: document.querySelectorAll(".bd-parent-scope").length,
        pins: document.querySelectorAll(".bd-cpin").length,
        measures: document.querySelectorAll(".bd-measure").length,
        measureExts: document.querySelectorAll(".bd-measure-ext").length,
      };
    });
    // 1. Idle hover over a nested layer highlights its outermost container AND shows dashed outlines for its direct children.
    const ib = await boxOf(page, inner);
    await page.mouse.move(ib.x + ib.width / 2, ib.y + ib.height / 2, { steps: 3 });
    await page.waitForTimeout(160);
    const sHover = await state();
    await picture(page, "paper-hover-children");
    // 2. Hovering empty background inside a populated artboard doesn't flash a hover outline on the artboard.
    const sb = await boxOf(page, stage);
    await page.mouse.move(sb.x + sb.width - 30, sb.y + sb.height - 30);
    await page.waitForTimeout(120);
    const sBgHover = await state();
    // 3. Click Column (shows parent pin lines), dblclick into Box (shows dashed parent scope on Column), dblclick into Inner (shows dashed parent scope on Box).
    await page.mouse.click(ib.x + ib.width / 2, ib.y + ib.height / 2);
    await page.waitForTimeout(150);
    const sCol = await state();
    await page.mouse.dblclick(ib.x + ib.width / 2, ib.y + ib.height / 2);
    await page.waitForTimeout(150);
    await page.mouse.dblclick(ib.x + ib.width / 2, ib.y + ib.height / 2);
    await page.waitForTimeout(150);
    const sInner = await state();
    await picture(page, "paper-nested-scope");
    // 4. Ancestor-scope picking: while Inner (inside Box inside Column) is selected, hovering & clicking uncle Title picks Title directly (never kicking back out to Column).
    const tb = await boxOf(page, title);
    await page.mouse.move(tb.x + tb.width / 2, tb.y + tb.height / 2, { steps: 3 });
    await page.waitForTimeout(150);
    const sUncleHover = await state();
    await page.mouse.click(tb.x + tb.width / 2, tb.y + tb.height / 2);
    await page.waitForTimeout(150);
    const sUncleClick = await state();
    // 5. Keyboard hierarchy navigation: Shift+Enter steps up to parent Column; Enter enters its children; clicking empty artboard space deselects.
    await page.keyboard.press("Shift+Enter");
    await page.waitForTimeout(150);
    const sUp = await state();
    await page.keyboard.press("Enter");
    await page.waitForTimeout(150);
    const sDown = await state();
    await page.mouse.click(sb.x + sb.width - 30, sb.y + sb.height - 30);
    await page.waitForTimeout(150);
    const sEmptyClick = await state();
    // 6. ⌥ measurement between side-by-side siblings shows distance AND dashed alignment extension lines.
    await sel(page, [column]);
    await page.waitForTimeout(150);
    const lb = await boxOf(page, loose);
    await page.keyboard.down("Alt");
    await page.mouse.move(lb.x + lb.width / 2, lb.y + lb.height / 2, { steps: 3 });
    await page.waitForTimeout(180);
    const sAlt = await state();
    await picture(page, "paper-alt-measure");
    await page.keyboard.up("Alt");
    boards.deleteBoard(t.id);
    if (sHover.hover !== "Column" || sHover.hoverKids !== 3) return `hover over Inner: ${JSON.stringify(sHover)}`;
    if (sBgHover.hover !== null) return `empty artboard background hovered: ${sBgHover.hover}`;
    if (sCol.sel !== "Column" || sCol.pins < 2) return `Column selected pins: ${JSON.stringify(sCol)}`;
    if (sInner.sel !== "Inner" || sInner.parentScopes !== 1) return `Inner selected scope: ${JSON.stringify(sInner)}`;
    if (sUncleHover.hover !== "Title" || sUncleClick.sel !== "Title") return `uncle hover/click: ${JSON.stringify({ sUncleHover, sUncleClick })}`;
    if (sUp.sel !== "Column" || sDown.sel !== "Title,Box,Footer") return `Shift+Enter / Enter: ${JSON.stringify({ sUp, sDown })}`;
    if (sEmptyClick.sel !== "") return `empty artboard click left selected: ${sEmptyClick.sel}`;
    if (sAlt.measures < 2 || sAlt.measureExts < 1) return `⌥ measurement: ${JSON.stringify(sAlt)}`;
    return "ok";
  },
  async "dragging: bounded snap guides with dots, equal spacing, unclipped overlay ghost, drop tag, Escape cancel, and multi-layer grid drop"(page) {
    const t = await openMaskBoard(page, DRAG_STAGE);
    const stage = t.byName("Stage");
    const column = t.byName("Column");
    const box = t.byName("Box");
    const inner = t.byName("Inner");
    const loose = t.byName("Loose");
    const sb = await boxOf(page, stage);
    const cb = await boxOf(page, column);
    const lb = await boxOf(page, loose);
    // 1. Drag Loose up so its top aligns with Column's top: bounded horizontal guide (< canvas width), anchor dots, and live distance pill; Escape cancels cleanly.
    await sel(page, [loose]);
    await page.waitForTimeout(150);
    const startX = lb.x + lb.width / 2;
    const startY = lb.y + lb.height / 2;
    const alignY = startY + (cb.y - lb.y);
    await page.mouse.move(startX, startY);
    await page.mouse.down();
    for (let i = 1; i <= 8; i++) await page.mouse.move(startX, startY + ((alignY - startY) * i) / 8);
    await page.waitForTimeout(120);
    const snapInfo = await S(page, () => {
      const cw = document.querySelector(".bd-canvas")!.getBoundingClientRect().width;
      const ys = [...document.querySelectorAll(".bd-guide.y")].map((g) => g.getBoundingClientRect().width);
      return {
        guides: ys.length,
        bounded: ys.length > 0 && ys.every((w) => w < cw - 40),
        pts: document.querySelectorAll(".bd-guide-pt").length,
        dists: document.querySelectorAll(".bd-snap-dist").length,
      };
    });
    await picture(page, "paper-drag-snap");
    await page.keyboard.press("Escape");
    await page.mouse.up();
    await page.waitForTimeout(300);
    const afterEsc = styleOf(t, loose);
    // 2. Drag Inner out of Box (clipped with overflow:hidden) over Column: unclipped overlay ghost + drop-target tag + gap-centered drop line.
    boards.changeBoard(t.id, [{ op: "set", id: box, style: { overflow: "hidden" } }], "studio");
    await page.waitForTimeout(250);
    await sel(page, [inner]);
    await page.waitForTimeout(150);
    const ib = await boxOf(page, inner);
    const titleBox = await boxOf(page, t.byName("Title"));
    await page.mouse.move(ib.x + ib.width / 2, ib.y + ib.height / 2);
    await page.mouse.down();
    for (let i = 1; i <= 8; i++) {
      await page.mouse.move(
        ib.x + ib.width / 2 + ((titleBox.x + titleBox.width / 2 - (ib.x + ib.width / 2)) * i) / 8,
        ib.y + ib.height / 2 + ((titleBox.y + titleBox.height + 2 - (ib.y + ib.height / 2)) * i) / 8,
      );
    }
    await page.waitForTimeout(120);
    const ghostInfo = await S(page, () => ({
      ghosts: document.querySelectorAll(".bd-ghost").length,
      dropInto: document.querySelectorAll(".bd-drop-into").length,
      dropTag: document.querySelector(".bd-drop-tag")?.textContent ?? "",
      dropLine: document.querySelectorAll(".bd-drop-line").length,
    }));
    await picture(page, "paper-drag-ghost");
    await page.keyboard.press("Escape");
    await page.mouse.up();
    await page.waitForTimeout(250);
    boards.deleteBoard(t.id);
    // 3. Equal spacing snap on 3 free siblings.
    const eq = await openMaskBoard(
      page,
      `<div data-name="Eq" style="position:relative;width:700px;height:300px;background:#fff"><div data-name="A" style="position:absolute;left:40px;top:80px;width:80px;height:80px;background:#ddd"></div><div data-name="B" style="position:absolute;left:180px;top:80px;width:80px;height:80px;background:#ddd"></div><div data-name="C" style="position:absolute;left:420px;top:80px;width:80px;height:80px;background:#4c8dff"></div></div>`,
    );
    const eqC = eq.byName("C");
    const eqB = await boxOf(page, eq.byName("B"));
    const eqCBox = await boxOf(page, eqC);
    const k = (await boxOf(page, eq.byName("Eq"))).width / 700;
    // Gap between A (40..120) and B (180..260) is 60px -> C equal-spaced sits at left=320px (drag dx = -98px, within snap of -100px).
    await sel(page, [eqC]);
    await page.waitForTimeout(150);
    await page.mouse.move(eqCBox.x + eqCBox.width / 2, eqCBox.y + eqCBox.height / 2);
    await page.mouse.down();
    for (let i = 1; i <= 8; i++) await page.mouse.move(eqCBox.x + eqCBox.width / 2 - (98 * k * i) / 8, eqCBox.y + eqCBox.height / 2);
    await page.waitForTimeout(100);
    const eqDists = await S(page, () => [...document.querySelectorAll(".bd-snap-dist span")].map((s) => s.textContent));
    await page.mouse.up();
    await page.waitForTimeout(400);
    const eqLeft = styleOf(eq, eqC).left;
    boards.deleteBoard(eq.id);
    // 4. Multi-layer drag into a grid frame.
    const gm = await openMaskBoard(
      page,
      `<div data-name="Desk" style="position:relative;width:760px;height:400px;background:#fff"><div data-name="Grid" style="position:absolute;left:40px;top:40px;width:360px;height:280px;display:grid;grid-template-columns:1fr 1fr;gap:12px;padding:12px;background:#f4f4f5"><div data-name="Cell1" style="height:80px;background:#ccc"></div></div><div data-name="P1" style="position:absolute;left:480px;top:60px;width:80px;height:60px;background:#f87171"></div><div data-name="P2" style="position:absolute;left:480px;top:150px;width:80px;height:60px;background:#60a5fa"></div></div>`,
    );
    const gridId = gm.byName("Grid");
    const p1 = gm.byName("P1");
    const p2 = gm.byName("P2");
    await sel(page, [p1, p2]);
    await page.waitForTimeout(150);
    const p1b = await boxOf(page, p1);
    const gb = await boxOf(page, gridId);
    await page.mouse.move(p1b.x + p1b.width / 2, p1b.y + p1b.height / 2);
    await page.mouse.down();
    for (let i = 1; i <= 10; i++) {
      await page.mouse.move(p1b.x + p1b.width / 2 + ((gb.x + gb.width / 2 - (p1b.x + p1b.width / 2)) * i) / 10, p1b.y + p1b.height / 2 + ((gb.y + gb.height / 2 - (p1b.y + p1b.height / 2)) * i) / 10);
    }
    await page.waitForTimeout(100);
    await page.mouse.up();
    await page.waitForTimeout(500);
    const gridParents = [nodeOf(gm, p1).parent === gridId, nodeOf(gm, p2).parent === gridId];
    boards.deleteBoard(gm.id);
    if (!snapInfo.guides || !snapInfo.bounded || snapInfo.pts < 2 || snapInfo.dists < 1) return `bounded snap guides: ${JSON.stringify(snapInfo)}`;
    if (afterEsc.left !== "500px" || afterEsc.top !== "300px") return `Escape didn't cancel drag: ${afterEsc.left}, ${afterEsc.top}`;
    if (ghostInfo.ghosts !== 1 || ghostInfo.dropInto !== 1 || ghostInfo.dropTag !== "Column" || ghostInfo.dropLine !== 1) return `overlay ghost/drop: ${JSON.stringify(ghostInfo)}`;
    if (eqLeft !== "320px" || eqDists.filter((d) => d === "60").length < 2) return `equal spacing: left=${eqLeft}, dists=${JSON.stringify(eqDists)}`;
    if (!gridParents.every(Boolean)) return `multi-layer grid drop: ${JSON.stringify(gridParents)}`;
    return "ok";
  },
  async "figma: frame draw auto-adopts enclosed layers, Shift+A infers flex, arrow keys reorder in flex, and double-click handle hugs/fits"(page) {
    const t = await openMaskBoard(
      page,
      `<div data-name="Board" style="position:relative;width:760px;height:420px;background:#ffffff">
        <div data-name="CardA" style="position:absolute;left:80px;top:120px;width:100px;height:100px;background:#ef4444;border-radius:8px"></div>
        <div data-name="CardB" style="position:absolute;left:220px;top:120px;width:100px;height:100px;background:#3b82f6;border-radius:8px"></div>
        <div data-name="CardC" style="position:absolute;left:360px;top:120px;width:100px;height:100px;background:#10b981;border-radius:8px"></div>
      </div>`,
    );
    const boardId = t.byName("Board");
    const aId = t.byName("CardA");
    const bId = t.byName("CardB");
    const cId = t.byName("CardC");
    const bb = await boxOf(page, boardId);
    const k = bb.width / 760;
    // 1. Draw Frame enclosing CardA and CardB completely, overlapping CardC only ~60%: ONLY CardA & CardB should preview + adopt!
    await page.keyboard.press("f");
    await page.waitForTimeout(100);
    const fx0 = bb.x + 50 * k;
    const fy0 = bb.y + 90 * k;
    const fx1Partial = bb.x + 420 * k; // covers A (80..180) and B (220..320), only 60px of C (360..460)
    const fy1 = bb.y + 250 * k;
    await page.mouse.move(fx0, fy0);
    await page.mouse.down();
    for (let i = 1; i <= 8; i++) await page.mouse.move(fx0 + ((fx1Partial - fx0) * i) / 8, fy0 + ((fy1 - fy0) * i) / 8);
    await page.waitForTimeout(100);
    const previewInfo = await S(page, () => ({
      willWrap: document.querySelectorAll(".bd-will-wrap").length,
      label: document.querySelector(".bd-draw-size")?.textContent ?? "",
    }));
    await picture(page, "figma-frame-wrap-preview");
    await page.mouse.up();
    await page.waitForTimeout(400);
    const partialFrameId = await S(page, async () => (await import("/ui/board-state.js" as string)).B.sel[0] ?? null);
    const partialParents = { a: nodeOf(t, aId).parent === partialFrameId, b: nodeOf(t, bId).parent === partialFrameId, c: nodeOf(t, cId).parent === boardId };
    // Check visual coordinates preserved inside new frame (CardA was at left=80, frame at left=50 -> CardA left ≈ 30px).
    const aLocalLeft = parseFloat(styleOf(t, aId).left ?? "0");
    // 2. Undo, then draw Frame enclosing ALL 3 cards with 30px padding around them.
    await page.keyboard.press("Meta+z");
    await page.waitForTimeout(400);
    await page.keyboard.press("f");
    await page.waitForTimeout(100);
    const fx1All = bb.x + 490 * k; // 460 + 30 = 490
    await page.mouse.move(fx0, fy0);
    await page.mouse.down();
    for (let i = 1; i <= 8; i++) await page.mouse.move(fx0 + ((fx1All - fx0) * i) / 8, fy0 + ((fy1 - fy0) * i) / 8);
    await page.waitForTimeout(80);
    await page.mouse.up();
    await page.waitForTimeout(400);
    const fullFrameId = await S(page, async () => (await import("/ui/board-state.js" as string)).B.sel[0] ?? null);
    // 3. Double-click bottom-right resize handle on this FREE frame -> Resize to Fit children tightly (width ≈ 380, height ≈ 100)!
    const seHandle = (await page.locator('.bd-handle[data-handle="se"]').boundingBox())!;
    await page.mouse.dblclick(seHandle.x + seHandle.width / 2, seHandle.y + seHandle.height / 2);
    await page.waitForTimeout(400);
    const fitStyle = styleOf(t, fullFrameId!);
    // Undo Resize to Fit so frame still has ~30px padding around all 3 cards before Shift+A!
    await page.keyboard.press("Meta+z");
    await page.waitForTimeout(400);
    // 4. Press Shift+A -> infers flexDirection: row, gap: 40px, padding ≈ 30px, reading order A,B,C!
    await page.keyboard.press("Shift+A");
    await page.waitForTimeout(400);
    const flexStyle = styleOf(t, fullFrameId!);
    const flexOrderBefore = (nodeOf(t, fullFrameId!).children ?? []).map((cid) => nodeOf(t, cid).name).join(",");
    // 5. Double-click east handle on the FLEX frame -> Hug contents (clears fixed width)!
    const eHandle = (await page.locator('.bd-handle[data-handle="e"]').boundingBox())!;
    await page.mouse.dblclick(eHandle.x + eHandle.width / 2, eHandle.y + eHandle.height / 2);
    await page.waitForTimeout(400);
    const huggedWidth = styleOf(t, fullFrameId!).width ?? null;
    // 6. Select CardA inside the flex row, press ArrowRight -> reorders to CardB,CardA,CardC!
    await sel(page, [aId]);
    await page.waitForTimeout(150);
    await page.keyboard.press("ArrowRight");
    await page.waitForTimeout(400);
    const flexOrderAfter = (nodeOf(t, fullFrameId!).children ?? []).map((cid) => nodeOf(t, cid).name).join(",");
    boards.deleteBoard(t.id);
    if (previewInfo.willWrap !== 2 || !previewInfo.label.includes("2 layers")) return `wrap preview: ${JSON.stringify(previewInfo)}`;
    if (!partialParents.a || !partialParents.b || !partialParents.c) return `partial wrap parents: ${JSON.stringify(partialParents)}`;
    if (Math.abs(aLocalLeft - 30) > 2) return `adopted child local left=${aLocalLeft} (expected ~30)`;
    if (Math.abs(parseFloat(fitStyle.width ?? "0") - 380) > 4 || Math.abs(parseFloat(fitStyle.height ?? "0") - 100) > 4) return `free frame dblclick fit: ${fitStyle.width} × ${fitStyle.height}`;
    if (flexStyle.display !== "flex" || flexStyle.flexDirection !== "row" || flexStyle.gap !== "40px") return `Shift+A flex infer: ${JSON.stringify(flexStyle)}`;
    if (!flexStyle.padding && !flexStyle.paddingTop) return `Shift+A didn't infer padding: ${JSON.stringify(flexStyle)}`;
    if (huggedWidth !== null) return `flex dblclick east handle didn't hug width: ${huggedWidth}`;
    if (flexOrderBefore !== "CardA,CardB,CardC" || flexOrderAfter !== "CardB,CardA,CardC") return `arrow reorder in flex: ${flexOrderBefore} -> ${flexOrderAfter}`;
    return "ok";
  },
  async "figma: Option-drag duplicates, Space skips auto-nesting & shifts draw, corner radius handles, Smart Selection gap & reorder, and Cmd-marquee"(page) {
    const t = await openMaskBoard(
      page,
      `<div data-name="Stage" style="position:relative;width:760px;height:440px;background:#ffffff">
        <div data-name="S1" style="position:absolute;left:40px;top:40px;width:90px;height:90px;background:#6366f1"></div>
        <div data-name="S2" style="position:absolute;left:160px;top:40px;width:90px;height:90px;background:#8b5cf6"></div>
        <div data-name="S3" style="position:absolute;left:280px;top:40px;width:90px;height:90px;background:#ec4899"></div>
        <div data-name="Target" style="position:absolute;left:40px;top:210px;width:240px;height:180px;background:#f4f4f5;border:1px solid #d4d4d8">
          <div data-name="DeepChild" style="position:absolute;left:40px;top:40px;width:80px;height:60px;background:#f59e0b"></div>
        </div>
        <div data-name="Mover" style="position:absolute;left:440px;top:250px;width:80px;height:80px;background:#14b8a6"></div>
      </div>`,
    );
    const stageId = t.byName("Stage");
    const s1 = t.byName("S1");
    const s2 = t.byName("S2");
    const s3 = t.byName("S3");
    const targetId = t.byName("Target");
    const deepChild = t.byName("DeepChild");
    const mover = t.byName("Mover");
    const sb = await boxOf(page, stageId);
    const k = sb.width / 760;

    // 1. Corner radius handles on S1: uniform drag, ⌥ single-corner drag, double-click reset to 0.
    await sel(page, [s1]);
    await page.waitForTimeout(150);
    const tl = (await page.locator('.bd-rad-h[data-radius="tl"]').boundingBox())!;
    await page.mouse.move(tl.x + tl.width / 2, tl.y + tl.height / 2);
    await page.mouse.down();
    for (let i = 1; i <= 6; i++) await page.mouse.move(tl.x + tl.width / 2 + (18 * k * i) / 6, tl.y + tl.height / 2 + (18 * k * i) / 6);
    await page.waitForTimeout(80);
    const radPill = await S(page, () => document.querySelector(".bd-rad-v")?.textContent ?? "");
    await picture(page, "figma-radius");
    await page.mouse.up();
    await page.waitForTimeout(350);
    const radAll = parseFloat(styleOf(t, s1).borderRadius ?? "0");
    // Option-drag bottom-right corner only.
    const br = (await page.locator('.bd-rad-h[data-radius="br"]').boundingBox())!;
    await page.mouse.move(br.x + br.width / 2, br.y + br.height / 2);
    await page.keyboard.down("Alt");
    await page.mouse.down();
    for (let i = 1; i <= 6; i++) await page.mouse.move(br.x + br.width / 2 - (10 * k * i) / 6, br.y + br.height / 2 - (10 * k * i) / 6);
    await page.mouse.up();
    await page.keyboard.up("Alt");
    await page.waitForTimeout(350);
    const radSingle = { tl: styleOf(t, s1).borderTopLeftRadius, br: styleOf(t, s1).borderBottomRightRadius };
    // Double-click corner dot resets radius to 0.
    const tl2 = (await page.locator('.bd-rad-h[data-radius="tl"]').boundingBox())!;
    await page.mouse.dblclick(tl2.x + tl2.width / 2, tl2.y + tl2.height / 2);
    await page.waitForTimeout(350);
    const radReset = styleOf(t, s1).borderRadius ?? styleOf(t, s1).borderTopLeftRadius ?? null;

    // 2. Smart Selection on S1, S2, S3 (30px uniform gaps): pink gap handles & center reorder dots!
    await sel(page, [s1, s2, s3]);
    await page.waitForTimeout(180);
    const smartUi = await S(page, () => ({
      gaps: document.querySelectorAll(".bd-smart-gap-h").length,
      dots: document.querySelectorAll(".bd-smart-dot").length,
    }));
    await picture(page, "figma-smart-selection");
    // Drag first gap handle +20px -> gap becomes 50px (S1=40, S2=180, S3=320).
    const sg = (await page.locator('.bd-smart-gap-h[data-smart-gap="0"]').boundingBox())!;
    await page.mouse.move(sg.x + sg.width / 2, sg.y + sg.height / 2);
    await page.mouse.down();
    for (let i = 1; i <= 6; i++) await page.mouse.move(sg.x + sg.width / 2 + (20 * k * i) / 6, sg.y + sg.height / 2);
    await page.mouse.up();
    await page.waitForTimeout(350);
    const smartGapLefts = [parseFloat(styleOf(t, s1).left ?? "0"), parseFloat(styleOf(t, s2).left ?? "0"), parseFloat(styleOf(t, s3).left ?? "0")];
    // Drag S1's center dot past S3's center -> S1 swaps to the rightmost slot (S2=40, S3=180, S1=320).
    const d1 = (await page.locator(`.bd-smart-dot[data-smart-dot="${s1}"]`).boundingBox())!;
    const d3 = (await page.locator(`.bd-smart-dot[data-smart-dot="${s3}"]`).boundingBox())!;
    await page.mouse.move(d1.x + d1.width / 2, d1.y + d1.height / 2);
    await page.mouse.down();
    for (let i = 1; i <= 8; i++) await page.mouse.move(d1.x + d1.width / 2 + ((d3.x + d3.width / 2 + 20 - (d1.x + d1.width / 2)) * i) / 8, d1.y + d1.height / 2);
    await page.mouse.up();
    await page.waitForTimeout(350);
    const smartSwapLefts = [parseFloat(styleOf(t, s2).left ?? "0"), parseFloat(styleOf(t, s3).left ?? "0"), parseFloat(styleOf(t, s1).left ?? "0")];

    // 3. Option-drag Mover to the right by 120px -> original stays at 440px, duplicate created at ~560px & selected!
    await sel(page, [mover]);
    await page.waitForTimeout(150);
    const mb = await boxOf(page, mover);
    const countBeforeDup = (nodeOf(t, stageId).children ?? []).length;
    await page.mouse.move(mb.x + mb.width / 2, mb.y + mb.height / 2);
    await page.keyboard.down("Alt");
    await page.mouse.down();
    for (let i = 1; i <= 8; i++) await page.mouse.move(mb.x + mb.width / 2 + (120 * k * i) / 8, mb.y + mb.height / 2);
    await page.waitForTimeout(100);
    const dupMid = await S(page, () => ({
      dupGhosts: document.querySelectorAll(".bd-ghost.dup").length,
      copying: document.querySelector(".bd-canvas")?.classList.contains("copying") ?? false,
    }));
    await picture(page, "figma-alt-dup");
    await page.mouse.up();
    await page.keyboard.up("Alt");
    await page.waitForTimeout(400);
    const countAfterDup = (nodeOf(t, stageId).children ?? []).length;
    const dupSelId = await S(page, async () => (await import("/ui/board-state.js" as string)).B.sel[0] ?? null);
    const origMoverLeft = styleOf(t, mover).left;
    const dupMoverLeft = dupSelId ? parseFloat(styleOf(t, dupSelId).left ?? "0") : 0;

    // 4. Drag Mover directly over Target while holding Space mid-drag -> stays in Stage (does NOT auto-nest into Target)!
    await sel(page, [mover]);
    await page.waitForTimeout(150);
    const tb = await boxOf(page, targetId);
    await page.mouse.move(mb.x + mb.width / 2, mb.y + mb.height / 2);
    await page.mouse.down();
    await page.mouse.move(mb.x + mb.width / 2 - 20 * k, mb.y + mb.height / 2);
    await page.keyboard.down("Space");
    for (let i = 1; i <= 8; i++) {
      await page.mouse.move(
        mb.x + mb.width / 2 - 20 * k + ((tb.x + tb.width * 0.7 - (mb.x + mb.width / 2 - 20 * k)) * i) / 8,
        mb.y + mb.height / 2 + ((tb.y + tb.height * 0.6 - (mb.y + mb.height / 2)) * i) / 8,
      );
    }
    await page.waitForTimeout(100);
    await page.mouse.up();
    await page.keyboard.up("Space");
    await page.waitForTimeout(400);
    const moverParentAfterSpace = nodeOf(t, mover).parent;

    // 5. Cmd-marquee across Target -> selects DeepChild directly!
    await sel(page, []);
    await page.waitForTimeout(120);
    const dcb = await boxOf(page, deepChild);
    await page.keyboard.down("Meta");
    await page.mouse.move(sb.x + 12 * k, tb.y + 10 * k);
    await page.mouse.down();
    for (let i = 1; i <= 6; i++) {
      await page.mouse.move(sb.x + 12 * k + ((dcb.x + dcb.width + 10 - (sb.x + 12 * k)) * i) / 6, tb.y + 10 * k + ((dcb.y + dcb.height + 10 - (tb.y + 10 * k)) * i) / 6);
    }
    await page.mouse.up();
    await page.keyboard.up("Meta");
    await page.waitForTimeout(250);
    const cmdMarqueeSel = await S(page, async () => (await import("/ui/board-state.js" as string)).B.sel.join(","));

    // 6. Holding Space mid-draw with R tool shifts the drawn rectangle's origin!
    await page.keyboard.press("r");
    await page.waitForTimeout(80);
    const rx0 = sb.x + 560 * k;
    const ry0 = sb.y + 40 * k;
    await page.mouse.move(rx0, ry0);
    await page.mouse.down();
    await page.mouse.move(rx0 + 60 * k, ry0 + 60 * k, { steps: 4 });
    await page.keyboard.down("Space");
    await page.mouse.move(rx0 + 110 * k, ry0 + 90 * k, { steps: 4 }); // shifts origin by (+50, +30) -> left ≈ 610, top ≈ 70, size ≈ 60×60
    await page.keyboard.up("Space");
    await page.mouse.up();
    await page.waitForTimeout(350);
    const drawnId = await S(page, async () => (await import("/ui/board-state.js" as string)).B.sel[0] ?? null);
    const drawnSt = drawnId ? styleOf(t, drawnId) : {};

    boards.deleteBoard(t.id);
    if (radAll < 10 || !radPill) return `corner radius drag: all=${radAll}, pill=${radPill}`;
    if (!radSingle.tl || !radSingle.br || radSingle.tl === radSingle.br) return `⌥ single corner radius: ${JSON.stringify(radSingle)}`;
    if (radReset !== null) return `dblclick radius reset left: ${radReset}`;
    if (smartUi.gaps !== 2 || smartUi.dots !== 3) return `smart selection UI: ${JSON.stringify(smartUi)}`;
    if (Math.abs(smartGapLefts[1] - 180) > 3 || Math.abs(smartGapLefts[2] - 320) > 3) return `smart gap drag lefts: ${JSON.stringify(smartGapLefts)}`;
    if (Math.abs(smartSwapLefts[0] - 40) > 3 || Math.abs(smartSwapLefts[1] - 180) > 3 || Math.abs(smartSwapLefts[2] - 320) > 3) return `smart reorder lefts: ${JSON.stringify(smartSwapLefts)}`;
    if (!dupMid.copying || dupMid.dupGhosts !== 1 || countAfterDup !== countBeforeDup + 1 || dupSelId === mover || origMoverLeft !== "440px" || Math.abs(dupMoverLeft - 560) > 4) {
      return `⌥-drag duplicate: mid=${JSON.stringify(dupMid)}, count=${countBeforeDup}->${countAfterDup}, orig=${origMoverLeft}, dup=${dupMoverLeft}`;
    }
    if (moverParentAfterSpace !== stageId) return `Space mid-drag still nested into ${moverParentAfterSpace}`;
    if (!cmdMarqueeSel.split(",").includes(deepChild)) return `⌘-marquee sel: ${cmdMarqueeSel} (expected ${deepChild})`;
    if (Math.abs(parseFloat(drawnSt.left ?? "0") - 610) > 6 || Math.abs(parseFloat(drawnSt.top ?? "0") - 70) > 6 || Math.abs(parseFloat(drawnSt.width ?? "0") - 60) > 6) {
      return `Space mid-draw origin shift: ${JSON.stringify(drawnSt)}`;
    }
    return "ok";
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
    const mp4 = path.join(LIB, "clip.mp4");
    const webm = path.join(LIB, "clip.webm");
    const still = path.join(LIB, "clip.jpg");
    // Sample clips kept with the tests (made once, so the tests need no ffmpeg).
    for (const [from, to] of [["clip.mp4", mp4], ["clip.webm", webm], ["clip.jpg", still]]) if (!existsSync(to)) copyFileSync(path.join(import.meta.dirname, "fixtures", from), to);
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
    const sentBefore = agentman.sent.length;
    // Only a tagged agent gets it: @ and its name.
    await page.keyboard.type("@Des");
    await page.waitForSelector(".bd-picker button", { timeout: 6000 });
    await page.keyboard.press("Enter");
    await page.keyboard.type("make this row taller");
    await page.keyboard.press("Enter");
    // It waits on the board until it's sent from the bar.
    await page.waitForSelector(".bd-sendbar .bd-sendbar-send", { timeout: 5000 });
    if (agentman.sent.length !== sentBefore) return "the comment went to the agent before Send";
    await page.click(".bd-sendbar .bd-sendbar-send");
    await page.waitForFunction(() => !document.querySelector(".bd-sendbar") && !document.querySelector(".bd-pin.pending"), null, { timeout: 8000 }).catch(() => undefined);
    const thread = talk.getComments(t.id).threads[0];
    await page.click(`.bd-pin[data-thread="${thread?.id}"]`).catch(() => undefined);
    await page.waitForFunction(() => document.querySelector(".bd-thread .bd-sent")?.textContent?.startsWith("Sent to Design agent"), null, { timeout: 8000 }).catch(() => undefined);
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
    await S(page, async () => (await import("/ui/board-state.js" as string)).bset({ rightTab: "comments" }));
    await S(page, async (id: string) => (await import("/ui/board-comments.js" as string)).openThread(id), thread.id);
    await page.waitForTimeout(300);
    const reopen = await S(page, () => document.querySelector(".bd-thread header .bd-reopen")?.textContent ?? "");
    if (reopen !== "Reopen") return `a resolved thread offers "${reopen}" to open it again`;
    await page.keyboard.press("Escape");
    await S(page, async () => (await import("/ui/board-state.js" as string)).bset({ rightTab: "design" }));
    const pinGone = await S(page, (id: string) => !document.querySelector(`.bd-pin[data-thread="${id}"]`), thread.id);
    await S(page, async () => (await import("/ui/board-state.js" as string)).bset({ rightTab: "comments" }));
    const listed = await S(page, () => document.querySelectorAll(".bd-crow").length);
    return resolved && pinGone && listed === 0 ? "ok" : `resolved: ${resolved}, pin hidden: ${pinGone}, open comments listed: ${listed}`;
  },
  async "an agent's cursor goes to what it touches, and following it brings its changes into view, at your zoom, until you look away"(page) {
    const t = await openTestBoard(page);
    const phone = t.byName("Phone");
    const touch = (id: string, doing = "edit") =>
      boards.changeBoard(t.id, [{ op: "agent", agent: { key: AGENT, session: AGENT, how: "process", kind: "claude", name: "Design agent", cwd: tmp }, artboards: [phone], at: new Date().toISOString(), touch: { ids: [id], doing } }], "agent");
    const cursorAt = () => S(page, () => {
      const c = document.querySelector(".bd-cursor .bd-cursor-in")?.getBoundingClientRect();
      return c ? { x: c.left, y: c.top, name: document.querySelector(".bd-cursor-name b")?.textContent, doing: document.querySelector(".bd-cursor-doing")?.textContent } : null;
    });
    touch(t.byName("Row One"));
    // The cursor is a point (the arrow and name hang from it): there, not "visible" as a box.
    const shown = await page.waitForSelector(".bd-cursor", { state: "attached", timeout: 5000 }).then(() => true, () => false);
    if (!shown) return "no cursor came for the agent's change";
    await page.waitForTimeout(900);
    const one = await cursorAt();
    const r1 = await boxOf(page, t.byName("Row One"));
    if (!one || one.name !== "Design agent") return `the cursor shows ${JSON.stringify(one)}`;
    if (!/changing Row One/.test(one.doing ?? "")) return `the cursor says it's "${one.doing}"`;
    // The artboard it's on is marked with its name (not a nameless "Agent"), in its colour.
    const mark = await S(page, () => document.querySelector(".bd-label.working .bd-agent")?.textContent);
    if (mark !== "Design agent") return `the artboard's mark says "${mark}"`;
    if (one.x < r1.x - 4 || one.x > r1.x + r1.width || one.y < r1.y - 4 || one.y > r1.y + r1.height) return `the cursor is at ${one.x},${one.y}, not on Row One (${r1.x},${r1.y} ${r1.width}×${r1.height})`;
    await picture(page, "presence-cursor");
    touch(t.byName("Row Three"));
    await page.waitForTimeout(1500);
    const three = await cursorAt();
    const r3 = await boxOf(page, t.byName("Row Three"));
    if (!three || three.y < r3.y - 4 || three.y > r3.y + r3.height) return "the cursor didn't move to Row Three";
    // Follow: the view frames what the agent touches.
    await page.click(".bd-avatar");
    const following = await page.waitForFunction(() => document.querySelector(".bd-following")?.textContent, null, { timeout: 3000 }).then((h) => h.jsonValue(), () => "");
    if (!/Following Design agent/.test(following)) return `following shows "${following}"`;
    const vp = page.viewportSize()!;
    const state = () => S(page, async () => { const m = await import("/ui/board-state.js" as string); return { following: m.B.following, z: m.B.view.z }; });
    await page.waitForTimeout(900);
    // Zooming in on the agent's work, to watch closely, keeps following...
    const before = await state();
    const rz = await boxOf(page, t.byName("Row Three"));
    await page.mouse.move(rz.x + rz.width / 2, rz.y + rz.height / 2);
    await page.keyboard.down("Control");
    for (let i = 0; i < 4; i++) { await page.mouse.wheel(0, -15); await page.waitForTimeout(40); }   // a pinch's worth
    await page.keyboard.up("Control");
    await page.waitForTimeout(400);
    const zoomed = await state();
    if (!zoomed.following) return "zooming stopped following";
    if (zoomed.z < before.z * 1.2) return `the zoom didn't go in (${before.z.toFixed(2)}× to ${zoomed.z.toFixed(2)}×)`;
    await picture(page, "presence-following");
    // ...and the agent's next move, now out of sight, is brought into view at that zoom.
    touch(t.byName("Row One"));
    await page.waitForTimeout(1600);
    const then = await state();
    const r1b = await boxOf(page, t.byName("Row One"));
    if (!then.following) return "following stopped when the agent moved";
    if (Math.abs(then.z - zoomed.z) > 0.01) return `the view went to ${then.z.toFixed(2)}×, not the ${zoomed.z.toFixed(2)}× zoomed to`;
    if (r1b.x < 0 || r1b.y < 0 || r1b.x + r1b.width > vp.width || r1b.y + r1b.height > vp.height) return `following at your zoom didn't bring Row One into view (it's at ${Math.round(r1b.x)},${Math.round(r1b.y)})`;
    // A write of several layers: the cursor walks them in order, naming each, and they build in.
    boards.changeBoard(t.id, [{ op: "agent", agent: { key: AGENT, session: AGENT, how: "process", kind: "claude", name: "Design agent", cwd: tmp }, artboards: [phone], at: new Date().toISOString(), touch: { ids: [t.byName("Row One"), t.byName("Row Two"), t.byName("Row Three")], doing: "write" } }], "agent");
    const said = new Set<string>();
    for (let i = 0; i < 30; i++) { const d = await S(page, () => document.querySelector(".bd-cursor-doing")?.textContent ?? ""); if (d) said.add(d); await page.waitForTimeout(100); }
    if (!["adding Row One", "adding Row Two", "adding Row Three"].every((w) => said.has(w))) return `the walk said ${[...said].join(" / ")}`;
    // Moving the view off what the agent is doing stops it.
    await page.mouse.move(vp.width / 2, vp.height / 2);
    for (let i = 0; i < 12; i++) { await page.mouse.wheel(900, 900); await page.waitForTimeout(30); }
    await page.waitForTimeout(400);
    const after = await state();
    return after.following ? `still following ${after.following} with the view moved away` : "ok";
  },
  async "the tab bar: an opened board gets a tab, Home keeps it, and closing it lets it go"(page) {
    const b = boards.createBoard("Tabbed board", "studio");
    await S(page, async (id: string) => (await import("/ui/board-state.js" as string)).openBoard(id), b.id);
    await page.waitForSelector(".bd-app .tabbar .tab.on");
    const onBoard = await S(page, () => document.querySelector(".tabbar .tab.on")?.textContent?.trim());
    await page.click(".tabbar .tab-home");
    await page.waitForSelector(".home");
    const kept = await S(page, (id: string) => Boolean(document.querySelector(`.home .tabbar [data-tab-board="${id}"]`)), b.id);
    await page.click(`.tabbar [data-tab-board="${b.id}"]`);
    await page.waitForSelector(".bd-app");
    const back = await S(page, async () => (await import("/ui/board-state.js" as string)).B.id);
    await page.click(`.tabbar [data-tab-board="${b.id}"] .tab-x`);
    await page.waitForSelector(".home");
    const gone = await S(page, (id: string) => !document.querySelector(`[data-tab-board="${id}"]`), b.id);
    boards.deleteBoard(b.id);
    return onBoard === "Tabbed board" && kept && back === b.id && gone ? "ok" : `tab: "${onBoard}", kept on Home: ${kept}, reopened: ${back === b.id}, closed: ${gone}`;
  },
  async "the tab bar: switching from one board's tab to another's never shows Home in between, even when the board loads slowly"(page) {
    const a = boards.createBoard("Tab one", "studio");
    const b = boards.createBoard("Tab two", "studio");
    await S(page, async (id: string) => (await import("/ui/board-state.js" as string)).openBoard(id), a.id);
    await page.waitForSelector(".bd-app .tabbar .tab.on");
    await S(page, async (id: string) => (await import("/ui/board-state.js" as string)).openBoard(id), b.id);
    await page.waitForFunction((id: string) => document.querySelector(".tabbar .tab.on")?.getAttribute("data-tab-board") === id, b.id);
    // Watch every change to the page while switching back, with the board's load held up for a moment.
    await page.route(`**/api/board?id=${a.id}`, async (r) => { await new Promise((ok) => setTimeout(ok, 400)); await r.continue(); });
    await S(page, () => {
      (window as any).__sawHome = false;
      const o = new MutationObserver(() => { if (document.querySelector(".home")) (window as any).__sawHome = true; });
      o.observe(document.body, { childList: true, subtree: true });
      (window as any).__homeWatch = o;
    });
    await page.click(`.tabbar [data-tab-board="${a.id}"]`);
    await page.waitForFunction((id: string) => document.querySelector(".tabbar .tab.on")?.getAttribute("data-tab-board") === id, a.id, { timeout: 5000 });
    await page.waitForTimeout(150);
    const r = await S(page, async () => {
      (window as any).__homeWatch.disconnect();
      return { sawHome: (window as any).__sawHome as boolean, id: (await import("/ui/board-state.js" as string)).B.id as string, drawn: document.querySelectorAll(".bd-app").length };
    });
    await page.unroute(`**/api/board?id=${a.id}`);
    for (const id of [a.id, b.id]) await S(page, async (id: string) => (await import("/ui/tabs.js" as string)).closeTab(id), id);
    boards.deleteBoard(a.id);
    boards.deleteBoard(b.id);
    return !r.sawHome && r.id === a.id && r.drawn === 1 ? "ok" : `Home showed during the switch: ${r.sawHome}, open board: ${r.id === a.id ? "the right one" : r.id}, editors drawn: ${r.drawn}`;
  },
  async "Home: boards sort by name, show as a list, and the scratchpad stays in the sidebar"(page) {
    const made = ["Zebra", "Apple", "Mango"].map((n) => boards.createBoard(n, "studio"));
    await S(page, async () => (await import("/ui/board-library.js" as string)).refreshBoards());
    await page.waitForSelector(".home .sp-card");
    const names = () => S(page, () => [...document.querySelectorAll(".home .sp-card .sp-text b")].map((e) => e.textContent ?? ""));
    await page.click(".home-filters .dd-btn");
    await page.locator(".menu-item", { hasText: "Name" }).click();
    await page.waitForTimeout(250);
    const sorted = (await names()).filter((n) => ["Zebra", "Apple", "Mango"].includes(n));
    const scratch = await S(page, () => Boolean(document.querySelector('.home .sp-card[data-board="scratchpad"]')));
    await page.click('.home-view button[title="List"]');
    await page.waitForTimeout(200);
    const rows = await S(page, () => {
      const cards = [...document.querySelectorAll(".home .sp-card")].map((c) => c.getBoundingClientRect());
      return cards.length > 1 && cards.every((r) => r.height < 70) && cards[1].top > cards[0].top && Math.abs(cards[1].left - cards[0].left) < 1;
    });
    await page.click('.home-view button[title="Grid"]');
    await page.click(".home-filters .dd-btn");
    await page.locator(".menu-item", { hasText: "Last edited" }).click();
    for (const b of made) boards.deleteBoard(b.id);
    await S(page, async () => (await import("/ui/board-library.js" as string)).refreshBoards());
    return sorted.join() === "Apple,Mango,Zebra" && !scratch && rows ? "ok" : `by name: ${sorted.join()}, scratchpad among them: ${scratch}, list rows: ${rows}`;
  },
  async "on a board: tools dock at the bottom, the chat opens beside Design with Comments, and Code shows the layer's HTML"(page) {
    const t = await openTestBoard(page);
    const dock = await S(page, () => {
      const d = document.querySelector(".bd-dock")?.getBoundingClientRect();
      const st = document.querySelector(".bd-stage")?.getBoundingClientRect();
      return d && st ? { low: st.bottom - d.bottom < 40 && d.top > st.top + st.height / 2, mid: Math.abs(d.left + d.width / 2 - (st.left + st.width / 2)) < 2 } : null;
    });
    await page.click(".bd-agent-toggle");
    await page.waitForSelector(".bd-chat-col");
    await page.waitForTimeout(350);
    const beside = await S(page, () => {
      const c = document.querySelector(".bd-chat-col")?.getBoundingClientRect();
      const r = document.querySelector(".bd-right")?.getBoundingClientRect();
      return Boolean(c && r && c.width > 200 && Math.abs(c.right - r.left) < 2);
    });
    await page.click('.bd-chat-tabs [data-tab="comments"]');
    await page.waitForTimeout(200);
    const comments = await S(page, () => Boolean(document.querySelector(".bd-chat-col .bd-comments, .bd-chat-col [class*=comment]")));
    await page.click(".bd-chat-bar .icon-btn");
    await page.waitForTimeout(200);
    const closed = await S(page, () => !document.querySelector(".bd-chat-col"));
    await S(page, async (id: string) => (await import("/ui/board-state.js" as string)).select([id]), t.byName("Row One"));
    await page.waitForTimeout(150);
    await page.click('.bd-design-tabs [data-tab="code"]');
    await page.waitForTimeout(250);
    const code = await S(page, () => document.querySelector(".bd-codeview-text")?.textContent ?? "");
    await page.click('.bd-design-tabs [data-tab="design"]');
    const ok = dock?.low && dock.mid && beside && comments && closed && /<div[^>]*style=/.test(code);
    return ok ? "ok" : `dock: ${JSON.stringify(dock)}, chat beside Design: ${beside}, comments there: ${comments}, closes: ${closed}, code: ${code.slice(0, 60)}`;
  },
  async "on a board: menus in the chat open by their buttons, the two right panels share one header rule, fields are 24px, and a selected frame lights what's inside it"(page) {
    const t = await openTestBoard(page);
    await page.click(".bd-agent-toggle");
    await page.waitForSelector(".bd-chat-col");
    await page.waitForTimeout(450);
    // The chat column slides in; a menu opened inside it must still land by its button.
    let menu: { near: boolean; inside: boolean } | "none" | null = "none";
    if (await page.locator(".ag-pick:not(:disabled)").count()) {
      await page.click(".ag-pick");
      await page.waitForTimeout(250);
      menu = await S(page, () => {
        const b = document.querySelector(".ag-pick")?.getBoundingClientRect();
        const p = document.querySelector(".ag-composer .pop")?.getBoundingClientRect();
        return b && p ? { near: Math.abs(p.left - b.left) < 24 && Math.abs(p.bottom - b.top) < 24, inside: p.left >= 0 && p.right <= innerWidth && p.top >= 0 && p.bottom <= innerHeight } : null;
      });
      await page.keyboard.press("Escape");
      await page.waitForTimeout(150);
    }
    const rule = await S(page, () => {
      const a = document.querySelector(".bd-chat-col .ag-head")?.getBoundingClientRect();
      const r = document.querySelector(".bd-right-head")?.getBoundingClientRect();
      return a && r ? Math.round(a.bottom - r.bottom) : null;
    });
    await page.click('.bd-chat-tabs [data-tab="comments"]');
    await page.waitForTimeout(200);
    const rule2 = await S(page, () => {
      const a = document.querySelector(".bd-comments > .bd-head")?.getBoundingClientRect();
      const r = document.querySelector(".bd-right-head")?.getBoundingClientRect();
      return a && r ? Math.round(a.bottom - r.bottom) : null;
    });
    await page.click(".bd-chat-bar .icon-btn");
    // A frame with layers inside, open in the list.
    const phone = t.byName("Phone");
    await S(page, async (id: string) => {
      const s = await import("/ui/board-state.js" as string);
      s.bset({ open: new Set([id]) });
      s.select([id]);
    }, phone);
    await page.waitForTimeout(250);
    const look = await S(page, () => {
      const rows = [...document.querySelectorAll(".bd-row")];
      const on = rows.filter((r) => r.classList.contains("on"));
      const under = rows.filter((r) => r.classList.contains("under"));
      const lit = rows.filter((r) => r.classList.contains("on") || r.classList.contains("under"));
      const num = document.querySelector(".bd-right .num")?.getBoundingClientRect();
      const h3 = document.querySelector(".bd-right .section-head h3");
      return {
        on: on.length,
        under: under.length,
        caps: lit.length > 1 && /cap-t/.test(lit[0].className) && /cap-b/.test(lit[lit.length - 1].className) && lit.slice(1, -1).every((r) => !/cap-/.test(r.className)),
        row: Math.round(rows[0]?.getBoundingClientRect().height ?? 0),
        field: Math.round(num?.height ?? 0),
        type: h3 ? getComputedStyle(h3).fontSize : "",
      };
    });
    const ok = (menu === "none" || (menu && menu.near && menu.inside)) && (rule === 0 || (rule === null && menu === "none")) && rule2 === 0 && look.on === 1 && look.under >= 3 && look.caps && look.row === 24 && look.field === 24 && look.type === "11px";
    return ok ? "ok" : `the agent menu: ${JSON.stringify(menu)}, chat rule off by ${rule}px, comments rule off by ${rule2}px, layers: ${JSON.stringify(look)}`;
  },
  async "the sign-in screen: an email gets the code boxes, a wrong code says so, and signing in goes on to the first-run steps"(page) {
    await S(page, async () => (await import("/ui/board-state.js" as string)).closeBoard());
    const need = (sel: string) => page.waitForSelector(sel, { timeout: 8000 }).then(() => true, () => false);
    await page.route("**/api/cloud/signin/email/send", (r) => r.fulfill({ json: { email: "ada@example.com" } }));
    let tries = 0;
    await page.route("**/api/cloud/signin/email/verify", (r) => (tries++ === 0 ? r.fulfill({ status: 400, headers: { "x-test-refusal": "1" }, json: { error: "That code isn't right. Check it and try again." } }) : r.fulfill({ json: { user: { id: "u-test", name: "ada@example.com", email: "ada@example.com" }, teams: [] } })));
    await page.route("**/api/cloud/account", (r) => r.fulfill({ json: { signedIn: tries > 1, serverUrl: "", user: tries > 1 ? { id: "u-test", name: "ada@example.com", email: "ada@example.com" } : undefined, teams: [] } }));
    const before = await S(page, async () => {
      const st = await import("/ui/store.js" as string);
      const keep = { opts: st.S.opts, cloud: st.S.cloud ?? null };
      st.set({ modal: null, opts: { ...st.S.opts, requireAccount: true }, cloud: { loaded: true, signedIn: false, teams: [], serverUrl: "" }, gate: undefined });
      return keep;
    });
    const restore = async () => {
      await page.unroute("**/api/cloud/signin/email/send");
      await page.unroute("**/api/cloud/signin/email/verify");
      await page.unroute("**/api/cloud/account");
      await S(page, async (keep: Record<string, unknown>) => (await import("/ui/store.js" as string)).set({ ...keep, gate: false }), before as Record<string, unknown>);
      await page.waitForTimeout(300);
    };
    if (!(await need(".gate"))) return await restore(), "the sign-in screen didn't show";
    const hidden = await S(page, () => !document.querySelector(".home, .bd-app"));
    await page.fill(".gate-input", "ada@example.com");
    await page.click(".gate-btn");
    if (!(await need(".gate-code"))) return await restore(), "no code boxes after the email";
    await page.waitForTimeout(200);
    await page.keyboard.type("111111");
    if (!(await need(".gate-err"))) return await restore(), `a wrong code said nothing (boxes: "${await S(page, () => document.querySelector(".gate-code")?.textContent ?? "")}", tries: ${tries})`;
    const wrong = await S(page, () => document.querySelector(".gate-err")?.textContent ?? "");
    await page.waitForTimeout(250);
    await page.keyboard.type("222222");
    const on = await need(".gate-steps");
    const step = await S(page, () => document.querySelector(".gate h1")?.textContent ?? "");
    await restore();
    return hidden && /isn't right/.test(wrong) && on && /call you/.test(step) ? "ok" : `app hidden: ${hidden}, wrong code: "${wrong}", steps shown: ${on}, then: "${step}", tries: ${tries}`;
  },
  async "Settings has its sections down the side, and the Team plan adds up seats and price"(page) {
    await S(page, async () => (await import("/ui/store.js" as string)).set({ modal: { kind: "settings", tab: "general" } }));
    await page.waitForSelector(".set-sheet");
    await page.waitForTimeout(350);
    const size = () => S(page, () => { const r = document.querySelector(".set-sheet")!.getBoundingClientRect(); return `${Math.round(r.width)}x${Math.round(r.height)}`; });
    const a = await size();
    await page.locator(".set-nav button", { hasText: "Shortcuts" }).click();
    const b = await size();
    await page.locator(".set-nav button", { hasText: "Plan" }).click();
    await page.locator(".set-row button", { hasText: "See the Team plan" }).click();
    await page.waitForSelector(".plan-sheet");
    const total = async () => (await page.waitForTimeout(350), S(page, () => document.querySelector(".plan-total")?.textContent ?? ""));
    const yearly = await total();
    await page.locator(".plan-opt", { hasText: "Monthly" }).click();
    await page.click('.plan-step button[title="One more"]');
    const monthly = await total();
    await page.keyboard.press("Escape");
    await page.waitForTimeout(200);
    const closed = await S(page, () => !document.querySelector(".plan-sheet"));
    return a === b && yearly === "$576.00" && monthly === "$80.00" && closed ? "ok" : `sheet ${a} then ${b}, yearly for 3: ${yearly}, monthly for 4: ${monthly}, Esc closes: ${closed}`;
  },
  async "the theme: picked in Settings, there from the first frame after a reload, and System follows the Mac"(page) {
    await S(page, async () => (await import("/ui/store.js" as string)).set({ modal: { kind: "settings" } }));
    const appearance = page.locator(".sheet .card", { hasText: "Appearance" });
    await appearance.locator("button", { hasText: "Light" }).click();
    const picked = await S(page, () => document.documentElement.dataset.theme);
    const bg = await S(page, () => getComputedStyle(document.body).backgroundColor);
    // Saved (after the half-second the app waits), and written on the page the server sends.
    await page.waitForTimeout(900);
    const served = /data-theme-pref="(\w+)"/.exec(await (await fetch(BASE)).text())?.[1];
    await page.reload({ waitUntil: "domcontentloaded" });
    const first = await S(page, () => document.documentElement.dataset.theme);
    await page.waitForSelector(".topbar, .home", { timeout: 15000 });
    // System: whatever the Mac is, as it changes.
    await S(page, async () => (await import("/ui/store.js" as string)).setTheme("system"));
    await page.emulateMedia({ colorScheme: "light" });
    await page.waitForTimeout(200);
    const sysLight = await S(page, () => document.documentElement.dataset.theme);
    await page.emulateMedia({ colorScheme: "dark" });
    await page.waitForTimeout(200);
    const sysDark = await S(page, () => document.documentElement.dataset.theme);
    await page.waitForTimeout(900);
    const servedAfter = /data-theme-pref="(\w+)"/.exec(await (await fetch(BASE)).text())?.[1];
    const got = { picked, bg, served, first, sysLight, sysDark, servedAfter };
    return picked === "light" && bg === "rgb(239, 239, 241)" && served === "light" && first === "light" && sysLight === "light" && sysDark === "dark" && servedAfter === "system" ? "ok" : JSON.stringify(got);
  },
  async "light and dark: on every screen the words read, and nothing is left in the other theme's colours"(page) {
    const problems: string[] = [];
    for (const theme of ["light", "dark"]) {
      await S(page, async (t: string) => (await import("/ui/store.js" as string)).setTheme(t), theme);
      await S(page, async () => {
        const st = await import("/ui/store.js" as string);
        st.set({ modal: null, toasts: [], menu: null });
      });
      await page.waitForTimeout(300);
      const look = async (screen: string) => {
        await page.waitForTimeout(450);
        await picture(page, `theme-${theme}-${screen}`);
        for (const issue of await themeAudit(page)) problems.push(`${theme} ${screen}: ${issue}`);
      };
      for (const [screen, go] of SCREENS) {
        await go(page);
        await look(screen);
      }
      // A board: its editor, a layer picked, the comments, a thread and the bar that sends them.
      await store(page, { modal: null });
      const t = await openTestBoard(page);
      boards.changeBoard(t.id, [{ op: "agent", agent: { key: AGENT, session: AGENT, how: "process", kind: "claude", name: "Design agent", cwd: tmp }, artboards: [t.byName("Phone")], at: new Date().toISOString() }], "agent");
      talk.startThread(t.id, { layer: t.byName("Row One") }, { text: "Row one is too tight", by: "person", pending: true });
      const sent = talk.startThread(t.id, { layer: t.byName("Row Two") }, { text: "@Design agent make this bold", by: "person", to: [AGENT] });
      talk.reply(t.id, sent.thread.id, { text: "Done: **bold** now.", by: AGENT, name: "Design agent" });
      await page.waitForTimeout(1200);
      await look("board");
      await S(page, async (id: string) => (await import("/ui/board-state.js" as string)).select([id]), t.byName("Row One"));
      await look("board-layer");
      await page.click('.bd-left-tabs [data-tab="assets"]').catch(() => undefined);
      await look("board-assets");
      await S(page, async () => (await import("/ui/board-state.js" as string)).bset({ rightTab: "agent" }));
      await look("board-agent");
      await S(page, async () => (await import("/ui/board-state.js" as string)).bset({ rightTab: "design" }));
      await S(page, async () => (await import("/ui/board-state.js" as string)).bset({ rightTab: "comments" }));
      await S(page, async (id: string) => (await import("/ui/board-comments.js" as string)).openThread(id), sent.thread.id);
      await look("board-comments");
      await page.click(".bd-sendbar-count").catch(() => undefined);
      await look("board-send");
      await S(page, async () => (await import("/ui/board-state.js" as string)).closeBoard());
    }
    await S(page, async () => (await import("/ui/store.js" as string)).setTheme("system"));
    return problems.length ? `${problems.length} problems:\n    ${problems.join("\n    ")}` : "ok";
  },
  async "on a board, comments wait until Send, then reach the agent as one list"(page) {
    const t = await openTestBoard(page);
    boards.changeBoard(t.id, [{ op: "agent", agent: { key: AGENT, session: AGENT, how: "process", kind: "claude", name: "Design agent", cwd: tmp }, artboards: [t.byName("Phone")], at: new Date().toISOString() }], "agent");
    await page.waitForTimeout(1200);
    const before = agentman.sent.length;
    await page.keyboard.press("c");
    for (const [name, words] of [["Row One", "Row one is too tight"], ["Row Two", "Row two should be bold"]]) {
      const r = await boxOf(page, t.byName(name));
      await page.mouse.click(r.x + r.width - 18, r.y + 8);
      await page.waitForSelector(".bd-thread textarea");
      await page.keyboard.type(words);
      await page.keyboard.press("Enter");
      // The card closes, so the next click comments somewhere else.
      await page.waitForFunction(() => !document.querySelector(".bd-thread"), null, { timeout: 4000 }).catch(() => undefined);
    }
    await page.waitForTimeout(300);
    const bar = await S(page, () => ({ count: document.querySelector(".bd-sendbar-count")?.textContent ?? "", to: document.querySelector(".bd-sendbar-to .nm")?.textContent ?? "", pins: document.querySelectorAll(".bd-pin.pending").length }));
    if (bar.count !== "2comments to send" || bar.to !== "Design agent" || bar.pins !== 2) return `the bar says ${JSON.stringify(bar)}`;
    if (agentman.sent.length !== before) return "a comment went to the agent before Send";
    // Look them over: the list, then one changed where it is.
    await page.click(".bd-sendbar-count");
    await page.waitForTimeout(250);
    await picture(page, "comments-pending-list");
    const rows = await S(page, () => [...document.querySelectorAll(".bd-sendbar-row .txt")].map((x) => x.textContent).join("|"));
    if (rows !== "Row one is too tight|Row two should be bold") return `the list shows "${rows}"`;
    await page.click(".bd-sendbar-row .go");
    await page.waitForSelector(".bd-thread .bd-pending-tag");
    await page.waitForTimeout(250);
    await picture(page, "comments-pending-thread");
    await page.click(".bd-thread .bd-msg.pending .bd-link");
    await page.keyboard.press("Meta+a");
    await page.keyboard.type("Row one needs 12px more padding");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(500);
    const edited = talk.getComments(t.id).threads.flatMap((x) => x.messages).some((m) => m.pending && m.text === "Row one needs 12px more padding");
    if (!edited) return "changing a comment that hasn't been sent didn't save";
    await page.keyboard.press("Escape");
    await page.click(".bd-sendbar-to");
    await page.waitForTimeout(250);
    await picture(page, "comments-send-to");
    await page.click(".bd-sendbar-to");
    await page.click(".bd-sendbar-send");
    await page.waitForFunction(() => !document.querySelector(".bd-sendbar"), null, { timeout: 8000 }).catch(() => undefined);
    await page.waitForTimeout(800);
    const out = agentman.sent.slice(before);
    if (out.length !== 1 || out[0].sessionId !== AGENT) return `Send handed Agentman ${out.length} messages`;
    if (!/sent you 2 comments at once/.test(out[0].text) || !out[0].text.includes("> Row one needs 12px more padding") || !out[0].text.includes("> Row two should be bold") || !/\n2\. Comment /.test(out[0].text)) return "the message isn't the list of both comments";
    const delivered = talk.getComments(t.id).threads.every((x) => x.messages.every((m) => !m.pending && m.delivery?.[AGENT]?.status === "delivered"));
    if (!delivered) return "the comments don't say they were delivered";
    // A reply waits in its thread too, with the thread left open.
    const first = talk.getComments(t.id).threads[0];
    await S(page, async (id: string) => (await import("/ui/board-comments.js" as string)).openThread(id), first.id);
    await page.waitForSelector(".bd-thread textarea");
    await page.keyboard.type("Also round the corners");
    await page.keyboard.press("Enter");
    const waiting = await page.waitForFunction(() => document.querySelector(".bd-thread .bd-msg.pending .txt")?.textContent === "Also round the corners" && document.querySelector(".bd-pin i.pending") && document.querySelector(".bd-sendbar-count")?.textContent === "1comment to send", null, { timeout: 5000 }).then(() => true, () => false);
    return waiting && agentman.sent.length === before + 1 ? "ok" : "a reply didn't wait in its open thread to be sent";
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
    if (typed !== "Hey @Helper can you tidy this row?" || button !== "Add comment" || to !== "To Helper") return `the words are "${typed}", the button says "${button}", "${to}"`;
    // ⌘⏎ adds it and sends at once.
    await page.keyboard.press("Meta+Enter");
    const tidy = () => talk.getComments(t.id).threads.find((x) => x.messages.some((m) => m.text.includes("tidy this row") && m.delivery?.["codex:helper"]?.status === "delivered"));
    for (let i = 0; i < 40 && !tidy(); i++) await page.waitForTimeout(200);
    const tagged = tidy();
    await S(page, async (id: string) => (await import("/ui/board-comments.js" as string)).openThread(id), tagged?.id ?? "");
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
    const area = await S(page, () => Boolean(document.querySelector(".bd-carea")));
    await page.click(".bd-compose .bd-send");
    await page.waitForTimeout(500);
    const th = talk.getComments(t.id).threads[0];
    const layers = (th?.anchor.layers ?? []).map((id) => boards.getBoard(t.id).nodes[id]?.name).join();
    if (!th?.anchor.rect || th.anchor.artboard !== t.byName("Phone")) return "the region wasn't saved on the artboard";
    if (layers !== "List") return `the region covers ${layers || "nothing"}, not List`;
    if (note || th.messages[0].to?.length || !th.messages[0].pending) return "with no agent tagged, it should wait to be sent, to no one in particular";
    return area ? "ok" : "the region isn't outlined while the comment is written";
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
  async "a number field: Escape calls off what's typed, Enter keeps it once"(page) {
    const t = await openTestBoard(page);
    const phone = t.byName("Phone");
    await S(page, async (id: string) => (await import("/ui/board-state.js" as string)).select(id), phone);
    await page.waitForTimeout(300);
    const field = page.locator(".bd-right .bd-size-field .num input").first();
    const past = () => S(page, async () => (await import("/ui/board-state.js" as string)).B.past.length);
    await field.click();
    await field.fill("123");
    await field.press("Escape");
    await page.waitForTimeout(500);
    if (boards.getBoard(t.id).nodes[phone].style.width !== "390px") return `Escape saved it: ${boards.getBoard(t.id).nodes[phone].style.width}`;
    const before = await past();
    await field.click();
    await field.fill("300");
    await field.press("Enter");
    await page.waitForTimeout(500);
    const steps = (await past()) - before;
    return boards.getBoard(t.id).nodes[phone].style.width === "300px" && steps === 1 ? "ok" : `Enter: width ${boards.getBoard(t.id).nodes[phone].style.width}, ${steps} undo steps`;
  },
  async "a paste goes onto the open board; on Home it starts a board with it"(page) {
    const t = await openTestBoard(page);
    const cmd = (p: string) => S(page, (p: string) => (window as unknown as { studio: { command: (n: string, a: unknown) => unknown } }).studio.command("imported", [{ path: p, width: 390, height: 844 }]), p);
    // A paste in the Mac app (or a file opened from Finder) arrives as `imported`.
    await cmd(shot);
    await page.waitForTimeout(1500);
    const onBoard = Object.values(boards.getBoard(t.id).nodes).some((n) => n.type === "image" && n.src === shot);
    // On Home: a new board, open, with the picture on it.
    await S(page, async () => (await import("/ui/board-state.js" as string)).closeBoard());
    await page.waitForTimeout(300);
    await cmd(used);
    await page.waitForTimeout(1800);
    const opened = await S(page, async () => (await import("/ui/store.js" as string)).S.boardId as string | null);
    const started = Boolean(opened && opened !== t.id && Object.values(boards.getBoard(opened).nodes).some((n) => n.type === "image" && n.src === used));
    return onBoard && started ? "ok" : `pasted onto the board: ${onBoard}; on Home, a board started with it: ${started} (${opened})`;
  },
  async "on a board, a save the engine misses is tried again, and one it refuses leaves undo"(page) {
    const t = await openTestBoard(page);
    const phone = t.byName("Phone");
    // The engine away for two tries: the change still lands.
    let missed = 0;
    await page.route("**/api/board/ops", (r) => (missed++ < 2 ? r.abort() : r.continue()));
    await S(page, async (id: string) => (await import("/ui/board-state.js" as string)).commit([{ op: "set", id, name: "Kept" }], { label: "Rename" }), phone);
    for (let i = 0; i < 40 && boards.getBoard(t.id).nodes[phone].name !== "Kept"; i++) await page.waitForTimeout(150);
    await page.unroute("**/api/board/ops");
    if (boards.getBoard(t.id).nodes[phone].name !== "Kept") return `not saved after the engine came back (${missed} tries)`;
    // Refused: the change goes, from the canvas and from undo, and the person is told.
    await page.route("**/api/board/ops", (r) => r.fulfill({ status: 400, contentType: "application/json", headers: { "x-test-refusal": "1" }, body: JSON.stringify({ error: "No." }) }));
    const after = await S(page, async (id: string) => {
      const m = await import("/ui/board-state.js" as string);
      const before = m.B.past.length;
      m.commit([{ op: "set", id, name: "Refused" }], { label: "Rename" });
      await new Promise((r) => setTimeout(r, 1500));
      return { name: m.B.board.nodes[id].name, undo: m.B.past.length - before, labels: m.B.past.map((e: { label?: string }) => e.label) };
    }, phone);
    await page.unroute("**/api/board/ops");
    const told = /Couldn.t save/.test(String(await toasts(page)));
    return after.name === "Kept" && after.undo === 0 && told ? "ok" : `after a refusal: ${JSON.stringify(after)}, told ${told}`;
  },
  async "the first run is remembered with the app's saved state, not only the window's storage (a new port each launch)"(page) {
    const r = await S(page, async () => {
      const st = await import("/ui/store.js" as string);
      const gate = await import("/ui/gate.js" as string);
      const user = { id: "first-run-check" };
      const key = `onboarded:${user.id}`;
      const before = gate.onboarded(user);
      st.touch(key);
      // A launch on another port starts with empty storage.
      localStorage.clear();
      const now = gate.onboarded(user);
      await new Promise((ok) => setTimeout(ok, 900));
      const saved = await st.api("/api/state");
      return { before, now, saved: Boolean(saved?.ui?.touched?.[key]) };
    });
    return !r.before && r.now && r.saved ? "ok" : JSON.stringify(r);
  },
  async "the welcome board walks through the app card by card, over real screenshots, with agents' sticky notes on it"(page) {
    const made = await S(page, async () => (await import("/ui/store.js" as string)).api("/api/board/welcome", {}));
    // Asked again (another first run, another window): the same board, never a second.
    const again = await S(page, async () => (await import("/ui/store.js" as string)).api("/api/board/welcome", {}));
    if (again.id !== made.id) return "a second welcome board was made";
    const b = boards.getBoard(made.id);
    const nodes = Object.values(b.nodes);
    const roots = b.pages[0].children.map((id) => b.nodes[id]);
    const cards = roots.filter((n) => n.type === "frame");
    const shots = nodes.filter((n) => n.type === "image" && n.name === "Screenshot");
    const kept = nodes.filter((n) => n.type === "image").every((n) => n.src && existsSync(n.src) && n.src.includes(`${path.sep}.studio${path.sep}`));
    const notes = roots.filter((n) => n.shape?.type === "note");
    boards.deleteBoard(made.id);
    // The feature cards are live layers: a shader under glass, a component with its copies, shapes and stickers.
    const live = nodes.some((n) => n.shader?.preset) && nodes.some((n) => n.effects?.some((e) => e.type === "glass")) && nodes.filter((n) => n.instanceOf).length === 3 && nodes.some((n) => n.shape?.type === "burst") && b.tokens.some((t) => /brand/.test(t.name));
    const ok = cards[0]?.name === "Start here" && cards.length === 12 && shots.length === 6 && kept && notes.length === 4 && notes.some((n) => n.shape?.caption === "Claude Code") && live;
    return ok ? "ok" : `cards: ${cards.map((c) => c.name).join(", ")}; screenshots: ${shots.length} (in the library: ${kept}); notes: ${notes.length}; live layers: ${live}`;
  },
  async "a sticky note from the Assets panel: handwriting on the canvas, its words and pin in the Design panel"(page) {
    const t = await openTestBoard(page);
    await S(page, async () => (await import("/ui/board-state.js" as string)).select([]));
    await page.locator(".bd-left-tabs button", { hasText: "Assets" }).click();
    await page.waitForTimeout(400);
    await page.locator(".bd-asset.shape", { hasText: "Sticky note" }).click();
    await page.waitForTimeout(600);
    const made = Object.values(boards.getBoard(t.id).nodes).find((n) => n.name === "Sticky note");
    if (!made?.shape || made.shape.type !== "note") return "no sticky note landed on the page";
    await page.waitForSelector(".bd-note-words");
    await page.fill(".bd-note-words", "Swapped Inter for Geist everywhere");
    await page.locator(".bd-right .dd-btn", { hasText: "Tape" }).click();
    await page.locator(".menu-item", { hasText: "Pin" }).click();
    await page.waitForTimeout(500);
    const after = boards.getBoard(t.id).nodes[made.id];
    const drawn = await S(page, (id: string) => {
      const el = document.querySelector(`.bd-world [data-bid="${id}"]`);
      const text = el?.querySelector("text");
      return { family: text ? getComputedStyle(text).fontFamily : "", words: [...(el?.querySelectorAll("text") ?? [])].map((x) => x.textContent).join(" "), loaded: document.fonts.check("20px 'Gloria Hallelujah'") };
    }, made.id);
    const ok = after.shape?.text === "Swapped Inter for Geist everywhere" && after.shape?.attach === "pin" && /Gloria Hallelujah/.test(drawn.family) && /Geist/.test(drawn.words);
    return ok ? "ok" : `words: ${after.shape?.text}, held by: ${after.shape?.attach}, drawn in: ${drawn.family}, shows: "${drawn.words}"`;
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
  async "on a board, Use as mask (⌃⌘M) clips the layers above it, live as they and it move, change and scale, with its list marks, panel and undo"(page) {
    const t = await openMaskBoard(page, `<div data-name="Card" style="position:relative;width:400px;height:400px;background:#fff"><div data-name="Below" style="position:absolute;left:0;top:0;width:40px;height:40px;background:rgb(0,0,255)"></div><div data-name="Shape" style="position:absolute;left:100px;top:100px;width:200px;height:200px;border-radius:50%;background:#000"></div><div data-name="Photo" style="position:absolute;left:0;top:0;width:400px;height:400px;background:rgb(255,0,0)"></div></div>`);
    const [card, shape, photo] = ["Card", "Shape", "Photo"].map(t.byName);
    const look = (pts: Array<[number, number]>) => colorsAt(page, card, 400, pts);
    if ((await look([[20, 20]])).join() !== "red") return "the photo doesn't cover the card before it's masked";
    await sel(page, [shape]);
    await page.waitForTimeout(200);
    await page.locator(`.bd-row[data-lid="${shape}"]`).click();
    await page.locator(".bd-stage").hover({ position: { x: 5, y: 5 } });
    await page.keyboard.press("Control+Meta+KeyM");
    await page.waitForTimeout(500);
    if (nodeOf(t, shape).mask !== "alpha") return `⌃⌘M made it ${nodeOf(t, shape).mask}`;
    // The circle shows the photo; outside it, the layer below the mask and the card show.
    let got = await look([[200, 200], [20, 20], [380, 380], [110, 110]]);
    if (got.join() !== "red,blue,white,white") return `masked, the card shows ${got.join()} (centre, below, corner, outside the circle)`;
    // The layer list joins the mask to the layers it masks; the panel says what it is.
    if (!(await page.locator(`.bd-row[data-lid="${shape}"] .bd-mask-mark.head`).count()) || !(await page.locator(`.bd-row[data-lid="${photo}"] .bd-mask-mark.end`).count())) return "the layer list doesn't mark the mask and what it masks";
    const panel = page.locator(".bd-right section", { has: page.locator("h3", { hasText: /^Mask$/ }) });
    if ((await panel.locator(".seg button.on").textContent())?.trim() !== "Alpha") return "the panel's Mask section doesn't show Alpha";
    // Moving the photo: clipped all the way, live.
    await sel(page, []);
    const cb = await boxOf(page, card);
    const k = cb.width / 400;
    await page.mouse.move(cb.x + 200 * k, cb.y + 200 * k);
    await page.mouse.down();
    await page.mouse.move(cb.x + 280 * k, cb.y + 200 * k, { steps: 4 });
    await page.mouse.move(cb.x + 350 * k, cb.y + 200 * k, { steps: 4 });
    await page.waitForTimeout(120);
    got = await look([[120, 200], [250, 200]]);
    await page.mouse.up();
    await page.waitForTimeout(500);
    if (got.join() !== "white,red") return `mid-drag, the moved photo shows ${got.join()} at the circle's left and middle`;
    if (styleOf(t, photo).left !== "150px") return `the photo was dropped at ${styleOf(t, photo).left}`;
    await page.keyboard.press("Meta+z");
    await page.waitForTimeout(400);
    // Moving the mask (arrow keys) moves what shows.
    await sel(page, [shape]);
    for (let i = 0; i < 5; i++) await page.keyboard.press("Shift+ArrowRight");
    await page.waitForTimeout(400);
    await sel(page, []);
    got = await look([[110, 200], [340, 200]]);
    if (got.join() !== "white,red") return `the mask moved 50 px right shows ${got.join()}`;
    // Off with its eye, on again; then by its brightness (black: nothing) and by its outline.
    await sel(page, [shape]);
    await page.waitForTimeout(200);
    await panel.locator("[data-mask-eye]").click();
    await page.waitForTimeout(300);
    const off = (await look([[380, 380]])).join();
    await panel.locator("[data-mask-eye]").click();
    await page.waitForTimeout(300);
    await panel.locator(".seg button", { hasText: "Luminance" }).click();
    await page.waitForTimeout(300);
    const luma = (await look([[250, 200]])).join();
    await panel.locator(".seg button", { hasText: "Vector" }).click();
    await page.waitForTimeout(300);
    const vector = (await look([[250, 200], [110, 200]])).join();
    await panel.locator(".seg button", { hasText: "Alpha" }).click();
    await page.waitForTimeout(300);
    if (off !== "red" || luma !== "white" || vector !== "red,white") return `mask off ${off} (red), luminance of black ${luma} (white), vector ${vector} (red,white)`;
    // The Scale tool scales the mask with everything else in the card.
    await sel(page, [card]);
    await page.keyboard.press("k");
    await page.waitForTimeout(300);
    const field = page.locator(".bd-scale-row .num input");
    await field.click();
    await field.fill("50");
    await field.press("Enter");
    await page.waitForTimeout(600);
    await S(page, async () => {
      (document.activeElement as HTMLElement | null)?.blur?.();
      (await import("/ui/board-state.js" as string)).bset({ tool: "move" });
    });
    if (styleOf(t, shape).width !== "100px" || styleOf(t, shape).left !== "75px") return `scaled to 50%, the mask is ${styleOf(t, shape).width} wide at ${styleOf(t, shape).left}`;
    await sel(page, []);
    got = await colorsAt(page, card, 200, [[125, 100], [60, 100], [190, 190]]);
    if (got.join() !== "red,white,white") return `scaled, the card shows ${got.join()}`;
    await page.locator(".bd-stage").hover({ position: { x: 5, y: 5 } });
    await page.keyboard.press("Meta+z");
    await page.waitForTimeout(400);
    // ⌃⌘M on the mask removes it: the photo shows whole; undo puts the mask back.
    await sel(page, [shape]);
    await page.keyboard.press("Control+Meta+KeyM");
    await page.waitForTimeout(400);
    const removed = `${nodeOf(t, shape).mask ?? "none"} ${(await look([[380, 380]])).join()}`;
    await page.keyboard.press("Meta+z");
    await page.waitForTimeout(400);
    await sel(page, [photo]);
    await page.waitForTimeout(200);
    await picture(page, "mask-use");
    const back = `${nodeOf(t, shape).mask} ${(await look([[380, 380], [250, 200]])).join()}`;
    if (removed !== "none red" || back !== "alpha white,red") return `removing the mask: ${removed} (none red); undone: ${back} (alpha white,red)`;
    // Its outline shows over the selected layer it masks.
    if ((await page.locator(".bd-mask-line").count()) !== 1) return "no mask outline over the selected masked layer";
    // The panel's + uses a layer as a mask too; the layer menu offers it.
    await panel.locator("[data-mask-add]").click();
    await page.waitForTimeout(400);
    const viaPanel = nodeOf(t, photo).mask;
    await page.locator(".bd-stage").hover({ position: { x: 5, y: 5 } });
    await page.keyboard.press("Meta+z");
    await page.waitForTimeout(300);
    await sel(page, [shape]);
    await page.locator(`.bd-row[data-lid="${shape}"]`).click({ button: "right" });
    await page.waitForTimeout(300);
    const menu = await page.locator(".ctx-item", { hasText: "Remove mask" }).count();
    await page.keyboard.press("Escape");
    return viaPanel === "alpha" && menu === 1 && !nodeOf(t, photo).mask ? "ok" : `the panel's + made ${viaPanel}; the layer menu has Remove mask ${menu} time(s); undone: ${nodeOf(t, photo).mask ?? "none"}`;
  },
  async "on a board, Mask with selection makes a mask group; gradient, text and vector masks look the same on the canvas and in an export; duplicates and copies keep them"(page) {
    const red = (x: number, w = 200, h = 200) => `<div data-name="Red ${x}" style="position:absolute;left:${x}px;top:0;width:${w}px;height:${h}px;background:rgb(255,0,0)"></div>`;
    // A picture whose left half is opaque and right half clear: as a mask, only its left half shows.
    const half = path.join(LIB, "images", "half-clear.png");
    const rgba = Buffer.alloc(40 * 40 * 4);
    for (let i = 0; i < 40 * 40; i++) rgba.set([0, 0, 0, i % 40 < 20 ? 255 : 0], i * 4);
    writeFileSync(half, encodePng({ width: 40, height: 40, rgba }));
    const t = await openMaskBoard(
      page,
      `<div data-name="Poster" style="position:relative;width:600px;height:520px;background:#fff">` +
        `<div data-name="Fade" style="position:absolute;left:0;top:0;width:200px;height:200px;background-image:linear-gradient(#000, transparent)"></div>${red(0)}` +
        `<p data-name="Word" style="position:absolute;left:200px;top:0;width:200px;height:200px;margin:0;font:900 190px/200px Helvetica;text-align:center;color:#000">M</p>${red(200)}` +
        `<svg data-name="Dot" style="position:absolute;left:400px;top:0;width:200px;height:200px" viewBox="0 0 10 10"><circle cx="5" cy="5" r="5"/></svg>${red(400)}` +
        `<div data-name="Row" style="position:absolute;left:0;top:220px;width:600px;height:80px;display:flex;gap:10px"><div data-name="Dot2" style="width:80px;height:80px;border-radius:50%;background:#000;flex-shrink:0"></div><div data-name="Next" style="width:80px;height:80px;background:#0a0;flex-shrink:0"></div></div>` +
        // Last, so it masks only the layer after it (a mask masks every layer above it, to the next mask).
        `<img data-name="Half" data-mask src="${half}" style="position:absolute;left:0;top:320px;width:200px;height:200px"><div data-name="Red pic" style="position:absolute;left:0;top:320px;width:200px;height:200px;background:rgb(255,0,0)"></div>` +
        `</div>`,
    );
    const poster = t.byName("Poster");
    const pairs = [["Fade", "Red 0"], ["Word", "Red 200"], ["Dot", "Red 400"]].map((p) => p.map(t.byName));
    for (const ids of pairs) {
      await sel(page, ids);
      await page.locator(".bd-stage").hover({ position: { x: 5, y: 5 } });
      await page.keyboard.press("Control+Meta+KeyM");
      await page.waitForTimeout(400);
    }
    const groups = pairs.map(([m]) => nodeOf(t, m).parent!);
    if (groups.some((g, i) => nodeOf(t, g).name !== "Mask group" || nodeOf(t, g).children![0] !== pairs[i][0] || nodeOf(t, pairs[i][0]).mask !== "alpha")) return `mask groups: ${groups.map((g) => `${nodeOf(t, g).name}: ${nodeOf(t, g).children!.map((c) => nodeOf(t, c).name).join("+")}`).join(" | ")}`;
    if (nodeOf(t, groups[0]).style.width !== "200px" || nodeOf(t, groups[1]).style.left !== "200px") return `the groups are ${groups.map((g) => `${nodeOf(t, g).style.left} ${nodeOf(t, g).style.width}`).join(", ")}`;
    // In a flex row, the mask goes into a mask group of its own, which keeps its place in the row.
    const next0 = (await boxOf(page, t.byName("Next"))).x;
    await sel(page, [t.byName("Dot2")]);
    await page.keyboard.press("Control+Meta+KeyM");
    await page.waitForTimeout(500);
    const dotGroup = nodeOf(t, nodeOf(t, t.byName("Dot2")).parent!);
    if (dotGroup.name !== "Mask group" || dotGroup.parent !== t.byName("Row") || dotGroup.style.position !== "relative" || Math.abs((await boxOf(page, t.byName("Next"))).x - next0) > 1) return `in a flex row: ${dotGroup.name} in ${dotGroup.parent}, ${dotGroup.style.position}; the next item moved ${(await boxOf(page, t.byName("Next"))).x - next0} px`;
    await sel(page, []);
    await page.mouse.move(5, 300);
    // What shows, on the canvas: the fade, the letter, the circle.
    const points: Array<[number, number]> = [[100, 12], [100, 150], [500, 100], [404, 4], [300, 250], [50, 420], [150, 420]];
    const canvas = await colorsAt(page, poster, 600, points, true);
    const word = await redShare(page, poster, 600, [200, 0, 200, 200]);
    // And in an export, drawn by the engine.
    const files = await S(page, async (a: { id: string; node: string }) => (await import("/ui/store.js" as string)).api("/api/board/export", { id: a.id, nodes: [a.node], scale: 1, format: "png" }), { id: t.id, node: poster });
    const shot = decodePng(readFileSync((files as { files: string[] }).files[0]));
    const exported = points.map(([x, y]) => colorName(pixelAt(shot, x, y), true));
    let inked = 0;
    for (let y = 0; y < 200; y += 2) for (let x = 200; x < 400; x += 2) inked += colorName(pixelAt(shot, x, y)) === "red" ? 1 : 0;
    const wordExport = inked / 10000;
    const want = "red,faded,red,white,white,red,white";
    if (canvas.join() !== want) return `the canvas shows ${canvas.join()} (${want})`;
    if (exported.join() !== want) return `the export shows ${exported.join()} (${want})`;
    if (word < 0.15 || word > 0.7 || Math.abs(word - wordExport) > 0.06) return `the letter shows ${Math.round(word * 100)}% of its box on the canvas, ${Math.round(wordExport * 100)}% in the export`;
    // And in Preview, a web page of its own in this browser.
    const preview = await page.context().browser()!.newPage();
    await preview.setViewportSize({ width: 900, height: 700 });
    await preview.goto(`${BASE}board/preview?board=${encodeURIComponent(t.id)}&node=${encodeURIComponent(poster)}`, { waitUntil: "networkidle" });
    await preview.waitForTimeout(400);
    const pb = (await preview.locator("#bd-frame > *").first().boundingBox())!;
    const pf = decodePng(await preview.screenshot());
    const previewed = points.map(([x, y]) => colorName(pixelAt(pf, pb.x + x, pb.y + y), true));
    await preview.close();
    if (previewed.join() !== want) return `Preview shows ${previewed.join()} (${want})`;
    // Duplicated, a mask group is still masked; copied and pasted too.
    const scopes = await page.locator(".bd-world [data-mask-scope]").count();
    await sel(page, [groups[2]]);
    await page.keyboard.press("Meta+d");
    await page.waitForTimeout(500);
    const dup = boards.getBoard(t.id).nodes[poster].children!.find((c) => !Object.values(groups).includes(c) && nodeOf(t, c).name === "Mask group" && nodeOf(t, c).parent === poster);
    const dupMask = dup && nodeOf(t, nodeOf(t, dup).children![0]);
    await S(page, () => {
      const dt = new DataTransfer();
      window.dispatchEvent(new ClipboardEvent("copy", { clipboardData: dt, bubbles: true }));
      (window as unknown as { __clip: DataTransfer }).__clip = dt;
    });
    await sel(page, [poster]);
    await S(page, () => window.dispatchEvent(new ClipboardEvent("paste", { clipboardData: (window as unknown as { __clip: DataTransfer }).__clip, bubbles: true })));
    await page.waitForTimeout(600);
    const pasted = Object.values(boards.getBoard(t.id).nodes).filter((n) => n.name === "Mask group" && n.parent === poster).length;
    if (dupMask?.mask !== "alpha" || pasted !== 5 || (await page.locator(".bd-world [data-mask-scope]").count()) !== scopes + 2) return `duplicate's mask ${dupMask?.mask}, ${pasted} mask groups on the poster (5), ${await page.locator(".bd-world [data-mask-scope]").count()} masked on the canvas (${scopes + 2})`;
    // A look in both themes, with the mask group open in the list and its mask in the panel.
    await sel(page, [pairs[1][0]]);
    await page.waitForTimeout(300);
    await picture(page, "mask-group-dark");
    await S(page, async () => (await import("/ui/store.js" as string)).setTheme("light"));
    await page.waitForTimeout(400);
    await picture(page, "mask-group-light");
    await S(page, async () => (await import("/ui/store.js" as string)).setTheme("system"));
    return "ok";
  },
  async "on a board, luminance masks (a gradient, a photo), a mask over a masked group and a vector's own pictures look the same on the canvas, in Preview and in an export"(page) {
    // A red photo, and one bright on its left half and dark on its right (as a luminance mask, it
    // shows what's over it on the left only). Both in the library, where the Studio serves files from.
    const photo = path.join(LIB, "images", "red-photo.png");
    flat(photo, 120, 96, [255, 0, 0]);
    const bright = path.join(LIB, "images", "half-bright.png");
    const rgba = Buffer.alloc(60 * 48 * 4);
    for (let i = 0; i < 60 * 48; i++) rgba.set(i % 60 < 30 ? [255, 255, 255, 255] : [0, 0, 0, 255], i * 4);
    writeFileSync(bright, encodePng({ width: 60, height: 48, rgba }));
    const star = `<svg data-name="Star" data-mask="vector" style="position:absolute;left:0;top:0;width:240px;height:240px" viewBox="0 0 240 240"><polygon points="120,0 150,90 240,90 165,145 195,240 120,180 45,240 75,145 0,90 90,90" fill="#000"/></svg>`;
    const t = await openMaskBoard(
      page,
      `<div data-name="Kinds" style="position:relative;width:1000px;height:240px;background:#fff">` +
        `<div data-name="Fade" style="position:absolute;left:0;top:0;width:300px;height:240px"><div data-mask="luminance" style="position:absolute;left:0;top:0;width:300px;height:240px;background:linear-gradient(90deg,#fff,#000)"></div><img src="${photo}" style="position:absolute;left:0;top:0;width:300px;height:240px;object-fit:cover"></div>` +
        `<div data-name="Bright" style="position:absolute;left:310px;top:0;width:300px;height:240px"><img data-mask="luminance" src="${bright}" style="position:absolute;left:0;top:0;width:300px;height:240px;object-fit:cover"><img src="${photo}" style="position:absolute;left:0;top:0;width:300px;height:240px;object-fit:cover"></div>` +
        `<div data-name="Nested" style="position:absolute;left:620px;top:0;width:240px;height:240px"><div data-mask style="position:absolute;left:20px;top:20px;width:200px;height:200px;border-radius:50%;background:#000"></div><div data-name="Group" style="position:absolute;left:0;top:0;width:240px;height:240px">${star}<img src="${photo}" style="position:absolute;left:0;top:0;width:240px;height:240px;object-fit:cover"></div></div>` +
        // A vector's pictures: an <image> part, and one in its defs (a pattern) written with xlink:href.
        `<svg data-name="Framed" style="position:absolute;left:870px;top:0;width:120px;height:110px" viewBox="0 0 120 110"><image href="${photo}" width="120" height="110" preserveAspectRatio="none"/></svg>` +
        `<svg data-name="Tiled" style="position:absolute;left:870px;top:130px;width:120px;height:110px" viewBox="0 0 120 110"><defs><pattern id="red-tile" patternUnits="userSpaceOnUse" width="120" height="110"><image xlink:href="${photo}" width="120" height="110" preserveAspectRatio="none"/></pattern></defs><rect width="120" height="110" fill="url(#red-tile)"/></svg>` +
        `</div>`,
    );
    const kinds = t.byName("Kinds");
    await sel(page, []);
    await page.mouse.move(5, 300);
    await page.waitForTimeout(400);
    // The fade (strong, faded, gone); the photo mask (its bright half, its dark half); the circle over
    // the star (inside both; inside the circle but not the star; two of the star's points, outside
    // the circle); the vector's two pictures.
    const points: Array<[number, number]> = [[12, 120], [150, 120], [290, 120], [370, 120], [550, 120], [740, 120], [680, 60], [845, 94], [688, 214], [930, 55], [930, 185]];
    const want = "red,faded,white,red,white,red,white,white,white,red,red";
    const canvas = await colorsAt(page, kinds, 1000, points, true);
    await picture(page, "masks-luminance-nested");
    const files = await S(page, async (a: { id: string; node: string }) => (await import("/ui/store.js" as string)).api("/api/board/export", { id: a.id, nodes: [a.node], scale: 1, format: "png" }), { id: t.id, node: kinds });
    const shot = decodePng(readFileSync((files as { files: string[] }).files[0]));
    const exported = points.map(([x, y]) => colorName(pixelAt(shot, x, y), true));
    const preview = await page.context().browser()!.newPage();
    await preview.setViewportSize({ width: 1200, height: 600 });
    await preview.goto(`${BASE}board/preview?board=${encodeURIComponent(t.id)}&node=${encodeURIComponent(kinds)}`, { waitUntil: "networkidle" });
    await preview.waitForTimeout(400);
    const pb = (await preview.locator("#bd-frame > *").first().boundingBox())!;
    const pf = decodePng(await preview.screenshot());
    const previewed = points.map(([x, y]) => colorName(pixelAt(pf, pb.x + x, pb.y + y), true));
    // The vector's pictures load from the library, as image layers' do (a bare path would be a 404).
    const fromLibrary = () => [...document.querySelectorAll("svg image")].map((i) => i.getAttribute("href") ?? i.getAttribute("xlink:href") ?? "").filter((h) => !h.startsWith("/file?path=")).join();
    const previewHrefs = await S(preview, fromLibrary);
    await preview.close();
    if (canvas.join() !== want) return `the canvas shows ${canvas.join()} (${want})`;
    if (previewed.join() !== want) return `Preview shows ${previewed.join()} (${want})`;
    if (exported.join() !== want) return `the export shows ${exported.join()} (${want})`;
    const canvasHrefs = await S(page, fromLibrary);
    return !canvasHrefs && !previewHrefs ? "ok" : `pictures not loaded from the library: canvas ${canvasHrefs}; Preview ${previewHrefs}`;
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
  // Smoothness: what moves with the pointer redraws, and nothing else does.
  async "on a board, panning, pinching and the pointer move the camera and redraw what's over the design, not the layers or the panels"(page) {
    const t = await openTestBoard(page);
    await sel(page, [t.byName("Two")]);
    await page.waitForTimeout(300);
    const PANELS = ["BoardApp", "PagesList", "LayersList", "Inspector"];
    // The pointer over another layer: its outline on the canvas and its row in the list draw
    // again, nothing else.
    const one = await boxOf(page, t.byName("One"));
    const hovered = await drawsDuring(page, [...PANELS, "Row"], async () => {
      await page.mouse.move(one.x + one.width / 2, one.y + one.height / 2);
      await page.waitForTimeout(150);
    });
    const shown = await S(page, async () => {
      const hover = (await import("/ui/board-state.js" as string)).B.hover as string | null;
      return { hover, box: Boolean(document.querySelector(".bd-hover")), row: Boolean(hover && document.querySelector(`.bd-row.hover[data-lid="${hover}"]`)) };
    });
    if (hovered.BoardApp || hovered.PagesList || hovered.Inspector || !hovered.LayersList || hovered.Row !== 1) return `the pointer drew ${JSON.stringify(hovered)}`;
    if (!shown.hover || !shown.box || !shown.row) return `hovering a layer shows ${JSON.stringify(shown)}`;
    // Two-finger scrolls and pinches: the camera moves the design (its layers aren't drawn again),
    // what's over it (labels, selection) and the zoom in the bar follow; the panels stay.
    const moved = await drawsDuring(page, [...PANELS, "BoardCanvas", "BoardTopbar", "Overlay", "ZoomLabel"], () =>
      S(page, async () => {
        const c = document.querySelector(".bd-canvas")!;
        const r = c.getBoundingClientRect();
        for (let i = 0; i < 6; i++) {
          c.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, clientX: r.left + 300, clientY: r.top + 300, deltaX: 8, deltaY: 5 }));
          await new Promise((f) => requestAnimationFrame(f));
          c.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, clientX: r.left + 300, clientY: r.top + 300, ctrlKey: true, deltaY: -4 }));
          await new Promise((f) => requestAnimationFrame(f));
        }
      }),
    );
    if (PANELS.some((n) => moved[n]) || moved.BoardCanvas || moved.BoardTopbar || !moved.Overlay || !moved.ZoomLabel) return `panning and pinching drew ${JSON.stringify(moved)}`;
    // Where the camera put the artboard is where the view says it is, while it's still and once
    // it's drawn sharp again.
    for (const wait of [0, 400]) {
      await page.waitForTimeout(wait);
      const off = await S(page, async (id: string) => {
        const { B } = await import("/ui/board-state.js" as string);
        const n = B.board.nodes[id];
        const c = document.querySelector(".bd-canvas")!.getBoundingClientRect();
        const r = document.querySelector(`.bd-world [data-bid="${id}"]`)!.getBoundingClientRect();
        const { x, y, z } = B.view;
        return Math.max(Math.abs(r.left - (c.left + x + (parseFloat(n.style.left) || 0) * z)), Math.abs(r.top - (c.top + y + (parseFloat(n.style.top) || 0) * z)), Math.abs(r.width - parseFloat(n.style.width) * z));
      }, t.byName("Phone"));
      if (off > 1) return `the artboard is ${off.toFixed(2)} px from where the view puts it${wait ? " once still" : ""}`;
    }
    const zoom = await S(page, async () => ({ shown: document.querySelector(".bd-zoom")?.textContent?.trim(), z: (await import("/ui/board-state.js" as string)).B.view.z as number }));
    if (zoom.shown !== `${Math.round(zoom.z * 100)}%`) return `the bar shows ${zoom.shown} at a zoom of ${zoom.z}`;
    return "ok";
  },
  async "on a board, picking words in a text being typed in redraws the canvas and the panel, not the layer list"(page) {
    const t = await openTestBoard(page);
    const two = t.byName("Two");
    await S(page, async (id: string) => (await import("/ui/board.js" as string)).startTextEdit(id), two);
    await page.waitForTimeout(400);
    const draws = await drawsDuring(page, ["BoardApp", "PagesList", "LayersList", "BoardTopbar", "Inspector", "Overlay"], () =>
      S(page, async (id: string) => {
        const text = document.querySelector(`.bd-world [data-bid="${id}"]`)!.firstChild!;
        for (let i = 1; i <= 2; i++) {
          const r = document.createRange();
          r.setStart(text, 0);
          r.setEnd(text, i);
          getSelection()!.removeAllRanges();
          getSelection()!.addRange(r);
          await new Promise((f) => setTimeout(f, 120));
        }
      }, two),
    );
    // The selection's outline over the canvas follows the words (the text box grows as it's typed in).
    if (draws.BoardApp || draws.PagesList || draws.LayersList || draws.BoardTopbar || !draws.Inspector || !draws.Overlay) return `picking words drew ${JSON.stringify(draws)}`;
    // The panel's word buttons follow: picked words can be made bold.
    const bold = await S(page, () => [...document.querySelectorAll(".bd-right .bd-word")].some((b) => !(b as HTMLButtonElement).disabled));
    return bold ? "ok" : "with words picked, the panel's word buttons stay off";
  },
  async "on a board, a vector part's size typed after zooming is in the board's units"(page) {
    const b = boards.createBoard("Vector zoom test", "studio");
    const made = boardCore.addHtmlOps(`<div data-name="Card" style="width:360px;height:240px;background:#fff;position:relative"><svg data-name="Art" style="position:absolute;left:20px;top:20px;width:320px;height:200px" viewBox="0 0 160 100"><rect data-name="Box" x="10" y="10" width="40" height="30" fill="#0a84ff"/></svg></div>`, null, { page: b.pages[0].id });
    boards.changeBoard(b.id, made.ops, "studio");
    await S(page, async (id: string) => (await import("/ui/board-state.js" as string)).openBoard(id), b.id);
    await page.waitForSelector(".bd-world [data-bid]");
    await page.waitForTimeout(900);
    const box = Object.values(boards.getBoard(b.id).nodes).find((n) => n.name === "Box")!.id;
    await sel(page, [box]);
    await page.waitForTimeout(300);
    // Pinch: the panel isn't drawn again for it, so what it does must read the zoom as it is now.
    await S(page, async () => {
      const c = document.querySelector(".bd-canvas")!;
      const r = c.getBoundingClientRect();
      for (let i = 0; i < 5; i++) {
        c.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, clientX: r.left + 200, clientY: r.top + 200, ctrlKey: true, deltaY: -12 }));
        await new Promise((f) => requestAnimationFrame(f));
      }
    });
    await page.waitForTimeout(300);
    const w = page.locator(".bd-right .num").filter({ has: page.locator(".scrub", { hasText: /^W$/ }) }).locator("input");
    await w.fill("60");
    await w.press("Enter");
    await page.waitForTimeout(500);
    // The svg is drawn at 2×: 60 on the board is 30 of its own units.
    const width = Number(boards.getBoard(b.id).nodes[box].attrs!.width);
    return Math.abs(width - 30) < 0.6 ? "ok" : `typing W 60 after zooming made the rect ${width} wide in its own units, not 30`;
  },
  async "on a board, scrubbing a number saves a few times a second, and what's saved is where it was let go"(page) {
    await page.evaluate("globalThis.__name = (f) => f");
    const t = await openTestBoard(page);
    const phone = t.byName("Phone");
    await sel(page, [phone]);
    await page.waitForTimeout(400);
    const saves: string[] = [];
    const onReq = (r: import("playwright").Request) => r.url().includes("/api/board/ops") && saves.push(r.url());
    page.on("request", onReq);
    // Sixty steps of the pointer over about half a second, on the X field's letter.
    const shown = await S(page, async () => {
      const scrub = [...document.querySelectorAll(".bd-right .num")].find((n) => n.querySelector(".scrub")?.textContent === "X")!;
      const label = scrub.querySelector(".scrub")!;
      const r = label.getBoundingClientRect();
      const pe = (type: string, el: EventTarget, x: number) => el.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: r.top + 4, pointerType: "mouse", button: 0, buttons: type === "pointerup" ? 0 : 1 }));
      pe("pointerdown", label, r.left + 4);
      for (let i = 1; i <= 60; i++) {
        pe("pointermove", document.body, r.left + 4 + i * 2);
        await new Promise((f) => setTimeout(f, 8));
      }
      pe("pointerup", document.body, r.left + 4 + 120);
      await new Promise((f) => setTimeout(f, 50));
      return (scrub.querySelector("input") as HTMLInputElement).value;
    });
    await page.waitForTimeout(700);
    page.off("request", onReq);
    const saved = boards.getBoard(t.id).nodes[phone].style.left;
    if (saved !== `${shown}px`) return `the panel shows X ${shown}, the board has ${saved}`;
    return saves.length >= 1 && saves.length <= 12 ? "ok" : `scrubbing saved the board ${saves.length} times`;
  },
  async "the colour picker keeps transparency, ⌘B keeps line breaks, one Escape closes one popover, popovers follow scrolling, and a menu works by keyboard"(page) {
    // tsx keeps the names of the functions written below, through a helper of its own the page needs too.
    await page.evaluate("globalThis.__name = (f) => f");
    return S(page, async () => {
      const { h, render } = await import("preact" as string);
      const c = await import("/ui/controls.js" as string);
      const bad: string[] = [];
      const wait = (ms = 120) => new Promise((r) => setTimeout(r, ms));
      const host = () => {
        const el = document.createElement("div");
        el.style.cssText = "position:fixed;left:40px;top:60px;width:260px;z-index:5000";
        document.body.append(el);
        return el;
      };
      const down = (el: Element, fx: number, fy: number) => {
        const r = el.getBoundingClientRect();
        el.dispatchEvent(new PointerEvent("pointerdown", { clientX: r.left + r.width * fx, clientY: r.top + r.height * fy, button: 0, buttons: 1, pointerType: "mouse", bubbles: true, cancelable: true }));
      };
      // A see-through colour keeps its alpha as its colour is changed; Escape mid-drag puts it back.
      const h1 = host();
      let got = "";
      render(h(c.ColorPicker, { value: "rgba(255, 0, 0, 0.5)", onChange: (v: string) => (got = v) }), h1);
      await wait();
      down(h1.querySelector(".cp-sv")!, 0.5, 0.5);
      window.dispatchEvent(new PointerEvent("pointerup", { button: 0, pointerType: "mouse", bubbles: true }));
      if (!/^rgba\(\d+, \d+, \d+, 0\.5\)$/.test(got)) bad.push(`dragging a 50% red gave ${got}`);
      down(h1.querySelector(".cp-hue")!, 0.5, 0.5);
      document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
      if (got !== "rgba(255, 0, 0, 0.5)") bad.push(`Escape mid-drag left ${got}`);
      render(null, h1);
      // ⌘B over two lines makes both accent words, keeping the line; again makes them plain.
      const ed = document.createElement("div");
      ed.contentEditable = "true";
      ed.innerHTML = c.accentEditHtml("one\ntwo");
      document.body.append(ed);
      const all = document.createRange();
      all.selectNodeContents(ed);
      getSelection()!.removeAllRanges();
      getSelection()!.addRange(all);
      c.toggleAccentIn(ed, "");
      const on = c.accentFromEdit(ed);
      c.toggleAccentIn(ed, "");
      const off = c.accentFromEdit(ed);
      ed.remove();
      if (on !== "**one**\n**two**" || off !== "one\ntwo") bad.push(`⌘B over two lines: ${JSON.stringify(on)}, then ${JSON.stringify(off)}`);
      if (!/<span data-acc[^>]*>two<br>lines<\/span>/.test(c.accentEditHtml("**two\nlines**"))) bad.push("an accent over a line break isn't read as one");
      // Two popovers open: one Escape closes the newer only.
      const h2 = host();
      const [a1, a2] = [document.createElement("button"), document.createElement("button")];
      h2.append(a1, a2);
      const pops = document.createElement("div");
      h2.append(pops);
      const closed: string[] = [];
      const onFirst = () => closed.push("first");
      render(h("div", null, h(c.Popover, { anchor: a1, onClose: onFirst }, "One")), pops);
      await wait();
      render(h("div", null, h(c.Popover, { anchor: a1, onClose: onFirst }, "One"), h(c.Popover, { anchor: a2, onClose: () => closed.push("second") }, "Two")), pops);
      await wait();
      document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
      if (closed.join() !== "second") bad.push(`one Escape closed ${closed.join() || "nothing"}`);
      render(null, pops);
      h2.remove();
      // A popover follows its anchor as its panel scrolls, and closes once the anchor is out of sight.
      const box = document.createElement("div");
      box.style.cssText = "position:fixed;left:420px;top:100px;width:200px;height:200px;overflow:auto";
      box.innerHTML = '<div style="height:120px"></div><button>Anchor</button><div style="height:900px"></div>';
      document.body.append(box);
      const h3 = host();
      let gone = false;
      render(h(c.Popover, { anchor: box.querySelector("button"), onClose: () => (gone = true) }, "Follows"), h3);
      await wait();
      const pop = h3.querySelector(".pop") as HTMLElement;
      const t0 = parseFloat(pop.style.top);
      box.scrollTop = 50;
      await wait();
      const t1 = parseFloat(pop.style.top);
      if (Math.abs(t0 - 50 - t1) > 2) bad.push(`scrolled 50 px, the popover moved ${t0 - t1} px`);
      box.scrollTop = 500;
      await wait();
      if (!gone) bad.push("the popover stayed open with its anchor scrolled out of sight");
      render(null, h3);
      box.remove();
      // A menu without a search box: the arrow keys move through it (keeping the row in sight) and Enter picks.
      const h4 = host();
      let picked: unknown = null;
      render(h(c.Dropdown, { value: 0, options: Array.from({ length: 40 }, (_, i) => ({ value: i, label: `Option ${i}` })), onChange: (v: unknown) => (picked = v) }), h4);
      await wait();
      (h4.querySelector("button") as HTMLButtonElement).click();
      await wait(200);
      for (let i = 0; i < 25; i++) document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }));
      await wait(200);
      const list = h4.querySelector(".pop")!.getBoundingClientRect();
      const row = h4.querySelector(".menu-item.active")?.getBoundingClientRect();
      if (!row || row.top < list.top - 1 || row.bottom > list.bottom + 1) bad.push(`the highlighted row is ${row ? `at ${Math.round(row.top)}–${Math.round(row.bottom)}, the menu ${Math.round(list.top)}–${Math.round(list.bottom)}` : "missing"}`);
      document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
      await wait();
      if (picked !== 25) bad.push(`25 × ↓ and Enter picked ${picked}`);
      render(null, h4);
      h4.remove();
      return bad.length ? bad.join("; ") : "ok";
    });
  },
  async "on a board, a grid shows its tracks, gaps and headers, and the Grid section, in both themes"(page) {
    const t = await openGridBoard(page);
    const problems: string[] = [];
    for (const theme of ["dark", "light"]) {
      await S(page, async (th: string) => (await import("/ui/store.js" as string)).setTheme(th), theme);
      await sel(page, [t.byName("Cards")]);
      await page.waitForTimeout(400);
      const drawn = await S(page, () => ({ lines: document.querySelectorAll(".bd-grid-line").length, gaps: document.querySelectorAll(".bd-grid-gap").length, heads: document.querySelectorAll(".bd-grid-head.at-col").length, rows: document.querySelectorAll(".bd-grid-head.at-row").length, section: [...document.querySelectorAll(".bd-right .section-head h3")].map((h) => h.textContent).join(",") }));
      if (drawn.heads !== 3 || drawn.rows !== 2 || drawn.gaps !== 3 || drawn.lines < 10) problems.push(`${theme}: drawn ${JSON.stringify(drawn)}`);
      if (!/Grid/.test(drawn.section)) problems.push(`${theme}: the panel's sections are ${drawn.section}`);
      // A cell hovered: its column's and row's sizes show.
      const c = await boxOf(page, t.byName("Card Five"));
      await page.mouse.move(c.x + c.width / 2, c.y + c.height / 2);
      await page.waitForTimeout(200);
      const tags = await S(page, () => [...document.querySelectorAll(".bd-grid-head .tag")].map((x) => x.textContent).join("|"));
      if (!/^1fr · \d+\|Auto · 90$/.test(tags)) problems.push(`${theme}: hovering a cell shows "${tags}"`);
      await picture(page, `grid-${theme}-frame`);
      for (const issue of await themeAudit(page)) problems.push(`${theme} grid: ${issue}`);
      await page.click(".bd-more");
      await page.locator(".bd-tracks[data-axis=columns] .bd-track").first().click();
      await page.waitForTimeout(250);
      await picture(page, `grid-${theme}-track`);
      for (const issue of await themeAudit(page)) problems.push(`${theme} track editor: ${issue}`);
      await page.keyboard.press("Escape");
      await page.locator('.bd-right .section-head button[title^="Columns × rows"]').click();
      await page.waitForTimeout(250);
      await picture(page, `grid-${theme}-presets`);
      for (const issue of await themeAudit(page)) problems.push(`${theme} presets: ${issue}`);
      await page.keyboard.press("Escape");
      await sel(page, [t.byName("Card Two")]);
      await page.waitForTimeout(300);
      await picture(page, `grid-${theme}-child`);
      for (const issue of await themeAudit(page)) problems.push(`${theme} child: ${issue}`);
      const marked = await S(page, () => document.querySelectorAll(".bd-grid-cell").length);
      if (marked !== 1) problems.push(`${theme}: a layer in the grid marks ${marked} cells`);
      // Far out, the lines stay and the small things go; close in, everything stays one pixel thin.
      await sel(page, [t.byName("Cards")]);
      for (const [z, name] of [[0.12, "far"], [4, "close"]] as const) {
        await S(page, async (args: { z: number; id: string }) => {
          const c = await import("/ui/board-canvas.js" as string);
          c.zoomTo(args.z);
          await new Promise((r) => setTimeout(r, 50));
          const b = c.worldBox(args.id);
          const st = await import("/ui/board-state.js" as string);
          const r = document.querySelector(".bd-canvas")!.getBoundingClientRect();
          st.bset({ view: { z: args.z, x: r.width / 2 - (b.x + b.width / 2) * args.z, y: r.height / 2 - (b.y + b.height / 2) * args.z } });
        }, { z, id: t.byName("Cards") });
        await page.waitForTimeout(350);
        await picture(page, `grid-${theme}-${name}`);
        const seen = await S(page, () => ({ lines: document.querySelectorAll(".bd-grid-line").length, drags: document.querySelectorAll(".bd-grid-drag").length, heads: document.querySelectorAll(".bd-grid-head, .bd-grid-add").length, thick: [...document.querySelectorAll(".bd-grid-line.v")].some((l) => Math.abs(l.getBoundingClientRect().width - 1) > 0.6) }));
        if (!seen.lines || seen.thick || (name === "far" && (seen.drags || seen.heads)) || (name === "close" && !seen.drags)) problems.push(`${theme} ${name}: ${JSON.stringify(seen)}`);
      }
    }
    await S(page, async () => (await import("/ui/store.js" as string)).setTheme("system"));
    return problems.length ? problems.join("\n    ") : "ok";
  },
  async "on a board, a frame becomes a grid from the panel and with ⇧G, its layers staying put, and back by ⌥⇧G and undo"(page) {
    const t = await openTestBoard(page);
    const list = t.byName("List");
    const rows = ["Row One", "Row Two", "Row Three"].map(t.byName);
    const where = () => Promise.all(rows.map((r) => boxOf(page, r)));
    const same = (a: { x: number; y: number; width: number; height: number }[], b: typeof a) => a.every((r, i) => Math.abs(r.x - b[i].x) <= 1 && Math.abs(r.y - b[i].y) <= 1 && Math.abs(r.width - b[i].width) <= 1 && Math.abs(r.height - b[i].height) <= 1);
    const before = await where();
    await sel(page, [list]);
    await page.waitForTimeout(300);
    await page.locator(".bd-right .bd-kind button", { hasText: "Grid" }).click();
    await page.waitForTimeout(800);
    const ls = styleOf(t, list);
    if (ls.display !== "grid" || ls.gridTemplateColumns !== "1fr" || ls.gridTemplateRows !== "repeat(3, auto)" || ls.gap !== "10px") return `List became ${JSON.stringify(ls)}`;
    if (!same(await where(), before)) return "the rows moved when their flex column became a grid";
    const icon = await S(page, (id: string) => document.querySelector(`.bd-row[data-lid="${id}"] .ico svg`)?.innerHTML.includes("rect") ?? false, list);
    const titles = await S(page, () => [...document.querySelectorAll(".bd-right .section-head h3")].map((h) => h.textContent).join(","));
    if (!/Grid/.test(titles) || !icon) return `the panel shows ${titles}`;
    await page.keyboard.press("Meta+z");
    await page.waitForTimeout(800);
    if (styleOf(t, list).display !== "flex" || styleOf(t, list).gridTemplateRows) return `undo left ${JSON.stringify(styleOf(t, list))}`;
    // ⇧G round three rows: a grid that keeps them where they are.
    await sel(page, rows);
    await page.keyboard.press("Shift+G");
    await page.waitForTimeout(900);
    const wrap = nodeOf(t, rows[0]).parent!;
    const ws = styleOf(t, wrap);
    if (nodeOf(t, wrap).name !== "Grid" || ws.display !== "grid" || childNames(t, wrap) !== "Row One,Row Two,Row Three" || ws.gap !== "10px") return `⇧G made ${nodeOf(t, wrap).name}: ${JSON.stringify(ws)} holding ${childNames(t, wrap)}`;
    if (!same(await where(), before)) return "the rows moved when wrapped in a grid";
    // ⌥⇧G: by hand, where they are; ⇧G again: a grid from where they are.
    await sel(page, [wrap]);
    await page.keyboard.press("Alt+Shift+KeyG");
    await page.waitForTimeout(900);
    if (styleOf(t, wrap).display || styleOf(t, rows[1]).position !== "absolute") return `⌥⇧G left ${JSON.stringify(styleOf(t, wrap))}, a row ${JSON.stringify(styleOf(t, rows[1]))}`;
    if (!same(await where(), before)) return "the rows moved when the grid was taken off";
    await page.keyboard.press("Shift+G");
    await page.waitForTimeout(900);
    const again = styleOf(t, wrap);
    if (again.display !== "grid" || styleOf(t, rows[1]).position || again.gap !== "10px") return `⇧G on a free frame made ${JSON.stringify(again)}`;
    if (!same(await where(), before)) return "the rows moved when the free frame became a grid";
    await picture(page, "grid-wrapped");
    return "ok";
  },
  async "on a board, a grid's columns and rows are edited in the panel: count, a track's size, gaps, cells and presets"(page) {
    const t = await openGridBoard(page);
    const cards = t.byName("Cards");
    const cols = () => styleOf(t, cards).gridTemplateColumns;
    await sel(page, [cards]);
    await page.waitForTimeout(400);
    const count = page.locator(".bd-tracks[data-axis=columns] .num input");
    await count.fill("4");
    await count.press("Enter");
    await page.waitForTimeout(500);
    if (cols() !== "repeat(4, 1fr)") return `4 columns wrote ${cols()}`;
    await page.locator(".bd-tracks[data-axis=columns] .bd-track").nth(1).click();
    await page.locator(".bd-track-edit .dd-btn").click();
    await page.locator(".pop .menu-item", { hasText: "Fixed · px" }).click();
    await page.waitForTimeout(300);
    const pxField = page.locator(".bd-track-edit .num", { hasText: "px" }).locator("input");
    await pxField.fill("120");
    await pxField.press("Enter");
    await page.waitForTimeout(400);
    if (cols() !== "1fr 120px 1fr 1fr") return `a fixed second column wrote ${cols()}`;
    await page.locator('.bd-track-edit button[title="Move right"]').click();
    await page.waitForTimeout(400);
    if (cols() !== "1fr 1fr 120px 1fr") return `moving it right wrote ${cols()}`;
    await page.locator(".bd-tracks[data-axis=columns] .bd-track").nth(2).click();
    await page.locator('.bd-track-edit button[title="Delete this column"]').click();
    await page.waitForTimeout(400);
    if (cols() !== "repeat(3, 1fr)") return `deleting it wrote ${cols()}`;
    const gap = page.locator('.bd-flex-side .num[title="Gap between columns"] input');
    await gap.fill("24");
    await gap.press("Enter");
    await page.waitForTimeout(400);
    if (styleOf(t, cards).gap !== "16px 24px") return `a 24px column gap wrote gap ${styleOf(t, cards).gap}`;
    await page.locator(".bd-right .bd-cellpad button").nth(4).click();
    await page.waitForTimeout(300);
    if (styleOf(t, cards).justifyItems !== "center" || styleOf(t, cards).alignItems !== "center") return `centring in cells wrote ${styleOf(t, cards).justifyItems}/${styleOf(t, cards).alignItems}`;
    await page.locator(".bd-right .bd-check", { hasText: "Fill cells" }).locator("input").check();
    await page.waitForTimeout(300);
    if (styleOf(t, cards).justifyItems || styleOf(t, cards).alignItems) return "Fill cells left an alignment";
    // One click from the presets: a layout, then columns × rows from the picker.
    await page.locator('.bd-right .section-head button[title^="Columns × rows"]').click();
    await page.locator(".bd-preset", { hasText: "Sidebar and main" }).click();
    await page.waitForTimeout(400);
    if (cols() !== "240px 1fr") return `Sidebar and main wrote ${cols()}`;
    await page.locator('.bd-right .section-head button[title^="Columns × rows"]').click();
    await page.locator('.bd-grid-picker button[aria-label="4 × 2"]').click();
    await page.waitForTimeout(400);
    if (cols() !== "repeat(4, 1fr)" || styleOf(t, cards).gridTemplateRows !== "repeat(2, auto)") return `the picker's 4 × 2 wrote ${cols()} / ${styleOf(t, cards).gridTemplateRows}`;
    await page.locator('.bd-right .section-head button[title^="Columns × rows"]').click();
    await page.locator(".bd-preset", { hasText: "Cards that wrap" }).click();
    await page.waitForTimeout(400);
    if (cols() !== "repeat(auto-fill, minmax(200px, 1fr))") return `Cards that wrap wrote ${cols()}`;
    const pill = await S(page, () => document.querySelector(".bd-tracks[data-axis=columns] .bd-track")?.textContent?.trim());
    if (pill !== "Fill ≥ 200") return `the auto-fill column reads "${pill}"`;
    const past = (await bstate(page)).past.split("|").filter((l) => l !== "Test");
    if (past.length !== 11) return `${past.length} steps of undo: ${past.join(", ")}`;
    // Flow and areas, under More.
    await page.click(".bd-more");
    await page.locator(".bd-grid-flow .seg button", { hasText: "Columns" }).click();
    await page.locator(".bd-grid-flow .bd-check input").check();
    await page.waitForTimeout(300);
    if (styleOf(t, cards).gridAutoFlow !== "column dense") return `flow wrote ${styleOf(t, cards).gridAutoFlow}`;
    await commitOps(page, [{ op: "set", id: cards, style: { gridTemplateColumns: "repeat(3, 1fr)", gridTemplateRows: "repeat(2, auto)", gridAutoFlow: null } }]);
    await page.waitForTimeout(400);
    const cell = page.locator(".bd-area-cell").first();
    await cell.fill("hero");
    await cell.press("Tab");
    await page.locator(".bd-area-cell").nth(1).fill("hero");
    await page.locator(".bd-area-cell").nth(1).press("Enter");
    await page.waitForTimeout(400);
    if (styleOf(t, cards).gridTemplateAreas !== `"hero hero ." ". . ."`) return `the areas wrote ${styleOf(t, cards).gridTemplateAreas}`;
    await picture(page, "grid-panel-areas");
    return "ok";
  },
  async "on a board, a grid's tracks change on the canvas: + adds one, lines drag, and a track's menu sets its size"(page) {
    const t = await openGridBoard(page);
    const cards = t.byName("Cards");
    const cols = () => styleOf(t, cards).gridTemplateColumns;
    await sel(page, [cards]);
    await page.waitForTimeout(400);
    await page.click(".bd-grid-add.at-col");
    await page.waitForTimeout(500);
    if (cols() !== "repeat(4, 1fr)") return `+ wrote ${cols()}`;
    await page.click(".bd-grid-add.at-row");
    await page.waitForTimeout(500);
    if (styleOf(t, cards).gridTemplateRows !== "repeat(3, auto)") return `+ for rows wrote ${styleOf(t, cards).gridTemplateRows}`;
    await commitOps(page, [{ op: "set", id: cards, style: { gridTemplateColumns: "120px 1fr 1fr", gridTemplateRows: null } }]);
    await page.waitForTimeout(500);
    const z = await S(page, async () => (await import("/ui/board-state.js" as string)).B.view.z);
    const drag = async (i: number, dx: number) => {
      const b = (await page.locator(".bd-grid-drag.v").nth(i).boundingBox())!;
      await page.mouse.move(b.x + b.width / 2, b.y + 20);
      await page.mouse.down();
      for (let k = 1; k <= 8; k++) await page.mouse.move(b.x + b.width / 2 + (dx * k) / 8, b.y + 20);
      await page.mouse.up();
      await page.waitForTimeout(500);
    };
    await drag(0, 40 * z);
    if (cols() !== "160px 1fr 1fr") return `dragging the line after a 120px column 40px wrote ${cols()}`;
    await drag(1, 30 * z);
    const m = /^160px ([\d.]+)fr ([\d.]+)fr$/.exec(cols() ?? "");
    if (!m || Math.abs(Number(m[1]) + Number(m[2]) - 2) > 0.02 || Number(m[1]) <= 1) return `dragging the line between two 1fr columns wrote ${cols()}`;
    await page.locator(".bd-grid-head.at-col").nth(2).click();
    await page.locator(".ctx-item", { hasText: "Fixed" }).click();
    await page.waitForTimeout(400);
    if (!/^160px [\d.]+fr \d+px$/.test(cols() ?? "")) return `Fixed from the third column's menu wrote ${cols()}`;
    await page.locator(".bd-grid-head.at-col").nth(0).click();
    await page.locator(".ctx-item", { hasText: "Add a column right" }).click();
    await page.waitForTimeout(400);
    if (!/^160px 160px [\d.]+fr \d+px$/.test(cols() ?? "")) return `Add a column right wrote ${cols()}`;
    await page.locator(".bd-grid-head.at-col").nth(1).click();
    await page.locator(".ctx-item", { hasText: "Delete column" }).click();
    await page.waitForTimeout(400);
    if (!/^160px [\d.]+fr \d+px$/.test(cols() ?? "")) return `Delete column wrote ${cols()}`;
    await picture(page, "grid-canvas-tracks");
    await page.keyboard.press("Meta+z");
    await page.keyboard.press("Meta+z");
    await page.waitForTimeout(500);
    return /^160px [\d.]+fr \d+px$/.test(cols() ?? "") ? "ok" : `two undos left ${cols()}`;
  },
  async "on a board, a layer moves to another cell of its grid, its edge changes its span, and a layer from a flex frame lands in a cell"(page) {
    const t = await openGridBoard(page);
    const cards = t.byName("Cards");
    const one = t.byName("Card One");
    const geo = () => S(page, async (id: string) => {
      const g = (await import("/ui/board-grid.js" as string)).gridGeometry(id);
      const c = document.querySelector(".bd-canvas")!.getBoundingClientRect();
      return { cols: g.cols.map((x: { a: number; b: number }) => (x.a + x.b) / 2 + c.left), rows: g.rows.map((x: { a: number; b: number }) => (x.a + x.b) / 2 + c.top) };
    }, cards);
    const dragTo = async (from: { x: number; y: number }, to: { x: number; y: number }) => {
      await page.mouse.move(from.x, from.y);
      await page.mouse.down();
      for (let k = 1; k <= 12; k++) await page.mouse.move(from.x + ((to.x - from.x) * k) / 12, from.y + ((to.y - from.y) * k) / 12);
      await page.waitForTimeout(150);
      const target = await S(page, () => document.querySelectorAll(".bd-grid-target").length);
      await page.mouse.up();
      await page.waitForTimeout(700);
      return target;
    };
    await sel(page, [one]);
    await page.waitForTimeout(300);
    let g = await geo();
    const a = await boxOf(page, one);
    const shown = await dragTo({ x: a.x + 20, y: a.y + 20 }, { x: g.cols[1], y: g.rows[1] });
    if (childNames(t, cards) !== "Card Two,Card Three,Card Four,Card Five,Card One,Card Six" || styleOf(t, one).gridColumn || !shown) return `dragging One to Five's cell (target shown: ${shown}) made ${childNames(t, cards)} (${styleOf(t, one).gridColumn})`;
    await page.keyboard.press("Meta+z");
    await page.waitForTimeout(600);
    if (childNames(t, cards) !== "Card One,Card Two,Card Three,Card Four,Card Five,Card Six") return `undo made ${childNames(t, cards)}`;
    // Its right edge dragged across the next column: it spans two.
    await sel(page, [one]);
    await page.waitForTimeout(300);
    g = await geo();
    const e = (await page.locator(".bd-handle.h-e").boundingBox())!;
    await dragTo({ x: e.x + 4, y: e.y + 4 }, { x: g.cols[1] + 20, y: e.y + 4 });
    if (styleOf(t, one).gridColumn !== "span 2") return `dragging One's edge across a column wrote ${styleOf(t, one).gridColumn}`;
    await page.keyboard.press("Meta+z");
    await page.waitForTimeout(500);
    // Four columns leave two cells free: the chip from the tray goes to the first in order, then by hand to the last.
    await commitOps(page, [{ op: "set", id: cards, style: { gridTemplateColumns: "repeat(4, 1fr)" } }]);
    await page.waitForTimeout(500);
    g = await geo();
    const chip = t.byName("Chip");
    await sel(page, [chip]);
    await page.waitForTimeout(300);
    const cb = await boxOf(page, chip);
    await dragTo({ x: cb.x + 30, y: cb.y + 20 }, { x: g.cols[2], y: g.rows[1] });
    if (nodeOf(t, chip).parent !== cards || childNames(t, cards).split(",").pop() !== "Chip" || styleOf(t, chip).gridColumn) return `the chip dropped on the next free cell: in ${nodeOf(t, nodeOf(t, chip).parent!).name}, ${childNames(t, cards)}, ${styleOf(t, chip).gridColumn}`;
    await sel(page, [chip]);
    await page.waitForTimeout(300);
    const cb2 = await boxOf(page, chip);
    await dragTo({ x: cb2.x + 20, y: cb2.y + 20 }, { x: g.cols[3], y: g.rows[1] });
    if (styleOf(t, chip).gridColumn !== "4" || styleOf(t, chip).gridRow !== "2") return `the chip dragged to the last cell is at ${styleOf(t, chip).gridColumn} / ${styleOf(t, chip).gridRow}`;
    const pinned = await boxOf(page, chip);
    if (Math.abs(pinned.x + pinned.width / 2 - g.cols[3]) > 2) return "the chip isn't drawn in the last column";
    await picture(page, "grid-dropped");
    // A rectangle drawn in the free cell goes into it.
    await page.keyboard.press("r");
    await page.mouse.move(g.cols[2] - 10, g.rows[1] - 10);
    await page.mouse.down();
    await page.mouse.move(g.cols[2] + 5, g.rows[1] + 5, { steps: 4 });
    await page.mouse.move(g.cols[2] + 10, g.rows[1] + 10, { steps: 2 });
    await page.mouse.up();
    await page.waitForTimeout(700);
    const rect = Object.values(boards.getBoard(t.id).nodes).find((n) => /^Rectangle/.test(n.name));
    if (rect?.parent !== cards || rect.style.gridColumn !== "3" || rect.style.gridRow !== "2" || rect.style.position) return `a rectangle drawn in the free cell: ${rect ? `in ${nodeOf(t, rect.parent!).name}, ${JSON.stringify(rect.style)}` : "none"}`;
    return "ok";
  },
  async "on a board, In the grid sets a layer's column, span, whole row, area and whether it fills its cell"(page) {
    const t = await openGridBoard(page);
    const cards = t.byName("Cards");
    const two = t.byName("Card Two");
    await sel(page, [two]);
    await page.waitForTimeout(400);
    const field = (row: number, label: string) => page.locator(".bd-cell-line").nth(row).locator(".num", { hasText: label }).locator("input");
    await field(0, "At").fill("2");
    await field(0, "At").press("Enter");
    await field(0, "Span").fill("2");
    await field(0, "Span").press("Enter");
    await page.waitForTimeout(400);
    if (styleOf(t, two).gridColumn !== "2 / span 2") return `column 2, span 2 wrote ${styleOf(t, two).gridColumn}`;
    await page.locator('.bd-cell-line button[title="Across the whole row"]').click();
    await page.waitForTimeout(400);
    if (styleOf(t, two).gridColumn !== "1 / -1") return `across the whole row wrote ${styleOf(t, two).gridColumn}`;
    // A card 90px tall doesn't fill its cell; ticked, it does; unticked, it keeps the size it had.
    const fill = page.locator(".bd-right .bd-check", { hasText: "Fill the cell" }).locator("input");
    if (await fill.isChecked()) return "a card with a height of its own reads as filling its cell";
    await fill.check();
    await page.waitForTimeout(400);
    if (styleOf(t, two).height || styleOf(t, two).width || styleOf(t, two).justifySelf || !(await fill.isChecked())) return `filling the cell left ${JSON.stringify(styleOf(t, two))}`;
    await fill.uncheck();
    await page.waitForTimeout(400);
    if (!/^\d+px$/.test(styleOf(t, two).width ?? "") || !/^\d+px$/.test(styleOf(t, two).height ?? "") || styleOf(t, two).justifySelf !== "start") return `its own size wrote ${JSON.stringify(styleOf(t, two))}`;
    await commitOps(page, [{ op: "set", id: cards, style: { gridTemplateAreas: `"hero hero side" "a b side"` } }]);
    await page.waitForTimeout(500);
    await page.locator(".bd-cell-line", { hasText: "Area" }).locator(".dd-btn").click();
    await page.locator(".pop .menu-item", { hasText: "side" }).click();
    await page.waitForTimeout(400);
    if (styleOf(t, two).gridArea !== "side" || styleOf(t, two).gridColumn) return `the area wrote ${JSON.stringify(styleOf(t, two))}`;
    const labels = await S(page, () => [...document.querySelectorAll(".bd-grid-area")].map((x) => x.textContent).join(","));
    if (labels !== "hero,side,a,b") return `the canvas names areas "${labels}"`;
    await picture(page, "grid-child-area");
    await page.locator('.bd-right .section-head button[title^="Back to wherever"]').click();
    await page.waitForTimeout(400);
    return styleOf(t, two).gridArea ? "Reset left its area" : "ok";
  },
  async "a grid draws the same on the canvas as in pictures of the board and in Preview"(page) {
    const t = await openGridBoard(page);
    const cards = t.byName("Cards");
    const names = ["Card One", "Card Two", "Card Three", "Card Four", "Card Five", "Card Six"];
    await commitOps(page, [
      { op: "set", id: cards, style: { gridTemplateColumns: "120px repeat(2, minmax(80px, 1fr))", gridAutoRows: "minmax(70px, auto)", gap: "12px 20px", justifyItems: "center" } },
      { op: "set", id: t.byName("Card One"), style: { gridColumn: "2 / span 2", width: "160px" } },
      { op: "set", id: t.byName("Card Six"), style: { gridColumn: "1 / -1", justifySelf: "stretch" } },
    ]);
    await page.waitForTimeout(1200);
    const desk = t.byName("Desk");
    const ids = [cards, ...names.map(t.byName)];
    const canvas = await S(page, async (args: { desk: string; ids: string[] }) => {
      const m = await import("/ui/board-canvas.js" as string);
      const d = m.worldBox(args.desk);
      return Object.fromEntries(args.ids.map((id) => {
        const b = m.worldBox(id);
        return [id, [b.x - d.x, b.y - d.y, b.width, b.height]];
      }));
    }, { desk, ids });
    const { drawLayers } = await import("../src/board/render.js");
    const drawn = await drawLayers(boards.getBoard(t.id), [desk], { scale: 1 });
    const off = ids.filter((id) => {
      const d = drawn.boxes[id];
      const c = canvas[id];
      return !d || Math.abs(d.x - c[0]) > 1 || Math.abs(d.y - c[1]) > 1 || Math.abs(d.width - c[2]) > 1 || Math.abs(d.height - c[3]) > 1;
    });
    if (off.length) return `drawn differently: ${off.map((id) => `${nodeOf(t, id).name} canvas ${canvas[id].map(Math.round)} picture ${JSON.stringify(drawn.boxes[id])}`).join("; ")}`;
    const html = await (await fetch(`${BASE}board/preview?board=${t.id}&node=${desk}`)).text();
    return /grid-template-columns:120px repeat\(2, minmax\(80px, 1fr\)\)/.test(html) && /grid-column:1 \/ -1/.test(html) ? "ok" : "Preview's page doesn't carry the grid as written";
  },
  async "on a board, a grid keeps its layout through duplicate, copy and paste, and components, and ⇧G makes an empty frame 2 × 2"(page) {
    const t = await openGridBoard(page);
    const cards = t.byName("Cards");
    const two = t.byName("Card Two");
    await commitOps(page, [{ op: "set", id: two, style: { gridColumn: "2 / span 2", gridRow: "2" } }]);
    await page.waitForTimeout(500);
    // ⌘D on a layer pinned to a cell: the copy keeps its span and takes the next free cell.
    await sel(page, [two]);
    await page.keyboard.press("Meta+d");
    await page.waitForTimeout(700);
    const dup = Object.values(boards.getBoard(t.id).nodes).find((n) => n.name === "Card Two" && n.id !== two)!;
    if (dup?.parent !== cards || dup.style.gridColumn !== "span 2" || dup.style.gridRow) return `the duplicate is ${JSON.stringify(dup?.style)} in ${dup?.parent}`;
    const copyIn = async () => S(page, () => {
      const dt = new DataTransfer();
      window.dispatchEvent(new ClipboardEvent("copy", { clipboardData: dt, bubbles: true }));
      (window as unknown as { __dt: DataTransfer }).__dt = dt;
    });
    const pasteIn = () => S(page, () => window.dispatchEvent(new ClipboardEvent("paste", { clipboardData: (window as unknown as { __dt: DataTransfer }).__dt, bubbles: true })));
    // The pinned layer copied into the grid goes into the order, keeping its span.
    await sel(page, [two]);
    await copyIn();
    await sel(page, [cards]);
    await pasteIn();
    await page.waitForTimeout(800);
    const pastedCard = boards.getBoard(t.id).nodes[boards.getBoard(t.id).nodes[cards].children!.slice(-1)[0]];
    if (pastedCard.name !== "Card Two" || pastedCard.style.gridColumn !== "span 2" || pastedCard.style.gridRow) return `pasted into the grid: ${pastedCard.name} ${JSON.stringify(pastedCard.style)}`;
    // The whole grid copied onto the page: its tracks, gaps and its layers' cells come too.
    await sel(page, [cards]);
    await copyIn();
    await sel(page, []);
    await pasteIn();
    await page.waitForTimeout(900);
    const page0 = boards.getBoard(t.id).pages[0].children;
    const pasted = boards.getBoard(t.id).nodes[page0[page0.length - 1]];
    const pastedTwo = pasted.children!.map((c) => boards.getBoard(t.id).nodes[c]).find((n) => n.name === "Card Two")!;
    if (pasted.style.gridTemplateColumns !== "repeat(3, 1fr)" || pasted.style.gap !== "16px" || pastedTwo.style.gridColumn !== "2 / span 2") return `the pasted grid: ${JSON.stringify(pasted.style)}, its Card Two ${JSON.stringify(pastedTwo?.style)}`;
    // A grid component: its copy follows its columns; a card in the copy keeps its own span.
    await sel(page, [cards]);
    await page.keyboard.press("Meta+Alt+k");
    await page.waitForTimeout(300);
    await S(page, async (id: string) => (await import("/ui/board.js" as string)).placeCopy(id), cards);
    await page.waitForTimeout(800);
    const inst = Object.values(boards.getBoard(t.id).nodes).find((n) => n.instanceOf === cards)!;
    if (!inst || inst.style.gridTemplateColumns !== "repeat(3, 1fr)") return `the copy of the grid component: ${JSON.stringify(inst?.style)}`;
    await sel(page, [cards]);
    await page.waitForTimeout(300);
    const count = page.locator(".bd-tracks[data-axis=columns] .num input");
    await count.fill("2");
    await count.press("Enter");
    await page.waitForTimeout(800);
    if (boards.getBoard(t.id).nodes[inst.id].style.gridTemplateColumns !== "repeat(2, 1fr)") return `the copy didn't follow its component's columns: ${boards.getBoard(t.id).nodes[inst.id].style.gridTemplateColumns}`;
    const instOne = Object.values(boards.getBoard(t.id).nodes).find((n) => n.parent === inst.id && n.name === "Card One")!;
    await sel(page, [instOne.id]);
    await page.waitForTimeout(400);
    const span = page.locator(".bd-cell-line").first().locator(".num", { hasText: "Span" }).locator("input");
    await span.fill("2");
    await span.press("Enter");
    await page.waitForTimeout(800);
    const one = boards.getBoard(t.id).nodes[t.byName("Card One")];
    const mine = boards.getBoard(t.id).nodes[instOne.id];
    if (mine.style.gridColumn !== "span 2" || one.style.gridColumn || !mine.overrides?.includes("style.gridColumn")) return `a card in the copy spanning two: ${mine.style.gridColumn}, the component's ${one.style.gridColumn}, overrides ${mine.overrides}`;
    // ⇧G on an empty frame: 2 × 2.
    await commitOps(page, [{ op: "add", nodes: { emptyf1: { id: "emptyf1", type: "frame", name: "Empty", parent: null, style: { width: "200px", height: "200px", left: "0px", top: "700px", backgroundColor: "#fff" }, children: [] } }, ids: ["emptyf1"], parent: null, page: boards.getBoard(t.id).pages[0].id }]);
    await page.waitForTimeout(500);
    await sel(page, ["emptyf1"]);
    await page.keyboard.press("Shift+G");
    await page.waitForTimeout(700);
    const e = boards.getBoard(t.id).nodes.emptyf1.style;
    return e.display === "grid" && e.gridTemplateColumns === "repeat(2, 1fr)" && e.gridTemplateRows === "repeat(2, 1fr)" ? "ok" : `⇧G on an empty frame made ${JSON.stringify(e)}`;
  },

  // Shaders: live GPU layers, drawn by one runtime with one WebGL context for all of them.
  async "shaders: added from Assets they play on the canvas, all in one WebGL context, with no panel drawn per frame"(page) {
    // Every WebGL context the page makes, counted from before the Studio loads.
    await page.addInitScript("(() => { const get = HTMLCanvasElement.prototype.getContext; window.__gl = 0; HTMLCanvasElement.prototype.getContext = function (kind, ...rest) { const c = get.call(this, kind, ...rest); if (c && /webgl/.test(String(kind)) && !this.__gl) { this.__gl = 1; window.__gl++; } return c; }; })()");
    await page.reload({ waitUntil: "networkidle" });
    await page.waitForTimeout(400);
    const t = await openTestBoard(page);
    await shaderBudget(page, 1000);
    await sel(page, []);
    await page.locator(".bd-left-tabs button", { hasText: "Assets" }).click();
    await page.waitForSelector(".bd-asset.shader canvas");
    await page.waitForTimeout(700);
    // The tiles show their stills, and nothing draws while they sit there: the runtime's loop sleeps.
    const states = () => S(page, () => [...document.querySelectorAll(".bd-asset.shader canvas")].map((c) => (c as HTMLCanvasElement).dataset.shaderState ?? ""));
    const still = await states();
    const tiles = still.length;
    if (tiles < 8 || still.some((s) => s !== "paused")) return `the shader tiles in Assets aren't all stills: ${JSON.stringify(still)}`;
    const frameNo = () => page.evaluate("BoardShaders.stats().layers[0]?.frame ?? -1") as Promise<number>;
    const f0 = await frameNo();
    await page.waitForTimeout(500);
    const f1 = await frameNo();
    if (f1 !== f0) {
      // What drew, and what might have asked it to: the pointer on a tile, a tile not at its still, the panel changing size.
      const why = await page.evaluate(
        "JSON.stringify({ first: BoardShaders.stats().layers[0], layers: BoardShaders.stats().layers.length, under: [...document.querySelectorAll(':hover')].slice(-2).map((e) => e.tagName + '.' + String(e.className).slice(0, 40)), notStill: [...document.querySelectorAll('canvas[data-shader-state]')].filter((c) => c.dataset.shaderState !== 'paused').map((c) => c.dataset.shaderState + ' in ' + String(c.parentElement && c.parentElement.className).slice(0, 40)).slice(0, 4), assets: [document.querySelector('.bd-assets').clientWidth, document.querySelector('.bd-assets').scrollHeight] })",
      );
      return `with only stills, the shader runtime still ran ${f1 - f0} frames in half a second: ${why}`;
    }
    // The pointer on one plays it, only it; off it, it's a still again.
    await page.locator(".bd-asset.shader", { hasText: "Liquid chrome" }).hover();
    await page.waitForTimeout(400);
    const hovered = await states();
    if (hovered.filter((s) => s === "playing").length !== 1) return `hovering a shader tile: ${JSON.stringify(hovered)}`;
    await page.mouse.move(5, 300);
    await page.waitForTimeout(300);
    if ((await states()).some((s) => s !== "paused")) return `a shader tile kept playing once the pointer left: ${JSON.stringify(await states())}`;
    // One clicked (into the middle of the view, panned clear of the artboards), one dragged onto the canvas under it.
    await page.mouse.move(700, 400);
    for (let i = 0; i < 8; i++) await page.mouse.wheel(60, 0);
    await page.waitForTimeout(300);
    await page.locator(".bd-asset.shader", { hasText: "Mesh gradient" }).click();
    await page.waitForTimeout(700);
    const meshId = Object.values(boards.getBoard(t.id).nodes).find((n) => n.shader?.preset === "mesh-gradient")?.id;
    if (!meshId) return "clicking Mesh gradient in Assets added nothing";
    const mesh = await boxOf(page, meshId);
    const cv = (await page.locator(".bd-canvas").boundingBox())!;
    await page.locator(".bd-asset.shader", { hasText: "Aurora" }).dragTo(page.locator(".bd-canvas"), { targetPosition: { x: Math.round(mesh.x + mesh.width / 2 - cv.x), y: Math.round(mesh.y + mesh.height + 150 - cv.y) } });
    await page.waitForTimeout(900);
    const shaders = () => Object.values(boards.getBoard(t.id).nodes).filter((n) => n.shader);
    const made = shaders();
    if (made.length !== 2 || !made.some((n) => n.shader?.preset === "mesh-gradient") || !made.some((n) => n.shader?.preset === "aurora")) return `the board's shaders: ${JSON.stringify(made.map((n) => n.shader))}`;
    const before = await layerFrames(page, made.map((n) => n.id));
    await page.waitForTimeout(600);
    const after = await layerFrames(page, made.map((n) => n.id));
    if (!made.every((n) => after[n.id] > before[n.id] + 5)) return `the shaders aren't playing: frames ${JSON.stringify(before)} then ${JSON.stringify(after)}`;
    const gl = await S(page, () => ({ made: (window as unknown as { __gl: number }).__gl, runtime: (globalThis as unknown as { BoardShaders: { stats(): { contexts: number } } }).BoardShaders.stats().contexts }));
    if (gl.made !== 1 || gl.runtime !== 1) return `${gl.made} WebGL contexts made for 2 layers and ${tiles} tiles (the runtime says ${gl.runtime})`;
    // A second of play redraws no component: the runtime draws in the canvases itself.
    const draws = await drawsDuring(page, ["BoardCanvas", "Layer", "ShaderCanvas", "Inspector", "LayersList", "AssetsPanel", "ShaderAssets"], () => page.waitForTimeout(1000));
    if (Object.values(draws).some((n) => n > 2)) return `components drew while the shaders played: ${JSON.stringify(draws)}`;
    // Panned: drawn at half the resolution while it moves, sharp again once it stops.
    const id = made.find((n) => n.shader?.preset === "mesh-gradient")!.id;
    const full = await canvasSize(page, id);
    let least = full.width;
    for (let i = 0; i < 8; i++) {
      await page.mouse.move(700, 400);
      await page.mouse.wheel(14, 0);
      await page.waitForTimeout(30);
      least = Math.min(least, (await canvasSize(page, id)).width);
    }
    await page.waitForTimeout(500);
    const settled = await canvasSize(page, id);
    if (!(least <= full.width * 0.6) || settled.width !== full.width) return `while panning the canvas was ${least} px wide (${full.width} still), then ${settled.width}`;
    for (const theme of ["dark", "light"]) {
      await S(page, async (th: string) => (await import("/ui/store.js" as string)).setTheme(th), theme);
      await sel(page, [id]);
      await page.waitForTimeout(400);
      await picture(page, `shaders-${theme}-assets`);
      const problems = await themeAudit(page);
      if (problems.length) return `${theme}: ${problems.join(" | ")}`;
    }
    return "ok";
  },
  async "shaders: a parameter changes its pixels; pause, play and Reduce Motion"(page) {
    const t = await openMaskBoard(page, `<div data-name="Art" style="width:480px;height:360px;background:#fff;position:relative"><div data-name="Glow" data-shader="mesh-gradient" style="position:absolute;left:40px;top:30px;width:400px;height:300px"></div></div>`);
    await shaderBudget(page, 1000);
    const id = t.byName("Glow");
    await sel(page, [id]);
    await page.waitForTimeout(600);
    const f0 = await layerFrames(page, [id]);
    await page.waitForTimeout(400);
    if ((await layerFrames(page, [id]))[id] <= f0[id] + 5) return "it isn't playing";
    // Paused (in its shader settings): its still, drawn once.
    await page.click("[data-shader-settings]");
    await page.waitForSelector("[data-shader-settings-pop]");
    await page.click("[data-shader-play]");
    await page.waitForTimeout(400);
    if (!nodeOf(t, id).shader?.paused) return `pause didn't pause it: ${JSON.stringify(nodeOf(t, id).shader)}`;
    const p1 = await layerFrames(page, [id]);
    const still = await canvasPixels(page, id);
    await page.waitForTimeout(500);
    if ((await layerFrames(page, [id]))[id] !== p1[id] || (await canvasPixels(page, id)) !== still) return "paused, it still drew";
    const said = await S(page, () => document.querySelector("[data-shader-status]")?.textContent ?? "");
    if (!/Paused at its still/.test(said)) return `the panel says "${said}" when paused`;
    // A parameter changed in the panel: new pixels (and the value on the board).
    const warp = page.locator('.bd-right .row[data-param="warp"] .val');
    await warp.fill("2");
    await warp.press("Enter");
    await page.waitForTimeout(500);
    if (nodeOf(t, id).shader?.params?.warp !== 2) return `warp on the board: ${JSON.stringify(nodeOf(t, id).shader)}`;
    if ((await canvasPixels(page, id)) === still) return "a parameter changed, the pixels didn't";
    for (const theme of ["dark", "light"]) {
      await S(page, async (th: string) => (await import("/ui/store.js" as string)).setTheme(th), theme);
      await page.waitForTimeout(300);
      await picture(page, `shaders-${theme}-panel`);
      const problems = await themeAudit(page);
      if (problems.length) return `${theme}: ${problems.join(" | ")}`;
    }
    await page.click("[data-shader-play]");
    await page.waitForTimeout(300);
    const p2 = await layerFrames(page, [id]);
    await page.waitForTimeout(400);
    if ((await layerFrames(page, [id]))[id] <= p2[id] + 5) return "played again, it didn't move";
    // Reduce Motion: every shader a still.
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.waitForTimeout(400);
    const r1 = await layerFrames(page, [id]);
    await page.waitForTimeout(500);
    const r2 = await layerFrames(page, [id]);
    const reduced = await S(page, () => document.querySelector("[data-shader-status]")?.textContent ?? "");
    await page.emulateMedia({ reducedMotion: "no-preference" });
    if (r2[id] !== r1[id] || !/Reduce Motion is on/.test(reduced)) return `with Reduce Motion it drew ${r2[id] - r1[id]} frames, and the panel said "${reduced}"`;
    await page.waitForTimeout(400);
    const a1 = await layerFrames(page, [id]);
    await page.waitForTimeout(400);
    return (await layerFrames(page, [id]))[id] > a1[id] + 5 ? "ok" : "Reduce Motion off again, it didn't play";
  },
  async "shaders: masked, a shader shows only where its mask is"(page) {
    const red = "void main() { gl_FragColor = vec4(1.0, 0.0, 0.0, 1.0); }";
    const t = await openMaskBoard(page, `<div data-name="Art" style="width:300px;height:300px;background:#fff;position:relative"><div data-name="Circle" data-mask style="position:absolute;left:50px;top:50px;width:200px;height:200px;border-radius:50%;background:#000"></div><div data-name="Fill" data-shader="custom" data-code="${red}" style="position:absolute;left:0;top:0;width:300px;height:300px"></div></div>`);
    await shaderBudget(page, 1000);
    await sel(page, []);
    await page.waitForTimeout(700);
    const art = t.byName("Art");
    const seen = await colorsAt(page, art, 300, [[150, 150], [80, 150], [60, 60], [12, 12], [290, 290]]);
    if (seen.join() !== "red,red,white,white,white") return `inside and outside the circle: ${seen.join(", ")}`;
    if (!(await S(page, (fill: string) => Boolean(document.querySelector(`[data-mask-scope] [data-bid="${fill}"] canvas`)), t.byName("Fill")))) return "the shader isn't inside what masks it";
    await picture(page, "shaders-masked");
    return "ok";
  },
  async "shaders: any frame takes one as its fill (Fill › shader), drawn behind its layers, filling its grid cell"(page) {
    const t = await openMaskBoard(page, `<div data-name="Art" style="width:520px;height:300px;background:#fff;display:grid;grid-template-columns:1fr 1fr;gap:20px;padding:20px"><div data-name="Cell" style="background:#fff;padding:30px"><div data-name="Chip" style="width:60px;height:60px;background:#0000ff"></div></div><div data-name="Other" style="background:#808080"></div></div>`);
    await shaderBudget(page, 1000);
    const art = t.byName("Art");
    const cell = t.byName("Cell");
    await sel(page, [cell]);
    await page.waitForTimeout(300);
    // The chooser: every preset's still, playing only under the pointer, and a search.
    await page.click("[data-shader-add]");
    await page.waitForSelector("[data-shader-chooser] .bd-shpick-tile canvas");
    // The pointer off the tiles (where it opened the chooser may be over one).
    await page.mouse.move(4, 4);
    await page.waitForTimeout(250);
    await page.waitForTimeout(700);
    const tiles = () => S(page, () => [...document.querySelectorAll("[data-shader-chooser] .bd-shpick-tile canvas")].map((c) => (c as HTMLCanvasElement).dataset.shaderState ?? ""));
    const st0 = await tiles();
    if (st0.length < 10 || st0.some((s) => s !== "paused")) return `the chooser's tiles: ${JSON.stringify(st0)}`;
    await page.locator("[data-shader-chooser] .bd-shpick-tile", { hasText: "Waves" }).hover();
    await page.waitForTimeout(400);
    if ((await tiles()).filter((s) => s === "playing").length !== 1) return `hovering a tile in the chooser: ${JSON.stringify(await tiles())}`;
    const search = page.locator("[data-shader-chooser] input");
    await search.fill("aur");
    await page.waitForTimeout(150);
    const found = await S(page, () => [...document.querySelectorAll("[data-shader-chooser] .bd-shpick-tile .nm")].map((e) => e.textContent));
    if (found.join() !== "Aurora") return `searching "aur" shows ${JSON.stringify(found)}`;
    await search.fill("");
    // Picked: the frame has it, keeps its name and its layers, and the chooser stays open to try another.
    await page.locator("[data-shader-chooser] .bd-shpick-tile", { hasText: "Aurora" }).click();
    await page.waitForTimeout(600);
    const n1 = nodeOf(t, cell);
    if (n1.shader?.preset !== "aurora" || n1.name !== "Cell" || n1.children?.length !== 1 || n1.type !== "frame") return `picked: ${JSON.stringify(n1)}`;
    if (!(await page.isVisible("[data-shader-chooser] .bd-shpick-tile.on .tick"))) return "the chooser doesn't mark the shader the frame has";
    const first = await S(page, (id: string) => document.querySelector(`[data-bid="${id}"]`)?.firstElementChild?.getAttribute("data-layer"), cell);
    if (first !== cell) return "the shader's canvas isn't the frame's first child";
    for (const theme of ["dark", "light"]) {
      await S(page, async (th: string) => (await import("/ui/store.js" as string)).setTheme(th), theme);
      await page.waitForTimeout(300);
      await picture(page, `shaders-${theme}-chooser`);
      const problems = await themeAudit(page);
      if (problems.length) return `${theme}, choosing: ${problems.join(" | ")}`;
    }
    await page.keyboard.press("Escape");
    await page.waitForTimeout(200);
    if (await page.isVisible("[data-shader-chooser]")) return "Escape didn't close the chooser";
    // Its colours are in the panel, under its row: one changed there is what's drawn (Aurora's sky, at the top).
    const skyBefore = (await canvasPixels(page, cell)).split(",").map(Number);
    await page.locator('.bd-right [data-shader-fill] .row[data-param="sky"] .color-btn').click();
    const hex = page.locator('.pop input[placeholder="#ff5fa2"]').first();
    // Typed once the picker has opened and settled where it shows.
    await page.waitForTimeout(250);
    await hex.click();
    await hex.fill("#ff0000");
    await hex.press("Enter");
    await page.waitForTimeout(600);
    for (const theme of ["dark", "light"]) {
      await S(page, async (th: string) => (await import("/ui/store.js" as string)).setTheme(th), theme);
      await page.waitForTimeout(300);
      await picture(page, `shaders-${theme}-colour`);
      const problems = await themeAudit(page);
      if (problems.length) return `${theme}, a shader's colour: ${problems.join(" | ")}`;
    }
    await page.keyboard.press("Escape");
    const skyAfter = (await canvasPixels(page, cell)).split(",").map(Number);
    if (nodeOf(t, cell).shader?.params?.sky !== "#ff0000") return `the sky colour on the board: ${JSON.stringify(nodeOf(t, cell).shader)}`;
    if (!(skyBefore[0] < 80 && skyAfter[0] > 150 && skyAfter[0] > skyAfter[2] * 1.5)) return `the sky colour changed, the sky drawn went from ${skyBefore.slice(0, 3)} to ${skyAfter.slice(0, 3)}`;
    // The grid cell's size, filled: the canvas is the cell, the frame laid out as before.
    const cellBox = await boxOf(page, cell);
    const drawn = await S(page, (id: string) => { const c = document.querySelector(`canvas[data-layer="${id}"]`) as HTMLCanvasElement; const r = c.getBoundingClientRect(); return { w: r.width, h: r.height }; }, cell);
    if (Math.abs(drawn.w - cellBox.width) > 1.5 || Math.abs(drawn.h - cellBox.height) > 1.5) return `the canvas is ${drawn.w}×${drawn.h}, the cell ${cellBox.width}×${cellBox.height}`;
    // Code of its own, from the row: red, so its pixels read; the frame's layer stays over it.
    await page.click("[data-shader-choose]");
    await page.click('[data-shader-pick="custom"]');
    await page.waitForTimeout(300);
    await page.keyboard.press("Escape");
    await page.click("[data-shader-settings]");
    await page.waitForSelector("[data-shader-settings-pop] .bd-code textarea");
    const code = page.locator("[data-shader-settings-pop] .bd-code textarea");
    await code.fill("void main() { gl_FragColor = vec4(1.0, 0.0, 0.0, 1.0); }");
    await code.press("Meta+Enter");
    await page.waitForTimeout(500);
    for (const theme of ["dark", "light"]) {
      await S(page, async (th: string) => (await import("/ui/store.js" as string)).setTheme(th), theme);
      await page.waitForTimeout(300);
      await picture(page, `shaders-${theme}-fill-settings`);
      const problems = await themeAudit(page);
      if (problems.length) return `${theme}, its settings: ${problems.join(" | ")}`;
    }
    await page.keyboard.press("Escape");
    await sel(page, []);
    await page.waitForTimeout(500);
    const seen = await colorsAt(page, art, 520, [[80, 80], [200, 220], [380, 150], [8, 8]]);
    if (seen.join() !== "blue,red,rgb(128,128,128),white") return `the chip, the shader behind it, the other cell, outside: ${seen.join(", ")}`;
    // Taken away: the frame and its layer stay, the canvas goes.
    await sel(page, [cell]);
    await page.waitForTimeout(200);
    await page.click("[data-shader-remove]");
    await page.waitForTimeout(400);
    const n2 = nodeOf(t, cell);
    const left = await S(page, (id: string) => Boolean(document.querySelector(`canvas[data-layer="${id}"]`)), cell);
    if (n2.shader || n2.children?.length !== 1 || left) return `removed: ${JSON.stringify(n2)}, canvas left ${left}`;
    // A shader in Assets clicked with a frame selected is its fill, not a new layer.
    const other = t.byName("Other");
    const count = Object.keys(boards.getBoard(t.id).nodes).length;
    await sel(page, [other]);
    await page.locator(".bd-left-tabs button", { hasText: "Assets" }).click();
    await page.locator(".bd-asset.shader", { hasText: "Waves" }).click();
    await page.waitForTimeout(500);
    const n3 = nodeOf(t, other);
    return n3.shader?.preset === "waves" && Object.keys(boards.getBoard(t.id).nodes).length === count ? "ok" : `clicked in Assets with a frame selected: ${JSON.stringify(n3)}, ${Object.keys(boards.getBoard(t.id).nodes).length - count} layers more`;
  },
  async "layers: deep layers keep their names: deeper levels step in by less, then the list scrolls sideways to the one selected or opened; the panel drags wider"(page) {
    // Words sixteen levels down: fifteen frames, each inside the last, in an artboard.
    let inner = `<p data-name="Deepest words" style="margin:0">Deep</p>`;
    for (let i = 15; i >= 1; i--) inner = `<div data-name="Level ${i}" style="padding:2px">${inner}</div>`;
    const t = await openMaskBoard(page, `<div data-name="Art" style="width:420px;height:320px;background:#fff">${inner}</div>`);
    const deep = t.byName("Deepest words");
    const look = (name: string) => S(page, (name: string) => {
      const list = document.querySelector(".bd-rows") as HTMLElement;
      const L = list.getBoundingClientRect();
      const rows = [...list.querySelectorAll(".bd-row")] as HTMLElement[];
      const row = rows.find((r) => r.querySelector(".nm")?.textContent === name);
      const nm = row?.querySelector(".nm")?.getBoundingClientRect();
      return {
        step: parseFloat(getComputedStyle(list).getPropertyValue("--step")),
        least: Math.round(Math.min(...rows.map((r) => (r.querySelector(".nm") as HTMLElement).getBoundingClientRect().width))),
        shown: nm ? Math.round(Math.min(nm.right, L.right) - Math.max(nm.left, L.left)) : -1,
        sideways: list.scrollWidth - list.clientWidth,
        panel: (document.querySelector(".bd-left") as HTMLElement).offsetWidth,
      };
    }, name);
    await page.mouse.move(700, 400);
    try {
      await sel(page, [deep]);
      await page.waitForTimeout(300);
      const a = await look("Deepest words");
      if (!(a.step >= 12 && a.step < 20)) return `sixteen levels deep, each steps in by ${a.step}px (it should be less than 20, and no less than 12)`;
      if (a.least < 90) return `a name kept only ${a.least}px`;
      if (a.sideways <= 0 || a.shown < 80) return `selected sixteen levels down, ${a.shown}px of its name shows (the list can scroll ${a.sideways}px sideways)`;
      // Opening a group brings its layer into sight.
      await S(page, async (id: string) => {
        const st = await import("/ui/board-state.js" as string);
        const open = new Set(st.B.open as Set<string>);
        open.delete(id);
        st.bset({ open, sel: [] });
      }, t.byName("Level 15"));
      await page.waitForTimeout(200);
      await S(page, () => ((document.querySelector(".bd-rows") as HTMLElement).scrollLeft = 0));
      await page.locator(`.bd-row[data-lid="${t.byName("Level 15")}"] .tw`).click();
      await page.waitForTimeout(300);
      const b = await look("Deepest words");
      if (b.shown < 80) return `opened, the layer inside shows ${b.shown}px of its name`;
      // A locked layer keeps its lock showing (and only that) without the pointer on it.
      await S(page, async (id: string) => (await import("/ui/board-state.js" as string)).commit([{ op: "set", id, locked: true }], { label: "Lock" }), t.byName("Level 2"));
      await page.mouse.move(700, 400);
      await page.waitForTimeout(250);
      const kept = await S(page, (id: string) => [...document.querySelectorAll(`.bd-row[data-lid="${id}"] .acts .icon-btn`)].map((b) => getComputedStyle(b).opacity + "/" + getComputedStyle(b.parentElement!).opacity), t.byName("Level 2"));
      if (kept.join() !== "1/1,0/1") return `a locked layer's buttons, as opacity/row opacity: ${kept}`;
      // The panel drags wider, and then nothing needs to scroll sideways; a double-click puts it back.
      const edge = (await page.locator(".bd-resizer").boundingBox())!;
      await page.mouse.move(edge.x + edge.width / 2, edge.y + edge.height / 2);
      await page.mouse.down();
      for (let i = 1; i <= 10; i++) await page.mouse.move(edge.x + edge.width / 2 + 20 * i, edge.y + edge.height / 2);
      await page.mouse.up();
      await page.waitForTimeout(300);
      const c = await look("Deepest words");
      const kept2 = await S(page, () => localStorage.getItem("board:left-w"));
      if (!(c.panel >= 440 && c.panel <= 452) || kept2 !== String(c.panel)) return `dragged 200px, the panel is ${c.panel}px wide (kept as ${kept2})`;
      if (c.sideways > 1 || c.step <= a.step) return `at ${c.panel}px, levels step in by ${c.step}px and the list scrolls ${c.sideways}px sideways`;
      await page.locator(".bd-resizer").dblclick();
      await page.waitForTimeout(300);
      const d = await look("Deepest words");
      if (d.panel !== 240 || (await S(page, () => localStorage.getItem("board:left-w")))) return `double-clicked, the panel is ${d.panel}px wide`;
      return "ok";
    } finally {
      await S(page, async () => {
        (await import("/ui/board-state.js" as string)).bset({ leftW: null });
        localStorage.removeItem("board:left-w");
      });
    }
  },
  async "shaders: not all at once: zoomed out they hold their frame, the biggest in view plays, the selected one always does"(page) {
    const t = await openMaskBoard(page, `<div data-name="Page" style="width:600px;display:flex;flex-direction:column;background:#fff"><div data-name="One" data-shader="mesh-gradient" style="height:400px"></div><div data-name="Two" data-shader="aurora" style="height:400px"></div><div data-name="Three" data-shader="waves" style="height:400px"></div></div>`);
    await shaderBudget(page, 1000);
    const ids = ["One", "Two", "Three"].map((n) => t.byName(n));
    const states = () => S(page, (ids: string[]) => ids.map((id) => (document.querySelector(`canvas[data-layer="${id}"]`) as HTMLCanvasElement | null)?.dataset.shaderState ?? ""), ids);
    const moved = async (ms = 500) => {
      const a = await layerFrames(page, ids);
      await page.waitForTimeout(ms);
      const b = await layerFrames(page, ids);
      return ids.map((id) => b[id] - a[id]);
    };
    const zoom = (z: number) => S(page, async (z: number) => (await import("/ui/board-canvas.js" as string)).zoomTo(z), z);
    await sel(page, []);
    // Zoomed out, each is a thumbnail: none moves.
    await zoom(0.15);
    await page.waitForTimeout(700);
    const far = await moved();
    if (far.some((n) => n > 0) || (await states()).some((s) => s !== "held")) return `zoomed out: frames ${far}, states ${await states()}`;
    // The selected one plays, however small.
    await sel(page, [ids[1]]);
    await page.waitForTimeout(500);
    const picked = await moved();
    if (!(picked[1] > 5 && picked[0] === 0 && picked[2] === 0)) return `with Two selected, zoomed out: frames ${picked}`;
    // At full size, only what fits the budget plays: here the one filling the view, at 30 frames a second.
    await sel(page, []);
    await S(page, async (id: string) => (await import("/ui/board-canvas.js" as string)).fit([id], { instant: true }), ids[0]);
    await zoom(2.2);
    await page.waitForTimeout(800);
    const near = await moved(1000);
    const st = await states();
    if (!(near[0] >= 8 && near[0] <= 36)) return `the one in view drew ${near[0]} frames in a second (it should play, at no more than 30 a second); states ${st}`;
    if (near[2] > 0) return `one out of view drew: ${near}`;
    return "ok";
  },
  async "shaders: one too slow is stopped at its still and says so; code of its own shows its errors by line"(page) {
    const t = await openMaskBoard(page, `<div data-name="Art" style="width:420px;height:320px;background:#fff;position:relative"><div data-name="Mine" data-shader="custom" data-code="uniform vec3 uTint; // @color = #ff3b30
void main() { gl_FragColor = vec4(uTint * (0.6 + 0.4 * sin(uTime)), 1.0); }" style="position:absolute;left:10px;top:10px;width:400px;height:300px"></div></div>`);
    const id = t.byName("Mine");
    await sel(page, [id]);
    await shaderBudget(page, 0.0001);
    await page.waitForTimeout(1500);
    const st = await S(page, (x: string) => (document.querySelector(`canvas[data-layer="${x}"]`) as HTMLCanvasElement | null)?.dataset.shaderState, id);
    const said = await S(page, () => document.querySelector("[data-shader-status]")?.textContent ?? "");
    const told = await toasts(page);
    if (st !== "slow" || !/Too slow to play here/.test(said) || !/too slow to play/.test(told)) return `too slow: state ${st}, the panel says "${said}", toasts ${told}, stats ${JSON.stringify(await page.evaluate("BoardShaders.stats()"))}`;
    const s1 = await layerFrames(page, [id]);
    await page.waitForTimeout(400);
    if ((await layerFrames(page, [id]))[id] !== s1[id]) return "stopped as too slow, it still drew";
    await shaderBudget(page, 1000);
    await page.locator("[data-shader-status] .bd-link", { hasText: "Try again" }).click();
    await page.waitForTimeout(600);
    const s2 = await layerFrames(page, [id]);
    await page.waitForTimeout(400);
    if ((await layerFrames(page, [id]))[id] <= s2[id] + 5) return "Try again didn't play it";
    // Its code (in its shader settings), broken on line 2: listed by line as it's typed, and the canvas shows the error once applied.
    await page.click("[data-shader-settings]");
    await page.waitForSelector("[data-shader-settings-pop]");
    const code = page.locator(".bd-code textarea");
    await code.fill("uniform vec3 uTint; // @color = #ff3b30\nvoid main() { gl_FragColor = vec4(oops, 1.0); }");
    await page.waitForTimeout(600);
    const errs = await S(page, () => [...document.querySelectorAll(".bd-code-err")].map((e) => e.textContent).join(" | "));
    if (!/^Line 2.*oops/.test(errs)) return `the errors listed: "${errs}"`;
    await code.press("Meta+Enter");
    await page.waitForTimeout(600);
    const bad = await S(page, (x: string) => (document.querySelector(`canvas[data-layer="${x}"]`) as HTMLCanvasElement | null)?.dataset.shaderState, id);
    if (bad !== "error" || !/oops/.test(nodeOf(t, id).shader?.code ?? "")) return `applied, the layer is ${bad}`;
    for (const theme of ["dark", "light"]) {
      await S(page, async (th: string) => (await import("/ui/store.js" as string)).setTheme(th), theme);
      await page.waitForTimeout(300);
      await picture(page, `shaders-${theme}-code-error`);
      const problems = await themeAudit(page);
      if (problems.length) return `${theme}: ${problems.join(" | ")}`;
    }
    await code.fill("uniform vec3 uTint; // @color = #ff3b30\nvoid main() { gl_FragColor = vec4(uTint, 1.0); }");
    await code.press("Meta+Enter");
    await page.waitForTimeout(700);
    const ok = await S(page, (x: string) => (document.querySelector(`canvas[data-layer="${x}"]`) as HTMLCanvasElement | null)?.dataset.shaderState, id);
    const okText = await S(page, () => document.querySelector(".bd-code-ok")?.textContent ?? "");
    return ok === "playing" && /Compiles/.test(okText) ? "ok" : `fixed, the layer is ${ok} and the panel says "${okText}"`;
  },
  async "shaders: resized, rotated and scaled on the canvas like any layer, the drawing following"(page) {
    const t = await openMaskBoard(page, `<div data-name="Art" style="width:700px;height:460px;background:#fff;position:relative"><div data-name="Dots" data-shader="halftone" style="position:absolute;left:40px;top:40px;width:200px;height:150px"></div></div>`);
    await shaderBudget(page, 1000);
    const id = t.byName("Dots");
    await sel(page, [id]);
    await page.waitForTimeout(500);
    const w0 = (await canvasSize(page, id)).width;
    // Its east handle dragged 100 px: wider, and its drawing follows once let go.
    const z = await S(page, async () => (await import("/ui/board-state.js" as string)).B.view.z);
    const h = (await page.locator('.bd-handle[data-handle="e"]').boundingBox())!;
    await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2);
    await page.mouse.down();
    await page.mouse.move(h.x + h.width / 2 + 100 * z, h.y + h.height / 2, { steps: 8 });
    await page.mouse.up();
    await page.waitForTimeout(600);
    const w1 = (await canvasSize(page, id)).width;
    if (styleOf(t, id).width !== "300px" || Math.abs(w1 - w0 * 1.5) > 2) return `resized to ${styleOf(t, id).width}, its canvas ${w0} → ${w1} px`;
    // Rotated from the panel: drawn turned, and still playing.
    const rot = page.locator(".bd-right .num", { has: page.locator('[title="Rotation"]') }).locator("input");
    if (await rot.count()) {
      await rot.fill("20");
      await rot.press("Enter");
    } else await commitOps(page, [{ op: "set", id, style: { transform: "rotate(20deg)" } }]);
    await page.waitForTimeout(400);
    const turned = await S(page, (x: string) => getComputedStyle(document.querySelector(`.bd-world [data-bid="${x}"]`)!).transform, id);
    const f1 = await layerFrames(page, [id]);
    await page.waitForTimeout(400);
    if (styleOf(t, id).transform !== "rotate(20deg)" || turned === "none" || (await layerFrames(page, [id]))[id] <= f1[id] + 5) return `rotated: ${styleOf(t, id).transform}, drawn ${turned}`;
    // The Scale tool: the box and its dot spacing (a length in px) twice as big.
    await S(page, async (x: string) => {
      const c = await import("/ui/board-canvas.js" as string);
      const plan = c.scalePlan([x]);
      plan.to(2);
      plan.done();
    }, id);
    await page.waitForTimeout(600);
    const n = nodeOf(t, id);
    if (n.style.width !== "600px" || n.style.height !== "300px" || n.shader?.params?.spacing !== 22) return `scaled: ${JSON.stringify(n.style)} ${JSON.stringify(n.shader)}`;
    await picture(page, "shaders-transformed");
    return "ok";
  },
  async "shaders: Preview plays them, and Copy as HTML is a page that plays them by itself"(page) {
    const t = await openMaskBoard(page, `<div data-name="Art" style="width:420px;height:320px;background:#fff;position:relative"><div data-name="Rays" data-shader="light-rays" data-params='{"light":"var(--brand)"}' style="position:absolute;inset:0"></div></div>`);
    boards.changeBoard(t.id, [{ op: "token", name: "--brand", value: "#ff3b30" }], "studio");
    const art = t.byName("Art");
    const frames = (p: Page) => p.evaluate("BoardShaders.stats().layers.map((l) => l.frames)") as Promise<number[]>;
    // Preview: the runtime is its first script, and the shader plays (Reduce Motion aside).
    const view = await page.context().browser()!.newPage();
    await view.goto(`${BASE}board/preview?board=${t.id}&node=${art}&w=420`, { waitUntil: "load" });
    await view.waitForTimeout(600);
    const first = await view.evaluate(() => document.querySelector("script")?.hasAttribute("data-board-shaders"));
    const a = await frames(view);
    await view.waitForTimeout(500);
    const b = await frames(view);
    const state = await view.evaluate(() => (document.querySelector("[data-shader] canvas") as HTMLCanvasElement | null)?.dataset.shaderState);
    await view.close();
    if (!first || a.length !== 1 || b[0] <= a[0] + 5 || state !== "playing") return `Preview: runtime first ${first}, frames ${a} then ${b}, ${state}`;
    // Copy as HTML: the runtime, then the layers carrying their code, playing in a page of their own.
    const copied = await S(page, async (id: string) => {
      const m = await import("/ui/board-shaders.js" as string);
      const s = await import("/ui/board-state.js" as string);
      for (let i = 0; i < 50 && !m.pageHtml(s.B.board, [id]).startsWith("<script"); i++) await new Promise((r) => setTimeout(r, 100));
      return m.pageHtml(s.B.board, [id]) as string;
    }, art);
    if (!/^<script data-board-shaders>/.test(copied) || !/data-shader="light-rays"[^>]* data-code="/.test(copied)) return `Copy as HTML gave ${copied.slice(0, 160)}`;
    const own = await page.context().browser()!.newPage();
    await own.setContent(`<!doctype html><html><head><style>:root{--brand:#2f7dff}</style></head><body style="margin:0">${copied}</body></html>`);
    await own.waitForTimeout(600);
    const c = await frames(own);
    await own.waitForTimeout(500);
    const d = await frames(own);
    await own.close();
    return c.length === 1 && d[0] > c[0] + 5 ? "ok" : `the copied page drew ${c} then ${d} frames`;
  },
};

const engines = { chromium, webkit } as const;
const asked = process.argv.slice(2).filter((a) => a in engines) as Array<keyof typeof engines>;
let failed = 0;
try {
  for (const name of asked.length ? asked : (["chromium"] as const)) {
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
      // Dark, as the checks were written; the theme check goes through light and dark itself.
      const page = await browser.newPage({ viewport: { width: 1500, height: 950 }, colorScheme: "dark" });
      page.on("pageerror", (e) => problems.push(`page error: ${e.message}`));
      // The backdrop's still is drawn on demand and may be refused for an unknown look: not a fault.
      // A refusal a check fakes on purpose (x-test-refusal) isn't one either.
      page.on("response", (r) => r.status() >= 400 && !r.url().includes("/api/bg-preview") && !r.headers()["x-test-refusal"] && problems.push(`${r.status()} ${decodeURIComponent(r.url()).replace(tmp, "…").slice(-80)}`));
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
