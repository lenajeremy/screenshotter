// The board's right panel: a layer's CSS in plain words (layout, size, flex, fill, border, shadow,
// type), the board's tokens when nothing is selected, and artboard sizes while drawing a frame.
import { useEffect, useRef, useState } from "preact/hooks";
import { attrText, camel, cleanAttrs, freeSpot, inFlow, instanceRootOf, instancesOf, isFlex, newId, pageOf, parseHtml, parseStyle, pxValue, renameTokenOps, round, serializeSvg, sizeWord, styleText, subtree, vectorName, videoSettings } from "./board-core.js";
import { B, CANVAS_ONLY, bset, commit as commitOps, currentPage, node, select, useBoard } from "./board-state.js";
import { fit, scalePlan, shiftSteps, toggleVideo, useVideo, vectorSpace, vectorStep, worldBox } from "./board-canvas.js";
import { alignSelection, canAlign, detachCopy, distributeSelection, flattenVector, goToComponent, layerIcon, placeCopy, resetCopy, selectCopies, setFlex, splitVector, stopComponent } from "./board.js";
import { maskSelection, removeMask, setMaskType, useAsMask } from "./board.js";
import { maskOf, maskedBy } from "./board-core.js";
import { styleWords, wordState, words } from "./board-canvas.js";
import { ColorButton, ColorPicker, Dropdown, Num, Popover, Section, Seg, Slider, Switch, html, normalizeColor, resolveVars, tokenColor, tokenRef } from "./controls.js";
import { Icon } from "./icons.js";
import { api, fail, fileUrl, toast } from "./store.js";
import { areaRects, areasValid, gridOf, gridPatch, isGrid, parsePlacement, parseTracks, placementCss, placementSpan, trackArgs, trackKind, trackLabel } from "./board-core.js";
import { AXES as GRID_AXES, changeGrids, gridGeometry, inGrid, insertTrackOps, layoutOf, moveTrackOps, removeTrackOps, setLayout, trackCountOps, trackSizeOps } from "./board-grid.js";

/** What the panel doesn't draw from: the view and the pointer (it does show the words picked in a text). */
const PANEL_SKIPS = CANVAS_ONLY.filter((k) => k !== "words");

// "Make a token" in a colour picker adds the token and puts it in the field as one step of undo:
// the token waits here for the field's own change, which comes straight after it.
const pendingTokens = [];
function commit(ops, opts) {
  return commitOps(pendingTokens.length ? [...pendingTokens.splice(0), ...ops] : ops, opts);
}
function makeToken(name, value) {
  pendingTokens.push({ op: "token", name, value });
  // A field that doesn't change the board at once (words being typed) still gets its token.
  queueMicrotask(() => pendingTokens.length && commitOps(pendingTokens.splice(0), { label: "Token" }));
}

/** A colour field on a board: its colour tokens to pick from, and "Make a token". */
const BoardColor = (props) => html`<${ColorButton} tokens=${B.board.tokens} onMakeToken=${makeToken} ...${props} />`;
const BoardPicker = (props) => html`<${ColorPicker} tokens=${B.board.tokens} onMakeToken=${makeToken} ...${props} />`;
/** A colour as the canvas draws it, through the board's tokens (one that's missing draws nothing). */
const paint = (c) => resolveVars(c, B.board.tokens).trim() || "transparent";
/** A token's name in a row or a field, marked so it doesn't read as a CSS colour name. */
const tokenTag = (c) => {
  const t = tokenRef(c);
  return t && html`<span class="cb-token">${t.slice(2)}</span>`;
};

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
  const b = useBoard(PANEL_SKIPS);
  const list = ids();
  if (!list.length) return b.tool === "frame" ? html`<${FramePresets} />` : html`<${BoardPanel} />`;
  const n = node(list[0]);
  const many = list.length > 1;
  const parts = list.filter((id) => node(id).type === "vector").length;
  if (parts) {
    return html`<div class="panel-head bd-ihead">
        <span class="ico"><${Icon} n=${layerIcon(n)} s=${15} /></span>
        <h2>${many ? `${list.length} layers` : n.name}</h2>
        ${!many && html`<span class="sub">${vectorName(n.tag)}</span>`}
      </div>
      <div class="panel-body bd-insp">
        ${parts === list.length
          ? html`<${PartSection} />${!many && n.tag === "text" && html`<${PartTextSection} key=${n.id} />`}<${SelectionColors} />${!many && html`<${AttrsSection} key=${n.id} /><${CssSection} key=${"css" + n.id} />`}`
          : html`<p class="bd-note bd-pad">Parts of a vector are edited on their own: pick only them, or only the other layers.</p>`}
      </div>`;
  }
  const allText = list.every((id) => node(id).type === "text");
  const allFrames = list.every((id) => node(id).type === "frame");
  return html`<div class="panel-head bd-ihead">
      <span class="ico"><${Icon} n=${layerIcon(n)} s=${15} /></span>
      <h2>${many ? `${list.length} layers` : n.name}</h2>
      ${!many && html`<span class="sub">${n.isComponent ? "Component" : n.instanceOf ? "Copy" : !n.parent && n.type === "frame" ? "Artboard" : n.shape ? "Shape" : { frame: "Frame", text: "Text", image: "Image", video: "Video", svg: "Vector", vector: "Vector" }[n.type]}</span>`}
    </div>
    <div class="panel-body bd-insp">
      ${b.tool === "scale" && html`<${ScaleSection} />`}
      ${!many && html`<${ComponentSection} />`}
      <${LayoutSection} />
      ${allFrames && (list.every((id) => isGrid(node(id))) ? html`<${GridSection} />` : html`<${FlexSection} />`)}
      ${!many && n.parent && isFlex(node(n.parent)) && html`<${ChildSection} />`}
      ${n.parent && isGrid(node(n.parent)) && list.every((id) => node(id).parent === n.parent) && html`<${GridChildSection} />`}
      ${allText && html`<${TypeSection} />`}
      ${!many && n.type === "image" && html`<${ImageSection} />`}
      ${!many && n.type === "video" && html`<${VideoSection} />`}
      ${!many && n.shape && html`<${ShapeSection} />`}
      ${!many && n.type === "svg" && !n.shape && html`<${VectorSection} />`}
      <${LookSection} />
      <${MaskSection} />
      ${!allText && n.type !== "image" && n.type !== "video" && n.type !== "svg" && html`<${FillSection} />`}
      ${n.type !== "svg" && html`<${LineSection} kind="border" />`}
      <${LineSection} kind="outline" />
      ${n.type !== "svg" && html`<${ShadowSection} />`}
      <${FiltersSection} />
      <${SelectionColors} />
      ${!many && n.type === "svg" && !n.svg && html`<${AttrsSection} key=${"a" + n.id} />`}
      ${!many && html`<${CssSection} key=${n.id} />`}
    </div>`;
}

// ---------------------------------------------------------------------------------------------
// A vector's parts: where they are, their paint, their words, their SVG attributes

const partIds = () => ids().filter((id) => node(id).type === "vector");
/** Set SVG attributes on the selected parts (a CSS property of the same name, which would win, goes). */
function setAttrs(patch, key, list = partIds()) {
  if (!list.length) return;
  commit(
    list.map((id) => {
      const n = node(id);
      const style = {};
      for (const k of Object.keys(patch)) if (n.style[camel(k)] !== undefined) style[camel(k)] = null;
      return { op: "set", id, attrs: patch, ...(Object.keys(style).length ? { style } : {}) };
    }),
    { key: key ? `attrs:${key}:${list.join()}` : null, label: "Style" },
  );
}
const attrOf = (n, k) => n.style[camel(k)] ?? n.attrs?.[k];
/** The svg layer a part is drawn in. */
const svgOf = (id) => {
  let p = node(id)?.parent;
  while (p && node(p)?.type === "vector") p = node(p).parent;
  return p;
};

/** How a part is painted: a colour, none, a gradient or pattern of the svg's, or what it inherits. */
function Paint({ label, prop }) {
  const list = partIds();
  const v = shared((m) => attrOf(m, prop) ?? "");
  const kind = v === "mixed" ? "mixed" : !v ? "inherit" : v === "none" ? "none" : /^url\(/i.test(v) ? "ref" : "color";
  return html`<div class="row bd-paint"><label>${label}</label>
    <${BoardColor} value=${kind === "color" ? v : undefined} auto=${{ none: "None", ref: "Gradient", inherit: "Inherited", mixed: "Mixed" }[kind] ?? "Inherited"}
      onChange=${(c) => setAttrs({ [prop]: c ?? null }, prop, list)} />
    <button class="icon-btn sm ${kind === "none" ? "on" : ""}" title=${kind === "none" ? `Give it a ${label.toLowerCase()}` : `No ${label.toLowerCase()}`}
      onClick=${() => setAttrs({ [prop]: kind === "none" ? (prop === "fill" ? "#000000" : "#000000") : "none" }, null, list)}><${Icon} n=${kind === "none" ? "plus" : "x"} s=${12} /></button>
  </div>`;
}

const DASHES = [
  { value: "", label: "Solid" },
  { value: "6 4", label: "Dashed" },
  { value: "1 4", label: "Dotted" },
];

function PartSection() {
  const list = partIds();
  const id = list[0];
  const n = node(id);
  const box = worldBox(id);
  const root = svgOf(id);
  const rb = root ? worldBox(root) : { x: 0, y: 0 };
  const at = box && { x: round(box.x - rb.x, 1), y: round(box.y - rb.y, 1), w: round(box.width, 1), h: round(box.height, 1) };
  const one = list.length === 1;
  // Moving or sizing goes through the part's own coordinates, as dragging does.
  const setBox = (k, v) => {
    if (v === undefined || !at) return;
    if (k === "x" || k === "y") return commit(shiftSteps(list, k === "x" ? v - at.x : 0, k === "y" ? v - at.y : 0), { key: `vpos:${k}:${list.join()}`, label: "Move" });
    const sp = vectorSpace(id);
    if (!sp) return;
    // The zoom as it is now (the panel doesn't redraw as the view moves).
    const to = { ...sp.from, [k === "w" ? "width" : "height"]: Math.max(0.1, v) * B.view.z };
    commit([vectorStep(n, sp, to)], { key: `vsize:${k}:${id}`, label: "Resize" });
  };
  const stroke = shared((m) => attrOf(m, "stroke") ?? "");
  const hasStroke = stroke && stroke !== "none";
  const width = shared((m) => attrOf(m, "stroke-width") ?? "1");
  const dash = shared((m) => attrOf(m, "stroke-dasharray") ?? "");
  const cap = shared((m) => attrOf(m, "stroke-linecap") ?? "butt");
  const opacity = shared((m) => Number(attrOf(m, "opacity") ?? 1));
  return html`<${Section} title="Layout">
      ${canAlign() && html`<${AlignRow} many=${list.length > 2} />`}
      ${one && at && html`<div class="grid2">
        <${Num} label="X" value=${at.x} digits=${1} onChange=${(v) => setBox("x", v)} />
        <${Num} label="Y" value=${at.y} digits=${1} onChange=${(v) => setBox("y", v)} />
        <${Num} label="W" value=${at.w} digits=${1} min=${0} onChange=${(v) => setBox("w", v)} />
        <${Num} label="H" value=${at.h} digits=${1} min=${0} onChange=${(v) => setBox("h", v)} />
      </div>`}
      ${n.tag === "rect" && one && html`<${Num} label=${html`<${Icon} n="corners" s=${12} />`} title="Corner radius" value=${Number(n.attrs?.rx ?? 0)} min=${0} onChange=${(v) => setAttrs({ rx: v ? String(v) : null, ry: null }, "rx")} />`}
    <//>
    <${Section} title="Paint">
      ${n.tag !== "line" && n.tag !== "polyline" && html`<${Paint} label="Fill" prop="fill" />`}
      <${Paint} label="Stroke" prop="stroke" />
      ${hasStroke && html`<div class="grid2">
        <${Num} label="W" title="Stroke width" value=${width === "mixed" ? undefined : parseFloat(width)} placeholder="—" min=${0} digits=${2} step=${0.5} onChange=${(v) => setAttrs({ "stroke-width": v === undefined ? null : String(v) }, "sw")} />
        <${Dropdown} value=${dash === "mixed" ? null : DASHES.some((d) => d.value === dash) ? dash : ""} placeholder="Mixed" options=${DASHES} onChange=${(v) => setAttrs({ "stroke-dasharray": v || null })} />
      </div>
      <${Seg} value=${cap === "mixed" ? null : cap} options=${[{ value: "butt", label: "Flat ends" }, { value: "round", label: "Round" }, { value: "square", label: "Square" }]} onChange=${(v) => setAttrs({ "stroke-linecap": v === "butt" ? null : v })} />`}
      <${Num} label=${html`<${Icon} n="eye" s=${12} />`} title="Opacity" unit="%" value=${opacity === "mixed" ? undefined : Math.round(opacity * 100)} placeholder="—" min=${0} max=${100}
        onChange=${(v) => v !== undefined && setAttrs({ opacity: v >= 100 ? null : String(round(v / 100, 3)) }, "op")} />
    <//>`;
}

/** Words drawn in SVG: what they say and how. */
function PartTextSection() {
  const id = partIds()[0];
  const n = node(id);
  const words = parseHtml(n.text ?? "").children.map((c) => (typeof c === "string" ? c : "")).join("");
  const styled = /</.test(n.text ?? "");
  const [draft, setDraft] = useState(null);
  const size = parseFloat(attrOf(n, "font-size") ?? "") || undefined;
  return html`<${Section} title="Words">
    <input class="input" value=${draft ?? (styled ? n.text.replace(/<[^>]+>/g, "") : words)} spellcheck=${false}
      onInput=${(e) => setDraft(e.target.value)} onKeyDown=${(e) => (e.stopPropagation(), e.key === "Enter" && e.target.blur())}
      onBlur=${() => {
        if (draft === null) return;
        const text = draft.replace(/&/g, "&amp;").replace(/</g, "&lt;");
        setDraft(null);
        commit([{ op: "set", id, text, ...(n.name === vectorName("text") || n.name === words.slice(0, 40) ? { name: draft.slice(0, 40) || n.name } : {}) }], { label: "Words" });
      }} />
    <div class="grid2">
      <${Num} label="Size" value=${size} placeholder="16" min=${1} onChange=${(v) => v && setAttrs({ "font-size": String(v) }, "fs")} />
      <${Dropdown} value=${attrOf(n, "font-weight") ?? "400"} options=${WEIGHTS} onChange=${(v) => setAttrs({ "font-weight": v === "400" ? null : v })} />
    </div>
    <${Seg} value=${attrOf(n, "text-anchor") ?? "start"} options=${[{ value: "start", icon: "alignL", label: "", title: "From its x" }, { value: "middle", icon: "alignC", label: "", title: "Centred on its x" }, { value: "end", icon: "alignR", label: "", title: "Ending at its x" }]} onChange=${(v) => setAttrs({ "text-anchor": v === "start" ? null : v })} />
    ${styled && html`<p class="bd-note">Typing here keeps the words but drops their own styling (tspans).</p>`}
  <//>`;
}

/** Every SVG attribute of a part (or of a vector's <svg>), to edit what the panel has no control for. */
function AttrsSection() {
  const id = ids()[0];
  const n = node(id);
  const text = cleanAttrs(n.attrs).map(([k, v]) => `${k}="${v.replace(/"/g, "&quot;")}"`).join("\n");
  const [draft, setDraft] = useState(null);
  useEffect(() => setDraft(null), [id]);
  return html`<${Section} title="SVG attributes" collapsible open=${false} id="board-attrs">
    <textarea class="textarea bd-mono bd-css" rows=${Math.min(14, Math.max(4, text.split("\n").length + 1))} spellcheck=${false} value=${draft ?? text}
      onInput=${(e) => setDraft(e.target.value)} onKeyDown=${(e) => e.stopPropagation()}
      onBlur=${() => {
        if (draft === null || draft === text) return setDraft(null);
        const el = parseHtml(`<x ${draft.replace(/\n/g, " ")}></x>`).children.find((c) => typeof c !== "string");
        const next = Object.fromEntries(cleanAttrs(el?.attrs ?? {}));
        const patch = Object.fromEntries([...Object.keys(n.attrs ?? {}).map((k) => [k, null]), ...Object.entries(next)]);
        setDraft(null);
        commit([{ op: "set", id, attrs: patch }], { label: "Attributes" });
      }} />
    <p class="bd-note">As written in SVG: <code>name="value"</code>, one a line.</p>
  <//>`;
}
void attrText;
void serializeSvg;

// ---------------------------------------------------------------------------------------------
// Components: what a component or a copy is, and what to do with it

function ComponentSection() {
  const id = ids()[0];
  const n = node(id);
  const root = instanceRootOf(B.board, id);
  if (n.isComponent) {
    const copies = instancesOf(B.board, id).length;
    return html`<div class="bd-compbox">
      <div class="t"><${Icon} n="component" s=${14} /><b>Component</b><span>${copies ? `${copies} cop${copies === 1 ? "y follows" : "ies follow"} it` : "No copies yet"}</span></div>
      <div class="hstack"><button class="btn sm" onClick=${() => placeCopy(id)}><${Icon} n="plus" s=${12} />Place a copy</button>
        ${copies > 0 && html`<button class="btn sm ghost" onClick=${() => selectCopies(id)}>Select copies</button>`}
        <span class="spacer"></span><button class="icon-btn sm" title="Stop being a component (its copies become ordinary layers)" onClick=${() => stopComponent(id)}><${Icon} n="x" s=${12} /></button></div>
    </div>`;
  }
  if (root) {
    const main = node(node(root).instanceOf);
    const changed = subtree(B.board, id).flatMap((x) => node(x).overrides ?? []);
    const words = [...new Set(changed.map((k) => (k === "text" ? "words" : k === "src" ? "picture" : k.replace(/^style\./, "").replace(/[A-Z]/g, (c) => " " + c.toLowerCase()))))];
    return html`<div class="bd-compbox">
      <div class="t"><${Icon} n="instance" s=${14} /><b>${root === id ? "Copy of" : "In a copy of"} ${main?.name ?? "a component"}</b></div>
      <p class="bd-note">${words.length ? `Changed here: ${words.slice(0, 5).join(", ")}${words.length > 5 ? "…" : ""}. The rest follows the component.` : "Follows the component: change the component to change every copy, or change this copy alone here."}</p>
      <div class="hstack"><button class="btn sm" onClick=${() => goToComponent(id)}>Go to the component</button>
        ${words.length > 0 && html`<button class="btn sm ghost" onClick=${() => resetCopy(id)}>Reset</button>`}
        <span class="spacer"></span><button class="btn sm ghost" title="Make it ordinary layers (⌥⌘B)" onClick=${() => detachCopy(id)}>Detach</button></div>
    </div>`;
  }
  return null;
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
    // In a grid: no size of its own, stretched across its cells.
    else if (p && isGrid(p) && !isAbsolute(n)) Object.assign(style, { [axis]: null, [axis === "width" ? "justifySelf" : "alignSelf"]: stretched(p.style[axis === "width" ? "justifyItems" : "alignItems"]) ? null : "stretch" });
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
    <${Num} label=${label} value=${mode === "mixed" || (list.length > 1 && mode !== "fixed") ? undefined : shown} placeholder=${mode === "mixed" || list.length > 1 ? "—" : "auto"} unit=${mode === "relative" ? "%" : ""}
      onChange=${(v, live) => v !== undefined && commit(list.map((x) => ({ op: "set", id: x, style: sizeStyle(x, axis, mode === "relative" ? "relative" : "fixed", v) })), { key: `size:${axis}:${list.join()}`, label: "Resize" })} />
    <${Dropdown} value=${mode} placeholder="Mixed" options=${modes} btnClass="dd-btn bd-mode" title="Fixed: a size in px. Fit: as big as what's inside. Fill: as big as the space it's in. Relative: a share of its frame." onChange=${(m) => commit(list.map((x) => ({ op: "set", id: x, style: sizeStyle(x, axis, m) })), { label: "Resize" })} />
  </div>`;
}

// ---------------------------------------------------------------------------------------------
// Scale (the Scale tool, K): the selection by a factor, or to a width or height, with everything in it

/** The point of the selection that stays put, left to right and top to bottom. */
const SCALE_FROM = [[0, 0], [0.5, 0], [1, 0], [0, 0.5], [0.5, 0.5], [1, 0.5], [0, 1], [0.5, 1], [1, 1]];
const FROM_NAMES = ["top left", "top", "top right", "left", "centre", "right", "bottom left", "bottom", "bottom right"];

/** A scrub on one of the fields: shown live from where it started, kept as one step when the pointer lifts. */
let scrubbing = null;
function scaleTo(factor, live) {
  if (!live) {
    scrubbing = null;
    const plan = scalePlan(ids());
    if (!plan.box) return;
    plan.to(factor(plan.box), B.scaleFrom);
    return plan.done();
  }
  if (!scrubbing) {
    const plan = (scrubbing = scalePlan(ids()));
    addEventListener("pointerup", () => scrubbing === plan && ((scrubbing = null), plan.done()), { once: true });
  }
  if (scrubbing.box) scrubbing.to(factor(scrubbing.box), B.scaleFrom);
}

function ScaleSection() {
  const b = useBoard(PANEL_SKIPS);
  const boxes = ids().map(worldBox).filter(Boolean);
  if (!boxes.length) return null;
  const x0 = Math.min(...boxes.map((r) => r.x));
  const y0 = Math.min(...boxes.map((r) => r.y));
  const w = Math.max(...boxes.map((r) => r.x + r.width)) - x0;
  const h = Math.max(...boxes.map((r) => r.y + r.height)) - y0;
  return html`<${Section} title="Scale">
    <div class="grid2">
      <${Num} label="W" title="Scale to this width" value=${Math.round(w)} min=${1} onChange=${(v, live) => v && scaleTo((g) => v / g.width, live)} />
      <${Num} label="H" title="Scale to this height" value=${Math.round(h)} min=${1} onChange=${(v, live) => v && scaleTo((g) => v / g.height, live)} />
    </div>
    <div class="bd-scale-row">
      <${Num} label=${html`<${Icon} n="scale" s=${12} />`} title="Scale by" value=${Math.round((b.scaling ?? 1) * 100)} unit="%" min=${1} onChange=${(v, live) => v && scaleTo(() => v / 100, live)} />
      <div class="bd-scale-from" role="radiogroup" aria-label="Scale from">
        ${SCALE_FROM.map(([x, y], i) => {
          const on = b.scaleFrom[0] === x && b.scaleFrom[1] === y;
          return html`<button key=${i} role="radio" aria-checked=${on} class=${on ? "on" : ""} title=${`Scale from the ${FROM_NAMES[i]}`} onClick=${() => bset({ scaleFrom: [x, y] })}><i></i></button>`;
        })}
      </div>
    </div>
    <p class="bd-note">Handles scale everything inside, type and spacing too. ⌥ scales from the centre.</p>
  <//>`;
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
    ${canAlign() && html`<${AlignRow} many=${list.length > 2} />`}
    ${free &&
    html`<div class="grid2">
      <${Num} label="X" value=${x === "mixed" ? undefined : x} placeholder=${x === "mixed" ? "—" : "0"} onChange=${(v) => v !== undefined && setPos("left", v)} />
      <${Num} label="Y" value=${y === "mixed" ? undefined : y} placeholder=${y === "mixed" ? "—" : "0"} onChange=${(v) => v !== undefined && setPos("top", v)} />
    </div>`}
    <div class="grid2">
      <${SizeField} axis="width" label="W" />
      <${SizeField} axis="height" label="H" />
    </div>
    <div class="grid2">
      <${Num} label=${html`<${Icon} n="rotate" s=${12} />`} title="Rotation" value=${rot === "mixed" ? undefined : rot} unit="°" placeholder="—"
        onChange=${(v) => commit(list.map((id) => ({ op: "set", id, style: { transform: v ? `rotate(${round(v, 1)}deg)` : null } })), { key: `rot:${list.join()}`, label: "Rotate" })} />
      ${n.type === "frame" && html`<label class="bd-check"><input type="checkbox" checked=${shared((m) => m.style.overflow === "hidden" || m.style.overflow === "clip") === true}
          onChange=${(e) => setStyle({ overflow: e.target.checked ? "hidden" : null })} />Clip content</label>`}
    </div>
  <//>`;
}

const ALIGNS = [
  ["left", "alignLeftE", "Align left (⌥A)"],
  ["hcenter", "alignHCenter", "Align centres (⌥H)"],
  ["right", "alignRightE", "Align right (⌥D)"],
  ["top", "alignTopE", "Align tops (⌥W)"],
  ["vcenter", "alignVCenter", "Align middles (⌥V)"],
  ["bottom", "alignBottomE", "Align bottoms (⌥S)"],
];
function AlignRow({ many }) {
  return html`<div class="bd-align" role="group" aria-label="Align">
    ${ALIGNS.map(([edge, icon, title]) => html`<button class="icon-btn sm" title=${title} onClick=${() => alignSelection(edge)}><${Icon} n=${icon} s=${15} /></button>`)}
    <span class="sep"></span>
    <button class="icon-btn sm" title="Even gaps across (⌥⇧H)" disabled=${!many} onClick=${() => distributeSelection("x")}><${Icon} n="distH" s=${15} /></button>
    <button class="icon-btn sm" title="Even gaps down (⌥⇧V)" disabled=${!many} onClick=${() => distributeSelection("y")}><${Icon} n="distV" s=${15} /></button>
  </div>`;
}

/** For a layer in a flex frame: whether it's placed by the frame or sits on its own. */
function ChildSection() {
  const id = ids()[0];
  const n = node(id);
  const abs = isAbsolute(n);
  const toggle = (on) => {
    if (on) {
      // A hidden layer isn't drawn: it's placed at its frame's corner.
      const p = worldBox(n.parent) ?? { x: 0, y: 0 };
      const me = worldBox(id) ?? { ...p, width: 100 };
      return commit([{ op: "set", id, style: { position: "absolute", left: `${Math.round(me.x - p.x)}px`, top: `${Math.round(me.y - p.y)}px`, width: n.style.width ?? `${Math.round(me.width)}px` } }, ...(node(n.parent).style.position ? [] : [{ op: "set", id: n.parent, style: { position: "relative" } }])], { label: "Absolute position" });
    }
    commit([{ op: "set", id, style: { position: null, left: null, top: null, right: null, bottom: null } }], { label: "In the flow" });
  };
  return html`<label class="bd-check" title=${abs ? "Placed by X and Y, over its frame's layout" : "Placed by its frame's flex layout; tick to place it by hand"}><input type="checkbox" checked=${abs} onChange=${(e) => toggle(e.target.checked)} />Absolute position</label>`;
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
    return html`<${Section} title="Auto layout" right=${!grid && html`<button class="icon-btn sm" title="Add flex (⇧A): lay its layers out in a row or column" onClick=${() => list.forEach((id) => setFlex(id, true))}><${Icon} n="plus" s=${14} /></button>`}>
      <${LayoutKind} list=${list} />
      <p class="bd-note">${grid ? "Laid out as a CSS grid: edit it under CSS." : "Its layers sit where you put them. Flex lays them out in a row or a column; a grid in rows and columns."}</p>
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
    <${LayoutKind} list=${list} />
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
        : html`<${Num} label=${html`<${Icon} n="flexRow" s=${12} />`} title="Padding left and right" value=${pad[1] === pad[3] ? pad[1] : undefined} placeholder="—" min=${0} onChange=${(v) => set(padStyle([pad[0], v ?? 0, pad[2], v ?? 0]), "padx")} />
          <${Num} label=${html`<${Icon} n="flexCol" s=${12} />`} title="Padding top and bottom" value=${pad[0] === pad[2] ? pad[0] : undefined} placeholder="—" min=${0} onChange=${(v) => set(padStyle([v ?? 0, pad[1], v ?? 0, pad[3]]), "pady")} />`}
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
      <${Num} label=${html`<${Icon} n="eye" s=${12} />`} title="Opacity" unit="%" value=${opacity === "mixed" ? undefined : Math.round(opacity * 100)} placeholder="—" min=${0} max=${100}
        onChange=${(v) => v !== undefined && setStyle({ opacity: v >= 100 ? null : String(round(v / 100, 3)) }, "opacity")} />
      <${Dropdown} value=${blend === "mixed" ? null : blend} placeholder="Mixed" options=${BLENDS} onChange=${(v) => setStyle({ mixBlendMode: v === "normal" ? null : v })} />
    </div>
    ${n.type !== "text" &&
    html`<div class="bd-radius ${four ? "four" : ""}">
      ${four
        ? r.map((x, i) => html`<${Num} label=${["↖", "↗", "↘", "↙"][i]} title="Corner radius" value=${x} min=${0} onChange=${(v) => setStyle(radiusStyle(r.map((y, j) => (j === i ? v ?? 0 : y))), `r${i}`)} />`)
        : html`<${Num} label=${html`<${Icon} n="corners" s=${12} />`} title="Corner radius" value=${r.every((x) => x === r[0]) ? r[0] : undefined} placeholder="—" min=${0} onChange=${(v) => setStyle(radiusStyle([v ?? 0, v ?? 0, v ?? 0, v ?? 0]), "radius")} />`}
      <button class="icon-btn sm ${four ? "on" : ""}" title="Each corner" onClick=${() => setFour(!four)}><${Icon} n="corners" s=${14} /></button>
    </div>`}
  <//>`;
}

// ---------------------------------------------------------------------------------------------
// Mask, as Figma has it: a layer used as a mask shows the layers above it in its frame only where it
// is, by its alpha, its outline (vector) or its brightness (luminance).

const MASK_KINDS = [
  { value: "alpha", label: "Alpha", title: "By its opacity: see-through parts of it (a gradient to transparent, a picture's clear parts) hide what's under them" },
  { value: "vector", label: "Vector", title: "By its outline: everything inside its shape shows, however see-through it's painted" },
  { value: "luminance", label: "Luminance", title: "By its brightness: white shows, black hides, greys show in part" },
];

function MaskSection() {
  const list = ids();
  const n = node(list[0]);
  if (list.length > 1) {
    if (!list.every((id) => node(id).parent === n.parent)) return null;
    return html`<${Section} title="Mask" right=${html`<button class="icon-btn sm" data-mask-add title="Mask with selection (⌃⌘M): the layer at the back masks the rest" onClick=${() => maskSelection()}><${Icon} n="plus" s=${14} /></button>`} />`;
  }
  if (!n.parent) return null;
  if (n.mask) {
    const shows = maskedBy(B.board, n.id);
    const count = `${shows.length} layer${shows.length === 1 ? "" : "s"}`;
    const flowing = inFlow(B.board, n.id);
    return html`<${Section} title="Mask" right=${html`
        <button class="icon-btn sm" data-mask-eye title=${n.hidden ? "Turn the mask on" : "Turn the mask off: what it masks shows whole"} onClick=${() => commit([{ op: "set", id: n.id, hidden: n.hidden ? null : true }], { label: n.hidden ? "Mask on" : "Mask off" })}><${Icon} n=${n.hidden ? "eyeOff" : "eye"} s=${14} /></button>
        <button class="icon-btn sm" data-mask-remove title="Remove mask (⌃⌘M): what it hid shows again" onClick=${() => removeMask(n.id)}><${Icon} n="minus" s=${14} /></button>`}>
      <div class="bd-mask-kind"><${Seg} value=${n.mask} options=${MASK_KINDS} onChange=${(v) => setMaskType(n.id, v)} /></div>
      <div class="bd-mask-what">
        <span>${n.hidden ? `Off: the ${count} above it show whole.` : shows.length ? `Shows the ${count} above it only where it is.` : "Nothing above it to mask yet: put layers above it in its frame."}</span>
        ${shows.length > 0 && html`<button class="btn sm ghost" onClick=${() => select(shows)}>Select</button>`}
      </div>
      ${flowing && html`<p class="bd-note">It's placed by its frame's layout, so the mask can't tell where it is. Tick Absolute position, or put it in a mask group (⌃⌘M on it and its layers).</p>`}
    <//>`;
  }
  const by = maskOf(B.board, n.id);
  return html`<${Section} title="Mask" right=${html`<button class="icon-btn sm" data-mask-add title="Use as mask (⌃⌘M): it shows the layers above it in its frame only where it is" onClick=${() => useAsMask(n.id)}><${Icon} n="plus" s=${14} /></button>`}>
    ${by && html`<div class="bd-mask-what by"><${Icon} n="mask" s=${14} /><span>Masked by <b>${node(by)?.name}</b>${node(by)?.hidden ? " (off)" : ""}</span><button class="btn sm ghost" onClick=${() => select(by)}>Select mask</button></div>`}
  <//>`;
}

// ---------------------------------------------------------------------------------------------
// Fill, border, shadow

// Fills are the CSS background's layers, top first: a solid colour (the bottom one is the
// background-color; any above it are a one-colour gradient), a linear, radial or conic gradient, or
// a picture. Anything the panel can't take apart stays as CSS.

const COLOR = /^(#|rgb|hsl|oklch|oklab|lab\(|lch\(|color\(|var\(|transparent$|currentcolor$|[a-z]+$)/i;

/** A list split at its top-level commas (not the ones inside brackets). */
function splitTop(v) {
  const out = [];
  let depth = 0;
  let cur = "";
  for (const ch of v ?? "") {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      out.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

const SIDES = { top: 0, right: 90, bottom: 180, left: 270, "top right": 45, "right top": 45, "bottom right": 135, "right bottom": 135, "bottom left": 225, "left bottom": 225, "top left": 315, "left top": 315 };

function parseStops(parts) {
  return parts.map((p) => {
    const m = /^(.*?)(?:\s+(-?[\d.]+)%)?(?:\s+(-?[\d.]+)%)?$/.exec(p.trim());
    return { color: (m?.[1] ?? p).trim(), pos: m?.[2] !== undefined ? Number(m[2]) : undefined };
  });
}

function parseFill(css) {
  const t = css.trim();
  const url = /^url\((.*)\)$/i.exec(t);
  if (url) return { kind: "image", url: url[1].replace(/^["']|["']$/g, "") };
  const g = /^(linear|radial|conic)-gradient\((.*)\)$/is.exec(t);
  if (!g) return COLOR.test(t) ? { kind: "solid", color: t } : { kind: "css", css: t };
  const args = splitTop(g[2]);
  const kind = g[1].toLowerCase();
  let cfg = args[0].replace(/\bin\s+[a-z-]+(\s+(shorter|longer|increasing|decreasing)\s+hue)?/i, "").trim();
  const isCfg = (a) => /^(to\s|from\s|at\s|circle|ellipse|closest|farthest|-?[\d.]+(deg|turn|rad|grad)\b)/i.test(a) || a === "";
  const out = { kind, angle: 180, x: 50, y: 50, shape: "circle" };
  let rest = args;
  if (isCfg(cfg)) {
    rest = args.slice(1);
    const deg = /(-?[\d.]+)(deg|turn|rad|grad)/i.exec(cfg);
    if (deg) out.angle = round(Number(deg[1]) * { deg: 1, turn: 360, rad: 57.2958, grad: 0.9 }[deg[2].toLowerCase()], 1);
    const to = /\bto\s+([a-z ]+)/i.exec(cfg);
    if (to && SIDES[to[1].trim()] !== undefined) out.angle = SIDES[to[1].trim()];
    const at = /\bat\s+(-?[\d.]+)%\s+(-?[\d.]+)%/i.exec(cfg);
    if (at) Object.assign(out, { x: Number(at[1]), y: Number(at[2]) });
    if (/\bellipse\b/i.test(cfg)) out.shape = "ellipse";
    if (kind === "conic" && !deg) out.angle = 0;
    // A gradient the panel can't show (a size, a named position) stays as CSS.
    if (/closest|farthest|\d+px/i.test(cfg) || (/\bat\b/i.test(cfg) && !at)) return { kind: "css", css: t };
  } else if (kind === "conic") out.angle = 0;
  out.stops = parseStops(rest);
  // A one-colour gradient is a solid fill drawn above others.
  if (kind === "linear" && out.stops.length === 2 && out.stops[0].color === out.stops[1].color && out.stops.every((x) => x.pos === undefined)) return { kind: "solid", color: out.stops[0].color };
  return out;
}

function fillCss(f, under) {
  const stops = () => f.stops.map((x) => (x.pos === undefined ? x.color : `${x.color} ${round(x.pos, 1)}%`)).join(", ");
  if (f.kind === "solid") return under ? `linear-gradient(${f.color}, ${f.color})` : f.color;
  if (f.kind === "linear") return `linear-gradient(${round(f.angle, 1)}deg, ${stops()})`;
  if (f.kind === "radial") return `radial-gradient(${f.shape} at ${round(f.x, 1)}% ${round(f.y, 1)}%, ${stops()})`;
  if (f.kind === "conic") return `conic-gradient(from ${round(f.angle, 1)}deg at ${round(f.x, 1)}% ${round(f.y, 1)}%, ${stops()})`;
  if (f.kind === "image") return `url("${f.url}")`;
  return f.css;
}

/** A layer's fills, top first. */
function fillsOf(style) {
  const fills = [];
  let layers = splitTop(style.backgroundImage ?? "");
  let color = style.backgroundColor;
  if (style.background && !style.backgroundImage && !style.backgroundColor) {
    const parts = splitTop(style.background);
    const last = parts[parts.length - 1];
    if (last && COLOR.test(last.trim()) && !/gradient|url\(/i.test(last)) {
      color = last.trim();
      parts.pop();
    }
    layers = parts;
  }
  for (const l of layers) if (l && l !== "none") fills.push(parseFill(l));
  if (color && color !== "transparent") fills.push({ kind: "solid", color });
  const sizes = splitTop(style.backgroundSize ?? "");
  fills.forEach((f, i) => f.kind === "image" && (f.size = sizes[i] || "cover"));
  return fills;
}

function fillsStyle(fills) {
  const bottom = fills[fills.length - 1];
  const solidBottom = bottom?.kind === "solid";
  const layers = solidBottom ? fills.slice(0, -1) : fills;
  const images = layers.some((f) => f.kind === "image");
  return {
    background: null,
    backgroundColor: solidBottom ? bottom.color : null,
    backgroundImage: layers.length ? layers.map((f) => fillCss(f, true)).join(", ") : null,
    backgroundSize: images ? layers.map((f) => (f.kind === "image" ? f.size || "cover" : "auto")).join(", ") : null,
    backgroundPosition: images ? layers.map(() => "center").join(", ") : null,
    backgroundRepeat: images ? layers.map((f) => (f.kind === "image" && f.size === "auto" ? "repeat" : "no-repeat")).join(", ") : null,
  };
}

const FILL_KINDS = [
  { value: "solid", label: "Solid" },
  { value: "linear", label: "Linear" },
  { value: "radial", label: "Radial" },
  { value: "conic", label: "Conic" },
  { value: "image", label: "Image" },
];

/** A fill turned into another kind, keeping its colours. */
function asKind(f, kind) {
  const colors = f.kind === "solid" ? [f.color, "transparent"] : f.stops ? f.stops.map((x) => x.color) : ["#ffffff", "#000000"];
  if (kind === "solid") return { kind, color: f.kind === "solid" ? f.color : colors[0] };
  if (kind === "image") return { kind, url: f.url ?? "", size: "cover" };
  // From a solid colour: that colour fading out (a token's can't take an alpha, so it fades to transparent).
  const fade = (c) => (/^#[0-9a-f]{6}$/i.test(c) ? `${c}00` : "transparent");
  const stops = f.stops ?? [{ color: colors[0], pos: 0 }, { color: colors[1] === "transparent" && f.kind === "solid" ? fade(colors[0]) : colors[1], pos: 100 }];
  return { kind, angle: kind === "conic" ? 0 : f.angle ?? 180, x: f.x ?? 50, y: f.y ?? 50, shape: f.shape ?? "circle", stops };
}

// Each fill, shadow and filter is one short row; its details open in a popover.

// The squares behind a see-through colour, in the theme's greys (styles.css).
const CHECK = "var(--check-sm)";

/** A row that opens its editor in a popover: a swatch, a summary, and a remove button. */
function PopRow({ swatch, label, sub, onRemove, children, width = 264, removeTitle = "Remove", title = "Edit" }) {
  const ref = useRef();
  const [open, setOpen] = useState(false);
  return html`<div class="bd-prow ${open ? "open" : ""}">
    <button class="bd-prow-main" ref=${ref} onClick=${() => setOpen(!open)} title=${title}>
      ${swatch !== undefined && html`<span class="bd-swatch" style=${{ background: swatch ? `${swatch}, ${CHECK}` : CHECK }}></span>`}
      <span class="lbl">${label}</span>
      ${sub && html`<span class="sub">${sub}</span>`}
    </button>
    <button class="icon-btn sm" title=${removeTitle} onClick=${onRemove}><${Icon} n="minus" s=${14} /></button>
    ${open && html`<${Popover} anchor=${ref.current} onClose=${() => setOpen(false)} width=${width} align="end"><div class="bd-pop-edit">${children}</div><//>`}
  </div>`;
}

const solidSwatch = (c) => `linear-gradient(${c}, ${c})`;
const fillLabel = (f) =>
  f.kind === "solid" ? tokenTag(f.color) ?? f.color : f.kind === "image" ? (f.url ?? "").split("/").pop() || "Picture" : f.kind === "css" ? "CSS" : `${f.kind[0].toUpperCase()}${f.kind.slice(1)}`;
const fillSub = (f) => (f.kind === "linear" ? `${round(f.angle, 1)}°` : f.kind === "image" ? { cover: "Fill", contain: "Fit", auto: "Tile" }[f.size ?? "cover"] : f.stops ? `${f.stops.length} colours` : "");

function FillSection() {
  const list = ids();
  const n = node(list[0]);
  const fills = fillsOf(n.style);
  const put = (next, key) => setStyle(fillsStyle(next), key);
  const add = () => put([fills.length ? { kind: "linear", angle: 180, stops: [{ color: "rgba(0,0,0,0)", pos: 0 }, { color: "rgba(0,0,0,0.4)", pos: 100 }] } : { kind: "solid", color: "#ffffff" }, ...fills]);
  return html`<${Section} title="Fill" right=${html`<button class="icon-btn sm" title=${fills.length ? "Add a fill on top" : "Add a fill"} onClick=${add}><${Icon} n="plus" s=${14} /></button>`}>
    ${fills.map((f, i) => {
      const set = (patch, key) => put(fills.map((x, j) => (j === i ? { ...x, ...patch } : x)), key && `fill${i}:${key}`);
      // Swatches are drawn through the board's tokens, as the canvas draws the fill.
      const swatch = f.kind === "image" ? (f.url ? `url("${f.url.startsWith("/") ? fileUrl(f.url) : f.url}") center / cover` : "") : f.kind === "solid" ? solidSwatch(paint(f.color)) : f.stops ? fillCss({ ...f, stops: f.stops.map((x) => ({ ...x, color: paint(x.color) })) }, true) : resolveVars(fillCss(f, true), B.board.tokens);
      return html`<${PopRow} key=${i} swatch=${swatch} label=${fillLabel(f)} sub=${fillSub(f)} removeTitle="Remove this fill" onRemove=${() => put(fills.filter((_, j) => j !== i))}>
        ${f.kind === "css"
          ? html`<textarea class="textarea bd-mono" rows="3" onKeyDown=${(e) => e.stopPropagation()} onChange=${(e) => set({ css: e.target.value.trim() })}>${f.css}</textarea>`
          : html`<${Seg} value=${f.kind} options=${FILL_KINDS} onChange=${(kind) => put(fills.map((x, j) => (j === i ? asKind(x, kind) : x)))} />
            ${f.kind === "solid" && html`<${BoardPicker} value=${f.color} onChange=${(c) => c && set({ color: c }, "c")} />`}
            ${f.stops && html`<${Gradient} f=${f} set=${set} />`}
            ${f.kind === "image" && html`<${ImageFill} f=${f} set=${set} />`}`}
      <//>`;
    })}
  <//>`;
}

function Gradient({ f, set }) {
  const stops = f.stops;
  const [active, setActive] = useState(0);
  const at = (i) => stops[i].pos ?? Math.round((i / Math.max(1, stops.length - 1)) * 100);
  const cur = Math.min(active, stops.length - 1);
  const setStop = (i, patch, key) => set({ stops: stops.map((x, j) => (j === i ? { ...x, pos: at(j), ...patch } : x)) }, key && `s${i}${key}`);
  const bar = useRef();
  // The stops sit on a strip of the gradient: drag one along it, click the strip to add one.
  const dragStop = (i) => (e) => {
    e.preventDefault();
    e.stopPropagation();
    setActive(i);
    const r = bar.current.getBoundingClientRect();
    const move = (ev) => setStop(i, { pos: Math.round(Math.max(0, Math.min(100, ((ev.clientX - r.left) / r.width) * 100))) }, "drag");
    const up = () => (removeEventListener("pointermove", move), removeEventListener("pointerup", up));
    addEventListener("pointermove", move);
    addEventListener("pointerup", up);
  };
  const addAt = (e) => {
    const r = bar.current.getBoundingClientRect();
    const pos = Math.round(((e.clientX - r.left) / r.width) * 100);
    set({ stops: [...stops.map((x, j) => ({ ...x, pos: at(j) })), { color: stops[cur].color, pos }].sort((a, b) => a.pos - b.pos) });
  };
  return html`<div class="bd-grad">
    <div class="bd-grad-bar" ref=${bar} style=${{ background: `linear-gradient(90deg, ${stops.map((x, i) => `${paint(x.color)} ${at(i)}%`).join(", ")}), ${CHECK}` }} onPointerDown=${addAt} title="Click to add a colour">
      ${stops.map((x, i) => html`<i class=${i === cur ? "on" : ""} style=${{ left: `${at(i)}%`, background: paint(x.color) }} onPointerDown=${dragStop(i)}></i>`)}
    </div>
    <div class="grid2">
      ${f.kind !== "radial" && html`<${Num} label=${html`<${Icon} n="rotate" s=${12} />`} title=${f.kind === "conic" ? "Starts at" : "Angle"} unit="°" value=${f.angle} onChange=${(v) => set({ angle: v ?? 0 }, "a")} />`}
      ${f.kind === "radial" && html`<${Seg} value=${f.shape} options=${[{ value: "circle", label: "Circle" }, { value: "ellipse", label: "Ellipse" }]} onChange=${(v) => set({ shape: v })} />`}
      ${f.kind !== "linear" && html`<div class="bd-xy"><${Num} label="X" unit="%" value=${f.x} onChange=${(v) => set({ x: v ?? 50 }, "x")} /><${Num} label="Y" unit="%" value=${f.y} onChange=${(v) => set({ y: v ?? 50 }, "y")} /></div>`}
    </div>
    <div class="bd-stop-head"><span>Colour ${cur + 1} of ${stops.length}</span>
      <${Num} label="" unit="%" title="Where it sits along the gradient" value=${at(cur)} min=${0} max=${100} onChange=${(v) => setStop(cur, { pos: v ?? 0 }, "p")} />
      <button class="icon-btn sm" title="Remove this colour" disabled=${stops.length <= 2} onClick=${() => (set({ stops: stops.filter((_, j) => j !== cur) }), setActive(0))}><${Icon} n="trash" s=${12} /></button>
    </div>
    <${BoardPicker} value=${stops[cur].color} onChange=${(c) => c && setStop(cur, { color: c }, "c")} />
  </div>`;
}

function ImageFill({ f, set }) {
  const pick = () => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/png,image/jpeg,image/webp,image/gif,image/svg+xml";
    input.onchange = async () => {
      const file = input.files[0];
      if (!file) return;
      try {
        const r = await api(`/api/upload?kind=image&name=${encodeURIComponent(file.name)}`, file, true);
        set({ url: r.path });
      } catch (e) {
        fail(e, "Couldn't add the picture");
      }
    };
    input.click();
  };
  return html`<div class="bd-src"><span title=${f.url}>${(f.url ?? "").split("/").pop() || "No picture"}</span><button class="btn sm" onClick=${pick}>Choose…</button></div>
    <${Seg} value=${f.size ?? "cover"} options=${[{ value: "cover", label: "Fill" }, { value: "contain", label: "Fit" }, { value: "auto", label: "Tile" }]} onChange=${(v) => set({ size: v })} />`;
}

function parseBorder(v) {
  if (!v || v === "none") return null;
  const width = /(-?[\d.]+)px/.exec(v)?.[1];
  const style = /\b(solid|dashed|dotted|double)\b/.exec(v)?.[1] ?? "solid";
  const color = v.replace(/(-?[\d.]+)px/, "").replace(/\b(solid|dashed|dotted|double)\b/, "").trim() || "currentColor";
  return { width: Number(width ?? 1), style, color };
}

/** Border (inside the layer's box, part of its size) or outline (drawn round it, taking no room). */
function LineSection({ kind }) {
  const list = ids();
  const n = node(list[0]);
  const outline = kind === "outline";
  const b = outline
    ? parseBorder(n.style.outline) ?? (n.style.outlineWidth ? { width: px(n.style.outlineWidth) ?? 1, style: n.style.outlineStyle ?? "solid", color: n.style.outlineColor ?? "currentColor" } : null)
    : parseBorder(n.style.border) ?? (n.style.borderWidth || n.style.borderStyle ? { width: px(n.style.borderWidth) ?? 1, style: n.style.borderStyle ?? "solid", color: n.style.borderColor ?? "currentColor" } : null);
  const put = (next, key) =>
    setStyle(
      outline
        ? { outline: next ? `${next.width}px ${next.style} ${next.color}` : null, outlineWidth: null, outlineStyle: null, outlineColor: null, ...(next ? {} : { outlineOffset: null }) }
        : { border: next ? `${next.width}px ${next.style} ${next.color}` : null, borderWidth: null, borderStyle: null, borderColor: null },
      key,
    );
  const offset = px(n.style.outlineOffset) ?? 0;
  return html`<${Section} title=${outline ? "Outline" : "Border"} right=${b ? html`<button class="icon-btn sm" title=${`Remove the ${kind}`} onClick=${() => put(null)}><${Icon} n="minus" s=${14} /></button>` : html`<button class="icon-btn sm" title=${outline ? "Add an outline: a line round the layer that takes no room" : "Add a border"} onClick=${() => put({ width: outline ? 2 : 1, style: "solid", color: outline ? "#4c8dff" : "#e4e4e7" })}><${Icon} n="plus" s=${14} /></button>`}>
    ${b &&
    html`<div class="bd-line">
        <${BoardColor} value=${b.color === "currentColor" ? undefined : b.color} auto="Text colour" onChange=${(c) => put({ ...b, color: c ?? "currentColor" }, `${kind}c`)} />
        <${Num} label="W" title="Width" value=${b.width} min=${0} onChange=${(v) => put({ ...b, width: v ?? 0 }, `${kind}w`)} />
      </div>
      <div class="grid2">
        <${Dropdown} value=${b.style} options=${["solid", "dashed", "dotted", "double"].map((v) => ({ value: v, label: v[0].toUpperCase() + v.slice(1) }))} onChange=${(v) => put({ ...b, style: v })} />
        ${outline && html`<${Num} label="Gap" title="How far out from the layer" value=${offset} onChange=${(v) => setStyle({ outlineOffset: v ? `${v}px` : null }, "oo")} />`}
      </div>`}
  <//>`;
}

function parseShadow(one) {
  const t = one.trim();
  const inset = /\binset\b/.test(t);
  const bare = t.replace(/\binset\b/, "").trim();
  const colorMatch = /(rgba?\([^)]*\)|hsla?\([^)]*\)|oklch\([^)]*\)|#[0-9a-f]{3,8}\b|var\([^)]*\)|\b[a-z]+\b(?![(\d]))/i.exec(bare);
  const color = colorMatch?.[1] ?? "rgba(0,0,0,0.2)";
  const nums = bare.replace(color, "").trim().split(/\s+/).filter(Boolean).map((x) => px(x) ?? 0);
  return { x: nums[0] ?? 0, y: nums[1] ?? 0, blur: nums[2] ?? 0, spread: nums[3] ?? 0, color, inset };
}
const shadowsOf = (v) => (!v || v === "none" ? [] : splitTop(v).map(parseShadow));

/** Shadows: a list, each outside the layer or inside it. Text gets text shadows. */
function ShadowSection() {
  const list = ids();
  const n = node(list[0]);
  const text = n.type === "text";
  const prop = text ? "textShadow" : "boxShadow";
  const all = shadowsOf(n.style[prop]);
  const css = (s) => (text ? `${s.x}px ${s.y}px ${s.blur}px ${s.color}` : `${s.inset ? "inset " : ""}${s.x}px ${s.y}px ${s.blur}px ${s.spread}px ${s.color}`);
  const put = (next, key) => setStyle({ [prop]: next.length ? next.map(css).join(", ") : null }, key);
  const add = () => put([...all, all.length ? { x: 0, y: 1, blur: 2, spread: 0, color: "rgba(0,0,0,0.08)", inset: false } : { x: 0, y: 8, blur: 24, spread: 0, color: "rgba(0,0,0,0.12)", inset: false }]);
  return html`<${Section} title="Shadow" right=${html`<button class="icon-btn sm" title="Add a shadow" onClick=${add}><${Icon} n="plus" s=${14} /></button>`}>
    ${all.map((s, i) => {
      const set = (patch, key) => put(all.map((x, j) => (j === i ? { ...x, ...patch } : x)), key && `sh${i}${key}`);
      // A token's name says more than the numbers (which are in the popover), and both don't fit.
      return html`<${PopRow} key=${i} swatch=${solidSwatch(paint(s.color))} label=${text ? "Text shadow" : s.inset ? "Inner shadow" : "Drop shadow"} sub=${tokenTag(s.color) ?? `${s.x}, ${s.y}, ${s.blur}`} title=${`${s.x}, ${s.y}, ${s.blur} ${s.color}`} removeTitle="Remove this shadow" onRemove=${() => put(all.filter((_, j) => j !== i))}>
        ${!text && html`<${Seg} value=${s.inset ? "in" : "out"} options=${[{ value: "out", label: "Outside" }, { value: "in", label: "Inside" }]} onChange=${(v) => set({ inset: v === "in" })} />`}
        <div class="grid2">
          <${Num} label="X" value=${s.x} onChange=${(v) => set({ x: v ?? 0 }, "x")} />
          <${Num} label="Y" value=${s.y} onChange=${(v) => set({ y: v ?? 0 }, "y")} />
          <${Num} label="Blur" value=${s.blur} min=${0} onChange=${(v) => set({ blur: v ?? 0 }, "b")} />
          ${!text && html`<${Num} label="Spread" value=${s.spread} onChange=${(v) => set({ spread: v ?? 0 }, "s")} />`}
        </div>
        <${BoardPicker} value=${s.color} onChange=${(c) => c && set({ color: c }, "c")} />
      <//>`;
    })}
  <//>`;
}

// Filters: CSS filter functions on the layer, or behind it (backdrop-filter), as Paper has them.
const FILTERS = [
  { id: "blur", label: "Blur", unit: "px", min: 0, max: 100, def: 4 },
  { id: "brightness", label: "Brightness", unit: "%", min: 0, max: 300, def: 120 },
  { id: "contrast", label: "Contrast", unit: "%", min: 0, max: 300, def: 120 },
  { id: "grayscale", label: "Grayscale", unit: "%", min: 0, max: 100, def: 100 },
  { id: "hue-rotate", label: "Hue rotate", unit: "deg", min: -180, max: 180, def: 90 },
  { id: "invert", label: "Invert", unit: "%", min: 0, max: 100, def: 100 },
  { id: "saturate", label: "Saturation", unit: "%", min: 0, max: 300, def: 150 },
  { id: "sepia", label: "Sepia", unit: "%", min: 0, max: 100, def: 100 },
  { id: "opacity", label: "Opacity", unit: "%", min: 0, max: 100, def: 60 },
];

/** "blur(4px) drop-shadow(0 1px 2px rgba(0,0,0,.2))" → [{fn, value, raw}], keeping brackets inside brackets. */
function parseFilters(v) {
  const out = [];
  if (!v || v === "none") return out;
  let depth = 0;
  let cur = "";
  for (const ch of v.trim()) {
    cur += ch;
    if (ch === "(") depth++;
    if (ch === ")") {
      depth--;
      if (depth === 0) {
        const m = /^\s*([a-z-]+)\((.*)\)\s*$/is.exec(cur);
        if (m) {
          const def = FILTERS.find((f) => f.id === m[1].toLowerCase());
          const num = parseFloat(m[2]);
          out.push(def && !Number.isNaN(num) ? { fn: def.id, value: def.unit === "%" && !/%/.test(m[2]) && def.id !== "blur" ? num * 100 : num } : { fn: m[1], raw: cur.trim() });
        }
        cur = "";
      }
    }
  }
  return out;
}
const filterCss = (list) => list.map((f) => f.raw ?? `${f.fn}(${round(f.value, 2)}${FILTERS.find((d) => d.id === f.fn)?.unit ?? ""})`).join(" ") || null;

function FiltersSection() {
  const list = ids();
  const n = node(list[0]);
  const layer = parseFilters(n.style.filter);
  const back = parseFilters(n.style.backdropFilter ?? n.style.WebkitBackdropFilter ?? n.style.webkitBackdropFilter);
  const all = [...layer.map((f) => ({ ...f, on: "layer" })), ...back.map((f) => ({ ...f, on: "backdrop" }))];
  const put = (next, key) => {
    const l = filterCss(next.filter((f) => f.on === "layer"));
    const b = filterCss(next.filter((f) => f.on === "backdrop"));
    setStyle({ filter: l, backdropFilter: b, WebkitBackdropFilter: b, webkitBackdropFilter: null }, key);
  };
  const add = () => put([...all, { fn: "blur", value: 4, on: "layer" }]);
  return html`<${Section} title="Filters" right=${html`<button class="icon-btn sm" title="Add a filter: blur, brightness, contrast and more, on the layer or behind it" onClick=${add}><${Icon} n="plus" s=${14} /></button>`}>
    ${all.map((f, i) => {
      const def = FILTERS.find((d) => d.id === f.fn);
      const set = (patch, key) => put(all.map((x, j) => (j === i ? { ...x, ...patch } : x)), key && `flt${i}${key}`);
      const label = def ? `${f.on === "backdrop" ? "Backdrop " : ""}${f.on === "backdrop" ? def.label.toLowerCase() : def.label}` : f.fn;
      return html`<${PopRow} key=${i} label=${label} sub=${def ? `${round(f.value, 1)}${def.unit === "deg" ? "°" : def.unit}` : "CSS"} removeTitle="Remove this filter" onRemove=${() => put(all.filter((_, j) => j !== i))}>
        ${def
          ? html`<${Seg} value=${f.on} options=${[{ value: "layer", label: "The layer" }, { value: "backdrop", label: "Behind it" }]} onChange=${(on) => set({ on })} />
            <${Dropdown} value=${f.fn} options=${FILTERS.map((d) => ({ value: d.id, label: d.label }))} onChange=${(fn) => set({ fn, value: FILTERS.find((d) => d.id === fn).def })} />
            <${Slider} value=${f.value} min=${def.min} max=${def.max} step=${def.unit === "px" ? 0.5 : 1} format=${(v) => `${round(v, 1)}${def.unit === "deg" ? "°" : def.unit}`} onChange=${(v) => set({ value: v }, "v")} />
            ${f.on === "backdrop" && html`<p class="bd-note">Blurs or tints what shows through the layer: give it a see-through fill, like frosted glass.</p>`}`
          : html`<p class="bd-note bd-mono">${f.raw}</p>`}
      <//>`;
    })}
  <//>`;
}

// Selection colours: every colour used in the selection, tokens too, to change them all at once.
const COLOR_RE = /#[0-9a-f]{3,8}\b|rgba?\([^)]*\)|hsla?\([^)]*\)|oklch\([^)]*\)|var\(\s*--[A-Za-z0-9_-]+\s*\)/gi;
const HAS_COLOR = new RegExp(COLOR_RE.source, "i");
/** A token keeps its name as written (names are case-sensitive in CSS); a colour is the same in any case. */
const isVar = (c) => /^var\(/i.test(c);
function SelectionColors() {
  const list = ids();
  const found = new Map();
  const add = (c, use) => {
    const key = isVar(c) ? c : c.toLowerCase();
    found.set(key, [...(found.get(key) ?? []), use]);
  };
  const scan = (v, use) => {
    for (const m of String(v ?? "").matchAll(COLOR_RE)) add(m[0], use);
  };
  for (const id of list)
    for (const x of subtree(B.board, id)) {
      const n = node(x);
      for (const [k, v] of Object.entries(n.style)) scan(v, { id: x, k });
      scan(n.text, { id: x, k: "text" });
      for (const [k, v] of Object.entries(n.attrs ?? {})) scan(v, { id: x, k: `attrs.${k}` });
      scan(n.defs, { id: x, k: "defs" });
      if (n.shape) for (const k of ["fill", "stroke", "labelColor"]) if (typeof n.shape[k] === "string" && HAS_COLOR.test(n.shape[k])) add(n.shape[k], { id: x, k: `shape.${k}` });
    }
  if (found.size < 2) return null;
  const replace = (from, to, key) => {
    const ops = new Map();
    for (const { id, k } of found.get(from)) {
      const n = node(id);
      const op = ops.get(id) ?? { op: "set", id };
      const swap = (v) => v.replace(new RegExp(from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), isVar(from) ? "g" : "gi"), to);
      if (k === "text") op.text = swap(op.text ?? n.text);
      else if (k === "defs") op.defs = swap(op.defs ?? n.defs);
      else if (k.startsWith("attrs.")) (op.attrs ??= {})[k.slice(6)] = swap(op.attrs?.[k.slice(6)] ?? n.attrs[k.slice(6)]);
      else if (k.startsWith("shape.")) op.shape = { ...(op.shape ?? n.shape), [k.slice(6)]: to };
      else (op.style ??= {})[k] = swap(op.style?.[k] ?? n.style[k]);
      ops.set(id, op);
    }
    commit([...ops.values()], { key: `selcolor:${key}`, label: "Colour" });
  };
  return html`<${Section} title="Selection colours" count=${found.size} collapsible open=${false} id="board-selcolors">
    ${[...found.entries()].slice(0, 12).map(([c, uses]) => html`<div class="bd-selcolor" key=${c}><${BoardColor} value=${c} allowAuto=${false} onChange=${(to) => to && replace(c, to, c)} /><span class="n">${uses.length}×</span></div>`)}
  <//>`;
}

// A shape (an arrow, a star, a badge…): its own settings, drawn again as they change.
const SHAPE_NAMES = { arrow: "Arrow", line: "Line", ellipse: "Ellipse", rect: "Box", triangle: "Triangle", star: "Star", badge: "Number badge", laurel: "Laurel", rating: "Rating", burst: "Burst", ribbon: "Ribbon", bubble: "Bubble", tag: "Tag" };
function ShapeSection() {
  const id = ids()[0];
  const n = node(id);
  const sh = n.shape;
  const t = sh.type;
  const set = (patch, key) => commit([{ op: "set", id, shape: { ...sh, ...patch } }], { key: key ? `shape:${id}:${key}` : null, label: "Shape" });
  const line = t === "arrow" || t === "line";
  const words = ["laurel", "rating", "burst", "ribbon", "bubble", "tag"].includes(t);
  return html`<${Section} title=${SHAPE_NAMES[t] ?? "Shape"}>
    ${!line && html`<div class="row"><label>Fill</label><${BoardColor} value=${sh.fill && sh.fill !== "none" ? sh.fill : undefined} auto="None" onChange=${(c) => set({ fill: c ?? "none" }, "fill")} /></div>`}
    ${!words && html`<div class="row"><label>Stroke</label><${BoardColor} value=${sh.stroke && sh.stroke !== "none" ? sh.stroke : undefined} auto="None" onChange=${(c) => set({ stroke: c ?? "none" }, "stroke")} /></div>
      ${sh.stroke && sh.stroke !== "none" && html`<div class="grid2">
        <${Num} label="W" title="Stroke width" value=${sh.strokeWidth ?? 4} min=${0} onChange=${(v) => set({ strokeWidth: v ?? 0 }, "sw")} />
        <${Dropdown} value=${sh.dash ?? "solid"} options=${[{ value: "solid", label: "Solid" }, { value: "dashed", label: "Dashed" }, { value: "dotted", label: "Dotted" }]} onChange=${(v) => set({ dash: v })} />
      </div>`}`}
    ${line && html`<div class="grid2">
        <${Dropdown} value=${sh.head ?? (t === "arrow" ? "end" : "none")} options=${[{ value: "end", label: "Head at the end" }, { value: "start", label: "At the start" }, { value: "both", label: "Both ends" }, { value: "none", label: "No heads" }]} onChange=${(v) => set({ head: v })} />
        <${Num} label="Bend" title="How far it curves (-100 to 100)" value=${Math.round((sh.bend ?? 0) * 100)} min=${-100} max=${100} onChange=${(v) => set({ bend: (v ?? 0) / 100 }, "bend")} />
      </div>`}
    ${t === "star" && html`<${Num} label="Points" value=${sh.points ?? 5} min=${3} max=${12} onChange=${(v) => set({ points: v ?? 5 }, "pts")} />`}
    ${t === "rect" && html`<${Num} label="Round" title="Corner rounding, % of the shorter side" unit="%" value=${Math.round((sh.radius ?? 0) * 100)} min=${0} max=${50} onChange=${(v) => set({ radius: (v ?? 0) / 100 }, "rad")} />`}
    ${t === "badge" && html`<div class="row"><label>Label</label><input class="input" value=${sh.label ?? "1"} maxLength="4" onKeyDown=${(e) => e.stopPropagation()} onInput=${(e) => set({ label: e.target.value }, "label")} /></div>`}
    ${words && html`<div class="row"><label>Words</label><input class="input" value=${sh.text ?? ""} onKeyDown=${(e) => e.stopPropagation()} onInput=${(e) => set({ text: e.target.value }, "text")} /></div>`}
    ${t === "laurel" && html`<div class="row"><label>Under it</label><input class="input" value=${sh.caption ?? ""} placeholder="App Store" onKeyDown=${(e) => e.stopPropagation()} onInput=${(e) => set({ caption: e.target.value }, "cap")} /></div>`}
    ${t === "rating" && html`<${Num} label="Stars" digits=${1} step=${0.1} value=${sh.value ?? 5} min=${0} max=${5} onChange=${(v) => set({ value: v ?? 5 }, "val")} />`}
    ${(t === "badge" || words) && html`<div class="row"><label>Words colour</label><${BoardColor} value=${sh.labelColor} allowAuto=${false} onChange=${(c) => c && set({ labelColor: c }, "lc")} /></div>`}
    <div class="bd-flex-opts">
      ${!words && html`<label class="bd-check"><input type="checkbox" checked=${Boolean(sh.sketch)} onChange=${(e) => set({ sketch: e.target.checked })} />Hand-drawn</label>`}
      <label class="bd-check"><input type="checkbox" checked=${Boolean(sh.shadow)} onChange=${(e) => set({ shadow: e.target.checked })} />Shadow</label>
    </div>
  <//>`;
}

/** A vector without shape settings (an icon, an illustration): its colour, for the parts drawn in "currentColor". */
function VectorSection() {
  const list = ids();
  const n = node(list[0]);
  const inParts = !n.svg;
  const tintable = /currentColor/i.test(n.svg ?? "") || subtree(B.board, n.id).some((x) => /currentColor/i.test(JSON.stringify(node(x).attrs ?? {}) + (node(x).defs ?? "")));
  const count = subtree(B.board, n.id).length - 1;
  return html`<${Section} title="Vector">
    ${tintable
      ? html`<div class="row"><label>Colour</label><${BoardColor} value=${n.style.color} auto="Inherited" onChange=${(c) => setStyle({ color: c ?? null }, "vc")} /></div>`
      : html`<p class="bd-note">${inParts ? `In ${count} part${count === 1 ? "" : "s"}: pick one on the canvas (double-click, or ⌘-click) to change it.` : "Drawn in its own colours, as one piece. Filters below can still shift them."}</p>`}
    ${list.length === 1 &&
    (inParts
      ? html`<button class="btn sm ghost" title="Make it one layer again (its parts become SVG markup)" onClick=${() => flattenVector(n.id)}>Make one piece</button>`
      : html`<button class="btn sm ghost" title="A layer for each of its shapes, paths and groups" onClick=${() => splitVector(n.id)}>Split into layers</button>`)}
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
  const typing = B.editing && list.includes(B.editing);
  return html`<${Section} title="Text">
    ${typing && html`<${WordBar} />`}
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
      <${Num} label="Size" value=${size === "mixed" ? undefined : size} placeholder=${size === "mixed" ? "—" : "16"} min=${1} onChange=${(v) => v && setStyle({ fontSize: `${v}px` }, "fs")} />
      <${Num} label="Line" title="Line height in px" value=${px(lh) ?? (lh && !isNaN(Number(lh)) ? Math.round(Number(lh) * (px(n.style.fontSize) ?? 16)) : undefined)} placeholder="auto" min=${0} onChange=${(v) => setStyle({ lineHeight: v ? `${v}px` : null }, "lh")} />
      <${Num} label="Letter" title="Letter spacing, in em" digits=${3} step=${0.005} value=${ls ? (/em$/.test(ls) ? parseFloat(ls) : (px(ls) ?? 0) / (px(n.style.fontSize) ?? 16)) : 0} onChange=${(v) => setStyle({ letterSpacing: v ? `${round(v, 3)}em` : null }, "ls")} />
    </div>
    <${Seg} value=${align} options=${[{ value: "left", icon: "alignL", label: "", title: "Left" }, { value: "center", icon: "alignC", label: "", title: "Centre" }, { value: "right", icon: "alignR", label: "", title: "Right" }, { value: "justify", icon: "alignJ", label: "", title: "Justify" }]} onChange=${(v) => setStyle({ textAlign: v === "left" ? null : v })} />
    <${BoardColor} value=${color === "mixed" ? undefined : color} auto=${color === "mixed" ? "Mixed" : "Inherited"} onChange=${(c) => setStyle({ color: c ?? null }, "tc")} />
    <div class="grid2">
      <${Dropdown} value=${n.style.textTransform ?? "none"} options=${[{ value: "none", label: "As typed" }, { value: "uppercase", label: "UPPERCASE" }, { value: "lowercase", label: "lowercase" }, { value: "capitalize", label: "Title Case" }]} onChange=${(v) => setStyle({ textTransform: v === "none" ? null : v })} />
      <${Dropdown} value=${n.style.textDecoration ?? "none"} options=${[{ value: "none", label: "No line" }, { value: "underline", label: "Underline" }, { value: "line-through", label: "Strikethrough" }]} onChange=${(v) => setStyle({ textDecoration: v === "none" ? null : v })} />
    </div>
  <//>`;
}

/** While typing: bold, italic, underline, strikethrough and a colour for the selected words. */
function WordBar() {
  const picked = Boolean(words.range && !words.range.collapsed);
  const keep = (e) => e.preventDefault();
  const btn = (cmd, label, title, style) => html`<button class="bd-word ${wordState(cmd) ? "on" : ""}" title=${title} disabled=${!picked} onPointerDown=${keep} onClick=${() => styleWords(cmd)} style=${style}>${label}</button>`;
  return html`<div class="bd-words" title=${picked ? "" : "Select some words in the text to style them"}>
    <span class="lbl">${picked ? "Selected words" : "Select words to style"}</span>
    ${btn("bold", "B", "Bold (⌘B)", { fontWeight: 700 })}
    ${btn("italic", "I", "Italic (⌘I)", { fontStyle: "italic" })}
    ${btn("underline", "U", "Underline (⌘U)", { textDecoration: "underline" })}
    ${btn("strikeThrough", "S", "Strikethrough", { textDecoration: "line-through" })}
    <${WordColor} picked=${picked} />
  </div>`;
}

/** The colour the selected words have now: a token as its var(), anything else as a colour. */
function wordsColor() {
  let n = words.range?.startContainer;
  if (n?.nodeType === 3) n = n.parentElement;
  for (; n?.nodeType === 1; n = n.parentElement) {
    const c = n.style?.color;
    if (c) return tokenRef(c) ? c : normalizeColor(c) ?? undefined;
    if (n.isContentEditable && !n.parentElement?.isContentEditable) break;
  }
  return undefined;
}

/**
 * A colour for the selected words, from the board's picker (tokens included). Its popover sits
 * inside the word bar and takes no focus from the words, so picking doesn't end the typing.
 */
function WordColor({ picked }) {
  const ref = useRef();
  const [open, setOpen] = useState(false);
  const keep = (e) => e.preventDefault();
  return html`<button class="bd-word color ${picked ? "" : "off"}" ref=${ref} title="Colour" disabled=${!picked} onPointerDown=${keep} onMouseDown=${keep} onClick=${() => setOpen(!open)}><i></i></button>
    ${open &&
    picked &&
    html`<${Popover} anchor=${ref.current} onClose=${() => setOpen(false)} width=${252} align="end">
      <div class="bd-word-pop" tabIndex="-1" onMouseDown=${(e) => !e.target.closest("input") && e.preventDefault()}>
        <${BoardPicker} value=${wordsColor()} onChange=${(c) => c && styleWords("foreColor", c)} />
      </div>
    <//>`}`;
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
// A video: its file, how it fills its box, a player to watch it on the canvas (play, scrub, jump to
// a time), and how it plays in Preview: Figma's autoplay, loop and sound.

const clock = (s) => (Number.isFinite(s) ? `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}` : "0:00");
/** "1:05" → 65, "12" → 12, "0:03.5" → 3.5; null for anything else. */
const parseClock = (text) => {
  const m = /^\s*(?:(\d+):)?(\d+(?:\.\d+)?)\s*$/.exec(text);
  return m ? Number(m[1] ?? 0) * 60 + Number(m[2]) : null;
};

function VideoSection() {
  const id = ids()[0];
  const n = node(id);
  const v = useVideo(id);
  const s = videoSettings(n);
  const track = useRef();
  const [drag, setDrag] = useState(false);
  const dur = v && Number.isFinite(v.duration) ? v.duration : 0;
  const t = v ? v.currentTime : 0;
  const playing = Boolean(v && !v.paused);
  const seek = (ev) => {
    if (!v || !dur) return;
    const r = track.current.getBoundingClientRect();
    v.currentTime = Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width)) * dur;
  };
  const play = (k, on, label) => commit([{ op: "set", id, video: { ...s, [k]: on } }], { label });
  const replace = () => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "video/mp4,video/quicktime,video/webm,.mp4,.m4v,.mov,.webm";
    input.onchange = async () => {
      const f = input.files[0];
      if (!f) return;
      try {
        const r = await api(`/api/upload?kind=video&name=${encodeURIComponent(f.name)}`, f, true);
        commit([{ op: "set", id, src: r.path, poster: r.poster ?? null }], { label: "Replace video" });
      } catch (e) {
        fail(e, "Couldn't add the video");
      }
    };
    input.click();
  };
  const frac = dur ? t / dur : 0;
  return html`<${Section} title="Video">
    <div class="bd-src"><span title=${n.src}>${(n.src ?? "").split("/").pop() || "No video"}</span><button class="btn sm" onClick=${replace}>Replace…</button></div>
    <${Seg} value=${n.style.objectFit ?? "fill"} options=${[{ value: "cover", label: "Fill" }, { value: "contain", label: "Fit" }, { value: "fill", label: "Stretch" }]} onChange=${(val) => setStyle({ objectFit: val === "fill" ? null : val })} />
    <div class="bd-player">
      <button class="icon-btn sm bd-player-play" title=${playing ? "Pause" : "Play it on the canvas"} aria-label=${playing ? "Pause" : "Play"} disabled=${!v} onClick=${() => toggleVideo(id)}><${Icon} n=${playing ? "pause" : "play"} s=${13} /></button>
      <div class="bd-scrub ${drag ? "active" : ""} ${dur ? "" : "off"}" ref=${track}
        onPointerDown=${(e) => {
          if (!dur) return;
          e.preventDefault();
          track.current.setPointerCapture(e.pointerId);
          setDrag(true);
          seek(e);
        }}
        onPointerMove=${(e) => drag && seek(e)} onPointerUp=${() => setDrag(false)} onPointerCancel=${() => setDrag(false)}>
        <div class="bd-scrub-rail"><div class="bd-scrub-fill" style=${{ width: frac * 100 + "%" }}></div></div><div class="bd-scrub-knob" style=${{ left: frac * 100 + "%" }}></div>
      </div>
      <input class="bd-time" value=${clock(t)} title="Go to a time (m:ss)" aria-label="Time" disabled=${!dur} onFocus=${(e) => e.target.select()}
        onKeyDown=${(e) => e.key === "Enter" && e.target.blur()}
        onChange=${(e) => {
          const at = parseClock(e.target.value);
          if (v && at !== null) v.currentTime = Math.min(dur, Math.max(0, at));
          e.target.value = clock(v ? v.currentTime : 0);
        }} /><span class="bd-dur">/ ${clock(dur)}</span>
    </div>
    <div class="bd-video-opts">
      <${Switch} checked=${s.autoplay} label="Autoplay" onChange=${(on) => play("autoplay", on, on ? "Autoplay" : "No autoplay")} />
      <${Switch} checked=${s.loop} label="Loop" onChange=${(on) => play("loop", on, on ? "Loop" : "Play once")} />
      <${Switch} checked=${!s.muted} label="Sound" onChange=${(on) => play("muted", !on, on ? "Sound on" : "Sound off")} />
    </div>
    <p class="bd-note">How it plays in Preview. On the canvas it shows its first frame until you press play.</p>
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
  const b = useBoard(PANEL_SKIPS);
  const page = currentPage();
  const [adding, setAdding] = useState(false);
  const tokens = b.board.tokens;
  const uses = tokenUses(b.board);
  const setToken = (name, value, key) => commit([{ op: "token", name, value }], { key: key ? `token:${name}` : null, label: "Token" });
  return html`<div class="panel-head"><h2>${b.board.name}</h2><span class="sub">${page?.children.length ?? 0} artboard${page?.children.length === 1 ? "" : "s"}</span></div>
    <div class="panel-body bd-insp">
      <${Section} title="Tokens" count=${tokens.length || undefined} right=${html`<button class="icon-btn sm" title="Add a token" onClick=${() => setAdding(true)}><${Icon} n="plus" s=${14} /></button>`}>
        <p class="bd-note">Colours, sizes and fonts with a name. Any layer can use one as <code>var(--name)</code>, so changing it here changes them all. Every colour picker on the board lists the colour ones.</p>
        ${tokens.map((t) => html`<${TokenRow} key=${t.name} t=${t} tokens=${tokens} uses=${uses.get(t.name)} onChange=${(v) => setToken(t.name, v, true)} onRemove=${() => setToken(t.name, null)} onRename=${(to) => renameToken(t.name, to)} />`)}
        ${adding && html`<${NewToken} onDone=${(name, value) => (setAdding(false), name && setToken(name, value || "#000000"))} />`}
      <//>
      <${Section} title="Agents">
        <p class="bd-note">An agent with Screenshotter's tools can design right here while you watch: ask it to “design a sign-up screen on the board ${b.board.name}”. Its changes land as steps you can undo.</p>
        <button class="btn sm block" onClick=${() => navigator.clipboard.writeText(MCP_COMMAND).then(() => toast({ kind: "ok", icon: "copy", title: "Copied the setup command", text: "Run it in a terminal to give Claude Code the tools.", timeout: 4000 }))}><${Icon} n="copy" s=${13} />Copy the setup command</button>
      <//>
      <${Section} title="Shortcuts" collapsible open=${false} id="board-keys">
        <dl class="bd-keys">
          ${[["V K F R T H", "Move, scale, frame, rectangle, text, pan"], ["⇧A", "Wrap in a flex frame (or add flex)"], ["⇧G", "Wrap in a grid (or make the frame one)"], ["⌥⌘G", "Wrap in a frame"], ["⇧⌘G", "Ungroup"], ["Esc / Enter", "Select the parent / the children"], ["Double-click", "The deepest layer under the pointer (and into its words)"], ["⌘ held", "Point at the deepest layer; click to select it"], ["Right-click", "Select layer…: any layer under the pointer"], ["⌘\\", "Hide or show both panels"], ["⇧0 ⇧1 ⇧2", "100%, fit, zoom to selection"], ["⌥⌘C / ⌥⌘V", "Copy / paste styles"]].map(
            ([k, d]) => html`<dt>${k}</dt><dd>${d}</dd>`,
          )}
        </dl>
      <//>
    </div>`;
}

let usesOf = { board: null, uses: new Map() };
/** The layers that use each token (by name): in their CSS, words, SVG or shape settings. */
function tokenUses(board) {
  if (usesOf.board === board) return usesOf.uses;
  const uses = new Map();
  for (const n of Object.values(board.nodes)) {
    const text = [...Object.values(n.style), n.text, n.svg, n.defs, ...Object.values(n.attrs ?? {}), n.shape && JSON.stringify(n.shape)].join(" ");
    if (!text.includes("var(")) continue;
    for (const [, name] of text.matchAll(/var\(\s*(--[A-Za-z0-9_-]+)/g)) {
      if (!uses.has(name)) uses.set(name, []);
      if (!uses.get(name).includes(n.id)) uses.get(name).push(n.id);
    }
  }
  usesOf = { board, uses };
  return uses;
}

/** Select the layers that use a token: those on the page on show, or else those on the first page that has some. */
function selectUses(list) {
  const on = (id) => pageOf(B.board, id)?.id;
  const here = list.filter((id) => on(id) === currentPage()?.id);
  const pick = here.length ? here : list.filter((id) => on(id) === on(list[0]));
  if (!pick.length) return;
  const moved = on(pick[0]) !== currentPage()?.id;
  if (moved) bset({ page: on(pick[0]) });
  select(pick);
  if (moved) requestAnimationFrame(() => fit(pick));
}

/** Rename a token, and every var() that uses it, as one step (copies of components keep following). */
function renameToken(from, to) {
  const name = to.trim().replace(/^--/, "");
  if (!name || `--${name}` === from) return;
  try {
    commit(renameTokenOps(B.board, from, name), { label: "Rename token" });
  } catch (e) {
    toast({ kind: "info", title: "Couldn't rename it", text: e.message, timeout: 4000 });
  }
}

function TokenRow({ t, tokens, uses = [], onChange, onRemove, onRename }) {
  // A colour, or a var() of another token that comes to one.
  const color = Boolean(tokenColor(t.value, tokens));
  const [draft, setDraft] = useState(null);
  const [naming, setNaming] = useState(null);
  const n = uses.length;
  return html`<div class="bd-token">
    ${naming !== null
      ? html`<input class="input bd-mono bd-token-name" autoFocus value=${naming} aria-label="Token name"
          onInput=${(e) => setNaming(e.target.value.replace(/[^A-Za-z0-9_-]/g, "-"))}
          onKeyDown=${(e) => (e.stopPropagation(), e.key === "Enter" && e.target.blur(), e.key === "Escape" && setNaming(null))}
          onBlur=${() => (naming !== null && onRename(naming), setNaming(null))} />`
      : html`<button class="bd-token-name" title=${`${t.name}: click to rename it (everywhere it's used)`} onClick=${() => setNaming(t.name.slice(2))}><code>${t.name.slice(2)}</code></button>`}
    ${color ? html`<${BoardColor} value=${t.value} tokens=${tokens.filter((x) => x.name !== t.name)} onMakeToken=${null} allowAuto=${false} onChange=${(c) => c && onChange(c)} />` : html`<input class="input bd-mono" value=${draft ?? t.value} onInput=${(e) => setDraft(e.target.value)} onKeyDown=${(e) => (e.stopPropagation(), e.key === "Enter" && e.target.blur())} onBlur=${() => (draft !== null && draft.trim() && onChange(draft.trim()), setDraft(null))} />`}
    <button class="bd-uses" disabled=${!n} title=${n ? `Used by ${n} layer${n === 1 ? "" : "s"}: click to select ${n === 1 ? "it" : "them"}` : "No layer uses it yet"} onClick=${() => selectUses(uses)}>${n}×</button>
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

// ---------------------------------------------------------------------------------------------
// Grid: a frame's columns and rows (each track's size), gaps, padding, how its layers sit in their
// cells, and its flow, new tracks and named areas; for a layer in a grid, the cells it takes and how
// it sits in them. The canvas edits the same things (board-grid.js).

const LAYOUTS = [
  { value: "free", icon: "freeLayout", label: "Free", title: "Free: layers sit where you put them" },
  { value: "flex", icon: "flexCol", label: "Flex", title: "Flex (⇧A): a row or a column" },
  { value: "grid", icon: "grid", label: "Grid", title: "Grid (⇧G): rows and columns" },
];

/** Free, flex or grid: how the selected frames lay out their layers. */
function LayoutKind({ list }) {
  const kinds = list.map((id) => layoutOf(node(id)));
  const v = kinds.every((k) => k === kinds[0]) ? kinds[0] : null;
  return html`<${Seg} class="bd-kind" value=${v} options=${LAYOUTS} onChange=${(k) => setLayout(list, k)} />`;
}

const SPOTS = ["start", "center", "end"];
/** Stretch, as a grid has it by default (normal) when nothing else is said. */
const stretched = (v) => !v || v === "normal" || v === "stretch" || v === "auto";

/**
 * Nine spots for where layers sit in their cells: across (justify) and down (align). A layer that
 * stretches across lights its whole row of spots as a bar, one that stretches down its column.
 */
function CellPad({ justify, align, onPick, label }) {
  const sx = stretched(justify);
  const sy = stretched(align);
  return html`<div class="bd-pad bd-cellpad" role="group" aria-label=${label}>
    ${[0, 1, 2].map((r) =>
      [0, 1, 2].map((c) => {
        const on = (sx || alignIndex(justify) === c) && (sy || alignIndex(align) === r);
        return html`<button class="${on ? "on" : ""} ${on && sx ? "sx" : ""} ${on && sy ? "sy" : ""}" title=${`${SPOTS[r] === "start" ? "Top" : SPOTS[r] === "end" ? "Bottom" : "Middle"} ${SPOTS[c] === "start" ? "left" : SPOTS[c] === "end" ? "right" : "centre"}`}
          onClick=${() => onPick(SPOTS[c], SPOTS[r])}><i></i></button>`;
      }),
    )}
  </div>`;
}

/** A CSS value typed in (a track size, say): kept on Enter or leaving the field, if CSS takes it for `prop`. */
function CssInput({ label, value, placeholder, prop, onChange, title }) {
  const [draft, setDraft] = useState(null);
  const done = (text) => {
    setDraft(null);
    const v = text.trim();
    if (v === (value ?? "")) return;
    if (v && globalThis.CSS?.supports && !CSS.supports(kebabProp(prop), v)) return toast({ kind: "info", title: `“${v}” isn't a size CSS knows here`, text: "Try 1fr, 240px, auto, min-content or minmax(120px, 1fr).", timeout: 3600 });
    onChange(v);
  };
  return html`<label class="num bd-css-in" title=${title}>
    <span class="scrub">${label}</span>
    <input class="bd-mono" value=${draft ?? value ?? ""} placeholder=${placeholder} spellcheck=${false}
      onInput=${(e) => setDraft(e.target.value)} onBlur=${(e) => draft !== null && done(e.target.value)}
      onKeyDown=${(e) => {
        e.stopPropagation();
        if (e.key === "Enter") e.target.blur();
        if (e.key === "Escape") (setDraft(null), requestAnimationFrame(() => e.target.blur()));
      }} />
  </label>`;
}
const kebabProp = (k) => k.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase());

const TRACK_KINDS = [
  { value: "fr", label: "Fill · fr" },
  { value: "px", label: "Fixed · px" },
  { value: "auto", label: "Hug · auto" },
  { value: "min-content", label: "Min content" },
  { value: "max-content", label: "Max content" },
  { value: "minmax", label: "Range" },
  { value: "fit-content", label: "Up to" },
  { value: "percent", label: "Percent" },
  { value: "other", label: "As written" },
];

/** One track's editor: its kind of size and the numbers for it, the CSS as written, and moving, adding and deleting. */
function TrackEditor({ list, axis, i, onClose }) {
  const id = list[0];
  const g = gridOf(node(id).style);
  const t = g[axis].tracks[i];
  if (!t) return null;
  const A = GRID_AXES[axis];
  const geo = gridGeometry(id);
  const drawnList = axis === "columns" ? geo?.cols : geo?.rows;
  const drawn = drawnList?.[i]?.size;
  const room = geo ? (axis === "columns" ? geo.content.width : geo.content.height) / geo.z : 0;
  const keyed = (k) => `track:${axis}:${i}:${k}:${list.join()}`;
  const apply = (size, k) => changeGrids(list, (x) => trackSizeOps(x, axis, i, size), { label: "Grid", key: k ? keyed(k) : null });
  const run = (make, label) => {
    changeGrids(list, make, { label });
    onClose();
  };
  if (t.auto) {
    const [min = "200px", max = "1fr"] = trackArgs(t.size) ?? [t.size];
    return html`<div class="bd-track-edit">
      <div class="hd"><b>${A.Word}s</b><span class="sub">${drawnList?.length ?? "?"} fit now</span></div>
      <${Seg} value=${t.auto} options=${[{ value: "auto-fill", label: "Fill", title: "Keep empty tracks at the end" }, { value: "auto-fit", label: "Fit", title: "Let what's there stretch over the empty tracks" }]}
        onChange=${(v) => changeGrids(list, (x) => [{ op: "set", id: x, style: gridPatch(node(x).style, { [axis]: { tracks: [{ ...t, auto: v }] } }) }], { label: "Grid" })} />
      <div class="grid2">
        <${Num} label="Min" title=${`Each ${A.word} at least`} value=${pxValue(min)} unit="px" min=${1} onChange=${(v) => v && apply(`minmax(${Math.round(v)}px, ${max})`, "min")} />
        <${CssInput} label="Max" value=${max} prop="gridTemplateColumns" onChange=${(v) => apply(`minmax(${min}, ${v || "1fr"})`)} />
      </div>
      <p class="bd-note">As many ${A.word}s as fit, each at least ${trackLabel(min)} wide${axis === "rows" ? " (tall)" : ""}.</p>
      <button class="btn sm ghost" onClick=${() => run((x) => trackCountOps(x, axis, drawnList?.length ?? 3), "Grid")}>A set number of ${A.word}s</button>
    </div>`;
  }
  const kind = trackKind(t.size);
  const to = (k) => {
    const d = Math.max(1, Math.round(drawn ?? 120));
    return { fr: "1fr", px: `${d}px`, auto: "auto", "min-content": "min-content", "max-content": "max-content", minmax: `minmax(${d}px, 1fr)`, "fit-content": `fit-content(${d}px)`, percent: `${round(room ? (d / room) * 100 : 25, 1)}%`, other: t.size }[k];
  };
  const args = trackArgs(t.size) ?? [];
  return html`<div class="bd-track-edit">
    <div class="hd"><b>${A.Word} ${i + 1}</b><span class="sub">${drawn !== undefined ? `${round(drawn, 1)} px drawn` : ""}</span>
      <span class="spacer"></span><button class="icon-btn sm" title="Close" onClick=${onClose}><${Icon} n="x" s=${12} /></button></div>
    <div class="grid2">
      <${Dropdown} value=${kind} options=${TRACK_KINDS} onChange=${(k) => k !== kind && apply(to(k))} title="How its size is set" />
      ${kind === "fr" && html`<${Num} label="fr" title="Its share of the room left" value=${parseFloat(t.size)} digits=${2} step=${0.25} min=${0.05} onChange=${(v) => v && apply(`${round(v, 2)}fr`, "fr")} />`}
      ${kind === "px" && html`<${Num} label="px" title="Its size" value=${pxValue(t.size)} min=${0} onChange=${(v) => v !== undefined && apply(`${Math.round(v)}px`, "px")} />`}
      ${kind === "percent" && html`<${Num} label="%" title="Its share of the frame" value=${parseFloat(t.size)} digits=${1} min=${0} max=${100} onChange=${(v) => v !== undefined && apply(`${round(v, 1)}%`, "pc")} />`}
      ${kind === "fit-content" && html`<${Num} label="≤" title="At most" value=${pxValue(args[0])} unit="px" min=${0} onChange=${(v) => v !== undefined && apply(`fit-content(${Math.round(v)}px)`, "fit")} />`}
      ${/^(auto|min-content|max-content)$/.test(kind) && html`<span class="bd-track-drawn">${drawn !== undefined ? `${round(drawn, 1)} px` : ""}</span>`}
    </div>
    ${kind === "minmax" && html`<div class="grid2">
      <${CssInput} label="Least" value=${args[0]} prop="gridTemplateColumns" onChange=${(v) => apply(`minmax(${v || "0px"}, ${args[1] ?? "1fr"})`)} />
      <${CssInput} label="Most" value=${args[1]} prop="gridTemplateColumns" onChange=${(v) => apply(`minmax(${args[0] ?? "0px"}, ${v || "1fr"})`)} />
    </div>`}
    <${CssInput} label="CSS" title="The track's size as written" value=${t.size} prop="gridTemplateColumns" onChange=${(v) => v && apply(v)} />
    <div class="bd-track-acts">
      <button class="icon-btn sm" title=${`Move ${A.before}`} disabled=${i === 0} onClick=${() => run((x) => moveTrackOps(x, axis, i, i - 1), `Move a ${A.word}`)}><${Icon} n=${axis === "columns" ? "left" : "up"} s=${13} /></button>
      <button class="icon-btn sm" title=${`Move ${A.after}`} disabled=${i >= g[axis].tracks.length - 1} onClick=${() => run((x) => moveTrackOps(x, axis, i, i + 1), `Move a ${A.word}`)}><${Icon} n=${axis === "columns" ? "right" : "down"} s=${13} /></button>
      <button class="btn sm ghost" title=${`Add a ${A.word} ${A.before} this one`} onClick=${() => run((x) => insertTrackOps(x, axis, i), `Add a ${A.word}`)}><${Icon} n="plus" s=${11} />${A.Before}</button>
      <button class="btn sm ghost" title=${`Add a ${A.word} ${A.after} this one`} onClick=${() => run((x) => insertTrackOps(x, axis, i + 1), `Add a ${A.word}`)}><${Icon} n="plus" s=${11} />${A.After}</button>
      <span class="spacer"></span>
      <button class="icon-btn sm" title=${`Delete this ${A.word}`} disabled=${axis === "columns" && g[axis].tracks.length <= 1} onClick=${() => run((x) => removeTrackOps(x, axis, i), `Delete a ${A.word}`)}><${Icon} n="trash" s=${13} /></button>
    </div>
  </div>`;
}

/** A track as a small button showing its size; it opens the track's editor. */
function TrackPill({ list, axis, i, t, drawn }) {
  const ref = useRef();
  const [open, setOpen] = useState(false);
  const kind = t.auto ? "repeat" : trackKind(t.size);
  return html`<button ref=${ref} class="bd-track k-${kind} ${open ? "open" : ""}" title=${`${GRID_AXES[axis].Word} ${i + 1}: ${t.auto ? `repeat(${t.auto}, ${t.size})` : t.size}${drawn !== undefined ? `, drawn ${round(drawn, 1)} px` : ""}`} onClick=${() => setOpen(!open)}>
      ${trackLabel(t)}
    </button>
    ${open && html`<${Popover} anchor=${ref.current} onClose=${() => setOpen(false)} width=${248} align="end"><${TrackEditor} list=${list} axis=${axis} i=${i} onClose=${() => setOpen(false)} /><//>`}`;
}

/** Rows (or columns) made as they're needed: their size, as one pill. */
function ImplicitPill({ list, axis }) {
  const ref = useRef();
  const [open, setOpen] = useState(false);
  const key = axis === "rows" ? "autoRows" : "autoColumns";
  const g = gridOf(node(list[0]).style);
  return html`<button ref=${ref} class="bd-track k-implicit ${open ? "open" : ""}" title=${`${GRID_AXES[axis].Word}s are made as they're needed, each ${g[key] || "auto"}`} onClick=${() => setOpen(!open)}>As needed · ${trackLabel(g[key] || "auto")}</button>
    ${open && html`<${Popover} anchor=${ref.current} onClose=${() => setOpen(false)} width=${232} align="end"><div class="bd-track-edit">
      <div class="hd"><b>New ${GRID_AXES[axis].word}s</b></div>
      <${CssInput} label="Size" placeholder="auto" value=${g[key]} prop="gridAutoRows" onChange=${(v) => changeGrids(list, (x) => [{ op: "set", id: x, style: gridPatch(node(x).style, { [key]: v }) }], { label: "Grid" })} />
      <p class="bd-note">${GRID_AXES[axis].Word}s come as layers need them. Give them a size here, or set a number of ${GRID_AXES[axis].word}s above.</p>
    </div><//>`}`;
}

/** A grid's columns or rows: how many, and each track's size. */
function TrackRow({ list, axis }) {
  const id = list[0];
  const g = gridOf(node(id).style);
  const tl = g[axis];
  const A = GRID_AXES[axis];
  const geo = gridGeometry(id);
  const drawn = axis === "columns" ? geo?.cols : geo?.rows;
  const auto = tl.tracks.some((t) => t.auto);
  const count = tl.raw || auto ? undefined : tl.tracks.length || undefined;
  return html`<div class="bd-tracks" data-axis=${axis}>
    <${Num} label=${html`<${Icon} n=${axis === "columns" ? "gridCols" : "gridRows"} s=${13} />`} title=${`${A.Word}s${auto ? ": as many as fit" : axis === "rows" && !tl.tracks.length ? ": made as they're needed" : ""}`}
      value=${count} placeholder=${auto ? "fit" : "auto"} min=${axis === "columns" ? 1 : 0} max=${48}
      onChange=${(v) => v !== undefined && changeGrids(list, (x) => trackCountOps(x, axis, v), { label: "Grid", key: `count:${axis}:${list.join()}` })} />
    <div class="bd-track-list">
      ${tl.raw
        ? html`<code class="bd-track-raw" title="Written as CSS: change it under CSS">${tl.raw}</code>`
        : tl.tracks.map((t, i) => html`<${TrackPill} key=${i} list=${list} axis=${axis} i=${i} t=${t} drawn=${drawn?.[i]?.size} />`)}
      ${!tl.raw && !tl.tracks.length && html`<${ImplicitPill} list=${list} axis=${axis} />`}
    </div>
    <button class="icon-btn sm" title=${`Add a ${A.word}`} disabled=${Boolean(tl.raw)}
      onClick=${() => changeGrids(list, (x) => (auto ? trackCountOps(x, axis, (drawn?.length ?? 1) + 1) : tl.tracks.length || axis === "columns" ? insertTrackOps(x, axis, gridOf(node(x).style)[axis].tracks.length) : trackCountOps(x, axis, (drawn?.length ?? 0) + 1)), { label: `Add a ${A.word}` })}><${Icon} n="plus" s=${13} /></button>
  </div>`;
}

const GRID_PRESETS = [
  { name: "2 columns", columns: "repeat(2, 1fr)", pic: "1fr 1fr", cells: 4 },
  { name: "3 columns", columns: "repeat(3, 1fr)", pic: "1fr 1fr 1fr", cells: 6 },
  { name: "4 columns", columns: "repeat(4, 1fr)", pic: "repeat(4, 1fr)", cells: 8 },
  { name: "12 columns", columns: "repeat(12, 1fr)", pic: "repeat(12, 1fr)", cells: 12 },
  { name: "Sidebar and main", columns: "240px 1fr", pic: "1fr 2.6fr", cells: 2 },
  { name: "Main and aside", columns: "1fr 280px", pic: "2.6fr 1fr", cells: 2 },
  { name: "Cards that wrap", hint: "As many as fit, each at least 200 px", columns: "repeat(auto-fill, minmax(200px, 1fr))", pic: "repeat(3, 1fr)", cells: 5 },
  { name: "Bento", hint: "The first layer takes 2 × 2", columns: "repeat(4, 1fr)", rows: "repeat(2, 160px)", pic: "repeat(4, 1fr)", cells: 5, bento: true },
];

/** Columns × rows picked from a grid of squares (as Figma's grid picker), and the usual layouts, one click each. */
function GridPresets({ list, onDone }) {
  const [hover, setHover] = useState(null);
  const pick = (cols, rows) => {
    changeGrids(list, (x) => {
      const fixed = pxValue(node(x).style.height) !== undefined;
      return [{ op: "set", id: x, style: gridPatch(node(x).style, { columns: parseTracks(`repeat(${cols}, 1fr)`), rows: parseTracks(rows > 1 || fixed ? `repeat(${rows}, ${fixed ? "1fr" : "auto"})` : "") }) }];
    }, { label: "Grid" });
    onDone();
  };
  const preset = (p) => {
    changeGrids(list, (x) => {
      const ops = [{ op: "set", id: x, style: gridPatch(node(x).style, { columns: parseTracks(p.columns), rows: parseTracks(p.rows ?? "") }) }];
      const first = (node(x).children ?? []).find((c) => node(c) && !node(c).hidden);
      if (p.bento && first) ops.push({ op: "set", id: first, style: { gridColumn: "span 2", gridRow: "span 2", gridArea: null } });
      return ops;
    }, { label: p.name });
    onDone();
  };
  return html`<div class="bd-grid-presets">
    <div class="bd-grid-picker" onPointerLeave=${() => setHover(null)}>
      ${Array.from({ length: 5 }, (_, r) =>
        Array.from({ length: 8 }, (_, c) => html`<button class=${hover && c < hover[0] && r < hover[1] ? "on" : ""} aria-label=${`${c + 1} × ${r + 1}`}
          onPointerEnter=${() => setHover([c + 1, r + 1])} onFocus=${() => setHover([c + 1, r + 1])} onClick=${() => pick(c + 1, r + 1)}></button>`),
      )}
    </div>
    <div class="bd-grid-size">${hover ? `${hover[0]} columns × ${hover[1]} row${hover[1] === 1 ? "" : "s"}` : "Pick columns × rows"}</div>
    <div class="bd-preset-list">
      ${GRID_PRESETS.map((p) => html`<button class="bd-preset" title=${p.hint ?? p.columns} onClick=${() => preset(p)}>
        <span class="pic" style=${{ gridTemplateColumns: p.pic }}>${Array.from({ length: p.cells }, (_, k) => html`<i key=${k} class=${p.bento && k === 0 ? "big" : ""}></i>`)}</span>
        <span class="nm">${p.name}</span>
      </button>`)}
    </div>
  </div>`;
}

const CONTENT = ["normal", "start", "center", "end", "space-between", "space-around", "space-evenly", "stretch"].map((v) => ({ value: v, label: v === "normal" ? "Normal" : v.replace(/-/g, " ").replace(/^./, (c) => c.toUpperCase()) }));

/** Name the cells of a grid to make areas (grid-template-areas); a layer then takes an area by name. */
function AreasEditor({ list }) {
  const id = list[0];
  const g = gridOf(node(id).style);
  const geo = gridGeometry(id);
  const cols = Math.max(1, g.columns.tracks.some((t) => t.auto) || g.columns.raw ? geo?.cols.length ?? 1 : g.columns.tracks.length || 1);
  const rows = Math.max(1, g.rows.tracks.length || geo?.rows.length || 1);
  const now = Array.from({ length: rows }, (_, r) => Array.from({ length: cols }, (_, c) => g.areas?.[r]?.[c] ?? "."));
  const [draft, setDraft] = useState(null);
  const cells = draft ?? now;
  const save = () => {
    if (!draft) return;
    const next = draft.map((r) => r.map((c) => c.trim().replace(/[^\w-]/g, "") || "."));
    setDraft(null);
    if (JSON.stringify(next) === JSON.stringify(now)) return;
    changeGrids(list, (x) => [{ op: "set", id: x, style: gridPatch(node(x).style, { areas: next, ...(gridOf(node(x).style).rows.tracks.length ? {} : { rows: { tracks: next.map(() => ({ size: "auto" })) } }) }) }], { label: "Grid areas" });
  };
  return html`<div class="bd-areas" style=${{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}>
      ${cells.map((row, r) => row.map((name, c) => html`<input key=${`${r}:${c}`} class="bd-area-cell ${name !== "." ? "named" : ""}" value=${name === "." ? "" : name} placeholder="·" spellcheck=${false} aria-label=${`Area of row ${r + 1}, column ${c + 1}`}
        onInput=${(e) => setDraft(cells.map((x, rr) => x.map((v, cc) => (rr === r && cc === c ? e.target.value : v))))}
        onBlur=${save} onKeyDown=${(e) => (e.stopPropagation(), e.key === "Enter" && e.target.blur())} />`))}
    </div>
    ${!areasValid(g.areas) && html`<p class="bd-note bd-warn">Each name has to make a rectangle (and every row as long as the others): CSS leaves the areas out until it does.</p>`}`;
}

function GridSection() {
  const list = ids().filter((id) => isGrid(node(id)));
  const id = list[0];
  const n = node(id);
  const g = gridOf(n.style);
  const [four, setFour] = useState(false);
  const [more, setMore] = useState(false);
  const [presets, setPresets] = useState(false);
  const presetBtn = useRef();
  const pad = sides(n.style, "padding", PAD_KEYS);
  const set = (style, key) => setStyle(style, key, list);
  const gaps = (change, key) => changeGrids(list, (x) => {
    const m = gridOf(node(x).style);
    return [{ op: "set", id: x, style: gridPatch(node(x).style, { rowGap: m.rowGap, columnGap: m.columnGap, ...change }) }];
  }, { label: "Gap", key: `${key}:${list.join()}` });
  const stretchAll = stretched(n.style.justifyItems) && stretched(n.style.alignItems);
  return html`<${Section} title="Grid" right=${html`<button class="icon-btn sm ${presets ? "on" : ""}" ref=${presetBtn} title="Columns × rows, and layouts to start from" onClick=${() => setPresets(!presets)}><${Icon} n="grid" s=${14} /></button>
      <button class="icon-btn sm" title="Remove grid (⌥⇧G): keep each layer where it is" onClick=${() => setLayout(list, "free")}><${Icon} n="minus" s=${14} /></button>`}>
    ${presets && html`<${Popover} anchor=${presetBtn.current} onClose=${() => setPresets(false)} width=${236} align="end"><${GridPresets} list=${list} onDone=${() => setPresets(false)} /><//>`}
    <${LayoutKind} list=${list} />
    <${TrackRow} list=${list} axis="columns" />
    <${TrackRow} list=${list} axis="rows" />
    <div class="bd-flex">
      <${CellPad} label="Where layers sit in their cells" justify=${n.style.justifyItems} align=${n.style.alignItems} onPick=${(j, a) => set({ justifyItems: j, alignItems: a })} />
      <div class="bd-flex-side">
        <${Num} label=${html`<${Icon} n="gapCols" s=${13} />`} title="Gap between columns" value=${px(g.columnGap) ?? 0} min=${0} onChange=${(v) => gaps({ columnGap: v ? `${v}px` : "" }, "cgap")} />
        <${Num} label=${html`<${Icon} n="gapRows" s=${13} />`} title="Gap between rows" value=${px(g.rowGap) ?? 0} min=${0} onChange=${(v) => gaps({ rowGap: v ? `${v}px` : "" }, "rgap")} />
        <label class="bd-check" title="Layers without a size of their own fill their cells"><input type="checkbox" checked=${stretchAll} onChange=${(e) => set(e.target.checked ? { justifyItems: null, alignItems: null } : { justifyItems: "start", alignItems: "start" })} />Fill cells</label>
      </div>
    </div>
    <div class="bd-pads ${four ? "four" : ""}">
      ${four
        ? ["Top", "Right", "Bottom", "Left"].map((s, i) => html`<${Num} label=${s[0]} title=${`${s} padding`} value=${pad[i]} min=${0} onChange=${(v) => set(padStyle(pad.map((x, j) => (j === i ? v ?? 0 : x))), `pad${i}`)} />`)
        : html`<${Num} label=${html`<${Icon} n="flexRow" s=${12} />`} title="Padding left and right" value=${pad[1] === pad[3] ? pad[1] : undefined} placeholder="—" min=${0} onChange=${(v) => set(padStyle([pad[0], v ?? 0, pad[2], v ?? 0]), "padx")} />
          <${Num} label=${html`<${Icon} n="flexCol" s=${12} />`} title="Padding top and bottom" value=${pad[0] === pad[2] ? pad[0] : undefined} placeholder="—" min=${0} onChange=${(v) => set(padStyle([v ?? 0, pad[1], v ?? 0, pad[3]]), "pady")} />`}
      <button class="icon-btn sm ${four ? "on" : ""}" title="Each side" onClick=${() => setFour(!four)}><${Icon} n="sides" s=${14} /></button>
    </div>
    <button class="bd-more ${more ? "open" : ""}" onClick=${() => setMore(!more)} aria-expanded=${more}><${Icon} n="right" s=${11} w=${2} />Flow, new tracks and areas</button>
    ${more && html`<div class="bd-grid-more">
      <div class="bd-grid-flow">
        <${Seg} value=${g.flow} options=${[{ value: "row", icon: "flexRow", label: "Rows", title: "Layers fill each row, then the next" }, { value: "column", icon: "flexCol", label: "Columns", title: "Layers fill each column, then the next" }]}
          onChange=${(v) => changeGrids(list, (x) => [{ op: "set", id: x, style: gridPatch(node(x).style, { flow: v }) }], { label: "Grid flow" })} />
        <label class="bd-check" title="Fill holes left by bigger layers with later ones"><input type="checkbox" checked=${g.dense} onChange=${(e) => changeGrids(list, (x) => [{ op: "set", id: x, style: gridPatch(node(x).style, { dense: e.target.checked }) }], { label: "Grid flow" })} />Dense</label>
      </div>
      <div class="grid2">
        <${CssInput} label="New rows" title="The size of rows made as they're needed (grid-auto-rows)" placeholder="auto" value=${g.autoRows} prop="gridAutoRows" onChange=${(v) => changeGrids(list, (x) => [{ op: "set", id: x, style: gridPatch(node(x).style, { autoRows: v }) }], { label: "Grid" })} />
        <${CssInput} label="New cols" title="The size of columns made as they're needed (grid-auto-columns)" placeholder="auto" value=${g.autoColumns} prop="gridAutoColumns" onChange=${(v) => changeGrids(list, (x) => [{ op: "set", id: x, style: gridPatch(node(x).style, { autoColumns: v }) }], { label: "Grid" })} />
      </div>
      <div class="bd-grid-content">
        <span>Columns in the frame</span><${Dropdown} value=${n.style.justifyContent ?? "normal"} options=${CONTENT} onChange=${(v) => set({ justifyContent: v === "normal" ? null : v })} />
        <span>Rows in the frame</span><${Dropdown} value=${n.style.alignContent ?? "normal"} options=${CONTENT} onChange=${(v) => set({ alignContent: v === "normal" ? null : v })} />
      </div>
      <div class="bd-sub">Areas</div>
      <${AreasEditor} key=${id} list=${list} />
      <p class="bd-note">Name cells to make areas; a layer takes one under In the grid.</p>
    </div>`}
  <//>`;
}

/** For layers in a grid: the cells they take (start and span, or an area) and how they sit in them. */
function GridChildSection() {
  const list = ids().filter((id) => inGrid(id));
  const all = ids();
  const id = list[0] ?? all[0];
  const n = node(id);
  const p = node(n.parent);
  if (!list.length) return html`<${Section} title="In the grid"><${ChildSection} /><//>`;
  const pg = gridOf(p.style);
  const geo = gridGeometry(p.id);
  const columns = Math.max(1, geo?.explicitCols || pg.columns.tracks.length || 1);
  const names = Object.keys(areaRects(pg.areas));
  const one = list.length === 1;
  const line = (key, patch) =>
    commit(list.map((x) => ({ op: "set", id: x, style: { [key]: placementCss({ ...parsePlacement(node(x).style[key]), ...patch }), gridArea: null } })), { label: "Grid cell", key: `cell:${key}:${list.join()}` });
  const lineRow = (key, word, across) => {
    const pl = parsePlacement(n.style[key]);
    if (typeof pl.start === "string" || typeof pl.end === "string") return html`<div class="bd-cell-line"><span class="lbl">${word}</span><code class="bd-track-raw">${n.style[key]}</code></div>`;
    const whole = pl.end === -1;
    return html`<div class="bd-cell-line">
      <span class="lbl">${word}</span>
      <${Num} label="At" title=${`The ${word.toLowerCase()} it starts in (empty: wherever there's room)`} value=${one && typeof pl.start === "number" ? pl.start : undefined} placeholder=${one ? "auto" : "—"} min=${1} max=${99}
        onChange=${(v) => line(key, { start: v === undefined ? undefined : Math.round(v), ...(whole ? { end: -1 } : {}) })} />
      ${whole
        ? html`<span class="bd-cell-to" title="To the last line">to the end</span>`
        : html`<${Num} label="Span" title=${`How many ${word.toLowerCase()}s it takes`} value=${one ? placementSpan(pl) : undefined} placeholder="—" min=${1} max=${key === "gridColumn" ? columns : 99}
          onChange=${(v) => v && line(key, { span: Math.round(v), end: undefined })} />`}
      <button class="icon-btn sm ${whole ? "on" : ""}" title=${whole ? "Back to one cell" : `Across the whole ${across}`}
        onClick=${() => line(key, whole ? { start: pl.start === 1 ? undefined : pl.start, end: undefined, span: undefined } : { start: 1, end: -1, span: undefined })}><${Icon} n=${key === "gridColumn" ? "gapCols" : "gapRows"} s=${13} /></button>
    </div>`;
  };
  const items = (k) => (stretched(p.style[k]) ? "stretch" : p.style[k]);
  const js = n.style.justifySelf && n.style.justifySelf !== "auto" ? n.style.justifySelf : items("justifyItems");
  const as = n.style.alignSelf && n.style.alignSelf !== "auto" ? n.style.alignSelf : items("alignItems");
  const fills = list.every((x) => sizeWord(B.board, x, "width") === "fill" && sizeWord(B.board, x, "height") === "fill");
  const fill = (on) =>
    commit(
      list.map((x) => {
        const k = node(x);
        const pp = node(k.parent).style;
        if (on) return { op: "set", id: x, style: { width: null, height: null, justifySelf: stretched(pp.justifyItems) ? null : "stretch", alignSelf: stretched(pp.alignItems) ? null : "stretch" } };
        const b = worldBox(x);
        return { op: "set", id: x, style: { ...(b ? { width: `${Math.round(b.width)}px`, ...(k.type === "text" ? {} : { height: `${Math.round(b.height)}px` }) } : {}), justifySelf: "start", alignSelf: "start" } };
      }),
      { label: on ? "Fill the cell" : "Own size" },
    );
  const area = n.style.gridArea;
  return html`<${Section} title="In the grid" right=${html`<button class="icon-btn sm" title="Back to wherever there's room, one cell, sitting as the grid says" onClick=${() => commit(list.map((x) => ({ op: "set", id: x, style: { gridColumn: null, gridRow: null, gridArea: null, justifySelf: null, alignSelf: null } })), { label: "Grid cell" })}><${Icon} n="refresh" s=${13} /></button>`}>
    ${names.length > 0 && html`<div class="bd-cell-line"><span class="lbl">Area</span>
      <${Dropdown} value=${one ? area ?? "" : null} placeholder="Mixed" options=${[{ value: "", label: "None" }, ...names.map((v) => ({ value: v, label: v }))]}
        onChange=${(v) => commit(list.map((x) => ({ op: "set", id: x, style: v ? { gridArea: v, gridColumn: null, gridRow: null } : { gridArea: null } })), { label: "Grid area" })} /></div>`}
    ${area && one ? html`<p class="bd-note">Placed by its area, ${area}.</p>` : html`${lineRow("gridColumn", "Column", "row")}${lineRow("gridRow", "Row", "column")}`}
    <div class="bd-flex">
      <${CellPad} label="Where it sits in its cell" justify=${js} align=${as} onPick=${(j, a) => setStyle({ justifySelf: j, alignSelf: a }, null, list)} />
      <div class="bd-flex-side">
        <label class="bd-check" title="No size of its own: as big as its cells"><input type="checkbox" checked=${fills} onChange=${(e) => fill(e.target.checked)} />Fill the cell</label>
        ${one && html`<${ChildSection} />`}
      </div>
    </div>
  <//>`;
}
