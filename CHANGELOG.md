# Changelog

All notable changes to Beadbox will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
- Update check re-runs when PostHog flags load, fixing a race condition on first launch
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

- **PostHog app analytics**: anonymous usage tracking with `app_opened` event for DAU/WAU/MAU measurement, includes opt-out toggle in Settings
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
