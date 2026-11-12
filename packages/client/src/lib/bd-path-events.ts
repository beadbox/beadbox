// Notifications when the per-user bd executable path setting changes
// (~/.beadbox/settings.json). Consumers (StartupGate's BdHealthContext,
// Settings > Help > System, and BdPathControl instances) re-query
// rpc.health.getBdPathInfo() so live views adopt the new binary and version
// without restarting Beadbox.

const BD_PATH_CHANGE_EVENT = "bd-path-change"
const bdPathEvents = new EventTarget()

export function publishBdPathChange(): void {
  bdPathEvents.dispatchEvent(new Event(BD_PATH_CHANGE_EVENT))
}

export function subscribeBdPathChange(listener: () => void): () => void {
  const handler = () => {
    listener()
  }
  bdPathEvents.addEventListener(BD_PATH_CHANGE_EVENT, handler)
  return () => {
    bdPathEvents.removeEventListener(BD_PATH_CHANGE_EVENT, handler)
  }
}
