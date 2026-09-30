/**
 * "Mise", a made-up recipe app, drawn in HTML so the landing page can show Screenshotter's output
 * without using anyone's real app. It follows iOS dark mode closely (system font, grouped lists,
 * one tint colour) and uses real food photos, so the captures read like a shipping app.
 * `scripts/site-assets.ts` renders each screen at the device's pixel scale like a real capture.
 */
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const PHOTOS = path.join(path.dirname(fileURLToPath(import.meta.url)), "photos");
const ph = (name: string) => pathToFileURL(path.join(PHOTOS, `${name}.jpg`)).href;

const C = {
  bg: "#000000",
  cell: "#1c1c1e",
  cell2: "#2c2c2e",
  sep: "#38383a",
  label: "#ffffff",
  sec: "rgba(235,235,245,.6)",
  ter: "rgba(235,235,245,.3)",
  tint: "#7ccf9d",
  tintInk: "#06150c",
};

const icon = {
  search: '<circle cx="11" cy="11" r="6.5" fill="none" stroke="currentColor" stroke-width="2"/><path d="M16 16l4.5 4.5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
  back: '<path d="M14.5 5l-7 7 7 7" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>',
  heart: '<path d="M12 20s-7-4.4-7-9.6A4 4 0 0 1 12 8a4 4 0 0 1 7 2.4C19 15.6 12 20 12 20z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>',
  share: '<path d="M12 3v12M8 7l4-4 4 4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M6 11v8a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1v-8" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
  clock: '<circle cx="12" cy="12" r="8.5" fill="none" stroke="currentColor" stroke-width="1.9"/><path d="M12 7.5V12l3 2" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/>',
  people: '<circle cx="9" cy="8" r="3.2" fill="none" stroke="currentColor" stroke-width="1.9"/><path d="M3.5 19c.6-3.2 2.8-5 5.5-5s4.9 1.8 5.5 5" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/><path d="M16 5.2a3 3 0 0 1 0 5.6M17.5 14.2c1.6.6 2.7 2.3 3 4.8" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/>',
  level: '<path d="M5 19V14M12 19V9M19 19V5" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/>',
  close: '<path d="M7 7l10 10M17 7L7 17" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>',
  plus: '<path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>',
  check: '<path d="M6.5 12.5l3.5 3.5 7.5-8" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>',
  home: '<path d="M4 10.5L12 4l8 6.5V20a1 1 0 0 1-1 1h-4.5v-6h-5v6H5a1 1 0 0 1-1-1z" fill="currentColor"/>',
  book: '<path d="M4 5.5C6.5 4.3 9.2 4.3 12 5.8c2.8-1.5 5.5-1.5 8-.3V19c-2.5-1.2-5.2-1.2-8 .3-2.8-1.5-5.5-1.5-8-.3z" fill="currentColor"/>',
  bookmark: '<path d="M6.5 3.5h11a1 1 0 0 1 1 1V21l-6.5-4.2L5.5 21V4.5a1 1 0 0 1 1-1z" fill="currentColor"/>',
  list: '<circle cx="5" cy="6.5" r="1.6" fill="currentColor"/><circle cx="5" cy="12" r="1.6" fill="currentColor"/><circle cx="5" cy="17.5" r="1.6" fill="currentColor"/><path d="M9.5 6.5H20M9.5 12H20M9.5 17.5H20" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
  calendar: '<rect x="4" y="5" width="16" height="15" rx="3" fill="none" stroke="currentColor" stroke-width="1.9"/><path d="M4 10h16M8.5 3v4M15.5 3v4" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/>',
};
const svg = (name: keyof typeof icon, size: number, color = "currentColor") =>
  `<svg width="${size}" height="${size}" viewBox="0 0 24 24" style="color:${color};flex:none">${icon[name]}</svg>`;

const statusBar = () => `
<div class="sb">
  <span class="t">9:41</span>
  <span class="ic">
    <svg width="19" height="12" viewBox="0 0 19 12"><rect x="0" y="8" width="3" height="4" rx="1" fill="#fff"/><rect x="5" y="5.5" width="3" height="6.5" rx="1" fill="#fff"/><rect x="10" y="3" width="3" height="9" rx="1" fill="#fff"/><rect x="15" y="0" width="3" height="12" rx="1" fill="#fff"/></svg>
    <svg width="17" height="12" viewBox="0 0 17 12"><path d="M8.5 2.3c2.4 0 4.6.9 6.2 2.5l1.1-1.1A10.4 10.4 0 0 0 8.5.7 10.4 10.4 0 0 0 1.2 3.7l1.1 1.1a8.8 8.8 0 0 1 6.2-2.5Zm0 3.2c1.5 0 2.9.6 4 1.6l1.1-1.1a7.2 7.2 0 0 0-10.2 0l1.1 1.1c1.1-1 2.5-1.6 4-1.6Zm0 3.2c.7 0 1.3.3 1.8.7L8.5 11.2 6.7 9.4c.5-.4 1.1-.7 1.8-.7Z" fill="#fff"/></svg>
    <svg width="27" height="13" viewBox="0 0 27 13"><rect x=".5" y=".5" width="23" height="12" rx="3.5" fill="none" stroke="#fff" opacity=".4"/><rect x="2" y="2" width="20" height="9" rx="2" fill="#fff"/><path d="M25 4.5v4c.8-.3 1.3-1.1 1.3-2s-.5-1.7-1.3-2Z" fill="#fff" opacity=".45"/></svg>
  </span>
</div>`;

const base = (w: number, h: number, extra = "") => `
<meta charset="utf-8">
<style>
  * { box-sizing: border-box; }
  body { margin: 0; width: ${w}px; height: ${h}px; overflow: hidden; background: ${C.bg}; color: ${C.label}; font-family: system-ui, -apple-system, "SF Pro Text", sans-serif; -webkit-font-smoothing: antialiased; letter-spacing: -0.012em; position: relative; }
  img { display: block; object-fit: cover; }
  .sb { position: relative; z-index: 5; height: 54px; display: flex; align-items: center; justify-content: space-between; padding: 6px 30px 0 52px; color: #fff; }
  .sb .t { font: 600 17px system-ui, -apple-system, sans-serif; letter-spacing: -0.02em; }
  .sb .ic { display: flex; gap: 6px; align-items: center; }
  .sec { color: ${C.sec}; }
  .tabs { position: absolute; left: 0; right: 0; bottom: 0; height: 84px; display: flex; justify-content: space-around; padding-top: 7px; background: rgba(20,20,22,.94); border-top: .5px solid ${C.sep}; }
  .tab { display: flex; flex-direction: column; align-items: center; gap: 3px; font: 500 10px system-ui, -apple-system, sans-serif; letter-spacing: 0; color: #8e8e93; width: 80px; }
  .tab.on { color: ${C.tint}; }
  .h-large { font: 700 34px/1.1 system-ui, -apple-system, sans-serif; letter-spacing: -0.028em; }
  ${extra}
</style>`;

const tabBar = (active: number) =>
  `<div class="tabs">${(
    [
      ["home", "Tonight"],
      ["book", "Browse"],
      ["bookmark", "Saved"],
      ["list", "Groceries"],
    ] as const
  )
    .map(([ic, name], i) => `<div class="tab ${i === active ? "on" : ""}">${svg(ic, 27)}${name}</div>`)
    .join("")}</div>`;

// ---------------------------------------------------------------------------------------------
// iPhone (402 × 874 pt)

export const tonight = () => `${base(402, 874, `
  .hdr { display: flex; justify-content: space-between; align-items: flex-end; padding: 8px 20px 0; }
  .date { font: 600 13px system-ui, -apple-system, sans-serif; letter-spacing: 0; color: ${C.sec}; text-transform: uppercase; }
  .av { width: 38px; height: 38px; border-radius: 50%; background: ${C.cell2}; display: grid; place-items: center; font: 600 15px system-ui, -apple-system, sans-serif; color: #d1d1d6; margin-bottom: 4px; }
  .search { margin: 14px 16px 0; height: 38px; border-radius: 11px; background: ${C.cell}; display: flex; align-items: center; gap: 7px; padding: 0 10px; color: #8e8e93; font-size: 17px; }
  .feat { position: relative; margin: 18px 16px 0; height: 222px; border-radius: 16px; overflow: hidden; }
  .feat img { width: 100%; height: 100%; }
  .pill { position: absolute; left: 12px; top: 12px; padding: 5px 10px; border-radius: 20px; background: rgba(0,0,0,.55); backdrop-filter: blur(10px); font: 600 12.5px system-ui, -apple-system, sans-serif; letter-spacing: 0; }
  .ft { margin: 12px 20px 0; font: 600 21px system-ui, -apple-system, sans-serif; letter-spacing: -0.02em; }
  .fm { margin: 3px 20px 0; font-size: 15px; color: ${C.sec}; }
  .shead { display: flex; justify-content: space-between; align-items: baseline; margin: 26px 20px 10px; }
  .shead b { font: 700 20px system-ui, -apple-system, sans-serif; letter-spacing: -0.02em; }
  .shead span { color: ${C.tint}; font-size: 16px; }
  .row { display: flex; gap: 12px; padding-left: 16px; }
  .card { width: 168px; flex: none; }
  .card img { width: 168px; height: 118px; border-radius: 12px; }
  .card b { display: block; margin-top: 8px; font: 600 15px system-ui, -apple-system, sans-serif; letter-spacing: -0.01em; }
  .card span { font-size: 13px; color: ${C.sec}; }
`)}
<body>${statusBar()}
  <div class="hdr"><div><div class="date">Tuesday 30 September</div><div class="h-large">Tonight</div></div><div class="av">AM</div></div>
  <div class="search">${svg("search", 18)}Recipes, ingredients, cuisines</div>
  <div class="feat"><img src="${ph("ramen")}"><span class="pill">Chef's pick</span></div>
  <div class="ft">Miso ramen with a jammy egg</div>
  <div class="fm">35 min · Medium · 640 kcal</div>
  <div class="shead"><b>Quick weeknight dinners</b><span>See all</span></div>
  <div class="row">
    <div class="card"><img src="${ph("tacos")}"><b>Crispy fish tacos</b><span>20 min · Easy</span></div>
    <div class="card"><img src="${ph("salmon")}"><b>Seared salmon, greens</b><span>25 min · Easy</span></div>
    <div class="card"><img src="${ph("curry")}"><b>Potato curry</b><span>35 min</span></div>
  </div>
  ${tabBar(0)}
</body>`;

export const recipe = () => `${base(402, 874, `
  .hero { position: absolute; left: 0; top: 0; width: 402px; height: 372px; }
  .scrim { position: absolute; left: 0; right: 0; top: 0; height: 120px; background: linear-gradient(rgba(0,0,0,.45), rgba(0,0,0,0)); }
  .btns { position: absolute; left: 16px; right: 16px; top: 60px; display: flex; justify-content: space-between; z-index: 4; }
  .btns div { display: flex; gap: 10px; }
  .cb { width: 38px; height: 38px; border-radius: 50%; background: rgba(28,28,30,.72); backdrop-filter: blur(14px); display: grid; place-items: center; color: #fff; }
  .sheet { position: absolute; left: 0; right: 0; top: 344px; bottom: 0; background: ${C.bg}; border-radius: 26px 26px 0 0; padding: 22px 20px 0; }
  h1 { margin: 0; font: 700 28px/1.12 system-ui, -apple-system, sans-serif; letter-spacing: -0.03em; }
  .by { margin-top: 6px; font-size: 15px; color: ${C.sec}; }
  .meta { display: flex; margin-top: 18px; padding: 12px 0; border-top: .5px solid ${C.sep}; border-bottom: .5px solid ${C.sep}; }
  .meta div { flex: 1; display: flex; flex-direction: column; align-items: center; gap: 5px; font: 600 14px system-ui, -apple-system, sans-serif; letter-spacing: 0; }
  .meta div + div { border-left: .5px solid ${C.sep}; }
  .meta small { font: 400 12px system-ui, -apple-system, sans-serif; color: ${C.sec}; }
  .seg { margin-top: 18px; display: flex; padding: 2px; border-radius: 9px; background: rgba(118,118,128,.24); }
  .seg div { flex: 1; text-align: center; padding: 6px 0; border-radius: 7px; font: 600 13px system-ui, -apple-system, sans-serif; letter-spacing: 0; }
  .seg .on { background: #636366; }
  .list { margin-top: 14px; border-radius: 12px; background: ${C.cell}; }
  .li { display: flex; justify-content: space-between; padding: 12px 16px; font-size: 16px; }
  .li + .li { box-shadow: inset 0 .5px 0 ${C.sep}; }
  .li b { font-weight: 600; }
  .li span { color: ${C.sec}; }
  .go { position: absolute; left: 20px; right: 20px; bottom: 34px; height: 52px; border-radius: 14px; background: ${C.tint}; color: ${C.tintInk}; display: grid; place-items: center; font: 600 17px system-ui, -apple-system, sans-serif; letter-spacing: -0.01em; }
`)}
<body>
  <img class="hero" src="${ph("ramen")}"><div class="scrim"></div>
  ${statusBar()}
  <div class="btns"><span class="cb">${svg("back", 20)}</span><div><span class="cb">${svg("heart", 19)}</span><span class="cb">${svg("share", 19)}</span></div></div>
  <div class="sheet">
    <h1>Miso ramen with a jammy egg</h1>
    <div class="by">Mise Kitchen · 4.8 ★ (1,204)</div>
    <div class="meta"><div>${svg("clock", 18, C.tint)}35 min<small>total</small></div><div>${svg("people", 18, C.tint)}2<small>servings</small></div><div>${svg("level", 18, C.tint)}Medium<small>skill</small></div></div>
    <div class="seg"><div class="on">Ingredients</div><div>Steps</div><div>Notes</div></div>
    <div class="list">
      <div class="li"><div><b>2 portions</b> fresh ramen noodles</div></div>
      <div class="li"><div><b>3 tbsp</b> white miso</div></div>
      <div class="li"><div><b>4 cups</b> chicken stock</div></div>
      <div class="li"><div><b>2</b> eggs, soft-boiled</div><span>6½ min</span></div>
      <div class="li"><div><b>2</b> spring onions, sliced</div></div>
    </div>
  </div>
  <div class="go">Start cooking</div>
</body>`;

export const cook = () => `${base(402, 874, `
  .top { display: flex; align-items: center; justify-content: space-between; padding: 8px 16px 0; }
  .x { width: 34px; height: 34px; border-radius: 50%; background: ${C.cell}; display: grid; place-items: center; color: #aeaeb2; }
  .top b { font: 600 17px system-ui, -apple-system, sans-serif; }
  .top span { color: ${C.tint}; font-size: 17px; }
  .prog { display: flex; gap: 5px; margin: 16px 20px 0; }
  .prog i { flex: 1; height: 4px; border-radius: 2px; background: ${C.cell2}; }
  .prog i.on { background: ${C.tint}; }
  .step { margin: 30px 20px 0; font: 600 29px/1.24 system-ui, -apple-system, sans-serif; letter-spacing: -0.028em; }
  .step span { color: ${C.sec}; }
  .chips { display: flex; flex-wrap: wrap; gap: 8px; margin: 22px 20px 0; }
  .chip { display: flex; align-items: center; gap: 7px; padding: 7px 12px; border-radius: 18px; background: ${C.cell}; font-size: 14px; }
  .chip i { width: 7px; height: 7px; border-radius: 50%; background: ${C.tint}; }
  .timer { margin: 30px 16px 0; padding: 18px 20px 20px; border-radius: 22px; background: ${C.cell}; }
  .timer .l { display: flex; justify-content: space-between; font-size: 15px; color: ${C.sec}; }
  .timer .v { margin-top: 4px; font: 300 64px/1 system-ui, -apple-system, sans-serif; letter-spacing: -0.04em; font-variant-numeric: tabular-nums; }
  .bar { margin-top: 16px; height: 6px; border-radius: 3px; background: ${C.cell2}; }
  .bar i { display: block; width: 38%; height: 100%; border-radius: 3px; background: ${C.tint}; }
  .tb { display: flex; gap: 10px; margin-top: 18px; }
  .tb div { flex: 1; height: 44px; border-radius: 12px; display: grid; place-items: center; font: 600 16px system-ui, -apple-system, sans-serif; background: ${C.cell2}; }
  .tb .p { background: ${C.tint}; color: ${C.tintInk}; }
  .nav { position: absolute; left: 16px; right: 16px; bottom: 34px; display: flex; gap: 10px; }
  .nav div { flex: 1; height: 52px; border-radius: 14px; display: grid; place-items: center; font: 600 17px system-ui, -apple-system, sans-serif; background: ${C.cell}; }
  .nav .n { background: #fff; color: #000; }
`)}
<body>${statusBar()}
  <div class="top"><span class="x">${svg("close", 16)}</span><b>Step 3 of 6</b><span>Ingredients</span></div>
  <div class="prog"><i class="on"></i><i class="on"></i><i class="on"></i><i></i><i></i><i></i></div>
  <div class="step">Whisk the miso into the hot stock, then simmer gently for 5 minutes. <span>Don't let it boil.</span></div>
  <div class="chips"><div class="chip"><i></i>3 tbsp white miso</div><div class="chip"><i></i>4 cups chicken stock</div></div>
  <div class="timer">
    <div class="l"><span>Simmer</span><span>5 min</span></div>
    <div class="v">04:36</div>
    <div class="bar"><i></i></div>
    <div class="tb"><div class="p">Pause</div><div>+1 min</div></div>
  </div>
  <div class="nav"><div>Previous</div><div class="n">Next step</div></div>
</body>`;

export const groceries = () => {
  const row = (name: string, qty: string, done = false) =>
    `<div class="gi ${done ? "done" : ""}"><span class="ck">${done ? svg("check", 16, C.tintInk) : ""}</span><span class="nm">${name}</span><span class="q">${qty}</span></div>`;
  return `${base(402, 874, `
  .hd { display: flex; justify-content: space-between; align-items: flex-end; padding: 8px 20px 0; }
  .hd .sec { font-size: 15px; margin-top: 2px; }
  .add { width: 34px; height: 34px; border-radius: 50%; background: ${C.cell}; display: grid; place-items: center; color: ${C.tint}; margin-bottom: 20px; }
  .gh { margin: 22px 36px 7px; font: 400 13px system-ui, -apple-system, sans-serif; letter-spacing: 0; color: ${C.sec}; text-transform: uppercase; }
  .grp { margin: 0 16px; border-radius: 12px; background: ${C.cell}; }
  .gi { display: flex; align-items: center; gap: 12px; padding: 0 16px; height: 46px; font-size: 17px; }
  .gi + .gi { box-shadow: inset 50px .5px 0 -49.5px ${C.sep}; }
  .ck { width: 24px; height: 24px; border-radius: 50%; border: 1.6px solid #48484a; display: grid; place-items: center; flex: none; }
  .gi .nm { flex: 1; }
  .gi .q { color: ${C.sec}; font-size: 15px; }
  .gi.done .ck { background: ${C.tint}; border-color: ${C.tint}; }
  .gi.done .nm { color: ${C.ter}; text-decoration: line-through; }
`)}
<body>${statusBar()}
  <div class="hd"><div><div class="h-large">Groceries</div><div class="sec">11 items for 3 recipes</div></div><span class="add">${svg("plus", 18)}</span></div>
  <div class="gh">Produce</div>
  <div class="grp">${row("Spring onions", "1 bunch")}${row("Bok choy", "2 heads", true)}${row("Limes", "2")}${row("Coriander", "1 bunch")}</div>
  <div class="gh">Noodles &amp; pantry</div>
  <div class="grp">${row("Fresh ramen noodles", "2 portions")}${row("White miso", "1 tub", true)}${row("Sesame oil", "")}${row("Nori", "1 pack")}</div>
  <div class="gh">Fish &amp; eggs</div>
  <div class="grp">${row("Eggs", "6")}${row("Salmon fillets", "2", true)}${row("Cod, skinless", "400 g")}</div>
  ${tabBar(3)}
</body>`;
};

export const saved = () => {
  const tile = (p: string, name: string, meta: string) => `<div class="t"><img src="${ph(p)}"><b>${name}</b><span>${meta}</span></div>`;
  return `${base(402, 874, `
  .hd { padding: 8px 20px 0; display: flex; justify-content: space-between; align-items: flex-end; }
  .hd span { color: ${C.tint}; font-size: 17px; margin-bottom: 8px; }
  .chips { display: flex; gap: 8px; padding: 14px 20px 0; }
  .chips div { padding: 7px 14px; border-radius: 18px; background: ${C.cell}; font: 500 14px system-ui, -apple-system, sans-serif; color: #d1d1d6; white-space: nowrap; }
  .chips .on { background: #fff; color: #000; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px 12px; padding: 18px 16px 0; }
  .t img { width: 100%; height: 150px; border-radius: 14px; }
  .t b { display: block; margin-top: 8px; font: 600 15px system-ui, -apple-system, sans-serif; }
  .t span { font-size: 13px; color: ${C.sec}; }
`)}
<body>${statusBar()}
  <div class="hd"><div class="h-large">Saved</div><span>Edit</span></div>
  <div class="chips"><div class="on">All 24</div><div>Weeknight</div><div>Date night</div><div>Veg</div></div>
  <div class="grid">
    ${tile("ramen", "Miso ramen", "35 min")}${tile("salmon", "Seared salmon", "25 min")}
    ${tile("shakshuka", "Shakshuka", "30 min")}${tile("tacos", "Fish tacos", "20 min")}
    ${tile("curry", "Potato curry", "35 min")}${tile("bowl", "Harvest bowl", "15 min")}
  </div>
  ${tabBar(2)}
</body>`;
};

// ---------------------------------------------------------------------------------------------
// iPad Pro 13 (1032 × 1376 pt), Apple Watch 46mm (208 × 248 pt), MacBook Pro 14 (1512 × 982 pt)

export const ipad = () => {
  const card = (p: string, name: string, meta: string) => `<div class="c"><img src="${ph(p)}"><b>${name}</b><span>${meta}</span></div>`;
  return `${base(1032, 1376, `
  body { display: grid; grid-template-columns: 290px 1fr; grid-template-rows: 44px 1fr; }
  .sb { grid-column: 1 / -1; height: 44px; padding: 4px 28px 0 36px; }
  aside { background: ${C.cell}; padding: 18px 14px; }
  .brand { font: 800 28px system-ui, -apple-system, sans-serif; letter-spacing: -0.04em; margin: 4px 10px 20px; }
  .nav { display: flex; align-items: center; gap: 12px; padding: 10px 12px; border-radius: 10px; font: 500 17px system-ui, -apple-system, sans-serif; color: #e5e5ea; }
  .nav svg { color: ${C.tint}; }
  .nav.on { background: ${C.tint}; color: ${C.tintInk}; }
  .nav.on svg { color: ${C.tintInk}; }
  .gh { margin: 26px 12px 8px; font: 600 13px system-ui, -apple-system, sans-serif; color: ${C.sec}; text-transform: uppercase; letter-spacing: 0; }
  main { padding: 18px 32px; overflow: hidden; }
  .search { margin-top: 12px; height: 40px; border-radius: 11px; background: ${C.cell}; display: flex; align-items: center; gap: 8px; padding: 0 12px; color: #8e8e93; font-size: 17px; }
  .chips { display: flex; gap: 8px; margin-top: 16px; }
  .chips div { padding: 8px 16px; border-radius: 18px; background: ${C.cell}; font: 500 15px system-ui, -apple-system, sans-serif; color: #d1d1d6; }
  .chips .on { background: #fff; color: #000; }
  .grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 26px 18px; margin-top: 24px; }
  .c img { width: 100%; height: 250px; border-radius: 14px; }
  .c b { display: block; margin-top: 10px; font: 600 17px system-ui, -apple-system, sans-serif; }
  .c span { font-size: 14px; color: ${C.sec}; }
`)}
<body>${statusBar()}
  <aside>
    <div class="brand">Mise</div>
    <div class="nav">${svg("home", 22)}Tonight</div>
    <div class="nav on">${svg("book", 22)}Browse</div>
    <div class="nav">${svg("bookmark", 22)}Saved</div>
    <div class="nav">${svg("list", 22)}Groceries</div>
    <div class="nav">${svg("calendar", 22)}Meal plan</div>
    <div class="gh">Collections</div>
    <div class="nav">Weeknight</div><div class="nav">Date night</div><div class="nav">Vegetarian</div>
  </aside>
  <main>
    <div class="h-large">Browse</div>
    <div class="search">${svg("search", 18)}Search 2,400 recipes</div>
    <div class="chips"><div class="on">All</div><div>Under 30 min</div><div>Seafood</div><div>Vegetarian</div><div>Comfort</div></div>
    <div class="grid">
      ${card("ramen", "Miso ramen with a jammy egg", "35 min · Medium")}${card("salmon", "Seared salmon, greens", "25 min · Easy")}${card("tacos", "Crispy fish tacos", "20 min · Easy")}
      ${card("shakshuka", "Shakshuka with feta", "30 min · Easy")}${card("curry", "Potato &amp; pea curry", "35 min · Easy")}${card("bowl", "Harvest grain bowl", "15 min · Easy")}
      ${card("salad", "Greek salad, crispy chickpeas", "15 min · Easy")}${card("toast", "Avocado toast, soft egg", "10 min · Easy")}${card("table", "Dinner for six", "1 h 20 min · Menu")}
    </div>
  </main>
</body>`;
};

export const watch = () => `${base(208, 248, `
  body { text-align: center; }
  .l { margin-top: 16px; font: 600 15px system-ui, -apple-system, sans-serif; color: ${C.tint}; }
  .rw { position: relative; width: 138px; height: 138px; margin: 8px auto 0; }
  .rw svg { position: absolute; inset: 0; transform: rotate(-90deg); }
  .v { position: absolute; inset: 0; display: grid; place-items: center; font: 600 36px ui-rounded, system-ui, sans-serif; letter-spacing: -0.03em; font-variant-numeric: tabular-nums; }
  .s { margin-top: 10px; font-size: 13px; color: ${C.sec}; }
`)}
<body>
  <div class="l">Simmer</div>
  <div class="rw"><svg width="138" height="138" viewBox="0 0 138 138"><circle cx="69" cy="69" r="62" fill="none" stroke="#1f2a23" stroke-width="10"/><circle cx="69" cy="69" r="62" fill="none" stroke="${C.tint}" stroke-width="10" stroke-linecap="round" stroke-dasharray="${2 * Math.PI * 62 * 0.62} 999"/></svg><div class="v">04:36</div></div>
  <div class="s">Ramen · step 3</div>
</body>`;

export const web = () => `${base(1512, 982, `
  body { background: #0a0a0a; }
  header { display: flex; align-items: center; justify-content: space-between; padding: 28px 72px; }
  .brand { font: 800 28px system-ui, -apple-system, sans-serif; letter-spacing: -0.04em; }
  nav { display: flex; gap: 36px; font: 500 16px system-ui, -apple-system, sans-serif; color: #a1a1a6; }
  .btn { padding: 12px 20px; border-radius: 12px; background: #fff; color: #000; font: 600 15px system-ui, -apple-system, sans-serif; }
  .hero { display: grid; grid-template-columns: 1fr 1.1fr; gap: 56px; padding: 56px 72px 0; align-items: center; }
  .eb { font: 600 14px system-ui, -apple-system, sans-serif; color: ${C.tint}; letter-spacing: 0; }
  h1 { margin: 14px 0 0; font: 700 88px/0.98 system-ui, -apple-system, sans-serif; letter-spacing: -0.05em; }
  p { font: 400 21px/1.45 system-ui, -apple-system, sans-serif; color: #a1a1a6; max-width: 460px; margin: 24px 0 32px; }
  .ctas { display: flex; gap: 12px; }
  .ghost { padding: 12px 20px; border-radius: 12px; background: ${C.cell}; font: 600 15px system-ui, -apple-system, sans-serif; }
  .pic { position: relative; height: 620px; border-radius: 28px; overflow: hidden; }
  .pic img { width: 100%; height: 100%; }
  .float { position: absolute; left: 24px; bottom: 24px; display: flex; gap: 14px; align-items: center; padding: 12px 18px 12px 12px; border-radius: 18px; background: rgba(20,20,22,.86); backdrop-filter: blur(16px); }
  .float img { width: 56px; height: 56px; border-radius: 12px; }
  .float b { display: block; font: 600 16px system-ui, -apple-system, sans-serif; }
  .float span { font-size: 14px; color: #a1a1a6; }
`)}
<body>
  <header><div class="brand">Mise</div><nav><span>Recipes</span><span>Meal plans</span><span>Pricing</span><span>Journal</span></nav><div class="btn">Get the app</div></header>
  <div class="hero">
    <div><div class="eb">For people who love dinner</div><h1>Dinner,<br>sorted.</h1>
      <p>Mise plans your week, builds the grocery list, and talks you through every step while you cook.</p>
      <div class="ctas"><div class="btn">Get the app</div><div class="ghost">Browse recipes</div></div></div>
    <div class="pic"><img src="${ph("salmon")}"><div class="float"><img src="${ph("ramen")}"><div><b>Tonight: miso ramen</b><span>35 min · shopping list ready</span></div></div></div>
  </div>
</body>`;
