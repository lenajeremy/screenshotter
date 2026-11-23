#!/usr/bin/env node
/**
 * Build the desktop app with Electron: build/<name>.app, the Studio in a Chromium window
 * (desktop/main.js) and the engine it runs with the Node inside Electron.
 *
 *   npm run desktop:build                       → build/Screenshotter.app
 *   SCREENSHOTTER_APP_NAME=Glassine npm run desktop:build
 *                                               → build/Glassine.app: a separate copy, with its own
 *                                                 bundle id, library, settings and Keychain items
 *
 * It takes Electron's own app (node_modules/electron) and makes it this one: renamed (the app and
 * its helpers), its Info.plist and icon, the desktop code in Resources/app and the engine (dist/ and
 * its production dependencies) in Resources/engine. Signed as scripts/build-app.mjs signs the
 * Swift app: with a Developer ID certificate if there's one (hardened runtime, ready to notarize),
 * else ad hoc.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { signingIdentity } from "./signing.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const NAME = (process.env.SCREENSHOTTER_APP_NAME || "Screenshotter").replace(/[^A-Za-z0-9 ._-]/g, "");
const MAIN = NAME === "Screenshotter";
const BUNDLE_ID = process.env.SCREENSHOTTER_BUNDLE_ID || (MAIN ? "com.screenshotter.studio" : `com.screenshotter.${NAME.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`);
const ELECTRON = path.join(root, "node_modules", "electron", "dist", "Electron.app");

const run = (cmd, args, opts = {}) => {
  const r = spawnSync(cmd, args, { cwd: root, stdio: "inherit", ...opts });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} failed (${r.status})`);
};
const step = (s) => console.log(`\n▸ ${s}`);
const plist = (file, key, type, value) => run("plutil", ["-replace", key, `-${type}`, typeof value === "string" ? value : JSON.stringify(value), file]);

if (!existsSync(ELECTRON)) throw new Error(`Electron isn't installed (${ELECTRON}): npm install (and node node_modules/electron/install.js if its download was skipped).`);

step("Building the engine and Studio UI");
run("npm", ["run", "build"]);

step(`Assembling build/${NAME}.app from Electron ${JSON.parse(readFileSync(path.join(root, "node_modules", "electron", "package.json"), "utf8")).version}`);
const app = path.join(root, "build", `${NAME}.app`);
rmSync(app, { recursive: true, force: true }); // only this generated bundle
mkdirSync(path.dirname(app), { recursive: true });
run("ditto", [ELECTRON, app]);
const contents = path.join(app, "Contents");
const resources = path.join(contents, "Resources");
const frameworks = path.join(contents, "Frameworks");

// The app and its helpers take its name (Electron finds its helpers by the app's executable name).
renameSync(path.join(contents, "MacOS", "Electron"), path.join(contents, "MacOS", NAME));
for (const helper of readdirSync(frameworks).filter((f) => /^Electron Helper.*\.app$/.test(f))) {
  const name = helper.replace(/^Electron/, NAME).replace(/\.app$/, "");
  const to = path.join(frameworks, `${name}.app`);
  renameSync(path.join(frameworks, helper), to);
  renameSync(path.join(to, "Contents", "MacOS", helper.replace(/\.app$/, "")), path.join(to, "Contents", "MacOS", name));
  const info = path.join(to, "Contents", "Info.plist");
  plist(info, "CFBundleName", "string", name);
  plist(info, "CFBundleIdentifier", "string", `${BUNDLE_ID}.helper`);
  plist(info, "CFBundleExecutable", "string", name);
}

const info = path.join(contents, "Info.plist");
const imageTypes = ["public.png", "public.jpeg", "org.webmproject.webp", "public.tiff", "public.heic", "public.svg-image", "com.compuserve.gif", "public.mpeg-4", "com.apple.quicktime-movie"];
for (const [key, type, value] of [
  ["CFBundleExecutable", "string", NAME],
  ["CFBundleName", "string", NAME],
  ["CFBundleDisplayName", "string", NAME],
  ["CFBundleIdentifier", "string", BUNDLE_ID],
  ["CFBundleShortVersionString", "string", pkg.version],
  ["CFBundleVersion", "string", pkg.version],
  ["CFBundleIconFile", "string", "AppIcon"],
  ["LSMinimumSystemVersion", "string", "14.0"],
  ["LSApplicationCategoryType", "string", "public.app-category.graphics-design"],
  ["NSHumanReadableCopyright", "string", `${NAME} — design with your agent.`],
  [
    "CFBundleDocumentTypes",
    "json",
    [
      { CFBundleTypeName: "Image", CFBundleTypeRole: "Viewer", LSHandlerRank: "Alternate", LSItemContentTypes: imageTypes },
      { CFBundleTypeName: "Figma Document", CFBundleTypeRole: "Viewer", LSHandlerRank: "Alternate", CFBundleTypeExtensions: ["fig"], LSItemContentTypes: ["com.figma.document"] },
    ],
  ],
  [
    "UTImportedTypeDeclarations",
    "json",
    [
      {
        UTTypeIdentifier: "com.figma.document",
        UTTypeDescription: "Figma Document",
        UTTypeConformsTo: ["public.data"],
        UTTypeTagSpecification: { "public.filename-extension": ["fig"] },
      },
    ],
  ],
]) plist(info, key, type, value);

// The desktop code, where Electron looks for an app (Electron's own default app goes).
rmSync(path.join(resources, "default_app.asar"), { force: true });
rmSync(path.join(resources, "electron.icns"), { force: true });
const appDir = path.join(resources, "app");
mkdirSync(appDir, { recursive: true });
for (const f of ["main.js", "preload.cjs"]) copyFileSync(path.join(root, "desktop", f), path.join(appDir, f));
writeFileSync(path.join(appDir, "package.json"), JSON.stringify({ name: NAME.toLowerCase().replace(/[^a-z0-9]+/g, "-"), productName: NAME, displayName: (process.env.SCREENSHOTTER_PRODUCT_NAME || NAME).replace(/[^A-Za-z0-9 ._-]/g, ""), version: pkg.version, main: "main.js", type: "module" }, null, 2));

// Engine: compiled JS (no source maps), docs, and production dependencies.
const engine = path.join(resources, "engine");
mkdirSync(engine, { recursive: true });
cpSync(path.join(root, "dist"), path.join(engine, "dist"), { recursive: true, filter: (src) => !src.endsWith(".map") });
for (const f of ["package.json", "README.md", "CHANGELOG.md"]) copyFileSync(path.join(root, f), path.join(engine, f));
const prod = execFileSync("npm", ["ls", "--omit=dev", "--all", "--parseable"], { cwd: root, encoding: "utf8" })
  .split("\n")
  .map((l) => l.trim())
  .filter((l) => l && l !== root && l.includes(`${path.sep}node_modules${path.sep}`));
const skip = /\.(map|d\.ts|d\.mts|d\.cts|md|markdown)$|[/\\](test|tests|__tests__|docs|example|examples)[/\\]/i;
for (const dir of new Set(prod)) {
  cpSync(dir, path.join(engine, path.relative(root, dir)), {
    recursive: true,
    filter: (src) => {
      const inner = path.relative(dir, src);
      if (inner.split(path.sep).includes("node_modules")) return false;
      return !skip.test(inner) || /LICENSE/i.test(inner);
    },
  });
}

// Icon: app/icon.svg drawn by the engine's headless Chrome, made an .icns.
step("Drawing the app icon");
const iconset = path.join(mkdtempSync(path.join(tmpdir(), "glassine-icon-")), "AppIcon.iconset");
mkdirSync(iconset);
const { newPage, closeBrowser } = await import(path.join(root, "dist", "render", "browser.js"));
const page = await newPage();
await page.setViewport({ width: 1024, height: 1024, deviceScaleFactor: 1 });
await page.setContent(`<html><body style="margin:0;background:transparent">${readFileSync(path.join(root, "app", "icon.svg"), "utf8")}</body></html>`);
const master = path.join(iconset, "icon_512x512@2x.png");
await page.screenshot({ path: master, omitBackground: true, clip: { x: 0, y: 0, width: 1024, height: 1024 } });
await page.close();
await closeBrowser();
for (const size of [16, 32, 128, 256, 512])
  for (const scale of [1, 2]) {
    const px = size * scale;
    const name = `icon_${size}x${size}${scale === 2 ? "@2x" : ""}.png`;
    if (name !== "icon_512x512@2x.png") execFileSync("sips", ["-z", String(px), String(px), master, "--out", path.join(iconset, name)], { stdio: "ignore" });
  }
execFileSync("iconutil", ["-c", "icns", iconset, "-o", path.join(resources, "AppIcon.icns")]);

// Signing, inside out: Electron's libraries and frameworks, its helpers, then the app.
const identity = signingIdentity();
const ent = (() => {
  const dir = mkdtempSync(path.join(tmpdir(), "glassine-sign-"));
  const file = (name, keys) => {
    const p = path.join(dir, name);
    writeFileSync(p, `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n${keys.map((k) => `  <key>${k}</key><true/>`).join("\n")}\n</dict></plist>\n`);
    return p;
  };
  // V8 compiles JavaScript as it runs (the page, and the engine run as Node by the app itself).
  const js = ["com.apple.security.cs.allow-jit", "com.apple.security.cs.allow-unsigned-executable-memory", "com.apple.security.cs.disable-library-validation"];
  return { app: file("app.entitlements", [...js, "com.apple.security.automation.apple-events", "com.apple.security.device.camera", "com.apple.security.device.audio-input"]), helper: file("helper.entitlements", js) };
})();
if (identity) {
  step(`Signing with ${identity}`);
  const sign = (target, entitlements) => run("codesign", ["--force", "--options", "runtime", "--timestamp", ...(entitlements ? ["--entitlements", entitlements] : []), "--sign", identity, target]);
  const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() && !d.isSymbolicLink() ? walk(path.join(dir, d.name)) : [path.join(dir, d.name)]));
  for (const fw of readdirSync(frameworks).filter((f) => f.endsWith(".framework"))) {
    const dir = path.join(frameworks, fw);
    for (const f of walk(dir)) if (/\.(dylib|so|node)$/.test(f) || (statSync(f).mode & 0o111 && !f.includes(".app/") && path.basename(f) !== path.basename(fw, ".framework") && !/Resources/.test(f))) sign(f);
    for (const inner of walk(dir).filter((f) => f.endsWith(".app/Contents/Info.plist"))) sign(path.dirname(path.dirname(inner)));
    sign(dir);
  }
  for (const helper of readdirSync(frameworks).filter((f) => f.endsWith(".app"))) sign(path.join(frameworks, helper), ent.helper);
  sign(app, ent.app);
  run("codesign", ["--verify", "--deep", "--strict", app]);
} else {
  step("Signing (ad hoc: no Developer ID certificate found)");
  run("codesign", ["--force", "--deep", "--sign", "-", app]);
}

const size = (p) => Number(execFileSync("du", ["-sk", p], { encoding: "utf8" }).split("\t")[0]) * 1024;
const mb = (n) => `${(n / 1024 / 1024).toFixed(1)} MB`;
console.log(`\n✓ Built ${path.relative(root, app)} (${mb(size(app))}: engine ${mb(size(engine))}, Electron ${mb(size(path.join(frameworks, "Electron Framework.framework")))})`);
console.log(`  Check it:    npx tsx scripts/desktop-check.ts --app`);
console.log(`  Open it:     open "build/${NAME}.app"`);
