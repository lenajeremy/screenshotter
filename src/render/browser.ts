import { existsSync } from "node:fs";
import { homedir } from "node:os";
import puppeteer, { type Browser, type Page } from "puppeteer-core";

const CANDIDATES = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
  "/Applications/Arc.app/Contents/MacOS/Arc",
];

export function findChrome(): string {
  const configured = process.env.SCREENSHOTTER_CHROME_PATH ?? process.env.CHROME_PATH;
  if (configured) {
    if (!existsSync(configured)) throw new Error(`SCREENSHOTTER_CHROME_PATH points to a missing file: ${configured}`);
    return configured;
  }
  const userApps = CANDIDATES.map((p) => p.replace("/Applications/", `${homedir()}/Applications/`));
  const found = [...CANDIDATES, ...userApps].find((p) => existsSync(p));
  if (!found) {
    throw new Error(
      "No Chromium-based browser found for rendering mockups. Install Google Chrome, or set " +
        "SCREENSHOTTER_CHROME_PATH to a Chrome/Chromium executable " +
        "(e.g. `npx @puppeteer/browsers install chrome-headless-shell@stable`).",
    );
  }
  return found;
}

let browserPromise: Promise<Browser> | undefined;
let idleTimer: NodeJS.Timeout | undefined;
let openPages = 0;
const IDLE_MS = 5 * 60_000;

/** Close the browser after a few idle minutes, but never while a page is still in use. */
function scheduleIdleClose() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    if (openPages > 0) scheduleIdleClose();
    else void closeBrowser();
  }, IDLE_MS);
  idleTimer.unref();
}

/** A shared headless browser, launched on first use and closed after a few idle minutes. */
export async function getBrowser(): Promise<Browser> {
  scheduleIdleClose();
  if (browserPromise) {
    const b = await browserPromise.catch(() => undefined);
    if (b?.connected) return b;
    openPages = 0;
  }
  browserPromise = puppeteer.launch({
    executablePath: findChrome(),
    headless: true,
    args: [
      "--allow-file-access-from-files",
      "--disable-web-security",
      "--font-render-hinting=none",
      "--force-color-profile=srgb",
      "--hide-scrollbars",
      "--no-first-run",
      "--no-default-browser-check",
      // 3D-tilted devices are stacks of composited layers, rendered at 2x. Chrome's default
      // graphics-memory budget can't hold them and silently drops tiles (black screens, missing
      // backgrounds), so give the compositor room.
      "--force-gpu-mem-available-mb=4096",
    ],
  });
  return browserPromise;
}

export async function closeBrowser(): Promise<void> {
  const p = browserPromise;
  browserPromise = undefined;
  if (!p) return;
  const b = await p.catch(() => undefined);
  await b?.close().catch(() => undefined);
}

/**
 * Open a page ready for `page.evaluate` with local functions. Bundlers like esbuild (used by
 * tsx in development) wrap functions in a `__name` helper that doesn't exist in the page.
 */
export async function newPage(): Promise<Page> {
  const page = await (await getBrowser()).newPage();
  openPages++;
  page.once("close", () => {
    openPages = Math.max(0, openPages - 1);
    scheduleIdleClose();
  });
  const shim = "globalThis.__name = globalThis.__name || ((fn) => fn);";
  await page.evaluateOnNewDocument(shim);
  await page.evaluate(shim);
  return page;
}
