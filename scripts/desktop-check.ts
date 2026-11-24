/**
 * The desktop app (Electron, desktop/main.js) as people get it, on a throwaway library: it starts
 * its engine and shows the Studio, the page's native calls answer, the top bar drags the window,
 * the menus hold Edit's text commands, a board opens and draws, quitting waits for the page, and
 * `<app> mcp` serves MCP on stdin/stdout. It never touches your library, settings or Keychain.
 *
 *   npx tsx scripts/desktop-check.ts            the app from this checkout (electron desktop/main.js)
 *   npx tsx scripts/desktop-check.ts --app      the built one, build/<name>.app (npm run desktop:build)
 *   DESKTOP_SHOT=<file.png>                     a picture of the window, to look at
 *
 * Its window shows on your screen for a few seconds, without taking the focus.
 */
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { _electron } from "playwright";

const ROOT = path.resolve(import.meta.dirname, "..");
const NAME = process.env.SCREENSHOTTER_APP_NAME || "Screenshotter";
const BUILT = process.argv.includes("--app");
const exe = BUILT ? path.join(ROOT, "build", `${NAME}.app`, "Contents", "MacOS", NAME) : path.join(ROOT, "node_modules", "electron", "dist", "Electron.app", "Contents", "MacOS", "Electron");
const appArgs = BUILT ? [] : [path.join(ROOT, "desktop", "main.js")];
if (!existsSync(exe)) throw new Error(`${exe} isn't there: ${BUILT ? "npm run desktop:build" : "npm install"} first`);

const tmp = mkdtempSync(path.join(os.tmpdir(), "glassine-desktop-check-"));
const LIB = path.join(tmp, "library");
mkdirSync(path.join(LIB, "images"), { recursive: true });
writeFileSync(path.join(tmp, "studio.json"), JSON.stringify({ folder: LIB }));
const ENV: Record<string, string> = {
  SCREENSHOTTER_OUTPUT_DIR: LIB,
  SCREENSHOTTER_STUDIO_FILE: path.join(tmp, "studio.json"),
  SCREENSHOTTER_SEEN_FILE: path.join(tmp, "seen.json"),
  SCREENSHOTTER_STYLE_FILE: path.join(tmp, "style.json"),
  SCREENSHOTTER_CACHE_DIR: path.join(tmp, "cache"),
  SCREENSHOTTER_AGENTMAN_SOCKET: path.join(tmp, "none.sock"),
  SCREENSHOTTER_NO_KEYCHAIN: "1",
  // The shell is what's checked here; signing in has its own check in the UI's tests.
  SCREENSHOTTER_NO_ACCOUNT: "1",
  SCREENSHOTTER_NO_SHELL_ENV: "1",
  SCREENSHOTTER_APP_NAME: "Glassine Check",
  GLASSINE_USER_DATA: path.join(tmp, "user-data"),
  GLASSINE_LOG_DIR: path.join(tmp, "logs"),
  GLASSINE_BACKGROUND: "1",
};
Object.assign(process.env, ENV);
const boards = await import("../src/board/store.js");
const core = await import("../src/board/core.js");
const b = boards.createBoard("Desktop check", "studio");
boards.changeBoard(b.id, core.addHtmlOps(`<div data-name="Phone" style="width:390px;height:844px;background:#f6f5f2;padding:40px;display:flex;flex-direction:column;gap:12px"><h1 style="margin:0;font-size:28px">Hello</h1><div data-name="Card" style="height:120px;border-radius:16px;background:linear-gradient(135deg,#6e6ef5,#4f46e5)"></div></div>`, null, { page: b.pages[0].id }).ops, "studio");

let failed = 0;
const check = async (title: string, fn: () => Promise<string | true>) => {
  let r: string | true;
  try {
    r = await fn();
  } catch (e) {
    r = `threw: ${(e as Error).message.split("\n")[0]}`;
  }
  if (r !== true) failed++;
  console.log(`${r === true ? "PASS" : "FAIL"} ${title}${r === true ? "" : ` — ${r}`}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const app = await _electron.launch({ executablePath: exe, args: appArgs, env: { ...process.env, ...ENV } as Record<string, string> });
const errors: string[] = [];
try {
  const page = await app.firstWindow();
  page.on("pageerror", (e) => errors.push(e.message));
  // tsx names inner functions with a helper neither the page nor Electron's main process has.
  const NAME_HELPER = "globalThis.__name = globalThis.__name || ((f) => f)";
  await page.context().addInitScript(NAME_HELPER);
  await app.evaluate(NAME_HELPER as never);

  await check("it starts its engine and shows the Studio", async () => {
    for (let i = 0; i < 300 && !/^http:\/\/127\.0\.0\.1:\d+\//.test(page.url()); i++) await sleep(100);
    if (!page.url().startsWith("http://127.0.0.1:")) return `still on ${page.url().slice(0, 60)}`;
    await page.waitForFunction(() => Boolean(document.querySelector("#root") && (window as unknown as { studio?: unknown }).studio), undefined, { timeout: 15000 });
    await page.evaluate("globalThis.__name = globalThis.__name || ((f) => f)");
    return true;
  });

  await check("the page has the desktop bridge, and nothing else of Electron or Node", async () => {
    const r = await page.evaluate(() => ({ bridge: typeof (window as unknown as { glassine?: { native?: unknown } }).glassine?.native, cls: document.documentElement.classList.contains("electron") && document.documentElement.classList.contains("native"), node: typeof (window as unknown as { require?: unknown }).require, proc: typeof (window as unknown as { process?: unknown }).process }));
    return r.bridge === "object" && r.cls && r.node === "undefined" && r.proc === "undefined" ? true : JSON.stringify(r);
  });

  await check("native calls answer: settings, theme, cloud token, text on the clipboard's way", async () => {
    const r = await page.evaluate(async () => {
      const { native } = await import("/ui/store.js" as string);
      const s = await native.call("getSettings");
      await native.call("setTheme", { theme: "dark" });
      await native.call("setCloudToken", { key: "" });
      let unknown = "";
      try {
        await native.call("noSuchCall");
      } catch (e) {
        unknown = (e as Error).message;
      }
      return { s, unknown };
    });
    const theme = await app.evaluate(({ nativeTheme }) => nativeTheme.themeSource);
    if (r.s.outputFolder !== LIB) return `library ${r.s.outputFolder} (wanted the check's own)`;
    if (!r.s.version || !String(r.s.node).startsWith("v") || typeof r.s.hasCloudToken !== "boolean") return `settings ${JSON.stringify(r.s)}`;
    if (theme !== "dark") return `theme ${theme}`;
    return /Unknown command/.test(r.unknown) ? true : `unknown call answered "${r.unknown}"`;
  });

  await check("a board opens and draws its layers", async () => {
    await page.evaluate(async (id: string) => (await import("/ui/board-state.js" as string)).openBoard(id), b.id);
    await page.waitForSelector(".bd-world [data-bid]", { timeout: 10000 });
    await sleep(600);
    const drawn = await page.evaluate(() => document.querySelectorAll(".bd-world [data-bid]").length);
    return drawn >= 3 ? true : `${drawn} layers drawn`;
  });

  await check("the top bar drags the window; its buttons and fields don't", async () => {
    const r = await page.evaluate(() => {
      const bar = document.querySelector("[data-drag]") as HTMLElement | null;
      const btn = bar?.querySelector("button") as HTMLElement | null;
      const region = (el: Element | null) => (el ? getComputedStyle(el).getPropertyValue("-webkit-app-region") || getComputedStyle(el).getPropertyValue("app-region") : "none");
      return { bar: region(bar), btn: region(btn) };
    });
    return r.bar === "drag" && r.btn === "no-drag" ? true : JSON.stringify(r);
  });

  await check("in full screen the top bar takes back the traffic lights' room, and gives it up again", async () => {
    // The window isn't really sent full screen (that would take over the screen): the window's own
    // events are raised, which is what the app listens to.
    const inset = () => page.evaluate(() => parseFloat(getComputedStyle(document.querySelector(".topbar")!).paddingLeft));
    const before = await inset();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].emit("enter-full-screen"));
    await sleep(250);
    const full = await inset();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].emit("leave-full-screen"));
    await sleep(250);
    const after = await inset();
    return before >= 70 && full <= 16 && after === before ? true : `the bar starts ${before}px in, ${full}px in full screen, ${after}px after`;
  });

  await check("the window: traffic lights in the top bar, the window's colour, at least 1040 × 660", async () => {
    const r = await app.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows()[0];
      return { min: w.getMinimumSize(), lights: w.getWindowButtonPosition?.() ?? null, bg: w.getBackgroundColor() };
    });
    if (r.min[0] !== 1040 || r.min[1] !== 660) return `minimum ${r.min}`;
    if (!r.lights || r.lights.x !== 20 || r.lights.y < 10 || r.lights.y > 22) return `traffic lights at ${JSON.stringify(r.lights)}`;
    return /^#1e1e1e|^#efeff1/i.test(r.bg) ? true : `background ${r.bg}`;
  });

  await check("the menus: Edit has the text commands, View zooms the board, not the page", async () => {
    const r = await app.evaluate(({ Menu }) => {
      const m = Menu.getApplicationMenu();
      const sub = (label: string) => m?.items.find((i) => i.label === label)?.submenu?.items.map((i) => i.role || i.label) ?? [];
      return { edit: sub("Edit"), view: sub("View"), file: sub("File") };
    });
    const want = ["cut", "copy", "Paste", "selectall"];
    const missing = want.filter((w) => !r.edit.map((x) => String(x).toLowerCase()).includes(w.toLowerCase()));
    if (missing.length) return `Edit lacks ${missing.join(", ")}: ${r.edit.join(", ")}`;
    if (r.view.some((x) => /^(zoomin|zoomout|resetzoom)$/i.test(String(x)))) return `View has the page's own zoom: ${r.view.join(", ")}`;
    return r.file.includes("Import Images…") ? true : `File: ${r.file.join(", ")}`;
  });

  await check("Edit → Paste works in text inputs, copies & pastes board frames, and native copyText/readText answer", async () => {
    const clip = await page.evaluate(async () => {
      const { native } = await import("/ui/store.js" as string);
      await native.call("copyText", { text: "GlassinePasteOK" });
      return (await native.call("readText"))?.text ?? "";
    });
    if (clip !== "GlassinePasteOK") return `native copyText/readText gave "${clip}"`;
    const nameInp = page.locator("input.scene-name");
    await nameInp.click();
    await nameInp.fill("");
    await app.evaluate(({ Menu }) => Menu.getApplicationMenu()?.items.find((i) => i.label === "Edit")?.submenu?.items.find((i) => i.label === "Paste")?.click());
    await sleep(300);
    const pastedVal = await nameInp.inputValue();
    await nameInp.fill("Desktop check");
    await nameInp.blur();
    await sleep(200);
    if (pastedVal !== "GlassinePasteOK") return `Edit → Paste into input gave "${pastedVal}"`;
    // Copy & paste a child frame (Card), then a top-level artboard (Phone), through the real Edit → Paste menu.
    const cardId = Object.values(boards.getBoard(b.id).nodes).find((n) => n.name === "Card")!.id;
    const phoneId = Object.values(boards.getBoard(b.id).nodes).find((n) => n.name === "Phone")!.id;
    await page.evaluate(async (id: string) => (await import("/ui/board-state.js" as string)).select(id), cardId);
    await sleep(150);
    const countBefore = Object.keys(boards.getBoard(b.id).nodes).length;
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.copy());
    await sleep(200);
    await app.evaluate(({ Menu }) => Menu.getApplicationMenu()?.items.find((i) => i.label === "Edit")?.submenu?.items.find((i) => i.label === "Paste")?.click());
    await sleep(700);
    const countAfterCard = Object.keys(boards.getBoard(b.id).nodes).length;
    if (countAfterCard !== countBefore + 1) return `pasting Card left node count ${countBefore} -> ${countAfterCard}`;
    await page.evaluate(async (id: string) => (await import("/ui/board-state.js" as string)).select(id), phoneId);
    await sleep(150);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.copy());
    await sleep(200);
    await app.evaluate(({ Menu }) => Menu.getApplicationMenu()?.items.find((i) => i.label === "Edit")?.submenu?.items.find((i) => i.label === "Paste")?.click());
    await sleep(800);
    const rootsAfterPhone = boards.getBoard(b.id).pages[0].children.length;
    if (rootsAfterPhone !== 2) return `pasting Phone left ${rootsAfterPhone} artboards`;
    // Verify Figma clipboard HTML routes through Edit → Paste to studio.command("pasteFigma", html).
    await page.evaluate(() => {
      const s = (window as unknown as { studio: { command: (n: string, a?: unknown) => unknown } }).studio;
      const own = s.command;
      s.command = (n: string, a?: unknown) => {
        if (n === "pasteFigma") {
          (window as unknown as { __figmaPaste?: string }).__figmaPaste = String(a ?? "");
          return;
        }
        return own(n, a);
      };
    });
    await app.evaluate(async ({ clipboard, ClipboardItem }) => {
      const figHtml = `<meta charset='utf-8'><span data-metadata="<!--(figmeta)e30=(/figmeta)-->"></span><span data-buffer="<!--(figma)TESTDATA(/figma)-->"></span>`;
      await clipboard.write([new ClipboardItem({ "text/html": new Blob([figHtml], { type: "text/html" }) })]);
    });
    await app.evaluate(({ Menu }) => Menu.getApplicationMenu()?.items.find((i) => i.label === "Edit")?.submenu?.items.find((i) => i.label === "Paste")?.click());
    await sleep(300);
    const figmaGot = await page.evaluate(() => (window as unknown as { __figmaPaste?: string }).__figmaPaste ?? "");
    return figmaGot.includes("(figma)TESTDATA(/figma)") ? true : `Edit → Paste Figma HTML gave "${figmaGot.slice(0, 80)}"`;
  });

  await check("links to other sites open in the browser, not the app", async () => {
    const before = page.url();
    const opened = await app.evaluate(({ shell }) => {
      const g = globalThis as unknown as { __opened: string[] };
      g.__opened = [];
      shell.openExternal = async (u: string) => void g.__opened.push(u);
      return true;
    });
    await page.evaluate(() => {
      const a = document.createElement("a");
      a.href = "https://example.com/";
      document.body.appendChild(a);
      a.click();
      a.remove();
    });
    await sleep(500);
    const got = await app.evaluate(() => (globalThis as unknown as { __opened: string[] }).__opened);
    return opened && page.url() === before && got.includes("https://example.com/") ? true : `now on ${page.url()}, opened ${JSON.stringify(got)}`;
  });

  if (process.env.DESKTOP_SHOT) {
    // The whole window, traffic lights and all (needs Screen Recording for the terminal); else its page.
    const id = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getMediaSourceId());
    try {
      execFileSync("screencapture", ["-x", "-o", `-l${id.split(":")[1]}`, process.env.DESKTOP_SHOT], { stdio: "ignore" });
    } catch {
      await page.screenshot({ path: process.env.DESKTOP_SHOT });
    }
    console.log(`picture of the window: ${process.env.DESKTOP_SHOT}`);
  }

  await check("quitting asks the page to save first, then quits", async () => {
    await page.evaluate(() => {
      const s = (window as unknown as { studio: { command: (n: string) => unknown } }).studio;
      const own = s.command;
      s.command = (n: string) => (n === "flush" ? ((window as unknown as { __flushed: boolean }).__flushed = true) : own(n));
    });
    const closed = new Promise<boolean>((done) => app.process().once("exit", () => done(true)));
    await app.evaluate(({ app: a }) => a.quit());
    const gone = await Promise.race([closed, sleep(5000).then(() => false)]);
    return gone ? true : "still running 5 s after Quit";
  });
} finally {
  await app.close().catch(() => undefined);
}

await check("`<app> mcp` serves MCP on stdin/stdout", async () => {
  const child = spawn(exe, [...appArgs, "mcp"], { env: { ...process.env, ...ENV }, stdio: ["pipe", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "desktop-check", version: "1" } } }) + "\n");
  for (let i = 0; i < 150 && !out.includes('"id":1'); i++) await sleep(100);
  child.stdin.end();
  child.kill();
  return /"serverInfo"/.test(out) ? true : `answered: ${out.slice(0, 120) || "nothing"}`;
});

if (errors.length) {
  failed++;
  console.log(`FAIL page errors: ${[...new Set(errors)].slice(0, 3).join(" | ")}`);
}
rmSync(tmp, { recursive: true, force: true });
console.log(failed ? `\n${failed} desktop check${failed === 1 ? "" : "s"} failed.` : "\nAll desktop checks passed.");
process.exit(failed ? 1 : 0);
