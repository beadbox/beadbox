// The molecule graph tooltip is a string that float-tooltip renders with
// innerHTML (three-render-objects -> float-tooltip `.html(content)`). Bead
// titles, ids and statuses come from bd and must reach the DOM as text.

import { GlobalRegistrator } from "@happy-dom/global-registrator"

if (!(globalThis as { document?: unknown }).document) {
  GlobalRegistrator.register()
}

import { describe, expect, test } from "bun:test"
import { escapeHtml, getNodeLabel } from "../lib/molecule-node-label"
import type { MoleculeNode } from "../lib/types"

const node = (over: Partial<MoleculeNode> = {}): MoleculeNode =>
  ({ id: "bd-1", title: "Step one", status: "open", type: "task", ...over }) as MoleculeNode

function render(html: string): HTMLDivElement {
  const el = document.createElement("div")
  el.innerHTML = html
  return el
}

describe("escapeHtml", () => {
  test("escapes the five HTML-significant characters", () => {
    expect(escapeHtml(`<a href="x" title='y'>&</a>`)).toBe(
      "&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;",
    )
  })

  test("leaves plain text unchanged", () => {
    expect(escapeHtml("Fix login (P1)")).toBe("Fix login (P1)")
  })
})

describe("getNodeLabel", () => {
  test("a title containing markup renders as text, not elements", () => {
    const title = `<img src="x.png"><b>bold</b>`
    const el = render(getNodeLabel(node({ title })))
    expect(el.querySelector("img")).toBeNull()
    expect(el.querySelector("b")).toBeNull()
    expect(el.textContent).toContain(title)
  })

  test("id and status are escaped too", () => {
    const el = render(
      getNodeLabel(node({ id: `<i>id</i>`, status: `<s>x</s>` as MoleculeNode["status"] })),
    )
    expect(el.querySelector("i")).toBeNull()
    expect(el.querySelector("s")).toBeNull()
    expect(el.textContent).toContain("<i>id</i>")
  })

  test("an ordinary node keeps its title, id and readable status", () => {
    const el = render(getNodeLabel(node({ title: "Ship it", status: "in_progress" })))
    expect(el.textContent).toContain("Ship it")
    expect(el.textContent).toContain("bd-1")
    expect(el.textContent).toContain("in progress")
  })
})
