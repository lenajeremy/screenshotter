/**
 * Edge-case regression checks for the rendering engine (no simulator needed except where noted).
 *
 *   npx tsx scripts/edge.ts
 */
import { mkdirSync, openSync, readSync, closeSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { closeBrowser } from "../src/render/browser.js";
import { createMockup } from "../src/render/mockup.js";
import { createVideo } from "../src/render/video.js";
import { resolveColor } from "../src/devices/resolve.js";
import { findModel } from "../src/devices/catalog.js";
import { outputPathFor } from "../src/util/files.js";
import { imageSize } from "../src/util/image.js";
import { renderHtml } from "../src/render/mockup.js";

const out = path.resolve(process.env.EDGE_OUT ?? "screenshots/edge");
mkdirSync(out, { recursive: true });

let failures = 0;
async function check(name: string, fn: () => Promise<unknown> | unknown) {
  try {
    const r = await fn();
    console.log(`PASS ${name}${r ? ` — ${String(r).slice(0, 140)}` : ""}`);
  } catch (e) {
    failures++;
    console.log(`FAIL ${name} — ${(e as Error).message.split("\n")[0].slice(0, 220)}`);
  }
}
const assert = (cond: unknown, msg: string) => {
  if (!cond) throw new Error(msg);
};
function magic(file: string): string {
  const fd = openSync(file, "r");
  const b = Buffer.alloc(12);
  readSync(fd, b, 0, 12, 0);
  closeSync(fd);
  if (b[0] === 0x89 && b[1] === 0x50) return "png";
  if (b[0] === 0xff && b[1] === 0xd8) return "jpeg";
  if (b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP") return "webp";
  if (b.toString("ascii", 0, 3) === "GIF") return "gif";
  return "unknown";
}

// A synthetic iPhone 17 Pro-sized screenshot so no simulator is required.
const shot = path.join(out, "synthetic-1206x2622.png");
if (!existsSync(shot)) {
  const rows = Array.from({ length: 10 }, (_, i) => `<div class="row"><span>Row number ${i + 1}</span></div>`).join("");
  await renderHtml(
    `<!doctype html><html><body style="margin:0;width:402px;height:874px;background:#f2f2f7;font:17px -apple-system"><div style="height:120px"></div><div style="margin:0 16px;background:#fff;border-radius:22px;overflow:hidden">${rows}</div><style>.row{height:52px;display:flex;align-items:center;padding:0 16px;border-bottom:1px solid #e5e5ea}</style></body></html>`,
    shot,
    402,
    874,
    { scale: 3, format: "png", transparent: false, outWidth: 1206, outHeight: 2622 },
  );
}
const landscapeShot = path.join(out, "synthetic-2622x1206.png");
if (!existsSync(landscapeShot)) {
  await renderHtml(`<!doctype html><body style="margin:0;background:linear-gradient(90deg,#f97316,#6366f1)"></body>`, landscapeShot, 874, 402, { scale: 3, format: "png", transparent: false, outWidth: 2622, outHeight: 1206 });
}

const base = { devices: [{ screenshot: shot }], quality: "preview" as const, preview: false };

await check("synthetic screenshot has the iPhone 17 Pro size", async () => {
  const s = await imageSize(shot);
  assert(s.width === 1206 && s.height === 2622, `${s.width}x${s.height}`);
});

for (const format of ["png", "jpeg", "webp"] as const) {
  await check(`final render as ${format} writes a real ${format} at the canvas size`, async () => {
    const r = await createMockup({ devices: [{ screenshot: shot }], format, canvas: "1:1", output: path.join(out, `fmt-${format}`) });
    assert(magic(r.path) === format, `file is ${magic(r.path)}`);
    const s = await imageSize(r.path).catch(() => ({ width: r.width, height: r.height }));
    assert(s.width === 2048 && s.height === 2048, `size ${s.width}x${s.height}`);
    return r.path;
  });
}

await check("output extension decides the format when format is omitted", async () => {
  const r = await createMockup({ ...base, output: path.join(out, "by-ext.jpg") });
  assert(magic(r.path) === "jpeg", `wrote ${magic(r.path)} to ${r.path}`);
});

await check("format wins over a conflicting output extension, and the extension is fixed", async () => {
  const r = await createMockup({ ...base, format: "jpeg", output: path.join(out, "conflict.png") });
  assert(magic(r.path) === "jpeg", `wrote ${magic(r.path)}`);
  assert(r.path.endsWith(".jpg"), `path ${r.path}`);
});

await check("deliveryWidth resizes the final image", async () => {
  const r = await createMockup({ devices: [{ screenshot: shot }], canvas: "1:1", deliveryWidth: 800, output: path.join(out, "delivery.png") });
  const s = await imageSize(r.path);
  assert(s.width === 800 && s.height === 800, `${s.width}x${s.height}`);
});

await check("misspelled look name is an error, not a blank background", async () => {
  let threw = false;
  try {
    await createMockup({ ...base, background: "meadow", output: path.join(out, "typo.jpg") });
  } catch (e) {
    threw = /look/i.test((e as Error).message);
  }
  assert(threw, "no error for unknown look 'meadow'");
});

await check("CSS colour and gradient strings still work as backgrounds", async () => {
  await createMockup({ ...base, background: "#0f172a", output: path.join(out, "css-hex.jpg") });
  await createMockup({ ...base, background: "navy", output: path.join(out, "css-named.jpg") });
  await createMockup({ ...base, background: "linear-gradient(160deg,#1e3a8a,#0f172a)", output: path.join(out, "css-grad.jpg") });
});

await check("a look with a photo override uses the photo", async () => {
  const photo = path.join(out, "photo.png");
  await renderHtml(`<!doctype html><body style="margin:0;background:#ff0000"></body>`, photo, 200, 200, { scale: 1, format: "png", transparent: false });
  process.env.SCREENSHOTTER_DEBUG_HTML = "1";
  const r = await createMockup({ ...base, background: { look: "midnight", photo }, output: path.join(out, "look-photo.jpg") });
  delete process.env.SCREENSHOTTER_DEBUG_HTML;
  const html = readFileSync(`${r.path}.html`, "utf8");
  assert(html.includes("photo.png"), "photo not used");
});

await check("blur: 1 is treated as 1px, not the whole canvas width", async () => {
  process.env.SCREENSHOTTER_DEBUG_HTML = "1";
  const r = await createMockup({ ...base, background: { photo: shot, blur: 1 }, output: path.join(out, "blur1.jpg") });
  delete process.env.SCREENSHOTTER_DEBUG_HTML;
  const html = readFileSync(`${r.path}.html`, "utf8");
  const m = /blur\(([\d.]+)px\)/.exec(html);
  assert(m && Number(m[1]) <= 1, `blur ${m?.[1]}px`);
});

await check("hex finish never matches a colour name by accident", () => {
  const model = findModel("iPhone 16 Pro")!;
  const c = resolveColor(model, "#eee");
  assert(c.id === "custom" && c.hex === "#eee", JSON.stringify(c));
});

await check("an existing directory with a dot in its name is used as a directory", () => {
  const dir = path.join(out, "my.folder");
  mkdirSync(dir, { recursive: true });
  const p = outputPathFor(dir, "x", "name", "png");
  assert(path.dirname(p) === dir, p);
});

await check("two outputs in the same millisecond get different names", () => {
  const a = outputPathFor(undefined, "collide", "same", "png");
  writeFileSync(a, "");
  const b = outputPathFor(undefined, "collide", "same", "png");
  assert(a !== b, `${a} === ${b}`);
});

await check("zero or negative device height is rejected by the schema", async () => {
  const { MockupInputSchema } = await import("../src/render/schema.js");
  const r = MockupInputSchema.safeParse({ devices: [{ screenshot: shot, height: 0 }] });
  assert(!r.success, "height 0 accepted");
});

await check("landscape capture renders with the device turned", async () => {
  const r = await createMockup({ devices: [{ screenshot: landscapeShot }], quality: "preview", preview: false, output: path.join(out, "landscape.jpg") });
  // A 1206 × 2622 capture with no metadata gets the newest phone with that screen.
  assert(r.devices[0].device === "iPhone 18 Pro", String(r.devices[0].device));
});

await check("stack layout keeps devices below the caption", async () => {
  const { computeLayout } = await import("../src/render/layouts.js");
  const l = computeLayout(undefined, 2560, 1440, ["mac", "iphone", "watch", "ipad"], true);
  const maxZ = Math.max(...l.devices.map((d) => d.z));
  assert(maxZ < 30, `max device z ${maxZ}`);
});

await check("video: zoom with end before start is rejected", async () => {
  let threw = false;
  try {
    await createVideo({ ...base, video: { duration: 1, zoom: { start: 2, end: 1 } }, output: path.join(out, "badzoom.mp4") } as any);
  } catch (e) {
    threw = /zoom/i.test((e as Error).message);
  }
  assert(threw, "no error");
});

await check("video: output extension decides the container", async () => {
  const r = await createVideo({ ...base, video: { duration: 1, fps: 12 }, output: path.join(out, "clip.gif") } as any);
  assert(magic(r.path) === "gif" && r.path.endsWith(".gif"), `${magic(r.path)} ${r.path}`);
});

await check("video: ffmpeg failure is reported, not a crash", async () => {
  const saved = process.env.PATH;
  let threw = false;
  try {
    process.env.PATH = "/nonexistent";
    await createVideo({ ...base, video: { duration: 1, fps: 12 }, output: path.join(out, "noffmpeg.mp4") } as any);
  } catch (e) {
    threw = true;
    return (e as Error).message;
  } finally {
    process.env.PATH = saved;
    assert(threw, "no error without ffmpeg");
  }
});

await check("simulator lock: a lock left by a dead process is cleared", async () => {
  const { withSimulatorLock } = await import("../src/simulator/simctl.js");
  const { cacheDir } = await import("../src/util/files.js");
  const dir = path.join(cacheDir("locks"), "simulator.lock");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "owner"), `999999 ${Date.now()}`);
  const t = Date.now();
  await withSimulatorLock(async () => undefined);
  assert(Date.now() - t < 2000, `took ${Date.now() - t}ms`);
});

await check("simulator lock: jobs in one process never overlap", async () => {
  const { withSimulatorLock } = await import("../src/simulator/simctl.js");
  let active = 0;
  let peak = 0;
  const job = () =>
    withSimulatorLock(async () => {
      peak = Math.max(peak, ++active);
      await new Promise((r) => setTimeout(r, 120));
      active--;
    });
  await Promise.all([job(), job(), job()]);
  assert(peak === 1, `peak ${peak}`);
});

await check("simulator lock: another process holding it makes us wait", async () => {
  const { spawn } = await import("node:child_process");
  const { withSimulatorLock } = await import("../src/simulator/simctl.js");
  const child = spawn(
    "npx",
    ["tsx", "-e", `import("./src/simulator/simctl.ts").then(m => m.withSimulatorLock(() => new Promise(r => { console.log("held"); setTimeout(r, 1500); })))`],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  await new Promise<void>((resolve) => child.stdout!.on("data", (d) => String(d).includes("held") && resolve()));
  const t = Date.now();
  await withSimulatorLock(async () => undefined);
  const waited = Date.now() - t;
  await new Promise((r) => child.on("exit", r));
  assert(waited >= 900, `only waited ${waited}ms`);
  return `waited ${waited}ms`;
});

await check("layout: entities list devices and caption with canvas-fraction positions", async () => {
  const { layoutScene } = await import("../src/render/mockup.js");
  const r = await layoutScene({ devices: [{ screenshot: shot }], headline: "Hello" } as any);
  const d = r.entities.find((e) => e.kind === "device")!;
  const c = r.entities.find((e) => e.kind === "caption")!;
  assert(d && c, "missing entities");
  assert(d.width > 0 && d.height > 0 && d.screen && d.screen.width > 0.8, JSON.stringify(d));
  return `device at ${d.x},${d.y} size ${d.width}x${d.height}; caption at ${c.x},${c.y}`;
});

await check("layout: an explicit device y is its centre, even in hero-bleed", async () => {
  const { layoutScene } = await import("../src/render/mockup.js");
  const r = await layoutScene({ devices: [{ screenshot: shot, x: 0.3, y: 0.4 }], layout: "hero-bleed", headline: "Hi" } as any);
  const d = r.entities.find((e) => e.kind === "device")!;
  assert(Math.abs(d.x - 0.3) < 0.001 && Math.abs(d.y - 0.4) < 0.001, `${d.x},${d.y}`);
});

await check("layout: textStyle.x/y place the caption exactly", async () => {
  const { layoutScene } = await import("../src/render/mockup.js");
  const r = await layoutScene({ devices: [{ screenshot: shot }], headline: "Hi", textStyle: { x: 0.2, y: 0.8, anchor: "bottom" } } as any);
  const c = r.entities.find((e) => e.kind === "caption")!;
  assert(c.x === 0.2 && c.y === 0.8 && c.anchor === "bottom", JSON.stringify(c));
});

await check("png encoder round-trips pixels exactly", async () => {
  const { encodePng, readBmp, frameDifference } = await import("../src/util/png.js");
  const { run } = await import("../src/util/exec.js");
  const w = 37, h = 23;
  const rgba = Buffer.alloc(w * h * 4);
  for (let i = 0; i < rgba.length; i++) rgba[i] = (i * 37 + (i >> 5)) & 0xff;
  for (let i = 3; i < rgba.length; i += 4) rgba[i] = 255;
  const png = path.join(out, "rt.png");
  writeFileSync(png, encodePng({ width: w, height: h, rgba }));
  await run("sips", ["-s", "format", "bmp", png, "--out", path.join(out, "rt.bmp")]);
  const back = readBmp(readFileSync(path.join(out, "rt.bmp")));
  assert(frameDifference(back, { width: w, height: h, rgba }, 1) === 0, "pixels differ");
});

await check("3D tilt at full size keeps the screen and the whole background (no dropped layers)", async () => {
  // A tilted device is a stack of composited layers rendered at 2x; when Chrome ran out of
  // graphics memory it silently dropped some: black screens, white holes in the background.
  const { readBmp } = await import("../src/util/png.js");
  const { run } = await import("../src/util/exec.js");
  const file = path.join(out, "tilt-3d.png");
  await createMockup({
    devices: [{ screenshot: shot, rotateX: 15, x: 0.5, y: 0.6, anchor: "center", height: 0.79, shadow: "strong" }],
    background: { type: "mesh", colors: ["#0b4709", "#2a1054", "#690e1f", "#895b18"], meshStyle: "aurora" },
    effects: { grain: 0.5, vignette: 0.26, edgeBlur: true, grade: "cinematic" },
    headline: "Tilted",
    preview: false,
    output: file,
  });
  await run("sips", ["-s", "format", "bmp", file, "--out", path.join(out, "tilt-3d.bmp")]);
  const img = readBmp(readFileSync(path.join(out, "tilt-3d.bmp")));
  const at = (fx: number, fy: number) => {
    const i = (Math.round(fy * (img.height - 1)) * img.width + Math.round(fx * (img.width - 1))) * 4;
    return (img.rgba[i] + img.rgba[i + 1] + img.rgba[i + 2]) / 3;
  };
  // The synthetic screenshot is light grey and white; the background is a dark mesh.
  assert(at(0.5, 0.62) > 170, `screen is dark (${at(0.5, 0.62).toFixed(0)}): the screenshot layer was dropped`);
  for (const [fx, fy] of [[0.95, 0.5], [0.95, 0.9], [0.05, 0.9], [0.5, 0.05]]) {
    assert(at(fx, fy) < 150, `background at ${fx},${fy} is bright (${at(fx, fy).toFixed(0)}): a background layer was dropped`);
  }
});

await check("a MacBook shows a web page below a drawn menu bar; a full-screen Mac capture keeps its own", async () => {
  // Notched Macs never draw content under the notch: a page's nav would be hidden by it.
  const { readBmp } = await import("../src/util/png.js");
  const { run } = await import("../src/util/exec.js");
  const { layoutScene } = await import("../src/render/mockup.js");
  const page = path.join(out, "white-page-3024x1964.png");
  await renderHtml(`<!doctype html><body style="margin:0;background:#fff"></body>`, page, 1512, 982, { scale: 2, format: "png", transparent: false, outWidth: 3024, outHeight: 1964 });
  const sample = async (screenshot: string, name: string) => {
    const input = { devices: [{ screenshot, device: "MacBook Pro 14-inch" }], canvas: "2000x1400", layout: "floating", background: "#808080", preview: false } as never;
    const e = (await layoutScene(input)).entities[0];
    const file = path.join(out, `${name}.png`);
    await createMockup({ ...(input as object), output: file } as never);
    await run("sips", ["-s", "format", "bmp", file, "--out", path.join(out, `${name}.bmp`)]);
    const img = readBmp(readFileSync(path.join(out, `${name}.bmp`)));
    // Point in the screen: 12% across (clear of the notch), at a height given as a fraction of the screen.
    const at = (fy: number) => {
      const s = e.screen!;
      const x = (e.x - e.width / 2 + e.width * (s.x + s.width * 0.12)) * img.width;
      const y = (e.y - e.height / 2 + e.height * (s.y + s.height * fy)) * img.height;
      const i = (Math.round(y) * img.width + Math.round(x)) * 4;
      return (img.rgba[i] + img.rgba[i + 1] + img.rgba[i + 2]) / 3;
    };
    return { bar: e.menuBar, top: at(0.015), below: at(0.1) };
  };
  const web = await sample(page, "mac-web");
  assert(web.bar && web.bar > 0.03 && web.bar < 0.05, `menu-bar strip is ${web.bar}`);
  // A light page gets a light macOS menu bar (not the page itself, and not a black strip).
  assert(web.top > 120 && web.top < 250, `the menu bar beside the notch should be drawn light, got ${web.top.toFixed(0)}`);
  assert(web.below > 225, `the page should start below the strip, got ${web.below.toFixed(0)}`);
  const full = path.join(out, "mac-fullscreen-3024x1964.png");
  writeFileSync(full, readFileSync(page));
  writeFileSync(`${full}.json`, JSON.stringify({ kind: "mac", scale: 2, width: 3024, height: 1964 }));
  const screen = await sample(full, "mac-full");
  assert(!screen.bar && screen.top > 225, `a full-screen Mac capture should fill the screen (strip ${screen.bar}, top ${screen.top.toFixed(0)})`);
});

await check("iPhone 18 Pro renders in its own finishes, front and back", async () => {
  for (const [color, side] of [["Burgundy", "front"], ["Glacier", "back"]] as const) {
    const r = await createMockup({ ...base, devices: [{ screenshot: shot, device: "iPhone 18 Pro", color, side, rotateY: -20 }], output: path.join(out, `18pro-${side}.jpg`) } as never);
    assert(r.devices[0].device === "iPhone 18 Pro", `${side}: ${r.devices[0].device}`);
  }
});

await check("an installed product bezel frames the screenshot (edge from the art, screen in its opening)", async () => {
  const { readBmp } = await import("../src/util/png.js");
  const { run } = await import("../src/util/exec.js");
  const dir = path.join(out, "bezels", "iPhone 17 Pro");
  mkdirSync(dir, { recursive: true });
  // A stand-in bezel: a solid magenta device with a transparent rounded opening the size of the screen.
  await renderHtml(
    `<!doctype html><body style="margin:0;background:transparent"><div style="position:absolute;inset:0;border-radius:90px;background:#ff00ff;-webkit-mask:radial-gradient(#000 0 0) 0 0/100% 100% no-repeat, linear-gradient(#000 0 0) 40px 40px/402px 874px no-repeat;-webkit-mask-composite:xor"></div></body>`,
    path.join(dir, "iPhone 17 Pro - Silver - Portrait.png"),
    482,
    954,
    { scale: 1, format: "png", transparent: true, outWidth: 482, outHeight: 954 },
  );
  process.env.SCREENSHOTTER_BEZELS_DIR = path.join(out, "bezels");
  try {
    const file = path.join(out, "bezel.png");
    await createMockup({ devices: [{ screenshot: shot, device: "iPhone 17 Pro", color: "Silver" }], canvas: "600x1000", layout: "floating", background: "#000000", preview: false, output: file } as never);
    await run("sips", ["-s", "format", "bmp", file, "--out", path.join(out, "bezel.bmp")]);
    const img = readBmp(readFileSync(path.join(out, "bezel.bmp")));
    const at = (fx: number, fy: number) => {
      const i = (Math.round(fy * (img.height - 1)) * img.width + Math.round(fx * (img.width - 1))) * 4;
      return [img.rgba[i], img.rgba[i + 1], img.rgba[i + 2]];
    };
    // Somewhere on the left edge of the device is the art's magenta; the middle is the (light) screenshot.
    const edge = Array.from({ length: 60 }, (_, k) => at(0.05 + k * 0.004, 0.5)).find(([r, g, b]) => r > 200 && g < 60 && b > 200);
    assert(edge, "the bezel art isn't drawn");
    const mid = at(0.5, 0.5);
    assert(mid[0] > 200 && mid[1] > 200, `the screenshot isn't in the opening (${mid})`);
  } finally {
    delete process.env.SCREENSHOTTER_BEZELS_DIR;
  }
});

await check("Apple's art files are told apart by model, colour and orientation", async () => {
  const { classify } = await import("../src/render/bezels.js");
  const root = "/art";
  const is = (rel: string, model: string, color: string, landscape = false) => {
    const e = classify(path.join(root, rel), root);
    assert(e && e.model === model && e.color === color && e.landscape === landscape, `${rel} → ${JSON.stringify(e)}`);
  };
  is("PNG/MacBook Pro M5 16-inch Silver.png", "macbook-pro-16", "Silver");
  is("PNG/MacBook Pro M5 14-inch Space Black.png", "macbook-pro-14", "Space Black");
  is("PNG/iPhone 17 Pro Max/iPhone 17 Pro Max - Cosmic Orange - Landscape.png", "iphone-17-pro-max", "Cosmic Orange", true);
  is("PNG/iPhone 17 Pro/iPhone 17 Pro - Deep Blue - Portrait.png", "iphone-17-pro", "Deep Blue");
  is("PNG/iPhone 17/iPhone 17 - Mist Blue - Portrait.png", "iphone-17", "Mist Blue");
  is("PNG/iPhone 18 Pro/iPhone 18 Pro - Burgundy - Portrait.png", "iphone-18-pro", "Burgundy");
});

await check("a device with only a recording shows the recording's first frame", async () => {
  const { spawnSync } = await import("node:child_process");
  if (spawnSync("ffmpeg", ["-version"]).status !== 0) return;
  const clip = path.join(out, "red-clip.mp4");
  spawnSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=red:s=402x874:d=1", "-c:v", "libx264", "-pix_fmt", "yuv420p", clip]);
  const r = await createMockup({ devices: [{ video: clip, frame: "none" }], canvas: "500x1000", layout: "floating", background: "#000000", quality: "preview", format: "png", preview: false, output: path.join(out, "video-only.png") } as never);
  assert(r.width > 0, "no image");
});

await check("a trailing newline in text doesn't add an empty line", async () => {
  const { buildScene } = await import("../src/render/mockup.js");
  const html = (await buildScene({ devices: [{ screenshot: shot }], texts: [{ text: "LAUNCH\n" }], headline: "Title\n\n" } as never)).html;
  assert(!/LAUNCH<br>/.test(html) && !/Title<br>/.test(html), "trailing newline rendered as a line break");
});

await check("extra text takes its own star colour, else the headline's, else bold", async () => {
  const { buildScene } = await import("../src/render/mockup.js");
  const html = (await buildScene({
    devices: [{ screenshot: shot }],
    headline: "Head **line**",
    textStyle: { accentColor: "#ff00aa" },
    texts: [{ text: "Inherits **this**" }, { text: "Own **colour**", accentColor: "#00ccff" }],
  } as never)).html;
  assert(/color:#ff00aa">this</.test(html), "extra text didn't inherit the headline's star colour");
  assert(/color:#00ccff">colour</.test(html), "extra text's own star colour was ignored");
  const bold = (await buildScene({ devices: [{ screenshot: shot }], texts: [{ text: "Just **bold**" }] } as never)).html;
  assert(/<strong>bold<\/strong>/.test(bold), "without any star colour the words should be bold");
});

await check("process still alive after all of the above", () => statSync(out).isDirectory());

await closeBrowser();
console.log(`\n${failures ? `${failures} FAILED` : "ALL PASSED"}`);
process.exit(failures ? 1 : 0);
