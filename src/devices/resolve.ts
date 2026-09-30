import { existsSync, readFileSync } from "node:fs";
import {
  DEVICE_MODELS,
  GENERIC_COLORS,
  findModel,
  norm,
  type ColorOption,
  type DeviceModel,
  type Family,
} from "./catalog.js";
import { profileFor, profilesMatchingSize, type SimDeviceProfile } from "./profile.js";

/** Metadata written next to every capture so mockups can pick the right frame automatically. */
export interface CaptureSidecar {
  /** "simulator" (default), "web" or "mac". */
  kind?: string;
  deviceName?: string;
  deviceTypeIdentifier?: string;
  scale?: number;
  url?: string;
  app?: string;
  deviceTypeName?: string;
  udid?: string;
  runtime?: string;
  width: number;
  height: number;
  bundleId?: string;
  appearance?: string;
  capturedAt: string;
}

export function sidecarPath(screenshot: string): string {
  return `${screenshot}.json`;
}

export function readSidecar(screenshot: string): CaptureSidecar | undefined {
  const file = sidecarPath(screenshot);
  if (!existsSync(file)) return undefined;
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

export interface ResolvedDevice {
  model: DeviceModel;
  /** Where the geometry came from. */
  source: "catalog" | "simulator" | "image-size" | "generic";
}

function familyFor(productFamily: string): Family | undefined {
  if (productFamily === "iPhone") return "iphone";
  if (productFamily === "iPad") return "ipad";
  if (productFamily === "Apple Watch") return "watch";
  return undefined;
}

const DEFAULT_THICKNESS: Record<Family, number> = { iphone: 50, ipad: 30, watch: 62, mac: 12 };

/** Merge exact simulator geometry into a catalog model, or synthesise one from the profile. */
function fromProfile(profile: SimDeviceProfile, base?: DeviceModel): DeviceModel | undefined {
  const family = base?.family ?? familyFor(profile.productFamily);
  if (!family) return undefined;
  const screen = {
    width: profile.screenWidth,
    height: profile.screenHeight,
    scale: profile.scale,
    cornerRadius: profile.cornerRadius || base?.screen.cornerRadius || 0,
  };
  if (base) {
    return {
      ...base,
      name: base.name,
      screen,
      buttons: profile.buttons.length ? profile.buttons : base.buttons,
    };
  }
  const border = profile.chromeBorder ?? (family === "ipad" ? 44 : family === "watch" ? 22 : 18);
  const frame = family === "ipad" ? 5 : family === "watch" ? Math.min(12, border / 2) : 8;
  const hasNotch = family === "iphone" && !profile.dynamicIsland && profile.cornerRadius >= 39;
  return {
    id: norm(profile.name),
    name: profile.name,
    family,
    screen,
    cutout: profile.dynamicIsland ? "island" : hasNotch ? "notch" : "none",
    bezel: Math.max(2, border - frame - (family === "iphone" ? 2 : 0)),
    frame,
    thickness: DEFAULT_THICKNESS[family],
    finish: "aluminum",
    colors: GENERIC_COLORS,
    buttons: profile.buttons,
    camera: family === "ipad" ? "long-edge" : undefined,
    generic: true,
  };
}

async function byName(name: string): Promise<ResolvedDevice | undefined> {
  const catalog = findModel(name);
  let profile: SimDeviceProfile | null = null;
  for (const candidate of [name, catalog?.name, ...(catalog?.aliases ?? [])]) {
    if (candidate && (profile = await profileFor(candidate))) break;
  }
  if (profile) {
    const base = catalog ?? findModel(profile.name);
    const model = fromProfile(profile, base);
    if (model) return { model, source: base ? "catalog" : "simulator" };
  }
  if (catalog) return { model: catalog, source: "catalog" };
  return undefined;
}

/** Guess a frame from the screenshot's pixel size alone. */
async function bySize(width: number, height: number): Promise<ResolvedDevice | undefined> {
  const matches = (m: DeviceModel) =>
    (m.screen.width === width && m.screen.height === height) ||
    (m.screen.width === height && m.screen.height === width);
  const catalog = DEVICE_MODELS.find(matches);
  if (catalog) return { model: catalog, source: "image-size" };
  const [profile] = await profilesMatchingSize(width, height);
  if (profile) {
    const model = fromProfile(profile, findModel(profile.name));
    if (model) return { model, source: "image-size" };
  }
  return undefined;
}

function genericFor(width: number, height: number): DeviceModel {
  const long = Math.max(width, height);
  const short = Math.min(width, height);
  const aspect = long / short;
  const family: Family =
    width > height && aspect > 1.3 && aspect < 1.8 && width >= 1200 ? "mac" : aspect > 1.7 ? "iphone" : short < 700 ? "watch" : "ipad";
  const scale = family === "iphone" ? 3 : 2;
  if (family === "mac") {
    return { ...DEVICE_MODELS.find((m) => m.family === "mac")!, id: "generic-mac", screen: { width, height, scale, cornerRadius: 10 }, generic: true };
  }
  const template = DEVICE_MODELS.find((m) => m.family === family)!;
  return {
    ...template,
    id: "generic",
    name: `Generic ${family === "iphone" ? "iPhone" : family === "ipad" ? "iPad" : "Watch"}`,
    screen: {
      width: Math.min(width, height) === width ? width : height,
      height: Math.max(width, height) === height ? height : width,
      scale,
      cornerRadius: family === "iphone" ? 55 : family === "ipad" ? 18 : 46,
    },
    cutout: "none",
    colors: GENERIC_COLORS,
    generic: true,
  };
}

/**
 * Pick the device frame for a screenshot: explicit request, then capture metadata,
 * then pixel size, then a generic frame with the right proportions.
 */
export async function resolveDevice(
  requested: string | undefined,
  screenshot: { path: string; width: number; height: number },
): Promise<ResolvedDevice> {
  if (requested) {
    const hit = await byName(requested);
    if (hit) return hit;
    const known = DEVICE_MODELS.map((m) => m.name).join(", ");
    throw new Error(
      `Unknown device "${requested}". Use a catalog model (${known}) or any simulator device type name.`,
    );
  }
  const sidecar = readSidecar(screenshot.path);
  if (sidecar) {
    for (const name of [sidecar.deviceTypeName, sidecar.deviceTypeIdentifier, sidecar.deviceName]) {
      const hit = name ? await byName(name) : undefined;
      if (hit) return hit;
    }
  }
  return (await bySize(screenshot.width, screenshot.height)) ?? { model: genericFor(screenshot.width, screenshot.height), source: "generic" };
}

const CSS_COLOR = /^(#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})|(rgb|rgba|hsl|hsla|oklch|oklab|lab|lch|color)\(.*\))$/i;

/** Resolve a frame colour by catalog name, generic finish name, or any CSS colour. */
export function resolveColor(model: DeviceModel, requested?: string): ColorOption {
  if (!requested) {
    // A dark, slim rail reads best on most backgrounds; use the model's own black when it has one.
    return model.colors.find((c) => /black|midnight/i.test(c.name)) ?? GENERIC_COLORS[0];
  }
  const q = norm(requested);
  const hit =
    model.colors.find((c) => norm(c.id) === q || norm(c.name) === q) ??
    model.colors.find((c) => norm(c.name).includes(q)) ??
    GENERIC_COLORS.find((c) => norm(c.id) === q || norm(c.name) === q);
  if (hit) return hit;
  if (CSS_COLOR.test(requested.trim())) return { id: "custom", name: requested, hex: requested.trim() };
  const options = model.colors.map((c) => c.name).join(", ");
  throw new Error(`Unknown color "${requested}" for ${model.name}. Options: ${options}, or any hex color.`);
}
