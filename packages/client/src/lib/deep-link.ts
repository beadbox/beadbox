/**
 * beadbox://bead/<id> deep links, as the page sees them. The Rust host validates the link and keeps the request;
 * the page asks for it once on start (a link that launched the app) and again after each `beadbox-open-bead`
 * event (a link that arrived while the app was running). Outside the Tauri shell this does nothing.
 */

export const OPEN_BEAD_EVENT = "beadbox-open-bead"

const BEAD_ID = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/

function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window
}

/** The id from a host answer, or null when it is not a bead id (the page never trusts what it is handed). */
export function beadIdFrom(answer: unknown): string | null {
  const id = (answer as { id?: unknown } | null)?.id
  return typeof id === "string" && BEAD_ID.test(id) ? id : null
}

/** Tell `onOpen` the id of every bead a deep link asks for, now and later. Returns the unsubscribe. */
export function subscribeDeepLinks(onOpen: (id: string) => void): () => void {
  if (!isTauri()) return () => {}
  let live = true
  let unlisten: (() => void) | null = null

  const take = async () => {
    try {
      const { invoke } = await import("@tauri-apps/api/core")
      const id = beadIdFrom(await invoke("take_pending_open"))
      if (live && id) onOpen(id)
    } catch (err) {
      console.warn("[deep-link] could not read the pending link:", err)
    }
  }

  void (async () => {
    try {
      const { listen } = await import("@tauri-apps/api/event")
      const off = await listen(OPEN_BEAD_EVENT, () => void take())
      if (live) unlisten = off
      else off()
    } catch (err) {
      console.warn("[deep-link] could not listen for links:", err)
    }
    await take()
  })()

  return () => {
    live = false
    unlisten?.()
  }
}
