/**
 * A file's sound as a waveform for the timeline's Sound row: how loud it is, fifty times a second
 * (0 to 100, on a square-root scale so quiet speech still shows), read once per file.
 */
import { spawn } from "node:child_process";
import { statSync } from "node:fs";

export interface Waveform {
  /** Seconds of sound (0: the file has none). */
  duration: number;
  /** Peaks a second. */
  rate: number;
  peaks: number[];
}

const RATE = 50;
const SAMPLE_RATE = 4000;
const cache = new Map<string, Promise<Waveform>>();

export function waveform(file: string): Promise<Waveform> {
  const key = `${file}:${statSync(file).mtimeMs}`;
  let w = cache.get(key);
  if (!w) {
    w = read(file);
    cache.set(key, w);
    w.catch(() => cache.delete(key));
  }
  return w;
}

function read(file: string): Promise<Waveform> {
  return new Promise((resolve, reject) => {
    // The sound alone, as small numbers: mono, 4,000 samples a second.
    const p = spawn("ffmpeg", ["-hide_banner", "-nostats", "-i", file, "-vn", "-ac", "1", "-ar", String(SAMPLE_RATE), "-f", "s16le", "-"], { stdio: ["ignore", "pipe", "pipe"] });
    const per = SAMPLE_RATE / RATE;
    const raw: number[] = [];
    let n = 0;
    let peak = 0;
    let samples = 0;
    let carry: Buffer | null = null;
    let err = "";
    p.stdout.on("data", (chunk: Buffer) => {
      const b = carry ? Buffer.concat([carry, chunk]) : chunk;
      const even = b.length - (b.length % 2);
      for (let i = 0; i < even; i += 2) {
        const v = Math.abs(b.readInt16LE(i));
        if (v > peak) peak = v;
        if (++n === per) {
          raw.push(peak);
          peak = 0;
          n = 0;
        }
      }
      samples += even / 2;
      carry = even < b.length ? b.subarray(even) : null;
    });
    p.stderr.on("data", (d) => (err += d));
    p.on("error", reject);
    p.on("exit", (code) => {
      if (n) raw.push(peak);
      if (code !== 0 && !raw.length) {
        // No sound track: nothing to show.
        if (/does not contain any stream|matches no streams|no audio/i.test(err)) return resolve({ duration: 0, rate: RATE, peaks: [] });
        return reject(new Error(`ffmpeg couldn't read the sound (${err.trim().split("\n").pop() ?? code})`));
      }
      let top = 1;
      for (const v of raw) if (v > top) top = v;
      resolve({ duration: samples / SAMPLE_RATE, rate: RATE, peaks: raw.map((v) => Math.round(Math.sqrt(v / top) * 100)) });
    });
  });
}
