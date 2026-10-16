import type { Bead } from "@/lib/types"

export function BeadCustomFields({ metadata }: { metadata: Bead["metadata"] }) {
  if (!metadata || Object.keys(metadata).length === 0) return null

  return (
    <div className="pt-4 border-t border-border/30">
      <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">
        Custom Fields
      </h3>
      <div className="space-y-1">
        {Object.entries(metadata).map(([key, value]) => (
          <div key={key} className="flex items-start justify-between gap-2 text-sm">
            <span className="text-muted-foreground">{key}</span>
            <span className="min-w-0 whitespace-pre-wrap break-all text-foreground/90">
              {typeof value === "string" ? value : JSON.stringify(value, null, 2)}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}
