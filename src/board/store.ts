/**
 * Boards on disk: each one a JSON file in the library (.studio/boards/<id>.json). The Studio and
 * agents (the MCP server, another process) both change them, so every change is a list of steps
 * applied to the latest file under a lock: neither overwrites what the other just did.
 */
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { libraryFolder } from "../studio/scenes.js";
import { ensureDir, resolveUserPath } from "../util/files.js";
import { applyOps, emptyBoard, expandOps, newId, pxValue, sizeWord, type Board, type BoardNode, type Op } from "./core.js";

const dir = () => ensureDir(path.join(libraryFolder(), ".studio", "boards"));
export const boardFile = (id: string) => path.join(dir(), `${id}.json`);
export const boardThumb = (id: string) => path.join(dir(), `${id}.jpg`);
export const assetDir = () => ensureDir(path.join(dir(), "assets"));
export const validBoardId = (id: unknown): id is string => typeof id === "string" && /^[a-z0-9]{6,32}$/.test(id);

function read(id: string): Board | undefined {
  try {
    return JSON.parse(readFileSync(boardFile(id), "utf8"));
  } catch {
    return undefined;
  }
}

function write(b: Board) {
  const tmp = `${boardFile(b.id)}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(b));
  renameSync(tmp, boardFile(b.id));
}

const pause = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** Run `fn` holding the board's lock (a folder, which only one process can make at a time). */
function withLock<T>(id: string, fn: () => T): T {
  const lock = `${boardFile(id)}.lock`;
  const start = Date.now();
  for (;;) {
    try {
      mkdirSync(lock);
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      try {
        // A lock left by a process that died mid-change.
        if (Date.now() - statSync(lock).mtimeMs > 5000) {
          rmSync(lock, { recursive: true, force: true });
          continue;
        }
      } catch {
        continue;
      }
      if (Date.now() - start > 8000) throw new Error("The board is busy; try again in a moment.");
      pause(6);
    }
  }
  try {
    return fn();
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

export interface BoardSummary {
  id: string;
  name: string;
  rev: number;
  createdAt: string;
  updatedAt: string;
  by?: "agent" | "studio";
  pages: Array<{ id: string; name: string; artboards: Array<{ id: string; name: string; width: string; height: string; x: number; y: number }> }>;
  layers: number;
  /** Its thumbnail, once rendered, and when it was drawn. */
  thumb?: string;
  thumbAt?: number;
  /** Artboards an agent wrote to in the last minute. */
  working: string[];
}

export const WORKING_MS = 60_000;

export function summarizeBoard(b: Board): BoardSummary {
  const thumb = boardThumb(b.id);
  const now = Date.now();
  return {
    id: b.id,
    name: b.name,
    rev: b.rev,
    createdAt: b.createdAt,
    updatedAt: b.updatedAt,
    by: b.by,
    pages: b.pages.map((p) => ({
      id: p.id,
      name: p.name,
      artboards: p.children
        .filter((id) => b.nodes[id])
        .map((id) => ({ id, name: b.nodes[id].name, width: sizeWord(b, id, "width"), height: sizeWord(b, id, "height"), x: pxValue(b.nodes[id].style.left) ?? 0, y: pxValue(b.nodes[id].style.top) ?? 0 })),
    })),
    layers: Object.keys(b.nodes).length,
    thumb: existsSync(thumb) ? thumb : undefined,
    thumbAt: existsSync(thumb) ? statSync(thumb).mtimeMs : undefined,
    working: Object.entries(b.working ?? {})
      .filter(([, at]) => now - Date.parse(at) < WORKING_MS)
      .map(([id]) => id),
  };
}

export function listBoards(): BoardSummary[] {
  const out: BoardSummary[] = [];
  for (const f of readdirSync(dir())) {
    if (!f.endsWith(".json")) continue;
    const b = read(f.slice(0, -5));
    if (!b?.pages) continue;
    try {
      out.push(summarizeBoard(b));
    } catch {
      // One odd file never hides the rest.
    }
  }
  return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function getBoard(id: unknown): Board {
  if (!validBoardId(id)) throw new Error("Unknown board");
  const b = read(id);
  if (!b) throw new Error("That board doesn't exist (it may have been deleted).");
  return b;
}

/** A board by id, or by name: the exact name, else the only one containing the words. */
export function findBoard(ref: string): Board {
  if (validBoardId(ref) && existsSync(boardFile(ref))) return getBoard(ref);
  const q = ref.trim().toLowerCase();
  const all = listBoards();
  const exact = all.filter((x) => x.name.toLowerCase() === q);
  const hits = exact.length ? exact : all.filter((x) => x.name.toLowerCase().includes(q));
  if (hits.length === 1) return getBoard(hits[0].id);
  if (!hits.length) throw new Error(`No board is called "${ref}". board_list shows them.`);
  throw new Error(`Several boards match "${ref}": ${hits.map((h) => `${h.name} (${h.id})`).join(", ")}. Give the id.`);
}

export function createBoard(name: string | undefined, by: "agent" | "studio"): Board {
  const id = newId(12);
  const now = new Date().toISOString();
  const b = { ...emptyBoard(id, name?.trim() || "Untitled board", now), by };
  write(b);
  return b;
}

export interface Changed {
  board: Board;
  inverse: Op[];
  /** Someone else changed the board since `base`: the caller should load it again. */
  stale: boolean;
}

/**
 * Apply steps to the board on disk, as one change. Components' copies follow (`expand`), unless the
 * steps already include that (the Studio works it out as it shows the change).
 */
export function changeBoard(id: string, ops: Op[], by: "agent" | "studio", base?: number, { expand = true } = {}): Changed {
  if (!validBoardId(id)) throw new Error("Unknown board");
  return withLock(id, () => {
    const current = read(id);
    if (!current) throw new Error("That board doesn't exist (it may have been deleted).");
    const { board, inverse } = applyOps(current, expand ? expandOps(current, ops) : ops);
    const onlyWorking = ops.every((o) => o.op === "working");
    const next: Board = onlyWorking ? board : { ...board, rev: current.rev + 1, updatedAt: new Date().toISOString(), by };
    write(next);
    return { board: next, inverse, stale: base !== undefined && base !== current.rev };
  });
}

export function deleteBoard(id: unknown) {
  if (!validBoardId(id)) throw new Error("Unknown board");
  rmSync(boardFile(id), { force: true });
  rmSync(boardThumb(id), { force: true });
}

export function duplicateBoard(id: unknown): Board {
  const b = getBoard(id);
  const now = new Date().toISOString();
  const copy: Board = { ...structuredClone(b), id: newId(12), name: `${b.name} copy`, rev: 0, createdAt: now, updatedAt: now, by: "studio", working: {} };
  write(copy);
  return copy;
}

/**
 * Pictures from outside the library are copied in (by their contents, so the same one is kept once),
 * so a board still shows them after the original moves. URLs and data: URIs are left as they are.
 */
export function adoptImages(nodes: Record<string, BoardNode>, warnings: string[] = []): Record<string, BoardNode> {
  const lib = path.resolve(libraryFolder());
  for (const n of Object.values(nodes)) {
    if (n.type !== "image" || !n.src) continue;
    const adopted = adoptImage(n.src, lib);
    if (adopted.warning) warnings.push(adopted.warning);
    n.src = adopted.src;
  }
  return nodes;
}

export function adoptImage(src: string, lib = path.resolve(libraryFolder())): { src: string; warning?: string } {
  if (/^(https?:|data:|blob:)/i.test(src)) return { src };
  const file = resolveUserPath(src.replace(/^file:\/\//, ""));
  if (!existsSync(file)) return { src, warning: `There's no picture at ${src}: its image layer is empty.` };
  if (file.startsWith(lib + path.sep)) return { src: file };
  const ext = path.extname(file).toLowerCase() || ".png";
  const hash = createHash("sha1").update(readFileSync(file)).digest("hex").slice(0, 16);
  const out = path.join(assetDir(), `${hash}${ext}`);
  if (!existsSync(out)) copyFileSync(file, out);
  return { src: out };
}
