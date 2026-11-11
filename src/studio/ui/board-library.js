// Boards in My designs: each with its first artboard as a thumbnail, and one being made by an
// agent marked as it happens.
import { useEffect, useState } from "preact/hooks";
import { html } from "./controls.js";
import { Icon } from "./icons.js";
import { openMenu } from "./menu.js";
import { api, fail, fileUrl, set, useStore } from "./store.js";
import { confirmDialog } from "./actions.js";
import { newBoard, openBoard } from "./board-state.js";
import { when } from "./scenes.js";

export async function refreshBoards() {
  const boards = await api("/api/boards").catch(() => null);
  if (boards) set({ boards });
  return boards;
}

export function useBoards() {
  const s = useStore();
  useEffect(() => {
    refreshBoards();
    // Agents make boards while the library is open; thumbnails are drawn a moment after a change.
    const t = setInterval(() => document.visibilityState === "visible" && refreshBoards(), 3000);
    return () => clearInterval(t);
  }, []);
  return s.boards ?? null;
}

const matches = (b, q) => !q.trim() || b.name.toLowerCase().includes(q.trim().toLowerCase());

export function BoardsGrid({ q }) {
  const boards = useBoards();
  const [renaming, setRenaming] = useState(null);
  if (!boards) return html`<div class="sp-empty"><span class="spinner"></span></div>`;
  if (!boards.length)
    return html`<div class="sp-empty big">
      <div class="art"><${Icon} n="frame" s=${24} /></div>
      <b>No boards yet</b>
      <span>A board is a canvas of artboards made of real HTML and CSS. Draw on it yourself, or have an agent design screens there while you watch.</span>
      <button class="btn primary sm" onClick=${() => newBoard("Untitled board")}><${Icon} n="plus" s=${13} w=${2.2} />New board</button>
    </div>`;
  const list = boards.filter((b) => matches(b, q));
  if (!list.length) return html`<div class="sp-empty"><${Icon} n="search" s=${22} /><b>No boards match “${q.trim()}”</b></div>`;
  return html`<div class="sp-grid">${list.map((b) => html`<${BoardCard} key=${b.id} b=${b} renaming=${renaming === b.id} onRename=${setRenaming} />`)}</div>`;
}

function BoardCard({ b, renaming, onRename }) {
  const artboards = b.pages.reduce((n, p) => n + p.artboards.length, 0);
  const [loaded, setLoaded] = useState(false);
  const more = (e) => {
    e.stopPropagation();
    const r = e.currentTarget.getBoundingClientRect();
    openMenu(r.left, r.bottom + 4, [
      { label: "Open", icon: "right", run: () => openBoard(b.id) },
      { label: "Rename", icon: "text", run: () => onRename(b.id) },
      { label: "Duplicate", icon: "duplicate", run: () => api("/api/board/duplicate", { id: b.id }).then(refreshBoards).catch((err) => fail(err, "Couldn't duplicate")) },
      "-",
      { label: "Delete", icon: "trash", danger: true, run: () => removeBoard(b) },
    ]);
  };
  return html`<div class="sp-card bd-card" data-board=${b.id} tabindex="0" role="button" aria-label=${b.name}
      onClick=${() => !renaming && openBoard(b.id)} onKeyDown=${(e) => e.key === "Enter" && openBoard(b.id)}
      onContextMenu=${(e) => (e.preventDefault(), more(e))}>
    <div class="sp-thumb">
      ${b.thumb ? html`<img class=${loaded ? "in" : ""} src=${fileUrl(b.thumb, Math.round(b.thumbAt ?? 0))} alt="" onLoad=${() => setLoaded(true)} />` : html`<span class="bd-thumb-empty"><${Icon} n="frame" s=${22} /></span>`}
      ${b.working.length > 0 && html`<span class="sp-badge"><i></i>Agent at work</span>`}
    </div>
    <div class="sp-info">
      <div class="sp-text">
        ${renaming
          ? html`<input class="input sm" value=${b.name} autoFocus onClick=${(e) => e.stopPropagation()}
              onKeyDown=${(e) => {
                e.stopPropagation();
                if (e.key === "Escape") onRename(null);
                if (e.key === "Enter") e.target.blur();
              }}
              onBlur=${(e) => renameBoard(b, e.target.value.trim()).then(() => onRename(null))} />`
          : html`<b title=${b.name}>${b.name}</b>`}
        <span class="sp-meta"><span>${artboards} artboard${artboards === 1 ? "" : "s"}</span><span>Edited ${when(b.updatedAt)}</span></span>
      </div>
      <button class="sp-more" title="More" onClick=${more}><${Icon} n="dots" s=${16} /></button>
    </div>
  </div>`;
}

async function renameBoard(b, name) {
  if (!name || name === b.name) return;
  try {
    await api("/api/board/ops", { id: b.id, ops: [{ op: "rename", name }] });
    await refreshBoards();
  } catch (e) {
    fail(e, "Couldn't rename");
  }
}

async function removeBoard(b) {
  const ok = await confirmDialog({ title: `Delete “${b.name}”?`, text: "The board and every artboard on it are removed. Images exported from it stay in the output folder.", confirm: "Delete", danger: true });
  if (!ok) return;
  try {
    await api("/api/board/delete", { id: b.id });
    await refreshBoards();
  } catch (e) {
    fail(e, "Couldn't delete");
  }
}
