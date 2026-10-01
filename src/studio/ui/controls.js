// Reusable controls: segmented, slider, scrubbable number, switch, dropdown, popover, colour picker.
import { h } from "preact";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import htm from "htm";
import { Icon } from "./icons.js";
import { clamp, native, toast } from "./store.js";

export const html = htm.bind(h);

// ---------------------------------------------------------------------------------------------
// Segmented control

export function Seg({ value, options, onChange, class: cls = "" }) {
  const ref = useRef();
  const [thumb, setThumb] = useState(null);
  useLayoutEffect(() => {
    const on = ref.current?.querySelector("button.on");
    setThumb(on ? { left: on.offsetLeft, width: on.offsetWidth } : null);
  }, [value, options.length]);
  useEffect(() => {
    const ro = new ResizeObserver(() => {
      const on = ref.current?.querySelector("button.on");
      if (on) setThumb({ left: on.offsetLeft, width: on.offsetWidth });
    });
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return html`<div class="seg ${cls}" ref=${ref}>
    ${thumb && html`<div class="thumb" style=${{ left: thumb.left + "px", width: thumb.width + "px" }}></div>`}
    ${options.map((o) => {
      const v = typeof o === "object" ? o.value : o;
      const label = typeof o === "object" ? o.label : o;
      return html`<button class=${v === value ? "on" : ""} title=${o.title ?? ""} onClick=${() => onChange(v)}>${o.icon ? html`<${Icon} n=${o.icon} s=${14} />` : null}${label}</button>`;
    })}
  </div>`;
}

// ---------------------------------------------------------------------------------------------
// Slider (value may be undefined = "auto"; double-click resets)

export function Slider({ value, min, max, step = 0.01, onChange, fallback, format, centered = false, reset }) {
  const ref = useRef();
  const [active, setActive] = useState(false);
  const shown = value ?? fallback ?? min;
  const frac = clamp((shown - min) / (max - min), 0, 1);
  const zero = centered ? clamp((0 - min) / (max - min), 0, 1) : 0;
  const snap = (v) => {
    const s = Math.round(v / step) * step;
    return Number(s.toFixed(6));
  };
  const at = (ev) => {
    const r = ref.current.getBoundingClientRect();
    return snap(min + clamp((ev.clientX - r.left) / r.width, 0, 1) * (max - min));
  };
  const down = (ev) => {
    ev.preventDefault();
    ref.current.setPointerCapture(ev.pointerId);
    setActive(true);
    onChange(at(ev), true);
  };
  const move = (ev) => active && onChange(at(ev), true);
  const up = () => setActive(false);
  const text = format ? format(shown) : String(Math.round(shown * 100) / 100);
  return html`<div class="slider ${value === undefined ? "unset" : ""}">
    <div class="track ${active ? "active" : ""} ${centered ? "centered" : ""}" ref=${ref} onPointerDown=${down} onPointerMove=${move} onPointerUp=${up} onPointerCancel=${up}
      onDblClick=${() => onChange(reset !== undefined ? reset : undefined)}>
      <div class="rail-line"></div>
      ${centered && html`<div class="tick" style=${{ left: zero * 100 + "%" }}></div>`}
      <div class="fill" style=${centered ? { left: Math.min(zero, frac) * 100 + "%", width: Math.abs(frac - zero) * 100 + "%" } : { width: frac * 100 + "%" }}></div>
      <div class="knob" style=${{ left: frac * 100 + "%" }}></div>
    </div>
    <input class="val" value=${text} onFocus=${(e) => e.target.select()}
      onChange=${(e) => {
        const n = parseFloat(e.target.value);
        onChange(Number.isFinite(n) ? clamp(n, min, max) : undefined);
      }} />
  </div>`;
}

// ---------------------------------------------------------------------------------------------
// Number field with a scrubbable label (drag the letter left/right)

export function Num({ label, value, onChange, step = 1, min = -Infinity, max = Infinity, unit = "", digits = 0, placeholder = "auto", title, scale = 1 }) {
  const [draft, setDraft] = useState(null);
  const shown = value === undefined || value === null ? "" : (value * scale).toFixed(digits).replace(/\.0+$/, "").replace(/(\.\d*?)0+$/, "$1");
  const commit = (text) => {
    setDraft(null);
    if (text.trim() === "") return onChange(undefined);
    const n = Number(text.replace(/[^\d.+-]/g, ""));
    if (Number.isFinite(n)) onChange(clamp(n / scale, min, max));
  };
  const scrub = (ev) => {
    ev.preventDefault();
    const start = ev.clientX;
    const v0 = value ?? 0;
    document.body.classList.add("scrubbing");
    const move = (e) => {
      const dx = e.clientX - start;
      const s = e.shiftKey ? step * 10 : e.altKey ? step / 10 : step;
      onChange(clamp(v0 + (Math.round(dx / 2) * s) / scale, min, max), true);
    };
    const up = () => {
      document.body.classList.remove("scrubbing");
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  return html`<div class="num ${value === undefined ? "auto" : ""}" title=${title}>
    <span class="scrub" onPointerDown=${scrub}>${label}</span>
    <input value=${draft ?? shown} placeholder=${placeholder}
      onFocus=${(e) => e.target.select()}
      onInput=${(e) => setDraft(e.target.value)}
      onBlur=${(e) => draft !== null && commit(e.target.value)}
      onKeyDown=${(e) => {
        if (e.key === "Enter") {
          commit(e.target.value);
          e.target.blur();
        } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
          e.preventDefault();
          const d = (e.key === "ArrowUp" ? 1 : -1) * (e.shiftKey ? step * 10 : step);
          onChange(clamp((value ?? 0) + d / scale, min, max));
          setDraft(null);
        } else if (e.key === "Escape") {
          setDraft(null);
          e.target.blur();
        }
        e.stopPropagation();
      }} />
    ${unit && html`<span class="unit">${unit}</span>`}
  </div>`;
}

// ---------------------------------------------------------------------------------------------

export function Switch({ checked, onChange, label }) {
  return html`<label class="switch"><input type="checkbox" checked=${Boolean(checked)} onChange=${(e) => onChange(e.target.checked)} /><span class="sw"></span>${label}</label>`;
}

export function Section({ title, count, children, right, collapsible = false, open: initial = true, id }) {
  const key = id && `sec:${id}`;
  const [open, setOpen] = useState(() => {
    if (!key) return initial;
    try {
      const v = localStorage.getItem(key);
      return v === null ? initial : v === "1";
    } catch {
      return initial;
    }
  });
  const toggle = () => {
    if (!collapsible) return;
    setOpen(!open);
    try {
      key && localStorage.setItem(key, open ? "0" : "1");
    } catch {}
  };
  return html`<section class="section ${collapsible ? "collapsible" : ""} ${open ? "" : "closed"}">
    <div class="section-head" onClick=${toggle}>
      ${collapsible && html`<${Icon} n="down" s=${12} class="chev" />`}
      <h3>${title}${count !== undefined && html` <span class="count">${count}</span>`}</h3>
      ${right && html`<div class="hstack" onClick=${(e) => e.stopPropagation()}>${right}</div>`}
    </div>
    ${open && children}
  </section>`;
}

// ---------------------------------------------------------------------------------------------
// Popover anchored to an element. Closes on outside click or Escape.

export function Popover({ anchor, onClose, children, class: cls = "", align = "start", offset = 6, width, avoid }) {
  const ref = useRef();
  const [pos, setPos] = useState(null);
  useLayoutEffect(() => {
    const place = () => {
      if (!anchor) return;
      const a = anchor.getBoundingClientRect();
      const el = ref.current;
      const w = el.offsetWidth;
      const hgt = el.offsetHeight;
      let left = align === "end" ? a.right - w : align === "center" ? a.left + a.width / 2 - w / 2 : a.left;
      left = clamp(left, 8, window.innerWidth - w - 8);
      // `avoid`: an element to keep in view (what the popover changes). Try below, above, then
      // either side of the anchor, and take the first spot that fits and leaves it uncovered.
      if (avoid) {
        const k = avoid.getBoundingClientRect();
        const spots = [
          { left, top: a.bottom + offset },
          { left, top: a.top - offset - hgt },
          { left: a.right + offset, top: a.top },
          { left: a.left - offset - w, top: a.top },
        ];
        const fits = (p) => p.left >= 8 && p.top >= 8 && p.left + w <= window.innerWidth - 8 && p.top + hgt <= window.innerHeight - 8;
        const clear = (p) => p.left >= k.right || p.left + w <= k.left || p.top >= k.bottom || p.top + hgt <= k.top;
        const spot = spots.find((p) => fits(p) && clear(p));
        if (spot) return setPos(spot);
      }
      let top = a.bottom + offset;
      if (top + hgt > window.innerHeight - 8 && a.top - offset - hgt > 8) top = a.top - offset - hgt;
      setPos({ left, top: clamp(top, 8, window.innerHeight - 40) });
    };
    place();
    const ro = new ResizeObserver(place);
    ro.observe(ref.current);
    window.addEventListener("resize", place);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", place);
    };
  }, [anchor]);
  useEffect(() => {
    const down = (e) => {
      if (ref.current?.contains(e.target) || anchor?.contains(e.target)) return;
      onClose();
    };
    const key = (e) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("pointerdown", down, true);
    window.addEventListener("keydown", key, true);
    return () => {
      window.removeEventListener("pointerdown", down, true);
      window.removeEventListener("keydown", key, true);
    };
  }, [anchor, onClose]);
  return html`<div class="pop ${cls}" ref=${ref} style=${{ left: (pos?.left ?? -9999) + "px", top: (pos?.top ?? -9999) + "px", width: width ? width + "px" : undefined, minWidth: !width && anchor ? anchor.offsetWidth + "px" : undefined }}>${children}</div>`;
}

// ---------------------------------------------------------------------------------------------
// Dropdown: options [{value, label, hint, group}] with optional search.

/** A menu of options to pick one from. `trigger` replaces the button's contents (a bare icon button, say). */
export function Dropdown({ value, options, onChange, placeholder = "Choose…", search = false, icon, render, trigger, btnClass = "dd-btn", title }) {
  const btn = useRef();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const field = useRef();
  const current = options.find((o) => o.value === value);
  const filtered = q ? options.filter((o) => `${o.label} ${o.hint ?? ""} ${o.group ?? ""}`.toLowerCase().includes(q.toLowerCase())) : options;
  useEffect(() => {
    if (open) setActive(Math.max(0, filtered.findIndex((o) => o.value === value)));
    else setQ("");
    // autofocus only works for what's on the page when it loads: focus the search box by hand.
    if (open && search) requestAnimationFrame(() => field.current?.focus());
  }, [open]);
  const pick = (o) => {
    onChange(o.value);
    setOpen(false);
  };
  const key = (e) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => Math.min(filtered.length - 1, a + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(0, a - 1));
    } else if (e.key === "Enter" && filtered[active]) {
      e.preventDefault();
      pick(filtered[active]);
    }
  };
  let lastGroup;
  return html`
    <button class="${btnClass} ${open ? "open" : ""}" ref=${btn} title=${title} onClick=${() => setOpen(!open)}>
      ${trigger ??
      html`${icon && html`<${Icon} n=${icon} s=${14} />`}
        <span class="label">${current ? (render ? render(current) : html`${current.label}${current.hint && html`<span class="muted">${current.hint}</span>`}`) : html`<span class="muted">${placeholder}</span>`}</span>
        <${Icon} n="down" s=${13} />`}
    </button>
    ${open &&
    html`<${Popover} anchor=${btn.current} onClose=${() => setOpen(false)}>
      <div onKeyDown=${key}>
        ${search &&
        html`<div class="menu-search"><div class="input-wrap"><${Icon} n="search" s=${13} /><input class="input sm" ref=${field} placeholder="Search" value=${q}
          onInput=${(e) => {
            setQ(e.target.value);
            setActive(0);
          }} /></div></div>`}
        ${filtered.map((o, i) => {
          const g = o.group && o.group !== lastGroup ? html`<div class="menu-group">${o.group}</div>` : null;
          lastGroup = o.group;
          return html`${g}<button class="menu-item ${i === active ? "active" : ""}" onMouseEnter=${() => setActive(i)} onClick=${() => pick(o)}>
            <span class="check">${o.value === value ? html`<${Icon} n="check" s=${13} w=${2.2} />` : null}</span>
            ${o.swatch && html`<span class="chip-color" style=${{ width: "14px", height: "14px", borderRadius: "4px", background: o.swatch, boxShadow: "inset 0 0 0 1px rgba(255,255,255,.2)" }}></span>`}
            <span style=${o.font ? { fontFamily: o.font } : null}>${o.label}</span>
            ${o.hint && html`<span class="muted">${o.hint}</span>`}
          </button>`;
        })}
        ${!filtered.length && html`<div class="menu-group">No matches</div>`}
      </div>
    <//>`}
  `;
}

// ---------------------------------------------------------------------------------------------
// Colour picker

function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec((hex ?? "").trim());
  if (!m) return null;
  let s = m[1];
  if (s.length === 3) s = [...s].map((c) => c + c).join("");
  return [0, 2, 4].map((i) => parseInt(s.slice(i, i + 2), 16));
}
const toHex = (r, g, b) => "#" + [r, g, b].map((v) => Math.round(clamp(v, 0, 255)).toString(16).padStart(2, "0")).join("");
function rgbToHsv([r, g, b]) {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let hh = 0;
  if (d) hh = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [(hh * 60 + 360) % 360, max ? d / max : 0, max];
}
function hsvToRgb(hh, s, v) {
  const f = (n) => {
    const k = (n + hh / 60) % 6;
    return v - v * s * Math.max(0, Math.min(k, 4 - k, 1));
  };
  return [f(5) * 255, f(3) * 255, f(1) * 255];
}
export const isHex = (c) => Boolean(hexToRgb(c));

const PRESETS = ["#ffffff", "#f4f4f5", "#a1a1aa", "#3f3f46", "#0b0b0d", "#ff5d5d", "#ffb547", "#d2ff4d", "#4ade80", "#22d3ee", "#3b82f6", "#8b7bff", "#ff5fa2", "#f5e6d3", "#1e3a5f", "#5b4ee6", "#0f766e", "#b45309", "#7c2d12", "#fde68a"];

// ---------------------------------------------------------------------------------------------
// Colour clipboard and eyedropper

let probe;
/**
 * Read any CSS colour someone might paste: "ff5fa2", "#F5A", "rgb(255 95 162)", "hotpink",
 * a quoted value from code… Opaque colours come back as #rrggbb; translucent ones as rgba().
 */
export function normalizeColor(text) {
  let s = String(text ?? "").trim().replace(/^['"`]+|['"`;,]+$/g, "").trim();
  if (!s || s.length > 64) return null;
  if (/^[0-9a-f]{3}([0-9a-f]{3})?([0-9a-f]{2})?$/i.test(s)) s = `#${s}`;
  probe ??= document.createElement("canvas").getContext("2d");
  // Two different sentinels tell "invalid" (fillStyle unchanged) from a genuine match.
  probe.fillStyle = "#010203";
  probe.fillStyle = s;
  const a = probe.fillStyle;
  probe.fillStyle = "#040506";
  probe.fillStyle = s;
  const b = probe.fillStyle;
  if (a !== b) return null;
  return a.startsWith("#") ? a.toLowerCase() : a.replace(/\s+/g, " ");
}

export const canPickColor = Boolean(native || window.EyeDropper);

/** Sample a colour from anywhere on screen. Resolves to #rrggbb, or null if cancelled. */
export async function pickScreenColor() {
  try {
    if (native) return normalizeColor((await native.call("pickColor"))?.hex) || null;
    if (window.EyeDropper) return normalizeColor((await new window.EyeDropper().open()).sRGBHex);
  } catch {
    // Escape / cancelled.
  }
  return null;
}

export async function copyColor(value) {
  if (!value) return;
  try {
    if (native) await native.call("copyText", { text: value });
    else await navigator.clipboard.writeText(value);
    toast({ kind: "ok", icon: "copy", title: `Copied ${value}`, timeout: 1600 });
  } catch {
    toast({ kind: "err", title: "Couldn't copy the colour" });
  }
}

/** The colour on the clipboard, or null (with a hint) if it isn't one. */
export async function readClipboardColor() {
  let text = "";
  try {
    text = native ? (await native.call("readText"))?.text ?? "" : await navigator.clipboard.readText();
  } catch {
    toast({ kind: "warn", title: "Couldn't read the clipboard", text: "Paste into the colour's text box instead (⌘V)." });
    return null;
  }
  const c = normalizeColor(text);
  if (!c) toast({ kind: "warn", title: "No colour on the clipboard", text: text ? `“${text.slice(0, 40)}” isn't a colour. Copy a hex like #ff5fa2.` : "Copy a hex like #ff5fa2 first." });
  return c;
}

export function ColorPicker({ value, onChange }) {
  const rgb = hexToRgb(value) ?? [255, 255, 255];
  const [hsv, setHsv] = useState(() => rgbToHsv(rgb));
  const [text, setText] = useState(value ?? "#ffffff");
  const [picking, setPicking] = useState(false);
  useEffect(() => {
    const cur = toHex(...hsvToRgb(...hsv));
    if (value && value.toLowerCase() !== cur) {
      const next = hexToRgb(value);
      if (next) setHsv(rgbToHsv(next));
    }
    setText(value ?? "");
  }, [value]);
  const emit = (next, live) => {
    setHsv(next);
    const hex = toHex(...hsvToRgb(...next));
    setText(hex);
    onChange(hex, live);
  };
  /** Apply a colour from outside the picker (paste, eyedropper, typed). */
  const apply = (c) => {
    const rgbv = hexToRgb(c);
    if (rgbv) emit(rgbToHsv(rgbv));
    else {
      setText(c);
      onChange(c);
    }
  };
  const drag = (el, fn) => (ev) => {
    ev.preventDefault();
    const r = el.current.getBoundingClientRect();
    const go = (e) => fn(clamp((e.clientX - r.left) / r.width, 0, 1), clamp((e.clientY - r.top) / r.height, 0, 1));
    go(ev);
    const move = (e) => go(e);
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  const pick = async () => {
    setPicking(true);
    const c = await pickScreenColor();
    setPicking(false);
    if (c) apply(c);
  };
  const sv = useRef();
  const hue = useRef();
  const [H, Sa, V] = hsv;
  const current = hexToRgb(value) ? value.toLowerCase() : value;
  return html`<div class="cp">
    <div class="cp-sv" ref=${sv} style=${{ background: `hsl(${H}, 100%, 50%)` }} onPointerDown=${drag(sv, (x, y) => emit([H, x, 1 - y], true))}>
      <div class="cp-dot" style=${{ left: Sa * 100 + "%", top: (1 - V) * 100 + "%", background: toHex(...hsvToRgb(H, Sa, V)) }}></div>
    </div>
    <div class="cp-hue" ref=${hue} onPointerDown=${drag(hue, (x) => emit([x * 360, Sa, V], true))}>
      <div class="cp-dot" style=${{ left: (H / 360) * 100 + "%", background: `hsl(${H}, 100%, 50%)` }}></div>
    </div>
    <div class="cp-row">
      ${canPickColor &&
      html`<button class="icon-btn sm cp-tool ${picking ? "on" : ""}" title="Pick a colour from the screen (eyedropper)" onClick=${pick}><${Icon} n="eyedropper" s=${14} /></button>`}
      <input class="input sm mono grow" value=${text} spellcheck=${false} placeholder="#ff5fa2" onInput=${(e) => setText(e.target.value)}
        onKeyDown=${(e) => {
          e.stopPropagation();
          if (e.key === "Enter") e.target.blur();
        }}
        onPaste=${(e) => {
          const c = normalizeColor(e.clipboardData?.getData("text"));
          if (!c) return;
          e.preventDefault();
          apply(c);
        }}
        onChange=${(e) => {
          const v = e.target.value.trim();
          if (!v) return;
          const c = normalizeColor(v);
          if (c) apply(c);
          else {
            setText(value ?? "");
            toast({ kind: "warn", title: `“${v.slice(0, 30)}” isn't a colour`, text: "Try a hex like #ff5fa2, or rgb(255 95 162)." });
          }
        }} />
      <button class="icon-btn sm cp-tool" title="Copy colour" disabled=${!current} onClick=${() => copyColor(current)}><${Icon} n="copy" s=${14} /></button>
      <button class="icon-btn sm cp-tool" title="Paste a colour (hex, rgb or name)" onClick=${async () => {
        const c = await readClipboardColor();
        if (c) apply(c);
      }}><${Icon} n="paste" s=${14} /></button>
    </div>
    <div class="cp-presets">${PRESETS.map((c) => html`<button style=${{ background: c }} title=${c} onClick=${() => emit(rgbToHsv(hexToRgb(c)))}></button>`)}</div>
  </div>`;
}

/**
 * A colour field: click to open the picker; hover for copy and paste. With no `value` it shows
 * the `auto` label, and `autoColor` (an inherited colour) in the swatch when there is one.
 * ⌘C / ⌘V work while it has focus.
 */
export function ColorButton({ value, onChange, auto = "Auto", allowAuto = true, autoColor }) {
  const ref = useRef();
  const [open, setOpen] = useState(false);
  const shown = value || autoColor;
  const paste = async () => {
    const c = await readClipboardColor();
    if (c) onChange(c);
  };
  const keys = (e) => {
    if (!(e.metaKey || e.ctrlKey)) return;
    const k = e.key.toLowerCase();
    if (k === "c" && shown) {
      e.preventDefault();
      e.stopPropagation();
      copyColor(shown);
    } else if (k === "v") {
      e.preventDefault();
      e.stopPropagation();
      paste();
    }
  };
  // The Edit menu's Copy/Paste arrive as clipboard events rather than key presses.
  const onCopy = (e) => {
    if (!shown) return;
    e.preventDefault();
    e.clipboardData?.setData("text/plain", shown);
    toast({ kind: "ok", icon: "copy", title: `Copied ${shown}`, timeout: 1600 });
  };
  const onPaste = (e) => {
    const c = normalizeColor(e.clipboardData?.getData("text"));
    if (!c) return;
    e.preventDefault();
    onChange(c);
  };
  return html`<div class="color-field" onKeyDown=${keys} onCopy=${onCopy} onPaste=${onPaste}>
    <button class="color-btn ${value ? "" : "auto"}" ref=${ref} onClick=${() => setOpen(!open)}>
      <span class="chip-color" style=${{ background: shown || "repeating-conic-gradient(#333 0 25%, #222 0 50%) 0 0 / 8px 8px" }}></span>
      <span class="grow">${value || auto}</span>
    </button>
    <span class="cf-tools">
      ${shown && html`<button class="icon-btn sm" title=${`Copy ${shown}`} onClick=${() => copyColor(shown)}><${Icon} n="copy" s=${12} /></button>`}
      <button class="icon-btn sm" title="Paste a colour" onClick=${paste}><${Icon} n="paste" s=${12} /></button>
    </span>
  </div>
    ${open &&
    html`<${Popover} anchor=${ref.current} onClose=${() => setOpen(false)} width=${252}>
      <${ColorPicker} value=${value ?? autoColor} onChange=${onChange} />
      ${allowAuto &&
      value &&
      html`<div style=${{ padding: "0 6px 6px" }}><button class="btn sm ghost block" onClick=${() => {
        onChange(undefined);
        setOpen(false);
      }}>Reset to ${auto.toLowerCase()}</button></div>`}
    <//>`}`;
}

/** Keep typing local while focused; commit on each input with a coalescing key. */
export function TextField({ value, onChange, placeholder, multiline = false, rows = 2, autoFocus = false, class: cls = "", onFocus, onEnter }) {
  const props = {
    class: `${multiline ? "textarea" : "input"} ${cls}`,
    value: value ?? "",
    placeholder,
    autoFocus,
    onFocus,
    onInput: (e) => onChange(e.target.value),
    onKeyDown: (e) => {
      e.stopPropagation();
      if (e.key === "Enter" && onEnter && (!multiline || e.metaKey)) {
        e.preventDefault();
        onEnter();
      }
    },
  };
  return multiline ? html`<textarea rows=${rows} ...${props}></textarea>` : html`<input ...${props} />`;
}

/**
 * A text box for words that can carry **accent** spans, with a button that wraps (or unwraps)
 * the selected words in stars, so nobody has to know the markup.
 */
export function AccentText({ value, onChange, placeholder, rows = 2, onFocus }) {
  const ref = useRef();
  const toggle = (e) => {
    e.preventDefault(); // keep the text selection
    const el = ref.current;
    if (!el) return;
    const v = el.value;
    let a = el.selectionStart;
    let b = el.selectionEnd;
    if (a === b) {
      // Nothing selected: use the word under the cursor.
      while (a > 0 && /\S/.test(v[a - 1])) a--;
      while (b < v.length && /\S/.test(v[b])) b++;
    }
    if (a === b) return;
    let next;
    let sel;
    if (v.slice(a - 2, a) === "**" && v.slice(b, b + 2) === "**") {
      next = v.slice(0, a - 2) + v.slice(a, b) + v.slice(b + 2);
      sel = [a - 2, b - 2];
    } else if (b - a > 4 && v.slice(a, a + 2) === "**" && v.slice(b - 2, b) === "**") {
      next = v.slice(0, a) + v.slice(a + 2, b - 2) + v.slice(b);
      sel = [a, b - 4];
    } else {
      next = `${v.slice(0, a)}**${v.slice(a, b)}**${v.slice(b)}`;
      sel = [a + 2, b + 2];
    }
    onChange(next);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(sel[0], sel[1]);
    });
  };
  return html`<div class="accent-field">
    <textarea ref=${ref} class="textarea" rows=${rows} value=${value ?? ""} placeholder=${placeholder} onFocus=${onFocus}
      title="Enter to finish · Shift+Enter for a new line"
      onInput=${(e) => onChange(e.target.value)}
      onKeyDown=${(e) => {
        e.stopPropagation();
        // Enter finishes, like the canvas's own text editing; Shift+Enter breaks the line.
        if (e.key === "Enter" && !e.shiftKey && !e.altKey && !e.isComposing) {
          e.preventDefault();
          e.target.blur();
        }
      }}
      onBlur=${(e) => {
        const trimmed = e.target.value.replace(/\s+$/, "");
        if (trimmed !== e.target.value) onChange(trimmed);
      }}></textarea>
    <button class="accent-btn" onMouseDown=${toggle} title="Wraps the selected words in **stars** so they take the star colour. Click again to undo.">
      <${Icon} n="spark" s=${12} />Colour selected words
    </button>
  </div>`;
}
