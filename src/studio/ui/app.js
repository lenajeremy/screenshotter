// Screenshotter Studio — app shell.
import { render } from "preact";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { Dropdown, Popover, Seg, Slider, Switch, html } from "./controls.js";
import { Icon } from "./icons.js";
import { S, api, base, dismiss, entityLabel, fail, fileUrl, flushPersist, native, persist, redo, refreshFiles, restore, scheduleLayout, set, setScene, thumbUrl, toast, undo, useStore } from "./store.js";
import {
  addDevice,
  aiEdit,
  placeImports,
  answerConfirm,
  copyImage,
  deleteEntity,
  deleteFile,
  duplicateEntity,
  exportImage,
  exportVideo,
  newScene,
  openAI,
  renderPreview,
  reveal,
  uploadFiles,
  useCapture,
} from "./actions.js";
import { CanvasView, canvasApi, commitEntity } from "./canvas.js";
import { BackgroundsPanel, CapturesPanel, ExportsPanel, LayersPanel, TextPanel } from "./panels.js";
import { Inspector } from "./inspector.js";

// =============================================================================================
// Top bar

/** Edit shows placement; Preview shows the finished render, re-rendering when the design changed. */
export function showPreview() {
  if (!S.scene.devices.length) return set({ view: "render" });
  if (!S.render || S.renderStale) renderPreview();
  else set({ view: "render" });
}

function ViewSwitch() {
  const s = useStore();
  const ref = useRef();
  const [knob, setKnob] = useState(null);
  useLayoutEffect(() => {
    const on = ref.current.querySelector("button.on");
    if (on) setKnob({ left: on.offsetLeft, width: on.offsetWidth });
  }, [s.view]);
  return html`<div class="viewswitch" ref=${ref} data-nodrag>
    ${knob && html`<div class="knob" style=${{ left: knob.left + "px", width: knob.width + "px" }}></div>`}
    <button class=${s.view === "canvas" ? "on" : ""} onClick=${() => set({ view: "canvas" })} title="Arrange things by dragging (⌘1)"><${Icon} n="canvas" s=${14} />Edit</button>
    <button class=${s.view === "render" ? "on" : ""} onClick=${showPreview} title="See the finished image with lighting and effects (⌘2)"><${Icon} n="eye" s=${14} />Preview</button>
  </div>`;
}

function Topbar() {
  const s = useStore();
  const exportBtn = useRef();
  return html`<header class="topbar" data-drag>
    <div class="brand">
      <div class="brand-mark"></div>
      <span class="brand-name">Screenshotter</span>
      <span class="crumb-sep">/</span>
      <input class="scene-name" data-nodrag value=${s.sceneName} spellcheck=${false}
        onKeyDown=${(e) => {
          e.stopPropagation();
          if (e.key === "Enter" || e.key === "Escape") e.target.blur();
        }}
        onChange=${(e) => {
          set({ sceneName: e.target.value.trim() || "Untitled scene" });
          persist();
        }} />
    </div>
    <div class="topbar-center">
      <${ViewSwitch} />
      ${(s.busy || s.rendering) && html`<div class="activity" data-nodrag><span class="spinner"></span><span>${(s.busy ?? s.rendering).label}</span></div>`}
    </div>
    <span class="spacer"></span>
    <div class="hstack" data-nodrag>
      <button class="icon-btn" title="Undo (⌘Z)" disabled=${!s.past.length} onClick=${undo}><${Icon} n="undo" s=${16} /></button>
      <button class="icon-btn" title="Redo (⇧⌘Z)" disabled=${!s.future.length} onClick=${redo}><${Icon} n="redo" s=${16} /></button>
      <button class="icon-btn ${s.jsonOpen ? "on" : ""}" title="Developer view: the JSON an AI agent sends to make this image" onClick=${() => set({ jsonOpen: !s.jsonOpen })}><${Icon} n="code" s=${16} /></button>
      <span style=${{ width: "6px" }}></span>
      <button class="btn ai" onClick=${() => (s.ai.open ? set({ ai: { ...s.ai, open: false } }) : openAI())} title="Describe a change in plain words and AI makes it (⌘K)"><${Icon} n="spark" s=${15} class="spark" />Ask AI<span class="kbd">⌘K</span></button>
      <button class="btn primary" ref=${exportBtn} disabled=${!s.scene.devices.length || Boolean(s.rendering)} title="Save the finished image or video" onClick=${() => set({ exportOpen: !s.exportOpen })}><${Icon} n="export" s=${15} w=${2} />Export</button>
    </div>
    ${(s.busy || s.rendering) && html`<div class="progress-line"></div>`}
    ${s.exportOpen && html`<${ExportPopover} anchor=${exportBtn.current} />`}
  </header>`;
}

// =============================================================================================
// Export

const MOTIONS = [
  { value: "none", label: "Still" },
  { value: "subtle", label: "Subtle" },
  { value: "float", label: "Float" },
  { value: "drift", label: "Drift" },
  { value: "push-in", label: "Push in" },
];

function ExportPopover({ anchor }) {
  const s = useStore();
  const o = s.exportOpts;
  const up = (patch) => {
    set({ exportOpts: { ...S.exportOpts, ...patch } });
    persist();
  };
  const upv = (patch) => up({ video: { ...S.exportOpts.video, ...patch } });
  const W = s.layout?.canvas.width ?? 0;
  const H = s.layout?.canvas.height ?? 0;
  const outW = o.size === "half" ? Math.round(W / 2) : o.size === "custom" ? o.width : W;
  const outH = W ? Math.round((outW * H) / W) : 0;
  const hasRecording = s.scene.devices.some((d) => d.video);
  return html`<${Popover} anchor=${anchor} align="end" class="export-pop" onClose=${() => set({ exportOpen: false })}>
    <div class="tabs"><${Seg} value=${o.tab} onChange=${(v) => up({ tab: v })} options=${[{ value: "image", label: "Image", icon: "image" }, { value: "video", label: "Video", icon: "video" }]} /></div>
    ${o.tab === "image"
      ? html`<div class="body">
          <div class="row"><label>Format</label><${Seg} value=${o.format} options=${[{ value: "png", label: "PNG" }, { value: "jpeg", label: "JPEG" }, { value: "webp", label: "WebP" }]} onChange=${(v) => up({ format: v })} /></div>
          <div class="row"><label>Size</label><${Seg} value=${o.size} options=${[{ value: "full", label: "Full" }, { value: "half", label: "½" }, { value: "custom", label: "Width" }]} onChange=${(v) => up({ size: v })} /></div>
          ${o.size === "custom" && html`<div class="row"><label>Width</label><input class="input sm mono" type="number" min="16" max="8192" value=${o.width} onKeyDown=${(e) => e.stopPropagation()} onChange=${(e) => up({ width: Math.max(16, Math.min(8192, Number(e.target.value) || 1080)) })} /></div>`}
          ${o.format !== "png" && html`<div class="row"><label>Quality</label><${Slider} value=${o.jpegQuality} min=${50} max=${100} step=${1} format=${(v) => Math.round(v)} onChange=${(v) => up({ jpegQuality: v ?? 90 })} /></div>`}
          <div class="note">${outW && outH ? html`<b>${outW} × ${outH}</b> px · ` : ""}${o.format === "png" ? "lossless, transparent where the background is none" : o.format.toUpperCase()}</div>
          <button class="btn primary lg block" onClick=${exportImage}><${Icon} n="export" s=${16} w=${2} />Export image<span class="kbd">⌘E</span></button>
        </div>`
      : html`<div class="body">
          <div class="lbl">Camera motion</div>
          <div class="motions">${MOTIONS.map((m) => html`<button class="motion ${o.video.motion === m.value ? "on" : ""}" onClick=${() => upv({ motion: m.value })}><i class="mini ${m.value}"></i>${m.label}</button>`)}</div>
          <div class="row"><label>Length</label><${Slider} value=${o.video.duration} min=${2} max=${20} step=${0.5} format=${(v) => v + "s"} onChange=${(v) => upv({ duration: v ?? 6 })} /></div>
          <${Switch} checked=${o.video.zoom} onChange=${(v) => upv({ zoom: v })} label="Zoom into the first highlight" />
          <div class="row"><label>Format</label><${Seg} value=${o.video.format} options=${[{ value: "mp4", label: "MP4" }, { value: "mov", label: "MOV" }, { value: "webm", label: "WebM" }, { value: "gif", label: "GIF" }]} onChange=${(v) => upv({ format: v })} /></div>
          <div class="note">${hasRecording ? html`<b>Screen recording</b> plays inside the frame.` : "Tip: record the simulator to play real app footage inside the frame."}</div>
          <button class="btn primary lg block" onClick=${exportVideo}><${Icon} n="video" s=${16} />Export video<span class="kbd">⇧⌘E</span></button>
        </div>`}
    <div class="foot"><${Icon} n="folder" s=${13} /><span class="grow" style=${{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title=${s.opts?.outputRoot}>${shortPath(s.opts?.outputRoot)}</span>
      <button class="btn sm ghost" onClick=${() => set({ modal: { kind: "settings" }, exportOpen: false })}>Change</button></div>
  <//>`;
}
const shortPath = (p) => (p ?? "").replace(/^\/Users\/[^/]+/, "~");

// =============================================================================================
// Rail and left panel

const TABS = [
  { id: "captures", label: "Screens", icon: "captures", tip: "Capture or import screenshots" },
  { id: "backgrounds", label: "Backdrop", icon: "background", tip: "Photos, gradients and colours behind your device" },
  { id: "text", label: "Text", icon: "text", tip: "Headline, labels and badges" },
  { id: "layers", label: "Layers", icon: "layers", tip: "Everything in the image, front to back" },
  { id: "exports", label: "Saved", icon: "exports", tip: "Images and videos you've exported" },
];

function Rail() {
  const s = useStore();
  const pick = (id) => {
    set(s.leftTab === id && s.leftOpen ? { leftOpen: false } : { leftTab: id, leftOpen: true });
    persist();
  };
  return html`<nav class="rail">
    ${TABS.map((t) => html`<button class="rail-btn ${s.leftOpen && s.leftTab === t.id ? "on" : ""}" onClick=${() => pick(t.id)}>
      <${Icon} n=${t.icon} s=${19} />
      <span class="rl">${t.label}</span>
      <span class="tip">${t.tip}</span>
    </button>`)}
    <span class="grow"></span>
    <button class="rail-btn" onClick=${() => set({ modal: { kind: "help" } })}><${Icon} n="info" s=${18} /><span class="rl">Help</span><span class="tip">How Screenshotter works</span></button>
    <button class="rail-btn ${s.modal?.kind === "settings" ? "on" : ""}" onClick=${() => set({ modal: { kind: "settings" } })}><${Icon} n="settings" s=${18} /><span class="rl">Settings</span><span class="tip">AI, output folder, shortcuts</span></button>
  </nav>`;
}

function LeftPanel() {
  const s = useStore();
  const P = { captures: CapturesPanel, backgrounds: BackgroundsPanel, text: TextPanel, layers: LayersPanel, exports: ExportsPanel }[s.leftTab] ?? CapturesPanel;
  return html`<${P} />`;
}

// =============================================================================================
// Stage

function Hero() {
  const s = useStore();
  const shots = s.files.filter((f) => ["raw", "uploads", "recordings"].includes(f.kind) && /\.(png|jpe?g|webp)$/i.test(f.path)).slice(0, 7);
  const booted = s.opts?.simulators?.find((x) => x.state === "Booted");
  const go = (source) => set({ leftTab: "captures", leftOpen: true, capture: { ...S.capture, source } });
  return html`<div class="hero"><div class="hero-inner">
    <h1>Make your app look <em>incredible.</em></h1>
    <div class="steps">
      <div class="step on"><span class="n">1</span>Add a screenshot</div><span class="step-line"></span>
      <div class="step"><span class="n">2</span>Make it yours</div><span class="step-line"></span>
      <div class="step"><span class="n">3</span>Export</div>
    </div>
    <p>Start by bringing in a screen from your app. Pick one:</p>
    <div class="starts">
      <button class="start" onClick=${() => go("simulator")}><span class="ico"><${Icon} n="sim" s=${18} /></span><b>From the iOS Simulator</b><span>${booted ? `Grabs whatever ${booted.name} shows, with a clean status bar` : "Boots an iPhone simulator and grabs the screen"}</span></button>
      <button class="start" onClick=${() => go("web")}><span class="ico"><${Icon} n="globe" s=${18} /></span><b>From a website</b><span>Type a URL; captured on a phone or desktop</span></button>
      <button class="start" onClick=${() => go("import")}><span class="ico"><${Icon} n="upload" s=${18} /></span><b>From a file</b><span>Drop images anywhere in this window, or paste with ⌘V</span></button>
    </div>
    ${shots.length > 0 &&
    html`<div class="vstack" style=${{ alignItems: "center", gap: "10px" }}>
      <span class="note">…or click one you captured before</span>
      <div class="recent-strip">${shots.map((f) => html`<button title=${base(f.path)} onClick=${() => addDevice(f.path)}><img src=${thumbUrl(f.path, 160)} /></button>`)}</div>
    </div>`}
  </div></div>`;
}

/** A small checklist that teaches the flow once there's something on the canvas. */
function Checklist() {
  const s = useStore();
  if (s.guideDone) return null;
  const sc = s.scene;
  const steps = [
    { done: sc.devices.length > 0, label: "Add a screenshot", hint: "Screens panel" },
    { done: s.touched.backdrop || (sc.background !== "meadow-motion" && sc.background !== undefined), label: "Choose a backdrop", hint: "Backdrop panel", go: () => set({ leftTab: "backgrounds", leftOpen: true }) },
    { done: Boolean(sc.headline), label: "Write a headline", hint: "Text panel or double-click", go: () => set({ leftTab: "text", leftOpen: true }) },
    { done: s.touched.moved, label: "Drag the device where you like", hint: "Or ask AI to do it" },
    { done: s.files.some((f) => f.kind === "mockups" || f.kind === "videos") && s.touched.exported, label: "Export the image", hint: "Top-right button", go: () => set({ exportOpen: true }) },
  ];
  const n = steps.filter((x) => x.done).length;
  const next = steps.find((x) => !x.done);
  const dismiss = () => {
    set({ guideDone: true });
    persist();
  };
  if (n === steps.length) setTimeout(dismiss, 2500);
  // A small pill showing the next step, so it never covers the design; click it for the list.
  const open = S.guideOpen ?? false;
  const toggle = () => set({ guideOpen: !open });
  if (!open) {
    return html`<div class="checklist mini" onPointerDown=${(e) => e.stopPropagation()}>
      <button class="cl-mini" onClick=${toggle} title="Show the getting-started checklist">
        <span class="cl-ring" style=${{ "--p": n / steps.length }}></span>
        <span class="grow">${next ? html`<span class="faint">Next:</span> ${next.label}` : "All done"}</span>
        <${Icon} n="down" s=${12} style=${{ transform: "rotate(180deg)" }} />
      </button>
    </div>`;
  }
  return html`<div class="checklist" onPointerDown=${(e) => e.stopPropagation()}>
    <div class="cl-head"><b>Getting started</b><span class="faint">${n}/${steps.length}</span><span class="grow"></span>
      <button class="icon-btn sm" title="Minimise" onClick=${toggle}><${Icon} n="down" s=${12} /></button>
      <button class="icon-btn sm" title="Don't show again" onClick=${dismiss}><${Icon} n="x" s=${12} /></button></div>
    <div class="cl-bar"><i style=${{ width: (n / steps.length) * 100 + "%" }}></i></div>
    ${steps.map((x) => html`<button class="cl-item ${x.done ? "done" : ""}" onClick=${x.go} disabled=${!x.go || x.done} title=${x.hint}>
      <span class="cl-dot">${x.done && html`<${Icon} n="check" s=${10} w=${3} />`}</span>
      <span class="grow">${x.label}</span>${!x.done && x.go && html`<${Icon} n="right" s=${12} class="go" />`}
    </button>`)}
  </div>`;
}

function RenderView() {
  const s = useStore();
  const r = s.render;
  // Drag the finished file out to Finder, Slack, Figma… once the pointer actually moves, so a
  // plain click doesn't start a drag.
  const dragOut = (e) => {
    if (!native || !r || e.button !== 0) return;
    e.preventDefault();
    const x0 = e.clientX;
    const y0 = e.clientY;
    const move = (m) => {
      if (Math.hypot(m.clientX - x0, m.clientY - y0) < 4) return;
      stop();
      native.call("dragFile", { path: r.path }).catch(() => undefined);
    };
    const stop = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", stop);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", stop);
  };
  return html`<div class="render-view">
    ${r
      ? html`
        <div class="render-meta">
          <span class="meta-chip">${r.preview ? "Preview · half size" : r.isVideo ? "Video" : (r.path.split(".").pop() ?? "").toUpperCase()}</span>
          ${r.width && html`<span class="meta-chip">${r.width} × ${r.height}</span>`}
          ${r.ms && html`<span class="meta-chip">${r.ms > 2000 ? (r.ms / 1000).toFixed(1) + " s" : Math.round(r.ms) + " ms"}</span>`}
          ${s.renderStale && html`<button class="meta-chip stale" onClick=${renderPreview} style=${{ border: 0 }}><${Icon} n="refresh" s=${12} />You changed the design · update preview</button>`}
        </div>
        <div class="render-frame">
          ${r.isVideo
            ? html`<video key=${r.path} src=${fileUrl(r.path, r.at)} autoplay loop muted playsinline controls></video>`
            : html`<img key=${r.path + r.at} src=${fileUrl(r.path, r.at)} draggable=${!native} onMouseDown=${native ? dragOut : undefined} class=${native ? "drag-out" : ""} title=${native ? "Drag into Finder, Slack, Figma…" : ""} />`}
        </div>
        <div class="float render-actions">
          ${r.preview
            ? html`<button class="btn" onClick=${() => set({ exportOpen: true })}><${Icon} n="export" s=${14} />Export full size…</button>`
            : html`<button class="btn" onClick=${() => reveal(r.path)}><${Icon} n="folder" s=${14} />Show in Finder</button>
                ${!r.isVideo && html`<button class="btn" onClick=${() => copyImage(r.path)}><${Icon} n="copy" s=${14} />Copy</button>`}
                <button class="btn danger" onClick=${() => deleteFile(r.path)}><${Icon} n="trash" s=${14} />Delete</button>`}
          <span style=${{ width: "1px", height: "18px", background: "var(--line-2)", margin: "0 4px" }}></span>
          <button class="btn" onClick=${() => set({ view: "canvas" })}><${Icon} n="canvas" s=${14} />Back to editing</button>
        </div>`
      : html`<div class="render-empty">
          <div class="big"><${Icon} n="eye" s=${30} w=${1.4} /></div>
          <h2>${s.scene.devices.length ? "See the finished image" : "Nothing to preview yet"}</h2>
          <span>${s.scene.devices.length ? "Edit shows where things go. Preview shows the real device frame, lighting and effects." : "Add a screenshot first, then come back here."}</span>
          <div class="hstack"><button class="btn" onClick=${renderPreview} disabled=${!s.scene.devices.length}>Show preview <span class="kbd">⌘R</span></button>
          <button class="btn primary" onClick=${exportImage} disabled=${!s.scene.devices.length}>Export image <span class="kbd">⌘E</span></button></div>
        </div>`}
    ${s.rendering && html`<div class="rendering-overlay"><div><div class="orb" style=${{ margin: "0 auto" }}></div><div class="label">${s.rendering.label}</div></div></div>`}
  </div>`;
}

function Stage() {
  const s = useStore();
  const empty = !s.scene.devices.length;
  return html`<main class="stage">
    <div class="stage-glow"></div>
    ${s.view === "render" ? html`<${RenderView} />` : empty ? html`<div class="dots"></div><${Hero} />` : html`<${CanvasView} />`}
    ${s.view === "canvas" && !empty && html`<${Checklist} />`}
    ${s.view === "canvas" && !empty && html`<${AIDock} />`}
    ${s.jsonOpen && html`<${JsonDrawer} />`}
  </main>`;
}

// =============================================================================================
// AI dock

function suggestionsFor(sel) {
  if (sel?.startsWith("device-")) return ["Tilt it 12° to the right", "Make it 20% bigger", "Move it to the left third", "Give it a floating 3D angle"];
  if (sel === "caption") return ["Punchier headline, 4 words", "Put the title at the bottom", "Accent the key word in orange", "Serif font, lighter weight"];
  if (sel?.startsWith("text-")) return ["Turn it into a pill badge", "Move it above the phone", "Make it smaller and uppercase"];
  return ["Warm sunset background", "Add a second phone, overlapping", "Make it feel premium and calm", "Bold headline about speed"];
}

function AIDock() {
  const s = useStore();
  const ai = s.ai;
  const ref = useRef();
  const [hist, setHist] = useState(-1);
  useEffect(() => {
    if (ai.open) setTimeout(() => ref.current?.focus(), 20);
  }, [ai.open]);
  useLayoutEffect(() => {
    const t = ref.current;
    if (!t) return;
    t.style.height = "auto";
    t.style.height = Math.min(140, t.scrollHeight) + "px";
  }, [ai.text, ai.open]);
  const setAi = (patch) => set({ ai: { ...S.ai, ...patch } });
  const status = s.opts?.ai;
  if (!ai.open) {
    return html`<div class="ai-dock"><button class="ai-pill" onClick=${() => openAI()}>
      <${Icon} n="spark" s=${16} class="spark" /><span>Describe a change${s.selected ? ` to ${entityLabel(s.selected)}` : ""}…</span><span class="kbd">⌘K</span>
    </button></div>`;
  }
  const send = () => aiEdit(ai.text);
  return html`<div class="ai-dock" onPointerDown=${(e) => e.stopPropagation()}>
    ${!ai.busy && !ai.text && html`<div class="suggestions">${suggestionsFor(ai.context ? s.selected : null).map((t) => html`<button class="chip" onClick=${() => aiEdit(t)}>${t}</button>`)}</div>`}
    <div class="ai-card ${ai.busy ? "busy" : ""}">
      <div class="ai-inner">
        ${ai.error && html`<div class="ai-error">${ai.error}${status && !status.available ? html` <a href="#" onClick=${(e) => {
          e.preventDefault();
          set({ modal: { kind: "settings" } });
        }}>Open Settings</a>` : ""}</div>`}
        <textarea ref=${ref} rows="1" value=${ai.text} disabled=${ai.busy}
          placeholder=${status && !status.available ? "AI Edit needs Claude Code or an API key (see Settings)…" : "Describe a change… “tilt the phone and make the title warmer”"}
          onInput=${(e) => {
            setAi({ text: e.target.value, error: null });
            setHist(-1);
          }}
          onKeyDown=${(e) => {
            e.stopPropagation();
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            } else if (e.key === "Escape") setAi({ open: false, error: null });
            else if (e.key === "ArrowUp" && !ai.text.includes("\n") && ai.history.length && (e.target.selectionStart === 0 || !ai.text)) {
              e.preventDefault();
              const n = hist < 0 ? ai.history.length - 1 : Math.max(0, hist - 1);
              setHist(n);
              setAi({ text: ai.history[n] });
            } else if (e.key === "ArrowDown" && hist >= 0) {
              e.preventDefault();
              const n = hist + 1;
              if (n >= ai.history.length) {
                setHist(-1);
                setAi({ text: "" });
              } else {
                setHist(n);
                setAi({ text: ai.history[n] });
              }
            }
          }}></textarea>
        <div class="ai-foot">
          ${ai.busy
            ? html`<span class="ai-status"><span class="spinner"></span><span class="shimmer-text">Claude is editing the scene…</span></span>`
            : s.selected && ai.context
              ? html`<span class="ctx-chip"><${Icon} n=${s.selected.startsWith("device") ? "phone" : "text"} s=${12} />${entityLabel(s.selected)}<button title="Apply to the whole scene" onClick=${() => setAi({ context: false })}><${Icon} n="x" s=${11} /></button></span>`
              : html`<span class="ctx-chip" style=${{ background: "var(--panel-3)", color: "var(--text-2)" }}><${Icon} n="canvas" s=${12} />Whole scene</span>`}
          <span class="grow"></span>
          <span class="faint" style=${{ fontSize: "11px" }}>${status?.provider === "api" ? status.model : status?.provider === "claude-code" ? "Claude Code" : ""}</span>
          <button class="icon-btn sm" title="Close (Esc)" onClick=${() => setAi({ open: false, error: null })}><${Icon} n="x" s=${14} /></button>
          <button class="send" disabled=${!ai.text.trim() || ai.busy} onClick=${send} title="Apply (Enter)"><${Icon} n="up" s=${16} w=${2.4} /></button>
        </div>
      </div>
    </div>
  </div>`;
}

// =============================================================================================
// JSON drawer — the exact MCP request, editable

function JsonDrawer() {
  const s = useStore();
  const [text, setText] = useState(() => JSON.stringify(s.scene, null, 2));
  const [err, setErr] = useState(null);
  const [dirty, setDirty] = useState(false);
  useEffect(() => {
    if (!dirty) setText(JSON.stringify(s.scene, null, 2));
  }, [s.scene]);
  const apply = async () => {
    try {
      const next = JSON.parse(text);
      if (!Array.isArray(next.devices)) throw new Error("The scene needs a devices array.");
      if (next.devices.length) await api("/api/layout", next);
      setScene(next);
      setDirty(false);
      setErr(null);
      toast({ kind: "ok", title: "Scene updated from JSON", timeout: 2500 });
    } catch (e) {
      setErr(e.message);
    }
  };
  return html`<div class="json-drawer" onPointerDown=${(e) => e.stopPropagation()}>
    <div class="panel-head"><h2>Scene JSON <span class="sub">create_mockup arguments</span></h2>
      <button class="icon-btn sm" onClick=${() => set({ jsonOpen: false })}><${Icon} n="x" s=${14} /></button></div>
    <textarea spellcheck=${false} value=${text} onKeyDown=${(e) => {
      e.stopPropagation();
      if (e.key === "Enter" && e.metaKey) apply();
    }} onInput=${(e) => {
      setText(e.target.value);
      setDirty(true);
    }}></textarea>
    <div class="foot">
      ${err ? html`<span class="note err grow">${err}</span>` : html`<span class="note grow">${dirty ? "Edited: apply to update the canvas (⌘↩)" : "Agents send exactly this to the MCP."}</span>`}
      <button class="btn sm" onClick=${() => {
        navigator.clipboard.writeText(text);
        toast({ kind: "ok", title: "Copied JSON", timeout: 1800 });
      }}><${Icon} n="copy" s=${13} />Copy</button>
      <button class="btn sm primary" disabled=${!dirty} onClick=${apply}>Apply</button>
    </div>
  </div>`;
}

// =============================================================================================
// Modals

function Settings() {
  const s = useStore();
  const [info, setInfo] = useState(null);
  const [key, setKey] = useState("");
  const [saving, setSaving] = useState(false);
  const ai = s.opts?.ai;
  useEffect(() => {
    native?.call("getSettings").then(setInfo).catch(() => setInfo({}));
  }, []);
  const saveKey = async (value) => {
    setSaving(true);
    try {
      await native.call("setApiKey", { key: value });
      toast({ kind: "ok", title: value ? "API key saved to Keychain" : "API key removed", text: "Restarting the engine…" });
    } catch (e) {
      fail(e, "Couldn't save the key");
    } finally {
      setSaving(false);
    }
  };
  const models = [
    { value: "", label: "Claude Opus 5.5", hint: "default" },
    { value: "claude-sonnet-5-5", label: "Claude Sonnet 5.5", hint: "faster" },
    { value: "claude-haiku-4-5", label: "Claude Haiku 4.5", hint: "fastest" },
    { value: "claude-fable-5-1", label: "Claude Fable 5.1", hint: "most capable" },
  ];
  return html`<div class="scrim" onPointerDown=${(e) => e.target === e.currentTarget && set({ modal: null })}>
    <div class="sheet">
      <div class="sheet-head"><h2>Settings</h2><button class="icon-btn" onClick=${() => set({ modal: null })}><${Icon} n="x" s=${16} /></button></div>
      <div class="sheet-body">
        <div class="card">
          <h4><${Icon} n="spark" s=${15} style=${{ color: "var(--pink)" }} />AI Edit
            <span class="grow"></span>
            ${ai?.provider === "api" ? html`<span class="pill ok"><span class="status-dot ok"></span>Anthropic API</span>` : ai?.provider === "claude-code" ? html`<span class="pill ok"><span class="status-dot ok"></span>Claude Code</span>` : html`<span class="pill"><span class="status-dot warn"></span>Not set up</span>`}
          </h4>
          <div class="note">Describe a change and Claude edits the scene. It uses your <b>Anthropic API key</b> if one is set, otherwise your signed-in <b>Claude Code</b> (${ai?.claudeCode ? "found" : "not found; install it and run claude once"}). Screenshots stay on your Mac: Claude sees the scene settings, with file paths replaced by placeholders.</div>
          ${native
            ? html`<div class="row"><label>API key</label><div class="hstack">
                <input class="input grow mono" type="password" placeholder=${info?.hasApiKey ? "•••••••••• saved in Keychain" : "sk-ant-… (optional)"} value=${key} onInput=${(e) => setKey(e.target.value)} onKeyDown=${(e) => e.stopPropagation()} />
                <button class="btn" disabled=${!key.trim() || saving} onClick=${() => saveKey(key.trim())}>Save</button>
                ${info?.hasApiKey && html`<button class="btn ghost" disabled=${saving} onClick=${() => saveKey("")}>Remove</button>`}
              </div></div>`
            : html`<div class="note">To use an API key, start the Studio with <code>ANTHROPIC_API_KEY</code> set.</div>`}
          <div class="row"><label>Model</label><${Dropdown} value=${s.ai.model} options=${models} onChange=${(v) => {
            set({ ai: { ...S.ai, model: v } });
            persist();
          }} /></div>
        </div>
        <div class="card">
          <h4><${Icon} n="folder" s=${15} />Output folder</h4>
          <div class="hstack"><span class="mono grow" style=${{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--text-2)" }}>${shortPath(s.opts?.outputRoot)}</span>
            <button class="btn sm" onClick=${() => reveal(s.opts.outputRoot)}>Show</button>
            ${native && html`<button class="btn sm" onClick=${async () => {
              try {
                const r = await native.call("chooseOutputFolder");
                if (r?.path) toast({ kind: "ok", title: "Output folder changed", text: `${shortPath(r.path)} · restarting…` });
              } catch (e) {
                fail(e);
              }
            }}>Change…</button>`}
          </div>
          <div class="note">Captures, imports, renders and your current scene live here.</div>
        </div>
        <div class="card">
          <h4><${Icon} n="wand" s=${15} />AI backgrounds</h4>
          <div class="note">${s.opts?.aiProviders?.length ? html`Using <b>${s.opts.aiProviders.join(", ")}</b>.` : html`Add <code>OPENAI_API_KEY</code>, <code>GEMINI_API_KEY</code>, <code>REPLICATE_API_TOKEN</code> or <code>FAL_KEY</code> to your shell profile (~/.zshrc) and restart Screenshotter.`}</div>
        </div>
        <div class="card">
          <h4><${Icon} n="bolt" s=${15} />Shortcuts</h4>
          <div class="shortcuts">
            ${[
              ["Ask AI", "⌘K"],
              ["Quick preview", "⌘R"],
              ["Export image / video", "⌘E / ⇧⌘E"],
              ["Canvas / Render", "⌘1 / ⌘2"],
              ["Undo / Redo", "⌘Z / ⇧⌘Z"],
              ["Duplicate / Delete", "⌘D / ⌫"],
              ["Nudge (×10 with ⇧)", "← ↑ → ↓"],
              ["Scale / Rotate", "+ − / [ ]"],
              ["Zoom in / out / fit", "⌘+ / ⌘− / ⌘0"],
              ["Pan", "Space-drag or scroll"],
              ["Import from clipboard", "⌘V"],
            ].map(([a, b]) => html`<span>${a}</span><span class="kbd">${b}</span>`)}
          </div>
        </div>
        ${info?.version && html`<div class="note" style=${{ textAlign: "center" }}>Screenshotter ${info.version} · engine on ${location.host} · Node ${info.node ?? ""}</div>`}
      </div>
    </div>
  </div>`;
}

function Help() {
  const close = () => set({ modal: null });
  const steps = [
    ["sim", "1 · Add a screenshot", "Capture your app from the iOS Simulator, a website, or a Mac window, or drop in image files. They collect in the Screens panel; click one to use it."],
    ["canvas", "2 · Make it yours", "Edit mode shows where things go. Drag the device to move it, pull a corner to resize, use the round handle to rotate. Double-click text to retype it. Pick a Backdrop, add a headline in Text."],
    ["spark", "Or just ask", "Press Ask AI (⌘K) and describe the change: “tilt the phone and use a sunset backdrop”. Undo (⌘Z) reverts anything."],
    ["eye", "Preview", "Edit mode is a quick layout guide. Preview renders the finished image with the real frame, lighting and effects."],
    ["export", "3 · Export", "Export saves a full-size PNG, JPEG or WebP, or a video with gentle camera motion. Everything lands in your output folder."],
  ];
  return html`<div class="scrim" onPointerDown=${(e) => e.target === e.currentTarget && close()}>
    <div class="sheet">
      <div class="sheet-head"><h2>How Screenshotter works</h2><button class="icon-btn" onClick=${close}><${Icon} n="x" s=${16} /></button></div>
      <div class="sheet-body">
        ${steps.map(([icon, title, text]) => html`<div class="help-row"><span class="ico"><${Icon} n=${icon} s=${18} /></span><div><b>${title}</b><div class="note" style=${{ fontSize: "12.5px" }}>${text}</div></div></div>`)}
        <div class="hstack">
          <button class="btn" onClick=${() => {
            set({ guideDone: false, modal: null });
            persist();
          }}>Show the getting-started checklist</button>
          <button class="btn ghost" onClick=${() => (native ? native.call("openURL", { url: `${location.origin}/docs` }) : window.open("/docs", "_blank"))}><${Icon} n="book" s=${14} />Full documentation</button>
        </div>
      </div>
    </div>
  </div>`;
}

function Confirm() {
  const m = S.modal;
  useEffect(() => {
    const key = (e) => {
      if (e.key === "Enter") answerConfirm(true);
      if (e.key === "Escape") answerConfirm(false);
      e.stopPropagation();
    };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  }, []);
  return html`<div class="scrim" onPointerDown=${(e) => e.target === e.currentTarget && answerConfirm(false)}>
    <div class="sheet" style=${{ width: "400px" }}>
      <div class="sheet-head"><h2>${m.title}</h2></div>
      <div class="sheet-body"><div class="note" style=${{ fontSize: "13px" }}>${m.text}</div></div>
      <div class="sheet-foot"><button class="btn" onClick=${() => answerConfirm(false)}>Cancel</button>
        <button class="btn ${m.danger ? "" : "primary"}" style=${m.danger ? { background: "var(--danger)", color: "#fff" } : null} autoFocus onClick=${() => answerConfirm(true)}>${m.confirm ?? "OK"}</button></div>
    </div>
  </div>`;
}

/** Toasts show AI summaries verbatim; drop the **accent** markers. */
const plain = (v) => (typeof v === "string" ? v.replace(/\*\*(.+?)\*\*/g, "$1") : v);

function Toasts() {
  const s = useStore();
  const icons = { ok: "check", err: "alert", warn: "alert", ai: "spark" };
  return html`<div class="toasts">${s.toasts.map(
    (t) => html`<div class="toast ${t.kind} ${t.leaving ? "leaving" : ""}" key=${t.id}>
      <span class="ti"><${Icon} n=${t.icon ?? icons[t.kind] ?? "info"} s=${13} w=${2.2} /></span>
      <div class="tb"><b>${plain(t.title)}</b>${t.text && html`<span class="d">${plain(t.text)}</span>`}
        ${t.actions?.length > 0 && html`<div class="ta">${t.actions.map((a) => html`<button class="btn sm" onClick=${() => {
          a.run();
          dismiss(t.id);
        }}>${a.label}</button>`)}</div>`}
      </div>
      <button class="icon-btn sm x" onClick=${() => dismiss(t.id)}><${Icon} n="x" s=${12} /></button>
    </div>`,
  )}</div>`;
}

// =============================================================================================
// Root

function App() {
  const s = useStore();
  if (s.bootError) {
    return html`<div class="hero"><div class="hero-inner"><h1>Couldn't reach the <em>engine.</em></h1><p>${s.bootError}</p><button class="btn primary" onClick=${() => location.reload()}>Try again</button></div></div>`;
  }
  if (!s.ready) return html`<div class="boot"><div class="boot-mark"></div></div>`;
  return html`<div class="app ${s.leftOpen ? "" : "left-closed"}">
    <${Topbar} />
    <${Rail} />
    <${LeftPanel} />
    <${Stage} />
    <${Inspector} />
    ${s.modal?.kind === "settings" && html`<${Settings} />`}
    ${s.modal?.kind === "confirm" && html`<${Confirm} />`}
    ${s.modal?.kind === "help" && html`<${Help} />`}
    <${Toasts} />
    ${s.dropping && html`<div class="drop-veil"><div><${Icon} n="upload" s=${28} />Drop to add to the scene</div></div>`}
  </div>`;
}

// =============================================================================================
// Keyboard, clipboard, drag & drop, native menu commands

const typing = () => {
  const a = document.activeElement;
  return a && (/INPUT|TEXTAREA|SELECT/.test(a.tagName) || a.isContentEditable);
};

function nudgeSelected(dx, dy, scaleF, rot) {
  const e = S.layout?.entities.find((x) => x.id === S.selected);
  if (!e) return;
  const next = { ...e };
  next.x += dx;
  next.y += dy;
  if (scaleF) {
    if (e.kind === "device") {
      next.width *= scaleF;
      next.height *= scaleF;
    } else {
      next.size *= scaleF;
      if (next.subSize) next.subSize *= scaleF;
    }
  }
  if (rot && e.kind !== "caption") next.rotate = (e.rotate || 0) + rot;
  // Apply to the layout right away so repeated key presses build on each other.
  set({ layout: { ...S.layout, entities: S.layout.entities.map((x) => (x.id === e.id ? next : x)) } });
  commitEntity(next);
}

const commands = {
  undo: () => (typing() ? document.execCommand("undo") : undo()),
  redo: () => (typing() ? document.execCommand("redo") : redo()),
  ai: () => (S.ai.open ? set({ ai: { ...S.ai, open: false } }) : openAI()),
  preview: renderPreview,
  showPreview: () => showPreview(),
  exportImage,
  exportVideo,
  canvas: () => set({ view: "canvas" }),
  render: () => showPreview(),
  zoomIn: () => canvasApi.zoomBy(1.25),
  zoomOut: () => canvasApi.zoomBy(1 / 1.25),
  fit: () => canvasApi.fit(),
  actual: () => canvasApi.zoomTo(1),
  duplicate: () => S.selected && duplicateEntity(S.selected),
  delete: () => S.selected && deleteEntity(S.selected),
  settings: () => set({ modal: { kind: "settings" } }),
  help: () => set({ modal: { kind: "help" } }),
  newScene,
  import: () => {
    set({ leftTab: "captures", leftOpen: true, capture: { ...S.capture, source: "import" } });
    setTimeout(() => document.querySelector('.dropzone input[type="file"]')?.click(), 60);
  },
  toggleLeft: () => set({ leftOpen: !S.leftOpen }),
  json: () => set({ jsonOpen: !S.jsonOpen }),
  refresh: () => refreshFiles().catch(fail),
  // Files the desktop app imported (pasted, opened from Finder, dropped on the Dock icon):
  // place them exactly like a drop, recordings included.
  imported: async (items) => {
    await booted;
    await refreshFiles().catch(() => undefined);
    placeImports(items ?? []);
  },
  flush: () => flushPersist(),
  error: (message) => toast({ kind: "err", title: "Something went wrong", text: message }),
};
window.studio = { command: (name, arg) => commands[name]?.(arg), isTyping: () => Boolean(typing()), state: S };

window.addEventListener("keydown", (e) => {
  const mod = e.metaKey || e.ctrlKey;
  const k = e.key.toLowerCase();
  // Shortcuts that also work while typing.
  if (mod && k === "k") {
    e.preventDefault();
    return commands.ai();
  }
  if (typing()) return;
  if (S.modal) return;
  if (mod && !e.shiftKey && k === "z") return e.preventDefault(), undo();
  if (mod && ((e.shiftKey && k === "z") || k === "y")) return e.preventDefault(), redo();
  if (mod && k === "r") return e.preventDefault(), renderPreview();
  if (mod && k === "e") return e.preventDefault(), e.shiftKey ? exportVideo() : exportImage();
  if (mod && k === "1") return e.preventDefault(), commands.canvas();
  if (mod && k === "2") return e.preventDefault(), showPreview();
  if (mod && (k === "=" || k === "+")) return e.preventDefault(), commands.zoomIn();
  if (mod && k === "-") return e.preventDefault(), commands.zoomOut();
  if (mod && k === "0") return e.preventDefault(), commands.fit();
  if (mod && k === "d") return e.preventDefault(), commands.duplicate();
  if (mod && k === "o") return e.preventDefault(), commands.import();
  if (mod && k === ",") return e.preventDefault(), commands.settings();
  if (mod) return;
  if (e.key === "Escape") {
    if (S.exportOpen) return set({ exportOpen: false });
    if (S.jsonOpen) return set({ jsonOpen: false });
    if (S.ai.open) return set({ ai: { ...S.ai, open: false } });
    if (S.replacing) return set({ replacing: null });
    return set({ selected: null });
  }
  if (S.view !== "canvas" || !S.selected) {
    if (e.key === "Tab" && S.layout?.entities.length) {
      e.preventDefault();
      set({ selected: S.layout.entities[0].id });
    }
    return;
  }
  const step = e.shiftKey ? 0.01 : 0.001;
  const moves = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
  if (moves[e.key]) return e.preventDefault(), nudgeSelected(...moves[e.key]);
  if (e.key === "+" || e.key === "=") return e.preventDefault(), nudgeSelected(0, 0, e.shiftKey ? 1.1 : 1.02);
  if (e.key === "-" || e.key === "_") return e.preventDefault(), nudgeSelected(0, 0, 1 / (e.shiftKey ? 1.1 : 1.02));
  if (e.key === "[" || e.key === "]") return e.preventDefault(), nudgeSelected(0, 0, 0, (e.key === "[" ? -1 : 1) * (e.shiftKey ? 15 : 1));
  if (e.key === "Backspace" || e.key === "Delete") return e.preventDefault(), deleteEntity(S.selected);
  if (e.key === "Enter" && (S.selected === "caption" || S.selected.startsWith("text-"))) return e.preventDefault(), canvasApi.editText(S.selected);
  if (e.key === "Tab") {
    e.preventDefault();
    const ids = S.layout?.entities.map((x) => x.id) ?? [];
    const i = ids.indexOf(S.selected);
    set({ selected: ids[(i + (e.shiftKey ? -1 : 1) + ids.length) % ids.length] });
  }
});

// Paste a screenshot straight from the clipboard. (The desktop app handles ⌘V natively and
// calls `imported` instead, because the web view has no paste target outside text fields.)
window.addEventListener("paste", (e) => {
  if (typing() || native) return;
  const files = [...(e.clipboardData?.files ?? [])];
  if (!files.length) return;
  e.preventDefault();
  uploadFiles(files);
});

// Drop files from Finder anywhere in the window.
let dragDepth = 0;
const hasFiles = (e) => [...(e.dataTransfer?.types ?? [])].includes("Files");
window.addEventListener("dragenter", (e) => {
  if (!hasFiles(e)) return;
  dragDepth++;
  if (!S.dropping) set({ dropping: true });
});
window.addEventListener("dragleave", (e) => {
  if (!hasFiles(e)) return;
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) set({ dropping: false });
});
window.addEventListener("dragover", (e) => hasFiles(e) && e.preventDefault());
window.addEventListener("drop", (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  set({ dropping: false });
  uploadFiles(e.dataTransfer.files);
});

// Report the draggable title-bar area to the desktop shell.
function reportDragRegions() {
  if (!native) return;
  const bar = document.querySelector(".topbar");
  if (!bar) return;
  const r = bar.getBoundingClientRect();
  const holes = [...bar.querySelectorAll("[data-nodrag], button, input")].map((el) => {
    const b = el.getBoundingClientRect();
    return [b.left, b.top, b.width, b.height];
  });
  native.call("dragRegions", { regions: [[r.left, r.top, r.width, r.height]], holes }).catch(() => undefined);
}
let dragTimer = 0;
new MutationObserver(() => {
  clearTimeout(dragTimer);
  dragTimer = setTimeout(reportDragRegions, 120);
}).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["class"] });
window.addEventListener("resize", () => {
  clearTimeout(dragTimer);
  dragTimer = setTimeout(reportDragRegions, 60);
});

// =============================================================================================
// Boot

/** Resolves once the saved scene is restored, so nothing lands in the scene before it. */
let bootDone;
const booted = new Promise((r) => (bootDone = r));

async function boot() {
  render(html`<${App} />`, document.getElementById("root"));
  try {
    const [opts] = await Promise.all([api("/api/options"), restore(), refreshFiles().catch(() => [])]);
    set({ opts, ready: true });
    // Drop scene devices whose files were deleted outside the app.
    const known = new Set(S.files.map((f) => f.path));
    const missing = S.scene.devices.filter((d) => !known.has(d.screenshot));
    if (missing.length) {
      const exists = await Promise.all(missing.map((d) => fetch(`/thumb?path=${encodeURIComponent(d.screenshot)}&w=64`, { method: "GET" }).then((r) => r.ok).catch(() => false)));
      const gone = new Set(missing.filter((_, i) => !exists[i]).map((d) => d.screenshot));
      if (gone.size) set({ scene: { ...S.scene, devices: S.scene.devices.filter((d) => !gone.has(d.screenshot)) } });
    }
    scheduleLayout(0);
    bootDone();
    setTimeout(reportDragRegions, 300);
    // Keep the library fresh when captures arrive from agents using the MCP.
    setInterval(() => document.visibilityState === "visible" && !S.busy && refreshFiles().catch(() => undefined), 15000);
  } catch (e) {
    set({ bootError: e.message });
  }
}
boot();
