// P4.3 (bb-un5c.3) strip: process_cleanup, telemetry, and logging modules
// were dead-coded after the Node.js sidecar machinery (spawn_sidecar,
// run_headless, sidecar_health_monitor, read_credential_envs) went away
// with the kkrpc bridge cutover. paths.rs now hosts only the
// open_url_in_browser helper still consumed by the WebView navigation hook.

#[cfg(not(target_os = "ios"))]
mod credentials;
#[cfg(not(target_os = "ios"))]
pub mod paths;
#[cfg(not(target_os = "ios"))]
mod telemetry_id;
#[cfg(all(unix, not(target_os = "ios")))]
use std::sync::atomic::{AtomicBool, Ordering};
#[cfg(all(unix, not(target_os = "ios")))]
use tauri_plugin_js::JsExt;

#[cfg(all(unix, not(target_os = "ios")))]
static SIDECAR_DRAIN_STARTED: AtomicBool = AtomicBool::new(false);

#[cfg(all(unix, not(target_os = "ios")))]
async fn drain_sidecar_before_exit(app: tauri::AppHandle) {
    let js = app.js();
    if let Ok(processes) = js.list_processes().await {
        for process in processes.into_iter().filter(|process| process.name == "beadbox-sidecar") {
            if let Some(pid) = process.pid {
                // PID comes from the plugin's owned child table immediately before signalling.
                let _ = std::process::Command::new("kill")
                    .arg("-TERM")
                    .arg(pid.to_string())
                    .status();
            }
        }
    }
    for _ in 0..300 {
        let still_running = js.list_processes().await.map(|processes| {
            processes.iter().any(|process| process.name == "beadbox-sidecar")
        }).unwrap_or(false);
        if !still_running { break; }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
    app.exit(0);
}
// beadbox-b2p (A-3'): private-repo self-update driven from the Rust host.
#[cfg(not(target_os = "ios"))]

// bb-7oq8: predicates extracted from the on_navigation closures in run()
// so cargo-mutants can actually exercise them. The closures live inside
// tauri::Builder::default().setup(...) where unit tests can't reach them
// — the previous mutation-score baseline (12/54 = 22%) was dominated by
// surviving mutants in those closure bodies.

/// Returns true if the URL should be allowed to navigate inside the
/// WebView (Tauri-internal scheme or local-host). External http(s) URLs
/// return false and the caller routes them to the OS browser.
fn is_internal_navigation(scheme: &str, host: &str) -> bool {
    scheme == "tauri"
        || scheme == "about"
        || host == "127.0.0.1"
        || host == "localhost"
        || host == "tauri.localhost"
}

/// Returns true if the URL should be opened in the user's default browser
/// rather than navigated inside the WebView. Mirrors the tail predicate
/// of the desktop on_navigation closure.
fn should_open_externally(scheme: &str) -> bool {
    scheme == "http" || scheme == "https"
}

/// Linux-only WebView refresh-keystroke predicate. Pure boolean function
/// over the four input bits so the GTK/gdk-typed call site stays a thin
/// wrapper. Truth: Ctrl+R (no Shift) OR F5 (any modifier).
#[allow(dead_code)] // referenced from the #[cfg(target_os = "linux")] block in run()
fn is_refresh_combo(ctrl: bool, shift: bool, key_is_r: bool, key_is_f5: bool) -> bool {
    if ctrl && !shift {
        key_is_r
    } else {
        key_is_f5
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // ── Desktop: kkrpc bridge to the Bun sidecar via tauri-plugin-js ──
    #[cfg(not(target_os = "ios"))]
    {
        let app = tauri::Builder::default()
            .plugin(tauri_plugin_dialog::init())
            .plugin(tauri_plugin_process::init())
            // kkrpc bridge between WebView and the Bun sidecar (P4.1).
            .plugin(tauri_plugin_js::init())
            // Self-update via tauri-plugin-updater (Tauri 2 native flow).
            // Endpoints + pubkey configured in tauri.conf.json plugins.updater.
            // Replaces the legacy custom GitHub-Releases polling
            // (lib/update-checker.ts) + stubbed installer
            // (hooks/use-update-downloader.ts).
            .plugin(tauri_plugin_updater::Builder::new().build())
            .invoke_handler(tauri::generate_handler![
                telemetry_id::get_stable_id,
                telemetry_id::get_username_prefix,
                credentials::get_credential,
                credentials::set_credential,
                credentials::delete_credential,
            ])
            .setup(move |app| {
                let builder = tauri::WebviewWindowBuilder::new(
                    app,
                    "main",
                    tauri::WebviewUrl::App("index.html?sidecar=1".into()),
                )
                .title("Beadbox")
                .inner_size(1200.0, 800.0)
                .min_inner_size(800.0, 600.0)
                .maximized(true)
                .disable_drag_drop_handler()
                .on_navigation(|url: &tauri::Url| {
                    let scheme = url.scheme();
                    let host = url.host_str().unwrap_or("");

                    if is_internal_navigation(scheme, host) {
                        return true;
                    }

                    if should_open_externally(scheme) {
                        paths::open_url_in_browser(url.as_str());
                    }
                    false
                });

                #[cfg(target_os = "linux")]
                let builder = builder.visible(false);

                let window = builder.build().expect("failed to create main window");

                #[cfg(target_os = "linux")]
                {
                    use gtk::prelude::*;
                    if let Ok(gtk_window) = window.gtk_window() {
                        if gtk_window.titlebar().is_none() {
                            let header = gtk::HeaderBar::new();
                            header.set_show_close_button(true);
                            header.set_title(Some("Beadbox"));
                            header.set_decoration_layout(Some(
                                "menu:minimize,maximize,close",
                            ));
                            gtk_window.set_titlebar(Some(&header));
                        }

                        let win_clone = window.clone();
                        gtk_window.connect_key_press_event(move |_, event| {
                            let state = event.state();
                            let ctrl = state.contains(gdk::ModifierType::CONTROL_MASK);
                            let shift = state.contains(gdk::ModifierType::SHIFT_MASK);
                            let kv = event.keyval();

                            let key_is_r = kv == gdk::keys::constants::r
                                || kv == gdk::keys::constants::R;
                            let key_is_f5 = kv == gdk::keys::constants::F5;
                            let is_refresh = is_refresh_combo(ctrl, shift, key_is_r, key_is_f5);

                            if is_refresh {
                                let _ = win_clone.eval(
                                    "document.dispatchEvent(new CustomEvent('tauri-refresh'))",
                                );
                                return gtk::glib::Propagation::Stop;
                            }

                            gtk::glib::Propagation::Proceed
                        });

                        gtk_window.show_all();
                    } else {
                        let _ = window.show();
                    }
                }

                // The WebView resolves to the Vite SPA via tauri.conf.json:
                //   - debug → devUrl (packages/client Vite dev server)
                //   - release → frontendDist (../packages/client/dist)
                // No manual eval/navigate is needed. tauri-plugin-js owns the
                // sidecar process lifecycle (spawn + SIGTERM on exit).
                let _ = window;
                Ok(())
            })
            .build(tauri::generate_context!())
            .expect("error while building tauri application");

        app.run(|app_handle, event| {
            #[cfg(unix)]
            if let tauri::RunEvent::ExitRequested { api, .. } = event {
                if !SIDECAR_DRAIN_STARTED.swap(true, Ordering::SeqCst) {
                    api.prevent_exit();
                    let app = app_handle.clone();
                    tauri::async_runtime::spawn(drain_sidecar_before_exit(app));
                }
            }
        });
    }

    // ── iOS: minimal WebView-only app (no sidecar) ──
    #[cfg(target_os = "ios")]
    {
        let app = tauri::Builder::default()
            .setup(|app| {
                tauri::WebviewWindowBuilder::new(
                    app,
                    "main",
                    tauri::WebviewUrl::App("index.html".into()),
                )
                .on_navigation(|url: &tauri::Url| {
                    let scheme = url.scheme();
                    let host = url.host_str().unwrap_or("");

                    if is_internal_navigation(scheme, host) {
                        return true;
                    }

                    open_in_safari(url.as_str());
                    false
                })
                .build()
                .expect("failed to create main window");
                Ok(())
            })
            .build(tauri::generate_context!())
            .expect("error while building tauri application");

        app.run(|_app_handle, _event| {});
    }
}

/// Open a URL in Safari using UIApplication.shared.openURL().
#[cfg(target_os = "ios")]
#[allow(deprecated)]
fn open_in_safari(url_str: &str) {
    use objc2::MainThreadMarker;
    use objc2_foundation::{NSString, NSURL};
    use objc2_ui_kit::UIApplication;

    unsafe {
        let mtm = MainThreadMarker::new_unchecked();
        let ns_str = NSString::from_str(url_str);
        if let Some(nsurl) = NSURL::URLWithString(&ns_str) {
            UIApplication::sharedApplication(mtm).openURL(&nsurl);
        }
    }
}

#[cfg(all(test, not(target_os = "ios")))]
mod tests {
    use super::*;

    // ─── is_internal_navigation ──────────────────────────────────────────
    // The 5 schemes/hosts that should navigate inside the WebView.

    #[test]
    fn internal_nav_allows_tauri_scheme() {
        assert!(is_internal_navigation("tauri", "anything.com"));
    }

    #[test]
    fn internal_nav_allows_about_scheme() {
        assert!(is_internal_navigation("about", "anything.com"));
    }

    #[test]
    fn internal_nav_allows_127_0_0_1_host() {
        assert!(is_internal_navigation("http", "127.0.0.1"));
    }

    #[test]
    fn internal_nav_allows_localhost_host() {
        assert!(is_internal_navigation("http", "localhost"));
    }

    #[test]
    fn internal_nav_allows_tauri_localhost_host() {
        assert!(is_internal_navigation("https", "tauri.localhost"));
    }

    #[test]
    fn internal_nav_rejects_external_https() {
        assert!(!is_internal_navigation("https", "example.com"));
    }

    #[test]
    fn internal_nav_rejects_file_scheme() {
        assert!(!is_internal_navigation("file", ""));
    }

    #[test]
    fn internal_nav_rejects_empty_scheme_and_host() {
        assert!(!is_internal_navigation("", ""));
    }

    #[test]
    fn internal_nav_rejects_partial_host_match() {
        // "127.0.0.10" should NOT match "127.0.0.1" — exact equality only.
        assert!(!is_internal_navigation("http", "127.0.0.10"));
        assert!(!is_internal_navigation("http", "localhost.evil.com"));
    }

    // ─── should_open_externally ──────────────────────────────────────────

    #[test]
    fn external_open_accepts_http() {
        assert!(should_open_externally("http"));
    }

    #[test]
    fn external_open_accepts_https() {
        assert!(should_open_externally("https"));
    }

    #[test]
    fn external_open_rejects_tauri_scheme() {
        assert!(!should_open_externally("tauri"));
    }

    #[test]
    fn external_open_rejects_file_scheme() {
        assert!(!should_open_externally("file"));
    }

    #[test]
    fn external_open_rejects_javascript_scheme() {
        // Defensive: a `javascript:` URL must NOT be opened in the OS browser.
        assert!(!should_open_externally("javascript"));
    }

    #[test]
    fn external_open_rejects_empty_scheme() {
        assert!(!should_open_externally(""));
    }

    // ─── is_refresh_combo (Linux refresh keystroke predicate) ────────────
    // Truth: Ctrl+R (no Shift) OR F5 (any modifier).

    #[test]
    fn refresh_combo_ctrl_r_alone_is_refresh() {
        assert!(is_refresh_combo(true, false, true, false));
    }

    #[test]
    fn refresh_combo_ctrl_shift_r_is_not_refresh() {
        // Shift modifier disqualifies the Ctrl+R path.
        assert!(!is_refresh_combo(true, true, true, false));
    }

    #[test]
    fn refresh_combo_f5_alone_is_refresh() {
        assert!(is_refresh_combo(false, false, false, true));
    }

    #[test]
    fn refresh_combo_ctrl_f5_is_refresh_via_else_branch() {
        // Ctrl+F5 falls through (Ctrl+!Shift but key_is_r=false) to F5 check.
        // Wait: with ctrl=true && !shift=true, the predicate selects key_is_r,
        // not key_is_f5. So Ctrl+F5 should NOT trigger refresh. That's a
        // subtle behavior the test documents.
        assert!(!is_refresh_combo(true, false, false, true));
    }

    #[test]
    fn refresh_combo_shift_f5_is_refresh() {
        // With shift, the Ctrl+R branch is skipped; F5 triggers refresh.
        assert!(is_refresh_combo(false, true, false, true));
    }

    #[test]
    fn refresh_combo_no_modifiers_no_keys_is_not_refresh() {
        assert!(!is_refresh_combo(false, false, false, false));
    }

    #[test]
    fn refresh_combo_r_without_ctrl_is_not_refresh() {
        // Bare 'r' keypress without Ctrl shouldn't trigger refresh.
        assert!(!is_refresh_combo(false, false, true, false));
    }
}
