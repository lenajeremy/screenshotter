/**
 * What runs inside a website being brought onto a board: it reads the page as it is drawn (every
 * element's final styles, after the site's own CSS and scripts) and returns it as a tree of plain
 * elements with inline styles, which a board takes as layers. It's a string, so nothing a bundler
 * adds to functions follows it into the page.
 *
 * What it keeps: the layout (flex, grid, block, positions), every box's paint (fills, gradients,
 * borders, radii, shadows, filters, transforms, masks), the words with their type, pictures,
 * vectors (with their styles written onto them), videos, ::before/::after, and fixed headers where
 * they sit at the top. Sizes become pixels at the width it was read at; a box that only fits its
 * content keeps no height. What it can't keep as layers (a <canvas>, an iframe, a form control's
 * native look) is marked for a picture of itself.
 */
/**
 * Before the page is read: down the page and back, so pictures that wait to be scrolled to load and
 * reveal-once animations play. Then, for what's still hidden below the first screen (animations that
 * play backwards when scrolled up, ones tied to the scroll), a slower pass that waits at each step
 * until things stop moving and keeps how each looks when it's in view. A pinned section is kept at
 * one moment as a whole (the one showing the most), so states that take turns never overlap. The
 * chosen looks are left in window.__ssSettled for SNAPSHOT to apply at the top.
 */
export const SETTLE = String.raw`(async function (opts) {
  var css = document.createElement("style");
  css.textContent = "html, body { scroll-behavior: auto !important; }";
  (document.head || document.documentElement).appendChild(css);
  var vh = innerHeight, vw = innerWidth, cap = opts.maxHeight || 16000;
  var wait = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
  var lenis = window.lenis || window.__lenis;
  var go = function (y) {
    window.scrollTo({ top: y, left: 0, behavior: "instant" });
    if (lenis && typeof lenis.scrollTo === "function") { try { lenis.scrollTo(y, { immediate: true, force: true }); } catch (e) {} }
  };
  var docH = function () { return Math.min(Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0), cap); };
  async function toTop() { for (var i = 0, still = 0; i < 40 && still < 4; i++) { go(0); await wait(100); still = window.scrollY === 0 ? still + 1 : 0; } }
  var moved = false;
  for (var y = 0; y < docH(); y += vh * 0.75) { go(y); await wait(140); if (window.scrollY > 0) moved = true; }
  go(docH()); await wait(300);
  await toTop(); await wait(400);
  window.__ssSettled = []; window.__ssScrolled = moved;
  if (!moved || !document.body) return { scrolled: moved, groups: 0 };

  function inside(r, b) {
    var w = Math.max(0, Math.min(r.right, b.right) - Math.max(r.left, b.left)), h = Math.max(0, Math.min(r.bottom, b.bottom) - Math.max(r.top, b.top));
    return r.width * r.height > 0 ? (w * h) / (r.width * r.height) : 0;
  }
  var screen = { left: 0, right: vw, top: -1e9, bottom: 1e9 };
  function look(el) { var cs = getComputedStyle(el); return { opacity: cs.opacity, visibility: cs.visibility, transform: cs.transform, translate: cs.translate, scale: cs.scale, rotate: cs.rotate, filter: cs.filter }; }
  function score(el, st, clipped) {
    if (st.visibility === "hidden") return 0;
    var r = el.getBoundingClientRect(), s = parseFloat(st.opacity) * inside(r, screen);
    if (clipped && el.parentElement) s *= inside(r, el.parentElement.getBoundingClientRect());
    return s;
  }
  // The pinned section an element is in, if any: a sticky box, or what GSAP pins in its spacer.
  function pinOf(el) {
    for (var a = el.parentElement; a && a !== document.body; a = a.parentElement) {
      if (getComputedStyle(a).position === "sticky") return a;
      if (a.parentElement && a.parentElement.classList.contains("pin-spacer")) return a;
    }
    return null;
  }
  var SVG_NS = "http://www.w3.org/2000/svg";
  var all = document.body.getElementsByTagName("*"), groups = [], byPin = new Map();
  for (var i = 0; i < all.length && i < 25000; i++) {
    var el = all[i];
    if (el.namespaceURI === SVG_NS && el.tagName.toLowerCase() !== "svg") continue;
    var cs = getComputedStyle(el);
    if (cs.display === "none" || cs.position === "fixed") continue;
    var r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) continue;
    // Seen at the top already (the first screen): kept as it is there.
    if (r.top < vh * 0.75) continue;
    var faded = parseFloat(cs.opacity) < 0.98 || cs.visibility === "hidden", clipped = false;
    // Words that slide up into view from behind their line's edge (a mask reveal). Only upwards: what
    // slides sideways is a marquee or a carousel, whose parts take turns.
    if (!faded && cs.transform !== "none" && el.parentElement && getComputedStyle(el.parentElement).overflow !== "visible") {
      var mt = new DOMMatrixReadOnly(cs.transform);
      clipped = Math.abs(mt.f) > Math.abs(mt.e) && inside(r, el.parentElement.getBoundingClientRect()) < 0.5;
    }
    if (!faded && !clipped) continue;
    var pin = pinOf(el);
    if (pin) {
      if (byPin.has(pin)) continue;
      // The whole section at one moment: every part of it, shown or not.
      var parts = [], inner = pin.getElementsByTagName("*");
      for (var j = 0; j < inner.length && parts.length < 500; j++) if (!(inner[j].namespaceURI === SVG_NS && inner[j].tagName.toLowerCase() !== "svg")) parts.push({ el: inner[j], clipped: false });
      var g = { root: pin, parts: parts, pinned: true };
      byPin.set(pin, g); groups.push(g);
      continue;
    }
    // One of several that take turns in the same place (slides, tabs): left as it is.
    var sibs = el.parentElement ? el.parentElement.children : [], alt = false;
    for (var k = 0; k < sibs.length && !alt; k++) {
      var sb = sibs[k];
      if (sb === el) continue;
      var scs = getComputedStyle(sb);
      if (scs.display === "none" || parseFloat(scs.opacity) < 0.5 || scs.visibility === "hidden") continue;
      if (inside(r, sb.getBoundingClientRect()) > 0.5) alt = true;
    }
    if (alt) continue;
    groups.push({ root: el, parts: [{ el: el, clipped: clipped }], pinned: false });
  }
  if (!groups.length) return { scrolled: true, groups: 0 };
  groups.forEach(function (g) { g.top = 0; g.parts.forEach(function (p) { g.top += score(p.el, look(p.el), p.clipped); }); g.best = null; g.last = null; });

  var spent = 0, budget = opts.budget || 9000, end = docH();
  for (var y2 = vh * 0.4; y2 <= end + vh * 0.6; y2 += vh * 0.6) {
    go(y2); await wait(160);
    for (var round = 0; round < 7; round++) {
      var moving = false, any = false;
      for (var gi = 0; gi < groups.length; gi++) {
        var g2 = groups[gi], rr = g2.root.getBoundingClientRect();
        if (rr.bottom < vh * 0.08 || rr.top > vh * 0.92) continue;
        any = true;
        var looks = [], total = 0, key = "", shown = [], clean = true;
        for (var pi = 0; pi < g2.parts.length; pi++) {
          var lk = look(g2.parts[pi].el), sc = score(g2.parts[pi].el, lk, g2.parts[pi].clipped), op = parseFloat(lk.opacity);
          looks.push(lk);
          total += sc;
          shown.push(sc >= 0.5);
          if (op > 0.1 && op < 0.9) clean = false;
          key += lk.opacity + lk.transform + lk.translate + lk.scale + lk.rotate + lk.filter + lk.visibility;
        }
        if (g2.last !== null && g2.last !== key) moving = true;
        if (g2.last === null) moving = true;
        g2.last = key;
        // A pinned section's moments are taken once the step has settled (below), never halfway through a fade.
        if (g2.pinned) g2.pending = { total: total, looks: looks, key: key, shown: shown, clean: clean };
        else if (!g2.best || total > g2.best.total + 0.02 * g2.parts.length) g2.best = { total: total, looks: looks };
      }
      if (!any || !moving || spent >= budget) break;
      await wait(180); spent += 180;
    }
    groups.forEach(function (g6) {
      if (!g6.pending) return;
      if (!g6.moments) g6.moments = [];
      if (!g6.moments.length || g6.moments[g6.moments.length - 1].key !== g6.pending.key) g6.moments.push(g6.pending);
      g6.pending = null;
    });
    groups.forEach(function (g3) { var b = g3.root.getBoundingClientRect(); if (b.bottom < vh * 0.08 || b.top > vh * 0.92) g3.last = null; });
    if (y2 > docH() + vh) break;
  }
  await toTop(); await wait(300);
  // A pinned section, at one moment with nothing caught halfway through a fade. When it builds up as
  // it's scrolled (what shows early still shows later), its fullest moment; when its parts take turns
  // (slides, a sequence), its first.
  groups.forEach(function (g5) {
    if (!g5.pinned || !g5.moments || !g5.moments.length) return;
    var pool = g5.moments.filter(function (m) { return m.clean; });
    if (!pool.length) pool = g5.moments;
    var full = pool[0];
    pool.forEach(function (m) { if (m.total > full.total + 0.01) full = m; });
    var first = pool[0];
    var builds = first.shown.every(function (v, i) { return !v || full.shown[i]; });
    g5.best = builds ? full : first;
  });
  groups.forEach(function (g4) {
    if (!g4.best || (!g4.pinned && g4.best.total < g4.top + 0.05)) return;
    for (var q = 0; q < g4.parts.length; q++) window.__ssSettled.push([g4.parts[q].el, g4.best.looks[q]]);
  });
  return { scrolled: true, groups: groups.length, settled: window.__ssSettled.length, waited: spent };
})`;

export const SNAPSHOT = String.raw`(function (opts) {
  // As each part looks when it's scrolled to (see SETTLE), with transitions that are halfway done finished.
  (window.__ssSettled || []).forEach(function (s) {
    var el = s[0], lk = s[1];
    if (!el.isConnected || !el.style) return;
    el.style.setProperty("transition", "none", "important");
    el.style.setProperty("opacity", lk.opacity, "important");
    el.style.setProperty("visibility", lk.visibility, "important");
    el.style.setProperty("transform", lk.transform, "important");
    ["translate", "scale", "rotate"].forEach(function (k) { if (lk[k] !== undefined) el.style.setProperty(k, lk[k], "important"); });
    el.style.setProperty("filter", lk.filter, "important");
  });
  try {
    document.getAnimations().forEach(function (a) {
      var t = a.effect && a.effect.getComputedTiming ? a.effect.getComputedTiming() : null;
      if (a.playState === "running" && t && typeof t.endTime === "number" && isFinite(t.endTime) && t.endTime < 6000) a.finish();
    });
  } catch (e) {}
  // A pinned section's runway (a tall box a sticky child scrolls through, GSAP's pin-spacer) is only
  // room for an animation to play in: it goes, and what follows moves up to meet the section.
  (function () {
    var els = document.body ? document.body.getElementsByTagName("*") : [], runways = [];
    for (var i = 0; i < els.length && i < 25000; i++) {
      var e = els[i], cl = e.classList;
      if (cl && (cl.contains("pin-spacer") || cl.contains("scrollmagic-pin-spacer"))) runways.push([e, true]);
      else if (getComputedStyle(e).position === "sticky" && e.parentElement && e.parentElement !== document.body) runways.push([e.parentElement, false]);
    }
    runways.forEach(function (rw) {
      var p = rw[0], before = p.getBoundingClientRect().height, old = p.getAttribute("style");
      p.style.setProperty("height", "auto", "important");
      if (rw[1]) { p.style.setProperty("padding-top", "0px", "important"); p.style.setProperty("padding-bottom", "0px", "important"); }
      if (before - p.getBoundingClientRect().height < window.innerHeight * 0.3) { if (old === null) p.removeAttribute("style"); else p.setAttribute("style", old); }
    });
  })();

  var MAX = opts.maxNodes || 6000;
  var CUT = opts.maxHeight || 16000;
  var VIEW_H = window.innerHeight;
  var W = document.documentElement.clientWidth;
  var docH = Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0);
  var limitY = opts.fullPage ? Math.min(docH, CUT) : VIEW_H;
  var count = 0, warnings = [], shots = [], families = {}, cutOff = false;

  var INHERITED = ["color", "font-family", "font-size", "font-weight", "font-style", "font-stretch", "line-height", "letter-spacing", "word-spacing",
    "text-align", "text-transform", "text-indent", "white-space", "text-shadow", "font-variant-caps", "font-variant-numeric", "font-feature-settings",
    "font-variation-settings", "overflow-wrap", "word-break", "hyphens", "text-wrap-mode", "text-wrap-style", "list-style-type", "list-style-position", "direction",
    "-webkit-text-stroke-width", "-webkit-text-stroke-color", "-webkit-text-fill-color"];
  var BOX = ["display", "position", "top", "right", "bottom", "left", "z-index", "float", "clear", "box-sizing", "min-width", "max-width", "max-height",
    "margin-top", "margin-right", "margin-bottom", "margin-left", "padding-top", "padding-right", "padding-bottom", "padding-left",
    "border-top-width", "border-right-width", "border-bottom-width", "border-left-width", "border-top-style", "border-right-style", "border-bottom-style",
    "border-left-style", "border-top-color", "border-right-color", "border-bottom-color", "border-left-color",
    "border-top-left-radius", "border-top-right-radius", "border-bottom-right-radius", "border-bottom-left-radius",
    "background-color", "background-image", "background-size", "background-position", "background-repeat", "background-clip", "background-origin",
    "box-shadow", "opacity", "overflow-x", "overflow-y", "flex-direction", "flex-wrap", "justify-content", "align-items", "align-content", "align-self",
    "justify-items", "justify-self", "row-gap", "column-gap", "flex-grow", "flex-shrink", "flex-basis", "order",
    "grid-template-columns", "grid-template-rows", "grid-template-areas", "grid-auto-flow", "grid-auto-rows", "grid-auto-columns",
    "grid-column-start", "grid-column-end", "grid-row-start", "grid-row-end",
    "transform", "translate", "scale", "rotate", "transform-origin", "filter", "backdrop-filter", "mix-blend-mode", "isolation", "object-fit", "object-position", "aspect-ratio",
    "vertical-align", "text-decoration-line", "text-decoration-color", "text-decoration-style", "text-decoration-thickness", "text-underline-offset",
    "text-overflow", "clip-path", "mask-image", "-webkit-mask-image", "mask-size", "-webkit-mask-size", "mask-position", "-webkit-mask-position",
    "mask-repeat", "-webkit-mask-repeat", "outline-width", "outline-style", "outline-color", "outline-offset", "-webkit-line-clamp", "-webkit-box-orient",
    "border-collapse", "border-spacing", "column-count", "visibility"];
  var SVG_PROPS = ["fill", "fill-opacity", "fill-rule", "stroke", "stroke-width", "stroke-opacity", "stroke-linecap", "stroke-linejoin", "stroke-dasharray",
    "stroke-dashoffset", "stroke-miterlimit", "opacity", "stop-color", "stop-opacity", "font-family", "font-size", "font-weight", "text-anchor", "dominant-baseline", "visibility"];
  var SKIP = { SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEMPLATE: 1, META: 1, LINK: 1, HEAD: 1, TITLE: 1, BASE: 1, SOURCE: 1, TRACK: 1, PARAM: 1, MAP: 1, AREA: 1, DATALIST: 1, OPTION: 1 };
  var PICTURED = { CANVAS: 1, IFRAME: 1, EMBED: 1, OBJECT: 1, METER: 1, PROGRESS: 1 };

  // The browser's own styles for each kind of element we write, from a clean page: what to leave out.
  var frame = document.createElement("iframe");
  frame.style.cssText = "position:absolute;left:-9999px;top:0;width:10px;height:10px;border:0;visibility:hidden";
  document.documentElement.appendChild(frame);
  var fdoc = frame.contentDocument;
  fdoc.open();
  fdoc.write("<!doctype html><html><head></head><body></body></html>");
  fdoc.close();
  var defaults = {};
  function defaultsFor(tag) {
    if (defaults[tag]) return defaults[tag];
    var el = fdoc.createElement(tag);
    fdoc.body.appendChild(el);
    var cs = fdoc.defaultView.getComputedStyle(el), o = {};
    for (var i = 0; i < BOX.length; i++) o[BOX[i]] = cs.getPropertyValue(BOX[i]);
    for (var j = 0; j < INHERITED.length; j++) o[INHERITED[j]] = cs.getPropertyValue(INHERITED[j]);
    el.remove();
    return (defaults[tag] = o);
  }

  function px(v) { var n = parseFloat(v); return isFinite(n) ? n : 0; }
  function r1(n) { return Math.round(n * 100) / 100; }
  // Sizes round up: a box a hair narrower than its words would wrap them.
  function up(n) { return Math.ceil(n * 100 - 0.001) / 100; }
  var measured = 0;
  /** As wide as its content, with nothing setting its width: it can go without one, and fit its words whatever the type does. */
  function fitsContent(el, rect) {
    if (measured++ > 900) return false;
    var s = el.style, keep = [s.getPropertyValue("width"), s.getPropertyPriority("width"), s.getPropertyValue("max-width"), s.getPropertyPriority("max-width"), s.getPropertyValue("flex-basis"), s.getPropertyPriority("flex-basis")];
    s.setProperty("width", "max-content", "important");
    s.setProperty("max-width", "none", "important");
    s.setProperty("flex-basis", "auto", "important");
    var w = el.getBoundingClientRect().width;
    s.setProperty("width", keep[0], keep[1]);
    s.setProperty("max-width", keep[2], keep[3]);
    s.setProperty("flex-basis", keep[4], keep[5]);
    return Math.abs(w - rect.width) < 1;
  }
  function abs(u) { try { return new URL(u, document.baseURI).href; } catch (e) { return u; } }
  function inlineLevel(d) { return d.indexOf("inline") === 0 || d === "ruby" || d === "contents"; }
  function noteFamily(ff) { var first = (ff || "").split(",")[0].trim().replace(/^["']|["']$/g, ""); if (first) families[first.toLowerCase()] = first; }
  // "Mmx1Wq_navItem" is a nav item: bits with letters and digits mixed are a build's hashes, not names.
  function pretty(s) {
    var words = String(s).split(/[-_\s]+/).filter(function (w) { return w && !(/\d/.test(w) && /[a-z]/i.test(w)) && w.length < 24; });
    s = words.join(" ").replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase().trim();
    return s ? s.charAt(0).toUpperCase() + s.slice(1, 48) : "";
  }
  var NOISE = /^(css|sc|jsx|svelte|astro|framer|tw|chakra|mui|ant|v)-|__|--|[0-9]{3,}|^_|^(flex|grid|block|inline|hidden|relative|absolute|fixed|sticky|w-|h-|p[xytrbl]?-|m[xytrbl]?-|text-|bg-|items-|justify-|content-|self-|place-|gap-|rounded|border|shadow|font-|leading-|tracking-|max-|min-|overflow|z-|top-|left-|right-|bottom-|inset|space-|col-|row-|order-|opacity|transition|duration|ease|transform|translate|scale|rotate|cursor|select|pointer|container|mx-|my-|sm:|md:|lg:|xl:|2xl:|hover:|group|peer|dark:|sr-only|visible|invisible|truncate|uppercase|lowercase|capitalize|italic|underline|antialiased|isolate|object-|aspect-|fill-|stroke-|ring|outline|decoration|whitespace|break-|align-|list-|from-|via-|to-)/;
  var NAMES = { HEADER: "Header", NAV: "Navigation", MAIN: "Main", FOOTER: "Footer", SECTION: "Section", ARTICLE: "Article", ASIDE: "Aside", FORM: "Form",
    BUTTON: "Button", UL: "List", OL: "List", LI: "Item", A: "Link", FIGURE: "Figure", TABLE: "Table", BLOCKQUOTE: "Quote" };
  function nameOf(el) {
    var aria = el.getAttribute("aria-label");
    if (aria) return pretty(aria);
    if (el.tagName === "IMG") return el.alt ? "Image: " + el.alt.slice(0, 40) : "Image";
    var id = el.id && !/[0-9]{3,}|^[a-f0-9-]{10,}$|^:/i.test(el.id) ? el.id : "";
    var cls = "";
    for (var i = 0; i < el.classList.length; i++) { var c = el.classList[i]; if (c.length > 2 && c.length < 40 && !NOISE.test(c)) { cls = c; break; } }
    var base = NAMES[el.tagName] || "";
    var pid = id ? pretty(id) : "", pcls = cls ? pretty(cls) : "";
    if (pid) return pid;
    if (base && pcls && pcls.toLowerCase() !== base.toLowerCase()) return base + " · " + pcls;
    return base || pcls;
  }

  // Positioned holders, for fixed elements moved into the page: their top left in the document.
  function docRect(el) { var r = el.getBoundingClientRect(); return { x: r.left + scrollX, y: r.top + scrollY, w: r.width, h: r.height }; }

  function styleOf(el, cs, parentCs, tag, pseudo) {
    var d = defaultsFor(tag), out = {};
    for (var i = 0; i < INHERITED.length; i++) {
      var p = INHERITED[i], v = cs.getPropertyValue(p);
      if (v !== (parentCs ? parentCs.getPropertyValue(p) : d[p])) out[p] = v;
    }
    for (var j = 0; j < BOX.length; j++) {
      var q = BOX[j], w = cs.getPropertyValue(q);
      if (w !== d[q]) out[q] = w;
    }
    // Lines that aren't drawn need no colour or style; nor do outlines, decorations or clamps that aren't there.
    ["top", "right", "bottom", "left"].forEach(function (s) {
      if (px(cs.getPropertyValue("border-" + s + "-width")) === 0 || cs.getPropertyValue("border-" + s + "-style") === "none") {
        delete out["border-" + s + "-width"]; delete out["border-" + s + "-style"]; delete out["border-" + s + "-color"];
      }
    });
    if (cs.getPropertyValue("outline-style") === "none") { delete out["outline-width"]; delete out["outline-color"]; delete out["outline-style"]; delete out["outline-offset"]; }
    if (cs.getPropertyValue("text-decoration-line") === "none") { delete out["text-decoration-color"]; delete out["text-decoration-style"]; delete out["text-decoration-thickness"]; delete out["text-underline-offset"]; }
    if (cs.getPropertyValue("-webkit-line-clamp") === "none") delete out["-webkit-box-orient"];
    var pos = cs.getPropertyValue("position");
    if (pos === "static") { delete out.top; delete out.right; delete out.bottom; delete out.left; delete out["z-index"]; }
    if (pos === "sticky") { out.position = "relative"; delete out.top; delete out.right; delete out.bottom; delete out.left; }
    if (pos === "relative") ["top", "right", "bottom", "left"].forEach(function (s) { if (px(out[s]) === 0) delete out[s]; });
    if (cs.getPropertyValue("display").indexOf("flex") < 0 && cs.getPropertyValue("display").indexOf("grid") < 0) {
      ["flex-direction", "flex-wrap", "justify-content", "align-items", "align-content", "justify-items", "row-gap", "column-gap", "grid-template-columns", "grid-template-rows", "grid-template-areas", "grid-auto-flow", "grid-auto-rows", "grid-auto-columns"].forEach(function (k) { delete out[k]; });
    }
    if (out["font-family"]) noteFamily(out["font-family"]);
    return out;
  }

  /** Width and height: pixels where the box has its own size; nothing where it fills its holder or fits its content. */
  function sizeOf(el, cs, style, rect, parentCs, replaced) {
    var disp = cs.getPropertyValue("display"), pos = cs.getPropertyValue("position");
    var w = rect.width, h = rect.height;
    if (disp === "inline" && !replaced) return;
    var out = pos === "absolute" || pos === "fixed";
    var pd = parentCs ? parentCs.getPropertyValue("display") : "block";
    var inFlex = pd.indexOf("flex") >= 0 || pd.indexOf("grid") >= 0;
    var bs = cs.getPropertyValue("box-sizing") === "border-box";
    var padX = px(cs.paddingLeft) + px(cs.paddingRight) + px(cs.borderLeftWidth) + px(cs.borderRightWidth);
    var padY = px(cs.paddingTop) + px(cs.paddingBottom) + px(cs.borderTopWidth) + px(cs.borderBottomWidth);
    var cw = bs ? w : w - padX, ch = bs ? h : h - padY;
    // A transformed box's rect is its drawn size: its own is in offsetWidth.
    if (cs.getPropertyValue("transform") !== "none" && el.offsetWidth !== undefined) { cw = bs ? el.offsetWidth : el.offsetWidth - padX; ch = bs ? el.offsetHeight : el.offsetHeight - padY; }
    var fills = false;
    if (!out && !inFlex && !inlineLevel(disp) && el.parentElement) {
      var pr = el.parentElement.getBoundingClientRect();
      var inner = pr.width - px(parentCs.paddingLeft) - px(parentCs.paddingRight) - px(parentCs.borderLeftWidth) - px(parentCs.borderRightWidth);
      fills = Math.abs(rect.width + px(cs.marginLeft) + px(cs.marginRight) - inner) < 1.5;
    }
    var hasWords = !replaced && (el.textContent || "").trim().length > 0;
    var shrinkWrap = (inFlex || disp.indexOf("inline") === 0 || out) && hasWords && px(cs.flexGrow) === 0 && cs.getPropertyValue("flex-basis") === "auto";
    if (shrinkWrap && fitsContent(el, rect)) { /* it sizes itself to its words */ }
    else if (replaced || out || !fills) style.width = up(cw) + "px";
    var kids = el.children.length > 0 || (el.textContent || "").trim().length > 0;
    var clips = cs.getPropertyValue("overflow-x") !== "visible" || cs.getPropertyValue("overflow-y") !== "visible";
    if (replaced || out || !kids) style.height = up(ch) + "px";
    else if (clips && !inFlex) style.height = up(ch) + "px";
    else {
      // Room the content doesn't explain (a hero at least as tall as the window): kept as a minimum.
      var bottom = rect.top;
      for (var i = 0; i < el.children.length; i++) {
        var c = el.children[i], ccs = getComputedStyle(c);
        if (ccs.position === "absolute" || ccs.position === "fixed" || ccs.display === "none") continue;
        var cr = c.getBoundingClientRect();
        bottom = Math.max(bottom, cr.bottom + px(ccs.marginBottom));
      }
      if (el.children.length === 0) bottom = rect.bottom;
      var need = bottom - rect.top + px(cs.paddingBottom) + px(cs.borderBottomWidth);
      if (h - need > 2) style["min-height"] = up(ch) + "px";
    }
    // Centred with auto margins: kept centred, not at today's pixels.
    if (!out && !inlineLevel(disp) && style.width && px(cs.marginLeft) > 1 && Math.abs(px(cs.marginLeft) - px(cs.marginRight)) < 1.5) { style["margin-left"] = "auto"; style["margin-right"] = "auto"; }
  }

  var positioned = [{ x: 0, y: 0, bt: 0, bl: 0 }];

  function textNode(t, parentDisplay) {
    var s = t.textContent;
    if (!s) return null;
    if (!s.trim()) return " ";
    return s;
  }

  function pseudo(el, which, parentCs, rectOf) {
    var cs = getComputedStyle(el, which);
    var content = cs.getPropertyValue("content");
    if (!content || content === "none" || content === "normal") return null;
    var words = "";
    var m = /^"((?:[^"\\]|\\.)*)"$/.exec(content);
    if (m) words = m[1].replace(/\\([0-9a-fA-F]{1,6})\s?/g, function (_, h) { return String.fromCodePoint(parseInt(h, 16)); }).replace(/\\(.)/g, "$1");
    else if (/^url\(/.test(content)) words = "";
    else if (content !== '""') return null;
    var disp = cs.getPropertyValue("display");
    var tag = inlineLevel(disp) ? "span" : "div";
    var style = styleOf(null, cs, parentCs, tag);
    if (!words) {
      var w = px(cs.width), h = px(cs.height);
      if (!(w > 0 && h > 0) && style["background-color"] === undefined && style["background-image"] === undefined && !style["border-top-width"]) return null;
      if (w > 0) style.width = cs.width;
      if (h > 0) style.height = cs.height;
      if (/^url\(/.test(content) && style["background-image"] === undefined) { style["background-image"] = content; style["background-size"] = "contain"; style["background-repeat"] = "no-repeat"; }
    }
    count++;
    return { tag: tag, name: which === "::before" ? "Before" : "After", style: style, children: words ? [words] : [] };
  }

  function svgOf(el, rect) {
    var clone = el.cloneNode(true);
    var src = el.querySelectorAll("*"), dst = clone.querySelectorAll("*");
    for (var i = 0; i < src.length && i < 4000; i++) {
      var cs = getComputedStyle(src[i]), parts = [];
      for (var j = 0; j < SVG_PROPS.length; j++) {
        var p = SVG_PROPS[j], v = cs.getPropertyValue(p);
        if (v && v !== "normal" && !(p === "visibility" && v === "visible")) parts.push(p + ":" + v);
      }
      dst[i].setAttribute("style", parts.join(";"));
      dst[i].removeAttribute("class");
    }
    // Icons drawn from a sprite elsewhere on the page (<use href="#icon">): the drawing itself comes along.
    var uses = clone.querySelectorAll("use");
    for (var k = 0; k < uses.length; k++) {
      var ref = uses[k].getAttribute("href") || uses[k].getAttribute("xlink:href") || "";
      if (ref.charAt(0) !== "#") continue;
      var target = document.getElementById(ref.slice(1));
      var here = null;
      try { here = clone.querySelector("#" + CSS.escape(ref.slice(1))); } catch (e) {}
      if (!target || here) continue;
      var g = document.createElementNS("http://www.w3.org/2000/svg", target.tagName.toLowerCase() === "symbol" ? "svg" : "g");
      if (target.getAttribute("viewBox")) g.setAttribute("viewBox", target.getAttribute("viewBox"));
      ["x", "y", "width", "height"].forEach(function (a) { if (uses[k].getAttribute(a)) g.setAttribute(a, uses[k].getAttribute(a)); });
      g.innerHTML = target.innerHTML;
      uses[k].replaceWith(g);
    }
    var ecs = getComputedStyle(el);
    clone.removeAttribute("class");
    clone.setAttribute("width", r1(rect.width));
    clone.setAttribute("height", r1(rect.height));
    clone.setAttribute("style", "color:" + ecs.color + ";fill:" + ecs.fill + ";stroke:" + ecs.stroke);
    if (!clone.getAttribute("xmlns")) clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    return new XMLSerializer().serializeToString(clone);
  }

  // A country or region picker, a cookie notice by its usual names: left out wherever it sits.
  var HOUSEKEEPING = /onetrust|cookiebot|cookieyes|localeswitcher|locale-switcher|cookie-?(banner|consent|notice|bar)|consent-?(banner|bar|manager)/i;
  var CONSENT_ID = /cookie|consent|gdpr|onetrust|cookiebot|cookieyes|cmp-|cc-window|cc-banner|truste|didomi|usercentrics|termly|iubenda|osano/i;
  var CONSENT_WORDS = /\b(cookies?|consent|gdpr|tracking technologies)\b/i;
  var CONSENT_ACT = /\b(accept|reject|decline|agree|allow|deny|got it|i understand|preferences|customi[sz]e)\b/i;
  function isConsent(el) {
    var id = (el.id || "") + " " + (typeof el.className === "string" ? el.className : "") + " " + (el.getAttribute("aria-label") || "");
    if (CONSENT_ID.test(id)) return true;
    var text = (el.textContent || "").slice(0, 3000);
    if (text.length > 1500 || !CONSENT_WORDS.test(text) || !CONSENT_ACT.test(text)) return false;
    // A site's header or footer that links to its cookie policy isn't a banner.
    return !el.querySelector("nav") && Boolean(el.querySelector("button, [role=button], a"));
  }
  function inPopover(el) {
    for (var a = el.parentElement, i = 0; a && a !== document.body && i < 8; a = a.parentElement, i++) {
      var p = getComputedStyle(a).position;
      if (p === "absolute" || p === "fixed") return true;
    }
    return false;
  }
  function takesTurns(el, rect) {
    var p = el.parentElement;
    if (!p || rect.width * rect.height === 0) return false;
    for (var i = 0; i < p.children.length; i++) {
      var o = p.children[i];
      if (o === el) continue;
      var ocs = getComputedStyle(o);
      if (ocs.display === "none" || ocs.visibility === "hidden" || px(ocs.opacity) < 0.5) continue;
      var r = o.getBoundingClientRect();
      var w = Math.max(0, Math.min(r.right, rect.right) - Math.max(r.left, rect.left)), h = Math.max(0, Math.min(r.bottom, rect.bottom) - Math.max(r.top, rect.top));
      if (w * h > 0.5 * rect.width * rect.height) return true;
    }
    return false;
  }
  function isAnimation(svg) {
    if (svg.querySelector("image, foreignObject")) return true;
    if (/translate3d/.test(svg.getAttribute("style") || "")) return true;
    return svg.getElementsByTagName("*").length > 1200;
  }
  function walk(el, parentCs, depth) {
    if (SKIP[el.tagName] || depth > 60) return null;
    if (count >= MAX) { cutOff = true; return null; }
    var cs = getComputedStyle(el);
    var disp = cs.getPropertyValue("display");
    if (disp === "none") return null;
    if (el.getAttribute && el.getAttribute("aria-hidden") === "true" && el.offsetWidth === 0) return null;
    var rect = el.getBoundingClientRect();
    var top = rect.top + scrollY;
    if (top > limitY) return null;
    var lifted = cs.position === "absolute" || cs.position === "fixed";
    if (lifted && (rect.right < -2 || rect.left > W + 2 || rect.bottom + scrollY <= 0)) return null;
    // Kept for screen readers only (clipped to nothing, a pixel square): not drawn, so not a layer.
    if (cs.clip === "rect(0px, 0px, 0px, 0px)" || /^inset\(50%/.test(cs.clipPath) || (lifted && rect.width <= 1 && rect.height <= 1 && cs.overflow === "hidden")) return null;
    if (disp === "contents") {
      var flat = [];
      for (var c = el.firstChild; c; c = c.nextSibling) {
        if (c.nodeType === 3) { var t = textNode(c); if (t) flat.push(t); }
        else if (c.nodeType === 1) { var k = walk(c, parentCs, depth + 1); if (k && k.tag === "#contents") flat.push.apply(flat, k.children); else if (k) flat.push(k); }
      }
      return { tag: "#contents", children: flat };
    }
    var tagName = el.tagName;
    if (tagName === "BR") return { tag: "br" };
    if (tagName === "WBR") return null;
    // A cookie or consent banner: the site's housekeeping, not its design.
    if ((lifted || cs.position === "sticky") && isConsent(el)) { warnings.indexOf("consent") < 0 && warnings.push("consent"); return null; }
    if (HOUSEKEEPING.test((el.id || "") + " " + (typeof el.className === "string" ? el.className : ""))) return null;
    var isSvg = el instanceof SVGElement;
    if (isSvg && tagName.toLowerCase() !== "svg") return null;
    if (rect.width === 0 && rect.height === 0 && cs.overflow !== "visible") return null;
    if (cs.getPropertyValue("visibility") === "hidden" && el.children.length === 0) return null;
    count++;
    var name = nameOf(el);
    var node;

    if (tagName === "IMG") {
      var src = el.currentSrc || el.src || el.getAttribute("data-src") || "";
      if (!src) return null;
      node = { tag: "img", attrs: { src: abs(src), alt: el.alt || "" } };
    } else if (tagName === "VIDEO") {
      node = { tag: "video", attrs: { src: abs(el.currentSrc || el.src || ""), poster: el.poster ? abs(el.poster) : "", muted: "", loop: el.loop ? "" : null, autoplay: el.autoplay ? "" : null, playsinline: "" } };
      // A film streamed in pieces (a blob: link) can't be played from anywhere else: its picture instead.
      if (!node.attrs.src || /^blob:/.test(node.attrs.src)) { node = { tag: "img", attrs: { src: "shot:" + shots.length, alt: "" } }; el.setAttribute("data-ss-shot", shots.length); shots.push(shots.length); }
      // Its still is a frame of it as it's seen (see the pictures in web-import), not the site's poster.
      else if (el.readyState >= 2 && el.videoWidth) { el.setAttribute("data-ss-shot", shots.length); node.attrs.poster = "shot:" + shots.length; shots.push(shots.length); }
    } else if (isSvg && isAnimation(el)) {
      // An animation drawn in SVG (Lottie and the like, with its pictures inside): a picture of how it's drawn.
      el.setAttribute("data-ss-shot", shots.length);
      node = { tag: "img", attrs: { src: "shot:" + shots.length, alt: "" } };
      shots.push(shots.length);
    } else if (isSvg) {
      node = { tag: "svg", markup: svgOf(el, rect) };
    } else if (PICTURED[tagName] || (tagName === "INPUT" && /^(checkbox|radio|range|color|file)$/i.test(el.type))) {
      el.setAttribute("data-ss-shot", shots.length);
      node = { tag: "img", attrs: { src: "shot:" + shots.length, alt: "" } };
      shots.push(shots.length);
    } else if (tagName === "INPUT" || tagName === "TEXTAREA" || tagName === "SELECT") {
      var words = tagName === "SELECT" ? (el.options[el.selectedIndex] || {}).text || "" : el.value || el.placeholder || "";
      var hint = !(tagName === "SELECT" || el.value);
      node = { tag: "div", children: [], words: words, placeholder: hint ? getComputedStyle(el, "::placeholder").color : null };
    } else {
      node = { tag: tagName === "A" && el.getAttribute("href") ? "a" : inlineLevel(disp) ? "span" : "div", children: [] };
      if (node.tag === "a") node.attrs = { href: abs(el.getAttribute("href")) };
    }
    var outTag = node.tag === "a" ? (inlineLevel(disp) ? "span" : "div") : node.tag === "svg" ? "div" : node.tag;
    var style = styleOf(el, cs, parentCs, outTag === "img" || outTag === "video" ? "img" : outTag);
    // A link's colour and underline are its own, not the browser's blue.
    if (node.tag === "a") { style.color = cs.color; style["text-decoration-line"] = cs.getPropertyValue("text-decoration-line"); }
    var replaced = node.tag === "img" || node.tag === "video" || node.tag === "svg";
    sizeOf(el, cs, style, rect, parentCs, replaced);
    // Kept back by a reveal-on-scroll script that didn't run: shown as it's meant to be seen.
    // (Not when something else shows in its place, one of several that take turns, nor a menu or a
    // tooltip waiting to be opened: hidden, inert, or in a box floated over the page.)
    if (px(cs.opacity) < 0.05 && !lifted && cs.pointerEvents !== "none" && (el.textContent || "").trim() && !el.closest("[aria-hidden=true]") && !takesTurns(el, rect) && !inPopover(el)) { delete style.opacity; delete style.transform; }
    // Fixed (a header that stays put): where it sits at the top of the page, in its holder.
    if (cs.position === "fixed") {
      var holder = positioned[positioned.length - 1];
      style.position = "absolute";
      // On the screen is where it sits at the top of the page, however far the page is scrolled.
      style.top = r1(rect.top - holder.y - holder.bt) + "px";
      style.left = r1(rect.left + scrollX - holder.x - holder.bl) + "px";
      delete style.right; delete style.bottom;
    }
    node.style = style;
    if (name) node.name = name;
    if (node.words !== undefined) {
      node.children = [node.words];
      if (node.placeholder) style.color = node.placeholder;
      if (!style["white-space"]) style["white-space"] = "nowrap";
      if (!style.overflow && !style["overflow-x"]) style["overflow-x"] = "hidden";
      if (tagName === "INPUT") {
        style.display = /^inline/.test(disp) ? "inline-flex" : "flex";
        style["align-items"] = "center";
        var ta = cs.textAlign;
        if (ta === "center") style["justify-content"] = "center";
        else if (ta === "right" || ta === "end") style["justify-content"] = "flex-end";
      }
    }
    if (node.tag === "div" || node.tag === "span" || node.tag === "a") {
      var pushed = cs.position !== "static";
      if (pushed) { var dr = docRect(el); positioned.push({ x: dr.x, y: dr.y, bt: px(cs.borderTopWidth), bl: px(cs.borderLeftWidth) }); }
      var before = pseudo(el, "::before", cs);
      if (before) node.children.push(before);
      for (var ch = el.firstChild; ch; ch = ch.nextSibling) {
        if (ch.nodeType === 3) { var tx = textNode(ch); if (tx) node.children.push(tx); }
        else if (ch.nodeType === 1) {
          var kid = walk(ch, cs, depth + 1);
          if (kid && kid.tag === "#contents") node.children.push.apply(node.children, kid.children);
          else if (kid) node.children.push(kid);
        }
      }
      var after = pseudo(el, "::after", cs);
      if (after) node.children.push(after);
      if (pushed) positioned.pop();
      // Spaces only between words: none at the edges of a block.
      while (node.children.length && node.children[0] === " ") node.children.shift();
      while (node.children.length && node.children[node.children.length - 1] === " ") node.children.pop();
      if ((el.textContent || "").trim()) noteFamily(cs.fontFamily);
    }
    return node;
  }

  scrollTo(0, 0);
  var body = document.body, html = document.documentElement;
  var bcs = getComputedStyle(body), hcs = getComputedStyle(html);
  var bg = bcs.backgroundColor;
  if (!bg || bg === "rgba(0, 0, 0, 0)") bg = hcs.backgroundColor;
  if (!bg || bg === "rgba(0, 0, 0, 0)") bg = "rgb(255, 255, 255)";
  var rootStyle = styleOf(body, bcs, null, "div");
  ["margin-top", "margin-right", "margin-bottom", "margin-left", "width", "height", "min-height", "max-width", "position", "top", "left", "right", "bottom", "overflow-x", "overflow-y", "display", "transform"].forEach(function (k) { delete rootStyle[k]; });
  rootStyle["padding-top"] = r1(px(bcs.marginTop) + px(bcs.paddingTop)) + "px";
  rootStyle["padding-right"] = r1(px(bcs.marginRight) + px(bcs.paddingRight)) + "px";
  rootStyle["padding-bottom"] = r1(px(bcs.marginBottom) + px(bcs.paddingBottom)) + "px";
  rootStyle["padding-left"] = r1(px(bcs.marginLeft) + px(bcs.paddingLeft)) + "px";
  rootStyle.position = "relative";
  rootStyle.width = W + "px";
  rootStyle["min-height"] = limitY + "px";
  if (!opts.fullPage) rootStyle.height = VIEW_H + "px";
  rootStyle.overflow = "hidden";
  rootStyle["background-color"] = bg;
  if (bcs.backgroundImage !== "none") rootStyle["background-image"] = bcs.backgroundImage;
  for (var i = 0; i < INHERITED.length; i++) if (!rootStyle[INHERITED[i]]) rootStyle[INHERITED[i]] = bcs.getPropertyValue(INHERITED[i]);
  noteFamily(bcs.fontFamily);
  var root = { tag: "div", name: document.title || location.hostname, style: rootStyle, children: [] };
  for (var c2 = body.firstChild; c2; c2 = c2.nextSibling) {
    if (c2.nodeType === 3) { var t2 = textNode(c2); if (t2 && t2 !== " ") root.children.push(t2); }
    else if (c2.nodeType === 1) {
      var k2 = walk(c2, bcs, 1);
      if (k2 && k2.tag === "#contents") root.children.push.apply(root.children, k2.children);
      else if (k2) root.children.push(k2);
    }
  }
  frame.remove();
  if (cutOff) warnings.push("The page has more than " + MAX + " elements: the rest were left out.");
  if (opts.fullPage && docH > CUT) warnings.push("The page is " + Math.round(docH) + " px long: it was cut at " + CUT + " px.");

  // The site's typefaces, from the stylesheets this page can read (the rest, from other sites, are read by the engine).
  var faces = [], unread = [];
  function ruleFaces(rules, base) {
    for (var i = 0; i < rules.length; i++) {
      var r = rules[i];
      if (r.type === 5) {
        var s = r.style;
        faces.push({ family: s.getPropertyValue("font-family").replace(/^["']|["']$/g, "").trim(), weight: s.getPropertyValue("font-weight") || "", style: s.getPropertyValue("font-style") || "", unicodeRange: s.getPropertyValue("unicode-range") || "", src: s.getPropertyValue("src") || "", base: base });
      } else if (r.cssRules) {
        ruleFaces(r.cssRules, r.styleSheet && r.styleSheet.href ? r.styleSheet.href : base);
      } else if (r.styleSheet) {
        try { ruleFaces(r.styleSheet.cssRules, r.styleSheet.href || base); } catch (e) { if (r.styleSheet.href) unread.push(r.styleSheet.href); }
      }
    }
  }
  for (var si = 0; si < document.styleSheets.length; si++) {
    var sh = document.styleSheets[si];
    try { ruleFaces(sh.cssRules, sh.href || document.baseURI); } catch (e) { if (sh.href) unread.push(sh.href); }
  }
  var used = [];
  for (var key in families) used.push(families[key]);
  return { root: root, width: W, height: opts.fullPage ? Math.min(docH, CUT) : VIEW_H, title: document.title || location.hostname, warnings: warnings, shots: shots.length, faces: faces, unread: unread, families: used, count: count };
})`;
