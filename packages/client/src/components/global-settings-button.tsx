import { Settings } from "lucide-react"
import { useEffect, useState } from "react"
import { usePreferences } from "../hooks/use-preferences"
import { useUpdateChecker } from "../hooks/use-update-checker"
import { useViewport } from "../hooks/use-viewport"
import { cn } from "../lib/utils"
import { SettingsDialog } from "./settings-dialog"
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip"
import { UpdateDialog } from "./update-dialog"

/** App preferences in views without a single source database. */
export function GlobalSettingsButton() {
  const [open, setOpen] = useState(false)
  const [updateOpen, setUpdateOpen] = useState(false)
  const { isMobile } = useViewport()
  const prefs = usePreferences()
  const update = useUpdateChecker({
    enabled: prefs.updateCheckEnabled,
    frequency: prefs.updateCheckFrequency,
  })
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === ",") {
        event.preventDefault()
        setOpen(true)
      }
    }
    window.addEventListener("keydown", keydown)
    return () => window.removeEventListener("keydown", keydown)
  }, [])
  return (
    <>
      {/* The same gear-only button as the workspace header. */}
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={() => setOpen(true)}
            className={cn(
              "inline-flex shrink-0 items-center justify-center rounded-md",
              "text-muted-foreground hover:text-foreground hover:bg-accent",
              "transition-colors",
              isMobile ? "min-h-[44px] min-w-[44px]" : "h-9 w-9",
            )}
          >
            <Settings className="h-4 w-4" />
            <span className="sr-only">Settings</span>
          </button>
        </TooltipTrigger>
        <TooltipContent>Settings (Cmd+,)</TooltipContent>
      </Tooltip>
      <SettingsDialog
        open={open}
        onOpenChange={setOpen}
        theme={prefs.theme}
        onThemeChange={prefs.handleThemeChange}
        zoomLevel={prefs.zoomLevel}
        onZoomChange={prefs.handleZoomChange}
        vimNavigationEnabled={prefs.vimEnabled}
        onVimNavigationChange={prefs.handleVimNavigationChange}
        updateCheckEnabled={prefs.updateCheckEnabled}
        onUpdateCheckEnabledChange={prefs.handleUpdateCheckEnabledChange}
        updateCheckFrequency={prefs.updateCheckFrequency}
        onUpdateCheckFrequencyChange={prefs.handleUpdateCheckFrequencyChange}
        updateAvailable={update.updateAvailable}
        updateChecking={update.checking}
        updateCheckError={update.checkError}
        onCheckForUpdates={update.checkNow}
        onOpenUpdateDialog={() => setUpdateOpen(true)}
      />
      {update.updateAvailable && (
        <UpdateDialog
          open={updateOpen}
          onOpenChange={setUpdateOpen}
          updateInfo={update.updateAvailable}
          onDismiss={update.dismissUpdate}
          currentVersion={import.meta.env.VITE_APP_VERSION ?? "0.0.0"}
        />
      )}
    </>
  )
}
