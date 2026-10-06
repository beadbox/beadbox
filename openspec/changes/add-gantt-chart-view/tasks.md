# Tasks

## 1. Data plumbing: `closedAt` and a shared archived rule

- [x] 1.1 Map bd's `closed_at` to `Bead.closedAt` in the server bead conversion (`packages/server/src/lib/bd.ts`, next to `createdAt`/`updatedAt`), add `closedAt?: Date` to both `lib/types.ts` files, and verify that a server unit test turns a closed bd bead into a `Bead` with `closedAt` set (`bun run test:server`)
- [x] 1.2 Move `isArchived` from `home-page.tsx:51` to a shared client helper (e.g. `lib/epic-tree-utils.ts`) and import it in `home-page.tsx`. Verify that `bun run test:client` passes unchanged, including `archived-group.test.tsx`

## 2. Server: record `started_at`

- [x] 2.1 Add `updateMetadata(id, key, value, options)` to `lib/bd.ts`, built on `buildUpdateArgs(id, "--set-metadata", "<key>=<value>")`. Verify that `bd-exports-argv.security.test.ts` picks up the new export and passes, and that a unit test asserts the argv `["update", id, "--set-metadata=started_at=<iso>"]`
- [x] 2.2 Add a pure selector `beadsNeedingStartedAt(epics)`. It returns the beads whose status is not in {open, deferred, blocked, closed} and that have no `metadata.started_at`, walking `children`, `childEpics` and standalone beads. Verify with unit tests covering in_progress, a custom status, blocked, deferred, closed, an existing key, and nested epics
- [x] 2.3 In `handlers/epics.ts`, at the end of `buildEpicHierarchy` (which every load path goes through, unlike `fullRebuild`):
  - patch `metadata.started_at = updatedAt` into each selected bead in the returned result;
  - start the writes without awaiting them, one after another;
  - keep a per-database pending set;
  - log a failure once per bead per session, and never retry in a loop.

  Verify with a handler test using a fake `bd` on `BD_PATH`: the reply carries the patched value, one `--set-metadata` call is recorded per selected bead, a second rebuild with the key present records none, and a failing write does not fail `getEpics`
- [x] 2.4 Verify against a real bd workspace (integration or manual): `bd update X --status in_progress`, wait for the reload, then check that `bd show X --json` has `metadata.started_at` equal to the `updated_at` from right after the transition, and that a second reload doesn't change it

## 3. Gantt model (pure logic)

- [x] 3.1 Create `lib/gantt-model.ts` with `buildGanttModel(epics, blockedBy, filters, now)` returning sections (with depth), rows, extent and per-bar start/end/style. It should:
  - leave out archived beads using the shared `isArchived` from 1.2;
  - keep backlogged epics;
  - put standalone beads under "Ungrouped";
  - filter with `matchesBead`, hiding sections that have no matching descendant.

  Verify with vitest cases for nesting, archived subtrees, Ungrouped and filtering
- [x] 3.2 Add bar timing and style:
  - start = `metadata.started_at`, or `createdAt` if missing;
  - end = `closedAt` for closed beads, `now` otherwise;
  - style: hollow (open/deferred), hollow red (blocked), solid (other non-closed), done (closed).

  Verify with vitest cases for each, including blocked-after-start and a custom status
- [x] 3.3 Add summary bars (from the earliest start to the latest end of all descendants), and the epic's own bar when it has no visible descendants. Verify with vitest cases for a nested span and a childless epic
- [x] 3.4 Add the dependency split: an edge becomes an arrow when both ends are in the same section, otherwise a marker on the blocked bead naming the other bead (including when the other bead is hidden). A `degraded` blocks payload yields no edges and no markers, plus a flag. Verify with vitest cases for each

## 4. Chart view UI

- [x] 4.1 Add `routes/chart.tsx` → `ChartView`, using the same epic loading, blocks loading, live-update refresh and `usePreferences()` filter state as `home-page.tsx`. Render `FilterBar` without the sort control. Verify that `/chart` renders, and that a filter set on Beads shows up on Chart (component test)
- [x] 4.2 Build the layout: an HTML title column and an SVG timeline with fixed row height and shared vertical scroll, collapsible epic and child-epic headers with summary bars, and an "Ungrouped" section. Collapsed state is kept per session. Verify with a component test that collapsing hides the rows but keeps the summary bar
- [x] 4.3 Draw the bars in the four styles with theme-aware colors (light and dark), and markers whose tooltip names the other bead (connector routing is group 7). Show the existing degraded-dependencies notice when the flag is set. Verify with a component test of the rendered SVG classes, and by viewing it in `bun run tauri:dev` (confirmed by the user from a screenshot of the running app)
- [x] 4.4 Add the time axis and zoom: hours, days and weeks, plus an initial fit-to-width, with the zoom level kept for the session only. A 60 s timer advances `now` while the view is mounted. Verify with unit tests of the scale (fit covers the extent; changing zoom changes tick units) and a test that the timer is cleared on unmount
- [x] 4.5 Make titles clickable: `setStoredSelectedBead(id)` then `navigate({ to: "/" })`, as `activity-page.tsx:473` does. Verify with a component test that clicking stores the id and navigates to `/`

## 5. Navigation: Chart button and ⌘5

- [x] 5.1 Add the "Chart" button after Formulas in `components/header.tsx` (icon from lucide-react, active state on `/chart`, tooltip "Chart ⌘5"). Verify with a header component test that the button navigates and shows the active state
- [x] 5.2 Add ⌘5 → `/chart` to `lib/epic-navigation-keys.ts` `tryViewSwitchShortcut`, `activity-page.tsx:512` and `formulas-view.tsx:485`, and give `ChartView` a handler for ⌘1–⌘4 and ⌘5. Verify with unit tests of `tryViewSwitchShortcut` and of the Chart handler
- [x] 5.3 Add a view-switch key handler to `trains-page.tsx` (it has none today) that covers at least ⌘5 → `/chart`. Verify with a component test
- [x] 5.4 Add "⌘5 Chart" to the shortcut list in `settings-dialog.tsx`, and add Chart to the README Features list. Verify both read correctly

## 6. Release notes and end-to-end checks

- [x] 6.1 Add a release-notes entry for the next version under `release-notes/`, describing the Chart view and saying plainly that Beadbox now writes `started_at` metadata to beads that are in a started state. Verify that the entry follows the style of `release-notes/v0.27.2.md`
- [x] 6.2 End-to-end coverage, given that `playwright.config.ts` currently ignores every `*.spec.ts` until the suite is rewritten for Tauri:
  - add `e2e/chart.spec.ts` in the same ignored state as the other specs (⌘5 from Beads, Activity and Formulas; clicking a title opens it on Beads; closing a bead via the bd CLI turns its bar done without a reload), as input for that rewrite;
  - add component tests that ⌘5 opens Chart from the Activity and Formulas views.

  Verify that the new component tests pass, and in the running app (`bun run tauri:dev`) that closing a bead with `bd close` turns its bar to the done style without a reload

## 7. Dependency connectors

- [x] 7.1 Add `lib/gantt-routing.ts` with a pure `routeConnector` (design D11): it takes row geometry and the bars of every visible row and returns the path for one edge. It covers the gap path, the path along the gap between rows when the bars overlap in time, and a vertical run chosen to avoid bars in the rows between. Verify with unit tests that each path starts on the predecessor's end edge and ends on the dependent's start edge heading right, plus a test over many generated layouts that no segment enters any bar's rectangle
- [x] 7.2 Add lanes: connectors sharing a row boundary or a vertical x are offset so no two share a segment. Verify with unit tests on chained and fanned-out dependencies (like group 5 in the screenshot)
- [x] 7.3 Use the router in `components/gantt-chart.tsx`: a right-pointing arrowhead at the dependent's start edge, the foreground colour for connectors ending at hollow (not-started or blocked) bars, the muted colour otherwise. Update `chart-view.test.tsx` to assert where each path ends, its arrow direction and its colour class. Verify with a screenshot of the running app

## 8. Dependency-aware scheduling

- [x] 8.1 Add the dependency-aware schedule to `lib/gantt-model.ts` (design D12): one memoized pass over all loaded beads before filtering, using the full `blockedBy` map, with cycle guard and the degraded (null) case. Recorded start kept; finished and in-progress beads without one get min(close or now, max(created_at, latest blocker finish)); not-started beads get max(now, latest blocker finish) for (estimate or 60) minutes. Verify with unit tests, one per spec scenario: recorded start kept, finished without record, not started without blockers, one blocker, several blockers, chain, independent beads in parallel, planned length, blocker hidden by filters, cycle, degraded data
- [x] 8.2 Make the Chart draw the schedule: planned bars dotted (hollow red when blocked), the time range and summary bars including planned future time, and planned bars moving with `now`. Update `chart-view.test.tsx` so a blocked chain renders in order (each dependent's bar starts at or after its blocker's end). Verify with `bun test`
- [x] 8.3 Check in the running app: a screenshot shows chains in order and independent beads in parallel, and, as the rerun of 6.2's live-close check, a bead closed with `bd close` while the Chart is open turns to the done style without a reload

## 9. Final checks

- [x] 9.1 Run `bun run lint`, `bun run test` and `bun run test:integration`, and confirm all pass

  Result (9.1): lint exit 0 (no errors, the clean checkout's 135 warnings); client 477/477; server 752 pass, 10 fail; integration 4 pass, 4 fail. The 14 failures (serve-proxy-reap.test.ts; dolt-server-fixture and stale-port-file integration tests) fail identically on a clean checkout of HEAD 4913b56 and predate this change; follow-up: beadbox-9pj.
