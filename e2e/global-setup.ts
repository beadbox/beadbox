import { execFileSync } from "child_process"
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"

import {
  childEnv,
  findBd,
  findDolt,
  findFreePort,
  startDoltServer,
  stopDoltServer,
  bd,
  bdCreate,
} from "./fixtures/dolt-server"
import { runPaths } from "./fixtures/run-paths"

// beadbox-r72.3: this setup no longer asks bd to kill every Dolt server of
// this user (other agents' included) and no longer reads or
// rewrites the real ~/.beads/registry.json. Under the headless harness every
// bd and Dolt process gets a scratch HOME (E2E_HOME), so nothing it creates
// can reach the real home in the first place.
const HEADLESS = !!process.env.E2E_RUN_DIR

// Unique suffix per Playwright process. globalSetup (main process) sets
// E2E_TEMPLATE_ID before workers spawn. Workers inherit the env var, so
// all processes within a single test run share the same paths. Different
// CI jobs on the same machine get different PIDs, avoiding cross-job races
// where one job's globalTeardown deletes another's template directories.
if (!process.env.E2E_TEMPLATE_ID) {
  process.env.E2E_TEMPLATE_ID = String(process.pid)
}
const TEMPLATE_SUFFIX = process.env.E2E_TEMPLATE_ID

// Template Dolt data directory: contains all seeded databases.
// Workers copy this and start their own Dolt server against the copy.
export const TEMPLATE_DATA_DIR = HEADLESS
  ? runPaths().templateData
  : join(tmpdir(), `beadbox-e2e-dolt-data-${TEMPLATE_SUFFIX}`)

// Template workspace directories: contain .beads/ with metadata.json.
// Workers copy these and update the dolt_server_port in metadata.json.
const templateWs = (name: string) =>
  HEADLESS ? runPaths().templateWorkspace(name) : join(tmpdir(), `beadbox-e2e-ws-${name}-${TEMPLATE_SUFFIX}`)
export const TEMPLATE_WS_DIR = templateWs("standard")
export const TEMPLATE_ALPHA_WS_DIR = templateWs("alpha")
export const TEMPLATE_BETA_WS_DIR = templateWs("beta")
export const TEMPLATE_GAMMA_WS_DIR = templateWs("gamma")
// bd 1.3 custom statuses in name:category form (beadbox-r72.4, check C).
export const TEMPLATE_STATUSES_WS_DIR = templateWs("statuses")
export const CUSTOM_STATUSES = "ticket_awaiting:active,ticket_active:wip,unit_escalated:frozen"
// Open bd gates for the Waiting view (beadbox-37h5): its own workspace, so no
// other spec sees a gate, a Waiting tab or a blocked bead.
export const TEMPLATE_GATES_WS_DIR = templateWs("gates")
// A nested formula poured once for the Formulas tab's closed/total per step
// (beadbox-ptca.4): its own workspace, so no other spec sees a molecule. Step 1's
// title is a template (resolved by --var on the pour), Step 3 has no children.
export const TEMPLATE_MOLECULES_WS_DIR = templateWs("molecules")
export const NESTED_FORMULA = "nest-flow"
const NESTED_FORMULA_TOML = `formula = "${NESTED_FORMULA}"
description = "synthetic nested"
version = 1
type = "workflow"

[vars.who]
default = "alice"

[[steps]]
id = "s1"
title = "Step 1: {{who}} prepares"

[[steps.children]]
id = "c1a"
title = "Child 1a"

[[steps.children]]
id = "c1b"
title = "Child 1b"

[[steps.children]]
id = "c1c"
title = "Child 1c"
needs = ["c1a"]

[[steps]]
id = "s2"
title = "Step 2: ship"
needs = ["s1"]

[[steps.children]]
id = "c2a"
title = "Child 2a"

[[steps]]
id = "s3"
title = "Step 3: empty"
`
/** Children of the gates workspace's "Big epic": past the view's per-gate cap of 200. */
export const BIG_EPIC_CHILDREN = 250

// Port used by the temporary Dolt server during template creation.
// Not used at runtime; workers pick their own ephemeral ports.
// Uses findFreePort() to avoid hardcoded port conflicts (bd 0.60+ compat).
const TEMPLATE_DOLT_PORT = Number(process.env.E2E_TEMPLATE_DOLT_PORT) || findFreePort()

const BD_PATH = findBd()

// System databases that Dolt always creates (not user data).
const DOLT_SYSTEM_DATABASES = new Set(["dolt", "information_schema", "mysql"])

function initWorkspace(wsDir: string, prefix: string): string {
  if (existsSync(wsDir)) rmSync(wsDir, { recursive: true, force: true })
  mkdirSync(wsDir, { recursive: true })

  // Record databases before init so we can identify the new one.
  const beforeDbs = new Set(
    existsSync(TEMPLATE_DATA_DIR)
      ? readdirSync(TEMPLATE_DATA_DIR).filter(d => !d.startsWith(".") && !DOLT_SYSTEM_DATABASES.has(d))
      : []
  )

  // Use env vars to tell bd init the server is already running. Without
  // these, bd init tries to start its own Dolt server on the same port,
  // which kills the already-running template server.
  // bd 1.0.x compatibility:
  //   --server + --external  : bd init defaults to embedded mode now, even
  //     with --server-host/--server-port set. We start the dolt server
  //     ourselves (above) and want bd to use it, so we pass --server (use
  //     external sql-server) and --external (server is already running,
  //     don't try to manage its lifecycle).
  //   --skip-hooks            : avoids a bd 1.0.2 self-deadlock on macOS.
  //     bd init runs `git commit`, which fires bd's own pre-commit hook,
  //     which calls `bd export`, which blocks on the embedded-dolt lock
  //     still held by bd init. The hook tries to bound itself with
  //     `timeout`, but that binary is not installed by default on macOS
  //     (only `gtimeout` from coreutils), so the unbounded fallback
  //     hangs indefinitely. Test workspaces are throwaway anyway and do
  //     not need bd's git integration.
  execFileSync(BD_PATH, [
    "init",
    "--prefix", prefix,
    "--server",
    "--external",
    "--server-host", "127.0.0.1",
    "--server-port", String(TEMPLATE_DOLT_PORT),
    "--skip-hooks",
    "-q",
  ], {
    cwd: wsDir,
    encoding: "utf-8",
    env: childEnv({
      BEADS_DOLT_SERVER_HOST: "127.0.0.1",
      BEADS_DOLT_SERVER_PORT: String(TEMPLATE_DOLT_PORT),
    }),
  })

  // Ensure metadata.json records the port and database name.
  // The database name MUST be explicit so it's portable: when workers copy
  // the workspace to a temp directory with a different name, bd derives a
  // different default database name from the directory, causing
  // "database not found" errors. Writing dolt_database makes it stable.
  const metaPath = join(wsDir, ".beads", "metadata.json")
  const meta = JSON.parse(readFileSync(metaPath, "utf-8"))
  if (!meta.dolt_server_port) {
    meta.dolt_server_port = TEMPLATE_DOLT_PORT
  }
  const afterDbs = readdirSync(TEMPLATE_DATA_DIR).filter(d =>
    !d.startsWith(".") && !DOLT_SYSTEM_DATABASES.has(d)
  )
  const newDb = afterDbs.find(d => !beforeDbs.has(d))
  if (!newDb) {
    throw new Error(
      `initWorkspace: no new database detected after bd init in ${wsDir}. ` +
      `Before: [${[...beforeDbs].join(", ")}], After: [${afterDbs.join(", ")}]. ` +
      `This means bd init reused an existing database instead of creating one.`
    )
  }
  meta.dolt_database = newDb
  writeFileSync(metaPath, JSON.stringify(meta, null, 2))

  return join(wsDir, ".beads", "beads.db")
}

function seedStandardData(dbPath: string): void {
  const epicId = bdCreate(dbPath, [
    "--title", "E2E Test Epic", "--type", "epic", "--priority", "2",
  ], TEMPLATE_DOLT_PORT)
  bdCreate(dbPath, [
    "--title", "High Priority Task", "--type", "task", "--priority", "1",
    "--parent", epicId,
  ], TEMPLATE_DOLT_PORT)
  const inProgressId = bdCreate(dbPath, [
    "--title", "In Progress Task", "--type", "task", "--priority", "2",
    "--parent", epicId,
  ], TEMPLATE_DOLT_PORT)
  bd(dbPath, ["update", inProgressId, "--status", "in_progress"], TEMPLATE_DOLT_PORT)
  bdCreate(dbPath, [
    "--title", "Critical Bug", "--type", "bug", "--priority", "0",
    "--parent", epicId,
  ], TEMPLATE_DOLT_PORT)
  const closedId = bdCreate(dbPath, [
    "--title", "Completed Task", "--type", "task", "--priority", "3",
    "--parent", epicId,
  ], TEMPLATE_DOLT_PORT)
  bd(dbPath, ["update", closedId, "--status", "closed"], TEMPLATE_DOLT_PORT)
  bdCreate(dbPath, [
    "--title", "Search Target Alpha", "--type", "task", "--priority", "2",
  ], TEMPLATE_DOLT_PORT)
}

/** Fail with the cause on the first line when a required tool is missing. */
// beadbox-37h5: one gate of each kind the Waiting view lists, plus a human gate
// on an epic whose children exceed the per-gate cap. The 250 children go in
// with one bd import of synthetic rows (one bd create each would take minutes).
function seedGatesWorkspace(dbPath: string): void {
  const port = TEMPLATE_DOLT_PORT
  const gate = (args: string[]) =>
    (JSON.parse(bd(dbPath, ["gate", "create", ...args, "--json"], port)) as { id: string }).id
  const ship = bdCreate(dbPath, ["--title", "Ship feature", "--type", "task"], port)
  const deploy = bdCreate(dbPath, ["--title", "Deploy", "--type", "task"], port)
  for (let i = 1; i <= 3; i++) bdCreate(dbPath, ["--title", `Spare task ${i}`, "--type", "task"], port)

  const now = new Date().toISOString().replace(/\.\d+Z$/, "Z")
  const row = (id: string, title: string, type: string, parent?: string) =>
    JSON.stringify({
      _type: "issue",
      id,
      title,
      status: "open",
      priority: 2,
      issue_type: type,
      created_at: now,
      updated_at: now,
      ...(parent
        ? { dependencies: [{ issue_id: id, depends_on_id: parent, type: "parent-child", created_at: now }] }
        : {}),
    })
  const rows = [row("gw-big", "Big epic", "epic")]
  for (let i = 1; i <= BIG_EPIC_CHILDREN; i++) rows.push(row(`gw-big.${i}`, `Big child ${i}`, "task", "gw-big"))
  const jsonl = join(TEMPLATE_GATES_WS_DIR, "big-epic.jsonl")
  writeFileSync(jsonl, `${rows.join("\n")}\n`)
  bd(dbPath, ["import", jsonl], port)
  rmSync(jsonl)

  gate(["--type=human", `--blocks=${ship}`, "--reason=Need design review"])
  gate(["--type=timer", `--blocks=${deploy}`, "--timeout=2h"])
  gate(["--type=gh:run", `--blocks=${deploy}`, "--await-id=123456789"])
  gate(["--type=human", "--blocks=gw-big", "--title=Gate: big epic sign-off"])
}

function requireTool(name: string, path: string): void {
  try {
    execFileSync(path, ["version"], { encoding: "utf-8", timeout: 15_000, env: childEnv() })
  } catch (error) {
    const reason = (error as NodeJS.ErrnoException).code === "ENOENT" ? "not found" : (error as Error).message.split("\n")[0]
    throw new Error(`[e2e] ${name} is required (${path}): ${reason}. Install it or set ${name.toUpperCase()}_PATH.`)
  }
}

export default function globalSetup() {
  // Refuse to run outside playwright.config.ts: without the run directory and
  // its scratch HOME, bd init and Dolt would write into the real home.
  if (!process.env.E2E_RUN_DIR || !process.env.E2E_HOME) {
    throw new Error("[e2e] global setup must run through playwright.config.ts (E2E_RUN_DIR and E2E_HOME are not set)")
  }
  // 0. Tools present, and a scratch HOME with a Dolt identity (Dolt refuses
  // `dolt init` without one; CI runners have none).
  requireTool("bd", BD_PATH)
  requireTool("dolt", findDolt())
  if (HEADLESS) {
    mkdirSync(runPaths().home, { recursive: true })
    for (const [key, value] of [["user.name", "beadbox-e2e"], ["user.email", "e2e@beadbox.app"]]) {
      execFileSync(findDolt(), ["config", "--global", "--add", key, value], { env: childEnv(), stdio: "ignore" })
    }
    // Test runs are not usage: keep them out of bd's anonymous metrics.
    execFileSync(BD_PATH, ["metrics", "off"], { env: childEnv(), stdio: "ignore", timeout: 15_000 })
  }

  // 2. Reset the isolated test registries (legacy + beadbox format)
  const testRegistryPath = process.env.BEADS_REGISTRY_PATH
  if (testRegistryPath) {
    writeFileSync(testRegistryPath, "[]")
  }
  const testBeadboxRegistryPath = process.env.BEADBOX_REGISTRY_PATH
  if (testBeadboxRegistryPath) {
    writeFileSync(testBeadboxRegistryPath, JSON.stringify({ version: 2, workspaces: [], activeWorkspace: null }))
  }

  // 3. Prepare template Dolt data directory
  if (existsSync(TEMPLATE_DATA_DIR)) rmSync(TEMPLATE_DATA_DIR, { recursive: true, force: true })
  mkdirSync(TEMPLATE_DATA_DIR, { recursive: true })

  // 4. Start a temporary Dolt server for seeding
  const server = startDoltServer(TEMPLATE_DOLT_PORT, TEMPLATE_DATA_DIR, "SELECT 1", { killPortFirst: !HEADLESS })

  try {
    // 5. Create and seed template workspaces (all on the same temp server)
    const stdDbPath = initWorkspace(TEMPLATE_WS_DIR, "e2e")
    seedStandardData(stdDbPath)

    const alphaDbPath = initWorkspace(TEMPLATE_ALPHA_WS_DIR, "alpha")
    const alphaEpicId = bdCreate(alphaDbPath, [
      "--title", "Alpha Epic", "--type", "epic", "--priority", "2",
    ], TEMPLATE_DOLT_PORT)
    bdCreate(alphaDbPath, [
      "--title", "Alpha Task One", "--type", "task", "--priority", "1",
      "--parent", alphaEpicId,
    ], TEMPLATE_DOLT_PORT)
    bdCreate(alphaDbPath, [
      "--title", "Alpha Task Two", "--type", "task", "--priority", "2",
      "--parent", alphaEpicId,
    ], TEMPLATE_DOLT_PORT)

    const betaDbPath = initWorkspace(TEMPLATE_BETA_WS_DIR, "beta")
    const betaEpicId = bdCreate(betaDbPath, [
      "--title", "Beta Epic", "--type", "epic", "--priority", "1",
    ], TEMPLATE_DOLT_PORT)
    bdCreate(betaDbPath, [
      "--title", "Beta Task One", "--type", "task", "--priority", "0",
      "--parent", betaEpicId,
    ], TEMPLATE_DOLT_PORT)
    bdCreate(betaDbPath, [
      "--title", "Beta Task Two", "--type", "task", "--priority", "3",
      "--parent", betaEpicId,
    ], TEMPLATE_DOLT_PORT)
    const gammaDbPath = initWorkspace(TEMPLATE_GAMMA_WS_DIR, "gamma")
    const gammaEpicId = bdCreate(gammaDbPath, [
      "--title", "Gamma Epic", "--type", "epic", "--priority", "3",
    ], TEMPLATE_DOLT_PORT)
    bdCreate(gammaDbPath, [
      "--title", "Gamma Task One", "--type", "task", "--priority", "2",
      "--parent", gammaEpicId,
    ], TEMPLATE_DOLT_PORT)

    // beadbox-r72.4 (check C): one bead in each bd 1.3 name:category status.
    const statusesDbPath = initWorkspace(TEMPLATE_STATUSES_WS_DIR, "st")
    bd(statusesDbPath, ["config", "set", "status.custom", CUSTOM_STATUSES], TEMPLATE_DOLT_PORT)
    for (const status of CUSTOM_STATUSES.split(",").map((s) => s.split(":")[0])) {
      const id = bdCreate(statusesDbPath, ["--title", `Bead in ${status}`, "--type", "task", "--priority", "2"], TEMPLATE_DOLT_PORT)
      bd(statusesDbPath, ["update", id, "--status", status], TEMPLATE_DOLT_PORT)
    }

    seedGatesWorkspace(initWorkspace(TEMPLATE_GATES_WS_DIR, "gw"))

    const moleculesDbPath = initWorkspace(TEMPLATE_MOLECULES_WS_DIR, "mf")
    mkdirSync(join(TEMPLATE_MOLECULES_WS_DIR, ".beads", "formulas"), { recursive: true })
    writeFileSync(join(TEMPLATE_MOLECULES_WS_DIR, ".beads", "formulas", `${NESTED_FORMULA}.formula.toml`), NESTED_FORMULA_TOML)
    bd(moleculesDbPath, ["mol", "pour", NESTED_FORMULA, "--var", "who=bob"], TEMPLATE_DOLT_PORT)
  } finally {
    // 6. Stop the template server. Data persists in TEMPLATE_DATA_DIR.
    stopDoltServer(server)
  }

  // 7. Reset test registries again (bd init may have registered templates)
  // NOTE: gamma database stays in TEMPLATE_DATA_DIR alongside e2e/alpha/beta.
  // Dolt sql-server does not auto-discover databases added to its data directory
  // after startup, so extracting gamma and injecting on-demand would require
  // restarting the server (disproportionate complexity for ~200ms latency savings).
  if (testRegistryPath) {
    writeFileSync(testRegistryPath, "[]")
  }
  if (testBeadboxRegistryPath) {
    writeFileSync(testBeadboxRegistryPath, JSON.stringify({ version: 2, workspaces: [], activeWorkspace: null }))
  }
}
