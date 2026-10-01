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
    throw new Error("Lost connection to the Screenshotter engine.");
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
  /** The saved scene being edited (null until it has something in it). */
  sceneId: null,
  /**
   * A video of several shots: each { scene, length?, transition? }, and which one is on the canvas
   * (its scene is S.scene; the copy in the list is filled in when you switch). null for one design.
   */
  shots: null,
  shot: 0,
  /** Shots an AI change just touched, highlighted in the strip for a moment. */
  shotPulse: [],
  scenes: [],
  scenesOpen: false,
  /** When the open scene was last saved, as the library has it: a newer save by an agent gets picked up. */
  sceneStamp: null,
  /** Side panels: the inspector can be hidden too, each can be dragged wider, and focus mode hides both. */
  rightOpen: false,
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
  view: "canvas",
  leftTab: "captures",
  // Both side panels start tucked away: the design has the window, and a panel opens when asked for.
  leftOpen: false,
  /** A new design's first steps: "design" (pick a template), "headline" (write it), "export". */
  guide: null,
  busy: null,
  rendering: null,
  render: null,
  renderStale: false,
  exportOpen: false,
  exportOpts: { tab: "image", format: "png", size: "full", width: 1080, jpegQuality: 90, video: { motion: "subtle", duration: 6, zoom: false, format: "mp4" } },
  capture: { source: "simulator", simulator: "", bundleId: "", deepLink: "", appearance: "light", time: "9:41", grant: true, system: false, url: "", viewport: "iphone", scheme: "light", macWindow: "", more: false },
  apps: { list: [], loading: false, for: "" },
  stillPick: null,
  /** Animate: the timeline under the canvas, the selected animation, the rows chosen to animate. */
  timelineOpen: false,
  animSel: null,
  animRows: [],
  playing: false,
  /** docked: Ask AI fills the right-hand panel instead of floating over the canvas. */
  ai: { open: false, docked: false, busy: false, text: "", error: null, history: [], thread: [], model: "", engine: "", preview: true, context: true, last: null, imageQuality: "fast" },
  pulse: [],
  toasts: [],
  modal: null,
  jsonOpen: false,
  dropping: false,
  replacing: null,
  guideDone: false,
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
export function setScene(next, { key = null, keepRender = false } = {}) {
  next = tidy(next);
  if (JSON.stringify(next) === JSON.stringify(S.scene)) return;
  const now = performance.now();
  const coalesce = key && key === lastKey && now - lastAt < 900;
  lastKey = key;
  lastAt = now;
  set({
    past: coalesce ? S.past : [...S.past.slice(-99), S.scene],
    future: [],
    scene: next,
    renderStale: keepRender ? S.renderStale : Boolean(S.render),
  });
  scheduleLayout();
  persist();
}

/** Edit the scene through a draft function: `edit(s => { s.devices[0].x = 0.4 }, "x")`. */
export function edit(fn, key) {
  const draft = clone(S.scene);
  fn(draft);
  setScene(draft, { key });
}

export function undo() {
  if (!S.past.length) return;
  lastKey = null;
  set({ future: [S.scene, ...S.future], scene: S.past[S.past.length - 1], past: S.past.slice(0, -1), renderStale: Boolean(S.render) });
  fixSelection();
  scheduleLayout();
  persist();
}
export function redo() {
  if (!S.future.length) return;
  lastKey = null;
  set({ past: [...S.past, S.scene], scene: S.future[0], future: S.future.slice(1), renderStale: Boolean(S.render) });
  fixSelection();
  scheduleLayout();
  persist();
}
function fixSelection() {
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
async function fetchLayout() {
  const mine = ++layoutSeq;
  if (!S.scene.devices?.length) {
    set({ layout: null, layoutError: null });
    return;
  }
  try {
    const layout = await api("/api/layout", S.scene);
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
  sceneId: S.sceneId,
  shots: S.shots,
  shot: S.shot,
  ui: { leftTab: S.leftTab, leftOpen: S.leftOpen, exportOpts: S.exportOpts, capture: { ...S.capture, more: false }, aiModel: S.ai.model, aiEngine: S.ai.engine, aiPreview: S.ai.preview, imageQuality: S.ai.imageQuality, aiThread: S.ai.thread.slice(-60), aiHistory: S.ai.history.slice(-20), guideDone: S.guideDone, touched: S.touched, scenesPrefs: S.scenesPrefs, rightOpen: S.rightOpen, leftW: S.leftW, rightW: S.rightW, tlH: S.tlH, aiDocked: S.ai.docked, layoutV: 2 },
});
export function persist() {
  persistPrefs();
  scheduleSceneSave();
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

const hasContent = (sc) => Boolean(sc?.devices?.length || sc?.headline || sc?.texts?.length);

/** Every shot with its scene, the one on the canvas included (null for a single design). */
export function allShots() {
  if (!S.shots || S.shots.length < 2) return null;
  return S.shots.map((x, i) => (i === S.shot ? { ...x, scene: S.scene } : x));
}
/** What the library keeps: the first shot as the design's scene, and the shots (the first without its scene). */
export function saveBody() {
  const shots = allShots();
  return {
    id: S.sceneId ?? undefined,
    name: S.sceneName,
    scene: shots ? shots[0].scene : S.scene,
    shots: shots ? shots.map((x, i) => (i === 0 ? { length: x.length, transition: x.transition } : x)) : null,
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
  if (saved.sceneName) patch.sceneName = saved.sceneName;
  if (saved.sceneId) patch.sceneId = saved.sceneId;
  // Tabs that were merged or moved: Shapes joined Text; Layers and Exports left the rail.
  // Text and Shapes were one panel for a while, with a switch between them (addTab).
  if (ui.leftTab) patch.leftTab = ui.leftTab === "text" && ui.addTab === "shapes" ? "shapes" : ({ layers: "captures", exports: "captures" }[ui.leftTab] ?? ui.leftTab);
  // Which panels are open is remembered from the layout with closed-by-default panels onward.
  if (ui.layoutV === 2) {
    if (typeof ui.leftOpen === "boolean") patch.leftOpen = ui.leftOpen;
    if (typeof ui.rightOpen === "boolean") patch.rightOpen = ui.rightOpen;
  }
  if (Number.isFinite(ui.leftW)) patch.leftW = ui.leftW;
  if (Number.isFinite(ui.rightW)) patch.rightW = ui.rightW;
  if (Number.isFinite(ui.tlH)) patch.tlH = ui.tlH;
  if (ui.exportOpts) patch.exportOpts = { ...S.exportOpts, ...ui.exportOpts, video: { ...S.exportOpts.video, ...(ui.exportOpts.video ?? {}) } };
  if (ui.capture) patch.capture = { ...S.capture, ...ui.capture };
  patch.ai = { ...S.ai, model: ui.aiModel ?? "", engine: ui.aiEngine === "codex" || ui.aiEngine === "claude" ? ui.aiEngine : "", preview: ui.aiPreview !== false, imageQuality: ui.imageQuality === "best" ? "best" : "fast", docked: ui.aiDocked === true, history: ui.aiHistory ?? [], thread: Array.isArray(ui.aiThread) ? ui.aiThread : [] };
  if (typeof ui.guideDone === "boolean") patch.guideDone = ui.guideDone;
  // Someone who used the app before this layout has done the first steps already.
  if (saved.ui && ui.layoutV !== 2) patch.guideDone = true;
  if (ui.touched) patch.touched = { ...S.touched, ...ui.touched };
  if (ui.scenesPrefs) patch.scenesPrefs = { ...S.scenesPrefs, ...ui.scenesPrefs };
  set(patch);
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

export function entityLabel(id, scene = S.scene, layout = S.layout) {
  if (!id) return "";
  if (id === "caption") return "Headline";
  const [kind, n] = id.split("-");
  if (kind === "text") return (scene.texts?.[n - 1]?.text || "Text").replace(/\*\*/g, "").slice(0, 28);
  if (kind === "shape") {
    const sh = scene.shapes?.[n - 1];
    const e = layout?.entities.find((x) => x.id === id)?.shape;
    if (!sh) return "Shape";
    if (sh.type === "badge") return `Number ${e?.label ?? sh.label ?? ""}`.trim();
    if (sh.type === "ellipse") return (e?.sketch ?? sh.sketch) && (e?.fill ?? sh.fill ?? "none") === "none" ? "Circled" : (e?.aspect ?? sh.aspect ?? 1.5) === 1 ? "Circle" : "Ellipse";
    if (sh.type === "rect") return (e?.fill ?? sh.fill ?? "none") === "none" ? "Box" : (e?.radius ?? sh.radius) >= 0.5 ? "Pill" : "Rectangle";
    return { arrow: "Arrow", line: "Line", triangle: "Triangle", star: "Star" }[sh.type] ?? "Shape";
  }
  if (kind === "device") {
    const e = layout?.entities.find((x) => x.id === id);
    const d = scene.devices?.[n - 1];
    if (d?.frame && d.frame !== "device") return { browser: "Browser", window: "Window", card: "Card", none: "Screenshot" }[d.frame];
    return e?.device || d?.device || `Device ${n}`;
  }
  return id;
}
