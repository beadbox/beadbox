// Platform-aware bd install / upgrade instructions (moved out of
// startup-gate.tsx for beadbox-ag1 so the workspaces page shares them).

import { ExternalLink } from "lucide-react"
import { CopyableCommand } from "@/components/copyable-command"
import { cn } from "@/lib/utils"

export interface PlatformFlags {
  isMac: boolean
  isWindows: boolean
  isLinux: boolean
}

// beads' documented embedded-capable go install (docs/getting-started/installation.md):
// the module path is still github.com/steveyegge/beads, and gms_pure_go avoids ICU.
export const BD_GO_INSTALL =
  "CGO_ENABLED=1 GOFLAGS=-tags=gms_pure_go go install github.com/steveyegge/beads/cmd/bd@latest"

// brew is macOS-only: it renders solely inside an explicit isMac branch, never
// as the fall-through. Windows and any unrecognised platform get the releases
// page. (This component has regressed four times by defaulting to brew.)
function BdReleasesLink({ label }: { label: string }) {
  return (
    <div className="flex justify-center mb-2">
      <a
        href="https://github.com/steveyegge/beads/releases/latest"
        target="_blank"
        rel="noopener noreferrer"
        className={cn(
          "inline-flex items-center gap-1.5 px-4 py-2.5 rounded-md text-sm font-medium",
          "bg-muted/50 border border-border text-foreground hover:bg-accent",
          "transition-colors",
        )}
      >
        {label}
        <ExternalLink className="h-3.5 w-3.5" />
      </a>
    </div>
  )
}

export function BdInstallInstructions({ isMac, isWindows, isLinux }: PlatformFlags) {
  if (isMac) return <CopyableCommand command="brew install beads" className="mb-3" />
  if (isLinux) return <CopyableCommand command={BD_GO_INSTALL} className="mb-3" />
  return <BdReleasesLink label={isWindows ? "Download bd for Windows" : "Download bd"} />
}

export function BdUpgradeInstructions({ isMac, isWindows, isLinux }: PlatformFlags) {
  if (isMac) return <CopyableCommand command="brew upgrade beads" className="mb-3" />
  if (isLinux) return <CopyableCommand command={BD_GO_INSTALL} className="mb-3" />
  return (
    <BdReleasesLink label={isWindows ? "Download latest bd for Windows" : "Download latest bd"} />
  )
}
