// beadbox-o3h: loads the active workspace's status colors and the project's
// status list into statusColorStore, and renders the one stylesheet that
// recolors every status surface (elements tagged data-status +
// data-status-role). Mounted once in the root route beside
// ChangeSubscriptionMount, so every route gets it.
//
// The <style> is unlayered on purpose: Tailwind v4 puts utilities in
// @layer utilities, and an unlayered rule beats any layered one, so a chosen
// color wins over a surface's default classes without !important. With no
// color chosen for a built-in, no rule exists for it and its classes stand.

import { useQuery } from "@tanstack/react-query"
import { useEffect, useMemo, useState } from "react"
import { rpc } from "../lib/rpc"
import {
  buildPriorityColorCss,
  buildStatusColorCss,
  buildTypeColorCss,
} from "../lib/status-colors"
import {
  currentThemeForeground,
  currentThemeSurface,
  statusColorStore,
  useStatusColors,
} from "../lib/status-colors-store"
import { getWorkspaceCookie, subscribeWorkspaceCookie } from "../lib/workspace-cookie"
import { useWorkspaceGate } from "./startup-gate"

export const statusColorsQueryKey = (workspaceId: string | null) =>
  ["status-colors", workspaceId] as const
export const statusListQueryKey = (workspaceId: string | null, dbPath: string | null | undefined) =>
  ["status-colors-statuses", workspaceId, dbPath] as const

export function StatusColorsMount() {
  const { workspaces } = useWorkspaceGate()
  const [active, setActive] = useState<{ id: string; dbPath: string | undefined } | null>(null)

  useEffect(() => {
    const resolve = () => {
      const cookieId = getWorkspaceCookie()
      const ws = (cookieId ? workspaces.find((w) => w.id === cookieId) : undefined) ?? workspaces[0]
      setActive(ws ? { id: ws.id, dbPath: ws.databasePath } : null)
    }
    resolve()
    return subscribeWorkspaceCookie(resolve)
  }, [workspaces])

  const colorsQuery = useQuery({
    queryKey: statusColorsQueryKey(active?.id ?? null),
    queryFn: async () => {
      const result = await rpc.workspaces.getStatusColors(active!.id)
      return result.success ? result.colors : {}
    },
    enabled: !!active,
    staleTime: Number.POSITIVE_INFINITY,
  })
  const statusesQuery = useQuery({
    queryKey: statusListQueryKey(active?.id ?? null, active?.dbPath ?? null),
    queryFn: () => rpc.beads.getAvailableStatuses(active?.dbPath),
    enabled: !!active,
  })

  const customsQuery = useQuery({
    queryKey: [...statusListQueryKey(active?.id ?? null, active?.dbPath ?? null), "custom"],
    queryFn: () => rpc.beads.getCustomStatusList(active?.dbPath),
    enabled: !!active,
  })

  useEffect(() => {
    // Switching away clears the old workspace's colors at once, so they can
    // never show on the next one while its own load is in flight.
    statusColorStore.set({
      workspaceId: active?.id ?? null,
      overrides: active ? (colorsQuery.data ?? {}) : {},
      statuses: active ? (statusesQuery.data ?? []) : [],
      customs: active ? (customsQuery.data ?? null) : null,
    })
  }, [active, colorsQuery.data, statusesQuery.data, customsQuery.data])

  useEffect(() => {
    const el = document.documentElement
    // Only set when a colour actually moved. This observer also fires on
    // `style`, and usePreferences writes documentElement.style.zoom on every
    // zoom step — without this check each of those rebuilt all three
    // stylesheets and re-rendered every useStatusColors subscriber.
    const update = () => {
      const surface = currentThemeSurface(el)
      const foreground = currentThemeForeground(el)
      const cur = statusColorStore.get()
      if (cur.surface === surface && cur.foreground === foreground) return
      statusColorStore.set({ surface, foreground })
    }
    update()
    const observer = new MutationObserver(update)
    observer.observe(el, { attributes: true, attributeFilter: ["class", "style"] })
    return () => observer.disconnect()
  }, [])

  return <StatusColorStyles />
}

export function StatusColorStyles() {
  const { css, surface } = useStatusColors()
  return <style data-beadbox-status-colors="">{buildStatusColorCss(css, surface)}</style>
}

/**
 * Priority and bead-type rules, which are neither user-configurable nor per
 * project — so one unscoped sheet serves the whole app.
 *
 * Mounted from __root.tsx OUTSIDE the aggregate branch, because
 * StatusColorsMount is inside it: emitting these from there left every type
 * badge on /all-projects falling back to the neutral TYPE_BADGE_CLASS and
 * collapsed the priority ramp. Deriving them in both places instead would be
 * two copies of one fact, which is what colorRules() exists to avoid.
 */
export function PriorityTypeStyles() {
  const [surface, setSurface] = useState(() => currentThemeSurface())
  useEffect(() => {
    const el = document.documentElement
    const update = () => setSurface((prev) => (prev === currentThemeSurface(el) ? prev : currentThemeSurface(el)))
    update()
    const observer = new MutationObserver(update)
    observer.observe(el, { attributes: true, attributeFilter: ["class", "style"] })
    return () => observer.disconnect()
  }, [])
  // Only `surface` feeds these, so recompute only when it moves: each
  // colorRules() call runs readableTextColor's contrast search.
  const css = useMemo(
    () => `${buildPriorityColorCss(surface)}\n${buildTypeColorCss(surface)}`,
    [surface],
  )
  return <style data-beadbox-status-colors-shared="">{css}</style>
}
