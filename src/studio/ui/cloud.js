// Accounts, teams and team boards: device sign-in in the browser, team creation & invitations,
// moving a local board into a team, and the Team boards browser on Home.
import { useEffect, useState } from "preact/hooks";
import { Seg, html } from "./controls.js";
import { Icon } from "./icons.js";
import { Avatar, TeamMark } from "./avatars.js";
import { openMenu } from "./menu.js";
import { S, api, confirmDialog, fail, fileUrl, native, set, toast, useStore, when } from "./store.js";
import { closeBoard, openTeamBoard, openTeamBoardResult } from "./board-state.js";
import { refreshBoards } from "./board-library.js";

export function openExternal(url) {
  if (!url) return;
  if (native) native.call("openURL", { url }).catch(() => window.open(url, "_blank", "noopener"));
  else window.open(url, "_blank", "noopener");
}

export async function refreshAccount() {
  try {
    const info = await api("/api/cloud/account");
    const cloud = {
      loaded: true,
      signedIn: Boolean(info.signedIn),
      serverUrl: info.serverUrl ?? "",
      user: info.user ?? null,
      teams: info.teams ?? [],
      offline: Boolean(info.offline),
      error: info.error ?? null,
    };
    const homeView =
      S.homeView !== "recents" && (!cloud.signedIn || !cloud.teams.some((t) => t.id === S.homeView))
        ? "recents"
        : S.homeView;
    set({ cloud, homeView });
    return cloud;
  } catch {
    set({ cloud: { ...S.cloud, loaded: true } });
    return S.cloud;
  }
}

export async function refreshTeamBoards(teamId) {
  if (!teamId) return null;
  try {
    const r = await api(`/api/cloud/teams/boards?team=${encodeURIComponent(teamId)}`);
    const boards = r.boards ?? [];
    set({ teamBoards: { ...S.teamBoards, [teamId]: boards } });
    return boards;
  } catch (e) {
    return S.teamBoards[teamId] ?? null;
  }
}

export async function signOutAccount() {
  try {
    await api("/api/cloud/signout", {});
    await native?.call("setCloudToken", { key: "" }).catch(() => undefined);
    if (S.boardId) closeBoard();
    set({
      cloud: { loaded: true, signedIn: false, serverUrl: S.cloud.serverUrl, user: null, teams: [], offline: false },
      homeView: "recents",
      teamBoards: {},
    });
    toast({ kind: "ok", title: "Signed out" });
  } catch (e) {
    fail(e, "Couldn't sign out");
  }
}

export async function newTeamBoard(team, name = "Untitled board") {
  try {
    const res = await api("/api/cloud/teams/boards/new", { teamId: team.id, teamName: team.name, name });
    openTeamBoardResult(res);
    refreshTeamBoards(team.id);
    return res;
  } catch (e) {
    fail(e, "Couldn't make a team board");
  }
}

// =============================================================================================
// Sign in modal (device code flow: approve in browser, app receives its own token)

export function SignInModal({ Sheet }) {
  const s = useStore();
  const [flow, setFlow] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [editServer, setEditServer] = useState(false);
  const [serverInput, setServerInput] = useState(s.cloud.serverUrl || "https://glassine.thesunset.live");

  const begin = async (url) => {
    setBusy(true);
    setErr("");
    try {
      const r = await api("/api/cloud/signin/start", url ? { serverUrl: url } : {});
      setFlow(r);
      if (r.verificationUrl) openExternal(r.verificationUrl);
    } catch (e) {
      setErr(e.message || "Couldn't reach the server.");
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    begin();
    return () => {
      api("/api/cloud/signin/cancel", {}).catch(() => undefined);
    };
  }, []);

  useEffect(() => {
    if (!flow || flow.status !== "pending") return;
    let alive = true;
    const t = setInterval(async () => {
      try {
        const r = await api("/api/cloud/signin/status?consume=1");
        if (!alive) return;
        setFlow(r);
        if (r.status === "approved") {
          clearInterval(t);
          if (r.token && native) await native.call("setCloudToken", { key: r.token }).catch(() => undefined);
          await refreshAccount();
          set({ modal: null });
          toast({ kind: "ok", title: "Signed in", text: r.user?.email || "" });
        } else if (r.status === "denied" || r.status === "expired" || r.status === "error") {
          clearInterval(t);
          setErr(r.error || "Sign-in didn't finish.");
        }
      } catch {}
    }, 1200);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [flow?.status, flow?.userCode]);

  return html`<${Sheet} title="Sign in" width=${420}>
    ${flow?.displayCode && flow.status === "pending"
      ? html`<div class="cloud-signin">
          <div class="note">Approve this code in your browser to sign ${s.opts?.appName ?? "Glassine"} in:</div>
          <div class="cloud-code" title="Sign-in code">${flow.displayCode}</div>
          <div class="cloud-wait"><span class="spinner"></span>Waiting for approval in your browser…</div>
          <div class="hstack" style=${{ justifyContent: "center", gap: "8px", marginTop: "8px" }}>
            <button class="btn primary sm" onClick=${() => openExternal(flow.verificationUrl)}>Open browser again</button>
            <button class="btn ghost sm" onClick=${() => navigator.clipboard?.writeText?.(flow.verificationUrl).then(() => toast({ kind: "ok", title: "Link copied" }))}>Copy link</button>
          </div>
        </div>`
      : busy
        ? html`<div class="cloud-signin"><span class="spinner"></span><div class="note">Connecting to ${serverInput}…</div></div>`
        : html`<div class="cloud-signin">
            ${err && html`<div class="cloud-err">${err}</div>`}
            <button class="btn primary" onClick=${() => begin(editServer ? serverInput : undefined)}>Try again</button>
          </div>`}
    <div class="cloud-server-box">
      ${editServer
        ? html`<div class="row"><label>Server</label><div class="hstack">
            <input class="input grow mono" value=${serverInput} spellcheck=${false} onInput=${(e) => setServerInput(e.target.value)} onKeyDown=${(e) => e.stopPropagation()} />
            <button class="btn sm" disabled=${busy || !serverInput.trim()} onClick=${() => begin(serverInput.trim())}>Use</button>
          </div></div>`
        : html`<button class="btn ghost sm" onClick=${() => setEditServer(true)}>Server: <span class="mono">${flow?.serverUrl || serverInput}</span></button>`}
    </div>
  <//>`;
}

// =============================================================================================
// Create team modal

export function CreateTeamModal({ Sheet }) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (e) => {
    e.preventDefault();
    const clean = name.trim();
    if (!clean || busy) return;
    setBusy(true);
    try {
      const team = await api("/api/cloud/teams/create", { name: clean });
      await refreshAccount();
      set({ homeView: team.id, modal: null });
      toast({ kind: "ok", title: `Created ${team.name}` });
    } catch (err) {
      fail(err, "Couldn't create the team");
    } finally {
      setBusy(false);
    }
  };
  return html`<${Sheet} title="New team" width=${400}>
    <form onSubmit=${submit}>
      <div class="row">
        <label>Team name</label>
        <input class="input" autoFocus placeholder="Design Studio" value=${name} onInput=${(e) => setName(e.target.value)} onKeyDown=${(e) => e.stopPropagation()} />
      </div>
      <div class="note" style=${{ marginTop: "8px" }}>Everyone in the team sees its boards and can edit them together, live.</div>
      <div class="hstack" style=${{ justifyContent: "flex-end", gap: "8px", marginTop: "16px" }}>
        <button type="button" class="btn" onClick=${() => set({ modal: null })}>Cancel</button>
        <button type="submit" class="btn primary" disabled=${!name.trim() || busy}>${busy ? "Creating…" : "Create team"}</button>
      </div>
    </form>
  <//>`;
}

// =============================================================================================
// Team members & invitations modal

export function TeamMembersModal({ Sheet }) {
  const s = useStore();
  const teamId = s.modal?.teamId;
  const team = s.cloud.teams.find((t) => t.id === teamId);
  const [details, setDetails] = useState(null);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("member");
  const [busy, setBusy] = useState(false);

  const load = () => {
    if (!teamId) return;
    api(`/api/cloud/teams/details?team=${encodeURIComponent(teamId)}`)
      .then(setDetails)
      .catch((e) => fail(e, "Couldn't load the team"));
  };
  useEffect(load, [teamId]);

  const canInvite = !team || team.role === "owner" || team.role === "admin";
  const invite = async (e) => {
    e.preventDefault();
    if (!email.trim() || busy) return;
    setBusy(true);
    try {
      await api("/api/cloud/teams/invite", { teamId, email: email.trim(), role });
      setEmail("");
      toast({ kind: "ok", title: "Invitation sent", text: email.trim() });
      load();
    } catch (err) {
      fail(err, "Couldn't send the invitation");
    } finally {
      setBusy(false);
    }
  };

  const cancelInv = async (id) => {
    try {
      await api("/api/cloud/teams/cancel-invite", { invitationId: id });
      load();
    } catch (err) {
      fail(err, "Couldn't cancel invitation");
    }
  };

  return html`<${Sheet} title=${team?.name || details?.name || "Team"} width=${460}>
    ${canInvite &&
    html`<form class="card" onSubmit=${invite}>
      <h4><${Icon} n="users" s=${15} />Invite someone</h4>
      <div class="hstack" style=${{ gap: "8px" }}>
        <input class="input grow" type="email" placeholder="teammate@company.com" value=${email} onInput=${(e) => setEmail(e.target.value)} onKeyDown=${(e) => e.stopPropagation()} />
        <${Seg} value=${role} options=${[{ value: "member", label: "Member" }, { value: "admin", label: "Admin" }]} onChange=${setRole} />
        <button class="btn primary sm" type="submit" disabled=${!email.trim() || busy}>${busy ? "Sending…" : "Invite"}</button>
      </div>
      <div class="note">They'll get an email with a link to join this team.</div>
    </form>`}
    <div class="card">
      <h4>Members ${details ? `(${details.members.length})` : ""}</h4>
      ${!details
        ? html`<div class="note">Loading…</div>`
        : html`<div class="cloud-list">${details.members.map(
            (m) => html`<div class="cloud-member" key=${m.id}>
              <${Avatar} user=${m.user} />
              <div class="cloud-member-info"><b>${m.user?.name || m.user?.email}</b><span>${m.user?.email}</span></div>
              <span class="cloud-role">${m.role}</span>
            </div>`,
          )}</div>`}
    </div>
    ${details?.invitations?.length > 0 &&
    html`<div class="card">
      <h4>Pending invitations</h4>
      <div class="cloud-list">${details.invitations.map(
        (inv) => html`<div class="cloud-member" key=${inv.id}>
          <span class="cloud-av dim">@</span>
          <div class="cloud-member-info"><b>${inv.email}</b><span>${inv.role} · pending</span></div>
          ${canInvite && html`<button class="btn ghost sm" onClick=${() => cancelInv(inv.id)}>Cancel</button>`}
        </div>`,
      )}</div>
    </div>`}
  <//>`;
}

// =============================================================================================
// Move local board to a team modal

export function MoveToTeamModal({ Sheet }) {
  const s = useStore();
  const { boardId, boardName } = s.modal ?? {};
  const teams = s.cloud.teams ?? [];
  const [teamId, setTeamId] = useState(teams[0]?.id ?? "");
  const [busy, setBusy] = useState(false);

  const move = async () => {
    const team = teams.find((t) => t.id === teamId);
    if (!team || !boardId || busy) return;
    setBusy(true);
    try {
      const res = await api("/api/cloud/boards/move", { id: boardId, teamId: team.id, teamName: team.name });
      set({ modal: null, homeView: team.id });
      openTeamBoardResult(res);
      refreshBoards();
      refreshTeamBoards(team.id);
      toast({ kind: "ok", title: `Moved to ${team.name}`, text: "Everyone in the team can now open and edit this board live." });
    } catch (e) {
      fail(e, "Couldn't move the board");
    } finally {
      setBusy(false);
    }
  };

  return html`<${Sheet} title="Move to a team" width=${420}>
    ${!teams.length
      ? html`<div class="note">You aren't in any team yet. Create a team first to share boards and edit live.</div>
          <div class="hstack" style=${{ justifyContent: "flex-end", gap: "8px", marginTop: "16px" }}>
            <button class="btn" onClick=${() => set({ modal: null })}>Cancel</button>
            <button class="btn primary" onClick=${() => set({ modal: { kind: "createTeam" } })}>Create a team</button>
          </div>`
      : html`<div class="note" style=${{ marginBottom: "12px" }}>Move <b>${boardName || "this board"}</b> and its pictures into a team so teammates can edit it live.</div>
          <div class="cloud-team-pick">${teams.map(
            (t) => html`<button key=${t.id} type="button" class="cloud-team-opt ${teamId === t.id ? "on" : ""}" onClick=${() => setTeamId(t.id)}>
              <${Icon} n="users" s=${15} />
              <span class="grow"><b>${t.name}</b></span>
              <span class="cloud-role">${t.role}</span>
            </button>`,
          )}</div>
          <div class="hstack" style=${{ justifyContent: "flex-end", gap: "8px", marginTop: "16px" }}>
            <button class="btn" onClick=${() => set({ modal: null })}>Cancel</button>
            <button class="btn primary" disabled=${!teamId || busy} onClick=${move}>${busy ? html`<span class="spinner"></span>Moving…` : "Move to team"}</button>
          </div>`}
  <//>`;
}

// =============================================================================================
// Team boards grid on Home

const matches = (b, q) => !q.trim() || b.name.toLowerCase().includes(q.trim().toLowerCase());

export function TeamBoardsGrid({ team, q }) {
  const s = useStore();
  const boards = s.teamBoards[team.id];
  const [renaming, setRenaming] = useState(null);

  useEffect(() => {
    refreshTeamBoards(team.id);
    const t = setInterval(() => document.visibilityState === "visible" && refreshTeamBoards(team.id), 5000);
    return () => clearInterval(t);
  }, [team.id]);

  if (!boards) return html`<div class="sp-empty"><span class="spinner"></span></div>`;
  if (!boards.length)
    return html`<div class="sp-empty big">
      <div class="art"><${Icon} n="users" s=${24} /></div>
      <b>No boards in ${team.name} yet</b>
      <span>Start a new team board, or move any board from Recents into ${team.name} from its menu to edit together live.</span>
      <button class="btn primary sm" onClick=${() => newTeamBoard(team)}><${Icon} n="plus" s=${13} w=${2.2} />New team board</button>
    </div>`;

  const list = boards.filter((b) => matches(b, q));
  if (!list.length) return html`<div class="sp-empty"><${Icon} n="search" s=${22} /><b>No boards match “${q.trim()}”</b></div>`;

  return html`<div class="sp-grid">${list.map(
    (b) => html`<${TeamBoardCard} key=${b.id} b=${b} team=${team} renaming=${renaming === b.id} onRename=${setRenaming} />`,
  )}</div>`;
}

/** Every team's boards as one list, newest first, each card tagged with its team: "Shared with you". */
export function SharedBoardsGrid({ teams, q }) {
  const s = useStore();
  const [renaming, setRenaming] = useState(null);
  const all = teams
    .flatMap((t) => (s.teamBoards[t.id] ?? []).map((b) => ({ b, team: t })))
    .sort((x, y) => String(y.b.updatedAt ?? "").localeCompare(String(x.b.updatedAt ?? "")));
  const list = all.filter(({ b }) => matches(b, q));
  if (!list.length) return html`<div class="sp-empty"><${Icon} n="search" s=${22} /><b>No boards match “${q.trim()}”</b></div>`;
  return html`<div class="sp-grid">${list.map(
    ({ b, team }) => html`<${TeamBoardCard} key=${b.id} b=${b} team=${team} tag renaming=${renaming === b.id} onRename=${setRenaming} />`,
  )}</div>`;
}

/** `tag`: say which team the board is in (on a page that mixes teams), at the bottom right of its picture. */
function TeamBoardCard({ b, team, renaming, onRename, tag = false }) {
  const [loaded, setLoaded] = useState(false);
  const [tall, setTall] = useState(false);

  const open = () => openTeamBoard(b.id, team.name);
  const rename = async (name) => {
    if (!name || name === b.name) return;
    try {
      await api("/api/cloud/boards/rename", { id: b.id, name });
      await refreshTeamBoards(team.id);
    } catch (e) {
      fail(e, "Couldn't rename");
    }
  };
  const remove = async () => {
    const ok = await confirmDialog({
      title: `Delete “${b.name}”?`,
      text: `This removes the board for everyone in ${team.name}.`,
      confirm: "Delete",
      danger: true,
    });
    if (!ok) return;
    try {
      await api("/api/cloud/boards/delete", { id: b.id });
      await refreshTeamBoards(team.id);
      refreshBoards();
    } catch (e) {
      fail(e, "Couldn't delete");
    }
  };
  const more = (e) => {
    e.stopPropagation();
    const r = e.currentTarget.getBoundingClientRect();
    openMenu(r.left, r.bottom + 4, [
      { label: "Open", icon: "right", run: open },
      { label: "Rename", icon: "text", run: () => onRename(b.id) },
      "-",
      { label: "Delete", icon: "trash", danger: true, run: remove },
    ]);
  };

  return html`<div class="sp-card bd-card" data-board=${b.id} tabindex="0" role="button" aria-label=${b.name}
      onClick=${() => !renaming && open()} onKeyDown=${(e) => e.key === "Enter" && open()}
      onContextMenu=${(e) => (e.preventDefault(), more(e))}>
    <div class="sp-thumb">
      ${b.thumb
        ? html`<img class=${`${loaded ? "in" : ""} ${tall ? "tall" : ""}`} src=${fileUrl(b.thumb, Math.round(b.thumbAt ?? 0))} alt=""
            onLoad=${(e) => {
              setLoaded(true);
              setTall(e.target.naturalHeight / e.target.naturalWidth > 2.4);
            }} />`
        : html`<span class="bd-thumb-empty"><${Icon} n="users" s=${22} /></span>`}
      ${tag && html`<span class="sp-team-tag" title=${`In ${team.name}`}><${TeamMark} team=${team} /><span>${team.name}</span></span>`}
    </div>
    <div class="sp-info">
      <div class="sp-text">
        ${renaming
          ? html`<input class="input sm" value=${b.name} autoFocus onClick=${(e) => e.stopPropagation()}
              onKeyDown=${(e) => {
                e.stopPropagation();
                if (e.key === "Escape") onRename(null);
                if (e.key === "Enter") e.target.blur();
              }}
              onBlur=${(e) => rename(e.target.value.trim()).then(() => onRename(null))} />`
          : html`<b title=${b.name}>${b.name}</b>`}
        ${tag && html`<span class="sp-team-tag inline"><${TeamMark} team=${team} /><span>${team.name}</span></span>`}
        <span class="sp-meta"><span>Rev ${b.rev}</span><span>Edited ${when(b.updatedAt)}</span></span>
      </div>
      <button class="sp-more" title="More" onClick=${more}><${Icon} n="dots" s=${16} /></button>
    </div>
  </div>`;
}
