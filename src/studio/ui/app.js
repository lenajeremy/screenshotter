// The app: Home (getting started, then your boards) and the board you're working on, with the
// sheets, menus and toasts over them. Everything about a board itself is in board*.js.
import { render } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { Dropdown, Popover, Seg, html } from "./controls.js";
import { Icon } from "./icons.js";
import { ContextMenu } from "./menu.js";
import { BoardApp, boardCommand, importToBoard, pickImages } from "./board.js";
import { bset, closeBoard, newBoard, openBoard, restoreTabs, saved as boardSaved } from "./board-state.js";
import { TabBar } from "./tabs.js";
import { Gate, onboarded } from "./gate.js";
import { UpgradeModal } from "./plans.js";
import { BoardsGrid, refreshBoards, useBoards } from "./board-library.js";
import { ImportWebsite, looksLikeUrl, openImportWebsite } from "./web-import.js";
import { ConnectAgent, FigmaMark, ImportFigma, importFigFile, isFigFile, isFigmaClipboard, looksLikeFigma, openImportFigma, pasteFigma, saveFigmaToken } from "./imports.js";
import { CreateTeamModal, MoveToTeamModal, SignInModal, TeamBoardsGrid, TeamMembersModal, newTeamBoard, refreshAccount, signOutAccount } from "./cloud.js";
import { S, answerConfirm, answerPrompt, api, dismiss, fail, native, restore, set, setTheme, themeNow, toast, touch, useStore } from "./store.js";

const shortPath = (p) => (p ?? "").replace(/^\/Users\/[^/]+/, "~");
const realBoards = (boards) => (boards ?? []).filter((b) => b.id !== "scratchpad" && !b.teamId);

// =============================================================================================
// Home: your boards, like a design tool's file browser

function Home() {
  const s = useStore();
  const boards = useBoards();
  const [q, setQ] = useState("");
  const [sort, setSort] = useState("edited");
  const [tab, setTab] = useState("recent");
  const [view, setView] = useState(() => {
    try {
      return localStorage.getItem("home:view") === "list" ? "list" : "grid";
    } catch {
      return "grid";
    }
  });
  const pickView = (v) => {
    setView(v);
    try {
      localStorage.setItem("home:view", v);
    } catch {}
  };
  const cloud = s.cloud ?? {};
  const activeTeam = s.homeView !== "recents" ? (cloud.teams ?? []).find((t) => t.id === s.homeView) : null;
  const first = !activeTeam && boards !== null && !realBoards(boards).length;
  return html`<div class="home">
    <${TabBar} />
    <aside class="home-side">
      ${cloud.signedIn && cloud.user
        ? html`<button class="home-account" title=${cloud.user.email} onClick=${() => set({ modal: { kind: "settings", tab: "account" } })}>
            ${cloud.user.image ? html`<img class="cloud-av sm" src=${cloud.user.image} alt="" />` : html`<span class="cloud-av sm">${(cloud.user.name || cloud.user.email)[0].toUpperCase()}</span>`}
            <b class="grow ellipsis">${cloud.user.name || cloud.user.email}</b>
            ${cloud.offline ? html`<span class="home-offline">Offline</span>` : html`<${Icon} n="down" s=${11} w=${2} />`}
          </button>`
        : html`<div class="home-brand"><div class="brand-mark"></div><span>${s.opts?.appName ?? "Glassine"}</span></div>`}
      <label class="home-search"><${Icon} n="search" s=${13} /><input placeholder="Search boards" value=${q} spellcheck=${false} onInput=${(e) => setQ(e.target.value)} onKeyDown=${(e) => e.stopPropagation()} aria-label="Search boards" /></label>
      <nav class="home-nav">
        <button class=${!activeTeam ? "on" : ""} onClick=${() => set({ homeView: "recents" })}><${Icon} n="history" s=${15} />Recents</button>
        <button onClick=${() => openBoard("scratchpad")}><${Icon} n="pen" s=${15} />Scratchpad</button>
      </nav>
      <div class="home-rule"></div>
      <div class="home-sec-row">
        <p class="home-sec">Teams</p>
        ${cloud.signedIn && html`<button class="icon-btn xs" title="New team" onClick=${() => set({ modal: { kind: "upgrade" } })}><${Icon} n="plus" s=${13} /></button>`}
      </div>
      <nav class="home-nav home-teams">
        ${cloud.signedIn
          ? cloud.teams.length
            ? cloud.teams.map(
                (t) => html`<button key=${t.id} class=${activeTeam?.id === t.id ? "on" : ""} onClick=${() => set({ homeView: t.id })}>
                  <i class="team-mark" style=${{ background: teamColor(t.id) }}>${(t.name || "?")[0].toUpperCase()}</i><span class="grow ellipsis">${t.name}</span>
                </button>`,
              )
            : html`<button onClick=${() => set({ modal: { kind: "upgrade" } })}><${Icon} n="plus" s=${15} />Create a team</button>`
          : html`<button onClick=${() => set({ modal: { kind: "signIn" } })}><${Icon} n="users" s=${15} />Sign in to collaborate</button>`}
      </nav>
      <span class="grow"></span>
      <nav class="home-nav">
        ${!cloud.signedIn && html`<button onClick=${() => set({ modal: { kind: "signIn" } })}><${Icon} n="user" s=${15} />Sign in</button>`}
        <button onClick=${() => set({ modal: { kind: "settings" } })}><${Icon} n="settings" s=${15} />Settings</button>
      </nav>
    </aside>
    <main class="home-main">
      <header class="home-head" data-drag>
        <h1>${activeTeam ? activeTeam.name : first ? "Start a board" : q.trim() ? "Search" : "Recents"}</h1>
        ${activeTeam && html`<span class="cloud-role">${activeTeam.role}</span>`}
        <span class="spacer"></span>
        ${activeTeam
          ? html`<button class="btn sm" onClick=${() => set({ modal: { kind: "teamMembers", teamId: activeTeam.id } })}><${Icon} n="users" s=${13} />Members</button>
              <button class="btn primary sm" onClick=${() => newTeamBoard(activeTeam)}><${Icon} n="plus" s=${13} w=${2.4} />New team board</button>`
          : html`<${ImportButton} />
              <button class="btn primary sm" onClick=${() => newBoard("Untitled board")}><${Icon} n="plus" s=${13} w=${2.4} />New board</button>`}
      </header>
      ${!first && boards !== null &&
      html`<div class="home-filters">
        ${!activeTeam && html`<div class="home-tabs" role="tablist">
          ${[["recent", "Recently edited"], ["shared", "Shared with you"]].map(([id, label]) => html`<button role="tab" data-home-tab=${id} aria-selected=${tab === id} class=${tab === id ? "on" : ""} onClick=${() => setTab(id)}>${label}</button>`)}
        </div>`}
        <span class="spacer"></span>
        ${!activeTeam && tab === "recent" && html`<${Dropdown} value=${sort} options=${[{ value: "edited", label: "Last edited" }, { value: "name", label: "Name" }]} onChange=${setSort} />`}
        <div class="home-view" role="group" aria-label="View">
          <button class=${view === "grid" ? "on" : ""} title="Grid" aria-pressed=${view === "grid"} onClick=${() => pickView("grid")}><${Icon} n="grid" s=${14} /></button>
          <button class=${view === "list" ? "on" : ""} title="List" aria-pressed=${view === "list"} onClick=${() => pickView("list")}><${Icon} n="list" s=${14} /></button>
        </div>
      </div>`}
      <div class="home-scroll ${view === "list" ? "as-list" : ""}">
        ${activeTeam
          ? html`<${TeamBoardsGrid} key=${activeTeam.id} team=${activeTeam} q=${q} />`
          : boards === null
            ? html`<div class="sp-empty"><span class="spinner"></span></div>`
            : first
              ? html`<${StartTiles} />`
              : tab === "shared"
                ? html`<${SharedBoards} q=${q} />`
                : html`<${BoardsGrid} q=${q} sort=${sort} />`}
      </div>
    </main>
  </div>`;
}

/** Every board your teams share, team by team. */
function SharedBoards({ q }) {
  const s = useStore();
  const cloud = s.cloud ?? {};
  if (!cloud.signedIn) return html`<div class="sp-empty big"><div class="art"><${Icon} n="users" s=${22} /></div><b>Nothing shared yet</b><span>Boards your teams share show up here once you sign in.</span><button class="btn primary sm" onClick=${() => set({ modal: { kind: "signIn" } })}>Sign in</button></div>`;
  if (!cloud.teams?.length) return html`<div class="sp-empty big"><div class="art"><${Icon} n="users" s=${22} /></div><b>Nothing shared yet</b><span>Start a team to share boards and edit them together, live.</span><button class="btn primary sm" onClick=${() => set({ modal: { kind: "upgrade" } })}>Create a team</button></div>`;
  return html`${cloud.teams.map((t) => html`<section class="home-team" key=${t.id}>
    <h2><i class="team-mark" style=${{ background: teamColor(t.id) }}>${(t.name || "?")[0].toUpperCase()}</i>${t.name}</h2>
    <${TeamBoardsGrid} team=${t} q=${q} />
  </section>`)}`;
}

/** A team's colour, the same every time: from its id. */
const TEAM_COLORS = ["#ff8a4c", "#7c9cff", "#4fd1a1", "#e879c6", "#f5c542", "#9b8cff"];
const teamColor = (id) => TEAM_COLORS[[...String(id)].reduce((n, c) => (n * 31 + c.charCodeAt(0)) >>> 0, 7) % TEAM_COLORS.length];

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

/** One setting: what it is on the left, its one control on the right. */
function SetRow({ label, hint, children, lead }) {
  return html`<div class="set-row">${lead}<div class="grow"><b>${label}</b>${hint && html`<span>${hint}</span>`}</div>${children}</div>`;
}

const SETTINGS_NAV = [
  { value: "account", label: "Account", icon: "user" },
  { value: "general", label: "Appearance", icon: "sun" },
  { value: "agents", label: "Agents", icon: "spark" },
  { value: "keys", label: "Connections", icon: "link" },
  { value: "shortcuts", label: "Shortcuts", icon: "sliders" },
  { value: "plan", label: "Plan", icon: "card" },
];

function Settings() {
  const s = useStore();
  const [info, setInfo] = useState(null);
  const [figma, setFigma] = useState(null);
  const [tab, setTab] = useState(s.modal?.tab ?? (s.cloud?.signedIn ? "account" : "general"));
  const [advanced, setAdvanced] = useState(false);
  const load = () => {
    (native ? native.call("getSettings") : Promise.resolve({})).then(setInfo).catch(() => setInfo({}));
    api("/api/figma").then((r) => setFigma(r.hasToken)).catch(() => setFigma(false));
  };
  useEffect(load, []);
  const close = () => set({ modal: null });
  useEscape(close);
  const [serverDraft, setServerDraft] = useState(s.cloud?.serverUrl || "");
  useEffect(() => {
    if (s.cloud?.serverUrl && !serverDraft) setServerDraft(s.cloud.serverUrl);
  }, [s.cloud?.serverUrl]);
  const user = s.cloud?.signedIn ? s.cloud.user : null;
  const teams = s.cloud?.teams ?? [];
  const saveName = async (e) => {
    const name = e.target.value.trim();
    if (!name || name === user?.name) return (e.target.value = user?.name ?? "");
    try {
      await api("/api/cloud/profile", { name });
      await refreshAccount();
      toast({ kind: "ok", title: "Name saved" });
    } catch (x) {
      e.target.value = user?.name ?? "";
      fail(x, "Couldn't save your name");
    }
  };
  const title = SETTINGS_NAV.find((t) => t.value === tab)?.label ?? "Settings";
  return html`<div class="scrim" onPointerDown=${(e) => e.target === e.currentTarget && close()}>
    <div class="sheet set-sheet" role="dialog" aria-label="Settings">
      <nav class="set-nav settings-tabs" role="tablist" aria-label="Settings">
        <p>Settings</p>
        ${SETTINGS_NAV.map((t) => html`<button role="tab" aria-selected=${tab === t.value} class=${tab === t.value ? "on" : ""} onClick=${() => setTab(t.value)}><${Icon} n=${t.icon} s=${15} />${t.label}${t.value === "plan" && html`<small>${teams.length ? "Team" : "Free"}</small>`}</button>`)}
        <span class="grow"></span>
        ${info?.version && html`<small class="set-version">${s.opts?.appName ?? "Glassine"} ${info.version}</small>`}
      </nav>
      <div class="set-main">
        <div class="set-head"><h2>${title}</h2><button class="icon-btn sm" title="Close (Esc)" onClick=${close}><${Icon} n="x" s=${15} /></button></div>
        <div class="set-body" key=${tab}>
          ${tab === "account" &&
          (user
            ? html`<section class="card set-sec"><h4>Profile</h4>
                  <${SetRow} label="Name" hint="Shown by your cursor and comments" lead=${user.image ? html`<img class="cloud-av" src=${user.image} alt="" />` : html`<span class="cloud-av">${(user.name || user.email)[0].toUpperCase()}</span>`}>
                    <input class="input set-input" defaultValue=${user.name ?? ""} spellcheck=${false} aria-label="Name" onBlur=${saveName} onKeyDown=${(e) => (e.stopPropagation(), e.key === "Enter" && e.target.blur())} />
                  <//>
                  <${SetRow} label="Email" hint=${user.email}><span class="set-value">${s.cloud.offline ? "Offline" : "Signed in"}</span><//>
                </section>
                <section class="card set-sec"><h4>Teams</h4>
                  ${teams.map((t) => html`<${SetRow} key=${t.id} label=${t.name} hint=${t.role === "owner" ? "Owner" : "Member"} lead=${html`<i class="gate-team sm">${(t.name || "?")[0].toUpperCase()}</i>`}>
                    <button class="btn sm" onClick=${() => set({ modal: { kind: "teamMembers", teamId: t.id } })}>Manage</button>
                  <//>`)}
                  <${SetRow} label=${teams.length ? "Start another team" : "Start a team"} hint="$16 a person each month, billed yearly"><button class="btn sm" onClick=${() => set({ modal: { kind: "upgrade" } })}>Create team</button><//>
                </section>
                <section class="card set-sec"><h4>Session</h4>
                  <${SetRow} label="Sign out of this Mac" hint="Your boards stay in your account"><button class="btn sm" onClick=${() => signOutAccount().then(close)}>Sign out</button><//>
                </section>`
            : html`<section class="card set-sec"><h4>Account</h4>
                  <${SetRow} label="You're not signed in" hint="Sign in to create teams, share boards and edit live with teammates"><button class="btn primary sm" onClick=${() => set({ modal: { kind: "signIn" } })}>Sign in</button><//>
                </section>`)}
          ${tab === "account" &&
          html`<button class="set-more" aria-expanded=${advanced} onClick=${() => setAdvanced(!advanced)}><${Icon} n=${advanced ? "down" : "right"} s=${12} w=${2} />Advanced</button>
            ${advanced &&
            html`<section class="card set-sec">
              <${SetRow} label="Server" hint="Accounts, teams and live editing connect here">
                <input class="input set-input mono" value=${serverDraft} placeholder="https://glassine.thesunset.live" spellcheck=${false} onInput=${(e) => setServerDraft(e.target.value)} onKeyDown=${(e) => e.stopPropagation()} />
                <button class="btn sm" disabled=${!serverDraft.trim() || serverDraft.trim() === s.cloud?.serverUrl} onClick=${async () => {
                  try {
                    await api("/api/cloud/server", { serverUrl: serverDraft.trim() });
                    await refreshAccount();
                    toast({ kind: "ok", title: "Server updated" });
                  } catch (e) {
                    fail(e, "Couldn't update server");
                  }
                }}>Save</button>
              <//>
            </section>`}`}
          ${tab === "general" &&
          html`<section class="card set-sec"><h4>Appearance</h4>
              <${SetRow} label="Theme" hint="System follows your Mac"><${Seg} value=${s.theme ?? "system"} options=${[{ value: "system", label: "System" }, { value: "light", label: "Light" }, { value: "dark", label: "Dark" }]} onChange=${setTheme} /><//>
            </section>
            <section class="card set-sec"><h4>Library</h4>
              <${SetRow} label="Where your boards live" hint=${shortPath(s.opts?.outputRoot)}>
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
              <//>
            </section>`}
          ${tab === "agents" &&
          html`<section class="card set-sec"><h4>From your own terminal</h4>
              <div class="note">Agents on this Mac chat with you on every board. To use ${s.opts?.appName ?? "Glassine"} from an agent you run yourself, add it to that agent once:</div>
              <${ConnectAgent} />
            </section>`}
          ${tab === "keys" &&
          html`<section class="card set-sec"><h4>Figma</h4>
              <div class="note">Importing from a Figma link needs a personal access token: in Figma, Settings › Security › Personal access tokens › Generate, with read access to files.</div>
              <${KeyRow} label="Token" placeholder="figd_…" saved=${figma} onSave=${async (v) => {
                await saveFigmaToken(v);
                setFigma(Boolean(v));
                toast({ kind: "ok", title: v ? "Figma token saved" : "Figma token removed" });
              }} />
            </section>
            <section class="card set-sec"><h4>Unsplash photos</h4>
              <div class="note">Agents can put real photos in with <code>unsplash:</code>. It needs a free access key from <a href="https://unsplash.com/developers" target="_blank">unsplash.com/developers</a>.</div>
              ${native
                ? html`<${KeyRow} label="Access key" placeholder="Unsplash access key" saved=${info?.hasUnsplashKey} onSave=${async (v) => {
                    await native.call("setUnsplashKey", { key: v });
                    toast({ kind: "ok", title: v ? "Unsplash key saved" : "Unsplash key removed", text: "Restarting the engine…" });
                    load();
                  }} />`
                : html`<div class="note">In the browser, the key comes from <code>UNSPLASH_ACCESS_KEY</code>.</div>`}
            </section>`}
          ${tab === "shortcuts" &&
          html`<section class="card set-sec"><div class="shortcuts">
            ${[
              ["Move, frame, text, rectangle", "V  F  T  R"],
              ["Pan", "Space-drag or scroll"],
              ["Zoom in / out / fit", "⌘+ / ⌘− / ⇧1"],
              ["Zoom to selection", "⇧2"],
              ["Undo / redo", "⌘Z / ⇧⌘Z"],
              ["Duplicate / delete", "⌘D / ⌫"],
              ["Group / frame selection", "⌘G / ⌥⌘G"],
              ["Rename", "⌘R"],
              ["Nudge (×10 with ⇧)", "← ↑ → ↓"],
              ["Comment", "C"],
              ["Hide the panels", "⌘\\"],
              ["New board", "⌘N"],
              ["All boards", "⇧⌘O"],
            ].map(([a, b]) => html`<span>${a}</span><span class="kbd">${b}</span>`)}
          </div></section>`}
          ${tab === "plan" &&
          html`<section class="card set-sec"><h4>Your plan</h4>
              <${SetRow} label=${teams.length ? "Team" : "Free"} hint=${teams.length ? "Shared boards, live editing and comments with your team" : "Unlimited boards, agents, imports and exports, for you"}>
                ${!teams.length && html`<button class="btn primary sm" onClick=${() => set({ modal: { kind: "upgrade" } })}>See the Team plan</button>`}
              <//>
            </section>`}
        </div>
      </div>
    </div>
  </div>`;
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

const MODALS = {
  settings: Settings,
  confirm: Confirm,
  prompt: Prompt,
  importWebsite: ImportWebsite,
  importFigma: ImportFigma,
  signIn: () => html`<${SignInModal} Sheet=${Sheet} />`,
  upgrade: UpgradeModal,
  createTeam: () => html`<${CreateTeamModal} Sheet=${Sheet} />`,
  teamMembers: () => html`<${TeamMembersModal} Sheet=${Sheet} />`,
  moveToTeam: () => html`<${MoveToTeamModal} Sheet=${Sheet} />`,
};

// =============================================================================================
// Root

function App() {
  const s = useStore();
  if (s.bootError)
    return html`<div class="boot"><b>The engine didn't start</b><span>${s.bootError}</span>${native && html`<button class="btn" onClick=${() => native.call("restartEngine")}>Restart the engine</button>`}</div>`;
  if (!s.ready) return html`<div class="boot"><div class="boot-mark"></div></div>`;
  const Modal = s.modal && MODALS[s.modal.kind];
  // Glassine opens on its sign-in screen, then three short steps the first time.
  if (s.opts?.requireAccount) {
    if (!s.cloud?.loaded) return html`<div class="boot"><div class="boot-mark"></div></div>`;
    if (!s.cloud.signedIn || (s.gate !== false && !onboarded(s.cloud.user)))
      return html`<${Gate} />
        ${Modal && html`<${Modal} key=${s.modal.kind} />`}
        <${Toasts} />`;
  }
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
  // Frames copied in Figma (the Mac app hands over what Figma put on the clipboard).
  pasteFigma: (html) => pasteFigma(html, { board: S.boardId }),
  // A .fig file the Mac app was given (pasted from Finder, opened with the app): onto this board, or a new one.
  importFigBytes: async ({ name, data }) => {
    try {
      const blob = await (await fetch(`data:application/octet-stream;base64,${data}`)).blob();
      await importFigFile(new File([blob], name), { board: S.boardId });
    } catch (err) {
      fail(err, "Couldn't bring the Figma file in");
    }
  },
  // Before the app quits: the open board's last changes.
  flush: () => boardSaved(),
  error: (message) => toast({ kind: "err", title: "Something went wrong", text: message }),
};
// The Mac app's file picker asks which kinds of file the picker being opened takes (its accept
// list): noted when one is clicked, or opened from code (most are, without being on the page).
const noteAccept = (el) => el instanceof HTMLInputElement && el.type === "file" && (window.__pickerAccept = el.accept || "");
document.addEventListener("click", (e) => noteAccept(e.target), true);
for (const m of ["click", "showPicker"]) {
  const own = HTMLInputElement.prototype[m];
  if (own)
    HTMLInputElement.prototype[m] = function (...a) {
      noteAccept(this);
      return own.apply(this, a);
    };
}
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
  const htmlText = e.clipboardData?.getData("text/html") ?? "";
  if (isFigmaClipboard(htmlText)) return (e.preventDefault(), pasteFigma(htmlText));
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
  const files = [...e.dataTransfer.files];
  // A .fig file: its frames, as a board of their own.
  const fig = files.find(isFigFile);
  if (fig) return importFigFile(fig).catch((err) => fail(err, "Couldn't bring the Figma file in"));
  uploadFiles(files).then(startBoardWith);
});

// The draggable title-bar area, for the Mac app's window.
function reportDragRegions() {
  // Electron drags the window by CSS (styles.css, -webkit-app-region): only the Swift app needs this.
  if (!native || window.glassine) return;
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
if (native && !window.glassine)
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
    restoreTabs();
    const [opts] = await Promise.all([api("/api/options"), restore()]);
    set({ opts });
    if (opts.appName) document.title = opts.appName;
    void refreshAccount();
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
