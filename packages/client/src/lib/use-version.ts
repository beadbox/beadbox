// Hook for the DevBadge (and any other "what's running?" surface) to
// fetch the sidecar's tool versions. Wraps rpc.health.getToolVersions in
// TanStack Query so DevBadge can render a placeholder while the call
// resolves and a fallback when the call errors (browser dev mode raises
// RpcUnavailableError).
//
// appVersion is a build-time client constant (Vite inline-replaces
// import.meta.env at build), so it doesn't need a query.
//
// beadbox-5yv: the version a user SEES is always the plain X.Y.Z
// (VITE_APP_VERSION). A release promotes an already-built rc/main build, so
// the build tag ("0.27.1-rc.1") would otherwise ship in the final's UI. The
// build tag is a detail for support: getBuildTag(), shown only in diagnostics.

import { useQuery } from "@tanstack/react-query"
import { rpc } from "./rpc"

/** The plain X.Y.Z shown to users, or null in dev builds. */
export function getDisplayVersion(): string | null {
  return (import.meta.env.VITE_APP_VERSION as string | undefined) || null
}

/** The raw build tag (e.g. "0.27.1-rc.1"), for diagnostics only. */
export function getBuildTag(): string | null {
  return (import.meta.env.VITE_BUILD_TAG as string | undefined) || null
}

export function useVersion() {
  const query = useQuery({
    queryKey: ["health", "tool-versions"] as const,
    queryFn: async () => rpc.health.getToolVersions(),
    staleTime: Infinity,
    gcTime: Infinity,
    retry: false,
  })
  return { ...query, appVersion: getDisplayVersion(), buildTag: getBuildTag() }
}
