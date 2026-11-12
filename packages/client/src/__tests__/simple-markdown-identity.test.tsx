import { afterEach, expect, test } from "bun:test"
import { cleanup, render } from "@testing-library/react"
import { SimpleMarkdown } from "../components/simple-markdown"

afterEach(cleanup)

test("detail markdown preserves mounted elements across unchanged text renders", () => {
  const content = "# Title\n\nA **stable** description.\n\n- [ ] task"
  const view = render(<SimpleMarkdown content={content} />)
  const heading = view.container.querySelector("h1")
  const paragraph = view.container.querySelector("p")
  const checkbox = view.container.querySelector("input")
  view.rerender(<SimpleMarkdown content={content} className="updated-panel-style" />)
  expect(view.container.querySelector("h1")).toBe(heading)
  expect(view.container.querySelector("p")).toBe(paragraph)
  expect(view.container.querySelector("input")).toBe(checkbox)
  view.rerender(<SimpleMarkdown content={"# Updated\n\nChanged description."} />)
  expect(view.container.querySelector("h1")?.textContent).toBe("Updated")
  expect(view.container.querySelector("p")?.textContent).toBe("Changed description.")
})
