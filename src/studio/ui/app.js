// Screenshotter Studio — app shell.
import { render } from "preact";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { Dropdown, Popover, Seg, Slider, Switch, TextField, html } from "./controls.js";
import { Icon } from "./icons.js";
import { S, api, base, dismiss, entityLabel, fail, fileUrl, flushPersist, isVideo, native, persist, redo, refreshFiles, refreshScenes, restore, saveSceneNow, scheduleLayout, set, setScene, thumbUrl, toast, undo, useStore } from "./store.js";
import {
  answerPrompt,
  deleteSavedScene,
  duplicateSavedScene,
  openScene,
  renameSavedScene,
  saveNow,
  canRevertAI,
  newChat,
  revertAI,
  addCaption,
  addDevice,
  addText,
  aiEdit,
  moveZ,
  placeImports,
  replaceMode,
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
import { CanvasView, canvasApi, commitEntity, withShape } from "./canvas.js";
import { ContextMenu, openMenu } from "./menu.js";
import { BackgroundsPanel, CapturesPanel, DesignsPanel, ExportsPanel, LayersPanel, ShapesPanel, TextPanel } from "./panels.js";
import { Inspector } from "./inspector.js";
import { ScenesPage, ScenesPopover, SceneThumb, closeScenesPage, openScenesPage, sceneMenu, toggleScenesPage } from "./scenes.js";

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
  const scenesBtn = useRef();
  return html`<header class="topbar" data-drag>
    <div class="brand">
      <div class="brand-mark"></div>
      <span class="brand-name">Screenshotter</span>
      <span class="crumb-sep">/</span>
      <div class="scene-switch ${s.scenesOpen ? "open" : ""}" data-nodrag ref=${scenesBtn}>
        <input class="scene-name" value=${s.sceneName} spellcheck=${false} title="Rename this scene"
          onKeyDown=${(e) => {
            e.stopPropagation();
            if (e.key === "Enter" || e.key === "Escape") e.target.blur();
          }}
          onChange=${(e) => {
            set({ sceneName: e.target.value.trim() || "Untitled scene" });
            persist();
          }} />
        <button class="scene-chev" title="Switch scene" onClick=${() => set({ scenesOpen: !s.scenesOpen })}><${Icon} n="down" s=${13} /></button>
      </div>
      <button class="icon-btn sm" data-nodrag title="New scene (⌘N)" onClick=${newScene}><${Icon} n="plus" s=${15} /></button>
    </div>
    ${s.scenesOpen && html`<${ScenesPopover} anchor=${scenesBtn.current} />`}
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
// Scenes

// The switcher, the Scenes page and the scene menus live in scenes.js.

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
  { id: "designs", label: "Designs", icon: "wand", tip: "Complete designs from your screens, or three from Claude" },
  { id: "backgrounds", label: "Backdrop", icon: "background", tip: "Photos, gradients and colours behind your device" },
  { id: "text", label: "Text", icon: "text", tip: "Headline, labels and badges" },
  { id: "shapes", label: "Shapes", icon: "shapes", tip: "Arrows, circles, numbers and shapes" },
  { id: "layers", label: "Layers", icon: "layers", tip: "Everything in the image, front to back" },
  { id: "exports", label: "Exports", icon: "exports", tip: "Images and videos you've exported" },
];

function Rail() {
  const s = useStore();
  const pick = (id) => {
    set(s.leftTab === id && s.leftOpen ? { leftOpen: false } : { leftTab: id, leftOpen: true });
    persist();
  };
  return html`<nav class="rail">
    <button class="rail-btn" onClick=${openScenesPage}><${Icon} n="grid" s=${19} /><span class="rl">Scenes</span><span class="tip">All your designs (⇧⌘O)</span></button>
    <span class="rail-sep"></span>
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
  const P = { captures: CapturesPanel, designs: DesignsPanel, backgrounds: BackgroundsPanel, text: TextPanel, shapes: ShapesPanel, layers: LayersPanel, exports: ExportsPanel }[s.leftTab] ?? CapturesPanel;
  return html`<${P} />`;
}

// =============================================================================================
// Stage

function Hero() {
  const s = useStore();
  const shots = s.files.filter((f) => ["raw", "uploads", "recordings"].includes(f.kind) && /\.(png|jpe?g|webp)$/i.test(f.path)).slice(0, 7);
  const booted = s.opts?.simulators?.find((x) => x.state === "Booted");
  const recent = s.scenes.filter((x) => x.id !== s.sceneId && x.devices > 0).slice(0, 5);
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
    ${recent.length > 0 &&
    html`<div class="vstack" style=${{ alignItems: "center", gap: "10px" }}>
      <span class="note">…or pick up a scene</span>
      <div class="scene-strip">${recent.map((x) => html`<button title=${x.name} data-scene=${x.id} onClick=${() => openScene(x.id)}><${SceneThumb} x=${x} /><span>${x.name}</span></button>`)}
        <button class="scene-strip-all" onClick=${openScenesPage}><div class="scene-thumb"><${Icon} n="grid" s=${18} /></div><span>See all ${s.scenes.length}</span></button></div>
    </div>`}
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
    ${s.view === "canvas" && !empty && html`<${AIChat} />`}
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

const StepIcon = ({ state }) =>
  html`<span class="step-ico ${state}">${state === "done" ? html`<${Icon} n="check" s=${10} w=${3} />` : state === "active" ? html`<i class="ring"></i>` : html`<i class="dot"></i>`}</span>`;

/**
 * The agent at work, step by step, as the engine reports it: what it's looking at (the very
 * image Claude sees), what it found in the scene, and how long it has been thinking.
 */
function AIWork() {
  const s = useStore();
  const w = s.ai.work;
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, []);
  if (!w) return null;
  const order = ["look", "read", "think", "check"];
  const at = order.indexOf(w.step);
  const state = (k) => (order.indexOf(k) < at ? "done" : order.indexOf(k) === at ? "active" : "todo");
  const secs = Math.max(0, Math.floor((now - w.started) / 1000));
  return html`<div class="msg assistant work">
    <ol class="work-steps">
      <li class=${state("look")}><${StepIcon} state=${state("look")} /><div class="step-body"><b>Looking at your design</b>
        ${w.image && html`<div class="work-shot"><img src=${w.image} onLoad=${(e) => {
          const b = e.target.closest(".ai-chat-body");
          b?.scrollTo({ top: b.scrollHeight, behavior: "smooth" });
        }} /><i class="scan"></i></div>`}</div></li>
      ${at >= 1 &&
      html`<li class=${state("read")}><${StepIcon} state=${state("read")} /><div class="step-body"><b>Reading the scene</b>
        <div class="work-items">${w.items.map((x, i) => html`<span style=${{ "--i": i }}>${x}</span>`)}</div></div></li>`}
      ${at >= 2 &&
      html`<li class=${state("think")}><${StepIcon} state=${state("think")} /><div class="step-body"><b class=${at === 2 ? "shimmer-text" : ""}>${w.retry ? "Fixing a mistake" : at > 2 ? "Designed the change" : "Designing the change"}</b>
        ${at === 2 && html`<span class="work-time">${secs}s</span>`}</div></li>`}
      ${at >= 3 &&
      html`<li class=${state("check")}><${StepIcon} state=${state("check")} /><div class="step-body"><b class="shimmer-text">Checking the result</b>
        ${w.checkImage && html`<div class="work-shot"><img src=${w.checkImage} onLoad=${(e) => {
          const b = e.target.closest(".ai-chat-body");
          b?.scrollTo({ top: b.scrollHeight, behavior: "smooth" });
        }} /><i class="scan"></i></div>`}
        <span class="work-time">${secs}s</span></div></li>`}
    </ol>
  </div>`;
}

/** After an answer: the steps it took, folded into one line you can open. */
function WorkedFor({ m }) {
  const [open, setOpen] = useState(false);
  return html`<div class="worked ${open ? "open" : ""}">
    <button class="worked-toggle" onClick=${() => setOpen(!open)}><${Icon} n="spark" s=${11} />Worked for ${m.took}s<${Icon} n="down" s=${11} class="chev" /></button>
    ${open &&
    html`<ol class="work-steps done">
      <li class="done"><${StepIcon} state="done" /><div class="step-body"><b>Looked at your design</b></div></li>
      <li class="done"><${StepIcon} state="done" /><div class="step-body"><b>Read the scene</b>${m.steps?.items?.length ? html`<div class="work-items static">${m.steps.items.map((x) => html`<span>${x}</span>`)}</div>` : ""}</div></li>
      ${m.steps?.retried && html`<li class="done"><${StepIcon} state="done" /><div class="step-body"><b>Fixed a mistake in its first try</b></div></li>`}
      <li class="done"><${StepIcon} state="done" /><div class="step-body"><b>${m.changes ? `Made ${m.changes} change${m.changes === 1 ? "" : "s"}` : "Answered"}</b></div></li>
      ${m.steps?.checked && html`<li class="done"><${StepIcon} state="done" /><div class="step-body"><b>${m.steps.checked.fixes ? `Checked the render and fixed ${m.steps.checked.fixes} thing${m.steps.checked.fixes === 1 ? "" : "s"}` : "Checked the render"}</b></div></li>`}
    </ol>`}
  </div>`;
}

/** Where the chat panel sits, as offsets from the stage's bottom-right corner (remembered). */
function chatPos() {
  try {
    const p = JSON.parse(localStorage.getItem("ai-chat-pos") ?? "null");
    if (p && Number.isFinite(p.right) && Number.isFinite(p.bottom)) return p;
  } catch {}
  return { right: 16, bottom: 16 };
}

/**
 * Ask AI as a chat: a panel you can move around the canvas. Each message builds on the ones
 * before it; each change Claude makes can be reverted from its message.
 */
function AIChat() {
  const s = useStore();
  const ai = s.ai;
  const input = useRef();
  const body = useRef();
  const panel = useRef();
  const [hist, setHist] = useState(-1);
  const [pos, setPos] = useState(chatPos);
  useEffect(() => {
    if (ai.open) setTimeout(() => input.current?.focus(), 20);
  }, [ai.open]);
  useLayoutEffect(() => {
    const t = input.current;
    if (!t) return;
    t.style.height = "auto";
    t.style.height = Math.min(120, t.scrollHeight) + "px";
  }, [ai.text, ai.open]);
  useLayoutEffect(() => {
    if (body.current) body.current.scrollTop = body.current.scrollHeight;
  }, [ai.thread.length, ai.busy, ai.open]);
  // Follow the agent as each step appears.
  useEffect(() => {
    body.current?.scrollTo({ top: body.current.scrollHeight, behavior: "smooth" });
  }, [ai.work?.step, ai.work?.image, ai.work?.retry]);
  const setAi = (patch) => set({ ai: { ...S.ai, ...patch } });
  const status = s.opts?.ai;
  if (!ai.open) {
    return html`<div class="ai-dock"><button class="ai-pill" onClick=${() => openAI()}>
      <${Icon} n="spark" s=${16} class="spark" /><span>${ai.thread.length ? "Continue the chat" : `Describe a change${s.selected ? ` to ${entityLabel(s.selected)}` : ""}`}…</span><span class="kbd">⌘K</span>
    </button></div>`;
  }
  const send = () => aiEdit(ai.text);
  // Drag the panel by its header; it stays inside the stage.
  const drag = (e) => {
    if (e.button !== 0 || e.target.closest("button")) return;
    e.preventDefault();
    const stage = panel.current.parentElement.getBoundingClientRect();
    const box = panel.current.getBoundingClientRect();
    const dx = e.clientX - box.right;
    const dy = e.clientY - box.bottom;
    const move = (m) => {
      const right = Math.max(8, Math.min(stage.width - box.width - 8, stage.right - (m.clientX - dx)));
      const bottom = Math.max(8, Math.min(stage.height - box.height - 8, stage.bottom - (m.clientY - dy)));
      setPos({ right, bottom });
    };
    const up = () => {
      removeEventListener("pointermove", move);
      removeEventListener("pointerup", up);
      setPos((p) => {
        try {
          localStorage.setItem("ai-chat-pos", JSON.stringify(p));
        } catch {}
        return p;
      });
    };
    addEventListener("pointermove", move);
    addEventListener("pointerup", up);
  };
  const via = status?.provider === "api" ? status.model : status?.provider === "claude-code" ? "Claude Code" : "";
  return html`<section class="ai-chat ${ai.busy ? "busy" : ""}" ref=${panel} style=${{ right: pos.right + "px", bottom: pos.bottom + "px" }} onPointerDown=${(e) => e.stopPropagation()}>
    <header class="ai-chat-head" onPointerDown=${drag} title="Drag to move">
      <span class="ai-chat-mark"><${Icon} n="spark" s=${14} /></span>
      <b>Ask AI</b>${via && html`<span class="faint">${via}</span>`}
      <span class="grow"></span>
      ${ai.thread.length > 0 && html`<button class="icon-btn sm" title="New chat" onClick=${newChat}><${Icon} n="plus" s=${14} /></button>`}
      <button class="icon-btn sm" title="Close (Esc)" onClick=${() => setAi({ open: false })}><${Icon} n="x" s=${14} /></button>
    </header>
    <div class="ai-chat-body" ref=${body}>
      ${!ai.thread.length &&
      html`<div class="ai-chat-empty">
        <b>What should change?</b>
        <span>Describe it like you'd brief a designer. I can see the design, change anything in it, and answer questions about it.</span>
        <div class="suggestions">${suggestionsFor(ai.context ? s.selected : null).map((t) => html`<button class="chip" onClick=${() => aiEdit(t)}>${t}</button>`)}</div>
        ${status && !status.available && html`<span class="note warn">Ask AI needs Claude Code or an API key. <a href="#" onClick=${(e) => {
          e.preventDefault();
          set({ modal: { kind: "settings" } });
        }}>Open Settings</a></span>`}
      </div>`}
      ${ai.thread.map((m) =>
        m.role === "user"
          ? html`<div class="msg user" key=${m.id}>${m.about && html`<span class="msg-about"><${Icon} n="phone" s=${10} />${m.about}</span>`}<p>${m.text}</p></div>`
          : m.role === "error"
            ? html`<div class="msg error" key=${m.id}><p>${m.text}</p>${m.retry && html`<button class="btn sm" onClick=${() => aiEdit(m.retry)}>Try again</button>`}</div>`
            : html`<div class="msg assistant ${m.reverted ? "reverted" : ""} ${m.fresh ? "fresh" : ""}" key=${m.id}>
                ${m.took && html`<${WorkedFor} m=${m} />`}
                ${m.ops?.length > 0 &&
                html`<ul class="op-list">${m.ops.map(
                  (o, i) => html`<li style=${{ "--i": i }}><span class="op-tick"><${Icon} n="check" s=${10} w=${3} /></span><b>${o.prop}</b><span class="op-target">${o.target}</span>${o.value && html`<span class="op-val" title=${o.value}>${o.color && html`<i style=${{ background: o.color }}></i>`}<span>${o.value}</span></span>`}</li>`,
                )}</ul>`}
                <p>${m.fresh ? plain(m.text).split(/(\s+)/).map((w, i) => html`<span class="w" style=${{ "--i": Math.min(i, 60) }}>${w}</span>`) : plain(m.text)}</p>
                ${m.remembered?.length > 0 && html`<div class="remembered"><${Icon} n="spark" s=${11} /><span>Remembered for next time: ${m.remembered.map((r) => `“${r}”`).join(", ")}</span></div>`}
                ${m.changes > 0 &&
                html`<div class="msg-changes">
                  ${(m.reverted || !m.ops?.length) && html`<span>${m.reverted ? "Reverted" : `${m.changes} change${m.changes === 1 ? "" : "s"}${m.changed?.length ? ` · ${m.changed.slice(0, 3).join(", ")}` : ""}`}</span>`}
                  ${!m.reverted && canRevertAI(m.id) && html`<button class="link" onClick=${() => revertAI(m.id)}>Revert</button>`}
                  ${!m.reverted && html`<button class="link" onClick=${renderPreview}>Preview</button>`}
                </div>`}
              </div>`,
      )}
      ${ai.busy && html`<${AIWork} />`}
    </div>
    <div class="ai-chat-compose">
      ${s.selected && ai.context
        ? html`<span class="ctx-chip"><${Icon} n=${s.selected.startsWith("device") ? "phone" : "text"} s=${12} />${entityLabel(s.selected)}<button title="Talk about the whole design" onClick=${() => setAi({ context: false })}><${Icon} n="x" s=${11} /></button></span>`
        : html`<button class="ctx-chip quiet" title=${s.selected ? "Aim at the selection" : "Select something on the canvas to aim at it"} onClick=${() => s.selected && setAi({ context: true })}><${Icon} n="canvas" s=${12} />Whole design</button>`}
      <div class="ai-chat-input">
        <textarea ref=${input} rows="1" value=${ai.text} disabled=${ai.busy}
          placeholder=${ai.thread.length ? "Reply, or ask for another change…" : "Ask for a change, or ask a question…"}
          onInput=${(e) => {
            setAi({ text: e.target.value });
            setHist(-1);
          }}
          onKeyDown=${(e) => {
            e.stopPropagation();
            if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
              e.preventDefault();
              send();
            } else if (e.key === "Escape") setAi({ open: false });
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
        <button class="send" disabled=${!ai.text.trim() || ai.busy} onClick=${send} title="Send (Enter)"><${Icon} n="up" s=${16} w=${2.4} /></button>
      </div>
    </div>
  </section>`;
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
          <div class="note">Describe a change and Claude edits the scene. It uses your <b>Anthropic API key</b> if one is set, otherwise your signed-in <b>Claude Code</b> (${ai?.claudeCode ? "found" : "not found; install it and run claude once"}). Claude sees the scene settings (file paths replaced by placeholders) and, if you allow it, a small preview of the design, so it can judge spacing and contrast. Your original files stay on your Mac.</div>
          <${Switch} checked=${s.ai.preview !== false} onChange=${(v) => {
            set({ ai: { ...S.ai, preview: v } });
            persist();
          }} label="Let Claude see a preview of the design" />
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
        <${DeviceArt} />
        <${HouseStyle} />
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

/**
 * Apple's product bezels as device frames. Screenshotter never ships them: it downloads them from
 * Apple and macOS asks the person to accept Apple's license before they're added.
 */
/** What Ask AI (and agents using the MCP server) remember about your taste. */
function HouseStyle() {
  const [notes, setNotes] = useState(null);
  const [draft, setDraft] = useState("");
  useEffect(() => {
    api("/api/house-style").then((r) => setNotes(r.notes)).catch(() => setNotes([]));
  }, []);
  const change = async (body) => {
    try {
      const r = await api("/api/house-style", body);
      setNotes(r.notes);
    } catch (e) {
      fail(e, "Couldn't update the house style");
    }
  };
  const add = () => {
    if (!draft.trim()) return;
    change({ add: [draft.trim()] });
    setDraft("");
  };
  return html`<div class="card">
    <h4><${Icon} n="spark" s=${15} />House style<span class="grow"></span>${notes?.length ? html`<span class="pill">${notes.length} remembered</span>` : ""}</h4>
    <div class="note">What you like, remembered for next time. Ask AI adds to it when you tell it what you prefer, and follows it in every design. Agents using the MCP server share it.</div>
    ${notes?.length > 0 &&
    html`<ul class="style-notes">${notes.map((n) => html`<li key=${n.id}><span>${n.text}</span><button class="icon-btn sm" title="Forget this" onClick=${() => change({ remove: [n.id] })}><${Icon} n="x" s=${12} /></button></li>`)}</ul>`}
    <div class="hstack">
      <${TextField} class="grow" placeholder="e.g. Always Space Black phones" value=${draft} onChange=${setDraft} onEnter=${add} />
      <button class="btn sm" disabled=${!draft.trim()} onClick=${add}>Remember</button>
    </div>
  </div>`;
}

function DeviceArt() {
  const [info, setInfo] = useState(null);
  const [pick, setPick] = useState(null);
  const load = () => api("/api/bezels").then(setInfo).catch(() => undefined);
  // Start with the suggested sets that aren't installed yet.
  useEffect(() => {
    if (info?.sets && pick === null) setPick(info.sets.filter((x) => !x.installed && info.suggested?.includes(x.id)).map((x) => x.id));
  }, [info]);
  const refreshScene = async () => {
    const opts = await api("/api/options").catch(() => null);
    if (opts) set({ opts });
    scheduleLayout(0);
    if (S.render) set({ renderStale: true });
  };
  useEffect(() => {
    load();
  }, []);
  const running = info?.job?.running;
  useEffect(() => {
    if (!running) return;
    const t = setInterval(async () => {
      const next = await api("/api/bezels").catch(() => null);
      if (!next) return;
      setInfo(next);
      if (!next.job.running) refreshScene();
    }, 1000);
    return () => clearInterval(t);
  }, [running]);
  const sets = info?.sets ?? [];
  const chosen = sets.filter((x) => !x.installed && pick?.includes(x.id));
  const mb = chosen.reduce((a, x) => a + x.mb, 0);
  const get = async () => {
    try {
      const r = await api("/api/bezels/get", { sets: chosen.map((x) => x.id) });
      setInfo({ ...info, job: r.job });
    } catch (e) {
      fail(e, "Couldn't start the download");
    }
  };
  const add = async () => {
    try {
      const r = await native.call("choosePaths", { message: "Choose Apple bezel images, or a folder (or opened disk image) of them." });
      if (!r?.paths?.length) return;
      const out = await api("/api/bezels/import", { paths: r.paths });
      setInfo({ ...info, ...out });
      toast({ kind: out.added ? "ok" : "warn", title: out.added ? `Added ${out.added} bezel images` : "No bezel images found", text: out.added ? "Matching devices now use them." : "Files need a model and colour in their name, like Apple's." });
      refreshScene();
    } catch (e) {
      fail(e, "Couldn't add the bezels");
    }
  };
  const job = info?.job;
  return html`<div class="card">
    <h4><${Icon} n="phone" s=${15} />Device art<span class="grow"></span>
      ${info?.count ? html`<span class="pill ok"><span class="status-dot ok"></span>Apple bezels</span>` : html`<span class="pill">Drawn frames</span>`}</h4>
    <div class="note">Use Apple's own product renders for iPhone, iPad, Apple Watch and Mac frames. Screenshotter downloads them from <a href="https://developer.apple.com/design/resources/" target="_blank">Apple Design Resources</a>, and macOS asks you to accept Apple's license first. It covers mock-ups of apps for Apple platforms, so website captures keep the drawn frames.</div>
    ${info?.models?.length > 0 && html`<div class="bezel-list">${info.models.map((m) => html`<span><b>${m.name}</b> ${m.colors.join(", ")}</span>`)}</div>`}
    <div class="bezel-sets">${sets.map((x) =>
      x.installed
        ? html`<div class="bezel-set installed"><span class="tick"><${Icon} n="check" s=${10} w=${3} /></span>${x.label}<span class="faint">Installed${x.images ? ` · ${x.images} images` : ""}</span></div>`
        : html`<label class="switch"><input type="checkbox" checked=${pick?.includes(x.id)} disabled=${running}
            onChange=${(e) => setPick(e.target.checked ? [...(pick ?? []), x.id] : (pick ?? []).filter((p) => p !== x.id))} /><span class="sw"></span>${x.label}<span class="faint">${x.mb} MB</span></label>`,
    )}</div>
    ${job && (job.step || job.error) && html`<div class="note ${job.error ? "err" : ""}">${job.error ?? job.step}${job.progress !== undefined && job.progress !== null ? html` <b>${Math.round(job.progress * 100)}%</b>` : ""}</div>`}
    <div class="hstack">
      <button class="btn primary sm" disabled=${running || !chosen.length} onClick=${get}>${running ? html`<span class="spinner"></span>Working…` : chosen.length ? `Get from Apple (${mb} MB)` : "Get from Apple"}</button>
      ${native && html`<button class="btn sm" disabled=${running} onClick=${add}>Add files…</button>`}
      ${info?.count > 0 && html`<button class="btn sm ghost" onClick=${() => reveal(info.dir)}>Show folder</button>`}
    </div>
  </div>`;
}

/** Show the release notes: `all` for the full history, else just what's new since last time. */
export async function openWhatsNew(all = true) {
  try {
    const r = await api("/api/whats-new");
    const releases = all ? r.releases : r.unseen;
    if (!releases.length) return;
    set({ modal: { kind: "whatsNew", releases, version: r.version, fresh: !all } });
  } catch {
    // No release notes in this build.
  }
}

/** Release notes, newest first; the first time after an update it opens by itself. */
function WhatsNew() {
  const m = S.modal;
  const close = () => {
    set({ modal: null });
    api("/api/whats-new/seen", {}).catch(() => undefined);
  };
  useEffect(() => {
    const key = (e) => e.key === "Escape" && close();
    addEventListener("keydown", key);
    return () => removeEventListener("keydown", key);
  }, []);
  return html`<div class="scrim" onPointerDown=${(e) => e.target === e.currentTarget && close()}>
    <div class="sheet whats-new">
      <div class="sheet-head"><h2>${m.fresh ? `What's new in Screenshotter ${m.version}` : "What's new"}</h2><button class="icon-btn" onClick=${close}><${Icon} n="x" s=${16} /></button></div>
      <div class="sheet-body">
        ${m.releases.map(
          (r, i) => html`<section class="release" style=${{ "--i": i }}>
            <div class="release-head"><span class="release-v">${r.version}</span>${r.date && html`<span class="faint">${r.date}</span>`}${r.version === m.version && html`<span class="pill ok">This version</span>`}</div>
            ${r.sections.map(
              (sec) => html`<div class="release-sec">
                ${sec.title && html`<h4>${sec.title}</h4>`}
                <ul>${sec.items.map((it) => html`<li dangerouslySetInnerHTML=${{ __html: it }}></li>`)}</ul>
              </div>`,
            )}
          </section>`,
        )}
        <div class="hstack"><button class="btn primary" onClick=${close}>Got it</button></div>
      </div>
    </div>
  </div>`;
}

function Help() {
  const close = () => set({ modal: null });
  const steps = [
    ["sim", "1 · Add a screenshot", "Capture your app from the iOS Simulator, a website, or a Mac window, or drop in image files. They collect in the Screens panel; click one to use it."],
    ["canvas", "2 · Make it yours", "Edit mode shows where things go. Drag the device to move it, pull a corner to resize, use the round handle to rotate. Double-click text to retype it. Pick a Backdrop, add a headline in Text, and point things out with arrows, circles and numbers from Shapes."],
    ["spark", "Or just ask", "Press Ask AI (⌘K) and describe the change: “tilt the phone and use a sunset backdrop”. Undo (⌘Z) reverts anything."],
    ["wand", "Or start from a design", "Designs turns your screen into a finished design in one click, or asks Claude for three to pick from."],
    ["eye", "Preview", "Edit mode is a quick layout guide. Preview renders the finished image with the real frame, lighting and effects."],
    ["export", "3 · Export", "Export saves a full-size PNG, JPEG or WebP, or a video with gentle camera motion. Everything lands in your output folder."],
    ["grid", "Scenes", "Every design saves itself as you work. Scenes (⇧⌘O) shows them all: search, open, rename, duplicate, or start a new one."],
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
          <button class="btn ghost" onClick=${() => openWhatsNew(true)}><${Icon} n="spark" s=${14} />What's new</button>
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

function Prompt() {
  const m = S.modal;
  const [v, setV] = useState(m.value ?? "");
  return html`<div class="scrim" onPointerDown=${(e) => e.target === e.currentTarget && answerPrompt(null)}>
    <div class="sheet" style=${{ width: "400px" }}>
      <div class="sheet-head"><h2>${m.title}</h2></div>
      <div class="sheet-body"><input class="input" autoFocus value=${v} spellcheck=${false} onFocus=${(e) => e.target.select()} onInput=${(e) => setV(e.target.value)}
        onKeyDown=${(e) => {
          e.stopPropagation();
          if (e.key === "Enter") answerPrompt(v);
          if (e.key === "Escape") answerPrompt(null);
        }} /></div>
      <div class="sheet-foot"><button class="btn" onClick=${() => answerPrompt(null)}>Cancel</button><button class="btn primary" disabled=${!v.trim()} onClick=${() => answerPrompt(v)}>${m.confirm ?? "OK"}</button></div>
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
    ${s.scenesPage && html`<${ScenesPage} />`}
    ${s.modal?.kind === "settings" && html`<${Settings} />`}
    ${s.modal?.kind === "confirm" && html`<${Confirm} />`}
    ${s.modal?.kind === "help" && html`<${Help} />`}
    ${s.modal?.kind === "whatsNew" && html`<${WhatsNew} />`}
    ${s.modal?.kind === "prompt" && html`<${Prompt} />`}
    <${Toasts} />
    <${ContextMenu} />
    ${s.dropping && html`<div class="drop-veil"><div><${Icon} n="upload" s=${28} />${s.scenesPage ? "Drop to start a new scene" : "Drop to add to the scene"}</div></div>`}
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
  let next = { ...e };
  next.x += dx;
  next.y += dy;
  if (e.kind === "shape") {
    const c = S.layout.canvas;
    next = withShape(e, (sh) => {
      if (sh.type === "arrow" || sh.type === "line") {
        for (const k of ["from", "to"]) sh[k] = { x: sh[k].x + dx, y: sh[k].y + dy };
      } else {
        sh.x += dx;
        sh.y += dy;
        if (scaleF) sh.size *= scaleF;
        if (rot) sh.rotate = (sh.rotate || 0) + rot;
      }
    }, c.width, c.height);
  } else if (scaleF) {
    if (e.kind === "device") {
      next.width *= scaleF;
      next.height *= scaleF;
    } else {
      next.size *= scaleF;
      if (next.subSize) next.subSize *= scaleF;
    }
  }
  if (rot && e.kind !== "caption" && e.kind !== "shape") next.rotate = (e.rotate || 0) + rot;
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
  whatsNew: () => openWhatsNew(true),
  newScene,
  save: () => saveNow(),
  scenes: () => toggleScenesPage(),
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
  if (mod && e.shiftKey && k === "o") {
    e.preventDefault();
    return commands.scenes();
  }
  // The Scenes page handles its own keys.
  if (S.scenesPage) return;
  if (mod && k === "k") {
    e.preventDefault();
    return commands.ai();
  }
  if (mod && k === "s" && !e.shiftKey) {
    e.preventDefault();
    return saveNow();
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

// ---------------------------------------------------------------------------------------------
// Right-click: a menu for whatever is under the pointer; never the web view's own menu.

function entityMenu(id) {
  const i = Number(id.split("-")[1]) - 1;
  const e = S.layout?.entities.find((x) => x.id === id);
  if (id.startsWith("device-")) {
    const d = S.scene.devices[i];
    if (!d) return [];
    const iphone = /iphone/i.test(e?.device ?? d.device ?? "") && (d.frame ?? "device") === "device";
    const placed = d.x !== undefined || d.y !== undefined || d.height !== undefined || d.rotate;
    return [
      { label: `Ask AI about ${entityLabel(id)}…`, icon: "spark", ai: true, kbd: "⌘K", run: () => openAI(id) },
      "-",
      { label: "Replace screenshot…", icon: "replace", run: () => replaceMode(id) },
      iphone && { label: d.side === "back" ? "Show the front" : "Show the back", icon: "phone", run: () => editScene((sc) => (sc.devices[i].side = d.side === "back" ? undefined : "back")) },
      (e?.bezel || d.bezel === false) && { label: d.bezel === false ? "Use Apple's device art" : "Use the drawn frame", icon: "image", run: () => editScene((sc) => (sc.devices[i].bezel = d.bezel === false ? undefined : false)) },
      { label: "Put back in the layout", icon: "refresh", disabled: !placed, run: () => editScene((sc) => ["x", "y", "anchor", "height", "width", "rotate"].forEach((k) => delete sc.devices[i][k])) },
      "-",
      { label: "Duplicate", icon: "duplicate", kbd: "⌘D", run: () => duplicateEntity(id) },
      { label: "Bring forward", icon: "front", run: () => moveZ(id, 1) },
      { label: "Send backward", icon: "back", run: () => moveZ(id, -1) },
      "-",
      { label: "Delete", icon: "trash", kbd: "⌫", danger: true, run: () => deleteEntity(id) },
    ];
  }
  if (id.startsWith("shape-")) {
    const sh = S.scene.shapes?.[i];
    if (!sh) return [];
    return [
      { label: `Ask AI about this ${entityLabel(id).toLowerCase()}…`, icon: "spark", ai: true, kbd: "⌘K", run: () => openAI(id) },
      "-",
      { label: sh.sketch ? "Make it clean" : "Make it hand-drawn", icon: "pen", run: () => editScene((sc) => (sc.shapes[i].sketch = sh.sketch ? undefined : true)) },
      { label: "Duplicate", icon: "duplicate", kbd: "⌘D", run: () => duplicateEntity(id) },
      { label: "Bring forward", icon: "front", run: () => moveZ(id, 1) },
      { label: "Send backward", icon: "back", run: () => moveZ(id, -1) },
      "-",
      { label: "Delete", icon: "trash", kbd: "⌫", danger: true, run: () => deleteEntity(id) },
    ];
  }
  return [
    { label: "Ask AI about this text…", icon: "spark", ai: true, kbd: "⌘K", run: () => openAI(id) },
    "-",
    { label: "Edit text", icon: "text", kbd: "↩", run: () => canvasApi.editText(id) },
    id !== "caption" && { label: "Duplicate", icon: "duplicate", kbd: "⌘D", run: () => duplicateEntity(id) },
    id !== "caption" && { label: "Bring forward", icon: "front", run: () => moveZ(id, 1) },
    id !== "caption" && { label: "Send backward", icon: "back", run: () => moveZ(id, -1) },
    "-",
    { label: id === "caption" ? "Remove headline" : "Delete", icon: "trash", kbd: "⌫", danger: true, run: () => deleteEntity(id) },
  ];
}

function canvasMenu() {
  const has = S.scene.devices.length > 0;
  return [
    has && { label: "Ask AI…", icon: "spark", ai: true, kbd: "⌘K", run: () => openAI(false) },
    has && "-",
    { label: "Add a screenshot…", icon: "upload", kbd: "⌘O", run: commands.import },
    has && { label: "Add text", icon: "text", run: () => addText("label") },
    has && !S.scene.headline && { label: "Add a headline", icon: "text", run: addCaption },
    { label: "Change backdrop…", icon: "background", run: () => set({ leftTab: "backgrounds", leftOpen: true }) },
    "-",
    has && { label: "Preview", icon: "eye", kbd: "⌘R", run: renderPreview },
    has && { label: "Export image", icon: "export", kbd: "⌘E", run: exportImage },
    has && { label: "Zoom to fit", icon: "fit", kbd: "⌘0", run: () => canvasApi.fit() },
  ];
}

function fileMenu(p, kind) {
  const image = !isVideo(p);
  if (kind === "saved") {
    return [
      { label: "Open", icon: "eye", run: () => set({ render: { path: p, isVideo: !image, preview: false, at: Date.now() }, renderStale: false, view: "render" }) },
      { label: "Show in Finder", icon: "folder", run: () => reveal(p) },
      image && { label: "Copy", icon: "copy", run: () => copyImage(p) },
      "-",
      { label: "Delete…", icon: "trash", danger: true, run: () => deleteFile(p) },
    ];
  }
  const sel = S.selected?.startsWith("device-") ? S.selected : null;
  return [
    { label: S.scene.devices.length ? (sel ? `Use in ${entityLabel(sel)}` : "Use in the design") : "Add to the design", icon: "check", run: () => useCapture(p) },
    S.scene.devices.length > 0 && { label: "Add as another device", icon: "plus", run: () => addDevice(p) },
    "-",
    { label: "Show in Finder", icon: "folder", run: () => reveal(p) },
    image && { label: "Copy", icon: "copy", run: () => copyImage(p) },
    "-",
    { label: "Delete…", icon: "trash", danger: true, run: () => deleteFile(p) },
  ];
}

const editScene = (fn) => {
  const next = JSON.parse(JSON.stringify(S.scene));
  fn(next);
  setScene(next);
};

window.addEventListener("contextmenu", (e) => {
  // Text fields keep the system's text menu (the desktop app trims it to text actions).
  if (typing() && e.target.closest?.("input, textarea, [contenteditable]")) return;
  e.preventDefault();
  const t = e.target;
  const scene = t.closest?.("[data-scene]");
  if (scene) return openMenu(e.clientX, e.clientY, sceneMenu(scene.dataset.scene));
  const ent = t.closest?.(".viewport .ent[data-id]");
  const shot = t.closest?.("[data-file]");
  let items = null;
  if (ent) {
    set({ selected: ent.dataset.id });
    items = entityMenu(ent.dataset.id);
  } else if (shot) {
    items = fileMenu(shot.dataset.file, shot.dataset.kind);
  } else if (t.closest?.(".viewport")) {
    items = canvasMenu();
  } else if (t.closest?.(".render-frame") && S.render) {
    const r = S.render;
    items = r.preview
      ? [{ label: "Export full size…", icon: "export", run: () => set({ exportOpen: true }) }, { label: "Back to editing", icon: "canvas", kbd: "⌘1", run: () => set({ view: "canvas" }) }]
      : fileMenu(r.path, "saved").slice(1);
  }
  if (items) openMenu(e.clientX, e.clientY, items);
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
  const files = [...e.dataTransfer.files];
  // On the Scenes page, a drop starts a new scene with the files.
  if (S.scenesPage) newScene().then(() => (closeScenesPage(), uploadFiles(files)));
  else uploadFiles(files);
});

// Report the draggable title-bar area to the desktop shell.
function reportDragRegions() {
  if (!native) return;
  const bar = document.querySelector(".scenes-page .sp-bar") ?? document.querySelector(".topbar");
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
    api("/api/recipes").then((recipes) => set({ recipes })).catch(() => undefined);
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
    // Scenes: list them, and make sure the design on screen is one of them.
    refreshScenes();
    if (!S.sceneId && (S.scene.devices.length || S.scene.headline)) saveSceneNow();
    // After an update, the release notes open once.
    setTimeout(() => !S.modal && openWhatsNew(false), 900);
    setTimeout(reportDragRegions, 300);
    // Keep the library fresh when captures arrive from agents using the MCP.
    setInterval(() => document.visibilityState === "visible" && !S.busy && refreshFiles().catch(() => undefined), 15000);
  } catch (e) {
    set({ bootError: e.message });
  }
}
boot();
