/**
 * The few pages people open in their browser: signing in (an emailed code, or Google), approving
 * the Mac app (the code it shows), and joining a team from an invitation. Each is a plain page
 * that calls Better Auth's own endpoints.
 */
import { Hono } from "hono";
import type { Auth } from "./auth.js";
import { APP_NAME } from "./auth.js";
import type { Config } from "./config.js";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function page(title: string, body: string, script = ""): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · ${esc(APP_NAME)}</title>
<style>
:root{--bg:#f6f6f4;--card:#fff;--line:#e6e6e1;--ink:#1a1a1a;--dim:#6b6b66;--accent:#1a1a1a;--bad:#c62f2f;color-scheme:light dark}
@media (prefers-color-scheme:dark){:root{--bg:#151515;--card:#1d1d1d;--line:#2d2d2d;--ink:#f1f1ef;--dim:#9a9a95;--accent:#f1f1ef;--bad:#ff6b6b}}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--ink);font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;padding:24px 16px}
main{width:100%;max-width:380px;background:var(--card);border:1px solid var(--line);border-radius:14px;padding:32px}
.brand{font-weight:600;font-size:13px;letter-spacing:.02em;color:var(--dim);margin:0 0 20px}
h1{font-size:21px;line-height:1.25;margin:0 0 8px;font-weight:600}p{margin:0 0 16px;color:var(--dim)}
label{display:block;font-size:13px;font-weight:500;margin:0 0 6px}
input{width:100%;font:inherit;padding:10px 12px;border:1px solid var(--line);border-radius:8px;background:transparent;color:inherit;outline:none}
input:focus{border-color:var(--dim)}.code{font:600 24px/1 ui-monospace,Menlo,monospace;letter-spacing:.25em;text-align:center}
button,.button{display:flex;align-items:center;justify-content:center;gap:8px;width:100%;margin-top:12px;font:inherit;font-weight:500;padding:10px 14px;border-radius:8px;border:1px solid var(--accent);background:var(--accent);color:var(--card);cursor:pointer;text-decoration:none}
button.quiet,.button.quiet{background:transparent;color:var(--ink);border-color:var(--line)}button:disabled{opacity:.5;cursor:default}
.or{display:flex;align-items:center;gap:12px;color:var(--dim);font-size:13px;margin:18px 0 6px}.or:before,.or:after{content:"";flex:1;height:1px;background:var(--line)}
.err{color:var(--bad);font-size:13px;margin:10px 0 0;min-height:1em}.big{font:600 28px/1 ui-monospace,Menlo,monospace;letter-spacing:.12em;margin:8px 0 20px;color:var(--ink)}
.done{text-align:center}.small{font-size:13px}
</style></head><body><main><p class="brand">${esc(APP_NAME)}</p>${body}</main>${script ? `<script>${script}</script>` : ""}</body></html>`;
}

const api = `async function api(path, body) {
  const r = await fetch("/api/auth" + path, body === undefined ? { credentials: "same-origin" } : { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.message || j.error_description || j.error || "Something went wrong.");
  return j;
}`;

export function pageRoutes(auth: Auth, config: Config) {
  const app = new Hono();
  const signedIn = async (h: Headers) => (await auth.api.getSession({ headers: h }))?.user ?? null;
  const back = (url: string) => `/signin?next=${encodeURIComponent(url)}`;

  app.get("/", async (c) => {
    const u = await signedIn(c.req.raw.headers);
    return c.html(page(APP_NAME, u ? `<h1>You're signed in</h1><p>As ${esc(u.email)}. Open ${esc(APP_NAME)} on your Mac to design with your team.</p><form method="post" action="/signout"><button class="quiet">Sign out</button></form>` : `<h1>Design with your team</h1><p>Sign in to work on boards together, live.</p><a class="button" href="/signin">Sign in</a>`));
  });

  app.get("/privacy", (c) =>
    c.html(
      page(
        "Privacy",
        `<h1>Privacy</h1><p>${esc(APP_NAME)} uses your name, email address and profile picture solely to sign you in, identify you in teams, and show your cursor while collaborating on boards.</p><p>Your boards and uploaded assets are stored to sync them with your team and are never sold or shared with third parties.</p><p class="small">Questions? Contact the workspace administrator.</p>`,
      ),
    ),
  );

  app.post("/signout", async (c) => {
    const r = await auth.api.signOut({ headers: c.req.raw.headers, asResponse: true });
    const out = c.redirect("/");
    for (const ck of r.headers.getSetCookie()) out.headers.append("Set-Cookie", ck);
    return out;
  });

  // Sign in: an email, then the code sent to it; or Google.
  app.get("/signin", async (c) => {
    const next = (c.req.query("next") ?? "/").startsWith("/") ? (c.req.query("next") ?? "/") : "/";
    if (await signedIn(c.req.raw.headers)) return c.redirect(next);
    const google = config.google ? `<button class="quiet" id="google" type="button"><svg width="16" height="16" viewBox="0 0 48 48" aria-hidden="true"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z"/><path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z"/></svg>Continue with Google</button><div class="or">or</div>` : "";
    return c.html(
      page(
        "Sign in",
        `<h1 id="title">Sign in</h1><p id="lead">We'll email you a code: no password.</p>
${google}<form id="email-form"><label for="email">Email</label><input id="email" type="email" autocomplete="email" required autofocus placeholder="you@company.com"><button id="send">Email me a code</button></form>
<form id="code-form" hidden><label for="code">Code</label><input id="code" class="code" inputmode="numeric" autocomplete="one-time-code" maxlength="7" required><button id="verify">Sign in</button><button class="quiet" type="button" id="again">Use another email</button></form>
<p class="err" id="err" role="alert"></p>`,
        `${api}
const next = ${JSON.stringify(next)}, $ = (id) => document.getElementById(id), err = (e) => ($("err").textContent = e ? e.message || e : "");
let email = "";
$("email-form").onsubmit = async (e) => { e.preventDefault(); err(); $("send").disabled = true;
  try { email = $("email").value.trim(); await api("/email-otp/send-verification-otp", { email, type: "sign-in" });
    $("email-form").hidden = true; $("code-form").hidden = false; ${config.google ? `$("google").hidden = true; document.querySelector(".or").hidden = true;` : ""}
    $("title").textContent = "Check your email"; $("lead").textContent = "Type the 6-digit code we sent to " + email + "."; $("code").focus();
  } catch (x) { err(x); } finally { $("send").disabled = false; } };
$("code-form").onsubmit = async (e) => { e.preventDefault(); err(); $("verify").disabled = true;
  try { await api("/sign-in/email-otp", { email, otp: $("code").value.replace(/\\D/g, "") }); location.replace(next); }
  catch (x) { err(x); $("verify").disabled = false; } };
$("again").onclick = () => location.reload();
${config.google ? `$("google").onclick = async () => { err(); try { const r = await api("/sign-in/social", { provider: "google", callbackURL: next }); location.href = r.url; } catch (x) { err(x); } };` : ""}`,
      ),
    );
  });

  // The Mac app's sign-in: the code it shows, approved here.
  app.get("/device", async (c) => {
    const code = (c.req.query("user_code") ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (!(await signedIn(c.req.raw.headers))) return c.redirect(back(`/device${code ? `?user_code=${code}` : ""}`));
    const shown = code.length > 4 ? `${code.slice(0, 4)}-${code.slice(4)}` : code;
    return c.html(
      page(
        "Sign in on your Mac",
        code
          ? `<div id="ask"><h1>Sign in ${esc(APP_NAME)} on your Mac?</h1><p>Check this is the code the app shows:</p><p class="big">${esc(shown)}</p><button id="yes">Sign in on this Mac</button><button class="quiet" id="no">That isn't my code</button></div><div id="done" class="done" hidden><h1 id="done-title"></h1><p id="done-text"></p></div><p class="err" id="err" role="alert"></p>`
          : `<h1>Sign in on your Mac</h1><p>Type the code ${esc(APP_NAME)} shows.</p><form method="get"><input name="user_code" class="code" required autofocus maxlength="9"><button>Continue</button></form>`,
        code
          ? `${api}
const $ = (id) => document.getElementById(id), code = ${JSON.stringify(code)};
const finish = (t, x) => { $("ask").hidden = true; $("done").hidden = false; $("done-title").textContent = t; $("done-text").textContent = x; };
// The code is claimed by this signed-in browser first; only then can it be approved.
$("yes").disabled = $("no").disabled = true;
api("/device?user_code=" + encodeURIComponent(code)).then(() => { $("yes").disabled = $("no").disabled = false; }).catch((x) => { $("ask").hidden = true; $("err").textContent = "That code didn't work: it may have expired. Start again from the app."; });
$("yes").onclick = async () => { try { await api("/device/approve", { userCode: code }); finish("You're signed in", "Go back to ${esc(APP_NAME)}: it has signed in. You can close this tab."); } catch (x) { $("err").textContent = x.message; } };
$("no").onclick = async () => { try { await api("/device/deny", { userCode: code }); } catch {} finish("Not signed in", "Nothing was signed in. You can close this tab."); };`
          : "",
      ),
    );
  });

  // Joining a team from an invitation.
  app.get("/invite/:id", async (c) => {
    const id = c.req.param("id");
    const u = await signedIn(c.req.raw.headers);
    if (!u) return c.redirect(back(`/invite/${encodeURIComponent(id)}`));
    return c.html(
      page(
        "Join a team",
        `<div id="ask"><h1 id="title">Join the team</h1><p id="lead">Loading the invitation…</p><button id="yes" disabled>Join the team</button></div><div id="done" class="done" hidden><h1>You're in</h1><p id="done-text"></p></div><p class="err" id="err" role="alert"></p>`,
        `${api}
const $ = (id) => document.getElementById(id), id = ${JSON.stringify(id)}, me = ${JSON.stringify(u.email)};
api("/organization/get-invitation?id=" + encodeURIComponent(id)).then((inv) => {
  $("title").textContent = "Join " + inv.organizationName;
  $("lead").textContent = (inv.inviterEmail ? inv.inviterEmail + " invited you" : "You're invited") + " to design with the " + inv.organizationName + " team on ${esc(APP_NAME)}.";
  $("yes").disabled = false;
  $("yes").onclick = async () => { try { await api("/organization/accept-invitation", { invitationId: id }); $("ask").hidden = true; $("done").hidden = false; $("done-text").textContent = "Open ${esc(APP_NAME)} on your Mac: the team's boards are there."; } catch (x) { $("err").textContent = x.message; } };
}).catch(() => { $("lead").textContent = "This invitation isn't for " + me + ", or it has expired. Ask for a new one."; $("yes").hidden = true; });`,
      ),
    );
  });

  return app;
}
