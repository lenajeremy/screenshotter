// The desktop app (Electron): one window hosting the Studio, the web UI the engine serves, and the
// engine itself (`dist/index.js studio`), run with the Node inside Electron. It adds what a browser
// tab can't do: a window with the traffic lights in the Studio's own top bar, menus, files opened
// from Finder, pictures and Figma designs pasted from other apps, the Keychain, and a few native
// calls the page makes (window.glassine.native: see preload.cjs and store.js `native`).
//
// It takes over from the Swift shell in app/ (same behaviour, same calls), with Chromium drawing the
// canvas: WebKit couldn't keep zooming and heavy boards at 60 fps (docs/perf) and capped high-zoom
// text rasterization.
import { app, autoUpdater, BrowserWindow, Menu, clipboard, dialog, ipcMain, nativeImage, nativeTheme, screen, shell } from "electron";
import { execFile, spawn } from "node:child_process";
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
// A copy of the app is named (and keeps its library, settings, logs and Keychain items) by its
// name: a development run is its own copy, so it never touches the installed app's library.
const NAME = app.isPackaged ? app.getName() : process.env.SCREENSHOTTER_APP_NAME || "Glassine Dev";
app.setName(NAME);
// Tests and benchmarks run a copy with everything of its own (never the person's settings).
if (process.env.GLASSINE_USER_DATA) app.setPath("userData", process.env.GLASSINE_USER_DATA);
const NO_KEYCHAIN = Boolean(process.env.SCREENSHOTTER_NO_KEYCHAIN);
const HOME = os.homedir();
const SUPPORT = path.join(HOME, "Library", "Application Support", NAME);
const STUDIO_FILE = path.join(SUPPORT, "studio.json");
const LOG = process.env.GLASSINE_LOG_DIR ? path.join(process.env.GLASSINE_LOG_DIR, "engine.log") : path.join(HOME, "Library", "Logs", NAME, "engine.log");
/** Where the engine lives: inside the app, or this checkout (or SCREENSHOTTER_ENGINE_DIR) in development. */
const ENGINE_ROOT = process.env.SCREENSHOTTER_ENGINE_DIR || (app.isPackaged ? path.join(process.resourcesPath, "engine") : path.resolve(here, ".."));
const TOP_BAR = 40;

// ---------------------------------------------------------------------------------------------
// `<app> mcp`: the engine's MCP server on stdin/stdout, for agents (claude mcp add … -- <app> mcp)

async function mcp() {
  app.dock?.hide();
  const args = process.argv.slice(process.argv.indexOf("mcp") + 1);
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: "1", SCREENSHOTTER_APP_NAME: NAME };
  env.SCREENSHOTTER_STUDIO_FILE ||= STUDIO_FILE;
  const keys = await savedKeys();
  if (!env.UNSPLASH_ACCESS_KEY && keys.unsplash) env.UNSPLASH_ACCESS_KEY = keys.unsplash;
  if (!env.FIGMA_TOKEN && keys.figma) env.FIGMA_TOKEN = keys.figma;
  if (!env.GLASSINE_AUTH_TOKEN && keys.cloud) env.GLASSINE_AUTH_TOKEN = keys.cloud;
  const child = spawn(process.execPath, [path.join(ENGINE_ROOT, "dist", "index.js"), ...args], { env, stdio: "inherit" });
  child.on("exit", (code) => app.exit(code ?? 1));
  child.on("error", (e) => {
    process.stderr.write(`${NAME} couldn't start its MCP server: ${e.message}\n`);
    app.exit(1);
  });
}

// ---------------------------------------------------------------------------------------------
// Settings kept by the app (the window's place, the theme, the library folder)

const settingsFile = () => path.join(app.getPath("userData"), "settings.json");
function settings() {
  try {
    return JSON.parse(readFileSync(settingsFile(), "utf8"));
  } catch {
    return {};
  }
}
function saveSettings(patch) {
  const next = { ...settings(), ...patch };
  mkdirSync(path.dirname(settingsFile()), { recursive: true });
  writeFileSync(settingsFile(), JSON.stringify(next, null, 2));
  return next;
}

/** The library: the folder chosen in Settings, else SCREENSHOTTER_OUTPUT_DIR, else ~/Pictures/<name>. */
const outputFolder = () => settings().outputFolder || process.env.SCREENSHOTTER_OUTPUT_DIR || path.join(HOME, "Pictures", NAME);

// ---------------------------------------------------------------------------------------------
// The Keychain: optional keys (Unsplash for photo search, Figma token, collaboration session token),
// handed to the engine as environment variables and never shown to the page. Kept where the Swift
// app kept them (service "<name>.AI"), through macOS's own `security` tool.

const SERVICE = `${NAME}.AI`;
function security(args) {
  return new Promise((done) => execFile("/usr/bin/security", args, { timeout: 8000 }, (err, out) => done(err ? null : out)));
}
async function loadKey(account) {
  if (NO_KEYCHAIN) return null;
  const out = await security(["find-generic-password", "-s", SERVICE, "-a", account, "-w"]);
  const key = out?.trim();
  return key || null;
}
async function saveKey(account, key) {
  if (NO_KEYCHAIN) return;
  const v = (key ?? "").trim();
  if (!v) return void (await security(["delete-generic-password", "-s", SERVICE, "-a", account]));
  // The key goes to `security` on its standard input (its -i mode), never on a command line, where
  // other programs on this Mac could read it for a moment.
  const quote = (x) => `"${String(x).replace(/["\\]/g, "\\$&")}"`;
  if (/[\r\n]/.test(v)) throw new Error("A key can't have line breaks in it.");
  const ok = await new Promise((done) => {
    const p = spawn("/usr/bin/security", ["-i"], { stdio: ["pipe", "ignore", "ignore"] });
    const timer = setTimeout(() => (p.kill(), done(false)), 8000);
    p.on("error", () => (clearTimeout(timer), done(false)));
    p.on("close", (code) => (clearTimeout(timer), done(code === 0)));
    p.stdin.end(`add-generic-password -U -s ${quote(SERVICE)} -a ${quote(account)} -w ${quote(v)}\n`);
  });
  if (!ok || (await loadKey(account)) !== v) throw new Error("Keychain couldn't save the key.");
}
async function savedKeys() {
  const [unsplash, figma, cloud] = await Promise.all([loadKey("unsplash"), loadKey("figma"), loadKey("cloud")]);
  return { unsplash, figma, cloud };
}

// ---------------------------------------------------------------------------------------------
// The shell's environment: apps opened from Finder don't get the person's shell setup, so PATH,
// API keys and tools (claude, codex) are read from a login shell once.

const MARK = "__SCREENSHOTTER_ENV__";
function shellEnvironment(timeout = 6000) {
  if (process.env.SCREENSHOTTER_NO_SHELL_ENV) return Promise.resolve({ ...process.env });
  const shellPath = process.env.SHELL && existsSync(process.env.SHELL) ? process.env.SHELL : "/bin/zsh";
  return new Promise((done) => {
    let out = "";
    const p = spawn(shellPath, ["-l", "-i", "-c", `printf '\\n${MARK}\\n'; /usr/bin/env -0`], { env: { ...process.env, SCREENSHOTTER_RESOLVING_ENV: "1" }, stdio: ["ignore", "pipe", "ignore"] });
    const timer = setTimeout(() => (p.kill(), done({ ...process.env })), timeout);
    p.stdout.on("data", (d) => (out += d));
    p.on("error", () => (clearTimeout(timer), done({ ...process.env })));
    p.on("close", () => {
      clearTimeout(timer);
      const at = out.indexOf(`\n${MARK}\n`);
      if (at < 0) return done({ ...process.env });
      const env = {};
      for (const entry of out.slice(at + MARK.length + 2).split("\0")) {
        const eq = entry.indexOf("=");
        if (eq > 0 && !entry.slice(0, eq).includes("\n")) env[entry.slice(0, eq)] = entry.slice(eq + 1);
      }
      delete env.SCREENSHOTTER_RESOLVING_ENV;
      done({ ...process.env, ...env });
    });
  });
}

// ---------------------------------------------------------------------------------------------
// The engine, on a free localhost port. Its stdin is a pipe nobody writes to: when the app goes,
// the pipe closes and the engine follows (--watch-stdin), so no server is left behind.

const engine = { state: "idle", url: null, reason: "", child: null, gen: 0, env: {} };
/** Read once, when the engine first starts (never for `<app> mcp`). */
let shellEnv = null;

async function startEngine() {
  stopEngine();
  const gen = ++engine.gen;
  setEngine("starting");
  const base = await (shellEnv ??= shellEnvironment());
  if (gen !== engine.gen) return;
  const entry = path.join(ENGINE_ROOT, "dist", "index.js");
  if (!existsSync(entry)) return setEngine("failed", `${NAME}'s engine is missing from the app (${entry}). Build it with npm run build.`);
  const keys = await savedKeys();
  const env = { ...base, ELECTRON_RUN_AS_NODE: "1", SCREENSHOTTER_OUTPUT_DIR: outputFolder(), SCREENSHOTTER_APP: "1", SCREENSHOTTER_APP_NAME: NAME };
  // A library for tests and benchmarks, set from outside, wins over the app's own.
  env.SCREENSHOTTER_STUDIO_FILE = process.env.SCREENSHOTTER_STUDIO_FILE || STUDIO_FILE;
  if (process.env.SCREENSHOTTER_OUTPUT_DIR && !settings().outputFolder) env.SCREENSHOTTER_OUTPUT_DIR = process.env.SCREENSHOTTER_OUTPUT_DIR;
  if (keys.unsplash) env.UNSPLASH_ACCESS_KEY = keys.unsplash;
  if (keys.figma) env.FIGMA_TOKEN = keys.figma;
  if (keys.cloud) env.GLASSINE_AUTH_TOKEN = keys.cloud;
  // Tools the engine starts (agents, a browser for exports) find Homebrew's too.
  env.PATH = [...new Set(["/opt/homebrew/bin", "/usr/local/bin", ...(env.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin").split(":")])].join(":");
  delete env.SCREENSHOTTER_STUDIO_PORT;
  engine.env = env;
  mkdirSync(path.dirname(LOG), { recursive: true });
  const log = createWriteStream(LOG);
  log.write(`— ${new Date().toISOString()} · Node ${process.versions.node} (Electron ${process.versions.electron})\n`);
  const child = spawn(process.execPath, [entry, "studio", "--port", "0", "--no-open", "--watch-stdin"], { cwd: ENGINE_ROOT, env, stdio: ["pipe", "ignore", "pipe"] });
  engine.child = child;
  let recent = "";
  child.stderr.on("data", (d) => {
    log.write(d);
    if (gen !== engine.gen) return;
    recent = (recent + d).slice(-8000);
    const port = /SCREENSHOTTER_STUDIO_PORT=(\d+)/.exec(recent)?.[1];
    if (engine.state === "starting" && port) setEngine("running", "", `http://127.0.0.1:${port}/`);
  });
  child.on("exit", (code) => {
    log.end();
    if (gen !== engine.gen) return;
    engine.child = null;
    const tail = recent.split("\n").filter(Boolean).slice(-6).join("\n");
    setEngine("failed", `The engine stopped (exit ${code}).${tail ? `\n\n${tail}` : ""}`);
  });
  child.on("error", (e) => gen === engine.gen && setEngine("failed", `Couldn't start the engine: ${e.message}`));
  setTimeout(() => {
    if (gen !== engine.gen || engine.state !== "starting") return;
    stopEngine();
    setEngine("failed", `The engine didn't start within 45 seconds. See ~/Library/Logs/${NAME}/engine.log.`);
  }, 45_000);
}

function stopEngine() {
  engine.gen++;
  const c = engine.child;
  if (c) {
    c.removeAllListeners("exit");
    c.stdin?.end();
    c.kill("SIGTERM");
    setTimeout(() => c.exitCode === null && c.kill("SIGKILL"), 3000);
  }
  engine.child = null;
  if (engine.state === "running") engine.state = "idle";
}

let restartTimer = 0;
const restartSoon = () => (clearTimeout(restartTimer), (restartTimer = setTimeout(startEngine, 350)));

function setEngine(state, reason = "", url = null) {
  Object.assign(engine, { state, reason, url });
  if (!win) return;
  pageReady = false;
  if (state === "running") win.loadURL(url);
  else win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(statusPage())}`);
}

// ---------------------------------------------------------------------------------------------
// The window

/** @type {BrowserWindow | null} */
let win = null;
/** The Studio (not the status page) has loaded: files opened meanwhile wait for it. */
let pageReady = false;
let pendingOpen = [];

const windowColour = () => (nativeTheme.shouldUseDarkColors ? "#0b0b0d" : "#e7e7ea");

function makeWindow() {
  const saved = settings().bounds;
  const onScreen = saved && screen.getAllDisplays().some((d) => saved.x < d.workArea.x + d.workArea.width && saved.x + saved.width > d.workArea.x && saved.y < d.workArea.y + d.workArea.height && saved.y + saved.height > d.workArea.y);
  win = new BrowserWindow({
    ...(onScreen ? saved : { width: 1360, height: 880 }),
    minWidth: 1040,
    minHeight: 660,
    title: NAME,
    show: false,
    // No title bar of its own: the traffic lights sit in the middle of the Studio's 52 pt top bar.
    titleBarStyle: "hidden",
    trafficLightPosition: { x: 20, y: Math.round((TOP_BAR - 14) / 2) },
    backgroundColor: windowColour(),
    fullscreenable: true,
    webPreferences: {
      preload: path.join(here, "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      // As the Swift app's web view: nothing kept between launches but what the engine keeps.
      partition: "studio",
      spellcheck: true,
      // A board's videos play when asked, without a click on the page first.
      autoplayPolicy: "no-user-gesture-required",
      // The canvas keeps drawing (agents' changes, shaders) while the window is behind another.
      backgroundThrottling: false,
    },
  });
  // A benchmark's window shows without taking the focus from whatever the person is doing.
  win.once("ready-to-show", () => (process.env.GLASSINE_BACKGROUND ? win?.showInactive() : win?.show()));
  // Pinching zooms the board (the page's own ctrl+wheel), never the whole window's page.
  win.webContents.setVisualZoomLevelLimits(1, 1);
  const keepBounds = () => win && !win.isFullScreen() && !win.isMinimized() && saveSettings({ bounds: win.getBounds() });
  win.on("resized", keepBounds);
  win.on("moved", keepBounds);
  // Closing the window keeps the app (and its engine) running; the Dock icon brings it back.
  win.on("close", (e) => {
    if (quitting) return;
    e.preventDefault();
    win.hide();
  });
  win.on("enter-full-screen", () => win.webContents.executeJavaScript("document.documentElement.classList.toggle('fullscreen', true)").catch(() => {}));
  win.on("leave-full-screen", () => win.webContents.executeJavaScript("document.documentElement.classList.toggle('fullscreen', false)").catch(() => {}));

  const wc = win.webContents;
  wc.on("did-finish-load", () => {
    if (!engine.url || !wc.getURL().startsWith(engine.url)) return;
    pageReady = true;
    if (pendingOpen.length) upload(pendingOpen.splice(0));
  });
  // The app stays on the engine; every other link opens in the person's browser.
  wc.on("will-navigate", (e, url) => {
    if (/^(about|data):/.test(url) || (engine.url && url.startsWith(engine.url))) return;
    e.preventDefault();
    shell.openExternal(url);
  });
  wc.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });
  // The page's renderer gone (a crash): the page loads again.
  wc.on("render-process-gone", () => {
    pageReady = false;
    if (engine.url) win.loadURL(engine.url);
  });
  // Text fields get the system's text menu (the page draws its own everywhere else).
  wc.on("context-menu", (_e, p) => {
    if (!p.isEditable && !p.selectionText) return;
    const items = [];
    for (const s of p.dictionarySuggestions ?? []) items.push({ label: s, click: () => wc.replaceMisspelling(s) });
    if (p.misspelledWord) items.push({ label: "Learn Spelling", click: () => wc.session.addWordToSpellCheckerDictionary(p.misspelledWord) }, { type: "separator" });
    if (p.isEditable) items.push({ role: "cut", enabled: p.editFlags.canCut }, { role: "copy", enabled: p.editFlags.canCopy }, { role: "paste", enabled: p.editFlags.canPaste }, { role: "selectAll" });
    else items.push({ role: "copy" });
    if (p.selectionText) items.push({ type: "separator" }, { label: `Look Up “${p.selectionText.slice(0, 24)}”`, click: () => wc.showDefinitionForSelection() });
    Menu.buildFromTemplate(items).popup({ window: win });
  });
  setEngine(engine.state, engine.reason, engine.url);
}

function showStudio() {
  if (!win) makeWindow();
  win.show();
  win.focus();
}

// ---------------------------------------------------------------------------------------------
// The page's native calls (store.js `native.call`)

const command = (name, arg) => win?.webContents.executeJavaScript(`window.studio && window.studio.command(${JSON.stringify(name)}${arg === undefined ? "" : `, ${JSON.stringify(arg)}`})`).catch(() => undefined);

const calls = {
  // The window is dragged by the page's own top bar (-webkit-app-region in styles.css).
  dragRegions: () => true,
  setTheme: ({ theme }) => {
    const t = theme === "light" || theme === "dark" ? theme : "system";
    saveSettings({ theme: t });
    nativeTheme.themeSource = t;
    return true;
  },
  getSettings: async () => {
    const keys = await savedKeys();
    return {
      hasUnsplashKey: Boolean(keys.unsplash),
      hasFigmaToken: Boolean(keys.figma),
      hasCloudToken: Boolean(keys.cloud),
      outputFolder: outputFolder(),
      version: app.getVersion(),
      node: `v${process.versions.node}`,
      nodePath: process.execPath,
    };
  },
  // An empty key removes the saved one. The engine restarts to pick it up.
  setUnsplashKey: async ({ key }) => (await saveKey("unsplash", key), restartSoon(), true),
  // No restart: the page hands the token to the running engine itself (an import may be under way).
  setFigmaToken: async ({ key }) => (await saveKey("figma", key), true),
  // Collaboration session token: kept in Keychain so it survives restarts without restarting the engine now.
  setCloudToken: async ({ key }) => (await saveKey("cloud", key), true),
  chooseOutputFolder: async () => {
    const r = await dialog.showOpenDialog(win, { properties: ["openDirectory", "createDirectory"], buttonLabel: "Use Folder", message: "Imports and exports will be saved here.", defaultPath: outputFolder() });
    if (r.canceled || !r.filePaths[0]) return { path: null };
    saveSettings({ outputFolder: r.filePaths[0] });
    restartSoon();
    return { path: r.filePaths[0] };
  },
  openURL: ({ url }) => (/^(https?|mailto):/i.test(url ?? "") && shell.openExternal(url), true),
  copyFile: ({ path: p }) => {
    if (!p || !existsSync(p)) return { error: "The file isn't there any more." };
    const image = nativeImage.createFromPath(p);
    // A picture is copied as one (it pastes as a picture anywhere); anything else as the file.
    if (!image.isEmpty()) clipboard.writeImage(image);
    else clipboard.writeBuffer("public.file-url", Buffer.from(`file://${encodeURI(p)}`));
    return true;
  },
  copyText: ({ text }) => (clipboard.writeText(text ?? ""), true),
  readText: () => ({ text: clipboard.readText() }),
  restartEngine: () => (restartSoon(), true),
  // Electron carries its own Node: there's none to choose.
  chooseNode: () => true,
  choosePaths: async ({ message }) => {
    const r = await dialog.showOpenDialog(win, { properties: ["openFile", "openDirectory", "multiSelections"], buttonLabel: "Add", message: message ?? "" });
    return { paths: r.canceled ? [] : r.filePaths };
  },
  showLog: () => (shell.showItemInFolder(LOG), true),
};

ipcMain.handle("native", async (e, msg) => {
  // Only the app's own pages: the Studio, or the status page.
  const url = e.senderFrame?.url ?? "";
  if (!(url.startsWith("data:") || (engine.url && url.startsWith(engine.url)))) return { error: "Not allowed here." };
  const fn = calls[msg?.cmd];
  if (!fn) return { error: `Unknown command ${msg?.cmd}` };
  try {
    return await fn(msg);
  } catch (err) {
    return { error: err?.message ?? String(err) };
  }
});

// ---------------------------------------------------------------------------------------------
// Files: opened with the app (Finder, the Dock icon), pasted from another app, or chosen

const IMPORTABLE = /\.(png|jpe?g|webp|tiff?|heic|svg|gif|mp4|m4v|mov)$/i;
const IS_FIG = /\.fig$/i;

async function importFig(p) {
  try {
    const data = await readFile(p);
    command("importFigBytes", { name: path.basename(p), data: data.toString("base64") });
  } catch {
    command("error", `Couldn't open ${path.basename(p)}: it isn't there any more, or ${NAME} isn't allowed to open it.`);
  }
}

async function upload(paths) {
  if (!engine.url) return;
  // Figma files go to the page, which brings their frames in (onto this board, or a new one).
  for (const p of paths.filter((f) => IS_FIG.test(f))) void importFig(p);
  const rest = paths.filter((f) => !IS_FIG.test(f));
  const takes = rest.filter((p) => IMPORTABLE.test(p));
  const refused = rest.filter((p) => !IMPORTABLE.test(p)).map((p) => path.basename(p));
  const items = [];
  const problems = refused.length ? [`Couldn't add ${refused.join(", ")}. ${NAME} adds pictures (PNG, JPEG, WebP, TIFF, HEIC, SVG, GIF), videos (MP4, MOV) and Figma files (.fig).`] : [];
  for (const p of takes) {
    try {
      let name = path.basename(p);
      let body;
      if (/\.(tiff?|heic)$/i.test(p)) {
        // The engine takes PNG, JPEG and WebP: TIFF and HEIC become PNG first.
        const img = nativeImage.createFromPath(p);
        if (img.isEmpty()) throw new Error(`It isn't a picture ${NAME} can read.`);
        body = img.toPNG();
        name = name.replace(/\.[^.]+$/, ".png");
      } else {
        statSync(p);
        body = createReadStream(p);
      }
      items.push(await post(name, body));
    } catch (e) {
      const why = e?.message ?? String(e);
      problems.push(`Couldn't add ${path.basename(p)}. ${why}${why.endsWith(".") ? "" : "."}`);
    }
  }
  if (items.length) command("imported", items);
  if (problems.length) command("error", problems.join(" "));
}

async function post(name, body) {
  const res = await fetch(`${engine.url}api/upload?name=${encodeURIComponent(name)}`, { method: "POST", headers: { "x-screenshotter": "studio" }, body, duplex: "half" });
  const json = await res.json().catch(() => null);
  if (json && typeof json.path === "string") return json;
  throw new Error(json?.error ?? "The engine didn't take it. Try again.");
}

/** ⌘V: Figma designs, pictures and files on the clipboard go onto the board; text goes where it always does. */
async function paste() {
  const wc = win?.webContents;
  if (!wc) return;
  // Frames copied in Figma carry their design data inside HTML.
  const html = clipboard.readHTML();
  if (html && html.includes("(figma)")) {
    const typing = await wc.executeJavaScript("Boolean(window.studio && window.studio.isTyping())").catch(() => false);
    if (!typing) {
      command("pasteFigma", html);
      return;
    }
    return wc.paste();
  }
  const files = clipboardFiles();
  const image = files.length ? null : clipboard.readImage();
  const hasImport = files.some((f) => IMPORTABLE.test(f) || IS_FIG.test(f)) || (image && !image.isEmpty());
  if (hasImport) {
    const typing = await wc.executeJavaScript("Boolean(window.studio && window.studio.isTyping())").catch(() => false);
    if (!(typing && clipboard.readText())) {
      if (files.length) return upload(files);
      if (!engine.url) return;
      try {
        command("imported", [await post("pasted.png", image.toPNG())]);
      } catch (e) {
        command("error", `Couldn't add the picture. ${e.message}`);
      }
      return;
    }
  }
  wc.paste();
}

/** Files copied in Finder (or another app), as paths. */
function clipboardFiles() {
  const out = [];
  for (const format of clipboard.availableFormats()) if (format === "text/uri-list") for (const u of clipboard.read("text/uri-list").split(/\r?\n/)) if (u.startsWith("file://")) out.push(decodeURI(u.slice(7)));
  if (!out.length) {
    const one = clipboard.read("public.file-url");
    if (one.startsWith("file://")) out.push(decodeURI(new URL(one).pathname));
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Updates: Electron's own updater (Squirrel.Mac) reads the site's feed (desktop-feed.json, written by
// scripts/release-feed.mjs), once at launch, once a day, and on Check for Updates…; a new version
// is downloaded, checked against this app's signature, and installed when the app next quits (or
// at once, if the person says so). Only the main app updates itself, as with Sparkle: a separate
// copy (another name) doesn't, unless SCREENSHOTTER_FEED_URL names a feed.

const FEED = process.env.SCREENSHOTTER_FEED_URL || (NAME === "Screenshotter" ? "https://screenshotter-umber.vercel.app/desktop-feed.json" : "");
const updates = { on: false, asked: false, ready: null };

function setUpUpdates() {
  if (!app.isPackaged || !FEED) return;
  try {
    autoUpdater.setFeedURL({ url: FEED, serverType: "json" });
  } catch {
    return; // an unsigned build can't update itself
  }
  updates.on = true;
  autoUpdater.on("update-downloaded", (_e, notes, name) => {
    updates.ready = name || "a new version";
    const answer = dialog.showMessageBoxSync(win ?? undefined, { type: "info", message: `${NAME} ${updates.ready} is ready`, detail: "It's installed when you next quit. Restart now to use it?", buttons: ["Restart Now", "Later"], defaultId: 0, cancelId: 1 });
    if (answer === 0) {
      quitting = true;
      autoUpdater.quitAndInstall();
    }
  });
  autoUpdater.on("update-not-available", () => {
    if (!updates.asked) return;
    updates.asked = false;
    dialog.showMessageBox(win ?? undefined, { type: "info", message: `You're up to date`, detail: `${NAME} ${app.getVersion()} is the newest version.` });
  });
  autoUpdater.on("error", (e) => {
    if (!updates.asked) return;
    updates.asked = false;
    dialog.showMessageBox(win ?? undefined, { type: "warning", message: "Couldn't check for updates", detail: e?.message ?? String(e) });
  });
  autoUpdater.checkForUpdates();
  setInterval(() => autoUpdater.checkForUpdates(), 24 * 60 * 60 * 1000);
}

function checkForUpdates() {
  if (!updates.on) return dialog.showMessageBox(win ?? undefined, { type: "info", message: "Updates are off in this copy", detail: app.isPackaged ? `${NAME} isn't the main app, so it doesn't update itself.` : "A copy run from the checkout updates with git." });
  if (updates.ready) return autoUpdater.quitAndInstall();
  updates.asked = true;
  autoUpdater.checkForUpdates();
}

// ---------------------------------------------------------------------------------------------
// Menus

function buildMenu() {
  const item = (label, name, accelerator) => ({ label, accelerator, click: () => command(name) });
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: NAME,
        submenu: [
          { role: "about", label: `About ${NAME}` },
          { label: "Check for Updates…", click: () => checkForUpdates() },
          { type: "separator" },
          item("Settings…", "settings", "Cmd+,"),
          { type: "separator" },
          { role: "hide", label: `Hide ${NAME}` },
          { role: "hideOthers" },
          { role: "unhide" },
          { type: "separator" },
          { role: "quit", label: `Quit ${NAME}` },
        ],
      },
      {
        label: "File",
        submenu: [
          item("New Board", "newBoard", "Cmd+N"),
          item("All Boards", "boards", "Cmd+Shift+O"),
          item("Save", "save", "Cmd+S"),
          { type: "separator" },
          item("Import Website…", "importWebsite", "Cmd+Shift+I"),
          item("Import from Figma…", "importFigma", "Cmd+Shift+F"),
          {
            label: "Import Images…",
            accelerator: "Cmd+O",
            click: async () => {
              const r = await dialog.showOpenDialog(win, { properties: ["openFile", "multiSelections"], message: "Choose images, videos or Figma files to add to the board.", filters: [{ name: "Images, videos and Figma files", extensions: ["png", "jpg", "jpeg", "webp", "tif", "tiff", "heic", "svg", "gif", "mp4", "m4v", "mov", "fig"] }] });
              if (!r.canceled) upload(r.filePaths);
            },
          },
          { type: "separator" },
          item("Export Image", "exportImage", "Cmd+E"),
          { type: "separator" },
          { label: "Show Library in Finder", click: () => (mkdirSync(outputFolder(), { recursive: true }), shell.openPath(outputFolder())) },
          { label: "Restart Engine", click: () => startEngine() },
          { type: "separator" },
          { role: "close", label: "Close Window" },
        ],
      },
      {
        label: "Edit",
        submenu: [
          // The page's own undo (a text field being typed in keeps its own: see the page's commands).
          item("Undo", "undo", "Cmd+Z"),
          item("Redo", "redo", "Cmd+Shift+Z"),
          { type: "separator" },
          { role: "cut" },
          { role: "copy" },
          { label: "Paste", accelerator: "Cmd+V", click: () => paste() },
          { role: "selectAll" },
          { type: "separator" },
          item("Duplicate", "duplicate", "Cmd+D"),
          item("Use as Mask", "mask", "Cmd+Ctrl+M"),
        ],
      },
      {
        label: "View",
        submenu: [
          item("Zoom In", "zoomIn", "Cmd+="),
          item("Zoom Out", "zoomOut", "Cmd+-"),
          item("Zoom to Fit", "fit", "Cmd+0"),
          { type: "separator" },
          item("Show or Hide the Left Panel", "toggleLeft", "Cmd+Alt+S"),
          item("Show or Hide the Right Panel", "toggleRight", "Cmd+Alt+I"),
          item("Focus Mode", "focus", "Cmd+\\"),
          { type: "separator" },
          { label: "Reload Interface", accelerator: "Cmd+Alt+Shift+R", click: () => win?.webContents.reload() },
          { role: "toggleDevTools", accelerator: "Cmd+Alt+Shift+I" },
          { role: "togglefullscreen", label: "Enter Full Screen", accelerator: "Cmd+Ctrl+F" },
        ],
      },
      { role: "windowMenu", submenu: [{ role: "minimize" }, { role: "zoom" }, { type: "separator" }, { label: NAME, click: () => showStudio() }] },
      { role: "help", submenu: [item("Chat with an Agent", "connect", "Cmd+J")] },
    ]),
  );
}

// ---------------------------------------------------------------------------------------------
// The page shown while the engine starts, or when it can't

const escapeHtml = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
function statusPage() {
  const failed = engine.state === "failed";
  const title = failed ? "The engine didn't start" : `Starting ${NAME}`;
  const body = failed ? escapeHtml(engine.reason).replace(/\n/g, "<br>") : "Warming up the engine…";
  const actions = failed ? `<button class="primary" onclick="post('restartEngine')">Try again</button><button onclick="post('showLog')">Show log</button>` : "";
  return `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;height:100%;background:#0b0b0d;color:#f4f4f5;font:13px/1.5 -apple-system,system-ui,sans-serif;-webkit-user-select:none;cursor:default}
body{-webkit-app-region:drag}
.wrap{height:100%;display:grid;place-items:center;text-align:center;padding:40px}
.card{max-width:460px;display:flex;flex-direction:column;align-items:center;gap:14px}
h1{margin:0;font:400 30px "New York",ui-serif,Georgia,serif;letter-spacing:-.02em}
p{margin:0;color:#8b8b94}
.ring{width:30px;height:30px;border-radius:50%;box-sizing:border-box;border:2.5px solid rgba(255,255,255,.1);border-top-color:#d2ff4d;animation:spin .8s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
.row{display:flex;gap:8px;margin-top:6px}
button{-webkit-app-region:no-drag;height:34px;padding:0 14px;border-radius:9px;border:0;background:#1c1c20;color:#f4f4f5;font:600 12.5px -apple-system,system-ui;box-shadow:inset 0 0 0 1px rgba(255,255,255,.1)}
button:hover{background:#26262b}
button.primary{background:#d2ff4d;color:#0d1100;box-shadow:none}
</style></head><body><div class="wrap"><div class="card">${failed ? "" : "<div class='ring'></div>"}<h1>${title}</h1><p>${body}</p><div class="row">${actions}</div></div></div>
<script>function post(cmd, extra){ return window.glassine.native.postMessage(Object.assign({cmd}, extra||{})); }</script></body></html>`;
}

// ---------------------------------------------------------------------------------------------
// The app

let quitting = false;
let flushed = false;

function main() {
  // One copy at a time (two would each start an engine): a second one brings this one forward.
  if (!app.requestSingleInstanceLock()) return app.quit();
  app.on("second-instance", () => showStudio());
  // Files opened with the app can arrive before the engine and the page are up: they wait.
  app.on("open-file", (e, file) => {
    e.preventDefault();
    if (pageReady) upload([file]);
    else pendingOpen.push(file);
    if (app.isReady()) showStudio();
  });
  app.on("activate", () => showStudio());
  // Before quitting, the page gets a moment to save an edit it hasn't written yet (it saves half a
  // second after each change), never more than 1.5 s.
  app.on("before-quit", (e) => {
    if (flushed || !pageReady || !win) return void (quitting = true);
    e.preventDefault();
    quitting = true;
    const done = () => {
      if (flushed) return;
      flushed = true;
      app.quit();
    };
    win.webContents.executeJavaScript("Promise.resolve(window.studio?.command('flush'))").then(done, done);
    setTimeout(done, 1500);
  });
  app.on("will-quit", () => stopEngine());
  app.whenReady().then(() => {
    nativeTheme.themeSource = settings().theme ?? "system";
    nativeTheme.on("updated", () => win?.setBackgroundColor(windowColour()));
    app.setAboutPanelOptions({ applicationName: NAME, applicationVersion: app.getVersion(), copyright: `${NAME} — design with your agent.` });
    buildMenu();
    makeWindow();
    startEngine();
    setUpUpdates();
  });
}

// The app, or (`<app> mcp`) its MCP server for agents.
if (process.argv.includes("mcp")) mcp();
else main();
