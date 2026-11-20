// Sonner Toaster wrapper for the SPA. Ported from components/ui/sonner.tsx
// (P2.3 / bb-cqpc.3).
//
// Differences from the Next.js version: useThemePreference() replaces
// next-themes' useTheme(), and the "use client" directive is gone (Vite SPA,
// no RSC boundary).
//
// Two axes: the toast BODY follows the --normal-* overrides below, so tokens
// repaint it; Sonner's `theme` prop separately drives the library's internal
// greys (close button, description text), which it does not expose as
// variables — so only the prop can reach them.
//
// The --bb-* variables come from the theme tokens in
// packages/client/src/index.css, where :root carries defaults and
// applyTheme() writes per-theme values onto <html>. (The bare --popover and
// friends this comment used to mention were dead by then and have since been
// deleted — do not reach for them.)

import { Toaster as Sonner, type ToasterProps } from "sonner"

import { isThemingAvailable } from "@/lib/theme-engine"

import { useThemePreference } from "@/hooks/use-theme-preference"

const Toaster = ({ ...props }: ToasterProps) => {
  const { appearance } = useThemePreference()
  // When the startup probe disables theming, applyTheme never runs and <html>
  // keeps the baked dark palette — so following the stored appearance here
  // would paint light toast chrome over a dark app. settings-dialog.tsx gates
  // on the same probe.
  return (
    <Sonner
      theme={isThemingAvailable() ? appearance : "dark"}
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
