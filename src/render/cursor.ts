// A screen recording's cursor, logged beside it by the capture bar (the real cursor is kept out of
// the picture): where it was, smoothed or not, which cursor it was, the clicks, and the zooms on
// them. Pure, so the Studio's canvas and the video renderer draw it from the same code.

import { cameraView } from "./animate.js";

/** The log as the capture bar writes it: seconds of the recording; places as shares of the
 *  recording (from its top left); clicks "down", "double", "up" or "right"; cursors "arrow",
 *  "text", "hand", "grab", "grabbing". */
export interface CursorLog {
  samples: Array<[number, number, number]>;
  clicks?: Array<[number, number, number, string]>;
  kinds?: Array<[number, string]>;
}

/** The cursor ready to draw: its path at an even rate (smoothed if asked), clicks and cursors. */
export interface CursorTrack {
  /** Seconds between points of `xs`/`ys`. */
  step: number;
  xs: number[];
  ys: number[];
  /** Presses: [seconds, x, y]. */
  clicks: Array<[number, number, number]>;
  kinds: Array<[number, string]>;
}

export const CURSOR_KINDS = ["arrow", "text", "hand", "grab", "grabbing"] as const;

/** A log as read from its file, its points in time order (a broken one is empty). */
export function readLog(raw: unknown): CursorLog {
  const o = (raw ?? {}) as Partial<CursorLog>;
  const num = (v: unknown) => typeof v === "number" && Number.isFinite(v);
  const samples = (Array.isArray(o.samples) ? o.samples : []).filter((s) => Array.isArray(s) && num(s[0]) && num(s[1]) && num(s[2])) as CursorLog["samples"];
  const clicks = (Array.isArray(o.clicks) ? o.clicks : []).filter((c) => Array.isArray(c) && num(c[0]) && num(c[1]) && num(c[2])) as NonNullable<CursorLog["clicks"]>;
  const kinds = (Array.isArray(o.kinds) ? o.kinds : []).filter((k) => Array.isArray(k) && num(k[0]) && typeof k[1] === "string") as NonNullable<CursorLog["kinds"]>;
  const byTime = <T extends [number, ...unknown[]]>(a: T, b: T) => a[0] - b[0];
  return { samples: [...samples].sort(byTime), clicks: [...clicks].sort(byTime), kinds: [...kinds].sort(byTime) };
}

/**
 * The path at 60 points a second. `smooth` (0 to 1) takes the shake out: the path is eased forwards
 * and then backwards, so it doesn't trail behind (the cursor still lands where you clicked).
 */
export function trackOf(log: CursorLog, smooth = 0): CursorTrack {
  const step = 1 / 60;
  const s = log.samples;
  const clicks = (log.clicks ?? []).filter((c) => c[3] === "down" || c[3] === "double" || c[3] === "right").map((c) => [c[0], c[1], c[2]] as [number, number, number]);
  const kinds = log.kinds ?? [];
  if (!s.length) return { step, xs: [], ys: [], clicks, kinds };
  const end = s[s.length - 1][0];
  const n = Math.max(1, Math.ceil(end / step) + 1);
  const xs = new Array<number>(n);
  const ys = new Array<number>(n);
  // Where it was at each step: it stays put between samples (the log only notes moves).
  let k = 0;
  for (let i = 0; i < n; i++) {
    const t = i * step;
    while (k + 1 < s.length && s[k + 1][0] <= t) k++;
    const a = s[k];
    const b = s[k + 1];
    if (b && t > a[0] && b[0] - a[0] < 0.05) {
      // Close samples: in between them.
      const p = (t - a[0]) / (b[0] - a[0]);
      xs[i] = a[1] + (b[1] - a[1]) * p;
      ys[i] = a[2] + (b[2] - a[2]) * p;
    } else {
      xs[i] = a[1];
      ys[i] = a[2];
    }
  }
  const amount = Math.min(1, Math.max(0, smooth));
  if (amount > 0) {
    // A time constant from a few hundredths of a second to a quarter of one.
    const tau = 0.02 + amount * 0.23;
    const a = 1 - Math.exp(-step / tau);
    for (const v of [xs, ys]) {
      for (let pass = 0; pass < 2; pass++) {
        for (let i = 1; i < n; i++) v[i] += (v[i - 1] - v[i]) * (1 - a);
        for (let i = n - 2; i >= 0; i--) v[i] += (v[i + 1] - v[i]) * (1 - a);
      }
    }
    // Clicks stay on target: near each press the path is drawn back to where it happened.
    for (const [t, x, y] of clicks) {
      const c = Math.round(t / step);
      const reach = Math.round(0.12 / step);
      for (let i = Math.max(0, c - reach); i <= Math.min(n - 1, c + reach); i++) {
        const w = 1 - Math.abs(i - c) / (reach + 1);
        const pull = w * w * (3 - 2 * w);
        xs[i] += (x - xs[i]) * pull;
        ys[i] += (y - ys[i]) * pull;
      }
    }
  }
  return { step, xs, ys, clicks, kinds };
}

/** Where the cursor is at `t`. */
export function cursorAt(track: CursorTrack, t: number): { x: number; y: number } | undefined {
  const n = track.xs.length;
  if (!n) return undefined;
  const f = Math.max(0, t / track.step);
  const i = Math.min(n - 1, Math.floor(f));
  const j = Math.min(n - 1, i + 1);
  const p = f - i;
  return { x: track.xs[i] + (track.xs[j] - track.xs[i]) * p, y: track.ys[i] + (track.ys[j] - track.ys[i]) * p };
}

/** Which cursor macOS showed at `t`. */
export function cursorKindAt(track: CursorTrack, t: number): string {
  let kind = "arrow";
  for (const [at, k] of track.kinds) {
    if (at > t) break;
    kind = k;
  }
  return (CURSOR_KINDS as readonly string[]).includes(kind) ? kind : "arrow";
}

/** How long ago the latest click was, if it's within `window` seconds (for the press and ripple). */
export function clickAt(track: CursorTrack, t: number, window = 0.5): { since: number; x: number; y: number } | undefined {
  let best: [number, number, number] | undefined;
  for (const c of track.clicks) {
    if (c[0] > t + 0.06) break;
    best = c;
  }
  if (!best) return undefined;
  const since = t - best[0];
  return since <= window ? { since, x: best[1], y: best[2] } : undefined;
}

/** A zoom onto the clicks: what auto zoom makes, a camera animation of the Studio's own kind. */
export interface AutoZoom {
  targets: "camera";
  at: number;
  duration: number;
  ease: "ease-in-out";
  to: { zoom: number; x: number; y: number };
  auto: true;
}

/** Where a recording sits on the canvas, as canvas fractions: its left, top, width and height. */
export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Zooms that follow the clicks, as Screen Studio's do, calmly: in on the first of a run of clicks
 * (clicks close together in time), and back out a little after the last. In between, the camera
 * stays put while each click lands well inside what it shows; it goes after one near the edge once
 * it has been still a moment, and after one out of sight at once (a quick string of those is one
 * glide, to the last). They're plain camera animations, so they can be moved, changed or deleted
 * on the timeline. Places are on the canvas: `box` is where the recording sits on it.
 */
export function autoZooms(track: CursorTrack, length: number, zoom = 1.8, box: Box = { x: 0, y: 0, w: 1, h: 1 }): AutoZoom[] {
  const presses = track.clicks.filter((c) => c[0] >= 0 && c[0] <= length);
  if (!presses.length) return [];
  // Runs of clicks: a pause of more than 3 s starts a new one.
  const runs: Array<Array<[number, number, number]>> = [];
  for (const c of presses) {
    const run = runs[runs.length - 1];
    if (run && c[0] - run[run.length - 1][0] <= 3) run.push(c);
    else runs.push([c]);
  }
  const r4 = (v: number) => Math.round(v * 10000) / 10000;
  const into = (v: number) => Math.min(1, Math.max(0, v));
  const on = (c: [number, number, number]) => ({ x: r4(into(box.x + c[1] * box.w)), y: r4(into(box.y + c[2] * box.h)) });
  const IN = 0.7;
  const OUT = 0.8;
  // Within this share of the view from its edge, a click is near the edge.
  const EDGE = 0.15;
  // How long the camera stays still before going after a click near the edge.
  const SETTLE = 1;
  /** Where a point is in the view of a camera on `f`: well inside, near the edge, or out of it. */
  const where = (f: { x: number; y: number }, p: { x: number; y: number }) => {
    const v = cameraView({ zoom, x: f.x, y: f.y });
    const m = v.width * EDGE;
    const within = (pad: number) => p.x >= v.x + pad && p.x <= v.x + v.width - pad && p.y >= v.y + pad && p.y <= v.y + v.height - pad;
    return within(m) ? "inside" : within(0) ? "edge" : "out";
  };
  const out: AutoZoom[] = [];
  // Where the camera is (null when zoomed out), and when its last move ends.
  let cam: { x: number; y: number } | null = null;
  let still = 0;
  runs.forEach((run, n) => {
    for (const [i, c] of run.entries()) {
      const p = on(c);
      if (!cam) {
        // In on the first click of the run, arriving a moment before it.
        const at = Math.max(still, c[0] - IN - 0.25);
        out.push({ targets: "camera", at: r4(at), duration: IN, ease: "ease-in-out", to: { zoom, ...p }, auto: true });
        cam = p;
        still = at + IN;
        continue;
      }
      const place = where(cam, p);
      if (place === "inside" || (place === "edge" && c[0] < still + SETTLE)) continue;
      const last = out[out.length - 1];
      // Still on its way, after one of this run's clicks: go on to this one instead, in one glide.
      if (i > 0 && last.to.zoom > 1 && c[0] < still + 0.15 && c[0] > last.at) {
        last.duration = r4(Math.max(last.duration, c[0] - last.at));
        last.to = { zoom, ...p };
      } else {
        // Across to it, arriving as it happens (or as soon as it can).
        const move = Math.min(0.6, Math.max(0.3, c[0] - still));
        const from = Math.max(still, c[0] - move);
        out.push({ targets: "camera", at: r4(from), duration: r4(Math.max(0.2, c[0] - from)), ease: "ease-in-out", to: { zoom, ...p }, auto: true });
      }
      cam = p;
      still = out[out.length - 1].at + out[out.length - 1].duration;
    }
    // Back out a moment after the last click, unless the next run starts soon after.
    const next = runs[n + 1];
    const leave = Math.min(length - OUT, Math.max(still, run[run.length - 1][0] + 1.6));
    if (leave >= still && (!next || next[0][0] - IN - 0.25 > leave + OUT)) {
      out.push({ targets: "camera", at: r4(leave), duration: OUT, ease: "ease-in-out", to: { zoom: 1, x: 0.5, y: 0.5 }, auto: true });
      cam = null;
      still = leave + OUT;
    }
  });
  return out;
}

/** The macOS cursors, drawn: an arrow, a text I-beam, a pointing hand (each a viewBox and paths, and where its point is). */
export const CURSOR_ART: Record<string, { box: [number, number]; hot: [number, number]; svg: string }> = {
  arrow: {
    box: [12, 19],
    hot: [0.6, 0.6],
    svg: `<path d="M0.6 0.6 L0.6 15.6 L4.2 12.2 L6.6 17.8 L9 16.8 L6.7 11.3 L11.4 11.3 Z" fill="#000" stroke="#fff" stroke-width="1.1" stroke-linejoin="round"/>`,
  },
  text: {
    box: [8, 18],
    hot: [4, 9],
    svg: `<path d="M1 1.2 C2.6 1.2 3.4 1.6 4 2.4 C4.6 1.6 5.4 1.2 7 1.2 M4 2.4 V15.6 M1 16.8 C2.6 16.8 3.4 16.4 4 15.6 C4.6 16.4 5.4 16.8 7 16.8 M2.4 9 H5.6" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round"/><path d="M1 1.2 C2.6 1.2 3.4 1.6 4 2.4 C4.6 1.6 5.4 1.2 7 1.2 M4 2.4 V15.6 M1 16.8 C2.6 16.8 3.4 16.4 4 15.6 C4.6 16.4 5.4 16.8 7 16.8 M2.4 9 H5.6" fill="none" stroke="#000" stroke-width="1.1" stroke-linecap="round"/>`,
  },
  hand: {
    box: [16, 18],
    hot: [5.6, 1],
    svg: `<path d="M4.6 9.4 V2.6 C4.6 1.1 6.9 1.1 6.9 2.6 V7.6 V6.4 C6.9 5 9.1 5 9.1 6.4 V7.8 V7 C9.1 5.7 11.3 5.7 11.3 7 V8.4 V7.8 C11.3 6.6 13.4 6.6 13.4 7.8 V12.2 C13.4 14.8 12 17 9.2 17 H7.6 C5.8 17 4.8 16.2 3.8 14.8 L1.4 11.4 C0.6 10.2 2.1 9 3.1 9.9 Z" fill="#fff" stroke="#000" stroke-width="1" stroke-linejoin="round"/><path d="M6.9 7.6 V11.4 M9.1 7.8 V11.4 M11.3 8.4 V11.4" stroke="#000" stroke-width="0.9" stroke-linecap="round"/>`,
  },
  grab: {
    box: [16, 17],
    hot: [8, 8],
    svg: `<path d="M3.2 8.6 V5.4 C3.2 4.2 5 4.2 5 5.4 V3.4 C5 2.2 6.9 2.2 6.9 3.4 V2.6 C6.9 1.4 8.9 1.4 8.9 2.6 V3.6 C8.9 2.4 10.8 2.4 10.8 3.6 V6.2 C10.8 5 12.7 5 12.7 6.2 V10.6 C12.7 13.6 11.1 16 8.2 16 H7.2 C5.4 16 4.4 15.2 3.6 13.8 L1.6 10.6 C1 9.6 2.4 8.6 3.2 9.4 Z" fill="#fff" stroke="#000" stroke-width="1" stroke-linejoin="round"/>`,
  },
  grabbing: {
    box: [16, 15],
    hot: [8, 7],
    svg: `<path d="M3.4 7 C3.4 5.8 5.2 5.8 5.2 7 V6 C5.2 4.8 7.1 4.8 7.1 6 V5.6 C7.1 4.4 9.1 4.4 9.1 5.6 V6 C9.1 4.8 11 4.8 11 6 V6.8 C11 5.8 12.8 5.8 12.8 6.8 V9.6 C12.8 12.4 11.2 14.2 8.4 14.2 H7.4 C5.4 14.2 4.4 13.2 3.8 11.8 L2.8 9.6 C2.4 8.6 3.4 8 3.4 7 Z" fill="#fff" stroke="#000" stroke-width="1" stroke-linejoin="round"/>`,
  },
};
