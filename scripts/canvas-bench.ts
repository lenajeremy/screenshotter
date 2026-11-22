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
// A library of its own, set before the engine's modules read where things are.

const tmp = mkdtempSync(path.join(os.tmpdir(), "glassine-bench-"));
const LIB = path.join(tmp, "library");
mkdirSync(path.join(LIB, "images"), { recursive: true });
writeFileSync(path.join(tmp, "studio.json"), JSON.stringify({ folder: LIB }));
const ENV: Record<string, string> = {
  SCREENSHOTTER_OUTPUT_DIR: LIB,
  SCREENSHOTTER_STUDIO_FILE: path.join(tmp, "studio.json"),
  SCREENSHOTTER_SEEN_FILE: path.join(tmp, "seen.json"),
  SCREENSHOTTER_STYLE_FILE: path.join(tmp, "style.json"),
  SCREENSHOTTER_CACHE_DIR: path.join(tmp, "cache"),
  SCREENSHOTTER_AGENTMAN_SOCKET: path.join(tmp, "none.sock"),
  SCREENSHOTTER_NO_KEYCHAIN: "1",
  // The engine draws board thumbnails with a browser: Playwright's own, not the person's Chrome.
  SCREENSHOTTER_CHROME_PATH: chromium.executablePath(),
};
Object.assign(process.env, ENV);

const boards = await import("../src/board/store.js");
const core = await import("../src/board/core.js");
const { encodePng } = await import("../src/util/png.js");

// ---------------------------------------------------------------------------------------------
// Pictures: photo-like (smooth colour with grain, so they cost what photos cost to draw) and avatars.

function photo(file: string, w: number, h: number, seed: number) {
  const rgba = Buffer.alloc(w * h * 4);
  let s = seed * 9301 + 49297;
  const rnd = () => ((s = (s * 9301 + 49297) % 233280) / 233280);
  const [a, b, c] = [rnd() * 255, rnd() * 255, rnd() * 255];
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const n = (rnd() - 0.5) * 40;
      const u = x / w, v = y / h;
      rgba[i] = Math.max(0, Math.min(255, a * (1 - u) + 200 * u * v + n));
      rgba[i + 1] = Math.max(0, Math.min(255, b * (1 - v) + 120 * u + n));
      rgba[i + 2] = Math.max(0, Math.min(255, c * v + 180 * (1 - u) * (1 - v) + n));
      rgba[i + 3] = 255;
    }
  writeFileSync(file, encodePng({ width: w, height: h, rgba }));
}
const PHOTOS = [0, 1, 2, 3, 4, 5].map((i) => path.join(LIB, "images", `photo-${i}.png`));
const AVATARS = [0, 1, 2, 3, 4, 5].map((i) => path.join(LIB, "images", `avatar-${i}.png`));
PHOTOS.forEach((f, i) => photo(f, 1200, 800, i + 1));
AVATARS.forEach((f, i) => photo(f, 160, 160, i + 11));
const CLIP = path.join(LIB, "clip.mp4");
copyFileSync(path.join(ROOT, "scripts", "fixtures", "clip.mp4"), CLIP);

// ---------------------------------------------------------------------------------------------
// The designs

const SANS = "'Helvetica Neue', Helvetica, sans-serif";
const SERIF = "Georgia, serif";
const words = ["Design", "systems", "that", "ship", "faster", "with", "every", "team", "on", "one", "canvas", "built", "for", "agents", "and", "people", "together"];
const sentence = (n: number, k: number) => Array.from({ length: n }, (_, i) => words[(i * 7 + k * 3) % words.length]).join(" ").replace(/^./, (c) => c.toUpperCase()) + ".";
const icon = (c: string, k = 0) =>
  k % 3 === 0
    ? `<svg width="24" height="24" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10" stroke="${c}" stroke-width="2"/><path d="M8 12l3 3 5-6" stroke="${c}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`
    : k % 3 === 1
      ? `<svg width="24" height="24" viewBox="0 0 24 24" fill="none"><rect x="3" y="3" width="18" height="18" rx="5" stroke="${c}" stroke-width="2"/><path d="M8 15l4-6 4 6" stroke="${c}" stroke-width="2" stroke-linejoin="round"/></svg>`
      : `<svg width="24" height="24" viewBox="0 0 24 24" fill="none"><path d="M12 2l3 7h7l-5.5 4.5L18 21l-6-4-6 4 1.5-7.5L2 9h7z" stroke="${c}" stroke-width="2" stroke-linejoin="round"/></svg>`;
const shadow = "0 1px 2px rgba(16,24,40,0.06), 0 12px 32px -8px rgba(16,24,40,0.18)";

function nav(k: number) {
  return `<div data-name="Nav" style="display:flex;align-items:center;justify-content:space-between;padding:20px 64px;border-bottom:1px solid #eceef2">
    <div style="display:flex;align-items:center;gap:10px">${icon("#5b5bd6", k)}<span style="font-size:18px;font-weight:700">Northwind</span></div>
    <div style="display:flex;gap:28px">${["Product", "Solutions", "Pricing", "Customers", "Docs", "Blog"].map((t) => `<span style="font-size:15px;color:#4b5563">${t}</span>`).join("")}</div>
    <div style="padding:10px 18px;border-radius:10px;background:#111827;color:#fff;font-size:14px;font-weight:600;box-shadow:${shadow}">Get started</div></div>`;
}
function hero(k: number, { shader = false, badge = true } = {}) {
  const inner = `<div style="display:flex;flex-direction:column;gap:24px;width:560px">
      <span style="align-self:flex-start;padding:6px 12px;border-radius:999px;background:rgba(91,91,214,0.12);color:#5b5bd6;font-size:13px;font-weight:600">New · Version ${k + 2}.0</span>
      <h1 style="margin:0;font:700 64px/1.05 ${SANS};letter-spacing:-0.03em">${sentence(5, k)}</h1>
      <p style="margin:0;font-size:19px;line-height:1.6;color:#4b5563">${sentence(24, k + 1)}</p>
      <div style="display:flex;gap:12px"><div style="padding:14px 22px;border-radius:12px;background:linear-gradient(180deg,#6e6ef5,#4f46e5);color:#fff;font-weight:600;box-shadow:0 8px 24px rgba(79,70,229,0.35)">Start free trial</div><div style="padding:14px 22px;border-radius:12px;background:#fff;border:1px solid #e5e7eb;font-weight:600">Book a demo</div></div></div>
    <img src="${PHOTOS[k % 6]}" style="width:600px;height:400px;object-fit:cover;border-radius:24px;box-shadow:0 30px 60px -12px rgba(0,0,0,0.35)" />
    ${badge ? `<div data-name="Badge ${k}" style="position:absolute;left:660px;top:56px;display:flex;align-items:center;gap:8px;padding:10px 16px;border-radius:999px;background:#111827;color:#fff;font-size:14px;font-weight:600;box-shadow:0 10px 30px rgba(0,0,0,0.25)">${icon("#a5b4fc", 2)}<span>Rated 4.9 by teams</span></div>` : ""}`;
  const style = `display:flex;align-items:center;justify-content:space-between;gap:48px;padding:96px 64px;position:relative;background:linear-gradient(135deg,#f5f3ff 0%,#e0f2fe 60%,#fdf2f8 100%)`;
  return shader ? `<div data-name="Hero" data-shader="mesh-gradient" style="${style}">${inner}</div>` : `<div data-name="Hero" style="${style}">${inner}</div>`;
}
function logos(k: number) {
  return `<div data-name="Logos ${k}" style="display:flex;justify-content:space-between;padding:40px 64px;border-top:1px solid #f1f2f4;border-bottom:1px solid #f1f2f4">${Array.from({ length: 8 }, (_, i) => `<div style="display:flex;align-items:center;gap:8px;opacity:0.7">${icon("#6b7280", i)}<span style="font-size:17px;font-weight:700;color:#6b7280">${["Acme", "Globex", "Initech", "Umbrella", "Hooli", "Stark", "Wayne", "Tyrell"][i]}</span></div>`).join("")}</div>`;
}
function features(k: number) {
  const card = (i: number) => `<div style="display:flex;flex-direction:column;gap:12px;padding:28px;border-radius:18px;background:#fff;box-shadow:${shadow};border:1px solid #f0f1f4">
    <div style="width:44px;height:44px;border-radius:12px;display:flex;align-items:center;justify-content:center;background:linear-gradient(135deg,#eef2ff,#e0e7ff)">${icon("#4f46e5", i)}</div>
    <h3 style="margin:0;font-size:20px;font-weight:650">${sentence(3, i + k)}</h3>
    <p style="margin:0;font-size:15px;line-height:1.6;color:#6b7280">${sentence(18, i * 2 + k)}</p>
    <span style="font-size:14px;font-weight:600;color:#4f46e5">Learn more →</span></div>`;
  return `<div data-name="Features ${k}" style="display:flex;flex-direction:column;gap:40px;padding:96px 64px;background:#f9fafb">
    <div style="display:flex;flex-direction:column;gap:12px;align-items:center"><h2 style="margin:0;font:700 44px/1.1 ${SANS};letter-spacing:-0.02em">${sentence(6, k + 5)}</h2><p style="margin:0;font-size:18px;color:#6b7280">${sentence(14, k + 2)}</p></div>
    <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:24px">${Array.from({ length: 9 }, (_, i) => card(i)).join("")}</div></div>`;
}
function gallery(k: number) {
  return `<div data-name="Gallery ${k}" style="display:grid;grid-template-columns:repeat(3,1fr);gap:20px;padding:64px">${Array.from({ length: 6 }, (_, i) => `<img src="${PHOTOS[(i + k) % 6]}" style="width:100%;height:280px;object-fit:cover;border-radius:16px" />`).join("")}</div>`;
}
function testimonials(k: number) {
  const card = (i: number) => `<div style="display:flex;flex-direction:column;gap:16px;padding:28px;border-radius:18px;background:#fff;box-shadow:${shadow}">
    <p style="margin:0;font:400 18px/1.6 ${SERIF};color:#111827">“${sentence(22, i + k)}”</p>
    <div style="display:flex;align-items:center;gap:12px"><img src="${AVATARS[(i + k) % 6]}" style="width:44px;height:44px;border-radius:999px;object-fit:cover" />
    <div style="display:flex;flex-direction:column"><b style="font-size:15px">${["Ada Park", "Lena Ortiz", "Sam Okafor"][i]}</b><span style="font-size:13px;color:#6b7280">Design lead, ${["Acme", "Globex", "Hooli"][i]}</span></div></div></div>`;
  return `<div data-name="Testimonials ${k}" style="display:grid;grid-template-columns:repeat(3,1fr);gap:24px;padding:96px 64px;background:linear-gradient(180deg,#fff,#f5f3ff)">${[0, 1, 2].map(card).join("")}</div>`;
}
function pricing(k: number) {
  const card = (i: number) => `<div style="display:flex;flex-direction:column;gap:20px;padding:32px;border-radius:20px;background:${i === 1 ? "#111827" : "#fff"};color:${i === 1 ? "#fff" : "#111827"};box-shadow:${shadow};border:1px solid #eceef2">
    <span style="font-size:15px;font-weight:600;opacity:0.8">${["Starter", "Team", "Enterprise"][i]}</span>
    <div style="display:flex;align-items:baseline;gap:4px"><span style="font-size:48px;font-weight:700;letter-spacing:-0.02em">$${[12, 39, 99][i]}</span><span style="font-size:15px;opacity:0.6">/ month</span></div>
    <div style="display:flex;flex-direction:column;gap:12px">${Array.from({ length: 6 }, (_, j) => `<div style="display:flex;align-items:center;gap:10px">${icon(i === 1 ? "#a5b4fc" : "#4f46e5", 0)}<span style="font-size:15px">${sentence(4, j + i + k)}</span></div>`).join("")}</div>
    <div style="padding:14px;border-radius:12px;text-align:center;font-weight:600;background:${i === 1 ? "#fff" : "#111827"};color:${i === 1 ? "#111827" : "#fff"}">Choose ${["Starter", "Team", "Enterprise"][i]}</div></div>`;
  return `<div data-name="Pricing ${k}" style="display:grid;grid-template-columns:repeat(3,1fr);gap:24px;padding:96px 64px">${[0, 1, 2].map(card).join("")}</div>`;
}
function blog(k: number) {
  const card = (i: number) => `<div style="display:flex;flex-direction:column;gap:12px">
    <img src="${PHOTOS[(i + k + 2) % 6]}" style="width:100%;height:200px;object-fit:cover;border-radius:14px" />
    <span style="font-size:12px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:#4f46e5">${["Guides", "Product", "Stories"][i % 3]}</span>
    <h4 style="margin:0;font-size:20px;line-height:1.3">${sentence(8, i + k)}</h4>
    <p style="margin:0;font-size:15px;line-height:1.6;color:#6b7280">${sentence(16, i + k + 1)}</p>
    <div style="display:flex;align-items:center;gap:8px"><img src="${AVATARS[i % 6]}" style="width:28px;height:28px;border-radius:999px" /><span style="font-size:13px;color:#6b7280">May ${i + 3}, 2026</span></div></div>`;
  return `<div data-name="Blog ${k}" style="display:grid;grid-template-columns:repeat(3,1fr);gap:32px;padding:64px">${Array.from({ length: 6 }, (_, i) => card(i)).join("")}</div>`;
}
function faq(k: number) {
  return `<div data-name="FAQ ${k}" style="display:flex;flex-direction:column;padding:96px 240px">${Array.from({ length: 8 }, (_, i) => `<div style="display:flex;flex-direction:column;gap:8px;padding:20px 0;border-bottom:1px solid #eceef2"><h4 style="margin:0;font-size:18px">${sentence(7, i + k)}?</h4><p style="margin:0;font-size:15px;line-height:1.6;color:#6b7280">${sentence(26, i + k + 3)}</p></div>`).join("")}</div>`;
}
function footer(k: number) {
  return `<div data-name="Footer ${k}" style="display:flex;flex-direction:column;gap:40px;padding:64px;background:#0b0d12;color:#e5e7eb">
    <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:24px">${[0, 1, 2, 3].map((c) => `<div style="display:flex;flex-direction:column;gap:10px"><b style="font-size:14px;color:#fff">${["Product", "Company", "Resources", "Legal"][c]}</b>${Array.from({ length: 6 }, (_, j) => `<span style="font-size:14px;color:#9ca3af">${sentence(2, c + j)}</span>`).join("")}</div>`).join("")}</div>
    <span style="font-size:13px;color:#6b7280">© 2026 Northwind, Inc.</span></div>`;
}
function videoSection(k: number) {
  return `<div data-name="Video section ${k}" style="padding:64px;background:#0b0d12"><video data-name="Video" src="${CLIP}" style="width:100%;height:560px;object-fit:cover;border-radius:24px"></video></div>`;
}

function desktop(k: number, at: { x: number; y: number }) {
  return `<div data-name="Desktop ${k}" style="left:${at.x}px;top:${at.y}px;width:1440px;display:flex;flex-direction:column;background:#fff;font-family:${SANS};color:#111827;overflow:hidden">
    ${nav(k)}${hero(k, { shader: k % 6 === 0 })}${logos(k)}${features(k)}${k % 6 === 1 ? videoSection(k) : gallery(k)}${testimonials(k)}${pricing(k)}${faq(k)}${footer(k)}</div>`;
}
function phone(k: number, at: { x: number; y: number }) {
  const row = (i: number) => `<div style="display:flex;align-items:center;gap:12px;padding:12px 16px;border-radius:14px;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,0.06)">
    <img src="${AVATARS[(i + k) % 6]}" style="width:40px;height:40px;border-radius:12px;object-fit:cover" />
    <div style="display:flex;flex-direction:column;gap:2px;flex:1"><span style="font-size:15px;font-weight:600">${sentence(2, i + k)}</span><span style="font-size:13px;color:#6b7280">${sentence(5, i * 3 + k)}</span></div>
    ${icon("#9ca3af", i)}</div>`;
  return `<div data-name="Phone ${k}" style="left:${at.x}px;top:${at.y}px;width:390px;height:844px;display:flex;flex-direction:column;background:${k % 2 ? "#f2f2f7" : "linear-gradient(180deg,#eef2ff,#f8fafc)"};font-family:${SANS};color:#111827;overflow:hidden;border-radius:0">
    <div style="display:flex;justify-content:space-between;align-items:center;padding:14px 24px"><span style="font-size:15px;font-weight:600">9:41</span><div style="display:flex;gap:6px">${icon("#111", 1)}${icon("#111", 2)}</div></div>
    <div style="display:flex;flex-direction:column;gap:12px;padding:8px 16px 12px"><h1 style="margin:0;font-size:32px;font-weight:700">${["Inbox", "Today", "Library", "Explore", "Friends"][k % 5]}</h1>
      <div style="display:flex;align-items:center;gap:8px;padding:10px 12px;border-radius:12px;background:rgba(118,118,128,0.12)">${icon("#8e8e93", 0)}<span style="font-size:15px;color:#8e8e93">Search</span></div></div>
    <div style="display:flex;flex-direction:column;gap:8px;padding:0 12px;flex:1">${Array.from({ length: 10 }, (_, i) => row(i)).join("")}</div>
    <div style="display:flex;justify-content:space-around;padding:10px 0 28px;background:rgba(255,255,255,0.92);border-top:1px solid #e5e7eb">${Array.from({ length: 5 }, (_, i) => `<div style="display:flex;flex-direction:column;align-items:center;gap:4px">${icon(i === 0 ? "#4f46e5" : "#9ca3af", i)}<span style="font-size:10px;color:${i === 0 ? "#4f46e5" : "#9ca3af"}">${["Home", "Search", "Add", "Inbox", "Me"][i]}</span></div>`).join("")}</div></div>`;
}
function website(at: { x: number; y: number }) {
  const blocks = Array.from({ length: STRESS ? 20 : 8 }, (_, k) => k).map((k) => `${features(k + 10)}${testimonials(k + 10)}${k % 2 ? pricing(k + 10) : blog(k + 10)}`).join("");
  return `<div data-name="Website" style="left:${at.x}px;top:${at.y}px;width:1440px;display:flex;flex-direction:column;background:#fff;font-family:${SANS};color:#111827">
    ${nav(9)}${hero(9, { badge: true })}${logos(9)}${blocks}${gallery(9)}${faq(9)}${footer(9)}</div>`;
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

// Each set: a row of 6 desktop pages with a row of 10 phones under it (--stress stacks 3 sets).
const screens = makeBoard("Bench: screens", Array.from({ length: SETS }, (_, r) => [
  ...[0, 1, 2, 3, 4, 5].map((k) => desktop(r * 6 + k, { x: k * 1640, y: r * 7200 })),
  ...[0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((k) => phone(r * 10 + k, { x: k * 490, y: r * 7200 + 5600 })),
]).flat());
const site = makeBoard("Bench: website", [website({ x: 0, y: 0 })]);

// ---------------------------------------------------------------------------------------------
// The engine, as its own process

async function freePort() {
  return new Promise<number>((done) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => done(p));
    });
  });
}
if (!existsSync(path.join(ROOT, "dist", "index.js"))) throw new Error("Build first: npm run build");
const port = await freePort();
const engine: ChildProcess = spawn(process.execPath, [path.join(ROOT, "dist", "index.js"), "studio", "--port", String(port), "--no-open"], { env: { ...process.env, ...ENV }, stdio: ["ignore", "ignore", "pipe"] });
let engineErr = "";
engine.stderr?.on("data", (d) => (engineErr += d));
const BASE = `http://127.0.0.1:${port}/`;
for (let i = 0; ; i++) {
  try {
    if ((await fetch(BASE + "api/options")).ok) break;
  } catch {}
  if (i > 100) throw new Error(`The engine didn't start: ${engineErr}`);
  await new Promise((r) => setTimeout(r, 100));
}

// ---------------------------------------------------------------------------------------------
// Measuring frames in the page

const RECORDER = `(() => {
  // tsx names inner functions with a helper the page doesn't have.
  globalThis.__name = globalThis.__name || ((f) => f);
  const b = (window.__bench = { on: false, gen: 0, frames: [], long: [] });
  b.start = () => {
    b.frames = []; b.long = []; b.on = true;
    // Each run has its own loop: one left over from the last run stops instead of counting twice.
    const gen = ++b.gen;
    const f = (t) => { if (!b.on || gen !== b.gen) return; b.frames.push(t); requestAnimationFrame(f); };
    requestAnimationFrame(f);
  };
  b.stop = () => { b.on = false; b.gen++; return { frames: b.frames, long: b.long }; };
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
  trace?: Record<string, number>;
}

const FRAME = 1000 / 60;
function summarize(ts: number[], long: number[]): Result {
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

type Ctx = { page: Page; browser: Browser; engine: EngineName };
type Scenario = { name: string; board: "screens" | "website"; prep: (c: Ctx) => Promise<void>; run: (c: Ctx) => Promise<void>; after?: (c: Ctx) => Promise<void> };

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
async function ceiling(page: Page, kind: "pan" | "zoom", willChange: boolean, frames = 150) {
  await E(page, async ({ kind, willChange, frames }: { kind: string; willChange: boolean; frames: number }) => {
    const w = document.querySelector(".bd-world") as HTMLElement;
    const t0 = w.style.transform;
    const m = /translate\(([-\d.e]+)px, ([-\d.e]+)px\) scale\(([-\d.e]+)\)/.exec(t0)!;
    const [x, y, z] = [Number(m[1]), Number(m[2]), Number(m[3])];
    const c = document.querySelector(".bd-canvas")!.getBoundingClientRect();
    if (willChange) w.style.willChange = "transform";
    await new Promise<void>((done) => {
      let i = 0;
      const f = () => {
        i++;
        if (kind === "pan") w.style.transform = `translate(${x + 160 * Math.sin(i / 15)}px, ${y + 100 * (1 - Math.cos(i / 15))}px) scale(${z})`;
        else {
          const k = Math.exp(1.2 * Math.sin((i / frames) * Math.PI * 2));
          const cx = c.width / 2, cy = c.height / 2;
          w.style.transform = `translate(${cx - (cx - x) * k}px, ${cy - (cy - y) * k}px) scale(${z * k})`;
        }
        if (i < frames) requestAnimationFrame(f);
        else done();
      };
      requestAnimationFrame(f);
    });
    w.style.transform = t0;
    w.style.willChange = "";
  }, { kind, willChange, frames });
}

const SCENARIOS: Scenario[] = [
  { name: "idle", board: "screens", prep: ({ page }) => setup(page, { view: "fit" }), run: () => sleep(1500) },
  { name: "pan: trackpad (all in view)", board: "screens", prep: ({ page }) => setup(page, { view: "fit" }), run: ({ page }) => wheelPan(page) },
  { name: "pan: trackpad (50%)", board: "screens", prep: ({ page }) => setup(page, { view: WORK }), run: ({ page }) => wheelPan(page) },
  { name: "pan: space-drag (50%)", board: "screens", prep: ({ page }) => setup(page, { view: WORK }), run: async ({ page }) => dragPath(page, await center(page), { x: -5, y: -3 }, 90, { space: true }) },
  { name: "zoom: pinch (ctrl+wheel)", board: "screens", prep: ({ page }) => setup(page, { view: "fit" }), run: ({ page }) => pinch(page) },
  { name: "zoom: ⌘+ / ⌘− (animated)", board: "screens", prep: ({ page }) => setup(page, { view: WORK }), run: ({ page }) => keyZoom(page) },
  {
    name: "zoom: to fit / to selection",
    board: "screens",
    prep: ({ page }) => setup(page, { view: WORK, sel: [screens.byName("Phone 3")] }),
    run: async ({ page }) => {
      for (let i = 0; i < 2; i++) {
        await page.keyboard.press("Shift+Digit1");
        await sleep(450);
        await page.keyboard.press("Shift+Digit2");
        await sleep(450);
      }
    },
  },
  { name: "ceiling: pan (all in view)", board: "screens", prep: ({ page }) => setup(page, { view: "fit" }), run: ({ page }) => ceiling(page, "pan", false) },
  { name: "ceiling: zoom, redrawn (all)", board: "screens", prep: ({ page }) => setup(page, { view: "fit" }), run: ({ page }) => ceiling(page, "zoom", false) },
  { name: "ceiling: zoom, will-change (all)", board: "screens", prep: ({ page }) => setup(page, { view: "fit" }), run: ({ page }) => ceiling(page, "zoom", true) },
  {
    name: "click to select",
    board: "screens",
    prep: ({ page }) => setup(page, { view: WORK }),
    run: async ({ page }) => {
      for (const p of await clickTargets(page, 12)) {
        await page.mouse.click(p.x, p.y);
        await sleep(160);
      }
    },
  },
  {
    name: "hover across layers",
    board: "screens",
    prep: ({ page }) => setup(page, { view: WORK }),
    run: async ({ page }) => {
      const c = await canvasBox(page);
      await paced(150, (i) => page.mouse.move(c.x + 30 + ((i % 30) / 30) * (c.width - 60), c.y + 60 + (Math.floor(i / 30) / 5) * (c.height - 120) + (i % 30) * 3));
    },
  },
  {
    name: "drag an artboard",
    board: "screens",
    prep: ({ page }) => setup(page, { view: WORK }),
    run: async ({ page }) => {
      const l = await E<Box, string>(page, (id) => {
        const r = document.querySelector(`[data-label="${id}"]`)!.getBoundingClientRect();
        return { x: r.x, y: r.y, width: r.width, height: r.height };
      }, screens.byName("Desktop 0"));
      await dragPath(page, { x: l.x + 20, y: l.y + l.height / 2 }, { x: 3, y: 2 });
    },
    after: ({ page }) => undo(page),
  },
  {
    name: "drag a layer",
    board: "screens",
    prep: ({ page }) => setup(page, { view: WORK }),
    run: async ({ page }) => {
      const b = (await boxOf(page, screens.byName("Badge 0")))!;
      await dragPath(page, { x: b.x + 10, y: b.y + b.height / 2 }, { x: 3, y: 2 });
    },
    after: ({ page }) => undo(page),
  },
  {
    name: "drag to reorder (flex)",
    board: "screens",
    prep: ({ page }) => setup(page, { view: WORK }),
    run: async ({ page }) => {
      const b = (await boxOf(page, screens.byName("Logos 0")))!;
      await dragPath(page, { x: b.x + 30, y: b.y + b.height / 2 }, { x: 0, y: 4 });
    },
    after: ({ page }) => undo(page),
  },
  {
    name: "resize with a handle",
    board: "screens",
    prep: ({ page }) => setup(page, { view: WORK, sel: [screens.byName("Badge 0")] }),
    run: async ({ page }) => {
      const h = (await page.locator(".bd-handle.h-se").first().boundingBox())!;
      await dragPath(page, { x: h.x + h.width / 2, y: h.y + h.height / 2 }, { x: 3, y: 1 });
    },
    after: ({ page }) => undo(page),
  },
  { name: "site: idle", board: "website", prep: ({ page }) => setup(page, { view: SITE_VIEW }), run: () => sleep(1500) },
  { name: "site: scroll (trackpad)", board: "website", prep: ({ page }) => setup(page, { view: SITE_VIEW }), run: ({ page }) => wheelScroll(page) },
  { name: "site: pinch (ctrl+wheel)", board: "website", prep: ({ page }) => setup(page, { view: SITE_VIEW }), run: ({ page }) => pinch(page, 50, 3) },
  { name: "site: zoom to fit", board: "website", prep: ({ page }) => setup(page, { view: SITE_VIEW }), run: async ({ page }) => {
    for (let i = 0; i < 2; i++) {
      await page.keyboard.press("Shift+Digit1");
      await sleep(450);
      await page.keyboard.press("Shift+Digit0");
      await sleep(450);
    }
  } },
  { name: "site ceiling: zoom, redrawn", board: "website", prep: ({ page }) => setup(page, { view: SITE_VIEW }), run: ({ page }) => ceiling(page, "zoom", false) },
  {
    name: "site: click to select",
    board: "website",
    prep: ({ page }) => setup(page, { view: SITE_VIEW }),
    run: async ({ page }) => {
      for (const p of await clickTargets(page, 12)) {
        await page.mouse.click(p.x, p.y);
        await sleep(160);
      }
    },
  },
  {
    name: "site: hover",
    board: "website",
    prep: ({ page }) => setup(page, { view: SITE_VIEW }),
    run: async ({ page }) => {
      const c = await canvasBox(page);
      await paced(150, (i) => page.mouse.move(c.x + 30 + ((i % 30) / 30) * (c.width - 60), c.y + 60 + (Math.floor(i / 30) / 5) * (c.height - 120) + (i % 30) * 3));
    },
  },
  {
    name: "site: drag a layer",
    board: "website",
    prep: ({ page }) => setup(page, { view: SITE_VIEW }),
    run: async ({ page }) => {
      const b = (await boxOf(page, site.byName("Badge 9")))!;
      await dragPath(page, { x: b.x + 10, y: b.y + b.height / 2 }, { x: 3, y: 2 });
    },
    after: ({ page }) => undo(page),
  },
  {
    name: "site: resize with a handle",
    board: "website",
    prep: ({ page }) => setup(page, { view: SITE_VIEW, sel: [site.byName("Badge 9")] }),
    run: async ({ page }) => {
      const h = (await page.locator(".bd-handle.h-se").first().boundingBox())!;
      await dragPath(page, { x: h.x + h.width / 2, y: h.y + h.height / 2 }, { x: 3, y: 1 });
    },
    after: ({ page }) => undo(page),
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
const results: Results = {};
let failures = 0;

async function openBoardIn(page: Page, id: string) {
  await E(page, async (id: string) => (await import("/ui/board-state.js" as string)).openBoard(id), id);
  await page.waitForSelector(".bd-world [data-bid]");
  await sleep(1500);
}

try {
  for (const name of engines) {
    const browser = await ENGINES[name].launch(name === "chromium" ? { channel: "chromium", headless: !HEADED } : { headless: !HEADED });
    const context: BrowserContext = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, colorScheme: "dark" });
    await context.addInitScript(RECORDER);
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(BASE, { waitUntil: "networkidle" });
    await sleep(500);
    results[name] = {};
    let open = "";
    console.log(`\n${name} (${screens.layers} + ${site.layers} layers)`);
    console.log(`${"interaction".padEnd(34)} ${"fps".padStart(5)} ${"p50".padStart(6)} ${"p95".padStart(6)} ${"max".padStart(6)} ${"drop".padStart(5)} ${"slow".padStart(5)}  long tasks${TRACE ? "   main-thread ms (trace)" : ""}`);
    for (const sc of SCENARIOS) {
      if (only && !only.test(sc.name)) continue;
      const boardId = sc.board === "screens" ? screens.id : site.id;
      if (open !== boardId) {
        await openBoardIn(page, boardId);
        open = boardId;
      }
      const runs: Result[] = [];
      try {
        for (let round = 0; round < ROUNDS; round++) {
          const ctx = { page, browser, engine: name };
          await sc.prep(ctx);
          if (TRACE && name === "chromium") await browser.startTracing(page, { categories: TRACE_CATS });
          await E(page, () => (window as unknown as { __bench: { start(): void } }).__bench.start());
          await sc.run(ctx);
          await sleep(120);
          const raw = await E<{ frames: number[]; long: number[] }, void>(page, () => (window as unknown as { __bench: { stop(): { frames: number[]; long: number[] } } }).__bench.stop());
          const r = summarize(raw.frames, raw.long);
          if (TRACE && name === "chromium") r.trace = traceSummary(await browser.stopTracing());
          runs.push(r);
          await sc.after?.(ctx);
        }
      } catch (e) {
        await E(page, () => (window as unknown as { __bench: { stop(): void } }).__bench.stop()).catch(() => undefined);
        failures++;
        console.log(`${sc.name.padEnd(34)} failed: ${(e as Error).message.split("\n")[0]}`);
        continue;
      }
      // Several rounds: the median one by fps.
      const r = runs.sort((a, b) => a.fps - b.fps)[Math.floor(runs.length / 2)];
      results[name][sc.name] = r;
      const tr = r.trace ? "   " + Object.entries(r.trace).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(", ") : "";
      console.log(`${sc.name.padEnd(34)} ${String(r.fps).padStart(5)} ${String(r.p50).padStart(6)} ${String(r.p95).padStart(6)} ${String(r.max).padStart(6)} ${String(r.dropped).padStart(5)} ${String(r.slow).padStart(5)}  ${r.long ? `${r.long} (${r.longMs} ms)` : "-"}${tr}`);
    }
    if (errors.length) {
      failures++;
      console.log(`page errors: ${[...new Set(errors)].slice(0, 3).join(" | ")}`);
    }
    await browser.close();
  }
} finally {
  engine.kill("SIGTERM");
  rmSync(tmp, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------------------------
// Saving, and comparing with an earlier run

const outDir = path.join(ROOT, "docs", "perf");
mkdirSync(outDir, { recursive: true });
const file = path.join(outDir, `canvas-${label}.json`);
writeFileSync(file, JSON.stringify({ label, stress: STRESS, at: new Date().toISOString(), layers: { screens: screens.layers, website: site.layers }, viewport: "1440x900@2x", results }, null, 2) + "\n");
console.log(`\nSaved ${path.relative(ROOT, file)}`);

if (compareTo) {
  const old = JSON.parse(readFileSync(path.join(outDir, `canvas-${compareTo}.json`), "utf8")).results as Results;
  for (const name of Object.keys(results)) {
    if (!old[name]) continue;
    console.log(`\n${name}: fps ${compareTo} → ${label} (p95 ms)`);
    for (const [sc, r] of Object.entries(results[name])) {
      const o = old[name][sc];
      if (!o) continue;
      console.log(`${sc.padEnd(34)} ${String(o.fps).padStart(5)} → ${String(r.fps).padStart(5)}   (${o.p95} → ${r.p95})`);
    }
  }
}
process.exit(failures ? 1 : 0);
