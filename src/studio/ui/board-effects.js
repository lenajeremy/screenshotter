// Optical & layer effects UI and canvas integration (Figma-style Liquid Glass, Pattern refraction,
// Lens distortion, Warp, Moving blobs, Slice shift, Pixel stretch, Pixelate, Gooey merge, Bloom,
// Bokeh blur, Gradient map, Color adjust, CRT screen, Outlines and Chromatic metal).
import "./board-effects-runtime.js";
import { useEffect, useRef, useState } from "preact/hooks";
import { EFFECT_CATEGORIES, EFFECT_DEFS, cleanEffects, defaultEffect, effectDefOf, newId, round } from "./board-core.js";
import { B, CANVAS_ONLY, node, useBoard } from "./board-state.js";
import { Dropdown, Num, Popover, Section, Seg, Slider, html } from "./controls.js";
import { Icon } from "./icons.js";

const BE = globalThis.BoardEffects;
const frameEl = (id) => document.querySelector(`.bd-canvas [data-bid="${id}"]`);

// ---------------------------------------------------------------------------------------------
// Canvas element hook: attaches/updates/detaches BoardEffects on any mounted layer with effects.

const activeHandles = new WeakMap();

export function syncElementEffects(el, n, board) {
  if (!el) return;
  const existing = activeHandles.get(el);
  const fx = n?.effects;
  if (!fx?.length || !BE) {
    if (existing) {
      existing.detach();
      activeHandles.delete(el);
    }
    return;
  }
  const tokenKey = board?.tokens?.map((t) => `${t.name}=${t.value}`).join("|") ?? "";
  const st = n.style || {};
  const styleHint = `${st.width || ""}|${st.height || ""}|${st.borderRadius || ""}|${st.borderTopLeftRadius || ""}|${st.borderTopRightRadius || ""}|${st.borderBottomRightRadius || ""}|${st.borderBottomLeftRadius || ""}`;
  const opts = {
    baseBackdropFilter: st.backdropFilter ?? st.WebkitBackdropFilter ?? "",
    baseFilter: st.filter ?? "",
    tokenKey,
    styleHint,
  };
  if (existing) existing.update(fx, opts);
  else activeHandles.set(el, BE.attach(el, fx, opts));
}

export function detachElementEffects(el) {
  if (!el) return;
  const existing = activeHandles.get(el);
  if (existing) {
    existing.detach();
    activeHandles.delete(el);
  }
}

// ---------------------------------------------------------------------------------------------
// Interactive 2D Light Direction Pad for Liquid Glass (matches Figma's Light angle + intensity pad)

function LightPad({ angle, intensity, onChange }) {
  const ref = useRef();
  const updateFromPointer = (e, live) => {
    const r = ref.current.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const dx = e.clientX - cx;
    const dy = e.clientY - cy;
    const deg = Math.round((Math.atan2(dy, dx) * 180) / Math.PI);
    const dist = Math.hypot(dx, dy) / (Math.min(r.width, r.height) * 0.45);
    const pct = Math.round(Math.min(100, Math.max(0, dist * 100)));
    onChange({ lightAngle: deg, lightIntensity: pct }, live ? "light" : null);
  };
  const down = (e) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    updateFromPointer(e, true);
    const move = (ev) => updateFromPointer(ev, true);
    const up = (ev) => {
      removeEventListener("pointermove", move);
      removeEventListener("pointerup", up);
      updateFromPointer(ev, false);
    };
    addEventListener("pointermove", move);
    addEventListener("pointerup", up);
  };
  const rad = ((angle ?? -60) * Math.PI) / 180;
  const li = Math.min(100, Math.max(0, intensity ?? 80)) / 100;
  const px = 50 + Math.cos(rad) * li * 36;
  const py = 50 + Math.sin(rad) * li * 36;
  const gradAngle = Math.round((angle ?? -60) + 90);
  return html`<div class="bd-fx-light">
    <span class="bd-fx-light-lbl">Light</span>
    <div class="bd-fx-pad" ref=${ref} onPointerDown=${down} title="Drag to aim the glass rim light angle and intensity"
      style=${{ background: `linear-gradient(${gradAngle}deg, rgba(255,255,255,${(0.28 + li * 0.44).toFixed(2)}) 0%, rgba(160,175,210,0.14) 48%, rgba(10,12,18,0.82) 100%), #1e2029` }}>
      <i class="bd-fx-pad-card"></i>
      <i class="bd-fx-pad-beam" style=${{ left: `${px}%`, top: `${py}%` }}></i>
    </div>
    <div class="bd-fx-light-nums">
      <${Num} label="∠" title="Light angle" value=${Math.round(angle ?? -60)} min=${-180} max=${180} unit="°" onChange=${(v) => v !== undefined && onChange({ lightAngle: v }, "la")} />
      <${Num} label="☀" title="Light intensity" value=${Math.round(intensity ?? 80)} min=${0} max=${100} unit="%" onChange=${(v) => v !== undefined && onChange({ lightIntensity: v }, "li")} />
    </div>
  </div>`;
}

// ---------------------------------------------------------------------------------------------
// Effect Controls Popover (opens when clicking an effect row in the Inspector)

function EffectPopover({ id, index, fx, list, anchor, Color, commit, onClose }) {
  const def = effectDefOf(fx.type);
  if (!def) return null;
  const putAll = (next, key, label = def.name) => {
    const cleaned = cleanEffects(next);
    commit(
      list.map((x) => ({ op: "set", id: x, effects: cleaned ?? null })),
      { key: key ? `fx:${list.join()}:${index}:${key}` : null, label },
    );
  };
  const curList = node(id)?.effects ?? [];
  const patch = (changes, key) => putAll(curList.map((e, j) => (j === index ? { ...e, ...changes } : e)), key);
  const switchType = (nextType) => putAll(curList.map((e, j) => (j === index ? defaultEffect(nextType) : e)), null, "Change effect");

  const otherParams = def.type === "glass" ? def.params.filter((p) => p.key !== "lightAngle" && p.key !== "lightIntensity") : def.params;

  return html`<${Popover} anchor=${anchor} onClose=${onClose} width=${278} align="end" avoid=${frameEl(id)} class="bd-fx-pop">
    <div class="bd-fx-head">
      <${Dropdown} value=${fx.type} options=${EFFECT_DEFS.map((d) => ({ value: d.type, label: d.name }))} onChange=${switchType} />
      <button class="icon-btn sm" title="Close" aria-label="Close" onClick=${onClose}><${Icon} n="x" s=${13} /></button>
    </div>
    <div class="bd-fx-body">
      ${def.switchableTarget &&
      html`<div class="row"><label>Apply to</label><${Seg} value=${fx.target ?? def.defaultTarget} options=${[{ value: "behind", label: "Behind" }, { value: "layer", label: "Layer" }]} onChange=${(t) => patch({ target: t }, null)} /></div>`}
      ${def.type === "glass" &&
      html`<${LightPad} angle=${fx.lightAngle ?? -60} intensity=${fx.lightIntensity ?? 80} onChange=${(c, key) => patch(c, key)} />`}
      ${otherParams.map((p) => {
        const val = fx[p.key] ?? p.default;
        if (p.kind === "color") {
          return html`<div class="row" key=${p.key} data-fx-param=${p.key}>
            <label>${p.label}</label>
            <${Color} value=${val} onChange=${(c, live) => c && patch({ [p.key]: c }, live ? p.key : null)} />
          </div>`;
        }
        if (p.kind === "choice") {
          return html`<div class="row" key=${p.key} data-fx-param=${p.key}>
            <label>${p.label}</label>
            <${Dropdown} value=${val} options=${p.options} onChange=${(v) => patch({ [p.key]: v }, null)} />
          </div>`;
        }
        const fmt = (v) => `${round(v, p.step && p.step < 1 ? 2 : 0)}${p.unit ?? ""}`;
        return html`<div class="row" key=${p.key} data-fx-param=${p.key}>
          <label>${p.label}</label>
          <${Slider} value=${Number(val)} min=${p.min} max=${p.max} step=${p.step ?? 1} reset=${p.default} format=${fmt} onChange=${(v) => patch({ [p.key]: v ?? p.default }, p.key)} />
        </div>`;
      })}
      ${def.type === "glass" && html`<p class="bd-note">Refracts layers behind this frame. Give it a see-through fill (e.g. 15–25% opacity) and rounded corners.</p>`}
      ${def.type === "gooey-merge" && html`<p class="bd-note">Place shapes or text inside this frame to melt them together where they meet.</p>`}
    </div>
  <//>`;
}

// ---------------------------------------------------------------------------------------------
// Effect Chooser Popover (opens from "+")

function EffectChooser({ anchor, onPick, onClose }) {
  const [q, setQ] = useState("");
  const words = q.trim().toLowerCase();
  const filtered = words ? EFFECT_DEFS.filter((d) => `${d.name} ${d.blurb} ${d.type}`.toLowerCase().includes(words)) : EFFECT_DEFS;
  return html`<${Popover} anchor=${anchor} onClose=${onClose} width=${276} align="end" class="bd-fx-pick-pop">
    <div class="bd-shpick-head"><b>Add effect</b><button class="icon-btn sm" title="Close" onClick=${onClose}><${Icon} n="x" s=${13} /></button></div>
    <label class="bd-shpick-search"><${Icon} n="search" s=${13} /><input class="input" placeholder="Search Glass, Bloom, Warp…" value=${q} autoFocus onInput=${(e) => setQ(e.target.value)} onKeyDown=${(e) => (e.stopPropagation(), e.key === "Escape" && (q ? setQ("") : onClose()))} /></label>
    <div class="bd-fx-pick-list">
      ${EFFECT_CATEGORIES.map((cat) => {
        const items = filtered.filter((d) => d.category === cat.id);
        if (!items.length) return null;
        return html`<div class="bd-fx-group" key=${cat.id}>
          <div class="bd-fx-cat">${cat.label}</div>
          ${items.map(
            (d) => html`<button class="bd-fx-item" key=${d.type} data-effect-pick=${d.type} title=${d.blurb} onClick=${() => onPick(d.type)}>
              <span class="bd-fx-dot ${d.type}"></span>
              <span class="bd-fx-inm"><b>${d.name}</b><small>${d.blurb}</small></span>
            </button>`,
          )}
        </div>`;
      })}
      ${!filtered.length && html`<p class="bd-note">No effect matches “${q.trim()}”.</p>`}
    </div>
  <//>`;
}

// ---------------------------------------------------------------------------------------------
// Inspector Section: Effects (Liquid Glass, Pattern refraction, Lens distortion, Bloom, etc.)

function effectSub(fx) {
  if (fx.type === "glass") return `${Math.round(fx.refraction ?? 80)} · ${Math.round(fx.dispersion ?? 50)}`;
  if (fx.type === "pattern-refraction") return `${fx.pattern || "lenticular"} · ${Math.round(fx.strength ?? 55)}`;
  if (fx.type === "lens-distortion") return `${round(fx.distortion ?? 0.5, 2)} · ${fx.mode || "lateral"}`;
  if (fx.type === "warp") return `${fx.style || "ripple"} · ${Math.round(fx.strength ?? 55)}`;
  if (fx.type === "pixelate") return `${Math.round(fx.size ?? 12)}px`;
  if (fx.type === "bloom") return `${Math.round(fx.intensity ?? 95)}%`;
  if (fx.type === "bokeh-blur") return `${round(fx.radius ?? 10, 1)}px`;
  if (fx.type === "gooey-merge") return `${round(fx.blur ?? 10, 1)}px`;
  return fx.target === "behind" ? "Behind" : "Layer";
}

export function EffectsSection({ list, Color, commit }) {
  useBoard(CANVAS_ONLY);
  const addBtn = useRef();
  const rowRefs = useRef({});
  const [choosing, setChoosing] = useState(false);
  const [openIdx, setOpenIdx] = useState(null);
  const id = list[0];
  const n = node(id);
  const effects = n?.effects ?? [];

  useEffect(() => {
    if (openIdx !== null && openIdx >= effects.length) setOpenIdx(null);
  }, [effects.length, id]);

  const setEffects = (next, label = "Effects") => {
    const cleaned = cleanEffects(next);
    commit(
      list.map((x) => ({ op: "set", id: x, effects: cleaned ?? null })),
      { label },
    );
  };

  const addEffect = (type) => {
    const fx = defaultEffect(type);
    const next = [...effects, fx];
    setEffects(next, `Add ${effectDefOf(type)?.name ?? type}`);
    setChoosing(false);
    setTimeout(() => setOpenIdx(next.length - 1), 30);
  };

  const toggleDisabled = (i) => {
    const next = effects.map((e, j) => (j === i ? { ...e, disabled: !e.disabled } : e));
    setEffects(next, effects[i].disabled ? "Show effect" : "Hide effect");
  };

  const removeAt = (i) => {
    if (openIdx === i) setOpenIdx(null);
    setEffects(effects.filter((_, j) => j !== i), "Remove effect");
  };

  return html`<${Section} title="Effects" right=${html`<button class="icon-btn sm ${choosing ? "on" : ""}" ref=${addBtn} data-effect-add title="Add an effect: Liquid Glass, Pattern refraction, Lens distortion, Bloom, Warp and more" onClick=${() => setChoosing(!choosing)}><${Icon} n="plus" s=${14} /></button>`}>
    ${effects.map((fx, i) => {
      const def = effectDefOf(fx.type);
      return html`<div class="bd-prow ${fx.disabled ? "is-off" : ""}" key=${`${fx.type}:${i}`} ref=${(el) => (rowRefs.current[i] = el)}>
        <button class="bd-prow-main" data-effect-row=${fx.type} onClick=${() => setOpenIdx(openIdx === i ? null : i)}>
          <span class="bd-fx-dot ${fx.type}"></span>
          <span class="lbl">${def?.name ?? fx.type}</span>
          <span class="sub">${effectSub(fx)}</span>
        </button>
        <button class="icon-btn sm" title=${fx.disabled ? "Show effect" : "Hide effect"} onClick=${() => toggleDisabled(i)}><${Icon} n=${fx.disabled ? "eyeOff" : "eye"} s=${13} /></button>
        <button class="icon-btn sm" title="Remove effect" onClick=${() => removeAt(i)}><${Icon} n="minus" s=${14} /></button>
      </div>`;
    })}
    ${choosing && html`<${EffectChooser} anchor=${addBtn.current} onPick=${addEffect} onClose=${() => setChoosing(false)} />`}
    ${openIdx !== null && effects[openIdx] && html`<${EffectPopover} id=${id} index=${openIdx} fx=${effects[openIdx]} list=${list} anchor=${rowRefs.current[openIdx] ?? addBtn.current} Color=${Color} commit=${commit} onClose=${() => setOpenIdx(null)} />`}
  <//>`;
}

// ---------------------------------------------------------------------------------------------
// Assets panel quick-drop Liquid Glass & Optical Lens presets

const GLASS_ASSETS = [
  {
    id: "glass-globe",
    name: "Glass lens",
    blurb: "Refractive crystal sphere with rainbow dispersion and directional rim light.",
    w: 240,
    h: 240,
    style: { borderRadius: "999px", background: "rgba(169, 165, 252, 0.22)", overflow: "hidden" },
    effects: [defaultEffect("glass", { refraction: 100, depth: 100, dispersion: 100, frost: 0, splay: 0, lightAngle: -60, lightIntensity: 80 })],
  },
  {
    id: "glass-pill",
    name: "Liquid glass",
    blurb: "Apple/Figma-style frosted liquid glass card ready for text and icons.",
    w: 280,
    h: 96,
    style: { borderRadius: "32px", background: "rgba(255, 255, 255, 0.16)", overflow: "hidden" },
    effects: [defaultEffect("glass", { refraction: 75, depth: 55, dispersion: 40, frost: 14, splay: 15, lightAngle: -55, lightIntensity: 85 })],
  },
  {
    id: "fluted-glass",
    name: "Fluted glass",
    blurb: "Lenticular & ribbed optical glass refracting anything behind it.",
    w: 280,
    h: 200,
    style: { borderRadius: "20px", background: "rgba(255, 255, 255, 0.08)", overflow: "hidden" },
    effects: [defaultEffect("pattern-refraction", { pattern: "waves", strength: 60, smoothness: 12, frost: 4, dispersion: 35, scale: 10, angle: 45 })],
  },
  {
    id: "lens-prism",
    name: "Prism lens",
    blurb: "Fisheye optical distortion with lateral chromatic aberration.",
    w: 240,
    h: 240,
    style: { borderRadius: "28px", background: "rgba(255, 255, 255, 0.04)", overflow: "hidden" },
    effects: [defaultEffect("lens-distortion", { distortion: 0.55, aberration: 0.35, centerX: 50, centerY: 50, mode: "lateral" })],
  },
];

export function glassAssetLayers(a) {
  const g = GLASS_ASSETS.find((x) => x.id === a.id) ?? GLASS_ASSETS[0];
  return [
    {
      id: newId(),
      type: "frame",
      name: g.name,
      parent: null,
      children: [],
      effects: g.effects,
      style: { width: `${g.w}px`, height: `${g.h}px`, flexShrink: "0", ...g.style },
    },
  ];
}

export function GlassAssets() {
  return html`<${Section} title="Glass & lenses" count=${GLASS_ASSETS.length} collapsible id="bd-a-glass">
    <p class="bd-note">Drop over photos, illustrations or UI to refract them live. Tune every optical slider in Effects.</p>
    <div class="bd-asset-grid shaders">
      ${GLASS_ASSETS.map(
        (g) => html`<button class="bd-asset shader" key=${g.id} data-glass-tile=${g.id} title=${`${g.name}: ${g.blurb} Click to add, or drag onto the canvas.`} draggable="true"
          onDragStart=${(e) => {
            e.dataTransfer.setData("text/x-board-asset", JSON.stringify({ kind: "glass-asset", id: g.id }));
            e.dataTransfer.effectAllowed = "copy";
          }}
          onClick=${() => import("./board-assets.js").then((m) => m.addAsset({ kind: "glass-asset", id: g.id }))}>
          <span class="art bd-glass-art ${g.id}"></span>
          <span class="nm">${g.name}</span>
        </button>`,
      )}
    </div>
  <//>`;
}
