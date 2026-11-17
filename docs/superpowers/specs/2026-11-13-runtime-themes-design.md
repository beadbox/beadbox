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
2. **A theme controls colours, radius, and fonts** — the tokens already in the
   `@theme` block, plus exactly three semantic tone tokens (amended
   2026-11-17, see Decision 7 and §7).
3. **The sidecar reads a themes folder.** No new Tauri `fs:` capability.
4. **A malformed theme is rejected atomically**, falling back to the last good
   theme, with the offending key named.
5. **Themes hot-reload** when their file changes on disk.
6. **Appearance is a separate axis from theme choice** (added 2026-11-17, see §6).
   The user picks a mode — permanently dark, permanently light, or follow the
   system — and assigns a theme to each of the dark and light slots.
7. **Three semantic tone tokens are added** — `warning`, `info`, `success`
   (amended 2026-11-17, see §7). This narrows Decision 2's original "no new
   token vocabulary is invented", which could not survive the palette sweep:
   none of the 19 existing tokens expresses these roles, and they account for
   ~424 of the 721 hardcoded palette sites. They are OPTIONAL in a theme file,
   and their readable text value is DERIVED per surface, never authored.

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

The 19 required colour keys map 1:1 onto the `--color-*` tokens in
`index.css`'s `@theme` block; the 3 optional tone keys (§7) onto
`--color-{warning,info,success}`; the 4 radius keys onto
`--radius-{sm,md,lg,xl}`; the 2 font keys onto `--font-{sans,mono}`. The set is
closed: validation rejects unknown keys so a typo is reported rather than
ignored.

**Why colours are required but radius and fonts are optional.** A partial colour
set is the failure that produces an unreadable UI — a theme defining
`background` but not `foreground` inherits the previous theme's text colour and
can land on black-on-black. Radius and fonts cannot make the app unreadable, so
an unset key falls back to the built-in default and a theme author can ship a
pure recolour without restating geometry they do not care about.

### `appearance` is required and load-bearing

It is not cosmetic metadata: it declares which of the two appearance slots a
theme is eligible for (§6), so the picker can offer only coherent choices.

**Superseded detail (2026-11-17):** this section originally said `appearance`
"decides whether `.dark` is applied". That is no longer true, and the change is
deliberate — see §6. The resolved *mode* now drives the class, and a theme's
`appearance` governs only slot eligibility. Those two cannot disagree, because
a theme is only offered for the slot matching its own `appearance`; driving the
class from the slot rather than from the theme removes the state where they
could.

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

## §6 Appearance mode (added 2026-11-17)

### Why this section exists

The original design treated appearance as a property *of a theme*: the user
picked one theme from a flat list, and that theme's `appearance` decided whether
the app rendered dark or light. Implementation completed on that model before the
gap surfaced: it gives the user no way to say "use this theme when I'm in dark
and that one when I'm in light", and no way to follow the OS at all. There was no
`prefers-color-scheme` handling anywhere in the client.

The brainstorming that produced this spec asked what a theme controls and how
custom themes load, but never asked how the user chooses between light and dark —
the assumption that appearance rides along with the theme was never examined, so
the approval it received was not an informed one.

### The model

Three persisted values replace the single stored theme id:

| value | meaning |
|---|---|
| `mode` | `"dark"` \| `"light"` \| `"system"` |
| `darkThemeId` | the theme to apply whenever effective appearance is dark |
| `lightThemeId` | the theme to apply whenever effective appearance is light |

```
effective appearance = mode === "system"
  ? (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light")
  : mode

active theme id = effective appearance === "dark" ? darkThemeId : lightThemeId
```

The effective appearance — not the theme — drives the `.dark` class. §1's hybrid
mechanism is otherwise unchanged: the class still carries appearance and inline
style still carries tokens.

### Slot eligibility

The dark slot offers only themes whose `appearance` is `"dark"`; the light slot
only `"light"`. A dark-appearance theme in the light slot would paint dark tokens
while the class says light, so `dark:` utilities and the status-colour surface
would both be wrong. Filtering makes the incoherent state unreachable rather than
merely discouraged.

### Storage and migration

One key holds all three values, so a change produces one store notification
rather than three keys that can drift. The legacy `beads-theme` key (a bare id)
is migrated once: read it, look up that theme's `appearance`, assign it to the
matching slot, and set `mode` to that appearance — so an existing user's current
appearance is preserved exactly across the upgrade. The legacy key is then
removed, since leaving it would be a second source of truth.

A migration that cannot resolve the stored id's appearance (the theme was
uninstalled) falls back to the built-in defaults rather than guessing.

### System mode

`matchMedia("(prefers-color-scheme: dark)")` plus a `change` listener, following
the existing `use-viewport.ts` idiom. The switch is live: changing the OS
appearance while the app is open re-resolves the slot and applies the other
theme, with no reload.

### Settings UI

The Theme section becomes a mode selector (Dark / Light / System) plus **two**
theme grids, "Dark theme" and "Light theme", each filtered to its slot. Both
grids stay visible regardless of the active mode — configuring the light theme
while sitting in dark mode is the normal case, not an edge one. Everything the
single grid already does carries over per grid: previews, keyboard navigation,
the analytics capture, and the non-selectable error card bearing a rejected
theme's reason.

### Consequence for the unthemed palette

With light as a first-class mode — reachable automatically via `system` — the
hardcoded Tailwind palette literals outside the token vocabulary stop being
deferrable. They render at 1.4–2.8:1 on white, and `lib/badge-config.tsx` alone
paints every row of the main view.

A full survey (2026-11-17) found **721** such sites across 46 production files,
of which exactly ONE sat inside a `dark:` variant. They are not 18 colour
families but six semantic roles reused throughout — `formula-dag`'s
`bg-amber-500/15 text-amber-400` is byte-identical to `home-page`'s:

| role | sites | mechanism |
|---|---|---|
| info / warning / success | ~424 | the three new tone tokens (§7) |
| error | ~91 | the existing `destructive` |
| neutral chrome | ~133 | existing `muted` / `border` / `card` |
| status, priority, bead-type keyed | ~88 | the status-colour machinery |

The sweep is being done in phases, main view first. See §7.

## §7 Semantic tone tokens (amended 2026-11-17)

Three authorable colour tokens are added — `warning`, `info`, `success` — and
one derivation rule that also applies to the pre-existing `destructive`.

### Why the vocabulary had to grow

Decision 2 originally promised no new tokens. The palette survey showed that
promise could not be kept: ~424 of the 721 hardcoded sites are warning, info or
success tones, and none of the 19 existing tokens expresses them. `primary` is
the brand green, and `accent` is a neutral tint in this palette — neither is a
warning amber or a link blue. The alternative was `dark:`-paired literals at
each of those sites, which works visually but leaves them **unthemeable** — so
a user's theme file could never change them. That defeats the purpose of the
feature, so the vocabulary grows by three rather than the sweep shipping
something a theme cannot reach.

`destructive` already covers the error tone and is deliberately NOT duplicated.

### One hex per tone, text derived not authored

A theme supplies one hex per tone. The readable text value is computed per
surface by the engine, using the `readableTextColor(hex, surface)` that
per-status colours already use: it mixes the tone toward white or black until
it clears 4.5:1 against its own 20% tint over the theme's `card`.

That is what lets a single authored hex work in both appearances:

| tone | base | text on `#27272a` | text on `#ffffff` |
|---|---|---|---|
| warning | `#f59e0b` | `#f59e0b` | `#935f07` |
| info | `#3b82f6` | `#76a8f9` | `#2c62b9` |
| success | `#10b981` | `#28c08e` | `#0a7854` |
| destructive | `#ef4444` | `#f47c7c` | `#b33333` |

All four clear 4.78:1 against their own fill in both appearances (measured).

The engine emits `--bb-<tone>` and `--bb-<tone>-text`; `@theme` exposes
`--color-<tone>` and `--color-<tone>-text`. Call sites use
`bg-warning/15 border-warning/30 text-warning-text`. The bare tone token must
never be used as text — the hex is tuned for fills and fails contrast on a
light card. A source-scan test enforces this rather than a comment asserting
it. `destructive` gets a derived `-text` companion WITHOUT becoming a new
authorable token: it is shadcn's semantic for a solid fill, paired with
`destructiveForeground` for text ON that fill, which is the wrong value for a
tinted badge.

### Tones are optional

Unlike the 19 required colours, a theme may omit all three. `DEFAULT_TONE_HEX`
then applies, so every theme file written before these tokens existed stays
valid — the compatibility guarantee that makes this amendment safe to ship
after the format was already public. A tone that IS present must still parse as
hex or `rgb()`, since a value is derived from it.

### Status, priority and bead-type colours route through the machinery

These are keyed, not tonal: five priorities and fourteen bead types against
three tones, so routing them to tones would flatten red/orange/yellow into one
hue. Each instead gets a default-hex table — `DEFAULT_STATUS_HEX`,
`DEFAULT_PRIORITY_HEX`, `DEFAULT_TYPE_HEX` — carrying exactly the hues the
literals used, tagged via `data-status` / `data-priority` / `data-type`, and
emitted as one unlayered stylesheet that beats Tailwind's `@layer utilities`
without `!important`. They go through it purely for the per-surface text.

A built-in status with no chosen colour previously kept the hardcoded Tailwind
classes and emitted no rule. That is reversed: every status now emits a rule,
so a built-in and a user-coloured custom status behave identically. The fill is
unchanged — `amber-500` IS `#f59e0b` at the same alpha.

A badge config's `className` is now the PRE-STYLESHEET fallback only, written
in tokens, since status rules appear only once the custom-status list loads.

### `open`'s default follows the theme

`DEFAULT_STATUS_HEX.open` was `#ffffff`, correct only while every theme is
dark: tinted 20% over a white card it is white — contrast 1.00, an invisible
badge in any light theme. `open` has no colour of its own (it draws in the body
text colour), so its default resolves from the theme's `foreground` and follows
any theme, user themes included. It stays in `RESERVED_HEX` so a generated
custom colour keeps avoiding it.

## Out of scope

- Per-workspace themes. Themes are application-level; status colours remain
  per-workspace and server-side.
- Theme marketplace, sharing, or download.
- Theming the Rust-side loading screen (`src-tauri/loading/index.html`).
- Judging whether a valid theme is legible (§4.3).
