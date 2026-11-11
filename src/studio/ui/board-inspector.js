// The board's right panel: a layer's CSS in plain words (layout, size, flex, fill, border, shadow,
// type), the board's tokens when nothing is selected, and artboard sizes while drawing a frame.
import { useEffect, useState } from "preact/hooks";
import { freeSpot, inFlow, isFlex, newId, parseStyle, pxValue, round, sizeWord, styleText } from "./board-core.js";
import { B, bset, commit, currentPage, node, select, useBoard } from "./board-state.js";
import { fit, worldBox } from "./board-canvas.js";
import { layerIcon, setFlex } from "./board.js";
import { ColorButton, Dropdown, Num, Section, Seg, Switch, html } from "./controls.js";
import { Icon } from "./icons.js";
import { api, fail, toast } from "./store.js";

const ids = () => B.sel.filter((id) => node(id));
/** Set CSS on every selected layer; `key` makes a run of changes one step of undo. */
function setStyle(style, key, list = ids()) {
  if (!list.length) return;
  commit(
    list.map((id) => ({ op: "set", id, style })),
    { key: key ? `${key}:${list.join()}` : null, label: "Style" },
  );
}
/** The first layer's value, or "mixed" when the selection disagrees. */
function shared(get) {
  const list = ids();
  const first = get(node(list[0]), list[0]);
  return list.every((id) => get(node(id), id) === first) ? first : "mixed";
}
const px = (v) => pxValue(v);
const isAbsolute = (n) => n.style.position === "absolute" || n.style.position === "fixed";

export function Inspector() {
  const b = useBoard();
  const list = ids();
  if (!list.length) return b.tool === "frame" ? html`<${FramePresets} />` : html`<${BoardPanel} />`;
  const n = node(list[0]);
  const many = list.length > 1;
  const allText = list.every((id) => node(id).type === "text");
  const allFrames = list.every((id) => node(id).type === "frame");
  return html`<div class="panel-head bd-ihead">
      <span class="ico"><${Icon} n=${layerIcon(n)} s=${15} /></span>
      <h2>${many ? `${list.length} layers` : n.name}</h2>
      ${!many && html`<span class="sub">${n.parent ? { frame: "Frame", text: "Text", image: "Image", svg: "Vector" }[n.type] : "Artboard"}</span>`}
    </div>
    <div class="panel-body bd-insp">
      <${LayoutSection} />
      ${allFrames && html`<${FlexSection} />`}
      ${!many && n.parent && isFlex(node(n.parent)) && html`<${ChildSection} />`}
      ${allText && html`<${TypeSection} />`}
      ${!many && n.type === "image" && html`<${ImageSection} />`}
      <${LookSection} />
      ${!allText && n.type !== "image" && html`<${FillSection} />`}
      <${BorderSection} />
      <${ShadowSection} />
      ${!many && html`<${CssSection} key=${n.id} />`}
    </div>`;
}

// ---------------------------------------------------------------------------------------------
// Position and size

const SIZE_MODES = [
  { value: "fixed", label: "Fixed" },
  { value: "fit", label: "Fit" },
  { value: "fill", label: "Fill" },
  { value: "relative", label: "Relative" },
];

function modeOf(id, axis) {
  const w = sizeWord(B.board, id, axis);
  if (w === "fit" || w === "auto") return "fit";
  if (w === "fill") return "fill";
  if (/%$/.test(w)) return "relative";
  return "fixed";
}

function sizeStyle(id, axis, mode, value) {
  const n = node(id);
  const p = n.parent ? node(n.parent) : null;
  const flexP = p && isFlex(p) && !isAbsolute(n);
  const row = flexP && !(p.style.flexDirection ?? "row").startsWith("column");
  const main = flexP && (axis === "width") === row;
  const box = worldBox(id) ?? { width: 100, height: 100 };
  const style = {};
  const unfill = main ? { flexGrow: null, flexBasis: null, flex: null } : {};
  if (mode === "fixed") Object.assign(style, unfill, { [axis]: `${Math.max(0, Math.round(value ?? box[axis]))}px` });
  else if (mode === "fit") Object.assign(style, unfill, { [axis]: "fit-content" });
  else if (mode === "fill") {
    if (main) Object.assign(style, { flexGrow: "1", flexBasis: "0px", [axis]: null });
    else if (flexP) Object.assign(style, { alignSelf: "stretch", [axis]: null });
    else style[axis] = "100%";
  } else {
    const pb = p ? worldBox(p.id) : null;
    const pct = value ?? (pb ? (box[axis] / Math.max(1, pb[axis])) * 100 : 50);
    Object.assign(style, unfill, { [axis]: `${round(pct, 1)}%` });
  }
  return style;
}

function SizeField({ axis, label }) {
  const list = ids();
  const id = list[0];
  const n = node(id);
  const mode = shared((_, x) => modeOf(x, axis));
  const box = worldBox(id);
  const shown = mode === "relative" ? parseFloat(n.style[axis]) : box ? Math.round(box[axis]) : undefined;
  const modes = n.parent ? SIZE_MODES : SIZE_MODES.filter((m) => m.value === "fixed" || m.value === "fit");
  return html`<div class="bd-size-field">
    <${Num} label=${label} value=${mode === "mixed" ? undefined : shown} placeholder=${mode === "mixed" ? "Mixed" : "auto"} unit=${mode === "relative" ? "%" : ""}
      onChange=${(v, live) => v !== undefined && commit(list.map((x) => ({ op: "set", id: x, style: sizeStyle(x, axis, mode === "relative" ? "relative" : "fixed", v) })), { key: `size:${axis}:${list.join()}`, label: "Resize" })} />
    <${Dropdown} value=${mode} options=${modes} btnClass="dd-btn bd-mode" title="Fixed: a size in px. Fit: as big as what's inside. Fill: as big as the space it's in. Relative: a share of its frame." onChange=${(m) => commit(list.map((x) => ({ op: "set", id: x, style: sizeStyle(x, axis, m) })), { label: "Resize" })} />
  </div>`;
}

function rotationOf(n) {
  const m = /rotate\((-?[\d.]+)deg\)/.exec(n.style.transform ?? "");
  return m ? Number(m[1]) : 0;
}

function LayoutSection() {
  const list = ids();
  const n = node(list[0]);
  const free = list.every((id) => !inFlow(B.board, id));
  const pos = (axis) => {
    const k = axis === "x" ? "left" : "top";
    return shared((m, id) => {
      const v = px(m.style[k]);
      if (v !== undefined) return v;
      const me = worldBox(id);
      const p = m.parent ? worldBox(m.parent) : { x: 0, y: 0 };
      return me ? Math.round((axis === "x" ? me.x - p.x : me.y - p.y)) : undefined;
    });
  };
  const setPos = (k, v) =>
    commit(
      list.map((id) => ({ op: "set", id, style: { [k]: `${Math.round(v)}px`, ...(node(id).parent && !isAbsolute(node(id)) ? { position: "absolute" } : {}) } })),
      { key: `pos:${k}:${list.join()}`, label: "Move" },
    );
  const x = pos("x");
  const y = pos("y");
  const rot = shared(rotationOf);
  return html`<${Section} title="Layout">
    ${free &&
    html`<div class="grid2">
      <${Num} label="X" value=${x === "mixed" ? undefined : x} placeholder=${x === "mixed" ? "Mixed" : "0"} onChange=${(v) => v !== undefined && setPos("left", v)} />
      <${Num} label="Y" value=${y === "mixed" ? undefined : y} placeholder=${y === "mixed" ? "Mixed" : "0"} onChange=${(v) => v !== undefined && setPos("top", v)} />
    </div>`}
    <div class="grid2">
      <${SizeField} axis="width" label="W" />
      <${SizeField} axis="height" label="H" />
    </div>
    <div class="grid2">
      <${Num} label=${html`<${Icon} n="rotate" s=${12} />`} title="Rotation" value=${rot === "mixed" ? undefined : rot} unit="°" placeholder="Mixed"
        onChange=${(v) => commit(list.map((id) => ({ op: "set", id, style: { transform: v ? `rotate(${round(v, 1)}deg)` : null } })), { key: `rot:${list.join()}`, label: "Rotate" })} />
      ${n.type === "frame" && html`<label class="bd-check"><input type="checkbox" checked=${shared((m) => m.style.overflow === "hidden" || m.style.overflow === "clip") === true}
          onChange=${(e) => setStyle({ overflow: e.target.checked ? "hidden" : null })} />Clip content</label>`}
    </div>
  <//>`;
}

/** For a layer in a flex frame: whether it's placed by the frame or sits on its own. */
function ChildSection() {
  const id = ids()[0];
  const n = node(id);
  const abs = isAbsolute(n);
  const toggle = (on) => {
    if (on) {
      const me = worldBox(id);
      const p = worldBox(n.parent);
      return commit([{ op: "set", id, style: { position: "absolute", left: `${Math.round(me.x - p.x)}px`, top: `${Math.round(me.y - p.y)}px`, width: n.style.width ?? `${Math.round(me.width)}px` } }, ...(node(n.parent).style.position ? [] : [{ op: "set", id: n.parent, style: { position: "relative" } }])], { label: "Absolute position" });
    }
    commit([{ op: "set", id, style: { position: null, left: null, top: null, right: null, bottom: null } }], { label: "In the flow" });
  };
  return html`<div class="bd-child"><label class="bd-check"><input type="checkbox" checked=${abs} onChange=${(e) => toggle(e.target.checked)} />Absolute position</label>
    <span class="bd-note">${abs ? "Placed by X and Y, over its frame's layout" : "Placed by its frame's flex layout"}</span></div>`;
}

// ---------------------------------------------------------------------------------------------
// Flex

const ALIGN = ["flex-start", "center", "flex-end"];
const alignIndex = (v) => (v === "center" ? 1 : v === "flex-end" || v === "end" ? 2 : 0);

/** Four sides of a padding (or radius) from its shorthand and longhands. */
function sides(style, base, keys) {
  const parts = (style[base] ?? "").trim().split(/\s+/).filter(Boolean).map((v) => px(v) ?? 0);
  const [t = 0, r = t, b = t, l = r] = parts;
  const out = [t, r, b, l];
  keys.forEach((k, i) => {
    if (style[k] !== undefined) out[i] = px(style[k]) ?? 0;
  });
  return out;
}
const PAD_KEYS = ["paddingTop", "paddingRight", "paddingBottom", "paddingLeft"];
function padStyle([t, r, b, l]) {
  const v = t === b && r === l ? (t === r ? `${t}px` : `${t}px ${r}px`) : `${t}px ${r}px ${b}px ${l}px`;
  return { padding: t || r || b || l ? v : null, paddingTop: null, paddingRight: null, paddingBottom: null, paddingLeft: null };
}

function FlexSection() {
  const list = ids();
  const n = node(list[0]);
  const [four, setFour] = useState(false);
  const flex = isFlex(n);
  const grid = n.style.display === "grid";
  if (!flex) {
    return html`<${Section} title="Flex" right=${!grid && html`<button class="icon-btn sm" title="Add flex (⇧A): lay its layers out in a row or column" onClick=${() => list.forEach((id) => setFlex(id, true))}><${Icon} n="plus" s=${14} /></button>`}>
      <p class="bd-note">${grid ? "Laid out as a CSS grid: edit it under CSS." : "Its layers sit where you put them. Add flex to lay them out in a row or a column, with gaps and padding."}</p>
    <//>`;
  }
  const column = (n.style.flexDirection ?? "row").startsWith("column");
  const justify = n.style.justifyContent ?? "flex-start";
  const items = n.style.alignItems ?? "stretch";
  const spread = /space-/.test(justify);
  const pad = sides(n.style, "padding", PAD_KEYS);
  const set = (style, key) => setStyle(style, key, list);
  const cell = (r, c) => {
    // Rows of the pad are vertical positions, columns horizontal ones.
    const main = column ? r : c;
    const cross = column ? c : r;
    return { justifyContent: spread ? justify : ALIGN[main], alignItems: ALIGN[cross] };
  };
  const onCell = (r, c) => {
    const m = column ? alignIndex(justify) : alignIndex(items);
    const k = column ? alignIndex(items) : alignIndex(justify);
    return !spread ? m === r && k === c : column ? alignIndex(items) === c : alignIndex(items) === r;
  };
  return html`<${Section} title="Flex" right=${html`<button class="icon-btn sm" title="Remove flex (⌥⇧A): keep each layer where it is" onClick=${() => list.forEach((id) => setFlex(id, false))}><${Icon} n="minus" s=${14} /></button>`}>
    <div class="bd-flex">
      <div class="bd-pad" role="group" aria-label="Alignment">
        ${[0, 1, 2].map((r) => [0, 1, 2].map((c) => html`<button class=${onCell(r, c) ? "on" : ""} title="Align" onClick=${() => set(cell(r, c))}><i></i></button>`))}
      </div>
      <div class="bd-flex-side">
        <${Seg} value=${column ? "column" : "row"} options=${[{ value: "column", icon: "flexCol", label: "", title: "Column" }, { value: "row", icon: "flexRow", label: "", title: "Row" }]} onChange=${(v) => set({ flexDirection: v === "row" ? null : "column" })} />
        <${Num} label=${html`<${Icon} n=${column ? "flexCol" : "flexRow"} s=${12} />`} title="Gap" value=${px(n.style.gap) ?? 0} min=${0} onChange=${(v) => set({ gap: v ? `${v}px` : null }, "gap")} />
      </div>
    </div>
    <div class="bd-flex-opts">
      <label class="bd-check"><input type="checkbox" checked=${spread} onChange=${(e) => set({ justifyContent: e.target.checked ? "space-between" : null })} />Spread out</label>
      <label class="bd-check"><input type="checkbox" checked=${n.style.flexWrap === "wrap"} onChange=${(e) => set({ flexWrap: e.target.checked ? "wrap" : null })} />Wrap</label>
    </div>
    <div class="bd-pads ${four ? "four" : ""}">
      ${four
        ? ["Top", "Right", "Bottom", "Left"].map((s, i) => html`<${Num} label=${s[0]} title=${`${s} padding`} value=${pad[i]} min=${0} onChange=${(v) => set(padStyle(pad.map((x, j) => (j === i ? v ?? 0 : x))), `pad${i}`)} />`)
        : html`<${Num} label=${html`<${Icon} n="flexRow" s=${12} />`} title="Padding left and right" value=${pad[1] === pad[3] ? pad[1] : undefined} placeholder="Mixed" min=${0} onChange=${(v) => set(padStyle([pad[0], v ?? 0, pad[2], v ?? 0]), "padx")} />
          <${Num} label=${html`<${Icon} n="flexCol" s=${12} />`} title="Padding top and bottom" value=${pad[0] === pad[2] ? pad[0] : undefined} placeholder="Mixed" min=${0} onChange=${(v) => set(padStyle([v ?? 0, pad[1], v ?? 0, pad[3]]), "pady")} />`}
      <button class="icon-btn sm ${four ? "on" : ""}" title="Each side" onClick=${() => setFour(!four)}><${Icon} n="sides" s=${14} /></button>
    </div>
  <//>`;
}

// ---------------------------------------------------------------------------------------------
// Look: opacity, blend, corners

const BLENDS = ["normal", "multiply", "screen", "overlay", "darken", "lighten", "color-dodge", "color-burn", "hard-light", "soft-light", "difference", "exclusion", "hue", "saturation", "color", "luminosity", "plus-lighter"].map((v) => ({ value: v, label: v === "normal" ? "Normal" : v.replace(/-/g, " ").replace(/^./, (c) => c.toUpperCase()) }));
const RADIUS_KEYS = ["borderTopLeftRadius", "borderTopRightRadius", "borderBottomRightRadius", "borderBottomLeftRadius"];

function LookSection() {
  const list = ids();
  const n = node(list[0]);
  const [four, setFour] = useState(false);
  const opacity = shared((m) => (m.style.opacity === undefined ? 1 : Number(m.style.opacity)));
  const blend = shared((m) => m.style.mixBlendMode ?? "normal");
  const r = sides(n.style, "borderRadius", RADIUS_KEYS);
  const radiusStyle = (v) => {
    const same = v.every((x) => x === v[0]);
    return { borderRadius: same ? (v[0] ? `${v[0]}px` : null) : v.map((x) => `${x}px`).join(" "), ...Object.fromEntries(RADIUS_KEYS.map((k) => [k, null])) };
  };
  return html`<${Section} title="Look">
    <div class="grid2">
      <${Num} label=${html`<${Icon} n="eye" s=${12} />`} title="Opacity" unit="%" value=${opacity === "mixed" ? undefined : Math.round(opacity * 100)} placeholder="Mixed" min=${0} max=${100}
        onChange=${(v) => v !== undefined && setStyle({ opacity: v >= 100 ? null : String(round(v / 100, 3)) }, "opacity")} />
      <${Dropdown} value=${blend === "mixed" ? null : blend} placeholder="Mixed" options=${BLENDS} onChange=${(v) => setStyle({ mixBlendMode: v === "normal" ? null : v })} />
    </div>
    ${n.type !== "text" &&
    html`<div class="bd-radius ${four ? "four" : ""}">
      ${four
        ? r.map((x, i) => html`<${Num} label=${["↖", "↗", "↘", "↙"][i]} title="Corner radius" value=${x} min=${0} onChange=${(v) => setStyle(radiusStyle(r.map((y, j) => (j === i ? v ?? 0 : y))), `r${i}`)} />`)
        : html`<${Num} label=${html`<${Icon} n="corners" s=${12} />`} title="Corner radius" value=${r.every((x) => x === r[0]) ? r[0] : undefined} placeholder="Mixed" min=${0} onChange=${(v) => setStyle(radiusStyle([v ?? 0, v ?? 0, v ?? 0, v ?? 0]), "radius")} />`}
      <button class="icon-btn sm ${four ? "on" : ""}" title="Each corner" onClick=${() => setFour(!four)}><${Icon} n="corners" s=${14} /></button>
    </div>`}
  <//>`;
}

// ---------------------------------------------------------------------------------------------
// Fill, border, shadow

function FillSection() {
  const list = ids();
  const n = node(list[0]);
  const color = shared((m) => m.style.backgroundColor ?? (/^#|^rgb|^hsl|^oklch|^var\(/.test(m.style.background ?? "") ? m.style.background : undefined));
  const image = n.style.backgroundImage ?? (n.style.background && !/^#|^rgb|^hsl|^oklch|^var\(/.test(n.style.background) ? n.style.background : "");
  const [draft, setDraft] = useState(null);
  return html`<${Section} title="Fill">
    <${ColorButton} value=${color === "mixed" ? undefined : color} auto=${color === "mixed" ? "Mixed" : "None"} onChange=${(c) => setStyle({ backgroundColor: c ?? null, ...(n.style.background && /^#|^rgb|^hsl|^oklch|^var\(/.test(n.style.background) ? { background: null } : {}) }, "fill")} />
    <input class="input bd-mono" placeholder="Gradient or image: linear-gradient(…), url(…)" value=${draft ?? image} spellcheck=${false}
      onInput=${(e) => setDraft(e.target.value)} onKeyDown=${(e) => (e.stopPropagation(), e.key === "Enter" && e.target.blur())}
      onBlur=${() => {
        if (draft === null) return;
        const v = draft.trim();
        setDraft(null);
        setStyle({ backgroundImage: v || null, background: n.style.background && !/^#|^rgb|^hsl|^oklch|^var\(/.test(n.style.background) ? null : n.style.background ?? null });
      }} />
  <//>`;
}

function parseBorder(v) {
  if (!v || v === "none") return null;
  const width = /(-?[\d.]+)px/.exec(v)?.[1];
  const style = /\b(solid|dashed|dotted|double)\b/.exec(v)?.[1] ?? "solid";
  const color = v.replace(/(-?[\d.]+)px/, "").replace(/\b(solid|dashed|dotted|double)\b/, "").trim() || "currentColor";
  return { width: Number(width ?? 1), style, color };
}

function BorderSection() {
  const list = ids();
  const n = node(list[0]);
  const b = parseBorder(n.style.border) ?? (n.style.borderWidth || n.style.borderStyle ? { width: px(n.style.borderWidth) ?? 1, style: n.style.borderStyle ?? "solid", color: n.style.borderColor ?? "currentColor" } : null);
  const put = (next, key) => setStyle({ border: next ? `${next.width}px ${next.style} ${next.color}` : null, borderWidth: null, borderStyle: null, borderColor: null }, key);
  return html`<${Section} title="Border" right=${b ? html`<button class="icon-btn sm" title="Remove the border" onClick=${() => put(null)}><${Icon} n="minus" s=${14} /></button>` : html`<button class="icon-btn sm" title="Add a border" onClick=${() => put({ width: 1, style: "solid", color: "#e4e4e7" })}><${Icon} n="plus" s=${14} /></button>`}>
    ${b &&
    html`<div class="grid2">
        <${Num} label="W" title="Width" value=${b.width} min=${0} onChange=${(v) => put({ ...b, width: v ?? 0 }, "bw")} />
        <${Dropdown} value=${b.style} options=${["solid", "dashed", "dotted", "double"].map((v) => ({ value: v, label: v[0].toUpperCase() + v.slice(1) }))} onChange=${(v) => put({ ...b, style: v })} />
      </div>
      <${ColorButton} value=${b.color === "currentColor" ? undefined : b.color} auto="Text colour" onChange=${(c) => put({ ...b, color: c ?? "currentColor" }, "bc")} />`}
  <//>`;
}

function parseShadow(v) {
  if (!v || v === "none") return null;
  // The first shadow of a list.
  let depth = 0;
  let first = "";
  for (const ch of v) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) break;
    first += ch;
  }
  const inset = /\binset\b/.test(first);
  const colorMatch = /(rgba?\([^)]*\)|hsla?\([^)]*\)|oklch\([^)]*\)|#[0-9a-f]{3,8}\b|var\([^)]*\)|\b[a-z]+\b(?!\())/i.exec(first.replace(/\binset\b/, ""));
  const color = colorMatch?.[1] ?? "rgba(0,0,0,0.2)";
  const nums = first.replace(color, "").replace(/\binset\b/, "").trim().split(/\s+/).map((x) => px(x) ?? 0);
  return { x: nums[0] ?? 0, y: nums[1] ?? 0, blur: nums[2] ?? 0, spread: nums[3] ?? 0, color, inset, more: v.length > first.length };
}

function ShadowSection() {
  const list = ids();
  const n = node(list[0]);
  const s = parseShadow(n.style.boxShadow);
  const put = (next, key) => setStyle({ boxShadow: next ? `${next.inset ? "inset " : ""}${next.x}px ${next.y}px ${next.blur}px ${next.spread}px ${next.color}` : null }, key);
  return html`<${Section} title="Shadow" right=${s ? html`<button class="icon-btn sm" title="Remove the shadow" onClick=${() => put(null)}><${Icon} n="minus" s=${14} /></button>` : html`<button class="icon-btn sm" title="Add a shadow" onClick=${() => put({ x: 0, y: 8, blur: 24, spread: 0, color: "rgba(0,0,0,0.12)", inset: false })}><${Icon} n="plus" s=${14} /></button>`}>
    ${s &&
    html`<div class="grid2">
        <${Num} label="X" value=${s.x} onChange=${(v) => put({ ...s, x: v ?? 0 }, "sx")} />
        <${Num} label="Y" value=${s.y} onChange=${(v) => put({ ...s, y: v ?? 0 }, "sy")} />
        <${Num} label="Blur" value=${s.blur} min=${0} onChange=${(v) => put({ ...s, blur: v ?? 0 }, "sb")} />
        <${Num} label="Spread" value=${s.spread} onChange=${(v) => put({ ...s, spread: v ?? 0 }, "ss")} />
      </div>
      <${ColorButton} value=${s.color} allowAuto=${false} onChange=${(c) => put({ ...s, color: c ?? s.color }, "sc")} />
      <label class="bd-check"><input type="checkbox" checked=${s.inset} onChange=${(e) => put({ ...s, inset: e.target.checked })} />Inside the layer (inset)</label>
      ${s.more && html`<p class="bd-note">More shadows follow this one: see them under CSS.</p>`}`}
  <//>`;
}

// ---------------------------------------------------------------------------------------------
// Type

const WEIGHTS = [
  [100, "Thin"], [200, "Extra light"], [300, "Light"], [400, "Regular"], [500, "Medium"], [600, "Semibold"], [700, "Bold"], [800, "Extra bold"], [900, "Black"],
].map(([v, l]) => ({ value: String(v), label: l, hint: String(v) }));
const FONTS = ["Inter", "SF Pro", "Geist", "Manrope", "DM Sans", "Plus Jakarta Sans", "Space Grotesk", "IBM Plex Sans", "Work Sans", "Poppins", "Montserrat", "Playfair Display", "Fraunces", "Instrument Serif", "Newsreader", "Lora", "JetBrains Mono", "Geist Mono", "IBM Plex Mono"];

function TypeSection() {
  const list = ids();
  const n = node(list[0]);
  const family = shared((m) => (m.style.fontFamily ?? "").split(",")[0].replace(/["']/g, "").trim());
  const [draft, setDraft] = useState(null);
  const weight = shared((m) => m.style.fontWeight ?? "");
  const size = shared((m) => px(m.style.fontSize));
  const lh = n.style.lineHeight;
  const ls = n.style.letterSpacing;
  const align = shared((m) => m.style.textAlign ?? "left");
  const color = shared((m) => m.style.color);
  const fontValue = (name) => (!name ? null : name === "SF Pro" ? "-apple-system, 'SF Pro Text', system-ui, sans-serif" : `${/\s/.test(name) ? `'${name}'` : name}, system-ui, sans-serif`);
  return html`<${Section} title="Text">
    <div class="bd-font">
      <input class="input" list="bd-fonts" placeholder=${family === "mixed" ? "Mixed" : "Inherited"} value=${draft ?? (family === "mixed" ? "" : family)} spellcheck=${false}
        onInput=${(e) => setDraft(e.target.value)} onKeyDown=${(e) => (e.stopPropagation(), e.key === "Enter" && e.target.blur())}
        onBlur=${() => {
          if (draft === null) return;
          setStyle({ fontFamily: fontValue(draft.trim()) });
          setDraft(null);
        }} />
      <datalist id="bd-fonts">${FONTS.map((f) => html`<option value=${f} />`)}</datalist>
    </div>
    <div class="grid2">
      <${Dropdown} value=${weight === "mixed" ? null : weight || "400"} placeholder="Mixed" options=${WEIGHTS} onChange=${(v) => setStyle({ fontWeight: v === "400" ? null : v })} />
      <${Num} label="Size" value=${size === "mixed" ? undefined : size} placeholder=${size === "mixed" ? "Mixed" : "16"} min=${1} onChange=${(v) => v && setStyle({ fontSize: `${v}px` }, "fs")} />
      <${Num} label="Line" title="Line height in px" value=${px(lh) ?? (lh && !isNaN(Number(lh)) ? Math.round(Number(lh) * (px(n.style.fontSize) ?? 16)) : undefined)} placeholder="auto" min=${0} onChange=${(v) => setStyle({ lineHeight: v ? `${v}px` : null }, "lh")} />
      <${Num} label="Letter" title="Letter spacing, in em" digits=${3} step=${0.005} value=${ls ? (/em$/.test(ls) ? parseFloat(ls) : (px(ls) ?? 0) / (px(n.style.fontSize) ?? 16)) : 0} onChange=${(v) => setStyle({ letterSpacing: v ? `${round(v, 3)}em` : null }, "ls")} />
    </div>
    <${Seg} value=${align} options=${[{ value: "left", icon: "alignL", label: "", title: "Left" }, { value: "center", icon: "alignC", label: "", title: "Centre" }, { value: "right", icon: "alignR", label: "", title: "Right" }, { value: "justify", icon: "alignJ", label: "", title: "Justify" }]} onChange=${(v) => setStyle({ textAlign: v === "left" ? null : v })} />
    <${ColorButton} value=${color === "mixed" ? undefined : color} auto=${color === "mixed" ? "Mixed" : "Inherited"} onChange=${(c) => setStyle({ color: c ?? null }, "tc")} />
    <div class="grid2">
      <${Dropdown} value=${n.style.textTransform ?? "none"} options=${[{ value: "none", label: "As typed" }, { value: "uppercase", label: "UPPERCASE" }, { value: "lowercase", label: "lowercase" }, { value: "capitalize", label: "Title Case" }]} onChange=${(v) => setStyle({ textTransform: v === "none" ? null : v })} />
      <${Dropdown} value=${n.style.textDecoration ?? "none"} options=${[{ value: "none", label: "No line" }, { value: "underline", label: "Underline" }, { value: "line-through", label: "Strikethrough" }]} onChange=${(v) => setStyle({ textDecoration: v === "none" ? null : v })} />
    </div>
  <//>`;
}

// ---------------------------------------------------------------------------------------------
// Image

function ImageSection() {
  const id = ids()[0];
  const n = node(id);
  const replace = () => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/png,image/jpeg,image/webp,image/gif,image/svg+xml";
    input.onchange = async () => {
      const f = input.files[0];
      if (!f) return;
      try {
        const r = await api(`/api/upload?kind=image&name=${encodeURIComponent(f.name)}`, f, true);
        commit([{ op: "set", id, src: r.path }], { label: "Replace image" });
      } catch (e) {
        fail(e, "Couldn't add the picture");
      }
    };
    input.click();
  };
  return html`<${Section} title="Image">
    <div class="bd-src"><span title=${n.src}>${(n.src ?? "").split("/").pop() || "No picture"}</span><button class="btn sm" onClick=${replace}>Replace…</button></div>
    <${Seg} value=${n.style.objectFit ?? "fill"} options=${[{ value: "cover", label: "Fill" }, { value: "contain", label: "Fit" }, { value: "fill", label: "Stretch" }]} onChange=${(v) => setStyle({ objectFit: v === "fill" ? null : v })} />
  <//>`;
}

// ---------------------------------------------------------------------------------------------
// All of its CSS, to edit anything the panel doesn't have a control for

function CssSection() {
  const id = ids()[0];
  const n = node(id);
  const text = Object.entries(n.style)
    .map(([k, v]) => `${k.startsWith("--") ? k : k.replace(/^(webkit|moz|ms)(?=[A-Z])/, "-$1").replace(/[A-Z]/g, (c) => "-" + c.toLowerCase())}: ${v};`)
    .join("\n");
  const [draft, setDraft] = useState(null);
  useEffect(() => setDraft(null), [id]);
  return html`<${Section} title="CSS" collapsible open=${false} id="board-css">
    <textarea class="textarea bd-mono bd-css" rows=${Math.min(14, Math.max(4, text.split("\n").length + 1))} spellcheck=${false} value=${draft ?? text}
      onInput=${(e) => setDraft(e.target.value)} onKeyDown=${(e) => e.stopPropagation()}
      onBlur=${() => {
        if (draft === null || draft === text) return setDraft(null);
        const style = parseStyle(draft.replace(/\n/g, ";"));
        setDraft(null);
        commit([{ op: "set", id, replaceStyle: style }], { label: "CSS" });
      }}></textarea>
    <p class="bd-note">Any CSS, one property per line. It's the layer's style attribute.</p>
  <//>`;
}

// ---------------------------------------------------------------------------------------------
// Nothing selected: the board itself

const MCP_COMMAND = "claude mcp add screenshotter --scope user -- /Applications/Screenshotter.app/Contents/MacOS/Screenshotter mcp";

function BoardPanel() {
  const b = useBoard();
  const page = currentPage();
  const [adding, setAdding] = useState(false);
  const tokens = b.board.tokens;
  const setToken = (name, value, key) => commit([{ op: "token", name, value }], { key: key ? `token:${name}` : null, label: "Token" });
  return html`<div class="panel-head"><h2>${b.board.name}</h2><span class="sub">${page?.children.length ?? 0} artboard${page?.children.length === 1 ? "" : "s"}</span></div>
    <div class="panel-body bd-insp">
      <${Section} title="Tokens" count=${tokens.length || undefined} right=${html`<button class="icon-btn sm" title="Add a token" onClick=${() => setAdding(true)}><${Icon} n="plus" s=${14} /></button>`}>
        <p class="bd-note">Colours, sizes and fonts with a name. Any layer can use one as <code>var(--name)</code>, so changing it here changes them all.</p>
        ${tokens.map((t) => html`<${TokenRow} key=${t.name} t=${t} onChange=${(v) => setToken(t.name, v, true)} onRemove=${() => setToken(t.name, null)} />`)}
        ${adding && html`<${NewToken} onDone=${(name, value) => (setAdding(false), name && setToken(name, value || "#000000"))} />`}
      <//>
      <${Section} title="Agents">
        <p class="bd-note">An agent with Screenshotter's tools can design right here while you watch: ask it to “design a sign-up screen on the board ${b.board.name}”. Its changes land as steps you can undo.</p>
        <button class="btn sm block" onClick=${() => navigator.clipboard.writeText(MCP_COMMAND).then(() => toast({ kind: "ok", icon: "copy", title: "Copied the setup command", text: "Run it in a terminal to give Claude Code the tools.", timeout: 4000 }))}><${Icon} n="copy" s=${13} />Copy the setup command</button>
      <//>
      <${Section} title="Shortcuts" collapsible open=${false} id="board-keys">
        <dl class="bd-keys">
          ${[["V F R T H", "Move, frame, rectangle, text, pan"], ["⇧A", "Wrap in a flex frame (or add flex)"], ["⌥⌘G", "Wrap in a frame"], ["⇧⌘G", "Ungroup"], ["Esc / Enter", "Select the parent / the children"], ["⌘-click", "Select the layer right under the pointer"], ["Double-click", "Go one layer in; edit text"], ["⇧0 ⇧1 ⇧2", "100%, fit, zoom to selection"], ["⌥⌘C / ⌥⌘V", "Copy / paste styles"]].map(
            ([k, d]) => html`<dt>${k}</dt><dd>${d}</dd>`,
          )}
        </dl>
      <//>
    </div>`;
}

function TokenRow({ t, onChange, onRemove }) {
  const color = /^(#|rgb|hsl|oklch|color\()/i.test(t.value.trim());
  const [draft, setDraft] = useState(null);
  return html`<div class="bd-token">
    <code title=${t.name}>${t.name.slice(2)}</code>
    ${color ? html`<${ColorButton} value=${t.value} allowAuto=${false} onChange=${(c) => c && onChange(c)} />` : html`<input class="input bd-mono" value=${draft ?? t.value} onInput=${(e) => setDraft(e.target.value)} onKeyDown=${(e) => (e.stopPropagation(), e.key === "Enter" && e.target.blur())} onBlur=${() => (draft !== null && draft.trim() && onChange(draft.trim()), setDraft(null))} />`}
    <button class="icon-btn sm" title="Remove" onClick=${onRemove}><${Icon} n="x" s=${12} /></button>
  </div>`;
}

function NewToken({ onDone }) {
  const [name, setName] = useState("");
  const [value, setValue] = useState("#4c8dff");
  return html`<div class="bd-token new">
    <input class="input bd-mono" autoFocus placeholder="brand" value=${name} onInput=${(e) => setName(e.target.value.replace(/[^A-Za-z0-9_-]/g, "-"))} onKeyDown=${(e) => (e.stopPropagation(), e.key === "Enter" && onDone(name, value), e.key === "Escape" && onDone(null))} />
    <input class="input bd-mono" value=${value} onInput=${(e) => setValue(e.target.value)} onKeyDown=${(e) => (e.stopPropagation(), e.key === "Enter" && onDone(name, value))} />
    <button class="btn sm" onClick=${() => onDone(name, value)}>Add</button>
  </div>`;
}

// ---------------------------------------------------------------------------------------------
// Drawing a frame: sizes to start from

const PRESETS = [
  ["Phone", [["iPhone 17 Pro", 402, 874], ["iPhone 17 Pro Max", 440, 956], ["iPhone Air", 420, 912], ["iPhone 16e", 390, 844], ["Android phone", 412, 915]]],
  ["Tablet", [["iPad Pro 13″", 1032, 1376], ["iPad Air 11″", 820, 1180], ["iPad mini", 744, 1133]]],
  ["Desktop", [["Desktop", 1440, 900], ["Laptop", 1280, 800], ["Full HD", 1920, 1080]]],
  ["Watch", [["Apple Watch 46mm", 208, 248], ["Apple Watch Ultra", 205, 251]]],
  ["App Store", [["iPhone 6.9″ screenshot", 1320, 2868], ["iPad 13″ screenshot", 2064, 2752], ["Mac screenshot", 2880, 1800]]],
  ["Social", [["Square post", 1080, 1080], ["Portrait post", 1080, 1350], ["Story", 1080, 1920], ["Link preview", 1200, 630]]],
];

function FramePresets() {
  const add = (name, w, h) => {
    const page = currentPage();
    const spot = freeSpot(B.board, page.id, w);
    const id = newId();
    commit([{ op: "add", nodes: { [id]: { id, type: "frame", name, parent: null, style: { display: "flex", flexDirection: "column", width: `${w}px`, height: `${h}px`, backgroundColor: "#ffffff", overflow: "hidden", left: `${spot.left}px`, top: `${spot.top}px` }, children: [] } }, ids: [id], parent: null, page: page.id }], { label: "Add artboard" });
    bset({ tool: "move" });
    select(id);
    requestAnimationFrame(() => fit([id]));
  };
  return html`<div class="panel-head"><h2>Frame</h2><span class="sub">Drag on the canvas, or start from a size</span></div>
    <div class="panel-body bd-insp">
      ${PRESETS.map(([group, items]) => html`<${Section} title=${group} collapsible id=${`preset-${group}`}>
          <div class="bd-presets">${items.map(([name, w, h]) => html`<button onClick=${() => add(name, w, h)}><span>${name}</span><span class="dim">${w} × ${h}</span></button>`)}</div>
        <//>`)}
    </div>`;
}

export { styleText };
