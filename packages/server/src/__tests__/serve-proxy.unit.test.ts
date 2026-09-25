// The attributed proxy reap (sec's R1-R3, beadbox-6x2), as pure decisions
// over a process-table snapshot. Every "leave it" rule has a case.

import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  argValue,
  bdSubcommand,
  findOurProxy,
  findServePid,
  liveServeRoots,
  type ProcRow,
  type ProxyRecord,
  parsePs,
  proxyReapDecision,
} from "../lib/serve-proxy"

let tmp = ""
afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true })
  tmp = ""
})

function workspace(name: string): { ws: string; root: string } {
  const ws = join(tmp, name)
  mkdirSync(join(ws, ".beads", "dolt"), { recursive: true })
  return { ws, root: realpathSync(join(ws, ".beads", "dolt")) }
}

const START = "Fri Sep 25 15:13:48 2026"
const UID = 501
const row = (p: Partial<ProcRow> & { pid: number; command: string }): ProcRow => ({ ppid: 1, uid: UID, start: START, ...p })

describe("parsing and argv helpers", () => {
  test("ps lines with lstart parse into rows", () => {
    const rows = parsePs(
      "  200   100   501 Fri Sep 25 15:13:48 2026     /x/bd db-proxy-child --root /a/.beads/dolt --port 0\n" +
        "  100    99   501 Fri Sep  5 09:01:02 2026     /bin/sh /t/bin/bd serve --addr 127.0.0.1:0\n" +
        "garbage line\n",
    )
    expect(rows).toEqual([
      { pid: 200, ppid: 100, uid: 501, start: "Fri Sep 25 15:13:48 2026", command: "/x/bd db-proxy-child --root /a/.beads/dolt --port 0" },
      { pid: 100, ppid: 99, uid: 501, start: "Fri Sep 5 09:01:02 2026", command: "/bin/sh /t/bin/bd serve --addr 127.0.0.1:0" },
    ])
  })
  test("the bd subcommand is found after the token named bd, for real bd and a script-run bd", () => {
    expect(bdSubcommand("/opt/homebrew/bin/bd serve --addr 127.0.0.1:0")).toBe("serve")
    expect(bdSubcommand("/bin/sh /t/bin/bd db-proxy-child --root /r")).toBe("db-proxy-child")
    expect(bdSubcommand("/usr/bin/python3 fake.py serve")).toBeNull()
    expect(argValue("bd db-proxy-child --root /r --port 0", "--root")).toBe("/r")
    expect(argValue("bd serve --db=/x/.beads", "--db")).toBe("/x/.beads")
  })
})

describe("R1: only the proxy whose parent is OUR bd serve is recorded", () => {
  test("found by parentage and root; a proxy with another parent (user-started, or another serve's) is not", () => {
    tmp = mkdtempSync(join(tmpdir(), "beadbox-proxy-unit-"))
    const { root } = workspace("ws")
    const rows = [
      row({ pid: 100, ppid: 99, command: "/t/bin/bd serve --addr 127.0.0.1:0" }), // our serve (wrapper 99)
      row({ pid: 200, ppid: 100, command: `/t/bin/bd db-proxy-child --root ${root} --port 0` }),
      row({ pid: 300, ppid: 1, command: `/t/bin/bd db-proxy-child --root ${root} --port 0` }), // user-started
    ]
    expect(findServePid(rows, 99)).toBe(100)
    expect(findOurProxy(rows, 100, root)).toEqual({ pid: 200, start: START, command: rows[1].command, root })
    expect(findOurProxy(rows.filter((r) => r.pid !== 200), 100, root)).toBeNull() // only the user's remains
    expect(findOurProxy(rows, 100, "/some/other/.beads/dolt")).toBeNull() // different root
  })
})

describe("R2 + R3: the reap decision", () => {
  const setup = () => {
    tmp = mkdtempSync(join(tmpdir(), "beadbox-proxy-unit-"))
    const a = workspace("a")
    const b = workspace("b")
    const cmd = `/t/bin/bd db-proxy-child --root ${a.root} --port 0`
    const rec: ProxyRecord = { pid: 200, start: START, command: cmd, root: a.root }
    return { a, b, rec, proxy: row({ pid: 200, command: cmd }) }
  }

  test("our recorded proxy, nothing else serving the root: reap", () => {
    const { rec, proxy } = setup()
    expect(proxyReapDecision(rec, [proxy], UID, [])).toEqual({ reap: true })
  })
  test("gone: leave", () => {
    const { rec } = setup()
    expect(proxyReapDecision(rec, [], UID, [])).toMatchObject({ reap: false, reason: "gone" })
  })
  test("another user's process: leave", () => {
    const { rec, proxy } = setup()
    expect(proxyReapDecision(rec, [{ ...proxy, uid: UID + 1 }], UID, [])).toMatchObject({ reap: false })
  })
  test("the pid was reused (a different start time, or a different command): leave", () => {
    const { rec, proxy } = setup()
    expect(proxyReapDecision(rec, [{ ...proxy, start: "Fri Sep 25 16:00:00 2026" }], UID, [])).toMatchObject({
      reap: false,
      reason: "pid reused by another process",
    })
    expect(proxyReapDecision(rec, [{ ...proxy, command: "/usr/bin/vim notes.txt" }], UID, [])).toMatchObject({ reap: false })
  })
  test("a record whose root is not this workspace's: leave", () => {
    const { b, rec, proxy } = setup()
    const other = `/t/bin/bd db-proxy-child --root ${b.root} --port 0`
    expect(proxyReapDecision({ ...rec, command: other }, [{ ...proxy, command: other }], UID, [])).toMatchObject({
      reap: false,
      reason: "not this workspace's proxy",
    })
  })
  test("a live bd serve on the same root (another instance, or the user's): leave", () => {
    const { a, rec, proxy } = setup()
    expect(proxyReapDecision(rec, [proxy], UID, [a.root])).toMatchObject({ reap: false, reason: "a live bd serve still uses this root" })
  })
  test("a live bd serve whose root cannot be told: leave (fail safe)", () => {
    const { rec, proxy } = setup()
    expect(proxyReapDecision(rec, [proxy], UID, [null])).toMatchObject({ reap: false })
  })
  test("a live bd serve on a DIFFERENT root does not block the reap", () => {
    const { b, rec, proxy } = setup()
    expect(proxyReapDecision(rec, [proxy], UID, [b.root])).toEqual({ reap: true })
  })
})

describe("R3: finding what each live bd serve serves", () => {
  test("from its working directory, walking up to .beads; -C overrides; --db is unknown", () => {
    tmp = mkdtempSync(join(tmpdir(), "beadbox-proxy-unit-"))
    const a = workspace("a")
    const b = workspace("b")
    mkdirSync(join(a.ws, "sub", "deep"), { recursive: true })
    const rows = [
      row({ pid: 1, command: "/x/bd serve --addr 127.0.0.1:0" }),
      row({ pid: 2, command: `/x/bd serve -C ${b.ws}` }),
      row({ pid: 3, command: "/x/bd serve --db=/elsewhere/.beads" }),
      row({ pid: 4, command: "/x/bd list --json" }), // not a serve
      row({ pid: 5, command: "/x/bd serve" }), // cwd unreadable
    ]
    const cwd: Record<number, string> = { 1: join(a.ws, "sub", "deep"), 2: "/" }
    expect(liveServeRoots(rows, (pid) => cwd[pid] ?? null)).toEqual([a.root, b.root, null, null])
  })
})
