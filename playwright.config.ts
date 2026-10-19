import { defineConfig, devices } from "@playwright/test"
import { mkdirSync, mkdtempSync, realpathSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { findFreePort } from "./e2e/fixtures/dolt-server"

// Headless harness (beadbox-r72.3, systemdesign §7.2): Playwright drives a
// production-shape test build of the real bundle against a real sidecar, one
// per worker, through the test transport (a CDP binding, not a socket). No
// window, no Tauri shell. The only listener is Vite's preview server.
//
// Everything below is decided ONCE, in the main process, and cached into
// process.env so global setup, every worker and teardown see the same values
// (workers re-evaluate this file).

// One fresh directory per run: a scratch HOME for every spawned process,
// template and per-worker Dolt data, workspaces, synthetic registries, logs and
// the test build. Two runs on one machine never share a path.
if (!process.env.E2E_RUN_DIR) {
  process.env.E2E_RUN_DIR = realpathSync(mkdtempSync(join(tmpdir(), "beadbox-e2e-")))
}
const RUN_DIR = process.env.E2E_RUN_DIR
process.env.E2E_HOME ??= join(RUN_DIR, "home")
mkdirSync(process.env.E2E_HOME, { recursive: true })
// Global setup's registries; each worker writes its own (e2e/fixtures/harness.ts).
process.env.BEADS_REGISTRY_PATH ??= join(RUN_DIR, "legacy-registry.json")
process.env.BEADBOX_REGISTRY_PATH ??= join(RUN_DIR, "registry.json")

const TEST_PORT = Number(process.env.TEST_PORT) || findFreePort()
process.env.TEST_PORT = String(TEST_PORT)

// The test build: BEADBOX_TEST_TRANSPORT=1 selects the binding transport
// (packages/client/src/lib/sidecar-transport.ts). Built into the run directory,
// never into packages/client/dist. E2E_CLIENT_DIST reuses a prebuilt one (CI).
const CLIENT_DIST = process.env.E2E_CLIENT_DIST || join(RUN_DIR, "client-dist")
// The client package's own pinned Vite, run from that package. Never `bun x
// vite`: bunx resolves outside the package, downloads vite@latest from the
// registry and runs that instead (it did, once, while this harness was built).
const vite = "node_modules/.bin/vite"
const preview = `${vite} preview --outDir ${CLIENT_DIST} --host 127.0.0.1 --port ${TEST_PORT} --strictPort`
const build = `${vite} build --outDir ${CLIENT_DIST} --emptyOutDir`

export default defineConfig({
  testDir: "./e2e",
  // Only the headless specs run. The legacy e2e/*.spec.ts files target the
  // pre-Tauri surface and stay in tree, ignored, until each is ported here
  // (beadbox-r72.4 onwards).
  testMatch: "headless/**/*.spec.ts",
  testIgnore: ["**/holistic/**"],
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? [["github"], ["list"]] : "list",
  globalSetup: "./e2e/global-setup.ts",
  globalTeardown: "./e2e/global-teardown.ts",
  timeout: 30_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: `http://127.0.0.1:${TEST_PORT}`,
    headless: true,
    // E2E_CHROMIUM: run against an already-installed Chromium instead of the
    // pinned download (local convenience; CI installs the pinned one).
    ...(process.env.E2E_CHROMIUM ? { launchOptions: { executablePath: process.env.E2E_CHROMIUM } } : {}),
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: process.env.E2E_CLIENT_DIST ? preview : `${build} && ${preview}`,
    cwd: "packages/client",
    url: `http://127.0.0.1:${TEST_PORT}`,
    reuseExistingServer: false,
    timeout: 120_000,
    stdout: "ignore",
    stderr: "pipe",
    env: { ...process.env, BEADBOX_TEST_TRANSPORT: "1" } as Record<string, string>,
  },
})
