# Design

## Context

See proposal.md for the motivation and specs/gantt-chart/spec.md for the required behavior. These are the existing constraints that shape the approach:

- **Data is already on the client.** `epics.getEpics` / `incrementalRefresh` (`packages/server/src/handlers/epics.ts`) return the full epic hierarchy (`Epic.children`, `Epic.childEpics`, loose beads under `_standalone`). Blocking edges come separately from `getBlocksDependencies`, which loads later and can report `degraded`.
- **Live updates say nothing about which bead changed.** `lib/change-detector.ts` compares table hashes and emits "changed". Every change leads to a full rebuild of the epic tree (`fullRebuild`). So the only place where the server sees every bead after a change is that rebuild.
- **No start time in bd.** bd's issue JSON has `created_at`, `updated_at` and `closed_at`. `closed_at` is not yet mapped into `Bead`. Metadata can be written with `bd update <id> --set-metadata k=v`.
- **Bead selection is session state, not a URL.** `use-epic-navigation.ts` keeps `beadIdParam` in state backed by session storage. The Activity view opens a bead by calling `setStoredSelectedBead(id)` and then `navigate({ to: "/" })` (`activity-page.tsx:473`).
- **Each view handles the tab shortcuts itself.** The ⌘1–⌘4 handlers live separately in each page (`activity-page.tsx:512`, `formulas-view.tsx:485`, home-page, trains-page).
- **Filters live in `usePreferences()`** (localStorage), and `matchesBead(bead, filters)` already applies them on the Beads view.

## Goals / Non-Goals

**Goals:**
- Build the chart purely from data the client already holds. No new RPC for reading.
- One server-side write path for `started_at`, idempotent and safe with several Beadbox instances.
- Keep rendering fast for workspaces with hundreds of visible beads.

**Non-Goals:**
- Resource levelling or calendars: the plan only follows dependencies (D12). `dueAt` and `deferUntil` are not used for bar placement; `estimatedMinutes` only sets the length of a planned bar.
- Editing from the chart (dragging bars, creating dependencies).
- Backfilling `started_at` from Dolt history or the events journal.
- Showing a bead's detail inside the Chart view itself.

## Decisions

### D1: Separate route, sharing the data hooks with Beads
Add `routes/chart.tsx` → `ChartView`. It gets epics, blocks and filter state through the same hooks the home page uses (`usePreferences`, the epic query and the blocks query). It does not mount `HomePage`.
*Alternative:* a fourth mode inside `HomePage`. Rejected: `home-page.tsx` is already over 1300 lines and tied to the tree/table layout.

### D2: Turn the data into rows first, then draw
A pure function `buildGanttModel(epics, blockedBy, filters, now)` → `{ sections, rows, edges, markers, extent }`. It handles:
- the hierarchy: epic sections, child-epic subsections and the "Ungrouped" section (from `_standalone`);
- leaving out archived beads: anything with the `archived` label, and the whole subtree under an archived epic. This is the same `isArchived` rule as `home-page.tsx:51`; move it to a shared helper rather than copying it. Backlogged epics are kept as normal sections;
- bar start and end (the dependency-aware schedule, D12), and style from status (hollow: open/deferred; hollow red: blocked; solid: other non-closed; done color: closed);
- summary bars, or the epic's own bar when it has no visible descendants;
- which dependencies become same-section arrows and which become markers.

The function is easy to unit-test with vitest and keeps the SVG components simple.
*Alternative:* compute while rendering. Rejected: harder to test, and the arrow/marker split needs the whole row map anyway.

### D3: Custom SVG, rows lined up with an HTML title column
The title column on the left is HTML: links, truncation and keyboard focus are simpler that way. The timeline on the right is one SVG with the same fixed row height, scrolled horizontally inside its own container and vertically together with the titles. Dependency connectors are routed as described in D11.
*Alternatives:* `@xyflow/react` + elkjs (already installed) is a graph layout tool with no time axis, and a Gantt library would add a new dependency, which the user ruled out.

### D4: Time scale and zoom
A linear scale from the extent `[min start, now or max end]` to pixels. The zoom levels hours, days and weeks set pixels per unit and the tick intervals. "Fit" (the initial state) picks the pixels per millisecond so the extent fills the visible width, then labels ticks using the nearest zoom level. The selected zoom level is kept for the session only (confirmed).

### D5: Bars that grow
(Confirmed.) A single client timer (about every 60 s, and only while the Chart view is mounted) updates `now` for the model. Running bars grow with it, and planned bars (D12), which start no earlier than now, move with it. That is enough at day and week zoom and cheap at hour zoom. No server involvement.

### D6: Clicking a title reuses the Activity view's pattern
(Confirmed.) `setStoredSelectedBead(id)` followed by `navigate({ to: "/" })`, so the Beads view opens with the detail panel showing that bead.
*Alternative:* add a URL search parameter for the bead. Rejected for this change: it would mean changing how bead selection works in general, which is a separate refactor.

### D7: Shared filters
`ChartView` renders `FilterBar` with `prefs.filters` / `prefs.setFilters` and filters rows with the existing `matchesBead`. Archived beads are removed before filtering (see D2), regardless of filter state. Epic sections with no matching rows are hidden; a section stays visible if it has any matching descendant. Sort options do not apply to the chart (rows follow the tree order), so the sort control is left out (confirmed).

### D8: `started_at` recording happens in the epic tree build, on the server
At the end of `buildEpicHierarchy`, before the tree is cached, walk the beads and collect those where:
- `status ∉ {open, deferred, blocked, closed}`, and
- `metadata.started_at` is missing.

For each, run `bd update <id> --set-metadata started_at=<bd updated_at, ISO>`. The written value is also patched into the beads being returned, so the current reply is already correct. Rules:
- The writes happen *after* the epics reply has been prepared and are not awaited by it: a slow or failing write never delays or breaks loading the tree.
- The value is always bd's `updated_at` from the moment of observation. If the status change was the last edit, that is the exact transition time, whether Beadbox was running at the time or not.
- Never overwritten: a reopened and restarted bead keeps its first `started_at` (confirmed).
- Idempotent: the key is only written when missing. Two Beadbox instances can both write, but they write the same `updated_at` value, so the result is the same.
- A per-database in-memory "pending" set avoids sending the same write twice while the first is still running.
- Writes go through the existing bd write path, so embedded-mode locking and server-mode connection handling apply unchanged.
- The hook is in `buildEpicHierarchy` rather than `fullRebuild`: the first load (`getEpics` → `getEpicsCore`) and the prefetch never go through `fullRebuild`, while every path builds the tree here. The write helper is `updateMetadata(id, key, value)` in `lib/bd.ts`, named like the other `update*` helpers.

*Alternatives:*
- Stamp in `updateBeadStatus`: misses CLI and agent transitions.
- Stamp in the change detector: it does not know which bead changed.
- Stamp on the client: it would need a write RPC for every client and would fire once per open window.

### D9: Missing dependency data
If `getBlocksDependencies` reports `degraded`, the chart draws bars without arrows or markers and shows the same notice the Beads view uses. A missing edge is not treated as "no dependency".

### D10: ⌘5
Add `"5"` → `/chart` to each view's tab shortcut handler and to the Settings shortcut list. The Activity view's plain `5` (filter by pipeline stage, without ⌘) is unaffected.

### D11: Dependency connector routing
A pure function `routeConnector` in `lib/gantt-routing.ts` turns one edge into SVG path points, given the row geometry (fixed row height; each bar is vertically centred, so the boundary between two rows never holds a bar) and the bars of every visible row. The connector always leaves the predecessor's end edge and ends on the dependent's start edge, so it never runs over either bar:
- **Gap path.** When the dependent starts far enough after the predecessor ends, and the vertical run at some x between them is free in every row in between: end edge → horizontal → vertical → horizontal → start edge.
- **Path along the gap between rows.** Otherwise: a short stub to the right of the predecessor's end, a vertical drop to the boundary between rows beside it, a horizontal run along that boundary to a free x, a vertical run to the boundary beside the dependent, a horizontal run to just left of the dependent's start, then a short stub into its start edge.
- **Choosing the vertical x.** The candidates are the two stub positions and "just past" the start and end of every bar in the rows between. Pick the shortest path whose vertical run crosses no bar in those rows. A position left of every bar involved always exists, so a route is always found.
- **Lanes.** Connectors that would share a row boundary or a vertical x are offset by about 3 px each, so no two connectors share a segment.
- **Arrowhead.** It points right, with its tip on the dependent's start edge.
- **Colour.** The foreground colour (white in dark mode, near-black in light mode) when the dependent is hollow (not started or blocked); the muted colour otherwise.

*Alternatives:*
- Obstacle-aware routing through a graph layout library (`elkjs` is installed): rejected, since it has no time axis and the drawing stays custom SVG.
- Falling back to markers when the bars overlap in time: rejected by the user in favour of routing.

### D12: Dependency-aware schedule
Bar times come from one pass over all loaded beads inside `buildGanttModel`. The pass runs before filtering, so blockers hidden by filters still count. It uses the full `blockedBy` map and memoizes each bead's bar as it is computed. For a bead with blocker finishes F (empty set → no constraint), `latest = max(F)`:
- **Recorded start** (`metadata.started_at`): start = started_at; end = closed_at, or now while not closed. Blockers are ignored, because what happened wins.
- **No recorded start, closed:** start = min(closed_at, max(created_at, latest)); end = closed_at.
- **No recorded start, started but not closed** (for example, the `started_at` write failed): start = min(now, max(created_at, latest)); end = now.
- **Not started** (open, deferred, blocked): start = max(now, latest); end = start + (estimatedMinutes or 60) minutes. These are planned windows.

A blocker's finish is the end of its own computed bar. Blockers missing from the tree (archived, not loaded) are skipped. A bead still being computed when it is reached again (a cycle) contributes no constraint, which breaks the cycle at that edge. When `blockedBy` is null (degraded), every bead is computed with no blockers.
*Alternatives:*
- Keep "created_at → now" for not-started beads: rejected by the user, because it draws impossible orders.
- A separate planned layer next to the waiting bar: rejected as too busy.

## Risks / Trade-offs

- [Beadbox now writes on its own, which breaks the v0.27.2 "nothing is rewritten" stance] → Only one metadata key is written, and only when missing. State it in the release notes.
- [Each write causes one extra change event and a full rebuild] → It converges after one round: on the next rebuild the key is present, so nothing more is written. When many beads are stamped at once (first launch on an old workspace), the writes are sequential. The change detector limits the resulting reloads: server mode checks every 5 s (`POLL_INTERVAL_MS`) and embedded mode waits 2 s after the last change (`EMBEDDED_DEBOUNCE_MS`). So a batch causes a few reloads, not one per bead.
- [`updated_at` is too late if the bead was edited after starting but before Beadbox saw it] → Accepted approximation; the error is bounded by the time Beadbox was closed.
- [First launch stamps every bead that is already in progress with its current `updated_at`] → Expected; those beads have no better source.
- [A failing write, e.g. read-only replica or permissions] → Log once per bead per session and fall back to `created_at` on screen. Never retry in a loop.
- [Large workspaces: hundreds of rows and arrows in one SVG] → Collapsed sections draw only their summary bar. If profiling shows a problem, draw only the visible rows (the row height is fixed, so this is straightforward).
- [The per-view shortcut handlers fall out of sync] → Add ⌘5 to all of them in one task; an e2e check covers each view.

- [A bead closed before its blocker finished (work done out of order, or a forced close) still ends at its real close time, so its bar can end before its blocker's] → Accepted: recorded facts win over the plan. Its connector still routes cleanly (D11).
- [A finished bead's calculated start is an estimate, not a record] → Only beads without `started_at` get one; beads Beadbox saw starting keep their recorded start.

## Migration Plan

No data migration. Beads without `started_at` simply use `created_at` until Beadbox sees them started. Rollback: remove the route and the write step. Any `started_at` keys already written stay behind as harmless metadata.
