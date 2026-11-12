import { afterEach, expect, test } from "bun:test"
import { act, cleanup, render } from "@testing-library/react"
import { useDevConsole } from "../hooks/use-dev-console"
import { useDevConsoleTaps } from "../hooks/use-dev-console-taps"
import { _getRpcTap } from "../lib/rpc"
import type { BdCommandEvent } from "../lib/console-types"

afterEach(cleanup)
const command = (n: number): BdCommandEvent => ({
  type: "bd_command",
  id: String(n),
  timestamp: n,
  command: "health.getToolVersions",
  args: [],
  dbPath: "/tmp/alpha/.beads",
  durationMs: 1,
  exitCode: 0,
  resultSummary: "ok",
  stderr: null,
  stdout: null,
  source: "app",
})

test("closed console replies retain bounded history without rendering the board", async () => {
  let consoleState!: ReturnType<typeof useDevConsole>
  let renders = 0
  function Board({ dbPath }: { dbPath: string }) {
    renders++
    consoleState = useDevConsole({ dbPath })
    useDevConsoleTaps(consoleState)
    return <div>{consoleState.open ? consoleState.commands.length : "closed"}</div>
  }
  const view = render(<Board dbPath="/tmp/alpha/.beads" />)
  const before = renders
  await act(async () => {
    for (let n = 0; n < 50; n++) _getRpcTap()?.(command(n))
  })
  expect(renders).toBe(before)
  await act(async () => consoleState.toggle())
  expect(consoleState.commands.length).toBe(50)
  await act(async () => consoleState.close())
  const closed = renders
  await act(async () => {
    for (let n = 50; n < 650; n++) _getRpcTap()?.(command(n))
  })
  expect(renders).toBe(closed)
  await act(async () => consoleState.toggle())
  expect(consoleState.commands.length).toBe(500)
  expect(consoleState.commands[0].id).toBe("150")
  view.rerender(<Board dbPath="/tmp/beta/.beads" />)
  expect(consoleState.commands).toEqual([])
})
