import { writeFileSync } from "node:fs";
import { run, sleep } from "../util/exec.js";
import { outputPathFor } from "../util/files.js";
import { imageSize } from "../util/image.js";

export interface MacWindow {
  id: number;
  app: string;
  title: string;
  width: number;
  height: number;
}

const LIST_WINDOWS = `
ObjC.import('CoreGraphics');
ObjC.import('Foundation');
const raw = $.CGWindowListCopyWindowInfo($.kCGWindowListOptionOnScreenOnly | $.kCGWindowListExcludeDesktopElements, $.kCGNullWindowID);
const list = ObjC.deepUnwrap(ObjC.castRefToObject(raw)) || [];
JSON.stringify(list.filter(w => w.kCGWindowLayer === 0 && w.kCGWindowBounds.Height > 60).map(w => ({
  id: w.kCGWindowNumber, app: w.kCGWindowOwnerName || '', title: w.kCGWindowName || '',
  width: w.kCGWindowBounds.Width, height: w.kCGWindowBounds.Height })));
`;

export async function listMacWindows(): Promise<MacWindow[]> {
  const { stdout } = await run("osascript", ["-l", "JavaScript", "-e", LIST_WINDOWS]);
  return JSON.parse(stdout.trim() || "[]");
}

export interface MacCaptureOptions {
  /** App name (e.g. "Xcode", "Safari") to capture its frontmost window. Omit for the whole screen. */
  app?: string;
  windowId?: number;
  /** Include the native window shadow. Default false (mockups add their own). */
  shadow?: boolean;
  /** Bring the app to the front first. Default true. */
  activate?: boolean;
  display?: number;
  output?: string;
}

const PERMISSION_HINT =
  "macOS blocked the capture. Grant Screen Recording to the app running this MCP server (System Settings › Privacy & Security › Screen & System Audio Recording), then retry.";

export async function captureMac(opts: MacCaptureOptions): Promise<{ path: string; width: number; height: number; window?: MacWindow }> {
  let win: MacWindow | undefined;
  if (opts.app || opts.windowId) {
    if (opts.app && opts.activate !== false) {
      await run("osascript", ["-e", `tell application "${opts.app.replace(/"/g, "")}" to activate`]).catch(() => undefined);
      await sleep(600);
    }
    const windows = await listMacWindows();
    win = opts.windowId
      ? windows.find((w) => w.id === opts.windowId)
      : windows
          .filter((w) => w.app.toLowerCase() === opts.app!.toLowerCase())
          .sort((a, b) => b.width * b.height - a.width * a.height)[0];
    if (!win) {
      const apps = [...new Set(windows.map((w) => w.app))].join(", ");
      throw new Error(`No on-screen window for ${opts.app ?? `id ${opts.windowId}`}. Windows are open for: ${apps}`);
    }
  }
  const out = outputPathFor(opts.output, "raw", win ? `mac-${win.app}` : "mac-screen", "png");
  const args = ["-x", "-t", "png"];
  if (win) {
    args.push("-l", String(win.id));
    if (!opts.shadow) args.push("-o");
  } else if (opts.display) {
    args.push("-D", String(opts.display));
  }
  args.push(out);
  try {
    await run("screencapture", args);
  } catch (e) {
    throw new Error(`${(e as Error).message}\n${PERMISSION_HINT}`);
  }
  const size = await imageSize(out);
  writeFileSync(
    `${out}.json`,
    JSON.stringify({ kind: "mac", app: win?.app, scale: 2, width: size.width, height: size.height, capturedAt: new Date().toISOString() }, null, 2),
  );
  return { path: out, ...size, window: win };
}
