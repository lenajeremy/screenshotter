/**
 * Boards on disk: each one a JSON file in the library (.studio/boards/<id>.json). The Studio and
 * agents (the MCP server, another process) both change them, so every change is a list of steps
 * applied to the latest file under a lock: neither overwrites what the other just did.
 */
import { createHash, randomBytes } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { libraryFolder } from "../studio/scenes.js";
import { ensureDir, resolveUserPath } from "../util/files.js";
import { applyOps, emptyBoard, expandOps, mapCssUrls, newId, pxValue, reconcileOps, sizeWord, type Board, type BoardNode, type Op } from "./core.js";

const dir = () => ensureDir(path.join(libraryFolder(), ".studio", "boards"));
export const boardFile = (id: string) => path.join(dir(), `${id}.json`);
export const boardThumb = (id: string) => path.join(dir(), `${id}.jpg`);
export const assetDir = () => ensureDir(path.join(dir(), "assets"));
export const validBoardId = (id: unknown): id is string => typeof id === "string" && /^[a-z0-9]{6,32}$/.test(id);

/** A board's file that's there but can't be read (cut short, edited by hand, not a board). */
export class DamagedBoard extends Error {
  constructor(readonly id: string) {
    super(`The board ${id} can't be read: its file is damaged (${boardFile(id)}).`);
  }
}

/** The board on disk; undefined when there's no file, DamagedBoard when there's one that can't be read. */
function read(id: string): Board | undefined {
  let text: string;
  try {
    text = readFileSync(boardFile(id), "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw e;
  }
  try {
    const b = JSON.parse(text) as Board;
    if (b && typeof b === "object" && Array.isArray(b.pages) && b.nodes && typeof b.nodes === "object") return b;
  } catch {
    // Falls through to the error below.
  }
  throw new DamagedBoard(id);
}

/** A damaged board's file moved out of the way (kept beside the others, not listed), so it can be recovered. */
function setAside(id: string): string {
  const kept = `${boardFile(id)}.damaged-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  renameSync(boardFile(id), kept);
  return kept;
}

function write(b: Board) {
  const tmp = `${boardFile(b.id)}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(b));
  renameSync(tmp, boardFile(b.id));
}

const pause = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** Run `fn` holding the board's lock. */
const withLock = <T>(id: string, fn: () => T): T => withFileLock(boardFile(id), fn);

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
};
const ownerOf = (lock: string) => {
  try {
    return readFileSync(path.join(lock, "owner"), "utf8");
  } catch {
    return undefined;
  }
};

/**
 * A lock left behind: its process has gone, or it was never finished being taken (no owner after
 * a few seconds), or it's been held far longer than any change takes. A slow change by a live
 * process keeps its lock.
 */
function staleLock(lock: string): string | false {
  let age: number;
  try {
    age = Date.now() - statSync(lock).mtimeMs;
  } catch {
    return false;
  }
  const owner = ownerOf(lock);
  if (owner === undefined) return age > 5000 ? "" : false;
  const pid = Number(owner.split(":")[0]);
  return !Number.isInteger(pid) || !alive(pid) || age > 60_000 ? owner : false;
}

/**
 * Run `fn` holding a file's lock: a folder only one process can make at a time, with its owner
 * (process and a random tag) written inside, so a stale one is told from a slow one and only its
 * owner removes it.
 */
export function withFileLock<T>(file: string, fn: () => T): T {
  const lock = `${file}.lock`;
  const me = `${process.pid}:${randomBytes(6).toString("hex")}`;
  const start = Date.now();
  for (;;) {
    try {
      mkdirSync(lock);
      writeFileSync(path.join(lock, "owner"), me);
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      const stale = staleLock(lock);
      if (stale !== false) {
        // Moved aside in one step, so of two processes clearing it only one does. If what was
        // moved isn't the lock judged stale (it was replaced meanwhile), it goes back.
        const aside = `${lock}.stale-${me.replace(":", "-")}`;
        try {
          renameSync(lock, aside);
          if ((ownerOf(aside) ?? "") !== stale) renameSync(aside, lock);
          else rmSync(aside, { recursive: true, force: true });
        } catch {
          // Someone else cleared it first.
        }
        continue;
      }
      if (Date.now() - start > 8000) throw new Error("The board is busy; try again in a moment.");
      pause(6);
    }
  }
  try {
    return fn();
  } finally {
    if (ownerOf(lock) === me) rmSync(lock, { recursive: true, force: true });
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
  /** Its file is there but can't be read: it can be deleted, or the file recovered by hand. */
  damaged?: boolean;
  file?: string;
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

/** The person's scratchpad: one board that's always there for trying things out, a page per try. */
export const SCRATCHPAD = "scratchpad";

/** "scratchpad", "my scratchpad", "Scratch pad"…: what the person or an agent calls it. */
export const isScratchpad = (ref: unknown) => typeof ref === "string" && /^(my\s+|the\s+)?scratch\s*pad$/i.test(ref.trim());

/** The scratchpad, made the first time anyone asks for it. */
export function scratchpad(): Board {
  const had = readOrAside(SCRATCHPAD);
  if (had) return had;
  return withLock(SCRATCHPAD, () => {
    const now = readOrAside(SCRATCHPAD);
    if (now) return now;
    const b: Board = { ...emptyBoard(SCRATCHPAD, "Scratchpad", new Date().toISOString()), by: "studio" };
    write(b);
    return b;
  });
}

/** The scratchpad is always there: a damaged one is kept aside (to recover) and a fresh one made, never written over. */
function readOrAside(id: string): Board | undefined {
  try {
    return read(id);
  } catch (e) {
    if (!(e instanceof DamagedBoard)) throw e;
    console.error(`${e.message} It was kept as ${setAside(id)}; a new one takes its place.`);
    return undefined;
  }
}

/** A fresh page on the scratchpad for one try, named for it (the first page, while it's still empty and unnamed). */
export function scratchPage(name: string | undefined, by: "agent" | "studio"): { board: Board; page: { id: string; name: string } } {
  const b = scratchpad();
  const title = name?.trim().slice(0, 80) || `Try ${b.pages.length + 1}`;
  const first = b.pages[0];
  if (b.pages.length === 1 && !first.children.length && first.name === "Page 1") {
    return { board: changeBoard(SCRATCHPAD, [{ op: "setPage", id: first.id, name: title }], by).board, page: { id: first.id, name: title } };
  }
  const id = newId();
  return { board: changeBoard(SCRATCHPAD, [{ op: "addPage", page: { id, name: title, children: [] } }], by).board, page: { id, name: title } };
}

/** Every board, newest first, with the scratchpad (made if it isn't yet) always at the top. */
export function listBoards(): BoardSummary[] {
  scratchpad();
  const out: BoardSummary[] = [];
  for (const f of readdirSync(dir())) {
    const id = f.slice(0, -5);
    if (!f.endsWith(".json") || !validBoardId(id)) continue;
    try {
      const b = read(id);
      if (b) out.push(summarizeBoard(b));
    } catch {
      // One that can't be read is listed as that, so it doesn't just vanish (and can be deleted).
      out.push(damagedSummary(id));
    }
  }
  return out.sort((a, b) => Number(b.id === SCRATCHPAD) - Number(a.id === SCRATCHPAD) || b.updatedAt.localeCompare(a.updatedAt));
}

function damagedSummary(id: string): BoardSummary {
  const at = (() => {
    try {
      return statSync(boardFile(id)).mtime.toISOString();
    } catch {
      return new Date(0).toISOString();
    }
  })();
  return { id, name: `Damaged board (${id})`, rev: 0, createdAt: at, updatedAt: at, pages: [], layers: 0, working: [], damaged: true, file: boardFile(id) };
}

export function getBoard(id: unknown): Board {
  if (!validBoardId(id)) throw new Error("Unknown board");
  if (id === SCRATCHPAD) return scratchpad();
  const b = read(id);
  if (!b) throw new Error("That board doesn't exist (it may have been deleted).");
  return b;
}

/** A board by id, or by name: the exact name, else the only one containing the words. */
export function findBoard(ref: string): Board {
  if (ref === SCRATCHPAD || isScratchpad(ref)) return scratchpad();
  if (validBoardId(ref) && existsSync(boardFile(ref))) return getBoard(ref);
  const q = ref.trim().toLowerCase();
  const all = listBoards().filter((x) => !x.damaged);
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
  /** Copies were brought in line with their components in the same save (load it again too). */
  repaired?: boolean;
}

/**
 * Apply steps to the board on disk, as one change. Components' copies follow (`expand`), unless the
 * steps already include that (the Studio works it out as it shows the change).
 */
export function changeBoard(id: string, ops: Op[], by: "agent" | "studio", base?: number, { expand = true, reconcile = false } = {}): Changed {
  if (!validBoardId(id)) throw new Error("Unknown board");
  return withLock(id, () => {
    const current = read(id);
    if (!current) throw new Error("That board doesn't exist (it may have been deleted).");
    let { board, inverse } = applyOps(current, expand ? expandOps(current, ops) : ops);
    // Steps worked out elsewhere (the Studio's, its copies already followed) may predate a copy
    // someone else placed meanwhile: whatever they missed is put right here, in the same save.
    let repaired = false;
    if (reconcile && Object.values(board.nodes).some((n) => n.master)) {
      const fix = reconcileOps(board);
      if (fix.length) {
        const r = applyOps(board, fix);
        board = r.board;
        inverse = [...r.inverse, ...inverse];
        repaired = true;
      }
    }
    // Who is working where is bookkeeping, not a change to the design: the revision stays.
    const onlyWorking = ops.every((o) => o.op === "working" || o.op === "agent");
    const next: Board = onlyWorking ? board : { ...board, rev: current.rev + 1, updatedAt: new Date().toISOString(), by };
    write(next);
    return { board: next, inverse, stale: base !== undefined && base !== current.rev, repaired };
  });
}

export function deleteBoard(id: unknown) {
  if (!validBoardId(id)) throw new Error("Unknown board");
  if (id === SCRATCHPAD) throw new Error("The scratchpad is always there: delete its pages instead.");
  // Under the board's lock: a change being saved meanwhile would otherwise write it back.
  withLock(id, () => {
    rmSync(boardFile(id), { force: true });
    rmSync(boardThumb(id), { force: true });
  });
  rmSync(commentsFile(id), { force: true });
}

/** A board's comments live beside it (comments/<id>.json), apart from the design and its undo. */
export const commentsFile = (id: string) => path.join(ensureDir(path.join(dir(), "comments")), `${id}.json`);

export function duplicateBoard(id: unknown): Board {
  const b = getBoard(id);
  const now = new Date().toISOString();
  // The agents (and the comments that go to them) stay with the original.
  const copy: Board = { ...structuredClone(b), id: newId(12), name: `${b.name} copy`, rev: 0, createdAt: now, updatedAt: now, by: "studio", working: {}, agents: {} };
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
    if ((n.type !== "image" && n.type !== "video") || !n.src) continue;
    const adopted = adoptImage(n.src, lib);
    if (adopted.warning) warnings.push(adopted.warning);
    n.src = adopted.src;
    if (n.type === "video" && n.poster) n.poster = adoptImage(n.poster, lib).src;
  }
  for (const n of Object.values(nodes)) adoptCssPictures(n.style, warnings, lib);
  return nodes;
}

/** A local file in CSS (url(/path), url(~/path), url(file://…)): a picture to copy into the library. */
const LOCAL_URL = /url\(\s*['"]?(\/|~|file:)/i;

/**
 * Pictures that CSS points at (a background-image, say) copied into the library like image layers'
 * are, so the Studio can show them (it serves only the library's files).
 */
export function adoptCssPictures(style: Record<string, string | null | undefined>, warnings: string[] = [], lib = path.resolve(libraryFolder())) {
  for (const [k, v] of Object.entries(style)) {
    if (typeof v !== "string" || !LOCAL_URL.test(v)) continue;
    style[k] = mapCssUrls(v, (src) => {
      if (!/^(\/|~|file:)/i.test(src)) return src;
      const adopted = adoptImage(src, lib);
      if (adopted.warning) warnings.push(adopted.warning);
      return adopted.src;
    });
  }
}

export function adoptImage(src: string, lib = path.resolve(libraryFolder())): { src: string; warning?: string } {
  if (/^(https?:|data:|blob:)/i.test(src)) return { src };
  const file = resolveUserPath(src.replace(/^file:\/\//, ""));
  if (!existsSync(file)) return { src, warning: `There's no picture at ${src}: its image layer is empty.` };
  if (file.startsWith(lib + path.sep)) return { src: file };
  const ext = path.extname(file).toLowerCase() || ".png";
  // A big file (a video) is known by where it is, its size and when it changed, not read whole to be hashed.
  const st = statSync(file);
  const hash = createHash("sha1")
    .update(st.size > 64 * 1024 * 1024 ? `${file}:${st.size}:${st.mtimeMs}` : readFileSync(file))
    .digest("hex")
    .slice(0, 16);
  const out = path.join(assetDir(), `${hash}${ext}`);
  if (!existsSync(out)) copyFileSync(file, out);
  return { src: out };
}
