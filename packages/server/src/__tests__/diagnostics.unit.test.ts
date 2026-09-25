// Unit tests for handlers/diagnostics.ts (P1.3 / bb-vy13.3).
//
// Surface coverage:
//   - runDiagnostics() with no path and no active workspace → "No active workspace" error
//   - runDiagnostics() with an obviously invalid path → "Invalid workspace path" error
//
// The happy-path branch shells out to `bd doctor`; that is exercised by the
// P1.7 parity runner against a real workspace, not here.

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { runDiagnostics } from "../handlers/diagnostics"

// Sandbox the registry so getActiveWorkspace() returns null deterministically
// when no workspace is selected.
const ORIGINAL_REGISTRY_PATH = process.env.BEADBOX_REGISTRY_PATH
let sandboxRegistry: string

beforeEach(async () => {
  const dir = await mkdtemp(join(tmpdir(), "beadbox-diag-"))
  sandboxRegistry = join(dir, "registry.json")
  process.env.BEADBOX_REGISTRY_PATH = sandboxRegistry
})

afterEach(async () => {
  if (sandboxRegistry) {
    await rm(sandboxRegistry.replace(/\/registry\.json$/, ""), { recursive: true, force: true })
  }
  if (ORIGINAL_REGISTRY_PATH === undefined) {
    delete process.env.BEADBOX_REGISTRY_PATH
  } else {
    process.env.BEADBOX_REGISTRY_PATH = ORIGINAL_REGISTRY_PATH
  }
})

describe("runDiagnostics", () => {
  test("returns no-active-workspace error when registry empty and no path", async () => {
    const result = await runDiagnostics()
    expect(result.ok).toBe(false)
    expect(result.checks).toEqual([])
    expect(result.passed).toBe(0)
    expect(result.warnings).toBe(0)
    expect(result.errors).toBe(0)
    expect(result.error).toMatch(/No active workspace/i)
  })

  test("returns invalid-workspace-path error for a non-.beads path", async () => {
    const result = await runDiagnostics("/tmp/not-a-beads-path")
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/Invalid workspace path/i)
  })

  test("rejects null-byte paths", async () => {
    const result = await runDiagnostics("/tmp/foo\0bar/.beads")
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/Invalid workspace path/i)
  })

  test("accepts server:// URIs (no filesystem check)", async () => {
    // Server URI bypasses isValidDbPath's structural check. The doctor call
    // against an unreachable server may either return a parsed
    // { ok: false } shape OR an "invocation failed" error string. Both
    // surfaces (action and handler) produce the same shape; what we assert
    // is that the URI gets past path validation.
    const result = await runDiagnostics("server://127.0.0.1:9999/nonexistent")
    expect(result.ok).toBe(false)
    if (result.error !== undefined) {
      expect(result.error).not.toMatch(/Invalid workspace path/i)
    }
  })

  test("active-workspace fallback resolves the registry UUID", async () => {
    await writeFile(
      sandboxRegistry,
      `${JSON.stringify({
        version: 2,
        activeWorkspace: "ws-1",
        workspaces: [
          {
            id: "ws-1",
            name: "test",
            addedAt: new Date().toISOString(),
            local: { path: "/tmp/anywhere/.beads" },
            server: null,
            mode: "embedded",
          },
        ],
      })}\n`,
    )

    const result = await runDiagnostics()
    expect(result.ok).toBe(false)
    expect(result.error).not.toMatch(/Invalid workspace path/i)
  })
})
