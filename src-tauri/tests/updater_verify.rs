//! Headless updater proof (beadbox-vxq; systemdesign §7.4, ADR-003).
//!
//! Drives the shipped tauri-plugin-updater on Tauri's mock runtime (no
//! window) with the shipped context, so the endpoint and minisign pubkey are
//! the ones in tauri.conf.json, and the plugin is registered exactly as in
//! lib.rs. `check()` fetches the live manifest and `download()` fetches the
//! bundle and verifies its signature before returning any bytes. `install()`
//! is never called and nothing is written: the bytes stay in memory.
//!
//! Every test is #[ignore] so `cargo test` and the coverage gate never touch
//! the network. Run them with:
//!
//!     cd src-tauri && cargo test --test updater_verify -- --ignored --nocapture

use std::cell::Cell;
use std::fmt;
use std::future::Future;
use std::time::Duration;

use tauri::test::{mock_builder, MockRuntime};
use tauri::App;
use tauri_plugin_updater::{Error, UpdaterExt};

const TIMEOUT: Duration = Duration::from_secs(120);
const ATTEMPTS: u32 = 3;

/// A minisign public key generated for this test only (key id
/// 841CB88CE3137E33). Its secret half was destroyed at generation and has
/// never signed anything, so no release can verify against it.
const THROWAWAY_PUBKEY: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXkgODQxQ0I4OENFMzEzN0UzMwpSV1F6ZmhQampMZ2NoQTJZN2JzNGxyaDEvSnJmWHRTRk1HUXpobEFPQlNEaE9sSmtJM0VjZHEwUAo=";

fn app() -> App<MockRuntime> {
    mock_builder()
        // The same registration line as lib.rs.
        .plugin(tauri_plugin_updater::Builder::new().build())
        .build(tauri::generate_context!())
        .expect("mock app from the shipped tauri.conf.json")
}

/// The shipped `plugins.updater` config.
fn updater_config(app: &App<MockRuntime>) -> serde_json::Value {
    app.config()
        .plugins
        .0
        .get("updater")
        .cloned()
        .expect("tauri.conf.json has plugins.updater")
}

fn shipped_endpoint(app: &App<MockRuntime>) -> String {
    updater_config(app)["endpoints"][0]
        .as_str()
        .expect("plugins.updater.endpoints[0]")
        .to_string()
}

fn shipped_pubkey(app: &App<MockRuntime>) -> String {
    updater_config(app)["pubkey"]
        .as_str()
        .expect("plugins.updater.pubkey")
        .to_string()
}

/// The comment line of a base64-encoded minisign public key, which names its
/// key id. Only used to print which key a run verified against.
fn key_comment(pubkey: &str) -> String {
    const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut bits = 0u32;
    let mut len = 0;
    let mut out = Vec::new();
    for c in pubkey.bytes().take_while(|&c| c != b'=') {
        let v = ALPHABET.iter().position(|&a| a == c).expect("base64 pubkey") as u32;
        bits = (bits << 6) | v;
        len += 6;
        if len >= 8 {
            len -= 8;
            out.push((bits >> len) as u8);
        }
    }
    String::from_utf8_lossy(&out).lines().next().unwrap_or_default().to_string()
}

struct Verified {
    url: String,
    version: String,
    bytes: usize,
    content_length: Option<u64>,
}

struct Failure {
    stage: &'static str,
    url: String,
    attempts: u32,
    error: Error,
}

impl fmt::Display for Failure {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "{} failed for {} after {} attempt(s): {:?} ({})",
            self.stage, self.url, self.attempts, self.error, self.error
        )
    }
}

/// Runs `op` up to ATTEMPTS times, retrying only transport errors. A
/// signature error is never retried, so a refusal can't be retried into a pass.
async fn with_retries<T, F, Fut>(op: F) -> (u32, Result<T, Error>)
where
    F: Fn() -> Fut,
    Fut: Future<Output = Result<T, Error>>,
{
    let mut attempt = 1;
    loop {
        match op().await {
            Err(e @ (Error::Network(_) | Error::Reqwest(_))) if attempt < ATTEMPTS => {
                eprintln!("attempt {attempt} failed, retrying: {e}");
                std::thread::sleep(Duration::from_secs(2 * u64::from(attempt)));
                attempt += 1;
            }
            result => return (attempt, result),
        }
    }
}

/// The plugin's own check() then download() for one manifest key, against the
/// shipped pubkey or the one given.
async fn verify(key: &str, pubkey: Option<&str>) -> Result<Verified, Failure> {
    let app = app();
    let endpoint = shipped_endpoint(&app);
    let manifest_failure = |attempts, error| Failure {
        stage: "manifest",
        url: endpoint.clone(),
        attempts,
        error,
    };

    let mut builder = app
        .updater_builder()
        .target(key)
        .version_comparator(|_, _| true)
        .timeout(TIMEOUT);
    if let Some(pubkey) = pubkey {
        builder = builder.pubkey(pubkey);
    }
    let updater = builder.build().map_err(|e| manifest_failure(0, e))?;

    let (attempts, checked) = with_retries(|| updater.check()).await;
    let mut update = match checked {
        Ok(Some(update)) => update,
        // With an always-true comparator, None means the endpoint sent 204.
        Ok(None) => return Err(manifest_failure(attempts, Error::ReleaseNotFound)),
        Err(e) => return Err(manifest_failure(attempts, e)),
    };
    // check() hands the Update no timeout (only the manifest fetch gets the
    // builder's), so the bundle download sets its own.
    update.timeout = Some(TIMEOUT);

    let content_length = Cell::new(None);
    let (update_ref, length_ref) = (&update, &content_length);
    let (attempts, downloaded) = with_retries(move || {
        update_ref.download(move |_, length| length_ref.set(length), || {})
    })
    .await;
    match downloaded {
        Ok(bytes) => Ok(Verified {
            url: update.download_url.to_string(),
            version: update.version.clone(),
            bytes: bytes.len(),
            content_length: content_length.get(),
        }),
        Err(error) => Err(Failure {
            stage: match error {
                Error::Minisign(_) | Error::Base64(_) | Error::SignatureUtf8(_) => "verify",
                _ => "download",
            },
            url: update.download_url.to_string(),
            attempts,
            error,
        }),
    }
}

fn positive(key: &str) {
    let app = app();
    println!(
        "{key}: manifest {} | pubkey \"{}\"",
        shipped_endpoint(&app),
        key_comment(&shipped_pubkey(&app))
    );
    let verified = tauri::async_runtime::block_on(verify(key, None))
        .unwrap_or_else(|failure| panic!("{key}: {failure}"));
    let content_length = verified
        .content_length
        .unwrap_or_else(|| panic!("{key}: {} sent no Content-Length", verified.url));
    assert_eq!(
        verified.bytes as u64, content_length,
        "{key}: {} returned {} bytes, Content-Length {content_length}",
        verified.url, verified.bytes
    );
    println!(
        "{key}: v{} {} verified, {} bytes (Content-Length {content_length})",
        verified.version, verified.url, verified.bytes
    );
}

#[test]
#[ignore = "network: fetches the live release"]
fn darwin_aarch64_bundle_verifies() {
    positive("darwin-aarch64");
}

#[test]
#[ignore = "network: fetches the live release"]
fn linux_x86_64_bundle_verifies() {
    positive("linux-x86_64");
}

#[test]
#[ignore = "network: fetches the live release"]
fn wrong_pubkey_is_refused() {
    let key = "darwin-aarch64";
    assert_ne!(
        key_comment(THROWAWAY_PUBKEY),
        key_comment(&shipped_pubkey(&app())),
        "the throwaway key must not be the shipped key"
    );
    println!("{key}: pubkey \"{}\"", key_comment(THROWAWAY_PUBKEY));
    match tauri::async_runtime::block_on(verify(key, Some(THROWAWAY_PUBKEY))) {
        Err(Failure {
            error: Error::Minisign(e),
            url,
            ..
        }) => println!("{key}: {url} refused: Minisign({e:?}): {e}"),
        Err(failure) => panic!("{key}: expected Error::Minisign, got: {failure}"),
        Ok(verified) => panic!(
            "{key}: {} verified against the throwaway key ({} bytes)",
            verified.url, verified.bytes
        ),
    }
}
