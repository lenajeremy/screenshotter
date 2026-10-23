// What's in a video or sound file, read from what ffmpeg says when it opens one (the app carries
// ffmpeg but not ffprobe): how long it runs, to the hundredth of a second, whether it has sound,
// and the size of its picture.

import { spawn } from "node:child_process";

export interface MediaInfo {
  /** Seconds; 0 when it can't be told. */
  length: number;
  sound: boolean;
  width?: number;
  height?: number;
}

/** Read ffmpeg's description of a file (what it prints on opening it). */
export function parseMediaInfo(text: string): MediaInfo {
  const d = /Duration: (\d+):(\d\d):(\d\d(?:\.\d+)?)/.exec(text);
  const picture = /Stream #\d+:\d+[^\n]*: Video: [^\n]*?, (\d{1,5})x(\d{1,5})[\s,[]/.exec(text);
  return {
    length: d ? Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3]) : 0,
    sound: /Stream #\d+:\d+[^\n]*: Audio:/.test(text),
    width: picture ? Number(picture[1]) : undefined,
    height: picture ? Number(picture[2]) : undefined,
  };
}

/** What's in a file. A file ffmpeg can't open has length 0 and no sound. */
export function mediaInfo(file: string, timeoutMs = 15_000): Promise<MediaInfo> {
  return new Promise((resolve, reject) => {
    const p = spawn("ffmpeg", ["-hide_banner", "-i", file], { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    const timer = setTimeout(() => p.kill("SIGKILL"), timeoutMs);
    p.stderr.on("data", (d) => (err += d));
    p.on("error", (e) => {
      clearTimeout(timer);
      reject((e as NodeJS.ErrnoException).code === "ENOENT" ? new Error("ffmpeg isn't installed. Install it with `brew install ffmpeg`.") : e);
    });
    // ffmpeg exits with an error when given no output; what it printed is all that's wanted.
    p.on("exit", () => {
      clearTimeout(timer);
      resolve(parseMediaInfo(err));
    });
  });
}
