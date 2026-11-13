// Review (beadbox-dbf): a memoized row that skips a render keeps the props of
// its last render. readState is a whole-board object and every tree load
// installs a fresh one (handleEpicsSuccess -> getReadState() -> JSON.parse),
// so each row pins the generation it last rendered with.
import { afterEach, expect, test } from "bun:test"
import { cleanup, render } from "@testing-library/react"
import { BeadTable } from "../components/bead-table"
import type { Bead, ReadState } from "../lib/types"

afterEach(cleanup)

const N = 20
const bead = (i: number): Bead => ({
  id: `b${i}`,
  title: `Task ${i}`,
  type: "task",
  description: "",
  status: "open",
  priority: "medium",
  assignee: "",
  comments: [],
})
const freshReadState = (): ReadState =>
  Object.fromEntries(
    Array.from({ length: N }, (_, i) => [
      `b${i}`,
      { viewedAt: "2030-01-01T00:00:00.000Z", commentCount: 0 },
    ]),
  )

function runBoard(pick: (load: number) => number = (load) => load) {
  let rows = Array.from({ length: N }, (_, i) => bead(i))
  let readState = freshReadState()
  const generations: WeakRef<ReadState>[] = [new WeakRef(readState)]
  const ui = () => <BeadTable beads={rows} epicId="e" onBeadClick={() => {}} readState={readState} />
  const view = render(ui())
  // N tree loads, each changing one different bead, each with the fresh
  // read-state object a load installs.
  for (let i = 0; i < N; i++) {
    rows = rows.map((b, j) => (j === pick(i) ? { ...b, title: `Edited ${i}` } : { ...b }))
    readState = freshReadState()
    generations.push(new WeakRef(readState))
    view.rerender(ui())
  }
  return { view, generations }
}

test("review: earlier read-state objects are collectable after later loads", async () => {
  const { generations } = runBoard()
  await new Promise((r) => setTimeout(r, 0))
  Bun.gc(true)
  await new Promise((r) => setTimeout(r, 0))
  Bun.gc(true)
  const alive = generations.filter((ref) => ref.deref() !== undefined).length
  // The current one, plus at most the one React's alternate tree still holds.
  expect(alive).toBeLessThanOrEqual(2)
})

// Control for the test above: the same loads, all editing ONE bead. Only that
// row re-renders, so only the first and the newest read states stay
// reachable. Green here shows the collector does clear the WeakRefs, and
// that the 21 above are rows pinning one generation each.
test("control: the same loads on one bead leave earlier read states collectable", async () => {
  const { generations } = runBoard(() => 0)
  await new Promise((r) => setTimeout(r, 0))
  Bun.gc(true)
  await new Promise((r) => setTimeout(r, 0))
  Bun.gc(true)
  const alive = generations.filter((ref) => ref.deref() !== undefined).length
  expect(alive).toBeLessThanOrEqual(3)
})
