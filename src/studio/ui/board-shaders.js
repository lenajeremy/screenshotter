// Shaders on a board, in the Studio: the layer on the canvas, the Shader section of the panel and
// the Shaders in Assets. The drawing is the runtime's (board-shader-runtime.js: one WebGL context
// for every shader on the page, the same script Preview, pages copied out and pictures of the
// board carry); the model is the engine's (src/board/shaders.ts, through board-core.js).
//
// Nothing here redraws per frame: a layer's component hands its canvas to the runtime once, and
// again only when its shader, the board's tokens or the board's own presets change. The runtime
// plays it from there.
import "./board-shader-runtime.js";
import { useEffect, useRef, useState } from "preact/hooks";
import { SHADER_PRESETS, cleanShaderSpec, newId, nodeHtml, parseShaderParams, presetOf, round, saveShaderPresetOps, shaderCode, shaderLabel, shaderPresetName, shaderUniforms, shaderUsers, shaderValues, subtree } from "./board-core.js";
import { B, CANVAS_ONLY, node, onBoard, useBoard } from "./board-state.js";
import { Dropdown, Num, Section, Seg, Slider, html } from "./controls.js";
import { Icon } from "./icons.js";
import { toast } from "./store.js";

const BS = globalThis.BoardShaders;

// ---------------------------------------------------------------------------------------------
// The runtime, told about the canvas: its zoom, and when the view (or a layer's size) is moving.

/** Each shader layer's state as the runtime last said it (playing, paused, error, too slow…), by id. */
const states = new Map();
const stateListeners = new Set();
/** The runtime's handle on each shader layer drawn on the canvas, by id. */
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
  onState: (canvas, st) => {
    const id = canvas.dataset.layer;
    if (!id) return;
    states.set(id, st);
    for (const l of stateListeners) l(id);
    if (st.kind === "slow" && !toldSlow.has(id)) {
      toldSlow.add(id);
      toast({ kind: "info", icon: "alert", title: "A shader was too slow to play", text: `“${node(id)?.name ?? "Shader"}” shows its still here. A smaller or lighter one plays; press play in its panel to try again.`, timeout: 8000 });
    }
  },
});
// The runtime sleeps when nothing plays; a change to the board (the view moving, above all) wakes
// it, to redraw stills at the new zoom.
onBoard(() => BS.wake());

/** A shader layer's state, kept up to date: { kind: "playing" | "paused" | "reduced" | "slow" | "error" | "nogl", ms, errors }. */
export function useShaderState(id) {
  const [, force] = useState(0);
  useEffect(() => {
    const l = (x) => x === id && force((k) => k + 1);
    stateListeners.add(l);
    return () => stateListeners.delete(l);
  }, [id]);
  return states.get(id) ?? null;
}

/** What the runtime draws a layer with: its code, uniforms (tokens left for it to resolve), speed, still and pause. */
function layerData(board, n) {
  const spec = n.shader ?? {};
  const code = shaderCode(spec, board.shaders) ?? "";
  return { code, uniforms: shaderUniforms(code, spec.params), speed: spec.speed ?? 1, time: spec.time ?? 0, paused: Boolean(spec.paused) };
}

const CANVAS_STYLE = { display: "block", width: "100%", height: "100%", borderRadius: "inherit" };

/**
 * A shader layer on the canvas: a box (its CSS, like any layer) holding the canvas the runtime
 * draws in. It follows the board's tokens and presets, which its layer object doesn't change with.
 */
export function ShaderLayer({ n, attrs }) {
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
  return html`<div ...${attrs}><canvas ref=${ref} data-layer=${n.id} style=${CANVAS_STYLE}></canvas></div>`;
}

// ---------------------------------------------------------------------------------------------
// Assets: a live tile for each preset (and each of the board's own), to click or drag on.

let runtimeText = "";
fetch(new URL("./board-shader-runtime.js", import.meta.url))
  .then((r) => (r.ok ? r.text() : ""))
  .then((t) => (runtimeText = t))
  .catch(() => undefined);

/** Layers as HTML for a page of their own (Copy as HTML): with shaders, the runtime goes first, and each carries its code. */
export function pageHtml(board, ids) {
  const shaders = ids.some((id) => subtree(board, id).some((x) => board.nodes[x]?.type === "shader"));
  const body = ids.map((id) => nodeHtml(board, id, shaders ? { code: true } : {})).join("\n");
  if (!shaders || !runtimeText) return body;
  return `<script data-board-shaders>${runtimeText.replace(/<\/script/gi, "<\\/script")}\nBoardShaders.auto();</script>\n${body}`;
}

/** The layer an asset tile adds: a shader of that preset, 400 × 300 (one of the board's own carries its code too). */
export function shaderAssetLayers(a) {
  const p = presetOf(a.preset);
  const own = B.board.shaders?.find((s) => s.name === a.preset);
  return [{ id: newId(), type: "shader", name: p?.name ?? shaderLabel(a.preset), parent: null, shader: { preset: a.preset, ...(own && !p ? { code: own.code } : {}) }, style: { width: "400px", height: "300px", flexShrink: "0", ...(p?.style ?? {}) } }];
}

/**
 * A preset's tile: its still, playing only while the pointer (or the keyboard) is on it. Ten tiles
 * playing at once kept the GPU busy, and the whole board choppy, for as long as Assets was open.
 */
function ShaderTile({ a, name, code, title, style }) {
  const ref = useRef();
  const handle = useRef(null);
  const data = (play) => ({ code, uniforms: shaderUniforms(code), time: 2, paused: !play });
  useEffect(() => {
    const h = BS.attach(ref.current, data(false));
    handle.current = h;
    return () => h.detach();
  }, [code]);
  const play = (on) => handle.current?.update(data(on));
  return html`<button class="bd-asset shader" data-shader-tile=${a.preset} title=${`${name}: ${title} Click to add it, or drag it onto the canvas.`} draggable="true"
    onPointerEnter=${() => play(true)} onPointerLeave=${() => play(false)} onFocus=${() => play(true)} onBlur=${() => play(false)}
    onDragStart=${(e) => {
      e.dataTransfer.setData("text/x-board-asset", JSON.stringify(a));
      e.dataTransfer.effectAllowed = "copy";
    }}
    onClick=${() => import("./board-assets.js").then((m) => m.addAsset(a))}>
    <span class="art"><canvas ref=${ref} style=${{ ...CANVAS_STYLE, ...(style ?? {}) }}></canvas></span><span class="nm">${name}</span>
  </button>`;
}

export function ShaderAssets() {
  const b = useBoard(CANVAS_ONLY);
  const own = b.board.shaders ?? [];
  return html`<${Section} title="Shaders" count=${SHADER_PRESETS.length + own.length} collapsible id="bd-a-shaders">
    <p class="bd-note">Live graphics drawn by the GPU. They play on the canvas and in Preview; pictures show each at its still.</p>
    <div class="bd-asset-grid shaders">
      ${SHADER_PRESETS.map((p) => html`<${ShaderTile} key=${p.id} a=${{ kind: "shader", preset: p.id }} name=${p.name} code=${p.code} title=${p.blurb} style=${p.style} />`)}
      ${own.map((s) => html`<${ShaderTile} key=${"own:" + s.name} a=${{ kind: "shader", preset: s.name }} name=${shaderLabel(s.name)} code=${s.code} title="This board's own preset." />`)}
    </div>
  <//>`;
}

// ---------------------------------------------------------------------------------------------
// The panel's Shader section: a preset, a control for each parameter, motion, and code.

const fmt = (p) => (v) => (p.glsl === "int" || p.step >= 1 ? String(Math.round(v)) : String(round(v, p.step < 0.01 ? 3 : 2))) + (p.px ? " px" : "");

/** `Color` and `commit` are the panel's own: colour fields with the board's tokens, and a commit that takes a token made in one along. */
export function ShaderSection({ Color, commit }) {
  const id = B.sel[0];
  const n = node(id);
  const st = useShaderState(id);
  const [saving, setSaving] = useState(null);
  if (!n || n.type !== "shader") return null;
  const spec = n.shader ?? {};
  const own = B.board.shaders ?? [];
  const mine = spec.preset ? own.find((s) => s.name === spec.preset) : null;
  const builtin = !mine && presetOf(spec.preset);
  const code = shaderCode(spec, own) ?? "";
  const { params } = parseShaderParams(code);
  const values = shaderValues(params, spec.params);
  const set = (next, key, label = "Shader") => commit([{ op: "set", id, shader: cleanShaderSpec(next) }], { key: key ? `shader:${id}:${key}` : null, label });
  const setParam = (p, v, key) => {
    const next = { ...(spec.params ?? {}) };
    if (v === null || v === undefined) delete next[p.key];
    else next[p.key] = v;
    set({ ...spec, params: next }, key ?? p.key);
  };
  const current = mine || builtin ? spec.preset : "custom";
  const options = [
    ...SHADER_PRESETS.map((p) => ({ value: p.id, label: p.name, group: "Presets" })),
    ...own.map((s) => ({ value: s.name, label: shaderLabel(s.name), group: "This board's" })),
    { value: "custom", label: "Your own code", group: "Code" },
  ];
  const pick = (v) => {
    if (v === current) return;
    if (v === "custom") return set({ ...spec, preset: undefined, code }, null, "Edit shader code");
    // Another preset starts from its own defaults; motion and still stay.
    const ops = [{ op: "set", id, shader: cleanShaderSpec({ preset: v, speed: spec.speed, time: spec.time, paused: spec.paused, ...(own.some((s) => s.name === v) ? { code: own.find((s) => s.name === v).code } : {}) }) }];
    const was = presetOf(spec.preset)?.name ?? (spec.preset ? shaderLabel(spec.preset) : "Shader");
    if (n.name === was || n.name === "Shader") ops.push({ op: "set", id, name: presetOf(v)?.name ?? shaderLabel(v) });
    commit(ops, { label: "Shader preset" });
  };
  const playing = !spec.paused;
  const play = () => {
    if (st?.kind === "slow") return handles.get(id)?.retry();
    set({ ...spec, paused: !spec.paused || null }, null, spec.paused ? "Play shader" : "Pause shader");
  };
  const status = statusOf(st, spec);
  return html`<${Section} title="Shader" right=${html`<button class="icon-btn sm" data-shader-play title=${st?.kind === "slow" ? "Try playing it again" : playing ? "Pause: show its still" : "Play"} aria-label=${playing && st?.kind !== "slow" ? "Pause" : "Play"} onClick=${play}><${Icon} n=${playing && st?.kind !== "slow" ? "pause" : "play"} s=${13} /></button>`}>
    <div class="row"><label>Preset</label><${Dropdown} value=${current} options=${options} onChange=${pick} title="Which shader" /></div>
    ${status && html`<p class="bd-sh-status ${status.tone}" data-shader-status=${st?.kind}>${status.text}${st?.kind === "slow" && html` <button class="bd-link" onClick=${() => handles.get(id)?.retry()}>Try again</button>`}</p>`}
    ${params.map((p) => html`<${Param} key=${p.key} p=${p} value=${values[p.key]} own=${spec.params?.[p.key]} Color=${Color} onChange=${(v, key) => setParam(p, v, key)} />`)}
    <div class="bd-sh-sub">Motion</div>
    <div class="row"><label>Speed</label><${Slider} value=${spec.speed ?? 1} min=${0} max=${3} step=${0.05} reset=${1} format=${(v) => `${round(v, 2)}×`} onChange=${(v) => set({ ...spec, speed: v ?? 1 }, "speed")} /></div>
    <div class="row"><label title="The moment pictures of the board show, and the canvas while paused">Still at</label>
      <div class="bd-sh-still">
        <${Num} value=${spec.time ?? 0} step=${0.1} digits=${1} min=${0} max=${100000} unit="s" title="Seconds into its motion" onChange=${(v) => set({ ...spec, time: v ?? 0 }, "time")} />
        <button class="btn sm" title="Keep the moment showing now as its still" onClick=${() => set({ ...spec, time: Math.max(0, round(handles.get(id)?.shown() ?? spec.time ?? 0, 1)) }, null, "Shader still")}>Now</button>
      </div>
    </div>
    ${!builtin && html`<${CodeField} key=${id + ":" + (mine ? mine.name : "")} code=${code} preset=${mine?.name} users=${mine ? shaderUsers(B.board, mine.name).length : 0}
      onCommit=${(next) => (mine ? commit([{ op: "shaderPreset", name: mine.name, code: next }], { label: "Shader code" }) : set({ ...spec, code: next }, null, "Shader code"))} />`}
    ${saving !== null &&
    html`<form class="bd-sh-save" onSubmit=${(e) => {
      e.preventDefault();
      const name = shaderPresetName(saving);
      if (!name) return;
      if (commit(saveShaderPresetOps(B.board, id, name), { label: "Save shader preset" }) !== false) toast({ kind: "ok", icon: "check", title: `Saved as “${shaderLabel(name)}”`, text: "Place it again from Assets › Shaders.", timeout: 4000 });
      setSaving(null);
    }}>
      <input class="input" autoFocus placeholder="Preset name" value=${saving} onInput=${(e) => setSaving(e.target.value)} onKeyDown=${(e) => (e.stopPropagation(), e.key === "Escape" && setSaving(null))} />
      <button class="btn sm primary" type="submit">Save</button>
    </form>`}
    <div class="bd-sh-actions">
      ${builtin && html`<button class="btn sm" title="Its GLSL, to change as your own" onClick=${() => set({ ...spec, preset: undefined, code }, null, "Edit shader code")}><${Icon} n="code" s=${13} />Edit code</button>`}
      ${!builtin && !mine && saving === null && html`<button class="btn sm" title="Keep it on this board, to place again from Assets" onClick=${() => setSaving(n.name === "Shader" ? "" : n.name)}><${Icon} n="plus" s=${13} />Save as preset</button>`}
      ${spec.params && Object.keys(spec.params).length > 0 && html`<button class="btn ghost sm" title="Every parameter back to its default" onClick=${() => set({ ...spec, params: undefined }, null, "Reset shader")}>Reset</button>`}
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
