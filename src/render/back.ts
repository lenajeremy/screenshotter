/**
 * The back of a phone: camera housing, lenses, flash, LiDAR, the glass panel and the Apple
 * logo, drawn in HTML/CSS at render resolution. Geometry is in fractions of the body width (W)
 * so one layout scales to every size; positions follow Apple's product photography.
 */
import type { BackDesign, DeviceModel } from "../devices/catalog.js";

const f = (n: number) => `${Math.round(n * 100) / 100}px`;

interface Disc {
  x: number;
  y: number;
  d: number;
}

interface Housing {
  /** The raised camera area, in W units. `full` spans the whole width (plateau/bar). */
  box: { x: number; y: number; w: number; h: number; r: number; full?: boolean };
  /** A second, subtler raised rounded square around the lenses (the plateau's lens island). */
  island?: { x: number; y: number; w: number; h: number; r: number };
  lenses: Disc[];
  flash?: Disc;
  lidar?: Disc;
  mic?: Disc;
}

const HOUSINGS: Record<BackDesign["camera"], Housing> = {
  // iPhone 17 Pro / 18 Pro: lenses sit straight on the plateau, big rings in a tight triangle.
  plateau: {
    box: { x: 0, y: 0, w: 1, h: 0.62, r: 0.085, full: true },
    lenses: [
      { x: 0.2, y: 0.175, d: 0.262 },
      { x: 0.2, y: 0.445, d: 0.262 },
      { x: 0.465, y: 0.31, d: 0.262 },
    ],
    flash: { x: 0.845, y: 0.15, d: 0.1 },
    mic: { x: 0.845, y: 0.29, d: 0.02 },
    lidar: { x: 0.845, y: 0.43, d: 0.09 },
  },
  bar: {
    box: { x: 0.04, y: 0.045, w: 0.92, h: 0.3, r: 0.15 },
    lenses: [{ x: 0.2, y: 0.195, d: 0.2 }],
    flash: { x: 0.4, y: 0.195, d: 0.07 },
    mic: { x: 0.52, y: 0.195, d: 0.02 },
  },
  square: {
    box: { x: 0.045, y: 0.045, w: 0.53, h: 0.53, r: 0.17 },
    lenses: [
      { x: 0.18, y: 0.175, d: 0.205 },
      { x: 0.18, y: 0.44, d: 0.205 },
      { x: 0.425, y: 0.31, d: 0.205 },
    ],
    flash: { x: 0.44, y: 0.13, d: 0.07 },
    mic: { x: 0.46, y: 0.53, d: 0.018 },
    lidar: { x: 0.44, y: 0.485, d: 0.065 },
  },
  pill: {
    box: { x: 0.065, y: 0.06, w: 0.25, h: 0.52, r: 0.125 },
    lenses: [
      { x: 0.19, y: 0.185, d: 0.18 },
      { x: 0.19, y: 0.455, d: 0.18 },
    ],
    flash: { x: 0.4, y: 0.16, d: 0.065 },
    mic: { x: 0.4, y: 0.27, d: 0.018 },
  },
  diagonal: {
    box: { x: 0.045, y: 0.045, w: 0.43, h: 0.43, r: 0.15 },
    lenses: [
      { x: 0.155, y: 0.155, d: 0.175 },
      { x: 0.365, y: 0.365, d: 0.175 },
    ],
    flash: { x: 0.37, y: 0.14, d: 0.065 },
    mic: { x: 0.27, y: 0.26, d: 0.016 },
  },
  single: {
    box: { x: 0.05, y: 0.05, w: 0.3, h: 0.3, r: 0.1 },
    lenses: [{ x: 0.2, y: 0.2, d: 0.17 }],
  },
};

/** The Apple logo, 170 × 170 viewBox (outline traced from the product silhouette). */
export const APPLE =
  "M140.6 131.9c-2.6 6-5.7 11.5-9.3 16.5-4.9 6.8-8.9 11.5-12 14.1-4.8 4.4-9.9 6.6-15.4 6.8-4 0-8.7-1.1-14.3-3.4-5.6-2.3-10.7-3.4-15.4-3.4-4.9 0-10.2 1.1-15.8 3.4-5.7 2.3-10.2 3.5-13.7 3.6-5.3.2-10.5-2.1-15.7-6.9-3.3-2.9-7.5-7.8-12.5-14.8-5.4-7.5-9.8-16.3-13.3-26.2C3.4 111 1.6 100.5 1.6 90.4c0-11.6 2.5-21.6 7.5-30 4-6.8 9.2-12.1 15.7-16.1 6.5-4 13.6-6 21.2-6.1 4.2 0 9.7 1.3 16.5 3.9 6.8 2.6 11.2 3.9 13.1 3.9 1.4 0 6.3-1.5 14.6-4.6 7.8-2.8 14.4-4 19.8-3.5 14.6 1.2 25.6 6.9 32.9 17.4-13.1 7.9-19.5 19-19.4 33.3.1 11.1 4.1 20.4 12.1 27.7 3.6 3.4 7.7 6.1 12.2 8-1 2.8-2 5.5-3.1 8.2zM107.1 3.5c0 8.7-3.2 16.9-9.6 24.4-7.7 9-17.1 14.2-27.2 13.3-.1-1-.2-2.1-.2-3.3 0-8.4 3.6-17.3 10.1-24.6 3.2-3.7 7.3-6.8 12.3-9.2 4.9-2.4 9.6-3.8 14-4 .1 1.1.2 2.3.2 3.4z";

/** A camera lens: metal ring, black barrel, coated glass with a colour cast and a highlight. */
function lens(x: number, y: number, d: number): string {
  const ring = Math.max(1, d * 0.13);
  return (
    `<div class="lens raised" style="left:${f(x - d / 2)};top:${f(y - d / 2)};width:${f(d)};height:${f(d)};--ring:${f(ring)}">` +
    `<div class="lens-glass" style="inset:${f(ring)}"><div class="lens-coat"></div><div class="lens-spec"></div></div></div>`
  );
}

function disc(cls: string, x: number, y: number, d: number): string {
  return `<div class="${cls} raised" style="left:${f(x - d / 2)};top:${f(y - d / 2)};width:${f(d)};height:${f(d)}"></div>`;
}

/**
 * HTML for the back of `model`, filling a W × H box whose corners are `R`. `frame` is the
 * width of the metal band around a glass back, in px.
 */
export function backHtml(model: DeviceModel, W: number, H: number, R: number, frame: number): string {
  const design = model.back ?? { camera: "square", material: "glass" };
  const h = HOUSINGS[design.camera];
  const u = (v: number) => v * W;
  let out = "";

  // Material: an aluminium back with a glass window below the plateau, or a glass panel inside the band.
  if (design.material === "glass") {
    out += `<div class="back-glass" style="inset:${f(frame)};border-radius:${f(Math.max(0, R - frame))}"></div>`;
  } else {
    const top = u(h.box.h + 0.045);
    const side = u(0.045);
    out += `<div class="back-window ${design.material}" style="left:${f(side)};right:${f(side)};top:${f(top)};bottom:${f(side)};border-radius:${f(u(0.1))}"></div>`;
  }

  // Camera housing.
  const b = h.box;
  const radius = b.full ? `${f(R)} ${f(R)} ${f(u(b.r))} ${f(u(b.r))}` : f(u(b.r));
  out += `<div class="back-housing raised${b.full ? " full" : ""}" style="left:${f(u(b.x))};top:${f(u(b.y))};width:${f(u(b.w))};height:${f(u(b.h))};border-radius:${radius}"></div>`;
  if (h.island) {
    const i = h.island;
    out += `<div class="back-island raised" style="left:${f(u(i.x))};top:${f(u(i.y))};width:${f(u(i.w))};height:${f(u(i.h))};border-radius:${f(u(i.r))}"></div>`;
  }
  for (const l of h.lenses) out += lens(u(l.x), u(l.y), u(l.d));
  if (h.flash) out += disc("flash", u(h.flash.x), u(h.flash.y), u(h.flash.d));
  if (h.lidar) out += disc("lidar", u(h.lidar.x), u(h.lidar.y), u(h.lidar.d));
  if (h.mic) out += disc("mic", u(h.mic.x), u(h.mic.y), u(h.mic.d));

  // Apple logo: centred on the MagSafe coil, a little below the middle on the Pro plateau designs.
  const lw = u(design.camera === "plateau" ? 0.25 : 0.2);
  const ly = design.camera === "plateau" ? H * 0.6 : H * 0.5;
  out +=
    `<svg class="back-logo" style="left:${f(W / 2 - lw / 2)};top:${f(ly - lw / 2)};width:${f(lw)};height:${f(lw)}" viewBox="0 0 170 170">` +
    `<defs><linearGradient id="lg-${model.id}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" style="stop-color:var(--logo-hi)"/><stop offset="1" style="stop-color:var(--logo-lo)"/></linearGradient></defs>` +
    `<path d="${APPLE}" fill="url(#lg-${model.id})"/></svg>`;
  return `<div class="back-face">${out}</div>`;
}

/** The camera housing's outline for the 3D edge (it stands proud of the back), in px. */
export function housingOutline(model: DeviceModel, W: number, R: number): { x: number; y: number; w: number; h: number; radius: string } | undefined {
  const design = model.back;
  if (!design) return undefined;
  const b = HOUSINGS[design.camera].box;
  return {
    x: b.x * W,
    y: b.y * W,
    w: b.w * W,
    h: b.h * W,
    radius: b.full ? `${f(R)} ${f(R)} ${f(b.r * W)} ${f(b.r * W)}` : f(b.r * W),
  };
}

export const BACK_CSS = `
.device .back-face { position:absolute; inset:0; border-radius:inherit; overflow:hidden; }
.device .back-face > * { position:absolute; }
/* In 3D the housing stands proud of the back: lift it (and what's on it) off the surface. */
.device.d3 .face.back, .device.d3 .back-face { transform-style:preserve-3d; overflow:visible; }
.device.d3 .back-face .raised { transform:translateZ(var(--rise)); }
.device.d3 .back-face .lens { transform:translateZ(calc(var(--rise) * 1.6)); }
/* Bead-blasted aluminium / frosted glass: a faint grain over the finish colour. */
.device .face.back {
  background:
    url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='120' height='120'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='1.1' numOctaves='2' stitchTiles='stitch'/%3E%3CfeColorMatrix values='0 0 0 0 .5  0 0 0 0 .5  0 0 0 0 .5  0 0 0 .09 0'/%3E%3C/filter%3E%3Crect width='120' height='120' filter='url(%23n)'/%3E%3C/svg%3E"),
    radial-gradient(120% 70% at 18% 8%, rgba(255,255,255,.16), rgba(255,255,255,0) 55%),
    linear-gradient(160deg, rgba(255,255,255,.05), rgba(0,0,0,.14)),
    var(--c);
  --logo-hi: color-mix(in oklab, var(--c), white 14%);
  --logo-lo: color-mix(in oklab, var(--c), black 16%);
}
.device .back-glass {
  background:
    radial-gradient(110% 60% at 20% 10%, rgba(255,255,255,.14), rgba(255,255,255,0) 55%),
    linear-gradient(165deg, color-mix(in oklab, var(--c), white 10%), color-mix(in oklab, var(--c), black 6%));
  box-shadow: inset 0 0 0 calc(var(--u) * .6px) color-mix(in oklab, var(--c), black 30%), inset 0 calc(var(--u) * 1px) calc(var(--u) * 2px) rgba(255,255,255,.12);
}
/* 17 Pro: the glass window reads glossier and a touch lighter than the metal around it. */
.device .back-window.window {
  background:
    linear-gradient(160deg, rgba(255,255,255,.14), rgba(255,255,255,.02) 45%, rgba(0,0,0,.08)),
    color-mix(in oklab, var(--c), white 7%);
  box-shadow: inset 0 0 0 calc(var(--u) * .5px) color-mix(in oklab, var(--c), black 25%), 0 0 0 calc(var(--u) * .4px) color-mix(in oklab, var(--c), white 25%);
}
/* 18 Pro: colour-matched; only a hairline and a slightly different texture give it away. */
.device .back-window.matched {
  background: linear-gradient(160deg, rgba(255,255,255,.07), rgba(255,255,255,0) 50%, rgba(0,0,0,.05)), color-mix(in oklab, var(--c), white 2%);
  box-shadow: inset 0 0 0 calc(var(--u) * .45px) color-mix(in oklab, var(--c), black 16%), 0 0 0 calc(var(--u) * .35px) color-mix(in oklab, var(--c), white 18%);
}
.device .back-housing {
  background:
    linear-gradient(180deg, rgba(255,255,255,.10), rgba(255,255,255,0) 40%, rgba(0,0,0,.06)),
    color-mix(in oklab, var(--c), black 3%);
  box-shadow:
    0 calc(var(--u) * 1.4px) calc(var(--u) * 2.4px) rgba(0,0,0,.28),
    inset 0 calc(var(--u) * .7px) 0 color-mix(in oklab, var(--c), white 30%),
    inset 0 calc(var(--u) * -.6px) 0 color-mix(in oklab, var(--c), black 25%);
}
/* The plateau's lower edge is a soft rounded fillet: a lit rim, then a shadow falling onto the back. */
.device .back-housing.full {
  background:
    linear-gradient(180deg, rgba(255,255,255,.07), rgba(255,255,255,0) 30%, rgba(255,255,255,0) 82%, rgba(255,255,255,.2) 93%, rgba(0,0,0,.12) 100%),
    color-mix(in oklab, var(--c), white 2%);
  box-shadow: 0 calc(var(--u) * 2px) calc(var(--u) * 4px) rgba(0,0,0,.3), 0 calc(var(--u) * .6px) calc(var(--u) * .8px) rgba(0,0,0,.25);
}
.device .back-island {
  background: linear-gradient(170deg, color-mix(in oklab, var(--c), white 9%), color-mix(in oklab, var(--c), black 6%));
  box-shadow: 0 calc(var(--u) * .8px) calc(var(--u) * 1.6px) rgba(0,0,0,.2), inset 0 calc(var(--u) * .5px) 0 color-mix(in oklab, var(--c), white 30%);
}
/* Lens rings: anodised metal in the finish colour, polished, catching two studio lights. */
.device .lens {
  border-radius:50%;
  background:
    radial-gradient(circle at 50% 50%, rgba(0,0,0,0) 62%, rgba(255,255,255,.35) 66%, rgba(255,255,255,0) 72%),
    conic-gradient(from 200deg, color-mix(in oklab, var(--c), white 55%), color-mix(in oklab, var(--c), black 22%) 70deg, color-mix(in oklab, var(--c), white 18%) 150deg, color-mix(in oklab, var(--c), black 38%) 250deg, color-mix(in oklab, var(--c), white 30%) 320deg, color-mix(in oklab, var(--c), white 55%));
  box-shadow: 0 calc(var(--u) * 1.6px) calc(var(--u) * 3px) rgba(0,0,0,.5), 0 0 0 calc(var(--u) * .5px) color-mix(in oklab, var(--c), black 45%), inset 0 0 0 calc(var(--u) * .4px) color-mix(in oklab, var(--c), white 40%);
}
.device .lens-glass {
  position:absolute; border-radius:50%; overflow:hidden;
  background: radial-gradient(circle at 50% 50%, #0a0b0f 0 30%, #1b1d25 31% 37%, #07080b 38% 55%, #262833 56% 58%, #0b0c10 59% 84%, #1a1b20 85% 88%, #050506 89%);
  box-shadow: inset 0 0 0 calc(var(--ring) * .35) #050506, inset 0 calc(var(--u) * 1px) calc(var(--u) * 3px) rgba(0,0,0,.8);
}
.device .lens-coat { position:absolute; inset:0; border-radius:50%; background: radial-gradient(circle at 38% 34%, rgba(120,110,255,.34), rgba(80,140,255,.12) 22%, rgba(0,0,0,0) 40%), radial-gradient(circle at 62% 70%, rgba(60,200,170,.16), rgba(0,0,0,0) 30%); mix-blend-mode:screen; }
.device .lens-spec { position:absolute; left:26%; top:22%; width:16%; height:12%; border-radius:50%; background:rgba(255,255,255,.55); filter:blur(calc(var(--u) * .6px)); transform:rotate(-30deg); }
.device .flash {
  border-radius:50%;
  background:
    repeating-radial-gradient(circle at 50% 50%, rgba(0,0,0,.05) 0 calc(var(--u) * .5px), rgba(255,255,255,0) calc(var(--u) * .5px) calc(var(--u) * 1.1px)),
    radial-gradient(circle at 45% 40%, #fbfaf4, #ebe6d6 55%, #c2bca9);
  box-shadow: 0 0 0 calc(var(--u) * .9px) color-mix(in oklab, var(--c), black 35%), 0 0 0 calc(var(--u) * 1.8px) color-mix(in oklab, var(--c), white 12%), inset 0 0 calc(var(--u) * 1px) rgba(0,0,0,.25);
}
.device .lidar { border-radius:50%; background: radial-gradient(circle at 40% 35%, #2b2d35, #0a0a0c 60%); box-shadow: 0 0 0 calc(var(--u) * .7px) color-mix(in oklab, var(--c), black 40%); }
.device .mic { border-radius:50%; background:#050506; box-shadow: inset 0 calc(var(--u) * .3px) calc(var(--u) * .5px) rgba(0,0,0,.9); }
.device .back-logo { overflow:visible; filter: drop-shadow(0 calc(var(--u) * -.25px) 0 rgba(255,255,255,.18)); }
`;
