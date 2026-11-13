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
// Tests never ask the Keychain (macOS would ask the person to allow it).
process.env.SCREENSHOTTER_NO_KEYCHAIN = "1";

const dir = await mkdtemp(path.join(tmpdir(), "screenshotter-studio-test-"));
const saved = Object.fromEntries(["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_CONFIG_DIR", "SCREENSHOTTER_CLAUDE_PATH", "SCREENSHOTTER_CODEX_PATH", "SCREENSHOTTER_OUTPUT_DIR", "SCREENSHOTTER_STYLE_FILE", "SCREENSHOTTER_SEEN_FILE", "SCREENSHOTTER_STUDIO_FILE", "OPENAI_API_KEY", "SCREENSHOTTER_CACHE_DIR"].map((k) => [k, process.env[k]]));
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
  const [main, retry] = blocks.find((b) => b.type === "text").text.split("\\n\\nYour previous operations");
  const prompt = JSON.parse(main);
  prompt.__retry = retry ?? "";
  prompt.__image = blocks.some((b) => b.type === "image" && b.source.data.length > 100);
  const reply = (${body})(prompt);
  console.log(JSON.stringify({ type: "system", subtype: "init" }));
  console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, structured_output: reply }));
});`,
  );
  await chmod(file, 0o755);
  process.env.SCREENSHOTTER_CLAUDE_PATH = file;
}

/**
 * A stand-in for `codex exec`: checks it runs isolated with a strict reply schema, then writes
 * `reply` (given the prompt from stdin) to the -o file, the way Codex does.
 */
async function fakeCodex(reply: object | ((prompt: any) => object)) {
  const file = path.join(dir, `fake-codex-${checks}.mjs`);
  const body = typeof reply === "function" ? reply.toString() : `() => (${JSON.stringify(reply)})`;
  await writeFile(
    file,
    `#!${process.execPath}
import { readFileSync, writeFileSync } from "node:fs";
let input = "";
process.stdin.on("data", (d) => (input += d));
process.stdin.on("end", () => {
  const a = process.argv.slice(2);
  const val = (f) => a[a.indexOf(f) + 1];
  if (a[0] !== "exec" || val("--sandbox") !== "read-only" || !a.includes("--ephemeral") || !a.includes("--skip-git-repo-check") || !a.includes("mcp_servers={}")) process.exit(3);
  if (!a.some((x) => x.startsWith("developer_instructions="))) process.exit(4);
  // OpenAI's strict schemas: every property required, nothing else allowed.
  const strict = (n) => !n || typeof n !== "object" || (Array.isArray(n) ? n.every(strict) : (n.type !== "object" || !n.properties || (n.additionalProperties === false && Object.keys(n.properties).every((k) => n.required?.includes(k)))) && Object.values(n).every(strict));
  if (!strict(JSON.parse(readFileSync(val("--output-schema"), "utf8")))) { console.log(JSON.stringify({ type: "error", message: "invalid_json_schema" })); process.exit(5); }
  const [main, retry] = input.split("\\n\\nYour previous operations");
  const prompt = JSON.parse(main);
  prompt.__retry = retry ?? "";
  prompt.__image = a.some((x) => x.startsWith("--image="));
  writeFileSync(val("-o"), JSON.stringify((${body})(prompt)));
  console.log(JSON.stringify({ type: "turn.completed" }));
});`,
  );
  await chmod(file, 0o755);
  process.env.SCREENSHOTTER_CODEX_PATH = file;
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

  // Codex gives values as they are: a number, plain text, or text it quoted out of habit.
  await fakeCodex((p: any) => ({
    summary: p.__image ? "Moved it, having seen it." : "Moved it.",
    operations: [
      { op: "set", path: "/devices/0/x", value: 0.25, from: null },
      { op: "set", path: "/headline", value: "Dinner, **solved.**", from: null },
      { op: "set", path: "/textStyle/accentColor", value: '"#ff5500"', from: null },
      // A remove's value is null, as Codex's schema allows.
      { op: "remove", path: "/effects", value: null, from: null },
    ],
    check: null, remember: null, see: null, look: null, imageReason: null,
  }));
  await check("Codex does the edit when chosen: isolated, with a strict schema, its nulls dropped", async () => {
    const r = await editScene({ request, instruction: "Move it left", engine: "codex" });
    assert.equal(r.provider, "codex");
    assert.equal(r.request.devices[0].x, 0.25);
    assert.equal(r.request.headline, "Dinner, **solved.**");
    assert.equal(r.request.textStyle?.accentColor, "#ff5500");
    assert.equal(r.request.effects, undefined, "the remove applied");
    assert.equal(r.request.devices[0].screenshot, shot);
    assert.equal(r.remembered, undefined);
    const looked = await editScene({ request, instruction: "Does it look balanced? Fix it", engine: "codex" });
    assert.equal(looked.summary, "Moved it, having seen it.", "the preview went to Codex as an image");
  });

  await check("choosing Codex when it isn't installed says what to do", async () => {
    process.env.SCREENSHOTTER_CODEX_PATH = path.join(dir, "no-codex-here");
    await assert.rejects(() => editScene({ request, instruction: "Move it", engine: "codex" }), /Codex wasn't found/);
  });

  await fakeClaude((p: any) => ({ summary: "Renamed.", operations: [{ op: "set", path: "/headline", value: p.__retry ? '"Dinner, solved."' : '"Dinner, solved."},{' }] }));
  await check("broken JSON in a value goes back to be fixed instead of landing in the design", async () => {
    const r = await editScene({ request, instruction: "Rename the headline" });
    assert.equal(r.request.headline, "Dinner, solved.");
  });

  await fakeClaude((p: any) => ({ summary: p.__image ? "Saw the design." : "Blind.", operations: [] }));
  await check("Claude gets a preview image of the design, unless it's turned off", async () => {
    assert.equal((await editScene({ request, instruction: "Look" })).summary, "Saw the design.");
    assert.equal((await editScene({ request, instruction: "Look", preview: false })).summary, "Blind.");
  });

  // A question or an exact edit goes without a render; Claude can ask to see the design.
  await fakeClaude((p: any) => ({ summary: p.__image ? "Saw the design." : "Blind.", operations: [] }));
  await check("a question or an exact edit goes to Claude without rendering the design", async () => {
    for (const instruction of ["What font is the headline?", "Make the headline blue"]) {
      const steps: string[] = [];
      assert.equal((await editScene({ request, instruction }, (p) => steps.push(p.step))).summary, "Blind.", instruction);
      assert.ok(!steps.includes("look") && !steps.includes("render"), `${instruction}: ${steps.join(", ")}`);
    }
  });
  await fakeClaude((p: any) => (p.__image ? { summary: "Seen it now.", operations: [] } : { summary: "", operations: [], see: true }));
  await check("Claude can ask to see the design, and gets the render", async () => {
    const steps: any[] = [];
    assert.equal((await editScene({ request, instruction: "Should the headline go first?" }, (p) => steps.push(p))).summary, "Seen it now.");
    assert.ok(steps.some((p) => p.step === "look" && typeof p.image === "string"), "the render was shown");
    // With previews off it answers without looking (asked again, it can't have one).
    assert.equal((await editScene({ request, instruction: "Should the headline go first?", preview: false })).summary, "");
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

  // New AI images are slow and cost money: only with a reason, otherwise Claude is asked again.
  await fakeClaude((p: any) =>
    /imageReason/.test(p.__retry)
      ? { summary: "Used the ember glow look.", operations: [{ op: "set", path: "/background", value: '"ember-glow"' }] }
      : { summary: "Generated a backdrop.", operations: [{ op: "set", path: "/background", value: '{"generate":"a rainy neon street"}' }] },
  );
  await check("a new AI image without a reason is sent back, and Claude uses a built-in backdrop", async () => {
    const r = await editScene({ request, instruction: "A nicer backdrop", preview: false });
    assert.equal(r.request.background, "ember-glow");
    assert.equal(r.summary, "Used the ember glow look.");
  });
  await fakeClaude((p: any) =>
    p.__retry
      ? { summary: "Asked twice.", operations: [] }
      : { summary: "Made a rainy street.", imageReason: "You asked for an AI image", operations: [{ op: "set", path: "/background", value: '{"generate":"a rainy neon street"}' }] },
  );
  await check("a new AI image with a reason goes ahead", async () => {
    const r = await editScene({ request, instruction: "Generate an AI image of a rainy street", preview: false });
    assert.equal(r.summary, "Made a rainy street.");
    assert.deepEqual(r.request.background, { generate: "a rainy neon street" });
  });

  // The timeline: Ask AI adds animations to the design; one that says nothing is refused.
  await fakeClaude(() => ({
    summary: "The headline slides up, then the device zooms in.",
    operations: [
      { op: "append", path: "/animations", value: '{"targets":"caption","at":0.4,"enter":"slide-up"}' },
      { op: "append", path: "/animations", value: '{"targets":["device-1"],"at":1.2,"enter":"zoom","ease":"back-out","duration":0.8}' },
    ],
  }));
  await check("Ask AI can write the design's animations", async () => {
    const r = await editScene({ request: { ...request, headline: "Hello" }, instruction: "Animate it", preview: false });
    assert.deepEqual(r.request.animations, [
      { targets: "caption", at: 0.4, enter: "slide-up" },
      { targets: ["device-1"], at: 1.2, enter: "zoom", ease: "back-out", duration: 0.8 },
    ]);
  });
  await fakeClaude(() => ({ summary: "Animated.", operations: [{ op: "append", path: "/animations", value: '{"targets":"caption","at":1}' }] }));
  await check("an animation that doesn't say what happens is rejected", async () => {
    await assert.rejects(() => editScene({ request, instruction: "Animate it", preview: false }), /enter, exit, from, to or path/);
  });

  // A video of several shots: Claude sees every shot and edits any of them, by /shots/N.
  await fakeClaude((p: any) =>
    p.video
      ? {
          summary: `Saw ${p.video.shots.length} shots, on ${p.video.onCanvas + 1}. Shot 1: white headline; added a copy of shot 2.`,
          operations: [
            { op: "set", path: "/shots/0/headline", value: '"Plan it"' },
            { op: "copy", from: "/shots/1", path: "/shots/2", value: "null" },
            { op: "set", path: "/shots/2/transition", value: '{"type":"push-left","duration":0.6}' },
          ],
        }
      : { summary: "No video.", operations: [] },
  );
  await check("in a video of several shots, Claude sees them all and edits any, adding and copying shots", async () => {
    const shots = [{ scene: { ...request, headline: "One" } }, { scene: { ...request, headline: "Two" }, length: 3 }];
    const r = await editScene({ request: { ...request, headline: "Two, edited" }, shots, shot: 1, instruction: "Make shot 1 say Plan it and add a copy of this one at the end", preview: false } as any);
    assert.match(r.summary, /^Saw 2 shots, on 2\./);
    assert.ok(r.video, "a video result");
    assert.equal(r.video!.shots.length, 3);
    assert.equal(r.video!.shots[0].scene.headline, "Plan it");
    // The shot on the canvas is taken as it is now, and its copy carries that.
    assert.equal(r.video!.shots[1].scene.headline, "Two, edited");
    assert.equal(r.video!.shots[2].scene.headline, "Two, edited");
    assert.deepEqual(r.video!.shots[2].transition, { type: "push-left", duration: 0.6 });
    assert.equal(r.video!.shots[2].length, 3);
    // Files come back as themselves in every shot.
    assert.equal(r.video!.shots[2].scene.devices[0].screenshot, shot);
    assert.equal(r.video!.structural, true);
    assert.deepEqual(r.video!.changed, [0, 2]);
    assert.equal(r.request.headline, "Plan it");
  });
  await fakeClaude(() => ({ summary: "Removed everything.", operations: [{ op: "remove", path: "/shots/1", value: "null" }, { op: "remove", path: "/shots/0", value: "null" }] }));
  await check("a video can't lose its last shot", async () => {
    const shots = [{ scene: request }, { scene: request }];
    await assert.rejects(() => editScene({ request, shots, shot: 0, instruction: "Delete them all", preview: false } as any), /at least one shot/);
  });

  // An animated design: Claude can ask to see particular moments before it answers.
  await fakeClaude((p: any) =>
    p.looked
      ? { summary: `Saw ${p.looked.join(" and ")}.`, operations: [{ op: "set", path: "/animations/0/at", value: "0.8" }] }
      : { summary: "", operations: [], look: [1.25, 0.5] },
  );
  await check("Claude can ask to see the video at chosen moments, and gets those frames", async () => {
    const steps: any[] = [];
    const r = await editScene({ request: { ...request, animations: [{ targets: "device-1", at: 1, enter: "fade" }] }, instruction: "Is the timing right?" }, (p) => steps.push(p));
    assert.equal(r.summary, "Saw 1.25 and 0.5.");
    assert.equal(r.request.animations?.[0].at, 0.8);
    const frames = steps.filter((p) => p.step === "frames");
    assert.deepEqual(frames[0].times, [1.25, 0.5]);
    assert.ok(frames.some((p) => typeof p.image === "string" && p.image.length > 1000), "the frames were rendered and shown");
    assert.ok(steps.some((p) => p.step === "look" && p.moments > 1), "an animated design is shown as its key moments");
  });

  await check("Stop ends Claude Code at once and leaves the design as it was", async () => {
    const file = path.join(dir, "slow-claude.mjs");
    await writeFile(file, `#!${process.execPath}\nprocess.stdin.resume();\nsetTimeout(() => {}, 60000);\n`);
    await chmod(file, 0o755);
    process.env.SCREENSHOTTER_CLAUDE_PATH = file;
    const stop = new AbortController();
    const started = Date.now();
    const steps: string[] = [];
    const run = editScene({ request, instruction: "Anything", preview: false }, (p) => {
      steps.push(p.step);
      if (p.step === "think") setTimeout(() => stop.abort(), 300);
    }, stop.signal);
    await assert.rejects(run, (e: Error) => e.name === "StoppedError");
    assert.ok(Date.now() - started < 5000, "it stopped promptly");
    // Reading only shows as a step when it takes a moment.
    assert.deepEqual(steps.filter((x) => x !== "read"), ["think"]);
  });

  await check("AI backdrops: Fast asks OpenAI for medium quality, one image per prompt at a time, and images you have are reused", async () => {
    const { generateImage, pendingImage, setImageQuality } = await import("../src/render/photos.js");
    process.env.SCREENSHOTTER_CACHE_DIR = path.join(dir, "cache");
    process.env.OPENAI_API_KEY = "test-key";
    const png = encodePng({ width: 4, height: 6, rgba: Buffer.alloc(4 * 6 * 4, 200) });
    const asked: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      if (!String(url).includes("api.openai.com")) return realFetch(url, init);
      asked.push(JSON.parse(String(init.body)).quality);
      await new Promise((r) => setTimeout(r, 150));
      return new Response(JSON.stringify({ data: [{ b64_json: png.toString("base64") }] }), { status: 200 });
    }) as typeof fetch;
    try {
      setImageQuality("best");
      const best = await generateImage({ prompt: "a quiet harbour" }, 1320, 2868);
      assert.deepEqual(asked, ["high"]);
      // Switching to Fast keeps the image already made for this prompt.
      setImageQuality("fast");
      assert.equal(pendingImage({ prompt: "a quiet harbour" }, 1320, 2868), undefined);
      assert.equal((await generateImage({ prompt: "a quiet harbour" }, 1320, 2868)).path, best.path);
      // A new prompt at Fast: medium quality, and two renders at once share one generation.
      assert.deepEqual(pendingImage({ prompt: "a busy market" }, 1320, 2868), { provider: "openai" });
      const [a, b] = await Promise.all([generateImage({ prompt: "a busy market" }, 1320, 2868), generateImage({ prompt: "a busy market" }, 1320, 2868)]);
      assert.equal(a.path, b.path);
      assert.deepEqual(asked, ["high", "medium"]);
    } finally {
      globalThis.fetch = realFetch;
      setImageQuality("fast");
    }
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

  await check("every recipe builds a valid design from a screenshot, keeping the person's words", async () => {
    const { RECIPES, buildRecipe } = await import("../src/design/recipes.js");
    const { layoutScene } = await import("../src/render/mockup.js");
    const { MockupInputSchema } = await import("../src/render/schema.js");
    for (const r of RECIPES) {
      const scene = await buildRecipe(r.id, [{ screenshot: shot }], { headline: "Our **words**" });
      MockupInputSchema.parse(scene);
      await layoutScene(scene);
      if (scene.headline) assert.equal(scene.headline, "Our **words**", r.id);
      assert.ok(scene.devices.every((d) => d.screenshot === shot), r.id);
    }
  });

  // Design it for me: three directions, each checked and rendered.
  await fakeClaude((p: any) => ({
    directions: [
      { name: "Warm studio", summary: "Warm.", operations: [{ op: "set", path: "/background", value: '"ember-glow"' }] },
      { name: "Gallery", summary: "Painted.", operations: [{ op: "set", path: "/background", value: '"great-wave"' }] },
      { name: "Broken", summary: "Invalid.", operations: [{ op: "set", path: "/devices/0/height", value: "-2" }] },
    ],
  }));
  await check("Design it for me returns the valid directions, each rendered", async () => {
    const { designDirections } = await import("../src/studio/ai.js");
    const r = await designDirections({ request, instruction: "Design it for me" });
    assert.deepEqual(r.directions.map((d) => d.name), ["Warm studio", "Gallery"]);
    assert.equal(r.directions[0].request.background, "ember-glow");
    assert.ok(r.directions.every((d) => (d.image?.length ?? 0) > 1000));
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
  // The note telling agents where this Studio's library is goes in the test folder too.
  process.env.SCREENSHOTTER_STUDIO_FILE = path.join(dir, "studio-note.json");
  server = await startStudio(0, false);
  const port = (server.address() as { port: number }).port;
  const base = `http://127.0.0.1:${port}`;
  const post = (route: string, body: unknown, headers: Record<string, string> = { "x-screenshotter": "studio" }) => fetch(base + route, { method: "POST", headers, body: JSON.stringify(body) });

  await check("port 0 picks a free loopback port and serves the UI", async () => {
    assert(port > 0);
    const html = await (await fetch(base + "/")).text();
    assert.match(html, /importmap/);
    for (const p of ["/ui/app.js", "/ui/styles.css", "/ui/vendor/preact.js", "/ui/vendor/htm.js"]) assert.equal((await fetch(base + p)).status, 200, p);
    // The canvas draws shapes with the engine's own module.
    const shapes = await (await fetch(base + "/ui/shapes.js")).text();
    assert.match(shapes, /export function renderShape/);
    assert.doesNotMatch(shapes, /^import /m);
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
  await check("saved scenes list their devices, size and caption; renaming or re-saving isn't an edit", async () => {
    const scene = { devices: [{ screenshot: shot, device: "MacBook Pro 14-inch" }, { screenshot: shot, device: "iPhone 17 Pro" }, { screenshot: shot, frame: "browser" }], headline: "Meet **Mise**" };
    const saved = await (await post("/api/scenes/save", { name: "Launch", scene })).json();
    assert.deepEqual(saved.kinds, ["mac", "iphone", "web"]);
    assert.deepEqual(saved.deviceNames, ["MacBook Pro 14-inch", "iPhone 17 Pro", "Browser"]);
    assert.deepEqual(saved.size, { width: 2560, height: 1440 });
    assert.equal(saved.headline, "Meet Mise");
    await new Promise((r) => setTimeout(r, 20));
    const renamed = await (await post("/api/scenes/save", { id: saved.id, name: "Launch day", scene })).json();
    assert.equal(renamed.name, "Launch day");
    assert.equal(renamed.updatedAt, saved.updatedAt);
    const edited = await (await post("/api/scenes/save", { id: saved.id, name: "Launch day", scene: { ...scene, headline: "Hi" } })).json();
    assert.notEqual(edited.updatedAt, saved.updatedAt);
    const listedScene = ((await (await fetch(base + "/api/scenes")).json()) as Array<{ id: string; name: string }>).find((x) => x.id === saved.id);
    assert.equal(listedScene?.name, "Launch day");
    assert.equal((await post("/api/scenes/delete", { id: saved.id })).status, 200);
  });
  await check("agents find the Studio's library; their scenes are copies unless told to replace, with files brought in", async () => {
    const { studioFolder } = await import("../src/util/studio.js");
    const { adoptFiles, findScene, saveScene } = await import("../src/studio/scenes.js");
    assert.equal(studioFolder(), path.resolve(dir));
    // A screenshot from outside the library is copied into it; one already inside stays put.
    const outside = await mkdtemp(path.join(tmpdir(), "screenshotter-elsewhere-"));
    const far = path.join(outside, "Far Away.png");
    await writeFile(far, await readFile(shot));
    const adopted = adoptFiles({ devices: [{ screenshot: far }, { screenshot: shot }], headline: "From an agent" });
    const [first, second] = adopted.scene.devices as Array<{ screenshot: string }>;
    assert.match(first.screenshot, /uploads\/far-away-[0-9a-f]{8}\.png$/);
    assert(first.screenshot.startsWith(path.resolve(dir)) && existsSync(first.screenshot));
    assert.equal(second.screenshot, shot);
    assert.equal(adopted.copied.length, 1);
    assert.equal(adoptFiles({ devices: [{ screenshot: far }] }).copied.length, 0, "the same file is copied once");
    await rm(outside, { recursive: true, force: true });
    // Saved by an agent: marked, and listed for the Studio.
    const original = await (await post("/api/scenes/save", { name: "Pricing", scene: { devices: [{ screenshot: shot }], headline: "Before" } })).json();
    const copy = saveScene({ name: "Pricing (agent's version)", scene: adopted.scene, by: "agent" });
    assert.notEqual(copy.id, original.id);
    const list = (await (await fetch(base + "/api/scenes")).json()) as Array<{ id: string; by?: string; headline?: string }>;
    assert.equal(list.find((x) => x.id === copy.id)?.by, "agent");
    assert.equal(list.find((x) => x.id === original.id)?.headline, "Before", "the original is untouched");
    // Replacing in place keeps the id; the Studio's own next edit clears the agent's mark.
    const replaced = saveScene({ id: original.id, scene: { devices: [{ screenshot: shot }], headline: "After" }, by: "agent" });
    assert.equal(replaced.id, original.id);
    assert.equal(replaced.by, "agent");
    assert.equal(findScene({ name: "pricing" }).id, original.id, "an exact name wins over a longer one containing it");
    const mine = await (await post("/api/scenes/save", { id: original.id, name: "Pricing", scene: { devices: [{ screenshot: shot }], headline: "Mine again" } })).json();
    assert.equal(mine.by, undefined);
    assert.throws(() => findScene({ name: "no such scene" }), /No scene named/);
    for (const id of [copy.id, original.id]) await post("/api/scenes/delete", { id });
  });
  await check("the Studio's save doesn't write over an agent's newer save of the same design", async () => {
    const { getScene, saveScene } = await import("../src/studio/scenes.js");
    const sc = (headline: string) => ({ devices: [{ screenshot: shot }], headline });
    const first = await (await post("/api/scenes/save", { name: "Race", scene: sc("Studio one") })).json();
    await new Promise((r) => setTimeout(r, 20));
    // An agent saves after the Studio's copy was made: the Studio's save based on its older copy is refused.
    const agent = saveScene({ id: first.id, scene: sc("Agent's"), by: "agent" });
    const refused = await (await post("/api/scenes/save", { id: first.id, name: "Race", scene: sc("Studio two"), base: first.updatedAt })).json();
    assert.equal(refused.conflict, true);
    assert.equal(refused.updatedAt, agent.updatedAt, "the answer is the agent's version, to take up");
    assert.equal((getScene(first.id).scene as { headline: string }).headline, "Agent's");
    // Once the Studio has the agent's version, its saves go in again.
    const taken = await (await post("/api/scenes/save", { id: first.id, name: "Race", scene: sc("Studio three"), base: agent.updatedAt })).json();
    assert.equal(taken.conflict, undefined);
    assert.equal((getScene(first.id).scene as { headline: string }).headline, "Studio three");
    // Agents' saves (no base) and saves with no agent change in between always go in.
    assert.equal(saveScene({ id: first.id, scene: sc("Agent again"), by: "agent" }).conflict, undefined);
    const own = await (await post("/api/scenes/save", { id: first.id, name: "Race", scene: sc("Mine"), base: "2000-01-01T00:00:00.000Z" })).json();
    assert.equal(own.conflict, true, "a stale base against an agent's save is refused");
    const plain = await (await post("/api/scenes/save", { id: first.id, name: "Race", scene: sc("No base") })).json();
    assert.equal(plain.conflict, undefined);
    assert.equal((getScene(first.id).scene as { headline: string }).headline, "No base");
    await post("/api/scenes/delete", { id: first.id });
  });
  await check("a design at several sizes keeps them all, and an agent saving the first size keeps the rest", async () => {
    const { getScene, saveScene } = await import("../src/studio/scenes.js");
    const sc = (canvas: string, headline: string) => ({ canvas, headline, devices: [{ screenshot: shot }] });
    const iphone = [{ scene: sc("iphone-6.9", "One"), name: "Intro" }, { scene: sc("iphone-6.9", "Two") }];
    const ipad = [{ scene: sc("ipad-13", "One") }, { scene: sc("ipad-13", "Two") }];
    const saved = await (
      await post("/api/scenes/save", { name: "Sizes", scene: iphone[0].scene, shots: [{ name: "Intro" }, iphone[1]], groups: [{ shots: iphone }, { shots: ipad }] })
    ).json();
    assert.equal(saved.sizes, 2);
    assert.equal(saved.shots, 2);
    assert.deepEqual(getScene(saved.id).groups?.map((g) => g.shots.map((x) => (x.scene as { canvas: string }).canvas).join()), ["iphone-6.9,iphone-6.9", "ipad-13,ipad-13"]);
    // An agent that knows nothing of sizes changes the first one; the iPad size stays.
    saveScene({ id: saved.id, scene: sc("iphone-6.9", "One, by an agent"), by: "agent" });
    const after = getScene(saved.id);
    assert.equal((after.groups?.[0].shots[0].scene as { headline: string }).headline, "One, by an agent");
    assert.equal(after.groups?.[0].shots[0].name, "Intro", "the screen keeps its name");
    assert.equal(after.groups?.[1].shots.length, 2);
    // Sent as null, a design is at one size again; one size sent is no sizes at all.
    assert.equal(saveScene({ id: saved.id, scene: after.scene, groups: null }).sizes, undefined);
    assert.equal(getScene(saved.id).groups, undefined);
    assert.equal(saveScene({ id: saved.id, scene: after.scene, groups: [{ shots: ipad }] }).sizes, undefined);
    await post("/api/scenes/delete", { id: saved.id });
  });
  await check("a set exports every size into numbered files, by size or ready for fastlane, with contact sheets", async () => {
    const sc = (canvas: string, headline: string) => ({ canvas, headline, layout: "custom", devices: [{ screenshot: shot, frame: "none", height: 0.5 }] });
    const sizes = [
      { label: "iPhone 6.9″", screens: [{ scene: sc("iphone-6.9", "One"), name: "Intro: the app" }, { scene: sc("iphone-6.9", "Two") }] },
      { label: "Watch Ultra 3", screens: [{ scene: sc("watch-ultra-3", "One") }] },
    ];
    const bySize = await (await post("/api/export-set", { name: "Set test", sizes })).json();
    const rel = (p: string) => path.relative(bySize.directory, p);
    assert.deepEqual(bySize.sizes.flatMap((x: { files: Array<{ path: string }> }) => x.files.map((f) => rel(f.path))), ["en-US/iPhone 6.9/01 Intro the app.png", "en-US/iPhone 6.9/02.png", "en-US/Watch Ultra 3/01.png"]);
    assert.equal(bySize.sizes[1].files[0].width, 422);
    assert(existsSync(path.join(bySize.directory, "Contact sheets", "iPhone 6.9.png")));
    const lane = await (await post("/api/export-set", { name: "Set test", sizes: sizes.slice(0, 1), folders: "fastlane", format: "jpeg", contactSheets: false })).json();
    assert.equal(path.relative(lane.directory, lane.sizes[0].files[1].path), "screenshots/en-US/iPhone 6.9 - 02.jpg");
    assert.equal(lane.screenshots, path.join(lane.directory, "screenshots"));
    assert(!existsSync(path.join(lane.directory, "Contact sheets")));
    assert.equal((await post("/api/export-set", { name: "Empty", sizes: [] })).status, 400);
    for (const d of [bySize.directory, lane.directory]) await rm(d, { recursive: true, force: true });
  });
  await check("thumbnails only for files in the output folder", async () => {
    const res = await fetch(`${base}/thumb?path=${encodeURIComponent(shot)}&w=100`);
    assert.equal(res.status, 200);
    assert.equal((await fetch(`${base}/thumb?path=${encodeURIComponent("/etc/hosts")}`)).status, 404);
  });
  await check("files are served in byte ranges: a span, to the end, the last few, and none past the end", async () => {
    const whole = await readFile(shot);
    const url = `${base}/file?path=${encodeURIComponent(shot)}`;
    const part = async (range: string) => {
      const res = await fetch(url, { headers: { Range: range } });
      return { status: res.status, range: res.headers.get("content-range"), body: Buffer.from(await res.arrayBuffer()) };
    };
    const span = await part("bytes=10-19");
    assert.equal(span.status, 206);
    assert.deepEqual(span.body, whole.subarray(10, 20));
    const tail = await part("bytes=-8");
    assert.equal(tail.range, `bytes ${whole.length - 8}-${whole.length - 1}/${whole.length}`);
    assert.deepEqual(tail.body, whole.subarray(whole.length - 8));
    const open = await part(`bytes=${whole.length - 5}-`);
    assert.deepEqual(open.body, whole.subarray(whole.length - 5));
    const over = await part(`bytes=${whole.length - 5}-${whole.length + 100}`);
    assert.equal(over.status, 206);
    assert.equal(over.body.length, 5);
    assert.equal((await part(`bytes=${whole.length + 10}-`)).status, 416);
    assert.equal((await part("bytes=0-1,5-6")).status, 200);
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
  await check("deleting a picture: an unused one goes (Undo brings it back); one a design uses only leaves the list; nothing else can go", async () => {
    const pictures = async () => ((await (await fetch(base + "/api/images")).json()).images as Array<{ path: string }>).map((f) => f.path);
    const upload = async (name: string) => (await (await raw(`/api/upload?kind=image&name=${name}`, await readFile(shot))).json()).path as string;
    // Not used anywhere: it's deleted, and Undo brings it back.
    const loose = await upload("Loose.png");
    const gone = await (await post("/api/images/delete", { path: loose })).json();
    assert(!gone.kept && !(await pictures()).includes(loose) && !existsSync(loose), "an unused picture is deleted");
    assert.equal((await post("/api/images/restore", { path: loose })).status, 200);
    assert((await pictures()).includes(loose) && existsSync(loose), "undo brings it back");
    // Used by a saved design: it leaves the list but its file stays, so the design keeps it.
    const logo = await upload("Logo.png");
    await post("/api/scenes/save", { name: "Uses the logo", scene: { devices: [], headline: "Hi", images: [{ src: logo }] } });
    const kept = await (await post("/api/images/delete", { path: logo })).json();
    assert(kept.kept && existsSync(logo) && !(await pictures()).includes(logo), "a used picture leaves the list, its file stays");
    assert.deepEqual(kept.usedIn, ["Uses the logo"], "the design using it is named");
    // Used by the design open (not saved yet): kept too.
    const open = await upload("Open.png");
    assert((await (await post("/api/images/delete", { path: open, inUse: true })).json()).kept && existsSync(open));
    assert.equal((await post("/api/images/restore", { path: logo })).status, 200);
    assert((await pictures()).includes(logo), "undo puts it back in the list");
    assert.equal((await post("/api/images/delete", { path: shot })).status, 403, "only pictures in the library's images folder");
    assert(existsSync(shot));
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
  await check("a recording's still: moments where the picture changes, saved beside it, kept out of the library, deleted with it", async () => {
    if (!ffmpeg) return console.log("  (skipped: no ffmpeg)");
    // Three screens: red, then blue, then green, a second each.
    const clip = path.join(dir, "screens.mp4");
    spawnSync("ffmpeg", ["-v", "error", "-y", ...["red", "blue", "green"].flatMap((c) => ["-f", "lavfi", "-i", `color=c=${c}:s=120x260:d=1`]), "-filter_complex", "concat=n=3:v=1:a=0", "-c:v", "libx264", "-pix_fmt", "yuv420p", clip]);
    const r = await (await raw("/api/upload?name=Three%20screens.mp4", await readFile(clip))).json();
    const { moments } = await (await fetch(`${base}/api/moments?path=${encodeURIComponent(r.path)}`)).json();
    const times = moments.map((m: { t: number }) => m.t);
    assert.equal(times[0], 0);
    assert(times.length >= 5 && times.length <= 8, `5 to 8 moments, got ${times.length}`);
    for (const screen of [1, 2]) assert(times.some((t: number) => Math.abs(t - screen) <= 0.35), `a moment near ${screen}s, where the screen changes`);
    assert.equal((await fetch(base + moments[1].thumb)).headers.get("content-type"), "image/jpeg");
    const still = await (await post("/api/still", { video: r.path, t: 1.5 })).json();
    assert.equal(still.path, r.path.replace(/\.mp4$/, ".still-1500.png"));
    assert(existsSync(still.path));
    assert.equal((await (await post("/api/still", { video: r.path, t: 0 })).json()).path, r.poster, "the first moment is the recording's own still");
    assert(!(await listed()).includes(still.path), "stills stay out of the library");
    assert.equal((await post("/api/still", { video: "/etc/hosts.mp4", t: 1 })).status, 403);
    assert.equal((await post("/api/delete", { path: r.path })).status, 200);
    assert(!existsSync(still.path), "a recording's stills go with it");
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
    assert.deepEqual([...new Set(steps)].filter((x) => x !== "read"), ["think"]);
    const read = lines.find((l) => l.step === "read");
    assert.ok(!read || read.items.includes("Backdrop"));
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
