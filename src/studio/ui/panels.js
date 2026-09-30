// Left panels: Captures, Backgrounds, Text, Layers, Exports.
import { useEffect, useRef, useState } from "preact/hooks";
import { AccentText, ColorButton, Dropdown, Seg, Slider, Section, Switch, TextField, html } from "./controls.js";
import { Icon } from "./icons.js";
import { S, api, base, edit, entityLabel, fail, isVideo, refreshFiles, set, thumbUrl, touch, useStore } from "./store.js";
import {
  TEXT_PRESETS,
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
    { value: "", label: "Automatic", hint: "booted or newest iPhone" },
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
      <div class="row"><label>Link</label><${TextField} value=${c.deepLink} placeholder="myapp://screen" onChange=${(v) => setCap({ deepLink: v })} /></div>
      <div class="row"><label>Look</label><${Seg} value=${c.appearance} options=${[{ value: "light", label: "Light", icon: "sun" }, { value: "dark", label: "Dark", icon: "moon" }]} onChange=${(v) => setCap({ appearance: v })} /></div>
      <div class="row"><label>Time</label><${TextField} value=${c.time} placeholder="9:41" onChange=${(v) => setCap({ time: v })} /></div>
      <${Switch} checked=${c.grant} onChange=${(v) => setCap({ grant: v })} label="Pre-grant permissions" />
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
    <div class="panel-head"><h2>Screens</h2>
      <button class="icon-btn sm" title="Refresh the list" onClick=${() => refreshFiles().catch(fail)}><${Icon} n="refresh" s=${14} /></button>
    </div>
    <div class="panel-body">
      <div class="intro">Bring in a screen from your app, then click it to put it in the design.</div>
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
          : html`<div class="empty-note">${shots.length ? "Nothing here." : "Screens you capture or import appear here. Click one to use it, or drag it onto the design."}</div>`}
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

export function LayersPanel() {
  const s = useStore();
  const ents = [...(s.layout?.entities ?? [])].sort((a, b) => b.z - a.z);
  return html`<div class="panel left">
    <div class="panel-head"><h2>Layers</h2><span class="sub">${ents.length}</span></div>
    <div class="panel-body" style=${{ gap: "2px" }}>
      <div class="intro" style=${{ marginBottom: "8px" }}>Everything in the image, front to back. Click to select.</div>
      ${ents.map(
        (e) => html`<div class="layer ${s.selected === e.id ? "on" : ""}" onClick=${() => set({ selected: e.id, view: "canvas" })} onMouseEnter=${() => set({ hover: e.id })} onMouseLeave=${() => set({ hover: null })}>
          <span class="thumb">${e.kind === "device" ? html`<img src=${thumbUrl(e.screenshot, 80)} />` : html`<${Icon} n="text" s=${13} />`}</span>
          <span class="nm">${entityLabel(e.id)}</span>
          <span class="faint mono">${Math.round(e.z)}</span>
        </div>`,
      )}
      <div class="layer ${!s.selected ? "on" : ""}" onClick=${() => set({ selected: null, view: "canvas" })}>
        <span class="thumb"><${Icon} n="background" s=${13} /></span><span class="nm">Background</span><span class="faint">${typeof s.scene.background === "string" ? s.scene.background : bgObj(s.scene.background).look ?? ""}</span>
      </div>
      ${!ents.length && html`<div class="empty-note">Add a screenshot to start the scene.</div>`}
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
export function ExportsPanel() {
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
  const view = (f) => set({ render: { path: f.path, isVideo: isVideo(f.path), preview: false, at: f.mtime }, renderStale: false, view: "render" });
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
  return html`<div class="panel left">
    <div class="panel-head"><h2>Saved</h2><span class="sub">${outs.length}</span></div>
    <div class="panel-body">
      <div class="intro">Images and videos you've exported. Each scene keeps its versions; click one to view it.</div>
      ${groups.length
        ? html`<div class="shots two">${groups.map((g) => [
            tile(g.versions[0], g),
            open === g.key &&
              html`<div class="history" key=${`${g.key}-history`}>
                <div class="history-head"><b>${g.scene?.name ?? "Scene"}</b><span class="faint">${g.versions.length} versions</span></div>
                ${g.versions.map(
                  (v, i) => html`<div class="history-row" key=${v.path}>
                    <button class="history-pick" onClick=${() => view(v)}><img loading="lazy" src=${thumbUrl(v.path, 120)} /><span>${i === 0 ? "Latest" : `Version ${g.versions.length - i}`}<em>${since(v.mtime)}</em></span></button>
                    ${!isVideo(v.path) && html`<button class="btn sm ghost" title="Make this version the working design" onClick=${() => restoreVersion(v.path)}>Restore</button>`}
                  </div>`,
                )}
              </div>`,
          ])}</div>`
        : html`<div class="empty-note">Images and videos you export appear here.</div>`}
    </div>
  </div>`;
}

export { bgObj, keepTreatment, setBackground };
