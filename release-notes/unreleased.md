## Added

- Filter beads by any selected label, together with status, search, and the other filters. Label choices are available in Beads, Chart, and All projects. Selections persist on reload and clear when switching workspaces from Beads or Chart. Thanks to [Kyle Dodson (@seniorquico)](https://github.com/seniorquico) for requesting this in [#70](https://github.com/beadbox/beadbox/issues/70).

## Fixed

- Status, type, workspace summary, epic status, and molecule progress reads now pass both `--readonly` and `--sandbox` to bd to suppress auto-push, including on bd 1.1.0. Thanks to [Bart Wegrzyn (@bwegrzyn)](https://github.com/bwegrzyn) for diagnosing the status-refresh push race and contributing the initial fix in [#71](https://github.com/beadbox/beadbox/pull/71).
- Reduce memory pressure on busy boards by coalescing refreshes and reusing unchanged rows and markdown, while keeping workspace switches and deadline displays current.

## Added

- Find bd installed through mise, asdf, or Nix, and choose a persistent bd executable path from Settings or the missing/too-old bd screens. The active path and any `BD_PATH` environment override are shown. Thanks to [Karl Q. (@kquinsland01)](https://github.com/kquinsland01) for requesting this in [#69](https://github.com/beadbox/beadbox/issues/69).
