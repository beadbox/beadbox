// Sonner Toaster wrapper for the SPA. Ported from components/ui/sonner.tsx
// (P2.3 / bb-cqpc.3).
//
// Differences from the Next.js version:
// - Removed the next-themes useTheme() call. `theme="dark"` is set here and
//   only here (the root route renders <Toaster /> without the prop, so this
//   is the single place that decides it).
// - Stripped the "use client" directive. Vite SPA, no RSC boundary.
//
// On theming: the toast BODY is theme-aware — the three --normal-* overrides
// below resolve through --bb-popover/--bb-popover-foreground/--bb-border, so
// a runtime theme swap repaints it. Sonner's own `theme` prop is a separate
// axis: it drives the library's internal greys (close button, description
// text), which stay dark-tuned even on a light theme. Making those follow
// the active theme's appearance means mapping appearance -> "light"/"dark"
// here; it is a visible change to the toast's own chrome and was left out of
// the runtime-themes branch deliberately rather than by oversight.
//
// The --bb-* variables come from the theme tokens in
// packages/client/src/index.css, where :root carries defaults and
// applyTheme() writes per-theme values onto <html>. (The bare --popover and
// friends this comment used to mention were dead by then and have since been
// deleted — do not reach for them.)

import { Toaster as Sonner, type ToasterProps } from "sonner"

const Toaster = ({ ...props }: ToasterProps) => {
  return (
    <Sonner
      theme="dark"
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
