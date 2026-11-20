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
import { currentThemeForeground, currentThemeSurface } from "../lib/status-colors-store"
import { statusColorsQueryKey, statusListQueryKey } from "./status-colors-mount"

export interface StatusColorSource {
  id: string
  databasePath: string
}

export function ProjectStatusColors({ sources }: { sources: readonly StatusColorSource[] }) {
  // Surface AND foreground: the surface drives readable-text contrast, the
  // foreground is `open`'s default (FOREGROUND_DEFAULT_STATUSES). Tracked as
  // one object so a theme change updates both in a single render.
  const [theme, setTheme] = useState(() => ({
    surface: currentThemeSurface(),
    foreground: currentThemeForeground(),
  }))
  useEffect(() => {
    const el = document.documentElement
    const update = () =>
      setTheme((prev) => {
        const next = { surface: currentThemeSurface(el), foreground: currentThemeForeground(el) }
        // Keep the identity stable when nothing moved, so an unrelated
        // attribute mutation does not re-render every project's sheet.
        return prev.surface === next.surface && prev.foreground === next.foreground ? prev : next
      })
    update()
    const observer = new MutationObserver(update)
    observer.observe(el, { attributes: true, attributeFilter: ["class", "style"] })
    return () => observer.disconnect()
  }, [])
  return (
    <>
      {sources.map((source) => (
        <ProjectStatusColorStyles
          key={source.id}
          source={source}
          surface={theme.surface}
          foreground={theme.foreground}
        />
      ))}
    </>
  )
}

function ProjectStatusColorStyles({
  source,
  surface,
  foreground,
}: {
  source: StatusColorSource
  surface: string
  foreground: string
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
        resolveStatusColors(statuses.data ?? [], colors.data ?? {}, customs.data ?? undefined, {
          foreground,
        }).css,
        surface,
        id,
      )
    : ""
  return <style data-beadbox-status-colors-project={id}>{css}</style>
}
