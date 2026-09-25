// Ported from components/edit-connection-dialog.tsx (P3.2 / bb-90zz.2).
// Swap: @/actions/workspaces.updateServerConnection → rpc.workspaces.updateServerConnection.
// Swap: @/ alias paths → relative.

import { AlertCircle, Loader2 } from "lucide-react"
import { useEffect, useState } from "react"
import { rpc } from "../lib/rpc"
import type { WorkspaceCard } from "../lib/types"
import { Button } from "./ui/button"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "./ui/dialog"
import { Input } from "./ui/input"

interface EditConnectionDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  workspace: WorkspaceCard | null
  onUpdated: (workspace: WorkspaceCard) => void
}

export function EditConnectionDialog({
  open,
  onOpenChange,
  workspace,
  onUpdated,
}: EditConnectionDialogProps) {
  const [host, setHost] = useState("")
  const [port, setPort] = useState("")
  const [user, setUser] = useState("")
  const [password, setPassword] = useState("")
  const [tls, setTls] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Pre-fill form when workspace changes
  useEffect(() => {
    if (workspace && open) {
      setHost(workspace.serverHost ?? "127.0.0.1")
      setPort(String(workspace.serverPort ?? 3307))
      setUser(workspace.serverUser ?? "root")
      setPassword("")
      setTls(workspace.serverTls ?? false)
      setError(null)
      setSaving(false)
    }
  }, [workspace, open])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!workspace) return

    const portNum = parseInt(port, 10)
    if (!host.trim() || Number.isNaN(portNum) || portNum < 1 || portNum > 65535) {
      setError("Invalid host or port.")
      return
    }

    setSaving(true)
    setError(null)

    const result = await rpc.workspaces.updateServerConnection(
      workspace.id,
      host.trim(),
      portNum,
      user.trim() || "root",
      password,
      tls,
    )

    setSaving(false)

    if (result.success) {
      onUpdated(result.workspace)
      onOpenChange(false)
    } else {
      setError(result.error)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!saving) onOpenChange(v)
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Configure Connection</DialogTitle>
          <DialogDescription>
            Update connection details for {workspace?.name ?? "workspace"}.
            {workspace?.serverDatabase ? ` Database: ${workspace.serverDatabase}` : ""}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-3 pt-1">
          <div className="flex gap-2">
            <div className="flex-1 space-y-1">
              <label className="text-xs font-medium text-muted-foreground">Host</label>
              <Input
                value={host}
                onChange={(e) => setHost(e.target.value)}
                placeholder="127.0.0.1"
                disabled={saving}
              />
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
                disabled={saving}
              />
            </div>
          </div>
          <div className="flex gap-2">
            <div className="flex-1 space-y-1">
              <label className="text-xs font-medium text-muted-foreground">User</label>
              <Input
                value={user}
                onChange={(e) => setUser(e.target.value)}
                placeholder="root"
                disabled={saving}
              />
            </div>
            <div className="flex-1 space-y-1">
              <label className="text-xs font-medium text-muted-foreground">Password</label>
              <Input
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Not stored on disk"
                type="password"
                disabled={saving}
              />
            </div>
          </div>
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={tls}
              onChange={(e) => setTls(e.target.checked)}
              className="rounded border-border"
              disabled={saving}
            />
            <span className="text-xs text-muted-foreground">Use TLS</span>
          </label>

          {error && (
            <div className="flex items-start gap-2 text-sm text-amber-400">
              <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
              <span>{error}</span>
            </div>
          )}

          <div className="flex justify-end gap-2 pt-1">
            <Button
              type="button"
              variant="ghost"
              onClick={() => onOpenChange(false)}
              disabled={saving}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={saving || !host.trim() || !port}>
              {saving && <Loader2 className="h-4 w-4 animate-spin mr-1.5" />}
              {saving ? "Validating..." : "Save"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}
