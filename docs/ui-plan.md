# UI plan: onboarding to editor

Branch `glassine-ui`. Written 2026-11-22 from a walk through every screen on a clean first run
(dark and light, 1440×900 and 1040-wide), plus Mobbin references. Nothing here is built yet.

Each item has an ID so we can accept, drop or reorder them. **Bug** means it is broken today;
the rest are design changes.

## What I looked at

Home (first run, with boards, search, menus), sign-in, new team, all five Settings tabs, both
import sheets, the editor (nothing selected; artboard, frame, text and picture selected; Assets;
Comments; Agent; zoom, export and layer menus; drawing a frame, typing text, adding a comment;
the colour picker), an empty board, light theme, and the smallest window the app allows.

References: sign-in with Google plus an email code on one screen
([Krea](https://mobbin.com/screens/383717b6-0cf8-4026-9b24-2296607d53dd),
[Asana](https://mobbin.com/screens/0072f3d2-f9e2-4a09-b9b5-ea0b63e24698)); file browsers
([Figma](https://mobbin.com/screens/41148519-a75e-4cd7-b8b2-726771086607),
[MagicPath](https://mobbin.com/screens/77bb103c-dca2-4181-b1b3-a60d7cd0f96b)); empty editors that
lead with the agent ([MagicPath](https://mobbin.com/screens/e7d8ce7d-d3bb-4c0b-b26e-00af76a3fc0d),
[Figma Make](https://mobbin.com/screens/18b4ef86-328d-4041-80d6-daa29f784ad9)); inviting a team
([Attio](https://mobbin.com/screens/173f6d04-cfff-40d4-9076-db180be6b725)); onboarding flows from
Figma, Framer, FLORA and Visual Electric.

## Phase 1: account gate and onboarding (new requirement)

Today the app opens straight on Home and signing in is optional. Sign-in is a small sheet that
shows a code and sends you to the browser; it also shows the server's address, and when it fails
it prints the raw URL in red with one button.

- **O1 Gate.** With no saved session the window shows only the welcome screen. No Home, no
  boards, no menus behind it. Signing out returns here.
- **O2 Welcome screen.** Full window, centred: the mark, the name, one line saying what Glassine
  is, "Continue with Google", then an email field with "Continue". Terms and privacy links under
  it. No server address.
- **O3 Email code in the app.** Type the email, get six boxes, paste or type the code, and you're
  in, without leaving the window. Resend with a countdown, "use a different email", clear
  messages for a wrong or expired code. The server already supports this.
- **O4 Google.** Opens the browser (Google does not allow sign-in inside an app window). The
  welcome screen shows "Finish in your browser" with a way to reopen the page or cancel. The
  code stays hidden unless it's needed.
- **O5 Failure states.** Offline, server unreachable, sign-in cancelled: one plain sentence and a
  retry, never a URL.
- **O6 After the first sign-in: three short steps, each skippable except the name.**
  1. Your name (filled in from Google when we have it).
  2. Team: join the teams you were invited to, or create one and invite by email, or skip.
  3. Agents: the agents found on this Mac, each ticked, or how to add one if there are none.
- **O7 Land on Home** with the three start tiles, signed in, account shown in the sidebar.
- **O8 Returning.** A saved session opens Home at once. If the server can't be reached, the app
  still opens and says it's offline (see question 2).
- **O9 Existing boards** on this Mac stay where they are and show as personal boards after
  sign-in.

## Phase 2: Home

- **H1** Sidebar account: one account row at the bottom (photo, name, menu with Settings and Sign
  out) replaces the two "Sign in" rows.
- **H2 Bug.** Agent rows in the sidebar look like buttons and do nothing. Clicking one should
  start a new board with that agent's chat open; the green dot gets a tooltip.
- **H3 Bug.** While searching, "Recents" stays highlighted. Nothing should be highlighted.
- **H4** Teams section once signed in: team rows, "New team", and an invite button on the team's
  page.
- **H5** Board grid: sort (last edited, name), grid or list, and who edited a team board.
- **H6** First run: the three start tiles sit alone in the top-left of an empty page. Centre them
  with a short heading, and keep them as a quiet row above the grid once boards exist.
- **H7** Card menu: add "Move to team" and "Show in Finder"; deleting offers Undo in the toast.
- **H8** Scratchpad stays in the sidebar and leaves the grid, so the grid is only your boards.

## Phase 3: the editor's first minute

The product is "design with agents", but a new board opens on a Design panel full of explanation
and the chat sits behind a second tab.

- **E1** An empty board opens with the Agent tab in front and the cursor in the prompt.
- **E2** The empty canvas shows four starts in the middle, as MagicPath does: ask an agent, draw
  a frame, import a website, import from Figma. They disappear with the first layer.
- **E3** Design panel with nothing selected: replace the paragraphs about tokens and agents with
  real controls (page name, canvas colour, the token list). Shortcuts move to one place (S4).
- **E4** Share button in the top bar: who is here, invite to the team, move the board to a team.
- **E5** Comments tab, empty: one sentence and a button that picks the comment tool.

## Phase 4: editor fixes

- **F1 Bug.** At the smallest window width the tool bar sits on top of undo and redo. The top bar
  needs a layout that gives way in order (board name shortens, Preview becomes an icon).
- **F2 Bug.** Light theme: white artboards are almost invisible on the canvas. Add a hairline and
  a soft shadow.
- **F3 Bug.** A picture that can't load is a blank white box. Show a "missing picture" tile with
  Replace.
- **F4** Layer menu is 22 rows in one column and lists ⇧A twice. Group it: Arrange, Wrap, Layout
  as submenus; cut it to about 12 rows.
- **F5** Every icon-only control in the Design panel gets a tooltip with its name and shortcut;
  check each field's tab order and that Escape always leaves a tool or popover.
- **F6** Zoom menu gains 50% and 200%.
- **F7** New layers get useful names ("Frame 1" is fine; pictures take their file name).

## Phase 5: Settings

- **S1 Bug.** The sheet changes height and jumps as you switch tabs. One fixed size.
- **S2 Bug.** The Agents tab still says "Screenshotter", and its agent picker stacks each logo
  above its name. Fix the name everywhere in the UI (five places) and lay the picker out in a row.
- **S3** Account tab: photo, name, email, teams, Sign out. The server address moves under an
  "Advanced" disclosure.
- **S4** Shortcuts: one complete list, reachable from Settings and from `?` in the editor.
- **S5** General: the engine's port and Node version move under "About"; the library path
  shortens with `~`.

## Phase 6: consistency pass

- **C1** One sheet style (title, spacing, button order: Cancel then the action) across sign-in,
  team, import and confirm sheets.
- **C2** Every empty and error state uses the same pattern: one sentence, one action.
- **C3** Check both themes and both window sizes for every screen above; keyboard focus rings on
  everything clickable.

## How I'll work

One item at a time, each with a check in `scripts/ui-test.ts`, a before and after picture, and
its own commit on `glassine-ui`. Order: Phase 1, then the bugs (H2, H3, F1–F3, S1, S2), then the
rest of Phases 2 to 6.

## Open questions

1. Email code typed inside the app, Google through the browser: is that the sign-in you want?
2. After the first sign-in, should the app open when there's no internet?
3. Onboarding length: the three short steps in O6, or sign in and go straight to Home?
4. Should a new, empty board open on the Agent tab (E1)?
