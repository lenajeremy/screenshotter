// The fast export: a video drawn by the Mac app on the GPU instead of photographed frame by frame
// in the browser. The browser draws each part of the design once (or once for each look it takes
// on), in the order it paints them; the timeline is worked out here, frame by frame, exactly as the
// page plays it (each part's move, the camera, the devices' ambient motion); the videos are put
// on the corners their screens land on. The app (SCREENSHOTTER_NATIVE) puts it all together.
import { spawn } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Page } from "puppeteer-core";
import { cameraTransform } from "./animate.js";
import { newPage } from "./browser.js";
import { CURSOR_ART } from "./cursor.js";
import type { AnimFrame, VideoInput } from "./video.js";

/** What the stage hands over: the page, the design's size and the timeline it plays. */
export interface FastStage {
  page: Page;
  dir: string;
  W: number;
  H: number;
  /** The page's device scale factor (pictures are this many px per CSS px). */
  scale: number;
  view: { width: number; height: number; x: number; y: number; scale: number };
  clip: { x: number; y: number; width: number; height: number };
  duration: number;
  timeline: {
    duration: number;
    W: number;
    H: number;
    motion: string;
    amount: number;
    keys: Array<{ t: number; s: number; x: number; y: number }>;
    highlight?: { in?: number; out?: number };
    caption?: { in?: number; out?: number };
    fade: number;
    grainFps: number;
  };
  frameAt: (t: number) => AnimFrame;
  cursorTrack?: { step: number; xs: number[]; ys: number[]; clicks: Array<[number, number, number]>; kinds: Array<[number, string]>; ripple: boolean };
  scene: { transparent?: boolean };
}

/** Whether the app can draw it at all: it runs the engine (SCREENSHOTTER_NATIVE), and nothing asks for what it can't. */
export function fastAvailable(input: VideoInput): boolean {
  const app = process.env.SCREENSHOTTER_NATIVE;
  if (!app || !existsSync(app) || process.env.SCREENSHOTTER_NO_NATIVE) return false;
  // A recording that dissolves into the backdrop, or shows part of its picture: the usual way.
  return !input.devices.some((d) => d.video && (d.fade || d.crop));
}

type Mat = [number, number, number, number, number, number];
/** a·b: b first, then a (affine, [a, b, c, d, tx, ty] as CSS has them). */
const mul = (a: Mat, b: Mat): Mat => [a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1], a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3], a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5]];
const T = (x: number, y: number): Mat => [1, 0, 0, 1, x, y];
const S = (x: number, y = x): Mat => [x, 0, 0, y, 0, 0];
const R = (deg: number): Mat => {
  const a = (deg * Math.PI) / 180;
  return [Math.cos(a), Math.sin(a), -Math.sin(a), Math.cos(a), 0, 0];
};
const I: Mat = [1, 0, 0, 1, 0, 0];
const apply = (m: Mat, x: number, y: number) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
const isI = (m: Mat) => Math.abs(m[0] - 1) + Math.abs(m[1]) + Math.abs(m[2]) + Math.abs(m[3] - 1) + Math.abs(m[4]) + Math.abs(m[5]) < 1e-6;
const r4 = (v: number) => Math.round(v * 10000) / 10000;

/** A CSS transform list of translate / scale / rotate (what a backdrop's move is made of), as a matrix. */
function cssMatrix(s: string): Mat {
  let m = I;
  for (const [, fn, args] of s.matchAll(/(translate|scale|rotate)\(([^)]*)\)/g)) {
    const v = args.split(",").map((x) => parseFloat(x));
    if (fn === "translate") m = mul(m, T(v[0] || 0, v[1] || 0));
    else if (fn === "scale") m = mul(m, S(v[0], v[1] ?? v[0]));
    else m = mul(m, R(v[0] || 0));
  }
  return m;
}

/** A CSS filter's colour functions (a grade) as one 4×5 colour matrix, rows R, G, B, A (each 4 weights and an offset). */
export function filterMatrix(filter: string): number[] | undefined {
  let m = [1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0];
  let any = false;
  const then = (n: number[]) => {
    // n after m: out = n·(m·c).
    const o = new Array(20).fill(0);
    for (let r = 0; r < 4; r++) {
      for (let c = 0; c < 5; c++) {
        let v = c === 4 ? n[r * 5 + 4] : 0;
        for (let k = 0; k < 4; k++) v += n[r * 5 + k] * m[k * 5 + c];
        o[r * 5 + c] = v;
      }
    }
    m = o;
    any = true;
  };
  const rgb = (a: number[]) => [a[0], a[1], a[2], 0, 0, a[3], a[4], a[5], 0, 0, a[6], a[7], a[8], 0, 0, 0, 0, 0, 1, 0];
  for (const [, fn, arg] of filter.matchAll(/([a-z-]+)\(([^)]*)\)/g)) {
    const v = arg.trim().endsWith("%") ? parseFloat(arg) / 100 : parseFloat(arg);
    if (fn === "brightness") then(rgb([v, 0, 0, 0, v, 0, 0, 0, v]));
    else if (fn === "contrast") then([v, 0, 0, 0, 0.5 - 0.5 * v, 0, v, 0, 0, 0.5 - 0.5 * v, 0, 0, v, 0, 0.5 - 0.5 * v, 0, 0, 0, 1, 0]);
    else if (fn === "saturate") then(rgb([0.213 + 0.787 * v, 0.715 - 0.715 * v, 0.072 - 0.072 * v, 0.213 - 0.213 * v, 0.715 + 0.285 * v, 0.072 - 0.072 * v, 0.213 - 0.213 * v, 0.715 - 0.715 * v, 0.072 + 0.928 * v]));
    else if (fn === "grayscale") {
      const k = 1 - Math.min(1, v);
      then(rgb([0.2126 + 0.7874 * k, 0.7152 - 0.7152 * k, 0.0722 - 0.0722 * k, 0.2126 - 0.2126 * k, 0.7152 + 0.2848 * k, 0.0722 - 0.0722 * k, 0.2126 - 0.2126 * k, 0.7152 - 0.7152 * k, 0.0722 + 0.9278 * k]));
    } else if (fn === "sepia") {
      const k = 1 - Math.min(1, v);
      then(rgb([0.393 + 0.607 * k, 0.769 - 0.769 * k, 0.189 - 0.189 * k, 0.349 - 0.349 * k, 0.686 + 0.314 * k, 0.168 - 0.168 * k, 0.272 - 0.272 * k, 0.534 - 0.534 * k, 0.131 + 0.869 * k]));
    } else if (fn === "hue-rotate") {
      const a = (parseFloat(arg) * Math.PI) / 180;
      const [c, s] = [Math.cos(a), Math.sin(a)];
      then(rgb([0.213 + c * 0.787 - s * 0.213, 0.715 - c * 0.715 - s * 0.715, 0.072 - c * 0.072 + s * 0.928, 0.213 - c * 0.213 + s * 0.143, 0.715 + c * 0.285 + s * 0.14, 0.072 - c * 0.072 - s * 0.283, 0.213 - c * 0.213 - s * 0.787, 0.715 - c * 0.715 + s * 0.715, 0.072 + c * 0.928 + s * 0.072]));
    } else if (fn === "invert") then([1 - 2 * v, 0, 0, 0, v, 0, 1 - 2 * v, 0, 0, v, 0, 0, 1 - 2 * v, 0, v, 0, 0, 0, 1, 0]);
  }
  return any ? m.map(r4) : undefined;
}

// ---------------------------------------------------------------------------------------------
// The page: its parts in the order it paints them

interface Leaf {
  id: string;
  kind: "own" | "entity" | "backdrop" | "grain" | "fill" | "blur";
  ent?: string;
  /** Moves with the camera: "stage" (always), "overlay" (when the animations move it), or not. */
  cam: "stage" | "overlay" | "none";
  /** Its middle at rest, page px (what an animation turns and scales it about). */
  mid: [number, number];
  /** Where to photograph it, page px (with room for shadows). */
  bounds: [number, number, number, number];
  /** A device's place in the page's list of devices (its ambient motion's phase). */
  dev?: number;
  /** Uses the page's --hl (call-outs) or --cap (caption) timing. */
  hl?: boolean;
  cap?: boolean;
  fill?: { color: string; opacity: number; blend: string };
  grain?: { opacity: number; blend: string; size: number; image: string };
  blur?: { radius: number; toward: "up" | "down"; solid: number };
  /** A device: how it holds its screen (and whether a recording plays on it). */
  device?: DeviceGeometry;
}

interface DeviceGeometry {
  /** A recording plays on its screen (drawn by the app between its body and the art over it). */
  hasVideo: boolean;
  /** The device's place (its middle), page px; its frame's box; the screen's box within it. */
  cx: number;
  cy: number;
  frameW: number;
  frameH: number;
  /** The screen's box in the device's (what shows of the video: the screen trims it). */
  shot: [number, number, number, number];
  /** Where the video itself sits in that box (it may be wider or taller, trimmed to fit). */
  inner: [number, number, number, number];
  radius: number;
  /** Its turn and tilts as placed (degrees), its turn for landscape, and its perspective (0: flat). */
  rotate: number;
  rotateX: number;
  rotateY: number;
  turn: number;
  perspective: number;
  /** The design's grade over it, and its own soft focus (px). */
  filter?: string;
  blur: number;
  /** Where the page puts its screen at rest (a check on the sums above). */
  seen: [number, number, number, number];
}

/** In the page: every part in paint order (data-nx ids), and what each needs. */
function analyse(): { leaves: Leaf[]; error?: string } {
  const cs = (el: Element) => getComputedStyle(el);
  let n = 0;
  const id = (el: Element) => {
    if (!el.hasAttribute("data-nx")) el.setAttribute("data-nx", String(n++));
    return el.getAttribute("data-nx")!;
  };
  const special = (el: Element): Leaf["kind"] | null => {
    if (el.hasAttribute("data-ent")) return "entity";
    if (el.classList.contains("bg-move")) return "backdrop";
    if (el.classList.contains("grain")) return "grain";
    const s = cs(el);
    if (el.classList.contains("bg") && s.mixBlendMode !== "normal") return "fill";
    if (s.backdropFilter && s.backdropFilter !== "none") return "blur";
    return null;
  };
  const context = (el: Element) => {
    const s = cs(el);
    return (
      (s.position !== "static" && s.zIndex !== "auto") ||
      s.opacity !== "1" ||
      s.transform !== "none" ||
      s.filter !== "none" ||
      s.mixBlendMode !== "normal" ||
      s.isolation === "isolate" ||
      (!!s.maskImage && s.maskImage !== "none") ||
      s.perspective !== "none" ||
      (s.translate && s.translate !== "none") ||
      (s.rotate && s.rotate !== "none") ||
      (s.scale && s.scale !== "none")
    );
  };
  const positioned = (el: Element) => cs(el).position !== "static";
  const zOf = (el: Element) => (cs(el).zIndex === "auto" ? 0 : Number(cs(el).zIndex));
  const order: Array<{ el: Element; kind: Leaf["kind"] }> = [];
  const skip = (el: Element) => el.tagName === "SCRIPT" || el.tagName === "STYLE" || (el.tagName.toLowerCase() === "svg" && el.getAttribute("width") === "0");
  const paint = (ctx: Element, own: boolean) => {
    if (own) order.push({ el: ctx, kind: "own" });
    const parts: Element[] = [];
    const walk = (el: Element) => {
      for (const c of Array.from(el.children)) {
        if (skip(c)) continue;
        if (special(c) || positioned(c) || context(c)) {
          parts.push(c);
          if (!special(c) && !context(c)) walk(c);
        } else walk(c);
      }
    };
    walk(ctx);
    parts
      .map((el, i) => ({ el, i, z: zOf(el) }))
      .sort((a, b) => a.z - b.z || a.i - b.i)
      .forEach(({ el }) => {
        const sp = special(el);
        if (sp) order.push({ el, kind: sp });
        else if (context(el)) paint(el, true);
        else order.push({ el, kind: "own" });
      });
  };
  paint(document.body, false);

  // What each part paints itself: its own box and what's in it that isn't a part of its own.
  const parts = new Set(order.map((o) => o.el));
  const own = (el: Element, kind: Leaf["kind"]): Element[] => {
    if (kind !== "own") return [el, ...Array.from(el.querySelectorAll("*"))];
    const out: Element[] = [el];
    const walk = (e: Element) => {
      for (const c of Array.from(e.children)) {
        if (parts.has(c) || skip(c)) continue;
        out.push(c);
        walk(c);
      }
    };
    walk(el);
    return out;
  };
  const paints = (els: Element[]) =>
    els.some((e) => {
      const s = cs(e);
      if (s.display === "none") return false;
      if (["IMG", "VIDEO", "CANVAS", "svg", "SVG"].includes(e.tagName)) return true;
      if (Array.from(e.childNodes).some((c) => c.nodeType === 3 && (c.textContent ?? "").trim())) return true;
      const bg = s.backgroundColor;
      if (bg && !/rgba\(.*,\s*0\)$/.test(bg) && bg !== "transparent") return true;
      if (s.backgroundImage && s.backgroundImage !== "none") return true;
      if (s.boxShadow && s.boxShadow !== "none") return true;
      if (parseFloat(s.borderTopWidth) > 0 || parseFloat(s.borderLeftWidth) > 0) return true;
      return false;
    });
  const stage = document.getElementById("stage");
  const overlay = document.getElementById("overlay");
  const devs = Array.from(document.querySelectorAll(".dev-wrap"));
  const leaves: Leaf[] = [];
  for (const { el, kind } of order) {
    const els = own(el, kind);
    if (kind === "own" && !paints(els)) continue;
    // Where it is, with room for shadows and soft edges.
    let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
    for (const e of els) {
      const r = e.getBoundingClientRect();
      if (!r.width && !r.height) continue;
      [x0, y0, x1, y1] = [Math.min(x0, r.left), Math.min(y0, r.top), Math.max(x1, r.right), Math.max(y1, r.bottom)];
    }
    if (!isFinite(x0)) continue;
    const pad = Math.max(24, 0.12 * Math.max(x1 - x0, y1 - y0));
    const W = document.documentElement.clientWidth;
    const H = document.documentElement.clientHeight;
    const bounds: [number, number, number, number] = [Math.max(0, Math.floor(x0 - pad)), Math.max(0, Math.floor(y0 - pad)), 0, 0];
    bounds[2] = Math.min(W, Math.ceil(x1 + pad)) - bounds[0];
    bounds[3] = Math.min(H, Math.ceil(y1 + pad)) - bounds[1];
    const r = el.getBoundingClientRect();
    const leaf: Leaf = {
      id: id(el),
      kind,
      ent: el.getAttribute("data-ent") ?? undefined,
      cam: stage?.contains(el) ? "stage" : overlay?.contains(el) ? "overlay" : "none",
      mid: [r.left + r.width / 2, r.top + r.height / 2],
      bounds,
    };
    if (el.classList.contains("dev-wrap")) leaf.dev = devs.indexOf(el);
    if (el.querySelector(".hlx")) leaf.hl = true;
    if (leaf.ent === "caption") leaf.cap = true;
    const s = cs(el);
    if (kind === "fill") leaf.fill = { color: s.backgroundColor, opacity: parseFloat(s.opacity), blend: s.mixBlendMode };
    if (kind === "grain") leaf.grain = { opacity: parseFloat(s.opacity), blend: s.mixBlendMode, size: parseFloat(s.backgroundSize) || 220, image: s.backgroundImage };
    if (kind === "blur") {
      const mask = s.maskImage || (s as unknown as Record<string, string>).webkitMaskImage || "";
      leaf.blur = { radius: parseFloat(/blur\(([\d.]+)px\)/.exec(s.backdropFilter)?.[1] ?? "0"), toward: /to top/.test(mask) ? "up" : "down", solid: (parseFloat(/(\d+(?:\.\d+)?)%/.exec(mask)?.[1] ?? "0") || 0) / 100 };
      leaf.bounds = [r.left, r.top, r.width, r.height];
    }
    // A device: how it's turned and tilted, and (playing a recording) where its screen is.
    const rot = kind === "entity" && el.classList.contains("dev-wrap") ? el.querySelector<HTMLElement>(".dev-rot") : null;
    const shot = rot ? el.querySelector<HTMLElement>("video.shot") : null;
    if (rot) {
      const devStage = el.querySelector<HTMLElement>(".dev-stage");
      if (!devStage) return { leaves, error: `${leaf.ent} has no device box` };
      // Where an element is laid out inside the device box (null when it isn't).
      const within = (from: HTMLElement) => {
        let [x, y] = [0, 0];
        let e: HTMLElement | null = from;
        while (e && e !== rot) {
          x += e.offsetLeft;
          y += e.offsetTop;
          e = e.offsetParent as HTMLElement | null;
        }
        return e === rot ? [x, y] : null;
      };
      // The screen: the nearest box round the video that trims it (else the video's own).
      let screen: HTMLElement | null = shot;
      for (let a = shot?.parentElement ?? null; a && a !== rot; a = a.parentElement) {
        const st = cs(a);
        if (st.overflow !== "visible" || st.overflowX !== "visible") {
          screen = a;
          break;
        }
      }
      const so = shot ? within(shot) : [0, 0];
      const bo = screen ? within(screen) : [0, 0];
      if (shot && (!so || !bo)) return { leaves, error: `${leaf.ent}'s screen isn't laid out inside its device` };
      const [sx, sy] = bo!;
      const nums = (rot.style.transform.match(/-?[\d.]+deg/g) ?? []).map((v) => parseFloat(v));
      const tilt = /rotateZ\(calc\(([-\d.]+)deg[^)]*\)\)\s*rotateX\(calc\(([-\d.]+)deg[^)]*\)\)\s*rotateY\(calc\(([-\d.]+)deg[^)]*\)\)\s*rotateZ\(([-\d.]+)deg\)/.exec(rot.style.transform);
      const radius = screen ? parseFloat(cs(screen).borderTopLeftRadius) || parseFloat(cs(shot!).borderTopLeftRadius) || 0 : 0;
      let filter: string | undefined;
      for (let a = el.parentElement; a; a = a.parentElement) {
        const f = cs(a).filter;
        if (f && f !== "none") filter = filter ? `${f} ${filter}` : f;
      }
      const sr = screen?.getBoundingClientRect() ?? new DOMRect();
      const wr = el.getBoundingClientRect();
      leaf.device = {
        hasVideo: Boolean(shot),
        cx: wr.left,
        cy: wr.top,
        frameW: rot.offsetWidth,
        frameH: rot.offsetHeight,
        shot: screen ? [sx, sy, screen.offsetWidth, screen.offsetHeight] : [0, 0, 0, 0],
        inner: shot ? [so![0] - sx, so![1] - sy, shot.offsetWidth, shot.offsetHeight] : [0, 0, 0, 0],
        radius,
        rotate: tilt ? parseFloat(tilt[1]) : nums[0] ?? 0,
        rotateX: tilt ? parseFloat(tilt[2]) : 0,
        rotateY: tilt ? parseFloat(tilt[3]) : 0,
        turn: tilt ? parseFloat(tilt[4]) : 0,
        perspective: parseFloat(cs(devStage).perspective) || 0,
        filter,
        blur: parseFloat(/blur\(([\d.]+)px\)/.exec(cs(el).filter)?.[1] ?? "0"),
        seen: [sr.left, sr.top, sr.width, sr.height],
      };
      // Its parts before the screen (the body) and after it (the art over the screen, call-outs).
      const all = Array.from(el.querySelectorAll("*"));
      const at = shot ? all.indexOf(shot) : -1;
      if (shot) all.forEach((x, i) => {
        if (x === shot || shot.contains(x)) return;
        if (i < at && !x.contains(shot)) x.setAttribute("data-nx-pre", "1");
        if (i > at) x.setAttribute("data-nx-post", "1");
        if (x.contains(shot)) x.setAttribute("data-nx-wraps", "1");
      });
    }
    leaves.push(leaf);
  }
  return { leaves };
}

/** In the page: show one part (or a device's body or its art over the screen) and nothing else. */
function showOnly(arg: { id: string | null; part?: "below" | "above" }) {
  document.querySelectorAll("[data-nx-on],[data-nx-off],[data-nx-self-off]").forEach((e) => {
    e.removeAttribute("data-nx-on");
    e.removeAttribute("data-nx-off");
    e.removeAttribute("data-nx-self-off");
  });
  if (!arg.id) return document.body.classList.remove("nx");
  document.body.classList.add("nx");
  const el = document.querySelector(`[data-nx="${arg.id}"]`)!;
  el.setAttribute("data-nx-on", "1");
  // Its own parts (each photographed on its own) stay out.
  el.querySelectorAll("[data-nx]").forEach((p) => p.setAttribute("data-nx-off", "1"));
  if (arg.part) {
    el.querySelectorAll("video.shot").forEach((v) => v.setAttribute("data-nx-off", "1"));
    if (arg.part === "below") el.querySelectorAll("[data-nx-post]").forEach((p) => p.setAttribute("data-nx-off", "1"));
    else {
      el.querySelectorAll("[data-nx-pre]").forEach((p) => p.setAttribute("data-nx-off", "1"));
      el.setAttribute("data-nx-self-off", "1");
      el.querySelectorAll("[data-nx-wraps]").forEach((p) => p.setAttribute("data-nx-self-off", "1"));
    }
  }
}

/** In the page: everything as designed, at rest (no animation, ambient motion or camera), the stage as it plays. */
function rest() {
  document.querySelectorAll<HTMLElement>("[data-ent]").forEach((el) => {
    for (const v of ["--ax", "--ay", "--asx", "--asy", "--ar", "--arx", "--ary", "--ao", "--acolor", "--ablur", "--amark"]) el.style.removeProperty(v);
    el.querySelectorAll<HTMLElement>(".u").forEach((u) => {
      u.style.opacity = u.style.translate = u.style.scale = u.style.rotate = u.style.filter = "";
    });
    el.querySelectorAll<HTMLElement>("[data-callout]").forEach((c) => c.style.removeProperty("--hl"));
  });
  document.querySelectorAll<HTMLElement>(".dev-wrap").forEach((d) => {
    d.style.setProperty("--dx", "0px");
    d.style.setProperty("--dy", "0px");
    for (const v of ["--dr", "--drx", "--dry"]) d.style.setProperty(v, "0deg");
  });
  camOff();
  const root = document.getElementById("canvas");
  root?.style.removeProperty("--hl");
  root?.style.removeProperty("--cap");
  const bd = document.querySelector<HTMLElement>(".bg-move");
  if (bd) bd.style.transform = bd.style.filter = "";
  function camOff() {
    const stage = document.getElementById("stage");
    // A transform keeps the stage the stacking context it is while the video plays.
    if (stage) {
      stage.style.transformOrigin = "0px 0px";
      stage.style.transform = "translate(0px, 0px) scale(1)";
    }
    const overlay = document.getElementById("overlay");
    if (overlay) overlay.style.transform = "";
  }
}

/** In the page: the camera back to rest, the rest as the timeline left it. */
function camOff() {
  const stage = document.getElementById("stage");
  if (stage) {
    stage.style.transformOrigin = "0px 0px";
    stage.style.transform = "translate(0px, 0px) scale(1)";
  }
  const overlay = document.getElementById("overlay");
  if (overlay) overlay.style.transform = "";
  const bd = document.querySelector<HTMLElement>(".bg-move");
  void bd;
}

// ---------------------------------------------------------------------------------------------
// The timeline, worked out as the page plays it

const ease = (x: number) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));
const windowAt = (t: number, span: { in?: number; out?: number } | undefined, f: number) => {
  if (!span) return 1;
  const a = span.in ?? 0;
  const up = a <= 0 ? 1 : ease((t - a) / f);
  const down = span.out === undefined ? 1 : 1 - ease((t - (span.out - f)) / f);
  return Math.min(up, down);
};

/** A device's ambient motion at `t` (as the page sets --dx, --dy, --dr, --drx, --dry). */
function motionAt(tl: FastStage["timeline"], i: number, t: number) {
  const { W, H, duration: D, amount: A } = tl;
  const ph = i * 1.3;
  const w = (period: number) => Math.sin((2 * Math.PI * t) / period + ph);
  let dx = 0,
    dy = 0,
    dr = 0,
    drx = 0,
    dry = 0;
  if (tl.motion === "subtle") {
    dy = w(6) * 0.004 * H * A;
    dr = w(7.5) * 0.35 * A;
  } else if (tl.motion === "float") {
    dy = w(5) * 0.012 * H * A;
    drx = w(6.3) * 2.2 * A;
    dry = Math.cos((2 * Math.PI * t) / 7.1 + ph) * 3 * A;
  } else if (tl.motion === "drift") {
    const k = ease(t / D);
    dx = (k - 0.5) * 0.03 * W * A;
    dry = (0.5 - k) * 8 * A;
    dy = w(6) * 0.003 * H * A;
  }
  return { dx, dy, dr, drx, dry };
}

/** The stage's camera at `t` (zoom, focus, move; canvas px), as the page works it out. */
function stageCamera(tl: FastStage["timeline"], frame: AnimFrame, t: number) {
  const { W, H, duration: D, amount: A, keys } = tl;
  let cam = keys[0] ?? { t: 0, s: 1, x: 0.5, y: 0.5 };
  if (frame.camera) cam = { t, ...frame.camera };
  else
    for (let k = 0; k < keys.length - 1; k++) {
      const a = keys[k];
      const b = keys[k + 1];
      if (t >= a.t && t <= b.t) {
        const p = b.t > a.t ? (t - a.t) / (b.t - a.t) : 1;
        const e = p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2;
        cam = { t, s: a.s + (b.s - a.s) * e, x: a.x + (b.x - a.x) * e, y: a.y + (b.y - a.y) * e };
        break;
      }
      if (t > b.t) cam = b;
    }
  let zoom = cam.s;
  if (tl.motion === "push-in") zoom *= 1 + 0.07 * A * ease(t / D);
  const c = cameraTransform({ zoom, x: cam.x, y: cam.y }, W, H);
  void D;
  // translate(cx - fx, cy - fy) scale(zoom) about (fx, fy).
  return mul(T(c.fx + c.tx, c.fy + c.ty), mul(S(c.zoom), T(-c.fx, -c.fy)));
}

/** A device's screen corners for one frame, canvas px (top left, top right, bottom right, bottom left). */
function screenCorners(v: DeviceGeometry, extra: { dr: number; rx: number; ry: number }, toCanvas: (x: number, y: number) => number[], rect: [number, number, number, number] = v.shot): number[][] {
  const [x, y, w, h] = rect;
  const corners = [
    [x, y],
    [x + w, y],
    [x + w, y + h],
    [x, y + h],
  ];
  const rad = Math.PI / 180;
  const a = (v.rotate + extra.dr) * rad;
  const b = (v.rotateX + extra.rx) * rad;
  const c = (v.rotateY + extra.ry) * rad;
  const t = v.turn * rad;
  return corners.map(([px, py]) => {
    // From the device box's middle; CSS applies the list right to left: turn, Y, X, Z.
    let p = [px - v.frameW / 2, py - v.frameH / 2, 0];
    const rz = (q: number[], g: number) => [q[0] * Math.cos(g) - q[1] * Math.sin(g), q[0] * Math.sin(g) + q[1] * Math.cos(g), q[2]];
    p = rz(p, t);
    p = [p[0] * Math.cos(c) + p[2] * Math.sin(c), p[1], -p[0] * Math.sin(c) + p[2] * Math.cos(c)];
    p = [p[0], p[1] * Math.cos(b) - p[2] * Math.sin(b), p[1] * Math.sin(b) + p[2] * Math.cos(b)];
    p = rz(p, a);
    const k = v.perspective > 0 ? v.perspective / (v.perspective - p[2]) : 1;
    return toCanvas(p[0] * k, p[1] * k);
  });
}

/** The perspective map taking four corners to four others (3×3, row by row, the last 1). */
function homography(from: number[][], to: number[][]): number[] {
  // Eight equations in eight unknowns, solved by elimination.
  const A: number[][] = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = from[i];
    const [u, v] = to[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y, u]);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y, v]);
  }
  for (let c = 0; c < 8; c++) {
    let p = c;
    for (let r = c + 1; r < 8; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    [A[c], A[p]] = [A[p], A[c]];
    for (let r = 0; r < 8; r++) {
      if (r === c || !A[c][c]) continue;
      const f = A[r][c] / A[c][c];
      for (let k = c; k < 9; k++) A[r][k] -= f * A[c][k];
    }
  }
  return [...A.map((row, i) => row[8] / row[i]), 1];
}
const throughH = (h: number[], x: number, y: number) => {
  const w = h[6] * x + h[7] * y + h[8];
  return [(h[0] * x + h[1] * y + h[2]) / w, (h[3] * x + h[4] * y + h[5]) / w];
};

// ---------------------------------------------------------------------------------------------
// The export

export interface FastResult {
  width: number;
  height: number;
  frames: number;
}

/**
 * Draw the video with the app. Throws when something in the design can't be drawn this way (the
 * export then takes the usual way). `output` is written as asked: an MP4 or a MOV directly, WebM
 * and GIF made from what the app draws.
 */
export async function renderFast(input: VideoInput, st: FastStage, out: string, fps: number, o: { format: string; shot?: boolean; appStore?: boolean; deliveryWidth?: number; progress?: (f: number) => void }): Promise<FastResult> {
  const { page, dir, W, H, clip, duration, timeline: tl } = st;
  const view = st.view;
  const total = Math.max(1, Math.round(duration * fps));
  // Output px per page CSS px; page CSS px per canvas px (and where the canvas sits in the page).
  const q = (o.deliveryWidth ?? clip.width * st.scale) / clip.width;
  const OW = Math.round((clip.width * q) / 2) * 2;
  const OH = Math.round((clip.height * q) / 2) * 2;
  const toPage = (x: number, y: number) => [view.x + x * view.scale, view.y + y * view.scale];
  const pageToOut: Mat = S(q);
  const canvasToOut: Mat = mul(pageToOut, mul(T(view.x, view.y), S(view.scale)));
  const outToCanvas = (m: Mat) => {
    // M in canvas px, as a matrix on output px.
    const inv: Mat = mul(S(1 / view.scale), mul(T(-view.x, -view.y), S(1 / q)));
    return mul(canvasToOut, mul(m, inv));
  };

  // The videos are drawn by the app: the page no longer seeks them frame by frame.
  await page.evaluate(() =>
    document.querySelectorAll<HTMLVideoElement>("video.shot").forEach((v) => {
      v.removeAttribute("src");
      v.load();
    }),
  );
  await page.addStyleTag({
    content:
      "body.nx *{visibility:hidden!important} body.nx [data-nx-on],body.nx [data-nx-on] *{visibility:visible!important} " +
      "body.nx [data-nx-self-off]{visibility:hidden!important} body.nx [data-nx-off],body.nx [data-nx-off] *{visibility:hidden!important} .nx-cursor{display:none!important}",
  });
  await page.evaluate(rest);
  const found = await page.evaluate(analyse);
  if (found.error) throw new Error(found.error);
  const leaves = found.leaves;

  // Each part's devices and timing, frame by frame.
  const frames: AnimFrame[] = [];
  for (let i = 0; i < total; i++) frames.push(st.frameAt(i / fps));
  const stageCam = frames.map((f, i) => stageCamera(tl, f, i / fps));
  const overlayCam = frames.map((f, i) => (f.camera ? stageCam[i] : I));
  const camFor = (leaf: Leaf, i: number) => (leaf.cam === "stage" ? stageCam[i] : leaf.cam === "overlay" ? overlayCam[i] : I);
  const inCanvas = (p: [number, number]) => [(p[0] - view.x) / view.scale, (p[1] - view.y) / view.scale];

  type Plan = { layer: Record<string, unknown>; looks?: Map<string, number>; lookAt?: number[]; index?: number[]; part?: "below" | "above"; leaf: Leaf; keys?: string[] };
  const plans: Plan[] = [];

  for (const leaf of leaves) {
    if (leaf.kind === "fill") {
      plans.push({ leaf, layer: { type: "fill", color: leaf.fill!.color, amount: leaf.fill!.opacity, blend: leaf.fill!.blend, rect: leaf.bounds.map((v) => v * q) } });
      continue;
    }
    if (leaf.kind === "blur") {
      plans.push({ leaf, layer: { type: "blur", rect: leaf.bounds.map((v) => v * q), radiusPx: (leaf.blur!.radius * q) / 2, toward: leaf.blur!.toward, solid: leaf.blur!.solid } });
      continue;
    }
    if (leaf.kind === "grain") {
      const g = leaf.grain!;
      const k = view.scale * q;
      const offsets = frames.map((_, i) => {
        const n = tl.grainFps > 0 ? Math.floor((i / fps) * tl.grainFps) : 0;
        return [((n * 73) % 220) * k, ((n * 151) % 220) * k];
      });
      plans.push({ leaf, layer: { type: "grain", tile: g.size * k, offsets, blend: g.blend, opacity: [g.opacity], rect: leaf.bounds.map((v) => v * q) } });
      continue;
    }
    // A part's state each frame: what it looks like (a key), how it moves, how see-through it is.
    const keys: string[] = [];
    const matrices: Mat[] = [];
    const opacity: number[] = [];
    const hues: number[] = [];
    const blurs: number[] = [];
    const tilt: Array<{ dr: number; rx: number; ry: number }> = [];
    let changes = false;
    const mid = inCanvas(leaf.mid);
    for (let i = 0; i < total; i++) {
      const f = frames[i];
      const t = i / fps;
      let m: Mat = I;
      let o = 1;
      const look: unknown[] = [];
      if (leaf.kind === "backdrop") {
        if (f.backdrop) {
          // Only a plain canvas: framed, the backdrop's own size isn't the canvas's.
          if (view.scale !== 1 || view.x || view.y) look.push(f.backdrop);
          else {
            m = cssMatrix(f.backdrop.transform);
            hues.push(parseFloat(/hue-rotate\(([-\d.]+)deg\)/.exec(f.backdrop.filter)?.[1] ?? "0"));
            blurs.push(parseFloat(/blur\(([\d.]+)px\)/.exec(f.backdrop.filter)?.[1] ?? "0") * q);
          }
        }
      } else if (leaf.ent) {
        const el = f.els.find((e) => e.id === leaf.ent);
        const shape = f.shapes.find((e) => e.id === leaf.ent);
        const callouts = f.callouts.filter((c) => c.device === leaf.ent);
        const mo = leaf.dev !== undefined ? motionAt(tl, leaf.dev, t) : undefined;
        const v = leaf.device;
        if (shape) look.push(shape);
        if (callouts.length) look.push(callouts);
        if (leaf.hl) look.push(Math.round(windowAt(t, tl.highlight, tl.fade) * 1000));
        if (leaf.cap) look.push(Math.round(windowAt(t, tl.caption, tl.fade) * 1000));
        // Only what differs from it at rest (a mark is 1, fully drawn, unless it's being drawn).
        const marking = el?.mark !== undefined && el.mark < 0.999;
        if (el && (el.color || (el.blur ?? 0) > 0.01 || marking || el.units?.length || ((el.rx || el.ry) && !v))) look.push(el.color, el.blur, marking ? el.mark : undefined, el.units);
        // A device turned in 3D: drawn once, then put on the corners its turn gives it (below).
        const turns = Boolean(v) && Boolean(v!.perspective || mo?.drx || mo?.dry || el?.rx || el?.ry);
        if (v) tilt.push({ dr: mo?.dr ?? 0, rx: (el?.rx ?? 0) + (mo?.drx ?? 0), ry: (el?.ry ?? 0) + (mo?.dry ?? 0) });
        if (el) {
          // Turned and scaled about its middle, then moved (as the page does it).
          m = mul(T(mid[0] + el.dx, mid[1] + el.dy), mul(R(el.r), mul(S(el.sx, el.sy), T(-mid[0], -mid[1]))));
          o = el.o;
        }
        if (mo) {
          m = mul(T(mo.dx, mo.dy), m);
          if (!turns && mo.dr) m = mul(m, mul(T(mid[0], mid[1]), mul(R(mo.dr), T(-mid[0], -mid[1]))));
        }
      }
      if (look.length) changes = true;
      keys.push(JSON.stringify(look));
      matrices.push(m);
      opacity.push(Math.max(0, Math.min(1, o)));
    }
    const v = leaf.device;
    // Turned in 3D: each frame, the corners the device's box lands on, and the map from where it is at rest.
    const threeD = Boolean(v) && (Boolean(v!.perspective) || tilt.some((x) => x.rx || x.ry));
    const turned = threeD && !changes;
    if (threeD && changes) {
      // Changing looks too: each look drawn turned as it is (keys with the turn).
      for (let i = 0; i < total; i++) keys[i] = JSON.stringify([keys[i], r4(tilt[i].dr), r4(tilt[i].rx), r4(tilt[i].ry)]);
    }
    const center = v ? inCanvas([v.cx, v.cy]) : [0, 0];
    const k = view.scale * q;
    /** Where a rect of the device's box lands this frame (output px): its turn, its move, the camera. */
    const cornersAt = (i: number, rect: [number, number, number, number], still = false) => {
      const f = frames[i];
      const el = still ? undefined : f.els.find((e) => e.id === leaf.ent);
      const mo = still || leaf.dev === undefined ? { dx: 0, dy: 0, dr: 0, drx: 0, dry: 0 } : motionAt(tl, leaf.dev, i / fps);
      let m: Mat = el ? mul(T(center[0] + el.dx, center[1] + el.dy), mul(R(el.r), mul(S(el.sx, el.sy), T(-center[0], -center[1])))) : I;
      m = mul(T(mo.dx, mo.dy), m);
      const whole = mul(canvasToOut, still ? I : mul(camFor(leaf, i), m));
      return screenCorners(v!, { dr: mo.dr, rx: (el?.rx ?? 0) + mo.drx, ry: (el?.ry ?? 0) + mo.dry }, (x, y) => [center[0] + x, center[1] + y], rect).map(([x, y]) => apply(whole, x, y));
    };
    const parts: Array<"below" | "above" | undefined> = v?.hasVideo ? ["below", "above"] : [undefined];
    for (const part of parts) {
      const layer: Record<string, unknown> = { type: "picture", opacity: opacity.some((x) => x < 0.999) ? opacity.map(r4) : undefined };
      if (hues.some((h) => Math.abs(h) > 0.01)) layer.hue = hues.map(r4);
      if (blurs.some((b) => b > 0.05)) layer.blur = blurs.map(r4);
      if (changes) {
        // A look for each change; the camera moves it (its own move is in the picture).
        const looks = new Map<string, number>();
        const index = keys.map((key) => {
          if (!looks.has(key)) looks.set(key, looks.size);
          return looks.get(key)!;
        });
        layer.matrix = frames.map((_, i) => outToCanvas(camFor(leaf, i))).map((m) => m.map(r4));
        plans.push({ leaf, part, layer, looks, index, keys });
      } else if (turned) {
        // The picture at rest, put each frame where the device's box goes (a perspective map).
        const box: [number, number, number, number] = [0, 0, v!.frameW, v!.frameH];
        const atRest = cornersAt(0, box, true);
        const rect = leaf.bounds.map((x) => x * q);
        const rc = [[rect[0], rect[1]], [rect[0] + rect[2], rect[1]], [rect[0] + rect[2], rect[1] + rect[3]], [rect[0], rect[1] + rect[3]]];
        layer.quads = frames.map((_, i) => {
          const h = homography(atRest, cornersAt(i, box));
          return rc.flatMap(([x, y]) => throughH(h, x, y)).map(r4);
        });
        plans.push({ leaf, part, layer });
      } else {
        const ms = matrices.map((m, i) => outToCanvas(mul(camFor(leaf, i), m)));
        if (ms.some((m) => !isI(m))) layer.matrix = ms.map((m) => m.map(r4));
        plans.push({ leaf, part, layer });
      }
      if (part === "below") {
        // The video, between its device's body and the art over its screen.
        const quads: number[][] = [];
        for (let i = 0; i < total; i++) quads.push(cornersAt(i, v!.shot).flat().map(r4));
        // A check: at rest, the sums put the screen where the page does.
        const rest = screenCorners(v!, { dr: 0, rx: 0, ry: 0 }, (x, y) => toPage(center[0] + x, center[1] + y));
        const xs = rest.map((p) => p[0]);
        const ys = rest.map((p) => p[1]);
        const seen = v!.seen;
        const off = Math.max(Math.abs(Math.min(...xs) - seen[0]), Math.abs(Math.min(...ys) - seen[1]), Math.abs(Math.max(...xs) - seen[0] - seen[2]), Math.abs(Math.max(...ys) - seen[1] - seen[3]));
        if (off > 2) throw new Error(`${leaf.ent}'s screen comes out ${off.toFixed(1)} px from where the page draws it`);
        const d = input.devices[Number(leaf.ent!.split("-")[1]) - 1];
        const video: Record<string, unknown> = {
          type: "video",
          file: d.video,
          box: [v!.shot[2] * k, v!.shot[3] * k].map(r4),
          inner: v!.inner.map((x) => r4(x * k)),
          quads,
          radius: r4(v!.radius * k),
          opacity: opacity.some((x) => x < 0.999) ? opacity.map(r4) : undefined,
          colorMatrix: v!.filter ? filterMatrix(v!.filter) : undefined,
          blur: v!.blur > 0.05 ? [r4((v!.blur * k) / 2)] : undefined,
        };
        const opt = input.video?.cursor;
        const c = st.cursorTrack ?? (opt?.points?.length ? pointsTrack(opt.points, duration) : undefined);
        if (c && opt && (opt.device ?? 0) === Number(leaf.ent!.split("-")[1]) - 1) {
          // A fingertip on phones and tablets (as the page has it), the macOS pointer elsewhere.
          const touch = !st.cursorTrack && (opt.style === "touch" || (!opt.style && !/MacBook|iMac/i.test(input.devices[Number(leaf.ent!.split("-")[1]) - 1]?.device ?? "") && !["browser", "window"].includes(input.devices[Number(leaf.ent!.split("-")[1]) - 1]?.frame ?? "")));
          video.cursor = await cursorPictures(dir, c, v!.inner[2] * k * (touch ? 0.105 : 0.016) * (opt.size ?? 1), touch);
        }
        plans.push({ leaf, layer: video });
      }
    }
  }

  // The pictures: each part at rest, once; the ones that change, once for each look.
  const shoot = async (plan: Plan, file: string, bounds: number[]) => {
    await page.evaluate(showOnly, { id: plan.leaf.id, part: plan.part });
    await page.screenshot({ path: file as `${string}.png`, type: "png", omitBackground: true, clip: { x: bounds[0], y: bounds[1], width: Math.max(1, bounds[2]), height: Math.max(1, bounds[3]) } });
  };
  let shots = 0;
  for (const [n, plan] of plans.entries()) {
    if (plan.layer.type !== "picture" || plan.looks) continue;
    const file = path.join(dir, `part-${n}.png`);
    await shoot(plan, file, plan.leaf.bounds);
    Object.assign(plan.layer, { file, rect: plan.leaf.bounds.map((v) => r4(v * q)) });
    shots++;
  }
  // Looks, in frame order: the page set to that moment (its camera at rest), each new look photographed.
  const changing = plans.filter((p) => p.looks);
  if (changing.length) {
    const files = new Map<Plan, string[]>();
    const rects = new Map<Plan, number[][]>();
    for (let i = 0; i < total; i++) {
      const due = changing.filter((p) => p.looks!.get(p.keys![i]) === (files.get(p)?.length ?? 0));
      if (!due.length) continue;
      await page.evaluate((t, f) => (window as any).__setTime(t, f), i / fps, { ...frames[i], camera: undefined });
      await page.evaluate(camOff);
      for (const p of due) {
        const b = await page.evaluate((id) => {
          const el = document.querySelector(`[data-nx="${id}"]`)!;
          let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
          for (const e of [el, ...Array.from(el.querySelectorAll("*"))]) {
            const r = e.getBoundingClientRect();
            if (!r.width && !r.height) continue;
            [x0, y0, x1, y1] = [Math.min(x0, r.left), Math.min(y0, r.top), Math.max(x1, r.right), Math.max(y1, r.bottom)];
          }
          const pad = Math.max(24, 0.12 * Math.max(x1 - x0, y1 - y0));
          const W = document.documentElement.clientWidth;
          const H = document.documentElement.clientHeight;
          const l = Math.max(0, Math.floor(x0 - pad));
          const t = Math.max(0, Math.floor(y0 - pad));
          return isFinite(x0) ? [l, t, Math.min(W, Math.ceil(x1 + pad)) - l, Math.min(H, Math.ceil(y1 + pad)) - t] : [0, 0, 1, 1];
        }, p.leaf.id);
        const list = files.get(p) ?? [];
        const file = path.join(dir, `look-${plans.indexOf(p)}-${list.length}.png`);
        await shoot(p, file, b);
        list.push(file);
        files.set(p, list);
        rects.set(p, [...(rects.get(p) ?? []), b.map((v) => r4(v * q))]);
        shots++;
      }
      o.progress?.(0.25 * (i / total));
    }
    for (const p of changing) Object.assign(p.layer, { files: files.get(p), rects: rects.get(p), index: p.index });
  }
  await page.evaluate(showOnly, { id: null });

  // The app draws it.
  const transparent = Boolean(st.scene.transparent) && (o.format === "mov" || o.format === "webm");
  const direct = o.format === "mp4" || o.format === "mov";
  const drawn = direct ? out : path.join(dir, transparent ? "drawn.mov" : "drawn.mp4");
  const codec = transparent ? "prores4444" : o.format === "mov" ? "prores" : "h264";
  const spec = {
    output: drawn,
    width: OW,
    height: OH,
    fps,
    frames: total,
    codec,
    appStore: o.appStore,
    bitrate: o.appStore ? 11_000_000 : o.shot || !direct ? Math.min(150_000_000, Math.round(OW * OH * fps * 0.35)) : undefined,
    transparent,
    layers: plans.map((p) => p.layer),
  };
  const specFile = path.join(dir, "fast.json");
  writeFileSync(specFile, JSON.stringify(spec));
  // SCREENSHOTTER_FAST_KEEP=<folder>: keep what the app was given (pictures and all), to look at.
  if (process.env.SCREENSHOTTER_FAST_KEEP) {
    const { cpSync } = await import("node:fs");
    cpSync(dir, path.join(process.env.SCREENSHOTTER_FAST_KEEP, path.basename(out)), { recursive: true });
  }
  const before = changing.length ? 0.25 : 0;
  await new Promise<void>((resolve, reject) => {
    const p = spawn(process.env.SCREENSHOTTER_NATIVE!, ["--render-recording", specFile], { stdio: ["ignore", "pipe", "pipe"] });
    let err = "";
    let last = Date.now();
    p.stdout.on("data", (d) => {
      last = Date.now();
      const m = /progress (\d+)\/(\d+)\s*$/.exec(String(d).trim());
      if (m) o.progress?.(before + (1 - before) * 0.97 * (Number(m[1]) / Math.max(1, Number(m[2]))));
    });
    p.stderr.on("data", (d) => (err += d));
    // macOS's video encoder can get stuck: give up when nothing moves for a minute.
    const watch = setInterval(() => {
      if (Date.now() - last > 60_000) {
        p.kill("SIGKILL");
        reject(new Error("the video encoder stopped responding"));
      }
    }, 2000);
    p.on("error", (e) => (clearInterval(watch), reject(e)));
    p.on("exit", (code) => {
      clearInterval(watch);
      if (code === 0) resolve();
      else reject(new Error(err.trim().split("\n").slice(-2).join(" ") || `the renderer stopped (${code})`));
    });
  });
  if (!direct) await transcode(drawn, out, o.format, fps, transparent);
  void shots;
  return { width: OW, height: OH, frames: total };
}

/**
 * A cursor given as points (where it is, when; a click; a drag), as a path every sixtieth of a
 * second: gliding between them as the page has it (easing in and out of each).
 */
function pointsTrack(points: Array<{ t: number; x: number; y: number; click?: boolean }>, duration: number): NonNullable<FastStage["cursorTrack"]> {
  const pts = [...points].sort((a, b) => a.t - b.t);
  const step = 1 / 60;
  const xs: number[] = [];
  const ys: number[] = [];
  for (let i = 0; i * step <= duration + step; i++) {
    const t = i * step;
    let x = pts[pts.length - 1].x;
    let y = pts[pts.length - 1].y;
    if (t <= pts[0].t) [x, y] = [pts[0].x, pts[0].y];
    else
      for (let k = 0; k < pts.length - 1; k++) {
        const [a, b] = [pts[k], pts[k + 1]];
        if (t <= b.t) {
          const p = b.t > a.t ? (t - a.t) / (b.t - a.t) : 1;
          const e = p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2;
          [x, y] = [a.x + (b.x - a.x) * e, a.y + (b.y - a.y) * e];
          break;
        }
      }
    xs.push(r4(x));
    ys.push(r4(y));
  }
  return { step, xs, ys, clicks: pts.filter((p) => p.click).map((p) => [p.t, p.x, p.y] as [number, number, number]), kinds: [[0, "arrow"]], ripple: true };
}

/** The cursor's pictures (each of macOS's cursors, or a fingertip, and the click ring) at the size it's drawn, px. */
async function cursorPictures(dir: string, c: NonNullable<FastStage["cursorTrack"]>, size: number, touch = false) {
  const pad = Math.ceil(size * 0.3);
  const art = await newPage();
  const images: Record<string, { file: string; hot: number[] }> = {};
  let ripple: { file: string } | undefined;
  try {
    if (touch) {
      // A fingertip: a soft white dot, its middle the point.
      const side = Math.ceil(size + pad * 2);
      await art.setViewport({ width: side, height: side, deviceScaleFactor: 1 });
      await art.setContent(`<html><body style="margin:0;background:transparent"><div style="position:absolute;left:${pad}px;top:${pad}px;width:${size}px;height:${size}px;border-radius:50%;background:rgba(255,255,255,.55);box-shadow:0 0 0 ${size * 0.05}px rgba(0,0,0,.18), 0 ${size * 0.06}px ${size * 0.2}px rgba(0,0,0,.25)"></div></body></html>`);
      const file = path.join(dir, "cursor-touch.png");
      await art.screenshot({ path: file as `${string}.png`, type: "png", omitBackground: true, clip: { x: 0, y: 0, width: side, height: side } });
      images.arrow = { file, hot: [pad + size / 2, pad + size / 2] };
    }
    for (const [kind, a] of touch ? [] : Object.entries(CURSOR_ART)) {
      const sc = size / a.box[1];
      const pw = Math.ceil(a.box[0] * sc + pad * 2);
      const ph = Math.ceil(size + pad * 2);
      await art.setViewport({ width: pw, height: ph, deviceScaleFactor: 1 });
      await art.setContent(`<html><body style="margin:0;background:transparent"><svg viewBox="0 0 ${a.box[0]} ${a.box[1]}" width="${a.box[0] * sc}" height="${size}" style="position:absolute;left:${pad}px;top:${pad}px;overflow:visible;filter:drop-shadow(0 ${size * 0.04}px ${size * 0.08}px rgba(0,0,0,.35))">${a.svg}</svg></body></html>`);
      const file = path.join(dir, `cursor-${kind}.png`);
      await art.screenshot({ path: file as `${string}.png`, type: "png", omitBackground: true, clip: { x: 0, y: 0, width: pw, height: ph } });
      images[kind] = { file, hot: [pad + a.hot[0] * sc, pad + a.hot[1] * sc] };
    }
    if (c.ripple) {
      const D = size * (touch ? 1.4 : 2.2);
      const rp = Math.ceil(size * 0.4);
      const side = Math.ceil(D + rp * 2);
      await art.setViewport({ width: side, height: side, deviceScaleFactor: 1 });
      await art.setContent(`<html><body style="margin:0;background:transparent"><div style="position:absolute;left:${rp}px;top:${rp}px;width:${D}px;height:${D}px;box-sizing:border-box;border-radius:50%;border:${Math.max(1, size * 0.1)}px solid rgba(255,255,255,.95);box-shadow:0 0 ${size * 0.2}px rgba(0,0,0,.25)"></div></body></html>`);
      const file = path.join(dir, "ripple.png");
      await art.screenshot({ path: file as `${string}.png`, type: "png", omitBackground: true, clip: { x: 0, y: 0, width: side, height: side } });
      ripple = { file };
    }
  } finally {
    await art.close().catch(() => undefined);
  }
  return { step: c.step, xs: c.xs, ys: c.ys, kinds: c.kinds.map(([t, kind]) => ({ t, kind })), clicks: c.clicks, images, ripple };
}

/** What the app drew, made into a WebM or a GIF as the usual export makes them. */
async function transcode(from: string, out: string, format: string, fps: number, transparent: boolean): Promise<void> {
  const args =
    format === "webm"
      ? ["-y", "-loglevel", "error", "-i", from, "-c:v", "libvpx-vp9", "-b:v", "0", "-crf", "26", "-row-mt", "1", "-pix_fmt", transparent ? "yuva420p" : "yuv420p", out]
      : ["-y", "-loglevel", "error", "-i", from, "-vf", `fps=${Math.min(fps, 20)},scale='min(960,iw)':-1:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=sierra2_4a`, "-loop", "0", out];
  await new Promise<void>((resolve, reject) => {
    const p = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    p.stderr.on("data", (d) => (err += d));
    p.on("error", reject);
    p.on("exit", (c) => (c === 0 ? resolve() : reject(new Error(`ffmpeg couldn't make the ${format} (${err.trim().split("\n").pop()})`))));
  });
}
