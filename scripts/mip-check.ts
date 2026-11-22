// Smaller copies of pictures on the canvas (so big boards stay light), checked in a real browser:
// a picture sized by its file keeps its size, a cropped one is sharp at the size it's drawn, and
// boxes are measured again after a drag.
//
//   npx tsx scripts/mip-check.ts [webkit]
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, webkit } from "playwright";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmp = mkdtempSync(path.join(os.tmpdir(), "glassine-mip-"));
const LIB = path.join(tmp, "library");
mkdirSync(path.join(LIB, "images"), { recursive: true });
writeFileSync(path.join(tmp, "studio.json"), JSON.stringify({ folder: LIB }));
const env = { SCREENSHOTTER_OUTPUT_DIR: LIB, SCREENSHOTTER_STUDIO_FILE: path.join(tmp, "studio.json"), SCREENSHOTTER_SEEN_FILE: path.join(tmp, "seen.json"), SCREENSHOTTER_STYLE_FILE: path.join(tmp, "style.json"), SCREENSHOTTER_CACHE_DIR: path.join(tmp, "cache"), SCREENSHOTTER_AGENTMAN_SOCKET: path.join(tmp, "none.sock"), SCREENSHOTTER_NO_KEYCHAIN: "1", SCREENSHOTTER_CHROME_PATH: chromium.executablePath() };
Object.assign(process.env, env);
const boards = await import("../src/board/store.js");
const core = await import("../src/board/core.js");
const { photo } = await import("./bench-designs.js");

let failed = 0;
const check = (ok: unknown, what: string) => (console.log(`${ok ? "PASS" : "FAIL"} ${what}`), ok || failed++);
const wide = path.join(LIB, "images", "wide.png");
const big = path.join(LIB, "images", "big.png");
photo(wide, 4000, 1000, 3);
photo(big, 3000, 2000, 5);

const b = boards.createBoard("Pictures", "studio");
const made = core.addHtmlOps(
  `<div data-name="Art" style="width:1200px;height:900px;position:relative;background:#fff">
    <img data-name="Unsized" src="${big}" style="position:absolute;left:0;top:0">
    <img data-name="Cropped" src="${wide}" style="position:absolute;left:20px;top:20px;width:400px;height:400px;object-fit:cover">
    <div data-name="Zoomed" style="position:absolute;left:440px;top:20px;width:300px;height:300px;background-image:url('${wide}');background-size:300% 300%;background-position:50% 50%"></div>
    <div data-name="Auto" style="position:absolute;left:760px;top:20px;width:300px;height:300px;background-image:url('${big}')"></div>
    <div data-name="Box" style="position:absolute;left:20px;top:500px;width:300px;height:200px;background:#eee"><div data-name="Inner" style="position:absolute;left:30px;top:30px;width:80px;height:60px;background:#39f"></div></div>
  </div>`,
  null,
  { page: b.pages[0].id },
);
boards.changeBoard(b.id, made.ops, "studio");
const nodes = boards.getBoard(b.id).nodes;
const id = (name: string) => Object.values(nodes).find((n) => n.name === name)!.id;

const port = await new Promise<number>((ok) => { const s = net.createServer().listen(0, "127.0.0.1", () => { const p = (s.address() as net.AddressInfo).port; s.close(() => ok(p)); }); });
const engine = spawn(process.execPath, [path.join(root, "dist", "index.js"), "studio", "--port", String(port), "--no-open"], { env: { ...process.env, ...env }, stdio: "ignore" });
for (let i = 0; i < 80; i++) { try { if ((await fetch(`http://127.0.0.1:${port}/api/options`)).ok) break; } catch {} await new Promise((r) => setTimeout(r, 150)); }

const kind = process.argv.includes("webkit") ? webkit : chromium;
const browser = await kind.launch();
try {
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 })).newPage();
  // tsx names the functions it compiles with a helper the page doesn't have.
  await page.addInitScript("window.__name = (f) => f");
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "networkidle" });
  await page.evaluate(async (bid) => (await import("/ui/board-state.js" as string)).openBoard(bid), b.id);
  await page.waitForSelector(".bd-world [data-bid]");
  const state = () => page.evaluate((ids) => {
    const el = (i: string) => document.querySelector(`[data-bid="${i}"]`) as HTMLElement;
    const w = (u: string) => Number(/[?&]w=(\d+)/.exec(u)?.[1] ?? 0);
    const un = el(ids.unsized) as HTMLImageElement, cr = el(ids.cropped) as HTMLImageElement;
    return { unsizedW: w(un.src), unsizedNatural: [un.naturalWidth, un.naturalHeight], unsizedBox: [un.offsetWidth, un.offsetHeight], croppedW: w(cr.src), croppedFull: !/[?&]w=/.test(cr.src), zoomedW: w(el(ids.zoomed).style.backgroundImage), zoomedFull: !/[?&]w=/.test(el(ids.zoomed).style.backgroundImage), autoW: w(el(ids.auto).style.backgroundImage) };
  }, { unsized: id("Unsized"), cropped: id("Cropped"), zoomed: id("Zoomed"), auto: id("Auto") });
  // Fit shows the 1200px artboard at about 0.6: wait for the copies to settle.
  await page.waitForTimeout(2500);
  let s = await state();
  check(s.unsizedW === 0 && s.unsizedBox[0] === 3000 && s.unsizedBox[1] === 2000, `a picture sized by its file keeps the file's size (${s.unsizedBox.join("×")}, no smaller copy)`);
  check(s.autoW === 0, "a background sized auto keeps its own file too");
  // Cropped: a 400px box showing a 4000×1000 picture by cover draws it 1600px wide; at this zoom and 2x, that many screen pixels.
  const z = await page.evaluate(async () => (await import("/ui/board-state.js" as string)).B.view.z);
  const need = 1600 * z * 2;
  check(s.croppedFull || s.croppedW >= Math.min(2048, need), `a picture cropped by cover gets a copy as large as it's drawn (${s.croppedW || "full"} px for ${Math.round(need)} needed, zoom ${z.toFixed(2)})`);
  const needBg = 900 * z * 2;
  check(s.zoomedFull || s.zoomedW >= Math.min(2048, needBg), `a background drawn at 300% gets a copy as large as it's drawn (${s.zoomedW || "full"} px for ${Math.round(needBg)} needed)`);
  // Zoomed in to 400%: the full files.
  await page.evaluate(async () => (await import("/ui/board-canvas.js" as string)).zoomTo(4, { x: 300, y: 300 }));
  await page.waitForTimeout(3000);
  s = await state();
  check(s.croppedFull && s.zoomedFull, `zoomed in to 400%, both show their full files (${s.croppedW || "full"}, ${s.zoomedW || "full"})`);
  // A frame moved by 200px: the layer inside it is measured where it is now.
  const moved = await page.evaluate(async ({ box, inner }) => {
    const st = await import("/ui/board-state.js" as string), cv = await import("/ui/board-canvas.js" as string);
    cv.fit(undefined, { instant: true });
    await new Promise((r) => setTimeout(r, 400));
    const before = cv.worldBox(inner);
    st.B.dragging = "move";
    st.commit([{ op: "set", id: box, style: { left: "220px" } }]);
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    st.B.dragging = null;
    const after = cv.worldBox(inner);
    return { dx: Math.round(after.x - before.x) };
  }, { box: id("Box"), inner: id("Inner") });
  check(moved.dx === 200, `after a frame is dragged, the layer inside it is measured where it is now (moved ${moved.dx}px of 200)`);
  check(!errors.length, `no errors on the page (${errors.join("; ")})`);
} finally {
  await browser.close();
  engine.kill();
}
console.log(failed ? `${failed} failed` : "All passed");
process.exit(failed ? 1 : 0);
