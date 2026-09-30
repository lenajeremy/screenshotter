/**
 * Where the Studio keeps its library. The Studio notes its output folder each time it starts, so
 * the MCP server (a separate process, often with its own output folder) can list, open and save
 * scenes in the same place the person sees them.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { outputRoot } from "./files.js";

const noteFile = () => process.env.SCREENSHOTTER_STUDIO_FILE || path.join(os.homedir(), "Library", "Application Support", "Screenshotter", "studio.json");

/** Called by the Studio when it starts. */
export function noteStudioFolder(folder: string) {
  try {
    const file = noteFile();
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ folder: path.resolve(folder), at: new Date().toISOString() }, null, 2));
  } catch {
    // Not being able to leave the note only means agents use their own output folder.
  }
}

/** The folder of the Studio last opened on this Mac, else this process's own output folder. */
export function studioFolder(): string {
  try {
    const { folder } = JSON.parse(readFileSync(noteFile(), "utf8")) as { folder?: string };
    if (folder && existsSync(folder)) return folder;
  } catch {
    // No Studio has run yet.
  }
  return outputRoot();
}
