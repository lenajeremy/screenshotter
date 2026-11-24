// The bar along the top of the window: Home, then a tab for each open board, as a design tool has.
import { useEffect, useRef } from "preact/hooks";
import { html } from "./controls.js";
import { Icon } from "./icons.js";
import { S, useStore } from "./store.js";
import { closeBoard, dropTab, newBoard, switchBoard } from "./board-state.js";

/** Go to a board from wherever you are. */
export async function switchToBoard(id) {
  if (S.boardId === id) return;
  await switchBoard(id);
}

export function closeTab(id) {
  if (S.boardId === id) closeBoard();
  dropTab(id);
}

/** `name`: the open board's name as it is now (it may have just been renamed). `right`: what sits at the far end. */
export function TabBar({ name, right }) {
  const s = useStore();
  const tabs = s.tabs ?? [];
  // With more tabs than fit, the strip scrolls sideways and keeps the open board's tab in sight.
  const strip = useRef();
  useEffect(() => {
    strip.current?.querySelector(".tab.on")?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [s.boardId, tabs.length]);
  return html`<header class="topbar tabbar" data-drag>
    <button class="icon-btn tab-home bd-back ${s.boardId ? "" : "on"}" data-nodrag title="All boards (⇧⌘O)" aria-pressed=${!s.boardId} onClick=${() => S.boardId && closeBoard()}><${Icon} n="home" s=${16} /></button>
    <div class="tabs" data-nodrag>
      <div class="tabs-strip" role="tablist" ref=${strip}>
      ${tabs.map((t) => {
        const on = t.id === s.boardId;
        return html`<div key=${t.id} class="tab ${on ? "on" : ""}" role="tab" aria-selected=${on} title=${on ? (name ?? t.name) : t.name} data-tab-board=${t.id}
            onClick=${() => switchToBoard(t.id)} onAuxClick=${(e) => e.button === 1 && closeTab(t.id)}>
          <i class="brand-mark"></i><span class="ellipsis">${on ? (name ?? t.name) : t.name}</span>
          <button class="tab-x" title="Close this tab" onClick=${(e) => (e.stopPropagation(), closeTab(t.id))}><${Icon} n="x" s=${11} w=${2} /></button>
        </div>`;
      })}
      </div>
      <button class="icon-btn tab-new" title="New board (⌘N)" onClick=${() => newBoard("Untitled board")}><${Icon} n="plus" s=${14} /></button>
    </div>
    <span class="spacer"></span>
    ${right}
  </header>`;
}
