import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { run, sleep } from "../util/exec.js";
import { cacheDir } from "../util/files.js";

export interface Runtime {
  identifier: string;
  name: string;
  version: string;
  platform: string;
  isAvailable: boolean;
  supportedDeviceTypes: string[];
}

export interface DeviceType {
  identifier: string;
  name: string;
  productFamily: string;
  bundlePath: string;
  minRuntimeVersionString?: string;
}

export interface Simulator {
  udid: string;
  name: string;
  state: string;
  deviceTypeIdentifier: string;
  runtimeIdentifier: string;
  runtimeName: string;
  runtimeVersion: string;
  platform: string;
  lastBootedAt?: string;
}

let queue: Promise<unknown> = Promise.resolve();
const LOCK_STALE_MS = 15 * 60_000;
const LOCK_WAIT_MS = 20 * 60_000;

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * A lock shared by every Screenshotter process on this Mac (the MCP server an agent runs and
 * the Studio can both drive the same simulator). mkdir is atomic; the owner file lets a lock
 * left by a crashed process be recognised and cleared.
 */
async function acquireFileLock(): Promise<() => void> {
  const dir = path.join(cacheDir("locks"), "simulator.lock");
  const owner = path.join(dir, "owner");
  const started = Date.now();
  for (;;) {
    try {
      mkdirSync(dir);
      writeFileSync(owner, `${process.pid} ${Date.now()}`);
      return () => rmSync(dir, { recursive: true, force: true });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
    let stale = false;
    try {
      const [pid, since] = readFileSync(owner, "utf8").split(" ").map(Number);
      stale = !processAlive(pid) || Date.now() - since > LOCK_STALE_MS;
    } catch {
      // Owner file not written yet, or the lock vanished: stale only if the directory is old.
      try {
        stale = Date.now() - statSync(dir).mtimeMs > 30_000;
      } catch {
        continue;
      }
    }
    if (stale) {
      rmSync(dir, { recursive: true, force: true });
      continue;
    }
    if (Date.now() - started > LOCK_WAIT_MS) throw new Error("Timed out waiting for another Screenshotter job to finish with the simulator.");
    await sleep(250);
  }
}

/**
 * Run simulator work one job at a time, across processes. Agents often fire tool calls in
 * parallel, and the Studio may be in use too; two jobs interleaving on one simulator would
 * launch each other's apps and capture the wrong screen.
 */
export function withSimulatorLock<T>(fn: () => Promise<T>): Promise<T> {
  const locked = async () => {
    const release = await acquireFileLock();
    try {
      return await fn();
    } finally {
      release();
    }
  };
  const job = queue.then(locked, locked);
  queue = job.catch(() => undefined);
  return job;
}

export async function simctl(args: string[], timeoutMs = 120_000) {
  return run("xcrun", ["simctl", ...args], { timeoutMs });
}

async function simctlJSON<T>(args: string[]): Promise<T> {
  const { stdout } = await simctl([...args, "-j"]);
  return JSON.parse(stdout) as T;
}

let runtimeCache: Runtime[] | undefined;
let deviceTypeCache: DeviceType[] | undefined;

export async function listRuntimes(): Promise<Runtime[]> {
  if (!runtimeCache) {
    const data = await simctlJSON<{ runtimes: any[] }>(["list", "runtimes"]);
    runtimeCache = data.runtimes.map((r) => ({
      identifier: r.identifier,
      name: r.name,
      version: r.version,
      platform: r.platform ?? String(r.name).split(" ")[0],
      isAvailable: r.isAvailable !== false,
      supportedDeviceTypes: (r.supportedDeviceTypes ?? []).map((t: any) => t.identifier),
    }));
  }
  return runtimeCache;
}

export async function listDeviceTypes(): Promise<DeviceType[]> {
  if (!deviceTypeCache) {
    const data = await simctlJSON<{ devicetypes: DeviceType[] }>(["list", "devicetypes"]);
    deviceTypeCache = data.devicetypes;
  }
  return deviceTypeCache;
}

export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

export async function listSimulators(): Promise<Simulator[]> {
  const [data, runtimes] = await Promise.all([
    simctlJSON<{ devices: Record<string, any[]> }>(["list", "devices", "available"]),
    listRuntimes(),
  ]);
  const out: Simulator[] = [];
  for (const [runtimeId, devices] of Object.entries(data.devices)) {
    const rt = runtimes.find((r) => r.identifier === runtimeId);
    const fallbackVersion = /(\d+)-(\d+)(?:-(\d+))?$/.exec(runtimeId)?.slice(1).filter(Boolean).join(".") ?? "0";
    for (const d of devices) {
      out.push({
        udid: d.udid,
        name: d.name,
        state: d.state,
        deviceTypeIdentifier: d.deviceTypeIdentifier,
        runtimeIdentifier: runtimeId,
        runtimeName: rt?.name ?? runtimeId.split(".").pop()!,
        runtimeVersion: rt?.version ?? fallbackVersion,
        platform: rt?.platform ?? runtimeId.split(".").pop()!.split("-")[0],
        lastBootedAt: d.lastBootedAt,
      });
    }
  }
  // Newest runtime first, booted devices first within a runtime.
  out.sort(
    (a, b) =>
      compareVersions(b.runtimeVersion, a.runtimeVersion) ||
      Number(b.state === "Booted") - Number(a.state === "Booted"),
  );
  return out;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

export interface ResolveOptions {
  /** UDID, exact simulator name, device type name (e.g. "iPhone 17 Pro"), or "booted". */
  simulator?: string;
  /** Prefer a specific runtime, e.g. "iOS 26.5" or "26.5". */
  runtime?: string;
  /** Create a simulator when a device type exists but no simulator does. */
  createIfMissing?: boolean;
}

/** Find the simulator a request refers to, creating one from a device type if allowed. */
export async function resolveSimulator(opts: ResolveOptions = {}): Promise<Simulator> {
  const sims = await listSimulators();
  const query = opts.simulator?.trim();
  const runtimeFilter = (s: Simulator) => {
    if (!opts.runtime) return true;
    const r = norm(opts.runtime);
    return norm(s.runtimeName).includes(r) || norm(s.runtimeVersion) === r || s.runtimeIdentifier === opts.runtime;
  };
  const candidates = sims.filter(runtimeFilter);

  if (!query || query.toLowerCase() === "booted") {
    // Prefer a booted iPhone/iPad over, say, a booted Apple Watch.
    const booted = candidates.find((s) => s.state === "Booted" && s.platform === "iOS") ?? candidates.find((s) => s.state === "Booted");
    if (booted) return booted;
    if (query) throw new Error("No simulator is booted. Pass a simulator name or UDID instead of \"booted\".");
    const iphone = candidates.find((s) => s.platform === "iOS" && s.name.startsWith("iPhone"));
    if (iphone) return iphone;
    throw new Error("No iOS simulators are available. Install an iOS runtime in Xcode > Settings > Components.");
  }

  const byUdid = sims.find((s) => s.udid.toLowerCase() === query.toLowerCase());
  if (byUdid) return byUdid;

  const q = norm(query);
  const exact = candidates.filter((s) => norm(s.name) === q);
  if (exact.length) return exact.find((s) => s.state === "Booted") ?? exact[0];

  // Match by device type name, e.g. a simulator renamed "My Phone" whose type is iPhone 17 Pro.
  const types = await listDeviceTypes();
  const type =
    types.find((t) => norm(t.name) === q) ??
    types.find((t) => t.identifier.toLowerCase() === query.toLowerCase());
  if (type) {
    const ofType = candidates.filter((s) => s.deviceTypeIdentifier === type.identifier);
    if (ofType.length) return ofType.find((s) => s.state === "Booted") ?? ofType[0];
    if (opts.createIfMissing !== false) return createSimulator(type, opts.runtime);
  }

  const fuzzy = candidates.filter((s) => norm(s.name).includes(q));
  if (fuzzy.length) return fuzzy.find((s) => s.state === "Booted") ?? fuzzy[0];

  const names = [...new Set(sims.map((s) => s.name))].slice(0, 25).join(", ");
  throw new Error(`No simulator matches "${query}". Available: ${names}`);
}

function platformForFamily(family: string): string {
  if (family === "Apple Watch") return "watchOS";
  if (family === "Apple TV") return "tvOS";
  if (family === "Apple Vision") return "visionOS";
  return "iOS";
}

export async function createSimulator(type: DeviceType, runtimeQuery?: string): Promise<Simulator> {
  const runtimes = (await listRuntimes())
    .filter((r) => r.isAvailable && r.platform === platformForFamily(type.productFamily))
    .filter((r) => r.supportedDeviceTypes.length === 0 || r.supportedDeviceTypes.includes(type.identifier))
    .filter((r) => !runtimeQuery || norm(r.name).includes(norm(runtimeQuery)) || r.version === runtimeQuery)
    .sort((a, b) => compareVersions(b.version, a.version));
  const runtime = runtimes[0];
  if (!runtime) throw new Error(`No installed runtime supports ${type.name}.`);
  const { stdout } = await simctl(["create", `${type.name} (Screenshotter)`, type.identifier, runtime.identifier]);
  const udid = stdout.trim();
  const created = (await listSimulators()).find((s) => s.udid === udid);
  if (!created) throw new Error(`Created simulator ${udid} but could not find it afterwards.`);
  return created;
}

export async function getState(udid: string): Promise<string> {
  const sim = (await listSimulators()).find((s) => s.udid === udid);
  return sim?.state ?? "Unknown";
}

/** Boot a simulator (if needed) and wait until it has finished booting. */
export async function bootSimulator(udid: string, openSimulatorApp = false, knownState?: string): Promise<void> {
  const state = knownState ?? (await getState(udid));
  if (state === "Booted" && !openSimulatorApp) return;
  if (state !== "Booted") {
    try {
      await simctl(["boot", udid]);
    } catch (e) {
      // Racing another boot is fine.
      if (!String((e as Error).message).includes("current state: Booted")) throw e;
    }
  }
  await simctl(["bootstatus", udid, "-b"], 600_000);
  if (openSimulatorApp) await showSimulator(udid);
}

/**
 * Bring up the app that shows simulators, so a person can see and interact with one. Xcode 27
 * replaced Simulator.app with DeviceHub; older Xcodes ship Simulator.app inside the developer
 * directory. Neither is necessarily registered with Launch Services, so look inside the active
 * Xcode first. Returns the app that was opened.
 */
export async function showSimulator(udid: string): Promise<string> {
  const { stdout } = await run("xcode-select", ["-p"]).catch(() => ({ stdout: "" }));
  const developer = stdout.trim();
  const xcodeApp = developer ? path.dirname(path.dirname(developer)) : "";
  const candidates = [
    { app: path.join(developer, "Applications", "Simulator.app"), args: ["--args", "-CurrentDeviceUDID", udid] },
    { app: path.join(xcodeApp, "Contents", "Applications", "DeviceHub.app"), args: [] },
  ];
  for (const c of candidates) {
    if (!developer || !existsSync(c.app)) continue;
    await run("open", ["-a", c.app, ...c.args]);
    return path.basename(c.app, ".app");
  }
  // Fall back to Launch Services by bundle id (Simulator, then DeviceHub).
  for (const id of ["com.apple.iphonesimulator", "com.apple.dt.Devices"]) {
    try {
      await run("open", ["-b", id, ...(id === "com.apple.iphonesimulator" ? ["--args", "-CurrentDeviceUDID", udid] : [])]);
      return id === "com.apple.iphonesimulator" ? "Simulator" : "DeviceHub";
    } catch {
      // try the next one
    }
  }
  throw new Error("Couldn't find Simulator.app or DeviceHub in the active Xcode (xcode-select -p). Open Xcode's simulator window manually.");
}

export async function shutdownSimulator(udid: string): Promise<void> {
  await simctl(["shutdown", udid]).catch((e) => {
    if (!String(e.message).includes("current state: Shutdown")) throw e;
  });
}

export interface InstalledApp {
  bundleId: string;
  name: string;
  type: string;
  path?: string;
}

const appsCache = new Map<string, InstalledApp[]>();

/** Drop the cached app list (after installing an app). */
export function forgetApps(udid: string): void {
  appsCache.delete(udid);
}

export async function listApps(udid: string, fresh = false): Promise<InstalledApp[]> {
  const cached = appsCache.get(udid);
  if (cached && !fresh) return cached;
  const apps = await readApps(udid);
  appsCache.set(udid, apps);
  return apps;
}

async function readApps(udid: string): Promise<InstalledApp[]> {
  const { stdout } = await simctl(["listapps", udid]);
  const { stdout: json } = await run("plutil", ["-convert", "json", "-o", "-", "-"], { input: stdout });
  const data = JSON.parse(json) as Record<string, any>;
  return Object.entries(data)
    .map(([bundleId, info]) => ({
      bundleId,
      name: info.CFBundleDisplayName || info.CFBundleName || bundleId,
      type: info.ApplicationType ?? "Unknown",
      path: info.Path,
    }))
    .sort((a, b) => Number(a.type === "System") - Number(b.type === "System") || a.name.localeCompare(b.name));
}

export interface StatusBarOptions {
  time?: string;
  batteryLevel?: number;
  batteryState?: "charged" | "charging" | "discharging";
  wifiBars?: number;
  cellularBars?: number;
  dataNetwork?: string;
  operatorName?: string;
  cellularMode?: "notSupported" | "searching" | "failed" | "active";
  wifiMode?: "searching" | "failed" | "active";
}

export async function overrideStatusBar(udid: string, o: StatusBarOptions, opts: { wifiOnly?: boolean } = {}): Promise<void> {
  const args = ["status_bar", udid, "override"];
  const add = (flag: string, v: unknown) => v !== undefined && v !== null && args.push(flag, String(v));
  // A plain time string: iPads show it next to today's date. (An ISO date would pin the date
  // too, but the status bar then shows a weekday that doesn't match it.)
  add("--time", o.time ?? "9:41");
  // A full battery that isn't plugged in: no charging bolt, the way Apple's marketing shots look.
  add("--batteryState", o.batteryState ?? "discharging");
  add("--batteryLevel", o.batteryLevel ?? 100);
  add("--wifiMode", o.wifiMode ?? "active");
  add("--wifiBars", o.wifiBars ?? 3);
  // iPads are shown Wi-Fi only, as in Apple's product shots.
  add("--cellularMode", o.cellularMode ?? (opts.wifiOnly ? "notSupported" : "active"));
  add("--cellularBars", o.cellularBars ?? 4);
  add("--dataNetwork", o.dataNetwork ?? "wifi");
  add("--operatorName", o.operatorName ?? "");
  await simctl(args);
}

export async function clearStatusBar(udid: string): Promise<void> {
  await simctl(["status_bar", udid, "clear"]);
}

export async function setAppearance(udid: string, appearance: "light" | "dark"): Promise<void> {
  await simctl(["ui", udid, "appearance", appearance]);
}

export async function setIncreaseContrast(udid: string, enabled: boolean): Promise<void> {
  await simctl(["ui", udid, "increase_contrast", enabled ? "enabled" : "disabled"]);
}

export async function setContentSize(udid: string, size: string): Promise<void> {
  await simctl(["ui", udid, "content_size", size]);
}

/** Services `simctl privacy` can pre-grant. Notifications are not among them. */
export const PRIVACY_SERVICES = [
  "all",
  "calendar",
  "contacts-limited",
  "contacts",
  "location",
  "location-always",
  "photos-add",
  "photos",
  "media-library",
  "microphone",
  "motion",
  "reminders",
  "siri",
] as const;

export async function installApp(udid: string, appPath: string): Promise<void> {
  await simctl(["install", udid, appPath], 300_000);
  appsCache.delete(udid);
}

export async function launchApp(
  udid: string,
  bundleId: string,
  opts: { args?: string[]; env?: Record<string, string>; terminateRunning?: boolean } = {},
): Promise<void> {
  const env = { ...process.env };
  for (const [k, v] of Object.entries(opts.env ?? {})) env[`SIMCTL_CHILD_${k}`] = v;
  const args = ["simctl", "launch"];
  if (opts.terminateRunning !== false) args.push("--terminate-running-process");
  args.push(udid, bundleId, ...(opts.args ?? []));
  await run("xcrun", args, { env, timeoutMs: 120_000 });
}

/**
 * Return to the Home Screen by quitting running apps. Launching an app while another is in
 * front makes iOS show a "◀ Previous App" back-link in the status bar; this avoids it.
 */
export async function goHome(udid: string): Promise<void> {
  const { stdout } = await simctl(["spawn", udid, "launchctl", "list"]).catch(() => ({ stdout: "" }));
  const running = [...stdout.matchAll(/UIKitApplication:([\w.-]+)\[/g)].map((m) => m[1]);
  if (!running.length) return;
  const apps = new Set((await listApps(udid).catch(() => [])).map((a) => a.bundleId));
  const services = /Spotlight|ViewService|WidgetRenderer|springboard|InCallService|PosterBoard/i;
  const targets = [...new Set(running)].filter((id) => apps.has(id) && !services.test(id));
  await Promise.all(targets.map((id) => terminateApp(udid, id)));
  if (targets.length) await sleep(250);
}

/**
 * Restart SpringBoard (the home screen process). System prompts such as notification requests
 * belong to it, so this clears one left behind by another app without answering it.
 */
export async function restartSpringBoard(udid: string): Promise<void> {
  await simctl(["spawn", udid, "launchctl", "stop", "com.apple.SpringBoard"]);
  await sleep(3500);
}

export async function terminateApp(udid: string, bundleId: string): Promise<void> {
  await simctl(["terminate", udid, bundleId]).catch(() => undefined);
}

export async function openUrl(udid: string, url: string): Promise<void> {
  await simctl(["openurl", udid, url]);
}

export async function grantPermissions(udid: string, bundleId: string, services: string[]): Promise<void> {
  for (const service of services) {
    if (!(PRIVACY_SERVICES as readonly string[]).includes(service)) {
      throw new Error(
        `Can't pre-grant "${service}". simctl supports: ${PRIVACY_SERVICES.join(", ")}.` +
          (/notif/i.test(service) ? " Notification prompts have to be answered once in the Simulator window." : ""),
      );
    }
    await simctl(["privacy", udid, "grant", service, bundleId]);
  }
}

export async function setLocation(udid: string, latitude: number, longitude: number): Promise<void> {
  await simctl(["location", udid, "set", `${latitude},${longitude}`]);
}

export async function screenshot(udid: string, file: string, mask: "ignored" | "alpha" | "black" = "ignored", type: "png" | "bmp" = "png") {
  await simctl(["io", udid, "screenshot", `--type=${type}`, `--mask=${mask}`, file]);
}

export { sleep };
