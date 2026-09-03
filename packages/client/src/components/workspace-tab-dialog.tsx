// Edit a workspace tab: display name + icon.
//
// A modal Dialog, not a Popover: the icon picker was a Popover opened from
// the tab's dropdown menu, and Radix dismisses a layer that mounts while
// another layer is returning focus — the picker closed the instant it
// opened. A modal Dialog owns focus outright, so it survives being opened
// from a menu item, from the avatar, or from a keyboard shortcut.
//
// The emoji grid is deliberately small: it covers "pick something
// recognisable" in one click, and the free-text field accepts anything the
// OS emoji picker produces (⌃⌘Space on macOS, Win+. on Windows), so nothing
// is gated on the grid's contents.

import { useEffect, useState } from "react"
import type { WorkspaceCard } from "../lib/types"
import { cn } from "../lib/utils"
import { Button } from "./ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog"
import { Input } from "./ui/input"

const SUGGESTED_ICONS = [
  "🟣",
  "🔵",
  "🟢",
  "🟡",
  "🟠",
  "🔴",
  "⚪",
  "⚫",
  "🚀",
  "🧪",
  "🛠️",
  "📦",
  "🐛",
  "🔥",
  "⚡",
  "🧩",
  "📘",
  "📝",
  "🎯",
  "🏗️",
  "🧠",
  "🤖",
  "🌱",
  "🌊",
  "🐙",
  "🐦",
  "🦀",
  "🐍",
  "🍎",
  "☕",
  "🎨",
  "🔒",
]

interface WorkspaceTabDialogProps {
  workspace: WorkspaceCard | null
  open: boolean
  onOpenChange: (open: boolean) => void
  /**
   * Only the changed fields are passed; `icon: null` clears the icon.
   * Resolving false keeps the dialog open with the user's input, so a
   * rejected label (see the server-side validation in
   * handlers/workspaces.ts:setWorkspaceLabel) is not silently discarded.
   */
  onSubmit: (label: { name?: string; icon?: string | null }) => Promise<boolean>
}

export function WorkspaceTabDialog({
  workspace,
  open,
  onOpenChange,
  onSubmit,
}: WorkspaceTabDialogProps) {
  const [name, setName] = useState("")
  const [icon, setIcon] = useState<string | null>(null)

  // Re-seed each time the dialog opens for a workspace: the same dialog
  // instance is reused across tabs.
  useEffect(() => {
    if (!open || !workspace) return
    setName(workspace.name)
    setIcon(workspace.icon ?? null)
  }, [open, workspace])

  if (!workspace) return null

  const trimmed = name.trim()
  const nameChanged = trimmed.length > 0 && trimmed !== workspace.name
  const iconChanged = (icon ?? null) !== (workspace.icon ?? null)

  const submit = async () => {
    const label: { name?: string; icon?: string | null } = {}
    if (nameChanged) label.name = trimmed
    if (iconChanged) label.icon = icon
    if (label.name === undefined && label.icon === undefined) {
      onOpenChange(false)
      return
    }
    if (await onSubmit(label)) onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Edit tab</DialogTitle>
          <DialogDescription>
            Rename this workspace and pick the icon shown on its tab.
          </DialogDescription>
        </DialogHeader>

        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault()
            void submit()
          }}
        >
          <div className="flex items-center gap-2">
            <span
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-muted/60 text-lg"
              aria-hidden="true"
            >
              {icon ?? "○"}
            </span>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              aria-label="Workspace name"
              placeholder={workspace.name}
              maxLength={64}
            />
          </div>

          <div className="grid grid-cols-8 gap-0.5" role="group" aria-label="Tab icon">
            {SUGGESTED_ICONS.map((option) => (
              <button
                key={option}
                type="button"
                onClick={() => setIcon(option)}
                aria-label={`Use ${option}`}
                aria-pressed={option === icon}
                className={cn(
                  "flex h-7 w-7 items-center justify-center rounded-md text-base",
                  option === icon ? "bg-accent" : "hover:bg-accent/60",
                )}
              >
                {option}
              </button>
            ))}
          </div>

          <div className="flex items-center gap-1.5">
            <Input
              value={icon ?? ""}
              onChange={(e) => setIcon(e.target.value === "" ? null : e.target.value)}
              aria-label="Custom icon"
              placeholder="Paste any emoji"
              className="h-8"
              maxLength={16}
            />
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-8 shrink-0 text-muted-foreground"
              onClick={() => setIcon(null)}
              disabled={icon === null}
            >
              Clear
            </Button>
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!nameChanged && !iconChanged}>
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
