import type { ChromeButton } from "./profile.js";

export type Family = "iphone" | "ipad" | "watch" | "mac";
export type Cutout = "island" | "notch" | "none";
export type Finish = "titanium" | "aluminum" | "polished";

export interface ColorOption {
  id: string;
  name: string;
  hex: string;
}

/**
 * A device the mockup renderer can draw. Screen geometry here is a fallback: when Xcode
 * knows the device, its simulator profile (exact screen size, corner radius, buttons) wins.
 */
export interface DeviceModel {
  id: string;
  name: string;
  family: Family;
  aliases?: string[];
  /** Screen in pixels plus the pixel-per-point scale and display corner radius in points. */
  screen: { width: number; height: number; scale: number; cornerRadius: number };
  cutout: Cutout;
  /** Black border between glass edge and pixels, in points. */
  bezel: number;
  /** Laptops: thicker bottom bezel, in points. */
  chin?: number;
  /** Visible metal band around the glass, in points. */
  frame: number;
  /** Body depth in points (used for the 3D edge when the device is tilted). */
  thickness: number;
  finish: Finish;
  colors: ColorOption[];
  buttons: ChromeButton[];
  /** Tablets: where the front camera sits when held in portrait. */
  camera?: "long-edge" | "short-edge";
  /** Dynamic Island size in points, when it isn't the standard 125 × 37 (iPhone 18 Pro's is narrower). */
  island?: { width: number; height: number };
  /** Camera Control on the right side (iPhone 16 and later): centre as a fraction of the body height, length in points. */
  cameraControl?: { at: number; length: number };
  /** Antenna lines across the long sides, as fractions of the body height. */
  antenna?: number[];
  /** What the back looks like: shown with `side: "back"`, and at the edges when the device is tilted. */
  back?: BackDesign;
  /** Other models whose product art may show this one (a foldable's folded and open states share a set). */
  shareArt?: string[];
  /** True when this entry was synthesised from an Xcode profile rather than the catalog. */
  generic?: boolean;
}

/**
 * The back of a phone. Camera housings: a full-width aluminium plateau (iPhone 17 Pro and later),
 * the iPhone Air's camera bar, a square module (15 Pro, 16 Pro), a vertical pill (16, 17), a
 * diagonal pair (15) or a single lens (16e). Material: an aluminium back with a glass window
 * ("window", which reads glazed next to the metal; "matched" when it's colour-matched), or glass
 * all over inside a metal band ("glass").
 */
export interface BackDesign {
  camera: "plateau" | "bar" | "square" | "pill" | "diagonal" | "single";
  material: "window" | "matched" | "glass";
}

const c = (name: string, hex: string): ColorOption => ({
  id: name.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
  name,
  hex,
});

/** Finishes available for every device, including ones newer than this catalog. */
export const GENERIC_COLORS: ColorOption[] = [
  c("Black", "#1f1f21"),
  c("Graphite", "#3a3a3c"),
  c("Silver", "#e3e4e5"),
  c("White", "#f4f3ef"),
  c("Natural", "#bfb8ad"),
  c("Gold", "#e6d3b3"),
  c("Blue", "#34405a"),
  c("Orange", "#ee7a35"),
];

// Side-button layouts, measured from Xcode's Simulator chrome. Offsets there are from the
// chrome's outer edge, so each layout subtracts that chrome's border to get screen-relative values.
const layout = (border: number, buttons: Array<[string, ChromeButton["side"], number, number, number?, ChromeButton["align"]?]>, vBorder = border) =>
  buttons.map(([name, side, offset, length, depth = 16, align = "leading"]): ChromeButton => ({
    name,
    side,
    offset: offset - (side === "left" || side === "right" ? vBorder : border),
    length,
    depth,
    align,
  }));

const PHONE_ACTION = layout(18, [
  ["action", "left", 160, 34],
  ["volume-up", "left", 221, 64],
  ["volume-down", "left", 300, 64],
  ["power", "right", 262, 101],
]);
const PHONE_ACTION_LARGE = layout(18, [
  ["action", "left", 180, 34],
  ["volume-up", "left", 268, 64],
  ["volume-down", "left", 354, 64],
  ["power", "right", 293, 101],
]);
const PHONE_CLASSIC = layout(22, [
  ["mute", "left", 160, 32],
  ["volume-up", "left", 221, 72],
  ["volume-down", "left", 300, 72],
  ["power", "right", 262, 117],
]);
const IPAD_PRO = layout(46, [
  ["volume-up", "right", 100, 52],
  ["volume-down", "right", 163, 52],
  ["power", "top", 74, 63, 16, "trailing"],
]);
const IPAD_MINI = layout(60, [
  ["volume-up", "top", 158, 65],
  ["volume-down", "top", 82, 65],
  ["power", "top", 82, 111, 16, "trailing"],
]);
const WATCH = layout(22, [
  ["digital-crown", "right", 65, 46, 18],
  ["side-button", "right", 153, 61, 8],
]);
const WATCH_ULTRA = layout(
  45.5,
  [
    ["digital-crown", "right", 84, 65, 28],
    ["side-button", "right", 160, 67, 16],
    ["action", "left", 138, 88, 8],
  ],
  31,
);

const screen = (width: number, height: number, scale: number, cornerRadius: number) => ({
  width,
  height,
  scale,
  cornerRadius,
});

// Sampled from Apple's product photography under neutral light.
const IPHONE_18_PRO_COLORS = [c("Black", "#29292b"), c("Silver", "#e2e2e0"), c("Glacier", "#a9b6c7"), c("Burgundy", "#4c2229")];
// iPhone Duo (2026): mirror-polished titanium.
const IPHONE_DUO_COLORS = [c("Night Sky", "#23262e"), c("Star White", "#ecebe6")];
const IPHONE_17_PRO_COLORS = [c("Deep Blue", "#323d57"), c("Silver", "#e4e4e2"), c("Cosmic Orange", "#e9773a")];
/** Camera Control sits two-thirds of the way down the right side. */
const CAMERA_CONTROL = { at: 0.655, length: 58 };
const PRO_ANTENNA = [0.083, 0.917];
const IPHONE_16_PRO_COLORS = [
  c("Black Titanium", "#303032"),
  c("White Titanium", "#f0eee9"),
  c("Natural Titanium", "#c2bbb0"),
  c("Desert Titanium", "#c1a58d"),
];
const IPHONE_15_PRO_COLORS = [
  c("Black Titanium", "#39393b"),
  c("White Titanium", "#efeeea"),
  c("Blue Titanium", "#3e4a57"),
  c("Natural Titanium", "#bfb9ae"),
];
const IPHONE_16_COLORS = [
  c("Black", "#2d2d2f"),
  c("White", "#f5f5f3"),
  c("Pink", "#f2bccf"),
  c("Teal", "#a9d1c9"),
  c("Ultramarine", "#8290ec"),
];
const IPHONE_15_COLORS = [
  c("Black", "#35393b"),
  c("Blue", "#d4dfe6"),
  c("Green", "#d9e3d1"),
  c("Yellow", "#f4ebc7"),
  c("Pink", "#f2d9dc"),
];
const IPAD_PRO_COLORS = [c("Space Black", "#2b2b2d"), c("Silver", "#e3e4e5")];
const IPAD_AIR_COLORS = [
  c("Space Gray", "#5f6064"),
  c("Blue", "#a9b9c9"),
  c("Purple", "#cfc5da"),
  c("Starlight", "#e8e1d3"),
];
const IPAD_COLORS = [c("Silver", "#e3e4e5"), c("Blue", "#a8c4da"), c("Pink", "#f0c4cc"), c("Yellow", "#f5e09c")];
const WATCH_COLORS = [
  c("Jet Black", "#1c1c1e"),
  c("Space Gray", "#3b3b3e"),
  c("Silver", "#e2e3e4"),
  c("Rose Gold", "#e8c9b9"),
  c("Natural Titanium", "#c8c2b8"),
  c("Gold Titanium", "#e0c9a3"),
  c("Slate Titanium", "#454547"),
];

export const DEVICE_MODELS: DeviceModel[] = [
  // iPhone — 2026
  {
    id: "iphone-18-pro-max",
    name: "iPhone 18 Pro Max",
    family: "iphone",
    screen: screen(1320, 2868, 3, 62),
    cutout: "island",
    island: { width: 82, height: 36.67 },
    bezel: 7.5,
    frame: 8,
    thickness: 53,
    finish: "aluminum",
    colors: IPHONE_18_PRO_COLORS,
    buttons: PHONE_ACTION_LARGE,
    cameraControl: CAMERA_CONTROL,
    antenna: PRO_ANTENNA,
    back: { camera: "plateau", material: "matched" },
  },
  {
    id: "iphone-18-pro",
    name: "iPhone 18 Pro",
    family: "iphone",
    screen: screen(1206, 2622, 3, 62),
    cutout: "island",
    island: { width: 82, height: 36.67 },
    bezel: 7.5,
    frame: 8.5,
    thickness: 53,
    finish: "aluminum",
    colors: IPHONE_18_PRO_COLORS,
    buttons: PHONE_ACTION,
    cameraControl: CAMERA_CONTROL,
    antenna: PRO_ANTENNA,
    back: { camera: "plateau", material: "matched" },
  },
  // iPhone Duo — 2026. Folded, it's a phone with a 5.4" outer display; open, a 7.6" inner display
  // (2670 × 1878, landscape when held open like a book), drawn like a small tablet.
  {
    id: "iphone-duo",
    name: "iPhone Duo",
    family: "iphone",
    aliases: ["iPhone Duo Folded", "iPhone Duo Closed", "iPhone Duo Outer"],
    screen: screen(1398, 2034, 3, 48),
    cutout: "island",
    bezel: 7,
    frame: 7,
    thickness: 52,
    finish: "polished",
    colors: IPHONE_DUO_COLORS,
    buttons: PHONE_ACTION,
    cameraControl: CAMERA_CONTROL,
    shareArt: ["iphone-duo-open"],
  },
  {
    id: "iphone-duo-open",
    name: "iPhone Duo (open)",
    family: "ipad",
    aliases: ["iPhone Duo Open", "iPhone Duo Unfolded", "iPhone Duo Inner", "iPhone Duo Opened"],
    screen: screen(1878, 2670, 3, 30),
    cutout: "none",
    bezel: 8,
    frame: 6,
    thickness: 26,
    finish: "polished",
    colors: IPHONE_DUO_COLORS,
    buttons: IPAD_MINI,
    camera: "short-edge",
    shareArt: ["iphone-duo"],
  },
  // iPhone — 2025
  {
    id: "iphone-17-pro-max",
    name: "iPhone 17 Pro Max",
    family: "iphone",
    screen: screen(1320, 2868, 3, 62),
    cutout: "island",
    bezel: 7.5,
    frame: 8,
    thickness: 53,
    finish: "aluminum",
    colors: IPHONE_17_PRO_COLORS,
    buttons: PHONE_ACTION_LARGE,
    cameraControl: CAMERA_CONTROL,
    antenna: PRO_ANTENNA,
    back: { camera: "plateau", material: "window" },
  },
  {
    id: "iphone-17-pro",
    name: "iPhone 17 Pro",
    family: "iphone",
    screen: screen(1206, 2622, 3, 62),
    cutout: "island",
    bezel: 7.5,
    frame: 8.5,
    thickness: 53,
    finish: "aluminum",
    colors: IPHONE_17_PRO_COLORS,
    buttons: PHONE_ACTION,
    cameraControl: CAMERA_CONTROL,
    antenna: PRO_ANTENNA,
    back: { camera: "plateau", material: "window" },
  },
  {
    id: "iphone-air",
    name: "iPhone Air",
    family: "iphone",
    screen: screen(1260, 2736, 3, 62),
    cutout: "island",
    bezel: 7.5,
    frame: 8,
    thickness: 34,
    finish: "polished",
    colors: [c("Space Black", "#1f1f21"), c("Cloud White", "#f3f2ee"), c("Light Gold", "#eadfc7"), c("Sky Blue", "#d4e3ef")],
    buttons: PHONE_ACTION_LARGE,
    cameraControl: CAMERA_CONTROL,
    back: { camera: "bar", material: "glass" },
  },
  {
    id: "iphone-17",
    name: "iPhone 17",
    family: "iphone",
    screen: screen(1206, 2622, 3, 62),
    cutout: "island",
    bezel: 8,
    frame: 8,
    thickness: 48,
    finish: "aluminum",
    colors: [
      c("Black", "#2a2a2c"),
      c("White", "#f2f2f0"),
      c("Mist Blue", "#a3b5cd"),
      c("Lavender", "#d8cce6"),
      c("Sage", "#b5c1a5"),
    ],
    buttons: PHONE_ACTION,
    cameraControl: CAMERA_CONTROL,
    back: { camera: "pill", material: "glass" },
  },
  // iPhone — 2024
  {
    id: "iphone-16-pro-max",
    name: "iPhone 16 Pro Max",
    family: "iphone",
    screen: screen(1320, 2868, 3, 62),
    cutout: "island",
    bezel: 7,
    frame: 7.5,
    thickness: 50,
    finish: "titanium",
    colors: IPHONE_16_PRO_COLORS,
    buttons: PHONE_ACTION_LARGE,
    cameraControl: CAMERA_CONTROL,
    back: { camera: "square", material: "glass" },
  },
  {
    id: "iphone-16-pro",
    name: "iPhone 16 Pro",
    family: "iphone",
    screen: screen(1206, 2622, 3, 62),
    cutout: "island",
    bezel: 7,
    frame: 8,
    thickness: 50,
    finish: "titanium",
    colors: IPHONE_16_PRO_COLORS,
    buttons: PHONE_ACTION,
    cameraControl: CAMERA_CONTROL,
    back: { camera: "square", material: "glass" },
  },
  {
    id: "iphone-16-plus",
    name: "iPhone 16 Plus",
    family: "iphone",
    screen: screen(1290, 2796, 3, 55),
    cutout: "island",
    bezel: 11.5,
    frame: 8,
    thickness: 47,
    finish: "aluminum",
    colors: IPHONE_16_COLORS,
    buttons: PHONE_ACTION_LARGE,
    cameraControl: CAMERA_CONTROL,
    back: { camera: "pill", material: "glass" },
  },
  {
    id: "iphone-16",
    name: "iPhone 16",
    family: "iphone",
    screen: screen(1179, 2556, 3, 55),
    cutout: "island",
    bezel: 11.5,
    frame: 8,
    thickness: 47,
    finish: "aluminum",
    colors: IPHONE_16_COLORS,
    buttons: PHONE_ACTION,
    cameraControl: CAMERA_CONTROL,
    back: { camera: "pill", material: "glass" },
  },
  {
    id: "iphone-16e",
    name: "iPhone 16e",
    family: "iphone",
    screen: screen(1170, 2532, 3, 47.33),
    cutout: "notch",
    bezel: 12.5,
    frame: 8,
    thickness: 47,
    finish: "aluminum",
    colors: [c("Black", "#2b2b2d"), c("White", "#f3f3f1")],
    buttons: PHONE_CLASSIC,
    back: { camera: "single", material: "glass" },
  },
  // iPhone — 2023
  {
    id: "iphone-15-pro-max",
    name: "iPhone 15 Pro Max",
    family: "iphone",
    screen: screen(1290, 2796, 3, 55),
    cutout: "island",
    bezel: 8.5,
    frame: 8,
    thickness: 50,
    finish: "titanium",
    colors: IPHONE_15_PRO_COLORS,
    buttons: PHONE_ACTION_LARGE,
    back: { camera: "square", material: "glass" },
  },
  {
    id: "iphone-15-pro",
    name: "iPhone 15 Pro",
    family: "iphone",
    screen: screen(1179, 2556, 3, 55),
    cutout: "island",
    bezel: 8.5,
    frame: 8,
    thickness: 50,
    finish: "titanium",
    colors: IPHONE_15_PRO_COLORS,
    buttons: PHONE_ACTION,
    back: { camera: "square", material: "glass" },
  },
  {
    id: "iphone-15-plus",
    name: "iPhone 15 Plus",
    family: "iphone",
    screen: screen(1290, 2796, 3, 55),
    cutout: "island",
    bezel: 11.5,
    frame: 8,
    thickness: 47,
    finish: "aluminum",
    colors: IPHONE_15_COLORS,
    buttons: PHONE_CLASSIC,
    back: { camera: "diagonal", material: "glass" },
  },
  {
    id: "iphone-15",
    name: "iPhone 15",
    family: "iphone",
    screen: screen(1179, 2556, 3, 55),
    cutout: "island",
    bezel: 11.5,
    frame: 8,
    thickness: 47,
    finish: "aluminum",
    colors: IPHONE_15_COLORS,
    buttons: PHONE_CLASSIC,
    back: { camera: "diagonal", material: "glass" },
  },
  // iPad
  {
    id: "ipad-pro-13",
    name: "iPad Pro 13-inch",
    family: "ipad",
    // Apple's art writes the size as 13", without "-inch".
    aliases: ["iPad Pro 13-inch (M5)", "iPad Pro 13-inch (M4)", "iPad Pro 13"],
    screen: screen(2064, 2752, 2, 30),
    cutout: "none",
    bezel: 39,
    frame: 5,
    thickness: 27,
    finish: "aluminum",
    colors: IPAD_PRO_COLORS,
    buttons: IPAD_PRO,
    camera: "long-edge",
  },
  {
    id: "ipad-pro-11",
    name: "iPad Pro 11-inch",
    family: "ipad",
    // Apple's art writes the size as 11", without "-inch".
    aliases: ["iPad Pro 11-inch (M5)", "iPad Pro 11-inch (M4)", "iPad Pro 11"],
    screen: screen(1668, 2420, 2, 30),
    cutout: "none",
    bezel: 39,
    frame: 5,
    thickness: 28,
    finish: "aluminum",
    colors: IPAD_PRO_COLORS,
    buttons: IPAD_PRO,
    camera: "long-edge",
  },
  {
    id: "ipad-air-13",
    name: "iPad Air 13-inch",
    family: "ipad",
    // Apple's art writes the size as 13", without "-inch".
    aliases: ["iPad Air 13-inch (M4)", "iPad Air 13-inch (M3)", "iPad Air 13-inch (M2)", "iPad Air 13"],
    screen: screen(2048, 2732, 2, 18),
    cutout: "none",
    bezel: 41,
    frame: 5.5,
    thickness: 32,
    finish: "aluminum",
    colors: IPAD_AIR_COLORS,
    buttons: IPAD_MINI,
    camera: "long-edge",
  },
  {
    id: "ipad-air-11",
    name: "iPad Air 11-inch",
    family: "ipad",
    // Apple's art writes the size as 11", without "-inch".
    aliases: ["iPad Air 11-inch (M4)", "iPad Air 11-inch (M3)", "iPad Air 11-inch (M2)", "iPad Air 11"],
    screen: screen(1640, 2360, 2, 18),
    cutout: "none",
    bezel: 41,
    frame: 5.5,
    thickness: 32,
    finish: "aluminum",
    colors: IPAD_AIR_COLORS,
    buttons: IPAD_MINI,
    camera: "long-edge",
  },
  {
    id: "ipad-mini",
    name: "iPad mini",
    family: "ipad",
    aliases: ["iPad mini (A17 Pro)"],
    screen: screen(1488, 2266, 2, 21.5),
    cutout: "none",
    bezel: 54.5,
    frame: 5.5,
    thickness: 40,
    finish: "aluminum",
    colors: IPAD_AIR_COLORS,
    buttons: IPAD_MINI,
    camera: "short-edge",
  },
  {
    id: "ipad",
    name: "iPad",
    family: "ipad",
    aliases: ["iPad (A16)"],
    screen: screen(1640, 2360, 2, 18),
    cutout: "none",
    bezel: 50.5,
    frame: 5.5,
    thickness: 36,
    finish: "aluminum",
    colors: IPAD_COLORS,
    buttons: IPAD_MINI,
    camera: "long-edge",
  },
  // Apple Watch
  {
    id: "apple-watch-46mm",
    name: "Apple Watch 46mm",
    family: "watch",
    aliases: ["Apple Watch Series 11 (46mm)", "Apple Watch Series 10 (46mm)"],
    screen: screen(416, 496, 2, 50),
    cutout: "none",
    bezel: 16,
    frame: 6,
    thickness: 62,
    finish: "aluminum",
    colors: WATCH_COLORS,
    buttons: WATCH,
  },
  {
    id: "apple-watch-42mm",
    name: "Apple Watch 42mm",
    family: "watch",
    aliases: ["Apple Watch Series 11 (42mm)", "Apple Watch Series 10 (42mm)"],
    screen: screen(374, 446, 2, 46),
    cutout: "none",
    bezel: 16,
    frame: 6,
    thickness: 62,
    finish: "aluminum",
    colors: WATCH_COLORS,
    buttons: WATCH,
  },
  {
    id: "apple-watch-ultra",
    name: "Apple Watch Ultra 49mm",
    family: "watch",
    // The Ultra comes in one size, so Apple's art may leave out "49mm" or shorten it to "U3".
    aliases: ["Apple Watch Ultra 3 (49mm)", "Apple Watch Ultra 2 (49mm)", "Apple Watch Ultra", "Apple Watch U3", "Apple Watch U2"],
    screen: screen(422, 514, 2, 57),
    cutout: "none",
    bezel: 12,
    frame: 20,
    thickness: 77,
    finish: "titanium",
    colors: [c("Natural Titanium", "#c9c4bb"), c("Black Titanium", "#2a2a2c")],
    buttons: WATCH_ULTRA,
  },
  // Mac
  {
    id: "macbook-pro-14",
    name: "MacBook Pro 14-inch",
    family: "mac",
    aliases: ["MacBook Pro 14", "MacBook Pro"],
    screen: screen(3024, 1964, 2, 10),
    cutout: "notch",
    bezel: 17,
    chin: 26,
    frame: 4,
    thickness: 12,
    finish: "aluminum",
    colors: [c("Space Black", "#2e2e30"), c("Silver", "#e3e4e6")],
    buttons: [],
  },
  {
    id: "macbook-pro-16",
    name: "MacBook Pro 16-inch",
    family: "mac",
    aliases: ["MacBook Pro 16"],
    screen: screen(3456, 2234, 2, 10),
    cutout: "notch",
    bezel: 18,
    chin: 28,
    frame: 4,
    thickness: 12,
    finish: "aluminum",
    colors: [c("Space Black", "#2e2e30"), c("Silver", "#e3e4e6")],
    buttons: [],
  },
  {
    id: "macbook-air-13",
    name: "MacBook Air 13-inch",
    family: "mac",
    aliases: ["MacBook Air 13", "MacBook Air"],
    screen: screen(2560, 1664, 2, 10),
    cutout: "notch",
    bezel: 17,
    chin: 26,
    frame: 4,
    thickness: 10,
    finish: "aluminum",
    colors: [c("Midnight", "#2e3440"), c("Starlight", "#e4ddd0"), c("Sky Blue", "#cfdce7"), c("Silver", "#e3e4e6")],
    buttons: [],
  },
  {
    id: "macbook-air-15",
    name: "MacBook Air 15-inch",
    family: "mac",
    aliases: ["MacBook Air 15"],
    screen: screen(2880, 1864, 2, 10),
    cutout: "notch",
    bezel: 17,
    chin: 26,
    frame: 4,
    thickness: 10,
    finish: "aluminum",
    colors: [c("Midnight", "#2e3440"), c("Starlight", "#e4ddd0"), c("Sky Blue", "#cfdce7"), c("Silver", "#e3e4e6")],
    buttons: [],
  },
];

export const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

export function findModel(query: string): DeviceModel | undefined {
  const q = norm(query);
  return (
    DEVICE_MODELS.find((m) => norm(m.id) === q || norm(m.name) === q) ??
    DEVICE_MODELS.find((m) => m.aliases?.some((a) => norm(a) === q))
  );
}

export function defaultModelForFamily(family: Family): DeviceModel {
  return DEVICE_MODELS.find((m) => m.family === family)!;
}
