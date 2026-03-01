# Changelog

All notable changes to Beadbox will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.12.1] - 2026-03-01

### Changed

- **Privacy toggle copy**: settings now explains exactly what anonymous crash reports and usage stats include, and confirms no personal data or file contents are ever collected

### Fixed

- **"What is beads?" link**: the onboarding link now points to the correct public article instead of a broken URL
- **Molecule graph sizing**: the 3D molecule DAG canvas now fills the available height in the detail panel instead of rendering at a fixed size
- **WebSocket server crash recovery**: if the real-time update server crashes, it now automatically restarts within 5 seconds instead of staying down until app restart
- **Workspace card loading state**: workspace cards that fail to load stats now show an error fallback ("Unable to load stats") instead of spinning indefinitely, particularly on Windows
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
