// Active workspace persistence.
//
// bb-qn71 (P1 v0.25-rc.4 header regression): the legacy v0.24 era stored the
// active workspace via document.cookie under http://localhost:PORT (Next.js
// custom server). v0.25's Vite SPA loads via tauri://localhost — the asset
// protocol — where document.cookie writes don't persist (custom URL schemes
// don't share the HTTP cookie store). Reads were always returning null,
// causing useWorkspaceLifecycle to fall through to initialWorkspaces[0]
// (registry order = "beadbox" first for Nelson) regardless of which
// workspace the user picked. localStorage works under tauri:// (per-origin
// storage; tauri://localhost is a stable origin).
//
// The function names are kept as `*Cookie` for callsite stability across
// the migration; only the storage backend moved. A future cleanup bead
// could rename to *ActiveWorkspace for clarity.
//
// bb-onv3.2: setWorkspaceCookie / clearWorkspaceCookie now dispatch on a
// module-scoped EventTarget so consumers can re-react to workspace switches
// without polling. routes/__root.tsx ChangeSubscriptionMount is the load-
// bearing consumer — without this, its useEffect deps [workspaces] don't
// re-fire on cookie writes (workspaces array reference unchanged) and the
// change-detector subscription stays pinned to whichever workspace was
// resolved first. The 'storage' DOM event is cross-tab only and Beadbox is
// a single-window Tauri app, so we synthesize our own pub/sub here.

import { resetLabelFilterPreference } from "./local-storage"

const WORKSPACE_KEY = "beads-workspace"
const COOKIE_CHANGE_EVENT = "workspace-cookie-change"

const workspaceCookieEvents = new EventTarget()

export function getWorkspaceCookie(): string | null {
  if (typeof localStorage === "undefined") return null
  try {
    return localStorage.getItem(WORKSPACE_KEY)
  } catch {
    return null
  }
}

export function setWorkspaceCookie(workspaceId: string): void {
  if (typeof localStorage === "undefined") return
  try {
    const previous = localStorage.getItem(WORKSPACE_KEY)
    localStorage.setItem(WORKSPACE_KEY, workspaceId)
    if (previous !== null && previous !== workspaceId) {
      resetLabelFilterPreference()
    }
    workspaceCookieEvents.dispatchEvent(new Event(COOKIE_CHANGE_EVENT))
  } catch {
    /* localStorage might be full or disabled */
  }
}

export function clearWorkspaceCookie(): void {
  if (typeof localStorage === "undefined") return
  try {
    const previous = localStorage.getItem(WORKSPACE_KEY)
    localStorage.removeItem(WORKSPACE_KEY)
    if (previous !== null) {
      resetLabelFilterPreference()
    }
    workspaceCookieEvents.dispatchEvent(new Event(COOKIE_CHANGE_EVENT))
  } catch {
    /* tolerable during teardown */
  }
}

/**
 * Subscribe to workspace-cookie changes. The listener fires AFTER each
 * setWorkspaceCookie / clearWorkspaceCookie write. Returns an unsubscribe
 * function. The listener receives no arguments — read getWorkspaceCookie()
 * inside the listener to get the current value.
 *
 * Used by routes/__root.tsx:ChangeSubscriptionMount to re-resolve the
 * active databasePath on every workspace switch (bb-onv3.2 fix).
 */
export function subscribeWorkspaceCookie(listener: () => void): () => void {
  workspaceCookieEvents.addEventListener(COOKIE_CHANGE_EVENT, listener)
  return () => {
    workspaceCookieEvents.removeEventListener(COOKIE_CHANGE_EVENT, listener)
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isValidWorkspaceCookie(value: string): boolean {
  return UUID_RE.test(value)
}
