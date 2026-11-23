// The Agent tab of a board's right panel: chat with Claude Code, Codex, opencode or Antigravity,
// on the person's own subscription, about this board. The agent works on the canvas through
// Screenshotter's tools while the chat shows what it did, in a few words, and its answer.
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { html, Popover } from "./controls.js";
import { Icon } from "./icons.js";
import { AgentLogo } from "./agent-logos.js";
import { B, currentPage, node, useBoard } from "./board-state.js";
import { api, fail, when } from "./store.js";
import { layerIcon } from "./board.js";

// ---------------------------------------------------------------------------------------------
// State: the agents on this Mac, the board's chats, the chat open, kept outside the panel so a
// chat keeps running (and showing) when the panel closes.

const A = { agents: null, pick: null, chats: [], thread: null, open: null, listeners: new Set() };
const emit = () => A.listeners.forEach((l) => l());
function useAgent() {
  const [, force] = useState(0);
  useEffect(() => {
    const l = () => force((n) => n + 1);
    A.listeners.add(l);
    return () => A.listeners.delete(l);
  }, []);
  return A;
}
const remembered = (k) => {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
};
const remember = (k, v) => {
  try {
    v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v);
  } catch {}
};

/** Which agent a new chat starts with. */
export function pickAgent(id) {
  A.pick = id;
  remember("agent:pick", id);
  emit();
}
export const pickedAgent = () => A.pick;

export async function loadAgents() {
  if (A.agents) return A.agents;
  const r = await api("/api/agents").catch(() => ({ agents: [] }));
  A.agents = r.agents;
  const saved = remembered("agent:pick");
  A.pick = r.agents.find((a) => a.id === saved)?.id ?? r.agents[0]?.id ?? null;
  emit();
  return A.agents;
}
export const agentLabel = (id) => A.agents?.find((a) => a.id === id)?.label ?? { claude: "Claude Code", codex: "Codex", opencode: "opencode", agy: "Antigravity" }[id] ?? id;

let poll = 0;
/** Follow the open chat: quickly while the agent works, and stop when it's done. */
function follow() {
  clearTimeout(poll);
  const id = A.open;
  if (!id) return;
  api(`/api/chat?id=${id}`)
    .then((t) => {
      if (A.open !== id) return;
      if (!A.thread || A.thread.rev !== t.rev || A.thread.id !== t.id) {
        A.thread = t;
        emit();
      }
      if (working(t)) poll = setTimeout(follow, 450);
      else refreshChats();
    })
    .catch(() => {
      if (A.open === id) poll = setTimeout(follow, 2000);
    });
}
const working = (t) => {
  const last = t?.messages?.[t.messages.length - 1];
  return last?.role === "agent" && last.status === "working";
};
export const agentWorking = () => working(A.thread);
/** On the Agent tab: a dot while the agent works. */
export function AgentDot() {
  const a = useAgent();
  return working(a.thread) ? html`<i class="ag-dot"></i>` : null;
}

async function refreshChats() {
  if (!B.id) return;
  const board = B.id;
  const r = await api(`/api/chats?board=${encodeURIComponent(board)}`).catch(() => ({ chats: [] }));
  if (B.id !== board) return;
  A.chats = r.chats;
  emit();
}

/** Open a chat (or none, for a new one) on this board. */
function openChat(id) {
  A.open = id;
  A.thread = null;
  remember(`chat:${B.id}`, id);
  emit();
  if (id) follow();
}

/** When a board opens: its chats, and the one that was open last time. */
export function boardOpened(boardId) {
  clearTimeout(poll);
  A.chats = [];
  A.thread = null;
  A.open = null;
  loadAgents();
  refreshChats().then(() => {
    if (B.id !== boardId) return;
    const last = remembered(`chat:${boardId}`);
    if (last && A.chats.some((c) => c.id === last)) openChat(last);
    else emit();
  });
}

async function sendMessage(text) {
  if (!A.pick) return;
  try {
    const t = await api("/api/chat/send", { thread: A.open ?? undefined, board: B.id, agent: A.pick, text, page: B.page, selection: B.sel });
    A.open = t.id;
    A.thread = t;
    remember(`chat:${B.id}`, t.id);
    emit();
    follow();
    refreshChats();
    return true;
  } catch (e) {
    fail(e, "Couldn't send it");
    return false;
  }
}

// ---------------------------------------------------------------------------------------------
// The panel

export function AgentPanel() {
  const a = useAgent();
  useBoard(["hover", "guides", "drop", "words", "view"]);
  useEffect(() => {
    loadAgents();
    if (A.open && !A.thread) follow();
  }, []);
  if (a.agents && !a.agents.length) return html`<${NoAgents} />`;
  const t = a.thread;
  return html`<div class="ag">
    <${ChatHead} />
    ${t && t.messages.length ? html`<${Thread} t=${t} />` : html`<${Starts} />`}
    <${Composer} />
  </div>`;
}

function ChatHead() {
  const a = useAgent();
  const [open, setOpen] = useState(false);
  const btn = useRef();
  const title = a.thread?.title ?? (a.open ? "…" : "New chat");
  const has = a.chats.length > 0;
  return html`<div class="ag-head">
    <button class="ag-chats" ref=${btn} disabled=${!has} title=${has ? "Earlier chats" : null} onClick=${() => setOpen(!open)}><span class="ag-title">${title}</span>${has && html`<${Icon} n="down" s=${10} w=${2} />`}</button>
    <button class="icon-btn sm ag-new" title="New chat" disabled=${!a.open} onClick=${() => openChat(null)}><${Icon} n="plus" s=${14} /></button>
    ${open &&
    html`<${Popover} anchor=${btn.current} onClose=${() => setOpen(false)} width=${Math.max(220, btn.current?.offsetWidth ?? 240)} align="start">
      <div class="ag-history">
        ${a.chats.map(
          (c) => html`<button class=${`ag-hrow ${c.id === a.open ? "on" : ""}`} onClick=${() => (openChat(c.id), setOpen(false))}>
            <${AgentLogo} id=${c.agent} s=${13} />
            <span class="grow"><b>${c.title}</b><small>${c.working ? "Working…" : when(c.updatedAt)}</small></span>
          </button>`,
        )}
      </div>
    <//>`}
  </div>`;
}

/** An empty chat: a few things to ask, from what's on the board. */
function ideasNow() {
  const page = currentPage();
  const first = page?.children.map((id) => node(id)).find((n) => n && !n.hidden);
  const sel = B.sel.length === 1 ? node(B.sel[0]) : null;
  const q = (n) => `“${n.name}”`;
  const short = (n) => (n.name.length > 26 ? `${n.name.slice(0, 24).trimEnd()}…` : n.name);
  const narrow = first && parseFloat(first.style?.width) < 600;
  // Each: what the row says, and the whole request it puts in the field (which names the layer).
  const ideas = sel
    ? [["Make it feel more premium", `Make ${q(sel)} feel more premium`], ["Three variations, side by side", `Three variations of ${q(sel)}, side by side`], ["Tighten the spacing and type", `Tighten the spacing and type in ${q(sel)}`]]
    : first
      ? [[narrow ? "Make a desktop version" : "Make a phone version", `Make a ${narrow ? "desktop" : "phone"} version of ${q(first)}`], ["Try three colour directions", `Try three colour directions for ${q(first)}`], ["Tighten the spacing and type", `Tighten the spacing and type on ${q(first)}`]]
      : [["A sign-up screen for an iPhone app", "Design a sign-up screen for an iPhone app"], ["A pricing page with three plans", "A pricing page with three plans"], ["A settings screen, light and dark", "A settings screen, light and dark"]];
  const about = sel ? `It works on “${short(sel)}”, the layer you have selected.` : first ? `Select a layer to change just that, or ask about “${short(first)}”.` : "Describe a screen and it lands here as layers you can change.";
  return { ideas: ideas.map(([label, ask]) => ({ label, ask })), about };
}

/** An empty chat: who you're talking to, what it will work on, and a few things to ask. */
function Starts() {
  const a = useAgent();
  const { ideas, about } = ideasNow();
  return html`<div class="ag-starts">
    <div class="ag-hello">
      <i>${a.pick ? html`<${AgentLogo} id=${a.pick} s=${20} />` : html`<${Icon} n="spark" s=${18} />`}</i>
      <b>Design with ${a.pick ? agentLabel(a.pick) : "an agent"}</b>
      <span>${about}</span>
    </div>
    <div class="ag-ideas">${ideas.map((t) => html`<button class="ag-idea" key=${t.label} title=${t.ask} onClick=${() => fillComposer(t.ask)}><${Icon} n="spark" s=${12} /><span>${t.label}</span></button>`)}</div>
  </div>`;
}

let composerEl = null;
function fillComposer(text) {
  if (!composerEl) return;
  composerEl.value = text;
  composerEl.dispatchEvent(new Event("input", { bubbles: true }));
  composerEl.focus();
}

function Thread({ t }) {
  const box = useRef();
  const stick = useRef(true);
  // Follow the newest words, unless the person scrolled up to read.
  useLayoutEffect(() => {
    const el = box.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  });
  return html`<div class="ag-thread" ref=${box} onScroll=${(e) => (stick.current = e.target.scrollHeight - e.target.scrollTop - e.target.clientHeight < 40)}>
    ${t.messages.map((m, i) =>
      m.role === "user"
        ? html`<div class="ag-you" key=${m.id}>${m.text}</div>`
        : html`<${Reply} key=${m.id} m=${m} last=${i === t.messages.length - 1} onRetry=${() => sendMessage([...t.messages].reverse().find((x) => x.role === "user")?.text ?? "")} />`,
    )}
  </div>`;
}

const secs = (a, b) => {
  const s = Math.max(1, Math.round((new Date(b ?? Date.now()) - new Date(a)) / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
};

/** A step's icon, from the tool it used. */
const STEP_ICON = { board_read: "eye", board_screenshot: "camera", board_write_html: "plus", board_edit: "sliders", board_done: "check", board_export: "export", board_import_website: "globe", board_import_figma: "frame", board_list: "grid", board_create: "plus", board_comment: "comment", board_comments: "comment", shell: "code", bash: "code" };
const stepIcon = (name = "") => STEP_ICON[name.replace(/^mcp__screenshotter__|^screenshotter[_.:]+/i, "")] ?? "dots";

/** An agent's words with the little formatting they use: paragraphs, lists, **bold** and `code`. */
function Prose({ text }) {
  const inline = (t, k) =>
    t.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).map((bit, i) =>
      bit.startsWith("**") && bit.endsWith("**") ? html`<b key=${`${k}${i}`}>${bit.slice(2, -2)}</b>` : bit.startsWith("`") && bit.endsWith("`") ? html`<code key=${`${k}${i}`}>${bit.slice(1, -1)}</code>` : bit,
    );
  const blocks = text.trim().split(/\n{2,}/);
  return html`<div class="ag-answer">${blocks.map((b, i) => {
    const lines = b.split("\n");
    if (lines.every((l) => /^\s*([-*•]|\d+[.)])\s+/.test(l))) return html`<ul key=${i}>${lines.map((l, j) => html`<li key=${j}>${inline(l.replace(/^\s*([-*•]|\d+[.)])\s+/, ""), `${i}-${j}-`)}</li>`)}</ul>`;
    return html`<p key=${i}>${lines.map((l, j) => html`${j ? html`<br />` : ""}${inline(l.replace(/^#+\s*/, ""), `${i}-${j}-`)}`)}</p>`;
  })}</div>`;
}

/** An agent's reply: who it is, what it did (folded once it's done), and what it says. */
function Reply({ m, last, onRetry }) {
  const [open, setOpen] = useState(false);
  const live = m.status === "working";
  // The answer is the last words after its last step; everything before is how it got there.
  const lastTool = m.parts.map((p) => p.kind).lastIndexOf("tool");
  const tail = m.parts.slice(lastTool + 1).filter((p) => p.kind === "text" && p.text.trim());
  const answer = live ? null : tail.map((p) => p.text.trim()).join("\n\n");
  const steps = live ? m.parts : m.parts.slice(0, lastTool + 1);
  const toolCount = steps.filter((p) => p.kind === "tool").length;
  const [, tick] = useState(0);
  useEffect(() => {
    if (!live) return;
    const i = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(i);
  }, [live]);
  const shown = live ? steps.slice(-6) : steps;
  // The steps that changed the board, not the ones that only looked at it.
  const changes = steps.filter((p) => p.kind === "tool" && /write_html|board_edit|import|board_create/.test(p.name ?? ""));
  const [copied, setCopied] = useState(false);
  const copy = () => navigator.clipboard.writeText(answer ?? "").then(() => (setCopied(true), setTimeout(() => setCopied(false), 1400)));
  return html`<div class="ag-reply">
    <div class="ag-who"><${AgentLogo} id=${m.agent} s=${12} /><span>${agentLabel(m.agent)}</span></div>
    ${(live || steps.length > 0) &&
    html`<button class="ag-worked ${live ? "live" : ""}" onClick=${() => !live && setOpen(!open)} disabled=${live}>
      ${live ? html`<span class="ag-live"></span><span class="ag-shimmer">Working</span><span>· ${secs(m.startedAt)}</span>` : html`Worked for ${secs(m.startedAt, m.endedAt)}${toolCount ? ` · ${toolCount} step${toolCount === 1 ? "" : "s"}` : ""}<${Icon} n=${open ? "down" : "right"} s=${11} w=${2.2} />`}
    </button>`}
    ${(live || open) &&
    shown.length > 0 &&
    html`<div class="ag-steps">
      ${shown.map((p) => (p.kind === "tool" ? html`<span class="ag-step" key=${p.id}><${Icon} n=${stepIcon(p.name)} s=${12} />${p.label}</span>` : p.text.trim() && html`<span class="ag-note" key=${p.id}>${p.text.trim()}</span>`))}
    </div>`}
    ${!live && changes.length > 0 &&
    html`<div class="ag-card">
      ${changes.slice(0, 4).map((p) => html`<span class="ag-change" key=${p.id}><${Icon} n=${stepIcon(p.name)} s=${12} /><span class="ellipsis">${p.label}</span></span>`)}
      <div class="ag-card-foot"><span>${changes.length} change${changes.length === 1 ? "" : "s"}${changes.length > 4 ? `, ${changes.length - 4} more in the steps` : ""}</span><button class="ag-undo" title="Undo the last change (⌘Z)" onClick=${() => window.studio?.command("undo")}><${Icon} n="undo" s=${11} />Undo</button></div>
    </div>`}
    ${answer && html`<${Prose} text=${answer} />`}
    ${m.status === "error" && html`<div class="ag-error">${m.error ?? "The agent stopped."}</div>`}
    ${m.status === "stopped" && html`<div class="ag-stopped">Stopped.</div>`}
    ${last &&
    !live &&
    html`<div class="ag-actions">
      ${answer && html`<button class="icon-btn sm" title=${copied ? "Copied" : "Copy"} onClick=${copy}><${Icon} n=${copied ? "check" : "copy"} s=${13} /></button>`}
      <button class="icon-btn sm" title="Try again" onClick=${onRetry}><${Icon} n="refresh" s=${13} /></button>
    </div>`}
    ${last && !live && m.status !== "error" &&
    html`<div class="ag-next">${ideasNow().ideas.map((t) => html`<button class="ag-chip" key=${t.label} title=${t.ask} onClick=${() => fillComposer(t.ask)}>${t.label}</button>`)}</div>`}
  </div>`;
}

function Composer() {
  const a = useAgent();
  const [text, setText] = useState(() => remembered(`chat:draft:${B.id}`) ?? "");
  const [busy, setBusy] = useState(false);
  const [picking, setPicking] = useState(false);
  const field = useRef();
  const pickBtn = useRef();
  const run = working(a.thread);
  useEffect(() => {
    composerEl = field.current;
    return () => (composerEl = null);
  }, []);
  const grow = () => {
    const el = field.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(180, el.scrollHeight)}px`;
  };
  useLayoutEffect(grow, [text]);
  const go = async () => {
    const t = text.trim();
    if (!t || busy || run || !a.pick) return;
    setBusy(true);
    const ok = await sendMessage(t);
    setBusy(false);
    if (ok) {
      setText("");
      remember(`chat:draft:${B.id}`, null);
    }
  };
  const stopIt = () => api("/api/chat/stop", { id: A.open }).then(() => setTimeout(follow, 300)).catch((e) => fail(e, "Couldn't stop it"));
  return html`<div class="ag-composer">
    <textarea ref=${field} rows="1" placeholder=${a.thread?.messages.length ? "Ask for a change" : "What should we design?"} value=${text} spellcheck=${true}
      onInput=${(e) => {
        setText(e.target.value);
        remember(`chat:draft:${B.id}`, e.target.value || null);
      }}
      onKeyDown=${(e) => {
        e.stopPropagation();
        if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
          e.preventDefault();
          go();
        }
      }}></textarea>
    <div class="ag-row">
      <button class="ag-pick" ref=${pickBtn} disabled=${!a.agents?.length} onClick=${() => setPicking(!picking)} title="Which agent">
        ${a.pick && html`<${AgentLogo} id=${a.pick} s=${12} />`}<span>${a.pick ? agentLabel(a.pick) : "…"}</span><${Icon} n="down" s=${10} w=${2.2} />
      </button>
      ${B.sel.length > 0 && html`<span class="ag-ctx" title="The agent is told what you have selected"><${Icon} n=${B.sel.length === 1 && node(B.sel[0]) ? layerIcon(node(B.sel[0])) : "layers"} s=${11} /><span>${B.sel.length === 1 ? (node(B.sel[0])?.name ?? "Layer") : `${B.sel.length} layers`}</span></span>`}
      <span class="grow"></span>
      ${run
        ? html`<button class="ag-send stop" title="Stop" onClick=${stopIt}><i></i></button>`
        : html`<button class="ag-send" title="Send (Enter)" disabled=${!text.trim() || busy || !a.pick} onClick=${go}><${Icon} n="up" s=${14} w=${2.4} /></button>`}
    </div>
    ${picking &&
    html`<${Popover} anchor=${pickBtn.current} onClose=${() => setPicking(false)} width=${220} align="start">
      <div class="bd-menu">
        ${a.agents.map(
          (x) => html`<button class="ctx-item" onClick=${() => {
            A.pick = x.id;
            remember("agent:pick", x.id);
            setPicking(false);
            emit();
          }}><span class="ctx-ico"><${AgentLogo} id=${x.id} s=${13} /></span><span class="ctx-label">${x.label}</span>${a.pick === x.id && html`<${Icon} n="check" s=${13} />`}</button>`,
        )}
      </div>
    <//>`}
  </div>`;
}

function NoAgents() {
  return html`<div class="ag ag-none">
    <b>No agents on this Mac yet</b>
    <p>The Agent tab works with Claude Code, Codex, opencode or Antigravity, on your own subscription. Install one, sign in once in Terminal, then come back.</p>
    <div class="ag-links">
      ${[
        ["claude", "Claude Code", "https://claude.com/claude-code"],
        ["codex", "Codex", "https://developers.openai.com/codex/cli"],
        ["opencode", "opencode", "https://opencode.ai"],
      ].map(([id, label, url]) => html`<a href=${url} target="_blank"><${AgentLogo} id=${id} s=${13} />${label}</a>`)}
    </div>
    <button class="btn sm" onClick=${() => ((A.agents = null), loadAgents())}>Look again</button>
  </div>`;
}
