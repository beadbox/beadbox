// Self-update downloader hook (beadbox-l5i.6.4, cutover phase D).
//
// Drives the updater plugin's JS downloadAndInstall() directly. The Rust host
// command it used to invoke existed only to attach a PAT for the private
// repo; beadbox/beadbox is public, so the plugin fetches the asset
// anonymously. It still verifies the .sig against the bundled pubkey before
// installing — that verification is what makes an anonymous fetch safe, and it
// is unchanged.
//
// The event shape is identical to what the Rust Channel emitted
// (Started/Progress/Finished), so the switch below did not need touching.
//
// API note: startDownload() keeps its NO-argument contract. It re-runs check()
// to obtain the plugin's Update handle rather than threading one down from the
// checker, which keeps every call site unchanged for one extra round-trip.

import { useCallback, useState } from "react"
import { detectClientPlatform } from "@/lib/platform"

// Mirrors tauri-plugin-updater's own DownloadEvent. Note contentLength is
// OPTIONAL here, not nullable: the Rust host this replaced serialised it as
// `number | null`, the plugin emits `number | undefined`. The `?? 0` below
// covers both, but the type has to match the plugin or the callback is not
// assignable — typecheck caught this, which is the argument for having it.
type DownloadEvent =
  | { event: "Started"; data: { contentLength?: number } }
  | { event: "Progress"; data: { chunkLength: number } }
  | { event: "Finished" }

export type DownloadStatus = "idle" | "downloading" | "installing" | "installed" | "error"

interface DownloadProgress {
  downloaded: number
  total: number
}

interface UseUpdateDownloaderResult {
  status: DownloadStatus
  progress: DownloadProgress
  error: string | null
  filePath: string | null
  platform: string | null
  startDownload: () => Promise<void>
  cancelDownload: () => void
  install: () => Promise<void>
  reset: () => void
}

export function useUpdateDownloader(): UseUpdateDownloaderResult {
  const [status, setStatus] = useState<DownloadStatus>("idle")
  const [progress, setProgress] = useState<DownloadProgress>({ downloaded: 0, total: 0 })
  const [error, setError] = useState<string | null>(null)
  const platform = detectClientPlatform()

  const startDownload = useCallback(async (): Promise<void> => {
    setError(null)
    setProgress({ downloaded: 0, total: 0 })
    setStatus("downloading")

    try {
      let totalSize = 0
      let downloaded = 0

      const { check } = await import("@tauri-apps/plugin-updater")

      const update = await check()
      if (!update) {
        // Nothing to install. Distinct from a failure — see update-checker.ts
        // on why those two must not collapse into one state.
        setStatus("idle")
        return
      }

      // downloadAndInstall streams Started / Progress / Finished and installs
      // in place before resolving. After it resolves the new binary is staged;
      // the dialog auto-relaunches via its handleQuit useEffect when
      // status === "installed".
      const onEvent = (event: DownloadEvent) => {
        switch (event.event) {
          case "Started":
            totalSize = event.data.contentLength ?? 0
            setProgress({ downloaded: 0, total: totalSize })
            break
          case "Progress":
            downloaded += event.data.chunkLength
            setProgress({ downloaded, total: totalSize })
            break
          case "Finished":
            setStatus("installing")
            break
        }
      }

      await update.downloadAndInstall(onEvent)

      setStatus("installed")
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error("[updater] download_and_install failed:", err)
      setStatus("error")
      setError(msg)
    }
  }, [])

  const cancelDownload = useCallback((): void => {
    // tauri-plugin-updater 2.x does not expose a public cancel API for an
    // in-flight downloadAndInstall. Best we can do is mark the local state
    // idle so the dialog re-renders; the underlying download finishes in
    // the background and discards the result. Document this limitation.
    setStatus("idle")
    setError(null)
    setProgress({ downloaded: 0, total: 0 })
  }, [])

  const install = useCallback(async (): Promise<void> => {
    // No-op: downloadAndInstall already installed. The dialog's existing
    // useEffect picks up status === "installed" and triggers relaunch via
    // @tauri-apps/plugin-process. Exposed here only because the prior
    // (stub) API exported it.
  }, [])

  const reset = useCallback((): void => {
    setStatus("idle")
    setError(null)
    setProgress({ downloaded: 0, total: 0 })
  }, [])

  return {
    status,
    progress,
    error,
    filePath: null,
    platform,
    startDownload,
    cancelDownload,
    install,
    reset,
  }
}
