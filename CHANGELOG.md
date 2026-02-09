# Changelog

All notable changes to Beadbox will be documented in this file.

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
