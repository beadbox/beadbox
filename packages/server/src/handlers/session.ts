// beadbox-z04: the page session. When WebKit terminates the page's content
// process, the host reloads the page and the new page attaches to this
// already-running sidecar instead of spawning another (one sidecar per app
// instance, systemdesign §3.1). The previous page's subscriptions are still
// registered here, each with a live change detector (a poll child in server
// mode) whose events nobody reads any more. The newly attached page owns the
// session, so it calls `attached()` before subscribing and those are stopped.

import { stop } from "./subscribe"
import { state } from "./subscribe-internals"

export async function attached(): Promise<{ stopped: number }> {
  const ids = [...state.detectors.keys()]
  await Promise.all(ids.map((id) => stop(id)))
  return { stopped: ids.length }
}
