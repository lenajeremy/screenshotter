#!/usr/bin/env node
/**
 * The update feed (Sparkle's appcast) for a notarized release: the disk image signed with the
 * update key in your keychain, a versioned copy of it beside the site's download, and
 * site/appcast.xml offering it to everyone on an older version, with its notes from CHANGELOG.md.
 *
 *   node scripts/release-feed.mjs        (build-dmg runs it after notarizing)
 *
 * Publish by deploying the site. The app checks the feed once a day, and on Check for Updates…
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { marked } from "marked";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SITE = process.env.SCREENSHOTTER_SITE_URL ?? "https://screenshotter-umber.vercel.app";
const { version } = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));

const dmg = path.join(root, "build", `Screenshotter-${version}.dmg`);
if (!existsSync(dmg)) throw new Error(`No ${path.relative(root, dmg)}: run npm run app:dmg first.`);
const signer = path.join(root, "app", ".build", "artifacts", "sparkle", "Sparkle", "bin", "sign_update");
if (!existsSync(signer)) throw new Error("Sparkle's sign_update isn't there: build the app first (npm run app:build).");

// The versioned copy the feed points at; the newest two stay, so a cached feed still works.
const downloads = path.join(root, "site", "downloads");
const name = `Screenshotter-${version}.dmg`;
copyFileSync(dmg, path.join(downloads, name));
const older = readdirSync(downloads)
  .filter((f) => /^Screenshotter-\d+\.\d+\.\d+\.dmg$/.test(f) && f !== name)
  .sort((a, b) => statSync(path.join(downloads, b)).mtimeMs - statSync(path.join(downloads, a)).mtimeMs);
for (const f of older.slice(1)) rmSync(path.join(downloads, f));

// Signed with the private key in the keychain (generate_keys made it): `sparkle:edSignature="…" length="…"`.
const signature = execFileSync(signer, [dmg], { encoding: "utf8" }).trim();
if (!/sparkle:edSignature="[^"]+"\s+length="\d+"/.test(signature)) throw new Error(`sign_update gave: ${signature}`);

// The release's notes, as the What's New sheet shows them.
const log = readFileSync(path.join(root, "CHANGELOG.md"), "utf8");
const section = new RegExp(`^## ${version.replace(/\./g, "\\.")}[^\\n]*\\n([\\s\\S]*?)(?=^## |$(?![\\s\\S]))`, "m").exec(log)?.[1]?.trim() ?? "";
const notes = section ? marked.parse(section.replace(/^### /gm, "#### ")) : `<p>Screenshotter ${version}.</p>`;
const css = "<style>body{font:13px -apple-system,system-ui;line-height:1.45;color:#1d1d1f}h4{font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:#6e6e73;margin:14px 0 4px}ul{padding-left:18px;margin:0}li{margin:4px 0}code{font:12px ui-monospace,monospace}@media (prefers-color-scheme:dark){body{color:#f5f5f7}h4{color:#a1a1a6}}</style>";

const date = new Date().toUTCString();
const xml = `<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0" xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel>
    <title>Screenshotter</title>
    <link>${SITE}/appcast.xml</link>
    <description>Updates to Screenshotter.</description>
    <language>en</language>
    <item>
      <title>Screenshotter ${version}</title>
      <pubDate>${date}</pubDate>
      <sparkle:version>${version}</sparkle:version>
      <sparkle:shortVersionString>${version}</sparkle:shortVersionString>
      <sparkle:minimumSystemVersion>14.0</sparkle:minimumSystemVersion>
      <sparkle:fullReleaseNotesLink>${SITE}/changelog.html</sparkle:fullReleaseNotesLink>
      <description><![CDATA[${css}${notes}]]></description>
      <enclosure url="${SITE}/downloads/${name}" type="application/octet-stream" ${signature} />
    </item>
  </channel>
</rss>
`;
writeFileSync(path.join(root, "site", "appcast.xml"), xml);
console.log(`✓ site/appcast.xml offers ${version} (site/downloads/${name}, signed). Deploy the site to publish it.`);
