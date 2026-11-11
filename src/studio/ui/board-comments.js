// Comments on a board: pins on the canvas, a thread by its pin, and the Comments tab. What the
// person writes goes to the agents it names, through Agentman (the Studio server sends it); their
// answers come back with the board's polling, as their changes to the design do.
import { useLayoutEffect, useRef, useState } from "preact/hooks";
import { defaultRecipients, plainText, rootOf, subtree } from "./board-core.js";
import { B, bset, commentListeners, currentPage, loadComments, node } from "./board-state.js";
import { canvasEl, centerOn, screenBox, worldBox } from "./board-canvas.js";
import { Switch, html } from "./controls.js";
import { Icon } from "./icons.js";
import { openMenu } from "./menu.js";
import { api, fail, toast } from "./store.js";

// ---------------------------------------------------------------------------------------------
// Who's who

const agents = () => Object.values(B.comments.agents ?? {}).sort((a, b) => b.lastAt.localeCompare(a.lastAt));
const agentName = (key, fallback) => B.comments.agents?.[key]?.name ?? fallback ?? "An agent";
const KINDS = { claude: "Claude", codex: "Codex", "cursor-cli": "Cursor", opencode: "OpenCode", kiro: "Kiro", antigravity: "Antigravity", muse: "Muse", agent: "Agent" };
const kindName = (k) => KINDS[k] ?? k;
const authorOf = (m) => (m.by === "person" ? "You" : agentName(m.by, m.name));
const initial = (m) => (m.by === "person" ? "Y" : (agentName(m.by, m.name).trim()[0] ?? "A").toUpperCase());

export function ago(iso) {
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (!Number.isFinite(s) || s < 45) return "now";
  if (s < 3600) return `${Math.round(s / 60)} min`;
  if (s < 86400) return `${Math.round(s / 3600)} h`;
  if (s < 86400 * 7) return `${Math.round(s / 86400)} d`;
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** What a comment is on, in a few words. */
function anchorLabel(a) {
  const name = (id) => node(id)?.name ?? a.names?.[id] ?? "A layer";
  if (a.layer) {
    const n = node(a.layer);
    if (n?.type === "text" && /^Text( \d+)?$/.test(n.name)) return plainText(n.text).slice(0, 40) || n.name;
    return name(a.layer);
  }
  return `Area of ${name(a.artboard)}`;
}

// ---------------------------------------------------------------------------------------------
// Where a pin goes: on the layer where it was clicked (or the top right of a region), on screen

function pinPoint(a) {
  if (a.layer) {
    const r = screenBox(a.layer) ?? screenBox(a.artboard);
    if (!r) return null;
    const at = node(a.layer) && a.at ? a.at : { x: 1, y: 0 };
    return { x: r.x + r.width * at.x, y: r.y + r.height * at.y };
  }
  const box = regionBox(a);
  return box && { x: box.x + box.width, y: box.y };
}

function regionBox(a) {
  if (!a.rect) return a.layer ? screenBox(a.layer) : null;
  const ab = screenBox(a.artboard);
  if (!ab) return null;
  const z = B.view.z;
  return { x: ab.x + a.rect.x * z, y: ab.y + a.rect.y * z, width: a.rect.width * z, height: a.rect.height * z };
}

/** A pin's place on the board (board units), to bring it into view. */
function pinWorld(a) {
  if (a.layer) {
    const r = worldBox(a.layer) ?? worldBox(a.artboard);
    const at = a.at ?? { x: 1, y: 0 };
    return r && { x: r.x + r.width * at.x, y: r.y + r.height * at.y };
  }
  const ab = worldBox(a.artboard);
  return ab && a.rect && { x: ab.x + a.rect.x + a.rect.width, y: ab.y + a.rect.y };
}

// ---------------------------------------------------------------------------------------------
// Seen: an agent's answer marks its pin until the thread is opened

let seen = {};
function loadSeen() {
  try {
    seen = JSON.parse(localStorage.getItem(`board:seen:${B.id}`) ?? "{}") ?? {};
  } catch {
    seen = {};
  }
}
function markSeen(t) {
  if (!t || seen[t.id] === t.messages.length) return;
  seen[t.id] = t.messages.length;
  try {
    localStorage.setItem(`board:seen:${B.id}`, JSON.stringify(seen));
  } catch {}
}
const unseen = (t) => {
  const last = t.messages[t.messages.length - 1];
  return Boolean(last && last.by !== "person" && (seen[t.id] ?? 0) < t.messages.length);
};
/** A message of the person's that didn't reach someone it was meant for. */
const notSent = (t) => t.messages.some((m) => Object.values(m.delivery ?? {}).some((d) => d.status === "failed" || (d.status === "sending" && stale(d))));
const stale = (d) => Date.now() - Date.parse(d.at) > 45_000;

let lastBoard = null;
commentListeners.add((before, after) => {
  if (B.id !== lastBoard) {
    lastBoard = B.id;
    loadSeen();
    return;
  }
  // An agent's new answer: say so, unless its thread is open.
  const had = new Set(before.threads.flatMap((t) => t.messages.map((m) => m.id)));
  for (const t of after.threads) {
    if (B.thread === t.id) {
      markSeen(t);
      continue;
    }
    const m = t.messages.find((x) => !had.has(x.id) && x.by !== "person");
    if (m) toast({ kind: "ok", icon: "comment", title: `${authorOf(m)} ${t.messages[0] === m ? "commented" : "replied"}`, text: m.text.slice(0, 120), timeout: 8000, actions: [{ label: "Show", run: () => openThread(t.id) }] });
  }
});

// ---------------------------------------------------------------------------------------------
// Opening and closing

export function openThread(id) {
  const t = B.comments.threads.find((x) => x.id === id);
  if (!t) return;
  const go = () => {
    const p = pinWorld(t.anchor);
    const c = canvasEl.current?.getBoundingClientRect();
    const r = pinPoint(t.anchor);
    // Bring the pin into view only if it's out of it (the thread opens on whichever side has room).
    if (p && c && (!r || r.x < 12 || r.y < 36 || r.x > c.width - 12 || r.y > c.height - 12)) centerOn(p, { dx: -150 });
  };
  markSeen(t);
  if (t.anchor.page !== B.page && B.board.pages.some((p) => p.id === t.anchor.page)) {
    bset({ page: t.anchor.page, sel: [], hover: null, thread: id, draft: null });
    requestAnimationFrame(() => requestAnimationFrame(go));
  } else {
    bset({ thread: id, draft: null });
    go();
  }
}

export function closeThread() {
  if (B.thread || B.draft) bset({ thread: null, draft: null });
}

/** A new comment, waiting for its words: on a layer (at a point on it), or a region of an artboard. */
export function startDraft(anchor) {
  const artboard = anchor.artboard ?? rootOf(B.board, anchor.layer);
  const page = currentPage()?.id;
  bset({ draft: { ...anchor, artboard, page, names: {} }, thread: null, sel: [], hover: null });
}

/** The layers mostly inside a region (board units), outermost first; else the one it sits in. */
export function layersIn(artboard, r) {
  const inside = [];
  for (const id of subtree(B.board, artboard)) {
    if (id === artboard || node(id)?.hidden) continue;
    const b = worldBox(id);
    if (!b || b.width * b.height <= 0) continue;
    const w = Math.max(0, Math.min(b.x + b.width, r.x + r.width) - Math.max(b.x, r.x));
    const h = Math.max(0, Math.min(b.y + b.height, r.y + r.height) - Math.max(b.y, r.y));
    if ((w * h) / (b.width * b.height) >= 0.8) inside.push(id);
  }
  const set = new Set(inside);
  const outer = inside.filter((id) => {
    let p = node(id)?.parent;
    while (p && p !== artboard) {
      if (set.has(p)) return false;
      p = node(p)?.parent;
    }
    return true;
  });
  if (outer.length) return outer;
  // Drawn inside one layer: that one (the deepest that holds it).
  let best = null;
  for (const id of subtree(B.board, artboard)) {
    const b = worldBox(id);
    if (id !== artboard && b && b.x <= r.x && b.y <= r.y && b.x + b.width >= r.x + r.width && b.y + b.height >= r.y + r.height) best = id;
  }
  return best ? [best] : [];
}

// ---------------------------------------------------------------------------------------------
// Talking to the server

async function post(body) {
  const r = await api("/api/board/comment", { id: B.id, ...body });
  await loadComments();
  return r;
}

async function send(thread, text, to) {
  try {
    if (thread) {
      await post({ do: "reply", comment: thread.id, text, to });
    } else {
      const d = B.draft;
      const anchor = d.rect ? { artboard: d.artboard, rect: d.rect, layers: d.layers } : { layer: d.layer, at: d.at };
      const r = await post({ do: "new", anchor, text, to });
      bset({ draft: null, thread: r.thread.id });
    }
    return true;
  } catch (e) {
    fail(e, "Couldn't save the comment");
    return false;
  }
}

const resolve = (t) => post({ do: "resolve", comment: t.id, resolved: !t.resolved }).then(() => !t.resolved && bset({ thread: null })).catch((e) => fail(e, "Couldn't change the comment"));
const retry = (t, m, key) => post({ do: "retry", comment: t.id, message: m.id, agents: [key] }).catch((e) => fail(e, "Couldn't send it again"));

function askDelete(t, e) {
  const r = e.currentTarget.getBoundingClientRect();
  openMenu(r.left, r.bottom + 4, [
    {
      label: t.messages.length > 1 ? "Delete the comment and its replies" : "Delete the comment",
      icon: "trash",
      danger: true,
      run: () =>
        post({ do: "delete", comment: t.id })
          .then(() => bset({ thread: null }))
          .catch((err) => fail(err, "Couldn't delete the comment")),
    },
  ]);
}

// ---------------------------------------------------------------------------------------------
// On the canvas

const stop = (e) => e.stopPropagation();

/** Pins for the page's comments, the open thread by its pin, and the region it's about. */
export function CommentLayer() {
  const b = B;
  const page = currentPage();
  if (!page || !canvasEl.current) return null;
  const busy = b.dragging && b.dragging !== "pan";
  const threads = b.comments.threads.filter((t) => t.anchor.page === page.id && (!t.resolved || b.showResolved || b.thread === t.id));
  const open = b.thread ? threads.find((t) => t.id === b.thread) : null;
  const focus = open?.anchor ?? b.draft;
  const area = focus && (focus.rect ? regionBox(focus) : focus.layer ? screenBox(focus.layer) : null);
  const draftAt = b.draft && pinPoint(b.draft);
  const at = open ? pinPoint(open.anchor) : draftAt;
  return html`
    ${area && html`<div class="bd-carea" style=${{ left: area.x + "px", top: area.y + "px", width: area.width + "px", height: area.height + "px" }}></div>`}
    ${!busy &&
    threads.map((t) => {
      const p = pinPoint(t.anchor);
      if (!p) return null;
      return html`<button key=${t.id} class="bd-pin ${t.id === b.thread ? "on" : ""} ${t.resolved ? "done" : ""}" data-thread=${t.id} style=${{ left: p.x + "px", top: p.y + "px" }}
          title=${`${anchorLabel(t.anchor)}: ${t.messages[0]?.text.slice(0, 80) ?? ""}`}
          onPointerDown=${stop} onClick=${() => (b.thread === t.id ? closeThread() : openThread(t.id))}>
        ${t.resolved ? html`<${Icon} n="check" s=${11} w=${2.4} />` : t.messages.length}
        ${!t.resolved && (unseen(t) ? html`<i class="new"></i>` : notSent(t) ? html`<i class="warn"></i>` : null)}
      </button>`;
    })}
    ${draftAt && html`<div class="bd-pin on draft" style=${{ left: draftAt.x + "px", top: draftAt.y + "px" }}><${Icon} n="plus" s=${12} w=${2.2} /></div>`}
    ${at && (open || b.draft) && html`<${ThreadCard} key=${open?.id ?? "draft"} t=${open} at=${at} />`}`;
}

/** A thread beside its pin: the messages, how each was sent, and a box to answer in. */
function ThreadCard({ t, at }) {
  const ref = useRef();
  // Beside the pin, kept inside the canvas.
  useLayoutEffect(() => {
    const el = ref.current;
    const c = canvasEl.current;
    if (!el || !c) return;
    const W = c.clientWidth;
    const H = c.clientHeight;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    let left = at.x + 30;
    if (left + w > W - 10) left = Math.max(10, at.x - w - 12);
    const top = Math.max(10, Math.min(at.y - 24, H - h - 10));
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
  });
  useLayoutEffect(() => {
    if (t) markSeen(t);
  }, [t?.messages.length]);
  const anchor = t?.anchor ?? B.draft;
  return html`<div class="bd-thread" ref=${ref} onPointerDown=${stop} onWheel=${stop} onDblClick=${stop} onContextMenu=${stop} role="dialog" aria-label="Comment">
    <header>
      <span class="t" title=${anchorLabel(anchor)}>${anchorLabel(anchor)}</span>
      ${t && html`<button class="icon-btn sm ${t.resolved ? "on" : ""}" title=${t.resolved ? "Open it again" : "Resolve"} aria-pressed=${Boolean(t.resolved)} onClick=${() => resolve(t)}><${Icon} n="check" s=${14} /></button>
        <button class="icon-btn sm" title="Delete" onClick=${(e) => askDelete(t, e)}><${Icon} n="trash" s=${14} /></button>`}
      <button class="icon-btn sm" title="Close (Esc)" onClick=${closeThread}><${Icon} n="x" s=${14} /></button>
    </header>
    ${t && html`<div class="bd-msgs">${t.messages.map((m) => html`<${Message} key=${m.id} t=${t} m=${m} />`)}</div>`}
    ${t?.resolved && html`<p class="bd-resolved">Resolved by ${t.resolved.by === "person" ? "you" : agentName(t.resolved.by)}, ${ago(t.resolved.at)}${ago(t.resolved.at) === "now" ? "" : " ago"}</p>`}
    <${Composer} t=${t} anchor=${anchor} />
  </div>`;
}

function Message({ t, m }) {
  return html`<div class="bd-msg">
    <div class="who"><span class="av ${m.by === "person" ? "" : "agent"}">${initial(m)}</span><b>${authorOf(m)}</b><span class="when">${ago(m.createdAt)}</span></div>
    <p class="txt">${m.text}</p>
    ${(m.to ?? []).map((key) => html`<${DeliveryLine} key=${key} t=${t} m=${m} k=${key} />`)}
  </div>`;
}

/** How sending a message to one agent went, in a few quiet words. */
function DeliveryLine({ t, m, k }) {
  const d = m.delivery?.[k] ?? { status: "sending", at: m.createdAt };
  const who = agentName(k);
  const again = html` · <button class="bd-link" onClick=${() => retry(t, m, k)}>Try again</button>`;
  if (d.status === "delivered") return html`<p class="bd-sent" title=${d.guess ? "Agentman lists one agent in its folder; it's most likely this one" : "Agentman typed it into the agent's chat"}>Sent to ${who}${d.guess ? " (by its folder)" : ""}</p>`;
  if (d.status === "queued") return html`<p class="bd-sent" title="It's a session Agentman can't type into while it works">Sent to ${who}: it gets it when its turn ends</p>`;
  if (d.status === "sending" && !stale(d)) return html`<p class="bd-sent">Sending to ${who}…</p>`;
  const why = d.status === "sending" ? "it didn't finish sending" : d.error || "something went wrong";
  return html`<p class="bd-sent failed"><i></i>Couldn't reach ${who}: ${why}${again}</p>`;
}

/** The box to write in, with who it goes to: the agents who worked here unless changed (@ picks). */
function Composer({ t, anchor }) {
  const [text, setText] = useState("");
  const [to, setTo] = useState(() => defaultRecipients({ agents: B.comments.agents ?? {} }, anchor.artboard, t?.messages ?? []));
  const [picking, setPicking] = useState(null);
  const [active, setActive] = useState(0);
  const [busy, setBusy] = useState(false);
  const area = useRef();
  useLayoutEffect(() => {
    area.current?.focus();
  }, [t?.id]);
  const all = agents();
  const q = (picking?.q ?? "").toLowerCase();
  const options = all.filter((a) => !q || a.name.toLowerCase().includes(q) || kindName(a.kind).toLowerCase().includes(q));
  const pick = (a) => {
    setTo(to.includes(a.key) ? to.filter((k) => k !== a.key) : [...to, a.key]);
    // The @word was only for picking: it doesn't stay in the words.
    if (picking?.typed) setText(text.slice(0, picking.at) + text.slice(picking.at + 1 + picking.q.length));
    setPicking(null);
    area.current?.focus();
  };
  const go = async () => {
    const words = text.trim();
    if (!words || busy) return;
    setBusy(true);
    const ok = await send(t, words, to);
    setBusy(false);
    if (ok) setText("");
  };
  const onInput = (e) => {
    const v = e.target.value;
    setText(v);
    const caret = e.target.selectionStart ?? v.length;
    const m = /(^|\s)@([^\s@]*)$/.exec(v.slice(0, caret));
    if (m && all.length) {
      setPicking({ typed: true, at: caret - m[2].length - 1, q: m[2] });
      setActive(0);
    } else if (picking?.typed) setPicking(null);
  };
  const onKey = (e) => {
    e.stopPropagation();
    if (picking && options.length) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        return setActive((active + (e.key === "ArrowDown" ? 1 : options.length - 1)) % options.length);
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        return pick(options[Math.min(active, options.length - 1)]);
      }
    }
    if (e.key === "Escape") {
      e.preventDefault();
      return picking ? setPicking(null) : closeThread();
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      go();
    }
  };
  return html`<div class="bd-compose">
    ${all.length > 0
      ? html`<div class="bd-to">
          <span class="lbl">To</span>
          ${to.map((k) => html`<span key=${k} class="bd-chip">${agentName(k)}<button title=${`Don't send to ${agentName(k)}`} onClick=${() => setTo(to.filter((x) => x !== k))}><${Icon} n="x" s=${10} w=${2} /></button></span>`)}
          ${!to.length && html`<span class="none">no one: a note</span>`}
          <button class="icon-btn sm bd-add-to" title="Send to an agent (or type @)" onClick=${() => setPicking(picking ? null : { typed: false, at: 0, q: "" })}><${Icon} n="plus" s=${13} /></button>
        </div>`
      : html`<p class="bd-sent">No agent has worked on this board, so this is a note for now.</p>`}
    ${picking &&
    html`<div class="bd-picker" role="listbox">
      ${options.length
        ? options.map((a, i) => html`<button key=${a.key} role="option" aria-selected=${i === active} class=${`${i === active ? "act" : ""} ${to.includes(a.key) ? "in" : ""}`} onPointerDown=${(e) => e.preventDefault()} onClick=${() => pick(a)}>
            <span class="av agent">${(a.name.trim()[0] ?? "A").toUpperCase()}</span>
            <span class="nm">${a.name}</span>
            <span class="k">${anchor.artboard && a.artboards.includes(anchor.artboard) ? "worked here" : kindName(a.kind)}</span>
            ${to.includes(a.key) && html`<${Icon} n="check" s=${12} />`}
          </button>`)
        : html`<p class="bd-sent">No agent called that.</p>`}
    </div>`}
    <textarea ref=${area} class="textarea" rows="2" placeholder=${t ? "Reply" : "Add a comment"} value=${text} onInput=${onInput} onKeyDown=${onKey}></textarea>
    <div class="bd-compose-foot">
      <span class="hint">⏎ to send, ⇧⏎ for a new line</span>
      <button class="btn sm" disabled=${!text.trim() || busy} onClick=${go}>${busy ? "Sending…" : to.length ? "Send" : "Save"}</button>
    </div>
  </div>`;
}

// ---------------------------------------------------------------------------------------------
// The Comments tab

export function CommentsPanel() {
  const b = B;
  const order = (t) => (t.resolved ? "0" : "1") + t.updatedAt;
  const threads = b.comments.threads.filter((t) => !t.resolved || b.showResolved).sort((x, y) => order(y).localeCompare(order(x)));
  const resolvedCount = b.comments.threads.filter((t) => t.resolved).length;
  const pageName = (id) => (b.board.pages.length > 1 ? b.board.pages.find((p) => p.id === id)?.name : null);
  const list = agents();
  return html`<div class="bd-comments">
    <div class="bd-head"><h3>Comments</h3>${resolvedCount > 0 && html`<${Switch} checked=${b.showResolved} onChange=${(v) => bset({ showResolved: v })} label=${`Resolved (${resolvedCount})`} />`}</div>
    <div class="bd-crows">
      ${threads.length
        ? threads.map((t) => {
            const first = t.messages[0];
            const last = t.messages[t.messages.length - 1];
            const replies = t.messages.length - 1;
            const state = t.resolved ? "Resolved" : notSent(t) ? "Not sent to everyone" : unseen(t) ? `New from ${authorOf(last)}` : replies ? `${replies} repl${replies === 1 ? "y" : "ies"}` : "";
            return html`<button key=${t.id} class="bd-crow ${b.thread === t.id ? "on" : ""} ${t.resolved ? "done" : ""}" data-thread=${t.id} onClick=${() => openThread(t.id)}>
              <span class="av ${first.by === "person" ? "" : "agent"}">${initial(first)}</span>
              <span class="body">
                <span class="top"><b>${anchorLabel(t.anchor)}</b><span class="when">${ago(t.updatedAt)}</span></span>
                <span class="txt">${first.text}</span>
                ${(state || pageName(t.anchor.page)) && html`<span class="meta ${notSent(t) && !t.resolved ? "warn" : unseen(t) && !t.resolved ? "new" : ""}">${[pageName(t.anchor.page), state].filter(Boolean).join(" · ")}</span>`}
              </span>
            </button>`;
          })
        : html`<p class="bd-hint">${b.comments.threads.length ? "Every comment is resolved." : "No comments yet. Press C, then click a layer or drag over part of an artboard. A comment goes to the agents that worked there, through Agentman, and their answers show here."}</p>`}
    </div>
    ${list.length > 0 &&
    html`<div class="bd-cagents">
      <div class="bd-head"><h3>Agents on this board</h3></div>
      ${list.map((a) => html`<div key=${a.key} class="bd-cagent" title=${a.session ? `${a.session}${a.how === "folder" ? " (found by its folder)" : ""}` : "Agentman didn't know this agent when it worked here"}>
        <span class="av agent">${(a.name.trim()[0] ?? "A").toUpperCase()}</span>
        <span class="nm">${a.name}</span>
        <span class="k">${kindName(a.kind)} · ${ago(a.lastAt)}</span>
      </div>`)}
    </div>`}
  </div>`;
}

/** Comments open on the board (for the tab's count). */
export const openCount = () => B.comments.threads.filter((t) => !t.resolved).length;
