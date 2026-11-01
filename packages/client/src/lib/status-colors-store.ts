// beadbox-o3h: the active workspace's status colors, held once for the whole
// app. StatusColorsMount loads it; Settings > Workflow writes it; the injected
// stylesheet and the molecule graph read it. A change here reaches every
// surface at once, with no reload.

import { useSyncExternalStore } from "react"
import { resolveStatusColors, type StatusColorMap, THEME_SURFACES } from "./status-colors"

export interface StatusColorState {
  workspaceId: string | null
  /** Every status of the project: bd's built-ins, then status.custom in order. */
  statuses: string[]
  /** The user's chosen colors, as stored (may name statuses since removed). */
  overrides: StatusColorMap
  /** The project's status.custom names; every other status is a bd built-in. Null until loaded. */
  customs: string[] | null
  /** The theme's card color, the surface the contrast rule reads against. */
  surface: string
}

export interface ResolvedStatusColors extends StatusColorState {
  css: StatusColorMap
  display: StatusColorMap
  defaults: StatusColorMap
}

function resolve(s: StatusColorState): ResolvedStatusColors {
  // Until the custom list is in, render nothing for any status: a bd
  // built-in must never flash a generated color.
  if (s.customs === null) return { ...s, css: {}, display: {}, defaults: {} }
  return { ...s, ...resolveStatusColors(s.statuses, s.overrides, s.customs) }
}

let state: ResolvedStatusColors = resolve({
  workspaceId: null,
  statuses: [],
  overrides: {},
  customs: null,
  surface: THEME_SURFACES.gray.card,
})
const listeners = new Set<() => void>()

function set(patch: Partial<StatusColorState>): void {
  state = resolve({ ...state, ...patch })
  for (const l of listeners) l()
}

export const statusColorStore = {
  get: (): ResolvedStatusColors => state,
  subscribe(listener: () => void): () => void {
    listeners.add(listener)
    return () => listeners.delete(listener)
  },
  set,
  /** Test hook: back to the empty state. */
  _reset(): void {
    set({ workspaceId: null, statuses: [], overrides: {}, customs: null, surface: THEME_SURFACES.gray.card })
  },
}

export function useStatusColors(): ResolvedStatusColors {
  return useSyncExternalStore(
    statusColorStore.subscribe,
    statusColorStore.get,
    statusColorStore.get,
  )
}

/** The card color of the theme on <html> (theme-gray / theme-green, else blue). */
export function currentThemeSurface(el: Element = document.documentElement): string {
  if (el.classList.contains("theme-gray")) return THEME_SURFACES.gray.card
  if (el.classList.contains("theme-green")) return THEME_SURFACES.green.card
  return THEME_SURFACES.blue.card
}
