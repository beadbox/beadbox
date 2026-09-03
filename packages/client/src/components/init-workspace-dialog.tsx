// Ported from components/init-workspace-dialog.tsx (P3.2 / bb-90zz.2).
// Swap: @/actions/workspaces.initializeWorkspace → rpc.workspaces.initializeWorkspace.
// Swap: @/ alias paths → relative.

import { AlertCircle, Loader2 } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import { trackedAction } from "../lib/capture-action-failed"
import { rpc } from "../lib/rpc"
import type { WorkspaceCard } from "../lib/types"
import { publishWorkspaceRegistryChange } from "../lib/workspace-registry-events"
import { Button } from "./ui/button"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "./ui/dialog"
import { Input } from "./ui/input"

interface InitWorkspaceDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSuccess: (workspace: WorkspaceCard) => void
  /** Pre-fill path (e.g., from addWorkspaceByPath needsInit response) */
  initialPath?: string
  isTauri?: boolean
}

export function InitWorkspaceDialog({
  open,
  onOpenChange,
  onSuccess,
  initialPath,
  isTauri,
}: InitWorkspaceDialogProps) {
  const [path, setPath] = useState(initialPath ?? "")
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [fixCommand, setFixCommand] = useState<string | null>(null)
  const [slowStart, setSlowStart] = useState(false)
  const slowTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  // Reset state when dialog opens
  useEffect(() => {
    if (open) {
      setPath(initialPath ?? "")
      setError(null)
      setFixCommand(null)
      setIsLoading(false)
      setSlowStart(false)
      if (slowTimerRef.current) clearTimeout(slowTimerRef.current)
      // Focus input after dialog animation
      setTimeout(() => inputRef.current?.focus(), 100)
    }
  }, [open, initialPath])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    const trimmed = path.trim()
    if (!trimmed) return

    setIsLoading(true)
    setError(null)
    setFixCommand(null)

    // bd v1.0.0+ embeds Dolt; no preflight needed (bb-cu2n). If bd itself
    // errors during init, the error message is surfaced unchanged below.
    slowTimerRef.current = setTimeout(() => setSlowStart(true), 3000)

    // The handler returns a discriminated union ({success: true, workspace} | InitError)
    // but trackedAction's generic signature widens it to { success: boolean; error?: string }.
    // Cast back to the source's union shape to recover .workspace on the success branch.
    const result = (await trackedAction(
      "initializeWorkspace",
      () =>
        rpc.workspaces.initializeWorkspace(trimmed) as Promise<
          | { success: true; workspace: WorkspaceCard }
          | { success: false; error: string; fixCommand?: string }
        >,
    )) as
      | { success: true; workspace: WorkspaceCard }
      | { success: false; error: string; fixCommand?: string }
    setIsLoading(false)
    if (slowTimerRef.current) clearTimeout(slowTimerRef.current)
    setSlowStart(false)

    if (result.success) {
      // `bd init` created the workspace and registered it. Announce the
      // membership change before handing back, so surfaces other than this
      // dialog's parent (the rail, the dashboard) re-read instead of
      // waiting for the next bd subscription bump.
      publishWorkspaceRegistryChange()
      onSuccess(result.workspace)
      onOpenChange(false)
    } else {
      setError(result.error ?? null)
      if (result.fixCommand) {
        setFixCommand(result.fixCommand)
      }
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
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Initialize Workspace</DialogTitle>
          <DialogDescription>
            Create a new beads workspace in a project directory.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
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
            <div className="bg-amber-500/10 border border-amber-500/20 rounded-md p-3">
              <div className="flex items-start gap-2">
                <AlertCircle className="h-4 w-4 text-amber-400 shrink-0 mt-0.5" />
                <div>
                  <p className="text-sm text-amber-300">{error}</p>
                  {fixCommand && (
                    <code className="block mt-1.5 text-xs bg-amber-500/10 text-amber-400/80 rounded px-2 py-1 font-mono">
                      {fixCommand}
                    </code>
                  )}
                </div>
              </div>
            </div>
          )}

          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="ghost"
              onClick={() => onOpenChange(false)}
              disabled={isLoading}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={!path.trim() || isLoading}>
              {isLoading && <Loader2 className="h-4 w-4 animate-spin mr-1.5" />}
              {isLoading && slowStart ? "Starting database..." : "Initialize"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}
