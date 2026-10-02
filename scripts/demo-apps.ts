/**
 * Render the demo apps Bloom and Penny (site/demo/apps.ts) as screenshots, each at its device's
 * pixel scale, into site/demo/shots/<app>-<screen>.png: iPhone at 3×, iPhone Duo open at 3× (its
 * 2670 × 1878 inner screen), iPad and Mac at 2×. For trying templates on more than one kind of app.
 *
 *   npx tsx scripts/demo-apps.ts
 */
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { closeBrowser } from "../src/render/browser.js";
import { renderHtml } from "../src/render/mockup.js";
import { bloom, penny } from "../site/demo/apps.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(root, "site", "demo", "shots");
mkdirSync(out, { recursive: true });

const SIZE: Record<string, [number, number, number]> = {
  duoWide: [890, 626, 3],
  duoTall: [626, 890, 3],
  ipad: [1032, 1376, 2],
  mac: [1512, 982, 2],
};
for (const [app, screens] of Object.entries({ bloom, penny })) {
  for (const [name, html] of Object.entries(screens)) {
    const [w, h, scale] = SIZE[name] ?? [402, 874, 3];
    const file = path.join(out, `${app}-${name}.png`);
    await renderHtml(`<!doctype html><html>${html()}</html>`, file, w, h, { scale, format: "png", transparent: false, outWidth: w * scale, outHeight: h * scale });
    console.log(`${path.relative(root, file)}  ${w * scale}×${h * scale}`);
  }
}
await closeBrowser();
