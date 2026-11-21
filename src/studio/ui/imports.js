// Bringing something in: a website or a Figma file, onto a new board (or the open one), with its
// progress as it goes. After it lands, the next step: what to ask your agent.
import { useEffect, useRef, useState } from "preact/hooks";
import { B, bset, openBoard, select } from "./board-state.js";
import { fit } from "./board-canvas.js";
import { html } from "./controls.js";
import { Icon } from "./icons.js";
import { AgentLogo } from "./agent-logos.js";
import { S, api, fail, native, set, touch, toast, useStore } from "./store.js";

/** Run an import with its progress (`onStep` gets { fraction, step }), then open what it made. */
export async function runImport(kind, body, onStep = () => undefined) {
  const job = Math.random().toString(36).slice(2, 12);
  onStep({ fraction: 0.02, step: kind === "figma" ? "Reading the file from Figma" : "Opening the page" });
  const poll = setInterval(async () => {
    try {
      const p = await api(`/api/progress?job=${job}`);
      if (p.fraction != null) onStep({ fraction: p.fraction, step: p.step });
    } catch {}
  }, 400);
  try {
    const r = await api(`/api/board/import-${kind === "figma" ? "figma" : "website"}?job=${job}`, body);
    const ids = kind === "figma" ? r.artboards.map((a) => a.id) : [r.artboard];
    await openBoard(r.board);
    requestAnimationFrame(() => {
      select(ids.slice(0, 1));
      fit(ids);
    });
    touch("started");
    touch(kind === "figma" ? "figma" : "website");
    // Next: ask an agent to change it.
    bset({ rightOpen: true, rightTab: "agent" });
    if (r.warnings?.length) toast({ kind: "warn", title: `Brought in ${r.name}`, text: r.warnings[0], timeout: 9000 });
    return r;
  } finally {
    clearInterval(poll);
  }
}

// ---------------------------------------------------------------------------------------------
// Figma

/** Ask for a Figma link to bring in: onto this board (`board`), or onto a new one named after the file. */
export function openImportFigma({ board = null, url = "" } = {}) {
  set({ modal: { kind: "importFigma", board, url }, menu: null });
}

export const looksLikeFigma = (text) => /^\s*(https?:\/\/)?(www\.)?figma\.com\/(file|design|proto)\/[A-Za-z0-9]+/i.test(text ?? "");

/** Keep a Figma token: for this run (the engine), and in the Keychain for the next (the Mac app). */
export async function saveFigmaToken(token) {
  await api("/api/figma-token", { token });
  await native?.call("setFigmaToken", { key: token }).catch(() => undefined);
}

export function ImportFigma() {
  const s = useStore();
  const m = s.modal;
  const [url, setUrl] = useState(m.url ?? "");
  const [token, setToken] = useState("");
  const [hasToken, setHasToken] = useState(null);
  const [busy, setBusy] = useState(null);
  const field = useRef();
  useEffect(() => {
    api("/api/figma")
      .then((r) => setHasToken(r.hasToken))
      .catch(() => setHasToken(false));
    field.current?.focus();
  }, []);
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
  const needsToken = hasToken === false;
  const ready = url.trim() && (!needsToken || token.trim());
  const go = async () => {
    if (!ready || busy) return;
    try {
      if (needsToken) await saveFigmaToken(token.trim());
      setBusy({ fraction: 0.02, step: "Reading the file from Figma" });
      await runImport("figma", { id: m.board ?? undefined, url: url.trim(), page: m.board && B.id === m.board ? B.page : undefined }, (p) => setBusy((b) => ({ fraction: p.fraction ?? b?.fraction ?? 0, step: p.step ?? b?.step })));
      set({ modal: null });
    } catch (e) {
      setBusy(null);
      fail(e, "Couldn't bring the Figma file in");
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
    <div class="sheet web-import" role="dialog" aria-label="Import from Figma">
      <div class="sheet-head"><h2>Import from Figma</h2><button class="icon-btn" title="Close (Esc)" disabled=${Boolean(busy)} onClick=${() => set({ modal: null })}><${Icon} n="x" s=${16} /></button></div>
      <div class="sheet-body">
        <p class="note">Paste a link to a file (its first page's frames come in) or to one frame (in Figma: right-click it › Copy link to selection). ${m.board ? "It goes beside the artboards on this board." : "It gets a board of its own."}</p>
        <label class="wi-url ${busy ? "off" : ""}">
          <${FigmaMark} />
          <input ref=${field} class="input grow" type="url" placeholder="figma.com/design/…" spellcheck=${false} autocomplete="off" value=${url} disabled=${Boolean(busy)} onInput=${(e) => setUrl(e.target.value)} onKeyDown=${onKey} aria-label="Figma link" />
        </label>
        ${needsToken &&
        html`<div class="fg-token">
          <label class="lbl" for="fg-token">Personal access token</label>
          <input id="fg-token" class="input mono" type="password" placeholder="figd_…" spellcheck=${false} autocomplete="off" value=${token} disabled=${Boolean(busy)} onInput=${(e) => setToken(e.target.value)} onKeyDown=${onKey} />
          <p class="note faint">Once only. In Figma: Settings › Security › Personal access tokens › Generate, with read access to files. It stays on this Mac${native ? ", in your Keychain" : ""}.</p>
        </div>`}
        ${busy
          ? html`<div class="wi-progress" aria-live="polite">
              <div class="wi-bar"><i style=${{ width: `${Math.round(busy.fraction * 100)}%` }}></i></div>
              <span>${busy.step}…</span>
            </div>`
          : !needsToken && html`<p class="note faint">Auto layout comes in as flex; text, fills, strokes, shadows, pictures and icons come with it.</p>`}
      </div>
      <div class="sheet-foot">
        <button class="btn" disabled=${Boolean(busy)} onClick=${() => set({ modal: null })}>Cancel</button>
        <button class="btn primary" disabled=${!ready || Boolean(busy)} onClick=${go}>${busy ? html`<span class="spinner dark"></span>Importing` : "Import"}</button>
      </div>
    </div>
  </div>`;
}

/** Figma's mark, in its own colours: people know it on sight. */
export const FigmaMark = ({ s = 15 }) => html`<svg width=${s * 0.67} height=${s} viewBox="0 0 38 57" aria-hidden="true" style=${{ flex: "none" }}>
  <path fill="#1abcfe" d="M19 28.5a9.5 9.5 0 1 1 19 0 9.5 9.5 0 0 1-19 0z" /><path fill="#0acf83" d="M0 47.5A9.5 9.5 0 0 1 9.5 38H19v9.5a9.5 9.5 0 1 1-19 0z" />
  <path fill="#ff7262" d="M19 0v19h9.5a9.5 9.5 0 1 0 0-19H19z" /><path fill="#f24e1e" d="M0 9.5A9.5 9.5 0 0 0 9.5 19H19V0H9.5A9.5 9.5 0 0 0 0 9.5z" />
  <path fill="#a259ff" d="M0 28.5A9.5 9.5 0 0 0 9.5 38H19V19H9.5A9.5 9.5 0 0 0 0 28.5z" /></svg>`;

// ---------------------------------------------------------------------------------------------
// Agents: connecting one, and whether one is connected

/** How to add this copy of the app to an agent: its MCP server's name and command come from the engine. */
export function agentSetups() {
  const name = S.opts?.mcpName ?? "screenshotter";
  const [command, ...args] = S.opts?.mcpCommand ?? ["/Applications/Screenshotter.app/Contents/MacOS/Screenshotter", "mcp"];
  const line = [command, ...args].map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(" ");
  const config = JSON.stringify({ command, args });
  return [
    { id: "claude", label: "Claude Code", cmd: `claude mcp add ${name} --scope user -- ${line}`, how: "Run it in Terminal, then start a new Claude Code session." },
    { id: "codex", label: "Codex", cmd: `codex mcp add ${name} -- ${line}`, how: "Run it in Terminal, then start Codex again." },
    {
      id: "cursor",
      label: "Cursor",
      cmd: JSON.stringify({ mcpServers: { [name]: { command, args } } }, null, 2),
      how: "Add it in one click, or put this in ~/.cursor/mcp.json.",
      link: `cursor://anysphere.cursor-deeplink/mcp/install?name=${encodeURIComponent(name)}&config=${btoa(config)}`,
    },
    { id: "other", label: "Other", cmd: line, how: "Any agent that speaks MCP: add a server that runs this command." },
  ];
}

/** The agents connected now, checked every couple of seconds while something shows it. */
export function useConnectedAgents() {
  const [agents, setAgents] = useState(null);
  useEffect(() => {
    let live = true;
    const check = () =>
      api("/api/agents-connected")
        .then((r) => {
          if (!live) return;
          setAgents(r.agents ?? []);
          if (r.agents?.length) touch("agent");
        })
        .catch(() => live && setAgents([]));
    check();
    const t = setInterval(() => document.visibilityState === "visible" && check(), 2500);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, []);
  return agents;
}

export function AgentStatus({ agents }) {
  if (agents === null) return html`<span class="agent-status"><span class="spinner"></span></span>`;
  if (!agents.length) return html`<span class="agent-status waiting"><i></i>Waiting for your agent</span>`;
  const names = [...new Set(agents.map((a) => a.label))];
  return html`<span class="agent-status ok"><i></i>${names.join(" and ")} ${names.length > 1 ? "are" : "is"} connected</span>`;
}

const copy = (text, what = "Copied") =>
  (native ? native.call("copyText", { text }) : navigator.clipboard.writeText(text)).then(
    () => toast({ kind: "ok", icon: "copy", title: what, timeout: 2600 }),
    (e) => fail(e, "Couldn't copy it"),
  );

/** How to connect an agent: one tab per agent, its command to copy (or a one-click install). */
export function ConnectAgent({ compact = false }) {
  const agents = useConnectedAgents();
  const [pick, setPick] = useState(() => {
    try {
      return localStorage.getItem("agent:setup") || "claude";
    } catch {
      return "claude";
    }
  });
  const setups = agentSetups();
  const a = setups.find((x) => x.id === pick) ?? setups[0];
  const choose = (id) => {
    setPick(id);
    try {
      localStorage.setItem("agent:setup", id);
    } catch {}
  };
  return html`<div class="connect ${compact ? "compact" : ""}">
    <div class="connect-head">
      <div class="connect-tabs" role="tablist">${setups.map((x) => html`<button role="tab" aria-selected=${x.id === a.id} class=${x.id === a.id ? "on" : ""} onClick=${() => choose(x.id)}><${AgentLogo} id=${x.id} s=${13} />${x.label}</button>`)}</div>
      <${AgentStatus} agents=${agents} />
    </div>
    <div class="connect-cmd">
      <pre class="mono">${a.cmd}</pre>
      <div class="connect-actions">
        ${a.link && html`<button class="btn sm primary" onClick=${() => (native ? native.call("openURL", { url: a.link }) : window.open(a.link))}>Add to ${a.label}</button>`}
        <button class="btn sm" onClick=${() => copy(a.cmd, "Copied the setup")}><${Icon} n="copy" s=${13} />Copy</button>
      </div>
    </div>
    <p class="connect-how">${a.how}</p>
  </div>`;
}
