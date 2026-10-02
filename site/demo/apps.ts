/**
 * Two more made-up apps, drawn in HTML like Mise (screens.ts), so templates can be tried on very
 * different screens: "Bloom", a bright habit tracker, and "Penny", a dark money app. Each has
 * iPhone screens, iPhone Duo screens (open: a two-pane landscape layout and a portrait one), an
 * iPad screen and a Mac window. scripts/demo-apps.ts renders them at each device's pixel scale.
 */

type Theme = { bg: string; card: string; line: string; ink: string; sub: string; dark: boolean };

const BLOOM: Theme & Record<string, string | boolean> = { bg: "#f7f3ec", card: "#ffffff", line: "#ece6db", ink: "#1f2a24", sub: "#7a8277", dark: false, coral: "#ff7a59", green: "#3fae73", lilac: "#8b7cf6", sun: "#ffc84a", sky: "#5bb8f5" };
const PENNY: Theme & Record<string, string | boolean> = { bg: "#0b1110", card: "#141c1a", line: "#22302c", ink: "#eef6f3", sub: "#8aa39b", dark: true, mint: "#4ade9b", coral: "#ff8a65", blue: "#60a5fa", gold: "#f6c453", violet: "#a78bfa" };

/** The iPhone/iPad status bar, dark or light. `ipad` puts the date beside the time. */
const statusBar = (t: Theme, ipad = false) => {
  const c = t.dark ? "#fff" : "#000";
  return `<div class="sb${ipad ? " pad" : ""}"><span class="t">9:41${ipad ? `<span class="d"> Tue 30 Sep</span>` : ""}</span><span class="ic">
    <svg width="19" height="12" viewBox="0 0 19 12"><rect x="0" y="8" width="3" height="4" rx="1" fill="${c}"/><rect x="5" y="5.5" width="3" height="6.5" rx="1" fill="${c}"/><rect x="10" y="3" width="3" height="9" rx="1" fill="${c}"/><rect x="15" y="0" width="3" height="12" rx="1" fill="${c}"/></svg>
    <svg width="17" height="12" viewBox="0 0 17 12"><path d="M8.5 2.3c2.4 0 4.6.9 6.2 2.5l1.1-1.1A10.4 10.4 0 0 0 8.5.7 10.4 10.4 0 0 0 1.2 3.7l1.1 1.1a8.8 8.8 0 0 1 6.2-2.5Zm0 3.2c1.5 0 2.9.6 4 1.6l1.1-1.1a7.2 7.2 0 0 0-10.2 0l1.1 1.1c1.1-1 2.5-1.6 4-1.6Zm0 3.2c.7 0 1.3.3 1.8.7L8.5 11.2 6.7 9.4c.5-.4 1.1-.7 1.8-.7Z" fill="${c}"/></svg>
    <svg width="27" height="13" viewBox="0 0 27 13"><rect x=".5" y=".5" width="23" height="12" rx="3.5" fill="none" stroke="${c}" opacity=".4"/><rect x="2" y="2" width="20" height="9" rx="2" fill="${c}"/><path d="M25 4.5v4c.8-.3 1.3-1.1 1.3-2s-.5-1.7-1.3-2Z" fill="${c}" opacity=".45"/></svg>
  </span></div>`;
};

const page = (t: Theme, w: number, h: number, body: string, extra = "") => `<meta charset="utf-8"><style>
  * { box-sizing: border-box; }
  body { margin: 0; width: ${w}px; height: ${h}px; overflow: hidden; background: ${t.bg}; color: ${t.ink}; font-family: system-ui, -apple-system, "SF Pro Text", sans-serif; -webkit-font-smoothing: antialiased; letter-spacing: -0.012em; position: relative; }
  .r { font-family: ui-rounded, "SF Pro Rounded", system-ui, sans-serif; }
  .sb { height: 54px; display: flex; align-items: center; justify-content: space-between; padding: 14px 30px 0 34px; font-weight: 600; font-size: 17px; }
  .sb.pad { height: 32px; padding: 6px 22px 0 22px; font-size: 14px; }
  .sb .d { font-weight: 500; }
  .sb .ic { display: flex; gap: 6px; align-items: center; }
  .card { background: ${t.card}; border-radius: 22px; ${t.dark ? `box-shadow: inset 0 0 0 1px ${t.line};` : `box-shadow: 0 1px 2px rgba(40,30,10,.05), 0 6px 20px -10px rgba(40,30,10,.12);`} }
  .sub { color: ${t.sub}; }
  .row { display: flex; align-items: center; gap: 12px; }
  .grow { flex: 1; min-width: 0; }
  .h1 { font-size: 32px; font-weight: 800; letter-spacing: -0.03em; }
  .h2 { font-size: 20px; font-weight: 700; letter-spacing: -0.02em; }
  .cap { font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: .06em; color: ${t.sub}; }
  .tabbar { position: absolute; left: 0; right: 0; bottom: 0; height: 86px; display: flex; justify-content: space-around; padding-top: 10px; background: ${t.dark ? "rgba(11,17,16,.92)" : "rgba(247,243,236,.94)"}; border-top: 1px solid ${t.line}; }
  .tab { display: flex; flex-direction: column; align-items: center; gap: 4px; font-size: 10.5px; font-weight: 600; color: ${t.sub}; }
  .tab.on { color: ${t.dark ? (PENNY.mint as string) : (BLOOM.coral as string)}; }
  .home { position: absolute; bottom: 8px; left: 50%; width: 140px; height: 5px; border-radius: 3px; background: ${t.ink}; transform: translateX(-50%); }
  ${extra}
</style><body>${body}</body>`;

// ---------------------------------------------------------------------------------------------
// Drawing helpers

const ring = (size: number, frac: number, color: string, track: string, stroke = 10, inner = "") => {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" style="flex:none"><circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="${track}" stroke-width="${stroke}"/><circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="${color}" stroke-width="${stroke}" stroke-linecap="round" stroke-dasharray="${(c * frac).toFixed(1)} ${c.toFixed(1)}" transform="rotate(-90 ${size / 2} ${size / 2})"/>${inner}</svg>`;
};
const bars = (w: number, h: number, values: number[], color: string, track: string, labels: string[] = [], sub = "#999", highlight = -1, hi = color) => {
  const n = values.length;
  const gap = w / n;
  const bw = gap * 0.56;
  const max = Math.max(...values);
  return `<svg width="${w}" height="${h + (labels.length ? 18 : 0)}" viewBox="0 0 ${w} ${h + (labels.length ? 18 : 0)}">${values
    .map((v, i) => {
      const bh = Math.max(6, (v / max) * (h - 6));
      const x = i * gap + (gap - bw) / 2;
      return `<rect x="${x}" y="0" width="${bw}" height="${h}" rx="${bw / 2}" fill="${track}"/><rect x="${x}" y="${h - bh}" width="${bw}" height="${bh}" rx="${bw / 2}" fill="${i === highlight ? hi : color}"/>${labels[i] ? `<text x="${x + bw / 2}" y="${h + 14}" text-anchor="middle" font-size="11" font-weight="600" fill="${sub}" font-family="system-ui">${labels[i]}</text>` : ""}`;
    })
    .join("")}</svg>`;
};
const line = (w: number, h: number, values: number[], color: string, fill = true) => {
  const max = Math.max(...values);
  const min = Math.min(...values);
  const pts = values.map((v, i) => [(i / (values.length - 1)) * w, h - 6 - ((v - min) / (max - min || 1)) * (h - 12)]);
  const d = pts.map((p, i) => `${i ? "L" : "M"}${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join("");
  const id = `g${Math.round(w * h + values[0])}`;
  return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><defs><linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${color}" stop-opacity=".35"/><stop offset="1" stop-color="${color}" stop-opacity="0"/></linearGradient></defs>${fill ? `<path d="${d}L${w} ${h}L0 ${h}Z" fill="url(#${id})"/>` : ""}<path d="${d}" fill="none" stroke="${color}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/><circle cx="${pts[pts.length - 1][0] - 2}" cy="${pts[pts.length - 1][1]}" r="5" fill="${color}" stroke="${"#fff"}" stroke-width="2"/></svg>`;
};
const donut = (size: number, parts: Array<[number, string]>, stroke: number, inner = "") => {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const total = parts.reduce((a, [v]) => a + v, 0);
  let off = 0;
  return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">${parts
    .map(([v, col]) => {
      const len = (v / total) * c;
      const s = `<circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="${col}" stroke-width="${stroke}" stroke-dasharray="${Math.max(0, len - 4).toFixed(1)} ${c.toFixed(1)}" stroke-dashoffset="${(-off).toFixed(1)}" transform="rotate(-90 ${size / 2} ${size / 2})" stroke-linecap="round"/>`;
      off += len;
      return s;
    })
    .join("")}${inner}</svg>`;
};
const heat = (cols: number, rows: number, cell: number, gap: number, colors: string[], seed = 3) => {
  let a = seed;
  const rnd = () => ((a = (a * 9301 + 49297) % 233280) / 233280);
  let s = "";
  for (let c = 0; c < cols; c++)
    for (let r = 0; r < rows; r++) {
      const v = rnd();
      const k = c > cols - 2 && r > 3 ? 0 : v > 0.82 ? 3 : v > 0.55 ? 2 : v > 0.3 ? 1 : 0;
      s += `<rect x="${c * (cell + gap)}" y="${r * (cell + gap)}" width="${cell}" height="${cell}" rx="${cell * 0.28}" fill="${colors[k]}"/>`;
    }
  return `<svg width="${cols * (cell + gap) - gap}" height="${rows * (cell + gap) - gap}">${s}</svg>`;
};
/** Simple glyphs drawn as SVG (no emoji), in a coloured circle. */
const GLYPH: Record<string, string> = {
  walk: '<circle cx="13" cy="5" r="2.2" fill="currentColor"/><path d="M10 21l2-6 2.5 2.2V21M11.5 9l-2.5 3 1.5 1.5M11.5 9l3 .5 1.5 3M11.5 9l1 5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
  water: '<path d="M12 3.5c3 4.2 5.5 7.4 5.5 10.5a5.5 5.5 0 0 1-11 0C6.5 10.9 9 7.7 12 3.5z" fill="currentColor"/>',
  book: '<path d="M4 5.5C6.5 4.3 9.2 4.3 12 5.8c2.8-1.5 5.5-1.5 8-.3V19c-2.5-1.2-5.2-1.2-8 .3-2.8-1.5-5.5-1.5-8-.3z" fill="currentColor"/>',
  moon: '<path d="M15.5 3.5A8.5 8.5 0 1 0 20.5 15a7 7 0 1 1-5-11.5z" fill="currentColor"/>',
  leaf: '<path d="M5 19C5 10 10 5 19 5c0 9-5 14-14 14z" fill="currentColor"/>',
  heart: '<path d="M12 20s-7-4.4-7-9.6A4 4 0 0 1 12 8a4 4 0 0 1 7 2.4C19 15.6 12 20 12 20z" fill="currentColor"/>',
  flame: '<path d="M12 3c1 4 6 6 6 11a6 6 0 0 1-12 0c0-3 2-4.5 2.5-7 .5 2 1.5 3 2.5 3.5C10.5 8 11 5.5 12 3z" fill="currentColor"/>',
  check: '<path d="M6.5 12.5l3.5 3.5 7.5-8" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/>',
  cart: '<path d="M4 5h2l2 10h9l2-7H7.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><circle cx="9.5" cy="19" r="1.6" fill="currentColor"/><circle cx="16.5" cy="19" r="1.6" fill="currentColor"/>',
  home: '<path d="M4 10.5L12 4l8 6.5V20a1 1 0 0 1-1 1h-4.5v-6h-5v6H5a1 1 0 0 1-1-1z" fill="currentColor"/>',
  car: '<path d="M5 15l1.5-5a2 2 0 0 1 1.9-1.4h7.2a2 2 0 0 1 1.9 1.4L19 15v3h-2v-1.5H7V18H5z" fill="currentColor"/><circle cx="8" cy="14.5" r="1.2" fill="#000" opacity=".35"/><circle cx="16" cy="14.5" r="1.2" fill="#000" opacity=".35"/>',
  plane: '<path d="M21 15.5l-8-4V6a1.5 1.5 0 0 0-3 0v5.5l-8 4V17l8-2.5V19l-2 1.5V22l3.5-1 3.5 1v-1.5L13 19v-4.5l8 2.5z" fill="currentColor"/>',
  coffee: '<path d="M5 9h11v5a5 5 0 0 1-5 5h-1a5 5 0 0 1-5-5z" fill="currentColor"/><path d="M16 11h1.5a2.5 2.5 0 0 1 0 5H16" fill="none" stroke="currentColor" stroke-width="2"/>',
  bag: '<path d="M6 8h12l-1 12H7z" fill="currentColor"/><path d="M9 8a3 3 0 0 1 6 0" fill="none" stroke="currentColor" stroke-width="2"/>',
  bolt: '<path d="M13 3L6 13h5l-1 8 7-10h-5z" fill="currentColor"/>',
  music: '<path d="M9 17V6l10-2v11" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="7" cy="17" r="2.5" fill="currentColor"/><circle cx="17" cy="15" r="2.5" fill="currentColor"/>',
  chart: '<path d="M5 19V13M10 19V8M15 19V11M20 19V5" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/>',
  grid: '<rect x="4" y="4" width="7" height="7" rx="2" fill="currentColor"/><rect x="13" y="4" width="7" height="7" rx="2" fill="currentColor"/><rect x="4" y="13" width="7" height="7" rx="2" fill="currentColor"/><rect x="13" y="13" width="7" height="7" rx="2" fill="currentColor"/>',
  user: '<circle cx="12" cy="8" r="4" fill="currentColor"/><path d="M4 20c1-4 4-6 8-6s7 2 8 6z" fill="currentColor"/>',
  plus: '<path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/>',
  gear: '<circle cx="12" cy="12" r="3" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
  sun: '<circle cx="12" cy="12" r="4.5" fill="currentColor"/><path d="M12 2.5v2.5M12 19v2.5M2.5 12H5M19 12h2.5M5.2 5.2l1.8 1.8M17 17l1.8 1.8M5.2 18.8L7 17M17 7l1.8-1.8" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
};
const g = (name: string, size: number, color: string) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" style="color:${color};flex:none">${GLYPH[name]}</svg>`;
const badge = (name: string, size: number, bg: string, fg = "#fff") => `<div style="width:${size}px;height:${size}px;border-radius:${size * 0.32}px;background:${bg};display:grid;place-items:center;flex:none">${g(name, size * 0.58, fg)}</div>`;

// ---------------------------------------------------------------------------------------------
// Bloom: habits

const B = BLOOM as typeof BLOOM & { coral: string; green: string; lilac: string; sun: string; sky: string };
const HABITS: Array<{ name: string; icon: string; color: string; done: boolean; streak: number; when: string }> = [
  { name: "Morning walk", icon: "walk", color: B.green, done: true, streak: 23, when: "7:30 · 20 min" },
  { name: "Drink water", icon: "water", color: B.sky, done: true, streak: 41, when: "6 of 8 glasses" },
  { name: "Read 20 pages", icon: "book", color: B.lilac, done: true, streak: 12, when: "Before bed" },
  { name: "Stretch", icon: "leaf", color: B.coral, done: false, streak: 5, when: "10 min" },
  { name: "Lights out by 11", icon: "moon", color: "#3d4a7a", done: false, streak: 9, when: "Tonight" },
  { name: "Call a friend", icon: "heart", color: B.sun, done: true, streak: 3, when: "Weekly" },
];
const habitRow = (h: (typeof HABITS)[number], compact = false) => `<div class="card row" style="padding:${compact ? "12px 14px" : "14px 16px"};gap:14px">
  ${badge(h.icon, compact ? 38 : 44, h.color)}
  <div class="grow"><div style="font-weight:700;font-size:${compact ? 15 : 16.5}px">${h.name}</div><div class="sub" style="font-size:13px;margin-top:2px">${h.when}</div></div>
  <div class="row" style="gap:4px;font-weight:700;font-size:13px;color:${B.coral}">${g("flame", 15, B.coral)}${h.streak}</div>
  <div style="width:30px;height:30px;border-radius:50%;display:grid;place-items:center;${h.done ? `background:${h.color}` : `box-shadow:inset 0 0 0 2.5px ${B.line}`}">${h.done ? g("check", 18, "#fff") : ""}</div>
</div>`;
const bloomTabs = (on: number) =>
  `<div class="tabbar">${[["grid", "Today"], ["chart", "Progress"], ["plus", "New"], ["flame", "Streaks"], ["user", "You"]].map(([i, n], k) => `<div class="tab ${k === on ? "on" : ""}">${g(i, 24, k === on ? B.coral : B.sub)}${n}</div>`).join("")}</div><div class="home"></div>`;
const bloomRing = (size: number) =>
  ring(size, 4 / 6, B.coral, "#f3e6dc", size * 0.11, `<text x="${size / 2}" y="${size / 2 + size * 0.02}" text-anchor="middle" font-size="${size * 0.24}" font-weight="800" fill="${B.ink}" font-family="ui-rounded, system-ui">4/6</text><text x="${size / 2}" y="${size / 2 + size * 0.19}" text-anchor="middle" font-size="${size * 0.09}" font-weight="600" fill="${B.sub}" font-family="system-ui">done today</text>`);
const week = (selected = 3) =>
  `<div class="row" style="justify-content:space-between">${["M", "T", "W", "T", "F", "S", "S"].map((d, i) => `<div style="display:flex;flex-direction:column;align-items:center;gap:6px;width:40px;padding:8px 0;border-radius:16px;${i === selected ? `background:${B.ink};color:#fff` : ""}"><span style="font-size:12px;font-weight:600;${i === selected ? "" : `color:${B.sub}`}">${d}</span><span style="font-size:16px;font-weight:700">${27 + i > 30 ? 27 + i - 30 : 27 + i}</span><span style="width:6px;height:6px;border-radius:50%;background:${i < selected ? B.green : i === selected ? B.coral : "transparent"}"></span></div>`).join("")}</div>`;

export const bloom = {
  today: () =>
    page(BLOOM, 402, 874, `${statusBar(BLOOM)}
    <div style="padding:6px 20px 0">
      <div class="row"><div class="grow"><div class="sub" style="font-size:14px;font-weight:600">Tuesday 30 September</div><div class="h1 r">Good morning, Ana</div></div></div>
      <div style="margin:16px 0">${week()}</div>
      <div class="card row" style="padding:18px;gap:18px;margin-bottom:14px;background:linear-gradient(135deg,#fff,#fff7f1)">
        ${bloomRing(112)}
        <div class="grow"><div class="h2 r">Almost there</div><div class="sub" style="font-size:14px;margin-top:4px;line-height:1.35">Two to go. Stretching takes ten minutes.</div>
        <div style="margin-top:12px;display:inline-flex;gap:6px;align-items:center;padding:7px 12px;border-radius:999px;background:#fff0e9;color:${B.coral};font-weight:700;font-size:13px">${g("flame", 14, B.coral)} 23-day streak</div></div>
      </div>
      <div class="row" style="justify-content:space-between;margin:4px 2px 10px"><span class="h2 r" style="font-size:19px">Today's habits</span><span style="color:${B.coral};font-weight:600;font-size:14px">Edit</span></div>
      <div style="display:flex;flex-direction:column;gap:10px">${HABITS.slice(0, 4).map((h) => habitRow(h)).join("")}</div>
    </div>${bloomTabs(0)}`),
  streak: () =>
    page(BLOOM, 402, 874, `${statusBar(BLOOM)}
    <div style="padding:6px 20px 0">
      <div class="h1 r">Streaks</div>
      <div class="card" style="margin-top:14px;padding:22px;text-align:center;background:linear-gradient(160deg,#ffefe6,#fff)">
        ${g("flame", 64, B.coral)}
        <div class="r" style="font-size:64px;font-weight:800;letter-spacing:-.04em;line-height:1">23</div>
        <div style="font-weight:700;font-size:17px;margin-top:4px">days in a row</div>
        <div class="sub" style="font-size:14px;margin-top:6px">Your longest yet. Keep it going tomorrow.</div>
      </div>
      <div class="card" style="margin-top:14px;padding:18px">
        <div class="row" style="justify-content:space-between;margin-bottom:12px"><span class="h2 r" style="font-size:18px">September</span><span class="sub" style="font-size:13px;font-weight:600">26 of 30 days</span></div>
        ${heat(10, 7, 26, 6, ["#f1ebe1", "#c9ecd7", "#83d3a5", B.green], 7)}
      </div>
      <div class="row" style="margin-top:14px;gap:10px">${[["walk", "Walker", B.green, "30 days"], ["book", "Bookworm", B.lilac, "12 books"], ["water", "Hydrated", B.sky, "41 days"]].map(([i, n, c, d]) => `<div class="card" style="flex:1;padding:14px 10px;text-align:center">${badge(i, 46, c)}<div style="font-weight:700;font-size:14px;margin-top:8px">${n}</div><div class="sub" style="font-size:12px">${d}</div></div>`).join("")}</div>
    </div>${bloomTabs(3)}`, `.card svg{display:block;margin:0 auto}`),
  stats: () =>
    page(BLOOM, 402, 874, `${statusBar(BLOOM)}
    <div style="padding:6px 20px 0">
      <div class="h1 r">Progress</div>
      <div class="row" style="gap:8px;margin:14px 0">${["Week", "Month", "Year"].map((t, i) => `<div style="padding:8px 16px;border-radius:999px;font-weight:600;font-size:14px;${i === 0 ? `background:${B.ink};color:#fff` : "background:#efe8dc"}">${t}</div>`).join("")}</div>
      <div class="card" style="padding:18px">
        <div class="cap">Completed</div><div class="row" style="align-items:baseline;gap:8px;margin:4px 0 14px"><span class="r" style="font-size:40px;font-weight:800">86%</span><span style="color:${B.green};font-weight:700;font-size:14px">▲ 12% vs last week</span></div>
        ${bars(322, 150, [4, 5, 6, 5, 6, 3, 4], "#ffcdb9", "#f5efe6", ["M", "T", "W", "T", "F", "S", "S"], B.sub, 2, B.coral)}
      </div>
      <div class="row" style="gap:12px;margin-top:14px">
        <div class="card" style="flex:1;padding:16px"><div class="cap">Best time</div><div class="row" style="gap:8px;margin-top:8px">${g("sun", 26, B.sun)}<span class="r" style="font-size:22px;font-weight:800">7–9 am</span></div></div>
        <div class="card" style="flex:1;padding:16px"><div class="cap">Habits</div><div class="r" style="font-size:22px;font-weight:800;margin-top:8px">6 active</div></div>
      </div>
      <div class="card" style="padding:16px;margin-top:14px"><div class="cap" style="margin-bottom:10px">Most consistent</div>${HABITS.slice(0, 3).map((h, i) => `<div class="row" style="gap:12px;margin-top:${i ? 10 : 0}px">${badge(h.icon, 32, h.color)}<span class="grow" style="font-weight:600">${h.name}</span><div style="width:110px;height:8px;border-radius:4px;background:#f1ebe1"><div style="width:${[96, 90, 78][i]}%;height:100%;border-radius:4px;background:${h.color}"></div></div></div>`).join("")}</div>
    </div>${bloomTabs(1)}`),
  habit: () =>
    page(BLOOM, 402, 874, `${statusBar(BLOOM)}
    <div style="padding:6px 20px 0">
      <div class="row" style="justify-content:space-between"><span style="color:${B.coral};font-weight:600;font-size:17px">‹ Today</span><span style="color:${B.coral};font-weight:600;font-size:17px">Edit</span></div>
      <div style="text-align:center;margin-top:18px">${badge("walk", 72, B.green)}<div class="h1 r" style="margin-top:12px">Morning walk</div><div class="sub" style="font-size:15px">Every day at 7:30 · 20 minutes</div></div>
      <div class="row" style="gap:10px;margin-top:20px">${[["23", "day streak"], ["30", "best"], ["94%", "this month"]].map(([v, l]) => `<div class="card" style="flex:1;padding:14px;text-align:center"><div class="r" style="font-size:26px;font-weight:800">${v}</div><div class="sub" style="font-size:12.5px">${l}</div></div>`).join("")}</div>
      <div class="card" style="padding:18px;margin-top:14px"><div class="cap" style="margin-bottom:12px">Minutes walked</div>${line(322, 130, [14, 18, 16, 22, 20, 25, 21, 26, 24, 30, 28, 32], B.green)}</div>
      <div class="card" style="padding:4px 16px;margin-top:14px">${[["Reminder", "7:15 am"], ["Repeat", "Every day"], ["Goal", "20 minutes"]].map(([k, v], i) => `<div class="row" style="padding:14px 0;${i ? `border-top:1px solid ${B.line}` : ""}"><span class="grow" style="font-weight:600">${k}</span><span class="sub">${v} ›</span></div>`).join("")}</div>
    </div>${bloomTabs(0)}`),
  mood: () =>
    page(BLOOM, 402, 874, `${statusBar(BLOOM)}
    <div style="padding:6px 20px 0">
      <div class="h1 r">How was today?</div>
      <div class="row" style="justify-content:space-between;margin:20px 0">${[["#ffb4a2", 0.2], ["#ffd59e", 0.5], ["#fde68a", 0.8], ["#bde7c9", 1.1], ["#a7d8f5", 1.4]].map(([c, k], i) => `<div style="width:62px;height:62px;border-radius:50%;background:${c};display:grid;place-items:center;${i === 3 ? `box-shadow:0 0 0 4px ${B.bg},0 0 0 7px ${B.green};transform:scale(1.12)` : ""}"><svg width="40" height="40" viewBox="0 0 40 40"><circle cx="14" cy="16" r="2.6" fill="${B.ink}"/><circle cx="26" cy="16" r="2.6" fill="${B.ink}"/><path d="M12 ${27 - (k as number) * 3}q8 ${(k as number) * 7 - 4} 16 0" fill="none" stroke="${B.ink}" stroke-width="2.6" stroke-linecap="round"/></svg></div>`).join("")}</div>
      <div class="card" style="padding:18px"><div class="cap">Today</div><div style="font-size:16px;line-height:1.45;margin-top:8px">Walked to the park before work. Felt calm all morning. Read on the train instead of scrolling.</div>
        <div class="row" style="gap:8px;margin-top:14px;flex-wrap:wrap">${["Calm", "Rested", "Focused"].map((t) => `<span style="padding:6px 12px;border-radius:999px;background:#eaf6ef;color:${B.green};font-weight:600;font-size:13px">${t}</span>`).join("")}</div></div>
      <div class="row" style="justify-content:space-between;margin:18px 2px 10px"><span class="h2 r" style="font-size:18px">This week</span></div>
      <div class="card" style="padding:16px">${bars(322, 90, [3, 4, 3, 5, 4, 5, 4], "#bde7c9", "#f5efe6", ["M", "T", "W", "T", "F", "S", "S"], B.sub, 3, B.green)}</div>
    </div>${bloomTabs(4)}`),
  /** iPhone Duo, open and held like a book: the habits beside the month. */
  duoWide: () =>
    page(BLOOM, 890, 626, `${statusBar(BLOOM, true)}
    <div style="display:grid;grid-template-columns:360px 1fr;gap:18px;padding:8px 22px 0;height:594px">
      <div style="display:flex;flex-direction:column;gap:9px">
        <div class="row"><div class="grow"><div class="sub" style="font-size:13px;font-weight:600">Tuesday 30 September</div><div class="r" style="font-size:26px;font-weight:800;letter-spacing:-.03em">Today</div></div>${bloomRing(70)}</div>
        ${HABITS.slice(0, 5).map((h) => habitRow(h, true)).join("")}
      </div>
      <div style="display:flex;flex-direction:column;gap:14px">
        <div class="card" style="padding:18px"><div class="row" style="justify-content:space-between;margin-bottom:12px"><span class="h2 r">September</span><span style="display:inline-flex;gap:6px;align-items:center;padding:6px 12px;border-radius:999px;background:#fff0e9;color:${B.coral};font-weight:700;font-size:13px">${g("flame", 14, B.coral)} 23-day streak</span></div>${heat(15, 7, 24, 6, ["#f1ebe1", "#c9ecd7", "#83d3a5", B.green], 5)}</div>
        <div class="row" style="gap:14px">
          <div class="card" style="flex:1.4;padding:16px"><div class="cap" style="margin-bottom:10px">This week</div>${bars(240, 90, [4, 5, 6, 5, 6, 3, 4], "#ffcdb9", "#f5efe6", ["M", "T", "W", "T", "F", "S", "S"], B.sub, 2, B.coral)}</div>
          <div class="card" style="flex:1;padding:16px;display:flex;flex-direction:column;justify-content:center"><div class="cap">Completed</div><div class="r" style="font-size:40px;font-weight:800">86%</div><div style="color:${B.green};font-weight:700;font-size:13px">▲ 12% vs last week</div></div>
        </div>
      </div>
    </div>`),
  /** iPhone Duo, open upright: everything at a glance. */
  duoTall: () =>
    page(BLOOM, 626, 890, `${statusBar(BLOOM, true)}
    <div style="padding:6px 22px 0">
      <div class="row"><div class="grow"><div class="sub" style="font-size:14px;font-weight:600">Tuesday 30 September</div><div class="h1 r">Good morning, Ana</div></div>${bloomRing(96)}</div>
      <div style="margin:16px 0">${week()}</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">${HABITS.map((h) => `<div class="card" style="padding:16px"><div class="row" style="justify-content:space-between">${badge(h.icon, 42, h.color)}<div style="width:30px;height:30px;border-radius:50%;display:grid;place-items:center;${h.done ? `background:${h.color}` : `box-shadow:inset 0 0 0 2.5px ${B.line}`}">${h.done ? g("check", 18, "#fff") : ""}</div></div><div style="font-weight:700;font-size:16px;margin-top:12px">${h.name}</div><div class="row" style="justify-content:space-between;margin-top:4px"><span class="sub" style="font-size:13px">${h.when}</span><span class="row" style="gap:3px;font-weight:700;font-size:13px;color:${B.coral}">${g("flame", 14, B.coral)}${h.streak}</span></div></div>`).join("")}</div>
      <div class="card" style="padding:16px;margin-top:12px"><div class="row" style="justify-content:space-between;margin-bottom:10px"><span class="cap">This week</span><span style="color:${B.green};font-weight:700;font-size:13px">86% done</span></div>${bars(546, 90, [4, 5, 6, 5, 6, 3, 4], "#ffcdb9", "#f5efe6", ["M", "T", "W", "T", "F", "S", "S"], B.sub, 2, B.coral)}</div>
    </div>`),
  ipad: () =>
    page(BLOOM, 1032, 1376, `${statusBar(BLOOM, true)}
    <div style="display:grid;grid-template-columns:260px 1fr;height:1344px">
      <div style="padding:16px 18px;border-right:1px solid ${B.line};display:flex;flex-direction:column;gap:6px">
        <div class="r" style="font-size:28px;font-weight:800;margin-bottom:12px">Bloom</div>
        ${[["grid", "Today", 1], ["chart", "Progress", 0], ["flame", "Streaks", 0], ["book", "Journal", 0], ["gear", "Settings", 0]].map(([i, n, on]) => `<div class="row" style="gap:10px;padding:10px 12px;border-radius:12px;font-weight:600;${on ? `background:#ffe9df;color:${B.coral}` : ""}">${g(i as string, 20, on ? B.coral : B.sub)}${n}</div>`).join("")}
      </div>
      <div style="padding:16px 26px">
        <div class="sub" style="font-size:15px;font-weight:600">Tuesday 30 September</div><div class="h1 r" style="font-size:38px">Good morning, Ana</div>
        <div style="display:grid;grid-template-columns:1.1fr 1fr;gap:16px;margin-top:18px">
          <div class="card row" style="padding:22px;gap:22px">${bloomRing(150)}<div><div class="h2 r">Almost there</div><div class="sub" style="font-size:15px;margin-top:6px;line-height:1.4">Two to go: stretching and lights out by eleven.</div></div></div>
          <div class="card" style="padding:20px"><div class="cap" style="margin-bottom:10px">This week</div>${bars(310, 120, [4, 5, 6, 5, 6, 3, 4], "#ffcdb9", "#f5efe6", ["M", "T", "W", "T", "F", "S", "S"], B.sub, 2, B.coral)}</div>
        </div>
        <div class="row" style="justify-content:space-between;margin:22px 2px 12px"><span class="h2 r">Today's habits</span><span style="color:${B.coral};font-weight:600">Edit</span></div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">${HABITS.map((h) => habitRow(h)).join("")}</div>
        <div class="card" style="padding:20px;margin-top:16px"><div class="row" style="justify-content:space-between;margin-bottom:12px"><span class="h2 r">September</span><span class="sub" style="font-weight:600">26 of 30 days</span></div>${heat(22, 7, 26, 6, ["#f1ebe1", "#c9ecd7", "#83d3a5", B.green], 9)}</div>
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;margin-top:16px">${[["walk", "Walker", B.green, "30 days of walks"], ["book", "Bookworm", B.lilac, "12 books this year"], ["water", "Hydrated", B.sky, "41 days in a row"]].map(([i, n, c, d]) => `<div class="card" style="padding:18px;text-align:center">${badge(i, 56, c)}<div style="font-weight:700;font-size:16px;margin-top:10px">${n}</div><div class="sub" style="font-size:13px;margin-top:2px">${d}</div></div>`).join("")}</div>
        <div class="card" style="padding:20px;margin-top:16px;background:linear-gradient(150deg,#ffefe6,#fff)"><div class="row" style="gap:16px">${g("flame", 54, B.coral)}<div class="grow"><div class="r" style="font-size:34px;font-weight:800;line-height:1">23 days</div><div class="sub" style="font-size:15px;margin-top:4px">Your longest streak yet. Keep it going tomorrow.</div></div><div style="padding:10px 16px;border-radius:999px;background:${B.coral};color:#fff;font-weight:700">Share</div></div></div>
      </div>
    </div>`),
  mac: () =>
    page(BLOOM, 1512, 982, `
    <div style="display:grid;grid-template-columns:240px 1fr 340px;height:982px">
      <div style="padding:18px 16px;background:#efe8dc;display:flex;flex-direction:column;gap:4px">
        <div class="row" style="gap:8px;margin-bottom:22px"><span style="width:12px;height:12px;border-radius:50%;background:#ff5f57"></span><span style="width:12px;height:12px;border-radius:50%;background:#febc2e"></span><span style="width:12px;height:12px;border-radius:50%;background:#28c840"></span></div>
        ${[["grid", "Today", 1], ["chart", "Progress", 0], ["flame", "Streaks", 0], ["book", "Journal", 0]].map(([i, n, on]) => `<div class="row" style="gap:10px;padding:8px 10px;border-radius:9px;font-weight:600;font-size:14px;${on ? `background:#ffe0d3;color:${B.coral}` : ""}">${g(i as string, 18, on ? B.coral : B.sub)}${n}</div>`).join("")}
        <div class="cap" style="margin:22px 10px 6px">Habits</div>
        ${HABITS.map((h) => `<div class="row" style="gap:10px;padding:6px 10px;font-size:14px;font-weight:500">${badge(h.icon, 22, h.color)}${h.name}</div>`).join("")}
      </div>
      <div style="padding:30px 32px">
        <div class="sub" style="font-size:15px;font-weight:600">Tuesday 30 September</div><div class="h1 r" style="font-size:36px">Good morning, Ana</div>
        <div style="margin:18px 0 20px;max-width:560px">${week()}</div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">${HABITS.map((h) => habitRow(h)).join("")}</div>
        <div class="card" style="padding:20px;margin-top:16px"><div class="row" style="justify-content:space-between;margin-bottom:12px"><span class="h2 r">September</span><span class="sub" style="font-weight:600">26 of 30 days</span></div>${heat(24, 7, 25, 6, ["#f1ebe1", "#c9ecd7", "#83d3a5", B.green], 4)}</div>
      </div>
      <div style="padding:30px 24px;border-left:1px solid ${B.line};display:flex;flex-direction:column;gap:16px">
        <div class="card" style="padding:22px;text-align:center">${bloomRing(170)}<div class="h2 r" style="margin-top:10px">Almost there</div><div class="sub" style="font-size:14px;margin-top:4px">Two habits to go</div></div>
        <div class="card" style="padding:18px"><div class="cap" style="margin-bottom:10px">This week</div>${bars(250, 110, [4, 5, 6, 5, 6, 3, 4], "#ffcdb9", "#f5efe6", ["M", "T", "W", "T", "F", "S", "S"], B.sub, 2, B.coral)}</div>
        <div class="card" style="padding:18px;background:linear-gradient(150deg,#ffefe6,#fff)"><div class="row" style="gap:10px">${g("flame", 36, B.coral)}<div><div class="r" style="font-size:30px;font-weight:800;line-height:1">23 days</div><div class="sub" style="font-size:13px">Your longest streak yet</div></div></div></div>
      </div>
    </div>`),
};

// ---------------------------------------------------------------------------------------------
// Penny: money

const P = PENNY as typeof PENNY & { mint: string; coral: string; blue: string; gold: string; violet: string };
const ACCOUNTS = [
  { name: "Everyday", sub: "Checking ··4021", amount: "$3,240.18", color: P.mint, icon: "home" },
  { name: "Rainy day", sub: "Savings ··7730", amount: "$8,915.40", color: P.blue, icon: "water" },
  { name: "Travel card", sub: "Credit ··1188", amount: "–$675.22", color: P.coral, icon: "plane" },
];
const SPEND: Array<[string, string, number, string]> = [
  ["Groceries", "cart", 412, P.mint],
  ["Home", "home", 980, P.blue],
  ["Getting around", "car", 186, P.gold],
  ["Eating out", "coffee", 264, P.coral],
  ["Shopping", "bag", 148, P.violet],
];
const TX: Array<[string, string, string, string, string]> = [
  ["Green Grocer", "Groceries", "–$46.80", "cart", P.mint],
  ["Metro card", "Getting around", "–$32.00", "car", P.gold],
  ["Salary", "Income", "+$4,200.00", "bolt", P.blue],
  ["Corner Café", "Eating out", "–$8.40", "coffee", P.coral],
  ["Streamly", "Subscriptions", "–$11.99", "music", P.violet],
  ["Rent", "Home", "–$1,650.00", "home", P.blue],
];
const pennyTabs = (on: number) =>
  `<div class="tabbar">${[["grid", "Home"], ["chart", "Spending"], ["plus", "Add"], ["bolt", "Budgets"], ["user", "You"]].map(([i, n], k) => `<div class="tab ${k === on ? "on" : ""}">${g(i, 24, k === on ? P.mint : P.sub)}${n}</div>`).join("")}</div><div class="home"></div>`;
const money = (v: string, size: number) => {
  const [whole, cents] = v.split(".");
  return `<span style="font-size:${size}px;font-weight:800;letter-spacing:-.035em">${whole}<span style="font-size:${size * 0.55}px;color:${P.sub}">.${cents}</span></span>`;
};
const account = (a: (typeof ACCOUNTS)[number]) =>
  `<div class="row" style="padding:13px 0;gap:12px">${badge(a.icon, 40, a.color + "26", a.color)}<div class="grow"><div style="font-weight:700">${a.name}</div><div class="sub" style="font-size:13px">${a.sub}</div></div><div style="font-weight:700;font-variant-numeric:tabular-nums">${a.amount}</div></div>`;
const tx = (t: (typeof TX)[number], i: number) =>
  `<div class="row" style="padding:12px 0;gap:12px;${i ? `border-top:1px solid ${P.line}` : ""}">${badge(t[3], 38, t[4] + "26", t[4])}<div class="grow"><div style="font-weight:700">${t[0]}</div><div class="sub" style="font-size:13px">${t[1]}</div></div><div style="font-weight:700;font-variant-numeric:tabular-nums;${t[2].startsWith("+") ? `color:${P.mint}` : ""}">${t[2]}</div></div>`;
const balance = [9800, 10200, 9900, 10800, 11200, 10900, 11600, 12100, 11800, 12480];
const spendDonut = (size: number) =>
  donut(size, SPEND.map(([, , v, c]) => [v, c] as [number, string]), size * 0.12, `<text x="${size / 2}" y="${size / 2 - 2}" text-anchor="middle" font-size="${size * 0.13}" font-weight="800" fill="${P.ink}" font-family="system-ui">$1,990</text><text x="${size / 2}" y="${size / 2 + size * 0.1}" text-anchor="middle" font-size="${size * 0.06}" font-weight="600" fill="${P.sub}" font-family="system-ui">spent in September</text>`);

export const penny = {
  overview: () =>
    page(PENNY, 402, 874, `${statusBar(PENNY)}
    <div style="padding:6px 20px 0">
      <div class="row"><div class="grow"><div class="sub" style="font-weight:600">Good evening, Sam</div></div>${badge("user", 36, P.line, P.sub)}</div>
      <div class="cap" style="margin-top:18px">Everything you have</div>
      <div style="margin-top:4px">${money("$11,480.36", 46)}</div>
      <div style="color:${P.mint};font-weight:700;font-size:14px;margin-top:2px">▲ $612 this month</div>
      <div style="margin:14px -20px 0">${line(402, 150, balance, P.mint)}</div>
      <div class="row" style="gap:8px;margin:6px 0 16px">${["1W", "1M", "3M", "1Y", "All"].map((t, i) => `<div style="flex:1;text-align:center;padding:7px 0;border-radius:10px;font-weight:700;font-size:13px;${i === 1 ? `background:${P.card};box-shadow:inset 0 0 0 1px ${P.line}` : `color:${P.sub}`}">${t}</div>`).join("")}</div>
      <div class="card" style="padding:4px 16px">${ACCOUNTS.map(account).join(`<div style="height:1px;background:${P.line}"></div>`)}</div>
      <div class="card row" style="padding:16px;margin-top:12px;gap:12px">${badge("bolt", 40, P.gold + "26", P.gold)}<div class="grow"><div style="font-weight:700">You're $84 under budget</div><div class="sub" style="font-size:13px">Nice. 6 days left in September.</div></div></div>
    </div>${pennyTabs(0)}`),
  spending: () =>
    page(PENNY, 402, 874, `${statusBar(PENNY)}
    <div style="padding:6px 20px 0">
      <div class="h1">Spending</div><div class="sub" style="font-weight:600;margin-top:2px">September</div>
      <div style="display:grid;place-items:center;margin:18px 0">${spendDonut(240)}</div>
      <div class="card" style="padding:6px 16px">${SPEND.map(([n, i, v, c], k) => `<div class="row" style="padding:12px 0;gap:12px;${k ? `border-top:1px solid ${P.line}` : ""}">${badge(i, 36, c + "26", c)}<div class="grow"><div style="font-weight:700">${n}</div><div style="height:6px;border-radius:3px;background:${P.line};margin-top:7px"><div style="width:${Math.round((v / 980) * 100)}%;height:100%;border-radius:3px;background:${c}"></div></div></div><div style="font-weight:700;width:64px;text-align:right">$${v}</div></div>`).join("")}</div>
    </div>${pennyTabs(1)}`),
  activity: () =>
    page(PENNY, 402, 874, `${statusBar(PENNY)}
    <div style="padding:6px 20px 0">
      <div class="h1">Activity</div>
      <div class="row" style="gap:10px;margin:14px 0;padding:11px 14px;border-radius:14px;background:${P.card};box-shadow:inset 0 0 0 1px ${P.line}"><svg width="18" height="18" viewBox="0 0 24 24"><circle cx="11" cy="11" r="6.5" fill="none" stroke="${P.sub}" stroke-width="2"/><path d="M16 16l4.5 4.5" stroke="${P.sub}" stroke-width="2" stroke-linecap="round"/></svg><span class="sub">Search payments</span></div>
      <div class="cap" style="margin:6px 2px 4px">Today</div>
      <div class="card" style="padding:0 16px">${TX.slice(0, 3).map(tx).join("")}</div>
      <div class="cap" style="margin:16px 2px 4px">Yesterday</div>
      <div class="card" style="padding:0 16px">${TX.slice(3).map(tx).join("")}</div>
    </div>${pennyTabs(0)}`),
  budgets: () =>
    page(PENNY, 402, 874, `${statusBar(PENNY)}
    <div style="padding:6px 20px 0">
      <div class="h1">Budgets</div><div class="sub" style="font-weight:600;margin-top:2px">6 days left in September</div>
      <div class="card" style="padding:18px;margin-top:16px"><div class="row" style="justify-content:space-between"><span class="cap">Left to spend</span><span style="color:${P.mint};font-weight:700;font-size:13px">On track</span></div><div style="margin-top:6px">${money("$842.00", 40)}</div><div style="height:12px;border-radius:6px;background:${P.line};margin-top:12px;overflow:hidden;display:flex">${SPEND.map(([, , v, c]) => `<div style="width:${(v / 2832) * 100}%;background:${c}"></div>`).join("")}</div></div>
      <div style="display:flex;flex-direction:column;gap:10px;margin-top:14px">${SPEND.map(([n, i, v, c]) => {
        const cap = Math.round(v * 1.3 / 50) * 50;
        return `<div class="card" style="padding:14px 16px"><div class="row" style="gap:12px">${badge(i, 34, c + "26", c)}<span class="grow" style="font-weight:700">${n}</span><span style="font-weight:700">$${v}<span class="sub" style="font-weight:600"> of $${cap}</span></span></div><div style="height:8px;border-radius:4px;background:${P.line};margin-top:10px"><div style="width:${Math.round((v / cap) * 100)}%;height:100%;border-radius:4px;background:${c}"></div></div></div>`;
      }).join("")}</div>
    </div>${pennyTabs(3)}`),
  goals: () =>
    page(PENNY, 402, 874, `${statusBar(PENNY)}
    <div style="padding:6px 20px 0">
      <div class="h1">Goals</div>
      <div class="card" style="padding:20px;margin-top:16px;text-align:center;background:linear-gradient(160deg,#16302a,${P.card})">${ring(170, 0.68, P.mint, P.line, 16, `<text x="85" y="84" text-anchor="middle" font-size="34" font-weight="800" fill="${P.ink}" font-family="system-ui">68%</text><text x="85" y="106" text-anchor="middle" font-size="13" font-weight="600" fill="${P.sub}" font-family="system-ui">$2,720 of $4,000</text>`)}<div class="h2" style="margin-top:10px">Japan in April</div><div class="sub" style="font-size:14px;margin-top:4px">$160 a week gets you there by March.</div></div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:12px">${[["New laptop", 0.42, P.blue, "plus"], ["Emergency fund", 0.9, P.gold, "heart"], ["Bike", 0.25, P.coral, "car"], ["Gifts", 0.6, P.violet, "bag"]].map(([n, f, c, i]) => `<div class="card" style="padding:16px">${ring(64, f as number, c as string, P.line, 8)}<div style="font-weight:700;margin-top:10px">${n}</div><div class="sub" style="font-size:13px">${Math.round((f as number) * 100)}% saved</div></div>`).join("")}</div>
    </div>${pennyTabs(3)}`),
  duoWide: () =>
    page(PENNY, 890, 626, `${statusBar(PENNY, true)}
    <div style="display:grid;grid-template-columns:330px 1fr;gap:18px;padding:8px 22px 0;height:594px">
      <div style="display:flex;flex-direction:column;gap:12px">
        <div><div class="cap">Everything you have</div><div style="margin-top:2px">${money("$11,480.36", 38)}</div><div style="color:${P.mint};font-weight:700;font-size:13px">▲ $612 this month</div></div>
        <div class="card" style="padding:2px 16px">${ACCOUNTS.map(account).join(`<div style="height:1px;background:${P.line}"></div>`)}</div>
        <div class="card row" style="padding:14px;gap:12px">${badge("bolt", 36, P.gold + "26", P.gold)}<div class="grow"><div style="font-weight:700;font-size:15px">$84 under budget</div><div class="sub" style="font-size:12.5px">6 days left in September</div></div></div>
      </div>
      <div style="display:flex;flex-direction:column;gap:14px">
        <div class="card" style="padding:16px 18px"><div class="row" style="justify-content:space-between;margin-bottom:8px"><span class="h2">Balance</span><div class="row" style="gap:6px">${["1M", "3M", "1Y"].map((t, i) => `<span style="padding:5px 10px;border-radius:8px;font-weight:700;font-size:12px;${i === 0 ? `background:${P.line}` : `color:${P.sub}`}">${t}</span>`).join("")}</div></div>${line(460, 150, balance, P.mint)}</div>
        <div class="row" style="gap:14px;align-items:stretch">
          <div class="card" style="padding:14px;display:grid;place-items:center">${spendDonut(170)}</div>
          <div class="card grow" style="padding:0 16px">${TX.slice(0, 3).map(tx).join("")}</div>
        </div>
      </div>
    </div>`),
  duoTall: () =>
    page(PENNY, 626, 890, `${statusBar(PENNY, true)}
    <div style="padding:6px 22px 0">
      <div class="cap">Everything you have</div><div style="margin-top:2px">${money("$11,480.36", 50)}</div><div style="color:${P.mint};font-weight:700;font-size:14px">▲ $612 this month</div>
      <div class="card" style="padding:14px 16px;margin-top:14px">${line(548, 170, balance, P.mint)}</div>
      <div class="row" style="gap:12px;margin-top:12px;align-items:stretch">
        <div class="card" style="padding:14px;display:grid;place-items:center">${spendDonut(200)}</div>
        <div class="card grow" style="padding:2px 16px">${ACCOUNTS.map(account).join(`<div style="height:1px;background:${P.line}"></div>`)}</div>
      </div>
      <div class="card" style="padding:0 16px;margin-top:12px">${TX.slice(0, 4).map(tx).join("")}</div>
    </div>`),
  ipad: () =>
    page(PENNY, 1032, 1376, `${statusBar(PENNY, true)}
    <div style="display:grid;grid-template-columns:250px 1fr;height:1344px">
      <div style="padding:16px 18px;border-right:1px solid ${P.line};display:flex;flex-direction:column;gap:6px">
        <div style="font-size:28px;font-weight:800;margin-bottom:12px">Penny</div>
        ${[["grid", "Home", 1], ["chart", "Spending", 0], ["bolt", "Budgets", 0], ["heart", "Goals", 0], ["gear", "Settings", 0]].map(([i, n, on]) => `<div class="row" style="gap:10px;padding:10px 12px;border-radius:12px;font-weight:600;${on ? `background:${P.mint}22;color:${P.mint}` : ""}">${g(i as string, 20, on ? P.mint : P.sub)}${n}</div>`).join("")}
      </div>
      <div style="padding:16px 26px">
        <div class="cap">Everything you have</div><div>${money("$11,480.36", 54)}</div><div style="color:${P.mint};font-weight:700">▲ $612 this month</div>
        <div class="card" style="padding:18px;margin-top:16px">${line(700, 220, balance, P.mint)}</div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-top:16px">
          <div class="card" style="padding:2px 18px">${ACCOUNTS.map(account).join(`<div style="height:1px;background:${P.line}"></div>`)}</div>
          <div class="card" style="padding:16px;display:grid;place-items:center">${spendDonut(220)}</div>
        </div>
        <div class="card" style="padding:0 18px;margin-top:16px">${TX.map(tx).join("")}</div>
      </div>
    </div>`),
  mac: () =>
    page(PENNY, 1512, 982, `
    <div style="display:grid;grid-template-columns:230px 1fr;height:982px">
      <div style="padding:18px 16px;background:#0f1715;border-right:1px solid ${P.line};display:flex;flex-direction:column;gap:4px">
        <div class="row" style="gap:8px;margin-bottom:22px"><span style="width:12px;height:12px;border-radius:50%;background:#ff5f57"></span><span style="width:12px;height:12px;border-radius:50%;background:#febc2e"></span><span style="width:12px;height:12px;border-radius:50%;background:#28c840"></span></div>
        ${[["grid", "Home", 1], ["chart", "Spending", 0], ["bolt", "Budgets", 0], ["heart", "Goals", 0]].map(([i, n, on]) => `<div class="row" style="gap:10px;padding:8px 10px;border-radius:9px;font-weight:600;font-size:14px;${on ? `background:${P.mint}22;color:${P.mint}` : ""}">${g(i as string, 18, on ? P.mint : P.sub)}${n}</div>`).join("")}
        <div class="cap" style="margin:22px 10px 6px">Accounts</div>
        ${ACCOUNTS.map((a) => `<div class="row" style="gap:10px;padding:6px 10px;font-size:14px"><span style="width:8px;height:8px;border-radius:50%;background:${a.color}"></span><span class="grow">${a.name}</span><span class="sub" style="font-variant-numeric:tabular-nums">${a.amount}</span></div>`).join("")}
      </div>
      <div style="padding:28px 32px;display:grid;grid-template-columns:1fr 360px;gap:22px;align-content:start">
        <div><div class="cap">Everything you have</div><div>${money("$11,480.36", 52)}</div><div style="color:${P.mint};font-weight:700">▲ $612 this month</div></div><div></div>
        <div class="card" style="padding:18px">${line(780, 260, balance, P.mint)}</div>
        <div class="card" style="padding:16px;display:grid;place-items:center">${spendDonut(260)}</div>
        <div class="card" style="padding:0 18px;grid-column:1 / span 2">${TX.map(tx).join("")}</div>
      </div>
    </div>`),
};
