// Screenshotter Studio — app shell.
import { render } from "preact";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { Dropdown, Popover, Seg, Slider, Switch, TextField, html } from "./controls.js";
import { Icon } from "./icons.js";
import { IMAGE_PROVIDERS, S, STORE_GAP, hasDesign, pictureUrl, aiEngine, aiName, aiVia, api, base, dismiss, edit, entityLabel, fail, fileUrl, flushPersist, isVideo, native, persist, persistPrefs, redo, refreshFiles, refreshScenes, restore, saveSceneNow, scheduleLayout, set, setScene, thumbUrl, toast, touch, undo, useStore } from "./store.js";
import {
  answerPrompt,
  applyRecipe,
  recipeInput,
  trySample,
  pickUpAgentChanges,
  toggleFocus,
  openExport,
  openViewer,
  togglePanel,
  deleteSavedScene,
  duplicateSavedScene,
  openScene,
  openRecording,
  openScreenshot,
  renameSavedScene,
  saveNow,
  canRevertAI,
  newChat,
  revertAI,
  addCaption,
  addDevice,
  addText,
  aiEdit,
  closeStills,
  openStills,
  addShot,
  pickStill,
  stopAI,
  useAIDraft,
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
  dockAI,
  reveal,
  uploadFiles,
  addPicture,
  uploadImages,
  setAppIcon,
  appIconOf,
  startWithWords,
  useCapture,
  goToShot,
  STYLE_PARTS,
  copyStyle,
  exportWholeSet,
  setSizes,
  screenName,
  sizeLabel,
} from "./actions.js";
import { CanvasView, canvasApi, commitEntity, deviceAtPoint, withShape } from "./canvas.js";
import { ContextMenu, openMenu } from "./menu.js";
import { BackgroundsPanel, CapturesPanel, DesignForMe, DesignsPanel, ElementsPanel, isElementsTab } from "./panels.js";
import { Inspector } from "./inspector.js";
import { TimelineDock, closeTimeline, cutSoundHere, deleteAnimation, openTimeline, play, toggleTimeline, videoLength } from "./timeline.js";
import { deleteSound, hasSoundRow, nudgeSound } from "./sound.js";
import { cutFootageHere, cuttable, deleteFootagePart } from "./footage.js";
import { ScenesPage, ScenesPopover, SceneThumb, closeScenesPage, openScenesPage, sceneMenu, toggleScenesPage } from "./scenes.js";

// =============================================================================================
// Top bar

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
        <input class="scene-name" value=${s.sceneName} spellcheck=${false} title="Rename this design"
          onKeyDown=${(e) => {
            e.stopPropagation();
            if (e.key === "Enter" || e.key === "Escape") e.target.blur();
          }}
          onChange=${(e) => {
            set({ sceneName: e.target.value.trim() || "Untitled design" });
            persist();
          }} />
        <button class="scene-chev" title="Switch design" onClick=${() => set({ scenesOpen: !s.scenesOpen })}><${Icon} n="down" s=${13} /></button>
      </div>
      <button class="icon-btn sm" data-nodrag title="New design (⌘N)" onClick=${newScene}><${Icon} n="plus" s=${15} /></button>
    </div>
    ${s.scenesOpen && html`<${ScenesPopover} anchor=${scenesBtn.current} />`}
    <div class="topbar-center">
      ${(s.busy || s.rendering) && html`<div class="activity" data-nodrag><span class="spinner"></span><span>${(s.busy ?? s.rendering).label}</span></div>`}
    </div>
    <span class="spacer"></span>
    <div class="hstack" data-nodrag>
      <button class="icon-btn" title="Undo (⌘Z)" disabled=${!s.past.length} onClick=${undo}><${Icon} n="undo" s=${16} /></button>
      <button class="icon-btn" title="Redo (⇧⌘Z)" disabled=${!s.future.length} onClick=${redo}><${Icon} n="redo" s=${16} /></button>
      <span style=${{ width: "6px" }}></span>
      <button class="btn ai" onClick=${() => (s.ai.open ? set({ ai: { ...s.ai, open: false } }) : openAI())} title="Describe a change in plain words and AI makes it (⌘K)"><${Icon} n="spark" s=${15} class="spark" />Ask AI<span class="kbd">⌘K</span></button>
      <button class="btn primary" ref=${exportBtn} disabled=${!(hasDesign(s.scene) || s.shots) || Boolean(s.rendering)} title="Save the finished image or video" onClick=${() => (s.exportOpen ? set({ exportOpen: false }) : openExport())}><${Icon} n="export" s=${15} w=${2} />Export</button>
      <span class="topbar-sep"></span>
      <button class="icon-btn ${s.leftOpen ? "on" : ""}" title=${`${s.leftOpen ? "Hide" : "Show"} the left panel (⌥⌘S)`} onClick=${() => togglePanel("left")}><${Icon} n="sidebar" s=${16} /></button>
      <button class="icon-btn ${s.rightOpen ? "on" : ""}" title=${`${s.rightOpen ? "Hide" : "Show"} the settings panel (⌥⌘I)`} onClick=${() => togglePanel("right")}><${Icon} n="sidebarR" s=${16} /></button>
    </div>
    ${(s.busy || s.rendering) && html`<div class="progress-line ${s.rendering?.progress > 0 ? "known" : ""}" style=${s.rendering?.progress > 0 ? { "--p": s.rendering.progress } : undefined}></div>`}
    ${s.exportOpen && html`<${ExportPopover} anchor=${exportBtn.current} />`}
  </header>`;
}

// =============================================================================================
// Scenes

// The switcher, the Scenes page and the scene menus live in scenes.js.

// =============================================================================================
// Export

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
  const many = s.shots?.length > 1;
  // A design of several screens or sizes exports them all from the Set tab.
  const isSet = many || s.groups?.length > 1;
  const tab = o.tab === "set" && !isSet ? "image" : o.tab;
  // Sizes to make: the first is the main file, the rest are versions.
  const sizes = o.video.sizes?.length ? o.video.sizes : ["design"];
  const toggleSize = (v) => {
    const on = sizes.includes(v) ? sizes.filter((x) => x !== v) : [...sizes, v];
    upv({ sizes: VIDEO_SIZES.map((z) => z.value).filter((x) => on.includes(x)).slice(0, 9) });
  };
  return html`<${Popover} anchor=${anchor} align="end" class="export-pop" onClose=${() => set({ exportOpen: false })}>
    <div class="tabs"><${Seg} value=${tab} onChange=${(v) => up({ tab: v })} options=${[{ value: "image", label: "Image", icon: "image" }, ...(isSet ? [{ value: "set", label: "Set", icon: "grid" }] : []), { value: "video", label: "Video", icon: "video" }]} /></div>
    ${tab === "set"
      ? html`<${SetExport} />`
      : tab === "image"
      ? html`<div class="body">
          <div class="row"><label>Format</label><${Seg} value=${o.format} options=${[{ value: "png", label: "PNG" }, { value: "jpeg", label: "JPEG" }, { value: "webp", label: "WebP" }]} onChange=${(v) => up({ format: v })} /></div>
          <div class="row"><label>Size</label><${Seg} value=${o.size} options=${[{ value: "full", label: "Full" }, { value: "half", label: "½" }, { value: "custom", label: "Width" }]} onChange=${(v) => up({ size: v })} /></div>
          ${o.size === "custom" && html`<div class="row"><label>Width</label><input class="input sm mono" type="number" min="16" max="8192" value=${o.width} onKeyDown=${(e) => e.stopPropagation()} onChange=${(e) => up({ width: Math.max(16, Math.min(8192, Number(e.target.value) || 1080)) })} /></div>`}
          ${o.format !== "png" && html`<div class="row"><label>Quality</label><${Slider} value=${o.jpegQuality} min=${50} max=${100} step=${1} format=${(v) => Math.round(v)} onChange=${(v) => up({ jpegQuality: v ?? 90 })} /></div>`}
          <div class="note">${outW && outH ? html`<b>${outW} × ${outH}</b> px · ` : ""}${o.format === "png" ? "lossless, transparent where the background is none" : o.format.toUpperCase()}</div>
          <button class="btn primary lg block" onClick=${exportImage}><${Icon} n="export" s=${16} w=${2} />Export image<span class="kbd">⌘E</span></button>
        </div>`
      : html`<div class="body">
          ${many && html`<${VideoScreens} />`}
          <div class="note">${s.scene.recording?.duration ? "The recording as you've edited it on its timeline." : html`How it moves, and for how long, is on its timeline (⌘T) and in its Motion settings.`}</div>
          <div class="row"><label>Format</label><${Seg} value=${o.video.format} options=${[{ value: "mp4", label: "MP4" }, { value: "mov", label: "MOV" }, { value: "webm", label: "WebM" }, { value: "gif", label: "GIF" }]} onChange=${(v) => upv({ format: v })} /></div>
          <div class="lbl">Sizes <span class="faint">${sizes.length > 1 ? `· ${sizes.length} files` : ""}</span></div>
          <div class="size-chips">${VIDEO_SIZES.map((z) => html`<button class="size-chip ${sizes.includes(z.value) ? "on" : ""}" key=${z.value} title=${z.title ?? ""} onClick=${() => toggleSize(z.value)}>
            <i class="shape" style=${{ aspectRatio: z.value === "design" ? `${W || 16} / ${H || 9}` : z.aspect }}></i><span><b>${z.label}</b><small>${z.value === "design" ? (W ? `${W}×${H}` : "") : z.sub}</small></span>
          </button>`)}</div>
          ${sizes.some((z) => z !== "design") && html`<div class="row"><label>Other shapes</label><${Seg} value=${o.video.fit ?? "auto"} options=${[{ value: "auto", label: "Auto" }, { value: "fit", label: "Fit" }, { value: "fill", label: "Fill" }, { value: "rearrange", label: "Rearrange" }]} onChange=${(v) => upv({ fit: v })} /></div>
            <div class="note">${{ auto: "Hand-placed designs fit whole, with the background filling the rest; automatic layouts are laid out again for each shape.", fit: "The whole design, with the background filling the rest.", fill: "Fills the shape, trimming the edges.", rearrange: "Laid out again for each shape." }[o.video.fit ?? "auto"]}</div>`}
          ${sizes.some((z) => z.startsWith("app-store")) && html`<div class="note"><b>App Store</b> previews follow Apple's rules: 15 to 30 seconds (a short one holds its end), 30 fps, H.264, with a silent sound track.</div>`}
          <div class="note">${hasRecording ? html`<b>Screen recording</b> plays inside the frame.` : "Tip: record the simulator to play real app footage inside the frame."}</div>
          <button class="btn primary lg block" onClick=${exportVideo}><${Icon} n="video" s=${16} />Export video<span class="kbd">⇧⌘E</span></button>
        </div>`}
    <div class="foot"><${Icon} n="folder" s=${13} /><span class="grow" style=${{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title=${s.opts?.outputRoot}>${shortPath(s.opts?.outputRoot)}</span>
      <button class="btn sm ghost" onClick=${() => set({ modal: { kind: "settings" }, exportOpen: false })}>Change</button></div>
  <//>`;
}
const shortPath = (p) => (p ?? "").replace(/^\/Users\/[^/]+/, "~");

/**
 * Which screens of a set go into the video: all of them (as the set plays), the one being edited, or
 * the ones picked; and, for several, one video joined by their transitions or one video each.
 */
function VideoScreens() {
  const s = useStore();
  const v = s.exportOpts.video;
  const shots = s.shots;
  const upv = (patch) => {
    set({ exportOpts: { ...S.exportOpts, video: { ...S.exportOpts.video, ...patch } } });
    persist();
  };
  const which = v.screens ?? "all";
  const picked = (v.picked ?? []).filter((i) => i < shots.length);
  const chosen = which === "this" ? [s.shot] : which === "pick" ? (picked.length ? picked : [s.shot]) : shots.map((_, i) => i).filter((i) => shots[i].video !== false);
  const n = which === "all" && !chosen.length ? shots.length : chosen.length;
  const toggle = (i) => upv({ picked: picked.includes(i) ? picked.filter((x) => x !== i) : [...picked, i].sort((a, b) => a - b) });
  const thumbs = useStoreThumbs(which === "pick" ? shots.map((x) => x.scene) : [], 96);
  return html`
    <div class="row"><label>Screens</label><${Seg} value=${which} options=${[{ value: "all", label: "All" }, { value: "this", label: "This one" }, { value: "pick", label: "Choose" }]}
      onChange=${(x) => upv({ screens: x, picked: x === "pick" && !picked.length ? [s.shot] : picked })} /></div>
    ${which === "pick" &&
    html`<div class="screen-picks">${shots.map((x, i) => html`<button key=${i} class="screen-pick ${picked.includes(i) ? "on" : ""}" title=${screenName(i)} onClick=${() => toggle(i)}>
        ${thumbs[i] ? html`<img src=${thumbs[i]} />` : html`<i class="ph"></i>`}<span>${String(i + 1).padStart(2, "0")}</span>
      </button>`)}</div>`}
    ${n > 1 && html`<div class="row"><label>Make</label><${Seg} value=${v.join === false ? "each" : "one"} options=${[{ value: "one", label: "One video" }, { value: "each", label: "One each" }]} onChange=${(x) => upv({ join: x === "one" })} /></div>`}
    <div class="note shots-note"><${Icon} n="video" s=${13} /><span>${n > 1
      ? v.join === false
        ? html`<b>${n} videos</b>, one for each screen.`
        : html`<b>${n} screens</b> in one video, joined by their transitions. Each screen's length is set on the timeline.`
      : html`<b>${which === "this" || n === 1 ? screenName(chosen[0] ?? s.shot) : "One screen"}</b> on its own.`}</span></div>`;
}

/** The Set tab: every screen of every size in one go, in store order. */
function SetExport() {
  const s = useStore();
  const o = s.exportOpts.set;
  const up = (patch) => {
    set({ exportOpts: { ...S.exportOpts, set: { ...S.exportOpts.set, ...patch } } });
    persist();
  };
  const sizes = setSizes();
  const n = sizes.reduce((k, z) => k + z.screens.length, 0);
  const first = sizes[0];
  const sample = first ? `${String(1).padStart(2, "0")} ${first.screens[0].name}` : "01 Screen";
  const folder = first?.label.replace(/″/g, "") ?? "iPhone 6.9";
  return html`<div class="body">
    <div class="set-sum">${sizes.map((z) => html`<span><b>${z.label}</b> ${z.screens.length}</span>`)}</div>
    <div class="row"><label>Format</label><${Seg} value=${o.format} options=${[{ value: "png", label: "PNG" }, { value: "jpeg", label: "JPEG" }]} onChange=${(v) => up({ format: v })} /></div>
    <div class="row"><label>Folders</label><${Seg} value=${o.folders} options=${[{ value: "size", label: "By size" }, { value: "fastlane", label: "fastlane" }]} onChange=${(v) => up({ folders: v })} /></div>
    <div class="note mono-path">${o.folders === "fastlane" ? `screenshots/en-US/${folder} - ${sample}.${o.format === "jpeg" ? "jpg" : "png"}` : `en-US/${folder}/${sample}.${o.format === "jpeg" ? "jpg" : "png"}`}</div>
    <div class="note">${o.folders === "fastlane" ? "One folder per language, ready for fastlane deliver to upload in this order." : "A folder for each size, numbered in store order."} Full size, as the stores want.</div>
    <${Switch} checked=${o.sheets} onChange=${(v) => up({ sheets: v })} label="A contact sheet for each size" />
    <button class="btn primary lg block" onClick=${exportWholeSet}><${Icon} n="export" s=${16} w=${2} />Export ${n} image${n === 1 ? "" : "s"}</button>
    <button class="btn block" onClick=${() => set({ exportOpen: false, modal: { kind: "storePage" } })}><${Icon} n="eye" s=${14} />Preview the store page</button>
  </div>`;
}
/** Sizes a video can be exported at, beside the design's own. */
const VIDEO_SIZES = [
  { value: "design", label: "As designed" },
  { value: "app-store-iphone", label: "App Store iPhone", sub: "886×1920", aspect: "886 / 1920", title: "Apple's app preview size for every current iPhone" },
  { value: "app-store-ipad", label: "App Store iPad", sub: "1200×1600", aspect: "3 / 4", title: "Apple's app preview size for iPad" },
  { value: "app-store-mac", label: "App Store Mac", sub: "1920×1080", aspect: "16 / 9", title: "Apple's app preview size for Mac and Apple TV" },
  { value: "vertical", label: "9:16", sub: "Reels, TikTok", aspect: "9 / 16" },
  { value: "portrait", label: "4:5", sub: "Feed post", aspect: "4 / 5" },
  { value: "square", label: "1:1", sub: "Square", aspect: "1 / 1" },
  { value: "widescreen", label: "16:9", sub: "YouTube, web", aspect: "16 / 9" },
];

// =============================================================================================
// Rail and left panel

const TABS = [
  { id: "captures", label: "Screenshots", icon: "captures", tip: "Bring in a screenshot of your app" },
  { id: "designs", label: "Templates", icon: "wand", tip: "Finished designs made from your screenshot" },
  { id: "backgrounds", label: "Back­grounds", icon: "background", tip: "Wallpapers, looks, colours and photos to sit behind your design" },
  { id: "elements", label: "Elements", icon: "shapes", tip: "Text, badges, arrows, shapes, stickers and pictures" },
];
/** Which rail tab the left panel's tab belongs to (Text, Shapes and Pictures are all Elements). */
const railOf = (tab) => (isElementsTab(tab) ? "elements" : tab);

function Rail() {
  const s = useStore();
  const pick = (id) => {
    const on = railOf(s.leftTab) === id;
    // Elements opens on the part last used.
    const tab = id === "elements" ? (isElementsTab(s.leftTab) ? s.leftTab : "text") : id;
    set(on && s.leftOpen ? { leftOpen: false } : { leftTab: tab, leftOpen: true });
    persistPrefs();
  };
  return html`<nav class="rail">
    ${TABS.map((t) => html`<button class="rail-btn ${!s.scenesPage && s.leftOpen && railOf(s.leftTab) === t.id ? "on" : ""}" onClick=${() => pick(t.id)}>
      <span class="ico"><${Icon} n=${t.icon} s=${18} /></span>
      <span class="rl">${t.label}</span>
      <span class="tip">${t.tip}</span>
    </button>`)}
    <span class="rail-sep"></span>
    <button class="rail-btn ${s.scenesPage ? "on" : ""}" onClick=${openScenesPage}><span class="ico"><${Icon} n="folder" s=${18} /></span><span class="rl">My designs</span><span class="tip">Everything you've made and exported (⇧⌘O)</span></button>
    <span class="grow"></span>
    <button class="rail-btn ${s.modal?.kind === "help" ? "on" : ""}" onClick=${() => set({ modal: { kind: "help" } })}><span class="ico"><${Icon} n="info" s=${17} /></span><span class="rl">Help</span><span class="tip">How Screenshotter works</span></button>
    <button class="rail-btn ${s.modal?.kind === "settings" ? "on" : ""}" onClick=${() => set({ modal: { kind: "settings" } })}><span class="ico"><${Icon} n="settings" s=${17} /></span><span class="rl">Settings</span><span class="tip">AI, output folder, shortcuts</span></button>
  </nav>`;
}

function LeftPanel() {
  const s = useStore();
  if (isElementsTab(s.leftTab)) return html`<${ElementsPanel} />`;
  const P = { captures: CapturesPanel, designs: DesignsPanel, backgrounds: BackgroundsPanel }[s.leftTab] ?? CapturesPanel;
  return html`<${P} />`;
}

// =============================================================================================
// Stage

/** The first thing anyone sees: one job, bringing in a screenshot. */
function Welcome() {
  const s = useStore();
  const input = useRef();
  const booted = s.opts?.simulators?.find((x) => x.state === "Booted");
  const hasSim = (s.opts?.simulators ?? []).length > 0;
  const shots = s.files.filter((f) => ["raw", "uploads", "recordings"].includes(f.kind) && /\.(png|jpe?g|webp)$/i.test(f.path)).slice(0, 6);
  const recent = s.scenes.filter((x) => x.id !== s.sceneId && x.devices > 0).slice(0, 4);
  const go = (source) => set({ leftTab: "captures", leftOpen: true, capture: { ...S.capture, source } });
  return html`<div class="hero"><div class="hero-inner welcome">
    <h1>Make your app look <em>incredible.</em></h1>
    <p>Start with a screenshot of your app. You get a finished design to make your own.</p>
    <button class="drop-target" onClick=${() => input.current.click()}>
      <span class="ico"><${Icon} n="upload" s=${24} /></span>
      <b>Drop a screenshot here</b>
      <span>or click to choose one. You can also paste with <span class="kbd">⌘V</span></span>
    </button>
    <input type="file" ref=${input} hidden multiple accept="image/png,image/jpeg,image/webp,video/mp4,video/quicktime" onChange=${(e) => {
      uploadFiles(e.target.files);
      e.target.value = "";
    }} />
    <div class="welcome-alt">
      ${hasSim && html`<button class="alt" onClick=${() => go("simulator")} title=${booted ? `Grabs whatever ${booted.name} is showing, with a clean status bar` : "Opens an iPhone simulator and grabs its screen"}><${Icon} n="sim" s=${15} />From the iOS Simulator</button>`}
      <button class="alt" onClick=${() => go("web")} title="Type an address; it's captured on a phone or a desktop"><${Icon} n="globe" s=${15} />From a website</button>
      <button class="alt" onClick=${startWithWords} title="A screen of just words, stickers and doodles: no screenshot needed"><${Icon} n="text" s=${15} />Just words and doodles</button>
      <button class="alt" onClick=${trySample} title="See what it does with a made-up app's screenshot"><${Icon} n="spark" s=${15} />Try a sample</button>
    </div>
    ${shots.length > 0 &&
    html`<div class="welcome-more">
      <span class="note">Or use a screenshot you already have</span>
      <div class="recent-strip">${shots.map((f) => html`<button title=${base(f.path)} onClick=${() => addDevice(f.path)}><img src=${thumbUrl(f.path, 160)} /></button>`)}</div>
    </div>`}
    ${recent.length > 0 &&
    shots.length === 0 &&
    html`<div class="welcome-more">
      <span class="note">Or pick up a design</span>
      <div class="scene-strip">${recent.map((x) => html`<button title=${x.name} data-scene=${x.id} onClick=${() => openScene(x.id)}><${SceneThumb} x=${x} /><span>${x.name}</span></button>`)}
        <button class="scene-strip-all" onClick=${openScenesPage}><div class="scene-thumb"><${Icon} n="grid" s=${18} /></div><span>See all ${s.scenes.length}</span></button></div>
    </div>`}
  </div></div>`;
}

const stop = (e) => e.stopPropagation();

/**
 * Pick the still of a recording: the moment its device shows in images and on the canvas. The
 * engine offers up to eight moments where the picture differs; the device shows each one as
 * you click it. Cancel puts back the one it had.
 */
function StillPicker() {
  const s = useStore();
  const p = s.stillPick;
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  useEffect(() => {
    let live = true;
    fetch(`/api/moments?path=${encodeURIComponent(p.video)}&n=8`)
      .then((r) => (r.ok ? r.json() : r.json().then((b) => Promise.reject(new Error(b.error || `HTTP ${r.status}`)))))
      .then((d) => live && setData(d))
      .catch((e) => live && setErr(e.message));
    return () => {
      live = false;
    };
  }, [p.video]);
  const current = s.scene.devices[Number(p.id.split("-")[1]) - 1]?.screenshot ?? "";
  const m = /\.still-(\d+)\.png$/i.exec(current);
  const at = m ? Number(m[1]) / 1000 : 0;
  const clock = (t) => `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, "0")}`;
  return html`<div class="guide-card still-picker" onPointerDown=${stop}>
    <div class="gc-head">
      <div class="gc-title"><b>Pick the still</b><span>The moment of the recording this device shows in images. Videos still play all of it.</span></div>
      <button class="btn ghost sm" onClick=${() => closeStills(true)}>Cancel</button>
      <button class="btn primary sm" onClick=${() => closeStills()}>Done</button>
    </div>
    <div class="still-row">
      ${data
        ? data.moments.map(
            (x) => html`<button class="still-card ${Math.abs(x.t - at) < 0.06 ? "on" : ""} ${p.busy === x.t ? "busy" : ""}" key=${x.t} title=${`Show the recording at ${clock(x.t)}`} onClick=${() => pickStill(x.t)}>
              <span class="still-img"><img src=${x.thumb} alt="" /></span><span class="still-t">${clock(x.t)}</span>
            </button>`,
          )
        : err
          ? html`<div class="note warn">${err}</div>`
          : Array.from({ length: 6 }, (_, k) => html`<span class="still-card loading" key=${k}><span class="still-img"></span><span class="still-t"> </span></span>`)}
    </div>
  </div>`;
}

/** A file you exported or opened from My designs, over the app: Esc or Done goes back to the design. */
function Viewer() {
  const s = useStore();
  const r = s.render;
  const close = () => set({ modal: null });
  useEffect(() => {
    const key = (e) => e.key === "Escape" && (e.preventDefault(), close());
    addEventListener("keydown", key);
    return () => removeEventListener("keydown", key);
  }, []);
  if (!r) return null;
  // Drag the file out to Finder, Slack, Figma… once the pointer actually moves, so a plain click
  // doesn't start a drag.
  const dragOut = (e) => {
    if (!native || e.button !== 0) return;
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
  return html`<div class="scrim viewer" onPointerDown=${(e) => e.target === e.currentTarget && close()}>
    <div class="viewer-box">
      <div class="viewer-head">
        <b title=${r.path}>${base(r.path)}</b>
        ${r.width > 0 && html`<span class="meta-chip">${r.width} × ${r.height}</span>`}
        ${r.duration > 0 && html`<span class="meta-chip">${r.duration.toFixed(1)} s</span>`}
        <span class="grow"></span>
        <button class="btn sm" onClick=${() => reveal(r.path)}><${Icon} n="folder" s=${13} />Show in Finder</button>
        ${!r.isVideo && !r.sheet && html`<button class="btn sm" onClick=${() => copyImage(r.path)}><${Icon} n="copy" s=${13} />Copy</button>`}
        ${!r.sheet && html`<button class="btn sm danger" onClick=${() => deleteFile(r.path)}><${Icon} n="trash" s=${13} />Delete</button>`}
        <button class="btn sm primary" onClick=${close}>Done</button>
      </div>
      <div class="viewer-frame">
        ${r.isVideo
          ? html`<video key=${r.path} src=${fileUrl(r.path, r.at)} autoplay loop playsinline controls></video>`
          : html`<img key=${r.path + r.at} src=${fileUrl(r.path, r.at)} draggable=${!native} onMouseDown=${native ? dragOut : undefined} class=${native ? "drag-out" : ""} title=${native ? "Drag into Finder, Slack, Figma…" : ""} />`}
      </div>
    </div>
  </div>`;
}

/** An export under way: what it's making and how far along, over the bottom of the canvas. */
function ExportProgress() {
  const s = useStore();
  const r = s.rendering;
  if (!r) return null;
  return html`<div class="float export-progress" onPointerDown=${stop}>
    <div class="ep-head"><span class="spinner"></span><b>${r.label}</b></div>
    ${r.progress !== undefined && html`<${RenderProgress} r=${r} />`}
  </div>`;
}

/** Opens and closes the timeline under the design. */
function TimelineButton() {
  return html`<div class="float timeline-btn" onPointerDown=${stop}>
    <button class="btn sm" title="Animate it for a video: open the timeline (⌘T)" onClick=${openTimeline}><${Icon} n="animate" s=${14} />Timeline<span class="kbd">⌘T</span></button>
  </div>`;
}

function Stage() {
  const s = useStore();
  // The start screen is for a design with nothing in it; a screen of a set waiting for its screenshot stays in the set.
  const empty = !hasDesign(s.scene) && !s.shots;
  return html`<main class="stage ${s.timelineOpen && !empty ? "animating" : ""}" style=${{ "--tl-h": s.tlH ? s.tlH + "px" : null }}>
    <div class="stage-glow"></div>
    ${empty ? html`<div class="dots"></div><${Welcome} />` : html`<${CanvasView} />`}
    ${!empty && s.timelineOpen && html`<${TimelineDock} />`}
    ${!empty && !s.timelineOpen && !s.stillPick && html`<${TimelineButton} />`}
    ${!empty && !s.timelineOpen && s.stillPick && html`<${StillPicker} key=${s.stillPick.video} />`}
    ${!empty && s.ai.open && !(s.ai.docked && s.rightOpen) && html`<${AIChat} />`}
    <${ExportProgress} />
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

/** Each step the agent takes: what it says while it runs, and once it's done. */
const provider = (x) => IMAGE_PROVIDERS[x?.provider] ?? "The image generator";
const AI_STEPS = {
  look: { now: "Rendering your design", done: (x) => (x.moments ? `Looked at ${x.moments} moments of your video` : "Looked at your design") },
  read: { now: "Reading the screenshots", done: "Read the design" },
  think: { now: () => `${aiName()} is thinking`, done: (x) => (x.answer ? "Answered" : "Designed the change") },
  retry: { now: "Fixing a mistake in its first try", done: "Fixed a mistake in its first try" },
  generate: { now: (x) => `${provider(x)} is making the new background image`, done: (x) => `${provider(x)} made the background image`, cut: (x) => `You used it while ${provider(x)} was still making the background image` },
  render: { now: "Rendering the result", done: "Rendered the result", cut: () => `You used it before ${aiName()} checked it` },
  frames: { now: (x) => `${aiName()} asked to see ${moments(x.times)}`, done: (x) => `Looked closer at ${moments(x.times)}` },
  check: { now: (x) => (x.moments ? `${aiName()} is checking ${x.moments} moments of the video` : `${aiName()} is checking the render`), done: (x) => (x.moments ? `Checked ${x.moments} moments of the video` : "Checked the render"), cut: "You used it before Claude finished checking it" },
};
const moments = (times = []) => (times.length > 3 ? `${times.length} moments` : times.map((t) => `${t} s`).join(", "));
const stepText = (x, active) => {
  const t = AI_STEPS[x.key]?.[active ? "now" : x.cut ? "cut" : "done"] ?? AI_STEPS[x.key]?.done ?? x.key;
  return typeof t === "function" ? t(x) : t;
};
const secs = (ms) => (ms >= 60000 ? `${Math.floor(ms / 60000)}m ${String(Math.floor((ms % 60000) / 1000)).padStart(2, "0")}s` : `${Math.max(0, Math.floor(ms / 1000))}s`);

/**
 * The agent at work, step by step, as the engine reports it: what it's doing now and for how
 * long, the image Claude looks at, and Stop. Once Claude has made its change, "Use it now" puts
 * it on the canvas without waiting for the check.
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
  const steps = w.steps ?? [];
  const scroll = (e) => {
    const b = e.target.closest(".ai-chat-body");
    b?.scrollTo({ top: b.scrollHeight, behavior: "smooth" });
  };
  const via = aiVia() || "Claude Code";
  return html`<div class="msg assistant work">
    <ol class="work-steps">
      ${!steps.length && html`<li class="active"><${StepIcon} state="active" /><div class="step-body"><div class="step-head"><b class="shimmer-text">Sending to ${aiName()}</b></div></div></li>`}
      ${steps.map((x, i) => {
        const active = !x.end;
        const st = active ? "active" : "done";
        return html`<li class=${st} key=${i}><${StepIcon} state=${st} /><div class="step-body">
          <div class="step-head"><b class=${active ? "shimmer-text" : ""}>${stepText(x, active)}</b><span class="work-time">${secs((x.end ?? now) - x.at)}</span></div>
          ${x.key === "look" && w.image && html`<div class="work-shot ${x.moments ? "sheet" : ""}"><img src=${w.image} onLoad=${scroll} /><i class="scan"></i></div>`}
          ${x.key === "read" && html`<div class="work-items">${w.items.map((t, j) => html`<span style=${{ "--i": j }}>${t}</span>`)}</div>`}
          ${x.key === "think" && active && html`<span class="step-note">${via} · usually 10 to 30 seconds</span>`}
          ${x.key === "retry" && x.reason && html`<span class="step-note">${x.reason}</span>`}
          ${x.key === "generate" &&
          html`<span class="step-note">${x.reason && html`<b class="why">Why a new image: </b>${x.reason}<br />`}${x.prompt ? `“${x.prompt.length > 110 ? x.prompt.slice(0, 110).trim() + "…" : x.prompt}”` : ""}${active ? html`<br />${x.provider === "openai" ? (s.ai.imageQuality === "best" ? "At Best quality this usually takes a minute or more." : "This usually takes about half a minute.") : "This can take a minute."}${w.draft ? " Use it now to skip the wait: the image appears on the canvas when it's made." : ""}` : ""}</span>`}
          ${x.key === "check" && w.checkImage && html`<div class="work-shot ${x.moments ? "sheet" : ""}"><img src=${w.checkImage} onLoad=${scroll} /><i class="scan"></i></div>`}
          ${x.key === "frames" && x.image && html`<div class="work-shot sheet"><img src=${x.image} onLoad=${scroll} /><i class="scan"></i></div>`}
        </div></li>`;
      })}
    </ol>
    <div class="work-actions">
      <span class="work-time">${secs(now - w.started)} in all</span><span class="grow"></span>
      ${w.draft && html`<button class="btn sm" title=${`Put ${aiName()}'s change on the canvas now, without waiting for it to check its work`} onClick=${useAIDraft}>Use it now</button>`}
      <button class="btn sm ghost stop" title=${`Stop ${aiName()}. The design stays as it was.`} onClick=${stopAI}><span class="stop-sq"></span>Stop</button>
    </div>
  </div>`;
}

/** After an answer: the steps it took, each with its time, folded into one line you can open. */
function WorkedFor({ m }) {
  const [open, setOpen] = useState(false);
  const list = m.steps?.list;
  return html`<div class="worked ${open ? "open" : ""}">
    <button class="worked-toggle" onClick=${() => setOpen(!open)}><${Icon} n="spark" s=${11} />Worked for ${m.took}s<${Icon} n="down" s=${11} class="chev" /></button>
    ${open &&
    (list?.length
      ? html`<ol class="work-steps done">
          ${list.map((x) => html`<li class="done"><${StepIcon} state="done" /><div class="step-body"><div class="step-head"><b>${stepText(x, false)}</b><span class="work-time">${secs(x.ms)}</span></div>
            ${x.key === "read" && m.steps.items?.length ? html`<div class="work-items static">${m.steps.items.map((t) => html`<span>${t}</span>`)}</div>` : ""}</div></li>`)}
          ${m.steps.checked?.fixes > 0 && html`<li class="done"><${StepIcon} state="done" /><div class="step-body"><b>Fixed ${m.steps.checked.fixes} thing${m.steps.checked.fixes === 1 ? "" : "s"} it saw in the render</b></div></li>`}
        </ol>`
      : html`<ol class="work-steps done">
          <li class="done"><${StepIcon} state="done" /><div class="step-body"><b>Looked at your design</b></div></li>
          <li class="done"><${StepIcon} state="done" /><div class="step-body"><b>Read the design</b>${m.steps?.items?.length ? html`<div class="work-items static">${m.steps.items.map((x) => html`<span>${x}</span>`)}</div>` : ""}</div></li>
          ${m.steps?.retried && html`<li class="done"><${StepIcon} state="done" /><div class="step-body"><b>Fixed a mistake in its first try</b></div></li>`}
          <li class="done"><${StepIcon} state="done" /><div class="step-body"><b>${m.changes ? `Made ${m.changes} change${m.changes === 1 ? "" : "s"}` : "Answered"}</b></div></li>
          ${m.steps?.checked && html`<li class="done"><${StepIcon} state="done" /><div class="step-body"><b>${m.steps.checked.fixes ? `Checked the render and fixed ${m.steps.checked.fixes} thing${m.steps.checked.fixes === 1 ? "" : "s"}` : "Checked the render"}</b></div></li>`}
        </ol>`)}
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
function AIChat({ docked }) {
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
  }, [ai.work?.steps?.length, ai.work?.image, ai.work?.checkImage, Boolean(ai.work?.draft)]);
  const setAi = (patch) => set({ ai: { ...S.ai, ...patch } });
  const status = s.opts?.ai;
  if (!ai.open) return null;
  const send = () => aiEdit(ai.text);
  // Drag the panel by its header; it stays inside the stage.
  const drag = (e) => {
    if (docked || e.button !== 0 || e.target.closest("button")) return;
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
  const via = aiVia();
  return html`<section class="ai-chat ${docked ? "docked" : ""} ${ai.busy ? "busy" : ""}" ref=${panel} style=${docked ? null : { right: pos.right + "px", bottom: pos.bottom + "px" }} onPointerDown=${(e) => e.stopPropagation()}>
    <header class="ai-chat-head" onPointerDown=${drag} title=${docked ? null : "Drag to move"}>
      <span class="ai-chat-mark"><${Icon} n="spark" s=${14} /></span>
      <b>Ask AI</b>${via && html`<span class="faint">${via}</span>`}
      <span class="grow"></span>
      ${ai.thread.length > 0 && html`<button class="icon-btn sm" title="New chat" onClick=${newChat}><${Icon} n="plus" s=${14} /></button>`}
      ${docked
        ? html`<button class="icon-btn sm" title="Shrink back to a floating panel (⇧⌘K)" onClick=${() => dockAI(false)}><${Icon} n="collapse" s=${14} /></button>`
        : html`<button class="icon-btn sm" title="Expand into the side panel (⇧⌘K)" onClick=${() => dockAI(true)}><${Icon} n="expand" s=${14} /></button>`}
      <button class="icon-btn sm" title="Close (Esc)" onClick=${() => setAi({ open: false })}><${Icon} n="x" s=${14} /></button>
    </header>
    <div class="ai-chat-body" ref=${body}>
      ${!ai.thread.length &&
      html`<div class="ai-chat-empty">
        <b>What should change?</b>
        <span>Describe it like you'd brief a designer. I can see the design, change anything in it, and answer questions about it.</span>
        <div class="suggestions">${suggestionsFor(ai.context ? s.selected : null).map((t) => html`<button class="chip" onClick=${() => aiEdit(t)}>${t}</button>`)}</div>
        ${s.scene.devices.length > 0 && !s.directions && html`<${DesignForMe} />`}
        ${status && !status.available && html`<span class="note warn">Ask AI needs Claude Code, Codex or an API key. <a href="#" onClick=${(e) => {
          e.preventDefault();
          set({ modal: { kind: "settings" } });
        }}>Open Settings</a></span>`}
      </div>`}
      ${ai.thread.map((m) =>
        m.role === "user"
          ? html`<div class="msg user" key=${m.id}>${m.about && html`<span class="msg-about"><${Icon} n="phone" s=${10} />${m.about}</span>`}<p>${m.text}</p></div>`
          : m.role === "error"
            ? html`<div class="msg error ${m.stopped ? "stopped" : ""}" key=${m.id}><p>${m.text}</p>${m.retry && html`<button class="btn sm" onClick=${() => aiEdit(m.retry)}>Try again</button>`}</div>`
            : html`<div class="msg assistant ${m.reverted ? "reverted" : ""} ${m.fresh ? "fresh" : ""}" key=${m.id}>
                ${m.took && html`<${WorkedFor} m=${m} />`}
                ${m.ops?.length > 0 &&
                html`<ul class="op-list">${m.ops.map(
                  (o, i) => html`<li style=${{ "--i": i }}><span class="op-tick"><${Icon} n="check" s=${10} w=${3} /></span>${o.shot && html`<span class="op-shot" title=${`Screen ${o.shot}`}>${o.shot}</span>`}<b>${o.prop}</b><span class="op-target">${o.target}</span>${o.value && html`<span class="op-val" title=${o.value}>${o.color && html`<i style=${{ background: o.color }}></i>`}<span>${o.value}</span></span>`}</li>`,
                )}</ul>`}
                <p>${m.fresh ? plain(m.text).split(/(\s+)/).map((w, i) => html`<span class="w" style=${{ "--i": Math.min(i, 60) }}>${w}</span>`) : plain(m.text)}</p>
                ${m.remembered?.length > 0 && html`<div class="remembered"><${Icon} n="spark" s=${11} /><span>Remembered for next time: ${m.remembered.map((r) => `“${r}”`).join(", ")}</span></div>`}
                ${m.changes > 0 &&
                html`<div class="msg-changes">
                  ${(m.reverted || !m.ops?.length) && html`<span>${m.reverted ? "Reverted" : `${m.changes} change${m.changes === 1 ? "" : "s"}${m.changed?.length ? ` · ${m.changed.slice(0, 3).join(", ")}` : ""}`}</span>`}
                  ${!m.reverted && canRevertAI(m.id) && html`<button class="link" onClick=${() => revertAI(m.id)}>Revert</button>`}
                </div>`}
              </div>`,
      )}
      ${ai.busy && html`<${AIWork} />`}
      ${s.directions && html`<${DesignForMe} />`}
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
            if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "k") {
              e.preventDefault();
              dockAI(!docked);
            } else if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
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
        ${ai.busy
          ? html`<button class="send stop" onClick=${stopAI} title=${`Stop ${aiName()}. The design stays as it was.`}><span class="stop-sq"></span></button>`
          : html`<button class="send" disabled=${!ai.text.trim()} onClick=${send} title="Send (Enter)"><${Icon} n="up" s=${16} w=${2.4} /></button>`}
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
      if (!Array.isArray(next.devices)) throw new Error("The design needs a devices array.");
      await api("/api/layout", next);
      setScene(next);
      setDirty(false);
      setErr(null);
      toast({ kind: "ok", title: "Design updated from JSON", timeout: 2500 });
    } catch (e) {
      setErr(e.message);
    }
  };
  return html`<div class="json-drawer" onPointerDown=${(e) => e.stopPropagation()}>
    <div class="panel-head"><h2>Design as JSON <span class="sub">create_mockup arguments</span></h2>
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
  const [unsplashKey, setUnsplashKey] = useState("");
  const [saving, setSaving] = useState(false);
  const ai = s.opts?.ai;
  useEffect(() => {
    native?.call("getSettings").then(setInfo).catch(() => setInfo({}));
  }, []);
  const saveUnsplashKey = async (value) => {
    setSaving(true);
    try {
      await native.call("setUnsplashKey", { key: value });
      setUnsplashKey("");
      toast({ kind: "ok", title: value ? "Unsplash key saved to Keychain" : "Unsplash key removed", text: "Restarting the engine…" });
    } catch (e) {
      fail(e, "Couldn't save the key");
    } finally {
      setSaving(false);
    }
  };
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
  const engine = aiEngine();
  return html`<div class="scrim" onPointerDown=${(e) => e.target === e.currentTarget && set({ modal: null })}>
    <div class="sheet">
      <div class="sheet-head"><h2>Settings</h2><button class="icon-btn" onClick=${() => set({ modal: null })}><${Icon} n="x" s=${16} /></button></div>
      <div class="sheet-body">
        <div class="card">
          <h4><${Icon} n="spark" s=${15} style=${{ color: "var(--pink)" }} />AI Edit
            <span class="grow"></span>
            ${engine === "codex"
              ? ai?.codex
                ? html`<span class="pill ok"><span class="status-dot ok"></span>Codex</span>`
                : html`<span class="pill"><span class="status-dot warn"></span>Codex not found</span>`
              : ai?.provider === "api"
                ? html`<span class="pill ok"><span class="status-dot ok"></span>Anthropic API</span>`
                : ai?.provider === "claude-code"
                  ? html`<span class="pill ok"><span class="status-dot ok"></span>Claude Code</span>`
                  : html`<span class="pill"><span class="status-dot warn"></span>Not set up</span>`}
          </h4>
          <div class="row"><label>Use</label><${Seg} value=${engine} options=${[{ value: "claude", label: "Claude" }, { value: "codex", label: "Codex" }]} onChange=${(v) => {
            set({ ai: { ...S.ai, engine: v } });
            persist();
          }} /></div>
          ${engine === "codex"
            ? html`<div class="note">Describe a change and Codex edits the design, using your signed-in <b>Codex</b> (${ai?.codex ? "found" : html`not found; install it with <code>brew install codex</code> and run <code>codex</code> once`}). It uses the model set in Codex${ai?.codexModel ? html` (<b>${ai.codexModel}</b>)` : ""}. Codex sees the scene settings (file paths replaced by placeholders) and, if you allow it, a small preview of the design when a request is about how it looks. Your original files stay on your Mac.</div>`
            : html`<div class="note">Describe a change and Claude edits the design. It uses your <b>Anthropic API key</b> if one is set, otherwise your signed-in <b>Claude Code</b> (${ai?.claudeCode ? "found" : "not found; install it and run claude once"}). Claude sees the scene settings (file paths replaced by placeholders) and, if you allow it, a small preview of the design when a request is about how it looks (questions and exact edits go without, so they're quicker). Your original files stay on your Mac.</div>`}
          <${Switch} checked=${s.ai.preview !== false} onChange=${(v) => {
            set({ ai: { ...S.ai, preview: v } });
            persist();
          }} label=${`Let ${engine === "codex" ? "Codex" : "Claude"} see a preview of the design`} />
          ${engine === "claude" &&
          html`${native
              ? html`<div class="row"><label>API key</label><div class="hstack">
                  <input class="input grow mono" type="password" placeholder=${info?.hasApiKey ? "•••••••••• saved in Keychain" : "sk-ant-… (optional)"} value=${key} onInput=${(e) => setKey(e.target.value)} onKeyDown=${(e) => e.stopPropagation()} />
                  <button class="btn" disabled=${!key.trim() || saving} onClick=${() => saveKey(key.trim())}>Save</button>
                  ${info?.hasApiKey && html`<button class="btn ghost" disabled=${saving} onClick=${() => saveKey("")}>Remove</button>`}
                </div></div>`
              : html`<div class="note">To use an API key, start the Studio with <code>ANTHROPIC_API_KEY</code> set.</div>`}
            <div class="row"><label>Model</label><${Dropdown} value=${s.ai.model} options=${models} onChange=${(v) => {
              set({ ai: { ...S.ai, model: v } });
              persist();
            }} /></div>`}
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
          <div class="note">Your screenshots, designs and exports live here.</div>
        </div>
        <${DeviceArt} />
        <${HouseStyle} />
        <div class="card">
          <h4><${Icon} n="code" s=${15} />For developers</h4>
          <div class="note">Every design is plain JSON: exactly what an AI agent sends to make this image. You can read it, edit it and apply it.</div>
          <div class="hstack"><button class="btn sm" onClick=${() => set({ modal: null, jsonOpen: true })}>Show this design as JSON</button><span class="kbd">⌥⌘J</span></div>
        </div>
        <div class="card">
          <h4><${Icon} n="image" s=${15} />Photos</h4>
          <div class="note">Searching <a href="https://unsplash.com" target="_blank">Unsplash</a> for background photos needs a free access key: at <a href="https://unsplash.com/developers" target="_blank">unsplash.com/developers</a>, make a new app (any name) and copy its <b>Access Key</b>. ${info?.hasUnsplashKey || s.opts?.unsplashKey ? "A key is set." : "Photos you've already chosen keep working without one."}</div>
          ${native
            ? html`<div class="row"><label>Access key</label><div class="hstack">
                <input class="input grow mono" type="password" placeholder=${info?.hasUnsplashKey ? "•••••••••• saved in Keychain" : "Unsplash Access Key"} value=${unsplashKey} onInput=${(e) => setUnsplashKey(e.target.value)} onKeyDown=${(e) => e.stopPropagation()} />
                <button class="btn" disabled=${!unsplashKey.trim() || saving} onClick=${() => saveUnsplashKey(unsplashKey.trim())}>Save</button>
                ${info?.hasUnsplashKey && html`<button class="btn ghost" disabled=${saving} onClick=${() => saveUnsplashKey("")}>Remove</button>`}
              </div></div>`
            : html`<div class="note">Start the Studio with <code>UNSPLASH_ACCESS_KEY</code> set to use one.</div>`}
        </div>
        <div class="card">
          <h4><${Icon} n="wand" s=${15} />AI backgrounds</h4>
          <div class="note">${s.opts?.aiProviders?.length ? html`Using <b>${s.opts.aiProviders.map((p) => IMAGE_PROVIDERS[p] ?? p).join(", ")}</b>. Ask AI only makes a new image when you ask for one, or when none of the looks, paintings, photos or colours can do what you asked.` : html`Add <code>OPENAI_API_KEY</code>, <code>GEMINI_API_KEY</code>, <code>REPLICATE_API_TOKEN</code> or <code>FAL_KEY</code> to your shell profile (~/.zshrc) and restart Screenshotter.`}</div>
          ${s.opts?.aiProviders?.[0] === "openai" &&
          html`<div class="row"><label>New images</label><${Seg} value=${s.ai.imageQuality === "best" ? "best" : "fast"} options=${[{ value: "fast", label: "Fast" }, { value: "best", label: "Best" }]} onChange=${(v) => {
              set({ ai: { ...S.ai, imageQuality: v } });
              persistPrefs();
            }} /></div>
            <div class="note">${s.ai.imageQuality === "best" ? "Best: the finest detail. A new image takes a minute or more." : "Fast: a new image in about half a minute, with a little less fine detail. Best takes a minute or more."} Images you already have are kept either way.</div>`}
        </div>
        <div class="card">
          <h4><${Icon} n="bolt" s=${15} />Shortcuts</h4>
          <div class="shortcuts">
            ${[
              ["Ask AI", "⌘K"],
              ["Quick preview", "⌘R"],
              ["Export image / video", "⌘E / ⇧⌘E"],
              ["Edit / Preview", "⌘1 / ⌘2"],
              ["My designs", "⇧⌘O"],
              ["Focus mode (hide both panels)", "⌘\\"],
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
  // Opened from the device panel's "Get Apple's device art…": bring this card into view.
  const card = useRef();
  useEffect(() => {
    if (S.modal?.tab === "art") card.current?.scrollIntoView({ block: "center" });
  }, []);
  return html`<div class="card" ref=${card}>
    <h4><${Icon} n="phone" s=${15} />Device art<span class="grow"></span>
      ${info?.count ? html`<span class="pill ok"><span class="status-dot ok"></span>Apple bezels</span>` : html`<span class="pill">No device art yet</span>`}</h4>
    <div class="note">Devices are shown with Apple's own product renders: only the models you get here appear in the device list, in the finishes (and, for Apple Watch, the bands) Apple drew. Screenshotter downloads them from <a href="https://developer.apple.com/design/resources/" target="_blank">Apple Design Resources</a>, and macOS asks you to accept Apple's license first. It covers mock-ups of apps for Apple platforms, so website captures are shown without hardware.</div>
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
    ["sim", "1 · Add a screenshot", "Drop in an image, or capture your app from the iOS Simulator, a website or a Mac window. They collect under Screenshots."],
    ["wand", "2 · Pick a look", `Templates has finished designs made from your screenshot; Backgrounds has macOS wallpapers, looks, colours and photos. ${aiName()} can design three for you in Ask AI.`],
    ["canvas", "3 · Make it yours", "Click anything in the design and its settings show on the right; with nothing selected, they're the whole design's. Drag to move, pull a corner to resize, use the round handle to rotate, double-click text to retype it. Right-click for more."],
    ["shapes", "Add more", "Elements has text, badges, arrows, shapes, stickers and pictures. Drag one onto the design, or click it."],
    ["animate", "Make it move", "The timeline (⌘T) opens under the design. Choose a row, move the playhead to when it should happen, and add how it moves. Space plays."],
    ["spark", "Or just ask", "Press Ask AI (⌘K) and describe the change: “tilt the phone and use a sunset background”. Undo (⌘Z) reverts anything."],
    ["export", "4 · Export", "Export saves the image (PNG, JPEG or WebP), the whole set, or a video when the design moves. As you work, the design shows its finished look: grain, finishes and colour."],
    ["grid", "My designs", "Every design saves itself as you work. My designs (⇧⌘O) has them all, and everything you've exported."],
  ];


  return html`<div class="scrim" onPointerDown=${(e) => e.target === e.currentTarget && close()}>
    <div class="sheet">
      <div class="sheet-head"><h2>How Screenshotter works</h2><button class="icon-btn" onClick=${close}><${Icon} n="x" s=${16} /></button></div>
      <div class="sheet-body">
        ${steps.map(([icon, title, text]) => html`<div class="help-row"><span class="ico"><${Icon} n=${icon} s=${18} /></span><div><b>${title}</b><div class="note" style=${{ fontSize: "12.5px" }}>${text}</div></div></div>`)}
        <div class="hstack">
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

/** Copy the screen's style to the others: which parts, and to this size or every size. */
function CopyStyle() {
  const s = useStore();
  const [parts, setParts] = useState({ backdrop: true, text: true, film: true, device: false, placement: false });
  const [every, setEvery] = useState(false);
  const here = s.shots ? s.shot : 0;
  const sizes = s.groups?.length > 1 ? s.groups : null;
  const mine = s.shots?.length ?? 1;
  const others = sizes ? sizes.reduce((n, g, i) => n + (i === s.group ? 0 : g.shots.length), 0) : 0;
  const n = mine - 1 + (every ? others : 0);
  const any = STYLE_PARTS.some((p) => parts[p.key]);
  const go = () => any && n > 0 && copyStyle(parts, every);
  const close = () => set({ modal: null });
  useEffect(() => {
    const key = (e) => {
      if (e.key === "Escape") close();
      if (e.key === "Enter") go();
      e.stopPropagation();
    };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  });
  const sizeNow = sizeLabel(s.scene);
  return html`<div class="scrim" onPointerDown=${(e) => e.target === e.currentTarget && close()}>
    <div class="sheet copy-style" style=${{ width: "440px" }}>
      <div class="sheet-head"><h2>Copy style</h2></div>
      <div class="sheet-body">
        <div class="note">From <b>${String(here + 1).padStart(2, "0")} · ${screenName(here)}</b> to the other screens. What they say and show stays theirs.</div>
        <div class="cs-parts">
          ${STYLE_PARTS.map(
            (p) => html`<label class="cs-part ${parts[p.key] ? "on" : ""} ${every && p.sameSize ? "here-only" : ""}">
              <input type="checkbox" checked=${parts[p.key]} onChange=${(e) => setParts({ ...parts, [p.key]: e.target.checked })} />
              <span class="box"><${Icon} n="check" s=${11} w=${2.6} /></span>
              <span class="t"><b>${p.label}</b><span>${every && p.sameSize ? `${sizeNow} screens only: each size keeps its own devices.` : p.hint}</span></span>
            </label>`,
          )}
        </div>
        ${sizes &&
        html`<div class="cs-where"><span class="lbl">Copy to</span><${Seg} value=${every ? "all" : "size"} onChange=${(v) => setEvery(v === "all")}
          options=${[
            { value: "size", label: `${sizeNow} · ${mine - 1}` },
            { value: "all", label: `Every size · ${mine - 1 + others}` },
          ]} /></div>`}
      </div>
      <div class="sheet-foot"><button class="btn" onClick=${close}>Cancel</button>
        <button class="btn primary" disabled=${!any || n < 1} onClick=${go}>${n < 1 ? "No other screens" : `Copy to ${n} screen${n === 1 ? "" : "s"}`}</button></div>
    </div>
  </div>`;
}

/** Pictures of screens for the store page, by contents and width, kept while the app runs. */
const storeThumbs = new Map();
function useStoreThumbs(scenes, w) {
  const [, bump] = useState(0);
  useEffect(() => {
    let alive = true;
    for (const sc of scenes) {
      const key = `${w}:${JSON.stringify(sc)}`;
      if (storeThumbs.has(key)) continue;
      storeThumbs.set(key, null);
      api(`/api/shot-thumb?w=${w}`, sc)
        .then((r) => {
          storeThumbs.set(key, r.image ?? "");
          if (alive) bump((n) => n + 1);
        })
        .catch(() => storeThumbs.delete(key));
    }
    return () => {
      alive = false;
    };
  }, [scenes.map((x) => JSON.stringify(x)).join("|"), w]);
  return scenes.map((sc) => storeThumbs.get(`${w}:${JSON.stringify(sc)}`));
}

/**
 * The app's icon on the store page: yours, or its initial until you choose one. Click it to pick
 * one of your pictures or a file; drop a picture on it to use that.
 */
function StoreIcon({ name }) {
  const s = useStore();
  const icon = appIconOf();
  const [open, setOpen] = useState(false);
  const [over, setOver] = useState(false);
  const [pics, setPics] = useState(null);
  const file = useRef(null);
  const wrap = useRef(null);
  useEffect(() => {
    if (!open) return;
    api("/api/images")
      .then((r) => setPics((r.images ?? []).filter((p) => !/\.svg$/i.test(p.path)).slice(0, 15)))
      .catch(() => setPics([]));
    const away = (e) => wrap.current && !wrap.current.contains(e.target) && setOpen(false);
    addEventListener("pointerdown", away, true);
    return () => removeEventListener("pointerdown", away, true);
  }, [open, s.imagesStamp]);
  const use = async (files) => {
    const [p] = await uploadImages([...files].slice(0, 1));
    if (p) {
      setAppIcon(p);
      setOpen(false);
    }
  };
  const drop = (e) => {
    e.preventDefault();
    e.stopPropagation();
    setOver(false);
    if (e.dataTransfer?.files?.length) use(e.dataTransfer.files);
  };
  return html`<div class="stp-icon-wrap" ref=${wrap}>
    <button class="stp-icon ${icon ? "mine" : ""} ${over ? "drop" : ""}" title="Your app's icon: click to choose one, or drop a picture here"
      onClick=${() => setOpen(!open)}
      onDragOver=${(e) => (e.preventDefault(), e.stopPropagation(), setOver(true))} onDragLeave=${() => setOver(false)} onDrop=${drop}>
      ${icon ? html`<img src=${pictureUrl(icon)} alt="" />` : name.trim()[0]?.toUpperCase()}
      <span class="stp-icon-hint">${icon ? "Change" : "Add icon"}</span>
    </button>
    <input ref=${file} type="file" accept="image/png,image/jpeg,image/webp,image/gif" hidden onChange=${(e) => (e.target.files?.length && use(e.target.files), (e.target.value = ""))} />
    ${open && html`<div class="stp-icon-menu" onPointerDown=${(e) => e.stopPropagation()}>
      <h4>App icon</h4>
      ${pics?.length > 0 && html`<div class="pics">${pics.map((p) => html`<button key=${p.path} class=${p.path === icon ? "on" : ""} title=${p.path.split("/").pop()} onClick=${() => (setAppIcon(p.path), setOpen(false))}><img loading="lazy" src=${pictureUrl(p.path)} /></button>`)}</div>`}
      <div class="acts">
        <button class="btn sm primary" onClick=${() => file.current?.click()}><${Icon} n="upload" s=${13} />Choose a file…</button>
        ${s.appIcon && html`<button class="btn sm" onClick=${() => (setAppIcon(null), setOpen(false))}>Remove</button>`}
      </div>
      <p class="note">${pics?.length ? "One of your pictures, or a new one. " : ""}A square PNG of your icon, at 1024 × 1024, looks best. It stays with this design.</p>
    </div>`}
  </div>`;
}

/**
 * The set on a store's product page: each size's screenshots in a row, in order, as people scroll
 * them. A sketch of the page (no store's marks or made-up ratings), sized like the device's.
 */
function StorePage() {
  const s = useStore();
  const sizes = setSizes();
  const [pick, setPick] = useState(Math.min(s.groups ? s.group : 0, sizes.length - 1));
  const size = sizes[pick] ?? sizes[0];
  const first = size.screens[0].scene;
  const preset = typeof first.canvas === "string" ? s.opts?.canvases?.[first.canvas] : null;
  const platform = preset?.platform ?? (pick === (s.groups ? s.group : 0) && s.layout?.canvas.width > s.layout?.canvas.height ? "mac" : "iphone");
  let [cw, ch] = preset ? [preset.width, preset.height] : /^\d+x\d+$/.test(first.canvas ?? "") ? first.canvas.split("x").map(Number) : [s.layout?.canvas.width ?? 1320, s.layout?.canvas.height ?? 2868];
  if (first.landscape && cw < ch) [cw, ch] = [ch, cw];
  const wide = cw > ch;
  const page = { ipad: 720, mac: 860, tv: 860, vision: 860 }[platform] ?? 390;
  const tileH = platform === "watch" ? 210 : wide ? Math.round(((page - 56) * ch) / cw) : platform === "ipad" ? 380 : 430;
  const tileW = Math.round((tileH * cw) / ch);
  const thumbs = useStoreThumbs(size.screens.map((x) => x.scene), Math.min(900, Math.round(tileW * 2)));
  const name = (s.sceneName || "Your app").replace(/\s*·\s*(App Store|Google Play).*$/i, "") || "Your app";
  const close = () => set({ modal: null });
  useEffect(() => {
    const key = (e) => {
      if (e.key === "Escape") close();
      if (e.key === "ArrowRight" || e.key === "ArrowLeft") setPick((p) => Math.max(0, Math.min(sizes.length - 1, p + (e.key === "ArrowRight" ? 1 : -1))));
      e.stopPropagation();
    };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  }, [sizes.length]);
  const play = preset?.store === "google-play";
  const device = { ipad: "iPad", mac: "Mac", watch: "Apple Watch", tv: "Apple TV", vision: "Apple Vision Pro", android: "Android" }[platform] ?? (play ? "Phone" : "iPhone");
  return html`<div class="scrim" onPointerDown=${(e) => e.target === e.currentTarget && close()}>
    <div class="sheet store-sheet">
      <div class="sheet-head"><h2>Store page preview</h2>
        ${sizes.length > 1 && html`<${Seg} value=${pick} onChange=${setPick} options=${sizes.map((z, i) => ({ value: i, label: z.label }))} />`}
        <button class="icon-btn sm" title="Close (Esc)" onClick=${close}><${Icon} n="x" s=${15} /></button></div>
      <div class="sheet-body store-body">
        <div class="store-page ${platform}" style=${{ width: page + "px" }}>
          <div class="stp-head">
            <${StoreIcon} name=${name} />
            <div class="stp-meta"><b>${name}</b><span>${device} app</span><button class="stp-get ${play ? "play" : ""}" tabIndex="-1">${play ? "Install" : "Get"}</button></div>
          </div>
          <div class="stp-row" style=${{ "--tile-h": tileH + "px", gap: Math.round(tileW * STORE_GAP) + "px" }}>
            ${size.screens.map((x, i) => html`<div class="stp-shot ${platform}" key=${i} title=${`${String(i + 1).padStart(2, "0")} · ${x.name}`} style=${{ width: tileW + "px", height: tileH + "px" }}>
              ${thumbs[i] ? html`<img src=${thumbs[i]} alt=${x.name} />` : html`<span class="spin"></span>`}
            </div>`)}
          </div>
          <div class="stp-device"><${Icon} n=${{ ipad: "tablet", mac: "laptop", watch: "watch" }[platform] ?? "phone"} s=${13} />${device}</div>
          <div class="stp-lines"><i></i><i></i><i style=${{ width: "62%" }}></i></div>
        </div>
        <div class="note">${size.label}: ${size.screens.length} screenshot${size.screens.length === 1 ? "" : "s"} in store order. The first are the ones people see before they scroll.${sizes.length > 1 ? " ← and → switch sizes." : ""}${s.appIcon ? "" : " Click the icon to add your app's."}</div>
      </div>
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

/** The edge of a side panel: drag it to make the panel wider or narrower; double-click for the usual width. */
function Resizer({ side }) {
  const left = side === "l";
  const down = (ev) => {
    if (ev.button !== 0) return;
    ev.preventDefault();
    const app = ev.currentTarget.closest(".app");
    const w0 = app.querySelector(left ? ".panel.left" : ".panel.right").offsetWidth;
    const min = left ? 248 : 264;
    // The canvas keeps at least 340px.
    const max = Math.max(min, Math.min(680, w0 + app.querySelector(".stage").offsetWidth - 340));
    const x0 = ev.clientX;
    let w = w0;
    app.classList.add("resizing");
    const move = (e) => {
      w = Math.round(Math.min(max, Math.max(min, w0 + (left ? 1 : -1) * (e.clientX - x0))));
      app.style.setProperty(left ? "--left-w" : "--right-w", w + "px");
    };
    const up = () => {
      removeEventListener("pointermove", move);
      removeEventListener("pointerup", up);
      app.classList.remove("resizing");
      if (w !== w0) {
        set(left ? { leftW: w } : { rightW: w });
        persistPrefs();
      }
    };
    addEventListener("pointermove", move);
    addEventListener("pointerup", up);
  };
  const reset = () => {
    set(left ? { leftW: null } : { rightW: null });
    persistPrefs();
  };
  return html`<div class="resizer ${side}" title="Drag to resize. Double-click for the usual width." onPointerDown=${down} onDblClick=${reset}></div>`;
}

function App() {
  const s = useStore();
  if (s.bootError) {
    return html`<div class="hero"><div class="hero-inner"><h1>Couldn't reach the <em>engine.</em></h1><p>${s.bootError}</p><button class="btn primary" onClick=${() => location.reload()}>Try again</button></div></div>`;
  }
  if (!s.ready) return html`<div class="boot"><div class="boot-mark"></div></div>`;
  return html`<div class="app ${s.leftOpen ? "" : "left-closed"} ${s.rightOpen ? "" : "right-closed"}" style=${{ "--left-w": s.leftW ? s.leftW + "px" : null, "--right-w": s.rightW ? s.rightW + "px" : null }}>
    <${Topbar} />
    <${Rail} />
    <${LeftPanel} />
    <${Stage} />
    ${s.ai.open && s.ai.docked && s.rightOpen ? html`<aside class="panel right chat"><${AIChat} docked /></aside>` : html`<${Inspector} />`}
    ${s.leftOpen && html`<${Resizer} side="l" />`}
    ${s.rightOpen && html`<${Resizer} side="r" />`}
    ${s.scenesPage && html`<${ScenesPage} />`}
    ${s.modal?.kind === "settings" && html`<${Settings} />`}
    ${s.modal?.kind === "confirm" && html`<${Confirm} />`}
    ${s.modal?.kind === "help" && html`<${Help} />`}
    ${s.modal?.kind === "whatsNew" && html`<${WhatsNew} />`}
    ${s.modal?.kind === "prompt" && html`<${Prompt} />`}
    ${s.modal?.kind === "copyStyle" && html`<${CopyStyle} />`}
    ${s.modal?.kind === "storePage" && html`<${StorePage} />`}
    ${s.modal?.kind === "viewer" && html`<${Viewer} />`}
    <${Toasts} />
    <${ContextMenu} />
    ${s.dropping && html`<div class="drop-veil"><div><${Icon} n="upload" s=${28} />${s.scenesPage ? "Drop to start a new design" : "Drop to add to the design"}</div></div>`}
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

/** How far a video export has got: a bar, the percentage, and about how long it has to go. */
function RenderProgress({ r }) {
  const pct = Math.min(100, Math.floor((r.progress ?? 0) * 100));
  const left = r.left;
  const time = left == null ? "" : left < 60 ? `about ${Math.max(1, Math.round(left))} s left` : `about ${Math.floor(left / 60)} min ${String(Math.round(left % 60)).padStart(2, "0")} s left`;
  return html`<div class="render-progress">
    <div class="bar"><i style=${{ width: pct + "%" }}></i></div>
    <div class="pct"><b>${pct}%</b>${pct >= 100 ? " · finishing up…" : time ? ` · ${time}` : pct === 0 ? " · getting ready…" : ""}</div>
  </div>`;
}

const commands = {
  undo: () => (typing() ? document.execCommand("undo") : undo()),
  redo: () => (typing() ? document.execCommand("redo") : redo()),
  ai: () => (S.ai.open ? set({ ai: { ...S.ai, open: false } }) : openAI()),
  preview: () => canvasApi.finishNow(),
  showPreview: () => canvasApi.finishNow(),
  exportImage,
  exportVideo,
  canvas: () => closeTimeline(),
  animate: () => toggleTimeline(),
  timeline: () => toggleTimeline(),
  render: () => canvasApi.finishNow(),
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
  // A recording from the capture bar: a design of its own, open in Animate.
  openRecording: async (r) => {
    await booted;
    // A screenshot comes the same way, as a design of its own.
    if (r?.image) await openScreenshot(r);
    else await openRecording(r);
    await refreshFiles().catch(() => undefined);
  },
  save: () => saveNow(),
  scenes: () => toggleScenesPage(),
  import: () => {
    set({ leftTab: "captures", leftOpen: true, capture: { ...S.capture, source: "import" } });
    setTimeout(() => document.querySelector('.dropzone input[type="file"]')?.click(), 60);
  },
  toggleLeft: () => togglePanel("left"),
  toggleRight: () => togglePanel("right"),
  focus: () => toggleFocus(),
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
  if (mod && e.shiftKey && k === "k") {
    e.preventDefault();
    return dockAI(!S.ai.docked);
  }
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
  if (mod && k === "r") return e.preventDefault(), canvasApi.finishNow();
  if (mod && k === "e") return e.preventDefault(), e.shiftKey ? exportVideo() : exportImage();
  if (mod && k === "1") return e.preventDefault(), commands.canvas();
  if (mod && k === "2") return e.preventDefault(), canvasApi.finishNow();
  // ⌘T opens and closes the timeline (⌘3 too, as Animate did).
  if (mod && (k === "t" || k === "3")) return e.preventDefault(), toggleTimeline();
  if (mod && (k === "=" || k === "+")) return e.preventDefault(), commands.zoomIn();
  if (mod && k === "-") return e.preventDefault(), commands.zoomOut();
  if (mod && (k === "0" || e.code === "Digit0")) {
    e.preventDefault();
    // In a set, ⌘0 fits the screen being edited and ⇧⌘0 the whole set.
    const inSet = S.shots?.length > 1 && !S.timelineOpen;
    return e.shiftKey && inSet ? canvasApi.fitSet() : inSet ? canvasApi.fitScreen() : commands.fit();
  }
  // Animate: ⌘B cuts the sound at the playhead.
  // ⌘B cuts the recording's footage at the playhead (the sound alone when the Sound row is chosen).
  if (mod && k === "b" && S.timelineOpen) {
    if (cuttable() && !S.animRows.includes("sound")) return e.preventDefault(), cutFootageHere();
    if (hasSoundRow()) return e.preventDefault(), cutSoundHere();
  }
  if (mod && k === "d") return e.preventDefault(), commands.duplicate();
  if (mod && k === "o") return e.preventDefault(), commands.import();
  if (mod && k === ",") return e.preventDefault(), commands.settings();
  if (mod && e.code === "Backslash") return e.preventDefault(), commands.focus();
  if (mod && e.altKey && e.code === "KeyS") return e.preventDefault(), commands.toggleLeft();
  if (mod && e.altKey && e.code === "KeyI") return e.preventDefault(), commands.toggleRight();
  if (mod && e.altKey && e.code === "KeyJ") return e.preventDefault(), commands.json();
  if (mod) return;
  // Animate: Space plays, ⌫ deletes the selected animation, Esc lets go of it.
  if (S.timelineOpen) {
    if (e.key === " ") return e.preventDefault(), play();
    if (S.animSel !== null && (e.key === "Backspace" || e.key === "Delete")) return e.preventDefault(), deleteAnimation(S.animSel);
    if (S.animSel !== null && e.key === "Escape") return set({ animSel: null });
    if (S.footageSel != null && (e.key === "Backspace" || e.key === "Delete")) return e.preventDefault(), deleteFootagePart(S.footageSel);
    if (S.footageSel != null && e.key === "Escape") return set({ footageSel: null });
    if (S.soundSel != null && (e.key === "Backspace" || e.key === "Delete")) return e.preventDefault(), deleteSound(S.soundSel);
    if (S.soundSel != null && e.key === "Escape") return set({ soundSel: null });
    if (S.soundSel != null && (e.key === "ArrowLeft" || e.key === "ArrowRight")) return e.preventDefault(), nudgeSound((e.key === "ArrowLeft" ? -1 : 1) * (e.shiftKey ? 1 : 0.1), videoLength());
  }
  if (e.key === "Escape") {
    if (S.stillPick) return closeStills(true);
    if (S.exportOpen) return set({ exportOpen: false });
    if (S.jsonOpen) return set({ jsonOpen: false });
    if (S.ai.open) return set({ ai: { ...S.ai, open: false } });
    if (S.replacing) return set({ replacing: null });
    return set({ selected: null });
  }
  if (!S.selected) {
    // A set with nothing selected: ← and → step through its screens.
    if (!S.timelineOpen && S.shots?.length > 1 && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
      e.preventDefault();
      return goToShot(Math.max(0, Math.min(S.shots.length - 1, S.shot + (e.key === "ArrowLeft" ? -1 : 1))));
    }
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
    const placed = d.x !== undefined || d.y !== undefined || d.height !== undefined || d.rotate;
    return [
      { label: `Ask AI about ${entityLabel(id)}…`, icon: "spark", ai: true, kbd: "⌘K", run: () => openAI(id) },
      "-",
      { label: "Replace screenshot…", icon: "replace", run: () => replaceMode(id) },
      d.video && { label: "Pick the still…", icon: "image", run: () => openStills(id) },
      // Devices are shown with Apple's art; a design that turned it off can turn it back on.
      d.bezel === false && { label: "Use Apple's device art", icon: "image", run: () => editScene((sc) => delete sc.devices[i].bezel) },
      { label: "Put back in the layout", icon: "refresh", disabled: !placed, run: () => editScene((sc) => ["x", "y", "anchor", "height", "width", "rotate"].forEach((k) => delete sc.devices[i][k])) },
      "-",
      { label: "Duplicate", icon: "duplicate", kbd: "⌘D", run: () => duplicateEntity(id) },
      { label: "Bring forward", icon: "front", run: () => moveZ(id, 1) },
      { label: "Send backward", icon: "back", run: () => moveZ(id, -1) },
      "-",
      { label: "Delete", icon: "trash", kbd: "⌫", danger: true, run: () => deleteEntity(id) },
    ];
  }
  if (id.startsWith("image-")) {
    const b = S.scene.images?.[i];
    if (!b) return [];
    return [
      { label: "Replace picture…", icon: "replace", run: () => set({ selected: id, replacingImage: id, leftTab: "images", leftOpen: true }) },
      { label: b.sticker ? "Remove the sticker edge" : "Make it a sticker", icon: "image", run: () => editScene((sc) => (sc.images[i].sticker = b.sticker ? undefined : true)) },
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
      !["laurel", "rating", "burst", "ribbon", "bubble", "tag"].includes(sh.type) && { label: sh.sketch ? "Make it clean" : "Make it hand-drawn", icon: "pen", run: () => editScene((sc) => (sc.shapes[i].sketch = sh.sketch ? undefined : true)) },
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
    { label: "Change background…", icon: "background", run: () => set({ leftTab: "backgrounds", leftOpen: true }) },
    has && !S.scene.recording && { label: "Add a screen", icon: "plus", run: () => addShot("copy", S.shots?.length > 1 ? { at: S.shots.length, copyOf: S.shots.length - 1 } : {}) },
    "-",
    has && { label: "Export image", icon: "export", kbd: "⌘E", run: exportImage },
    has && { label: "Zoom to fit", icon: "fit", kbd: "⌘0", run: () => canvasApi.fit() },
  ];
}

function fileMenu(p, kind) {
  const image = !isVideo(p);
  if (kind === "saved") {
    return [
      { label: "Open", icon: "eye", run: () => openViewer(p) },
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
  } else if (t.closest?.(".viewer-frame") && S.render && !S.render.sheet) {
    items = fileMenu(S.render.path, "saved").slice(1);
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
  // With the Images panel open, pictures dropped on the design go on as image blocks.
  if (!S.scenesPage && S.leftOpen && S.leftTab === "images" && files.every((f) => /\.(png|jpe?g|webp|gif|svg)$/i.test(f.name))) {
    return uploadImages(files).then((paths) => paths.forEach((p) => addPicture(p)));
  }
  // On the Scenes page, a drop starts a new scene with the files.
  if (S.scenesPage) return newScene().then(() => (closeScenesPage(), uploadFiles(files)));
  // On another screen of the set: open it, and the files go there (onto the device dropped on).
  const ghost = e.target.closest?.(".ghost-wrap.set");
  if (ghost) {
    const device = deviceAtPoint(ghost, e.clientX, e.clientY);
    goToShot(Number(ghost.dataset.shot));
    return uploadFiles(files, { device });
  }
  uploadFiles(files);
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
  // A smaller window: widened panels go back to their usual width rather than squeeze the canvas.
  const stage = document.querySelector(".stage");
  if (stage && stage.offsetWidth < 300 && (S.leftW || S.rightW)) set({ leftW: null, rightW: null });
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
    api("/api/set-templates").then((setTemplates) => set({ setTemplates })).catch(() => undefined);
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
    // Scenes: list them, and make sure the design on screen is one of them. An agent may have
    // changed the open one while the Studio was closed.
    refreshScenes().then((scenes) => pickUpAgentChanges(scenes, null));
    if (!S.sceneId && hasDesign(S.scene)) saveSceneNow();
    // Scenes saved by agents through the MCP server show up while you work.
    setInterval(async () => {
      if (document.visibilityState !== "visible" || S.busy || S.ai.busy) return;
      const known = new Set(S.scenes.map((x) => x.id));
      pickUpAgentChanges(await refreshScenes(), known);
    }, 5000);
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
