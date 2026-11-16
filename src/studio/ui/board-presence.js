// Agents on the board, live: each agent at work has a cursor in its own colour, with its name,
// that glides to what it just touched (the layers flash in its colour), and an avatar over the
// canvas. Click an avatar to follow that agent: the view goes with its changes until you take over
// (a scroll, a click, Esc).
import { useEffect, useState } from "preact/hooks";
import { pageOf } from "./board-core.js";
import { B, bset, currentPage } from "./board-state.js";
import { canvasEl, centerOn, fit, worldBox } from "./board-canvas.js";
import { html } from "./controls.js";

/** Long enough to read as "at work", short enough that a finished agent's cursor goes. */
const ACTIVE_MS = 45_000;
const FADE_MS = 6_000;
const COLOURS = ["#7c6cff", "#f0508c", "#1ba7c4", "#e8890c", "#2f9e57", "#e2603f", "#4c6ef5", "#b350d6"];
const VERBS = { edit: "is changing", write: "is adding", import: "brought in", look: "is looking at", read: "is reading" };

export function colourOf(key) {
  let h = 0;
  for (const ch of String(key)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return COLOURS[h % COLOURS.length];
}

const age = (p) => Date.now() - Date.parse(p.at);
/** The agents at work now, the most recent first. */
export const activeAgents = () => (B.presence ?? []).filter((p) => age(p) < ACTIVE_MS).sort((a, b) => b.at.localeCompare(a.at));

/** The box around what an agent touched, on the page showing (board units), or null. */
function boxOf(p) {
  const boxes = (p.ids ?? []).filter((id) => B.board?.nodes[id] && pageOf(B.board, id)?.id === B.page).map(worldBox).filter(Boolean);
  if (!boxes.length) return null;
  const x = Math.min(...boxes.map((b) => b.x));
  const y = Math.min(...boxes.map((b) => b.y));
  return { x, y, width: Math.max(...boxes.map((b) => b.x + b.width)) - x, height: Math.max(...boxes.map((b) => b.y + b.height)) - y };
}

/** Where the cursor points: inside the box near its top left, not off in a big artboard's middle. */
const tipOf = (box) => ({ x: box.x + Math.min(box.width / 2, 36), y: box.y + Math.min(box.height / 2, 24) });

function describe(p) {
  const n = (p.ids ?? []).map((id) => B.board?.nodes[id]?.name).filter(Boolean);
  const what = n.length > 1 ? `${n[0]} and ${n.length - 1} more` : n[0] ?? "the board";
  const s = Math.round(age(p) / 1000);
  return `${p.name} ${VERBS[p.doing] ?? "is working on"} ${what}${s >= 5 ? ` · ${s} s ago` : ""}`;
}

/** Go with an agent: bring what it touched into view (its page, then the place), only moving when it's out of sight. */
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
  const c = canvasEl.current?.getBoundingClientRect();
  if (!box || !c) return;
  const { x, y, z } = B.view;
  const s = { left: box.x * z + x, top: box.y * z + y, right: (box.x + box.width) * z + x, bottom: (box.y + box.height) * z + y };
  const inside = s.left >= 24 && s.top >= 48 && s.right <= c.width - 24 && s.bottom <= c.height - 24;
  if (inside) return;
  if (box.width * z < c.width - 96 && box.height * z < c.height - 96) centerOn({ x: box.x + box.width / 2, y: box.y + box.height / 2 });
  else fit(p.ids.filter((i) => B.board.nodes[i]));
}

export function follow(key) {
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
  // Fading out on time, with nothing else changing.
  useEffect(() => {
    if (!agents.length) return;
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [agents.length > 0]);
  // Following: each new move of that agent comes into view; you taking over stops it.
  const followed = agents.find((p) => p.key === b.following);
  useEffect(() => {
    if (followed) bringIntoView(followed);
  }, [followed?.at]);
  useEffect(() => {
    if (!b.following) return;
    const el = canvasEl.current;
    // The avatars themselves switch who's followed: a press on them isn't taking over.
    const stop = (e) => !e.target?.closest?.(".bd-presence-bar") && unfollow();
    const key = (e) => e.key === "Escape" && unfollow();
    el?.addEventListener("wheel", stop, { passive: true });
    el?.addEventListener("pointerdown", stop, true);
    addEventListener("keydown", key, true);
    return () => {
      el?.removeEventListener("wheel", stop);
      el?.removeEventListener("pointerdown", stop, true);
      removeEventListener("keydown", key, true);
    };
  }, [b.following]);
  if (!b.board || !agents.length) return null;
  const { x, y, z } = b.view;
  return html`<div class="bd-presence" aria-hidden="true" style=${{ transform: `translate(${x}px, ${y}px) scale(${z})` }}>
    ${agents.map((p) => {
      const box = boxOf(p);
      if (!box) return null;
      const tip = tipOf(box);
      const left = ACTIVE_MS - age(p);
      const fade = left < FADE_MS ? Math.max(0, left / FADE_MS) : 1;
      const c = colourOf(p.key);
      return html`<div key=${p.key} class="bd-agent-mark" style=${{ "--c": c, "--inv": 1 / z, opacity: fade }}>
        <div key=${p.at} class="bd-agent-flash" style=${{ left: box.x + "px", top: box.y + "px", width: box.width + "px", height: box.height + "px" }}></div>
        <div class="bd-cursor" data-agent=${p.key} style=${{ left: tip.x + "px", top: tip.y + "px" }}>
          <div class="bd-cursor-in">
            <svg width="18" height="20" viewBox="0 0 18 20"><path d="M1.5 1.5l13.6 7.1-6 1.4-2.9 5.8z" fill="var(--c)" stroke="#fff" stroke-width="1.6" stroke-linejoin="round" /></svg>
            <span class="bd-cursor-name">${p.name}</span>
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
  if (!b.board || !agents.length) return null;
  const following = agents.find((p) => p.key === b.following);
  return html`${following && html`<div class="bd-follow-frame" style=${{ "--c": colourOf(following.key) }}></div>`}<div class="bd-presence-bar" onPointerDown=${(e) => e.stopPropagation()}>
    ${following &&
    html`<span class="bd-following" style=${{ "--c": colourOf(following.key) }}>Following ${following.name}<button class="bd-link" onClick=${unfollow}>Stop</button></span>`}
    ${agents.map((p) => html`<button key=${p.key} class="bd-avatar ${p.key === b.following ? "on" : ""}" style=${{ "--c": colourOf(p.key) }}
        title=${`${describe(p)}. ${p.key === b.following ? "Click to stop following" : "Click to follow"}`}
        aria-label=${p.key === b.following ? `Stop following ${p.name}` : `Follow ${p.name}`} aria-pressed=${p.key === b.following}
        onClick=${() => (p.key === b.following ? unfollow() : follow(p.key))}>${(p.name.trim()[0] ?? "A").toUpperCase()}</button>`)}
  </div>`;
}
