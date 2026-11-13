// Reusable controls: segmented, slider, scrubbable number, switch, dropdown, popover, colour picker.
import { h } from "preact";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import htm from "htm";
import { Icon } from "./icons.js";
import { clamp, native, toast } from "./store.js";

export const html = htm.bind(h);

// ---------------------------------------------------------------------------------------------
// Segmented control

/** An option's value as a name people read: "warm-film" → "Warm film". */
export const optionName = (v) => String(v).charAt(0).toUpperCase() + String(v).slice(1).replace(/-/g, " ");

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
      // A plain value reads as a name ("light" → "Light").
      const label = typeof o === "object" ? o.label : optionName(o);
      return html`<button class=${v === value ? "on" : ""} title=${o.title ?? ""} onClick=${() => onChange(v)}>${o.icon ? html`<${Icon} n=${o.icon} s=${14} />` : null}${label}</button>`;
    })}
  </div>`;
}

// ---------------------------------------------------------------------------------------------
// Drags

/**
 * Follow a drag from a pointerdown until it ends, on the window so it carries on outside the
 * element. Letting go calls `done`; so does a drag that's lost (the pointer cancelled, the window
 * losing focus mid-drag with ⌘Tab, or a move with the button already up), so nothing is left
 * following the pointer. Escape calls `cancel` instead, to put things back as they were. Other keys
 * wait until it's over: Delete mid-drag would take away the very thing being dragged.
 */
export function followDrag({ move, done, cancel }) {
  let over = false;
  const stop = () => {
    over = true;
    removeEventListener("pointermove", onMove);
    removeEventListener("pointerup", onUp);
    removeEventListener("pointercancel", onUp);
    removeEventListener("blur", onUp);
    removeEventListener("keydown", onKey, true);
  };
  const end = (fn, e) => {
    if (over) return;
    stop();
    fn?.(e);
  };
  const onUp = (e) => end(done, e);
  const onMove = (e) => {
    // A mouse moving with no button down was let go of somewhere we didn't hear about.
    if (e.pointerType === "mouse" && e.buttons === 0) return end(done, e);
    move?.(e);
  };
  const onKey = (e) => {
    if (["Shift", "Alt", "Meta", "Control"].includes(e.key)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (e.key === "Escape") end(cancel ?? done, e);
  };
  addEventListener("pointermove", onMove);
  addEventListener("pointerup", onUp);
  addEventListener("pointercancel", onUp);
  addEventListener("blur", onUp);
  addEventListener("keydown", onKey, true);
  return stop;
}

/**
 * Whether keys like Space and Tab are the canvas's: only while no control has the keyboard. A
 * button, field or menu reached with the keyboard keeps them (Space presses it, Tab moves on); one
 * that only has focus because it was clicked (Chrome leaves it there) doesn't.
 */
export function keysForCanvas() {
  const a = document.activeElement;
  if (!a || a === document.body || a === document.documentElement) return true;
  if (/^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName) || a.isContentEditable) return false;
  try {
    return !a.matches(":focus-visible");
  } catch {
    return false;
  }
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
    if (ev.button !== 0) return;
    ev.preventDefault();
    const was = value;
    setActive(true);
    onChange(at(ev), true);
    followDrag({
      move: (e) => onChange(at(e), true),
      done: () => setActive(false),
      // Escape puts it back as it was before the drag.
      cancel: () => {
        setActive(false);
        onChange(was, true);
      },
    });
  };
  const text = format ? format(shown) : String(Math.round(shown * 100) / 100);
  return html`<div class="slider ${value === undefined ? "unset" : ""}">
    <div class="track ${active ? "active" : ""} ${centered ? "centered" : ""}" ref=${ref} onPointerDown=${down}
      onDblClick=${() => onChange(reset !== undefined ? reset : undefined)}>
      <div class="rail-line"></div>
      ${centered && html`<div class="tick" style=${{ left: zero * 100 + "%" }}></div>`}
      <div class="fill" style=${centered ? { left: Math.min(zero, frac) * 100 + "%", width: Math.abs(frac - zero) * 100 + "%" } : { width: frac * 100 + "%" }}></div>
      <div class="knob" style=${{ left: frac * 100 + "%" }}></div>
    </div>
    <input class="val" value=${text} onFocus=${(e) => e.target.select()}
      onChange=${(e) => {
        const v = sliderValue(e.target.value, { min, max, step, format });
        // Words that aren't a value put back what was there; a value shows as the slider shows it.
        e.target.value = String(v === null ? text : format ? format(v) : Math.round(v * 100) / 100);
        if (v !== null) onChange(v);
      }} />
  </div>`;
}

/**
 * A slider's typed value, in the units its box shows ("120%" or just 120 for a brightness shown as
 * 120% is 1.2). `format` can scale, round, add a unit or show a word at one end ("Straight",
 * "Off"), so it isn't undone by hand: the value is the slider's step whose shown number is nearest
 * the typed one (on a tie, the roundest), or the step shown as the typed word. null when nothing
 * typed reads as a value.
 */
export function sliderValue(typed, { min, max, step = 0.01, format }) {
  const t = String(typed ?? "").trim().replace(/−/g, "-").replace(",", ".");
  const numberIn = (s) => {
    const m = /[-+]?(\d+\.?\d*|\.\d+)/.exec(String(s));
    return m ? Number(m[0]) : NaN;
  };
  const n = numberIn(t);
  if (!t) return null;
  if (!format) return Number.isFinite(n) ? clamp(n, min, max) : null;
  // Every value the slider can take (in at most a few thousand steps), with the number it shows.
  const k = Math.max(step, (max - min) / 4000);
  const vals = [min];
  for (let i = Math.ceil(min / k - 1e-9); i * k < max - 1e-9; i++) if (i * k > min + 1e-9) vals.push(Number((i * k).toFixed(6)));
  vals.push(max);
  const shown = vals.map((v) => String(format(v)));
  if (!Number.isFinite(n)) {
    const word = t.toLowerCase().replace(/\s+/g, "");
    const i = shown.findIndex((s) => s.toLowerCase().replace(/\s+/g, "") === word);
    return i < 0 ? null : vals[i];
  }
  const nums = shown.map(numberIn);
  // A step shown as a word ("Straight") stands for the number a straight line through the ends gives it.
  const ends = nums.map((x, i) => i).filter((i) => Number.isFinite(nums[i]));
  if (ends.length >= 2) {
    const [a, b] = [ends[0], ends[ends.length - 1]];
    const slope = (nums[b] - nums[a]) / (vals[b] - vals[a] || 1);
    nums.forEach((x, i) => Number.isFinite(x) || (nums[i] = nums[a] + (vals[i] - vals[a]) * slope));
  }
  let best = Infinity;
  let hits = [];
  nums.forEach((x, i) => {
    const d = Math.abs(x - n);
    if (!Number.isFinite(d) || d > best + 1e-9) return;
    if (d < best - 1e-9) hits = [];
    best = Math.min(best, d);
    hits.push(vals[i]);
  });
  if (!hits.length) return null;
  const decimals = (v) => (String(v).split(".")[1] ?? "").length;
  const mid = (hits[0] + hits[hits.length - 1]) / 2;
  return hits.sort((a, b) => decimals(a) - decimals(b) || Math.abs(a - mid) - Math.abs(b - mid))[0];
}

// ---------------------------------------------------------------------------------------------
// Number field with a scrubbable label (drag the letter left/right)

export function Num({ label, value, onChange, step = 1, min = -Infinity, max = Infinity, unit = "", digits = 0, placeholder = "auto", title, scale = 1 }) {
  const [draft, setDraft] = useState(null);
  // Enter and Escape are done with the field before the blur they cause: that blur mustn't commit (again).
  const settled = useRef(false);
  const shown = value === undefined || value === null ? "" : (value * scale).toFixed(digits).replace(/\.0+$/, "").replace(/(\.\d*?)0+$/, "$1");
  const commit = (text) => {
    setDraft(null);
    if (text.trim() === "") return onChange(undefined);
    const n = Number(text.replace(/[^\d.+-]/g, ""));
    if (Number.isFinite(n)) onChange(clamp(n / scale, min, max));
  };
  const scrub = (ev) => {
    if (ev.button !== 0) return;
    ev.preventDefault();
    const start = ev.clientX;
    const was = value;
    const v0 = value ?? 0;
    let moved = false;
    document.body.classList.add("scrubbing");
    const end = () => document.body.classList.remove("scrubbing");
    followDrag({
      move: (e) => {
        const dx = e.clientX - start;
        const s = e.shiftKey ? step * 10 : e.altKey ? step / 10 : step;
        moved = true;
        onChange(clamp(v0 + (Math.round(dx / 2) * s) / scale, min, max), true);
      },
      done: end,
      // Escape puts the value back as it was before the scrub.
      cancel: () => {
        end();
        if (moved) onChange(was, true);
      },
    });
  };
  return html`<div class="num ${value === undefined ? "auto" : ""}" title=${title}>
    <span class="scrub" onPointerDown=${scrub}>${label}</span>
    <input value=${draft ?? shown} placeholder=${placeholder}
      onFocus=${(e) => e.target.select()}
      onInput=${(e) => setDraft(e.target.value)}
      onBlur=${(e) => (settled.current ? (settled.current = false) : draft !== null && commit(e.target.value))}
      onKeyDown=${(e) => {
        if (e.key === "Enter") {
          commit(e.target.value);
          settled.current = true;
          e.target.blur();
        } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
          e.preventDefault();
          const d = (e.key === "ArrowUp" ? 1 : -1) * (e.shiftKey ? step * 10 : step);
          onChange(clamp((value ?? 0) + d / scale, min, max));
          setDraft(null);
        } else if (e.key === "Escape") {
          setDraft(null);
          settled.current = true;
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
// Popover anchored to an element. Closes on outside click or Escape (the one on top only), and
// follows its anchor as what's around it scrolls (closing once the anchor is scrolled out of view).

/** The popovers open now, the newest last: Escape closes only that one. */
const openPopovers = [];

export function Popover({ anchor, onClose, children, class: cls = "", align = "start", offset = 6, width, avoid }) {
  const ref = useRef();
  const [pos, setPos] = useState(null);
  const close = useRef(onClose);
  close.current = onClose;
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
      // Kept whole on screen: a tall one near the bottom moves up rather than running off it.
      setPos({ left, top: clamp(top, 8, Math.max(8, window.innerHeight - hgt - 8)) });
    };
    place();
    const ro = new ResizeObserver(place);
    ro.observe(ref.current);
    // Something round the anchor scrolled (a panel, the page): follow it, or close once it's out of sight.
    const scrolled = (e) => {
      if (!anchor || ref.current?.contains(e.target)) return;
      const box = e.target instanceof Element ? e.target.getBoundingClientRect() : null;
      if (box && !e.target.contains(anchor)) return;
      const a = anchor.getBoundingClientRect();
      const view = box ?? { top: 0, left: 0, bottom: window.innerHeight, right: window.innerWidth };
      const gone = !anchor.isConnected || a.bottom <= view.top || a.top >= view.bottom || a.right <= view.left || a.left >= view.right;
      if (gone) close.current();
      else place();
    };
    window.addEventListener("resize", place);
    window.addEventListener("scroll", scrolled, true);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", scrolled, true);
    };
  }, [anchor]);
  const mine = useRef({});
  useEffect(() => {
    openPopovers.push(mine.current);
    return () => openPopovers.splice(openPopovers.indexOf(mine.current), 1);
  }, []);
  useEffect(() => {
    const down = (e) => {
      if (ref.current?.contains(e.target) || anchor?.contains(e.target)) return;
      onClose();
    };
    const key = (e) => {
      // One Escape closes one popover: the newest (a colour picker opened from a menu goes first).
      if (e.key === "Escape" && openPopovers[openPopovers.length - 1] === mine.current) {
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
  const list = useRef();
  const current = options.find((o) => o.value === value);
  const filtered = q ? options.filter((o) => `${o.label} ${o.hint ?? ""} ${o.group ?? ""}`.toLowerCase().includes(q.toLowerCase())) : options;
  /** Scroll the highlighted row into sight, in the menu's own scroll. */
  const showActive = () => {
    const item = list.current?.querySelector(".menu-item.active");
    const box = item?.closest(".pop");
    if (!box) return;
    const b = box.getBoundingClientRect();
    const r = item.getBoundingClientRect();
    if (r.top < b.top) box.scrollTop -= b.top - r.top + 6;
    else if (r.bottom > b.bottom) box.scrollTop += r.bottom - b.bottom + 6;
  };
  // The button was given the keyboard only for the menu: it goes back when the menu closes.
  const lent = useRef(false);
  useEffect(() => {
    if (open) setActive(Math.max(0, filtered.findIndex((o) => o.value === value)));
    else setQ("");
    if (!open && lent.current && document.activeElement === btn.current) btn.current.blur();
    lent.current = open && !search && document.activeElement !== btn.current;
    // autofocus only works for what's on the page when it loads: focus the search box by hand.
    // Without one the button keeps the keyboard (WebKit doesn't focus a clicked button), so the
    // arrow keys and Enter reach the menu.
    if (open)
      requestAnimationFrame(() => {
        (search ? field.current : btn.current)?.focus({ preventScroll: true });
        showActive();
      });
  }, [open]);
  // The arrow keys move the highlight: it stays in sight (hovering doesn't scroll).
  const follow = useRef(false);
  useEffect(() => {
    if (follow.current) showActive();
    follow.current = false;
  }, [active]);
  const pick = (o) => {
    onChange(o.value);
    setOpen(false);
  };
  const key = (e) => {
    const go = (fn) => {
      e.preventDefault();
      // The keys are the menu's while it's open (not the canvas's: arrows would move the selection).
      e.stopPropagation();
      follow.current = true;
      setActive(fn);
    };
    if (e.key === "ArrowDown") go((a) => Math.min(filtered.length - 1, a + 1));
    else if (e.key === "ArrowUp") go((a) => Math.max(0, a - 1));
    else if (e.key === "Home" && !search) go(() => 0);
    else if (e.key === "End" && !search) go(() => filtered.length - 1);
    else if (e.key === "Enter" && filtered[active]) {
      e.preventDefault();
      e.stopPropagation();
      pick(filtered[active]);
    }
  };
  let lastGroup;
  return html`
    <button class="${btnClass} ${open ? "open" : ""}" ref=${btn} title=${title ?? (current ? `${current.label}${current.hint ? ` · ${current.hint}` : ""}` : undefined)} onClick=${() => setOpen(!open)}
      onKeyDown=${open && !search ? key : undefined}>
      ${trigger ??
      html`${icon && html`<${Icon} n=${icon} s=${14} />`}
        <span class="label">${current ? (render ? render(current) : html`${current.label}${current.hint && html`<span class="muted">${current.hint}</span>`}`) : html`<span class="muted">${placeholder}</span>`}</span>
        <${Icon} n="down" s=${13} />`}
    </button>
    ${open &&
    html`<${Popover} anchor=${btn.current} onClose=${() => setOpen(false)}>
      <div onKeyDown=${key} ref=${list}>
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
/**
 * A colour's red, green, blue and alpha (0–1): from hex, or the rgba() that normalizeColor gives a
 * see-through colour. null if it's neither.
 */
function readRgba(c) {
  const rgb = hexToRgb(c);
  if (rgb) return [...rgb, 1];
  const m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:\s*[,/]\s*([\d.]+)(%?))?\s*\)$/i.exec(String(c ?? "").trim());
  if (!m) return null;
  const a = m[4] === undefined ? 1 : Number(m[4]) / (m[5] ? 100 : 1);
  return [Number(m[1]), Number(m[2]), Number(m[3]), clamp(a, 0, 1)];
}
const toHex = (r, g, b) => "#" + [r, g, b].map((v) => Math.round(clamp(v, 0, 255)).toString(16).padStart(2, "0")).join("");
/** A colour as the picker writes it: #rrggbb, or rgba() when it's see-through. */
const toColor = ([r, g, b], a = 1) => (a < 1 ? `rgba(${[r, g, b].map((v) => Math.round(clamp(v, 0, 255))).join(", ")}, ${Math.round(a * 1000) / 1000})` : toHex(r, g, b));
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

// ---------------------------------------------------------------------------------------------
// Tokens: a board's named values (CSS custom properties), which its colour fields use as
// var(--name). Only boards pass `tokens` to the colour controls; without them nothing changes.

/** The token a value is, when it's just `var(--name)` (a fallback allowed): "--name", or null. */
export function tokenRef(v) {
  const s = String(v ?? "").trim();
  const m = /^var\(\s*(--[A-Za-z0-9_-]+)\s*[,)]/.exec(s);
  if (!m) return null;
  // The var() has to be the whole value: its closing bracket is the last thing in it.
  for (let i = 3, d = 0; i < s.length; i++) {
    if (s[i] === "(") d++;
    else if (s[i] === ")" && --d === 0) return i === s.length - 1 ? m[1] : null;
  }
  return null;
}

const tokenMap = (tokens) => (tokens instanceof Map ? tokens : new Map((tokens ?? []).map((t) => [t.name, t.value])));

/** Where a list's first comma outside brackets is, or -1. */
function topComma(s) {
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "(") depth++;
    else if (s[i] === ")") depth--;
    else if (s[i] === "," && depth === 0) return i;
  }
  return -1;
}

/**
 * A CSS value with every var() swapped for what it stands for, so the panel can draw it as the
 * canvas does (the panel's own CSS has tokens of the same names, like --lime, which would answer
 * instead). A token can use other tokens; a missing one takes its fallback; one that can't be
 * resolved (missing, or going round in a circle) becomes nothing, as it does in CSS.
 */
export function resolveVars(value, tokens, depth = 0) {
  const s = String(value ?? "");
  if (!s.includes("var(")) return s;
  const map = tokenMap(tokens);
  let out = "";
  let i = 0;
  for (;;) {
    const at = s.indexOf("var(", i);
    if (at < 0) return out + s.slice(i);
    out += s.slice(i, at);
    let end = at + 3;
    for (let d = 0; end < s.length; end++) {
      if (s[end] === "(") d++;
      else if (s[end] === ")" && --d === 0) break;
    }
    const inner = s.slice(at + 4, end);
    const comma = topComma(inner);
    const name = (comma < 0 ? inner : inner.slice(0, comma)).trim();
    let got = depth < 12 && map.has(name) ? resolveVars(map.get(name), map, depth + 1).trim() : "";
    if (!got && comma >= 0 && depth < 12) got = resolveVars(inner.slice(comma + 1), map, depth + 1).trim();
    out += got;
    i = end + 1;
  }
}

/** The colour a value comes to through the tokens (#rrggbb or rgba()), or null if it isn't one. */
export function tokenColor(value, tokens) {
  const r = resolveVars(value, tokens).trim();
  return r ? normalizeColor(r) : null;
}

/** The tokens whose value is a colour (or a var() that comes to one), each with that colour. */
export function colorTokens(tokens) {
  const map = tokenMap(tokens);
  return (tokens ?? []).map((t) => ({ ...t, color: tokenColor(t.value, map) })).filter((t) => t.color);
}

/** A colour from text: any CSS colour, or with `tokens` one of them (`var(--name)` or `--name`). */
export function readColor(text, tokens) {
  const c = normalizeColor(text);
  if (c || !tokens) return c;
  const s = String(text ?? "").trim();
  const ref = tokenRef(s);
  const name = ref ?? (/^--[A-Za-z0-9_-]+$/.test(s) ? s : null);
  if (!name || !tokenColor(`var(${name})`, tokens)) return null;
  return ref ? s : `var(${name})`;
}

/** The colour on the clipboard, or null (with a hint) if it isn't one. With `tokens`, a token's var() counts. */
export async function readClipboardColor(tokens) {
  let text = "";
  try {
    text = native ? (await native.call("readText"))?.text ?? "" : await navigator.clipboard.readText();
  } catch {
    toast({ kind: "warn", title: "Couldn't read the clipboard", text: "Paste into the colour's text box instead (⌘V)." });
    return null;
  }
  const c = readColor(text, tokens);
  if (!c) toast({ kind: "warn", title: "No colour on the clipboard", text: text ? `“${text.slice(0, 40)}” isn't a colour. Copy a hex like #ff5fa2.` : "Copy a hex like #ff5fa2 first." });
  return c;
}

/**
 * A colour picker. With `tokens` (a board's) it also lists the colour tokens to pick, which it
 * writes as `var(--name)`, and with `onMakeToken(name, colour)` it can make one from the colour.
 */
export function ColorPicker({ value: given, onChange, tokens, onMakeToken }) {
  // A token shows as the colour it stands for; changing that colour makes it a plain one again.
  const ref = tokens ? tokenRef(given) : null;
  const value = ref ? tokenColor(given, tokens) ?? undefined : given;
  // A see-through colour keeps how see-through it is as its colour is changed here.
  const rgba = readRgba(value);
  const alpha = rgba?.[3] ?? 1;
  const [hsv, setHsv] = useState(() => rgbToHsv(rgba?.slice(0, 3) ?? [255, 255, 255]));
  const [text, setText] = useState(value ?? "#ffffff");
  const [picking, setPicking] = useState(false);
  useEffect(() => {
    const cur = toHex(...hsvToRgb(...hsv));
    const next = readRgba(value);
    if (next && toHex(...next) !== cur) setHsv(rgbToHsv(next.slice(0, 3)));
    setText(value ?? "");
  }, [value, given]);
  const emit = (next, live, a = alpha) => {
    setHsv(next);
    const c = toColor(hsvToRgb(...next), a);
    setText(c);
    onChange(c, live);
  };
  /** Apply a colour from outside the picker (paste, eyedropper, typed), with its own alpha. */
  const apply = (c) => {
    const v = readRgba(c);
    if (v) emit(rgbToHsv(v.slice(0, 3)), undefined, v[3]);
    else {
      setText(c);
      onChange(c);
    }
  };
  const drag = (el, fn) => (ev) => {
    if (ev.button !== 0) return;
    ev.preventDefault();
    const r = el.current.getBoundingClientRect();
    const go = (e) => fn(clamp((e.clientX - r.left) / r.width, 0, 1), clamp((e.clientY - r.top) / r.height, 0, 1));
    // Escape puts back the colour it had before the drag.
    const [hsv0, given0] = [hsv, given];
    go(ev);
    followDrag({
      move: go,
      cancel: () => {
        setHsv(hsv0);
        setText(given0 ?? "");
        onChange(given0, true);
      },
    });
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
  // A token copies as its var(), so pasting it into another of the board's fields keeps the token.
  const current = ref ? `var(${ref})` : hexToRgb(value) ? value.toLowerCase() : value;
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
          const c = readColor(e.clipboardData?.getData("text"), tokens);
          if (!c) return;
          e.preventDefault();
          apply(c);
        }}
        onChange=${(e) => {
          const v = e.target.value.trim();
          if (!v) return;
          const c = readColor(v, tokens);
          if (c) apply(c);
          else {
            setText(value ?? "");
            toast({ kind: "warn", title: `“${v.slice(0, 30)}” isn't a colour`, text: tokens ? "Try a hex like #ff5fa2, rgb(255 95 162), or a token's name." : "Try a hex like #ff5fa2, or rgb(255 95 162)." });
          }
        }} />
      <button class="icon-btn sm cp-tool" title="Copy colour" disabled=${!current} onClick=${() => copyColor(current)}><${Icon} n="copy" s=${14} /></button>
      <button class="icon-btn sm cp-tool" title="Paste a colour (hex, rgb or name)" onClick=${async () => {
        const c = await readClipboardColor(tokens);
        if (c) apply(c);
      }}><${Icon} n="paste" s=${14} /></button>
    </div>
    ${tokens &&
    html`<${TokenChips} tokens=${tokens} current=${ref} onPick=${(name) => onChange(`var(${name})`)}
      onMake=${onMakeToken &&
      ((name) => {
        // The colour as the picker has it: a token's own colour, or what's been picked.
        onMakeToken(name, normalizeColor(value ?? "") ?? toHex(...hsvToRgb(...hsv)));
        onChange(`var(${name})`);
      })} />`}
    <div class="cp-presets">${PRESETS.map((c) => html`<button style=${{ background: c }} title=${c} onClick=${() => emit(rgbToHsv(hexToRgb(c)))}></button>`)}</div>
  </div>`;
}

/** The board's colour tokens in the picker, as chips (before the presets: they're the board's own palette), and "Make a token". */
function TokenChips({ tokens, current, onPick, onMake }) {
  const list = colorTokens(tokens);
  // null while not making one; otherwise the name being typed.
  const [name, setName] = useState(null);
  const field = useRef();
  useEffect(() => {
    if (name !== null) requestAnimationFrame(() => field.current?.focus());
  }, [name === null]);
  const clean = (name ?? "").replace(/^-+|-+$/g, "");
  const full = `--${clean}`;
  const taken = Boolean(clean) && tokens.some((t) => t.name === full);
  const make = () => {
    if (!clean || taken) return;
    onMake(full);
    setName(null);
  };
  return html`<div class="cp-tokens">
    ${name === null
      ? html`<div class="cp-tokens-head"><span>Tokens</span>
          ${onMake && html`<button class="btn sm ghost cp-make" title="Give this colour a name any layer can use: change the token, and every layer using it changes" onClick=${() => setName("")}><${Icon} n="plus" s=${12} />Make a token</button>`}
        </div>`
      : html`<div class="cp-row">
          <input class="input sm mono grow" ref=${field} placeholder="Name it, e.g. brand" value=${name} spellcheck=${false}
            onInput=${(e) => setName(e.target.value.replace(/[^A-Za-z0-9_-]/g, "-"))}
            onKeyDown=${(e) => {
              e.stopPropagation();
              if (e.key === "Enter") make();
            }} />
          <button class="btn sm" disabled=${!clean || taken} onClick=${make}>Add</button>
          <button class="icon-btn sm cp-tool" title="Don't make one" onClick=${() => setName(null)}><${Icon} n="x" s=${12} /></button>
        </div>
        ${taken && html`<p class="cp-hint">There's a token called ${clean} already. Pick it below, or choose another name.</p>`}`}
    ${list.length > 0 &&
    html`<div class="cp-chips">${list.map(
      (t) => html`<button class="cp-token ${t.name === current ? "on" : ""}" title=${`var(${t.name}): ${t.value}`} onClick=${() => onPick(t.name)}>
        <i style=${{ background: t.color }}></i><span>${t.name.slice(2)}</span>
      </button>`,
    )}</div>`}
  </div>`;
}

/**
 * A colour field: click to open the picker; hover for copy and paste. With no `value` it shows
 * the `auto` label, and `autoColor` (an inherited colour) in the swatch when there is one.
 * ⌘C / ⌘V work while it has focus. With `tokens` (a board's), a `var(--name)` value shows as the
 * token's name and colour, and the picker offers the tokens (and `onMakeToken`, making one).
 */
export function ColorButton({ value, onChange, auto = "Auto", allowAuto = true, autoColor, tokens, onMakeToken }) {
  const ref = useRef();
  const [open, setOpen] = useState(false);
  const shown = value || autoColor;
  const token = tokens ? tokenRef(value) : null;
  const swatch = tokens && shown ? resolveVars(shown, tokens).trim() : shown;
  const paste = async () => {
    const c = await readClipboardColor(tokens);
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
    const c = readColor(e.clipboardData?.getData("text"), tokens);
    if (!c) return;
    e.preventDefault();
    onChange(c);
  };
  const missing = token && !swatch;
  return html`<div class="color-field" onKeyDown=${keys} onCopy=${onCopy} onPaste=${onPaste}>
    <button class="color-btn ${value ? "" : "auto"}" ref=${ref} onClick=${() => setOpen(!open)}
      title=${token ? (missing ? `There's no token called ${token} on this board` : `var(${token}): ${tokens.find((t) => t.name === token)?.value ?? ""}`) : undefined}>
      <span class="chip-color" style=${{ background: swatch || "repeating-conic-gradient(#333 0 25%, #222 0 50%) 0 0 / 8px 8px" }}></span>
      <span class="grow">${token ? html`<span class="cb-token ${missing ? "missing" : ""}">${token.slice(2)}</span>` : value || auto}</span>
    </button>
    <span class="cf-tools">
      ${shown && html`<button class="icon-btn sm" title=${`Copy ${shown}`} onClick=${() => copyColor(shown)}><${Icon} n="copy" s=${12} /></button>`}
      <button class="icon-btn sm" title="Paste a colour" onClick=${paste}><${Icon} n="paste" s=${12} /></button>
    </span>
  </div>
    ${open &&
    html`<${Popover} anchor=${ref.current} onClose=${() => setOpen(false)} width=${252}>
      <${ColorPicker} value=${value ?? autoColor} onChange=${onChange} tokens=${tokens} onMakeToken=${onMakeToken} />
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

/** The words as they look while retyping them: accent words in the accent (no ** to see), lines as breaks. */
export const accentEditHtml = (text, accentCss = "") => {
  const esc = (t) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const css = accentCss.replace(/"/g, "'");
  return String(text ?? "")
    // An accent can run over a line break ("**two\nlines**").
    .split(/\*\*([\s\S]+?)\*\*/g)
    .map((part, i) => {
      const h = esc(part).replace(/\\n|\n/g, "<br>");
      return i % 2 ? `<span data-acc style="${css}">${h}</span>` : h;
    })
    .join("");
};

/** Back to the stored words: accent runs (and anything a paste made bold) as **…**, breaks as new lines. */
export const accentFromEdit = (el) => {
  const runs = [];
  const add = (t, acc) => {
    const last = runs[runs.length - 1];
    if (last && last.acc === acc) last.t += t;
    else runs.push({ t, acc });
  };
  const walk = (n, acc) =>
    n.childNodes.forEach((c) => {
      if (c.nodeType === 3) return add(c.data, acc);
      if (c.nodeName === "BR") return add("\n", false);
      // A new line typed in the middle comes as a block of its own.
      if (c.nodeName === "DIV" && runs.length && !runs[runs.length - 1].t.endsWith("\n")) add("\n", false);
      walk(c, acc || c.hasAttribute?.("data-acc") || c.nodeName === "B" || c.nodeName === "STRONG");
    });
  walk(el, false);
  return runs
    .map(({ t, acc }) => {
      if (!acc || !t.trim()) return t;
      const [, lead, mid, trail] = t.match(/^(\s*)([\s\S]*?)(\s*)$/);
      return `${lead}**${mid}**${trail}`;
    })
    .join("")
    .replace(/ /g, " ")
    .replace(/\n+$/, "");
};

/** ⌘B while retyping: the chosen words become accent words, or plain again if they already are. */
export const toggleAccentIn = (root, accentCss = "") => {
  const sel = getSelection();
  if (!sel.rangeCount) return;
  const r = sel.getRangeAt(0);
  if (r.collapsed || !root.contains(r.commonAncestorContainer)) return;
  const accOf = (n) => (n.nodeType === 3 ? n.parentElement : n)?.closest?.("[data-acc]");
  const acc = accOf(r.startContainer);
  const pick = (node) => {
    sel.removeAllRanges();
    const nr = document.createRange();
    nr.selectNodeContents(node);
    sel.addRange(nr);
  };
  if (acc && acc === accOf(r.endContainer)) {
    // Out of the accent: the accent splits around them.
    const tail = document.createRange();
    tail.setStart(r.endContainer, r.endOffset);
    tail.setEnd(acc, acc.childNodes.length);
    const after = tail.extractContents();
    const plain = document.createElement("span");
    plain.append(plainWords(r.extractContents()));
    acc.after(plain);
    if (after.textContent) {
      const rest = acc.cloneNode(false);
      rest.append(after);
      plain.after(rest);
    }
    if (!acc.textContent) acc.remove();
    return pick(plain);
  }
  const span = document.createElement("span");
  span.setAttribute("data-acc", "");
  span.style.cssText = accentCss;
  span.append(plainWords(r.extractContents()));
  r.insertNode(span);
  pick(span);
};

/**
 * Chosen words as plain text that keeps its line breaks (a <br> each, as a new line typed in the
 * middle comes as a block of its own), without the accents inside: textContent would join the lines.
 */
function plainWords(fragment) {
  const out = document.createDocumentFragment();
  const walk = (n) =>
    n.childNodes.forEach((c) => {
      if (c.nodeType === 3) return out.append(c.data);
      if (c.nodeName === "BR") return out.append(document.createElement("br"));
      if ((c.nodeName === "DIV" || c.nodeName === "P") && out.childNodes.length && out.lastChild.nodeName !== "BR") out.append(document.createElement("br"));
      walk(c);
    });
  walk(fragment);
  return out;
}


/** How accent words look while being typed in a panel (the design's own colour shows on the canvas). */
const ACCENT_MARK = "color: var(--lime); font-weight: 650";

/**
 * Words that can carry **accent** words, shown as they look: accent words marked, no stars to see.
 * Choose words and press the button (or ⌘B) to make them accent words, or plain again.
 */
export function AccentText({ value, onChange, placeholder, rows = 2, onFocus }) {
  const ref = useRef();
  const last = useRef(null);
  // Only words changed from outside (undo, Ask AI) redraw the field; typing never moves the caret.
  useEffect(() => {
    const el = ref.current;
    if (!el || value === last.current) return;
    last.current = value ?? "";
    el.innerHTML = accentEditHtml(value ?? "", ACCENT_MARK);
  }, [value]);
  const emit = () => {
    const v = accentFromEdit(ref.current);
    last.current = v;
    onChange(v);
  };
  const toggle = (e) => {
    e.preventDefault(); // keep the text selection
    const el = ref.current;
    if (!el) return;
    const sel = getSelection();
    // Nothing chosen: the word under the caret.
    if (sel.rangeCount && sel.getRangeAt(0).collapsed && sel.modify) {
      sel.modify("move", "backward", "word");
      sel.modify("extend", "forward", "word");
    }
    toggleAccentIn(el, ACCENT_MARK);
    emit();
  };
  return html`<div class="accent-field">
    <div ref=${ref} class="textarea rich" contenteditable="true" role="textbox" aria-multiline="true" data-placeholder=${placeholder ?? ""} style=${{ minHeight: rows * 1.45 + 1.1 + "em" }} onFocus=${onFocus}
      title="↩ to finish · ⇧↩ for a new line · ⌘B accents the chosen words"
      onInput=${emit}
      onPaste=${(e) => (e.preventDefault(), document.execCommand("insertText", false, e.clipboardData.getData("text/plain")))}
      onKeyDown=${(e) => {
        e.stopPropagation();
        if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "b") return toggle(e);
        // Enter finishes, like the canvas's own text editing; Shift+Enter breaks the line. Not
        // while an input method is composing (Safari gives its confirming Enter keyCode 229).
        if (e.key === "Enter" && !e.shiftKey && !e.altKey && !e.isComposing && e.keyCode !== 229) {
          e.preventDefault();
          e.target.blur();
        }
      }}
      onBlur=${() => {
        const v = accentFromEdit(ref.current).replace(/\s+$/, "");
        if (v !== (value ?? "")) onChange(v);
      }}></div>
    <button class="accent-btn" onMouseDown=${toggle} title="In the accent colour; again makes them plain (⌘B)">
      <${Icon} n="palette" s=${12} />Accent the chosen words
    </button>
  </div>`;
}
