// The layout canvas: shows where things go (no effects), lets you drag, resize, rotate and retype.
import { createContext } from "preact";
import { useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import { ColorPicker, Dropdown, Popover, html } from "./controls.js";
import { Icon } from "./icons.js";
import { openMenu } from "./menu.js";
import { MotionPathOverlay, Viewfinder, afterEntity, applyPreview, blurAnimated, commitKeyframe, joinStyles, manyShots, offVideo, onPlayhead, onVideoTime, playhead, shotsAt, video, videoPlan } from "./timeline.js";
import { textPieces, unitMode } from "./animate.js";
import { S, activeScreens, allGroups, api, clamp, edit, entityLabel, fileUrl, persistPrefs, r4, set, setScene, thumbUrl, touch, useStore } from "./store.js";
import { addDevice, addShot, addSize, closeStills, openCopyStyle, setInVideo, deleteEntity, deleteShot, duplicateEntity, goToShot, goToSize, moveShot, moveZ, openAI, openStills, recordingFor, removeSize, replaceMode, screenName, sizeLabel, togglePanel, updateShot } from "./actions.js";
import { sizeOptions } from "./inspector.js";
import { bendThrough, curveMid, isLine, renderShape } from "./shapes.js";

export const canvasApi = { fit: () => {}, zoomBy: () => {}, zoomTo: () => {}, editText: () => {} };

/**
 * A shape entity with its shape changed by `fn`, and its box worked out again (canvas fractions).
 * W0 and H0 are the canvas size in pixels.
 */
export function withShape(e, fn, W0, H0) {
  const sh = JSON.parse(JSON.stringify(e.shape));
  fn(sh);
  if (isLine(sh.type)) {
    return { ...e, shape: sh, x: (sh.from.x + sh.to.x) / 2, y: (sh.from.y + sh.to.y) / 2, width: Math.abs(sh.to.x - sh.from.x), height: Math.abs(sh.to.y - sh.from.y), rotate: 0 };
  }
  return { ...e, shape: sh, x: sh.x, y: sh.y, width: (sh.size * H0 * sh.aspect) / W0, height: sh.size, rotate: sh.rotate };
}

function ShapeEnt({ e, W, H }) {
  const r = renderShape(e.shape, W, H, { hit: 14 });
  return html`<div class="shape-svg" dangerouslySetInnerHTML=${{ __html: r.svg }}></div>`;
}

function placeShape(e, W, H) {
  const r = renderShape(e.shape, W, H, { hit: 14 });
  return {
    left: r.left + "px",
    top: r.top + "px",
    width: r.width + "px",
    height: r.height + "px",
    transform: r.rotate ? `rotate(${r.rotate}deg)` : undefined,
    filter: r.filter,
    zIndex: e.z,
  };
}

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
  // AI backdrops too: the engine serves one once it's made, and never starts one for the canvas.
  return bg.type !== "transparent";
}

/** A scene's macOS menu bar, sketched on the canvas (the render draws the real one). */
function SceneMenuBar({ bar, H }) {
  const h = (bar.size ?? 0.034) * H;
  const dark = bar.style === "dark";
  return html`<div style=${{ position: "absolute", left: 0, right: 0, top: 0, height: h + "px", zIndex: 40, pointerEvents: "none", background: dark ? "rgba(22,22,26,.62)" : "rgba(246,246,249,.74)", display: "flex", alignItems: "center", justifyContent: "flex-end", gap: h * 0.6 + "px", padding: `0 ${h * 0.6}px`, font: `500 ${h * 0.5}px -apple-system, system-ui, sans-serif`, color: dark ? "#fff" : "#1d1d1f" }}>
    ${bar.status && html`<span style=${{ background: dark ? "rgba(255,255,255,.2)" : "rgba(0,0,0,.1)", borderRadius: h * 0.3 + "px", padding: `${h * 0.1}px ${h * 0.35}px`, whiteSpace: "nowrap" }}>${bar.status}</span>`}
    <span style=${{ whiteSpace: "pre" }}>${bar.time ?? "Wed Sep 23  9:41 AM"}</span>
  </div>`;
}

function Backdrop({ bg, W, H }) {
  const looks = S.opts?.looks;
  const guess = bgGuess(bg, looks);
  const key = JSON.stringify(bg ?? null);
  const [ready, setReady] = useState(null);
  const still = needsStill(bg, looks) ? `/api/bg-preview?bg=${encodeURIComponent(key)}&w=${Math.round(Math.min(720, W / 3))}&h=${Math.round((Math.min(720, W / 3) * H) / W)}` : null;
  // The backdrop's own move (Animate) turns and scales the inner layer; the camera moves the outer.
  return html`<div class="bg"><div class="bg-move" style=${{ background: guess }}>
    ${still && html`<img key=${still} src=${still} style=${{ opacity: ready === still ? 1 : 0, transition: "opacity .35s" }} onLoad=${() => setReady(still)} onError=${() => setReady(null)} />`}
  </div></div>`;
}

// ---------------------------------------------------------------------------------------------

// Font names the renderer knows as shortcuts; anything else is a Google Fonts (or installed) family.
const FONT_SHORTCUTS = {
  "sf-pro": `-apple-system, "SF Pro Display", system-ui, sans-serif`,
  system: `-apple-system, "SF Pro Display", system-ui, sans-serif`,
  "sf-rounded": `ui-rounded, "SF Pro Rounded", -apple-system, system-ui, sans-serif`,
  "new-york": `ui-serif, "New York", Georgia, serif`,
  "sf-mono": `ui-monospace, "SF Mono", Menlo, monospace`,
};
const stackFor = (font) => (font ? (FONT_SHORTCUTS[font.toLowerCase()] ?? `"${font.replace(/"/g, "")}", -apple-system, system-ui, sans-serif`) : undefined);

/** Load the Google Fonts a scene uses, so the canvas shows the same type as the render. */
const loadedFonts = new Set();
function useSceneFonts(scene) {
  const families = [scene.textStyle?.font, scene.textStyle?.subheadlineFont, scene.textStyle?.accentFont, ...(scene.texts ?? []).flatMap((t) => [t.font, t.accentFont])].filter(
    (f) => f && !FONT_SHORTCUTS[f.toLowerCase()],
  );
  for (const f of families) {
    if (loadedFonts.has(f)) continue;
    loadedFonts.add(f);
    const name = encodeURIComponent(f).replace(/%20/g, "+");
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = `https://fonts.googleapis.com/css2?family=${name}:ital,wght@0,300;0,400;0,500;0,600;0,700;0,800;0,900;1,400;1,700&display=swap`;
    // Families without every style reject that request; fall back to whatever the family has.
    link.onerror = () => {
      const plain = document.createElement("link");
      plain.rel = "stylesheet";
      plain.href = `https://fonts.googleapis.com/css2?family=${name}&family=${name}:ital@1&display=swap`;
      document.head.append(plain);
    };
    document.head.append(link);
  }
}

const accentStyle = (accent) => ({
  ...(accent.color
    ? /gradient\(/.test(accent.color)
      ? { backgroundImage: accent.color, WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent" }
      : { color: accent.color }
    : {}),
  fontFamily: stackFor(accent.font),
  fontWeight: accent.weight,
  fontStyle: accent.italic ? "italic" : undefined,
});

/** Text cut into words or letters (.u), like the video renderer, so Animate can move each one. */
function richUnits(text, accent, by) {
  const plain = !accent.color && !accent.font && accent.weight === undefined && !accent.italic;
  const wrap = (nodes, on, seg) => (!on ? nodes : plain ? html`<strong>${nodes}</strong>` : html`<span class="accent" data-acc=${seg} style=${accentStyle(accent)}>${nodes}</span>`);
  const pieces = textPieces(text, by);
  const out = [];
  for (let i = 0; i < pieces.length; ) {
    const p = pieces[i];
    if (p.kind === "break") {
      out.push(html`<br />`);
      i++;
    } else if (p.kind === "space") {
      out.push(" ");
      i++;
    } else {
      // One word (.uw keeps it on one line): its pieces, accented runs wrapped in the accent.
      const word = [];
      while (i < pieces.length && pieces[i].kind === "unit" && pieces[i].w === p.w) {
        const accented = pieces[i].accent;
        const run = [];
        while (i < pieces.length && pieces[i].kind === "unit" && pieces[i].w === p.w && pieces[i].accent === accented) run.push(html`<span class="u">${pieces[i++].text}</span>`);
        word.push(wrap(run, accented, pieces[i - 1].seg));
      }
      out.push(html`<span class="uw">${word}</span>`);
    }
  }
  return out;
}

/** **accent** spans like the renderer: accent colour (or gradient), font, weight and italic; just bold without any. */
const rich = (text, accent = {}, by) =>
  by ? richUnits(text, accent, by) :
  String(text ?? "")
    .replace(/(\\n|\n|\s)+$/, "")
    .split(/\*\*(.+?)\*\*/g)
    .map((part, i) => {
      if (i % 2 === 0) return part.split(/\\n|\n/).map((line, j) => (j ? [html`<br />`, line] : line));
      if (!accent.color && !accent.font && accent.weight === undefined && !accent.italic) return html`<strong>${part}</strong>`;
      return html`<span style=${accentStyle(accent)}>${part}</span>`;
    });

/**
 * The shot a canvas item belongs to: the one being edited (the store's), or another shot of the
 * video drawn read-only behind it (for playing through the whole video).
 */
const ShotCtx = createContext(null);
const useShot = () => useContext(ShotCtx) ?? { scene: S.scene, layout: S.layout, ghost: false };

function place(e, W, H) {
  if (e.kind === "shape") return placeShape(e, W, H);
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
  const { scene, layout, ghost } = useShot();
  const dev = scene.devices?.[e.index] ?? {};
  const bar = dev.chrome === "dark" ? "#2a2a2f" : "#e9e9ec";
  const body = frame === "device" ? e.color || "#1d1d1f" : frame === "browser" || frame === "window" ? bar : "transparent";
  const screen = { left: s.x * 100 + "%", top: s.y * 100 + "%", width: s.width * 100 + "%", height: s.height * 100 + "%", borderRadius: Math.max(0, (s.radius - s.x) * bw) + "px" };
  // Laptops show the capture below the drawn menu bar, like the render.
  const menuStrip = e.menuBar
    ? { position: "absolute", left: s.x * 100 + "%", top: s.y * 100 + "%", width: s.width * 100 + "%", height: s.height * e.menuBar * 100 + "%", background: e.menuBarStyle === "dark" ? "#141417" : "#e9e8ee" }
    : null;
  if (e.menuBar) {
    const bar = s.height * e.menuBar;
    Object.assign(screen, { top: (s.y + bar) * 100 + "%", height: (s.height - bar) * 100 + "%", objectPosition: "top", borderRadius: 0 });
  }
  const tags = [dev.video && (S.stillPick?.id === e.id ? "Still" : "▶ Recording")].filter(Boolean);
  // Soft focus and fade, like the render: blur is a fraction of canvas width (or canvas px).
  const cw = layout?.canvas.width || W;
  const blur = dev.blur ? (dev.blur <= 0.5 ? dev.blur * W : (dev.blur * W) / cw) : 0;
  const fade = dev.fade ? (typeof dev.fade === "number" ? { edge: "bottom", extent: dev.fade } : { edge: "bottom", extent: 0.4, ...dev.fade }) : null;
  const mask = fade && `linear-gradient(to ${fade.edge}, #000 ${(1 - fade.extent) * 100}%, rgba(0,0,0,.55) ${(1 - fade.extent * 0.55) * 100}%, transparent 100%)`;
  // Tilted in 3D like the render: Apple's art is flat, so the same perspective (2.6× the device's
  // longer side, unless the design sets one) and turn show it as it will look. An animation that
  // tilts it adds to that (--arx, --ary), as it does in the render.
  const persp = dev.perspective ? (dev.perspective * W) / cw : Math.max(bw, e.height * H) * 2.6;
  const tilt = `perspective(${persp}px) rotateX(calc(${e.rotateX || 0}deg + var(--arx, 0deg))) rotateY(calc(${e.rotateY || 0}deg + var(--ary, 0deg)))`;
  // A drawn watch: band stubs above and below, the case between them.
  const band = e.band;
  const caseBox = band ? { position: "absolute", left: 0, right: 0, top: band.stub * 100 + "%", bottom: band.stub * 100 + "%", background: body, borderRadius: s.radius * bw + "px" } : null;
  const stub = (top) => ({ position: "absolute", left: (1 - band.width) * 50 + "%", width: band.width * 100 + "%", top: top ? 0 : undefined, bottom: top ? undefined : 0, height: band.stub * 100 + 6 + "%", background: band.color, borderRadius: top ? "8% 8% 0 0 / 20% 20% 0 0" : "0 0 8% 8% / 0 0 20% 20%" });
  // With an installed product bezel, the canvas shows the real art over the screen.
  // A blur the timeline animates comes from --ablur, set as the playhead moves.
  const soft = blurAnimated(e.id, scene) ? `blur(var(--ablur, ${blur}px))` : blur ? `blur(${blur}px)` : "";
  // Apple's art is a cut-out (a watch's band, a laptop's base): its shadow follows its shape, not its box.
  const shade = e.bezel && dev.shadow !== "none" ? `drop-shadow(0 ${Math.max(2, bw * 0.03)}px ${Math.max(4, bw * 0.06)}px rgba(0,0,0,.5))` : "";
  const filter = [shade, soft].filter(Boolean).join(" ") || undefined;
  return html`<div class="body" style=${{ background: e.bezel || band ? "transparent" : body, borderRadius: s.radius * bw + "px", filter, WebkitMaskImage: mask || undefined, maskImage: mask || undefined, transform: tilt, boxShadow: e.bezel || dev.shadow === "none" ? "none" : undefined }}>
    ${band && html`<div style=${stub(true)}></div><div style=${stub(false)}></div><div style=${caseBox}></div>`}
    ${menuStrip && html`<div style=${menuStrip}></div>`}
    <img draggable=${false} src=${thumbUrl(e.screenshot, Math.min(900, Math.max(240, Math.round(bw * s.width * 2))))} style=${screen} />
    ${dev.video && !ghost && S.stillPick?.id !== e.id && html`<video key=${dev.video} src=${fileUrl(dev.video)} muted loop autoplay playsinline preload="auto" style=${{ ...screen, objectFit: "cover" }}></video>`}
    ${e.bezel && html`<img class="bezel-art" draggable=${false} src=${fileUrl(e.bezel)} />`}
  </div>
  ${tags.length > 0 && html`<span class="tag">${tags.join(" · ")}</span>`}`;
}

/** A text's soft focus on the canvas, like the render; an animated one comes from --ablur. */
function textBlur(e, b, H, shot) {
  const c = shot.layout?.canvas ?? { width: 1, height: 1 };
  const w = (H * c.width) / c.height;
  const v = !b ? 0 : b <= 0.5 ? b * w : (b * w) / c.width;
  return blurAnimated(e.id, shot.scene) ? `blur(var(--ablur, ${v}px))` : v > 0 ? `blur(${v}px)` : undefined;
}

function TextEnt({ e, H, editing, onDone }) {
  const shot = useShot();
  const scene = shot.scene;
  const t = e.kind === "text" ? scene.texts?.[e.index] ?? {} : {};
  const style = scene.textStyle ?? {};
  useSceneFonts(scene);
  // Extra text uses its own accent settings, else the headline's.
  const own = e.kind === "text" ? t : {};
  const accent = {
    color: own.accentColor ?? style.accentColor,
    font: own.accentFont ?? style.accentFont,
    weight: own.accentWeight ?? style.accentWeight,
    italic: own.accentItalic ?? style.accentItalic,
  };
  const base = {
    color: `var(--acolor, ${e.color || "#fff"})`,
    fontFamily: e.font || "-apple-system, system-ui, sans-serif",
    fontWeight: e.weight || 700,
    textAlign: e.align || "center",
    fontSize: e.size * H + "px",
    textTransform: (e.kind === "text" ? t.uppercase : style.uppercase) ? "uppercase" : undefined,
    letterSpacing: (e.kind === "text" ? t.letterSpacing : style.letterSpacing) !== undefined ? `${e.kind === "text" ? t.letterSpacing : style.letterSpacing}em` : undefined,
    opacity: t.opacity,
    filter: textBlur(e, e.kind === "text" ? t.blur : style.blur, H, shot),
  };
  // In Animate, text revealed by word or letter is drawn in pieces.
  const by = S.timelineOpen && !editing ? unitMode(scene.animations, e.id) : undefined;
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
      : html`<div class=${cls} data-part=${part}>${rich(text, accent, by)}</div>`;
  if (e.kind === "caption") {
    return html`<div ref=${ref} style=${base}>
      ${(e.text || editing) && editable("headline", e.text ?? "", "h")}
      ${(e.subtext || editing === "subheadline") && html`<div class="s" style=${{ fontSize: (e.subSize || e.size * 0.46) * H + "px", fontFamily: e.subFont, fontWeight: style.subheadlineWeight }}>${editing ? editable("subheadline", e.subtext ?? "", "") : rich(e.subtext, accent, by)}</div>`}
    </div>`;
  }
  const pill = t.background ? { display: "inline-block", background: t.background, padding: ".35em .8em", borderRadius: "2em" } : null;
  return html`<div ref=${ref} style=${base}><span style=${pill}>${editable("text", e.text ?? "", "")}</span></div>`;
}

// ---------------------------------------------------------------------------------------------
// Other shots of a video, drawn read-only over the canvas while the video plays through them

// Each shot's layout from the engine, remembered by its scene (the newest few).
const shotLayouts = new Map();
function useShotLayouts(on) {
  const s = useStore();
  const [, bump] = useState(0);
  useEffect(() => {
    if (!on) return;
    let alive = true;
    (s.shots ?? []).forEach((x, i) => {
      if (i === s.shot || !x.scene?.devices?.length) return;
      const key = JSON.stringify(x.scene);
      if (shotLayouts.has(key)) return;
      shotLayouts.set(key, null);
      if (shotLayouts.size > 60) shotLayouts.delete(shotLayouts.keys().next().value);
      api("/api/layout", x.scene)
        .then((l) => {
          shotLayouts.set(key, l);
          if (alive) bump((n) => n + 1);
        })
        .catch(() => shotLayouts.delete(key));
    });
    return () => {
      alive = false;
    };
  }, [on, s.shots, s.shot]);
  return (scene) => shotLayouts.get(JSON.stringify(scene)) ?? null;
}

/** Another shot, as it looks (fitted into the frame): click it to edit it. */
function ShotGhost({ index, scene, layout, W, H, x = 0, inSet = false }) {
  const gW0 = layout.canvas.width;
  const gH0 = layout.canvas.height;
  const k = Math.min(W / gW0, H / gH0);
  const gw = gW0 * k;
  const gh = gH0 * k;
  return html`<div class="ghost-wrap ${inSet ? "set" : ""}" data-shot=${index} style=${{ width: W + "px", height: H + "px", left: x + "px" }} title=${inSet ? `${screenName(index)}: click to edit it` : `Shot ${index + 1}: click to edit it`}
      onPointerDown=${(ev) => {
        if (ev.button !== 0) return;
        ev.stopPropagation();
        goToShot(index);
      }}
      onDblClick=${(ev) => {
        ev.stopPropagation();
        canvasApi.fitScreen?.();
      }}
      onContextMenu=${(ev) => inSet && screenMenu(ev, index)}>
    <${ShotCtx.Provider} value=${{ scene, layout, ghost: true }}>
      <div class="artboard ghost" style=${{ width: gw + "px", height: gh + "px", left: (W - gw) / 2 + "px", top: (H - gh) / 2 + "px" }}>
        <${Backdrop} bg=${scene.background} W=${gW0} H=${gH0} />
        ${scene.menuBar && html`<${SceneMenuBar} bar=${scene.menuBar} H=${gh} />`}
        ${layout.entities.map(
          (e) => html`<div key=${e.id} class="ent ent-${e.kind}" data-id=${e.id} style=${place(e, gw, gh)}>
            ${e.kind === "shape" ? html`<${ShapeEnt} e=${e} W=${gw} H=${gh} />` : e.kind === "device" ? html`<${DeviceEnt} e=${e} W=${gw} H=${gh} />` : html`<${TextEnt} e=${e} H=${gh} editing=${null} onDone=${() => undefined} />`}
          </div>`,
        )}
      </div>
    <//>
  </div>`;
}

const JOIN_PROPS = ["transform", "opacity", "clipPath", "filter", "maskImage", "webkitMaskImage", "visibility", "zIndex"];

/**
 * Show what's on screen at the video's time T: the shot being edited, another shot, or two part
 * way through the transition between them, each at its own moment of its own timeline.
 */
function composite(world, art, T, plan, ghosts) {
  if (!world || !art) return;
  const els = new Map([[S.shot, art]]);
  world.querySelectorAll(":scope > .ghost-wrap").forEach((g) => els.set(Number(g.dataset.shot), g));
  for (const el of els.values()) for (const k of JOIN_PROPS) el.style[k] = "";
  for (const el of els.values()) if (el !== art) el.style.visibility = "hidden";
  const matte = world.querySelector(":scope > .join-matte");
  const frameClip = world.querySelector(":scope > .frame-clip");
  const ownClip = art.querySelector(":scope > .clip");
  const vis = shotsAt(plan, T);
  const show = (i, style, z) => {
    const el = els.get(i);
    if (!el) return;
    el.style.visibility = "visible";
    el.style.zIndex = z;
    for (const [k, v] of Object.entries(style)) el.style[k] = v;
    if (style.maskImage) el.style.webkitMaskImage = style.maskImage;
    if (el !== art) {
      const g = ghosts.get(i);
      if (g) applyPreview(el.querySelector(".artboard"), true, Math.max(0, T - plan.starts[i]), { scene: g.scene, layout: g.layout, held: false });
    }
  };
  // The shot being edited is hidden while another is on screen.
  if (vis.only !== undefined ? vis.only !== S.shot : vis.in !== S.shot && vis.out !== S.shot) art.style.visibility = "hidden";
  const joining = vis.only === undefined;
  if (!joining) show(vis.only, {}, 2);
  else {
    const st = joinStyles(vis.type, vis.p, art.offsetWidth, art.offsetHeight);
    show(vis.out, st.out, 1);
    show(vis.in, st.in, 2);
    if (matte) {
      matte.style.visibility = st.matte ? "visible" : "hidden";
      matte.style.background = st.matte ?? "";
    }
  }
  if (!joining && matte) matte.style.visibility = "hidden";
  // Mid-transition, one dim over the frame for both shots (the design's own would darken the other).
  if (ownClip) ownClip.style.visibility = joining ? "hidden" : "";
  if (frameClip) frameClip.style.visibility = joining ? "visible" : "hidden";
}

export function CanvasView() {
  const s = useStore();
  const layout = s.layout;
  const vp = useRef();
  const art = useRef();
  const [size, setSize] = useState({ w: 800, h: 600 });
  const [view, setView] = useState({ zoom: null, x: 0, y: 0 }); // zoom null = fit
  const [fit, setFit] = useState("set"); // in a set: fit the whole row, or the screen being edited
  const [renaming, setRenaming] = useState(null);
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

  // Another screen of the set is now the one being edited: the row stays where it is on screen
  // (the view is drawn from that screen's corner, so a zoom of your own moves along with it).
  const lastShot = useRef(s.shot);
  useLayoutEffect(() => {
    const was = lastShot.current;
    lastShot.current = s.shot;
    if (was === s.shot || view.zoom === null || !setModeRef.current) return;
    const c = cam.current;
    const step = c.W0 * c.scale * (1 + SET_GAP);
    setView((v) => ({ ...v, x: v.x + (s.shot - was) * step }));
  }, [s.shot]);
  const setModeRef = useRef(false);

  // The new layout from the engine has arrived: drop the local copy we showed meanwhile.
  useEffect(() => {
    if (pending.current && !live) pending.current = null;
  }, [layout]);

  const W0 = layout?.canvas.width ?? 1320;
  const H0 = layout?.canvas.height ?? 2868;
  // While a first-steps card sits at the bottom, the design fits in the room above it.
  // The timeline as tall as it's been dragged (else the usual), with a gap above it.
  const bottom = s.timelineOpen ? Math.max(0, Math.min(s.tlH ?? Math.min(size.h * 0.44, 270), size.h - 150)) + 30 : s.guide === "design" || s.stillPick ? Math.min(size.h * 0.46, 290) : s.guide ? 210 : BOTTOM;
  // A set of screens sits in a row in Edit: fit the whole row, or just the screen being edited.
  const setMode = !s.timelineOpen && s.view === "canvas" && manyShots();
  const count = setMode ? s.shots.length : 1;
  const G0 = Math.round(W0 * SET_GAP);
  const fitAll = setMode && fit === "set";
  // The row: every screen, the gaps, and the narrow Add screen tile at the end.
  const R0 = fitAll ? count * W0 + count * G0 + W0 * SET_ADD : W0;
  const fitS = Math.max(0.02, Math.min((size.w - PAD * 2) / R0, (size.h - TOP - bottom) / H0));
  const scale = view.zoom ?? fitS;
  const W = W0 * scale;
  const H = H0 * scale;
  const G = G0 * scale;
  const ox = view.zoom === null ? (size.w - R0 * scale) / 2 + (fitAll ? s.shot * (W + G) : 0) : view.x;
  const oy = view.zoom === null ? TOP + (size.h - TOP - bottom - H) / 2 : view.y;

  // The view as it is right now. Trackpad events arrive faster than the canvas re-renders, so
  // each one builds on the last one's result rather than on the last render.
  const cam = useRef();
  cam.current = { scale, ox, oy, W0, H0, size, ready: !!layout };
  setModeRef.current = setMode;
  const moveTo = (zoom, x, y) => {
    cam.current = { ...cam.current, scale: zoom, ox: x, oy: y };
    setView({ zoom, x, y });
  };
  const zoomAt = (next, cx, cy) => {
    const c = cam.current;
    cx ??= c.size.w / 2;
    cy ??= c.size.h / 2;
    next = clamp(next, 0.02, 4);
    const fx = (cx - c.ox) / (c.W0 * c.scale);
    const fy = (cy - c.oy) / (c.H0 * c.scale);
    moveTo(next, cx - fx * c.W0 * next, cy - fy * c.H0 * next);
  };
  canvasApi.fit = () => setView({ zoom: null, x: 0, y: 0 });
  canvasApi.fitSet = () => (setFit("set"), setView({ zoom: null, x: 0, y: 0 }));
  canvasApi.fitScreen = () => (setFit("screen"), setView({ zoom: null, x: 0, y: 0 }));
  canvasApi.rename = (i) => setRenaming(i);
  canvasApi.zoomBy = (f) => zoomAt(cam.current.scale * f);
  canvasApi.zoomTo = (z) => zoomAt(z);
  canvasApi.editText = (id, part) => setEditing({ id, part: part ?? (id === "caption" ? "headline" : "text") });
  canvasApi.scale = scale;

  // Trackpad: two-finger scroll pans, pinch zooms around the pointer, from wherever the zoom is.
  // WebKit reports a pinch as gesture events (scale relative to where the pinch began); Chrome
  // as ctrl+wheel. While a gesture runs, any ctrl+wheel it also produces is ignored.
  useEffect(() => {
    const el = vp.current;
    let pinch = null; // zoom when the current pinch began
    const at = (ev) => {
      const r = el.getBoundingClientRect();
      return [ev.clientX - r.left, ev.clientY - r.top];
    };
    const wheel = (ev) => {
      if (!cam.current.ready) return;
      // A menu or list over the canvas (the + size menu, a right-click menu) scrolls itself.
      if (ev.target.closest?.(".pop, .ctx-menu, .size-switch")) return;
      ev.preventDefault();
      if (ev.ctrlKey || ev.metaKey) {
        if (pinch === null) zoomAt(cam.current.scale * Math.exp(-ev.deltaY * 0.012), ...at(ev));
      } else {
        const c = cam.current;
        moveTo(c.scale, c.ox - ev.deltaX, c.oy - ev.deltaY);
      }
    };
    const gs = (ev) => {
      ev.preventDefault();
      pinch = cam.current.scale;
    };
    const gc = (ev) => {
      ev.preventDefault();
      if (pinch !== null && cam.current.ready) zoomAt(pinch * ev.scale, ...at(ev));
    };
    const ge = (ev) => {
      ev.preventDefault();
      pinch = null;
    };
    el.addEventListener("wheel", wheel, { passive: false });
    el.addEventListener("gesturestart", gs);
    el.addEventListener("gesturechange", gc);
    el.addEventListener("gestureend", ge);
    return () => {
      el.removeEventListener("wheel", wheel);
      el.removeEventListener("gesturestart", gs);
      el.removeEventListener("gesturechange", gc);
      el.removeEventListener("gestureend", ge);
    };
  }, []);

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

  // A video of several shots in Animate: the other shots, ready to show as the video plays.
  const multi = s.timelineOpen && manyShots();
  const layoutOf = useShotLayouts(multi || setMode);
  const world = useRef();
  const ghosts = new Map();
  if ((multi || setMode) && layout) {
    s.shots.forEach((x, i) => {
      if (i === s.shot) return;
      const l = layoutOf(x.scene);
      if (l) ghosts.set(i, { scene: x.scene, layout: l });
    });
  }
  const ghostsRef = useRef(ghosts);
  ghostsRef.current = ghosts;

  const entities = useMemo(() => {
    if (!layout) return [];
    // With a Change selected in the timeline, its items are drawn as they end up (afterEntity).
    return layout.entities.map((e) => (live && live.e.id === e.id ? live.e : pending.current?.id === e.id ? pending.current : afterEntity(e, withShape)));
  }, [layout, live, s.timelineOpen, s.animSel, s.scene.animations]);

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
    if (ev.target.closest(".editing, .pop")) return;
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
    const mode = handle === "rot" ? "rotate" : handle === "from" || handle === "to" || handle === "bend" ? handle : /^[nsew]$/.test(handle ?? "") ? "stretch" : handle ? "resize" : "move";
    const start = { x: ev.clientX, y: ev.clientY };
    // Shapes: the pointer in canvas pixels, and the box as it was.
    const at = (e) => ({ x: ((e.clientX - a.left) / W) * W0, y: ((e.clientY - a.top) / H) * H0 });
    const sh0 = e0.shape;
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
        if (sh0) {
          cur = withShape(e0, (sh) => {
            if (isLine(sh.type)) {
              for (const k of ["from", "to"]) sh[k] = { x: sh0[k].x + fx, y: sh0[k].y + fy };
            } else {
              sh.x = sh0.x + fx;
              sh.y = sh0.y + fy;
            }
          }, W0, H0);
        }
      } else if (sh0 && (mode === "from" || mode === "to")) {
        // Drag an end; Shift keeps the line to 15° steps.
        const other = sh0[mode === "from" ? "to" : "from"];
        let p = at(e);
        if (e.shiftKey) {
          const ox = other.x * W0;
          const oy = other.y * H0;
          const len = Math.hypot(p.x - ox, p.y - oy);
          const ang = Math.round(Math.atan2(p.y - oy, p.x - ox) / (Math.PI / 12)) * (Math.PI / 12);
          p = { x: ox + Math.cos(ang) * len, y: oy + Math.sin(ang) * len };
        }
        cur = withShape(e0, (sh) => (sh[mode] = { x: p.x / W0, y: p.y / H0 }), W0, H0);
      } else if (sh0 && mode === "bend") {
        const p = at(e);
        cur = withShape(e0, (sh) => (sh.bend = Math.abs(bendThrough(sh0, p, W0, H0)) < 0.04 ? 0 : bendThrough(sh0, p, W0, H0)), W0, H0);
      } else if (sh0 && mode === "stretch") {
        // Pull one side; the opposite side stays put.
        const p = at(e);
        const rad = ((sh0.rotate || 0) * Math.PI) / 180;
        const horiz = handle === "e" || handle === "w";
        const u = horiz ? { x: Math.cos(rad), y: Math.sin(rad) } : { x: -Math.sin(rad), y: Math.cos(rad) };
        const sign = handle === "e" || handle === "s" ? 1 : -1;
        const h0 = sh0.size * H0;
        const w0 = h0 * sh0.aspect;
        const half = (horiz ? w0 : h0) / 2;
        const c0 = { x: sh0.x * W0, y: sh0.y * H0 };
        const fixed = { x: c0.x - u.x * sign * half, y: c0.y - u.y * sign * half };
        const len = Math.max(6, sign * ((p.x - fixed.x) * u.x + (p.y - fixed.y) * u.y));
        const c = { x: fixed.x + (u.x * sign * len) / 2, y: fixed.y + (u.y * sign * len) / 2 };
        cur = withShape(e0, (sh) => {
          sh.x = c.x / W0;
          sh.y = c.y / H0;
          if (horiz) sh.aspect = len / h0;
          else {
            sh.size = len / H0;
            sh.aspect = w0 / len;
          }
        }, W0, H0);
      } else if (mode === "resize") {
        const d0 = Math.hypot(start.x - center.x, start.y - center.y) || 1;
        const d1 = Math.hypot(e.clientX - center.x, e.clientY - center.y);
        const f = clamp(d1 / d0, 0.05, 12);
        if (sh0) {
          cur = withShape(e0, (sh) => (sh.size = Math.max(0.004, sh0.size * f)), W0, H0);
        } else if (cur.kind === "device") {
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
        if (sh0) cur = withShape(e0, (sh) => (sh.rotate = ang), W0, H0);
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
  // Animate: the canvas shows the design at the playhead (and as designed everywhere else).
  useLayoutEffect(() => applyPreview(art.current, S.timelineOpen, playhead.t));
  useEffect(() => onPlayhead((t) => applyPreview(art.current, S.timelineOpen, t)), []);
  // Playing through a video of several shots: show what's on screen at the video's time.
  useLayoutEffect(() => {
    if (multi && !offVideo()) composite(world.current, art.current, video.T, videoPlan(), ghostsRef.current);
    else if (art.current) {
      for (const k of JOIN_PROPS) art.current.style[k] = "";
      const own = art.current.querySelector(":scope > .clip");
      if (own) own.style.visibility = "";
    }
  });
  useEffect(() => onVideoTime((T, plan) => S.timelineOpen && manyShots() && composite(world.current, art.current, T, plan, ghostsRef.current)), []);

  return html`<div class="viewport ${space ? "space" : ""}" ref=${vp} onPointerDown=${onPointerDown} onDblClick=${onDblClick}
      onPointerMove=${(e) => {
        const id = e.target.closest?.(".ghost-wrap") ? null : (e.target.closest?.(".ent")?.dataset.id ?? null);
        if (id !== S.hover) set({ hover: id });
      }}
      onPointerLeave=${() => S.hover && set({ hover: null })}
      onDragOver=${onDragOver} onDragLeave=${() => setDropOver(false)} onDrop=${onDrop}>
    <div class="dots" style=${{ "--dot": 22 * Math.max(0.5, Math.min(2, scale / fitS)) + "px", "--dot-x": ox + "px", "--dot-y": oy + "px" }}></div>
    ${layout &&
    html`<div class="world" ref=${world} style=${{ transform: `translate(${ox}px, ${oy}px)` }}>
      ${multi && html`<div class="join-matte" style=${{ width: W + "px", height: H + "px" }}></div>`}
      ${multi && [...ghosts.entries()].map(([i, g]) => html`<${ShotGhost} key=${`g${i}`} index=${i} scene=${g.scene} layout=${g.layout} W=${W} H=${H} />`)}
      ${setMode && [...ghosts.entries()].map(([i, g]) => html`<${ShotGhost} key=${`s${i}`} index=${i} scene=${g.scene} layout=${g.layout} W=${W} H=${H} x=${(i - s.shot) * (W + G)} inSet=${true} />`)}
      ${setMode && s.shots.map((x, i) => html`<${SetLabel} key=${`l${i}`} i=${i} x=${(i - s.shot) * (W + G)} w=${W} on=${i === s.shot} renaming=${renaming === i} onDone=${() => setRenaming(null)} />`)}
      ${setMode && html`<button class="set-add" style=${{ left: (s.shots.length - s.shot) * (W + G) + "px", width: W * SET_ADD + "px", height: H + "px" }} title="Add a screen at the end: a copy of the last one"
        onPointerDown=${(e) => e.stopPropagation()} onClick=${() => addShot("copy", { at: s.shots.length, copyOf: s.shots.length - 1 })}><${Icon} n="plus" s=${Math.max(16, Math.min(28, W / 8))} /><span>Add screen</span></button>`}
      ${multi && html`<div class="frame-clip" style=${{ width: W + "px", height: H + "px" }}></div>`}
      <div class="artboard-label" style=${{ top: H + 12 + "px", zIndex: setMode ? 96 : undefined }}><button class="size-btn" title="Change the image size" onPointerDown=${(e) => e.stopPropagation()} onClick=${() => {
        set({ selected: null, rightOpen: true });
        persistPrefs();
      }}><b>${canvasName(layout.canvas.name)}</b><span>${layout.canvas.width} × ${layout.canvas.height}</span><${Icon} n="down" s=${11} /></button><span class="faint">${s.shots?.length > 1 ? html`· <b class="shot-of">Screen ${s.shot + 1} of ${s.shots.length}</b> ` : ""}${!s.timelineOpen && !(s.shots?.length > 1) ? html`· <button class="link-btn" onPointerDown=${(e) => e.stopPropagation()} onClick=${() => addShot("copy")} title="Make this a set: add another screen beside it">Add a screen</button> ` : ""}· Edit view shows placement. Preview shows the finished look.</span></div>
      <div class="artboard ${setMode ? "in-set" : ""} ${dropOver ? "drop-over" : ""} ${s.ai.busy || s.designing ? "ai-working" : ""}" ref=${art} style=${{ width: W + "px", height: H + "px", "--set-gap": G + "px" }}>
        <${Backdrop} bg=${s.scene.background} W=${W0} H=${H0} />
        ${s.scene.menuBar && html`<${SceneMenuBar} bar=${s.scene.menuBar} H=${H} />`}
        ${entities.map(
          (e) => html`<div key=${e.id} class="ent ent-${e.kind} ${s.pulse.includes(e.id) ? "pulse" : ""}" data-id=${e.id} style=${place(e, W, H)}>
            ${e.kind === "shape"
              ? html`<${ShapeEnt} e=${e} W=${W} H=${H} />`
              : e.kind === "device"
              ? html`<${DeviceEnt} e=${e} W=${W} H=${H} />`
              : html`<${TextEnt} e=${e} H=${H} editing=${editing?.id === e.id ? editing.part : null} onDone=${finishEdit} />`}
          </div>`,
        )}
        <div class="clip"></div>
        ${s.timelineOpen && html`<${Viewfinder} /><${MotionPathOverlay} />`}
        ${guides.map((g) => (g.v !== undefined ? html`<div class="guide v" style=${{ left: g.v * W + "px", top: -4000 + "px", height: 8000 + "px" }}></div>` : html`<div class="guide h" style=${{ top: g.h * H + "px", left: -4000 + "px", width: 8000 + "px" }}></div>`))}
        ${hovBox && !live && html`<div class="hover-box" style=${hovBox}></div>`}
        ${sel?.kind === "shape" && isLine(sel.shape.type) && html`<${LineHandles} sh=${sel.shape} W=${W} H=${H} dims=${dims} />`}
        ${selBox &&
        !editing &&
        !(sel.kind === "shape" && isLine(sel.shape.type)) &&
        html`<div class="sel-box ${sel.kind === "shape" && Math.min(sel.width * W, sel.height * H) <= 44 ? "small" : ""}" style=${selBox}>
          ${["nw", "ne", "sw", "se"].map((c) => html`<div class="h ${c}" data-handle=${c}></div>`)}
          ${sel.kind === "shape" && Math.min(sel.width * W, sel.height * H) > 44 && ["n", "s", "e", "w"].map((c) => html`<div class="h side ${c}" data-handle=${c}></div>`)}
          ${sel.kind !== "caption" && html`<div class="rot" data-handle="rot"><${Icon} n="rotate" s=${12} w=${2} /></div>`}
          ${dims && html`<div class="dims" style=${{ transform: `translate(-50%, 10px) rotate(${-(sel.rotate || 0)}deg)` }}>${dims}</div>`}
        </div>`}
      </div>
    </div>`}
    ${sel && selBox && !live && !editing && !s.timelineOpen && html`<${ContextBar} sel=${sel} box=${selEl} vp=${vp.current} />`}
    ${layout && !s.timelineOpen && s.view === "canvas" && (s.scene.devices.length || s.groups) && html`<${SizeSwitch} />`}
    ${layout &&
    html`<div class="float zoom-ctl" onPointerDown=${(e) => e.stopPropagation()}>
      <button class="icon-btn sm" title="Zoom out (⌘−)" onClick=${() => canvasApi.zoomBy(1 / 1.25)}><${Icon} n="minus" s=${14} /></button>
      <button class="pct" title="Fit (⌘0)" onClick=${() => canvasApi.fit()}>${Math.round(scale * 100)}%</button>
      <button class="icon-btn sm" title="Zoom in (⌘+)" onClick=${() => canvasApi.zoomBy(1.25)}><${Icon} n="plus" s=${14} /></button>
      ${setMode
        ? html`<button class="icon-btn sm ${view.zoom === null && fit === "screen" ? "on" : ""}" title="Fit this screen (⌘0)" onClick=${() => canvasApi.fitScreen()}><${Icon} n="fit" s=${14} /></button>
            <button class="icon-btn sm ${view.zoom === null && fit === "set" ? "on" : ""}" title="Fit the whole set (⇧⌘0)" onClick=${() => canvasApi.fitSet()}><${Icon} n="grid" s=${14} /></button>`
        : html`<button class="icon-btn sm ${view.zoom === null ? "on" : ""}" title="Zoom to fit (⌘0)" onClick=${() => canvasApi.fit()}><${Icon} n="fit" s=${14} /></button>`}
    </div>`}
  </div>`;
}

/**
 * The design's sizes, above the canvas: the one being edited, the others to switch to (right-click
 * one to remove it), and + to make every screen again at another size.
 */
function SizeSwitch() {
  const s = useStore();
  const groups = allGroups() ?? [{ shots: activeScreens() }];
  const presets = s.opts?.canvases ?? {};
  const have = new Set(groups.map((g) => g.shots[0].scene.canvas ?? ""));
  const options = sizeOptions(presets).map((o) => (have.has(o.value) ? { ...o, hint: "In this design" } : o));
  const menu = (ev, i) => {
    ev.preventDefault();
    ev.stopPropagation();
    openMenu(ev.clientX, ev.clientY, [
      { label: "Open", icon: "eye", run: () => goToSize(i), disabled: i === s.group },
      "-",
      { label: `Remove ${sizeLabel(groups[i].shots[0].scene)}`, icon: "trash", danger: true, run: () => removeSize(i) },
    ]);
  };
  return html`<div class="size-switch" onPointerDown=${(e) => e.stopPropagation()} onContextMenu=${(e) => (e.preventDefault(), e.stopPropagation())}>
    <div class="tabs">${groups.map((g, i) => {
      const on = i === s.group || groups.length === 1;
      const label = on && !g.shots[0].scene.canvas && s.layout ? canvasName(s.layout.canvas.name) : sizeLabel(g.shots[0].scene);
      return html`<button class="size-tab ${on ? "on" : ""}" title=${on ? `${label}, on the canvas${groups.length > 1 ? ". Right-click to remove it." : ""}` : `Open ${label}`}
        onClick=${() => goToSize(i)} onContextMenu=${(e) => (groups.length > 1 ? menu(e, i) : (e.preventDefault(), e.stopPropagation()))}>
        ${label}${g.shots.length > 1 && html`<span class="n">${g.shots.length}</span>`}
      </button>`;
    })}</div>
    <${Dropdown} value=${null} options=${options} search onChange=${addSize} btnClass="icon-btn sm size-add" title="Add a size: every screen made again for iPad, Apple Watch, Google Play…" trigger=${html`<${Icon} n="plus" s=${14} />`} />
  </div>`;
}

/** The gap between screens of a set, and the Add screen tile's width, as fractions of a screen's width. */
const SET_GAP = 0.1;
const SET_ADD = 0.42;

/** A screen's name above it in the set: "01 · Introduction". Double-click to rename. */
function SetLabel({ i, x, w, on, renaming, onDone }) {
  const name = screenName(i);
  const done = (v) => {
    onDone();
    if (v === undefined) return;
    updateShot(i, { name: v.trim() || undefined });
  };
  return html`<div class="set-label ${on ? "on" : ""}" style=${{ left: x + "px", width: w + "px" }}
      onPointerDown=${(e) => {
        e.stopPropagation();
        if (!renaming && e.button === 0) goToShot(i);
      }}
      onDblClick=${(e) => (e.stopPropagation(), canvasApi.rename(i))}
      onContextMenu=${(e) => screenMenu(e, i)}>
    <span class="n">${String(i + 1).padStart(2, "0")}</span>
    ${renaming
      ? html`<input class="set-rename" value=${S.shots?.[i]?.name ?? ""} placeholder=${name} ref=${(el) => el && !el.dataset.f && ((el.dataset.f = "1"), el.focus(), el.select())}
          onKeyDown=${(e) => {
            e.stopPropagation();
            if (e.key === "Enter") done(e.target.value);
            if (e.key === "Escape") done();
          }}
          onBlur=${(e) => done(e.target.value)} />`
      : html`<span class="nm" title="Double-click to rename">${name}</span>`}
    ${S.shots?.[i]?.video === false && html`<span class="off" title="Left out of the video: still one of the set's screenshots">No video</span>`}
  </div>`;
}

function screenMenu(ev, i) {
  ev.preventDefault();
  ev.stopPropagation();
  const n = S.shots?.length ?? 1;
  openMenu(ev.clientX, ev.clientY, [
    { label: "Rename", icon: "text", run: () => canvasApi.rename(i) },
    { label: "Duplicate", icon: "duplicate", run: () => addShot("copy", { at: i + 1, copyOf: i }) },
    { label: "Copy style to the others…", icon: "copy", run: () => (goToShot(i), openCopyStyle()) },
    S.shots?.[i]?.video === false ? { label: "Put back in the video", icon: "video", run: () => setInVideo(i, true) } : { label: "Leave out of the video", icon: "video", run: () => setInVideo(i, false) },
    { label: "Move left", icon: "left", disabled: i === 0, run: () => moveShot(i, -1) },
    { label: "Move right", icon: "right", disabled: i === n - 1, run: () => moveShot(i, 1) },
    "-",
    { label: "Delete", icon: "trash", danger: true, run: () => deleteShot(i) },
  ]);
}

function canvasName(name) {
  const presets = S.opts?.canvases ?? {};
  if (presets[name]) return presets[name].short ?? presets[name].label;
  if (/^\d+x\d+$/i.test(name)) return "Custom size";
  return { "iphone-6.9": "iPhone 6.9″ App Store", "iphone-6.5": "iPhone 6.5″ App Store", "ipad-13": "iPad 13″ App Store", "ipad-12.9": "iPad 12.9″ App Store" }[name] ?? name;
}

function selectionBox(e, W, H, el) {
  if (e.kind === "device" || e.kind === "shape") {
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
  if (e.kind === "shape") {
    const sh = e.shape;
    if (mode === "resize" || mode === "stretch") return `${Math.round(sh.size * H0 * sh.aspect)} × ${Math.round(sh.size * H0)} px`;
    if (mode === "bend") return sh.bend ? `Curve ${Math.round(sh.bend * 100)}%` : "Straight";
    if (mode === "from" || mode === "to") {
      const len = Math.hypot((sh.to.x - sh.from.x) * W0, (sh.to.y - sh.from.y) * H0);
      const ang = (Math.atan2((sh.to.y - sh.from.y) * H0, (sh.to.x - sh.from.x) * W0) * 180) / Math.PI;
      return `${Math.round(len)} px  ·  ${Math.round(-ang)}°`;
    }
  }
  if (mode === "resize") return e.kind === "device" ? `H ${Math.round(e.height * 1000) / 10}%  ·  ${Math.round(e.width * W0)}×${Math.round(e.height * H0)}` : `${Math.round(e.size * H0)} px`;
  return `X ${Math.round(e.x * 1000) / 10}%  Y ${Math.round(e.y * 1000) / 10}%`;
}

/** Write an entity's canvas position back into the scene. */
function commit(e) {
  // Animate, with a Change selected: the drag sets what the animation changes it to.
  if (commitKeyframe(e)) return;
  touch("moved");
  edit((d) => {
    if (e.kind === "device") {
      const dev = d.devices[e.index];
      if (!dev) return;
      Object.assign(dev, { x: r4(e.x), y: r4(e.y), anchor: "center", height: r4(clamp(e.height, 0.01, 5)), rotate: Math.round((e.rotate || 0) * 2) / 2 });
      delete dev.width;
      if (!dev.rotate) delete dev.rotate;
    } else if (e.kind === "shape") {
      const sh = d.shapes?.[e.index];
      const g = e.shape;
      if (!sh || !g) return;
      // Moved by hand, it stays where it was put, rather than following its target.
      delete sh.around;
      delete sh.at;
      if (isLine(g.type)) {
        sh.from = { x: r4(g.from.x), y: r4(g.from.y) };
        sh.to = { x: r4(g.to.x), y: r4(g.to.y) };
        sh.bend = Math.round(g.bend * 100) / 100;
        delete sh.x;
        delete sh.y;
      } else {
        Object.assign(sh, { x: r4(g.x), y: r4(g.y), size: r4(g.size), aspect: Math.round(g.aspect * 1000) / 1000, rotate: Math.round((g.rotate || 0) * 2) / 2 });
        if (!sh.rotate) delete sh.rotate;
      }
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

/** A selected line or arrow: its two ends, and a handle in the middle to curve it. */
function LineHandles({ sh, W, H, dims }) {
  const m = curveMid(sh, W, H);
  return html`<div class="line-handles">
    <svg class="line-guide" width=${W} height=${H}><line x1=${sh.from.x * W} y1=${sh.from.y * H} x2=${sh.to.x * W} y2=${sh.to.y * H} /></svg>
    <div class="pt" data-handle="from" title="Drag to move this end" style=${{ left: sh.from.x * W + "px", top: sh.from.y * H + "px" }}></div>
    <div class="pt" data-handle="to" title="Drag to move this end" style=${{ left: sh.to.x * W + "px", top: sh.to.y * H + "px" }}></div>
    <div class="pt bend" data-handle="bend" title="Drag to curve it" style=${{ left: m.x + "px", top: m.y + "px" }}></div>
    ${dims && html`<div class="dims" style=${{ left: m.x + "px", top: m.y + 18 + "px" }}>${dims}</div>`}
  </div>`;
}

// ---------------------------------------------------------------------------------------------
// Floating actions above the selection

function ContextBar({ sel, box, vp }) {
  const [pick, setPick] = useState(null);
  const barRef = useRef();
  useEffect(() => setPick(null), [sel.id]);
  if (!box || !vp) return null;
  // Sit above the selection (clear of the rotate handle), else below it, else at the top of the
  // canvas; prefer a spot that doesn't cover another item, like the headline.
  const r = box.getBoundingClientRect();
  const v = vp.getBoundingClientRect();
  const left = clamp(r.left + r.width / 2 - v.left, 200, v.width - 200);
  const half = 185;
  // Also keep clear of the "3D tilt" tag and the artboard's own label.
  const others = [...vp.querySelectorAll(".ent, .ent-device .tag, .artboard-label"), ...(vp.parentElement?.querySelectorAll(".guide-strip") ?? [])].filter((el) => el.dataset.id !== sel.id).map((el) => el.getBoundingClientRect());
  const fits = (bottom) => bottom - 40 >= 8 && bottom <= v.height - 70;
  const clear = (bottom) =>
    !others.some((o) => o.left - v.left < left + half && o.right - v.left > left - half && o.top - v.top < bottom && o.bottom - v.top > bottom - 40);
  // The nearest free spot above the selection or below it, whichever is closer; failing that,
  // just above it (or below, or at the top of the canvas) even if it covers something.
  const above = r.top - v.top - (sel.kind === "caption" ? 12 : 50);
  const below = r.bottom - v.top + 50;
  const scan = (from, step) => {
    for (let b = from; b - 40 >= 8 && b <= v.height - 70; b += step) if (clear(b)) return b;
    return null;
  };
  const up = scan(above, -6);
  const down = scan(below, 6);
  const top = up !== null && (down === null || above - up <= down - below) ? up : (down ?? [above, below, 50].find(fits) ?? 50);
  const stop = (e) => e.stopPropagation();
  const text = sel.kind === "caption" || sel.kind === "text";
  const sh = sel.shape;
  // The everyday edits sit in the bar itself: words, colours, the screenshot. The rest is one
  // click away, under ⋯ or in Settings.
  const shapeUpd = (fn, key) => edit((d) => {
    const x = d.shapes?.[sel.index];
    if (x) fn(x);
  }, key && `s${sel.index}.${key}`);
  const textColor = (v) =>
    sel.id === "caption"
      ? edit((d) => (d.textStyle = { ...(d.textStyle ?? {}), color: v }), "cap.color")
      : edit((d) => {
          const t = d.texts?.[sel.index];
          if (t) t.color = v;
        }, `t${sel.index}.color`);
  const more = (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    const z = sel.id !== "caption";
    openMenu(r.left, r.bottom + 6, [
      sel.kind === "shape" && { label: sh?.sketch ? "Make it clean" : "Make it hand-drawn", icon: "pen", run: () => shapeUpd((x) => (x.sketch = sh?.sketch ? undefined : true)) },
      z && { label: "Duplicate", icon: "duplicate", kbd: "⌘D", run: () => duplicateEntity(sel.id) },
      z && { label: "Bring forward", icon: "front", run: () => moveZ(sel.id, 1) },
      z && { label: "Send backward", icon: "back", run: () => moveZ(sel.id, -1) },
      "-",
      { label: "All settings", icon: "sliders", kbd: "⌥⌘I", run: () => !S.rightOpen && togglePanel("right") },
    ]);
  };
  // Colours to change from the bar: a fill dot, a stroke ring, or the text's colour.
  const colours = text
    ? [{ key: "text", label: "Text colour", value: sel.color, onChange: textColor }]
    : sel.kind === "shape" && sh
      ? [
          !isLine(sh.type) && { key: "fill", label: "Fill", value: sh.fill, none: true, onChange: (v) => shapeUpd((x) => (x.fill = v ?? "none"), "fill") },
          {
            key: "stroke",
            label: sh.type === "badge" ? "Ring" : isLine(sh.type) ? "Colour" : "Stroke",
            value: sh.strokeWidth > 0 ? sh.stroke : undefined,
            ring: !isLine(sh.type),
            none: !isLine(sh.type),
            onChange: (v) => shapeUpd((x) => {
              x.stroke = v ?? "none";
              if (v && !(sh.strokeWidth > 0)) x.strokeWidth = 0.005;
            }, "stroke"),
          },
        ].filter(Boolean)
      : [];
  const picking = pick && colours.find((c) => c.key === pick.key);
  const off = (v) => !v || v === "none";
  return html`<div class="ctx-bar" ref=${barRef} style=${{ left: left + "px", top: top + "px" }} onPointerDown=${(e) => {
    stop(e);
    if (!e.target.closest(".qc")) setPick(null);
  }}>
    <button class="btn" title="Describe a change and let AI make it (⌘K)" onClick=${() => openAI(sel.id)}><${Icon} n="spark" s=${14} style=${{ color: "var(--pink)" }} /><span class="ai-mini">Ask AI</span></button>
    <span class="sep"></span>
    ${text && html`<button class="btn" title="Change the words (double-click, or ↩)" onClick=${() => canvasApi.editText(sel.id)}><${Icon} n="text" s=${14} />Edit</button>`}
    ${sel.kind === "device" && html`<button class="btn" title="Use a different screenshot in this device" onClick=${() => replaceMode(sel.id)}><${Icon} n="replace" s=${14} />Replace</button>`}
    ${sel.kind === "device" && S.scene.devices[sel.index]?.video && html`<button class="btn ${S.stillPick?.id === sel.id ? "on" : ""}" title="Choose the moment of the recording this device shows in images" onClick=${() => (S.stillPick?.id === sel.id ? closeStills() : openStills(sel.id))}><${Icon} n="image" s=${14} />Still</button>`}
    ${colours.map(
      (c) => html`<button key=${c.key} class="qc ${c.ring ? "ring" : ""} ${off(c.value) ? "off" : ""} ${pick?.key === c.key ? "on" : ""}" title=${c.label} data-colour=${c.key}
        onClick=${() => setPick(pick?.key === c.key ? null : { key: c.key })}>
        <span style=${off(c.value) ? null : c.ring ? { borderColor: c.value } : { background: c.value }}></span>
      </button>`,
    )}
    <button class="btn ${S.rightOpen ? "on" : ""}" title="Every setting for this, in the panel on the right (⌥⌘I)" onClick=${() => togglePanel("right")}><${Icon} n="sliders" s=${14} />Settings</button>
    <button class="icon-btn" title="More" onClick=${more}><${Icon} n="dots" s=${15} /></button>
    <button class="icon-btn" title=${sel.id === "caption" ? "Remove the headline (⌫)" : "Delete (⌫)"} onClick=${() => deleteEntity(sel.id)}><${Icon} n="trash" s=${15} /></button>
  </div>
  ${picking &&
  html`<${Popover} anchor=${barRef.current} avoid=${box} onClose=${() => setPick(null)} width=${244} align="center">
    <div class="qc-head"><b>${picking.label}</b>${picking.none && html`<button class="btn sm ${off(picking.value) ? "on" : "ghost"}" onClick=${() => picking.onChange(undefined)}>None</button>`}</div>
    <${ColorPicker} value=${off(picking.value) ? "#ffffff" : picking.value} onChange=${(v) => v && picking.onChange(v)} />
  <//>`}`;
}

export { commit as commitEntity, entityLabel };
