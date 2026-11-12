import { AlertCircle, FolderOpen, Loader2, RotateCcw } from "lucide-react"
import { useCallback, useEffect, useState } from "react"

import { publishBdPathChange, subscribeBdPathChange } from "../lib/bd-path-events"
import { queryClient } from "../lib/query-client"
import { rpc } from "../lib/rpc"
import { cn } from "../lib/utils"
import { Button } from "./ui/button"
import { Input } from "./ui/input"

export interface ClientBdPathInfo {
  effectivePath: string
  source: "env" | "saved" | "auto"
  envPath: string | null
  savedPath: string | null
  bdAvailable: boolean
  bdVersion: string | null
  minVersion: string
  platform: string
  statusError: string | null
  statusErrorCode: string | null
}

export function formatBdPathSourceLabel(source: ClientBdPathInfo["source"]): string {
  switch (source) {
    case "env":
      return "BD_PATH environment variable"
    case "saved":
      return "Custom path"
    case "auto":
      return "Automatic detection"
  }
}

function placeholderForPlatform(platform?: string | null): string {
  if (platform === "win32") {
    return "C:\\Users\\you\\AppData\\Local\\mise\\shims\\bd.exe"
  }
  return "~/.local/share/mise/shims/bd"
}

interface BdPathControlProps {
  variant?: "settings" | "onboarding"
  platform?: string | null
  onApplied?: (info: ClientBdPathInfo) => void
}

export function BdPathControl({
  variant = "settings",
  platform,
  onApplied,
}: BdPathControlProps) {
  const [info, setInfo] = useState<ClientBdPathInfo | null>(null)
  const [inputValue, setInputValue] = useState("")
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const isTauri =
    typeof window !== "undefined" &&
    Boolean((window as unknown as Record<string, unknown>).__TAURI_INTERNALS__)

  const refresh = useCallback(async () => {
    if (typeof rpc.health?.getBdPathInfo !== "function") return
    try {
      const next = await rpc.health.getBdPathInfo()
      setInfo(next)
      setInputValue((prev) => (dirty ? prev : (next.savedPath ?? "")))
    } catch {
      // Browser dev / stub RPC mode
    }
  }, [dirty])

  useEffect(() => {
    void refresh()
    return subscribeBdPathChange(() => {
      void refresh()
    })
  }, [refresh])

  const notifyApplied = (nextInfo: ClientBdPathInfo) => {
    setInfo(nextInfo)
    setInputValue(nextInfo.savedPath ?? "")
    setDirty(false)
    setError(null)
    publishBdPathChange()
    void queryClient.invalidateQueries()
    onApplied?.(nextInfo)
  }

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault()
    const trimmed = inputValue.trim()
    if (!trimmed || typeof rpc.health?.setBdPath !== "function") return
    setSaving(true)
    setError(null)
    try {
      const res = await rpc.health.setBdPath(trimmed)
      if (!res.ok) {
        setError(res.error)
      } else {
        notifyApplied(res.info)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  const handleResetToAuto = async () => {
    if (typeof rpc.health?.setBdPath !== "function") return
    setSaving(true)
    setError(null)
    try {
      const res = await rpc.health.setBdPath(null)
      if (!res.ok) {
        setError(res.error)
      } else {
        notifyApplied(res.info)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  const handleBrowse = async () => {
    if (!isTauri) return
    try {
      const { open: openDialog } = await import("@tauri-apps/plugin-dialog")
      const selected = await openDialog({ directory: false, multiple: false })
      if (typeof selected === "string" && selected) {
        setInputValue(selected)
        setDirty(true)
        setError(null)
      }
    } catch {
      // File dialog unavailable
    }
  }

  const resolvedPlatform = platform ?? info?.platform ?? null
  const showActiveError =
    !error &&
    info?.statusError &&
    (variant === "settings" || info.source === "saved" || info.source === "env")

  return (
    <div
      className={cn(
        "text-left space-y-3",
        variant === "onboarding"
          ? "mt-4 pt-4 border-t border-border/60"
          : "max-w-lg rounded-md border border-border p-3.5 bg-muted/20",
      )}
    >
      {variant === "onboarding" && (
        <p className="text-xs font-medium text-muted-foreground">
          Already have <span className="font-mono text-foreground">bd</span> installed elsewhere?
          Set its path:
        </p>
      )}

      {info && (
        <div className="space-y-1 text-xs">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <span className="text-muted-foreground">Active source:</span>
            <span className="inline-flex items-center rounded-full border border-border bg-muted/60 px-2 py-0.5 font-medium text-foreground">
              {formatBdPathSourceLabel(info.source)}
            </span>
          </div>
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <span className="text-muted-foreground">Resolved binary:</span>
            <span className="font-mono text-foreground break-all">
              <span>{info.effectivePath}</span>
              {info.bdVersion ? (
                <span className="text-muted-foreground">{` (v${info.bdVersion})`}</span>
              ) : null}
            </span>
          </div>
          {info.source === "env" && (
            <p className="text-[11px] text-muted-foreground pt-0.5">
              <span className="font-mono text-foreground">BD_PATH</span> is set in Beadbox&apos;s
              environment and overrides{" "}
              {info.savedPath ? `your saved path (${info.savedPath})` : "automatic detection"}.
            </p>
          )}
        </div>
      )}

      {showActiveError && (
        <div className="flex items-start gap-2 text-xs text-amber-400">
          <AlertCircle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
          <span>{info?.statusError}</span>
        </div>
      )}

      <form onSubmit={handleSave} className="space-y-2">
        <div className="flex items-center gap-2">
          <Input
            aria-label="Custom bd executable path"
            value={inputValue}
            onChange={(e) => {
              setInputValue(e.target.value)
              setDirty(true)
              if (error) setError(null)
            }}
            placeholder={placeholderForPlatform(resolvedPlatform)}
            disabled={saving}
            className="font-mono text-xs h-8"
          />
          {isTauri && (
            <Button
              type="button"
              variant="outline"
              size="icon"
              className="h-8 w-8 shrink-0"
              onClick={handleBrowse}
              disabled={saving}
              aria-label="Browse for bd executable"
            >
              <FolderOpen className="h-3.5 w-3.5" />
            </Button>
          )}
          <Button
            type="submit"
            size="sm"
            variant={variant === "onboarding" ? "secondary" : "default"}
            className="h-8 shrink-0"
            disabled={!inputValue.trim() || saving}
            aria-label="Save bd path"
          >
            {saving && <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" />}
            Save
          </Button>
        </div>

        {error && (
          <div role="alert" className="flex items-start gap-2 text-xs text-amber-400">
            <AlertCircle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
            <span>{error}</span>
          </div>
        )}

        {info?.savedPath && (
          <div className="flex items-center justify-between pt-0.5">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-xs text-muted-foreground hover:text-foreground"
              onClick={handleResetToAuto}
              disabled={saving}
            >
              <RotateCcw className="h-3 w-3 mr-1.5" />
              Use automatic detection
            </Button>
          </div>
        )}
      </form>
    </div>
  )
}
