/**
 * The keys the person saved once in the app's Settings, for every way the engine runs. The app
 * hands them to the engines it starts (as environment variables); an engine started some other way
 * (an agent's MCP server from a development checkout, say) reads them from the Keychain itself,
 * where the app keeps them. macOS asks the person once before it lets a program other than the
 * app read one.
 */
import { execFile } from "node:child_process";

const KEYCHAIN_SERVICE = "Screenshotter.AI";
const asked = new Map<string, Promise<string | undefined>>();

function fromKeychain(account: string): Promise<string | undefined> {
  if (process.platform !== "darwin" || process.env.SCREENSHOTTER_NO_KEYCHAIN) return Promise.resolve(undefined);
  let got = asked.get(account);
  if (!got) {
    // Asked once per process: a "Deny" isn't asked again until the engine starts again.
    got = new Promise((resolve) => {
      execFile("/usr/bin/security", ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", account, "-w"], { timeout: 120_000 }, (err, stdout) => {
        const key = err ? "" : String(stdout).trim();
        resolve(key || undefined);
      });
    });
    asked.set(account, got);
  }
  return got;
}

/** Unsplash's access key (Settings › Photos), or undefined when there isn't one. */
export async function unsplashKey(): Promise<string | undefined> {
  return process.env.UNSPLASH_ACCESS_KEY?.trim() || (await fromKeychain("unsplash"));
}
