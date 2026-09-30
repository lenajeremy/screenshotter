/**
 * End-to-end check of every tool through a real MCP client over stdio, against the built server.
 *
 *   npm run build && npm run smoke            # full run (needs Xcode + an iPhone simulator)
 *   SMOKE_OUT=/tmp/out npm run smoke          # choose where files go
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const out = path.resolve(process.env.SMOKE_OUT ?? "screenshots/smoke");
mkdirSync(out, { recursive: true });
const simulator = process.env.SMOKE_SIMULATOR ?? "iPhone 17 Pro";

const client = new Client({ name: "smoke", version: "0.0.0" });
await client.connect(
  new StdioClientTransport({
    command: "node",
    args: ["dist/index.js"],
    env: { ...(process.env as Record<string, string>), SCREENSHOTTER_OUTPUT_DIR: out },
  }),
);

let failures = 0;
async function call(name: string, args: Record<string, unknown>, expectError = false): Promise<any> {
  const t = Date.now();
  const r = (await client.callTool({ name, arguments: args }, undefined, { timeout: 600_000 })) as any;
  const texts = r.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");
  const images = r.content.filter((c: any) => c.type === "image");
  images.forEach((img: any, i: number) => writeFileSync(path.join(out, `preview-${name}-${Date.now()}-${i}.jpg`), Buffer.from(img.data, "base64")));
  const ok = Boolean(r.isError) === expectError;
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name} (${Date.now() - t} ms, ${images.length} image) ${texts.replace(/\s+/g, " ").slice(0, 220)}`);
  try {
    return JSON.parse(texts);
  } catch {
    return texts;
  }
}

const { tools } = await client.listTools();
console.log(`tools: ${tools.map((t) => t.name).join(", ")}`);

await call("list_simulators", { platform: "iOS" });
await call("list_mockup_options", {});
await call("list_apps", { simulator, includeSystem: true });
await call("simulator_control", { action: "status_bar", simulator });

const captured = await call("capture_screenshot", { simulator, bundleId: "com.apple.Preferences", appearance: "light" });
const shot = captured.path;
// A pending system prompt (e.g. an app's notification request) covers every app until someone
// answers it in the Simulator window; text-targeted checks can't pass until then.
const alertPending = (captured.warnings ?? []).some((w: string) => /alert/i.test(w));
if (alertPending) console.log(`NOTE a system alert is on the simulator; skipping text-targeted checks. ${captured.warnings[0]}`);
await call("find_text", { screenshot: shot, query: "General" });
await call("layout_mockup", { devices: [{ screenshot: shot }], headline: "Hello", canvas: "16:9" });

if (!alertPending) await call("create_mockup", {
  devices: [{ screenshot: shot, highlights: [{ style: "lift", text: "General" }] }],
  canvas: "16:9",
  layout: "hero-bleed",
  background: "meadow-motion",
});
await call("create_mockup", {
  devices: [{ screenshot: shot, color: "Cosmic Orange" }],
  layout: "tilted",
  headline: "Everything, **in its place**",
  subheadline: "Settings that make sense at a glance.",
  background: "clouds",
  textStyle: { accentColor: "#ea580c" },
  effects: { grain: 0.12, grade: "warm-film" },
});

const desktop = (await call("capture_web", { url: "https://linear.app", viewport: "desktop" })).path;
await call("create_mockup", { devices: [{ screenshot: desktop }], canvas: "16:9", background: "midnight", headline: "Plan and **ship**", textStyle: { position: "left", accentColor: "#8b7dff" } });

const safari = (await call("capture_web", { url: "https://www.apple.com/iphone/", viewport: "iphone" })).path;
const macbook = (await call("capture_web", { url: "https://linear.app", viewport: "macbook" })).path;
await call("create_mockup", { devices: [{ screenshot: macbook }, { screenshot: safari }], canvas: "16:9", background: "dunes", effects: { edgeBlur: true } });

await call("create_mockup_set", {
  name: "smoke-set",
  background: { look: "pastel" },
  screens: [
    { screenshot: shot, headline: "Tidy **settings**" },
    { screenshot: safari, headline: "Browse **anything**", layout: "hero-bleed" },
  ],
  textStyle: { accentColor: "#6d5dfc" },
});

const rec = await call("record_simulator", { simulator, bundleId: "com.apple.Preferences", duration: 4 });
await call("create_video", {
  devices: [{ screenshot: rec.poster, video: rec.video }],
  canvas: "9:16",
  background: "sunset",
  headline: "See it **move**",
  quality: "preview",
  video: { motion: "subtle" },
});
await call("create_video", {
  devices: [{ screenshot: shot, highlights: alertPending ? [] : [{ style: "loupe", text: "Apple Account" }] }],
  canvas: "1:1",
  background: "graphite",
  format: "gif",
  quality: "preview",
  video: { duration: 3, motion: "float", zoom: { start: 1, end: 2.8 } },
});

await call("capture_mac", { listWindows: true });

// Errors must come back as tool errors with a useful message, not crash the server.
await call("create_mockup", { devices: [{ screenshot: "/nope/missing.png" }] }, true);
await call("create_mockup", { devices: [{ screenshot: shot, device: "Nokia 3310" }] }, true);
await call("create_mockup", { devices: [{ screenshot: shot }], background: { generate: "misty lake" } }, !process.env.OPENAI_API_KEY && !process.env.GEMINI_API_KEY);
await call("find_text", { screenshot: shot, query: "definitely-not-on-screen" });
await call("list_simulators", {});

await client.close();
console.log(`\n${failures ? `${failures} FAILED` : "ALL PASSED"} — files in ${out}`);
process.exit(failures ? 1 : 0);
