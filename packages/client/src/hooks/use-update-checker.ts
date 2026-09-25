"use client"

import posthog from "posthog-js"
import { useCallback, useEffect, useRef, useState } from "react"
import {
  getAnalyticsEnabled,
  getUpdateCheckEnabled,
  getUpdateCheckFrequency,
  getUpdateDismissedVersion,
  setUpdateDismissedVersion,
} from "../lib/local-storage"
import { safeCapture } from "../lib/posthog-safe"
import { checkForUpdate, type UpdateInfo } from "../lib/update-checker"

const APP_VERSION = import.meta.env.VITE_APP_VERSION ?? "0.0.0"

interface UpdateCheckerConfig {
  enabled?: boolean
  frequency?: number
}

interface UseUpdateCheckerResult {
  updateAvailable: UpdateInfo | null
  checking: boolean
  checkNow: () => Promise<void>
  dismissUpdate: () => void
  lastChecked: Date | null
  clearUpdate: () => void
  /**
   * Non-null when the last check FAILED, as distinct from succeeding and
   * finding nothing. beadbox-l5i.6.4: 0.25.x collapsed these two into the same
   * null and told users they were up to date while the fetch was 404ing.
   * Consumers must render this differently from "no update available".
   */
  checkError: string | null
}

export function useUpdateChecker(config?: UpdateCheckerConfig): UseUpdateCheckerResult {
  const [updateAvailable, setUpdateAvailable] = useState<UpdateInfo | null>(null)
  const [checking, setChecking] = useState(false)
  const [checkError, setCheckError] = useState<string | null>(null)
  const [lastChecked, setLastChecked] = useState<Date | null>(null)
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  // Track which version we already fired app_update_available for to prevent
  // duplicates (initial check + onFeatureFlags callback both call runCheck).
  const firedVersionRef = useRef<string | null>(null)

  // Resolve config: explicit params take precedence over localStorage
  const enabled = config?.enabled ?? getUpdateCheckEnabled()
  const frequency = config?.frequency ?? getUpdateCheckFrequency()

  // beadbox-l5i.6.4: the 'use-private-update-repo' PostHog flag path is gone.
  // It threaded a repo override and a TOKEN (from a feature-flag payload) into
  // the checker for the private-repo era. Those options were already no-ops —
  // endpoint and verification live in tauri.conf.json — and distributing a
  // credential through a feature-flag payload is not something to carry into a
  // public repo. Nothing replaces it: the public endpoint needs no options.

  const runCheck = useCallback(async () => {
    setChecking(true)
    try {
      const result = await checkForUpdate(APP_VERSION)
      if (result.status === "check-failed") {
        // Leave any previously-known update in place; a failed check is not
        // evidence that it went away.
        setCheckError(result.message)
      } else if (result.status === "update-available") {
        setCheckError(null)
        const info = result.info
        const dismissed = getUpdateDismissedVersion()
        if (dismissed === info.version) {
          setUpdateAvailable(null)
        } else {
          setUpdateAvailable(info)
          if (getAnalyticsEnabled() && firedVersionRef.current !== info.version) {
            firedVersionRef.current = info.version
            safeCapture("app_update_available", {
              current_version: APP_VERSION,
              available_version: info.version,
              channel: info.version.includes("-rc") ? "rc" : "stable",
            })
          }
        }
      } else {
        setCheckError(null)
        setUpdateAvailable(null)
      }
      setLastChecked(new Date())
    } finally {
      setChecking(false)
    }
  }, [])

  // Initial check on mount + periodic interval, reactive to enabled/frequency
  useEffect(() => {
    if (!enabled) {
      setUpdateAvailable(null)
      return
    }

    runCheck()

    // Re-run check when PostHog flags become available (flags load async,
    // so the initial runCheck above may miss the use-private-update-repo flag)
    posthog.onFeatureFlags?.(() => {
      runCheck()
    })

    intervalRef.current = setInterval(runCheck, frequency)

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current)
        intervalRef.current = null
      }
    }
  }, [runCheck, enabled, frequency])

  // Manual check ignores the enabled flag (user explicitly requested it)
  const checkNow = useCallback(async () => {
    setChecking(true)
    try {
      const result = await checkForUpdate(APP_VERSION)
      if (result.status === "check-failed") {
        setCheckError(result.message)
      } else if (result.status === "update-available") {
        setCheckError(null)
        setUpdateAvailable(result.info)
      } else {
        setCheckError(null)
        setUpdateAvailable(null)
      }
      setLastChecked(new Date())
    } finally {
      setChecking(false)
    }
  }, [])

  const dismissUpdate = useCallback(() => {
    if (updateAvailable) {
      if (getAnalyticsEnabled()) {
        safeCapture("app_update_dismissed", {
          available_version: updateAvailable.version,
        })
      }
      setUpdateDismissedVersion(updateAvailable.version)
      setUpdateAvailable(null)
    }
  }, [updateAvailable])

  const clearUpdate = useCallback(() => {
    setUpdateAvailable(null)
  }, [])

  return {
    updateAvailable,
    checking,
    checkNow,
    dismissUpdate,
    lastChecked,
    clearUpdate,
    checkError,
  }
}
