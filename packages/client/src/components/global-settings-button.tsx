import { Settings } from "lucide-react"
import { useEffect, useState } from "react"
import { usePreferences } from "../hooks/use-preferences"
import { useUpdateChecker } from "../hooks/use-update-checker"
import { SettingsDialog } from "./settings-dialog"
import { UpdateDialog } from "./update-dialog"
import { Button } from "./ui/button"

/** App preferences in views without a single source database. */
export function GlobalSettingsButton() {
  const [open, setOpen] = useState(false)
  const [updateOpen, setUpdateOpen] = useState(false)
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
      <Button variant="ghost" className="shrink-0" onClick={() => setOpen(true)}>
        <Settings className="h-4 w-4" />
        Settings
      </Button>
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
