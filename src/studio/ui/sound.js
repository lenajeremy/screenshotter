// The video's sound, on its own row of the timeline: pieces of sound to move, trim, cut and turn
// down, each a stretch of a file (a recording's voice, to start with) placed at a time. The export
// plays exactly these; the editor plays them in step with the playhead, each on an <audio> of its own.
import { useEffect, useRef, useState } from "preact/hooks";
import { html } from "./controls.js";
import { S, api, clamp, edit, fileUrl, set, useStore } from "./store.js";

export const SOUND = "sound";
const r3 = (v) => Math.round(v * 1000) / 1000;
export const pieceLength = (c) => Math.max(0, (c.to ?? 0) - (c.from ?? 0));

/** The pieces: the design's own, or (until one's changed) a recording's whole sound from the start. */
export function soundClips(scene = S.scene) {
  if (scene.sounds) return scene.sounds;
  const rec = scene.recording;
  const src = scene.devices?.[0]?.video;
  return rec?.duration && src ? [{ src, at: 0, from: 0, to: rec.duration }] : [];
}

/** Whether the design has a Sound row: a recording does, and so does a design with sound of its own. */
export const hasSoundRow = (scene = S.scene) => Boolean(scene.sounds || (scene.recording?.duration && scene.devices?.[0]?.video));

/** Whether the sound plays at all (a recording's can be turned off in its panel). */
const soundOn = (scene = S.scene) => scene.recording?.sound !== false;

/** Change the pieces. The first change makes the recording's own sound a piece of the design. */
export function editSounds(fn, key) {
  const start = soundClips(S.scene).map((c) => ({ ...c }));
  edit((d) => {
    d.sounds = d.sounds ?? start;
    fn(d.sounds);
  }, key);
}

export const selectSound = (i) => set({ soundSel: i, animSel: null, animRows: [SOUND], rightOpen: true });

const inside = (c, t) => Boolean(c) && t > c.at + 0.05 && t < c.at + pieceLength(c) - 0.05;

/** The piece sounding at `t` (the one added last, where they overlap); -1 for none. */
export function pieceAt(t, list = soundClips()) {
  for (let i = list.length - 1; i >= 0; i--) if (inside(list[i], t)) return i;
  return -1;
}

/** Cut a piece in two at `t`: the selected one, or the one sounding then. Whether it could. */
export function splitSound(t) {
  const list = soundClips();
  const i = S.soundSel !== null && inside(list[S.soundSel], t) ? S.soundSel : pieceAt(t, list);
  if (i < 0) return false;
  const cut = r3(list[i].from + (t - list[i].at));
  editSounds((l) => {
    const a = l[i];
    const b = { ...a, at: r3(t), from: cut };
    // The fades stay at the outer ends.
    delete b.fadeIn;
    a.to = cut;
    delete a.fadeOut;
    l.splice(i + 1, 0, b);
  });
  set({ soundSel: i + 1, animSel: null, animRows: [SOUND] });
  return true;
}

export function deleteSound(i) {
  editSounds((l) => l.splice(i, 1));
  set({ soundSel: null });
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
const inPlace = (c, scene = S.scene) => c.src === scene.devices?.[0]?.video && Math.abs(c.at - c.from) < 0.005;

/** How loud the recording's own sound plays at `t`: as its pieces there say, silent between them. */
export function recordingGain(t) {
  if (!hasSoundRow()) return 1;
  if (!soundOn()) return 0;
  let g = 0;
  for (const c of soundClips()) if (inPlace(c) && t >= c.at && t < c.at + pieceLength(c)) g = Math.max(g, gainAt(c, t - c.at));
  return Math.min(1, g);
}

const players = [];
/** How loud a piece is `u` seconds into it: its volume, faded at its ends. */
const gainAt = (c, u) => (c.volume ?? 1) * Math.max(0, Math.min(1, c.fadeIn ? u / c.fadeIn : 1, c.fadeOut ? (pieceLength(c) - u) / c.fadeOut : 1));

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

/** What's playing, for the tests: each piece's player. */
export const soundPlayers = () => players.map((a) => ({ t: a.currentTime, paused: a.paused, volume: a.volume }));

// ---------------------------------------------------------------------------------------------
// The row

const waves = new Map();
/** A file's waveform ({ duration, rate, peaks }), fetched once. */
function useWave(src) {
  const [w, setW] = useState(() => waves.get(src)?.value);
  useEffect(() => {
    let live = true;
    let p = waves.get(src);
    if (!p) {
      p = { promise: api(`/api/waveform?path=${encodeURIComponent(src)}`).catch(() => ({ duration: 0, rate: 50, peaks: [] })) };
      waves.set(src, p);
      p.promise.then((v) => (p.value = v));
    }
    p.promise.then((v) => live && setW(v));
    return () => {
      live = false;
    };
  }, [src]);
  return w;
}
export const sourceLength = (src) => waves.get(src)?.value?.duration || Infinity;

/** The pieces on the Sound row, `pps` pixels a second, in a video `len` seconds long; `now()` is the playhead. */
export function SoundPieces({ pps, len, now }) {
  const s = useStore();
  const list = soundClips(s.scene);
  const off = !soundOn(s.scene);
  if (!list.length) return html`<span class="tl-sound-none">No sound. ${s.scene.sounds ? html`<button class="link" onPointerDown=${(e) => e.stopPropagation()} onClick=${resetSounds}>Put the recording's back</button>` : ""}</span>`;
  return list.map((c, i) => html`<${Piece} key=${i} c=${c} i=${i} pps=${pps} len=${len} now=${now} on=${s.soundSel === i} off=${off} />`);
}

function Piece({ c, i, pps, len, now, on, off }) {
  const wave = useWave(c.src);
  const canvas = useRef();
  const w = Math.max(6, pieceLength(c) * pps);
  useEffect(() => draw(canvas.current, wave, c, w), [wave, c.from, c.to, w, on]);
  const silent = wave && !wave.peaks.length;
  const name = `${silent ? "No sound in this recording" : `Sound from ${clock(c.from)} to ${clock(c.to)}`}${c.volume !== undefined && c.volume !== 1 ? ` at ${Math.round(c.volume * 100)}%` : ""}`;
  return html`<div class="tl-sound ${on ? "on" : ""} ${off ? "off" : ""}" style=${{ left: c.at * pps + "px", width: w + "px" }}
    title=${`${name}. Drag to move it, its ends to trim it; ⌘B cuts it at the playhead.`}
    onPointerDown=${(e) => drag(e, i, "move", pps, len, now)}>
    <canvas ref=${canvas}></canvas>
    ${(c.fadeIn || c.fadeOut) && html`<svg class="tl-fades" viewBox="0 0 100 10" preserveAspectRatio="none">${c.fadeIn ? html`<path d=${`M0 10 L${Math.min(100, (c.fadeIn / pieceLength(c)) * 100)} 0 L0 0Z`} />` : ""}${c.fadeOut ? html`<path d=${`M100 10 L${Math.max(0, 100 - (c.fadeOut / pieceLength(c)) * 100)} 0 L100 0Z`} />` : ""}</svg>`}
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

/** Drag a piece to move it, or an end to trim it. Ends snap to the other pieces' and the playhead's. */
function drag(e, i, mode, pps, len, now) {
  if (e.button !== 0) return;
  e.stopPropagation();
  selectSound(i);
  const list = soundClips();
  const c0 = { ...list[i] };
  const long = pieceLength(c0);
  const edges = list.flatMap((c, k) => (k === i ? [] : [c.at, c.at + pieceLength(c)])).concat([0, now()]);
  const near = (t) => {
    let best = t;
    let gap = 8 / pps;
    for (const x of edges) if (Math.abs(x - t) < gap) (gap = Math.abs(x - t)), (best = x);
    return best;
  };
  const x0 = e.clientX;
  let moved = false;
  const move = (m) => {
    if (!moved && Math.abs(m.clientX - x0) < 3) return;
    moved = true;
    const dt = (m.clientX - x0) / pps;
    editSounds((l) => {
      const c = l[i];
      if (mode === "move") {
        const a = near(c0.at + dt);
        const b = near(c0.at + long + dt) - long;
        const at = Math.abs(a - (c0.at + dt)) <= Math.abs(b - (c0.at + dt)) ? a : b;
        c.at = r3(clamp(at, 0, Math.max(0, len - 0.1)));
      } else if (mode === "start") {
        const d = clamp(near(c0.at + dt) - c0.at, Math.max(-c0.from, -c0.at), long - 0.1);
        c.at = r3(c0.at + d);
        c.from = r3(c0.from + d);
      } else {
        const end = near(c0.at + long + dt);
        c.to = r3(clamp(c0.from + (end - c0.at), c0.from + 0.1, sourceLength(c0.src)));
      }
    }, `sound${i}.${mode}`);
  };
  const up = () => {
    removeEventListener("pointermove", move);
    removeEventListener("pointerup", up);
  };
  addEventListener("pointermove", move);
  addEventListener("pointerup", up);
}
