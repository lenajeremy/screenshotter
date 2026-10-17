/**
 * The fast export (the Mac app drawing videos on the GPU) against the usual one (the browser,
 * frame by frame), design by design: the same video both ways, compared frame by frame (PSNR),
 * with how long each took. Needs the app built (npm run app:build) or SCREENSHOTTER_NATIVE.
 *
 *   npm run test:fast                every design
 *   npm run test:fast -- phone mov   only the designs whose names contain these words
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const native = process.env.SCREENSHOTTER_NATIVE ?? path.join(root, "build", "Screenshotter.app", "Contents", "MacOS", "Screenshotter");
if (!existsSync(native)) throw new Error(`No app to draw with at ${native}: run npm run app:build first.`);
delete process.env.SCREENSHOTTER_NATIVE;
const only = process.argv.slice(2).filter((a) => !a.startsWith("-"));

const tmp = mkdtempSync(path.join(os.tmpdir(), "screenshotter-fast-"));
process.env.SCREENSHOTTER_OUTPUT_DIR = path.join(tmp, "library");
mkdirSync(process.env.SCREENSHOTTER_OUTPUT_DIR, { recursive: true });
const { createVideo } = await import("../src/render/video.js");
const { createSequence } = await import("../src/render/sequence.js");
const { closeBrowser } = await import("../src/render/browser.js");

const ff = (...a: string[]) => {
  const r = spawnSync("ffmpeg", ["-y", "-loglevel", "error", ...a], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`ffmpeg: ${r.stderr}`);
};
const hd = ["-vf", "scale=out_color_matrix=bt709", "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709"];
// Footage: a phone-shaped screen recording, a Mac-shaped one with a tone, and their stills.
const phone = path.join(tmp, "phone.mp4");
const mac = path.join(tmp, "mac.mp4");
ff("-f", "lavfi", "-i", "testsrc2=size=590x1280:rate=30", "-t", "4", ...hd, "-c:v", "libx264", "-pix_fmt", "yuv420p", phone);
ff("-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=30", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000", "-t", "4", ...hd, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", mac);
const still = (v: string) => {
  const p = v.replace(/\.mp4$/, ".png");
  ff("-ss", "0.1", "-i", v, "-frames:v", "1", p);
  return p;
};
const phoneShot = still(phone);
// A webcam of one colour (blue), so a corner that isn't rounded away shows.
const cam = path.join(tmp, "cam.mp4");
ff("-f", "lavfi", "-i", "color=c=blue:size=480x480:rate=30", "-t", "2", ...hd, "-c:v", "libx264", "-pix_fmt", "yuv420p", cam);
const camShot = still(cam);
const macShot = still(mac);

/** A case, and optionally a spot (x, y, size as shares of the frame) whose colour must match too. */
type Case = { name: string; run: (out: string) => Promise<{ path: string }>; ext?: string; spot?: [number, number, number] };
const video = (input: Record<string, unknown>, ext = "mp4"): Case["run"] => (out) => createVideo({ ...input, output: out.replace(/\.mp4$/, `.${ext}`) } as never);
const cases: Case[] = [
  {
    name: "phone mockup, gentle motion, a caption by word, an arrow, film looks",
    run: video({
      devices: [{ screenshot: phoneShot, video: phone, frame: "device", device: "iPhone 17 Pro" }],
      headline: "Cook something new tonight",
      subheadline: "Recipes that fit your evening",
      shapes: [{ type: "arrow", from: { x: 0.15, y: 0.75 }, to: { x: 0.3, y: 0.62 } }],
      effects: { grain: 0.2, vignette: 0.3, grade: { preset: "warm-film", scope: "all" }, edgeBlur: { edges: "bottom" } },
      animations: [{ targets: "caption", at: 0.3, enter: "blur", by: "word" }, { targets: "shape-1", at: 1, enter: "fade" }],
      video: { duration: 3, motion: "subtle" },
    }),
  },
  {
    name: "recording, padded on a backdrop, rounded, shadowed, zooming in",
    run: video({
      canvas: { width: 1280, height: 720 },
      background: "meadow-motion",
      devices: [{ screenshot: macShot, video: mac, frame: "none", x: 0.5, y: 0.5, height: 0.84, radius: 0.025, shadow: "strong" }],
      animations: [{ targets: "camera", at: 0.5, duration: 0.7, to: { zoom: 1.8, x: 0.4, y: 0.45 } }, { targets: "camera", at: 2.4, duration: 0.6, to: { zoom: 1 } }],
      video: { duration: 3, motion: "none", sound: true },
    }),
  },
  {
    name: "phone floating in 3D, a moving backdrop",
    run: video({
      devices: [{ screenshot: phoneShot, video: phone, frame: "device", device: "iPhone 17 Pro" }],
      headline: "Float",
      animations: [{ targets: "backdrop", at: 0, duration: 3, to: { zoom: 1.15, hue: 30 } }],
      video: { duration: 3, motion: "float" },
    }),
  },
  {
    name: "a MacBook with a recording, sliding in, as a MOV",
    ext: "mov",
    run: video(
      {
        devices: [{ screenshot: macShot, video: mac, frame: "device", device: "MacBook Pro 14-inch", menuBar: false }],
        animations: [{ targets: "device-1", at: 0.2, enter: "slide-up", duration: 0.8 }],
        video: { duration: 3, motion: "none" },
      },
      "mov",
    ),
  },
  {
    name: "the phone design as a GIF and a WebM",
    ext: "gif",
    run: video({ devices: [{ screenshot: phoneShot, video: phone, frame: "card" }], headline: "Small and quick", video: { duration: 2, motion: "subtle" } }, "gif"),
  },
  {
    name: "an App Store preview of the phone",
    run: video({ devices: [{ screenshot: phoneShot, video: phone, frame: "device", device: "iPhone 17 Pro" }], headline: "On the App Store", video: { duration: 3, motion: "none" }, versions: ["app-store-iphone"] }),
  },
  {
    name: "a phone with a fingertip tapping its way through, from points",
    run: video({
      devices: [{ screenshot: phoneShot, video: phone, frame: "device", device: "iPhone 17 Pro" }],
      video: { duration: 3, motion: "none", cursor: { points: [{ t: 0, x: 0.3, y: 0.7 }, { t: 1, x: 0.6, y: 0.4, click: true }, { t: 2, x: 0.5, y: 0.8, click: true }] } },
    }),
  },
  {
    name: "a transparent MOV, no backdrop",
    ext: "mov",
    run: video({ background: { type: "transparent" }, devices: [{ screenshot: phoneShot, video: phone, frame: "card" }], video: { duration: 2, motion: "subtle" } }, "mov"),
  },
  {
    name: "a smaller delivery size",
    run: video({ devices: [{ screenshot: macShot, video: mac, frame: "none" }], headline: "Smaller", deliveryWidth: 640, video: { duration: 2, motion: "none" } }),
  },
  {
    name: "a round webcam stays round (its corner shows what's behind it)",
    spot: [0.2 - 0.18 * (720 / 1280), 0.7 - 0.18, 0.012],
    run: video({
      canvas: { width: 1280, height: 720 },
      background: "#000000",
      devices: [
        { screenshot: macShot, video: mac, frame: "none", x: 0.5, y: 0.5, height: 1, shadow: "none" },
        { screenshot: camShot, video: cam, frame: "card", radius: 0.5, ring: true, shadow: "medium", fixed: true, x: 0.2, y: 0.7, height: 0.4 },
      ],
      video: { duration: 1, motion: "none" },
    }),
  },
  {
    name: "a video of two shots",
    run: (out) =>
      createSequence({
        shots: [
          { devices: [{ screenshot: phoneShot, video: phone, frame: "device", device: "iPhone 17 Pro" }], headline: "One", video: { duration: 2, motion: "subtle" } },
          { devices: [{ screenshot: macShot, video: mac, frame: "none" }], headline: "Two", video: { duration: 2, motion: "none" } },
        ],
        output: out,
      } as never),
  },
];

let failed = 0;
for (const c of cases) {
  if (only.length && !only.some((w) => c.name.includes(w))) continue;
  try {
    const ext = c.ext ?? "mp4";
    const usual = path.join(tmp, `${cases.indexOf(c)}-usual.mp4`);
    const fast = path.join(tmp, `${cases.indexOf(c)}-fast.mp4`);
    let t0 = Date.now();
    const a = await c.run(usual);
    const slow = (Date.now() - t0) / 1000;
    process.env.SCREENSHOTTER_NATIVE = native;
    t0 = Date.now();
    const b = await c.run(fast);
    const quick = (Date.now() - t0) / 1000;
    delete process.env.SCREENSHOTTER_NATIVE;
    const warn = (b as { warnings?: string[] }).warnings?.find((w) => /fast export/.test(w));
    if (warn) throw new Error(warn);
    // Frame by frame, alike?
    const cmp = spawnSync("ffmpeg", ["-hide_banner", "-nostats", "-i", a.path, "-i", b.path, "-lavfi", "[0:v][1:v]scale2ref[x][y];[x][y]psnr", "-f", "null", "-"], { encoding: "utf8" });
    const m = /average:([\d.]+|inf)/.exec(cmp.stderr);
    const db = m ? (m[1] === "inf" ? 99 : Number(m[1])) : 0;
    let ok = db > (ext === "gif" ? 18 : 24);
    let note = "";
    if (c.spot) {
      // The same colour at the spot, both ways (a corner that should be rounded away, say).
      const colour = (file: string) => {
        const [x, y, size] = c.spot!;
        const r = spawnSync("ffmpeg", ["-v", "error", "-ss", "0.5", "-i", file, "-frames:v", "1", "-vf", `crop=iw*${size}:iw*${size}:iw*${x}:ih*${y},scale=1:1`, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]);
        return [...r.stdout.subarray(0, 3)];
      };
      const [p, q] = [colour(a.path), colour(b.path)];
      const off = Math.max(...p.map((v, i) => Math.abs(v - q[i])));
      if (off > 24) ok = false;
      note = `, the spot ${p.join(",")} vs ${q.join(",")}`;
    }
    if (!ok) failed++;
    console.log(`${ok ? "PASS" : "FAIL"} ${c.name}: ${quick.toFixed(1)} s fast, ${slow.toFixed(1)} s usual, ${db.toFixed(1)} dB alike${note}`);
  } catch (e) {
    failed++;
    console.log(`FAIL ${c.name}: ${(e as Error).message}`);
  } finally {
    delete process.env.SCREENSHOTTER_NATIVE;
  }
}
await closeBrowser();
if (process.env.KEEP) console.log("kept", tmp);
else rmSync(tmp, { recursive: true, force: true });
console.log(failed ? `\n${failed} failed.` : "\nThe fast export matches the usual one.");
process.exit(failed ? 1 : 0);
