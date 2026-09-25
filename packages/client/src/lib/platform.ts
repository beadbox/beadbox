// The host OS as Node names it ("darwin" | "win32" | "linux"), read from the
// WebView. null when unknown. Shared by the update downloader and the bd
// install/upgrade hints (beadbox-ag1), which gate brew on "darwin" only.
export function detectClientPlatform(): string | null {
  if (typeof navigator === "undefined") return null
  const p = navigator.platform.toLowerCase()
  if (p.includes("mac")) return "darwin"
  if (p.includes("win")) return "win32"
  if (p.includes("linux")) return "linux"
  return null
}
