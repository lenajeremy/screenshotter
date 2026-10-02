// Left panels: Screenshots, Templates, Backdrop, Text and Shapes. Also the layers list and the exports grid.
import { useEffect, useRef, useState } from "preact/hooks";
import { AccentText, ColorButton, Dropdown, Seg, Slider, Section, Switch, TextField, html } from "./controls.js";
import { Icon, LayoutIcon } from "./icons.js";
import { IMAGE_PROVIDERS, S, aiName, api, base, edit, entityLabel, fail, fileUrl, isVideo, persistPrefs, pictureName, refreshFiles, set, thumbUrl, touch, useStore, pictureUrl } from "./store.js";
import { renderShape, shapeSpec } from "./shapes.js";
import {
  SHAPE_KINDS,
  TEXT_PRESETS,
  AWARD_PRESETS,
  BADGE_PRESETS,
  addPicture,
  addPresetShape,
  addSticker,
  addArt,
  replaceImage,
  uploadImages,
  addShape,
  setBackdropAcross,
  deleteEntity,
  addCaption,
  addDevice,
  addText,
  captureMac,
  captureSimulator,
  captureWeb,
  deleteFile,
  recordSimulator,
  recordingFor,
  restoreVersion,
  applyRecipe,
  applySetTemplate,
  applyMyTemplate,
  deleteMyTemplate,
  importTemplateFile,
  refreshMyTemplates,
  saveAsTemplate,
  setTemplateInput,
  shareTemplate,
  applyDirection,
  designForMe,
  stopDesignForMe,
  recipeInput,
  reveal,
  uploadFiles,
  useCapture,
} from "./actions.js";

const setCap = (patch) => set({ capture: { ...S.capture, ...patch } });

// =============================================================================================
// Captures

async function loadApps() {
  const c = S.capture;
  const key = `${c.simulator}|${c.system}`;
  if (S.apps.loading || S.apps.for === key) return;
  set({ apps: { ...S.apps, loading: true, for: key } });
  try {
    const r = await api(`/api/apps?simulator=${encodeURIComponent(c.simulator)}&system=${c.system ? 1 : 0}`);
    set({ apps: { list: r.apps, loading: false, for: key } });
  } catch (e) {
    set({ apps: { list: [], loading: false, for: "" } });
    fail(e, "Couldn't list apps");
  }
}

function SimulatorForm() {
  const s = useStore();
  const c = s.capture;
  const sims = s.opts?.simulators ?? [];
  useEffect(() => {
    if (sims.length) loadApps();
  }, [c.simulator, c.system, sims.length]);
  if (!sims.length) {
    return html`<div class="note">No simulators found. Install Xcode and a simulator runtime, then restart Screenshotter. You can still import screenshots or capture websites.</div>`;
  }
  const simOpts = [
    { value: "", label: "Any open simulator", hint: "or the newest iPhone" },
    ...sims.map((x) => ({ value: x.udid, label: x.name, hint: `${x.state === "Booted" ? "● " : ""}${x.runtimeName ?? ""}`, group: x.name.startsWith("iPad") ? "iPad" : x.name.includes("Watch") ? "Watch" : x.name.includes("Vision") ? "Vision" : "iPhone" })),
  ];
  const appOpts = [{ value: "", label: "Home screen" }, ...s.apps.list.map((a) => ({ value: a.bundleId, label: a.name, hint: a.bundleId }))];
  return html`<div class="vstack">
    <div class="row"><label>Device</label><${Dropdown} value=${c.simulator} options=${simOpts} search onChange=${(v) => setCap({ simulator: v, bundleId: "" })} /></div>
    <div class="row"><label>App</label>
      <${Dropdown} value=${c.bundleId} options=${appOpts} search placeholder=${s.apps.loading ? "Loading apps…" : "Home screen"} onChange=${(v) => setCap({ bundleId: v })} />
    </div>
    <button class="more-toggle" onClick=${() => setCap({ more: !c.more })}><${Icon} n=${c.more ? "down" : "right"} s=${12} />Options</button>
    ${c.more &&
    html`<div class="vstack">
      <div class="row"><label>Open link</label><${TextField} value=${c.deepLink} placeholder="myapp://screen" onChange=${(v) => setCap({ deepLink: v })} /></div>
      <div class="row"><label>Look</label><${Seg} value=${c.appearance} options=${[{ value: "light", label: "Light", icon: "sun" }, { value: "dark", label: "Dark", icon: "moon" }]} onChange=${(v) => setCap({ appearance: v })} /></div>
      <div class="row"><label>Time</label><${TextField} value=${c.time} placeholder="9:41" onChange=${(v) => setCap({ time: v })} /></div>
      <${Switch} checked=${c.grant} onChange=${(v) => setCap({ grant: v })} label="Allow permission pop-ups for me" />
      <${Switch} checked=${c.system} onChange=${(v) => setCap({ system: v })} label="Show system apps" />
    </div>`}
    <div class="grid2" style=${{ gridTemplateColumns: "1fr auto" }}>
      <button class="btn primary" disabled=${Boolean(s.busy)} onClick=${captureSimulator}><${Icon} n="camera" s=${15} />Capture</button>
      <button class="btn" disabled=${Boolean(s.busy)} title="Record 6 seconds of the screen" onClick=${() => recordSimulator(6)}><${Icon} n="record" s=${14} style=${{ color: "#ff5d5d" }} />Record</button>
    </div>
  </div>`;
}

function WebForm() {
  const s = useStore();
  const c = s.capture;
  const vps = s.opts?.webViewports ?? ["iphone", "ipad", "desktop"];
  return html`<div class="vstack">
    <div class="input-wrap"><${Icon} n="link" s=${14} /><input class="input" placeholder="example.com" value=${c.url} onInput=${(e) => setCap({ url: e.target.value })}
      onKeyDown=${(e) => {
        e.stopPropagation();
        if (e.key === "Enter") captureWeb();
      }} /></div>
    <div class="chips">${vps.map((v) => html`<button class="chip sm ${c.viewport === v ? "on" : ""}" onClick=${() => setCap({ viewport: v })}>${v}</button>`)}</div>
    <div class="row"><label>Look</label><${Seg} value=${c.scheme} options=${[{ value: "light", label: "Light", icon: "sun" }, { value: "dark", label: "Dark", icon: "moon" }]} onChange=${(v) => setCap({ scheme: v })} /></div>
    <button class="btn primary" disabled=${Boolean(s.busy)} onClick=${captureWeb}><${Icon} n="globe" s=${15} />Capture page</button>
  </div>`;
}

function MacForm() {
  const s = useStore();
  const c = s.capture;
  const [wins, setWins] = useState(null);
  const load = () =>
    api("/api/mac-windows")
      .then(setWins)
      .catch(() => setWins([]));
  useEffect(() => {
    load();
  }, []);
  const apps = [...new Map((wins ?? []).map((w) => [w.app, w])).values()];
  const opts = [{ value: "", label: "Entire screen" }, ...apps.map((w) => ({ value: w.app, label: w.app, hint: w.title?.slice(0, 30) }))];
  return html`<div class="vstack">
    <div class="hstack"><div class="grow"><${Dropdown} value=${c.macWindow} options=${opts} search placeholder=${wins ? "Choose a window" : "Loading windows…"} onChange=${(v) => setCap({ macWindow: v })} /></div>
      <button class="icon-btn" title="Refresh" onClick=${load}><${Icon} n="refresh" s=${14} /></button></div>
    <div class="note">macOS may ask to allow <b>Screen Recording</b> for Screenshotter the first time.</div>
    <button class="btn primary" disabled=${Boolean(s.busy)} onClick=${captureMac}><${Icon} n="monitor" s=${15} />Capture ${c.macWindow ? "window" : "screen"}</button>
  </div>`;
}

function ImportForm() {
  const input = useRef();
  const [over, setOver] = useState(false);
  return html`<div class="dropzone ${over ? "over" : ""}" onClick=${() => input.current.click()}
      onDragOver=${(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave=${() => setOver(false)}
      onDrop=${() => setOver(false)}>
    <${Icon} n="upload" s=${22} />
    <b style=${{ color: "var(--text)", fontWeight: 600 }}>Drop screenshots or recordings</b>
    <span class="note">PNG, JPEG, WebP, MP4 or MOV. Or paste with <span class="kbd">⌘V</span></span>
    <input type="file" ref=${input} hidden multiple accept="image/png,image/jpeg,image/webp,video/mp4,video/quicktime" onChange=${(e) => {
      uploadFiles(e.target.files);
      e.target.value = "";
    }} />
  </div>`;
}

const SOURCES = [
  { id: "simulator", label: "Simulator", icon: "sim" },
  { id: "web", label: "Website", icon: "globe" },
  { id: "mac", label: "Mac app", icon: "monitor" },
  { id: "import", label: "Import", icon: "upload" },
];

function Shot({ f, used, replacing }) {
  const video = recordingFor(f.path);
  const [wide, setWide] = useState(false);
  const stop = (e) => e.stopPropagation();
  return html`<div class="shot ${used ? "used" : ""} ${wide ? "wide" : ""}" data-file=${f.path} data-kind="shot" draggable="true" title=${`${base(f.path)}\nClick to use · drag onto the canvas`}
      onDragStart=${(e) => {
        e.dataTransfer.setData("application/x-screenshot", f.path);
        e.dataTransfer.effectAllowed = "copy";
      }}
      onClick=${() => useCapture(f.path)}>
    <img loading="lazy" src=${thumbUrl(f.path, 300)} onLoad=${(e) => setWide(e.target.naturalWidth > e.target.naturalHeight * 0.9)} />
    <div class="veil"></div>
    ${video && html`<span class="badge"><${Icon} n="play" s=${9} />Video</span>`}
    ${used && !video && html`<span class="used-dot"><${Icon} n="check" s=${12} w=${2.6} /></span>`}
    <div class="tools" onClick=${stop}>
      <button class="icon-btn" title="Show in Finder" onClick=${() => reveal(f.path)}><${Icon} n="folder" s=${12} /></button>
      <button class="icon-btn del" title="Delete" onClick=${() => deleteFile(f.path)}><${Icon} n="trash" s=${12} /></button>
    </div>
    <div class="acts" onClick=${stop}>
      <button class="btn" onClick=${() => useCapture(f.path)}>${replacing ? "Replace" : S.scene.devices.length ? "Use" : "Add"}</button>
      ${S.scene.devices.length > 0 && html`<button class="icon-btn" title="Add as another device" onClick=${() => addDevice(f.path)}><${Icon} n="plus" s=${13} /></button>`}
    </div>
  </div>`;
}

export function CapturesPanel() {
  const s = useStore();
  const c = s.capture;
  const [filter, setFilter] = useState("all");
  const shots = s.files.filter((f) => ["raw", "uploads", "recordings"].includes(f.kind) && !isVideo(f.path));
  const shown = shots.filter((f) => filter === "all" || (filter === "screens" && f.kind === "raw") || (filter === "recordings" && f.kind === "recordings") || (filter === "uploads" && f.kind === "uploads"));
  const used = new Set(s.scene.devices.map((d) => d.screenshot));
  return html`<div class="panel left">
    <div class="panel-head"><h2>Screenshots</h2>
      <button class="icon-btn sm" title="Refresh the list" onClick=${() => refreshFiles().catch(fail)}><${Icon} n="refresh" s=${14} /></button>
    </div>
    <div class="panel-body">
      <div class="intro">Bring in a screenshot of your app, then click it to put it in the design.</div>
      ${s.replacing &&
      html`<div class="insp-hero" style=${{ boxShadow: "inset 0 0 0 1px var(--iris)", background: "var(--iris-soft)" }}>
        <${Icon} n="replace" s=${16} />
        <div class="meta"><b>Replacing ${entityLabel(s.replacing)}</b><span>Pick a capture below</span></div>
        <button class="btn sm ghost" onClick=${() => set({ replacing: null })}>Cancel</button>
      </div>`}
      <div class="sources">${SOURCES.map((x) => html`<button class="source ${c.source === x.id ? "on" : ""}" onClick=${() => setCap({ source: x.id })}><${Icon} n=${x.icon} s=${18} />${x.label}</button>`)}</div>
      <div class="capture-card">
        ${c.source === "simulator" && html`<${SimulatorForm} />`}
        ${c.source === "web" && html`<${WebForm} />`}
        ${c.source === "mac" && html`<${MacForm} />`}
        ${c.source === "import" && html`<${ImportForm} />`}
      </div>
      <${Section} title="Your screenshots" count=${shots.length}
        right=${html`<${Dropdown} value=${filter} onChange=${setFilter} options=${[
          { value: "all", label: "All" },
          { value: "screens", label: "Captures" },
          { value: "recordings", label: "Recordings" },
          { value: "uploads", label: "Imported" },
        ]} />`}>
        ${shown.length
          ? html`<div class="shots">${shown.map((f) => html`<${Shot} key=${f.path} f=${f} used=${used.has(f.path)} replacing=${s.replacing} />`)}</div>`
          : html`<div class="empty-note">${shots.length ? "Nothing here." : "Screenshots you capture or import appear here. Click one to use it, or drag it onto the design."}</div>`}
      <//>
    </div>
  </div>`;
}

// =============================================================================================
// Backgrounds

const bgObj = (bg) => (bg && typeof bg === "object" ? bg : typeof bg === "string" && S.opts?.looks.some((l) => l.name === bg) ? { look: bg } : bg ? { color: bg } : {});
const TREATMENT = ["blur", "motionBlur", "motionAngle", "brightness", "contrast", "saturation", "tint", "tintAmount", "haze", "hazeColor", "bloom", "halation", "dim", "zoom", "focusX", "focusY", "finish"];

// Print and paint finishes for the backdrop, with the colours each one takes.
const FINISH_OPTIONS = [
  { value: "risograph", label: "Risograph", colors: [["Colour ink", "#ff4a9e"], ["Dark ink", "#23306b"]] },
  { value: "newsprint", label: "Newsprint" },
  { value: "halftone", label: "Halftone" },
  { value: "dither", label: "One-bit", colors: [["Dark", "#151515"], ["Light", "#f2f0eb"]] },
  { value: "oil", label: "Oil paint" },
  { value: "watercolor", label: "Watercolour" },
  { value: "ink", label: "Ink wash", colors: [["Paper", "#efe6d3"], ["Ink", "#3b2a1d"]] },
  { value: "fluted-glass", label: "Fluted glass" },
];

function PrintFinish() {
  const s = useStore();
  const o = bgObj(s.scene.background);
  if (o.type === "transparent") return null;
  const f = typeof o.finish === "string" ? { style: o.finish } : o.finish ?? null;
  const opt = FINISH_OPTIONS.find((x) => x.value === f?.style);
  const setF = (next, key) =>
    edit((d) => {
      const b = bgObj(d.background);
      if (!next) delete b.finish;
      else {
        const clean = Object.fromEntries(Object.entries(next).filter(([, v]) => v !== undefined && !(Array.isArray(v) && !v.length)));
        b.finish = Object.keys(clean).length === 1 ? clean.style : clean;
      }
      const keys = Object.keys(b);
      d.background = keys.length === 1 && keys[0] === "look" ? b.look : b;
    }, key ?? "bg.finish");
  return html`<${Section} title="Print & paint" collapsible id="print">
    <div class="note">Reprint or repaint the backdrop. Your screenshots stay untouched.</div>
    <div class="chips">
      <button class="chip sm ${!f ? "on" : ""}" onClick=${() => setF(null)}>None</button>
      ${FINISH_OPTIONS.map((x) => html`<button class="chip sm ${f?.style === x.value ? "on" : ""}" onClick=${() => setF({ style: x.value })}>${x.label}</button>`)}
    </div>
    ${f &&
    html`<div class="row"><label>Size</label><${Slider} value=${f.scale} min=${0.4} max=${3} step=${0.05} fallback=${1} format=${(v) => v.toFixed(2) + "×"} onChange=${(v) => setF({ ...f, scale: v === undefined || v === 1 ? undefined : v }, "bg.finish.scale")} /></div>
      <div class="row"><label>Strength</label><${Slider} value=${f.amount} min=${0.1} max=${1} step=${0.01} fallback=${1} format=${(v) => Math.round(v * 100) + "%"} onChange=${(v) => setF({ ...f, amount: v === undefined || v >= 1 ? undefined : v }, "bg.finish.amount")} /></div>
      ${opt?.colors?.map(
        ([label, dflt], i) => html`<div class="row"><label>${label}</label><${ColorButton} value=${f.colors?.[i] ?? dflt} onChange=${(v) => {
          const colors = opt.colors.map(([, d], j) => (j === i ? v ?? d : f.colors?.[j] ?? d));
          setF({ ...f, colors }, `bg.finish.c${i}`);
        }} /></div>`,
      )}`}
  <//>`;
}
function keepTreatment(bg) {
  const o = bgObj(bg);
  const out = {};
  for (const k of TREATMENT) if (o[k] !== undefined) out[k] = o[k];
  return out;
}
function setBackground(next, key) {
  touch("backdrop");
  edit((d) => {
    d.background = next;
  }, key);
}
function currentMode(bg) {
  const o = bgObj(bg);
  if (o.type === "transparent") return "none";
  if (o.generate) return "ai";
  if (o.photo || o.unsplash) return "photo";
  if (o.look) return "looks";
  return "color";
}

function LookTile({ l, on }) {
  const [ready, setReady] = useState(false);
  const guess = l.colors.length > 1 ? `linear-gradient(150deg, ${l.colors.join(", ")})` : l.color;
  return html`<button class="look ${on ? "on" : ""}" title=${l.description}
      onClick=${() => {
        const t = keepTreatment(S.scene.background);
        setBackground(Object.keys(t).length && l.photo ? { look: l.name, ...t } : l.name);
      }}>
    <div class="sw" style=${{ background: guess }}></div>
    <img class=${ready ? "ready" : ""} loading="lazy" src=${`/api/look-thumb?name=${encodeURIComponent(l.name)}`} onLoad=${() => setReady(true)} />
    <div class="name">${l.name.replace(/-/g, " ")}</div>
    ${on && html`<span class="check"><${Icon} n="check" s=${12} w=${2.6} /></span>`}
  </button>`;
}

function Looks() {
  const s = useStore();
  const o = bgObj(s.scene.background);
  const looks = s.opts?.looks ?? [];
  const photo = looks.filter((l) => l.photo && !l.painting);
  const paintings = looks.filter((l) => l.painting);
  const made = looks.filter((l) => !l.photo);
  return html`
    <${Section} title="Photographic" count=${photo.length}><div class="looks">${photo.map((l) => html`<${LookTile} key=${l.name} l=${l} on=${o.look === l.name} />`)}</div><//>
    <${Section} title="Paintings & prints" count=${paintings.length}><div class="looks">${paintings.map((l) => html`<${LookTile} key=${l.name} l=${l} on=${o.look === l.name} />`)}</div><//>
    <${Section} title="Gradients" count=${made.length}><div class="looks">${made.map((l) => html`<${LookTile} key=${l.name} l=${l} on=${o.look === l.name} />`)}</div><//>`;
}

const SOLIDS = ["#0b0b0d", "#f5f5f7", "#1e1b4b", "#0f172a", "#14532d", "#7c2d12", "#fde68a", "#fbcfe8", "#bae6fd", "#d9f99d", "#e9d5ff", "#fecaca"];

function ColorBg() {
  const s = useStore();
  const o = bgObj(s.scene.background);
  const isGrad = Boolean(o.colors?.length) || o.type === "gradient" || o.type === "mesh" || o.type === "radial";
  const kind = o.type === "mesh" ? "mesh" : o.type === "radial" ? "radial" : isGrad ? "linear" : "solid";
  const colors = o.colors?.length ? o.colors : [o.color ?? "#1e1b4b", "#6d28d9", "#0ea5e9"];
  const setKind = (k) => {
    if (k === "solid") setBackground({ type: "solid", color: colors[0] });
    else if (k === "mesh") setBackground({ type: "mesh", colors: colors.length > 1 ? colors : [colors[0], "#6d28d9", "#0ea5e9"] });
    else if (k === "radial") setBackground({ type: "radial", colors: colors.length > 1 ? colors.slice(0, 2) : [colors[0], "#000000"] });
    else setBackground({ colors: colors.length > 1 ? colors : [colors[0], "#6d28d9"], angle: o.angle ?? 160 });
  };
  const preview = kind === "solid" ? colors[0] : kind === "radial" ? `radial-gradient(circle at 50% 40%, ${colors.join(", ")})` : `linear-gradient(${o.angle ?? 160}deg, ${colors.join(", ")})`;
  const dial = useRef();
  const turn = (ev) => {
    ev.preventDefault();
    const r = dial.current.getBoundingClientRect();
    const go = (e) => {
      const a = Math.round(((Math.atan2(e.clientY - (r.top + r.height / 2), e.clientX - (r.left + r.width / 2)) * 180) / Math.PI + 90 + 360) % 360);
      edit((d) => (d.background = { ...bgObj(d.background), angle: e.shiftKey ? Math.round(a / 15) * 15 : a }), "bg.angle");
    };
    go(ev);
    const up = () => {
      window.removeEventListener("pointermove", go);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", go);
    window.addEventListener("pointerup", up);
  };
  return html`
    <${Seg} value=${kind} options=${[{ value: "solid", label: "Solid" }, { value: "linear", label: "Linear" }, { value: "radial", label: "Radial" }, { value: "mesh", label: "Mesh" }]} onChange=${setKind} />
    <div class="grad-preview" style=${{ background: preview }}></div>
    ${kind === "solid"
      ? html`<div class="swatches">${SOLIDS.map((c) => html`<button class="swatch ${colors[0] === c ? "on" : ""}" style=${{ background: c }} onClick=${() => setBackground({ type: "solid", color: c })}></button>`)}</div>
          <div class="row"><label>Colour</label><${ColorButton} value=${colors[0]} allowAuto=${false} onChange=${(c) => c && setBackground({ type: "solid", color: c }, "bg.color")} /></div>`
      : html`${colors.map(
          (c, i) => html`<div class="row"><label>${i === 0 && kind === "mesh" ? "Base" : `Stop ${i + 1}`}</label><div class="hstack">
            <div class="grow"><${ColorButton} value=${c} allowAuto=${false} onChange=${(v) => v && edit((d) => {
              const b = bgObj(d.background);
              b.colors = [...colors];
              b.colors[i] = v;
              d.background = b;
            }, `bg.c${i}`)} /></div>
            ${colors.length > 2 && html`<button class="icon-btn sm" title="Remove stop" onClick=${() => edit((d) => {
              const b = bgObj(d.background);
              b.colors = colors.filter((_, j) => j !== i);
              d.background = b;
            })}><${Icon} n="x" s=${13} /></button>`}
          </div></div>`,
        )}
        <div class="hstack">
          ${colors.length < 5 && html`<button class="btn sm" onClick=${() => edit((d) => {
            const b = bgObj(d.background);
            b.colors = [...colors, "#ffb547"];
            d.background = b;
          })}><${Icon} n="plus" s=${13} />Add stop</button>`}
          <span class="grow"></span>
          ${kind === "linear" && html`<span class="lbl">${o.angle ?? 160}°</span><div class="dial" ref=${dial} onPointerDown=${turn}><i style=${{ transform: `rotate(${(o.angle ?? 160) + 180}deg)` }}></i></div>`}
        </div>
        ${kind === "mesh" &&
        html`<div class="chips">${["field", "orbs", "aurora", "corner", "diagonal"].map((m) => html`<button class="chip sm ${(o.meshStyle ?? "field") === m ? "on" : ""}" onClick=${() => edit((d) => (d.background = { ...bgObj(d.background), meshStyle: m }))}>${m}</button>`)}
          <button class="chip sm" onClick=${() => edit((d) => (d.background = { ...bgObj(d.background), seed: ((bgObj(d.background).seed ?? 0) + 1) % 50 }))}><${Icon} n="refresh" s=${11} />Shuffle</button></div>`}`}
  `;
}

function PhotoBg() {
  const s = useStore();
  const o = bgObj(s.scene.background);
  const [q, setQ] = useState(o.unsplash ?? "");
  const [hits, setHits] = useState(null);
  const [loading, setLoading] = useState(false);
  const file = useRef();
  const search = async (query = q) => {
    if (!query.trim()) return;
    setLoading(true);
    try {
      setHits(await api(`/api/unsplash?q=${encodeURIComponent(query.trim())}`));
    } catch (e) {
      fail(e, "Unsplash search failed");
      setHits([]);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    if (!hits && q) search();
  }, []);
  const current = o.photo?.startsWith("unsplash:") ? o.photo.slice(9) : null;
  return html`
    <div class="input-wrap"><${Icon} n="search" s=${14} /><input class="input" placeholder="Search Unsplash: misty mountains, linen…" value=${q} onInput=${(e) => setQ(e.target.value)}
      onKeyDown=${(e) => {
        e.stopPropagation();
        if (e.key === "Enter") search();
      }} />${loading && html`<span class="suffix"><span class="spinner"></span></span>`}</div>
    ${!hits && html`<div class="chips">${["abstract light", "wildflowers", "ocean", "mountains", "paper texture", "neon city", "clouds", "desert"].map((t) => html`<button class="chip sm" onClick=${() => { setQ(t); search(t); }}>${t}</button>`)}</div>`}
    ${hits &&
    html`<div class="photo-grid">${hits.map((h) => html`<button key=${h.id} class=${current === h.id ? "on" : ""} style=${{ background: h.color }} title=${`${h.description ?? ""}${h.author ? ` — ${h.author}` : ""}`}
        onClick=${() => setBackground({ ...keepTreatment(S.scene.background), photo: `unsplash:${h.id}` })}><img loading="lazy" src=${h.thumb} /></button>`)}</div>
      ${!hits.length && html`<div class="empty-note">No free photos found.</div>`}
      <div class="note">Photos from <a href="https://unsplash.com" target="_blank">Unsplash</a>. Credits are added to each render's metadata.</div>`}
    <div class="divider"></div>
    <button class="btn" onClick=${() => file.current.click()}><${Icon} n="upload" s=${14} />Use your own photo</button>
    <input type="file" ref=${file} hidden accept="image/*" onChange=${async (e) => {
      const f = e.target.files[0];
      e.target.value = "";
      if (!f) return;
      try {
        const r = await api(`/api/upload?kind=backdrop&name=${encodeURIComponent(f.name)}`, f, true);
        setBackground({ ...keepTreatment(S.scene.background), photo: r.path });
      } catch (err) {
        fail(err, "Upload failed");
      }
    }} />
    ${o.photo && !current && html`<div class="note">Using <b>${base(o.photo)}</b></div>`}
  `;
}

function AiBg() {
  const s = useStore();
  const o = bgObj(s.scene.background);
  const providers = s.opts?.aiProviders ?? [];
  const [text, setText] = useState(typeof o.generate === "string" ? o.generate : o.generate?.prompt ?? "");
  return html`
    <${TextField} multiline rows=${3} value=${text} placeholder="Soft pastel sand dunes at golden hour, gentle haze" onChange=${setText} />
    <button class="btn primary" disabled=${!providers.length || !text.trim()} onClick=${() => setBackground({ ...keepTreatment(S.scene.background), generate: text.trim(), ...(o.seed !== undefined ? { seed: o.seed } : {}) })}>
      <${Icon} n="wand" s=${15} />Use this prompt</button>
    ${o.generate && html`<button class="btn sm" onClick=${() => edit((d) => (d.background = { ...bgObj(d.background), seed: ((bgObj(d.background).seed ?? 0) + 1) % 100 }))}><${Icon} n="refresh" s=${13} />New variation</button>`}
    <div class="note">${providers.length
      ? html`Generated with <b>${providers[0]}</b> when you render, then cached for this prompt.`
      : html`Set <code>OPENAI_API_KEY</code>, <code>GEMINI_API_KEY</code>, <code>REPLICATE_API_TOKEN</code> or <code>FAL_KEY</code> in your shell profile, then restart Screenshotter.`}</div>
  `;
}

function Treatment() {
  const s = useStore();
  const o = bgObj(s.scene.background);
  const look = s.opts?.looks.find((l) => l.name === o.look);
  const photoish = o.photo || o.unsplash || o.generate || look?.photo;
  if (!photoish) return null;
  const setT = (k, v) =>
    edit((d) => {
      const b = bgObj(d.background);
      if (v === undefined) delete b[k];
      else b[k] = v;
      const keys = Object.keys(b);
      d.background = keys.length === 1 && keys[0] === "look" ? b.look : b;
    }, `bg.${k}`);
  const pct = (v) => `${Math.round(v * 100)}`;
  return html`<${Section} title="Adjust photo" collapsible id="treat" right=${Object.keys(keepTreatment(s.scene.background)).length ? html`<button class="btn sm ghost" onClick=${() => setBackground(o.look && !o.photo ? o.look : Object.fromEntries(Object.entries(o).filter(([k]) => !TREATMENT.includes(k))))}>Reset</button>` : null}>
    <div class="row"><label>Motion</label><${Slider} value=${o.motionBlur} min=${0} max=${0.15} step=${0.002} fallback=${0} format=${pct} onChange=${(v) => setT("motionBlur", v)} /></div>
    <div class="row"><label>Blur</label><${Slider} value=${o.blur} min=${0} max=${0.06} step=${0.001} fallback=${0} format=${pct} onChange=${(v) => setT("blur", v)} /></div>
    <div class="row"><label>Haze</label><${Slider} value=${o.haze} min=${0} max=${1} step=${0.01} fallback=${0} format=${pct} onChange=${(v) => setT("haze", v)} /></div>
    <div class="row"><label>Bloom</label><${Slider} value=${o.bloom} min=${0} max=${1} step=${0.01} fallback=${0} format=${pct} onChange=${(v) => setT("bloom", v)} /></div>
    <div class="row"><label>Brightness</label><${Slider} value=${o.brightness} min=${0.4} max=${1.6} step=${0.01} fallback=${1} centered format=${(v) => v.toFixed(2)} onChange=${(v) => setT("brightness", v)} /></div>
    <div class="row"><label>Saturation</label><${Slider} value=${o.saturation} min=${0} max=${2} step=${0.01} fallback=${1} format=${(v) => v.toFixed(2)} onChange=${(v) => setT("saturation", v)} /></div>
    <div class="row"><label>Dim</label><${Slider} value=${o.dim} min=${0} max=${0.8} step=${0.01} fallback=${0} format=${pct} onChange=${(v) => setT("dim", v)} /></div>
    <div class="row"><label>Zoom</label><${Slider} value=${o.zoom} min=${1} max=${3} step=${0.01} fallback=${1} format=${(v) => v.toFixed(2) + "×"} onChange=${(v) => setT("zoom", v)} /></div>
    <div class="row"><label>Tint</label><div class="hstack"><${ColorButton} value=${o.tint} auto="None" onChange=${(v) => setT("tint", v)} />${o.tint && html`<div class="grow"><${Slider} value=${o.tintAmount} min=${0} max=${1} step=${0.01} fallback=${0.15} format=${pct} onChange=${(v) => setT("tintAmount", v)} /></div>`}</div></div>
  <//>`;
}

function Finish() {
  const s = useStore();
  const fx = s.scene.effects ?? {};
  const setFx = (k, v) =>
    edit((d) => {
      d.effects = { ...(d.effects ?? {}) };
      if (v === undefined || v === 0 || v === false || v === "none") delete d.effects[k];
      else d.effects[k] = v;
    }, `fx.${k}`);
  const grain = typeof fx.grain === "object" ? fx.grain.amount : fx.grain;
  const vig = typeof fx.vignette === "object" ? fx.vignette.amount : fx.vignette;
  const grade = typeof fx.grade === "object" ? fx.grade.preset ?? "none" : fx.grade ?? "none";
  return html`<${Section} title="Film look" collapsible id="finish">
    <div class="row"><label>Grain</label><${Slider} value=${grain} min=${0} max=${0.6} step=${0.01} fallback=${0} format=${(v) => Math.round(v * 100)} onChange=${(v) => setFx("grain", v)} /></div>
    <div class="row"><label>Vignette</label><${Slider} value=${vig} min=${0} max=${1} step=${0.01} fallback=${0} format=${(v) => Math.round(v * 100)} onChange=${(v) => setFx("vignette", v)} /></div>
    <${Switch} checked=${Boolean(fx.edgeBlur)} onChange=${(v) => setFx("edgeBlur", v || undefined)} label="Blur where devices leave the canvas" />
    <div class="lbl">Colour grade (affects the backdrop, not your screenshot)</div>
    <div class="chips">${(s.opts?.grades ?? ["none"]).map((g) => html`<button class="chip sm ${grade === g ? "on" : ""}" onClick=${() => setFx("grade", g)}>${g}</button>`)}</div>
  <//>`;
}

export function BackgroundsPanel() {
  const s = useStore();
  const [mode, setMode] = useState(() => currentMode(S.scene.background));
  return html`<div class="panel left">
    <div class="panel-head"><h2>Backdrop</h2>
      <button class="btn sm ${currentMode(s.scene.background) === "none" ? "" : "ghost"}" title="No backdrop: export a transparent PNG" onClick=${() => setBackground({ type: "transparent" })}>Transparent</button>
    </div>
    <div class="panel-body">
      <div class="intro">What sits behind your device. Start with a ready-made look, or use your own colours or photo.</div>
      ${s.shots &&
      html`<div class="across-set ${s.scene.backgroundSpan ? "on" : ""}">
        <${Switch} checked=${Boolean(s.scene.backgroundSpan)} label=${`Across all ${s.shots.length} screens`} onChange=${setBackdropAcross} />
        <span>${s.scene.backgroundSpan ? "One backdrop, each screen showing its slice: swiping through them reads as one picture." : "Lay this backdrop across the whole set as one panorama, each screen showing its slice."}</span>
      </div>`}
      <${Seg} value=${mode} onChange=${setMode} options=${[{ value: "looks", label: "Looks" }, { value: "color", label: "Colours" }, { value: "photo", label: "Photos" }, { value: "ai", label: "AI image" }]} />
      ${mode === "looks" && html`<${Looks} />`}
      ${mode === "color" && html`<div class="vstack">${html`<${ColorBg} />`}</div>`}
      ${mode === "photo" && html`<div class="vstack"><${PhotoBg} /></div>`}
      ${mode === "ai" && html`<div class="vstack"><${AiBg} /></div>`}
      <${Treatment} />
      <${PrintFinish} />
      <${Finish} />
    </div>
  </div>`;
}

// =============================================================================================
// Text

/** Text and shapes share a tab in the rail: this switches between the two halves. */

export function TextPanel() {
  const s = useStore();
  const scene = s.scene;
  const texts = scene.texts ?? [];
  const hasCaption = scene.headline !== undefined || scene.subheadline !== undefined;
  return html`<div class="panel left">
    <div class="panel-head"><h2>Text</h2></div>
    <div class="panel-body">
      <div class="intro">A headline sells the screen. Add labels or badges for extra detail. Double-click any text in the design to retype it.</div>
      <${Section} title="Headline">
        ${hasCaption
          ? html`<div class="text-card ${s.selected === "caption" ? "on" : ""}" onClick=${() => set({ selected: "caption" })}>
              <${AccentText} rows=${2} value=${scene.headline} placeholder="Headline" onChange=${(v) => edit((d) => (d.headline = v || undefined), "headline")} />
              <${TextField} value=${scene.subheadline} placeholder="Subheadline (optional)" onChange=${(v) => edit((d) => (d.subheadline = v || undefined), "subheadline")} />
            </div>`
          : html`<button class="btn block" onClick=${addCaption}><${Icon} n="plus" s=${14} />Add a headline</button>`}
      <//>
      <${Section} title="Add extra text">
        <div class="presets">
          <button class="preset" onClick=${() => addText("label")}><span style=${{ fontWeight: 650 }}>Label</span></button>
          <button class="preset" onClick=${() => addText("badge")}><span style=${{ background: "var(--lime)", color: "var(--lime-ink)", padding: "3px 9px", borderRadius: "20px", fontSize: "10.5px", fontWeight: 800, letterSpacing: ".04em" }}>NEW</span></button>
          <button class="preset" onClick=${() => addText("rating")}><span style=${{ color: "var(--amber)", letterSpacing: "1px" }}>★★★★★</span></button>
          <button class="preset" onClick=${() => addText("big")}><span style=${{ fontSize: "20px", fontWeight: 800 }}><span style=${{ color: "var(--pink)" }}>2×</span> faster</span></button>
        </div>
      <//>
      <${Section} title="Extra text" count=${texts.length}>
        ${texts.length
          ? texts.map(
              (t, i) => html`<div class="text-card ${s.selected === `text-${i + 1}` ? "on" : ""}" onClick=${() => set({ selected: `text-${i + 1}` })}>
                <div class="hstack" style=${{ alignItems: "flex-start" }}><div class="grow"><${AccentText} rows=${1} value=${t.text} onFocus=${() => set({ selected: `text-${i + 1}` })} onChange=${(v) => edit((d) => (d.texts[i].text = v), `text${i}`)} /></div>
                  <button class="icon-btn sm" title="Remove" onClick=${(e) => {
                    e.stopPropagation();
                    edit((d) => d.texts.splice(i, 1));
                    set({ selected: null });
                  }}><${Icon} n="trash" s=${13} /></button></div>
              </div>`,
            )
          : html`<div class="empty-note">Labels, badges and ratings you add appear here. Double-click text on the canvas to retype it.</div>`}
      <//>
    </div>
  </div>`;
}

// =============================================================================================
// Layers

/** Everything in the image, front to back: click one to select it. Lives in the right panel. */
export function LayersList() {
  const s = useStore();
  const ents = [...(s.layout?.entities ?? [])].sort((a, b) => b.z - a.z);
  if (!ents.length) return html`<div class="empty-note">Add a screenshot to start the design.</div>`;
  return html`<div class="layers">
    ${ents.map(
      (e) => html`<div class="layer ${s.selected === e.id ? "on" : ""}" onClick=${() => set({ selected: e.id, view: "canvas" })} onMouseEnter=${() => set({ hover: e.id })} onMouseLeave=${() => set({ hover: null })}>
        <span class="thumb">${e.kind === "device" ? html`<img src=${thumbUrl(e.screenshot, 80)} />` : html`<${Icon} n=${e.kind === "shape" ? "shapes" : "text"} s=${13} />`}</span>
        <span class="nm">${entityLabel(e.id)}</span>
      </div>`,
    )}
  </div>`;
}

// =============================================================================================
// Shapes

const TINTS = ["#ff3b30", "#ff9f0a", "#ffd60a", "#34c759", "#0a84ff", "#bf5af2", "#ff5fa2", "#ffffff", "#111111"];
const MARKS = [
  { value: "circle-it", label: "", title: "Circle it", icon: "circled" },
  { value: "box", label: "", title: "Box it", icon: "square" },
  { value: "sketch-arrow", label: "", title: "Point an arrow at it", icon: "arrow" },
  { value: "badge", label: "", title: "Number it", icon: "badge" },
];

const isDark = (hex) => {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex ?? "");
  if (!m) return false;
  const n = parseInt(m[1], 16);
  return (0.2126 * (n >> 16) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255 < 0.22;
};

/** A shape drawn small, exactly as it will look, for its button. */
function ShapePreview({ kind, tint }) {
  const W = 66;
  const H = 46;
  const made = kind.make(tint);
  const line = made.type === "arrow" || made.type === "line";
  const spec = shapeSpec({
    ...made,
    x: 0.5,
    y: 0.5,
    size: made.type === "badge" ? 0.62 : Math.min(0.66, (0.9 * W) / H / (made.aspect ?? 1)),
    strokeWidth: made.strokeWidth ? 0.045 : 0,
    from: line ? { x: 0.16, y: 0.76 } : undefined,
    to: line ? { x: 0.84, y: 0.24 } : undefined,
  });
  const r = renderShape(spec, W, H);
  return html`<span class="shape-prev" style=${{ width: W + "px", height: H + "px" }}>
    <span style=${{ position: "absolute", left: r.left + "px", top: r.top + "px", width: r.width + "px", height: r.height + "px" }} dangerouslySetInnerHTML=${{ __html: r.svg }}></span>
  </span>`;
}

/**
 * Drag a shape out of the panel: it follows the pointer at the size it will be, and lands where
 * it's dropped on the design. A press without a drag adds it in the middle.
 */
function dragShape(ev, kind, tint) {
  const made = kind.make(tint);
  dragOnto(ev, shapeGhost(made), (at) => addShape(kind.id, { tint, at }));
}

/** A shape's ghost, drawn for the design's size on screen, so what you drag is what you get. */
const shapeGhost = (made) => (W, H) => {
  const line = made.type === "arrow" || made.type === "line";
  const r = renderShape(shapeSpec({ ...made, x: 0.5, y: 0.5, from: line ? { x: 0.38, y: 0.56 } : undefined, to: line ? { x: 0.62, y: 0.44 } : undefined }), W, H);
  return { html: r.svg, width: r.width, height: r.height, rotate: r.rotate };
};

/**
 * A picture's ghost at the height it goes on (a share of the design's), as wide as its own shape;
 * a sticker with its white edge.
 */
const pictureGhost = (src, height, sticker = false) => (W, H) => {
  const h = height * H;
  const edge = sticker ? `filter:drop-shadow(2px 0 0 #fff) drop-shadow(-2px 0 0 #fff) drop-shadow(0 2px 0 #fff) drop-shadow(0 -2px 0 #fff)` : "";
  return { html: `<img src="${pictureUrl(src)}" style="display:block;height:${h}px;width:auto;max-width:${W}px;${edge}">`, width: undefined, height: h };
};

/**
 * Drag something from a panel onto the design: a ghost follows the pointer at the size it will be,
 * and letting go over the design puts it there (`place(at)`, canvas fractions). A click without a
 * drag puts it in its usual place (`place()`); Esc lets go without adding anything.
 */
function dragOnto(ev, makeGhost, place) {
  if (ev.button !== 0) return;
  ev.preventDefault();
  const start = { x: ev.clientX, y: ev.clientY };
  let ghost = null;
  const board = () => document.querySelector(".stage .artboard")?.getBoundingClientRect();
  const over = (e) => {
    const v = document.querySelector(".stage .viewport")?.getBoundingClientRect();
    return Boolean(v && e.clientX >= v.left && e.clientX <= v.right && e.clientY >= v.top && e.clientY <= v.bottom);
  };
  const move = (e) => {
    if (!ghost) {
      if (Math.hypot(e.clientX - start.x, e.clientY - start.y) < 5) return;
      const a = board();
      const g = makeGhost(a?.width ?? 640, a?.height ?? 480);
      ghost = document.createElement("div");
      ghost.className = "shape-ghost";
      if (g.width) ghost.style.width = g.width + "px";
      ghost.style.height = g.height + "px";
      if (g.rotate) ghost.style.rotate = `${g.rotate}deg`;
      ghost.innerHTML = g.html;
      document.body.append(ghost);
      document.body.classList.add("dragging-shape");
    }
    // Centred on the pointer, as it lands.
    ghost.style.transform = `translate(${e.clientX - ghost.offsetWidth / 2}px, ${e.clientY - ghost.offsetHeight / 2}px)`;
    ghost.classList.toggle("over", over(e));
  };
  const up = (e) => {
    removeEventListener("pointermove", move);
    removeEventListener("pointerup", up);
    removeEventListener("keydown", key, true);
    document.body.classList.remove("dragging-shape");
    if (!ghost) return e && place();
    ghost.remove();
    const a = board();
    if (e && a && over(e)) place({ x: (e.clientX - a.left) / a.width, y: (e.clientY - a.top) / a.height });
  };
  // Esc lets go without adding anything.
  const key = (e) => {
    if (e.key !== "Escape") return;
    e.stopPropagation();
    up(null);
  };
  addEventListener("pointermove", move);
  addEventListener("pointerup", up);
  addEventListener("keydown", key, true);
}

export function ShapesPanel() {
  const s = useStore();
  const tint = s.shapeTint;
  const shapes = s.scene.shapes ?? [];
  const devices = s.scene.devices;
  // Marks go on the selected device's screen, else the first.
  const di = s.selected?.startsWith("device-") ? Number(s.selected.split("-")[1]) - 1 : 0;
  const dev = devices[di] ?? devices[0];
  const [ocr, setOcr] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => setOcr(null), [dev?.screenshot]);
  const find = async () => {
    setBusy(true);
    try {
      const boxes = await api(`/api/text?path=${encodeURIComponent(dev.screenshot)}`);
      setOcr(boxes.filter((b) => b.text.trim().length > 1));
    } catch (e) {
      fail(e, "Couldn't read the screenshot");
    } finally {
      setBusy(false);
    }
  };
  const tile = (k) => html`<div class="shape-tile ${isDark(tint) ? "light" : ""}" role="button" tabindex="0" title=${`Drag ${k.label.toLowerCase()} onto the design, or click to add it`}
      onPointerDown=${(e) => dragShape(e, k, tint)}
      onKeyDown=${(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), addShape(k.id, { tint }))}>
    <${ShapePreview} kind=${k} tint=${tint} /><span class="nm">${k.label}</span>
  </div>`;
  return html`<div class="panel left">
    <div class="panel-head"><h2>Shapes</h2>${shapes.length > 0 && html`<span class="sub">${shapes.length}</span>`}</div>
    <div class="panel-body">
      <div class="intro">Drag a shape onto your design and drop it where you want it (or click to add it in the middle). Then move, resize, rotate and recolour it.</div>
      <${Section} title="Colour">
        <div class="tints">
          ${TINTS.map((c) => html`<button class="tint ${c === tint ? "on" : ""}" title=${c} style=${{ background: c }} onClick=${() => set({ shapeTint: c })}></button>`)}
        </div>
        <${ColorButton} value=${tint} allowAuto=${false} onChange=${(v) => v && set({ shapeTint: v })} />
      <//>
      <${Section} title="Point things out">
        <div class="shape-tiles">${SHAPE_KINDS.filter((k) => k.group === "mark").map(tile)}</div>
      <//>
      <${Section} title="Shapes">
        <div class="shape-tiles">${SHAPE_KINDS.filter((k) => k.group === "solid").map(tile)}</div>
      <//>
      <${Section} title="Badges and awards">
        <div class="shape-tiles">${SHAPE_KINDS.filter((k) => k.group === "award").map(tile)}</div>
        <div class="note">Each holds your own words. Only claim what's true. More ready-made ones are in Images.</div>
      <//>
      ${shapes.length > 0 &&
      html`<${Section} title="In this design" count=${shapes.length}>
        ${shapes.map((sh, i) => {
          const id = `shape-${i + 1}`;
          const icon = { arrow: "arrow", line: "line", ellipse: sh.sketch ? "circled" : "ellipse", rect: "square", triangle: "triangle", star: "star", badge: "badge" }[sh.type] ?? "star";
          return html`<div class="layer ${s.selected === id ? "on" : ""}" onClick=${() => set({ selected: id, view: "canvas" })} onMouseEnter=${() => set({ hover: id })} onMouseLeave=${() => set({ hover: null })}>
            <span class="thumb" style=${{ color: sh.stroke && sh.stroke !== "none" ? sh.stroke : sh.fill && sh.fill !== "none" ? sh.fill : undefined }}><${Icon} n=${icon} s=${13} /></span>
            <span class="nm">${entityLabel(id)}${sh.around ? html` <span class="faint">on “${sh.around.text}”</span>` : ""}</span>
            <button class="icon-btn sm" title="Remove" onClick=${(e) => {
              e.stopPropagation();
              deleteEntity(id);
            }}><${Icon} n="trash" s=${13} /></button>
          </div>`;
        })}
      <//>`}
      ${dev &&
      html`<${Section} title="Snap to text on the screen" collapsible open=${false} id="shape-snap">
        <div class="note">Optional. Instead of placing a mark yourself, pick words on the screen: the mark lands on them and follows the device when it moves.</div>
        <div class="row"><label>Add a</label><${Seg} value=${s.shapeMark} options=${MARKS} onChange=${(v) => set({ shapeMark: v })} /></div>
        ${ocr
          ? html`<div class="ocr">${ocr.map((b) => html`<button title=${b.text} onClick=${() => addShape(s.shapeMark, { tint, around: { device: di + 1 > 1 ? di + 1 : undefined, text: b.text } })}>${b.text}</button>`)}${!ocr.length && html`<span class="note">No text found.</span>`}</div>`
          : html`<button class="btn sm block" onClick=${find} disabled=${busy}>${busy ? html`<span class="spinner"></span>` : html`<${Icon} n="search" s=${12} />`}Find the text${devices.length > 1 ? ` on ${entityLabel(`device-${di + 1}`)}` : ""}</button>`}
      <//>`}
    </div>
  </div>`;
}

// =============================================================================================
// Images

// How a picture goes on: Auto guesses (a logo, an app icon, a sticker or a photo), or as it is, as an
// app icon (Apple's icon outline and a shadow), or a sticker.
const IMAGE_AS = [
  { value: "auto", label: "Auto" },
  { value: "picture", label: "Plain" },
  { value: "icon", label: "Icon" },
  { value: "sticker", label: "Sticker" },
];

export function ImagesPanel() {
  const s = useStore();
  const [lib, setLib] = useState(null);
  const [over, setOver] = useState(false);
  const file = useRef();
  useEffect(() => {
    api("/api/images")
      .then((r) => setLib(r.images))
      .catch(() => setLib([]));
  }, [s.imagesStamp]);
  const images = s.scene.images ?? [];
  const replacing = s.replacingImage && images[Number(s.replacingImage.split("-")[1]) - 1] ? s.replacingImage : null;
  const as = IMAGE_AS.find((a) => a.value === s.imageAs) ?? IMAGE_AS[0];
  const use = (p) => {
    if (replacing) {
      replaceImage(replacing, p);
      set({ replacingImage: null, selected: replacing });
    } else addPicture(p);
  };
  const preset = (p) => html`<div class="shape-tile" role="button" tabindex="0" title=${`Drag ${p.label.toLowerCase()} onto the design (or click to add it), then change its words`}
      onPointerDown=${(e) => dragOnto(e, shapeGhost(p.shape), (at) => addPresetShape(p.shape, { at }))} onKeyDown=${(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), addPresetShape(p.shape))}>
    <${ShapePreview} kind=${{ make: () => p.shape }} tint=${p.shape.fill} /><span class="nm">${p.label}</span>
  </div>`;
  const add = async (files) => {
    const paths = await uploadImages(files);
    // One picture goes straight on (or in, when replacing); several wait in the library.
    if (paths.length === 1 || (replacing && paths.length)) use(paths[0]);
  };
  return html`<div class="panel left">
    <div class="panel-head"><h2>Images</h2>${images.length > 0 && html`<span class="sub">${images.length}</span>`}</div>
    <div class="panel-body">
      ${replacing
        ? html`<div class="follow-note"><${Icon} n="replace" s=${13} /><span>Choose a picture for <b>${entityLabel(replacing)}</b>.</span><button class="btn sm ghost" onClick=${() => set({ replacingImage: null })}>Cancel</button></div>`
        : html`<div class="intro">Logos, your app icon, stickers or any picture. Add one, then move, size, turn and style it like a shape.</div>`}
      ${!replacing && html`<div class="row"><label>Add as</label><${Seg} value=${as.value} options=${IMAGE_AS} onChange=${(v) => set({ imageAs: v })} /></div>`}
      <div class="image-drop ${over ? "over" : ""}"
        onDragOver=${(e) => {
          if (![...(e.dataTransfer?.types ?? [])].includes("Files")) return;
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave=${() => setOver(false)}
        onDrop=${(e) => {
          e.preventDefault();
          e.stopPropagation();
          setOver(false);
          add([...e.dataTransfer.files]);
        }}>
        <button class="btn block" onClick=${() => file.current.click()}><${Icon} n="upload" s=${14} />Add a picture…</button>
        <span>or drop a PNG, JPEG, WebP, GIF or SVG here</span>
      </div>
      <input type="file" ref=${file} hidden multiple accept=".png,.jpg,.jpeg,.webp,.gif,.svg,image/png,image/jpeg,image/webp,image/gif,image/svg+xml" onChange=${(e) => {
        const files = [...e.target.files];
        e.target.value = "";
        if (files.length) add(files);
      }} />
      ${!replacing &&
      html`<${Section} title="Stickers" count=${s.opts?.stickers?.length}>
        <div class="sticker-grid">${(s.opts?.stickers ?? []).map((n) => html`<button key=${n} title=${`${n[0].toUpperCase()}${n.slice(1)}: drag it onto the design, or click to add it`} onPointerDown=${(e) => dragOnto(e, pictureGhost(`sticker:${n}`, 0.11, true), (at) => addSticker(n, { at }))} onKeyDown=${(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), addSticker(n))}><img loading="lazy" src=${`/ui/stickers/${n}.svg`} /></button>`)}</div>
      <//>
      <${Section} title="Illustrations" count=${s.opts?.art?.length}>
        <div class="sticker-grid art-grid">${(s.opts?.art ?? []).map((n) => html`<button key=${n} class=${(s.opts?.colouredArt ?? []).includes(n) ? "" : "mono"} title=${`${n.replace(/-/g, " ")}: drag it onto the design, or click to add it (it goes behind the devices)`}
          onPointerDown=${(e) => dragOnto(e, pictureGhost(`art:${n}`, 0.14), (at) => addArt(n, { at }))} onKeyDown=${(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), addArt(n))}><img loading="lazy" src=${`/ui/art/${n}.svg`} /></button>`)}</div>
      <//>
      <${Section} title="Badges">
        <div class="shape-tiles">${BADGE_PRESETS.map(preset)}</div>
        <div class="note">Select one to change its words in the panel on the right.</div>
      <//>
      <${Section} title="Awards and ratings">
        <div class="shape-tiles">${AWARD_PRESETS.map(preset)}</div>
        <div class="note">Placeholders: put in an award, rating or count your app has really had.</div>
      <//>`}
      ${lib?.length > 0 &&
      html`<${Section} title="Your pictures" count=${lib.length}>
        <div class="image-grid">${lib.map((f) => html`<button key=${f.path} title=${`${pictureName(f.path)}: ${replacing ? "click to use it" : "drag it onto the design, or click to add it"}`}
          onPointerDown=${(e) => (replacing ? undefined : dragOnto(e, pictureGhost(f.path, 0.12), (at) => addPicture(f.path, { at })))} onClick=${() => replacing && use(f.path)}
          onKeyDown=${(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), use(f.path))}><img loading="lazy" src=${fileUrl(f.path)} /></button>`)}</div>
      <//>`}
      ${images.length > 0 &&
      html`<${Section} title="In this design" count=${images.length}>
        ${images.map((b, i) => {
          const id = `image-${i + 1}`;
          return html`<div class="layer ${s.selected === id ? "on" : ""}" onClick=${() => set({ selected: id, view: "canvas" })} onMouseEnter=${() => set({ hover: id })} onMouseLeave=${() => set({ hover: null })}>
            <span class="thumb img"><img src=${pictureUrl(b.src)} /></span>
            <span class="nm">${entityLabel(id)}</span>
            <button class="icon-btn sm" title="Remove" onClick=${(e) => {
              e.stopPropagation();
              deleteEntity(id);
            }}><${Icon} n="trash" s=${13} /></button>
          </div>`;
        })}
      <//>`}
    </div>
  </div>`;
}

// =============================================================================================
// Exports

/** How long ago, briefly. */
const since = (ms) => {
  const m = Math.round((Date.now() - ms) / 60000);
  return m < 1 ? "just now" : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`;
};

/**
 * Everything exported, newest first. Exports of the same scene stack into one card with its
 * versions: open a version to view it, or restore it as the working design.
 */
/** Everything exported, newest first, as a grid for the My designs page. */
export function ExportsGrid() {
  const s = useStore();
  const [open, setOpen] = useState(null);
  const outs = s.files.filter((f) => f.kind === "mockups" || f.kind === "videos");
  const groups = [];
  const byScene = new Map();
  for (const f of outs) {
    const id = f.scene?.id;
    if (id && byScene.has(id)) byScene.get(id).versions.push(f);
    else {
      const g = { key: id ?? f.path, scene: f.scene, versions: [f] };
      if (id) byScene.set(id, g);
      groups.push(g);
    }
  }
  const view = (f) => set({ render: { path: f.path, isVideo: isVideo(f.path), preview: false, at: f.mtime }, renderStale: false, view: "render", scenesPage: false });
  const tile = (f, g) => html`<div class="shot wide" key=${f.path} data-file=${f.path} data-kind="saved" title=${base(f.path)} onClick=${() => view(f)}>
    ${isVideo(f.path) ? html`<video src=${`/file?path=${encodeURIComponent(f.path)}#t=0.5`} muted preload="metadata" style=${{ width: "100%", height: "100%", objectFit: "contain" }}></video>` : html`<img loading="lazy" src=${thumbUrl(f.path, 360)} />`}
    <div class="veil"></div>
    ${isVideo(f.path) && html`<span class="badge"><${Icon} n="play" s=${9} />${f.path.split(".").pop().toUpperCase()}</span>`}
    ${g && g.versions.length > 1 && html`<button class="badge versions" title="Show every version" onClick=${(e) => {
      e.stopPropagation();
      setOpen(open === g.key ? null : g.key);
    }}><${Icon} n="history" s=${10} />${g.versions.length} versions</button>`}
    <div class="acts" onClick=${(e) => e.stopPropagation()}>
      <button class="btn" onClick=${() => reveal(f.path)}>Show</button>
      <button class="icon-btn" title="Delete" onClick=${() => deleteFile(f.path)}><${Icon} n="trash" s=${13} /></button>
    </div>
  </div>`;
  if (!groups.length) return html`<div class="sp-empty big"><div class="art"><${Icon} n="exports" s=${24} /></div><b>Nothing exported yet</b><span>Images and videos you export appear here, with every version of each design.</span></div>`;
  return html`<div class="shots exports-grid">${groups.map((g) => [
    tile(g.versions[0], g),
    open === g.key &&
      html`<div class="history" key=${`${g.key}-history`}>
        <div class="history-head"><b>${g.scene?.name ?? "Design"}</b><span class="faint">${g.versions.length} versions</span></div>
        ${g.versions.map(
          (v, i) => html`<div class="history-row" key=${v.path}>
            <button class="history-pick" onClick=${() => view(v)}><img loading="lazy" src=${thumbUrl(v.path, 120)} /><span>${i === 0 ? "Latest" : `Version ${g.versions.length - i}`}<em>${since(v.mtime)}</em></span></button>
            ${!isVideo(v.path) && html`<button class="btn sm ghost" title="Make this version the working design" onClick=${() => restoreVersion(v.path).then(() => set({ scenesPage: false }))}>Restore</button>`}
          </div>`,
        )}
      </div>`,
  ])}</div>`;
}

// =============================================================================================
// Designs

const DIRECTION_STEPS = { look: "Rendering your design", read: "Reading your screens", get think() { return `${aiName()} is designing three directions`; }, render: "Rendering them", generate: "Making their AI backdrops" };

/** Claude proposes three directions, rendered side by side; pick one. */
function DesignForMe() {
  const s = useStore();
  const d = s.directions;
  const ai = s.opts?.ai;
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!d?.busy) return;
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, [d?.busy]);
  return html`<div class="dfm">
    <div class="dfm-head">
      <div><b>Design it for me</b><span>${aiName()} looks at your screens and proposes three directions. Pick the one you like.</span></div>
      <button class="btn primary sm" disabled=${d?.busy || !s.scene.devices.length || (ai && !ai.available)} onClick=${designForMe}>
        ${d?.busy ? html`<span class="spinner"></span>Designing…` : html`<${Icon} n="spark" s=${13} />${d?.items?.length ? "Three more" : "Design it"}`}
      </button>
    </div>
    ${d?.busy &&
    html`<div class="dfm-progress"><span class="shimmer-text">${DIRECTION_STEPS[d.step] ?? "Working"}…</span><span class="faint" title="This step · in all">${Math.max(0, Math.round((now - (d.stepAt ?? d.started)) / 1000))}s · ${Math.max(0, Math.round((now - d.started) / 1000))}s</span>
      <button class="btn sm ghost" title=${`Stop ${aiName()}. Your design stays as it is.`} onClick=${stopDesignForMe}>Stop</button></div>
      ${d.step === "generate" && html`<div class="note">${IMAGE_PROVIDERS[d.provider] ?? "The image generator"} is making a new backdrop image. This can take a minute.</div>`}`}
    ${d?.error && html`<div class="note warn">${d.error}</div>`}
    ${d?.items?.length > 0 &&
    html`<div class="dfm-grid">${d.items.map(
      (x, i) => html`<button class="dfm-card ${d.picked === i ? "on" : ""}" style=${{ "--i": i }} onClick=${() => applyDirection(i)} title=${x.summary}>
        ${x.image ? html`<img src=${`data:image/jpeg;base64,${x.image}`} />` : html`<div class="dfm-blank"></div>`}
        <b>${x.name}</b><span>${x.summary}</span>
      </button>`,
    )}</div>`}
    ${ai && !ai.available && html`<div class="note">Needs Claude Code, Codex or an API key (Settings › AI Edit).</div>`}
  </div>`;
}

const LAYOUT_NAMES = { hero: "Title on top", "hero-bleed": "Big device", "text-bottom": "Title below", tilted: "Tilted", floating: "No title", duo: "Two devices", trio: "Three devices", split: "Title beside", stack: "Stacked", grid: "Grid", staircase: "Staircase", rising: "Rising pair" };
const LAYOUT_TIPS = {
  hero: "Headline at the top, device underneath",
  "hero-bleed": "A large device that runs off the bottom edge",
  "text-bottom": "Device on top, headline underneath",
  tilted: "Device angled in 3D",
  floating: "Just the device, no headline space",
  duo: "Two devices side by side",
  trio: "Three devices in a row",
  split: "Headline on one side, device on the other",
  stack: "Devices overlapping, e.g. a Mac and an iPhone",
  grid: "Every screen in a tidy grid",
  staircase: "Screens stepping up to the right",
  rising: "Two screens leaning toward each other",
};

/** Where the devices and headline sit, without changing colours or type. */
function Arrangement() {
  const s = useStore();
  const sc = s.scene;
  const layouts = (s.opts?.layouts ?? []).filter((l) => l !== "custom");
  return html`<${Section} title="Just rearrange" collapsible open=${false} id="arrange">
    <div class="note">Move the devices and headline around, keeping your colours and type.</div>
    <div class="layouts">
      <button class="layout-opt ${!sc.layout ? "on" : ""}" title="Picks an arrangement for the number of devices" onClick=${() => edit((d) => delete d.layout)}><${LayoutIcon} n="custom" />Automatic</button>
      ${layouts.map((l) => html`<button class="layout-opt ${sc.layout === l ? "on" : ""}" title=${LAYOUT_TIPS[l] ?? ""} onClick=${() => edit((d) => (d.layout = l))}><${LayoutIcon} n=${l} />${LAYOUT_NAMES[l] ?? l}</button>`)}
    </div>
    ${sc.devices.some((d) => d.x !== undefined || d.y !== undefined) &&
    html`<button class="btn sm" onClick=${() => edit((d) => d.devices.forEach((dev) => ["x", "y", "anchor", "height", "width", "rotate"].forEach((k) => delete dev[k])))}>
      <${Icon} n="refresh" s=${12} />Undo hand placement on all devices</button>
      <div class="note">Devices you dragged by hand keep their spot until you undo that.</div>`}
  <//>`;
}

/** Complete designs built from your own screens, headline and colours. */
/** Your own templates: save the design as one, use one, share or delete it, import one. */
function MyTemplates({ has, sq }) {
  const s = useStore();
  const list = s.myTemplates ?? [];
  const [saving, setSaving] = useState(null);
  const [sure, setSure] = useState(null);
  const file = useRef();
  useEffect(() => {
    refreshMyTemplates();
  }, []);
  const designHas = (s.scene.devices ?? []).length > 0;
  return html`<${Section} title="Your templates" count=${list.length || undefined}>
    ${saving
      ? html`<div class="tpl-save">
          <${TextField} value=${saving.name} placeholder="Name it" onChange=${(v) => setSaving({ ...saving, name: v })} />
          <${Switch} checked=${saving.keep} onChange=${(v) => setSaving({ ...saving, keep: v })} label="Keep the words" />
          <div class="note">${saving.keep ? "Its words come along as they are." : "Its words become placeholders; screenshots always become slots for the next app's."}</div>
          <div class="tpl-actions"><button class="btn sm ghost" onClick=${() => setSaving(null)}>Cancel</button>
            <button class="btn sm primary" onClick=${async () => {
              if (await saveAsTemplate(saving.name, saving.keep)) setSaving(null);
            }}>Save template</button></div>
        </div>`
      : html`<button class="btn block" disabled=${!designHas} title=${designHas ? "Keep this design's look to use with any app's screenshots" : "Add a screenshot first"}
          onClick=${() => setSaving({ name: s.sceneName && s.sceneName !== "Untitled" ? `${s.sceneName} look` : "My template", keep: false })}><${Icon} n="plus" s=${13} />Save this design as a template…</button>`}
    ${list.length > 0 &&
    html`<div class="set-templates">${list.map(
      (t) => html`<div class="set-template mine" key=${t.id} role="button" tabindex="0" onClick=${() => has && applyMyTemplate(t.id)} title=${has ? "Use it with this design's screenshots" : "Add a screenshot first"}>
        <div class="strip">${html`<img loading="lazy" src=${`/api/my-template-preview?id=${encodeURIComponent(t.id)}&w=640&body=${sq}`} />`}</div>
        <div class="tpl-row"><b>${t.name}</b><span class="faint">${t.screens} screen${t.screens === 1 ? "" : "s"}</span>
          <button class="icon-btn sm" title="Share: a file with its pictures inside" onClick=${(e) => (e.stopPropagation(), shareTemplate(t.id))}><${Icon} n="export" s=${13} /></button>
          <button class="icon-btn sm ${sure === t.id ? "danger" : ""}" title=${sure === t.id ? "Click again to delete it" : "Delete"} onClick=${(e) => {
            e.stopPropagation();
            if (sure === t.id) {
              setSure(null);
              deleteMyTemplate(t.id);
            } else setSure(t.id);
          }}><${Icon} n="trash" s=${13} /></button></div>
      </div>`,
    )}</div>`}
    <button class="btn sm ghost block" onClick=${() => file.current.click()}><${Icon} n="upload" s=${12} />Import a template…</button>
    <input type="file" ref=${file} hidden accept=".screenshotter-template,application/json" onChange=${(e) => {
      const f = e.target.files[0];
      e.target.value = "";
      if (f) importTemplateFile(f);
    }} />
  <//>`;
}

const FORM_NAME = { phone: "iPhone", tablet: "iPad", duoTall: "iPhone Duo", duoWide: "iPhone Duo", mac: "Mac" };
// A preview strip's shape: five screens side by side at the canvas each kind of screenshot gets.
const STRIP_SHAPE = { phone: "640 / 268", tablet: "640 / 165", duoTall: "640 / 165", duoWide: "640 / 93", mac: "640 / 78" };

/** The sets made for this kind of screenshot first, then the ones for every kind, then those made for another. */
function setsFor(list, form) {
  const rank = (t) => (!t.forms ? 1 : t.forms.includes(form) ? 0 : 2);
  return [...list].sort((a, b) => rank(a) - rank(b));
}

/** What the first screenshot is: iPhone, iPad, iPhone Duo (upright or held open), or Mac. */
function useShotForm(shot) {
  const [form, setForm] = useState(null);
  useEffect(() => {
    if (!shot) return setForm(null);
    let live = true;
    api(`/api/set-form?shot=${encodeURIComponent(shot)}`).then((r) => live && setForm(r.form ?? null)).catch(() => undefined);
    return () => {
      live = false;
    };
  }, [shot]);
  return form;
}

export function DesignsPanel() {
  const s = useStore();
  const body = recipeInput(s.scene);
  const has = body.devices.length > 0;
  const form = useShotForm(body.devices[0]?.screenshot);
  const q = encodeURIComponent(JSON.stringify(body));
  const setBody = setTemplateInput();
  const sq = encodeURIComponent(JSON.stringify(setBody));
  return html`<div class="panel left">
    <div class="panel-head"><h2>Templates</h2><span class="sub">${s.recipes.length}</span></div>
    <div class="panel-body">
      <div class="intro">Finished designs made from your screenshot, your headline and your app's colours. One click to try one; undo goes back.</div>
      <${DesignForMe} />
      <${Section} title="Whole sets" count=${s.setTemplates?.length}>
        <div class="note">Five screens in one look, made from your screenshots in order and your words: a hero, three features and a close.</div>
        ${!has && html`<div class="empty-note">Add a screenshot and each set shows a preview made from it.</div>`}
        <div class="set-templates">${setsFor(s.setTemplates ?? [], form).map(
          (t) => html`<button class="set-template" key=${t.id} disabled=${!has} onClick=${() => applySetTemplate(t.id)} title=${t.description}>
            <div class="strip" style=${{ aspectRatio: STRIP_SHAPE[form] ?? STRIP_SHAPE.phone }}>${has && html`<img loading="lazy" src=${`/api/set-template-preview?id=${t.id}&w=640&body=${sq}`} />`}</div>
            <b>${t.name}${t.forms?.includes(form) ? html` <em class="made-for">For ${FORM_NAME[form]}</em>` : ""}</b><span>${t.description}</span>
          </button>`,
        )}</div>
      <//>
      <${MyTemplates} has=${has} sq=${sq} />
      <${Section} title="Single screens" count=${s.recipes.length}>
        ${!has && html`<div class="empty-note">Add a screenshot and each template shows a preview made from it.</div>`}
        <div class="recipes">${s.recipes.map(
          (r) => html`<button class="recipe" key=${r.id} disabled=${!has} onClick=${() => applyRecipe(r.id)} title=${r.description}>
            <div class="recipe-img">${has && html`<img loading="lazy" src=${`/api/recipe-preview?id=${r.id}&w=320&body=${q}`} />`}</div>
            <b>${r.name}</b><span>${r.description}</span>
          </button>`,
        )}</div>
      <//>
      ${has && html`<${Arrangement} />`}
    </div>
  </div>`;
}

export { bgObj, keepTreatment, setBackground };
