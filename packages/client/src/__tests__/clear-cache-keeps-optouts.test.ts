// Clear Cache must not undo an opt-out. The analytics and automatic
// update-check settings default to enabled when their key is missing, so a
// clearCache() that removed them turned both back on without asking.
//
// Defensive happy-dom registration, as in filters-persistence-migration.test.ts,
// so the file also runs without the bunfig preload.

import { GlobalRegistrator } from "@happy-dom/global-registrator"

if (!(globalThis as { document?: unknown }).document) {
  GlobalRegistrator.register()
}

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import {
  clearCache,
  getAnalyticsEnabled,
  getSortPreference,
  getUpdateCheckEnabled,
  setAnalyticsEnabled,
  setSortPreference,
  setUpdateCheckEnabled,
} from "../lib/local-storage"

const KEYS = ["beadbox_analytics_enabled", "beadbox_update_check_enabled", "beads-sort"]

function reset() {
  try {
    for (const key of KEYS) localStorage.removeItem(key)
  } catch {
    /* tolerable */
  }
}

beforeEach(reset)
afterEach(reset)

describe("clearCache keeps opt-outs", () => {
  test("analytics stays disabled after Clear Cache", () => {
    setAnalyticsEnabled(false)
    clearCache()
    expect(getAnalyticsEnabled()).toBe(false)
  })

  test("automatic update checks stay disabled after Clear Cache", () => {
    setUpdateCheckEnabled(false)
    clearCache()
    expect(getUpdateCheckEnabled()).toBe(false)
  })

  test("the molecule view switch is left alone", () => {
    localStorage.setItem("beadbox_enable_molecule_view", "true")
    clearCache()
    expect(localStorage.getItem("beadbox_enable_molecule_view")).toBe("true")
    localStorage.removeItem("beadbox_enable_molecule_view")
  })

  test("other preferences are still cleared", () => {
    setSortPreference({ field: "priority", direction: "asc" })
    clearCache()
    expect(localStorage.getItem("beads-sort")).toBeNull()
    expect(getSortPreference()).toEqual({ field: "status", direction: "desc" })
  })
})
