/**
 * Live team board sync: keeps one WebSocket per open team board against the collaboration server,
 * streams remote edits and teammates' cursors to the Studio UI over SSE, forwards Studio and MCP
 * (agent) edits up to the server, and catches up seamlessly after disconnects.
 */
import type http from "node:http";
import { newId, type Board, type Op } from "../board/core.js";
import { applyRemoteOpsToDisk, drainSyncOutbox, getSyncMeta, setSyncMeta, writeSyncedBoard } from "../board/store.js";
import { scheduleBoardThumb } from "../board/thumbs.js";
import { authToken, cloudFetch, fetchTeamBoard, rewriteOpsAssets, serverUrl } from "./client.js";

export interface LivePeer {
  id: string;
  user: { id: string; name: string; email: string; image?: string | null };
  color: string;
  agent?: string;
}

export interface PeerPresence {
  page?: string;
  cursor?: { x: number; y: number } | null;
  selection?: string[];
  viewport?: { x: number; y: number; zoom: number; w?: number; h?: number };
  tool?: string;
}

type ConnectionStatus = "connecting" | "connected" | "reconnecting" | "offline";

interface OutboundBatch {
  id: string;
  ops: Op[];
  agent?: string;
  sent?: boolean;
}

interface LiveRoom {
  boardId: string;
  teamId: string;
  teamName?: string;
  role?: string;
  baseUrl: string;
  syncedRev: number;
  status: ConnectionStatus;
  you: LivePeer | null;
  peers: Map<string, { peer: LivePeer; presence?: PeerPresence }>;
  ws: WebSocket | null;
  subscribers: Set<http.ServerResponse>;
  outbound: OutboundBatch[];
  lastPresence?: PeerPresence;
  reconnectTimer?: NodeJS.Timeout;
  idleTimer?: NodeJS.Timeout;
  outboxTimer?: NodeJS.Timeout;
  pingTimer?: NodeJS.Timeout;
  reconnectAttempt: number;
  closed: boolean;
  drainingOutbox: boolean;
}

const rooms = new Map<string, LiveRoom>();

function emit(room: LiveRoom, event: Record<string, unknown>) {
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of [...room.subscribers]) {
    try {
      res.write(payload);
    } catch {
      room.subscribers.delete(res);
    }
  }
}

export function roomState(room: LiveRoom) {
  return {
    boardId: room.boardId,
    teamId: room.teamId,
    teamName: room.teamName,
    role: room.role,
    status: room.status,
    rev: room.syncedRev,
    you: room.you,
    peers: [...room.peers.values()].map((p) => ({ ...p.peer, presence: p.presence })),
  };
}

/** Open a team board: fetch latest snapshot from the server, cache locally, and connect live. */
export async function openTeamBoard(boardId: string, teamName?: string): Promise<{ board: Board; live: ReturnType<typeof roomState> }> {
  const fetched = await fetchTeamBoard(boardId);
  const existing = getSyncMeta(boardId);
  const name = teamName || existing?.teamName;
  const base = serverUrl();
  const board: Board = { ...fetched.doc, id: fetched.id, name: fetched.name, rev: fetched.rev };
  setSyncMeta({ boardId: fetched.id, teamId: fetched.teamId, teamName: name, serverUrl: base, syncedRev: fetched.rev });
  writeSyncedBoard(board);
  scheduleBoardThumb(fetched.id, 300);

  const room = ensureRoom(fetched.id, fetched.teamId, name, fetched.role, fetched.rev);
  return { board, live: roomState(room) };
}

/** Ensure a live WebSocket room exists for a synced board (e.g. reopened on launch). */
export function ensureSyncedRoom(boardId: string): LiveRoom | null {
  const existing = rooms.get(boardId);
  if (existing && !existing.closed) return existing;
  const meta = getSyncMeta(boardId);
  if (!meta || !authToken()) return null;
  return ensureRoom(meta.boardId, meta.teamId, meta.teamName, undefined, meta.syncedRev);
}

function ensureRoom(boardId: string, teamId: string, teamName: string | undefined, role: string | undefined, syncedRev: number): LiveRoom {
  const had = rooms.get(boardId);
  if (had && !had.closed) {
    if (teamName) had.teamName = teamName;
    if (role) had.role = role;
    if (had.idleTimer) {
      clearTimeout(had.idleTimer);
      had.idleTimer = undefined;
    }
    return had;
  }
  const room: LiveRoom = {
    boardId,
    teamId,
    teamName,
    role,
    baseUrl: serverUrl(),
    syncedRev,
    status: "connecting",
    you: null,
    peers: new Map(),
    ws: null,
    subscribers: new Set(),
    outbound: [],
    reconnectAttempt: 0,
    closed: false,
    drainingOutbox: false,
  };
  rooms.set(boardId, room);
  room.outboxTimer = setInterval(() => void drainOutbox(room), 160);
  room.outboxTimer.unref?.();
  room.pingTimer = setInterval(() => {
    for (const res of [...room.subscribers]) {
      try {
        res.write(": keepalive\n\n");
      } catch {
        room.subscribers.delete(res);
      }
    }
    if (room.ws && room.ws.readyState === WebSocket.OPEN) {
      try {
        room.ws.send(JSON.stringify({ t: "ping" }));
      } catch {}
    }
  }, 20_000);
  room.pingTimer.unref?.();
  void connectRoom(room);
  return room;
}

async function connectRoom(room: LiveRoom) {
  if (room.closed) return;
  const tok = authToken();
  if (!tok) {
    room.status = "offline";
    emit(room, { t: "status", status: room.status });
    return;
  }
  room.status = room.reconnectAttempt > 0 ? "reconnecting" : "connecting";
  emit(room, { t: "status", status: room.status });

  try {
    const { ticket } = await cloudFetch<{ ticket: string }>("/api/live/ticket", {
      method: "POST",
      body: { board: room.boardId },
      token: tok,
      base: room.baseUrl,
    });
    if (room.closed) return;
    const wsBase = room.baseUrl.replace(/^http/i, "ws");
    const wsUrl = `${wsBase}/live?board=${encodeURIComponent(room.boardId)}&since=${room.syncedRev}&ticket=${encodeURIComponent(ticket)}`;
    const ws = new WebSocket(wsUrl);
    room.ws = ws;

    ws.addEventListener("open", () => {
      if (room.ws !== ws || room.closed) return;
      room.reconnectAttempt = 0;
    });

    ws.addEventListener("message", (ev) => {
      if (room.ws !== ws || room.closed) return;
      let msg: any;
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      void handleServerMessage(room, msg);
    });

    ws.addEventListener("close", () => {
      if (room.ws !== ws) return;
      room.ws = null;
      // Mark any unacknowledged sent batches as unsent so they resend cleanly after reconnect.
      for (const b of room.outbound) b.sent = false;
      if (!room.closed) scheduleReconnect(room);
    });

    ws.addEventListener("error", () => {
      // Close event handles reconnect.
    });
  } catch {
    if (!room.closed) scheduleReconnect(room);
  }
}

function scheduleReconnect(room: LiveRoom) {
  if (room.closed || room.reconnectTimer) return;
  room.status = "reconnecting";
  emit(room, { t: "status", status: room.status });
  const delay = Math.min(15_000, 1000 * 2 ** Math.min(room.reconnectAttempt, 4));
  room.reconnectAttempt += 1;
  room.reconnectTimer = setTimeout(() => {
    room.reconnectTimer = undefined;
    void connectRoom(room);
  }, delay);
  room.reconnectTimer.unref?.();
}

async function handleServerMessage(room: LiveRoom, msg: any) {
  switch (msg.t) {
    case "welcome": {
      room.status = "connected";
      room.you = msg.you ?? null;
      room.peers.clear();
      for (const p of msg.peers ?? []) room.peers.set(p.id, { peer: p });
      if (msg.doc) {
        const doc: Board = { ...msg.doc, id: room.boardId, rev: msg.rev };
        room.syncedRev = msg.rev;
        setSyncMeta({ boardId: room.boardId, teamId: room.teamId, teamName: room.teamName, serverUrl: room.baseUrl, syncedRev: msg.rev });
        writeSyncedBoard(doc);
        emit(room, { t: "welcome", ...roomState(room), board: doc });
      } else if (Array.isArray(msg.changes) && msg.changes.length) {
        let board: Board | null = null;
        try {
          for (const ch of msg.changes) {
            board = applyRemoteOpsToDisk(room.boardId, ch.ops, ch.rev);
            room.syncedRev = ch.rev;
          }
          setSyncMeta({ boardId: room.boardId, teamId: room.teamId, teamName: room.teamName, serverUrl: room.baseUrl, syncedRev: room.syncedRev });
          emit(room, { t: "welcome", ...roomState(room), ...(board ? { board } : {}) });
        } catch {
          await resyncFromServer(room);
        }
      } else {
        room.syncedRev = msg.rev ?? room.syncedRev;
        setSyncMeta({ boardId: room.boardId, teamId: room.teamId, teamName: room.teamName, serverUrl: room.baseUrl, syncedRev: room.syncedRev });
        emit(room, { t: "welcome", ...roomState(room) });
      }
      if (room.lastPresence) sendLivePresence(room.boardId, room.lastPresence);
      flushOutbound(room);
      break;
    }
    case "ops": {
      try {
        const board = applyRemoteOpsToDisk(room.boardId, msg.ops, msg.rev);
        room.syncedRev = msg.rev;
        setSyncMeta({ boardId: room.boardId, teamId: room.teamId, teamName: room.teamName, serverUrl: room.baseUrl, syncedRev: msg.rev });
        scheduleBoardThumb(room.boardId, 1200);
        emit(room, { t: "ops", rev: msg.rev, ops: msg.ops, by: msg.by, agent: msg.agent, updatedAt: board.updatedAt });
      } catch {
        await resyncFromServer(room);
      }
      break;
    }
    case "ack": {
      const idx = room.outbound.findIndex((b) => b.id === msg.id);
      if (idx >= 0) room.outbound.splice(idx, 1);
      if (typeof msg.rev === "number" && msg.rev > room.syncedRev) {
        room.syncedRev = msg.rev;
        setSyncMeta({ boardId: room.boardId, teamId: room.teamId, teamName: room.teamName, serverUrl: room.baseUrl, syncedRev: msg.rev });
      }
      emit(room, { t: "ack", id: msg.id, rev: msg.rev });
      flushOutbound(room);
      break;
    }
    case "reject": {
      const idx = room.outbound.findIndex((b) => b.id === msg.id);
      if (idx >= 0) room.outbound.splice(idx, 1);
      await resyncFromServer(room, msg.reason || "A change conflicted with a teammate's edit.");
      break;
    }
    case "joined": {
      if (msg.peer) {
        room.peers.set(msg.peer.id, { peer: msg.peer });
        emit(room, { t: "joined", peer: msg.peer });
      }
      break;
    }
    case "left": {
      if (msg.peer) {
        room.peers.delete(msg.peer);
        emit(room, { t: "left", peer: msg.peer });
      }
      break;
    }
    case "presence": {
      if (msg.peer && msg.p) {
        const entry = room.peers.get(msg.peer);
        if (entry) entry.presence = msg.p;
        emit(room, { t: "presence", peer: msg.peer, p: msg.p });
      }
      break;
    }
    case "resync": {
      await resyncFromServer(room);
      break;
    }
  }
}

async function resyncFromServer(room: LiveRoom, rejectReason?: string) {
  try {
    const fetched = await fetchTeamBoard(room.boardId);
    const board: Board = { ...fetched.doc, id: fetched.id, name: fetched.name, rev: fetched.rev };
    room.syncedRev = fetched.rev;
    setSyncMeta({ boardId: room.boardId, teamId: room.teamId, teamName: room.teamName, serverUrl: room.baseUrl, syncedRev: fetched.rev });
    writeSyncedBoard(board);
    emit(room, { t: rejectReason ? "reject" : "sync", reason: rejectReason, rev: fetched.rev, board });
  } catch {
    // Next reconnect will catch up.
  }
}

function flushOutbound(room: LiveRoom) {
  if (!room.ws || room.ws.readyState !== WebSocket.OPEN) return;
  for (const batch of room.outbound) {
    if (batch.sent) continue;
    batch.sent = true;
    try {
      room.ws.send(JSON.stringify({ t: "ops", id: batch.id, ops: batch.ops, ...(batch.agent ? { agent: batch.agent } : {}) }));
    } catch {
      batch.sent = false;
      break;
    }
  }
}

/** Push operations made in the Studio (or by an MCP agent) up to the team server. */
export async function pushTeamOps(boardId: string, ops: Op[], agent?: string): Promise<void> {
  const clean = ops.filter((o) => o.op !== "working" && o.op !== "agent");
  if (!clean.length) return;
  const room = ensureSyncedRoom(boardId);
  if (!room) return;
  const rewritten = await rewriteOpsAssets(room.teamId, clean);
  room.outbound.push({ id: newId(10), ops: rewritten, ...(agent ? { agent } : {}) });
  flushOutbound(room);
}

/** Drain operations written to disk by external MCP agents and forward them live. */
async function drainOutbox(room: LiveRoom) {
  if (room.drainingOutbox || room.closed) return;
  room.drainingOutbox = true;
  try {
    const entries = drainSyncOutbox(room.boardId);
    for (const e of entries) {
      await pushTeamOps(room.boardId, e.ops, e.agent);
    }
  } catch {
    // Retried on the next tick.
  } finally {
    room.drainingOutbox = false;
  }
}

export function sendLivePresence(boardId: string, p: PeerPresence): void {
  const room = rooms.get(boardId);
  if (!room || room.closed) return;
  room.lastPresence = p;
  if (room.ws && room.ws.readyState === WebSocket.OPEN) {
    try {
      room.ws.send(JSON.stringify({ t: "presence", p }));
    } catch {}
  }
}

/** Subscribe a Studio UI tab to live updates for a team board over SSE. */
export function subscribeLive(boardId: string, res: http.ServerResponse): boolean {
  const room = ensureSyncedRoom(boardId);
  if (!room) return false;
  if (room.idleTimer) {
    clearTimeout(room.idleTimer);
    room.idleTimer = undefined;
  }
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
  });
  room.subscribers.add(res);
  res.write(`data: ${JSON.stringify({ t: "state", ...roomState(room) })}\n\n`);
  res.on("close", () => {
    room.subscribers.delete(res);
    if (!room.subscribers.size && !room.closed) {
      room.idleTimer = setTimeout(() => {
        if (!room.subscribers.size) closeLiveRoom(boardId);
      }, 60_000);
      room.idleTimer.unref?.();
    }
  });
  return true;
}

export function closeLiveRoom(boardId: string): void {
  const room = rooms.get(boardId);
  if (!room) return;
  room.closed = true;
  rooms.delete(boardId);
  if (room.reconnectTimer) clearTimeout(room.reconnectTimer);
  if (room.idleTimer) clearTimeout(room.idleTimer);
  if (room.outboxTimer) clearInterval(room.outboxTimer);
  if (room.pingTimer) clearInterval(room.pingTimer);
  for (const res of room.subscribers) {
    try {
      res.end();
    } catch {}
  }
  room.subscribers.clear();
  try {
    room.ws?.close(1000, "closed");
  } catch {}
}

export function closeAllLiveRooms(): void {
  for (const id of [...rooms.keys()]) closeLiveRoom(id);
}
