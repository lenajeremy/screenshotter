#!/usr/bin/env node
/**
 * Package build/Screenshotter.app as a drag-to-Applications disk image, for the website's
 * Download button.
 *
 *   npm run app:dmg                      → build/Screenshotter-<version>.dmg and site/downloads/Screenshotter.dmg
 *   npm run app:dmg -- --bundle-node     builds the app with Node inside first (for Macs without Node)
 *
 * With a Developer ID certificate in the keychain, the app and the disk image are signed with it.
 * With notarization credentials saved too, the image is notarized and stapled, so it opens on any
 * Mac without a warning. Save them once with:
 *
 *   xcrun notarytool store-credentials screenshotter --apple-id <you@example.com> --team-id <TEAMID>
 *
 * (it asks for an app-specific password from account.apple.com). See scripts/signing.mjs.
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { notaryAuth, signingIdentity } from "./signing.mjs";

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

const identity = signingIdentity();
let state = "ad-hoc signed";
if (identity) {
  run("codesign", ["--force", "--timestamp", "--sign", identity, dmg]);
  state = "signed";
  const auth = notaryAuth();
  if (auth) {
    console.log("\n▸ Notarizing with Apple (a few minutes)");
    run("xcrun", ["notarytool", "submit", dmg, ...auth, "--wait"]);
    run("xcrun", ["stapler", "staple", dmg]);
    state = "signed and notarized";
    // Notarized, it can be offered as an update: sign it with the update key and write the feed.
    run("node", [path.join(root, "scripts", "release-feed.mjs")]);
  }
}

const site = path.join(root, "site", "downloads");
mkdirSync(site, { recursive: true });
copyFileSync(dmg, path.join(site, "Screenshotter.dmg"));
const mb = (statSync(dmg).size / 1024 / 1024).toFixed(1);
console.log(`\n✓ ${path.relative(root, dmg)} (${mb} MB, ${state}), copied to site/downloads/Screenshotter.dmg`);
if (identity && state === "signed") {
  console.log("  Not notarized: macOS will still warn people who download it. To notarize, either:");
  console.log("    name a notarytool profile you've already saved: SCREENSHOTTER_NOTARY_PROFILE=<name> npm run app:dmg");
  console.log("    use an App Store Connect API key: SCREENSHOTTER_NOTARY_KEY=<AuthKey_….p8> SCREENSHOTTER_NOTARY_KEY_ID=<id> SCREENSHOTTER_NOTARY_ISSUER=<issuer> npm run app:dmg");
  console.log("    or save a profile: xcrun notarytool store-credentials screenshotter --apple-id <your Apple ID> --team-id " + (/\(([A-Z0-9]{10})\)$/.exec(identity)?.[1] ?? "<TEAMID>"));
}
