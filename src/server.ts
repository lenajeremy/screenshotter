import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { captureScreenshot } from "./simulator/capture.js";
import * as sim from "./simulator/simctl.js";
import { CANVAS_PRESETS } from "./render/layouts.js";
import { bezelSummary } from "./render/bezels.js";
import { createMockup, layoutScene } from "./render/mockup.js";
import { stickerNames } from "./render/images.js";
import { CLAY_TONES } from "./render/frame.js";
import { LAYOUTS, MockupInputShape, type MockupInput } from "./render/schema.js";
import { createMockupSet, exportSet, MockupSetShape } from "./render/set.js";
import { cropImage, CropInputShape, createGrid, GridInputShape } from "./render/compose.js";
import { houseStyle, updateHouseStyle } from "./util/style.js";
import { DESIGN_GUIDE } from "./design/guide.js";
import { RECIPES, buildRecipe } from "./design/recipes.js";
import { adoptFiles, findScene, firstScreens, getScene, libraryFolder, listScenes, saveScene, sceneSizes, sceneThumb, useLibrary, withFirstSize, type SavedGroup } from "./studio/scenes.js";
import { studioFolder } from "./util/studio.js";
import { recordMac, RecordMacShape, recordWeb, RecordWebShape } from "./capture/record.js";
import { outputRoot } from "./util/files.js";
import { captureWeb, WEB_VIEWPORTS } from "./capture/web.js";
import { captureMac, listMacWindows } from "./capture/mac.js";
import { recognizeText } from "./native/ocr.js";
import { imageSize } from "./util/image.js";
import { resolveUserPath } from "./util/files.js";
import { LOOKS } from "./render/looks.js";
import { GRADES } from "./render/schema.js";
import { readSidecar, resolveDevice } from "./devices/resolve.js";
import { recordSimulator } from "./simulator/record.js";
import { createVideo, storyboard, VideoInputShape } from "./render/video.js";
import { createSequence, sequenceStoryboard, SequenceInputShape, TRANSITIONS } from "./render/sequence.js";
import { previewBase64 } from "./util/image.js";

const VERSION = "0.9.0";

const INSTRUCTIONS = `Screenshotter captures real app screens and turns them into marketing-ready device mockups and App Store sets.

Capture:
- iOS/iPadOS/watchOS apps: list_simulators / list_apps, then capture_screenshot (bundleId, deep link \`url\` or \`launchArgs\` to reach a screen). Status bar is set to 9:41 / full battery; the capture waits until the screen stops animating.
- Websites: capture_web (iPhone/iPad in real Mobile Safari on the simulator, or desktop in headless Chrome).
- Mac apps: capture_mac (a window by app name, or the whole screen).

Compose with create_mockup (or create_mockup_set for a whole series):
- Frames: device hardware (iPhone, iPad, Apple Watch, MacBook) from Apple's own product art in the finishes Apple drew, or in \`clay\` (that art in one matte colour: porcelain, sand, sage, sky, slate, ink or any); browser, window, card (the screen only, with the device's own corners) or none. Several devices make a composition (e.g. MacBook + iPhone).
- Backgrounds: named looks (photographic, public-domain paintings and prints like "great-wave" or "monet-bridge", soft grounds like "cream-grain"), gradients/mesh, any photo, Unsplash (\`unsplash\` search or "unsplash:<id>"), or AI-generated (\`generate\` prompt) with photo treatment: motion blur, blur, haze, tint, bloom, halation. \`finish\` reprints or repaints the backdrop (never the UI): risograph, newsprint, halftone, dither, oil, watercolor, ink, fluted-glass.
- Effects: film grain, vignette, edge blur, colour grade. Shadows: soft/medium/strong/studio. Per device: \`blur\` (soft focus behind a sharp hero device) and \`fade\` (dissolve into the backdrop).
- Highlights call out UI: lift a row (\`breakout\` makes a card wider than the device), loupe (can sit beside the device), outline, spotlight, blur-rest, blur (hide something private), highlighter, numbered step markers and curved arrows. Target by visible text (on-device OCR) or a rect; find_text lists the text boxes.
- Image blocks: \`images\` place logos, the app icon (\`mask: "icon"\`), stickers (\`sticker\`, a die-cut white edge; built-in ones as \`src: "sticker:heart"\`) or any picture (SVG too), by centre and height, with corners, a shadow, soft focus and opacity.
- Badges: shapes of type burst ("NEW"), ribbon ("Try it free"), bubble (a speech bubble) and tag ("FREE") hold your words in \`text\`.
- Awards and ratings: shapes of type laurel (a wreath round \`text\`, with a \`caption\`) and rating (stars filled to \`value\`, a line of \`text\` under them). Only claim awards and ratings the app really has.
- Shapes: arrows, lines, circles, boxes, triangles, stars and number badges drawn over the scene, each with a fill and a stroke, clean or hand-drawn (sketch). Aim one at text on a screen with \`around\` (an ellipse goes around it, a badge beside it, an arrow to its edge), or place it freely with x/y, or from/to.
- Animation: a scene's \`animations\` time each item's entrance, changes and exit in a video (create_video): \`{ targets: "caption", at: 0.5, enter: "slide-up" }\`, \`{ targets: ["device-1", "device-2"], at: 2, enter: "zoom", ease: "back-out" }\` (a group, zooming from its shared centre), \`{ targets: "shape-1", at: 3.5, to: { fill: "#ff3b30", scale: 1.3 } }\`, \`{ targets: "shape-2", at: 4, to: { end: { x: 0.6, y: 0.4 }, bend: 0.4 } }\` (an arrow's end and curve), \`{ targets: "camera", at: 5, to: { zoom: 2.5, x: 0.8, y: 0.6 } }\` (the camera pushes in on a point; \`zoom: 1\` pulls back), \`{ targets: "caption", at: 0.3, enter: "blur", by: "word" }\` (text a word or letter at a time, here coming into focus), \`{ targets: "shape-1", at: 0, duration: 3, path: { shape: "circle", size: 0.03 }, repeat: true }\` (a loop round a circle for the whole video; \`path: { points: [...] }\` is a route of your own), \`{ targets: "device-1", at: 1, duration: 1.6, to: { dy: -0.015 }, repeat: true, yoyo: true }\` (a float), \`{ targets: "backdrop", at: 0, duration: 6, to: { zoom: 1.15, hue: 30 } }\` (only the backdrop pushes in and shifts colour). Anything can blur (\`blur\` on texts, shapes, devices, images, textStyle; animate \`to: { blur }\`). \`{ targets: "caption", at: 0.4, duration: 0.8, from: { mark: 0 } }\` draws a headline's highlighter in; \`{ targets: "shape-1", at: 1, enter: "fade", from: { value: 0 } }\` fills a rating's stars up. Item ids come from layout_mockup. The design guide has the pacing. preview_video shows the frames at the key moments in a second or so: check the timing there before create_video.
- Studio scenes: list_scenes and get_scene open the designs the person saved in the Studio; save_scene puts a design into it (a new scene by default; replace an existing one only when asked). Every element stays editable there. A design can be a set: screens in store order (shots), each an App Store screenshot that also plays as a shot of its preview video, made at one or several sizes (sizes: iPhone, iPad, Apple Watch…). export_scene_set exports a saved set's every screen of every size, by size or ready for fastlane deliver.
- Caption: headline/subheadline with **accent** words (their own colour, font, weight or italic, and a mark: \`accentMark\` highlight, underline or pill), fonts from Google Fonts, top/bottom/left/right. Text (headline or extra) can have an outline (\`stroke\`), a \`decoration\` (underline, strike, highlight), a line height; a text's pill its padding and corner radius.
- Mac: MacBook screens draw the macOS menu bar with the app's name and menus; a scene \`menuBar\` draws one across the top of the canvas for menu bar app shots, with the app's menu hung under its status item.
- Several shots in one video: create_sequence joins scenes (each with its own animations and length) with transitions (cut, crossfade, fade through black, push, wipe, iris, zoom, blur). preview_sequence shows its key moments first. For the App Store, \`size: "app-store-iphone"\` (or app-store-ipad, app-store-mac) follows Apple's app preview rules (15–30 s, 30 fps, H.264, a stereo track); \`versions\` on create_video or create_sequence also makes vertical, square, 4:5, widescreen or App Store copies, each design fitted (or laid out again) for that shape.
- Layouts include grid (a mosaic of screens). \`camera\` zooms the scene in on a point for a crisp close-up.
- Recipes: apply_recipe builds a complete, proven design (bold hero, art director, gallery painting, risograph, 3D tilt, depth of field, rising pair, staircase, mosaic, five-star review, award, feature call-out, how-to, dissolve) from your screenshots: a strong start to refine.
- Finished images: crop_image crops or zooms into part of any image; create_grid lays images out as a contact sheet or mosaic. Use a grid to compare variants side by side, and a crop to check small details before you call something done.
- Video: create_video renders the same scene with motion (float, drift, push-in), zooms that follow the action (video.zooms), a drawn cursor with clicks and drags (video.cursor) and timed reveals. Recordings to play inside a frame: record_simulator (iPhone, iPad, Watch), record_web (a rehearsed click-through of a page, with its cursor track) and record_mac (an app window).

Design: read design_guide once before you design (composition, copy, type, colour, backdrops, callouts and a checklist). House style: call get_house_style before designing and follow it. When the person says they like or dislike something, or asks for something every time ("always use Space Black", "less text"), save it with remember_style.

Always look at the returned preview and iterate (positions, sizes, rotation, copy). The scene is a set of entities (devices, caption, texts, images, shapes); every result lists them with their resolved positions, and layout_mockup returns them without rendering. Move an entity by setting its properties: devices[i].x/y (centre)/height/rotate, textStyle.x/y for the caption, texts[i].x/y. Positions and sizes are fractions of the canvas (x 0 = left, 1 = right). Each output has a .mockup.json with the exact request for re-rendering.
Call list_mockup_options for devices, colours, looks, canvases, layouts and grades.`;

type Content = CallToolResult["content"];

function text(value: unknown): Content[number] {
  return { type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) };
}

async function image(file: string, maxEdge = 1000): Promise<Content[number] | undefined> {
  try {
    return { type: "image", data: await previewBase64(file, maxEdge), mimeType: "image/jpeg" };
  } catch {
    return undefined;
  }
}

/** Run a tool body and turn thrown errors into readable tool errors. */
async function guard(fn: () => Promise<Content>): Promise<CallToolResult> {
  try {
    return { content: await fn() };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { isError: true, content: [text(message)] };
  }
}

const StatusBarSchema = z
  .object({
    time: z.string().optional().describe("Default \"9:41\"."),
    batteryLevel: z.number().min(0).max(100).optional().describe("Default 100."),
    batteryState: z.enum(["charged", "charging", "discharging"]).optional(),
    wifiBars: z.number().min(0).max(3).optional(),
    cellularBars: z.number().min(0).max(4).optional(),
    dataNetwork: z.enum(["hide", "wifi", "3g", "4g", "lte", "lte-a", "lte+", "5g", "5g+", "5g-uwb", "5g-uc"]).optional(),
    operatorName: z.string().optional().describe("Carrier name; empty string hides it (default)."),
  })
  .describe("Status bar overrides. Defaults to Apple's marketing look: 9:41, full battery, full bars.");

const CaptureShape = {
  simulator: z
    .string()
    .optional()
    .describe("Simulator name (\"iPhone 17 Pro\"), device type, UDID, or \"booted\". A missing device type is created. Default: booted, else newest iPhone."),
  runtime: z.string().optional().describe("Prefer a runtime, e.g. \"iOS 26.5\"."),
  bundleId: z.string().optional().describe("App to launch (relaunched fresh by default)."),
  appPath: z.string().optional().describe("Built .app to install before launching."),
  url: z.string().optional().describe("Deep link / universal link to open after launch, to reach a specific screen."),
  launchArgs: z.array(z.string()).optional().describe("Arguments passed to the app, e.g. [\"-UITestDemoData\", \"YES\"]."),
  launchEnv: z.record(z.string(), z.string()).optional().describe("Environment variables for the app."),
  relaunch: z.boolean().optional().describe("Terminate a running instance before launching. Default true."),
  appearance: z.enum(["light", "dark"]).optional(),
  clock: z.enum(["12h", "24h", "system"]).optional().describe("Status bar clock style. Default 12h so it reads 9:41. Changing it reboots the simulator once."),
  locale: z.string().optional().describe("e.g. \"en_US\", \"de_DE\". Applied to the simulator (reboots once) and the app."),
  language: z.string().optional().describe("e.g. \"en\", \"de\", \"ja\". Applied to the simulator (reboots once) and the app."),
  contentSize: z
    .enum([
      "extra-small",
      "small",
      "medium",
      "large",
      "extra-large",
      "extra-extra-large",
      "extra-extra-extra-large",
      "accessibility-medium",
      "accessibility-large",
      "accessibility-extra-large",
      "accessibility-extra-extra-large",
      "accessibility-extra-extra-extra-large",
    ])
    .optional()
    .describe("Dynamic Type size."),
  statusBar: z.union([StatusBarSchema, z.literal(false)]).optional().describe("Overrides, or false to show the real status bar."),
  grantPermissions: z
    .array(z.enum(sim.PRIVACY_SERVICES))
    .optional()
    .describe("Pre-grant privacy permissions (location, photos, contacts, calendar…) so their alerts don't appear, e.g. [\"all\"]. Notification prompts can't be pre-granted."),
  location: z.object({ latitude: z.number(), longitude: z.number() }).optional(),
  increaseContrast: z.boolean().optional().describe("Turn Increase Contrast on or off."),
  waitMs: z.number().optional().describe("Extra wait after launch/deep link before checking the screen. Default 300 ms (1500 ms with settle: false)."),
  settle: z.boolean().optional().describe("Wait until the screen stops changing (launch animations, loading) before capturing. Default true; typically adds about 1 s."),
  clearAlerts: z
    .boolean()
    .optional()
    .describe("If a system prompt left over from another app covers the screen, clear it by restarting SpringBoard (nothing is answered) and capture again. Default true."),
  maxWaitMs: z.number().optional().describe("Capture anyway if the screen is still changing after this long. Default 10000."),
  output: z.string().optional().describe("Output file or directory. Default ./screenshots/raw/."),
  openSimulatorApp: z.boolean().optional().describe("Also show the Simulator window. Default false (headless)."),
  preview: z.boolean().optional().describe("Return a preview image. Default true."),
};

export function createServer(): McpServer {
  const server = new McpServer({ name: "screenshotter", version: VERSION }, { instructions: INSTRUCTIONS });

  server.registerTool(
    "list_simulators",
    {
      title: "List simulators",
      description: "List available iOS/iPadOS/watchOS simulators with their state, runtime and UDID.",
      inputSchema: {
        platform: z.string().optional().describe("Filter by platform, e.g. \"iOS\" or \"watchOS\"."),
        bootedOnly: z.boolean().optional(),
      },
      annotations: { readOnlyHint: true },
    },
    ({ platform, bootedOnly }) =>
      guard(async () => {
        const sims = (await sim.listSimulators()).filter(
          (s) => (!platform || s.platform.toLowerCase() === platform.toLowerCase()) && (!bootedOnly || s.state === "Booted"),
        );
        if (!sims.length) return [text("No matching simulators.")];
        const lines = sims.map(
          (s) => `${s.state === "Booted" ? "●" : "○"} ${s.name} — ${s.runtimeName} — ${s.state} — ${s.udid}`,
        );
        return [text(`${sims.length} simulators (● booted):\n${lines.join("\n")}`)];
      }),
  );

  server.registerTool(
    "list_apps",
    {
      title: "List installed apps",
      description: "List apps installed on a simulator (bundle id and name). Boots the simulator if needed.",
      inputSchema: {
        simulator: z.string().optional().describe("Simulator name, device type, UDID or \"booted\". Default: booted, else newest iPhone."),
        includeSystem: z.boolean().optional().describe("Include Apple's built-in apps. Default false."),
      },
      annotations: { readOnlyHint: true },
    },
    ({ simulator, includeSystem }) =>
      guard(async () => {
        const { s, all } = await sim.withSimulatorLock(async () => {
          const s = await sim.resolveSimulator({ simulator });
          await sim.bootSimulator(s.udid, false, s.state);
          return { s, all: await sim.listApps(s.udid, true) };
        });
        const apps = all.filter((a) => includeSystem || a.type !== "System");
        if (!apps.length) {
          return [text(`No user apps on ${s.name}. Build and install one (or pass appPath to capture_screenshot), or set includeSystem.`)];
        }
        return [text(`Apps on ${s.name} (${s.runtimeName}):\n${apps.map((a) => `${a.name} — ${a.bundleId}${a.type === "System" ? " (system)" : ""}`).join("\n")}`)];
      }),
  );

  server.registerTool(
    "simulator_control",
    {
      title: "Control a simulator",
      description:
        "Drive a simulator between captures: boot/shutdown, launch/terminate an app, open a deep link, install an app, set appearance, status bar or location, grant permissions, or show the Simulator window.",
      inputSchema: {
        action: z.enum([
          "boot",
          "shutdown",
          "open_simulator_app",
          "launch",
          "terminate",
          "open_url",
          "install",
          "appearance",
          "status_bar",
          "clear_status_bar",
          "location",
          "grant_permissions",
        ]),
        simulator: z.string().optional(),
        bundleId: z.string().optional(),
        url: z.string().optional(),
        appPath: z.string().optional().describe("Path to a built .app for install."),
        appearance: z.enum(["light", "dark"]).optional(),
        statusBar: StatusBarSchema.optional(),
        latitude: z.number().optional(),
        longitude: z.number().optional(),
        permissions: z
          .array(z.enum(sim.PRIVACY_SERVICES))
          .optional()
          .describe("Services to pre-grant; default [\"all\"]. Notification prompts can't be pre-granted by simctl."),
        launchArgs: z.array(z.string()).optional(),
      },
    },
    (a) =>
      guard(() => sim.withSimulatorLock(async () => {
        const s = await sim.resolveSimulator({ simulator: a.simulator });
        const need = (v: unknown, name: string) => {
          if (v === undefined || v === null || v === "") throw new Error(`"${name}" is required for action ${a.action}.`);
        };
        if (a.action !== "shutdown" && a.action !== "boot") await sim.bootSimulator(s.udid, false, s.state);
        switch (a.action) {
          case "boot":
            await sim.bootSimulator(s.udid);
            break;
          case "shutdown":
            await sim.shutdownSimulator(s.udid);
            break;
          case "open_simulator_app":
            await sim.bootSimulator(s.udid, true);
            break;
          case "launch":
            need(a.bundleId, "bundleId");
            await sim.launchApp(s.udid, a.bundleId!, { args: a.launchArgs });
            break;
          case "terminate":
            need(a.bundleId, "bundleId");
            await sim.terminateApp(s.udid, a.bundleId!);
            break;
          case "open_url":
            need(a.url, "url");
            await sim.openUrl(s.udid, a.url!);
            break;
          case "install":
            need(a.appPath, "appPath");
            await sim.installApp(s.udid, resolveUserPath(a.appPath!));
            break;
          case "appearance":
            need(a.appearance, "appearance");
            await sim.setAppearance(s.udid, a.appearance!);
            break;
          case "status_bar":
            await sim.overrideStatusBar(s.udid, a.statusBar ?? {});
            break;
          case "clear_status_bar":
            await sim.clearStatusBar(s.udid);
            break;
          case "location":
            need(a.latitude, "latitude");
            need(a.longitude, "longitude");
            await sim.setLocation(s.udid, a.latitude!, a.longitude!);
            break;
          case "grant_permissions":
            need(a.bundleId, "bundleId");
            await sim.grantPermissions(s.udid, a.bundleId!, a.permissions ?? ["all"]);
            break;
        }
        return [text(`${a.action} done on ${s.name} (${s.udid}).`)];
      })),
  );

  server.registerTool(
    "capture_screenshot",
    {
      title: "Capture a simulator screenshot",
      description:
        "Boot a simulator if needed, set a clean status bar (9:41), optionally install/launch an app, open a deep link, and capture a full-resolution PNG. Returns the file path plus a preview. Use the path with create_mockup.",
      inputSchema: CaptureShape,
    },
    (a) =>
      guard(async () => {
        const r = await captureScreenshot(a);
        const summary = {
          path: r.path,
          size: `${r.width}×${r.height}`,
          simulator: `${r.simulator.name} (${r.simulator.runtimeName})`,
          udid: r.simulator.udid,
          steps: r.steps,
          ...(r.warnings.length ? { warnings: r.warnings } : {}),
        };
        const content: Content = [text(summary)];
        if (a.preview !== false) {
          const img = await image(r.path, 900);
          if (img) content.push(img);
        }
        return content;
      }),
  );

  server.registerTool(
    "capture_web",
    {
      title: "Capture a web page",
      description:
        "Screenshot a web page. iPhone/iPad viewports open it in real Mobile Safari on the iOS Simulator (native status bar and Safari UI); desktop viewports render it in headless Chrome and default to a browser frame in create_mockup.",
      inputSchema: {
        url: z.string().url(),
        viewport: z
          .union([z.enum(Object.keys(WEB_VIEWPORTS) as [string, ...string[]]), z.object({ width: z.number(), height: z.number(), scale: z.number().optional(), mobile: z.boolean().optional() })])
          .optional()
          .describe("iphone, iphone-max, ipad, desktop (default), macbook, wide, or a custom size in CSS px."),
        colorScheme: z.enum(["light", "dark"]).optional(),
        fullPage: z.boolean().optional(),
        selector: z.string().optional().describe("Capture just this element."),
        hide: z.array(z.string()).optional().describe("CSS selectors to hide (chat widgets, promos). Cookie banners are hidden automatically."),
        hideBanners: z.boolean().optional().describe("Hide cookie/consent banners automatically. Default true."),
        scale: z.number().min(1).max(4).optional().describe("Pixel density. Default 3 for desktop pages (crisp on large canvases), 3 for iPhone, 2 for iPad."),
        engine: z.enum(["safari", "chrome"]).optional().describe("safari = Mobile Safari in the iOS Simulator (default for iphone/ipad); chrome = headless Chrome page render."),
        simulator: z.string().optional().describe("Simulator for the safari engine. Default matches the viewport."),
        waitMs: z.number().optional(),
        output: z.string().optional(),
        preview: z.boolean().optional(),
      },
    },
    (a) =>
      guard(async () => {
        const r = await captureWeb(a as Parameters<typeof captureWeb>[0]);
        const content: Content = [text({ path: r.path, size: `${r.width}×${r.height}`, engine: r.engine, frame: r.device ?? "browser", ...(r.warnings?.length ? { warnings: r.warnings } : {}) })];
        if (a.preview !== false) {
          const img = await image(r.path, 900);
          if (img) content.push(img);
        }
        return content;
      }),
  );

  server.registerTool(
    "capture_mac",
    {
      title: "Capture a Mac app",
      description:
        "Capture a macOS app window (by app name) or the whole screen with screencapture. Window captures keep their native chrome and default to frame \"none\" in create_mockup; full-screen captures fit a MacBook frame. Needs Screen Recording permission for the host app.",
      inputSchema: {
        app: z.string().optional().describe("App name, e.g. \"Xcode\". Omit to capture the whole screen."),
        windowId: z.number().optional(),
        listWindows: z.boolean().optional().describe("Only list capturable windows."),
        shadow: z.boolean().optional().describe("Keep the native window shadow. Default false."),
        activate: z.boolean().optional().describe("Bring the app forward first. Default true."),
        display: z.number().optional(),
        output: z.string().optional(),
        preview: z.boolean().optional(),
      },
    },
    (a) =>
      guard(async () => {
        if (a.listWindows) {
          const windows = await listMacWindows();
          return [text(windows.map((w) => `${w.id} — ${w.app}${w.title ? ` — ${w.title}` : ""} (${w.width}×${w.height})`).join("\n") || "No windows.")];
        }
        const r = await captureMac(a);
        const content: Content = [text({ path: r.path, size: `${r.width}×${r.height}`, window: r.window })];
        if (a.preview !== false) {
          const img = await image(r.path, 900);
          if (img) content.push(img);
        }
        return content;
      }),
  );

  server.registerTool(
    "find_text",
    {
      title: "Find text in a screenshot",
      description:
        "Run on-device OCR (Apple Vision) on a screenshot and return each text line with its box in pixels and points. Use it to target highlights precisely or to check copy.",
      inputSchema: {
        screenshot: z.string(),
        query: z.string().optional().describe("Only return lines containing this text."),
      },
      annotations: { readOnlyHint: true },
    },
    (a) =>
      guard(async () => {
        const file = resolveUserPath(a.screenshot);
        const size = await imageSize(file);
        // Points per pixel: from the capture's metadata, else from the device it matches.
        const sidecar = readSidecar(file);
        const device = sidecar?.scale ? undefined : await resolveDevice(undefined, { path: file, ...size }).catch(() => undefined);
        const scale = sidecar?.scale ?? (device && device.source !== "generic" ? device.model.screen.scale : 2);
        const boxes = (await recognizeText(file)).filter((b) => !a.query || b.text.toLowerCase().includes(a.query.toLowerCase()));
        const rows = boxes.map(
          (b) =>
            `"${b.text}" px {x:${Math.round(b.x)}, y:${Math.round(b.y)}, width:${Math.round(b.width)}, height:${Math.round(b.height)}} ` +
            `pt {x:${Math.round(b.x / scale)}, y:${Math.round(b.y / scale)}, width:${Math.round(b.width / scale)}, height:${Math.round(b.height / scale)}}`,
        );
        return [text(`${size.width}×${size.height} px (@${scale}x). ${boxes.length} text line(s):\n${rows.join("\n")}`)];
      }),
  );

  server.registerTool(
    "create_mockup",
    {
      title: "Create a device mockup",
      description:
        "Compose screenshots into polished device frames on a styled canvas: choose device model and colour, position, scale, 2D/3D rotation, shadow, background (gradient, mesh, image, blurred screenshot), headline/subheadline with accent words, and extra text. Outputs a PNG at App Store size by default and returns a preview.",
      inputSchema: MockupInputShape,
    },
    (a) =>
      guard(async () => {
        const r = await createMockup(a);
        const content: Content = [text(r)];
        if (a.preview !== false) {
          const img = await image(r.path);
          if (img) content.push(img);
        }
        return content;
      }),
  );

  server.registerTool(
    "layout_mockup",
    {
      title: "Lay out a mockup without rendering",
      description:
        "Resolve a create_mockup request into its canvas and entities (every device, the caption, each extra text and each shape) with their positions and sizes as canvas fractions, without rendering. Fast. Use it to see where auto-layout put things, then move or resize an entity by setting that device's x/y/height/rotate (or textStyle.x/y for the caption, texts[i].x/y for extra text) in create_mockup.",
      inputSchema: MockupInputShape,
      annotations: { readOnlyHint: true },
    },
    (a) => guard(async () => [text(await layoutScene(a))]),
  );

  server.registerTool(
    "record_web",
    {
      title: "Record a flow on a web page",
      description:
        "Record clicks, typing and scrolling on a web page as a video. The flow is rehearsed first (a step that can't find its target fails with its name) and then recorded with a real pointer. Returns the video, a first-frame still and a cursor track: pass the still as the device's screenshot, the video as its video, and the cursor as create_video's video.cursor, then place zooms (video.zooms) where the clicks happen.",
      inputSchema: RecordWebShape,
    },
    (a) => guard(async () => [text(await recordWeb(a))]),
  );

  server.registerTool(
    "record_mac",
    {
      title: "Record a Mac app",
      description:
        "Record an app's window (or the whole display) for a number of seconds as a video, with a first-frame still. Do the flow while it runs. Put it in a MacBook or window frame with create_video.",
      inputSchema: RecordMacShape,
    },
    (a) => guard(async () => [text(await recordMac(a))]),
  );

  server.registerTool(
    "apply_recipe",
    {
      title: "Start from a recipe",
      description: `Build a complete, proven design from your screenshots: it picks the canvas, backdrop (from the app's own colours), composition, type and effects, and returns the create_mockup request (rendered too, unless render is false). A strong starting point to refine. Recipes: ${RECIPES.map((r) => `${r.id} (${r.description})`).join("; ")}`,
      inputSchema: {
        recipe: z.enum(RECIPES.map((r) => r.id) as [string, ...string[]]),
        screenshots: z.array(z.string()).min(1).max(8).describe("Screenshot paths, most important first."),
        headline: z.string().optional().describe("Your headline (**accent** words allowed). Without one, a placeholder is used."),
        subheadline: z.string().optional(),
        render: z.boolean().optional().describe("Also render it. Default true."),
      },
    },
    (a) =>
      guard(async () => {
        const request = await buildRecipe(a.recipe, a.screenshots.map((screenshot) => ({ screenshot })), { headline: a.headline, subheadline: a.subheadline });
        if (a.render === false) return [text({ request })];
        const r = await createMockup(request);
        const content: Content = [text({ request, path: r.path, width: r.width, height: r.height, warnings: r.warnings })];
        const img = await image(r.path, 1200);
        if (img) content.push(img);
        return content;
      }),
  );

  // Scenes live in the Studio's library: the folder of the Studio last opened on this Mac.
  useLibrary(studioFolder);

  /** A screen's name when it wasn't given one: its headline, else its number. */
  const screenTitle = (scene: unknown, i: number) => {
    const head = String((scene as { headline?: unknown })?.headline ?? "").replace(/\*\*/g, "").replace(/\s+/g, " ").trim();
    return head ? (head.length > 40 ? head.slice(0, 38).trim() + "…" : head) : `Screen ${i + 1}`;
  };

  /** A screen of a set: its design, its name, and as a shot of the video its length and way in. */
  const ScreenShape = z.object({
    scene: z.object(MockupInputShape),
    name: z.string().max(80).optional().describe("What the screen is called in the Studio and in exported file names, e.g. \"Introduction\"."),
    video: z.boolean().optional().describe("false leaves the screen out of the video: still one of the set's screenshots, it takes no time in the video."),
    length: z.number().min(0.5).max(60).optional(),
    transition: z.object({ type: z.enum(TRANSITIONS), duration: z.number().min(0).max(3).optional() }).optional(),
  });

  server.registerTool(
    "list_scenes",
    {
      title: "List the Studio's scenes",
      description:
        "The designs saved in the Studio (its Scenes page), most recently edited first: id, name, devices, canvas size, headline, how many screens and sizes a set has, and when each was last edited. Open one with get_scene.",
      inputSchema: {
        query: z.string().optional().describe("Only scenes whose name, headline or devices contain these words."),
      },
    },
    (a) =>
      guard(async () => {
        const q = a.query?.trim().toLowerCase();
        const scenes = listScenes()
          .filter((x) => !q || [x.name, x.headline, ...x.deviceNames].some((v) => v?.toLowerCase().includes(q)))
          .map((x) => ({ id: x.id, name: x.name, devices: x.deviceNames, size: x.size ? `${x.size.width}x${x.size.height}` : undefined, screens: x.shots, sizes: x.sizes, headline: x.headline, editedAt: x.updatedAt, lastEditedBy: x.by ?? "the person" }));
        return [text({ library: libraryFolder(), scenes })];
      }),
  );

  server.registerTool(
    "get_scene",
    {
      title: "Open a Studio scene",
      description:
        "A scene saved in the Studio, as a create_mockup request you can change and render, with a preview of how it looks. A set has its screens in store order (`shots`: the App Store screenshots, and the shots its preview video plays), and a set made at several sizes has every size (`sizes`: iPhone 6.9″, iPad 13″, Apple Watch…). Give its id (from list_scenes) or its name. To put your changes back in the Studio, use save_scene; export the whole set with export_scene_set.",
      inputSchema: {
        id: z.string().optional().describe("The scene's id."),
        name: z.string().optional().describe("The scene's name, or words from it, when you don't have the id."),
      },
    },
    (a) =>
      guard(async () => {
        const s = findScene(a);
        // A set: each screen's name, scene, and its length and way in as a shot of the video (the first is `request`).
        const shots = s.shots && s.shots.length > 1 ? firstScreens(s) : undefined;
        const sizes = s.groups && s.groups.length > 1 ? sceneSizes(s).map((z) => ({ size: z.label, screens: z.screens })) : undefined;
        const note = [
          shots && `A set of ${shots.length} screens, in store order: each is an App Store screenshot, and together they play as a video (render it with create_sequence, leaving out any screen with video: false). Save changes with save_scene's shots.`,
          sizes && `Made at ${sizes.length} sizes (${sizes.map((z) => z.size).join(", ")}); \`request\` and \`shots\` are the first. Change other sizes with save_scene's sizes, or leave them out to keep them.`,
        ].filter(Boolean).join(" ");
        const content: Content = [text({ id: s.id, name: s.name, editedAt: s.updatedAt, request: s.scene, shots, sizes, note: note || undefined })];
        const thumb = await sceneThumb(s.id);
        const img = thumb ? await image(thumb, 1200) : undefined;
        if (img) content.push(img);
        return content;
      }),
  );

  server.registerTool(
    "save_scene",
    {
      title: "Save a scene to the Studio",
      description:
        "Save a design into the Studio's Scenes, where the person can open it and keep editing: every device, caption, text, shape and call-out stays editable there. For a set of screens (App Store screenshots that also play in order as a video), pass `shots` (the first screen's scene is also `scene`). For a set made at several sizes, pass `sizes` instead (the first size's first screen is also `scene`). By default it is saved as a NEW scene and nothing existing changes. To change an existing scene in place, pass its `id` and `replace: true`, and only when the person asked you to change that scene: if they have it open, the change appears on their canvas (as one step they can undo). Files from outside the library are copied in. Render with create_mockup first and look at it; save what you'd be happy to hand over.",
      inputSchema: {
        scene: z.object(MockupInputShape).describe("The design: a create_mockup request (output and format settings are ignored)."),
        name: z.string().max(120).optional().describe("The scene's name. Default: the original's name (a copy is marked as the agent's), else \"Untitled scene\"."),
        id: z.string().optional().describe("The scene this is an edit of (from list_scenes or get_scene)."),
        replace: z.boolean().optional().describe("With `id`: overwrite that scene instead of saving a copy. Default false."),
        shots: z
          .array(
            ScreenShape,
          )
          .min(2)
          .max(20)
          .optional()
          .describe("A set's screens, in store order: each a scene, a name (\"Introduction\"), and as a shot of the video its length (seconds) and how it comes in (as create_sequence takes them). The first screen's scene is the design's `scene`. Leave out to keep the scene's screens as they are."),
        sizes: z
          .array(z.object({ screens: z.array(ScreenShape).min(1).max(20).describe("This size's screens in store order; set each scene's `canvas` to the size (\"ipad-13\", \"watch-ultra-3\"…).") }))
          .min(2)
          .max(12)
          .optional()
          .describe("A set made at several sizes (iPhone, iPad, Apple Watch…), each with its screens. Replaces `shots`: the first size's screens are the design's. Leave out to keep the scene's other sizes as they are."),
      },
    },
    (a) =>
      guard(async () => {
        if (a.replace && !a.id) throw new Error("`replace` needs the `id` of the scene to replace.");
        if (a.sizes && a.shots) throw new Error("Pass `sizes` or `shots`, not both: with sizes, the first size's screens are the shots.");
        // Several sizes: the first size's screens are the design's own; every scene is checked and its files brought in.
        if (a.sizes) {
          const [head, ...rest] = a.sizes[0].screens;
          a = { ...a, scene: head.scene, shots: a.sizes[0].screens.length > 1 ? [head, ...rest] : undefined };
        }
        const original = a.id ? getScene(a.id) : undefined;
        // Rendering settings belong to an export, not to the design.
        const { output: _o, preview: _p, quality: _q, format: _f, jpegQuality: _j, deliveryWidth: _d, ...design } = a.scene;
        const first = a.shots ? a.shots[0].scene : design;
        const { output: _o2, preview: _p2, quality: _q2, format: _f2, jpegQuality: _j2, deliveryWidth: _d2, ...firstDesign } = first as typeof a.scene;
        const adopted = adoptFiles(a.shots ? firstDesign : design);
        // Laying it out checks every file and target before anything is written.
        const layout = await layoutScene(adopted.scene as Parameters<typeof layoutScene>[0]);
        const shots = a.shots
          ? await Promise.all(
              a.shots.map(async (x, i) => {
                if (i === 0) return { name: x.name, video: x.video, length: x.length, transition: x.transition };
                return { ...(await checked(x.scene)), name: x.name, video: x.video, length: x.length, transition: x.transition };
              }),
            )
          : undefined;
        // The other sizes, each screen checked and its files brought in.
        const otherSizes = a.sizes
          ? await Promise.all(a.sizes.slice(1).map(async (z) => ({ shots: await Promise.all(z.screens.map(async (x) => ({ ...(await checked(x.scene)), name: x.name, video: x.video, length: x.length, transition: x.transition }))) })))
          : undefined;
        async function checked(scene: typeof a.scene) {
          const { output: _o3, preview: _p3, quality: _q3, format: _f3, jpegQuality: _j3, deliveryWidth: _d3, ...rest } = scene;
          const own = adoptFiles(rest);
          adopted.copied.push(...own.copied);
          await layoutScene(own.scene as Parameters<typeof layoutScene>[0]);
          return { scene: own.scene };
        }
        // Sizes: as sent; else a copy keeps the original's, its first size now this design.
        type Shots = Parameters<typeof firstScreens>[0]["shots"];
        const groups: SavedGroup[] | undefined = otherSizes
          ? [{ shots: firstScreens({ scene: adopted.scene as MockupInput, shots: shots as Shots }) }, ...otherSizes]
          : !a.replace && original?.groups
            ? withFirstSize(original.groups, adopted.scene, (shots ?? original.shots) as Shots)
            : undefined;
        const saved = saveScene({
          id: a.replace ? a.id : undefined,
          name: a.name ?? (original ? (a.replace ? original.name : `${original.name} (agent's version)`) : undefined),
          scene: adopted.scene,
          chat: a.replace ? undefined : original?.chat,
          // A copy keeps the original's shots unless new ones are given.
          shots: shots ?? (!a.replace ? original?.shots : undefined),
          groups,
          by: "agent",
        });
        const content: Content = [
          text({
            saved: { id: saved.id, name: saved.name, replaced: Boolean(a.replace), editedAt: saved.updatedAt },
            library: libraryFolder(),
            copiedIntoLibrary: adopted.copied.length ? adopted.copied : undefined,
            warnings: layout.warnings.length ? layout.warnings : undefined,
            next: a.replace ? "If the person has this scene open in the Studio, it updates there within a few seconds." : "It's in the Studio under Scenes.",
          }),
        ];
        const thumb = await sceneThumb(saved.id);
        const img = thumb ? await image(thumb, 1200) : undefined;
        if (img) content.push(img);
        return content;
      }),
  );

  server.registerTool(
    "export_scene_set",
    {
      title: "Export a Studio scene's whole set",
      description:
        "Export every screen of every size of a scene saved in the Studio, at full size, numbered in store order, with a contact sheet per size to look at. Folders go by size (<language>/<size>/01 Introduction.png) or are ready for `fastlane deliver` (screenshots/<language>/<size> - 01 Introduction.png). Give the scene's id (from list_scenes) or its name.",
      inputSchema: {
        id: z.string().optional().describe("The scene's id."),
        name: z.string().optional().describe("The scene's name, or words from it, when you don't have the id."),
        folders: z.enum(["size", "fastlane"]).optional().describe("\"size\" (default): a folder per size. \"fastlane\": one folder per language, files prefixed by size, for fastlane deliver."),
        language: z.string().max(12).optional().describe("The language folder, as App Store Connect names it. Default \"en-US\"."),
        format: z.enum(["png", "jpeg"]).optional().describe("Default png."),
        output: z.string().optional().describe("Folder to export into. Default: ./screenshots/sets/<scene>-<timestamp>/."),
      },
    },
    (a) =>
      guard(async () => {
        const s = findScene(a);
        const sizes = sceneSizes(s).map((z) => ({ label: z.label, screens: z.screens.map((x, i) => ({ scene: x.scene as MockupInput, name: x.name ?? screenTitle(x.scene, i) })) }));
        const r = await exportSet({ name: s.name, sizes, folders: a.folders, language: a.language, format: a.format, output: a.output });
        const content: Content = [
          text({
            directory: r.directory,
            screenshots: a.folders === "fastlane" ? r.screenshots : undefined,
            sizes: r.sizes.map((z) => ({ size: z.label, files: z.files.map((f) => f.path), width: z.files[0]?.width, height: z.files[0]?.height, contactSheet: z.contactSheet })),
            next: a.folders === "fastlane" ? `Upload with \`fastlane deliver --screenshots_path "${r.screenshots}"\`.` : undefined,
          }),
        ];
        for (const z of r.sizes.slice(0, 4)) {
          const img = z.contactSheet ? await image(z.contactSheet, 1600) : undefined;
          if (img) content.push(img);
        }
        return content;
      }),
  );

  server.registerTool(
    "design_guide",
    {
      title: "How to design great screenshots",
      description:
        "The art direction guide for App Store screenshots, mockups, how-to and launch images: composition with real numbers, headline copy, font pairings, colour from the app's palette, which backdrop, finish, effect and callout to use when, sets, a quality checklist, and how to turn vague requests into settings. Read it once before designing.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    () => guard(async () => [text(DESIGN_GUIDE)]),
  );

  server.registerTool(
    "get_house_style",
    {
      title: "Get the house style",
      description: "What this person likes, remembered between sessions: colours, devices, fonts, backdrops, layouts and things to avoid. Read it before designing and follow it unless asked otherwise.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    () => guard(async () => [text({ notes: houseStyle() })]),
  );

  server.registerTool(
    "remember_style",
    {
      title: "Remember a style preference",
      description:
        "Save what the person likes or dislikes so every future design follows it, e.g. \"Always Space Black devices\", \"Loves film grain on backdrops\", \"No rotated phones\". One short, specific note per preference. Remove notes they no longer want by id.",
      inputSchema: {
        add: z.array(z.string().max(240)).optional().describe("Notes to remember."),
        remove: z.array(z.string()).optional().describe("Ids of notes to forget (from get_house_style)."),
      },
    },
    (a) => guard(async () => [text({ notes: updateHouseStyle(a) })]),
  );

  server.registerTool(
    "crop_image",
    {
      title: "Crop or zoom into an image",
      description:
        "Crop any image (a mockup, screenshot or crop) to a region, or zoom into a point, optionally enlarging the result. For detail shots, social crops, and for checking small details of a render (text edges, a callout, a bezel) before calling it done. Returns the path, the region as fractions and a preview.",
      inputSchema: CropInputShape,
    },
    (a) =>
      guard(async () => {
        const r = await cropImage(a);
        const content: Content = [text(r)];
        if (a.preview !== false) {
          const img = await image(r.path, 1400);
          if (img) content.push(img);
        }
        return content;
      }),
  );

  server.registerTool(
    "create_grid",
    {
      title: "Lay images out in a grid",
      description:
        "Arrange images in a grid: a contact sheet (every image whole, rows scaled to the full width), or a mosaic of equal cells. For comparing variants side by side, presenting an App Store set, a feature wall of screens, or a before/after pair. Any backdrop, labels under each image.",
      inputSchema: GridInputShape,
    },
    (a) =>
      guard(async () => {
        const r = await createGrid(a);
        const content: Content = [text(r)];
        if (a.preview !== false) {
          const img = await image(r.path, 1600);
          if (img) content.push(img);
        }
        return content;
      }),
  );

  server.registerTool(
    "create_mockup_set",
    {
      title: "Create a set of mockups",
      description:
        "Render a consistent series of mockups (e.g. a full App Store screenshot set): shared canvas, background, text style and device settings, with a headline and screenshot per screen. Returns all paths and a contact sheet preview.",
      inputSchema: MockupSetShape,
    },
    (a) =>
      guard(async () => {
        const r = await createMockupSet(a);
        const content: Content = [
          text({
            directory: r.directory,
            files: r.files.map((f) => f.path),
            contactSheet: r.contactSheet,
            warnings: [...new Set(r.files.flatMap((f) => f.warnings))],
          }),
        ];
        if (a.preview !== false) {
          const img = await image(r.contactSheet, 1600);
          if (img) content.push(img);
        }
        return content;
      }),
  );

  server.registerTool(
    "record_simulator",
    {
      title: "Record the simulator screen",
      description:
        "Record a video of the simulator screen (same setup options as capture_screenshot), optionally opening deep links on a timeline while recording. Returns the .mp4 and a poster PNG; pass both to create_video (devices[].screenshot = poster, devices[].video = mp4) to play the recording inside a device frame.",
      inputSchema: {
        ...CaptureShape,
        duration: z.number().min(1).max(120).optional().describe("Seconds to record. Default 8."),
        timeline: z
          .array(z.object({ at: z.number(), url: z.string().optional(), launch: z.string().optional(), appearance: z.enum(["light", "dark"]).optional() }))
          .optional()
          .describe("Actions during the take, at seconds from the start: open a deep link, launch an app, switch appearance."),
      },
    },
    (a) =>
      guard(async () => {
        const r = await recordSimulator(a);
        const content: Content = [text(r)];
        if (a.preview !== false) {
          const img = await image(r.poster, 700);
          if (img) content.push(img);
        }
        return content;
      }),
  );

  server.registerTool(
    "preview_video",
    {
      title: "Preview a video's key moments",
      description:
        "Frames of a video as one image, each labelled with its time, without rendering the video (about a second). Ask for exact moments (`times`, to the millisecond), one every so many seconds (`every`), or by default the key moments: the start, just after each animation ends, the middle of long ones, and the settled end. Takes the same input as create_video. Use it to check an animation's timing and framing (is anything alone on an empty frame, cut off, or late? what exactly is on screen at 2.35 s?) before rendering. Up to 16 frames.",
      inputSchema: {
        ...VideoInputShape,
        times: z.array(z.number().min(0)).min(1).max(16).optional().describe("Exact moments to see, in seconds (to the millisecond: 1.25, 3.5). Instead of the key moments."),
        every: z.number().min(0.05).max(10).optional().describe("A frame every this many seconds (1 = each second), from the start. Instead of the key moments."),
        moments: z.number().int().min(2).max(16).optional().describe("With neither: how many key moments at most. Default 8."),
      },
    },
    ({ moments, times, every, ...a }) =>
      guard(async () => {
        const r = await storyboard(a, { max: moments, times, every });
        const img = await image(r.path, 1800);
        return [text({ times: r.times, duration: r.duration, warnings: r.warnings }), ...(img ? [img] : [])];
      }),
  );

  server.registerTool(
    "preview_sequence",
    {
      title: "Preview a video of several shots",
      description:
        "Frames of a several-shot video (create_sequence's input) as one image, without rendering it: a second or two a shot. By default each shot's key moments; or exact times across the whole video (`times`), or one `every` so many seconds. Each frame is labelled with its time and shot, and the result says when each shot starts. During a transition it shows the shot mostly on screen. Up to 16 frames.",
      inputSchema: {
        ...SequenceInputShape,
        times: z.array(z.number().min(0)).min(1).max(16).optional().describe("Exact moments across the whole video, in seconds."),
        every: z.number().min(0.1).max(10).optional().describe("A frame every this many seconds, from the start."),
        moments: z.number().int().min(2).max(16).optional().describe("With neither: how many frames at most. Default 12."),
      },
    },
    ({ moments, times, every, ...a }) =>
      guard(async () => {
        const r = await sequenceStoryboard(a, { max: moments, times, every });
        const img = await image(r.path, 1800);
        return [text({ times: r.times, duration: r.duration, shots: r.shots, warnings: r.warnings }), ...(img ? [img] : [])];
      }),
  );

  server.registerTool(
    "create_sequence",
    {
      title: "Create a video of several shots",
      description:
        "Several scenes (shots) one after another as one video, joined by transitions: cut, fade (a crossfade), fade-black, fade-white, push-left/right/up/down, wipe-left/right, iris, zoom, blur, dissolve. Each shot is a scene as create_video takes it (with its own animations and video options), plus `length` (seconds on screen, transitions included) and `transition` (how it comes in). `size` is the video's size: a preset (app-store-iphone 886×1920, app-store-ipad 1200×1600, app-store-mac 1920×1080, vertical, portrait, square, widescreen) or WIDTHxHEIGHT; default the first shot's canvas. A shot of another shape is fitted (whole, its backdrop filling the rest), filled or laid out again (`fit`). App Store sizes follow Apple's app preview rules: 15 to 30 s (a short one holds its last shot), 30 fps, H.264, a silent stereo track. `versions` also makes it at other sizes. Returns the file, when each shot starts, and a filmstrip of each shot and transition. Check the timing with preview_sequence first.",
      inputSchema: SequenceInputShape,
    },
    (a) =>
      guard(async () => {
        const r = await createSequence(a);
        const content: Content = [text(r)];
        if (a.preview !== false && r.filmstrip) {
          const img = await image(r.filmstrip, 1800);
          if (img) content.push(img);
        }
        return content;
      }),
  );

  server.registerTool(
    "create_video",
    {
      title: "Create an animated mockup video",
      description:
        "Render the same scene as create_mockup as a video (mp4/mov/webm/gif). `animations` choreograph it: when each item (device, headline, text, shape) enters, changes and leaves, with a transition and an easing; several items can move as one group, and shapes can change colour, size, and an arrow's ends and curve. Anything can blur or come into focus, travel along a curve, and loop (repeat, back and forth) for the whole video; the backdrop moves on its own (a slow push, drift, colour shift). Plus ambient motion (subtle, float, drift, push-in), camera zooms onto a point or highlight, a drawn cursor, animated grain, and screen recordings playing inside device frames. `versions` also makes it at other sizes (App Store preview sizes that follow Apple's rules, vertical, square, 4:5, widescreen). Returns the file plus a filmstrip preview. For several scenes in one video, use create_sequence.",
      inputSchema: VideoInputShape,
    },
    (a) =>
      guard(async () => {
        const r = await createVideo(a);
        const content: Content = [text(r)];
        if (a.preview !== false) {
          const img = await image(r.filmstrip, 1800);
          if (img) content.push(img);
        }
        return content;
      }),
  );

  server.registerTool(
    "list_mockup_options",
    {
      title: "List mockup options",
      description: "The devices available to create_mockup (those with Apple's product art installed, with their finishes and Apple Watch bands), canvas presets, layouts, background types and fonts.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    () =>
      guard(async () => {
        // Devices are shown with Apple's own art only: these are the ones installed, in the finishes
        // (and, for Apple Watch, the bands) Apple drew.
        const art = bezelSummary();
        const catalog = art.models.map(
          (m) => `- ${m.name} [${m.family}]: ${m.colors.join(", ")}${m.bands ? `\n    bands: ${Object.entries(m.bands).map(([c, b]) => `${c}: ${b.join(", ")}`).join("; ")}` : ""}`,
        );
        const presets = Object.entries(CANVAS_PRESETS).map(([k, v]) => `- ${k}: ${v.width}×${v.height} — ${v.label}`);
        return [
          text(
            [
              catalog.length
                ? "DEVICES (Apple's product art is installed for these; `color` picks a finish, `band` an Apple Watch band):"
                : "DEVICES: none yet. Devices are shown with Apple's product art, which the person gets in the Studio (Settings › Device art); until then a device is shown as its bare screen.",
              ...catalog,
              catalog.length ? "Another model is shown as an installed one of its family whose screen fits the screenshot (or as its bare screen), with a warning." : "",
              catalog.length ? `CLAY (\`clay\` on a device: its Apple art in one matte colour): true (porcelain), ${Object.entries(CLAY_TONES).map(([n, h]) => `${n} ${h}`).join(", ")}, or any colour.` : "",
              "SCREEN ONLY (UI-only): frame \"card\", the screen alone with the device's own corners.",
              "\nCANVAS PRESETS (or \"WIDTHxHEIGHT\" / {width,height}; landscape:true swaps):",
              ...presets,
              `\nLAYOUTS: ${LAYOUTS.join(", ")}`,
              "\nLOOKS (background: \"<name>\" or {look, ...overrides}):",
              ...LOOKS.map((l) => `- ${l.name} [${l.tone}${l.background.photo ? ", photo" : ""}]: ${l.description}`),
              "\nBACKGROUNDS: a look; a CSS colour/gradient string; {colors, angle} gradient; {type:\"radial\"}; {type:\"mesh\", colors, meshStyle: field|orbs|aurora|corner|diagonal, seed}; {photo: path|URL|\"unsplash:<id>\"}; {unsplash: \"search words\", seed}; {generate: \"prompt\"} (AI); {type:\"blur\"} (blurred screenshot); {type:\"transparent\"}. Photo treatment: blur, motionBlur, motionAngle, brightness, contrast, saturation, tint+tintAmount, haze+hazeColor, bloom, halation, dim, zoom, focusX/Y.",
              `AI BACKGROUNDS: ${[process.env.OPENAI_API_KEY && "openai", (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || process.env.GOOGLE_GENERATIVE_AI_API_KEY) && "gemini", process.env.REPLICATE_API_TOKEN && "replicate", process.env.FAL_KEY && "fal"].filter(Boolean).join(", ") || "no provider key set (OPENAI_API_KEY, GEMINI_API_KEY, REPLICATE_API_TOKEN or FAL_KEY)"}`,
              `\nEFFECTS: grain, vignette, edgeBlur, grade (${GRADES.join(", ")}; or {preset, exposure, temperature, tint, contrast, saturation, fade}).`,
              "SHADOWS: none, soft, medium (default), strong, studio, or {style, opacity, blur, offsetY, color:\"auto\"}.",
              "HIGHLIGHTS (per device): lift, loupe, outline, spotlight, blur-rest — target {text:\"Add a task\"} or {rect, unit}.",
              "FRAMES: device, browser (url), window (title), card (the screen only, with the device's corners), none. chrome: light|dark.",
              "IMAGES (scene `images`): {src, x, y, height, rotate, radius, mask: icon|circle, shadow, sticker, opacity, blur, flip, z}. Ids image-1, image-2… for animations.",
              `STICKERS (src "sticker:<name>", with sticker: true): ${stickerNames().join(", ")}.`,
              "BADGES (shapes, your words in `text`, coloured by fill and labelColor): burst (a starburst, \"NEW\"), ribbon (\"Try it free\"), bubble (a speech bubble), tag (a price tag, \"FREE\").",
              "AWARDS AND RATINGS (shapes): {type:\"laurel\", text, caption, fill} and {type:\"rating\", value, text, fill}. Only claim what's true.",
              "\nFONTS: sf-pro (default), sf-rounded, new-york, sf-mono, any installed font, or any Google Fonts family (fetched automatically). Local files via `fonts`.",
              "\nTEXT MARKUP: **word** uses accentColor (a colour or a CSS gradient). \\n breaks lines.",
              "TEXT EMPHASIS (textStyle and texts): accentMark (highlight, underline, pill) + accentMarkColor; decoration (underline, strike, highlight) + decorationColor; stroke + strokeWidth (outline); lineHeight; a text's pill: background, padding, radius.",
              "ANIMATING THEM: images move, scale, turn, fade and blur like devices; to/from { mark } draws marks in (0–1); { value } fills a rating's stars; { color } changes a clay device's colour.",
              `\nOUTPUT FOLDER: ${outputRoot()}`,
            ].join("\n"),
          ),
        ];
      }),
  );

  return server;
}
