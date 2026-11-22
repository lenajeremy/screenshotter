/**
 * Postgres: Better Auth's tables (people, sessions, teams, members, invitations, Macs signing in)
 * and the server's own: team boards (a snapshot of each and its revision), every change made to
 * them (in order, so a board can be rebuilt and a client can catch up), and their pictures.
 */
import { getMigrations } from "better-auth/db/migration";
import pg from "pg";
import type { Auth } from "./auth.js";

export function makePool(url: string): pg.Pool {
  const pool = new pg.Pool({ connectionString: url, max: 10 });
  pool.on("error", (err) => console.error("[db] idle client error:", err.message));
  return pool;
}

const OWN = `
create table if not exists boards (
  id text primary key,
  team_id text not null references organization(id) on delete cascade,
  name text not null,
  rev integer not null default 0,
  doc jsonb not null,
  created_by text references "user"(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists boards_team on boards (team_id, updated_at desc);

-- Every accepted change, by revision: the snapshot is the board at boards.rev; changes after it
-- (from a moment before the snapshot was written) are applied when the board is opened.
create table if not exists board_changes (
  board_id text not null references boards(id) on delete cascade,
  rev integer not null,
  ops jsonb not null,
  by_user text references "user"(id) on delete set null,
  by_agent text,
  at timestamptz not null default now(),
  primary key (board_id, rev)
);

-- Pictures (and other files) team boards use, by the SHA-1 of their bytes, per team.
create table if not exists assets (
  team_id text not null references organization(id) on delete cascade,
  hash text not null,
  mime text not null,
  size integer not null,
  bytes bytea not null,
  created_at timestamptz not null default now(),
  primary key (team_id, hash)
);
`;

/** Bring the database up to date: Better Auth's tables, then the server's own. */
export async function migrate(auth: Auth, pool: pg.Pool) {
  const { runMigrations } = await getMigrations(auth.options);
  await runMigrations();
  await pool.query(OWN);
}

/** A person's place in a team: their role, or null when they aren't in it. */
export async function roleIn(pool: pg.Pool, userId: string, teamId: string): Promise<string | null> {
  const r = await pool.query(`select role from member where "organizationId" = $1 and "userId" = $2 limit 1`, [teamId, userId]);
  return r.rows[0]?.role ?? null;
}
