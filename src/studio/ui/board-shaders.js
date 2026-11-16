// Shaders on a board, in the Studio: a frame's shader fill on the canvas, the shader in the
// panel's Fill section (the shader chooser and its settings) and the Shaders in Assets. The
// drawing is the runtime's (board-shader-runtime.js: one WebGL context for every shader on the
// page, the same script Preview, pages copied out and pictures of the board carry); the model is
// the engine's (src/board/shaders.ts, through board-core.js).
//
// Nothing here redraws per frame: a frame's canvas is handed to the runtime once, and again only
// when its shader, the board's tokens or the board's own presets change. The runtime plays it
// from there.
import "./board-shader-runtime.js";
import { useEffect, useRef, useState } from "preact/hooks";
import { SHADER_BLENDS, SHADER_PRESETS, cleanShaderSpec, newId, nodeHtml, parseShaderParams, presetOf, round, saveShaderPresetOps, shaderCode, shaderLabel, shaderPresetName, shaderUniforms, shaderUsers, shaderValues, subtree } from "./board-core.js";
import { B, CANVAS_ONLY, node, onBoard, useBoard } from "./board-state.js";
import { Dropdown, Num, Popover, Section, Seg, Slider, html, resolveVars } from "./controls.js";
import { Icon } from "./icons.js";
import { toast } from "./store.js";

const BS = globalThis.BoardShaders;

// ---------------------------------------------------------------------------------------------
// The runtime, told about the canvas: its zoom, and when the view (or a layer's size) is moving.

/** Each shader's state as the runtime last said it (playing, paused, error, too slow…), by its frame's id. */
const states = new Map();
const stateListeners = new Set();
/** The runtime's handle on each frame's shader drawn on the canvas, by the frame's id. */
const handles = new Map();
const toldSlow = new Set();
let lastView = null;
let viewAt = 0;

BS.configure({
  zoom: () => B.view?.z ?? 1,
  // Panning, zooming, or a layer being resized or scaled: drawn at less resolution until it stops.
  moving: () => {
    if (B.view !== lastView) {
      lastView = B.view;
      viewAt = performance.now();
    }
    return B.dragging === "pan" || B.dragging === "resize" || B.dragging === "scale" || performance.now() - viewAt < 140;
  },
  // The frame being worked on plays, however small, whatever else is on screen.
  focus: (id) => Boolean(id) && B.sel.includes(id),
  onState: (canvas, st) => {
    const id = canvas.dataset.layer;
    if (!id) return;
    states.set(id, st);
    for (const l of stateListeners) l(id);
    if (st.kind === "slow" && !toldSlow.has(id)) {
      toldSlow.add(id);
      toast({ kind: "info", icon: "alert", title: "A shader was too slow to play", text: `“${node(id)?.name ?? "Shader"}” shows its still here. A smaller or lighter one plays; press play in its shader settings to try again.`, timeout: 8000 });
    }
  },
});
// The runtime sleeps when nothing plays; a change to the board (the view moving, above all) wakes
// it, to redraw stills at the new zoom.
onBoard(() => BS.wake());

/** A frame's shader state, kept up to date: { kind: "playing" | "paused" | "reduced" | "slow" | "error" | "nogl", ms, errors }. */
export function useShaderState(id) {
  const [, force] = useState(0);
  useEffect(() => {
    const l = (x) => x === id && force((k) => k + 1);
    stateListeners.add(l);
    return () => stateListeners.delete(l);
  }, [id]);
  return states.get(id) ?? null;
}

/** What the runtime draws a frame's shader with: its code, uniforms (tokens left for it to resolve), speed, still and pause. */
function layerData(board, n) {
  const spec = n.shader ?? {};
  const code = shaderCode(spec, board.shaders) ?? "";
  return { code, uniforms: shaderUniforms(code, spec.params), speed: spec.speed ?? 1, time: spec.time ?? 0, paused: Boolean(spec.paused) };
}

const CANVAS_STYLE = { display: "block", width: "100%", height: "100%", borderRadius: "inherit" };
/** A frame's shader canvas, as the engine writes it (SHADER_CANVAS_CSS): over the frame's box, behind its layers, never in the way of a click. */
const FILL_CANVAS = { position: "absolute", left: "0", top: "0", zIndex: "-1", display: "block", width: "100%", height: "100%", borderRadius: "inherit", pointerEvents: "none" };

/**
 * A frame's shader on the canvas: the canvas the runtime draws in, the frame's first child. It
 * follows the board's tokens and presets, which the frame's layer object doesn't change with.
 */
export function ShaderCanvas({ n }) {
  useBoard(CANVAS_ONLY);
  const ref = useRef();
  useEffect(() => {
    const h = BS.attach(ref.current, layerData(B.board, n));
    handles.set(n.id, h);
    return () => {
      h.detach();
      if (handles.get(n.id) === h) handles.delete(n.id);
    };
  }, []);
  useEffect(() => {
    handles.get(n.id)?.update(layerData(B.board, n));
  }, [n.shader, B.board.tokens, B.board.shaders]);
  const blend = n.shader?.blend;
  return html`<canvas ref=${ref} data-layer=${n.id} data-shader-canvas style=${blend ? { ...FILL_CANVAS, mixBlendMode: blend } : FILL_CANVAS}></canvas>`;
}

let runtimeText = "";
fetch(new URL("./board-shader-runtime.js", import.meta.url))
  .then((r) => (r.ok ? r.text() : ""))
  .then((t) => (runtimeText = t))
  .catch(() => undefined);

/** Layers as HTML for a page of their own (Copy as HTML): with shaders, the runtime goes first, and each carries its code. */
export function pageHtml(board, ids) {
  const shaders = ids.some((id) => subtree(board, id).some((x) => board.nodes[x]?.shader));
  const body = ids.map((id) => nodeHtml(board, id, shaders ? { code: true } : {})).join("\n");
  if (!shaders || !runtimeText) return body;
  return `<script data-board-shaders>${runtimeText.replace(/<\/script/gi, "<\\/script")}\nBoardShaders.auto();</script>\n${body}`;
}

// ---------------------------------------------------------------------------------------------
// Tiles: a preset's still, playing only while the pointer (or the keyboard) is on it. Ten tiles
// playing at once kept the GPU busy, and the whole board choppy, for as long as they showed.

/** The layer an Assets tile adds: a frame with that shader and nothing in it, 400 × 300 (one of the board's own carries its code too). */
export function shaderAssetLayers(a) {
  const p = presetOf(a.preset);
  const own = B.board.shaders?.find((s) => s.name === a.preset);
  return [{ id: newId(), type: "frame", name: p?.name ?? shaderLabel(a.preset), parent: null, children: [], shader: { preset: a.preset, ...(own && !p ? { code: own.code } : {}) }, style: { width: "400px", height: "300px", flexShrink: "0", ...(p?.style ?? {}) } }];
}

/** A preset's tile: in Assets (`a`: click or drag it in) or in the shader chooser (`onPick`). */
function ShaderTile({ a, name, code, title, style, picked, onPick }) {
  const ref = useRef();
  const handle = useRef(null);
  // Played only under the pointer, so it always plays then: it doesn't wait its turn behind the board's.
  const data = (play) => ({ code, uniforms: shaderUniforms(code), time: 2, paused: !play, always: true });
  useEffect(() => {
    const h = BS.attach(ref.current, data(false));
    handle.current = h;
    return () => h.detach();
  }, [code]);
  const play = (on) => handle.current?.update(data(on));
  const hover = { onPointerEnter: () => play(true), onPointerLeave: () => play(false), onFocus: () => play(true), onBlur: () => play(false) };
  const art = html`<span class="art"><canvas ref=${ref} style=${{ ...CANVAS_STYLE, ...(style ?? {}) }}></canvas>${picked && html`<span class="tick"><${Icon} n="check" s=${11} /></span>`}</span><span class="nm">${name}</span>`;
  if (onPick) return html`<button class="bd-shpick-tile ${picked ? "on" : ""}" data-shader-pick=${a.preset} aria-pressed=${Boolean(picked)} title=${title} ...${hover} onClick=${onPick}>${art}</button>`;
  return html`<button class="bd-asset shader" data-shader-tile=${a.preset} title=${`${name}: ${title} Click to add it, or drag it onto the canvas.`} draggable="true" ...${hover}
    onDragStart=${(e) => {
      e.dataTransfer.setData("text/x-board-asset", JSON.stringify(a));
      e.dataTransfer.effectAllowed = "copy";
    }}
    onClick=${() => import("./board-assets.js").then((m) => m.addAsset(a))}>${art}</button>`;
}

export function ShaderAssets() {
  const b = useBoard(CANVAS_ONLY);
  const own = b.board.shaders ?? [];
  return html`<${Section} title="Shaders" count=${SHADER_PRESETS.length + own.length} collapsible id="bd-a-shaders">
    <p class="bd-note">Live graphics drawn by the GPU. With a frame selected, a click makes one its fill.</p>
    <div class="bd-asset-grid shaders">
      ${SHADER_PRESETS.map((p) => html`<${ShaderTile} key=${p.id} a=${{ kind: "shader", preset: p.id }} name=${p.name} code=${p.code} title=${p.blurb} style=${p.style} />`)}
      ${own.map((s) => html`<${ShaderTile} key=${"own:" + s.name} a=${{ kind: "shader", preset: s.name }} name=${shaderLabel(s.name)} code=${s.code} title="This board's own preset." />`)}
    </div>
  <//>`;
}

// ---------------------------------------------------------------------------------------------
// The shader in the panel's Fill section: a row naming it (a click chooses another), its colours
// under it, and its settings (the rest of its controls, motion, blend and code) in a popover.

const fmt = (p) => (v) => (p.glsl === "int" || p.step >= 1 ? String(Math.round(v)) : String(round(v, p.step < 0.01 ? 3 : 2))) + (p.px ? " px" : "");

/** Where a frame is on the canvas: what a popover that changes it shouldn't cover. */
const frameEl = (id) => document.querySelector(`.bd-canvas [data-bid="${id}"]`);

/** Code to start from for a shader of one's own: two colours drifting. */
const STARTER = `// Your own shader (GLSL). It's given uTime (seconds), uRes (its size in pixels) and uPx.
uniform vec3 uColorA; // @color = #4c8dff "Colour 1"
uniform vec3 uColorB; // @color = #ff5ab4 "Colour 2"
uniform float uScale; // @param 0.5..6 = 2.5 "Scale"
void main() {
  vec2 uv = gl_FragCoord.xy / uRes;
  float t = 0.5 + 0.5 * sin(uTime * 0.6 + (uv.x * 1.3 + uv.y) * uScale);
  gl_FragColor = vec4(mix(uColorA, uColorB, t), 1.0);
}
`;

/** Which of the chooser's tiles a frame's shader is: a preset (built in or the board's own), or "custom". */
function currentOf(spec, own) {
  if (!spec) return null;
  return spec.preset && (presetOf(spec.preset) || own.some((s) => s.name === spec.preset)) ? spec.preset : "custom";
}

/** Steps that give a frame the shader `v` (a preset, or "custom"): another preset starts from its own defaults; motion and still stay. */
export function shaderFillOps(n, v) {
  return pickOps(n, v, B.board.shaders ?? []);
}

function pickOps(n, v, own) {
  const spec = n.shader;
  if (v === "custom") return [{ op: "set", id: n.id, shader: cleanShaderSpec({ ...(spec ?? {}), preset: undefined, code: (spec && shaderCode(spec, own)) || STARTER }) }];
  const p = presetOf(v);
  const mine = own.find((s) => s.name === v);
  const ops = [{ op: "set", id: n.id, shader: cleanShaderSpec({ preset: v, speed: spec?.speed, time: spec?.time, paused: spec?.paused, blend: p?.blend, ...(mine && !p ? { code: mine.code } : {}) }) }];
  // A frame named for its shader is named for the new one.
  const was = spec ? presetOf(spec.preset)?.name ?? (spec.preset ? shaderLabel(spec.preset) : "Shader") : null;
  if (was && (n.name === was || n.name === "Shader")) ops.push({ op: "set", id: n.id, name: p?.name ?? shaderLabel(v) });
  return ops;
}

/** The shader chooser: every preset's still (playing under the pointer), a search, and code of one's own. Picking keeps it open, to try another. */
export function ShaderChooser({ id, anchor, onClose, commit }) {
  useBoard(CANVAS_ONLY);
  const [q, setQ] = useState("");
  const n = node(id);
  if (!n) return null;
  const own = B.board.shaders ?? [];
  const current = currentOf(n.shader, own);
  const items = [
    ...SHADER_PRESETS.map((p) => ({ key: p.id, name: p.name, code: p.code, title: p.blurb, style: p.style })),
    ...own.map((s) => ({ key: s.name, name: shaderLabel(s.name), code: s.code, title: "This board's own preset." })),
  ];
  const words = q.trim().toLowerCase();
  const shown = words ? items.filter((it) => `${it.name} ${it.title}`.toLowerCase().includes(words)) : items;
  const pick = (v) => v !== current && commit(pickOps(n, v, own), { key: `shader:${id}:pick`, label: n.shader ? "Change shader" : "Shader fill" });
  const ownCode = !words || "your own code glsl custom".includes(words);
  return html`<${Popover} anchor=${anchor} onClose=${onClose} width=${312} align="end" avoid=${frameEl(id)} class="bd-shpick-pop">
    <div class="bd-shpick" data-shader-chooser>
      <div class="bd-shpick-head"><b>Choose shader</b><button class="icon-btn sm" title="Close" aria-label="Close" onClick=${onClose}><${Icon} n="x" s=${13} /></button></div>
      <label class="bd-shpick-search"><${Icon} n="search" s=${13} /><input class="input" placeholder="Search…" value=${q} autoFocus onInput=${(e) => setQ(e.target.value)} onKeyDown=${(e) => (e.stopPropagation(), e.key === "Escape" && (q ? setQ("") : onClose()))} /></label>
      <div class="bd-shpick-grid">
        ${shown.map((it) => html`<${ShaderTile} key=${it.key} a=${{ preset: it.key }} name=${it.name} code=${it.code} title=${it.title} style=${it.style} picked=${current === it.key} onPick=${() => pick(it.key)} />`)}
        ${ownCode &&
        html`<button class="bd-shpick-tile code ${current === "custom" ? "on" : ""}" data-shader-pick="custom" aria-pressed=${current === "custom"} title="Write the shader yourself, in GLSL" onClick=${() => pick("custom")}>
          <span class="art"><${Icon} n="code" s=${20} />${current === "custom" && html`<span class="tick"><${Icon} n="check" s=${11} /></span>`}</span><span class="nm">Your own code</span>
        </button>`}
      </div>
      ${!shown.length && !ownCode && html`<p class="bd-note">No shader is called “${q.trim()}”.</p>`}
    </div>
  <//>`;
}

/** A shader's still, small: the swatch of its row in the panel (its colours drawn through the board's tokens). */
function ShaderSwatch({ code, uniforms, time }) {
  const ref = useRef();
  const handle = useRef(null);
  const resolved = Object.fromEntries(Object.entries(uniforms).map(([k, v]) => [k, typeof v === "string" ? resolveVars(v, B.board.tokens).trim() || v : v]));
  const data = { code, uniforms: resolved, time, paused: true };
  const key = JSON.stringify(data);
  useEffect(() => {
    const h = BS.attach(ref.current, data);
    handle.current = h;
    return () => h.detach();
  }, []);
  useEffect(() => handle.current?.update(data), [key]);
  return html`<span class="bd-swatch shader"><canvas ref=${ref} style=${CANVAS_STYLE}></canvas></span>`;
}

/** The shader a frame has, and what can be changed about it. */
function useShader(id) {
  const n = node(id);
  const spec = n?.shader ?? {};
  const own = B.board.shaders ?? [];
  const mine = spec.preset ? own.find((s) => s.name === spec.preset) : null;
  const builtin = !mine && presetOf(spec.preset);
  const code = shaderCode(spec, own) ?? "";
  const { params } = parseShaderParams(code);
  return { n, spec, own, mine, builtin, code, params, values: shaderValues(params, spec.params) };
}

/**
 * A frame's shader in its Fill section. `Color` and `commit` are the panel's own: colour fields
 * with the board's tokens, and a commit that takes a token made in one along. `onChoose(anchor)`
 * opens the chooser.
 */
export function ShaderFill({ id, Color, commit, onChoose }) {
  const st = useShaderState(id);
  const row = useRef();
  const gear = useRef();
  const [open, setOpen] = useState(false);
  const sh = useShader(id);
  const { n, spec, mine, builtin, code, params, values } = sh;
  if (!n?.shader) return null;
  const set = (next, key, label = "Shader") => commit([{ op: "set", id, shader: cleanShaderSpec(next) }], { key: key ? `shader:${id}:${key}` : null, label });
  const setParam = (p, v, key) => {
    const next = { ...(spec.params ?? {}) };
    if (v === null || v === undefined) delete next[p.key];
    else next[p.key] = v;
    set({ ...spec, params: next }, key ?? p.key);
  };
  const label = builtin ? builtin.name : mine ? shaderLabel(mine.name) : "Your own code";
  const status = statusOf(st, spec);
  return html`<div class="bd-shfill" data-shader-fill>
    <div class="bd-prow">
      <button class="bd-prow-main" ref=${row} data-shader-choose title="Choose another shader" onClick=${() => onChoose(row.current)}>
        <${ShaderSwatch} code=${code} uniforms=${shaderUniforms(code, spec.params)} time=${spec.time ?? 0} />
        <span class="lbl">${label}</span>
        <${Icon} n="down" s=${12} class="bd-shfill-chev" />
      </button>
      <button class="bd-shfill-tune ${open ? "on" : ""}" ref=${gear} data-shader-settings title="Shader settings: its controls, motion, blend and code" aria-label="Shader settings" aria-expanded=${open} onClick=${() => setOpen(!open)}><${Icon} n="tune" s=${18} /></button>
      <button class="icon-btn sm" data-shader-remove title="Remove the shader" aria-label="Remove the shader" onClick=${() => commit([{ op: "set", id, shader: null }], { label: "Remove shader" })}><${Icon} n="minus" s=${14} /></button>
    </div>
    ${status && html`<p class="bd-sh-status ${status.tone}" data-shader-status=${st?.kind}>${status.text}${st?.kind === "slow" && html` <button class="bd-link" onClick=${() => handles.get(id)?.retry()}>Try again</button>`}</p>`}
    ${params.filter((p) => p.kind === "color").map((p) => html`<${Param} key=${p.key} p=${p} value=${values[p.key]} own=${spec.params?.[p.key]} Color=${Color} onChange=${(v, key) => setParam(p, v, key)} />`)}
    ${open && html`<${ShaderSettings} id=${id} sh=${sh} st=${st} anchor=${gear.current} set=${set} setParam=${setParam} commit=${commit} Color=${Color} onClose=${() => setOpen(false)} />`}
  </div>`;
}

/** A frame's shader settings, in a popover: its other controls, motion, blend, and its code. */
function ShaderSettings({ id, sh, st, anchor, set, setParam, commit, Color, onClose }) {
  const [saving, setSaving] = useState(null);
  const { n, spec, mine, builtin, code, params, values } = sh;
  const playing = !spec.paused;
  const play = () => {
    if (st?.kind === "slow") return handles.get(id)?.retry();
    set({ ...spec, paused: !spec.paused || null }, null, spec.paused ? "Play shader" : "Pause shader");
  };
  const controls = params.filter((p) => p.kind !== "color");
  const blends = SHADER_BLENDS.map((b) => ({ value: b, label: shaderLabel(b) }));
  return html`<${Popover} anchor=${anchor} onClose=${onClose} width=${300} align="end" avoid=${frameEl(id)} class="bd-shset-pop">
    <div class="bd-pop-edit bd-shset" data-shader-settings-pop>
      <div class="bd-shpick-head"><b>Shader settings</b>
        <button class="icon-btn sm" data-shader-play title=${st?.kind === "slow" ? "Try playing it again" : playing ? "Pause: show its still" : "Play"} aria-label=${playing && st?.kind !== "slow" ? "Pause" : "Play"} onClick=${play}><${Icon} n=${playing && st?.kind !== "slow" ? "pause" : "play"} s=${13} /></button>
        <button class="icon-btn sm" title="Close" aria-label="Close" onClick=${onClose}><${Icon} n="x" s=${13} /></button>
      </div>
      ${controls.map((p) => html`<${Param} key=${p.key} p=${p} value=${values[p.key]} own=${spec.params?.[p.key]} Color=${Color} onChange=${(v, key) => setParam(p, v, key)} />`)}
      <div class="row"><label>Speed</label><${Slider} value=${spec.speed ?? 1} min=${0} max=${3} step=${0.05} reset=${1} format=${(v) => `${round(v, 2)}×`} onChange=${(v) => set({ ...spec, speed: v ?? 1 }, "speed")} /></div>
      <div class="row"><label title="The moment pictures of the board show, and the canvas while paused">Still at</label>
        <div class="bd-sh-still">
          <${Num} value=${spec.time ?? 0} step=${0.1} digits=${1} min=${0} max=${100000} unit="s" title="Seconds into its motion" onChange=${(v) => set({ ...spec, time: v ?? 0 }, "time")} />
          <button class="btn sm" title="Keep the moment showing now as its still" onClick=${() => set({ ...spec, time: Math.max(0, round(handles.get(id)?.shown() ?? spec.time ?? 0, 1)) }, null, "Shader still")}>Now</button>
        </div>
      </div>
      <div class="row"><label title="How it mixes with the frame's fills under it">Blend</label><${Dropdown} value=${spec.blend ?? "normal"} options=${blends} onChange=${(v) => set({ ...spec, blend: v === "normal" ? undefined : v }, null, "Shader blend")} title="How it mixes with the frame's fills under it" /></div>
      ${!builtin && html`<${CodeField} key=${id + ":" + (mine ? mine.name : "")} code=${code} preset=${mine?.name} users=${mine ? shaderUsers(B.board, mine.name).length : 0}
        onCommit=${(next) => (mine ? commit([{ op: "shaderPreset", name: mine.name, code: next }], { label: "Shader code" }) : set({ ...spec, code: next }, null, "Shader code"))} />`}
      ${saving !== null &&
      html`<form class="bd-sh-save" onSubmit=${(e) => {
        e.preventDefault();
        const name = shaderPresetName(saving);
        if (!name) return;
        if (commit(saveShaderPresetOps(B.board, id, name), { label: "Save shader preset" }) !== false) toast({ kind: "ok", icon: "check", title: `Saved as “${shaderLabel(name)}”`, text: "Choose it again from any frame's shaders, or Assets › Shaders.", timeout: 4000 });
        setSaving(null);
      }}>
        <input class="input" autoFocus placeholder="Preset name" value=${saving} onInput=${(e) => setSaving(e.target.value)} onKeyDown=${(e) => (e.stopPropagation(), e.key === "Escape" && setSaving(null))} />
        <button class="btn sm primary" type="submit">Save</button>
      </form>`}
      <div class="bd-sh-actions">
        ${builtin && html`<button class="btn sm" title="Its GLSL, to change as your own" onClick=${() => set({ ...spec, preset: undefined, code }, null, "Edit shader code")}><${Icon} n="code" s=${13} />Edit code</button>`}
        ${!builtin && !mine && saving === null && html`<button class="btn sm" title="Keep it on this board, to choose again" onClick=${() => setSaving(n.name === "Shader" || n.name === "Frame" ? "" : n.name)}><${Icon} n="plus" s=${13} />Save as preset</button>`}
        ${spec.params && Object.keys(spec.params).length > 0 && html`<button class="btn ghost sm" title="Every control back to its default" onClick=${() => set({ ...spec, params: undefined }, null, "Reset shader")}>Reset</button>`}
      </div>
    </div>
  <//>`;
}

/** What the panel says about how a shader is drawing, when there's something to say. */
function statusOf(st, spec) {
  if (!st) return null;
  if (st.kind === "error") return { tone: "bad", text: `It doesn't compile${st.errors?.[0]?.line ? ` (line ${st.errors[0].line})` : ""}, so the canvas shows its error.` };
  if (st.kind === "slow") return { tone: "warn", text: `Too slow to play here${st.ms ? ` (about ${Math.round(st.ms)} ms a frame)` : ""}, so it shows its still.` };
  if (st.kind === "reduced") return { tone: "", text: "Reduce Motion is on, so shaders show their stills." };
  if (st.kind === "nogl") return { tone: "bad", text: "WebGL is off here, so shaders can't draw." };
  if (st.kind === "paused" && spec.paused) return { tone: "", text: `Paused at its still (${round(spec.time ?? 0, 1)} s).` };
  return null;
}

/** One parameter's control: a slider, a colour (with the board's tokens) or its words. */
function Param({ p, value, own, Color, onChange }) {
  if (p.kind === "color")
    return html`<div class="row" data-param=${p.key}><label title=${p.uniform}>${p.label}</label><${Color} value=${own ?? p.default} allowAuto=${false} onChange=${(c) => onChange(c ?? null, p.key)} /></div>`;
  if (p.kind === "choice") {
    const opts = (p.options ?? []).map((o) => ({ value: o, label: shaderLabel(o) }));
    return html`<div class="row" data-param=${p.key}><label title=${p.uniform}>${p.label}</label>${opts.length <= 3 ? html`<${Seg} value=${value} options=${opts} onChange=${(v) => onChange(v)} />` : html`<${Dropdown} value=${value} options=${opts} onChange=${(v) => onChange(v)} />`}</div>`;
  }
  return html`<div class="row" data-param=${p.key}><label title=${p.uniform}>${p.label}</label><${Slider} value=${value} min=${p.min} max=${p.max} step=${p.step} reset=${p.default} format=${fmt(p)} onChange=${(v) => onChange(v ?? p.default, p.key)} /></div>`;
}

/**
 * A shader's own GLSL: typed here, compiled as it's typed (in the canvas's own context), its
 * errors listed by line (a click goes to the line), applied on ⌘↩ or when the field is left.
 */
function CodeField({ code, onCommit, preset, users }) {
  const [draft, setDraft] = useState(code);
  const [errors, setErrors] = useState(() => BS.compile(code).errors);
  const ta = useRef();
  const gutter = useRef();
  // Changed elsewhere (an agent, undo): shown, unless it's being typed in.
  useEffect(() => {
    if (document.activeElement === ta.current) return;
    setDraft(code);
  }, [code]);
  useEffect(() => {
    const t = setTimeout(() => setErrors(BS.compile(draft).errors), 250);
    return () => clearTimeout(t);
  }, [draft]);
  const done = () => draft !== code && onCommit(draft);
  const goTo = (line) => {
    const el = ta.current;
    const lines = draft.split("\n");
    const start = lines.slice(0, line - 1).reduce((a, l) => a + l.length + 1, 0);
    el.focus();
    el.setSelectionRange(start, start + (lines[line - 1] ?? "").length);
    el.scrollTop = Math.max(0, (line - 4) * 16);
  };
  const count = draft.split("\n").length;
  const bad = new Set(errors.map((e) => e.line).filter(Boolean));
  return html`<div class="bd-code ${errors.length ? "bad" : ""}">
    <div class="bd-sh-sub">Code${preset ? html` <span class="bd-sh-tag">${shaderLabel(preset)}</span>` : ""}</div>
    <div class="bd-code-box" style=${{ height: `${Math.min(300, Math.max(120, count * 16 + 18))}px` }}>
      <pre class="gutter" ref=${gutter} aria-hidden="true">${Array.from({ length: count }, (_, i) => html`<span class=${bad.has(i + 1) ? "bad" : ""}>${i + 1}</span>`)}</pre>
      <textarea ref=${ta} spellcheck=${false} autocomplete="off" autocapitalize="off" value=${draft} aria-label="Shader code (GLSL)"
        onInput=${(e) => setDraft(e.target.value)} onBlur=${done}
        onScroll=${(e) => gutter.current && (gutter.current.scrollTop = e.target.scrollTop)}
        onKeyDown=${(e) => {
          e.stopPropagation();
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            done();
          } else if (e.key === "Tab" && !e.shiftKey) {
            e.preventDefault();
            document.execCommand("insertText", false, "  ");
          } else if (e.key === "Escape") {
            setDraft(code);
            e.target.blur();
          }
        }}></textarea>
    </div>
    ${errors.length
      ? html`<div class="bd-code-errors" role="list">${errors.slice(0, 6).map((er) => html`<button role="listitem" class="bd-code-err" onClick=${() => er.line && goTo(er.line)}><b>${er.line ? `Line ${er.line}` : "Error"}</b><span>${er.message}</span></button>`)}</div>`
      : html`<p class="bd-code-ok"><${Icon} n="check" s=${12} />Compiles${draft !== code ? " · ⌘↩ applies it" : ""}</p>`}
    ${users > 1 && html`<p class="bd-note">The board's preset: a change here changes all ${users} layers using it.</p>`}
    <p class="bd-note">GLSL, given <code>uTime</code>, <code>uRes</code> and <code>uPx</code>. A uniform with <code>// @param 0..1 = 0.5</code>, <code>// @color = #ff5a1f</code> or <code>// @choice a|b</code> gets a control.</p>
  </div>`;
}
