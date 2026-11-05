import { expect, test } from "bun:test"
import {
  BACKOFF_BASE_MS,
  BACKOFF_MAX_MS,
  dueSources,
  mergeRegistry,
  nextBackoff,
  type ProjectSnapshot,
  projectBeadKey,
  readProjects,
} from "../lib/aggregate"
import type { WorkspaceCard } from "../lib/types"

test("identity is an unambiguous pair", () => {
  expect(projectBeadKey("a", "same")).not.toBe(projectBeadKey("b", "same"))
  expect(projectBeadKey("a/b", "c")).not.toBe(projectBeadKey("a", "b/c"))
})

test("loading is bounded and cancellation stops queued sources", async () => {
  let active = 0
  let peak = 0
  let cancelled = false
  const read: number[] = []
  await readProjects(
    [1, 2, 3, 4, 5],
    async (item) => {
      active++
      peak = Math.max(peak, active)
      read.push(item)
      await new Promise((resolve) => setTimeout(resolve, 5))
      cancelled = true
      active--
    },
    () => cancelled,
  )
  expect(peak).toBe(2)
  expect(read).toEqual([1, 2])
})

const card = (id: string, databasePath: string) =>
  ({ id, name: id, mode: "embedded", path: null, databasePath }) as WorkspaceCard

test("a registry refresh keeps the sidecar's spelling of the same database", () => {
  const resolved: ProjectSnapshot = {
    workspace: card("a", "/p/.beads/beads.db"),
    epics: [],
    registryPath: "/p/.beads",
  }
  const [kept] = mergeRegistry([resolved], [card("a", "/p/.beads")])
  expect(kept.workspace.databasePath).toBe("/p/.beads/beads.db")
  expect(kept.registryPath).toBe("/p/.beads")
})

test("a registry refresh takes the new card when the database moved or was never read", () => {
  const resolved: ProjectSnapshot = {
    workspace: card("a", "/p/.beads/beads.db"),
    epics: [],
    registryPath: "/p/.beads",
  }
  const [moved] = mergeRegistry([resolved], [card("a", "/q/.beads")])
  expect(moved.workspace.databasePath).toBe("/q/.beads")
  expect(moved.registryPath).toBeUndefined()
  const [fresh] = mergeRegistry([], [card("b", "/b/.beads")])
  expect(fresh).toEqual({ workspace: card("b", "/b/.beads"), epics: [] })
})

test("failed sources back off, doubling to a cap, and go after healthy ones", () => {
  const first = nextBackoff(undefined, 1_000)
  expect(first).toEqual({ failures: 1, retryAt: 1_000 + BACKOFF_BASE_MS })
  const second = nextBackoff(first, 2_000)
  expect(second.retryAt).toBe(2_000 + 2 * BACKOFF_BASE_MS)
  let state = second
  for (let i = 0; i < 20; i++) state = nextBackoff(state, 0)
  expect(state.retryAt).toBe(BACKOFF_MAX_MS)

  const items = [{ id: "down" }, { id: "up" }, { id: "due" }]
  const backoff = new Map([
    ["down", { failures: 3, retryAt: 10_000 }],
    ["due", { failures: 1, retryAt: 4_000 }],
  ])
  expect(dueSources(items, backoff, 5_000, false).map((i) => i.id)).toEqual(["up", "due"])
  expect(dueSources(items, backoff, 5_000, true).map((i) => i.id)).toEqual(["up", "down", "due"])
})
