// Optical & layer effects runtime for Glassine boards (Liquid Glass, Pattern refraction, Lens
// distortion, Warp, Moving blobs, Slice shift, Pixel stretch, Pixelate, Gooey merge, Bloom, Bokeh
// blur, Gradient map, Color adjust, CRT screen, Outlines and Chromatic metal).
//
// Plain self-contained script (sets globalThis.BoardEffects), shared identically by the Studio
// canvas, Preview, headless Chrome exports / Bitmap LOD and Copy as HTML. Uses Chromium's native
// GPU-composited SVG filter graphs (`backdrop-filter: url(#…)` and `filter: url(#…)`) with cached
// procedural displacement maps and crisp directional Fresnel specular rim canvases.
(function () {
  "use strict";
  const G = typeof globalThis !== "undefined" ? globalThis : window;
  if (G.BoardEffects) return;

  const NS = "http://www.w3.org/2000/svg";
  const MAX_CACHE = 96;
  const mapCache = new Map();
  const filterCounts = new Map();
  let defsSvg = null;
  let defsEl = null;
  let serial = 0;

  function ensureDefs() {
    if (defsEl && defsSvg?.isConnected) return defsEl;
    defsSvg = document.getElementById("bd-fx-defs-svg");
    if (!defsSvg) {
      defsSvg = document.createElementNS(NS, "svg");
      defsSvg.id = "bd-fx-defs-svg";
      defsSvg.setAttribute("width", "0");
      defsSvg.setAttribute("height", "0");
      defsSvg.setAttribute("aria-hidden", "true");
      defsSvg.style.cssText = "position:fixed;left:-9999px;top:-9999px;width:0;height:0;pointer-events:none;overflow:hidden";
      defsEl = document.createElementNS(NS, "defs");
      defsSvg.appendChild(defsEl);
      (document.body || document.documentElement).appendChild(defsSvg);
    } else {
      defsEl = defsSvg.querySelector("defs") || defsSvg.appendChild(document.createElementNS(NS, "defs"));
    }
    return defsEl;
  }

  function cacheGet(key, build) {
    const hit = mapCache.get(key);
    if (hit !== undefined) {
      mapCache.delete(key);
      mapCache.set(key, hit);
      return hit;
    }
    const val = build();
    if (mapCache.size >= MAX_CACHE) {
      const oldest = mapCache.keys().next().value;
      if (oldest !== undefined) mapCache.delete(oldest);
    }
    mapCache.set(key, val);
    return val;
  }

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const clampByte = (v) => (v <= 0 ? 0 : v >= 255 ? 255 : Math.round(v));

  /** Resolve a CSS colour (including var(--token)) to [r, g, b] in 0..1. */
  let probeCtx = null;
  function parseColor(css, el) {
    if (!probeCtx) {
      const c = document.createElement("canvas");
      c.width = c.height = 1;
      probeCtx = c.getContext("2d", { willReadFrequently: true });
    }
    let val = String(css || "#ffffff").trim();
    if (/^var\(/i.test(val) && el) {
      const m = /var\(\s*(--[\w-]+)\s*(?:,\s*([^)]+))?\)/.exec(val);
      if (m) {
        const resolved = getComputedStyle(el).getPropertyValue(m[1]).trim();
        val = resolved || (m[2] ? m[2].trim() : "#ffffff");
      }
    }
    probeCtx.clearRect(0, 0, 1, 1);
    probeCtx.fillStyle = "#000000";
    probeCtx.fillStyle = val;
    probeCtx.fillRect(0, 0, 1, 1);
    const d = probeCtx.getImageData(0, 0, 1, 1).data;
    return [d[0] / 255, d[1] / 255, d[2] / 255, d[3] / 255];
  }

  /** Read actual element geometry & per-corner border radii in local design CSS px. */
  function readGeom(el) {
    const cs = getComputedStyle(el);
    const W = Math.max(1, el.offsetWidth || parseFloat(cs.width) || 100);
    const H = Math.max(1, el.offsetHeight || parseFloat(cs.height) || 100);
    const maxR = Math.min(W, H) * 0.5;
    const rad = (prop) => {
      const raw = cs[prop] || "0";
      const n = parseFloat(raw) || 0;
      return clamp(raw.includes("%") ? (n / 100) * Math.min(W, H) : n, 0, maxR);
    };
    return {
      W,
      H,
      rTL: rad("borderTopLeftRadius"),
      rTR: rad("borderTopRightRadius"),
      rBR: rad("borderBottomRightRadius"),
      rBL: rad("borderBottomLeftRadius"),
    };
  }

  /** Signed distance (positive inside, 0 at outer rim) & inward unit normal for a 4-corner rounded rect. */
  function rrectSdf(x, y, W, H, rTL, rTR, rBR, rBL) {
    const halfW = W * 0.5;
    const halfH = H * 0.5;
    const px = x - halfW;
    const py = y - halfH;
    const r = px < 0 ? (py < 0 ? rTL : rBL) : py < 0 ? rTR : rBR;
    const bx = halfW - r;
    const by = halfH - r;
    const ax = Math.abs(px) - bx;
    const ay = Math.abs(py) - by;
    const qx = Math.max(ax, 0);
    const qy = Math.max(ay, 0);
    const outLen = Math.hypot(qx, qy);
    const inDist = Math.min(Math.max(ax, ay), 0);
    const sd = r - (outLen + inDist);
    let nx = 0;
    let ny = 0;
    if (outLen > 1e-4) {
      nx = -(qx / outLen) * (px < 0 ? -1 : 1);
      ny = -(qy / outLen) * (py < 0 ? -1 : 1);
    } else if (ax > ay) {
      nx = px < 0 ? 1 : -1;
    } else {
      ny = py < 0 ? 1 : -1;
    }
    return { sd, nx, ny };
  }

  function makePng(w, h, fill) {
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    const ctx = c.getContext("2d");
    const img = ctx.createImageData(w, h);
    fill(img.data, w, h);
    ctx.putImageData(img, 0, 0);
    return c.toDataURL("image/png");
  }

  // Value noise + fbm for Moving blobs
  function hash2(ix, iy) {
    const n = Math.sin(ix * 127.1 + iy * 311.7) * 43758.5453123;
    return n - Math.floor(n);
  }
  function noise2(x, y) {
    const ix = Math.floor(x), iy = Math.floor(y);
    const fx = x - ix, fy = y - iy;
    const ux = fx * fx * (3 - 2 * fx);
    const uy = fy * fy * (3 - 2 * fy);
    const a = hash2(ix, iy), b = hash2(ix + 1, iy);
    const c = hash2(ix, iy + 1), d = hash2(ix + 1, iy + 1);
    return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
  }
  function fbm2(x, y) {
    let v = 0, amp = 0.5;
    for (let i = 0; i < 4; i++) {
      v += amp * noise2(x, y);
      x = x * 2.02 + 13.7;
      y = y * 2.02 - 9.3;
      amp *= 0.5;
    }
    return v;
  }

  // -------------------------------------------------------------------------------------------
  // Specular rim highlight overlay for Liquid Glass & Pattern Refraction

  function drawGlassSpecular(canvas, geom, fx) {
    const { W, H, rTL, rTR, rBR, rBL } = geom;
    // Cap rim canvas at 256px (smooth Fresnel glow upscales cleanly on GPU at 9x less CPU work)
    const sW = clamp(Math.round(W), 48, 256);
    const sH = clamp(Math.round(H), 48, 256);
    if (canvas.width !== sW) canvas.width = sW;
    if (canvas.height !== sH) canvas.height = sH;
    const ctx = canvas.getContext("2d");
    const img = ctx.createImageData(sW, sH);
    const d = img.data;

    if (fx.type === "glass") {
      const li = clamp(Number(fx.lightIntensity ?? 80) / 100, 0, 1);
      if (li <= 0.005) {
        ctx.clearRect(0, 0, sW, sH);
        return;
      }
      const rad = (Number(fx.lightAngle ?? -60) * Math.PI) / 180;
      const lx = Math.cos(rad);
      const ly = Math.sin(rad);
      const maxR = Math.min(W, H) * 0.5;
      const depth = clamp(Number(fx.depth ?? 65) / 100, 0, 1);
      const splay = clamp(Number(fx.splay ?? 0) / 100, 0, 1);
      const bevel = Math.max(4, maxR * (0.08 + 0.54 * depth + 0.34 * splay * depth));
      const rimBand = clamp(bevel * 0.36, 3, 28);
      const invRim = 1 / rimBand;
      const skipDist = rimBand * 3.8 + 4;
      const innerX0 = skipDist, innerX1 = W - skipDist;
      const innerY0 = skipDist, innerY1 = H - skipDist;
      const hasInner = innerX1 > innerX0 && innerY1 > innerY0;
      const scaleX = W / sW;
      const scaleY = H / sH;
      for (let j = 0; j < sH; j++) {
        const y = (j + 0.5) * scaleY;
        const yInner = hasInner && y > innerY0 && y < innerY1;
        const rowOff = j * sW;
        for (let i = 0; i < sW; i++) {
          const x = (i + 0.5) * scaleX;
          if (yInner && x > innerX0 && x < innerX1) continue;
          const { sd, nx, ny } = rrectSdf(x, y, W, H, rTL, rTR, rBR, rBL);
          if (sd <= 0 || sd > skipDist) continue;
          const dot = -nx * lx - ny * ly;
          const primary = dot > 0 ? dot * dot * Math.sqrt(dot) : 0;
          const opposite = dot < 0 ? (-dot) * (-dot) * (-dot) * 0.52 : 0;
          const sharpEdge = sd < 10 ? Math.exp(-sd * 0.645) * (0.28 + 0.85 * primary + 0.48 * opposite) : 0;
          const bevelGlow = Math.exp(-sd * invRim) * (primary * 0.44 + opposite * 0.22);
          const a = (sharpEdge + bevelGlow) * li;
          if (a < 0.004) continue;
          const idx = (rowOff + i) * 4;
          d[idx] = 255;
          d[idx + 1] = 255;
          d[idx + 2] = 255;
          d[idx + 3] = a >= 1 ? 255 : Math.round(a * 255);
        }
      }
      ctx.putImageData(img, 0, 0);
      return;
    }

    if (fx.type === "pattern-refraction") {
      // Subtle glossy highlight along each optical rib peak
      const strength = clamp(Number(fx.strength ?? 55) / 100, 0, 1);
      if (strength <= 0.02) {
        ctx.clearRect(0, 0, sW, sH);
        return;
      }
      const period = Math.max(6, (Number(fx.scale ?? 12) / 100) * Math.min(W, H));
      const ang = (Number(fx.angle ?? 45) * Math.PI) / 180;
      const ca = Math.cos(ang), sa = Math.sin(ang);
      const pat = fx.pattern || "lenticular";
      const invPeriod = 1 / period;
      const scaleX = W / sW;
      const scaleY = H / sH;
      for (let j = 0; j < sH; j++) {
        const y = (j + 0.5) * scaleY;
        const rowOff = j * sW;
        for (let i = 0; i < sW; i++) {
          const x = (i + 0.5) * scaleX;
          const u = x * ca + y * sa;
          const v = -x * sa + y * ca;
          let sheen = 0;
          if (pat === "lenticular" || pat === "fluted") {
            const ph = ((u * invPeriod) % 1 + 1) % 1;
            const s = Math.sin(ph * Math.PI);
            sheen = s > 0 ? s * s * s * s * s * s * 0.22 : 0;
          } else if (pat === "waves") {
            const wv = u + Math.sin(v * invPeriod * 1.4) * period * 0.65;
            const ph = ((wv * invPeriod) % 1 + 1) % 1;
            const s = Math.sin(ph * Math.PI);
            sheen = s > 0 ? s * s * s * s * s * s * 0.2 : 0;
          } else if (pat === "ripple") {
            const r = Math.hypot(x - W * 0.5, y - H * 0.5);
            const ph = ((r * invPeriod) % 1 + 1) % 1;
            const s = Math.sin(ph * Math.PI);
            sheen = s > 0 ? s * s * s * s * s * s * 0.2 : 0;
          } else if (pat === "mosaic" || pat === "crosshatch") {
            const pu = ((u * invPeriod) % 1 + 1) % 1;
            const pv = ((v * invPeriod) % 1 + 1) % 1;
            const edge = Math.min(pu, 1 - pu, pv, 1 - pv);
            sheen = Math.exp(-edge * 14) * 0.22;
          }
          const a = clamp(sheen * strength, 0, 0.35);
          if (a < 0.004) continue;
          const idx = (rowOff + i) * 4;
          d[idx] = 255;
          d[idx + 1] = 255;
          d[idx + 2] = 255;
          d[idx + 3] = Math.round(a * 255);
        }
      }
      ctx.putImageData(img, 0, 0);
      return;
    }
    ctx.clearRect(0, 0, sW, sH);
  }

  // -------------------------------------------------------------------------------------------
  // SVG <filter> builders for all 16 effects

  /** Emit a displacement + optional RGB chromatic dispersion pipeline from `inName` to `outName`. */
  function displaceStage(inName, outName, mapUrl, W, H, scale, dispersionFrac, blurPx) {
    const pre = blurPx > 0.05 ? `<feGaussianBlur in="${inName}" stdDeviation="${blurPx.toFixed(2)}" result="${outName}_s"/>` : "";
    const src = pre ? `${outName}_s` : inName;
    if (Math.abs(scale) < 0.05) {
      return pre ? `${pre}<feOffset in="${src}" dx="0" dy="0" result="${outName}"/>` : `<feOffset in="${inName}" dx="0" dy="0" result="${outName}"/>`;
    }
    const map = `<feImage href="${mapUrl}" x="0" y="0" width="${W}" height="${H}" preserveAspectRatio="none" result="${outName}_m"/>`;
    if (dispersionFrac > 0.004) {
      const sR = scale * (1 - dispersionFrac);
      const sG = scale;
      const sB = scale * (1 + dispersionFrac);
      return `${pre}${map}
        <feDisplacementMap in="${src}" in2="${outName}_m" scale="${sR.toFixed(2)}" xChannelSelector="R" yChannelSelector="G" result="${outName}_dr"/>
        <feDisplacementMap in="${src}" in2="${outName}_m" scale="${sG.toFixed(2)}" xChannelSelector="R" yChannelSelector="G" result="${outName}_dg"/>
        <feDisplacementMap in="${src}" in2="${outName}_m" scale="${sB.toFixed(2)}" xChannelSelector="R" yChannelSelector="G" result="${outName}_db"/>
        <feColorMatrix in="${outName}_dr" type="matrix" values="1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0" result="${outName}_r"/>
        <feColorMatrix in="${outName}_dg" type="matrix" values="0 0 0 0 0  0 1 0 0 0  0 0 0 0 0  0 0 0 1 0" result="${outName}_g"/>
        <feColorMatrix in="${outName}_db" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 1 0 0  0 0 0 1 0" result="${outName}_b"/>
        <feComposite in="${outName}_r" in2="${outName}_g" operator="arithmetic" k1="0" k2="1" k3="1" k4="0" result="${outName}_rg"/>
        <feComposite in="${outName}_rg" in2="${outName}_b" operator="arithmetic" k1="0" k2="1" k3="1" k4="0" result="${outName}"/>`;
    }
    return `${pre}${map}<feDisplacementMap in="${src}" in2="${outName}_m" scale="${scale.toFixed(2)}" xChannelSelector="R" yChannelSelector="G" result="${outName}"/>`;
  }

  function buildStage(fx, inName, outName, geom, el) {
    const { W, H, rTL, rTR, rBR, rBL } = geom;
    // Smooth optical displacement maps interpolate cleanly on GPU at 128px (4x faster to build & decode)
    const mapW = clamp(Math.round(W * 0.5), 48, 128);
    const mapH = clamp(Math.round(H * 0.5), 48, 128);
    const hiW = clamp(Math.round(W * 0.75), 64, 192);
    const hiH = clamp(Math.round(H * 0.75), 64, 192);

    switch (fx.type) {
      case "glass": {
        const refr = clamp(Number(fx.refraction ?? 80) / 100, 0, 1);
        const depth = clamp(Number(fx.depth ?? 65) / 100, 0, 1);
        const disp = clamp(Number(fx.dispersion ?? 50) / 100, 0, 1);
        const frost = clamp(Number(fx.frost ?? 6) / 100, 0, 1);
        const splay = clamp(Number(fx.splay ?? 0) / 100, 0, 1);
        const maxR = Math.min(W, H) * 0.5;
        const bevel = Math.max(4, maxR * (0.08 + 0.54 * depth + 0.36 * splay * depth));
        const power = 3.8 - splay * 2.1;
        const scale = refr * Math.min(maxR * 0.56, 76);
        const key = `glass:${Math.round(W)}x${Math.round(H)}:${Math.round(rTL)},${Math.round(rTR)},${Math.round(rBR)},${Math.round(rBL)}:${bevel.toFixed(1)}:${power.toFixed(2)}`;
        const url = cacheGet(key, () =>
          makePng(mapW, mapH, (data, mw, mh) => {
            for (let j = 0; j < mh; j++) {
              const y = ((j + 0.5) / mh) * H;
              for (let i = 0; i < mw; i++) {
                const x = ((i + 0.5) / mw) * W;
                const { sd, nx, ny } = rrectSdf(x, y, W, H, rTL, rTR, rBR, rBL);
                const idx = (j * mw + i) * 4;
                if (sd <= 0 || sd >= bevel) {
                  data[idx] = 128; data[idx + 1] = 128; data[idx + 2] = 128; data[idx + 3] = 255;
                  continue;
                }
                const t = sd / bevel; // 0 at rim, 1 at inner end of bevel
                // Smoothstep roll-off so center stays crystal-clear with zero stray fringing
                const u = 1 - t;
                const smooth = u * u * (3 - 2 * u);
                const mag = Math.pow(smooth, power * 0.52);
                data[idx] = clampByte(128 + nx * mag * 127);
                data[idx + 1] = clampByte(128 + ny * mag * 127);
                data[idx + 2] = 128;
                data[idx + 3] = 255;
              }
            }
          }),
        );
        const dispFrac = disp * 0.19;
        const blurPx = frost * 18;
        return displaceStage(inName, outName, url, W, H, scale, dispFrac, blurPx);
      }

      case "pattern-refraction": {
        const pat = String(fx.pattern || "lenticular");
        const strength = clamp(Number(fx.strength ?? 55) / 100, 0, 1);
        const smooth = clamp(Number(fx.smoothness ?? 15) / 100, 0, 1);
        const frost = clamp(Number(fx.frost ?? 0) / 100, 0, 1);
        const disp = clamp(Number(fx.dispersion ?? 25) / 100, 0, 1);
        const sc = clamp(Number(fx.scale ?? 12) / 100, 0.02, 1);
        const angle = Number(fx.angle ?? 45);
        const period = Math.max(6, sc * Math.min(W, H));
        const rad = (angle * Math.PI) / 180;
        const ca = Math.cos(rad), sa = Math.sin(rad);
        const scale = strength * Math.min(period * 1.15, 64);
        const key = `pat:${pat}:${Math.round(W)}x${Math.round(H)}:${period.toFixed(1)}:${Math.round(angle)}:${smooth.toFixed(2)}`;
        const url = cacheGet(key, () =>
          makePng(hiW, hiH, (data, mw, mh) => {
            for (let j = 0; j < mh; j++) {
              const y = ((j + 0.5) / mh) * H;
              for (let i = 0; i < mw; i++) {
                const x = ((i + 0.5) / mw) * W;
                const u = x * ca + y * sa;
                const v = -x * sa + y * ca;
                let du = 0, dv = 0;
                if (pat === "lenticular") {
                  const ph = (((u / period) % 1) + 1) % 1;
                  const saw = (ph - 0.5) * 2;
                  du = saw * (1 - smooth * 0.45) + Math.sin(ph * Math.PI * 2) * smooth * 0.45;
                } else if (pat === "fluted") {
                  du = Math.cos((u / period) * Math.PI * 2);
                } else if (pat === "waves") {
                  const wv = u + Math.sin((v / period) * 1.35) * period * 0.7;
                  const ph = (((wv / period) % 1) + 1) % 1;
                  const saw = (ph - 0.5) * 2;
                  du = saw * (1 - smooth * 0.5) + Math.sin(ph * Math.PI * 2) * smooth * 0.5;
                  dv = Math.cos((v / period) * 1.35) * 0.35;
                } else if (pat === "ripple") {
                  const rx = x - W * 0.5, ry = y - H * 0.5;
                  const r = Math.hypot(rx, ry) || 1;
                  const w = Math.sin((r / period) * Math.PI * 2);
                  du = (rx / r) * w;
                  dv = (ry / r) * w;
                  const idx = (j * mw + i) * 4;
                  data[idx] = clampByte(128 + du * 127);
                  data[idx + 1] = clampByte(128 + dv * 127);
                  data[idx + 2] = 128;
                  data[idx + 3] = 255;
                  continue;
                } else if (pat === "mosaic") {
                  const pu = (((u / period) % 1) + 1) % 1 - 0.5;
                  const pv = (((v / period) % 1) + 1) % 1 - 0.5;
                  du = pu * 2;
                  dv = pv * 2;
                } else {
                  // crosshatch
                  du = Math.sin((u / period) * Math.PI * 2);
                  dv = Math.sin((v / period) * Math.PI * 2);
                }
                const dx = du * ca - dv * sa;
                const dy = du * sa + dv * ca;
                const idx = (j * mw + i) * 4;
                data[idx] = clampByte(128 + dx * 127);
                data[idx + 1] = clampByte(128 + dy * 127);
                data[idx + 2] = 128;
                data[idx + 3] = 255;
              }
            }
          }),
        );
        return displaceStage(inName, outName, url, W, H, scale, disp * 0.22, frost * 16, disp * 0.6);
      }

      case "lens-distortion": {
        const dist = clamp(Number(fx.distortion ?? 0.5), -1, 1);
        const aberr = clamp(Number(fx.aberration ?? 0.25), 0, 1);
        const cx = clamp(Number(fx.centerX ?? 50) / 100, 0, 1);
        const cy = clamp(Number(fx.centerY ?? 50) / 100, 0, 1);
        const mode = String(fx.mode || "lateral");
        const maxScale = Math.min(W, H) * 0.28;
        const scale = (Math.abs(dist) > 0.01 ? dist : aberr * 0.25) * maxScale;
        const key = `lens:${Math.round(W)}x${Math.round(H)}:${cx.toFixed(2)},${cy.toFixed(2)}:${mode}`;
        const url = cacheGet(key, () =>
          makePng(mapW, mapH, (data, mw, mh) => {
            for (let j = 0; j < mh; j++) {
              const ny = (j + 0.5) / mh - cy;
              for (let i = 0; i < mw; i++) {
                const nx = (i + 0.5) / mw - cx;
                const r2 = nx * nx + ny * ny;
                const f = Math.min(1, r2 * 2.2);
                const dx = mode === "lateral" ? nx * f * 2 : nx * Math.sqrt(r2) * 2.2;
                const dy = mode === "lateral" ? ny * f * 2 : ny * Math.sqrt(r2) * 2.2;
                const idx = (j * mw + i) * 4;
                data[idx] = clampByte(128 + clamp(dx, -1, 1) * 127);
                data[idx + 1] = clampByte(128 + clamp(dy, -1, 1) * 127);
                data[idx + 2] = 128;
                data[idx + 3] = 255;
              }
            }
          }),
        );
        return displaceStage(inName, outName, url, W, H, scale, aberr * 0.35, 0, aberr * 0.8);
      }

      case "warp": {
        const style = String(fx.style || "ripple");
        const strength = clamp(Number(fx.strength ?? 55) / 100, 0, 1);
        const freq = clamp(Number(fx.frequency ?? 6), 1, 20);
        const cx = clamp(Number(fx.centerX ?? 50) / 100, 0, 1);
        const cy = clamp(Number(fx.centerY ?? 50) / 100, 0, 1);
        const ang = (Number(fx.angle ?? 0) * Math.PI) / 180;
        const scale = strength * Math.min(W, H) * 0.22;
        const key = `warp:${style}:${Math.round(W)}x${Math.round(H)}:${freq.toFixed(1)}:${cx.toFixed(2)},${cy.toFixed(2)}:${Math.round(Number(fx.angle ?? 0))}`;
        const url = cacheGet(key, () =>
          makePng(mapW, mapH, (data, mw, mh) => {
            const ca = Math.cos(ang), sa = Math.sin(ang);
            for (let j = 0; j < mh; j++) {
              const py = (j + 0.5) / mh - cy;
              for (let i = 0; i < mw; i++) {
                const px = (i + 0.5) / mw - cx;
                const r = Math.hypot(px, py) || 1e-4;
                let dx = 0, dy = 0;
                if (style === "ripple") {
                  const w = Math.sin(r * freq * Math.PI * 2);
                  dx = (px / r) * w;
                  dy = (py / r) * w;
                } else if (style === "swirl") {
                  const fall = Math.max(0, 1 - r * 1.8);
                  const a = fall * fall * freq * 0.6;
                  const rx = px * Math.cos(a) - py * Math.sin(a) - px;
                  const ry = px * Math.sin(a) + py * Math.cos(a) - py;
                  dx = clamp(rx * 3.5, -1, 1);
                  dy = clamp(ry * 3.5, -1, 1);
                } else if (style === "wave") {
                  const u = px * ca + py * sa;
                  const v = -px * sa + py * ca;
                  const w = Math.sin(u * freq * Math.PI * 2);
                  const w2 = Math.cos(v * freq * Math.PI * 1.5) * 0.3;
                  dx = clamp(w * -sa + w2 * ca, -1, 1);
                  dy = clamp(w * ca + w2 * sa, -1, 1);
                } else {
                  // bulge
                  const fall = Math.max(0, 1 - r * 2);
                  const m = fall * fall;
                  dx = clamp(-px * m * 2.5, -1, 1);
                  dy = clamp(-py * m * 2.5, -1, 1);
                }
                const idx = (j * mw + i) * 4;
                data[idx] = clampByte(128 + dx * 127);
                data[idx + 1] = clampByte(128 + dy * 127);
                data[idx + 2] = 128;
                data[idx + 3] = 255;
              }
            }
          }),
        );
        return displaceStage(inName, outName, url, W, H, scale, 0, 0, 0);
      }

      case "moving-blobs": {
        const strength = clamp(Number(fx.strength ?? 55) / 100, 0, 1);
        const sc = clamp(Number(fx.scale ?? 3.5), 0.5, 12);
        const disp = clamp(Number(fx.dispersion ?? 35) / 100, 0, 1);
        const seed = Number(fx.seed ?? 12) * 0.37;
        const scale = strength * Math.min(W, H) * 0.25;
        const key = `blobs:${Math.round(W)}x${Math.round(H)}:${sc.toFixed(2)}:${seed.toFixed(2)}`;
        const url = cacheGet(key, () =>
          makePng(mapW, mapH, (data, mw, mh) => {
            const asp = W / H;
            for (let j = 0; j < mh; j++) {
              const v = ((j + 0.5) / mh) * sc;
              for (let i = 0; i < mw; i++) {
                const u = ((i + 0.5) / mw) * sc * asp;
                const wx = fbm2(u + seed, v - seed * 0.6) - 0.5;
                const wy = fbm2(u + 4.3 - seed * 0.5, v + 2.1 + seed) - 0.5;
                const dx = (fbm2(u + wx * 2.4 + 1.7, v + wy * 2.4) - 0.5) * 2;
                const dy = (fbm2(u + wx * 2.4, v + wy * 2.4 + 8.3) - 0.5) * 2;
                const idx = (j * mw + i) * 4;
                data[idx] = clampByte(128 + clamp(dx, -1, 1) * 127);
                data[idx + 1] = clampByte(128 + clamp(dy, -1, 1) * 127);
                data[idx + 2] = 128;
                data[idx + 3] = 255;
              }
            }
          }),
        );
        return displaceStage(inName, outName, url, W, H, scale, disp * 0.24, 0, disp * 0.5);
      }

      case "slice-shift": {
        const slices = clamp(Math.round(Number(fx.slices ?? 10)), 2, 40);
        const offset = clamp(Number(fx.offset ?? 28), -100, 100);
        const angle = Number(fx.angle ?? 45);
        const dir = String(fx.direction || "parallel");
        const disp = clamp(Number(fx.dispersion ?? 12) / 100, 0, 1);
        const rad = (angle * Math.PI) / 180;
        const ca = Math.cos(rad), sa = Math.sin(rad);
        const scale = (Math.abs(offset) / 100) * Math.min(W, H) * 0.24;
        const sign = offset < 0 ? -1 : 1;
        const key = `slice:${slices}:${Math.round(angle)}:${dir}:${sign}`;
        const url = cacheGet(key, () =>
          makePng(mapW, mapH, (data, mw, mh) => {
            for (let j = 0; j < mh; j++) {
              const y = (j + 0.5) / mh - 0.5;
              for (let i = 0; i < mw; i++) {
                const x = (i + 0.5) / mw - 0.5;
                const across = x * ca + y * sa;
                const band = Math.floor((across + 1) * slices);
                const frac = ((across + 1) * slices) - band;
                let s = 0;
                if (dir === "parallel") s = (frac - 0.5) * 2;
                else if (dir === "zigzag") s = (band % 2 === 0 ? 1 : -1) * 0.85;
                else s = (hash2(band, 3.1) - 0.5) * 2;
                s *= sign;
                // Shift perpendicular to slice boundary
                const dx = -sa * s;
                const dy = ca * s;
                const idx = (j * mw + i) * 4;
                data[idx] = clampByte(128 + clamp(dx, -1, 1) * 127);
                data[idx + 1] = clampByte(128 + clamp(dy, -1, 1) * 127);
                data[idx + 2] = 128;
                data[idx + 3] = 255;
              }
            }
          }),
        );
        return displaceStage(inName, outName, url, W, H, scale, disp * 0.2, 0, disp * 0.4);
      }

      case "pixel-stretch": {
        const pos = clamp(Number(fx.position ?? 50) / 100, 0, 1);
        const dir = String(fx.direction || "right");
        const soft = clamp(Number(fx.smoothness ?? 0) / 100, 0, 1);
        const horiz = dir === "right" || dir === "left";
        const span = horiz ? W : H;
        // scale = span * 2 lets 127/255 encode up to +-span px displacement cleanly!
        const scale = span * 2;
        const key = `stretch:${dir}:${pos.toFixed(3)}:${soft.toFixed(2)}:${Math.round(span)}`;
        const url = cacheGet(key, () =>
          makePng(horiz ? Math.min(256, Math.max(64, Math.round(W))) : 4, horiz ? 4 : Math.min(256, Math.max(64, Math.round(H))), (data, mw, mh) => {
            for (let j = 0; j < mh; j++) {
              const fy = (j + 0.5) / mh;
              for (let i = 0; i < mw; i++) {
                const fx0 = (i + 0.5) / mw;
                let dx = 0, dy = 0;
                if (dir === "right" && fx0 > pos) dx = pos - fx0;
                else if (dir === "left" && fx0 < pos) dx = pos - fx0;
                else if (dir === "down" && fy > pos) dy = pos - fy;
                else if (dir === "up" && fy < pos) dy = pos - fy;
                const idx = (j * mw + i) * 4;
                // feDisplacementMap: P'(x) = P(x + scale * (R/255 - 0.5)); with scale = 2*span, offset = (pos - fx0) * span => R/255 - 0.5 = (pos - fx0) / 2
                data[idx] = clampByte(128 + dx * 127);
                data[idx + 1] = clampByte(128 + dy * 127);
                data[idx + 2] = 128;
                data[idx + 3] = 255;
              }
            }
          }),
        );
        return displaceStage(inName, outName, url, W, H, scale, 0, soft * 6, 0);
      }

      case "pixelate": {
        const size = clamp(Math.round(Number(fx.size ?? 12)), 2, 64);
        const half = Math.max(1, Math.floor(size / 2));
        // Pure GPU SVG mosaic: sample 1px at each cell center and dilate into razor-sharp blocks (zero seam artifacts, zero PNG encode)
        return `<feFlood x="${half}" y="${half}" width="1" height="1" flood-color="#ffffff" result="${outName}_pt"/>
          <feComposite in="${outName}_pt" x="0" y="0" width="${size}" height="${size}" result="${outName}_cell"/>
          <feTile in="${outName}_cell" result="${outName}_grid"/>
          <feComposite in="${inName}" in2="${outName}_grid" operator="in" result="${outName}_samp"/>
          <feMorphology in="${outName}_samp" operator="dilate" radius="${half}" result="${outName}_blk"/>
          <feComposite in="${outName}_blk" in2="${inName}" operator="in" result="${outName}"/>`;
      }

      case "gooey-merge": {
        const blur = clamp(Number(fx.blur ?? 10), 1, 40);
        const thresh = clamp(Number(fx.threshold ?? 50) / 100, 0.05, 0.95);
        const sharp = clamp(Number(fx.sharpness ?? 18), 4, 40);
        const intercept = -thresh * sharp;
        return `<feGaussianBlur in="${inName}" stdDeviation="${blur.toFixed(2)}" result="${outName}_b"/>
          <feColorMatrix in="${outName}_b" type="matrix" values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 ${sharp.toFixed(2)} ${intercept.toFixed(2)}" result="${outName}"/>`;
      }

      case "bloom": {
        const thresh = clamp(Number(fx.threshold ?? 55) / 100, 0, 0.98);
        const intensity = clamp(Number(fx.intensity ?? 95) / 100, 0, 2.5);
        const radius = clamp(Number(fx.radius ?? 18), 1, 60);
        const [tr, tg, tb] = parseColor(fx.tint || "#ffffff", el);
        const slope = 1 / Math.max(0.05, 1 - thresh);
        const intercept = -thresh * slope;
        const rM = (tr * intensity).toFixed(3);
        const gM = (tg * intensity).toFixed(3);
        const bM = (tb * intensity).toFixed(3);
        return `<feComponentTransfer in="${inName}" result="${outName}_hi">
            <feFuncR type="linear" slope="${slope.toFixed(3)}" intercept="${intercept.toFixed(3)}"/>
            <feFuncG type="linear" slope="${slope.toFixed(3)}" intercept="${intercept.toFixed(3)}"/>
            <feFuncB type="linear" slope="${slope.toFixed(3)}" intercept="${intercept.toFixed(3)}"/>
          </feComponentTransfer>
          <feGaussianBlur in="${outName}_hi" stdDeviation="${(radius * 0.45).toFixed(2)}" result="${outName}_b1"/>
          <feGaussianBlur in="${outName}_hi" stdDeviation="${radius.toFixed(2)}" result="${outName}_b2"/>
          <feBlend in="${outName}_b1" in2="${outName}_b2" mode="screen" result="${outName}_b"/>
          <feColorMatrix in="${outName}_b" type="matrix" values="${rM} 0 0 0 0  0 ${gM} 0 0 0  0 0 ${bM} 0 0  0 0 0 1 0" result="${outName}_t"/>
          <feBlend in="${inName}" in2="${outName}_t" mode="screen" result="${outName}"/>`;
      }

      case "bokeh-blur": {
        const radius = clamp(Number(fx.radius ?? 10), 1, 40);
        const boost = clamp(Number(fx.boost ?? 60) / 100, 0, 1);
        const thresh = clamp(Number(fx.threshold ?? 65) / 100, 0.1, 0.95);
        const slope = 1 / Math.max(0.08, 1 - thresh);
        const intercept = -thresh * slope;
        const dil = clamp(radius * 0.38, 1, 14);
        const k = (boost * 0.85).toFixed(3);
        return `<feGaussianBlur in="${inName}" stdDeviation="${(radius * 0.8).toFixed(2)}" result="${outName}_base"/>
          <feComponentTransfer in="${inName}" result="${outName}_hi">
            <feFuncR type="linear" slope="${slope.toFixed(3)}" intercept="${intercept.toFixed(3)}"/>
            <feFuncG type="linear" slope="${slope.toFixed(3)}" intercept="${intercept.toFixed(3)}"/>
            <feFuncB type="linear" slope="${slope.toFixed(3)}" intercept="${intercept.toFixed(3)}"/>
          </feComponentTransfer>
          <feMorphology in="${outName}_hi" operator="dilate" radius="${dil.toFixed(2)}" result="${outName}_disk"/>
          <feGaussianBlur in="${outName}_disk" stdDeviation="${(radius * 0.45).toFixed(2)}" result="${outName}_soft"/>
          <feColorMatrix in="${outName}_soft" type="matrix" values="${k} 0 0 0 0  0 ${k} 0 0 0  0 0 ${k} 0 0  0 0 0 1 0" result="${outName}_bk"/>
          <feBlend in="${outName}_base" in2="${outName}_bk" mode="screen" result="${outName}"/>`;
      }

      case "gradient-map": {
        const c0 = parseColor(fx.shadow || "#1b1464", el);
        const c1 = parseColor(fx.midtone || "#6d28d9", el);
        const c2 = parseColor(fx.highlight || "#f9a8d4", el);
        const mix = clamp(Number(fx.mix ?? 100) / 100, 0, 1);
        const table = (ch) => {
          const vals = [];
          for (let i = 0; i <= 16; i++) {
            const t = i / 16;
            const v = t < 0.5 ? c0[ch] + (c1[ch] - c0[ch]) * (t * 2) : c1[ch] + (c2[ch] - c1[ch]) * ((t - 0.5) * 2);
            vals.push(v.toFixed(4));
          }
          return vals.join(" ");
        };
        const mapped = `<feColorMatrix in="${inName}" type="matrix" values="0.2126 0.7152 0.0722 0 0  0.2126 0.7152 0.0722 0 0  0.2126 0.7152 0.0722 0 0  0 0 0 1 0" result="${outName}_lum"/>
          <feComponentTransfer in="${outName}_lum" result="${outName}_gm">
            <feFuncR type="table" tableValues="${table(0)}"/>
            <feFuncG type="table" tableValues="${table(1)}"/>
            <feFuncB type="table" tableValues="${table(2)}"/>
          </feComponentTransfer>`;
        if (mix >= 0.995) return `${mapped}<feOffset in="${outName}_gm" dx="0" dy="0" result="${outName}"/>`;
        return `${mapped}<feComposite in="${outName}_gm" in2="${inName}" operator="arithmetic" k1="0" k2="${mix.toFixed(3)}" k3="${(1 - mix).toFixed(3)}" k4="0" result="${outName}"/>`;
      }

      case "color-adjust": {
        const exp = Math.pow(2, clamp(Number(fx.exposure ?? 0), -100, 100) / 50);
        const con = 1 + clamp(Number(fx.contrast ?? 15), -100, 100) / 100;
        const sat = Math.max(0, 1 + clamp(Number(fx.saturation ?? 15), -100, 100) / 100);
        const temp = clamp(Number(fx.temperature ?? 0), -100, 100) / 250;
        const tint = clamp(Number(fx.tint ?? 0), -100, 100) / 250;
        const rS = (exp * con * (1 + temp)).toFixed(4);
        const gS = (exp * con * (1 - tint * 0.6)).toFixed(4);
        const bS = (exp * con * (1 - temp + tint * 0.4)).toFixed(4);
        const off = (0.5 * (1 - con)).toFixed(4);
        return `<feColorMatrix in="${inName}" type="saturate" values="${sat.toFixed(3)}" result="${outName}_sat"/>
          <feColorMatrix in="${outName}_sat" type="matrix" values="${rS} 0 0 0 ${off}  0 ${gS} 0 0 ${off}  0 0 ${bS} 0 ${off}  0 0 0 1 0" result="${outName}"/>`;
      }

      case "crt-screen": {
        const pitch = clamp(Math.round(Number(fx.scale ?? 4)), 2, 16);
        const scan = clamp(Number(fx.scanlines ?? 55) / 100, 0, 1);
        const glow = clamp(Number(fx.glow ?? 30) / 100, 0, 1);
        const curv = clamp(Number(fx.curvature ?? 18) / 100, 0, 1);
        const aberr = clamp(Number(fx.aberration ?? 30) / 100, 0, 1);
        // Subtle phosphor aperture grille + scanline tile
        const tileW = pitch * 3;
        const tileH = Math.max(2, pitch);
        const tileUrl = cacheGet(`crt:${tileW}x${tileH}:${scan.toFixed(2)}`, () =>
          makePng(tileW, tileH, (data, mw, mh) => {
            for (let j = 0; j < mh; j++) {
              const rowDim = j === mh - 1 && mh >= 3 ? 1 - scan * 0.72 : 1 - scan * 0.12;
              for (let i = 0; i < mw; i++) {
                const sub = Math.floor(i / pitch) % 3;
                const boost = 1 + scan * 0.25;
                const dim = 1 - scan * 0.55;
                const r = (sub === 0 ? boost : dim) * rowDim;
                const g = (sub === 1 ? boost : dim) * rowDim;
                const b = (sub === 2 ? boost : dim) * rowDim;
                const idx = (j * mw + i) * 4;
                data[idx] = clampByte(r * 255);
                data[idx + 1] = clampByte(g * 255);
                data[idx + 2] = clampByte(b * 255);
                data[idx + 3] = 255;
              }
            }
          }),
        );
        let stage = "";
        let cur = inName;
        if (curv > 0.02 || aberr > 0.02) {
          const lensUrl = cacheGet(`crt-lens:${Math.round(W)}x${Math.round(H)}`, () =>
            makePng(mapW, mapH, (data, mw, mh) => {
              for (let j = 0; j < mh; j++) {
                const ny = (j + 0.5) / mh - 0.5;
                for (let i = 0; i < mw; i++) {
                  const nx = (i + 0.5) / mw - 0.5;
                  const r2 = nx * nx + ny * ny;
                  const idx = (j * mw + i) * 4;
                  data[idx] = clampByte(128 + clamp(nx * r2 * 3, -1, 1) * 127);
                  data[idx + 1] = clampByte(128 + clamp(ny * r2 * 3, -1, 1) * 127);
                  data[idx + 2] = 128;
                  data[idx + 3] = 255;
                }
              }
            }),
          );
          stage += displaceStage(cur, `${outName}_c`, lensUrl, W, H, Math.max(curv * 32, aberr * 8), aberr * 0.28, 0, 0);
          cur = `${outName}_c`;
        }
        stage += `<feImage href="${tileUrl}" x="0" y="0" width="${tileW}" height="${tileH}" result="${outName}_pt"/>
          <feTile in="${outName}_pt" result="${outName}_grid"/>
          <feBlend in="${cur}" in2="${outName}_grid" mode="multiply" result="${outName}_m"/>`;
        if (glow > 0.02) {
          stage += `<feGaussianBlur in="${cur}" stdDeviation="${(glow * 5).toFixed(2)}" result="${outName}_gb"/>
            <feColorMatrix in="${outName}_gb" type="matrix" values="${(glow * 0.55).toFixed(3)} 0 0 0 0  0 ${(glow * 0.55).toFixed(3)} 0 0 0  0 0 ${(glow * 0.55).toFixed(3)} 0 0  0 0 0 1 0" result="${outName}_gt"/>
            <feBlend in="${outName}_m" in2="${outName}_gt" mode="screen" result="${outName}"/>`;
        } else {
          stage += `<feOffset in="${outName}_m" dx="0" dy="0" result="${outName}"/>`;
        }
        return stage;
      }

      case "outlines": {
        const thick = clamp(Number(fx.thickness ?? 2), 1, 8);
        const sens = clamp(Number(fx.threshold ?? 45) / 100, 0, 1);
        const ink = parseColor(fx.color || "#c4b5fd", el);
        const bg = parseColor(fx.background || "#0b0b12", el);
        const mix = clamp(Number(fx.mix ?? 100) / 100, 0, 1);
        const gain = 1.5 + sens * 7;
        const preBlur = thick > 1.5 ? `<feGaussianBlur in="${inName}" stdDeviation="${((thick - 1) * 0.55).toFixed(2)}" result="${outName}_pb"/>` : `<feOffset in="${inName}" dx="0" dy="0" result="${outName}_pb"/>`;
        const table = (ch) => `${bg[ch].toFixed(3)} ${ink[ch].toFixed(3)}`;
        const core = `${preBlur}
          <feColorMatrix in="${outName}_pb" type="matrix" values="0.2126 0.7152 0.0722 0 0  0.2126 0.7152 0.0722 0 0  0.2126 0.7152 0.0722 0 0  0 0 0 1 0" result="${outName}_gr"/>
          <feConvolveMatrix in="${outName}_gr" order="3" kernelMatrix="-1 -1 -1 -1 8 -1 -1 -1 -1" preserveAlpha="true" result="${outName}_ed"/>
          <feComponentTransfer in="${outName}_ed" result="${outName}_ed2">
            <feFuncR type="linear" slope="${gain.toFixed(2)}" intercept="-0.08"/>
            <feFuncG type="linear" slope="${gain.toFixed(2)}" intercept="-0.08"/>
            <feFuncB type="linear" slope="${gain.toFixed(2)}" intercept="-0.08"/>
          </feComponentTransfer>
          <feComponentTransfer in="${outName}_ed2" result="${outName}_col">
            <feFuncR type="table" tableValues="${table(0)}"/>
            <feFuncG type="table" tableValues="${table(1)}"/>
            <feFuncB type="table" tableValues="${table(2)}"/>
          </feComponentTransfer>`;
        if (mix >= 0.995) return `${core}<feComposite in="${outName}_col" in2="${inName}" operator="in" result="${outName}"/>`;
        return `${core}<feComposite in="${outName}_col" in2="${inName}" operator="in" result="${outName}_masked"/>
          <feComposite in="${outName}_masked" in2="${inName}" operator="arithmetic" k1="0" k2="${mix.toFixed(3)}" k3="${(1 - mix).toFixed(3)}" k4="0" result="${outName}"/>`;
      }

      case "chromatic-metal": {
        const depth = clamp(Number(fx.depth ?? 65) / 100, 0, 1);
        const disp = clamp(Number(fx.dispersion ?? 75) / 100, 0, 1);
        const shine = clamp(Number(fx.shine ?? 85) / 100, 0, 1);
        const rad = (Number(fx.lightAngle ?? -45) * Math.PI) / 180;
        const bevelBlur = 2 + depth * 8;
        const surfScale = 3 + depth * 12;
        const lx = Math.round(W * 0.5 + Math.cos(rad) * Math.max(W, H) * 0.85);
        const ly = Math.round(H * 0.5 + Math.sin(rad) * Math.max(W, H) * 0.85);
        const lz = Math.round(Math.min(W, H) * (0.4 + (1 - depth) * 0.35));
        const sp = 0.9 + shine * 1.6;
        // Spectral iridescence LUT: dark chrome shadow -> vivid rainbow mid-band -> hot white specular
        const iridTable = (ch) => {
          const vals = [];
          const phase = [0, 2.094, 4.188][ch];
          for (let i = 0; i <= 16; i++) {
            const t = i / 16;
            const base = Math.pow(t, 1.15);
            const band = Math.sin(t * Math.PI * 3.0 + phase) * 0.5 + 0.5;
            const env = Math.sin(t * Math.PI) * disp * 0.82;
            const v = clamp(base * (1 - env * 0.55) + band * env + Math.pow(t, 3.6) * 0.55, 0, 1);
            vals.push(v.toFixed(3));
          }
          return vals.join(" ");
        };
        // Sculpt 3D metallic height from layer luminance × alpha so inner text, shapes & photos become chrome
        return `<feColorMatrix in="${inName}" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0.299 0.587 0.114 0 0" result="${outName}_la"/>
          <feGaussianBlur in="${outName}_la" stdDeviation="${bevelBlur.toFixed(2)}" result="${outName}_h"/>
          <feSpecularLighting in="${outName}_h" surfaceScale="${surfScale.toFixed(2)}" specularConstant="${sp.toFixed(2)}" specularExponent="${(10 + shine * 24).toFixed(1)}" lighting-color="#ffffff" result="${outName}_sp">
            <fePointLight x="${lx}" y="${ly}" z="${lz}"/>
          </feSpecularLighting>
          <feDiffuseLighting in="${outName}_h" surfaceScale="${(surfScale * 0.8).toFixed(2)}" diffuseConstant="0.95" lighting-color="#d4e0f4" result="${outName}_df">
            <fePointLight x="${lx}" y="${ly}" z="${lz}"/>
          </feDiffuseLighting>
          <feComposite in="${outName}_sp" in2="${outName}_df" operator="arithmetic" k1="0" k2="0.9" k3="0.65" k4="0.04" result="${outName}_lit"/>
          <feComponentTransfer in="${outName}_lit" result="${outName}_ir">
            <feFuncR type="table" tableValues="${iridTable(0)}"/>
            <feFuncG type="table" tableValues="${iridTable(1)}"/>
            <feFuncB type="table" tableValues="${iridTable(2)}"/>
          </feComponentTransfer>
          <feComposite in="${outName}_ir" in2="${inName}" operator="in" result="${outName}"/>`;
      }

      default:
        return `<feOffset in="${inName}" dx="0" dy="0" result="${outName}"/>`;
    }
  }

  function buildFilterXml(list, geom, el, filterId) {
    let stages = "";
    let prev = "SourceGraphic";
    list.forEach((fx, i) => {
      const out = `fx${i}`;
      stages += buildStage(fx, prev, out, geom, el);
      prev = out;
    });
    const pad = list.some((fx) => fx.type === "bloom" || fx.type === "bokeh-blur" || fx.type === "gooey-merge") ? 20 : 0;
    const x = pad ? `-${pad}%` : "0%";
    const wh = pad ? `${100 + pad * 2}%` : "100%";
    return `<filter id="${filterId}" x="${x}" y="${x}" width="${wh}" height="${wh}" color-interpolation-filters="sRGB">${stages}</filter>`;
  }

  // -------------------------------------------------------------------------------------------
  // Handle lifecycle: attach to an element, track resize / corner-radius / params, clean up on unmount

  const handles = new WeakMap();
  let ro = null;

  function ensureRo() {
    if (ro || typeof ResizeObserver === "undefined") return ro;
    ro = new ResizeObserver((entries) => {
      for (const e of entries) {
        const h = handles.get(e.target);
        if (h) h.refresh();
      }
    });
    return ro;
  }

  function removeFilterNode(id) {
    if (!id) return;
    const n = (filterCounts.get(id) || 1) - 1;
    if (n <= 0) {
      filterCounts.delete(id);
      document.getElementById(id)?.remove();
    } else {
      filterCounts.set(id, n);
    }
  }

  function mountFilter(xml, prevId) {
    const defs = ensureDefs();
    if (prevId) removeFilterNode(prevId);
    const id = `bd-fx-${++serial}`;
    const full = xml.replace("__ID__", id);
    const wrap = document.createElementNS(NS, "svg");
    wrap.innerHTML = full;
    const f = wrap.firstElementChild;
    if (f) {
      defs.appendChild(f);
      filterCounts.set(id, 1);
      return id;
    }
    return null;
  }

  function attach(el, effects, opts = {}) {
    if (!el) return { update() {}, detach() {} };
    const existing = handles.get(el);
    if (existing) {
      existing.update(effects, opts);
      return existing;
    }
    let curEffects = [];
    let curOpts = opts;
    let behindId = null;
    let layerId = null;
    let specCanvas = null;
    let lastBehindKey = "";
    let lastLayerKey = "";
    let lastSpecKey = "";
    let lastFxRef = null;
    let lastStyleHint = "";
    let lastTokenKey = "";
    let lastGeom = null;

    function clearSpec() {
      if (specCanvas) {
        specCanvas.remove();
        specCanvas = null;
      }
      lastSpecKey = "";
    }

    function applyCss() {
      const baseBack = curOpts.baseBackdropFilter || "";
      const baseLayer = curOpts.baseFilter || "";
      const nextBack = behindId ? `url(#${behindId})${baseBack ? ` ${baseBack}` : ""}` : baseBack;
      const nextLayer = layerId ? `url(#${layerId})${baseLayer ? ` ${baseLayer}` : ""}` : baseLayer;
      if (el.style.backdropFilter !== nextBack) {
        el.style.backdropFilter = nextBack;
        el.style.webkitBackdropFilter = nextBack;
      }
      if (el.style.filter !== nextLayer) el.style.filter = nextLayer;
    }

    /** Strip rim-light-only props so aiming the glass light pad never tears down the SVG filter. */
    function filterSig(list) {
      return list.map((e) => {
        if (e.type !== "glass") return e;
        const { lightAngle: _a, lightIntensity: _i, ...rest } = e;
        return rest;
      });
    }

    function specSig(fx) {
      if (!fx) return "";
      if (fx.type === "glass") return `g:${fx.lightAngle ?? -60}:${fx.lightIntensity ?? 80}:${fx.depth ?? 65}:${fx.splay ?? 0}`;
      if (fx.type === "pattern-refraction") return `p:${fx.pattern || "lenticular"}:${fx.strength ?? 55}:${fx.scale ?? 12}:${fx.angle ?? 45}`;
      return "";
    }

    function refresh(force = false, fromResize = false) {
      if (!el.isConnected) return;
      const active = (curEffects || []).filter((e) => e && !e.disabled);
      if (!active.length) {
        if (behindId) (removeFilterNode(behindId), (behindId = null));
        if (layerId) (removeFilterNode(layerId), (layerId = null));
        clearSpec();
        lastBehindKey = "";
        lastLayerKey = "";
        lastGeom = null;
        applyCss();
        return;
      }
      const geom = !fromResize && !force && lastGeom && curOpts.styleHint && curOpts.styleHint === lastStyleHint ? lastGeom : readGeom(el);
      lastGeom = geom;
      const geomKey = `${Math.round(geom.W)}x${Math.round(geom.H)}:${Math.round(geom.rTL)},${Math.round(geom.rTR)},${Math.round(geom.rBR)},${Math.round(geom.rBL)}`;
      const behind = active.filter((e) => e.target === "behind" || (e.type === "glass" && e.target !== "layer"));
      const layer = active.filter((e) => !behind.includes(e));

      const behindKey = behind.length ? `${geomKey}:${JSON.stringify(filterSig(behind))}:${curOpts.tokenKey || ""}` : "";
      if (force || behindKey !== lastBehindKey) {
        lastBehindKey = behindKey;
        if (behind.length) {
          const xml = buildFilterXml(behind, geom, el, "__ID__");
          behindId = mountFilter(xml, behindId);
        } else if (behindId) {
          removeFilterNode(behindId);
          behindId = null;
        }
      }

      const layerKey = layer.length ? `${geomKey}:${JSON.stringify(layer)}:${curOpts.tokenKey || ""}` : "";
      if (force || layerKey !== lastLayerKey) {
        lastLayerKey = layerKey;
        if (layer.length) {
          const xml = buildFilterXml(layer, geom, el, "__ID__");
          layerId = mountFilter(xml, layerId);
        } else if (layerId) {
          removeFilterNode(layerId);
          layerId = null;
        }
      }

      const specFx = behind.find((e) => e.type === "glass" || e.type === "pattern-refraction");
      const sKey = specFx ? `${geomKey}:${specSig(specFx)}` : "";
      if (specFx) {
        if (!specCanvas || !specCanvas.isConnected) {
          specCanvas = el.querySelector(":scope > canvas[data-glass-rim]");
          if (!specCanvas) {
            specCanvas = document.createElement("canvas");
            specCanvas.dataset.glassRim = "1";
            specCanvas.style.cssText = "position:absolute;inset:0;width:100%;height:100%;border-radius:inherit;pointer-events:none;z-index:2;mix-blend-mode:screen";
            // Ensure element establishes a positioning context without creating a Backdrop Root!
            const pos = getComputedStyle(el).position;
            if (pos === "static") el.style.position = "relative";
            el.appendChild(specCanvas);
          }
          lastSpecKey = "";
        }
        if (force || sKey !== lastSpecKey) {
          lastSpecKey = sKey;
          drawGlassSpecular(specCanvas, geom, specFx);
        }
      } else {
        clearSpec();
      }
      applyCss();
    }

    const h = {
      refresh: () => refresh(false, true),
      update(nextEffects, nextOpts) {
        const prevFx = lastFxRef;
        const prevHint = lastStyleHint;
        const prevTok = lastTokenKey;
        curEffects = Array.isArray(nextEffects) ? nextEffects : [];
        if (nextOpts) curOpts = nextOpts;
        const nextHint = curOpts.styleHint || "";
        const nextTok = curOpts.tokenKey || "";
        // O(1) fast path during layer drags (left/top changes): skip getComputedStyle & JSON work completely!
        if (prevFx === nextEffects && nextHint && prevHint === nextHint && prevTok === nextTok && lastGeom && el.isConnected) {
          applyCss();
          return;
        }
        lastFxRef = nextEffects;
        lastStyleHint = nextHint;
        lastTokenKey = nextTok;
        refresh(false, false);
      },
      detach() {
        ro?.unobserve(el);
        handles.delete(el);
        if (behindId) (removeFilterNode(behindId), (behindId = null));
        if (layerId) (removeFilterNode(layerId), (layerId = null));
        clearSpec();
        el.style.backdropFilter = curOpts.baseBackdropFilter || "";
        el.style.webkitBackdropFilter = curOpts.baseBackdropFilter || "";
        el.style.filter = curOpts.baseFilter || "";
      },
    };
    handles.set(el, h);
    ensureRo()?.observe(el);
    h.update(effects, opts);
    return h;
  }

  /** Scan a document/container for `[data-effects]` or `[data-glass]` elements (Preview, exports, Copy as HTML). */
  function scan(root = document) {
    for (const el of Array.from(root.querySelectorAll("[data-effects], [data-glass]"))) {
      let list = [];
      if (el.dataset.glass !== undefined && el.dataset.glass !== "false") {
        try {
          const p = el.dataset.glass && el.dataset.glass !== "true" ? JSON.parse(el.dataset.glass) : {};
          list.push({ type: "glass", target: "behind", lightAngle: -60, lightIntensity: 80, refraction: 80, depth: 65, dispersion: 50, frost: 6, splay: 0, ...p });
        } catch {}
      }
      if (el.dataset.effects) {
        try {
          const parsed = JSON.parse(el.dataset.effects);
          if (Array.isArray(parsed)) list = list.concat(parsed);
        } catch {}
      }
      if (list.length) {
        attach(el, list, { baseBackdropFilter: el.style.backdropFilter || "", baseFilter: el.style.filter || "" });
      }
    }
  }

  function auto() {
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => scan(document), { once: true });
    else scan(document);
  }

  function ready() {
    scan(document);
    return new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
  }

  G.BoardEffects = { attach, scan, auto, ready };
})();
