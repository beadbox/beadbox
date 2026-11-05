// beadbox-t6x: the All projects view shows status colors the way each
// workspace view does. Colors are per project (o3h), so the same status can
// have a different color on each row: every project gets its own stylesheet,
// scoped to the elements tagged with its data-project-id (its table rows and
// the detail pane opened from one).
//
// The queries use the same keys as StatusColorsMount, so a color saved in
// Settings > Workflow (persistStatusColors updates that cache) reaches this
// view too. Until a project's custom-status list is in, its sheet is empty:
// a bd built-in must never flash a generated color.

import { useQueries } from "@tanstack/react-query"
import { useEffect, useState } from "react"
import { rpc } from "../lib/rpc"
import { buildStatusColorCss, resolveStatusColors } from "../lib/status-colors"
import { currentThemeSurface } from "../lib/status-colors-store"
import { statusColorsQueryKey, statusListQueryKey } from "./status-colors-mount"

export interface StatusColorSource {
  id: string
  databasePath: string
}

export function ProjectStatusColors({ sources }: { sources: readonly StatusColorSource[] }) {
  const [surface, setSurface] = useState(() => currentThemeSurface())
  useEffect(() => {
    const el = document.documentElement
    const update = () => setSurface(currentThemeSurface(el))
    update()
    const observer = new MutationObserver(update)
    observer.observe(el, { attributes: true, attributeFilter: ["class"] })
    return () => observer.disconnect()
  }, [])
  return (
    <>
      {sources.map((source) => (
        <ProjectStatusColorStyles key={source.id} source={source} surface={surface} />
      ))}
    </>
  )
}

function ProjectStatusColorStyles({
  source,
  surface,
}: {
  source: StatusColorSource
  surface: string
}) {
  const { id, databasePath } = source
  const [colors, statuses, customs] = useQueries({
    queries: [
      {
        queryKey: statusColorsQueryKey(id),
        queryFn: async () => {
          const result = await rpc.workspaces.getStatusColors(id)
          return result.success ? result.colors : {}
        },
        staleTime: Number.POSITIVE_INFINITY,
      },
      {
        queryKey: statusListQueryKey(id, databasePath),
        queryFn: () => rpc.beads.getAvailableStatuses(databasePath),
      },
      {
        queryKey: [...statusListQueryKey(id, databasePath), "custom"],
        queryFn: () => rpc.beads.getCustomStatusList(databasePath),
      },
    ],
  })
  const ready = customs.data !== undefined && customs.data !== null && statuses.data !== undefined
  const css = ready
    ? buildStatusColorCss(
        resolveStatusColors(statuses.data ?? [], colors.data ?? {}, customs.data ?? undefined).css,
        surface,
        id,
      )
    : ""
  return <style data-beadbox-status-colors-project={id}>{css}</style>
}
