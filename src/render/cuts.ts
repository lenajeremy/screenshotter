// Parts of a recording taken out (a device's `cuts`): the video, its sound and its cursor play on
// without them. Pure time maps, so the Studio's timeline and the video renderer agree on where
// every moment lands.

import type { CursorLog } from "./cursor.js";

/** A part of a file taken out: seconds of the file, from and to. */
export interface Cut {
  from: number;
  to: number;
}

const r3 = (v: number) => Math.round(v * 1000) / 1000;

/** Cuts in order, merged where they touch or overlap, kept within the file (`length` when known). */
export function tidyCuts(cuts: Cut[] | undefined, length = Infinity): Cut[] {
  const list = (cuts ?? [])
    .map((c) => ({ from: Math.max(0, Math.min(c.from, c.to)), to: Math.min(length, Math.max(c.from, c.to)) }))
    .filter((c) => Number.isFinite(c.from) && c.to - c.from > 1e-3)
    .sort((a, b) => a.from - b.from);
  const out: Cut[] = [];
  for (const c of list) {
    const last = out[out.length - 1];
    if (last && c.from <= last.to + 1e-3) last.to = Math.max(last.to, c.to);
    else out.push({ from: r3(c.from), to: r3(c.to) });
  }
  return out.map((c) => ({ from: r3(c.from), to: r3(c.to) }));
}

/** How much of the file is taken out before `t` (a moment inside a cut counts up to it). */
const before = (t: number, cuts: Cut[]) => cuts.reduce((n, c) => n + Math.max(0, Math.min(t, c.to) - c.from), 0);

/** Where a moment of the file lands once the cuts are out (a moment inside a cut: where the cut was). */
export function toEdited(t: number, cuts: Cut[]): number {
  return t - before(t, cuts);
}

/** The moment of the file shown at a moment of the edited video. */
export function toSource(t: number, cuts: Cut[]): number {
  let s = t;
  for (const c of cuts) {
    if (s < c.from - 1e-9) break;
    s += c.to - c.from;
  }
  return s;
}

/** The parts kept, in order: [from, to] of the file. */
export function keptParts(cuts: Cut[], length: number): Cut[] {
  const out: Cut[] = [];
  let at = 0;
  for (const c of tidyCuts(cuts, length)) {
    if (c.from > at + 1e-3) out.push({ from: r3(at), to: r3(c.from) });
    at = Math.max(at, c.to);
  }
  if (length > at + 1e-3) out.push({ from: r3(at), to: r3(length) });
  return out;
}

/** How long the file plays with the cuts out. */
export const editedLength = (cuts: Cut[], length: number) => keptParts(cuts, length).reduce((n, p) => n + p.to - p.from, 0);

/** Whether a moment of the file is inside a cut. */
export const isCut = (t: number, cuts: Cut[]) => cuts.some((c) => t > c.from + 1e-6 && t < c.to - 1e-6);

/**
 * A cursor log with the cut parts taken out: what happened in them is gone, and what came after
 * moves up. Where it was at each cut is kept, so the cursor doesn't jump from somewhere else.
 */
export function cutLog(log: CursorLog, cuts: Cut[]): CursorLog {
  const list = tidyCuts(cuts);
  if (!list.length) return log;
  const samples: CursorLog["samples"] = [];
  for (const s of log.samples) {
    if (isCut(s[0], list)) continue;
    samples.push([r3(toEdited(s[0], list)), s[1], s[2]]);
  }
  // At each cut's end, the cursor is where it was by then (its last place inside the cut, or before).
  for (const c of list) {
    const last = [...log.samples].reverse().find((s) => s[0] <= c.to);
    if (last && isCut(last[0], list)) samples.push([r3(toEdited(c.to, list)), last[1], last[2]]);
  }
  samples.sort((a, b) => a[0] - b[0]);
  const clicks = (log.clicks ?? []).filter((c) => !isCut(c[0], list)).map((c) => [r3(toEdited(c[0], list)), c[1], c[2], c[3]] as [number, number, number, string]);
  const kinds = (log.kinds ?? []).map((k) => [r3(toEdited(k[0], list)), k[1]] as [number, string]);
  return { samples, clicks, kinds };
}
