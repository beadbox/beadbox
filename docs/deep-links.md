# Deep links

`beadbox://bead/<id>` opens a bead in Beadbox, so a bead id in a terminal, a note, a chat or a commit message can be a link.

```
beadbox://bead/beadbox-d6l.2
```

- The app comes to the front and shows that bead, whether it was already running or the link launched it.
- Only the `bead` host and one id are accepted. The id may hold letters, digits, `-`, `_` and `.` (at most 128 characters, not starting with `.`); anything else is ignored. The Rust host validates the link (`src-tauri/src/deep_link.rs`) and the page checks the id again (`packages/client/src/lib/deep-link.ts`) before using it.
- The bead is looked up in the workspace that is open. A link does not switch workspaces.
- The page gets no new permission: the plugin's own page-side commands are not granted (the capability list is unchanged); links reach the page through one app command, `take_pending_open`, and one event.
- macOS registers the scheme from the app bundle (`CFBundleURLTypes`, written from `plugins.deep-link` in `tauri.conf.json`), so it works from the installed app. A second launch on Windows and Linux hands its link to the running app (single-instance plugin).
- On macOS the host writes one line to the unified log for each link: `[beadbox] deep link: opening bead <id>` or `deep link refused`.

Try it: `open "beadbox://bead/<id>"`.
