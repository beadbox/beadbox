// Dev mode build badge. Ported from components/dev-badge.tsx
// (P2.3 / bb-cqpc.3); swapped to live data in P2.4 / bb-cqpc.4.
//
// Renders both halves: Beadbox app version (build-time constant from
// Vite env) + bd CLI version (runtime via kkrpc to sidecar). bb-lst5
// restored the app-version half — P2.3 dropped the original
// process.env.NEXT_PUBLIC_APP_VERSION read but never re-added the Vite
// equivalent.
//
// Behaviour:
// - Under Tauri (production .app): "beadbox 0.25.0 · bd 1.0.2". The plain
//   version, even on an rc build (beadbox-5yv); the build tag is only in
//   data-build-tag.
// - Tauri dev (no VITE_BUILD_TAG injected): "beadbox dev · bd 1.0.2"
// - Plain browser dev (no sidecar): rpc throws RpcUnavailableError,
//   isError flips, bd-half falls back to placeholder: "beadbox dev · bd dev"

import { useVersion } from "../lib/use-version"

const PLACEHOLDER = "dev"

export function DevBadge() {
  const { data, isError, isPending, appVersion, buildTag } = useVersion()

  const bdVersion = isPending || isError || !data?.bd_version ? PLACEHOLDER : data.bd_version
  const app = appVersion ?? PLACEHOLDER

  const label = `beadbox ${app} · bd ${bdVersion}`

  return (
    <div
      data-testid="dev-badge"
      data-build-tag={buildTag ?? undefined}
      className="fixed bottom-2 right-2 z-50 px-2 py-0.5 rounded text-[10px] font-mono text-muted-foreground/50 bg-muted/30 pointer-events-none select-none"
    >
      {label}
    </div>
  )
}
