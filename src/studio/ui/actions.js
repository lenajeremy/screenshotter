// Everything the UI can do to the scene or the engine, shared by panels, canvas, keys and menus.
import { S, api, base, edit, entityLabel, fail, isVideo, native, r4, refreshFiles, set, setScene, task, tidy, toast, touch } from "./store.js";

const clone = (v) => JSON.parse(JSON.stringify(v));
const idx = (id) => Number(String(id).split("-")[1]) - 1;

// ---------------------------------------------------------------------------------------------
// Devices

/** A recording that belongs to a poster frame (same name, .mp4). */
export function recordingFor(p) {
  const stem = p.replace(/\.(png|jpe?g|webp)$/i, "");
  return S.files.find((f) => f.path === `${stem}.mp4` || f.path === `${stem}.mov`)?.path;
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
  setScene(next);
  set({ selected: `device-${next.devices.length}`, view: "canvas", replacing: null });
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
  });
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

export async function exportImage() {
  if (!S.scene.devices.length) return toast({ kind: "warn", title: "Add a screenshot first" });
  if (S.rendering) return;
  const started = performance.now();
  set({ rendering: { label: "Rendering full resolution…" }, view: "render", exportOpen: false });
  try {
    const r = await api("/api/mockup", deliveryRequest());
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
    const r = await api("/api/video", { ...clone(S.scene), video, format: v.format, preview: false });
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
  setTimeout(() => document.querySelector(".ai-inner textarea")?.focus(), 30);
}

export async function aiEdit(text) {
  const instruction = text.trim();
  if (!instruction || S.ai.busy) return;
  if (!S.scene.devices.length) return set({ ai: { ...S.ai, error: "Add a screenshot to the scene first, then describe the change." } });
  const snapshot = S.scene;
  const selection = S.ai.context ? S.selected || undefined : undefined;
  const history = [...S.ai.history.filter((h) => h !== instruction), instruction].slice(-20);
  set({ ai: { ...S.ai, busy: true, error: null, history } });
  try {
    const r = await api("/api/ai-edit", { request: snapshot, instruction, selection, model: S.ai.model || undefined });
    if (S.scene !== snapshot) throw new Error("The scene changed while Claude was working. Try again.");
    if (!r.operations?.length) {
      set({ ai: { ...S.ai, busy: false, error: r.summary || "Claude didn't change anything." } });
      return;
    }
    setScene(r.request);
    if (r.changed.some((c) => c.startsWith("device"))) touch("moved");
    if (r.changed.includes("background")) touch("backdrop");
    const pulse = r.changed.filter((c) => !["background", "canvas"].includes(c));
    set({ ai: { ...S.ai, busy: false, open: false, text: "", error: null, last: r }, pulse, view: "canvas" });
    setTimeout(() => set({ pulse: [] }), 1700);
    toast({
      kind: "ai",
      title: r.summary,
      text: `${r.operations.length} change${r.operations.length === 1 ? "" : "s"} · ${r.provider === "api" ? r.model ?? "Claude" : "via Claude Code"}`,
      timeout: 8000,
      actions: [{ label: "Undo", run: () => import("./store.js").then((m) => m.undo()) }, { label: "Preview", run: renderPreview }],
    });
  } catch (e) {
    set({ ai: { ...S.ai, busy: false, error: e.message } });
  }
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

export function newScene() {
  confirmDialog({ title: "Start a new scene?", text: "The current layout is cleared. Your captures stay in the library, and Undo brings the scene back.", confirm: "New scene" }).then((ok) => {
    if (!ok) return;
    setScene({ devices: [], background: S.scene.background });
    set({ selected: null, sceneName: "Untitled scene", render: null, renderStale: false, view: "canvas" });
  });
}
