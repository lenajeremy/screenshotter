// Before the app: sign in (Google through the browser, or a six-digit code by email), then three
// short steps the first time: your name, your team, your agents.
import { useEffect, useRef, useState } from "preact/hooks";
import { html } from "./controls.js";
import { Icon } from "./icons.js";
import { AgentLogo } from "./agent-logos.js";
import { loadAgents } from "./board-agent.js";
import { openExternal, refreshAccount } from "./cloud.js";
import { S, api, native, set, useStore } from "./store.js";

const seen = (key) => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};
const mark = (key, v = "1") => {
  try {
    localStorage.setItem(key, v);
  } catch {}
};

/** Whether this person has been through the first-run steps on this Mac. */
export const onboarded = (user) => Boolean(user && seen(`onboarded:${user.id ?? user.email}`));

const GoogleMark = () => html`<svg width="17" height="17" viewBox="0 0 18 18" aria-hidden="true"><path fill="#4285F4" d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844c-.209 1.125-.843 2.078-1.796 2.717v2.258h2.908c1.702-1.567 2.684-3.874 2.684-6.615z"/><path fill="#34A853" d="M9 18c2.43 0 4.467-.806 5.956-2.18l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 009 18z"/><path fill="#FBBC05" d="M3.964 10.71A5.41 5.41 0 013.682 9c0-.593.102-1.17.282-1.71V4.958H.957A8.996 8.996 0 000 9c0 1.452.348 2.827.957 4.042l3.007-2.332z"/><path fill="#EA4335" d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 00.957 4.958L3.964 7.29C4.672 5.163 6.656 3.58 9 3.58z"/></svg>`;

/** The whole window, until there's an account and the first-run steps are done. */
export function Gate() {
  const s = useStore();
  const cloud = s.cloud ?? {};
  const [step, setStep] = useState(() => (cloud.signedIn ? "name" : "welcome"));
  const [email, setEmail] = useState("");
  // Signed in from elsewhere (the browser flow finishing): move on.
  useEffect(() => {
    if (cloud.signedIn && (step === "welcome" || step === "code" || step === "browser")) setStep(onboarded(cloud.user) ? "done" : "name");
  }, [cloud.signedIn]);
  useEffect(() => {
    if (step === "done") finish(cloud.user);
  }, [step]);
  const steps = ["name", "team", "agents"];
  const at = steps.indexOf(step);
  return html`<div class="gate">
    <div class="gate-drag" data-drag></div>
    <section class="gate-form">
      ${at >= 0 && html`<div class="gate-steps" aria-label=${`Step ${at + 1} of 3`}>${steps.map((_, i) => html`<i class=${i <= at ? "on" : ""}></i>`)}</div>`}
      <div class="gate-card" key=${step}>
        ${step === "welcome" && html`<${Welcome} email=${email} setEmail=${setEmail} onCode=${() => setStep("code")} onBrowser=${() => setStep("browser")} />`}
        ${step === "code" && html`<${Code} email=${email} onBack=${() => setStep("welcome")} />`}
        ${step === "browser" && html`<${Browser} onBack=${() => setStep("welcome")} />`}
        ${step === "name" && html`<${Name} onNext=${() => setStep("team")} />`}
        ${step === "team" && html`<${Team} onBack=${() => setStep("name")} onNext=${() => setStep("agents")} />`}
        ${step === "agents" && html`<${Agents} onBack=${() => setStep("team")} onNext=${() => setStep("done")} />`}
      </div>
    </section>
    <section class="gate-show" aria-hidden="true"><img src="/ui/welcome.webp" alt="" draggable=${false} /><div class="gate-fade"></div></section>
  </div>`;
}

function finish(user) {
  const key = `onboarded:${user?.id ?? user?.email}`;
  const first = Boolean(user) && !seen(key);
  if (user) mark(key);
  set({ gate: false });
  // The first time on this Mac: a board that shows the way around, there when Home opens.
  if (first) api("/api/board/welcome", {}).then(() => api("/api/boards")).then((boards) => set({ boards })).catch(() => undefined);
}

function Welcome({ email, setEmail, onCode, onBrowser }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const send = async (e) => {
    e?.preventDefault();
    if (busy) return;
    setBusy(true);
    setErr("");
    try {
      const r = await api("/api/cloud/signin/email/send", { email });
      setEmail(r.email);
      onCode();
    } catch (x) {
      setErr(x.message || "Couldn't send the code. Try again.");
    } finally {
      setBusy(false);
    }
  };
  return html`<div class="gate-in">
    <div class="brand-mark gate-mark"></div>
    <h1>Welcome to ${S.opts?.appName ?? "Glassine"}</h1>
    <p class="gate-lede">Your team and your agents, designing on the same canvas.</p>
    <button class="gate-google" onClick=${onBrowser}><${GoogleMark} />Continue with Google</button>
    <div class="gate-or"><i></i>or<i></i></div>
    <form onSubmit=${send}>
      <input class="gate-input" type="email" placeholder="you@company.com" value=${email} autoFocus spellcheck=${false} autocomplete="email" aria-label="Email"
        onInput=${(e) => (setEmail(e.target.value), setErr(""))} onKeyDown=${(e) => e.stopPropagation()} />
      ${err && html`<p class="gate-err" role="alert">${err}</p>`}
      <button class="btn primary gate-btn" type="submit" disabled=${busy || !email.trim()}>${busy ? html`<span class="spinner"></span>` : "Continue with email"}</button>
    </form>
    <p class="gate-fine">We'll email you a six-digit code. By continuing you agree to the <a onClick=${() => openExternal(`${S.cloud?.serverUrl || "https://glassine.thesunset.live"}/terms`)}>Terms</a> and <a onClick=${() => openExternal(`${S.cloud?.serverUrl || "https://glassine.thesunset.live"}/privacy`)}>Privacy Policy</a>.</p>
  </div>`;
}

function Code({ email, onBack }) {
  const [digits, setDigits] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [wait, setWait] = useState(30);
  const field = useRef();
  // The boxes are drawn; the one real field under them takes the typing, so it has the focus from the start.
  useEffect(() => {
    field.current?.focus();
  }, []);
  useEffect(() => {
    if (wait <= 0) return;
    const t = setTimeout(() => setWait(wait - 1), 1000);
    return () => clearTimeout(t);
  }, [wait]);
  const verify = async (code) => {
    setBusy(true);
    setErr("");
    try {
      const r = await api("/api/cloud/signin/email/verify", { email, code });
      if (r.token && native) await native.call("setCloudToken", { key: r.token }).catch(() => undefined);
      await refreshAccount();
    } catch (x) {
      setErr(x.message || "That code isn't right.");
      setDigits("");
      field.current?.focus();
    } finally {
      setBusy(false);
    }
  };
  const type = (v) => {
    const d = v.replace(/\D/g, "").slice(0, 6);
    setDigits(d);
    setErr("");
    if (d.length === 6 && !busy) verify(d);
  };
  const resend = async () => {
    setWait(30);
    setErr("");
    await api("/api/cloud/signin/email/send", { email }).catch((x) => setErr(x.message || "Couldn't send a new code."));
  };
  return html`<div class="gate-in">
    <button class="gate-back" onClick=${onBack}><${Icon} n="left" s=${14} />Back</button>
    <h1>Check your email</h1>
    <p class="gate-lede">Enter the code we sent to <b>${email}</b></p>
    <label class="gate-code ${err ? "bad" : ""} ${busy ? "busy" : ""}" onClick=${() => field.current?.focus()}>
      <input ref=${field} inputmode="numeric" autocomplete="one-time-code" maxlength="6" value=${digits} autoFocus aria-label="Six-digit code" disabled=${busy}
        onInput=${(e) => type(e.target.value)} onKeyDown=${(e) => e.stopPropagation()} />
      ${[0, 1, 2, 3, 4, 5].map((i) => html`${i === 3 && html`<i class="gate-dash"></i>`}<span class="${digits[i] ? "has" : ""} ${i === digits.length && !busy ? "at" : ""}">${digits[i] ?? ""}</span>`)}
    </label>
    ${err ? html`<p class="gate-err" role="alert">${err}</p>` : busy ? html`<p class="gate-note"><span class="spinner"></span>Signing you in…</p>` : html`<p class="gate-note"><span class="gate-plain">Didn't get it? Check spam, or ${wait > 0 ? html`<b>resend in 0:${String(wait).padStart(2, "0")}</b>` : html`<a onClick=${resend}>send a new code</a>`}.</span></p>`}
    <p class="gate-fine">The code works for 10 minutes.</p>
  </div>`;
}

/** Google goes through the browser: the page signs you in and hands the session back here. */
function Browser({ onBack }) {
  const [flow, setFlow] = useState(null);
  const [err, setErr] = useState("");
  const begin = async () => {
    setErr("");
    try {
      const r = await api("/api/cloud/signin/start", {});
      setFlow(r);
      if (r.verificationUrl) openExternal(r.verificationUrl);
    } catch {
      setErr("Couldn't reach Glassine. Check your connection and try again.");
    }
  };
  useEffect(() => {
    begin();
    return () => api("/api/cloud/signin/cancel", {}).catch(() => undefined);
  }, []);
  useEffect(() => {
    if (!flow || flow.status !== "pending") return;
    const t = setInterval(async () => {
      const r = await api("/api/cloud/signin/status?consume=1").catch(() => null);
      if (!r) return;
      if (r.status === "approved") {
        clearInterval(t);
        if (r.token && native) await native.call("setCloudToken", { key: r.token }).catch(() => undefined);
        await refreshAccount();
      } else if (r.status !== "pending") {
        clearInterval(t);
        setFlow(r);
        setErr("Sign-in didn't finish. Try again.");
      }
    }, 1200);
    return () => clearInterval(t);
  }, [flow?.status, flow?.userCode]);
  return html`<div class="gate-in">
    <button class="gate-back" onClick=${onBack}><${Icon} n="left" s=${14} />Back</button>
    <h1>Finish in your browser</h1>
    <p class="gate-lede">We opened a page to sign you in with Google. Come back here when it says you're done.</p>
    ${err
      ? html`<p class="gate-err" role="alert">${err}</p><button class="btn primary gate-btn" onClick=${begin}>Try again</button>`
      : html`${flow?.displayCode && html`<div class="gate-device" title="The page will show this same code">${flow.displayCode}</div>`}
          <p class="gate-note"><span class="spinner"></span>Waiting for your browser…</p>
          ${flow?.verificationUrl && html`<button class="btn gate-btn" onClick=${() => openExternal(flow.verificationUrl)}>Open the page again</button>`}`}
  </div>`;
}

function Name({ onNext }) {
  const s = useStore();
  const user = s.cloud?.user ?? {};
  const [name, setName] = useState(user.name && user.name !== user.email ? user.name : "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const go = async (e) => {
    e?.preventDefault();
    if (!name.trim() || busy) return;
    setBusy(true);
    try {
      if (name.trim() !== user.name) {
        await api("/api/cloud/profile", { name });
        await refreshAccount();
      }
      onNext();
    } catch (x) {
      setErr(x.message || "Couldn't save your name.");
    } finally {
      setBusy(false);
    }
  };
  return html`<form class="gate-in" onSubmit=${go}>
    <h1>What should we call you?</h1>
    <p class="gate-lede">Teammates see this next to your cursor and comments.</p>
    <div class="gate-row">
      ${user.image ? html`<img class="gate-av" src=${user.image} alt="" />` : html`<span class="gate-av">${(name || user.email || "?")[0].toUpperCase()}</span>`}
      <label class="grow"><span>Name</span><input class="gate-input" value=${name} autoFocus spellcheck=${false} onInput=${(e) => (setName(e.target.value), setErr(""))} onKeyDown=${(e) => e.stopPropagation()} /></label>
    </div>
    ${err && html`<p class="gate-err" role="alert">${err}</p>`}
    <div class="gate-foot"><span></span><button class="btn primary gate-next" type="submit" disabled=${busy || !name.trim()}>Continue</button></div>
  </form>`;
}

function Team({ onBack, onNext }) {
  const s = useStore();
  const teams = s.cloud?.teams ?? [];
  return html`<div class="gate-in">
    <h1>${teams.length ? "Your team is here" : "Work with a team?"}</h1>
    <p class="gate-lede">Teams share boards and edit them together, live. You can also do this later.</p>
    ${teams.length > 0 && html`<div class="gate-list">${teams.map((t) => html`<div class="gate-item" key=${t.id}>
      <i class="gate-team">${(t.name || "?")[0].toUpperCase()}</i>
      <div class="grow"><b>${t.name}</b><span>You're ${t.role === "owner" ? "the owner" : `a ${t.role ?? "member"}`}</span></div>
      <${Icon} n="check" s=${16} />
    </div>`)}</div>`}
    <button class="gate-item as-btn" onClick=${() => (set({ modal: { kind: "upgrade" } }))}>
      <i class="gate-team plain"><${Icon} n="plus" s=${15} /></i>
      <div class="grow"><b>Create a team</b><span>$16 a person each month, billed yearly</span></div>
      <em>Team plan</em>
    </button>
    <div class="gate-foot"><button class="gate-back in-foot" onClick=${onBack}>Back</button><button class="btn ${teams.length ? "primary" : ""} gate-next" onClick=${onNext}>${teams.length ? "Continue" : "Skip, I'll work alone"}</button></div>
  </div>`;
}

function Agents({ onBack, onNext }) {
  const [agents, setAgents] = useState(null);
  useEffect(() => {
    loadAgents().then(setAgents);
  }, []);
  const none = agents && !agents.length;
  return html`<div class="gate-in">
    <h1>${none ? "Bring an agent" : "Your agents are ready"}</h1>
    <p class="gate-lede">${none ? "Glassine works with the coding agents on your Mac. Install one and it shows up here." : "We found these on your Mac. They design on your boards with their own accounts; Glassine never sees your keys."}</p>
    <div class="gate-list">
      ${agents === null && html`<div class="gate-item"><span class="spinner"></span><div class="grow"><b>Looking on this Mac…</b></div></div>`}
      ${(agents ?? []).map((a, i) => html`<div class="gate-item" key=${a.id}><${AgentLogo} id=${a.id} s=${18} /><div class="grow"><b>${a.label}</b>${i === 0 && html`<span>Default</span>`}</div><small><i></i>Ready</small></div>`)}
      ${none && html`<div class="gate-item"><${Icon} n="code" s=${18} /><div class="grow"><b>Claude Code, Codex, opencode or Antigravity</b><span>Install any of them, then reopen Glassine</span></div></div>`}
    </div>
    <div class="gate-foot"><button class="gate-back in-foot" onClick=${onBack}>Back</button><button class="btn primary gate-next" onClick=${onNext}>Open ${S.opts?.appName ?? "Glassine"}</button></div>
  </div>`;
}
