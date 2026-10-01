// Everything the UI can do to the scene or the engine, shared by panels, canvas, keys and menus.
import { timelineEnd } from "./animate.js";
import { DEFAULT_SCENE, S, TRANSITION_NAMES, activeScreens, aiEngine, aiName, allGroups, allShots, api, base, edit, entityLabel, fail, isVideo, native, persist, persistPrefs, r4, refreshFiles, refreshScenes, savePending, saveSceneNow, scheduleLayout, set, setScene, task, tidy, toast, touch, undo } from "./store.js";

const clone = (v) => JSON.parse(JSON.stringify(v));
const idx = (id) => Number(String(id).split("-")[1]) - 1;

// ---------------------------------------------------------------------------------------------
// Devices

/** A recording that belongs to a poster frame (same name, .mp4). */
export function recordingFor(p) {
  // A recording's own still is <name>.png; one picked for a design is <name>.still-<ms>.png.
  const stem = p.replace(/\.still-\d+\.png$/i, "").replace(/\.(png|jpe?g|webp)$/i, "");
  return S.files.find((f) => f.path === `${stem}.mp4` || f.path === `${stem}.mov`)?.path;
}

// ---------------------------------------------------------------------------------------------
// Designs: recipes (complete designs built from your screens) and "Design it for me".

/** What a recipe is built from: the scene's screens (and recordings) and its words. */
export const recipeInput = (scene = S.scene) => ({
  devices: (scene.devices ?? []).filter((d) => d.screenshot).map((d) => (d.video ? { screenshot: d.screenshot, video: d.video } : { screenshot: d.screenshot })),
  ...(scene.headline ? { headline: scene.headline } : {}),
  ...(scene.subheadline ? { subheadline: scene.subheadline } : {}),
});

/** Apply a recipe to the current screens: one undo step. */
// The latest template asked for wins: an earlier, slower answer never lands on top of it.
let recipeAsk = 0;
export async function applyRecipe(id, { quiet = false, silent = false } = {}) {
  const body = recipeInput();
  if (!body.devices.length) return toast({ kind: "warn", title: "Add a screenshot first", text: "Templates are made from your own screenshot." });
  const ask = ++recipeAsk;
  try {
    const { scene } = await api("/api/recipe", { id, ...body });
    if (ask !== recipeAsk) return;
    // A template with no headline of its own keeps the one already written.
    if (body.headline && !scene.headline) Object.assign(scene, { headline: body.headline, subheadline: body.subheadline });
    setScene(scene);
    touch("backdrop");
    set({ view: "canvas", selected: null });
    const name = S.recipes?.find((r) => r.id === id)?.name ?? "the design";
    // While the person is trying templates one after another, the canvas is the feedback.
    if (!silent) toast({ kind: "ok", title: quiet ? `Started you off with ${name}` : `Applied ${name}`, text: quiet ? "Undo (⌘Z) for a plain layout, or pick another in Templates." : "Undo (⌘Z) goes back.", timeout: 3200 });
  } catch (e) {
    fail(e, "Couldn't apply that template");
  }
}

/** Ask Claude for three directions, each rendered, to pick from. */
let directionsStop = null;
export const stopDesignForMe = () => directionsStop?.abort();
export async function designForMe() {
  if (!S.scene.devices.length) return toast({ kind: "warn", title: "Add a screenshot first" });
  if (S.directions?.busy) return;
  const started = Date.now();
  const stop = (directionsStop = new AbortController());
  set({ directions: { busy: true, step: "look", stepAt: started, started, items: [], error: null } });
  try {
    const res = await fetch("/api/ai-directions", {
      method: "POST",
      headers: { "x-screenshotter": "studio", "Content-Type": "application/json" },
      body: JSON.stringify({ request: S.scene, ...aiChoice(), preview: S.ai.preview !== false }),
      signal: stop.signal,
    });
    if (!res.ok || !res.body) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        const ev = JSON.parse(line);
        if (ev.type === "progress" && !(ev.step === "look" && ev.image)) {
          const step = ev.step === "check" ? "render" : ev.step;
          if (step !== S.directions.step) set({ directions: { ...S.directions, step, stepAt: Date.now(), provider: ev.provider ?? S.directions.provider } });
        }
        else if (ev.type === "error") throw new Error(ev.error);
        else if (ev.type === "result") {
          set({ directions: { busy: false, items: ev.directions, took: Math.round((Date.now() - started) / 1000), base: S.scene } });
          return;
        }
      }
    }
    throw new Error("It stopped before it finished. Try again.");
  } catch (e) {
    set({ directions: { busy: false, items: [], error: stop.signal.aborted ? null : e.message } });
  } finally {
    if (directionsStop === stop) directionsStop = null;
  }
}

/** Use one of the directions: one undo step. */
export function applyDirection(i) {
  const d = S.directions?.items?.[i];
  if (!d) return;
  setScene(d.request);
  touch("backdrop");
  set({ view: "canvas", selected: null, directions: { ...S.directions, picked: i } });
  toast({ kind: "ok", title: d.name, text: "Undo (⌘Z) goes back, or pick another.", timeout: 2600 });
}

export function addDevice(path, at = {}) {
  const d = { screenshot: path };
  const video = at.video ?? recordingFor(path);
  if (video) d.video = video;
  if (at.frame) d.frame = at.frame;
  if (at.x !== undefined) Object.assign(d, { x: at.x, y: at.y, anchor: "center" });
  const next = clone(S.scene);
  next.devices = [...(next.devices ?? []), d].slice(0, 8);
  if (at.x !== undefined && next.devices.length > 1 && !d.height) {
    const first = S.layout?.entities.find((e) => e.kind === "device");
    if (first) d.height = r4(first.height);
  }
  // A fresh scene's first screen starts from a design that works, not a plain layout.
  const pristine = !S.scene.devices?.length && !S.scene.headline && !S.scene.layout && !S.scene.effects && S.scene.background === DEFAULT_SCENE.background && at.x === undefined && !at.frame;
  setScene(next);
  set({ selected: `device-${next.devices.length}`, view: "canvas", replacing: null });
  // A recording: first choose the moment it shows (its first frame is often blank).
  if (video) openStills(`device-${next.devices.length}`);
  if (pristine) {
    // A new design starts from a finished one, and offers a few others to choose from.
    set({ guide: "design", guidePick: "bold-hero", selected: null, designing: true });
    return applyRecipe("bold-hero", { silent: true }).finally(() => set({ designing: false }));
  }
}

// ---------------------------------------------------------------------------------------------
// A recording's still: the moment a device shows in images and on the canvas, picked from a
// handful the engine finds in the recording. The picker sits under the canvas.

/** Open the picker for a device that plays a recording. */
export function openStills(id) {
  const d = S.scene.devices[idx(id)];
  if (!d?.video) return;
  set({ stillPick: { id, video: d.video, before: d.screenshot } });
}

/** Show the moment at `t` seconds on the device (one undo step however many you try). */
export async function pickStill(t) {
  const p = S.stillPick;
  if (!p) return;
  set({ stillPick: { ...p, busy: t } });
  try {
    const r = await api("/api/still", { video: p.video, t });
    if (S.stillPick?.video !== p.video) return;
    const i = idx(p.id);
    edit((d) => {
      if (d.devices[i]?.video === p.video) d.devices[i].screenshot = r.path;
    }, `still${i}`);
    set({ stillPick: { ...S.stillPick, busy: null } });
  } catch (e) {
    set({ stillPick: S.stillPick && { ...S.stillPick, busy: null } });
    fail(e, "Couldn't use that moment");
  }
}

/** Close the picker; Cancel puts back the still the device had before. */
export function closeStills(cancel = false) {
  const p = S.stillPick;
  if (!p) return;
  const i = idx(p.id);
  if (cancel && S.scene.devices[i]?.video === p.video && S.scene.devices[i].screenshot !== p.before) {
    edit((d) => {
      d.devices[i].screenshot = p.before;
    });
  }
  set({ stillPick: null });
}

/** Bring in the sample screenshot (a made-up recipe app), for trying the app with nothing to hand. */
export async function trySample() {
  try {
    const { path } = await api("/api/sample", {});
    await refreshFiles();
    return addDevice(path);
  } catch (e) {
    fail(e, "Couldn't load the sample");
  }
}

/** Put a capture on the selected device, or start the scene with it. */
export function useCapture(path, { frame, video } = {}) {
  const sel = S.replacing ?? S.selected;
  if (!S.scene.devices.length) return addDevice(path, { frame, video });
  const i = sel?.startsWith("device-") ? idx(sel) : 0;
  edit((d) => {
    const dev = d.devices[i] ?? d.devices[0];
    dev.screenshot = path;
    const rec = video ?? recordingFor(path);
    if (rec) dev.video = rec;
    else delete dev.video;
    if (frame) {
      dev.frame = frame === "device" ? undefined : frame;
      if (frame !== "device") delete dev.device;
    }
  });
  const id = `device-${Math.min(i, S.scene.devices.length - 1) + 1}`;
  set({ selected: id, replacing: null, view: "canvas" });
  if (S.scene.devices[idx(id)]?.video) openStills(id);
}

export function replaceMode(id) {
  set({ replacing: id, selected: id, leftTab: "captures", leftOpen: true });
  toast({ kind: "ok", icon: "replace", title: `Choose a capture for ${entityLabel(id)}`, text: "Click any capture in the library, or drag one onto the device.", timeout: 4000 });
}

export function deleteEntity(id) {
  if (!id) return;
  if (id === "caption") {
    edit((d) => {
      delete d.headline;
      delete d.subheadline;
    });
  } else if (id.startsWith("device-")) {
    edit((d) => d.devices.splice(idx(id), 1));
  } else if (id.startsWith("text-")) {
    edit((d) => d.texts.splice(idx(id), 1));
  } else if (id.startsWith("shape-")) {
    edit((d) => {
      d.shapes.splice(idx(id), 1);
      if (!d.shapes.length) delete d.shapes;
    });
  }
  set({ selected: null });
}

export function duplicateEntity(id) {
  if (!id || id === "caption") return;
  const e = S.layout?.entities.find((x) => x.id === id);
  if (id.startsWith("device-")) {
    if (S.scene.devices.length >= 8) return toast({ kind: "warn", title: "Eight devices is the limit" });
    edit((d) => {
      const copy = clone(d.devices[idx(id)]);
      if (e) Object.assign(copy, { x: r4(e.x + 0.06), y: r4(e.y + 0.03), anchor: "center", height: r4(e.height) });
      delete copy.width;
      d.devices.push(copy);
    });
    set({ selected: `device-${S.scene.devices.length}` });
  } else if (id.startsWith("shape-")) {
    // The copy sits a little down and right, free of any target, with the next number on a badge.
    const g = e?.shape;
    edit((d) => {
      const copy = clone(d.shapes[idx(id)]);
      delete copy.around;
      delete copy.at;
      if (g && (g.type === "arrow" || g.type === "line")) {
        copy.from = { x: r4(g.from.x + 0.03), y: r4(g.from.y + 0.03) };
        copy.to = { x: r4(g.to.x + 0.03), y: r4(g.to.y + 0.03) };
        copy.bend = g.bend;
      } else if (g) {
        Object.assign(copy, { x: r4(g.x + 0.03), y: r4(g.y + 0.03), size: r4(g.size), aspect: Math.round(g.aspect * 1000) / 1000 });
        if (g.rotate) copy.rotate = g.rotate;
      }
      if (copy.type === "badge" && /^\d+$/.test(g?.label ?? copy.label ?? "")) copy.label = String(Number(g?.label ?? copy.label) + 1);
      d.shapes.push(copy);
    });
    set({ selected: `shape-${S.scene.shapes.length}` });
  } else {
    edit((d) => {
      const copy = clone(d.texts[idx(id)]);
      copy.x = r4((e?.x ?? copy.x ?? 0.5) + 0.03);
      copy.y = r4((e?.y ?? copy.y ?? 0.1) + 0.03);
      d.texts.push(copy);
    });
    set({ selected: `text-${S.scene.texts.length}` });
  }
}

/** Raise or lower an entity. Devices and texts share one z order with the caption at 30. */
export function moveZ(id, dir) {
  const ents = S.layout?.entities ?? [];
  const e = ents.find((x) => x.id === id);
  if (!e) return;
  const zs = ents.filter((x) => x.id !== id).map((x) => x.z);
  const above = zs.filter((z) => z > e.z).sort((a, b) => a - b);
  const below = zs.filter((z) => z < e.z).sort((a, b) => b - a);
  const z = dir > 0 ? (above.length ? above[0] + 1 : e.z) : below.length ? below[0] - 1 : e.z;
  if (z === e.z) return;
  edit((d) => {
    if (id.startsWith("device-")) d.devices[idx(id)].z = z;
    else if (id.startsWith("text-")) d.texts[idx(id)].z = z;
    else if (id.startsWith("shape-")) d.shapes[idx(id)].z = z;
  });
}

// ---------------------------------------------------------------------------------------------
// Panels

export function togglePanel(side) {
  set(side === "left" ? { leftOpen: !S.leftOpen } : { rightOpen: !S.rightOpen });
  persistPrefs();
}

/** Focus mode: hide both side panels for the whole canvas; again brings back the ones that were open. */
export function toggleFocus() {
  if (S.leftOpen || S.rightOpen) {
    set({ focusRestore: { left: S.leftOpen, right: S.rightOpen }, leftOpen: false, rightOpen: false });
    if (!S.touched.focus) {
      touch("focus");
      toast({ kind: "ok", icon: "focus", title: "Focus mode", text: "The panels are tucked away. Press ⌘\\ or use the buttons in the canvas corners to bring them back.", timeout: 4200 });
    }
  } else {
    const r = S.focusRestore ?? { left: true, right: true };
    set({ leftOpen: r.left, rightOpen: r.right, focusRestore: null });
  }
  persistPrefs();
}

// ---------------------------------------------------------------------------------------------
// Shapes

/** What each shape in the Shapes panel starts as. `tint` is the panel's colour: the stroke of a mark, the fill of a solid. */
export const SHAPE_KINDS = [
  { id: "arrow", label: "Arrow", icon: "arrow", group: "mark", make: (tint) => ({ type: "arrow", stroke: tint, strokeWidth: 0.006, bend: 0.3 }) },
  { id: "sketch-arrow", label: "Drawn arrow", icon: "arrow", group: "mark", make: (tint) => ({ type: "arrow", stroke: tint, strokeWidth: 0.006, bend: 0.35, sketch: true }) },
  { id: "circle-it", label: "Circle it", icon: "circled", group: "mark", make: (tint) => ({ type: "ellipse", stroke: tint, fill: "none", strokeWidth: 0.005, size: 0.09, aspect: 1.6, sketch: true }) },
  { id: "box", label: "Box", icon: "square", group: "mark", make: (tint) => ({ type: "rect", stroke: tint, fill: "none", strokeWidth: 0.005, size: 0.08, aspect: 1.8, radius: 0.2 }) },
  { id: "badge", label: "Number", icon: "badge", group: "mark", make: (tint) => ({ type: "badge", fill: tint, stroke: "#ffffff", labelColor: "#ffffff" }) },
  { id: "line", label: "Line", icon: "line", group: "mark", make: (tint) => ({ type: "line", stroke: tint, strokeWidth: 0.005, bend: 0 }) },
  { id: "rect", label: "Rectangle", icon: "square", group: "solid", make: (tint) => ({ type: "rect", fill: tint, stroke: "none", size: 0.1, aspect: 1.6, radius: 0.12 }) },
  { id: "ellipse", label: "Circle", icon: "ellipse", group: "solid", make: (tint) => ({ type: "ellipse", fill: tint, stroke: "none", size: 0.1, aspect: 1 }) },
  { id: "pill", label: "Pill", icon: "square", group: "solid", make: (tint) => ({ type: "rect", fill: tint, stroke: "none", size: 0.06, aspect: 3.2, radius: 0.5 }) },
  { id: "triangle", label: "Triangle", icon: "triangle", group: "solid", make: (tint) => ({ type: "triangle", fill: tint, stroke: "none", size: 0.08, aspect: 1.1 }) },
  { id: "star", label: "Star", icon: "star", group: "solid", make: (tint) => ({ type: "star", fill: tint, stroke: "none", size: 0.08, aspect: 1 }) },
];

const lineKind = (t) => t === "arrow" || t === "line";

/**
 * Add a shape: in free space near the middle (staggered so a few in a row don't stack), at a point
 * (canvas fractions, from a drop), or aimed at text on a screen with `around`.
 */
export function addShape(kind, { tint = "#ff3b30", at, around } = {}) {
  const k = SHAPE_KINDS.find((x) => x.id === kind);
  if (!k) return;
  if (!S.scene.devices.length) return toast({ kind: "warn", title: "Add a screenshot first", text: "Shapes go on top of a design." });
  const shapes = S.scene.shapes ?? [];
  if (shapes.length >= 40) return toast({ kind: "warn", title: "Forty shapes is the limit" });
  const sh = k.make(tint);
  if (sh.type === "badge") sh.label = String(shapes.filter((x) => x.type === "badge").length + 1);
  if (around) sh.around = around;
  else {
    const off = (shapes.length % 5) * 0.035;
    const c = at ?? { x: 0.5 + off, y: 0.5 + off };
    if (lineKind(sh.type)) {
      sh.from = { x: r4(c.x - 0.12), y: r4(c.y + 0.06) };
      sh.to = { x: r4(c.x + 0.12), y: r4(c.y - 0.06) };
    } else {
      sh.x = r4(c.x);
      sh.y = r4(c.y);
    }
  }
  edit((d) => (d.shapes = [...(d.shapes ?? []), sh]));
  touch("shape");
  set({ selected: `shape-${shapes.length + 1}`, view: "canvas" });
}

// ---------------------------------------------------------------------------------------------
// Text

export const TEXT_PRESETS = {
  label: { text: "New feature", size: 0.026, weight: 650 },
  badge: { text: "NEW", size: 0.018, weight: 750, background: "#d2ff4d", color: "#0d1100", letterSpacing: 0.04 },
  rating: { text: "★★★★★  4.9 on the App Store", size: 0.02, weight: 650 },
  big: { text: "**2×** faster", size: 0.07, weight: 800, accentColor: "#ff5fa2" },
};

export function addText(kind = "label") {
  const preset = TEXT_PRESETS[kind] ?? TEXT_PRESETS.label;
  const n = (S.scene.texts?.length ?? 0) + 1;
  const y = freeRowFor(preset.size);
  const item = { ...preset, x: 0.5, y: r4(y ?? 0.12 + ((n - 1) % 5) * 0.06), anchor: "middle", align: "center" };
  // No clear space: sit on top of the design in a pill, so it's readable over the screen.
  if (y === null && !item.background) Object.assign(item, { background: "rgba(0,0,0,0.72)", color: "#ffffff" });
  edit((d) => {
    d.texts = [...(d.texts ?? []), item];
  });
  set({ selected: `text-${n}`, view: "canvas" });
}

/**
 * The middle of the biggest empty horizontal band (clear of devices, the headline and other
 * text) that fits text of this size, as a fraction of the height; null if nothing fits.
 */
function freeRowFor(size) {
  const ents = S.layout?.entities ?? [];
  const taken = [];
  for (const e of ents) {
    if (e.kind === "device") taken.push([e.y - e.height / 2, e.y + e.height / 2]);
    else {
      // Text boxes aren't measured here; estimate from the font size (two lines for captions).
      const h = e.kind === "caption" ? e.size * 2.3 + (e.subSize ?? 0) * 2.8 : e.size * 1.6;
      const top = e.anchor === "middle" ? e.y - h / 2 : e.anchor === "bottom" ? e.y - h : e.y;
      taken.push([top, top + h]);
    }
  }
  taken.sort((a, b) => a[0] - b[0]);
  const need = size * 2.4;
  let best = null;
  let at = 0.03;
  for (const [t, b] of [...taken, [0.97, 1]]) {
    if (t - at >= need && (!best || t - at > best.gap)) best = { gap: t - at, y: (at + t) / 2 };
    at = Math.max(at, b);
  }
  return best ? best.y : null;
}

export function addCaption() {
  edit((d) => {
    d.headline = d.headline || "Your **headline** here";
  });
  set({ selected: "caption" });
}

// ---------------------------------------------------------------------------------------------
// Capture

async function afterCapture(r, { frame } = {}) {
  await refreshFiles();
  const shot = r.poster ?? r.path;
  useCapture(shot, { frame, video: r.video });
  const warnings = r.warnings ?? [];
  if (warnings.length) {
    toast({
      kind: "warn",
      title: "Captured, with a note",
      text: warnings.join(" "),
      timeout: 0,
      actions: /prompt|alert|permission/i.test(warnings.join(" ")) ? [{ label: "Open Simulator", run: openSimulator }] : [],
    });
  } else toast({ kind: "ok", title: "Captured", text: `${base(shot)} · ${r.width ?? ""}${r.height ? "×" + r.height : ""}` });
}

export async function openSimulator() {
  try {
    const o = await api("/api/open-simulator", { simulator: S.capture.simulator || undefined });
    toast({ kind: "ok", title: `Opened ${o.app}`, text: `Answer the prompt on ${o.simulator} once (iOS remembers it), then capture again.` });
  } catch (e) {
    fail(e, "Couldn't open the simulator");
  }
}

export function captureSimulator() {
  const c = S.capture;
  return task("Capturing simulator…", async () => {
    const r = await api(
      "/api/capture/simulator",
      tidy({
        simulator: c.simulator || undefined,
        bundleId: c.bundleId || undefined,
        url: c.deepLink.trim() || undefined,
        appearance: c.appearance,
        statusBar: { time: c.time || "9:41" },
        grantPermissions: c.bundleId && c.grant ? ["all"] : undefined,
      }),
    );
    await afterCapture(r, { frame: "device" });
  });
}

export function recordSimulator(duration = 6) {
  const c = S.capture;
  return task(`Recording ${duration}s…`, async () => {
    const r = await api(
      "/api/record",
      tidy({
        simulator: c.simulator || undefined,
        bundleId: c.bundleId || undefined,
        url: c.deepLink.trim() || undefined,
        appearance: c.appearance,
        duration,
        grantPermissions: c.bundleId && c.grant ? ["all"] : undefined,
      }),
    );
    await afterCapture({ ...r, path: r.poster }, { frame: "device" });
    toast({ kind: "ok", title: "Recording attached", text: "Export a video to play it inside the frame." });
  });
}

export function captureWeb() {
  const c = S.capture;
  let url = c.url.trim();
  if (!url) return toast({ kind: "warn", title: "Enter a web address first" });
  if (!/^[a-z]+:/i.test(url)) url = `https://${url}`;
  return task("Capturing web page…", async () => {
    const r = await api("/api/capture/web", { url, viewport: c.viewport, colorScheme: c.scheme });
    await afterCapture(r, { frame: r.device ? "device" : "browser" });
  });
}

export function captureMac() {
  const app = S.capture.macWindow;
  return task(app ? `Capturing ${app}…` : "Capturing screen…", async () => {
    const r = await api("/api/capture/mac", tidy({ app: app || undefined }));
    await afterCapture(r, { frame: app ? "none" : "card" });
  });
}

export async function uploadFiles(files, { at, replace, device } = {}) {
  const list = [...files].filter((f) => /\.(png|jpe?g|webp|mp4|mov)$/i.test(f.name) || /^image\/|^video\//.test(f.type));
  if (!list.length) return toast({ kind: "warn", title: "Drop PNG, JPEG, WebP, MP4 or MOV files" });
  const big = list.some((f) => f.size > 200 * 1024 * 1024);
  return task(list.length > 1 ? `Importing ${list.length} files…` : big ? "Importing a large recording…" : "Importing…", async () => {
    const items = [];
    for (const f of list) {
      const name = f.name || (f.type === "image/png" ? "pasted.png" : f.type.startsWith("video/") ? "recording.mp4" : "pasted.jpg");
      // Send the File itself: the browser streams it instead of copying it into memory first.
      items.push(await api(`/api/upload?name=${encodeURIComponent(name)}`, f, true));
    }
    await refreshFiles();
    placeImports(items, { at, replace, device });
  });
}

/** Aspect ratio (width / height) of a device's screen on the canvas. */
function screenAspect(e) {
  const W = S.layout?.canvas.width ?? 1;
  const H = S.layout?.canvas.height ?? 1;
  const sc = e.screen ?? { width: 1, height: 1 };
  return (e.width * W * sc.width) / Math.max(1, e.height * H * sc.height);
}

/**
 * Put imported files into the scene. Screenshots become devices (or replace the selected one);
 * a recording plays inside a device: the one asked for, else the selected one, else the one
 * whose screen shape matches the video, else a new device showing its first frame.
 * `items` are upload results: { path, poster?, width?, height? } (plain paths also work).
 */
export function placeImports(items, { at, replace, device } = {}) {
  items = items.map((i) => (typeof i === "string" ? { path: i } : i)).filter((i) => i?.path);
  const images = items.filter((i) => !isVideo(i.path)).map((i) => i.path);
  const videos = items.filter((i) => isVideo(i.path));
  if (replace && images[0]) useCapture(images[0]);
  else if (images.length === 1 && !S.scene.devices.length) addDevice(images[0], at);
  else for (const p of images) addDevice(p);
  const attached = [];
  for (const v of videos) {
    let target = device ?? (S.selected?.startsWith("device-") ? S.selected : null);
    if (!target && S.scene.devices.length) {
      const aspect = v.width && v.height ? v.width / v.height : null;
      const devs = (S.layout?.entities ?? []).filter((e) => e.kind === "device");
      target = aspect && devs.length ? devs.reduce((a, b) => (Math.abs(Math.log(screenAspect(a) / aspect)) <= Math.abs(Math.log(screenAspect(b) / aspect)) ? a : b)).id : "device-1";
    }
    if (target && S.scene.devices[idx(target)]) {
      edit((d) => (d.devices[idx(target)].video = v.path));
      set({ selected: target });
      attached.push(entityLabel(target));
    } else if (v.poster) {
      addDevice(v.poster, { video: v.path });
      attached.push("the new device");
    } else {
      toast({ kind: "warn", title: "Recording imported", text: "Add a screenshot first, then attach the recording from the device's settings." });
    }
  }
  if (attached.length) {
    toast({ kind: "ok", icon: "video", title: "Recording attached", text: `It plays inside ${attached.join(" and ")} on the canvas and in exported videos.`, actions: [{ label: "Export video", run: () => set({ exportOpen: true, exportOpts: { ...S.exportOpts, tab: "video" } }) }] });
  }
  if (images.length) toast({ kind: "ok", title: images.length > 1 ? `Imported ${images.length} screenshots` : "Imported", text: images.map(base).join(", ") });
}

export async function deleteFile(p) {
  const ok = await confirmDialog({ title: `Delete ${base(p)}?`, text: "The file and its metadata are removed from the output folder. This can't be undone.", confirm: "Delete", danger: true });
  if (!ok) return;
  try {
    await api("/api/delete", { path: p });
    if (S.scene.devices.some((d) => d.screenshot === p || d.video === p)) {
      const next = clone(S.scene);
      next.devices = next.devices.filter((d) => d.screenshot !== p);
      next.devices.forEach((d) => d.video === p && delete d.video);
      setScene(next);
    }
    if (S.render?.path === p) set({ render: null, renderStale: false });
    await refreshFiles();
    toast({ kind: "ok", title: "Deleted", text: base(p) });
  } catch (e) {
    fail(e, "Couldn't delete");
  }
}

// ---------------------------------------------------------------------------------------------
// Render & export

function deliveryRequest() {
  const o = S.exportOpts;
  const req = { ...clone(S.scene), preview: false, format: o.format };
  if (o.format !== "png") req.jpegQuality = o.jpegQuality;
  if (o.size === "custom" && o.width) req.deliveryWidth = o.width;
  if (o.size === "half" && S.layout) req.deliveryWidth = Math.round(S.layout.canvas.width / 2);
  return req;
}

function renderResult(r, extra) {
  set({ render: { ...r, ...extra, at: Date.now(), scene: JSON.stringify(S.scene) }, renderStale: false, view: "render" });
}

export async function renderPreview() {
  if (!S.scene.devices.length) return toast({ kind: "warn", title: "Add a screenshot first" });
  if (S.rendering) return;
  const started = performance.now();
  set({ rendering: { label: "Rendering preview…" }, view: "render" });
  try {
    const r = await api("/api/mockup", { ...clone(S.scene), quality: "preview", format: "jpeg", jpegQuality: 88, preview: false });
    renderResult(r, { preview: true, ms: performance.now() - started });
  } catch (e) {
    fail(e, "Preview failed");
  } finally {
    set({ rendering: null });
  }
}

/** Exports carry the scene they came from, so the library can show each scene's versions. */
const historyQuery = () => (S.sceneId ? `?scene=${encodeURIComponent(S.sceneId)}&name=${encodeURIComponent(S.sceneName ?? "")}` : "");

/** Bring an exported version back as the working design (one undo step). */
export async function restoreVersion(file) {
  try {
    const res = await fetch(`/file?path=${encodeURIComponent(`${file}.mockup.json`)}`);
    if (!res.ok) throw new Error("This version's settings weren't saved with it");
    const req = await res.json();
    for (const k of ["output", "preview", "quality", "format", "jpegQuality", "deliveryWidth", "studio", "video"]) delete req[k];
    setScene(req);
    set({ view: "edit" });
    toast({ kind: "ok", title: "Version restored", text: "Undo (⌘Z) goes back to what you had." });
  } catch (e) {
    fail(e, "Couldn't restore this version");
  }
}

export async function exportImage() {
  if (!S.scene.devices.length) return toast({ kind: "warn", title: "Add a screenshot first" });
  if (S.rendering) return;
  const started = performance.now();
  set({ rendering: { label: "Rendering full resolution…" }, view: "render", exportOpen: false });
  try {
    const r = await api(`/api/mockup${historyQuery()}`, deliveryRequest());
    renderResult(r, { preview: false, ms: performance.now() - started });
    touch("exported");
    refreshFiles();
    toast({
      kind: "ok",
      title: "Image exported",
      text: `${base(r.path)} · ${r.width}×${r.height}`,
      actions: [
        { label: "Show in Finder", run: () => reveal(r.path) },
        { label: "Copy", run: () => copyImage(r.path) },
      ],
    });
    for (const w of r.warnings ?? []) toast({ kind: "warn", title: "Note", text: w });
  } catch (e) {
    fail(e, "Export failed");
  } finally {
    set({ rendering: null });
  }
}

/** A shot's video options: the camera motion chosen for export, and its own length when it has one. */
function shotVideo(scene, length) {
  const v = S.exportOpts.video;
  const d = length ?? Math.max(v.duration ?? 6, Math.ceil((timelineEnd(scene.animations) + (scene.animations?.length ? 1.2 : 0)) * 2) / 2);
  return tidy({ duration: d, motion: v.motion, zoom: v.zoom ? { start: d * 0.35, end: d * 0.85 } : undefined });
}

/** Every shot as the engine renders them: its scene, video options, length and way in. */
function sequenceShots() {
  const shots = allShots() ?? [{ scene: S.scene }];
  return shots.map((x, i) => {
    const length = x.length ?? (shots.length === 1 ? shotVideo(x.scene).duration : undefined);
    return tidy({ ...clone(x.scene), video: shotVideo(x.scene, length), length, transition: i ? (x.transition ?? { type: "fade", duration: 0.5 }) : undefined });
  });
}

/**
 * Export the video: every shot, at each size chosen (the first is the main file, the rest are
 * versions), each fitted, filled or laid out again for its shape.
 */
export async function exportVideo() {
  const shots = allShots();
  if (!(shots ? shots[0].scene : S.scene).devices.length) return toast({ kind: "warn", title: "Add a screenshot first" });
  if (S.rendering) return;
  const o = S.exportOpts.video;
  const sizes = o.sizes?.length ? o.sizes : ["design"];
  const fit = o.fit && o.fit !== "auto" ? o.fit : undefined;
  const [main, ...rest] = sizes;
  const versions = rest.map((size) => (fit ? { size, fit } : size));
  const started = performance.now();
  const what = shots ? `${shots.length} shots` : "video";
  set({ rendering: { label: `Rendering the ${what}${sizes.length > 1 ? ` at ${sizes.length} sizes` : ""}… this takes a little while` }, view: "render", exportOpen: false });
  try {
    let r;
    if (!shots && main === "design") {
      const video = shotVideo(S.scene, S.exportOpts.video.duration && Math.max(S.exportOpts.video.duration, shotVideo(S.scene).duration));
      r = await api(`/api/video${historyQuery()}`, { ...clone(S.scene), video, format: o.format, preview: false, versions: versions.length ? versions : undefined });
    } else {
      r = await api(`/api/sequence${historyQuery()}`, { shots: sequenceShots(), size: main === "design" ? undefined : main, fit, versions: versions.length ? versions : undefined, format: o.format, preview: false });
    }
    renderResult(r, { preview: false, isVideo: o.format !== "gif", ms: performance.now() - started });
    touch("exported");
    refreshFiles();
    const extra = r.versions?.length ? ` + ${r.versions.map((v) => v.label.split(" · ")[0] === "App Store" ? v.label : v.label.split(" · ")[0]).join(", ")}` : "";
    toast({ kind: "ok", title: shots ? `${shots.length}-shot video exported` : "Video exported", text: `${base(r.path)} · ${r.width}×${r.height} · ${r.duration?.toFixed?.(1)}s${extra}`, actions: [{ label: "Show in Finder", run: () => reveal(r.path) }] });
    const notes = [...(r.warnings ?? []), ...(r.versions ?? []).flatMap((v) => (v.warnings ?? []).map((w) => `${v.label}: ${w}`))];
    if (notes.length) toast({ kind: "warn", title: "Worth knowing", text: notes.slice(0, 3).join(" "), timeout: 12000 });
  } catch (e) {
    fail(e, "Video export failed");
  } finally {
    set({ rendering: null });
  }
}

/** Every shot at its key moments, as one contact sheet, without rendering the video (a second or two a shot). */
export async function previewShots() {
  const shots = allShots();
  if (!shots || S.rendering) return;
  const started = performance.now();
  set({ rendering: { label: `Looking at ${shots.length} shots…` }, view: "render" });
  try {
    const r = await api("/api/sequence-board", { shots: sequenceShots(), size: (S.exportOpts.video.sizes ?? ["design"])[0] === "design" ? undefined : S.exportOpts.video.sizes[0] });
    renderResult({ path: r.path, width: 0, height: 0, sheet: true, duration: r.duration }, { preview: true, ms: performance.now() - started });
  } catch (e) {
    fail(e, "Couldn't make the contact sheet");
  } finally {
    set({ rendering: null });
  }
}

// ---------------------------------------------------------------------------------------------
// Sizes

/** The device a size is made for, when one of its family is swapped in. */
const SIZE_DEVICES = { iphone: "iPhone 17 Pro Max", ipad: "iPad Pro 13-inch", mac: "MacBook Pro 16-inch", watch: "Apple Watch Ultra 49mm" };

/** The family of each device in a scene, by its model or (left to the app) by what its layout chose. */
function familiesIn(scene, layout) {
  const models = S.opts?.devices ?? [];
  return scene.devices.map((d, i) => {
    const name = d.device ?? layout?.entities.find((e) => e.id === `device-${i + 1}`)?.device;
    return models.find((m) => m.name === name)?.family;
  });
}

/** A screen's layout, to tell which devices the app chose for it (only asked when it chose some). */
function layoutFor(scene) {
  if (scene === S.scene) return Promise.resolve(S.layout);
  if (!scene.devices.some((d) => !d.device && (!d.frame || d.frame === "device"))) return Promise.resolve(null);
  return api("/api/layout", scene).catch(() => null);
}

/**
 * Make a scene at another size (in place): the canvas set, and each framed device of another kind
 * swapped for the size's model (keeping its screenshot). Returns how many were swapped.
 */
function resize(d, value, families) {
  const preset = S.opts?.canvases?.[value];
  const want = preset && SIZE_DEVICES[preset.platform] ? preset.platform : null;
  const model = want && (S.opts?.devices ?? []).find((m) => m.name === SIZE_DEVICES[want]);
  d.canvas = value || undefined;
  if (preset?.platform === "watch") delete d.landscape;
  let n = 0;
  if (model)
    d.devices.forEach((dev, i) => {
      if ((dev.frame && dev.frame !== "device") || !families[i] || families[i] === want) return;
      dev.device = model.name;
      delete dev.color;
      n++;
    });
  return n;
}

/** What a swap of devices asks of the person: a screenshot of the new kind on each. */
function swapNote(value, n) {
  const want = S.opts?.canvases?.[value]?.platform;
  const kind = { mac: "a Mac", watch: "an Apple Watch", ipad: "an iPad" }[want] ?? "an iPhone";
  return n ? `${n === 1 ? `A device is now ${an(SIZE_DEVICES[want])}` : `${n} devices are now ${SIZE_DEVICES[want]}`}: drop ${kind} screenshot on ${n === 1 ? "it" : "each"}.` : "";
}
const an = (name) => `${/^(i|[AEIOU])/.test(name) ? "an" : "a"} ${name}`;

/**
 * Change the image size. A size made for another kind of device (iPad, Mac, Apple Watch) swaps each
 * framed device for that kind's model, keeping its screenshot until a new one is dropped on it. In a
 * set the size is the set's, so every screen changes.
 */
export async function setCanvasSize(value) {
  const preset = S.opts?.canvases?.[value];
  const label = preset ? (preset.short ?? preset.label) : value ? value.replace("x", " × ") : "the automatic size";
  const many = allShots();
  if (!many) {
    let n = 0;
    const families = familiesIn(S.scene, S.layout);
    edit((d) => (n = resize(d, value, families)));
    if (n) toast({ kind: "ok", icon: "replace", title: `Made for ${label}`, text: `${swapNote(value, n)} Undo (⌘Z) goes back.`, timeout: 5000 });
    return;
  }
  // Every screen's devices, told apart by its layout, before anything changes.
  const layouts = new Map(await Promise.all(many.map(async (x) => [x.scene, await layoutFor(x.scene)])));
  const shots = allShots();
  if (!shots) return;
  const before = { shots: clone(shots), shot: S.shot, scene: S.scene };
  let n = 0;
  const next = shots.map((x) => {
    const scene = clone(x.scene);
    n += resize(scene, value, familiesIn(scene, layouts.get(x.scene) ?? (x.scene === S.scene ? S.layout : null)));
    return { ...x, scene };
  });
  set({ shots: next });
  setScene(next[S.shot].scene);
  persist();
  toast({ kind: "ok", icon: "replace", title: `All ${next.length} screens are ${label}`, text: swapNote(value, n) || "The size is the set's: every screen has it.", timeout: 6000, actions: [{ label: "Undo", run: () => (set(before), scheduleLayout(0), persist()) }] });
}

// ---------------------------------------------------------------------------------------------
// Sizes of one design: its screens made again for iPad, Apple Watch, Google Play… The size on the
// canvas has its screens in S.shots; the others wait in S.groups.

/** What a size is called: its image size's short name ("iPad 13″"), else its pixels. */
export function sizeLabel(scene) {
  const c = scene?.canvas;
  const p = typeof c === "string" ? S.opts?.canvases?.[c] : null;
  if (p) return p.short ?? p.label;
  if (typeof c === "string" && /^\d+x\d+$/.test(c)) return c.replace("x", " × ");
  if (c && typeof c === "object") return `${c.width} × ${c.height}`;
  return "Auto size";
}

/** Put another size on the canvas: its screens, the first one to edit. */
export function goToSize(i) {
  const groups = allGroups();
  if (!groups || i === S.group || !groups[i]) return;
  const shots = groups[i].shots;
  set({ groups, group: i, shots: shots.length > 1 ? shots : null, shot: 0, scene: shots[0].scene, past: [], future: [], selected: null, animSel: null, animRows: [], render: null, renderStale: false, stillPick: null });
  scheduleLayout(0);
  persist();
}

/** Make every screen again at another size (devices swapped to suit), and open it. A size the design has already just opens. */
export async function addSize(value) {
  const groups = allGroups() ?? [{ shots: activeScreens() }];
  const have = groups.findIndex((g) => (g.shots[0].scene.canvas ?? "") === value);
  if (have >= 0) {
    if (S.groups) goToSize(have);
    return toast({ kind: "ok", title: `This design has ${sizeLabel({ canvas: value })} already`, timeout: 2600 });
  }
  const screens = activeScreens();
  const layouts = await Promise.all(screens.map((x) => layoutFor(x.scene)));
  let n = 0;
  const shots = screens.map((x, i) => {
    const scene = clone(x.scene);
    n += resize(scene, value, familiesIn(scene, layouts[i]));
    return { ...x, scene };
  });
  set({ groups: [...(allGroups() ?? [{ shots: activeScreens() }]), { shots }], group: S.groups ? S.group : 0 });
  goToSize(S.groups.length - 1);
  const label = sizeLabel({ canvas: value });
  toast({ kind: "ok", icon: "plus", title: `${label} added`, text: `${shots.length === 1 ? "The design" : `All ${shots.length} screens`}, made again at ${label}. ${swapNote(value, n)}`.trim(), timeout: 6000 });
}

/** Take a size out (with a way back). The last one left is a design at one size again. */
export function removeSize(i) {
  const groups = allGroups();
  if (!groups?.[i]) return;
  const before = { groups, group: S.group, shots: S.shots, shot: S.shot, scene: S.scene };
  const label = sizeLabel(groups[i].shots[0].scene);
  const rest = groups.filter((_, n) => n !== i);
  const show = i === S.group ? Math.max(0, i - 1) : S.group > i ? S.group - 1 : S.group;
  const shots = rest[show].shots;
  set({ groups: rest.length > 1 ? rest : null, group: rest.length > 1 ? show : 0, shots: shots.length > 1 ? shots : null, shot: i === S.group ? 0 : S.shot, scene: i === S.group ? shots[0].scene : S.scene, past: i === S.group ? [] : S.past, future: i === S.group ? [] : S.future, selected: i === S.group ? null : S.selected });
  scheduleLayout(0);
  persist();
  toast({ kind: "ok", title: `${label} removed`, timeout: 6000, actions: [{ label: "Undo", run: () => (set({ ...before, past: [], future: [] }), scheduleLayout(0), persist()) }] });
}

// ---------------------------------------------------------------------------------------------
// Shots: a design can be a video of several, one after another. The one on the canvas is S.scene.

/** Put another shot on the canvas (its own undo history). */
export function goToShot(i) {
  const shots = allShots();
  if (!shots || i === S.shot || !shots[i]) return;
  set({ shots, shot: i, scene: shots[i].scene, past: [], future: [], selected: null, animSel: null, animRows: [], render: null, renderStale: false, stillPick: null });
  scheduleLayout(0);
  persist();
}

/**
 * Add a screen (a shot of the video): a copy of one (the one on the canvas unless `copyOf` says
 * which), or a saved design (by id); after the one on the canvas unless `at` says where.
 */
export async function addShot(from = "copy", { at, copyOf } = {}) {
  const shots = allShots() ?? [{ scene: S.scene }];
  let scene = clone(shots[copyOf ?? (S.shots ? S.shot : 0)]?.scene ?? S.scene);
  if (from !== "copy") {
    try {
      scene = (await api(`/api/scene?id=${encodeURIComponent(from)}`)).scene;
    } catch (e) {
      return fail(e, "Couldn't add that design");
    }
  }
  at = Math.max(0, Math.min(shots.length, at ?? (S.shots ? S.shot : 0) + 1));
  shots.splice(at, 0, { scene, transition: { type: "fade", duration: 0.5 } });
  set({ shots, shot: S.shots ? (S.shot >= at ? S.shot + 1 : S.shot) : at === 0 ? 1 : 0 });
  goToShot(at);
  toast({ kind: "ok", title: `Screen ${at + 1} added`, text: from === "copy" ? "A copy to change. In Animate the screens play in order as a video." : "Change it here: it's its own copy.", timeout: 3200 });
}

/** A screen's name: the one it was given, else its headline, else its number. */
export function screenName(i) {
  const x = S.shots?.[i];
  if (x?.name) return x.name;
  const scene = !S.shots || i === S.shot ? S.scene : x?.scene;
  const head = (scene?.headline ?? "").replace(/\*\*/g, "").replace(/\s+/g, " ").trim();
  return head ? (head.length > 40 ? head.slice(0, 38).trim() + "…" : head) : `Screen ${i + 1}`;
}

/** Take a shot out (with a way back). The last one left is a single design again. */
export function deleteShot(i) {
  const shots = allShots();
  if (!shots) return;
  const before = { shots, shot: S.shot, scene: S.scene };
  const rest = shots.filter((_, n) => n !== i);
  const next = Math.min(rest.length - 1, i === S.shot ? Math.max(0, i - 1) : S.shot > i ? S.shot - 1 : S.shot);
  set({ shots: rest.length > 1 ? rest : null, shot: rest.length > 1 ? next : 0, scene: rest[next].scene, past: [], future: [], selected: null, animSel: null });
  scheduleLayout(0);
  persist();
  toast({ kind: "ok", title: `Screen ${i + 1} removed`, timeout: 6000, actions: [{ label: "Undo", run: () => (set(before), scheduleLayout(0), persist()) }] });
}

/** Move a shot one place earlier (-1) or later (1). */
export function moveShot(i, by) {
  const shots = allShots();
  const j = i + by;
  if (!shots || j < 0 || j >= shots.length) return;
  [shots[i], shots[j]] = [shots[j], shots[i]];
  set({ shots, shot: S.shot === i ? j : S.shot === j ? i : S.shot });
  persist();
}

/** Change a shot's length or how it comes in. */
export function updateShot(i, patch) {
  const shots = allShots();
  if (!shots?.[i]) return;
  shots[i] = { ...shots[i], ...patch };
  for (const [k, v] of Object.entries(patch)) if (v === undefined) delete shots[i][k];
  set({ shots });
  persist();
}

export async function reveal(p) {
  try {
    await api("/api/reveal", { path: p });
  } catch (e) {
    fail(e, "Couldn't show the file");
  }
}

export async function copyImage(p) {
  try {
    if (native) await native.call("copyFile", { path: p });
    else {
      const blob = await (await fetch(`/file?path=${encodeURIComponent(p)}`)).blob();
      const png = blob.type === "image/png" ? blob : await toPng(blob);
      await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
    }
    toast({ kind: "ok", title: "Copied to clipboard", timeout: 2200 });
  } catch (e) {
    fail(e, "Couldn't copy");
  }
}
async function toPng(blob) {
  const bmp = await createImageBitmap(blob);
  const c = new OffscreenCanvas(bmp.width, bmp.height);
  c.getContext("2d").drawImage(bmp, 0, 0);
  return c.convertToBlob({ type: "image/png" });
}

// ---------------------------------------------------------------------------------------------
// AI

export function openAI(context) {
  // Docked, it opens in the right-hand panel (shown if it was hidden).
  set({ ai: { ...S.ai, open: true, error: null, context: context !== false }, selected: typeof context === "string" ? context : S.selected, view: "canvas", ...(S.ai.docked ? { rightOpen: true } : {}) });
  setTimeout(() => document.querySelector(".ai-chat textarea")?.focus(), 30);
}

/** Ask AI in the right-hand panel (docked), or floating over the canvas again. */
export function dockAI(docked) {
  set({ ai: { ...S.ai, open: true, docked }, ...(docked ? { rightOpen: true } : {}) });
  persistPrefs();
  setTimeout(() => document.querySelector(".ai-chat textarea")?.focus(), 30);
}

/** The scene before each AI change, so a chat message can revert it (kept in memory only). */
const beforeAI = new Map();
let msgId = 0;
const msg = (m) => ({ id: `${Date.now()}-${++msgId}`, at: Date.now(), ...m });

/** The conversation so far, as the turns Claude sees: what the user said and what it replied. */
function chatHistory() {
  const turns = [];
  for (const m of S.ai.thread) {
    if (m.role === "user") turns.push({ user: m.text });
    else if (turns.length && !turns[turns.length - 1].assistant) turns[turns.length - 1].assistant = m.text;
  }
  return turns.slice(-12);
}

/** The edit in progress: Stop aborts it; "Use it now" takes its draft and stops the rest. */
let aiRun = null;
export function stopAI() {
  aiRun?.stop.abort();
}
export function useAIDraft() {
  if (!aiRun || !S.ai.work?.draft) return;
  aiRun.takeDraft = true;
  aiRun.stop.abort();
}

export async function aiEdit(text) {
  const instruction = text.trim();
  if (!instruction || S.ai.busy) return;
  const selection = S.ai.context ? S.selected || undefined : undefined;
  const history = chatHistory();
  const recall = [...S.ai.history.filter((h) => h !== instruction), instruction].slice(-20);
  const user = msg({ role: "user", text: instruction, about: selection ? entityLabel(selection) : undefined });
  set({ ai: { ...S.ai, open: true, busy: true, text: "", error: null, history: recall, thread: [...S.ai.thread, user] } });
  if (!S.scene.devices.length) {
    set({ ai: { ...S.ai, busy: false, thread: [...S.ai.thread, msg({ role: "error", text: "Add a screenshot first, then describe the change." })] } });
    return;
  }
  const snapshot = S.scene;
  // A video of several shots: Claude gets every shot, and which one is on the canvas.
  const video = allShots();
  const shotsSnapshot = S.shots;
  const shotSnapshot = S.shot;
  const started = Date.now();
  const run = (aiRun = { stop: new AbortController(), takeDraft: false });
  // Steps appear as the engine takes them: a question may go straight to Claude.
  set({ ai: { ...S.ai, work: { started, steps: [], items: [], retry: null, draft: null } } });
  const work = (patch) => set({ ai: { ...S.ai, work: { ...S.ai.work, ...patch } } });
  // Each step the engine reports closes the one before it, so every step has its own time.
  const step = (key, extra = {}) => {
    const now = Date.now();
    const steps = (S.ai.work?.steps ?? []).map((x) => (x.end ? x : { ...x, end: now }));
    work({ steps: [...steps, { key, at: now, ...extra }] });
  };
  const doneSteps = (answer = false) => (S.ai.work?.steps ?? []).map((x) => ({ key: x.key, ms: (x.end ?? Date.now()) - x.at, provider: x.provider, cut: x.cut, moments: x.moments, times: x.times, answer }));

  /** Put a finished (or drafted) edit on the canvas and into the chat. */
  const finish = (r, { skippedCheck = false } = {}) => {
    if (S.scene !== snapshot || S.shots !== shotsSnapshot || S.shot !== shotSnapshot) throw new Error(`The design changed while ${aiName()} was working. Ask again.`);
    const via = r.provider === "api" ? r.model ?? "Claude" : r.provider === "codex" ? "Codex" : "Claude Code";
    const took = Math.max(1, Math.round((Date.now() - started) / 1000));
    const answered = !r.operations?.length;
    const steps = { list: doneSteps(answered), items: S.ai.work?.items ?? [], retried: Boolean(S.ai.work?.retry), checked: r.checked, skippedCheck, remembered: r.remembered };
    if (answered) {
      // A plain answer: just the reply, unless Claude looked at something to give it.
      const looked = steps.list.some((x) => x.key !== "think");
      const answer = msg({ role: "assistant", text: r.summary || "I didn't change anything.", via, ...(looked ? { took, steps } : {}), remembered: r.remembered, fresh: true });
      set({ ai: { ...S.ai, busy: false, work: null, thread: [...S.ai.thread, answer] } });
      settle(answer.id);
      persist();
      return;
    }
    const ops = r.operations.map((o) => describeOp(o, r.request, r.video?.shots));
    const reply = msg({ role: "assistant", text: r.summary, changes: r.operations.length, changed: r.video && r.video.changed.length > 1 ? r.video.changed.map((i) => `Shot ${i + 1}`) : r.changed.map((c) => entityLabel(c, r.request)), ops, via, took, steps, remembered: r.remembered, fresh: true });
    if (r.video) {
      // Every shot as it was, so Revert can put back the ones this changed.
      beforeAI.set(reply.id, { kind: "video", shots: video, shot: shotSnapshot, changed: r.video.changed, structural: r.video.structural });
      applyVideo(r.video);
    } else {
      // The shot it was made on, so Revert puts back that one (even from another shot).
      beforeAI.set(reply.id, { kind: "scene", scene: snapshot, shot: S.shots ? S.shot : 0 });
      setScene(r.request);
    }
    if (r.changed.some((c) => c.startsWith("device"))) touch("moved");
    if (r.changed.includes("background")) touch("backdrop");
    const pulse = r.changed.filter((c) => !["background", "canvas"].includes(c));
    // A change to the timeline shows in Animate.
    const timeline = r.operations.some((o) => o.path.startsWith("/animations"));
    set({ ai: { ...S.ai, busy: false, work: null, error: null, last: r, thread: [...S.ai.thread, reply] }, pulse, view: "canvas", ...(timeline ? { timelineOpen: true, animSel: null } : {}) });
    setTimeout(() => set({ pulse: [] }), 1700);
    settle(reply.id);
    persist();
  };

  try {
    const r = await streamEdit(
      { request: snapshot, instruction, selection, history, ...aiChoice(), preview: S.ai.preview !== false, ...(video ? { shots: video.map((x) => tidy({ scene: x.scene, name: x.name, length: x.length, transition: x.transition })), shot: S.shot } : {}) },
      (p) => {
        if (p.step === "look") {
          if (!p.image) return step("look");
          // The design as Claude sees it: rendering (and any backdrop it waited for) is done.
          const now = Date.now();
          work({ image: `data:image/jpeg;base64,${p.image}`, steps: S.ai.work.steps.map((x) => ({ ...(x.end ? x : { ...x, end: now }), ...(x.key === "look" && p.moments ? { moments: p.moments } : {}) })) });
        } else if (p.step === "read") step("read"), work({ items: p.items });
        else if (p.step === "think") step("think");
        else if (p.step === "retry") step("retry", { reason: p.reason }), work({ retry: p.reason });
        else if (p.step === "draft") work({ draft: p.result });
        else if (p.step === "generate") step("generate", { provider: p.provider, prompt: p.prompt, reason: p.reason });
        else if (p.step === "render") step("render");
        // Claude asked to see particular moments: a step while they render, then the frames.
        else if (p.step === "frames" && !p.image) step("frames", { times: p.times });
        else if (p.step === "frames") work({ steps: S.ai.work.steps.map((x, i, all) => (i === all.length - 1 && x.key === "frames" ? { ...x, image: `data:image/jpeg;base64,${p.image}` } : x)) });
        else if (p.step === "check") step("check", { moments: p.moments }), work({ checkImage: `data:image/jpeg;base64,${p.image}` });
      },
      run.stop.signal,
    );
    finish(r);
  } catch (e) {
    if (run.stop.signal.aborted && run.takeDraft && S.ai.work?.draft) {
      // The step it was on when you took the change is cut short, and says so.
      const now = Date.now();
      work({ steps: S.ai.work.steps.map((x) => (x.end ? x : { ...x, end: now, cut: true })) });
      try {
        return finish(S.ai.work.draft, { skippedCheck: true });
      } catch (err) {
        e = err;
      }
    }
    const current = S.ai.work?.steps?.at(-1)?.key;
    const text = run.stop.signal.aborted && !run.takeDraft ? `Stopped${stoppedAt(current) ? ` ${stoppedAt(current)}` : ""}. Nothing changed.` : e.message;
    set({ ai: { ...S.ai, busy: false, work: null, thread: [...S.ai.thread, msg({ role: "error", stopped: run.stop.signal.aborted, text, retry: instruction })] } });
  } finally {
    if (aiRun === run) aiRun = null;
  }
}

/** Where an edit was when it was stopped, for the chat. */
const stoppedAt = (step) =>
  ({
    look: "while rendering your design",
    read: "while reading the design",
    think: `while ${aiName()} was designing`,
    retry: `while ${aiName()} was fixing its first try`,
    frames: `while ${aiName()} was looking at moments of the video`,
    generate: "while the backdrop image was being made",
    render: "while rendering the result",
    check: `while ${aiName()} was checking its work`,
  })[step];

/** The AI the person chose and, for Claude, its model (Codex uses the model set in Codex). */
const aiChoice = () => ({ engine: aiEngine(), model: aiEngine() === "claude" ? S.ai.model || undefined : undefined });

/** A new reply animates in once; after that it's just text (also when the chat is reopened). */
function settle(id) {
  setTimeout(() => set({ ai: { ...S.ai, thread: S.ai.thread.map((m) => (m.id === id ? { ...m, fresh: false } : m)) } }), 2600);
}

/** POST an edit and read the engine's progress lines as they arrive; resolves with the result. */
async function streamEdit(body, onProgress, signal) {
  let res;
  try {
    res = await fetch("/api/ai-edit?stream=1", { method: "POST", headers: { "x-screenshotter": "studio", "Content-Type": "application/json" }, body: JSON.stringify(body), signal });
  } catch (e) {
    if (signal?.aborted) throw e;
    throw new Error("Lost connection to the Screenshotter engine.");
  }
  if (!res.ok || !res.body) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `HTTP ${res.status}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      const ev = JSON.parse(line);
      if (ev.type === "progress") onProgress(ev);
      else if (ev.type === "error") throw new Error(ev.error);
      else if (ev.type === "result") return ev;
    }
  }
  throw new Error("The edit stopped before it finished. Try again.");
}

const OP_NAMES = {
  animations: "Animation",
  rotateY: "Turn", rotateX: "Tilt", rotate: "Rotation", height: "Size", width: "Size", x: "Position", y: "Position", anchor: "Position",
  color: "Colour", accentColor: "Accent colour", headline: "Headline", subheadline: "Subheadline", headlineSize: "Headline size",
  subheadlineSize: "Subheadline size", font: "Font", headlineWeight: "Weight", weight: "Weight", letterSpacing: "Tracking",
  uppercase: "Uppercase", align: "Alignment", position: "Placement", shadow: "Shadow", glare: "Glare", frame: "Frame",
  device: "Model", side: "Side", highlights: "Call-outs", text: "Words", size: "Size", background: "Backdrop", opacity: "Opacity",
  canvas: "Image size", layout: "Arrangement", effects: "Film look", grain: "Grain", vignette: "Vignette", grade: "Colour grade",
  edgeBlur: "Edge blur", screenshot: "Screenshot", texts: "Text", devices: "Device", blur: "Blur", dim: "Dim", look: "Look",
};

/** One operation in plain words: what it touched, which property, and the new value. */
function describeOp(op, scene, shots) {
  let parts = op.path.split("/").slice(1).map((p) => p.replace(/~1/g, "/").replace(/~0/g, "~"));
  // In a video of several shots, every change says which shot it's in.
  let shot = "";
  if (parts[0] === "shots" && /^\d+$/.test(parts[1] ?? "")) {
    const n = Number(parts[1]);
    shot = `Shot ${n + 1}`;
    scene = shots?.[n]?.scene ?? scene;
    parts = parts.slice(2);
    const verb = { remove: "Removed", move: "Moved", copy: "Added a copy", insert: "Added", append: "Added" }[op.op];
    if (!parts.length) return { shot: String(n + 1), target: "Shot", prop: verb ?? "Replaced", value: op.from && /^\/shots\/\d+$/.test(op.from) ? `from shot ${Number(op.from.split("/")[2]) + 1}` : "" };
    if (parts[0] === "length") return { shot: String(n + 1), target: "Shot", prop: "Length", value: op.op === "remove" ? "as long as it needs" : `${JSON.parse(op.value)} s` };
    if (parts[0] === "transition") {
      let t;
      try {
        t = JSON.parse(op.value);
      } catch {}
      return { shot: String(n + 1), target: "Shot", prop: "Comes in", value: t?.type ? `${TRANSITION_NAMES[t.type] ?? t.type}${t.duration !== undefined && t.type !== "cut" ? ` · ${t.duration} s` : ""}` : "updated" };
    }
  }
  let target = "Design";
  let rest = parts;
  if (parts[0] === "devices" && /^\d+$/.test(parts[1] ?? "")) {
    target = entityLabel(`device-${Number(parts[1]) + 1}`, scene);
    rest = parts.slice(2);
  } else if (parts[0] === "texts" && /^\d+$/.test(parts[1] ?? "")) {
    target = "Text";
    rest = parts.slice(2);
  } else if (["headline", "subheadline", "textStyle"].includes(parts[0])) {
    target = "Caption";
    rest = parts[0] === "textStyle" ? parts.slice(1) : parts;
  } else if (parts[0] === "background") {
    target = "Backdrop";
    rest = parts.slice(1);
  } else if (parts[0] === "effects") {
    target = "Film look";
    rest = parts.slice(1);
  } else if (parts[0] === "animations") {
    target = "Timeline";
    rest = ["animations"];
  }
  const key = rest.find((p) => !/^\d+$/.test(p)) ?? parts[0];
  const prop = OP_NAMES[key] ?? key.replace(/([A-Z])/g, " $1").replace(/^./, (c) => c.toUpperCase());
  let value;
  try {
    value = op.op === "remove" ? undefined : JSON.parse(op.value);
  } catch {
    value = op.value;
  }
  const short = (v) => {
    if (v === undefined) return "removed";
    if (typeof v === "number") return Number.isInteger(v) ? String(v) : String(Math.round(v * 1000) / 1000);
    if (typeof v === "string") return v.replace(/\*\*/g, "").slice(0, 28) + (v.length > 28 ? "…" : "");
    if (Array.isArray(v)) return `${v.length} item${v.length === 1 ? "" : "s"}`;
    if (v && typeof v === "object") return v.look ?? v.type ?? v.unsplash ?? (v.photo ? "photo" : v.generate ? "AI image" : "updated");
    return String(v);
  };
  const color = typeof value === "string" && /^#[0-9a-f]{3,8}$/i.test(value) ? value : undefined;
  const unit = ["rotateY", "rotateX", "rotate"].includes(key) ? "°" : "";
  const moved = op.op === "copy" || op.op === "move";
  return {
    shot: shot ? shot.replace("Shot ", "") : undefined,
    target,
    prop: op.op === "append" || op.op === "insert" ? `Added ${prop.toLowerCase()}` : moved ? `${op.op === "copy" ? "Copied" : "Moved"} ${prop.toLowerCase()}` : prop,
    value: op.op === "append" || op.op === "insert" ? "" : moved ? (op.from?.startsWith("/shots/") ? `from shot ${Number(op.from.split("/")[2]) + 1}` : "") : short(value) + (typeof value === "number" ? unit : ""),
    color: moved ? undefined : color,
  };
}

/**
 * Put Claude's edit of a video on the canvas: the shot it changed (or the one you're on), with the
 * shots it touched highlighted in the strip. An edit to just the shot on the canvas is one undo step.
 */
function applyVideo(v) {
  const onlyHere = !v.structural && v.show === S.shot && v.changed.every((i) => i === S.shot);
  if (onlyHere) {
    const shots = v.shots.map((x, i) => (i === S.shot ? { ...x, scene: S.scene } : x));
    set({ shots });
    setScene(v.shots[v.show].scene);
  } else {
    const many = v.shots.length > 1;
    set({ shots: many ? v.shots : null, shot: many ? v.show : 0, scene: v.shots[v.show].scene, past: [], future: [], selected: null, animSel: null, animRows: [] });
    scheduleLayout(0);
  }
  set({ shotPulse: v.changed });
  setTimeout(() => set({ shotPulse: [] }), 1800);
  persist();
}

/**
 * Put back what one of Claude's changes changed: the shots it touched (every shot, if it added,
 * removed or reordered them), or the one shot it was made on, even when another is on the canvas.
 */
export function revertAI(id) {
  const before = beforeAI.get(id);
  if (!before) return toast({ kind: "warn", title: "Can't revert that one", text: "Use Undo (⌘Z) instead." });
  if (before.kind === "video") {
    const now = allShots() ?? [{ scene: S.scene }];
    const whole = before.structural || now.length !== before.shots.length;
    const next = whole ? before.shots : now.map((x, i) => (before.changed.includes(i) ? before.shots[i] : x));
    const show = whole ? before.shot : (before.changed[0] ?? S.shot);
    set({ shots: next.length > 1 ? next : null, shot: next.length > 1 ? show : 0, scene: next[show].scene, past: [], future: [], selected: null, animSel: null, animRows: [], shotPulse: whole ? [] : before.changed });
    setTimeout(() => set({ shotPulse: [] }), 1800);
    scheduleLayout(0);
  } else if (!S.shots || S.shot === before.shot) {
    setScene(before.scene);
  } else {
    // Made on another shot: put that one back, and show it.
    const shots = allShots();
    if (shots[before.shot]) {
      shots[before.shot] = { ...shots[before.shot], scene: before.scene };
      set({ shots });
      goToShot(before.shot);
    }
  }
  beforeAI.delete(id);
  set({ ai: { ...S.ai, thread: S.ai.thread.map((m) => (m.id === id ? { ...m, reverted: true } : m)) } });
  persist();
}
export const canRevertAI = (id) => beforeAI.has(id);

export function newChat() {
  beforeAI.clear();
  set({ ai: { ...S.ai, thread: [], error: null } });
  persist();
}

// ---------------------------------------------------------------------------------------------
// Confirm dialog (custom; the web view has no native confirm())

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

// ---------------------------------------------------------------------------------------------
// Scenes: every design is saved as you work; these switch between them.

/** Start a clean canvas. The scene you were on is already saved in the Scenes list. */
export async function newScene() {
  await saveSceneNow();
  set({
    scene: { devices: [], background: DEFAULT_SCENE.background },
    shots: null,
    shot: 0,
    groups: null,
    group: 0,
    sceneId: null,
    sceneStamp: null,
    guide: null,
    stillPick: null,
    animSel: null,
    animRows: [],
    sceneName: "Untitled design",
    past: [],
    future: [],
    selected: null,
    render: null,
    renderStale: false,
    view: "canvas",
    scenesOpen: false,
    ai: { ...S.ai, thread: [] },
  });
  scheduleLayout(0);
  persist();
}

export async function openScene(id) {
  if (id === S.sceneId) return set({ scenesOpen: false, scenesPage: false });
  await saveSceneNow();
  try {
    const saved = await api(`/api/scene?id=${encodeURIComponent(id)}`);
    // A video of several shots opens on its first; a design at several sizes on its first size.
    const shots = saved.shots?.length > 1 ? saved.shots.map((x, i) => (i === 0 ? { ...x, scene: saved.scene } : x)) : null;
    const groups = saved.groups?.length > 1 ? saved.groups : null;
    set({ scene: saved.scene, shots, shot: 0, groups, group: 0, sceneId: saved.id, sceneStamp: saved.updatedAt, guide: null, stillPick: null, animSel: null, animRows: [], sceneName: saved.name, past: [], future: [], selected: null, render: null, renderStale: false, view: "canvas", scenesOpen: false, scenesPage: false, ai: { ...S.ai, thread: saved.chat ?? [] } });
    scheduleLayout(0);
    persist();
  } catch (e) {
    fail(e, "Couldn't open the design");
    refreshScenes();
  }
}

export async function saveNow() {
  if (!S.scene.devices.length && !S.scene.headline) return toast({ kind: "warn", title: "Nothing to save yet", text: "Add a screenshot first." });
  await saveSceneNow();
  toast({ kind: "ok", title: "Saved", text: `“${S.sceneName}” is in your scenes.`, timeout: 2200 });
}

/** Rename a saved scene: to `to`, or to what the person types in a sheet. */
/**
 * Agents can save scenes through the MCP server. If one replaced the scene that's open, put its
 * version on the canvas (one undo step); if one added scenes, say so. `known` is the ids listed
 * before this check, or null the first time.
 */
export async function pickUpAgentChanges(scenes, known) {
  const mine = S.sceneId && scenes.find((x) => x.id === S.sceneId);
  if (mine && mine.by === "agent" && mine.updatedAt !== S.sceneStamp && !savePending() && !S.ai.busy) {
    try {
      const saved = await api(`/api/scene?id=${encodeURIComponent(mine.id)}`);
      // A design at several sizes: the saved one has every size (an agent's save of the first size
      // is merged in), so take all of it when it differs, on the size that was showing.
      const theirSizes = saved.groups?.length > 1 ? saved.groups : null;
      const ourSizes = allGroups();
      if (theirSizes || ourSizes) {
        const bare = (gs) => gs?.map((g) => g.shots.map((x) => [x.scene, x.length, x.transition]));
        if (JSON.stringify(bare(theirSizes)) !== JSON.stringify(bare(ourSizes))) {
          const group = theirSizes ? Math.min(S.group, theirSizes.length - 1) : 0;
          const shots = theirSizes ? theirSizes[group].shots : saved.shots?.length > 1 ? saved.shots.map((x, i) => (i === 0 ? { ...x, scene: saved.scene } : x)) : [{ scene: saved.scene }];
          const shot = Math.min(group === S.group ? S.shot : 0, shots.length - 1);
          set({ sceneStamp: saved.updatedAt, groups: theirSizes, group, shots: shots.length > 1 ? shots : null, shot: shots.length > 1 ? shot : 0, scene: shots[shot].scene, sceneName: saved.name, past: [], future: [], selected: null, render: null, renderStale: false });
          scheduleLayout(0);
          toast({ kind: "ok", icon: "spark", title: "An agent updated this design", text: theirSizes ? `${theirSizes.length} sizes.` : undefined, timeout: 9000 });
        } else set({ sceneStamp: saved.updatedAt });
        return;
      }
      // An agent saved a video of several shots (or made this one single again): take all of it.
      const theirs = saved.shots?.length > 1 ? saved.shots.map((x, i) => (i === 0 ? { ...x, scene: saved.scene } : x)) : null;
      const ours = allShots();
      if ((theirs || ours) && JSON.stringify(theirs?.map((x) => [x.scene, x.length, x.transition])) !== JSON.stringify(ours?.map((x) => [x.scene, x.length, x.transition]))) {
        const shot = theirs ? Math.min(S.shot, theirs.length - 1) : 0;
        set({ sceneStamp: saved.updatedAt, shots: theirs, shot, scene: theirs ? theirs[shot].scene : saved.scene, sceneName: saved.name, past: [], future: [], selected: null, render: null, renderStale: false });
        scheduleLayout(0);
        toast({ kind: "ok", icon: "spark", title: theirs ? `An agent updated this video (${theirs.length} shots)` : "An agent updated this design", timeout: 9000 });
        return;
      }
      // An agent saves the design's first shot: on the canvas if that's the one showing.
      const elsewhere = S.shots && S.shot !== 0;
      const differs = JSON.stringify(saved.scene) !== JSON.stringify(elsewhere ? S.shots[0].scene : S.scene);
      set({ sceneStamp: saved.updatedAt });
      if (differs && elsewhere) {
        set({ shots: S.shots.map((x, i) => (i === 0 ? { ...x, scene: saved.scene } : x)) });
        toast({ kind: "ok", icon: "spark", title: "An agent updated shot 1", timeout: 9000, actions: [{ label: "Show it", run: () => goToShot(0) }] });
      } else if (differs) {
        setScene(saved.scene);
        set({ sceneName: saved.name, selected: null, render: null, renderStale: false });
        toast({ kind: "ok", icon: "spark", title: "An agent updated this design", text: "Its version is on the canvas.", timeout: 9000, actions: [{ label: "Undo", run: () => undo() }] });
      }
    } catch {
      // The scene went away in the meantime: the next save recreates it.
    }
  } else if (mine && !S.sceneStamp) {
    set({ sceneStamp: mine.updatedAt });
  }
  if (!known) return;
  const added = scenes.filter((x) => x.by === "agent" && !known.has(x.id));
  if (added.length === 1) toast({ kind: "ok", icon: "spark", title: "An agent saved a design", text: added[0].name, timeout: 9000, actions: [{ label: "Open", run: () => openScene(added[0].id) }] });
  else if (added.length > 1) toast({ kind: "ok", icon: "spark", title: `An agent saved ${added.length} designs`, text: added.map((x) => x.name).join(", "), timeout: 9000, actions: [{ label: "See them", run: () => set({ scenesPage: true }) }] });
}

export async function renameSavedScene(id, to) {
  const current = S.scenes.find((x) => x.id === id);
  const name = to ?? (await promptDialog({ title: "Rename design", value: current?.name ?? S.sceneName, confirm: "Rename" }));
  if (!name?.trim() || name.trim() === current?.name) return;
  set({ scenes: S.scenes.map((x) => (x.id === id ? { ...x, name: name.trim() } : x)) });
  if (id === S.sceneId) {
    set({ sceneName: name.trim() });
    persist();
    return saveSceneNow();
  }
  try {
    const saved = await api(`/api/scene?id=${encodeURIComponent(id)}`);
    await api("/api/scenes/save", { id, name: name.trim(), scene: saved.scene });
    refreshScenes();
  } catch (e) {
    fail(e, "Couldn't rename");
  }
}

export async function duplicateSavedScene(id) {
  if (id === S.sceneId) await saveSceneNow();
  try {
    const copy = await api("/api/scenes/duplicate", { id });
    await refreshScenes();
    set({ freshScene: copy.id });
    setTimeout(() => S.freshScene === copy.id && set({ freshScene: null }), 1600);
    toast({ kind: "ok", title: "Duplicated", text: copy.name, actions: [{ label: "Open", run: () => openScene(copy.id) }] });
  } catch (e) {
    fail(e, "Couldn't duplicate");
  }
}

export async function deleteSavedScene(id) {
  const target = S.scenes.find((x) => x.id === id);
  const ok = await confirmDialog({ title: `Delete “${target?.name ?? "this design"}”?`, text: "It's removed from My designs. Your screenshots and exports stay in the output folder.", confirm: "Delete", danger: true });
  if (!ok) return;
  try {
    await api("/api/scenes/delete", { id });
    if (id === S.sceneId) {
      set({ sceneId: null });
      await newScene();
    }
    await refreshScenes();
  } catch (e) {
    fail(e, "Couldn't delete");
  }
}

// A one-line text prompt, in the app's own sheet style.
let promptResolve = null;
export function promptDialog(opts) {
  return new Promise((resolve) => {
    promptResolve?.(null);
    promptResolve = resolve;
    set({ modal: { kind: "prompt", ...opts } });
  });
}
export function answerPrompt(value) {
  const r = promptResolve;
  promptResolve = null;
  set({ modal: null });
  r?.(value);
}
