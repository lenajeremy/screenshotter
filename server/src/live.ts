/**
 * Live team boards over WebSockets: one room per open board. Everyone in the room sends their
 * changes (the board's own operations, as the app makes them); the server applies each batch in
 * the order it arrives, with the app's own code, gives it the next revision, keeps it, and only
 * then confirms it to its sender and passes it to everyone else. A batch that can't apply (a
 * layer someone else just deleted) is refused on its own, and its sender undoes it. Cursors,
 * selections and what people are looking at are passed along as they come and never kept.
 *
 * Connect to /live?board=ID[&since=REV] with an Authorization: Bearer header (the Mac's engine),
 * or with ?ticket= from POST /api/live/ticket (a browser can't set headers).
 */
import { randomBytes } from "node:crypto";
import type http from "node:http";
import type { Duplex } from "node:stream";
import type pg from "pg";
import { WebSocket, WebSocketServer } from "ws";
import type { Auth } from "./auth.js";
import { boardFor, HttpError, sessionOf, type Session } from "./boards.js";
import { roleIn } from "./db.js";
import { applyOps, type Board, type Op } from "./shared/core.js";

/** Server → client. */
export type Down =
  | { t: "welcome"; board: string; rev: number; you: Peer; peers: Peer[]; doc?: Board; changes?: Change[] }
  | { t: "ops"; rev: number; ops: Op[]; by: string; agent?: string }
  | { t: "ack"; id: string; rev: number }
  | { t: "reject"; id: string; rev: number; reason: string }
  | { t: "joined"; peer: Peer }
  | { t: "left"; peer: string }
  | { t: "presence"; peer: string; p: Presence }
  | { t: "resync"; reason: string }
  | { t: "error"; reason: string };
/** Client → server. */
export type Up = { t: "ops"; id: string; ops: Op[]; agent?: string } | { t: "presence"; p: Presence } | { t: "ping" };

export interface Peer {
  /** This connection (one person can have the board open twice). */
  id: string;
  user: { id: string; name: string; email: string; image?: string | null };
  color: string;
  agent?: string;
}
export interface Presence {
  page?: string;
  cursor?: { x: number; y: number } | null;
  selection?: string[];
  viewport?: { x: number; y: number; zoom: number; w?: number; h?: number };
  tool?: string;
}
export interface Change {
  rev: number;
  ops: Op[];
  by: string;
  agent?: string;
}

interface Client {
  ws: WebSocket;
  peer: Peer;
  presence?: Presence;
  alive: boolean;
}
interface Room {
  id: string;
  teamId: string;
  doc: Board;
  rev: number;
  savedRev: number;
  clients: Set<Client>;
  /** Changes are kept and passed on one at a time, in revision order. */
  queue: Promise<void>;
  saveTimer?: NodeJS.Timeout;
  closeTimer?: NodeJS.Timeout;
  broken?: boolean;
}

const COLORS = ["#e5484d", "#f76b15", "#ffb224", "#46a758", "#12a594", "#0090ff", "#3e63dd", "#8e4ec6", "#d6409f", "#ab4aba"];
const colorOf = (s: string) => COLORS[[...s].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) >>> 0, 7) % COLORS.length];
const MAX_OPS = 5000;
const SNAPSHOT_EVERY_MS = 2000;
const CLOSE_AFTER_MS = 30_000;

export function attachLive(server: http.Server, auth: Auth, pool: pg.Pool) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024 });
  const rooms = new Map<string, Promise<Room>>();
  /** One-use tickets for browsers: ticket → who, which board, until when. */
  const tickets = new Map<string, { user: Session["user"]; board: string; until: number }>();

  const send = (c: Client, m: Down) => c.ws.readyState === WebSocket.OPEN && c.ws.send(JSON.stringify(m));
  const others = (room: Room, from: Client | null, m: Down) => {
    const data = JSON.stringify(m);
    for (const c of room.clients) if (c !== from && c.ws.readyState === WebSocket.OPEN) c.ws.send(data);
  };

  async function load(id: string): Promise<Room> {
    const r = await pool.query(`select team_id, rev, doc from boards where id = $1`, [id]);
    if (!r.rows[0]) throw new HttpError(404, "There's no such board.");
    let doc: Board = r.rows[0].doc;
    let rev: number = r.rows[0].rev;
    // Changes kept after the last snapshot (the server stopped before writing it): applied again.
    const later = await pool.query(`select rev, ops from board_changes where board_id = $1 and rev > $2 order by rev`, [id, rev]);
    for (const row of later.rows) {
      try {
        doc = applyOps(doc, row.ops).board;
      } catch {
        // A change that no longer applies was refused when it was made: it can't be here.
      }
      rev = row.rev;
    }
    return { id, teamId: r.rows[0].team_id, doc: { ...doc, rev }, rev, savedRev: r.rows[0].rev, clients: new Set(), queue: Promise.resolve() };
  }
  const open = (id: string) => {
    let p = rooms.get(id);
    if (!p) {
      p = load(id);
      rooms.set(id, p);
      p.catch(() => rooms.delete(id));
    }
    return p;
  };

  async function snapshot(room: Room) {
    if (room.savedRev === room.rev || room.broken) return;
    const rev = room.rev;
    await pool.query(`update boards set doc = $2, rev = $3, name = $4, updated_at = now() where id = $1 and rev < $3`, [room.id, JSON.stringify(room.doc), rev, room.doc.name]);
    room.savedRev = rev;
  }
  const later = (room: Room) => {
    if (room.saveTimer) return;
    room.saveTimer = setTimeout(() => {
      room.saveTimer = undefined;
      room.queue = room.queue.then(() => snapshot(room)).catch((e) => console.error("[live] snapshot", e));
    }, SNAPSHOT_EVERY_MS);
  };

  /** Another copy of the server took this board's next revision: this room is out of date. */
  function broken(room: Room, why: string) {
    room.broken = true;
    rooms.delete(room.id);
    for (const c of room.clients) send(c, { t: "resync", reason: why });
    for (const c of room.clients) c.ws.close(1012, "resync");
  }

  function change(room: Room, c: Client, m: Extract<Up, { t: "ops" }>) {
    const id = String(m.id ?? "").slice(0, 100);
    if (!Array.isArray(m.ops) || !m.ops.length || m.ops.length > MAX_OPS) return send(c, { t: "reject", id, rev: room.rev, reason: "A change needs between 1 and 5000 operations." });
    let next: Board;
    try {
      next = applyOps(room.doc, m.ops).board;
    } catch (e) {
      return send(c, { t: "reject", id, rev: room.rev, reason: (e as Error).message });
    }
    room.rev += 1;
    const rev = room.rev;
    room.doc = { ...next, rev, updatedAt: new Date().toISOString() };
    const agent = (m.agent ?? c.peer.agent)?.slice(0, 80) || undefined;
    room.queue = room.queue
      .then(async () => {
        if (room.broken) return;
        try {
          await pool.query(`insert into board_changes (board_id, rev, ops, by_user, by_agent) values ($1, $2, $3, $4, $5)`, [room.id, rev, JSON.stringify(m.ops), c.peer.user.id, agent ?? null]);
        } catch (e) {
          if ((e as { code?: string }).code === "23505") return broken(room, "This board changed on another server: open it again.");
          throw e;
        }
        send(c, { t: "ack", id, rev });
        others(room, c, { t: "ops", rev, ops: m.ops, by: c.peer.id, ...(agent ? { agent } : {}) });
        later(room);
      })
      .catch((e) => {
        console.error("[live] change", e);
        broken(room, "The server couldn't keep a change: open the board again.");
      });
  }

  async function join(ws: WebSocket, user: Session["user"], boardId: string, since: number | null, agent: string | undefined) {
    let room: Room;
    try {
      room = await open(boardId);
    } catch {
      ws.close(1011, "Couldn't open the board");
      return;
    }
    if (room.closeTimer) (clearTimeout(room.closeTimer), (room.closeTimer = undefined));
    const peer: Peer = { id: randomBytes(6).toString("hex"), user, color: colorOf(user.id), ...(agent ? { agent } : {}) };
    const c: Client = { ws, peer, alive: true };
    // Up to date: the changes since what it has (if they're all kept), else the board whole.
    await room.queue;
    let changes: Change[] | undefined;
    if (since !== null && since <= room.rev) {
      const r = await pool.query(`select rev, ops, by_user as by, by_agent as agent from board_changes where board_id = $1 and rev > $2 order by rev`, [room.id, since]);
      if (r.rows.length === room.rev - since) changes = r.rows.map((x) => ({ rev: x.rev, ops: x.ops, by: x.by, ...(x.agent ? { agent: x.agent } : {}) }));
    }
    room.clients.add(c);
    send(c, { t: "welcome", board: room.id, rev: room.rev, you: peer, peers: [...room.clients].filter((x) => x !== c).map((x) => x.peer), ...(changes ? { changes } : { doc: room.doc }) });
    for (const x of room.clients) if (x !== c && x.presence) send(c, { t: "presence", peer: x.peer.id, p: x.presence });
    others(room, c, { t: "joined", peer });

    ws.on("pong", () => (c.alive = true));
    ws.on("message", (data) => {
      let m: Up;
      try {
        m = JSON.parse(String(data));
      } catch {
        return send(c, { t: "error", reason: "That wasn't JSON." });
      }
      if (m.t === "ops") change(room, c, m);
      else if (m.t === "presence") {
        c.presence = cleanPresence(m.p);
        others(room, c, { t: "presence", peer: peer.id, p: c.presence });
      }
    });
    ws.on("close", () => {
      room.clients.delete(c);
      others(room, c, { t: "left", peer: peer.id });
      if (!room.clients.size)
        room.closeTimer = setTimeout(() => {
          if (room.clients.size) return;
          rooms.delete(room.id);
          room.queue = room.queue.then(() => snapshot(room)).catch((e) => console.error("[live] snapshot", e));
        }, CLOSE_AFTER_MS);
    });
  }

  server.on("upgrade", async (req: http.IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(req.url ?? "/", "http://server");
    if (url.pathname !== "/live") return void socket.destroy();
    const refuse = (status: number, text: string) => {
      socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      socket.destroy();
    };
    try {
      const boardId = url.searchParams.get("board") ?? "";
      let user: Session["user"] | null = null;
      const ticket = url.searchParams.get("ticket");
      if (ticket) {
        const t = tickets.get(ticket);
        tickets.delete(ticket);
        if (t && t.until > Date.now() && t.board === boardId) user = t.user;
      } else {
        const headers = new Headers();
        for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
        user = (await sessionOf(auth, headers))?.user ?? null;
      }
      if (!user) return refuse(401, "Unauthorized");
      await boardFor(pool, user.id, boardId);
      const since = url.searchParams.has("since") ? Number(url.searchParams.get("since")) : null;
      const agent = url.searchParams.get("agent")?.slice(0, 80) || undefined;
      const who = user;
      wss.handleUpgrade(req, socket, head, (ws) => void join(ws, who, boardId, Number.isInteger(since) ? since : null, agent));
    } catch (e) {
      refuse(e instanceof HttpError ? e.status : 500, e instanceof HttpError ? "Not Found" : "Error");
    }
  });

  // Connections that stopped answering are closed; people removed from a team are let go.
  const beat = setInterval(async () => {
    for (const p of rooms.values()) {
      const room = await p.catch(() => null);
      if (!room) continue;
      for (const c of room.clients) {
        if (!c.alive) {
          c.ws.terminate();
          continue;
        }
        c.alive = false;
        c.ws.ping();
        if (!(await roleIn(pool, c.peer.user.id, room.teamId).catch(() => "unknown"))) c.ws.close(4403, "You're no longer in this team.");
      }
    }
    const now = Date.now();
    for (const [k, t] of tickets) if (t.until < now) tickets.delete(k);
  }, 30_000);

  return {
    /** A one-use ticket to open a board live from a browser (valid 30 seconds). */
    async ticket(user: Session["user"], board: string) {
      await boardFor(pool, user.id, board);
      const t = randomBytes(24).toString("base64url");
      tickets.set(t, { user, board, until: Date.now() + 30_000 });
      return t;
    },
    /** Keep every open board and close every connection (the server is stopping: clients reconnect). */
    async close() {
      clearInterval(beat);
      for (const p of rooms.values()) {
        const room = await p.catch(() => null);
        if (!room) continue;
        if (room.saveTimer) clearTimeout(room.saveTimer);
        if (room.closeTimer) clearTimeout(room.closeTimer);
        await room.queue.catch(() => undefined);
        await snapshot(room).catch((e) => console.error("[live] snapshot", e));
        for (const c of room.clients) c.ws.close(1012, "The server is restarting");
      }
      rooms.clear();
      wss.close();
    },
  };
}

function cleanPresence(p: unknown): Presence {
  const o = (p ?? {}) as Record<string, unknown>;
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
  const cur = o.cursor as Record<string, unknown> | null | undefined;
  const vp = o.viewport as Record<string, unknown> | undefined;
  return {
    ...(typeof o.page === "string" ? { page: o.page.slice(0, 64) } : {}),
    ...(cur === null ? { cursor: null } : cur && n(cur.x) !== undefined && n(cur.y) !== undefined ? { cursor: { x: n(cur.x)!, y: n(cur.y)! } } : {}),
    ...(Array.isArray(o.selection) ? { selection: o.selection.filter((s): s is string => typeof s === "string").slice(0, 500) } : {}),
    ...(vp && n(vp.zoom) ? { viewport: { x: n(vp.x) ?? 0, y: n(vp.y) ?? 0, zoom: n(vp.zoom)!, ...(n(vp.w) ? { w: n(vp.w) } : {}), ...(n(vp.h) ? { h: n(vp.h) } : {}) } } : {}),
    ...(typeof o.tool === "string" ? { tool: o.tool.slice(0, 32) } : {}),
  };
}
