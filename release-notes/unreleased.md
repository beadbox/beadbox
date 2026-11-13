# Unreleased

- Background windows now refresh immediately on the first change after opening a workspace or a quiet period, then coalesce ongoing changes into at most one tree refresh every 30 seconds. Returning to a window catches up immediately when changes are pending. Hidden changes defer other query and blocked-by health reads until the window is shown.
- Packaged smoke tests allow for the background refresh interval and verify a completed tree refetch, log change-to-refetch latency, and fail if live updates do not arrive.
