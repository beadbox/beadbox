// Whether the native Tauri shell is present. Native-feature sites (dialogs,
// updater, relaunch, keychain, PostHog platform) ask this. Sites that only
// need a sidecar to talk to ask hasSidecarTransport() in
// ./sidecar-transport instead, which is also true in a headless test build
// (beadbox-r72.2). Kept in its own module so the transport seam can use it
// without importing rpc.ts.
export function isTauriRuntime(): boolean {
  if (typeof window === "undefined") return false
  return (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ != null
}
