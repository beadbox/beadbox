// bb-nxqh: side-effect import installs a console.warn filter for the one
// known upstream THREE.THREE.Clock deprecation from react-force-graph-3d's
// bundled three.js AudioListener. MUST stay first so the override is in
// place before any module imports (esp. components/formula-dag.tsx) that
// transitively load react-force-graph-3d. See lib/silence-three-clock-warn.ts
// for the rationale + removal criteria.
import "./lib/silence-three-clock-warn"

import { QueryClientProvider } from "@tanstack/react-query"
import { createMemoryHistory, createRouter, RouterProvider } from "@tanstack/react-router"
import { StrictMode } from "react"
import ReactDOM from "react-dom/client"
import { isStoppedPage, StoppedPage } from "./components/stopped-page"
import { isTauriRuntime } from "./lib/rpc"
import { queryClient } from "./lib/query-client"
import { startSidecarShutdownStamp } from "./lib/sidecar-shutdown-stamp"
import { startSidecarWatcherStamp } from "./lib/sidecar-watcher-stamp"
import { installWindowBd } from "./lib/window-bd"
import { routeTree } from "./routeTree.gen"
import "./index.css"

// beadbox-z04: the host shows the stopped page (`stopped=1`) once WebKit has
// killed the page's content process past the reload cap. That page starts
// nothing: no stamps, no sidecar, no router.
const stopped = isStoppedPage(window.location.search)

if (!stopped) {
  // bb-x0il: subscribe early so the very first [bb-x0il-state] line emitted
  // by the sidecar at boot lands in window.__BEADBOX__.watcher.
  // No-op outside the Tauri runtime.
  startSidecarWatcherStamp()

  // bb-0vlu: subscribe to [bb-0vlu] sigterm_received / shutdown_watchdog_escalating
  // lines so DevTools can see the SIGTERM source data when the sidecar is asked
  // to shut down. No-op outside the Tauri runtime.
  startSidecarShutdownStamp()

  // bb-tu1m: install window.bd() helper at module-load (idempotent). Previously
  // planted via console-logo.tsx's mount effect, which was deleted with the
  // rest of the dev-console cosmetic noise (BEADBX ASCII + bd-help tip). The
  // helper is a plain side-effect, so module-level boot here matches the same
  // shape as the sidecar-stamp installers above.
  installWindowBd()
}

// bb-eze7 (P0 v0.25-RC blocker): under the Tauri asset protocol, the WebView
// loads `tauri://localhost/index.html?sidecar=1` (per src-tauri/src/lib.rs's
// WebviewUrl::App). TanStack Router's default browser-history reads
// window.location.pathname → "/index.html", which doesn't match the index
// route registered at "/". Result: notFoundComponent renders → "Not Found"
// (production-bundle context exposed; dev-mode `bun run tauri dev` hides it
// because Vite dev server normalizes "/" without the index.html suffix).
//
// Fix: under Tauri, use createMemoryHistory initialized at "/". Routing lives
// in memory, the WebView's URL bar is irrelevant, and every desktop-shell
// SPA pattern (Electron / Tauri) does this for the same reason. In browser
// dev / preview / Playwright contexts we keep the default browser history so
// page.goto('/workspaces') style URL navigation continues to work for tests.
const router = createRouter({
  routeTree,
  ...(isTauriRuntime()
    ? { history: createMemoryHistory({ initialEntries: ["/"] }) }
    : {}),
})

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router
  }
}

const rootEl = document.getElementById("root")
if (!rootEl) throw new Error("#root not found")

ReactDOM.createRoot(rootEl).render(
  <StrictMode>
    {stopped ? (
      <StoppedPage />
    ) : (
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    )}
  </StrictMode>,
)
