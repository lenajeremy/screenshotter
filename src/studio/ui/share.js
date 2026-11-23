// Share: who can open this board, and inviting someone to the team it's in.
import { useEffect, useState } from "preact/hooks";
import { Popover, html } from "./controls.js";
import { Icon } from "./icons.js";
import { Avatar, TeamMark } from "./avatars.js";
import { B } from "./board-state.js";
import { api, set, toast, useStore } from "./store.js";

export function SharePopover({ anchor, onClose }) {
  const s = useStore();
  const live = B.live;
  const me = s.cloud?.user;
  const [details, setDetails] = useState(null);
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const load = () => live && api(`/api/cloud/teams/details?team=${encodeURIComponent(live.teamId)}`).then(setDetails).catch(() => setDetails({ members: [], invitations: [] }));
  useEffect(() => {
    load();
  }, [live?.teamId]);
  const invite = async (e) => {
    e?.preventDefault();
    if (!email.trim() || busy) return;
    setBusy(true);
    setErr("");
    try {
      await api("/api/cloud/teams/invite", { teamId: live.teamId, email: email.trim(), role: "member" });
      toast({ kind: "ok", title: "Invitation sent", text: email.trim() });
      setEmail("");
      load();
    } catch (x) {
      setErr(x.message || "Couldn't send the invitation.");
    } finally {
      setBusy(false);
    }
  };
  const go = (modal) => (onClose(), set({ modal }));
  return html`<${Popover} anchor=${anchor} onClose=${onClose} width=${380} align="end" class="share-pop">
    <div class="share">
      <div class="share-head"><b>Share “${B.board?.name}”</b></div>
      ${live
        ? html`<form class="share-invite" onSubmit=${invite}>
              <input class="input" type="email" placeholder="Invite by email" value=${email} autoFocus spellcheck=${false} onInput=${(e) => (setEmail(e.target.value), setErr(""))} onKeyDown=${(e) => e.stopPropagation()} />
              <button class="btn primary sm" type="submit" disabled=${busy || !email.trim()}>${busy ? html`<span class="spinner"></span>` : "Invite"}</button>
            </form>
            ${err && html`<p class="share-err" role="alert">${err}</p>`}
            <div class="share-list">
              <p>Who can open this</p>
              <div class="share-row"><${TeamMark} team=${{ id: live.teamId, name: live.teamName }} cls="gate-team sm" /><div class="grow"><b>Everyone at ${live.teamName || "the team"}</b><span>${details ? `${details.members.length} ${details.members.length === 1 ? "person" : "people"}` : "Loading…"}</span></div><em>Can edit</em></div>
              ${(details?.members ?? []).slice(0, 5).map((m) => html`<div class="share-row" key=${m.id}>
                <${Avatar} user=${m.user} />
                <div class="grow"><b>${m.user?.name || m.user?.email}${m.user?.email === me?.email && html`<small> (you)</small>`}</b><span>${m.user?.email}</span></div>
                <em>${m.role === "owner" ? "Owner" : "Can edit"}</em>
              </div>`)}
              ${(details?.invitations ?? []).slice(0, 3).map((i) => html`<div class="share-row" key=${i.id}><span class="cloud-av dim"><${Icon} n="link" s=${13} /></span><div class="grow"><b>${i.email}</b><span>Invited</span></div><em>Pending</em></div>`)}
            </div>
            <div class="share-foot"><button onClick=${() => go({ kind: "teamMembers", teamId: live.teamId })}><${Icon} n="users" s=${13} />Manage the team</button></div>`
        : html`<div class="share-solo">
              <i><${Icon} n="lock" s=${16} /></i>
              <div class="grow"><b>Only you can open this</b><span>Move it into a team to design in it together, live.</span></div>
            </div>
            <div class="share-foot">
              ${s.cloud?.teams?.length
                ? html`<button class="btn primary sm" onClick=${() => go({ kind: "moveToTeam", boardId: B.id, boardName: B.board?.name })}>Move to a team</button>`
                : html`<button class="btn primary sm" onClick=${() => go({ kind: "upgrade" })}>Start a team</button>`}
            </div>`}
    </div>
  <//>`;
}
