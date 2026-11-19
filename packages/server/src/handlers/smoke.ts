// beadbox-79a: the packaged smoke's in-app view probe (see lib/smoke-targets.ts).
// Inert unless the app was launched with BEADBOX_SMOKE_VIEWS.
import { readSmokeTargets, reportSmokeView, type SmokeTargets } from "../lib/smoke-targets"

/** The smoke's view targets; disabled when the smoke did not launch the app. */
export async function getTargets(): Promise<SmokeTargets> {
  return readSmokeTargets()
}

/** Record one target's result in the sidecar log. */
export async function report(result: { target: string; ok: boolean; detail: string }): Promise<boolean> {
  return reportSmokeView(result)
}
