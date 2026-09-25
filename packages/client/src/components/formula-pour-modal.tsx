import { Loader2 } from "lucide-react"
import { useCallback, useEffect, useState } from "react"
import { toast } from "sonner"
import { rpc } from "../lib/rpc"
import type { FormulaDetail } from "../lib/types"
import { Button } from "./ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog"
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip"

interface FormulaPourModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  formula: FormulaDetail
  dbPath?: string
}

export function FormulaPourModal({ open, onOpenChange, formula, dbPath }: FormulaPourModalProps) {
  const [vars, setVars] = useState<Record<string, string>>({})
  const [assignee, setAssignee] = useState("")
  const [pouring, setPouring] = useState(false)
  const [validationErrors, setValidationErrors] = useState<Set<string>>(new Set())

  // Initialize vars from defaults on open
  useEffect(() => {
    if (!open) return
    const initial: Record<string, string> = {}
    for (const [name, v] of Object.entries(formula.vars ?? {})) {
      if (v.default) initial[name] = v.default
    }
    setVars(initial)
    setAssignee("")
    setValidationErrors(new Set())
  }, [open, formula])

  const handleVarChange = (name: string, value: string) => {
    setVars((prev) => ({ ...prev, [name]: value }))
    setValidationErrors((prev) => {
      const next = new Set(prev)
      next.delete(name)
      return next
    })
  }

  const validate = useCallback((): boolean => {
    const errors = new Set<string>()
    for (const [name, v] of Object.entries(formula.vars ?? {})) {
      if (v.required && !vars[name]?.trim()) {
        errors.add(name)
      }
    }
    setValidationErrors(errors)
    return errors.size === 0
  }, [formula.vars, vars])

  const handlePour = useCallback(async () => {
    if (!validate()) return
    setPouring(true)
    const result = await rpc.formulas.pourFormulaAction(
      formula.formula,
      vars,
      assignee.trim() || undefined,
      dbPath,
    )
    setPouring(false)
    if (result.success) {
      toast("Molecule created", {
        description: `Poured ${formula.formula} successfully.`,
      })
      onOpenChange(false)
    } else {
      toast.error("Pour failed", {
        description: result.error,
      })
    }
  }, [formula.formula, vars, assignee, dbPath, validate, onOpenChange])

  // bd omits `vars` for a formula without variables (beadbox-vco).
  const formulaVars = formula.vars ?? {}
  const hasVars = Object.keys(formulaVars).length > 0

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Pour: {formula.formula}</DialogTitle>
          <DialogDescription>
            Create a live workflow from this formula. This creates beads for each step.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          {/* Variable inputs */}
          {hasVars && (
            <div className="space-y-3">
              <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground/60">
                Variables
              </div>
              {Object.entries(formulaVars).map(([name, v]) => (
                <Tooltip key={name}>
                  <TooltipTrigger asChild>
                    <div>
                      <label className="text-sm text-foreground mb-1 block">
                        {name}
                        {v.required && <span className="text-amber-400 ml-0.5">*</span>}
                      </label>
                      <input
                        type="text"
                        value={vars[name] ?? ""}
                        onChange={(e) => handleVarChange(name, e.target.value)}
                        placeholder={v.default || ""}
                        className={`w-full px-3 py-2 text-sm rounded-md border bg-muted text-foreground ${
                          validationErrors.has(name)
                            ? "border-red-500/50 ring-1 ring-red-500/30"
                            : "border-border"
                        }`}
                      />
                      {validationErrors.has(name) && (
                        <p className="text-xs text-red-400 mt-0.5">Required</p>
                      )}
                    </div>
                  </TooltipTrigger>
                  <TooltipContent>{v.description || name}</TooltipContent>
                </Tooltip>
              ))}
            </div>
          )}

          {/* Assignee */}
          <div>
            <Tooltip>
              <TooltipTrigger asChild>
                <div>
                  <label className="text-sm text-foreground mb-1 block">
                    Assignee <span className="text-muted-foreground text-xs">(optional)</span>
                  </label>
                  <input
                    type="text"
                    value={assignee}
                    onChange={(e) => setAssignee(e.target.value)}
                    placeholder="e.g. qam"
                    className="w-full px-3 py-2 text-sm rounded-md border border-border bg-muted text-foreground"
                  />
                </div>
              </TooltipTrigger>
              <TooltipContent>Assignee for the root bead of the molecule</TooltipContent>
            </Tooltip>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pouring}>
            Cancel
          </Button>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button onClick={handlePour} disabled={pouring}>
                {pouring && <Loader2 className="h-4 w-4 animate-spin mr-1.5" />}
                Pour
              </Button>
            </TooltipTrigger>
            <TooltipContent>Create a live workflow from this formula</TooltipContent>
          </Tooltip>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
