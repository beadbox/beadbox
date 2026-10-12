// beadbox-2wi: the Grouped (by status) arrangement of the Beads view, per
// pm/spec.md §4.2.4. Grouped ON is the same items as the tree, arranged by
// status: each epic keeps the Grouped OFF card, shown inside every status group
// where it has beads, and every bead appears exactly once, in the group of its
// own status (inside its nearest ancestor epic's card, or in the group's loose
// table when it has none). Rows never carry children: a subtask is its own row.
import type { Bead, Epic } from "@/lib/types"

/** One epic's card inside one status group. */
export interface GroupedCard {
  /** Unique per card (an epic can have a card in several groups). */
  key: string
  /** The epic as the Grouped OFF tree renders it (header, progress, n/m). */
  epic: Epic
  /** The rows of this group's status under this epic, children stripped. */
  beads: Bead[]
  /** True when this is the epic's own status, so its header counts here. */
  ownStatus: boolean
}

export interface GroupedSection {
  status: string
  label: string
  cards: GroupedCard[]
  /** Beads with no parent epic, shown after the cards. */
  loose: Bead[]
  /**
   * Items of this status shown in the group: every row, plus the card
   * headers of epics whose own status is this one (not cards that appear here
   * only to hold their children). Summed over the groups, each visible bead
   * and epic counts exactly once.
   */
  count: number
}

const STANDALONE = "_standalone"

export function groupedCardKey(status: string, epicId: string): string {
  return `grouped:${status}:${epicId}`
}

export function groupTreeByStatus(
  roots: Epic[],
  chain: string[],
  matches: (bead: Bead) => boolean = () => true,
  headerFor: (epic: Epic) => Epic = (epic) => epic,
): GroupedSection[] {
  const sections = new Map<string, { cards: GroupedCard[]; loose: Bead[] }>()
  const sectionFor = (status: string) => {
    let s = sections.get(status)
    if (!s) {
      s = { cards: [], loose: [] }
      sections.set(status, s)
    }
    return s
  }

  // A bead and its subtasks, in tree order, each as a row without children.
  const rowsUnder = (beads: Bead[] | undefined): Bead[] =>
    (beads ?? []).flatMap((b) => [{ ...b, children: undefined }, ...rowsUnder(b.children)])

  const byStatus = (rows: Bead[]) => {
    const out = new Map<string, Bead[]>()
    for (const row of rows.filter(matches)) {
      const list = out.get(row.status)
      if (list) list.push(row)
      else out.set(row.status, [row])
    }
    return out
  }

  const walk = (epic: Epic) => {
    if (epic.id === STANDALONE) {
      for (const [status, rows] of byStatus(rowsUnder(epic.children))) sectionFor(status).loose.push(...rows)
      return
    }
    const rows = byStatus(rowsUnder(epic.children))
    const header = headerFor(epic)
    const ownStatus = matches(epic) ? epic.status : null
    const statuses = [...rows.keys()]
    if (ownStatus !== null && !rows.has(ownStatus)) statuses.push(ownStatus)
    for (const status of statuses) {
      sectionFor(status).cards.push({
        key: groupedCardKey(status, epic.id),
        epic: header,
        beads: rows.get(status) ?? [],
        ownStatus: status === ownStatus,
      })
    }
    // Child epics are their own cards, never nested.
    for (const child of epic.childEpics ?? []) walk(child)
  }
  for (const root of roots) walk(root)

  // Workflow order, as groupBeadsByStatus: open, in progress, the workspace's
  // chain, closed, then anything else in the order first seen.
  const order: string[] = []
  for (const s of ["open", "in_progress", ...chain, "closed", ...sections.keys()]) {
    if (!order.includes(s)) order.push(s)
  }
  const labelFor = (s: string) => s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())

  return order
    .filter((status) => sections.has(status))
    .map((status) => {
      const { cards, loose } = sections.get(status) as { cards: GroupedCard[]; loose: Bead[] }
      const rows = cards.reduce((n, c) => n + c.beads.length, 0) + loose.length
      return {
        status,
        label: labelFor(status),
        cards,
        loose,
        count: rows + cards.filter((c) => c.ownStatus).length,
      }
    })
}

/** One keyboard stop, in display order (same shape as the tree's). */
export interface GroupedNavItem {
  id: string
  type: "epic" | "bead"
  bead: Bead
}

/**
 * The keyboard order of the Grouped view: per group, each card header (its
 * own stop, keyed by the card, since one epic can have a card in several
 * groups), then the card's rows when the epic is expanded, then the group's
 * loose rows. Rows carry no children here, so every bead is one stop.
 */
export function groupedNavigationOrder(layout: GroupedSection[], expandedEpics: Set<string>): GroupedNavItem[] {
  const items: GroupedNavItem[] = []
  for (const section of layout) {
    for (const card of section.cards) {
      items.push({ id: card.key, type: "epic", bead: card.epic })
      if (expandedEpics.has(card.epic.id)) {
        for (const bead of card.beads) items.push({ id: bead.id, type: "bead", bead })
      }
    }
    for (const bead of section.loose) items.push({ id: bead.id, type: "bead", bead })
  }
  return items
}
