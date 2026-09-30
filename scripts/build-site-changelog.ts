/** Writes the website's What's new page (site/changelog.html) from CHANGELOG.md. */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseChangelog } from "../src/studio/whatsnew.js";

const root = path.join(import.meta.dirname, "..");
const releases = parseChangelog(readFileSync(path.join(root, "CHANGELOG.md"), "utf8"));
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const body = releases
  .map(
    (r, i) => `<section class="release" id="v${r.version}">
  <div class="release-head"><h2>${esc(r.version)}</h2>${r.date ? `<span class="date">${esc(r.date)}</span>` : ""}${i === 0 ? `<span class="latest">Latest</span>` : ""}</div>
  ${r.sections
    .map((s) => `<div class="sec">${s.title ? `<h3>${esc(s.title)}</h3>` : ""}<ul>${s.items.map((it) => `<li>${it}</li>`).join("")}</ul></div>`)
    .join("\n  ")}
</section>`,
  )
  .join("\n");

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>What's new · Screenshotter</title>
<meta name="description" content="Every Screenshotter release and what it added.">
<link rel="icon" href="assets/icon.svg" type="image/svg+xml">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Geist:wght@300..800&family=Geist+Mono:wght@400;500;600&family=Newsreader:ital,opsz,wght@1,6..72,300..500&display=swap">
<style>
:root { --bg: #070708; --line: rgba(255,255,255,.08); --text: #f4f4f5; --text-2: #b4b4bc; --text-3: #80808a; --lime: #d2ff4d; --lime-ink: #0d1100;
  --display: "Newsreader", ui-serif, Georgia, serif; --sans: "Geist", -apple-system, system-ui, sans-serif; --mono: "Geist Mono", ui-monospace, Menlo, monospace; color-scheme: dark; }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); font: 16px/1.6 var(--sans); -webkit-font-smoothing: antialiased; }
a { color: inherit; }
.wrap { max-width: 760px; margin: 0 auto; padding: 0 16px; }
header { display: flex; align-items: center; justify-content: space-between; padding: 22px 0; }
.brand { display: inline-flex; align-items: center; gap: 10px; font-weight: 600; text-decoration: none; }
.brand img { width: 28px; height: 28px; }
.dl { display: inline-flex; align-items: center; height: 36px; padding: 0 16px; border-radius: 999px; background: var(--lime); color: var(--lime-ink); font-weight: 600; font-size: 14px; text-decoration: none; }
h1 { font: 400 clamp(40px, 7vw, 64px)/1.05 var(--display); font-style: italic; letter-spacing: -0.02em; margin: 56px 0 10px; }
.lede { color: var(--text-2); margin: 0 0 48px; }
.release { padding: 36px 0; border-top: 1px solid var(--line); }
.release-head { display: flex; align-items: baseline; gap: 14px; flex-wrap: wrap; margin-bottom: 18px; }
.release h2 { margin: 0; font: 700 28px var(--sans); letter-spacing: -0.02em; }
.date { font: 500 13px var(--mono); color: var(--text-3); }
.latest { font: 600 11px var(--mono); text-transform: uppercase; letter-spacing: .1em; color: var(--lime-ink); background: var(--lime); padding: 3px 8px; border-radius: 999px; }
.sec + .sec { margin-top: 20px; }
h3 { margin: 0 0 8px; font: 600 12px var(--mono); text-transform: uppercase; letter-spacing: .1em; color: var(--text-3); }
ul { margin: 0; padding-left: 20px; display: grid; gap: 8px; color: var(--text-2); }
li::marker { color: var(--lime); }
li strong { color: var(--text); font-weight: 600; }
footer { padding: 48px 0 64px; color: var(--text-3); font-size: 13px; border-top: 1px solid var(--line); }
</style>
</head>
<body>
<div class="wrap">
<header><a class="brand" href="./"><img src="assets/icon.svg" alt="">Screenshotter</a><a class="dl" href="downloads/Screenshotter.dmg">Download</a></header>
<h1>What's new</h1>
<p class="lede">Every release and what it added. The app shows these notes once after it updates, and anytime from Help › What's New.</p>
${body}
<footer><a href="./">← Back to Screenshotter</a></footer>
</div>
</body>
</html>
`;
writeFileSync(path.join(root, "site", "changelog.html"), html);
console.log(`Wrote site/changelog.html (${releases.length} releases)`);
