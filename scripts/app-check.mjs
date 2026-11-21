#!/usr/bin/env node
/**
 * Check the engine inside build/Screenshotter.app without touching your files: it starts on a free
 * port, serves the app's UI and its assets, makes a board, draws and exports it as a real PNG, takes
 * a video (its still made by the browser) into a temporary folder, and exits by itself when its
 * stdin closes (as it does when the app quits).
 * It runs on the Node the app carries, with nothing from Homebrew or nvm on its PATH,
 * as on a Mac with nothing installed.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import assert from "node:assert/strict";

const APP = `build/${process.env.SCREENSHOTTER_APP_NAME || "Screenshotter"}.app`;
const resources = path.resolve(APP, "Contents/Resources");
const helpers = path.resolve(APP, "Contents/Helpers");
const node = path.join(helpers, "node");
assert(existsSync(node), `${node} is missing: the app should carry it`);
assert(!existsSync(path.join(helpers, "ffmpeg")), "the app shouldn't carry ffmpeg any more");
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
  for (const p of ["/", "/ui/app.js", "/ui/imports.js", "/ui/board-agent.js", "/ui/agent-logos.js", "/ui/board.js", "/ui/board-core.js", "/ui/shapes.js", "/ui/styles.css", "/ui/vendor/preact.js", "/ui/vendor/hooks.js", "/ui/vendor/htm.js", "/ui/icon.svg"]) {
    assert.equal((await fetch(base + p)).status, 200, p);
  }
  pass("the app's UI and vendored Preact/htm are served from the bundle");
  const opts = await (await fetch(base + "/api/options")).json();
  assert(opts.stickers.length > 10 && opts.art.length > 10 && opts.outputRoot);
  pass("options list the built-in stickers and illustrations");
  assert.deepEqual(await (await fetch(base + "/api/agents-connected")).json(), { agents: [] });
  pass("no agent connected yet");
  const board = await post("/api/board/new", { name: "Bundle check" });
  const page = board.pages[0].id;
  await post("/api/board/ops", { id: board.id, ops: [{ op: "add", page, parent: null, ids: ["a1"], nodes: { a1: { id: "a1", type: "frame", name: "Card", parent: null, children: ["t1"], style: { left: "0px", top: "0px", width: "200px", height: "120px", background: "#2f6fed", display: "flex", alignItems: "center", justifyContent: "center" } }, t1: { id: "t1", type: "text", name: "Words", parent: "a1", text: "Bundled engine", style: { color: "#fff", fontSize: "18px" } } } }] });
  const exported = await post("/api/board/export", { id: board.id, nodes: ["a1"], scale: 1, format: "png" });
  const png = await readFile(exported.files[0]);
  assert.equal(png[0], 137);
  assert.equal(png.readUInt32BE(16), 200);
  pass("draws a board and exports it as a real PNG");
  const video = await post("/api/upload?kind=video&name=clip.mp4", await readFile(path.resolve("scripts/fixtures/clip.mp4")), true);
  assert(video.poster && existsSync(video.poster) && video.width === 320 && video.height === 180, JSON.stringify(video));
  pass("takes a video, its size and still read by the browser");
  await post("/api/state", { ui: { theme: "dark", touched: { started: true } } });
  assert.equal((await (await fetch(base + "/api/state")).json()).ui.theme, "dark");
  pass("remembers preferences between launches");
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.stdin.end();
  await Promise.race([exited, new Promise((_, reject) => setTimeout(() => reject(new Error("engine kept running after its stdin closed")), 8000))]);
  pass("exits when the app goes away (stdin closed)");
} finally {
  if (child.exitCode === null) child.kill("SIGKILL");
  await rm(output, { recursive: true, force: true });
}
