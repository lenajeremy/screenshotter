// End-to-end teams & live collaboration test: runs the real collaboration server (against a
// throwaway Postgres) and two separate Glassine Studio engines (Alice's Mac and Bob's Mac), plus
// two real Chromium tabs via Playwright, verifying:
//   - Mac device-code sign-in
//   - Creating a team, inviting a teammate, inspecting members/invites
//   - Moving a local board with a local PNG picture into a team (assets upload + proxy download)
//   - Live edits between Alice and Bob (and an external MCP agent writing to Alice's disk)
//   - Live cursors, selections and avatars across two real Studio browser windows
//
//   npm run test:teams
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";

process.env.QUIET_MAIL = "1";
const { startServer } = await import("../server/src/app.js");
const { readConfig } = await import("../server/src/config.js");
const { outbox } = await import("../server/src/mail.js");

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

const waitFor = async <T>(fn: () => Promise<T | false | null | undefined>, ms = 10_000, step = 100): Promise<T> => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error("Timed out waiting");
    await new Promise((r) => setTimeout(r, step));
  }
};

// 1. Throwaway Postgres for the collaboration server.
const tmpRoot = mkdtempSync(path.join(os.tmpdir(), "glassine-teams-"));
const pgDir = path.join(tmpRoot, "pg");
const pgPort = await freePort();
execFileSync("initdb", ["-D", path.join(pgDir, "data"), "-U", "test", "--auth=trust", "-E", "UTF8"], { stdio: "ignore" });
const pgProc = spawn("postgres", ["-D", path.join(pgDir, "data"), "-p", String(pgPort), "-k", pgDir, "-c", "listen_addresses=127.0.0.1"], { stdio: "ignore" });
for (let i = 0; i < 100; i++) {
  try {
    execFileSync("pg_isready", ["-h", "127.0.0.1", "-p", String(pgPort)], { stdio: "ignore" });
    break;
  } catch {
    await new Promise((r) => setTimeout(r, 100));
  }
}
execFileSync("createdb", ["-h", "127.0.0.1", "-p", String(pgPort), "-U", "test", "glassine"]);
const dbUrl = `postgres://test@127.0.0.1:${pgPort}/glassine`;

// 2. Start collaboration server.
const cloudPort = await freePort();
const cloudBase = `http://localhost:${cloudPort}`;
const cloudServer = await startServer(readConfig({ DATABASE_URL: dbUrl, PORT: String(cloudPort), BASE_URL: cloudBase }));

// 3. Helper to launch an isolated Glassine Studio engine.
async function startStudioChild(name: string) {
  const lib = path.join(tmpRoot, `lib-${name}`);
  const cache = path.join(tmpRoot, `cache-${name}`);
  const child = spawn(process.execPath, [path.resolve("dist/index.js"), "studio", "--port", "0", "--no-open", "--watch-stdin"], {
    env: {
      ...process.env,
      SCREENSHOTTER_OUTPUT_DIR: lib,
      SCREENSHOTTER_CACHE_DIR: cache,
      SCREENSHOTTER_STUDIO_FILE: path.join(lib, "studio.json"),
      SCREENSHOTTER_AGENTMAN_SOCKET: path.join(lib, "no-agentman.sock"),
      SCREENSHOTTER_NO_KEYCHAIN: "1",
      SCREENSHOTTER_APP_NAME: "Glassine",
      GLASSINE_SERVER_URL: cloudBase,
    },
    stdio: ["pipe", "ignore", "pipe"],
  });
  let log = "";
  const port = await new Promise<number>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`Studio ${name} timed out:\n${log}`)), 30_000);
    child.stderr.on("data", (b) => {
      log += String(b);
      const m = log.match(/SCREENSHOTTER_STUDIO_PORT=(\d+)/);
      if (m) {
        clearTimeout(t);
        resolve(Number(m[1]));
      }
    });
    child.once("exit", (c) => reject(new Error(`Studio ${name} exited ${c}:\n${log}`)));
  });
  const base = `http://127.0.0.1:${port}`;
  const req = async (p: string, body?: unknown) => {
    const r = await fetch(base + p, body === undefined ? {} : { method: "POST", headers: { "x-screenshotter": "studio", "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const text = await r.text();
    let json: any = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = text;
    }
    return { status: r.status, json };
  };
  return { child, port, base, lib, req, stop: () => { child.stdin.end(); child.kill("SIGTERM"); } };
}

async function cloudCall(p: string, opts: { body?: unknown; token?: string } = {}) {
  const r = await fetch(cloudBase + p, {
    method: opts.body !== undefined ? "POST" : "GET",
    headers: { ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}), ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}), Origin: cloudBase },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
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

async function signInBrowser(email: string): Promise<string> {
  await cloudCall("/api/auth/email-otp/send-verification-otp", { body: { email, type: "sign-in" } });
  const mail = outbox.filter((m) => m.to === email).at(-1);
  const otp = mail?.text.match(/\b(\d{3}) (\d{3})\b/)?.slice(1).join("") ?? "";
  const r = await cloudCall("/api/auth/sign-in/email-otp", { body: { email, otp } });
  const token = r.headers.get("set-auth-token") ?? "";
  if (!token) throw new Error(`Couldn't sign ${email} in: ${r.status}`);
  return token;
}

async function signInStudio(studio: Awaited<ReturnType<typeof startStudioChild>>, email: string) {
  const browserTok = await signInBrowser(email);
  const started = await studio.req("/api/cloud/signin/start", { serverUrl: cloudBase });
  if (started.status !== 200 || !started.json.userCode) throw new Error(`signin/start failed: ${JSON.stringify(started)}`);
  const code = started.json.userCode;
  await cloudCall(`/api/auth/device?user_code=${encodeURIComponent(code)}`, { token: browserTok });
  await cloudCall("/api/auth/device/approve", { body: { userCode: code }, token: browserTok });
  const done = await waitFor(async () => {
    const s = await studio.req("/api/cloud/signin/status");
    return s.json.status === "approved" ? s.json : null;
  }, 10_000, 200);
  return { browserTok, done };
}

function openSSE(base: string, boardId: string) {
  const events: any[] = [];
  const ac = new AbortController();
  const ready = (async () => {
    const res = await fetch(`${base}/api/cloud/live/stream?board=${encodeURIComponent(boardId)}`, { signal: ac.signal });
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let buf = "";
    (async () => {
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          for (let i = buf.indexOf("\n\n"); i >= 0; i = buf.indexOf("\n\n")) {
            const chunk = buf.slice(0, i);
            buf = buf.slice(i + 2);
            for (const line of chunk.split("\n")) {
              if (line.startsWith("data: ")) {
                try {
                  events.push(JSON.parse(line.slice(6)));
                } catch {}
              }
            }
          }
        }
      } catch {}
    })();
  })();
  return { events, ready, close: () => ac.abort() };
}

let aliceStudio: Awaited<ReturnType<typeof startStudioChild>> | null = null;
let bobStudio: Awaited<ReturnType<typeof startStudioChild>> | null = null;
let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;

try {
  check((await fetch(`${cloudBase}/privacy`)).status === 200, "the server serves /privacy");

  aliceStudio = await startStudioChild("alice");
  bobStudio = await startStudioChild("bob");

  // Device sign-in for Alice and Bob.
  const aAuth = await signInStudio(aliceStudio, "alice@example.com");
  const aAcct = await aliceStudio.req("/api/cloud/account");
  check(aAuth.done.user?.email === "alice@example.com" && aAcct.json.signedIn && aAcct.json.user.email === "alice@example.com", "Alice signs in through the Mac device flow");

  // Alice creates a team and invites Bob.
  const teamRes = await aliceStudio.req("/api/cloud/teams/create", { name: "Design Studio" });
  const teamId = teamRes.json.id;
  check(teamRes.status === 200 && teamId, "Alice creates a team from Glassine");

  const invRes = await aliceStudio.req("/api/cloud/teams/invite", { teamId, email: "bob@example.com", role: "member" });
  const details = await aliceStudio.req(`/api/cloud/teams/details?team=${encodeURIComponent(teamId)}`);
  check(invRes.status === 200 && details.json.members?.length === 1 && details.json.invitations?.length === 1, "Alice invites Bob and sees members + pending invite");

  const bAuth = await signInStudio(bobStudio, "bob@example.com");
  await cloudCall("/api/auth/organization/accept-invitation", { body: { invitationId: invRes.json.id }, token: bAuth.browserTok });
  const bAcct = await bobStudio.req("/api/cloud/account");
  check(bAcct.json.signedIn && bAcct.json.teams.some((t: any) => t.id === teamId && t.name === "Design Studio"), "Bob signs in, joins the team, and sees it in Glassine");

  // Alice creates a local board with a real PNG picture, then moves it into the team.
  const localBoard = (await aliceStudio.req("/api/board/new", { name: "Hero Concepts" })).json;
  const pngPath = path.join(aliceStudio.lib, "images", "pixel.png");
  const pngBytes = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0f01f0005000201a2d9b2a30000000049454e44ae426082", "hex");
  execFileSync("mkdir", ["-p", path.dirname(pngPath)]);
  writeFileSync(pngPath, pngBytes);
  const pageId = localBoard.pages[0].id;
  await aliceStudio.req("/api/board/ops", {
    id: localBoard.id,
    ops: [
      {
        op: "add",
        page: pageId,
        parent: null,
        ids: ["f1"],
        nodes: {
          f1: { id: "f1", type: "frame", name: "Card", parent: null, children: ["i1"], style: { left: "100px", top: "100px", width: "320px", height: "200px", backgroundColor: "#ffffff" } },
          i1: { id: "i1", type: "image", name: "Photo", parent: "f1", src: pngPath, style: { width: "40px", height: "40px" } },
        },
      },
    ],
  });

  const moved = await aliceStudio.req("/api/cloud/boards/move", { id: localBoard.id, teamId, teamName: "Design Studio" });
  const teamBoardId = moved.json.board?.id;
  const assetUrl = moved.json.board?.nodes?.i1?.src as string;
  check(moved.status === 200 && teamBoardId && /^\/api\/assets\//.test(assetUrl), `local board moves to team and uploads its local PNG (${assetUrl})`);
  const bobBoards = (await bobStudio.req(`/api/cloud/teams/boards?team=${encodeURIComponent(teamId)}`)).json.boards;
  check(bobBoards.some((b: any) => b.id === teamBoardId && b.name === "Hero Concepts"), "Bob sees the moved board in the team's list");

  // Bob opens the team board and fetches the proxied asset through his Studio.
  const bobOpen = await bobStudio.req("/api/cloud/boards/open", { id: teamBoardId, teamName: "Design Studio" });
  const assetRes = await fetch(bobStudio.base + assetUrl);
  check(bobOpen.status === 200 && assetRes.status === 200 && Buffer.from(await assetRes.arrayBuffer()).equals(pngBytes), "Bob's Studio proxies and caches the team picture identically");

  // Live SSE sync: Alice edits -> Bob receives; MCP agent edits Alice's disk -> Bob receives; presence relays.
  const aSse = openSSE(aliceStudio.base, teamBoardId);
  const bSse = openSSE(bobStudio.base, teamBoardId);
  await Promise.all([aSse.ready, bSse.ready]);
  await waitFor(async () => aSse.events.some((e) => (e.t === "welcome" || e.t === "state") && e.status === "connected"));
  await waitFor(async () => bSse.events.some((e) => (e.t === "welcome" || e.t === "state") && e.status === "connected"));

  await aliceStudio.req("/api/board/ops", { id: teamBoardId, ops: [{ op: "set", id: "f1", name: "Pricing Card" }] });
  const bobGotOp = await waitFor(async () => bSse.events.find((e) => e.t === "ops" && e.ops?.some((o: any) => o.name === "Pricing Card")));
  const bobDisk = (await bobStudio.req(`/api/board?id=${encodeURIComponent(teamBoardId)}`)).json;
  check(Boolean(bobGotOp) && bobDisk.nodes.f1.name === "Pricing Card", "Alice's edit streams live to Bob and updates Bob's local board");

  // Simulate an external MCP agent writing directly to Alice's local board file via changeBoard(..., "agent").
  const prevOut = process.env.SCREENSHOTTER_OUTPUT_DIR;
  process.env.SCREENSHOTTER_OUTPUT_DIR = aliceStudio.lib;
  const { changeBoard } = await import("../dist/board/store.js");
  changeBoard(teamBoardId, [{ op: "set", id: "f1", style: { backgroundColor: "#22aa66" } }], "agent");
  if (prevOut === undefined) delete process.env.SCREENSHOTTER_OUTPUT_DIR;
  else process.env.SCREENSHOTTER_OUTPUT_DIR = prevOut;
  const bobGotAgent = await waitFor(async () => bSse.events.find((e) => e.t === "ops" && e.ops?.some((o: any) => o.style?.backgroundColor === "#22aa66")));
  check(Boolean(bobGotAgent) && Boolean(bobGotAgent.agent), "an MCP agent's edit on Alice's disk streams live to Bob with agent attribution");

  // Live cursor & selection presence over SSE.
  await aliceStudio.req("/api/cloud/live/presence", { id: teamBoardId, p: { page: pageId, cursor: { x: 240, y: 180 }, selection: ["f1"] } });
  const bobGotPresence = await waitFor(async () => bSse.events.find((e) => e.t === "presence" && e.p?.cursor?.x === 240 && e.p?.selection?.[0] === "f1"));
  check(Boolean(bobGotPresence), "Alice's live cursor and selection reach Bob immediately");

  aSse.close();
  bSse.close();

  // 4. Real browser UI check with Playwright: Teams on Home + live teammate cursor on canvas.
  browser = await chromium.launch({ headless: true });
  const pageA = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const pageB = await browser.newPage({ viewport: { width: 1280, height: 800 } });

  await pageA.goto(aliceStudio.base);
  await pageA.waitForSelector(".home-teams button", { timeout: 10_000 });
  const teamBtnText = await pageA.textContent(".home-teams");
  check(Boolean(teamBtnText && teamBtnText.includes("Design Studio")), "Alice's Home sidebar shows her team");
  await pageA.click('.home-teams button:has-text("Design Studio")');
  await pageA.waitForSelector(`.sp-card[data-board="${teamBoardId}"]`, { timeout: 10_000 });
  check(true, "Clicking the team on Home shows its team boards");

  // Open the team board in both browser windows.
  await pageA.click(`.sp-card[data-board="${teamBoardId}"]`);
  await pageA.waitForSelector(".bd-team-pill", { timeout: 10_000 });

  await pageB.goto(bobStudio.base);
  await pageB.waitForSelector('.home-teams button:has-text("Design Studio")', { timeout: 10_000 });
  await pageB.click('.home-teams button:has-text("Design Studio")');
  await pageB.waitForSelector(`.sp-card[data-board="${teamBoardId}"]`, { timeout: 10_000 });
  await pageB.click(`.sp-card[data-board="${teamBoardId}"]`);
  await pageB.waitForSelector(".bd-team-pill", { timeout: 10_000 });

  // Wait for both browsers to see each other's avatar in PresenceBar.
  await pageB.waitForSelector(".bd-presence-bar .bd-avatar", { timeout: 10_000 });
  check(true, "Bob's canvas shows Alice's avatar in the presence bar");

  // Alice moves her mouse over the canvas -> Bob sees Alice's live cursor!
  const canvasBox = await pageA.locator(".bd-canvas").boundingBox();
  if (canvasBox) {
    await pageA.mouse.move(canvasBox.x + 320, canvasBox.y + 260);
    await pageA.mouse.move(canvasBox.x + 380, canvasBox.y + 300);
  }
  await pageB.waitForSelector(".bd-peer-cursor .bd-cursor-name", { timeout: 10_000 });
  const cursorLabel = await pageB.textContent(".bd-peer-cursor .bd-cursor-name");
  check(Boolean(cursorLabel && /alice/i.test(cursorLabel)), `Bob sees Alice's live cursor on the canvas (${cursorLabel?.trim()})`);

  // Alice adds a text layer live -> Bob's canvas DOM renders it without reloading!
  await aliceStudio.req("/api/board/ops", {
    id: teamBoardId,
    ops: [{ op: "add", parent: "f1", ids: ["t-live"], nodes: { "t-live": { id: "t-live", type: "text", name: "Headline", parent: "f1", text: "Hello live team", style: { fontSize: "20px", color: "#111111" } } } }],
  });
  await pageB.waitForSelector('[data-bid="t-live"]', { timeout: 10_000 });
  const liveText = await pageB.textContent('[data-bid="t-live"]');
  check(liveText?.includes("Hello live team"), "Alice's live layer addition renders immediately on Bob's open canvas");
} finally {
  await browser?.close().catch(() => undefined);
  aliceStudio?.stop();
  bobStudio?.stop();
  await cloudServer.close().catch(() => undefined);
  pgProc.kill("SIGINT");
  setTimeout(() => rmSync(tmpRoot, { recursive: true, force: true }), 500);
}

if (failed) {
  console.log(`${failed} failed`);
  process.exit(1);
}
console.log("All passed");
process.exit(0);
