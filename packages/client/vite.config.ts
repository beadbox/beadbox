import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import tailwindcss from "@tailwindcss/vite"
import { TanStackRouterVite } from "@tanstack/router-plugin/vite"
import react from "@vitejs/plugin-react"
import { defineConfig, type Plugin } from "vite"
import { testTransportEnabled, testTransportGuard } from "./vite-plugins/test-transport-guard"

const __dirname = dirname(fileURLToPath(import.meta.url))

// bb-216k: when CI doesn't pre-populate VITE_APP_VERSION (i.e. local
// `bun run tauri:dev`, plain `vite dev`, ad-hoc `vite build` without env),
// fall back to root package.json so `import.meta.env.VITE_APP_VERSION`
// always inlines a real string. Without this, every PostHog event from a
// dev build was tagged app_version='unknown' (growth bb-udj8 audit).
// CI sets the env explicitly from the git tag and wins this branch.
//
// IMPORTANT (qa1 diagnosis): do NOT also fall back VITE_BUILD_TAG. The
// posthog-guard plugin below treats any `^\d`-prefixed VITE_BUILD_TAG as a
// release build and demands VITE_POSTHOG_KEY/HOST. In dev mode those secrets
// are absent (Vite loads .env.local AFTER plugin config() hooks), so any
// non-empty BUILD_TAG fallback turns dev into a hard release-build error.
// VITE_BUILD_TAG stays empty in dev — consumers (use-update-checker,
// dev-badge) already fall back to VITE_APP_VERSION when BUILD_TAG is blank.
if (!process.env.VITE_APP_VERSION) {
  const rootPkg = JSON.parse(readFileSync(resolve(__dirname, "../../package.json"), "utf-8"))
  process.env.VITE_APP_VERSION = rootPkg.version
}

// bb-aurr: fail fast at build time if a release build is missing the
// PostHog injection. v0.25.0-rc.1 and rc.2 shipped with empty/missing
// VITE_POSTHOG_KEY which caused 5 days of telemetry blackout. The build
// would happily succeed and the runtime would silently no-op.
//
// Triggers when VITE_BUILD_TAG looks like a release tag (starts with a
// digit, e.g. "0.25.0-rc.3" or "1.0.0"). Dev builds (no BUILD_TAG) and
// explicit SKIP_POSTHOG_GUARD=1 (for local non-release one-offs) bypass.
function posthogGuardPlugin(): Plugin {
  return {
    name: "beadbox-posthog-guard",
    config() {
      if (process.env.SKIP_POSTHOG_GUARD === "1") return
      const buildTag = process.env.VITE_BUILD_TAG ?? ""
      const looksLikeRelease = /^\d/.test(buildTag)
      if (!looksLikeRelease) return
      const key = process.env.VITE_POSTHOG_KEY ?? ""
      const host = process.env.VITE_POSTHOG_HOST ?? ""
      if (!key || !host) {
        throw new Error(
          `[posthog-guard] release build (VITE_BUILD_TAG=${buildTag}) is missing ` +
            `${!key ? "VITE_POSTHOG_KEY" : ""}${!key && !host ? " and " : ""}` +
            `${!host ? "VITE_POSTHOG_HOST" : ""}. ` +
            "GitHub secret NEXT_PUBLIC_POSTHOG_KEY/HOST is likely empty in repo " +
            "settings. Set SKIP_POSTHOG_GUARD=1 to bypass for local one-offs.",
        )
      }
    },
  }
}

// base: "./" is binding (spec §6 P2.1, bead AC). The Tauri asset protocol
// serves index.html from tauri://localhost/ — absolute URLs like
// /assets/index-abc.js would resolve relative to the protocol root, not the
// document, and 404. The bead AC includes a grep gate against
// dist/index.html for href="/".
// beadbox-r72.2: the headless test transport. On only for a build run with
// BEADBOX_TEST_TRANSPORT=1 (the Playwright harness); every other build gets
// the literal false, the test transport's import() is compiled out, and the
// guard fails the build if any of it survives.
const TEST_TRANSPORT = testTransportEnabled()

export default defineConfig({
  base: "./",
  define: {
    __BEADBOX_TEST_TRANSPORT__: JSON.stringify(TEST_TRANSPORT),
  },
  // bb-1yhp: honor PORT env var so the Playwright webServer in
  // e2e/holistic/playwright.holistic.config.ts (and the project port-
  // assignment table for parallel agent dev sessions) can pin the dev
  // server to a specific port. Without this, Vite ignores PORT and
  // defaults to 5173, leaving Playwright waiting on TEST_PORT forever
  // (60s timeout). strictPort: true is a deliberate fail-fast — silent
  // fallback to the next free port would confuse both CI and developers.
  server: {
    port: Number(process.env.PORT) || 5173,
    strictPort: true,
  },
  plugins: [
    // Auto-generates src/routeTree.gen.ts from src/routes/. Treated as build
    // output (gitignored). Dev server regenerates on save.
    TanStackRouterVite({ target: "react", autoCodeSplitting: true }),
    react(),
    // Tailwind v4 Vite plugin. CSS-first config (no tailwind.config.js); the
    // plugin reads @theme {} blocks from src/index.css. Bypasses PostCSS,
    // so the parent-config-walk-up issue TB0 hit doesn't apply here.
    tailwindcss(),
    posthogGuardPlugin(),
    testTransportGuard(TEST_TRANSPORT),
  ],
  resolve: {
    alias: {
      // Mirrors tsconfig.json paths "@/*" -> "./src/*". The bead-90zz.5 home
      // route port reuses the main app's @/-import convention.
      "@": resolve(__dirname, "src"),
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: true,
  },
})
