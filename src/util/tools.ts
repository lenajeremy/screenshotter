// The programs Screenshotter.app carries (ffmpeg, in Contents/Helpers). When this engine is the
// one inside the app, they come first on its PATH, so every `spawn("ffmpeg")` uses them rather
// than whatever is installed, or nothing.

import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** The app's Contents/Helpers folder, when this engine is the one inside the app and it has ffmpeg. */
export function appHelpers(): string | undefined {
  const engine = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
  const resources = path.dirname(engine);
  const contents = path.dirname(resources);
  if (path.basename(engine) !== "engine" || path.basename(resources) !== "Resources" || path.basename(contents) !== "Contents") return undefined;
  const helpers = path.join(contents, "Helpers");
  return existsSync(path.join(helpers, "ffmpeg")) ? helpers : undefined;
}

/** Put the app's programs first on the PATH (once, at start). */
export function useAppHelpers(): void {
  const dir = appHelpers();
  if (!dir) return;
  process.env.PATH = [dir, ...(process.env.PATH ?? "").split(":").filter((d) => d && d !== dir)].join(":");
}
