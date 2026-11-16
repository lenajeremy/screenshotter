// Shaders on boards, drawn. One small script, the same everywhere a board is shown: the Studio's
// canvas (and its Assets tiles), Preview, a page copied out as HTML, and the pictures the engine
// takes in headless Chrome. It is a plain script (it sets globalThis.BoardShaders), so a page can
// carry it inline; the Studio imports it as a module.
//
// How it draws: one WebGL context for every shader layer on the page (browsers allow about 16), on a
// canvas of its own that's never shown. Each layer is drawn there in turn, at the size it shows,
// and copied into the layer's own canvas (a 2D one, which browsers don't limit). So a layer is an
// ordinary element: it's placed, rotated, rounded, blended and masked by CSS like any other.
//
// What it saves: layers off screen aren't drawn; while the view is panned or zoomed they're drawn
// at half the resolution; never more than 2 pixels per CSS pixel while playing. With Reduce Motion
// on, every shader is a still. A frame-time guard times each layer's drawing now and then (by
// waiting for the graphics card to finish it): one that's too slow is drawn smaller, then stopped
// at its still, and says so.
//
// A shader's code is GLSL, given to the graphics card and nothing else. Its parameters come as
// uniforms already worked out by the model (src/board/shaders.ts): numbers, "12px" lengths (in
// design pixels; drawn pixels here) and CSS colours (tokens resolved here, where they're drawn).
(function () {
  "use strict";
  const G = typeof globalThis !== "undefined" ? globalThis : window;
  if (G.BoardShaders) return;

  const VERT1 = "attribute vec2 p;void main(){gl_Position=vec4(p,0.0,1.0);}";
  const VERT3 = "#version 300 es\nin vec2 p;void main(){gl_Position=vec4(p,0.0,1.0);}";
  /** What every shader is given, unless it declares them itself. */
  const BUILTINS = [
    ["uTime", "float"],
    ["uRes", "vec2"],
    ["uPx", "float"],
  ];
  const MAX_CODE = 20000;
  const PX = /^(-?\d*\.?\d+)px$/;
  const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

  const opts = {
    /** "live" plays; "still" draws each layer once, at its time (pictures of the board). */
    mode: "live",
    /** How much the page is scaled where the layers are (the Studio's zoom). */
    zoom: () => 1,
    /** Whether the view is being panned or zoomed right now. */
    moving: () => false,
    /** The element visibility is measured against (null: the window). */
    root: () => null,
    /** Pixels per CSS pixel, at most, while playing. */
    maxRatio: 2,
    /** How long (ms) one layer may take to draw before it's drawn smaller, and in the end stopped. */
    budget: 24,
    /** Write on a layer that was too slow to play. */
    badges: true,
    /** Told when a layer starts playing, pauses, fails or is stopped as too slow: (canvas, state). */
    onState: null,
  };

  let gl = null;
  let glc = null;
  let gl2 = false;
  let tried = false;
  let contexts = 0;
  const programs = new Map();
  const layers = new Set();
  const byCanvas = new WeakMap();
  let raf = 0;
  let frameNo = 0;
  let serial = 0;
  let io = null;
  let ioRoot = null;
  let ro = null;
  let movingUntil = 0;
  let wasMoving = false;
  const PIXEL = new Uint8Array(4);

  const mq = typeof matchMedia === "function" ? matchMedia("(prefers-reduced-motion: reduce)") : null;
  let reduce = Boolean(mq && mq.matches);
  const onReduce = () => {
    reduce = Boolean(mq && mq.matches);
    for (const L of layers) L.dirty = true;
    wake();
  };
  if (mq) mq.addEventListener ? mq.addEventListener("change", onReduce) : mq.addListener?.(onReduce);

  // -------------------------------------------------------------------------------------------
  // The one context

  function context() {
    if (gl && !gl.isContextLost()) return gl;
    if (tried) return gl && !gl.isContextLost() ? gl : null;
    tried = true;
    if (typeof document === "undefined") return null;
    glc = document.createElement("canvas");
    glc.width = 256;
    glc.height = 256;
    const attrs = { alpha: true, premultipliedAlpha: false, antialias: false, depth: false, stencil: false, preserveDrawingBuffer: false, powerPreference: "low-power" };
    try {
      gl = glc.getContext("webgl2", attrs);
      gl2 = Boolean(gl);
      if (!gl) gl = glc.getContext("webgl", attrs) || glc.getContext("experimental-webgl", attrs);
    } catch {
      gl = null;
    }
    if (!gl) return null;
    contexts++;
    glc.addEventListener("webglcontextlost", (e) => {
      e.preventDefault();
      programs.clear();
      for (const L of layers) L.dirty = true;
    });
    glc.addEventListener("webglcontextrestored", () => {
      setup();
      for (const L of layers) L.dirty = true;
      wake();
    });
    setup();
    return gl;
  }

  /** One triangle that covers the view: every pixel runs the shader once. */
  function setup() {
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  }

  // -------------------------------------------------------------------------------------------
  // Code to programs

  /**
   * The source given to the graphics card: precision and the built-in uniforms first, then
   * `#line 1` so errors name the lines of the code as written. Code in Shadertoy's form
   * (mainImage, iTime, iResolution) gets a main() of its own.
   */
  function prepare(code) {
    code = String(code == null ? "" : code)
      .replace(/\r\n?/g, "\n")
      .replace(/[^\t\n\x20-\x7e]/g, " ")
      .slice(0, MAX_CODE);
    const v3 = /^\s*#version\s+300\s+es\b/.test(code);
    let head = "";
    let body = code;
    let first = 1;
    if (v3) {
      const nl = code.indexOf("\n");
      head = nl < 0 ? code + "\n" : code.slice(0, nl + 1);
      body = nl < 0 ? "" : code.slice(nl + 1);
      first = 2;
    }
    const pre = ["#ifdef GL_FRAGMENT_PRECISION_HIGH", "precision highp float;", "#else", "precision mediump float;", "#endif"];
    for (const [name, type] of BUILTINS) if (!new RegExp(`\\buniform\\b[^;]*\\b${name}\\b`).test(body)) pre.push(`uniform ${type} ${name};`);
    let tail = "";
    if (!/\bvoid\s+main\s*\(/.test(body) && /\bvoid\s+mainImage\s*\(/.test(body)) {
      pre.push("#define iTime uTime", "#define iResolution vec3(uRes, 1.0)");
      tail = v3 ? "\nout vec4 bdFragColor;\nvoid main(){vec4 c=vec4(0.0,0.0,0.0,1.0);mainImage(c,gl_FragCoord.xy);bdFragColor=c;}\n" : "\nvoid main(){vec4 c=vec4(0.0,0.0,0.0,1.0);mainImage(c,gl_FragCoord.xy);gl_FragColor=c;}\n";
    }
    return { source: `${head}${pre.join("\n")}\n#line ${first}\n${body}${tail}`, v3, lines: code.split("\n").length };
  }

  /** A compiler's log as errors on the lines of the code as written (null: not on one of its lines). */
  function errorsOf(log, lines) {
    const out = [];
    for (const raw of String(log || "").split("\n")) {
      if (!raw.trim() || /compilation errors|No code generated/i.test(raw)) continue;
      const m = /^\s*ERROR:\s*\d+:(\d+):\s*(.*)$/.exec(raw);
      if (m) {
        const line = Number(m[1]);
        out.push({ line: line >= 1 && line <= lines ? line : null, message: m[2].trim() });
      } else if (/^\s*ERROR:/.test(raw)) out.push({ line: null, message: raw.replace(/^\s*ERROR:\s*/, "").trim() });
    }
    if (!out.length && log && String(log).trim()) out.push({ line: null, message: String(log).trim().slice(0, 300) });
    return out;
  }

  /** A program for some code, made once and kept: its uniforms, or what's wrong with it. */
  function program(code) {
    let e = programs.get(code);
    if (e && (!e.prog || !gl || !gl.isContextLost())) return e;
    const g = context();
    if (!g) return { error: [{ line: null, message: "WebGL isn't available here, so shaders can't draw." }], nogl: true };
    const p = prepare(code);
    e = { uniforms: new Map() };
    if (!String(code || "").trim()) e.error = [{ line: null, message: "There's no shader code." }];
    else if (p.v3 && !gl2) e.error = [{ line: 1, message: "This is GLSL 3.00 (#version 300 es), which needs WebGL 2: this browser has WebGL 1 only." }];
    else {
      const fs = g.createShader(g.FRAGMENT_SHADER);
      g.shaderSource(fs, p.source);
      g.compileShader(fs);
      if (!g.getShaderParameter(fs, g.COMPILE_STATUS)) {
        e.error = errorsOf(g.getShaderInfoLog(fs), p.lines);
        if (!e.error.length) e.error = [{ line: null, message: "The shader didn't compile." }];
        g.deleteShader(fs);
      } else {
        const vs = g.createShader(g.VERTEX_SHADER);
        g.shaderSource(vs, p.v3 ? VERT3 : VERT1);
        g.compileShader(vs);
        const prog = g.createProgram();
        g.attachShader(prog, vs);
        g.attachShader(prog, fs);
        g.bindAttribLocation(prog, 0, "p");
        g.linkProgram(prog);
        g.deleteShader(vs);
        g.deleteShader(fs);
        if (!g.getProgramParameter(prog, g.LINK_STATUS)) {
          e.error = errorsOf(g.getProgramInfoLog(prog), p.lines);
          if (!e.error.length) e.error = [{ line: null, message: "The shader couldn't be linked: does it have a main()?" }];
          g.deleteProgram(prog);
        } else {
          e.prog = prog;
          const n = g.getProgramParameter(prog, g.ACTIVE_UNIFORMS);
          for (let i = 0; i < n; i++) {
            const info = g.getActiveUniform(prog, i);
            if (!info || info.size !== 1 || info.name.includes("[")) continue;
            e.uniforms.set(info.name, { loc: g.getUniformLocation(prog, info.name), type: info.type });
          }
        }
      }
    }
    // Kept for the code that made it; the oldest go when there are many.
    if (programs.size >= 48) {
      const [oldest, old] = programs.entries().next().value;
      if (old.prog) g.deleteProgram(old.prog);
      programs.delete(oldest);
    }
    programs.set(code, e);
    return e;
  }

  /** Compile some code (in this browser) and say what's wrong with it, by line. */
  function compile(code) {
    const e = program(String(code == null ? "" : code));
    return { ok: !e.error, errors: e.error || [], uniforms: e.uniforms ? [...e.uniforms.keys()] : [], webgl: gl2 ? 2 : gl ? 1 : 0 };
  }

  // -------------------------------------------------------------------------------------------
  // Colours: CSS (tokens too) to numbers, where the layer is drawn

  let probe2d = null;
  const colors = new Map();
  function color(el, value) {
    let s = String(value).trim();
    if (s.includes("var(")) {
      let cs = null;
      for (let i = 0; i < 8 && s.includes("var("); i++)
        s = s.replace(/var\(\s*(--[\w-]+)\s*(?:,\s*((?:[^()]|\([^()]*\))*))?\)/g, (_m, name, fb) => {
          cs = cs || getComputedStyle(el);
          return cs.getPropertyValue(name).trim() || (fb || "").trim();
        });
    }
    if (colors.has(s)) return colors.get(s);
    let out = [0, 0, 0, 1];
    try {
      probe2d = probe2d || Object.assign(document.createElement("canvas"), { width: 1, height: 1 }).getContext("2d", { willReadFrequently: true });
      // A colour the browser doesn't know leaves fillStyle as it was: set from two sides to tell.
      probe2d.fillStyle = "#000";
      probe2d.fillStyle = s;
      const a = probe2d.fillStyle;
      probe2d.fillStyle = "#fff";
      probe2d.fillStyle = s;
      if (a === probe2d.fillStyle) {
        probe2d.clearRect(0, 0, 1, 1);
        probe2d.fillRect(0, 0, 1, 1);
        const d = probe2d.getImageData(0, 0, 1, 1).data;
        out = [d[0] / 255, d[1] / 255, d[2] / 255, d[3] / 255];
      }
    } catch {
      // No 2D canvas: black.
    }
    if (colors.size > 500) colors.clear();
    colors.set(s, out);
    return out;
  }

  // -------------------------------------------------------------------------------------------
  // Layers

  const num = (v, d) => (typeof v === "number" && Number.isFinite(v) ? v : d);

  class Layer {
    constructor(canvas) {
      this.id = ++serial;
      this.canvas = canvas;
      this.ctx = null;
      this.visible = true;
      this.quality = 1;
      this.cost = 0;
      this.strikes = 0;
      this.probes = 0;
      this.probeAt = 0;
      this.slow = false;
      this.state = "";
      this.cssW = canvas.clientWidth;
      this.cssH = canvas.clientHeight;
      this.ratio = 1;
      this.frames = 0;
      this.drawn = 0;
      this.gone = 0;
      this.dirty = true;
      this.base = 0;
      this.since = now();
      this.data = null;
    }
    set(data) {
      const d = data || {};
      const was = this.data;
      this.data = d;
      this.code = typeof d.code === "string" ? d.code : "";
      const speed = num(d.speed, 1);
      const time = num(d.time, 0);
      const paused = Boolean(d.paused);
      // Played from its still; a new speed carries on from the moment showing.
      if (!was || num(was.time, 0) !== time || Boolean(was.paused) !== paused) {
        this.base = time;
        this.since = now();
      } else if (num(was.speed, 1) !== speed) {
        this.base = this.shown();
        this.since = now();
      }
      this.speed = speed;
      this.time = time;
      this.paused = paused;
      if (!was || was.code !== d.code) this.again();
      this.resolve();
      this.dirty = true;
    }
    /** The guard forgets what it found: new code, or the person asked it to play again. */
    again() {
      this.slow = false;
      this.quality = 1;
      this.cost = 0;
      this.strikes = 0;
      this.probes = 0;
      this.probeAt = 0;
      this.drawn = 0;
    }
    shown() {
      return this.base + ((now() - this.since) / 1000) * this.speed;
    }
    plays() {
      return opts.mode === "live" && !this.paused && !reduce && !this.slow && this.speed !== 0;
    }
    resolve() {
      const u = (this.data && this.data.uniforms) || {};
      const vals = {};
      this.vars = false;
      for (const [k, v] of Object.entries(u)) {
        if (typeof v === "number") vals[k] = Number.isFinite(v) ? v : 0;
        else if (typeof v === "boolean") vals[k] = v ? 1 : 0;
        else if (typeof v === "string") {
          const m = PX.exec(v.trim());
          if (m) vals[k] = { px: Number(m[1]) };
          else {
            vals[k] = color(this.canvas, v);
            if (v.includes("var(")) this.vars = true;
          }
        }
      }
      this.values = vals;
      this.resolvedAt = now();
    }
  }

  function setUniform(g, u, v, ratio) {
    let n = 0;
    let c = null;
    if (Array.isArray(v)) c = v;
    else if (v && typeof v === "object" && "px" in v) n = v.px * ratio;
    else if (typeof v === "number") n = v;
    switch (u.type) {
      case g.FLOAT:
        g.uniform1f(u.loc, c ? c[0] : n);
        break;
      case g.INT:
      case g.BOOL:
        g.uniform1i(u.loc, Math.round(c ? c[0] : n));
        break;
      case g.FLOAT_VEC2:
        g.uniform2f(u.loc, c ? c[0] : n, c ? c[1] : n);
        break;
      case g.FLOAT_VEC3:
        if (c) g.uniform3f(u.loc, c[0], c[1], c[2]);
        else g.uniform3f(u.loc, n, n, n);
        break;
      case g.FLOAT_VEC4:
        if (c) g.uniform4f(u.loc, c[0], c[1], c[2], c[3]);
        else g.uniform4f(u.loc, n, n, n, 1);
        break;
      default:
    }
  }

  /** Size a layer's canvas to how big it shows. Returns whether it changed. */
  function fit(L, moving) {
    const cw = L.cssW;
    const ch = L.cssH;
    if (!(cw > 0 && ch > 0)) return false;
    const still = opts.mode === "still";
    const dpr = G.devicePixelRatio || 1;
    let zoom = 1;
    try {
      zoom = still ? 1 : Math.max(0.01, Number(opts.zoom()) || 1);
    } catch {}
    let ratio = still ? Math.min(dpr, 4) : Math.min(dpr, opts.maxRatio) * zoom * L.quality;
    if (moving && !still) ratio *= 0.5;
    const side = still ? 4096 : 2560;
    const area = still ? 16e6 : 4.2e6;
    ratio = Math.min(ratio, side / cw, side / ch, Math.sqrt(area / (cw * ch)));
    const w = Math.max(1, Math.round(cw * ratio));
    const h = Math.max(1, Math.round(ch * ratio));
    const c = L.canvas;
    if (w === c.width && h === c.height) {
      L.ratio = w / cw;
      return false;
    }
    // While the view moves, a canvas near the size it should be stays as it is (no new one each frame).
    if (moving && !still && L.drawn > 0) {
      const k = w / c.width;
      if (k > 0.6 && k < 1.7) return false;
    }
    c.width = w;
    c.height = h;
    L.ratio = w / cw;
    return true;
  }

  function setState(L, st) {
    const key = `${st.kind}|${st.errors ? JSON.stringify(st.errors) : ""}`;
    if (L.state === key) return;
    L.state = key;
    L.stateObj = st;
    L.canvas.dataset.shaderState = st.kind;
    if (opts.onState) {
      try {
        opts.onState(L.canvas, st);
      } catch {}
    }
  }

  /** Draw a layer once: at the moment it's at while playing, else at its still. */
  function draw(L) {
    const ctx = L.ctx || (L.ctx = L.canvas.getContext("2d"));
    if (!ctx) return;
    const g = context();
    if (!g) {
      note(L, "WebGL is off here", "Shaders need WebGL to draw.");
      setState(L, { kind: "nogl" });
      return;
    }
    const e = program(L.code);
    if (e.error) {
      errorCard(L, e.error);
      L.dirty = false;
      setState(L, { kind: "error", errors: e.error });
      return;
    }
    const w = L.canvas.width;
    const h = L.canvas.height;
    if (w < 1 || h < 1) return;
    // The shared canvas grows to hold the biggest layer.
    if (glc.width < w || glc.height < h) {
      glc.width = Math.min(8192, Math.max(glc.width, 2 ** Math.ceil(Math.log2(w))));
      glc.height = Math.min(8192, Math.max(glc.height, 2 ** Math.ceil(Math.log2(h))));
    }
    const plays = L.plays();
    const t = plays ? L.shown() : L.time;
    g.viewport(0, 0, w, h);
    g.useProgram(e.prog);
    for (const [name, u] of e.uniforms) {
      if (name === "uTime") g.uniform1f(u.loc, t);
      else if (name === "uRes") g.uniform2f(u.loc, w, h);
      else if (name === "uPx") g.uniform1f(u.loc, L.ratio);
      else setUniform(g, u, L.values[name], L.ratio);
    }
    // Now and then (not on its first frames, while the card readies the program), time it.
    const probe = plays && L.drawn >= 2 && frameNo >= L.probeAt;
    const t0 = probe ? now() : 0;
    g.clearColor(0, 0, 0, 0);
    g.clear(g.COLOR_BUFFER_BIT);
    g.drawArrays(g.TRIANGLES, 0, 3);
    if (probe) {
      g.readPixels(0, 0, 1, 1, g.RGBA, g.UNSIGNED_BYTE, PIXEL);
      measured(L, now() - t0);
    }
    ctx.globalCompositeOperation = "copy";
    ctx.drawImage(glc, 0, glc.height - h, w, h, 0, 0, w, h);
    ctx.globalCompositeOperation = "source-over";
    L.frames++;
    L.drawn++;
    L.dirty = false;
    if (L.slow && opts.badges && opts.mode === "live") badge(L, "Too slow to play here: showing its still");
    setState(L, { kind: L.slow ? "slow" : opts.mode === "still" ? "still" : reduce ? "reduced" : L.paused || L.speed === 0 ? "paused" : "playing", ms: Math.round(L.cost * 10) / 10 });
  }

  /** The guard: a layer that keeps taking longer than the budget is drawn smaller, then stopped. */
  function measured(L, ms) {
    L.cost = L.probes ? L.cost * 0.6 + ms * 0.4 : ms;
    L.probes++;
    L.probeAt = frameNo + (L.probes < 5 ? 3 : 30 + (L.id % 11));
    if (ms > opts.budget) strike(L);
    else L.strikes = Math.max(0, L.strikes - 1);
  }

  /** Too slow once more: twice in a row, it's drawn smaller (down to 0.3 of its size), and after that stopped. */
  function strike(L) {
    if (++L.strikes < 2) return;
    L.strikes = 0;
    if (L.quality > 0.3) {
      L.quality = Math.max(0.3, L.quality * 0.6);
      L.probes = 0;
      L.probeAt = frameNo + 3;
      L.dirty = true;
      return;
    }
    // Stopped: its still is drawn once, so it can be sharp.
    L.slow = true;
    L.quality = 1;
    L.dirty = true;
  }

  // -------------------------------------------------------------------------------------------
  // What's written on a layer instead: an error, no WebGL, too slow

  function lines(ctx, text, width, max) {
    const out = [];
    let cur = "";
    for (const word of String(text).split(/\s+/)) {
      const next = cur ? `${cur} ${word}` : word;
      if (ctx.measureText(next).width > width && cur) {
        out.push(cur);
        cur = word;
        if (out.length >= max) break;
      } else cur = next;
    }
    if (cur && out.length < max) out.push(cur);
    return out;
  }

  function errorCard(L, errors) {
    const c = L.canvas;
    const ctx = L.ctx;
    const w = c.width;
    const h = c.height;
    const k = Math.max(0.5, Math.min(3, L.ratio || 1));
    ctx.globalCompositeOperation = "source-over";
    ctx.fillStyle = "#1d1416";
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = "rgba(255, 106, 96, 0.09)";
    ctx.lineWidth = 6 * k;
    for (let x = -h; x < w; x += 18 * k) {
      ctx.beginPath();
      ctx.moveTo(x, h);
      ctx.lineTo(x + h, 0);
      ctx.stroke();
    }
    const pad = 12 * k;
    const first = errors[0] || { line: null, message: "It didn't compile." };
    ctx.fillStyle = "#ff8f85";
    ctx.font = `600 ${12 * k}px ui-monospace, Menlo, monospace`;
    ctx.fillText(first.line ? `Shader error · line ${first.line}` : "Shader error", pad, pad + 11 * k);
    ctx.fillStyle = "#f3dcd9";
    ctx.font = `${11 * k}px ui-monospace, Menlo, monospace`;
    const room = Math.max(1, Math.floor((h - pad * 2 - 20 * k) / (15 * k)));
    const said = lines(ctx, first.message, w - pad * 2, room);
    said.forEach((s, i) => ctx.fillText(s, pad, pad + 30 * k + i * 15 * k));
    if (errors.length > 1 && said.length < room) {
      ctx.fillStyle = "rgba(243, 220, 217, 0.6)";
      ctx.fillText(`and ${errors.length - 1} more`, pad, pad + 30 * k + said.length * 15 * k);
    }
  }

  function note(L, title, text) {
    const c = L.canvas;
    const ctx = L.ctx;
    const k = Math.max(0.5, Math.min(3, L.ratio || 1));
    ctx.fillStyle = "#26262b";
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.fillStyle = "#e6e6ea";
    ctx.font = `600 ${12 * k}px system-ui, sans-serif`;
    ctx.fillText(title, 12 * k, 22 * k);
    ctx.fillStyle = "#a9a9b2";
    ctx.font = `${11 * k}px system-ui, sans-serif`;
    ctx.fillText(text, 12 * k, 40 * k);
    L.dirty = false;
  }

  function badge(L, text) {
    const ctx = L.ctx;
    const k = Math.max(0.5, Math.min(3, L.ratio || 1));
    ctx.font = `500 ${11 * k}px system-ui, sans-serif`;
    const w = ctx.measureText(text).width + 16 * k;
    const h = 20 * k;
    const x = 8 * k;
    const y = L.canvas.height - h - 8 * k;
    ctx.fillStyle = "rgba(12, 12, 14, 0.72)";
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(x, y, w, h, h / 2);
    else ctx.rect(x, y, w, h);
    ctx.fill();
    ctx.fillStyle = "#fff";
    ctx.fillText(text, x + 8 * k, y + 14 * k);
  }

  // -------------------------------------------------------------------------------------------
  // The loop

  function wake() {
    if (!raf && layers.size && typeof requestAnimationFrame === "function") raf = requestAnimationFrame(tick);
  }

  function tick() {
    raf = 0;
    frameNo++;
    const t = now();
    let moving = false;
    try {
      moving = opts.mode === "live" && Boolean(opts.moving());
    } catch {}
    if (moving) movingUntil = t + 160;
    const isMoving = t < movingUntil;
    // Once the view stops, everything is drawn sharp again.
    if (wasMoving && !isMoving) for (const L of layers) L.dirty = true;
    wasMoving = isMoving;
    // Another frame only while there's something to do: a layer playing in view, one still to
    // draw, the view moving. Otherwise the loop sleeps until something wakes it (a change, a
    // resize, a layer coming into view, the board's view moving).
    let again = isMoving;
    for (const L of [...layers]) {
      // Gone from the page (its element removed): let it go.
      if (!L.canvas.isConnected) {
        if (++L.gone > 2) detach(L);
        else again = true;
        continue;
      }
      L.gone = 0;
      if (L.vars && t - L.resolvedAt > 1000) {
        L.resolve();
        L.dirty = true;
      }
      const resized = fit(L, isMoving);
      if (!L.visible && opts.mode === "live") continue;
      if (L.plays() || resized || L.dirty) draw(L);
      if (L.plays() || (L.dirty && L.cssW > 0 && L.cssH > 0)) again = true;
    }
    // All of them together too slow (each one may be fine): every half second, the costliest takes a strike.
    if (frameNo % 30 === 0) {
      let total = 0;
      let worst = null;
      for (const L of layers)
        if (L.visible && L.plays() && L.probes) {
          total += L.cost;
          if (!worst || L.cost > worst.cost) worst = L;
        }
      if (worst && total > opts.budget * 1.5) strike(worst);
    }
    if (again && layers.size) raf = requestAnimationFrame(tick);
  }

  // -------------------------------------------------------------------------------------------
  // Attaching layers

  function observe(L) {
    const root = (opts.root && opts.root()) || null;
    if (typeof IntersectionObserver !== "function") return;
    if (!io || ioRoot !== root) {
      if (io) io.disconnect();
      ioRoot = root;
      io = new IntersectionObserver(
        (entries) => {
          for (const en of entries) {
            const x = byCanvas.get(en.target);
            if (!x) continue;
            const was = x.visible;
            x.visible = en.isIntersecting;
            if (x.visible && !was) {
              x.dirty = true;
              wake();
            }
          }
        },
        { root, rootMargin: "80px" },
      );
      for (const x of layers) io.observe(x.canvas);
    } else io.observe(L.canvas);
  }

  function resized(entries) {
    for (const en of entries) {
      const L = byCanvas.get(en.target);
      if (!L) continue;
      const box = en.contentBoxSize && en.contentBoxSize[0];
      L.cssW = box ? box.inlineSize : en.contentRect.width;
      L.cssH = box ? box.blockSize : en.contentRect.height;
      L.dirty = true;
    }
    wake();
  }

  function handle(L) {
    return {
      canvas: L.canvas,
      update(data) {
        L.set(data);
        wake();
      },
      detach: () => detach(L),
      /** Play again after the guard stopped it. */
      retry() {
        L.again();
        L.dirty = true;
        wake();
      },
      state: () => L.stateObj || null,
      /** The moment it shows now, in seconds of its time. */
      shown: () => (L.plays() ? L.shown() : L.time),
    };
  }

  /** Draw a shader in a canvas from now on: { code, uniforms, speed, time, paused }. */
  function attach(canvas, data) {
    let L = byCanvas.get(canvas);
    if (!L) {
      L = new Layer(canvas);
      layers.add(L);
      byCanvas.set(canvas, L);
      observe(L);
      if (typeof ResizeObserver === "function") (ro = ro || new ResizeObserver(resized)).observe(canvas);
    }
    L.set(data);
    wake();
    return handle(L);
  }

  function detach(L) {
    if (!layers.has(L)) return;
    layers.delete(L);
    byCanvas.delete(L.canvas);
    if (io) io.unobserve(L.canvas);
    if (ro) ro.unobserve(L.canvas);
  }

  const parse = (s) => {
    try {
      return s ? JSON.parse(s) : undefined;
    } catch {
      return undefined;
    }
  };

  /** What a shader layer written as HTML says: data-code, data-uniforms (or data-params), data-speed, data-time, data-paused. */
  function dataOf(el) {
    const d = el.dataset;
    let uniforms = parse(d.uniforms);
    if (!uniforms) {
      uniforms = {};
      const params = parse(d.params) || {};
      for (const [k, v] of Object.entries(params)) uniforms[/^u[A-Z0-9]/.test(k) ? k : `u${k.charAt(0).toUpperCase()}${k.slice(1)}`] = v;
    }
    const n = (v, def) => (v === undefined || v === "" || !Number.isFinite(Number(v)) ? def : Number(v));
    return { code: d.code || "", uniforms, speed: n(d.speed, 1), time: n(d.time, 0), paused: d.paused !== undefined && d.paused !== "false" };
  }

  /** Draw every shader layer written in a page (elements with data-shader); let go of those no longer there. */
  function scan(root) {
    const doc = root || (typeof document !== "undefined" ? document : null);
    if (!doc) return 0;
    for (const L of [...layers]) if (!L.canvas.isConnected) detach(L);
    let n = 0;
    for (const el of doc.querySelectorAll("[data-shader]")) {
      let canvas = el.tagName === "CANVAS" ? el : [...el.children].find((c) => c.tagName === "CANVAS");
      if (!canvas) {
        canvas = document.createElement("canvas");
        canvas.style.cssText = "display:block;width:100%;height:100%;border-radius:inherit";
        el.appendChild(canvas);
      }
      attach(canvas, dataOf(el));
      n++;
    }
    return n;
  }

  /** Scan the page once it's there. */
  function auto(o) {
    if (o) configure(o);
    if (typeof document === "undefined") return;
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => scan(document), { once: true });
    else scan(document);
  }

  /**
   * Draw every layer now, at the size it shows (for a picture of the page), and resolve once the
   * drawing is on screen.
   */
  function ready() {
    for (const L of layers) {
      if (!L.canvas.isConnected) continue;
      L.cssW = L.canvas.clientWidth;
      L.cssH = L.canvas.clientHeight;
      fit(L, false);
      draw(L);
    }
    return new Promise((done) => {
      if (typeof requestAnimationFrame !== "function") return done(stats());
      requestAnimationFrame(() => requestAnimationFrame(() => done(stats())));
    });
  }

  function configure(o) {
    const root = opts.root;
    Object.assign(opts, o || {});
    if (o && "root" in o && o.root !== root) {
      if (io) io.disconnect();
      io = null;
      ioRoot = null;
      for (const L of layers) observe(L);
    }
    for (const L of layers) L.dirty = true;
    wake();
  }

  /** How things stand, for tests: contexts made, and each layer's state, frames drawn and size. */
  function stats() {
    return {
      contexts,
      webgl: gl2 ? 2 : gl ? 1 : 0,
      reduced: reduce,
      layers: [...layers].map((L) => ({ layer: L.canvas.dataset.layer || null, state: L.stateObj ? L.stateObj.kind : "", frames: L.frames, width: L.canvas.width, height: L.canvas.height, visible: L.visible, quality: L.quality, cost: Math.round(L.cost * 100) / 100, probes: L.probes, strikes: L.strikes, probeAt: L.probeAt, frame: frameNo })),
    };
  }

  G.BoardShaders = { attach, scan, auto, ready, compile, configure, stats, wake, prepare, version: 1 };
})();
