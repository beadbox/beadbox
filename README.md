# Beadbox

> Beadbox has a sister project, [initech](https://github.com/nmelo/initech) — a runtime for agents that collaborate with each other from one terminal, optimized for steerability.
> Beadbox is built and maintained with it; worth a look.

A fast, native GUI for the [beads](https://github.com/gastownhall/beads) issue tracker.

Beadbox gives `bd` users a visual interface for the things a terminal can't show well — epic trees, dependency structure, pipeline state, and live activity — without making simple operations slower than typing `bd show`.

![Beadbox screenshot](docs/screenshot.png)

## Features

- **Epic tree** — hierarchical view of epics and child beads with status, priority, and progress at a glance
- **Live updates** — changes made from the `bd` CLI appear in the UI in real time; no refresh
- **Bead detail** — full descriptions, comments, dependencies, and workflow advancement in a side panel or modal
- **Filters** — slice by status, type, priority, and assignee; filters persist across sessions
- **Activity feed** — a timeline of what changed, by whom, across the workspace
- **Multi-workspace** — switch between local `.beads/` projects and remote Dolt server connections
- **Keyboard-first** — power-user paths work without touching the mouse

## Install

**Requires the [beads](https://github.com/gastownhall/beads) CLI, version 1.0.1 or newer** (`brew install beads`). Beadbox is a GUI over `bd`; all data lives in your beads database.

### macOS

```sh
brew install --cask beadbox/cask/beadbox
```

Or download the DMG (Apple Silicon) from [Releases](https://github.com/beadbox/beadbox/releases). Builds are signed and notarized.

### Linux and Windows

Download packages from [Releases](https://github.com/beadbox/beadbox/releases).

More at [beadbox.app](https://beadbox.app).

## Build from source

Prerequisites: [Bun](https://bun.sh), [Rust](https://rustup.rs) (stable), Node.js, and the platform prerequisites for [Tauri v2](https://v2.tauri.app/start/prerequisites/).

```sh
git clone https://github.com/beadbox/beadbox.git
cd beadbox
bun install

# Run the desktop app in development
bun run tauri:dev

# Or run the web client + server without the native shell
bun run dev

# Build a release bundle
bun run tauri:build
```

## Architecture (short version)

Beadbox is a Tauri v2 app. The Rust shell spawns a Bun sidecar process and talks to it over stdio (kkrpc) — the app opens no network ports. All issue data flows through the `bd` CLI; Beadbox never touches the database behind `bd`'s back. Live updates come from watching the workspace filesystem (local) or polling Dolt table hashes (server workspaces).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Contributions are accepted under the MIT license — no CLA.

## Security

To report a vulnerability, see [SECURITY.md](SECURITY.md). Please don't open public issues for security reports.

## License

[MIT](LICENSE) © 2026 Nelson Melo
