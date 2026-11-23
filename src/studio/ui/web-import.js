// Bringing a website onto a board: the person gives its address, the engine opens it and reads it
// as it's drawn, and it lands as an artboard of ordinary layers to change (or have an agent change).
import { useEffect, useRef, useState } from "preact/hooks";
import { B } from "./board-state.js";
import { runImport } from "./imports.js";
import { Seg, Switch, html } from "./controls.js";
import { Icon } from "./icons.js";
import { fail, set, useStore } from "./store.js";

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
    setBusy({ fraction: 0.02, step: "Opening the page" });
    try {
      await runImport("website", { id: m.board ?? undefined, url: url.trim(), width, fullPage: whole, page: m.board && B.id === m.board ? B.page : undefined }, (p) => setBusy((b) => ({ fraction: p.fraction ?? b?.fraction ?? 0, step: p.step ?? b?.step })));
      set({ modal: null });
    } catch (e) {
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
        <label class="wi-url ${busy ? "off" : ""}">
          <${Icon} n="globe" s=${15} />
          <input ref=${field} autofocus class="wi-field" type="url" inputmode="url" placeholder="example.com" spellcheck=${false} autocomplete="off" value=${url} disabled=${Boolean(busy)} onInput=${(e) => setUrl(e.target.value)} onKeyDown=${onKey} aria-label="Website address" />
        </label>
        <div class="wi-opts">
          <div class="wi-opt"><div><b>Width</b><span>The size the page is read at</span></div><${Seg} value=${width} options=${WIDTHS} onChange=${(v) => !busy && setWidth(v)} /></div>
          <div class="wi-opt"><div><b>Whole page</b><span>Everything, not just the first screen</span></div><${Switch} checked=${whole} onChange=${(v) => !busy && setWhole(v)} /></div>
        </div>
        ${busy
          ? html`<div class="wi-progress" aria-live="polite">
              <div class="wi-bar"><i style=${{ width: `${Math.round(busy.fraction * 100)}%` }}></i></div>
              <span>${busy.step}…</span>
            </div>`
          : html`<p class="wi-fine">It comes in as layers you can change${m.board ? ", beside the artboards on this board" : ", on a board of its own"}. Only bring in sites you have the right to use.</p>`}
      </div>
      <div class="sheet-foot">
        <button class="btn" disabled=${Boolean(busy)} onClick=${() => set({ modal: null })}>Cancel</button>
        <button class="btn primary" disabled=${!url.trim() || Boolean(busy)} onClick=${go}>${busy ? html`<span class="spinner dark"></span>Importing` : "Import"}</button>
      </div>
    </div>
  </div>`;
}
