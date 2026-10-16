import { expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { BeadCustomFields } from "../components/bead-custom-fields"

test("structured Beads metadata renders as text instead of React children", () => {
  const metadata = {
    legacy_frontmatter: {
      pr: 42,
      hitl: false,
      repo: "example/project",
      blocked_by: ["00.md"],
      assignee: null,
    },
    fog: [{ text: "Confirm rollout", clarifying_ticket: "map-1" }],
    max_workers: 0,
    archived: false,
    stacked_on: null,
    branch: "feat/example",
  }
  const html = renderToStaticMarkup(<BeadCustomFields metadata={metadata} />)
  for (const value of Object.values(metadata)) {
    const text = typeof value === "string" ? value : JSON.stringify(value, null, 2)
    const escaped = text.replaceAll("&", "&amp;").replaceAll('"', "&quot;")
    expect(html).toContain(escaped)
  }
})

test("missing and empty metadata have no custom-fields section", () => {
  expect(renderToStaticMarkup(<BeadCustomFields metadata={undefined} />)).toBe("")
  expect(renderToStaticMarkup(<BeadCustomFields metadata={{}} />)).toBe("")
})

test("strings stay unquoted and React escapes metadata HTML", () => {
  const html = renderToStaticMarkup(
    <BeadCustomFields
      metadata={{ plain: "hello", unsafe: { text: "<script>alert(1)</script>" } }}
    />,
  )
  expect(html).toContain(">hello</span>")
  expect(html).not.toContain("<script>")
  expect(html).toContain("&lt;script&gt;")
})
