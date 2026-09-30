// Scenes: every design saves itself as you work. The switcher by the scene name lists them in a
// popover; the Scenes page (⇧⌘O) lists them all, full window, like a file browser.
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { Popover, html } from "./controls.js";
import { Icon } from "./icons.js";
import { S, fileUrl, persistPrefs, refreshScenes, saveSceneNow, set, thumbUrl, useStore } from "./store.js";
import { addDevice, deleteSavedScene, designForMe, duplicateSavedScene, newScene, openScene, renameSavedScene } from "./actions.js";
import { openMenu } from "./menu.js";

// ---------------------------------------------------------------------------------------------
// Dates, the way people say them

const dayStart = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
const daysAgo = (iso) => Math.round((dayStart(new Date()) - dayStart(new Date(iso))) / 86400000);

/** "just now", "5 min ago", "3 hours ago", "yesterday", "Monday", "Sep 12". */
export function when(iso) {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  const days = daysAgo(iso);
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (days === 0) {
    const h = Math.round(s / 3600);
    return `${h} hour${h === 1 ? "" : "s"} ago`;
  }
  if (days === 1) return "yesterday";
  const d = new Date(iso);
  if (days < 7) return d.toLocaleDateString(undefined, { weekday: "long" });
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: d.getFullYear() === new Date().getFullYear() ? undefined : "numeric" });
}
const cap = (t) => t.charAt(0).toUpperCase() + t.slice(1);

function groupLabel(iso) {
  const days = daysAgo(iso);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return "Previous 7 days";
  if (days < 30) return "Previous 30 days";
  return new Date(iso).toLocaleDateString(undefined, { month: "long", year: "numeric" });
}

// ---------------------------------------------------------------------------------------------
// Shared by the popover, the page and right-clicks anywhere a scene shows

export const sceneMenu = (id) => [
  { label: "Open", icon: "canvas", run: () => openScene(id) },
  { label: "Rename…", icon: "text", run: () => (S.scenesPage ? set({ renaming: id }) : renameSavedScene(id)) },
  { label: "Duplicate", icon: "duplicate", kbd: S.scenesPage ? "⌘D" : undefined, run: () => duplicateSavedScene(id) },
  "-",
  { label: "Delete…", icon: "trash", danger: true, kbd: S.scenesPage ? "⌫" : undefined, run: () => deleteSavedScene(id) },
];

export function SceneThumb({ x }) {
  return html`<div class="scene-thumb">${x.thumb ? html`<img src=${fileUrl(x.thumb, x.thumbAt ?? x.updatedAt)} draggable=${false} />` : html`<${Icon} n="canvas" s=${18} />`}</div>`;
}

export function openScenesPage() {
  set({ scenesPage: true, scenesOpen: false, exportOpen: false, menu: null, renaming: null });
  refreshScenes();
  // The design on screen joins the list with its latest name and look.
  saveSceneNow().then(() => refreshScenes());
}
export const closeScenesPage = () => set({ scenesPage: false, renaming: null });
export const toggleScenesPage = () => (S.scenesPage ? closeScenesPage() : openScenesPage());

// ---------------------------------------------------------------------------------------------
// The quick switcher by the scene name

export function ScenesPopover({ anchor }) {
  const s = useStore();
  const [q, setQ] = useState("");
  useEffect(() => {
    saveSceneNow().then(() => refreshScenes());
  }, []);
  const list = s.scenes.filter((x) => !q || x.name.toLowerCase().includes(q.toLowerCase()));
  return html`<${Popover} anchor=${anchor} class="scenes-pop" width=${440} onClose=${() => set({ scenesOpen: false })}>
    <div class="scenes-head">
      <b>Scenes</b><span class="faint">${s.scenes.length || ""}</span><span class="grow"></span>
      <button class="btn sm ghost" onClick=${openScenesPage} title="Every scene, full window (⇧⌘O)"><${Icon} n="grid" s=${13} />See all</button>
      <button class="btn sm primary" onClick=${newScene}><${Icon} n="plus" s=${12} w=${2.4} />New scene</button>
    </div>
    ${s.scenes.length > 6 && html`<div class="input-wrap scenes-search"><${Icon} n="search" s=${13} /><input class="input sm" placeholder="Search scenes" value=${q} autoFocus onInput=${(e) => setQ(e.target.value)} onKeyDown=${(e) => e.stopPropagation()} /></div>`}
    ${list.length
      ? html`<div class="scene-grid">${list.slice(0, 12).map(
          (x) => html`<div class="scene-card ${x.id === s.sceneId ? "on" : ""}" role="button" tabindex="0" data-scene=${x.id} title=${x.name}
              onClick=${() => openScene(x.id)} onKeyDown=${(e) => e.key === "Enter" && openScene(x.id)}>
            <${SceneThumb} x=${x} />
            <div class="scene-meta"><b>${x.name}</b><span>${x.id === s.sceneId ? "Open now" : cap(when(x.updatedAt))}</span></div>
            <button class="scene-more" title="More" onClick=${(e) => {
              e.stopPropagation();
              const r = e.currentTarget.getBoundingClientRect();
              openMenu(r.left, r.bottom + 4, sceneMenu(x.id));
            }}><${Icon} n="dots" s=${14} /></button>
          </div>`,
        )}</div>
        ${list.length > 12 && html`<button class="scenes-more-link" onClick=${openScenesPage}>${list.length - 12} more · See all scenes</button>`}`
      : html`<div class="empty-note">${q ? "No scenes match." : "Scenes save themselves as you work. Start designing and this one appears here."}</div>`}
    <div class="scenes-foot"><${Icon} n="check" s=${12} />Saved automatically · <span class="kbd">⌘S</span> saves now<span class="grow"></span><span class="kbd">⇧⌘O</span> all scenes</div>
  <//>`;
}

// ---------------------------------------------------------------------------------------------
// The Scenes page

const KINDS = [
  { id: "iphone", label: "iPhone", icon: "phone" },
  { id: "ipad", label: "iPad", icon: "tablet" },
  { id: "mac", label: "Mac", icon: "laptop" },
  { id: "watch", label: "Watch", icon: "watch" },
  { id: "web", label: "Web", icon: "globe" },
];
const KIND_ICON = Object.fromEntries(KINDS.map((k) => [k.id, k.icon]));

const SORTS = [
  { id: "edited", label: "Last edited" },
  { id: "created", label: "Date created" },
  { id: "name", label: "Name" },
];
const ORDER = {
  edited: (a, b) => b.updatedAt.localeCompare(a.updatedAt),
  created: (a, b) => b.createdAt.localeCompare(a.createdAt),
  name: (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }),
};

function prefs(patch) {
  set({ scenesPrefs: { ...S.scenesPrefs, ...patch } });
  persistPrefs();
}

const matches = (x, q) => {
  const t = q.trim().toLowerCase();
  return !t || [x.name, x.headline, ...(x.deviceNames ?? [])].some((v) => v?.toLowerCase().includes(t));
};

function groupsOf(list, sort) {
  if (sort === "name") return [{ label: null, items: list }];
  const key = sort === "created" ? "createdAt" : "updatedAt";
  const out = [];
  for (const x of list) {
    const label = groupLabel(x[key]);
    if (out.at(-1)?.label === label) out.at(-1).items.push(x);
    else out.push({ label, items: [x] });
  }
  return out;
}

/** "iPhone 18 Pro ×2, MacBook Pro 14-inch". */
function devicesLabel(x) {
  const counts = new Map();
  for (const n of x.deviceNames ?? []) counts.set(n, (counts.get(n) ?? 0) + 1);
  return [...counts].map(([n, c]) => (c > 1 ? `${n} ×${c}` : n)).join(", ") || "No devices";
}

const typing = () => {
  const a = document.activeElement;
  return a && (/INPUT|TEXTAREA|SELECT/.test(a.tagName) || a.isContentEditable);
};

/** Arrow keys move between cards the way they sit on screen, across groups. */
function moveFocus(dir) {
  const cards = [...document.querySelectorAll(".scenes-page [data-card]")];
  if (!cards.length) return;
  const at = cards.indexOf(document.activeElement);
  const go = (el) => {
    el?.focus();
    el?.scrollIntoView({ block: "nearest" });
  };
  if (at < 0 || dir === "first") return go(cards[0]);
  if (dir === "left" || dir === "right") return go(cards[at + (dir === "right" ? 1 : -1)]);
  const box = (el) => el.getBoundingClientRect();
  const r = box(cards[at]);
  const cx = r.left + r.width / 2;
  const others = cards.filter((c) => (dir === "down" ? box(c).top > r.top + 4 : box(c).top < r.top - 4));
  if (!others.length) {
    if (dir === "up") document.querySelector(".sp-search input")?.focus();
    return;
  }
  const rowTop = dir === "down" ? Math.min(...others.map((c) => box(c).top)) : Math.max(...others.map((c) => box(c).top));
  const row = others.filter((c) => Math.abs(box(c).top - rowTop) < 4);
  row.sort((a, b) => Math.abs(box(a).left + box(a).width / 2 - cx) - Math.abs(box(b).left + box(b).width / 2 - cx));
  go(row[0]);
}

const moreMenu = (e, id) => {
  e.stopPropagation();
  const r = e.currentTarget.getBoundingClientRect();
  openMenu(r.left, r.bottom + 4, sceneMenu(id));
};

function Thumb({ x, mini }) {
  const [loaded, setLoaded] = useState(false);
  if (x.thumb) return html`<img src=${fileUrl(x.thumb, x.thumbAt ?? x.updatedAt)} class=${loaded ? "in" : ""} loading="lazy" decoding="async" draggable=${false} alt="" onLoad=${() => setLoaded(true)} />`;
  if (mini) return x.devices ? html`<span class="spinner"></span>` : html`<${Icon} n="canvas" s=${14} />`;
  if (x.devices) return html`<div class="sp-placeholder"><span class="spinner"></span>Drawing a preview…</div>`;
  return html`<div class="sp-placeholder">${x.headline ? html`<span class="hl">${x.headline}</span>` : html`<${Icon} n="canvas" s=${22} /><span>Empty scene</span>`}</div>`;
}

function NameEdit({ x }) {
  const ref = useRef();
  const done = useRef(false);
  const [v, setV] = useState(x.name);
  useLayoutEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  const finish = (save) => {
    if (done.current) return;
    done.current = true;
    set({ renaming: null });
    if (save && v.trim()) renameSavedScene(x.id, v.trim());
    requestAnimationFrame(() => document.querySelector(`.scenes-page [data-card][data-scene="${x.id}"]`)?.focus());
  };
  return html`<input ref=${ref} class="sp-rename" value=${v} spellcheck=${false} maxlength="120"
    onInput=${(e) => setV(e.target.value)} onClick=${(e) => e.stopPropagation()} onBlur=${() => finish(true)}
    onKeyDown=${(e) => {
      e.stopPropagation();
      if (e.key === "Enter") finish(true);
      else if (e.key === "Escape") finish(false);
    }} />`;
}

function Kinds({ x }) {
  return (x.kinds ?? []).slice(0, 3).map((k) => html`<${Icon} n=${KIND_ICON[k]} s=${12} />`);
}

function Card({ x, sort, on, fresh, renaming }) {
  const stamp = sort === "created" ? `Created ${when(x.createdAt)}` : `Edited ${when(x.updatedAt)}`;
  return html`<div class="sp-card ${on ? "on" : ""} ${fresh ? "fresh" : ""}" data-card data-scene=${x.id} tabindex="0" role="button" aria-label=${x.name}
      onClick=${() => !renaming && openScene(x.id)}>
    <div class="sp-thumb">
      <${Thumb} x=${x} />
      ${on && html`<span class="sp-badge"><i></i>Open now</span>`}
    </div>
    <div class="sp-info">
      <div class="sp-text">
        ${renaming ? html`<${NameEdit} x=${x} />` : html`<b title=${x.name}>${x.name}</b>`}
        <span class="sp-meta"><${Kinds} x=${x} /><span>${stamp}</span></span>
      </div>
      <button class="sp-more" title="More" onClick=${(e) => moreMenu(e, x.id)}><${Icon} n="dots" s=${16} /></button>
    </div>
  </div>`;
}

function ListView({ list, sort, s }) {
  const head = (id, label) => html`<button class="sp-th ${sort === id ? "on" : ""}" onClick=${() => prefs({ sort: id })}>${label}${sort === id && html`<${Icon} n=${id === "name" ? "up" : "down"} s=${11} w=${2} />`}</button>`;
  return html`<div class="sp-list" role="table">
    <div class="sp-row sp-headrow" role="row">
      <span>${head("name", "Name")}</span><span>Devices</span><span>Size</span><span>${head("edited", "Edited")}</span><span>${head("created", "Created")}</span><span></span>
    </div>
    ${list.map((x) => {
      const on = x.id === s.sceneId;
      return html`<div class="sp-row ${on ? "on" : ""} ${x.id === s.freshScene ? "fresh" : ""}" data-card data-scene=${x.id} tabindex="0" role="row" aria-label=${x.name}
          onClick=${() => s.renaming !== x.id && openScene(x.id)}>
        <span class="sp-name">
          <span class="sp-mini"><${Thumb} x=${x} mini /></span>
          ${s.renaming === x.id ? html`<${NameEdit} x=${x} />` : html`<b title=${x.name}>${x.name}</b>`}
          ${on && html`<span class="sp-badge inline"><i></i>Open</span>`}
        </span>
        <span class="sp-dim sp-devs"><${Kinds} x=${x} /><span>${devicesLabel(x)}</span></span>
        <span class="sp-dim mono">${x.size ? `${x.size.width} × ${x.size.height}` : "—"}</span>
        <span class="sp-dim">${cap(when(x.updatedAt))}</span>
        <span class="sp-dim">${cap(when(x.createdAt))}</span>
        <span><button class="sp-more" title="More" onClick=${(e) => moreMenu(e, x.id)}><${Icon} n="dots" s=${16} /></button></span>
      </div>`;
    })}
  </div>`;
}

export function ScenesPage() {
  const s = useStore();
  const p = s.scenesPrefs;
  const [q, setQ] = useState("");
  const search = useRef();

  useEffect(() => {
    search.current?.focus();
    const onKey = (e) => {
      if (S.modal || S.menu || S.renaming) return;
      const mod = e.metaKey || e.ctrlKey;
      const k = e.key.toLowerCase();
      const inSearch = document.activeElement === search.current;
      if ((mod && k === "f") || (e.key === "/" && !typing())) {
        e.preventDefault();
        search.current?.focus();
        return search.current?.select();
      }
      if (e.key === "Escape") {
        e.preventDefault();
        if (inSearch && search.current.value) return setQ("");
        return closeScenesPage();
      }
      if (inSearch) {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          moveFocus("first");
        } else if (e.key === "Enter") {
          document.querySelector(".scenes-page [data-card]")?.click();
        }
        return;
      }
      if (typing()) return;
      if (e.key.startsWith("Arrow")) {
        e.preventDefault();
        return moveFocus(e.key.slice(5).toLowerCase());
      }
      const card = document.activeElement?.closest?.(".scenes-page [data-card]");
      if (!card) return;
      const id = card.dataset.scene;
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        openScene(id);
      } else if (e.key === "Backspace" || e.key === "Delete") {
        e.preventDefault();
        deleteSavedScene(id);
      } else if (mod && k === "d") {
        e.preventDefault();
        duplicateSavedScene(id);
      }
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, []);

  // Thumbnails render in the background: check back while some are still on their way (for a minute).
  const waiting = s.scenes.some((x) => x.devices && !x.thumb);
  useEffect(() => {
    if (!waiting) return;
    const until = Date.now() + 60000;
    const t = setInterval(() => (Date.now() > until ? clearInterval(t) : refreshScenes()), 2500);
    return () => clearInterval(t);
  }, [waiting]);

  const all = s.scenes;
  const counts = {};
  for (const x of all) for (const k of x.kinds ?? []) counts[k] = (counts[k] ?? 0) + 1;
  const kinds = KINDS.filter((k) => counts[k.id]);
  const kind = p.kind !== "all" && counts[p.kind] ? p.kind : "all";
  const sort = ORDER[p.sort] ? p.sort : "edited";
  const list = all.filter((x) => (kind === "all" || x.kinds?.includes(kind)) && matches(x, q)).sort(ORDER[sort]);
  const current = all.find((x) => x.id === s.sceneId);
  const shots = s.files.filter((f) => ["raw", "uploads", "recordings"].includes(f.kind) && /\.(png|jpe?g|webp)$/i.test(f.path));
  const latest = shots[0];

  const start = async (how) => {
    await newScene();
    closeScenesPage();
    if (how === "blank") return;
    if (how === "ai") set({ leftTab: "designs", leftOpen: true });
    await addDevice(latest.path);
    if (how === "ai") designForMe();
  };
  const sortMenu = (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    openMenu(r.left, r.bottom + 4, SORTS.map((o) => ({ label: o.label, icon: o.id === sort ? "check" : undefined, run: () => prefs({ sort: o.id }) })));
  };

  return html`<div class="scenes-page" role="dialog" aria-label="Scenes">
    <header class="sp-bar" data-drag>
      <div class="brand">
        <div class="brand-mark"></div>
        <span class="brand-name">Screenshotter</span>
        <span class="crumb-sep">/</span>
        <span class="sp-crumb">Scenes</span>
      </div>
      <div class="sp-search input-wrap" data-nodrag>
        <${Icon} n="search" s=${14} />
        <input ref=${search} class="input" placeholder="Search by name, headline or device" value=${q} spellcheck=${false} onInput=${(e) => setQ(e.target.value)} />
        ${q ? html`<button class="suffix sp-clear" title="Clear" onClick=${() => (setQ(""), search.current?.focus())}><${Icon} n="x" s=${12} w=${2.2} /></button>` : html`<span class="suffix kbd">/</span>`}
      </div>
      <span class="spacer"></span>
      <div class="hstack" data-nodrag>
        <button class="btn ghost sp-back" onClick=${closeScenesPage} title="Back to the editor (Esc)"><${Icon} n="left" s=${15} /><span>${current ? current.name : "Back to editor"}</span></button>
        <button class="btn primary" onClick=${() => start("blank")}><${Icon} n="plus" s=${14} w=${2.2} />New scene</button>
      </div>
    </header>
    <div class="sp-scroll">
      <div class="sp-inner">
        <div class="sp-head">
          <h1>Scenes</h1>
          <p>Every design saves itself here as you work. Pick one up, or start something new.</p>
        </div>
        <div class="sp-starts">
          <button class="sp-start" onClick=${() => start("blank")}>
            <span class="ico"><${Icon} n="plus" s=${18} w=${2} /></span>
            <span class="txt"><b>Blank scene</b><span>Start from the Simulator, a website or a file</span></span>
          </button>
          <button class="sp-start" disabled=${!latest} onClick=${() => start("latest")}>
            ${latest ? html`<img class="shot" src=${thumbUrl(latest.path, 120)} alt="" />` : html`<span class="ico"><${Icon} n="image" s=${18} /></span>`}
            <span class="txt"><b>Your latest screen</b><span>${latest ? "Framed in a finished design, ready to tweak" : "Capture or import a screen first"}</span></span>
          </button>
          <button class="sp-start ai" disabled=${!latest} onClick=${() => start("ai")}>
            <span class="ico"><${Icon} n="spark" s=${18} /></span>
            <span class="txt"><b>Design it for me</b><span>${latest ? "Claude makes three designs from your latest screen" : "Needs a screen to design around"}</span></span>
          </button>
        </div>
        ${all.length
          ? html`<div class="sp-toolbar">
                <div class="sp-chips">
                  <button class="chip ${kind === "all" ? "on" : ""}" onClick=${() => prefs({ kind: "all" })}>All<span class="n">${all.length}</span></button>
                  ${kinds.map((k) => html`<button class="chip ${kind === k.id ? "on" : ""}" onClick=${() => prefs({ kind: k.id })}><${Icon} n=${k.icon} s=${13} />${k.label}<span class="n">${counts[k.id]}</span></button>`)}
                </div>
                <span class="grow"></span>
                <button class="sp-sort" onClick=${sortMenu}><${Icon} n="sort" s=${14} />${SORTS.find((o) => o.id === sort).label}<${Icon} n="down" s=${12} /></button>
                <div class="sp-views">
                  <button class=${p.layout !== "list" ? "on" : ""} title="Grid" onClick=${() => prefs({ layout: "grid" })}><${Icon} n="grid" s=${15} /></button>
                  <button class=${p.layout === "list" ? "on" : ""} title="List" onClick=${() => prefs({ layout: "list" })}><${Icon} n="list" s=${15} /></button>
                </div>
              </div>
              ${!list.length
                ? html`<div class="sp-empty"><${Icon} n="search" s=${22} /><b>${q ? `No scenes match “${q.trim()}”` : "No scenes here"}</b>
                    <button class="btn sm" onClick=${() => (setQ(""), prefs({ kind: "all" }))}>Show all scenes</button></div>`
                : p.layout === "list"
                  ? html`<${ListView} list=${list} sort=${sort} s=${s} />`
                  : groupsOf(list, sort).map(
                      (g) => html`<section class="sp-group">
                        ${g.label && html`<h3>${g.label}<span>${g.items.length}</span></h3>`}
                        <div class="sp-grid">${g.items.map((x) => html`<${Card} key=${x.id} x=${x} sort=${sort} on=${x.id === s.sceneId} fresh=${x.id === s.freshScene} renaming=${s.renaming === x.id} />`)}</div>
                      </section>`,
                    )}`
          : html`<div class="sp-empty big"><div class="art"><${Icon} n="grid" s=${24} /></div><b>No scenes yet</b><span>Every design saves itself here as you work.</span></div>`}
      </div>
    </div>
  </div>`;
}
