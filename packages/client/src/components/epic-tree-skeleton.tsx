"use client"

import { Loader2 } from "lucide-react"
import { Skeleton } from "@/components/ui/skeleton"

// Mirrors epic-tree's identity cycle so the skeleton looks like what loads.
// Identity colours, left literal: see authorColors in bead-detail-helpers.
const SKELETON_EPIC_GROUPS = [
  { children: 3, color: "border-l-emerald-500" },
  { children: 2, color: "border-l-teal-500" },
  { children: 2, color: "border-l-cyan-500" },
]

export function EpicTreeSkeleton({ isSlowLoad = false }: { isSlowLoad?: boolean }) {
  return (
    <div className="space-y-2 py-4">
      {isSlowLoad && (
        <div className="flex items-center gap-2 px-3 py-2 mb-2 text-sm text-warning-text">
          <Loader2 className="h-4 w-4 animate-spin" />
          <span>Taking longer than expected&hellip;</span>
        </div>
      )}
      {SKELETON_EPIC_GROUPS.map((group, gi) => (
        <div key={gi} className={`border-l-2 ${group.color}`}>
          {/* Epic header row */}
          <div className="flex items-center gap-3 px-3 py-2.5">
            <Skeleton className="h-5 w-5 rounded" />
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-3.5 w-3.5 rounded" />
            <Skeleton className="h-4 flex-1 max-w-[200px]" />
            <Skeleton className="h-5 w-16 rounded-full" />
            <Skeleton className="h-5 w-12 rounded-full" />
            <Skeleton className="h-3 w-36 rounded-full" />
          </div>
          {/* Child bead rows */}
          <div className="border-t border-border/30">
            {Array.from({ length: group.children }).map((_, ci) => (
              <div key={ci} className="flex items-center gap-3 px-3 py-2 pl-8">
                <Skeleton className="h-4 w-20" />
                <Skeleton className="h-4 flex-1 max-w-[180px]" />
                <Skeleton className="h-5 w-16 rounded-full" />
                <Skeleton className="h-5 w-12 rounded-full" />
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}
