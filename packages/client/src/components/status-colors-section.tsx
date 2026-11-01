// beadbox-o3h: Settings > Workflow > Status colors. One row per status of the
// open project (bd's built-ins, then status.custom in order): a live badge
// preview, a color picker and a hex field, so every row works by keyboard
// alone even where the OS picker does not. "Reset colors" puts every status
// back to its default.
//
// Colors are Beadbox's own per-workspace setting (rpc.workspaces.
// setStatusColors writes the registry), never bd. A change applies to the
// status-color store at once, so every surface recolors without a reload, and
// is persisted shortly after (a picker drag fires many changes).

import { RotateCcw } from "lucide-react"
import { useCallback, useEffect, useRef, useState } from "react"
import { toast } from "sonner"
import { getStatusDisplayConfig } from "@/components/bead-detail-helpers"
import { statusColorsQueryKey } from "@/components/status-colors-mount"
import { Button } from "@/components/ui/button"
import { getStatusConfig, PillBadge } from "@/lib/badge-config"
import { queryClient } from "@/lib/query-client"
import { rpc } from "@/lib/rpc"
import { BUILTIN_STATUSES, isHexColor, type StatusColorMap } from "@/lib/status-colors"
import { statusColorStore, useStatusColors } from "@/lib/status-colors-store"

const PERSIST_DELAY_MS = 300

/**
 * Write a workspace's chosen colors: to the store at once, to the registry
 * via rpc. On failure the previous colors come back and the user is told.
 */
export async function persistStatusColors(
  workspaceId: string,
  next: StatusColorMap,
): Promise<boolean> {
  const result = await rpc.workspaces.setStatusColors(
    workspaceId,
    Object.keys(next).length ? next : null,
  )
  if (result.success) {
    queryClient.setQueryData(statusColorsQueryKey(workspaceId), result.colors)
    return true
  }
  return false
}

/** The colors to keep after the project's custom statuses became `customs`. */
export function pruneStatusColors(
  overrides: StatusColorMap,
  customs: readonly string[],
  statuses: readonly string[],
): StatusColorMap {
  // Kept: a built-in, a configured custom status, or anything bd still lists.
  // A just-removed status may linger in a not-yet-refetched `statuses`; it is
  // dropped on the next pass, once the refetched list arrives.
  const keep = new Set<string>([...BUILTIN_STATUSES, ...customs, ...statuses])
  return Object.fromEntries(Object.entries(overrides).filter(([k]) => keep.has(k)))
}

function normalizeHex(input: string): string | null {
  const v = input.trim()
  const withHash = v.startsWith("#") ? v : `#${v}`
  return isHexColor(withHash) ? withHash.toLowerCase() : null
}

export function StatusColorsSection({
  customStatuses,
}: {
  customStatuses: readonly string[] | null
}) {
  const { workspaceId, statuses, overrides, display } = useStatusColors()
  const pending = useRef<{ id: string; colors: StatusColorMap; previous: StatusColorMap } | null>(
    null,
  )
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const flush = useCallback(async () => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
    const job = pending.current
    pending.current = null
    if (!job) return
    const ok = await persistStatusColors(job.id, job.colors)
    if (!ok) {
      if (statusColorStore.get().workspaceId === job.id)
        statusColorStore.set({ overrides: job.previous })
      toast.error("Could not save status colors")
    }
  }, [])

  useEffect(
    () => () => {
      void flush()
    },
    [flush],
  )

  const apply = useCallback(
    (next: StatusColorMap, immediate = false) => {
      if (!workspaceId) return
      const previous = pending.current?.previous ?? statusColorStore.get().overrides
      statusColorStore.set({ overrides: next })
      pending.current = { id: workspaceId, colors: next, previous }
      if (timer.current) clearTimeout(timer.current)
      if (immediate) void flush()
      else timer.current = setTimeout(() => void flush(), PERSIST_DELAY_MS)
    },
    [workspaceId, flush],
  )

  // Drop colors for statuses the project no longer has, once both lists are
  // in, so a removed-then-re-added status starts from a fresh default.
  useEffect(() => {
    if (!workspaceId || !customStatuses || statuses.length === 0) return
    const pruned = pruneStatusColors(overrides, customStatuses, statuses)
    if (Object.keys(pruned).length !== Object.keys(overrides).length) apply(pruned, true)
  }, [workspaceId, customStatuses, statuses, overrides, apply])

  if (!workspaceId) return null
  const hasChosen = Object.keys(overrides).some((k) => statuses.includes(k))

  return (
    <div className="space-y-3 pt-4 border-t">
      <div>
        <h3 className="text-lg font-semibold mb-1">Status colors</h3>
        <p className="text-sm text-muted-foreground">
          The color of each status everywhere Beadbox shows it. Saved in Beadbox for this project
          only; nothing is written to bd.
        </p>
      </div>
      <ul className="rounded-md border divide-y" aria-label="Status colors">
        {statuses.map((s) => (
          <StatusColorRow
            key={s}
            status={s}
            color={display[s] ?? "#3b82f6"}
            chosen={s in overrides}
            onChange={(hex, immediate) => apply({ ...overrides, [s]: hex }, immediate)}
          />
        ))}
      </ul>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => apply({}, true)}
        disabled={!hasChosen}
        aria-label="Reset status colors"
      >
        <RotateCcw className="h-4 w-4" />
        Reset colors
      </Button>
    </div>
  )
}

function StatusColorRow({
  status,
  color,
  chosen,
  onChange,
}: {
  status: string
  color: string
  chosen: boolean
  onChange: (hex: string, immediate: boolean) => void
}) {
  const label = getStatusDisplayConfig(status).label
  const [draft, setDraft] = useState(color)
  const [invalid, setInvalid] = useState(false)
  useEffect(() => {
    setDraft(color)
    setInvalid(false)
  }, [color])

  const commitDraft = () => {
    const hex = normalizeHex(draft)
    if (!hex) {
      setInvalid(true)
      return
    }
    setInvalid(false)
    if (hex !== color || !chosen) onChange(hex, true)
  }

  return (
    <li data-status-color-row={status} className="flex items-center gap-3 px-3 py-2">
      <div className="w-36 shrink-0">
        <PillBadge config={getStatusConfig(status)} status={status} />
      </div>
      <code className="flex-1 text-xs font-mono text-muted-foreground truncate">{status}</code>
      <input
        type="color"
        value={color}
        onChange={(e) => onChange(e.target.value.toLowerCase(), false)}
        aria-label={`${label} color`}
        className="h-7 w-9 shrink-0 cursor-pointer rounded border border-input bg-transparent p-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      />
      <input
        type="text"
        value={draft}
        onChange={(e) => {
          setDraft(e.target.value)
          if (invalid) setInvalid(false)
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault()
            commitDraft()
          }
        }}
        onBlur={commitDraft}
        spellCheck={false}
        maxLength={7}
        aria-label={`${label} color hex`}
        aria-invalid={invalid ? "true" : "false"}
        className="h-7 w-20 shrink-0 rounded-md border border-input bg-background px-2 text-xs font-mono focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring aria-[invalid=true]:border-red-400"
      />
    </li>
  )
}
