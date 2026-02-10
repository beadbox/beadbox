# Changelog

All notable changes to Beadbox will be documented in this file.

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
