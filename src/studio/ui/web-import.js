// Bringing a website onto a board: the person gives its address, the engine opens it and reads it
// as it's drawn, and it lands as an artboard of ordinary layers to change (or have an agent change).
import { useEffect, useRef, useState } from "preact/hooks";
import { B, openBoard, select } from "./board-state.js";
import { fit } from "./board-canvas.js";
import { Seg, Switch, html } from "./controls.js";
import { Icon } from "./icons.js";
import { S, api, fail, set, toast, useStore } from "./store.js";

const WIDTHS = [
  { value: 1440, label: "Desktop" },
  { value: 834, label: "Tablet" },
  { value: 390, label: "Phone" },
];

/** Ask for a website to bring in: onto this board (`board`), or onto a new one named after the site. */
export function openImportWebsite({ board = null, url = "" } = {}) {
  set({ modal: { kind: "importWebsite", board, url }, menu: null });
}

/** A web address on its own, as someone would paste one. */
export const looksLikeUrl = (text) => /^\s*(https?:\/\/)?([a-z0-9-]+\.)+[a-z]{2,}(:\d+)?(\/\S*)?\s*$/i.test(text ?? "") || /^\s*https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/\S*)?\s*$/i.test(text ?? "");

export function ImportWebsite() {
  const s = useStore();
  const m = s.modal;
  const [url, setUrl] = useState(m.url ?? "");
  const [width, setWidth] = useState(() => {
    try {
      return Number(localStorage.getItem("board:import-width")) || 1440;
    } catch {
      return 1440;
    }
  });
  const [whole, setWhole] = useState(true);
  const [busy, setBusy] = useState(null);
  const field = useRef();
  useEffect(() => field.current?.focus(), []);
  useEffect(() => {
    const key = (e) => {
      if (e.key === "Escape" && !busy) {
        e.stopPropagation();
        set({ modal: null });
      }
    };
    addEventListener("keydown", key, true);
    return () => removeEventListener("keydown", key, true);
  }, [busy]);

  const go = async () => {
    if (!url.trim() || busy) return;
    try {
      localStorage.setItem("board:import-width", String(width));
    } catch {}
    const job = Math.random().toString(36).slice(2, 12);
    setBusy({ fraction: 0.02, step: "Opening the page" });
    const poll = setInterval(async () => {
      try {
        const p = await api(`/api/progress?job=${job}`);
        if (p.fraction != null) setBusy((b) => (b ? { fraction: p.fraction, step: p.step ?? b.step } : b));
      } catch {}
    }, 400);
    try {
      const r = await api(`/api/board/import-website?job=${job}`, { id: m.board ?? undefined, url: url.trim(), width, fullPage: whole, page: m.board && B.id === m.board ? B.page : undefined });
      clearInterval(poll);
      set({ modal: null });
      // Opened (or opened again) with the new artboard on it, picked and in view.
      await openBoard(r.board);
      requestAnimationFrame(() => {
        select([r.artboard]);
        fit([r.artboard]);
      });
      toast({
        kind: r.warnings.length ? "warn" : "ok",
        icon: "globe",
        title: `Brought in ${r.name}`,
        text: [`${r.layers.toLocaleString()} layers`, r.pictures && `${r.pictures} pictures`, r.fonts && `${r.fonts} fonts`].filter(Boolean).join(" · ") + (r.warnings.length ? `. ${r.warnings[0]}` : ". Change it like any artboard, or ask an agent to."),
        timeout: 9000,
      });
    } catch (e) {
      clearInterval(poll);
      setBusy(null);
      fail(e, "Couldn't bring the website in");
    }
  };

  const onKey = (e) => {
    e.stopPropagation();
    if (e.key === "Enter") {
      e.preventDefault();
      go();
    }
  };

  return html`<div class="scrim" onPointerDown=${(e) => e.target === e.currentTarget && !busy && set({ modal: null })}>
    <div class="sheet web-import" role="dialog" aria-label="Import a website">
      <div class="sheet-head"><h2>Import a website</h2><button class="icon-btn" title="Close (Esc)" disabled=${Boolean(busy)} onClick=${() => set({ modal: null })}><${Icon} n="x" s=${16} /></button></div>
      <div class="sheet-body">
        <p class="note">It comes in as an artboard of layers you can change: its layout, words, pictures and fonts. ${m.board ? "It goes beside the artboards on this board." : "It gets a board of its own."}</p>
        <label class="wi-url ${busy ? "off" : ""}">
          <${Icon} n="globe" s=${15} />
          <input ref=${field} autofocus class="input grow" type="url" inputmode="url" placeholder="example.com" spellcheck=${false} autocomplete="off" value=${url} disabled=${Boolean(busy)} onInput=${(e) => setUrl(e.target.value)} onKeyDown=${onKey} aria-label="Website address" />
        </label>
        <div class="row"><label>Read it at</label><${Seg} value=${width} options=${WIDTHS} onChange=${(v) => !busy && setWidth(v)} /></div>
        <div class="row"><label></label><${Switch} checked=${whole} onChange=${(v) => !busy && setWhole(v)} label="The whole page, not just the first screen" /></div>
        ${busy
          ? html`<div class="wi-progress" aria-live="polite">
              <div class="wi-bar"><i style=${{ width: `${Math.round(busy.fraction * 100)}%` }}></i></div>
              <span>${busy.step}…</span>
            </div>`
          : html`<p class="note faint">Only bring in sites you have the right to use. Pages behind a sign-in come in as the browser sees them signed out.</p>`}
      </div>
      <div class="sheet-foot">
        <button class="btn" disabled=${Boolean(busy)} onClick=${() => set({ modal: null })}>Cancel</button>
        <button class="btn primary" disabled=${!url.trim() || Boolean(busy)} onClick=${go}>${busy ? html`<span class="spinner dark"></span>Importing` : "Import"}</button>
      </div>
    </div>
  </div>`;
}
