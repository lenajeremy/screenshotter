/**
 * A drawn macOS menu bar: the Apple menu, the app's name and menus on the left; a menu bar app's
 * status item, Control Center, Spotlight, Wi-Fi, battery and the clock on the right. It sits on a
 * MacBook's screen above an app capture, or across the top of the canvas for menu bar app shots.
 */
import { APPLE } from "./back.js";
import { esc } from "./background.js";

export interface MenuBarSpec {
  /** App name, shown bold after the Apple menu. Without one only the Apple menu shows on the left. */
  app?: string;
  /** The app's menus. Default File, Edit, View, Window, Help. */
  menus?: string[];
  /** light: dark text on a pale bar. dark: white text on a dark bar. */
  style?: "light" | "dark";
  /** The clock. Default "Wed Sep 23  9:41 AM". */
  time?: string;
  /** A menu bar app's status item, drawn highlighted (its menu is open), e.g. "Team standup · in 19m". */
  status?: string;
  /** Where the status item's centre sits, as a fraction of the bar's width. Default: just left of the system icons. */
  statusX?: number;
}

export const SAFARI_MENUS = ["File", "Edit", "View", "History", "Bookmarks", "Window", "Help"];
const DEFAULT_MENUS = ["File", "Edit", "View", "Window", "Help"];

const f = (n: number) => `${Math.round(n * 100) / 100}px`;
/** Rough text width for SF Pro at `size` (menu bars use short, known words). */
const textWidth = (s: string, size: number, bold = false) => s.length * size * (bold ? 0.6 : 0.55);

const ICONS = {
  control: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"><rect x="3" y="4.5" width="18" height="6" rx="3"/><circle cx="7" cy="7.5" r="1.7" fill="currentColor" stroke="none"/><rect x="3" y="13.5" width="18" height="6" rx="3"/><circle cx="17" cy="16.5" r="1.7" fill="currentColor" stroke="none"/></svg>`,
  search: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round"><circle cx="10.5" cy="10.5" r="6.3"/><path d="m15.3 15.3 5.2 5.2"/></svg>`,
  wifi: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 5.2c3.6 0 6.9 1.4 9.4 3.7l-1.6 1.7A11.3 11.3 0 0 0 12 7.5c-3 0-5.8 1.2-7.8 3.1L2.6 8.9A13.6 13.6 0 0 1 12 5.2Zm0 4.6c2.3 0 4.5.9 6.1 2.4l-1.6 1.7A6.6 6.6 0 0 0 12 12.1a6.6 6.6 0 0 0-4.5 1.8l-1.6-1.7A8.9 8.9 0 0 1 12 9.8Zm0 4.6c1.1 0 2 .4 2.8 1.1L12 18.4l-2.8-2.9c.8-.7 1.7-1.1 2.8-1.1Z"/></svg>`,
  battery: `<svg viewBox="0 0 30 16"><rect x="1.2" y="2.2" width="24.6" height="11.6" rx="3.6" fill="none" stroke="currentColor" stroke-opacity=".42" stroke-width="1.3"/><rect x="3.2" y="4.2" width="17.5" height="7.6" rx="2" fill="currentColor"/><path d="M27.4 6.1v3.8a2 2 0 0 0 0-3.8Z" fill="currentColor" fill-opacity=".42"/></svg>`,
};

const statusWidth = (spec: MenuBarSpec, fs: number) => (spec.status ? textWidth(spec.status, fs) + fs * 1.4 : 0);

/**
 * Where the right-hand system items (icons and clock) begin, in px from the left, and how far
 * they're pushed right. In a close-up the bar is too short for everything: the status item keeps
 * its place beside the Apple menu and the icons and clock run off the right edge, as a cropped
 * screenshot of a real menu bar would.
 */
function tray(spec: MenuBarSpec, W: number, fs: number): { start: number; shift: number } {
  const gap = fs * 1.5;
  const icons = [1.25, 1.18, 1.35, 1.75].reduce((a, k) => a + gap * 0.95 + fs * k, 0);
  const natural = W - fs * 1.2 - textWidth(spec.time ?? "Wed Sep 23  9:41 AM", fs) - icons;
  const needed = fs * 1.2 + fs * 1.12 + gap + (spec.status ? statusWidth(spec, fs) + fs * 1.2 : 0);
  const shift = Math.max(0, needed - natural);
  return { start: natural + shift, shift };
}

/**
 * Where the status item's centre sits (px): at `statusX` when given, else just left of the system
 * icons like a real menu bar app, and never over them.
 */
export function statusCentre(spec: MenuBarSpec, W: number, fs: number): number {
  const half = statusWidth(spec, fs) / 2;
  const max = tray(spec, W, fs).start - fs * 1.2 - half;
  return Math.min(spec.statusX !== undefined ? spec.statusX * W : max, max);
}

/**
 * The bar as HTML, `W` × `H` px, with text at `fs` px. `notch` (px) keeps the left-hand menus
 * clear of a MacBook's notch in the middle. `background` overrides the bar's own fill.
 */
export function menuBarHtml(spec: MenuBarSpec, W: number, H: number, fs: number, opts: { notch?: number; background?: string } = {}): string {
  const dark = spec.style === "dark";
  const ink = dark ? "#ffffff" : "#1d1d1f";
  const fill = opts.background ?? (dark ? "rgba(22,22,26,.62)" : "rgba(246,246,249,.74)");
  const item = (x: number, content: string, extra = "") =>
    `<div style="position:absolute;left:${f(x)};top:0;height:${f(H)};display:flex;align-items:center;white-space:nowrap;${extra}">${content}</div>`;
  const icon = (svg: string, w: number) => `<span style="display:inline-block;width:${f(w)};height:${f(w)};color:${ink}">${svg}</span>`;
  const font = `font:500 ${f(fs)} -apple-system, 'SF Pro Text', system-ui, sans-serif;letter-spacing:-0.01em;color:${ink}`;

  let out = "";
  // Left: Apple menu, then the app and its menus, stopping before the notch.
  const gap = fs * 1.5;
  let x = fs * 1.2;
  out += item(x, `<svg viewBox="0 0 170 170" width="${fs * 1.12}" height="${fs * 1.12}" style="margin-top:${f(-fs * 0.12)}"><path d="${APPLE}" fill="${ink}"/></svg>`);
  x += fs * 1.12 + gap;
  const limit = opts.notch ? W / 2 - opts.notch / 2 - fs : W * 0.6;
  if (spec.app) {
    const w = textWidth(spec.app, fs, true);
    if (x + w < limit) {
      out += item(x, `<span style="${font};font-weight:700">${esc(spec.app)}</span>`);
      x += w + gap;
      for (const m of spec.menus ?? DEFAULT_MENUS) {
        const mw = textWidth(m, fs);
        if (x + mw > limit) break;
        out += item(x, `<span style="${font}">${esc(m)}</span>`);
        x += mw + gap;
      }
    }
  }

  // Right, from the edge inwards: clock, Control Center, Spotlight, Wi-Fi, battery.
  let r = W - fs * 1.2 + tray(spec, W, fs).shift;
  const time = spec.time ?? "Wed Sep 23  9:41 AM";
  const tw = textWidth(time, fs);
  r -= tw;
  out += item(r, `<span style="${font};white-space:pre">${esc(time)}</span>`);
  const icons: Array<[string, number]> = [
    [ICONS.control, fs * 1.25],
    [ICONS.search, fs * 1.18],
    [ICONS.wifi, fs * 1.35],
    [ICONS.battery, fs * 1.75],
  ];
  for (const [svg, w] of icons) {
    r -= gap * 0.95 + w;
    out += item(r, icon(svg, w));
  }

  // The status item of a menu bar app, highlighted because its menu is open.
  if (spec.status) {
    const sw = statusWidth(spec, fs);
    const cx = statusCentre(spec, W, fs);
    const pill = `background:${dark ? "rgba(255,255,255,.2)" : "rgba(0,0,0,.1)"};border-radius:${f(H * 0.3)};height:${f(H * 0.78)};top:${f(H * 0.11)};padding:0 ${f(fs * 0.7)};`;
    out += `<div style="position:absolute;left:${f(cx - sw / 2)};${pill}display:flex;align-items:center;white-space:nowrap"><span style="${font}">${esc(spec.status)}</span></div>`;
  }

  return `<div class="menubar" style="position:absolute;left:0;top:0;width:${f(W)};height:${f(H)};background:${fill};overflow:hidden">${out}</div>`;
}
