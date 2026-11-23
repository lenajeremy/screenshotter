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
    const dpr = Math.min(2, typeof devicePixelRatio === "number" ? devicePixelRatio : 2);
    // Crisp Retina rim up to 512px (interior bounding-box skip keeps CPU work tiny)
    const sW = clamp(Math.round(W * dpr), 64, 512);
    const sH = clamp(Math.round(H * dpr), 64, 512);
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
      const bevel = Math.max(6, maxR * (0.14 + 0.46 * depth + 0.16 * splay));
      const rimBand = clamp(bevel * 0.28, 3, 22);
      const invRim = 1 / rimBand;
      const skipDist = rimBand * 3.6 + 6;
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
          // Crisp primary Fresnel specular arc + soft opposite transmitted caustic arc
          const primary = dot > 0 ? Math.pow(dot, 2.4) : 0;
          const opposite = dot < 0 ? Math.pow(-dot, 3.0) * 0.58 : 0;
          const razor = sd < 6 ? Math.exp(-sd * 0.92) * (0.24 + 0.92 * primary + 0.56 * opposite) : 0;
          const innerRim = sd < 14 ? Math.exp(-Math.pow((sd - 2.2) / 2.6, 2)) * (0.22 * primary + 0.14 * opposite) : 0;
          const bevelGlow = Math.exp(-sd * invRim) * (primary * 0.34 + opposite * 0.16);
          const a = (razor + innerRim + bevelGlow) * li;
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

  /**
   * Emit a displacement + optional continuous spectral chromatic dispersion pipeline from `inName` to `outName`.
   * When `spectral` is true (Liquid Glass), uses 5 energy-conserving spectral bands (Red -> Amber ->
   * Green -> Cyan -> Violet) so dispersion renders as a silky continuous prism rainbow instead of 3
   * hard disconnected RGB ghosts.
   */
  function displaceStage(inName, outName, mapUrl, W, H, scale, dispersionFrac, blurPx, spectral = false, satBoost = 1) {
    let pre = "";
    let src = inName;
    if (blurPx > 0.05) {
      pre += `<feGaussianBlur in="${src}" stdDeviation="${blurPx.toFixed(2)}" result="${outName}_b"/>`;
      src = `${outName}_b`;
    }
    if (satBoost > 1.01) {
      pre += `<feColorMatrix in="${src}" type="saturate" values="${satBoost.toFixed(2)}" result="${outName}_v"/>`;
      src = `${outName}_v`;
    }
    if (Math.abs(scale) < 0.05) {
      return pre ? `${pre}<feOffset in="${src}" dx="0" dy="0" result="${outName}"/>` : `<feOffset in="${inName}" dx="0" dy="0" result="${outName}"/>`;
    }
    const map = `<feImage href="${mapUrl}" x="0" y="0" width="${W}" height="${H}" preserveAspectRatio="none" result="${outName}_m"/>`;
    if (dispersionFrac > 0.004) {
      if (spectral) {
        // 5-band continuous spectral prism (sums: R=1.00, G=1.00, B=1.00 -> exact colour preservation in center)
        const s1 = scale * (1 - dispersionFrac);
        const s2 = scale * (1 - dispersionFrac * 0.5);
        const s3 = scale;
        const s4 = scale * (1 + dispersionFrac * 0.5);
        const s5 = scale * (1 + dispersionFrac);
        return `${pre}${map}
          <feDisplacementMap in="${src}" in2="${outName}_m" scale="${s1.toFixed(2)}" xChannelSelector="R" yChannelSelector="G" result="${outName}_d1"/>
          <feDisplacementMap in="${src}" in2="${outName}_m" scale="${s2.toFixed(2)}" xChannelSelector="R" yChannelSelector="G" result="${outName}_d2"/>
          <feDisplacementMap in="${src}" in2="${outName}_m" scale="${s3.toFixed(2)}" xChannelSelector="R" yChannelSelector="G" result="${outName}_d3"/>
          <feDisplacementMap in="${src}" in2="${outName}_m" scale="${s4.toFixed(2)}" xChannelSelector="R" yChannelSelector="G" result="${outName}_d4"/>
          <feDisplacementMap in="${src}" in2="${outName}_m" scale="${s5.toFixed(2)}" xChannelSelector="R" yChannelSelector="G" result="${outName}_d5"/>
          <feColorMatrix in="${outName}_d1" type="matrix" values="0.58 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0" result="${outName}_c1"/>
          <feColorMatrix in="${outName}_d2" type="matrix" values="0.42 0 0 0 0  0 0.33 0 0 0  0 0 0 0 0  0 0 0 1 0" result="${outName}_c2"/>
          <feColorMatrix in="${outName}_d3" type="matrix" values="0 0 0 0 0  0 0.34 0 0 0  0 0 0 0 0  0 0 0 1 0" result="${outName}_c3"/>
          <feColorMatrix in="${outName}_d4" type="matrix" values="0 0 0 0 0  0 0.33 0 0 0  0 0 0.42 0 0  0 0 0 1 0" result="${outName}_c4"/>
          <feColorMatrix in="${outName}_d5" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0.58 0 0  0 0 0 1 0" result="${outName}_c5"/>
          <feComposite in="${outName}_c1" in2="${outName}_c2" operator="arithmetic" k1="0" k2="1" k3="1" k4="0" result="${outName}_s12"/>
          <feComposite in="${outName}_s12" in2="${outName}_c3" operator="arithmetic" k1="0" k2="1" k3="1" k4="0" result="${outName}_s13"/>
          <feComposite in="${outName}_s13" in2="${outName}_c4" operator="arithmetic" k1="0" k2="1" k3="1" k4="0" result="${outName}_s14"/>
          <feComposite in="${outName}_s14" in2="${outName}_c5" operator="arithmetic" k1="0" k2="1" k3="1" k4="0" result="${outName}"/>`;
      }
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
    const glassW = clamp(Math.round(W), 128, 320);
    const glassH = clamp(Math.round(H), 128, 320);

    switch (fx.type) {
      case "glass": {
        const refr = clamp(Number(fx.refraction ?? 80) / 100, 0, 1);
        const depth = clamp(Number(fx.depth ?? 65) / 100, 0, 1);
        const disp = clamp(Number(fx.dispersion ?? 50) / 100, 0, 1);
        const frost = clamp(Number(fx.frost ?? 6) / 100, 0, 1);
        const splay = clamp(Number(fx.splay ?? 0) / 100, 0, 1);
        const maxR = Math.min(W, H) * 0.5;
        // Strictly monotonic C1 dome profile: u(s) = s + (a/p)*(1-s)^p with a <= 0.92 guarantees
        // du/ds = 1 - a*(1-s)^(p-1) >= 0.08 > 0 everywhere -> ZERO folding creases or mirrored tears!
        const bevel = Math.max(6, maxR * (0.12 + 0.43 * depth + 0.18 * splay));
        const power = 2.85 - splay * 1.05; // 2.85 tight glossy rim -> 1.80 broad dome splay
        const maxDisp = Math.min(bevel * ((refr * 0.92) / power), 68);
        // feDisplacementMap applies scale * (channel/255 - 0.5), so scale = 2 * maxDisp gives exact pixel displacement
        const scale = maxDisp * 2;
        const key = `glass2:${Math.round(W)}x${Math.round(H)}:${Math.round(rTL)},${Math.round(rTR)},${Math.round(rBR)},${Math.round(rBL)}:${bevel.toFixed(1)}:${power.toFixed(2)}`;
        const url = cacheGet(key, () =>
          makePng(glassW, glassH, (data, mw, mh) => {
            for (let j = 0; j < mh; j++) {
              const y = ((j + 0.5) / mh) * H;
              for (let i = 0; i < mw; i++) {
                const x = ((i + 0.5) / mw) * W;
                const { sd, nx, ny } = rrectSdf(x, y, W, H, rTL, rTR, rBR, rBL);
                const idx = (j * mw + i) * 4;
                if (sd >= bevel) {
                  data[idx] = 128; data[idx + 1] = 128; data[idx + 2] = 128; data[idx + 3] = 255;
                  continue;
                }
                // Extrapolate rim vector smoothly past sd <= 0 so bilinear feImage never stair-steps the circular border!
                const t = sd <= 0 ? 0 : sd / bevel;
                const mag = Math.pow(1 - t, power);
                data[idx] = clampByte(128 + nx * mag * 127);
                data[idx + 1] = clampByte(128 + ny * mag * 127);
                data[idx + 2] = 128;
                data[idx + 3] = 255;
              }
            }
          }),
        );
        const dispFrac = disp * 0.24;
        const blurPx = frost * 18;
        const satBoost = frost > 0.02 ? 1 + Math.min(0.24, frost * 0.85) : 1;
        return displaceStage(inName, outName, url, W, H, scale, dispFrac, blurPx, disp > 0.15, satBoost);
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
  // True 32-bit Float WebGL Liquid Glass Engine (Figma / Apple-grade Snell's Law refraction,
  // 12-tap continuous Cauchy spectral dispersion, 2-pass separable GPU Gaussian frost blur,
  // and subpixel-exact directional Fresnel specular rim).

  const GLASS_VERT = "attribute vec2 p;void main(){gl_Position=vec4(p,0.0,1.0);}";

  const BLUR_FRAG_EXACT = `
    precision highp float;
    uniform sampler2D uTex;
    uniform vec2 uRes;
    uniform vec2 uDir;
    void main() {
      vec2 uv = gl_FragCoord.xy / uRes;
      vec3 sum = texture2D(uTex, uv).rgb * 0.163;
      sum += (texture2D(uTex, clamp(uv + uDir * 1.4, vec2(0.002), vec2(0.998))).rgb
            + texture2D(uTex, clamp(uv - uDir * 1.4, vec2(0.002), vec2(0.998))).rgb) * 0.151;
      sum += (texture2D(uTex, clamp(uv + uDir * 3.3, vec2(0.002), vec2(0.998))).rgb
            + texture2D(uTex, clamp(uv - uDir * 3.3, vec2(0.002), vec2(0.998))).rgb) * 0.119;
      sum += (texture2D(uTex, clamp(uv + uDir * 5.3, vec2(0.002), vec2(0.998))).rgb
            + texture2D(uTex, clamp(uv - uDir * 5.3, vec2(0.002), vec2(0.998))).rgb) * 0.079;
      sum += (texture2D(uTex, clamp(uv + uDir * 7.3, vec2(0.002), vec2(0.998))).rgb
            + texture2D(uTex, clamp(uv - uDir * 7.3, vec2(0.002), vec2(0.998))).rgb) * 0.044;
      sum += (texture2D(uTex, clamp(uv + uDir * 9.3, vec2(0.002), vec2(0.998))).rgb
            + texture2D(uTex, clamp(uv - uDir * 9.3, vec2(0.002), vec2(0.998))).rgb) * 0.025;
      gl_FragColor = vec4(sum, 1.0);
    }
  `;

  const GLASS_FRAG = `
    precision highp float;
    uniform sampler2D uTex;
    uniform vec2 uRes;
    uniform vec2 uSize;
    uniform float uPad;
    uniform vec4 uRadii;
    uniform float uRefraction;
    uniform float uDepth;
    uniform float uDispersion;
    uniform float uFrost;
    uniform float uSplay;
    uniform vec2 uLightDir;
    uniform float uLightIntensity;
    uniform vec4 uTint;

    float sdRoundRect(vec2 p, vec2 halfSize, vec4 r) {
      vec2 rr = (p.x > 0.0) ? r.xy : r.zw;
      float rad = (p.y > 0.0) ? rr.y : rr.x;
      vec2 q = abs(p) - halfSize + rad;
      return min(max(q.x, q.y), 0.0) + length(max(q, 0.0)) - rad;
    }

    vec3 spectral(float w) {
      float r = smoothstep(0.62, 0.08, w);
      float g = sin(w * 3.14159265);
      g = g * g;
      float b = smoothstep(0.38, 0.92, w);
      return vec3(r, g, b);
    }

    vec2 pxToUv(vec2 px) {
      vec2 uv = (px + vec2(uPad)) / (uSize + vec2(uPad * 2.0));
      return clamp(vec2(uv.x, 1.0 - uv.y), vec2(0.002), vec2(0.998));
    }

    void main() {
      vec2 fragNorm = gl_FragCoord.xy / uRes;
      vec2 px = vec2(fragNorm.x * uSize.x, (1.0 - fragNorm.y) * uSize.y);
      vec2 halfSize = uSize * 0.5;
      vec2 p = px - halfSize;

      float sd = sdRoundRect(p, halfSize, uRadii);
      float aa = max(uSize.x / max(uRes.x, 1.0), 0.5);
      float shapeAlpha = 1.0 - smoothstep(-aa * 0.75, aa * 0.75, sd);
      if (shapeAlpha <= 0.001) discard;

      float d = max(0.0, -sd);

      // Exact 32-bit float outward normal of the 4-corner rounded-rect SDF
      float eps = 0.35;
      vec2 grad = vec2(
        sdRoundRect(p + vec2(eps, 0.0), halfSize, uRadii) - sdRoundRect(p - vec2(eps, 0.0), halfSize, uRadii),
        sdRoundRect(p + vec2(0.0, eps), halfSize, uRadii) - sdRoundRect(p - vec2(0.0, eps), halfSize, uRadii)
      );
      float gLen = length(grad);
      vec2 outN = gLen > 1e-4 ? (grad / gLen) : vec2(0.0);

      // Convex glass squircle/spherical dome cross-section calibrated to Figma Liquid Glass:
      // At Depth=100, Splay=0: ~48% rim bevel keeps center subjects crisp while curving the rim cleanly;
      // increasing Splay broadens curvature smoothly across the full dome.
      float maxR = min(halfSize.x, halfSize.y);
      float bevel = max(5.0, maxR * (0.10 + 0.38 * uDepth + 0.36 * uSplay));
      float t = clamp(d / bevel, 0.0, 1.0);
      float u = 1.0 - t;

      // h(t) = (1 - u^n)^(1/n): n = 3.8 (tight glossy bevel) .. 2.0 (broad spherical dome)
      float nExp = mix(3.8, 2.0, uSplay);
      float un = pow(max(u, 0.0), nExp);
      float domeH = pow(max(1.0 - un, 0.0001), 1.0 / nExp);
      float rawSlope = u > 0.0001 ? pow(u, nExp - 1.0) / pow(max(1.0 - un, 0.036), 1.0 - 1.0 / nExp) : 0.0;
      float slope = rawSlope / (1.0 + rawSlope * 0.24);

      // 3D outward surface normal on the convex dome
      vec3 N = normalize(vec3(outN * slope * (0.78 + 0.88 * uRefraction), 1.0));
      float refrStrength = uRefraction * (0.30 + 0.70 * uDepth);
      float rayDist = bevel * (0.18 + 0.62 * refrStrength) * (0.38 + 0.62 * domeH);

      float baseIor = 1.0 + uRefraction * 0.56;
      float dispDelta = uDispersion * uRefraction * 0.17;

      vec3 col = vec3(0.0);
      if (uRefraction < 0.002 || slope < 0.0004) {
        col = texture2D(uTex, pxToUv(px)).rgb;
      } else if (dispDelta < 0.004) {
        vec3 ray = refract(vec3(0.0, 0.0, -1.0), N, 1.0 / baseIor);
        vec2 shift = (ray.xy / max(-ray.z, 0.18)) * rayDist;
        col = texture2D(uTex, pxToUv(px + shift)).rgb;
      } else {
        // 12-tap continuous Cauchy spectral prism dispersion (zero banding even at 1000% zoom!)
        vec3 acc = vec3(0.0);
        vec3 wSum = vec3(0.0);
        for (int i = 0; i < 12; i++) {
          float w = (float(i) + 0.5) / 12.0;
          float ior = max(1.005, baseIor + (w - 0.5) * dispDelta * 2.0);
          vec3 ray = refract(vec3(0.0, 0.0, -1.0), N, 1.0 / ior);
          vec2 shift = (ray.xy / max(-ray.z, 0.18)) * rayDist;
          vec3 sw = spectral(w);
          acc += texture2D(uTex, pxToUv(px + shift)).rgb * sw;
          wSum += sw;
        }
        col = acc / max(wSum, vec3(1e-4));
      }

      // Frosted vibrancy boost so frosted glass glows richly instead of washing out grey
      if (uFrost > 0.02) {
        float lum = dot(col, vec3(0.2126, 0.7152, 0.0722));
        col = mix(vec3(lum), col, 1.0 + min(0.22, uFrost * 0.55));
      }

      // Composite user frame background tint cleanly over the refracted glass
      col = mix(col, uTint.rgb, uTint.a);

      // Physical Fresnel grazing rim depth & razor-sharp directional specular rim highlight
      float fresnel = pow(1.0 - max(N.z, 0.0), 2.2);
      float lDot = dot(outN, uLightDir);
      float primaryArc = pow(max(0.0, lDot), 2.1);
      float oppositeArc = pow(max(0.0, -lDot), 2.8) * 0.58;
      float grazingSide = 1.0 - abs(lDot);

      // Subtle dark grazing edge reflection giving crystal spheres & tiles crisp 3D thickness
      float edgeDepth = exp(-d / max(2.2, bevel * 0.10)) * (0.16 * grazingSide + 0.05) * (0.35 + 0.65 * uDepth) * (1.0 - uFrost * 0.55);
      col *= (1.0 - edgeDepth);

      // Razor-thin glossy specular bevel rim (matches Figma's crisp 1px metallic-glass edge)
      float rimRazor = exp(-d / 1.15) * (0.16 + 0.90 * primaryArc + 0.54 * oppositeArc);
      float rimInner = exp(-pow((d - 1.8) / 2.0, 2.0)) * (0.20 * primaryArc + 0.12 * oppositeArc);
      float bevelSheen = exp(-d / max(4.0, bevel * 0.30)) * (0.22 * primaryArc + 0.10 * oppositeArc) * (0.5 + 0.5 * fresnel);
      float spec = clamp((rimRazor + rimInner + bevelSheen) * uLightIntensity, 0.0, 1.0);

      col = 1.0 - (1.0 - col) * (1.0 - vec3(spec));
      gl_FragColor = vec4(col, shapeAlpha);
    }
  `;

  let gGL = null;
  let gGLTried = false;

  function ensureGlassGL() {
    if (gGL && !gGL.gl.isContextLost()) return gGL;
    if (gGLTried) return gGL && !gGL.gl.isContextLost() ? gGL : null;
    gGLTried = true;
    try {
      const canvas = document.createElement("canvas");
      canvas.width = 256;
      canvas.height = 256;
      const attrs = { alpha: true, premultipliedAlpha: false, antialias: false, depth: false, stencil: false, preserveDrawingBuffer: true };
      const gl = canvas.getContext("webgl2", attrs) || canvas.getContext("webgl", attrs) || canvas.getContext("experimental-webgl", attrs);
      if (!gl) return null;

      const makeProg = (fragSrc) => {
        const vs = gl.createShader(gl.VERTEX_SHADER);
        gl.shaderSource(vs, GLASS_VERT);
        gl.compileShader(vs);
        const fs = gl.createShader(gl.FRAGMENT_SHADER);
        gl.shaderSource(fs, fragSrc);
        gl.compileShader(fs);
        const prog = gl.createProgram();
        gl.attachShader(prog, vs);
        gl.attachShader(prog, fs);
        gl.bindAttribLocation(prog, 0, "p");
        gl.linkProgram(prog);
        gl.deleteShader(vs);
        gl.deleteShader(fs);
        if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return null;
        return prog;
      };

      const glassProg = makeProg(GLASS_FRAG);
      const blurProg = makeProg(BLUR_FRAG_EXACT);
      if (!glassProg || !blurProg) return null;

      const vbo = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

      const makeTex = () => {
        const t = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, t);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        return t;
      };

      const uLocs = (prog, names) => Object.fromEntries(names.map((n) => [n, gl.getUniformLocation(prog, n)]));
      const glassU = uLocs(glassProg, ["uTex", "uRes", "uSize", "uPad", "uRadii", "uRefraction", "uDepth", "uDispersion", "uFrost", "uSplay", "uLightDir", "uLightIntensity", "uTint"]);
      const blurU = uLocs(blurProg, ["uTex", "uRes", "uDir"]);

      const texIn = makeTex();
      const texA = makeTex();
      const texB = makeTex();
      const fboA = gl.createFramebuffer();
      const fboB = gl.createFramebuffer();

      gGL = { canvas, gl, glassProg, blurProg, glassU, blurU, texIn, texA, texB, fboA, fboB, fboW: 0, fboH: 0 };
      canvas.addEventListener("webglcontextlost", (e) => {
        e.preventDefault();
        gGL = null;
        gGLTried = false;
      });
      return gGL;
    } catch {
      return null;
    }
  }

  function ensureFboSize(Gctx, w, h) {
    if (Gctx.fboW === w && Gctx.fboH === h) return;
    const { gl, texA, texB, fboA, fboB } = Gctx;
    Gctx.fboW = w;
    Gctx.fboH = h;
    for (const [tex, fbo] of [[texA, fboA], [texB, fboB]]) {
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  function renderGlassWebGL(outCanvas, backdropCanvas, geom, pad, fx, tintRgba) {
    const Gctx = ensureGlassGL();
    if (!Gctx) return false;
    const { gl, canvas, glassProg, blurProg, glassU, blurU, texIn, texA, texB, fboA, fboB } = Gctx;
    const { W, H, rTL, rTR, rBR, rBL } = geom;
    const dpr = Math.min(2, typeof devicePixelRatio === "number" ? devicePixelRatio : 2);
    const outW = clamp(Math.round(W * dpr), 32, 1024);
    const outH = clamp(Math.round(H * dpr), 32, 1024);

    if (canvas.width < outW || canvas.height < outH) {
      canvas.width = Math.min(2048, Math.max(canvas.width, outW));
      canvas.height = Math.min(2048, Math.max(canvas.height, outH));
    }
    if (outCanvas.width !== outW) outCanvas.width = outW;
    if (outCanvas.height !== outH) outCanvas.height = outH;

    // Upload backdrop texture (flipped so V=1 is top)
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texIn);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, backdropCanvas);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 0);

    const frost = clamp(Number(fx.frost ?? 6) / 100, 0, 1);
    let srcTex = texIn;

    // Optional silky 2-pass separable GPU Gaussian blur when frost > 0
    if (frost > 0.005) {
      const bw = Math.max(16, Math.round(backdropCanvas.width * (frost > 0.35 ? 0.5 : 1)));
      const bh = Math.max(16, Math.round(backdropCanvas.height * (frost > 0.35 ? 0.5 : 1)));
      ensureFboSize(Gctx, bw, bh);
      gl.useProgram(blurProg);
      gl.uniform1i(blurU.uTex, 0);
      gl.uniform2f(blurU.uRes, bw, bh);
      gl.viewport(0, 0, bw, bh);

      const radius = frost * 2.4 * (backdropCanvas.width / Math.max(W + pad * 2, 1));
      const passes = frost > 0.35 ? 2 : 1;
      let curTex = texIn;
      for (let p = 0; p < passes; p++) {
        const mult = p === 0 ? radius : radius * 1.65;
        // Horizontal -> fboA
        gl.bindFramebuffer(gl.FRAMEBUFFER, fboA);
        gl.bindTexture(gl.TEXTURE_2D, curTex);
        gl.uniform2f(blurU.uDir, mult / bw, 0);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        // Vertical -> fboB
        gl.bindFramebuffer(gl.FRAMEBUFFER, fboB);
        gl.bindTexture(gl.TEXTURE_2D, texA);
        gl.uniform2f(blurU.uDir, 0, mult / bh);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        curTex = texB;
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      srcTex = texB;
    }

    // Main 32-bit float Liquid Glass pass
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, outW, outH);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(glassProg);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, srcTex);
    gl.uniform1i(glassU.uTex, 0);
    gl.uniform2f(glassU.uRes, outW, outH);
    gl.uniform2f(glassU.uSize, W, H);
    gl.uniform1f(glassU.uPad, pad);
    gl.uniform4f(glassU.uRadii, rTR, rBR, rTL, rBL);
    gl.uniform1f(glassU.uRefraction, clamp(Number(fx.refraction ?? 80) / 100, 0, 1));
    gl.uniform1f(glassU.uDepth, clamp(Number(fx.depth ?? 65) / 100, 0, 1));
    gl.uniform1f(glassU.uDispersion, clamp(Number(fx.dispersion ?? 50) / 100, 0, 1));
    gl.uniform1f(glassU.uFrost, frost);
    gl.uniform1f(glassU.uSplay, clamp(Number(fx.splay ?? 0) / 100, 0, 1));
    const rad = (Number(fx.lightAngle ?? -60) * Math.PI) / 180;
    gl.uniform2f(glassU.uLightDir, Math.cos(rad), Math.sin(rad));
    gl.uniform1f(glassU.uLightIntensity, clamp(Number(fx.lightIntensity ?? 80) / 100, 0, 1));
    gl.uniform4f(glassU.uTint, tintRgba[0], tintRgba[1], tintRgba[2], tintRgba[3]);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    const outCtx = outCanvas.getContext("2d");
    outCtx.globalCompositeOperation = "copy";
    outCtx.drawImage(canvas, 0, canvas.height - outH, outW, outH, 0, 0, outW, outH);
    outCtx.globalCompositeOperation = "source-over";
    return true;
  }

  // -------------------------------------------------------------------------------------------
  // High-fidelity DOM Backdrop Compositor (paints behind-layers in exact CSS paint order into a
  // padded Canvas2D texture for WebGL Liquid Glass: supports live WebGL shaders, photos, SVGs,
  // gradients, videos, Glass-over-Glass, rotated frames, and exact browser-laid-out typography).

  const assetImgCache = new Map();
  const pendingAssetDecodes = new Set();

  function loadCachedImage(key, src, onReady) {
    const hit = assetImgCache.get(key);
    if (hit) {
      if (hit.loaded) return hit.img;
      if (onReady) hit.waiters.push(onReady);
      return null;
    }
    const img = new Image();
    img.crossOrigin = "anonymous";
    const entry = { img, loaded: false, failed: false, waiters: onReady ? [onReady] : [] };
    if (assetImgCache.size > 160) {
      const oldest = assetImgCache.keys().next().value;
      if (oldest !== undefined) assetImgCache.delete(oldest);
    }
    assetImgCache.set(key, entry);
    const p = new Promise((resolve) => {
      const done = (ok) => {
        entry.loaded = ok;
        entry.failed = !ok;
        pendingAssetDecodes.delete(p);
        const ws = entry.waiters.splice(0);
        for (const fn of ws) fn();
        resolve();
      };
      img.onload = () => done(true);
      img.onerror = () => done(false);
    });
    pendingAssetDecodes.add(p);
    img.src = src;
    return null;
  }

  function splitTopLevel(str, sep = ",") {
    const out = [];
    let depth = 0, start = 0;
    for (let i = 0; i < str.length; i++) {
      const ch = str[i];
      if (ch === "(") depth++;
      else if (ch === ")") depth = Math.max(0, depth - 1);
      else if (ch === sep && depth === 0) {
        out.push(str.slice(start, i).trim());
        start = i + 1;
      }
    }
    const last = str.slice(start).trim();
    if (last) out.push(last);
    return out;
  }

  function parseGradientStops(parts) {
    const stops = parts.map((p) => {
      const m = /^(.*)\s+(-?[\d.]+)(%|px)$/.exec(p);
      if (m) return { color: m[1].trim(), pos: m[3] === "%" ? parseFloat(m[2]) / 100 : null };
      return { color: p.trim(), pos: null };
    });
    if (!stops.length) return [];
    if (stops[0].pos === null) stops[0].pos = 0;
    if (stops[stops.length - 1].pos === null) stops[stops.length - 1].pos = 1;
    let lastKnown = 0;
    for (let i = 1; i < stops.length; i++) {
      if (stops[i].pos !== null) {
        const span = i - lastKnown;
        if (span > 1) {
          const p0 = stops[lastKnown].pos, p1 = stops[i].pos;
          for (let j = 1; j < span; j++) stops[lastKnown + j].pos = p0 + ((p1 - p0) * j) / span;
        }
        lastKnown = i;
      }
    }
    return stops;
  }

  function paintBgLayer(ctx, layerStr, x, y, w, h, cs, onAssetLoad) {
    if (!layerStr || layerStr === "none") return;
    if (layerStr.startsWith("linear-gradient(")) {
      const inner = layerStr.slice(16, -1);
      const parts = splitTopLevel(inner, ",");
      if (parts.length < 2) return;
      let deg = 180;
      let stopStart = 0;
      const first = parts[0].trim();
      if (/^-?[\d.]+(deg|rad|turn|grad)$/i.test(first)) {
        const n = parseFloat(first);
        if (/rad$/i.test(first)) deg = (n * 180) / Math.PI;
        else if (/turn$/i.test(first)) deg = n * 360;
        else if (/grad$/i.test(first)) deg = n * 0.9;
        else deg = n;
        stopStart = 1;
      } else if (/^to\s+/i.test(first)) {
        const dir = first.toLowerCase();
        const right = dir.includes("right"), left = dir.includes("left");
        const top = dir.includes("top"), bottom = dir.includes("bottom");
        if (right && top) deg = 45;
        else if (right && bottom) deg = 135;
        else if (left && bottom) deg = 225;
        else if (left && top) deg = 315;
        else if (right) deg = 90;
        else if (left) deg = 270;
        else if (top) deg = 0;
        else deg = 180;
        stopStart = 1;
      }
      const rad = ((deg - 90) * Math.PI) / 180;
      const dx = Math.cos(rad), dy = Math.sin(rad);
      const L = (Math.abs(w * dx) + Math.abs(h * dy)) * 0.5;
      const cx = x + w * 0.5, cy = y + h * 0.5;
      const g = ctx.createLinearGradient(cx - dx * L, cy - dy * L, cx + dx * L, cy + dy * L);
      for (const s of parseGradientStops(parts.slice(stopStart))) {
        try { g.addColorStop(clamp(s.pos, 0, 1), s.color); } catch {}
      }
      ctx.fillStyle = g;
      ctx.fillRect(x, y, w, h);
      return;
    }
    if (layerStr.startsWith("radial-gradient(")) {
      const inner = layerStr.slice(16, -1);
      const parts = splitTopLevel(inner, ",");
      if (parts.length < 2) return;
      let cx = x + w * 0.5, cy = y + h * 0.5;
      let rx = w * 0.5, ry = h * 0.5;
      let stopStart = 0;
      const first = parts[0].trim();
      if (/^(circle|ellipse|closest|farthest|at\b)/i.test(first) || /\bat\b/i.test(first)) {
        const atM = /\bat\s+([^\s]+)(?:\s+([^\s]+))?/i.exec(first);
        const parsePos = (tok, base, len) => {
          if (!tok || tok === "center") return base + len * 0.5;
          if (tok === "left" || tok === "top") return base;
          if (tok === "right" || tok === "bottom") return base + len;
          if (tok.endsWith("%")) return base + (parseFloat(tok) / 100) * len;
          return base + (parseFloat(tok) || 0);
        };
        if (atM) {
          cx = parsePos(atM[1], x, w);
          cy = parsePos(atM[2] || "50%", y, h);
        }
        const szM = /^ellipse\s+([\d.]+)%\s+([\d.]+)%/i.exec(first);
        if (szM) {
          rx = (parseFloat(szM[1]) / 100) * w;
          ry = (parseFloat(szM[2]) / 100) * h;
        } else {
          const r = Math.hypot(Math.max(cx - x, x + w - cx), Math.max(cy - y, y + h - cy));
          rx = ry = r;
        }
        stopStart = 1;
      } else {
        rx = ry = Math.hypot(w * 0.5, h * 0.5);
      }
      ctx.save();
      const maxR = Math.max(rx, ry, 1);
      ctx.translate(cx, cy);
      ctx.scale(rx / maxR, ry / maxR);
      const g = ctx.createRadialGradient(0, 0, 0, 0, 0, maxR);
      for (const s of parseGradientStops(parts.slice(stopStart))) {
        try { g.addColorStop(clamp(s.pos, 0, 1), s.color); } catch {}
      }
      ctx.fillStyle = g;
      ctx.fillRect(-maxR * 2, -maxR * 2, maxR * 4, maxR * 4);
      ctx.restore();
      return;
    }
    if (layerStr.startsWith("url(")) {
      const m = /^url\(\s*["']?([^"')]+)["']?\s*\)/.exec(layerStr);
      if (!m) return;
      const img = loadCachedImage(`bg:${m[1]}`, m[1], onAssetLoad);
      if (img && img.naturalWidth > 0) drawFittedImage(ctx, img, x, y, w, h, cs.backgroundSize === "contain" ? "contain" : "cover");
    }
  }

  function drawFittedImage(ctx, img, x, y, w, h, fit) {
    const iw = img.naturalWidth || img.width || 1;
    const ih = img.naturalHeight || img.height || 1;
    if (fit === "cover" || fit === "contain") {
      const s = fit === "cover" ? Math.max(w / iw, h / ih) : Math.min(w / iw, h / ih);
      const dw = iw * s, dh = ih * s;
      ctx.drawImage(img, x + (w - dw) * 0.5, y + (h - dh) * 0.5, dw, dh);
    } else {
      ctx.drawImage(img, x, y, w, h);
    }
  }

  function roundRectPath(ctx, x, y, w, h, cs, zoom) {
    const maxR = Math.min(w, h) * 0.5;
    const rad = (prop) => {
      const raw = cs[prop] || "0";
      const n = parseFloat(raw) || 0;
      return clamp(raw.includes("%") ? (n / 100) * Math.min(w, h) : n * zoom, 0, maxR);
    };
    const tl = rad("borderTopLeftRadius"), tr = rad("borderTopRightRadius");
    const br = rad("borderBottomRightRadius"), bl = rad("borderBottomLeftRadius");
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(x, y, w, h, [tl, tr, br, bl]);
    else ctx.rect(x, y, w, h);
  }

  function ancestorMatrix(el) {
    const chain = [];
    for (let cur = el; cur && cur.nodeType === 1; cur = cur.parentElement) chain.push(cur);
    let m = new DOMMatrix();
    for (let i = chain.length - 1; i >= 0; i--) {
      const tf = getComputedStyle(chain[i]).transform;
      if (tf && tf !== "none") {
        try { m = m.multiply(new DOMMatrix(tf)); } catch {}
      }
    }
    return m;
  }

  function paintTextNode(ctx, textNode, parentCs, zoom, cull) {
    const raw = textNode.nodeValue;
    if (!raw || !raw.trim()) return;
    const ws = parentCs.whiteSpace || "normal";
    const text = ws.startsWith("pre") ? raw : raw.replace(/\s+/g, " ");
    const tf = parentCs.textTransform || "none";
    const xform = (s) => (tf === "uppercase" ? s.toUpperCase() : tf === "lowercase" ? s.toLowerCase() : s);

    const range = document.createRange();
    range.selectNodeContents(textNode);
    const allRects = range.getClientRects();
    if (!allRects.length) return;
    const bb = range.getBoundingClientRect();
    if (bb.right < cull.left || bb.left > cull.right || bb.bottom < cull.top || bb.top > cull.bottom) return;

    const fontSize = (parseFloat(parentCs.fontSize) || 16) * zoom;
    const fontWeight = parentCs.fontWeight || "400";
    const fontStyle = parentCs.fontStyle || "normal";
    const fontFamily = parentCs.fontFamily || "sans-serif";
    ctx.font = `${fontStyle} ${fontWeight} ${fontSize}px ${fontFamily}`;
    ctx.fillStyle = parentCs.color || "#ffffff";
    ctx.textBaseline = "alphabetic";
    const ls = parseFloat(parentCs.letterSpacing);
    if ("letterSpacing" in ctx) ctx.letterSpacing = Number.isFinite(ls) ? `${ls * zoom}px` : "0px";

    const drawChunk = (str, r) => {
      const s = xform(str.trim());
      if (!s) return;
      const m = ctx.measureText(s);
      const asc = m.fontBoundingBoxAscent || fontSize * 0.8;
      const desc = m.fontBoundingBoxDescent || fontSize * 0.2;
      const baseY = r.top + (r.height + asc - desc) * 0.5;
      ctx.fillText(s, r.left, baseY);
    };

    if (allRects.length === 1) {
      drawChunk(text, allRects[0]);
      return;
    }
    // Multi-line wrapped text: walk word spans to group words on each visual line accurately
    const len = raw.length;
    let lineStart = 0;
    let curLineTop = null;
    let curLineRect = null;
    const wordRe = /\S+\s*/g;
    let m;
    while ((m = wordRe.exec(raw))) {
      range.setStart(textNode, m.index);
      range.setEnd(textNode, Math.min(len, m.index + m[0].trimEnd().length));
      const wr = range.getBoundingClientRect();
      if (!wr.width && !wr.height) continue;
      if (curLineTop === null) {
        curLineTop = wr.top;
        curLineRect = { left: wr.left, top: wr.top, right: wr.right, bottom: wr.bottom, height: wr.height };
        lineStart = m.index;
      } else if (Math.abs(wr.top - curLineTop) > fontSize * 0.45) {
        drawChunk(raw.slice(lineStart, m.index).replace(/\s+/g, " "), curLineRect);
        curLineTop = wr.top;
        curLineRect = { left: wr.left, top: wr.top, right: wr.right, bottom: wr.bottom, height: wr.height };
        lineStart = m.index;
      } else {
        curLineRect.right = Math.max(curLineRect.right, wr.right);
        curLineRect.bottom = Math.max(curLineRect.bottom, wr.bottom);
        curLineRect.height = Math.max(curLineRect.height, wr.height);
      }
    }
    if (curLineRect) drawChunk(raw.slice(lineStart).replace(/\s+/g, " "), curLineRect);
  }

  function findBackdropRoot(el) {
    const world = el.closest(".bd-world");
    if (world) {
      let cur = el;
      while (cur.parentElement && cur.parentElement !== world) cur = cur.parentElement;
      if (cur.parentElement === world) return cur;
    }
    return document.body?.firstElementChild || document.body || document.documentElement;
  }

  function captureBackdrop(targetEl, geom, pad, outCanvas, onAssetLoad) {
    const { W, H } = geom;
    const elRect = targetEl.getBoundingClientRect();
    if (!elRect.width || !elRect.height) return { ok: false, hasLiveShader: false };

    const M = ancestorMatrix(targetEl);
    const zoom = Math.max(0.01, Math.hypot(M.a, M.b));
    const rot = Math.atan2(M.b, M.a);
    const cx = elRect.left + elRect.width * 0.5;
    const cy = elRect.top + elRect.height * 0.5;

    const totalW = W + pad * 2;
    const totalH = H + pad * 2;
    const dpr = Math.min(2, typeof devicePixelRatio === "number" ? devicePixelRatio : 2);
    const texScale = Math.min(dpr, 768 / Math.max(totalW, totalH));
    const capW = Math.max(32, Math.round(totalW * texScale));
    const capH = Math.max(32, Math.round(totalH * texScale));
    if (outCanvas.width !== capW) outCanvas.width = capW;
    if (outCanvas.height !== capH) outCanvas.height = capH;

    const ctx = outCanvas.getContext("2d");
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    // Fill canvas neutral backdrop matching root/page so outside-artboard padding never bleeds transparent black
    const root = findBackdropRoot(targetEl);
    const rootBg = root ? getComputedStyle(root).backgroundColor : "";
    ctx.fillStyle = rootBg && rootBg !== "rgba(0, 0, 0, 0)" ? rootBg : "#08090e";
    ctx.fillRect(0, 0, capW, capH);

    // Map screen pixel space -> targetEl's padded local canvas coordinates
    ctx.translate(capW * 0.5, capH * 0.5);
    ctx.scale(texScale / zoom, texScale / zoom);
    if (Math.abs(rot) > 1e-4) ctx.rotate(-rot);
    ctx.translate(-cx, -cy);

    // Generous screen-space culling AABB covering rotated + padded capture bounds
    const diag = Math.hypot(totalW, totalH) * 0.55 * zoom;
    const cull = { left: cx - diag, right: cx + diag, top: cy - diag, bottom: cy + diag };
    let hasLiveShader = false;

    const walk = (node) => {
      if (node === targetEl) return true;
      if (node.nodeType !== 1) return false;
      const tag = node.tagName;
      if (tag === "SCRIPT" || tag === "STYLE" || tag === "DEFS" || node.dataset?.glassRim === "1") return false;
      const cs = getComputedStyle(node);
      if (cs.display === "none" || cs.visibility === "hidden") return false;
      const op = parseFloat(cs.opacity);
      if (op <= 0.001) return false;

      const nr = node.getBoundingClientRect();
      const containsTarget = node.contains(targetEl);
      const overlaps = nr.width > 0 && nr.height > 0 && nr.right >= cull.left && nr.left <= cull.right && nr.bottom >= cull.top && nr.top <= cull.bottom;
      if (!containsTarget && !overlaps && (cs.overflow === "hidden" || cs.overflow === "clip" || tag === "IMG" || tag === "CANVAS" || tag === "SVG" || tag === "VIDEO")) {
        return false;
      }

      ctx.save();
      if (op < 0.999) ctx.globalAlpha *= op;
      if (cs.mixBlendMode && cs.mixBlendMode !== "normal") {
        try { ctx.globalCompositeOperation = cs.mixBlendMode; } catch {}
      }

      // Paint node's own box (solid fill + CSS gradients / background-image)
      const bgCol = cs.backgroundColor;
      const bgImg = cs.backgroundImage;
      const hasFill = (bgCol && bgCol !== "rgba(0, 0, 0, 0)" && bgCol !== "transparent") || (bgImg && bgImg !== "none");
      if (overlaps && hasFill) {
        ctx.save();
        roundRectPath(ctx, nr.left, nr.top, nr.width, nr.height, cs, zoom);
        ctx.clip();
        if (bgCol && bgCol !== "rgba(0, 0, 0, 0)" && bgCol !== "transparent") {
          ctx.fillStyle = bgCol;
          ctx.fillRect(nr.left, nr.top, nr.width, nr.height);
        }
        if (bgImg && bgImg !== "none") {
          const layers = splitTopLevel(bgImg, ",");
          for (let i = layers.length - 1; i >= 0; i--) paintBgLayer(ctx, layers[i], nr.left, nr.top, nr.width, nr.height, cs, onAssetLoad);
        }
        ctx.restore();
      }

      // Paint replaced media elements: <canvas> (all 24 WebGL Shaders & lower Glass layers!), <img>, <video>, <svg>
      if (overlaps && tag === "CANVAS") {
        if (node.width > 0 && node.height > 0) {
          ctx.save();
          roundRectPath(ctx, nr.left, nr.top, nr.width, nr.height, cs, zoom);
          ctx.clip();
          try { ctx.drawImage(node, nr.left, nr.top, nr.width, nr.height); } catch {}
          ctx.restore();
          if (node.dataset?.shaderState === "playing") hasLiveShader = true;
        }
        ctx.restore();
        return false;
      }
      if (overlaps && tag === "IMG") {
        if (node.complete && node.naturalWidth > 0) {
          ctx.save();
          roundRectPath(ctx, nr.left, nr.top, nr.width, nr.height, cs, zoom);
          ctx.clip();
          try { drawFittedImage(ctx, node, nr.left, nr.top, nr.width, nr.height, cs.objectFit || "fill"); } catch {}
          ctx.restore();
        } else if (onAssetLoad) {
          node.addEventListener("load", onAssetLoad, { once: true });
        }
        ctx.restore();
        return false;
      }
      if (overlaps && tag === "VIDEO") {
        if (node.readyState >= 2) {
          ctx.save();
          roundRectPath(ctx, nr.left, nr.top, nr.width, nr.height, cs, zoom);
          ctx.clip();
          try { ctx.drawImage(node, nr.left, nr.top, nr.width, nr.height); } catch {}
          ctx.restore();
        }
        ctx.restore();
        return false;
      }
      if (overlaps && tag === "svg") {
        const clone = node.cloneNode(true);
        if (!clone.getAttribute("xmlns")) clone.setAttribute("xmlns", NS);
        if (!clone.getAttribute("width")) clone.setAttribute("width", String(Math.round(nr.width / zoom)));
        if (!clone.getAttribute("height")) clone.setAttribute("height", String(Math.round(nr.height / zoom)));
        const markup = new XMLSerializer().serializeToString(clone);
        const svgImg = loadCachedImage(`svg:${markup}`, `data:image/svg+xml;charset=utf-8,${encodeURIComponent(markup)}`, onAssetLoad);
        if (svgImg) {
          try { ctx.drawImage(svgImg, nr.left, nr.top, nr.width, nr.height); } catch {}
        }
        ctx.restore();
        return false;
      }

      // Clip children if overflow is hidden/clip
      const clipped = overlaps && (cs.overflow === "hidden" || cs.overflow === "clip" || cs.overflowX === "hidden");
      if (clipped) {
        ctx.save();
        roundRectPath(ctx, nr.left, nr.top, nr.width, nr.height, cs, zoom);
        ctx.clip();
      }

      // Walk children in CSS stacking order (negative z-index -> 0/auto -> positive z-index)
      const kids = [];
      for (let i = 0; i < node.childNodes.length; i++) {
        const ch = node.childNodes[i];
        if (ch.nodeType === 3) {
          kids.push({ ch, z: 0, order: i });
        } else if (ch.nodeType === 1) {
          const zRaw = getComputedStyle(ch).zIndex;
          const z = zRaw && zRaw !== "auto" ? parseInt(zRaw, 10) || 0 : 0;
          kids.push({ ch, z, order: i });
        }
      }
      kids.sort((a, b) => a.z - b.z || a.order - b.order);

      let found = false;
      for (const item of kids) {
        if (item.ch.nodeType === 3) {
          if (overlaps) paintTextNode(ctx, item.ch, cs, zoom, cull);
        } else {
          if (walk(item.ch)) {
            found = true;
            break;
          }
        }
      }

      if (clipped) ctx.restore();

      // Paint element's own border
      const bw = parseFloat(cs.borderTopWidth) || 0;
      if (overlaps && bw > 0 && cs.borderTopStyle !== "none" && cs.borderTopColor !== "rgba(0, 0, 0, 0)") {
        ctx.save();
        roundRectPath(ctx, nr.left + (bw * zoom) * 0.5, nr.top + (bw * zoom) * 0.5, Math.max(0, nr.width - bw * zoom), Math.max(0, nr.height - bw * zoom), cs, zoom);
        ctx.strokeStyle = cs.borderTopColor;
        ctx.lineWidth = bw * zoom;
        ctx.stroke();
        ctx.restore();
      }

      ctx.restore();
      return found;
    };

    if (root) walk(root);
    return { ok: true, hasLiveShader };
  }

  // -------------------------------------------------------------------------------------------
  // Active WebGL Liquid Glass registry (paint-order refresh, live shader ticker, board edits)

  const glassHandles = new Set();
  let glassRaf = 0;
  let glassTickRaf = 0;
  let lastLiveTick = 0;

  function compareDomOrder(a, b) {
    if (a.el === b.el) return 0;
    const pos = a.el.compareDocumentPosition(b.el);
    return pos & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
  }

  function flushGlassBatch(forceCapture = false) {
    glassRaf = 0;
    const list = [...glassHandles].filter((h) => h.el.isConnected).sort(compareDomOrder);
    let anyLive = false;
    for (const h of list) {
      h.renderGlass(forceCapture);
      if (h.hasLiveShader) anyLive = true;
    }
    if (anyLive) ensureGlassLiveTick();
  }

  function scheduleGlassRefresh(forceCapture = false) {
    if (forceCapture) {
      for (const h of glassHandles) h.markBackdropDirty();
    }
    if (!glassRaf && glassHandles.size && typeof requestAnimationFrame === "function") {
      glassRaf = requestAnimationFrame(() => flushGlassBatch(false));
    }
  }

  function ensureGlassLiveTick() {
    if (glassTickRaf || !glassHandles.size || typeof requestAnimationFrame !== "function") return;
    const tick = (now) => {
      glassTickRaf = 0;
      let anyLive = false;
      const list = [...glassHandles].filter((h) => h.el.isConnected).sort(compareDomOrder);
      if (now - lastLiveTick >= 32) {
        lastLiveTick = now;
        for (const h of list) {
          if (!h.hasLiveShader) continue;
          const r = h.el.getBoundingClientRect();
          const vis = r.width > 0 && r.height > 0 && r.right > 0 && r.bottom > 0 && r.left < (G.innerWidth || 2000) && r.top < (G.innerHeight || 2000);
          if (vis) {
            h.markBackdropDirty();
            h.renderGlass(false);
            anyLive = true;
          } else {
            anyLive = true;
          }
        }
      } else {
        anyLive = list.some((h) => h.hasLiveShader);
      }
      if (anyLive && glassHandles.size) glassTickRaf = requestAnimationFrame(tick);
    };
    glassTickRaf = requestAnimationFrame(tick);
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
    let glCanvas = null;
    let backdropCanvas = null;
    let backdropDirty = true;
    let glGlassFx = null;
    let glActive = false;
    let savedIso = "";
    let lastBehindKey = "";
    let lastLayerKey = "";
    let lastSpecKey = "";
    let lastGlKey = "";
    let lastFxRef = null;
    let lastStyleHint = "";
    let lastPosHint = "";
    let lastTokenKey = "";
    let lastGeom = null;

    function clearSpec() {
      if (specCanvas) {
        specCanvas.remove();
        specCanvas = null;
      }
      lastSpecKey = "";
    }

    function clearGL() {
      if (glCanvas) {
        glCanvas.remove();
        glCanvas = null;
      }
      if (glActive) {
        glActive = false;
        glassHandles.delete(h);
        el.style.isolation = savedIso;
      }
      glGlassFx = null;
      lastGlKey = "";
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

    function renderGlass(forceCapture = false) {
      if (!glActive || !glGlassFx || !el.isConnected) return;
      const geom = readGeom(el);
      lastGeom = geom;
      const pad = clamp(Math.round(Math.min(geom.W, geom.H) * 0.36), 24, 96);
      if (!glCanvas || !glCanvas.isConnected) {
        glCanvas = el.querySelector(":scope > canvas[data-glass-gl]");
        if (!glCanvas) {
          glCanvas = document.createElement("canvas");
          glCanvas.dataset.glassGl = "1";
          glCanvas.style.cssText = "position:absolute;inset:0;width:100%;height:100%;border-radius:inherit;pointer-events:none;z-index:-1;display:block";
          const pos = getComputedStyle(el).position;
          if (pos === "static") el.style.position = "relative";
          el.prepend(glCanvas);
        }
      }
      if (!backdropCanvas) backdropCanvas = document.createElement("canvas");
      const needCapture = forceCapture || backdropDirty || !backdropCanvas.width;
      if (needCapture) {
        backdropDirty = false;
        const cap = captureBackdrop(el, geom, pad, backdropCanvas, () => {
          backdropDirty = true;
          scheduleGlassRefresh(false);
        });
        if (!cap.ok) return;
        h.hasLiveShader = cap.hasLiveShader;
        if (cap.hasLiveShader) ensureGlassLiveTick();
      }
      const tint = parseColor(getComputedStyle(el).backgroundColor || "rgba(0,0,0,0)", el);
      renderGlassWebGL(glCanvas, backdropCanvas, geom, pad, glGlassFx, tint);
    }

    function refresh(force = false, fromResize = false) {
      if (!el.isConnected) return;
      const active = (curEffects || []).filter((e) => e && !e.disabled);
      if (!active.length) {
        if (behindId) (removeFilterNode(behindId), (behindId = null));
        if (layerId) (removeFilterNode(layerId), (layerId = null));
        clearSpec();
        clearGL();
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

      // Use true 32-bit float WebGL2 Liquid Glass whenever `glass` is the behind optical effect and WebGL is available!
      const pureGlass = behind.length === 1 && behind[0].type === "glass" ? behind[0] : null;
      const useGL = Boolean(pureGlass && ensureGlassGL());

      if (useGL) {
        if (behindId) (removeFilterNode(behindId), (behindId = null), (lastBehindKey = ""));
        clearSpec();
        if (!glActive) {
          savedIso = el.style.isolation;
          el.style.isolation = "isolate";
          glActive = true;
          glassHandles.add(h);
          backdropDirty = true;
        }
        glGlassFx = pureGlass;
        const glKey = `${geomKey}:${JSON.stringify(pureGlass)}:${curOpts.tokenKey || ""}:${curOpts.posHint || ""}`;
        if (force || fromResize) backdropDirty = true;
        if (force || fromResize || glKey !== lastGlKey) {
          lastGlKey = glKey;
          renderGlass(false);
        }
      } else {
        clearGL();
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
        const specFx = behind.find((e) => e.type === "glass" || e.type === "pattern-refraction");
        const sKey = specFx ? `${geomKey}:${specSig(specFx)}` : "";
        if (specFx) {
          if (!specCanvas || !specCanvas.isConnected) {
            specCanvas = el.querySelector(":scope > canvas[data-glass-rim]");
            if (!specCanvas) {
              specCanvas = document.createElement("canvas");
              specCanvas.dataset.glassRim = "1";
              specCanvas.style.cssText = "position:absolute;inset:0;width:100%;height:100%;border-radius:inherit;pointer-events:none;z-index:2;mix-blend-mode:screen";
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

      applyCss();
    }

    const h = {
      el,
      hasLiveShader: false,
      markBackdropDirty() {
        backdropDirty = true;
      },
      renderGlass,
      refresh: () => refresh(false, true),
      update(nextEffects, nextOpts) {
        const prevFx = lastFxRef;
        const prevHint = lastStyleHint;
        const prevPos = lastPosHint;
        const prevTok = lastTokenKey;
        curEffects = Array.isArray(nextEffects) ? nextEffects : [];
        if (nextOpts) curOpts = nextOpts;
        const nextHint = curOpts.styleHint || "";
        const nextPos = curOpts.posHint || "";
        const nextTok = curOpts.tokenKey || "";
        if (prevPos !== nextPos || prevHint !== nextHint) backdropDirty = true;
        // O(1) fast path when nothing changed (e.g. canvas pan/zoom): zero DOM reads!
        if (prevFx === nextEffects && nextHint && prevHint === nextHint && prevPos === nextPos && prevTok === nextTok && lastGeom && el.isConnected) {
          applyCss();
          return;
        }
        lastFxRef = nextEffects;
        lastStyleHint = nextHint;
        lastPosHint = nextPos;
        lastTokenKey = nextTok;
        refresh(false, false);
      },
      detach() {
        ro?.unobserve(el);
        handles.delete(el);
        if (behindId) (removeFilterNode(behindId), (behindId = null));
        if (layerId) (removeFilterNode(layerId), (layerId = null));
        clearSpec();
        clearGL();
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

  async function ready() {
    scan(document);
    try {
      if (document.fonts && document.fonts.ready) await document.fonts.ready;
    } catch {}
    // First pass triggers any lazy SVG / background-image loads, then await them & paint back-to-front!
    flushGlassBatch(true);
    if (pendingAssetDecodes.size) {
      await Promise.race([Promise.all([...pendingAssetDecodes]), new Promise((r) => setTimeout(r, 1500))]);
      flushGlassBatch(true);
    }
    await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
  }

  G.BoardEffects = { attach, scan, auto, ready, refreshGlass: () => scheduleGlassRefresh(true) };
})();
