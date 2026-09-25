// P3.1 port of app/posthog-provider.tsx.
// Source-divergence:
//   - process.env.NEXT_PUBLIC_POSTHOG_KEY/HOST → import.meta.env.VITE_POSTHOG_KEY/HOST
//     (Vite's env-replace replaces VITE_* tokens at bundle time the way Next.js
//     does for NEXT_PUBLIC_*). Env var rename tracked centrally in
//     docs/specs/bun-migration-p1-p6.md Migration Gaps.
//   - process.env.NEXT_PUBLIC_APP_VERSION → import.meta.env.VITE_APP_VERSION
//   - actions/health { getToolVersions, getWorkspaceCount } → rpc.health.*
//   - ToolVersions type sourced from packages/server/src/handlers/health.

import type * as HealthHandlers from "@beadbox/server/handlers"
import posthog from "posthog-js"
import { PostHogProvider as PHProvider } from "posthog-js/react"
import { useEffect, useRef } from "react"
import { getAnalyticsEnabled } from "./local-storage"
import { safeCapture } from "./posthog-safe"
import { rpc } from "./rpc"

type ToolVersions =
  ReturnType<typeof HealthHandlers.handlers.health.getToolVersions> extends Promise<infer T>
    ? T
    : never

const POSTHOG_KEY = import.meta.env.VITE_POSTHOG_KEY as string | undefined
const POSTHOG_HOST_RAW = import.meta.env.VITE_POSTHOG_HOST as string | undefined

// bb-xhf6: hardcoded fallback to PostHog's US ingest endpoint. If the
// VITE_POSTHOG_HOST secret is empty OR set to a non-ingest URL (e.g. the
// PostHog marketing site `us.posthog.com` instead of the `us.i.posthog.com`
// ingest subdomain), every event POST silently lands on the wrong host
// and no telemetry arrives. The ingest URL is well-known and stable;
// self-hosted setups can still override via the env var.
const DEFAULT_POSTHOG_HOST = "https://us.i.posthog.com"
const POSTHOG_HOST = POSTHOG_HOST_RAW || DEFAULT_POSTHOG_HOST

// bb-aurr: stamp a DevTools-inspectable diagnostic so production debugging
// of "is telemetry actually firing?" takes 30 seconds (open console, type
// __BEADBOX__.posthog) instead of 30 minutes of source-spelunking. The
// initial value reflects what Vite inlined at build; useEffect updates
// `init` once posthog.init runs (or to a reason-string if it doesn't).
// `host` is the EFFECTIVE host (post-fallback), `host_from_env` is the raw
// env value so an operator can tell whether the fallback fired.
import { ensureBeadboxStamp } from "./window-globals"

{
  const stamp = ensureBeadboxStamp()
  if (stamp) {
    stamp.posthog = {
      key_present: Boolean(POSTHOG_KEY),
      host: POSTHOG_HOST,
      host_from_env: POSTHOG_HOST_RAW,
      init: false,
    }
  }
}

export function PostHogProvider({ children }: { children: React.ReactNode }) {
  const initRef = useRef(false)
  const gateListenerRef = useRef<(() => void) | null>(null)

  useEffect(() => {
    if (initRef.current) return

    if (!POSTHOG_KEY) {
      // Loud no-op: was silent in v0.25.0-rc.x and caused a 5-day telemetry
      // blackout (bb-aurr) that took multi-agent triage to surface.
      console.warn(
        "[posthog] disabled — VITE_POSTHOG_KEY not present at build time. " +
          "Telemetry will not be sent. If this is a release build, the GitHub " +
          "secret NEXT_PUBLIC_POSTHOG_KEY is likely empty.",
      )
      if (typeof window !== "undefined" && window.__BEADBOX__?.posthog) {
        window.__BEADBOX__.posthog.init = "no_key_at_build_time"
      }
      return
    }

    const enabled = getAnalyticsEnabled()
    if (!enabled) {
      console.warn("[posthog] disabled — analytics opt-out in localStorage")
      if (typeof window !== "undefined" && window.__BEADBOX__?.posthog) {
        window.__BEADBOX__.posthog.init = "user_opt_out"
      }
      return
    }

    initRef.current = true
    posthog.init(POSTHOG_KEY, {
      api_host: POSTHOG_HOST,
      person_profiles: "identified_only",
      capture_pageview: false,
      capture_pageleave: true,
      autocapture: false,
      capture_exceptions: true,
      enable_recording_console_log: true,
    })
    if (typeof window !== "undefined" && window.__BEADBOX__?.posthog) {
      window.__BEADBOX__.posthog.init = true
    }

    const platform = "__TAURI_INTERNALS__" in window ? "tauri" : "web"
    const appVersion = (import.meta.env.VITE_APP_VERSION as string | undefined) ?? "unknown"
    posthog.register({ app_version: appVersion, platform })

    posthog.pageViewManager.doPageView(new Date())

    // bb-07pe: distinct_id is now `<sanitized-username>-<stable-hash>` so
    // dashboard readers can identify users at a glance and override-list
    // them by username instead of an opaque hash. We fetch BOTH commands
    // (oldId via get_stable_id stays byte-identical so the alias path
    // below has the pre-fix distinct_id available; prefix from the new
    // get_username_prefix command). Empty prefix → fallback to bare hash.
    //
    // Migration: posthog.alias(newId, oldId) once per upgrade so PostHog
    // merges historical events from the bare-hash person into the new
    // prefixed person. Idempotent via localStorage gate.
    const tauriInternals = (
      window as unknown as {
        __TAURI_INTERNALS__?: { invoke: (command: string) => Promise<string> }
      }
    ).__TAURI_INTERNALS__
    if (tauriInternals?.invoke) {
      Promise.all([
        tauriInternals.invoke("get_stable_id").catch(() => "") as Promise<string>,
        tauriInternals.invoke("get_username_prefix").catch(() => "") as Promise<string>,
      ])
        .then(([oldId, prefix]) => {
          if (!oldId) return
          const newId = prefix ? `${prefix}-${oldId}` : oldId
          const ALIAS_KEY = "beadbox_posthog_aliased_v1"
          if (newId !== oldId && !localStorage.getItem(ALIAS_KEY)) {
            posthog.alias(newId, oldId)
            localStorage.setItem(ALIAS_KEY, "1")
          }
          posthog.identify(newId)
        })
        .catch(() => {})
    }

    const baseProps = { app_version: appVersion, platform }

    const fireAppOpened = (
      versions: ToolVersions,
      workspaceCount: number,
      extraProps?: Record<string, string>,
    ) => {
      safeCapture("app_opened", {
        ...baseProps,
        workspace_count: workspaceCount,
        bd_version: versions.bd_version ?? "not_found",
        ...extraProps,
      })
    }

    Promise.all([
      rpc.health.getToolVersions().catch(() => ({ bd_version: null }) as ToolVersions),
      rpc.health.getWorkspaceCount().catch(() => 0),
    ])
      .then(([versions, workspaceCount]) => {
        if (versions.bd_version) {
          fireAppOpened(versions, workspaceCount)
          return
        }
        const handleGateReady = () => {
          window.removeEventListener("startup-gate-ready", handleGateReady)
          gateListenerRef.current = null
          rpc.health
            .getToolVersions()
            .then((resolved) => {
              fireAppOpened(
                resolved,
                workspaceCount,
                !resolved.bd_version
                  ? { tool_version_error: `post-gate: bd=${resolved.bd_version ?? "not_found"}` }
                  : undefined,
              )
            })
            .catch((err) => {
              fireAppOpened({ bd_version: null }, workspaceCount, {
                tool_version_error: err instanceof Error ? err.message : String(err),
              })
            })
        }
        gateListenerRef.current = handleGateReady
        window.addEventListener("startup-gate-ready", handleGateReady)
      })
      .catch(() => {
        safeCapture("app_opened", {
          ...baseProps,
          bd_version: "not_found",
        })
      })

    return () => {
      if (gateListenerRef.current) {
        window.removeEventListener("startup-gate-ready", gateListenerRef.current)
        gateListenerRef.current = null
      }
    }
  }, [])

  if (!POSTHOG_KEY) {
    return <>{children}</>
  }

  return <PHProvider client={posthog}>{children}</PHProvider>
}
