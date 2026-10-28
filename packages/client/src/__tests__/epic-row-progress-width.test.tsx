// beadbox-v07e: the epic row's progress bar is 96 px (w-24), down from 144 px
// (w-36), so the row stays compact. Height, colours and the "N/M (P%)" count
// beside it are unchanged, and the count is rendered whole.

import { afterEach, describe, expect, mock, test } from "bun:test"
import { cleanup, render, screen } from "@testing-library/react"

import { EpicTree } from "../components/epic-tree"
import type { Bead, Epic } from "../lib/types"

afterEach(cleanup)

const child = (id: string, status: string) =>
  ({
    id,
    title: id,
    status,
    priority: "medium",
    type: "task",
    labels: [],
    createdAt: new Date(),
    updatedAt: new Date(),
  }) as unknown as Bead

function epicWithFive(): Epic {
  return {
    id: "bb-e1",
    title: "Progress Epic",
    description: "",
    status: "open",
    priority: "medium",
    type: "epic",
    assignee: "",
    labels: [],
    createdAt: new Date(),
    updatedAt: new Date(),
    comments: [],
    children: [
      child("c1", "closed"),
      child("c2", "closed"),
      child("c3", "open"),
      child("c4", "open"),
      child("c5", "in_progress"),
    ],
    childEpics: [],
    commentCount: 0,
  } as Epic
}

describe("epic row progress bar width (beadbox-v07e)", () => {
  test("the bar is 96 px (w-24) and the full 2/5 (40%) count sits beside it", () => {
    render(
      <EpicTree
        epics={[epicWithFive()]}
        expandedEpics={new Set()}
        onToggleEpic={mock(() => {})}
        onBeadClick={mock(() => {})}
      />,
    )
    const count = screen.getByText("2/5 (40%)")
    const bar = count.parentElement?.firstElementChild as HTMLElement
    expect(bar.className.split(" ")).toContain("w-24")
    expect(bar.className.split(" ")).not.toContain("w-36")
    // Unchanged: the h-3 track and the count's own width.
    expect(bar.querySelector(".h-3")).not.toBeNull()
    expect(count.className.split(" ")).toContain("min-w-[90px]")
  })
})
