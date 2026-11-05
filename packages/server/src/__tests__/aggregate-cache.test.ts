import { afterEach, expect, test } from "bun:test"
import {
  getCachedBeadDetail,
  getCachedEpics,
  invalidateEpicCache,
  setCachedBeadDetail,
  setCachedEpics,
} from "../lib/epic-cache"
import type { Epic } from "../lib/types"

afterEach(invalidateEpicCache)
const epic = (title: string): Epic => ({
  id: "same-id",
  title,
  type: "epic",
  description: "",
  status: "open",
  priority: "medium",
  assignee: "",
  comments: [],
  children: [],
  childEpics: [],
  updatedAt: new Date("2026-01-01"),
})

test("identical IDs and timestamps cannot mix details, even with interleaved responses", () => {
  const a = epic("Project A")
  const b = epic("Project B")
  setCachedEpics("a1", "/a", [a])
  setCachedEpics("b1", "/b", [b])
  // A's slow detail finishes after B's tree.
  setCachedBeadDetail(a, "/a")
  setCachedBeadDetail(b, "/b")
  expect(getCachedBeadDetail(a.id, "/a")?.title).toBe("Project A")
  expect(getCachedBeadDetail(b.id, "/b")?.title).toBe("Project B")
  expect(getCachedEpics("a1", "/a")?.[0].title).toBe("Project A")
  setCachedEpics("a2", "/a", [{ ...a, labels: ["new"] }])
  expect(getCachedBeadDetail(a.id, "/a")).toBeNull()
  expect(getCachedBeadDetail(b.id, "/b")?.title).toBe("Project B")
  invalidateEpicCache()
  expect(getCachedEpics("b1", "/b")).toBeNull()
})
