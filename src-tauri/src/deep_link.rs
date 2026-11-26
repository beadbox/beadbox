//! `beadbox://` deep links: `beadbox://bead/<id>` opens that bead in the running (or launching) app.
//!
//! The URL comes from outside the app (a browser, a terminal, a note), so it is validated here, in
//! Rust, before anything reaches the page: only the `beadbox` scheme, only the `bead` host, exactly
//! one path segment, and only the characters a bead id is made of. The page is handed the bare id.

use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

/// The longest bead id accepted (ids are short: `auto-eeb`, `beadbox-d6l.2`).
pub const MAX_ID_LEN: usize = 128;

/// What a deep link asks for.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct OpenBead {
    pub id: String,
}

/// The link that arrived before the page could listen (a cold start from a link): the page asks for it once
/// it is ready, and every later link is handed over the same way after an event.
#[derive(Default)]
pub struct PendingOpen(pub Mutex<Option<OpenBead>>);

fn id_char_ok(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.'
}

/// `beadbox://bead/<id>` -> the id; anything else -> None.
pub fn parse(raw: &str) -> Option<OpenBead> {
    let url = tauri::Url::parse(raw).ok()?;
    if url.scheme() != "beadbox" || url.host_str() != Some("bead") {
        return None;
    }
    if url.username() != "" || url.password().is_some() || url.port().is_some() {
        return None;
    }
    let mut segments = url.path_segments()?;
    let id = segments.next()?;
    match segments.next() {
        None | Some("") if segments.next().is_none() => {} // one segment, with or without a trailing slash
        _ => return None,
    }
    if id.is_empty() || id.len() > MAX_ID_LEN || !id.chars().all(id_char_ok) || id.starts_with('.')
    {
        return None;
    }
    Some(OpenBead { id: id.to_string() })
}

/// Remember the request, bring the window forward and tell the page.
pub fn handle(app: &AppHandle, urls: &[tauri::Url]) {
    let Some(open) = urls.iter().rev().find_map(|u| parse(u.as_str())) else {
        #[cfg(target_os = "macos")]
        crate::log_unified(&format!(
            "deep link refused ({} url(s) received)",
            urls.len()
        ));
        return;
    };
    #[cfg(target_os = "macos")]
    crate::log_unified(&format!("deep link: opening bead {}", open.id));
    if let Some(pending) = app.try_state::<PendingOpen>() {
        if let Ok(mut slot) = pending.0.lock() {
            *slot = Some(open.clone());
        }
    }
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
    let _ = app.emit("beadbox-open-bead", open);
}

/// The page calls this once on start and after each `beadbox-open-bead` event; it clears the request.
#[tauri::command]
pub fn take_pending_open(pending: tauri::State<'_, PendingOpen>) -> Option<OpenBead> {
    pending.0.lock().ok().and_then(|mut slot| slot.take())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn id(raw: &str) -> Option<String> {
        parse(raw).map(|o| o.id)
    }

    #[test]
    fn a_bead_link_gives_its_id() {
        assert_eq!(id("beadbox://bead/auto-eeb").as_deref(), Some("auto-eeb"));
        assert_eq!(
            id("beadbox://bead/beadbox-d6l.2").as_deref(),
            Some("beadbox-d6l.2")
        );
        assert_eq!(id("beadbox://bead/auto-eeb/").as_deref(), Some("auto-eeb"));
    }

    #[test]
    fn another_scheme_host_or_shape_is_refused() {
        assert_eq!(id("https://bead/auto-eeb"), None);
        assert_eq!(id("beadbox://workspace/auto-eeb"), None);
        assert_eq!(id("beadbox://bead"), None);
        assert_eq!(id("beadbox://bead/"), None);
        assert_eq!(id("beadbox://bead/a/b"), None);
        assert_eq!(id("beadbox://user@bead/auto-eeb"), None);
        assert_eq!(id("beadbox://bead:80/auto-eeb"), None);
        assert_eq!(id("not a url"), None);
    }

    #[test]
    fn an_id_with_anything_but_id_characters_is_refused() {
        assert_eq!(id("beadbox://bead/auto%20eeb"), None);
        assert_eq!(id("beadbox://bead/auto-eeb%3Bls"), None);
        assert_eq!(id("beadbox://bead/..%2Fsecret"), None);
        assert_eq!(id("beadbox://bead/.hidden"), None);
        assert_eq!(id("beadbox://bead/a$(x)"), None);
        let long = format!("beadbox://bead/{}", "a".repeat(MAX_ID_LEN + 1));
        assert_eq!(id(&long), None);
        assert!(id(&format!("beadbox://bead/{}", "a".repeat(MAX_ID_LEN))).is_some());
    }

    #[test]
    fn a_query_or_fragment_is_ignored_not_trusted() {
        assert_eq!(
            id("beadbox://bead/auto-eeb?x=1#frag").as_deref(),
            Some("auto-eeb")
        );
    }
}
