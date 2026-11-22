/**
 * Bringing Figma in without Figma's API: a .fig file (File › Save local copy) or frames copied in
 * Figma (⌘C) and pasted. The frames land on a board as artboards of ordinary layers, where they
 * sat relative to each other, with their pictures (from a .fig) and their Google fonts.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { libraryFolder } from "../util/files.js";
import { freeSpot, htmlToNodes, newId, type BoardFont, type Op } from "./core.js";
import { changeBoard, createBoard, getBoard } from "./store.js";
import { forLatin, saveAsset } from "./web-import.js";
import { readFigClipboard, readFigFile, type FigArchive } from "./fig-file.js";
import { loadPathKit } from "./pathkit.js";
import { copiedRoots, figDoc, newCtx, nodeHtml, placeOf, resolveTree, type FigDoc, type FNode } from "./fig-convert.js";

type Progress = (fraction: number, step?: string) => void;

export interface FigImportResult {
  board: string;
  name: string;
  /** Each with the board page it's on. */
  artboards: { id: string; name: string; page: string }[];
  /** How many pages it filled. */
  pages: number;
  layers: number;
  pictures: number;
  fonts: number;
  warnings: string[];
}

const MAX_FRAMES = 80;
const FRAMES = new Set(["FRAME", "SECTION", "SYMBOL", "INSTANCE"]);

/** The fonts a design uses, from Google Fonts where it has them (others need to be on this Mac). */
async function googleFonts(used: Map<string, Set<string>>, warnings: Set<string>): Promise<BoardFont[]> {
  const out: BoardFont[] = [];
  const missing: string[] = [];
  for (const [family, variants] of used) {
    const tuples = [...variants]
      .map((v) => [v.endsWith("i") ? 1 : 0, parseInt(v)] as const)
      .sort((a, b) => a[0] - b[0] || a[1] - b[1])
      .map(([i, w]) => `${i},${w}`);
    const url = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(family).replace(/%20/g, "+")}:ital,wght@${[...new Set(tuples)].join(";")}&display=swap`;
    let cssText = "";
    try {
      const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36" } });
      if (!r.ok) {
        missing.push(family);
        continue;
      }
      cssText = await r.text();
    } catch {
      missing.push(family);
      continue;
    }
    for (const m of cssText.matchAll(/@font-face\s*{([^}]*)}/g)) {
      const block = m[1];
      const get = (k: string) => new RegExp(`${k}:\\s*([^;]+);`).exec(block)?.[1].trim();
      const range = get("unicode-range") ?? "";
      if (!forLatin(range)) continue;
      const src = /url\(([^)]+)\)/.exec(get("src") ?? "")?.[1];
      if (!src) continue;
      try {
        const f = await fetch(src);
        if (!f.ok) continue;
        const file = saveAsset(Buffer.from(await f.arrayBuffer()), "woff2");
        const style = get("font-style");
        out.push({ family, weight: get("font-weight"), ...(style && style !== "normal" ? { style } : {}), src: file, ...(range ? { unicodeRange: range } : {}) });
      } catch {
        // One face missing: the rest still come.
      }
    }
  }
  if (missing.length) warnings.add(`${missing.join(", ")} ${missing.length === 1 ? "isn't" : "aren't"} on Google Fonts: ${missing.length === 1 ? "it shows" : "they show"} right where ${missing.length === 1 ? "it's" : "they're"} installed on this Mac.`);
  return out;
}

export interface FigImportOptions {
  /** A .fig file, by path or its bytes. */
  file?: string;
  data?: Buffer;
  /** Or what Figma put on the clipboard (its HTML). */
  html?: string;
  /** The board page to put it on. */
  page?: string;
  /** In a .fig: the Figma page to bring in, by name (default the first). */
  figmaPage?: string;
}

/**
 * Pictures a paste points to but doesn't carry (Figma's clipboard holds only their hashes): the
 * library's own copy when the file was brought in before (a picture's hash is its contents'), else
 * from Figma itself when there's a token to ask with. What's still missing is said by picture().
 */
async function bringPictures(d: FigDoc, fileKey: string | undefined, warnings: Set<string>, progress: Progress) {
  const wanted = new Set<string>();
  const look = (v: unknown, depth: number) => {
    if (!v || typeof v !== "object" || depth > 12) return;
    if (Array.isArray(v)) return v.forEach((x) => look(x, depth + 1));
    const o = v as Record<string, any>;
    if (o.type === "IMAGE" && o.image?.hash) wanted.add(typeof o.image.hash === "string" ? o.image.hash : Buffer.from(Object.values(o.image.hash) as number[]).toString("hex"));
    for (const [k, x] of Object.entries(o)) if (k !== "children" && x && typeof x === "object" && !(x instanceof Uint8Array)) look(x, depth + 1);
  };
  for (const n of d.byId.values()) look(n, 0);
  let missing = [...wanted].filter((h) => !d.images.has(h));
  if (!missing.length) return;
  const dir = path.join(libraryFolder(), "images", "figma");
  if (existsSync(dir)) {
    const files = readdirSync(dir);
    for (const h of missing) {
      const f = files.find((x) => x.startsWith(h.slice(0, 20)));
      if (f) d.images.set(h, readFileSync(path.join(dir, f)));
    }
  }
  missing = missing.filter((h) => !d.images.has(h));
  const token = process.env.FIGMA_TOKEN?.trim();
  if (!missing.length || !token || !fileKey) return;
  progress(0.15, "Fetching pictures from Figma");
  try {
    const r = await fetch(`https://api.figma.com/v1/files/${encodeURIComponent(fileKey)}/images`, { headers: { "X-Figma-Token": token }, signal: AbortSignal.timeout(30_000) });
    if (!r.ok) {
      if (r.status === 429) warnings.add("Figma is limiting how often this account can ask for pictures right now, so some didn't come. Drop the .fig file instead (File › Save local copy), or paste again later.");
      return;
    }
    const urls: Record<string, string> = ((await r.json()) as { meta?: { images?: Record<string, string> } }).meta?.images ?? {};
    const queue = missing.filter((h) => urls[h]);
    await Promise.all(
      Array.from({ length: 6 }, async () => {
        for (let h = queue.shift(); h; h = queue.shift()) {
          try {
            const got = await fetch(urls[h], { signal: AbortSignal.timeout(60_000) });
            if (got.ok) d.images.set(h, Buffer.from(await got.arrayBuffer()));
          } catch {
            // That one stays missing (and is said).
          }
        }
      }),
    );
  } catch {
    // Offline, or Figma didn't answer: what's missing is said.
  }
}

export async function importFig(boardId: string | null | undefined, o: FigImportOptions, by: "agent" | "studio", progress: Progress = () => undefined): Promise<FigImportResult> {
  progress(0.05, "Reading Figma's file");
  // Skia's path operations, for joining shapes Figma didn't store an outline for (as in a paste).
  await loadPathKit();
  const archive: FigArchive = o.html ? readFigClipboard(o.html) : readFigFile(o.data ?? readFileSync(o.file!));
  const d = figDoc(archive);
  const ctx = newCtx(d);
  if (o.html) await bringPictures(d, (archive as { fileKey?: string }).fileKey, ctx.warnings, progress);
  // What comes in, page by page: what was copied; or the file's pages (all of them, onto a new
  // board, each its own page; one page, onto a board already open).
  const framesOf = (page: FNode) => {
    const kids = page.children.filter((n) => n.visible !== false);
    const frames = kids.filter((n) => FRAMES.has(n.type));
    return frames.length ? frames : kids;
  };
  let groups: Array<{ name: string; roots: FNode[] }>;
  let name = archive.name ?? "Figma";
  if (o.html) {
    const roots = copiedRoots(d).filter((n) => n.visible !== false);
    groups = [{ name: "", roots }];
    name = roots.length === 1 ? (roots[0].name ?? name) : "From Figma";
  } else {
    const named = o.figmaPage ? d.pages.find((p) => p.name?.trim().toLowerCase() === o.figmaPage!.trim().toLowerCase()) : undefined;
    const pages = named ? [named] : boardId ? [d.pages.find((p) => p.children.some((k) => FRAMES.has(k.type))) ?? d.pages[0]].filter(Boolean) : d.pages.filter((p) => framesOf(p).length);
    groups = pages.map((p) => ({ name: p.name ?? "Page", roots: framesOf(p) }));
  }
  groups = groups.filter((g) => g.roots.length);
  if (!groups.length) throw new Error("There's nothing there to bring in.");
  let total = 0;
  for (const g of groups) {
    const room = Math.max(0, MAX_FRAMES - total);
    if (g.roots.length > room) ctx.warnings.add(`There are more than ${MAX_FRAMES} frames: the first ${MAX_FRAMES} came in.`);
    g.roots = g.roots.slice(0, room);
    total += g.roots.length;
  }
  groups = groups.filter((g) => g.roots.length);
  progress(0.3, "Making the layers");
  const fresh = !boardId;
  const id = boardId || createBoard(name, by).id;
  const board = getBoard(id);
  const ops: Op[] = [];
  const artboards: { id: string; name: string; page: string }[] = [];
  let layers = 0;
  groups.forEach((g, gi) => {
    // On a new board, each Figma page is a page of its own (the first named after it); else this page.
    let pid: string;
    if (fresh && gi > 0) {
      pid = newId();
      ops.push({ op: "addPage", page: { id: pid, name: g.name, children: [] } });
    } else {
      pid = o.page && board.pages.some((p) => p.id === o.page) ? o.page : board.pages[0].id;
      if (fresh && g.name) ops.push({ op: "setPage", id: pid, name: g.name });
    }
    const x0 = Math.min(...g.roots.map((r) => placeOf(r).x));
    const y0 = Math.min(...g.roots.map((r) => placeOf(r).y));
    const spot = gi === 0 ? freeSpot(board, pid, 0) : { left: 0, top: 0 };
    for (const r of g.roots) {
      const tree = resolveTree(d, r);
      const made = htmlToNodes(nodeHtml(ctx, tree, null), { wholeSvg: true });
      for (const w of made.warnings) ctx.warnings.add(w);
      const root = made.roots[0];
      if (!root) continue;
      const st = made.nodes[root].style;
      delete st.position;
      const at = placeOf(r);
      st.left = `${Math.round(spot.left + at.x - x0)}px`;
      st.top = `${Math.round(spot.top + at.y - y0)}px`;
      for (const k of made.roots) made.nodes[k].parent = null;
      ops.push({ op: "add", nodes: made.nodes, ids: [root], parent: null, page: pid });
      artboards.push({ id: root, name: made.nodes[root].name ?? "Frame", page: pid });
      layers += Object.keys(made.nodes).length;
    }
  });
  progress(0.7, "Bringing its fonts");
  const fonts = await googleFonts(ctx.fonts, ctx.warnings);
  const have = new Set((board.fonts ?? []).map((f) => [f.family.toLowerCase(), f.weight ?? "", f.style ?? "", f.unicodeRange ?? ""].join("|")));
  for (const font of fonts) if (!have.has([font.family.toLowerCase(), font.weight ?? "", font.style ?? "", font.unicodeRange ?? ""].join("|"))) ops.unshift({ op: "font", font });
  changeBoard(id, ops, by);
  progress(1, "Done");
  return { board: id, name, artboards, pages: groups.length, layers, pictures: ctx.pictures.size, fonts: fonts.length, warnings: [...ctx.warnings].slice(0, 12) };
}
