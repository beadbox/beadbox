// beadbox-9d4: a bead's T-shirt size, read from what bd already holds.
//
// The size follows the estimate in agent minutes (bd estimated_minutes),
// unless a revised estimate of what is left is recorded in the bead's
// metadata (estimate_revised_min), which then wins. A bead with no usable
// estimate is "unsized": the row says so plainly and never guesses.

import type { Bead } from "./types"

export type BeadSize = "XS" | "S" | "M" | "L"

/**
 * Size boundaries in minutes, the one place to change them:
 * XS < 15, S 15 to < 60, M 60 to 180, L > 180.
 */
export const SIZE_THRESHOLDS = { xsBelow: 15, sBelow: 60, mUpTo: 180 } as const

export function sizeForMinutes(minutes: number): BeadSize {
  if (minutes < SIZE_THRESHOLDS.xsBelow) return "XS"
  if (minutes < SIZE_THRESHOLDS.sBelow) return "S"
  if (minutes <= SIZE_THRESHOLDS.mUpTo) return "M"
  return "L"
}

export interface BeadSizeInfo {
  /** null when the bead has no usable estimate */
  size: BeadSize | null
  minutes: number | null
  /** true when the revised estimate from metadata was used */
  revised: boolean
  /** accessible name, e.g. "Size M, about 2h" or "Unsized: no estimate" */
  label: string
  /** tooltip text, e.g. "~2h", "~4h (revised)" or "No estimate" */
  tooltip: string
}

/** A usable estimate is a positive, finite number of minutes. 0 means "not estimated". */
function positiveMinutes(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) && value > 0 ? value : null
  if (typeof value === "string" && /^\d+(\.\d+)?$/.test(value.trim())) {
    const n = Number(value.trim())
    return n > 0 ? n : null
  }
  return null
}

function duration(minutes: number): string {
  return minutes >= 60 ? `${Math.round(minutes / 60)}h` : `${Math.round(minutes)}m`
}

export function beadSize(bead: Pick<Bead, "estimatedMinutes" | "metadata">): BeadSizeInfo {
  const revisedMinutes = positiveMinutes(bead.metadata?.estimate_revised_min)
  const minutes = revisedMinutes ?? positiveMinutes(bead.estimatedMinutes)
  if (minutes === null) {
    return { size: null, minutes: null, revised: false, label: "Unsized: no estimate", tooltip: "No estimate" }
  }
  const size = sizeForMinutes(minutes)
  const revised = revisedMinutes !== null
  const note = revised ? " (revised)" : ""
  return {
    size,
    minutes,
    revised,
    label: `Size ${size}, about ${duration(minutes)}${note}`,
    tooltip: `~${duration(minutes)}${note}`,
  }
}
