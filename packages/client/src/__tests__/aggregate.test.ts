import { expect, test } from "bun:test"
import { projectBeadKey, readProjects } from "../lib/aggregate"

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
