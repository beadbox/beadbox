import { afterEach, expect, test } from "bun:test"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { BdPathSettings } from "../components/bd-path-settings"
import { queryClient } from "../lib/query-client"
import { _resetRpc, _setRpc, type RemoteApi } from "../lib/rpc"

afterEach(() => {
  cleanup()
  queryClient.clear()
  _resetRpc()
})
function setup(source = "automatic") {
  const calls: (string | null)[] = []
  _setRpc({
    bdSettings: {
      getBdPath: async () => ({
        resolvedPath: source === "environment" ? "/env/bd" : "bd",
        savedPath: null,
        source,
      }),
      setBdPath: async (path: string | null) => {
        calls.push(path)
        if (path === "/missing") throw new Error("Choose an existing regular executable file")
        return { resolvedPath: path ?? "bd", savedPath: path, source: path ? "saved" : "automatic" }
      },
    },
  } as unknown as RemoteApi)
  return calls
}
test("saves a path with spaces and resets to automatic", async () => {
  const calls = setup()
  let retries = 0
  render(<BdPathSettings onSaved={() => { retries++ }} />)
  await screen.findByText("Automatic detection")
  fireEvent.change(screen.getByLabelText("bd executable path"), {
    target: { value: "/tools with spaces/bd" },
  })
  fireEvent.click(screen.getByRole("button", { name: "Save bd path" }))
  await waitFor(() => expect(calls).toEqual(["/tools with spaces/bd"]))
  await waitFor(() =>
    expect(
      (screen.getByRole("button", { name: "Use automatic detection" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false),
  )
  fireEvent.click(screen.getByRole("button", { name: "Use automatic detection" }))
  await waitFor(() => expect(calls).toEqual(["/tools with spaces/bd", null]))
  await waitFor(() => expect(retries).toBe(2))
})
test("shows an env override and validation failures inline", async () => {
  setup("environment")
  render(<BdPathSettings />)
  await screen.findByText(/BD_PATH environment override/)
  expect(screen.getByText("/env/bd")).toBeTruthy()
  fireEvent.change(screen.getByLabelText("bd executable path"), { target: { value: "/missing" } })
  fireEvent.click(screen.getByRole("button", { name: "Save bd path" }))
  expect((await screen.findByRole("alert")).textContent).toContain(
    "Choose an existing regular executable file",
  )
})
