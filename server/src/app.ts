/**
 * The server: sign-in and teams (Better Auth, under /api/auth), team boards (/api), the live
 * connections (/live), and the pages people open in a browser (/signin, /device, /invite).
 */
import type http from "node:http";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { makeAuth } from "./auth.js";
import { boardRoutes, sessionOf } from "./boards.js";
import type { Config } from "./config.js";
import { makePool, migrate } from "./db.js";
import { attachLive } from "./live.js";
import { pageRoutes } from "./pages.js";

export async function startServer(config: Config) {
  const pool = makePool(config.databaseUrl);
  const auth = makeAuth(config, pool);
  await migrate(auth, pool);

  const app = new Hono();
  const live: { now?: ReturnType<typeof attachLive> } = {};
  app.get("/health", (c) => c.json({ ok: true }));
  app.on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw));
  // A browser's way into a live board (it can't send an Authorization header with a WebSocket).
  app.post("/api/live/ticket", async (c) => {
    const s = await sessionOf(auth, c.req.raw.headers);
    if (!s) return c.json({ error: "Sign in first." }, 401);
    const { board } = await c.req.json<{ board?: string }>().catch(() => ({ board: undefined }));
    try {
      return c.json({ ticket: await live.now!.ticket(s.user, String(board ?? "")) });
    } catch {
      return c.json({ error: "There's no such board." }, 404);
    }
  });
  app.route("/api", boardRoutes(auth, pool));
  app.route("/", pageRoutes(auth, config));

  const server = serve({ fetch: app.fetch, port: config.port, hostname: "0.0.0.0" }) as http.Server;
  await new Promise<void>((ok) => (server.listening ? ok() : server.once("listening", () => ok())));
  live.now = attachLive(server, auth, pool);
  const port = (server.address() as { port: number }).port;

  return {
    app,
    auth,
    pool,
    port,
    /** Keep every open board, close every connection, and stop. */
    async close() {
      await live.now?.close();
      await new Promise<void>((ok) => server.close(() => ok()));
      server.closeAllConnections?.();
      await pool.end();
    },
  };
}
