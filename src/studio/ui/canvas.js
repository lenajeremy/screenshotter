// The layout canvas: shows where things go (no effects), lets you drag, resize, rotate and retype.
import { createContext } from "preact";
import { useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import { Dropdown, accentEditHtml, accentFromEdit, html, toggleAccentIn } from "./controls.js";
import { Icon } from "./icons.js";
import { openMenu } from "./menu.js";
import { MotionPathOverlay, Viewfinder, afterEntity, applyPreview, blurAnimated, commitKeyframe, followVideo, joinStyles, manyShots, offVideo, onPlayhead, onVideoTime, playhead, shotsAt, video, videoPlan } from "./timeline.js";
import { textPieces, unitMode } from "./animate.js";
import { CURSOR_ART, clickAt, cursorAt, cursorKindAt } from "./cursor.js";
import { cursorTrack } from "./recording.js";
import { S, STORE_GAP, activeScreens, allGroups, api, clamp, edit, entityLabel, fileUrl, persistPrefs, r4, set, setScene, thumbUrl, touch, useStore, pictureUrl, layoutCache, rememberLayout, knownLayout, hasDesign } from "./store.js";
import { addDevice, addShot, addSize, isPlaceholder, carryDeviceOver, finishedAsked, finishedLook, moveShotTo, openCopyStyle, setInVideo, deleteShot, goToShot, goToSize, moveShot, recordingFor, removeSize, replaceMode, screenName, sizeLabel, updateShot } from "./actions.js";
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
/** Room above the design: for the set's screen names or the sizes' tabs, else a margin. */
const TOP_TABS = 96;
const TOP_PLAIN = 56;
const BOTTOM = 64;

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

function Backdrop({ bg, W, H, span }) {
  const looks = S.opts?.looks;
  const guess = bgGuess(bg, looks);
  const key = JSON.stringify(bg ?? null);
  const [ready, setReady] = useState(null);
  // Across a set, the backdrop is as wide as every screen side by side, and this one shows its slice.
  const n = span && span.count > 1 ? span.count : 1;
  const w = Math.round(Math.min(720 * Math.min(n, 3), (W * (n + (n - 1) * (span?.gap ?? 0))) / 3));
  const still = needsStill(bg, looks) ? `/api/bg-preview?bg=${encodeURIComponent(key)}&w=${w}&h=${Math.round((w * H) / (W * (n + (n - 1) * (span?.gap ?? 0))))}` : null;
  const g = n > 1 ? (span.gap ?? 0) * 100 : 0;
  const slice = n > 1 ? { width: n * 100 + (n - 1) * g + "%", right: "auto", left: -Math.min(span.index, n - 1) * (100 + g) + "%" } : null;
  // The backdrop's own move (Animate) turns and scales the inner layer; the camera moves the outer.
  return html`<div class="bg"><div class="bg-move" style=${{ background: guess, ...slice }}>
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

/** An accent's look as CSS text, for the words being retyped (just bolder when it has no look of its own). */
const accentCss = (accent) => {
  const st = accentStyle(accent);
  if (!accent.color && !accent.font && accent.weight === undefined && !accent.italic) st.fontWeight = "bolder";
  return Object.entries(st)
    .filter(([, v]) => v !== undefined && v !== "")
    .map(([k, v]) => `${k.replace(/^Webkit/, "-webkit-").replace(/[A-Z]/g, (c) => "-" + c.toLowerCase())}: ${v}`)
    .join("; ");
};

/** A screen with nothing on it yet but its backdrop: it asks for a screenshot (one with words or pictures only gets a small button). */
const bare = (sc) => !sc.texts?.length && !sc.images?.length && !sc.shapes?.length && !sc.headline && !sc.subheadline;

/** A mark as a background that Animate can draw in (--amark), as the render's are. */
const sweep = { backgroundRepeat: "no-repeat", WebkitBoxDecorationBreak: "clone", boxDecorationBreak: "clone" };
/** A highlighter's band: a translucent stroke over the lower half of the line (as the render's markerBand). */
const markerBand = (c) => ({
  backgroundImage: `linear-gradient(transparent 50%, color-mix(in oklab, ${c} 58%, transparent) 50%, color-mix(in oklab, ${c} 58%, transparent) 92%, transparent 92%)`,
  backgroundSize: "calc(var(--amark, 1) * 100%) 100%",
  ...sweep,
});

/** A squiggly underline: one long wave pinned left and cropped to the words, as the render's squiggleImage. */
const WAVE = `M0 5Q4 0 8 5${Array.from({ length: 299 }, (_, k) => `T${(k + 2) * 8} 5`).join("")}`;
const squiggleImage = (c) =>
  `url("data:image/svg+xml,${`<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 2400 10' preserveAspectRatio='xMinYMid slice'><path d='${WAVE}' fill='none' stroke='${String(c).replace(/['"<>&]/g, "")}' stroke-width='2.5' stroke-linecap='round' stroke-linejoin='round'/></svg>`.replace(/%/g, "%25").replace(/#/g, "%23").replace(/</g, "%3C").replace(/>/g, "%3E")}")`;

/** Accent words with their mark (highlighter, underline, squiggle or pill), as the render's markAccent draws them. */
function marked(nodes, accent) {
  const solid = accent.color && !/gradient\(/.test(accent.color) ? accent.color : undefined;
  const c = accent.markColor ?? solid ?? "#ffd60a";
  // A pill or highlighter made in the accent colour sets its words in the text's own colour.
  const own = (accent.mark === "pill" || accent.mark === "highlight") && !accent.markColor && solid ? { ...accent, color: accent.base } : accent;
  const plain = !own.color && !own.font && own.weight === undefined && !own.italic;
  const word = plain ? html`<strong>${nodes}</strong>` : html`<span class="accent" style=${accentStyle(own)}>${nodes}</span>`;
  const st =
    accent.mark === "highlight"
      ? { ...markerBand(c), padding: "0 .08em", margin: "0 -.08em" }
      : accent.mark === "underline"
        ? { backgroundImage: `linear-gradient(${c}, ${c})`, backgroundPosition: "0 100%", backgroundSize: "calc(var(--amark, 1) * 100%) .09em", ...sweep, paddingBottom: ".02em" }
        : accent.mark === "squiggle"
          ? { backgroundImage: squiggleImage(c), backgroundPosition: "0 100%", backgroundSize: "calc(var(--amark, 1) * 100%) .27em", ...sweep, paddingBottom: ".07em" }
          : { backgroundImage: `linear-gradient(${c}, ${c})`, backgroundSize: "calc(var(--amark, 1) * 100%) 100%", ...sweep, borderRadius: ".32em", padding: "0 .24em", margin: "0 .04em" };
  return html`<span class="mark" style=${st}>${word}</span>`;
}

/** Text cut into words or letters (.u), like the video renderer, so Animate can move each one. */
function richUnits(text, accent, by) {
  const plain = !accent.color && !accent.font && accent.weight === undefined && !accent.italic;
  const wrap = (nodes, on, seg) =>
    !on ? nodes : accent.mark ? marked(nodes, accent) : plain ? html`<strong>${nodes}</strong>` : html`<span class="accent" data-acc=${seg} style=${accentStyle(accent)}>${nodes}</span>`;
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
      if (accent.mark) return marked(part, accent);
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
  if (e.kind === "device" || e.kind === "image") {
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
  // A neighbour's device carrying on into this screen is described in `spill`, not `devices`.
  const dev = (e.spill ? scene.spill : scene.devices)?.[e.index] ?? {};
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
  // "▶ Recording" says a device plays a video: in a recording's own design (and on its webcam) that's
  // already plain, so it only shows elsewhere, and "Still" while its still is being picked.
  const picking = S.stillPick?.id === e.id;
  const tags = [dev.video && (picking ? "Still" : !scene.recording && !dev.fixed && "▶ Recording")].filter(Boolean);
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
    ${dev.video && !ghost && S.stillPick?.id !== e.id && (S.timelineOpen
      ? // In Animate, the recording follows the playhead (and plays its sound with the timeline).
        html`<video key=${dev.video + "#follow"} data-follow data-master=${e.index === 0 && scene.recording ? "1" : undefined} src=${fileUrl(dev.video)} playsinline preload="auto" onLoadedMetadata=${(ev) => followVideo(ev.currentTarget)} style=${{ ...screen, objectFit: "cover" }}></video>`
      : html`<video key=${dev.video} src=${fileUrl(dev.video)} muted loop autoplay playsinline preload="auto" style=${{ ...screen, objectFit: "cover" }}></video>`)}
    ${e.index === 0 && !e.spill && scene.recording?.cursor?.log && scene.recording.cursor.show !== false && !ghost && html`<${RecordingCursor} c=${scene.recording.cursor} box=${screen} w=${bw * s.width} />`}
    ${dev.ring && html`<div style=${{ ...screen, position: "absolute", pointerEvents: "none", boxShadow: `inset 0 0 0 ${Math.max(1, (dev.ring.width ?? 0.018) * Math.min(bw * s.width, e.height * H * s.height))}px ${dev.ring.color ?? "#fff"}` }}></div>`}
    ${e.bezel && (e.clay ? html`<${ClayArt} e=${e} s=${s} bw=${bw} />` : html`<img class="bezel-art" draggable=${false} src=${fileUrl(e.bezel)} />`)}
  </div>
  ${tags.length > 0 && html`<span class="tag">${tags.join(" · ")}</span>`}`;
}

/**
 * A recording's cursor over it, where the log has it at the playhead: smoothed or not, the cursor
 * macOS showed, a dip and a ring on each click. The export draws it the same way.
 */
function RecordingCursor({ c, box, w }) {
  useStore();
  const track = cursorTrack(c.log, c.smooth ?? 0.5);
  const el = useRef(null);
  const ring = useRef(null);
  const size = w * 0.016 * (c.size ?? 1.4);
  useEffect(() => {
    if (!track || !el.current) return;
    let shown = "";
    const move = (t) => {
      const p = cursorAt(track, t);
      const node = el.current;
      if (!p || !node) return;
      const kind = cursorKindAt(track, t);
      if (kind !== shown) {
        const art = CURSOR_ART[kind] ?? CURSOR_ART.arrow;
        const sc = size / art.box[1];
        node.innerHTML = `<svg viewBox="0 0 ${art.box[0]} ${art.box[1]}" width="${art.box[0] * sc}" height="${size}" style="display:block;overflow:visible;margin:${-art.hot[1] * sc}px 0 0 ${-art.hot[0] * sc}px;filter:drop-shadow(0 ${size * 0.04}px ${size * 0.08}px rgba(0,0,0,.35))">${art.svg}</svg>`;
        shown = kind;
      }
      const click = clickAt(track, t);
      const press = click && click.since >= 0 && click.since < 0.14 ? 0.86 : 1;
      const W = node.parentElement.offsetWidth;
      const H = node.parentElement.offsetHeight;
      node.style.opacity = p.x >= -0.01 && p.x <= 1.01 && p.y >= -0.01 && p.y <= 1.01 ? "1" : "0";
      node.style.transform = `translate(${p.x * W}px, ${p.y * H}px) scale(${press})`;
      const r = ring.current;
      if (r) {
        if (c.ripple !== false && click && click.since >= 0) {
          const k = click.since / 0.5;
          const rs = size * 2.2;
          r.style.opacity = String(Math.max(0, 1 - k));
          r.style.transform = `translate(${click.x * W - rs / 2}px, ${click.y * H - rs / 2}px) scale(${0.45 + k * 0.9})`;
        } else r.style.opacity = "0";
      }
    };
    move(playhead.t);
    return onPlayhead(move);
  }, [track, size, c.ripple]);
  if (!track) return null;
  return html`<div class="rec-cursor" style=${{ ...box, position: "absolute", overflow: "hidden", pointerEvents: "none" }}>
    <div ref=${ring} style=${{ position: "absolute", left: 0, top: 0, width: size * 2.2 + "px", height: size * 2.2 + "px", borderRadius: "50%", border: `${Math.max(1, size * 0.1)}px solid rgba(255,255,255,.95)`, boxShadow: `0 0 ${size * 0.2}px rgba(0,0,0,.25)`, opacity: 0 }}></div>
    <div ref=${el} style=${{ position: "absolute", left: 0, top: 0, transformOrigin: "0 0", willChange: "transform" }}></div>
  </div>`;
}

/**
 * An image block, drawn as the render draws it (render/images.ts imageLook): its corners or app-icon
 * outline, a sticker's white edge and shadows that follow the picture's outline, soft focus, opacity.
 */
function ImageEnt({ e, W, H }) {
  const { scene, layout } = useShot();
  const b = scene.images?.[e.index] ?? {};
  const w = e.width * W;
  const h = e.height * H;
  const short = Math.min(w, h);
  const filters = [];
  if (b.sticker) {
    const t = Math.max(1, short * 0.035);
    filters.push(`drop-shadow(${t}px 0 0 #fff)`, `drop-shadow(-${t}px 0 0 #fff)`, `drop-shadow(0 ${t}px 0 #fff)`, `drop-shadow(0 -${t}px 0 #fff)`);
  }
  if (b.shadow || b.sticker) filters.push(`drop-shadow(0 ${short * 0.03}px ${short * 0.06}px rgba(0,0,0,${b.sticker ? 0.28 : 0.35}))`);
  const cw = layout?.canvas.width || W;
  const soft = !b.blur ? 0 : b.blur <= 0.5 ? b.blur * W : (b.blur * W) / cw;
  if (blurAnimated(e.id, scene)) filters.push(`blur(var(--ablur, ${soft}px))`);
  else if (soft > 0.05) filters.push(`blur(${soft}px)`);
  const corners = b.mask === "icon" ? { borderRadius: "22.4%", cornerShape: "superellipse(1.35)" } : b.mask === "circle" ? { borderRadius: "50%" } : b.radius ? { borderRadius: b.radius * short + "px" } : {};
  const url = pictureUrl(b.src ?? e.src);
  const mask = `url("${url}") 0 0 / 100% 100% no-repeat`;
  return html`<div class="image-body" style=${{ filter: filters.join(" ") || undefined, opacity: b.opacity ?? undefined }}>
    ${b.tint
      ? html`<div class="tinted" style=${{ ...corners, background: b.tint, WebkitMask: mask, mask, transform: b.flip ? "scaleX(-1)" : undefined }}></div>`
      : html`<img draggable=${false} src=${url} style=${{ ...corners, transform: b.flip ? "scaleX(-1)" : undefined }} />`}
  </div>`;
}

/**
 * Apple's art in clay, as the render draws it: one colour cut out by the art's silhouette and shaded
 * by its light and dark; inside the screen's opening the art stays as it is (the island stays black).
 */
function ClayArt({ e, s, bw }) {
  const url = fileUrl(e.bezel);
  const mask = `url("${url}") 0 0 / 100% 100% no-repeat`;
  const pct = (v) => v * 100 + "%";
  const opening = `inset(${pct(s.y)} ${pct(1 - s.x - s.width)} ${pct(1 - s.y - s.height)} ${pct(s.x)} round ${s.radius * bw}px)`;
  return html`<div class="bezel-art clay" style=${{ background: `var(--acolor, ${e.clay})`, WebkitMask: mask, mask }}><img draggable=${false} src=${url} /></div>
    <img class="bezel-art" draggable=${false} src=${url} style=${{ clipPath: opening }} />`;
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
    mark: own.accentMark ?? (e.kind === "text" ? undefined : style.accentMark),
    markColor: own.accentMarkColor ?? (e.kind === "text" ? undefined : style.accentMarkColor),
    base: e.color || "#fff",
  };
  // Outline, underline or strike-through, as the render draws them (sizes are shares of the font size).
  const look = e.kind === "text" ? t : style;
  const fs = e.size * H;
  const dc = look.decorationColor || "currentColor";
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
    lineHeight: look.lineHeight ?? undefined,
    WebkitTextStroke: look.stroke ? `${(look.strokeWidth ?? 0.1) * fs}px ${look.stroke}` : undefined,
    paintOrder: look.stroke ? "stroke fill" : undefined,
  };
  // Lines through or under the words, or a marker behind them: a text's, or the headline's alone
  // (not its subheadline's), as the render draws them.
  const lines = {
    textDecoration: look.decoration === "underline" ? `underline ${dc} ${fs * 0.07}px` : look.decoration === "strike" ? `line-through ${dc} ${fs * 0.07}px` : undefined,
    textUnderlineOffset: look.decoration === "underline" ? fs * 0.12 + "px" : undefined,
    textDecorationSkipInk: look.decoration ? "none" : undefined,
  };
  if (e.kind === "text") Object.assign(base, lines);
  const hl = (nodes) => (look.decoration === "highlight" ? html`<span style=${{ ...markerBand(look.decorationColor || "#ffd60a"), padding: "0 .1em" }}>${nodes}</span>` : nodes);
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
  const finish = (ev, part) => onDone(part, accentFromEdit(ev.target));
  const keys = (ev, part) => {
    ev.stopPropagation();
    if ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === "b") {
      ev.preventDefault();
      toggleAccentIn(ev.currentTarget, accentCss(accent));
    } else if (ev.key === "Escape") {
      ev.preventDefault();
      onDone(null);
    } else if (ev.key === "Enter" && !ev.shiftKey) {
      ev.preventDefault();
      ev.target.blur();
    }
  };
  const editable = (part, text, cls) =>
    editing
      ? html`<div class="editing ${cls}" data-part=${part} contenteditable="true" title="⌘B makes the chosen words accent words" dangerouslySetInnerHTML=${{ __html: accentEditHtml(text, accentCss(accent)) }}
          onPaste=${(ev) => (ev.preventDefault(), document.execCommand("insertText", false, ev.clipboardData.getData("text/plain")))}
          onBlur=${(ev) => finish(ev, part)} onKeyDown=${(ev) => keys(ev, part)}></div>`
      : html`<div class=${cls} data-part=${part} style=${part === "headline" ? lines : undefined}>${part === "subheadline" ? rich(text, accent, by) : hl(rich(text, accent, by))}</div>`;
  if (e.kind === "caption") {
    // Stand-in words are marked on the canvas (never in the export), so nobody ships them by mistake.
    const stand = !editing && !shot.ghost && isPlaceholder(scene.headline);
    return html`<div ref=${ref} class=${stand ? "placeholder" : ""} style=${base}>
      ${stand && html`<span class="ph-tag">Write your headline · double-click</span>`}
      ${(e.text || editing) && editable("headline", e.text ?? "", "h")}
      ${(e.subtext || editing === "subheadline") && html`<div class="s" style=${{ fontSize: (e.subSize || e.size * 0.46) * H + "px", fontFamily: e.subFont, fontWeight: style.subheadlineWeight, lineHeight: 1.25 }}>${editing ? editable("subheadline", e.subtext ?? "", "") : rich(e.subtext, accent, by)}</div>`}
    </div>`;
  }
  const pad = t.padding ?? 0.8;
  const pill = t.background ? { display: "inline-block", background: t.background, padding: `${pad * 0.44}em ${pad}em`, borderRadius: `${t.radius ?? 2}em` } : null;
  return html`<div ref=${ref} style=${base}><span style=${pill}>${editable("text", e.text ?? "", "")}</span></div>`;
}

// ---------------------------------------------------------------------------------------------
// Other shots of a video, drawn read-only over the canvas while the video plays through them

// Each shot's layout from the engine, from the store's cache (by its contents). While a changed
// screen's new layout comes, the row keeps drawing the last one it had for that screen, rather
// than leaving a gap that flashes back.
const asking = new Set();
const lastShown = new Map();
function useShotLayouts(on) {
  const s = useStore();
  const [, bump] = useState(0);
  useEffect(() => {
    if (!on) return;
    let alive = true;
    (s.shots ?? []).forEach((x, i) => {
      if (i === s.shot || !x.scene?.devices) return;
      const key = JSON.stringify(x.scene);
      if (layoutCache.has(key) || asking.has(key)) return;
      asking.add(key);
      api("/api/layout", x.scene)
        .then((l) => {
          rememberLayout(x.scene, l);
          if (alive) bump((n) => n + 1);
        })
        .catch(() => undefined)
        .finally(() => asking.delete(key));
    });
    return () => {
      alive = false;
    };
  }, [on, s.shots, s.shot]);
  return (scene, i) => {
    const l = knownLayout(scene);
    if (l) {
      lastShown.set(i, l);
      return l;
    }
    return lastShown.get(i) ?? null;
  };
}

/** Another shot, as it looks (fitted into the frame): click it to edit it. */
function ShotGhost({ index, scene, layout, W, H, x = 0, inSet = false, quiet = false, dragging = false, dropping = false, onGrab }) {
  const gW0 = layout.canvas.width;
  const gH0 = layout.canvas.height;
  const k = Math.min(W / gW0, H / gH0);
  const gw = gW0 * k;
  const gh = gH0 * k;
  const finished = useFinished(scene, inSet && quiet);
  return html`<div class="ghost-wrap ${inSet ? "set" : ""} ${dragging ? "dragging" : ""} ${dropping ? "drop-over" : ""}" data-shot=${index} style=${{ width: W + "px", height: H + "px", left: x + "px" }} title=${inSet ? `${screenName(index)}: click to edit it, drag to move it` : `Screen ${index + 1}: click to edit it`}
      onPointerDown=${(ev) => {
        if (ev.button !== 0) return;
        ev.stopPropagation();
        if (onGrab) onGrab(ev);
        else goToShot(index);
      }}
      onDblClick=${(ev) => {
        ev.stopPropagation();
        canvasApi.fitScreen?.();
      }}
      onContextMenu=${(ev) => inSet && screenMenu(ev, index)}>
    <${ShotCtx.Provider} value=${{ scene, layout, ghost: true }}>
      <div class="artboard ghost" style=${{ width: gw + "px", height: gh + "px", left: (W - gw) / 2 + "px", top: (H - gh) / 2 + "px" }}>
        <${Backdrop} bg=${scene.background} W=${gW0} H=${gH0} span=${scene.backgroundSpan} />
        ${scene.menuBar && html`<${SceneMenuBar} bar=${scene.menuBar} H=${gh} />`}
        ${layout.entities.map(
          (e) => html`<div key=${e.id} class="ent ent-${e.kind}" data-id=${e.id} style=${place(e, gw, gh)}>
            ${e.kind === "shape" ? html`<${ShapeEnt} e=${e} W=${gw} H=${gh} />` : e.kind === "device" ? html`<${DeviceEnt} e=${e} W=${gw} H=${gh} />` : e.kind === "image" ? html`<${ImageEnt} e=${e} W=${gw} H=${gh} />` : html`<${TextEnt} e=${e} H=${gh} editing=${null} onDone=${() => undefined} />`}
          </div>`,
        )}
        <${FinishedLook} got=${finished} show=${inSet && quiet && finished && gw <= finished.w * 1.3} />
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

/**
 * The design's finished look (its effects, finishes and lighting), drawn by the engine once edits
 * have settled for a moment. The canvas lays it over the design until the next change or drag.
 * `kick` changing asks for it straight away (⌘R).
 */
function useFinished(scene, quiet, kick = 0) {
  const key = useMemo(() => JSON.stringify(scene), [scene]);
  const [got, setGot] = useState(null);
  const last = useRef(kick);
  useEffect(() => {
    const now = kick !== last.current;
    last.current = kick;
    if (!quiet) return;
    let alive = true;
    const t = setTimeout(
      () => finishedLook(scene).then((r) => alive && setGot({ key, src: fileUrl(r.path), w: r.width }), () => undefined),
      now || finishedAsked(key) ? 0 : 900,
    );
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [key, quiet, kick]);
  return got?.key === key ? got : null;
}

/** The finished look over an artboard: it fades in once loaded and goes at once when hidden. */
function FinishedLook({ got, show }) {
  const [loaded, setLoaded] = useState(null);
  if (!got) return null;
  return html`<img class="finished ${show && loaded === got.src ? "on" : ""}" src=${got.src} alt="" draggable=${false} onLoad=${() => setLoaded(got.src)} />`;
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
  // A screen being dragged to another place in the set: which, and the gap it would go into.
  const [reorder, setReorder] = useState(null);
  const [live, setLive] = useState(null); // entity being dragged: {id, e}
  const [guides, setGuides] = useState([]);
  const [editing, setEditing] = useState(null); // {id, part}
  const [space, setSpace] = useState(false);
  const [dropOver, setDropOver] = useState(false);
  const [kick, setKick] = useState(0);
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
  // While the still picker sits at the bottom, the design fits in the room above it.
  // The timeline as tall as it's been dragged (else the usual), with a gap above it.
  const bottom = s.timelineOpen ? Math.max(0, Math.min(s.tlH ?? Math.min(size.h * 0.44, 320), size.h - 150)) + 30 : s.stillPick ? Math.min(size.h * 0.46, 290) : BOTTOM;
  const TOP = s.groups?.length > 1 || (!s.timelineOpen && manyShots()) ? TOP_TABS : TOP_PLAIN;
  // A set of screens sits in a row in Edit: fit the whole row, or just the screen being edited.
  const setMode = !s.timelineOpen && manyShots();
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
  /**
   * Press on a screen of the set (its label, or the screen itself if it isn't the one being edited):
   * a click opens it; a drag moves it, into the gap nearest the pointer.
   */
  const dragScreen = (ev, i) => {
    if (ev.button !== 0) return;
    ev.stopPropagation();
    const [x0, y0] = [ev.clientX, ev.clientY];
    const step = W + G;
    let to = null;
    const move = (m) => {
      if (to === null && Math.hypot(m.clientX - x0, m.clientY - y0) < 5) return;
      // The gaps are at k × (screen + gap) from screen 1's left, less half a gap.
      const fromFirst = m.clientX - world.current.getBoundingClientRect().left + S.shot * step;
      to = Math.max(0, Math.min(S.shots.length, Math.round((fromFirst + G / 2) / step)));
      setReorder({ from: i, to });
    };
    const up = () => {
      removeEventListener("pointermove", move);
      removeEventListener("pointerup", up);
      setReorder(null);
      if (to === null) return goToShot(i);
      const dest = to > i ? to - 1 : to;
      if (dest !== i) moveShotTo(i, dest);
    };
    addEventListener("pointermove", move);
    addEventListener("pointerup", up);
  };
  canvasApi.zoomBy = (f) => zoomAt(cam.current.scale * f);
  canvasApi.zoomTo = (z) => zoomAt(z);
  canvasApi.editText = (id, part) => setEditing({ id, part: part ?? (id === "caption" ? "headline" : "text") });
  canvasApi.scale = scale;
  canvasApi.finishNow = () => setKick((n) => n + 1);

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
      const l = layoutOf(x.scene, i);
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
    // A neighbour's device carrying on into this screen: edit it on its own screen.
    if (id?.startsWith("spill-")) {
      ev.preventDefault();
      const from = S.scene.spill?.[Number(id.split("-")[1]) - 1]?.spillOf;
      if (from) {
        goToShot(from.shot);
        set({ selected: `device-${from.device + 1}` });
      }
      return;
    }
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
    // A set's seams beside this screen, for a device to sit across: dragged near one, it's pulled to
    // sit halfway over it (⌥ places it freely). Not for a device kept inside its own screen.
    const seams =
      e0.kind === "device" && S.shots && S.scene.devices[e0.index]?.span !== false
        ? [S.shot > 0 && { x: 0, a: S.shot, b: S.shot + 1 }, S.shot < S.shots.length - 1 && { x: 1, a: S.shot + 1, b: S.shot + 2 }].filter(Boolean)
        : [];
    const seamPull = Math.max(16 / W, 0.035);
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
          const seam = seams.find((sm) => Math.abs(e0.x + fx - sm.x) < seamPull);
          if (seam) {
            fx = seam.x - e0.x;
            g.push({ v: seam.x, seam });
          }
          const sx = seam ? null : snap1([box0.l + fx, (box0.l + box0.r) / 2 + fx, box0.r + fx], targets.xs, tolX);
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
        } else if (cur.kind === "device" || cur.kind === "image") {
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
        // Let go mostly over the screen beside it: it moves there (not while setting an animation).
        if (mode === "move" && cur.kind === "device" && !S.timelineOpen) carryDeviceOver(cur.index);
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
    } else if (id.startsWith("image-")) {
      set({ selected: id, replacingImage: id, leftTab: "images", leftOpen: true });
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
    const files = ev.dataTransfer.types.includes("Files");
    if (!ev.dataTransfer.types.includes("application/x-screenshot") && !files) return;
    // Over another screen of the set, that screen lights up: the drop goes there.
    const ghost = ev.target.closest?.(".ghost-wrap.set");
    if (files) return setDropOver(ghost ? Number(ghost.dataset.shot) : false);
    ev.preventDefault();
    ev.dataTransfer.dropEffect = "copy";
    setDropOver(ghost ? Number(ghost.dataset.shot) : true);
  };
  const onDrop = (ev) => {
    const p = ev.dataTransfer.getData("application/x-screenshot");
    setDropOver(false);
    if (!p) return;
    ev.preventDefault();
    ev.stopPropagation();
    // On another screen of the set: open it, then place it there as on the one being edited.
    const ghost = ev.target.closest?.(".ghost-wrap.set");
    if (ghost) {
      const board = ghost.querySelector(".artboard").getBoundingClientRect();
      const on = deviceAtPoint(ghost, ev.clientX, ev.clientY);
      goToShot(Number(ghost.dataset.shot));
      return placeShot(p, on, { x: r4((ev.clientX - board.left) / board.width), y: r4((ev.clientY - board.top) / board.height) });
    }
    const a = art.current?.getBoundingClientRect();
    placeShot(p, ev.target.closest?.(".ent-device")?.dataset.id, a && { x: r4((ev.clientX - a.left) / a.width), y: r4((ev.clientY - a.top) / a.height) });
  };
  /** A screenshot dropped on the screen being edited: onto the device it was dropped on, else a new device where it landed. */
  const placeShot = (p, target, at) => {
    if (target && S.scene.devices[Number(target.split("-")[1]) - 1]) {
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
    if (at && S.scene.devices.length) addDevice(p, at);
    else addDevice(p);
  };

  // ------------------------------------------------------------------ render

  // Quiet: nothing being dragged, typed, animated or redone by AI, so the finished look can show.
  // A design with a recording in it keeps playing on the canvas instead.
  const quiet = Boolean(layout) && hasDesign(s.scene) && !s.scene.devices.some((d) => d.video) && !s.timelineOpen && !live && !editing && !s.stillPick && !s.ai.busy && !s.designing && !s.dropping && !dropOver;
  const finished = useFinished(s.scene, quiet, kick);
  // Zoomed in past the drawing's own size, the canvas itself is sharper.
  const finishedShows = quiet && finished && W <= finished.w * 1.3;

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
        const over = e.target.closest?.(".ghost-wrap") ? null : (e.target.closest?.(".ent")?.dataset.id ?? null);
        const id = over?.startsWith("spill-") ? null : over;
        if (id !== S.hover) set({ hover: id });
      }}
      onPointerLeave=${() => S.hover && set({ hover: null })}
      onDragOver=${onDragOver} onDragLeave=${() => setDropOver(false)} onDrop=${onDrop}>
    <div class="dots" style=${{ "--dot": 22 * Math.max(0.5, Math.min(2, scale / fitS)) + "px", "--dot-x": ox + "px", "--dot-y": oy + "px" }}></div>
    ${layout &&
    html`<div class="world" ref=${world} style=${{ transform: `translate(${ox}px, ${oy}px)` }}>
      ${multi && html`<div class="join-matte" style=${{ width: W + "px", height: H + "px" }}></div>`}
      ${multi && [...ghosts.entries()].map(([i, g]) => html`<${ShotGhost} key=${`g${i}`} index=${i} scene=${g.scene} layout=${g.layout} W=${W} H=${H} />`)}
      ${setMode && [...ghosts.entries()].map(([i, g]) => html`<${ShotGhost} key=${`s${i}`} index=${i} scene=${g.scene} layout=${g.layout} W=${W} H=${H} x=${(i - s.shot) * (W + G)} inSet=${true} quiet=${quiet && !reorder} dragging=${reorder?.from === i} dropping=${dropOver === i} onGrab=${(ev) => dragScreen(ev, i)} />`)}
      ${setMode && s.shots.map((x, i) => html`<${SetLabel} key=${`l${i}`} i=${i} x=${(i - s.shot) * (W + G)} w=${W} on=${i === s.shot} dragging=${reorder?.from === i} renaming=${renaming === i} onDone=${() => setRenaming(null)} onGrab=${(ev) => dragScreen(ev, i)} />`)}
      ${setMode && reorder && html`<div class="set-drop" style=${{ left: (reorder.to - s.shot) * (W + G) - G / 2 + "px", height: H + "px" }}></div>`}
      ${setMode && html`<button class="set-add" style=${{ left: (s.shots.length - s.shot) * (W + G) + "px", width: W * SET_ADD + "px", height: H + "px" }} title="Add a screen at the end: a copy of the last one"
        onPointerDown=${(e) => e.stopPropagation()} onClick=${() => addShot("copy", { at: s.shots.length, copyOf: s.shots.length - 1 })}><${Icon} n="plus" s=${Math.max(16, Math.min(28, W / 8))} /><span>Add screen</span></button>`}
      ${multi && html`<div class="frame-clip" style=${{ width: W + "px", height: H + "px" }}></div>`}
      <div class="artboard ${setMode ? "in-set" : ""} ${dropOver === true ? "drop-over" : ""} ${s.ai.busy || s.designing ? "ai-working" : ""}" ref=${art} style=${{ width: W + "px", height: H + "px", "--set-gap": G + "px" }}>
        <${Backdrop} bg=${s.scene.background} W=${W0} H=${H0} span=${s.scene.backgroundSpan} />
        ${s.scene.menuBar && html`<${SceneMenuBar} bar=${s.scene.menuBar} H=${H} />`}
        ${entities.map(
          (e) => html`<div key=${e.id} class="ent ent-${e.kind} ${e.spill ? "spill" : ""} ${s.pulse.includes(e.id) ? "pulse" : ""}" data-id=${e.id} style=${place(e, W, H)}
              title=${e.spill ? `Carries on from screen ${(s.scene.spill?.[e.index]?.spillOf?.shot ?? 0) + 1}: click to edit it there` : undefined}>
            ${e.kind === "shape"
              ? html`<${ShapeEnt} e=${e} W=${W} H=${H} />`
              : e.kind === "device"
              ? html`<${DeviceEnt} e=${e} W=${W} H=${H} />`
              : e.kind === "image"
              ? html`<${ImageEnt} e=${e} W=${W} H=${H} />`
              : html`<${TextEnt} e=${e} H=${H} editing=${editing?.id === e.id ? editing.part : null} onDone=${finishEdit} />`}
          </div>`,
        )}
        <${FinishedLook} got=${finished} show=${finishedShows} />
        <div class="clip"></div>
        ${!s.scene.devices.length &&
        (bare(s.scene)
          ? html`<div class="empty-screen" onPointerDown=${(e) => e.stopPropagation()}>
              <b>No screenshot on this screen</b><span>Drop one here, or choose one. Or keep it to words and pictures: add a headline, stickers or illustrations.</span>
              <button class="btn sm" onClick=${() => set({ leftTab: "captures", leftOpen: true })}><${Icon} n="upload" s=${13} />Choose a screenshot…</button>
            </div>`
          : html`<button class="add-shot-pill" title="This screen has no screenshot, and that's fine: it exports as it is. Click to add one." onPointerDown=${(e) => e.stopPropagation()} onClick=${() => set({ leftTab: "captures", leftOpen: true })}><${Icon} n="plus" s=${12} />Add a screenshot</button>`)}
        ${s.timelineOpen && html`<${Viewfinder} /><${MotionPathOverlay} />`}
        ${guides.map((g) =>
          g.seam
            ? html`<div class="seam-glow" style=${{ left: g.v * W + "px" }}></div><div class="seam-label" style=${{ left: g.v * W + "px" }}>Across ${g.seam.a} & ${g.seam.b}</div>`
            : g.v !== undefined
              ? html`<div class="guide v" style=${{ left: g.v * W + "px", top: -4000 + "px", height: 8000 + "px" }}></div>`
              : html`<div class="guide h" style=${{ top: g.h * H + "px", left: -4000 + "px", width: 8000 + "px" }}></div>`,
        )}
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
    ${layout && !s.timelineOpen && s.groups?.length > 1 && html`<${SizeSwitch} />`}
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
const SET_GAP = STORE_GAP;
const SET_ADD = 0.42;

/**
 * The device under a point in a screen of the set, by where each is drawn (another screen doesn't take
 * the pointer itself): the topmost one, as an entity id ("device-2").
 */
export function deviceAtPoint(root, x, y) {
  const hit = [...root.querySelectorAll(".ent-device")].reverse().find((el) => {
    const r = el.getBoundingClientRect();
    return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
  });
  return hit?.dataset.id;
}

/** A screen's name above it in the set: "01 · Introduction". Double-click to rename. */
function SetLabel({ i, x, w, on, renaming, onDone, onGrab, dragging = false }) {
  const name = screenName(i);
  const done = (v) => {
    onDone();
    if (v === undefined) return;
    updateShot(i, { name: v.trim() || undefined });
  };
  return html`<div class="set-label ${on ? "on" : ""} ${dragging ? "dragging" : ""}" style=${{ left: x + "px", width: w + "px" }} title="Click to edit this screen, drag to move it, double-click to rename it"
      onPointerDown=${(e) => {
        e.stopPropagation();
        if (!renaming && e.button === 0) onGrab(e);
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
  if (e.kind === "device" || e.kind === "shape" || e.kind === "image") {
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
  if (mode === "resize") return e.kind === "device" || e.kind === "image" ? `H ${Math.round(e.height * 1000) / 10}%  ·  ${Math.round(e.width * W0)}×${Math.round(e.height * H0)}` : `${Math.round(e.size * H0)} px`;
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
    } else if (e.kind === "image") {
      const b = d.images?.[e.index];
      if (!b) return;
      // A block given both sides keeps its shape as it's scaled; otherwise its height sets its size.
      Object.assign(b, { x: r4(e.x), y: r4(e.y), height: r4(clamp(e.height, 0.005, 5)), rotate: Math.round((e.rotate || 0) * 2) / 2 });
      if (b.width !== undefined) b.width = r4(e.width);
      if (!b.rotate) delete b.rotate;
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

/** Shapes that carry words of their own (laurels, ratings, badges): a colour and their words' colour. */
export { commit as commitEntity, entityLabel };
