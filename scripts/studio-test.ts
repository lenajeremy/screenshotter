/**
 * Studio server and AI Edit checks. No simulator, network or Claude account needed: the Claude
 * Code fallback is replaced by a fake CLI that returns canned operations.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { applyOperations, editScene, EditReplySchema, sceneAssets } from "../src/studio/ai.js";
import { startStudio } from "../src/studio/server.js";
import { closeBrowser } from "../src/render/browser.js";
import type { MockupInput } from "../src/render/schema.js";
import { encodePng } from "../src/util/png.js";

const dir = await mkdtemp(path.join(tmpdir(), "screenshotter-studio-test-"));
const saved = Object.fromEntries(["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_CONFIG_DIR", "SCREENSHOTTER_CLAUDE_PATH", "SCREENSHOTTER_OUTPUT_DIR", "SCREENSHOTTER_STYLE_FILE", "SCREENSHOTTER_SEEN_FILE"].map((k) => [k, process.env[k]]));
let server: http.Server | undefined;
let checks = 0;
const check = async (name: string, fn: () => unknown | Promise<unknown>) => {
  await fn();
  checks++;
  console.log(`PASS ${name}`);
};

/** A stand-in for `claude -p`: prints `reply` (with the prompt it received available as $PROMPT). */
async function fakeClaude(reply: object | ((prompt: any) => object)) {
  const file = path.join(dir, `fake-claude-${checks}.mjs`);
  const body = typeof reply === "function" ? reply.toString() : `() => (${JSON.stringify(reply)})`;
  await writeFile(
    file,
    `#!${process.execPath}
let input = "";
process.stdin.on("data", (d) => (input += d));
process.stdin.on("end", () => {
  const a = process.argv;
  // Isolation flags must be present.
  if (!a.includes("--safe-mode") || a[a.indexOf("--tools") + 1] !== "" || !a.includes("--no-session-persistence") || !a.includes("--json-schema")) process.exit(3);
  // Claude Code rejects schemas tagged draft 2020-12.
  if (/2020-12/.test(a[a.indexOf("--json-schema") + 1])) { console.error("--json-schema is not a valid JSON Schema"); process.exit(4); }
  if (a[a.indexOf("--input-format") + 1] !== "stream-json") process.exit(5);
  const blocks = JSON.parse(input.trim().split("\\n")[0]).message.content;
  const prompt = JSON.parse(blocks.find((b) => b.type === "text").text.split("\\n\\nYour previous operations")[0]);
  prompt.__image = blocks.some((b) => b.type === "image" && b.source.data.length > 100);
  const reply = (${body})(prompt);
  console.log(JSON.stringify({ type: "system", subtype: "init" }));
  console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, structured_output: reply }));
});`,
  );
  await chmod(file, 0o755);
  process.env.SCREENSHOTTER_CLAUDE_PATH = file;
}

try {
  // No API credentials in this process: AI Edit takes the Claude Code path.
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_AUTH_TOKEN;
  process.env.ANTHROPIC_CONFIG_DIR = path.join(dir, "no-anthropic-config");

  const shot = path.join(dir, "private screenshot.png");
  await writeFile(shot, encodePng({ width: 100, height: 200, rgba: Buffer.alloc(100 * 200 * 4, 255) }));
  const request: MockupInput = {
    devices: [{ screenshot: shot, video: path.join(dir, "take.mp4"), frame: "card", height: 0.7 }],
    canvas: "400x600",
    headline: "Hello",
    textStyle: { x: 0.5, y: 0.1 },
    background: { photo: shot, haze: 0.2 },
    output: path.join(dir, "keep.png"),
    effects: { grain: { amount: 0.1, scope: "background" } },
  };

  await check("local paths become placeholders and are deduplicated", () => {
    const { safe, assets } = sceneAssets(request);
    assert(!JSON.stringify(safe).includes(dir));
    assert.equal(safe.devices[0].screenshot, typeof safe.background === "object" ? safe.background.photo : undefined);
    assert.equal(safe.output, undefined);
    assert.equal(assets.size, 2);
  });

  await check("operations set, append and remove by JSON pointer without touching anything else", () => {
    const out = applyOperations(request, [
      { op: "set", path: "/devices/0/x", value: "0.3" },
      { op: "set", path: "/textStyle/accentColor", value: '"#ff5500"' },
      { op: "append", path: "/texts", value: '{"text":"NEW","x":0.5,"y":0.9}' },
      { op: "remove", path: "/effects", value: "null" },
      { op: "set", path: "/background/haze", value: "0.5" },
    ]) as MockupInput;
    assert.equal(out.devices[0].x, 0.3);
    assert.equal(out.devices[0].height, 0.7);
    assert.equal(out.textStyle?.accentColor, "#ff5500");
    assert.equal(out.texts?.[0].text, "NEW");
    assert.equal(out.effects, undefined);
    assert.equal((out.background as { haze: number; photo: string }).photo, shot);
    assert.equal(request.devices[0].x, undefined, "input untouched");
  });

  await check("operations can't reach prototypes or replace the whole scene", () => {
    assert.throws(() => applyOperations(request, [{ op: "set", path: "/__proto__/polluted", value: "1" }]), /Invalid path/);
    assert.throws(() => applyOperations(request, [{ op: "set", path: "", value: "{}" }]), /whole scene/);
    assert.equal(({} as Record<string, unknown>).polluted, undefined);
  });

  await check("reply schema matches the documented shape", () => {
    EditReplySchema.parse({ summary: "Moved it", operations: [{ op: "set", path: "/devices/0/x", value: "0.4" }] });
  });

  await fakeClaude((p: any) => ({
    summary: "Moved the card left and tilted it.",
    operations: [
      { op: "set", path: "/devices/0/x", value: "0.3" },
      { op: "set", path: "/devices/0/anchor", value: '"center"' },
      { op: "set", path: "/devices/0/rotate", value: String(p.selected === "device-1" ? 8 : 0) },
    ],
  }));
  await check("an edit applies, restores paths and keeps delivery settings", async () => {
    const before = await readdir(dir);
    const r = await editScene({ request, instruction: "Move it left and tilt it", selection: "device-1" });
    assert.equal(r.provider, "claude-code");
    assert.equal(r.request.devices[0].x, 0.3);
    assert.equal(r.request.devices[0].rotate, 8, "selection reached the model");
    assert.equal(r.request.devices[0].screenshot, shot);
    assert.equal(r.request.devices[0].video, request.devices[0].video);
    assert.equal(r.request.output, request.output);
    assert.deepEqual(r.changed, ["device-1"]);
    assert.deepEqual((await readdir(dir)).filter((f) => !f.startsWith("fake-claude")), before.filter((f) => !f.startsWith("fake-claude")));
  });

  await fakeClaude(() => ({ summary: "Swapped the screenshot.", operations: [{ op: "set", path: "/devices/0/screenshot", value: '"/etc/passwd"' }] }));
  await check("an edit can't point at a file that isn't in the scene", async () => {
    await assert.rejects(() => editScene({ request, instruction: "Use another file" }), /isn't in this scene/);
  });

  await fakeClaude(() => ({ summary: "Can't do that.", operations: [] }));
  await check("no operations leaves the scene exactly as it was", async () => {
    const r = await editScene({ request, instruction: "Make it smell nice" });
    assert.deepEqual(r.request, request);
    assert.deepEqual(r.operations, []);
  });

  await fakeClaude((p: any) => ({ summary: p.__image ? "Saw the design." : "Blind.", operations: [] }));
  await check("Claude gets a preview image of the design, unless it's turned off", async () => {
    assert.equal((await editScene({ request, instruction: "Look" })).summary, "Saw the design.");
    assert.equal((await editScene({ request, instruction: "Look", preview: false })).summary, "Blind.");
  });

  await fakeClaude(() => ({ summary: "Bad device.", operations: [{ op: "set", path: "/devices/0/height", value: "-3" }] }));
  await check("an invalid result is retried once, then reported", async () => {
    await assert.rejects(() => editScene({ request, instruction: "Break it" }), /height|Too small|>0/i);
  });

  // The design brief: the guide in the system prompt, and each screen's palette in the request.
  await fakeClaude((p: any) => ({ summary: p.screens?.[0]?.palette?.tone && "available" in p ? `Palette ${p.screens[0].palette.tone}` : "No facts.", operations: [] }));
  await check("Claude gets each screen's palette and what's available, with the design guide", async () => {
    assert.match((await editScene({ request, instruction: "Look" })).summary, /^Palette (dark|light)$/);
  });

  // It looks at its own render and fixes what's off, on top of its first edit.
  await fakeClaude((p: any) =>
    p.review
      ? { summary: "Checked it: the title needed more room.", operations: [{ op: "set", path: "/textStyle/headlineSize", value: "0.05" }] }
      : { summary: "Retitled.", operations: [{ op: "set", path: "/headline", value: '"Big idea"' }], check: true },
  );
  await check("Claude checks its render when it asks to, and its fixes apply on top", async () => {
    const r = await editScene({ request, instruction: "Make it better" });
    assert.equal(r.request.headline, "Big idea");
    assert.equal(r.request.textStyle?.headlineSize, 0.05);
    assert.equal(r.summary, "Checked it: the title needed more room.");
    assert.deepEqual(r.checked, { fixes: 1 });
    assert.equal(r.operations.length, 2);
  });

  // Stated preferences go to the house style.
  process.env.SCREENSHOTTER_STYLE_FILE = path.join(dir, "house-style.json");
  await fakeClaude((p: any) => ({ summary: p.houseStyle?.length ? "Knew it." : "Noted.", operations: [], remember: ["Always Space Black devices"] }));
  await check("preferences are remembered and come back in later requests", async () => {
    const first = await editScene({ request, instruction: "I always want Space Black" });
    assert.deepEqual(first.remembered, ["Always Space Black devices"]);
    assert.match(readFileSync(process.env.SCREENSHOTTER_STYLE_FILE!, "utf8"), /Always Space Black devices/);
    assert.equal((await editScene({ request, instruction: "Again" })).summary, "Knew it.");
  });

  await check("release notes: parsed from the changelog, shown once after an update, never on a first run", async () => {
    const { parseChangelog, whatsNew, markSeen, compareVersions } = await import("../src/studio/whatsnew.js");
    const md = "# What's new\n\n## 0.3.0 · Later\n\n### New\n- **Big** thing\n- Small thing\n\n## 0.2.0 · Earlier\n\n- Older thing\n";
    const releases = parseChangelog(md);
    assert.deepEqual(releases.map((r) => r.version), ["0.3.0", "0.2.0"]);
    assert.equal(releases[0].sections[0].title, "New");
    assert.equal(releases[0].sections[0].items[0], "<strong>Big</strong> thing");
    assert.equal(compareVersions("0.10.0", "0.9.1"), 1);
    const file = path.join(dir, "CHANGELOG.md");
    await writeFile(file, md);
    const out = process.env.SCREENSHOTTER_OUTPUT_DIR;
    // First run (no saved Studio state): nothing to show, and this version counts as seen.
    process.env.SCREENSHOTTER_SEEN_FILE = path.join(dir, "seen-a.json");
    process.env.SCREENSHOTTER_OUTPUT_DIR = path.join(dir, "fresh-output");
    assert.deepEqual(whatsNew(file, "0.3.0").unseen, []);
    // Updating from before the changelog (the Studio saved state before): this release only.
    process.env.SCREENSHOTTER_SEEN_FILE = path.join(dir, "seen-b.json");
    process.env.SCREENSHOTTER_OUTPUT_DIR = path.join(dir, "used-output");
    mkdirSync(path.join(dir, "used-output", ".studio"), { recursive: true });
    await writeFile(path.join(dir, "used-output", ".studio", "state.json"), "{}");
    assert.deepEqual(whatsNew(file, "0.3.0").unseen.map((r) => r.version), ["0.3.0"]);
    markSeen("0.3.0");
    assert.deepEqual(whatsNew(file, "0.3.0").unseen, []);
    // Skipping versions shows everything since the last one seen.
    markSeen("0.1.0");
    assert.deepEqual(whatsNew(file, "0.3.0").unseen.map((r) => r.version), ["0.3.0", "0.2.0"]);
    if (out === undefined) delete process.env.SCREENSHOTTER_OUTPUT_DIR;
    else process.env.SCREENSHOTTER_OUTPUT_DIR = out;
  });

  await check("the Claude Code skill is up to date with the design guide", async () => {
    const { SKILL_MD } = await import("../src/design/skill.js");
    assert.equal(readFileSync(path.join(import.meta.dirname, "..", "skills", "screenshot-design", "SKILL.md"), "utf8"), SKILL_MD, "Run npm run skill");
  });

  process.env.SCREENSHOTTER_CLAUDE_PATH = path.join(dir, "missing-claude");
  await check("without Claude Code or a key, the error says how to set it up", async () => {
    await assert.rejects(() => editScene({ request, instruction: "Edit" }), /Sign in to Claude Code|API key/);
  });

  process.env.SCREENSHOTTER_OUTPUT_DIR = dir;
  server = await startStudio(0, false);
  const port = (server.address() as { port: number }).port;
  const base = `http://127.0.0.1:${port}`;
  const post = (route: string, body: unknown, headers: Record<string, string> = { "x-screenshotter": "studio" }) => fetch(base + route, { method: "POST", headers, body: JSON.stringify(body) });

  await check("port 0 picks a free loopback port and serves the UI", async () => {
    assert(port > 0);
    const html = await (await fetch(base + "/")).text();
    assert.match(html, /importmap/);
    for (const p of ["/ui/app.js", "/ui/styles.css", "/ui/vendor/preact.js", "/ui/vendor/htm.js"]) assert.equal((await fetch(base + p)).status, 200, p);
    assert.equal((await fetch(base + "/ui/../server.js")).status, 404);
  });
  await check("requests from other sites are refused", async () => {
    assert.equal((await post("/api/layout", request, {})).status, 403);
    // fetch() won't send a custom Host, so use a raw request, as a DNS-rebinding page would.
    const status = await new Promise<number>((resolve, reject) =>
      http.get({ host: "127.0.0.1", port, path: "/api/options", headers: { Host: "evil.example" } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      }).on("error", reject),
    );
    assert.equal(status, 403);
  });
  await check("layout returns entities for the canvas", async () => {
    const body = await (await post("/api/layout", request)).json();
    assert.equal(body.canvas.width, 400);
    assert.equal(body.entities[0].id, "device-1");
    assert.equal(body.entities[1].id, "caption");
  });
  await check("state round-trips through the output folder", async () => {
    assert.equal((await post("/api/state", { sceneName: "Test", scene: request })).status, 200);
    assert.equal((await (await fetch(base + "/api/state")).json()).sceneName, "Test");
  });
  await check("thumbnails only for files in the output folder", async () => {
    const res = await fetch(`${base}/thumb?path=${encodeURIComponent(shot)}&w=100`);
    assert.equal(res.status, 200);
    assert.equal((await fetch(`${base}/thumb?path=${encodeURIComponent("/etc/hosts")}`)).status, 404);
  });
  const raw = (route: string, data: Buffer) => fetch(base + route, { method: "POST", headers: { "x-screenshotter": "studio", "Content-Type": "application/octet-stream" }, body: data });
  const listed = async () => ((await (await fetch(base + "/api/files")).json()) as Array<{ path: string }>).map((f) => f.path);
  await check("screenshots upload into the library, with their size", async () => {
    const r = await (await raw("/api/upload?name=Shot.png", await readFile(shot))).json();
    assert.match(r.path, /uploads\/shot-.*\.png$/);
    assert(r.width > 0 && r.height > 0);
    assert((await listed()).includes(r.path));
  });
  await check("backdrop photos stay out of the screenshot library", async () => {
    const r = await (await raw("/api/upload?kind=backdrop&name=Linen.png", await readFile(shot))).json();
    assert.match(r.path, /backdrops\/linen-.*\.png$/);
    assert(!(await listed()).includes(r.path));
  });
  const ffmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;
  await check("a recording gets a poster frame, and deleting either removes both", async () => {
    if (!ffmpeg) return console.log("  (skipped: no ffmpeg)");
    const clip = path.join(dir, "clip.mp4");
    spawnSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=red:s=120x260:d=1", "-c:v", "libx264", "-pix_fmt", "yuv420p", clip]);
    const r = await (await raw("/api/upload?name=Screen%20Recording.mp4", await readFile(clip))).json();
    assert.match(r.path, /uploads\/screen-recording-.*\.mp4$/);
    assert.equal(r.poster, r.path.replace(/\.mp4$/, ".png"));
    assert.deepEqual([r.width, r.height], [120, 260]);
    assert((await listed()).includes(r.poster));
    assert.equal((await post("/api/delete", { path: r.poster })).status, 200);
    assert(!existsSync(r.path) && !existsSync(r.poster));
  });
  await check("AI status reports what's available", async () => {
    const s = await (await fetch(base + "/api/ai-status")).json();
    assert.equal(typeof s.available, "boolean");
    assert.equal(s.model, "claude-opus-5-5");
  });
  await check("AI endpoint rejects an empty instruction before calling Claude", async () => {
    assert.equal((await post("/api/ai-edit", { request, instruction: "  " })).status, 400);
  });
  await fakeClaude({ summary: "Retitled.", operations: [{ op: "set", path: "/headline", value: '"New title"' }] });
  await check("AI endpoint returns the edited scene without rendering or writing files", async () => {
    const r = await (await post("/api/ai-edit", { request, instruction: "Retitle it" })).json();
    assert.equal(r.request.headline, "New title");
    assert.equal(r.request.devices[0].screenshot, shot);
    assert.equal((await readFile(shot))[0], 137);
  });
  await check("AI endpoint streams its steps, then the result", async () => {
    const text = await (await post("/api/ai-edit?stream=1", { request, instruction: "Retitle it", preview: false })).text();
    const lines = text.trim().split("\n").map((l) => JSON.parse(l));
    const steps = lines.filter((l) => l.type === "progress").map((l) => l.step);
    assert.deepEqual([...new Set(steps)], ["look", "read", "think"]);
    assert.ok(lines.find((l) => l.step === "read").items.includes("Backdrop"));
    const last = lines.at(-1);
    assert.equal(last.type, "result");
    assert.equal(last.request.headline, "New title");
  });
  console.log(`${checks} Studio checks passed.`);
} finally {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server!.close(() => resolve()));
  }
  await closeBrowser();
  await rm(dir, { recursive: true, force: true });
}
