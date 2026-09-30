/**
 * What's new: the changelog (CHANGELOG.md) as release notes, and which of them this person hasn't
 * seen yet, so the Studio can show them once after an update.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { marked } from "marked";
import { outputRoot } from "../util/files.js";

export interface Release {
  version: string;
  date: string;
  sections: Array<{ title: string; items: string[] }>;
}

/** Releases from a changelog: "## 0.2.0 · date", "### Section", "- item" (items as HTML). */
export function parseChangelog(md: string): Release[] {
  const releases: Release[] = [];
  let release: Release | undefined;
  let section: Release["sections"][number] | undefined;
  for (const line of md.split("\n")) {
    const h2 = /^##\s+(\d+\.\d+\.\d+)\s*(?:[·—-]\s*(.*))?$/.exec(line.trim());
    if (h2) {
      release = { version: h2[1], date: (h2[2] ?? "").trim(), sections: [] };
      releases.push(release);
      section = undefined;
      continue;
    }
    const h3 = /^###\s+(.*)$/.exec(line.trim());
    if (h3 && release) {
      section = { title: h3[1].trim(), items: [] };
      release.sections.push(section);
      continue;
    }
    const item = /^[-*]\s+(.*)$/.exec(line.trim());
    if (item && release) {
      if (!section) {
        section = { title: "", items: [] };
        release.sections.push(section);
      }
      section.items.push(marked.parseInline(item[1]) as string);
    }
  }
  return releases;
}

/** -1, 0 or 1, comparing dotted version numbers. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

const seenFile = () => process.env.SCREENSHOTTER_SEEN_FILE || path.join(os.homedir(), "Library", "Application Support", "Screenshotter", "whats-new.json");

function seenVersion(): string | undefined {
  try {
    return (JSON.parse(readFileSync(seenFile(), "utf8")) as { seen?: string }).seen;
  } catch {
    return undefined;
  }
}

export function markSeen(version: string) {
  const file = seenFile();
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ seen: version }, null, 2));
}

/**
 * The releases and the ones not seen yet. Someone who has never opened What's new but has used the
 * Studio before (it saved its state) is updating from before the changelog, so they see this
 * release; a first-time user starts fresh.
 */
export function whatsNew(changelogFile: string, version: string): { version: string; releases: Release[]; unseen: Release[] } {
  const releases = existsSync(changelogFile) ? parseChangelog(readFileSync(changelogFile, "utf8")) : [];
  let seen = seenVersion();
  if (!seen) {
    const usedBefore = existsSync(path.join(outputRoot(), ".studio", "state.json"));
    if (!usedBefore) {
      markSeen(version);
      seen = version;
    } else {
      // Updating from before the changelog: show this release only (releases are newest first).
      seen = releases.find((r) => compareVersions(r.version, version) < 0)?.version ?? "0.0.0";
    }
  }
  const unseen = releases.filter((r) => compareVersions(r.version, seen!) > 0 && compareVersions(r.version, version) <= 0);
  return { version, releases, unseen };
}
