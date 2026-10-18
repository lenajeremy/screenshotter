/**
 * Screen recordings from the capture bar, as the Studio edits and exports them: opening one (the
 * recording filling a canvas its size, the webcam its own layer that stays put), its cursor drawn
 * from the log beside it and switching cursors, zooms onto the clicks (and only those going when
 * auto zoom is turned off), the video following the playhead, and the export (its length, its
 * sound). With the Mac app's renderer (SCREENSHOTTER_NATIVE, or --native with a built app), the
 * fast export too, checked against the usual one frame by frame. Its own library, made-up footage.
 *
 *   npm run test:recording                 the Studio in Chromium and WebKit, and the export
 *   npm run test:recording -- --native     also the app's fast export (build the app first)
 *   npm run test:recording -- --native-only
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium, webkit, type Page } from "playwright";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const args = process.argv.slice(2);
const nativeOnly = args.includes("--native-only");
const appBin = path.join(root, "build", "Screenshotter.app", "Contents", "MacOS", "Screenshotter");
const native = process.env.SCREENSHOTTER_NATIVE ?? (args.includes("--native") || nativeOnly ? appBin : undefined);
if ((args.includes("--native") || nativeOnly) && !existsSync(native ?? "")) throw new Error(`No app to draw with at ${native}: run npm run app:build first.`);
// The Studio's own exports take the usual way unless this test asks for the fast one.
delete process.env.SCREENSHOTTER_NATIVE;

const tmp = mkdtempSync(path.join(os.tmpdir(), "screenshotter-rec-"));
const LIB = path.join(tmp, "library");
const REC = path.join(LIB, "recordings");
const PARTS = path.join(REC, ".parts", "mac-screen-fixture");
mkdirSync(PARTS, { recursive: true });
writeFileSync(path.join(tmp, "studio.json"), JSON.stringify({ folder: LIB }));
process.env.SCREENSHOTTER_STUDIO_FILE = path.join(tmp, "studio.json");
process.env.SCREENSHOTTER_SEEN_FILE = path.join(tmp, "seen.json");
// What's new never opens over the tests.
writeFileSync(path.join(tmp, "seen.json"), JSON.stringify({ seen: "999.0.0" }));
process.env.SCREENSHOTTER_STYLE_FILE = path.join(tmp, "style.json");
process.env.SCREENSHOTTER_OUTPUT_DIR = LIB;

const { startStudio } = await import("../src/studio/server.js");
const { createVideo } = await import("../src/render/video.js");
const { closeBrowser } = await import("../src/render/browser.js");

const ff = (...a: string[]) => {
  const r = spawnSync("ffmpeg", ["-y", "-loglevel", "error", ...a], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`ffmpeg ${a.join(" ")}: ${r.stderr}`);
  return r.stderr;
};
/** Seconds long, and how loud (mean dB), of a video. */
const probe = (file: string) => {
  const r = spawnSync("ffmpeg", ["-hide_banner", "-nostats", "-i", file, "-map", "0:a?", "-af", "volumedetect", "-f", "null", "-"], { encoding: "utf8" });
  const dur = /Duration: (\d+):(\d+):([\d.]+)/.exec(r.stderr);
  const vol = /mean_volume: (-?[\d.]+) dB/.exec(r.stderr);
  return { seconds: dur ? Number(dur[1]) * 3600 + Number(dur[2]) * 60 + Number(dur[3]) : 0, volume: vol ? Number(vol[1]) : -Infinity };
};

// The footage: a 4 s screen recording with a tone, a square webcam clip, and a cursor log with
// three clicks (two close together, one later) and the cursor changing on the way.
const video = path.join(REC, "mac-screen-fixture.mp4");
const poster = path.join(REC, "mac-screen-fixture.png");
const cam = path.join(PARTS, "camera-edit.mp4");
const camPoster = path.join(PARTS, "camera-edit.png");
const log = path.join(PARTS, "cursor.json");
// Tagged as HD colour, as a Mac's recordings are, so there's no guessing how it looks.
const hd = ["-vf", "scale=out_color_matrix=bt709", "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709"];
ff("-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=30", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000", "-t", "4", ...hd, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", video);
ff("-ss", "0.1", "-i", video, "-frames:v", "1", poster);
ff("-f", "lavfi", "-i", "testsrc=size=480x480:rate=30", "-t", "4", ...hd, "-c:v", "libx264", "-pix_fmt", "yuv420p", cam);
ff("-ss", "0.1", "-i", cam, "-frames:v", "1", camPoster);
const samples = Array.from({ length: 241 }, (_, i) => {
  const t = i / 60;
  return [t, 0.2 + 0.12 * t + 0.01 * Math.sin(t * 37), 0.35 + 0.1 * Math.sin(t) + 0.008 * Math.cos(t * 41)].map((v) => Math.round(v * 10000) / 10000);
});
writeFileSync(log, JSON.stringify({ version: 1, width: 1280, height: 720, samples, clicks: [[0.9, 0.31, 0.43, "down"], [1.0, 0.31, 0.43, "up"], [1.7, 0.4, 0.45, "down"], [3.4, 0.62, 0.4, "down"]], kinds: [[0, "arrow"], [2, "text"], [3, "hand"]] }));
const spec = {
  video, poster, width: 1280, height: 720, duration: 4, name: "Recording test", saveName: "Screen Recording test", saveTo: path.join(tmp, "desktop"), cursor: log,
  // Dragged across at 1.5 s (a curving drag), then made bigger at 2.2 s.
  camera: {
    video: cam, poster: camPoster, x: 0.1, y: 0.8, height: 0.25, radius: 0.5, ring: true, endsAt: 3,
    path: [[0, 0.1, 0.8, 0.25], [1.5, 0.15, 0.78, 0.25], [1.533, 0.3, 0.6, 0.25], [1.566, 0.45, 0.62, 0.25], [1.6, 0.6, 0.7, 0.25], [2.2, 0.6, 0.7, 0.3], [2.233, 0.6, 0.7, 0.35]],
  },
};
mkdirSync(spec.saveTo, { recursive: true });

let failed = 0;
// The sound as the Sound row left it (cut, a piece deleted, one moved), to export.
let soundsFromUI: Array<{ at: number; from: number; to: number }> | null = null;
const check = async (name: string, fn: () => Promise<string | void>) => {
  try {
    const note = await fn();
    console.log(`PASS ${name}${note ? ` (${note})` : ""}`);
  } catch (e) {
    failed++;
    console.log(`FAIL ${name}: ${(e as Error).message}`);
  }
};
const expect = (ok: unknown, why: string) => {
  if (!ok) throw new Error(why);
};

// The Studio, as people use it.
const server = nativeOnly ? null : await startStudio(0, false);
const BASE = server ? `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}/` : "";
const S = <T,>(page: Page, fn: (arg: any) => T | Promise<T>, arg?: unknown) => page.evaluate(fn as never, arg) as Promise<T>;
for (const [name, engine] of nativeOnly ? [] : ([["chromium", chromium], ["webkit", webkit]] as const)) {
  if (args.some((a) => a === "chromium" || a === "webkit") && !args.includes(name)) continue;
  // Silent: the recordings play with their sound on (that's checked), but never out loud.
  const browser = await engine.launch(name === "chromium" ? { args: ["--mute-audio"] } : {});
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.addInitScript(() => {
    // Every volume set is 0, so the Sound row's players never play out loud either.
    const play = HTMLMediaElement.prototype.play;
    const volume = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "volume")!;
    Object.defineProperty(HTMLMediaElement.prototype, "volume", { configurable: true, get: volume.get, set() { volume.set!.call(this, 0); } });
    HTMLMediaElement.prototype.play = function () {
      this.volume = 0;
      return play.call(this);
    };
  });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(BASE);
  await page.waitForFunction(() => (window as any).studio?.state?.ready, null, { timeout: 30000 });
  await S(page, (s) => (window as any).studio.command("openRecording", s), spec);
  await page.waitForFunction(() => (window as any).studio.state.scene.recording?.autoZoom && document.querySelector(".rec-cursor svg"), null, { timeout: 15000 }).catch(() => undefined);
  const pad = name.padEnd(8);

  await check(`${pad} a recording opens in Animate: its size, the recording filling it, the webcam its own layer that stays put`, async () => {
    const st = await S(page, () => {
      const s = (window as any).studio.state;
      return { open: s.timelineOpen, canvas: s.scene.canvas, devices: s.scene.devices.map((d: any) => [d.label, d.frame, Boolean(d.fixed)]), panel: document.querySelector(".panel.right h2")?.textContent };
    });
    if (process.env.SHOTS) {
      await new Promise((r) => setTimeout(r, 2500));
      await S(page, async () => (await import("/ui/store.js" as string)).set({ modal: null }));
      await new Promise((r) => setTimeout(r, 300));
      await page.screenshot({ path: path.join(process.env.SHOTS, `${name}-opened.png`) });
    }
    expect(st.open, "Animate isn't open");
    expect(st.canvas?.width === 1280 && st.canvas?.height === 720, `canvas ${JSON.stringify(st.canvas)}`);
    expect(JSON.stringify(st.devices) === JSON.stringify([["Recording", "none", false], ["Webcam", "card", true]]), `devices ${JSON.stringify(st.devices)}`);
    expect(st.panel === "Recording", `panel says ${st.panel}`);
  });

  await check(`${pad} moving and resizing the webcam while recording does the same in the video`, async () => {
    const moves = await S(page, () => ((window as any).studio.state.scene.animations ?? []).filter((a: any) => a.targets === "device-2" && a.to));
    expect(moves.length >= 2 && moves.length <= 5, `${moves.length} moves`);
    const last = moves[moves.length - 1];
    // Where it went over the recording, which opens framed (5% of room round it).
    const framed = (v: number) => 0.5 + (v - 0.5) * 0.9;
    expect(Math.abs(last.to.x - framed(0.6)) < 0.01 && Math.abs(last.to.y - framed(0.7)) < 0.01 && Math.abs(last.to.scale - 1.4) < 0.01, `ends at ${JSON.stringify(last.to)}`);
    expect(moves[0].at >= 1.4 && moves[0].at <= 1.5, `starts at ${moves[0].at}`);
    return `${moves.length} moves`;
  });

  await check(`${pad} the timeline zooms in (it scrolls sideways) and fits again`, async () => {
    const r = await S(page, async () => {
      const body = document.querySelector(".tl-body") as HTMLElement;
      const fit = { scroll: body.scrollWidth - body.clientWidth };
      const edge = body.getBoundingClientRect().left + body.clientWidth;
      for (let n = 0; n < 4; n++) (document.querySelector('.tl-zoom button[title="Zoom in"]') as HTMLButtonElement).click();
      await new Promise((r) => setTimeout(r, 300));
      const ticks = document.querySelectorAll(".tl-tick").length;
      const zoomed = { scroll: body.scrollWidth - body.clientWidth, ticks };
      (document.querySelector(".tl-zoom .btn") as HTMLButtonElement).click();
      await new Promise((r) => setTimeout(r, 300));
      return { fit, zoomed, back: body.scrollWidth - body.clientWidth };
    });
    expect(r.fit.scroll <= 2, `fit scrolls by ${r.fit.scroll}`);
    expect(r.zoomed.scroll > 300, `zoomed in scrolls by only ${r.zoomed.scroll}`);
    expect(r.back <= 2, `Fit left it scrolling by ${r.back}`);
  });

  await check(`${pad} zooms land on the clicks, and turning auto zoom off removes only those`, async () => {
    const zooms = await S(page, () => ((window as any).studio.state.scene.animations ?? []).filter((a: any) => a.targets === "camera" && a.auto).length);
    expect(zooms >= 3, `${zooms} automatic zooms`);
    const left = await S(page, async () => {
      const st = await import("/ui/store.js" as string);
      st.edit((d: any) => d.animations.push({ targets: "camera", at: 3.6, duration: 0.3, to: { zoom: 1.3, x: 0.5, y: 0.5 } }));
      const r = await import("/ui/recording.js" as string);
      await r.setAutoZoom(false);
      return ((window as any).studio.state.scene.animations ?? []).filter((a: any) => a.targets === "camera").map((a: any) => Boolean(a.auto));
    });
    expect(JSON.stringify(left) === "[false]", `left ${JSON.stringify(left)}`);
    const back = await S(page, async () => (await import("/ui/recording.js" as string)).setAutoZoom(true));
    expect(back === zooms, `${back} zooms when turned back on`);
    return `${zooms} zooms`;
  });

  await check(`${pad} the cursor follows the playhead and changes as macOS's did`, async () => {
    const at = (t: number) =>
      S(page, async (t: number) => {
        (await import("/ui/timeline.js" as string)).setPlayhead(t);
        await new Promise((r) => setTimeout(r, 150));
        const c = document.querySelector(".rec-cursor > div:last-child") as HTMLElement;
        return { tf: c?.style.transform ?? "", d: c?.querySelector("path")?.getAttribute("d")?.slice(0, 6) ?? "" };
      }, t);
    const [a, b, c] = [await at(0.5), await at(2.5), await at(3.5)];
    expect(a.tf && a.tf !== b.tf, `it didn't move (${a.tf} / ${b.tf})`);
    expect(new Set([a.d, b.d, c.d]).size === 3, `cursors ${a.d} ${b.d} ${c.d}`);
  });

  await check(`${pad} playing plays the recording with its sound; scrubbing shows the frame at the playhead`, async () => {
    const r = await S(page, async () => {
      const tl = await import("/ui/timeline.js" as string);
      tl.setPlayhead(0);
      tl.play();
      await new Promise((r) => setTimeout(r, 1200));
      const playing = [...document.querySelectorAll<HTMLVideoElement>("video[data-follow]")].map((v) => ({ t: v.currentTime, muted: v.muted, paused: v.paused, master: Boolean(v.dataset.master) }));
      // The recording sets the pace: the playhead is where it is. Its sound plays from the Sound row.
      const master = document.querySelector<HTMLVideoElement>("video[data-master]")!;
      const lead = Math.abs(tl.playhead.t - master.currentTime);
      const sound = (await import("/ui/sound.js" as string)).soundPlayers().map((p: { t: number; paused: boolean }) => ({ ...p, off: p.t - master.currentTime }));
      tl.pause();
      tl.setPlayhead(2.5);
      await new Promise((r) => setTimeout(r, 400));
      const still = [...document.querySelectorAll<HTMLVideoElement>("video[data-follow]")].map((v) => ({ t: v.currentTime, paused: v.paused }));
      return { playing, still, lead, sound };
    });
    expect(r.lead < 0.1, `the playhead is ${r.lead.toFixed(2)} s from the recording`);
    expect(r.playing.length === 2 && r.playing.every((v) => v.t > 0.5 && !v.paused && !v.muted), `playing ${JSON.stringify(r.playing)}`);
    expect(!r.sound.some((p) => !p.paused), `nothing's moved, yet a sound player plays: ${JSON.stringify(r.sound)}`);
    expect(r.still.every((v) => v.paused && Math.abs(v.t - 2.5) < 0.05), `scrubbed ${JSON.stringify(r.still)}`);
  });

  await check(`${pad} the webcam keeps in step with the recording as it plays (lips with the voice)`, async () => {
    const offs = await S(page, async () => {
      const tl = await import("/ui/timeline.js" as string);
      tl.setPlayhead(0);
      tl.play();
      const master = document.querySelector<HTMLVideoElement>("video[data-master]")!;
      const cam = document.querySelector<HTMLVideoElement>("video[data-follow]:not([data-master])")!;
      const out: number[] = [];
      await new Promise((r) => setTimeout(r, 700));
      for (let k = 0; k < 20 && !master.paused; k++) {
        await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 80)));
        out.push(cam.currentTime - master.currentTime);
      }
      tl.pause();
      return out;
    });
    const worst = Math.max(...offs.map(Math.abs));
    expect(offs.length >= 10 && worst < 0.08, `the webcam is up to ${(worst * 1000).toFixed(0)} ms off the recording (${offs.map((o) => Math.round(o * 1000)).join(", ")} ms)`);
    return `within ${(worst * 1000).toFixed(0)} ms`;
  });

  await check(`${pad} the Sound row: a waveform, cut at the playhead, a piece deleted, one dragged later`, async () => {
    const r = await S(page, async () => {
      const tl = await import("/ui/timeline.js" as string);
      const snd = await import("/ui/sound.js" as string);
      const st = (window as any).studio.state;
      tl.pause();
      let drawn = 0;
      for (let k = 0; k < 40 && !drawn; k++) {
        await new Promise((r) => setTimeout(r, 100));
        const cv = document.querySelector<HTMLCanvasElement>(".tl-row.sound .tl-sound canvas");
        if (cv && cv.width > 1) {
          const d = cv.getContext("2d")!.getImageData(0, 0, cv.width, cv.height).data;
          for (let i = 3; i < d.length; i += 4) if (d[i] > 0) drawn++;
        }
      }
      const name = document.querySelector(".tl-name.sound")?.textContent?.trim();
      tl.setPlayhead(1.5);
      tl.cutSoundHere();
      tl.setPlayhead(2.5);
      tl.cutSoundHere();
      const cut = st.scene.sounds.map((c: any) => [c.at, c.from, c.to]);
      await new Promise((r) => setTimeout(r, 100));
      const panel = document.querySelector(".panel.right h2")?.textContent;
      snd.deleteSound(1);
      // Out of the way of the mouse: any dialog that opened on its own (What's new, say).
      const modal = st.modal?.kind ?? null;
      (await import("/ui/store.js" as string)).set({ modal: null });
      await new Promise((r) => setTimeout(r, 250));
      document.querySelector(".tl-row.sound")?.scrollIntoView({ block: "nearest" });
      await new Promise((r) => setTimeout(r, 100));
      const pieces = [...document.querySelectorAll<HTMLElement>(".tl-row.sound .tl-sound")].map((e) => {
        const b = e.getBoundingClientRect();
        const hit = document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2);
        return { x: b.x, y: b.y, w: b.width, h: b.height, hit: hit === e || e.contains(hit) ? "piece" : `${hit?.tagName}.${hit?.className}` };
      });
      return { drawn, name, cut, panel, pieces, modal, pps: document.querySelector<HTMLElement>(".tl-tracks")!.getBoundingClientRect().width / 4 };
    });
    expect(r.drawn > 100, `the waveform isn't drawn (${r.drawn} pixels)`);
    expect(r.name === "Sound", `the row is called ${r.name}`);
    expect(JSON.stringify(r.cut) === JSON.stringify([[0, 0, 1.5], [1.5, 1.5, 2.5], [2.5, 2.5, 4]]), `cut into ${JSON.stringify(r.cut)}`);
    expect(r.panel === "Sound", `the panel says ${r.panel}`);
    expect(r.pieces.length === 2, `${r.pieces.length} pieces after deleting one`);
    expect(r.pieces[1].hit === "piece", `the piece is under ${r.pieces[1].hit} (dialog: ${r.modal})`);
    // The last piece, dragged half a second later.
    const p = r.pieces[1];
    await page.mouse.move(p.x + p.w / 2, p.y + p.h / 2);
    await page.mouse.down();
    await page.mouse.move(p.x + p.w / 2 + 0.25 * r.pps, p.y + p.h / 2, { steps: 4 });
    await page.mouse.move(p.x + p.w / 2 + 0.5 * r.pps, p.y + p.h / 2, { steps: 4 });
    await page.mouse.up();
    const sounds = await S<Array<{ at: number; from: number; to: number }>>(page, () => (window as any).studio.state.scene.sounds);
    expect(Math.abs(sounds[1].at - 3) < 0.03 && sounds[1].from === 2.5, `dragged to ${JSON.stringify(sounds[1])}`);
    soundsFromUI ??= sounds;
    const heard = await S(page, async (engine: string) => {
      const snd = await import("/ui/sound.js" as string);
      const tl = await import("/ui/timeline.js" as string);
      const gains = [0.8, 2, 3.2].map((t) => snd.recordingGain(t));
      if (engine !== "chromium") return { gains, off: null };
      // Played: the moved piece (2.5–4 s of the recording, now at 3 s) on its own player.
      tl.setPlayhead(3.1);
      tl.play();
      await new Promise((r) => setTimeout(r, 600));
      const master = document.querySelector<HTMLVideoElement>("video[data-master]")!;
      const p = snd.soundPlayers()[0];
      const off = p && !p.paused ? p.t - (master.currentTime - 3 + 2.5) : null;
      tl.pause();
      return { gains, off };
    }, name);
    expect(JSON.stringify(heard.gains) === "[1,0,0]", `the recording's own sound at 0.8, 2 and 3.2 s: ${JSON.stringify(heard.gains)}`);
    expect(name !== "chromium" || (heard.off !== null && Math.abs(heard.off) < 0.08), `the moved piece plays ${heard.off === null ? "not at all" : `${Math.round(heard.off * 1000)} ms off`}`);
    if (process.env.SHOTS) await page.screenshot({ path: path.join(process.env.SHOTS, `${name}-sound.png`) });
    return `${r.drawn} waveform pixels; ${sounds.map((c) => `${c.from}–${c.to} s at ${c.at} s`).join(", ")}`;
  });

  if (name === "chromium") {
    await check(`${pad} exporting shows how far along it is, and about how long is left`, async () => {
      const seen = await S(page, async () => {
        const a = await import("/ui/actions.js" as string);
        const st = (window as any).studio.state;
        const seen: Array<[number, number | null]> = [];
        const watch = setInterval(() => st.rendering?.progress !== undefined && seen.push([st.rendering.progress, st.rendering.left ?? null]), 200);
        await a.exportVideo();
        clearInterval(watch);
        const shown = document.querySelector(".render-progress") ? true : false;
        return { seen, shown };
      });
      const mid = seen.seen.filter(([p]) => p > 0.05 && p < 0.95);
      expect(mid.length >= 2, `progress seen: ${JSON.stringify(seen.seen.slice(0, 8))}`);
      expect(mid.some(([, left]) => left !== null && left > 0), "no time left was shown");
      expect(seen.seen.every(([p], i) => i === 0 || p >= seen.seen[i - 1][0]), "it went backwards");
      return `${mid.length} readings mid-way`;
    });
  }

  await check(`${pad} a screenshot opens as a design of its own, without a frame; more added come in frameless too`, async () => {
    const r = await S(page, async (img: string) => {
      const st = (window as any).studio.state;
      await (window as any).studio.command("openRecording", { image: img, width: 1280, height: 720, name: "Screenshot test" });
      await new Promise((r) => setTimeout(r, 800));
      const opened = { canvas: st.scene.canvas, frame: st.scene.devices[0].frame, plain: st.scene.plain, panel: document.querySelector(".panel.right h2")?.textContent };
      const rec = await import("/ui/recording.js" as string);
      await rec.setFrame({ padding: 0.06 });
      const padded = { height: st.scene.devices[0].height, background: st.scene.background };
      const a = await import("/ui/actions.js" as string);
      a.addDevice(img);
      await new Promise((r) => setTimeout(r, 300));
      const second = st.scene.devices[1]?.frame;
      // A fresh design, with the Screenshots panel set to add them without a frame.
      await a.newScene();
      (await import("/ui/store.js" as string)).set({ capture: { ...st.capture, frame: "none" } });
      a.addDevice(img);
      await new Promise((r) => setTimeout(r, 300));
      const fresh = { frame: st.scene.devices[0]?.frame, guide: st.guide };
      return { opened, padded, second, fresh };
    }, poster);
    expect(r.opened.canvas?.width === 1280 && r.opened.frame === "none" && r.opened.plain && r.opened.panel === "Screenshot", `opened ${JSON.stringify(r.opened)}`);
    expect(r.padded.height < 1 && r.padded.background !== "#000000", `padded ${JSON.stringify(r.padded)}`);
    expect(r.second === "none", `the second came in with frame ${r.second}`);
    expect(r.fresh.frame === "none" && r.fresh.guide !== "design", `fresh ${JSON.stringify(r.fresh)}`);
  });

  await check(`${pad} no page errors`, async () => expect(!errors.length, errors.join(" | ")));
  await browser.close();
}

// The export: the usual way, then (with the app) the fast one, which should look the same.
const input = (out: string) => ({
  canvas: { width: 1280, height: 720 },
  background: "#000000",
  devices: [
    { screenshot: poster, video, frame: "none" as const, x: 0.5, y: 0.5, height: 1, shadow: "none" as const },
    { screenshot: camPoster, video: cam, frame: "card" as const, radius: 0.5, ring: true, shadow: "medium" as const, fixed: true, x: 0.1, y: 0.8, height: 0.25 },
  ],
  animations: [
    { targets: "camera", at: 0.3, duration: 0.6, to: { zoom: 1.8, x: 0.31, y: 0.43 } },
    { targets: "camera", at: 1.3, duration: 0.4, to: { zoom: 1.8, x: 0.4, y: 0.45 } },
    { targets: "camera", at: 3.2, duration: 0.6, to: { zoom: 1 } },
    { targets: "device-2", at: 2.6, exit: "fade" as const, duration: 0.4 },
  ],
  video: { duration: 4, motion: "none" as const, sound: true, cursor: { device: 0, log, smooth: 0.5, size: 1.4, ripple: true }, follow: true },
  output: out,
});
const usual = path.join(tmp, "usual.mp4");
if (!nativeOnly) {
  await check("the export runs the recording's length, with its sound", async () => {
    const t0 = Date.now();
    const r = await createVideo(input(usual) as never);
    const p = probe(usual);
    expect(Math.abs(p.seconds - 4) < 0.1, `${p.seconds} s`);
    expect(p.volume > -40, `sound at ${p.volume} dB`);
    expect(!r.warnings?.length, `warnings: ${r.warnings?.join(" ")}`);
    return `${((Date.now() - t0) / 1000).toFixed(1)} s`;
  });
}
if (!nativeOnly) {
  await check("the export's sound is where the Sound row put it (cut, a piece deleted, one moved)", async () => {
    expect(soundsFromUI, "the Sound row check didn't get that far");
    const out = path.join(tmp, "cut.mp4");
    await createVideo({ ...input(out), sounds: soundsFromUI } as never);
    const loud = (from: number, to: number) => {
      const r = spawnSync("ffmpeg", ["-hide_banner", "-nostats", "-ss", String(from), "-t", String(to - from), "-i", out, "-af", "volumedetect", "-f", "null", "-"], { encoding: "utf8" });
      const m = /mean_volume: (-?[\d.]+|-inf) dB/.exec(r.stderr)?.[1];
      return m === undefined || m === "-inf" ? -Infinity : Number(m);
    };
    const parts = [loud(0.2, 1.3), loud(1.7, 2.8), loud(3.2, 3.9)];
    expect(parts[0] > -40 && parts[1] < -60 && parts[2] > -40, `loudness: ${parts.map((v) => v.toFixed(0)).join(", ")} dB (sound, silence, sound wanted)`);
    return `${parts.map((v) => (Number.isFinite(v) ? v.toFixed(0) : "silent")).join(" / ")} dB`;
  });
}
if (native) {
  await check("the voice stays with the picture through gaps in the sound (the app's writer)", async () => {
    const r = spawnSync(native, ["--sync-test", path.join(tmp, "sync")], { encoding: "utf8", timeout: 120_000 });
    const line = r.stdout.split("\n").find((l) => /^(PASS|FAIL) /.test(l)) ?? r.stderr.slice(-300);
    expect(r.status === 0, line);
    return line.replace(/^PASS [^:]+: /, "");
  });
  await check("the fast export (the app, on the GPU) looks like the usual one, with its sound", async () => {
    if (!existsSync(usual)) await createVideo(input(usual) as never);
    process.env.SCREENSHOTTER_NATIVE = native;
    const fast = path.join(tmp, "fast.mp4");
    const t0 = Date.now();
    const r = await createVideo(input(fast) as never);
    const secs = (Date.now() - t0) / 1000;
    delete process.env.SCREENSHOTTER_NATIVE;
    expect(!r.warnings?.length, `warnings: ${r.warnings?.join(" ")}`);
    const p = probe(fast);
    expect(Math.abs(p.seconds - 4) < 0.1 && p.volume > -40, `${p.seconds} s, sound at ${p.volume} dB`);
    // Frame by frame against the usual export.
    const cmp = spawnSync("ffmpeg", ["-hide_banner", "-nostats", "-i", usual, "-i", fast, "-lavfi", "[0:v][1:v]psnr", "-f", "null", "-"], { encoding: "utf8" });
    const psnr = /average:([\d.]+|inf)/.exec(cmp.stderr);
    const db = psnr ? (psnr[1] === "inf" ? 99 : Number(psnr[1])) : 0;
    expect(db > 24, `only ${db.toFixed(1)} dB alike`);
    return `${secs.toFixed(1)} s, ${db.toFixed(1)} dB alike`;
  });
}

await closeBrowser();
server?.close();
if (process.env.KEEP) console.log("kept", tmp);
else rmSync(tmp, { recursive: true, force: true });
console.log(failed ? `\n${failed} recording check${failed === 1 ? "" : "s"} failed.` : "\nAll recording checks passed.");
process.exit(failed ? 1 : 0);
