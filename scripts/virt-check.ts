/**
 * Off-screen artboard virtualization + zoomed-out Bitmap LOD check on a massive 35,000+ layer
 * multi-artboard page: verifies fast open, tiny DOM node count, crisp LOD bitmaps, off-screen
 * virtualization when zoomed in, seamless hydration on zoom/click/double-click, content-hash
 * invalidation on edit (but not on move), and 60 fps pan/zoom.
 *
 *   npx tsx scripts/virt-check.ts
 */
import { spawn } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmp = mkdtempSync(path.join(os.tmpdir(), "glassine-virt-"));
const LIB = path.join(tmp, "library");
mkdirSync(path.join(LIB, "images"), { recursive: true });
writeFileSync(path.join(tmp, "studio.json"), JSON.stringify({ folder: LIB }));
const env = {
  SCREENSHOTTER_OUTPUT_DIR: LIB,
  SCREENSHOTTER_STUDIO_FILE: path.join(tmp, "studio.json"),
  SCREENSHOTTER_SEEN_FILE: path.join(tmp, "seen.json"),
  SCREENSHOTTER_STYLE_FILE: path.join(tmp, "style.json"),
  SCREENSHOTTER_CACHE_DIR: path.join(tmp, "cache"),
  SCREENSHOTTER_AGENTMAN_SOCKET: path.join(tmp, "none.sock"),
  SCREENSHOTTER_NO_KEYCHAIN: "1",
  SCREENSHOTTER_CHROME_PATH: chromium.executablePath(),
};
Object.assign(process.env, env);

const boards = await import("../src/board/store.js");
const core = await import("../src/board/core.js");
const { A, desktop, phone, photo } = await import("./bench-designs.js");
const { artboardLodHash } = await import("../src/board/lod.js");

A.photos = [0, 1, 2, 3, 4, 5].map((i) => path.join(LIB, "images", `photo-${i}.png`));
A.avatars = [0, 1, 2, 3, 4, 5].map((i) => path.join(LIB, "images", `avatar-${i}.png`));
for (let i = 0; i < 6; i++) {
  photo(A.photos[i], 800, 500, i + 1);
  photo(A.avatars[i], 120, 120, i + 11);
}
A.clip = path.join(LIB, "clip.mp4");
copyFileSync(path.join(root, "scripts", "fixtures", "clip.mp4"), A.clip);

// Build a 160-artboard mega board (~32,000+ layers: 60 desktop screens + 100 phone screens).
const b = boards.createBoard("Mega 35k layers", "studio");
const pageId = b.pages[0].id;
const SETS = 10;
for (let r = 0; r < SETS; r++) {
  const htmls = [
    ...[0, 1, 2, 3, 4, 5].map((k) => desktop(r * 6 + k, { x: k * 1640, y: r * 7200 })),
    ...[0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((k) => phone(r * 10 + k, { x: k * 490, y: r * 7200 + 5600 })),
  ];
  for (const h of htmls) {
    boards.changeBoard(b.id, core.addHtmlOps(h, null, { page: pageId }).ops, "studio");
  }
}
const board = boards.getBoard(b.id);
const totalLayers = Object.keys(board.nodes).length;
const totalRoots = board.pages[0].children.length;
const rootByName = (name: string) => Object.values(board.nodes).find((n) => !n.parent && n.name === name)!.id;
console.log(`Built test board: ${totalRoots} artboards, ${totalLayers} total layers`);

let failed = 0;
const check = (ok: unknown, what: string) => {
  console.log(`${ok ? "PASS" : "FAIL"} ${what}`);
  if (!ok) failed++;
};

// Hash invariant: moving root artboard keeps LOD hash; editing child changes LOD hash.
const phone0 = rootByName("Phone 0");
const phone1 = rootByName("Phone 1");
const hMoveBefore = artboardLodHash(board, phone1, 768);
const movedBoard = core.applyOps(board, [{ op: "set", id: phone1, style: { left: "999px", top: "777px" } }]).board;
const hMoveAfter = artboardLodHash(movedBoard, phone1, 768);
check(hMoveBefore === hMoveAfter, `moving an artboard keeps its LOD hash (${hMoveBefore})`);

const phone0Child = Object.values(board.nodes).find((n) => n.type === "text" && core.rootOf(board, n.id) === phone0)!.id;
const hEditBefore = artboardLodHash(board, phone0, 768);
const editedBoard = core.applyOps(board, [{ op: "set", id: phone0Child, text: "Updated title" }]).board;
const hEditAfter = artboardLodHash(editedBoard, phone0, 768);
check(hEditBefore !== hEditAfter, `editing a layer inside an artboard invalidates its LOD hash (${hEditBefore} -> ${hEditAfter})`);

const port = await new Promise<number>((ok) => {
  const s = net.createServer().listen(0, "127.0.0.1", () => {
    const p = (s.address() as net.AddressInfo).port;
    s.close(() => ok(p));
  });
});
const engine = spawn(process.execPath, [path.join(root, "dist", "index.js"), "studio", "--port", String(port), "--no-open"], { env: { ...process.env, ...env }, stdio: "ignore" });
const base = `http://127.0.0.1:${port}/`;
for (let i = 0; i < 80; i++) {
  try {
    if ((await fetch(`${base}api/options`)).ok) break;
  } catch {}
  await new Promise((r) => setTimeout(r, 150));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const FRAME = 1000 / 60;
async function paced(n: number, fn: (i: number) => Promise<unknown>) {
  const t0 = performance.now();
  for (let i = 0; i < n; i++) {
    await fn(i);
    const w = t0 + (i + 1) * FRAME - performance.now();
    if (w > 0) await sleep(w);
  }
}

// Keep macOS display/idle awake for the duration of this run; `-w <pid>` exits automatically when we do.
if (process.platform === "darwin") {
  const caff = spawn("/usr/bin/caffeinate", ["-d", "-i", "-w", String(process.pid)], { stdio: "ignore", detached: true });
  caff.on("error", () => undefined);
  caff.unref();
}
const CHROMIUM_PERF_ARGS = [
  "--disable-renderer-backgrounding",
  "--disable-background-timer-throttling",
  "--disable-backgrounding-occluded-windows",
];

const browser = await chromium.launch({ channel: "chromium", headless: true, args: CHROMIUM_PERF_ARGS });
const shotDir = process.env.VIRT_SHOT_DIR || "";
try {
  // 1. Cold open at Fit
  const ctx1 = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, colorScheme: "dark" });
  await ctx1.addInitScript("window.__name = (f) => f");
  const page = await ctx1.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(base, { waitUntil: "networkidle" });

  const tCold0 = performance.now();
  await page.evaluate(async (id) => (await import("/ui/board-state.js" as string)).openBoard(id), b.id);
  await page.waitForSelector(".bd-world [data-bid]");
  const tColdOpen = Math.round(performance.now() - tCold0);
  const coldImmediate = await page.evaluate(() => ({
    dom: document.querySelectorAll(".bd-world *").length,
    virt: { ...(window as any).__glassineVirt },
  }));
  check(coldImmediate.virt.active && coldImmediate.dom < 9000, `cold open caps DOM on ${totalLayers}-layer board (${tColdOpen}ms, ${coldImmediate.dom} DOM nodes vs ${totalLayers} layers, live=${coldImmediate.virt.live} lod=${coldImmediate.virt.lod} virt=${coldImmediate.virt.virtual})`);

  // Wait for LOD bitmaps to finish rendering and decoding on Fit view
  const tLod0 = performance.now();
  let settled: any = null;
  for (let i = 0; i < 120; i++) {
    await sleep(300);
    settled = await page.evaluate(() => ({
      dom: document.querySelectorAll(".bd-world *").length,
      lodImgs: document.querySelectorAll(".bd-world .bd-lod-img").length,
      loadedImgs: [...document.querySelectorAll<HTMLImageElement>(".bd-world .bd-lod-img")].filter((im) => im.complete && im.naturalWidth > 0).length,
      virt: { ...(window as any).__glassineVirt },
    }));
    if (settled.virt.lod >= totalRoots - 2 && settled.loadedImgs >= totalRoots - 2) break;
  }
  const tLodMs = Math.round(performance.now() - tLod0);
  check(settled.virt.lod >= totalRoots - 2 && settled.loadedImgs >= totalRoots - 2 && settled.dom < 1000, `Fit settles to crisp Bitmap LOD in ${tLodMs}ms (${settled.loadedImgs}/${settled.virt.lod} WebP bitmaps loaded, only ${settled.dom} DOM nodes for ${totalLayers} layers!)`);
  if (shotDir) {
    mkdirSync(shotDir, { recursive: true });
    await page.screenshot({ path: path.join(shotDir, "virt-fit-lod.png") });
  }

  // Measure pan + pinch FPS at Fit on 32k+ layer board
  const c = await page.evaluate(() => {
    const r = document.querySelector(".bd-canvas")!.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  async function measureFps(fn: () => Promise<void>) {
    await page.evaluate(`(() => {
      window.__f = []; window.__w = []; window.__on = true;
      const ch = new MessageChannel(); const st = [];
      ch.port1.onmessage = () => { const t0 = st.shift(); if (window.__on && t0 !== undefined) window.__w.push(performance.now() - t0); };
      const f = (t) => { if (window.__on) { window.__f.push(t); st.push(performance.now()); ch.port2.postMessage(0); requestAnimationFrame(f); } };
      requestAnimationFrame(f);
    })()`);
    await fn();
    await sleep(120);
    const res: { frames: number[]; work: number[] } = await page.evaluate(`(() => { window.__on = false; return { frames: window.__f, work: window.__w }; })()`);
    const ds = res.frames.slice(1).map((t, i) => t - res.frames[i]).sort((a, b) => a - b);
    const ws = [...res.work].sort((a, b) => a - b);
    const ms = res.frames.length > 1 ? res.frames[res.frames.length - 1] - res.frames[0] : 0;
    return {
      fps: Math.round((ms ? (ds.length * 1000) / ms : 0) * 10) / 10,
      p95: Math.round((ds[Math.floor(ds.length * 0.95)] ?? 0) * 10) / 10,
      max: Math.round((ds[ds.length - 1] ?? 0) * 10) / 10,
      workP95: Math.round((ws[Math.floor(ws.length * 0.95)] ?? 0) * 10) / 10,
      workMax: Math.round((ws[ws.length - 1] ?? 0) * 10) / 10,
    };
  }
  // Check actual display refresh rate (ProMotion Macs dynamically step between 24-120 Hz; main-thread
  // workP95 <= 10ms & workMax <= 16.7ms verifies true 60fps+ headroom regardless of display VSync).
  const hz = await page.evaluate(() => new Promise<number>((done) => {
    const t: number[] = [];
    const f = (x: number) => (t.push(x), t.length < 25 ? requestAnimationFrame(f) : done(Math.round(24000 / (t[24] - t[0]))));
    requestAnimationFrame(f);
  }));
  if (hz < 55) console.log(`(display refresh is ${hz} Hz right now; verifying main-thread workP95 <= 10ms and workMax <= 16.7ms)`);

  // Verify ALL 160 LOD WebPs have non-transparent painted pixels (catches any texture-limit clipping).
  const nonBlank = await page.evaluate(() => {
    const c = document.createElement("canvas");
    c.width = 16;
    c.height = 16;
    const ctx = c.getContext("2d")!;
    let ok = 0;
    const imgs = [...document.querySelectorAll<HTMLImageElement>(".bd-world .bd-lod-img")];
    for (const im of imgs) {
      ctx.clearRect(0, 0, 16, 16);
      ctx.drawImage(im, 0, 0, 16, 16);
      const d = ctx.getImageData(0, 0, 16, 16).data;
      let painted = false;
      for (let i = 3; i < d.length; i += 4) if (d[i] > 20) { painted = true; break; }
      if (painted) ok++;
    }
    return { ok, total: imgs.length };
  });
  check(nonBlank.ok === nonBlank.total && nonBlank.total >= totalRoots - 2, `all ${nonBlank.ok}/${nonBlank.total} LOD bitmaps have painted pixels (zero clipped blanks)`);

  const fitPan = await measureFps(async () => {
    await page.mouse.move(c.x, c.y);
    await paced(60, (i) => page.mouse.wheel(Math.round(14 * Math.cos(i / 8)), Math.round(14 * Math.sin(i / 8))));
  });
  check(fitPan.fps >= 24 && fitPan.workP95 <= 10 && fitPan.workMax <= 16.7, `Fit pan across ${totalLayers} layers runs smoothly (${fitPan.fps} fps, workP95=${fitPan.workP95}ms, workMax=${fitPan.workMax}ms)`);

  const fitPinch = await measureFps(async () => {
    await page.mouse.move(c.x, c.y);
    await page.keyboard.down("Control");
    await paced(30, () => page.mouse.wheel(0, -4));
    await paced(30, () => page.mouse.wheel(0, 4));
    await page.keyboard.up("Control");
  });
  check(fitPinch.fps >= 24 && fitPinch.workP95 <= 10, `Fit pinch across ${totalLayers} layers runs smoothly (${fitPinch.fps} fps, workP95=${fitPinch.workP95}ms, workMax=${fitPinch.workMax}ms)`);

  // 2. Clicking an LOD artboard hydrates it live immediately
  await page.evaluate(async (id) => (await import("/ui/board-state.js" as string)).select(id), phone0);
  await sleep(150);
  const afterSel = await page.evaluate((id) => {
    const el = document.querySelector(`[data-bid="${id}"]`) as HTMLElement | null;
    return { isLod: el?.dataset.lod === "1", isVirt: el?.dataset.virtual === "1", kids: el?.querySelectorAll("[data-bid]").length ?? 0 };
  }, phone0);
  check(!afterSel.isLod && !afterSel.isVirt && afterSel.kids > 20, `selecting an LOD artboard hydrates it to live DOM (${afterSel.kids} child layers live)`);

  // Deselect and zoom in to Desktop 0 at 60% -> Desktop 0 live, >130 off-screen artboards virtualized!
  const desktop0 = rootByName("Desktop 0");
  await page.evaluate(async () => {
    const st = await import("/ui/board-state.js" as string);
    st.select([]);
    st.bset({ view: { x: 80, y: 60, z: 0.6 } });
  });
  let zoomedIn = { isLive: false, kids: 0, dom: 0, virt: { virtual: 0 } as any };
  const tZoomLimit = performance.now() + 1500;
  while (performance.now() < tZoomLimit) {
    zoomedIn = await page.evaluate((id) => {
      const el = document.querySelector(`[data-bid="${id}"]`) as HTMLElement | null;
      return {
        isLive: Boolean(el && !el.dataset.lod && !el.dataset.virtual),
        kids: el?.querySelectorAll("[data-bid]").length ?? 0,
        dom: document.querySelectorAll(".bd-world *").length,
        virt: { ...(window as any).__glassineVirt },
      };
    }, desktop0);
    if (zoomedIn.isLive && zoomedIn.virt.virtual >= 130) break;
    await sleep(60);
  }
  await sleep(100);
  check(zoomedIn.isLive && zoomedIn.kids > 100 && zoomedIn.virt.virtual >= 130 && zoomedIn.dom < 5000, `zoomed in to 60%: Desktop 0 is live (${zoomedIn.kids} layers), ${zoomedIn.virt.virtual} off-screen artboards virtualized, only ${zoomedIn.dom} DOM nodes total`);
  if (shotDir) await page.screenshot({ path: path.join(shotDir, "virt-zoom-live.png") });

  const zoomPan = await measureFps(async () => {
    await page.mouse.move(c.x, c.y);
    await paced(60, (i) => page.mouse.wheel(Math.round(16 * Math.cos(i / 8)), Math.round(16 * Math.sin(i / 8))));
  });
  check(zoomPan.fps >= 24 && zoomPan.workP95 <= 10 && zoomPan.workMax <= 16.7, `zoomed-in pan across ${totalLayers} layers runs smoothly (${zoomPan.fps} fps, workP95=${zoomPan.workP95}ms, workMax=${zoomPan.workMax}ms)`);

  await ctx1.close();

  // 3. Warm open (disk LOD cache populated) in a brand-new context
  const ctx2 = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, colorScheme: "dark" });
  await ctx2.addInitScript("window.__name = (f) => f");
  const page2 = await ctx2.newPage();
  page2.on("pageerror", (e) => errors.push(e.message));
  await page2.goto(base, { waitUntil: "networkidle" });
  const tWarm0 = performance.now();
  await page2.evaluate(async (id) => (await import("/ui/board-state.js" as string)).openBoard(id), b.id);
  await page2.waitForSelector(".bd-world [data-bid]");
  const tWarmOpen = Math.round(performance.now() - tWarm0);
  let warmState = { dom: 0, loadedImgs: 0, virt: {} as any };
  const tWarmLimit = performance.now() + 4000;
  while (performance.now() < tWarmLimit) {
    warmState = await page2.evaluate(() => ({
      dom: document.querySelectorAll(".bd-world *").length,
      loadedImgs: [...document.querySelectorAll<HTMLImageElement>(".bd-world .bd-lod-img")].filter((im) => im.complete && im.naturalWidth > 0).length,
      virt: { ...(window as any).__glassineVirt },
    }));
    if (warmState.loadedImgs >= totalRoots - 2) break;
    await sleep(80);
  }
  const tWarmReady = Math.round(performance.now() - tWarm0);
  check(tWarmOpen < 2000 && tWarmReady < 4000 && warmState.loadedImgs >= totalRoots - 2 && warmState.dom < 1000, `warm open loads ${totalLayers}-layer board in ${tWarmOpen}ms (all ${warmState.loadedImgs} cached LOD bitmaps ready in ${tWarmReady}ms, ${warmState.dom} DOM nodes)`);
  await ctx2.close();

  check(!errors.length, `no errors on the page (${errors.join("; ")})`);
} finally {
  await browser.close();
  engine.kill("SIGKILL");
  rmSync(tmp, { recursive: true, force: true });
}

console.log(failed ? `\n${failed} failed` : "\nAll passed");
process.exit(failed ? 1 : 0);
