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
  <div class="meta"><h2><a href="#v${r.version}">${esc(r.version)}</a></h2>${r.date ? `<span class="date">${esc(r.date)}</span>` : ""}${i === 0 ? `<span class="latest">Latest</span>` : ""}</div>
  <div class="notes">
  ${r.sections
    .map((s) => `<div class="part">${s.title ? `<h3 class="label">${esc(s.title)}</h3>` : ""}<ul>${s.items.map((it) => `<li>${it}</li>`).join("")}</ul></div>`)
    .join("\n  ")}
  </div>
</section>`,
  )
  .join("\n");

// The page wears the site's shared look (site.css, site.js); only the release rows are its own.
const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>What's new · Screenshotter</title>
<meta name="description" content="Every Screenshotter release and what it added.">
<meta name="theme-color" content="#0a0a0b">
<link rel="icon" href="favicon.ico" sizes="48x48">
<link rel="icon" href="favicon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="apple-touch-icon.png">
<link rel="manifest" href="site.webmanifest">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Geist:wght@400..700&family=Geist+Mono:wght@400;500;600&display=swap">
<link rel="stylesheet" href="site.css">
<style>
.releases { margin-top: clamp(56px, 7vw, 88px); border-top: 1px solid var(--line-2); }
.release { display: grid; grid-template-columns: minmax(0, 0.3fr) minmax(0, 1fr); gap: 32px; padding: 44px 0; border-bottom: 1px solid var(--line-2); }
.release .meta { position: sticky; top: 96px; align-self: start; display: flex; flex-direction: column; align-items: flex-start; gap: 10px; }
.release h2 { font: 600 28px/1 var(--sans); letter-spacing: -0.03em; }
.release h2 a:hover { color: var(--lime); }
.date { font: 500 12px var(--mono); color: var(--text-3); }
.latest { padding: 3px 7px; border-radius: 4px; background: var(--lime-soft); color: var(--lime); font: 500 11px var(--mono); letter-spacing: 0.06em; text-transform: uppercase; }
.part + .part { margin-top: 32px; }
.part ul { margin: 14px 0 0; padding: 0; list-style: none; display: grid; gap: 12px; }
.part li { position: relative; padding-left: 20px; max-width: 46em; font-size: 15px; line-height: 1.65; color: var(--text-2); }
.part li::before { content: ""; position: absolute; left: 2px; top: 0.7em; width: 6px; height: 6px; border-radius: 1.5px; background: var(--line-3); }
.part li strong { color: var(--text); font-weight: 500; }
.part li code { font-size: 13px; color: var(--text); }
@media (max-width: 760px) { .release { grid-template-columns: minmax(0, 1fr); gap: 18px; padding: 36px 0; } .release .meta { position: static; flex-direction: row; align-items: baseline; flex-wrap: wrap; gap: 12px; } }
</style>
</head>
<body>

<header class="nav" id="top">
  <div class="wrap">
    <a class="brand" href="./"><img src="favicon.svg" alt="" width="24" height="24">Screenshotter</a>
    <nav class="links" aria-label="Pages">
      <a href="./">Overview</a>
      <a href="features.html">Features</a>
      <a href="features.html#agents">Agents</a>
      <a href="changelog.html" aria-current="page">What's new</a>
    </nav>
    <a class="btn primary sm" href="downloads/Screenshotter.dmg">Download</a>
  </div>
</header>

<main>
<section class="page-head">
  <div class="wrap">
    <p class="label"><b>●</b>&nbsp; Changelog</p>
    <h1>What’s new.</h1>
    <p class="sub">Every release and what it added. The app shows these notes once after it updates, and anytime from Help › What’s New.</p>
    <div class="releases">
${body}
    </div>
  </div>
</section>
</main>

<footer>
  <div class="wrap">
    <div class="row">
      <a class="brand" href="./"><img src="favicon.svg" alt="" width="24" height="24">Screenshotter</a>
      <nav aria-label="Footer"><a href="./">Overview</a><a href="features.html">Features</a><a href="features.html#agents">For agents</a><a href="downloads/Screenshotter.dmg">Download</a></nav>
    </div>
    <div class="small"><span>Every image on this site was made with Screenshotter.</span><span>Version ${esc(releases[0]?.version ?? "")}</span></div>
  </div>
</footer>

<script src="site.js"></script>
</body>
</html>
`;
writeFileSync(path.join(root, "site", "changelog.html"), html);
console.log(`Wrote site/changelog.html (${releases.length} releases)`);
