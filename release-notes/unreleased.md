## Added

- Each bead row now shows its size, XS, S, M or L, where the estimate stopwatch used to be, so a long list reads at a glance. The size follows the estimate in minutes (XS under 15, S under 60, M up to 180, L above), and a revised estimate recorded on the bead takes its place. A bead with no estimate shows a plain "?" mark instead of a guessed size. The tooltip still gives the estimate itself.
- Background windows now refresh immediately on the first change after opening a workspace or a quiet period, then coalesce ongoing changes into at most one tree refresh every 30 seconds. Returning to a window catches up immediately when changes are pending. Hidden changes defer other query and blocked-by health reads until the window is shown.
- Packaged smoke tests allow for the background refresh interval and verify a completed tree refetch, log change-to-refetch latency, and fail if live updates do not arrive.
