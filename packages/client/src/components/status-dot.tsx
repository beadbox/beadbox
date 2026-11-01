// beadbox-o3h: a small dot in a status's color, for places that list statuses
// without a badge (the Status filter rows, the Grouped view's section
// headers). Its default is the status's dot class from the detail panel; a
// chosen color recolors it through the injected stylesheet (role "dot").

import { getStatusDisplayConfig } from "@/components/bead-detail-helpers"
import { cn } from "@/lib/utils"

export function StatusDot({ status, className }: { status: string; className?: string }) {
  return (
    <span
      aria-hidden="true"
      data-status={status}
      data-status-role="dot"
      className={cn(
        "inline-block w-2 h-2 rounded-full shrink-0",
        getStatusDisplayConfig(status).dotClass,
        className,
      )}
    />
  )
}
