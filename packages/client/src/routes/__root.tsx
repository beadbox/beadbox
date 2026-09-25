import { createRootRoute, Outlet } from "@tanstack/react-router"
import { useEffect, useState } from "react"
import { DevBadge } from "../components/dev-badge"
import { StartupGate, useWorkspaceGate } from "../components/startup-gate"
import { Toaster } from "../components/ui/sonner"
import { WorkspaceRailPanel } from "../components/workspace-rail-panel"
import { PostHogProvider } from "../lib/posthog-provider"
import { useChangeSubscription } from "../lib/subscribe"
import { getWorkspaceCookie, subscribeWorkspaceCookie } from "../lib/workspace-cookie"

// Root layout for the Beadbox SPA.
//
// Layering (outside-in):
//   1. PostHogProvider — analytics init (gated by getAnalyticsEnabled()),
//      no-op when VITE_POSTHOG_KEY is unset. Wraps everything so capture()
//      calls from any descendant succeed.
//   2. WorkspaceRailPanel — persistent, resizable left rail of workspace
//      tabs (+ dashboard / add / remove). Sibling of the gate, not a
//      child: it must stay mounted while the gate re-checks health on a
//      workspace switch. Hidden below 768px.
//   3. StartupGate — workspace registry health, version checks, redirect
//      to /workspaces when no_registry. Renders error screens INSTEAD of
//      children when health fails, so per-route Header mounts (inside
//      <Outlet />) are structurally inside StartupGate and get replaced
//      by the gate's error UI.
//   4. <Outlet /> — TanStack Router renders the active route here. Per-
//      route components mount their own Header (the chrome is in
//      packages/client/src/components/header.tsx, available to import).
//   5. Toaster + DevBadge — chrome that always renders regardless of route
//      or gate state. window.bd() helper is installed at module-load in
//      main.tsx (bb-tu1m removed the prior console-logo.tsx planter along
//      with the BEADBX ASCII + bd-help-tip dev-console noise).
//
// P2.4 mounts the dual-channel change subscription here. SINGLE SOURCE
// per arch §5: P3.[2-6] consume invalidations via TanStack Query —
// they never mount their own subscription. The active workspacePath
// comes from StartupGate's WorkspaceGateContext (resolved during the
// startup health check). useChangeSubscription must be inside the
// gate's React tree so the context lookup succeeds; we use a thin
// internal component for the same reason.
//
// The <html> shell + theme className live in packages/client/index.html.
// This component renders inside <body> via main.tsx's <RouterProvider>.

export const Route = createRootRoute({
  component: RootLayout,
})

function RootLayout() {
  return (
    <PostHogProvider>
      {/* Shell row: the workspace rail is a sibling of the gated route
          content, NOT one of the gate's children. StartupGate replaces its
          children with the "Starting up..." spinner / error screens, and a
          workspace switch re-runs that check — a rail inside would vanish
          and re-appear on every switch. Height chain is html/body/#root at
          100% (index.css bb-s3gb), so h-full here keeps the page shells'
          own h-full working. */}
      <div className="flex h-full min-h-0">
        <WorkspaceRailPanel />
        <div className="min-w-0 flex-1">
          <StartupGate>
            <ChangeSubscriptionMount />
            <Outlet />
          </StartupGate>
        </div>
      </div>
      <Toaster position="bottom-right" theme="dark" />
      <DevBadge />
    </PostHogProvider>
  )
}

// Centralized change-subscription mount. Lives inside StartupGate so it
// can read the active workspace from WorkspaceGateContext. The hook is a
// no-op when workspacePath is null (no active workspace yet) or when
// we're not running under Tauri (browser dev iteration).
//
// bb-fvw2: derive activePath from the cookie-active workspace, not from
// `workspaces[0]`. Two bugs collapsed by this:
//   1. Wrong-workspace subscription — bd's getWorkspaces() returns
//      registry order, not active order; subscribing to workspaces[0]
//      means change events fire for the wrong db while the user views
//      another. No live updates for the actually-active workspace.
//   2. Subscribe.start churn — getWorkspaces() ordering is not stable
//      across calls (see [ws:resolve] in beadbox-sidecar.log). Any
//      non-deterministic shuffle flips workspaces[0], flips activePath,
//      and re-fires useChangeSubscription. Each restart spawns a new
//      change-detector + Dolt pool + initial-change emit, queueing
//      kkrpc traffic and starving in-flight handler responses (this is
//      the home-page bead-list stall vector).
// Cookie is the source of truth for "active workspace"; fall back to
// workspaces[0] only when no cookie is set (first launch before any
// /workspaces selection).
//
// bb-onv3.2: also re-resolve on workspace-cookie change. workspaces array
// reference doesn't change when the user picks a different active workspace
// (same registered set, just different selection), so without this
// subscription the effect would never re-fire on a switch — the
// change-detector would stay pinned to whichever workspace was resolved
// first. subscribeWorkspaceCookie pubs from setWorkspaceCookie /
// clearWorkspaceCookie on a module-scoped EventTarget (workspace-cookie.ts).
export function ChangeSubscriptionMount() {
  const { workspaces } = useWorkspaceGate()
  // Persist last-resolved active workspace path so a transient empty
  // workspaces array (e.g. mid-refresh) doesn't cause the subscription
  // to flap.
  const [activePath, setActivePath] = useState<string | null>(null)
  useEffect(() => {
    const resolve = () => {
      const cookieId = getWorkspaceCookie()
      const cookieMatch = cookieId ? workspaces.find((w) => w.id === cookieId) : undefined
      const next = cookieMatch?.id ?? workspaces[0]?.id ?? null
      if (next) setActivePath(next)
    }
    resolve()
    return subscribeWorkspaceCookie(resolve)
  }, [workspaces])
  useChangeSubscription(activePath)
  return null
}
