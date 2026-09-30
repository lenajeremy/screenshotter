#!/usr/bin/env node
/**
 * Package build/Screenshotter.app as a drag-to-Applications disk image, for the website's
 * Download button.
 *
 *   npm run app:dmg                      → build/Screenshotter-<version>.dmg and site/downloads/Screenshotter.dmg
 *   npm run app:dmg -- --bundle-node     builds the app with Node inside first (for Macs without Node)
 *
 * The app is ad-hoc signed. For a public release, sign it with a Developer ID and notarize the
 * disk image, or macOS will ask people to allow it in Privacy & Security on first launch.
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const run = (cmd, args) => {
  const r = spawnSync(cmd, args, { cwd: root, stdio: "inherit" });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} failed (${r.status})`);
};
const version = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).version;

run("node", ["scripts/build-app.mjs", ...process.argv.slice(2)]);
const app = path.join(root, "build", "Screenshotter.app");
if (!existsSync(app)) throw new Error("build/Screenshotter.app is missing");

// Stage the app next to an Applications shortcut, so the window says what to do.
const stage = path.join(mkdtempSync(path.join(tmpdir(), "screenshotter-dmg-")), "Screenshotter");
mkdirSync(stage, { recursive: true });
cpSync(app, path.join(stage, "Screenshotter.app"), { recursive: true, verbatimSymlinks: true });
symlinkSync("/Applications", path.join(stage, "Applications"));

const dmg = path.join(root, "build", `Screenshotter-${version}.dmg`);
rmSync(dmg, { force: true });
run("hdiutil", ["create", "-volname", "Screenshotter", "-srcfolder", stage, "-ov", "-format", "ULMO", dmg]);
rmSync(path.dirname(stage), { recursive: true, force: true });

const site = path.join(root, "site", "downloads");
mkdirSync(site, { recursive: true });
copyFileSync(dmg, path.join(site, "Screenshotter.dmg"));
const mb = (statSync(dmg).size / 1024 / 1024).toFixed(1);
console.log(`\n✓ ${path.relative(root, dmg)} (${mb} MB), copied to site/downloads/Screenshotter.dmg`);
