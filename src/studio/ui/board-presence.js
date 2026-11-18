// Agents on the board, live: each agent at work has a cursor in its own colour, with its name and
// what it's doing, that glides to what it just touched (each layer flashing in its colour as the
// cursor reaches it), the artboard it's on marked in that colour, and an avatar over the canvas.
// An agent stays while Agentman says it's still at work (thinking, rendering, running a command
// between board moves), not only for a while after its last move. Click an avatar to follow that
// agent: the view goes to each change as it lands. Zooming keeps it (and the view keeps your zoom);
// moving the view away from where the agent is working, Esc, or Stop ends it.
import { useEffect, useRef, useState } from "preact/hooks";
import { pageOf, rootOf } from "./board-core.js";
import { B, bset } from "./board-state.js";
import { canvasEl, followGliding, frameBox, worldBox } from "./board-canvas.js";
import { html } from "./controls.js";

/** After its last move, an agent Agentman can't vouch for stays this long (it may be thinking). */
const GRACE_MS = 3 * 60_000;
/** An agent Agentman says is idle (its turn over) leaves this long after its last move. */
const IDLE_MS = 45_000;
/** Within this long of its last move an agent reads as "at work"; after it, "thinking". */
const LIVE_MS = 12_000;
const FADE_MS = 6_000;
/** The cursor visits each layer a move touched, this long on each. */
const STEP_MS = 260;
const COLOURS = ["#7c6cff", "#f0508c", "#1ba7c4", "#e8890c", "#2f9e57", "#e2603f", "#4c6ef5", "#b350d6"];
const VERBS = { edit: "changing", write: "adding", import: "bringing in", look: "looking at", read: "reading" };

export function colourOf(key) {
  let h = 0;
  for (const ch of String(key)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return COLOURS[h % COLOURS.length];
}

const age = (p) => Date.now() - Date.parse(p.at);
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

const ago = (ms) => (ms < 5000 ? "just now" : ms < 60_000 ? `${Math.round(ms / 1000)} s ago` : `${Math.round(ms / 60_000)} min ago`);
/** What the agent is doing, in a few words: "changing Title and 3 more", "thinking", "waiting for you". */
function doingNow(p) {
  const phase = phaseOf(p);
  if (phase === "waiting") return "waiting for you";
  if (phase === "thinking") return `thinking · ${Math.round(age(p) / 1000)} s`;
  const n = (p.ids ?? []).map((id) => B.board?.nodes[id]?.name).filter(Boolean);
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

export function follow(key) {
  followZoom = null;
  bset({ following: key });
  const p = (B.presence ?? []).find((x) => x.key === key);
  if (p) bringIntoView(p);
}
export const unfollow = () => B.following && bset({ following: null });

/** The cursors, in the board's own space (so panning and zooming carry them), each gliding when its agent moves. */
export function Presence() {
  const b = B;
  const [, tick] = useState(0);
  const agents = activeAgents();
  // A move that touched several layers: the cursor steps through them, so the work reads as it was done.
  const stepping = agents.some((p) => (p.ids?.length ?? 0) > 1 && age(p) < (p.ids.length + 1) * STEP_MS);
  useEffect(() => {
    if (!agents.length) return;
    const t = setInterval(() => tick((n) => n + 1), stepping ? STEP_MS / 2 : 1000);
    return () => clearInterval(t);
  }, [agents.length > 0, stepping]);
  // Following: each new move of that agent is framed; an agent that has finished stops it; you taking over stops it.
  const followed = (b.presence ?? []).find((p) => p.key === b.following);
  useEffect(() => {
    if (followed && age(followed) < stayMs(followed)) bringIntoView(followed);
  }, [followed?.at]);
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
  if (!b.board || !agents.length) return null;
  const { x, y, z } = b.view;
  return html`<div class="bd-presence" aria-hidden="true" style=${{ transform: `translate(${x}px, ${y}px) scale(${z})` }}>
    ${agents.map((p) => {
      const ids = drawn(p);
      const boxes = ids.map((id) => [id, worldBox(id)]).filter(([, r]) => r);
      if (!boxes.length) return null;
      // Which layer the cursor is on: it walks the touched layers in order, then rests on the first.
      const step = Math.floor(age(p) / STEP_MS);
      const walking = boxes.length > 1 && step < boxes.length;
      const at = walking ? boxes[Math.min(step, boxes.length - 1)][1] : union(boxes.map(([, r]) => r));
      const tip = tipOf(walking ? at : boxes[0][1]);
      const left = stayMs(p) - age(p);
      const fade = left < FADE_MS ? Math.max(0, left / FADE_MS) : 1;
      const phase = phaseOf(p);
      const c = colourOf(p.key);
      return html`<div key=${p.key} class="bd-agent-mark ${phase}" style=${{ "--c": c, "--inv": 1 / z, opacity: fade }}>
        ${boxes.slice(0, walking ? step + 1 : boxes.length).map(([id, r], i) => html`<div key=${p.at + id} class="bd-agent-flash" style=${{ left: r.x + "px", top: r.y + "px", width: r.width + "px", height: r.height + "px", animationDelay: walking ? "0s" : `${Math.min(i, 12) * 40}ms` }}></div>`)}
        <div class="bd-cursor" data-agent=${p.key} style=${{ left: tip.x + "px", top: tip.y + "px" }}>
          <div class="bd-cursor-in">
            <svg width="18" height="20" viewBox="0 0 18 20"><path d="M1.5 1.5l13.6 7.1-6 1.4-2.9 5.8z" fill="var(--c)" stroke="#fff" stroke-width="1.6" stroke-linejoin="round" /></svg>
            <span class="bd-cursor-name"><b>${p.name}</b><span class="bd-cursor-doing">${phase === "thinking" ? html`thinking<i class="bd-dots"><i></i><i></i><i></i></i>` : doingNow(p)}</span></span>
          </div>
        </div>
      </div>`;
    })}
  </div>`;
}

/** The agents at work as avatars over the canvas: click one to follow it, again to stop. */
export function PresenceBar() {
  const b = B;
  const agents = activeAgents();
  const followedP = (b.presence ?? []).find((p) => p.key === b.following);
  const following = b.following && followedP;
  if (!b.board || (!agents.length && !following)) return null;
  const here = following && agents.some((p) => p.key === followedP.key);
  return html`${following && html`<div class="bd-follow-frame" style=${{ "--c": colourOf(followedP.key) }}></div>`}<div class="bd-presence-bar" onPointerDown=${(e) => e.stopPropagation()}>
    ${following &&
    html`<span class="bd-following" style=${{ "--c": colourOf(followedP.key) }}>
      <span class="bd-following-t">Following <b>${followedP.name}</b><span class="bd-following-doing">${here ? doingNow(followedP) : "waiting for its next move"}</span></span>
      <button class="bd-link" onClick=${unfollow}>Stop</button></span>`}
    ${agents.map((p) => html`<button key=${p.key} class="bd-avatar ${p.key === b.following ? "on" : ""} ${phaseOf(p)}" style=${{ "--c": colourOf(p.key) }}
        title=${`${describe(p)}. ${p.key === b.following ? "Click to stop following" : "Click to follow"}`}
        aria-label=${p.key === b.following ? `Stop following ${p.name}` : `Follow ${p.name}`} aria-pressed=${p.key === b.following}
        onClick=${() => (p.key === b.following ? unfollow() : follow(p.key))}>${(p.name.trim()[0] ?? "A").toUpperCase()}</button>`)}
  </div>`;
}
