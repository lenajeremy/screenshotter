// A recording's footage on the timeline's Footage row: cut it at the playhead into parts, and take
// a part out. Everything after moves up, so the video plays on without it: its screen and webcam,
// its sound, its cursor, and the zooms, webcam moves and animations on the timeline. The recording's
// file is never changed; its devices carry the parts taken out (`cuts`), which the export takes out
// the same way. Where the parts were cut but nothing's gone yet is the design's `footage.splits`.
import { editedLength, isCut, keptParts, tidyCuts, toEdited, toSource } from "./cuts.js";
import { S, edit, set, toast } from "./store.js";
import { soundClips, toOf } from "./sound.js";
import { playhead, setPlayhead, videoLength } from "./timeline.js";

const r3 = (v) => Math.round(v * 1000) / 1000;
/** The shortest part a cut leaves, in seconds. */
const MIN = 0.1;

/** Whether the screen on the canvas has footage to cut: a recording. */
export const cuttable = (scene = S.scene) => Boolean(scene.recording?.duration && scene.recording.video);

/** The parts taken out of the recording (the same on its screen and its webcam). */
export function cutsOf(scene = S.scene) {
  const d = scene.devices?.find((x) => x.video && x.cuts?.length);
  return tidyCuts(d?.cuts);
}

/** How long the recording's file runs: its edited length and what's been taken out. */
export const fileLength = (scene = S.scene) => (scene.recording?.duration ?? 0) + cutsOf(scene).reduce((n, c) => n + c.to - c.from, 0);

/** The moment of the recording's file that shows at `t` on the timeline. */
export const sourceAt = (t, scene = S.scene) => toSource(t, cutsOf(scene));

/** The footage's parts: each stretch of the file kept, split where it's been cut. `at` is on the timeline. */
export function footageParts(scene = S.scene) {
  if (!cuttable(scene)) return [];
  const cuts = cutsOf(scene);
  const splits = scene.footage?.splits ?? [];
  const out = [];
  for (const k of keptParts(cuts, fileLength(scene))) {
    const marks = splits.filter((t) => t > k.from + 0.02 && t < k.to - 0.02).sort((a, b) => a - b);
    let a = k.from;
    for (const m of [...marks, k.to]) {
      out.push({ from: a, to: m, at: r3(toEdited(a, cuts)) });
      a = m;
    }
  }
  return out;
}

/** The part under the playhead, if any. */
export const partAt = (t, scene = S.scene) => footageParts(scene).findIndex((p) => t >= p.at - 1e-6 && t < p.at + (p.to - p.from) - 1e-6);

/** Choose a part (its settings show on the right). */
export const selectPart = (i) => set({ footageSel: i, animRows: ["footage"], animSel: null, soundSel: null, selected: null, rightOpen: true });

/** Cut the footage in two at the playhead. True when it did. */
export function cutFootageHere() {
  if (!cuttable()) return false;
  const t = playhead.t;
  const parts = footageParts();
  const i = partAt(t);
  const p = parts[i];
  const src = r3(sourceAt(t));
  if (!p || src - p.from < MIN || p.to - src < MIN) {
    toast({ kind: "info", icon: "scissors", title: "Nothing to cut here", text: "Move the playhead into the footage, away from where it's already cut." });
    return false;
  }
  edit((d) => {
    d.footage = { ...(d.footage ?? {}), splits: [...(d.footage?.splits ?? []), src].sort((a, b) => a - b) };
  });
  selectPart(i + 1);
  return true;
}

/**
 * Take the stretch from `a` to `b` (seconds on the timeline, within the footage) out of the video:
 * the recording skips it, and everything after moves up by its length. Things that start inside it
 * go with it; sound running over it is trimmed round it.
 */
export function removeSpan(a, b) {
  if (!cuttable()) return;
  const cuts = cutsOf();
  const span = r3(b - a);
  if (span < 0.01) return;
  const from = r3(toSource(a, cuts));
  const to = r3(toSource(b - 1e-6, cuts) + 1e-6);
  if (editedLength(tidyCuts([...cuts, { from, to }]), fileLength()) < MIN) {
    toast({ kind: "warn", title: "That's all of it", text: "Keep at least part of the recording." });
    return;
  }
  // The sound as it plays now, each piece with its end written down.
  const pieces = soundClips(S.scene).map((c) => ({ ...c, from: c.from ?? 0, to: r3(toOf(c)) }));
  edit((d) => {
    const next = tidyCuts([...cuts, { from, to }]);
    for (const dev of d.devices) if (dev.video) dev.cuts = next;
    d.recording.duration = r3(Math.max(MIN, d.recording.duration - span));
    if (d.footage?.splits) {
      d.footage.splits = d.footage.splits.filter((t) => !isCut(t, next) && Math.abs(t - from) > 1e-3 && Math.abs(t - to) > 1e-3);
      if (!d.footage.splits.length) delete d.footage;
    }
    // Animations (zooms, webcam moves and the rest): later ones move up; ones starting inside go.
    if (d.animations) {
      d.animations = d.animations.filter((x) => !(x.at >= a - 1e-6 && x.at < b - 1e-6)).map((x) => (x.at >= b - 1e-6 ? { ...x, at: r3(x.at - span) } : x));
      if (!d.animations.length) delete d.animations;
    }
    // Sound: later pieces move up; a piece over the stretch loses that part of it.
    const out = [];
    for (const c of pieces) {
      const end = c.at + (c.to - c.from);
      if (end <= a + 1e-6) out.push(c);
      else if (c.at >= b - 1e-6) out.push({ ...c, at: r3(c.at - span) });
      else {
        if (c.at < a) out.push({ ...c, to: r3(c.from + (a - c.at)), fadeOut: undefined });
        if (end > b) out.push({ ...c, at: r3(Math.max(a, c.at)), from: r3(c.from + (b - c.at)), fadeIn: undefined });
      }
    }
    d.sounds = out.filter((c) => c.to - c.from >= 0.02).map((c) => Object.fromEntries(Object.entries(c).filter(([, v]) => v !== undefined)));
  });
  set({ footageSel: null, soundSel: null, animSel: null });
  setPlayhead(Math.min(a, videoLength()));
}

/** Take a part of the footage out (see removeSpan). */
export function deleteFootagePart(i) {
  const p = footageParts()[i];
  if (!p) return;
  if (footageParts().length < 2) {
    toast({ kind: "info", icon: "scissors", title: "Cut it first", text: "Move the playhead to where the part you don't want starts and press ⌘B, then where it ends and ⌘B again. Then delete the part between." });
    return;
  }
  removeSpan(p.at, p.at + (p.to - p.from));
}
