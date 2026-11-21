// App state, the engine API, toasts and saved preferences. The boards keep their own state (board-state.js).
import { useLayoutEffect, useReducer } from "preact/hooks";

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
    throw new Error("Lost connection to the engine. Choose File › Restart Engine, then try again.");
  }
  const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
  if (!res.ok || (data && data.error)) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}
export const fileUrl = (p, bust) => `/file?path=${encodeURIComponent(p)}${bust ? `&t=${bust}` : ""}`;
export const thumbUrl = (p, w = 360, bust) => `/thumb?path=${encodeURIComponent(p)}&w=${w}${bust ? `&t=${bust}` : ""}`;

// ---------------------------------------------------------------------------------------------
// Desktop bridge (present only inside the Mac app)

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
// Light or dark: the person's choice, or the Mac's ("system", following it as it changes)

const darkQuery = matchMedia("(prefers-color-scheme: dark)");
/** The theme showing now, "light" or "dark". */
export const themeNow = () => (document.documentElement.dataset.theme === "light" ? "light" : "dark");
export function applyTheme(pref = S.theme) {
  const light = pref === "light" || (pref !== "dark" && !darkQuery.matches);
  document.documentElement.dataset.theme = light ? "light" : "dark";
  document.documentElement.dataset.themePref = pref;
}
darkQuery.addEventListener?.("change", () => applyTheme());
/** Choose the theme: "system", "light" or "dark". The app's window follows it too. */
export function setTheme(pref) {
  const theme = pref === "light" || pref === "dark" ? pref : "system";
  set({ theme });
  applyTheme(theme);
  native?.call("setTheme", { theme }).catch(() => undefined);
  persistPrefs();
}

// ---------------------------------------------------------------------------------------------
// State

export const S = {
  ready: false,
  bootError: null,
  /** The board open, or null for Home. */
  boardId: null,
  boards: null,
  /** The engine's options: the built-in stickers and illustrations, the library folder. */
  opts: null,
  theme: "system",
  modal: null,
  menu: null,
  toasts: [],
  busy: null,
  /** First-run steps done (seen Home, imported something, connected an agent…), remembered. */
  touched: {},
  /** Home's view when chosen ("start" or "boards"); null decides by whether anything's been made. */
  homeView: null,
  /** After an import: the next step, shown on that board ({ board, name, kind }). */
  coach: null,
  /** Files being dragged over Home. */
  dropping: false,
  /** Image quality for generated pictures: "fast" or "best". */
  imageQuality: "fast",
};

const listeners = new Map();
let frame = 0;
/** Counts redraws, so a component can tell it missed one before it was listening. */
let version = 0;
/** What changed since the last frame: anything (a change made to S directly), or these keys. */
let changedAll = false;
const changed = new Set();
function notify(keys) {
  if (keys) for (const k of keys) changed.add(k);
  else changedAll = true;
  if (frame) return;
  frame = requestAnimationFrame(() => {
    frame = 0;
    version++;
    const all = changedAll;
    const keys = [...changed];
    changedAll = false;
    changed.clear();
    for (const [l, ignore] of listeners) if (all || !ignore || keys.some((k) => !ignore.has(k))) l();
  });
}
export function set(patch) {
  const p = typeof patch === "function" ? patch(S) : patch;
  Object.assign(S, p);
  // set({}) asks for a redraw of everything (something outside S changed).
  const keys = Object.keys(p ?? {});
  notify(keys.length ? keys : undefined);
}
/** Re-render the calling component whenever the store changes. */
export function useStore() {
  const [, force] = useReducer((n) => n + 1, 0);
  const seen = version;
  useLayoutEffect(() => {
    listeners.set(force, null);
    // A change that landed between drawing and listening (a fast boot) still gets drawn.
    if (version !== seen) force();
    return () => listeners.delete(force);
  }, []);
  return S;
}

// ---------------------------------------------------------------------------------------------
// Saved preferences

let persistTimer = 0;
const snapshot = () => ({ ui: { theme: S.theme, touched: S.touched, imageQuality: S.imageQuality } });
/** Save the preferences (debounced). */
export function persistPrefs() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistTimer = 0;
    api("/api/state", snapshot()).catch(() => undefined);
  }, 500);
}
addEventListener("pagehide", () => {
  if (!persistTimer) return;
  clearTimeout(persistTimer);
  fetch("/api/state", { method: "POST", keepalive: true, headers: { "x-screenshotter": "studio", "Content-Type": "application/json" }, body: JSON.stringify(snapshot()) }).catch(() => undefined);
});

export async function restore() {
  const saved = await api("/api/state").catch(() => ({}));
  const ui = saved.ui ?? {};
  const theme = ui.theme === "light" || ui.theme === "dark" ? ui.theme : "system";
  set({ theme, touched: ui.touched && typeof ui.touched === "object" ? ui.touched : {}, imageQuality: ui.imageQuality === "best" ? "best" : "fast" });
  applyTheme(theme);
}

/** Remember a first-run step as done. */
export function touch(key) {
  if (S.touched[key]) return;
  set({ touched: { ...S.touched, [key]: true } });
  persistPrefs();
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

export const sameList = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && JSON.stringify(a) === JSON.stringify(b);
export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
export const base = (p) => (p ? String(p).split("/").pop() : "");
export const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

/** "just now", "5 min ago", "3 hours ago", "yesterday", "Monday", "Sep 12". */
const dayStart = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
const daysAgo = (iso) => Math.round((dayStart(new Date()) - dayStart(new Date(iso))) / 86400000);
export function when(iso) {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  const days = daysAgo(iso);
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (days === 0) {
    const h = Math.round(s / 3600);
    return `${h} hour${h === 1 ? "" : "s"} ago`;
  }
  if (days === 1) return "yesterday";
  const d = new Date(iso);
  if (days < 7) return d.toLocaleDateString(undefined, { weekday: "long" });
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: d.getFullYear() === new Date().getFullYear() ? undefined : "numeric" });
}

// ---------------------------------------------------------------------------------------------
// Dialogs: a confirm and a one-line prompt, answered as promises.

let confirmResolve = null;
export function confirmDialog(opts) {
  return new Promise((resolve) => {
    confirmResolve?.(false);
    confirmResolve = resolve;
    set({ modal: { kind: "confirm", ...opts } });
  });
}
export function answerConfirm(ok) {
  const r = confirmResolve;
  confirmResolve = null;
  set({ modal: null });
  r?.(ok);
}
let promptResolve = null;
export function promptDialog(opts) {
  return new Promise((resolve) => {
    promptResolve?.(null);
    promptResolve = resolve;
    set({ modal: { kind: "prompt", ...opts } });
  });
}
export function answerPrompt(v) {
  const r = promptResolve;
  promptResolve = null;
  set({ modal: null });
  r?.(v === null ? null : String(v).trim() || null);
}
