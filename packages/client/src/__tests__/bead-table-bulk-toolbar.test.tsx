// bb-y729: bead-table-bulk-toolbar — RTL render contract.
//
// Verifies count display, archive button wiring, hidden state, pending lock,
// and (beadbox-id1, GH #59) the Status menu: its items, the pick, and the
// keyboard path (Enter or Space opens, arrows move, Escape closes, no write).
// userEvent.setup({ delay: null }) per bb-w4ee — Linux runner stalls on the
// default 0ms keystroke chain.

import { afterEach, describe, expect, mock, test } from "bun:test"
import { cleanup, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { BeadTableBulkToolbar } from "../components/bead-table-bulk-toolbar"

afterEach(cleanup)

const userInstance = () => userEvent.setup({ delay: null })

const STATUSES = ["open", "in_progress", "blocked", "closed", "ticket_awaiting", "unit_escalated"]
const statusProps = () => ({
  availableStatuses: STATUSES,
  onBulkStatus: mock((_status: string) => {}),
})

describe("BeadTableBulkToolbar (bb-y729)", () => {
  test("renders nothing when 0 selected", () => {
    const { container } = render(
      <BeadTableBulkToolbar
        selectedCount={0}
        onBulkArchive={mock(() => Promise.resolve())}
        onClear={mock(() => {})}
        {...statusProps()}
      />,
    )
    expect(container.firstChild).toBeNull()
  })

  test("shows '1 selected' for single", () => {
    render(
      <BeadTableBulkToolbar
        selectedCount={1}
        onBulkArchive={mock(() => Promise.resolve())}
        onClear={mock(() => {})}
        {...statusProps()}
      />,
    )
    expect(screen.getByText("1 selected")).toBeTruthy()
  })

  test("shows 'N selected' for multiple", () => {
    render(
      <BeadTableBulkToolbar
        selectedCount={5}
        onBulkArchive={mock(() => Promise.resolve())}
        onClear={mock(() => {})}
        {...statusProps()}
      />,
    )
    expect(screen.getByText("5 selected")).toBeTruthy()
  })

  test("clicking Archive invokes onBulkArchive", async () => {
    const onBulkArchive = mock(() => Promise.resolve())
    const user = userInstance()
    render(
      <BeadTableBulkToolbar
        selectedCount={3}
        onBulkArchive={onBulkArchive}
        onClear={mock(() => {})}
        {...statusProps()}
      />,
    )
    await user.click(screen.getByRole("button", { name: /archive selected/i }))
    expect(onBulkArchive).toHaveBeenCalledTimes(1)
  })

  test("clicking Cancel invokes onClear", async () => {
    const onClear = mock(() => {})
    const user = userInstance()
    render(
      <BeadTableBulkToolbar
        selectedCount={2}
        onBulkArchive={mock(() => Promise.resolve())}
        onClear={onClear}
        {...statusProps()}
      />,
    )
    await user.click(screen.getByRole("button", { name: /clear selection/i }))
    expect(onClear).toHaveBeenCalledTimes(1)
  })

  test("disables Archive button when isPending", () => {
    render(
      <BeadTableBulkToolbar
        selectedCount={2}
        onBulkArchive={mock(() => Promise.resolve())}
        onClear={mock(() => {})}
        {...statusProps()}
        isPending
      />,
    )
    const btn = screen.getByRole("button", { name: /archive selected/i }) as HTMLButtonElement
    expect(btn.disabled).toBe(true)
  })

  test("disables the Status control when isPending", () => {
    render(
      <BeadTableBulkToolbar
        selectedCount={2}
        onBulkArchive={mock(() => Promise.resolve())}
        onClear={mock(() => {})}
        {...statusProps()}
        isPending
      />,
    )
    const btn = screen.getByRole("button", { name: /set status of selected/i }) as HTMLButtonElement
    expect(btn.disabled).toBe(true)
  })
})

describe("BeadTableBulkToolbar Status menu (beadbox-id1)", () => {
  function renderToolbar() {
    const props = statusProps()
    render(
      <BeadTableBulkToolbar
        selectedCount={3}
        onBulkArchive={mock(() => Promise.resolve())}
        onClear={mock(() => {})}
        {...props}
      />,
    )
    return props.onBulkStatus
  }

  test("a Status control sits beside Archive", () => {
    renderToolbar()
    const buttons = screen.getAllByRole("button").map((b) => b.getAttribute("aria-label"))
    const status = buttons.indexOf("Set status of selected")
    expect(status).toBeGreaterThanOrEqual(0)
    expect(buttons[status + 1]).toBe("Archive selected")
  })

  test("the menu lists exactly the statuses given, by display name", async () => {
    renderToolbar()
    await userInstance().click(screen.getByRole("button", { name: /set status of selected/i }))
    const items = await screen.findAllByRole("menuitem")
    expect(items.map((i) => i.textContent)).toEqual([
      "Open",
      "In Progress",
      "Blocked",
      "Closed",
      "Ticket Awaiting",
      "Unit Escalated",
    ])
  })

  test("picking a status calls onBulkStatus with its name", async () => {
    const onBulkStatus = renderToolbar()
    const user = userInstance()
    await user.click(screen.getByRole("button", { name: /set status of selected/i }))
    await user.click(await screen.findByRole("menuitem", { name: "Unit Escalated" }))
    expect(onBulkStatus).toHaveBeenCalledTimes(1)
    expect(onBulkStatus).toHaveBeenCalledWith("unit_escalated")
  })

  test("keyboard: Enter opens, arrows move, Enter picks", async () => {
    const onBulkStatus = renderToolbar()
    const user = userInstance()
    screen.getByRole("button", { name: /set status of selected/i }).focus()
    await user.keyboard("{Enter}")
    // Opened from the keyboard, the menu focuses its first item once mounted.
    await waitFor(() => expect(document.activeElement?.textContent).toBe("Open"))
    await user.keyboard("{ArrowDown}")
    expect(document.activeElement?.textContent).toBe("In Progress")
    await user.keyboard("{Enter}")
    expect(onBulkStatus).toHaveBeenCalledTimes(1)
    expect(onBulkStatus).toHaveBeenCalledWith("in_progress")
  })

  test("keyboard: Space opens; Escape closes with no write", async () => {
    const onBulkStatus = renderToolbar()
    const user = userInstance()
    screen.getByRole("button", { name: /set status of selected/i }).focus()
    await user.keyboard(" ")
    await waitFor(() => expect(document.activeElement?.textContent).toBe("Open"))
    await user.keyboard("{ArrowDown}{Escape}")
    expect(screen.queryAllByRole("menuitem")).toHaveLength(0)
    expect(onBulkStatus).not.toHaveBeenCalled()
  })
})
