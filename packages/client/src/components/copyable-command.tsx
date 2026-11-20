import { Check, Copy } from "lucide-react"
import { useState } from "react"
import { cn } from "../lib/utils"

interface CopyableCommandProps {
  command: string
  label?: string
  className?: string
}

export function CopyableCommand({ command, label, className }: CopyableCommandProps) {
  const [copied, setCopied] = useState(false)

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(command)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // Fallback for environments without clipboard API
      const textarea = document.createElement("textarea")
      textarea.value = command
      textarea.style.position = "fixed"
      textarea.style.opacity = "0"
      document.body.appendChild(textarea)
      textarea.select()
      document.execCommand("copy")
      document.body.removeChild(textarea)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    }
  }

  return (
    <div className={cn("text-left", className)}>
      {label && <p className="text-sm text-muted-foreground mb-1.5">{label}</p>}
      <div className="flex items-center gap-2 bg-muted/50 border border-border rounded-md px-3 py-2">
        <code className="flex-1 text-sm font-mono text-foreground whitespace-nowrap overflow-x-auto">
          $ {command}
        </code>
        <button
          onClick={handleCopy}
          className="shrink-0 p-1 rounded hover:bg-muted-foreground/10 transition-colors text-muted-foreground hover:text-foreground"
          aria-label={copied ? "Copied" : "Copy command"}
        >
          {copied ? <Check className="h-4 w-4 text-success-text" /> : <Copy className="h-4 w-4" />}
        </button>
      </div>
    </div>
  )
}
