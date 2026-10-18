/**
 * A video's sound, edge by edge: the Sound row in the Studio (cutting, deleting, moving, trimming,
 * snapping, nudging, undo, the keys and the menu, pieces that overlap or lost their file, the
 * sound turned off, playing) and the sound of exported videos (pieces cut, moved, turned down and
 * faded, cuts that carry straight on, files of other kinds mixed in, pieces past the end, nothing
 * at all, a video of several shots, a GIF, the fast export).
 *
 * The footage says where its sound came from: a quiet 200 Hz hum throughout, and a beep each
 * second (0.5–0.7 s past it), a step higher each time: 300, 500, 700, 900, 1100, 1300 Hz. Listening
 * for which beep is where tells which part of the recording plays when.
 *
 *   npm run test:sound                  the Studio in Chromium and WebKit, and the exports
 *   npm run test:sound -- chromium      one browser (or webkit); exports too
 *   npm run test:sound -- --native      also the app's fast export (build the app first)
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium, webkit, type Page } from "playwright";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const args = process.argv.slice(2);
const appBin = path.join(root, "build", "Screenshotter.app", "Contents", "MacOS", "Screenshotter");
const native = args.includes("--native") ? (process.env.SCREENSHOTTER_NATIVE ?? appBin) : undefined;
if (native && !existsSync(native)) throw new Error(`No app to draw with at ${native}: run npm run app:build first.`);
delete process.env.SCREENSHOTTER_NATIVE;

const tmp = mkdtempSync(path.join(os.tmpdir(), "screenshotter-sound-"));
const LIB = path.join(tmp, "library");
const REC = path.join(LIB, "recordings");
mkdirSync(REC, { recursive: true });
writeFileSync(path.join(tmp, "studio.json"), JSON.stringify({ folder: LIB }));
process.env.SCREENSHOTTER_STUDIO_FILE = path.join(tmp, "studio.json");
process.env.SCREENSHOTTER_SEEN_FILE = path.join(tmp, "seen.json");
// What's new never opens over the tests.
writeFileSync(path.join(tmp, "seen.json"), JSON.stringify({ seen: "999.0.0" }));
process.env.SCREENSHOTTER_STYLE_FILE = path.join(tmp, "style.json");
process.env.SCREENSHOTTER_OUTPUT_DIR = LIB;

const { startStudio } = await import("../src/studio/server.js");
const { createVideo } = await import("../src/render/video.js");
const { createSequence } = await import("../src/render/sequence.js");
const { closeBrowser } = await import("../src/render/browser.js");

const ff = (...a: string[]) => {
  const r = spawnSync("ffmpeg", ["-y", "-loglevel", "error", ...a], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`ffmpeg ${a.join(" ")}: ${r.stderr}`);
};

// The recording (6 s, stereo, 48 kHz), its still, and a piece of music of another kind (mono,
// 44.1 kHz, a steady 1700 Hz) to mix in.
const video = path.join(REC, "mac-screen-sound.mp4");
const poster = path.join(REC, "mac-screen-sound.png");
const music = path.join(LIB, "music.m4a");
ff("-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30", "-f", "lavfi", "-i", "aevalsrc=0.1*sin(2*PI*200*t)+0.6*between(mod(t\\,1)\\,0.5\\,0.7)*sin(2*PI*(300+200*floor(t))*t):s=48000:c=stereo", "-t", "6", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", "-shortest", video);
ff("-ss", "0.1", "-i", video, "-frames:v", "1", poster);
ff("-f", "lavfi", "-i", "sine=frequency=1700:sample_rate=44100", "-t", "3", "-af", "volume=4", "-ac", "1", "-c:a", "aac", music);
const BEEPS = [300, 500, 700, 900, 1100, 1300];

// ---------------------------------------------------------------------------------------------
// Listening

const RATE = 8000;
/** A file's sound, mono, 8 kHz. Empty when it has none. */
function pcm(file: string): Float32Array {
  const r = spawnSync("ffmpeg", ["-v", "error", "-i", file, "-vn", "-ac", "1", "-ar", String(RATE), "-f", "f32le", "-"], { maxBuffer: 1 << 28 });
  const b = r.stdout ?? Buffer.alloc(0);
  return new Float32Array(b.buffer, b.byteOffset, Math.floor(b.length / 4));
}
/** How strong a frequency is in a stretch of sound (a sine of amplitude A reads about A / 2). */
function level(x: Float32Array, at: number, n: number, f: number): number {
  const k = 2 * Math.cos((2 * Math.PI * f) / RATE);
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < n && at + i < x.length; i++) {
    const s = x[at + i] + k * s1 - s2;
    s2 = s1;
    s1 = s;
  }
  return Math.sqrt(Math.max(0, s1 * s1 + s2 * s2 - k * s1 * s2)) / n;
}
/** Each beep heard: its pitch, when it starts and how loud (seconds; 20 ms windows, 5 ms apart). */
function beeps(x: Float32Array, freqs = [...BEEPS, 1700]): Array<{ f: number; t: number; v: number }> {
  const win = 160;
  const hop = 40;
  const out: Array<{ f: number; t: number; v: number }> = [];
  for (const f of freqs) {
    let on = false;
    for (let at = 0; at + win <= x.length; at += hop) {
      const v = level(x, at, win, f);
      if (!on && v > 0.08) {
        on = true;
        // How loud: a little way in.
        out.push({ f, t: (at + win / 2) / RATE, v: level(x, at + win, win, f) });
      } else if (on && v < 0.03) on = false;
    }
  }
  return out.sort((a, b) => a.t - b.t);
}
/** The hum's strength around a moment (20 ms). */
const hum = (x: Float32Array, t: number) => level(x, Math.max(0, Math.round(t * RATE) - 80), 160, 200);
const heard = (b: Array<{ f: number; t: number }>) => b.map((x) => `${x.f}@${x.t.toFixed(2)}`).join(" ");
/** The beeps heard are just these, each within 30 ms of when it should be. */
function expectBeeps(got: Array<{ f: number; t: number }>, want: Array<[number, number]>) {
  const ok = got.length === want.length && want.every(([f, t], i) => got[i].f === f && Math.abs(got[i].t - t) < 0.03);
  expect(ok, `heard ${heard(got)}; wanted ${want.map(([f, t]) => `${f}@${t.toFixed(2)}`).join(" ")}`);
}
/** Seconds long, and whether there's a sound track at all. */
function probe(file: string) {
  const r = spawnSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type:format=duration", "-of", "json", file], { encoding: "utf8" });
  const j = JSON.parse(r.stdout || "{}") as { streams?: Array<{ codec_type: string }>; format?: { duration?: string } };
  return { seconds: Number(j.format?.duration ?? 0), sound: Boolean(j.streams?.some((s) => s.codec_type === "audio")) };
}

let failed = 0;
const check = async (name: string, fn: () => Promise<string | void>) => {
  try {
    const note = await fn();
    console.log(`PASS ${name}${note ? ` (${note})` : ""}`);
  } catch (e) {
    failed++;
    console.log(`FAIL ${name}: ${(e as Error).message}`);
  }
};
function expect(ok: unknown, why: string): asserts ok {
  if (!ok) throw new Error(why);
}

// ---------------------------------------------------------------------------------------------
// The Studio

const engines = [["chromium", chromium], ["webkit", webkit]] as const;
const only = engines.filter(([n]) => args.includes(n));
const server = await startStudio(0, false);
const BASE = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}/`;
const S = <T,>(page: Page, fn: (arg: any) => T | Promise<T>, arg?: unknown) => page.evaluate(fn as never, arg) as Promise<T>;
const spec = { video, poster, width: 640, height: 360, duration: 6, name: "Sound test" };

for (const [name, engine] of only.length ? only : engines) {
  // Silent: every volume set is 0, so nothing ever plays out loud.
  const browser = await engine.launch(name === "chromium" ? { args: ["--mute-audio"] } : {});
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.addInitScript(() => {
    const volume = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "volume")!;
    Object.defineProperty(HTMLMediaElement.prototype, "volume", { configurable: true, get: volume.get, set() { volume.set!.call(this, 0); } });
  });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(BASE);
  await page.waitForFunction(() => (window as any).studio?.state?.ready, null, { timeout: 30000 });
  const pad = name.padEnd(8);
  /** A fresh recording, opened as from the capture bar, its waveform drawn, nothing open over it. */
  const fresh = async () => {
    await S(page, (s) => (window as any).studio.command("openRecording", s), spec);
    await page.waitForFunction(() => document.querySelector(".tl-row.sound .tl-sound"), null, { timeout: 15000 });
    await S(page, async () => {
      (await import("/ui/store.js" as string)).set({ modal: null, menu: null });
      document.querySelector(".tl-row.sound")?.scrollIntoView({ block: "nearest" });
    });
    await page.waitForTimeout(400);
  };
  /** The pieces as [at, from, to] (to 3 places), and which is chosen. */
  const pieces = () => S<{ list: number[][]; sel: number | null }>(page, async () => {
    const snd = await import("/ui/sound.js" as string);
    const st = (window as any).studio.state;
    return { list: snd.soundClips(st.scene).map((c: any) => [c.at, c.from ?? 0, Math.round(snd.toOf(c) * 1000) / 1000]), sel: st.soundSel };
  });
  const same = (a: number[][], b: number[][]) => a.length === b.length && a.every((p, i) => p.every((v, k) => Math.abs(v - b[i][k]) < 0.011));
  /** Where piece i is on the screen, and pixels a second. */
  const box = (i: number) => S<{ x: number; y: number; w: number; h: number; pps: number }>(page, (k: number) => {
    const e = document.querySelectorAll<HTMLElement>(".tl-row.sound .tl-sound")[k];
    const b = e.getBoundingClientRect();
    const tracks = document.querySelector<HTMLElement>(".tl-tracks")!.getBoundingClientRect();
    return { x: b.x, y: b.y, w: b.width, h: b.height, pps: tracks.width / 6 };
  }, i);
  /** Drag from (x, y) by dx pixels. */
  const dragBy = async (x: number, y: number, dx: number) => {
    await page.mouse.move(x, y);
    await page.mouse.down();
    for (let k = 1; k <= 6; k++) await page.mouse.move(x + (dx * k) / 6, y);
    await page.mouse.up();
    await page.waitForTimeout(200);
  };
  const call = (fn: string, ...a: unknown[]) => S(page, async ([f, xs]: [string, unknown[]]) => {
    const tl = await import("/ui/timeline.js" as string);
    const snd = await import("/ui/sound.js" as string);
    const all = { ...tl, ...snd } as Record<string, (...x: unknown[]) => unknown>;
    return all[f](...xs);
  }, [fn, a]);

  await fresh();

  await check(`${pad} a recording's sound: one piece, the whole of it, its waveform drawn, the row named Sound`, async () => {
    const r = await S(page, () => {
      const cv = document.querySelector<HTMLCanvasElement>(".tl-row.sound .tl-sound canvas")!;
      const d = cv.getContext("2d")!.getImageData(0, 0, cv.width, cv.height).data;
      let ink = 0;
      for (let i = 3; i < d.length; i += 4) if (d[i] > 0) ink++;
      return { ink, name: document.querySelector(".tl-name.sound")?.textContent?.trim(), video: (window as any).studio.state.scene.recording?.video };
    });
    const p = await pieces();
    expect(same(p.list, [[0, 0, 6]]), `pieces ${JSON.stringify(p.list)}`);
    expect(r.ink > 200, `the waveform has ${r.ink} pixels`);
    expect(r.name === "Sound", `the row is called ${r.name}`);
    expect(r.video === video, "the design doesn't remember the recording's video");
  });

  await check(`${pad} cutting at the playhead makes two pieces that carry straight on; the second is chosen`, async () => {
    await call("setPlayhead", 2.5);
    expect(await call("cutSoundHere"), "it didn't cut");
    const p = await pieces();
    expect(same(p.list, [[0, 0, 2.5], [2.5, 2.5, 6]]) && p.sel === 1, `pieces ${JSON.stringify(p)}`);
  });

  await check(`${pad} no cut right at an end, or at the very start or end of the video (nothing changes)`, async () => {
    for (const t of [0, 0.02, 2.48, 2.52, 5.98, 6]) {
      await call("setPlayhead", t);
      expect(!(await call("cutSoundHere")), `it cut at ${t} s`);
    }
    const p = await pieces();
    expect(same(p.list, [[0, 0, 2.5], [2.5, 2.5, 6]]), `pieces ${JSON.stringify(p.list)}`);
  });

  await check(`${pad} ⌘B cuts the piece under the playhead even when another is chosen`, async () => {
    await call("selectSound", 1);
    await call("setPlayhead", 1);
    await page.keyboard.press("Meta+b");
    await page.waitForTimeout(150);
    const p = await pieces();
    expect(same(p.list, [[0, 0, 1], [1, 1, 2.5], [2.5, 2.5, 6]]) && p.sel === 1, `pieces ${JSON.stringify(p)}`);
  });

  await check(`${pad} undo takes the cut back and lets go of the chosen piece (its place in the list changed); redo cuts again`, async () => {
    await page.keyboard.press("Meta+z");
    await page.waitForTimeout(250);
    let p = await pieces();
    expect(same(p.list, [[0, 0, 2.5], [2.5, 2.5, 6]]) && p.sel === null, `after undo ${JSON.stringify(p)}`);
    const panel = await S(page, () => document.querySelector(".panel.right h2")?.textContent);
    expect(panel !== "Sound", "the Sound panel still shows a piece that's gone");
    await page.keyboard.press("Meta+Shift+z");
    await page.waitForTimeout(250);
    p = await pieces();
    expect(same(p.list, [[0, 0, 1], [1, 1, 2.5], [2.5, 2.5, 6]]), `after redo ${JSON.stringify(p.list)}`);
  });

  await check(`${pad} ⌫ deletes the chosen piece, leaving a gap: the recording is silent there and plays either side`, async () => {
    await call("selectSound", 1);
    await page.keyboard.press("Backspace");
    await page.waitForTimeout(150);
    const p = await pieces();
    expect(same(p.list, [[0, 0, 1], [2.5, 2.5, 6]]) && p.sel === null, `pieces ${JSON.stringify(p)}`);
    const g = await S(page, async () => {
      const snd = await import("/ui/sound.js" as string);
      return [0.5, 1.5, 2.4, 3].map((t) => snd.recordingGain(t));
    });
    expect(JSON.stringify(g) === "[1,0,0,1]", `the recording's sound at 0.5, 1.5, 2.4, 3 s: ${JSON.stringify(g)}`);
  });

  await check(`${pad} a piece dragged into the gap stops at the piece before it (pieces never overlap)`, async () => {
    const b = await box(1);
    await dragBy(b.x + b.w / 2, b.y + b.h / 2, -3 * b.pps);
    const p = await pieces();
    expect(Math.abs(p.list[1][0] - 1) < 0.011 && p.list[1][1] === 2.5, `the piece is at ${JSON.stringify(p.list[1])}`);
  });

  await check(`${pad} dragged back near where it was recorded, it snaps exactly there (and plays from the recording again)`, async () => {
    const b = await box(1);
    await dragBy(b.x + b.w / 2, b.y + b.h / 2, 1.49 * b.pps);
    const p = await pieces();
    const g = await S(page, async () => (await import("/ui/sound.js" as string)).recordingGain(3));
    expect(p.list[1][0] === 2.5 && g === 1, `the piece is at ${JSON.stringify(p.list[1])}, the recording at ${g}`);
  });

  await check(`${pad} its start dragged out stops at the piece before it; its end stops at the end of the recording`, async () => {
    let b = await box(1);
    await dragBy(b.x + 2, b.y + b.h / 2, -3 * b.pps);
    let p = await pieces();
    expect(Math.abs(p.list[1][0] - 1) < 0.011 && Math.abs(p.list[1][1] - 1) < 0.011, `start dragged: ${JSON.stringify(p.list[1])}`);
    b = await box(1);
    await dragBy(b.x + b.w - 2, b.y + b.h / 2, 2 * b.pps);
    p = await pieces();
    expect(Math.abs(p.list[1][2] - 6) < 0.011, `end dragged: ${JSON.stringify(p.list[1])}`);
  });

  await check(`${pad} a piece can't be trimmed to nothing (a tenth of a second at least)`, async () => {
    const b = await box(0);
    await dragBy(b.x + b.w - 2, b.y + b.h / 2, -3 * b.pps);
    const p = await pieces();
    expect(Math.abs(p.list[0][2] - p.list[0][1] - 0.1) < 0.011, `the piece is ${JSON.stringify(p.list[0])}`);
  });

  await check(`${pad} Esc while dragging puts the piece back as it was`, async () => {
    const before = (await pieces()).list;
    const b = await box(1);
    await page.mouse.move(b.x + b.w / 2, b.y + b.h / 2);
    await page.mouse.down();
    await page.mouse.move(b.x + b.w / 2 + 40, b.y + b.h / 2, { steps: 4 });
    await page.keyboard.press("Escape");
    await page.mouse.up();
    const p = await pieces();
    expect(same(p.list, before), `before ${JSON.stringify(before)}, after ${JSON.stringify(p.list)}`);
  });

  await check(`${pad} ← and → nudge the chosen piece a tenth of a second (⇧, a second), only into its room`, async () => {
    await call("selectSound", 1);
    await page.keyboard.press("ArrowRight");
    let p = await pieces();
    expect(Math.abs(p.list[1][0] - 1.1) < 0.011, `→: ${JSON.stringify(p.list[1])}`);
    await page.keyboard.press("Shift+ArrowLeft");
    p = await pieces();
    expect(Math.abs(p.list[1][0] - 0.1) < 0.011, `⇧←: ${JSON.stringify(p.list)} (the piece before ends at 0.1)`);
    await page.keyboard.press("Shift+ArrowRight");
    await page.keyboard.press("Shift+ArrowRight");
    p = await pieces();
    expect(p.list[1][0] <= 6 - 0.1 + 0.011, `past the end: ${JSON.stringify(p.list[1])}`);
  });

  await check(`${pad} the piece's panel: volume and fades; a fade longer than the piece is fine; cutting keeps fades at the outer ends`, async () => {
    await call("resetSounds");
    await call("selectSound", 0);
    await S(page, async () => {
      const snd = await import("/ui/sound.js" as string);
      snd.editSounds((l: any[]) => void Object.assign(l[0], { volume: 0.5, fadeIn: 10, fadeOut: 1 }));
    });
    const g = await S(page, async () => {
      const snd = await import("/ui/sound.js" as string);
      return [0, 3, 5.5, 6].map((t) => Math.round(snd.recordingGain(t) * 1000) / 1000);
    });
    expect(g.every((v) => Number.isFinite(v) && v >= 0 && v <= 0.5) && g[1] > 0.2 && g[1] < 0.3 && g[3] === 0, `gains ${JSON.stringify(g)}`);
    await call("setPlayhead", 3);
    await call("cutSoundHere");
    const f = await S(page, () => (window as any).studio.state.scene.sounds.map((c: any) => [c.fadeIn ?? 0, c.fadeOut ?? 0, c.volume ?? 1]));
    expect(JSON.stringify(f) === "[[10,0,0.5],[0,1,0.5]]", `fades after the cut ${JSON.stringify(f)}`);
    const panel = await S(page, () => document.querySelector(".panel.right h2")?.textContent);
    expect(panel === "Sound", `the panel says ${panel}`);
  });

  await check(`${pad} right-click a piece: Cut, Play, Delete`, async () => {
    const b = await box(0);
    await page.mouse.click(b.x + b.w / 2, b.y + b.h / 2, { button: "right" });
    await page.waitForTimeout(200);
    const items = await S(page, () => [...document.querySelectorAll(".ctx-menu button, .menu button, [role=menu] button")].map((e) => e.textContent?.trim()));
    expect(items.some((t) => t?.startsWith("Cut at the playhead")) && items.some((t) => t?.startsWith("Delete this piece")), `menu: ${JSON.stringify(items)}`);
    await page.keyboard.press("Escape");
    await S(page, async () => (await import("/ui/store.js" as string)).set({ menu: null }));
  });

  await check(`${pad} every piece deleted: "No sound", and putting the recording's back brings the whole of it`, async () => {
    await S(page, async () => {
      const snd = await import("/ui/sound.js" as string);
      while (snd.soundClips().length) snd.deleteSound(0);
    });
    await page.waitForTimeout(200);
    const none = await S(page, () => document.querySelector(".tl-sound-none")?.textContent ?? "");
    expect(none.includes("No sound"), `the row says ${JSON.stringify(none)}`);
    const g = await S(page, async () => (await import("/ui/sound.js" as string)).recordingGain(1));
    expect(g === 0, `the recording still plays (${g})`);
    await page.click(".tl-sound-none button");
    const p = await pieces();
    expect(same(p.list, [[0, 0, 6]]), `after putting it back ${JSON.stringify(p.list)}`);
  });

  await check(`${pad} the recording's sound turned off: pieces dimmed, nothing plays`, async () => {
    await S(page, async () => (await import("/ui/recording.js" as string)).setRecording({ sound: false }));
    await page.waitForTimeout(200);
    const r = await S(page, async () => ({ dim: document.querySelector(".tl-sound")?.classList.contains("off"), g: (await import("/ui/sound.js" as string)).recordingGain(1) }));
    await S(page, async () => (await import("/ui/recording.js" as string)).setRecording({ sound: true }));
    expect(r.dim && r.g === 0, JSON.stringify(r));
  });

  await check(`${pad} a piece written without an end runs to the end of its file, and cuts like any other`, async () => {
    await S(page, (v: string) => {
      const st = (window as any).studio;
      return import("/ui/store.js" as string).then((m) => m.edit((d: any) => (d.sounds = [{ src: v, at: 0, from: 1 }])));
    }, video);
    await page.waitForTimeout(300);
    let p = await pieces();
    expect(Math.abs(p.list[0][2] - 6) < 0.05, `its end: ${JSON.stringify(p.list[0])}`);
    await call("setPlayhead", 2);
    await call("cutSoundHere");
    p = await pieces();
    expect(p.list.length === 2 && Math.abs(p.list[0][2] - 3) < 0.011 && Math.abs(p.list[1][1] - 3) < 0.011, `cut: ${JSON.stringify(p.list)}`);
    const written = await S(page, () => (window as any).studio.state.scene.sounds.every((c: any) => typeof c.to === "number"));
    expect(written, "the pieces' ends weren't written down");
  });

  await check(`${pad} pieces written overlapping stay as they are when one is moved (it isn't pushed into the other)`, async () => {
    await S(page, (v: string) => import("/ui/store.js" as string).then((m) => m.edit((d: any) => (d.sounds = [{ src: v, at: 0, from: 0, to: 3 }, { src: v, at: 2, from: 4, to: 6 }]))), video);
    await call("selectSound", 1);
    await page.keyboard.press("ArrowRight");
    const p = await pieces();
    expect(p.list.length === 2 && Math.abs(p.list[1][0] - 2.1) < 0.011 && p.list[0][0] === 0, `pieces ${JSON.stringify(p.list)}`);
  });

  await check(`${pad} a piece whose file is gone says so, and nothing breaks`, async () => {
    await S(page, (v: string) => import("/ui/store.js" as string).then((m) => m.edit((d: any) => (d.sounds = [{ src: v, at: 0, from: 0, to: 2 }]))), path.join(LIB, "gone.m4a"));
    await page.waitForTimeout(500);
    const r = await S(page, () => ({ missing: document.querySelector(".tl-sound")?.classList.contains("missing"), title: document.querySelector(".tl-sound")?.getAttribute("title") }));
    expect(r.missing && /isn't there/.test(r.title ?? ""), JSON.stringify(r));
  });

  await check(`${pad} playing: a moved piece plays on its own, in step; the recording is silent where it was cut out`, async () => {
    await call("resetSounds");
    // 0–2 s where it was; 2–3 s moved to 4 s; nothing between.
    await S(page, (v: string) => import("/ui/store.js" as string).then((m) => m.edit((d: any) => (d.sounds = [{ src: v, at: 0, from: 0, to: 2 }, { src: v, at: 4, from: 2, to: 3 }]))), video);
    const r = await S(page, async (engineName: string) => {
      const tl = await import("/ui/timeline.js" as string);
      const snd = await import("/ui/sound.js" as string);
      const master = document.querySelector<HTMLVideoElement>("video[data-master]")!;
      tl.setPlayhead(0.5);
      tl.play();
      await new Promise((r) => setTimeout(r, 500));
      const early = { muted: master.muted };
      tl.pause();
      tl.setPlayhead(2.5);
      tl.play();
      await new Promise((r) => setTimeout(r, 400));
      const gap = { muted: master.muted };
      tl.pause();
      let off: number | null = null;
      if (engineName === "chromium") {
        tl.setPlayhead(4.1);
        tl.play();
        await new Promise((r) => setTimeout(r, 600));
        const p = snd.soundPlayers()[0];
        off = p && !p.paused ? p.t - (master.currentTime - 4 + 2) : null;
        tl.pause();
      }
      const after = snd.soundPlayers().every((p: { paused: boolean }) => p.paused);
      return { early, gap, off, after };
    }, name);
    expect(!r.early.muted, "the recording is muted where its sound should play");
    expect(r.gap.muted, "the recording plays where its sound was cut out");
    expect(name !== "chromium" || (r.off !== null && Math.abs(r.off) < 0.08), `the moved piece plays ${r.off === null ? "not at all" : `${Math.round(r.off * 1000)} ms off`}`);
    expect(r.after, "a piece still plays after pausing");
  });

  await check(`${pad} no page errors`, async () => expect(!errors.length, errors.join(" | ")));
  // Footage: cut the recording at the playhead, take a part out; everything after moves up.
  const footage = () => S<{ dur: number; cuts: unknown; sounds: number[][]; parts: number[][] }>(page, async () => {
    const f = await import("/ui/footage.js" as string);
    const snd = await import("/ui/sound.js" as string);
    const st = (window as any).studio.state;
    return { dur: st.scene.recording.duration, cuts: st.scene.devices.map((d: any) => d.cuts ?? null), sounds: snd.soundClips(st.scene).map((c: any) => [c.at, c.from ?? 0, Math.round(snd.toOf(c) * 1000) / 1000]), parts: f.footageParts().map((p: any) => [p.at, p.from, p.to]) };
  });
  await check(`${pad} footage: cut at the playhead twice and take the middle out: the rest moves up, screen, webcam and sound`, async () => {
    await fresh();
    const r = await S(page, async () => {
      const tl = await import("/ui/timeline.js" as string);
      const f = await import("/ui/footage.js" as string);
      tl.setPlayhead(2);
      const a = f.cutFootageHere();
      tl.setPlayhead(4);
      const b = f.cutFootageHere();
      const parts = f.footageParts().length;
      const shown = document.querySelectorAll(".tl-row.footage .tl-part").length;
      f.deleteFootagePart(1);
      return { a, b, parts, shown };
    });
    await page.waitForTimeout(300);
    const g = await footage();
    expect(r.a && r.b && r.parts === 3, `cuts ${r.a} ${r.b}, ${r.parts} parts`);
    expect(g.dur === 4, `it runs ${g.dur} s`);
    expect(JSON.stringify(g.cuts) === JSON.stringify([[{ from: 2, to: 4 }]]) || JSON.stringify(g.cuts).split('{"from":2,"to":4}').length - 1 === g.cuts.filter(Boolean).length, `cuts ${JSON.stringify(g.cuts)}`);
    expect(same(g.sounds, [[0, 0, 2], [2, 4, 6]]), `sound ${JSON.stringify(g.sounds)}`);
    expect(same(g.parts, [[0, 0, 2], [2, 4, 6]]), `parts ${JSON.stringify(g.parts)}`);
  });
  await check(`${pad} footage: the recording on the canvas shows the moment after the cut`, async () => {
    await call("setPlayhead", 2.5);
    await page.waitForTimeout(500);
    const t = await S(page, () => (document.querySelector("video[data-master]") as HTMLVideoElement).currentTime);
    expect(Math.abs(t - 4.5) < 0.06, `the recording is at ${t.toFixed(2)} s`);
  });
  await check(`${pad} footage: playing runs over the part taken out, on the edited video's clock`, async () => {
    await call("setPlayhead", 1.5);
    await call("play");
    // Over the cut the recording seeks on, which can take a moment (headless WebKit pauses for it).
    for (let k = 0; k < 40; k++) {
      await page.waitForTimeout(100);
      if ((await S<number>(page, async () => (await import("/ui/timeline.js" as string)).playhead.t)) > 2.3) break;
    }
    const r = await S(page, async () => {
      const tl = await import("/ui/timeline.js" as string);
      return { t: tl.playhead.t, src: (document.querySelector("video[data-master]") as HTMLVideoElement).currentTime };
    });
    await call("pause");
    expect(r.t > 2.1 && r.src > 4.05 && Math.abs(r.src - (r.t + 2)) < 0.2, `playhead ${r.t.toFixed(2)}, recording ${r.src.toFixed(2)}`);
  });
  await check(`${pad} footage: undo brings the part back; redo takes it out again`, async () => {
    await S(page, async () => (await import("/ui/store.js" as string)).undo());
    await page.waitForTimeout(200);
    const back = await footage();
    await S(page, async () => (await import("/ui/store.js" as string)).redo());
    await page.waitForTimeout(200);
    const again = await footage();
    expect(back.dur === 6 && back.cuts.every((c) => !c), `undone: ${JSON.stringify(back)}`);
    expect(again.dur === 4, `redone: ${again.dur} s`);
  });
  if (name === "chromium") {
    await check(`${pad} footage: the exported video skips the part taken out, picture and sound`, async () => {
      const out = await S<string>(page, async () => {
        const st = (window as any).studio.state;
        await (await import("/ui/actions.js" as string)).exportVideo();
        return st.render?.path;
      });
      const p = probe(out);
      expect(Math.abs(p.seconds - 4) < 0.15, `${p.seconds.toFixed(2)} s long`);
      expectBeeps(beeps(pcm(out)), [[300, 0.5], [500, 1.5], [1100, 2.5], [1300, 3.5]]);
    });
  }

  await browser.close();
}
server.close();

// ---------------------------------------------------------------------------------------------
// Exports

const design = (sounds: unknown, extra: Record<string, unknown> = {}) => ({
  canvas: { width: 640, height: 360 },
  background: "#202020",
  devices: [{ screenshot: poster, video, frame: "none", x: 0.5, y: 0.5, height: 0.9, shadow: "none" }],
  ...(sounds === undefined ? {} : { sounds }),
  video: { duration: 6, motion: "none", sound: true },
  ...extra,
});
let n = 0;
const exportOf = async (input: Record<string, unknown>, ext = "mp4") => {
  const out = path.join(tmp, `export-${++n}.${ext}`);
  const r = await createVideo({ ...input, output: out } as never);
  return { path: r.path, warnings: r.warnings ?? [] };
};
const at = (k: number) => k + 0.5;

await check("export: the recording's own sound, as it was", async () => {
  const r = await exportOf(design(undefined));
  expectBeeps(beeps(pcm(r.path)), BEEPS.map((f, k) => [f, at(k)]));
});

await check("export: a cut-out stretch is silent (beep and hum), the rest as it was", async () => {
  const r = await exportOf(design([{ src: video, at: 0, from: 0, to: 2 }, { src: video, at: 3, from: 3, to: 6 }]));
  const x = pcm(r.path);
  expectBeeps(beeps(x), [[300, 0.5], [500, 1.5], [900, 3.5], [1100, 4.5], [1300, 5.5]]);
  expect(hum(x, 1.2) > 0.03 && hum(x, 2.5) < 0.005 && hum(x, 3.2) > 0.03, `hum ${[1.2, 2.5, 3.2].map((t) => hum(x, t).toFixed(3)).join(", ")}`);
});

await check("export: a moved piece plays its own stretch at its new time", async () => {
  const r = await exportOf(design([{ src: video, at: 0, from: 0, to: 2 }, { src: video, at: 3, from: 3, to: 4 }, { src: video, at: 4.2, from: 2, to: 3 }]));
  expectBeeps(beeps(pcm(r.path)), [[300, 0.5], [500, 1.5], [900, 3.5], [700, 4.7]]);
});

await check("export: cut but nothing taken out, it carries straight on (no dip at the cut)", async () => {
  const r = await exportOf(design([{ src: video, at: 0, from: 0, to: 3.2 }, { src: video, at: 3.2, from: 3.2, to: 6 }]));
  const x = pcm(r.path);
  const dip = hum(x, 3.2) / hum(x, 3.05);
  expect(dip > 0.85, `the hum at the cut is ${(dip * 100).toFixed(0)}% of just before it`);
  expectBeeps(beeps(x), BEEPS.map((f, k) => [f, at(k)]));
});

await check("export: half volume is half as loud; a fade-in rises from nothing", async () => {
  const x = pcm((await exportOf(design([{ src: video, at: 0, from: 0, to: 6, volume: 0.5, fadeIn: 1 }]))).path);
  const full = pcm((await exportOf(design(undefined))).path);
  // The 500 Hz beep (1.5 s, after the fade) and the 300 Hz one (0.5 s, half-way through it).
  const ratio = level(x, Math.round(1.55 * RATE), 400, 500) / level(full, Math.round(1.55 * RATE), 400, 500);
  const faded = level(x, Math.round(0.55 * RATE), 400, 300) / level(full, Math.round(0.55 * RATE), 400, 300);
  expect(ratio > 0.4 && ratio < 0.6, `half volume reads ${(ratio * 100).toFixed(0)}%`);
  expect(faded > 0.15 && faded < 0.45, `half-way through the fade-in it reads ${(faded * 100).toFixed(0)}% (about 30% wanted: half volume, half faded in)`);
  return `${(ratio * 100).toFixed(0)}%, ${(faded * 100).toFixed(0)}% fading in`;
});

await check("export: a file of another kind (mono, 44.1 kHz) mixes in with the recording", async () => {
  const r = await exportOf(design([{ src: video, at: 0, from: 0, to: 6 }, { src: music, at: 1, from: 0, to: 2 }]));
  const b = beeps(pcm(r.path));
  const tone = b.filter((x) => x.f === 1700);
  expect(tone.length === 1 && Math.abs(tone[0].t - 1) < 0.03, `the music: ${heard(tone)}; warnings ${r.warnings.join(" ")}`);
  expectBeeps(b.filter((x) => x.f !== 1700), BEEPS.map((f, k) => [f, at(k)]));
});

await check("export: a piece running past the video's end is cut there; one starting after it is left out", async () => {
  const r = await exportOf(design([{ src: video, at: 2, from: 0, to: 6 }, { src: music, at: 7, from: 0, to: 2 }]));
  const p = probe(r.path);
  expectBeeps(beeps(pcm(r.path)), [[300, 2.5], [500, 3.5], [700, 4.5], [900, 5.5]]);
  expect(Math.abs(p.seconds - 6) < 0.15, `${p.seconds} s long`);
});

await check("export: a piece written without an end plays to the end of its file", async () => {
  const r = await exportOf(design([{ src: video, at: 0, from: 4 }]));
  expectBeeps(beeps(pcm(r.path)), [[1100, 0.5], [1300, 1.5]]);
});

await check("export: no pieces at all is a silent video, made without fuss", async () => {
  const r = await exportOf(design([]));
  const p = probe(r.path);
  expect(!p.sound && !r.warnings.length, `sound: ${p.sound}; warnings ${r.warnings.join(" ")}`);
});

await check("export: a piece whose file is gone is left out; the rest plays", async () => {
  const r = await exportOf(design([{ src: video, at: 0, from: 0, to: 2 }, { src: path.join(LIB, "gone.m4a"), at: 3, from: 0, to: 2 }]));
  expectBeeps(beeps(pcm(r.path)), [[300, 0.5], [500, 1.5]]);
});

await check("export: a GIF, with pieces of sound, is made (GIFs have no sound)", async () => {
  const r = await exportOf(design([{ src: video, at: 1, from: 0, to: 2 }], { video: { duration: 2, motion: "none", sound: true } }), "gif");
  expect(existsSync(r.path), "no GIF");
});

await check("export: a video of several shots keeps each shot's sound, cut off where its shot ends", async () => {
  const out = path.join(tmp, "shots.mp4");
  const r = await createSequence({
    shots: [
      { ...design([{ src: video, at: 0, from: 0, to: 6 }]), video: { duration: 3, motion: "none", sound: true } },
      { canvas: { width: 640, height: 360 }, background: "#303030", devices: [], headline: "Two", video: { duration: 2, motion: "none" } },
    ],
    output: out,
  } as never);
  const b = beeps(pcm(r.path));
  expect(b.length >= 2 && b[0].f === 300 && Math.abs(b[0].t - 0.5) < 0.03 && b[1].f === 500 && b.every((x) => x.t < 3.05), `heard ${heard(b)}`);
});

// Footage cuts: parts of the recording taken out, picture, sound and cursor alike.
const { toEdited, toSource, keptParts, cutLog } = await import("../src/render/cuts.js");

await check("cuts: moments map to the edited video and back, and the cursor's log loses the cut parts", async () => {
  const cuts = [{ from: 1, to: 2 }, { from: 4, to: 5 }];
  const there = [0.5, 1.5, 2.5, 4.5, 5.5].map((t) => +toEdited(t, cuts).toFixed(3));
  expect(JSON.stringify(there) === JSON.stringify([0.5, 1, 1.5, 3, 3.5]), `edited ${there}`);
  const back = [0.5, 1.2, 3.2].map((t) => +toSource(t, cuts).toFixed(3));
  expect(JSON.stringify(back) === JSON.stringify([0.5, 2.2, 5.2]), `source ${back}`);
  const kept = keptParts(cuts, 6).map((p) => `${p.from}-${p.to}`).join(",");
  expect(kept === "0-1,2-4,5-6", `kept ${kept}`);
  const log = cutLog({ samples: [[0.5, 0.1, 0.1], [1.5, 0.5, 0.5], [3, 0.3, 0.3]], clicks: [[1.4, 0.5, 0.5, "down"], [3.1, 0.3, 0.3, "down"]] }, cuts);
  const s = log.samples.map((x) => `${x[0]}:${x[1]}`).join(",");
  expect(s === "0.5:0.1,1:0.5,2:0.3", `samples ${s}`);
  expect(log.clicks!.length === 1 && log.clicks![0][0] === 2.1, `clicks ${JSON.stringify(log.clicks)}`);
});

await check("export: a part cut out of the recording is gone, picture and sound, and the rest moves up", async () => {
  const r = await exportOf(design(undefined, { devices: [{ screenshot: poster, video, frame: "none", x: 0.5, y: 0.5, height: 0.9, shadow: "none", cuts: [{ from: 2, to: 4 }] }], video: { duration: 4, motion: "none", sound: true } }));
  const p = probe(r.path);
  expect(Math.abs(p.seconds - 4) < 0.1, `${p.seconds.toFixed(2)} s long`);
  expectBeeps(beeps(pcm(r.path)), [[300, 0.5], [500, 1.5], [1100, 2.5], [1300, 3.5]]);
});

await check("export: the start trimmed and a part cut from the middle", async () => {
  const r = await exportOf(design(undefined, { devices: [{ screenshot: poster, video, frame: "none", x: 0.5, y: 0.5, height: 0.9, shadow: "none", cuts: [{ from: 3, to: 4 }, { from: 0, to: 1 }] }], video: { duration: 4, motion: "none", sound: true } }));
  expectBeeps(beeps(pcm(r.path)), [[500, 0.5], [700, 1.5], [1100, 2.5], [1300, 3.5]]);
});

if (native) {
  await check("fast export: a part cut out is gone there too", async () => {
    process.env.SCREENSHOTTER_NATIVE = native;
    try {
      const r = await exportOf(design(undefined, { devices: [{ screenshot: poster, video, frame: "none", x: 0.5, y: 0.5, height: 0.9, shadow: "none", cuts: [{ from: 2, to: 4 }] }], video: { duration: 4, motion: "none", sound: true } }));
      expect(!r.warnings.some((w) => /fast export/.test(w)), r.warnings.join(" "));
      expectBeeps(beeps(pcm(r.path)), [[300, 0.5], [500, 1.5], [1100, 2.5], [1300, 3.5]]);
    } finally {
      delete process.env.SCREENSHOTTER_NATIVE;
    }
  });
}

if (native) {
  await check("fast export: the same sound, piece for piece", async () => {
    process.env.SCREENSHOTTER_NATIVE = native;
    try {
      const r = await exportOf(design([{ src: video, at: 0, from: 0, to: 2 }, { src: video, at: 3, from: 3, to: 4 }, { src: video, at: 4.2, from: 2, to: 3 }]));
      expect(!r.warnings.some((w) => /fast export/.test(w)), r.warnings.join(" "));
      expectBeeps(beeps(pcm(r.path)), [[300, 0.5], [500, 1.5], [900, 3.5], [700, 4.7]]);
    } finally {
      delete process.env.SCREENSHOTTER_NATIVE;
    }
  });
}

await closeBrowser();
if (process.env.KEEP) console.log("kept", tmp);
else rmSync(tmp, { recursive: true, force: true });
console.log(failed ? `\n${failed} sound check${failed === 1 ? "" : "s"} failed.` : "\nAll sound checks passed.");
process.exit(failed ? 1 : 0);
