// Settings → Workflow tab: add / remove / reorder custom bead statuses.
// Ported from v0.24 components/custom-statuses-manager.tsx (commit 1386b41 /
// bb-oqux) for v0.25's bb-wxuw. Three structural changes from the original:
//   1. Server actions → kkrpc handlers: import from @/lib/rpc instead of
//      @/actions/beads. The Proxy auto-types via @beadbox/server/handlers.
//   2. "use client" annotation removed — no Next.js anymore.
//   3. Validation imports from @/lib/status-validation (the client-side
//      copy); the server has its own copy for defence-in-depth.

import { ArrowDown, ArrowUp, Loader2, Plus, Save, Trash2 } from "lucide-react"
import type React from "react"
import { useCallback, useEffect, useRef, useState } from "react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { settleAction } from "@/lib/capture-action-failed"
import { rpc } from "@/lib/rpc"
import { validateStatusName } from "@/lib/status-validation"
import { cn } from "@/lib/utils"

interface CustomStatusesManagerProps {
  databasePath?: string
  onStatusesChanged?: () => void
}

export function CustomStatusesManager({
  databasePath,
  onStatusesChanged,
}: CustomStatusesManagerProps) {
  const [original, setOriginal] = useState<string[] | null>(null)
  const [current, setCurrent] = useState<string[]>([])
  const [input, setInput] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!databasePath) {
      setLoading(false)
      return
    }
    setLoading(true)
    rpc.beads
      .getCustomStatusList(databasePath)
      .then((list) => {
        setOriginal(list)
        setCurrent(list)
      })
      .finally(() => setLoading(false))
  }, [databasePath])

  const dirty = original !== null && !arraysEqual(original, current)

  const handleAdd = useCallback(() => {
    const trimmed = input.trim()
    const err = validateStatusName(trimmed, current)
    if (err) {
      setError(err)
      return
    }
    setCurrent([...current, trimmed])
    setInput("")
    setError(null)
    inputRef.current?.focus()
  }, [input, current])

  const handleInputChange = useCallback(
    (value: string) => {
      setInput(value)
      if (error) setError(null)
    },
    [error],
  )

  const handleRemove = useCallback(
    (index: number) => {
      setCurrent(current.filter((_, i) => i !== index))
    },
    [current],
  )

  const handleMove = useCallback(
    (index: number, delta: -1 | 1) => {
      const target = index + delta
      if (target < 0 || target >= current.length) return
      const next = [...current]
      ;[next[index], next[target]] = [next[target], next[index]]
      setCurrent(next)
    },
    [current],
  )

  const handleSave = useCallback(async () => {
    if (!databasePath || saving) return
    setSaving(true)
    try {
      const result = await settleAction(() => rpc.beads.updateCustomStatuses(current, databasePath))
      if (result.success) {
        setOriginal(current)
        toast.success("Custom statuses saved")
        onStatusesChanged?.()
      } else {
        toast.error("Failed to save", { description: result.error })
      }
    } finally {
      setSaving(false)
    }
  }, [current, databasePath, saving, onStatusesChanged])

  const handleReset = useCallback(() => {
    if (original) setCurrent(original)
    setInput("")
    setError(null)
  }, [original])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Enter") {
        e.preventDefault()
        handleAdd()
      }
    },
    [handleAdd],
  )

  if (!databasePath) {
    return (
      <p className="text-sm text-muted-foreground italic">
        Select a workspace to manage custom statuses.
      </p>
    )
  }

  return (
    <div className="space-y-4 max-w-lg">
      <div>
        <h3 className="text-lg font-semibold mb-1">Custom Statuses</h3>
        <p className="text-sm text-muted-foreground">
          Extend the bead workflow with team-specific statuses like{" "}
          <code className="text-xs bg-muted px-1 py-0.5 rounded">ready_for_qa</code> or{" "}
          <code className="text-xs bg-muted px-1 py-0.5 rounded">in_review</code>. Built-in statuses
          (open, in_progress, blocked, deferred, closed) cannot be redefined.
        </p>
      </div>

      {/* Add new */}
      <div className="space-y-1">
        <label htmlFor="new-status-input" className="text-sm font-medium">
          Add a status
        </label>
        <div className="flex items-center gap-2">
          <input
            id="new-status-input"
            ref={inputRef}
            type="text"
            value={input}
            onChange={(e) => handleInputChange(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="ready_for_qa"
            disabled={loading}
            aria-invalid={error ? "true" : "false"}
            aria-describedby={error ? "new-status-error" : undefined}
            className="flex-1 h-9 rounded-md border border-input bg-background px-3 py-1 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={handleAdd}
            disabled={loading || !input.trim()}
            aria-label="Add status"
          >
            <Plus className="h-4 w-4" />
            Add
          </Button>
        </div>
        {error && (
          <p id="new-status-error" className="text-xs text-red-400">
            {error}
          </p>
        )}
      </div>

      {/* Current list */}
      <div>
        <p className="text-sm font-medium mb-2">Current custom statuses</p>
        {loading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading...
          </div>
        ) : current.length === 0 ? (
          <p className="text-sm text-muted-foreground italic">
            No custom statuses yet. Add one above.
          </p>
        ) : (
          <ul className="rounded-md border divide-y" aria-label="Custom statuses">
            {current.map((name, i) => (
              <li key={name} className="flex items-center gap-2 px-3 py-2">
                <code className="flex-1 text-sm font-mono">{name}</code>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  onClick={() => handleMove(i, -1)}
                  disabled={i === 0}
                  aria-label={`Move ${name} up`}
                >
                  <ArrowUp className="h-3.5 w-3.5" />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  onClick={() => handleMove(i, 1)}
                  disabled={i === current.length - 1}
                  aria-label={`Move ${name} down`}
                >
                  <ArrowDown className="h-3.5 w-3.5" />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 text-red-400 hover:text-red-300"
                  onClick={() => handleRemove(i)}
                  aria-label={`Remove ${name}`}
                  title="Beads already using this status keep the label as a dangling value."
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Save / Reset */}
      <div className={cn("flex items-center gap-2 pt-2", !dirty && "opacity-50")}>
        <Button
          type="button"
          variant="default"
          size="sm"
          onClick={handleSave}
          disabled={!dirty || saving}
          aria-label="Save custom statuses"
        >
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
          {saving ? "Saving..." : "Save changes"}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={handleReset}
          disabled={!dirty || saving}
        >
          Reset
        </Button>
        {dirty && <span className="text-xs text-muted-foreground">Unsaved changes</span>}
      </div>
    </div>
  )
}

function arraysEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}
