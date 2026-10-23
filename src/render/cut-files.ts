// The files a video with parts taken out plays from: its recording without them (picture and
// sound), and its cursor log without them. Made with ffmpeg once and kept in the cache.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { cacheDir } from "../util/files.js";
import { mediaInfo } from "../util/media.js";
import { readLog } from "./cursor.js";
import { cutLog, keptParts, tidyCuts, type Cut } from "./cuts.js";

const key = (file: string, cuts: Cut[], kind: string) => createHash("sha1").update(`${kind}|${file}|${statSync(file).mtimeMs}|${statSync(file).size}|${JSON.stringify(cuts)}`).digest("hex").slice(0, 24);

function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("error", (e) => reject((e as NodeJS.ErrnoException).code === "ENOENT" ? new Error(`${cmd} isn't installed. Install it with \`brew install ffmpeg\`.`) : e));
    p.on("exit", (code) => (code === 0 ? resolve(out) : reject(new Error(`${cmd} couldn't cut the recording: ${err.trim().split("\n").slice(-2).join(" ")}`))));
  });
}

const making = new Map<string, Promise<string>>();

/** The recording with its cut parts taken out, picture and sound, as one file. */
export async function cutVideo(file: string, cuts: Cut[]): Promise<string> {
  const list = tidyCuts(cuts);
  if (!list.length) return file;
  const out = path.join(cacheDir("cuts"), `${key(file, list, "video")}${path.extname(file).toLowerCase() === ".mov" ? ".mov" : ".mp4"}`);
  if (existsSync(out)) return out;
  const pending = making.get(out);
  if (pending) return pending;
  const job = (async () => {
    const { length, sound } = await mediaInfo(file);
    const parts = keptParts(list, length || Infinity).filter((p) => p.to - p.from > 0.01);
    if (!parts.length) throw new Error("Every part of the recording was cut out.");
    const f = (v: number) => v.toFixed(3);
    // The file's length is known to the hundredth of a second: a part running to its end runs to the end.
    const span = (p: Cut) => `start=${f(p.from)}${Number.isFinite(p.to) && !(length && p.to >= length - 0.011) ? `:end=${f(p.to)}` : ""}`;
    const chains = parts.flatMap((p, k) => [
      `[0:v]trim=${span(p)},setpts=PTS-STARTPTS[v${k}]`,
      ...(sound ? [`[0:a]atrim=${span(p)},asetpts=PTS-STARTPTS[a${k}]`] : []),
    ]);
    const joined = parts.map((_, k) => (sound ? `[v${k}][a${k}]` : `[v${k}]`)).join("");
    const graph = `${chains.join(";")};${joined}concat=n=${parts.length}:v=1:a=${sound ? 1 : 0}[v]${sound ? "[a]" : ""}`;
    const tmp = `${out}.part${path.extname(out)}`;
    await run("ffmpeg", ["-v", "error", "-y", "-i", file, "-filter_complex", graph, "-map", "[v]", ...(sound ? ["-map", "[a]", "-c:a", "aac", "-b:a", "256k"] : []), "-c:v", "libx264", "-preset", "veryfast", "-crf", "12", "-pix_fmt", "yuv420p", "-movflags", "+faststart", tmp]);
    renameSync(tmp, out);
    return out;
  })();
  making.set(out, job);
  try {
    return await job;
  } catch (e) {
    rmSync(`${out}.part${path.extname(out)}`, { force: true });
    throw e;
  } finally {
    making.delete(out);
  }
}

/** The cursor log with the cut parts taken out, as a file beside the cut recordings. */
export function cutLogFile(file: string, cuts: Cut[]): string {
  const list = tidyCuts(cuts);
  if (!list.length) return file;
  const out = path.join(cacheDir("cuts"), `${key(file, list, "log")}.json`);
  if (!existsSync(out)) writeFileSync(out, JSON.stringify(cutLog(readLog(JSON.parse(readFileSync(file, "utf8"))), list)));
  return out;
}
