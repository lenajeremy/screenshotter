// The board's own change code (src/board/core.ts and what it imports), copied into the server so the
// server folder deploys on its own and applies changes exactly as the app does. Run before dev,
// test and deploy; `--check` fails when the copy is behind the app's.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const from = path.resolve(here, "../../src/board");
const to = path.resolve(here, "../src/shared");
const files = ["core.ts", "shaders.ts"];
const check = process.argv.includes("--check");
mkdirSync(to, { recursive: true });
let stale = [];
for (const f of files) {
  const src = path.join(from, f);
  if (!existsSync(src)) {
    // Deployed on its own (no app beside it): the copy that came with it is what there is.
    if (existsSync(path.join(to, f))) continue;
    throw new Error(`${src} is missing, and there's no copy in src/shared.`);
  }
  const body = `// Copied from src/board/${f} by scripts/shared.mjs: change it there.\n${readFileSync(src, "utf8")}`;
  const out = path.join(to, f);
  if (existsSync(out) && readFileSync(out, "utf8") === body) continue;
  if (check) stale.push(f);
  else writeFileSync(out, body);
}
if (stale.length) {
  console.error(`src/shared is behind the app's board code (${stale.join(", ")}): run node scripts/shared.mjs`);
  process.exit(1);
}
