// The app: Home (getting started, then your boards) and the board you're working on, with the
// sheets, menus and toasts over them. Everything about a board itself is in board*.js.
import { render } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { Popover, Seg, html } from "./controls.js";
import { Icon } from "./icons.js";
import { ContextMenu } from "./menu.js";
import { BoardApp, boardCommand, importToBoard, pickImages } from "./board.js";
import { bset, closeBoard, newBoard, openBoard, saved as boardSaved } from "./board-state.js";
import { BoardsGrid, refreshBoards, useBoards } from "./board-library.js";
import { ImportWebsite, looksLikeUrl, openImportWebsite } from "./web-import.js";
import { ConnectAgent, FigmaMark, ImportFigma, looksLikeFigma, openImportFigma, saveFigmaToken } from "./imports.js";
import { AgentLogo } from "./agent-logos.js";
import { loadAgents } from "./board-agent.js";
import { S, answerConfirm, answerPrompt, api, dismiss, fail, native, restore, set, setTheme, themeNow, toast, touch, useStore } from "./store.js";

const shortPath = (p) => (p ?? "").replace(/^\/Users\/[^/]+/, "~");
const realBoards = (boards) => (boards ?? []).filter((b) => b.id !== "scratchpad");

// =============================================================================================
// Home: your boards, like a design tool's file browser

function Home() {
  const boards = useBoards();
  const [q, setQ] = useState("");
  const first = boards !== null && !realBoards(boards).length;
  return html`<div class="home">
    <aside class="home-side">
      <div class="home-drag" data-drag></div>
      <div class="home-brand"><div class="brand-mark"></div><span>Screenshotter</span></div>
      <label class="home-search"><${Icon} n="search" s=${13} /><input placeholder="Search boards" value=${q} spellcheck=${false} onInput=${(e) => setQ(e.target.value)} onKeyDown=${(e) => e.stopPropagation()} aria-label="Search boards" /></label>
      <nav class="home-nav">
        <button class="on"><${Icon} n="history" s=${15} />Recents</button>
        <button onClick=${() => openBoard("scratchpad")}><${Icon} n="pen" s=${15} />Scratchpad</button>
      </nav>
      <p class="home-sec">Agents</p>
      <${AgentsList} />
      <span class="grow"></span>
      <nav class="home-nav"><button onClick=${() => set({ modal: { kind: "settings" } })}><${Icon} n="settings" s=${15} />Settings</button></nav>
    </aside>
    <main class="home-main">
      <header class="home-head" data-drag>
        <h1>${first ? "Start a board" : q.trim() ? "Search" : "Recents"}</h1>
        <span class="spacer"></span>
        <${ImportButton} />
        <button class="btn primary sm" onClick=${() => newBoard("Untitled board")}><${Icon} n="plus" s=${13} w=${2.4} />New board</button>
      </header>
      <div class="home-scroll">${boards === null ? html`<div class="sp-empty"><span class="spinner"></span></div>` : first ? html`<${StartTiles} />` : html`<${BoardsGrid} q=${q} />`}</div>
    </main>
  </div>`;
}

/** The agents on this Mac, each one ready to chat on a board. */
function AgentsList() {
  const [agents, setAgents] = useState(null);
  useEffect(() => {
    loadAgents().then(setAgents);
  }, []);
  if (!agents) return null;
  if (!agents.length) return html`<nav class="home-nav"><button onClick=${() => set({ modal: { kind: "settings", tab: "agents" } })}><${Icon} n="plus" s=${15} />Add an agent</button></nav>`;
  return html`<div class="home-agents">${agents.map((a) => html`<span title=${`${a.label} is on this Mac: chat with it on any board, in the Agent tab`}><${AgentLogo} id=${a.id} s=${14} />${a.label}<i></i></span>`)}</div>`;
}

function ImportButton() {
  const [open, setOpen] = useState(false);
  const btn = useRef();
  const pick = (run) => (setOpen(false), run());
  return html`<button class="btn sm" ref=${btn} onClick=${() => setOpen(!open)}>Import<${Icon} n="down" s=${11} w=${2.2} /></button>
    ${open &&
    html`<${Popover} anchor=${btn.current} onClose=${() => setOpen(false)} width=${220} align="end">
      <div class="bd-menu">
        <button class="ctx-item" onClick=${() => pick(() => openImportWebsite())}><span class="ctx-ico"><${Icon} n="globe" s=${14} /></span><span class="ctx-label">A website…</span></button>
        <button class="ctx-item" onClick=${() => pick(() => openImportFigma())}><span class="ctx-ico"><${FigmaMark} s=${13} /></span><span class="ctx-label">A Figma file…</span></button>
        <button class="ctx-item" onClick=${() => pick(() => commands.import())}><span class="ctx-ico"><${Icon} n="image" s=${14} /></span><span class="ctx-label">Images…</span></button>
      </div>
    <//>`}`;
}

/** Before anything's been made: the three ways to start, as boards would be. */
function StartTiles() {
  const tiles = [
    { art: html`<${Icon} n="plus" s=${26} w=${1.6} />`, title: "Blank board", text: "Draw, or ask an agent to", run: () => (touch("started"), newBoard("Untitled board")) },
    { art: html`<${Icon} n="globe" s=${26} w=${1.5} />`, title: "Import a website", text: "A page as layers to change", run: () => openImportWebsite() },
    { art: html`<${FigmaMark} s=${26} />`, title: "Import from Figma", text: "A file, or one frame", run: () => openImportFigma() },
  ];
  return html`<div class="sp-grid home-starts">${tiles.map(
    (t) => html`<button class="sp-card start-tile" onClick=${t.run}>
      <div class="sp-thumb"><span class="start-art">${t.art}</span></div>
      <div class="sp-info"><div class="sp-text"><b>${t.title}</b><span class="sp-meta"><span>${t.text}</span></span></div></div>
    </button>`,
  )}</div>`;
}

// =============================================================================================
// Sheets

function useEscape(close) {
  useEffect(() => {
    const key = (e) => e.key === "Escape" && (e.preventDefault(), close());
    addEventListener("keydown", key);
    return () => removeEventListener("keydown", key);
  }, []);
}

function Sheet({ title, children, width, foot }) {
  useEscape(() => set({ modal: null }));
  return html`<div class="scrim" onPointerDown=${(e) => e.target === e.currentTarget && set({ modal: null })}>
    <div class="sheet" style=${width ? { width: `${width}px` } : null} role="dialog" aria-label=${title}>
      <div class="sheet-head"><h2>${title}</h2><button class="icon-btn" title="Close (Esc)" onClick=${() => set({ modal: null })}><${Icon} n="x" s=${16} /></button></div>
      <div class="sheet-body">${children}</div>
      ${foot && html`<div class="sheet-foot">${foot}</div>`}
    </div>
  </div>`;
}

/** A key kept in the Keychain (in the Mac app), with Save and Remove. */
function KeyRow({ label, placeholder, saved, onSave }) {
  const [v, setV] = useState("");
  const [busy, setBusy] = useState(false);
  const save = async (value) => {
    setBusy(true);
    try {
      await onSave(value);
      setV("");
    } catch (e) {
      fail(e, "Couldn't save it");
    } finally {
      setBusy(false);
    }
  };
  return html`<div class="row"><label>${label}</label><div class="hstack">
    <input class="input grow mono" type="password" placeholder=${saved ? "•••••••••• saved" : placeholder} value=${v} onInput=${(e) => setV(e.target.value)} onKeyDown=${(e) => e.stopPropagation()} />
    <button class="btn" disabled=${!v.trim() || busy} onClick=${() => save(v.trim())}>Save</button>
    ${saved && html`<button class="btn ghost" disabled=${busy} onClick=${() => save("")}>Remove</button>`}
  </div></div>`;
}

function Settings() {
  const s = useStore();
  const [info, setInfo] = useState(null);
  const [figma, setFigma] = useState(null);
  const [tab, setTab] = useState(s.modal?.tab ?? "general");
  const load = () => {
    (native ? native.call("getSettings") : Promise.resolve({})).then(setInfo).catch(() => setInfo({}));
    api("/api/figma").then((r) => setFigma(r.hasToken)).catch(() => setFigma(false));
  };
  useEffect(load, []);
  const TABS = [
    { value: "general", label: "General" },
    { value: "agents", label: "Agents" },
    { value: "keys", label: "Figma & photos" },
    { value: "shortcuts", label: "Shortcuts" },
  ];
  return html`<${Sheet} title="Settings">
    <div class="settings-tabs"><${Seg} value=${tab} options=${TABS} onChange=${setTab} /></div>
    ${tab === "general" &&
    html`<div class="card">
        <h4><${Icon} n=${themeNow() === "light" ? "sun" : "moon"} s=${15} />Appearance</h4>
        <div class="row"><label>Theme</label><${Seg} value=${s.theme ?? "system"} options=${[{ value: "system", label: "System" }, { value: "light", label: "Light" }, { value: "dark", label: "Dark" }]} onChange=${setTheme} /></div>
      </div>
      <div class="card">
        <h4><${Icon} n="folder" s=${15} />Library</h4>
        <div class="hstack"><span class="mono grow ellipsis" style=${{ color: "var(--text-2)" }}>${shortPath(s.opts?.outputRoot)}</span>
          <button class="btn sm" onClick=${() => api("/api/reveal", { path: s.opts.outputRoot }).catch((e) => fail(e))}>Show</button>
          ${native &&
          html`<button class="btn sm" onClick=${async () => {
            try {
              const r = await native.call("chooseOutputFolder");
              if (r?.path) toast({ kind: "ok", title: "Library moved", text: `${shortPath(r.path)} · restarting…` });
            } catch (e) {
              fail(e);
            }
          }}>Change…</button>`}
        </div>
        <div class="note">Your boards, their pictures and your exports live here, as files.</div>
      </div>
      ${info?.version && html`<div class="note" style=${{ textAlign: "center" }}>Screenshotter ${info.version} · engine on ${location.host}${info.node ? ` · Node ${info.node}` : ""}</div>`}`}
    ${tab === "agents" &&
    html`<div class="card"><h4><${Icon} n="code" s=${15} />From your own terminal</h4>
        <div class="note">Agents on this Mac chat with you in each board's Agent tab. To use Screenshotter from an agent you run yourself, add it to that agent once:</div>
        <${ConnectAgent} />
      </div>`}
    ${tab === "keys" &&
    html`<div class="card">
        <h4><${FigmaMark} s=${14} />Figma</h4>
        <div class="note">Importing from Figma needs a personal access token: in Figma, Settings › Security › Personal access tokens › Generate, with read access to files.</div>
        <${KeyRow} label="Token" placeholder="figd_…" saved=${figma} onSave=${async (v) => {
          await saveFigmaToken(v);
          setFigma(Boolean(v));
          toast({ kind: "ok", title: v ? "Figma token saved" : "Figma token removed" });
        }} />
      </div>
      <div class="card">
        <h4><${Icon} n="image" s=${15} />Unsplash photos</h4>
        <div class="note">Agents can put real photos in with <code>unsplash:</code>. It needs a free access key from <a href="https://unsplash.com/developers" target="_blank">unsplash.com/developers</a>. ${info?.hasUnsplashKey || s.opts?.unsplashKey ? "A key is set." : ""}</div>
        ${native
          ? html`<${KeyRow} label="Access key" placeholder="Unsplash access key" saved=${info?.hasUnsplashKey} onSave=${async (v) => {
              await native.call("setUnsplashKey", { key: v });
              toast({ kind: "ok", title: v ? "Unsplash key saved" : "Unsplash key removed", text: "Restarting the engine…" });
              load();
            }} />`
          : html`<div class="note">In the browser, the key comes from <code>UNSPLASH_ACCESS_KEY</code>.</div>`}
      </div>`}
    ${tab === "shortcuts" &&
    html`<div class="card"><div class="shortcuts">
      ${[
        ["Move, frame, text, rectangle", "V  F  T  R"],
        ["Pan", "Space-drag or scroll"],
        ["Zoom in / out / fit", "⌘+ / ⌘− / ⇧1"],
        ["Zoom to selection", "⇧2"],
        ["Undo / redo", "⌘Z / ⇧⌘Z"],
        ["Duplicate / delete", "⌘D / ⌫"],
        ["Group / frame selection", "⌘G / ⌥⌘G"],
        ["Nudge (×10 with ⇧)", "← ↑ → ↓"],
        ["Comment", "C"],
        ["Hide the panels", "⌘\\"],
        ["New board", "⌘N"],
        ["All boards", "⇧⌘O"],
      ].map(([a, b]) => html`<span>${a}</span><span class="kbd">${b}</span>`)}
    </div></div>`}
  <//>`;
}

function Confirm() {
  const m = S.modal;
  useEffect(() => {
    const key = (e) => {
      if (e.key === "Enter") answerConfirm(true);
      if (e.key === "Escape") answerConfirm(false);
      e.stopPropagation();
    };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  }, []);
  return html`<div class="scrim" onPointerDown=${(e) => e.target === e.currentTarget && answerConfirm(false)}>
    <div class="sheet" style=${{ width: "400px" }}>
      <div class="sheet-head"><h2>${m.title}</h2></div>
      <div class="sheet-body"><div class="note" style=${{ fontSize: "13px" }}>${m.text}</div></div>
      <div class="sheet-foot"><button class="btn" onClick=${() => answerConfirm(false)}>${m.cancel ?? "Cancel"}</button>
        <button class="btn ${m.danger ? "" : "primary"}" style=${m.danger ? { background: "var(--danger-strong)", color: "#fff" } : null} autoFocus onClick=${() => answerConfirm(true)}>${m.confirm ?? "OK"}</button></div>
    </div>
  </div>`;
}

function Prompt() {
  const m = S.modal;
  const [v, setV] = useState(m.value ?? "");
  return html`<div class="scrim" onPointerDown=${(e) => e.target === e.currentTarget && answerPrompt(null)}>
    <div class="sheet" style=${{ width: "400px" }}>
      <div class="sheet-head"><h2>${m.title}</h2></div>
      <div class="sheet-body"><input class="input" autoFocus value=${v} spellcheck=${false} onFocus=${(e) => e.target.select()} onInput=${(e) => setV(e.target.value)}
        onKeyDown=${(e) => {
          e.stopPropagation();
          if (e.key === "Enter") answerPrompt(v);
          if (e.key === "Escape") answerPrompt(null);
        }} /></div>
      <div class="sheet-foot"><button class="btn" onClick=${() => answerPrompt(null)}>Cancel</button><button class="btn primary" disabled=${!v.trim()} onClick=${() => answerPrompt(v)}>${m.confirm ?? "OK"}</button></div>
    </div>
  </div>`;
}

function Toasts() {
  const s = useStore();
  const icons = { ok: "check", err: "alert", warn: "alert" };
  return html`<div class="toasts">${s.toasts.slice(-2).map(
    (t) => html`<div class="toast ${t.kind} ${t.leaving ? "leaving" : ""}" key=${t.id}>
      <span class="ti"><${Icon} n=${t.icon ?? icons[t.kind] ?? "info"} s=${13} w=${2.2} /></span>
      <div class="tb"><b>${t.title}</b>${t.text && html`<span class="d">${t.text}</span>`}
        ${t.actions?.length > 0 && html`<div class="ta">${t.actions.map((a) => html`<button class="btn sm" onClick=${() => (a.run(), dismiss(t.id))}>${a.label}</button>`)}</div>`}
      </div>
      <button class="icon-btn sm x" onClick=${() => dismiss(t.id)}><${Icon} n="x" s=${12} /></button>
    </div>`,
  )}</div>`;
}

const MODALS = { settings: Settings, confirm: Confirm, prompt: Prompt, importWebsite: ImportWebsite, importFigma: ImportFigma };

// =============================================================================================
// Root

function App() {
  const s = useStore();
  if (s.bootError)
    return html`<div class="boot"><b>The engine didn't start</b><span>${s.bootError}</span>${native && html`<button class="btn" onClick=${() => native.call("restartEngine")}>Restart the engine</button>`}</div>`;
  if (!s.ready) return html`<div class="boot"><div class="boot-mark"></div></div>`;
  const Modal = s.modal && MODALS[s.modal.kind];
  return html`${s.boardId ? html`<${BoardApp} key=${s.boardId} />` : html`<${Home} />`}
    ${Modal && html`<${Modal} key=${s.modal.kind} />`}
    ${s.dropping && !s.boardId && html`<div class="drop-veil"><div><${Icon} n="upload" s=${22} /><b>Drop to start a board with these</b></div></div>`}
    <${ContextMenu} />
    <${Toasts} />`;
}

/** Wait for a board just opened to be on screen. */
const drawn = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

/** Pictures and videos onto a new board (from Home). */
async function startBoardWith(items) {
  if (!items?.length) return;
  touch("started");
  await newBoard("Untitled board");
  await drawn();
  importToBoard(items);
}

async function uploadFiles(files) {
  const items = [];
  for (const f of files) {
    const video = /^video\//.test(f.type) || /\.(mp4|mov|m4v|webm)$/i.test(f.name);
    if (!video && !/^image\//.test(f.type) && !/\.(png|jpe?g|webp|gif|svg|heic|avif)$/i.test(f.name)) continue;
    try {
      items.push(await api(`/api/upload?kind=${video ? "video" : "image"}&name=${encodeURIComponent(f.name || "pasted.png")}`, f, true));
    } catch (e) {
      fail(e, `Couldn't add ${f.name}`);
    }
  }
  return items;
}

const typing = () => {
  const el = document.activeElement;
  return Boolean(el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable));
};

const commands = {
  newBoard: () => newBoard("Untitled board"),
  boards: () => S.boardId && closeBoard(),
  // The open board's Agent tab, or Settings › Agents from Home.
  connect: () => (S.boardId ? bset({ rightOpen: true, rightTab: "agent" }) : set({ modal: { kind: "settings", tab: "agents" } })),
  settings: () => set({ modal: { kind: "settings" } }),
  help: () => set({ modal: { kind: "settings", tab: "agents" } }),
  importWebsite: () => openImportWebsite({ board: S.boardId }),
  importFigma: () => openImportFigma({ board: S.boardId }),
  import: async () => {
    if (!S.boardId) {
      await newBoard("Untitled board");
      await drawn();
    }
    pickImages();
  },
  undo: () => typing() && document.execCommand("undo"),
  redo: () => typing() && document.execCommand("redo"),
  refresh: () => refreshBoards(),
  // Files the Mac app brought in (pasted, opened from Finder, dropped on the Dock icon).
  imported: async (items) => {
    await booted;
    if (S.boardId) return importToBoard(items);
    return startBoardWith(items);
  },
  // Before the app quits: the open board's last changes.
  flush: () => boardSaved(),
  error: (message) => toast({ kind: "err", title: "Something went wrong", text: message }),
};
window.studio = { command: (name, arg) => (S.boardId && boardCommand(name, arg) ? undefined : commands[name]?.(arg)), isTyping: () => typing(), state: S };

// Home's own keys (a board has its own).
window.addEventListener("keydown", (e) => {
  if (S.boardId || S.modal || typing()) return;
  const mod = e.metaKey || e.ctrlKey;
  if (mod && e.key === ",") {
    e.preventDefault();
    commands.settings();
  }
});

// A website or Figma link pasted on Home goes straight in; pictures start a board.
window.addEventListener("paste", (e) => {
  if (S.boardId || S.modal || typing()) return;
  const text = e.clipboardData?.getData("text/plain")?.trim();
  if (text && looksLikeFigma(text)) return (e.preventDefault(), openImportFigma({ url: text }));
  if (text && looksLikeUrl(text)) return (e.preventDefault(), openImportWebsite({ url: text }));
  if (native) return;
  const files = [...(e.clipboardData?.files ?? [])];
  if (!files.length) return;
  e.preventDefault();
  uploadFiles(files).then(startBoardWith);
});

// Files dropped on Home start a board with them (a board takes drops on its canvas itself).
let dragDepth = 0;
const hasFiles = (e) => [...(e.dataTransfer?.types ?? [])].includes("Files");
window.addEventListener("dragenter", (e) => {
  if (S.boardId || !hasFiles(e)) return;
  dragDepth++;
  if (!S.dropping) set({ dropping: true });
});
window.addEventListener("dragleave", (e) => {
  if (S.boardId || !hasFiles(e)) return;
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) set({ dropping: false });
});
window.addEventListener("dragover", (e) => !S.boardId && hasFiles(e) && e.preventDefault());
window.addEventListener("drop", (e) => {
  if (S.boardId || !hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  set({ dropping: false });
  uploadFiles([...e.dataTransfer.files]).then(startBoardWith);
});

// The draggable title-bar area, for the Mac app's window.
function reportDragRegions() {
  if (!native) return;
  const bars = [...document.querySelectorAll("[data-drag]")].filter((el) => el.offsetParent || el === document.body);
  if (!bars.length) return;
  const rect = (el) => {
    const b = el.getBoundingClientRect();
    return [b.left, b.top, b.width, b.height];
  };
  const holes = bars.flatMap((bar) => [...bar.querySelectorAll("[data-nodrag], button, input")].map(rect));
  native.call("dragRegions", { regions: bars.map(rect), holes }).catch(() => undefined);
}
let dragTimer = 0;
new MutationObserver(() => {
  clearTimeout(dragTimer);
  dragTimer = setTimeout(reportDragRegions, 120);
}).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["class"] });
window.addEventListener("resize", () => {
  clearTimeout(dragTimer);
  dragTimer = setTimeout(reportDragRegions, 60);
});

// =============================================================================================
// Boot

let bootDone;
const booted = new Promise((r) => (bootDone = r));

async function boot() {
  render(html`<${App} />`, document.getElementById("root"));
  try {
    const [opts] = await Promise.all([api("/api/options"), restore()]);
    set({ opts });
    await refreshBoards();
    // The board that was open last time opens again.
    let last = null;
    try {
      last = localStorage.getItem("board:last");
    } catch {}
    if (last && (S.boards ?? []).some((b) => b.id === last)) await openBoard(last);
    set({ ready: true });
    bootDone();
    setTimeout(reportDragRegions, 300);
  } catch (e) {
    set({ bootError: e.message });
  }
}
boot();
