# Workspace rail — test plan

Covers the change set on `pr1-registry-durability` → `pr2-workspace-switch` →
`pr3-workspace-rail`: the persistent workspace rail, editable tab labels, the
no-re-check project switch with per-workspace view caches, and the registry
durability fix underneath them.

Unit and integration coverage already in the tree (`bun run test` — 297 client
+ 395 server tests) is not repeated here. This plan is the layer above it:
real `bd` data, real files, concurrency, scale, and the UI surfaces a unit
test cannot observe.

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

| id | Case | Method | Expected |
|---|---|---|---|
| A1 | Agent-driven bead churn is picked up | In a throwaway workspace: `bd create` / `bd close` / `bd delete` / `bd comment`, calling `getEpics` between each | Every mutation shows in the next `getEpics`; a deleted bead never comes back; the sidecar's fingerprint cache does not serve a stale tree |
| A2 | Cross-process registry writes | Two OS processes concurrently running `setWorkspaceLabel`, `addWorkspaceByPath`, `setActiveWorkspaceAction`, `removeWorkspace` against one sandbox registry | The file always parses; lost updates quantified. PR1's serialization is explicitly per-process, so this measures the residual gap rather than asserting zero |
| A3 | Registry recovery drills | Unreadable file (chmod 000), truncated JSON, valid JSON with malformed entries, pre-created symlink at the tmp path, read-only directory | ENOENT alone yields an empty registry; an unreadable file propagates instead of being overwritten; unparseable content is quarantined exactly once; a symlinked tmp path is refused (`flag: "wx"`); no `.tmp` file survives a failure |
| A4 | Scale | 100-workspace registry; one workspace with ~500 beads over ~20 epics | Workspace listing stays far under the 30s handler timeout and does not spawn `bd` per entry; `getEpics` timing recorded as a baseline; the client LRU holds at most 6 payloads per cache |
| A5 | Label validation surface | `setWorkspaceLabel` fuzzed: emoji (ZWJ, VS16, skin tone, flags, keycaps), non-emoji text, RTL/bidi names, the 64-char boundary, `{}`, non-strings, unknown ids | Only single emoji graphemes accepted; every rejection returns `{ success: false }` without throwing and without touching the registry |

## B. Manual (needs eyes on the app)

| id | Case | Steps | Status |
|---|---|---|---|
| B1 | Warm switch | alpha → beta → alpha → beta | **pass** — skeleton only on each project's first visit; one `bd epics` per switch |
| B2 | Switch storm | Click alpha/beta rapidly ~10 times | **pass** — no wrong-project tree, no stuck spinner, last click wins |
| B3 | Switch between routes | Beads → Activity → Beads → Activity | **pass** — after the feed + pipeline session caches (this case found that bug) |
| B4 | Remove the active workspace | Remove the active tab, then remove until none are left | pending — survivor promoted and loaded; last removal lands on the dashboard |
| B5 | Label round-trip | Rename + set an emoji; check rail / header / dashboard cards; restart | pending — all three agree immediately, both survive a restart |
| B6 | Rail geometry | Drag to both clamps, release outside the window, collapse, restart | pending — clamps at 180/420 and persists; no stuck cursor or text selection |
| B7 | Broken workspace | `mv ~/beadbox-demo/demo-alpha/.beads /tmp` with the app open, switch to it, switch back, restore | pending — error screen, not a silent empty tree |
| B8 | Narrow window | Resize under 768px and back | pending — rail disappears and returns, active workspace unchanged |
| B9 | Server workspace | Add a Dolt server workspace; switch, rename, remove | pending — `server://` tabs behave like local ones; credentials deleted on remove |

**Not coverable in this environment:** the Formulas route. Its tab is disabled
— `header.tsx` gates it on `isFeatureEnabled("enable-formulas")` — so
`formulas-view.tsx`, which this change set moved onto `useActiveWorkspace`,
cannot be exercised by hand here. It is compile- and unit-checked only, and it
has no session cache, so it will reload on every visit once enabled.

## C. Pre-PR gates

| id | Check | Command |
|---|---|---|
| C1 | Lint | `bun run lint` |
| C2 | Unit tests | `bun run test` |
| C3 | Typecheck | `bun --cwd=packages/client run typecheck`, `bun --cwd=packages/server run typecheck` |
| C4 | Complexity | `bash scripts/check-ccn-allowlist.sh --mode=full` — compare against a clean checkout: three violations pre-date this work |
| C5 | e2e | `bun run test:e2e` is a no-op today: `playwright.config.ts:47` ignores every spec. Running `e2e/workspaces.spec.ts` and `e2e/workspace-lifecycle.spec.ts` for real needs the Dolt fixture from `e2e/global-setup.ts` |

## Known gaps, deliberately not closed here

- **Cross-process registry serialization.** `mutateRegistry`'s queue is
  per-process. Two Beadbox instances (or a second sidecar) can still lose an
  update; tmp-file + rename keeps the file parseable. A2/A3 quantify it.
- **Two `databasePath` spellings.** `resolveBdDbPath` returns
  `<project>/.beads/beads.db` while `resolveLocalEntry` returns
  `<project>/.beads`. The view caches are keyed by workspace id to be immune,
  but the divergence itself is pre-existing and wants its own upstream fix.
- **Formulas route** has no session cache and is flag-gated off.
- **`docs/screenshot.png`** still shows the app without the rail.
