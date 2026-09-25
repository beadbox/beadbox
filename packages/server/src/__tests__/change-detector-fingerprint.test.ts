// Regression suite for getChangeFingerprint.
//
// Signal-source history (see dolt-write-marker.ts for the empirical table):
//   - bb-onv3.9:   last-touched → journal.idx mtime+size.
//   - beadbox-v7l: journal.idx → manifest CONTENT-HASH. Under bd 1.0.2
//     embedded mode the journal.idx file's mtime+size flapped every ~3s
//     from background compaction even with NO user writes, producing a
//     subscription hot loop. The Dolt manifest's bytes encode the repo's
//     current commit hash + root pointer; real writes change the bytes,
//     bd show / bd list / Dolt GC do not.
//
// THIS TEST creates a synthetic Dolt layout and asserts:
//   1. Returns null when no manifest is present
//   2. Returns a stable fingerprint while manifest CONTENT is unchanged
//   3. Flips when manifest content changes
//   4. Does NOT flip on mtime-only updates (the bd 1.0.2 GC pattern)
//   5. Does NOT flip when sibling files (journal.idx, vvv…v) churn
//   6. Handles server (<beads-dir>/dolt/<db>/...) and embedded
//      (<beads-dir>/embeddeddolt/<db>/...) layouts
//   7. Handles multiple databases under one dolt root (union of manifests)
//   8. Does NOT depend on .beads/last-touched (bd 1.0.x read-marker noise)
//
// Every call here passes mode "embedded": these cases test manifest hashing
// itself. The dolt/<db> "server" LAYOUT is also where pre-0.63 bd kept
// EMBEDDED databases. Server MODE selects no markers at all (beadbox-01f.3,
// dolt-write-marker-mode.test.ts).

import { rmSync, utimesSync, writeFileSync } from "node:fs"
import { mkdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { getChangeFingerprint, isTrainFile } from "../lib/change-detector"

let tmpRoot: string

function uniqueRoot(): string {
  return join(tmpdir(), `bb-v7l-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
}

async function setupServerLayout(root: string, dbName: string): Promise<string> {
  const manifest = join(root, ".beads", "dolt", dbName, ".dolt", "noms", "manifest")
  await mkdir(join(root, ".beads", "dolt", dbName, ".dolt", "noms"), { recursive: true })
  await writeFile(manifest, "5:__DOLT__:f8oprniddg50up7sbmifm9u49lbvpvmi:initial-root-hash")
  return manifest
}

async function setupEmbeddedLayout(root: string, dbName: string): Promise<string> {
  const manifest = join(root, ".beads", "embeddeddolt", dbName, ".dolt", "noms", "manifest")
  await mkdir(join(root, ".beads", "embeddeddolt", dbName, ".dolt", "noms"), { recursive: true })
  await writeFile(manifest, "5:__DOLT__:f8oprniddg50up7sbmifm9u49lbvpvmi:initial-root-hash")
  return manifest
}

afterEach(() => {
  if (tmpRoot) {
    try {
      rmSync(tmpRoot, { recursive: true, force: true })
    } catch {
      /* tolerable */
    }
  }
})

beforeEach(() => {
  tmpRoot = uniqueRoot()
})

describe("getChangeFingerprint (beadbox-v7l)", () => {
  test("returns null when doltDir does not exist", async () => {
    await mkdir(join(tmpRoot, ".beads"), { recursive: true })
    const fp = await getChangeFingerprint(join(tmpRoot, ".beads"), "embedded")
    expect(fp).toBeNull()
  })

  test("returns null when doltDir exists but contains no manifest", async () => {
    await mkdir(join(tmpRoot, ".beads", "dolt", "bb"), { recursive: true })
    const fp = await getChangeFingerprint(join(tmpRoot, ".beads"), "embedded")
    expect(fp).toBeNull()
  })

  test("returns a manifest-derived fingerprint (server layout)", async () => {
    await setupServerLayout(tmpRoot, "bb")
    const fp = await getChangeFingerprint(join(tmpRoot, ".beads"), "embedded")
    expect(fp).not.toBeNull()
    expect(fp).toContain("manifest")
  })

  test("returns a manifest-derived fingerprint (embedded layout)", async () => {
    await setupEmbeddedLayout(tmpRoot, "cla")
    const fp = await getChangeFingerprint(join(tmpRoot, ".beads"), "embedded")
    expect(fp).not.toBeNull()
    expect(fp).toContain("manifest")
  })

  test("fingerprint stays stable when manifest content is unchanged", async () => {
    await setupServerLayout(tmpRoot, "bb")
    const fp1 = await getChangeFingerprint(join(tmpRoot, ".beads"), "embedded")
    const fp2 = await getChangeFingerprint(join(tmpRoot, ".beads"), "embedded")
    expect(fp1).toBe(fp2)
  })

  test("fingerprint flips when manifest content changes (real bd-create pattern)", async () => {
    const manifest = await setupServerLayout(tmpRoot, "bb")
    const fpBefore = await getChangeFingerprint(join(tmpRoot, ".beads"), "embedded")
    // Real bd commits rewrite the manifest with a new root-hash payload.
    writeFileSync(manifest, "5:__DOLT__:f8oprniddg50up7sbmifm9u49lbvpvmi:NEW-root-hash-after-commit")
    const fpAfter = await getChangeFingerprint(join(tmpRoot, ".beads"), "embedded")
    expect(fpAfter).not.toBe(fpBefore)
  })

  test("fingerprint does NOT flip on mtime-only updates (bd 1.0.2 GC pattern)", async () => {
    const manifest = await setupServerLayout(tmpRoot, "bb")
    const fpBefore = await getChangeFingerprint(join(tmpRoot, ".beads"), "embedded")
    // Dolt's background compaction bumps manifest mtime without changing
    // content. The beadbox-e9b hot loop came from this exact pattern.
    const future = new Date(Date.now() + 2000)
    utimesSync(manifest, future, future)
    const fpAfter = await getChangeFingerprint(join(tmpRoot, ".beads"), "embedded")
    expect(fpAfter).toBe(fpBefore)
  })

  test("does NOT flip when sibling Dolt internals churn (journal.idx + vvv...v)", async () => {
    await setupServerLayout(tmpRoot, "bb")
    const noms = join(tmpRoot, ".beads", "dolt", "bb", ".dolt", "noms")
    const journal = join(noms, "journal.idx")
    const vvvv = join(noms, "vvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvv")
    await writeFile(journal, "initial-journal-content")
    await writeFile(vvvv, "initial-data-content")
    const fpBefore = await getChangeFingerprint(join(tmpRoot, ".beads"), "embedded")
    // Simulate Dolt's compaction: journal.idx size flaps, vvv...v rewrites.
    writeFileSync(journal, "compacted-journal-different-bytes-and-length")
    writeFileSync(vvvv, "compacted-data-different-content")
    const future = new Date(Date.now() + 2000)
    utimesSync(journal, future, future)
    utimesSync(vvvv, future, future)
    const fpAfter = await getChangeFingerprint(join(tmpRoot, ".beads"), "embedded")
    expect(fpAfter).toBe(fpBefore)
  })

  test("multiple databases under one dolt root combine into one fingerprint", async () => {
    await setupServerLayout(tmpRoot, "bb")
    const secondManifest = join(
      tmpRoot,
      ".beads",
      "dolt",
      "secondary",
      ".dolt",
      "noms",
      "manifest",
    )
    await mkdir(join(tmpRoot, ".beads", "dolt", "secondary", ".dolt", "noms"), { recursive: true })
    await writeFile(secondManifest, "5:__DOLT__:secondary-db-initial-hash")
    const fp = await getChangeFingerprint(join(tmpRoot, ".beads"), "embedded")
    expect(fp).not.toBeNull()
    expect(fp).toContain("bb")
    expect(fp).toContain("secondary")
  })

  test("does NOT depend on .beads/last-touched (bd 1.0.x read-marker noise)", async () => {
    await setupServerLayout(tmpRoot, "bb")
    const lastTouched = join(tmpRoot, ".beads", "last-touched")
    await writeFile(lastTouched, "initial-bead-id")
    const fp1 = await getChangeFingerprint(join(tmpRoot, ".beads"), "embedded")
    await writeFile(lastTouched, "different-bead-id-from-bd-show")
    const fp2 = await getChangeFingerprint(join(tmpRoot, ".beads"), "embedded")
    expect(fp1).toBe(fp2)
  })

  test("getChangeFingerprint is UNCHANGED by a .beadtrain edit (hot path stays v7l-sized)", async () => {
    // beadbox-if6: plan files are watched separately; they must never enter
    // the fingerprint, which is read on every poll tick and fs event.
    await setupServerLayout(tmpRoot, "bb")
    const trainDir = join(tmpRoot, ".beads", "plans")
    await mkdir(trainDir, { recursive: true })
    const train = join(trainDir, "demo.beadtrain")
    await writeFile(train, '[train]\nname = "before"\n')
    const fp1 = await getChangeFingerprint(join(tmpRoot, ".beads"), "embedded")
    await writeFile(train, '[train]\nname = "after"\n')
    const fp2 = await getChangeFingerprint(join(tmpRoot, ".beads"), "embedded")
    expect(fp2).toBe(fp1)
    expect(fp1).not.toContain("beadtrain")
  })

  test("isTrainFile matches plan files in both fs.watch filename shapes", () => {
    expect(isTrainFile("demo.beadtrain")).toBe(true)              // Windows leaf
    expect(isTrainFile("plans/demo.beadtrain")).toBe(true)        // macOS relative
    expect(isTrainFile("dolt/bb/.dolt/noms/manifest")).toBe(false)
    expect(isTrainFile("issues.jsonl")).toBe(false)
    expect(isTrainFile(null)).toBe(false)
  })
})
