import { GlobalSettingsButton } from "./global-settings-button"
import { ProjectStatusColors } from "./project-status-colors"
import { Link } from "@tanstack/react-router"
import { useEffect, useMemo, useRef, useState } from "react"
import {
  type Backoff,
  dueSources,
  mergeRegistry,
  nextBackoff,
  projectBeads,
  readProjects,
  type ProjectBead,
  type ProjectSnapshot,
} from "../lib/aggregate"
import { extractLabels, matchesBead, resolveStatusFilter } from "../lib/epic-tree-utils"
import { useBeadSelection } from "../hooks/use-bead-selection"
import { compareBead } from "../lib/sort"
import { getSortPreference, getFiltersPreference } from "../lib/local-storage"
import { rpc } from "../lib/rpc"
import type { Bead } from "../lib/types"
import { subscribeWorkspaceRegistryChange } from "../lib/workspace-registry-events"
import { BeadDetailPanel } from "./bead-detail-panel"
import { BeadTable } from "./bead-table"
import { BeadTableBulkToolbar } from "./bead-table-bulk-toolbar"
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
  AlertDialogAction,
} from "./ui/alert-dialog"
import { FilterBar } from "./filter-bar"
import { MultiSelectFilter } from "./multi-select-filter"
import { Textarea } from "./ui/textarea"
import { Button } from "./ui/button"

const REFRESH_MS = 5_000

export function AllProjectsPage() {
  const [snapshots, setSnapshots] = useState<ProjectSnapshot[]>([])
  const [filters, setFilters] = useState(getFiltersPreference)
  const [sort, setSort] = useState(getSortPreference)
  const selection = useBeadSelection()
  const [pendingAction, setPendingAction] = useState<"status" | "archive" | null>(null)
  const [actionError, setActionError] = useState<string>()
  const [deleteKey, setDeleteKey] = useState<string | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [showArchived, setShowArchived] = useState(false)
  const [projects, setProjects] = useState<string[] | null>(null)
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [registryError, setRegistryError] = useState<string>()
  const refresh = useRef<() => void>(() => {})
  const includeSystem = filters.includeSystem ?? false

  useEffect(() => {
    let cancelled = false
    let busy = false
    let requested = false
    let forceRequested = false
    let timer: ReturnType<typeof setTimeout> | undefined
    // Failed sources wait out a growing backoff instead of a read slot per cycle.
    const backoff = new Map<string, Backoff>()
    const load = async (force = false) => {
      if (cancelled) return
      if (busy) {
        requested = true
        forceRequested ||= force
        return
      }
      clearTimeout(timer)
      busy = true
      requested = false
      try {
        const workspaces = await rpc.workspaces.getRegisteredWorkspacesForSelector()
        if (cancelled) return
        setRegistryError(undefined)
        setSnapshots((old) => mergeRegistry(old, workspaces))
        for (const id of backoff.keys())
          if (!workspaces.some((w) => w.id === id)) backoff.delete(id)
        await readProjects(
          dueSources(workspaces, backoff, Date.now(), force),
          async (workspace) => {
            try {
              if (workspace.available === false)
                throw new Error("Project is unavailable. Check its folder or connection.")
              const reply = await rpc.aggregate.readWorkspace(workspace.id, includeSystem)
              if (!reply.result.success) throw new Error(reply.result.bdLoadError.message)
              const epics = reply.result.epics
              backoff.delete(workspace.id)
              if (!cancelled)
                setSnapshots((old) =>
                  old.map((s) =>
                    s.workspace.id === workspace.id
                      ? {
                          workspace: { ...workspace, databasePath: reply.databasePath },
                          epics,
                          registryPath: workspace.databasePath,
                        }
                      : s,
                  ),
                )
            } catch (error) {
              backoff.set(workspace.id, nextBackoff(backoff.get(workspace.id), Date.now()))
              if (!cancelled)
                setSnapshots((old) =>
                  old.map((s) =>
                    s.workspace.id === workspace.id
                      ? { ...s, error: error instanceof Error ? error.message : String(error) }
                      : s,
                  ),
                )
            }
          },
          () => cancelled,
        )
      } catch (error) {
        if (!cancelled) setRegistryError(error instanceof Error ? error.message : String(error))
      } finally {
        busy = false
        if (!cancelled) {
          setLoading(false)
          const force = forceRequested
          forceRequested = false
          const tick = () => {
            if (document.hidden) timer = setTimeout(tick, REFRESH_MS)
            else void load(force)
          }
          timer = setTimeout(tick, requested ? 0 : REFRESH_MS)
        }
      }
    }
    refresh.current = () => void load(true)
    const unsubscribe = subscribeWorkspaceRegistryChange(() => void load(true))
    // One bounded refresh loop for the whole view, suspended in the background.
    const onVisible = () => {
      if (!document.hidden) void load()
    }
    document.addEventListener("visibilitychange", onVisible)
    void load()
    return () => {
      cancelled = true
      clearTimeout(timer)
      unsubscribe()
      document.removeEventListener("visibilitychange", onVisible)
      refresh.current = () => {}
    }
  }, [includeSystem])

  const allRows = useMemo(() => snapshots.flatMap(projectBeads), [snapshots])
  const labels = useMemo(() => extractLabels(snapshots.flatMap((s) => s.epics ?? [])), [snapshots])
  const statuses = [...new Set(allRows.map((r) => r.bead.status))]
  const resolved = resolveStatusFilter(filters, statuses)
  const filteredRows = allRows.filter(
    (r) =>
      (projects === null || projects.includes(r.workspace.id)) && matchesBead(r.bead, resolved),
  )
  const rows = filteredRows
    .filter((r) => showArchived || !r.bead.labels?.includes("archived"))
    .sort(
      (a, b) =>
        (filters.grouped ? a.bead.status.localeCompare(b.bead.status) : 0) ||
        compareBead(a.bead, b.bead, sort),
    )
  const byBead = useMemo(() => new Map(allRows.map((r) => [r.bead, r])), [allRows])
  const visibleKey = JSON.stringify(rows.map((r) => r.key))
  const { pruneTo } = selection
  useEffect(() => {
    pruneTo(JSON.parse(visibleKey) as string[])
  }, [visibleKey, pruneTo])
  const deleteTarget = allRows.find((r) => r.key === deleteKey)

  const mutate = async (targets: ProjectBead[], action: "status" | "archive", status?: string) => {
    if (pendingAction) return
    setPendingAction(action)
    setActionError(undefined)
    const errors: string[] = []
    const failed: string[] = []
    const groups = new Map<string, ProjectBead[]>()
    for (const row of targets)
      groups.set(row.workspace.id, [...(groups.get(row.workspace.id) ?? []), row])
    await readProjects(
      [...groups.values()],
      async (group) => {
        const workspace = group[0].workspace
        try {
          const error = snapshots.find((s) => s.workspace.id === workspace.id)?.error
          if (error) throw new Error(error)
          const ids = group.map((r) => r.bead.id)
          const result =
            action === "archive"
              ? await rpc.beads.archiveBeads(ids, workspace.databasePath)
              : await rpc.beads.updateBeadsStatus(ids, status ?? "open", workspace.databasePath)
          for (const item of result.results)
            if (!item.success) {
              errors.push(`${workspace.name}: ${item.id}: ${item.error}`)
              failed.push(JSON.stringify([workspace.id, item.id]))
            }
        } catch (error) {
          errors.push(`${workspace.name}: ${String(error)}`)
          failed.push(...group.map((r) => r.key))
        }
      },
      () => false,
    )
    if (errors.length) setActionError(errors.join("; "))
    selection.pruneTo(failed)
    setPendingAction(null)
    refresh.current()
  }

  const selected = allRows.find((r) => r.key === selectedKey)
  const selectedError = snapshots.find((s) => s.workspace.id === selected?.workspace.id)?.error
  const projectIds = snapshots.map((s) => s.workspace.id)
  const selectedProjects = projects?.filter((id) => projectIds.includes(id)) ?? projectIds

  return (
    <main className="flex h-full min-h-0 flex-col bg-background">
      {/* Each project's own status colors, scoped to its rows and pane (beadbox-t6x). */}
      <ProjectStatusColors sources={snapshots.map((s) => s.workspace)} />
      <header className="flex flex-wrap items-center gap-3 border-b p-4">
        <h1 className="mr-auto text-lg font-semibold">All projects</h1>
        <GlobalSettingsButton />
        <Button variant="outline" onClick={() => refresh.current()}>
          Refresh
        </Button>
        <Button variant="ghost" asChild>
          <Link to="/workspaces">Projects</Link>
        </Button>
      </header>
      <div className="px-6 pt-4 pb-3">
        <FilterBar
          extraFilters={
            <MultiSelectFilter
              triggerLabel={
                projects === null ? "All projects" : `Projects: ${selectedProjects.length}`
              }
              ariaLabel="Project filter"
              triggerClassName="h-8"
              allLabel="All projects"
              allState={
                selectedProjects.length === projectIds.length
                  ? true
                  : selectedProjects.length
                    ? "indeterminate"
                    : false
              }
              onToggleAll={() =>
                setProjects(projectIds.every((id) => selectedProjects.includes(id)) ? [] : null)
              }
              options={snapshots.map((s) => ({ value: s.workspace.id, label: s.workspace.name }))}
              selected={selectedProjects}
              onToggle={(id) =>
                setProjects(
                  selectedProjects.includes(id)
                    ? selectedProjects.filter((p) => p !== id)
                    : [...selectedProjects, id],
                )
              }
            />
          }
          sort={sort}
          onSortChange={setSort}
          filters={filters}
          onFiltersChange={setFilters}
          assignees={[...new Set(allRows.map((r) => r.bead.assignee).filter(Boolean))]}
          rigNames={[
            ...new Set(allRows.map((r) => r.bead.rigName).filter((name): name is string => !!name)),
          ]}
          availableLabels={labels}
          availableStatuses={statuses}
          availableTypes={[...new Set(allRows.map((r) => r.bead.type))]}
          selectedType={filters.type ?? "all"}
          onTypeChange={(type) => setFilters((f) => ({ ...f, type }))}
          includeSystem={includeSystem}
          onIncludeSystemChange={(value) => setFilters((f) => ({ ...f, includeSystem: value }))}
        />
      </div>
      {actionError && (
        <p role="alert" className="px-6 py-2 text-destructive">
          {actionError}
        </p>
      )}
      {registryError && (
        <p role="alert" className="p-4 text-destructive">
          Could not load projects: {registryError}. Click Refresh to retry.
        </p>
      )}
      {snapshots
        .filter((s) => s.error)
        .map((s) => (
          <p role="alert" key={s.workspace.id} className="px-4 py-2 text-destructive">
            {s.workspace.name}: {s.error} {s.epics.length > 0 && "Showing the last loaded data."}{" "}
            Retrying automatically.
          </p>
        ))}
      <div className="flex min-h-0 flex-1 flex-col px-6 pb-6 md:flex-row">
        <div className="min-h-0 min-w-0 flex-1 overflow-auto" aria-label="Beads from all projects">
          <BeadTableBulkToolbar
            selectedCount={selection.selectedIds.size}
            onBulkArchive={() =>
              mutate(
                rows.filter((r) => selection.selectedIds.has(r.key)),
                "archive",
              )
            }
            availableStatuses={[...new Set(["open", "in_progress", "closed", ...statuses])]}
            onBulkStatus={(status) =>
              mutate(
                rows.filter((r) => selection.selectedIds.has(r.key)),
                "status",
                status,
              )
            }
            onClear={selection.clear}
            isPending={pendingAction !== null}
            pendingAction={pendingAction ?? undefined}
          />
          {loading && allRows.length === 0 && (
            <p role="status" className="p-4 text-muted-foreground">
              Loading beads…
            </p>
          )}
          <BeadTable
            beads={rows.map((r) => r.bead)}
            epicId="_all"
            flat
            sourceForBead={(bead) => byBead.get(bead)?.workspace}
            onBeadClick={(bead) => setSelectedKey(byBead.get(bead)?.key ?? null)}
            selectedBeadId={selectedKey}
            selectedIds={selection.selectedIds}
            onToggleSelect={(key) => {
              if (!pendingAction) selection.toggle(key)
            }}
            onToggleSelectAll={(keys) => {
              if (!pendingAction) selection.toggleAll(keys)
            }}
            showWaves={filters.showWaves}
            onArchive={async (key) => {
              const row = allRows.find((r) => r.key === key)
              if (row) await mutate([row], "archive")
            }}
            onDelete={setDeleteKey}
          />
          {filteredRows.some((r) => r.bead.labels?.includes("archived")) && (
            <Button variant="ghost" onClick={() => setShowArchived(!showArchived)}>
              {showArchived ? "Hide archived" : "Show archived"}
            </Button>
          )}
          {!loading && rows.length === 0 && (
            <p className="p-6 text-muted-foreground">
              No beads match the selected projects and filters.
            </p>
          )}
        </div>
        {selected && (
          <section
            aria-label={`Details: ${selected.workspace.name}`}
            data-project-id={selected.workspace.id}
            className="flex min-h-0 flex-1 flex-col overflow-auto border-t md:border-l md:border-t-0"
          >
            <div className="border-b px-4 py-2 text-sm font-medium">{selected.workspace.name}</div>
            {selectedError ? (
              <p className="p-4">Editing is unavailable until the project reconnects.</p>
            ) : (
              <ProjectDetail
                key={selected.key}
                row={selected}
                onClose={() => setSelectedKey(null)}
                onRefresh={() => refresh.current()}
                onNavigate={(id) => setSelectedKey(JSON.stringify([selected.workspace.id, id]))}
              />
            )}
          </section>
        )}
      </div>
      <AlertDialog
        open={!!deleteTarget}
        onOpenChange={(open) => {
          if (!open && !deleting) setDeleteKey(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete bead?</AlertDialogTitle>
            <AlertDialogDescription>
              Delete {deleteTarget?.bead.id} from {deleteTarget?.workspace.name}? This cannot be
              undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={deleting}
              onClick={async (event) => {
                event.preventDefault()
                if (!deleteTarget || deleting) return
                setDeleting(true)
                try {
                  const sourceError = snapshots.find(
                    (s) => s.workspace.id === deleteTarget.workspace.id,
                  )?.error
                  if (sourceError) throw new Error(sourceError)
                  const result = await rpc.beads.deleteBead(
                    deleteTarget.bead.id,
                    deleteTarget.workspace.databasePath,
                  )
                  if (!result.success) throw new Error(result.error)
                  if (selectedKey === deleteTarget.key) setSelectedKey(null)
                  setDeleteKey(null)
                  refresh.current()
                } catch (error) {
                  setActionError(String(error))
                  setDeleteKey(null)
                } finally {
                  setDeleting(false)
                }
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </main>
  )
}

function ProjectDetail({
  row,
  onClose,
  onRefresh,
  onNavigate,
}: {
  row: ProjectBead
  onClose: () => void
  onRefresh: () => void
  onNavigate: (id: string) => void
}) {
  const [bead, setBead] = useState<Bead | null>(null)
  const [error, setError] = useState<string>()
  const [revision, setRevision] = useState(0)
  const [comment, setComment] = useState("")
  const [saving, setSaving] = useState(false)
  const [commentError, setCommentError] = useState<string>()
  const [catalog, setCatalog] = useState({
    statuses: ["open", "in_progress", "closed"],
    types: [] as string[],
    ready: false,
  })
  useEffect(() => {
    let cancelled = false
    void Promise.all([
      rpc.beads.getAvailableStatuses(row.workspace.databasePath),
      rpc.beads.getAvailableTypes(row.workspace.databasePath),
    ])
      .then(([statuses, types]) => {
        if (!cancelled) setCatalog({ statuses, types, ready: true })
      })
      .catch(() => {
        /* Keep read/detail available when a catalog is unsupported. */
      })
    return () => {
      cancelled = true
    }
  }, [row.workspace.databasePath])

  const refreshDetail = useRef<() => void>(() => {})
  const sourcePath = row.workspace.databasePath
  const beadId = row.bead.id
  useEffect(() => {
    let cancelled = false
    let busy = false
    let requested = false
    const load = async () => {
      if (cancelled) return
      if (busy) {
        requested = true
        return
      }
      busy = true
      try {
        const detail = await rpc.epics.getBeadDetail(beadId, sourcePath, true)
        if (cancelled) return
        if (!detail) {
          setError("Could not load this bead. Click Refresh to retry.")
          return
        }
        setError(undefined)
        setBead(detail)
      } catch (err) {
        if (!cancelled) setError(String(err))
      } finally {
        busy = false
        if (requested && !cancelled) {
          requested = false
          void load()
        }
      }
    }
    refreshDetail.current = () => void load()
    return () => {
      cancelled = true
      refreshDetail.current = () => {}
    }
  }, [beadId, sourcePath])
  // A source refresh must not cancel a slow detail read. Coalesce requests
  // within this identity; only selecting another source/bead discards replies.
  // biome-ignore lint/correctness/useExhaustiveDependencies: these are explicit refresh signals.
  useEffect(() => {
    refreshDetail.current()
  }, [row.bead, revision, sourcePath])
  const updated = () => {
    setRevision((v) => v + 1)
    onRefresh()
  }
  if (!bead && !error)
    return (
      <p role="status" className="p-4 text-muted-foreground">
        Loading details…
      </p>
    )
  if (error)
    return (
      <p role="alert" className="p-4 text-destructive">
        {error}
      </p>
    )
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1">
        <BeadDetailPanel
          bead={bead}
          dbPath={row.workspace.databasePath}
          isLoadingBead={!bead}
          availableStatuses={catalog.statuses}
          availableTypes={catalog.types}
          typeCatalogReady={catalog.ready}
          onClose={onClose}
          onUpdate={(next) => {
            setBead(next)
            updated()
          }}
          onAddComment={updated}
          onDelete={() => {
            onClose()
            onRefresh()
          }}
          onBeadNavigate={onNavigate}
        />
      </div>
      <form
        className="space-y-2 border-t p-3"
        onSubmit={async (event) => {
          event.preventDefault()
          if (saving || !comment.trim()) return
          setSaving(true)
          try {
            const result = await rpc.beads.addComment(
              row.bead.id,
              comment.trim(),
              row.workspace.databasePath,
            )
            if (!result.success) throw new Error(result.error ?? "Comment could not be saved")
            setComment("")
            setCommentError(undefined)
            updated()
          } catch (err) {
            setCommentError(String(err))
          } finally {
            setSaving(false)
          }
        }}
      >
        <Textarea
          aria-label="Comment"
          placeholder="Add comment…"
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          disabled={saving}
        />
        {commentError && (
          <p role="alert" className="text-sm text-destructive">
            {commentError}
          </p>
        )}
        <Button type="submit" disabled={saving || !comment.trim() || !bead}>
          {saving ? "Saving…" : "Add comment"}
        </Button>
      </form>
    </div>
  )
}
