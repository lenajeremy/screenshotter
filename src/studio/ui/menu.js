// Right-click menus. The web view's own menu ("Reload", "Inspect Element") never shows: each part
// of the app gets the actions that make sense there. Text fields keep the system's text menu.
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { html } from "./controls.js";
import { Icon } from "./icons.js";
import { S, set, useStore } from "./store.js";

/**
 * Open a menu at the pointer. `items`: {label, icon, kbd, run, danger, disabled, hover} or "-" for a
 * divider; `hover(true/false)` is told when the item is pointed at (or picked with the arrow keys).
 */
export function openMenu(x, y, items) {
  const clean = items.filter(Boolean).filter((it, i, all) => it !== "-" || (i > 0 && i < all.length - 1 && all[i - 1] !== "-"));
  if (clean.length) set({ menu: { x, y, items: clean } });
}
export const closeMenu = () => S.menu && set({ menu: null });

export function ContextMenu() {
  const s = useStore();
  const m = s.menu;
  const ref = useRef();
  const [pos, setPos] = useState(null);
  const [active, setActive] = useState(-1);
  useLayoutEffect(() => {
    if (!m || !ref.current) return;
    // Keep it on screen: flip left/up when it would run off the edge, like macOS.
    const w = ref.current.offsetWidth;
    const h = ref.current.offsetHeight;
    const x = m.x + w > innerWidth - 8 ? Math.max(8, m.x - w) : m.x;
    const y = m.y + h > innerHeight - 8 ? Math.max(8, innerHeight - h - 8) : m.y;
    setPos({ x, y });
    setActive(-1);
  }, [m]);
  useEffect(() => {
    if (!m) return;
    const away = (e) => !ref.current?.contains(e.target) && closeMenu();
    const key = (e) => {
      const live = m.items.map((it, i) => (it !== "-" && !it.disabled ? i : -1)).filter((i) => i >= 0);
      if (e.key === "Escape") closeMenu();
      else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        const at = live.indexOf(active);
        const next = e.key === "ArrowDown" ? live[(at + 1) % live.length] : live[(at - 1 + live.length) % live.length];
        setActive(next ?? live[0]);
      } else if (e.key === "Enter" && active >= 0) {
        run(m.items[active]);
      } else return;
      e.preventDefault();
      e.stopPropagation();
    };
    addEventListener("pointerdown", away, true);
    addEventListener("keydown", key, true);
    addEventListener("blur", closeMenu);
    addEventListener("resize", closeMenu);
    addEventListener("wheel", closeMenu, { passive: true });
    return () => {
      removeEventListener("pointerdown", away, true);
      removeEventListener("keydown", key, true);
      removeEventListener("blur", closeMenu);
      removeEventListener("resize", closeMenu);
      removeEventListener("wheel", closeMenu);
    };
  }, [m, active]);
  // What a pointed-at item is about shows while it's pointed at (a layer outlined on the canvas, say).
  useEffect(() => {
    const it = m && active >= 0 ? m.items[active] : null;
    if (!it || it === "-" || !it.hover) return;
    it.hover(true);
    return () => it.hover(false);
  }, [m, active]);
  if (!m) return null;
  const run = (it) => {
    if (!it || it === "-" || it.disabled) return;
    closeMenu();
    it.run?.();
  };
  return html`<div class="ctx-menu" ref=${ref} role="menu" style=${{ left: (pos?.x ?? -9999) + "px", top: (pos?.y ?? -9999) + "px" }}
      onContextMenu=${(e) => e.preventDefault()}>
    ${m.items.map((it, i) =>
      it === "-"
        ? html`<div class="ctx-sep" role="separator"></div>`
        : html`<button role="menuitem" class="ctx-item ${it.danger ? "danger" : ""} ${it.ai ? "ai" : ""} ${i === active ? "active" : ""}" disabled=${it.disabled}
            onMouseEnter=${() => setActive(i)} onMouseLeave=${() => setActive(-1)} onClick=${() => run(it)}>
            <span class="ctx-ico">${it.icon && html`<${Icon} n=${it.icon} s=${14} />`}</span>
            <span class="ctx-label">${it.label}</span>
            ${it.kbd && html`<span class="ctx-kbd">${it.kbd}</span>`}
          </button>`,
    )}
  </div>`;
}
