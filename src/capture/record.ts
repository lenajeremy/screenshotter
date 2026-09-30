/**
 * Screen recordings of web pages and Mac apps, to play inside a frame with create_video.
 *
 * A web flow is rehearsed first (every step must find its target) and then recorded with a real
 * mouse, so the result comes back with a cursor track: where the pointer was and when it clicked,
 * as fractions of the page. Pass it to create_video's `video.cursor` to draw the cursor.
 */
import { spawn } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { z } from "zod";
import { run, sleep } from "../util/exec.js";
import { outputPathFor } from "../util/files.js";
import { imageSize } from "../util/image.js";
import { newPage } from "../render/browser.js";
import { IPAD_UA, MOBILE_UA, settlePage, WEB_VIEWPORTS } from "./web.js";

// ---------------------------------------------------------------------------------------------
// Web

const ActionSchema = z.object({
  click: z.string().optional().describe("Click an element: a CSS selector, or its visible text."),
  hover: z.string().optional().describe("Move the pointer over an element (selector or text)."),
  type: z.string().optional().describe("Type this text, into `into` or whatever has focus."),
  into: z.string().optional().describe("With type: the field to click and type into (selector or text)."),
  press: z.string().optional().describe('Press a key, e.g. "Enter" or "Escape".'),
  scroll: z.union([z.number(), z.enum(["top", "bottom"])]).optional().describe("Scroll by this many px (negative is up), or to the top or bottom."),
  to: z.string().optional().describe("Scroll until this element (selector or text) is in view."),
  wait: z.number().min(0).max(10_000).optional().describe("Pause, in ms."),
});

export const RecordWebShape = {
  url: z.string().url(),
  viewport: z
    .union([z.enum(Object.keys(WEB_VIEWPORTS) as [string, ...string[]]), z.object({ width: z.number().int(), height: z.number().int() })])
    .optional()
    .describe("Page size: desktop (default), macbook, wide, iphone, iphone-max, ipad, or {width,height}."),
  colorScheme: z.enum(["light", "dark"]).optional(),
  actions: z.array(ActionSchema).max(40).describe("The flow, in order. It's rehearsed first; a step that can't find its target stops with an error naming it."),
  pace: z.number().min(0.2).max(3).optional().describe("Seconds the pointer takes to reach each target. Default 0.7."),
  hold: z.number().min(0).max(5).optional().describe("Seconds to keep recording after the last step. Default 1.2."),
  hideBanners: z.boolean().optional().describe("Hide cookie banners. Default true."),
  output: z.string().optional().describe("Output file or directory. Default ./screenshots/recordings/."),
};
const RecordWebSchema = z.object(RecordWebShape);
export type RecordWebInput = z.infer<typeof RecordWebSchema>;

export interface RecordingResult {
  video: string;
  /** The first frame as a still, to frame or to use as the device's screenshot. */
  screenshot: string;
  width: number;
  height: number;
  duration: number;
  /** For create_video's video.cursor: where the pointer was, and when it clicked. */
  cursor?: { style: "pointer" | "touch"; points: Array<{ t: number; x: number; y: number; click?: boolean }> };
}

type Page = Awaited<ReturnType<typeof newPage>>;

/** The centre of an element found by selector or visible text, in viewport px (scrolled into view). */
async function locate(page: Page, target: string): Promise<{ x: number; y: number } | undefined> {
  return page.evaluate((q: string) => {
    let el: Element | null = null;
    try {
      el = document.querySelector(q);
    } catch {
      // Not a selector: look for the text.
    }
    if (!el) {
      const want = q.trim().toLowerCase();
      const all = Array.from(document.querySelectorAll<HTMLElement>("a, button, [role=button], input, textarea, select, label, summary, li, h1, h2, h3, h4, p, span, div"));
      const visible = (e: HTMLElement) => {
        const r = e.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== "hidden";
      };
      const exact = all.find((e) => visible(e) && (e.innerText ?? e.getAttribute("aria-label") ?? "").trim().toLowerCase() === want);
      el = exact ?? all.filter((e) => visible(e) && (e.innerText ?? "").toLowerCase().includes(want)).sort((a, b) => (a.innerText?.length ?? 0) - (b.innerText?.length ?? 0))[0] ?? null;
    }
    if (!el) return undefined;
    el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" as ScrollBehavior });
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }, target);
}

/** Run the flow. With `track`, the pointer glides to each target and every move is logged. */
async function perform(page: Page, input: RecordWebInput, track?: { t0: number; log: Array<{ t: number; x: number; y: number; click?: boolean }>; vw: number; vh: number }) {
  const pace = input.pace ?? 0.7;
  let pos = { x: (track?.vw ?? 1000) * 0.62, y: (track?.vh ?? 800) * 0.7 };
  const now = () => (track ? (performance.now() - track.t0) / 1000 : 0);
  const note = (click = false) => track?.log.push({ t: Math.round(now() * 1000) / 1000, x: pos.x / track.vw, y: pos.y / track.vh, ...(click ? { click } : {}) });
  const glide = async (to: { x: number; y: number }) => {
    if (!track) {
      pos = to;
      return;
    }
    note();
    const steps = Math.max(8, Math.round(pace * 40));
    const from = pos;
    for (let i = 1; i <= steps; i++) {
      const p = i / steps;
      const e = p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2;
      await page.mouse.move(from.x + (to.x - from.x) * e, from.y + (to.y - from.y) * e);
      await sleep((pace * 1000) / steps);
    }
    pos = to;
    note();
  };
  const target = async (q: string, step: number, what: string) => {
    const at = await locate(page, q);
    if (!at) throw new Error(`Step ${step + 1} (${what} "${q}"): nothing on the page matches it. Use a CSS selector or the element's exact visible text.`);
    return at;
  };
  for (const [i, a] of input.actions.entries()) {
    if (a.wait) await sleep(a.wait);
    if (a.to) {
      await target(a.to, i, "scroll to");
      await sleep(track ? 500 : 50);
    }
    if (a.scroll !== undefined) {
      if (track) {
        const by = a.scroll === "top" ? -1e6 : a.scroll === "bottom" ? 1e6 : a.scroll;
        const total = a.scroll === "top" ? -(await page.evaluate(() => scrollY)) : a.scroll === "bottom" ? await page.evaluate(() => document.documentElement.scrollHeight - innerHeight - scrollY) : by;
        const steps = Math.max(10, Math.round(Math.abs(total) / 40));
        for (let s = 0; s < steps; s++) {
          await page.mouse.wheel({ deltaY: total / steps });
          await sleep(16);
        }
        await sleep(300);
      } else await page.evaluate((v) => (typeof v === "number" ? scrollBy(0, v) : scrollTo(0, v === "top" ? 0 : document.documentElement.scrollHeight)), a.scroll);
    }
    if (a.hover) await glide(await target(a.hover, i, "hover"));
    if (a.click) {
      const at = await target(a.click, i, "click");
      await glide(at);
      if (track) {
        note(true);
        await page.mouse.click(at.x, at.y, { delay: 70 });
        await sleep(450);
      }
    }
    if (a.type) {
      if (a.into) {
        const at = await target(a.into, i, "type into");
        await glide(at);
        if (track) {
          note(true);
          await page.mouse.click(at.x, at.y, { delay: 60 });
        }
      }
      if (track) await page.keyboard.type(a.type, { delay: 55 });
    }
    if (a.press && track) await page.keyboard.press(a.press as never);
  }
  if (track) note();
}

export async function recordWeb(raw: RecordWebInput): Promise<RecordingResult> {
  const input = RecordWebSchema.parse(raw);
  const preset = typeof input.viewport === "string" || !input.viewport ? WEB_VIEWPORTS[input.viewport ?? "desktop"] : undefined;
  const vp = preset ?? { width: (input.viewport as { width: number }).width, height: (input.viewport as { height: number }).height, scale: 2, mobile: false };
  const host = new URL(input.url).hostname.replace(/^www\./, "");
  const video = outputPathFor(input.output, "recordings", `web-${host}`, "mp4");
  const still = video.replace(/\.mp4$/, ".png");
  const webm = video.replace(/\.mp4$/, ".webm");
  const opts = { url: input.url, colorScheme: input.colorScheme, hideBanners: input.hideBanners, waitMs: 400 };

  const open = async () => {
    const page = await newPage();
    if (vp.mobile) await page.setUserAgent(vp.width > 800 ? IPAD_UA : MOBILE_UA);
    // Recording runs at 2× so the video stays sharp inside a frame.
    await page.setViewport({ width: vp.width, height: vp.height, deviceScaleFactor: 2, isMobile: vp.mobile, hasTouch: vp.mobile });
    await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: input.colorScheme ?? "light" }]);
    // Cookie banners come back on every page the flow opens: keep hiding them.
    if (input.hideBanners !== false) {
      await page.evaluateOnNewDocument(() => {
        const sweep = () => {
          for (const el of document.querySelectorAll<HTMLElement>("body *")) {
            const st = getComputedStyle(el);
            if (st.position !== "fixed" && st.position !== "sticky") continue;
            const key = `${el.id} ${el.getAttribute("class") ?? ""} ${el.getAttribute("aria-label") ?? ""}`.toLowerCase();
            const text = (el.textContent ?? "").slice(0, 600).toLowerCase();
            const cookieish = /cookie|consent|gdpr|onetrust|cookiebot|privacy-banner|cmp-/.test(key) || (/cookie/.test(text) && /accept|agree|allow|reject|decline/.test(text));
            if (cookieish && el.getBoundingClientRect().height < innerHeight * 0.7) el.style.setProperty("display", "none", "important");
          }
        };
        addEventListener("DOMContentLoaded", () => {
          sweep();
          setInterval(sweep, 400);
        });
      });
    }
    await page.goto(input.url, { waitUntil: "networkidle2", timeout: 60_000 });
    await settlePage(page, opts);
    return page;
  };

  // Rehearsal: every step has to find its target before anything is recorded.
  const rehearsal = await open();
  try {
    await perform(rehearsal, input);
  } finally {
    await rehearsal.close().catch(() => undefined);
  }

  const page = await open();
  try {
    await page.screenshot({ path: still as `${string}.png` });
    const recorder = await page.screencast({ path: webm as `${string}.webm` });
    const track = { t0: performance.now(), log: [] as Array<{ t: number; x: number; y: number; click?: boolean }>, vw: vp.width, vh: vp.height };
    await sleep(500);
    await perform(page, input, track);
    await sleep((input.hold ?? 1.2) * 1000);
    const duration = (performance.now() - track.t0) / 1000;
    await recorder.stop();
    // H.264 plays everywhere (and inside frames in create_video).
    await new Promise<void>((resolve, reject) => {
      const ff = spawn("ffmpeg", ["-y", "-loglevel", "error", "-i", webm, "-c:v", "libx264", "-preset", "medium", "-crf", "17", "-pix_fmt", "yuv420p", "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2", "-movflags", "+faststart", video]);
      let err = "";
      ff.stderr.on("data", (d) => (err += d));
      ff.on("error", (e) => reject((e as NodeJS.ErrnoException).code === "ENOENT" ? new Error("ffmpeg isn't installed. Install it with `brew install ffmpeg`.") : e));
      ff.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg failed: ${err.trim().split("\n").pop()}`))));
    });
    rmSync(webm, { force: true });
    const size = await imageSize(still);
    writeFileSync(`${still}.json`, JSON.stringify({ kind: "web", url: input.url, scale: 2, width: size.width, height: size.height, capturedAt: new Date().toISOString() }, null, 2));
    return {
      video,
      screenshot: still,
      ...size,
      duration: Math.round(duration * 100) / 100,
      cursor: { style: vp.mobile ? "touch" : "pointer", points: track.log },
    };
  } finally {
    await page.close().catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------------------------
// Mac

export const RecordMacShape = {
  app: z.string().optional().describe("Record this app's frontmost window. Omit to record the whole main display."),
  seconds: z.number().min(1).max(120).describe("How long to record. Do the flow (or have the person do it) while it runs."),
  output: z.string().optional().describe("Output file or directory. Default ./screenshots/recordings/."),
};
const RecordMacSchema = z.object(RecordMacShape);

const WINDOW_BOUNDS = (app: string) => `
ObjC.import('CoreGraphics');
const raw = $.CGWindowListCopyWindowInfo($.kCGWindowListOptionOnScreenOnly | $.kCGWindowListExcludeDesktopElements, $.kCGNullWindowID);
const list = ObjC.deepUnwrap(ObjC.castRefToObject(raw)) || [];
const w = list.find(w => w.kCGWindowLayer === 0 && (w.kCGWindowOwnerName || '').toLowerCase() === ${JSON.stringify(app.toLowerCase())} && w.kCGWindowBounds.Height > 60);
JSON.stringify(w ? w.kCGWindowBounds : null);
`;

export async function recordMac(raw: z.infer<typeof RecordMacSchema>): Promise<RecordingResult> {
  const input = RecordMacSchema.parse(raw);
  const video = outputPathFor(input.output, "recordings", `mac-${input.app ?? "screen"}`, "mov");
  const args = ["-v", "-x", "-V", String(input.seconds)];
  if (input.app) {
    await run("osascript", ["-e", `tell application "${input.app.replace(/"/g, "")}" to activate`]).catch(() => undefined);
    await sleep(600);
    const { stdout } = await run("osascript", ["-l", "JavaScript", "-e", WINDOW_BOUNDS(input.app)]);
    const b = JSON.parse(stdout.trim() || "null") as { X: number; Y: number; Width: number; Height: number } | null;
    if (!b) throw new Error(`No open window of "${input.app}" was found. Open it first (list_apps doesn't cover Mac apps; capture_mac lists windows).`);
    args.push("-R", `${Math.round(b.X)},${Math.round(b.Y)},${Math.round(b.Width)},${Math.round(b.Height)}`);
  }
  args.push(video);
  try {
    await run("screencapture", args, { timeoutMs: (input.seconds + 20) * 1000 });
  } catch (e) {
    throw new Error(`The recording failed: ${(e as Error).message}. Grant Screen Recording to the app running this server (System Settings › Privacy & Security › Screen & System Audio Recording).`);
  }
  // A still from the first frame, for framing.
  const still = video.replace(/\.mov$/, ".png");
  await run("ffmpeg", ["-y", "-loglevel", "error", "-i", video, "-frames:v", "1", still]).catch(() => undefined);
  const size = await imageSize(still).catch(() => ({ width: 0, height: 0 }));
  writeFileSync(`${still}.json`, JSON.stringify({ kind: "mac", app: input.app, scale: 2, width: size.width, height: size.height, capturedAt: new Date().toISOString() }, null, 2));
  return { video, screenshot: still, ...size, duration: input.seconds };
}
