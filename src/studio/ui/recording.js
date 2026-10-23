// A screen recording from the capture bar, as the Studio edits it: its cursor log (loaded once),
// the cursor's path for the canvas, the calmer one the camera follows, and the zooms auto zoom
// makes on the clicks. The drawing itself uses the engine's cursor module, as the export does.
import { autoZooms, cursorAt, readLog, trackOf } from "./cursor.js";
import { cutLog, tidyCuts } from "./cuts.js";
import { CAMERA } from "./animate.js";
import { DEFAULT_SCENE, S, edit, fileUrl, set } from "./store.js";

const logs = new Map();
const tracks = new Map();

/** The recording's cursor log, loading it the first time (the canvas redraws when it's in). */
function logFor(path) {
  if (!path) return undefined;
  const got = logs.get(path);
  if (got && !(got instanceof Promise)) return got;
  if (!got) {
    logs.set(
      path,
      fetch(fileUrl(path))
        .then((r) => (r.ok ? r.json() : null))
        .then((raw) => {
          logs.set(path, readLog(raw));
          set({ cursorStamp: Date.now() });
        })
        .catch(() => logs.set(path, readLog(null))),
    );
  }
  return undefined;
}

/** The parts cut out of the recording (its devices carry them). */
const cutsIn = (scene = S.scene) => tidyCuts(scene.devices?.find((d) => d.video && d.cuts?.length)?.cuts);

/** The cursor's path at this smoothness, once the log is in, with the parts cut out of the recording taken out. */
export function cursorTrack(path, smooth = 0.5, cuts = cutsIn()) {
  const log = logFor(path);
  if (!log) return undefined;
  const key = `${path}|${smooth}|${JSON.stringify(cuts)}`;
  if (!tracks.has(key)) tracks.set(key, trackOf(cuts.length ? cutLog(log, cuts) : log, smooth));
  return tracks.get(key);
}

/** The log itself, waiting for it if it isn't in yet. */
export async function cursorLog(path) {
  const now = logFor(path);
  if (now) return now;
  await logs.get(path);
  return logs.get(path);
}

/**
 * The recording's layer (the first device) on the canvas, as canvas fractions. The canvas has the
 * recording's own shape, so its height says its width too.
 */
function recordingBox(scene = S.scene) {
  const d = scene.devices?.[0];
  const h = d?.height ?? 1;
  return { x: (d?.x ?? 0.5) - h / 2, y: (d?.y ?? 0.5) - h / 2, w: h, h };
}

/** What the camera follows when zoomed in (follow on): the cursor on a calmer path. Undefined otherwise. */
export function cameraFollow(scene = S.scene) {
  const rec = scene.recording;
  if (!rec?.follow || !rec.cursor?.log) return undefined;
  const calm = cursorTrack(rec.cursor.log, 1);
  if (!calm) return undefined;
  const box = recordingBox(scene);
  return (t) => {
    const p = cursorAt(calm, t);
    return p && { x: box.x + p.x * box.w, y: box.y + p.y * box.h };
  };
}

/**
 * The recording's frame, as Screen Studio has it: padding (the backdrop showing round it), rounded
 * corners and a shadow. Padding over a plain black backdrop brings in the usual one, to see.
 */
export async function setFrame({ padding, radius, shadow }) {
  edit((d) => {
    const dev = d.devices[0];
    if (padding !== undefined) {
      const h = Math.round((1 - 2 * Math.max(0, padding)) * 10000) / 10000;
      Object.assign(dev, { x: 0.5, y: 0.5, height: h });
      if (h < 1 && (!d.background || d.background === "#000000")) d.background = DEFAULT_SCENE.background;
    }
    if (radius !== undefined) dev.radius = radius > 0 ? Math.round(radius * 1000) / 1000 : undefined;
    if (shadow !== undefined) dev.shadow = shadow;
  });
  // Zooms on the clicks follow the recording to where it now sits.
  if (padding !== undefined && S.scene.recording?.autoZoom) await setAutoZoom(true);
}

/** Change the recording's settings (cursor, zoom, sound). */
export function setRecording(patch) {
  edit((d) => {
    d.recording = { ...d.recording, ...patch };
    if (patch.cursor) d.recording.cursor = { ...S.scene.recording?.cursor, ...patch.cursor };
  });
}

/**
 * Auto zoom on or off. On: zooms onto the clicks (camera moves of the Studio's own kind, marked as
 * made automatically) replace any it made before; moves made by hand stay. Off: its moves go.
 */
export async function setAutoZoom(on, zoom = S.scene.recording?.zoom ?? 1.8) {
  const rec = S.scene.recording;
  const log = on && rec?.cursor?.log ? await cursorLog(rec.cursor.log) : null;
  // On the recording wherever it sits (padded, it doesn't fill the canvas).
  const cuts = cutsIn();
  const made = log ? autoZooms(trackOf(cuts.length ? cutLog(log, cuts) : log, 0), rec.duration ?? Infinity, zoom, recordingBox()) : [];
  edit((d) => {
    const own = (d.animations ?? []).filter((a) => !(a.auto && [a.targets].flat().includes(CAMERA)));
    d.animations = [...own, ...made].sort((a, b) => a.at - b.at);
    if (!d.animations.length) delete d.animations;
    d.recording = { ...d.recording, autoZoom: on, zoom };
  });
  set({ animSel: null });
  return made.length;
}
