"use client"

import posthog from "posthog-js"
import { useCallback, useEffect, useRef, useState } from "react"
import {
  getAnalyticsEnabled,
  getFilterBarVisible,
  getFiltersPreference,
  getSortPreference,
  getThemePreference,
  getUpdateCheckEnabled,
  getUpdateCheckFrequency,
  getVimNavigationEnabled,
  getZoomLevel,
  setFilterBarVisible as persistFilterBarVisible,
  setZoomLevel as persistZoomLevel,
  setFiltersPreference,
  setSortPreference,
  setThemePreference,
  setUpdateCheckEnabled,
  setUpdateCheckFrequency,
  setVimNavigationEnabled,
  type ThemeVariant,
  type UpdateCheckFrequency,
} from "../lib/local-storage"
import { safeCapture } from "../lib/posthog-safe"
import type { Filters, SortOption } from "../lib/types"

export function usePreferences() {
  const [theme, setTheme] = useState<ThemeVariant>("gray")
  const [zoomLevel, setZoomLevelState] = useState(100)
  const [isTauri, setIsTauri] = useState(false)
  const isTauriRef = useRef(false)

  const [filters, setFiltersState] = useState<Filters>({
    // beadbox-brg: default to the canonical-known statuses so beads are
    // visible on first render. Replaced from localStorage in the mount
    // effect below.
    status: [
      "open",
      "in_progress",
      "closed",
      "ready_for_qa",
      "qa_passed",
      "ready_to_ship",
      "blocked",
      "deferred",
    ],
    assignee: "all",
    priority: "all",
    showMessages: false,
    showWaves: false,
    hasSpec: false,
    hasDeadline: false,
    search: "",
    rig: "all",
    grouped: false,
  })
  const prevFiltersRef = useRef<Filters | null>(null)

  // Load filters preference from localStorage on mount
  useEffect(() => {
    const loaded = getFiltersPreference()
    setFiltersState(loaded)
    prevFiltersRef.current = loaded
  }, [])

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
        { key: "priority", label: "priority", defaultVal: "all" },
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

  // Load theme, zoom, vim navigation, and update preferences on mount
  useEffect(() => {
    setTheme(getThemePreference())
    setVimEnabledState(getVimNavigationEnabled())
    setUpdateCheckEnabledState(getUpdateCheckEnabled())
    setUpdateCheckFrequencyState(getUpdateCheckFrequency())
    const detected = !!(window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
    isTauriRef.current = detected
    setIsTauri(detected)
    if (detected) {
      setZoomLevelState(getZoomLevel())
    }
  }, [])

  // Apply theme classes to <html>
  useEffect(() => {
    const el = document.documentElement
    el.classList.add("dark")
    el.classList.remove("theme-gray", "theme-green")
    if (theme === "gray") el.classList.add("theme-gray")
    if (theme === "green") el.classList.add("theme-green")
  }, [theme])

  // Apply zoom level to document (Tauri only)
  useEffect(() => {
    if (!isTauriRef.current) return
    document.documentElement.style.zoom = `${zoomLevel}%`
  }, [zoomLevel])

  const handleThemeChange = useCallback((next: ThemeVariant) => {
    setTheme(next)
    setThemePreference(next)
  }, [])

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
