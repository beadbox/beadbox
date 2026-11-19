// Sonner Toaster wrapper for the SPA. Ported from components/ui/sonner.tsx
// (P2.3 / bb-cqpc.3).
//
// Differences from the Next.js version:
// - Replaced the next-themes useTheme() call with Beadbox's own
//   useThemePreference(), the single source for the resolved appearance.
// - Stripped the "use client" directive. Vite SPA, no RSC boundary.
//
// On theming, there are two axes and both are now handled. The toast BODY is
// theme-aware through the three --normal-* overrides below, which resolve
// through --bb-popover/--bb-popover-foreground/--bb-border, so a runtime
// theme swap repaints it. Sonner's own `theme` prop is separate: it drives
// the library's INTERNAL greys (close button, description text), which it
// does not expose as variables.
//
// That prop was hardcoded "dark" while light mode was being built, which left
// toast chrome dark-tuned on a light theme — the one surface the palette
// sweep could not reach, because the colours live inside the library. It now
// takes the resolved appearance, so it follows a mode switch and the system
// preference like everything else. `appearance` is exactly "dark" | "light",
// which is a subset of Sonner's own "light" | "dark" | "system", so it maps
// across with no translation.
//
// The --bb-* variables come from the theme tokens in
// packages/client/src/index.css, where :root carries defaults and
// applyTheme() writes per-theme values onto <html>. (The bare --popover and
// friends this comment used to mention were dead by then and have since been
// deleted — do not reach for them.)

import { Toaster as Sonner, type ToasterProps } from "sonner"

import { useThemePreference } from "@/hooks/use-theme-preference"

const Toaster = ({ ...props }: ToasterProps) => {
  const { appearance } = useThemePreference()
  return (
    <Sonner
      theme={appearance}
      className="toaster group"
      style={
        {
          "--normal-bg": "var(--bb-popover)",
          "--normal-text": "var(--bb-popover-foreground)",
          "--normal-border": "var(--bb-border)",
        } as React.CSSProperties
      }
      {...props}
    />
  )
}

export { Toaster }
