// The Team plan: what it adds, what it costs, and the way into a team.
import { useEffect, useRef, useState } from "preact/hooks";
import { html } from "./controls.js";
import { Icon } from "./icons.js";
import { AgentLogo } from "./agent-logos.js";
import { set, toast, useStore } from "./store.js";

const PRICE = { yearly: 16, monthly: 20 };

/** A number that glides to its new value (a fifth of a second, easing out) instead of jumping. */
function useGlide(target, ms = 200) {
  const [shown, setShown] = useState(target);
  const from = useRef(target);
  useEffect(() => {
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return setShown(target);
    const start = from.current;
    const t0 = performance.now();
    let raf = 0;
    const step = (now) => {
      const k = Math.min(1, (now - t0) / ms);
      const v = start + (target - start) * (1 - Math.pow(1 - k, 3));
      from.current = v;
      setShown(v);
      if (k < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target]);
  return shown;
}
const BENEFITS = [
  ["pointer", "Live editing with cursors"],
  ["comment", "Comments from teammates"],
  ["users", "Roles and team boards"],
  ["component", "Shared tokens and components"],
];

export function UpgradeModal() {
  const s = useStore();
  const [period, setPeriod] = useState("yearly");
  const [seats, setSeats] = useState(3);
  const close = () => set({ modal: null });
  useEffect(() => {
    const key = (e) => e.key === "Escape" && (e.preventDefault(), close());
    addEventListener("keydown", key);
    return () => removeEventListener("keydown", key);
  }, []);
  const each = PRICE[period];
  const total = period === "yearly" ? each * 12 * seats : each * seats;
  const money = (n) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2 })}`;
  const gliding = Math.round(useGlide(total));
  const go = () => {
    // Payments aren't wired yet: say so, and let the team be made.
    set({ modal: { kind: "createTeam" } });
    toast({ kind: "info", title: "Payments aren't switched on yet", text: "Teams are free to start while Glassine is in preview.", timeout: 7000 });
  };
  const me = s.cloud?.user;
  return html`<div class="scrim" onPointerDown=${(e) => e.target === e.currentTarget && close()}>
    <div class="sheet plan-sheet" role="dialog" aria-label="Upgrade to Team">
      <div class="plan-why">
        <h2>Upgrade to Team</h2>
        <p>Your team and your agents, designing in the same board. Everything you use today stays free.</p>
        <div class="plan-art" aria-hidden="true">
          <div class="plan-page"><b>Ship the whole team's work.</b><span>One place for plans, designs and releases.</span><i></i></div>
          <div class="plan-sel"><em>${(me?.name || "You").split(" ")[0]}</em></div>
          <div class="plan-cursor"><${Icon} n="pointer" s=${14} /><em>Jo</em></div>
          <div class="plan-note"><b>Jo</b><span>Can the button sit closer to the headline?</span></div>
          <div class="plan-note agent"><${AgentLogo} id="claude" s=${14} /><span>Gap 16 → 12 on Hero</span></div>
        </div>
        <ul class="plan-list">${BENEFITS.map(([icon, text]) => html`<li><${Icon} n=${icon} s=${15} />${text}</li>`)}</ul>
      </div>
      <div class="plan-bill">
        <div class="plan-bill-head"><b>Billing</b><button class="icon-btn sm" title="Close (Esc)" onClick=${close}><${Icon} n="x" s=${14} /></button></div>
        <div class="plan-opts" role="radiogroup" aria-label="Billing period">
          ${[["yearly", "Yearly", "$192 a person each year"], ["monthly", "Monthly", "Billed each month"]].map(([id, label, note]) => html`<button role="radio" aria-checked=${period === id} class="plan-opt ${period === id ? "on" : ""}" onClick=${() => setPeriod(id)}>
            <span class="grow"><b>${label}${id === "yearly" && html`<em>Save 20%</em>`}</b><small>${note}</small></span>
            <span class="plan-price"><b>$${PRICE[id]}</b><small>per person / mo</small></span>
            <i class="plan-radio"></i>
          </button>`)}
        </div>
        <div class="plan-seats"><span>Seats</span><div class="plan-step"><button title="One fewer" disabled=${seats <= 1} onClick=${() => setSeats(seats - 1)}><${Icon} n="minus" s=${12} /></button><b>${seats}</b><button title="One more" disabled=${seats >= 99} onClick=${() => setSeats(seats + 1)}><${Icon} n="plus" s=${12} /></button></div></div>
        <div class="plan-sum">
          <div><span>${seats} seat${seats === 1 ? "" : "s"} × $${period === "yearly" ? each * 12 : each}</span><span>${money(total)}</span></div>
          <div class="due"><b>Due ${period === "yearly" ? "each year" : "each month"}</b><b class="plan-total" data-total=${money(total)}>${money(gliding)}</b></div>
        </div>
        <span class="grow"></span>
        <button class="btn primary plan-go" onClick=${go}>Continue</button>
        <small class="plan-fine">Cancel any time. Your boards stay yours.</small>
      </div>
    </div>
  </div>`;
}
