import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { encodePng, frameDifference, isBlankFrame, readBmp, type Frame } from "../util/png.js";
import { listDeviceTypes, type Simulator } from "./simctl.js";
import * as sim from "./simctl.js";
import { run, sleep } from "../util/exec.js";
import { outputPathFor, resolveUserPath } from "../util/files.js";
import { imageSize } from "../util/image.js";
import { sidecarPath, type CaptureSidecar } from "../devices/resolve.js";

export interface CaptureOptions {
  simulator?: string;
  runtime?: string;
  bundleId?: string;
  appPath?: string;
  url?: string;
  launchArgs?: string[];
  launchEnv?: Record<string, string>;
  relaunch?: boolean;
  appearance?: "light" | "dark";
  clock?: "12h" | "24h" | "system";
  locale?: string;
  language?: string;
  contentSize?: string;
  increaseContrast?: boolean;
  statusBar?: sim.StatusBarOptions | false;
  grantPermissions?: string[];
  location?: { latitude: number; longitude: number };
  waitMs?: number;
  /** Keep capturing until two frames match (animations finished). Default true. */
  settle?: boolean;
  /** Clear a system prompt left over from another app by restarting SpringBoard. Default true. */
  clearAlerts?: boolean;
  maxWaitMs?: number;
  output?: string;
  openSimulatorApp?: boolean;
}

export interface CaptureResult {
  path: string;
  width: number;
  height: number;
  simulator: Simulator;
  steps: string[];
  warnings: string[];
}

const ALERT = /would like to|allow once|allow while using|don.t allow|would like to send you notifications/i;

export interface ScreenAlert {
  /** The prompt's title line. */
  title: string;
  /** The app that asked, from the quoted name in the title. */
  app?: string;
  notifications: boolean;
}

/** Look for a system permission prompt in a capture (on-device OCR). */
export async function detectAlert(file: string): Promise<ScreenAlert | undefined> {
  try {
    const { recognizeText } = await import("../native/ocr.js");
    const lines = (await recognizeText(file)).map((b) => b.text.trim());
    if (!lines.some((t) => ALERT.test(t))) return undefined;
    // Titles read like `"Photos" Would Like to Send You Notifications` or `Allow "Wallet" to use
    // your location?`, and OCR often splits them over two lines.
    const at = lines.findIndex((t) => /would like|wants to|^allow\s+["“]/i.test(t));
    let title = at >= 0 ? lines[at] : "a permission request";
    if (at >= 0 && !/[?.]$/.test(title) && lines[at + 1] && !ALERT.test(lines[at + 1])) title = `${title} ${lines[at + 1]}`;
    return { title, app: /["“]([^"”]+)["”]/.exec(title)?.[1], notifications: lines.some((t) => /notifications/i.test(t)) };
  } catch {
    return undefined;
  }
}

export function alertMessage(alert: ScreenAlert, grantedPermissions: boolean): string {
  const who = alert.app ? `${alert.app}'s` : "An app's";
  if (alert.notifications) {
    return `${who} notification permission prompt is on screen; the app asks on launch until it's answered. simctl can't pre-grant notifications, so ask the user to answer it once in the Simulator window (simulator_control action "open_simulator_app"); iOS remembers the answer. Your own app can skip the prompt in a screenshot mode (launchArgs).`;
  }
  return grantedPermissions
    ? `${who} permission prompt is on screen: "${alert.title}". Pre-granting didn't cover it (Apple's own apps often ignore it), so ask the user to answer it once in the Simulator window (simulator_control action "open_simulator_app"); iOS remembers the answer. Your own app can skip it in a screenshot mode (launchArgs).`
    : `${who} permission prompt is on screen: "${alert.title}". Recapture with grantPermissions: ["all"] to pre-approve it.`;
}

/**
 * Capture once the screen settles; if a prompt from another app is covering it, clear that
 * prompt (SpringBoard restart, nothing is answered), bring the target back and capture again.
 * A prompt from the target app itself is left alone and reported: it would only ask again.
 */
async function captureClear(
  simulator: Simulator,
  out: string,
  opts: CaptureOptions,
  steps: string[],
  target: { name?: string; relaunch: () => Promise<void> },
): Promise<string[]> {
  const settle = async () => {
    if (opts.settle === false) {
      await sim.screenshot(simulator.udid, out);
      return;
    }
    const settled = await captureWhenStill(simulator.udid, out, opts.maxWaitMs ?? 10_000);
    steps.push(settled ? "screen settled" : "screen still animating at timeout; captured anyway");
  };
  await settle();
  let alert = await detectAlert(out);
  const fromTarget = (a: ScreenAlert) => Boolean(a.app && target.name && a.app.toLowerCase() === target.name.toLowerCase());
  if (alert && opts.clearAlerts !== false && !fromTarget(alert)) {
    await sim.restartSpringBoard(simulator.udid);
    steps.push(`cleared ${alert.app ?? "another app"}'s leftover prompt (restarted SpringBoard)`);
    await target.relaunch();
    await sleep(opts.waitMs ?? 300);
    await settle();
    alert = await detectAlert(out);
  }
  return alert ? [alertMessage(alert, Boolean(opts.grantPermissions?.length))] : [];
}

async function readGlobalDefault(udid: string, key: string): Promise<string | undefined> {
  try {
    const { stdout } = await sim.simctl(["spawn", udid, "defaults", "read", "-g", key]);
    return stdout.trim();
  } catch {
    return undefined;
  }
}

async function writeGlobalDefault(udid: string, key: string, type: "-bool" | "-string" | "-array", ...values: string[]) {
  await sim.simctl(["spawn", udid, "defaults", "write", "-g", key, type, ...values]);
}

/**
 * Apply settings SpringBoard only reads at boot (clock style, locale, language).
 * Returns true when something changed and the simulator needs a reboot.
 */
const bootSettingsApplied = new Map<string, string>();

async function applyBootSettings(udid: string, opts: CaptureOptions, steps: string[]): Promise<boolean> {
  // Reading defaults costs a process spawn each; skip when this process already verified them.
  const key = JSON.stringify([opts.clock ?? "12h", opts.locale ?? "", opts.language ?? ""]);
  if (bootSettingsApplied.get(udid) === key) return false;
  const changed = await checkBootSettings(udid, opts, steps);
  bootSettingsApplied.set(udid, key);
  return changed;
}

async function checkBootSettings(udid: string, opts: CaptureOptions, steps: string[]): Promise<boolean> {
  let changed = false;
  const clock = opts.clock ?? "12h";
  if (clock !== "system") {
    const want12 = clock === "12h";
    const [cur12, cur24] = await Promise.all([readGlobalDefault(udid, "AppleICUForce12HourTime"), readGlobalDefault(udid, "AppleICUForce24HourTime")]);
    if ((cur12 === "1") !== want12 || (cur24 === "1") !== !want12) {
      await writeGlobalDefault(udid, "AppleICUForce12HourTime", "-bool", String(want12));
      await writeGlobalDefault(udid, "AppleICUForce24HourTime", "-bool", String(!want12));
      steps.push(`set ${clock} clock`);
      changed = true;
    }
  }
  if (opts.locale) {
    const cur = await readGlobalDefault(udid, "AppleLocale");
    if (cur !== opts.locale) {
      await writeGlobalDefault(udid, "AppleLocale", "-string", opts.locale);
      steps.push(`set locale ${opts.locale}`);
      changed = true;
    }
  }
  if (opts.language) {
    const cur = (await readGlobalDefault(udid, "AppleLanguages")) ?? "";
    const first = /"?([A-Za-z-_]+)"?/.exec(cur.replace(/[()\s]/g, ""))?.[1];
    if (first !== opts.language) {
      await writeGlobalDefault(udid, "AppleLanguages", "-array", opts.language);
      steps.push(`set language ${opts.language}`);
      changed = true;
    }
  }
  return changed;
}

/**
 * Boot the simulator, apply appearance/status bar/locale, install and launch the app and open
 * the deep link. Shared by screenshots and screen recordings.
 */
export async function prepareSimulator(opts: CaptureOptions, steps: string[]): Promise<Simulator> {
  const simulator = await sim.resolveSimulator({ simulator: opts.simulator, runtime: opts.runtime });
  const udid = simulator.udid;
  let coldBoot = false;

  if (simulator.state !== "Booted") {
    bootSettingsApplied.delete(udid);
    await sim.bootSimulator(udid, opts.openSimulatorApp);
    steps.push(`booted ${simulator.name} (${simulator.runtimeName})`);
    coldBoot = true;
  } else if (opts.openSimulatorApp) {
    await sim.showSimulator(udid).catch((e) => steps.push(`couldn't show the simulator window: ${(e as Error).message}`));
  }

  if (await applyBootSettings(udid, opts, steps)) {
    await sim.shutdownSimulator(udid);
    await sim.bootSimulator(udid, opts.openSimulatorApp);
    steps.push("rebooted to apply settings");
    coldBoot = true;
  }
  if (coldBoot) await sleep(5000); // SpringBoard keeps drawing for a few seconds after boot

  // Some platforms (watchOS) don't support every setting; note it and carry on.
  const optional = async (label: string, fn: () => Promise<void>) => {
    try {
      await fn();
      steps.push(label);
    } catch (e) {
      steps.push(`${label.split(" ")[0]} not supported on ${simulator.platform}`);
    }
  };
  // Independent settings go out together; each is a separate simctl process.
  const settings: Array<Promise<void>> = [];
  if (opts.appearance) settings.push(optional(`appearance ${opts.appearance}`, () => sim.setAppearance(udid, opts.appearance!)));
  if (opts.increaseContrast !== undefined) {
    settings.push(optional(`increase-contrast ${opts.increaseContrast ? "on" : "off"}`, () => sim.setIncreaseContrast(udid, opts.increaseContrast!)));
  }
  if (opts.contentSize) settings.push(optional(`content-size ${opts.contentSize}`, () => sim.setContentSize(udid, opts.contentSize!)));
  if (opts.statusBar === false) {
    settings.push(sim.clearStatusBar(udid).catch(() => undefined));
  } else if (simulator.platform !== "watchOS") {
    const bar = opts.statusBar ?? {};
    const wifiOnly = /ipad/i.test(simulator.name) || /iPad/.test(simulator.deviceTypeIdentifier);
    settings.push(optional(`status bar ${bar.time ?? "9:41"}`, () => sim.overrideStatusBar(udid, bar, { wifiOnly })));
  }
  if (opts.location) {
    settings.push(sim.setLocation(udid, opts.location.latitude, opts.location.longitude).then(() => void steps.push("location set")));
  }
  await Promise.all(settings);
  if (opts.appPath) {
    await sim.installApp(udid, resolveUserPath(opts.appPath));
    sim.forgetApps(udid);
    steps.push(`installed ${opts.appPath}`);
  }

  const bundleId = opts.bundleId;
  if (bundleId && opts.grantPermissions?.length) {
    await sim.grantPermissions(udid, bundleId, opts.grantPermissions);
    steps.push(`granted ${opts.grantPermissions.join(", ")}`);
  }
  await launchTarget(simulator, opts, steps);
  return simulator;
}

/** Launch the app and/or open the deep link, from a clean Home Screen. */
export async function launchTarget(simulator: Simulator, opts: CaptureOptions, steps: string[]): Promise<void> {
  const udid = simulator.udid;
  const bundleId = opts.bundleId;
  if ((bundleId || opts.url) && opts.relaunch !== false) {
    await sim.goHome(udid);
  }
  if (bundleId) {
    // Launch arguments double as the standard way to force language/locale per app.
    const args = [...(opts.launchArgs ?? [])];
    if (opts.language) args.push("-AppleLanguages", `(${opts.language})`);
    if (opts.locale) args.push("-AppleLocale", opts.locale);
    await sim.launchApp(udid, bundleId, {
      args,
      env: opts.launchEnv,
      terminateRunning: opts.relaunch !== false,
    });
    steps.push(`launched ${bundleId}`);
  }
  if (opts.url) {
    await sim.openUrl(udid, opts.url);
    steps.push(`opened ${opts.url}`);
  }
}

/** Metadata next to a capture so mockups pick the right frame automatically. */
export async function writeCaptureSidecar(file: string, simulator: Simulator, extra: Partial<CaptureSidecar> = {}): Promise<void> {
  const size = await imageSize(file);
  const types = await listDeviceTypes().catch(() => []);
  const sidecar: CaptureSidecar = {
    kind: "simulator",
    deviceName: simulator.name,
    deviceTypeIdentifier: simulator.deviceTypeIdentifier,
    deviceTypeName: types.find((t) => t.identifier === simulator.deviceTypeIdentifier)?.name,
    udid: simulator.udid,
    runtime: simulator.runtimeName,
    width: size.width,
    height: size.height,
    capturedAt: new Date().toISOString(),
    ...extra,
  };
  writeFileSync(sidecarPath(file), JSON.stringify(sidecar, null, 2));
}

/** Drive a simulator into the requested state and capture its screen. */
export function captureScreenshot(opts: CaptureOptions): Promise<CaptureResult> {
  return sim.withSimulatorLock(() => captureUnlocked(opts));
}

async function captureUnlocked(opts: CaptureOptions): Promise<CaptureResult> {
  const steps: string[] = [];
  const simulator = await prepareSimulator(opts, steps);
  const udid = simulator.udid;
  const bundleId = opts.bundleId;
  // A short head start; waiting for the screen to settle does the rest.
  const wait = opts.waitMs ?? (opts.settle === false ? 1500 : 300);
  if (wait > 0) await sleep(wait);

  const base = bundleId ? `${simulator.name}-${bundleId.split(".").pop()}` : simulator.name;
  const out = outputPathFor(opts.output, "raw", base, "png");
  const appName = bundleId ? (await sim.listApps(udid).catch(() => [])).find((a) => a.bundleId === bundleId)?.name : undefined;
  const warnings = await captureClear(simulator, out, opts, steps, {
    name: appName,
    relaunch: () => launchTarget(simulator, opts, []),
  });
  const size = await imageSize(out);
  await writeCaptureSidecar(out, simulator, { bundleId, appearance: opts.appearance });
  return { path: out, ...size, simulator, steps, warnings };
}

/**
 * Capture once the screen has stopped changing, so launch animations, fades and lazy-loaded
 * content have finished. Probes are raw BMP captures (about half the cost of PNG) compared with
 * a small tolerance, so a blinking cursor or a small spinner doesn't count as movement. As soon
 * as two consecutive probes match, the last one is encoded as the PNG, with no extra capture.
 * A nearly empty screen (an app still starting up) only counts once it has held for 4 s.
 * Returns false if the screen was still changing at the timeout (the last frame is kept).
 */
export { captureClear };

export async function captureWhenStill(udid: string, out: string, maxWaitMs: number): Promise<boolean> {
  const probeFile = `${out}.probe.bmp`;
  const probe = async (): Promise<Frame> => {
    await sim.screenshot(udid, probeFile, "ignored", "bmp");
    return readBmp(readFileSync(probeFile));
  };
  const started = Date.now();
  let settled = false;
  let prev = await probe();
  let blankSince: number | undefined;
  try {
    while (Date.now() - started < maxWaitMs) {
      const cur = await probe();
      const still = frameDifference(prev, cur) < 0.005;
      prev = cur;
      if (!still) {
        blankSince = undefined;
        continue;
      }
      if (!isBlankFrame(cur)) {
        settled = true;
        break;
      }
      blankSince ??= Date.now();
      if (Date.now() - blankSince >= 4000) {
        settled = true;
        break;
      }
      await sleep(250);
    }
    writeFileSync(out, encodePng(prev));
  } finally {
    rmSync(probeFile, { force: true });
  }
  return settled;
}
