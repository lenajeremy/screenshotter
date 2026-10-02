/**
 * Animation: timed changes to anything in a scene, for videos. A scene's `animations` are clips:
 * which items (one or several, moving as one group), when, for how long, with what easing, and
 * what happens: an entrance or exit preset, or values to animate from or to (position, size,
 * rotation, 3D tilt, opacity, blur, colours, a shape's fill and stroke, a line's ends and curve).
 * A Change can repeat, and go back and forth. The camera and the backdrop are targets of their own.
 *
 * `evaluate` works out every animated item at a moment in time. It is pure, with no Node imports,
 * so the video renderer and the Studio canvas run the same code (the server hands the compiled
 * file to the browser as /ui/animate.js, next to /ui/shapes.js).
 */
import { isLine, type Point, type ShapeSpec } from "./shapes.js";

export const EASES = ["ease-out", "ease-in", "ease-in-out", "linear", "back-out", "spring", "bounce"] as const;
export type Ease = (typeof EASES)[number];
export const EFFECTS = ["fade", "zoom", "blur", "scale-x", "scale-y", "slide-up", "slide-down", "slide-left", "slide-right", "none"] as const;
export type Effect = (typeof EFFECTS)[number];
export const DEFAULT_DURATION = 0.6;
/** The camera as a target: it zooms the scene (backdrop, devices, shapes) in on a point. */
export const CAMERA = "camera";
/** The backdrop as a target: it pushes in, pans, turns, softens or shifts colour behind everything. */
export const BACKDROP = "backdrop";
/** Ready-made routes for a motion path: loops that start and end where the item is. */
export const PATH_SHAPES = ["circle", "oval", "figure-8"] as const;
export type PathShape = (typeof PATH_SHAPES)[number];
export const DEFAULT_PATH_SIZE = 0.04;
/** How soft the "blur" entrance starts (and exit ends): a fraction of the canvas width. */
export const DEFAULT_BLUR = 0.012;
/** Text can arrive a word or a letter at a time. */
export const UNITS = ["word", "letter"] as const;
export type Unit = (typeof UNITS)[number];
export const DEFAULT_EACH: Record<Unit, number> = { word: 0.08, letter: 0.03 };

/** Values an animation moves between. Multipliers (scale, opacity) are 1 as designed; rotations add. */
export interface AnimProps {
  opacity?: number;
  /** Its centre, as canvas fractions. */
  x?: number;
  y?: number;
  /** An offset, as fractions of the canvas width and height. */
  dx?: number;
  dy?: number;
  scale?: number;
  scaleX?: number;
  scaleY?: number;
  /** Degrees added to its own rotation; for devices, to its 3D tilt (X) and turn (Y). */
  rotate?: number;
  rotateX?: number;
  rotateY?: number;
  /** Text colour; a clay device's clay colour. */
  color?: string;
  /** Text: how much of its marks (highlighter, underline, pill) are drawn, 0 to 1. */
  mark?: number;
  /** Ratings: how many of the five stars are filled. */
  value?: number;
  /** Shapes. */
  fill?: string;
  stroke?: string;
  strokeWidth?: number;
  radius?: number;
  /** Lines and arrows: where the ends are (canvas fractions) and how far it bows. */
  start?: Point;
  end?: Point;
  bend?: number;
  /** The camera and backdrop: how far it's zoomed in (1 shows everything); its x and y are what it looks at. */
  zoom?: number;
  /** Soft focus (a fraction of the canvas width up to 0.5, or px). 0 is sharp. */
  blur?: number;
  /** The backdrop: its colours turned round the colour wheel, in degrees. */
  hue?: number;
}

/**
 * A route for an item to travel along, starting from where it is: a ready-made loop (`shape`,
 * `size` a fraction of the canvas width) or a smooth curve through `points` (canvas fractions),
 * back to the start when `closed`. `orient` turns it to face the way it's going.
 */
export interface MotionPath {
  shape?: PathShape;
  size?: number;
  points?: Point[];
  closed?: boolean;
  orient?: boolean;
  reverse?: boolean;
}

export interface Animation {
  targets: string | string[];
  at: number;
  duration?: number;
  ease?: Ease;
  enter?: Effect;
  exit?: Effect;
  amount?: number;
  fade?: boolean;
  from?: AnimProps;
  to?: AnimProps;
  stagger?: number;
  /** Text: animate it a word or a letter at a time, `each` seconds apart. */
  by?: Unit;
  each?: number;
  /** A Change plays again: this many more times, or (true) until the video ends. */
  repeat?: number | boolean;
  /** With repeat, every other play runs backwards: there and back. */
  yoyo?: boolean;
  /** A Change that travels along a curve (with `to`, both happen together). */
  path?: MotionPath;
}

/** What the layout says about an item: enough to animate it. Positions are canvas fractions. */
export interface AnimEntity {
  id: string;
  kind: "device" | "caption" | "text" | "shape" | "image";
  x: number;
  y: number;
  width: number;
  height?: number;
  anchor?: "top" | "middle" | "bottom";
  align?: "left" | "center" | "right";
  size?: number;
  color?: string;
  shape?: ShapeSpec;
  /** Text: its words (a headline's, then its subheadline's), for word and letter reveals. */
  text?: string;
  subtext?: string;
  /** Its own soft focus, as the design sets it (a fraction of the canvas width up to 0.5, or px). */
  blur?: number;
}

/** One word or letter of a text at a moment: about its own middle. `dx`/`dy` are pixels. */
export interface UnitState {
  opacity: number;
  dx: number;
  dy: number;
  sx: number;
  sy: number;
  rotate: number;
  /** Soft focus, in pixels. */
  blur: number;
}

/**
 * An item at one moment. `dx`/`dy` are pixels; scale and rotation are about the item's own centre
 * (a group's shared centre is already worked into `dx`/`dy`). Shapes come back as the shape to
 * draw, with everything folded in; devices and text as values to apply to the element.
 */
export interface AnimState {
  opacity: number;
  dx: number;
  dy: number;
  sx: number;
  sy: number;
  rotate: number;
  rotateX: number;
  rotateY: number;
  color?: string;
  /** Text: how much of its marks are drawn (1 as designed). */
  mark?: number;
  /** Soft focus, in pixels. */
  blur?: number;
  shape?: ShapeSpec;
  /** Text revealed a word or letter at a time: each piece, in reading order. */
  units?: UnitState[];
}

// ---------------------------------------------------------------------------------------------
// Easing

/** Progress 0–1 through an animation, eased. Overshooting eases go past 1 on the way. */
export function ease(name: Ease | undefined, p: number): number {
  if (p <= 0) return 0;
  if (p >= 1) return 1;
  switch (name) {
    case "linear":
      return p;
    case "ease-in":
      return p * p * p;
    case "ease-in-out":
      return p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2;
    case "back-out": {
      const c1 = 1.70158;
      return 1 + (c1 + 1) * Math.pow(p - 1, 3) + c1 * Math.pow(p - 1, 2);
    }
    case "spring":
      // Overshoots by about a fifth, settles, and lands exactly on 1 (cos 3.5π = 0).
      return 1 - Math.exp(-6 * p) * Math.cos(p * Math.PI * 3.5);
    case "bounce": {
      const n = 7.5625;
      const d = 2.75;
      if (p < 1 / d) return n * p * p;
      if (p < 2 / d) return n * (p -= 1.5 / d) * p + 0.75;
      if (p < 2.5 / d) return n * (p -= 2.25 / d) * p + 0.9375;
      return n * (p -= 2.625 / d) * p + 0.984375;
    }
    default:
      return 1 - Math.pow(1 - p, 3);
  }
}

// ---------------------------------------------------------------------------------------------
// Presets

/** An entrance's starting values (or an exit's end values). */
export function presetProps(effect: Effect, amount?: number, fade = true): AnimProps {
  const out: AnimProps = fade || effect === "fade" || effect === "none" ? { opacity: 0 } : {};
  const slide = amount ?? 0.2;
  switch (effect) {
    case "zoom":
      out.scale = amount ?? 0.6;
      break;
    case "blur":
      out.blur = amount ?? DEFAULT_BLUR;
      break;
    case "scale-x":
      out.scaleX = amount ?? 0;
      break;
    case "scale-y":
      out.scaleY = amount ?? 0;
      break;
    case "slide-up":
      out.dy = slide;
      break;
    case "slide-down":
      out.dy = -slide;
      break;
    case "slide-left":
      out.dx = slide;
      break;
    case "slide-right":
      out.dx = -slide;
      break;
  }
  return out;
}

export const targetsOf = (a: Animation): string[] => (Array.isArray(a.targets) ? a.targets : [a.targets]);
const durationOf = (a: Animation) => (a.enter === "none" || a.exit === "none" ? 0 : Math.max(0, a.duration ?? DEFAULT_DURATION));
/** How many times a clip plays: once, `repeat` more, or forever. Entrances and exits play once. */
export const playsOf = (a: Pick<Animation, "repeat" | "enter" | "exit">) =>
  a.enter || a.exit || !a.repeat ? 1 : a.repeat === true ? Infinity : 1 + Math.max(0, Math.floor(a.repeat));

/**
 * The easing a clip uses when it doesn't say: a loop runs steadily (a spin, a trip round a
 * path), a there-and-back eases at each end, a single trip along a path eases in and out, and
 * anything else slows down as it lands.
 */
export function defaultEase(a: Pick<Animation, "repeat" | "yoyo" | "enter" | "exit"> & { path?: MotionPath }): Ease {
  if (playsOf(a) > 1) return a.yoyo ? "ease-in-out" : "linear";
  return a.path ? "ease-in-out" : "ease-out";
}

/**
 * How far through a clip `t` is, eased (0 before it starts, 1 once it's done). A repeated clip
 * starts again each play; with yoyo every other play runs backwards, ending where it began after
 * an even number of plays.
 */
export function progressAt(a: Pick<Animation, "ease" | "repeat" | "yoyo" | "enter" | "exit"> & { path?: MotionPath }, at: number, d: number, t: number, fallback?: Ease): number {
  if (d <= 0) return t >= at ? 1 : 0;
  fallback ??= defaultEase(a);
  const local = (t - at) / d;
  if (local <= 0) return 0;
  const plays = playsOf(a);
  if (local >= plays) return a.yoyo && plays % 2 === 0 ? 0 : 1;
  const k = Math.floor(local);
  const f = local - k;
  return ease(a.ease ?? fallback, a.yoyo && k % 2 === 1 ? 1 - f : f);
}

/** When an animation has finished: its last target, and with `entities`, a text's last word or letter. */
export function animationEnd(a: Animation, entities?: AnimEntity[]): number {
  const ids = targetsOf(a);
  let pieces = 0;
  if (a.by && entities) {
    for (const id of ids) {
      const e = entities.find((x) => x.id === id);
      if (e && (e.kind === "caption" || e.kind === "text")) pieces = Math.max(pieces, unitsOf(e, a.by).reduce((m, u) => Math.max(m, a.by === "letter" ? u.l : u.w), 0));
    }
  }
  // A clip that repeats until the video ends counts one play: the video's length is its own.
  const plays = playsOf(a);
  return a.at + (a.stagger ?? 0) * Math.max(0, ids.length - 1) + pieces * (a.each ?? DEFAULT_EACH[a.by ?? "word"]) + durationOf(a) * (Number.isFinite(plays) ? plays : 1);
}
export const timelineEnd = (list: Animation[] = [], entities?: AnimEntity[]) => list.reduce((m, a) => Math.max(m, animationEnd(a, entities)), 0);
/**
 * The moments worth looking at to judge a timeline: the start, just after each animation ends,
 * the middle of long ones, and the settled end. At most `max`, at least a quarter second apart.
 */
export function keyMoments(list: Animation[] | undefined, entities: AnimEntity[] | undefined, duration: number, max = 8): number[] {
  if (!list?.length) return [0, 1 / 3, 2 / 3, 1].map((k) => Math.round(k * duration * 100) / 100);
  const moments = [0];
  for (const a of list) {
    const end = animationEnd(a, entities);
    moments.push(end + 0.05);
    if (end - a.at > 0.9) moments.push((a.at + end) / 2);
  }
  moments.push(timelineEnd(list, entities) + 0.6);
  const sorted = [...new Set(moments.map((t) => Math.round(Math.min(duration, Math.max(0, t)) * 100) / 100))].sort((p, q) => p - q);
  let times: number[] = [];
  for (const t of sorted) if (!times.length || t - times[times.length - 1] >= 0.25) times.push(t);
  // Too many: keep the first and the last, and spread the rest evenly.
  if (times.length > max) times = Array.from({ length: max }, (_, i) => times[Math.round((i * (times.length - 1)) / (max - 1))]);
  return times;
}

/** A device's call-out (lift, loupe, outline…) as a target: "device-1/callout-2", counting from 1. */
export const CALLOUT = /^device-(\d+)\/callout-(\d+)$/;
/** Every item the animations name (the camera and call-outs are handled on their own). */
export const animatedIds = (list: Animation[] = []) => new Set(list.flatMap(targetsOf).filter((id) => id !== CAMERA && id !== BACKDROP && !CALLOUT.test(id)));

/**
 * How far each animated call-out is shown at `t` (0 hidden, 1 shown). A call-out arrives the way
 * its style does (a lift rises, a loupe grows), so entrances and exits just set when and how fast.
 */
export function evaluateCallouts(list: Animation[] | undefined, t: number): Map<string, number> {
  const out = new Map<string, number>();
  const clips = (list ?? []).filter((a) => targetsOf(a).some((id) => CALLOUT.test(id))).sort((p, q) => p.at - q.at);
  for (const a of clips) {
    targetsOf(a)
      .filter((id) => CALLOUT.test(id))
      .forEach((id, k) => {
        const at = a.at + (a.stagger ?? 0) * k;
        const e = progressAt(a, at, durationOf(a), t);
        let v = out.get(id) ?? 1;
        if (a.enter || a.from) v = lerp(a.from?.opacity ?? 0, v, e);
        if (a.exit) v = lerp(v, 0, e);
        else if (a.to?.opacity !== undefined) v = lerp(v, a.to.opacity, e);
        out.set(id, v);
      });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Text in pieces

/** A piece of a text: a word or letter to animate, or the space or line break between them. */
export interface TextPiece {
  kind: "unit" | "space" | "break";
  text: string;
  /** Inside **stars**, and which starred phrase (so a phrase's gradient can run across its words). */
  accent: boolean;
  seg: number;
  /** Which word it belongs to, and which letter it is, counting through the whole text. */
  w: number;
  l: number;
}

/**
 * A text as the renderers draw it (trailing blank lines dropped, **stars** marking accents),
 * cut into words or letters. Counting starts at `from`, so a subheadline follows its headline.
 */
export function textPieces(text: string | undefined, by: Unit, from = { w: 0, l: 0 }): TextPiece[] {
  const out: TextPiece[] = [];
  let w = from.w - 1;
  let l = from.l;
  // Pieces that touch (an accented word and the full stop after it) are one word.
  let joined = false;
  // A line break may be written out as "\n".
  String(text ?? "")
    .replace(/\\n/g, "\n")
    .replace(/\s+$/, "")
    .split(/\*\*(.+?)\*\*/g)
    .forEach((part, seg) => {
      const accent = seg % 2 === 1;
      for (const m of part.matchAll(/(\n)|([^\S\n]+)|(\S+)/g)) {
        if (!m[3]) {
          out.push({ kind: m[1] ? "break" : "space", text: m[1] ? "" : " ", accent, seg, w: Math.max(0, w), l });
          joined = false;
          continue;
        }
        if (!joined) w++;
        joined = true;
        if (by === "word") out.push({ kind: "unit", text: m[3], accent, seg, w, l: w });
        else for (const ch of Array.from(m[3])) out.push({ kind: "unit", text: ch, accent, seg, w, l: l++ });
      }
    });
  return out;
}

/** A text item's words or letters, in reading order. */
function unitsOf(e: AnimEntity, by: Unit): TextPiece[] {
  const head = textPieces(e.text, by).filter((p) => p.kind === "unit");
  const last = head[head.length - 1];
  return [...head, ...textPieces(e.subtext, by, last ? { w: last.w + 1, l: last.l + 1 } : undefined).filter((p) => p.kind === "unit")];
}

/** How finely a text is cut for its animations: by letter if any asks for letters, else by word. */
export function unitMode(list: Animation[] | undefined, id: string): Unit | undefined {
  const mine = (list ?? []).filter((a) => a.by && targetsOf(a).includes(id));
  return mine.some((a) => a.by === "letter") ? "letter" : mine.length ? "word" : undefined;
}

// ---------------------------------------------------------------------------------------------
// The camera

export interface CameraState {
  zoom: number;
  x: number;
  y: number;
}

/** Where the camera is at `t`: undefined when no animation moves it. */
export function evaluateCamera(list: Animation[] | undefined, t: number): CameraState | undefined {
  const clips = (list ?? []).filter((a) => targetsOf(a).includes(CAMERA) && a.to).sort((p, q) => p.at - q.at);
  if (!clips.length) return undefined;
  let cam: CameraState = { zoom: 1, x: 0.5, y: 0.5 };
  for (const a of clips) {
    const k = progressAt(a, a.at, durationOf(a), t, "ease-in-out");
    const to = { zoom: Math.max(1, a.to!.zoom ?? cam.zoom), x: a.to!.x ?? cam.x, y: a.to!.y ?? cam.y };
    // Not zoomed in yet, the camera isn't looking anywhere in particular: push straight in on the point.
    const start = cam.zoom <= 1.001 ? { zoom: cam.zoom, x: to.x, y: to.y } : cam;
    cam = { zoom: lerp(start.zoom, to.zoom, k), x: lerp(start.x, to.x, k), y: lerp(start.y, to.y, k) };
  }
  return cam;
}

/**
 * The camera as a transform of a W×H scene: scale by `zoom` about (fx, fy), then move by (tx, ty).
 * The point looked at drifts toward the middle of the frame, and the frame never shows past an edge.
 */
export function cameraTransform(cam: CameraState, W: number, H: number) {
  const zoom = Math.max(1, cam.zoom);
  const fx = cam.x * W;
  const fy = cam.y * H;
  const clampC = (f: number, c: number, size: number) => Math.min(f * zoom, Math.max(size - (size - f) * zoom, c));
  const cx = clampC(fx, fx + (W / 2 - fx) * (1 - 1 / zoom), W);
  const cy = clampC(fy, fy + (H / 2 - fy) * (1 - 1 / zoom), H);
  return { zoom, fx, fy, tx: cx - fx, ty: cy - fy };
}

/** The part of the scene the camera shows, as canvas fractions. */
export function cameraView(cam: CameraState): { x: number; y: number; width: number; height: number } {
  const c = cameraTransform(cam, 1, 1);
  return { x: c.fx - (c.fx + c.tx) / c.zoom, y: c.fy - (c.fy + c.ty) / c.zoom, width: 1 / c.zoom, height: 1 / c.zoom };
}

/** The camera that shows a view whose top-left corner is at (x, y) at this zoom. */
export function cameraFor(view: { x: number; y: number }, zoom: number): CameraState {
  // A view's edge moves steadily with the point looked at, so search for the point.
  const solve = (want: number, axis: "x" | "y") => {
    let lo = 0;
    let hi = 1;
    for (let i = 0; i < 30; i++) {
      const mid = (lo + hi) / 2;
      if (cameraView({ zoom, x: mid, y: mid })[axis] < want) lo = mid;
      else hi = mid;
    }
    return (lo + hi) / 2;
  };
  return { zoom, x: solve(view.x, "x"), y: solve(view.y, "y") };
}
// ---------------------------------------------------------------------------------------------
// The backdrop

export interface BackdropState {
  /** Pushed in (1 fills the canvas as designed), toward the point x, y (canvas fractions). */
  zoom: number;
  x: number;
  y: number;
  /** Degrees turned. */
  rotate: number;
  /** Soft focus, in pixels. */
  blur: number;
  /** Degrees round the colour wheel. */
  hue: number;
}

/** The backdrop at `t`: undefined when no animation moves it. From values run to how it's designed. */
export function evaluateBackdrop(list: Animation[] | undefined, t: number, W: number): BackdropState | undefined {
  const clips = (list ?? []).filter((a) => targetsOf(a).includes(BACKDROP) && (a.to || a.from)).sort((p, q) => p.at - q.at);
  if (!clips.length) return undefined;
  const values = (p: AnimProps, cur: BackdropState): BackdropState => ({
    zoom: Math.max(1, p.zoom ?? cur.zoom),
    x: p.x ?? cur.x,
    y: p.y ?? cur.y,
    rotate: p.rotate ?? cur.rotate,
    blur: p.blur !== undefined ? blurPx(p.blur, W) : cur.blur,
    hue: p.hue ?? cur.hue,
  });
  let bd: BackdropState = { zoom: 1, x: 0.5, y: 0.5, rotate: 0, blur: 0, hue: 0 };
  for (const a of clips) {
    const k = progressAt(a, a.at, durationOf(a), t, "ease-in-out");
    const mix = (from: BackdropState, to: BackdropState): BackdropState => {
      // Not pushed in yet, it isn't looking anywhere in particular: push straight in on the point.
      const start = from.zoom <= 1.001 ? { ...from, x: to.x, y: to.y } : from;
      return { zoom: lerp(start.zoom, to.zoom, k), x: lerp(start.x, to.x, k), y: lerp(start.y, to.y, k), rotate: lerp(from.rotate, to.rotate, k), blur: lerp(from.blur, to.blur, k), hue: lerp(from.hue, to.hue, k) };
    };
    if (a.from) bd = mix(values(a.from, bd), bd);
    if (a.to) bd = mix(bd, values(a.to, bd));
  }
  return bd;
}

/**
 * The backdrop's move as one CSS transform (origin at the top-left corner) and filter: pushed in
 * like the camera, turned about the middle, and scaled up just enough that turning and blurring
 * never show an edge.
 */
export function backdropStyle(b: BackdropState, W: number, H: number): { transform: string; filter: string } {
  const ct = cameraTransform({ zoom: b.zoom, x: b.x, y: b.y }, W, H);
  const r = (Math.abs(b.rotate % 180) * Math.PI) / 180;
  const cover = b.rotate ? Math.abs(Math.cos(r)) + Math.abs(Math.sin(r)) * Math.max(W / H, H / W) : 1;
  const margin = 1 + (3 * b.blur) / Math.min(W, H);
  const n = (v: number) => Math.round(v * 1000) / 1000;
  const transform =
    `translate(${n(ct.tx + ct.fx)}px, ${n(ct.ty + ct.fy)}px) scale(${n(ct.zoom)}) translate(${n(-ct.fx)}px, ${n(-ct.fy)}px) ` +
    `translate(${n(W / 2)}px, ${n(H / 2)}px) rotate(${n(b.rotate)}deg) scale(${n(cover * margin)}) translate(${n(-W / 2)}px, ${n(-H / 2)}px)`;
  const filter = [b.hue ? `hue-rotate(${n(b.hue)}deg)` : "", b.blur > 0.05 ? `blur(${n(b.blur)}px)` : ""].filter(Boolean).join(" ");
  return { transform, filter };
}

/** Whether any animation tilts or turns a device in 3D (the renderer then draws devices in 3D). */
export const uses3d = (list: Animation[] = []) => list.some((a) => [a.from, a.to].some((p) => p && (p.rotateX !== undefined || p.rotateY !== undefined)));

// ---------------------------------------------------------------------------------------------
// Evaluation

/** Where an item's middle is, as canvas fractions (text is placed by an anchor, so estimate). */
export function entityCentre(e: AnimEntity): Point {
  if (e.kind === "shape" && e.shape && isLine(e.shape.type)) return { x: (e.shape.from.x + e.shape.to.x) / 2, y: (e.shape.from.y + e.shape.to.y) / 2 };
  if (e.kind === "device" || e.kind === "shape" || e.kind === "image") return { x: e.x, y: e.y };
  const x = e.align === "left" ? e.x + e.width / 2 : e.align === "right" ? e.x - e.width / 2 : e.x;
  const h = e.height ?? (e.size ?? 0.05) * (e.kind === "caption" ? 2.6 : 1.2);
  const y = e.anchor === "bottom" ? e.y - h / 2 : e.anchor === "middle" ? e.y : e.y + h / 2;
  return { x, y };
}

interface Clip {
  id: string;
  at: number;
  duration: number;
  ease?: Ease;
  repeat?: number | boolean;
  yoyo?: boolean;
  path?: MotionPath;
  mode: "from" | "to";
  props: AnimProps;
  pivot?: Point;
}

/** Every animation as one clip per target, in the order they start. */
function clipsOf(list: Animation[], byId: Map<string, AnimEntity>): Clip[] {
  const clips: Clip[] = [];
  list.forEach((a) => {
    // Text animated by word or letter is worked out piece by piece (unitStates), not as a block.
    const pieces = (id: string) => Boolean(a.by) && ["caption", "text"].includes(byId.get(id)!.kind);
    const ids = targetsOf(a).filter((id) => byId.has(id) && !pieces(id));
    // Several items scale and turn about their shared centre, like one object.
    const centres = ids.map((id) => entityCentre(byId.get(id)!));
    const pivot = ids.length > 1 ? { x: centres.reduce((s, c) => s + c.x, 0) / centres.length, y: centres.reduce((s, c) => s + c.y, 0) / centres.length } : undefined;
    const fade = a.fade !== false;
    const base = { duration: durationOf(a), ease: a.ease, pivot, ...(a.enter || a.exit ? {} : { repeat: a.repeat, yoyo: a.yoyo }) };
    ids.forEach((id, k) => {
      const at = a.at + (a.stagger ?? 0) * k;
      if (a.enter) clips.push({ ...base, id, at, mode: "from", props: { ...presetProps(a.enter, a.amount, fade), ...a.from } });
      else if (a.from) clips.push({ ...base, id, at, mode: "from", props: a.from });
      if (a.exit) clips.push({ ...base, id, at, mode: "to", props: { ...presetProps(a.exit, a.amount, fade), ...a.to } });
      else if (a.to || a.path) clips.push({ ...base, id, at, mode: "to", props: a.to ?? {}, path: a.path });
    });
  });
  return clips.sort((p, q) => p.at - q.at);
}

type RGBA = [number, number, number, number];
const NAMED: Record<string, RGBA> = { white: [255, 255, 255, 1], black: [0, 0, 0, 1], transparent: [0, 0, 0, 0], none: [0, 0, 0, 0] };
function parseColor(c: string | undefined): RGBA | undefined {
  if (!c) return undefined;
  const s = c.trim().toLowerCase();
  if (NAMED[s]) return [...NAMED[s]] as RGBA;
  let m = /^#([0-9a-f]{3,8})$/.exec(s);
  if (m) {
    let h = m[1];
    if (h.length === 3 || h.length === 4) h = [...h].map((ch) => ch + ch).join("");
    if (h.length !== 6 && h.length !== 8) return undefined;
    const n = (i: number) => parseInt(h.slice(i, i + 2), 16);
    return [n(0), n(2), n(4), h.length === 8 ? n(6) / 255 : 1];
  }
  m = /^rgba?\(([^)]+)\)$/.exec(s);
  if (m) {
    const v = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
    if (v.length >= 3 && v.slice(0, 3).every(Number.isFinite)) return [v[0], v[1], v[2], Number.isFinite(v[3]) ? v[3] : 1];
  }
  return undefined;
}

/** A colour part way between two. "none" fades from or to the other colour, clear. */
export function mixColor(a: string | undefined, b: string | undefined, k: number): string | undefined {
  if (k <= 0) return a;
  if (k >= 1) return b;
  const pa = parseColor(a);
  const pb = parseColor(b);
  if (!pa || !pb) return k < 0.5 ? a : b;
  if (a?.trim().toLowerCase() === "none") pa.splice(0, 3, pb[0], pb[1], pb[2]);
  if (b?.trim().toLowerCase() === "none") pb.splice(0, 3, pa[0], pa[1], pa[2]);
  const c = pa.map((v, i) => v + (pb[i] - v) * k);
  const r = (v: number) => Math.round(Math.min(255, Math.max(0, v)));
  return `rgba(${r(c[0])}, ${r(c[1])}, ${r(c[2])}, ${Math.round(Math.min(1, Math.max(0, c[3])) * 1000) / 1000})`;
}

const lerp = (a: number, b: number, k: number) => a + (b - a) * k;
const lerpPoint = (a: Point, b: Point, k: number): Point => ({ x: lerp(a.x, b.x, k), y: lerp(a.y, b.y, k) });

interface Channels {
  opacity: number;
  dx: number;
  dy: number;
  sx: number;
  sy: number;
  rotate: number;
  rotateX: number;
  rotateY: number;
  color?: string;
  fill?: string;
  stroke?: string;
  strokeWidth?: number;
  radius?: number;
  start?: Point;
  end?: Point;
  bend?: number;
  mark?: number;
  value?: number;
  /** Soft focus, in pixels. */
  blur?: number;
}

/** A device's blur setting in pixels: a fraction of the canvas width up to 0.5, else pixels. */
const blurPx = (b: number | undefined, W: number) => (!b ? 0 : b <= 0.5 ? b * W : b);

/** An item's values as designed. */
function baseChannels(e: AnimEntity): Channels {
  const s = e.shape;
  return {
    opacity: 1,
    dx: 0,
    dy: 0,
    sx: 1,
    sy: 1,
    rotate: 0,
    rotateX: 0,
    rotateY: 0,
    color: e.color,
    fill: s?.fill,
    stroke: s?.stroke,
    strokeWidth: s?.strokeWidth,
    radius: s?.radius,
    start: s?.from,
    end: s?.to,
    bend: s?.bend,
    mark: 1,
    value: s?.value,
    blur: e.blur ?? e.shape?.blur,
  };
}

/** A clip's values, in the channels' terms. */
function target(props: AnimProps, e: AnimEntity, cur: Channels, W: number, H: number): Partial<Channels> {
  const out: Partial<Channels> = {};
  const c = entityCentre(e);
  if (props.opacity !== undefined) out.opacity = props.opacity;
  if (props.x !== undefined) out.dx = (props.x - c.x) * W;
  if (props.y !== undefined) out.dy = (props.y - c.y) * H;
  if (props.dx !== undefined) out.dx = (out.dx ?? cur.dx) + props.dx * W;
  if (props.dy !== undefined) out.dy = (out.dy ?? cur.dy) + props.dy * H;
  if (props.scale !== undefined) {
    out.sx = props.scale;
    out.sy = props.scale;
  }
  if (props.scaleX !== undefined) out.sx = props.scaleX * (props.scale ?? 1);
  if (props.scaleY !== undefined) out.sy = props.scaleY * (props.scale ?? 1);
  if (props.rotate !== undefined) out.rotate = props.rotate;
  if (props.rotateX !== undefined) out.rotateX = props.rotateX;
  if (props.rotateY !== undefined) out.rotateY = props.rotateY;
  for (const k of ["color", "fill", "stroke"] as const) if (props[k] !== undefined) out[k] = props[k];
  for (const k of ["strokeWidth", "radius", "bend", "mark", "value"] as const) if (props[k] !== undefined) out[k] = props[k];
  if (props.start) out.start = props.start;
  if (props.end) out.end = props.end;
  if (props.blur !== undefined) out.blur = blurPx(props.blur, W);
  return out;
}

function mixChannels(a: Channels, b: Partial<Channels>, k: number, forward: boolean): Channels {
  // forward: from the current values to b; otherwise from b to the current values.
  const out = { ...a };
  for (const key of Object.keys(b) as Array<keyof Channels>) {
    const cur = a[key];
    const tgt = b[key];
    const [from, to] = forward ? [cur, tgt] : [tgt, cur];
    if (key === "color" || key === "fill" || key === "stroke") (out as any)[key] = mixColor(from as string | undefined, to as string | undefined, k);
    else if (key === "start" || key === "end") (out as any)[key] = from && to ? lerpPoint(from as Point, to as Point, k) : to ?? from;
    else if (typeof from === "number" && typeof to === "number") (out as any)[key] = lerp(from, to, k);
    else (out as any)[key] = k >= 1 ? to : from;
  }
  return out;
}

/** Every animated item at `t` seconds, keyed by id. Items no animation touches are left out. */
export function evaluate(list: Animation[] | undefined, entities: AnimEntity[], t: number, W: number, H: number): Map<string, AnimState> {
  const out = new Map<string, AnimState>();
  if (!list?.length) return out;
  const byId = new Map(entities.map((e) => [e.id, e]));
  const clips = clipsOf(list, byId);
  const state = new Map<string, Channels>();
  for (const clip of clips) {
    const e = byId.get(clip.id)!;
    const cur = state.get(clip.id) ?? { ...baseChannels(e), blur: blurPx(e.blur ?? e.shape?.blur, W) };
    const k = progressAt(clip, clip.at, clip.duration, t);
    const next = mixChannels(cur, target(clip.props, e, cur, W, H), k, clip.mode === "to");
    // Along a path: its centre (a group's shared centre) travels the route from where it is.
    if (clip.path) {
      const o = clip.pivot ?? entityCentre(e);
      const m = pathMotion(clip.path, { x: o.x * W + cur.dx, y: o.y * H + cur.dy }, k, W, H);
      next.dx += m.dx;
      next.dy += m.dy;
      if (clip.path.orient) next.rotate += m.turn;
    }
    // In a group, scaling and turning happen about the group's centre: move the item's centre too.
    if (clip.pivot && (next.sx !== cur.sx || next.sy !== cur.sy || next.rotate !== cur.rotate)) {
      const c = entityCentre(e);
      const vx = (c.x - clip.pivot.x) * W;
      const vy = (c.y - clip.pivot.y) * H;
      const kx = cur.sx === 0 ? next.sx : next.sx / cur.sx;
      const ky = cur.sy === 0 ? next.sy : next.sy / cur.sy;
      const r = ((next.rotate - cur.rotate) * Math.PI) / 180;
      const x = vx * kx;
      const y = vy * ky;
      next.dx += x * Math.cos(r) - y * Math.sin(r) - vx;
      next.dy += x * Math.sin(r) + y * Math.cos(r) - vy;
    }
    state.set(clip.id, next);
  }
  // Text revealed by word or letter is animated even when nothing moves it as a block.
  for (const e of entities) {
    if ((e.kind === "caption" || e.kind === "text") && !state.has(e.id) && unitMode(list, e.id)) state.set(e.id, { ...baseChannels(e), blur: blurPx(e.blur, W) });
  }
  for (const [id, ch] of state) {
    const e = byId.get(id)!;
    const st: AnimState = { opacity: ch.opacity, dx: ch.dx, dy: ch.dy, sx: ch.sx, sy: ch.sy, rotate: ch.rotate, rotateX: ch.rotateX, rotateY: ch.rotateY, color: ch.color, blur: ch.blur, mark: ch.mark };
    if (e.shape) st.shape = animatedShape(e.shape, ch, W, H);
    if (e.kind === "caption" || e.kind === "text") st.units = unitStates(list, e, t, W, H);
    out.set(id, st);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Motion paths

/** A smooth curve through points (Catmull-Rom), sampled finely; `closed` joins the end to the start. */
function smoothThrough(pts: Point[], closed: boolean): Point[] {
  if (pts.length < 2) return pts;
  const at = (i: number) => (closed ? pts[(i + pts.length) % pts.length] : pts[Math.max(0, Math.min(pts.length - 1, i))]);
  const out: Point[] = [];
  const segs = closed ? pts.length : pts.length - 1;
  for (let i = 0; i < segs; i++) {
    const [p0, p1, p2, p3] = [at(i - 1), at(i), at(i + 1), at(i + 2)];
    for (let j = 0; j < 20; j++) {
      const u = j / 20;
      const u2 = u * u;
      const u3 = u2 * u;
      const f = (a: number, b: number, c: number, d: number) => 0.5 * (2 * b + (-a + c) * u + (2 * a - 5 * b + 4 * c - d) * u2 + (-a + 3 * b - 3 * c + d) * u3);
      out.push({ x: f(p0.x, p1.x, p2.x, p3.x), y: f(p0.y, p1.y, p2.y, p3.y) });
    }
  }
  out.push(closed ? pts[0] : pts[pts.length - 1]);
  return out;
}

/**
 * A path's route in pixels, from `start` (where the item's centre is when it sets off). Loops
 * start and end at `start`: a circle or oval hangs below it, a figure-8 crosses at it.
 */
export function pathRoute(path: MotionPath, start: Point, W: number, H: number): { points: Point[]; closed: boolean } {
  const dir = path.reverse ? -1 : 1;
  if (path.shape || !path.points?.length) {
    const r = (path.size ?? DEFAULT_PATH_SIZE) * W;
    const shape = path.shape ?? "circle";
    const points = Array.from({ length: 97 }, (_, i) => {
      const a = (dir * 2 * Math.PI * i) / 96;
      if (shape === "figure-8") return { x: start.x + 1.4 * r * Math.sin(a), y: start.y + 0.7 * r * Math.sin(2 * a) };
      const ry = shape === "oval" ? r * 0.55 : r;
      // Round from the top of the loop, clockwise (anticlockwise when reversed).
      return { x: start.x + r * Math.sin(a), y: start.y + ry - ry * Math.cos(a) };
    });
    return { points, closed: true };
  }
  const closed = path.closed ?? false;
  const through = [start, ...path.points.map((p) => ({ x: p.x * W, y: p.y * H }))];
  return { points: smoothThrough(path.reverse ? [start, ...through.slice(1).reverse()] : through, closed), closed };
}

/**
 * How far along its route an item is at progress `k` (0–1, eased), as an offset from where it set
 * off, and how far it has turned from its starting heading (for `orient`). Distance along the
 * route is what's eased, so it moves at an even speed on a steady ease.
 */
export function pathMotion(path: MotionPath, start: Point, k: number, W: number, H: number): { dx: number; dy: number; turn: number } {
  const { points, closed } = pathRoute(path, start, W, H);
  if (points.length < 2) return { dx: 0, dy: 0, turn: 0 };
  const lengths = [0];
  for (let i = 1; i < points.length; i++) lengths.push(lengths[i - 1] + Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y));
  const total = lengths[lengths.length - 1];
  if (total <= 0) return { dx: 0, dy: 0, turn: 0 };
  // Overshooting eases run a loop on round; an open route stops at its ends.
  const u = !closed ? Math.min(1, Math.max(0, k)) : k >= 1 && Number.isInteger(k) ? 1 : ((k % 1) + 1) % 1;
  const d = u * total;
  let i = 1;
  while (i < lengths.length - 1 && lengths[i] < d) i++;
  const seg = lengths[i] - lengths[i - 1] || 1;
  const f = (d - lengths[i - 1]) / seg;
  const a = points[i - 1];
  const b = points[i];
  const heading = (p: Point, q: Point) => (Math.atan2(q.y - p.y, q.x - p.x) * 180) / Math.PI;
  let turn = heading(a, b) - heading(points[0], points[1]);
  turn = ((turn + 540) % 360) - 180;
  return { dx: a.x + (b.x - a.x) * f - start.x, dy: a.y + (b.y - a.y) * f - start.y, turn };
}

/** An entrance's starting values for one word or letter: slides are measured in text heights. */
function unitPreset(effect: Effect, amount: number | undefined, fade: boolean, em: number, W: number): Partial<UnitState> {
  const out: Partial<UnitState> = fade || effect === "fade" || effect === "none" ? { opacity: 0 } : {};
  const slide = (amount ?? 0.6) * em;
  if (effect === "zoom") out.sx = out.sy = amount ?? 0.6;
  else if (effect === "blur") out.blur = blurPx(amount ?? DEFAULT_BLUR, W);
  else if (effect === "scale-x") out.sx = amount ?? 0;
  else if (effect === "scale-y") out.sy = amount ?? 0;
  else if (effect === "slide-up") out.dy = slide;
  else if (effect === "slide-down") out.dy = -slide;
  else if (effect === "slide-left") out.dx = slide;
  else if (effect === "slide-right") out.dx = -slide;
  return out;
}

function unitProps(p: AnimProps | undefined, W: number, H: number): Partial<UnitState> {
  const out: Partial<UnitState> = {};
  if (!p) return out;
  if (p.opacity !== undefined) out.opacity = p.opacity;
  if (p.dx !== undefined) out.dx = p.dx * W;
  if (p.dy !== undefined) out.dy = p.dy * H;
  if (p.scale !== undefined) out.sx = out.sy = p.scale;
  if (p.scaleX !== undefined) out.sx = p.scaleX * (p.scale ?? 1);
  if (p.scaleY !== undefined) out.sy = p.scaleY * (p.scale ?? 1);
  if (p.rotate !== undefined) out.rotate = p.rotate;
  if (p.blur !== undefined) out.blur = blurPx(p.blur, W);
  return out;
}

/** Each word or letter of a text at `t`, in reading order; undefined when it isn't animated in pieces. */
function unitStates(list: Animation[], e: AnimEntity, t: number, W: number, H: number): UnitState[] | undefined {
  const mode = unitMode(list, e.id);
  if (!mode) return undefined;
  const em = (e.size ?? 0.05) * H;
  const clips = list.filter((a) => a.by && targetsOf(a).includes(e.id)).sort((p, q) => p.at - q.at);
  return unitsOf(e, mode).map((u) => {
    let ch: UnitState = { opacity: 1, dx: 0, dy: 0, sx: 1, sy: 1, rotate: 0, blur: 0 };
    for (const a of clips) {
      const index = a.by === "letter" ? u.l : u.w;
      const at = a.at + (a.stagger ?? 0) * targetsOf(a).indexOf(e.id) + index * (a.each ?? DEFAULT_EACH[a.by!]);
      const k = progressAt(a, at, durationOf(a), t);
      const fade = a.fade !== false;
      const mix = (tgt: Partial<UnitState>, forward: boolean) => {
        const next = { ...ch };
        for (const key of Object.keys(tgt) as Array<keyof UnitState>) next[key] = forward ? lerp(ch[key], tgt[key]!, k) : lerp(tgt[key]!, ch[key], k);
        ch = next;
      };
      if (a.enter) mix({ ...unitPreset(a.enter, a.amount, fade, em, W), ...unitProps(a.from, W, H) }, false);
      else if (a.from) mix(unitProps(a.from, W, H), false);
      if (a.exit) mix({ ...unitPreset(a.exit, a.amount, fade, em, W), ...unitProps(a.to, W, H) }, true);
      else if (a.to) mix(unitProps(a.to, W, H), true);
    }
    return ch;
  });
}

/** The shape to draw: its own values with the animated ones applied, moves and turns included. */
function animatedShape(s: ShapeSpec, ch: Channels, W: number, H: number): ShapeSpec {
  const shape: ShapeSpec = {
    ...s,
    fill: ch.fill ?? s.fill,
    stroke: ch.stroke ?? s.stroke,
    strokeWidth: Math.max(0, ch.strokeWidth ?? s.strokeWidth),
    radius: Math.max(0, ch.radius ?? s.radius),
    bend: Math.max(-1, Math.min(1, ch.bend ?? s.bend)),
    value: Math.max(0, Math.min(5, ch.value ?? s.value)),
    opacity: Math.max(0, Math.min(1, s.opacity * ch.opacity)),
    blur: ch.blur !== undefined ? Math.max(0, ch.blur) / W : s.blur,
  };
  if (isLine(s.type)) {
    // Scale and turn the ends about the line's middle (in pixels, so turns aren't squashed).
    const a = ch.start ?? s.from;
    const b = ch.end ?? s.to;
    const cx = ((a.x + b.x) / 2) * W;
    const cy = ((a.y + b.y) / 2) * H;
    const r = (ch.rotate * Math.PI) / 180;
    const move = (p: Point): Point => {
      const x = (p.x * W - cx) * ch.sx;
      const y = (p.y * H - cy) * ch.sy;
      return { x: (cx + x * Math.cos(r) - y * Math.sin(r) + ch.dx) / W, y: (cy + x * Math.sin(r) + y * Math.cos(r) + ch.dy) / H };
    };
    shape.from = move(a);
    shape.to = move(b);
    return shape;
  }
  const sy = Math.max(0.0001, ch.sy);
  shape.x = s.x + ch.dx / W;
  shape.y = s.y + ch.dy / H;
  shape.size = Math.max(0.0001, s.size * sy);
  shape.aspect = Math.max(0.0001, (s.aspect * Math.max(0.0001, ch.sx)) / sy);
  shape.rotate = s.rotate + ch.rotate;
  return shape;
}
