## Added

- Find `bd` automatically in `mise`, `asdf`, and `nix` shim and profile directories, and let users set or reset a custom per-user `bd` executable path in Settings and on missing- or outdated-`bd` screens ([#69](https://github.com/beadbox/beadbox/issues/69)).

## Fixed

- Status, type, workspace summary, epic status, and molecule progress reads now pass both `--readonly` and `--sandbox` to bd to suppress auto-push, including on bd 1.1.0. Thanks to [Bart Wegrzyn (@bwegrzyn)](https://github.com/bwegrzyn) for diagnosing the status-refresh push race and contributing the initial fix in [#71](https://github.com/beadbox/beadbox/pull/71).
- Reduce memory pressure on busy boards by coalescing refreshes and reusing unchanged rows and markdown, while keeping workspace switches and deadline displays current.
