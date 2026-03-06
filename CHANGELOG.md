# Changelog

All notable changes to Beadbox will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.16.3] - 2026-03-05

### Added

- **mysql2 connection pool**: Beadbox now maintains a persistent mysql2 connection pool per workspace instead of spawning a new `bd` process for every query. This is the foundation for eliminating subprocess overhead across the app. The ws-server fingerprint poll is the first consumer: real-time update detection dropped from ~1400ms (Go process spawn + TCP connect + query + exit) to ~5ms (single query on a persistent connection).
- **"Dolt is required" startup screen**: when Dolt is not installed, Beadbox now shows a dedicated screen with platform-specific install instructions (Homebrew, curl, Windows download) and a "Check again" button that auto-polls every 10 seconds. Replaces the cryptic "Unable to load workspace" error that appeared when bd was present but Dolt was missing.
- **metadata.json corruption warning**: if your workspace's `metadata.json` is missing or malformed, Beadbox now shows an inline warning banner explaining the issue instead of silently falling back to embedded detection mode. Server-mode workspaces no longer degrade to embedded mode without telling you.
- **Unified health indicator**: the three independent error signals (red header banner, amber inline overlay, green/red health dot) are now driven by a single `AppHealth` state machine. Recovery from a Dolt outage clears all indicators at once instead of leaving stale banners over fresh data.

### Changed

- **Workspace selector rewrite**: the workspace selector page was a single 2152-line component. It is now decomposed into focused modules: `WorkspaceCard` (individual workspace display and actions), `InitWorkspaceDialog` (new workspace creation flow), `AddWorkspaceDialog` (connecting to existing workspaces), and `WorkspacesPage` (layout and orchestration). No user-facing behavior changes; this is a maintainability improvement that unblocks future workspace features.

### Fixed

- **Error banner persists after recovery**: the amber "Failed to refresh" overlay stayed visible even after the Dolt server recovered and data refreshed successfully via WebSocket. The overlay now clears automatically when a WebSocket-triggered refresh succeeds, matching the behavior of the red header banner and health dot which already self-healed.
- **Workspace creation errors are opaque**: `bd init` failures surfaced as a generic toast with no guidance. Workspace creation errors now appear inline on the creation form with specific messages (permission denied, path not found, database already exists) and suggested fixes.
- **toastError infinite recursion**: `toastError()` was calling itself instead of the underlying toast function, causing a `Maximum call stack size exceeded` error. No error toasts were shown and no `app_error_shown` events fired. All error paths silently swallowed failures.
- **Archive bead visual lag**: archiving a bead left it visible in the list for 500-1000ms while waiting for the server round-trip. Archive now uses an optimistic update, removing the bead from the list instantly before the server action completes.
- **Delete bead visual lag**: same pattern as archive. Deleting a bead kept it visible until `loadEpics` finished. Now uses an optimistic removal from local state.
- **Stale dolt-server.port after restart**: when Beadbox restarts a managed Dolt server, the old `.dolt/dolt-server.port` file could linger, causing the app to connect to a port that no longer existed. The restart path now cleans up stale port files before launching a new server.
- **Workspace init error logging**: `bd init` failures logged `[object Object]` instead of the actual error. Error objects are now properly serialized so diagnostic details survive into logs and PostHog events.
- **Middleware Edge Runtime crash**: `middleware.ts` used Node.js `crypto` APIs that are unavailable in the Edge Runtime, causing a crash on every request in production builds. Replaced with Edge-compatible alternatives.
## [0.16.2] - 2026-03-04

### Added

- **Developer Console**: press `~` to open a bottom drawer with two tabs. The Commands tab streams live `bd` CLI output and accepts interactive input. The Events tab shows WebSocket lifecycle events in real time. Session-token gated and undocumented; built for power users who want to see what's happening under the hood.

### Changed

- **Bead detail caching**: `getBeadDetail` now uses a cache-first strategy. Opening the same bead a second time is instant instead of re-running CLI calls.

### Fixed

- **Activity Dashboard filter crash**: clicking the Filter button on the Activity Dashboard no longer crashes when `bd activity` falls back to `bd list` (happens when some beads have no actor field). P1 fix affecting users with mixed-actor workspaces.
- **Workspace re-open spinner**: clicking the tab for an already-active workspace no longer shows a spinner that never resolves. Previously required closing and re-opening the workspace to recover. P1 fix confirmed in 7 user reports.
- **"Fix this" button on error screen**: the WorkspaceErrorScreen now shows the "Fix this" button for circuit breaker and server-unreachable errors, which were previously missing the button entirely.
- **/settings 500 error**: the `/settings` page no longer returns a 500 in production builds. The standalone output glob patterns were excluding SSR chunks needed by the settings route.
- **/api/console 401 in dev mode**: the `/api/console` endpoint no longer returns 401 when running under Turbopack dev mode (module isolation was preventing session token validation).
- **Circuit breaker severity**: reverted circuit breaker error severity to "recoverable" so transient Dolt failures trigger auto-retry instead of showing a permanent error screen.
- **E2E test port collisions in CI**: test fixtures now use isolated port ranges, eliminating spurious CI failures from port reuse across parallel test runs.

## [0.16.1] - 2026-03-03

Stability release. Error recovery actually works now (two P1 fixes), transient failures self-heal, and the CI test suites are back online.

### Added

- **Comments skeleton loading**: selecting a bead now shows animated placeholder cards in the comments area during the async load, with a smooth fade transition when real comments arrive. Background refreshes (WebSocket updates) skip the skeleton so the UI stays calm.
- **Filter bar keyboard shortcut**: press Cmd+F (macOS) or Ctrl+F (Windows/Linux) to toggle the filter bar open and closed. Focus moves to the first filter input on open.
- **Workspace switch failure telemetry**: failed workspace switches now send structured events to PostHog with error type, source workspace, and target workspace, closing a diagnostic gap in multi-workspace usage.
- **Update checker on workspace selector**: when a newer Beadbox version is available, the workspace selector now shows an inline banner with a Download button above your workspace cards. You no longer need to open a workspace to discover updates.

### Changed

- **AI help button in header**: the floating `?` circle in the bottom-right corner moved to the header bar next to the sponsor button for consistency. The help popover widened from 384px to 576px so prose wraps properly and code blocks scroll horizontally instead of clipping.
- **Init prompt inline**: the workspace initialization prompt ("No workspace found. Create one?") moved from a floating bottom bar into the Quick Start card on the onboarding screen, below the "Set Up Workspace" button.
- **Privacy toggle copy**: the Settings privacy toggle body text now says "anonymous crash reports and usage stats" instead of "a single startup event," which had become inaccurate as more telemetry events were added.
- **Docs workspace concept page**: fixed 8 technical inaccuracies in `/docs/concepts#workspace` including outdated path references, incorrect detection logic descriptions, and stale screenshots.

### Fixed

- **Workspace switch flash in Tauri**: switching workspaces in the native app no longer briefly flashes the target workspace and then redirects back to the original. The redirect guard now waits for the workspace cookie to propagate before evaluating navigation state.
- **Error recovery screen**: two P1 fixes that together make workspace error recovery functional. First, the error classifier now uses regex instead of literal string matching, so real `bd` error messages (which contain variable content like database names) are classified correctly instead of falling through to "unknown." Second, errors thrown from server actions are now returned as discriminated unions instead of thrown class instances, preserving error classification across the Next.js server/client serialization boundary. Users now see specific error screens ("Workspace out of sync," "Server unreachable") with targeted fix commands instead of a generic "Unable to load workspace."
- **Circuit breaker auto-retry**: when the Dolt server's circuit breaker trips (temporary connection failure), the error is now classified as transient instead of "unknown." The app retries automatically with exponential backoff (3s, 6s, 12s, 24s) and self-heals when the server recovers, instead of freezing until the user clicks Retry.
- **Drag to backlog/archive**: dragging a bead onto the Backlog or Archived section headers in the epic tree now works. Previously only the separate "Drop here to..." zones accepted drops. Section headers show visual feedback (blue ring for backlog, amber ring for archive).
- **Workspace card skeleton after add**: adding a workspace no longer gets stuck showing a perpetual skeleton loading bar. When `bd status` fails for a workspace, the card now shows "Unable to load stats" instead of spinning forever.
- **"What is beads?" link**: the onboarding link now points to the public article instead of a private GitHub repo that returned 404 for end users.
- **Molecule graph height**: the Three.js 3D graph in the Molecule tab now fills the full available height in the detail panel instead of only the upper half, leaving a blank region below.
- **Minimap comment order**: the minimap (right side of detail panel) now respects the current sort direction. Previously it always showed oldest-first regardless of the selected sort, and clicking a minimap entry scrolled to the wrong comment.
- **Comment card author accents**: comment cards in the detail panel now show a colored left border matching the comment author, making it easier to visually track who said what in long threads.
- **Workspace connect error advice**: when connecting to a workspace fails, the bottom bar now shows category-specific recovery hints (e.g., "Database not found" suggests checking the `.beads` directory) instead of a generic "Check that the server is running" message regardless of error type.
- **"Fix this" button command**: the workspace error screen's "Fix this" button for database-not-found errors now runs `bd dolt start` (correct) instead of `bd dolt stop` (wrong).
- **WebSocket server crash in Tauri**: if the real-time update server crashes inside the native app, the Rust sidecar monitor now detects the exit and automatically restarts it. The UI reconnects within about 8 seconds. Previously a crash silently killed real-time updates until the next app restart.
- **Header overflow at 4+ workspaces**: workspace tabs in the header no longer push the right-side controls (refresh, settings, sponsor) off-screen. Workspace names truncate with ellipsis and controls stay visible regardless of workspace count.
- **E2E test suite CI timeout**: bumped the E2E and holistic test job timeouts from 15 to 30 minutes to accommodate release-build test runs.
- **CI E2E and holistic test suites re-enabled**: both test suites were disabled to ship v0.16.0. Re-enabled with hardened configurations: stale process cleanup, port collision fixes, registry isolation, and cookie fallback for workspace health checks. 73 E2E tests and 18 holistic tests passing on Linux.
- **PostHog log capture filtering**: the PostHog log capture integration was forwarding all stdout output as log events. Now it filters to error-level messages only, reducing noise and event volume.
- **app_opened event in Tauri**: the `app_opened` PostHog event was not firing for some native app users because the telemetry init raced with the WebView load. The event now fires after the client confirms the WebView is ready.
- **AI help textarea clearing**: the AI help input field now clears after a response is received. Previously the textarea retained the last question, requiring manual deletion before asking another.
- **Windows: JobObject startup telemetry**: the Windows Job Object creation failure path in headless mode now reports to telemetry, closing a diagnostic gap in Windows startup errors.

## [0.16.0] - 2026-03-03

This release overhauls how Beadbox manages workspaces. You control which projects appear, connect to Dolt servers without creating local folders, and get real logs when something goes wrong.

### Added

- **App-owned workspace registry**: Beadbox now keeps its own workspace list at `~/.beadbox/registry.json` instead of autodiscovering `.beads/` directories on disk. You decide which workspaces appear. No more phantom entries from old projects or stale paths cluttering the selector.
- **Remove any workspace card**: hover over any workspace card and click the X button to remove it from your list. Previously the remove button only appeared on broken workspaces.
- **Sidecar log files on all platforms**: the native app now writes Next.js and WebSocket server output to log files (`~/Library/Logs/Beadbox/` on macOS, equivalent paths on Windows and Linux). Crashes and errors are no longer invisible.
- **bd doctor in diagnostics**: the Settings diagnostics panel now runs `bd doctor` against your active workspace, surfacing health issues without switching to the terminal.
- **bd command timing**: every `bd` CLI call now logs its execution time, making it easy to spot slow commands in the logs.
- **Client-side startup logging**: critical startup-gate events (workspace detection, cookie resolution, redirect decisions) are now captured server-side, closing a major diagnostic blind spot.

### Changed

- **Direct Dolt server connections**: connecting to a Dolt server no longer creates a local stub folder. Pick `host:port`, select your databases, done. Connection info lives in the workspace registry, and workspace cards show `host:port/database` instead of a meaningless local path.
- **Server discovery filters to beads databases**: when scanning a Dolt server, the discovery dialog now hides databases that don't have the beads schema. No more selecting a random database and getting a confusing error.
- **Removed Feedback tab**: the Settings dialog no longer includes the Feedback tab (the backend was never connected).

### Fixed

- **Initialize button shows spinner**: the Initialize button now shows a loading spinner while `bd init` runs instead of appearing frozen.
- **Spaces in folder names**: `bd init` no longer fails silently when the project folder path contains spaces.
- **Folder rename handling**: workspaces no longer crash when you rename the parent folder after running `bd init` (database name mismatch). The error is caught and surfaced with a clear message.
- **Random redirect to workspace selector**: fixed a race condition that could bounce you back to the workspace selector seconds after opening a workspace.
- **Server workspace schema validation**: schema validation no longer rejects valid Dolt server workspaces that use `.beads` vs `.beads/dolt` paths.
- **Server workspace display path**: server-connected workspaces now show the actual `host:port/database` connection info instead of a synthetic `.beadbox/servers/` file path.
- **bd init error reporting**: initialization errors are now logged server-side and sent to error tracking instead of failing silently.
- **bd command timeout**: long-running or hung `bd` commands now time out with an error instead of blocking the UI indefinitely.
- **Workspace card skeleton**: adding a new workspace no longer gets stuck in the skeleton loading state with details that never render.
- **Dolt health check path**: the inline health check now correctly resolves database paths for Dolt workspaces.
- **Windows: log output**: Windows release builds now produce log output (were completely blind before this fix).
- **Windows: workspace setup**: setting up a workspace on Windows no longer fails silently when `bd` is not in PATH; the error is surfaced to the user.

## [0.15.0] - 2026-03-02

### Changed

- **Scan-first Dolt connect dialog**: the "Connect to Dolt Server" dialog now auto-scans for running servers when it opens, displaying discovered servers with one-click "Use" buttons at the top. The manual connection form collapses into an accordion below scan results, and auto-expands when no servers are found or authentication fails.
- **Update dialog release notes**: the "Update Available" dialog now shows curated release notes describing what changed, instead of install instructions. Content is fetched from the public changelog repository; falls back to the previous behavior when a curated entry doesn't exist yet.

### Fixed

- **Status filter scroll reset**: selecting a status filter no longer leaves the list scrolled to the previous position; the view resets to the top so matching beads are immediately visible
- **CI E2E test reliability**: the end-to-end test suite (66 tests) now passes reliably in CI, fixing a port-discovery collision where the WebSocket server connected to the wrong Dolt instance instead of the test fixture's server

## [0.14.0] - 2026-03-01

### Added

- **Port-scan server discovery**: the "Add by server" screen now has a "Scan for local servers" link that finds running Dolt servers automatically. Phase 1 checks common ports instantly; Phase 2 scans a wider range if nothing is found. Click a result to auto-fill the connection form and discover databases.
- **Rig badges for Gastown workspaces**: in multi-rig Gastown workspaces, each bead row shows a small tag indicating which rig it belongs to (parsed from `.beads/routes.jsonl`). Rig is also available as a filter. Invisible in non-Gastown workspaces.
- **Pipeline type composition**: each pipeline column now shows a summary line below the count (e.g. "3 bugs · 2 tasks") so you can see what kind of work is in each stage at a glance

### Changed

- **Empty board redesign**: the onboarding hero now leads with "Nothing here yet." and the quickstart commands, instead of philosophy copy. Pip logo is smaller. The pilot/mechanic tagline survives below a divider in secondary styling.

### Fixed

- **Health indicator accuracy**: the connection dot now correctly turns red when the Dolt server stops or the circuit breaker trips, across both the Beads and Activity tabs. Previously the dot could stay green after a Dolt failure.
- **Archived beads in Backlog**: archived beads no longer appear in the Backlog section of the epic tree
- **Workspace stats with bd v0.57.0**: the workspace card error classifier now handles the new Dolt error format introduced in beads v0.57.0, showing correct error hints instead of a generic fallback

### Security

- **API path validation**: the `/api/bd` route now validates database paths and rejects `--db` flag injection attempts

## [0.13.0] - 2026-03-01

### Added

- **Archive button in bead list**: each bead row now has an archive icon button next to delete, so you can archive beads without opening the detail panel or dragging to a drop zone
- **Gastown workspace support**: workspaces managed by Gastown (beads' multi-agent orchestration tool) now load correctly in Beadbox. The epic tree view falls back to a flat list when no epics exist, so beads are visible on first open instead of showing "No epics or beads match your filters"

### Changed

- **Workspace loading performance**: parallelized read-only CLI calls, added fingerprint caching to skip redundant reloads, and introduced incremental refresh so only changed beads are re-fetched on WebSocket updates. Large workspaces (500+ beads) load noticeably faster.
- **"Mark Ready to Ship" button**: now shows a loading spinner while the status change executes, instead of appearing unresponsive until the command completes

### Fixed

- **Real-time updates with bd v0.57.0**: change detection no longer depends on `issues.jsonl` (removed in beads v0.57.0). Embedded-mode and server-mode workspaces both use Dolt-native fingerprinting for live updates.
- **Real-time updates for Gastown workspaces**: the WebSocket server now watches the correct data directory for Gastown-managed workspaces, so live updates work without manual refresh
- **Workspace resolution after SQLite migration**: workspaces that auto-migrated from SQLite to Dolt (beads v0.57.0) now resolve correctly without reconfiguration. Registry entries pointing to old `.db` paths are handled gracefully.
- **Dolt server error message**: the "Failed to initialize workspace" error no longer references "Gas Town" and has improved formatting

## [0.12.1] - 2026-03-01

### Changed

- **Privacy toggle copy**: settings now explains exactly what anonymous crash reports and usage stats include, and confirms no personal data or file contents are ever collected

### Fixed

- **"What is beads?" link**: the onboarding link now points to the correct public article instead of a broken URL
- **Molecule graph sizing**: the 3D molecule DAG canvas now fills the available height in the detail panel instead of rendering at a fixed size
- **WebSocket server crash recovery**: if the real-time update server crashes, it now automatically restarts within 5 seconds instead of staying down until app restart
- **Workspace card loading state**: workspace cards that fail to load stats now show an error fallback ("Unable to load stats") instead of spinning indefinitely, particularly on Windows
- **Workspace error hints**: workspace cards that fail to load stats now show a specific reason (server not running, database not found, CLI not found) with a recovery hint, instead of a generic error message
- **Native app startup reliability**: improved error reporting during app startup so crashes surface actionable diagnostics instead of silent failures

## [0.12.0] - 2026-02-28

### Added

- **Ready to Ship pipeline column**: the pipeline dashboard now shows a "Ready to Ship" stage (emerald green) between Ready for QA and Closed, so you can see which beads have passed QA and are queued for release
- **Custom metadata display**: bead detail panel and modal now show custom metadata key-value pairs (read-only) below the standard fields, surfacing project-specific data without switching to the CLI
- **Molecule DAG visualization**: bead detail panel can render molecule dependency graphs as interactive 3D DAGs.
- **Molecule badge types**: molecule epics now display a pink "Molecule" badge, and their children show the correct child type (Task or Gate) instead of generic badges
- **Beads tab icon**: circle icon added next to the "Beads" tab label for visual consistency with the Activity tab
- **Delete spinner**: the delete button now shows a loading spinner while the deletion is in progress, preventing double-clicks and confirming the action is underway

### Fixed

- **Detail panel latency**: parallelized CLI calls in `getBeadDetail` and eliminated a redundant comments fetch (comments already come back from `bd show --json`). Typical load time drops from ~450ms to ~125ms (3-4x improvement).
- **Clear Filters button in Activity tab**: the button was wired up but had no effect; now correctly resets all active filters
- **Archive dialog title wrapping**: child bead titles in the archive confirmation dialog no longer truncate mid-word; long titles wrap to the next line
- **Delete button actually deletes**: the delete button in the UI was silently failing in certain modes; now reliably removes beads

## [0.11.3] - 2026-02-28

### Added

- **Welcome screen for new users**: when the `bd` CLI is not installed, Beadbox now shows a "Welcome to Beadbox" screen with a one-sentence explanation, a copyable install command for your platform, and a "What is beads?" link. Replaces the previous error-toned "CLI not found" message.
- **Unread indicators**: a blue dot replaces the type-color dot on beads that have changed since you last viewed them (new comments or field updates). Opening a bead marks it as read. `Shift+U` marks all visible beads as read. Read state persists in localStorage across sessions. On first launch, all existing beads start as read so you're not overwhelmed.

### Fixed

- **Connection status dot consolidation**: replaced the separate "Live updates paused" badge with a single connection dot that carries all states (skeleton while loading, green when connected, amber when WebSocket is disconnected, red on error)
- **Bead deletion in Dolt server mode**: delete from UI now works correctly with Dolt-backed workspaces (previous fix used raw SQL that skipped Dolt's commit layer; replaced with `bd delete --force`)
- **Workspace selector tab icon contrast**: active tab icon was invisible against the green background due to a hardcoded muted color; now renders with correct contrast
- **Onboarding hero instructions**: getting-started commands now tell users to `cd` into their project directory first, preventing "command not found" confusion when run from the wrong path
- **Workspace hint auto-dismiss**: the pulsing green ring on the workspace folder button now disappears after ~8 seconds, so it only draws attention on first launch instead of every launch

## [0.11.2] - 2026-02-27

### Added

- **Activity pane header controls**: settings gear, connection status dot, and keyboard shortcuts (`j`/`k` navigation, `f` for filters, `Enter` to open, `Cmd+,` for settings, `Cmd+R` to refresh) now match the Beads tab
- **Skeleton loading states**: switching between Beads and Activity tabs now shows structural placeholder skeletons matching each tab's layout instead of bare "Loading..." text or a spinner flash

### Changed

- Onboarding hero getting-started commands now labeled "From your project directory:" for clarity

### Fixed

- "Download & Quit" in the auto-updater now actually quits the app (~1.5s after the update finishes downloading). Previously the download completed but the app stayed open. Tauri only.

## [0.11.1] - 2026-02-27

### Added

- **Read-first onboarding**: empty boards now show "You're the pilot, not the mechanic" messaging with two copy-to-clipboard getting-started commands (`bd create` and an AI agent example) instead of the bare "No epics found" text. Disappears automatically when the first bead arrives.
- Refresh icon in the header now spins while reloading (Cmd+R or click)

### Fixed

- In-app AI help no longer hallucinates UI controls that don't exist. The injected context now reflects Beadbox's read-only model and directs write operations to the `bd` CLI instead of inventing buttons.

## [0.11.0] - 2026-02-27

### Added

- **Activity Dashboard**: the Activity tab is now a coordination dashboard with three layers instead of a flat event log
  - **Agent Status Strip**: persistent row of agent cards at the top showing each agent's status (active/quiet/silent), current bead, last action, and time since last event. Click an agent to filter the feed to their events.
  - **Pipeline Flow**: visual pipeline showing beads distributed across stages (open, in_progress, ready_for_qa, closed) with counts, clickable bead IDs, and a pulse animation when beads transition. Click a stage to filter the feed.
  - **Cross-filtering**: clicking an agent, pipeline stage, or bead ID filters across all three layers simultaneously. Active filter shown as a dismissible chip. Keyboard shortcuts: `1`-`4` for pipeline stages, `a` for agent focus mode.
- **Spec viewer modal**: clicking a spec-id file path in the bead detail panel now opens the markdown document in a full-width modal, rendered with the same styling as bead descriptions. No more switching to a separate editor to read specs.
- **In-app AI help**: floating `?` button (bottom-right corner) opens a text input where you can ask questions about Beadbox. Queries are answered by whichever AI CLI is installed (`claude`, `codex`, or `gemini`), with app context automatically injected. Falls back to a helpful message if no CLI is found.
- **Archive onboarding toast**: the first time you close a bead, a persistent toast teaches you about drag-to-archive with a one-click "Archive now" shortcut. Appears once per installation, stays visible until dismissed.
- **Node.js crash reporting**: unhandled exceptions and rejected promises in the Next.js server and WebSocket server are now captured for error reporting. Browser-side capture was already in place; this closes the server-side gap.

### Fixed

- Real-time updates now detect bead hierarchy changes (parent reassignment via `bd update --parent`) within ~2 seconds, without manual refresh
- Real-time updates now detect comment additions in Dolt server mode (replaced dual-mechanism poll with a single comprehensive SQL fingerprint query)
- Delete button in the UI now actually deletes beads in Dolt server mode (was silently failing because `bd delete --force` does not work against server-mode databases; switched to direct SQL DELETE)
- Epic row status badges no longer overlap with adjacent title text at narrow viewport widths
- Nested `<button>` HTML violation in PipelineFlow component resolved (inner bead ID elements changed to `div[role="button"]`)

## [0.10.0] - 2026-02-27

### Added

- **Dolt server authentication**: advanced mode now supports user, password, TLS, and database fields when connecting to a Dolt server. Password is held in memory only (never written to disk) and passed to `bd` as an environment variable. Fixes [GitHub issue #2](https://github.com/beadbox/beadbox/issues/2).
- Header tooltip for server-mode workspaces now shows `user@host:port/database` format
- Periodic `bd` health check monitors CLI availability and surfaces connection issues
- Server-side platform detection for install instructions (no longer relies on client-side user agent)
- **E2E CI gate**: test suite runs on every release candidate, catching regressions before QA
- **Holistic test infrastructure**: app launcher fixture, Dolt server fixture, deterministic Playwright assertions, and 6 packaging verification scenarios
- Documentation: [Connecting Beadbox to a Dolt Server](https://beadbox.app/docs/connecting-dolt-server) guide covering local setup, authentication, hosted Dolt, and troubleshooting

### Fixed

- 14 pre-existing E2E test failures resolved to enable the CI gate
- 3 flaky workspace tab tests stabilized with deterministic timing
- Website: page title now aligns with H1 keywords for better search engine relevance
- Website: H1 heading keywords echoed in body copy for improved content coherence
- Website: `www.beadbox.app` now 301-redirects to `beadbox.app` (eliminates duplicate content in search indexes)

## [0.9.12] - 2026-02-26

### Added

- Settings gear icon in the header with "Settings (Cmd+,)" tooltip for quick access to app settings
- Labels and helper text on the Dolt server connection form explaining that no credentials are needed
- Folder icon and "Manage workspaces" tooltip on the workspace button, with a one-time hint popover for new users
- Website: "Copy setup instructions for AI" button in the hero section, inline with the download button

### Changed

- Dolt connection form host placeholder updated to 127.0.0.1 with local-first helper text
- Website: LLM setup instructions rewritten so CLI-only AI agents can follow every step without GUI interaction

### Fixed

- Enter and Space keys now activate header buttons like Settings, Refresh, and Support (global keyboard handler was intercepting native button clicks)
- Dolt connection form error messages no longer echo raw user input back (prevents credential reflection)
- Clicking the workspace hint text now dismisses the popover (previously only the X button worked)
- Workspace first-launch hint popover replaced with a pulsing ring on the folder icon (cleaner, no floating text box)
- Workspace tab close button no longer causes layout shift on hover (opacity-toggle instead of display-toggle, fades in with rounded shape)

## [0.9.10] - 2026-02-25

### Fixed

- Real-time updates now work in the native Mac app for Dolt server-mode workspaces (sidecar processes were missing the login shell PATH, so `bd` was not found)

### Changed

- Loose Beads section now starts expanded and Backlog starts collapsed on fresh open (was reversed)

## [0.9.9] - 2026-02-24

### Fixed

- Real-time updates in Dolt server-mode workspaces (WebSocket server was passing the wrong database path to `bd` poll commands)

## [0.9.8] - 2026-02-23

### Added

- **Dolt server-mode workspace support**: connect to workspaces backed by a running Dolt SQL server, with automatic detection during workspace discovery
- Select all / deselect all toggle in server discovery

### Fixed

- Switching workspaces now loads the correct workspace data (was showing beadbox data for all workspaces in Dolt server mode)
- Workspace tabs no longer change count when switching between Beads and Activity views

## [0.9.7] - 2026-02-21

### Added

- Remove workspace button in workspace selector

### Fixed

- Comments not loading on beads with invalid registry entries
- Dolt database crash on concurrent operations
- Website showing 'unknown' for app version

## [0.9.6] - 2026-02-21

### Changed

- Priority dropdowns now show P0-P4 labels with names (P0 Critical through P4 Backlog)

## [0.9.5] - 2026-02-20

### Changed

- Backlog now uses P4 priority instead of labels (drag-to-backlog sets priority, not label)

### Fixed

- Website auto-deploys on release promote (no more manual trigger)
- CHANGELOG.md auto-syncs to public repo on promote

## [0.9.4] - 2026-02-20

### Added

- Cmd+1/Cmd+2 keyboard shortcuts to switch between Beads and Activity views

### Fixed

- WebSocket live indicator no longer flashes yellow every 2 seconds
- Refresh button no longer hangs for 20 seconds then loads an empty workspace

## [0.9.3] - 2026-02-20

### Fixed

- Activity feed sorts by most recent first
- RC update channel no longer prompts stable users with pre-release builds
- Website deploy triggers automatically on new releases

## [0.9.2] - 2026-02-20

### Fixed

- Version display correctly distinguishes RC testers from GA users (RC suffix only shown to testers)

## [0.9.1] - 2026-02-20

### Fixed

- Update dialog now shows full version including RC suffix, so users can tell which build they're running

## [0.9.0] - 2026-02-20

### Added

- **Dolt backend support**: Beadbox now detects and works with Dolt-backed beads workspaces in addition to SQLite
- **Smarter real-time updates**: change detection uses Dolt commit hashes instead of file modification times, eliminating false-positive refreshes

### Fixed

- Activity feed works correctly with bd v0.54.0 output format

### Removed

- WAL-based change detection (replaced by Dolt commit hash fingerprinting)

## [0.8.0] - 2026-02-14

### Added

- **Self-update system**: Beadbox checks for updates in the background, shows an indicator in the header when a new version is available, and lets you download and install updates without leaving the app
- **Update settings**: choose between stable and RC update channels in Settings
- **Activity feed**: see a timeline of recent changes across your workspace with live real-time updates, filtering, bulk operation grouping, and click-through navigation to bead details
- **Keyboard shortcuts**: vim-style `G`/`gg`/`/` bindings; full keyboard shortcuts reference in Settings
- **Headless mode**: run with `--headless` for server-only mode without the native window
- Feature vote page at `/vote`

### Fixed

- Update checker now downloads the correct architecture DMG on ARM64 Macs (was downloading x64)
- "Quit to Update" button works in the native app
- Auto-updater correctly detects newer RC versions for RC-to-RC upgrades
- DMG auto-opens after update download completes
- Correct CPU architecture detected in native app for update downloads
- Warning shown when closing or archiving an epic that still has open children

## [0.7.1] - 2026-02-12

### Bug Fixes

- **macOS Finder launch**: app now correctly locates the `bd` CLI when launched from Finder or the Dock (PATH resolution fix)

## [0.7.0] - 2026-02-12

### Features

- **Windows support**: native Windows binaries with code signing via Azure Trusted Signing
- **Linux support**: distributed as `.deb` package and AppImage
- **macOS Intel support**: universal builds now cover both Apple Silicon and Intel Macs
- **Code signing and notarization**: all macOS builds are signed and notarized for gatekeeper-free installation
- **Floating version label**: version indicator visible on all screens
- **Version API endpoint**: `/api/version` returns current version and build ID
- **Workspace registration**: selecting a folder writes it to the workspace registry for quick access
- **Keyboard shortcuts on website**: keyboard shortcuts section added to the features page on beadbox.app
- **Build number system**: release candidates promote to final without rebuilding
- **Automated website version updates**: website version badge updates automatically on each release

### Bug Fixes

- **Epic progress bar accuracy**: progress bar now only counts closed children, not in-progress ones

## [0.5.0] - 2026-02-10

### Features

- **Zoom controls (Desktop)**: Cmd+/Cmd- to zoom in/out, Cmd+0 to reset, with persistent zoom level in Settings > General
- **Blog**: markdown-based blog on beadbox.app with vision post

### Bug Fixes

- **Default sort**: default sort is now "Status (Closed first)" so completed work surfaces on launch
- **DMG installer polish**: white background and standard macOS Applications folder icon in DMG window
- **DMG icon on Sequoia**: fixed Applications icon rendering as generic box on macOS Sequoia
- **Standalone build**: include Turbopack app-route runtime in standalone output

## [0.4.12] - 2026-02-09

### Features

- **Website download tracking**: download-intent events on beadbox.app for measuring visitor-to-download conversion

### Bug Fixes

- **Changelog link**: changelog link in the settings footer now opens correctly
- **Settings typography**: settings dialog font and sizing updated to match Aptakube's polished typography
- **iOS app icon**: removed transparency from app icon to pass Apple TestFlight validation
- **Workspace tab labels**: bumped workspace tab label font size to text-base for better readability
- **Gear icon replaced**: workspace header gear icon replaced with a plus (+) button for clearer "add workspace" affordance

## [0.4.11] - 2026-02-09

### Features

- **Workspace selector**: new card-based workspace picker screen for discovering and switching between projects
- **Settings dialog**: new Settings panel (Cmd+,) with sidebar navigation
- **Theme picker**: choose your theme from the Settings General tab (replaces header palette icon)
- **Feedback form**: submit feedback directly from Settings (backend deferred; UI ready)
- **Help tab**: access support links, view logs, and clear cache from Settings
- **BETA badge**: visible beta indicator next to the app icon in the header
- **Drop zone reorder**: archive zone moved first, backlog second, epic/loose side by side

### Bug Fixes

- **Mobile Connect button**: Connect button on workspace selector is now reachable on mobile viewports
- **Connection timeout**: workspace connection attempts now time out after 10 seconds instead of hanging indefinitely
- **Stripe sponsor heart icon**: heart icon now opens Stripe in an external browser in the Tauri app
- **App naming**: renamed from "Beads" to "Beadbox" in app title and window title

## [0.4.0] - 2026-02-09

### Bug Fixes

- **WebSocket reconnection loop**: eliminated a WAL checkpoint feedback loop that caused ~1s reload cycles and constant reconnection indicators
- **Convoy badge overlap**: convoy type badges no longer overlap with status badges on wider viewports (iPad, desktop)
- **iOS/iPadOS safe area insets**: content now respects Dynamic Island, status bar, and home indicator
- **Clipboard crash on LAN**: copying bead IDs no longer crashes on non-secure HTTP contexts
- **WebSocket hostname**: WebSocket connects using the page hostname instead of hardcoded localhost, enabling real-time updates over LAN
- **Drag-and-drop archive**: archiving epics via drag-and-drop now works in the native macOS app

## [0.3.0] - 2026-02-09

First public release.

### Features

- **Epic tree view** with expandable hierarchies, progress bars, and nested children
- **Real-time sync**: changes made via `bd` CLI appear in the GUI within milliseconds (no refresh, no polling)
- **Multi-workspace support**: switch between beads databases from different projects
- **Inline editing** with auto-save for titles, descriptions, status, priority, and assignee
- **Dependency tracking**: visual badges showing blocking relationships between issues
- **Filter and search**: filter by status, priority, type, or assignee; full-text search across bead titles
- **Sort** by title, priority, status, or last updated
- **Bead detail panel** with markdown-rendered comments and full edit capabilities
- **Convoy view** for grouped workflow sequences
- **Dark and light themes** that follow your system preference
- **Mobile-responsive layout** with touch-friendly targets for iPad and phone
- **First-run experience** that guides you through installing `bd` and connecting a workspace
- **Native macOS app** via Tauri (no Electron)
- **Copyable bead IDs** (click to copy)
- **URL-based state**: expanded epics and selected bead persist in the URL

### Install

```bash
brew tap beadbox/cask
brew install --cask beadbox
```

Or download the `.app` bundle from [beadbox.app](https://beadbox.app).
