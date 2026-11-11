/**
 * A stand-in for Agentman's daemon, for tests: it answers list_sessions and send_message on a Unix
 * socket of its own and keeps everything it's sent. Tests point SCREENSHOTTER_AGENTMAN_SOCKET at it,
 * so they never reach the person's real agents.
 */
import net from "node:net";

export interface FakeSession {
  id: string;
  kind: string;
  name: string;
  cwd: string;
  state?: string;
  inject?: string;
  /** A question the agent is waiting on: Agentman refuses messages to it until it's answered. */
  question?: unknown;
}

export async function fakeAgentman(socket: string, sessions: FakeSession[]) {
  const sent: Array<{ sessionId: string; text: string; clientId?: string }> = [];
  const requests: Array<Record<string, any>> = [];
  const badFrames: string[] = [];
  let n = 0;
  const server = net.createServer((c) => {
    c.setEncoding("utf8");
    c.on("error", () => undefined);
    // Agentman sends every app the events it has for anyone: one arrives before any answer, to
    // check a client only takes the reply to its own request.
    c.write(`${JSON.stringify({ v: 2, id: "evt-0", to: "app", payload: { type: "session_update", session: sessions[0] } })}\n`);
    let buf = "";
    c.on("data", (chunk: string) => {
      buf += chunk;
      for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        let env: any;
        try {
          env = JSON.parse(line);
        } catch {
          badFrames.push(line);
          continue;
        }
        if (env.v !== 2 || env.to !== "daemon" || typeof env.id !== "string") badFrames.push(line);
        const p = env.payload ?? {};
        requests.push(p);
        let answer: Record<string, unknown>;
        if (p.type === "list_sessions") answer = { type: "sessions", sessions };
        else if (p.type === "send_message") {
          const s = sessions.find((x) => x.id === p.sessionId);
          if (!s) answer = { type: "send_result", sessionId: p.sessionId, status: "failed", error: "daemon: unknown session" };
          else if (s.question) answer = { type: "send_result", sessionId: p.sessionId, status: "failed", error: "daemon: answer the pending question before sending a message" };
          else {
            sent.push({ sessionId: p.sessionId, text: p.text, clientId: p.clientId });
            answer = { type: "send_result", sessionId: p.sessionId, clientId: p.clientId, status: s.inject === "hook" ? "queued" : "delivered" };
          }
        } else answer = { type: "error", error: `daemon: the stand-in doesn't do ${p.type}` };
        c.write(`${JSON.stringify({ v: 2, id: "evt-1", to: "app", payload: { type: "turn_complete", sessionId: "someone-else" } })}\n`);
        c.write(`${JSON.stringify({ v: 2, id: `r${++n}`, replyTo: env.id, to: "app", payload: answer })}\n`);
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socket, resolve);
  });
  return { sessions, sent, requests, badFrames, close: () => new Promise<void>((r) => server.close(() => r())) };
}
