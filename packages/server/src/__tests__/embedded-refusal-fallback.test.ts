// beadbox-5wk: an embedded store whose metadata.json has NO dolt_mode, next
// to a stale dolt-server.port and a registry entry saying server. The mode
// oracle (dr6) has nothing explicit to go on and answers "server", so the poll
// loop runs `bd sql`, which bd refuses on an embedded store. That used to be
// retried forever. Now one refusal ends the server attempt, the detector falls
// back to embedded detection, and it says so once.
//
// Scope, as real bd behaves (bd 1.2.2, captured below and by QA):
// - COVERED: a stale port file and/or a NON-external registry entry. The poll
//   bd gets at most BEADS_DOLT_SERVER_PORT, opens the store on disk, sees it
//   is embedded and refuses. That refusal is what the loop matches.
// - NOT COVERED (out of scope by ruling; the product question is open): an
//   EXTERNAL registry entry. The sidecar hands the poll bd that entry's
//   BEADS_DOLT_SERVER_* env, so bd dials the registered server and, with
//   nothing listening, reports a connection error. That is never a refusal,
//   so there is no fallback; the loop keeps polling and its paused path
//   (polling_error after three failures) carries it.
//
// The fake bd follows real bd on exactly that point (refusal without server
// env, connection error with it) and logs the env it got, so each case also
// checks its own premise. The last block runs the real binary when present.
//
// Synthetic workspace, synthetic registry, fake bd (BD_PATH).

import { afterAll, afterEach, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import { execFileSync, spawn, spawnSync } from "node:child_process"
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
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

/**
 * An embedded store with NO dolt_mode and a stale port file, registered as
 * mode=server. "managed" is the covered shape (a non-external entry, as in
 * the reported case); "external" adds a server block the sidecar dials.
 */
async function fixture(
  name: string,
  entry: "managed" | "external",
): Promise<{ beads: string; manifest: string; envLog: string }> {
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
          server:
            entry === "external"
              ? { host: "127.0.0.1", port: 3307, database: "bb", user: "root" }
              : null,
          mode: "server",
          serverOwnership: entry,
        },
      ],
    }),
  )
  // Real bd's two answers on this store (bd 1.2.2): with no server env it
  // opens the store on disk and refuses; with BEADS_DOLT_SERVER_HOST it dials
  // that server instead.
  const envLog = join(root, `${name}-env.log`)
  const fakeBd = join(root, `bd-${name}`)
  await writeFile(
    fakeBd,
    `#!/bin/sh
case " $* " in *" sql "*)
  echo "host=$BEADS_DOLT_SERVER_HOST mode=$BEADS_DOLT_SERVER_MODE" >> "${envLog}"
  if [ -n "$BEADS_DOLT_SERVER_HOST" ]; then
    echo "Error: failed to open database: Dolt server unreachable at $BEADS_DOLT_SERVER_HOST:$BEADS_DOLT_SERVER_PORT: connect: connection refused" >&2
  else
    echo "Error: 'bd sql' is not yet supported in embedded mode" >&2
  fi
  exit 1 ;;
esac
echo '[]'
`,
    { mode: 0o700 },
  )
  process.env.BD_PATH = fakeBd
  resetPathCaches()
  return { beads, manifest, envLog }
}

async function sqlEnvs(envLog: string): Promise<string[]> {
  try {
    return (await readFile(envLog, "utf8")).split("\n").filter(Boolean)
  } catch {
    return []
  }
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
  test("stale port file + non-external entry: refused once -> logged once, no respawn, a write is delivered, the oracle now says embedded", async () => {
    const { beads, manifest, envLog } = await fixture("refuse", "managed")
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
    // The premise real bd needs to refuse: the poll bd got no server to dial.
    // Refused once and never retried. (polling_error needs three failed polls;
    // the loop writes it straight to the inherited stderr, the wire, so it
    // never reaches this callback and cannot be asserted absent here.)
    const envs = await sqlEnvs(envLog)
    expect(envs).toHaveLength(1)
    expect(envs[0].startsWith("host= ")).toBe(true)
    expect(lines.filter((l) => l.includes("falling back to embedded")).length).toBe(1)
    expect(events.some((e) => e.type === "change" && e.trigger !== "initial")).toBe(true)
    expect(metadata.resolveDoltMode(dbPath)).toBe("embedded")
  })

  test("an EXTERNAL entry is not covered (out of scope by ruling): bd dials the registered server, no fallback, the paused path carries it", async () => {
    const { beads, envLog } = await fixture("external", "external")
    overrides.pollTimeoutS = 2
    overrides.respawnBaseMs = 100
    const id = `5wk-external-${process.pid}`
    const dbPath = join(beads, "beads.db")
    const events: SubscriptionEvent[] = []
    const { lines } = await captureStderr(async (lines) => {
      const d = await detector.createChangeDetector(dbPath, (e) => events.push(e), id)
      try {
        // Three failed polls (5s apart) is where the loop emits polling_error,
        // the paused path. It writes that straight to the inherited stderr (the
        // wire), so it is asserted at the loop level (poll-child-resilience);
        // here: the loop is still polling after three failures, not fallen back.
        const deadline = Date.now() + 25_000
        while (Date.now() < deadline && (await sqlEnvs(envLog)).length < 3) {
          await new Promise((r) => setTimeout(r, 200))
        }
        expect(loopShells(id)).toBeGreaterThanOrEqual(1)
      } finally {
        await d.stop()
      }
      return lines
    })
    // The sidecar handed bd the entry's server, so bd never looks at the store on disk.
    const envs = await sqlEnvs(envLog)
    expect(envs.length).toBeGreaterThanOrEqual(3)
    expect(envs.every((e) => e === "host=127.0.0.1 mode=1")).toBe(true)
    expect(lines.some((l) => l.includes("falling back to embedded"))).toBe(false)
    expect(metadata.resolveDoltMode(dbPath)).toBe("server")
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
    const prefix = `beadbox-poll-${child.pid}.`
    try {
      // Let at least one full poll (and its check) complete.
      await new Promise((r) => setTimeout(r, 2_500))
      const files = readdirSync(tmpdir()).filter((n) => n.startsWith(prefix))
      expect(files).toHaveLength(1)
      const file = join(tmpdir(), files[0])
      expect(existsSync(file)).toBe(true)
      expect(statSync(file).mode & 0o077).toBe(0)
      expect(readFileSync(file, "utf8")).not.toContain("S3cret-5wk-probe")
    } finally {
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL")
      } catch {
        /* gone */
      }
      if (child.pid) detector.removePollStderrFiles(child.pid)
    }
  })

  test("a file planted at the loop's pid-named path is never opened (a shared /tmp)", async () => {
    const tmp = await mkdtemp(join(root, "tmp-"))
    const beads = join(root, "plant", ".beads")
    await mkdir(beads, { recursive: true })
    await writeFile(join(beads, "metadata.json"), "{}")
    const victim = join(root, "victim")
    await writeFile(victim, "victim-content")
    const fakeBd = join(root, "bd-plant")
    await writeFile(fakeBd, `#!/bin/sh\necho "password is S3cret-5wk-probe" >&2\nexit 1\n`, {
      mode: 0o700,
    })
    const args = (detector.buildPollShellArgs as (...a: unknown[]) => string[])(
      "5wk-plant",
      join(beads, "beads.db"),
      fakeBd,
      2,
      "",
      beads,
    )
    // exec keeps the pid, so the loop's $$ is this wrapper's: plant a symlink
    // at beadbox-poll-<that pid> first, the way another local user could in /tmp.
    const child = spawn(
      "/bin/sh",
      ["-c", 'ln -s "$VICTIM" "$TMPDIR/beadbox-poll-$$" && exec /bin/sh "$@"', "plant", ...args],
      {
        env: { ...process.env, TMPDIR: tmp, VICTIM: victim },
        stdio: ["pipe", "ignore", "ignore"],
        detached: true,
      },
    )
    try {
      await new Promise((r) => setTimeout(r, 2_500))
      expect(readFileSync(victim, "utf8")).toBe("victim-content")
    } finally {
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL")
      } catch {
        /* gone */
      }
      await rm(tmp, { recursive: true, force: true })
    }
  })
})

// The loop's classifier is a grep (change-detector.ts, buildPollShellArgs:
// `grep -qi "supported in embedded mode"`). Pin it against the REAL binary on
// a real embedded store, in both env shapes the sidecar gives the poll bd.
let realBd: string | null = null
try {
  realBd = execFileSync("/bin/sh", ["-c", "command -v bd"], { encoding: "utf-8" }).trim() || null
} catch {
  realBd = null
}
/** The ambient env minus git's hook vars and any BEADS_* (both would steer bd). */
function cleanEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(process.env))
    if (!k.startsWith("GIT_") && !k.startsWith("BEADS_")) env[k] = v
  return env
}

describe.skipIf(!realBd)(
  "real bd: what the poll's bd sql says on an embedded store with no dolt_mode",
  () => {
    let proj: string
    const REFUSAL = /supported in embedded mode/i

    beforeAll(async () => {
      proj = join(root, "real")
      await mkdir(proj, { recursive: true })
      execFileSync("git", ["init", "-q"], { cwd: proj, env: cleanEnv() })
      execFileSync(realBd as string, ["init", "--quiet", "--non-interactive", "--prefix", "rb"], {
        cwd: proj,
        env: cleanEnv(),
        stdio: "ignore",
        timeout: 60_000,
      })
      const metaPath = join(proj, ".beads", "metadata.json")
      const meta = JSON.parse(readFileSync(metaPath, "utf-8"))
      delete meta.dolt_mode
      await writeFile(metaPath, JSON.stringify(meta))
      await writeFile(join(proj, ".beads", "dolt-server.port"), "58625")
    })

    const sql = (env: Record<string, string>) =>
      spawnSync(
        realBd as string,
        ["sql", "SELECT 1", "--db", join(proj, ".beads"), "--json", "--quiet", "--readonly"],
        { cwd: proj, env: { ...cleanEnv(), ...env }, encoding: "utf-8", timeout: 30_000 },
      )

    test("the covered shape (only BEADS_DOLT_SERVER_PORT): the refusal the loop matches", () => {
      const r = sql({ BEADS_DOLT_SERVER_PORT: "58625" })
      expect(r.status).not.toBe(0)
      expect(r.stderr).toMatch(REFUSAL)
    })

    test("the external shape (the entry's BEADS_DOLT_SERVER_*): a connection error, never the refusal", () => {
      const r = sql({
        BEADS_DOLT_SERVER_HOST: "127.0.0.1",
        BEADS_DOLT_SERVER_PORT: "1", // nothing listens on port 1
        BEADS_DOLT_SERVER_DATABASE: "rb",
        BEADS_DOLT_SERVER_USER: "root",
        BEADS_DOLT_AUTO_START: "0",
        BEADS_DOLT_SERVER_MODE: "1",
      })
      expect(r.status).not.toBe(0)
      expect(r.stderr).not.toMatch(REFUSAL)
    })
  },
)
