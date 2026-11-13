# Unreleased

- Background windows now coalesce data changes into at most one tree refresh every 30 seconds, keeping boards fresh while limiting refresh work. Returning to a window still catches up immediately.
- Packaged smoke tests allow for the background refresh interval and fail if live updates do not arrive.
