import { ChevronRight, Loader2 } from "lucide-react"
import { useCallback, useEffect, useState } from "react"
import { rpc } from "../lib/rpc"
import type { CookedFormula, FormulaDetail } from "../lib/types"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "./ui/dialog"
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip"

interface FormulaPreviewModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  formula: FormulaDetail
  dbPath?: string
}

export function FormulaPreviewModal({
  open,
  onOpenChange,
  formula,
  dbPath,
}: FormulaPreviewModalProps) {
  const [cooked, setCooked] = useState<CookedFormula | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [runtimeMode, setRuntimeMode] = useState(false)
  const [vars, setVars] = useState<Record<string, string>>({})

  // Initialize vars from defaults
  useEffect(() => {
    if (!open) return
    const initial: Record<string, string> = {}
    for (const [name, v] of Object.entries(formula.vars ?? {})) {
      if (v.default) initial[name] = v.default
    }
    setVars(initial)
    setRuntimeMode(false)
    setCooked(null)
    setError(null)
  }, [open, formula])

  // Fetch preview on open and when vars change in runtime mode
  const fetchPreview = useCallback(async () => {
    setLoading(true)
    setError(null)
    const result = await rpc.formulas.previewFormula(
      formula.formula,
      runtimeMode ? vars : undefined,
      dbPath,
    )
    if (result.success) {
      setCooked(result.data)
    } else {
      setError(result.error)
    }
    setLoading(false)
  }, [formula.formula, runtimeMode, vars, dbPath])

  useEffect(() => {
    if (open) fetchPreview()
  }, [open, fetchPreview])

  const handleVarChange = (name: string, value: string) => {
    setVars((prev) => ({ ...prev, [name]: value }))
  }

  // bd omits `vars` for a formula without variables (beadbox-vco).
  const formulaVars = formula.vars ?? {}
  const hasVars = Object.keys(formulaVars).length > 0

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl max-h-[80vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>Preview: {formula.formula}</DialogTitle>
          <DialogDescription>Read-only preview. No beads are created.</DialogDescription>
        </DialogHeader>

        {/* Runtime mode toggle + variable inputs */}
        {hasVars && (
          <div className="border-b border-border/50 pb-3 space-y-2">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={runtimeMode}
                onChange={(e) => setRuntimeMode(e.target.checked)}
                className="rounded border-border"
              />
              <span className="text-foreground">Runtime mode (resolve variables)</span>
            </label>
            {runtimeMode && (
              <div className="grid grid-cols-2 gap-2 mt-2">
                {Object.entries(formulaVars).map(([name, v]) => (
                  <Tooltip key={name}>
                    <TooltipTrigger asChild>
                      <div>
                        <label className="text-xs text-muted-foreground mb-0.5 block">
                          {name}
                          {v.required && <span className="text-amber-400 ml-0.5">*</span>}
                        </label>
                        <input
                          type="text"
                          value={vars[name] ?? ""}
                          onChange={(e) => handleVarChange(name, e.target.value)}
                          placeholder={v.default || ""}
                          className="w-full px-2 py-1.5 text-sm rounded-md border border-border bg-muted text-foreground"
                        />
                      </div>
                    </TooltipTrigger>
                    <TooltipContent>{v.description || name}</TooltipContent>
                  </Tooltip>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Cooked output */}
        <div className="flex-1 overflow-y-auto min-h-0 space-y-2">
          {loading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : error ? (
            <div className="text-sm text-red-400 py-4 px-2">{error}</div>
          ) : cooked ? (
            cooked.steps.map((step) => (
              <div key={step.id} className="border border-border/50 rounded-md px-3 py-2.5">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-foreground">{step.title}</span>
                  {step.assignee && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
                      @{step.assignee}
                    </span>
                  )}
                  {step.gate && (
                    <span
                      className={`text-[10px] px-1.5 py-0.5 rounded border ${
                        step.gate.type === "human"
                          ? "bg-amber-500/15 text-amber-400 border-amber-500/20"
                          : "bg-blue-500/15 text-blue-400 border-blue-500/20"
                      }`}
                    >
                      {step.gate.type}
                    </span>
                  )}
                </div>
                {step.needs && step.needs.length > 0 && (
                  <div className="flex items-center gap-1 mt-1 text-[11px] text-muted-foreground">
                    <ChevronRight className="h-3 w-3" />
                    needs: {step.needs.join(", ")}
                  </div>
                )}
                {step.description && (
                  <pre className="mt-1.5 text-xs font-mono text-muted-foreground whitespace-pre-wrap line-clamp-4">
                    {step.description.slice(0, 200)}
                  </pre>
                )}
              </div>
            ))
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  )
}
