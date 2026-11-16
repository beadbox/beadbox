// Appearance-only: the .dark class drives Tailwind's dark: variants and the
// status-colour MutationObserver. Colour tokens are applied separately by
// theme-engine.applyTheme.
import type { Appearance } from "./theme-tokens"

export function applyThemeClass(el: HTMLElement, appearance: Appearance): void {
  el.classList.toggle("dark", appearance === "dark")
}
