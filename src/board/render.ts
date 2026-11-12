/**
 * Drawing boards in headless Chrome: a layer as a picture (for agents to look at, for exports and
 * thumbnails) and where every layer ended up (for agents to check a layout by numbers).
 *
 * A layer is always drawn inside its whole artboard, so it looks as it does on the canvas (its
 * inherited fonts and colours, a size that fills its parent), then cut out.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { newPage } from "../render/browser.js";
import { BOARD_CSS, fontFamilies, fontLinks, nodeHtml, pxValue, rootOf, styleText, tokenCss, type Board } from "./core.js";

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

const srcUrl = (src: string) => (/^(https?:|data:|blob:|file:)/i.test(src) ? src : pathToFileURL(src).href);

/** A page of HTML with one artboard at the top left, as the canvas draws it. */
export function artboardDocument(board: Board, rootId: string): string {
  const links = fontLinks(fontFamilies(board, [rootId]))
    .map((href) => `<link rel="stylesheet" href="${href}">`)
    .join("");
  const art = nodeHtml(board, rootId, { ids: true, src: srcUrl, still: true });
  return `<!doctype html><html><head><meta charset="utf-8">${links}<style>${BOARD_CSS}html,body{margin:0;background:transparent}:root{${tokenCss(board)}}#bd-root{position:absolute;left:0;top:0}#bd-root>*{position:relative!important;left:auto!important;top:auto!important}</style></head><body><div id="bd-root">${art}</div></body></html>`;
}

/** What a layer takes from the layers around it, so a frame previewed by itself still looks as it does in place. */
const INHERITED = ["fontFamily", "fontSize", "fontWeight", "fontStyle", "lineHeight", "letterSpacing", "wordSpacing", "color", "textAlign", "textTransform", "whiteSpace", "direction"];

/**
 * A frame by itself as a web page, to open in a browser and use: the board's fonts and tokens,
 * pictures from `src`, and what it inherits from its parents. A desktop-size frame (PAGE_WIDTH or
 * wider) is the page: it fills the window, edge to edge and at least as tall. Anything smaller (a
 * phone, a card) keeps its size, centred on a quiet backdrop. Neither is ever wider than the window,
 * so narrowing it shows how the frame reflows. It updates itself when the board changes.
 */
const PAGE_WIDTH = 1024;

export function previewDocument(board: Board, id: string, opts: { width?: number; src: (src: string) => string }): string {
  const n = board.nodes[id];
  const inherit: Record<string, string> = {};
  for (let p = n.parent ? board.nodes[n.parent] : undefined; p; p = p.parent ? board.nodes[p.parent] : undefined)
    for (const k of INHERITED) if (p.style?.[k] && !(k in inherit)) inherit[k] = String(p.style[k]);
  const own = /^\s*[\d.]+px\s*$/.test(String(n.style?.width ?? "")) ? pxValue(n.style.width) : undefined;
  const w = Math.round(own ?? opts.width ?? 0) || undefined;
  const links = fontLinks(fontFamilies(board, [rootOf(board, id)]))
    .map((href) => `<link rel="stylesheet" href="${href}">`)
    .join("");
  const body = nodeHtml(board, id, { src: opts.src });
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  const page = (w ?? 0) >= PAGE_WIDTH;
  const css =
    `${BOARD_CSS}:root{${tokenCss(board)}}html,body{margin:0}body{min-height:100vh;background:#e9e9ec;` +
    (page
      ? `}#bd-frame{width:100%;`
      : w
        ? `padding:clamp(0px,calc((100vw - ${w}px) / 2),48px) 0;}#bd-frame{width:${w}px;`
        : `padding:48px 0;}#bd-frame{width:fit-content;`) +
    `max-width:100%;margin:0 auto;${styleText(inherit)}}#bd-frame>*{position:relative!important;left:auto!important;top:auto!important;max-width:100%${page ? ";width:100%!important;min-height:100vh" : ""}}`;
  // Videos that autoplay with sound start without it when the browser won't allow sound before a click.
  // Every second, while the tab shows: if the board changed, take the new frame from this same address.
  const live = `<script>const play=()=>{for(const v of document.querySelectorAll("video[autoplay]"))v.play().catch(()=>{v.muted=true;v.play().catch(()=>{})})};play();let rev=${board.rev};setInterval(async()=>{if(document.hidden)return;try{const r=await(await fetch("/api/board/rev?id=${encodeURIComponent(board.id)}")).json();if(r.rev<=rev)return;rev=r.rev;const d=new DOMParser().parseFromString(await(await fetch(location.href,{cache:"no-store"})).text(),"text/html");const f=d.getElementById("bd-frame");if(!f){document.body.innerHTML=d.body.innerHTML;return}document.getElementById("bd-frame").replaceWith(f);document.getElementById("bd-css").textContent=d.getElementById("bd-css").textContent;document.title=d.title;play()}catch{}},1000)</script>`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(n.name)} · ${esc(board.name)}</title>${links}<style id="bd-css">${css}</style></head><body><div id="bd-frame">${body}</div>${live}</body></html>`;
}

interface Drawn {
  /** Each layer's box, relative to the artboard's top left. */
  boxes: Record<string, Box>;
  /** PNG or JPEG bytes of each layer asked for. */
  images: Record<string, Buffer>;
}

/**
 * Draw an artboard and cut out the layers asked for (all on that artboard). `scale` is pixels per
 * CSS pixel; `maxEdge` shrinks it so no picture is longer than that on its longer side.
 */
export async function drawArtboard(board: Board, rootId: string, ids: string[], opts: { scale?: number; maxEdge?: number; format?: "png" | "jpeg"; quality?: number; transparent?: boolean } = {}): Promise<Drawn> {
  const dir = await mkdtemp(path.join(tmpdir(), "screenshotter-board-"));
  const file = path.join(dir, "board.html");
  await writeFile(file, artboardDocument(board, rootId));
  const page = await newPage();
  try {
    await page.setViewport({ width: 1600, height: 1000, deviceScaleFactor: 1 });
    await page.goto(pathToFileURL(file).href, { waitUntil: "load", timeout: 60_000 });
    const settle = () =>
      page.evaluate(async () => {
        await Promise.race([document.fonts.ready, new Promise((r) => setTimeout(r, 6000))]);
        await Promise.all(Array.from(document.images).map((img) => (img.complete ? Promise.resolve() : img.decode().catch(() => undefined))));
      });
    await settle();
    const measure = () =>
      page.evaluate(() => {
        const out: Record<string, { x: number; y: number; width: number; height: number }> = {};
        const root = document.querySelector("#bd-root > [data-id]") as HTMLElement | null;
        const o = root?.getBoundingClientRect() ?? { left: 0, top: 0 };
        for (const el of Array.from(document.querySelectorAll<HTMLElement>("[data-id]"))) {
          const r = el.getBoundingClientRect();
          out[el.dataset.id!] = { x: Math.round((r.left - o.left) * 100) / 100, y: Math.round((r.top - o.top) * 100) / 100, width: Math.round(r.width * 100) / 100, height: Math.round(r.height * 100) / 100 };
        }
        return out;
      });
    let boxes = await measure();
    const art = boxes[rootId] ?? { x: 0, y: 0, width: 1, height: 1 };
    // Room for the whole artboard, drawn at the scale asked for.
    let scale = opts.scale ?? 1;
    if (opts.maxEdge) {
      const longest = Math.max(1, ...ids.map((id) => Math.max(boxes[id]?.width ?? 0, boxes[id]?.height ?? 0)));
      scale = Math.min(scale, opts.maxEdge / longest);
    }
    scale = Math.max(0.05, Math.min(4, scale));
    await page.setViewport({ width: Math.max(1, Math.ceil(art.width)), height: Math.max(1, Math.ceil(art.height)), deviceScaleFactor: scale });
    await settle();
    boxes = await measure();
    const images: Record<string, Buffer> = {};
    for (const id of ids) {
      const b = boxes[id];
      if (!b || b.width < 0.5 || b.height < 0.5) continue;
      const data = await page.screenshot({
        type: opts.format ?? "png",
        quality: opts.format === "jpeg" ? opts.quality ?? 90 : undefined,
        clip: { x: b.x, y: b.y, width: b.width, height: b.height },
        omitBackground: opts.transparent ?? true,
        captureBeyondViewport: true,
      });
      images[id] = Buffer.from(data);
    }
    return { boxes, images };
  } finally {
    await page.close().catch(() => undefined);
    await rm(dir, { recursive: true, force: true });
  }
}

/** Draw layers that may be on different artboards. */
export async function drawLayers(board: Board, ids: string[], opts: Parameters<typeof drawArtboard>[3] = {}) {
  const byRoot = new Map<string, string[]>();
  for (const id of ids) {
    if (!board.nodes[id]) throw new Error(`There's no layer ${id} on this board.`);
    const r = rootOf(board, id);
    byRoot.set(r, [...(byRoot.get(r) ?? []), id]);
  }
  const images: Record<string, Buffer> = {};
  const boxes: Record<string, Box> = {};
  for (const [root, list] of byRoot) {
    const d = await drawArtboard(board, root, list, opts);
    Object.assign(images, d.images);
    for (const id of list) if (d.boxes[id]) boxes[id] = d.boxes[id];
    for (const [k, v] of Object.entries(d.boxes)) boxes[k] ??= v;
  }
  return { images, boxes };
}
