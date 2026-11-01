// beadbox-knr: put the theme's classes on <html>. One copy, used by every
// page that applies the theme (it was the same block three times). The class
// is that of the theme that renders (effectiveTheme), so a stored Blue or
// Green gets theme-gray, matching what is on screen.
import { effectiveTheme, type ThemeVariant } from "./local-storage"

export function applyThemeClass(el: HTMLElement, theme: ThemeVariant): void {
  const t = effectiveTheme(theme)
  el.classList.add("dark")
  el.classList.remove("theme-gray", "theme-green")
  if (t === "gray") el.classList.add("theme-gray")
  if (t === "green") el.classList.add("theme-green")
}
