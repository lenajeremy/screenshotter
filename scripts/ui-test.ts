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

// A library of its own, set before the Studio's modules read where the library is.
const tmp = mkdtempSync(path.join(os.tmpdir(), "screenshotter-ui-"));
const LIB = path.join(tmp, "library");
mkdirSync(path.join(LIB, "images"), { recursive: true });
writeFileSync(path.join(tmp, "studio.json"), JSON.stringify({ folder: LIB }));
process.env.SCREENSHOTTER_STUDIO_FILE = path.join(tmp, "studio.json");
process.env.SCREENSHOTTER_SEEN_FILE = path.join(tmp, "seen.json");
process.env.SCREENSHOTTER_STYLE_FILE = path.join(tmp, "style.json");
process.env.SCREENSHOTTER_OUTPUT_DIR = LIB;

const { startStudio } = await import("../src/studio/server.js");
const { encodePng } = await import("../src/util/png.js");
const { renderHtml } = await import("../src/render/mockup.js");
const { closeBrowser } = await import("../src/render/browser.js");

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

const CHECKS: Record<string, Check> = {
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
  async "the squiggly underline draws, and Wavy is in the Text panel"(page) {
    await setDesign(page, { shots: null, groups: null, scene: phone({ headline: "Say it **wavy**", textStyle: { accentMark: "squiggle", accentColor: "#e0662a" } }), selected: "caption", rightOpen: true });
    await page.waitForTimeout(1500);
    return S(page, () => {
      const mark = [...document.querySelectorAll<HTMLElement>(".stage .artboard .mark")].some((x) => (x.style.backgroundImage || "").includes("svg"));
      const wavy = [...document.querySelectorAll(".panel.right button")].some((b) => b.textContent?.trim() === "Wavy");
      return mark && wavy ? "ok" : `mark ${mark}, Wavy option ${wavy}`;
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
  async "a design of just words and doodles starts, exports and previews"(page) {
    await S(page, async () => (await import("/ui/actions.js" as string)).newScene());
    await page.waitForTimeout(1000);
    const welcome = await S(page, () => Boolean(document.querySelector(".welcome")));
    await page.locator(".welcome-alt .alt", { hasText: "Just words" }).click();
    await page.waitForTimeout(1600);
    const r = await S(page, async () => {
      const st = await import("/ui/store.js" as string);
      const a = await import("/ui/actions.js" as string);
      const exportOn = !([...document.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Export") as HTMLButtonElement | undefined)?.disabled;
      await a.exportImage();
      for (let i = 0; i < 100 && st.S.rendering; i++) await new Promise((r) => setTimeout(r, 400));
      const exported = st.S.toasts.some((t: { title: string }) => /exported/i.test(t.title));
      await a.renderPreview();
      for (let i = 0; i < 100 && st.S.rendering; i++) await new Promise((r) => setTimeout(r, 400));
      return { exportOn, exported, preview: Boolean(st.S.render), layout: Boolean(st.S.layout) };
    });
    return welcome && r.exportOn && r.exported && r.preview && r.layout ? "ok" : `start screen ${welcome}, ${JSON.stringify(r)}`;
  },
  async "a design of just words comes back after a reload"(page) {
    await S(page, async () => (await import("/ui/actions.js" as string)).newScene());
    await page.waitForTimeout(800);
    await page.locator(".welcome-alt .alt", { hasText: "Just words" }).click();
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
    await page.waitForTimeout(1000);
    const first = await S(page, () => document.querySelector(".set-template b")?.textContent ?? "");
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
  await closeBrowser();
  rmSync(tmp, { recursive: true, force: true });
}
console.log(failed ? `\n${failed} UI check${failed === 1 ? "" : "s"} failed.` : `\nAll UI checks passed.`);
process.exit(failed ? 1 : 0);
