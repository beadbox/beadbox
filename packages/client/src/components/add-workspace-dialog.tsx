// Ported from components/add-workspace-dialog.tsx (P3.2 / bb-90zz.2).
// Swap: @/actions/workspaces.{addWorkspaceByPath, scanForDoltServers,
//        discoverServerDatabases, addServerWorkspace, getLocalWorkspaceOverlaps,
//        replaceLocalWithServer} → rpc.workspaces.*
// Swap: @/ alias paths → relative.

import { AlertCircle, ChevronDown, ChevronRight, Loader2, Server } from "lucide-react"
import { useCallback, useEffect, useRef, useState } from "react"
import { safeCapture } from "../lib/posthog-safe"
import { rpc } from "../lib/rpc"
import { Button } from "./ui/button"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "./ui/dialog"
import { Input } from "./ui/input"

// LocalOverlap mirrored inline from packages/server/src/handlers/workspaces.ts.
// The cross-package type resolution via "@beadbox/server/src/handlers/workspaces"
// fails through the client tsconfig (same pre-existing breakage as rpc.ts and
// settings-dialog.tsx); inline copy keeps this bead off that adjacent yak.
interface LocalOverlap {
  workspaceId: string
  localPath: string
}

import { getAnalyticsEnabled } from "../lib/local-storage"
import { storeCredential } from "../lib/tauri-credentials"
import type { ScanResult, ServerDatabase, WorkspaceCard } from "../lib/types"
import { publishWorkspaceRegistryChange } from "../lib/workspace-registry-events"

interface AddWorkspaceDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onWorkspaceAdded: (workspaces: WorkspaceCard[], replacedIds?: string[]) => void
  onNeedsInit: (path: string) => void
  isTauri?: boolean
  defaultTab?: "local" | "server"
}

export function AddWorkspaceDialog({
  open,
  onOpenChange,
  onWorkspaceAdded,
  onNeedsInit,
  isTauri,
  defaultTab = "local",
}: AddWorkspaceDialogProps) {
  const [showServer, setShowServer] = useState(defaultTab === "server")

  useEffect(() => {
    if (open) setShowServer(defaultTab === "server")
  }, [open, defaultTab])

  // Every add path in this dialog — local folder, server databases, and
  // local→server replacement — lands here, so the registry-change
  // announcement is made once for all three. Surfaces that are not this
  // dialog's parent (the rail when the add came from the dashboard, and
  // vice versa) have no other way to learn: a registry write raises no bd
  // change signal.
  const handleWorkspaceAdded = useCallback(
    (added: WorkspaceCard[], replacedIds?: string[]) => {
      publishWorkspaceRegistryChange()
      onWorkspaceAdded(added, replacedIds)
    },
    [onWorkspaceAdded],
  )

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Add Workspace</DialogTitle>
          <DialogDescription>
            Point to a project folder that contains a .beads directory.
          </DialogDescription>
        </DialogHeader>

        <LocalPathTab
          onWorkspaceAdded={handleWorkspaceAdded}
          onNeedsInit={onNeedsInit}
          onClose={() => onOpenChange(false)}
          isTauri={isTauri}
        />

        <div className="border-t border-border pt-3">
          <button
            type="button"
            onClick={() => setShowServer(!showServer)}
            className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            {showServer ? (
              <ChevronDown className="h-3 w-3" />
            ) : (
              <ChevronRight className="h-3 w-3" />
            )}
            Advanced: Connect to remote server
          </button>

          {showServer && (
            <div className="mt-3">
              <ServerTab
                onWorkspaceAdded={handleWorkspaceAdded}
                onClose={() => onOpenChange(false)}
                isActive={open && showServer}
              />
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}

// --- Local Path Tab ---

function LocalPathTab({
  onWorkspaceAdded,
  onNeedsInit,
  onClose,
  isTauri,
}: {
  onWorkspaceAdded: (workspaces: WorkspaceCard[], replacedIds?: string[]) => void
  onNeedsInit: (path: string) => void
  onClose: () => void
  isTauri?: boolean
}) {
  const [path, setPath] = useState("")
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const [slowStart, setSlowStart] = useState(false)
  const slowTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    setTimeout(() => inputRef.current?.focus(), 100)
  }, [])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    const trimmed = path.trim()
    if (!trimmed) return

    setIsLoading(true)
    slowTimerRef.current = setTimeout(() => setSlowStart(true), 3000)
    setError(null)

    const result = await rpc.workspaces.addWorkspaceByPath(trimmed)
    setIsLoading(false)
    if (slowTimerRef.current) clearTimeout(slowTimerRef.current)
    setSlowStart(false)

    if (result.success) {
      onWorkspaceAdded([result.workspace])
      onClose()
    } else if (result.needsInit) {
      onNeedsInit(trimmed)
      onClose()
    } else {
      setError(result.error)
    }
  }

  const handleBrowse = async () => {
    if (!isTauri) return
    try {
      const { open: openDialog } = await import("@tauri-apps/plugin-dialog")
      const selected = await openDialog({ directory: true, multiple: false })
      if (selected) setPath(selected as string)
    } catch {
      // Folder picker unavailable
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4 pt-2">
      <div className="flex gap-2">
        <Input
          ref={inputRef}
          value={path}
          onChange={(e) => setPath(e.target.value)}
          placeholder="~/Projects/my-project"
          disabled={isLoading}
        />
        {isTauri && (
          <Button type="button" variant="outline" size="icon" onClick={handleBrowse}>
            <span className="sr-only">Browse</span>
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M5 4h4l3 3h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z" />
            </svg>
          </Button>
        )}
      </div>

      {error && (
        <div className="flex items-start gap-2 text-sm text-amber-400">
          <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
          <span>{error}</span>
        </div>
      )}

      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onClose} disabled={isLoading}>
          Cancel
        </Button>
        <Button type="submit" disabled={!path.trim() || isLoading}>
          {isLoading && <Loader2 className="h-4 w-4 animate-spin mr-1.5" />}
          {isLoading && slowStart ? "Starting database..." : "Add"}
        </Button>
      </div>
    </form>
  )
}

// --- Server Tab ---

type ServerPhase = "scanning" | "scan-results" | "manual" | "discovering" | "select-db" | "adding"

function ServerTab({
  onWorkspaceAdded,
  onClose,
  isActive,
}: {
  onWorkspaceAdded: (workspaces: WorkspaceCard[], replacedIds?: string[]) => void
  onClose: () => void
  isActive: boolean
}) {
  // isActive is unused in the body; preserved for signature parity with the
  // Next.js source. void-consume satisfies sidecar tsconfig's noUnusedParameters.
  void isActive
  const [phase, setPhase] = useState<ServerPhase>("manual")
  const [scanResults, setScanResults] = useState<ScanResult[]>([])
  const [scanError, setScanError] = useState<string | null>(null)

  const [host, setHost] = useState("127.0.0.1")
  const [port, setPort] = useState("3307")
  const [user, setUser] = useState("root")
  const [password, setPassword] = useState("")
  const [tls, setTls] = useState(false)

  const [databases, setDatabases] = useState<ServerDatabase[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [overlaps, setOverlaps] = useState<Record<string, LocalOverlap>>({})
  const [replacingDb, setReplacingDb] = useState<string | null>(null)
  const [discoverError, setDiscoverError] = useState<string | null>(null)
  const [addError, setAddError] = useState<string | null>(null)

  const abortRef = useRef<AbortController | null>(null)

  useEffect(() => {
    return () => {
      abortRef.current?.abort()
    }
  }, [])

  const runScan = useCallback(async () => {
    setPhase("scanning")
    setScanError(null)
    abortRef.current = new AbortController()
    const result = await rpc.workspaces.scanForDoltServers()
    if (abortRef.current?.signal.aborted) return
    if (!result.success) {
      setScanError(result.error || "Scan failed")
      setPhase("manual")
      return
    }
    if (result.servers.length === 0) {
      setPhase("manual")
      return
    }
    setScanResults(result.servers)
    setPhase("scan-results")
  }, [])

  const handleDiscover = useCallback(
    async (h: string, p: number, u?: string, pw?: string, useTls?: boolean) => {
      abortRef.current = new AbortController()
      const startTime = Date.now()
      if (getAnalyticsEnabled()) {
        safeCapture("app_server_scan_started", {
          source: "add_workspace_dialog",
        })
      }
      setPhase("discovering")
      setDiscoverError(null)
      const result = await rpc.workspaces.discoverServerDatabases(
        h,
        p,
        u || undefined,
        pw || undefined,
        useTls || undefined,
      )

      if (getAnalyticsEnabled()) {
        safeCapture("app_server_scan_completed", {
          success: result.success,
          databases_found: result.success ? result.databases?.length || 0 : 0,
          duration_ms: Date.now() - startTime,
          error_type: !result.success
            ? result.error?.includes("ECONNREFUSED")
              ? "connection_refused"
              : result.error?.includes("Access denied")
                ? "access_denied"
                : "other"
            : undefined,
        })
      }

      if (!result.success) {
        setDiscoverError(result.error)
        setPhase("manual")
        return
      }
      if (result.databases.length === 0) {
        setDiscoverError(`No beads databases found on ${h}:${p}.`)
        setPhase("manual")
        return
      }
      setDatabases(result.databases)
      setSelected(new Set())
      // Check which databases overlap with already-registered local workspaces
      const dbNames = result.databases.map((d: ServerDatabase) => d.databaseName)
      const localOverlaps = await rpc.workspaces.getLocalWorkspaceOverlaps(h, p, dbNames)
      setOverlaps(localOverlaps)
      setPhase("select-db")
    },
    [],
  )

  const handleUseScanResult = useCallback(
    (r: ScanResult) => {
      setHost(r.host)
      setPort(r.port.toString())
      handleDiscover(r.host, r.port, user, password, tls)
    },
    [handleDiscover, user, password, tls],
  )

  const handleManualSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    const p = parseInt(port, 10)
    if (host.trim() && !Number.isNaN(p) && p > 0 && p <= 65535) {
      handleDiscover(host.trim(), p, user.trim() || "root", password, tls)
    }
  }

  const handleAddSelected = async () => {
    setAddError(null)
    setPhase("adding")
    const portNum = parseInt(port, 10)
    const added: WorkspaceCard[] = []

    for (const dbName of selected) {
      // Skip overlapping databases (they use the Replace flow instead)
      if (overlaps[dbName]) continue
      const result = await rpc.workspaces.addServerWorkspace(
        host,
        portNum,
        dbName,
        user.trim() || "root",
        password || undefined,
        tls,
      )
      if (!result.success) {
        setAddError(result.error)
        setPhase("select-db")
        return
      }
      if (password) {
        await storeCredential(result.credentialKey, password)
      }
      added.push(result.workspace)
    }

    onWorkspaceAdded(added)
    onClose()
  }

  const handleReplace = async (dbName: string) => {
    const overlap = overlaps[dbName]
    if (!overlap) return
    setReplacingDb(dbName)
    setAddError(null)
    const portNum = parseInt(port, 10)
    const result = await rpc.workspaces.replaceLocalWithServer(
      overlap.workspaceId,
      host,
      portNum,
      dbName,
      user.trim() || "root",
      tls,
      password || undefined,
    )
    setReplacingDb(null)
    if (!result.success) {
      setAddError(result.error)
      return
    }
    if (password) {
      await storeCredential(result.credentialKey, password)
    }
    onWorkspaceAdded([result.workspace], [overlap.workspaceId])
    onClose()
  }

  if (phase === "scanning") {
    return (
      <div className="flex items-center gap-2 py-8 justify-center text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        <span>Scanning for local Dolt servers...</span>
      </div>
    )
  }

  if (phase === "discovering") {
    return (
      <div className="flex items-center gap-2 py-8 justify-center text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        <span>
          Discovering databases on {host}:{port}...
        </span>
      </div>
    )
  }

  if (phase === "adding") {
    return (
      <div className="flex items-center gap-2 py-8 justify-center text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        <span>
          Adding {selected.size} workspace{selected.size !== 1 ? "s" : ""}...
        </span>
      </div>
    )
  }

  if (phase === "scan-results") {
    return (
      <div className="space-y-3 pt-2">
        <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
          Found {scanResults.length} server{scanResults.length !== 1 ? "s" : ""}
        </p>
        <div className="space-y-1.5 max-h-[200px] overflow-y-auto">
          {scanResults.map((r) => (
            <div
              key={r.port}
              className="flex items-center justify-between rounded-md border border-border px-3 py-2"
            >
              <div className="flex items-center gap-2 text-sm">
                <span className="text-green-400">&#9679;</span>
                <span className="font-mono text-foreground">
                  {r.host}:{r.port}
                </span>
              </div>
              <Button size="sm" className="h-7 px-3 text-xs" onClick={() => handleUseScanResult(r)}>
                Use
              </Button>
            </div>
          ))}
        </div>
        <div className="flex items-center justify-end pt-1">
          <button
            type="button"
            onClick={() => setPhase("manual")}
            className="text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            Enter manually
          </button>
        </div>
      </div>
    )
  }

  if (phase === "select-db") {
    const addableCount = [...selected].filter((name) => !overlaps[name]).length
    const nonOverlappingDbs = databases.filter((d) => !overlaps[d.databaseName])

    return (
      <div className="space-y-3 pt-2">
        <div className="flex items-center justify-between">
          <p className="text-sm font-medium text-foreground">
            {databases.length} database{databases.length !== 1 ? "s" : ""} on {host}:{port}
          </p>
          {nonOverlappingDbs.length > 0 && (
            <button
              onClick={
                addableCount === nonOverlappingDbs.length
                  ? () => setSelected(new Set())
                  : () => setSelected(new Set(nonOverlappingDbs.map((d) => d.databaseName)))
              }
              className="text-xs text-primary hover:text-primary/80"
            >
              {addableCount === nonOverlappingDbs.length ? "Deselect All" : "Select All"}
            </button>
          )}
        </div>
        <div className="space-y-2 max-h-[250px] overflow-y-auto">
          {databases.map((db) => {
            const overlap = overlaps[db.databaseName]
            if (overlap) {
              const displayPath = overlap.localPath.startsWith("/Users/")
                ? `~${overlap.localPath.slice(overlap.localPath.indexOf("/", 1))}`
                : overlap.localPath
              return (
                <div
                  key={db.databaseName}
                  className="rounded-md border border-border px-3 py-2 space-y-1.5"
                >
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-foreground">{db.databaseName}</span>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 px-2 text-xs"
                      disabled={replacingDb === db.databaseName}
                      onClick={() => handleReplace(db.databaseName)}
                    >
                      {replacingDb === db.databaseName ? (
                        <Loader2 className="h-3 w-3 animate-spin mr-1" />
                      ) : null}
                      Replace
                    </Button>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Already registered as local workspace at {displayPath}
                  </p>
                </div>
              )
            }
            return (
              <label
                key={db.databaseName}
                className="flex items-center gap-3 rounded-md border border-border px-3 py-2 cursor-pointer hover:bg-accent/30 transition-colors"
              >
                <input
                  type="checkbox"
                  checked={selected.has(db.databaseName)}
                  onChange={() => {
                    setSelected((prev) => {
                      const next = new Set(prev)
                      if (next.has(db.databaseName)) next.delete(db.databaseName)
                      else next.add(db.databaseName)
                      return next
                    })
                  }}
                  className="rounded border-border"
                />
                <span className="text-sm text-foreground">{db.databaseName}</span>
              </label>
            )
          })}
        </div>
        {addError && (
          <div className="flex items-start gap-2 text-sm text-amber-400">
            <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
            <span>{addError}</span>
          </div>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setPhase("manual")}>
            Back
          </Button>
          {addableCount > 0 && (
            <Button onClick={handleAddSelected} disabled={addableCount === 0}>
              Add {addableCount} Workspace{addableCount !== 1 ? "s" : ""}
            </Button>
          )}
        </div>
      </div>
    )
  }

  // Manual form (default / fallback)
  return (
    <div className="space-y-3 pt-2">
      <p className="text-xs text-muted-foreground">
        Connect to a remote Dolt server. If you ran{" "}
        <code className="text-[11px] bg-muted px-1 py-0.5 rounded">bd init</code> locally, close
        this and use the path field above instead.
      </p>
      {scanError && <p className="text-xs text-amber-400">Scan: {scanError}</p>}
      {!scanError && scanResults.length > 0 && null}

      {discoverError && (
        <div className="flex items-start gap-2 text-sm text-amber-400 mb-2">
          <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
          <span>{discoverError}</span>
        </div>
      )}

      <form onSubmit={handleManualSubmit} className="space-y-3">
        <div className="flex gap-2">
          <div className="flex-1 space-y-1">
            <label className="text-xs font-medium text-muted-foreground">Host</label>
            <Input value={host} onChange={(e) => setHost(e.target.value)} placeholder="127.0.0.1" />
          </div>
          <div className="w-24 space-y-1">
            <label className="text-xs font-medium text-muted-foreground">Port</label>
            <Input
              value={port}
              onChange={(e) => setPort(e.target.value)}
              placeholder="3307"
              type="number"
              min={1}
              max={65535}
            />
          </div>
        </div>
        <div className="flex gap-2">
          <div className="flex-1 space-y-1">
            <label className="text-xs font-medium text-muted-foreground">User</label>
            <Input value={user} onChange={(e) => setUser(e.target.value)} placeholder="root" />
          </div>
          <div className="flex-1 space-y-1">
            <label className="text-xs font-medium text-muted-foreground">Password</label>
            <Input
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Optional"
              type="password"
            />
          </div>
        </div>
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={tls}
            onChange={(e) => setTls(e.target.checked)}
            className="rounded border-border"
          />
          <span className="text-xs text-muted-foreground">Use TLS</span>
        </label>
        <div className="flex items-center justify-between">
          <button
            type="button"
            onClick={() => runScan()}
            className="text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            Re-scan ports
          </button>
          <div className="flex gap-2">
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={!host.trim() || !port}>
              <Server className="h-4 w-4 mr-1.5" />
              Discover
            </Button>
          </div>
        </div>
      </form>
    </div>
  )
}
