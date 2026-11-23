// Agents on the board, live: each agent at work has a cursor in its own colour, with its name and
// what it's doing, that glides to what it just touched (each layer flashing in its colour as the
// cursor reaches it), the artboard it's on marked in that colour, and an avatar over the canvas.
// An agent stays while Agentman says it's still at work (thinking, rendering, running a command
// between board moves), not only for a while after its last move. Click an avatar to follow that
// agent: the view goes to each change as it lands. Zooming keeps it (and the view keeps your zoom);
// moving the view away from where the agent is working, Esc, or Stop ends it.
import { useEffect, useRef, useState } from "preact/hooks";
import { pageOf, rootOf } from "./board-core.js";
import { B, bset, useBoard } from "./board-state.js";
import { canvasEl, centerOn, elOf, followGliding, frameBox, worldBox } from "./board-canvas.js";
import { html } from "./controls.js";
import { faceOf } from "./avatars.js";
import { AgentLogo, logoFor } from "./agent-logos.js";

/** After its last move, an agent Agentman can't vouch for stays this long (it may be thinking). */
const GRACE_MS = 3 * 60_000;
/** An agent Agentman says is idle (its turn over) leaves this long after its last move. */
const IDLE_MS = 45_000;
/** Within this long of its last move an agent reads as "at work"; after it, "thinking". */
const LIVE_MS = 12_000;
const FADE_MS = 6_000;
/** The cursor visits each layer a move touched, this long on each (quicker for a big write, so the walk takes at most about 4 s). */
const stepOf = (p) => Math.max(70, Math.min(260, 4200 / Math.max(1, p.ids?.length ?? 1)));
const COLOURS = ["#7c6cff", "#f0508c", "#1ba7c4", "#e8890c", "#2f9e57", "#e2603f", "#4c6ef5", "#b350d6"];
const VERBS = { edit: "changing", write: "adding", import: "bringing in", look: "looking at", read: "reading" };

/** The arrow someone else's pointer is drawn as, in their colour (--c): on the canvas, and wherever a cursor is shown. */
export const CursorArrow = () => html`<svg width="18" height="20" viewBox="0 0 18 20"><path d="M1.5 1.5l13.6 7.1-6 1.4-2.9 5.8z" fill="var(--c)" stroke="#fff" stroke-width="1.6" stroke-linejoin="round" /></svg>`;
/**
 * The colour teammates see someone's cursor in. The collaboration server picks it from the
 * person's id (server/src/live.ts: the same list, the same sum), so this is the colour they'll get.
 */
const PEER_COLOURS = ["#e5484d", "#f76b15", "#ffb224", "#46a758", "#12a594", "#0090ff", "#3e63dd", "#8e4ec6", "#d6409f", "#ab4aba"];
export const peerColourOf = (id) => PEER_COLOURS[[...String(id ?? "")].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) >>> 0, 7) % PEER_COLOURS.length];

export function colourOf(key) {
  let h = 0;
  for (const ch of String(key)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return COLOURS[h % COLOURS.length];
}

const age = (p) => Date.now() - Date.parse(p.at);
/**
 * How long since the Studio first saw a move (it reaches the Studio up to a poll after it's made):
 * the cursor's walk and the build-in run from then, so none of their first steps are skipped.
 */
const firstSeen = new Map();
function since(p) {
  const k = `${p.key}@${p.at}`;
  if (!firstSeen.has(k)) {
    firstSeen.set(k, Date.now());
    if (firstSeen.size > 200) firstSeen.delete(firstSeen.keys().next().value);
  }
  return Date.now() - firstSeen.get(k);
}
/** How long an agent may stay on the board, by what Agentman says it's doing. */
function stayMs(p) {
  if (p.state === "ended") return 0;
  if (p.state === "busy" || p.state === "waiting_input") return Infinity;
  if (p.state === "idle") return IDLE_MS;
  return GRACE_MS;
}
/** The agents on the board now, the most recent first. */
export const activeAgents = () => (B.presence ?? []).filter((p) => age(p) < stayMs(p)).sort((a, b) => b.at.localeCompare(a.at));

/** "at work" just after a move; "thinking" (or "waiting for you") between moves. */
function phaseOf(p) {
  if (p.state === "waiting_input") return "waiting";
  return age(p) < LIVE_MS ? "live" : "thinking";
}

const drawn = (p) => (p.ids ?? []).filter((id) => B.board?.nodes[id] && pageOf(B.board, id)?.id === B.page);
const union = (boxes) => {
  if (!boxes.length) return null;
  const x = Math.min(...boxes.map((b) => b.x)), y = Math.min(...boxes.map((b) => b.y));
  return { x, y, width: Math.max(...boxes.map((b) => b.x + b.width)) - x, height: Math.max(...boxes.map((b) => b.y + b.height)) - y };
};
/** The box around what an agent touched, on the page showing (board units), or null. */
const boxOf = (p) => union(drawn(p).map(worldBox).filter(Boolean));
/** Where the cursor points: inside the box near its top left, not off in a big artboard's middle. */
const tipOf = (box) => ({ x: box.x + Math.min(box.width / 2, 36), y: box.y + Math.min(box.height / 2, 24) });

/** The artboards each agent is on now (where its latest move was), for their marks: id → agent. */
export function agentArtboards() {
  const out = new Map();
  for (const p of activeAgents().slice().reverse()) for (const id of p.ids ?? []) if (B.board?.nodes[id]) out.set(rootOf(B.board, id), p);
  return out;
}

/** Moves whose new layers have been built in already. */
const built = new Set();

const ago = (ms) => (ms < 5000 ? "just now" : ms < 60_000 ? `${Math.round(ms / 1000)} s ago` : `${Math.round(ms / 60_000)} min ago`);
/** What the agent is doing, in a few words: "changing Title and 3 more", "thinking", "waiting for you". */
function doingNow(p) {
  const phase = phaseOf(p);
  if (phase === "waiting") return "waiting for you";
  if (phase === "thinking") return `thinking · ${Math.round(age(p) / 1000)} s`;
  const ids = p.ids ?? [];
  // While the cursor walks a move's layers, it names the one it's on.
  const step = ids.length > 1 ? Math.floor(since(p) / stepOf(p)) : -1;
  if (step >= 0 && step < ids.length && B.board?.nodes[ids[step]]) return `${VERBS[p.doing] ?? "working on"} ${B.board.nodes[ids[step]].name}`;
  const n = ids.map((id) => B.board?.nodes[id]?.name).filter(Boolean);
  const what = n.length > 1 ? `${n[0]} and ${n.length - 1} more` : n[0] ?? "the board";
  return `${VERBS[p.doing] ?? "working on"} ${what}`;
}
const describe = (p) => `${p.name} · ${doingNow(p)}${phaseOf(p) === "live" ? ` · ${ago(age(p))}` : ""}`;

/** The zoom the person chose while following (null: each change is framed at a zoom that suits it). */
let followZoom = null;

/** Go with an agent's latest move: its page, then a view that frames what it touched (at the person's zoom, if they set one). */
function bringIntoView(p) {
  const id = (p.ids ?? []).find((x) => B.board?.nodes[x]);
  if (!id) return;
  const pg = pageOf(B.board, id);
  if (pg && pg.id !== B.page) {
    bset({ page: pg.id, sel: [], hover: null });
    requestAnimationFrame(() => requestAnimationFrame(() => bringIntoView(p)));
    return;
  }
  const box = boxOf(p);
  const first = drawn(p).map(worldBox).find(Boolean);
  frameBox(box, { zoom: followZoom, focus: first && tipOf(first) });
}

/** Whether the view is still on what the agent is doing: a good part of it showing, or it filling the view. */
function watching(p) {
  const box = boxOf(p), c = canvasEl.current?.getBoundingClientRect();
  if (!box || !c) return true;
  const { x, y, z } = B.view;
  const l = Math.max(0, box.x * z + x), t = Math.max(0, box.y * z + y), r = Math.min(c.width, (box.x + box.width) * z + x), btm = Math.min(c.height, (box.y + box.height) * z + y);
  const seen = Math.max(0, r - l) * Math.max(0, btm - t);
  return seen >= box.width * z * box.height * z * 0.15 || seen >= c.width * c.height * 0.25;
}

/** Display name for a live teammate peer. */
function peerName(p) {
  const n = p.user?.name?.trim();
  if (n) return n.split(/\s+/)[0];
  return (p.user?.email ?? "Teammate").split("@")[0];
}
const peerFull = (p) => (p.user?.name ? `${p.user.name} (${p.user.email})` : p.user?.email ?? "Teammate");

function bringPeerIntoView(p) {
  const pr = p.presence;
  if (!pr) return;
  if (pr.page && pr.page !== B.page && B.board?.pages.some((pg) => pg.id === pr.page)) {
    bset({ page: pr.page, sel: [], hover: null });
    requestAnimationFrame(() => requestAnimationFrame(() => bringPeerIntoView(p)));
    return;
  }
  if (pr.cursor) return centerOn(pr.cursor);
  const firstSel = (pr.selection ?? []).map(worldBox).find(Boolean);
  if (firstSel) frameBox(firstSel, { zoom: followZoom });
}

export function follow(key) {
  followZoom = null;
  bset({ following: key });
  if (String(key).startsWith("peer:")) {
    const id = String(key).slice(5);
    const peer = (B.peers ?? []).find((x) => x.id === id);
    if (peer) bringPeerIntoView(peer);
    return;
  }
  const p = (B.presence ?? []).find((x) => x.key === key);
  if (p) bringIntoView(p);
}
export const unfollow = () => B.following && bset({ following: null });

/** The cursors, in the board's own space (so panning and zooming carry them), each gliding when its agent or teammate moves. */
export function Presence() {
  const b = useBoard();
  const [, tick] = useState(0);
  const agents = activeAgents();
  const peers = b.peers ?? [];
  // A move that touched several layers: the cursor steps through them, so the work reads as it was done.
  const stepping = agents.some((p) => (p.ids?.length ?? 0) > 1 && since(p) < (p.ids.length + 1) * stepOf(p));
  useEffect(() => {
    if (!agents.length) return;
    const t = setInterval(() => tick((n) => n + 1), stepping ? 60 : 1000);
    return () => clearInterval(t);
  }, [agents.length > 0, stepping]);
  // A fresh write builds in: each new layer fades up as the cursor reaches it (once per move, not on load).
  useEffect(() => {
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    for (const p of agents) {
      const tag = `${p.key}@${p.at}`;
      if (p.doing !== "write" || built.has(tag) || age(p) > 4000) continue;
      built.add(tag);
      const st = stepOf(p);
      drawn(p).forEach((id, i) => elOf(id)?.animate?.([{ opacity: 0, transform: "translateY(6px)" }, { opacity: 1, transform: "none" }],
        { duration: 380, delay: Math.max(0, i * st - since(p)), easing: "cubic-bezier(0.16, 1, 0.3, 1)", fill: "backwards" }));
    }
  }, [agents.map((p) => p.at).join()]);
  // Following a teammate: follow their cursor or page changes.
  const followedPeer = String(b.following ?? "").startsWith("peer:") ? peers.find((p) => p.id === String(b.following).slice(5)) : null;
  const fpCur = followedPeer?.presence?.cursor ? `${followedPeer.presence.page ?? ""}:${followedPeer.presence.cursor.x},${followedPeer.presence.cursor.y}` : followedPeer?.presence?.page ?? "";
  useEffect(() => {
    if (!followedPeer) return;
    bringPeerIntoView(followedPeer);
  }, [followedPeer?.id, fpCur]);
  // Following: each new move of that agent is framed; an agent that has finished stops it; you taking over stops it.
  const followed = (b.presence ?? []).find((p) => p.key === b.following);
  useEffect(() => {
    if (!followed || age(followed) >= stayMs(followed)) return;
    // A look (a screenshot, a read) moves the view only when what it looks at is out of sight: looking isn't changing.
    if (["look", "read"].includes(followed.doing) && watching(followed)) return;
    bringIntoView(followed);
  }, [followed?.at]);
  // While the cursor walks a move's layers, the view keeps the one it's on in sight, at the zoom it's at.
  const walk = followed && b.following && (followed.ids?.length ?? 0) > 1 ? Math.floor(since(followed) / stepOf(followed)) : -1;
  useEffect(() => {
    if (walk < 1 || followGliding()) return;
    const ids = drawn(followed);
    const r = walk < ids.length ? worldBox(ids[walk]) : null;
    if (r) frameBox(r, { zoom: B.view.z, ms: 420, focus: tipOf(r) });
  }, [walk]);
  useEffect(() => {
    if (b.following && followed?.state === "ended") unfollow();
  }, [followed?.state]);
  // The person moving the view: a zoom is kept (it becomes the zoom the view follows at); a move that
  // takes the view off what the agent is doing ends the follow. The view's own glides don't count.
  const lastZ = useRef(b.view.z);
  useEffect(() => {
    const zoomed = Math.abs(b.view.z - lastZ.current) > 1e-4;
    lastZ.current = b.view.z;
    if (!b.following || followGliding()) return;
    if (zoomed) followZoom = b.view.z;
    if (followed && agents.some((p) => p.key === followed.key) && !watching(followed)) unfollow();
  }, [b.view.x, b.view.y, b.view.z]);
  useEffect(() => {
    if (!b.following) return;
    const key = (e) => e.key === "Escape" && unfollow();
    addEventListener("keydown", key, true);
    return () => removeEventListener("keydown", key, true);
  }, [b.following]);
  const visiblePeers = peers.filter((p) => p.presence && (!p.presence.page || p.presence.page === b.page));
  if (!b.board || (!agents.length && !visiblePeers.length)) return null;
  const { x, y, z } = b.view;
  return html`<div class="bd-presence" aria-hidden="true" style=${{ transform: `translate(${x}px, ${y}px) scale(${z})` }}>
    ${visiblePeers.map((p) => {
      const c = p.color || colourOf(p.user?.id || p.id);
      const selBoxes = (p.presence?.selection ?? []).map((id) => [id, worldBox(id)]).filter(([, r]) => r);
      const cur = p.presence?.cursor;
      const label = peerName(p);
      return html`<div key=${`peer-${p.id}`} class="bd-peer-mark" style=${{ "--c": c, "--inv": 1 / z }}>
        ${selBoxes.map(([id, r], i) => html`<div key=${id} class="bd-peer-sel" style=${{ left: r.x + "px", top: r.y + "px", width: r.width + "px", height: r.height + "px" }}>
          ${i === 0 && html`<span class="bd-peer-tag">${label}</span>`}
        </div>`)}
        ${cur && html`<div class="bd-cursor bd-peer-cursor" data-peer=${p.id} style=${{ left: cur.x + "px", top: cur.y + "px" }}>
          <div class="bd-cursor-in">
            <${CursorArrow} />
            <span class="bd-cursor-name"><b>${label}</b>${p.agent && html`<span class="bd-cursor-doing">${p.agent}</span>`}</span>
          </div>
        </div>`}
      </div>`;
    })}
    ${agents.map((p) => {
      const ids = drawn(p);
      const boxes = ids.map((id) => [id, worldBox(id)]).filter(([, r]) => r);
      if (!boxes.length) return null;
      // Which layer the cursor is on: it walks the touched layers in order, then rests on the first.
      const step = Math.floor(since(p) / stepOf(p));
      const walking = boxes.length > 1 && step < boxes.length;
      const at = walking ? boxes[Math.min(step, boxes.length - 1)][1] : union(boxes.map(([, r]) => r));
      const tip = tipOf(walking ? at : boxes[0][1]);
      const left = stayMs(p) - age(p);
      const fade = left < FADE_MS ? Math.max(0, left / FADE_MS) : 1;
      const phase = phaseOf(p);
      const c = colourOf(p.key);
      return html`<div key=${p.key} class="bd-agent-mark ${phase}" style=${{ "--c": c, "--inv": 1 / z, opacity: fade }}>
        ${boxes.slice(0, walking ? step + 1 : boxes.length).map(([id, r], i) => html`<div key=${p.at + id} class="bd-agent-flash" style=${{ left: r.x + "px", top: r.y + "px", width: r.width + "px", height: r.height + "px", animationDelay: walking ? "0s" : `${Math.min(i, 12) * 40}ms`, animationDuration: walking ? `${Math.max(0.45, (stepOf(p) * 5) / 1000)}s` : undefined }}></div>`)}
        <div class="bd-cursor" data-agent=${p.key} style=${{ left: tip.x + "px", top: tip.y + "px" }}>
          <div class="bd-cursor-in">
            <${CursorArrow} />
            <span class="bd-cursor-name"><b>${p.name}</b><span class="bd-cursor-doing">${phase === "thinking" ? html`thinking<i class="bd-dots"><i></i><i></i><i></i></i>` : doingNow(p)}</span></span>
          </div>
        </div>
      </div>`;
    })}
  </div>`;
}

/** The teammates and agents on the board as avatars over the canvas: click one to follow, again to stop. */
export function PresenceBar() {
  const b = useBoard(["view", "hover", "guides", "drop", "words"]);
  const agents = activeAgents();
  const peers = b.peers ?? [];
  const followedAgent = (b.presence ?? []).find((p) => p.key === b.following);
  const followedPeer = String(b.following ?? "").startsWith("peer:") ? peers.find((p) => p.id === String(b.following).slice(5)) : null;
  const following = Boolean(b.following && (followedAgent || followedPeer));
  if (!b.board || (!agents.length && !peers.length && !following)) return null;
  const here = followedAgent && agents.some((p) => p.key === followedAgent.key);
  const followColor = followedPeer ? followedPeer.color || colourOf(followedPeer.user?.id || followedPeer.id) : followedAgent ? colourOf(followedAgent.key) : "#7c6cff";
  return html`${following && html`<div class="bd-follow-frame" style=${{ "--c": followColor }}></div>`}<div class="bd-presence-bar" onPointerDown=${(e) => e.stopPropagation()}>
    ${following &&
    html`<span class="bd-following" style=${{ "--c": followColor }}>
      <span class="bd-following-t">Following <b>${followedPeer ? peerName(followedPeer) : followedAgent.name}</b>
        ${followedAgent && html`<span class="bd-following-doing">${here ? doingNow(followedAgent) : "waiting for its next move"}</span>`}</span>
      <button class="bd-link" onClick=${unfollow}>Stop</button></span>`}
    ${peers.map((p) => {
      const fkey = `peer:${p.id}`;
      const c = p.color || colourOf(p.user?.id || p.id);
      const label = peerFull(p);
      const face = p.user?.image ? null : faceOf(p.user ?? { id: p.id });
      return html`<button key=${fkey} class="bd-avatar ${face ? "face" : ""} ${b.following === fkey ? "on" : ""}" style=${{ "--c": c, background: face?.tint }}
        title=${`${label}. ${b.following === fkey ? "Click to stop following" : "Click to follow"}`}
        aria-label=${b.following === fkey ? `Stop following ${label}` : `Follow ${label}`} aria-pressed=${b.following === fkey}
        onClick=${() => (b.following === fkey ? unfollow() : follow(fkey))}>
        ${face ? face.emoji : html`<img src=${p.user.image} alt="" />`}
      </button>`;
    })}
    ${agents.map((p) => html`<button key=${p.key} class="bd-avatar ${p.key === b.following ? "on" : ""} ${phaseOf(p)}" style=${{ "--c": colourOf(p.key) }}
        title=${`${describe(p)}. ${p.key === b.following ? "Click to stop following" : "Click to follow"}`}
        aria-label=${p.key === b.following ? `Stop following ${p.name}` : `Follow ${p.name}`} aria-pressed=${p.key === b.following}
        onClick=${() => (p.key === b.following ? unfollow() : follow(p.key))}><${AgentLogo} id=${logoFor(p.key, p.name)} s=${13} /></button>`)}
  </div>`;
}
