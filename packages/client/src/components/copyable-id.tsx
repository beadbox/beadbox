import { Check } from "lucide-react"
import type React from "react"
import { useState } from "react"
import { useViewport } from "../hooks/use-viewport"
import { shortenId } from "../lib/shorten-id"
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip"

interface CopyableIdProps {
  id: string
  className?: string
  onCopy?: () => void
  /**
   * Most characters the id may show (beadbox-d0d). Longer ids are shortened
   * to fit; the tooltip and the copy action always use the full id.
   */
  maxChars?: number
}

export function CopyableId({ id, className = "", onCopy, maxChars = 14 }: CopyableIdProps) {
  const displayId = shortenId(id, maxChars)
  const isTruncated = displayId !== id
  const { isMobile } = useViewport()
  const [copied, setCopied] = useState(false)

  const handleCopy = async (e: React.MouseEvent) => {
    e.stopPropagation()

    try {
      if (navigator.clipboard) {
        await navigator.clipboard.writeText(id)
      } else {
        const textarea = document.createElement("textarea")
        textarea.value = id
        textarea.style.position = "fixed"
        textarea.style.opacity = "0"
        document.body.appendChild(textarea)
        textarea.select()
        document.execCommand("copy")
        document.body.removeChild(textarea)
      }
      setCopied(true)
      onCopy?.()
      setTimeout(() => {
        setCopied(false)
      }, 1000)
    } catch (err) {
      console.error("Failed to copy:", err)
    }
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          role="button"
          tabIndex={0}
          onClick={handleCopy}
          onKeyDown={(e) => e.key === "Enter" && handleCopy(e as unknown as React.MouseEvent)}
          className={`inline-flex items-center gap-1.5 font-mono text-sm text-muted-foreground hover:text-primary hover:underline underline-offset-2 transition-all cursor-pointer min-w-[5rem] ${isMobile ? "min-h-[44px]" : ""} ${className}`}
        >
          {copied ? (
            <span className="inline-flex items-center gap-1 text-primary animate-in fade-in duration-150">
              <Check className="h-3.5 w-3.5" />
              <span className="text-xs">Copied</span>
            </span>
          ) : (
            // Clipped inside the id box, so a wider font can never paint
            // under the next item in the row (beadbox-d0d).
            <span className="min-w-0 overflow-hidden text-ellipsis transition-opacity whitespace-nowrap">
              {displayId}
            </span>
          )}
        </span>
      </TooltipTrigger>
      <TooltipContent>{isTruncated ? `${id} · Click to copy` : "Click to copy"}</TooltipContent>
    </Tooltip>
  )
}
