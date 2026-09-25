import { afterEach, describe, expect, test } from "bun:test"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { EditableMarkdownField } from "../components/editable-markdown-field"

afterEach(cleanup)

describe("EditableMarkdownField", () => {
  test("opens an empty field and submits its draft", async () => {
    let saved = ""
    render(
      <EditableMarkdownField
        label="Acceptance Criteria"
        value=""
        isSaving={false}
        onSave={async (value) => {
          saved = value
          return true
        }}
      />,
    )
    fireEvent.click(screen.getByRole("button", { name: "Edit Acceptance Criteria" }))
    fireEvent.change(screen.getByRole("textbox", { name: "Acceptance Criteria" }), {
      target: { value: "Must pass" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Save" }))
    await waitFor(() => expect(saved).toBe("Must pass"))
    await waitFor(() =>
      expect(screen.queryByRole("textbox", { name: "Acceptance Criteria" })).toBeNull(),
    )
  })

  test("keeps the draft open when saving fails", async () => {
    render(
      <EditableMarkdownField
        label="Notes"
        value="old"
        isSaving={false}
        onSave={async () => false}
      />,
    )
    fireEvent.click(screen.getByRole("button", { name: "Edit Notes" }))
    fireEvent.change(screen.getByRole("textbox", { name: "Notes" }), { target: { value: "new" } })
    fireEvent.click(screen.getByRole("button", { name: "Save" }))
    await waitFor(() =>
      expect((screen.getByRole("textbox", { name: "Notes" }) as HTMLTextAreaElement).value).toBe(
        "new",
      ),
    )
  })
})
