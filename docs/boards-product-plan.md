# Glassine: Boards as its own product

Status: agreed with Jeremiah, 2026-11-21. **Changed the same day:** no split and no second repo. Everything stays in this one, and the app itself became boards only (branch `glassine`): screenshots, App Store sets, video editing and recording are gone, and onboarding is new (import a website or a Figma file, connect an agent). The name stays Screenshotter until the rename is decided. Sections 1 and 3 onwards below still describe the original plan.

**Glassine** is the see-through paper you lay over something real to trace it: Paper's cousin, for
designing over your running app. No software uses the name (checked 2026-11-21); check the domain
and trademark before launch. The line: "Paper, free, and your agent never runs out of calls."

**Decided:** $16 per editor per month. What's free is open source; the team server is in a separate
private repo. First comes shipping the free app; teams follow.

## 0. Several agents on one board (checked, fixed)

Already safe: every change is applied under the board's file lock to the board as it is at that moment, so agents' changes interleave instead of overwriting each other. `npm run test:agents` proves it: six agents, each with its own MCP server, made 276 calls at once with nothing lost and no errors.

One fault was found and fixed (adad5bd): artboards two agents added at the same moment landed in the same spot. Their place is now found when the change lands.

## 1. The split: one codebase, two builds

| | Screenshotter (today) | Glassine |
|---|---|---|
| App | Studio: screenshots, App Store sets, video | Boards only |
| MCP tools | all | `board_*`, plus `capture_web`, `capture_screenshot` (simulator) and `capture_mac` (design from your running app) |
| Bundle, icon, update feed, site | current | new |
| Code | `src/board` (core, store, MCP, render) is shared | the same, plus `src/server` (teams) |

- **Repos:**
  - `glassine` is public and holds the free app: board core, renderer, MCP, captures and the desktop shell.
  - Screenshotter (private) uses it as a package for its boards.
  - `glassine-teams` (private) is the team server.
- **Licences:** the app is under AGPL-3.0, so its parts can't be lifted into a closed product. The file format and the MCP tool list are under MIT, so any tool can read and write boards.
- **The moat is the server, not the client:** the team UI can sit in the public app, because without the private server there's nothing to sync with.

## 2. Free and paid

| Free, for an individual, no limits | Team plan, per editor per month |
|---|---|
| Unlimited MCP calls (they run locally) | Team workspaces and roles |
| Several agents of your own on a board | Live editing together, and several people's agents on one board |
| Boards are files on your Mac | Comments and replies, by and to anyone |
| Captures from simulator, browser, Mac | Version history and restore (beyond local undo) |
| View-only share links | Shared components and tokens across a workspace's boards |
| Local background removal (Vision) | AI image generation and similar |

**Cost of free sharing:** a view link stores the board and its pictures on our server, the only thing the free plan costs us. Cap it, for example at 20 shared boards or 1 GB, and stay quiet about the cap until someone reaches it.

## 3. Account and clone flow

1. **Share:** "Share" uploads a read-only snapshot (the board JSON and its pictures) and returns a link. No account is needed to share for the first time; a device key is used instead. An account is asked for at the second share, or when a share is kept for more than 30 days.
2. **View:** the link opens a web viewer that draws the board with the same renderer. Pan, zoom and inspect layers and CSS; no comments.
3. **Clone:**
   - "Clone this board" asks you to sign in with Apple, GitHub or email.
   - It copies the board to your account, then opens it in the desktop app (via deep link), or offers the download.
   - The copy is independent. It keeps `copiedFrom { board, author, link }`, shown as "Copied from Maya's *Pricing page*" with a link back, which is the viral loop.
4. **Upgrade:** inviting a second editor, or turning on comments, is where the team plan starts.

## 4. What to build first for teams, in order

1. **Server, accounts and share links (on Pier).** A Node service in `src/server`, Postgres for accounts, workspaces and billing, S3-compatible storage for snapshots and pictures, and Stripe for per-editor billing. Free sharing needs it anyway, so it ships before any team feature.
2. **Workspaces and roles:** owner, admin, editor and viewer. A board belongs to you or to a workspace.
3. **Live sync.** Recommendation: **not Yjs**; a server that orders our existing operations.
   - Board changes are already small, per-property operations with undo, applied under a lock. The server becomes that lock: clients and agents send operations with the revision they're based on, and the server applies them with the same `applyOps`, assigns the next revision and broadcasts it.
   - This keeps one model on the Mac and the server, keeps undo, and is how Figma works.
   - Yjs would mean rewriting the board model as a CRDT. It only pays off for long offline editing or editing the same text at once, and neither is how boards are used.
   - **Local-first stays:** a team board is a local file plus a sync connection. The MCP writes locally and the app pushes the operations, so agents need no network code.
4. **Presence for people and agents across machines.** The cursors and Follow that exist today, extended to teammates. Comments move to the server, so they reach anyone.
5. **Version history:** the server keeps the operation log, from which come named versions, restore and "what changed since yesterday".
6. **Shared components and tokens:** a workspace library that boards link to; changes flow into copies as they do within a board today.

**What a teammate sees while someone's agent edits:**
- The agent is labelled with its owner, for example "Maya's Claude", in a shade of Maya's colour. Its changes build in as it writes, and its artboard is marked.
- Anyone can follow it or comment to it. A comment reaches the agent through its owner's Mac (via Agentman) when that Mac is online, and is held until then when it isn't.
- Only the owner can stop the agent.

## 5. Keeping people once Paper copies "free"

Both candidates fit together, and I'd lead with both:

- **Design from your real app.** Captures from the simulator, Safari and Mac windows land on the board as layers or pictures, and an agent can redesign a real screen. Neither Paper nor pen.dev does this.
- **Your boards are open files.** Open-source the file format, the renderer and the MCP server; keep the team server closed. This earns trust and contributors (Penpot's play) without giving away what's paid. Paper can drop its call limit overnight; it can't easily open its format.

The current README sells nothing. The new edition needs a one-screen pitch before anything else.

## Order of work

Teams need users first: there's no release and no user yet but you.

1. **Ship Glassine free.** About a week of work:
   - the public repo cut out of this one;
   - the Glassine shell (boards only);
   - name, icon and a one-screen site;
   - a notarised DMG with the MCP built in, and its update feed.
2. **Share links and clones**, the growth loop: the server on Pier, sign-in, the web viewer, and "Copied from".
3. **Teams:** workspaces, roles and Stripe at $16, live sync, presence across machines, history, then the shared library.
