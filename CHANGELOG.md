# Changelog

All notable changes to Beadbox will be documented in this file.

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
brew install nmelo/tap/beads-ui
```

Or download the `.app` bundle from [beadbox.app](https://beadbox.app).
