#!/usr/bin/env node
/**
 * Check the engine inside build/Screenshotter.app without touching the simulator or your files:
 * it starts on a free port, serves the Studio UI and its assets, renders a real PNG and MP4 into
 * a temporary folder, and exits by itself when its stdin closes (as it does when the app quits).
 * It runs on the Node and ffmpeg the app carries, with nothing from Homebrew or nvm on its PATH,
 * as on a Mac with nothing installed.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { encodePng } from "../dist/util/png.js";

const resources = path.resolve("build/Screenshotter.app/Contents/Resources");
const helpers = path.resolve("build/Screenshotter.app/Contents/Helpers");
const node = path.join(helpers, "node");
for (const f of [node, path.join(helpers, "ffmpeg")]) assert(existsSync(f), `${f} is missing: the app should carry it`);
const output = await mkdtemp(path.join(tmpdir(), "screenshotter-bundle-test-"));
const child = spawn(node, [path.join(resources, "engine/dist/index.js"), "studio", "--port", "0", "--no-open", "--watch-stdin"], {
  cwd: path.join(resources, "engine"),
  env: { ...process.env, PATH: "/usr/bin:/bin:/usr/sbin:/sbin", SCREENSHOTTER_OUTPUT_DIR: output },
  stdio: ["pipe", "ignore", "pipe"],
});
let log = "";
const pass = (m) => console.log(`PASS ${m}`);
try {
  const port = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Engine startup timed out\n${log}`)), 30000);
    child.once("error", reject);
    child.once("exit", (code) => reject(new Error(`Engine exited ${code}: ${log}`)));
    child.stderr.on("data", (b) => {
      log += b;
      const m = log.match(/SCREENSHOTTER_STUDIO_PORT=(\d+)/);
      if (m) {
        clearTimeout(timeout);
        resolve(m[1]);
      }
    });
  });
  const base = `http://127.0.0.1:${port}`;
  const post = async (route, body, raw = false) => {
    const res = await fetch(base + route, { method: "POST", headers: { "x-screenshotter": "studio" }, body: raw ? body : JSON.stringify(body), signal: AbortSignal.timeout(180000) });
    const json = await res.json();
    assert.equal(res.status, 200, JSON.stringify(json));
    return json;
  };
  for (const p of ["/", "/ui/app.js", "/ui/styles.css", "/ui/vendor/preact.js", "/ui/vendor/hooks.js", "/ui/vendor/htm.js", "/ui/icon.svg", "/docs"]) {
    assert.equal((await fetch(base + p)).status, 200, p);
  }
  pass("Studio UI, vendored Preact/htm and docs are served from the bundle");
  const opts = await (await fetch(base + "/api/options")).json();
  assert(opts.looks.length > 10 && opts.ai && typeof opts.ai.available === "boolean");
  pass("options include looks and AI status");
  const upload = await post("/api/upload?name=sample%26test.png", encodePng({ width: 100, height: 200, rgba: Buffer.alloc(100 * 200 * 4, 245) }), true);
  const request = { devices: [{ screenshot: upload.path, frame: "card" }], canvas: "400x600", background: "pastel", headline: "Bundled engine", preview: false };
  const preview = await post("/api/mockup", { ...request, quality: "preview" });
  assert.equal(preview.width, 200);
  assert.equal((await readFile(preview.path))[0], 137);
  pass("renders a real PNG");
  assert.equal((await fetch(`${base}/thumb?path=${encodeURIComponent(upload.path)}&w=120`)).headers.get("content-type"), "image/jpeg");
  pass("library thumbnails");
  const bg = await fetch(`${base}/api/bg-preview?bg=${encodeURIComponent(JSON.stringify("pastel"))}&w=90&h=120`);
  assert.equal(bg.status, 200);
  pass("backdrop previews");
  const video = await post("/api/video", { ...request, quality: "preview", format: "mp4", video: { duration: 0.5, fps: 12, motion: "subtle" } });
  assert((await readFile(video.path)).length > 100);
  pass("exports an MP4 with the app's own ffmpeg");
  const webm = await post("/api/video", { ...request, quality: "preview", format: "webm", video: { duration: 0.5, fps: 12, motion: "subtle" } });
  assert((await readFile(webm.path)).length > 100);
  pass("exports a WebM (VP9) with it too");
  await post("/api/state", { scene: request, sceneName: "check" });
  assert.equal((await (await fetch(base + "/api/state")).json()).sceneName, "check");
  pass("remembers the design between launches");
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.stdin.end();
  await Promise.race([exited, new Promise((_, reject) => setTimeout(() => reject(new Error("engine kept running after its stdin closed")), 8000))]);
  pass("exits when the app goes away (stdin closed)");
} finally {
  if (child.exitCode === null) child.kill("SIGKILL");
  await rm(output, { recursive: true, force: true });
}
