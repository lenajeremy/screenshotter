import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { run, sleep } from "../util/exec.js";
import { outputPathFor } from "../util/files.js";
import { mediaInfo } from "../util/media.js";
import { rmSync } from "node:fs";
import path from "node:path";
import { captureClear, launchTarget, prepareSimulator, writeCaptureSidecar, type CaptureOptions } from "./capture.js";
import * as sim from "./simctl.js";

export interface RecordOptions extends CaptureOptions {
  /** Seconds to record. */
  duration?: number;
  /** Things to do while recording, at seconds from the start. */
  timeline?: Array<{ at: number; url?: string; launch?: string; appearance?: "light" | "dark" }>;
}

export interface RecordResult {
  video: string;
  poster: string;
  width: number;
  height: number;
  duration: number;
  steps: string[];
  warnings: string[];
}

/**
 * Record the simulator screen (H.264) while optionally opening deep links on a timeline.
 * Also writes a poster frame PNG so mockups can detect the device from it.
 */
export function recordSimulator(opts: RecordOptions): Promise<RecordResult> {
  return sim.withSimulatorLock(() => recordUnlocked(opts));
}

async function recordUnlocked(opts: RecordOptions): Promise<RecordResult> {
  const steps: string[] = [];
  const simulator = await prepareSimulator(opts, steps);
  const duration = Math.min(Math.max(opts.duration ?? 8, 1), 120);
  await sleep(opts.waitMs ?? 1200);

  const base = opts.bundleId ? `${simulator.name}-${opts.bundleId.split(".").pop()}` : simulator.name;
  // Recordings are always H.264 MP4; the poster sits next to it with the same name.
  const video = outputPathFor(opts.output, "recordings", base, "mp4");
  const stem = path.join(path.dirname(video), path.parse(video).name);
  // Start once the app has finished drawing (and any other app's leftover prompt is cleared),
  // so the take doesn't open on a blank screen or an alert.
  let warnings: string[] = [];
  if (opts.settle !== false) {
    const probe = `${stem}.settle.png`;
    const appName = opts.bundleId ? (await sim.listApps(simulator.udid).catch(() => [])).find((a) => a.bundleId === opts.bundleId)?.name : undefined;
    warnings = await captureClear(simulator, probe, opts, steps, { name: appName, relaunch: () => launchTarget(simulator, opts, []) });
    rmSync(probe, { force: true });
  }
  const proc = spawn("xcrun", ["simctl", "io", simulator.udid, "recordVideo", "--codec=h264", "--force", video], {
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  proc.stderr.on("data", (d) => (stderr += d));
  const exited = new Promise<number | null>((resolve) => proc.on("exit", resolve));

  try {
  // recordVideo needs a moment before the first frame is written.
  const started = Date.now();
  while (!/Recording started/i.test(stderr) && Date.now() - started < 5000) await sleep(100);
  const t0 = Date.now();
  for (const step of [...(opts.timeline ?? [])].sort((a, b) => a.at - b.at)) {
    const wait = step.at * 1000 - (Date.now() - t0);
    if (wait > 0) await sleep(wait);
    try {
      if (step.launch) await sim.launchApp(simulator.udid, step.launch);
      if (step.url) await sim.openUrl(simulator.udid, step.url);
      if (step.appearance) await sim.setAppearance(simulator.udid, step.appearance);
      steps.push(`@${step.at}s ${step.url ?? step.launch ?? step.appearance}`);
    } catch (e) {
      // Keep recording; report the failed step instead of throwing away the take.
      steps.push(`@${step.at}s FAILED ${step.url ?? step.launch ?? step.appearance}: ${(e as Error).message.split("\n").pop()?.trim()}`);
    }
  }
  const remaining = duration * 1000 - (Date.now() - t0);
  if (remaining > 0) await sleep(remaining);
  } finally {
    // Always stop the recorder, even if a step threw, so it never lingers.
    proc.kill("SIGINT");
  }
  const code = await Promise.race([exited, sleep(15_000).then(() => "timeout" as const)]);
  if (code === "timeout") proc.kill("SIGKILL");
  if (!existsSync(video)) {
    const busy = /already in progress/i.test(stderr) ? " Another recording of this simulator is still running; stop it (pkill -INT -f recordVideo) and retry." : "";
    throw new Error(`Recording failed: ${stderr.trim() || `exit ${code}`}.${busy}`);
  }

  const poster = `${stem}.png`;
  // The recorder only writes frames when the screen changes, so take the very first frame.
  await run("ffmpeg", ["-y", "-loglevel", "error", "-i", video, "-frames:v", "1", "-update", "1", poster]);
  await writeCaptureSidecar(poster, simulator, { bundleId: opts.bundleId, appearance: opts.appearance });
  const info = await mediaInfo(video);
  steps.push(`recorded ${duration}s`);
  return {
    video,
    poster,
    width: info.width ?? 0,
    height: info.height ?? 0,
    // A still screen yields a short file; the take still covers the requested time.
    duration: Math.max(info.length, duration),
    steps,
    warnings,
  };
}
