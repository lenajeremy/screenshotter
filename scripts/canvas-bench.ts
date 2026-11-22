/**
 * How smooth the board canvas is: frames per second while panning, zooming, clicking, dragging,
 * resizing and hovering on heavy boards, in WebKit (the Mac app's engine) and Chromium.
 *
 * It starts its own engine on a throwaway library (never the person's), builds two boards there:
 *   screens:  a page of 16 artboards (6 desktop pages 1440 wide, 10 phone screens), ~3,500 layers:
 *             nested flex frames, lots of text, pictures, corners, shadows, gradients, SVG icons,
 *             a video layer and a shader fill
 *   website:  one artboard like an imported website page, 1440 wide, ~10,000 px tall, ~1,500 layers
 * and drives real input through Playwright at 1440×900, device scale 2: trackpad-like wheel pans,
 * ctrl+wheel zooms, keyboard zooms, zoom to fit / to selection, space-drag, clicks, drags, resizes
 * and hovers. Frames are timed in the page with requestAnimationFrame.
 *
 *   npm run bench:canvas                              both engines, prints a table, saves JSON
 *   npm run bench:canvas -- --label before            names the saved results (docs/perf/canvas-before.json)
 *   npm run bench:canvas -- --compare before          prints the change from a saved run
 *   npm run bench:canvas -- webkit --only "pan|zoom"  one engine, some interactions
 *   npm run bench:canvas -- chromium --trace          Chromium only: where main-thread time goes, per interaction
 *   npm run bench:canvas -- --headed                  windows you can watch
 *   npm run bench:canvas -- --ab <folder>             before and after: the app built in <folder> (a
 *                                                     checkout of the commit before) against this one,
 *                                                     a round of each in turn, so a busy Mac slows both alike
 */
import { spawn, type ChildProcess } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { chromium, webkit, type Browser, type BrowserContext, type Page } from "playwright";

const ROOT = path.resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const opt = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const ENGINES = { webkit, chromium } as const;
type EngineName = keyof typeof ENGINES;
const asked = args.filter((a) => a in ENGINES) as EngineName[];
const engines: EngineName[] = asked.length ? asked : ["webkit", "chromium"];
const only = opt("only") ? new RegExp(opt("only")!, "i") : null;
const label = opt("label") ?? (args.includes("--stress") ? "stress" : "latest");
const compareTo = opt("compare");
const TRACE = flag("trace");
const HEADED = flag("headed");
const ROUNDS = Number(opt("rounds") ?? 1);
/** --stress: three times the artboards (about 10,000 layers) and a website page three times as long. */
const STRESS = flag("stress");
const SETS = STRESS ? 3 : 1;

// ---------------------------------------------------------------------------------------------
// Each app under test ("side") has a library of its own, never the person's: set before the
// engine's modules read where things are.

const AB = opt("ab");
const SIDES = AB ? [{ name: "before", root: path.resolve(AB) }, { name: "after", root: ROOT }] : [{ name: "after", root: ROOT }];
const tmpRoot = mkdtempSync(path.join(os.tmpdir(), "glassine-bench-"));
function envFor(name: string) {
  const tmp = path.join(tmpRoot, name);
  const LIB = path.join(tmp, "library");
  mkdirSync(path.join(LIB, "images"), { recursive: true });
  writeFileSync(path.join(tmp, "studio.json"), JSON.stringify({ folder: LIB }));
  return {
    LIB,
    env: {
      SCREENSHOTTER_OUTPUT_DIR: LIB,
      SCREENSHOTTER_STUDIO_FILE: path.join(tmp, "studio.json"),
      SCREENSHOTTER_SEEN_FILE: path.join(tmp, "seen.json"),
      SCREENSHOTTER_STYLE_FILE: path.join(tmp, "style.json"),
      SCREENSHOTTER_CACHE_DIR: path.join(tmp, "cache"),
      SCREENSHOTTER_AGENTMAN_SOCKET: path.join(tmp, "none.sock"),
      SCREENSHOTTER_NO_KEYCHAIN: "1",
      // The engine draws board thumbnails with a browser: Playwright's own, not the person's Chrome.
      SCREENSHOTTER_CHROME_PATH: chromium.executablePath(),
    } as Record<string, string>,
  };
}
const sideEnv = Object.fromEntries(SIDES.map((x) => [x.name, envFor(x.name)]));
Object.assign(process.env, sideEnv[SIDES[0].name].env);

const boards = await import("../src/board/store.js");
const core = await import("../src/board/core.js");
const { encodePng } = await import("../src/util/png.js");
const { A, desktop, phone, photo, website } = await import("./bench-designs.js");

// ---------------------------------------------------------------------------------------------
// Pictures: photo-like (smooth colour with grain, so they cost what photos cost to draw) and avatars.

const PICS = path.join(tmpRoot, "pictures");
mkdirSync(PICS, { recursive: true });
for (let i = 0; i < 6; i++) {
  photo(path.join(PICS, `photo-${i}.png`), 1200, 800, i + 1);
  photo(path.join(PICS, `avatar-${i}.png`), 160, 160, i + 11);
}

function makeBoard(name: string, artboards: string[]) {
  const b = boards.createBoard(name, "studio");
  for (const h of artboards) {
    const made = core.addHtmlOps(h, null, { page: b.pages[0].id });
    boards.changeBoard(b.id, made.ops, "studio");
  }
  const board = boards.getBoard(b.id);
  return { id: b.id, layers: Object.keys(board.nodes).length, byName: (n: string) => Object.values(board.nodes).find((x) => x.name === n)!.id };
}

async function freePort() {
  return new Promise<number>((done) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const p = (srv.address() as net.AddressInfo).port;
      srv.close(() => done(p));
    });
  });
}

type Made = ReturnType<typeof makeBoard>;
type Side = { name: string; root: string; base: string; engine: ChildProcess; screens: Made; site: Made };

/** A side: its library with the two boards, and its engine (the app built in `root`) serving it. */
async function makeSide(name: string, root: string): Promise<Side> {
  const { LIB, env } = sideEnv[name];
  Object.assign(process.env, env);
  A.photos = [0, 1, 2, 3, 4, 5].map((i) => path.join(LIB, "images", `photo-${i}.png`));
  A.avatars = [0, 1, 2, 3, 4, 5].map((i) => path.join(LIB, "images", `avatar-${i}.png`));
  for (let i = 0; i < 6; i++) {
    copyFileSync(path.join(PICS, `photo-${i}.png`), A.photos[i]);
    copyFileSync(path.join(PICS, `avatar-${i}.png`), A.avatars[i]);
  }
  A.clip = path.join(LIB, "clip.mp4");
  copyFileSync(path.join(ROOT, "scripts", "fixtures", "clip.mp4"), A.clip);
  A.stress = STRESS;
  // Each set: a row of 6 desktop pages with a row of 10 phones under it (--stress stacks 3 sets).
  const screens = makeBoard("Bench: screens", Array.from({ length: SETS }, (_, r) => [
    ...[0, 1, 2, 3, 4, 5].map((k) => desktop(r * 6 + k, { x: k * 1640, y: r * 7200 })),
    ...[0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((k) => phone(r * 10 + k, { x: k * 490, y: r * 7200 + 5600 })),
  ]).flat());
  const site = makeBoard("Bench: website", [website({ x: 0, y: 0 })]);
  if (!existsSync(path.join(root, "dist", "index.js"))) throw new Error(`Build first: npm run build (in ${root})`);
  const port = await freePort();
  const engine = spawn(process.execPath, [path.join(root, "dist", "index.js"), "studio", "--port", String(port), "--no-open"], { env: { ...process.env, ...env }, stdio: ["ignore", "ignore", "pipe"] });
  let err = "";
  engine.stderr?.on("data", (d) => (err += d));
  const base = `http://127.0.0.1:${port}/`;
  for (let i = 0; ; i++) {
    try {
      if ((await fetch(base + "api/options")).ok) break;
    } catch {}
    if (i > 100) throw new Error(`The ${name} engine didn't start: ${err}`);
    await new Promise((r) => setTimeout(r, 100));
  }
  return { name, root, base, engine, screens, site };
}
const sides: Side[] = [];
for (const x of SIDES) sides.push(await makeSide(x.name, x.root));
const { screens, site } = sides[0];

// ---------------------------------------------------------------------------------------------
// Measuring frames in the page

const RECORDER = `(() => {
  // tsx names inner functions with a helper the page doesn't have.
  globalThis.__name = globalThis.__name || ((f) => f);
  const b = (window.__bench = { on: false, gen: 0, frames: [], long: [], work: [] });
  // How long each frame's work takes, whatever the display's rate: from the frame's start (this
  // callback, the first of the frame's) to the first task after it, which runs once the frame's
  // scripts, style, layout and painting are done.
  const ch = new MessageChannel();
  const starts = [];
  ch.port1.onmessage = () => { const t0 = starts.shift(); if (b.on && t0 !== undefined) b.work.push(performance.now() - t0); };
  b.start = () => {
    b.frames = []; b.long = []; b.work = []; starts.length = 0; b.on = true;
    // Each run has its own loop: one left over from the last run stops instead of counting twice.
    const gen = ++b.gen;
    const f = (t) => {
      if (!b.on || gen !== b.gen) return;
      b.frames.push(t);
      starts.push(performance.now());
      ch.port2.postMessage(0);
      requestAnimationFrame(f);
    };
    requestAnimationFrame(f);
  };
  b.stop = () => { b.on = false; b.gen++; return { frames: b.frames, long: b.long, work: b.work }; };
  try {
    new PerformanceObserver((l) => { if (b.on) for (const e of l.getEntries()) b.long.push(Math.round(e.duration)); }).observe({ type: "longtask" });
  } catch {}
})();`;

interface Result {
  frames: number;
  ms: number;
  fps: number;
  p50: number;
  p95: number;
  max: number;
  dropped: number;
  slow: number;
  long: number;
  longMs: number;
  /** Each frame's work (ms), whatever the display's rate: a frame fits 60 fps under ~14 ms. */
  workP50: number;
  workP95: number;
  workMax: number;
  /** Frames whose work didn't fit a 60 Hz frame. */
  over: number;
  trace?: Record<string, number>;
}

const FRAME = 1000 / 60;
function summarize(ts: number[], long: number[], work: number[] = []): Result {
  const w = [...work].sort((a, b) => a - b);
  const wq = (p: number) => (w.length ? Math.round(w[Math.min(w.length - 1, Math.floor(p * w.length))] * 10) / 10 : 0);
  const d = ts.slice(1).map((t, i) => t - ts[i]);
  const s = [...d].sort((a, b) => a - b);
  const q = (p: number) => (s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : 0);
  const ms = ts.length > 1 ? ts[ts.length - 1] - ts[0] : 0;
  const r1 = (v: number) => Math.round(v * 10) / 10;
  return {
    frames: d.length,
    ms: Math.round(ms),
    fps: r1(ms ? (d.length * 1000) / ms : 0),
    p50: r1(q(0.5)),
    p95: r1(q(0.95)),
    max: r1(s[s.length - 1] ?? 0),
    // Frames a 60 Hz display had to skip, and frames that took longer than a frame and a bit.
    dropped: d.reduce((n, x) => n + Math.max(0, Math.round(x / FRAME) - 1), 0),
    slow: d.filter((x) => x > FRAME * 1.25).length,
    long: long.length,
    longMs: long.reduce((a, b) => a + b, 0),
    workP50: wq(0.5),
    workP95: wq(0.95),
    workMax: wq(1),
    over: w.filter((x) => x > 14).length,
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Run `fn` `n` times, one every `ms` (a trackpad sends about one event per frame). */
async function paced(n: number, fn: (i: number) => Promise<unknown>, ms = FRAME) {
  const t0 = performance.now();
  for (let i = 0; i < n; i++) {
    await fn(i);
    const wait = t0 + (i + 1) * ms - performance.now();
    if (wait > 0) await sleep(wait);
  }
}

const E = <T, A>(page: Page, fn: (arg: A) => T | Promise<T>, arg?: A) => page.evaluate(fn as never, arg) as Promise<T>;
type Box = { x: number; y: number; width: number; height: number };
const boxOf = (page: Page, id: string) => E<Box | null, string>(page, (id) => {
  const r = document.querySelector(`.bd-world [data-bid="${id}"]`)?.getBoundingClientRect();
  return r ? { x: r.x, y: r.y, width: r.width, height: r.height } : null;
}, id);
const canvasBox = (page: Page) => E<Box, void>(page, () => {
  const r = document.querySelector(".bd-canvas")!.getBoundingClientRect();
  return { x: r.x, y: r.y, width: r.width, height: r.height };
});

/** Put the board in a known state: a view, a selection, nothing hovered, the move tool. */
async function setup(page: Page, s: { view?: { x: number; y: number; z: number } | "fit"; sel?: string[] }) {
  await page.mouse.move(2, 2);
  await E(page, async (s: { view?: unknown; sel?: string[] }) => {
    const st = await import("/ui/board-state.js" as string);
    const cv = await import("/ui/board-canvas.js" as string);
    st.bset({ sel: s.sel ?? [], hover: null, tool: "move", drop: null, guides: [] });
    if (s.view === "fit") cv.fit(undefined, { instant: true });
    else if (s.view) st.bset({ view: s.view });
  }, s);
  // Pictures decoded and the canvas drawn sharp again before timing starts.
  await sleep(700);
}

async function undo(page: Page) {
  await E(page, async () => (await import("/ui/board-state.js" as string)).undo());
  await sleep(500);
}

type Ctx = { page: Page; browser: Browser; engine: EngineName; side: Side };
type Scenario = { name: string; board: "screens" | "website"; prep: (c: Ctx) => Promise<unknown>; run: (c: Ctx) => Promise<unknown>; after?: (c: Ctx) => Promise<unknown> };

const center = async (page: Page) => {
  const c = await canvasBox(page);
  return { x: c.x + c.width / 2, y: c.y + c.height / 2 };
};
const WORK = { x: 60, y: 90, z: 0.5 };
const SITE_VIEW = { x: 40, y: 60, z: 0.75 };

async function wheelPan(page: Page, n = 120, r = 14) {
  const c = await center(page);
  await page.mouse.move(c.x, c.y);
  await paced(n, (i) => page.mouse.wheel(Math.round(r * Math.cos(i / 12)), Math.round(r * Math.sin(i / 12))));
}
async function wheelScroll(page: Page, n = 120) {
  const c = await center(page);
  await page.mouse.move(c.x, c.y);
  await paced(n, (i) => page.mouse.wheel(0, i < n / 2 ? 24 : -24));
}
async function pinch(page: Page, n = 60, d = 3) {
  const c = await center(page);
  await page.mouse.move(c.x, c.y);
  await page.keyboard.down("Control");
  await paced(n, () => page.mouse.wheel(0, -d));
  await paced(n, () => page.mouse.wheel(0, d));
  await page.keyboard.up("Control");
}
async function keyZoom(page: Page) {
  for (const k of ["Meta+Equal", "Meta+Equal", "Meta+Equal", "Meta+Minus", "Meta+Minus", "Meta+Minus"]) {
    await page.keyboard.press(k);
    await sleep(320);
  }
}
async function dragPath(page: Page, from: { x: number; y: number }, step: { x: number; y: number }, n = 60, { space = false } = {}) {
  await page.mouse.move(from.x, from.y);
  if (space) await page.keyboard.down("Space");
  await page.mouse.down();
  await paced(n, (i) => page.mouse.move(from.x + step.x * (i + 1), from.y + step.y * (i + 1)));
  await page.mouse.up();
  if (space) await page.keyboard.up("Space");
  await sleep(250);
}
/** Layers drawn inside the canvas, big enough to click, spread over it. */
async function clickTargets(page: Page, n: number) {
  return E<Array<{ x: number; y: number }>, number>(page, (n) => {
    const c = document.querySelector(".bd-canvas")!.getBoundingClientRect();
    const all = [...document.querySelectorAll(".bd-world [data-bid]")]
      .map((el) => el.getBoundingClientRect())
      .filter((r) => r.width > 24 && r.height > 14 && r.width < c.width * 0.6 && r.left > c.left + 20 && r.top > c.top + 40 && r.right < c.right - 20 && r.bottom < c.bottom - 20);
    const step = Math.max(1, Math.floor(all.length / n));
    return all.filter((_, i) => i % step === 0).slice(0, n).map((r) => ({ x: r.left + r.width / 2, y: r.top + r.height / 2 }));
  }, n);
}

/**
 * What the browser itself can do with the board: the world's transform moved straight from
 * requestAnimationFrame, none of the Studio's code running. `willChange` keeps the drawn board
 * on the GPU while it moves (sharp again only after); without it, every zoom step redraws it.
 */
async function ceiling(page: Page, kind: "pan" | "zoom", mode: "redrawn" | "will-change" | "camera", frames = 150) {
  await E(page, async ({ kind, mode, frames }: { kind: string; mode: string; frames: number }) => {
    const w = document.querySelector(".bd-world") as HTMLElement;
    const t0 = w.style.transform;
    const { x, y, z } = (await import("/ui/board-state.js" as string)).B.view as { x: number; y: number; z: number };
    const c = document.querySelector(".bd-canvas")!.getBoundingClientRect();
    // The Studio's own camera, if it has one, stands still (or is the one used, for "camera").
    const own = document.querySelector(".bd-camera") as HTMLElement | null;
    const c0 = own?.style.transform ?? "";
    if (own) own.style.transform = "none";
    // "camera": the world drawn at a zoom of its own, inside a GPU layer that moves and scales it
    // to the view; drawn again at the view's zoom only when that's 1.6× off.
    let cam: HTMLElement | null = null;
    let made = false;
    let at = { x, y, z };
    if (mode === "camera") {
      cam = own;
      if (!cam) {
        cam = document.createElement("div");
        cam.style.cssText = "position:absolute;left:0;top:0;transform-origin:0 0;will-change:transform";
        w.parentElement!.insertBefore(cam, w);
        cam.appendChild(w);
        made = true;
      }
      w.style.transform = `translate(${x}px, ${y}px) scale(${z})`;
    }
    if (mode === "will-change") w.style.willChange = "transform";
    const put = (vx: number, vy: number, vz: number) => {
      if (!cam) return void (w.style.transform = `translate(${vx}px, ${vy}px) scale(${vz})`);
      let s = vz / at.z;
      if (s > 1.6 || s < 0.6) {
        at = { x: vx, y: vy, z: vz };
        w.style.transform = `translate(${vx}px, ${vy}px) scale(${vz})`;
        s = 1;
      }
      cam.style.transform = `translate(${vx - s * at.x}px, ${vy - s * at.y}px) scale(${s})`;
    };
    await new Promise<void>((done) => {
      let i = 0;
      const f = () => {
        i++;
        if (kind === "pan") put(x + 160 * Math.sin(i / 15), y + 100 * (1 - Math.cos(i / 15)), z);
        else {
          const k = Math.exp(1.2 * Math.sin((i / frames) * Math.PI * 2));
          const cx = c.width / 2, cy = c.height / 2;
          put(cx - (cx - x) * k, cy - (cy - y) * k, z * k);
        }
        if (i < frames) requestAnimationFrame(f);
        else done();
      };
      requestAnimationFrame(f);
    });
    if (cam && made) {
      cam.parentElement!.insertBefore(w, cam);
      cam.remove();
    }
    if (own) own.style.transform = c0;
    w.style.transform = t0;
    w.style.willChange = "";
  }, { kind, mode, frames });
}

/**
 * --lab: what makes WebKit slow to move the camera. The camera pans (whole pixels, or not) with
 * one kind of thing hidden at a time.
 */
async function lab(page: Page, { css = "", whole = true }: { css?: string; whole?: boolean }, frames = 150) {
  await E(page, async ({ css, whole, frames }: { css: string; whole: boolean; frames: number }) => {
    const cam = document.querySelector(".bd-camera") as HTMLElement;
    const t0 = cam.style.transform;
    const m = /translate\(([-\d.e]+)px, ([-\d.e]+)px\)/.exec(t0)!;
    const [x, y] = [Number(m[1]), Number(m[2])];
    const st = document.createElement("style");
    st.textContent = css;
    document.head.appendChild(st);
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    await new Promise((r) => setTimeout(r, 300));
    await new Promise<void>((done) => {
      let i = 0;
      const f = () => {
        i++;
        let dx = 160 * Math.sin(i / 15), dy = 100 * (1 - Math.cos(i / 15));
        if (whole) (dx = Math.round(dx)), (dy = Math.round(dy));
        cam.style.transform = `translate(${x + dx}px, ${y + dy}px) scale(1)`;
        if (i < frames) requestAnimationFrame(f);
        else done();
      };
      requestAnimationFrame(f);
    });
    cam.style.transform = t0;
    st.remove();
  }, { css, whole, frames });
}
const LAB: Array<[string, { css?: string; whole?: boolean }]> = [
  ["part pixels", { whole: false }],
  ["whole pixels", {}],
  ["no overlay", { css: ".bd-overlay, .bd-presence { display: none !important; }" }],
  ["no video, canvas", { css: ".bd-world video, .bd-world canvas { display: none !important; }" }],
  ["no shadows", { css: ".bd-world * { box-shadow: none !important; }" }],
  ["no pictures", { css: ".bd-world img { visibility: hidden !important; }" }],
  ["no text", { css: ".bd-world * { color: transparent !important; text-shadow: none !important; }" }],
  ["no gradients", { css: ".bd-world * { background-image: none !important; }" }],
  ["design hidden", { css: ".bd-world { visibility: hidden !important; }" }],
];
const LAB_APP: Array<[string, string]> = [
  ["app pan", ""],
  ["app pan, no overlay", ".bd-overlay { display: none !important; }"],
  ["app pan, no labels", ".bd-label { display: none !important; }"],
  ["app pan, no topbar", ".bd-topbar { display: none !important; }"],
  ["app pan, no panels", ".bd-left, .bd-right { display: none !important; }"],
  ["app pan, no canvas", ".bd-world canvas { display: none !important; }"],
  ["app pan, no video", ".bd-world video { display: none !important; }"],
  ["app pan, design hidden", ".bd-world { visibility: hidden !important; }"],
];
/** The app's own trackpad pan, with one kind of thing hidden. */
async function labApp(page: Page, css: string) {
  await E(page, (css: string) => {
    const st = document.createElement("style");
    st.id = "lab-css";
    st.textContent = css;
    document.head.appendChild(st);
  }, css);
  await sleep(300);
  await wheelPan(page);
  await E(page, () => document.getElementById("lab-css")?.remove());
}
/** A zoom redrawn at every step (the world's own transform), with one kind of thing hidden. */
async function labZoom(page: Page, css: string) {
  await E(page, (css: string) => {
    const st = document.createElement("style");
    st.id = "lab-css";
    st.textContent = css;
    document.head.appendChild(st);
  }, css);
  await sleep(400);
  await ceiling(page, "zoom", "redrawn", 90);
  await E(page, () => document.getElementById("lab-css")?.remove());
}
const LAB_ZOOM: Array<[string, string]> = [
  ["zoom", ""],
  ["zoom, no shadows", ".bd-world * { box-shadow: none !important; }"],
  ["zoom, no text", ".bd-world * { color: transparent !important; }"],
  ["zoom, no pictures", ".bd-world img, .bd-world video { visibility: hidden !important; }"],
  ["zoom, no gradients", ".bd-world * { background-image: none !important; }"],
  ["zoom, gradients no-repeat", ".bd-world * { background-repeat: no-repeat !important; }"],
  ["zoom, gradients as layers", ".bd-world *[style*='gradient'] { will-change: transform; }"],
  ["zoom, no svg", ".bd-world svg { visibility: hidden !important; }"],
  ["zoom, no corners", ".bd-world * { border-radius: 0 !important; }"],
  ["zoom, no borders", ".bd-world * { border-color: transparent !important; }"],
  ["zoom, design hidden", ".bd-world { visibility: hidden !important; }"],
];
const LAB_SCENARIOS: Scenario[] = [
  ...LAB_ZOOM.map(([name, css]): Scenario => ({ name: `lab: ${name}`, board: "screens", prep: ({ page }) => setup(page, { view: "fit" }), run: ({ page }) => labZoom(page, css) })),
  ...LAB.map(([name, o]): Scenario => ({ name: `lab: ${name}`, board: "screens", prep: ({ page }) => setup(page, { view: "fit" }), run: ({ page }) => lab(page, o) })),
  ...LAB_APP.map(([name, css]): Scenario => ({ name: `lab: ${name}`, board: "screens", prep: ({ page }) => setup(page, { view: "fit" }), run: ({ page }) => labApp(page, css) })),
];

const SCENARIOS: Scenario[] = [
  { name: "idle", board: "screens", prep: ({ page, side }) => setup(page, { view: "fit" }), run: () => sleep(1500) },
  { name: "pan: trackpad (all in view)", board: "screens", prep: ({ page, side }) => setup(page, { view: "fit" }), run: ({ page, side }) => wheelPan(page) },
  { name: "pan: trackpad (50%)", board: "screens", prep: ({ page, side }) => setup(page, { view: WORK }), run: ({ page, side }) => wheelPan(page) },
  { name: "pan: space-drag (50%)", board: "screens", prep: ({ page, side }) => setup(page, { view: WORK }), run: async ({ page, side }) => dragPath(page, await center(page), { x: -5, y: -3 }, 90, { space: true }) },
  { name: "zoom: pinch (ctrl+wheel)", board: "screens", prep: ({ page, side }) => setup(page, { view: "fit" }), run: ({ page, side }) => pinch(page) },
  { name: "zoom: ⌘+ / ⌘− (animated)", board: "screens", prep: ({ page, side }) => setup(page, { view: WORK }), run: ({ page, side }) => keyZoom(page) },
  {
    name: "zoom: to fit / to selection",
    board: "screens",
    prep: ({ page, side }) => setup(page, { view: WORK, sel: [side.screens.byName("Phone 3")] }),
    run: async ({ page, side }) => {
      for (let i = 0; i < 2; i++) {
        await page.keyboard.press("Shift+Digit1");
        await sleep(450);
        await page.keyboard.press("Shift+Digit2");
        await sleep(450);
      }
    },
  },
  { name: "ceiling: pan (all in view)", board: "screens", prep: ({ page, side }) => setup(page, { view: "fit" }), run: ({ page, side }) => ceiling(page, "pan", "redrawn") },
  { name: "ceiling: pan, camera (all)", board: "screens", prep: ({ page, side }) => setup(page, { view: "fit" }), run: ({ page, side }) => ceiling(page, "pan", "camera") },
  { name: "ceiling: zoom, redrawn (all)", board: "screens", prep: ({ page, side }) => setup(page, { view: "fit" }), run: ({ page, side }) => ceiling(page, "zoom", "redrawn") },
  { name: "ceiling: zoom, will-change (all)", board: "screens", prep: ({ page, side }) => setup(page, { view: "fit" }), run: ({ page, side }) => ceiling(page, "zoom", "will-change") },
  { name: "ceiling: zoom, camera (all)", board: "screens", prep: ({ page, side }) => setup(page, { view: "fit" }), run: ({ page, side }) => ceiling(page, "zoom", "camera") },
  {
    name: "click to select",
    board: "screens",
    prep: ({ page, side }) => setup(page, { view: WORK }),
    run: async ({ page, side }) => {
      for (const p of await clickTargets(page, 12)) {
        await page.mouse.click(p.x, p.y);
        await sleep(160);
      }
    },
  },
  {
    name: "hover across layers",
    board: "screens",
    prep: ({ page, side }) => setup(page, { view: WORK }),
    run: async ({ page, side }) => {
      const c = await canvasBox(page);
      await paced(150, (i) => page.mouse.move(c.x + 30 + ((i % 30) / 30) * (c.width - 60), c.y + 60 + (Math.floor(i / 30) / 5) * (c.height - 120) + (i % 30) * 3));
    },
  },
  {
    name: "drag an artboard",
    board: "screens",
    prep: ({ page, side }) => setup(page, { view: WORK }),
    run: async ({ page, side }) => {
      const l = await E<Box, string>(page, (id) => {
        const r = document.querySelector(`[data-label="${id}"]`)!.getBoundingClientRect();
        return { x: r.x, y: r.y, width: r.width, height: r.height };
      }, side.screens.byName("Desktop 0"));
      await dragPath(page, { x: l.x + 20, y: l.y + l.height / 2 }, { x: 3, y: 2 });
    },
    after: ({ page, side }) => undo(page),
  },
  {
    name: "drag a layer",
    board: "screens",
    prep: ({ page, side }) => setup(page, { view: WORK }),
    run: async ({ page, side }) => {
      const b = (await boxOf(page, side.screens.byName("Badge 0")))!;
      await dragPath(page, { x: b.x + 10, y: b.y + b.height / 2 }, { x: 3, y: 2 });
    },
    after: ({ page, side }) => undo(page),
  },
  {
    name: "drag to reorder (flex)",
    board: "screens",
    prep: ({ page, side }) => setup(page, { view: WORK }),
    run: async ({ page, side }) => {
      const b = (await boxOf(page, side.screens.byName("Logos 0")))!;
      await dragPath(page, { x: b.x + 30, y: b.y + b.height / 2 }, { x: 0, y: 4 });
    },
    after: ({ page, side }) => undo(page),
  },
  {
    name: "resize with a handle",
    board: "screens",
    prep: ({ page, side }) => setup(page, { view: WORK, sel: [side.screens.byName("Badge 0")] }),
    run: async ({ page, side }) => {
      const h = (await page.locator(".bd-handle.h-se").first().boundingBox())!;
      await dragPath(page, { x: h.x + h.width / 2, y: h.y + h.height / 2 }, { x: 3, y: 1 });
    },
    after: ({ page, side }) => undo(page),
  },
  { name: "site: idle", board: "website", prep: ({ page, side }) => setup(page, { view: SITE_VIEW }), run: () => sleep(1500) },
  { name: "site: scroll (trackpad)", board: "website", prep: ({ page, side }) => setup(page, { view: SITE_VIEW }), run: ({ page, side }) => wheelScroll(page) },
  { name: "site: pinch (ctrl+wheel)", board: "website", prep: ({ page, side }) => setup(page, { view: SITE_VIEW }), run: ({ page, side }) => pinch(page, 50, 3) },
  { name: "site: zoom to fit", board: "website", prep: ({ page, side }) => setup(page, { view: SITE_VIEW }), run: async ({ page, side }) => {
    for (let i = 0; i < 2; i++) {
      await page.keyboard.press("Shift+Digit1");
      await sleep(450);
      await page.keyboard.press("Shift+Digit0");
      await sleep(450);
    }
  } },
  { name: "site ceiling: zoom, redrawn", board: "website", prep: ({ page, side }) => setup(page, { view: SITE_VIEW }), run: ({ page, side }) => ceiling(page, "zoom", "redrawn") },
  { name: "site ceiling: zoom, will-change", board: "website", prep: ({ page, side }) => setup(page, { view: SITE_VIEW }), run: ({ page, side }) => ceiling(page, "zoom", "will-change") },
  { name: "site ceiling: zoom, camera", board: "website", prep: ({ page, side }) => setup(page, { view: SITE_VIEW }), run: ({ page, side }) => ceiling(page, "zoom", "camera") },
  {
    name: "site: click to select",
    board: "website",
    prep: ({ page, side }) => setup(page, { view: SITE_VIEW }),
    run: async ({ page, side }) => {
      for (const p of await clickTargets(page, 12)) {
        await page.mouse.click(p.x, p.y);
        await sleep(160);
      }
    },
  },
  {
    name: "site: hover",
    board: "website",
    prep: ({ page, side }) => setup(page, { view: SITE_VIEW }),
    run: async ({ page, side }) => {
      const c = await canvasBox(page);
      await paced(150, (i) => page.mouse.move(c.x + 30 + ((i % 30) / 30) * (c.width - 60), c.y + 60 + (Math.floor(i / 30) / 5) * (c.height - 120) + (i % 30) * 3));
    },
  },
  {
    name: "site: drag a layer",
    board: "website",
    prep: ({ page, side }) => setup(page, { view: SITE_VIEW }),
    run: async ({ page, side }) => {
      const b = (await boxOf(page, side.site.byName("Badge 9")))!;
      await dragPath(page, { x: b.x + 10, y: b.y + b.height / 2 }, { x: 3, y: 2 });
    },
    after: ({ page, side }) => undo(page),
  },
  {
    name: "site: resize with a handle",
    board: "website",
    prep: ({ page, side }) => setup(page, { view: SITE_VIEW, sel: [side.site.byName("Badge 9")] }),
    run: async ({ page, side }) => {
      const h = (await page.locator(".bd-handle.h-se").first().boundingBox())!;
      await dragPath(page, { x: h.x + h.width / 2, y: h.y + h.height / 2 }, { x: 3, y: 1 });
    },
    after: ({ page, side }) => undo(page),
  },
];

// ---------------------------------------------------------------------------------------------
// Chromium's own account of the main thread, per interaction (--trace)

const TRACE_CATS = ["devtools.timeline", "disabled-by-default-devtools.timeline", "v8", "blink", "cc", "gpu"];
function traceSummary(buf: Buffer): Record<string, number> {
  const events = (JSON.parse(buf.toString("utf8")).traceEvents ?? []) as Array<{ ph: string; name: string; ts: number; dur?: number; pid: number; tid: number; args?: { name?: string } }>;
  const main = events.find((e) => e.ph === "M" && e.name === "thread_name" && e.args?.name === "CrRendererMain" && events.some((x) => x.pid === e.pid && x.name === "Layout"));
  if (!main) return {};
  const workers = new Set(events.filter((e) => e.ph === "M" && e.name === "thread_name" && e.pid === main.pid && /Compositor|Raster/i.test(e.args?.name ?? "")).map((e) => e.tid));
  const group = (n: string) =>
    /^(Layout|UpdateLayoutTree|RecalculateStyles|ParseHTML|InvalidateLayout|ScheduleStyleRecalculation)$/.test(n) ? (n === "Layout" ? "layout" : "style")
      : /^(Paint|PrePaint|Layerize|PaintImage|Decode Image|UpdateLayer|CompositeLayers|Commit|ImageDecodeTask)$/.test(n) ? "paint"
      : /^(HitTest)$/.test(n) ? "hit-test"
      : /GC/.test(n) ? "gc"
      : /^(FunctionCall|EvaluateScript|v8\.compile|v8\.run|TimerFire|EventDispatch|FireAnimationFrame|RunMicrotasks|v8\.callFunction|V8\.Execute|v8\.execute)$/.test(n) ? "script"
      : null;
  const out: Record<string, number> = {};
  // Self time on the main thread: each event's length less the events inside it.
  const xs = events.filter((e) => e.pid === main.pid && e.tid === main.tid && e.ph === "X" && e.dur).sort((a, b) => a.ts - b.ts || (b.dur ?? 0) - (a.dur ?? 0));
  const stack: Array<{ end: number; g: string | null; self: number }> = [];
  const close = (until: number) => {
    while (stack.length && stack[stack.length - 1].end <= until) {
      const top = stack.pop()!;
      const g = top.g ?? stack.findLast?.((s) => s.g)?.g ?? "other";
      out[g] = (out[g] ?? 0) + top.self;
    }
  };
  for (const e of xs) {
    close(e.ts);
    const parent = stack[stack.length - 1];
    if (parent) parent.self -= e.dur!;
    stack.push({ end: e.ts + e.dur!, g: group(e.name), self: e.dur! });
  }
  close(Infinity);
  let raster = 0;
  for (const e of events) if (e.pid === main.pid && workers.has(e.tid) && e.ph === "X" && /RasterTask|TileManager::RunTask|RasterizerTaskImpl/.test(e.name)) raster += e.dur ?? 0;
  out.raster = raster;
  for (const k of Object.keys(out)) out[k] = Math.round(out[k] / 1000);
  return out;
}

// ---------------------------------------------------------------------------------------------
// Running it

type Results = Record<string, Record<string, Result>>;
/** By side ("before", "after"), engine and interaction. */
const results: Record<string, Results> = Object.fromEntries(sides.map((x) => [x.name, {}]));
let failures = 0;

async function openBoardIn(page: Page, id: string) {
  await E(page, async (id: string) => (await import("/ui/board-state.js" as string)).openBoard(id), id);
  await page.waitForSelector(".bd-world [data-bid]");
  await sleep(1500);
}

const row = (r: Result) => `${String(r.fps).padStart(5)} ${String(r.p50).padStart(6)} ${String(r.p95).padStart(6)} ${String(r.max).padStart(6)} ${String(r.dropped).padStart(5)} ${String(r.slow).padStart(5)}   ${String(r.workP50).padStart(5)} ${String(r.workP95).padStart(5)} ${String(r.workMax).padStart(6)} ${String(r.over).padStart(4)}  ${r.long ? `${r.long} (${r.longMs} ms)` : "-"}`;

/**
 * --look (with --ab): the canvas at rest, the same views in both builds, compared pixel by pixel:
 * how many pixels differ visibly, and pictures of both (and of the difference) to look at.
 */
async function look(pages: Array<{ b: Side; page: Page }>, engine: string) {
  const { decodePng } = await import("../src/util/png.js");
  const dir = path.join(os.tmpdir(), "glassine-look");
  mkdirSync(dir, { recursive: true });
  const views: Array<[string, "screens" | "website", { x: number; y: number; z: number } | "fit", string[]?]> = [
    ["screens fit", "screens", "fit"],
    ["screens 50%", "screens", WORK],
    ["screens 200%", "screens", { x: -200, y: -300, z: 2 }],
    ["site 75%", "website", SITE_VIEW],
    ["selected", "screens", WORK, ["Badge 0"]],
  ];
  for (const [title, board, view, sel] of views) {
    const shots: Buffer[] = [];
    for (const p of pages) {
      const id = board === "screens" ? p.b.screens.id : p.b.site.id;
      if ((p as { open?: string }).open !== id) {
        await openBoardIn(p.page, id);
        (p as { open?: string }).open = id;
      }
      await setup(p.page, { view, sel: sel?.map((n) => p.b.screens.byName(n)) });
      await sleep(900);
      const c = await canvasBox(p.page);
      const file = path.join(dir, `${engine}-${title.replace(/\W+/g, "-")}-${p.b.name}.png`);
      shots.push(await p.page.screenshot({ path: file, clip: c }));
    }
    const [a, b] = shots.map((x) => decodePng(x));
    let off = 0;
    let worst = 0;
    const diff = Buffer.alloc(a.width * a.height * 4);
    for (let i = 0; i < a.rgba.length; i += 4) {
      const d = Math.max(Math.abs(a.rgba[i] - b.rgba[i]), Math.abs(a.rgba[i + 1] - b.rgba[i + 1]), Math.abs(a.rgba[i + 2] - b.rgba[i + 2]));
      if (d > 8) off++;
      worst = Math.max(worst, d);
      diff.set(d > 8 ? [255, 0, 80, 255] : [a.rgba[i] / 3, a.rgba[i + 1] / 3, a.rgba[i + 2] / 3, 255], i);
    }
    writeFileSync(path.join(dir, `${engine}-${title.replace(/\W+/g, "-")}-diff.png`), encodePng({ width: a.width, height: a.height, rgba: diff }));
    console.log(`${title.padEnd(16)} ${((off / (a.width * a.height)) * 100).toFixed(3).padStart(7)}% of pixels differ (largest difference ${worst}/255)`);
  }
  console.log(`pictures in ${dir}`);
}

try {
  for (const name of engines) {
    const browser = await ENGINES[name].launch(name === "chromium" ? { channel: "chromium", headless: !HEADED } : { headless: !HEADED });
    // A page for each side, in contexts of their own: only one is driven at a time.
    const pages: Array<{ b: Side; page: Page; open: string; errors: string[] }> = [];
    for (const b of sides) {
      const context: BrowserContext = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, colorScheme: "dark" });
      await context.addInitScript(RECORDER);
      const page = await context.newPage();
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await page.goto(b.base, { waitUntil: "networkidle" });
      pages.push({ b, page, open: "", errors });
      results[b.name][name] = {};
    }
    await sleep(500);
    if (flag("look")) {
      console.log(`\n${name}: the canvas at rest, before against after`);
      await look(pages, name);
      await browser.close();
      continue;
    }
    console.log(`\n${name} (${screens.layers} + ${site.layers} layers)${AB ? ": before → after" : ""}`);
    // A display slower than 60 Hz holds WebKit to its rate: then the frames' work says more than fps.
    const hz = await E<number, void>(pages[0].page, () => new Promise<number>((done) => { const t: number[] = []; const f = (x: number) => (t.push(x), t.length < 31 ? requestAnimationFrame(f) : done(Math.round(30000 / (t[30] - t[0])))); requestAnimationFrame(f); }));
    if (hz < 55) console.log(`(this engine draws at ${hz} Hz here: the display it follows is slower than 60 Hz, so fps can't pass ${hz}; "work" still shows what fits 60)`);
    console.log(AB ? `${"interaction".padEnd(34)} ${"fps".padStart(13)} ${"p95 ms".padStart(13)} ${"work p95".padStart(13)} ${"work max".padStart(13)} ${">14ms".padStart(9)}` : `${"interaction".padEnd(34)} ${"fps".padStart(5)} ${"p50".padStart(6)} ${"p95".padStart(6)} ${"max".padStart(6)} ${"drop".padStart(5)} ${"slow".padStart(5)}   work: p50   p95    max >14  long tasks${TRACE ? "   main-thread ms (trace)" : ""}`);
    for (const sc of flag("lab") ? LAB_SCENARIOS : SCENARIOS) {
      if (only && !only.test(sc.name)) continue;
      const runs = new Map<string, Result[]>(pages.map((x) => [x.b.name, []]));
      try {
        for (let round = 0; round < ROUNDS; round++)
          for (const p of pages) {
            const { page, b } = p;
            const boardId = sc.board === "screens" ? b.screens.id : b.site.id;
            if (p.open !== boardId) {
              await openBoardIn(page, boardId);
              p.open = boardId;
            }
            const ctx = { page, browser, engine: name, side: b };
            await sc.prep(ctx);
            if (TRACE && name === "chromium") await browser.startTracing(page, { categories: TRACE_CATS });
            await E(page, () => (window as unknown as { __bench: { start(): void } }).__bench.start());
            await sc.run(ctx);
            await sleep(120);
            const raw = await E<{ frames: number[]; long: number[]; work: number[] }, void>(page, () => (window as unknown as { __bench: { stop(): { frames: number[]; long: number[]; work: number[] } } }).__bench.stop());
            const r = summarize(raw.frames, raw.long, raw.work);
            // --frames: each frame's length, to see where the slow ones fall.
            if (flag("frames")) console.log(`  ${b.name} frames: ` + raw.frames.slice(1).map((t, i) => Math.round(t - raw.frames[i])).join(" "));
            if (TRACE && name === "chromium") r.trace = traceSummary(await browser.stopTracing());
            runs.get(b.name)!.push(r);
            await sc.after?.(ctx);
          }
      } catch (e) {
        for (const { page } of pages) await E(page, () => (window as unknown as { __bench: { stop(): void } }).__bench.stop()).catch(() => undefined);
        failures++;
        console.log(`${sc.name.padEnd(34)} failed: ${(e as Error).message.split("\n")[0]}`);
        continue;
      }
      // Several rounds: the median one by fps.
      const med = (list: Result[]) => [...list].sort((a, b) => a.fps - b.fps)[Math.floor(list.length / 2)];
      for (const { b } of pages) results[b.name][name][sc.name] = med(runs.get(b.name)!);
      if (AB && results.before[name]) {
        const [o, r] = [results.before[name][sc.name], results.after[name][sc.name]];
        const pair = (a: number, c: number, w: number) => `${a} → ${c}`.padStart(w);
        console.log(`${sc.name.padEnd(34)} ${pair(o.fps, r.fps, 13)} ${pair(o.p95, r.p95, 13)} ${pair(o.workP95, r.workP95, 13)} ${pair(o.workMax, r.workMax, 13)} ${pair(o.over, r.over, 9)}`);
      } else {
        const r = results.after[name][sc.name];
        const tr = r.trace ? "   " + Object.entries(r.trace).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(", ") : "";
        console.log(`${sc.name.padEnd(34)} ${row(r)}${tr}`);
      }
    }
    for (const p of pages)
      if (p.errors.length) {
        failures++;
        console.log(`page errors (${p.b.name}): ${[...new Set(p.errors)].slice(0, 3).join(" | ")}`);
      }
    await browser.close();
  }
} finally {
  for (const b of sides) b.engine.kill("SIGTERM");
  rmSync(tmpRoot, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------------------------
// Saving, and comparing with an earlier run

const outDir = path.join(ROOT, "docs", "perf");
mkdirSync(outDir, { recursive: true });
const file = path.join(outDir, `canvas-${label}.json`);
const meta = { label, stress: STRESS, at: new Date().toISOString(), layers: { screens: screens.layers, website: site.layers }, viewport: "1440x900@2x", rounds: ROUNDS };
writeFileSync(file, JSON.stringify({ ...meta, results: results.after, ...(AB ? { before: results.before } : {}) }, null, 2) + "\n");
console.log(`\nSaved ${path.relative(ROOT, file)}`);

if (compareTo) {
  const old = JSON.parse(readFileSync(path.join(outDir, `canvas-${compareTo}.json`), "utf8")).results as Results;
  for (const name of Object.keys(results.after)) {
    if (!old[name]) continue;
    console.log(`\n${name}: fps ${compareTo} → ${label} (p95 ms)`);
    for (const [sc, r] of Object.entries(results.after[name])) {
      const o = old[name][sc];
      if (!o) continue;
      console.log(`${sc.padEnd(34)} ${String(o.fps).padStart(5)} → ${String(r.fps).padStart(5)}   (${o.p95} → ${r.p95})`);
    }
  }
}
process.exit(failures ? 1 : 0);
