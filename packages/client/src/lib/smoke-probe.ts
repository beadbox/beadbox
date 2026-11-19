// beadbox-79a: the packaged smoke's view probe. When the smoke launches the
// app with BEADBOX_SMOKE_VIEWS, the sidecar hands this probe the views the
// release changes; it opens each in this WebView (WKWebView, the packaged CSP
// and theme), checks the rendered DOM and computed styles, and reports one
// result per target to the sidecar log. Otherwise it makes one RPC and stops.

import { rpc } from "./rpc"

type Targets = Awaited<ReturnType<typeof rpc.smoke.getTargets>>
type Target = NonNullable<Extract<Targets, { enabled: true }>["targets"]>[number]

export interface SmokeProbeOptions {
  /** Open a client route (the router's navigate). */
  navigate: (route: string) => unknown
  /** How often to re-check for the targets file and for a view's state. */
  pollMs?: number
  /** How long a view may take to render and match its assertions. */
  viewTimeoutMs?: number
  /** How long to wait for the smoke to publish its targets. */
  targetsTimeoutMs?: number
  root?: ParentNode
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** The first failing assertion, or null when every assertion holds. */
export function checkAssertions(target: Target, root: ParentNode = document): string | null {
  for (const assertion of target.assertions) {
    let matches: Element[]
    try {
      matches = [...root.querySelectorAll(assertion.selector)]
    } catch {
      return `invalid selector ${assertion.selector}`
    }
    if (assertion.minCount !== undefined && matches.length < assertion.minCount) {
      return `${assertion.selector}: found ${matches.length}, want at least ${assertion.minCount}`
    }
    if (assertion.style) {
      if (matches.length === 0) return `${assertion.selector}: no element to read ${assertion.style.property} from`
      const actual = getComputedStyle(matches[0]).getPropertyValue(assertion.style.property).trim()
      if (actual !== assertion.style.equals) {
        return `${assertion.selector} ${assertion.style.property} ${actual || "(empty)"}, want ${assertion.style.equals}`
      }
    }
  }
  return null
}

async function probeTarget(target: Target, opts: Required<Omit<SmokeProbeOptions, "root">> & { root: ParentNode }) {
  await opts.navigate(target.route)
  const deadline = Date.now() + opts.viewTimeoutMs
  let failure: string | null = `view did not render ${target.waitFor}`
  // Poll with timers, not animation frames: the smoke's window is hidden.
  while (Date.now() < deadline) {
    if (opts.root.querySelector(target.waitFor)) {
      failure = checkAssertions(target, opts.root)
      if (failure === null) break
    }
    await sleep(opts.pollMs)
  }
  const ok = failure === null
  const detail = ok ? `${target.route}: ${target.assertions.length} assertion(s) hold` : `${target.route}: ${failure}`
  await rpc.smoke.report({ target: target.id, ok, detail }).catch(() => false)
}

/** Run the probe if the smoke launched this app; resolves when it is done. */
export async function runSmokeProbe(options: SmokeProbeOptions): Promise<void> {
  const opts = {
    pollMs: 1000,
    viewTimeoutMs: 30_000,
    targetsTimeoutMs: 10 * 60_000,
    root: document as ParentNode,
    ...options,
  }
  let result: Targets
  try {
    result = await rpc.smoke.getTargets()
  } catch {
    return // browser-only mode or an older sidecar
  }
  if (!result.enabled) return
  const deadline = Date.now() + opts.targetsTimeoutMs
  while (result.enabled && result.targets === null && Date.now() < deadline) {
    await sleep(opts.pollMs)
    result = await rpc.smoke.getTargets().catch(() => result)
  }
  if (!result.enabled || !result.targets) return
  for (const target of result.targets) await probeTarget(target, opts)
}
