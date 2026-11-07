// App state, the engine API, undo history and persistence.
import { useEffect, useReducer } from "preact/hooks";

// ---------------------------------------------------------------------------------------------
// Engine API

export async function api(path, body, raw) {
  const init =
    body === undefined
      ? {}
      : {
          method: "POST",
          headers: { "x-screenshotter": "studio", "Content-Type": raw ? "application/octet-stream" : "application/json" },
          body: raw ? body : JSON.stringify(body),
        };
  let res;
  try {
    res = await fetch(path, init);
  } catch {
    throw new Error("Lost connection to the Screenshotter engine. Choose File › Restart Engine, then try again.");
  }
  const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
  if (!res.ok || (data && data.error)) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}
export const fileUrl = (p, bust) => `/file?path=${encodeURIComponent(p)}${bust ? `&t=${bust}` : ""}`;
export const thumbUrl = (p, w = 360, bust) => `/thumb?path=${encodeURIComponent(p)}&w=${w}${bust ? `&t=${bust}` : ""}`;

// ---------------------------------------------------------------------------------------------
// Desktop bridge (present only inside Screenshotter.app)

const handler = window.webkit?.messageHandlers?.native;
export const native = handler
  ? {
      call: async (cmd, args = {}) => {
        const reply = await handler.postMessage({ cmd, ...args });
        if (reply && reply.error) throw new Error(reply.error);
        return reply;
      },
    }
  : null;
if (native) document.documentElement.classList.add("native");

// ---------------------------------------------------------------------------------------------
// State

export const DEFAULT_SCENE = { devices: [], background: "meadow-motion" };

export const S = {
  ready: false,
  bootError: null,
  opts: null,
  scene: DEFAULT_SCENE,
  sceneName: "Untitled design",
  /** The app's icon (a picture in the library), for the store page preview; null shows its initial. */
  appIcon: null,
  /** The app's name on the store page preview; null shows the design's name. */
  appName: null,
  /** The saved scene being edited (null until it has something in it). */
  sceneId: null,
  /**
   * A video of several shots: each { scene, length?, transition? }, and which one is on the canvas
   * (its scene is S.scene; the copy in the list is filled in when you switch). null for one design.
   */
  shots: null,
  shot: 0,
  /**
   * A design made at several sizes: each size's screens ({ name?, shots: [{ scene, … }] }), and which
   * size is on the canvas. That size's screens are `shots` (its entry here waits until another size
   * is opened). null for a design at one size.
   */
  groups: null,
  group: 0,
  /** Shots an AI change just touched, highlighted in the strip for a moment. */
  shotPulse: [],
  scenes: [],
  scenesOpen: false,
  /** When the open scene was last saved, as the library has it: a newer save by an agent gets picked up. */
  sceneStamp: null,
  /** Side panels: the inspector can be hidden too, each can be dragged wider, and focus mode hides both. */
  rightOpen: true,
  leftW: null,
  rightW: null,
  /** The timeline's height when dragged taller or shorter (null: the usual). */
  tlH: null,
  focusRestore: null,
  /** The full-window Scenes page, and how it lists them. */
  scenesPage: false,
  scenesPrefs: { sort: "edited", layout: "grid", kind: "all" },
  renaming: null,
  /** The Shapes panel: the colour new shapes take, and what a click on screen text adds. */
  shapeTint: "#ff3b30",
  shapeMark: "circle-it",
  /** Recipes: complete designs built from your screens (loaded at start). */
  recipes: [],
  /** "Design it for me": { busy, step, items: [{ name, summary, request, image }], error }. */
  directions: null,
  layout: null,
  layoutError: null,
  files: [],
  filesAt: 0,
  selected: null,
  hover: null,
  leftTab: "captures",
  // The left panel (things to add) opens from the rail; the right one (settings) is always there.
  leftOpen: false,
  busy: null,
  rendering: null,
  render: null,
  exportOpen: false,
  exportOpts: { tab: "image", format: "png", size: "full", width: 1080, jpegQuality: 90, video: { motion: "subtle", duration: 6, zoom: false, format: "mp4", screens: "all", picked: [], join: true }, set: { format: "png", folders: "size", sheets: true } },
  capture: { source: "simulator", simulator: "", bundleId: "", deepLink: "", appearance: "light", time: "9:41", grant: true, system: false, url: "", viewport: "iphone", scheme: "light", macWindow: "", more: false, frame: "device" },
  apps: { list: [], loading: false, for: "" },
  stillPick: null,
  /** A new design's first screenshot is in: pick how it starts, on a screen of its own. */
  starting: false,
  /** Animate: the timeline under the canvas, the selected animation, the rows chosen to animate. */
  timelineOpen: false,
  animSel: null,
  /** The chosen piece of sound on Animate's Sound row. */
  soundSel: null,
  /** The chosen part of the recording on the Footage row. */
  footageSel: null,
  animRows: [],
  playing: false,
  /** docked: Ask AI fills the right-hand panel instead of floating over the canvas. */
  // Docked by default: floating, it covered the design it's talking about.
  ai: { open: false, docked: true, busy: false, text: "", error: null, history: [], thread: [], model: "", engine: "", preview: true, context: true, last: null, imageQuality: "fast" },
  pulse: [],
  toasts: [],
  modal: null,
  jsonOpen: false,
  dropping: false,
  replacing: null,
  touched: { backdrop: false, moved: false, exported: false },
  past: [],
  future: [],
};

const listeners = new Set();
let frame = 0;
function notify() {
  if (frame) return;
  frame = requestAnimationFrame(() => {
    frame = 0;
    for (const l of listeners) l();
  });
}
export function set(patch) {
  Object.assign(S, typeof patch === "function" ? patch(S) : patch);
  notify();
}
/** Re-render the calling component whenever the store changes. */
export function useStore() {
  const [, force] = useReducer((n) => n + 1, 0);
  useEffect(() => {
    listeners.add(force);
    return () => listeners.delete(force);
  }, []);
  return S;
}

// ---------------------------------------------------------------------------------------------
// Scene changes, undo and layout

const clone = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));
let lastKey = null;
let lastAt = 0;

/** Clean empty values out so the request stays readable (and identical to what an agent would send). */
export function tidy(v) {
  if (Array.isArray(v)) return v.map(tidy);
  if (v && typeof v === "object") {
    const out = {};
    for (const [k, x] of Object.entries(v)) {
      if (x === undefined || x === null || x === "") continue;
      const t = tidy(x);
      if (t && typeof t === "object" && !Array.isArray(t) && !Object.keys(t).length) continue;
      out[k] = t;
    }
    return out;
  }
  return v;
}

/**
 * Replace the scene. `key` groups rapid edits of the same control (a slider drag, typing) into one
 * undo step.
 */
export function setScene(next, { key = null } = {}) {
  next = tidy(next);
  if (JSON.stringify(next) === JSON.stringify(S.scene)) return;
  const now = performance.now();
  const coalesce = key && key === lastKey && now - lastAt < 900;
  lastKey = key;
  lastAt = now;
  set({
    past: coalesce ? S.past : [...S.past.slice(-99), { screen: { ...where(), scene: S.scene } }],
    future: [],
    scene: next,
  });
  scheduleLayout();
  persist();
}

// ---------------------------------------------------------------------------------------------
// History. One for the whole design: each step is one screen's design as it was (and which screen
// and size it's on), or the whole design (every screen of every size) before a change across them.
// Undoing a step made on another screen goes to that screen.

/** The screen being edited: its size and its place in the size's screens. */
const where = () => ({ group: S.groups ? S.group : 0, shot: S.shots ? S.shot : 0 });
/** The whole design: every screen of every size, and which one is on the canvas. */
const designNow = () => ({ shots: allShots(), shot: S.shot, groups: allGroups(), group: S.group, scene: S.scene });

/**
 * Remember the whole design before a change across its screens or sizes (copying a style, adding a
 * size, moving a screen…), so ⌘Z puts it all back. Changes with the same `key` in quick succession
 * (dragging a shot's length) are one step.
 */
export function checkpoint(key = null) {
  const now = performance.now();
  const coalesce = key && key === lastKey && now - lastAt < 900;
  lastKey = key;
  lastAt = now;
  if (!coalesce) set({ past: [...S.past.slice(-99), { design: designNow() }], future: [] });
}

/** Put a remembered whole design back. */
function restoreDesign(d) {
  const groups = d.groups && d.groups.length > 1 ? d.groups : null;
  const shots = d.shots && d.shots.length > 1 ? d.shots : null;
  set({ groups, group: groups ? d.group : 0, shots, shot: shots ? Math.min(d.shot, shots.length - 1) : 0, scene: d.scene, selected: null, animSel: null, animRows: [] });
}

/** Put another screen on the canvas without touching the history (undo going to where a change was). */
function showScreen(group, shot) {
  if (S.groups && group !== S.group && S.groups[group]) {
    const groups = allGroups();
    const shots = groups[group].shots;
    set({ groups, group, shots: shots.length > 1 ? shots : null, shot: 0, scene: shots[0].scene });
  }
  const shots = allShots();
  if (shots && shot !== S.shot && shots[shot]) set({ shots, shot, scene: shots[shot].scene, selected: null, animSel: null, animRows: [] });
}

/** One step back or forward: `from` is the list taken from, `to` the one the present goes onto. */
function step(back) {
  const from = back ? S.past : S.future;
  if (!from.length) return;
  lastKey = null;
  const e = back ? from[from.length - 1] : from[0];
  const rest = back ? from.slice(0, -1) : from.slice(1);
  let mirror;
  if (e.design) {
    mirror = { design: designNow() };
    restoreDesign(e.design);
  } else {
    // A step from before history knew its screen is the one on the canvas.
    const { group, shot, scene } = e.screen ?? { ...where(), scene: e };
    showScreen(group, shot);
    mirror = { screen: { ...where(), scene: S.scene } };
    set({ scene });
  }
  set(back ? { past: rest, future: [mirror, ...S.future] } : { future: rest, past: [...S.past, mirror] });
  fixSelection();
  scheduleLayout(0);
  persist();
}

/** Edit the scene through a draft function: `edit(s => { s.devices[0].x = 0.4 }, "x")`. */
export function edit(fn, key) {
  const draft = clone(S.scene);
  fn(draft);
  setScene(draft, { key });
}

export const undo = () => step(true);
export const redo = () => step(false);
function fixSelection() {
  // A piece of sound is chosen by its place in the list, which an undo may have changed.
  if (S.soundSel != null || S.footageSel != null) set({ soundSel: null, footageSel: null });
  const s = S.selected;
  if (!s) return;
  const [kind, n] = s.split("-");
  if (kind === "device" && !S.scene.devices?.[n - 1]) set({ selected: null });
  if (kind === "text" && !S.scene.texts?.[n - 1]) set({ selected: null });
  if (s === "caption" && !S.scene.headline && !S.scene.subheadline) set({ selected: null });
}

let layoutTimer = 0;
let layoutSeq = 0;
export function scheduleLayout(delay = 40) {
  clearTimeout(layoutTimer);
  layoutTimer = setTimeout(fetchLayout, delay);
}
/**
 * Every screen's layout, remembered by its contents (the newest few): the set row draws the other
 * screens from it, and moving to one of them starts from the layout the row already had, so
 * neither waits on the engine (or flashes) while a fresh one comes.
 */
export const layoutCache = new Map();
export function rememberLayout(scene, layout) {
  if (!scene || !layout) return;
  const key = JSON.stringify(scene);
  layoutCache.delete(key);
  layoutCache.set(key, layout);
  if (layoutCache.size > 80) layoutCache.delete(layoutCache.keys().next().value);
}
export const knownLayout = (scene) => layoutCache.get(JSON.stringify(scene)) ?? null;

async function fetchLayout() {
  const mine = ++layoutSeq;
  // A design with nothing in it shows the start screen; one with only words or pictures, or a
  // screen of a set with no device yet, is still laid out (its backdrop and the rest).
  if (!hasDesign(S.scene) && !S.shots) {
    set({ layout: null, layoutError: null });
    return;
  }
  try {
    const scene = S.scene;
    const layout = await api("/api/layout", scene);
    rememberLayout(scene, layout);
    if (mine === layoutSeq) set({ layout, layoutError: null });
  } catch (e) {
    if (mine === layoutSeq) set({ layoutError: e.message });
  }
}

// ---------------------------------------------------------------------------------------------
// Persistence: the scene and preferences live in the output folder, so they survive restarts.

let persistTimer = 0;
const snapshot = () => ({
  scene: S.scene,
  sceneName: S.sceneName,
  appIcon: S.appIcon,
  appName: S.appName,
  sceneId: S.sceneId,
  shots: S.shots,
  shot: S.shot,
  groups: S.groups,
  group: S.group,
  ui: { leftTab: S.leftTab, leftOpen: S.leftOpen, exportOpts: S.exportOpts, capture: { ...S.capture, more: false }, aiModel: S.ai.model, aiEngine: S.ai.engine, aiPreview: S.ai.preview, imageQuality: S.ai.imageQuality, aiThread: S.ai.thread.slice(-60), aiHistory: S.ai.history.slice(-20), touched: S.touched, scenesPrefs: S.scenesPrefs, rightOpen: S.rightOpen, leftW: S.leftW, rightW: S.rightW, tlH: S.tlH, aiPanel: S.ai.docked ? "docked" : "floating", layoutV: 3 },
});
export function persist() {
  syncSpans();
  persistPrefs();
  scheduleSceneSave();
}

/**
 * The space between screenshots on the App Store (about 10 pt beside a 230 pt screenshot; 56 px
 * beside a 1290 px one), as a share of a screen's width. The Edit row and the previews leave it, so
 * the set looks as the store shows it. A device or backdrop across the set doesn't run on behind it:
 * each screen picks up exactly where the one before ends, so nothing is hidden in the gap (the store
 * shifts the rest sideways by it).
 */
export const STORE_GAP = 0.043;

/**
 * Keep a set's spans in step after any change: a backdrop across the set (every screen the
 * backdrop of the one being edited, each with its slice: `backgroundSpan`), and devices that carry
 * on into the neighbouring screens (drawn there, in their terms, as `spill`). Derived from the
 * screens, so it isn't an undo step of its own.
 */
/** A scene's height ÷ width, from its canvas (a preset, "WxH" or {width,height}) and orientation. */
export function canvasRatio(scene) {
  const c = scene?.canvas;
  let w = 0;
  let h = 0;
  if (c && typeof c === "object") [w, h] = [c.width, c.height];
  else if (typeof c === "string" && /^\d+x\d+$/i.test(c)) [w, h] = c.toLowerCase().split("x").map(Number);
  else if (typeof c === "string" && S.opts?.canvases?.[c]) [w, h] = [S.opts.canvases[c].width, S.opts.canvases[c].height];
  else if (typeof c === "string" && /^\d+:\d+$/.test(c)) [w, h] = c.split(":").map(Number);
  if (!w || !h) return S.layout ? S.layout.canvas.height / S.layout.canvas.width : 2.17;
  return scene.landscape ? Math.min(w, h) / Math.max(w, h) : h / w;
}

export function syncSpans() {
  const shots = allShots();
  if (!shots) {
    if (S.scene.backgroundSpan || S.scene.spill) set({ scene: tidy({ ...S.scene, backgroundSpan: undefined, spill: undefined }) });
    return;
  }
  const across = shots.some((x) => x.scene.backgroundSpan);
  // A set has one image size: screens that came in at another (from an agent, or a template) take
  // the first screen's, so the row lines up and devices carry across the same way on every screen.
  const size = { canvas: shots[0].scene.canvas, landscape: shots[0].scene.landscape };
  // Whether a device reaches past a side edge, from its height, its screen's shape and its kind's
  // proportions, erring wide (a copy that turns out to miss is dropped by the render).
  const wide = { mac: 1.55, ipad: 0.76, watch: 0.84 };
  const reaches = (d, scene) => {
    const fam = (S.opts?.devices ?? []).find((m) => m.name === d.device || m.aliases?.includes(d.device))?.family;
    const ratio = canvasRatio(scene);
    // Its width and height as fractions of the canvas's width, then the box its rotation turns it into.
    const tall = (d.height ?? 0.7) * ratio;
    const a = (Math.abs(d.rotate ?? 0) * Math.PI) / 180;
    const half = ((tall * (wide[fam] ?? 0.5) * Math.cos(a) + tall * Math.sin(a)) * 1.06) / 2;
    return d.x - half < 0 || d.x + half > 1;
  };
  let changed = false;
  const next = shots.map((x, i) => {
    const sc = { ...x.scene };
    if (JSON.stringify(sc.canvas) !== JSON.stringify(size.canvas) || Boolean(sc.landscape) !== Boolean(size.landscape)) {
      if (size.canvas === undefined) delete sc.canvas;
      else sc.canvas = size.canvas;
      if (size.landscape) sc.landscape = true;
      else delete sc.landscape;
    }
    if (across) {
      sc.background = S.scene.background;
      sc.backgroundSpan = { count: shots.length, index: i };
    } else delete sc.backgroundSpan;
    // A spanning device of the screen on the left is one screen to the left in this one's terms; of the one on the right, to the right.
    const spill = [];
    for (const j of [i - 1, i + 1])
      shots[j]?.scene.devices.forEach((d, k) => {
        // In a set, a device you've placed carries on into the screen beside it unless it's told not to.
        if (d.span !== false && typeof d.x === "number" && reaches(d, shots[j].scene)) spill.push(tidy({ ...d, x: r4(d.x + (j - i)), span: undefined, spillOf: { shot: j, device: k } }));
      });
    if (spill.length) sc.spill = spill;
    else delete sc.spill;
    if (JSON.stringify(sc) === JSON.stringify(x.scene)) return x;
    changed = true;
    return { ...x, scene: sc };
  });
  if (!changed) return;
  const was = S.scene;
  set({ shots: next, scene: next[S.shot].scene });
  // The screen on the canvas lent or borrowed a device (a neighbour moved, screens were reordered,
  // the design was reopened): lay it out again, or the canvas shows the copies where they were.
  if (S.scene !== was) scheduleLayout(0);
}
/** Save the app's state but not the scene: only a preference changed, not the design. */
export function persistPrefs() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistTimer = 0;
    api("/api/state", snapshot()).catch(() => undefined);
  }, 500);
}

// ---------------------------------------------------------------------------------------------
// Saved scenes: the scene you're editing saves itself as you work.

/** How one shot comes in from the one before, by name. */
export const TRANSITION_NAMES = {
  cut: "Cut",
  fade: "Crossfade",
  "fade-black": "Through black",
  "fade-white": "Through white",
  "push-left": "Push left",
  "push-right": "Push right",
  "push-up": "Push up",
  "push-down": "Push down",
  "wipe-left": "Wipe left",
  "wipe-right": "Wipe right",
  iris: "Iris",
  zoom: "Zoom",
  blur: "Blur",
  dissolve: "Dissolve",
};

/**
 * A screen has something to show: a screenshot, words, pictures or shapes. A screen of just a
 * headline and doodles is a screen like any other, to edit, preview and export.
 */
export const hasDesign = (sc) => Boolean(sc?.devices?.length || sc?.headline || sc?.subheadline || sc?.texts?.length || sc?.images?.length || sc?.shapes?.length);
const hasContent = hasDesign;

/** Every shot with its scene, the one on the canvas included (null for a single design). */
export function allShots() {
  if (!S.shots || S.shots.length < 2) return null;
  return S.shots.map((x, i) => (i === S.shot ? { ...x, scene: S.scene } : x));
}
/** The screens of the size on the canvas, each with its scene (one screen when it isn't a set). */
export function activeScreens() {
  return allShots() ?? [{ ...(S.shots?.[0] ?? {}), scene: S.scene }];
}
/** Every size of the design, the one on the canvas as it is now; null for a design at one size. */
export function allGroups() {
  if (!S.groups || S.groups.length < 2) return null;
  return S.groups.map((g, i) => (i === S.group ? { ...g, shots: activeScreens() } : g));
}
/**
 * What the library keeps: the first size's first screen as the design's scene, its screens as the
 * shots (the first without its scene), and every size when there are several.
 */
export function saveBody() {
  const groups = allGroups();
  const first = groups ? groups[0].shots : activeScreens();
  const shots = first.length > 1 ? first : null;
  return {
    id: S.sceneId ?? undefined,
    name: S.sceneName,
    appIcon: S.appIcon ?? null,
    appName: S.appName ?? null,
    scene: first[0].scene,
    shots: shots ? shots.map((x, i) => (i === 0 ? { name: x.name, length: x.length, transition: x.transition } : x)) : null,
    groups,
    chat: S.ai.thread.slice(-60),
  };
}
let sceneTimer = 0;
let saving = Promise.resolve();
function scheduleSceneSave() {
  clearTimeout(sceneTimer);
  sceneTimer = setTimeout(() => {
    sceneTimer = 0;
    saveSceneNow();
  }, 800);
}
/** Save the current scene now (creating it in the library the first time). Saves run in order. */
export function saveSceneNow() {
  clearTimeout(sceneTimer);
  sceneTimer = 0;
  const body = saveBody();
  if (!hasContent(body.scene)) return saving;
  const forScene = S.scene;
  saving = saving
    .then(() => api("/api/scenes/save", { ...body, id: S.sceneId ?? undefined }))
    .then((saved) => {
      // Still the same document? (It may have been swapped while the save was in flight.)
      if (S.scene === forScene || S.sceneId === null || S.sceneId === saved.id) {
        const others = S.scenes.filter((x) => x.id !== saved.id);
        set({ sceneId: S.sceneId ?? saved.id, sceneStamp: saved.updatedAt, scenes: [{ ...saved, at: Date.now() }, ...others] });
        if (!body.id) api("/api/state", snapshot()).catch(() => undefined);
      }
      return saved;
    })
    .catch(() => undefined);
  return saving;
}
/** A change to the scene is waiting to be saved. */
export const savePending = () => Boolean(sceneTimer);
export async function refreshScenes() {
  const scenes = await api("/api/scenes").catch(() => null);
  if (scenes) set({ scenes: scenes.map((x) => ({ ...x, at: Date.now() })) });
  return S.scenes;
}
/** Save a pending change right away (the window is closing or the app is quitting). */
export function flushPersist() {
  const headers = { "x-screenshotter": "studio", "Content-Type": "application/json" };
  const jobs = [];
  if (sceneTimer && hasContent(S.scene)) {
    clearTimeout(sceneTimer);
    sceneTimer = 0;
    jobs.push(fetch("/api/scenes/save", { method: "POST", keepalive: true, headers, body: JSON.stringify(saveBody()) }).catch(() => undefined));
  }
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = 0;
    jobs.push(fetch("/api/state", { method: "POST", keepalive: true, headers, body: JSON.stringify(snapshot()) }).catch(() => undefined));
  }
  return Promise.all(jobs).then(() => undefined);
}
addEventListener("pagehide", () => flushPersist());

export async function restore() {
  const saved = await api("/api/state").catch(() => ({}));
  const ui = saved.ui ?? {};
  const patch = {};
  if (saved.scene && Array.isArray(saved.scene.devices)) patch.scene = saved.scene;
  if (Array.isArray(saved.shots) && saved.shots.length > 1) Object.assign(patch, { shots: saved.shots, shot: Math.min(saved.shots.length - 1, Math.max(0, saved.shot ?? 0)) });
  if (Array.isArray(saved.groups) && saved.groups.length > 1) Object.assign(patch, { groups: saved.groups, group: Math.min(saved.groups.length - 1, Math.max(0, saved.group ?? 0)) });
  if (saved.sceneName) patch.sceneName = saved.sceneName;
  if (typeof saved.appIcon === "string") patch.appIcon = saved.appIcon;
  if (typeof saved.appName === "string") patch.appName = saved.appName;
  if (saved.sceneId) patch.sceneId = saved.sceneId;
  // Tabs that were merged or moved: Shapes joined Text; Layers and Exports left the rail.
  // Text and Shapes were one panel for a while, with a switch between them (addTab).
  if (ui.leftTab) patch.leftTab = ui.leftTab === "text" && ui.addTab === "shapes" ? "shapes" : ({ layers: "captures", exports: "captures" }[ui.leftTab] ?? ui.leftTab);
  // Which panels are open is remembered; the simpler layout (3) opens the settings panel once for everyone.
  if (ui.layoutV >= 2 && typeof ui.leftOpen === "boolean") patch.leftOpen = ui.leftOpen;
  if (ui.layoutV >= 3 && typeof ui.rightOpen === "boolean") patch.rightOpen = ui.rightOpen;
  if (Number.isFinite(ui.leftW)) patch.leftW = ui.leftW;
  if (Number.isFinite(ui.rightW)) patch.rightW = ui.rightW;
  if (Number.isFinite(ui.tlH)) patch.tlH = ui.tlH;
  if (ui.exportOpts) patch.exportOpts = { ...S.exportOpts, ...ui.exportOpts, video: { ...S.exportOpts.video, ...(ui.exportOpts.video ?? {}) }, set: { ...S.exportOpts.set, ...(ui.exportOpts.set ?? {}) } };
  if (ui.capture) patch.capture = { ...S.capture, ...ui.capture };
  patch.ai = { ...S.ai, model: ui.aiModel ?? "", engine: ui.aiEngine === "codex" || ui.aiEngine === "claude" ? ui.aiEngine : "", preview: ui.aiPreview !== false, imageQuality: ui.imageQuality === "best" ? "best" : "fast", // aiPanel replaced aiDocked when docked became the default (aiDocked had saved the old default).
    docked: ui.aiPanel !== "floating", history: ui.aiHistory ?? [], thread: Array.isArray(ui.aiThread) ? ui.aiThread : [] };
  if (ui.touched) patch.touched = { ...S.touched, ...ui.touched };
  if (ui.scenesPrefs) patch.scenesPrefs = { ...S.scenesPrefs, ...ui.scenesPrefs };
  set(patch);
  // A set saved before its spans were kept in step (or by an agent) gets them now.
  syncSpans();
}

// ---------------------------------------------------------------------------------------------
// Files

export async function refreshFiles() {
  const files = await api("/api/files");
  set({ files, filesAt: Date.now() });
  return files;
}

// ---------------------------------------------------------------------------------------------
// Toasts and busy state

let toastId = 0;
export function toast(t) {
  const id = ++toastId;
  const item = { id, kind: "ok", timeout: t.kind === "err" ? 9000 : 5200, ...t };
  set({ toasts: [...S.toasts.slice(-3), item] });
  if (item.timeout) setTimeout(() => dismiss(id), item.timeout);
  return id;
}
export function dismiss(id) {
  const t = S.toasts.find((x) => x.id === id);
  if (!t || t.leaving) return;
  t.leaving = true;
  set({ toasts: [...S.toasts] });
  setTimeout(() => set({ toasts: S.toasts.filter((x) => x.id !== id) }), 200);
}
export const fail = (e, title = "Something went wrong") => toast({ kind: "err", title, text: e?.message ?? String(e) });

/** Run a long task with the activity pill showing. Only one at a time. */
export async function task(label, fn) {
  if (S.busy) {
    toast({ kind: "warn", title: "One moment", text: `${S.busy.label} is still running.` });
    return undefined;
  }
  set({ busy: { label, at: Date.now() } });
  try {
    return await fn();
  } catch (e) {
    fail(e, label.replace(/…$/, "") + " failed");
    return undefined;
  } finally {
    set({ busy: null });
  }
}

// ---------------------------------------------------------------------------------------------
// Helpers

/** Remember a first-time action for the getting-started checklist. */
export function touch(key) {
  if (S.touched[key]) return;
  set({ touched: { ...S.touched, [key]: true } });
  persist();
}

export const r4 = (v) => Math.round(v * 10000) / 10000;
export const base = (p) => (p ? String(p).split("/").pop() : "");
export const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
export const isVideo = (p) => /\.(mp4|mov|webm)$/i.test(p ?? "");
export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** Image generators by the names people know them by. */
/**
 * Which AI Ask AI uses: what the person chose in Settings, else Claude when it's set up (an API key
 * or Claude Code), else Codex.
 */
export function aiEngine() {
  if (S.ai.engine === "codex" || S.ai.engine === "claude") return S.ai.engine;
  const st = S.opts?.ai;
  return st && !st.provider && st.codex ? "codex" : "claude";
}
/** The AI's name in the interface: "Claude" or "Codex". */
export const aiName = () => (aiEngine() === "codex" ? "Codex" : "Claude");
/** Where it runs, for the chat's head and the thinking step: "Claude Code", a Claude model, or "Codex". */
export function aiVia() {
  const st = S.opts?.ai;
  if (aiEngine() === "codex") return st?.codexModel ? `Codex · ${st.codexModel}` : "Codex";
  return st?.provider === "api" ? S.ai.model || st.model : st?.provider === "claude-code" ? "Claude Code" : "";
}
export const IMAGE_PROVIDERS = { openai: "OpenAI", gemini: "Gemini", replicate: "Replicate", fal: "fal" };

/** Where the canvas finds a picture: a built-in sticker ("sticker:heart") or a file. */
export const pictureUrl = (src) => {
  if (/^sticker:/i.test(src ?? "")) return `/ui/stickers/${src.slice(8).toLowerCase()}.svg`;
  if (/^art:/i.test(src ?? "")) return `/ui/art/${src.slice(4).toLowerCase()}.svg`;
  // A built-in by its file (as the engine's layout names it): served with the UI, not as a file.
  const builtIn = /[\\/]studio[\\/]ui[\\/](stickers|art)[\\/]([\w-]+\.svg)$/i.exec(src ?? "");
  return builtIn ? `/ui/${builtIn[1]}/${builtIn[2]}` : fileUrl(src);
};

/** A picture's own name, without the timestamp the library adds: "logo-20261002-082507-857.svg" is "Logo". */
export function pictureName(src) {
  if (/^sticker:/i.test(src ?? "")) return `${src[8].toUpperCase()}${src.slice(9)} sticker`;
  if (/^art:/i.test(src ?? "")) return `${src[4].toUpperCase()}${src.slice(5).replace(/-/g, " ")}`;
  const name = String(src ?? "").split("/").pop().replace(/\.[a-z0-9]+$/i, "").replace(/-\d{8}-\d{6}(-\d{3})?$/, "").replace(/[-_]+/g, " ").trim();
  return name ? name[0].toUpperCase() + name.slice(1, 28) : "Image";
}

export function entityLabel(id, scene = S.scene, layout = S.layout) {
  if (!id) return "";
  if (id === "caption") return "Headline";
  const [kind, n] = id.split("-");
  if (kind === "text") return (scene.texts?.[n - 1]?.text || "Text").replace(/\*\*/g, "").slice(0, 28);
  if (kind === "image") {
    const b = scene.images?.[n - 1];
    if (!b) return "Image";
    if (b.mask === "icon") return "App icon";
    if (b.sticker) return "Sticker";
    return pictureName(b.src);
  }
  if (kind === "shape") {
    const sh = scene.shapes?.[n - 1];
    const e = layout?.entities.find((x) => x.id === id)?.shape;
    if (!sh) return "Shape";
    if (sh.type === "badge") return `Number ${e?.label ?? sh.label ?? ""}`.trim();
    if (sh.type === "ellipse") return (e?.sketch ?? sh.sketch) && (e?.fill ?? sh.fill ?? "none") === "none" ? "Circled" : (e?.aspect ?? sh.aspect ?? 1.5) === 1 ? "Circle" : "Ellipse";
    if (sh.type === "rect") return (e?.fill ?? sh.fill ?? "none") === "none" ? "Box" : (e?.radius ?? sh.radius) >= 0.5 ? "Pill" : "Rectangle";
    if (sh.type === "laurel") return (sh.text ?? "Laurel").replace(/\\n|\n/g, " ").slice(0, 28) || "Laurel";
    if (sh.type === "rating") return `Rating ${sh.value ?? 5}`;
    if (["burst", "ribbon", "bubble", "tag"].includes(sh.type)) return (sh.text ?? { burst: "NEW", ribbon: "Try it free", bubble: "So easy!", tag: "FREE" }[sh.type]).replace(/\\n|\n/g, " ").slice(0, 28);
    return { arrow: "Arrow", line: "Line", triangle: "Triangle", star: "Star" }[sh.type] ?? "Shape";
  }
  if (kind === "device") {
    const e = layout?.entities.find((x) => x.id === id);
    const d = scene.devices?.[n - 1];
    // A name of its own (a recording's layers: "Recording", "Webcam").
    if (d?.label) return d.label;
    if (d?.frame && d.frame !== "device") return { browser: "Browser", window: "Window", card: "Screen only", none: "Screenshot" }[d.frame];
    return e?.device || d?.device || `Device ${n}`;
  }
  return id;
}
