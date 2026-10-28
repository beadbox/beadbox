# P4 Verification Rubric

Binding 6-gate runbook for re-baselining the post-P4 stack. Re-run on every
Tauri or Bun upgrade, every macOS WebKit major shift, and any time the
Tauri-WebView ↔ kkrpc-sidecar bridge surface changes.

This rubric lives because each of the four `bb-90zz.7` cutover bounces
(resolver / runtime / capabilities / CSS engine) became an ADR-2008 addendum
*after* a permissive verifier passed the artifact and a stricter one found
the gap. The strictest verifier per gate (per addendum 6) is documented
inline; do not relax.

## How to use

1. Run gates 1 → 6 in order. Halt on first failure.
2. Each gate has: **command(s)**, **strictest verifier**, **pass criteria**,
   **what to do on fail**.
3. Fill the per-gate evidence template at the end. Attach to the bead's DONE
   comment (or to a re-baseline ticket if you're running this against an
   upgrade).
4. Some gates require GUI access (DevTools, Safari Develop, .app bundle
   launch). Those are flagged **GUI-required**; CLI-only sessions stop at
   the gate boundary and document the rest as pending.

---

## Gate 1 — Capability-error-zero precondition (addendum 4)

**Strictest verifier:** Production bundle on macOS WKWebView with Tauri v2
capabilities baked in, DevTools attached, console errors counted across
every route.

**Why:** Tauri v2's capabilities system is permission-checked at runtime.
A missing capability identifier surfaces as a console error, not a build
error. Routes that *happen* not to invoke the gated API in dev can pass
the dev-mode check and fail in production. **Both dev AND bundled-app
console error counts must be zero.**

**Steps (GUI-required):**

```bash
# Dev mode
bun run tauri:dev
# In the app: Develop → [Mac] → [Beadbox] → Show Web Inspector
# Navigate to: /, /workspaces, /activity, /formulas
# In each route: open the dev console (window.bd helper), run a probe
```

In DevTools console, count matches:

```js
// Paste in DevTools console — runs against the current console buffer
console.warn(
  "[p4.5 gate 1]",
  ["permission denied", "not allowed", "capability", "permission"].map((needle) => ({
    needle,
    // If you have a console history dump, replace [] with the array of message strings
    matches: ([]).filter((m) => String(m).toLowerCase().includes(needle)).length,
  })),
);
```

Repeat against the production bundle:

```bash
bun run tauri build
# macOS: open src-tauri/target/release/bundle/macos/Beadbox.app
# Linux: chmod +x src-tauri/target/release/bundle/appimage/Beadbox-*.AppImage && ./Beadbox-*.AppImage
# Windows: src-tauri/target/release/bundle/msi/Beadbox-*.msi (install + launch)
# Open DevTools (Develop menu / Tauri devtools cap)
```

**Pass criteria:** Zero matches in both dev and bundled DevTools console
across all four routes.

**On fail:** File a P4-followup bead naming the missing capability
identifier. Bounce P4.5. Add the capability to
`src-tauri/capabilities/default.json` per addendum 4.

---

## Gate 2 — WKWebView CSS visual diff vs Chromium (addendum 5)

**Strictest verifier:** Safari Develop attached to the WKWebView in
`bun run tauri:dev`, side-by-side screenshot comparison against
`bun --cwd packages/client run dev` in Chromium.

**Why:** Tailwind v4's `@theme` block, OKLCH colors, and `color-mix()`
chains render differently across engines. WebKit accepts more permissive
syntax than the Vite-only browser dev path; CSS that "works" in Chromium
can render text-invisible / wrong-color in WKWebView. Bounce B3 in the
P3.7 cutover was exactly this class.

**Steps (GUI-required):**

```bash
# Tauri WKWebView
bun run tauri:dev
# Develop → [Mac] → [Beadbox] → Web Inspector
# For each route, screenshot via Web Inspector → Element snapshot
#   Save as: docs/p4-screenshots/<route>--wkwebview.png

# Chromium (vite dev)
bun --cwd packages/client run dev
# Open http://localhost:5173/<route> in Chrome (NOT Tauri)
# DevTools → 3-dot menu → Capture screenshot
#   Save as: docs/p4-screenshots/<route>--chromium.png
```

**Diff checklist (binding):**

- [ ] All foreground text visible in **both** screenshots
- [ ] Theme tokens render same color (within rounding tolerance) in both
- [ ] Layout aligned: containers, flex/grid math, spacing
- [ ] No "invisible button" cases (transparent on WKWebView)
- [ ] No raw OKLCH `oklch(...)` strings reaching the engine outside
      `@theme` (run `grep oklch packages/client/src/index.css` —
      should only appear inside `@theme {}` blocks)

**Pass criteria:** All four checklist items green for `/`, `/workspaces`,
`/activity`, `/formulas`.

**On fail:** Audit `packages/client/src/index.css` for `oklch` outside
`@theme`, deep `color-mix` chains, or unflattened custom properties.
Apply addendum 5's flatten discipline; restore the bb-90zz.7 B3 baseline.

---

## Gate 3 — Subscription burst (addendum 1, P4.2 strictest verifier)

**Strictest verifier:** Tauri app running, 1000 mutations in <30s, activity
feed renders all 1000 events with order preserved, kkrpc requests during
the burst still resolve.

**Why:** Stdout is the kkrpc wire; stderr carries `[SUBSCRIPTION:<id>]`
event lines. Under sustained load the bridge's two channels race —
buffered batch arrival, line splitting on chunk boundaries, kkrpc reply
interleaving. P1.6 validated the writer in isolation; this gate exercises
the full Rust bridge → WebView event bus → React invalidation chain.

**Steps:**

CLI part 1 (run anywhere — the writer in isolation):

```bash
bun --cwd packages/server test src/__tests__/subscribe.parity.test.ts
```

GUI part 2 (Tauri end-to-end):

```bash
# Terminal 1
bun run tauri:dev

# Terminal 2 — in a tmpdir bd workspace registered in Beadbox
TMPD=$(mktemp -d) && cd "$TMPD" && git init -q && bd init --skip-hooks --skip-agents
# Add this workspace via Beadbox UI; navigate to /activity
# Then in Terminal 2:
START=$(date +%s); for i in $(seq 1 1000); do bd create -t bug -p 1 "burst-$i" >/dev/null; done; END=$(date +%s); echo "elapsed: $((END-START))s"
```

**Pass criteria:**

- CLI part 1: 1000-event burst test passes (zero drops, all parse cleanly)
- GUI part 2:
  - All 1000 burst beads visible in /activity feed within 30s of last
    `bd create`
  - Sequence numbers monotonically increasing across the rendered feed
  - During the burst, manually invoke `await rpc.beads.list()` from the
    DevTools console — kkrpc request still resolves with current state
    (no deadlock / dropped reply)

**On fail:** addendum 1's contract is broken. File a P4-followup against
the breaking bead (P4.2 if Rust bridge, P1.6 if writer, P2.4 if client
listener). Bounce P4.5.

---

## Gate 4 — Production-bundle smoke (P4.[1-3] strictest verifier)

**Strictest verifier:** Installed bundle on host platform launched outside
dev mode, every route smoke-tested, clean exit verified via ps grep.

**Why:** Capability resolution and sidecar pathing differ between dev
(`tauri:dev`'s loose external-bin location) and bundled (the strictly
relative `Contents/MacOS/sidecar` location). TB0.4 caught this class once;
the strict verifier ensures it isn't re-introduced.

**Steps (GUI-required):**

```bash
bun run tauri build
# macOS:
open src-tauri/target/release/bundle/macos/Beadbox.app
# Linux:
chmod +x src-tauri/target/release/bundle/appimage/Beadbox-*.AppImage
./src-tauri/target/release/bundle/appimage/Beadbox-*.AppImage
# Windows:
# Install the .msi from src-tauri/target/release/bundle/msi/, launch from Start menu
```

**Smoke checklist:**

- [ ] StartupGate clears (window not stuck on the gate; main UI renders)
- [ ] `/` route: workspace selector visible
- [ ] `/workspaces` route: registry list visible
- [ ] `/activity` route: feed renders, no "RpcUnavailableError" toast
- [ ] `/formulas` route: list renders
- [ ] DevTools console: zero capability errors (re-applies Gate 1)
- [ ] Dev console (window.bd helper) responds; `await window.bd("list")`
      returns
- [ ] `bd create -t bug -p 1 "smoke"` in a separate shell → bead appears
      in /activity within 2s (re-applies the bb-hj80 / bb-1xi2 wire)

**Process exit:**

```bash
# After confirming smoke checklist, close the app window
# Within 500ms:
sleep 0.5 && ps aux | grep -E "Beadbox|beadbox-sidecar" | grep -v grep
# Expected: empty output (zero orphans)
```

**Pass criteria:** All checklist items green; ps grep empty.

**On fail:** A bundled-app failure that passes in `tauri:dev` means
capabilities or sidecar resolution diverges between dev and bundle. File
a P4-followup against the responsible P4.[1-3] bead. Bounce P4.5.

---

## Gate 5 — Dead-code regression (P4.3 strictest verifier)

**Strictest verifier:** `cargo build --release` clean of all warnings
(especially `unused`/`dead_code`); `cargo clippy -- -D warnings` clean;
explicit grep for deleted module names returns zero outside git history.

**Why:** P4.3 stripped Node-sidecar Rust + obsolete capabilities + dead
client transport. Stripped-but-not-deleted symbols are silent rot until a
later bead re-imports them. The grep is the leak detector.

**Steps:**

```bash
# Prereq: the sidecar binary must exist for tauri.conf.json's externalBin
# resolution. The dev/build hooks normally run this; do it explicitly here.
bash src-tauri/scripts/copy-sidecar.sh

# Cargo --release
( cd src-tauri && cargo build --release 2>&1 | tee /tmp/p4.5-cargo.log )
# Pass: zero "warning:" lines containing "unused" or "dead_code"

# Clippy
( cd src-tauri && cargo clippy --release -- -D warnings 2>&1 | tee /tmp/p4.5-clippy.log )
# Pass: exits 0

# Dead-symbol grep (the names P4.3 + P4.4 deleted)
grep -rE "spawn_node|wait_for_server|resolve_node_path|CHILD_PGID|tauri_plugin_shell|server-custom|use-websocket|ws-manager|api/ws" src-tauri/ packages/ --include="*.rs" --include="*.ts" --include="*.tsx" 2>&1 | tee /tmp/p4.5-grep.log
# Pass: empty output (matches in tb0/ are tracer history; verify the
#       only matches are inside tb0/ and treat as informational)
```

**Pass criteria:**
- `cargo build --release`: zero warnings
- `cargo clippy --release -- -D warnings`: exit 0
- Dead-symbol grep: empty, OR only:
  - `tb0/` matches (tracer history; out of scope)
  - The single doc comment in `src-tauri/src/paths.rs` line 4
    explaining what the module USED to contain. This is intentional
    historical context surfaced by P4.3 — verify the line is a
    comment (`//` prefix), not code, before treating as a pass.

**On fail:** Track down the symbol. If it's a re-add, bounce that bead.
If it's a P4.3 miss, file a P4.5 fix scoped to the regression.

---

## Gate 6 — Old `bun run dev` behaviour documented

**Strictest verifier:** `bun run dev` from the repo root either
redirects to the Vite SPA dev server, prints a clear error pointing at
the new dev command, or doesn't exist at all. Any of those is acceptable
per P4.4's eng-decision rubric — the gate exists so the documented state
is captured for the next engineer who tries the legacy path.

**Steps:**

```bash
# Inspect the root package.json scripts
jq '.scripts | to_entries | map(select(.key == "dev" or .key == "tauri:dev"))' package.json
# Run the legacy command:
bun run dev 2>&1 | tee /tmp/p4.5-legacy-dev.log
# Document the actual behaviour: redirect / error / missing
```

**Pass criteria:** Behaviour documented in DONE. Not a fail-the-bead gate.

**On unexpected behaviour:** If `bun run dev` silently runs the Next.js
dev server (which P4.4 deleted), then there's a stale script entry —
clean it up and reference P4.4 in the commit.

---

## Footnote sweep

`.next/dev/types/validator.ts` was noted by qa2 in the bb-un5c.4 QA as
a stale Next.js build artifact left after the legacy transport delete.

```bash
ls -la .next/dev/types/validator.ts 2>/dev/null && rm -rf .next || echo "no .next/ artifact present"
```

If present and removed, document the path + commit reference in DONE.

---

## Per-gate evidence template

Copy into the DONE comment of any P4.5 re-run.

```
Gate 1 — Capability-error-zero
  Dev (tauri:dev):     [pass | fail | blocked]
  Bundled .app:        [pass | fail | blocked]
  Routes covered:      / /workspaces /activity /formulas
  Console errors:      <count>
  Evidence:            <devtools console screenshot path>

Gate 2 — WKWebView CSS diff
  Per route:           [pass | fail | blocked]
  Screenshots:         docs/p4-screenshots/<route>--wkwebview.png
                       docs/p4-screenshots/<route>--chromium.png
  Diff observations:   <text-visibility, color, layout>

Gate 3 — Subscription burst
  Part 1 (writer):     [pass | fail | blocked]   (CLI test result)
  Part 2 (Tauri E2E):  [pass | fail | blocked]
  Burst elapsed:       <seconds for 1000 mutations>
  Drops/reorders:      <count>
  kkrpc-during-burst:  [resolved | dropped]

Gate 4 — Production bundle
  Build:               [pass | fail]
  Smoke checklist:     <which items pass/fail>
  Process exit:        <ps grep output>

Gate 5 — Dead-code regression
  cargo build:         [pass | fail]   (warnings: <count>)
  cargo clippy:        [pass | fail]
  Dead-symbol grep:    <matches outside tb0/>

Gate 6 — Legacy dev path
  Behaviour:           <redirect | error | missing | other>

Footnote sweep
  .next/dev/types/validator.ts:  <present-and-removed | absent>
```

---

## When this rubric runs

- **bb-un5c.5 baseline** — first execution; closes P4 epic.
- **Tauri major upgrade** — re-run gates 1, 2, 4 (the GUI-bridge contract
  changes most often there).
- **Bun major upgrade** — re-run gate 3 + gate 5 (sidecar runtime + Rust
  build invariants).
- **macOS major upgrade** (WebKit shifts) — re-run gate 2 + gate 4.
- **Capability schema change in Tauri** — re-run gate 1.

When re-running, link the new evidence to the upgrade-tracking bead so
the rubric's pass/fail history is queryable.

---

## externalBin convention (P5.2 — bb-x6lg.2)

`tauri.conf.json` declares the sidecar as a single base name:

```json
"externalBin": ["binaries/beadbox-sidecar"]
```

Tauri resolves this at bundle time by appending the active Rust target
triple, with `.exe` on Windows. The four supported triples and their
resolved paths:

| Rust triple | Resolved path |
|-------------|---------------|
| `aarch64-apple-darwin` | `binaries/beadbox-sidecar-aarch64-apple-darwin` |
| `x86_64-apple-darwin` | `binaries/beadbox-sidecar-x86_64-apple-darwin` |
| `x86_64-unknown-linux-gnu` | `binaries/beadbox-sidecar-x86_64-unknown-linux-gnu` |
| `x86_64-pc-windows-msvc` | `binaries/beadbox-sidecar-x86_64-pc-windows-msvc.exe` |

`copy-sidecar.sh` (P5.1) emits binaries at exactly these paths — see
`SIDECAR_BASENAME` + the `${SIDECAR_BASENAME}-${TARGET}${EXT}` template.
The convention contract is: **whatever copy-sidecar.sh emits, Tauri's
externalBin resolution must look up.** Drift on either side is a P5.2
bounce.

### Per-platform overlay handling

- **macOS / Linux / Windows overlays** carry no `externalBin` entry; they
  inherit the base. This is intentional — same sidecar pattern across
  the three desktop targets.
- **iOS overlay** (`tauri.ios.conf.json`) carries an explicit empty
  `externalBin: []` to override the inherited base. iOS does not run the
  Bun sidecar (see `lib.rs` `#[cfg(not(target_os = "ios"))]`); without
  the override Tauri would search for a non-existent
  `binaries/beadbox-sidecar-aarch64-apple-ios` at iOS bundle time.

### Missing-binary failure mode

When the binary for the active triple is absent, `bun run tauri build`
fails fast with a Tauri-level resource-not-found error pointing at the
missing path. This is the desired behaviour — it surfaces a CI matrix
mis-step (e.g. `copy-sidecar.sh` skipped on a runner) immediately rather
than producing a broken bundle that fails at first launch.

### When this convention changes

- **Tauri changes the externalBin separator** (currently `-`) — patch
  `copy-sidecar.sh` `OUTFILE=...` template to match.
- **A new Rust target gets added** to the matrix (e.g. iOS, ARM64
  Linux) — extend `rust_triple_to_bun_target` in `copy-sidecar.sh` and
  add the matching CI runner job.
- **Bun changes its `--target` naming** — patch
  `rust_triple_to_bun_target` mapping; the externalBin path is
  unaffected.

---

## CI workflow verification methodology

Different workflow files take different verification approaches based on
how they're triggered. Check the workflow's `on:` block before specifying
verification.

| Workflow | Trigger | Verification path |
|---|---|---|
| `release.yml` | `push: tags: ["v*"]` + `workflow_dispatch` | Push a test tag to a feature branch; observe the run end-to-end. |
| `build-arm-dmg.yml` | RETIRED (beadbox-449.6) | A dispatched Build (nightly) on main makes the signed .app and DMG. |
| `e2e-tests.yml` | `workflow_call` ONLY (callable by release.yml) | Structural-checks-as-fallback: grep for stale `pnpm`/`setup-node` refs, YAML lint, then transitive verification when `release.yml` fires (qa3 observation 2026-04-25). NOT directly dispatchable. |
| `holistic-tests.yml` | `workflow_call` ONLY | Same as e2e-tests.yml — structural fallback + transitive via `release.yml`. NOT directly dispatchable. |
| `install-smoke.yml` (P5.6) | `workflow_dispatch` + post-release hook | Trigger directly after release.yml lands artifacts. |

**workflow_call-only workflows look unrunnable from `gh workflow run`.**
That's correct. Their migration QA happens transitively when the calling
workflow fires. Future engineers attempting to dispatch them standalone
will see "workflow does not have any triggers that allow this dispatch" —
that's by design, not a regression.
