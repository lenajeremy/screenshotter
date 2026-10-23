#!/usr/bin/env node
/**
 * Build Screenshotter.app: a small AppKit shell (app/) around the Studio engine.
 *
 *   npm run app:build                 → build/Screenshotter.app
 *
 * The bundle holds the compiled engine (dist/) and its production dependencies, and the programs
 * it runs on, so it works on a Mac with nothing installed: the Node running this build, and an
 * ffmpeg built from source for it (scripts/build-ffmpeg.mjs; a few minutes the first time), both in
 * Contents/Helpers, with their licences in Contents/Resources/Licenses.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ffmpegBuild } from "./build-ffmpeg.mjs";
import { entitlements, signingIdentity } from "./signing.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// Updates (Sparkle): the feed the app checks, and the public half of the key releases are signed
// with (the private half is in the keychain of whoever publishes: see scripts/release-feed.mjs).
const FEED_URL = process.env.SCREENSHOTTER_FEED_URL ?? "https://screenshotter-umber.vercel.app/appcast.xml";
const UPDATE_KEY = "opZoJmL49A5/xAnivPGIucSxtQXaUKtTac3kJGQ2D4k=";
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));

const run = (cmd, args, opts = {}) => {
  const r = spawnSync(cmd, args, { cwd: root, stdio: "inherit", ...opts });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} failed (${r.status})`);
};
const step = (s) => console.log(`\n▸ ${s}`);

// The Node that goes in: this one, if it runs on any Mac (Homebrew's needs Homebrew's libraries).
const nodeLinks = execFileSync("otool", ["-L", process.execPath], { encoding: "utf8" }).trim().split("\n").slice(1).map((l) => l.trim().split(" ")[0]);
const nodeForeign = nodeLinks.filter((l) => !l.startsWith("/usr/lib/") && !l.startsWith("/System/Library/"));
if (nodeForeign.length) throw new Error(`This Node (${process.execPath}) needs libraries other Macs won't have (${nodeForeign.join(", ")}). Build with Node from nodejs.org or nvm.`);
if (Number(process.versions.node.split(".")[0]) < 20) throw new Error(`The app needs Node 20 or newer; this is ${process.version}.`);

step("Getting ffmpeg ready");
const ffmpeg = ffmpegBuild();

step("Building the engine and Studio UI");
run("npm", ["run", "build"]);

step("Compiling the macOS shell");
run("swift", ["build", "--package-path", "app", "-c", "release"]);
const bin = execFileSync("swift", ["build", "--package-path", "app", "-c", "release", "--show-bin-path"], { cwd: root, encoding: "utf8" }).trim();

step("Assembling build/Screenshotter.app");
const app = path.join(root, "build", "Screenshotter.app");
rmSync(app, { recursive: true, force: true }); // only this generated bundle
const contents = path.join(app, "Contents");
const resources = path.join(contents, "Resources");
const engine = path.join(resources, "engine");
mkdirSync(path.join(contents, "MacOS"), { recursive: true });
mkdirSync(engine, { recursive: true });
copyFileSync(path.join(bin, "Screenshotter"), path.join(contents, "MacOS", "Screenshotter"));
chmodSync(path.join(contents, "MacOS", "Screenshotter"), 0o755);
// Sparkle, with its symlinks and helpers intact, where the app looks for frameworks.
const frameworks = path.join(contents, "Frameworks");
mkdirSync(frameworks, { recursive: true });
run("ditto", [path.join(bin, "Sparkle.framework"), path.join(frameworks, "Sparkle.framework")]);
const rpaths = execFileSync("otool", ["-l", path.join(contents, "MacOS", "Screenshotter")], { encoding: "utf8" });
if (!rpaths.includes("@executable_path/../Frameworks")) run("install_name_tool", ["-add_rpath", "@executable_path/../Frameworks", path.join(contents, "MacOS", "Screenshotter")]);

// Engine: compiled JS (no source maps), docs, and production dependencies.
cpSync(path.join(root, "dist"), path.join(engine, "dist"), { recursive: true, filter: (src) => !src.endsWith(".map") });
for (const f of ["package.json", "README.md", "CHANGELOG.md"]) copyFileSync(path.join(root, f), path.join(engine, f));
const prod = execFileSync("npm", ["ls", "--omit=dev", "--all", "--parseable"], { cwd: root, encoding: "utf8" })
  .split("\n")
  .map((l) => l.trim())
  .filter((l) => l && l !== root && l.includes(`${path.sep}node_modules${path.sep}`));
const skip = /\.(map|d\.ts|d\.mts|d\.cts|md|markdown)$|[/\\](test|tests|__tests__|docs|example|examples)[/\\]/i;
for (const dir of new Set(prod)) {
  const rel = path.relative(root, dir);
  cpSync(dir, path.join(engine, rel), {
    recursive: true,
    filter: (src) => {
      const inner = path.relative(dir, src);
      // Nested node_modules are copied as their own entries from `npm ls`.
      if (inner.split(path.sep).includes("node_modules")) return false;
      return !skip.test(inner) || /LICENSE/i.test(inner);
    },
  });
}
// The programs it runs on, and their licences.
const helpers = path.join(contents, "Helpers");
mkdirSync(helpers, { recursive: true });
copyFileSync(process.execPath, path.join(helpers, "node"));
copyFileSync(ffmpeg.bin, path.join(helpers, "ffmpeg"));
for (const f of ["node", "ffmpeg"]) chmodSync(path.join(helpers, f), 0o755);
const licenses = path.join(resources, "Licenses");
cpSync(ffmpeg.licenses, licenses, { recursive: true });
copyFileSync(ffmpeg.notice, path.join(licenses, "ffmpeg NOTICE.txt"));
const nodeLicense = path.resolve(process.execPath, "..", "..", "LICENSE");
if (!existsSync(nodeLicense)) throw new Error(`Node's licence isn't beside it (${nodeLicense}).`);
copyFileSync(nodeLicense, path.join(licenses, "Node.js.txt"));

// Icon: render app/icon.svg with the same headless Chrome the engine uses, then make an .icns.
step("Drawing the app icon");
const iconset = path.join(mkdtempSync(path.join(tmpdir(), "screenshotter-icon-")), "AppIcon.iconset");
mkdirSync(iconset);
const { newPage, closeBrowser } = await import(path.join(root, "dist", "render", "browser.js"));
const page = await newPage();
await page.setViewport({ width: 1024, height: 1024, deviceScaleFactor: 1 });
await page.setContent(`<html><body style="margin:0;background:transparent">${readFileSync(path.join(root, "app", "icon.svg"), "utf8")}</body></html>`);
const master = path.join(iconset, "icon_512x512@2x.png");
await page.screenshot({ path: master, omitBackground: true, clip: { x: 0, y: 0, width: 1024, height: 1024 } });
await page.close();
await closeBrowser();
for (const size of [16, 32, 128, 256, 512]) {
  for (const scale of [1, 2]) {
    const px = size * scale;
    const name = `icon_${size}x${size}${scale === 2 ? "@2x" : ""}.png`;
    if (name === "icon_512x512@2x.png") continue;
    execFileSync("sips", ["-z", String(px), String(px), master, "--out", path.join(iconset, name)], { stdio: "ignore" });
  }
}
execFileSync("iconutil", ["-c", "icns", iconset, "-o", path.join(resources, "AppIcon.icns")]);

const imageTypes = ["public.png", "public.jpeg", "org.webmproject.webp", "public.tiff", "public.heic", "public.svg-image", "com.compuserve.gif", "public.mpeg-4", "com.apple.quicktime-movie"];
writeFileSync(
  path.join(contents, "Info.plist"),
  `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleExecutable</key><string>Screenshotter</string>
  <key>CFBundleIdentifier</key><string>com.screenshotter.studio</string>
  <key>CFBundleName</key><string>Screenshotter</string>
  <key>CFBundleDisplayName</key><string>Screenshotter</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>${pkg.version}</string>
  <key>CFBundleVersion</key><string>${pkg.version}</string>
  <key>LSMinimumSystemVersion</key><string>14.0</string>
  <key>LSApplicationCategoryType</key><string>public.app-category.graphics-design</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSSupportsAutomaticGraphicsSwitching</key><true/>
  <key>NSHumanReadableCopyright</key><string>Screenshotter — marketing mockups from your app's real screens.</string>
  <key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>
  <key>NSAppleEventsUsageDescription</key><string>Screenshotter asks other apps about their windows so it can capture the one you pick.</string>
  <key>NSCameraUsageDescription</key><string>Screenshotter records your camera alongside your screen when you turn it on in the capture bar.</string>
  <key>NSMicrophoneUsageDescription</key><string>Screenshotter records your voice with your screen recordings when you turn the microphone on in the capture bar.</string>
  <key>SUFeedURL</key><string>${FEED_URL}</string>
  <key>SUPublicEDKey</key><string>${UPDATE_KEY}</string>
  <key>SUEnableAutomaticChecks</key><true/>
  <key>CFBundleDocumentTypes</key><array><dict>
    <key>CFBundleTypeName</key><string>Screenshot</string>
    <key>CFBundleTypeRole</key><string>Viewer</string>
    <key>LSHandlerRank</key><string>Alternate</string>
    <key>LSItemContentTypes</key><array>${imageTypes.map((t) => `<string>${t}</string>`).join("")}</array>
  </dict></array>
</dict></plist>
`,
);

const identity = signingIdentity();
if (identity) {
  step(`Signing with ${identity}`);
  const ent = entitlements();
  const sign = (target, file) => run("codesign", ["--force", "--options", "runtime", "--timestamp", "--entitlements", file, "--sign", identity, target]);
  // Inside out: Node and ffmpeg, Sparkle's helpers and Sparkle itself, then the app around them.
  const plain = (target, extra = []) => run("codesign", ["--force", "--options", "runtime", "--timestamp", ...extra, "--sign", identity, target]);
  sign(path.join(helpers, "node"), ent.node);
  plain(path.join(helpers, "ffmpeg"));
  const sparkle = path.join(frameworks, "Sparkle.framework", "Versions", "B");
  for (const xpc of ["Installer.xpc", "Downloader.xpc"]) {
    const p = path.join(sparkle, "XPCServices", xpc);
    if (existsSync(p)) plain(p, xpc === "Downloader.xpc" ? ["--preserve-metadata=entitlements"] : []);
  }
  plain(path.join(sparkle, "Autoupdate"));
  plain(path.join(sparkle, "Updater.app"));
  plain(path.join(frameworks, "Sparkle.framework"));
  sign(app, ent.app);
  run("codesign", ["--verify", "--deep", "--strict", app]);
} else {
  step("Signing (ad hoc: no Developer ID certificate found)");
  run("codesign", ["--force", "--deep", "--sign", "-", app]);
}

const size = (p) => {
  const s = statSync(p);
  if (!s.isDirectory()) return s.size;
  return execFileSync("du", ["-sk", p], { encoding: "utf8" }).split("\t")[0] * 1024;
};
const mb = (n) => `${(n / 1024 / 1024).toFixed(1)} MB`;
console.log(`\n✓ Built ${path.relative(root, app)} (${mb(size(app))}: engine ${mb(size(engine))}, Node ${process.version} ${mb(size(path.join(helpers, "node")))}, ffmpeg ${mb(size(path.join(helpers, "ffmpeg")))})`);
console.log(`  Open it:     npm run app:start`);
console.log(`  Install it:  cp -R build/Screenshotter.app /Applications/`);
if (!existsSync(path.join(resources, "AppIcon.icns"))) console.warn("  (icon missing)");
