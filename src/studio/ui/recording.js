// A screen recording from the capture bar, as the Studio edits it: its cursor log (loaded once),
// the cursor's path for the canvas, the calmer one the camera follows, and the zooms auto zoom
// makes on the clicks. The drawing itself uses the engine's cursor module, as the export does.
import { autoZooms, cursorAt, readLog, trackOf } from "./cursor.js";
import { CAMERA } from "./animate.js";
import { S, edit, fileUrl, set } from "./store.js";

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

/** The cursor's path at this smoothness, once the log is in. */
export function cursorTrack(path, smooth = 0.5) {
  const log = logFor(path);
  if (!log) return undefined;
  const key = `${path}|${smooth}`;
  if (!tracks.has(key)) tracks.set(key, trackOf(log, smooth));
  return tracks.get(key);
}

/** The log itself, waiting for it if it isn't in yet. */
export async function cursorLog(path) {
  const now = logFor(path);
  if (now) return now;
  await logs.get(path);
  return logs.get(path);
}

/** The recording's layer (the first device) on the canvas, as canvas fractions. */
function recordingBox() {
  const e = S.layout?.entities.find((x) => x.id === "device-1");
  return e ? { x: e.x - e.width / 2, y: e.y - e.height / 2, w: e.width, h: e.height } : { x: 0, y: 0, w: 1, h: 1 };
}

/** What the camera follows when zoomed in (follow on): the cursor on a calmer path. Undefined otherwise. */
export function cameraFollow(scene = S.scene) {
  const rec = scene.recording;
  if (!rec?.follow || !rec.cursor?.log) return undefined;
  const calm = cursorTrack(rec.cursor.log, 1);
  if (!calm) return undefined;
  const box = recordingBox();
  return (t) => {
    const p = cursorAt(calm, t);
    return p && { x: box.x + p.x * box.w, y: box.y + p.y * box.h };
  };
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
  const made = log ? autoZooms(trackOf(log, 0), rec.duration ?? Infinity, zoom) : [];
  edit((d) => {
    const own = (d.animations ?? []).filter((a) => !(a.auto && [a.targets].flat().includes(CAMERA)));
    d.animations = [...own, ...made].sort((a, b) => a.at - b.at);
    if (!d.animations.length) delete d.animations;
    d.recording = { ...d.recording, autoZoom: on, zoom };
  });
  set({ animSel: null });
  return made.length;
}
