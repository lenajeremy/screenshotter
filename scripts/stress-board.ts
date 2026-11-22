/**
 * A heavy board to try by hand: the canvas benchmark's stress design (18 desktop pages and 30 phone
 * screens, about 9,700 layers: nested flex frames, text, pictures, shadows, gradients, SVG icons,
 * videos and shaders) on a new board in a library, as an agent would add it. Nothing else in the
 * library changes; its pictures and videos are copied into the board's own assets.
 *
 *   npx tsx scripts/stress-board.ts --app Glassine          the library that app uses
 *   npx tsx scripts/stress-board.ts --library <folder>      a library folder
 *   --sets 1                                                a third of it (16 artboards, ~3,200 layers)
 */
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const args = process.argv.slice(2);
const opt = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const appName = opt("app");
const library = opt("library") ?? (appName ? (JSON.parse(readFileSync(path.join(os.homedir(), "Library", "Application Support", appName, "studio.json"), "utf8")) as { folder: string }).folder : undefined);
if (!library || !existsSync(library)) throw new Error(`Which library? --app <name> or --library <folder> (got ${library ?? "none"})`);
const SETS = Number(opt("sets") ?? 3);

const tmp = mkdtempSync(path.join(os.tmpdir(), "glassine-stress-"));
// The library to add to; anything else the modules might write stays in the scratch folder.
Object.assign(process.env, { SCREENSHOTTER_OUTPUT_DIR: library, SCREENSHOTTER_STUDIO_FILE: path.join(tmp, "studio.json"), SCREENSHOTTER_CACHE_DIR: path.join(tmp, "cache"), SCREENSHOTTER_NO_KEYCHAIN: "1" });
const boards = await import("../src/board/store.js");
const core = await import("../src/board/core.js");
const { A, desktop, phone, photo } = await import("./bench-designs.js");

A.photos = [0, 1, 2, 3, 4, 5].map((i) => path.join(tmp, `photo-${i}.png`));
A.avatars = [0, 1, 2, 3, 4, 5].map((i) => path.join(tmp, `avatar-${i}.png`));
A.photos.forEach((f, i) => photo(f, 1200, 800, i + 1));
A.avatars.forEach((f, i) => photo(f, 160, 160, i + 11));
A.clip = path.join(tmp, "clip.mp4");
copyFileSync(path.join(import.meta.dirname, "fixtures", "clip.mp4"), A.clip);

const artboards = Array.from({ length: SETS }, (_, r) => [
  ...[0, 1, 2, 3, 4, 5].map((k) => desktop(r * 6 + k, { x: k * 1640, y: r * 7200 })),
  ...[0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((k) => phone(r * 10 + k, { x: k * 490, y: r * 7200 + 5600 })),
]).flat();

const b = boards.createBoard("Stress test", "agent");
for (const [i, html] of artboards.entries()) {
  const made = core.addHtmlOps(html, null, { page: b.pages[0].id });
  for (const op of made.ops) if (op.op === "add") boards.adoptImages(op.nodes);
  boards.changeBoard(b.id, made.ops, "agent");
  process.stdout.write(`\r${i + 1}/${artboards.length} artboards`);
}
const board = boards.getBoard(b.id);
const layers = Object.keys(board.nodes).length;
boards.changeBoard(b.id, [{ op: "rename", name: `Stress test · ${layers.toLocaleString("en")} layers` }], "agent");
rmSync(tmp, { recursive: true, force: true });
console.log(`\n✓ "Stress test · ${layers.toLocaleString("en")} layers" (${board.pages[0].children.length} artboards) is on the boards in ${library}`);
