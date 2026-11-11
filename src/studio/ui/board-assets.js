// Assets: what the rest of Screenshotter has, on a board. Shapes, stickers and illustrations, your
// pictures and screenshots, Apple's devices round a screenshot (or an artboard), backdrops, and the
// board's own components. Click to add to the selected frame (or the middle of the view), or drag
// onto the canvas.
import { useEffect, useState } from "preact/hooks";
import { htmlToNodes, instanceRootOf, newId, pxValue } from "./board-core.js";
import { B, commit, currentPage, node, useBoard } from "./board-state.js";
import { canvasEl, placeNew, toWorld, worldBox } from "./board-canvas.js";
import { placeCopy } from "./board.js";
import { Section, html } from "./controls.js";
import { Icon } from "./icons.js";
import { shapeInBox } from "./shapes.js";
import { S, api, dismiss, fail, fileUrl, thumbUrl, toast, useStore } from "./store.js";

// ---------------------------------------------------------------------------------------------
// Shapes: rectangles, circles and pills are frames (plain CSS); the rest are drawn by the same
// code that draws the design editor's shapes, and stay editable on the right.

const TINTS = ["#ff3b30", "#ff9f0a", "#ffd60a", "#34c759", "#0a84ff", "#5e5ce6", "#ffffff", "#1d1d1f"];
const onTint = (c) => (["#ffffff", "#ffd60a"].includes(c) ? "#1d1d1f" : "#ffffff");

export const BOARD_SHAPES = [
  { id: "rect", label: "Rectangle", w: 160, h: 110, css: (t) => ({ backgroundColor: t, borderRadius: "14px" }) },
  { id: "circle", label: "Circle", w: 120, h: 120, css: (t) => ({ backgroundColor: t, borderRadius: "50%" }) },
  { id: "pill", label: "Pill", w: 180, h: 56, css: (t) => ({ backgroundColor: t, borderRadius: "999px" }) },
  { id: "line", label: "Line", w: 180, h: 24, shape: (t) => ({ type: "line", stroke: t, strokeWidth: 4 }) },
  { id: "arrow", label: "Arrow", w: 170, h: 110, shape: (t) => ({ type: "arrow", stroke: t, strokeWidth: 5, head: "end", bend: 0.3 }) },
  { id: "sketch-arrow", label: "Drawn arrow", w: 170, h: 110, shape: (t) => ({ type: "arrow", stroke: t, strokeWidth: 5, head: "end", bend: 0.35, sketch: true }) },
  { id: "circle-it", label: "Circle it", w: 190, h: 110, shape: (t) => ({ type: "ellipse", stroke: t, fill: "none", strokeWidth: 4, sketch: true }) },
  { id: "box", label: "Box", w: 190, h: 110, shape: (t) => ({ type: "rect", stroke: t, fill: "none", strokeWidth: 4, radius: 0.2 }) },
  { id: "triangle", label: "Triangle", w: 120, h: 110, shape: (t) => ({ type: "triangle", fill: t, stroke: "none" }) },
  { id: "star", label: "Star", w: 120, h: 120, shape: (t) => ({ type: "star", fill: t, stroke: "none" }) },
  { id: "badge", label: "Number", w: 52, h: 52, shape: (t) => ({ type: "badge", fill: t, stroke: "#ffffff", strokeWidth: 3, label: "1", labelColor: onTint(t) }) },
  { id: "burst", label: "Burst", w: 130, h: 130, shape: (t) => ({ type: "burst", fill: t, text: "NEW", labelColor: onTint(t) }) },
  { id: "ribbon", label: "Ribbon", w: 230, h: 54, shape: (t) => ({ type: "ribbon", fill: t, text: "Try it free", labelColor: onTint(t) }) },
  { id: "tag", label: "Tag", w: 150, h: 60, shape: (t) => ({ type: "tag", fill: t, text: "FREE", labelColor: onTint(t) }) },
  { id: "bubble", label: "Bubble", w: 190, h: 84, shape: () => ({ type: "bubble", fill: "#ffffff", text: "So easy!", labelColor: "#1d1d1f" }) },
  { id: "laurel", label: "Laurel", w: 270, h: 108, shape: () => ({ type: "laurel", fill: "#e9c46a", text: "App of the Day" }) },
  { id: "rating", label: "Rating", w: 250, h: 74, shape: () => ({ type: "rating", fill: "#ffd60a", value: 5, text: "4.9 · 2K ratings" }) },
];

/** What an asset becomes: the new layers (not yet on the board), made with no parent. */
async function layersFor(a) {
  if (a.kind === "shape") {
    const k = BOARD_SHAPES.find((x) => x.id === a.id);
    const id = newId();
    if (k.css) return [{ id, type: "frame", name: k.label, parent: null, style: { width: `${k.w}px`, height: `${k.h}px`, flexShrink: "0", ...k.css(a.tint) }, children: [] }];
    const shape = k.shape(a.tint);
    return [{ id, type: "svg", name: k.label, parent: null, shape, svg: shapeInBox(shape, k.w, k.h), style: { width: `${k.w}px`, height: `${k.h}px`, flexShrink: "0" } }];
  }
  if (a.kind === "sticker" || a.kind === "art") {
    const res = await fetch(`/ui/${a.kind === "art" ? "art" : "stickers"}/${a.name}.svg`);
    if (!res.ok) throw new Error(`There's no ${a.kind === "art" ? "illustration" : "sticker"} called ${a.name}.`);
    let markup = await res.text();
    // An illustration in one ink takes the layer's colour, so it can be any colour.
    const mono = a.kind === "art" && !(S.opts?.colouredArt ?? []).includes(a.name);
    if (mono) markup = markup.replace(/#1d1d1f/gi, "currentColor");
    const got = htmlToNodes(markup);
    const n = got.nodes[got.roots[0]];
    const w0 = pxValue(n.style.width) ?? 100;
    const h0 = pxValue(n.style.height) ?? 100;
    const k = (a.kind === "art" ? 220 : 104) / Math.max(w0, h0);
    const style = { width: `${Math.round(w0 * k)}px`, height: `${Math.round(h0 * k)}px`, flexShrink: "0" };
    if (mono) style.color = "#1d1d1f";
    // A sticker's die-cut white edge and soft shadow, as in the design editor.
    if (a.kind === "sticker") style.filter = "drop-shadow(2px 0 0 #fff) drop-shadow(-2px 0 0 #fff) drop-shadow(0 2px 0 #fff) drop-shadow(0 -2px 0 #fff) drop-shadow(0 6px 10px rgba(0,0,0,0.22))";
    return [{ ...n, id: newId(), name: a.name.replace(/-/g, " ").replace(/^./, (c) => c.toUpperCase()), parent: null, style }];
  }
  if (a.kind === "picture") {
    const size = await naturalSize(fileUrl(a.path));
    const k = Math.min(1, (a.max ?? 360) / Math.max(size.width, size.height));
    return [{ id: newId(), type: "image", name: a.path.split("/").pop().replace(/\.[a-z0-9]+$/i, ""), parent: null, src: a.path, style: { width: `${Math.round(size.width * k)}px`, height: `${Math.round(size.height * k)}px`, objectFit: "cover", flexShrink: "0" } }];
  }
  if (a.kind === "device") {
    const t = toast({ kind: "info", icon: "phone", title: "Putting it in a device…", timeout: 60000 });
    try {
      const r = await api("/api/board/device", a.node ? { board: B.id, node: a.node } : { screenshot: a.path });
      const k = 460 / r.height;
      return [{ id: newId(), type: "image", name: a.name ?? "Device", parent: null, src: r.path, style: { width: `${Math.round(r.width * k)}px`, height: `${Math.round(r.height * k)}px`, objectFit: "contain", flexShrink: "0" } }];
    } finally {
      dismiss(t);
    }
  }
  if (a.kind === "backdrop") {
    const r = await api("/api/board/backdrop", { background: a.look, width: 800, height: 1000 });
    return [{ id: newId(), type: "image", name: a.look, parent: null, src: r.path, style: { width: "400px", height: "500px", objectFit: "cover", flexShrink: "0" } }];
  }
  return [];
}

const naturalSize = (src) =>
  new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth || 400, height: img.naturalHeight || 300 });
    img.onerror = () => resolve({ width: 400, height: 300 });
    img.src = src;
  });

/** Where an asset clicked (not dropped) goes: into the selected frame, else the middle of the view. */
function clickTarget() {
  const s = B.sel.filter((id) => node(id));
  const one = s.length === 1 ? node(s[0]) : null;
  if (one?.type === "frame" && !instanceRootOf(B.board, one.id)) return { into: one.id };
  if (one?.parent && !instanceRootOf(B.board, one.parent)) return { into: one.parent };
  return { into: null };
}

/** Put an asset on the board: dropped at a point, or clicked (into the selected frame). */
export async function addAsset(a, { at, into, ev } = {}) {
  if (a.kind === "component") return placeCopy(a.id, into !== undefined ? { into } : {});
  if (a.kind === "backdrop" && !at) {
    // With a frame selected, a backdrop is its fill.
    const s = B.sel.filter((id) => node(id)?.type === "frame");
    if (s.length) {
      try {
        const box = worldBox(s[0]) ?? { width: 800, height: 1000 };
        const r = await api("/api/board/backdrop", { background: a.look, width: Math.round(box.width * 2), height: Math.round(box.height * 2) });
        commit(s.map((id) => ({ op: "set", id, style: { backgroundImage: `url("${r.path}")`, backgroundSize: "cover", backgroundPosition: "center", backgroundRepeat: "no-repeat" } })), { label: "Backdrop" });
      } catch (e) {
        fail(e, "Couldn't make the backdrop");
      }
      return;
    }
  }
  try {
    const layers = await layersFor(a);
    if (!layers.length) return;
    let target = into;
    let point = at;
    if (target === undefined) target = clickTarget().into;
    if (!point) {
      // Into a frame laid out by hand, or onto the page: in the middle of what's showing.
      const box = target ? worldBox(target) : null;
      const c = canvasEl.current.getBoundingClientRect();
      const mid = box ? { x: box.x + box.width / 2, y: box.y + box.height / 2 } : toWorld(c.left + c.width / 2, c.top + c.height / 2);
      const w = pxValue(layers[0].style.width) ?? 100;
      const h = pxValue(layers[0].style.height) ?? 100;
      point = { x: Math.round(mid.x - w / 2), y: Math.round(mid.y - h / 2) };
      // Added again and again, each lands a little down and to the right of the last.
      const taken = (target ? node(target).children ?? [] : currentPage().children).map((id) => node(id)?.style).filter(Boolean);
      while (taken.some((st) => Math.abs((pxValue(st.left) ?? -1e9) - point.x) < 4 && Math.abs((pxValue(st.top) ?? -1e9) - point.y) < 4)) point = { x: point.x + 24, y: point.y + 24 };
    } else {
      const w = pxValue(layers[0].style.width) ?? 100;
      const h = pxValue(layers[0].style.height) ?? 100;
      point = { x: point.x - w / 2, y: point.y - h / 2 };
    }
    placeNew(layers, target ?? null, point, ev);
  } catch (e) {
    fail(e, "Couldn't add that");
  }
}

// ---------------------------------------------------------------------------------------------
// The panel

/** Start dragging an asset onto the canvas (the canvas takes it in its drop). */
const dragStart = (a) => (e) => {
  e.dataTransfer.setData("text/x-board-asset", JSON.stringify(a));
  e.dataTransfer.effectAllowed = "copy";
};

function Tile({ a, title, children, class: cls = "" }) {
  return html`<button class="bd-asset ${cls}" title=${title} draggable="true" onDragStart=${dragStart(a)} onClick=${() => addAsset(a)}>${children}</button>`;
}

function ShapeTile({ k, tint }) {
  const art = k.css ? html`<i class="bd-css-shape" style=${{ ...k.css(tint), aspectRatio: `${k.w} / ${k.h}` }}></i>` : html`<span class="bd-svg-shape" dangerouslySetInnerHTML=${{ __html: shapeInBox(k.shape(tint), k.w, k.h).replace(/^<svg\b/, '<svg style="width:100%;height:100%"') }}></span>`;
  return html`<${Tile} a=${{ kind: "shape", id: k.id, tint }} title=${`${k.label}: click to add it, or drag it onto the canvas`} class="shape">${art}<span class="nm">${k.label}</span><//>`;
}

export function AssetsPanel() {
  const b = useBoard();
  const s = useStore();
  const [tint, setTint] = useState(() => localStorage.getItem("board:tint") || "#ff3b30");
  const [pictures, setPictures] = useState([]);
  useEffect(() => {
    api("/api/images")
      .then((r) => setPictures(r.images ?? []))
      .catch(() => undefined);
  }, []);
  const pick = (c) => {
    setTint(c);
    try {
      localStorage.setItem("board:tint", c);
    } catch {}
  };
  const mains = Object.values(b.board.nodes).filter((n) => n.isComponent);
  const shots = (s.files ?? []).filter((f) => ["raw", "uploads", "recordings"].includes(f.kind) && /\.(png|jpe?g|webp)$/i.test(f.path)).slice(0, 24);
  const one = b.sel.length === 1 ? node(b.sel[0]) : null;
  const artboard = one && !one.parent && one.type === "frame" ? one : null;
  return html`<div class="bd-assets">
    ${mains.length > 0 &&
    html`<${Section} title="Components" count=${mains.length} collapsible id="bd-a-comps">
      ${mains.map((m) => html`<${Tile} a=${{ kind: "component", id: m.id }} title="Click to place a copy, or drag it onto the canvas" class="row"><${Icon} n="component" s=${14} /><span class="nm">${m.name}</span><//>`)}
    <//>`}
    <${Section} title="Shapes" collapsible id="bd-a-shapes">
      <div class="bd-tints">${TINTS.map((c) => html`<button class=${c === tint ? "on" : ""} style=${{ background: c }} title=${c} onClick=${() => pick(c)}></button>`)}</div>
      <div class="bd-asset-grid shapes">${BOARD_SHAPES.map((k) => html`<${ShapeTile} k=${k} tint=${tint} />`)}</div>
    <//>
    <${Section} title="Devices" collapsible id="bd-a-devices">
      <p class="bd-note">A screenshot in Apple's device frame, as a picture on the board.</p>
      ${artboard && html`<button class="btn sm block" onClick=${() => addAsset({ kind: "device", node: artboard.id, name: `${artboard.name} in a device` })}><${Icon} n="phone" s=${13} />Put “${artboard.name}” in a device</button>`}
      ${shots.length
        ? html`<div class="bd-asset-grid pics">${shots.map((f) => html`<${Tile} a=${{ kind: "device", path: f.path, name: "Device" }} title="Put this screenshot in a device"><img loading="lazy" draggable=${false} src=${thumbUrl(f.path, 160)} alt="" /><//>`)}</div>`
        : html`<p class="bd-note">Take or bring in a screenshot first (Screenshots, in the design editor).</p>`}
    <//>
    <${Section} title="Stickers" count=${s.opts?.stickers?.length} collapsible id="bd-a-stickers">
      <div class="bd-asset-grid icons">${(s.opts?.stickers ?? []).map((n) => html`<${Tile} a=${{ kind: "sticker", name: n }} title=${n}><img loading="lazy" draggable=${false} src=${`/ui/stickers/${n}.svg`} alt="" /><//>`)}</div>
    <//>
    <${Section} title="Illustrations" count=${s.opts?.art?.length} collapsible id="bd-a-art">
      <div class="bd-asset-grid icons">${(s.opts?.art ?? []).map((n) => html`<${Tile} a=${{ kind: "art", name: n }} class=${(s.opts?.colouredArt ?? []).includes(n) ? "" : "mono"} title=${n.replace(/-/g, " ")}><img loading="lazy" draggable=${false} src=${`/ui/art/${n}.svg`} alt="" /><//>`)}</div>
      <p class="bd-note">The ones drawn in one ink take any colour: change Colour on the right.</p>
    <//>
    ${pictures.length > 0 &&
    html`<${Section} title="Your pictures" count=${pictures.length} collapsible id="bd-a-pics">
      <div class="bd-asset-grid pics">${pictures.slice(0, 36).map((p) => html`<${Tile} a=${{ kind: "picture", path: p.path }} title=${p.path.split("/").pop()}><img loading="lazy" draggable=${false} src=${thumbUrl(p.path, 160)} alt="" /><//>`)}</div>
    <//>`}
    ${shots.length > 0 &&
    html`<${Section} title="Screenshots" count=${shots.length} collapsible open=${false} id="bd-a-shots">
      <div class="bd-asset-grid pics">${shots.map((f) => html`<${Tile} a=${{ kind: "picture", path: f.path, max: 420 }} title=${f.path.split("/").pop()}><img loading="lazy" draggable=${false} src=${thumbUrl(f.path, 160)} alt="" /><//>`)}</div>
    <//>`}
    <${Section} title="Backdrops" collapsible open=${false} id="bd-a-backdrops">
      <p class="bd-note">With a frame selected, a backdrop becomes its fill; otherwise it's added as a picture.</p>
      <div class="bd-asset-grid pics">${(s.opts?.looks ?? []).slice(0, 40).map((l) => html`<${Tile} a=${{ kind: "backdrop", look: l.name }} title=${l.description ?? l.name}><img loading="lazy" draggable=${false} src=${`/api/look-thumb?name=${encodeURIComponent(l.name)}`} alt="" /><//>`)}</div>
    <//>
  </div>`;
}
