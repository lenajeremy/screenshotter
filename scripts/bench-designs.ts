/**
 * The designs the canvas benchmark draws (scripts/canvas-bench.ts) and scripts/stress-board.ts puts
 * on a board to try by hand: desktop pages 1440 wide (nested flex frames, lots of text, pictures,
 * corners, shadows, gradients, SVG icons, a video, a shader), phone screens, and a long website page.
 */
import { writeFileSync } from "node:fs";
import { encodePng } from "../src/util/png.js";

/** The pictures, the video and the size the designs use: set before drawing them. */
export const A = { photos: [] as string[], avatars: [] as string[], clip: "", stress: false };

/** A photo-like picture: smooth colour with grain, so it costs what a photo costs to draw. */
export function photo(file: string, w: number, h: number, seed: number) {
  const rgba = Buffer.alloc(w * h * 4);
  let s = seed * 9301 + 49297;
  const rnd = () => ((s = (s * 9301 + 49297) % 233280) / 233280);
  const [a, b, c] = [rnd() * 255, rnd() * 255, rnd() * 255];
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const n = (rnd() - 0.5) * 40;
      const u = x / w, v = y / h;
      rgba[i] = Math.max(0, Math.min(255, a * (1 - u) + 200 * u * v + n));
      rgba[i + 1] = Math.max(0, Math.min(255, b * (1 - v) + 120 * u + n));
      rgba[i + 2] = Math.max(0, Math.min(255, c * v + 180 * (1 - u) * (1 - v) + n));
      rgba[i + 3] = 255;
    }
  writeFileSync(file, encodePng({ width: w, height: h, rgba }));
}

const SANS = "'Helvetica Neue', Helvetica, sans-serif";
const SERIF = "Georgia, serif";
const words = ["Design", "systems", "that", "ship", "faster", "with", "every", "team", "on", "one", "canvas", "built", "for", "agents", "and", "people", "together"];
const sentence = (n: number, k: number) => Array.from({ length: n }, (_, i) => words[(i * 7 + k * 3) % words.length]).join(" ").replace(/^./, (c) => c.toUpperCase()) + ".";
const icon = (c: string, k = 0) =>
  k % 3 === 0
    ? `<svg width="24" height="24" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10" stroke="${c}" stroke-width="2"/><path d="M8 12l3 3 5-6" stroke="${c}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`
    : k % 3 === 1
      ? `<svg width="24" height="24" viewBox="0 0 24 24" fill="none"><rect x="3" y="3" width="18" height="18" rx="5" stroke="${c}" stroke-width="2"/><path d="M8 15l4-6 4 6" stroke="${c}" stroke-width="2" stroke-linejoin="round"/></svg>`
      : `<svg width="24" height="24" viewBox="0 0 24 24" fill="none"><path d="M12 2l3 7h7l-5.5 4.5L18 21l-6-4-6 4 1.5-7.5L2 9h7z" stroke="${c}" stroke-width="2" stroke-linejoin="round"/></svg>`;
const shadow = "0 1px 2px rgba(16,24,40,0.06), 0 12px 32px -8px rgba(16,24,40,0.18)";

function nav(k: number) {
  return `<div data-name="Nav" style="display:flex;align-items:center;justify-content:space-between;padding:20px 64px;border-bottom:1px solid #eceef2">
    <div style="display:flex;align-items:center;gap:10px">${icon("#5b5bd6", k)}<span style="font-size:18px;font-weight:700">Northwind</span></div>
    <div style="display:flex;gap:28px">${["Product", "Solutions", "Pricing", "Customers", "Docs", "Blog"].map((t) => `<span style="font-size:15px;color:#4b5563">${t}</span>`).join("")}</div>
    <div style="padding:10px 18px;border-radius:10px;background:#111827;color:#fff;font-size:14px;font-weight:600;box-shadow:${shadow}">Get started</div></div>`;
}
function hero(k: number, { shader = false, badge = true } = {}) {
  const inner = `<div style="display:flex;flex-direction:column;gap:24px;width:560px">
      <span style="align-self:flex-start;padding:6px 12px;border-radius:999px;background:rgba(91,91,214,0.12);color:#5b5bd6;font-size:13px;font-weight:600">New · Version ${k + 2}.0</span>
      <h1 style="margin:0;font:700 64px/1.05 ${SANS};letter-spacing:-0.03em">${sentence(5, k)}</h1>
      <p style="margin:0;font-size:19px;line-height:1.6;color:#4b5563">${sentence(24, k + 1)}</p>
      <div style="display:flex;gap:12px"><div style="padding:14px 22px;border-radius:12px;background:linear-gradient(180deg,#6e6ef5,#4f46e5);color:#fff;font-weight:600;box-shadow:0 8px 24px rgba(79,70,229,0.35)">Start free trial</div><div style="padding:14px 22px;border-radius:12px;background:#fff;border:1px solid #e5e7eb;font-weight:600">Book a demo</div></div></div>
    <img src="${A.photos[k % 6]}" style="width:600px;height:400px;object-fit:cover;border-radius:24px;box-shadow:0 30px 60px -12px rgba(0,0,0,0.35)" />
    ${badge ? `<div data-name="Badge ${k}" style="position:absolute;left:660px;top:56px;display:flex;align-items:center;gap:8px;padding:10px 16px;border-radius:999px;background:#111827;color:#fff;font-size:14px;font-weight:600;box-shadow:0 10px 30px rgba(0,0,0,0.25)">${icon("#a5b4fc", 2)}<span>Rated 4.9 by teams</span></div>` : ""}`;
  const style = `display:flex;align-items:center;justify-content:space-between;gap:48px;padding:96px 64px;position:relative;background:linear-gradient(135deg,#f5f3ff 0%,#e0f2fe 60%,#fdf2f8 100%)`;
  return shader ? `<div data-name="Hero" data-shader="mesh-gradient" style="${style}">${inner}</div>` : `<div data-name="Hero" style="${style}">${inner}</div>`;
}
function logos(k: number) {
  return `<div data-name="Logos ${k}" style="display:flex;justify-content:space-between;padding:40px 64px;border-top:1px solid #f1f2f4;border-bottom:1px solid #f1f2f4">${Array.from({ length: 8 }, (_, i) => `<div style="display:flex;align-items:center;gap:8px;opacity:0.7">${icon("#6b7280", i)}<span style="font-size:17px;font-weight:700;color:#6b7280">${["Acme", "Globex", "Initech", "Umbrella", "Hooli", "Stark", "Wayne", "Tyrell"][i]}</span></div>`).join("")}</div>`;
}
function features(k: number) {
  const card = (i: number) => `<div style="display:flex;flex-direction:column;gap:12px;padding:28px;border-radius:18px;background:#fff;box-shadow:${shadow};border:1px solid #f0f1f4">
    <div style="width:44px;height:44px;border-radius:12px;display:flex;align-items:center;justify-content:center;background:linear-gradient(135deg,#eef2ff,#e0e7ff)">${icon("#4f46e5", i)}</div>
    <h3 style="margin:0;font-size:20px;font-weight:650">${sentence(3, i + k)}</h3>
    <p style="margin:0;font-size:15px;line-height:1.6;color:#6b7280">${sentence(18, i * 2 + k)}</p>
    <span style="font-size:14px;font-weight:600;color:#4f46e5">Learn more →</span></div>`;
  return `<div data-name="Features ${k}" style="display:flex;flex-direction:column;gap:40px;padding:96px 64px;background:#f9fafb">
    <div style="display:flex;flex-direction:column;gap:12px;align-items:center"><h2 style="margin:0;font:700 44px/1.1 ${SANS};letter-spacing:-0.02em">${sentence(6, k + 5)}</h2><p style="margin:0;font-size:18px;color:#6b7280">${sentence(14, k + 2)}</p></div>
    <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:24px">${Array.from({ length: 9 }, (_, i) => card(i)).join("")}</div></div>`;
}
function gallery(k: number) {
  return `<div data-name="Gallery ${k}" style="display:grid;grid-template-columns:repeat(3,1fr);gap:20px;padding:64px">${Array.from({ length: 6 }, (_, i) => `<img src="${A.photos[(i + k) % 6]}" style="width:100%;height:280px;object-fit:cover;border-radius:16px" />`).join("")}</div>`;
}
function testimonials(k: number) {
  const card = (i: number) => `<div style="display:flex;flex-direction:column;gap:16px;padding:28px;border-radius:18px;background:#fff;box-shadow:${shadow}">
    <p style="margin:0;font:400 18px/1.6 ${SERIF};color:#111827">“${sentence(22, i + k)}”</p>
    <div style="display:flex;align-items:center;gap:12px"><img src="${A.avatars[(i + k) % 6]}" style="width:44px;height:44px;border-radius:999px;object-fit:cover" />
    <div style="display:flex;flex-direction:column"><b style="font-size:15px">${["Ada Park", "Lena Ortiz", "Sam Okafor"][i]}</b><span style="font-size:13px;color:#6b7280">Design lead, ${["Acme", "Globex", "Hooli"][i]}</span></div></div></div>`;
  return `<div data-name="Testimonials ${k}" style="display:grid;grid-template-columns:repeat(3,1fr);gap:24px;padding:96px 64px;background:linear-gradient(180deg,#fff,#f5f3ff)">${[0, 1, 2].map(card).join("")}</div>`;
}
function pricing(k: number) {
  const card = (i: number) => `<div style="display:flex;flex-direction:column;gap:20px;padding:32px;border-radius:20px;background:${i === 1 ? "#111827" : "#fff"};color:${i === 1 ? "#fff" : "#111827"};box-shadow:${shadow};border:1px solid #eceef2">
    <span style="font-size:15px;font-weight:600;opacity:0.8">${["Starter", "Team", "Enterprise"][i]}</span>
    <div style="display:flex;align-items:baseline;gap:4px"><span style="font-size:48px;font-weight:700;letter-spacing:-0.02em">$${[12, 39, 99][i]}</span><span style="font-size:15px;opacity:0.6">/ month</span></div>
    <div style="display:flex;flex-direction:column;gap:12px">${Array.from({ length: 6 }, (_, j) => `<div style="display:flex;align-items:center;gap:10px">${icon(i === 1 ? "#a5b4fc" : "#4f46e5", 0)}<span style="font-size:15px">${sentence(4, j + i + k)}</span></div>`).join("")}</div>
    <div style="padding:14px;border-radius:12px;text-align:center;font-weight:600;background:${i === 1 ? "#fff" : "#111827"};color:${i === 1 ? "#111827" : "#fff"}">Choose ${["Starter", "Team", "Enterprise"][i]}</div></div>`;
  return `<div data-name="Pricing ${k}" style="display:grid;grid-template-columns:repeat(3,1fr);gap:24px;padding:96px 64px">${[0, 1, 2].map(card).join("")}</div>`;
}
function blog(k: number) {
  const card = (i: number) => `<div style="display:flex;flex-direction:column;gap:12px">
    <img src="${A.photos[(i + k + 2) % 6]}" style="width:100%;height:200px;object-fit:cover;border-radius:14px" />
    <span style="font-size:12px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:#4f46e5">${["Guides", "Product", "Stories"][i % 3]}</span>
    <h4 style="margin:0;font-size:20px;line-height:1.3">${sentence(8, i + k)}</h4>
    <p style="margin:0;font-size:15px;line-height:1.6;color:#6b7280">${sentence(16, i + k + 1)}</p>
    <div style="display:flex;align-items:center;gap:8px"><img src="${A.avatars[i % 6]}" style="width:28px;height:28px;border-radius:999px" /><span style="font-size:13px;color:#6b7280">May ${i + 3}, 2026</span></div></div>`;
  return `<div data-name="Blog ${k}" style="display:grid;grid-template-columns:repeat(3,1fr);gap:32px;padding:64px">${Array.from({ length: 6 }, (_, i) => card(i)).join("")}</div>`;
}
function faq(k: number) {
  return `<div data-name="FAQ ${k}" style="display:flex;flex-direction:column;padding:96px 240px">${Array.from({ length: 8 }, (_, i) => `<div style="display:flex;flex-direction:column;gap:8px;padding:20px 0;border-bottom:1px solid #eceef2"><h4 style="margin:0;font-size:18px">${sentence(7, i + k)}?</h4><p style="margin:0;font-size:15px;line-height:1.6;color:#6b7280">${sentence(26, i + k + 3)}</p></div>`).join("")}</div>`;
}
function footer(k: number) {
  return `<div data-name="Footer ${k}" style="display:flex;flex-direction:column;gap:40px;padding:64px;background:#0b0d12;color:#e5e7eb">
    <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:24px">${[0, 1, 2, 3].map((c) => `<div style="display:flex;flex-direction:column;gap:10px"><b style="font-size:14px;color:#fff">${["Product", "Company", "Resources", "Legal"][c]}</b>${Array.from({ length: 6 }, (_, j) => `<span style="font-size:14px;color:#9ca3af">${sentence(2, c + j)}</span>`).join("")}</div>`).join("")}</div>
    <span style="font-size:13px;color:#6b7280">© 2026 Northwind, Inc.</span></div>`;
}
function videoSection(k: number) {
  return `<div data-name="Video section ${k}" style="padding:64px;background:#0b0d12"><video data-name="Video" src="${A.clip}" style="width:100%;height:560px;object-fit:cover;border-radius:24px"></video></div>`;
}

export function desktop(k: number, at: { x: number; y: number }) {
  return `<div data-name="Desktop ${k}" style="left:${at.x}px;top:${at.y}px;width:1440px;display:flex;flex-direction:column;background:#fff;font-family:${SANS};color:#111827;overflow:hidden">
    ${nav(k)}${hero(k, { shader: k % 6 === 0 })}${logos(k)}${features(k)}${k % 6 === 1 ? videoSection(k) : gallery(k)}${testimonials(k)}${pricing(k)}${faq(k)}${footer(k)}</div>`;
}
export function phone(k: number, at: { x: number; y: number }) {
  const row = (i: number) => `<div style="display:flex;align-items:center;gap:12px;padding:12px 16px;border-radius:14px;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,0.06)">
    <img src="${A.avatars[(i + k) % 6]}" style="width:40px;height:40px;border-radius:12px;object-fit:cover" />
    <div style="display:flex;flex-direction:column;gap:2px;flex:1"><span style="font-size:15px;font-weight:600">${sentence(2, i + k)}</span><span style="font-size:13px;color:#6b7280">${sentence(5, i * 3 + k)}</span></div>
    ${icon("#9ca3af", i)}</div>`;
  return `<div data-name="Phone ${k}" style="left:${at.x}px;top:${at.y}px;width:390px;height:844px;display:flex;flex-direction:column;background:${k % 2 ? "#f2f2f7" : "linear-gradient(180deg,#eef2ff,#f8fafc)"};font-family:${SANS};color:#111827;overflow:hidden;border-radius:0">
    <div style="display:flex;justify-content:space-between;align-items:center;padding:14px 24px"><span style="font-size:15px;font-weight:600">9:41</span><div style="display:flex;gap:6px">${icon("#111", 1)}${icon("#111", 2)}</div></div>
    <div style="display:flex;flex-direction:column;gap:12px;padding:8px 16px 12px"><h1 style="margin:0;font-size:32px;font-weight:700">${["Inbox", "Today", "Library", "Explore", "Friends"][k % 5]}</h1>
      <div style="display:flex;align-items:center;gap:8px;padding:10px 12px;border-radius:12px;background:rgba(118,118,128,0.12)">${icon("#8e8e93", 0)}<span style="font-size:15px;color:#8e8e93">Search</span></div></div>
    <div style="display:flex;flex-direction:column;gap:8px;padding:0 12px;flex:1">${Array.from({ length: 10 }, (_, i) => row(i)).join("")}</div>
    <div style="display:flex;justify-content:space-around;padding:10px 0 28px;background:rgba(255,255,255,0.92);border-top:1px solid #e5e7eb">${Array.from({ length: 5 }, (_, i) => `<div style="display:flex;flex-direction:column;align-items:center;gap:4px">${icon(i === 0 ? "#4f46e5" : "#9ca3af", i)}<span style="font-size:10px;color:${i === 0 ? "#4f46e5" : "#9ca3af"}">${["Home", "Search", "Add", "Inbox", "Me"][i]}</span></div>`).join("")}</div></div>`;
}
export function website(at: { x: number; y: number }) {
  const blocks = Array.from({ length: A.stress ? 20 : 8 }, (_, k) => k).map((k) => `${features(k + 10)}${testimonials(k + 10)}${k % 2 ? pricing(k + 10) : blog(k + 10)}`).join("");
  return `<div data-name="Website" style="left:${at.x}px;top:${at.y}px;width:1440px;display:flex;flex-direction:column;background:#fff;font-family:${SANS};color:#111827">
    ${nav(9)}${hero(9, { badge: true })}${logos(9)}${blocks}${gallery(9)}${faq(9)}${footer(9)}</div>`;
}
