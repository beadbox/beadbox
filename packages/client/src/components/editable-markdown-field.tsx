import { Pencil } from "lucide-react"
import { useState } from "react"
import { SimpleMarkdown } from "@/components/simple-markdown"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { Textarea } from "@/components/ui/textarea"

interface EditableMarkdownFieldProps {
  label: string
  value: string
  isSaving: boolean
  onSave: (value: string) => Promise<boolean>
  emptyMessage?: string
}

export function EditableMarkdownField({
  label,
  value,
  isSaving,
  onSave,
  emptyMessage,
}: EditableMarkdownFieldProps) {
  const [isEditing, setIsEditing] = useState(false)
  const [draft, setDraft] = useState("")

  const save = async () => {
    if (await onSave(draft)) setIsEditing(false)
  }

  return (
    <section className="pt-4 border-t border-border/30">
      <div className="flex items-center gap-2 mb-2">
        <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
          {label}
        </h3>
        {!isEditing && (
          <button
            type="button"
            aria-label={`Edit ${label}`}
            onClick={() => {
              setDraft(value)
              setIsEditing(true)
            }}
            className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            <Pencil className="h-3 w-3" />
            <span>Edit</span>
          </button>
        )}
        {isSaving && <Spinner className="h-3 w-3" />}
      </div>
      {isEditing ? (
        <div>
          <Textarea
            aria-label={label}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                event.preventDefault()
                if (!isSaving) void save()
              }
              if (event.key === "Escape") setIsEditing(false)
            }}
            rows={8}
            autoFocus
            className="w-full bg-transparent border-border/40 text-foreground text-sm resize-y"
          />
          <div className="flex items-center gap-2 mt-1.5">
            <Button
              size="sm"
              className="h-6 text-xs"
              disabled={isSaving}
              onClick={() => void save()}
            >
              Save
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="h-6 text-xs"
              disabled={isSaving}
              onClick={() => setIsEditing(false)}
            >
              Cancel
            </Button>
            <span className="text-xs text-muted-foreground/40">Cmd+Enter to save</span>
          </div>
        </div>
      ) : value ? (
        <div className="prose prose-sm prose-invert max-w-none text-foreground/90">
          <SimpleMarkdown content={value} />
        </div>
      ) : (
        <p className="text-muted-foreground/50 italic text-sm">
          {emptyMessage ?? `No ${label.toLowerCase()}`}
        </p>
      )}
    </section>
  )
}
