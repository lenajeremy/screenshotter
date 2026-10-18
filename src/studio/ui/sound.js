// The video's sound, on its own row of the timeline: pieces of sound to move, trim, cut and turn
// down, each a stretch of a file (a recording's voice, to start with) placed at a time. One row, so
// pieces never overlap: each moves and stretches only into the room beside it. The export plays
// exactly these pieces; the editor plays them in step with the playhead.
import { useEffect, useRef, useState } from "preact/hooks";
import { html } from "./controls.js";
import { openMenu } from "./menu.js";
import { S, api, clamp, edit, fileUrl, set, useStore } from "./store.js";
import { tidyCuts, toSource } from "./cuts.js";

export const SOUND = "sound";
/** The shortest a piece can be, in seconds. */
const MIN = 0.1;
const r3 = (v) => Math.round(v * 1000) / 1000;

/** The recording's video, where its sound is (remembered by the design; older ones: the first device's). */
export const recordingVideo = (scene = S.scene) => scene.recording?.video ?? scene.devices?.[0]?.video;
/** The parts cut out of the recording's footage (its devices carry them). */
const takeCuts = (scene = S.scene) => tidyCuts(scene.devices?.find((d) => d.video && d.cuts?.length)?.cuts);
/** The video the canvas plays as the recording, whose own sound the editor plays. */
const masterVideo = (scene = S.scene) => (scene.recording ? scene.devices?.[0]?.video : undefined);

// Each file's waveform ({ duration, rate, peaks }), fetched once: { promise, value, missing }.
const waves = new Map();

/** How long a file's sound runs: its waveform's length once read, else the recording's; unknown: undefined. */
export function sourceLength(src, scene = S.scene) {
  const w = waves.get(src)?.value;
  if (w?.duration > 0) return w.duration;
  if (src === recordingVideo(scene) && scene.recording?.duration) return scene.recording.duration + takeCuts(scene).reduce((n, k) => n + k.to - k.from, 0);
  return undefined;
}

/** Where a piece ends in its file: as given, else the file's end (until that's known, the video's). */
export const toOf = (c, scene = S.scene) => c.to ?? sourceLength(c.src, scene) ?? (c.from ?? 0) + Math.max(MIN, (scene.recording?.duration ?? 10) - c.at);
export const pieceLength = (c, scene = S.scene) => Math.max(0, toOf(c, scene) - (c.from ?? 0));
const endOf = (c, scene = S.scene) => c.at + pieceLength(c, scene);

/** The pieces: the design's own, or (until one's changed) the recording's whole sound from the start. */
export function soundClips(scene = S.scene) {
  if (scene.sounds) return scene.sounds;
  const src = recordingVideo(scene);
  return scene.recording?.duration && src ? [{ src, at: 0, from: 0, to: scene.recording.duration }] : [];
}

/** Whether the design has a Sound row: a recording does, and so does a design with sound of its own. */
export const hasSoundRow = (scene = S.scene) => Boolean(scene.sounds || (scene.recording?.duration && recordingVideo(scene)));

/** Whether the sound plays at all (a recording's can be turned off in its panel). */
const soundOn = (scene = S.scene) => scene.recording?.sound !== false;

/**
 * Change the pieces. They're made the design's own first (each with its end written down), then
 * kept in time order with the chosen piece still chosen. `fn` may return a piece to choose instead.
 */
export function editSounds(fn, key) {
  const chosen = S.soundSel;
  let pick = chosen;
  const start = soundClips(S.scene).map((c) => ({ ...c }));
  edit((d) => {
    d.sounds = (d.sounds ?? start).map((c) => ({ ...c, from: c.from ?? 0, to: c.to ?? r3(toOf(c, d)) }));
    const was = chosen != null ? d.sounds[chosen] : undefined;
    const now = fn(d.sounds);
    d.sounds.sort((a, b) => a.at - b.at);
    const want = now ?? was;
    pick = want ? d.sounds.indexOf(want) : null;
  }, key);
  if (pick !== chosen) set({ soundSel: pick != null && pick >= 0 ? pick : null });
}

export const selectSound = (i) => set({ soundSel: i, animSel: null, animRows: [SOUND], rightOpen: true });

const inside = (c, t) => Boolean(c) && t > c.at + 0.05 && t < endOf(c) - 0.05;

/** The piece sounding at `t` (the later one, where they overlap); -1 for none. */
export function pieceAt(t, list = soundClips()) {
  for (let i = list.length - 1; i >= 0; i--) if (inside(list[i], t)) return i;
  return -1;
}

/**
 * The room piece `i` has on the row: from the end of the piece before it to the start of the one
 * after. Pieces that already overlap (written that way by hand) aren't pushed apart.
 */
function room(list, i) {
  const c = list[i];
  let lo = 0;
  let hi = Infinity;
  list.forEach((o, k) => {
    if (k === i) return;
    if (o.at < c.at || (o.at === c.at && k < i)) lo = Math.max(lo, endOf(o));
    else hi = Math.min(hi, o.at);
  });
  return { lo: Math.min(lo, c.at), hi: Math.max(hi, endOf(c)) };
}

/** Cut a piece in two at `t`: the chosen one, or the one sounding then. Whether it could. */
export function splitSound(t) {
  const list = soundClips();
  const i = S.soundSel != null && inside(list[S.soundSel], t) ? S.soundSel : pieceAt(t, list);
  if (i < 0) return false;
  editSounds((l) => {
    const a = l[i];
    const cut = r3(a.from + (t - a.at));
    const b = { ...a, at: r3(t), from: cut };
    // The fades stay at the outer ends.
    delete b.fadeIn;
    a.to = cut;
    delete a.fadeOut;
    l.splice(i + 1, 0, b);
    return b;
  });
  set({ animSel: null, animRows: [SOUND] });
  return true;
}

export function deleteSound(i) {
  if (!soundClips()[i]) return;
  editSounds((l) => void l.splice(i, 1));
  set({ soundSel: null });
}

/** Move piece `i` to start at `at`, as far as its room allows (and never past the video's end). */
export function placeSound(i, at, len = Infinity, key) {
  const list = soundClips();
  const c = list[i];
  if (!c) return;
  const { lo, hi } = room(list, i);
  const next = r3(clamp(at, Math.max(0, lo), Math.max(lo, Math.min(hi - pieceLength(c), len - MIN))));
  if (next !== c.at) editSounds((l) => void (l[i].at = next), key);
}

/** Nudge the chosen piece by `dt` seconds (the arrow keys). */
export function nudgeSound(dt, len) {
  const i = S.soundSel;
  const c = soundClips()[i];
  if (c) placeSound(i, c.at + dt, len, `sound${i}.nudge`);
}

/** The recording's sound back as it came: one piece, the whole of it. */
export function resetSounds() {
  edit((d) => {
    delete d.sounds;
  });
  set({ soundSel: null });
}

// ---------------------------------------------------------------------------------------------
// Playing. A piece where it was recorded (cut or trimmed, not moved) plays from the recording
// itself, turned up and down: in step, lips and all. A moved piece plays on an <audio> of its own.

/** Whether a piece plays where it was recorded, from the recording the canvas shows. */
const inPlace = (c, scene = S.scene) => {
  if (c.src !== masterVideo(scene)) return false;
  // Parts cut out of the footage: the recording shows the file's moment `toSource(t)` at `t`.
  const cuts = takeCuts(scene);
  return Math.abs(toSource(c.at, cuts) - c.from) < 0.005 && !cuts.some((k) => k.from > c.from + 0.005 && k.from < toOf(c, scene) - 0.005);
};

/** How loud a piece is `u` seconds into it: its volume, faded at its ends (as the export fades it). */
const gainAt = (c, u) => {
  const len = pieceLength(c);
  const fin = c.fadeIn ? clamp(u / Math.min(c.fadeIn, len), 0, 1) : 1;
  const fout = c.fadeOut ? clamp((len - u) / Math.min(c.fadeOut, len), 0, 1) : 1;
  return (c.volume ?? 1) * fin * fout;
};

/** How loud the recording's own sound plays at `t`: as its pieces there say, silent between them. */
export function recordingGain(t) {
  if (!hasSoundRow()) return 1;
  if (!soundOn()) return 0;
  let g = 0;
  for (const c of soundClips()) if (inPlace(c) && t >= c.at && t < endOf(c)) g = Math.max(g, gainAt(c, t - c.at));
  return Math.min(1, g);
}

const players = [];

/** Plays (or stops) the moved pieces for the playhead at `t`. */
export function followSound(t, playing) {
  const list = S.timelineOpen && hasSoundRow() && soundOn() ? soundClips().filter((c) => !inPlace(c)) : [];
  while (players.length > list.length) {
    const a = players.pop();
    a.pause();
    a.removeAttribute("src");
    a.load();
  }
  list.forEach((c, i) => {
    let a = players[i];
    if (!a) {
      a = players[i] = new Audio();
      a.preload = "auto";
    }
    const url = fileUrl(c.src);
    if (a.dataset.src !== url) {
      a.dataset.src = url;
      a.src = url;
    }
    const u = t - c.at;
    if (!playing || u < 0 || u >= pieceLength(c)) {
      if (!a.paused) a.pause();
      a.playbackRate = 1;
      delete a.dataset.settle;
      return;
    }
    a.volume = clamp(gainAt(c, u), 0, 1);
    const want = c.from + u;
    if (a.paused) {
      a.currentTime = want;
      a.dataset.settle = String(want);
      a.play().catch(() => undefined);
      return;
    }
    // In step with the playhead. Just started, it lines up once (starting takes a moment); then
    // well off, it jumps, and a little off, it runs a touch faster or slower until it's back.
    const off = a.currentTime - want;
    if (a.dataset.settle && a.currentTime > Number(a.dataset.settle) + 0.05 && !a.seeking) {
      delete a.dataset.settle;
      if (Math.abs(off) > 0.03) a.currentTime = want + 0.02;
      return;
    }
    if (Math.abs(off) > 0.25) {
      a.currentTime = want;
      a.playbackRate = 1;
    } else if (Math.abs(off) > 0.05) a.playbackRate = off > 0 ? 0.97 : 1.03;
    else if (Math.abs(off) < 0.015) a.playbackRate = 1;
  });
}

/** What's playing, for the tests: each moved piece's player. */
export const soundPlayers = () => players.map((a) => ({ t: a.currentTime, paused: a.paused, volume: a.volume }));

// ---------------------------------------------------------------------------------------------
// The row

/** A file's waveform, fetched once; `missing` when the file isn't there any more. */
function useWave(src) {
  const [w, setW] = useState(() => waves.get(src));
  useEffect(() => {
    let live = true;
    let p = waves.get(src);
    if (!p) {
      p = { promise: null, value: undefined, missing: false };
      p.promise = api(`/api/waveform?path=${encodeURIComponent(src)}`).then(
        (v) => (p.value = v),
        () => ((p.missing = true), (p.value = { duration: 0, rate: 50, peaks: [] })),
      );
      waves.set(src, p);
    }
    p.promise.then(() => live && setW({ ...p }));
    return () => {
      live = false;
    };
  }, [src]);
  return w;
}

/**
 * The pieces on the Sound row, `pps` pixels a second, in a video `len` seconds long. `now()` is the
 * playhead; `cut()` cuts there and `play(piece)` plays one piece (both the timeline's).
 */
export function SoundPieces({ pps, len, now, cut, play }) {
  const s = useStore();
  const list = soundClips(s.scene);
  const off = !soundOn(s.scene);
  if (!list.length)
    return html`<span class="tl-sound-none">No sound. ${s.scene.sounds && s.scene.recording ? html`<button class="link" onPointerDown=${(e) => e.stopPropagation()} onClick=${resetSounds}>Put the recording's back</button>` : ""}</span>`;
  return list.map((c, i) => html`<${Piece} key=${`${i}:${c.src}`} c=${c} i=${i} pps=${pps} len=${len} now=${now} cut=${cut} play=${play} on=${s.soundSel === i} off=${off} />`);
}

function Piece({ c, i, pps, len, now, cut, play, on, off }) {
  const wave = useWave(c.src);
  const canvas = useRef();
  const long = pieceLength(c);
  const w = Math.max(6, long * pps);
  useEffect(() => draw(canvas.current, wave?.value, c, w), [wave, c.from, c.to, w, on]);
  const name = wave?.missing
    ? "The sound's file isn't there any more (moved or deleted)"
    : wave?.value && !wave.value.peaks.length
      ? "No sound in this recording"
      : `Sound from ${clock(c.from)} to ${clock(c.from + long)}${c.volume !== undefined && c.volume !== 1 ? `, at ${Math.round(c.volume * 100)}%` : ""}`;
  const menu = (e) => {
    e.preventDefault();
    e.stopPropagation();
    selectSound(i);
    openMenu(e.clientX, e.clientY, [
      { label: "Cut at the playhead", icon: "scissors", kbd: "⌘B", run: cut },
      { label: "Play this piece", icon: "play", run: () => play(c) },
      "-",
      { label: "Delete this piece", icon: "trash", kbd: "⌫", danger: true, run: () => deleteSound(i) },
    ]);
  };
  return html`<div class="tl-sound ${on ? "on" : ""} ${off ? "off" : ""} ${wave?.missing ? "missing" : ""}" style=${{ left: c.at * pps + "px", width: w + "px" }}
    title=${`${name}. Drag to move it, its ends to trim it; ⌘B cuts it at the playhead.`}
    onPointerDown=${(e) => drag(e, i, "move", pps, len, now)} onContextMenu=${menu}>
    <canvas ref=${canvas}></canvas>
    ${(c.fadeIn || c.fadeOut) && long > 0 && html`<svg class="tl-fades" viewBox="0 0 100 10" preserveAspectRatio="none">${c.fadeIn ? html`<path d=${`M0 10 L${Math.min(100, (c.fadeIn / long) * 100)} 0 L0 0Z`} />` : ""}${c.fadeOut ? html`<path d=${`M100 10 L${Math.max(0, 100 - (c.fadeOut / long) * 100)} 0 L100 0Z`} />` : ""}</svg>`}
    <i class="tl-trim at-start" title="Drag to trim the start" onPointerDown=${(e) => drag(e, i, "start", pps, len, now)}></i>
    <i class="tl-trim at-end" title="Drag to trim the end" onPointerDown=${(e) => drag(e, i, "end", pps, len, now)}></i>
  </div>`;
}

const clock = (t) => `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, "0")}`;

/** The waveform of the piece's stretch of its file, a bar per pixel. */
function draw(cv, wave, c, w) {
  if (!cv) return;
  const dpr = window.devicePixelRatio || 1;
  const W = Math.max(1, Math.min(4096, Math.round(w * dpr)));
  const H = Math.max(1, Math.round(cv.clientHeight * dpr) || 60);
  if (cv.width !== W) cv.width = W;
  if (cv.height !== H) cv.height = H;
  const g = cv.getContext("2d");
  g.clearRect(0, 0, W, H);
  if (!wave?.peaks.length) return;
  g.fillStyle = getComputedStyle(cv).color;
  const len = pieceLength(c);
  for (let x = 0; x < W; x++) {
    const a = Math.floor((c.from + (x / W) * len) * wave.rate);
    const b = Math.max(a + 1, Math.floor((c.from + ((x + 1) / W) * len) * wave.rate));
    let p = 0;
    for (let k = a; k < b && k < wave.peaks.length; k++) p = Math.max(p, wave.peaks[k]);
    const h = Math.max(dpr, (p / 100) * H * 0.72);
    g.fillRect(x, (H - h) / 2, 1, h);
  }
}

/**
 * Drag a piece to move it, or an end to trim it, within its room on the row. Edges snap to the
 * other pieces', the playhead and the start; a moved piece of the recording snaps back to where
 * it was recorded. Near the timeline's edge it scrolls; Esc puts it back as it was.
 */
function drag(e, i, mode, pps, len, now) {
  if (e.button !== 0) return;
  e.stopPropagation();
  e.preventDefault();
  selectSound(i);
  const list = soundClips();
  const c0 = { ...list[i], from: list[i].from ?? 0 };
  const long = pieceLength(c0);
  const { lo, hi } = room(list, i);
  const total = sourceLength(c0.src) ?? Infinity;
  const edges = list.flatMap((c, k) => (k === i ? [] : [c.at, endOf(c)])).concat([0, now()]);
  const home = c0.src === recordingVideo() ? c0.from : null;
  const near = (t, extra = []) => {
    let best = t;
    let gap = 8 / pps;
    for (const x of [...edges, ...extra]) if (Math.abs(x - t) < gap) (gap = Math.abs(x - t)), (best = x);
    return best;
  };
  const body = e.currentTarget.closest(".tl-body");
  const scroll0 = body?.scrollLeft ?? 0;
  const x0 = e.clientX;
  let last = e.clientX;
  let moved = false;
  let auto = 0;
  const apply = () => {
    const dt = (last - x0 + ((body?.scrollLeft ?? 0) - scroll0)) / pps;
    editSounds((l) => {
      const c = l[i];
      if (mode === "move") {
        // Its start or its end snaps, whichever is nearer something to snap to.
        const raw = c0.at + dt;
        const a = near(raw, home !== null ? [home] : []);
        const b = near(raw + long) - long;
        const snapped = [a, b].filter((v) => Math.abs(v - raw) > 1e-6);
        const at = snapped.length ? snapped.reduce((p, q) => (Math.abs(q - raw) < Math.abs(p - raw) ? q : p)) : raw;
        c.at = r3(clamp(at, Math.max(0, lo), Math.max(lo, Math.min(hi - long, len - MIN))));
      } else if (mode === "start") {
        const at = clamp(near(c0.at + dt), Math.max(lo, c0.at - c0.from), c0.at + long - MIN);
        c.from = r3(c0.from + (at - c0.at));
        c.at = r3(at);
      } else {
        const end = clamp(near(c0.at + long + dt), c0.at + MIN, Math.min(hi, c0.at + (total - c0.from)));
        c.to = r3(c0.from + (end - c0.at));
      }
    }, `sound${i}.${mode}`);
  };
  // Held near the timeline's left or right edge: it scrolls, and the piece goes with it.
  const edgeScroll = () => {
    auto = 0;
    // Only when zoomed in, with more of the timeline to see.
    if (!body?.classList.contains("zoomed")) return;
    const r = body.getBoundingClientRect();
    const left = r.left + 172;
    const dir = last < left + 30 ? -1 : last > r.right - 30 ? 1 : 0;
    if (!dir) return;
    const before = body.scrollLeft;
    body.scrollLeft += dir * 12;
    if (body.scrollLeft !== before) apply();
    auto = requestAnimationFrame(edgeScroll);
  };
  const move = (m) => {
    last = m.clientX;
    if (!moved && Math.abs(m.clientX - x0) < 3) return;
    moved = true;
    apply();
    if (!auto) auto = requestAnimationFrame(edgeScroll);
  };
  const done = () => {
    cancelAnimationFrame(auto);
    removeEventListener("pointermove", move);
    removeEventListener("pointerup", done);
    removeEventListener("pointercancel", done);
    removeEventListener("keydown", esc, true);
  };
  const esc = (k) => {
    if (k.key !== "Escape") return;
    k.preventDefault();
    k.stopPropagation();
    done();
    if (moved) editSounds((l) => void Object.assign(l[i], { at: c0.at, from: c0.from, to: toOf(c0) }), `sound${i}.${mode}`);
  };
  addEventListener("pointermove", move);
  addEventListener("pointerup", done);
  addEventListener("pointercancel", done);
  addEventListener("keydown", esc, true);
}
