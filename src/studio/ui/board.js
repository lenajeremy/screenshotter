// The board editor: a design tool where agents and people work on the same HTML and CSS. Pages and
// layers on the left, the canvas in the middle, the layer's CSS (in words) on the right.
import { useEffect, useRef, useState } from "preact/hooks";
import { ancestors, cloneTree, componentOps, copyTree, detachOps, freeSpot, htmlToNodes, inFlow, instanceRootOf, instanceTree, instancesOf, isFlex, mainOf, newId, nodeHtml, parseHtml, plainText, pxValue, resetOps, rootOf, siblingsOf, subtree, uncomponentOps } from "./board-core.js";
import { B, bset, closeBoard, commit, currentPage, node, redo, select, selectedArtboards, undo, useBoard } from "./board-state.js";
import { BoardCanvas, canvasEl, elOf, fit, placeNew, placeOf, toWorld, worldBox, zoomBy, zoomTo } from "./board-canvas.js";
import { Inspector } from "./board-inspector.js";
import { Popover, Seg, html } from "./controls.js";
import { Icon } from "./icons.js";
import { openMenu } from "./menu.js";
import { S, api, fail, toast } from "./store.js";

const mod = navigator.platform.includes("Mac") ? "⌘" : "Ctrl+";

// =============================================================================================
// The shell

export function BoardApp() {
  const b = useBoard();
  useEffect(() => {
    addEventListener("keydown", onKey);
    addEventListener("copy", onCopy);
    addEventListener("cut", onCut);
    addEventListener("paste", onPaste);
    return () => {
      removeEventListener("keydown", onKey);
      removeEventListener("copy", onCopy);
      removeEventListener("cut", onCut);
      removeEventListener("paste", onPaste);
    };
  }, []);
  if (!b.board) return html`<div class="bd-app"><div class="boot"><div class="boot-mark"></div></div></div>`;
  return html`<div class="bd-app ${b.leftOpen ? "" : "left-closed"} ${b.rightOpen ? "" : "right-closed"}">
    <${BoardTopbar} />
    ${b.leftOpen && html`<aside class="panel bd-left"><${PagesList} /><${ComponentsList} /><${LayersList} /></aside>`}
    <main class="bd-stage"><${BoardCanvas} /></main>
    ${b.rightOpen && html`<aside class="panel bd-right"><${Inspector} /></aside>`}
  </div>`;
}

const TOOLS = [
  { id: "move", icon: "pointer", label: "Move", key: "V" },
  { id: "frame", icon: "frame", label: "Frame", key: "F" },
  { id: "rect", icon: "square", label: "Rectangle", key: "R" },
  { id: "text", icon: "text", label: "Text", key: "T" },
  { id: "image", icon: "image", label: "Image", key: "⇧⌘K" },
  { id: "hand", icon: "hand", label: "Pan", key: "H or Space" },
];

function BoardTopbar() {
  const b = useBoard();
  const exportBtn = useRef();
  const zoomBtn = useRef();
  const [exporting, setExporting] = useState(false);
  const [zoomOpen, setZoomOpen] = useState(false);
  return html`<header class="topbar bd-topbar" data-drag>
    <div class="brand">
      <div class="brand-mark"></div>
      <button class="btn ghost sm bd-back" data-nodrag title="Back to My designs" onClick=${() => closeBoard()}><${Icon} n="left" s=${14} />My designs</button>
      <span class="crumb-sep" aria-hidden="true">/</span>
      <input class="scene-name" data-nodrag value=${b.board.name} spellcheck=${false} title="Rename this board"
        onKeyDown=${(e) => {
          e.stopPropagation();
          if (e.key === "Enter" || e.key === "Escape") e.target.blur();
        }}
        onChange=${(e) => {
          const name = e.target.value.trim();
          if (name && name !== B.board.name) commit([{ op: "rename", name }], { label: "Rename" });
          else e.target.value = B.board.name;
        }} />
    </div>
    <div class="topbar-center bd-tools" data-nodrag role="toolbar" aria-label="Tools">
      ${TOOLS.map((t) => html`<button class="icon-btn ${b.tool === t.id ? "on" : ""}" title=${`${t.label} (${t.key})`} aria-pressed=${b.tool === t.id}
          onClick=${() => (t.id === "image" ? pickImages() : bset({ tool: t.id }))}><${Icon} n=${t.icon} s=${16} /></button>`)}
    </div>
    <span class="spacer"></span>
    <div class="hstack" data-nodrag>
      ${b.working.length > 0 && html`<span class="bd-agent-pill" title="An agent is changing this board: you'll see each change as it lands"><i></i>Agent at work</span>`}
      <button class="icon-btn" title="Undo (⌘Z)" disabled=${!b.past.length} onClick=${undo}><${Icon} n="undo" s=${16} /></button>
      <button class="icon-btn" title="Redo (⇧⌘Z)" disabled=${!b.future.length} onClick=${redo}><${Icon} n="redo" s=${16} /></button>
      <button class="btn ghost sm bd-zoom" ref=${zoomBtn} title="Zoom" onClick=${() => setZoomOpen(!zoomOpen)}>${Math.round(b.view.z * 100)}%<${Icon} n="down" s=${12} /></button>
      <button class="btn primary" ref=${exportBtn} disabled=${!currentPage()?.children.length} onClick=${() => setExporting(!exporting)}><${Icon} n="export" s=${15} w=${2} />Export</button>
      <span class="topbar-sep"></span>
      <button class="icon-btn ${b.leftOpen ? "on" : ""}" title="Pages and layers (⌥⌘S)" onClick=${() => bset({ leftOpen: !B.leftOpen })}><${Icon} n="sidebar" s=${16} /></button>
      <button class="icon-btn ${b.rightOpen ? "on" : ""}" title="Design (⌥⌘I)" onClick=${() => bset({ rightOpen: !B.rightOpen })}><${Icon} n="sidebarR" s=${16} /></button>
    </div>
    ${zoomOpen && html`<${Popover} anchor=${zoomBtn.current} onClose=${() => setZoomOpen(false)} width=${210} align="end">
      <div class="bd-menu">
        ${[
          ["Zoom in", "⌘+", () => zoomBy(1.25)],
          ["Zoom out", "⌘−", () => zoomBy(0.8)],
          ["Zoom to 100%", "⇧0", () => zoomTo(1)],
          ["Fit the page", "⇧1", () => fit()],
          ["Zoom to selection", "⇧2", () => fit(B.sel)],
        ].map(([label, kbd, run]) => html`<button class="ctx-item" onClick=${() => (run(), setZoomOpen(false))}><span class="ctx-label">${label}</span><span class="ctx-kbd">${kbd}</span></button>`)}
      </div>
    <//>`}
    ${exporting && html`<${ExportPopover} anchor=${exportBtn.current} onClose=${() => setExporting(false)} />`}
  </header>`;
}

function ExportPopover({ anchor, onClose }) {
  const [scale, setScale] = useState(() => Number(localStorage.getItem("board:scale")) || 2);
  const [format, setFormat] = useState(() => localStorage.getItem("board:format") || "png");
  const [busy, setBusy] = useState(false);
  const ids = B.sel.length ? B.sel.slice() : currentPage().children.filter((id) => !node(id)?.hidden);
  const what = B.sel.length ? `${ids.length} selected layer${ids.length === 1 ? "" : "s"}` : `${ids.length} artboard${ids.length === 1 ? "" : "s"} on this page`;
  const run = async () => {
    setBusy(true);
    try {
      localStorage.setItem("board:scale", String(scale));
      localStorage.setItem("board:format", format);
    } catch {}
    try {
      const r = await api("/api/board/export", { id: B.id, nodes: ids, scale, format });
      onClose();
      toast({ kind: "ok", icon: "export", title: `Exported ${r.files.length} image${r.files.length === 1 ? "" : "s"}`, text: r.files[0]?.split("/").slice(-2).join("/"), timeout: 9000, actions: [{ label: "Show in Finder", run: () => api("/api/reveal", { path: r.files[0] }).catch(fail) }] });
    } catch (e) {
      fail(e, "Couldn't export");
    } finally {
      setBusy(false);
    }
  };
  return html`<${Popover} anchor=${anchor} onClose=${onClose} width=${280} align="end">
    <div class="bd-pop">
      <h4>Export ${what}</h4>
      <div class="row"><label>Size</label><${Seg} value=${scale} options=${[{ value: 1, label: "1×" }, { value: 2, label: "2×" }, { value: 3, label: "3×" }]} onChange=${setScale} /></div>
      <div class="row"><label>Format</label><${Seg} value=${format} options=${[{ value: "png", label: "PNG" }, { value: "jpeg", label: "JPEG" }]} onChange=${setFormat} /></div>
      <button class="btn primary block" disabled=${busy || !ids.length} onClick=${run}>${busy ? html`<span class="spinner"></span>Exporting…` : "Export"}</button>
      <button class="btn ghost block sm" onClick=${() => (copyHtml(ids), onClose())}><${Icon} n="code" s=${13} />Copy as HTML</button>
      <button class="btn ghost block sm" title="Make a Screenshotter design with this artboard as the screen in a device frame" onClick=${() => (onClose(), artboardToDesign(B.sel.length ? undefined : ids))}><${Icon} n="phone" s=${13} />Put in a device frame</button>
    </div>
  <//>`;
}

// =============================================================================================
// Pages

function PagesList() {
  const b = useBoard();
  const [renaming, setRenaming] = useState(null);
  const add = () => {
    const id = newId();
    commit([{ op: "addPage", page: { id, name: `Page ${B.board.pages.length + 1}`, children: [] } }], { label: "Add page" });
    bset({ page: id, sel: [] });
    setRenaming(id);
  };
  const menu = (e, p) => {
    e.preventDefault();
    openMenu(e.clientX, e.clientY, [
      { label: "Rename", icon: "text", run: () => setRenaming(p.id) },
      { label: "Delete page", icon: "trash", danger: true, disabled: B.board.pages.length < 2, run: () => commit([{ op: "deletePage", id: p.id }], { label: "Delete page" }) },
    ]);
  };
  return html`<section class="bd-pages">
    <div class="bd-head"><h3>Pages</h3><button class="icon-btn sm" title="Add a page" onClick=${add}><${Icon} n="plus" s=${14} /></button></div>
    ${b.board.pages.map((p) => html`<div key=${p.id} class="bd-page ${p.id === (b.page ?? b.board.pages[0].id) ? "on" : ""}" onClick=${() => p.id !== B.page && bset({ page: p.id, sel: [], hover: null, view: { ...B.view, fitPending: true } })} onDblClick=${() => setRenaming(p.id)} onContextMenu=${(e) => menu(e, p)}>
        <${Icon} n="page" s=${14} />
        ${renaming === p.id
          ? html`<${NameInput} value=${p.name} onDone=${(v) => (setRenaming(null), v && v !== p.name && commit([{ op: "setPage", id: p.id, name: v }], { label: "Rename page" }))} />`
          : html`<span class="nm">${p.name}</span>`}
        <span class="n">${p.children.length || ""}</span>
      </div>`)}
  </section>`;
}

function NameInput({ value, onDone }) {
  const ref = useRef();
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  return html`<input ref=${ref} class="bd-name-input" value=${value} spellcheck=${false}
    onClick=${(e) => e.stopPropagation()} onPointerDown=${(e) => e.stopPropagation()}
    onKeyDown=${(e) => {
      e.stopPropagation();
      if (e.key === "Enter") onDone(e.target.value.trim());
      if (e.key === "Escape") onDone(null);
    }}
    onBlur=${(e) => onDone(e.target.value.trim())} />`;
}

// =============================================================================================
// Layers

export function layerIcon(n, b = B.board) {
  if (n.isComponent) return "component";
  if (n.instanceOf) return "instance";
  if (n.type === "text") return "text";
  if (n.type === "image") return "image";
  if (n.type === "svg") return "vector";
  if (!n.parent) return "frame";
  if (isFlex(n)) return (n.style.flexDirection ?? "row").startsWith("column") ? "flexCol" : "flexRow";
  void b;
  return (n.children ?? []).length ? "freeLayout" : "square";
}

function LayersList() {
  const b = useBoard();
  const page = currentPage();
  const ref = useRef();
  const rows = [];
  const walk = (id, depth) => {
    const n = b.board.nodes[id];
    if (!n) return;
    rows.push({ id, depth, n });
    if (n.children?.length && b.open.has(id)) for (const c of n.children) walk(c, depth + 1);
  };
  for (const id of page?.children ?? []) walk(id, 0);
  // Keep the selected layer in sight.
  useEffect(() => {
    const el = ref.current?.querySelector(".bd-row.on");
    el?.scrollIntoView?.({ block: "nearest" });
  }, [b.sel.join()]);
  return html`<section class="bd-layers" ref=${ref}>
    <div class="bd-head"><h3>Layers</h3></div>
    <div class="bd-rows" onPointerDown=${layerDown}>
      ${rows.length ? rows.map((r) => html`<${LayerRow} key=${r.id} ...${r} />`) : html`<p class="bd-hint">Layers you draw, paste or an agent writes appear here.</p>`}
      ${b.drop?.layer && html`<div class="bd-row-drop ${b.drop.layer.inside ? "inside" : ""}" style=${{ top: b.drop.layer.y + "px", left: b.drop.layer.x + "px" }}></div>`}
    </div>
  </section>`;
}

function LayerRow({ id, depth, n }) {
  const on = B.sel.includes(id);
  const open = B.open.has(id);
  const toggle = (e) => {
    e.stopPropagation();
    const o = new Set(B.open);
    o.has(id) ? o.delete(id) : o.add(id);
    bset({ open: o });
  };
  const name = n.type === "text" && /^Text$|^Text \d+$/.test(n.name) ? plainText(n.text).slice(0, 40) || n.name : n.name;
  return html`<div class="bd-row ${on ? "on" : ""} ${B.hover === id ? "hover" : ""} ${n.hidden ? "hidden" : ""} ${!n.parent ? "root" : ""}" data-lid=${id} style=${{ paddingLeft: 6 + depth * 14 + "px" }}
      onPointerEnter=${() => bset({ hover: id })} onPointerLeave=${() => B.hover === id && bset({ hover: null })}
      onDblClick=${(e) => (e.stopPropagation(), bset({ renaming: id }))}
      onContextMenu=${(e) => {
        e.preventDefault();
        if (!B.sel.includes(id)) select(id);
        openLayerMenu(e.clientX, e.clientY);
      }}>
    ${n.children?.length ? html`<button class="tw ${open ? "open" : ""}" onPointerDown=${(e) => e.stopPropagation()} onClick=${toggle} aria-label=${open ? "Close" : "Open"}><${Icon} n="right" s=${11} w=${2} /></button>` : html`<span class="tw"></span>`}
    <span class="ico"><${Icon} n=${layerIcon(n)} s=${14} /></span>
    ${B.renaming === id
      ? html`<${NameInput} value=${n.name} onDone=${(v) => (bset({ renaming: null }), v && v !== n.name && commit([{ op: "set", id, name: v }], { label: "Rename" }))} />`
      : html`<span class="nm">${name}</span>`}
    <span class="acts">
      <button class="icon-btn sm ${n.locked ? "keep" : ""}" title=${n.locked ? "Unlock (⇧⌘L)" : "Lock (⇧⌘L)"} onPointerDown=${(e) => e.stopPropagation()} onClick=${(e) => (e.stopPropagation(), commit([{ op: "set", id, locked: n.locked ? null : true }], { label: n.locked ? "Unlock" : "Lock" }))}><${Icon} n=${n.locked ? "lock" : "unlock"} s=${12} /></button>
      <button class="icon-btn sm ${n.hidden ? "keep" : ""}" title=${n.hidden ? "Show (⇧⌘H)" : "Hide (⇧⌘H)"} onPointerDown=${(e) => e.stopPropagation()} onClick=${(e) => (e.stopPropagation(), commit([{ op: "set", id, hidden: n.hidden ? null : true }], { label: n.hidden ? "Show" : "Hide" }))}><${Icon} n=${n.hidden ? "eyeOff" : "eye"} s=${12} /></button>
    </span>
  </div>`;
}

/** Click a row to select it (⇧ for a range, ⌘ to add); drag it to move the layer. */
function layerDown(e) {
  const row = e.target.closest?.(".bd-row");
  if (!row || e.button !== 0) return;
  const id = row.dataset.lid;
  if (e.metaKey || e.ctrlKey) select(id, { toggle: true });
  else if (e.shiftKey && B.sel.length) {
    const ids = [...document.querySelectorAll(".bd-rows .bd-row")].map((r) => r.dataset.lid);
    const a = ids.indexOf(B.sel[B.sel.length - 1]);
    const z = ids.indexOf(id);
    select(ids.slice(Math.min(a, z), Math.max(a, z) + 1));
  } else if (!B.sel.includes(id)) select(id);
  const list = row.closest(".bd-rows");
  const x0 = e.clientX;
  const y0 = e.clientY;
  let live = false;
  let target = null;
  const move = (ev) => {
    if (!live && Math.hypot(ev.clientX - x0, ev.clientY - y0) < 4) return;
    live = true;
    const over = document.elementFromPoint(ev.clientX, ev.clientY)?.closest?.(".bd-row");
    if (!over || over.dataset.lid === id || ancestors(B.board, over.dataset.lid).includes(id)) return bset({ drop: null });
    const r = over.getBoundingClientRect();
    const lr = list.getBoundingClientRect();
    const oid = over.dataset.lid;
    const on = node(oid);
    const f = (ev.clientY - r.top) / r.height;
    const inside = on.type === "frame" && f > 0.28 && f < 0.72;
    const before = !inside && f <= 0.5;
    target = inside ? { parent: oid, index: (on.children ?? []).length } : { ref: oid, after: !before };
    bset({ drop: { layer: { y: (inside ? r.top + r.height / 2 : before ? r.top : r.bottom) - lr.top + list.scrollTop, x: (parseFloat(over.style.paddingLeft) || 6) + (inside ? 18 : 0), inside } } });
  };
  const up = () => {
    removeEventListener("pointermove", move);
    removeEventListener("pointerup", up);
    bset({ drop: null });
    if (!live || !target) return;
    const ids = B.sel.includes(id) ? B.sel.filter((x) => !B.sel.some((y) => y !== x && ancestors(B.board, x).includes(y))) : [id];
    const ops = [];
    let parent;
    let index;
    if (target.ref) {
      const r = node(target.ref);
      parent = r.parent;
      const sibs = siblingsOf(B.board, target.ref).filter((x) => !ids.includes(x));
      index = sibs.indexOf(target.ref) + (target.after ? 1 : 0);
    } else {
      parent = target.parent;
      index = (node(parent).children ?? []).filter((x) => !ids.includes(x)).length;
    }
    if (parent && ids.some((x) => x === parent || ancestors(B.board, parent).includes(x))) return;
    const pageId = parent ? undefined : currentPage().id;
    for (const [k, x] of ids.entries()) {
      ops.push({ op: "move", id: x, parent, page: pageId, index: index + k });
      // Leaving a frame for the page: it keeps its place on the board.
      if (!parent && node(x).parent) {
        const wb = worldBox(x);
        if (wb) ops.push({ op: "set", id: x, style: { position: null, left: `${Math.round(wb.x)}px`, top: `${Math.round(wb.y)}px` } });
      } else if (parent && !node(x).parent) ops.push({ op: "set", id: x, style: { left: null, top: null } });
    }
    commit(ops, { label: "Move" });
  };
  addEventListener("pointermove", move);
  addEventListener("pointerup", up);
}

// =============================================================================================
// Things to do with the selection

const sel = () => B.sel.filter((id) => node(id));
/** The selected layers without any inside another selected one. */
const outermost = () => {
  const s = sel();
  return s.filter((id) => !ancestors(B.board, id).some((a) => s.includes(a)));
};

export function startTextEdit(id) {
  if (node(id)?.type !== "text" || node(id)?.locked) return;
  bset({ editing: id, sel: [id], tool: "move" });
}

export function deleteSelection() {
  const ids = outermost().filter((id) => !node(id).locked);
  if (!ids.length) return;
  const parent = node(ids[0]).parent;
  commit([{ op: "delete", ids }], { label: "Delete" });
  select(parent && node(parent) ? [parent] : []);
}

export function duplicateSelection() {
  const ids = outermost();
  if (!ids.length) return;
  const ops = [];
  const made = [];
  for (const id of ids) {
    const n = node(id);
    // A component's duplicate is a copy of it, which follows it.
    const clone = copyTree(B.board, id, n.parent);
    const c = clone.nodes[clone.id];
    if (!n.parent) {
      // A copied artboard goes beside the original.
      const w = worldBox(id)?.width ?? pxValue(n.style.width) ?? 400;
      c.style.left = `${Math.round((pxValue(n.style.left) ?? 0) + w + 80)}px`;
    } else if (!inFlow(B.board, id)) {
      c.style.left = `${Math.round((pxValue(n.style.left) ?? 0) + 16)}px`;
      c.style.top = `${Math.round((pxValue(n.style.top) ?? 0) + 16)}px`;
    }
    if (!n.isComponent) c.name = n.name;
    const sibs = siblingsOf(B.board, id);
    ops.push({ op: "add", nodes: clone.nodes, ids: [clone.id], parent: n.parent, page: n.parent ? undefined : currentPage().id, index: sibs.indexOf(id) + 1 + made.filter((m) => node(m)?.parent === n.parent).length });
    made.push(clone.id);
  }
  commit(ops, { label: "Duplicate" });
  select(made);
}

/** Put the selected layers (side by side in one frame) into a new frame: a flex one unless `free`. */
export function wrapSelection({ free = false } = {}) {
  const ids = outermost();
  if (!ids.length) return;
  const parent = node(ids[0]).parent;
  if (ids.some((id) => node(id).parent !== parent)) return toast({ kind: "err", title: "Pick layers in the same frame", text: "Only layers side by side can go into one frame." });
  const sibs = siblingsOf(B.board, ids[0]);
  const ordered = sibs.filter((x) => ids.includes(x));
  const boxes = ordered.map(worldBox);
  const minX = Math.min(...boxes.map((b) => b.x));
  const minY = Math.min(...boxes.map((b) => b.y));
  const maxX = Math.max(...boxes.map((b) => b.x + b.width));
  const maxY = Math.max(...boxes.map((b) => b.y + b.height));
  // A row if they sit side by side, else a column; the gap between them as it is now.
  const row = ordered.length > 1 && maxX - minX - Math.max(...boxes.map((b) => b.width)) > maxY - minY - Math.max(...boxes.map((b) => b.height));
  const gaps = boxes.slice(1).map((b, i) => (row ? b.x - (boxes[i].x + boxes[i].width) : b.y - (boxes[i].y + boxes[i].height))).filter((g) => g > 0);
  const gap = gaps.length ? Math.round(gaps.reduce((a, g) => a + g, 0) / gaps.length) : 0;
  const id = newId();
  const flowing = parent && inFlow(B.board, ordered[0]);
  const style = free ? { position: "relative", width: `${Math.round(maxX - minX)}px`, height: `${Math.round(maxY - minY)}px` } : { display: "flex", flexDirection: row ? "row" : "column", ...(gap ? { gap: `${gap}px` } : {}) };
  if (!flowing) {
    // Where it goes on its parent (or the page): where the layers were.
    const pb = parent ? worldBox(parent) : { x: 0, y: 0 };
    Object.assign(style, parent ? { position: "absolute" } : {}, { left: `${Math.round(minX - pb.x)}px`, top: `${Math.round(minY - pb.y)}px` });
  }
  const ops = [{ op: "add", nodes: { [id]: { id, type: "frame", name: free ? "Group" : "Frame", parent, style, children: [] } }, ids: [id], parent, page: parent ? undefined : currentPage().id, index: sibs.indexOf(ordered[0]) }];
  ordered.forEach((x, k) => {
    ops.push({ op: "move", id: x, parent: id, index: k });
    const b = boxes[k];
    if (free) ops.push({ op: "set", id: x, style: { position: "absolute", left: `${Math.round(b.x - minX)}px`, top: `${Math.round(b.y - minY)}px` } });
    else ops.push({ op: "set", id: x, style: { position: null, left: null, top: null } });
  });
  commit(ops, { label: "Wrap in frame" });
  select(id);
}

/** Take a frame's layers out of it (keeping where they are) and remove the frame. */
export function ungroupSelection() {
  const ids = outermost().filter((id) => node(id).type === "frame" && node(id).children?.length);
  if (!ids.length) return;
  const ops = [];
  const freed = [];
  for (const id of ids) {
    const n = node(id);
    const sibs = siblingsOf(B.board, id);
    let at = sibs.indexOf(id);
    const flowing = n.parent && isFlex(node(n.parent));
    const pb = n.parent ? worldBox(n.parent) : { x: 0, y: 0 };
    for (const c of n.children) {
      const cb = worldBox(c);
      ops.push({ op: "move", id: c, parent: n.parent, page: n.parent ? undefined : currentPage().id, index: at++ });
      if (!flowing && cb) ops.push({ op: "set", id: c, style: { ...(n.parent ? { position: "absolute" } : { position: null }), left: `${Math.round(cb.x - pb.x)}px`, top: `${Math.round(cb.y - pb.y)}px` } });
      freed.push(c);
    }
    ops.push({ op: "delete", ids: [id] });
  }
  commit(ops, { label: "Ungroup" });
  select(freed);
}

/** Lay a frame's layers out by hand (each where it is now) or with flex. */
export function setFlex(id, on) {
  const n = node(id);
  if (!n || n.type !== "frame") return;
  if (on) {
    const ops = [{ op: "set", id, style: { display: "flex", flexDirection: n.style.flexDirection ?? "column" } }];
    for (const c of n.children ?? []) ops.push({ op: "set", id: c, style: { position: null, left: null, top: null, right: null, bottom: null } });
    return commit(ops, { label: "Add flex" });
  }
  const fb = worldBox(id);
  const cs = getComputedStyle(elOf(id));
  const ops = [{ op: "set", id, style: { display: null, flexDirection: null, flexWrap: null, gap: null, rowGap: null, columnGap: null, justifyContent: null, alignItems: null, position: n.style.position ?? (n.parent ? "relative" : null), width: `${Math.round(fb.width)}px`, height: `${Math.round(fb.height)}px` } }];
  for (const c of n.children ?? []) {
    const cb = worldBox(c);
    if (!cb) continue;
    ops.push({ op: "set", id: c, style: { position: "absolute", left: `${Math.round(cb.x - fb.x - (parseFloat(cs.borderLeftWidth) || 0))}px`, top: `${Math.round(cb.y - fb.y - (parseFloat(cs.borderTopWidth) || 0))}px`, width: `${Math.round(cb.width)}px`, height: node(c).type === "text" ? node(c).style.height ?? null : `${Math.round(cb.height)}px`, flexGrow: null, flexBasis: null, alignSelf: null } });
  }
  commit(ops, { label: "Remove flex" });
}

/**
 * Line layers up: several by the box they make together, one by its frame. Only layers placed by
 * hand move; a frame's flex layout places the rest.
 */
export function alignSelection(edge) {
  const ids = outermost().filter((id) => !inFlow(B.board, id) && !node(id).locked);
  if (!ids.length) return;
  const boxes = Object.fromEntries(ids.map((id) => [id, worldBox(id)]).filter(([, b]) => b));
  let ref;
  if (ids.length === 1) {
    const p = node(ids[0]).parent;
    if (!p) return;
    const pb = worldBox(p);
    const cs = getComputedStyle(elOf(p));
    const bl = parseFloat(cs.borderLeftWidth) || 0;
    const bt = parseFloat(cs.borderTopWidth) || 0;
    ref = { x: pb.x + bl, y: pb.y + bt, width: pb.width - bl - (parseFloat(cs.borderRightWidth) || 0), height: pb.height - bt - (parseFloat(cs.borderBottomWidth) || 0) };
  } else {
    const all = Object.values(boxes);
    const x = Math.min(...all.map((b) => b.x));
    const y = Math.min(...all.map((b) => b.y));
    ref = { x, y, width: Math.max(...all.map((b) => b.x + b.width)) - x, height: Math.max(...all.map((b) => b.y + b.height)) - y };
  }
  const ops = [];
  for (const id of Object.keys(boxes)) {
    const b = boxes[id];
    const at = placeOf(id);
    const dx = edge === "left" ? ref.x - b.x : edge === "right" ? ref.x + ref.width - b.x - b.width : edge === "hcenter" ? ref.x + ref.width / 2 - b.x - b.width / 2 : 0;
    const dy = edge === "top" ? ref.y - b.y : edge === "bottom" ? ref.y + ref.height - b.y - b.height : edge === "vcenter" ? ref.y + ref.height / 2 - b.y - b.height / 2 : 0;
    if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) continue;
    ops.push({ op: "set", id, style: { left: `${Math.round(at.left + dx)}px`, top: `${Math.round(at.top + dy)}px`, ...(node(id).parent && node(id).style.position !== "absolute" ? { position: "absolute" } : {}) } });
  }
  commit(ops, { label: "Align" });
}

/** Even gaps between three or more layers, across or down. */
export function distributeSelection(axis) {
  const ids = outermost().filter((id) => !inFlow(B.board, id) && !node(id).locked);
  if (ids.length < 3) return toast({ kind: "info", title: "Pick three or more layers", text: "Their gaps are made even, between the first and the last.", timeout: 3000 });
  const x = axis === "x";
  const list = ids.map((id) => ({ id, b: worldBox(id), at: placeOf(id) })).filter((o) => o.b).sort((a, b) => (x ? a.b.x - b.b.x : a.b.y - b.b.y));
  const first = list[0].b;
  const last = list[list.length - 1].b;
  const span = x ? last.x + last.width - first.x : last.y + last.height - first.y;
  const sizes = list.reduce((t, o) => t + (x ? o.b.width : o.b.height), 0);
  const gap = (span - sizes) / (list.length - 1);
  let pos = x ? first.x : first.y;
  const ops = [];
  for (const o of list) {
    const d = pos - (x ? o.b.x : o.b.y);
    if (Math.abs(d) >= 0.5) ops.push({ op: "set", id: o.id, style: x ? { left: `${Math.round(o.at.left + d)}px` } : { top: `${Math.round(o.at.top + d)}px` } });
    pos += (x ? o.b.width : o.b.height) + gap;
  }
  commit(ops, { label: "Distribute" });
}

/** Whether the selection can be lined up (layers placed by hand, not by a flex layout). */
export const canAlign = () => {
  const ids = outermost().filter((id) => !inFlow(B.board, id));
  return ids.length > 1 || (ids.length === 1 && Boolean(node(ids[0]).parent));
};

function restack(where) {
  const ids = outermost();
  if (!ids.length) return;
  const ops = [];
  for (const id of ids) {
    const n = node(id);
    const sibs = siblingsOf(B.board, id);
    const i = sibs.indexOf(id);
    const to = where === "front" ? sibs.length - 1 : where === "back" ? 0 : where === "forward" ? Math.min(sibs.length - 1, i + 1) : Math.max(0, i - 1);
    if (to !== i) ops.push({ op: "move", id, parent: n.parent, page: n.parent ? undefined : currentPage().id, index: to });
  }
  commit(ops, { label: "Reorder" });
}

const toggleAll = (key) => {
  const ids = sel();
  if (!ids.length) return;
  const on = !ids.every((id) => node(id)[key]);
  commit(ids.map((id) => ({ op: "set", id, [key]: on ? true : null })), { label: key === "hidden" ? (on ? "Hide" : "Show") : on ? "Lock" : "Unlock" });
};

function nudge(dx, dy) {
  const ids = sel().filter((id) => !inFlow(B.board, id) && !node(id).locked);
  if (!ids.length) return;
  commit(
    ids.map((id) => {
      const n = node(id);
      const wb = worldBox(id);
      const pb = n.parent ? worldBox(n.parent) : { x: 0, y: 0 };
      const l = pxValue(n.style.left) ?? Math.round(wb.x - pb.x);
      const t = pxValue(n.style.top) ?? Math.round(wb.y - pb.y);
      return { op: "set", id, style: { left: `${l + dx}px`, top: `${t + dy}px` } };
    }),
    { key: `nudge:${ids.join()}`, label: "Move" },
  );
}

function selectAll() {
  const s = sel();
  const n = s.length ? node(s[0]) : null;
  select(n ? siblingsOf(B.board, s[0]) : currentPage().children.slice());
}

function selectParent() {
  if (B.editing) return bset({ editing: null });
  if (B.tool !== "move") return bset({ tool: "move" });
  const s = sel();
  if (!s.length) return;
  const p = node(s[0]).parent;
  select(p ? [p] : []);
}

function selectChildren() {
  const s = sel();
  if (s.length !== 1) return;
  const n = node(s[0]);
  if (n.type === "text") return startTextEdit(n.id);
  if (n.children?.length) select(n.children.filter((c) => !node(c).hidden));
}

function selectNextSibling(back) {
  const s = sel();
  if (s.length !== 1) return;
  const sibs = siblingsOf(B.board, s[0]);
  const i = sibs.indexOf(s[0]);
  select(sibs[(i + (back ? -1 : 1) + sibs.length) % sibs.length]);
}

// =============================================================================================
// Clipboard: layers copy as HTML (they paste as layers here, and as HTML anywhere else)

let clip = null;

function copySelection() {
  const ids = outermost();
  if (!ids.length) return null;
  const nodes = {};
  for (const id of ids) for (const x of subtree(B.board, id)) nodes[x] = structuredClone(node(x));
  const token = newId(8);
  clip = { token, ids, nodes, boxes: Object.fromEntries(ids.map((id) => [id, worldBox(id)])) };
  return { token, html: ids.map((id) => nodeHtml(B.board, id)).join("\n") };
}

function copyHtml(ids) {
  const text = ids.map((id) => nodeHtml(B.board, id)).join("\n");
  navigator.clipboard
    .writeText(text)
    .then(() => toast({ kind: "ok", icon: "code", title: "Copied as HTML", text: `${ids.length} layer${ids.length === 1 ? "" : "s"}, styles inline`, timeout: 2600 }))
    .catch((e) => fail(e, "Couldn't copy"));
}

const typingNow = () => {
  const a = document.activeElement;
  return Boolean(a && (/INPUT|TEXTAREA|SELECT/.test(a.tagName) || a.isContentEditable));
};

function onCopy(e) {
  if (!S.boardId || typingNow() || S.modal) return;
  const got = copySelection();
  if (!got) return;
  e.preventDefault();
  e.clipboardData.setData("text/html", `<!--board:${got.token}-->${got.html}`);
  e.clipboardData.setData("text/plain", got.html);
}

function onCut(e) {
  if (!S.boardId || typingNow() || S.modal) return;
  onCopy(e);
  if (clip) deleteSelection();
}

/** Where pasted layers go: into the selected frame, beside the selected layer, or on the page. */
function pasteTarget() {
  const s = sel();
  if (s.length === 1) {
    const n = node(s[0]);
    if (n.type === "frame" && !(clip?.ids ?? []).includes(n.id)) return { into: n.id };
    return { into: n.parent, after: n.id };
  }
  return { into: null };
}

function onPaste(e) {
  if (!S.boardId || typingNow() || S.modal) return;
  const files = [...(e.clipboardData?.files ?? [])].filter((f) => /^image\//.test(f.type));
  const htmlText = e.clipboardData?.getData("text/html") ?? "";
  const plain = e.clipboardData?.getData("text/plain") ?? "";
  e.preventDefault();
  if (files.length && !htmlText) return addImages(files, pasteTarget());
  const mark = /<!--board:([a-z0-9]+)-->/.exec(htmlText);
  if (mark && clip?.token === mark[1]) return pasteLayers(clip);
  const source = /<[a-z][\s\S]*>/i.test(plain) ? plain : htmlText && /<[a-z]/i.test(htmlText) && !/^\s*<meta/i.test(htmlText) ? htmlText : null;
  if (source) {
    const got = htmlToNodes(source);
    if (got.roots.length) {
      pasteLayers({ ids: got.roots, nodes: got.nodes, boxes: {} });
      if (got.warnings.length) toast({ kind: "info", title: "Pasted the HTML", text: got.warnings[0], timeout: 9000 });
      return;
    }
  }
  if (plain.trim()) {
    const id = newId();
    const text = plain.trim().replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/\n/g, "<br>");
    pasteLayers({ ids: [id], nodes: { [id]: { id, type: "text", name: plain.trim().slice(0, 40), parent: null, style: { fontSize: "16px" }, text } }, boxes: {} });
  }
}

function pasteLayers(from) {
  const t = pasteTarget();
  const fake = { nodes: from.nodes };
  const made = [];
  const nodes = {};
  for (const id of from.ids) {
    // A component pasted on its own board is a copy of it; links to another board's components are let go.
    const live = B.board.nodes[id];
    const c = live?.isComponent ? copyTree(B.board, id, null) : cloneTree(fake, id, null);
    for (const n of Object.values(c.nodes)) {
      if ((n.master && !B.board.nodes[n.master]) || (n.instanceOf && !B.board.nodes[n.instanceOf]?.isComponent)) {
        delete n.master;
        delete n.instanceOf;
        delete n.overrides;
      }
      if (n.isComponent) delete n.isComponent;
    }
    Object.assign(nodes, c.nodes);
    made.push(c.id);
  }
  if (!t.into) {
    // On the page: beside where they were copied from, else in the middle of the view.
    const c = canvasEl.current.getBoundingClientRect();
    const mid = toWorld(c.left + c.width / 2, c.top + c.height / 2);
    made.forEach((id, k) => {
      const b = from.boxes[from.ids[k]];
      const s = nodes[id].style;
      delete s.position;
      s.left = `${Math.round(b ? b.x + 40 : mid.x - 160 + k * 40)}px`;
      s.top = `${Math.round(b ? b.y + 40 : mid.y - 120 + k * 40)}px`;
    });
    commit([{ op: "add", nodes, ids: made, parent: null, page: currentPage().id }], { label: "Paste" });
  } else {
    const f = node(t.into);
    for (const id of made) {
      const s = nodes[id].style;
      nodes[id].parent = t.into;
      if (isFlex(f)) {
        delete s.left;
        delete s.top;
        if (s.position === "absolute") delete s.position;
      } else if (!s.position) {
        s.position = "absolute";
        s.left ??= "16px";
        s.top ??= "16px";
      }
    }
    const index = t.after ? (f.children ?? []).indexOf(t.after) + 1 : undefined;
    commit([{ op: "add", nodes, ids: made, parent: t.into, index }], { label: "Paste" });
  }
  select(made);
}

let styleClip = null;
function copyStyles() {
  const s = sel();
  if (s.length !== 1) return;
  const { left, top, position, ...style } = node(s[0]).style;
  void left;
  void top;
  void position;
  styleClip = style;
  toast({ kind: "ok", icon: "copy", title: "Copied the styles", timeout: 1600 });
}
function pasteStyles() {
  if (!styleClip) return;
  const s = sel();
  commit(s.map((id) => ({ op: "set", id, style: Object.fromEntries([...Object.keys(node(id).style).filter((k) => !["left", "top", "position"].includes(k)).map((k) => [k, null]), ...Object.entries(styleClip)]) })), { label: "Paste styles" });
}

// =============================================================================================
// Images

function pickImages() {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = "image/png,image/jpeg,image/webp,image/gif,image/svg+xml";
  input.multiple = true;
  input.onchange = () => addImages([...input.files], pasteTarget());
  input.click();
}

export async function addImages(files, { at, into, after, ev } = {}) {
  if (!files.length) return;
  try {
    const layers = [];
    for (const f of files) {
      const r = await api(`/api/upload?kind=image&name=${encodeURIComponent(f.name || "pasted.png")}`, f, true);
      const w0 = r.width ?? 400;
      const h0 = r.height ?? 300;
      const k = Math.min(1, 720 / Math.max(w0, h0));
      const id = newId();
      layers.push({ id, type: "image", name: (f.name || "Image").replace(/\.[a-z0-9]+$/i, ""), parent: null, src: r.path, style: { width: `${Math.round(w0 * k)}px`, height: `${Math.round(h0 * k)}px`, objectFit: "cover", flexShrink: "0" } });
    }
    let point = at;
    if (!point) {
      const c = canvasEl.current.getBoundingClientRect();
      point = toWorld(c.left + c.width / 2, c.top + c.height / 2);
    }
    if (after && into) {
      const f = node(into);
      const nodes = Object.fromEntries(layers.map((l) => [l.id, { ...l, parent: into }]));
      commit([{ op: "add", nodes, ids: layers.map((l) => l.id), parent: into, index: (f.children ?? []).indexOf(after) + 1 }], { label: "Add image" });
      select(layers.map((l) => l.id));
    } else placeNew(layers, into ?? null, point, ev);
  } catch (e) {
    fail(e, "Couldn't add the picture");
  }
}

// =============================================================================================
// From a board to a design: an artboard drawn at 3× becomes the screen in a device frame, ready to
// be an App Store screenshot.

export async function artboardToDesign(ids = selectedArtboards()) {
  const roots = ids.filter((id) => node(id) && !node(id).parent).slice(0, 3);
  if (!roots.length) return toast({ kind: "info", title: "Pick an artboard first", timeout: 2400 });
  try {
    const r = await api("/api/board/export", { id: B.id, nodes: roots, scale: 3, format: "png" });
    const { addDevice, newScene } = await import("./actions.js");
    closeBoard({ toLibrary: false });
    await newScene();
    for (const f of r.files) await addDevice(f);
  } catch (e) {
    fail(e, "Couldn't make a design from it");
  }
}

// =============================================================================================
// Components

export function makeComponent() {
  const s = outermost();
  if (s.length !== 1) return toast({ kind: "info", title: "Pick one frame", text: "A component is made from one frame: wrap the layers in a frame first (⌥⌘G).", timeout: 4000 });
  const n = node(s[0]);
  if (n.type !== "frame") return toast({ kind: "info", title: "Only a frame can be a component", text: "Wrap it in a frame first (⌥⌘G).", timeout: 4000 });
  try {
    commit(componentOps(B.board, n.id), { label: "Make a component" });
  } catch (e) {
    toast({ kind: "info", title: "That can't be a component", text: e.message, timeout: 6000 });
  }
}

/** A copy of a component: into the selected frame, else beside the component (or in the view). */
export function placeCopy(main, { into } = {}) {
  const m = node(main);
  if (!m?.isComponent) return;
  const target = into !== undefined ? into : (() => {
    const s = sel();
    const one = s.length === 1 ? node(s[0]) : null;
    if (one && one.type === "frame" && one.id !== main && !ancestors(B.board, one.id).includes(main) && !instanceRootOf(B.board, one.id)) return one.id;
    return undefined;
  })();
  let parent;
  let index;
  if (target) parent = target;
  else if (m.parent && rootOf(B.board, main) && currentPage().children.includes(rootOf(B.board, main))) {
    parent = m.parent;
    index = siblingsOf(B.board, main).indexOf(main) + 1;
  } else parent = null;
  const t = instanceTree(B.board, main, parent);
  if (!parent) {
    const spot = m.parent ? (() => {
      const c = canvasEl.current.getBoundingClientRect();
      const p = toWorld(c.left + c.width / 2, c.top + c.height / 2);
      return { left: p.x, top: p.y };
    })() : freeSpot(B.board, currentPage().id, 0);
    Object.assign(t.nodes[t.id].style, { left: `${Math.round(spot.left)}px`, top: `${Math.round(spot.top)}px` });
  } else if (!isFlex(node(parent))) Object.assign(t.nodes[t.id].style, { position: "absolute", left: "16px", top: "16px" });
  if (commit([{ op: "add", nodes: t.nodes, ids: [t.id], parent, page: parent ? undefined : currentPage().id, index }], { label: "Copy of a component" }) !== false) select(t.id);
}

export function goToComponent(id) {
  const r = instanceRootOf(B.board, id);
  const main = r && node(node(r).instanceOf);
  if (!main) return;
  const page = B.board.pages.find((p) => p.children.includes(rootOf(B.board, main.id)));
  if (page && page.id !== B.page) bset({ page: page.id });
  select(main.id);
  requestAnimationFrame(() => fit([main.id]));
}

export const resetCopy = (id) => commit(resetOps(B.board, id), { label: "Reset" });
export const detachCopy = (id) => commit(detachOps(B.board, instanceRootOf(B.board, id) ?? id), { label: "Detach" });
export const stopComponent = (id) => commit(uncomponentOps(B.board, id), { label: "No longer a component" });
export const selectCopies = (main) => select(instancesOf(B.board, main));

/** Every component on the board, for the Components list. */
export function ComponentsList() {
  const b = useBoard();
  const mains = Object.values(b.board.nodes).filter((n) => n.isComponent);
  if (!mains.length) return null;
  return html`<section class="bd-comps">
    <div class="bd-head"><h3>Components</h3><span class="bd-count">${mains.length}</span></div>
    ${mains.map((m) => html`<div key=${m.id} class="bd-comp ${b.sel.includes(m.id) ? "on" : ""}" title="Click to select it, + to place a copy" onClick=${() => goToComponentMain(m.id)}>
        <${Icon} n="component" s=${13} />
        <span class="nm">${m.name}</span>
        <span class="n">${instancesOf(b.board, m.id).length || ""}</span>
        <button class="icon-btn sm" title="Place a copy (into the selected frame, or beside it)" onClick=${(e) => (e.stopPropagation(), placeCopy(m.id))}><${Icon} n="plus" s=${12} /></button>
      </div>`)}
  </section>`;
}

function goToComponentMain(id) {
  const page = B.board.pages.find((p) => p.children.includes(rootOf(B.board, id)));
  if (page && page.id !== B.page) bset({ page: page.id });
  select(id);
}

const hasOverrides = (id) => subtree(B.board, id).some((x) => node(x)?.overrides?.length);

// =============================================================================================
// The layer menu

export function openLayerMenu(x, y) {
  const s = sel();
  const one = s.length === 1 ? node(s[0]) : null;
  const frame = one?.type === "frame";
  const any = s.length > 0;
  openMenu(x, y, [
    any && { label: "Copy", icon: "copy", kbd: "⌘C", run: () => document.execCommand("copy") },
    { label: "Paste", icon: "paste", kbd: "⌘V", run: () => navigator.clipboard?.readText?.().then((t) => t && onPaste({ preventDefault() {}, clipboardData: { files: [], getData: (k) => (k === "text/plain" ? t : "") } })).catch(() => toast({ kind: "info", title: "Press ⌘V to paste", timeout: 2400 })) },
    any && { label: "Duplicate", icon: "duplicate", kbd: "⌘D", run: duplicateSelection },
    any && { label: "Copy as HTML", icon: "code", run: () => copyHtml(outermost()) },
    any && "-",
    one && { label: "Rename", icon: "text", kbd: "⌘R", run: () => bset({ renaming: one.id }) },
    any && { label: "Wrap in flex frame", icon: "flexCol", kbd: "⇧A", run: () => wrapSelection() },
    any && { label: "Wrap in frame", icon: "frame", kbd: "⌥⌘G", run: () => wrapSelection({ free: true }) },
    frame && one.children?.length && { label: "Ungroup", icon: "layers", kbd: "⇧⌘G", run: ungroupSelection },
    frame && (isFlex(one) ? { label: "Remove flex", icon: "freeLayout", kbd: "⌥⇧A", run: () => setFlex(one.id, false) } : { label: "Add flex", icon: "flexCol", kbd: "⇧A", run: () => setFlex(one.id, true) }),
    any && "-",
    frame && !one.isComponent && !instanceRootOf(B.board, one.id) && { label: "Make a component", icon: "component", kbd: "⌥⌘K", run: makeComponent },
    one?.isComponent && { label: "Place a copy", icon: "instance", run: () => placeCopy(one.id) },
    one?.isComponent && instancesOf(B.board, one.id).length > 0 && { label: `Select its ${instancesOf(B.board, one.id).length} cop${instancesOf(B.board, one.id).length === 1 ? "y" : "ies"}`, icon: "instance", run: () => selectCopies(one.id) },
    one && instanceRootOf(B.board, one.id) && { label: "Go to the component", icon: "component", run: () => goToComponent(one.id) },
    one && hasOverrides(one.id) && { label: "Reset to the component", icon: "refresh", run: () => resetCopy(one.id) },
    one && instanceRootOf(B.board, one.id) && { label: "Detach the copy", icon: "x", kbd: "⌥⌘B", run: () => detachCopy(one.id) },
    one?.isComponent && { label: "Stop being a component", icon: "x", run: () => stopComponent(one.id) },
    any && "-",
    any && { label: "Bring to front", icon: "front", kbd: "]", run: () => restack("front") },
    any && { label: "Send to back", icon: "back", kbd: "[", run: () => restack("back") },
    any && { label: s.every((id) => node(id).hidden) ? "Show" : "Hide", icon: "eye", kbd: "⇧⌘H", run: () => toggleAll("hidden") },
    any && { label: s.every((id) => node(id).locked) ? "Unlock" : "Lock", icon: "lock", kbd: "⇧⌘L", run: () => toggleAll("locked") },
    any && "-",
    any && { label: "Export…", icon: "export", run: () => document.querySelector(".bd-topbar .btn.primary")?.click() },
    any && { label: "Put in a device frame", icon: "phone", run: () => artboardToDesign() },
    any && { label: "Delete", icon: "trash", kbd: "⌫", danger: true, run: deleteSelection },
  ]);
}

// =============================================================================================
// Keys

const TOOL_KEYS = { v: "move", f: "frame", r: "rect", t: "text", h: "hand" };

function onKey(e) {
  if (!S.boardId || S.modal || S.menu) return;
  const m = e.metaKey || e.ctrlKey;
  const k = e.key.toLowerCase();
  if (typingNow()) return;
  const take = () => {
    e.preventDefault();
    e.stopPropagation();
  };
  if (m && !e.shiftKey && k === "z") return take(), undo();
  if (m && ((e.shiftKey && k === "z") || k === "y")) return take(), redo();
  if (m && k === "d") return take(), duplicateSelection();
  if (m && k === "a") return take(), selectAll();
  if (m && !e.shiftKey && k === "r") return take(), B.sel.length === 1 && bset({ renaming: B.sel[0] });
  if (m && e.altKey && (k === "k" || e.code === "KeyK")) return take(), makeComponent();
  if (m && e.altKey && (k === "b" || e.code === "KeyB")) return take(), B.sel.length === 1 && detachCopy(B.sel[0]);
  if (m && e.altKey && k === "g") return take(), wrapSelection({ free: true });
  if (m && e.shiftKey && k === "g") return take(), ungroupSelection();
  if (m && e.shiftKey && k === "h") return take(), toggleAll("hidden");
  if (m && e.shiftKey && k === "l") return take(), toggleAll("locked");
  if (m && e.shiftKey && k === "k") return take(), pickImages();
  if (m && e.altKey && k === "c") return take(), copyStyles();
  if (m && e.altKey && k === "v") return take(), pasteStyles();
  if (m && e.altKey && k === "s") return take(), bset({ leftOpen: !B.leftOpen });
  if (m && e.altKey && k === "i") return take(), bset({ rightOpen: !B.rightOpen });
  if (m && (k === "=" || k === "+")) return take(), zoomBy(1.25);
  if (m && k === "-") return take(), zoomBy(0.8);
  if (m && (k === "0" || e.code === "Digit0")) return take(), fit();
  if (m && k === "e") return take(), document.querySelector(".bd-topbar .btn.primary")?.click();
  if (m && k === "]") return take(), restack("forward");
  if (m && k === "[") return take(), restack("backward");
  if (m) return;
  // ⌥ and a letter lines layers up (as in Figma); ⌥⇧H and ⌥⇧V space them evenly.
  if (e.altKey && !e.shiftKey) {
    const edge = { KeyA: "left", KeyD: "right", KeyH: "hcenter", KeyW: "top", KeyS: "bottom", KeyV: "vcenter" }[e.code];
    if (edge) return take(), alignSelection(edge);
  }
  if (e.altKey && e.shiftKey && (e.code === "KeyH" || e.code === "KeyV")) return take(), distributeSelection(e.code === "KeyH" ? "x" : "y");
  if (e.shiftKey && e.code === "Digit0") return take(), zoomTo(1);
  if (e.shiftKey && e.code === "Digit1") return take(), fit();
  if (e.shiftKey && e.code === "Digit2") return take(), fit(B.sel);
  if (e.shiftKey && k === "a" && !e.altKey) {
    take();
    const one = B.sel.length === 1 ? node(B.sel[0]) : null;
    return one?.type === "frame" && !isFlex(one) ? setFlex(one.id, true) : wrapSelection();
  }
  if (e.shiftKey && e.altKey && (k === "a" || e.code === "KeyA")) return take(), B.sel.length === 1 && setFlex(B.sel[0], false);
  if (k === "]") return take(), restack("front");
  if (k === "[") return take(), restack("back");
  if (TOOL_KEYS[k] && !e.altKey) return take(), bset({ tool: TOOL_KEYS[k] });
  if (k === "backspace" || k === "delete") return take(), deleteSelection();
  if (k === "escape") return take(), selectParent();
  if (k === "enter") return take(), selectChildren();
  if (k === "tab") return take(), selectNextSibling(e.shiftKey);
  const step = e.shiftKey ? 10 : 1;
  if (k === "arrowleft") return take(), nudge(-step, 0);
  if (k === "arrowright") return take(), nudge(step, 0);
  if (k === "arrowup") return take(), nudge(0, -step);
  if (k === "arrowdown") return take(), nudge(0, step);
}

/** Commands from the app's menus, while a board is open. Returns false for the ones it leaves alone. */
export function boardCommand(name) {
  const run = {
    undo: () => (typingNow() ? document.execCommand("undo") : undo()),
    redo: () => (typingNow() ? document.execCommand("redo") : redo()),
    zoomIn: () => zoomBy(1.25),
    zoomOut: () => zoomBy(0.8),
    fit: () => fit(),
    actual: () => zoomTo(1),
    duplicate: duplicateSelection,
    delete: deleteSelection,
    exportImage: () => document.querySelector(".bd-topbar .btn.primary")?.click(),
    toggleLeft: () => bset({ leftOpen: !B.leftOpen }),
    toggleRight: () => bset({ rightOpen: !B.rightOpen }),
    save: () => toast({ kind: "ok", icon: "check", title: "Boards save themselves", text: "Every change is on disk as you make it.", timeout: 2400 }),
  }[name];
  if (run) {
    run();
    return true;
  }
  // The design editor's own commands mean nothing here.
  return ["preview", "showPreview", "render", "canvas", "animate", "timeline", "exportVideo", "focus", "ai", "import"].includes(name);
}

export { rootOf, selectedArtboards, parseHtml };
