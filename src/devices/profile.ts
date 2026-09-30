import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { run } from "../util/exec.js";
import { listDeviceTypes, type DeviceType } from "../simulator/simctl.js";

/** A side button as laid out by Xcode's Simulator chrome, in points. */
export interface ChromeButton {
  name: string;
  side: "left" | "right" | "top" | "bottom";
  /**
   * Offset along the edge in points, measured from the screen's top edge (left/right
   * buttons) or from the screen's leading/trailing edge (top/bottom buttons).
   */
  offset: number;
  /** Length along the edge, in points. */
  length: number;
  /** How far the button sticks out, in points (from the chrome artwork). */
  depth: number;
  align: "leading" | "trailing";
}

/** Geometry read from an installed simulator device type. */
export interface SimDeviceProfile {
  name: string;
  deviceTypeIdentifier: string;
  productFamily: string;
  screenWidth: number;
  screenHeight: number;
  scale: number;
  /** Display corner radius in points. */
  cornerRadius: number;
  dynamicIsland: boolean;
  /** Border width (screen edge to device edge) used by Simulator's chrome, in points. */
  chromeBorder?: number;
  buttons: ChromeButton[];
}

const CHROME_ROOTS = ["/Library/Developer/DeviceKit/Chrome"];
const profileCache = new Map<string, SimDeviceProfile | null>();

async function plistJSON(file: string): Promise<any> {
  const { stdout } = await run("plutil", ["-convert", "json", "-o", "-", file]);
  return JSON.parse(stdout);
}

function pdfSize(file: string): { width: number; height: number } | undefined {
  try {
    const text = readFileSync(file).toString("latin1");
    const m = /MediaBox\s*\[\s*([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s*\]/.exec(text);
    if (!m) return undefined;
    return { width: Number(m[3]) - Number(m[1]), height: Number(m[4]) - Number(m[2]) };
  } catch {
    return undefined;
  }
}

function readChrome(chromeIdentifier: string | undefined) {
  if (!chromeIdentifier) return undefined;
  const short = chromeIdentifier.split(".").pop()!;
  for (const root of CHROME_ROOTS) {
    const dir = path.join(root, `${short}.devicechrome`, "Contents", "Resources");
    const file = path.join(dir, "chrome.json");
    if (!existsSync(file)) continue;
    try {
      const chrome = JSON.parse(readFileSync(file, "utf8"));
      const sizing = chrome.images?.sizing ?? {};
      const border = Number(sizing.leftWidth ?? 0);
      const topBorder = Number(sizing.topHeight ?? border);
      const buttons: ChromeButton[] = [];
      for (const input of chrome.inputs ?? []) {
        if (input.type && input.type !== "button") continue;
        const size = input.image ? pdfSize(path.join(dir, `${input.image}.pdf`)) : undefined;
        const vertical = input.anchor === "left" || input.anchor === "right";
        const off = input.offsets?.normal ?? { x: 0, y: 0 };
        buttons.push({
          name: String(input.name),
          side: input.anchor,
          align: input.align === "trailing" ? "trailing" : "leading",
          offset: Math.abs(vertical ? Number(off.y) : Number(off.x)) - (vertical ? topBorder : border),
          length: size ? (vertical ? size.height : size.width) : 40,
          depth: size ? (vertical ? size.width : size.height) : 16,
        });
      }
      return { border, topBorder, buttons };
    } catch {
      return undefined;
    }
  }
  return undefined;
}

async function loadProfile(type: DeviceType): Promise<SimDeviceProfile | null> {
  const resources = path.join(type.bundlePath, "Contents", "Resources");
  const capsFile = path.join(resources, "capabilities.plist");
  if (!existsSync(capsFile)) return null;
  try {
    const caps = (await plistJSON(capsFile)).capabilities ?? {};
    const profile = await plistJSON(path.join(resources, "profile.plist")).catch(() => ({}));
    const display = (caps.displays ?? []).find((d: any) => d.displayType === "integrated") ?? caps.displays?.[0];
    if (!display) return null;
    const chrome = readChrome(profile.chromeIdentifier);
    return {
      name: caps["marketing-name"] ?? type.name,
      deviceTypeIdentifier: type.identifier,
      productFamily: type.productFamily,
      screenWidth: Number(display.width),
      screenHeight: Number(display.height),
      scale: Number(display.scale ?? 3),
      cornerRadius: Number(display.cornerRadiusUL ?? caps.DeviceCornerRadius ?? 0),
      dynamicIsland: Boolean(caps.DeviceSupportsDynamicIsland),
      chromeBorder: chrome?.border,
      buttons: chrome?.buttons ?? [],
    };
  } catch {
    return null;
  }
}

/** Profile for a device type, looked up by identifier or name. Null when Xcode doesn't know it. */
export async function profileFor(nameOrIdentifier: string): Promise<SimDeviceProfile | null> {
  const key = nameOrIdentifier.toLowerCase();
  if (profileCache.has(key)) return profileCache.get(key)!;
  let types: DeviceType[] = [];
  try {
    types = await listDeviceTypes();
  } catch {
    // Xcode not installed: the static catalog still works.
  }
  const type = types.find((t) => t.identifier.toLowerCase() === key || t.name.toLowerCase() === key);
  const profile = type ? await loadProfile(type) : null;
  profileCache.set(key, profile);
  return profile;
}

/** Every simulator device type whose screen matches the given pixel size (newest first). */
export async function profilesMatchingSize(width: number, height: number): Promise<SimDeviceProfile[]> {
  let types: DeviceType[] = [];
  try {
    types = await listDeviceTypes();
  } catch {
    return [];
  }
  const out: SimDeviceProfile[] = [];
  for (const t of types) {
    if (!["iPhone", "iPad", "Apple Watch"].includes(t.productFamily)) continue;
    const p = await profileFor(t.identifier);
    if (!p) continue;
    const portrait = p.screenWidth === width && p.screenHeight === height;
    const landscape = p.screenWidth === height && p.screenHeight === width;
    if (portrait || landscape) out.push(p);
  }
  return out;
}
