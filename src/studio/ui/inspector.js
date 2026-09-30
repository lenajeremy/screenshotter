// Right panel: properties of the selection, or of the scene when nothing is selected.
import { useRef, useState } from "preact/hooks";
import { AccentText, ColorButton, ColorPicker, Dropdown, Num, Popover, Seg, Slider, Section, Switch, TextField, html } from "./controls.js";
import { Icon } from "./icons.js";
import { S, api, base, clamp, edit, entityLabel, fail, isVideo, r4, set, thumbUrl, useStore } from "./store.js";
import { deleteEntity, duplicateEntity, openStills, replaceMode, uploadFiles } from "./actions.js";
import { ClipInspector } from "./timeline.js";
import { LayersList, bgObj } from "./panels.js";

const FONTS = [
  { value: "", label: "SF Pro", font: "-apple-system" },
  { value: "sf-rounded", label: "SF Pro Rounded", font: "ui-rounded" },
  { value: "new-york", label: "New York", font: "ui-serif" },
  { value: "sf-mono", label: "SF Mono", font: "ui-monospace" },
  { value: "Inter", label: "Inter", hint: "Google", font: "Inter" },
  { value: "Instrument Serif", label: "Instrument Serif", hint: "Google", font: "Instrument Serif" },
  { value: "Manrope", label: "Manrope", hint: "Google", font: "Manrope" },
  { value: "DM Serif Display", label: "DM Serif Display", hint: "Google", font: "DM Serif Display" },
  { value: "Space Grotesk", label: "Space Grotesk", hint: "Google", font: "Space Grotesk" },
  { value: "Fraunces", label: "Fraunces", hint: "Google", font: "Fraunces" },
  { value: "Outfit", label: "Outfit", hint: "Google", font: "Outfit" },
  { value: "Plus Jakarta Sans", label: "Plus Jakarta Sans", hint: "Google", font: "Plus Jakarta Sans" },
];
const WEIGHTS = [
  { value: 400, label: "Regular" },
  { value: 500, label: "Medium" },
  { value: 600, label: "Semibold" },
  { value: 700, label: "Bold" },
  { value: 800, label: "Heavy" },
  { value: 900, label: "Black" },
];

const pct = { scale: 100, unit: "%", digits: 1, step: 0.5 };
/** Presets use in-between weights like 650; show the closest named one. */
const nearestWeight = (w) => WEIGHTS.reduce((a, b) => (Math.abs(b.value - w) < Math.abs(a.value - w) ? b : a)).value;

// =============================================================================================

export function Inspector() {
  const s = useStore();
  const id = s.selected;
  let body;
  // Animate: the selected animation takes the panel.
  if (s.timelineOpen && s.animSel !== null && s.scene.animations?.[s.animSel]) body = html`<${ClipInspector} />`;
  else if (!id) body = html`<${SceneInspector} />`;
  else if (id.startsWith("device-")) body = html`<${DeviceInspector} id=${id} />`;
  else if (id === "caption") body = html`<${CaptionInspector} />`;
  else if (id.startsWith("shape-")) body = html`<${ShapeInspector} id=${id} />`;
  else body = html`<${TextInspector} id=${id} />`;
  return html`<aside class="panel right">${body}</aside>`;
}

/**
 * The settings most people change come first; the rest sit behind "More options". Whether it's
 * open is remembered per kind of thing (device, text, shape, image).
 */
function More({ id, children }) {
  const key = `more:${id}`;
  const [open, setOpen] = useState(() => {
    try {
      return localStorage.getItem(key) === "1";
    } catch {
      return false;
    }
  });
  const toggle = () => {
    setOpen(!open);
    try {
      localStorage.setItem(key, open ? "0" : "1");
    } catch {
      // Private window: it just won't be remembered.
    }
  };
  return html`<button class="more-options ${open ? "open" : ""}" onClick=${toggle} aria-expanded=${open}>
      <${Icon} n=${open ? "down" : "right"} s=${13} />${open ? "Fewer options" : "More options"}
    </button>
    ${open && children}`;
}

function Head({ title, sub, id }) {
  return html`<div class="panel-head">
    <h2>${title}${sub && html` <span class="sub">${sub}</span>`}</h2>
    ${id && id !== "caption" && html`<button class="icon-btn sm" title="Duplicate (⌘D)" onClick=${() => duplicateEntity(id)}><${Icon} n="duplicate" s=${14} /></button>`}
    ${id && html`<button class="icon-btn sm" title="Delete" onClick=${() => deleteEntity(id)}><${Icon} n="trash" s=${14} /></button>`}
    ${id && html`<button class="icon-btn sm" title="Deselect (Esc)" onClick=${() => set({ selected: null })}><${Icon} n="x" s=${14} /></button>`}
  </div>`;
}

// =============================================================================================
// Device

const FRAMES = [
  { value: "device", label: "Device", icon: "phone" },
  { value: "browser", label: "Browser", icon: "browser" },
  { value: "window", label: "Window", icon: "window" },
  { value: "card", label: "Card", icon: "card" },
  { value: "none", label: "None", icon: "noframe" },
];
const SHADOWS = ["none", "soft", "medium", "strong", "studio"];
// Which edge of a device dissolves into the backdrop. Icons, as five words don't fit the row.
const FADES = [
  { value: "none", label: "", icon: "fadeNone", title: "No fade" },
  { value: "bottom", label: "", icon: "fadeBottom", title: "Fade the bottom" },
  { value: "top", label: "", icon: "fadeTop", title: "Fade the top" },
  { value: "left", label: "", icon: "fadeLeft", title: "Fade the left side" },
  { value: "right", label: "", icon: "fadeRight", title: "Fade the right side" },
];
const HL_STYLES = [
  { value: "lift", label: "Lift" },
  { value: "loupe", label: "Loupe" },
  { value: "outline", label: "Outline" },
  { value: "spotlight", label: "Spotlight" },
  { value: "blur-rest", label: "Blur rest" },
];

/** Soft focus for text and shapes, as a fraction of the canvas width (shown in pixels). */
function BlurRow({ value, onChange }) {
  const W = S.layout?.canvas.width ?? 1000;
  return html`<div class="row"><label>Blur</label><${Slider} value=${value ?? 0} min=${0} max=${0.02} step=${0.0005} reset=${0}
    format=${(v) => (v > 0.0002 ? Math.round(v * W) + " px" : "Sharp")} onChange=${(v) => onChange(v > 0.0002 ? Math.round(v * 10000) / 10000 : undefined)} /></div>`;
}

/** The moment of its recording a device's still shows (a picked still is named `.still-<ms>`). */
function stillClock(still) {
  const m = /\.still-(\d+)\.png$/i.exec(still ?? "");
  const t = m ? Number(m[1]) / 1000 : 0;
  return `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, "0")}`;
}

function DeviceInspector({ id }) {
  const s = useStore();
  const i = Number(id.split("-")[1]) - 1;
  const d = s.scene.devices[i];
  const e = s.layout?.entities.find((x) => x.id === id);
  if (!d) return null;
  const upd = (fn, key) => edit((sc) => fn(sc.devices[i]), key && `d${i}.${key}`);
  const frame = d.frame ?? "device";
  const models = s.opts?.devices ?? [];
  const modelName = d.device ?? e?.device;
  const model = models.find((m) => m.name === modelName);
  const colors = [...(model?.colors ?? []), ...(s.opts?.genericColors ?? []).filter((g) => !model?.colors.some((c) => c.name === g.name))];
  // Finishes with Apple's product art installed render photographically; everything else is drawn.
  const artNames = s.opts?.bezels?.models?.find((b) => b.name === model?.name)?.colors ?? [];
  const appleColors = (model?.colors ?? []).filter((c) => artNames.includes(c.name));
  const drawnColors = colors.filter((c) => !artNames.includes(c.name));
  const current = d.color ?? model?.colors[0]?.name ?? "Black";
  const currentIsApple = artNames.includes(current);
  // Art exists for this finish but isn't used: turned off, or a web page (Apple's licence covers app mock-ups).
  const artUnused = currentIsApple && !e?.bezel;
  const family = (m) => (m.family === "iphone" ? "iPhone" : m.family === "ipad" ? "iPad" : m.family === "watch" ? "Watch" : m.family === "mac" ? "Mac" : m.family);
  const modelOpts = [
    { value: "", label: "Match the screenshot", hint: e?.device ?? "" },
    ...models.map((m) => ({ value: m.name, label: m.name, group: family(m) })),
    ...(s.opts?.extraDevices ?? []).map((n) => ({ value: n, label: n, group: "From Xcode" })),
  ];
  // Transform: prefer the scene's value, fall back to where the layout put it.
  const X = d.x ?? e?.x;
  const Y = d.y ?? e?.y;
  const Hh = d.height ?? e?.height;
  const place = (patch, key) =>
    upd((dev) => {
      if (patch.x !== undefined || patch.y !== undefined) {
        dev.x ??= r4(e?.x ?? 0.5);
        dev.y ??= r4(e?.y ?? 0.5);
        dev.anchor = "center";
      }
      Object.assign(dev, patch);
      if (patch.height !== undefined) delete dev.width;
    }, key);
  const custom = d.x !== undefined || d.y !== undefined || d.height !== undefined || d.rotate;
  // The frame chooser and its extras. Everyday for a browser, window or card; an extra for a device.
  const frameSection = html`<${Section} title="Frame style">
        <div class="frames">${FRAMES.map((f) => html`<button class="frame-opt ${frame === f.value ? "on" : ""}" onClick=${() => upd((dev) => (dev.frame = f.value === "device" ? undefined : f.value))}><${Icon} n=${f.icon} s=${17} />${f.label}</button>`)}</div>
        ${frame === "browser" && html`<div class="row"><label>Address</label><${TextField} value=${d.url} placeholder="Page URL by default" onChange=${(v) => upd((dev) => (dev.url = v || undefined), "url")} /></div>`}
        ${frame === "window" && html`<div class="row"><label>Title</label><${TextField} value=${d.title} placeholder="Window title" onChange=${(v) => upd((dev) => (dev.title = v || undefined), "title")} /></div>`}
        ${(frame === "browser" || frame === "window") && html`<div class="row"><label>Chrome</label><${Seg} value=${d.chrome ?? "light"} options=${["light", "dark"]} onChange=${(v) => upd((dev) => (dev.chrome = v === "light" ? undefined : v))} /></div>`}
        ${frame === "device" && (e?.bezel || d.bezel === false) &&
        html`<div class="row"><label>Art</label><${Seg} value=${d.bezel === false ? "drawn" : "apple"} options=${[{ value: "apple", label: "Apple" }, { value: "drawn", label: "Drawn" }]} onChange=${(v) => upd((dev) => (dev.bezel = v === "drawn" ? false : undefined))} /></div>`}
        ${frame === "device" && /iphone/i.test(modelName ?? "") &&
        html`<div class="row"><label>Show</label><${Seg} value=${d.side ?? "front"} options=${[{ value: "front", label: "Front" }, { value: "back", label: "Back" }]} onChange=${(v) => upd((dev) => (dev.side = v === "front" ? undefined : v))} /></div>`}
        ${frame === "device" &&
        html`<div class="hstack wrap" style=${{ gap: "14px" }}>
          <${Switch} checked=${d.buttons !== false} onChange=${(v) => upd((dev) => (dev.buttons = v ? undefined : false))} label="Buttons" />
          <${Switch} checked=${Boolean(d.glare)} onChange=${(v) => upd((dev) => (dev.glare = v || undefined))} label="Glass glare" />
        </div>`}
      <//>`;
  return html`
    <${Head} title=${entityLabel(id)} sub=${s.scene.devices.length > 1 ? `${i + 1} of ${s.scene.devices.length}` : ""} id=${id} />
    <div class="panel-body">
      <div class="insp-hero ${d.video ? "rec" : ""}">
        <div class="pic"><img src=${thumbUrl(d.screenshot, 120)} /></div>
        <div class="meta"><b title=${base(d.video ?? d.screenshot)}>${base(d.video ?? d.screenshot)}</b>
          <span>${d.video ? html`<${Icon} n="video" s=${11} />Recording · still at ${stillClock(d.screenshot)}` : e ? `${Math.round(e.width * (s.layout.canvas.width))} × ${Math.round(e.height * s.layout.canvas.height)} on canvas` : ""}</span></div>
        ${d.video
          ? html`<div class="hero-actions">
              <button class="btn sm" title="Choose the moment of the recording this device shows in images" onClick=${() => openStills(id)}><${Icon} n="image" s=${13} />Pick the still</button>
              <button class="btn sm" onClick=${() => replaceMode(id)}><${Icon} n="replace" s=${13} />Replace</button>
            </div>`
          : html`<button class="btn sm" onClick=${() => replaceMode(id)}>Replace</button>`}
      </div>

      ${frame === "device"
        ? html`<${Section} title="Device">
        <div class="row"><label>Device</label><${Dropdown} value=${d.device ?? ""} options=${modelOpts} search onChange=${(v) => upd((dev) => {
          dev.device = v || undefined;
          delete dev.color;
        })} /></div>
          <div class="row top"><label>Colour</label><div class="vstack colour-groups">
            ${appleColors.length > 0 &&
            html`<div class="colour-group">
              <span class="colour-head"><${Icon} n="image" s=${11} />Apple product art</span>
              ${html`<div class="swatches">${appleColors.map(
                    (c) => html`<button class="swatch art ${current === c.name ? "on" : ""}" style=${{ background: c.hex }} title=${`${c.name}: Apple's photographic render`} onClick=${() => upd((dev) => {
                      dev.color = c.name;
                      if (dev.bezel === false) delete dev.bezel;
                    })}></button>`,
                  )}</div>`}
            </div>`}
            <div class="colour-group">
              ${appleColors.length > 0 && html`<span class="colour-head"><${Icon} n="wand" s=${11} />Drawn</span>`}
              <div class="swatches">
                ${drawnColors.map((c) => html`<button class="swatch ${current === c.name ? "on" : ""}" style=${{ background: c.hex }} title=${`${c.name}: drawn`} onClick=${() => upd((dev) => (dev.color = c.name))}></button>`)}
                <${ColorPickSwatch} value=${/^#/.test(d.color ?? "") ? d.color : undefined} onChange=${(v) => upd((dev) => (dev.color = v), "color")} />
              </div>
            </div>
            <span class="swatch-name">${current}<span class="faint"> · ${currentIsApple && !artUnused ? "Apple product art" : "drawn"}</span></span>
            ${artUnused && html`<span class="note">${d.bezel === false ? "Art is set to Drawn below." : "Web pages use drawn frames: Apple's licence covers mock-ups of apps."}</span>`}
          </div></div>
      <//>`
        : frameSection}

      <${Section} title="Size & tilt" right=${d.rotateX || d.rotateY ? html`<button class="btn sm ghost" onClick=${() => upd((dev) => {
        delete dev.rotateX;
        delete dev.rotateY;
      })}>Make flat</button>` : null}>
        <div class="row"><label>Size</label><${Slider} value=${Hh} min=${0.1} max=${1.6} step=${0.005} format=${(v) => Math.round(v * 100) + "%"} onChange=${(v) => place({ height: v === undefined ? undefined : r4(v) }, "h")} /></div>
        <${Pad3D} rx=${d.rotateX ?? 0} ry=${d.rotateY ?? 0} onChange=${(rx, ry) => upd((dev) => {
          dev.rotateX = rx || undefined;
          dev.rotateY = ry || undefined;
        }, "3d")} />
      <//>

      <${More} id="device">
        ${frame === "device" && frameSection}
        <${Section} title="Position" right=${custom ? html`<button class="btn sm ghost" title="Put it back where the layout places it" onClick=${() => upd((dev) => {
        for (const k of ["x", "y", "anchor", "height", "width", "rotate"]) delete dev[k];
      })}><${Icon} n="refresh" s=${12} />Auto-place</button>` : null}>
        <div class="row"><label>Rotation</label><${Slider} value=${d.rotate ?? 0} min=${-45} max=${45} step=${0.5} centered reset=${0} format=${(v) => Math.round(v * 10) / 10 + "°"} onChange=${(v) => upd((dev) => (dev.rotate = v ? Math.round(v * 10) / 10 : undefined), "rot")} /></div>
        <div class="row"><label>Position</label><div class="grid2">
          <${Num} label="X" title="Horizontal: 0% left edge, 100% right edge" value=${X} ...${pct} onChange=${(v) => place({ x: v === undefined ? undefined : r4(v) }, "x")} />
          <${Num} label="Y" title="Vertical: 0% top, 100% bottom" value=${Y} ...${pct} onChange=${(v) => place({ y: v === undefined ? undefined : r4(v) }, "y")} />
        </div></div>
        <div class="row"><label>3D</label><div class="grid2">
          <${Num} label="↕" title="Tilt: top leans away" value=${d.rotateX ?? 0} unit="°" digits=${1} min=${-60} max=${60} onChange=${(v) => upd((dev) => (dev.rotateX = v || undefined), "rx")} />
          <${Num} label="↔" title="Turn: right edge turns away" value=${d.rotateY ?? 0} unit="°" digits=${1} min=${-70} max=${70} onChange=${(v) => upd((dev) => (dev.rotateY = v || undefined), "ry")} />
        </div></div>
        <div class="note">Tip: drag the device on the canvas. Hold ⌥ to turn snapping off.</div>
      <//>
      <${Section} title="Focus">
        <div class="row"><label>Blur</label><${Slider} value=${d.blur ?? 0} min=${0} max=${0.012} step=${0.0005} reset=${0}
          format=${(v) => (v ? Math.round((v / 0.012) * 100) + "%" : "Sharp")} onChange=${(v) => upd((dev) => (dev.blur = v ? Math.round(v * 10000) / 10000 : undefined), "blur")} /></div>
        <div class="row"><label>Fade</label><${Seg} value=${d.fade ? (typeof d.fade === "number" ? "bottom" : d.fade.edge ?? "bottom") : "none"}
          options=${FADES}
          onChange=${(v) => upd((dev) => {
            const extent = typeof dev.fade === "number" ? dev.fade : dev.fade?.extent ?? 0.4;
            dev.fade = v === "none" ? undefined : v === "bottom" ? extent : { edge: v, extent };
          })} /></div>
        ${d.fade && html`<div class="row"><label>Amount</label><${Slider} value=${typeof d.fade === "number" ? d.fade : d.fade.extent ?? 0.4} min=${0.1} max=${1} step=${0.01}
          format=${(v) => Math.round(v * 100) + "%"} onChange=${(v) => upd((dev) => {
            const extent = v === undefined ? 0.4 : Math.round(v * 100) / 100;
            dev.fade = typeof dev.fade === "number" || !dev.fade ? extent : { ...dev.fade, extent };
          }, "fade")} /></div>`}
        <div class="note">Blur a device to put it out of focus behind a sharp one. Fade dissolves one edge of it into the background${d.fade ? `: the ${typeof d.fade === "number" ? "bottom" : d.fade.edge ?? "bottom"} edge` : ""}.</div>
      <//>

      <${Section} title="Shadow">
        <div class="chips">${SHADOWS.map((sh) => html`<button class="chip sm ${(typeof d.shadow === "string" ? d.shadow : d.shadow ? "custom" : "medium") === sh ? "on" : ""}" onClick=${() => upd((dev) => (dev.shadow = sh === "medium" ? undefined : sh))}>${sh}</button>`)}</div>
      <//>

      <${Highlights} i=${i} d=${d} />

      <${Recording} id=${id} d=${d} upd=${upd} />
      <//>
    </div>`;
}

/** A screen recording that plays inside this device (canvas and exported videos). */
function Recording({ id, d, upd }) {
  const input = useRef();
  const s = useStore();
  const clips = s.files.filter((f) => isVideo(f.path) && ["recordings", "uploads"].includes(f.kind));
  const pick = html`<input type="file" ref=${input} hidden accept="video/mp4,video/quicktime,.mp4,.mov" onChange=${(e) => {
    const files = e.target.files;
    if (files?.length) uploadFiles([files[0]], { device: id });
    e.target.value = "";
  }} />`;
  if (d.video) {
    return html`<${Section} title="Recording">
      <div class="hstack"><${Icon} n="video" s=${14} /><span class="grow mono" style=${{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title=${d.video}>${base(d.video)}</span>
      <button class="btn sm ghost" onClick=${() => input.current.click()}>Change…</button>
      <button class="btn sm ghost" onClick=${() => upd((dev) => delete dev.video)}>Remove</button></div>
      <div class="note">Plays inside the screen on the canvas and in exported videos. Stills use the screenshot.</div>
      ${pick}
    <//>`;
  }
  return html`<${Section} title="Recording" collapsible open=${false} id="rec">
    <div class="note">Play a screen recording inside this ${d.frame && d.frame !== "device" ? "frame" : "device"} when you export a video.</div>
    <div class="hstack wrap">
      <button class="btn sm" onClick=${() => input.current.click()}><${Icon} n="video" s=${13} />Attach a recording…</button>
      ${clips.length > 0 && html`<${Dropdown} value="" placeholder="Or pick one you imported" options=${clips.slice(0, 20).map((f) => ({ value: f.path, label: base(f.path) }))} onChange=${(v) => v && upd((dev) => (dev.video = v))} />`}
    </div>
    ${pick}
  <//>`;
}

function ColorPickSwatch({ value, onChange }) {
  const ref = useRef();
  const [open, setOpen] = useState(false);
  return html`<button class="swatch ${value ? "on" : "add"}" ref=${ref} title="Custom colour" style=${value ? { background: value } : null} onClick=${() => setOpen(!open)}></button>
    ${open && html`<${Popover} anchor=${ref.current} onClose=${() => setOpen(false)} width=${244}><${ColorPicker} value=${value ?? "#8b7bff"} onChange=${(v) => v && onChange(v)} /><//>`}`;
}

/** Drag the puck to tilt (vertical) and turn (horizontal). */
function Pad3D({ rx, ry, onChange }) {
  const ref = useRef();
  const RX = 40;
  const RY = 50;
  const down = (ev) => {
    ev.preventDefault();
    const r = ref.current.getBoundingClientRect();
    const go = (e) => {
      let y = Math.round(clamp(((e.clientX - r.left) / r.width) * 2 - 1, -1, 1) * RY);
      let x = Math.round(clamp(-(((e.clientY - r.top) / r.height) * 2 - 1), -1, 1) * RX);
      if (Math.abs(x) < 2) x = 0;
      if (Math.abs(y) < 2) y = 0;
      onChange(x, y);
    };
    go(ev);
    const up = () => {
      window.removeEventListener("pointermove", go);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", go);
    window.addEventListener("pointerup", up);
  };
  return html`<div class="pad3d" ref=${ref} onPointerDown=${down} onDblClick=${() => onChange(0, 0)} title="Drag to tilt · double-click to flatten">
    <div class="phone" style=${{ transform: `rotateX(${rx}deg) rotateY(${ry}deg)` }}></div>
    <div class="puck" style=${{ left: 50 + (ry / RY) * 50 + "%", top: 50 - (rx / RX) * 50 + "%" }}></div>
    <span class="lbl-y">tilt ${Math.round(rx)}°</span><span class="lbl-x">turn ${Math.round(ry)}°</span>
  </div>`;
}

function Highlights({ i, d }) {
  const hs = d.highlights ?? [];
  const [ocr, setOcr] = useState(null);
  const [busy, setBusy] = useState(false);
  const upd = (fn, key) => edit((sc) => fn(sc.devices[i]), key && `d${i}.hl.${key}`);
  const find = async () => {
    setBusy(true);
    try {
      const boxes = await api(`/api/text?path=${encodeURIComponent(d.screenshot)}`);
      setOcr(boxes.filter((b) => b.text.trim().length > 1));
    } catch (e) {
      fail(e, "Couldn't read the screenshot");
    } finally {
      setBusy(false);
    }
  };
  return html`<${Section} title="Call-outs" count=${hs.length || undefined} collapsible id="hl"
      right=${html`<button class="btn sm ghost" onClick=${find} disabled=${busy}>${busy ? html`<span class="spinner"></span>` : html`<${Icon} n="search" s=${12} />`}Find text</button>`}>
    ${hs.map(
      (hl, j) => html`<div class="hl-item">
        <div class="vstack" style=${{ gap: "6px" }}>
          <${Dropdown} value=${hl.style} options=${HL_STYLES} onChange=${(v) => upd((dev) => (dev.highlights[j].style = v))} />
          <${TextField} value=${hl.text} placeholder="Text on screen, e.g. Add task" onChange=${(v) => upd((dev) => (dev.highlights[j].text = v || undefined), `t${j}`)} />
        </div>
        <button class="icon-btn sm" title="Remove" onClick=${() => upd((dev) => {
          dev.highlights.splice(j, 1);
          if (!dev.highlights.length) delete dev.highlights;
        })}><${Icon} n="x" s=${13} /></button>
      </div>`,
    )}
    ${ocr &&
    html`<div class="note">Click text to highlight it:</div><div class="ocr">${ocr.map((b) => html`<button title=${b.text} onClick=${() => upd((dev) => {
      dev.highlights = [...(dev.highlights ?? []), { style: "lift", text: b.text }];
    })}>${b.text}</button>`)}${!ocr.length && html`<span class="note">No text found.</span>`}</div>`}
    ${!hs.length && !ocr && html`<div class="note">Draw attention to one part of the screen: lift it out, magnify it, or dim everything else. Press <b>Find text</b> and click the words you want to call out. Call-outs show in Preview.</div>`}
    ${hs.length > 0 && html`<button class="btn sm" onClick=${() => upd((dev) => (dev.highlights = [...(dev.highlights ?? []), { style: "lift" }]))}><${Icon} n="plus" s=${12} />Add another</button>`}
  <//>`;
}

// =============================================================================================
// Text styling shared by the caption and text items

/** Font and colour are the everyday part ("basic"); weight, alignment, tracking and case are the rest. */
function TypeControls({ part, font, weight, color, onFont, onWeight, onColor, align, onAlign, uppercase, onUpper, spacing, onSpacing, colorAuto = "Auto" }) {
  const basic = part !== "rest";
  const rest = part !== "basic";
  return html`
    ${basic && html`<div class="row"><label>Font</label><${Dropdown} value=${font ?? ""} options=${FONTS} search onChange=${onFont} render=${(o) => html`<span style=${{ fontFamily: o.font }}>${o.label}</span>`} /></div>
      <div class="row"><label>Colour</label><${ColorButton} value=${color} auto=${colorAuto} onChange=${onColor} /></div>`}
    ${rest && html`<div class="row"><label>Weight</label><${Dropdown} value=${nearestWeight(weight ?? 700)} options=${WEIGHTS} onChange=${onWeight} /></div>
      ${onAlign && html`<div class="row"><label>Align</label><${Seg} class="icons" value=${align ?? "center"} options=${[{ value: "left", label: "", icon: "alignL", title: "Left" }, { value: "center", label: "", icon: "alignC", title: "Centre" }, { value: "right", label: "", icon: "alignR", title: "Right" }]} onChange=${onAlign} /></div>`}
      <div class="row"><label>Tracking</label><${Slider} value=${spacing} min=${-0.1} max=${0.3} step=${0.005} fallback=${-0.02} centered format=${(v) => v.toFixed(3)} onChange=${onSpacing} /></div>
      <${Switch} checked=${Boolean(uppercase)} onChange=${onUpper} label="Uppercase" />`}
  `;
}

function CaptionInspector() {
  const s = useStore();
  const sc = s.scene;
  const st = sc.textStyle ?? {};
  const e = s.layout?.entities.find((x) => x.id === "caption");
  const upd = (fn, key) => edit((d) => {
    d.textStyle = { ...(d.textStyle ?? {}) };
    fn(d.textStyle, d);
  }, key && `cap.${key}`);
  const placed = st.x !== undefined || st.y !== undefined;
  return html`
    <${Head} title="Headline" id="caption" />
    <div class="panel-body">
      <${Section} title="Words">
        <${AccentText} rows=${2} value=${sc.headline} placeholder="Headline" onChange=${(v) => edit((d) => (d.headline = v || undefined), "headline")} />
        <${TextField} value=${sc.subheadline} placeholder="Subheadline (optional)" onChange=${(v) => edit((d) => (d.subheadline = v || undefined), "subheadline")} />
        <div class="row"><label>Star colour</label><${ColorButton} value=${st.accentColor} auto="Bold only" onChange=${(v) => upd((t) => (t.accentColor = v), "accent")} /></div>
        <div class="note">Words in **stars** take this colour, in the headline and in extra text that doesn't pick its own.</div>
      <//>
      <${Section} title="Style">
        <${TypeControls} part="basic" font=${st.font} weight=${st.headlineWeight} color=${st.color}
          onFont=${(v) => upd((t) => (t.font = v || undefined))}
          onWeight=${(v) => upd((t) => (t.headlineWeight = v === 700 ? undefined : v))}
          onColor=${(v) => upd((t) => (t.color = v), "color")}
          align=${st.align ?? e?.align} onAlign=${(v) => upd((t) => (t.align = v))}
          uppercase=${st.uppercase} onUpper=${(v) => upd((t) => (t.uppercase = v || undefined))}
          spacing=${st.letterSpacing} onSpacing=${(v) => upd((t) => (t.letterSpacing = v), "ls")} />
        <div class="row"><label>Size</label><${Slider} value=${st.headlineSize ?? e?.size} min=${0.015} max=${0.12} step=${0.001} format=${(v) => Math.round(v * (s.layout?.canvas.height ?? 1000)) + " px"} onChange=${(v) => upd((t) => (t.headlineSize = v && r4(v)), "hs")} /></div>
      <//>
      <${More} id="text">
      <${Section} title="Position" right=${placed ? html`<button class="btn sm ghost" title="Put it back where the layout places it" onClick=${() => upd((t) => {
        for (const k of ["x", "y", "anchor", "width"]) delete t[k];
      })}><${Icon} n="refresh" s=${12} />Auto-place</button>` : null}>
        <div class="row"><label>Place</label><${Seg} value=${placed ? "" : st.position ?? "top"} options=${["top", "bottom", "left", "right"]} onChange=${(v) => upd((t) => {
          for (const k of ["x", "y", "anchor"]) delete t[k];
          t.position = v === "top" ? undefined : v;
        })} /></div>
        <div class="grid2">
          <${Num} label="X" value=${st.x ?? e?.x} ...${pct} onChange=${(v) => upd((t) => {
            t.x = v === undefined ? undefined : r4(v);
            t.y ??= e?.y;
            t.anchor ??= e?.anchor;
          }, "x")} />
          <${Num} label="Y" value=${st.y ?? e?.y} ...${pct} onChange=${(v) => upd((t) => {
            t.y = v === undefined ? undefined : r4(v);
            t.x ??= e?.x;
            t.anchor ??= e?.anchor;
          }, "y")} />
          <${Num} label="W" title="Width of the text block, % of the image" value=${st.width ?? e?.width} ...${pct} min=${0.1} max=${1.2} onChange=${(v) => upd((t) => (t.width = v && r4(v)), "w")} />
        </div>
      <//>
      <${Section} title="Type details">
        <${TypeControls} part="rest" font=${st.font} weight=${st.headlineWeight} color=${st.color}
          onFont=${(v) => upd((t) => (t.font = v || undefined))}
          onWeight=${(v) => upd((t) => (t.headlineWeight = v === 700 ? undefined : v))}
          onColor=${(v) => upd((t) => (t.color = v), "color")}
          align=${st.align ?? e?.align} onAlign=${(v) => upd((t) => (t.align = v))}
          uppercase=${st.uppercase} onUpper=${(v) => upd((t) => (t.uppercase = v || undefined))}
          spacing=${st.letterSpacing} onSpacing=${(v) => upd((t) => (t.letterSpacing = v), "ls")} />
        <${Switch} checked=${Boolean(st.shadow)} onChange=${(v) => upd((t) => (t.shadow = v || undefined))} label="Soft text shadow" />
        <${BlurRow} value=${st.blur} onChange=${(v) => upd((t) => (t.blur = v), "blur")} />
      <//>
      <//>
    </div>`;
}

function TextInspector({ id }) {
  const s = useStore();
  const i = Number(id.split("-")[1]) - 1;
  const t = s.scene.texts?.[i];
  const e = s.layout?.entities.find((x) => x.id === id);
  if (!t) return null;
  const upd = (fn, key) => edit((d) => fn(d.texts[i]), key && `t${i}.${key}`);
  const headAccent = s.scene.textStyle?.accentColor;
  return html`
    <${Head} title="Text" id=${id} />
    <div class="panel-body">
      <${Section} title="Words">
        <${AccentText} rows=${2} value=${t.text} onChange=${(v) => upd((x) => (x.text = v), "text")} />
        <div class="row"><label>Star colour</label><${ColorButton} value=${t.accentColor} auto=${headAccent ? "Same as headline" : "Bold only"} autoColor=${headAccent}
          onChange=${(v) => upd((x) => (x.accentColor = v), "accent")} /></div>
        <div class="note">Words in **stars** take the star colour${headAccent ? " (the headline's until you pick one)" : ""}.</div>
      <//>
      <${Section} title="Style">
        <${TypeControls} part="basic" font=${t.font} weight=${t.weight} color=${t.color}
          onFont=${(v) => upd((x) => (x.font = v || undefined))}
          onWeight=${(v) => upd((x) => (x.weight = v))}
          onColor=${(v) => upd((x) => (x.color = v), "color")}
          align=${t.align ?? "center"} onAlign=${(v) => upd((x) => (x.align = v))}
          uppercase=${t.uppercase} onUpper=${(v) => upd((x) => (x.uppercase = v || undefined))}
          spacing=${t.letterSpacing} onSpacing=${(v) => upd((x) => (x.letterSpacing = v), "ls")} />
        <div class="row"><label>Size</label><${Slider} value=${t.size ?? e?.size} min=${0.008} max=${0.12} step=${0.001} format=${(v) => Math.round(v * (s.layout?.canvas.height ?? 1000)) + " px"} onChange=${(v) => upd((x) => (x.size = v && r4(v)), "size")} /></div>
      <//>
      <${More} id="text">
      <${Section} title="Position">
        <div class="grid2">
          <${Num} label="X" value=${t.x ?? e?.x} ...${pct} onChange=${(v) => upd((x) => (x.x = v === undefined ? undefined : r4(v)), "x")} />
          <${Num} label="Y" value=${t.y ?? e?.y} ...${pct} onChange=${(v) => upd((x) => (x.y = v === undefined ? undefined : r4(v)), "y")} />
        </div>
        <div class="row"><label>Rotation</label><${Slider} value=${t.rotate ?? 0} min=${-45} max=${45} step=${0.5} centered reset=${0} format=${(v) => v + "°"} onChange=${(v) => upd((x) => (x.rotate = v || undefined), "rot")} /></div>
      <//>
      <${Section} title="Type details">
        <${TypeControls} part="rest" font=${t.font} weight=${t.weight} color=${t.color}
          onFont=${(v) => upd((x) => (x.font = v || undefined))}
          onWeight=${(v) => upd((x) => (x.weight = v))}
          onColor=${(v) => upd((x) => (x.color = v), "color")}
          align=${t.align ?? "center"} onAlign=${(v) => upd((x) => (x.align = v))}
          uppercase=${t.uppercase} onUpper=${(v) => upd((x) => (x.uppercase = v || undefined))}
          spacing=${t.letterSpacing} onSpacing=${(v) => upd((x) => (x.letterSpacing = v), "ls")} />
        <div class="row"><label>Opacity</label><${Slider} value=${t.opacity} min=${0.1} max=${1} step=${0.01} fallback=${1} format=${(v) => Math.round(v * 100) + "%"} onChange=${(v) => upd((x) => (x.opacity = v === 1 ? undefined : v), "op")} /></div>
        <${BlurRow} value=${t.blur} onChange=${(v) => upd((x) => (x.blur = v), "blur")} />
      <//>
      <${Section} title="Badge">
        <div class="row"><label>Pill colour</label><${ColorButton} value=${t.background} auto="None" onChange=${(v) => upd((x) => (x.background = v), "bg")} /></div>
        <${Switch} checked=${Boolean(t.shadow)} onChange=${(v) => upd((x) => (x.shadow = v || undefined))} label="Soft text shadow" />
      <//>
      <//>
    </div>`;
}

// =============================================================================================
// Shapes

const HEADS = [
  { value: "none", label: "None" },
  { value: "end", label: "End" },
  { value: "start", label: "Start" },
  { value: "both", label: "Both" },
];
const DASH_OPTIONS = [
  { value: "solid", label: "Solid" },
  { value: "dashed", label: "Dashed" },
  { value: "dotted", label: "Dotted" },
];
const BOX_TYPES = [
  { value: "ellipse", label: "", title: "Ellipse", icon: "ellipse" },
  { value: "rect", label: "", title: "Rectangle", icon: "square" },
  { value: "triangle", label: "", title: "Triangle", icon: "triangle" },
  { value: "star", label: "", title: "Star", icon: "star" },
];
const LINE_TYPES = [
  { value: "arrow", label: "Arrow", icon: "arrow" },
  { value: "line", label: "Line", icon: "line" },
];

function ShapeInspector({ id }) {
  const s = useStore();
  const i = Number(id.split("-")[1]) - 1;
  const sh = s.scene.shapes?.[i];
  // The shape as drawn: what it leaves unsaid filled in, and its target (if any) found.
  const g = s.layout?.entities.find((x) => x.id === id)?.shape;
  if (!sh || !g) return null;
  const W0 = s.layout?.canvas.width ?? 1000;
  const H0 = s.layout?.canvas.height ?? 1000;
  const upd = (fn, key) => edit((d) => fn(d.shapes[i]), key && `s${i}.${key}`);
  const line = g.type === "arrow" || g.type === "line";
  const badge = g.type === "badge";
  // Setting the geometry by hand places it, so it stops following its target.
  const place = (fn, key) =>
    upd((x) => {
      if (x.around) {
        if (line) Object.assign(x, { from: { ...g.from }, to: { ...g.to }, bend: g.bend });
        else Object.assign(x, { x: r4(g.x), y: r4(g.y), size: r4(g.size), aspect: Math.round(g.aspect * 1000) / 1000 });
        delete x.around;
        delete x.at;
      }
      fn(x);
    }, key);
  const colour = (v) => (v && v !== "none" ? v : undefined);
  const strokeOn = g.stroke !== "none" && g.strokeWidth > 0;
  const widthFrac = g.strokeWidth < 1 ? g.strokeWidth : g.strokeWidth / H0;
  return html`
    <${Head} title=${entityLabel(id)} id=${id} />
    <div class="panel-body">
      ${sh.around &&
      html`<div class="follow-note"><${Icon} n="link" s=${13} /><span>Follows <b>“${sh.around.text}”</b> on the screen. Drag it to place it yourself.</span></div>`}
      <${Section} title="Shape">
        ${!badge && html`<${Seg} value=${g.type} options=${line ? LINE_TYPES : BOX_TYPES} onChange=${(v) => upd((x) => {
          x.type = v;
          if (v === "line") x.head ??= g.head === "end" ? "none" : g.head;
          else if (v === "arrow" && (x.head ?? "none") === "none") delete x.head;
        })} />`}
        ${badge && html`<div class="row"><label>Label</label><${TextField} value=${g.label} placeholder="1" onChange=${(v) => upd((x) => (x.label = (v ?? "").slice(0, 4) || undefined), "label")} /></div>`}
        ${line &&
        html`<div class="row"><label>Heads</label><${Seg} value=${g.head} options=${HEADS} onChange=${(v) => upd((x) => (x.head = v))} /></div>
          <div class="row"><label>Curve</label><${Slider} value=${g.bend} min=${-1} max=${1} step=${0.01} centered reset=${0} format=${(v) => (v ? Math.round(v * 100) + "%" : "Straight")} onChange=${(v) => place((x) => (x.bend = v ?? 0), "bend")} /></div>`}
        ${g.type === "rect" && html`<div class="row"><label>Corners</label><${Slider} value=${g.radius} min=${0} max=${0.5} step=${0.01} format=${(v) => (v >= 0.5 ? "Pill" : v ? Math.round(v * 200) + "%" : "Square")} onChange=${(v) => upd((x) => (x.radius = v ?? 0), "radius")} /></div>`}
        ${g.type === "star" && html`<div class="row"><label>Points</label><${Slider} value=${g.points} min=${3} max=${12} step=${1} format=${(v) => String(v)} onChange=${(v) => upd((x) => (x.points = v ?? 5), "points")} /></div>`}
        <${Switch} checked=${g.sketch} onChange=${(v) => upd((x) => (x.sketch = v || undefined))} label="Hand-drawn" />
        ${g.sketch && html`<button class="btn sm ghost" onClick=${() => upd((x) => (x.seed = (g.seed % 97) + 1))}><${Icon} n="refresh" s=${12} />Redraw it</button>`}
      <//>
      ${!line &&
      html`<${Section} title="Fill">
        <div class="row"><label>Colour</label><${ColorButton} value=${colour(g.fill)} auto="None" onChange=${(v) => upd((x) => (x.fill = v ?? "none"), "fill")} /></div>
        ${badge && html`<div class="row"><label>Label colour</label><${ColorButton} value=${g.labelColor} allowAuto=${false} onChange=${(v) => upd((x) => (x.labelColor = v), "labelColor")} /></div>`}
      <//>`}
      <${Section} title=${badge ? "Ring" : "Stroke"}>
        <div class="row"><label>Colour</label><${ColorButton} value=${colour(g.stroke)} auto="None" allowAuto=${!line}
          onChange=${(v) => upd((x) => {
            x.stroke = v ?? "none";
            if (v && !(g.strokeWidth > 0)) x.strokeWidth = 0.005;
          }, "stroke")} /></div>
        ${strokeOn &&
        html`<div class="row"><label>Width</label><${Slider} value=${widthFrac} min=${0.001} max=${0.03} step=${0.0005} format=${(v) => Math.max(1, Math.round(v * H0)) + " px"} onChange=${(v) => upd((x) => (x.strokeWidth = v ?? 0.005), "sw")} /></div>`}
      <//>
      <${More} id="shape">
      ${strokeOn && html`<${Section} title="Line style">
        <${Seg} value=${g.dash} options=${DASH_OPTIONS} onChange=${(v) => upd((x) => (x.dash = v === "solid" ? undefined : v))} />
      <//>`}
      <${Section} title="Size & position">
        ${line
          ? html`<div class="row"><label>From</label><div class="grid2">
                <${Num} label="X" value=${g.from.x} ...${pct} onChange=${(v) => v !== undefined && place((x) => (x.from = { ...g.from, x: r4(v) }), "fx")} />
                <${Num} label="Y" value=${g.from.y} ...${pct} onChange=${(v) => v !== undefined && place((x) => (x.from = { ...g.from, y: r4(v) }), "fy")} />
              </div></div>
              <div class="row"><label>To</label><div class="grid2">
                <${Num} label="X" value=${g.to.x} ...${pct} onChange=${(v) => v !== undefined && place((x) => (x.to = { ...g.to, x: r4(v) }), "tx")} />
                <${Num} label="Y" value=${g.to.y} ...${pct} onChange=${(v) => v !== undefined && place((x) => (x.to = { ...g.to, y: r4(v) }), "ty")} />
              </div></div>`
          : html`<div class="grid2">
                <${Num} label="X" value=${g.x} ...${pct} onChange=${(v) => v !== undefined && place((x) => (x.x = r4(v)), "x")} />
                <${Num} label="Y" value=${g.y} ...${pct} onChange=${(v) => v !== undefined && place((x) => (x.y = r4(v)), "y")} />
                <${Num} label="W" value=${g.size * g.aspect} scale=${H0} unit="px" min=${4 / H0} max=${4} onChange=${(v) => v !== undefined && place((x) => (x.aspect = Math.round((v / g.size) * 1000) / 1000), "w")} />
                <${Num} label="H" value=${g.size} scale=${H0} unit="px" min=${4 / H0} max=${2} onChange=${(v) => v !== undefined && place((x) => {
                  x.aspect = Math.round(((g.size * g.aspect) / v) * 1000) / 1000;
                  x.size = r4(v);
                }, "h")} />
              </div>
              <div class="row"><label>Rotation</label><${Slider} value=${g.rotate} min=${-180} max=${180} step=${1} centered reset=${0} format=${(v) => v + "°"} onChange=${(v) => upd((x) => (x.rotate = v || undefined), "rot")} /></div>`}
      <//>
      <${Section} title="Look">
        <div class="row"><label>Opacity</label><${Slider} value=${g.opacity} min=${0.05} max=${1} step=${0.01} fallback=${1} format=${(v) => Math.round(v * 100) + "%"} onChange=${(v) => upd((x) => (x.opacity = v === 1 ? undefined : v), "op")} /></div>
        <${BlurRow} value=${g.blur} onChange=${(v) => upd((x) => (x.blur = v), "blur")} />
        <${Switch} checked=${g.shadow} onChange=${(v) => upd((x) => (x.shadow = v || undefined))} label="Soft shadow" />
      <//>
      <//>
    </div>`;
}

// =============================================================================================
// Scene

const CANVASES = [
  { value: "", label: "Auto", w: 9, h: 19.5, hint: "The App Store size for your device" },
  { value: "iphone-6.9", label: "iPhone 6.9″", w: 1320, h: 2868, hint: "App Store: required iPhone size" },
  { value: "iphone-6.5", label: "iPhone 6.5″", w: 1284, h: 2778, hint: "App Store: older iPhone size" },
  { value: "ipad-13", label: "iPad 13″", w: 2064, h: 2752, hint: "App Store: iPad size" },
  { value: "9:16", label: "Story", w: 9, h: 16, hint: "9:16 for Stories, Reels and TikTok" },
  { value: "4:5", label: "Post", w: 4, h: 5, hint: "4:5 for Instagram posts" },
  { value: "1:1", label: "Square", w: 1, h: 1, hint: "1:1" },
  { value: "16:9", label: "Wide", w: 16, h: 9, hint: "16:9 for websites, X and YouTube" },
];
function SceneInspector() {
  const s = useStore();
  const sc = s.scene;
  const presets = s.opts?.canvases ?? {};
  const canvases = CANVASES.filter((c) => !c.value || presets[c.value]);
  const cur = typeof sc.canvas === "string" ? sc.canvas : sc.canvas ? `${sc.canvas.width}x${sc.canvas.height}` : "";
  const custom = cur && !canvases.some((c) => c.value === cur);
  const [cw, ch] = (/^(\d+)x(\d+)$/.exec(cur) ?? []).slice(1).map(Number);
  const o = bgObj(sc.background);
  const bgName = typeof sc.background === "string" ? sc.background : o.look ?? (o.type === "transparent" ? "Transparent" : o.photo ? (o.photo.startsWith("unsplash:") ? "Unsplash photo" : base(o.photo)) : o.unsplash ? `Unsplash: ${o.unsplash}` : o.generate ? "AI image" : o.colors ? "Gradient" : o.color ?? "Custom");
  const bgStill = sc.background && !o.generate && o.type !== "transparent" ? `/api/bg-preview?bg=${encodeURIComponent(JSON.stringify(sc.background))}&w=120&h=120` : null;
  return html`
    <div class="panel-head"><h2>Whole image</h2><span class="sub">${s.layout ? `${s.layout.canvas.width} × ${s.layout.canvas.height}` : ""}</span></div>
    <div class="panel-body">
      <div class="intro">Click anything in the design to change it. With nothing selected, these are the settings for the whole image.</div>
      <${Section} title="Image size">
        <div class="canvas-presets">${canvases.map((c) => {
          const r = c.w / c.h;
          const box = r >= 1 ? { width: "26px", height: 26 / r + "px" } : { width: 30 * r + "px", height: "30px" };
          return html`<button class="cpreset ${cur === c.value ? "on" : ""}" title=${c.hint ?? `${presets[c.value]?.width ?? ""}×${presets[c.value]?.height ?? ""}`} onClick=${() => edit((d) => (d.canvas = c.value || undefined))}><i style=${box}></i>${c.label}</button>`;
        })}</div>
      <//>
      <${Section} title="Backdrop">
        <button class="bg-summary" onClick=${() => set({ leftTab: "backgrounds", leftOpen: true })}>
          <span class="sw" style=${{ background: "var(--check)" }}>${bgStill && html`<img src=${bgStill} />`}</span>
          <span class="grow"><b style=${{ display: "block", textTransform: "capitalize" }}>${String(bgName).replace(/-/g, " ")}</b><span class="note">Change the look, colours or photo</span></span>
          <${Icon} n="right" s=${14} />
        </button>
      <//>
      <${Section} title="In this design">
        <${LayersList} />
      <//>
      <${More} id="image">
      <${Section} title="Custom size">
        <div class="grid2">
          <${Num} label="W" value=${custom ? cw : undefined} placeholder=${s.layout?.canvas.width ?? ""} min=${64} max=${8192} step=${10} onChange=${(v) => v && edit((d) => (d.canvas = `${Math.round(v)}x${ch || s.layout?.canvas.height || Math.round(v)}`))} />
          <${Num} label="H" value=${custom ? ch : undefined} placeholder=${s.layout?.canvas.height ?? ""} min=${64} max=${8192} step=${10} onChange=${(v) => v && edit((d) => (d.canvas = `${cw || s.layout?.canvas.width || Math.round(v)}x${Math.round(v)}`))} />
        </div>
        <${Switch} checked=${Boolean(sc.landscape)} onChange=${(v) => edit((d) => (d.landscape = v || undefined))} label="Landscape" />
      <//>
      <//>
      ${s.layout?.warnings?.length ? html`<${Section} title="Notes">${s.layout.warnings.map((w) => html`<div class="note warn">${w}</div>`)}<//>` : null}
      ${s.layoutError && html`<${Section} title="Problem"><div class="note err">${s.layoutError}</div><//>`}

    </div>`;
}
