## Added

- Filter beads by label from the filter bar across the Beads, Chart, and All projects views: select one or more workspace labels to show beads carrying any selected label while preserving parent context, composing with status, type, priority, assignee, and search, persisting within a workspace, and resetting cleanly when switching workspaces. Suggested by [Kyle Dodson (@seniorquico)](https://github.com/seniorquico) in [#70](https://github.com/beadbox/beadbox/issues/70).

## Fixed

- Status, type, workspace summary, epic status, and molecule progress reads now pass both `--readonly` and `--sandbox` to bd to suppress auto-push, including on bd 1.1.0. Thanks to [Bart Wegrzyn (@bwegrzyn)](https://github.com/bwegrzyn) for diagnosing the status-refresh push race and contributing the initial fix in [#71](https://github.com/beadbox/beadbox/pull/71).
- Reduce memory pressure on busy boards by coalescing refreshes and reusing unchanged rows and markdown, while keeping workspace switches and deadline displays current.
