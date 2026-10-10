// beadbox-z04: shown when WebKit kept terminating the page's content process
// and the host stopped reloading it (3 reloads in 10 minutes, see
// src-tauri/src/lib.rs). The host navigates to the app's own page with
// `stopped=1`; main.tsx then renders only this, with no sidecar and no router,
// so there is nothing left to grow and be killed again.

export const STOPPED_PAGE_MESSAGE = "Beadbox's page stopped responding. Quit and reopen Beadbox."

export function isStoppedPage(search: string): boolean {
  return new URLSearchParams(search).get("stopped") === "1"
}

export function StoppedPage() {
  return (
    <main className="flex h-screen items-center justify-center bg-background p-8 text-foreground">
      <p className="max-w-md text-center text-sm">{STOPPED_PAGE_MESSAGE}</p>
    </main>
  )
}
