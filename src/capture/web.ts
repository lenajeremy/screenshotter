import { writeFileSync } from "node:fs";
import { newPage } from "../render/browser.js";
import { captureClear, prepareSimulator, writeCaptureSidecar } from "../simulator/capture.js";
import * as sim from "../simulator/simctl.js";
import { sleep } from "../util/exec.js";
import { outputPathFor } from "../util/files.js";
import { imageSize } from "../util/image.js";

export interface WebViewport {
  width: number;
  height: number;
  scale: number;
  mobile: boolean;
  /** Simulator used when capturing in real Mobile Safari. */
  simulator?: string;
  /** Device frame the capture is sized for. */
  device?: string;
}

export const WEB_VIEWPORTS: Record<string, WebViewport> = {
  iphone: { width: 402, height: 874, scale: 3, mobile: true, simulator: "iPhone 17 Pro", device: "iPhone 17 Pro" },
  "iphone-max": { width: 440, height: 956, scale: 3, mobile: true, simulator: "iPhone 17 Pro Max", device: "iPhone 17 Pro Max" },
  ipad: { width: 1032, height: 1376, scale: 2, mobile: true, simulator: "iPad Pro 13-inch (M5)", device: "iPad Pro 13-inch" },
  desktop: { width: 1440, height: 900, scale: 2, mobile: false },
  macbook: { width: 1512, height: 982, scale: 2, mobile: false, device: "MacBook Pro 14-inch" },
  wide: { width: 1920, height: 1080, scale: 2, mobile: false },
};

export interface WebCaptureOptions {
  url: string;
  viewport?: keyof typeof WEB_VIEWPORTS | { width: number; height: number; scale?: number; mobile?: boolean };
  /**
   * "safari" opens the page in Mobile Safari on the iOS Simulator, so the status bar and browser
   * UI are the real ones. "chrome" renders the page alone in headless Chrome. Default: safari
   * for iphone/ipad viewports when a simulator is available, chrome otherwise.
   */
  engine?: "safari" | "chrome";
  simulator?: string;
  colorScheme?: "light" | "dark";
  fullPage?: boolean;
  selector?: string;
  hide?: string[];
  waitMs?: number;
  output?: string;
}

const MOBILE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1";
const IPAD_UA =
  "Mozilla/5.0 (iPad; CPU OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1";

export interface WebCaptureResult {
  path: string;
  width: number;
  height: number;
  engine: "safari" | "chrome";
  device?: string;
  warnings?: string[];
}

async function captureInSafari(opts: WebCaptureOptions, vp: WebViewport): Promise<WebCaptureResult> {
  return sim.withSimulatorLock(async () => {
  const steps: string[] = [];
  // The viewport's model may not exist in older Xcodes; fall back to the default iPhone/iPad.
  let simulatorName = opts.simulator ?? vp.simulator;
  if (!opts.simulator && vp.simulator) {
    const family = /ipad/i.test(vp.simulator) ? "iPad" : "iPhone";
    const found = await sim.resolveSimulator({ simulator: vp.simulator }).catch(() => undefined);
    if (!found) simulatorName = (await sim.listSimulators()).find((s) => s.platform === "iOS" && s.name.startsWith(family))?.udid;
  }
  const simulator = await prepareSimulator({ simulator: simulatorName, appearance: opts.colorScheme ?? "light" }, steps);
  // Bring Safari forward first: opening a link from another app makes iOS show a
  // "◀ App" back-link in the status bar.
  const open = async () => {
    await sim.goHome(simulator.udid);
    await sim.launchApp(simulator.udid, "com.apple.mobilesafari");
    await sleep(800);
    await sim.openUrl(simulator.udid, opts.url);
    await sleep(opts.waitMs ?? 2500);
  };
  await open();
  const host = new URL(opts.url).hostname.replace(/^www\./, "");
  const out = outputPathFor(opts.output, "raw", `safari-${host}`, "png");
  const warnings = await captureClear(simulator, out, { maxWaitMs: 20_000 }, steps, { name: "Safari", relaunch: open });
  await writeCaptureSidecar(out, simulator, { url: opts.url, appearance: opts.colorScheme });
  const size = await imageSize(out);
  return { path: out, ...size, engine: "safari" as const, device: simulator.name, warnings };
  });
}

async function simulatorAvailable(): Promise<boolean> {
  try {
    return (await sim.listSimulators()).some((s) => s.platform === "iOS");
  } catch {
    return false;
  }
}

export async function captureWeb(opts: WebCaptureOptions): Promise<WebCaptureResult> {
  const preset = typeof opts.viewport === "string" || opts.viewport === undefined ? WEB_VIEWPORTS[opts.viewport ?? "desktop"] : undefined;
  if (!preset && typeof opts.viewport === "string") throw new Error(`Unknown viewport "${opts.viewport}". Use ${Object.keys(WEB_VIEWPORTS).join(", ")} or {width,height}.`);
  const vp: WebViewport = preset ?? { scale: 2, mobile: false, ...(opts.viewport as { width: number; height: number }) };

  const wantsSafari = opts.engine === "safari" || (opts.engine === undefined && vp.simulator && !opts.fullPage && !opts.selector && !opts.hide?.length);
  if (wantsSafari) {
    if (!vp.simulator && !opts.simulator) throw new Error("engine \"safari\" needs an iphone/ipad viewport or a simulator name.");
    if (await simulatorAvailable()) return captureInSafari(opts, vp);
    if (opts.engine === "safari") throw new Error("No iOS simulator is available for a Mobile Safari capture.");
  }

  const page = await newPage();
  const host = new URL(opts.url).hostname.replace(/^www\./, "");
  const out = outputPathFor(opts.output, "raw", `web-${host}`, "png");
  try {
    if (vp.mobile) await page.setUserAgent(vp.width > 800 ? IPAD_UA : MOBILE_UA);
    await page.setViewport({ width: vp.width, height: vp.height, deviceScaleFactor: vp.scale, isMobile: vp.mobile, hasTouch: vp.mobile });
    await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: opts.colorScheme ?? "light" }]);
    await page.goto(opts.url, { waitUntil: "networkidle2", timeout: 60_000 });
    if (opts.hide?.length) await page.addStyleTag({ content: `${opts.hide.join(",")}{display:none !important}` });
    await page.evaluate(() => document.fonts.ready);
    await sleep(opts.waitMs ?? 800);
    if (opts.selector) {
      const el = await page.$(opts.selector);
      if (!el) throw new Error(`No element matches ${opts.selector}`);
      await el.screenshot({ path: out as `${string}.png` });
    } else {
      await page.screenshot({ path: out as `${string}.png`, fullPage: opts.fullPage ?? false });
    }
  } finally {
    await page.close().catch(() => undefined);
  }
  const size = await imageSize(out);
  // Only whole-viewport captures match a device screen; elements and full pages go in cards.
  const device = opts.selector || opts.fullPage ? undefined : vp.device;
  writeFileSync(
    `${out}.json`,
    JSON.stringify({ kind: "web", url: opts.url, scale: vp.scale, deviceName: device, deviceTypeName: device, width: size.width, height: size.height, capturedAt: new Date().toISOString() }, null, 2),
  );
  return { path: out, ...size, engine: "chrome", device };
}
