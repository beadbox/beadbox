// Workspace display-label change notifications.
//
// The registry (~/.beadbox/registry.json, written via
// rpc.workspaces.setWorkspaceLabel) is the source of truth for a
// workspace's name and tab emoji. Every surface that already holds a
// resolved Workspace object in local state — the rail, home-page's
// lifecycle hook, activity-page, formulas-view and the Header they render
// — would otherwise keep showing the pre-rename label until the next
// workspace switch or app restart.
//
// So the writer publishes the accepted label here right after the registry
// write, and those consumers patch the workspace objects they hold. This
// is a propagation channel, not a second store: a fresh workspace list
// read returns exactly the same values.
//
// Same shape as workspace-cookie.ts's pub/sub (module-scoped EventTarget)
// for the same reason: single-window Tauri app, no cross-tab concerns.

export interface WorkspaceLabelChange {
  workspaceId: string
  name: string
  /** undefined = no emoji (cleared or never set). */
  icon?: string
}

const LABEL_CHANGE_EVENT = "workspace-label-change"
const workspaceLabelEvents = new EventTarget()

export function publishWorkspaceLabel(change: WorkspaceLabelChange): void {
  workspaceLabelEvents.dispatchEvent(
    new CustomEvent<WorkspaceLabelChange>(LABEL_CHANGE_EVENT, { detail: change }),
  )
}

/**
 * Subscribe to workspace label changes. Returns an unsubscribe function.
 * The listener receives the change that was just published.
 */
export function subscribeWorkspaceLabels(
  listener: (change: WorkspaceLabelChange) => void,
): () => void {
  const handler = (event: Event) => {
    listener((event as CustomEvent<WorkspaceLabelChange>).detail)
  }
  workspaceLabelEvents.addEventListener(LABEL_CHANGE_EVENT, handler)
  return () => {
    workspaceLabelEvents.removeEventListener(LABEL_CHANGE_EVENT, handler)
  }
}
