/**
 * Team boards over HTTP: a team's boards, making one (empty, or a board brought from the Mac),
 * reading one whole, the changes since a revision (to catch up), renaming and deleting, and the
 * pictures they use. Live editing is in live.ts; both check the person is in the board's team.
 */
import { createHash } from "node:crypto";
import { Hono, type Context } from "hono";
import type pg from "pg";
import { z } from "zod";
import type { Auth } from "./auth.js";
import { roleIn } from "./db.js";
import { emptyBoard, newId, type Board } from "./shared/core.js";

/** Largest board accepted whole (a board brought from the Mac with everything in it). */
export const BOARD_LIMIT = 20 * 1024 * 1024;
export const ASSET_LIMIT = 25 * 1024 * 1024;
const ASSET_TYPES = /^(image\/(png|jpeg|webp|gif|svg\+xml|avif)|video\/(mp4|webm|quicktime)|font\/(woff2?|ttf|otf)|application\/(octet-stream|json))$/;

export interface Session {
  user: { id: string; email: string; name: string; image?: string | null };
}

/** Who's asking: their session from a cookie (pages) or a Bearer token (the Mac). */
export async function sessionOf(auth: Auth, headers: Headers): Promise<Session | null> {
  const s = await auth.api.getSession({ headers });
  return s ? { user: { id: s.user.id, email: s.user.email, name: s.user.name, image: s.user.image } } : null;
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface BoardRow {
  id: string;
  team_id: string;
  name: string;
  rev: number;
  doc: Board;
  updated_at: Date;
}

export async function loadBoard(pool: pg.Pool, id: string): Promise<BoardRow | null> {
  const r = await pool.query(`select id, team_id, name, rev, doc, updated_at from boards where id = $1`, [id]);
  return r.rows[0] ?? null;
}

/** The board, if this person may open it (they're in its team), with their role. */
export async function boardFor(pool: pg.Pool, userId: string, id: string): Promise<{ board: BoardRow; role: string }> {
  const board = await loadBoard(pool, id);
  if (!board) throw new HttpError(404, "There's no such board.");
  const role = await roleIn(pool, userId, board.team_id);
  if (!role) throw new HttpError(404, "There's no such board.");
  return { board, role };
}

const NewBoard = z.object({ name: z.string().trim().min(1).max(200), board: z.record(z.string(), z.unknown()).optional() });

export function boardRoutes(auth: Auth, pool: pg.Pool) {
  const app = new Hono<{ Variables: { session: Session } }>();

  app.use("*", async (c, next) => {
    const s = await sessionOf(auth, c.req.raw.headers);
    if (!s) return c.json({ error: "Sign in first." }, 401);
    c.set("session", s);
    await next();
  });
  app.onError((e, c) => (e instanceof HttpError ? c.json({ error: e.message }, e.status as 400) : (console.error(e), c.json({ error: "Something went wrong on the server." }, 500))));

  const me = (c: Context<{ Variables: { session: Session } }>) => c.get("session").user;
  const member = async (userId: string, teamId: string) => {
    const role = await roleIn(pool, userId, teamId);
    if (!role) throw new HttpError(404, "There's no such team.");
    return role;
  };

  // Who's signed in, and their teams.
  app.get("/me", async (c) => {
    const u = me(c);
    const teams = await pool.query(`select o.id, o.name, o.slug, m.role from member m join organization o on o.id = m."organizationId" where m."userId" = $1 order by o.name`, [u.id]);
    return c.json({ user: u, teams: teams.rows });
  });

  app.get("/teams/:team/boards", async (c) => {
    await member(me(c).id, c.req.param("team"));
    const r = await pool.query(`select id, name, rev, updated_at as "updatedAt" from boards where team_id = $1 order by updated_at desc`, [c.req.param("team")]);
    return c.json({ boards: r.rows });
  });

  // A new team board: empty, or one brought from the Mac (its layers, pages and tokens as they are).
  app.post("/teams/:team/boards", async (c) => {
    const team = c.req.param("team");
    await member(me(c).id, team);
    const raw = await c.req.text();
    if (raw.length > BOARD_LIMIT) throw new HttpError(413, "That board is too big to bring in whole.");
    const body = NewBoard.safeParse(JSON.parse(raw || "{}"));
    if (!body.success) throw new HttpError(400, "A board needs a name.");
    const id = newId(12);
    const now = new Date().toISOString();
    const base = emptyBoard(id, body.data.name, now);
    const given = body.data.board as Partial<Board> | undefined;
    const doc: Board = given ? { ...base, pages: given.pages ?? base.pages, nodes: given.nodes ?? {}, tokens: given.tokens ?? [], fonts: given.fonts ?? [], shaders: given.shaders ?? [], id, name: body.data.name, rev: 0 } : base;
    if (given && (!Array.isArray(doc.pages) || typeof doc.nodes !== "object")) throw new HttpError(400, "That isn't a board.");
    await pool.query(`insert into boards (id, team_id, name, rev, doc, created_by) values ($1, $2, $3, 0, $4, $5)`, [id, team, body.data.name, JSON.stringify(doc), me(c).id]);
    return c.json({ id, name: body.data.name, rev: 0 }, 201);
  });

  app.get("/boards/:id", async (c) => {
    const { board, role } = await boardFor(pool, me(c).id, c.req.param("id"));
    return c.json({ id: board.id, teamId: board.team_id, name: board.name, rev: board.rev, role, doc: board.doc });
  });

  // The changes after a revision, to catch up (or 410 when too far behind: open the board whole).
  app.get("/boards/:id/changes", async (c) => {
    const { board } = await boardFor(pool, me(c).id, c.req.param("id"));
    const since = Number(c.req.query("since") ?? NaN);
    if (!Number.isInteger(since) || since < 0 || since > board.rev) throw new HttpError(400, "since must be a revision of this board.");
    const r = await pool.query(`select rev, ops, by_user as "by", by_agent as agent from board_changes where board_id = $1 and rev > $2 order by rev`, [board.id, since]);
    if (r.rows.length && r.rows[0].rev !== since + 1) return c.json({ error: "Too far behind: open the board whole." }, 410);
    return c.json({ rev: board.rev, changes: r.rows });
  });

  app.patch("/boards/:id", async (c) => {
    const { board } = await boardFor(pool, me(c).id, c.req.param("id"));
    const name = z.object({ name: z.string().trim().min(1).max(200) }).safeParse(await c.req.json().catch(() => ({})));
    if (!name.success) throw new HttpError(400, "A board needs a name.");
    await pool.query(`update boards set name = $2, updated_at = now() where id = $1`, [board.id, name.data.name]);
    return c.json({ id: board.id, name: name.data.name });
  });

  // Deleting a team board: its team's owners and admins, or whoever made it.
  app.delete("/boards/:id", async (c) => {
    const { board, role } = await boardFor(pool, me(c).id, c.req.param("id"));
    const made = await pool.query(`select created_by from boards where id = $1`, [board.id]);
    if (role !== "owner" && role !== "admin" && made.rows[0]?.created_by !== me(c).id) throw new HttpError(403, "Only the team's owners and admins, or whoever made it, can delete a board.");
    await pool.query(`delete from boards where id = $1`, [board.id]);
    return c.json({ deleted: board.id });
  });

  // Pictures: kept once per team by their contents, read by anyone in the team.
  app.post("/teams/:team/assets", async (c) => {
    const team = c.req.param("team");
    await member(me(c).id, team);
    const mime = (c.req.header("content-type") ?? "").split(";")[0].trim().toLowerCase();
    if (!ASSET_TYPES.test(mime)) throw new HttpError(415, "That kind of file can't be kept on a board.");
    const bytes = Buffer.from(await c.req.arrayBuffer());
    if (!bytes.length) throw new HttpError(400, "That file is empty.");
    if (bytes.length > ASSET_LIMIT) throw new HttpError(413, "That file is larger than 25 MB.");
    const hash = createHash("sha1").update(bytes).digest("hex");
    await pool.query(`insert into assets (team_id, hash, mime, size, bytes) values ($1, $2, $3, $4, $5) on conflict do nothing`, [team, hash, mime, bytes.length, bytes]);
    return c.json({ hash, url: `/api/assets/${team}/${hash}`, size: bytes.length }, 201);
  });

  app.get("/assets/:team/:hash", async (c) => {
    const team = c.req.param("team");
    await member(me(c).id, team);
    const r = await pool.query(`select mime, bytes from assets where team_id = $1 and hash = $2`, [team, c.req.param("hash")]);
    if (!r.rows[0]) throw new HttpError(404, "There's no such file.");
    return new Response(r.rows[0].bytes, { headers: { "Content-Type": r.rows[0].mime, "Cache-Control": "private, max-age=31536000, immutable" } });
  });

  return app;
}
