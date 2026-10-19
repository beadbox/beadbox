// Fixtures for headless specs (beadbox-r72.3).
//
// A spec imports { test, expect } from here and gets:
//   workspace  (worker) the standard template workspace on this worker's own
//              Dolt server, registered as the active workspace in a synthetic
//              registry; plus bd() to read or write it the way a user would.
//   sidecar    (worker) one real sidecar for the worker (SidecarBridge).
//   page       a page with window.__beadboxTestBridge installed, so the test
//              build's rpc.* reaches that sidecar.
//
// Everything lives under this run's directory and every spawned process gets
// the scratch HOME, so no fixture can touch a real registry or another run.

import { test as base, expect } from "@playwright/test"
import { execFileSync } from "child_process"
import { randomUUID } from "crypto"
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "fs"
import { join, resolve } from "path"
import { TEMPLATE_DATA_DIR, TEMPLATE_WS_DIR } from "../global-setup"
import {
  childEnv,
  findBd,
  findFreePort,
  startDoltServer,
  stopDoltServer,
  waitForTablesReady,
} from "./dolt-server"
import { runPaths } from "./run-paths"
import { SidecarBridge } from "./sidecar-bridge"

const REPO_ROOT = resolve(__dirname, "..", "..")

export interface HarnessWorkspace {
  id: string
  name: string
  /** The project directory (the parent of .beads). */
  projectDir: string
  /** The .beads directory, as the registry stores it. */
  beadsDir: string
  doltPort: number
  registryPath: string
  /** Run bd in this workspace as a user would (scratch HOME, this worker's Dolt). */
  bd: (args: string[]) => string
  /** bd's JSON output, parsed. */
  bdJson: <T = unknown>(args: string[]) => T
}

/** Copy the template workspace into this worker's directory, pointed at its Dolt server. */
function copyWorkspace(dest: string, doltPort: number): string {
  mkdirSync(dest, { recursive: true })
  const beadsDir = join(dest, ".beads")
  cpSync(join(TEMPLATE_WS_DIR, ".beads"), beadsDir, { recursive: true })
  const metaPath = join(beadsDir, "metadata.json")
  const meta = JSON.parse(readFileSync(metaPath, "utf-8"))
  meta.dolt_server_port = doltPort
  writeFileSync(metaPath, JSON.stringify(meta, null, 2))
  writeFileSync(join(beadsDir, "dolt-server.port"), String(doltPort))
  // The fixture owns the Dolt server; bd must not start its own.
  const configPath = join(beadsDir, "config.yaml")
  const config = existsSync(configPath) ? readFileSync(configPath, "utf-8") : ""
  if (!config.includes("auto-start")) writeFileSync(configPath, `${config}\ndolt:\n  auto-start: false\n`)
  return beadsDir
}

type WorkerFixtures = { workspace: HarnessWorkspace; sidecar: SidecarBridge }

export const test = base.extend<object, WorkerFixtures>({
  workspace: [
    async ({}, use, workerInfo) => {
      const dir = runPaths().worker(workerInfo.workerIndex)
      const dataDir = join(dir, "dolt")
      cpSync(TEMPLATE_DATA_DIR, dataDir, { recursive: true })
      const doltPort = findFreePort()
      const server = startDoltServer(doltPort, dataDir, "SELECT 1", { killPortFirst: false })
      try {
        waitForTablesReady(doltPort)
        const projectDir = join(dir, "ws-standard")
        const beadsDir = copyWorkspace(projectDir, doltPort)
        const id = randomUUID()
        const registryPath = join(dir, "registry.json")
        writeFileSync(
          registryPath,
          JSON.stringify({
            version: 2,
            activeWorkspace: id,
            workspaces: [
              {
                id,
                name: "e2e-standard",
                addedAt: new Date().toISOString(),
                local: { path: beadsDir },
                server: null,
                mode: "server",
              },
            ],
          }),
        )
        writeFileSync(join(dir, "legacy-registry.json"), "[]")
        const env = childEnv({ BEADS_DOLT_SERVER_HOST: "127.0.0.1", BEADS_DOLT_SERVER_PORT: String(doltPort) })
        const bd = (args: string[]) =>
          execFileSync(findBd(), args, { cwd: projectDir, env, encoding: "utf-8", timeout: 30_000 })
        await use({
          id,
          name: "e2e-standard",
          projectDir,
          beadsDir,
          doltPort,
          registryPath,
          bd,
          bdJson: <T>(args: string[]) => JSON.parse(bd([...args, "--json"])) as T,
        })
      } finally {
        const pid = server.process.pid
        stopDoltServer(server)
        console.log(`[e2e worker ${workerInfo.workerIndex}] stopped its Dolt server, pid ${pid}`)
      }
    },
    { scope: "worker" },
  ],

  sidecar: [
    async ({ workspace }, use, workerInfo) => {
      const dir = runPaths().worker(workerInfo.workerIndex)
      const bridge = new SidecarBridge({
        repoRoot: REPO_ROOT,
        env: {
          HOME: runPaths().home,
          BEADBOX_REGISTRY_PATH: workspace.registryPath,
          BEADS_REGISTRY_PATH: join(dir, "legacy-registry.json"),
          BEADBOX_LOG_PATH: join(dir, "sidecar.log"),
          BD_PATH: findBd(),
        },
      })
      const pid = await bridge.spawn()
      console.log(`[e2e worker ${workerInfo.workerIndex}] sidecar pid ${pid}: ${bridge.command.join(" ")}`)
      try {
        await use(bridge)
      } finally {
        const killed = bridge.kill()
        console.log(`[e2e worker ${workerInfo.workerIndex}] SIGKILLed its sidecar and descendants: ${killed.join(", ") || "none running"}`)
      }
    },
    { scope: "worker" },
  ],

  page: async ({ page, sidecar }, use) => {
    await sidecar.attach(page)
    await use(page)
  },
})

export { expect }
