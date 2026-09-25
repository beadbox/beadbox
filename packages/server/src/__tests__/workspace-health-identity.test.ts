// beadbox-287: a server workspace whose scaffold identity differs from the
// served database gets an actionable health error, not "Startup error" with
// bd's raw text (which says another project's server is on the port).

import { describe, expect, test } from "bun:test"
import { classifyHealthError } from "../lib/workspace-health"
import type { RegistryEntry } from "../lib/workspace-registry"

// bd 1.2.2's text, verbatim from a reproduction against a scratch server.
const MISMATCH = `Error: failed to open database: PROJECT IDENTITY MISMATCH — refusing to connect

  Local project ID (metadata.json):  29ae6d48-c4c6-4df6-b12c-089f2b315526
  Database project ID:               328c14ec-4172-44bb-a87b-e06a37ab19fa

This means the Dolt server is serving a DIFFERENT project's database.`

const serverWorkspace: RegistryEntry = {
  id: "ws-1",
  name: "team_beads",
  addedAt: "2026-09-25T00:00:00Z",
  local: { path: "/Users/x/.beadbox/workspaces/ws-1/.beads" },
  server: {
    host: "db.example.test",
    port: 3307,
    database: "team_beads",
    user: "alice",
    tls: false,
  },
  mode: "server",
  serverOwnership: "external",
}

const localWorkspace: RegistryEntry = {
  id: "ws-2",
  name: "proj",
  addedAt: "2026-09-25T00:00:00Z",
  local: { path: "/Users/x/proj/.beads" },
  server: null,
  mode: "server",
}

describe("classifyHealthError: project identity mismatch (beadbox-287)", () => {
  test("a server workspace gets project_identity_mismatch with both ids", () => {
    expect(classifyHealthError("Command failed", MISMATCH, serverWorkspace)).toEqual({
      kind: "project_identity_mismatch",
      database: "team_beads",
      localId: "29ae6d48-c4c6-4df6-b12c-089f2b315526",
      databaseId: "328c14ec-4172-44bb-a87b-e06a37ab19fa",
    })
  })

  test("the text is found in stdout too (bd --json puts errors there)", () => {
    const out = JSON.stringify({ error: MISMATCH })
    expect(classifyHealthError("Command failed", "", serverWorkspace, out).kind).toBe(
      "project_identity_mismatch",
    )
  })

  test("a local workspace keeps bd's own message (a different server on its port)", () => {
    expect(classifyHealthError("Command failed", MISMATCH, localWorkspace).kind).not.toBe(
      "project_identity_mismatch",
    )
  })
})
