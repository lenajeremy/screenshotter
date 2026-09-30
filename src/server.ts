import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { DEVICE_MODELS, GENERIC_COLORS, findModel } from "./devices/catalog.js";
import { captureScreenshot } from "./simulator/capture.js";
import * as sim from "./simulator/simctl.js";
import { CANVAS_PRESETS } from "./render/layouts.js";
import { createMockup, layoutScene } from "./render/mockup.js";
import { LAYOUTS, MockupInputShape } from "./render/schema.js";
import { createMockupSet, MockupSetShape } from "./render/set.js";
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
import { createVideo, VideoInputShape } from "./render/video.js";
import { previewBase64 } from "./util/image.js";

const VERSION = "0.1.0";

const INSTRUCTIONS = `Screenshotter captures real app screens and turns them into marketing-ready device mockups and App Store sets.

Capture:
- iOS/iPadOS/watchOS apps: list_simulators / list_apps, then capture_screenshot (bundleId, deep link \`url\` or \`launchArgs\` to reach a screen). Status bar is set to 9:41 / full battery; the capture waits until the screen stops animating.
- Websites: capture_web (iPhone/iPad in real Mobile Safari on the simulator, or desktop in headless Chrome).
- Mac apps: capture_mac (a window by app name, or the whole screen).

Compose with create_mockup (or create_mockup_set for a whole series):
- Frames: device hardware (iPhone, iPad, Apple Watch, MacBook; any colour), browser, window, card or none. Several devices make a composition (e.g. MacBook + iPhone).
- Backgrounds: named looks (e.g. "meadow-motion", "clouds", "midnight"), gradients/mesh, any photo, Unsplash (\`unsplash\` search or "unsplash:<id>"), or AI-generated (\`generate\` prompt) with photo treatment: motion blur, blur, haze, tint, bloom, halation.
- Effects: film grain, vignette, edge blur, colour grade. Shadows: soft/medium/strong/studio.
- Highlights call out UI: lift a row, loupe magnifier, outline, spotlight, blur-rest. Target by visible text (on-device OCR) or a rect; find_text lists the text boxes.
- Caption: headline/subheadline with **accent** words, top/bottom/left/right.
- Video: create_video renders the same scene with motion (float, drift, push-in), a zoom onto a highlight and timed reveals; record_simulator captures a screen recording to play inside the frame.

Always look at the returned preview and iterate (positions, sizes, rotation, copy). The scene is a set of entities (devices, caption, texts); every result lists them with their resolved positions, and layout_mockup returns them without rendering. Move an entity by setting its properties: devices[i].x/y (centre)/height/rotate, textStyle.x/y for the caption, texts[i].x/y. Positions and sizes are fractions of the canvas (x 0 = left, 1 = right). Each output has a .mockup.json with the exact request for re-rendering.
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
        hide: z.array(z.string()).optional().describe("CSS selectors to hide (cookie banners, chat widgets)."),
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
        "Resolve a create_mockup request into its canvas and entities (every device, the caption and each extra text) with their positions and sizes as canvas fractions, without rendering. Fast. Use it to see where auto-layout put things, then move or resize an entity by setting that device's x/y/height/rotate (or textStyle.x/y for the caption, texts[i].x/y for extra text) in create_mockup.",
      inputSchema: MockupInputShape,
      annotations: { readOnlyHint: true },
    },
    (a) => guard(async () => [text(await layoutScene(a))]),
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
    "create_video",
    {
      title: "Create an animated mockup video",
      description:
        "Render the same scene as create_mockup as a video (mp4/mov/webm/gif) with ambient motion (subtle, float, drift, push-in), a camera zoom onto a point or highlight, timed highlight and caption reveals, animated grain, and optional screen recordings playing inside device frames. Returns the file plus a filmstrip preview.",
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
      description: "Device frames and colours, canvas presets, layouts, background types and fonts available to create_mockup.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    () =>
      guard(async () => {
        const catalog = DEVICE_MODELS.map((m) => `- ${m.name} [${m.family}]: ${m.colors.map((c) => `${c.name} ${c.hex}`).join(", ")}`);
        let extra: string[] = [];
        try {
          extra = (await sim.listDeviceTypes())
            .filter((t) => ["iPhone", "iPad", "Apple Watch"].includes(t.productFamily) && !findModel(t.name))
            .map((t) => t.name);
        } catch {
          // Xcode not available
        }
        const presets = Object.entries(CANVAS_PRESETS).map(([k, v]) => `- ${k}: ${v.width}×${v.height} — ${v.label}`);
        return [
          text(
            [
              "DEVICE FRAMES (with catalog colours):",
              ...catalog,
              extra.length
                ? `\nAlso drawable from Xcode's device profiles (exact geometry, generic colours ${GENERIC_COLORS.map((c) => c.name).join("/")} or any hex):\n${extra.join(", ")}`
                : "",
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
              "FRAMES: device, browser (url), window (title), card, none. chrome: light|dark.",
              "\nFONTS: sf-pro (default), sf-rounded, new-york, sf-mono, any installed font, or any Google Fonts family (fetched automatically). Local files via `fonts`.",
              "\nTEXT MARKUP: **word** uses accentColor (a colour or a CSS gradient). \\n breaks lines.",
              `\nOUTPUT FOLDER: ${outputRoot()}`,
            ].join("\n"),
          ),
        ];
      }),
  );

  return server;
}
