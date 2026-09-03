// Workspace registry membership change notifications.
//
// Sibling of workspace-labels.ts, for the same underlying reason: a
// registry write (~/.beadbox/registry.json) produces no bd change signal,
// so nothing tells the other mounted surfaces that the set of workspaces
// itself changed. Labels already had this channel; adding and removing did
// not, and the surfaces disagreed:
//
//   - Adding from the /workspaces dashboard updated only that page's cards.
//     The rail kept its stale list until the next bd subscription bump (a
//     poll, hence "it shows up if I wait"), because the rail's own add
//     button was the only path that called its refresh.
//   - Removing from the beads view or the dashboard left the rail showing a
//     tab for an entry that no longer existed.
//
// Publishers are the membership mutations: both workspace dialogs and
// unregisterWorkspace. Consumers re-read the registry — this carries no
// payload precisely so it cannot drift from what a fresh read returns.
//
// Same shape as workspace-cookie.ts / workspace-labels.ts (module-scoped
// EventTarget): single-window Tauri app, no cross-tab concerns.

const REGISTRY_CHANGE_EVENT = "workspace-registry-change"
const workspaceRegistryEvents = new EventTarget()

/**
 * Announce that the set of registered workspaces changed. Call after the
 * registry write has succeeded, so every consumer's re-read observes it.
 */
export function publishWorkspaceRegistryChange(): void {
  workspaceRegistryEvents.dispatchEvent(new Event(REGISTRY_CHANGE_EVENT))
}

/**
 * Subscribe to registry membership changes. Returns an unsubscribe function.
 */
export function subscribeWorkspaceRegistryChange(listener: () => void): () => void {
  const handler = () => {
    listener()
  }
  workspaceRegistryEvents.addEventListener(REGISTRY_CHANGE_EVENT, handler)
  return () => {
    workspaceRegistryEvents.removeEventListener(REGISTRY_CHANGE_EVENT, handler)
  }
}
