// Everything the UI can do to the scene or the engine, shared by panels, canvas, keys and menus.
import { DEFAULT_SCENE, S, api, base, edit, entityLabel, fail, isVideo, native, persist, persistPrefs, r4, refreshFiles, refreshScenes, savePending, saveSceneNow, scheduleLayout, set, setScene, task, tidy, toast, touch, undo } from "./store.js";

const clone = (v) => JSON.parse(JSON.stringify(v));
const idx = (id) => Number(String(id).split("-")[1]) - 1;

// ---------------------------------------------------------------------------------------------
// Devices

/** A recording that belongs to a poster frame (same name, .mp4). */
export function recordingFor(p) {
  const stem = p.replace(/\.(png|jpe?g|webp)$/i, "");
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
export async function applyRecipe(id, { quiet = false } = {}) {
  const body = recipeInput();
  if (!body.devices.length) return toast({ kind: "warn", title: "Add a screenshot first", text: "Recipes use your own screens." });
  try {
    const { scene } = await api("/api/recipe", { id, ...body });
    setScene(scene);
    touch("backdrop");
    set({ view: "canvas", selected: null });
    const name = S.recipes?.find((r) => r.id === id)?.name ?? "the design";
    toast({ kind: "ok", title: quiet ? `Started you off with ${name}` : `Applied ${name}`, text: quiet ? "Undo (⌘Z) for a plain layout, or pick another in Designs." : "Undo (⌘Z) goes back.", timeout: 3200 });
  } catch (e) {
    fail(e, "Couldn't apply that design");
  }
}

/** Ask Claude for three directions, each rendered, to pick from. */
export async function designForMe() {
  if (!S.scene.devices.length) return toast({ kind: "warn", title: "Add a screenshot first" });
  if (S.directions?.busy) return;
  const started = Date.now();
  set({ directions: { busy: true, step: "look", started, items: [], error: null } });
  try {
    const res = await fetch("/api/ai-directions", {
      method: "POST",
      headers: { "x-screenshotter": "studio", "Content-Type": "application/json" },
      body: JSON.stringify({ request: S.scene, model: S.ai.model || undefined, preview: S.ai.preview !== false }),
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
        if (ev.type === "progress") set({ directions: { ...S.directions, step: ev.step === "check" ? "render" : ev.step } });
        else if (ev.type === "error") throw new Error(ev.error);
        else if (ev.type === "result") {
          set({ directions: { busy: false, items: ev.directions, took: Math.round((Date.now() - started) / 1000), base: S.scene } });
          return;
        }
      }
    }
    throw new Error("It stopped before it finished. Try again.");
  } catch (e) {
    set({ directions: { busy: false, items: [], error: e.message } });
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
  if (pristine) return applyRecipe("bold-hero", { quiet: true });
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
  set({ selected: `device-${Math.min(i, S.scene.devices.length - 1) + 1}`, replacing: null, view: "canvas" });
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

export async function exportVideo() {
  if (!S.scene.devices.length) return toast({ kind: "warn", title: "Add a screenshot first" });
  if (S.rendering) return;
  const v = S.exportOpts.video;
  const started = performance.now();
  set({ rendering: { label: `Rendering ${v.duration}s video… this takes a little while` }, view: "render", exportOpen: false });
  try {
    const video = tidy({ duration: v.duration, motion: v.motion, zoom: v.zoom ? { start: v.duration * 0.35, end: v.duration * 0.85 } : undefined });
    const r = await api(`/api/video${historyQuery()}`, { ...clone(S.scene), video, format: v.format, preview: false });
    renderResult(r, { preview: false, isVideo: v.format !== "gif", ms: performance.now() - started });
    touch("exported");
    refreshFiles();
    toast({ kind: "ok", title: "Video exported", text: `${base(r.path)} · ${r.width}×${r.height} · ${r.duration?.toFixed?.(1) ?? v.duration}s`, actions: [{ label: "Show in Finder", run: () => reveal(r.path) }] });
  } catch (e) {
    fail(e, "Video export failed");
  } finally {
    set({ rendering: null });
  }
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
  set({ ai: { ...S.ai, open: true, error: null, context: context !== false }, selected: typeof context === "string" ? context : S.selected, view: "canvas" });
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

export async function aiEdit(text) {
  const instruction = text.trim();
  if (!instruction || S.ai.busy) return;
  const selection = S.ai.context ? S.selected || undefined : undefined;
  const history = chatHistory();
  const recall = [...S.ai.history.filter((h) => h !== instruction), instruction].slice(-20);
  const user = msg({ role: "user", text: instruction, about: selection ? entityLabel(selection) : undefined });
  set({ ai: { ...S.ai, open: true, busy: true, text: "", error: null, history: recall, thread: [...S.ai.thread, user] } });
  if (!S.scene.devices.length) {
    set({ ai: { ...S.ai, busy: false, thread: [...S.ai.thread, msg({ role: "error", text: "Add a screenshot to the scene first, then describe the change." })] } });
    return;
  }
  const snapshot = S.scene;
  const started = Date.now();
  set({ ai: { ...S.ai, work: { started, step: "look", image: null, items: [], retry: null } } });
  const work = (patch) => set({ ai: { ...S.ai, work: { ...S.ai.work, ...patch } } });
  try {
    const r = await streamEdit({ request: snapshot, instruction, selection, history, model: S.ai.model || undefined, preview: S.ai.preview !== false }, (p) => {
      if (p.step === "look") work({ step: "look", ...(p.image ? { image: `data:image/jpeg;base64,${p.image}` } : {}) });
      else if (p.step === "read") work({ step: "read", items: p.items });
      else if (p.step === "think") work({ step: "think" });
      else if (p.step === "retry") work({ step: "think", retry: p.reason });
      else if (p.step === "check") work({ step: "check", checkImage: `data:image/jpeg;base64,${p.image}` });
    });
    if (S.scene !== snapshot) throw new Error("The design changed while Claude was working. Ask again.");
    const via = r.provider === "api" ? r.model ?? "Claude" : "Claude Code";
    const took = Math.max(1, Math.round((Date.now() - started) / 1000));
    const steps = { items: S.ai.work?.items ?? [], retried: Boolean(S.ai.work?.retry), checked: r.checked, remembered: r.remembered };
    if (!r.operations?.length) {
      const answer = msg({ role: "assistant", text: r.summary || "I didn't change anything.", via, took, steps, remembered: r.remembered, fresh: true });
      set({ ai: { ...S.ai, busy: false, work: null, thread: [...S.ai.thread, answer] } });
      settle(answer.id);
      persist();
      return;
    }
    const ops = r.operations.map((o) => describeOp(o, r.request));
    const reply = msg({ role: "assistant", text: r.summary, changes: r.operations.length, changed: r.changed.map((c) => entityLabel(c, r.request)), ops, via, took, steps, remembered: r.remembered, fresh: true });
    beforeAI.set(reply.id, snapshot);
    setScene(r.request);
    if (r.changed.some((c) => c.startsWith("device"))) touch("moved");
    if (r.changed.includes("background")) touch("backdrop");
    const pulse = r.changed.filter((c) => !["background", "canvas"].includes(c));
    set({ ai: { ...S.ai, busy: false, work: null, error: null, last: r, thread: [...S.ai.thread, reply] }, pulse, view: "canvas" });
    setTimeout(() => set({ pulse: [] }), 1700);
    settle(reply.id);
    persist();
  } catch (e) {
    set({ ai: { ...S.ai, busy: false, work: null, thread: [...S.ai.thread, msg({ role: "error", text: e.message, retry: instruction })] } });
  }
}

/** A new reply animates in once; after that it's just text (also when the chat is reopened). */
function settle(id) {
  setTimeout(() => set({ ai: { ...S.ai, thread: S.ai.thread.map((m) => (m.id === id ? { ...m, fresh: false } : m)) } }), 2600);
}

/** POST an edit and read the engine's progress lines as they arrive; resolves with the result. */
async function streamEdit(body, onProgress) {
  let res;
  try {
    res = await fetch("/api/ai-edit?stream=1", { method: "POST", headers: { "x-screenshotter": "studio", "Content-Type": "application/json" }, body: JSON.stringify(body) });
  } catch {
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
  rotateY: "Turn", rotateX: "Tilt", rotate: "Rotation", height: "Size", width: "Size", x: "Position", y: "Position", anchor: "Position",
  color: "Colour", accentColor: "Accent colour", headline: "Headline", subheadline: "Subheadline", headlineSize: "Headline size",
  subheadlineSize: "Subheadline size", font: "Font", headlineWeight: "Weight", weight: "Weight", letterSpacing: "Tracking",
  uppercase: "Uppercase", align: "Alignment", position: "Placement", shadow: "Shadow", glare: "Glare", frame: "Frame",
  device: "Model", side: "Side", highlights: "Call-outs", text: "Words", size: "Size", background: "Backdrop", opacity: "Opacity",
  canvas: "Image size", layout: "Arrangement", effects: "Film look", grain: "Grain", vignette: "Vignette", grade: "Colour grade",
  edgeBlur: "Edge blur", screenshot: "Screenshot", texts: "Text", devices: "Device", blur: "Blur", dim: "Dim", look: "Look",
};

/** One operation in plain words: what it touched, which property, and the new value. */
function describeOp(op, scene) {
  const parts = op.path.split("/").slice(1).map((p) => p.replace(/~1/g, "/").replace(/~0/g, "~"));
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
  return { target, prop: op.op === "append" ? `Added ${prop.toLowerCase()}` : prop, value: op.op === "append" ? "" : short(value) + (typeof value === "number" ? unit : ""), color };
}

/** Put the design back to how it was before one of Claude's changes. */
export function revertAI(id) {
  const before = beforeAI.get(id);
  if (!before) return toast({ kind: "warn", title: "Can't revert that one", text: "Use Undo (⌘Z) instead." });
  setScene(before);
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
    sceneId: null,
    sceneStamp: null,
    sceneName: "Untitled scene",
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
    set({ scene: saved.scene, sceneId: saved.id, sceneStamp: saved.updatedAt, sceneName: saved.name, past: [], future: [], selected: null, render: null, renderStale: false, view: "canvas", scenesOpen: false, scenesPage: false, ai: { ...S.ai, thread: saved.chat ?? [] } });
    scheduleLayout(0);
    persist();
  } catch (e) {
    fail(e, "Couldn't open the scene");
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
      const differs = JSON.stringify(saved.scene) !== JSON.stringify(S.scene);
      set({ sceneStamp: saved.updatedAt });
      if (differs) {
        setScene(saved.scene);
        set({ sceneName: saved.name, selected: null, render: null, renderStale: false });
        toast({ kind: "ok", icon: "spark", title: "An agent updated this scene", text: "Its version is on the canvas.", timeout: 9000, actions: [{ label: "Undo", run: () => undo() }] });
      }
    } catch {
      // The scene went away in the meantime: the next save recreates it.
    }
  } else if (mine && !S.sceneStamp) {
    set({ sceneStamp: mine.updatedAt });
  }
  if (!known) return;
  const added = scenes.filter((x) => x.by === "agent" && !known.has(x.id));
  if (added.length === 1) toast({ kind: "ok", icon: "spark", title: "An agent saved a scene", text: added[0].name, timeout: 9000, actions: [{ label: "Open", run: () => openScene(added[0].id) }] });
  else if (added.length > 1) toast({ kind: "ok", icon: "spark", title: `An agent saved ${added.length} scenes`, text: added.map((x) => x.name).join(", "), timeout: 9000, actions: [{ label: "See them", run: () => set({ scenesPage: true }) }] });
}

export async function renameSavedScene(id, to) {
  const current = S.scenes.find((x) => x.id === id);
  const name = to ?? (await promptDialog({ title: "Rename scene", value: current?.name ?? S.sceneName, confirm: "Rename" }));
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
  const ok = await confirmDialog({ title: `Delete “${target?.name ?? "this scene"}”?`, text: "The scene is removed from your scenes. Captures and exports stay in the output folder.", confirm: "Delete", danger: true });
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
