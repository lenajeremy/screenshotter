// Code signing for the app and its disk image.
//
// With a "Developer ID Application" certificate in the keychain (from your Apple Developer
// account, via Xcode › Settings › Accounts › Manage Certificates), builds are signed with it and
// the hardened runtime, which is what Apple notarizes. Without one, builds are ad-hoc signed and
// macOS asks people to allow the app on first launch.
//
//   SCREENSHOTTER_SIGN_IDENTITY   part of an identity's name to use instead, or "-" for ad hoc
//   SCREENSHOTTER_NOTARY_PROFILE  notarytool keychain profile (default "screenshotter")
//   SCREENSHOTTER_NOTARY_KEY      or an App Store Connect API key instead: the AuthKey_….p8 file,
//   SCREENSHOTTER_NOTARY_KEY_ID   its key ID,
//   SCREENSHOTTER_NOTARY_ISSUER   and its issuer ID (team keys only)
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/** The identity to sign with, or null for an ad-hoc signature. */
export function signingIdentity() {
  const want = process.env.SCREENSHOTTER_SIGN_IDENTITY;
  if (want === "-") return null;
  const out = spawnSync("security", ["find-identity", "-v", "-p", "codesigning"], { encoding: "utf8" }).stdout ?? "";
  const names = [...out.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  if (want) {
    const hit = names.find((n) => n.includes(want));
    if (!hit) throw new Error(`No signing identity matches "${want}". Found: ${names.join("; ") || "none"}`);
    return hit;
  }
  return names.find((n) => n.startsWith("Developer ID Application:")) ?? null;
}

const plist = (keys) =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n${keys.map((k) => `  <key>${k}</key><true/>`).join("\n")}\n</dict></plist>\n`;

/** Write the entitlements files: the app's, and those a bundled Node needs to run JavaScript. */
export function entitlements() {
  const dir = mkdtempSync(path.join(tmpdir(), "screenshotter-sign-"));
  const app = path.join(dir, "app.entitlements");
  const node = path.join(dir, "node.entitlements");
  // Capturing Mac windows asks other apps about their windows (Apple Events); the capture bar
  // records the camera and microphone (the hardened runtime needs both declared).
  writeFileSync(app, plist(["com.apple.security.automation.apple-events", "com.apple.security.device.camera", "com.apple.security.device.audio-input"]));
  writeFileSync(node, plist(["com.apple.security.cs.allow-jit", "com.apple.security.cs.allow-unsigned-executable-memory", "com.apple.security.cs.disable-library-validation"]));
  return { app, node };
}

/** notarytool's credentials (an App Store Connect API key, or a saved keychain profile that works), or null. */
export function notaryAuth() {
  const { SCREENSHOTTER_NOTARY_KEY: key, SCREENSHOTTER_NOTARY_KEY_ID: keyId, SCREENSHOTTER_NOTARY_ISSUER: issuer } = process.env;
  const args = key && keyId ? ["--key", key, "--key-id", keyId, ...(issuer ? ["--issuer", issuer] : [])] : ["--keychain-profile", process.env.SCREENSHOTTER_NOTARY_PROFILE || "screenshotter"];
  const r = spawnSync("xcrun", ["notarytool", "history", ...args], { encoding: "utf8" });
  return r.status === 0 ? args : null;
}
