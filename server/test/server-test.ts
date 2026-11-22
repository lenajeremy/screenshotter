// The server end to end, against a Postgres of its own (Homebrew's initdb in a temporary folder):
// signing in with an emailed code, the Mac's sign-in by approving its code, a team, an invitation
// and joining it, team boards and who can see them, two people editing one board live (and a
// change that can't apply), catching up after a reconnect, a restart that keeps everything, and a
// browser's ticket in.
//
//   npm test                      (DATABASE_URL=… uses that database instead: it must be empty)
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";

process.env.QUIET_MAIL = "1";
const { startServer } = await import("../src/app.js");
const { readConfig } = await import("../src/config.js");
const { outbox } = await import("../src/mail.js");
const { MAC_CLIENT_ID } = await import("../src/auth.js");

let failed = 0;
const check = (ok: unknown, what: string) => {
  console.log(`${ok ? "PASS" : "FAIL"} ${what}`);
  if (!ok) failed++;
};
const freePort = () =>
  new Promise<number>((ok) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => ok(p));
    });
  });

// A Postgres of its own.
let dbUrl = process.env.DATABASE_URL ?? "";
let stopDb = () => undefined as void;
if (!dbUrl) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "glassine-pg-"));
  const port = await freePort();
  execFileSync("initdb", ["-D", path.join(dir, "data"), "-U", "test", "--auth=trust", "-E", "UTF8"], { stdio: "ignore" });
  const pg = spawn("postgres", ["-D", path.join(dir, "data"), "-p", String(port), "-k", dir, "-c", "listen_addresses=127.0.0.1"], { stdio: "ignore" });
  for (let i = 0; i < 100; i++) {
    try {
      execFileSync("pg_isready", ["-h", "127.0.0.1", "-p", String(port)], { stdio: "ignore" });
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  execFileSync("createdb", ["-h", "127.0.0.1", "-p", String(port), "-U", "test", "glassine"]);
  dbUrl = `postgres://test@127.0.0.1:${port}/glassine`;
  stopDb = () => {
    pg.kill("SIGINT");
    setTimeout(() => rmSync(dir, { recursive: true, force: true }), 500);
  };
}

const port = await freePort();
const env = { DATABASE_URL: dbUrl, PORT: String(port), BASE_URL: `http://localhost:${port}` };
let server = await startServer(readConfig(env));
const base = `http://localhost:${port}`;

async function call(p: string, o: { method?: string; body?: unknown; token?: string; raw?: BodyInit; type?: string } = {}) {
  const r = await fetch(base + p, {
    method: o.method ?? (o.body !== undefined || o.raw !== undefined ? "POST" : "GET"),
    headers: { ...(o.body !== undefined ? { "Content-Type": "application/json" } : {}), ...(o.type ? { "Content-Type": o.type } : {}), ...(o.token ? { Authorization: `Bearer ${o.token}` } : {}), Origin: base },
    body: o.raw ?? (o.body !== undefined ? JSON.stringify(o.body) : undefined),
  });
  const text = await r.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: r.status, json, headers: r.headers };
}

/** Sign in with an emailed code: the token the app would keep. */
async function signIn(email: string): Promise<string> {
  const sent = await call("/api/auth/email-otp/send-verification-otp", { body: { email, type: "sign-in" } });
  const mail = outbox.filter((m) => m.to === email).at(-1);
  const otp = mail?.text.match(/\b(\d{3}) (\d{3})\b/)?.slice(1).join("") ?? "";
  const r = await call("/api/auth/sign-in/email-otp", { body: { email, otp } });
  const token = r.headers.get("set-auth-token") ?? "";
  if (sent.status !== 200 || r.status !== 200 || !token) throw new Error(`Couldn't sign ${email} in: ${sent.status} ${r.status} ${JSON.stringify(r.json)}`);
  return token;
}

check((await call("/health")).json?.ok, "the server answers");

// Signing in.
const wrong = await call("/api/auth/sign-in/email-otp", { body: { email: "nobody@example.com", otp: "000000" } });
check(wrong.status >= 400, "a wrong code doesn't sign in");
const alice = await signIn("alice@example.com");
const mail = outbox.find((m) => m.to === "alice@example.com");
check(/^\d{3} \d{3} is your .+ code$/.test(mail?.subject ?? ""), `the code is emailed, in its subject too (${mail?.subject})`);
const meA = await call("/api/me", { token: alice });
check(meA.status === 200 && meA.json.user.email === "alice@example.com" && meA.json.teams.length === 0, "signed in with the code: the app's token says who it is, and they have no teams yet");
check((await call("/api/me")).status === 401, "without a token, nothing");

// The Mac's sign-in: a code shown in the app, approved in the browser.
const dev = await call("/api/auth/device/code", { body: { client_id: MAC_CLIENT_ID } });
check(dev.status === 200 && dev.json.user_code && String(dev.json.verification_uri_complete).startsWith(`${base}/device`), `the Mac asks for a code and gets the page to approve it on (${dev.json.verification_uri_complete})`);
const poll = () => call("/api/auth/device/token", { body: { grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: dev.json.device_code, client_id: MAC_CLIENT_ID } });
check((await poll()).json.error === "authorization_pending", "until it's approved, the Mac waits");
const page = await fetch(`${base}/device?user_code=${dev.json.user_code}`, { redirect: "manual" });
check(page.status === 302 && page.headers.get("location")?.startsWith("/signin?next="), "the approval page asks a signed-out browser to sign in first");
// As the page does: the signed-in browser claims the code, then approves it.
const claim = await call(`/api/auth/device?user_code=${dev.json.user_code}`, { token: alice });
const approve = await call("/api/auth/device/approve", { body: { userCode: dev.json.user_code }, token: alice });
check(claim.status === 200 && approve.status === 200, `the signed-in browser claims the code and approves it (${approve.status} ${JSON.stringify(approve.json)})`);
// It asks again no sooner than it was told to (every 2 seconds).
await new Promise((r) => setTimeout(r, 2100));
const got = await poll();
if (!got.json.access_token) console.log("token answer:", got.status, JSON.stringify(got.json));
const macToken = got.json.access_token;
check(Boolean(macToken) && (await call("/api/me", { token: macToken })).json?.user?.email === "alice@example.com", "approved, the Mac gets a token of its own");
check((await call("/api/auth/device/code", { body: { client_id: "something-else" } })).status >= 400, "only the app can ask for a code");

// A team, an invitation, and joining it.
const team = await call("/api/auth/organization/create", { body: { name: "Studio", slug: "studio" }, token: alice });
check(team.status === 200 && team.json.id, "Alice starts a team");
const teamId = team.json.id;
const invite = await call("/api/auth/organization/invite-member", { body: { email: "bob@example.com", role: "member", organizationId: teamId }, token: alice });
const inviteMail = outbox.filter((m) => m.to === "bob@example.com").at(-1);
check(invite.status === 200 && inviteMail && /invited you to Studio/.test(inviteMail.subject) && inviteMail.text.includes(`${base}/invite/`), "she invites Bob: he gets an email with a link to join");
const bob = await signIn("bob@example.com");
const accept = await call("/api/auth/organization/accept-invitation", { body: { invitationId: invite.json.id }, token: bob });
const meB = await call("/api/me", { token: bob });
check(accept.status === 200 && meB.json.teams.some((t: any) => t.id === teamId && t.role === "member"), "Bob joins: the team is his too, as a member");
const carol = await signIn("carol@example.com");

// Team boards.
const made = await call(`/api/teams/${teamId}/boards`, { body: { name: "Landing page" }, token: alice });
const boardId = made.json.id;
check(made.status === 201 && boardId, "Alice makes a team board");
const list = await call(`/api/teams/${teamId}/boards`, { token: bob });
check(list.json.boards?.some((b: any) => b.id === boardId), "Bob sees it in the team's boards");
check((await call(`/api/boards/${boardId}`, { token: carol })).status === 404 && (await call(`/api/teams/${teamId}/boards`, { token: carol })).status === 404, "Carol, not in the team, can't see the board or the team");
const local = { pages: [{ id: "p1", name: "Page 1", children: ["a1"] }], nodes: { a1: { id: "a1", type: "frame", name: "Hero", parent: null, children: [], style: { width: "1440px", height: "900px" } } }, tokens: [{ name: "--brand", value: "#ff5500" }] };
const brought = await call(`/api/teams/${teamId}/boards`, { body: { name: "From my Mac", board: local }, token: alice });
const broughtDoc = (await call(`/api/boards/${brought.json.id}`, { token: bob })).json.doc;
check(brought.status === 201 && broughtDoc?.nodes?.a1?.name === "Hero" && broughtDoc.tokens[0].value === "#ff5500", "a board from the Mac comes into the team as it was (layers, pages, tokens)");

// Pictures.
const png = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0f01f0005000201a2d9b2a30000000049454e44ae426082", "hex");
const up = await call(`/api/teams/${teamId}/assets`, { raw: png, type: "image/png", token: alice });
const down = await fetch(base + up.json.url, { headers: { Authorization: `Bearer ${bob}` } });
check(up.status === 201 && down.status === 200 && Buffer.from(await down.arrayBuffer()).equals(png), "a picture kept for the team comes back the same, for anyone in it");
check((await fetch(base + up.json.url, { headers: { Authorization: `Bearer ${carol}` } })).status === 404, "and not for anyone else");

// Live.
type Msg = Record<string, any>;
function connect(token: string, q: string) {
  const ws = new WebSocket(`ws://localhost:${port}/live?${q}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  const inbox: Msg[] = [];
  const waiters: Array<{ test: (m: Msg) => boolean; ok: (m: Msg) => void }> = [];
  ws.on("message", (d) => {
    const m = JSON.parse(String(d));
    inbox.push(m);
    for (const w of waiters.splice(0)) (w.test(m) ? w.ok(m) : waiters.push(w));
  });
  const next = (test: (m: Msg) => boolean, ms = 4000) =>
    new Promise<Msg>((ok, no) => {
      const had = inbox.find(test);
      if (had) return ok(had);
      waiters.push({ test, ok });
      setTimeout(() => no(new Error("timed out waiting")), ms);
    });
  const opened = new Promise<void>((ok, no) => (ws.once("open", () => ok()), ws.once("unexpected-response", (_q, r) => no(new Error(String(r.statusCode)))), ws.once("error", no)));
  return { ws, inbox, next, opened, send: (m: Msg) => ws.send(JSON.stringify(m)) };
}

const a = connect(alice, `board=${boardId}`);
await a.opened;
const wa = await a.next((m) => m.t === "welcome");
const pageId = wa.doc.pages[0].id;
check(wa.rev === 0 && wa.doc?.name === "Landing page" && wa.peers.length === 0, "Alice opens the board live: it comes whole, at revision 0");
const b = connect(bob, `board=${boardId}`);
await b.opened;
const wb = await b.next((m) => m.t === "welcome");
check(wb.peers.some((p: Msg) => p.user.email === "alice@example.com") && (await a.next((m) => m.t === "joined")).peer.user.email === "bob@example.com", "Bob joins: each sees the other");

a.send({ t: "ops", id: "a-1", ops: [{ op: "add", nodes: { f1: { id: "f1", type: "frame", name: "Card", parent: null, children: [], style: { width: "300px", height: "200px" } } }, ids: ["f1"], parent: null, page: pageId }] });
const ack1 = await a.next((m) => m.t === "ack" && m.id === "a-1");
const got1 = await b.next((m) => m.t === "ops" && m.rev === 1);
check(ack1.rev === 1 && got1.ops[0].op === "add" && got1.by === wa.you.id, "Alice adds a frame: it's confirmed to her as revision 1 and reaches Bob, from her");
b.send({ t: "ops", id: "b-1", ops: [{ op: "set", id: "f1", style: { backgroundColor: "#ff5500" } }], agent: "Claude" });
const got2 = await a.next((m) => m.t === "ops" && m.rev === 2);
check(got2.ops[0].style.backgroundColor === "#ff5500" && got2.agent === "Claude", "Bob's agent colours it: Alice sees the change, and that an agent made it");
a.send({ t: "presence", p: { cursor: { x: 120, y: 40 }, selection: ["f1"], page: pageId, junk: "x" } });
const pres = await b.next((m) => m.t === "presence");
check(pres.peer === wa.you.id && pres.p.cursor.x === 120 && pres.p.selection[0] === "f1" && !("junk" in pres.p), "Alice's cursor and selection reach Bob (and nothing else she sent)");
b.send({ t: "ops", id: "b-2", ops: [{ op: "set", id: "gone", style: { opacity: "0.5" } }] });
const rej = await b.next((m) => m.t === "reject" && m.id === "b-2");
check(rej.rev === 2 && /gone/.test(rej.reason), `a change to a layer that isn't there is refused, to Bob alone (${rej.reason})`);
await new Promise((r) => setTimeout(r, 200));
check(!a.inbox.some((m) => m.t === "ops" && m.rev === 3), "and nobody else hears of it");

// Catching up after a reconnect.
b.ws.close();
await a.next((m) => m.t === "left");
a.send({ t: "ops", id: "a-2", ops: [{ op: "set", id: "f1", name: "Pricing card" }] });
await a.next((m) => m.t === "ack" && m.id === "a-2");
const b2 = connect(bob, `board=${boardId}&since=2`);
await b2.opened;
const wb2 = await b2.next((m) => m.t === "welcome");
check(!wb2.doc && wb2.changes?.length === 1 && wb2.changes[0].rev === 3 && wb2.changes[0].ops[0].name === "Pricing card", "Bob reconnects from revision 2: he gets only what he missed");

// Who may connect.
const c = connect(carol, `board=${boardId}`);
check(await c.opened.then(() => false, (e) => e.message === "404"), "Carol can't open the board live");
const anon = connect("", `board=${boardId}`);
check(await anon.opened.then(() => false, (e) => e.message === "401"), "nobody signed out can");
const ticket = await call("/api/live/ticket", { body: { board: boardId }, token: bob });
const t1 = connect("", `board=${boardId}&ticket=${ticket.json.ticket}`);
await t1.opened;
check((await t1.next((m) => m.t === "welcome")).rev === 3, "a browser gets in with a ticket");
const t2 = connect("", `board=${boardId}&ticket=${ticket.json.ticket}`);
check(await t2.opened.then(() => false, (e) => e.message === "401"), "once");
for (const x of [a, b2, t1]) x.ws.close();

// A restart keeps everything.
await server.close();
server = await startServer(readConfig(env));
const after = await call(`/api/boards/${boardId}`, { token: bob });
check(after.json.rev === 3 && after.json.doc.nodes.f1?.name === "Pricing card" && after.json.doc.nodes.f1.style.backgroundColor === "#ff5500", "after a restart the board is as it was: revision 3, every change in it");
const hist = await call(`/api/boards/${boardId}/changes?since=0`, { token: alice });
check(hist.json.changes?.length === 3 && hist.json.changes[1].agent === "Claude", "and every change is kept, in order, with who (and which agent) made it");
check((await call(`/api/boards/${boardId}`, { method: "DELETE", token: bob })).status === 403 && (await call(`/api/boards/${boardId}`, { method: "DELETE", token: alice })).status === 200, "a member who didn't make it can't delete a board; its owner can");

await server.close();
stopDb();
if (failed) {
  console.log(`${failed} failed`);
  process.exit(1);
}
console.log("All passed");
process.exit(0);
