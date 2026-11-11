// The board canvas: every artboard drawn as the real HTML and CSS it is, on an endless canvas you
// pan and zoom, with selection, moving, resizing and drawing new layers on top.
import { useEffect, useLayoutEffect, useRef } from "preact/hooks";
import { ancestors, fontFamilies, fontLinks, inFlow, isFlex, newId, pxValue, round, sizeWord } from "./board-core.js";
import { B, bset, commit, currentPage, node, notify, preview, select } from "./board-state.js";
import { html } from "./controls.js";
import { fileUrl } from "./store.js";
import { openLayerMenu, startTextEdit } from "./board.js";

export const canvasEl = { current: null };

export const srcUrl = (src) => (!src ? "" : /^(https?:|data:|blob:)/i.test(src) ? src : fileUrl(src));

// ---------------------------------------------------------------------------------------------
// Where things are

/** The element drawing a layer. */
export const elOf = (id) => canvasEl.current?.querySelector(`[data-bid="${id}"]`);

/** A screen point (client px) on the canvas, in board units. */
export function toWorld(clientX, clientY) {
  const r = canvasEl.current.getBoundingClientRect();
  const { x, y, z } = B.view;
  return { x: (clientX - r.left - x) / z, y: (clientY - r.top - y) / z };
}

/** A layer's box in board units (as drawn), or null if it isn't drawn. */
export function worldBox(id) {
  const el = elOf(id);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  const c = canvasEl.current.getBoundingClientRect();
  const { x, y, z } = B.view;
  return { x: (r.left - c.left - x) / z, y: (r.top - c.top - y) / z, width: r.width / z, height: r.height / z };
}

/** A layer's box on screen, relative to the canvas. */
function screenBox(id) {
  const el = elOf(id);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  const c = canvasEl.current.getBoundingClientRect();
  return { x: r.left - c.left, y: r.top - c.top, width: r.width, height: r.height };
}

export function zoomTo(z, at) {
  const c = canvasEl.current?.getBoundingClientRect();
  if (!c) return;
  const nz = Math.min(64, Math.max(0.02, z));
  const p = at ?? { x: c.width / 2, y: c.height / 2 };
  const { x, y, z: oz } = B.view;
  bset({ view: { x: p.x - ((p.x - x) / oz) * nz, y: p.y - ((p.y - y) / oz) * nz, z: nz } });
}
export const zoomBy = (k, at) => zoomTo(B.view.z * k, at);

/** Fit layers (default: everything on the page) in the canvas. */
export function fit(ids) {
  const c = canvasEl.current?.getBoundingClientRect();
  const page = currentPage();
  if (!c || !page) return;
  const list = ids?.length ? ids : page.children;
  const boxes = list.map(worldBox).filter(Boolean);
  if (!boxes.length) return bset({ view: { x: c.width / 2 - 200, y: 120, z: 1 } });
  const minX = Math.min(...boxes.map((b) => b.x));
  const minY = Math.min(...boxes.map((b) => b.y));
  const maxX = Math.max(...boxes.map((b) => b.x + b.width));
  const maxY = Math.max(...boxes.map((b) => b.y + b.height));
  const pad = 72;
  const z = Math.min(ids?.length ? 4 : 1, (c.width - pad * 2) / Math.max(1, maxX - minX), (c.height - pad * 2 - 24) / Math.max(1, maxY - minY));
  bset({ view: { z, x: (c.width - (maxX - minX) * z) / 2 - minX * z, y: (c.height - (maxY - minY) * z) / 2 - minY * z + 12 } });
}

// ---------------------------------------------------------------------------------------------
// Drawing the board

const loaded = new Set();
function useFonts(board, page) {
  useEffect(() => {
    if (!board || !page) return;
    for (const href of fontLinks(fontFamilies(board, page.children))) {
      if (loaded.has(href)) continue;
      loaded.add(href);
      const l = document.createElement("link");
      l.rel = "stylesheet";
      l.href = href;
      l.onload = () => document.fonts.ready.then(notify);
      document.head.appendChild(l);
    }
  });
}

function svgMarkup(svg) {
  return (svg ?? "").replace(/^<svg\b/i, '<svg style="display:block;width:100%;height:100%"');
}

function Layer({ id, root = false }) {
  const n = B.board.nodes[id];
  if (!n || n.hidden) return null;
  const style = { ...n.style };
  if (root) style.position = "absolute";
  const attrs = { "data-bid": id, style };
  if (n.type === "text") {
    if (B.editing === id) return html`<${EditableText} id=${id} style=${style} />`;
    return html`<div ...${attrs} dangerouslySetInnerHTML=${{ __html: n.text ?? "" }}></div>`;
  }
  if (n.type === "image") return html`<img ...${attrs} src=${srcUrl(n.src)} alt="" draggable=${false} />`;
  if (n.type === "svg") return html`<div ...${attrs} dangerouslySetInnerHTML=${{ __html: svgMarkup(n.svg) }}></div>`;
  return html`<div ...${attrs}>${(n.children ?? []).map((c) => html`<${Layer} key=${c} id=${c} />`)}</div>`;
}

/** A text layer being typed in: the browser edits it; the words go back on Escape or a click away. */
function EditableText({ id, style }) {
  const ref = useRef();
  useLayoutEffect(() => {
    const el = ref.current;
    el.innerHTML = node(id)?.text ?? "";
    el.focus();
    const r = document.createRange();
    r.selectNodeContents(el);
    const s = getSelection();
    s.removeAllRanges();
    s.addRange(r);
  }, [id]);
  useEffect(() => {
    const onSel = () => {
      const s = getSelection();
      const r = s.rangeCount ? s.getRangeAt(0) : null;
      const inside = r && ref.current?.contains(r.commonAncestorContainer);
      const was = Boolean(words.range && !words.range.collapsed);
      if (inside) words.range = r.cloneRange();
      if (Boolean(words.range && !words.range.collapsed) !== was || inside) notify();
    };
    document.addEventListener("selectionchange", onSel);
    return () => {
      document.removeEventListener("selectionchange", onSel);
      words.range = null;
    };
  }, [id]);
  return html`<div data-bid=${id} ref=${ref} style=${{ ...style, outline: "none", cursor: "text" }} contenteditable="true" spellcheck=${false}
    onBlur=${(e) => !e.relatedTarget?.closest?.(".bd-words") && finishText(id, ref.current)}
    onPointerDown=${(e) => e.stopPropagation()}
    onKeyDown=${(e) => {
      e.stopPropagation();
      if (e.key === "Escape" || (e.key === "Enter" && (e.metaKey || e.ctrlKey))) {
        e.preventDefault();
        ref.current.blur();
      } else if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        document.execCommand("insertLineBreak");
      }
    }}></div>`;
}

/** The words selected in the text being typed in, for the panel's bold, italic and colour. */
export const words = { range: null };

/** Style the selected words: bold, italic, underline, strikeThrough, or foreColor with a colour. */
export function styleWords(cmd, value) {
  const el = B.editing && elOf(B.editing);
  if (!el || !words.range) return;
  el.focus();
  const s = getSelection();
  s.removeAllRanges();
  s.addRange(words.range);
  document.execCommand("styleWithCSS", false, cmd === "foreColor");
  document.execCommand(cmd, false, value);
  if (s.rangeCount) words.range = s.getRangeAt(0).cloneRange();
  notify();
}
export const wordState = (cmd) => {
  try {
    return Boolean(words.range && !words.range.collapsed && document.queryCommandState(cmd));
  } catch {
    return false;
  }
};

export async function finishText(id, el) {
  if (B.editing !== id || !el) return;
  const { inlineHtml, parseHtml } = await import("./board-core.js");
  // New lines the browser made as <div>s become line breaks.
  const raw = el.innerHTML.replace(/<div>/gi, "<br>").replace(/<\/div>/gi, "");
  const text = inlineHtml(parseHtml(raw).children).replace(/^(<br>)+/, "");
  B.editing = null;
  if (text !== (node(id)?.text ?? "")) commit([{ op: "set", id, text: text || "Text" }], { label: "Typing" });
  else notify();
}

// ---------------------------------------------------------------------------------------------
// The canvas

export function BoardCanvas() {
  const ref = useRef();
  const b = B;
  const page = currentPage();
  useFonts(b.board, page);
  useLayoutEffect(() => {
    canvasEl.current = ref.current;
  });
  // A board opens fitted to its first page.
  useLayoutEffect(() => {
    if (B.view.fitPending) {
      B.view = { ...B.view, fitPending: false };
      requestAnimationFrame(() => fit());
    }
  }, [b.id, b.page]);
  useEffect(() => {
    const el = ref.current;
    const wheel = (e) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      if (e.ctrlKey || e.metaKey) zoomBy(Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.002)), { x: e.clientX - r.left, y: e.clientY - r.top });
      else bset({ view: { ...B.view, x: B.view.x - e.deltaX, y: B.view.y - e.deltaY } });
    };
    // Safari's own pinch.
    let g0 = 1;
    const gs = (e) => {
      e.preventDefault();
      g0 = 1;
    };
    const gc = (e) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      zoomBy(e.scale / g0, { x: e.clientX - r.left, y: e.clientY - r.top });
      g0 = e.scale;
    };
    el.addEventListener("wheel", wheel, { passive: false });
    el.addEventListener("gesturestart", gs);
    el.addEventListener("gesturechange", gc);
    const fonts = () => notify();
    document.fonts.addEventListener?.("loadingdone", fonts);
    return () => {
      el.removeEventListener("wheel", wheel);
      el.removeEventListener("gesturestart", gs);
      el.removeEventListener("gesturechange", gc);
      document.fonts.removeEventListener?.("loadingdone", fonts);
    };
  }, []);
  if (!b.board || !page) return html`<div class="bd-canvas" ref=${ref}></div>`;
  const { x, y, z } = b.view;
  const tokens = Object.fromEntries(b.board.tokens.map((t) => [t.name, t.value]));
  return html`<div class="bd-canvas tool-${b.tool} ${spaceDown ? "panning" : ""}" ref=${ref}
      onPointerDown=${down} onDblClick=${dblclick} onContextMenu=${contextMenu} onPointerMove=${hoverMove} onPointerLeave=${() => B.hover && bset({ hover: null })}
      onClickCapture=${(e) => e.target.closest("a") && e.preventDefault()}
      onDragOver=${(e) => e.preventDefault()} onDrop=${dropFiles}>
    <div class="bd-world" style=${{ transform: `translate(${x}px, ${y}px) scale(${z})`, ...tokens }}>
      ${page.children.map((id) => html`<${Layer} key=${id} id=${id} root />`)}
    </div>
    <${Overlay} />
    ${!page.children.length && html`<div class="bd-empty"><b>An empty page</b><span>Press F and drag to draw an artboard, paste HTML, or ask an agent to design here.</span></div>`}
  </div>`;
}

// ---------------------------------------------------------------------------------------------
// What's drawn over the design: selection, handles, labels, guides

const HANDLES = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];

function sizeLabel(id, box) {
  const z = B.view.z;
  const word = (axis, px) => {
    const w = sizeWord(B.board, id, axis);
    const v = Math.round(px / z);
    return w === "fit" ? `Fit ${v}` : w === "fill" ? `Fill ${v}` : w === "auto" ? `${v}` : /%$/.test(w) ? `${w} ${v}` : String(round(Number(w), 1)) === "NaN" ? `${v}` : w;
  };
  return `${word("width", box.width)} × ${word("height", box.height)}`;
}

function Overlay() {
  const b = B;
  const page = currentPage();
  if (!canvasEl.current || !page) return null;
  const roots = page.children.filter((id) => b.board.nodes[id] && !b.board.nodes[id].hidden);
  const one = b.sel.length === 1 ? b.sel[0] : null;
  // While something is being dragged, only what helps with it shows: the size while resizing.
  const busy = b.dragging;
  const hover = !busy && b.hover && !b.sel.includes(b.hover) ? screenBox(b.hover) : null;
  const sel = b.sel.map((id) => [id, screenBox(id)]).filter(([, r]) => r);
  const box = one ? screenBox(one) : null;
  const locked = one && node(one)?.locked;
  const movable = b.sel.length > 1 && !b.editing ? b.sel.filter((id) => !node(id)?.locked) : [];
  const group = movable.length > 1 ? unionOf(movable.map(screenBox).filter(Boolean)) : null;
  return html`<div class="bd-overlay">
    ${roots.map((id) => {
      const r = screenBox(id);
      if (!r) return null;
      const working = b.working.includes(id);
      return html`<div key=${id} class="bd-label ${b.sel.includes(id) ? "on" : ""} ${working ? "working" : ""}" style=${{ left: r.x + "px", top: r.y - 22 + "px", maxWidth: Math.max(40, r.width) + "px" }} data-label=${id}>
        ${working && html`<span class="bd-agent"><i></i>Agent</span>`}<span class="t">${b.board.nodes[id].name}</span></div>
        ${working && html`<div class="bd-working" style=${{ left: r.x - 2 + "px", top: r.y - 2 + "px", width: r.width + 4 + "px", height: r.height + 4 + "px" }}></div>`}`;
    })}
    ${hover && html`<div class="bd-hover" style=${{ left: hover.x + "px", top: hover.y + "px", width: hover.width + "px", height: hover.height + "px" }}></div>`}
    ${sel.map(([id, r]) => html`<div key=${id} class="bd-sel ${node(id)?.locked ? "locked" : ""}" style=${{ left: r.x + "px", top: r.y + "px", width: r.width + "px", height: r.height + "px" }}></div>`)}
    ${box && !locked && !b.editing && !busy &&
    HANDLES.map((h) => html`<div key=${h} class="bd-handle h-${h}" data-handle=${h} style=${{ left: box.x + (h.includes("w") ? 0 : h.includes("e") ? box.width : box.width / 2) + "px", top: box.y + (h.includes("n") ? 0 : h.includes("s") ? box.height : box.height / 2) + "px" }}></div>`)}
    ${box && !b.editing && (!busy || busy === "resize") && html`<div class="bd-size" style=${{ left: box.x + box.width / 2 + "px", top: box.y + box.height + 8 + "px" }}>${sizeLabel(one, box)}</div>`}
    ${group && html`<div class="bd-group" style=${{ left: group.x + "px", top: group.y + "px", width: group.width + "px", height: group.height + "px" }}></div>
      ${!busy && HANDLES.map((h) => html`<div key=${h} class="bd-handle h-${h}" data-handle=${h} data-group="1" style=${{ left: group.x + (h.includes("w") ? 0 : h.includes("e") ? group.width : group.width / 2) + "px", top: group.y + (h.includes("n") ? 0 : h.includes("s") ? group.height : group.height / 2) + "px" }}></div>`)}
      ${(!busy || busy === "resize") && html`<div class="bd-size" style=${{ left: group.x + group.width / 2 + "px", top: group.y + group.height + 8 + "px" }}>${Math.round(group.width / b.view.z)} × ${Math.round(group.height / b.view.z)}</div>`}`}
    ${altDown && one && !busy && html`<${Distances} from=${one} to=${b.hover && b.hover !== one ? b.hover : node(one)?.parent} />`}
    ${b.drop?.line && html`<div class="bd-drop-line" style=${{ left: b.drop.line.x + "px", top: b.drop.line.y + "px", width: b.drop.line.width + "px", height: b.drop.line.height + "px" }}></div>`}
    ${b.drop?.into && (() => {
      const r = screenBox(b.drop.into);
      return r && html`<div class="bd-drop-into" style=${{ left: r.x + "px", top: r.y + "px", width: r.width + "px", height: r.height + "px" }}></div>`;
    })()}
    ${b.drop?.rect && html`<div class=${b.drop.kind === "marquee" ? "bd-marquee" : "bd-draw"} style=${{ left: b.drop.rect.x + "px", top: b.drop.rect.y + "px", width: b.drop.rect.width + "px", height: b.drop.rect.height + "px" }}></div>`}
    ${b.guides.map((g, i) => html`<div key=${i} class="bd-guide ${g.axis}" style=${g.axis === "x" ? { left: g.at + "px", top: g.from + "px", height: g.to - g.from + "px" } : { top: g.at + "px", left: g.from + "px", width: g.to - g.from + "px" }}></div>`)}
  </div>`;
}

const unionOf = (boxes) => {
  if (!boxes.length) return null;
  const x = Math.min(...boxes.map((r) => r.x));
  const y = Math.min(...boxes.map((r) => r.y));
  return { x, y, width: Math.max(...boxes.map((r) => r.x + r.width)) - x, height: Math.max(...boxes.map((r) => r.y + r.height)) - y };
};

/** ⌥ held: how far the selected layer is from another (or, inside it, from its edges). */
function Distances({ from, to }) {
  const a = from && screenBox(from);
  const b = to && screenBox(to);
  if (!a || !b) return null;
  const z = B.view.z;
  const lines = [];
  const inside = a.x >= b.x - 0.5 && a.y >= b.y - 0.5 && a.x + a.width <= b.x + b.width + 0.5 && a.y + a.height <= b.y + b.height + 0.5;
  const midY = a.y + a.height / 2;
  const midX = a.x + a.width / 2;
  const h = (x1, x2, y) => x2 - x1 > 0.5 && lines.push({ x: x1, y, w: x2 - x1, h: 0, v: (x2 - x1) / z });
  const v = (y1, y2, x) => y2 - y1 > 0.5 && lines.push({ x, y: y1, w: 0, h: y2 - y1, v: (y2 - y1) / z });
  if (inside) {
    h(b.x, a.x, midY);
    h(a.x + a.width, b.x + b.width, midY);
    v(b.y, a.y, midX);
    v(a.y + a.height, b.y + b.height, midX);
  } else {
    const oy = Math.max(a.y, b.y) < Math.min(a.y + a.height, b.y + b.height) ? (Math.max(a.y, b.y) + Math.min(a.y + a.height, b.y + b.height)) / 2 : midY;
    const ox = Math.max(a.x, b.x) < Math.min(a.x + a.width, b.x + b.width) ? (Math.max(a.x, b.x) + Math.min(a.x + a.width, b.x + b.width)) / 2 : midX;
    if (a.x + a.width <= b.x) h(a.x + a.width, b.x, oy);
    else if (b.x + b.width <= a.x) h(b.x + b.width, a.x, oy);
    if (a.y + a.height <= b.y) v(a.y + a.height, b.y, ox);
    else if (b.y + b.height <= a.y) v(b.y + b.height, a.y, ox);
  }
  return html`${!inside && html`<div class="bd-measure-box" style=${{ left: b.x + "px", top: b.y + "px", width: b.width + "px", height: b.height + "px" }}></div>`}
    ${lines.map((l, i) => html`<div key=${i} class="bd-measure ${l.h ? "v" : "h"}" style=${{ left: l.x + "px", top: l.y + "px", width: Math.max(1, l.w) + "px", height: Math.max(1, l.h) + "px" }}>
      <span style=${l.h ? { top: "50%", left: "6px" } : { left: "50%", top: "6px" }}>${Math.round(l.v)}</span></div>`)}`;
}

// ---------------------------------------------------------------------------------------------
// Pointer work

let spaceDown = false;
/** ⌥ held: distances from the selection to the layer under the pointer. */
let altDown = false;
addEventListener("keydown", (e) => {
  if (e.key === "Alt" && !altDown && B.id) {
    altDown = true;
    notify();
  }
});
addEventListener("keyup", (e) => {
  if (e.key === "Alt" && altDown) {
    altDown = false;
    notify();
  }
});
addEventListener("blur", () => {
  if (altDown) {
    altDown = false;
    notify();
  }
});
addEventListener("keydown", (e) => {
  if (e.code === "Space" && !e.repeat && B.id && !B.editing && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName ?? "") && !document.activeElement?.isContentEditable) {
    spaceDown = true;
    e.preventDefault();
    notify();
  }
});
addEventListener("keyup", (e) => {
  if (e.code === "Space" && spaceDown) {
    spaceDown = false;
    notify();
  }
});

/** The layer a click on `id` (the deepest one hit) means, by how deep the selection already is. */
export function pickFor(e, id) {
  const board = B.board;
  const chain = [id, ...ancestors(board, id)].filter((x) => !board.nodes[x]?.locked || x === id);
  if (!chain.length) return null;
  if (e.metaKey || e.ctrlKey) return chain[0];
  // Keep to the level being worked at: a layer beside (or inside) what's selected.
  for (const s of B.sel) {
    const sn = node(s);
    if (!sn?.parent) continue;
    const at = chain.findIndex((x) => node(x)?.parent === sn.parent);
    if (at >= 0) return chain[at];
    const inside = chain.findIndex((x) => node(x)?.parent === s);
    if (inside >= 0) return chain[inside];
  }
  // Else what sits directly on the artboard (or the artboard, clicked on its own background).
  return chain.length >= 2 ? chain[chain.length - 2] : chain[0];
}

function hoverMove(e) {
  if (e.buttons || B.tool !== "move" || spaceDown) return;
  const hit = e.target.closest?.("[data-bid]");
  const label = e.target.closest?.("[data-label]");
  const id = label ? label.dataset.label : hit ? pickFor(e, hit.dataset.bid) : null;
  if (id !== B.hover) bset({ hover: id });
}

/** Follow a press until it lets go. `kind` says what the drag is, so the overlay can step aside. */
function drag(e, { move, up, threshold = 3, kind = null }) {
  const x0 = e.clientX;
  const y0 = e.clientY;
  let live = threshold === 0;
  if (live && kind) B.dragging = kind;
  const onMove = (ev) => {
    if (!live && Math.hypot(ev.clientX - x0, ev.clientY - y0) < threshold) return;
    if (!live && kind) B.dragging = kind;
    live = true;
    move(ev);
  };
  const onUp = (ev) => {
    removeEventListener("pointermove", onMove);
    removeEventListener("pointerup", onUp);
    B.dragging = null;
    up(ev, live);
    notify();
  };
  addEventListener("pointermove", onMove);
  addEventListener("pointerup", onUp);
}

function down(e) {
  if (e.button === 2) return;
  const c = canvasEl.current;
  if (B.editing && e.target.closest?.(`[data-bid="${B.editing}"]`)) return;
  if (B.editing) finishText(B.editing, elOf(B.editing));
  document.activeElement?.blur?.();
  // Pan: the hand tool, space held, or the middle button.
  if (e.button === 1 || B.tool === "hand" || spaceDown) {
    e.preventDefault();
    const v0 = { ...B.view };
    c.classList.add("grabbing");
    return drag(e, {
      threshold: 0,
      kind: "pan",
      move: (ev) => bset({ view: { ...v0, x: v0.x + ev.clientX - e.clientX, y: v0.y + ev.clientY - e.clientY } }),
      up: () => c.classList.remove("grabbing"),
    });
  }
  const handle = e.target.closest?.("[data-handle]");
  if (handle && handle.dataset.group) return resizeMany(e, B.sel.filter((id) => !node(id)?.locked), handle.dataset.handle);
  if (handle && B.sel.length === 1) return resize(e, B.sel[0], handle.dataset.handle);
  if (B.tool === "frame" || B.tool === "rect" || B.tool === "text") return create(e);
  const label = e.target.closest?.("[data-label]");
  if (label) {
    const id = label.dataset.label;
    if (e.shiftKey) select(id, { toggle: true });
    else if (!B.sel.includes(id)) select(id);
    return moveLayers(e, B.sel.slice());
  }
  const hit = e.target.closest?.("[data-bid]");
  if (!hit) return marquee(e, null);
  const id = pickFor(e, hit.dataset.bid);
  if (!id) return marquee(e, null);
  const n = node(id);
  // A press on an artboard's own background: click selects it, a drag selects what's inside.
  if (!n.parent && hit.dataset.bid === id && !B.sel.includes(id) && !e.shiftKey) return marquee(e, id);
  if (e.shiftKey) {
    select(id, { toggle: true });
    return;
  }
  if (!B.sel.includes(id)) select(id);
  if (n.locked) return;
  moveLayers(e, B.sel.filter((x) => !node(x)?.locked));
}

function marquee(e, root) {
  const c = canvasEl.current.getBoundingClientRect();
  const keep = e.shiftKey ? B.sel.slice() : [];
  if (!e.shiftKey && !root) select([]);
  drag(e, {
    kind: "marquee",
    move: (ev) => {
      const r = { x: Math.min(e.clientX, ev.clientX) - c.left, y: Math.min(e.clientY, ev.clientY) - c.top, width: Math.abs(ev.clientX - e.clientX), height: Math.abs(ev.clientY - e.clientY) };
      const candidates = root ? node(root).children ?? [] : currentPage().children;
      const hits = candidates.filter((id) => {
        const n = node(id);
        if (!n || n.hidden || n.locked) return false;
        const b = screenBox(id);
        return b && b.x < r.x + r.width && b.x + b.width > r.x && b.y < r.y + r.height && b.y + b.height > r.y;
      });
      B.drop = { kind: "marquee", rect: r };
      select([...new Set([...keep, ...hits])]);
    },
    up: (ev, moved) => {
      bset({ drop: null });
      if (!moved && root) select(root);
    },
  });
}

/** Where a free layer's left and top are now, in its parent's terms (measured if not written). */
export function placeOf(id) {
  const n = node(id);
  const l = pxValue(n.style.left);
  const t = pxValue(n.style.top);
  if (l !== undefined && t !== undefined) return { left: l, top: t };
  const me = worldBox(id);
  const p = n.parent ? worldBox(n.parent) : { x: 0, y: 0 };
  const pel = n.parent ? elOf(n.parent) : null;
  const cs = pel ? getComputedStyle(pel) : null;
  return { left: l ?? round(me.x - p.x - (cs ? parseFloat(cs.borderLeftWidth) || 0 : 0)), top: t ?? round(me.y - p.y - (cs ? parseFloat(cs.borderTopWidth) || 0 : 0)) };
}

const SNAP = 6;

function moveLayers(e, ids) {
  if (!ids.length) return;
  const base = B.board;
  const z = B.view.z;
  // One layer placed by its frame's flex layout is moved among its siblings instead.
  if (ids.length === 1 && inFlow(base, ids[0])) return reorder(e, ids[0]);
  const free = ids.filter((id) => !inFlow(base, id));
  const starts = Object.fromEntries(free.map((id) => [id, placeOf(id)]));
  // Edges to snap to: the other artboards (for artboards), else the parent's edges and centre.
  const lone = free.length === 1 ? free[0] : null;
  const loneBox = lone ? worldBox(lone) : null;
  const targets = { x: [], y: [] };
  if (lone) {
    const others = node(lone).parent ? [node(lone).parent] : currentPage().children.filter((x) => x !== lone);
    for (const o of others) {
      const b = worldBox(o);
      if (!b) continue;
      targets.x.push(b.x, b.x + b.width / 2, b.x + b.width);
      targets.y.push(b.y, b.y + b.height / 2, b.y + b.height);
    }
    for (const s of node(node(lone).parent ?? "")?.children ?? []) {
      if (s === lone) continue;
      const b = worldBox(s);
      if (!b) continue;
      targets.x.push(b.x, b.x + b.width);
      targets.y.push(b.y, b.y + b.height);
    }
  }
  let ops = [];
  drag(e, {
    kind: "move",
    move: (ev) => {
      let dx = (ev.clientX - e.clientX) / z;
      let dy = (ev.clientY - e.clientY) / z;
      const guides = [];
      if (loneBox && !ev.metaKey) {
        const snap = (pos, size, list) => {
          let best = null;
          for (const t of list)
            for (const [k, edge] of [[0, pos], [0.5, pos + size / 2], [1, pos + size]]) {
              const d = t - edge;
              if (Math.abs(d) * z <= SNAP && (!best || Math.abs(d) < Math.abs(best.d))) best = { d, t, k };
            }
          return best;
        };
        const sx = snap(loneBox.x + dx, loneBox.width, targets.x);
        const sy = snap(loneBox.y + dy, loneBox.height, targets.y);
        if (sx) dx += sx.d;
        if (sy) dy += sy.d;
        const c = canvasEl.current.getBoundingClientRect();
        const { x, y } = B.view;
        if (sx) guides.push({ axis: "x", at: sx.t * z + x, from: 0, to: c.height });
        if (sy) guides.push({ axis: "y", at: sy.t * z + y, from: 0, to: c.width });
      }
      dx = Math.round(dx);
      dy = Math.round(dy);
      ops = free.map((id) => ({ op: "set", id, style: { left: `${starts[id].left + dx}px`, top: `${starts[id].top + dy}px` } }));
      B.guides = guides;
      preview(base, ops);
    },
    up: (ev, moved) => {
      B.guides = [];
      if (!moved || !ops.length) return notify();
      B.board = base;
      commit(ops, { label: "Move" });
    },
  });
}

/**
 * Drag a layer along its flex frame: a line shows where it will go. Taken out past the frame's edge,
 * it goes into whichever frame it's over (at the pointer, if that frame isn't a flex one).
 */
function reorder(e, id) {
  const n = node(id);
  const el = elOf(id);
  el?.classList.add("bd-dragging");
  const c = canvasEl.current.getBoundingClientRect();
  let target = null;
  const kind = "move";
  const inside = (box, ev) => box && ev.clientX - c.left >= box.x && ev.clientX - c.left <= box.x + box.width && ev.clientY - c.top >= box.y && ev.clientY - c.top <= box.y + box.height;
  drag(e, {
    kind,
    move: (ev) => {
      let frameId = n.parent;
      if (!inside(screenBox(n.parent), ev)) {
        const f = frameAt(ev.clientX, ev.clientY, id);
        if (f) frameId = f;
      }
      const frame = node(frameId);
      if (!isFlex(frame)) {
        target = { parent: frameId, at: toWorld(ev.clientX, ev.clientY) };
        return bset({ drop: { into: frameId } });
      }
      const fRow = !(frame.style.flexDirection ?? "row").startsWith("column");
      const kids = (frame.children ?? []).filter((x) => x !== id && !node(x)?.hidden);
      const p = fRow ? ev.clientX - c.left : ev.clientY - c.top;
      let index = kids.length;
      let line = null;
      for (let i = 0; i < kids.length; i++) {
        const r = screenBox(kids[i]);
        if (r && p < (fRow ? r.x + r.width / 2 : r.y + r.height / 2)) {
          index = i;
          line = fRow ? { x: r.x - 2, y: r.y, width: 3, height: r.height } : { x: r.x, y: r.y - 2, width: r.width, height: 3 };
          break;
        }
      }
      if (!line) {
        const last = kids.length ? screenBox(kids[kids.length - 1]) : null;
        const fr = screenBox(frameId);
        line = last ? (fRow ? { x: last.x + last.width, y: last.y, width: 3, height: last.height } : { x: last.x, y: last.y + last.height, width: last.width, height: 3 }) : fr && { x: fr.x + 4, y: fr.y + 4, width: fRow ? 3 : fr.width - 8, height: fRow ? fr.height - 8 : 3 };
      }
      // Its index among all the frame's layers (hidden ones count too).
      const all = (frame.children ?? []).filter((x) => x !== id);
      target = { parent: frameId, index: index < kids.length ? all.indexOf(kids[index]) : all.length };
      bset({ drop: { line, into: frameId !== n.parent ? frameId : null } });
    },
    up: (ev, moved) => {
      el?.classList.remove("bd-dragging");
      bset({ drop: null });
      if (!moved || !target) return;
      if (target.at) {
        // Into a frame laid out by hand: it sits where it was dropped.
        const fb = worldBox(target.parent);
        const me = worldBox(id);
        const ops = [{ op: "move", id, parent: target.parent }, { op: "set", id, style: { position: "absolute", left: `${Math.round(target.at.x - fb.x - me.width / 2)}px`, top: `${Math.round(target.at.y - fb.y - me.height / 2)}px` } }];
        if (!node(target.parent).style.position) ops.push({ op: "set", id: target.parent, style: { position: "relative" } });
        return commit(ops, { label: "Move" });
      }
      const was = (node(n.parent).children ?? []).indexOf(id);
      if (target.parent === n.parent && target.index === was) return;
      commit([{ op: "move", id, parent: target.parent, index: target.index }], { label: "Move" });
    },
  });
}

function resize(e, id, h) {
  e.stopPropagation();
  const base = B.board;
  const n = node(id);
  const box0 = worldBox(id);
  const free = !inFlow(base, id);
  const start = free ? placeOf(id) : null;
  const z = B.view.z;
  const ratio = box0.width / Math.max(1, box0.height);
  const parent = n.parent ? node(n.parent) : null;
  const parentRow = parent && isFlex(parent) && !(parent.style.flexDirection ?? "row").startsWith("column");
  let ops = [];
  drag(e, {
    threshold: 0,
    kind: "resize",
    move: (ev) => {
      const dx = (ev.clientX - e.clientX) / z;
      const dy = (ev.clientY - e.clientY) / z;
      let w = box0.width + (h.includes("e") ? dx : h.includes("w") ? -dx : 0);
      let hh = box0.height + (h.includes("s") ? dy : h.includes("n") ? -dy : 0);
      if (ev.shiftKey && h.length === 2) {
        if (Math.abs(dx) > Math.abs(dy)) hh = w / ratio;
        else w = hh * ratio;
      }
      w = Math.max(1, Math.round(w));
      hh = Math.max(1, Math.round(hh));
      const style = {};
      if (h.includes("e") || h.includes("w") || ev.shiftKey) {
        style.width = `${w}px`;
        // A layer that filled its row stops growing once it has a width of its own.
        if (parentRow && !free) Object.assign(style, { flexGrow: null, flexBasis: null, flex: null });
        if (parent && !parentRow && !free && n.style.alignSelf === "stretch") style.alignSelf = null;
      }
      if (h.includes("n") || h.includes("s") || ev.shiftKey) {
        style.height = `${hh}px`;
        if (parent && !parentRow && isFlex(parent) && !free) Object.assign(style, { flexGrow: null, flexBasis: null, flex: null });
      }
      if (free) {
        if (h.includes("w")) style.left = `${Math.round(start.left + box0.width - w)}px`;
        if (h.includes("n")) style.top = `${Math.round(start.top + box0.height - hh)}px`;
      }
      ops = [{ op: "set", id, style }];
      preview(base, ops);
    },
    up: (ev, moved) => {
      if (!moved || !ops.length) return;
      B.board = base;
      commit(ops, { label: "Resize" });
    },
  });
}

/** Resize several layers as one: each keeps its place and share of the box they make together. */
function resizeMany(e, ids, h) {
  e.stopPropagation();
  const base = B.board;
  const top = ids.filter((id) => !ancestors(base, id).some((a) => ids.includes(a)));
  const boxes = Object.fromEntries(top.map((id) => [id, worldBox(id)]).filter(([, b]) => b));
  const list = Object.keys(boxes);
  if (!list.length) return;
  const g = unionOf(Object.values(boxes));
  const starts = Object.fromEntries(list.filter((id) => !inFlow(base, id)).map((id) => [id, placeOf(id)]));
  const z = B.view.z;
  let ops = [];
  drag(e, {
    threshold: 0,
    kind: "resize",
    move: (ev) => {
      const dx = (ev.clientX - e.clientX) / z;
      const dy = (ev.clientY - e.clientY) / z;
      let w = Math.max(4, g.width + (h.includes("e") ? dx : h.includes("w") ? -dx : 0));
      let hh = Math.max(4, g.height + (h.includes("s") ? dy : h.includes("n") ? -dy : 0));
      if (ev.shiftKey) {
        const k = Math.abs(w / g.width - 1) > Math.abs(hh / g.height - 1) ? w / g.width : hh / g.height;
        w = g.width * k;
        hh = g.height * k;
      }
      const sx = w / g.width;
      const sy = hh / g.height;
      const gx = h.includes("w") ? g.x + g.width - w : g.x;
      const gy = h.includes("n") ? g.y + g.height - hh : g.y;
      ops = list.map((id) => {
        const b = boxes[id];
        const n = node(id);
        const style = {};
        if (sx !== 1) style.width = `${Math.max(1, Math.round(b.width * sx))}px`;
        if (sy !== 1 && n.type !== "text") style.height = `${Math.max(1, Math.round(b.height * sy))}px`;
        if (starts[id]) {
          style.left = `${Math.round(starts[id].left + gx + (b.x - g.x) * sx - b.x)}px`;
          style.top = `${Math.round(starts[id].top + gy + (b.y - g.y) * sy - b.y)}px`;
        }
        return { op: "set", id, style };
      });
      preview(base, ops);
    },
    up: (ev, moved) => {
      if (!moved || !ops.length) return;
      B.board = base;
      commit(ops, { label: "Resize" });
    },
  });
}

// ---------------------------------------------------------------------------------------------
// Drawing new layers

/** The frame a point is over (its deepest frame, not `except` or inside it), or null for the page. */
function frameAt(clientX, clientY, except) {
  const hits = document.elementsFromPoint(clientX, clientY);
  for (const el of hits) {
    const h = el.closest?.("[data-bid]");
    if (!h || !h.closest(".bd-world")) continue;
    let id = h.dataset.bid;
    while (id && (node(id)?.type !== "frame" || id === except || (except && ancestors(B.board, id).includes(except)))) id = node(id)?.parent;
    if (id && !node(id)?.locked) return id;
  }
  return null;
}

let counter = { frame: 0, rect: 0, text: 0 };

function create(e) {
  const tool = B.tool;
  const c = canvasEl.current.getBoundingClientRect();
  const p0 = toWorld(e.clientX, e.clientY);
  const into = frameAt(e.clientX, e.clientY);
  let rect = null;
  drag(e, {
    threshold: 2,
    kind: "draw",
    move: (ev) => {
      rect = { x: Math.min(e.clientX, ev.clientX) - c.left, y: Math.min(e.clientY, ev.clientY) - c.top, width: Math.abs(ev.clientX - e.clientX), height: Math.abs(ev.clientY - e.clientY) };
      bset({ drop: { kind: "draw", rect, into } });
    },
    up: (ev, moved) => {
      bset({ drop: null });
      const p1 = toWorld(ev.clientX, ev.clientY);
      const dragged = moved && rect && rect.width > 3 && rect.height > 3;
      const w = dragged ? Math.round(Math.abs(p1.x - p0.x)) : null;
      const h = dragged ? Math.round(Math.abs(p1.y - p0.y)) : null;
      const origin = { x: Math.round(Math.min(p0.x, p1.x)), y: Math.round(Math.min(p0.y, p1.y)) };
      const id = newId();
      let layer;
      if (tool === "text") {
        layer = { id, type: "text", name: "Text", parent: null, style: { fontSize: "16px", ...(into ? {} : { color: "#111111", fontFamily: "Inter, system-ui, sans-serif" }), ...(w ? { width: `${w}px` } : {}) }, text: "Text" };
      } else if (tool === "rect") {
        layer = { id, type: "frame", name: `Rectangle ${++counter.rect}`, parent: null, style: { width: `${w ?? 120}px`, height: `${h ?? 120}px`, backgroundColor: "#d9d9de", flexShrink: "0" }, children: [] };
      } else {
        const artboard = !into;
        layer = { id, type: "frame", name: artboard ? `Artboard ${++counter.frame}` : `Frame ${++counter.frame}`, parent: null, style: { display: "flex", flexDirection: "column", width: `${w ?? (artboard ? 390 : 160)}px`, height: `${h ?? (artboard ? 844 : 120)}px`, ...(artboard ? { backgroundColor: "#ffffff", overflow: "hidden" } : { flexShrink: "0" }) }, children: [] };
      }
      placeNew([layer], into, origin, ev);
      bset({ tool: "move" });
      if (tool === "text") startTextEdit(id);
    },
  });
}

/**
 * Put new layers (made with no parent) into a frame or on the page, at a point in board units: in a
 * flex frame they join its layout where the point is; elsewhere they sit at the point.
 */
export function placeNew(layers, into, at, ev) {
  const nodes = {};
  const tops = [];
  for (const l of layers) {
    nodes[l.id] = l;
    if (!l.parent) tops.push(l.id);
  }
  const ops = [];
  if (!into) {
    for (const id of tops) Object.assign(nodes[id].style, { left: `${Math.round(at.x)}px`, top: `${Math.round(at.y)}px` });
    ops.push({ op: "add", nodes, ids: tops, parent: null, page: currentPage().id });
  } else {
    const f = node(into);
    for (const id of tops) nodes[id] = { ...nodes[id], parent: into };
    if (isFlex(f)) {
      // Where among its layers the point falls.
      const row = !(f.style.flexDirection ?? "row").startsWith("column");
      const c = canvasEl.current.getBoundingClientRect();
      const px = ev ? (row ? ev.clientX - c.left : ev.clientY - c.top) : Infinity;
      let index = (f.children ?? []).length;
      (f.children ?? []).some((k, i) => {
        const r = screenBox(k);
        if (r && px < (row ? r.x + r.width / 2 : r.y + r.height / 2)) {
          index = i;
          return true;
        }
        return false;
      });
      ops.push({ op: "add", nodes, ids: tops, parent: into, index });
    } else {
      const fb = worldBox(into);
      const cs = getComputedStyle(elOf(into));
      for (const id of tops) Object.assign(nodes[id].style, { position: "absolute", left: `${Math.round(at.x - fb.x - (parseFloat(cs.borderLeftWidth) || 0))}px`, top: `${Math.round(at.y - fb.y - (parseFloat(cs.borderTopWidth) || 0))}px` });
      if (!f.style.position) ops.push({ op: "set", id: into, style: { position: "relative" } });
      ops.push({ op: "add", nodes, ids: tops, parent: into });
    }
  }
  commit(ops, { label: "Add" });
  select(tops);
  return tops;
}

// ---------------------------------------------------------------------------------------------
// Double-click and right-click

function dblclick(e) {
  if (B.tool !== "move") return;
  const hit = e.target.closest?.("[data-bid]");
  const label = e.target.closest?.("[data-label]");
  if (label) return bset({ renaming: label.dataset.label });
  if (!hit) return;
  const chain = [hit.dataset.bid, ...ancestors(B.board, hit.dataset.bid)];
  const cur = B.sel.length === 1 ? chain.indexOf(B.sel[0]) : -1;
  const target = cur > 0 ? chain[cur - 1] : cur === 0 ? chain[0] : pickFor(e, hit.dataset.bid);
  if (!target) return;
  if (node(target)?.type === "text" && (cur === 0 || target === chain[0])) {
    select(target);
    return startTextEdit(target);
  }
  select(target);
}

function contextMenu(e) {
  e.preventDefault();
  const hit = e.target.closest?.("[data-bid]");
  const label = e.target.closest?.("[data-label]");
  const id = label ? label.dataset.label : hit ? pickFor(e, hit.dataset.bid) : null;
  if (id && !B.sel.includes(id)) select(id);
  openLayerMenu(e.clientX, e.clientY, { at: toWorld(e.clientX, e.clientY) });
}

async function dropFiles(e) {
  e.preventDefault();
  const files = [...(e.dataTransfer?.files ?? [])].filter((f) => /^image\//.test(f.type) || /\.(png|jpe?g|webp|gif|svg)$/i.test(f.name));
  if (!files.length) return;
  const { addImages } = await import("./board.js");
  addImages(files, { at: toWorld(e.clientX, e.clientY), into: frameAt(e.clientX, e.clientY), ev: e });
}

