// Animate: when each item appears, changes and leaves in a video. A timeline under the canvas
// (a row per item, a bar per animation, a playhead), the editor for the selected animation, and
// the live preview: the canvas shows the design at the playhead, worked out by the same engine
// the video renderer uses (/ui/animate.js).
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { ColorButton, Dropdown, Num, Popover, Section, Seg, Slider, Switch, html } from "./controls.js";
import { openMenu } from "./menu.js";
import { Icon } from "./icons.js";
import { S, TRANSITION_NAMES, api, clamp, edit, entityLabel, persistPrefs, set, toast, useStore, hasDesign } from "./store.js";
import { BACKDROP, DEFAULT_BLUR, DEFAULT_PATH_SIZE, backdropStyle, defaultEase, evaluateBackdrop, pathRoute, playsOf, CALLOUT, CAMERA, DEFAULT_DURATION, DEFAULT_EACH, EASES, animationEnd, cameraFor, cameraTransform, cameraView, ease as easeAt, entityCentre, evaluate, evaluateCamera, targetsOf, timelineEnd } from "./animate.js";
import { renderShape } from "./shapes.js";
import { addShot, deleteShot, goToShot, moveShot, previewShots, screenName, setInVideo, updateShot } from "./actions.js";
import { cameraFollow } from "./recording.js";
import { SOUND, SoundPieces, deleteSound, editSounds, followSound, hasSoundRow, pieceLength, placeSound, recordingGain, recordingVideo, resetSounds, soundClips, splitSound } from "./sound.js";

// ---------------------------------------------------------------------------------------------
// The playhead lives outside the store: it moves every frame while playing, and only the canvas
// preview and the timeline's own line need to follow it.

export const playhead = { t: 0 };
const followers = new Set();
export function onPlayhead(fn) {
  followers.add(fn);
  return () => followers.delete(fn);
}
/** Move the playhead within the shot on the canvas (in a video of several, the video's clock follows). */
export function setPlayhead(t) {
  playhead.t = Math.max(0, t);
  // A screen left out of the video keeps its own time: the video's clock stays where it was.
  if (manyShots() && !offVideo()) {
    const plan = videoPlan();
    video.T = plan.starts[S.shot] + playhead.t;
    for (const fn of videoFollowers) fn(video.T, plan);
  }
  for (const fn of followers) fn(playhead.t);
}

// ---------------------------------------------------------------------------------------------
// A video of several shots: one clock for the whole video. The canvas shows whatever is on screen
// at that moment (another shot, or two mid-transition); the shot on the canvas keeps its own time.

export const video = { T: 0 };
const videoFollowers = new Set();
export function onVideoTime(fn) {
  videoFollowers.add(fn);
  return () => videoFollowers.delete(fn);
}
export const manyShots = () => S.shots?.length > 1;

/** Where each shot starts and how long it runs, joined the way the export joins them. */
export function videoPlan() {
  const shots = S.shots.map((x, i) => (i === S.shot ? { ...x, scene: S.scene } : x));
  // A screen left out of the video takes no time (unless every one is: then they all play).
  const out = shots.map((x) => x.video === false);
  if (out.every(Boolean)) out.fill(false);
  const lengths = shots.map((x, i) => (out[i] ? 0 : i === S.shot ? videoLength() : shotLength(x)));
  // Each shot comes in from the last one that plays before it.
  let prev = -1;
  const joins = shots.map((x, i) => {
    if (out[i]) return { type: null, duration: 0 };
    const from = prev;
    prev = i;
    if (from < 0) return { type: null, duration: 0 };
    const t = x.transition ?? { type: "fade", duration: 0.5 };
    return { type: t.type, duration: t.type === "cut" ? 0 : Math.min(t.duration ?? 0.5, 0.45 * lengths[from], 0.45 * lengths[i]) };
  });
  const starts = [0];
  for (let i = 1; i < shots.length; i++) starts.push(starts[i - 1] + lengths[i - 1] - joins[i].duration);
  return { shots, lengths, joins, starts, out, total: starts[shots.length - 1] + lengths[shots.length - 1] };
}

/** Whether the shot on the canvas is left out of the video (it's edited on its own then). */
export const offVideo = () => S.shots?.[S.shot]?.video === false && S.shots.some((x) => x.video !== false);

/** What's on screen at T: one shot, or two part way (p) through the transition between them. */
export function shotsAt(plan, T) {
  T = clamp(T, 0, plan.total);
  // Only the shots that play (screens left out of the video take no time).
  const on = plan.shots.map((_, i) => i).filter((i) => !plan.out?.[i]);
  let k = 0;
  while (k < on.length - 1 && T >= plan.starts[on[k + 1]]) k++;
  const i = on[k];
  const before = on[k - 1];
  if (k > 0 && plan.joins[i].duration > 0 && T < plan.starts[before] + plan.lengths[before]) {
    return { out: before, in: i, p: clamp((T - plan.starts[i]) / plan.joins[i].duration, 0, 1), type: plan.joins[i].type };
  }
  return { only: i };
}

/** Move the video's clock; the shot on the canvas follows with its own time (held at its ends outside it). */
export function setVideoTime(T) {
  if (!manyShots()) return setPlayhead(T);
  const plan = videoPlan();
  video.T = clamp(T, 0, plan.total);
  playhead.t = clamp(video.T - plan.starts[S.shot], 0, plan.lengths[S.shot]);
  for (const fn of followers) fn(playhead.t);
  for (const fn of videoFollowers) fn(video.T, plan);
}

/**
 * Two shots part way (p) through the transition between them, as CSS for each (and a matte behind
 * them for fades through black or white). A close match to the export's, drawn live.
 */
export function joinStyles(type, p, W, H) {
  const q = 1 - p;
  const soft = 8;
  switch (type) {
    case "fade-black":
    case "fade-white":
      return { out: { opacity: clamp(1 - 2 * p, 0, 1) }, in: { opacity: clamp(2 * p - 1, 0, 1) }, matte: type === "fade-black" ? "#000" : "#fff" };
    case "push-left":
      return { out: { transform: `translateX(${-p * W}px)`, clipPath: `inset(0 0 0 ${p * W}px)` }, in: { transform: `translateX(${q * W}px)`, clipPath: `inset(0 ${q * W}px 0 0)` } };
    case "push-right":
      return { out: { transform: `translateX(${p * W}px)`, clipPath: `inset(0 ${p * W}px 0 0)` }, in: { transform: `translateX(${-q * W}px)`, clipPath: `inset(0 0 0 ${q * W}px)` } };
    case "push-up":
      return { out: { transform: `translateY(${-p * H}px)`, clipPath: `inset(${p * H}px 0 0 0)` }, in: { transform: `translateY(${q * H}px)`, clipPath: `inset(0 0 ${q * H}px 0)` } };
    case "push-down":
      return { out: { transform: `translateY(${p * H}px)`, clipPath: `inset(0 0 ${p * H}px 0)` }, in: { transform: `translateY(${-q * H}px)`, clipPath: `inset(${q * H}px 0 0 0)` } };
    case "wipe-left": {
      const x = q * (100 + soft) - soft;
      return { out: {}, in: { maskImage: `linear-gradient(to right, transparent ${x}%, #000 ${x + soft}%)` } };
    }
    case "wipe-right": {
      const x = p * (100 + soft);
      return { out: {}, in: { maskImage: `linear-gradient(to right, #000 ${x - soft}%, transparent ${x}%)` } };
    }
    case "iris": {
      const r = (p * Math.hypot(W, H) * 1.08) / 2;
      return { out: {}, in: { maskImage: `radial-gradient(circle at 50% 50%, #000 ${Math.max(0, r - 24)}px, transparent ${r}px)` } };
    }
    case "zoom": {
      // Zooms through the old shot as it fades, trimmed to the frame.
      const z = 1 + 0.6 * p;
      const cut = (1 - 1 / z) / 2;
      return { out: { transform: `scale(${z})`, clipPath: `inset(${cut * H}px ${cut * W}px)`, opacity: q }, in: { opacity: p } };
    }
    case "blur":
      return { out: { filter: `blur(${p * 18}px)`, opacity: q }, in: { filter: `blur(${q * 18}px)`, opacity: p } };
    default:
      return { out: {}, in: { opacity: p } };
  }
}

/** How long the video runs: the length chosen, or long enough for every animation to finish. */
export function videoLength() {
  // A recording runs its own length.
  if (S.scene.recording?.duration) return S.scene.recording.duration;
  const chosen = S.exportOpts.video.duration ?? 6;
  const needed = Math.ceil((timelineEnd(S.scene.animations, animEntities()) + 1.2) * 2) / 2;
  // A shot of several: its own length when set, else as long as its animations need.
  if (S.shots?.length > 1) return Math.min(60, S.shots[S.shot]?.length ?? Math.max(chosen, S.scene.animations?.length ? needed : 0));
  return Math.min(60, Math.max(chosen, S.scene.animations?.length ? needed : 0));
}
/** A shot's length when it isn't on the canvas (its text isn't laid out, so words aren't counted). */
const shotLength = (x) => x.length ?? Math.max(S.exportOpts.video.duration ?? 6, x.scene?.animations?.length ? Math.ceil((timelineEnd(x.scene.animations) + 1.2) * 2) / 2 : 0);

// Recordings on the canvas in Animate follow the playhead: they play, sound and all, while the
// timeline plays, and show the frame at the playhead when it's scrubbed or stopped.
const seekTo = (v, t) => Math.max(0, Math.min(t, (v.duration || Infinity) - 0.05));
export function followVideo(v, t = playhead.t) {
  if (!v || !S.timelineOpen) return;
  const at = seekTo(v, t);
  // A recording sets the pace while playing (the playhead follows it): seeking it would cut up its sound.
  if (S.playing && v.dataset.master) {
    // Its sound, as the Sound row has it: silent where it's been cut out, quieter where turned down.
    const g = recordingGain(t);
    v.muted = g <= 0;
    if (g > 0 && Math.abs(v.volume - g) > 0.01) v.volume = g;
    if (v.paused) v.play().catch(() => undefined);
    return;
  }
  if (S.playing) {
    v.muted = false;
    if (v.paused) {
      v.currentTime = at;
      v.play().catch(() => undefined);
      return;
    }
    // Kept in step with the playhead (a webcam with the voice in the recording, lips and all):
    // well behind or ahead, it jumps; a little, it runs a touch faster or slower until it's back.
    const off = v.currentTime - at;
    if (Math.abs(off) > 0.3) {
      v.currentTime = at;
      v.playbackRate = 1;
    } else if (Math.abs(off) > 0.03) v.playbackRate = off > 0 ? 0.93 : 1.07;
    else if (Math.abs(off) < 0.01 && v.playbackRate !== 1) v.playbackRate = 1;
  } else {
    if (!v.paused) v.pause();
    v.playbackRate = 1;
    if (Math.abs(v.currentTime - at) > 0.02) v.currentTime = at;
  }
}
const followAll = (t) => {
  document.querySelectorAll("video[data-follow]").forEach((v) => followVideo(v, t));
  followSound(t, S.playing);
};
onPlayhead(followAll);

let raf = 0;
export function pause() {
  cancelAnimationFrame(raf);
  if (S.playing) set({ playing: false });
  followAll(playhead.t);
}
/** Play from the playhead to `until` (the end by default); from the start if already at the end. */
export function play(until) {
  if (S.playing) return pause();
  // A video of several shots plays through all of them, transitions and all.
  if (manyShots() && !offVideo() && until === undefined) {
    const total = videoPlan().total;
    if (video.T >= total - 0.02) setVideoTime(0);
    set({ playing: true });
    let last = performance.now();
    const tick = (now) => {
      const T = video.T + (now - last) / 1000;
      last = now;
      if (T >= total) {
        setVideoTime(total);
        return pause();
      }
      setVideoTime(T);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return;
  }
  const end = until ?? videoLength();
  if (playhead.t >= end - 0.02) setPlayhead(0);
  set({ playing: true });
  // A recording keeps its own pace, sound and all: the playhead follows it (waiting when it buffers).
  const master = S.scene.recording && document.querySelector("video[data-follow][data-master]");
  if (master) {
    master.muted = recordingGain(playhead.t) <= 0;
    master.currentTime = seekTo(master, playhead.t);
    master.play().catch(() => undefined);
    const follow = () => {
      const t = master.currentTime;
      if (t >= end - 0.01 || master.ended) {
        setPlayhead(Math.min(end, t));
        return pause();
      }
      setPlayhead(t);
      raf = requestAnimationFrame(follow);
    };
    raf = requestAnimationFrame(follow);
    return;
  }
  let last = performance.now();
  const tick = (now) => {
    const t = playhead.t + (now - last) / 1000;
    last = now;
    if (t >= end) {
      setPlayhead(end);
      return pause();
    }
    setPlayhead(t);
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);
}

export function openTimeline() {
  set({ timelineOpen: true, view: "canvas", stillPick: null });
}
export function closeTimeline() {
  pause();
  set({ timelineOpen: false, animSel: null, soundSel: null, animRows: [] });
}

/** Play one piece of sound, from its start to its end. */
export function playPiece(c) {
  pause();
  setPlayhead(c.at);
  play(Math.min(videoLength(), c.at + pieceLength(c)));
}

/** Cut the sound in two at the playhead (⌘B). */
export function cutSoundHere() {
  if (splitSound(playhead.t)) return true;
  toast({ kind: "info", icon: "sound", title: "No sound to cut here", text: "Move the playhead over a piece of sound on the Sound row, then cut." });
  return false;
}

// ---------------------------------------------------------------------------------------------
// The canvas preview: every animated item as it is at time t.

const toAnim = (e) => ({ id: e.id, kind: e.kind, x: e.x, y: e.y, width: e.width, height: e.height, anchor: e.anchor, align: e.align, size: e.size, color: e.color, shape: e.shape, text: e.text, subtext: e.subtext, blur: e.blur });
/** The design's items as the animation engine needs them. */
export const animEntities = () => (S.layout?.entities ?? []).map(toAnim);
const isCallout = (id) => CALLOUT.test(id);
const HL_NAMES = { lift: "Lift", outline: "Outline", "blur-rest": "Blur rest", loupe: "Loupe", spotlight: "Spotlight", blur: "Blur", highlighter: "Marker", step: "Step", arrow: "Arrow" };
/** A device's call-out by what it points at: Lift “Add a task”. */
function calloutLabel(id) {
  const m = CALLOUT.exec(id);
  const h = S.scene.devices?.[m[1] - 1]?.highlights?.[m[2] - 1];
  const text = h?.text?.trim();
  return `${HL_NAMES[h?.style] ?? "Call-out"} ${text ? `“${text.length > 18 ? text.slice(0, 17) + "…" : text}”` : m[2]}`;
}
const label = (id) => (id === CAMERA ? "Camera" : id === BACKDROP ? "Backdrop" : id === SOUND ? "Sound" : isCallout(id) ? calloutLabel(id) : entityLabel(id));
/** A device's call-outs as rows of their own, "device-1/callout-2" (counting from 1). */
const calloutRows = (e) => (S.scene.devices?.[e.index]?.highlights ?? []).map((_, k) => ({ id: `${e.id}/callout-${k + 1}`, kind: "callout" }));
/** Whether a device's soft focus is animated (the canvas then takes it from --ablur). */
export const blurAnimated = (id, scene = S.scene) => Boolean(S.timelineOpen && scene.animations?.some((a) => (a.to?.blur !== undefined || a.from?.blur !== undefined || a.enter === "blur" || a.exit === "blur") && targetsOf(a).includes(id)));

function drawShape(el, spec, art) {
  const r = renderShape(spec, art.offsetWidth, art.offsetHeight, { hit: 14 });
  Object.assign(el.style, { left: r.left + "px", top: r.top + "px", width: r.width + "px", height: r.height + "px", transform: r.rotate ? `rotate(${r.rotate}deg)` : "", filter: r.filter ?? "" });
  const svg = el.querySelector(".shape-svg");
  if (svg) svg.innerHTML = r.svg;
}

const IDLE = { opacity: 1, dx: 0, dy: 0, sx: 1, sy: 1, rotate: 0 };

/** Lay each gradient accent's gradient across its pieces (as the video does): measured untransformed. */
function paintPieces(root) {
  // A gradient accent drawn in pieces: clipped to text, it wouldn't reach the words inside it,
  // so each piece carries its own slice of the phrase's gradient, lined up across the phrase.
  const phrases = new Map();
  root.querySelectorAll(".accent[data-acc]").forEach((acc) => {
    const owner = acc.closest("[data-ent]")?.getAttribute("data-ent") ?? "";
    const key = `${owner}|${acc.dataset.acc}`;
    phrases.set(key, [...(phrases.get(key) ?? []), acc]);
  });
  for (const spans of phrases.values()) {
    const image = getComputedStyle(spans[0]).backgroundImage;
    if (!image || image === "none") continue;
    const boxes = spans.map((sp) => sp.getBoundingClientRect());
    const left = Math.min(...boxes.map((b) => b.left));
    const top = Math.min(...boxes.map((b) => b.top));
    const width = Math.max(...boxes.map((b) => b.right)) - left;
    const height = Math.max(...boxes.map((b) => b.bottom)) - top;
    for (const sp of spans) {
      sp.querySelectorAll(".u").forEach((u) => {
        const r = u.getBoundingClientRect();
        u.style.backgroundImage = image;
        u.style.backgroundSize = `${width}px ${height}px`;
        u.style.backgroundPosition = `${left - r.left}px ${top - r.top}px`;
        u.style.setProperty("-webkit-background-clip", "text");
        u.style.setProperty("background-clip", "text");
        u.style.setProperty("-webkit-text-fill-color", "transparent");
        u.style.color = "transparent";
      });
    }
  }
}

/**
 * Show the artboard's items as they are at `t` seconds (or as designed, when `on` is false).
 * Devices and text get a move, scale, turn and opacity about their own middle; shapes are
 * redrawn; a text's words or letters move on their own; and the camera moves the lot.
 */
export function applyPreview(art, on, t, shot = { scene: S.scene, layout: S.layout, held: true }) {
  const layout = shot.layout;
  if (!art || !layout) return;
  const anims = shot.scene.animations;
  const W0 = layout.canvas.width;
  const H0 = layout.canvas.height;
  const k = art.offsetWidth / W0;
  const states = on && anims?.length ? evaluate(anims, layout.entities.map(toAnim), t, W0, H0) : new Map();
  // A Change being edited: the canvas itself draws its items as they end up, to drag them there.
  const held = on && shot.held ? keyframe() : null;
  // Its soft focus as it ends (that isn't dragged, so the canvas shows it).
  const heldBlur = held && held.clip.to?.blur !== undefined ? evaluate(anims, layout.entities.map(toAnim), animationEnd(held.clip), W0, H0) : null;
  if (held) for (const id of targetsOf(held.clip)) states.delete(id);
  // The camera, except while one of its moves is being framed (the viewfinder shows that).
  const cam = on && !(held && targetsOf(held.clip).includes(CAMERA)) ? evaluateCamera(anims, t, cameraFollow(shot.scene)) : undefined;
  const ct = cam && cam.zoom > 1.0005 ? cameraTransform(cam, W0, H0) : null;
  const through = (x, y) => (ct ? { x: (x - ct.fx) * ct.zoom + ct.fx + ct.tx, y: (y - ct.fy) * ct.zoom + ct.fy + ct.ty } : { x, y });
  const bg = art.querySelector(":scope > .bg");
  if (bg) {
    bg.style.transformOrigin = ct ? `${ct.fx * k}px ${ct.fy * k}px` : "";
    bg.style.transform = ct ? `translate(${ct.tx * k}px, ${ct.ty * k}px) scale(${ct.zoom})` : "";
    // The backdrop's own move, inside the camera's.
    const move = bg.querySelector(".bg-move");
    const bd = on ? evaluateBackdrop(anims, t, W0) : undefined;
    if (move) {
      const b = bd && backdropStyle({ ...bd, blur: bd.blur * k }, W0 * k, H0 * k);
      move.style.transform = b?.transform ?? "";
      move.style.filter = b?.filter ?? "";
    }
  }
  const box = art.getBoundingClientRect();
  const camAll = ct;
  for (const el of art.querySelectorAll(":scope > .ent[data-id]")) {
    const e = layout.entities.find((x) => x.id === el.dataset.id);
    // A fixed device (a recording's webcam) stays out of the camera's moves.
    const pinned = e?.kind === "device" && shot.scene.devices?.[e.index]?.fixed;
    const ct = pinned ? null : camAll;
    const through = (x, y) => (ct ? { x: (x - ct.fx) * ct.zoom + ct.fx + ct.tx, y: (y - ct.fy) * ct.zoom + ct.fy + ct.ty } : { x, y });
    const st = states.get(el.dataset.id) ?? (ct ? IDLE : undefined);
    const blur = (st ?? heldBlur?.get(el.dataset.id))?.blur;
    if (blur !== undefined) el.style.setProperty("--ablur", `${Math.max(0, blur) * k}px`);
    else el.style.removeProperty("--ablur");
    if (!st) {
      if (el.dataset.anim) {
        delete el.dataset.anim;
        el.style.translate = el.style.scale = el.style.rotate = el.style.opacity = "";
        for (const v of ["--acolor", "--arx", "--ary", "--amark"]) el.style.removeProperty(v);
        for (const u of el.querySelectorAll(".u")) u.style.translate = u.style.scale = u.style.rotate = u.style.opacity = u.style.filter = "";
        if (e?.kind === "shape") drawShape(el, e.shape, art);
      }
      continue;
    }
    el.dataset.anim = "1";
    el.style.translate = el.style.scale = el.style.rotate = "";
    if (e?.kind === "shape") {
      drawShape(el, st.shape ?? e.shape, art);
      if (ct) {
        // The camera moves the drawn shape: its box's middle goes where the camera sends it.
        const mx = (el.offsetLeft + el.offsetWidth / 2) / k;
        const my = (el.offsetTop + el.offsetHeight / 2) / k;
        const to = through(mx, my);
        el.style.translate = `${(to.x - mx) * k}px ${(to.y - my) * k}px`;
        el.style.scale = String(ct.zoom);
      }
      continue;
    }
    // Its words or letters untransformed, and a gradient accent's slices laid across them.
    const pieces = el.querySelectorAll(".u");
    if (pieces.length) {
      pieces.forEach((u) => (u.style.translate = u.style.scale = u.style.rotate = ""));
      paintPieces(el);
    }
    // Where its visual middle sits from the point CSS scales and turns it about.
    const r = el.getBoundingClientRect();
    const origin = getComputedStyle(el).transformOrigin.split(" ").map(parseFloat);
    const vx = r.left + r.width / 2 - (box.left + el.offsetLeft + (origin[0] || 0));
    const vy = r.top + r.height / 2 - (box.top + el.offsetTop + (origin[1] || 0));
    // Its middle on the canvas, moved by its own animation and then by the camera.
    const mx = (r.left + r.width / 2 - box.left) / k;
    const my = (r.top + r.height / 2 - box.top) / k;
    const to = through(mx + st.dx, my + st.dy);
    const z = ct?.zoom ?? 1;
    const a = (st.rotate * Math.PI) / 180;
    const sx = vx * st.sx * z;
    const sy = vy * st.sy * z;
    el.style.translate = `${(to.x - mx) * k + vx - (sx * Math.cos(a) - sy * Math.sin(a))}px ${(to.y - my) * k + vy - (sx * Math.sin(a) + sy * Math.cos(a))}px`;
    el.style.scale = `${st.sx * z} ${st.sy * z}`;
    el.style.rotate = `${st.rotate}deg`;
    el.style.opacity = String(clamp(st.opacity, 0, 1));
    if (st.color) el.style.setProperty("--acolor", st.color);
    else el.style.removeProperty("--acolor");
    if (st.mark !== undefined && st.mark < 1) el.style.setProperty("--amark", String(clamp(st.mark, 0, 1)));
    else el.style.removeProperty("--amark");
    // A device's 3D tilt and turn, on top of its own (its body adds them, as the render does).
    for (const [v, n] of [["--arx", st.rotateX], ["--ary", st.rotateY]]) {
      if (n) el.style.setProperty(v, `${n}deg`);
      else el.style.removeProperty(v);
    }
    // Words or letters, each about its own middle.
    pieces.forEach((u, i) => {
      const p = st.units?.[i];
      u.style.opacity = p ? String(clamp(p.opacity, 0, 1)) : "";
      u.style.translate = p ? `${p.dx * k}px ${p.dy * k}px` : "";
      u.style.scale = p ? `${p.sx} ${p.sy}` : "";
      u.style.rotate = p ? `${p.rotate}deg` : "";
      u.style.filter = p?.blur > 0.05 ? `blur(${p.blur * k}px)` : "";
    });
  }
}

// ---------------------------------------------------------------------------------------------
// Keyframes by hand: with a Change selected, the canvas shows its items as they end up, and
// moving, resizing, turning or bending them sets what the animation changes them to.

/** The Change being edited on the canvas, if one is selected. */
export function keyframe() {
  if (!S.timelineOpen || S.animSel === null) return null;
  const clip = S.scene.animations?.[S.animSel];
  return clip && !clip.enter && !clip.exit ? { i: S.animSel, clip } : null;
}

/** An item as the selected Change leaves it: the entity to draw and drag. */
export function afterEntity(e, withShape) {
  const held = keyframe();
  const layout = S.layout;
  if (!held || !layout || !targetsOf(held.clip).includes(e.id)) return e;
  const W0 = layout.canvas.width;
  const H0 = layout.canvas.height;
  const st = evaluate(S.scene.animations, layout.entities.map(toAnim), animationEnd(held.clip), W0, H0).get(e.id);
  if (!st) return e;
  if (st.shape) return withShape(e, (sh) => Object.assign(sh, st.shape), W0, H0);
  const out = { ...e, x: e.x + st.dx / W0, y: e.y + st.dy / H0, rotate: (e.rotate || 0) + st.rotate };
  if (e.kind === "device" || e.kind === "image") Object.assign(out, { width: e.width * st.sx, height: e.height * st.sy });
  else Object.assign(out, { size: e.size * st.sy, subSize: e.subSize ? e.subSize * st.sy : e.subSize });
  return out;
}

const r3 = (v) => Math.round(v * 1000) / 1000;
const r4 = (v) => Math.round(v * 10000) / 10000;

/** Save a dragged item into the selected Change. True when it took it (so the design is left alone). */
export function commitKeyframe(e) {
  const held = keyframe();
  const layout = S.layout;
  const base = layout?.entities.find((x) => x.id === e.id);
  if (!held || !base || !targetsOf(held.clip).includes(e.id)) return false;
  const W0 = layout.canvas.width;
  const H0 = layout.canvas.height;
  // Where it was just before this change starts (earlier animations may have moved it).
  const before = evaluate(S.scene.animations, layout.entities.map(toAnim), Math.max(0, held.clip.at - 0.0001), W0, H0).get(e.id);
  edit((d) => {
    const a = d.animations?.[held.i];
    if (!a) return;
    const to = { ...(a.to ?? {}) };
    const put = (key, v, same) => {
      if (Math.abs(v - same) < 0.0005) delete to[key];
      else to[key] = v;
    };
    if (e.kind === "shape" && e.shape.type !== "arrow" && e.shape.type !== "line") {
      const g = e.shape;
      const b = base.shape;
      to.x = r4(g.x);
      to.y = r4(g.y);
      const sy = g.size / b.size;
      const sx = (g.aspect * sy) / b.aspect;
      delete to.scale;
      delete to.scaleX;
      delete to.scaleY;
      if (Math.abs(sx - sy) < 0.01) put("scale", r3(sy), 1);
      else {
        to.scaleX = r3(sx);
        to.scaleY = r3(sy);
      }
      put("rotate", Math.round((g.rotate || 0) - (b.rotate || 0)), 0);
    } else if (e.kind === "shape") {
      to.start = { x: r4(e.shape.from.x), y: r4(e.shape.from.y) };
      to.end = { x: r4(e.shape.to.x), y: r4(e.shape.to.y) };
      to.bend = Math.round(e.shape.bend * 100) / 100;
    } else if (e.kind === "device" || e.kind === "image") {
      to.x = r4(e.x);
      to.y = r4(e.y);
      put("scale", r3(e.height / base.height), 1);
      put("rotate", Math.round((e.rotate || 0) - (base.rotate || 0)), 0);
    } else {
      put("dx", r4(e.x - base.x - (before?.dx ?? 0) / W0), 0);
      put("dy", r4(e.y - base.y - (before?.dy ?? 0) / H0), 0);
      put("scale", r3(e.size / base.size), 1);
      put("rotate", Math.round((e.rotate || 0) - (base.rotate || 0)), 0);
    }
    a.to = to;
  }, null);
  return true;
}

/** Select an animation. A Change shows on the canvas as it ends, ready to drag into place. */
export function selectAnimation(i) {
  set({ animSel: i, soundSel: null, rightOpen: true });
  const a = S.scene.animations?.[i];
  if (a && !a.enter && !a.exit) {
    pause();
    setPlayhead(Math.min(videoLength(), animationEnd(a, animEntities())));
  }
}

// ---------------------------------------------------------------------------------------------
// Editing the scene's animations

const FX = { none: "Appear", fade: "Fade", zoom: "Zoom", blur: "Blur", "scale-x": "Stretch across", "scale-y": "Stretch up", "slide-up": "Slide up", "slide-down": "Slide down", "slide-left": "Slide left", "slide-right": "Slide right" };
const FX_ORDER = ["fade", "zoom", "blur", "scale-x", "scale-y", "slide-up", "slide-down", "slide-left", "slide-right", "none"];
const EASE_NAMES = { "ease-out": "Slow down", "ease-in": "Speed up", "ease-in-out": "Smooth", linear: "Steady", "back-out": "Overshoot", spring: "Spring", bounce: "Bounce" };
const kindOf = (a) => (a.enter ? "enter" : a.exit ? "exit" : a.repeat === true ? "loop" : "change");

/** Motion that keeps going for the whole video: each a Change that repeats until the end. */
const LOOPS = {
  float: { label: "Float", clip: { duration: 1.6, yoyo: true, to: { dy: -0.015 } } },
  pulse: { label: "Pulse", clip: { duration: 0.8, yoyo: true, to: { scale: 1.06 } } },
  sway: { label: "Sway", clip: { duration: 1.4, yoyo: true, to: { rotate: 5 } } },
  spin: { label: "Spin", clip: { duration: 3, to: { rotate: 360 } } },
  orbit: { label: "Orbit", clip: { duration: 3, path: { shape: "circle", size: 0.02 } } },
  eight: { label: "Figure-8", clip: { duration: 4, path: { shape: "figure-8", size: 0.02 } } },
  blink: { label: "Blink", clip: { duration: 0.6, yoyo: true, to: { opacity: 0.35 } } },
  curve: { label: "Your own curve", clip: { duration: 4, path: { points: [], closed: true } } },
};
/** Which loop a clip is, if it's one of the ready-made ones. */
function loopOf(a) {
  if (a.path?.points) return "curve";
  if (a.path?.shape === "figure-8") return "eight";
  if (a.path) return "orbit";
  const to = a.to ?? {};
  if (to.rotate === 360 || to.rotate === -360) return "spin";
  if (to.dy !== undefined) return "float";
  if (to.scale !== undefined) return "pulse";
  if (to.rotate !== undefined) return "sway";
  if (to.opacity !== undefined) return "blink";
  return null;
}
/** Ways the backdrop can move: a slow push, a drift, breathing, a colour shift, a turn, a focus pull. */
const BACKDROP_MOVES = {
  push: { label: "Slow push", clip: { to: { zoom: 1.15 } } },
  drift: { label: "Drift", clip: { duration: 5, repeat: true, yoyo: true, to: { zoom: 1.2, x: 0.3, y: 0.35 } } },
  breathe: { label: "Breathe", clip: { duration: 3, repeat: true, yoyo: true, to: { zoom: 1.06 } } },
  hue: { label: "Colour shift", clip: { duration: 4, repeat: true, yoyo: true, to: { hue: 45 } } },
  turn: { label: "Turn", clip: { to: { zoom: 1.12, rotate: 6 } } },
  focus: { label: "Come into focus", clip: { duration: 1.5, from: { blur: 0.02 } } },
};
function backdropMoveOf(a) {
  const to = a.to ?? {};
  if (a.from?.blur !== undefined) return "focus";
  if (to.hue !== undefined) return "hue";
  if (to.rotate !== undefined) return "turn";
  if (a.repeat && (to.x !== undefined || to.y !== undefined)) return "drift";
  if (a.repeat) return "breathe";
  if (to.zoom !== undefined) return "push";
  return null;
}
const clipName = (a) =>
  targetsOf(a).includes(BACKDROP)
    ? BACKDROP_MOVES[backdropMoveOf(a)]?.label ?? "Backdrop move"
    : kindOf(a) === "loop"
      ? LOOPS[loopOf(a)]?.label ?? "Loop"
      : a.path && !a.enter && !a.exit
        ? "Along a curve"
        : targetsOf(a).some(isCallout)
    ? a.exit ? "Leaves" : "Appears"
    : targetsOf(a).includes(CAMERA)
    ? (a.to?.zoom ?? 1) <= 1.001 ? "Pull back" : `${(a.to?.zoom ?? 1).toFixed(1)}× zoom`
    : a.enter ? `${FX[a.enter]} in${a.by ? ` by ${a.by}` : ""}` : a.exit ? `${FX[a.exit]} out${a.by ? ` by ${a.by}` : ""}` : a.from && !a.to ? "From" : "Change";
const snap = (t) => Math.round(t * 20) / 20;

const update = (i, fn, key) =>
  edit((d) => {
    const a = d.animations?.[i];
    if (a) fn(a);
  }, key && `anim${i}.${key}`);

/** Animate the chosen items (one clip; several items move as a group), starting at the playhead. */
export function addAnimation(ids) {
  const list = S.scene.animations ?? [];
  if (ids.includes(CAMERA)) {
    // A camera move: push in on the selected item (or the middle); pull back if it's already in.
    const now = evaluateCamera(list, playhead.t + 0.001);
    const aim = S.layout?.entities.find((e) => e.id === S.selected);
    const c = aim ? entityCentre(toAnim(aim)) : { x: 0.5, y: 0.5 };
    const to = now && now.zoom > 1.2 ? { zoom: 1 } : { zoom: 2, x: Math.round(c.x * 1000) / 1000, y: Math.round(c.y * 1000) / 1000 };
    edit((d) => {
      d.animations = [...(d.animations ?? []), { targets: CAMERA, at: snap(playhead.t), duration: 1, ease: "ease-in-out", to }];
    });
    selectAnimation(list.length);
    return persistPrefs();
  }
  if (ids.includes(BACKDROP)) {
    // The backdrop: a slow push from here to the end of the video, to start with.
    const at = snap(playhead.t);
    edit((d) => {
      d.animations = [...(d.animations ?? []), { targets: BACKDROP, at, duration: Math.max(1, snap(videoLength() - at)), ease: "ease-in-out", to: { zoom: 1.15 } }];
    });
    selectAnimation(list.length);
    return persistPrefs();
  }
  if (ids.length && ids.every(isCallout)) {
    // A call-out appears the way its style does; once it has, the next one takes it away.
    const shown = ids.every((id) => list.some((a) => a.enter && targetsOf(a).includes(id)));
    edit((d) => {
      d.animations = [...(d.animations ?? []), { targets: ids.length === 1 ? ids[0] : ids, at: snap(playhead.t), duration: 0.5, [shown ? "exit" : "enter"]: "fade" }];
    });
    selectAnimation(list.length);
    return persistPrefs();
  }
  const targets = ids.filter((id) => S.layout?.entities.some((e) => e.id === id));
  if (!targets.length) return;
  // The first animation of an item is its entrance; after that, a change.
  const entered = targets.every((id) => list.some((a) => a.enter && targetsOf(a).includes(id)));
  const text = targets.every((id) => id === "caption" || id.startsWith("text-"));
  const clip = { targets: targets.length === 1 ? targets[0] : targets, at: snap(playhead.t), duration: DEFAULT_DURATION };
  if (entered) clip.to = { scale: 1.15 };
  else clip.enter = text ? "slide-up" : "zoom";
  edit((d) => {
    d.animations = [...(d.animations ?? []), clip];
  });
  selectAnimation(list.length);
  persistPrefs();
}

export function deleteAnimation(i) {
  edit((d) => {
    d.animations.splice(i, 1);
    if (!d.animations.length) delete d.animations;
  });
  set({ animSel: null });
}

// ---------------------------------------------------------------------------------------------
// The timeline under the canvas

const ROW_ICON = { camera: "camera", backdrop: "background", device: "phone", callout: "highlight", caption: "text", text: "text", image: "image", shape: "shapes", sound: "sound" };
const clock = (t) => `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, "0")}`;
const stop = (e) => e.stopPropagation();

/** The ruler's step: the smallest that leaves room for its label at this many pixels a second. */
const TICK_STEPS = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300];
const tickStep = (pps) => TICK_STEPS.find((s) => s * pps >= 56) ?? 600;
const tickLabel = (t, step, len) => (len >= 60 ? `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}${step < 1 ? "." + String(Math.round((t % 1) * 10)) : ""}` : `${step < 1 ? t.toFixed(step < 0.5 ? 2 : 1).replace(/\.?0+$/, "") : t}s`);

export function TimelineDock() {
  const s = useStore();
  const body = useRef();
  const tracks = useRef();
  const line = useRef();
  const time = useRef();
  // The tracks' visible width, and how far in the timeline is zoomed (1 fits the whole video).
  const [width, setWidth] = useState(600);
  const [zoom, setZoomNow] = useState(1);
  const anchor = useRef(null);
  const len = videoLength();
  const list = s.scene.animations ?? [];
  const entities = s.layout?.entities ?? [];
  // Text first, then devices, then shapes: roughly the order things are introduced.
  // Each device's call-outs sit under it.
  const rows = [{ id: CAMERA, kind: "camera" }, { id: BACKDROP, kind: "backdrop" }, ...entities.filter((e) => e.kind === "caption" || e.kind === "text"), ...entities.filter((e) => e.kind === "device").flatMap((e) => [e, ...calloutRows(e)]), ...entities.filter((e) => e.kind === "image"), ...entities.filter((e) => e.kind === "shape"), ...(hasSoundRow(s.scene) ? [{ id: SOUND, kind: "sound" }] : [])];
  const ents = entities.map(toAnim);
  // Zoomed in, a second gets up to 400px; the timeline scrolls sideways.
  const maxZoom = Math.max(1, (400 * len) / Math.max(1, width));
  const z = clamp(zoom, 1, maxZoom);
  const pps = (width / len) * z;

  useLayoutEffect(() => {
    const el = body.current;
    if (!el) return;
    // The names column and the tracks' margins aren't timeline.
    const measure = () => setWidth(Math.max(120, el.clientWidth - 172 - 28));
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    measure();
    return () => ro.disconnect();
  }, []);
  /** Zoom to `next`, keeping the moment at `clientX` (default: the playhead) where it is. */
  const setZoom = (next, clientX) => {
    const el = body.current;
    const left = tracks.current?.getBoundingClientRect().left ?? 0;
    const x = clientX ?? left + playhead.t * pps;
    anchor.current = { t: clamp((x - left) / pps, 0, len), x: x - el.getBoundingClientRect().left };
    setZoomNow(clamp(next, 1, maxZoom));
  };
  useLayoutEffect(() => {
    const a = anchor.current;
    const el = body.current;
    if (!a || !el) return;
    anchor.current = null;
    el.scrollLeft = Math.max(0, 172 + 12 + a.t * pps - a.x);
  }, [z]);
  // ⌘-scroll or pinch zooms about the pointer.
  const wheel = (e) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    setZoom(z * Math.exp(-e.deltaY * 0.01), e.clientX);
  };
  // The playhead line and the clock follow without re-rendering the dock.
  useEffect(() => {
    const show = (t) => {
      if (line.current) line.current.style.transform = `translateX(${t * pps}px)`;
      if (time.current && !manyShots()) time.current.textContent = clock(t);
      // Zoomed in and playing: the timeline keeps the playhead in view.
      const el = body.current;
      if (el && S.playing && z > 1) {
        const x = 172 + 12 + t * pps;
        if (x > el.scrollLeft + el.clientWidth - 48 || x < el.scrollLeft + 172) el.scrollLeft = Math.max(0, x - 172 - 48);
      }
    };
    show(playhead.t);
    const offShot = onPlayhead(show);
    // A video of several shots: the clock is the whole video's; this shot's playhead dims outside it.
    const offVideo = onVideoTime((T, plan) => {
      if (time.current) time.current.textContent = clock(T);
      const a = plan.starts[S.shot];
      if (line.current) line.current.style.opacity = T >= a - 1e-6 && T <= a + plan.lengths[S.shot] + 1e-6 ? "" : "0.3";
    });
    if (manyShots()) setVideoTime(video.T);
    else if (line.current) line.current.style.opacity = "";
    return () => {
      offShot();
      offVideo();
    };
  }, [pps, z, s.shots?.length]);
  useEffect(() => {
    if (playhead.t > len) setPlayhead(len);
  }, [len]);

  const timeAt = (clientX) => clamp((clientX - tracks.current.getBoundingClientRect().left) / pps, 0, len);
  const scrub = (e) => {
    if (e.button !== 0) return;
    pause();
    setPlayhead(timeAt(e.clientX));
    const move = (m) => setPlayhead(timeAt(m.clientX));
    const up = () => {
      removeEventListener("pointermove", move);
      removeEventListener("pointerup", up);
    };
    addEventListener("pointermove", move);
    addEventListener("pointerup", up);
  };
  // Drag a bar to change when it starts; drag its right edge to change how long it takes.
  const dragBar = (e, i, offset, edge) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    if (S.animSel !== i) selectAnimation(i);
    const a0 = S.scene.animations[i];
    const x0 = e.clientX;
    const at0 = a0.at;
    const dur0 = a0.duration ?? DEFAULT_DURATION;
    let moved = false;
    const move = (m) => {
      const dt = (m.clientX - x0) / pps;
      if (!moved && Math.abs(m.clientX - x0) < 3) return;
      moved = true;
      if (edge) update(i, (a) => (a.duration = clamp(snap(dur0 + dt), 0.05, 30)), "dur");
      else update(i, (a) => (a.at = clamp(snap(at0 + dt), 0, Math.max(120, len))), "at");
      // A Change stays shown as it ends while its bar moves.
      if (keyframe()) setPlayhead(Math.min(videoLength(), animationEnd(S.scene.animations[i])));
    };
    const up = () => {
      removeEventListener("pointermove", move);
      removeEventListener("pointerup", up);
    };
    addEventListener("pointermove", move);
    addEventListener("pointerup", up);
  };
  const pickRow = (e, id) => {
    // The camera is animated on its own; items can be chosen together, and so can call-outs.
    const solo = (x) => x === CAMERA || x === BACKDROP || x === SOUND;
    const group = (x) => (solo(x) ? x : isCallout(x) ? "callout" : "item");
    const many = (e.metaKey || e.ctrlKey || e.shiftKey) && !solo(id) && s.animRows.every((x) => group(x) === group(id));
    const rowsNow = many ? (s.animRows.includes(id) ? s.animRows.filter((x) => x !== id) : [...s.animRows, id]) : [id];
    // A call-out's row selects its device on the canvas.
    set({ animRows: rowsNow, animSel: null, soundSel: null, ...(solo(id) ? {} : { selected: id.split("/")[0] }) });
  };
  const chosen = s.animRows.length ? s.animRows : s.selected ? [s.selected] : [];
  // Drag the top edge to make the timeline taller or shorter; the canvas keeps at least 150px.
  const resize = (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const stage = e.currentTarget.closest(".stage");
    const h0 = e.currentTarget.parentElement.offsetHeight;
    const max = Math.max(150, stage.clientHeight - 150);
    const y0 = e.clientY;
    let h = h0;
    stage.classList.add("tl-sizing");
    const move = (m) => {
      h = Math.round(clamp(h0 - (m.clientY - y0), 150, max));
      stage.style.setProperty("--tl-h", h + "px");
    };
    const up = () => {
      removeEventListener("pointermove", move);
      removeEventListener("pointerup", up);
      stage.classList.remove("tl-sizing");
      if (h !== h0) {
        set({ tlH: h });
        persistPrefs();
      }
    };
    addEventListener("pointermove", move);
    addEventListener("pointerup", up);
  };
  const usualHeight = () => {
    set({ tlH: null });
    persistPrefs();
  };
  const step = tickStep(pps);
  // Each with room for its label (none right at the end, where it would run past it).
  const ticks = Array.from({ length: Math.floor(len / step + 1e-6) + 1 }, (_, n) => Math.round(n * step * 1000) / 1000).filter((t) => (len - t) * pps >= 34);

  return html`<section class="tl-dock" onPointerDown=${stop}>
    <i class="tl-grip" title="Drag to make the timeline taller or shorter. Double-click for the usual height." onPointerDown=${resize} onDblClick=${usualHeight}></i>
    <header class="tl-head">
      <button class="icon-btn tl-play" title=${s.playing ? "Pause (Space)" : "Play (Space)"} onClick=${() => play()}><${Icon} n=${s.playing ? "pause" : "play"} s=${15} /></button>
      <span class="tl-clock" title=${manyShots() ? "Where the whole video is, and how long it runs" : ""}><b ref=${time}>0:00.0</b><span> / ${clock(manyShots() ? videoPlan().total : len)}</span></span>
      ${chosen.includes(SOUND)
        ? html`<button class="btn sm primary" title="Cut the sound in two at the playhead (⌘B)" onClick=${cutSoundHere}><${Icon} n="scissors" s=${13} />Cut at the playhead</button>
          ${s.soundSel !== null && html`<button class="btn sm" title="Delete the chosen piece of sound (⌫)" onClick=${() => deleteSound(s.soundSel)}><${Icon} n="trash" s=${13} />Delete piece</button>`}`
        : html`<button class="btn sm primary" disabled=${!chosen.length} title=${chosen.length ? "Add an animation for the chosen items, starting at the playhead" : "Choose an item on the left first (⌘-click for several)"} onClick=${() => addAnimation(chosen)}>
        <${Icon} n="plus" s=${13} w=${2.2} />${chosen.includes(CAMERA) ? "Move the camera" : chosen.includes(BACKDROP) ? "Move the backdrop" : chosen.length > 1 ? `Animate ${chosen.length} together` : chosen.length ? `Animate ${label(chosen[0])}` : "Animate"}
      </button>`}
      <span class="grow"></span>
      ${s.scene.recording?.duration ? html`<span class="tl-len" title="A recording runs its own length">Recording · ${clock(len)}</span>` : html`<label class="tl-len" title=${s.shots?.length > 1 ? "How long this shot is on screen, its transitions included." : "How long the video runs. It's never shorter than the animations need."}>${s.shots?.length > 1 ? `Shot ${s.shot + 1}` : "Length"}
        <${Num} value=${s.shots?.length > 1 ? len : s.exportOpts.video.duration} min=${1} max=${60} step=${0.5} digits=${1} unit="s" onChange=${(v) => {
          if (S.shots?.length > 1) return updateShot(S.shot, { length: v ?? undefined });
          set({ exportOpts: { ...S.exportOpts, video: { ...S.exportOpts.video, duration: v ?? 6 } } });
          persistPrefs();
        }} /></label>`}
      <div class="tl-zoom" title="Zoom the timeline (⌘-scroll or pinch over it)">
        <button class="icon-btn sm" disabled=${z <= 1.001} title="Zoom out" onClick=${() => setZoom(z / 1.6)}><${Icon} n="minus" s=${13} /></button>
        <${Slider} value=${Math.log(z) / Math.log(maxZoom || 1.0001) || 0} min=${0} max=${1} step=${0.01} format=${(v) => `${Math.pow(maxZoom, v).toFixed(1)}×`} onChange=${(v) => setZoom(Math.pow(maxZoom, v ?? 0))} />
        <button class="icon-btn sm" disabled=${z >= maxZoom - 0.001} title="Zoom in" onClick=${() => setZoom(z * 1.6)}><${Icon} n="plus" s=${13} /></button>
        <button class="btn sm ghost" disabled=${z <= 1.001} title="Show the whole video" onClick=${() => setZoom(1)}>Fit</button>
      </div>
      <button class="icon-btn sm" title="Close the timeline" onClick=${closeTimeline}><${Icon} n="x" s=${14} /></button>
    </header>
    <${ShotStrip} />
    <div class="tl-body ${z > 1.001 ? "zoomed" : ""}" ref=${body} onWheel=${wheel}>
      <div class="tl-names">
        <div class="tl-corner">${list.length ? `${list.length} animation${list.length === 1 ? "" : "s"}` : "Items"}</div>
        ${rows.map(
          (e) => html`<button class="tl-name ${e.kind === "callout" ? "sub" : ""} ${e.kind === "sound" ? "sound" : ""} ${chosen.includes(e.id) ? "on" : ""}" key=${e.id} title=${e.kind === "sound" ? "The video's sound: drag a piece to move it, its ends to trim it, and cut it at the playhead (⌘B)" : "Click to choose; ⌘-click to choose several and animate them together"} onClick=${(ev) => pickRow(ev, e.id)}>
            <${Icon} n=${ROW_ICON[e.kind]} s=${13} /><span>${label(e.id)}</span>
          </button>`,
        )}
      </div>
      <div class="tl-tracks" ref=${tracks} style=${{ width: len * pps + "px" }}>
        <div class="tl-ruler" onPointerDown=${scrub}>
          ${ticks.map((n) => html`<span class="tl-tick" key=${n} style=${{ left: n * pps + "px" }}>${tickLabel(n, step, len)}</span>`)}
        </div>
        ${rows.map(
          (e) => html`<div class="tl-row ${e.kind === "sound" ? "sound" : ""} ${chosen.includes(e.id) ? "on" : ""}" key=${e.id} onPointerDown=${scrub}>
            ${e.kind === "sound" && html`<${SoundPieces} pps=${pps} len=${len} now=${() => playhead.t} cut=${cutSoundHere} play=${playPiece} />`}
            ${list.map((a, i) => {
              const k = targetsOf(a).indexOf(e.id);
              if (k < 0) return null;
              const at = a.at + (a.stagger ?? 0) * k;
              // As long as it runs for this item: a text's words or letters included, every play of
              // a repeat, and to the end of the video for one that keeps going.
              const plays = playsOf(a);
              const dur = plays === Infinity ? Math.max(0, len - at) : animationEnd(a, ents) - a.at - (a.stagger ?? 0) * (targetsOf(a).length - 1);
              const cycle = (a.duration ?? DEFAULT_DURATION) * pps;
              return html`<div class="tl-bar ${e.id === CAMERA ? "camera" : e.id === BACKDROP ? "backdrop" : kindOf(a)} ${plays > 1 ? "rep" : ""} ${s.animSel === i ? "on" : ""} ${targetsOf(a).length > 1 ? "group" : ""}" key=${i} style=${{ left: at * pps + "px", width: Math.max(10, dur * pps) + "px", "--cyc": Math.max(4, cycle) + "px" }}
                title=${`${clipName(a)} at ${at.toFixed(2)}s, ${plays > 1 ? `${(a.duration ?? DEFAULT_DURATION).toFixed(2)}s a time, ${plays === Infinity ? "until the end" : `${plays} times`}` : `${dur.toFixed(2)}s`}${targetsOf(a).length > 1 ? ` · with ${targetsOf(a).length - 1} other${targetsOf(a).length > 2 ? "s" : ""}` : ""}`}
                onPointerDown=${(ev) => dragBar(ev, i, k)}>
                <span>${clipName(a)}</span>
                <i class="tl-edge" onPointerDown=${(ev) => dragBar(ev, i, k, true)}></i>
              </div>`;
            })}
          </div>`,
        )}
        ${!rows.length && html`<div class="tl-empty">Add a screenshot first.</div>`}
        ${rows.length > 0 && !list.length && html`<div class="tl-hint">Choose an item on the left, move the playhead to when it should arrive, then press Animate.</div>`}
        <div class="tl-line" ref=${line}><i></i></div>
      </div>
    </div>
  </section>`;
}

// ---------------------------------------------------------------------------------------------
// Shots: a video of several designs, one after another, joined by transitions



/** A small picture of a transition: the old shot (grey) giving way to the new (lime). */
function TransitionIcon({ type }) {
  const a = (x, y, w, h, o = 1) => html`<rect x=${x} y=${y} width=${w} height=${h} rx="2" fill="currentColor" opacity=${o * 0.35} />`;
  const b = (x, y, w, h, o = 1) => html`<rect x=${x} y=${y} width=${w} height=${h} rx="2" fill="var(--lime)" opacity=${o} />`;
  const arrow = (d) => html`<path d=${d} fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />`;
  const art = {
    cut: html`${a(4, 8, 13, 16)}${b(19, 8, 13, 16)}`,
    fade: html`${a(6, 8, 18, 16)}${b(12, 8, 18, 16, 0.6)}`,
    "fade-black": html`${a(4, 8, 10, 16)}<rect x="13" y="8" width="10" height="16" rx="2" fill="#000" />${b(22, 8, 10, 16)}`,
    "fade-white": html`${a(4, 8, 10, 16)}<rect x="13" y="8" width="10" height="16" rx="2" fill="#fff" />${b(22, 8, 10, 16)}`,
    "push-left": html`${a(2, 8, 14, 16)}${b(17, 8, 14, 16)}${arrow("M28 28h-10M21 25.5l-3 2.5 3 2.5")}`,
    "push-right": html`${b(2, 8, 14, 16)}${a(17, 8, 14, 16)}${arrow("M6 28h10M13 25.5l3 2.5-3 2.5")}`,
    "push-up": html`${a(10, 1, 16, 12)}${b(10, 14, 16, 12)}${arrow("M31 24v-9M28.5 17.5l2.5-3 2.5 3")}`,
    "push-down": html`${b(10, 1, 16, 12)}${a(10, 14, 16, 12)}${arrow("M31 6v9M28.5 12.5l2.5 3 2.5-3")}`,
    "wipe-left": html`${a(4, 8, 28, 16)}${b(17, 8, 15, 16)}<path d="M17 6v20" stroke="currentColor" stroke-width="1.5" />`,
    "wipe-right": html`${a(4, 8, 28, 16)}${b(4, 8, 15, 16)}<path d="M19 6v20" stroke="currentColor" stroke-width="1.5" />`,
    iris: html`${a(4, 8, 28, 16)}<circle cx="18" cy="16" r="6.5" fill="var(--lime)" />`,
    zoom: html`${a(4, 6, 28, 20)}${b(12, 11, 12, 10)}${arrow("M9 9l3 3M27 9l-3 3M9 23l3-3M27 23l-3-3")}`,
    blur: html`${a(4, 8, 28, 16)}<rect x="9" y="10" width="18" height="12" rx="5" fill="var(--lime)" opacity=".35" /><rect x="12" y="12" width="12" height="8" rx="3" fill="var(--lime)" />`,
    dissolve: html`${a(4, 8, 28, 16)}${[...Array(12)].map((_, n) => html`<rect x=${6 + (n % 6) * 4.5} y=${n < 6 ? 11 : 17} width="2.5" height="2.5" fill="var(--lime)" opacity=${0.4 + (n % 3) * 0.3} />`)}`,
  }[type];
  return html`<svg viewBox="0 0 36 32" width="36" height="32">${art}</svg>`;
}

/** How a shot comes in: a chip between it and the one before, opening a picker. */
function TransitionChip({ i, t, at }) {
  const [open, setOpen] = useState(false);
  const ref = useRef();
  const type = t?.type ?? "fade";
  return html`<button class="shot-join ${open ? "on" : ""}" ref=${ref} style=${at !== undefined ? { left: at + "px" } : null} title=${`${TRANSITION_NAMES[type]} into shot ${i + 1}`} onPointerDown=${(e) => e.stopPropagation()} onClick=${() => setOpen(!open)}>
      <${TransitionIcon} type=${type} />
    </button>
    ${open &&
    html`<${Popover} anchor=${ref.current} align="center" class="join-pop" onClose=${() => setOpen(false)}>
      <div class="join-head">Into shot ${i + 1}</div>
      <div class="fx-grid">${Object.entries(TRANSITION_NAMES).map(([name, label]) => html`<button class="fx ${type === name ? "on" : ""}" key=${name} onClick=${() => updateShot(i, { transition: { type: name, duration: name === "cut" ? undefined : (t?.duration ?? 0.5) } })}><${TransitionIcon} type=${name} /><span>${label}</span></button>`)}</div>
      ${type !== "cut" && html`<div class="row"><label>Takes</label><${Slider} value=${t?.duration} min=${0.1} max=${2} step=${0.05} fallback=${0.5} format=${(v) => v.toFixed(2) + " s"} onChange=${(v) => updateShot(i, { transition: { type, duration: v ?? 0.5 } })} /></div>`}
    <//>`}`;
}

// Shot pictures, remembered by what's in them (the newest few).
const thumbs = new Map();
function ShotThumb({ scene, film }) {
  const key = JSON.stringify(scene ?? null);
  const [img, setImg] = useState(thumbs.get(key));
  useEffect(() => {
    if (thumbs.has(key)) return setImg(thumbs.get(key));
    if (!hasDesign(scene)) return;
    // The shot on the canvas changes as you work: wait for a pause before drawing it again.
    const timer = setTimeout(() => {
      api("/api/shot-thumb", { ...scene, animations: undefined })
        .then((r) => {
          if (!r.image) return;
          thumbs.set(key, r.image);
          if (thumbs.size > 40) thumbs.delete(thumbs.keys().next().value);
          setImg(r.image);
        })
        .catch(() => undefined);
    }, 600);
    return () => clearTimeout(timer);
  }, [key]);
  // On the video's timeline, the picture repeats along the shot like frames of film.
  if (film) return img ? html`<i class="shot-film" style=${{ backgroundImage: `url(${img})` }}></i>` : html`<i class="shot-blank"></i>`;
  return img ? html`<img src=${img} alt="" draggable=${false} />` : html`<i class="shot-blank"></i>`;
}

/**
 * The video's shots on one timeline: each as long as it runs, a transition chip where one gives
 * way to the next, and a playhead for the whole video (drag it, or press Play). Click a shot to
 * edit it; add one, or right-click one to move or remove it.
 */
function ShotStrip() {
  const s = useStore();
  const many = s.shots?.length > 1;
  const track = useRef();
  const line = useRef();
  const [tw, setTw] = useState(600);
  useLayoutEffect(() => {
    const el = track.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setTw(el.clientWidth));
    ro.observe(el);
    setTw(el.clientWidth);
    return () => ro.disconnect();
  }, [many]);
  const plan = many ? videoPlan() : null;
  const pps = plan ? tw / Math.max(0.1, plan.total) : 0;
  // The video's playhead follows its clock without re-rendering the strip.
  useEffect(() => {
    if (!many) return;
    const show = (T) => line.current && (line.current.style.transform = `translateX(${T * pps}px)`);
    show(video.T);
    return onVideoTime(show);
  }, [many, pps]);
  // Editing another shot: the clock moves into it (keeping its place if it's already there).
  useEffect(() => {
    if (!many || offVideo()) return;
    const p = videoPlan();
    const a = p.starts[S.shot];
    const L = p.lengths[S.shot];
    if (video.T < a - 1e-6 || video.T > a + L + 1e-6) setVideoTime(a + Math.min(playhead.t, L));
    else setVideoTime(video.T);
  }, [many, s.shot, s.shots?.length]);
  const addMenu = (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    const designs = (S.scenes ?? []).filter((x) => x.id !== S.sceneId && x.devices).slice(0, 10);
    openMenu(r.left, r.top - 8, [
      { label: "A copy of this shot", icon: "duplicate", run: () => addShot("copy") },
      designs.length ? "-" : null,
      ...designs.map((x) => ({ label: x.name, icon: "image", run: () => addShot(x.id) })),
    ]);
  };
  const addBtn = html`<button class="shot-add" title="Add a shot after this one: a copy of it, or one of your designs" onClick=${addMenu}><${Icon} n="plus" s=${14} w=${2.2} /><span>${many ? "" : "Add a shot"}</span></button>`;
  if (!many) {
    return html`<div class="tl-shots">
      <button class="tl-shot on" title="Shot 1, on the canvas"><${ShotThumb} scene=${s.scene} /><span class="shot-n">1</span><span class="shot-len">${videoLength().toFixed(1)}s</span></button>
      ${addBtn}
    </div>`;
  }
  const n = plan.shots.length;
  const shotMenu = (e, i) => {
    e.preventDefault();
    openMenu(e.clientX, e.clientY, [
      { label: "Duplicate", icon: "duplicate", run: () => (goToShot(i), setTimeout(() => addShot("copy"))) },
      { label: "Move earlier", icon: "left", disabled: i === 0, run: () => moveShot(i, -1) },
      { label: "Move later", icon: "right", disabled: i === n - 1, run: () => moveShot(i, 1) },
      plan.shots[i].video === false ? { label: "Put back in the video", icon: "video", run: () => setInVideo(i, true) } : { label: "Leave out of the video", icon: "video", disabled: plan.out.filter((o) => !o).length < 2, run: () => setInVideo(i, false) },
      "-",
      { label: "Remove this shot", icon: "trash", danger: true, run: () => deleteShot(i) },
    ]);
  };
  // Drag anywhere on the strip to scrub the whole video; a click on a shot also edits it.
  const scrub = (e) => {
    if (e.button !== 0 || e.target.closest(".shot-join")) return;
    pause();
    const at = (x) => clamp((x - track.current.getBoundingClientRect().left) / pps, 0, plan.total);
    setVideoTime(at(e.clientX));
    const move = (m) => setVideoTime(at(m.clientX));
    const up = () => {
      removeEventListener("pointermove", move);
      removeEventListener("pointerup", up);
    };
    addEventListener("pointermove", move);
    addEventListener("pointerup", up);
  };
  const c = s.layout?.canvas;
  return html`<div class="tl-shots video" style=${{ "--shot-aspect": c ? `${c.width} / ${c.height}` : undefined }}>
    <div class="vt" ref=${track} onPointerDown=${scrub}>
      ${plan.shots.map((x, i) => {
        if (plan.out[i]) return null;
        const left = plan.starts[i] * pps;
        const right = (i < n - 1 ? plan.starts[i + 1] : plan.total) * pps;
        return html`<button class="tl-shot ${i === s.shot ? "on" : ""} ${s.shotPulse?.includes(i) ? "pulse" : ""}" key=${`s${i}`} style=${{ left: left + "px", width: Math.max(18, right - left - 3) + "px" }}
            title=${i === s.shot ? `${i + 1} · ${screenName(i)}, on the canvas. Right-click to move or remove it.` : `${i + 1} · ${screenName(i)}: click to edit it`} onClick=${() => goToShot(i)} onContextMenu=${(e) => shotMenu(e, i)}>
          <${ShotThumb} scene=${i === s.shot ? s.scene : x.scene} film />
          <span class="shot-n">${i + 1}</span>
          ${right - left > 70 && html`<span class="shot-len">${plan.lengths[i].toFixed(1)}s</span>`}
        </button>`;
      })}
      ${plan.shots.map((x, i) => plan.joins[i].type && html`<${TransitionChip} i=${i} t=${x.transition} key=${`t${i}`} at=${plan.starts[i] * pps + (plan.joins[i].duration * pps) / 2} />`)}
      <div class="vt-line" ref=${line}><i></i></div>
    </div>
    ${plan.out.some(Boolean) &&
    html`<div class="tl-left-out" title="Screens of the set left out of the video: still App Store screenshots. Right-click one to put it back.">
      <span>Not in the video</span>
      ${plan.shots.map((x, i) => plan.out[i] && html`<button class="tl-shot mini ${i === s.shot ? "on" : ""}" key=${`o${i}`} title=${`${i + 1} · ${screenName(i)}: left out of the video`} onClick=${() => goToShot(i)} onContextMenu=${(e) => shotMenu(e, i)}>
        <${ShotThumb} scene=${i === s.shot ? s.scene : x.scene} /><span class="shot-n">${i + 1}</span>
      </button>`)}
    </div>`}
    ${addBtn}
    <span class="tl-total">${plan.out.filter((o) => !o).length} shots · ${plan.total.toFixed(1)} s</span>
    <button class="btn sm ghost" title="Every shot at its key moments on one sheet, without rendering the video" onClick=${previewShots}><${Icon} n="grid" s=${13} />All shots</button>
  </div>`;
}

// ---------------------------------------------------------------------------------------------
// The selected animation, in the right-hand panel

/** A small picture of an easing curve. */
function Curve({ name }) {
  const pts = Array.from({ length: 33 }, (_, i) => {
    const p = i / 32;
    return `${(4 + p * 40).toFixed(1)},${(30 - easeAt(name, p) * 22).toFixed(1)}`;
  }).join(" ");
  return html`<svg viewBox="0 0 48 36" width="48" height="36"><path d="M4 30H44" stroke="currentColor" stroke-opacity=".18" /><path d="M4 8H44" stroke="currentColor" stroke-opacity=".18" stroke-dasharray="2 3" /><polyline points=${pts} fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" /></svg>`;
}

/** A small picture of an entrance: a block and the way it arrives. */
function FxIcon({ fx }) {
  const block = (x, y, w, h, o = 1) => html`<rect x=${x} y=${y} width=${w} height=${h} rx="2" fill="currentColor" opacity=${o} />`;
  const arrow = (d) => html`<path d=${d} fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />`;
  const art = {
    none: block(11, 9, 14, 14),
    fade: html`${block(11, 9, 14, 14, 0.35)}`,
    zoom: html`${block(14, 12, 8, 8)}<rect x="8.5" y="6.5" width="19" height="19" rx="3" fill="none" stroke="currentColor" stroke-opacity=".5" stroke-dasharray="2 2.5" />`,
    blur: html`<rect x="8" y="6" width="20" height="20" rx="6" fill="currentColor" opacity=".18" /><rect x="10" y="8" width="16" height="16" rx="4" fill="currentColor" opacity=".3" />${block(12.5, 10.5, 11, 11)}`,
    "scale-x": html`${block(15, 9, 6, 14)}${arrow("M9 16H5M27 16h4M7 14l-2 2 2 2M29 14l2 2-2 2")}`,
    "scale-y": html`${block(11, 13, 14, 6)}${arrow("M18 9V5M18 23v4M16 7l2-2 2 2M16 25l2 2 2-2")}`,
    "slide-up": html`${block(11, 6, 14, 12)}${arrow("M18 28v-6M15 24.5l3-3 3 3")}`,
    "slide-down": html`${block(11, 14, 14, 12)}${arrow("M18 4v6M15 7.5l3 3 3-3")}`,
    "slide-left": html`${block(5, 9, 14, 14)}${arrow("M31 16h-7M27 13l-3 3 3 3")}`,
    "slide-right": html`${block(17, 9, 14, 14)}${arrow("M5 16h7M9 13l3 3-3 3")}`,
  }[fx];
  return html`<svg viewBox="0 0 36 32" width="36" height="32">${art}</svg>`;
}

const pct = { scale: 100, unit: "%", digits: 0, step: 1 };

const REPEATS = [{ value: "0", label: "Once" }, { value: "1", label: "2×" }, { value: "2", label: "3×" }, { value: "forever", label: "Forever" }];

/**
 * Timing and easing: the same for every kind of animation. `fallback` is the easing used when
 * none is set. `repeatable` adds how many times it plays, and whether each play starts over or
 * runs back (`loop` means it always keeps going).
 */
function TimingAndEasing({ i, a, many, fallback, repeatable = false, loop = false }) {
  fallback ??= defaultEase(a);
  return html`<${Section} title="Timing">
      <div class="grid2">
        <${Num} label="At" title="Seconds after the video starts" value=${a.at} min=${0} max=${120} step=${0.1} digits=${2} unit="s" onChange=${(v) => v !== undefined && update(i, (x) => (x.at = v), "at")} />
        <${Num} label="For" title=${a.repeat ? "How long each play takes, in seconds" : "How long it takes, in seconds"} value=${a.duration ?? DEFAULT_DURATION} min=${0.05} max=${30} step=${0.1} digits=${2} unit="s" onChange=${(v) => v !== undefined && update(i, (x) => (x.duration = v), "dur")} />
      </div>
      ${repeatable && !loop && html`<div class="row"><label>Plays</label><${Seg} value=${a.repeat === true ? "forever" : String(a.repeat ?? 0)} options=${REPEATS} onChange=${(v) => update(i, (x) => {
        if (v === "0") {
          delete x.repeat;
          delete x.yoyo;
        } else x.repeat = v === "forever" ? true : Number(v);
      })} /></div>`}
      ${(loop || (repeatable && a.repeat)) && html`<div class="row"><label>Each time</label><${Seg} value=${a.yoyo ? "back" : "over"} options=${[{ value: "over", label: "Start over" }, { value: "back", label: "Back and forth" }]} onChange=${(v) => update(i, (x) => {
        if (v === "back") x.yoyo = true;
        else delete x.yoyo;
      })} /></div>`}
      ${many && html`<div class="row"><label>One by one</label><${Slider} value=${a.stagger} min=${0} max=${2} step=${0.05} fallback=${0} format=${(v) => (v ? v.toFixed(2) + " s" : "Off")} onChange=${(v) => update(i, (x) => (x.stagger = v || undefined), "stagger")} /></div>`}
    <//>
    <${Section} title="Easing">
      <div class="ease-grid">${EASES.map((name) => html`<button class="ease ${(a.ease ?? fallback) === name ? "on" : ""}" key=${name} onClick=${() => update(i, (x) => (x.ease = name))}><${Curve} name=${name} /><span>${EASE_NAMES[name]}</span></button>`)}</div>
    <//>`;
}

const playClip = (a) => {
  pause();
  setPlayhead(Math.max(0, a.at - 0.4));
  play(Math.min(videoLength(), animationEnd(a, animEntities()) + 0.6));
};

/** A camera move: how far in, and at what. The frame on the canvas is the quick way to set both. */
function CameraInspector({ i, a }) {
  const s = useStore();
  const to = a.to ?? {};
  const zoom = to.zoom ?? 1;
  const items = (s.layout?.entities ?? []).map((e) => ({ value: e.id, label: entityLabel(e.id) }));
  const setTo = (patch, key) =>
    update(i, (x) => {
      x.to = { ...(x.to ?? {}), ...patch };
    }, key);
  const aim = (id) => {
    const e = s.layout?.entities.find((x) => x.id === id);
    if (!e) return;
    const c = entityCentre(toAnim(e));
    setTo({ x: r3(c.x), y: r3(c.y), zoom: Math.max(zoom, 1.8) });
  };
  return html`
    <div class="panel-head clip-head"><h2>Camera</h2><span class="sub">${clipName(a)}</span><span class="grow"></span>
      <button class="icon-btn sm" title="Delete this move (⌫)" onClick=${() => deleteAnimation(i)}><${Icon} n="trash" s=${14} /></button>
      <button class="icon-btn sm" title="Close" onClick=${() => set({ animSel: null })}><${Icon} n="x" s=${14} /></button>
    </div>
    <div class="panel-body">
      <div class="note">Drag the frame on the canvas to aim the camera, and a corner to zoom. The camera moves the whole picture, text included.</div>
      <${Section} title="Goes to">
        <div class="row"><label>Zoom</label><${Slider} value=${zoom} min=${1} max=${6} step=${0.05} format=${(v) => (v <= 1.001 ? "All of it" : v.toFixed(1) + "×")} onChange=${(v) => setTo({ zoom: v ?? 1 }, "zoom")} /></div>
        <div class="row"><label>Look at</label><${Dropdown} value="" placeholder="An item…" options=${items} onChange=${aim} /></div>
        ${zoom > 1.001 &&
        html`<div class="row"><label>Point</label><div class="grid2">
          <${Num} label="X" value=${to.x ?? 0.5} ...${pct} min=${0} max=${1} onChange=${(v) => v !== undefined && setTo({ x: r3(v) }, "x")} />
          <${Num} label="Y" value=${to.y ?? 0.5} ...${pct} min=${0} max=${1} onChange=${(v) => v !== undefined && setTo({ y: r3(v) }, "y")} />
        </div></div>`}
        ${zoom > 1.001 && html`<button class="btn sm ghost" onClick=${() => update(i, (x) => (x.to = { zoom: 1 }))}><${Icon} n="fit" s=${12} />Pull back to the whole design</button>`}
      <//>
      <${TimingAndEasing} i=${i} a=${a} fallback="ease-in-out" />
      <button class="btn block" onClick=${() => playClip(a)}><${Icon} n="play" s=${13} />Play this move</button>
    </div>`;
}

/** A route's options: a curve's points, whether it closes, and which way the item faces. */
function PathOptions({ a, setPath }) {
  const pts = a.path?.points;
  return html`
    ${pts && html`<div class="row"><label>Points</label><div class="hstack">
      <button class="btn sm" disabled=${pts.length >= 12} onClick=${() => {
        // A new point just past the last, continuing the way the route was going.
        const last = pts[pts.length - 1];
        const prev = pts[pts.length - 2] ?? last;
        setPath({ points: [...pts, { x: r3(last.x + (last.x - prev.x) * 0.6 + 0.02), y: r3(last.y + (last.y - prev.y) * 0.6) }] });
      }}><${Icon} n="plus" s=${12} />Add</button>
      <button class="btn sm" disabled=${pts.length <= 1} onClick=${() => setPath({ points: pts.slice(0, -1) })}><${Icon} n="minus" s=${12} />Remove</button>
    </div></div>
    <${Switch} checked=${Boolean(a.path.closed)} onChange=${(v) => setPath({ closed: v })} label="Come back round to the start" />`}
    <${Switch} checked=${Boolean(a.path?.orient)} onChange=${(v) => setPath({ orient: v })} label="Face the way it's going" />
    <${Switch} checked=${Boolean(a.path?.reverse)} onChange=${(v) => setPath({ reverse: v })} label="Go the other way" />`;
}

/** A small picture of a loop. */
function LoopIcon({ kind }) {
  const dot = (x, y, r = 4) => html`<circle cx=${x} cy=${y} r=${r} fill="currentColor" />`;
  const line = (d, dash) => html`<path d=${d} fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-dasharray=${dash ? "2 2.5" : undefined} opacity=${dash ? 0.6 : 1} />`;
  const art = {
    float: html`${dot(18, 13)}${line("M18 20v7M15.5 24.5l2.5 2.5 2.5-2.5M15.5 8.5L18 6l2.5 2.5", false)}`,
    pulse: html`${dot(18, 16, 4.5)}<circle cx="18" cy="16" r="9" fill="none" stroke="currentColor" stroke-width="1.4" stroke-dasharray="2 2.5" opacity=".6" />`,
    sway: html`<rect x="14" y="8" width="8" height="14" rx="2" fill="currentColor" transform="rotate(12 18 22)" />${line("M8 26q10 5 20 0", true)}`,
    spin: html`<rect x="13" y="11" width="10" height="10" rx="2" fill="currentColor" />${line("M27 16a9 9 0 1 1-3-6.7M24 5v4.5h-4.5", false)}`,
    orbit: html`${line("M18 7a9 9 0 1 1 0 18a9 9 0 1 1 0-18", true)}${dot(18, 7, 3.5)}`,
    eight: html`${line("M18 16c-3-5-9-5-9 0s6 5 9 0 9-5 9 0-6 5-9 0", true)}${dot(9, 16, 3.2)}`,
    blink: html`${dot(12, 16, 4)}<circle cx="24" cy="16" r="4" fill="currentColor" opacity=".3" />`,
    curve: html`${line("M6 24c5-14 12-14 14-6s6 6 10-8", true)}${dot(6, 24, 2.6)}${dot(20, 18, 2.6)}${dot(30, 10, 2.6)}`,
    push: html`<rect x="9" y="8" width="18" height="16" rx="2" fill="currentColor" opacity=".35" /><rect x="13" y="11.5" width="10" height="9" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.5" />`,
    drift: html`<rect x="7" y="9" width="16" height="14" rx="2" fill="currentColor" opacity=".35" />${line("M21 16h9M27 13l3 3-3 3", false)}`,
    breathe: html`<rect x="11" y="10" width="14" height="12" rx="2" fill="currentColor" opacity=".4" /><rect x="7" y="7" width="22" height="18" rx="3" fill="none" stroke="currentColor" stroke-width="1.3" stroke-dasharray="2 2.5" opacity=".6" />`,
    hue: html`<circle cx="14" cy="16" r="6" fill="#8b7bff" /><circle cx="22" cy="16" r="6" fill="#ff5fa2" opacity=".85" />`,
    turn: html`<rect x="10" y="9" width="16" height="14" rx="2" fill="currentColor" opacity=".4" transform="rotate(-10 18 16)" />${line("M28 20a10 10 0 0 1-6 5", false)}`,
    focus: html`<rect x="10" y="9" width="16" height="14" rx="3" fill="currentColor" opacity=".25" /><rect x="13" y="12" width="10" height="8" rx="2" fill="currentColor" />`,
  }[kind];
  return html`<svg viewBox="0 0 36 32" width="36" height="32">${art}</svg>`;
}

/** The backdrop's own move: a ready-made one, then what it pushes, turns, softens or shifts to. */
function BackdropInspector({ i, a }) {
  const s = useStore();
  const W0 = s.layout?.canvas.width ?? 1000;
  // A focus pull starts from its values (from); everything else goes to them (to).
  const key = a.from && !a.to ? "from" : "to";
  const v = a[key] ?? {};
  const zoom = v.zoom ?? 1;
  const setV = (patch, k) =>
    update(i, (x) => {
      x[key] = { ...(x[key] ?? {}) };
      for (const [name, val] of Object.entries(patch)) if (val === undefined) delete x[key][name];
      else x[key][name] = val;
    }, k);
  const setMove = (name) =>
    update(i, (x) => {
      for (const k of ["to", "from", "repeat", "yoyo"]) delete x[k];
      const clip = structuredClone(BACKDROP_MOVES[name].clip);
      Object.assign(x, clip);
      // A one-off move runs to the end of the video unless its own length says otherwise.
      if (!clip.duration) x.duration = Math.max(1, snap(videoLength() - x.at));
    });
  return html`
    <div class="panel-head clip-head"><h2>Backdrop</h2><span class="sub">${clipName(a)}</span><span class="grow"></span>
      <button class="icon-btn sm" title="Delete this move (⌫)" onClick=${() => deleteAnimation(i)}><${Icon} n="trash" s=${14} /></button>
      <button class="icon-btn sm" title="Close" onClick=${() => set({ animSel: null })}><${Icon} n="x" s=${14} /></button>
    </div>
    <div class="panel-body">
      <div class="note">Moves only the backdrop, behind everything else. The camera moves the whole picture.</div>
      <${Section} title="Move">
        <div class="fx-grid">${Object.entries(BACKDROP_MOVES).map(([name, m]) => html`<button class="fx ${backdropMoveOf(a) === name ? "on" : ""}" key=${name} onClick=${() => setMove(name)}><${LoopIcon} kind=${name} /><span>${m.label}</span></button>`)}</div>
      <//>
      <${Section} title=${key === "from" ? "Starts from" : "Goes to"}>
        <div class="row"><label>Push in</label><${Slider} value=${v.zoom} min=${1} max=${2.5} step=${0.01} fallback=${1} format=${(z) => (z <= 1.001 ? "None" : Math.round((z - 1) * 100) + "%")} onChange=${(z) => setV({ zoom: z > 1.001 ? z : undefined }, "zoom")} /></div>
        ${zoom > 1.001 &&
        html`<div class="row"><label>Toward</label><div class="grid2">
          <${Num} label="X" value=${v.x ?? 0.5} ...${pct} min=${0} max=${1} onChange=${(n) => n !== undefined && setV({ x: r3(n) }, "x")} />
          <${Num} label="Y" value=${v.y ?? 0.5} ...${pct} min=${0} max=${1} onChange=${(n) => n !== undefined && setV({ y: r3(n) }, "y")} />
        </div></div>`}
        <div class="row"><label>Turn</label><${Slider} value=${v.rotate} min=${-45} max=${45} step=${1} centered fallback=${0} format=${(d) => d + "°"} onChange=${(d) => setV({ rotate: d || undefined }, "rotate")} /></div>
        <div class="row"><label>Colour</label><${Slider} value=${v.hue} min=${-180} max=${180} step=${1} centered fallback=${0} format=${(d) => (d ? (d > 0 ? "+" : "") + d + "°" : "As it is")} onChange=${(d) => setV({ hue: d || undefined }, "hue")} /></div>
        <div class="row"><label>Blur</label><${Slider} value=${v.blur} min=${0} max=${0.04} step=${0.001} fallback=${0} format=${(b) => (b > 0.0004 ? Math.round(b * W0) + " px" : "Sharp")} onChange=${(b) => setV({ blur: b > 0.0004 ? b : undefined }, "blur")} /></div>
      <//>
      <${TimingAndEasing} i=${i} a=${a} repeatable />
      <button class="btn block" onClick=${() => playClip(a)}><${Icon} n="play" s=${13} />Play this move</button>
    </div>`;
}

/**
 * A selected animation's route on the canvas: the curve it travels, and for a route of your own,
 * its points to drag.
 */
export function MotionPathOverlay() {
  const s = useStore();
  const held = keyframe();
  const layout = s.layout;
  if (!held || !held.clip.path || !layout) return null;
  const W0 = layout.canvas.width;
  const H0 = layout.canvas.height;
  const ids = targetsOf(held.clip).filter((id) => layout.entities.some((e) => e.id === id));
  if (!ids.length) return null;
  // Where it sets off: its middle (a group's shared middle), moved by anything before.
  const ents = layout.entities.map(toAnim);
  const centres = ids.map((id) => entityCentre(ents.find((e) => e.id === id)));
  const c = { x: centres.reduce((m, p) => m + p.x, 0) / centres.length, y: centres.reduce((m, p) => m + p.y, 0) / centres.length };
  const before = evaluate(s.scene.animations, ents, Math.max(0, held.clip.at - 0.0001), W0, H0).get(ids[0]);
  const start = { x: c.x * W0 + (before?.dx ?? 0), y: c.y * H0 + (before?.dy ?? 0) };
  const route = pathRoute(held.clip.path, start, W0, H0);
  const d = route.points.map((p, j) => `${j ? "L" : "M"}${(p.x / W0) * 100} ${(p.y / H0) * 100}`).join(" ");
  const pts = held.clip.path.points;
  const drag = (e, j) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    const art = e.currentTarget.closest(".artboard").getBoundingClientRect();
    const move = (m) => {
      const x = clamp((m.clientX - art.left) / art.width, -0.2, 1.2);
      const y = clamp((m.clientY - art.top) / art.height, -0.2, 1.2);
      update(held.i, (a) => {
        a.path = { ...a.path, points: a.path.points.map((p, n) => (n === j ? { x: r4(x), y: r4(y) } : p)) };
      }, `path${j}`);
    };
    const up = () => {
      removeEventListener("pointermove", move);
      removeEventListener("pointerup", up);
    };
    addEventListener("pointermove", move);
    addEventListener("pointerup", up);
  };
  return html`<div class="motion-path">
    <svg viewBox="0 0 100 100" preserveAspectRatio="none"><path d=${d} vector-effect="non-scaling-stroke" /></svg>
    <i class="mp-start" style=${{ left: (start.x / W0) * 100 + "%", top: (start.y / H0) * 100 + "%" }}></i>
    ${pts?.map((p, j) => html`<i class="mp-pt" key=${j} title="Drag to reshape the route" style=${{ left: p.x * 100 + "%", top: p.y * 100 + "%" }} onPointerDown=${(e) => drag(e, j)}><b>${j + 1}</b></i>`)}
  </div>`;
}

/** A call-out's timing: when it appears or disappears, and how fast. */
function CalloutInspector({ i, a }) {
  const ids = targetsOf(a);
  const setKind = (v) =>
    update(i, (x) => {
      delete x.enter;
      delete x.exit;
      delete x.to;
      delete x.from;
      x[v] = "fade";
    });
  return html`
    <div class="panel-head clip-head"><h2>Call-out</h2><span class="sub">${clipName(a)}</span><span class="grow"></span>
      <button class="icon-btn sm" title="Delete this animation (⌫)" onClick=${() => deleteAnimation(i)}><${Icon} n="trash" s=${14} /></button>
      <button class="icon-btn sm" title="Close" onClick=${() => set({ animSel: null })}><${Icon} n="x" s=${14} /></button>
    </div>
    <div class="panel-body">
      <div class="clip-targets">${ids.map((id) => html`<span class="pill">${label(id)}</span>`)}</div>
      <${Seg} value=${a.exit ? "exit" : "enter"} options=${[{ value: "enter", label: "Appear" }, { value: "exit", label: "Disappear" }]} onChange=${setKind} />
      <div class="note">A call-out arrives the way its style does: a lift rises off the screen, a loupe grows, an outline fades in. Call-outs aren't drawn on the canvas; they show in the exported video. Ones you don't time all appear a quarter of the way in.</div>
      <${TimingAndEasing} i=${i} a=${a} many=${ids.length > 1} />
    </div>`;
}

/** The camera's frame on the canvas, for the selected camera move: drag it to aim, a corner to zoom. */
export function Viewfinder() {
  const s = useStore();
  const held = keyframe();
  if (!held || !targetsOf(held.clip).includes(CAMERA)) return null;
  const cam = evaluateCamera(s.scene.animations, animationEnd(held.clip)) ?? { zoom: 1, x: 0.5, y: 0.5 };
  const v = cameraView(cam);
  const setCam = (next) =>
    update(held.i, (x) => {
      x.to = next.zoom <= 1.001 ? { zoom: 1 } : { ...(x.to ?? {}), zoom: r3(next.zoom), x: r4(next.x), y: r4(next.y) };
    }, "frame");
  const drag = (e, corner) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    const art = e.currentTarget.closest(".artboard").getBoundingClientRect();
    const x0 = e.clientX;
    const y0 = e.clientY;
    const move = (m) => {
      const dx = (m.clientX - x0) / art.width;
      const dy = (m.clientY - y0) / art.height;
      if (!corner) return setCam(cameraFor({ x: clamp(v.x + dx, 0, 1 - v.width), y: clamp(v.y + dy, 0, 1 - v.height) }, cam.zoom));
      // A corner grows or shrinks the frame about its middle: a smaller frame is a closer zoom.
      const grow = Math.max((corner.includes("e") ? 1 : -1) * dx, (corner.includes("s") ? 1 : -1) * dy) * 2;
      const w = clamp(v.width + grow, 1 / 8, 1);
      setCam(cameraFor({ x: clamp(v.x + v.width / 2 - w / 2, 0, 1 - w), y: clamp(v.y + v.height / 2 - w / 2, 0, 1 - w) }, 1 / w));
    };
    const up = () => {
      removeEventListener("pointermove", move);
      removeEventListener("pointerup", up);
    };
    addEventListener("pointermove", move);
    addEventListener("pointerup", up);
  };
  return html`<div class="viewfinder" style=${{ left: v.x * 100 + "%", top: v.y * 100 + "%", width: v.width * 100 + "%", height: v.height * 100 + "%" }} onPointerDown=${(e) => drag(e)}>
    <span class="vf-tag"><${Icon} n="camera" s=${11} />${cam.zoom <= 1.001 ? "The whole design" : cam.zoom.toFixed(1) + "×"}</span>
    ${["nw", "ne", "sw", "se"].map((c) => html`<i class="vf-h ${c}" key=${c} onPointerDown=${(e) => drag(e, c)}></i>`)}
  </div>`;
}

/** A piece of sound: how loud, its fades, when it starts; cut it, play it or delete it. */
export function SoundInspector() {
  const s = useStore();
  const list = soundClips(s.scene);
  const i = s.soundSel;
  const c = list[i];
  if (!c) return null;
  const setPiece = (patch, key) => editSounds((l) => void Object.assign(l[i], patch), key);
  const whole = c.src === recordingVideo(s.scene) ? "the recording" : "the file";
  const long = pieceLength(c);
  return html`
    <div class="panel-head clip-head"><h2>Sound</h2><span class="sub">${list.length > 1 ? `Piece ${i + 1} of ${list.length}` : "The recording's sound"}</span><span class="grow"></span>
      <button class="icon-btn sm" title="Delete this piece (⌫)" onClick=${() => deleteSound(i)}><${Icon} n="trash" s=${14} /></button>
      <button class="icon-btn sm" title="Close" onClick=${() => set({ soundSel: null })}><${Icon} n="x" s=${14} /></button>
    </div>
    <div class="panel-body">
      <div class="note">Drag the piece to move it, and its ends to trim it. To take a part out, cut at its start and its end (⌘B cuts at the playhead), then delete the piece between.</div>
      <${Section} title="Loudness">
        <div class="row"><label>Volume</label><${Slider} value=${c.volume ?? 1} min=${0} max=${1} step=${0.01} format=${(v) => `${Math.round(v * 100)}%`} onChange=${(v) => setPiece({ volume: v === undefined || v >= 0.995 ? undefined : r3(v) }, "volume")} /></div>
        <div class="row"><label>Fade in</label><${Slider} value=${c.fadeIn ?? 0} min=${0} max=${3} step=${0.1} format=${(v) => (v > 0 ? `${v.toFixed(1)} s` : "None")} onChange=${(v) => setPiece({ fadeIn: v ? r3(v) : undefined }, "fadeIn")} /></div>
        <div class="row"><label>Fade out</label><${Slider} value=${c.fadeOut ?? 0} min=${0} max=${3} step=${0.1} format=${(v) => (v > 0 ? `${v.toFixed(1)} s` : "None")} onChange=${(v) => setPiece({ fadeOut: v ? r3(v) : undefined }, "fadeOut")} /></div>
      <//>
      <${Section} title="Timing">
        <div class="row"><label>Starts at</label><${Num} value=${c.at} min=${0} max=${videoLength()} step=${0.1} digits=${2} unit="s" onChange=${(v) => v !== undefined && placeSound(i, v, videoLength(), "at")} /></div>
        <div class="note">${clock(long)} long: ${clock(c.from ?? 0)} to ${clock((c.from ?? 0) + long)} of ${whole}. It moves only into the room beside it (pieces never overlap); ← and → nudge it.</div>
      <//>
      <div class="hstack">
        <button class="btn" title="Cut the sound in two at the playhead (⌘B)" onClick=${cutSoundHere}><${Icon} n="scissors" s=${13} />Cut at the playhead</button>
        <button class="btn" onClick=${() => playPiece(c)}><${Icon} n="play" s=${13} />Play it</button>
      </div>
      ${s.scene.sounds && html`<button class="btn sm ghost" title="Undo every cut, move and change to the sound" onClick=${resetSounds}><${Icon} n="undo" s=${12} />Put the recording's sound back as it was</button>`}
    </div>`;
}

export function ClipInspector() {
  const s = useStore();
  const i = s.animSel;
  const a = s.scene.animations?.[i];
  if (!a) return null;
  if (targetsOf(a).includes(CAMERA)) return html`<${CameraInspector} i=${i} a=${a} />`;
  if (targetsOf(a).some(isCallout)) return html`<${CalloutInspector} i=${i} a=${a} />`;
  if (targetsOf(a).includes(BACKDROP)) return html`<${BackdropInspector} i=${i} a=${a} />`;
  const ids = targetsOf(a);
  const ents = ids.map((id) => s.layout?.entities.find((e) => e.id === id)).filter(Boolean);
  const kind = kindOf(a);
  const fx = a.enter ?? a.exit;
  const to = a.to ?? {};
  const all = (test) => ents.length > 0 && ents.every(test);
  const devices = all((e) => e.kind === "device");
  const texts = all((e) => e.kind === "caption" || e.kind === "text");
  const shapes = all((e) => e.kind === "shape");
  const lines = shapes && all((e) => e.shape.type === "arrow" || e.shape.type === "line");
  const ratings = shapes && all((e) => e.shape.type === "rating");
  const clays = devices && all((e) => e.clay);
  // Text with marks to draw in: a highlighter, an accent underline or pill.
  const marked = texts && ents.some((e) => {
    const t = e.kind === "caption" ? s.scene.textStyle ?? {} : s.scene.texts?.[e.index] ?? {};
    return Boolean(t.accentMark || t.decoration === "highlight");
  });
  const first = ents[0];
  // An entrance that also draws marks in or fills stars up, from nothing.
  const fromZero = (key, on) =>
    update(i, (x) => {
      if (on) x.from = { ...(x.from ?? {}), [key]: 0 };
      else if (x.from) {
        delete x.from[key];
        if (!Object.keys(x.from).length) delete x.from;
      }
    });
  // Its own soft focus, as a share of the canvas width (the slider's resting value).
  const W0 = s.layout?.canvas.width ?? 1000;
  const own = first?.blur ?? first?.shape?.blur ?? 0;
  const ownBlur = own > 0.5 ? own / W0 : own;
  const setKind = (next) =>
    update(i, (x) => {
      const effect = x.enter ?? x.exit ?? "fade";
      delete x.enter;
      delete x.exit;
      if (next === "loop") {
        // Keeps going for the whole video: a float, to start with.
        for (const key of ["to", "from", "path", "yoyo", "amount", "fade", "by", "each"]) delete x[key];
        Object.assign(x, structuredClone(LOOPS.float.clip), { repeat: true });
      } else if (next === "change") {
        if (x.repeat === true) {
          delete x.repeat;
          delete x.yoyo;
          delete x.path;
        }
        if (!x.to && !x.path) x.to = { scale: 1.15 };
        delete x.amount;
        delete x.fade;
      } else {
        x[next] = effect;
        for (const key of ["to", "from", "path", "repeat", "yoyo"]) delete x[key];
      }
    });
  // A ready-made loop, in place of the one it was (its timing stays).
  const setLoop = (name) =>
    update(i, (x) => {
      for (const key of ["to", "from", "path", "yoyo"]) delete x[key];
      const clip = structuredClone(LOOPS[name].clip);
      // Your own curve starts as a loop out to the right of the item and back.
      if (name === "curve") {
        const c = first ? entityCentre(toAnim(first)) : { x: 0.5, y: 0.5 };
        clip.path.points = [{ x: r3(c.x + 0.08), y: r3(c.y - 0.07) }, { x: r3(c.x + 0.16), y: r3(c.y) }, { x: r3(c.x + 0.08), y: r3(c.y + 0.07) }];
      }
      Object.assign(x, clip, { repeat: true });
    });
  // Straight to where it ends, or along a curve through points (dragged on the canvas).
  const setRoute = (curve) =>
    update(i, (x) => {
      if (!curve) return delete x.path;
      const c = first ? entityCentre(toAnim(first)) : { x: 0.5, y: 0.5 };
      const end = { x: r3(x.to?.x ?? c.x + 0.2), y: r3(x.to?.y ?? c.y) };
      if (x.to) {
        for (const key of ["x", "y", "dx", "dy"]) delete x.to[key];
        if (!Object.keys(x.to).length) delete x.to;
      }
      x.path = { points: [{ x: r3((c.x + end.x) / 2), y: r3(Math.min(c.y, end.y) - 0.12) }, end] };
    });
  const setPath = (patch) =>
    update(i, (x) => {
      x.path = { ...(x.path ?? {}), ...patch };
      for (const [k, v] of Object.entries(patch)) if (v === undefined || v === false) delete x.path[k];
    }, "path");
  // A value to change to: set it, or take it out so the item keeps its own.
  const setTo = (key, v) =>
    update(i, (x) => {
      x.to = { ...(x.to ?? {}) };
      if (v === undefined) delete x.to[key];
      else x.to[key] = v;
    }, `to.${key}`);
  const point = (key, base) => html`<div class="row"><label>${key === "start" ? "Start" : "End"}</label><div class="grid2">
    <${Num} label="X" value=${(to[key] ?? base).x} ...${pct} digits=${1} step=${0.5} onChange=${(v) => v !== undefined && setTo(key, { ...(to[key] ?? base), x: Math.round(v * 10000) / 10000 })} />
    <${Num} label="Y" value=${(to[key] ?? base).y} ...${pct} digits=${1} step=${0.5} onChange=${(v) => v !== undefined && setTo(key, { ...(to[key] ?? base), y: Math.round(v * 10000) / 10000 })} />
  </div></div>`;
  const row = (label, key, control) => html`<div class="row"><label>${label}</label>${control}${to[key] !== undefined && html`<button class="icon-btn sm clip-x" title="Leave this as it is" onClick=${() => setTo(key, undefined)}><${Icon} n="x" s=${11} /></button>`}</div>`;
  const amount = fx === "zoom" ? { label: "Starts at", min: 0, max: 2, fallback: 0.6, format: (v) => Math.round(v * 100) + "%" }
    : fx === "blur" ? { label: "Softness", min: 0.002, max: 0.04, fallback: DEFAULT_BLUR, format: (v) => Math.round(v * W0) + " px" }
    : fx === "scale-x" || fx === "scale-y" ? { label: "Starts at", min: 0, max: 1, fallback: 0, format: (v) => Math.round(v * 100) + "%" }
    : fx?.startsWith("slide") ? (a.by ? { label: "Distance", min: 0.1, max: 3, fallback: 0.6, format: (v) => v.toFixed(1) + "× height" } : { label: "Distance", min: 0.02, max: 1, fallback: 0.2, format: (v) => Math.round(v * 100) + "%" })
    : null;
  return html`
    <div class="panel-head clip-head"><h2>Animation</h2><span class="sub">${clipName(a)}</span><span class="grow"></span>
      <button class="icon-btn sm" title="Delete this animation (⌫)" onClick=${() => deleteAnimation(i)}><${Icon} n="trash" s=${14} /></button>
      <button class="icon-btn sm" title="Close" onClick=${() => set({ animSel: null })}><${Icon} n="x" s=${14} /></button>
    </div>
    <div class="panel-body">
      <div class="clip-targets">${ids.map((id) => html`<span class="pill">${entityLabel(id)}</span>`)}${ids.length > 1 && html`<span class="note">Move as one group: zooms and turns are about their shared middle.</span>`}</div>
      <${Seg} value=${kind} options=${[{ value: "enter", label: "Enter" }, { value: "change", label: "Change" }, { value: "loop", label: "Loop" }, { value: "exit", label: "Exit" }]} onChange=${setKind} />
      ${kind === "loop" &&
      html`<${Section} title="Keeps going">
          <div class="fx-grid">${Object.entries(LOOPS).map(([name, l]) => html`<button class="fx ${loopOf(a) === name ? "on" : ""}" key=${name} onClick=${() => setLoop(name)}><${LoopIcon} kind=${name} /><span>${l.label}</span></button>`)}</div>
          <div class="note">It keeps going until the video ends.${a.path?.points ? " Drag the points on the canvas to shape its route." : " Drag it on the canvas to set how far it goes."}</div>
          ${a.path?.shape && html`<div class="row"><label>Size</label><${Slider} value=${a.path.size} min=${0.005} max=${0.15} step=${0.001} fallback=${DEFAULT_PATH_SIZE} format=${(v) => Math.round(v * (s.layout?.canvas.width ?? 1000)) + " px"} onChange=${(v) => setPath({ size: v })} /></div>`}
          ${a.path && html`<${PathOptions} a=${a} setPath=${setPath} />`}
        <//>`}
      ${kind === "loop"
        ? null
        : kind !== "change"
        ? html`<${Section} title=${kind === "enter" ? "How it arrives" : "How it leaves"}>
            <div class="fx-grid">${FX_ORDER.map((f) => html`<button class="fx ${fx === f ? "on" : ""}" key=${f} onClick=${() => update(i, (x) => {
              x[kind] = f;
              delete x.amount;
            })}><${FxIcon} fx=${f} /><span>${FX[f]}</span></button>`)}</div>
            ${amount && html`<div class="row"><label>${amount.label}</label><${Slider} value=${a.amount} min=${amount.min} max=${amount.max} step=${0.01} fallback=${amount.fallback} format=${amount.format} onChange=${(v) => update(i, (x) => (x.amount = v), "amount")} /></div>`}
            ${fx !== "fade" && fx !== "none" && html`<${Switch} checked=${a.fade !== false} onChange=${(v) => update(i, (x) => (x.fade = v ? undefined : false))} label="Fade as well" />`}
            ${texts && html`<div class="row"><label>${kind === "enter" ? "Arrives" : "Leaves"}</label><${Seg} value=${a.by ?? "all"} options=${[{ value: "all", label: "As one" }, { value: "word", label: "By word" }, { value: "letter", label: "By letter" }]} onChange=${(v) => update(i, (x) => {
              // Slides are measured differently for pieces (text heights), so start from the default.
              delete x.each;
              delete x.amount;
              if (v === "all") delete x.by;
              else x.by = v;
            })} /></div>
              ${a.by && html`<div class="row"><label>Gap</label><${Slider} value=${a.each} min=${0.01} max=${0.5} step=${0.01} fallback=${DEFAULT_EACH[a.by]} format=${(v) => v.toFixed(2) + " s"} onChange=${(v) => update(i, (x) => (x.each = v), "each")} /></div>`}`}
            ${kind === "enter" && marked && html`<${Switch} checked=${a.from?.mark === 0} onChange=${(v) => fromZero("mark", v)} label="Marks draw in" />`}
            ${kind === "enter" && ratings && html`<${Switch} checked=${a.from?.value === 0} onChange=${(v) => fromZero("value", v)} label="Stars fill in" />`}
          <//>`
        : html`<${Section} title="Changes to">
            <div class="note">Set what it becomes: drag, resize or turn it on the canvas${lines ? ", or pull the arrow's ends and middle," : ""} or use the controls here. Anything you leave alone stays as it is.</div>
            ${row("Size", "scale", html`<${Slider} value=${to.scale} min=${0} max=${3} step=${0.01} fallback=${1} format=${(v) => Math.round(v * 100) + "%"} onChange=${(v) => setTo("scale", v)} />`)}
            ${row("Turn", "rotate", html`<${Slider} value=${to.rotate} min=${-360} max=${360} step=${1} centered fallback=${0} format=${(v) => v + "°"} onChange=${(v) => setTo("rotate", v)} />`)}
            ${row("Move →", "dx", html`<${Slider} value=${to.dx} min=${-1} max=${1} step=${0.005} centered fallback=${0} format=${(v) => Math.round(v * 100) + "%"} onChange=${(v) => setTo("dx", v)} />`)}
            ${row("Move ↓", "dy", html`<${Slider} value=${to.dy} min=${-1} max=${1} step=${0.005} centered fallback=${0} format=${(v) => Math.round(v * 100) + "%"} onChange=${(v) => setTo("dy", v)} />`)}
            ${row("Opacity", "opacity", html`<${Slider} value=${to.opacity} min=${0} max=${1} step=${0.01} fallback=${1} format=${(v) => Math.round(v * 100) + "%"} onChange=${(v) => setTo("opacity", v)} />`)}
            ${row("Blur", "blur", html`<${Slider} value=${to.blur} min=${0} max=${0.04} step=${0.001} fallback=${ownBlur} format=${(v) => (v > 0.0004 ? Math.round(v * W0) + " px" : "Sharp")} onChange=${(v) => setTo("blur", v)} />`)}
            ${devices && html`${row("3D tilt", "rotateX", html`<${Slider} value=${to.rotateX} min=${-60} max=${60} step=${1} centered fallback=${0} format=${(v) => v + "°"} onChange=${(v) => setTo("rotateX", v)} />`)}
              ${row("3D turn", "rotateY", html`<${Slider} value=${to.rotateY} min=${-75} max=${75} step=${1} centered fallback=${0} format=${(v) => v + "°"} onChange=${(v) => setTo("rotateY", v)} />`)}
              <div class="note">3D tilt and turn show in Preview and the exported video. To rack focus, give two devices a Change at the same moment: blur one, sharpen the other.</div>`}
            ${(texts || clays) && row(clays ? "Clay colour" : "Colour", "color", html`<${ColorButton} value=${to.color} auto="No change" onChange=${(v) => setTo("color", v)} />`)}
            ${marked && row("Marks drawn", "mark", html`<${Slider} value=${to.mark} min=${0} max=${1} step=${0.01} fallback=${1} format=${(v) => Math.round(v * 100) + "%"} onChange=${(v) => setTo("mark", v)} />`)}
            ${ratings && row("Stars", "value", html`<${Slider} value=${to.value} min=${0} max=${5} step=${0.1} fallback=${first.shape.value} format=${(v) => v.toFixed(1)} onChange=${(v) => setTo("value", v)} />`)}
            ${shapes && html`
              ${!lines && row("Fill", "fill", html`<${ColorButton} value=${to.fill} auto="No change" onChange=${(v) => setTo("fill", v)} />`)}
              ${row(lines ? "Colour" : "Stroke", "stroke", html`<${ColorButton} value=${to.stroke} auto="No change" onChange=${(v) => setTo("stroke", v)} />`)}
              ${row("Thickness", "strokeWidth", html`<${Slider} value=${to.strokeWidth} min=${0} max=${0.03} step=${0.0005} fallback=${first.shape.strokeWidth} format=${(v) => Math.max(0, Math.round(v * (s.layout?.canvas.height ?? 1000))) + " px"} onChange=${(v) => setTo("strokeWidth", v)} />`)}`}
            <div class="row"><label>Route</label><${Seg} value=${a.path ? "curve" : "straight"} options=${[{ value: "straight", label: "Straight" }, { value: "curve", label: "Along a curve" }]} onChange=${(v) => setRoute(v === "curve")} /></div>
            ${a.path && html`<div class="note">It travels through the points: drag them on the canvas.</div><${PathOptions} a=${a} setPath=${setPath} />`}
            ${lines && ents.length === 1 && html`
              ${point("start", first.shape.from)}
              ${point("end", first.shape.to)}
              ${row("Curve", "bend", html`<${Slider} value=${to.bend} min=${-1} max=${1} step=${0.01} centered fallback=${first.shape.bend} format=${(v) => (v ? Math.round(v * 100) + "%" : "Straight")} onChange=${(v) => setTo("bend", v)} />`)}
              <div class="note">Start and End are where the ${first.shape.type} runs from and to, as a share of the image: 0% is the left or top edge.</div>`}
          <//>`}
      <${TimingAndEasing} i=${i} a=${a} many=${ids.length > 1} repeatable=${kind === "change"} loop=${kind === "loop"} />
      <button class="btn block" onClick=${() => playClip(a)}><${Icon} n="play" s=${13} />Play this animation</button>
    </div>`;
}
