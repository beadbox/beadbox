// beadbox-o3h: the active workspace's status colors, held once for the whole
// app. StatusColorsMount loads it; Settings > Workflow writes it; the injected
// stylesheet and the molecule graph read it. A change here reaches every
// surface at once, with no reload.

import { useSyncExternalStore } from "react"
import {
  DEFAULT_STATUS_HEX,
  resolveStatusColors,
  type StatusColorMap,
  THEME_SURFACES,
} from "./status-colors"

/** The dark palette's --bb-muted-foreground, the fallback for the getter below. */
export const DEFAULT_MUTED_FOREGROUND = "#a1a1aa"

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
  /**
   * The theme's foreground color. `open` has no colour of its own — it draws
   * in the body text colour — so its default is resolved from the theme
   * rather than baked (see FOREGROUND_DEFAULT_STATUSES).
   */
  foreground: string
  /**
   * The theme's muted foreground. Needed by the formula graphs, whose SVG
   * edges and marker arrowheads take a colour VALUE, not a class: React Flow
   * writes markerEnd.color into an SVG presentation attribute, where var()
   * does not resolve. So the value has to be read in JS.
   */
  mutedForeground: string
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
  return {
    ...s,
    ...resolveStatusColors(s.statuses, s.overrides, s.customs, { foreground: s.foreground }),
  }
}

let state: ResolvedStatusColors = resolve({
  workspaceId: null,
  statuses: [],
  overrides: {},
  customs: null,
  surface: THEME_SURFACES.gray.card,
  foreground: DEFAULT_STATUS_HEX.open,
  mutedForeground: DEFAULT_MUTED_FOREGROUND,
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
    set({
      workspaceId: null,
      statuses: [],
      overrides: {},
      customs: null,
      surface: THEME_SURFACES.gray.card,
    })
  },
}

export function useStatusColors(): ResolvedStatusColors {
  return useSyncExternalStore(
    statusColorStore.subscribe,
    statusColorStore.get,
    statusColorStore.get,
  )
}

/**
 * The card colour of the active theme.
 *
 * Reads the live --bb-card token rather than mapping a theme-* class through
 * a hardcoded table: those classes were removed once runtime theming
 * landed, and an arbitrary user theme has no fixed set to map. Inline style
 * is checked first since that's what applyTheme actually sets; computed
 * style is the fallback for any other way the token might be reached.
 * Falls back to THEME_SURFACES.gray.card, matching the store's own default,
 * so the engine still reports a surface even if theming is unavailable.
 */
export function currentThemeSurface(el: Element = document.documentElement): string {
  return readThemeVar(el, "--bb-card") || THEME_SURFACES.gray.card
}

/**
 * The theme's foreground, read the same way as the surface above. Falls back
 * to the dark literal, which is what `open` has always drawn in.
 */
export function currentThemeForeground(el: Element = document.documentElement): string {
  return readThemeVar(el, "--bb-foreground") || DEFAULT_STATUS_HEX.open
}

export function currentThemeMutedForeground(el: Element = document.documentElement): string {
  return readThemeVar(el, "--bb-muted-foreground") || DEFAULT_MUTED_FOREGROUND
}

/**
 * `--bb-muted-foreground` as a concrete colour VALUE at the given alpha, for
 * the one place a class or var() will not do: React Flow serialises
 * markerEnd.color into an SVG presentation attribute, and var() does not
 * resolve there.
 *
 * Edge STROKES use `var(--bb-muted-foreground)` in an inline style instead,
 * so they follow a theme switch immediately; only arrowheads carry this
 * snapshot, and they refresh on the next layout.
 */
export function currentThemeEdgeColor(alpha = 0.5, el: Element = document.documentElement): string {
  const v = currentThemeMutedForeground(el).trim()
  const hex = /^#[0-9a-fA-F]{6}$/.test(v)
    ? ([1, 3, 5].map((i) => Number.parseInt(v.slice(i, i + 2), 16)) as [number, number, number])
    : null
  const rgb = v.match(/^rgba?\(\s*(\d{1,3})[\s,]+(\d{1,3})[\s,]+(\d{1,3})/)
  const [r, g, b] = hex ?? (rgb ? [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])] : [161, 161, 170])
  return `rgb(${r} ${g} ${b} / ${alpha})`
}

function readThemeVar(el: Element, name: string): string {
  const inline = (el as HTMLElement).style?.getPropertyValue(name)?.trim()
  if (inline) return inline
  const view = el.ownerDocument?.defaultView
  return view?.getComputedStyle(el).getPropertyValue(name).trim() ?? ""
}
