// Fixtures for headless specs (beadbox-r72.3).
//
// A spec imports { test, expect } from here and gets:
//   workspace  (worker) the standard template workspace on this worker's own
//              Dolt server, registered as the active workspace in a synthetic
//              registry; plus bd() to read or write it the way a user would.
//   statusesWorkspace (worker) a second registered workspace whose beads sit
//              in bd 1.3 name:category custom statuses (beadbox-r72.4).
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
import { TEMPLATE_DATA_DIR, TEMPLATE_STATUSES_WS_DIR, TEMPLATE_WS_DIR } from "../global-setup"
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

/** Copy a template workspace into this worker's directory, pointed at its Dolt server. */
function copyWorkspace(template: string, dest: string, doltPort: number): string {
  mkdirSync(dest, { recursive: true })
  const beadsDir = join(dest, ".beads")
  cpSync(join(template, ".beads"), beadsDir, { recursive: true })
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

function harnessWorkspace(name: string, projectDir: string, beadsDir: string, doltPort: number, registryPath: string): HarnessWorkspace {
  const env = childEnv({ BEADS_DOLT_SERVER_HOST: "127.0.0.1", BEADS_DOLT_SERVER_PORT: String(doltPort) })
  const bd = (args: string[]) => execFileSync(findBd(), args, { cwd: projectDir, env, encoding: "utf-8", timeout: 30_000 })
  return {
    id: randomUUID(),
    name,
    projectDir,
    beadsDir,
    doltPort,
    registryPath,
    bd,
    bdJson: <T>(args: string[]) => JSON.parse(bd([...args, "--json"])) as T,
  }
}

type WorkerFixtures = {
  workspaces: { standard: HarnessWorkspace; statuses: HarnessWorkspace }
  workspace: HarnessWorkspace
  statusesWorkspace: HarnessWorkspace
  sidecar: SidecarBridge
}

export const test = base.extend<object, WorkerFixtures>({
  workspaces: [
    async ({}, use, workerInfo) => {
      const dir = runPaths().worker(workerInfo.workerIndex)
      const dataDir = join(dir, "dolt")
      cpSync(TEMPLATE_DATA_DIR, dataDir, { recursive: true })
      const doltPort = findFreePort()
      const server = startDoltServer(doltPort, dataDir, "SELECT 1", { killPortFirst: false })
      try {
        waitForTablesReady(doltPort)
        const registryPath = join(dir, "registry.json")
        const make = (name: string, template: string, folder: string) => {
          const projectDir = join(dir, folder)
          return harnessWorkspace(name, projectDir, copyWorkspace(template, projectDir, doltPort), doltPort, registryPath)
        }
        const standard = make("e2e-standard", TEMPLATE_WS_DIR, "ws-standard")
        const statuses = make("e2e-statuses", TEMPLATE_STATUSES_WS_DIR, "ws-statuses")
        writeFileSync(
          registryPath,
          JSON.stringify({
            version: 2,
            activeWorkspace: standard.id,
            workspaces: [standard, statuses].map((w) => ({
              id: w.id,
              name: w.name,
              addedAt: new Date().toISOString(),
              local: { path: w.beadsDir },
              server: null,
              mode: "server",
            })),
          }),
        )
        writeFileSync(join(dir, "legacy-registry.json"), "[]")
        await use({ standard, statuses })
      } finally {
        const pid = server.process.pid
        stopDoltServer(server)
        console.log(`[e2e worker ${workerInfo.workerIndex}] stopped its Dolt server, pid ${pid}`)
      }
    },
    { scope: "worker" },
  ],

  workspace: [async ({ workspaces }, use) => use(workspaces.standard), { scope: "worker" }],
  statusesWorkspace: [async ({ workspaces }, use) => use(workspaces.statuses), { scope: "worker" }],

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
