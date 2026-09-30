/**
 * House style: what the person likes, remembered between sessions ("always Space Black phones",
 * "loves film grain", "no rotated devices"). Short notes, shared by the Studio's Ask AI and any
 * agent using the MCP server, which read them before designing and add to them when the person
 * states a preference.
 */
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export interface StyleNote {
  id: string;
  text: string;
  at: string;
}

export function styleFile(): string {
  return process.env.SCREENSHOTTER_STYLE_FILE || path.join(os.homedir(), "Library", "Application Support", "Screenshotter", "house-style.json");
}

export function houseStyle(): StyleNote[] {
  try {
    const file = styleFile();
    if (!existsSync(file)) return [];
    const data = JSON.parse(readFileSync(file, "utf8")) as { notes?: StyleNote[] };
    return Array.isArray(data.notes) ? data.notes.filter((n) => n && typeof n.text === "string") : [];
  } catch {
    return [];
  }
}

function save(notes: StyleNote[]) {
  const file = styleFile();
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify({ notes }, null, 2));
  renameSync(tmp, file);
}

const same = (a: string, b: string) => a.trim().toLowerCase().replace(/[.!\s]+$/, "") === b.trim().toLowerCase().replace(/[.!\s]+$/, "");

/** Add notes (skipping ones already there) and remove notes by id. Returns the notes after. */
export function updateHouseStyle(change: { add?: string[]; remove?: string[] }): StyleNote[] {
  let notes = houseStyle();
  if (change.remove?.length) notes = notes.filter((n) => !change.remove!.includes(n.id));
  for (const raw of change.add ?? []) {
    const text = raw.trim().slice(0, 240);
    if (!text || notes.some((n) => same(n.text, text))) continue;
    notes.push({ id: randomBytes(4).toString("hex"), text, at: new Date().toISOString() });
  }
  save(notes.slice(-60));
  return notes.slice(-60);
}
