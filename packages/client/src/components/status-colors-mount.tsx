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
import { useEffect, useState } from "react"
import { rpc } from "../lib/rpc"
import { buildStatusColorCss } from "../lib/status-colors"
import { currentThemeSurface, statusColorStore, useStatusColors } from "../lib/status-colors-store"
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
    const update = () => statusColorStore.set({ surface: currentThemeSurface(el) })
    update()
    const observer = new MutationObserver(update)
    observer.observe(el, { attributes: true, attributeFilter: ["class"] })
    return () => observer.disconnect()
  }, [])

  return <StatusColorStyles />
}

export function StatusColorStyles() {
  const { css, surface } = useStatusColors()
  return <style data-beadbox-status-colors="">{buildStatusColorCss(css, surface)}</style>
}
