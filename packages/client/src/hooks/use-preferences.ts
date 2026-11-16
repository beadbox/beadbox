"use client"

import posthog from "posthog-js"
import { useCallback, useEffect, useRef, useState } from "react"
import {
  getAnalyticsEnabled,
  getFilterBarVisible,
  getFiltersPreference,
  getSortPreference,
  getUpdateCheckEnabled,
  getUpdateCheckFrequency,
  getVimNavigationEnabled,
  getZoomLevel,
  setFilterBarVisible as persistFilterBarVisible,
  setZoomLevel as persistZoomLevel,
  setFiltersPreference,
  setSortPreference,
  setUpdateCheckEnabled,
  setUpdateCheckFrequency,
  setVimNavigationEnabled,
  type UpdateCheckFrequency,
} from "../lib/local-storage"
import { safeCapture } from "../lib/posthog-safe"
import type { Filters, SortOption } from "../lib/types"
import { useThemePreference } from "./use-theme-preference"

export function usePreferences() {
  // beadbox-sdd/2026-11-13-runtime-themes task 11: theme preference is a
  // single observable store (local-storage.ts), not local state here —
  // see use-theme-preference.ts for the subscription-only hook and
  // use-theme.ts for the hook that owns the apply-to-<html> effect. This
  // keeps usePreferences's five independent call sites in sync with any
  // change made through the store, including from use-theme.ts itself.
  const { themeId: theme, setTheme: handleThemeChange } = useThemePreference()
  const [zoomLevel, setZoomLevelState] = useState(100)
  const [isTauri, setIsTauri] = useState(false)
  const isTauriRef = useRef(false)

  // Read saved filters on the first render so workspace-binding effects
  // cannot overwrite them with defaults before preferences have loaded.
  const [filters, setFiltersState] = useState<Filters>(getFiltersPreference)
  const prevFiltersRef = useRef<Filters | null>(filters)

  // Wrap setFilters to persist to localStorage and fire analytics
  // NOTE: does NOT handle scroll reset; page.tsx wraps this to add scroll behavior
  const setFilters = useCallback((newFilters: Filters) => {
    // Track discrete filter changes (skip search - too noisy from keystrokes)
    if (getAnalyticsEnabled() && prevFiltersRef.current) {
      const prev = prevFiltersRef.current
      // beadbox-brg: status switched from singleton to array. String(arr) is
      // empty string for [] (no filter — matches the new defaultVal "") and
      // a comma-separated list otherwise. The reference compare on prev[key]
      // !== newFilters[key] handles array identity correctly.
      const tracked: { key: keyof Filters; label: string; defaultVal: string }[] = [
        { key: "status", label: "status", defaultVal: "" },
        { key: "priority", label: "priority", defaultVal: "" },
        { key: "assignee", label: "assignee", defaultVal: "all" },
        { key: "showMessages", label: "show_messages", defaultVal: "false" },
        { key: "showWaves", label: "show_waves", defaultVal: "false" },
        { key: "hasSpec", label: "has_spec", defaultVal: "false" },
        { key: "hasDeadline", label: "has_deadline", defaultVal: "false" },
        { key: "rig", label: "rig", defaultVal: "all" },
        { key: "grouped", label: "grouped", defaultVal: "false" },
      ]
      for (const { key, label, defaultVal } of tracked) {
        const newVal = String(newFilters[key])
        if (prev[key] !== newFilters[key] && newVal !== defaultVal) {
          safeCapture("app_filter_applied", {
            filter_type: label,
            value: newVal,
          })
        }
      }
    }
    prevFiltersRef.current = newFilters
    setFiltersState(newFilters)
    setFiltersPreference(newFilters)
  }, [])

  const [sort, setSortState] = useState<SortOption>({ field: "updated", direction: "desc" })

  // Load sort preference from localStorage on mount
  useEffect(() => {
    setSortState(getSortPreference())
  }, [])

  // Wrap setSort to persist to localStorage
  const setSort = useCallback((newSort: SortOption) => {
    setSortState(newSort)
    setSortPreference(newSort)
  }, [])

  // Filter bar visibility (toggled via Cmd+F / Ctrl+F)
  const [filterBarVisible, setFilterBarVisibleState] = useState(true)

  useEffect(() => {
    setFilterBarVisibleState(getFilterBarVisible())
  }, [])

  const setFilterBarVisible = useCallback((visible: boolean) => {
    setFilterBarVisibleState(visible)
    persistFilterBarVisible(visible)
  }, [])

  // Update checker settings (managed as React state for reactivity)
  const [updateCheckEnabled, setUpdateCheckEnabledState] = useState(true)
  const [updateCheckFrequency, setUpdateCheckFrequencyState] =
    useState<UpdateCheckFrequency>(3600000)

  // Check if private update repo flag is active (enables RC version display)
  const [showRcVersion, setShowRcVersion] = useState(false)
  useEffect(() => {
    try {
      setShowRcVersion(!!posthog.isFeatureEnabled("use-private-update-repo"))
    } catch {
      // PostHog not ready yet
    }
    // Re-check when flags load (PostHog loads flags async)
    const onFlags = () => {
      try {
        setShowRcVersion(!!posthog.isFeatureEnabled("use-private-update-repo"))
      } catch {
        // ignore
      }
    }
    posthog.onFeatureFlags?.(onFlags)
  }, [])

  // Vim navigation toggle
  const [vimEnabled, setVimEnabledState] = useState(true)

  // Load zoom, vim navigation, and update preferences on mount. Theme is
  // no longer hydrated here: it comes from use-theme-preference.ts's
  // useSyncExternalStore call above, which already reads
  // getThemePreference() on first render.
  useEffect(() => {
    setVimEnabledState(getVimNavigationEnabled())
    setUpdateCheckEnabledState(getUpdateCheckEnabled())
    setUpdateCheckFrequencyState(getUpdateCheckFrequency())
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const detected = !!(window as any).__TAURI_INTERNALS__
    isTauriRef.current = detected
    setIsTauri(detected)
    if (detected) {
      setZoomLevelState(getZoomLevel())
    }
  }, [])

  // Apply zoom level to document (Tauri only)
  useEffect(() => {
    if (!isTauriRef.current) return
    document.documentElement.style.zoom = `${zoomLevel}%`
  }, [zoomLevel])

  const handleZoomChange = useCallback((level: number) => {
    const clamped = Math.max(50, Math.min(200, level))
    setZoomLevelState(clamped)
    persistZoomLevel(clamped)
  }, [])

  const handleVimNavigationChange = useCallback((enabled: boolean) => {
    setVimEnabledState(enabled)
    setVimNavigationEnabled(enabled)
  }, [])

  const handleUpdateCheckEnabledChange = useCallback((enabled: boolean) => {
    setUpdateCheckEnabledState(enabled)
    setUpdateCheckEnabled(enabled)
  }, [])

  const handleUpdateCheckFrequencyChange = useCallback((frequency: UpdateCheckFrequency) => {
    setUpdateCheckFrequencyState(frequency)
    setUpdateCheckFrequency(frequency)
  }, [])

  return {
    filters,
    setFilters,
    sort,
    setSort,
    theme,
    handleThemeChange,
    zoomLevel,
    handleZoomChange,
    filterBarVisible,
    setFilterBarVisible,
    vimEnabled,
    handleVimNavigationChange,
    updateCheckEnabled,
    handleUpdateCheckEnabledChange,
    updateCheckFrequency,
    handleUpdateCheckFrequencyChange,
    showRcVersion,
    isTauri,
    isTauriRef,
  }
}
