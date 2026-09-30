// The layout canvas: shows where things go (no effects), lets you drag, resize, rotate and retype.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import { html } from "./controls.js";
import { Icon } from "./icons.js";
import { S, api, clamp, edit, entityLabel, fileUrl, r4, set, setScene, thumbUrl, touch, useStore } from "./store.js";
import { addDevice, deleteEntity, duplicateEntity, moveZ, openAI, recordingFor, replaceMode } from "./actions.js";

export const canvasApi = { fit: () => {}, zoomBy: () => {}, zoomTo: () => {}, editText: () => {} };

const PAD = 72;
const TOP = 96;
const BOTTOM = 104;

// ---------------------------------------------------------------------------------------------
// Background shown behind the layout: a cached still of the real background, with a colour guess
// underneath while it loads.

function bgGuess(bg, looks) {
  if (!bg) return "#1d1d22";
  if (typeof bg === "string") {
    const l = looks?.find((x) => x.name === bg);
    if (l) return l.colors.length > 1 ? `linear-gradient(160deg, ${l.colors.join(", ")})` : l.color;
    return bg;
  }
  if (bg.type === "transparent") return "var(--check)";
  if (bg.look) return bgGuess(bg.look, looks);
  if (bg.colors?.length) return bg.colors.length > 1 ? `linear-gradient(${bg.angle ?? 160}deg, ${bg.colors.join(", ")})` : bg.colors[0];
  if (bg.color) return bg.color;
  return "linear-gradient(160deg, #3a3f47, #1f2227)";
}
function needsStill(bg, looks) {
  if (!bg) return false;
  if (typeof bg === "string") return Boolean(looks?.some((l) => l.name === bg));
  if (bg.type === "transparent" || bg.generate) return false;
  return true;
}

function Backdrop({ bg, W, H }) {
  const looks = S.opts?.looks;
  const guess = bgGuess(bg, looks);
  const key = JSON.stringify(bg ?? null);
  const [ready, setReady] = useState(null);
  const still = needsStill(bg, looks) ? `/api/bg-preview?bg=${encodeURIComponent(key)}&w=${Math.round(Math.min(720, W / 3))}&h=${Math.round((Math.min(720, W / 3) * H) / W)}` : null;
  return html`<div class="bg" style=${{ background: guess }}>
    ${still && html`<img key=${still} src=${still} style=${{ opacity: ready === still ? 1 : 0, transition: "opacity .35s" }} onLoad=${() => setReady(still)} onError=${() => setReady(null)} />`}
  </div>`;
}

// ---------------------------------------------------------------------------------------------

/** **accent** spans like the renderer: the accent colour (or gradient), or just bold without one. */
const rich = (text, accent) =>
  String(text ?? "")
    .replace(/(\\n|\n|\s)+$/, "")
    .split(/\*\*(.+?)\*\*/g)
    .map((part, i) => {
      if (i % 2 === 0) return part.split(/\\n|\n/).map((line, j) => (j ? [html`<br />`, line] : line));
      if (!accent) return html`<strong>${part}</strong>`;
      return /gradient\(/.test(accent)
        ? html`<span style=${{ backgroundImage: accent, WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent" }}>${part}</span>`
        : html`<span style=${{ color: accent }}>${part}</span>`;
    });

function place(e, W, H) {
  if (e.kind === "device") {
    return {
      left: e.x * W + "px",
      top: e.y * H + "px",
      width: e.width * W + "px",
      height: e.height * H + "px",
      transform: `translate(-50%, -50%) rotate(${e.rotate || 0}deg)`,
      zIndex: e.z,
    };
  }
  const tx = e.align === "left" ? "0" : e.align === "right" ? "-100%" : "-50%";
  const ty = e.anchor === "middle" ? "-50%" : e.anchor === "bottom" ? "-100%" : "0";
  return {
    left: e.x * W + "px",
    top: e.y * H + "px",
    width: e.kind === "caption" ? e.width * W + "px" : "max-content",
    maxWidth: e.width * W + "px",
    transform: `translate(${tx}, ${ty}) rotate(${e.rotate || 0}deg)`,
    transformOrigin: `${e.align === "left" ? "0" : e.align === "right" ? "100%" : "50%"} ${e.anchor === "middle" ? "50%" : e.anchor === "bottom" ? "100%" : "0"}`,
    zIndex: e.z,
  };
}

function DeviceEnt({ e, W, H }) {
  const s = e.screen ?? { x: 0, y: 0, width: 1, height: 1, radius: 0.1 };
  const bw = e.width * W;
  const frame = e.frame ?? "device";
  const dev = S.scene.devices?.[e.index] ?? {};
  const bar = dev.chrome === "dark" ? "#2a2a2f" : "#e9e9ec";
  const body = frame === "device" ? e.color || "#1d1d1f" : frame === "browser" || frame === "window" ? bar : "transparent";
  const screen = { left: s.x * 100 + "%", top: s.y * 100 + "%", width: s.width * 100 + "%", height: s.height * 100 + "%", borderRadius: Math.max(0, (s.radius - s.x) * bw) + "px" };
  // Laptops show the capture below a black menu-bar strip, like the render.
  if (e.menuBar) {
    const bar = s.height * e.menuBar;
    Object.assign(screen, { top: (s.y + bar) * 100 + "%", height: (s.height - bar) * 100 + "%", objectPosition: "top", borderRadius: 0 });
  }
  const tags = [dev.video && "▶ Recording", (Math.abs(e.rotateX || 0) > 0.5 || Math.abs(e.rotateY || 0) > 0.5) && "3D tilt applied on render"].filter(Boolean);
  return html`<div class="body" style=${{ background: body, borderRadius: s.radius * bw + "px" }}>
    <img draggable=${false} src=${thumbUrl(e.screenshot, Math.min(900, Math.max(240, Math.round(bw * s.width * 2))))} style=${screen} />
    ${dev.video && html`<video key=${dev.video} src=${fileUrl(dev.video)} muted loop autoplay playsinline preload="auto" style=${{ ...screen, objectFit: "cover" }}></video>`}
  </div>
  ${tags.length > 0 && html`<span class="tag">${tags.join(" · ")}</span>`}`;
}

function TextEnt({ e, H, editing, onDone }) {
  const scene = S.scene;
  const t = e.kind === "text" ? scene.texts?.[e.index] ?? {} : {};
  const style = scene.textStyle ?? {};
  // Extra text uses its own star colour, else the headline's.
  const accent = (e.kind === "text" ? t.accentColor : undefined) ?? style.accentColor;
  const base = {
    color: e.color || "#fff",
    fontFamily: e.font || "-apple-system, system-ui, sans-serif",
    fontWeight: e.weight || 700,
    textAlign: e.align || "center",
    fontSize: e.size * H + "px",
    textTransform: (e.kind === "text" ? t.uppercase : style.uppercase) ? "uppercase" : undefined,
    letterSpacing: (e.kind === "text" ? t.letterSpacing : style.letterSpacing) !== undefined ? `${e.kind === "text" ? t.letterSpacing : style.letterSpacing}em` : undefined,
    opacity: t.opacity,
  };
  const ref = useRef();
  useEffect(() => {
    if (!editing || !ref.current) return;
    const el = ref.current.querySelector(`[data-part="${editing}"]`) ?? ref.current.querySelector("[contenteditable]");
    if (!el) return;
    el.focus();
    const r = document.createRange();
    r.selectNodeContents(el);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(r);
  }, [editing]);
  const finish = (ev, part) => {
    const text = ev.target.innerText.replace(/\n+$/, "");
    onDone(part, text);
  };
  const keys = (ev, part) => {
    ev.stopPropagation();
    if (ev.key === "Escape") {
      ev.preventDefault();
      onDone(null);
    } else if (ev.key === "Enter" && !ev.shiftKey) {
      ev.preventDefault();
      ev.target.blur();
    }
  };
  const editable = (part, text, cls) =>
    editing
      ? html`<div class="editing ${cls}" data-part=${part} contenteditable="plaintext-only" onBlur=${(ev) => finish(ev, part)} onKeyDown=${(ev) => keys(ev, part)}>${text}</div>`
      : html`<div class=${cls} data-part=${part}>${rich(text, accent)}</div>`;
  if (e.kind === "caption") {
    return html`<div ref=${ref} style=${base}>
      ${(e.text || editing) && editable("headline", e.text ?? "", "h")}
      ${(e.subtext || editing === "subheadline") && html`<div class="s" style=${{ fontSize: (e.subSize || e.size * 0.46) * H + "px" }}>${editing ? editable("subheadline", e.subtext ?? "", "") : rich(e.subtext, accent)}</div>`}
    </div>`;
  }
  const pill = t.background ? { display: "inline-block", background: t.background, padding: ".35em .8em", borderRadius: "2em" } : null;
  return html`<div ref=${ref} style=${base}><span style=${pill}>${editable("text", e.text ?? "", "")}</span></div>`;
}

// ---------------------------------------------------------------------------------------------

export function CanvasView() {
  const s = useStore();
  const layout = s.layout;
  const vp = useRef();
  const art = useRef();
  const [size, setSize] = useState({ w: 800, h: 600 });
  const [view, setView] = useState({ zoom: null, x: 0, y: 0 }); // zoom null = fit
  const [live, setLive] = useState(null); // entity being dragged: {id, e}
  const [guides, setGuides] = useState([]);
  const [editing, setEditing] = useState(null); // {id, part}
  const [space, setSpace] = useState(false);
  const [dropOver, setDropOver] = useState(false);
  const pending = useRef(null);

  useLayoutEffect(() => {
    const ro = new ResizeObserver(() => setSize({ w: vp.current.clientWidth, h: vp.current.clientHeight }));
    ro.observe(vp.current);
    return () => ro.disconnect();
  }, []);

  // The new layout from the engine has arrived: drop the local copy we showed meanwhile.
  useEffect(() => {
    if (pending.current && !live) pending.current = null;
  }, [layout]);

  const W0 = layout?.canvas.width ?? 1320;
  const H0 = layout?.canvas.height ?? 2868;
  const fitS = Math.max(0.02, Math.min((size.w - PAD * 2) / W0, (size.h - TOP - BOTTOM) / H0));
  const scale = view.zoom ?? fitS;
  const W = W0 * scale;
  const H = H0 * scale;
  const ox = view.zoom === null ? (size.w - W) / 2 : view.x;
  const oy = view.zoom === null ? TOP + (size.h - TOP - BOTTOM - H) / 2 : view.y;

  const zoomAt = (next, cx = size.w / 2, cy = size.h / 2) => {
    next = clamp(next, 0.02, 4);
    const fx = (cx - ox) / W;
    const fy = (cy - oy) / H;
    setView({ zoom: next, x: cx - fx * W0 * next, y: cy - fy * H0 * next });
  };
  canvasApi.fit = () => setView({ zoom: null, x: 0, y: 0 });
  canvasApi.zoomBy = (f) => zoomAt(scale * f);
  canvasApi.zoomTo = (z) => zoomAt(z);
  canvasApi.editText = (id, part) => setEditing({ id, part: part ?? (id === "caption" ? "headline" : "text") });
  canvasApi.scale = scale;

  // Trackpad: two-finger scroll pans, pinch (ctrl+wheel / Safari gesture) zooms.
  useEffect(() => {
    const el = vp.current;
    const wheel = (ev) => {
      if (!layout) return;
      ev.preventDefault();
      const r = el.getBoundingClientRect();
      if (ev.ctrlKey || ev.metaKey) {
        zoomAt(scale * Math.exp(-ev.deltaY * 0.012), ev.clientX - r.left, ev.clientY - r.top);
      } else {
        setView({ zoom: scale, x: ox - ev.deltaX, y: oy - ev.deltaY });
      }
    };
    let g0 = 1;
    const gs = (ev) => {
      ev.preventDefault();
      g0 = scale;
    };
    const gc = (ev) => {
      ev.preventDefault();
      const r = el.getBoundingClientRect();
      zoomAt(g0 * ev.scale, ev.clientX - r.left, ev.clientY - r.top);
    };
    el.addEventListener("wheel", wheel, { passive: false });
    el.addEventListener("gesturestart", gs);
    el.addEventListener("gesturechange", gc);
    return () => {
      el.removeEventListener("wheel", wheel);
      el.removeEventListener("gesturestart", gs);
      el.removeEventListener("gesturechange", gc);
    };
  });

  // Space to pan.
  useEffect(() => {
    const down = (e) => {
      if (e.code === "Space" && !e.repeat && !/INPUT|TEXTAREA/.test(document.activeElement?.tagName) && !document.activeElement?.isContentEditable) {
        e.preventDefault();
        setSpace(true);
      }
    };
    const up = (e) => e.code === "Space" && setSpace(false);
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  }, []);

  const entities = useMemo(() => {
    if (!layout) return [];
    return layout.entities.map((e) => (live && live.e.id === e.id ? live.e : pending.current?.id === e.id ? pending.current : e));
  }, [layout, live]);

  // ------------------------------------------------------------------ interactions

  const boxOf = (id) => {
    const el = art.current?.querySelector(`.ent[data-id="${id}"]`);
    if (!el) return null;
    const a = art.current.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    return { l: (r.left - a.left) / W, r: (r.right - a.left) / W, t: (r.top - a.top) / H, b: (r.bottom - a.top) / H };
  };

  const startPan = (ev) => {
    ev.preventDefault();
    const sx = ev.clientX;
    const sy = ev.clientY;
    const x0 = ox;
    const y0 = oy;
    const z = scale;
    vp.current.classList.add("panning");
    const move = (e) => setView({ zoom: z, x: x0 + e.clientX - sx, y: y0 + e.clientY - sy });
    const up = () => {
      vp.current?.classList.remove("panning");
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const onPointerDown = (ev) => {
    if (ev.button === 1 || space) return startPan(ev);
    if (ev.button !== 0) return;
    const entEl = ev.target.closest(".ent");
    const handle = ev.target.closest("[data-handle]")?.dataset.handle;
    if (ev.target.closest(".editing")) return;
    if (!entEl && !handle) {
      if (editing) return;
      set({ selected: null });
      return startPan(ev);
    }
    const id = handle ? S.selected : entEl.dataset.id;
    const e0 = entities.find((x) => x.id === id);
    if (!e0) return;
    ev.preventDefault();
    if (S.selected !== id) set({ selected: id });
    if (editing && editing.id !== id) setEditing(null);
    const el = art.current.querySelector(`.ent[data-id="${id}"]`);
    const r = el.getBoundingClientRect();
    const a = art.current.getBoundingClientRect();
    const center = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    const box0 = boxOf(id);
    const targets = { xs: [0, 0.5, 1], ys: [0, 0.5, 1] };
    for (const other of entities) {
      if (other.id === id) continue;
      const b = boxOf(other.id);
      if (!b) continue;
      targets.xs.push(b.l, (b.l + b.r) / 2, b.r);
      targets.ys.push(b.t, (b.t + b.b) / 2, b.b);
    }
    const mode = handle === "rot" ? "rotate" : handle ? "resize" : "move";
    const start = { x: ev.clientX, y: ev.clientY };
    let moved = false;
    let cur = { ...e0 };
    const tolX = 6 / W;
    const tolY = 6 / H;
    const snap1 = (vals, list, tol) => {
      let best = null;
      for (const v of vals) for (const t of list) if (Math.abs(t - v) < tol && (!best || Math.abs(t - v) < Math.abs(best.d))) best = { d: t - v, at: t };
      return best;
    };
    const move = (e) => {
      const dx = e.clientX - start.x;
      const dy = e.clientY - start.y;
      if (!moved && Math.hypot(dx, dy) < 3) return;
      moved = true;
      cur = { ...e0 };
      const g = [];
      if (mode === "move") {
        let fx = dx / W;
        let fy = dy / H;
        if (!e.altKey && box0) {
          const sx = snap1([box0.l + fx, (box0.l + box0.r) / 2 + fx, box0.r + fx], targets.xs, tolX);
          const sy = snap1([box0.t + fy, (box0.t + box0.b) / 2 + fy, box0.b + fy], targets.ys, tolY);
          if (sx) {
            fx += sx.d;
            g.push({ v: sx.at });
          }
          if (sy) {
            fy += sy.d;
            g.push({ h: sy.at });
          }
        }
        if (e.shiftKey) Math.abs(dx) > Math.abs(dy) ? (fy = 0) : (fx = 0);
        cur.x = e0.x + fx;
        cur.y = e0.y + fy;
      } else if (mode === "resize") {
        const d0 = Math.hypot(start.x - center.x, start.y - center.y) || 1;
        const d1 = Math.hypot(e.clientX - center.x, e.clientY - center.y);
        const f = clamp(d1 / d0, 0.05, 12);
        if (cur.kind === "device") {
          cur.width = e0.width * f;
          cur.height = e0.height * f;
        } else {
          cur.size = Math.max(0.004, e0.size * f);
          if (e0.subSize) cur.subSize = Math.max(0.003, e0.subSize * f);
        }
      } else {
        let ang = (Math.atan2(e.clientY - center.y, e.clientX - center.x) * 180) / Math.PI + 90;
        if (ang > 180) ang -= 360;
        ang = e.shiftKey ? Math.round(ang / 15) * 15 : Math.abs(ang) < 2.5 ? 0 : Math.round(ang * 2) / 2;
        cur.rotate = ang;
      }
      setGuides(g);
      setLive({ e: cur, mode });
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setGuides([]);
      if (moved) {
        pending.current = cur;
        commit(cur);
      }
      setLive(null);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const onDblClick = (ev) => {
    const entEl = ev.target.closest(".ent");
    if (!entEl) return canvasApi.fit();
    const id = entEl.dataset.id;
    if (id === "caption" || id.startsWith("text-")) {
      const part = ev.target.closest("[data-part]")?.dataset.part ?? (id === "caption" ? "headline" : "text");
      setEditing({ id, part });
    } else if (id.startsWith("device-")) {
      replaceMode(id);
    }
  };

  const finishEdit = (part, text) => {
    const id = editing?.id;
    setEditing(null);
    if (!part || !id) return;
    if (id === "caption") edit((d) => (d[part] = text.trim() || undefined));
    else {
      const i = Number(id.split("-")[1]) - 1;
      if (!text.trim()) edit((d) => d.texts.splice(i, 1));
      else edit((d) => (d.texts[i].text = text));
    }
  };

  // ------------------------------------------------------------------ drop captures from the library

  const onDragOver = (ev) => {
    if (!ev.dataTransfer.types.includes("application/x-screenshot")) return;
    ev.preventDefault();
    ev.dataTransfer.dropEffect = "copy";
    setDropOver(true);
  };
  const onDrop = (ev) => {
    const p = ev.dataTransfer.getData("application/x-screenshot");
    setDropOver(false);
    if (!p) return;
    ev.preventDefault();
    ev.stopPropagation();
    const a = art.current?.getBoundingClientRect();
    const target = ev.target.closest?.(".ent-device")?.dataset.id;
    if (target) {
      const i = Number(target.split("-")[1]) - 1;
      const rec = recordingFor(p);
      edit((d) => {
        d.devices[i].screenshot = p;
        if (rec) d.devices[i].video = rec;
        else delete d.devices[i].video;
      });
      set({ selected: target });
      return;
    }
    if (a && S.scene.devices.length) addDevice(p, { x: r4((ev.clientX - a.left) / a.width), y: r4((ev.clientY - a.top) / a.height) });
    else addDevice(p);
  };

  // ------------------------------------------------------------------ render

  const sel = entities.find((e) => e.id === s.selected);
  const selEl = sel && art.current?.querySelector(`.ent[data-id="${sel.id}"]`);
  const selBox = sel ? selectionBox(sel, W, H, selEl) : null;
  const hov = s.hover && s.hover !== s.selected ? entities.find((e) => e.id === s.hover) : null;
  const hovEl = hov && art.current?.querySelector(`.ent[data-id="${hov.id}"]`);
  const hovBox = hov ? selectionBox(hov, W, H, hovEl) : null;
  const dims = live && sel ? dimsText(live.e, live.mode, W0, H0) : null;

  // Text boxes are measured from the DOM, so paint once more after they render.
  const [, remeasure] = useState(0);
  useLayoutEffect(() => remeasure((n) => n + 1), [s.selected, layout, W, H, s.hover]);

  return html`<div class="viewport ${space ? "space" : ""}" ref=${vp} onPointerDown=${onPointerDown} onDblClick=${onDblClick}
      onPointerMove=${(e) => {
        const id = e.target.closest?.(".ent")?.dataset.id ?? null;
        if (id !== S.hover) set({ hover: id });
      }}
      onPointerLeave=${() => S.hover && set({ hover: null })}
      onDragOver=${onDragOver} onDragLeave=${() => setDropOver(false)} onDrop=${onDrop}>
    <div class="dots" style=${{ "--dot": 22 * Math.max(0.5, Math.min(2, scale / fitS)) + "px", "--dot-x": ox + "px", "--dot-y": oy + "px" }}></div>
    ${layout &&
    html`<div class="world" style=${{ transform: `translate(${ox}px, ${oy}px)` }}>
      <div class="artboard-label" style=${{ top: H + 12 + "px" }}><b>${canvasName(layout.canvas.name)}</b><span>${layout.canvas.width} × ${layout.canvas.height}</span><span class="faint">· Edit view shows placement. Preview shows the finished look.</span></div>
      <div class="artboard ${dropOver ? "drop-over" : ""}" ref=${art} style=${{ width: W + "px", height: H + "px" }}>
        <${Backdrop} bg=${s.scene.background} W=${W0} H=${H0} />
        ${entities.map(
          (e) => html`<div key=${e.id} class="ent ent-${e.kind} ${s.pulse.includes(e.id) ? "pulse" : ""}" data-id=${e.id} style=${place(e, W, H)}>
            ${e.kind === "device"
              ? html`<${DeviceEnt} e=${e} W=${W} H=${H} />`
              : html`<${TextEnt} e=${e} H=${H} editing=${editing?.id === e.id ? editing.part : null} onDone=${finishEdit} />`}
          </div>`,
        )}
        <div class="clip"></div>
        ${guides.map((g) => (g.v !== undefined ? html`<div class="guide v" style=${{ left: g.v * W + "px", top: -4000 + "px", height: 8000 + "px" }}></div>` : html`<div class="guide h" style=${{ top: g.h * H + "px", left: -4000 + "px", width: 8000 + "px" }}></div>`))}
        ${hovBox && !live && html`<div class="hover-box" style=${hovBox}></div>`}
        ${selBox &&
        !editing &&
        html`<div class="sel-box" style=${selBox}>
          ${["nw", "ne", "sw", "se"].map((c) => html`<div class="h ${c}" data-handle=${c}></div>`)}
          ${sel.kind !== "caption" && html`<div class="rot" data-handle="rot"><${Icon} n="rotate" s=${12} w=${2} /></div>`}
          ${dims && html`<div class="dims" style=${{ transform: `translate(-50%, 10px) rotate(${-(sel.rotate || 0)}deg)` }}>${dims}</div>`}
        </div>`}
      </div>
    </div>`}
    ${sel && selBox && !live && !editing && !s.ai.open && html`<${ContextBar} sel=${sel} box=${selEl} vp=${vp.current} />`}
    ${layout &&
    html`<div class="float zoom-ctl" onPointerDown=${(e) => e.stopPropagation()}>
      <button class="icon-btn sm" title="Zoom out (⌘−)" onClick=${() => canvasApi.zoomBy(1 / 1.25)}><${Icon} n="minus" s=${14} /></button>
      <button class="pct" title="Fit (⌘0)" onClick=${() => canvasApi.fit()}>${Math.round(scale * 100)}%</button>
      <button class="icon-btn sm" title="Zoom in (⌘+)" onClick=${() => canvasApi.zoomBy(1.25)}><${Icon} n="plus" s=${14} /></button>
      <button class="icon-btn sm ${view.zoom === null ? "on" : ""}" title="Zoom to fit (⌘0)" onClick=${() => canvasApi.fit()}><${Icon} n="fit" s=${14} /></button>
    </div>`}
  </div>`;
}

function canvasName(name) {
  const presets = S.opts?.canvases ?? {};
  if (presets[name]?.label) return presets[name].label;
  if (/^\d+x\d+$/i.test(name)) return "Custom size";
  return { "iphone-6.9": "iPhone 6.9″ App Store", "iphone-6.5": "iPhone 6.5″ App Store", "ipad-13": "iPad 13″ App Store", "ipad-12.9": "iPad 12.9″ App Store" }[name] ?? name;
}

function selectionBox(e, W, H, el) {
  if (e.kind === "device") {
    return {
      left: e.x * W - (e.width * W) / 2 + "px",
      top: e.y * H - (e.height * H) / 2 + "px",
      width: e.width * W + "px",
      height: e.height * H + "px",
      transform: `rotate(${e.rotate || 0}deg)`,
    };
  }
  if (!el) return null;
  const w = el.offsetWidth;
  const hh = el.offsetHeight;
  const left = e.x * W - (e.align === "left" ? 0 : e.align === "right" ? w : w / 2);
  const top = e.y * H - (e.anchor === "middle" ? hh / 2 : e.anchor === "bottom" ? hh : 0);
  return {
    left: left + "px",
    top: top + "px",
    width: w + "px",
    height: hh + "px",
    transform: `rotate(${e.rotate || 0}deg)`,
    transformOrigin: `${e.align === "left" ? "0" : e.align === "right" ? "100%" : "50%"} ${e.anchor === "middle" ? "50%" : e.anchor === "bottom" ? "100%" : "0"}`,
  };
}

function dimsText(e, mode, W0, H0) {
  if (mode === "rotate") return `${Math.round((e.rotate || 0) * 10) / 10}°`;
  if (mode === "resize") return e.kind === "device" ? `H ${Math.round(e.height * 1000) / 10}%  ·  ${Math.round(e.width * W0)}×${Math.round(e.height * H0)}` : `${Math.round(e.size * H0)} px`;
  return `X ${Math.round(e.x * 1000) / 10}%  Y ${Math.round(e.y * 1000) / 10}%`;
}

/** Write an entity's canvas position back into the scene. */
function commit(e) {
  touch("moved");
  edit((d) => {
    if (e.kind === "device") {
      const dev = d.devices[e.index];
      if (!dev) return;
      Object.assign(dev, { x: r4(e.x), y: r4(e.y), anchor: "center", height: r4(clamp(e.height, 0.01, 5)), rotate: Math.round((e.rotate || 0) * 2) / 2 });
      delete dev.width;
      if (!dev.rotate) delete dev.rotate;
    } else if (e.kind === "caption") {
      d.textStyle = { ...(d.textStyle ?? {}), x: r4(e.x), y: r4(e.y), anchor: e.anchor ?? "top", align: e.align ?? "center", headlineSize: r4(e.size) };
      if (e.subSize) d.textStyle.subheadlineSize = r4(e.subSize);
      delete d.textStyle.position;
    } else {
      const t = d.texts?.[e.index];
      if (!t) return;
      Object.assign(t, { x: r4(e.x), y: r4(e.y), size: r4(e.size), rotate: Math.round((e.rotate || 0) * 2) / 2 });
      if (!t.rotate) delete t.rotate;
      t.anchor ??= e.anchor;
      t.align ??= e.align;
    }
  }, null);
}

// ---------------------------------------------------------------------------------------------
// Floating actions above the selection

function ContextBar({ sel, box, vp }) {
  if (!box || !vp) return null;
  // Sit above the selection (clear of the rotate handle), else below it, else at the top of the
  // canvas; prefer a spot that doesn't cover another item, like the headline.
  const r = box.getBoundingClientRect();
  const v = vp.getBoundingClientRect();
  const left = clamp(r.left + r.width / 2 - v.left, 170, v.width - 170);
  const half = sel.kind === "device" ? 150 : 125;
  // Also keep clear of the "3D tilt" tag and the artboard's own label.
  const others = [...vp.querySelectorAll(".ent, .ent-device .tag, .artboard-label")].filter((el) => el.dataset.id !== sel.id).map((el) => el.getBoundingClientRect());
  const fits = (bottom) => bottom - 40 >= 8 && bottom <= v.height - 70;
  const clear = (bottom) =>
    !others.some((o) => o.left - v.left < left + half && o.right - v.left > left - half && o.top - v.top < bottom && o.bottom - v.top > bottom - 40);
  const candidates = [r.top - v.top - (sel.kind === "caption" ? 12 : 50), r.bottom - v.top + 50, 50];
  const top = candidates.find((c) => fits(c) && clear(c)) ?? candidates.find(fits) ?? 50;
  const stop = (e) => e.stopPropagation();
  const text = sel.kind !== "device";
  return html`<div class="ctx-bar" style=${{ left: left + "px", top: top + "px" }} onPointerDown=${stop}>
    <button class="btn" onClick=${() => openAI(sel.id)}><${Icon} n="spark" s=${14} style=${{ color: "var(--pink)" }} /><span class="ai-mini">Ask AI</span></button>
    <span class="sep"></span>
    ${text
      ? html`<button class="icon-btn" title="Edit text (double-click)" onClick=${() => canvasApi.editText(sel.id)}><${Icon} n="text" s=${15} /></button>`
      : html`<button class="icon-btn" title="Replace screenshot" onClick=${() => replaceMode(sel.id)}><${Icon} n="replace" s=${15} /></button>`}
    ${sel.id !== "caption" && html`<button class="icon-btn" title="Duplicate (⌘D)" onClick=${() => duplicateEntity(sel.id)}><${Icon} n="duplicate" s=${15} /></button>`}
    ${sel.id !== "caption" && html`<button class="icon-btn" title="Bring forward" onClick=${() => moveZ(sel.id, 1)}><${Icon} n="front" s=${15} /></button>`}
    ${sel.id !== "caption" && html`<button class="icon-btn" title="Send backward" onClick=${() => moveZ(sel.id, -1)}><${Icon} n="back" s=${15} /></button>`}
    <button class="icon-btn" title="Delete (⌫)" onClick=${() => deleteEntity(sel.id)}><${Icon} n="trash" s=${15} /></button>
  </div>`;
}

export { commit as commitEntity, entityLabel };
