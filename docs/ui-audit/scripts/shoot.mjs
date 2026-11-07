// Drive the scratch Studio in WebKit and take named screenshots.
// Usage: node shoot.mjs <steps.mjs>   — the steps module exports default async ({ page, shot, st, wait }) => {}
import { webkit, chromium } from "/Users/mac/Documents/screenshotter/node_modules/playwright/index.mjs";
import path from "node:path";
const OUT = "/private/tmp/claude-501/-Users-mac-Documents-screenshotter/d31ba984-670b-4646-b282-6d6fee6f787f/scratchpad/audit/shots";
const steps = (await import(path.resolve(process.argv[2]))).default;
const engine = process.env.ENGINE === "chromium" ? chromium : webkit;
const w = +(process.env.W ?? 1440), h = +(process.env.H ?? 900);
const kill = setTimeout(() => { console.error("timed out"); process.exit(2); }, +(process.env.TIMEOUT ?? 240000));
const browser = await engine.launch();
const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 2 });
if (process.env.NATIVE) await page.addInitScript(() => { window.webkit = { messageHandlers: { native: { postMessage() {} } } }; });
const errors = [];
page.on("pageerror", (e) => errors.push("pageerror " + e.message));
page.on("console", (m) => { if (m.type() === "error") errors.push("console " + m.text().slice(0, 200)); });
await page.goto("http://127.0.0.1:4790/", { waitUntil: "load" });
await page.waitForTimeout(2500);
const wait = (ms) => page.waitForTimeout(ms);
const shot = async (name, opts = {}) => { await page.screenshot({ path: path.join(OUT, name + ".png"), ...opts }); console.log("shot", name); };
const st = (patch) => page.evaluate(async (patch) => { const s = await import("/ui/store.js"); s.set(patch); s.scheduleLayout?.(0); }, patch);
try { await steps({ page, shot, st, wait }); } catch (e) { console.error("step failed:", e.message); await shot("_failed"); }
console.log(errors.length ? "errors:\n" + [...new Set(errors)].join("\n") : "no errors");
await browser.close();
clearTimeout(kill);
process.exit(0);
