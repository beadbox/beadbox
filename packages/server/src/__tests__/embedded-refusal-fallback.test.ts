// beadbox-5wk: an embedded store whose metadata.json has NO dolt_mode, next
// to a stale dolt-server.port and a registry entry saying server. The mode
// oracle (dr6) has nothing explicit to go on and answers "server", so the poll
// loop runs `bd sql`, which bd refuses on an embedded store. That used to be
// retried forever. Now one refusal ends the server attempt, the detector falls
// back to embedded detection, and it says so once.
//
// Synthetic workspace, synthetic registry, fake bd (BD_PATH).

import { afterAll, afterEach, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import { spawn } from "node:child_process"
import { rmSync, statSync, readFileSync, existsSync } from "node:fs"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { resetPathCaches } from "../lib/bd-paths"
import * as detector from "../lib/change-detector"
import * as metadata from "../lib/dolt-metadata"
import type { SubscriptionEvent } from "../subscribe-protocol"

setDefaultTimeout(40_000)

const saved = { bd: process.env.BD_PATH, registry: process.env.BEADBOX_REGISTRY_PATH }
const overrides = detector._testOverrides as Record<string, number | null>
let root: string

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "beadbox-5wk-"))
  process.env.BEADBOX_REGISTRY_PATH = join(root, "registry.json")
})

afterEach(() => {
  for (const k of ["embeddedDebounceMs", "pollIntervalMs", "pollTimeoutS", "respawnBaseMs"])
    overrides[k] = null
})

afterAll(async () => {
  if (saved.bd === undefined) delete process.env.BD_PATH
  else process.env.BD_PATH = saved.bd
  if (saved.registry === undefined) delete process.env.BEADBOX_REGISTRY_PATH
  else process.env.BEADBOX_REGISTRY_PATH = saved.registry
  resetPathCaches()
  await rm(root, { recursive: true, force: true })
})

/** An embedded store with NO dolt_mode, a stale port file and a registry entry saying server. */
async function fixture(
  name: string,
  bdSql: "refuse" | "fail",
): Promise<{ beads: string; manifest: string }> {
  const beads = join(root, name, ".beads")
  const manifest = join(beads, "embeddeddolt", "beadbox", ".dolt", "noms", "manifest")
  await mkdir(join(manifest, ".."), { recursive: true })
  await writeFile(manifest, "5:__DOLT__:root-before")
  await writeFile(
    join(beads, "metadata.json"),
    JSON.stringify({ backend: "dolt", dolt_database: "beadbox" }),
  )
  await writeFile(join(beads, "dolt-server.port"), "58625")
  await writeFile(
    process.env.BEADBOX_REGISTRY_PATH as string,
    JSON.stringify({
      version: 2,
      activeWorkspace: null,
      workspaces: [
        {
          id: `5wk-${name}`,
          name,
          addedAt: "2026-05-01T00:00:00Z",
          local: { path: beads },
          server: { host: "127.0.0.1", port: 3307, database: "bb", user: "root" },
          mode: "server",
          serverOwnership: "external",
        },
      ],
    }),
  )
  const fakeBd = join(root, `bd-${name}`)
  const onSql =
    bdSql === "refuse"
      ? `echo "Error: 'bd sql' is not yet supported in embedded mode" >&2; exit 1`
      : `echo "Error: connection refused" >&2; exit 1`
  await writeFile(fakeBd, `#!/bin/sh\ncase " $* " in *" sql "*) ${onSql} ;; esac\necho '[]'\n`, {
    mode: 0o700,
  })
  process.env.BD_PATH = fakeBd
  resetPathCaches()
  return { beads, manifest }
}

function loopShells(id: string): number {
  const out = Bun.spawnSync(["ps", "-axo", "ppid=,command="]).stdout.toString()
  return out.split("\n").filter((l) => l.trim().startsWith(`${process.pid} `) && l.includes(id))
    .length
}

async function captureStderr<T>(
  fn: (lines: string[]) => Promise<T>,
): Promise<{ result: T; lines: string[] }> {
  const lines: string[] = []
  const write = process.stderr.write.bind(process.stderr)
  process.stderr.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
    lines.push(String(chunk))
    return (write as (...a: unknown[]) => boolean)(chunk, ...rest)
  }) as typeof process.stderr.write
  try {
    return { result: await fn(lines), lines }
  } finally {
    process.stderr.write = write
  }
}

describe("AC7: a bd sql refusal ends the server attempt and falls back to embedded", () => {
  test("refused once -> logged once, no respawn, a write is delivered, the oracle now says embedded", async () => {
    const { beads, manifest } = await fixture("refuse", "refuse")
    overrides.embeddedDebounceMs = 50
    overrides.pollIntervalMs = 200
    overrides.pollTimeoutS = 2
    overrides.respawnBaseMs = 100
    const id = `5wk-refuse-${process.pid}`
    const dbPath = join(beads, "beads.db")
    expect(metadata.resolveDoltMode(dbPath)).toBe("server") // the premise: nothing explicit

    const events: SubscriptionEvent[] = []
    const { lines } = await captureStderr(async (lines) => {
      const d = await detector.createChangeDetector(dbPath, (e) => events.push(e), id)
      try {
        const deadline = Date.now() + 8_000
        while (
          Date.now() < deadline &&
          !lines.some((l) => l.includes("falling back to embedded"))
        ) {
          await new Promise((r) => setTimeout(r, 100))
        }
        // No loop is respawned after the fallback.
        await new Promise((r) => setTimeout(r, 1_500))
        expect(loopShells(id)).toBe(0)
        await writeFile(manifest, "5:__DOLT__:root-after-bd-close")
        const until = Date.now() + 5_000
        while (
          Date.now() < until &&
          !events.some((e) => e.type === "change" && e.trigger !== "initial")
        ) {
          await new Promise((r) => setTimeout(r, 50))
        }
      } finally {
        await d.stop()
      }
      return lines
    })
    expect(lines.filter((l) => l.includes("falling back to embedded")).length).toBe(1)
    expect(events.some((e) => e.type === "change" && e.trigger !== "initial")).toBe(true)
    expect(events.some((e) => e.type === "polling_error")).toBe(false)
    expect(metadata.resolveDoltMode(dbPath)).toBe("embedded")
  })

  test("a generic bd failure is NOT a refusal: no fallback, the loop keeps retrying", async () => {
    const { beads } = await fixture("generic", "fail")
    overrides.pollTimeoutS = 2
    overrides.respawnBaseMs = 100
    const id = `5wk-generic-${process.pid}`
    const { lines } = await captureStderr(async (lines) => {
      const d = await detector.createChangeDetector(join(beads, "beads.db"), () => {}, id)
      try {
        await new Promise((r) => setTimeout(r, 3_000))
        expect(loopShells(id)).toBeGreaterThanOrEqual(1)
      } finally {
        await d.stop()
      }
      return lines
    })
    expect(lines.some((l) => l.includes("falling back to embedded"))).toBe(false)
  })
})

describe("AC6: a registry that disagrees with the resolved mode is warned about once", () => {
  test("registry mode=server, metadata embedded -> exactly one warning", async () => {
    const beads = join(root, "warn", ".beads")
    await mkdir(beads, { recursive: true })
    await writeFile(join(beads, "metadata.json"), JSON.stringify({ dolt_mode: "embedded" }))
    await writeFile(
      process.env.BEADBOX_REGISTRY_PATH as string,
      JSON.stringify({
        version: 2,
        activeWorkspace: null,
        workspaces: [
          {
            id: "5wk-warn",
            name: "warn",
            addedAt: "2026-05-01T00:00:00Z",
            local: { path: beads },
            server: { host: "127.0.0.1", port: 3307, database: "bb", user: "root" },
            mode: "server",
          },
        ],
      }),
    )
    const { lines } = await captureStderr(async () => {
      for (let i = 0; i < 5; i++)
        expect(metadata.resolveDoltMode(join(beads, "beads.db"))).toBe("embedded")
    })
    expect(lines.filter((l) => l.includes("registry says server")).length).toBe(1)
  })
})

describe("the per-poll stderr file never keeps what bd printed (it can carry credentials)", () => {
  test.each([
    "fail",
    "succeed",
  ])("bd %s with a secret on stderr: the file is owner-only and empty", async (outcome) => {
    const beads = join(root, `leak-${outcome}`, ".beads")
    await mkdir(beads, { recursive: true })
    await writeFile(join(beads, "metadata.json"), "{}")
    const fakeBd = join(root, `bd-leak-${outcome}`)
    const tail = outcome === "fail" ? "exit 1" : `echo '[{"issues":"h1"}]'`
    await writeFile(fakeBd, `#!/bin/sh\necho "password is S3cret-5wk-probe" >&2\n${tail}\n`, {
      mode: 0o700,
    })
    const args = (detector.buildPollShellArgs as (...a: unknown[]) => string[])(
      `5wk-leak-${outcome}`,
      join(beads, "beads.db"),
      fakeBd,
      2,
      "",
      beads,
    )
    const child = spawn("/bin/sh", args, { stdio: ["pipe", "ignore", "ignore"], detached: true })
    const file = join(tmpdir(), `beadbox-poll-${child.pid}`)
    try {
      // Let at least one full poll (and its check) complete.
      await new Promise((r) => setTimeout(r, 2_500))
      expect(existsSync(file)).toBe(true)
      expect(statSync(file).mode & 0o077).toBe(0)
      expect(readFileSync(file, "utf8")).not.toContain("S3cret-5wk-probe")
    } finally {
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL")
      } catch {
        /* gone */
      }
      rmSync(file, { force: true })
    }
  })
})
