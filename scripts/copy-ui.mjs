#!/usr/bin/env node
// Copy the Studio UI (plain ES modules, no bundler) and its two tiny dependencies into dist.
import { cpSync, mkdirSync, rmSync, copyFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(root, "package.json"));
const out = path.join(root, "dist", "studio");
rmSync(path.join(out, "ui"), { recursive: true, force: true });
mkdirSync(path.join(out, "ui", "vendor"), { recursive: true });
cpSync(path.join(root, "src", "studio", "ui"), path.join(out, "ui"), { recursive: true });
copyFileSync(path.join(root, "src", "studio", "docs.html"), path.join(out, "docs.html"));
// Walk up from the package's entry point (htm doesn't export its package.json).
const pkg = (name) => {
  let dir = path.dirname(require.resolve(name));
  while (!dir.endsWith(`${path.sep}node_modules${path.sep}${name}`)) dir = path.dirname(dir);
  return dir;
};
copyFileSync(path.join(pkg("preact"), "dist", "preact.module.js"), path.join(out, "ui", "vendor", "preact.js"));
copyFileSync(path.join(pkg("preact"), "hooks", "dist", "hooks.module.js"), path.join(out, "ui", "vendor", "hooks.js"));
copyFileSync(path.join(pkg("htm"), "dist", "htm.module.js"), path.join(out, "ui", "vendor", "htm.js"));
