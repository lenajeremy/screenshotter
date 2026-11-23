// Faces without photos: an animal on a soft colour for a person, a small emblem for a team. Each is
// picked from who it's for, so the same person or team always gets the same one.
import { html } from "./controls.js";

const ANIMALS = ["🦊", "🐼", "🐨", "🦁", "🐯", "🐸", "🐵", "🦉", "🐙", "🦄", "🐳", "🐝", "🦋", "🐢", "🦜", "🐰", "🐻", "🐶", "🐱", "🐧", "🦦", "🦔", "🐬", "🦩"];
const EMBLEMS = ["🌿", "🔥", "🌊", "⭐", "🍋", "🪐", "🌸", "⚡", "🍀", "🌙", "🎈", "🧩", "🏔️", "🌵", "🍊", "💎"];
const TINTS = ["#ffd9a8", "#c9e4ff", "#d6f5c4", "#f6d0ee", "#fff0a6", "#d9d2ff", "#bff0e4", "#ffc9c2"];

// Mixed well, so two ids a letter apart ("t1", "t2") don't land on the same colour.
const hash = (text, seed = 7) => {
  let h = seed >>> 0;
  for (const c of String(text ?? "")) h = Math.imul(h ^ c.charCodeAt(0), 0x01000193) >>> 0;
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d) >>> 0;
  h ^= h >>> 12;
  return h >>> 0;
};

/** The animal and colour for someone with no photo. */
export const faceOf = (user) => {
  const key = user?.id ?? user?.email ?? user?.name ?? "someone";
  return { emoji: ANIMALS[hash(key) % ANIMALS.length], tint: TINTS[hash(key, 99) % TINTS.length] };
};

/** The emblem and colour for a team. */
export const emblemOf = (team) => {
  const key = typeof team === "string" ? team : (team?.id ?? team?.name ?? "team");
  return { emoji: EMBLEMS[hash(key) % EMBLEMS.length], tint: TINTS[hash(key, 99) % TINTS.length] };
};

/** A person: their photo if they have one, their animal if not. `cls` sets the size (cloud-av, bd-face, gate-av…). */
export function Avatar({ user, cls = "cloud-av", title, style }) {
  if (user?.image) return html`<img class=${cls} src=${user.image} alt="" title=${title} style=${style} />`;
  const f = faceOf(user);
  return html`<span class="${cls} face" title=${title} style=${{ background: f.tint, ...(style ?? {}) }} aria-hidden="true">${f.emoji}</span>`;
}

/** A team's mark. */
export function TeamMark({ team, cls = "team-mark" }) {
  const f = emblemOf(team);
  return html`<i class="${cls} face" style=${{ background: f.tint }} aria-hidden="true">${f.emoji}</i>`;
}
