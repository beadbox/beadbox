// ⌘1–⌘6 view switching for pages without their own key handler (Chart,
// Trains, Waiting). Beads, Activity and Formulas keep their existing handlers.

const ROUTES: Record<string, string> = {
  "1": "/",
  "2": "/activity",
  "3": "/formulas",
  "4": "/trains",
  "5": "/chart",
  "6": "/waiting",
}

export interface ViewSwitchContext {
  push: (to: string) => void
  hasTrains: boolean
  hasWaiting: boolean
}

// Returns true when the event was a view-switch shortcut (handled or not).
export function tryViewSwitchShortcut(e: KeyboardEvent, ctx: ViewSwitchContext): boolean {
  if (!(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey) return false
  const to = ROUTES[e.key]
  if (!to) return false
  e.preventDefault()
  if (to === "/trains" && !ctx.hasTrains) return true
  if (to === "/waiting" && !ctx.hasWaiting) return true
  ctx.push(to)
  return true
}
