// beadbox-a9l regression suite: detail-panel comments render via the
// version-stable `bd comments <id> --json` subcommand.
//
// THE BUG IT GUARDS AGAINST:
// `bd show <id> --json` omits comment bodies by default — the response
// has `comment_count` but `comments: null`. getBeadDetail used to read
// `(bdBead.comments || []).map(...)`, so the detail panel's comments
// section (gated on commentsCount > 0) never rendered for any bead with
// comments. The first fix attempt added `--include-comments` to bd show,
// but that flag is VERSION-GATED (newer bd only) and blew up on CI's
// older bd with a usage dump. The durable fix sources comment bodies
// from the dedicated `bd comments <id> --json` subcommand (getComments),
// which is stable across every bd version and runs in getBeadDetail's
// existing parallel batch (no added round-trip).
//
// This test exercises the PRODUCTION path — getBeadDetail — using only
// stable bd subcommands (`bd comments add`, then getBeadDetail's
// `bd comments --json` read), so it passes on CI's bd version, not just
// a newer local one.
//
// Coverage:
//   1. A bead with N comments → getBeadDetail returns N populated bodies.
//   2. Each comment carries id / author / content / timestamp.
//   3. A zero-comment bead → empty comments array (no spurious section).

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import * as epics from "../handlers/epics"
import { BD_WORKSPACE_TIMEOUT_MS, createBdWorkspace, runBdInWorkspace, type Workspace } from "./fixtures/bd-workspace"

setDefaultTimeout(BD_WORKSPACE_TIMEOUT_MS)

let ws: Workspace
let beadIdWithComments: string
let beadIdNoComments: string

beforeAll(async () => {
  ws = await createBdWorkspace()
  beadIdWithComments = ws.seedIds.test2
  beadIdNoComments = ws.seedIds.test3
  await runBdInWorkspace(
    ["comments", "add", beadIdWithComments, "first reply on the bead"],
    ws.root,
  )
  await runBdInWorkspace(
    ["comments", "add", beadIdWithComments, "second reply with a different body"],
    ws.root,
  )
})

afterAll(async () => {
  await ws?.cleanup()
})

describe("getBeadDetail comments via stable bd comments subcommand (beadbox-a9l)", () => {
  test("returns N populated comment bodies for a bead with N comments", async () => {
    const bead = await epics.getBeadDetail(beadIdWithComments, ws.dbPath)
    expect(bead).not.toBeNull()
    expect(bead!.id).toBe(beadIdWithComments)
    expect(bead!.comments).toHaveLength(2)
    const bodies = bead!.comments.map((c) => c.content)
    expect(bodies).toContain("first reply on the bead")
    expect(bodies).toContain("second reply with a different body")
  })

  test("each comment carries id / author / content / timestamp", async () => {
    const bead = await epics.getBeadDetail(beadIdWithComments, ws.dbPath)
    expect(bead).not.toBeNull()
    for (const c of bead!.comments) {
      expect(typeof c.id).toBe("string")
      expect(c.id.length).toBeGreaterThan(0)
      expect(typeof c.author).toBe("string")
      expect(typeof c.content).toBe("string")
      expect(c.content.length).toBeGreaterThan(0)
      expect(c.timestamp instanceof Date).toBe(true)
    }
  })

  test("a bead with zero comments returns an empty comments array", async () => {
    const bead = await epics.getBeadDetail(beadIdNoComments, ws.dbPath)
    expect(bead).not.toBeNull()
    expect(bead!.comments).toEqual([])
  })
})
