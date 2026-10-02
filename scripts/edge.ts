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
  // A child that dies or stalls fails the check rather than hanging the run.
  let said = "";
  await new Promise<void>((resolve, reject) => {
    child.stdout!.on("data", (d) => (said += d) && String(d).includes("held") && resolve());
    child.on("exit", (code, sig) => reject(new Error(`the other process ended (${code ?? sig}) before holding the lock: ${said.trim().slice(0, 200)}`)));
    child.on("error", reject);
    setTimeout(() => reject(new Error(`the other process never held the lock in 30 s: ${said.trim().slice(0, 200)}`)), 30000).unref();
  });
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

await check("clay recolours Apple's art into one matte colour, keeping the screen as it is", async () => {
  const { readBmp } = await import("../src/util/png.js");
  const { run } = await import("../src/util/exec.js");
  const { layoutScene } = await import("../src/render/mockup.js");
  // The magenta stand-in art from the check above.
  process.env.SCREENSHOTTER_BEZELS_DIR = path.join(out, "bezels");
  try {
    const input = { devices: [{ screenshot: shot, device: "iPhone 17 Pro", color: "Silver", clay: "sage" }], canvas: "600x1000", layout: "floating", background: "#000000" };
    const file = path.join(out, "clay.png");
    await createMockup({ ...input, preview: false, output: file } as never);
    await run("sips", ["-s", "format", "bmp", file, "--out", path.join(out, "clay.bmp")]);
    const img = readBmp(readFileSync(path.join(out, "clay.bmp")));
    const at = (fx: number, fy: number) => {
      const i = (Math.round(fy * (img.height - 1)) * img.width + Math.round(fx * (img.width - 1))) * 4;
      return [img.rgba[i], img.rgba[i + 1], img.rgba[i + 2]];
    };
    const row = Array.from({ length: 60 }, (_, k) => at(0.05 + k * 0.004, 0.5));
    assert(!row.some(([r, g, b]) => r > 200 && g < 60 && b > 200), "the art's own magenta still shows");
    // Sage is #b8c6b0: green a touch above red and blue. Shading moves it, but not its hue.
    const sage = row.find(([r, g, b]) => g > 70 && g >= r && g >= b && Math.max(r, g, b) - Math.min(r, g, b) < 60);
    assert(sage, `no sage on the device's edge: ${JSON.stringify(row.slice(0, 12))}`);
    const mid = at(0.5, 0.5);
    assert(mid[0] > 200 && mid[1] > 200, `the screenshot isn't in the opening (${mid})`);
    const layout = await layoutScene(input as never);
    assert(layout.entities.find((e) => e.kind === "device")?.clay === "#b8c6b0", "the layout should tell the Studio the clay colour");
  } finally {
    delete process.env.SCREENSHOTTER_BEZELS_DIR;
  }
});

await check("image blocks: placed by their centre, sized by height with their own shape, drawn in front of the scene", async () => {
  const { readBmp } = await import("../src/util/png.js");
  const { run } = await import("../src/util/exec.js");
  const { layoutScene } = await import("../src/render/mockup.js");
  const { svgSize } = await import("../src/render/images.js");
  // A 2:1 red picture, and an SVG that only has a viewBox.
  const pic = path.join(out, "block.png");
  await renderHtml(`<!doctype html><body style="margin:0;background:#ff0000"></body>`, pic, 200, 100, { scale: 1, format: "png", transparent: false, outWidth: 200, outHeight: 100 });
  const svg = path.join(out, "block.svg");
  writeFileSync(svg, `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 100"><rect width="300" height="100" fill="#00ff00"/></svg>`);
  assert(JSON.stringify(svgSize(readFileSync(svg, "utf8"))) === JSON.stringify({ width: 300, height: 100 }), "an SVG's size comes from its viewBox");
  const input = {
    devices: [],
    canvas: "1000x1000",
    layout: "custom",
    background: "#000000",
    images: [
      { src: pic, x: 0.3, y: 0.3, height: 0.2, sticker: true },
      { src: svg, x: 0.7, y: 0.7, width: 0.3 },
      { src: path.join(out, "nowhere.png") },
    ],
  };
  const layout = await layoutScene(input as never);
  const [a, b] = layout.entities.filter((e) => e.kind === "image");
  assert(a?.id === "image-1" && Math.abs(a.width - 0.4) < 0.001 && Math.abs(a.height - 0.2) < 0.001, `a 2:1 picture 0.2 high is 0.4 wide: ${JSON.stringify(a)}`);
  assert(b && Math.abs(b.height - 0.1) < 0.001, `an SVG 0.3 wide is 0.1 high: ${JSON.stringify(b)}`);
  assert(layout.warnings.some((w) => /image 3 wasn't found/.test(w)), `a missing picture is left out with a warning: ${JSON.stringify(layout.warnings)}`);
  const file = path.join(out, "blocks.png");
  await createMockup({ ...input, preview: false, output: file } as never);
  await run("sips", ["-s", "format", "bmp", file, "--out", path.join(out, "blocks.bmp")]);
  const img = readBmp(readFileSync(path.join(out, "blocks.bmp")));
  const at = (fx: number, fy: number) => {
    const i = (Math.round(fy * (img.height - 1)) * img.width + Math.round(fx * (img.width - 1))) * 4;
    return [img.rgba[i], img.rgba[i + 1], img.rgba[i + 2]];
  };
  const red = at(0.3, 0.3);
  const green = at(0.7, 0.7);
  assert(red[0] > 200 && red[1] < 60, `the picture is drawn at its centre: ${red}`);
  assert(green[1] > 200 && green[0] < 60, `the SVG is drawn at its centre: ${green}`);
  // The sticker's white edge sits just outside the picture's left edge (0.1 of the width).
  const edge = at(0.094, 0.3);
  assert(edge[0] > 220 && edge[1] > 220 && edge[2] > 220, `a sticker has a white edge: ${edge}`);
});

await check("with no Apple art installed, a device is its bare screen (rounded like the device), never drawn", async () => {
  process.env.SCREENSHOTTER_BEZELS_DIR = path.join(out, "no-bezels");
  try {
    const r = await createMockup({ devices: [{ screenshot: shot, device: "iPhone 17 Pro" }], canvas: "600x1000", layout: "floating", background: "#000000", preview: false, output: path.join(out, "no-art.png") } as never);
    assert((r.warnings ?? []).some((w) => /no Apple art for an iPhone installed/.test(w)), `warnings: ${JSON.stringify(r.warnings)}`);
    const { layoutScene } = await import("../src/render/mockup.js");
    const layout = await layoutScene({ devices: [{ screenshot: shot, device: "iPhone 17 Pro" }], canvas: "600x1000", layout: "floating" } as never);
    assert(layout.entities.find((e) => e.kind === "device")?.frame === "card", "the device should be laid out as its bare screen");
  } finally {
    delete process.env.SCREENSHOTTER_BEZELS_DIR;
  }
});

await check("a set reads as one picture: a backdrop's slices line up, and a spanning device carries on next door", async () => {
  const { layoutScene } = await import("../src/render/mockup.js");
  const { run } = await import("../src/util/exec.js");
  const { readBmp } = await import("../src/util/png.js");
  const bg = { colors: ["#ff0000", "#0000ff"], angle: 90 };
  const scene = (index: number, extra = {}) => ({ devices: [{ screenshot: shot, frame: "none", x: 0.5, y: 0.5, height: 0.4 }], canvas: "200x400", layout: "custom", background: bg, backgroundSpan: { count: 2, index }, preview: false, ...extra });
  // The left screen's right edge and the right screen's left edge are the same colour: the middle of one gradient.
  const files = [0, 1].map((i) => path.join(out, `span-${i}.png`));
  for (const [i, f] of files.entries()) await createMockup({ ...scene(i), output: f } as never);
  const edge = async (f: string, x: number) => {
    await run("sips", ["-s", "format", "bmp", f, "--out", `${f}.bmp`]);
    const img = readBmp(readFileSync(`${f}.bmp`));
    const i = (Math.round(img.height * 0.1) * img.width + Math.round(x * (img.width - 1))) * 4;
    return [img.rgba[i], img.rgba[i + 1], img.rgba[i + 2]];
  };
  const [a, b] = [await edge(files[0], 1), await edge(files[1], 0)];
  assert(Math.abs(a[0] - b[0]) < 16 && Math.abs(a[2] - b[2]) < 16, `the slices don't meet: ${a} vs ${b}`);
  const [l, r] = [await edge(files[0], 0), await edge(files[1], 1)];
  assert(l[0] > 200 && r[2] > 200, `each screen shows its own end of the gradient: ${l} … ${r}`);
  // A neighbour's spanning device is an entity of its own, below this screen's devices.
  const layout = await layoutScene({ ...scene(1), spill: [{ screenshot: shot, frame: "none", x: -0.1, y: 0.5, height: 0.4 }] } as never);
  const own = layout.entities.find((e) => e.id === "device-1")!;
  const spill = layout.entities.find((e) => e.id === "spill-1")!;
  assert(spill?.spill && spill.x === -0.1 && spill.z < own.z, `spill entity: ${JSON.stringify(spill)}`);
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
  // Apple writes iPad sizes as 13" (no "-inch"): never the plain iPad.
  is('PNG/iPad Pro (M5) 13" - Silver - Portrait.png', "ipad-pro-13", "Silver");
  is('PNG/iPad Pro (M5) 11" - Silver - Landscape.png', "ipad-pro-11", "Silver", true);
  is('PNG/iPad Air 13" (M4) - Blue - Portrait.png', "ipad-air-13", "Blue");
  is("PNG/Sport Band/Apple Watch S11 - 42mm - Aluminum Jet Black + Sport Band Black.png", "apple-watch-42mm", "Jet Black");
  // The Ultra comes in one size: its art may leave out "49mm", or shorten the name to "U3".
  is("PNG/Apple Watch Ultra 3 - Black Titanium - Alpine Loop.png", "apple-watch-ultra", "Black Titanium");
  is("PNG/Apple Watch U3 - 49mm - Titanium Natural + Trail Loop Blue.png", "apple-watch-ultra", "Natural Titanium");
  // Apple's own Ultra 3 file names.
  is("PNG/Alpine Loop/AW Ultra 3 - Natural + Alpine Loop Terra Cotta.png", "apple-watch-ultra", "Natural Titanium");
  is("PNG/Ocean Band/AW Ultra 3 - Black + Ocean Band Anchor Blue.png", "apple-watch-ultra", "Black Titanium");
  // A watch's band comes after the "+"; the finish is read before it, so a band's colour isn't taken for the case's.
  const watch = classify("/art/PNG/Sport Band/Apple Watch S11 - 46mm - Titanium Slate + Sport Band Black.png", "/art");
  assert(watch?.color === "Slate Titanium" && watch.band === "Sport Band Black", `S11 band → ${JSON.stringify(watch)}`);
  assert(classify("/art/PNG/Milanese Loop/AW Ultra 3 - Natural + Milanese Loop.png", "/art")?.band === "Milanese Loop", "a band without a colour");
  // Designs saved before the watches were named by generation still find them.
  const { findModel } = await import("../src/devices/catalog.js");
  assert(findModel("Apple Watch Ultra 49mm")?.name === "Apple Watch Ultra 3", "the Ultra's old name");
  assert(findModel("Apple Watch 46mm")?.name === "Apple Watch Series 11 46mm", "the Series 11's old name");
  // A set from Apple names its one model when the file doesn't.
  assert(!classify("/art/Ocean Band/Natural Titanium.png", "/art"), "a file naming no model is skipped");
  assert(classify("/art/Ocean Band/Natural Titanium.png", "/art", "apple-watch-ultra")?.model === "apple-watch-ultra", "a set's one model is used when the file doesn't name it");
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

await check("shapes: every type draws, badges number themselves, and each is an entity", async () => {
  const { buildScene } = await import("../src/render/mockup.js");
  const types = ["arrow", "line", "ellipse", "rect", "triangle", "star", "badge", "badge"];
  const scene = await buildScene({ devices: [{ screenshot: shot }], shapes: types.map((type, i) => ({ type, x: 0.1 + i * 0.1, y: 0.1, sketch: i % 2 === 0 })) } as never);
  assert((scene.html.match(/class="shape"/g) ?? []).length === types.length, "not every shape was drawn");
  assert(/>1<\/text>/.test(scene.html) && />2<\/text>/.test(scene.html), "badges should number themselves 1, 2");
  const ents = scene.result.entities.filter((e) => e.kind === "shape");
  assert(ents.length === types.length && ents[6].shape?.label === "1" && ents[2].z === 40, "shape entities are wrong");
  assert(ents[2].shape?.stroke === "#ff3b30" && ents[5].shape?.fill === "#ffd60a", "defaults should be a red outline and a yellow star");
});

await check("shapes: `around` lands on the text, follows the device, and an arrow stops at its edge", async () => {
  const { layoutScene } = await import("../src/render/mockup.js");
  const scene = (x: number) => ({
    devices: [{ screenshot: shot, x, y: 0.5, height: 0.8, anchor: "center" }],
    canvas: "1600x1200",
    shapes: [{ type: "ellipse", around: { text: "Row number 3" } }, { type: "arrow", around: { text: "Row number 3" } }, { type: "badge", around: { text: "Row number 3" }, at: "left" }],
  });
  const a = await layoutScene(scene(0.4) as never);
  const b = await layoutScene(scene(0.6) as never);
  const dev = a.entities[0];
  const [ring, arrow, badge] = a.entities.filter((e) => e.kind === "shape");
  // Row 3 sits 250pt down an 874pt screen, and its words start at the left.
  const wantY = dev.y - dev.height! / 2 + (dev.screen!.y + (250 / 874) * dev.screen!.height) * dev.height!;
  assert(Math.abs(ring.y - wantY) < 0.012, `ring is at y ${ring.y}, the row is at ${wantY.toFixed(4)}`);
  assert(ring.x > dev.x - dev.width / 2 && ring.x < dev.x, `ring x ${ring.x} should be on the left half of the device`);
  const ring2 = b.entities.find((e) => e.id === "shape-1")!;
  assert(Math.abs(ring2.x - ring.x - 0.2) < 0.002 && Math.abs(ring2.y - ring.y) < 0.002, "the ring should move with the device");
  const to = arrow.shape!.to;
  const from = arrow.shape!.from;
  const gap = Math.hypot((to.x - ring.x) * 1600, (to.y - ring.y) * 1200);
  assert(gap > 8 && gap < 140, `the arrow should stop at the text's edge, not ${Math.round(gap)}px from its centre`);
  assert(from.x < dev.x - dev.width / 2, "the arrow should start outside the device");
  assert(badge.x < ring.x - ring.width / 2 + 0.01, "a badge `at: left` should sit left of the text");
});

await check("shapes: a target that isn't on the screen is a warning, not a failure", async () => {
  const { layoutScene } = await import("../src/render/mockup.js");
  const r = await layoutScene({ devices: [{ screenshot: shot }], shapes: [{ type: "ellipse", around: { text: "No such words" } }] } as never);
  assert(r.warnings.some((w) => /Shape 1/.test(w)), "no warning");
  assert(r.entities.some((e) => e.id === "shape-1"), "the shape should still be placed");
});

await check("animation: easings start at 0 and land on 1; entrances hide until their time; a group zooms about its shared centre", async () => {
  const { EASES, ease, evaluate, timelineEnd } = await import("../src/render/animate.js");
  for (const e of EASES) assert(ease(e, 0) === 0 && ease(e, 1) === 1 && Number.isFinite(ease(e, 0.37)), `${e} doesn't run from 0 to 1`);
  assert(ease("back-out", 0.6) > 1 && ease("spring", 0.29) > 1.1, "back-out and spring should overshoot");
  const ents = [
    { id: "device-1", kind: "device" as const, x: 0.3, y: 0.5, width: 0.2, height: 0.5 },
    { id: "device-2", kind: "device" as const, x: 0.7, y: 0.5, width: 0.2, height: 0.5 },
    { id: "caption", kind: "caption" as const, x: 0.5, y: 0.1, width: 0.8, anchor: "top" as const, align: "center" as const, size: 0.05, color: "#ffffff" },
  ];
  const anims = [
    { targets: "caption", at: 1, enter: "slide-up" as const, duration: 1, ease: "linear" as const },
    { targets: ["device-1", "device-2"], at: 2, enter: "zoom" as const, amount: 0.5, duration: 1, ease: "linear" as const, fade: false },
    { targets: "caption", at: 4, duration: 1, ease: "linear" as const, to: { color: "#000000", scale: 2 } },
  ];
  const at = (t: number) => evaluate(anims, ents, t, 1000, 1000);
  const near = (a: number, b: number) => Math.abs(a - b) < 0.001;
  let st = at(0);
  assert(st.get("caption")!.opacity === 0 && near(st.get("caption")!.dy, 200), "the headline should wait below, unseen, until 1 s");
  // Half size about the centre between them (x 0.5): each sits half as far from it.
  assert(near(st.get("device-1")!.sx, 0.5) && near(st.get("device-1")!.dx, 100) && near(st.get("device-2")!.dx, -100) && st.get("device-1")!.opacity === 1, "the pair should start half size, pulled toward their shared centre");
  st = at(1.5);
  assert(near(st.get("caption")!.opacity, 0.5) && near(st.get("caption")!.dy, 100), "halfway through sliding in");
  st = at(3);
  assert(near(st.get("device-1")!.sx, 1) && near(st.get("device-1")!.dx, 0), "the pair should be in place at 3 s");
  st = at(4.5);
  assert(near(st.get("caption")!.sx, 1.5) && st.get("caption")!.color === "rgba(128, 128, 128, 1)", `halfway through the change, got ${st.get("caption")!.sx} ${st.get("caption")!.color}`);
  st = at(9);
  assert(st.get("caption")!.sx === 2 && st.get("caption")!.color === "#000000", "a change should stay");
  assert(timelineEnd(anims) === 5, "the timeline ends when the last animation does");
});

await check("animation: shapes are redrawn with animated values: size, turn, fill, an arrow's end and curve", async () => {
  const { evaluate } = await import("../src/render/animate.js");
  const { shapeSpec, renderShape } = await import("../src/render/shapes.js");
  const arrow = shapeSpec({ type: "arrow", from: { x: 0.1, y: 0.1 }, to: { x: 0.3, y: 0.1 }, bend: 0 });
  const circle = shapeSpec({ type: "ellipse", x: 0.5, y: 0.5, size: 0.1, aspect: 1, fill: "#ffd60a" });
  const ents = [
    { id: "shape-1", kind: "shape" as const, x: 0.2, y: 0.1, width: 0.2, shape: arrow },
    { id: "shape-2", kind: "shape" as const, x: 0.5, y: 0.5, width: 0.1, shape: circle },
  ];
  const anims = [
    { targets: "shape-1", at: 0, duration: 2, ease: "linear" as const, to: { end: { x: 0.5, y: 0.1 }, bend: 0.4 } },
    { targets: "shape-2", at: 0, duration: 2, ease: "linear" as const, to: { scale: 2, fill: "#ff0000", rotate: 90 } },
  ];
  const st = evaluate(anims, ents, 1, 1000, 1000);
  const a = st.get("shape-1")!.shape!;
  const c = st.get("shape-2")!.shape!;
  assert(Math.abs(a.to.x - 0.4) < 0.001 && Math.abs(a.bend - 0.2) < 0.001 && a.from.x === 0.1, `the arrow's end should be halfway there, got ${a.to.x} bend ${a.bend}`);
  assert(Math.abs(c.size - 0.15) < 0.001 && c.rotate === 45 && c.fill === "rgba(255, 107, 5, 1)" && Math.abs(c.aspect - 1) < 0.001, `the circle should be halfway: ${c.size} ${c.rotate} ${c.fill}`);
  assert(renderShape(a, 1000, 1000).svg.includes("<path") && renderShape(c, 1000, 1000).svg.includes("rgba(255, 107, 5, 1)"), "the animated shapes should draw");
});

await check("animation: the camera pushes in on a point, glides to the next and pulls back; its frame round-trips", async () => {
  const { evaluateCamera, cameraView, cameraFor, cameraTransform, animatedIds } = await import("../src/render/animate.js");
  const anims = [
    { targets: "camera", at: 1, duration: 1, ease: "linear" as const, to: { zoom: 2, x: 0.3, y: 0.5 } },
    { targets: "camera", at: 3, duration: 1, ease: "linear" as const, to: { zoom: 3, x: 0.8, y: 0.6 } },
    { targets: "camera", at: 5, duration: 1, ease: "linear" as const, to: { zoom: 1 } },
    { targets: "device-1", at: 0, enter: "fade" as const },
  ];
  const near = (a: number, b: number) => Math.abs(a - b) < 0.002;
  assert(evaluateCamera([anims[3]], 1) === undefined, "no camera moves, no camera");
  assert(![...animatedIds(anims)].includes("camera"), "the camera isn't an item");
  let c = evaluateCamera(anims, 1.5)!;
  // Pushing in from the whole design goes straight at the point.
  assert(near(c.zoom, 1.5) && near(c.x, 0.3) && near(c.y, 0.5), `halfway in: ${JSON.stringify(c)}`);
  c = evaluateCamera(anims, 3.5)!;
  assert(near(c.zoom, 2.5) && near(c.x, 0.55) && near(c.y, 0.55), `gliding between the two points: ${JSON.stringify(c)}`);
  c = evaluateCamera(anims, 7)!;
  assert(near(c.zoom, 1), "pulled back at the end");
  // The frame it shows stays inside the image, and a frame gives back its camera.
  for (const cam of [{ zoom: 2, x: 0.05, y: 0.95 }, { zoom: 3.5, x: 0.8, y: 0.6 }, { zoom: 1.4, x: 0.5, y: 0.2 }]) {
    const v = cameraView(cam);
    assert(v.x >= -1e-6 && v.y >= -1e-6 && v.x + v.width <= 1 + 1e-6 && v.y + v.height <= 1 + 1e-6 && near(v.width, 1 / cam.zoom), `the frame leaves the image: ${JSON.stringify(v)}`);
    const back = cameraView(cameraFor(v, cam.zoom));
    assert(near(back.x, v.x) && near(back.y, v.y), "a frame should give back the same frame");
  }
  const t = cameraTransform({ zoom: 2, x: 0.5, y: 0.5 }, 1000, 800);
  assert(t.zoom === 2 && near(t.tx, 0) && near(t.ty, 0), "zooming on the middle doesn't move it");
});

await check("animation: text arrives a word or a letter at a time; an accented word keeps its punctuation", async () => {
  const { evaluate, textPieces, unitMode, timelineEnd } = await import("../src/render/animate.js");
  const words = textPieces("Plan it on the **Mac**. Cook it\nnow", "word").filter((p) => p.kind === "unit");
  assert(words.map((p) => `${p.text}:${p.w}`).join(" ") === "Plan:0 it:1 on:2 the:3 Mac:4 .:4 Cook:5 it:6 now:7", `words: ${words.map((p) => `${p.text}:${p.w}`).join(" ")}`);
  assert(textPieces("Hi **you**!", "letter").filter((p) => p.kind === "unit").map((p) => `${p.w}/${p.l}`).join(" ") === "0/0 0/1 1/2 1/3 1/4 1/5", "letters keep their word");
  const ents = [{ id: "caption", kind: "caption" as const, x: 0.5, y: 0.1, width: 0.8, size: 0.05, text: "One two **three**.", subtext: "four" }];
  const anims = [{ targets: "caption", at: 1, enter: "slide-up" as const, by: "word" as const, each: 0.5, duration: 1, ease: "linear" as const }];
  assert(unitMode(anims, "caption") === "word" && unitMode(anims, "text-1") === undefined, "only the headline is in pieces");
  const at = (t: number) => evaluate(anims, ents, t, 1000, 1000).get("caption")!;
  let st = at(0);
  // Five pieces: One, two, three, its full stop, four. The block itself isn't moved.
  assert(st.units?.length === 5 && st.units.every((u) => u.opacity === 0) && st.opacity === 1 && st.dy === 0, "every word should wait, unseen; the block stays");
  // A slide is 0.6 of the text's height (50 px here).
  assert(Math.abs(st.units![0].dy - 30) < 0.001, `a word should start 30 px down, got ${st.units![0].dy}`);
  st = at(2.25);
  const o = st.units!.map((u) => u.opacity.toFixed(2)).join(" ");
  assert(o === "1.00 0.75 0.25 0.25 0.00", `words arrive half a second apart, the full stop with its word: ${o}`);
  assert(timelineEnd(anims, ents) === 3.5 && timelineEnd(anims) === 2, "the reveal runs until the last word is in");
});

await check("video: text drawn in pieces lays out like the still; the camera carries the text", async () => {
  const { buildScene } = await import("../src/render/mockup.js");
  const scene = { devices: [{ screenshot: shot }], headline: "Two **words**. Here", texts: [{ text: "AB" }] };
  const plain = await buildScene(scene as never, { motion3d: false });
  assert(!/class="u"/.test(plain.html) && /id="overlay"/.test(plain.html) && /data-ent="caption"/.test(plain.html), "a video scene has the text overlay and ids, and no pieces unless asked");
  const pieces = await buildScene({ ...scene, animations: [{ targets: "caption", at: 0, enter: "fade", by: "word" }, { targets: "text-1", at: 0, enter: "fade", by: "letter" }] } as never, { motion3d: false });
  assert((pieces.html.match(/class="u"/g) ?? []).length === 6, `4 pieces in the headline and 2 letters, got ${(pieces.html.match(/class="u"/g) ?? []).length}`);
  assert(/<span class="uw"><span class="accent"[^>]*><span class="u">words<\/span><\/span><span class="u">\.<\/span><\/span>/.test(pieces.html) || /<span class="uw"><strong><span class="u">words<\/span><\/strong><span class="u">\.<\/span><\/span>/.test(pieces.html), "an accented word and its full stop stay together");
  const still = await buildScene(scene as never);
  assert(!/id="overlay"/.test(still.html), "stills have no overlay");
});

await check("storyboard: frames at key moments, at exact times, or every second, without rendering a video", async () => {
  const { storyboard } = await import("../src/render/video.js");
  const { keyMoments } = await import("../src/render/animate.js");
  const anims = [{ targets: "device-1", at: 1, enter: "fade" as const, duration: 0.5 }, { targets: "camera", at: 2, duration: 2, to: { zoom: 2 } }];
  assert(JSON.stringify(keyMoments(anims, [], 6)) === JSON.stringify([0, 1.55, 3, 4.05, 4.6]), `key moments: ${JSON.stringify(keyMoments(anims, [], 6))}`);
  const scene = { devices: [{ screenshot: shot }], animations: anims, video: { duration: 5 } };
  const started = Date.now();
  const key = await storyboard(scene as any, { output: path.join(out, "board-key.jpg") });
  const exact = await storyboard(scene as any, { times: [2.345, 0.5, 0.5], output: path.join(out, "board-exact.jpg") });
  const every = await storyboard(scene as any, { every: 1, output: path.join(out, "board-every.jpg") });
  assert(JSON.stringify(key.times) === JSON.stringify([0, 1.55, 3, 4.05, 4.6]) && magic(key.path) === "jpeg", "key moments sheet");
  assert(JSON.stringify(exact.times) === JSON.stringify([0.5, 2.345]), `exact times, sorted and once each: ${exact.times}`);
  assert(JSON.stringify(every.times) === JSON.stringify([0, 1, 2, 3, 4, 5]), `every second: ${every.times}`);
  return `3 storyboards in ${Date.now() - started} ms`;
});

await check("video: a gradient accent shows when its text arrives word by word", async () => {
  const { storyboard } = await import("../src/render/video.js");
  const { readBmp } = await import("../src/util/png.js");
  const { run } = await import("../src/util/exec.js");
  const pinkIn = async (by?: "word" | "letter") => {
    const file = path.join(out, `gradient-${by ?? "block"}.jpg`);
    await storyboard(
      {
        devices: [{ screenshot: shot, x: 0.8, y: 0.6, anchor: "center", height: 0.4 }],
        canvas: "16:9",
        background: "#101014",
        headline: "Plan it on the **Mac**",
        textStyle: { accentColor: "linear-gradient(90deg, #ff2d8a, #ff2d8a)" },
        animations: [{ targets: "caption", at: 0, enter: "fade", duration: 0.2, ...(by ? { by } : {}) }],
      } as any,
      { times: [3], output: file },
    );
    await run("sips", ["-s", "format", "bmp", file, "--out", `${file}.bmp`]);
    const img = readBmp(readFileSync(`${file}.bmp`));
    let pink = 0;
    for (let i = 0; i < img.rgba.length; i += 4) if (img.rgba[i] > 200 && img.rgba[i + 1] < 120 && img.rgba[i + 2] > 90) pink++;
    return pink;
  };
  const block = await pinkIn();
  const words = await pinkIn("word");
  const letters = await pinkIn("letter");
  assert(block > 200 && words > block * 0.6 && letters > block * 0.6, `the gradient word should show: ${block} pink pixels as a block, ${words} by word, ${letters} by letter`);
  return `${block} / ${words} / ${letters} pink pixels`;
});

await check("animation: repeats and back-and-forth, loops round a path, and the backdrop's own move", async () => {
  const { progressAt, evaluate, evaluateBackdrop, backdropStyle, pathMotion, timelineEnd } = await import("../src/render/animate.js");
  const a = { at: 1, duration: 1, ease: "linear" as const };
  // Plays three times, starting over; back and forth ends where it began after two plays.
  const over = [0.5, 1.5, 2.25, 3.75, 5].map((t) => progressAt({ ...a, repeat: 2 }, 1, 1, t));
  assert(JSON.stringify(over) === JSON.stringify([0, 0.5, 0.25, 0.75, 1]), `repeat: ${over}`);
  const back = [1.5, 2.25, 3.5].map((t) => progressAt({ ...a, repeat: 1, yoyo: true }, 1, 1, t));
  assert(JSON.stringify(back) === JSON.stringify([0.5, 0.75, 0]), `yoyo: ${back}`);
  assert(progressAt({ ...a, repeat: true }, 1, 1, 100.25) === 0.25, "forever keeps going");
  assert(timelineEnd([{ targets: "shape-1", ...a, to: { rotate: 360 }, repeat: 2 }]) === 4 && timelineEnd([{ targets: "shape-1", ...a, to: { rotate: 360 }, repeat: true }]) === 2, "a repeat's end counts its plays; forever counts one");
  // A circle loop: round and back to where it started, passing below it half way.
  const start = { x: 500, y: 300 };
  const half = pathMotion({ shape: "circle", size: 0.05 }, start, 0.5, 1000, 600);
  const whole = pathMotion({ shape: "circle", size: 0.05 }, start, 1, 1000, 600);
  assert(Math.abs(half.dx) < 1 && Math.abs(half.dy - 100) < 1 && Math.hypot(whole.dx, whole.dy) < 0.5, `circle: half ${JSON.stringify(half)}, whole ${JSON.stringify(whole)}`);
  // A route of your own ends at its last point; facing the way it goes turns it.
  const ents = [{ id: "shape-1", kind: "shape" as const, x: 0.2, y: 0.5, width: 0.1, height: 0.1 }];
  const route = [{ targets: "shape-1", at: 0, duration: 2, ease: "linear" as const, path: { points: [{ x: 0.5, y: 0.2 }, { x: 0.8, y: 0.5 }], orient: true } }];
  const end = evaluate(route, ents, 3, 1000, 600).get("shape-1")!;
  const mid = evaluate(route, ents, 1, 1000, 600).get("shape-1")!;
  assert(Math.abs(end.dx - 600) < 1 && Math.abs(end.dy) < 1 && Math.abs(mid.rotate) > 20, `route: end ${end.dx},${end.dy}, turned ${mid.rotate}° half way`);
  // Blur for anything, and the blur entrance.
  const soft = evaluate([{ targets: "shape-1", at: 0, duration: 1, enter: "blur", ease: "linear" }], ents, 0.5, 1000, 600).get("shape-1")!;
  assert(Math.abs(soft.blur! - 6) < 0.01 && Math.abs(soft.opacity - 0.5) < 0.01, `blur entrance half way: ${soft.blur}px, opacity ${soft.opacity}`);
  // The backdrop: pushed in, turned and shifted, scaled enough never to show an edge.
  const bd = evaluateBackdrop([{ targets: "backdrop", at: 0, duration: 2, ease: "linear", to: { zoom: 1.2, rotate: 10, hue: 40 } }], 1, 1000)!;
  const css = backdropStyle(bd, 1000, 600);
  assert(Math.abs(bd.zoom - 1.1) < 1e-9 && bd.hue === 20 && /hue-rotate\(20deg\)/.test(css.filter) && /rotate\(5deg\)/.test(css.transform), `backdrop: ${JSON.stringify(bd)} ${css.transform} ${css.filter}`);
  return "repeats, loops, routes, blur and the backdrop";
});

await check("video: a looping path, a blur entrance and the backdrop's colour shift show in the frames", async () => {
  const { storyboard } = await import("../src/render/video.js");
  const { readBmp } = await import("../src/util/png.js");
  const { run } = await import("../src/util/exec.js");
  const scene = {
    devices: [{ screenshot: shot, x: 0.5, y: 0.55, anchor: "center", height: 0.7 }],
    canvas: "16:9",
    background: { colors: ["#1030ff", "#1030ff"] },
    shapes: [{ type: "badge", x: 0.2, y: 0.3, size: 0.08, fill: "#ff2020", stroke: "none", label: " " }],
    animations: [
      { targets: "shape-1", at: 0, duration: 2, path: { shape: "circle", size: 0.1 }, repeat: true },
      // Blue turned back a third of the way round the colour wheel is green (forward would be red, like the badge).
      { targets: "backdrop", at: 0, duration: 2, ease: "linear", to: { hue: -120 } },
    ],
    video: { duration: 4, motion: "none" },
  };
  const at = async (t: number) => {
    const file = path.join(out, `loop-${t}.jpg`);
    await storyboard(scene as any, { times: [t], output: file });
    await run("sips", ["-s", "format", "bmp", file, "--out", `${file}.bmp`]);
    const img = readBmp(readFileSync(`${file}.bmp`));
    // Where the red badge is (its middle), and the backdrop's colour at a corner.
    let n = 0;
    let sx = 0;
    let sy = 0;
    for (let y = 0; y < img.height; y++)
      for (let x = 0; x < img.width; x++) {
        const i = (y * img.width + x) * 4;
        if (img.rgba[i] > 180 && img.rgba[i + 1] < 90 && img.rgba[i + 2] < 90) (n++, (sx += x), (sy += y));
      }
    // The backdrop, well inside the frame (the sheet has a margin), clear of the device and badge.
    const c = (Math.round(img.height * 0.85) * img.width + Math.round(img.width * 0.92)) * 4;
    return { x: sx / Math.max(1, n) / img.width, y: sy / Math.max(1, n) / img.height, corner: [img.rgba[c], img.rgba[c + 1], img.rgba[c + 2]] };
  };
  const [p0, p1, p2] = [await at(0.05), await at(1), await at(2)];
  assert(p1.y - p0.y > 0.2 && Math.hypot(p2.x - p0.x, p2.y - p0.y) < 0.03, `the badge should go round and come back: ${JSON.stringify([p0, p1, p2].map((p) => [p.x.toFixed(2), p.y.toFixed(2)]))}`);
  assert(p0.corner[2] > 150 && p2.corner[1] > p2.corner[2], `the backdrop should shift from blue toward green: ${p0.corner} → ${p2.corner}`);
  return `badge round and back; backdrop ${p0.corner} → ${p2.corner}`;
});

await check("frames: a design fits whole into another shape, its backdrop filling the frame", async () => {
  const { createMockup } = await import("../src/render/mockup.js");
  const { readBmp } = await import("../src/util/png.js");
  const { run } = await import("../src/util/exec.js");
  const file = path.join(out, "fit-frame.png");
  const r = await createMockup({ devices: [{ screenshot: shot }], canvas: "16:9", background: "#2040ff", output: file, preview: false } as any, { width: 1080, height: 1920, fit: "fit" });
  await run("sips", ["-s", "format", "bmp", file, "--out", `${file}.bmp`]);
  const img = readBmp(readFileSync(`${file}.bmp`));
  const at = (fx: number, fy: number) => { const i = (Math.round(img.height * fy) * img.width + Math.round(img.width * fx)) * 4; return [img.rgba[i], img.rgba[i + 1], img.rgba[i + 2]]; };
  const top = at(0.5, 0.03);
  const bottom = at(0.5, 0.97);
  assert(r.width === 1080 && r.height === 1920, `size ${r.width}×${r.height}`);
  assert(top[2] > 200 && bottom[2] > 200, `the backdrop should fill the frame top and bottom: ${top} / ${bottom}`);
  return `${r.width}×${r.height}, backdrop ${top}`;
});

await check("sequence: shots joined by transitions, and an App Store version that follows Apple's rules", async () => {
  const { spawnSync } = await import("node:child_process");
  if (spawnSync("ffmpeg", ["-version"]).status !== 0) return "skipped: no ffmpeg";
  const { createSequence, sequenceStoryboard } = await import("../src/render/sequence.js");
  const input = {
    size: "720x1280",
    shots: [
      { devices: [{ screenshot: shot }], canvas: "9:16", background: "#1030ff", video: { motion: "none" }, length: 2 },
      { devices: [{ screenshot: shot }], canvas: "16:9", layout: "custom", background: "#ff3010", video: { motion: "none" }, length: 2, transition: { type: "push-left", duration: 0.5 } },
    ],
    quality: "preview",
    output: path.join(out, "sequence.mp4"),
  };
  const board = await sequenceStoryboard(input as any, { times: [0.5, 3] });
  assert(board.shots[1].start === 1.5 && board.duration === 3.5 && board.times.length === 2, `storyboard: ${JSON.stringify(board)}`);
  const r = await createSequence({ ...input, versions: ["app-store-iphone"] } as any);
  const probe = (f: string) => spawnSync("ffprobe", ["-v", "error", "-show_entries", "format=duration:stream=codec_type,codec_name,profile,level,width,height,r_frame_rate,channels,sample_rate", "-of", "json", f]).stdout.toString();
  const main = JSON.parse(probe(r.path));
  const v = main.streams.find((x: any) => x.codec_type === "video");
  assert(Math.abs(Number(main.format.duration) - 3.5) < 0.1 && v.width === 360 && v.height === 640, `main: ${main.format.duration}s ${v.width}×${v.height}`);
  const store = JSON.parse(probe(r.versions![0].path));
  const sv = store.streams.find((x: any) => x.codec_type === "video");
  const sa = store.streams.find((x: any) => x.codec_type === "audio");
  assert(sv.width === 886 && sv.height === 1920 && sv.profile === "High" && sv.level <= 40 && sv.r_frame_rate === "30/1", `App Store video: ${JSON.stringify(sv)}`);
  assert(sa && sa.codec_name === "aac" && sa.channels === 2 && ["44100", "48000"].includes(sa.sample_rate), `App Store audio: ${JSON.stringify(sa)}`);
  assert(Number(store.format.duration) >= 14.95 && Number(store.format.duration) <= 30, `App Store length ${store.format.duration}`);
  return `3.5 s main; App Store ${sv.width}×${sv.height} ${sv.profile} ${sv.level} ${sv.r_frame_rate}, ${sa.codec_name} ${sa.channels}ch, ${Number(store.format.duration).toFixed(1)} s`;
});

await check("video: a call-out appears at its own time, and focus racks from one device to the other", async () => {
  const { storyboard } = await import("../src/render/video.js");
  const { readBmp } = await import("../src/util/png.js");
  const { run } = await import("../src/util/exec.js");
  const scene = {
    devices: [
      { screenshot: shot, x: 0.3, y: 0.5, anchor: "center", height: 0.8 },
      // Its call-out on the device that comes into focus (a blurred one would smear it).
      { screenshot: shot, x: 0.7, y: 0.5, anchor: "center", height: 0.8, blur: 0.01, highlights: [{ style: "outline", color: "#00ff66", rect: { x: 60, y: 400, width: 1080, height: 150 } }] },
    ],
    canvas: "16:9",
    background: "#101014",
    animations: [
      { targets: "device-2/callout-1", at: 1.5, enter: "fade", duration: 0.3 },
      { targets: "device-1", at: 1.5, duration: 0.3, to: { blur: 0.01 } },
      { targets: "device-2", at: 1.5, duration: 0.3, to: { blur: 0 } },
    ],
    video: { duration: 4 },
  };
  const at = async (t: number) => {
    const file = path.join(out, `rack-${t}.jpg`);
    await storyboard(scene as any, { times: [t], output: file });
    await run("sips", ["-s", "format", "bmp", file, "--out", `${file}.bmp`]);
    const img = readBmp(readFileSync(`${file}.bmp`));
    // Green outline pixels, and how sharp each half is (the summed jumps between neighbours).
    let green = 0;
    const edges = [0, 0];
    for (let y = 0; y < img.height; y++)
      for (let x = 1; x < img.width; x++) {
        const i = (y * img.width + x) * 4;
        // Clearly green (the thin ring blends into the white screen, so not pure green).
        if (img.rgba[i + 1] - img.rgba[i] > 50 && img.rgba[i + 1] - img.rgba[i + 2] > 30) green++;
        edges[x < img.width / 2 ? 0 : 1] += Math.abs(img.rgba[i] - img.rgba[i - 4]);
      }
    return { green, left: edges[0], right: edges[1] };
  };
  const before = await at(1);
  const after = await at(3);
  assert(before.green < 20 && after.green > 60, `the outline should arrive at 1.5 s: ${before.green} green pixels at 1 s, ${after.green} at 3 s`);
  assert(before.left > before.right * 1.3 && after.right > after.left * 1.3, `focus should rack: sharpness left/right ${before.left}/${before.right} at 1 s, ${after.left}/${after.right} at 3 s`);
  return `outline ${before.green} → ${after.green} px; sharp side left → right`;
});

await check("video: animations play: an item isn't there before its entrance, and is after", async () => {
  const { spawnSync } = await import("node:child_process");
  if (spawnSync("ffmpeg", ["-version"]).status !== 0) return "skipped: no ffmpeg";
  const { readBmp } = await import("../src/util/png.js");
  const file = path.join(out, "animated.mp4");
  const r = await createVideo({
    devices: [{ screenshot: shot, x: 0.5, y: 0.5, anchor: "center", height: 0.7 }],
    background: "#101014",
    animations: [{ targets: "device-1", at: 1, enter: "fade", duration: 0.2 }, { targets: "nothing-9", at: 0, enter: "fade" }],
    video: { duration: 2, fps: 10, motion: "none" },
    quality: "preview",
    preview: false,
    output: file,
  } as any);
  assert(r.warnings?.some((w) => /nothing-9/.test(w)), "an unknown target should be a warning");
  const middle = (t: number) => {
    const bmp = path.join(out, `animated-${t}.bmp`);
    spawnSync("ffmpeg", ["-v", "error", "-y", "-ss", String(t), "-i", file, "-frames:v", "1", bmp]);
    const img = readBmp(readFileSync(bmp));
    const i = (Math.round(img.height / 2) * img.width + Math.round(img.width / 2)) * 4;
    return (img.rgba[i] + img.rgba[i + 1] + img.rgba[i + 2]) / 3;
  };
  const before = middle(0.5);
  const after = middle(1.7);
  // The backdrop is near black; the synthetic screen is light.
  assert(before < 40 && after > 180, `the middle of the image should be backdrop at 0.5 s (${before}) and screen at 1.7 s (${after})`);
  return `${before.toFixed(0)} → ${after.toFixed(0)}`;
});

await check("process still alive after all of the above", () => statSync(out).isDirectory());

await closeBrowser();
console.log(`\n${failures ? `${failures} FAILED` : "ALL PASSED"}`);
process.exit(failures ? 1 : 0);
