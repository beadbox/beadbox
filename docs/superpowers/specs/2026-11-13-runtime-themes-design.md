# Runtime themes: light mode and user-supplied theme files

- **Date:** 2026-11-13
- **Status:** Approved design, not yet implemented
- **Scope:** Restore runtime theme switching; ship a light theme; let users load their own themes from disk.

## Problem

Beadbox renders dark-gray only. A light theme cannot be added as "just another CSS
class", because the mechanism that would switch it was deliberately removed.

Users want a light theme, and want to supply their own themes.

## Background: what exists today

A theme system is already present but disabled:

| Piece | File | State |
|---|---|---|
| `ThemeVariant = "blue" \| "gray" \| "green"` | `client/src/lib/local-storage.ts` | three themes modelled |
| `AVAILABLE_THEMES` | same | `["gray"]` — only gray renders |
| `effectiveTheme()` | same | downgrades blue/green to gray, **preserves** the stored preference |
| `applyThemeClass()` | `client/src/lib/theme.ts` | writes `dark` + `theme-*` onto `<html>` |
| hardcoded class | `client/index.html` | `class="dark theme-gray"` |
| `theme.test.ts` | `client/src/__tests__/` | asserts gray-only as expected behaviour |

### Why it is disabled

`index.css` declares an `@theme inline` block. Tailwind substitutes each token's
declared value directly into every utility class it generates:

```css
/* BEFORE — broke in Tauri's WKWebView */
@theme inline { --color-background: var(--background); }
  → .bg-background { background-color: var(--background) }   /* resolved at use site */

/* NOW — works, but unthemeable */
@theme inline { --color-background: #18181b; }
  → .bg-background { background-color: #18181b }             /* literal, frozen */
```

The `var()` form made WKWebView render text the same colour as its background.
The in-code comment (P3.7 / B3 / qa1) offers two candidate causes: a failed
`oklch()` fallback at `:root`, or `var()` lookup scoped to the `@theme`
definition site rather than the consuming element. It was fixed by baking
literals, which froze the theme.

Every utility class in the app now carries a baked literal. There is no variable
left to override, which is why no theme can switch.

The same comment anticipates this work:

> a future bead would need to either re-introduce the var() chain inside a
> different scope structure or rebuild the @theme block dynamically

## Spike findings (2026-11-13)

A throwaway probe rendered six token-resolution strategies in a real WKWebView
and sampled **painted pixels** from a webview snapshot.

Pixel sampling was necessary, not incidental: this engine returns `oklch(1 0 0)`
verbatim from both `getComputedStyle` and canvas `fillStyle`, so JS-level
inspection cannot distinguish "rendered correctly" from "failed to resolve".
Two earlier oracles produced a false "oklch is broken" verdict before this was
caught.

| Test | Shape | Result |
|---|---|---|
| T1 | literal hex (current) | PASS |
| T2 | `var()`, single level at `:root`, hex | PASS |
| T3 | `var()`, three nested scopes, hex | PASS |
| T4 | `oklch()` at `:root` + hex overrides — the original broken shape | PASS |
| T5 | pure `oklch()`, no override | PASS |
| T6 | runtime `setProperty` on `documentElement` | PASS |

**The original bug does not reproduce.** Neither candidate cause holds on current
WebKit. T6 confirms the runtime switching mechanism works.

### Residual risk — the important caveat

`tauri.conf.json` sets `minimumSystemVersion: "13.0"`. The workaround landed
2026-08-21 (`598b76c`). The spike ran on **macOS 27.0.1 only**.

The bug is cleared on current WebKit. It is **not** cleared on macOS 13–15,
which remain supported targets. This is a non-reproduction on the newest engine,
not a proof of correctness on the oldest. §4 failure mode 2 exists specifically
to bound this risk.

Escalating the spike to `tauri dev` was considered and rejected: it exercises
Tauri's actual WKWebView but still only on macOS 27, so it would not reduce the
remaining uncertainty.

## Decisions

1. **Light ships as a bundled theme file**, loaded through the identical path a
   user's custom theme uses. One mechanism, dogfooded — if light works, custom
   themes provably work.
2. **A theme controls colours, radius, and fonts** — exactly the tokens already
   in the `@theme` block. No new token vocabulary is invented.
3. **The sidecar reads a themes folder.** No new Tauri `fs:` capability.
4. **A malformed theme is rejected atomically**, falling back to the last good
   theme, with the offending key named.
5. **Themes hot-reload** when their file changes on disk.

## §1 Rendering mechanism

**Hybrid: the class carries appearance, inline style carries tokens.**

`index.css` gains one level of indirection, with today's literals as the baked
default:

```css
@theme inline {
  --color-background: var(--bb-background);   /* 19 colour tokens */
  --color-foreground: var(--bb-foreground);
  --radius-md:        var(--bb-radius-md);    /* 4 radius tokens  */
  --font-sans:        var(--bb-font-sans);    /* 2 font stacks    */
}
:root {
  /* Defaults are today's gray literals verbatim. With JS disabled, or the
     engine bailed (§4.2), the app renders exactly as it does now. */
  --bb-background: #18181b;
  --bb-foreground: #f4f4f5;
}
```

- The nested `.dark.theme-gray` and `.dark.theme-green` blocks are deleted.
- `client/index.html` keeps `class="dark"` as the pre-hydration default and drops
  `theme-gray`. The class must be present before the engine runs or every cold
  start flashes a light frame; the engine owns the class thereafter.
- A new `client/src/lib/theme-engine.ts` writes `--bb-*` onto
  `documentElement.style` and adds/removes the `.dark` class.

This is the shape the spike validated: T2 for the token chain, T6 for runtime
application.

### This is the same `@theme inline` + `var()` form that broke — deliberately

Comparing the code block above with the "BEFORE — broke" block earlier, the
mechanism is identical: `inline` substitutes a `var()` reference into every
generated utility. **What changed is what sits behind the variable.** The broken
form resolved `--background` through three nested scopes (`:root` → `.dark` →
`.dark.theme-gray`) with `oklch()` at the root — the T4 shape. This form
resolves `--bb-*` through a single `:root` definition in hex — the T2 shape.
Both passed the spike, but T2 is the conservative one, and it is the only
`var()` form the design relies on.

`inline` is kept rather than dropped because it produces the **shorter** chain.
Plain `@theme` would emit `.bg-background { background-color: var(--color-background) }`
with `--color-background: var(--bb-background)` at `:root` — two levels of
indirection. `@theme inline` collapses that to one. Since the original failure
was a cascade-walking problem, fewer levels is strictly safer. The implementation
should confirm the emitted CSS matches this expectation before building on it.

### Why both mechanisms are required

Three things key off the `.dark` class and would break silently if tokens were
applied by inline style alone:

1. **29 `dark:` utilities**, via `@custom-variant dark (&:is(.dark *))`.
2. **`currentThemeSurface()`** (`lib/status-colors-store.ts`) — how status
   colours choose contrast.
3. **The `MutationObserver`** in `status-colors-mount.tsx`, which is filtered to
   `attributeFilter: ["class"]` and therefore never fires on a `style` change.

Without the class toggle, switching to light would leave status colours tuned for
a dark background.

## §2 Theme file format

This is a public interface. Once users have theme files, it cannot be changed
incompatibly.

```jsonc
{
  "id": "nord",             // stable key; MUST equal the filename stem
  "name": "Nord",           // label shown in the picker
  "appearance": "dark",     // "dark" | "light" — REQUIRED
  "colors": {               // all 19 keys required, no more and no fewer
    "background": "#2e3440",          "foreground": "#eceff4",
    "card": "#3b4252",                "cardForeground": "#eceff4",
    "popover": "#3b4252",             "popoverForeground": "#eceff4",
    "primary": "#88c0d0",             "primaryForeground": "#2e3440",
    "secondary": "#434c5e",           "secondaryForeground": "#eceff4",
    "muted": "#434c5e",               "mutedForeground": "#d8dee9",
    "accent": "#434c5e",              "accentForeground": "#eceff4",
    "destructive": "#bf616a",         "destructiveForeground": "#fef2f2",
    "border": "#434c5e",              "input": "#434c5e",
    "ring": "#88c0d0"
  },
  "radius": { "sm": "0.25rem", "md": "0.5rem",     // optional; any subset,
              "lg": "0.75rem", "xl": "1rem" },     //   unset keys use defaults
  "fonts":  { "sans": "'Inter', system-ui, sans-serif",   // optional
              "mono": "'JetBrains Mono', ui-monospace, monospace" }
}
```

The 19 colour keys map 1:1 onto the `--color-*` tokens in `index.css`'s `@theme`
block; the 4 radius keys onto `--radius-{sm,md,lg,xl}`; the 2 font keys onto
`--font-{sans,mono}`. No token vocabulary is invented, and the set is closed:
validation rejects unknown keys so a typo is reported rather than ignored.

**Why colours are required but radius and fonts are optional.** A partial colour
set is the failure that produces an unreadable UI — a theme defining
`background` but not `foreground` inherits the previous theme's text colour and
can land on black-on-black. Radius and fonts cannot make the app unreadable, so
an unset key falls back to the built-in default and a theme author can ship a
pure recolour without restating geometry they do not care about.

### `appearance` is required and load-bearing

It is not cosmetic metadata. It decides whether `.dark` is applied, which drives
the `dark:` variants *and* tells the status-colour system which surface to
contrast against. A theme without it would ship dark-tuned status colours on a
light background.

### Colour values: hex and `rgb()` only

`oklch()` and `color-mix()` are **rejected by validation**.

Not because they fail — the spike showed `oklch()` renders correctly on current
WebKit. Because the spike could not clear macOS 13–15, and hex is the one form
proven safe on every engine Beadbox ships to. A format restriction is cheap to
relax later and impossible to tighten: once a user's theme file contains
`oklch()`, that support is owed permanently. The restriction may be lifted once
there is evidence from the macOS versions actually supported.

### Built-in themes

Two files, bundled with the client, loaded through the same path as user themes:

- `beadbox-dark.json` — today's gray palette, verbatim.
- `beadbox-light.json` — derived from the light palette already sitting unused in
  `index.css`'s `:root` block, converted from `oklch()` to hex.

## §3 Loading pipeline

### Sidecar namespace

New `packages/server/src/handlers/themes.ts`, registered in `handlers/index.ts`
via `wrapNamespace` like every other namespace:

| Method | Returns |
|---|---|
| `themes.list()` | metadata only — `{ id, name, appearance, source, error? }[]` |
| `themes.get(id)` | the full validated token set |

`list()` returns metadata without tokens so the picker can render without loading
every theme.

### Location

`~/.beadbox/themes/*.json`, with a `BEADBOX_THEMES_PATH` environment override.

This mirrors `getBeadboxRegistryPath()` exactly — `~/.beadbox/registry.json`,
overridable via `BEADBOX_REGISTRY_PATH` for test isolation. Same directory, same
convention, same test seam.

### Hot reload

Reuses the existing dual-channel subscription pattern rather than adding a
transport. `subscribe.ts` pairs imperative kkrpc `start`/`stop` with structured
stderr events (`[SUBSCRIPTION:<id>] <json>`), chosen specifically to avoid
HTTP/WS. A themes-folder watcher emits on that same channel; the client
invalidates its themes query and re-applies the active theme if it changed.

### Client modules

- `client/src/lib/theme-engine.ts` — applies tokens, toggles `.dark`, runs the
  §4.2 probe.
- `client/src/lib/theme-source.ts` — merges bundled built-ins with
  `rpc.themes.*`.

In browser/stub mode `buildStubRpc` throws `RpcUnavailableError`; the source
layer catches it and degrades to built-ins only.

### Breaking change

`ThemeVariant` changes from `"blue" | "gray" | "green"` to an opaque `string`
id. `getThemePreference()` currently validates against `VALID_THEMES`; that check
becomes "does a theme with this id exist, else fall back to the default".

`effectiveTheme()`'s existing behaviour of **preserving an unrenderable stored
preference** is kept deliberately — it is exactly right for custom themes.
Uninstalling a theme and reinstalling it restores the user's choice.

## §4 Failure handling

### 4.1 Malformed theme file

Validate the entire file before applying any of it. Reject atomically — never
half-apply — keep the last good theme, and name the offending key.

The invalid file is **reported in place, never moved**. `themes.list()` returns
the entry with its `error` field populated, so the picker shows
`Nord — invalid: colors.background is not hex` rather than the theme silently
disappearing. The entry is non-selectable until the file validates.

**Corrected 2026-11-13 during planning.** This section previously said to reuse
`quarantineUnreadableRegistry()`, which moves a corrupt file aside. That is
correct for the registry and wrong for themes, because §3 hot-reloads on file
change: editors save in several steps, so a watcher routinely observes a
theme file in a transiently invalid state. Quarantining on parse failure would
move a user's theme file out from under them *while they were editing it* —
data loss caused by the feature that exists to make editing pleasant. The
registry is written by the app and never hand-edited, so the same policy is
safe there and unsafe here.

### 4.2 Engine cannot resolve tokens

This bounds the macOS 13–15 risk from the spike.

On startup, before applying any theme: set a probe token on an offscreen element,
read back its computed value, and confirm the indirection resolved. If it did
not, the engine bails permanently and the app renders from the baked `:root`
literals — today's exact appearance. Theme switching is disabled with an
explanation.

**What the probe does and does not detect.** An unresolvable `var()` falls back
to the property's initial value — for `background-color`, `transparent`, which
`getComputedStyle` reports literally as `rgba(0, 0, 0, 0)`. That is detectable.
So the probe catches **non-resolution**: the engine cannot walk the indirection
at all.

It does **not** catch *mis*-resolution — a `var()` that resolves to a real but
wrong colour. The spike established that this engine returns `oklch(1 0 0)`
verbatim from `getComputedStyle`, so computed-style inspection cannot verify that
a resolved value is the *correct* one. The original 0.25.2 symptom ("text the
same colour as its background") could have been either failure; a probe cannot
distinguish them.

Mis-resolution is guarded differently: by the hex-only restriction in §2, which
removes the colour-syntax class of failure entirely, and by the single-level
`:root` chain in §1, which removes the cascade-walking class. The probe is the
backstop for the remaining case, not a complete proof.

The worst case on an untested engine is therefore "themes unavailable", not "an
app you cannot read". This check should be built regardless of spike results, as
it is the only thing that makes custom themes safe on platforms that cannot be
tested.

### 4.3 Valid but unreadable theme

A syntactically valid theme may still be black-on-black. **Out of scope.** We
validate syntax, not taste. Stated explicitly so it is not mistaken for an
oversight.

## §5 Testing

| Layer | Tests |
|---|---|
| Validation (pure) | hex and `rgb()` accepted; `oklch()`, `color-mix()`, malformed rejected with the offending key named |
| `theme-engine` | tokens land on `documentElement`; `.dark` toggles with `appearance`; probe-failure path disables cleanly and leaves baked literals |
| Regression | `theme.test.ts` **rewritten** — see below |
| Status-colour integration | switching appearance fires the `class` MutationObserver and recomputes `surface` |
| Sidecar | `themes.list/get` against a temp `BEADBOX_THEMES_PATH`; a corrupt file is reported in place, not fatal |
| E2E | sibling to `e2e/headless/status-colors.spec.ts`: switch to light, assert contrast |

### `theme.test.ts` must be rewritten

It currently asserts `AVAILABLE_THEMES` equals `["gray"]` and that a stored blue
or green renders as gray. Those assertions encode the limitation being removed.
Leaving them green would mean the fix had not actually landed.

The one assertion worth keeping: a stored preference is not rewritten when it
cannot be rendered.

### Explicitly not tested

Rendering on macOS 13–15. It cannot be tested here, which is precisely why §4.2
exists. Claiming coverage would be dishonest.

## Out of scope

- Per-workspace themes. Themes are application-level; status colours remain
  per-workspace and server-side.
- Theme marketplace, sharing, or download.
- Theming the Rust-side loading screen (`src-tauri/loading/index.html`).
- Judging whether a valid theme is legible (§4.3).
