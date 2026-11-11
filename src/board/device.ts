/**
 * Screenshotter's devices on a board: a screenshot (or an artboard drawn as one) in Apple's device
 * frame, as a transparent PNG cropped close to the device, to place as an image layer.
 */
import { createHash } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { createMockup, layoutScene } from "../render/mockup.js";
import { cacheDir } from "../util/files.js";
import { imageSize } from "../util/image.js";

export interface DeviceOptions {
  /** A model ("iPhone 17 Pro"); default: detected from the screenshot. */
  device?: string;
  /** A finish ("Cosmic Orange") or clay tone. */
  color?: string;
  clay?: string | boolean;
}

const jobs = new Map<string, Promise<{ path: string; width: number; height: number }>>();

export async function deviceImage(screenshot: string, opts: DeviceOptions = {}): Promise<{ path: string; width: number; height: number }> {
  if (!existsSync(screenshot)) throw new Error(`There's no screenshot at ${screenshot}.`);
  const key = createHash("sha1").update(JSON.stringify([screenshot, statSync(screenshot).mtimeMs, opts])).digest("hex").slice(0, 16);
  const out = path.join(cacheDir("board-devices"), `${key}.png`);
  if (existsSync(out)) return { path: out, ...(await imageSize(out)) };
  const running = jobs.get(key);
  if (running) return running;
  const job = (async () => {
    const dev = { screenshot, ...(opts.device ? { device: opts.device } : {}), ...(opts.color ? { color: opts.color } : {}), ...(opts.clay ? { clay: opts.clay } : {}), shadow: "none" as const, x: 0.5, y: 0.5, anchor: "center" as const };
    // Where the device comes out on a big square canvas, to fit the real one closely round it.
    const probe = await layoutScene({ devices: [{ ...dev, height: 0.8 }], canvas: { width: 2400, height: 2400 }, layout: "custom", background: "transparent" });
    const d = probe.entities.find((e) => e.kind === "device");
    if (!d?.width || !d.height) throw new Error("Couldn't work out the device's size.");
    const pad = 0.02;
    const W = Math.round(d.width * 2400 * (1 + pad * 2));
    const H = Math.round(d.height * 2400 * (1 + pad * 2));
    await createMockup({ devices: [{ ...dev, height: 1 / (1 + pad * 2) }], canvas: { width: W, height: H }, layout: "custom", background: "transparent", format: "png", output: out, preview: false });
    return { path: out, width: W, height: H };
  })();
  jobs.set(key, job);
  try {
    return await job;
  } finally {
    jobs.delete(key);
  }
}
