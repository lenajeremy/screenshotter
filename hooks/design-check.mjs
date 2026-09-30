#!/usr/bin/env node
/**
 * Claude Code hook (PostToolUse on Screenshotter's render tools). The first time an agent renders
 * in a session, it gets a short design checklist, the person's house style and how to check its
 * work (crop into details, compare variants in a grid). Later renders in the session add nothing.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

let input = "";
process.stdin.on("data", (d) => (input += d));
process.stdin.on("end", () => {
  let event = {};
  try {
    event = JSON.parse(input || "{}");
  } catch {
    process.exit(0);
  }
  const session = String(event.session_id ?? "default").replace(/[^a-zA-Z0-9_-]/g, "");
  const dir = path.join(os.tmpdir(), "screenshotter-hooks");
  const marker = path.join(dir, `${session}.checked`);
  if (existsSync(marker)) process.exit(0);
  mkdirSync(dir, { recursive: true });
  writeFileSync(marker, new Date().toISOString());

  // The house style, shared with the Studio (same file the MCP server's tools use).
  const styleFile = process.env.SCREENSHOTTER_STYLE_FILE || path.join(os.homedir(), "Library", "Application Support", "Screenshotter", "house-style.json");
  let notes = [];
  try {
    notes = (JSON.parse(readFileSync(styleFile, "utf8")).notes ?? []).map((n) => n.text).filter(Boolean);
  } catch {
    // No house style yet.
  }

  const context = [
    "Screenshotter: check this render like a designer before moving on.",
    "- Headline readable at thumbnail size, 2–5 words a line, at most 3 lines, not touching the device.",
    "- Device big (60–80% of the height, or bleeding off an edge); no empty band over ~20% of the canvas.",
    "- Backdrop and accent taken from the app's own palette; every text colour has strong contrast.",
    "- One hero and one idea; call-outs on the element the headline names.",
    "Zoom into details with crop_image (focus + zoom). If the direction isn't clear, render 2–3 variants and compare them side by side with create_grid (labels), then refine the best.",
    notes.length ? `House style (follow it): ${notes.map((n) => `“${n}”`).join("; ")}.` : "No house style saved yet. When the person states a preference, save it with remember_style.",
    "The full art-direction guide is the design_guide tool.",
  ].join("\n");
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: context } }));
});
