# Proposal

## Why

Beadbox shows epics as a tree and dependencies as lists. Neither shows *when* work happened or how long it has been running and waiting. A Gantt view per epic answers "what is in flight, what is waiting, and what is blocking what" at a glance. beads does not record when work on a bead started, so Beadbox has to record that moment itself.

## What Changes

- A **Chart** button is added to the header nav next to Formulas, along with a `/chart` route and the **⌘5** shortcut.
- The Chart view shows one Gantt section per epic, nested and collapsible like the epic tree, with one row per child bead and a summary bar per epic. An epic with no children shows its own bar instead. Beads without an epic go in an **Ungrouped** section. Archived beads are not shown; backlogged epics are shown normally.
- Bead titles are listed on the left. Clicking a title switches to the Beads view with that bead open.
- Bars follow what happened and, from now on, the plan:
  - a bead with a recorded start (`metadata.started_at`) starts there and ends at `closed_at`, or at the current time while still open (bars keep growing);
  - a bead without a recorded start is scheduled after its blockers: it starts at the latest blocker's finish (but not before its creation, and not after its own close);
  - a not-started bead is drawn as its planned window, starting no earlier than now and lasting its estimate, or one hour without one, so dependency chains read in order and independent beads stay parallel.
  - Style shows state: hollow = not started (open or deferred), hollow red = blocked, solid = started, solid in the done color = closed.
- Dependencies from `blockedBy` / `blocks` are drawn as connectors from the end of the predecessor's bar to the start of the dependent's bar, routed through free space (the gaps between bars and between rows) and never over a bar, with a small arrowhead at the dependent. A dependency on a bead in another section is shown as a marker on the bar instead.
- The view reuses the Beads `FilterBar` and **the same saved filter state**, so a filter applies in both views.
- A time axis with zoom levels for hours, days and weeks. The initial view fits all bars.
- **Start-time recording (new write behavior):** when the server reloads the epic tree and finds a bead in a started status (any status other than open, deferred, blocked or closed) without `metadata.started_at`, it runs `bd update <id> --set-metadata started_at=<updated_at>`. It writes only when the key is missing, never overwrites it (a reopened bead keeps its first start), and never writes for closed beads.
- `closed_at` is passed through from bd to the client's `Bead` type.
- **Behavior change to note in release notes:** until now, Beadbox did not write to the beads database unless the user asked it to. It now writes `started_at` metadata on its own.

## Capabilities

### New Capabilities
- `gantt-chart`: the Chart view (navigation, layout, bar timing and style, dependencies, filtering, zoom, live updates) and the recording of `metadata.started_at` it relies on.

### Modified Capabilities
<!-- None: no existing specs in openspec/specs/. -->

## Impact

- **Client** (`packages/client`):
  - `components/header.tsx`: nav button.
  - New `routes/chart.tsx` and chart components (custom SVG; no new dependency).
  - The view-switch shortcut handlers (`lib/epic-navigation-keys.ts`, `activity-page`, `formulas-view`) learn ⌘5; `trains-page` gets a handler (it has none today).
  - `lib/types.ts`: `Bead.closedAt`.
  - Settings shortcut list.
- **Server** (`packages/server`):
  - `lib/bd.ts` maps `closed_at`.
  - The epic-tree handler (`handlers/epics.ts`) gains the `started_at` recording step, plus a metadata write helper.
- **Data:** Beadbox writes one metadata key per started bead to the user's beads database. Each write causes one extra live-update refresh. In embedded mode the write waits in the existing per-db write queue.
- **Dependencies:** none added.
