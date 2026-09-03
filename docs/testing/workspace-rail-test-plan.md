# Workspace rail — test plan

Covers the change set on `pr1-registry-durability` → `pr2-workspace-switch` →
`pr3-workspace-rail`: the persistent workspace rail, editable tab labels, the
no-re-check project switch with per-workspace view caches, and the registry
durability fix underneath them.

Unit and integration coverage already in the tree (`bun run test` — 298 client
+ 407 server tests) is not repeated here. This plan is the layer above it:
real `bd` data, real files, concurrency, scale, and the UI surfaces a unit
test cannot observe.

## Status — complete as of 2026-09-03

Every case ran. A1–A5 pass, B1–B6 and B8–B10 pass, and all five pre-PR gates
are green (C5 excepted: it is a no-op by configuration). One case fails, B7,
on a defect that reproduces byte-identically at the merge base and so is not
this change set's to block on.

Three defects surfaced, all of which existing unit coverage missed:

| found by | defect | disposition |
|---|---|---|
| A5 | keycap emoji (`1️⃣`) rejected as workspace icons, though the tab dialog promises to accept anything the OS picker produces | **fixed** + unit test |
| B10 | the rail never saw workspaces added from the dashboard until a `bd` poll happened to fire | **fixed** + unit test |
| B7 | a workspace whose `.beads` vanishes reads as an empty tree instead of an error, and `bd` silently recreates the database | **documented only** — pre-existing, own change |

## Environment

| Thing | Value |
|---|---|
| App under test | `bun run tauri:dev` (hub process `beadbox-demo`) |
| Manual fixtures | `~/beadbox-demo/demo-alpha`, `~/beadbox-demo/demo-beta` — real `bd init` workspaces |
| Automated fixtures | created per run under `/tmp`, with `BEADBOX_REGISTRY_PATH` pointed at a sandbox registry |
| Off limits to automation | `~/.beadbox/registry.json`, the two manual fixtures, the running app |

Automated cases drive the sidecar's handler modules directly
(`packages/server/src/handlers/*`) — the same code the app reaches over kkrpc
— with `BEADBOX_REGISTRY_PATH` isolating state.

## A. Automated (agent-driven)

Run 2026-09-03 against a throwaway harness that imports the handler modules
directly with `BEADBOX_REGISTRY_PATH` pointed at per-case sandboxes under
`/tmp`. All five cases pass; A5 found one real defect, now fixed.

| id | Case | Method | Result |
|---|---|---|---|
| A1 | Agent-driven bead churn is picked up | In a throwaway workspace: `bd create` / `bd close` / `bd delete` / `bd comment`, calling `getEpics` between each | **pass** — create/close/delete/comment each visible on the next `getEpics`; the deleted bead stayed absent; no stale fingerprint tree |
| A2 | Cross-process registry writes | Two OS processes concurrently running `setWorkspaceLabel`, `addWorkspaceByPath`, `setActiveWorkspaceAction`, `removeWorkspace` against one sandbox registry | **pass, gap quantified** — 36 sampled intermediate reads, 0 parse failures; two lost updates observed (one removal, one rename). PR1's serialization is per-process, so this measures the residual gap rather than asserting zero |
| A3 | Registry recovery drills | Unreadable file (chmod 000), truncated JSON, valid JSON with malformed entries, pre-created symlink at the tmp path, read-only directory | **pass** — 6/6 drills: ENOENT yields an empty registry; unreadable propagates (EACCES) instead of overwriting; unparseable content quarantined exactly once; symlinked tmp path refused with `EEXIST` and never followed; no `.tmp` survives a failure |
| A4 | Scale | 100-workspace registry; one workspace with ~500 beads over ~20 epics | **pass** — `getWorkspaces` 100 entries in 3.6ms with zero `bd` spawns (fake-`bd` log 0 bytes); `getEpics` 500 beads / 20 epics in 388ms, far under the 30s timeout; client LRU evicted at 7 inserts, capacity 6 |
| A5 | Label validation surface | `setWorkspaceLabel` fuzzed: emoji (ZWJ, VS16, skin tone, flags, keycaps), non-emoji text, RTL/bidi names, the 64-char boundary, `{}`, non-strings, unknown ids | **pass after fix** — 8 accepts / 10 rejects, every rejection `{ success: false }` without throwing and without touching the registry. Initially failed: keycap emoji were rejected (see below) |

### A3 note — the symlink drill needed fixing, not the code

The drill first reported FAIL. Cause was the harness, not the product: it
mocked `randomUUID` via `mock.module("crypto", …)`, which Bun does not apply
to a builtin, so `writeRegistry` kept its random tmp name and the
pre-created symlink never sat in the write path. Patching the real builtin
through `bun --preload` made the tmp name predictable and the drill passes
for the right reason: `EEXIST`, registry unchanged, symlink target never
created, no `.tmp` left behind.

### A5 defect — keycap emoji were rejected (fixed)

`SINGLE_EMOJI` in `handlers/workspaces.ts` required an
`\p{Extended_Pictographic}` base. A keycap is `1` + `U+FE0F` + `U+20E3`,
whose base is an ASCII digit, so `1️⃣` / `#️⃣` / `*️⃣` were rejected as "Icon
must be a single emoji." — while `workspace-tab-dialog.tsx` documents its
free-text field as accepting "anything the OS emoji picker produces", and
the macOS picker offers keycaps. Fixed with a dedicated keycap alternative
that still requires the enclosing `U+20E3`, so a bare `1` or `#` stays
rejected. Covered by a new unit test in `workspaces.unit.test.ts`.

## B. Manual (needs eyes on the app)

| id | Case | Steps | Status |
|---|---|---|---|
| B1 | Warm switch | alpha → beta → alpha → beta | **pass** — skeleton only on each project's first visit; one `bd epics` per switch |
| B2 | Switch storm | Click alpha/beta rapidly ~10 times | **pass** — no wrong-project tree, no stuck spinner, last click wins |
| B3 | Switch between routes | Beads → Activity → Beads → Activity | **pass** — after the feed + pipeline session caches (this case found that bug) |
| B4 | Remove the active workspace | Remove the active tab, then remove until none are left | **pass** — observed in the app: removing the active tab switches to the first remaining workspace; with only one left, removal lands on the dashboard. Registry side matches: `activeWorkspace` is cleared on removal (never a dangling id), the last removal leaves `{workspaces: [], activeWorkspace: null}`, and re-removing returns a clean `{success:false}` |
| B5 | Label round-trip | Rename + set an emoji; check rail / header / dashboard cards; restart | **pass** — confirmed in the app: rail, header and dashboard cards all agree immediately, and both fields survive a restart. Underneath: name + emoji land on the `getWorkspaces` card all three surfaces read, survive a fresh process re-reading the file, and `icon: null` clears without disturbing the name |
| B6 | Rail geometry | Drag to both clamps, release outside the window, collapse, restart | **pass** — confirmed in the app across all six checks: both clamps hold (180/420), releasing the pointer outside the window ends the drag cleanly, text selection returns after release with no stuck `col-resize` cursor, collapse gives the 56px icon-only rail and expands back to the dragged width, and both width and collapsed state survive a restart. Unmounting mid-drag also resets cleanly |
| B7 | Broken workspace | `mv ~/beadbox-demo/demo-alpha/.beads /tmp` with the app open, switch to it, switch back, restore | **FAIL — pre-existing defect, see below.** Automated on its own fixture (the demo workspaces are off limits): a vanished `.beads` yields a successful empty tree, never an error |
| B8 | Narrow window | Resize under 768px and back | **pass** — confirmed in the app: the rail disappears below the md breakpoint and returns on widening, with the active workspace unchanged |
| B9 | Server workspace | Add a Dolt server workspace; switch, rename, remove | **pass** — against a real `dolt sql-server`: `beads_b9` registered as mode `server` (prefix stripped to "b9"), switch set `activeWorkspace`, rename + emoji worked through the same handler as a local tab, and removal returned the `credentialKey` the client needs to purge the keychain. Keychain deletion itself is client-side, so that step needs the app |
| B10 | Add from the dashboard | Add a workspace on `/workspaces` while the rail is visible | **pass after fix** — the new tab appears in the rail immediately. This case was added after manual testing found it broken (see below) |

**Not coverable in this environment:** the Formulas route. Its tab is disabled
— `header.tsx` gates it on `isFeatureEnabled("enable-formulas")` — so
`formulas-view.tsx`, which this change set moved onto `useActiveWorkspace`,
cannot be exercised by hand here. It is compile- and unit-checked only, and it
has no session cache, so it will reload on every visit once enabled.

### B10 defect — the rail missed workspaces added from the dashboard (fixed)

Reported from manual testing: adding a workspace on `/workspaces` left the
rail unchanged, and the tab only appeared after opening a project and waiting.

A registry write raises no `bd` change signal, so the rail had exactly three
ways to learn anything: its mount fetch, the workspace cookie (which updates
only the active highlight, not the list), and `useSubscriptionChangeSignal` —
a `bd` poll. That poll is the "some time passes" in the report. The rail's own
add button worked because `workspace-rail-panel.tsx` called the controller's
`refresh()` in its own handler; the dashboard's handler updated only its own
cards, and the two components have no shared state.

Labels had already hit this exact wall and solved it with a propagation
channel (`lib/workspace-labels.ts`, whose header says as much). Membership
changes had no equivalent. The fix adds the sibling channel,
`lib/workspace-registry-events.ts`, published by every membership mutation:

- `add-workspace-dialog.tsx` — one wrapper around `onWorkspaceAdded` covers
  all three add paths (local folder, server databases, local→server replace).
- `init-workspace-dialog.tsx` — after a successful `bd init`.
- `unregisterWorkspace` in `lib/workspace-actions.ts` — covers removal from
  all three surfaces that offer it (dashboard, rail, beads view).

Both list-holding surfaces subscribe: the rail re-reads the registry, and
`workspaces-page.tsx` does too, which closes the mirror-image bug (adding or
removing from the rail while the dashboard is mounted left *its* cards stale).
The panel's own `refresh()` calls are gone — the channel is the single
mechanism, so no add path can be wired up while forgetting to announce.

Covered by `use-workspace-rail.test.tsx`: "re-reads the registry when another
surface announces a membership change".

### B7 defect — a vanished workspace reads as empty, and gets silently recreated

**Pre-existing, not from this change set:** the same probe run in a worktree
at the merge base `c60f455` produces byte-identical output, so this does not
block `pr3-workspace-rail`. Filed here because B7 is what found it.

With a registered local workspace whose `.beads` is moved away (external
move, unmounted drive, deleted directory):

| step | observed |
|---|---|
| healthy baseline | `getEpics` → success, 1 epic |
| `.beads` moved aside | absent on disk |
| `checkHealth` | **`ok: true`** — and it *recreated* `.beads` |
| `getEpics` | **success with 0 epics**, no error |
| `checkHealth` again | `ok: true` — the error path is now permanently unreachable |
| the user's real data | orphaned in the moved directory (`config.yaml`, `embeddeddolt`, `metadata.json`, `interactions.jsonl`) |

Root cause is `bd` materialising a fresh database when pointed at a missing
path, so any bd invocation resurrects an empty workspace. The consequences:

- The designed error path is dead for this case. `HealthError` already has
  `database_missing` → the "Database not found" screen with Remove / Choose
  recovery actions, and `classifyHealthError` maps bd's "no beads database"
  text to it — but bd never emits that text, because it creates the database
  instead.
- `startup-gate.tsx:123-130` deliberately skips re-checking an
  already-verified workspace, relying on "the page-level load error path" for
  a workspace that breaks mid-session. That fallback does not fire: the load
  path returns a successful empty tree.
- Recreation is self-concealing. Once the empty database exists,
  `databaseExists` reports the workspace as available, so nothing downstream
  can tell the data ever went missing.

A guard belongs at the single choke point — `bdExec` / `bdExecRaw` in
`lib/bd.ts`, which every read path funnels through, while `initWorkspace` and
`initServerScaffold` call `execFileAsync` directly and so would keep their
legitimate ability to create a workspace. Not fixed here: it reshapes the
health/bd error surface for every call path and wants its own change.

## C. Pre-PR gates

All run 2026-09-03 on `pr3-workspace-rail`, after the A5 keycap fix.

| id | Check | Command | Result |
|---|---|---|---|
| C1 | Lint | `bun run lint` | **pass** — exit 0, 0 errors. 122 warnings / 66 infos are repo-wide and pre-existing |
| C2 | Unit tests | `bun run test` | **pass** — 407 server + 297 client, 0 fail. Server is 407, not the 395 this plan first recorded: tests were added since, plus the new keycap case |
| C3 | Typecheck | `bun --cwd=packages/client run typecheck`, `bun --cwd=packages/server run typecheck` | **pass** — both clean |
| C4 | Complexity | `bash scripts/check-ccn-allowlist.sh --mode=full` | **pass for this branch** — 3 violations (`addWorkspaceByPath`, `FilterBar`, `BeadDetailPanel`), verified identical in a worktree at the merge base `c60f455`, so this change set adds none. The script still exits non-zero on them |
| C5 | e2e | `bun run test:e2e` | **not run** — no-op today: `playwright.config.ts:47` ignores every spec. Running `e2e/workspaces.spec.ts` and `e2e/workspace-lifecycle.spec.ts` for real needs the Dolt fixture from `e2e/global-setup.ts` |

**Why B4–B9 cannot be automated here.** The client throws
`RpcUnavailableError` without a Tauri runtime — `playwright.config.ts:38-39`
records this — so a plain Chromium against the Vite dev server on :5173
cannot reach the sidecar, and Tauri's macOS WKWebView is not
CDP-attachable. These six need the app window driven by hand.

## Known gaps, deliberately not closed here

- **Cross-process registry serialization.** `mutateRegistry`'s queue is
  per-process. Two Beadbox instances (or a second sidecar) can still lose an
  update; tmp-file + rename keeps the file parseable. Measured, not
  hypothetical: A2 lost two updates (one removal, one rename) across 36
  sampled reads with zero parse failures.
- **Two `databasePath` spellings.** `resolveBdDbPath` returns
  `<project>/.beads/beads.db` while `resolveLocalEntry` returns
  `<project>/.beads`. The view caches are keyed by workspace id to be immune,
  but the divergence itself is pre-existing and wants its own upstream fix.
- **Formulas route** has no session cache and is flag-gated off.
- **`docs/screenshot.png`** still shows the app without the rail.
