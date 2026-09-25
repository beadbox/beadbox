# Beadbox

> Beadbox has a sister project, [initech](https://github.com/nmelo/initech) — a runtime for agents that collaborate with each other from one terminal, optimized for steerability.
> Beadbox is built and maintained with it; worth a look.

A fast, native GUI for the [beads](https://github.com/gastownhall/beads) issue tracker.

Beadbox gives `bd` users a visual interface for the things a terminal can't show well — epic trees, dependency structure, pipeline state, and live activity — without making simple operations slower than typing `bd show`.

![Beadbox screenshot](docs/screenshot.png)

![Resizable workspace rail: switch projects, rename a tab, pick an emoji](docs/rail-demo.gif)

## Features

- **Epic tree** — hierarchical view of epics and child beads with status, priority, and progress at a glance
- **Trains** — `.beadtrain` files in the workspace `.beads/` folder: ready cars, coupler joins, click through to the bead
- **Live updates** — changes made from the `bd` CLI appear in the UI in real time; no refresh
- **Bead detail** — full descriptions, comments, dependencies, and workflow advancement in a side panel or modal
- **Filters** — slice by status, type, priority, and assignee; filters persist across sessions
- **Activity feed** — a timeline of what changed, by whom, across the workspace
- **Multi-workspace** — a rail of project tabs switches between local `.beads/` projects and remote Dolt servers; rename a tab, give it an emoji, and switching back is instant
- **Keyboard-first** — power-user paths work without touching the mouse

## Install

**Requires the [beads](https://github.com/gastownhall/beads) CLI, version 1.1.0 or newer** (`brew install beads`). Beadbox is a GUI over `bd`; issue data lives in your beads database. `.beadtrain` files in `.beads/` are optional plans (see [Beadtrains](https://github.com/acrinym/Beadtrains)) shown on the Trains tab.

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

### Local macOS build, isolated from an installed Beadbox

To try a change in a real app on macOS without touching an installed Beadbox,
build a separate, locally signed copy:

```sh
bash scripts/build-local-macos.sh
```

Nothing is installed. The app stays in the build tree at
`src-tauri/target/release/bundle/macos/Beadbox Local.app`, with a scratch
profile beside it in `src-tauri/target/local-profile/`. Open it from Finder
or with:

```sh
open -n "src-tauri/target/release/bundle/macos/Beadbox Local.app"
```

How it stays separate from the installed app:

- **Own bundle identifier** (`app.beadbox.local`) and name, so macOS keeps its
  window, WebView and app-data state apart from the installed Beadbox.
- **Scratch workspace registry.** The app's `Info.plist` (`LSEnvironment`)
  points `BEADBOX_REGISTRY_PATH` at
  `src-tauri/target/local-profile/registry.json` and `BEADS_REGISTRY_PATH` at a
  file in the same folder, so the app neither reads your registered workspaces
  nor imports them from the legacy `~/.beads/registry.json` on first run. It starts with no workspaces; add a test workspace from inside the app.
- **Own sidecar log** at `src-tauri/target/local-profile/sidecar.log` (via
  `BEADBOX_LOG_PATH`) instead of `~/Library/Logs/Beadbox/`.
- **No updates.** The build has no update endpoint, so it cannot replace itself
  with a release build; the update check reports that it failed.
- **No analytics.** The build blanks the analytics key.

What it still shares or leaves behind:

- The installed `bd`. Any workspace you add in the local app is a real
  workspace on disk; opening one of your real workspaces from both apps at
  once works, but edits from either land in the same database.
- Saved server-workspace credentials live in the same macOS keychain service
  (`beadbox`) as the installed app.
- macOS and WebKit create per-app folders for `app.beadbox.local` (for example
  under `~/Library/WebKit` and `~/Library/Caches`) when it first launches. They
  are separate from the installed app's; delete them with the build if you
  want a clean slate.
- The build uses the usual toolchain caches (`~/.cargo`, `~/.bun`).

The signature is ad hoc and the build is not notarized; it is for your own
machine only. The scratch paths are absolute and baked into the bundle at build
time: if you move the repository, rebuild. They apply whenever macOS opens the
app (Finder, Spotlight, `open`), but not if you run the executable inside
`Contents/MacOS` directly.

## Architecture (short version)

Beadbox is a Tauri v2 app. The Rust shell spawns a Bun sidecar process and talks to it over stdio (kkrpc) — the app opens no network ports. All issue data flows through the `bd` CLI; Beadbox never touches the database behind `bd`'s back. Live updates come from watching the workspace filesystem (local) or polling Dolt table hashes (server workspaces).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Contributions are accepted under the MIT license — no CLA.

## Security

To report a vulnerability, see [SECURITY.md](SECURITY.md). Please don't open public issues for security reports.

## License

[MIT](LICENSE) © 2026 Nelson Melo
