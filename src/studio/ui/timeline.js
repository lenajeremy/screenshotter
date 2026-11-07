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
import { addFootage, addFootageFile, addShot, deleteShot, goToShot, moveShot, previewShots, recordingFor, screenName, setInVideo, updateShot } from "./actions.js";
import { cameraFollow } from "./recording.js";
import { cutFootageHere, cutsOf, cuttable, deleteFootagePart, footageParts, removeSpan, selectPart, sourceAt } from "./footage.js";
import { toEdited } from "./cuts.js";
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
const shotLength = (x) => x.scene?.recording?.duration ?? x.length ?? Math.max(S.exportOpts.video.duration ?? 6, x.scene?.animations?.length ? Math.ceil((timelineEnd(x.scene.animations) + 1.2) * 2) / 2 : 0);

// Recordings on the canvas in Animate follow the playhead: they play, sound and all, while the
// timeline plays, and show the frame at the playhead when it's scrubbed or stopped.
const seekTo = (v, t) => Math.max(0, Math.min(t, (v.duration || Infinity) - 0.05));
export function followVideo(v, t = playhead.t) {
  if (!v || !S.timelineOpen) return;
  const at = seekTo(v, sourceAt(t));
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
    // Parts cut out of the recording are skipped: the playhead runs on the edited video's clock.
    const cuts = cutsOf();
    master.muted = recordingGain(playhead.t) <= 0;
    master.currentTime = seekTo(master, sourceAt(playhead.t));
    master.play().catch(() => undefined);
    const follow = () => {
      let src = master.currentTime;
      const gap = cuts.find((c) => src >= c.from - 0.02 && src < c.to - 0.02);
      if (gap) {
        master.currentTime = gap.to;
        src = gap.to;
      }
      const t = toEdited(src, cuts);
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
  set({ timelineOpen: true, stillPick: null });
}
export const toggleTimeline = () => (S.timelineOpen ? closeTimeline() : openTimeline());
export function closeTimeline() {
  pause();
  set({ timelineOpen: false, animSel: null, soundSel: null, footageSel: null, animRows: [] });
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
const label = (id) => (id === CAMERA ? "Camera" : id === BACKDROP ? "Background" : id === SOUND ? "Sound" : isCallout(id) ? calloutLabel(id) : entityLabel(id));
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

// ---------------------------------------------------------------------------------------------
// The design's own motion, under its animations: a gentle bob unless it says otherwise.

/** How a design can move on its own (its Motion setting). */
export const MOTION_OPTIONS = [
  { value: "none", label: "Still", note: "Nothing moves unless you animate it." },
  { value: "subtle", label: "Subtle", note: "The devices bob gently, as if held." },
  { value: "float", label: "Float", note: "The devices sway gently in 3D." },
  { value: "drift", label: "Drift", note: "The devices pan and turn slowly across the video." },
  { value: "push-in", label: "Push in", note: "The camera pushes in slowly over the whole video." },
];
/** A design's own motion: a recording has none; anything else is subtle unless set. */
export const motionOf = (scene = S.scene) => (scene.recording?.duration ? "none" : scene.motion ?? "subtle");
const smoothstep = (x) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));
/** A device's own motion at `t` (canvas px and degrees), as the video draws it. */
function ambientAt(motion, i, t, W, H, D) {
  const ph = i * 1.3;
  const w = (period) => Math.sin((2 * Math.PI * t) / period + ph);
  if (motion === "subtle") return { dx: 0, dy: w(6) * 0.004 * H, dr: w(7.5) * 0.35, drx: 0, dry: 0 };
  if (motion === "float") return { dx: 0, dy: w(5) * 0.012 * H, dr: 0, drx: w(6.3) * 2.2, dry: Math.cos((2 * Math.PI * t) / 7.1 + ph) * 3 };
  if (motion === "drift") {
    const k = smoothstep(t / D);
    return { dx: (k - 0.5) * 0.03 * W, dy: w(6) * 0.003 * H, dr: 0, drx: 0, dry: (0.5 - k) * 8 };
  }
  return null;
}
/** Set how the design moves on its own. */
export function setMotion(v) {
  edit((d) => {
    if (v === "subtle") delete d.motion;
    else d.motion = v;
  }, "motion");
}

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
  // The design's own motion: a bob or sway of each device, or a slow push of the camera.
  const motion = on ? motionOf(shot.scene) : "none";
  const D = Math.max(0.5, videoLength());
  // The camera, except while one of its moves is being framed (the viewfinder shows that).
  let cam = on && !(held && targetsOf(held.clip).includes(CAMERA)) ? evaluateCamera(anims, t, cameraFollow(shot.scene)) : undefined;
  if (motion === "push-in") {
    const c = cam ?? { zoom: 1, x: 0.5, y: 0.5 };
    cam = { ...c, zoom: c.zoom * (1 + 0.07 * smoothstep(t / D)) };
  }
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
    let st = states.get(el.dataset.id) ?? (ct ? IDLE : undefined);
    const am = e?.kind === "device" && !pinned && !(held && targetsOf(held.clip).includes(e.id)) ? ambientAt(motion, e.index, t, W0, H0, D) : null;
    if (am) {
      const b = st ?? IDLE;
      st = { ...b, dx: b.dx + am.dx, dy: b.dy + am.dy, rotate: b.rotate + am.dr, rotateX: (b.rotateX ?? 0) + am.drx, rotateY: (b.rotateY ?? 0) + am.dry };
    }
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
/** What a bar says on the timeline: a camera move's zoom fits a short bar ("1.8×", "1×" for a pull back);
 * its full name stays in the bar's tooltip. */
const barName = (a) => (targetsOf(a).includes(CAMERA) && !targetsOf(a).includes(BACKDROP) ? `${(a.to?.zoom ?? 1) <= 1.001 ? 1 : (a.to?.zoom ?? 1).toFixed(1)}×` : clipName(a));
const snap = (t) => Math.round(t * 20) / 20;

const update = (i, fn, key) =>
  edit((d) => {
    const a = d.animations?.[i];
    if (a) fn(a);
  }, key && `anim${i}.${key}`);

/** Changes part way, ready-made: what an item becomes, to fine-tune or drag on the canvas. */
const CHANGES = {
  grow: { label: "Grow", icon: "pulse", clip: { to: { scale: 1.15 } } },
  shrink: { label: "Shrink", icon: "pulse", clip: { to: { scale: 0.85 } } },
  rise: { label: "Move up", icon: "float", clip: { to: { dy: -0.04 } } },
  turn: { label: "Turn", icon: "sway", clip: { to: { rotate: 8 } } },
  dim: { label: "Dim", icon: "blink", clip: { to: { opacity: 0.35 } } },
  tilt: { label: "3D tilt", icon: "turn", clip: { to: { rotateY: -18 } }, devices: true },
};
const isText = (id) => id === "caption" || id.startsWith("text-");

/**
 * Add an animation for `ids` at the playhead (several items move as one group), and select it so
 * its settings show on the right. `spec` says what: { enter }, { exit } (an effect), { loop }
 * (a loop's name), { change } (a ready-made change), { camera: "in" | "out" }, { backdrop } (a
 * move's name) or { callout: "enter" | "exit" }. `at` is when (the playhead by default).
 */
export function addClip(ids, spec, at = snap(playhead.t)) {
  const list = S.scene.animations ?? [];
  const targets = ids.length === 1 ? ids[0] : ids;
  const first = S.layout?.entities.find((e) => e.id === ids[0]);
  let clip;
  if (spec.camera) {
    // Push in on the selected item (or the middle); or pull back to the whole design.
    const aim = S.layout?.entities.find((e) => e.id === S.selected);
    const c = aim ? entityCentre(toAnim(aim)) : { x: 0.5, y: 0.5 };
    clip = { targets: CAMERA, at, duration: 1, ease: "ease-in-out", to: spec.camera === "out" ? { zoom: 1 } : { zoom: 2, x: r3(c.x), y: r3(c.y) } };
  } else if (spec.backdrop) {
    const m = structuredClone(BACKDROP_MOVES[spec.backdrop].clip);
    clip = { targets: BACKDROP, at, ...m };
    // A one-off move runs to the end of the video unless its own length says otherwise.
    if (!m.duration) clip.duration = Math.max(1, snap(videoLength() - at));
    if (!m.repeat && !m.from) clip.ease = "ease-in-out";
  } else if (spec.callout) {
    clip = { targets, at, duration: 0.5, [spec.callout]: "fade" };
  } else if (spec.enter || spec.exit) {
    clip = { targets, at, duration: DEFAULT_DURATION, ...(spec.enter ? { enter: spec.enter } : { exit: spec.exit }) };
  } else if (spec.loop) {
    clip = { targets, at, ...structuredClone(LOOPS[spec.loop].clip), repeat: true };
    // Your own curve starts as a loop out to the right of the item and back.
    if (spec.loop === "curve") {
      const c = first ? entityCentre(toAnim(first)) : { x: 0.5, y: 0.5 };
      clip.path.points = [{ x: r3(c.x + 0.08), y: r3(c.y - 0.07) }, { x: r3(c.x + 0.16), y: r3(c.y) }, { x: r3(c.x + 0.08), y: r3(c.y + 0.07) }];
    }
  } else if (spec.change) {
    clip = { targets, at, duration: DEFAULT_DURATION, ...structuredClone(CHANGES[spec.change].clip) };
  }
  if (!clip) return;
  edit((d) => {
    d.animations = [...(d.animations ?? []), clip];
  });
  if (!S.timelineOpen) openTimeline();
  selectAnimation(list.length);
  persistPrefs();
}

/** The + on a row: what to add there, at the playhead. */
function AddPopover({ anchor, ids, onClose }) {
  const [tab, setTab] = useState("enter");
  const id = ids[0];
  const add = (spec) => {
    onClose();
    addClip(ids, spec);
  };
  const when = `at ${playhead.t.toFixed(1)}s`;
  const head = (title) => html`<div class="add-head"><b>${title}</b><span>${when}</span></div>`;
  if (id === CAMERA)
    return html`<${Popover} anchor=${anchor} onClose=${onClose} class="add-pop" width=${270}>
      ${head("The camera")}
      <button class="add-row" onClick=${() => add({ camera: "in" })}><${Icon} n="plus" s=${14} /><span><b>Zoom in here</b><small>${S.selected ? `On ${entityLabel(S.selected)}` : "On the middle; select an item first to zoom on it"}</small></span></button>
      <button class="add-row" onClick=${() => add({ camera: "out" })}><${Icon} n="fit" s=${14} /><span><b>Pull back</b><small>Back out to the whole design</small></span></button>
    <//>`;
  if (id === BACKDROP)
    return html`<${Popover} anchor=${anchor} onClose=${onClose} class="add-pop" width=${300}>
      ${head("The background")}
      <div class="fx-grid">${Object.entries(BACKDROP_MOVES).map(([name, m]) => html`<button class="fx" key=${name} onClick=${() => add({ backdrop: name })}><${LoopIcon} kind=${name} /><span>${m.label}</span></button>`)}</div>
    <//>`;
  if (ids.every(isCallout))
    return html`<${Popover} anchor=${anchor} onClose=${onClose} class="add-pop" width=${260}>
      ${head(ids.length > 1 ? `${ids.length} call-outs` : label(id))}
      <button class="add-row" onClick=${() => add({ callout: "enter" })}><${Icon} n="eye" s=${14} /><span><b>Appears</b><small>The way its style does</small></span></button>
      <button class="add-row" onClick=${() => add({ callout: "exit" })}><${Icon} n="x" s=${14} /><span><b>Leaves</b></span></button>
    <//>`;
  const devices = ids.every((x) => x.startsWith("device-"));
  const texts = ids.every(isText);
  return html`<${Popover} anchor=${anchor} onClose=${onClose} class="add-pop" width=${330}>
    ${head(ids.length > 1 ? `${ids.length} items, together` : label(id))}
    <${Seg} value=${tab} onChange=${setTab} options=${[{ value: "enter", label: "Comes in" }, { value: "loop", label: "Keeps moving" }, { value: "change", label: "Changes" }, { value: "exit", label: "Leaves" }]} />
    ${tab === "enter" || tab === "exit"
      ? html`<div class="fx-grid">${(tab === "enter" && texts ? ["slide-up", ...FX_ORDER.filter((f) => f !== "slide-up")] : FX_ORDER).map((f) => html`<button class="fx" key=${f} onClick=${() => add({ [tab]: f })}><${FxIcon} fx=${f} /><span>${FX[f]}</span></button>`)}</div>
        ${texts && tab === "enter" && html`<div class="note">Text can come in a word or a letter at a time: choose it in its settings after.</div>`}`
      : tab === "loop"
        ? html`<div class="fx-grid">${Object.entries(LOOPS).map(([name, l]) => html`<button class="fx" key=${name} onClick=${() => add({ loop: name })}><${LoopIcon} kind=${name} /><span>${l.label}</span></button>`)}</div>
          <div class="note">It keeps going until the video ends.</div>`
        : html`<div class="fx-grid">${Object.entries(CHANGES).filter(([, c]) => !c.devices || devices).map(([name, c]) => html`<button class="fx" key=${name} onClick=${() => add({ change: name })}><${LoopIcon} kind=${c.icon} /><span>${c.label}</span></button>`)}</div>
          <div class="note">Then drag it on the canvas to where it should end up, or fine-tune it on the right.</div>`}
  <//>`;
}

/** When an animation added from an item's own settings starts, with the timeline closed. */
function quickAt(kind) {
  if (S.timelineOpen) return snap(playhead.t);
  return kind === "exit" ? Math.max(0.5, snap(videoLength() - 1)) : kind === "change" ? 1.5 : kind === "loop" ? 0 : 0.3;
}

/** An item's animation, in its own settings: how it comes in, keeps moving, changes and leaves. */
export function AnimationSection({ id }) {
  const s = useStore();
  const mine = (s.scene.animations ?? []).map((a, i) => ({ a, i })).filter(({ a }) => targetsOf(a).includes(id));
  const ROWS = [
    { kind: "enter", title: "Comes in", spec: { enter: isText(id) ? "slide-up" : "zoom" }, sum: (a) => `${FX[a.enter]}${a.by ? ` by ${a.by}` : ""} · ${a.at.toFixed(1)}s` },
    { kind: "loop", title: "Keeps moving", spec: { loop: "float" }, sum: (a) => LOOPS[loopOf(a)]?.label ?? "Loop" },
    { kind: "change", title: "Changes part way", spec: { change: "grow" }, sum: (a) => `${clipName(a)} · ${a.at.toFixed(1)}s` },
    { kind: "exit", title: "Leaves", spec: { exit: "fade" }, sum: (a) => `${FX[a.exit]} · ${a.at.toFixed(1)}s` },
  ];
  const open = (i) => {
    if (!S.timelineOpen) openTimeline();
    selectAnimation(i);
  };
  // A still design doesn't need four empty rows on every item: one row says it can move, and
  // opens the timeline on this item's row, where its + adds the first animation.
  if (!mine.length && !s.timelineOpen)
    return html`<${Section} title="Animation">
      <div class="anim-rows"><button class="anim-row" title="Open the timeline (⌘T) on this item's row" onClick=${() => (openTimeline(), set({ animRows: [id], animSel: null }))}>
        <span class="ar-name">Animate it</span><span class="ar-val">On the timeline</span><${Icon} n="right" s=${12} />
      </button></div>
    <//>`;
  return html`<${Section} title="Animation">
    <div class="anim-rows">${ROWS.map((r) => {
      const got = mine.filter(({ a }) => kindOf(a) === r.kind);
      return html`<button class="anim-row ${got.length ? "set" : ""}" key=${r.kind} title=${got.length ? "Change it" : `Add one: it shows on the timeline (⌘T)`} onClick=${() => (got.length ? open(got[0].i) : addClip([id], r.spec, quickAt(r.kind)))}>
        <span class="ar-name">${r.title}</span><span class="ar-val">${got.length ? got.map(({ a }) => r.sum(a)).join(", ") : "None"}</span><${Icon} n=${got.length ? "right" : "plus"} s=${12} />
      </button>`;
    })}</div>
    ${s.timelineOpen ? null : html`<div class="note">The timeline (⌘T) shows when each happens.</div>`}
  <//>`;
}

// ---------------------------------------------------------------------------------------------
// Motion styles: ready-made ways in, written as ordinary animations to change on the timeline.

const STYLES = [
  { value: "one-by-one", label: "One by one", note: "The headline rises word by word, then each device zooms in, then the rest, one after another." },
  { value: "lively", label: "Lively", note: "Everything pops in with a little overshoot, and the devices float." },
  { value: "tour", label: "Tour", note: "Everything fades in, then the camera visits each device and each line of text in turn, and pulls back." },
];

/** A style's animations for the design as it is, and the motion it goes with. */
function styleOf(name, scene = S.scene, layout = S.layout) {
  const ents = layout?.entities ?? [];
  if (!ents.length) return null;
  const r2 = (v) => Math.round(v * 100) / 100;
  const kind = (k) => ents.filter((e) => e.kind === k);
  const captions = kind("caption");
  const devices = kind("device");
  const rest = [...kind("text"), ...kind("image"), ...kind("shape")];
  const clips = [];
  if (name === "tour") {
    for (const e of [...captions, ...devices, ...rest]) clips.push({ targets: e.id, at: 0, duration: 0.6, enter: "fade" });
    // The camera calls on each device and each line of text, a couple of seconds each, then pulls back.
    const stops = [...devices, ...kind("text")].slice(0, 5);
    let at = 1.2;
    for (const e of stops) {
      const c = entityCentre(toAnim(e));
      clips.push({ targets: CAMERA, at: r2(at), duration: 0.9, ease: "ease-in-out", to: { zoom: e.kind === "device" ? 1.6 : 2.2, x: r3(c.x), y: r3(c.y) } });
      at += 2;
    }
    if (stops.length) clips.push({ targets: CAMERA, at: r2(at), duration: 0.9, ease: "ease-in-out", to: { zoom: 1 } });
    return { motion: "none", animations: clips };
  }
  const lively = name === "lively";
  const pop = lively ? { ease: "back-out" } : {};
  let t = 0.3;
  for (const e of captions) {
    clips.push({ targets: e.id, at: r2(t), duration: 0.7, enter: lively ? "zoom" : "slide-up", by: "word", ...pop });
    t += 0.6;
  }
  devices.forEach((e, i) => clips.push({ targets: e.id, at: r2(t + i * 0.25), duration: 0.8, enter: lively ? "slide-up" : "zoom", ...pop }));
  if (devices.length) t += 0.8 + (devices.length - 1) * 0.25;
  for (const e of rest) {
    clips.push({ targets: e.id, at: r2(t), duration: 0.5, enter: lively ? "zoom" : "fade", ...pop });
    t += 0.25;
  }
  // Each device's call-outs, one after another.
  for (const d of devices)
    (scene.devices?.[d.index]?.highlights ?? []).forEach((_, k) => {
      clips.push({ targets: `${d.id}/callout-${k + 1}`, at: r2(t), duration: 0.5, enter: "fade" });
      t += 0.5;
    });
  return { motion: lively ? "float" : "subtle", animations: clips };
}
const isStyle = (name) => {
  const st = styleOf(name);
  return Boolean(st?.animations.length) && st.motion === motionOf() && JSON.stringify(st.animations) === JSON.stringify(S.scene.animations ?? []);
};

/** Put a style's animations on the timeline (in place of what's there) and play them. */
export function applyStyle(name) {
  const st = styleOf(name);
  if (!st) return;
  const had = S.scene.animations?.length ?? 0;
  edit((d) => {
    if (st.animations.length) d.animations = st.animations;
    else delete d.animations;
    if (st.motion === "subtle") delete d.motion;
    else d.motion = st.motion;
  });
  openTimeline();
  set({ animSel: null, soundSel: null });
  setPlayhead(0);
  play();
  const label = STYLES.find((x) => x.value === name)?.label;
  if (had) toast({ kind: "ok", icon: "animate", title: label, text: `In place of the ${had} animation${had === 1 ? "" : "s"} it had. ⌘Z brings ${had === 1 ? "it" : "them"} back.`, timeout: 5000 });
}

/** The design's Motion settings: how it moves on its own, ready-made ways in, and how long it runs. */
export function MotionSection() {
  const s = useStore();
  const [hover, setHover] = useState(null);
  if (s.scene.recording?.duration) return null;
  const now = motionOf(s.scene);
  const style = STYLES.find((x) => isStyle(x.value));
  const n = s.scene.animations?.length ?? 0;
  const note = hover?.note ?? style?.note ?? (n ? `${n} animation${n === 1 ? "" : "s"} on its timeline (⌘T).` : MOTION_OPTIONS.find((m) => m.value === now)?.note);
  return html`<${Section} title="Motion">
    <div class="lbl">On its own</div>
    <div class="motions">${MOTION_OPTIONS.map((m) => html`<button class="motion ${now === m.value ? "on" : ""}" key=${m.value} title=${m.note} onMouseEnter=${() => setHover(m)} onMouseLeave=${() => setHover(null)} onClick=${() => setMotion(m.value)}><i class="mini mo-${m.value}"></i>${m.label}</button>`)}</div>
    <div class="lbl">Bring it in</div>
    <div class="chips">${STYLES.map((x) => html`<button class="chip ${style?.value === x.value ? "on" : ""}" key=${x.value} title=${x.note} onMouseEnter=${() => setHover(x)} onMouseLeave=${() => setHover(null)} onClick=${() => applyStyle(x.value)}>${x.label}</button>`)}</div>
    <div class="note">${note}</div>
    ${!(s.shots?.length > 1) &&
    html`<div class="row"><label>Length</label><${Slider} value=${s.exportOpts.video.duration} min=${2} max=${30} step=${0.5} format=${(v) => v + " s"} onChange=${(v) => {
      set({ exportOpts: { ...S.exportOpts, video: { ...S.exportOpts.video, duration: v ?? 6 } } });
      persistPrefs();
    }} /></div>`}
    <button class="btn block" onClick=${toggleTimeline}><${Icon} n="animate" s=${13} />${s.timelineOpen ? "Close the timeline" : "Open the timeline"}<span class="kbd">⌘T</span></button>
  <//>`;
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

const ROW_ICON = { footage: "video", motion: "animate", camera: "camera", backdrop: "background", device: "phone", callout: "highlight", caption: "text", text: "text", image: "image", shape: "shapes", sound: "sound" };
/** A row's icon: a recording's screen and its webcam aren't phones. */
const rowIcon = (e, scene) => {
  const d = e.kind === "device" ? scene.devices?.[e.index] : null;
  if (d?.fixed) return "webcam";
  if (d && scene.recording?.duration) return "monitor";
  return ROW_ICON[e.kind];
};
/** The row for the design's own motion (not an item). */
const MOTION_ROW = "motion";
/** The row for the video's clips: its footage and pictures, one after another. */
export const FOOTAGE = "footage";
/** Room after the timeline for the Footage row's +. */
const ADD_ROOM = 40;
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
  // One timeline for the whole video: the screen on the canvas is the span from `off`, `len` long.
  const many = manyShots() && !offVideo();
  const plan = many ? videoPlan() : null;
  const off = many ? plan.starts[s.shot] : 0;
  const total = many ? plan.total : len;
  const list = s.scene.animations ?? [];
  const entities = s.layout?.entities ?? [];
  // Text first, then devices, then shapes: roughly the order things are introduced.
  // Each device's call-outs sit under it.
  const motion = motionOf(s.scene);
  const rows = [...(motion !== "none" ? [{ id: MOTION_ROW, kind: "motion" }] : []), { id: CAMERA, kind: "camera" }, { id: BACKDROP, kind: "backdrop" }, ...entities.filter((e) => e.kind === "caption" || e.kind === "text"), ...entities.filter((e) => e.kind === "device").flatMap((e) => [e, ...calloutRows(e)]), ...entities.filter((e) => e.kind === "image"), ...entities.filter((e) => e.kind === "shape"), { id: FOOTAGE, kind: "footage" }, ...(hasSoundRow(s.scene) ? [{ id: SOUND, kind: "sound" }] : [])];
  const ents = entities.map(toAnim);
  // Zoomed in, a second gets up to 400px; the timeline scrolls sideways.
  const maxZoom = Math.max(1, (400 * total) / Math.max(1, width));
  const z = clamp(zoom, 1, maxZoom);
  const pps = (width / total) * z;

  useLayoutEffect(() => {
    const el = body.current;
    if (!el) return;
    // The names column, the tracks' margins and room for the Footage row's + aren't timeline.
    const measure = () => setWidth(Math.max(120, el.clientWidth - 172 - 28 - ADD_ROOM));
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    measure();
    return () => ro.disconnect();
  }, []);
  /** Zoom to `next`, keeping the moment at `clientX` (default: the playhead) where it is. */
  const setZoom = (next, clientX) => {
    const el = body.current;
    const left = tracks.current?.getBoundingClientRect().left ?? 0;
    const x = clientX ?? left + (many ? video.T : playhead.t) * pps;
    anchor.current = { t: clamp((x - left) / pps, 0, total), x: x - el.getBoundingClientRect().left };
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
  // The playhead line and the clock follow without re-rendering the dock: the whole video's clock
  // when it has several screens (outside the one on the canvas, its rows' + buttons step aside).
  useEffect(() => {
    const show = (T) => {
      if (line.current) {
        line.current.style.transform = `translateX(${T * pps}px)`;
        line.current.classList.toggle("outside", many && (T < off - 1e-6 || T > off + len + 1e-6));
      }
      if (time.current) time.current.textContent = clock(T);
      // Zoomed in and playing: the timeline keeps the playhead in view.
      const el = body.current;
      if (el && S.playing && z > 1) {
        const x = 172 + 12 + T * pps;
        if (x > el.scrollLeft + el.clientWidth - 48 || x < el.scrollLeft + 172) el.scrollLeft = Math.max(0, x - 172 - 48);
      }
    };
    if (!many) {
      show(playhead.t);
      return onPlayhead(show);
    }
    const stop = onVideoTime((T) => show(T));
    setVideoTime(video.T);
    return stop;
  }, [pps, z, many, off, len]);
  // Editing another screen: the clock moves into it (keeping its place if it's already there).
  useEffect(() => {
    if (!many) return;
    if (video.T < off - 1e-6 || video.T > off + len + 1e-6) setVideoTime(off + Math.min(playhead.t, len));
    else setVideoTime(video.T);
  }, [many, s.shot, s.shots?.length]);
  useEffect(() => {
    if (playhead.t > len) setPlayhead(len);
  }, [len]);

  /** The moment under the pointer, on the whole video's clock. */
  const timeAt = (clientX) => clamp((clientX - tracks.current.getBoundingClientRect().left) / pps, 0, total);
  /** Move the playhead to a moment of the whole video. */
  const goTo = (T) => (many ? setVideoTime(T) : setPlayhead(T));
  const scrub = (e) => {
    if (e.button !== 0) return;
    pause();
    goTo(timeAt(e.clientX));
    const move = (m) => goTo(timeAt(m.clientX));
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
    if (id === MOTION_ROW) return set({ selected: null, animSel: null, soundSel: null, animRows: [], rightOpen: true });
    if (id === FOOTAGE) return set({ animRows: [FOOTAGE], animSel: null, soundSel: null, selected: null });
    const solo = (x) => x === CAMERA || x === BACKDROP || x === SOUND;
    const group = (x) => (solo(x) ? x : isCallout(x) ? "callout" : "item");
    const many = (e.metaKey || e.ctrlKey || e.shiftKey) && !solo(id) && s.animRows.every((x) => group(x) === group(id));
    const rowsNow = many ? (s.animRows.includes(id) ? s.animRows.filter((x) => x !== id) : [...s.animRows, id]) : [id];
    // A call-out's row selects its device on the canvas.
    set({ animRows: rowsNow, animSel: null, soundSel: null, ...(solo(id) ? {} : { selected: id.split("/")[0] }) });
  };
  const chosen = s.animRows.length ? s.animRows : s.selected ? [s.selected] : [];
  // Each row that takes animations has a + at the playhead; the popover it opens adds one there.
  const [plus, setPlus] = useState([]);
  const [adding, setAdding] = useState(null);
  const rowKey = rows.map((r) => r.id).join("|");
  useLayoutEffect(() => {
    const el = tracks.current;
    if (!el) return;
    const next = [...el.querySelectorAll(":scope > .tl-row[data-row]")]
      .filter((r) => r.dataset.row !== SOUND && r.dataset.row !== MOTION_ROW && r.dataset.row !== FOOTAGE)
      .map((r) => ({ id: r.dataset.row, top: r.offsetTop, h: r.offsetHeight }));
    if (JSON.stringify(next) !== JSON.stringify(plus)) setPlus(next);
  });
  /** Open the + popover for a row; several chosen rows together get one animation as a group. */
  const openAdd = (id, el) => {
    if (adding?.id === id) return setAdding(null);
    pause();
    const ids = chosen.length > 1 && chosen.includes(id) ? chosen : [id];
    if (!chosen.includes(id) || chosen.length === 1) pickRow({}, id);
    setAdding({ id, ids, el });
  };
  /** Right-click a spot on a row: the playhead goes there and the + opens. */
  const addHere = (ev, id) => {
    ev.preventDefault();
    ev.stopPropagation();
    if (id === SOUND || id === MOTION_ROW || id === FOOTAGE) return;
    // Only within the screen on the canvas (its rows are its own).
    goTo(clamp(timeAt(ev.clientX), off, off + len));
    requestAnimationFrame(() => {
      const el = line.current?.querySelector(`[data-add="${CSS.escape(id)}"]`);
      if (el) openAdd(id, el);
    });
  };
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
  const ticks = Array.from({ length: Math.floor(total / step + 1e-6) + 1 }, (_, n) => Math.round(n * step * 1000) / 1000).filter((t) => (total - t) * pps >= 34);

  return html`<section class="tl-dock" onPointerDown=${stop}>
    <i class="tl-grip" title="Drag to make the timeline taller or shorter. Double-click for the usual height." onPointerDown=${resize} onDblClick=${usualHeight}></i>
    <header class="tl-head">
      <button class="icon-btn tl-play" title=${s.playing ? "Pause (Space)" : "Play (Space)"} onClick=${() => play()}><${Icon} n=${s.playing ? "pause" : "play"} s=${15} /></button>
      <span class="tl-clock" title=${many ? "Where the whole video is, and how long it runs" : ""}><b ref=${time}>0:00.0</b><span> / ${clock(total)}</span></span>
      ${chosen.includes(FOOTAGE) && cuttable(s.scene) &&
      html`<button class="btn sm primary" title="Cut the footage in two at the playhead (⌘B)" onClick=${cutFootageHere}><${Icon} n="scissors" s=${13} />Cut at the playhead</button>
        ${s.footageSel != null && html`<button class="btn sm" title="Take the chosen part out: everything after moves up (⌫)" onClick=${() => deleteFootagePart(s.footageSel)}><${Icon} n="trash" s=${13} />Delete part</button>`}`}
      ${chosen.includes(SOUND) &&
      html`<button class="btn sm primary" title="Cut the sound in two at the playhead (⌘B)" onClick=${cutSoundHere}><${Icon} n="scissors" s=${13} />Cut at the playhead</button>
        ${s.soundSel !== null && html`<button class="btn sm" title="Delete the chosen piece of sound (⌫)" onClick=${() => deleteSound(s.soundSel)}><${Icon} n="trash" s=${13} />Delete piece</button>`}`}
      <span class="grow"></span>
      ${s.scene.recording?.duration ? html`<span class="tl-len" title="A recording runs its own length">Recording · ${clock(len)}</span>` : html`<label class="tl-len" title=${s.shots?.length > 1 ? "How long this screen is on, its transitions included." : "How long the video runs. It's never shorter than the animations need."}><span class="tl-len-name">${s.shots?.length > 1 ? `Screen ${s.shot + 1}` : "Length"}</span>
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
    <div class="tl-body ${z > 1.001 ? "zoomed" : ""}" ref=${body} onWheel=${wheel}>
      <div class="tl-names">
        <div class="tl-corner">${list.length ? `${list.length} animation${list.length === 1 ? "" : "s"}` : "Items"}</div>
        ${rows.map(
          (e) => html`<button class="tl-name ${e.kind === "callout" ? "sub" : ""} ${e.kind === "sound" ? "sound" : ""} ${chosen.includes(e.id) ? "on" : ""}" key=${e.id} title=${e.kind === "sound" ? "The video's sound: drag a piece to move it, its ends to trim it, and cut it at the playhead (⌘B)" : e.kind === "motion" ? "How the design moves on its own: change it in its Motion settings" : e.kind === "footage" ? "The video's clips, one after another: videos and pictures. The + at its end adds another." : "Click to choose; ⌘-click to choose several and animate them together. The + at the playhead adds how it moves."} onClick=${(ev) => pickRow(ev, e.id)}>
            <${Icon} n=${rowIcon(e, s.scene)} s=${13} /><span>${e.kind === "motion" ? "On its own" : e.kind === "footage" ? "Footage" : label(e.id)}</span>
          </button>`,
        )}
      </div>
      <div class="tl-tracks" ref=${tracks} style=${{ width: total * pps + "px", "--off": off * pps + "px", "--span": len * pps + "px" }}>
        <div class="tl-ruler" onPointerDown=${scrub}>
          ${ticks.map((n) => html`<span class="tl-tick" key=${n} style=${{ left: n * pps + "px" }}>${tickLabel(n, step, total)}</span>`)}
        </div>
        ${rows.map(
          (e) => html`<div class="tl-row ${e.kind} ${chosen.includes(e.id) ? "on" : ""}" key=${e.id} data-row=${e.id} onPointerDown=${scrub} onContextMenu=${(ev) => addHere(ev, e.id)}>
            ${e.kind === "footage"
              ? html`<${FootageTrack} pps=${pps} plan=${plan} len=${len} on=${chosen.includes(FOOTAGE)} />`
              : html`<div class="tl-lane ${many ? "part" : ""}">
            ${e.kind === "sound" && html`<${SoundPieces} pps=${pps} len=${len} now=${() => playhead.t} cut=${cutSoundHere} play=${playPiece} />`}
            ${e.kind === "motion" &&
            html`<div class="tl-bar ambient" style=${{ left: 0, width: len * pps + "px" }} title="The design's own motion, for the whole video. Change it in its Motion settings (click)." onPointerDown=${(ev) => {
              ev.stopPropagation();
              set({ selected: null, animSel: null, soundSel: null, animRows: [], rightOpen: true });
            }}><span>${MOTION_OPTIONS.find((m) => m.value === motion)?.label}</span></div>`}
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
                <span>${barName(a)}</span>
                <i class="tl-edge" onPointerDown=${(ev) => dragBar(ev, i, k, true)}></i>
              </div>`;
            })}
            </div>`}
          </div>`,
        )}
        ${!rows.length && html`<div class="tl-empty">Add a screenshot first.</div>`}
        ${rows.length > 0 && !list.length && html`<div class="tl-hint">Move the playhead to when something should happen, then press + on its row.</div>`}
        <div class="tl-line" ref=${line}><i></i>
          ${plus.map((r) => html`<button class="tl-add ${chosen.includes(r.id) ? "on" : ""} ${adding?.id === r.id ? "open" : ""}" key=${r.id} data-add=${r.id} style=${{ top: r.top + r.h / 2 - 9 + "px" }} title=${`Add to ${r.id === CAMERA ? "the camera" : r.id === BACKDROP ? "the background" : label(r.id)}, here`} onPointerDown=${stop} onClick=${(ev) => openAdd(r.id, ev.currentTarget)}><${Icon} n="plus" s=${12} w=${2.4} /></button>`)}
        </div>
        ${adding && html`<${AddPopover} anchor=${adding.el} ids=${adding.ids} onClose=${() => setAdding(null)} />`}
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
  return html`<button class="shot-join ${open ? "on" : ""}" ref=${ref} style=${at !== undefined ? { left: at + "px" } : null} title=${`${TRANSITION_NAMES[type]} into screen ${i + 1}`} onPointerDown=${(e) => e.stopPropagation()} onClick=${() => setOpen(!open)}>
      <${TransitionIcon} type=${type} />
    </button>
    ${open &&
    html`<${Popover} anchor=${ref.current} align="center" class="join-pop" onClose=${() => setOpen(false)}>
      <div class="join-head">Into screen ${i + 1}</div>
      <div class="fx-grid">${Object.entries(TRANSITION_NAMES).map(([name, label]) => html`<button class="fx ${type === name ? "on" : ""}" key=${name} onClick=${() => updateShot(i, { transition: { type: name, duration: name === "cut" ? undefined : (t?.duration ?? 0.5) } })}><${TransitionIcon} type=${name} /><span>${label}</span></button>`)}</div>
      ${type !== "cut" && html`<div class="row"><label>Takes</label><${Slider} value=${t?.duration} min=${0.1} max=${2} step=${0.05} fallback=${0.5} format=${(v) => v.toFixed(2) + " s"} onChange=${(v) => updateShot(i, { transition: { type, duration: v ?? 0.5 } })} /></div>`}
    <//>`}`;
}

// Shot pictures, remembered by what's in them (the newest few).
const thumbs = new Map();
function ShotThumb({ scene, film, single }) {
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
  if (film) return img ? html`<i class="shot-film ${single ? "single" : ""}" style=${{ backgroundImage: `url(${img})` }}></i>` : html`<i class="shot-blank"></i>`;
  return img ? html`<img src=${img} alt="" draggable=${false} />` : html`<i class="shot-blank"></i>`;
}

/** Steps between the frames a video clip shows: the smallest that leaves each frame room. */
const FRAME_STEPS = [0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
const mediaLengths = new Map();
/** How long a video file runs (asked of the engine once, then remembered). */
function useMediaLength(file) {
  const [n, setN] = useState(() => mediaLengths.get(file));
  useEffect(() => {
    if (!file || mediaLengths.has(file)) return setN(mediaLengths.get(file));
    let live = true;
    api(`/api/media-length?path=${encodeURIComponent(file)}`)
      .then((r) => {
        mediaLengths.set(file, r.duration || 0);
        if (live) setN(r.duration || 0);
      })
      .catch(() => undefined);
    return () => (live = false);
  }, [file]);
  return n;
}

/** The video a screen plays (its recording, else the first device's), if any. */
export const footageOf = (scene) => scene?.recording?.video ?? scene?.devices?.find((d) => d.video)?.video;

/** A stretch of a video's frames, from `from` to `to` in the file: one at a steady step, so zooming reuses them. */
function Frames({ file, from, to, pps }) {
  const dur = useMediaLength(file);
  // A frame about as wide as the row is tall; the same moments at every zoom, so they're reused.
  const step = FRAME_STEPS.find((x) => x * pps >= 56) ?? 1200;
  const last = Math.max(0.05, Math.min(to, dur || to) - 0.05);
  const times = [];
  for (let t = Math.floor(from / step) * step; t < to - 1e-6 && times.length < 400; t += step) times.push(t);
  return html`<span class="clip-frames" style=${{ left: (times[0] - from) * pps + "px" }}>${times.map((t) => html`<img key=${t} loading="lazy" draggable=${false} alt="" src=${`/api/moment?path=${encodeURIComponent(file)}&t=${clamp(t + step / 2, 0, last).toFixed(2)}&w=160`} style=${{ width: step * pps + "px" }} />`)}</span>`;
}

/** A clip's look on the Footage row: its video's frames, or its picture. */
function ClipFrames({ scene, len, pps, single }) {
  const vid = footageOf(scene);
  // A still design on its own is one picture for its whole length, not frames of film.
  if (!vid) return html`<${ShotThumb} scene=${scene} film single=${single} />`;
  return html`<${Frames} file=${vid} from=${0} to=${len} pps=${pps} />`;
}

/**
 * The recording on the canvas, on the Footage row: its parts (cut at the playhead with ⌘B) to
 * choose and take out, and its ends to drag in to trim it. The rest moves up.
 */
function CutClip({ scene, at, len, pps, on, menu }) {
  const s = useStore();
  const [trim, setTrim] = useState(null);
  const file = scene.recording.video;
  const parts = footageParts(scene);
  // Drag an end in: the stretch it passes over goes when it's let go.
  const drag = (e, side) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    pause();
    const x0 = e.clientX;
    let by = 0;
    const move = (m) => {
      by = clamp(((m.clientX - x0) / pps) * (side === "start" ? 1 : -1), 0, Math.max(0, len - 0.1));
      setTrim({ side, by });
    };
    const up = () => {
      removeEventListener("pointermove", move);
      removeEventListener("pointerup", up);
      setTrim(null);
      if (by >= 0.05) side === "start" ? removeSpan(0, by) : removeSpan(len - by, len);
    };
    addEventListener("pointermove", move);
    addEventListener("pointerup", up);
  };
  return html`<div class="tl-clip current cut ${on ? "on" : ""}" style=${{ left: at * pps + "px", width: Math.max(14, len * pps) + "px" }} onContextMenu=${menu}>
    ${parts.map(
      (p, k) => html`<button class="tl-part ${on && s.footageSel === k ? "on" : ""}" key=${`${p.from}`} style=${{ left: p.at * pps + "px", width: Math.max(4, (p.to - p.from) * pps - (k < parts.length - 1 ? 1 : 0)) + "px" }}
          title=${`${(p.to - p.from).toFixed(1)} s, from ${clock(p.from)} of the recording. Click to choose it; ⌫ takes it out.`}
          onClick=${() => selectPart(k)}>
        <${Frames} file=${file} from=${p.from} to=${p.to} pps=${pps} />
      </button>`,
    )}
    ${trim && html`<i class="tl-trimmed" style=${trim.side === "start" ? { left: 0, width: trim.by * pps + "px" } : { right: 0, width: trim.by * pps + "px" }}></i>`}
    <i class="tl-trim at-start" title="Drag to trim the start" onPointerDown=${(e) => drag(e, "start")}></i>
    <i class="tl-trim at-end" title="Drag to trim the end" onPointerDown=${(e) => drag(e, "end")}></i>
  </div>`;
}

/** The + at the end of the Footage row: a video or a picture from your library, or a file. */
function AddFootage({ anchor, onClose }) {
  const s = useStore();
  const input = useRef();
  const media = s.files.filter((f) => ["raw", "uploads", "recordings"].includes(f.kind) && /\.(png|jpe?g|webp)$/i.test(f.path) && !/\.still-\d+\.png$/i.test(f.path)).slice(0, 12);
  const add = (p) => {
    onClose();
    addFootage(p);
  };
  return html`<${Popover} anchor=${anchor} onClose=${onClose} class="add-pop footage-pop" width=${320} align="end">
    <div class="add-head"><b>Add a video or a picture</b><span>after the last clip</span></div>
    ${media.length
      ? html`<div class="footage-grid">${media.map((f) => html`<button class="fg-tile" key=${f.path} title=${f.path.split("/").pop()} onClick=${() => add(f.path)}><img src=${`/thumb?path=${encodeURIComponent(f.path)}&w=160`} alt="" />${recordingFor(f.path) && html`<span class="fg-video"><${Icon} n="video" s=${11} /></span>`}</button>`)}</div>`
      : html`<div class="note">Your screenshots and recordings show here.</div>`}
    <button class="btn block" onClick=${() => input.current.click()}><${Icon} n="upload" s=${13} />Choose a file…</button>
    <input type="file" ref=${input} hidden accept="image/png,image/jpeg,image/webp,video/mp4,video/quicktime" onChange=${(e) => {
      const f = e.target.files?.[0];
      e.target.value = "";
      if (!f) return;
      onClose();
      addFootageFile(f);
    }} />
  <//>`;
}

/**
 * The Footage row: the video's clips one after another (each screen of it, as its recording's
 * frames or its picture), a transition chip where one gives way to the next, and a + at the end to
 * add a video or a picture. Click a clip to edit it; right-click one for more.
 */
function FootageTrack({ pps, plan, len, on }) {
  const s = useStore();
  const [adding, setAdding] = useState(null);
  const many = Boolean(plan);
  const cur = s.shots ? s.shot : 0;
  const clips = many
    ? plan.shots.map((x, i) => ({ i, scene: i === s.shot ? s.scene : x.scene, at: plan.starts[i], len: plan.lengths[i] })).filter((c) => !plan.out[c.i])
    : [{ i: 0, scene: s.scene, at: 0, len }];
  const end = many ? plan.total : len;
  const n = s.shots?.length ?? 1;
  const pick = (i) => {
    if (i !== cur) {
      pause();
      goToShot(i);
    } else set({ animRows: [FOOTAGE], animSel: null, soundSel: null, selected: null });
  };
  const menu = (e, i) => {
    e.preventDefault();
    e.stopPropagation();
    openMenu(e.clientX, e.clientY, [
      i !== cur && { label: "Edit this clip", icon: "canvas", run: () => goToShot(i) },
      { label: "Duplicate", icon: "duplicate", run: () => addShot("copy", { at: i + 1, copyOf: i }) },
      many && { label: "Move earlier", icon: "left", disabled: i === 0, run: () => moveShot(i, -1) },
      many && { label: "Move later", icon: "right", disabled: i === n - 1, run: () => moveShot(i, 1) },
      many && (S.shots[i]?.video === false ? { label: "Put back in the video", icon: "video", run: () => setInVideo(i, true) } : { label: "Leave out of the video", icon: "video", disabled: plan.out.filter((o) => !o).length < 2, run: () => setInVideo(i, false) }),
      many && { label: "See every clip on one sheet", icon: "grid", run: previewShots },
      many && "-",
      many && { label: "Delete this clip", icon: "trash", danger: true, run: () => deleteShot(i) },
    ]);
  };
  const leftOut = many ? plan.shots.map((_, i) => i).filter((i) => plan.out[i]) : [];
  return html`
    ${clips.map((c) =>
      c.i === cur && cuttable(c.scene)
        ? html`<${CutClip} key=${c.i} scene=${c.scene} at=${c.at} len=${c.len} pps=${pps} on=${on} menu=${(e) => menu(e, c.i)} />`
        : html`<button class="tl-clip ${c.i === cur ? "current" : ""} ${on && c.i === cur ? "on" : ""} ${s.shotPulse?.includes(c.i) ? "pulse" : ""}" key=${c.i}
          style=${{ left: c.at * pps + "px", width: Math.max(14, c.len * pps - (many ? 2 : 0)) + "px" }}
          title=${`${many ? `${c.i + 1} · ${screenName(c.i)} · ` : ""}${c.len.toFixed(1)} s${c.i === cur ? "" : ": click to edit it"}. Right-click for more.`}
          onClick=${() => pick(c.i)} onContextMenu=${(e) => menu(e, c.i)}>
        <${ClipFrames} scene=${c.scene} len=${c.len} pps=${pps} single=${!many} />
        ${many && html`<span class="clip-n">${c.i + 1}</span>`}
        ${c.len * pps > 70 && html`<span class="clip-len">${c.len.toFixed(1)}s</span>`}
      </button>`,
    )}
    ${many && plan.shots.map((x, i) => plan.joins[i].type && html`<${TransitionChip} i=${i} t=${x.transition} key=${`t${i}`} at=${plan.starts[i] * pps + (plan.joins[i].duration * pps) / 2} />`)}
    <button class="tl-clip-add ${adding ? "open" : ""}" style=${{ left: end * pps + 8 + "px" }} title="Add a video or a picture after the last clip" onPointerDown=${stop} onClick=${(e) => setAdding(adding ? null : e.currentTarget)}><${Icon} n="plus" s=${14} w=${2.2} /></button>
    ${leftOut.length > 0 &&
    html`<button class="tl-left-out" style=${{ left: end * pps + 40 + "px" }} title="Screens of the set left out of the video: still App Store screenshots" onPointerDown=${stop}
      onClick=${(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        openMenu(r.left, r.top - 8, leftOut.map((i) => ({ label: `Put screen ${i + 1} back in the video`, icon: "video", run: () => setInVideo(i, true) })));
      }}>${leftOut.length} not in the video</button>`}
    ${adding && html`<${AddFootage} anchor=${adding} onClose=${() => setAdding(null)} />`}`;
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
      <div class="note">Drag the frame on the design to aim, a corner to zoom.</div>
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
    <div class="panel-head clip-head"><h2>Background</h2><span class="sub">${clipName(a)}</span><span class="grow"></span>
      <button class="icon-btn sm" title="Delete this move (⌫)" onClick=${() => deleteAnimation(i)}><${Icon} n="trash" s=${14} /></button>
      <button class="icon-btn sm" title="Close" onClick=${() => set({ animSel: null })}><${Icon} n="x" s=${14} /></button>
    </div>
    <div class="panel-body">
      <div class="note">Moves only the background, behind everything else. The camera moves the whole picture.</div>
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
/** The chosen part of the recording: where it's from, how long, and taking it out. */
export function FootageInspector() {
  const s = useStore();
  const parts = footageParts(s.scene);
  const p = parts[s.footageSel];
  if (!p) return null;
  const len = p.to - p.from;
  return html`
    <div class="panel-head clip-head"><h2>Footage</h2><span class="sub">Part ${s.footageSel + 1} of ${parts.length}</span><span class="grow"></span>
      <button class="icon-btn sm" title="Take this part out (⌫)" onClick=${() => deleteFootagePart(s.footageSel)}><${Icon} n="trash" s=${14} /></button>
      <button class="icon-btn sm" title="Close" onClick=${() => set({ footageSel: null })}><${Icon} n="x" s=${14} /></button>
    </div>
    <div class="panel-body">
      <${Section} title="This part">
        <div class="row"><label>Timeline</label><span class="mono">${clock(p.at)} – ${clock(p.at + len)}</span></div>
        <div class="row"><label>Recording</label><span class="mono">${clock(p.from)} – ${clock(p.to)}</span></div>
        <div class="row"><label>Length</label><span class="mono">${len.toFixed(1)} s</span></div>
      <//>
      <button class="btn block danger" disabled=${parts.length < 2} onClick=${() => deleteFootagePart(s.footageSel)}><${Icon} n="trash" s=${13} />Take this part out</button>
      <div class="note">${parts.length < 2 ? "Cut the footage first: move the playhead and press ⌘B." : "The screen, the webcam, your voice and the cursor all skip it, and everything after moves up. ⌘Z brings it back."}</div>
      <button class="btn block" onClick=${cutFootageHere}><${Icon} n="scissors" s=${13} />Cut at the playhead<span class="kbd">⌘B</span></button>
    </div>`;
}

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
      <div class="note">Drag it to move it, its ends to trim it. ⌘B cuts at the playhead.</div>
      <${Section} title="Loudness">
        <div class="row"><label>Volume</label><${Slider} value=${c.volume ?? 1} min=${0} max=${1} step=${0.01} format=${(v) => `${Math.round(v * 100)}%`} onChange=${(v) => setPiece({ volume: v === undefined || v >= 0.995 ? undefined : r3(v) }, "volume")} /></div>
        <div class="row"><label>Fade in</label><${Slider} value=${c.fadeIn ?? 0} min=${0} max=${3} step=${0.1} format=${(v) => (v > 0 ? `${v.toFixed(1)} s` : "None")} onChange=${(v) => setPiece({ fadeIn: v ? r3(v) : undefined }, "fadeIn")} /></div>
        <div class="row"><label>Fade out</label><${Slider} value=${c.fadeOut ?? 0} min=${0} max=${3} step=${0.1} format=${(v) => (v > 0 ? `${v.toFixed(1)} s` : "None")} onChange=${(v) => setPiece({ fadeOut: v ? r3(v) : undefined }, "fadeOut")} /></div>
      <//>
      <${Section} title="Timing">
        <div class="row"><label>Starts at</label><${Num} value=${c.at} min=${0} max=${videoLength()} step=${0.1} digits=${2} unit="s" onChange=${(v) => v !== undefined && placeSound(i, v, videoLength(), "at")} /></div>
        <div class="note">${clock(long)} long: ${clock(c.from ?? 0)} to ${clock((c.from ?? 0) + long)} of ${whole}. ← and → nudge it; pieces never overlap.</div>
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
      <${Seg} value=${kind} options=${[{ value: "enter", label: "Comes in" }, { value: "loop", label: "Keeps moving" }, { value: "change", label: "Changes" }, { value: "exit", label: "Leaves" }]} onChange=${setKind} />
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
