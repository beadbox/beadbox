# All projects

The virtual **All projects** tab opens `/all-projects`. It does not change the
active workspace cookie or create a registry entry. Individual project tabs keep
the existing health check and subscription lifecycle.

The aggregate view reads the registry and schedules at most two source reads at
a time. `aggregate.readWorkspace` resolves each workspace UUID against the current
registry, deduplicates concurrent reads, and also enforces a two-source limit on
the server. It uses the existing `bd` wrapper and epic hierarchy builder, including
embedded Dolt support. There is no merged database, export, or persistent task copy.

Rows and selection use `[workspaceId, beadId]` keys. Details, comments, edits and
dependency navigation retain the source database; identical bead IDs in different
projects are independent. Server tree caches are bounded to 32 database/view keys;
detail caches use database + bead ID and are bounded to 512 entries. A changed
source fingerprint invalidates its details and outdated alternate view.

Project selection intersects with the existing status, priority, assignee, type,
search, rig, specification and deadline filters. This first aggregate view is a
flat list containing both tasks and epics; individual project tabs retain their
tree views.

Live refresh uses one controlled cycle, five seconds **after the previous cycle
finishes**, rather than starting a detector/poll child for every source. Embedded
cache validation reads local write markers. Hidden windows pause scheduled cycles;
leaving the route cancels queued reads and discards late replies. An unavailable
project displays its own error, retains explicitly marked last-loaded rows, and
disables its detail editor until recovery. Other sources remain usable. Refresh
latency grows with slow sources and the number of connected projects.

## Verification

```sh
bun run lint
bun run test
bun --cwd=packages/server run typecheck
bun --cwd=packages/client run typecheck
bun run test:e2e --workers=1 all-projects.spec.ts cli-label-live.spec.ts add-label.spec.ts
bash scripts/build-local-macos.sh
```

The aggregate Playwright scenario creates two independent temporary embedded
stores with identical task, epic and dependency IDs. It verifies intersecting
filters, source-specific dependency navigation, isolated bulk status and label/comment writes, external
CLI changes, stability over refresh, an unavailable source, recovery, reload and
switching to an ordinary tab and back. It also checks the shared table, project badges,
selection isolation, and keyboard opening of Settings in both views at desktop
and narrow widths. It never mutates the user's demo stores.

`build-local-macos.sh` produces Beadbox Local with bundle ID `app.beadbox.local`
and an isolated profile in `src-tauri/target/local-profile`. Its production updater
is disabled. Register demo paths in that profile, not in the installed Beadbox's
registry. Copy the resulting bundle to Applications only when explicitly requested.
