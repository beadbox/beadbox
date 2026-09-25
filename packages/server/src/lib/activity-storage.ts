// Session storage keys
const FILTER_STORAGE_KEY = "beadbox-activity-filters"
const SCROLL_STORAGE_KEY = "beadbox-activity-scroll"

// Filter state interface
export interface ActivityFilters {
  actors: string[]
  beadSearch: string
  eventTypes: string[]
  timeRange: string // "1h" | "today" | "24h" | "7d" | "all"
}

export const DEFAULT_FILTERS: ActivityFilters = {
  actors: [],
  beadSearch: "",
  eventTypes: [],
  timeRange: "all",
}

// Load filters from sessionStorage
export function loadFilters(): ActivityFilters {
  if (typeof window === "undefined") return DEFAULT_FILTERS
  try {
    const stored = sessionStorage.getItem(FILTER_STORAGE_KEY)
    if (stored) {
      const parsed = JSON.parse(stored) as ActivityFilters
      return { ...DEFAULT_FILTERS, ...parsed }
    }
  } catch {
    // ignore parse errors
  }
  return DEFAULT_FILTERS
}

// Save filters to sessionStorage
export function saveFilters(filters: ActivityFilters) {
  if (typeof window === "undefined") return
  try {
    sessionStorage.setItem(FILTER_STORAGE_KEY, JSON.stringify(filters))
  } catch {
    // ignore storage errors
  }
}

// Save/restore scroll position for back-navigation
export function saveScrollPosition(scrollTop: number) {
  if (typeof window === "undefined") return
  try {
    sessionStorage.setItem(SCROLL_STORAGE_KEY, String(scrollTop))
  } catch {
    // ignore storage errors
  }
}

export function loadAndClearScrollPosition(): number | null {
  if (typeof window === "undefined") return null
  try {
    const stored = sessionStorage.getItem(SCROLL_STORAGE_KEY)
    sessionStorage.removeItem(SCROLL_STORAGE_KEY)
    if (stored !== null) {
      const val = parseInt(stored, 10)
      return Number.isNaN(val) ? null : val
    }
  } catch {
    // ignore storage errors
  }
  return null
}
