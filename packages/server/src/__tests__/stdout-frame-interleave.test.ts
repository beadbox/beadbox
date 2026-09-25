// Concurrent replies must not interleave on the sidecar's stdout (beadbox-hia).
// Found with a synthetic 5000-issue workspace: on a full pipe, a ~7MB
// epics.getEpics frame went out in partial writes, a small reply landed in
// the middle of it, the client dropped both frames, and the calls never
// settled. The fake below splits every frame into partial writes the way a
// full pipe does, so the interleave is deterministic here.

import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { serializeWrites } from "../lib/serial-write"

function pipeLikeWriter() {
  let wire = ""
  return {
    wire: () => wire,
    io: {
      async write(message: string): Promise<void> {
        const third = Math.ceil(message.length / 3)
        for (let at = 0; at < message.length; at += third) {
          wire += message.slice(at, at + third)
          await new Promise((r) => setTimeout(r, 1)) // the pipe drains
        }
      },
    },
  }
}

const big = `{"big":"${"x".repeat(30_000)}"}\n`
const small = (i: number) => `{"small":${i}}\n`

function badFrames(wire: string): number {
  return wire
    .split("\n")
    .filter((l) => l.length > 0)
    .filter((l) => {
      try {
        JSON.parse(l)
        return false
      } catch {
        return true
      }
    }).length
}

async function writeConcurrently(io: { write(m: string): Promise<void> }): Promise<void> {
  await Promise.all([io.write(big), io.write(small(1)), io.write(small(2))])
}

test("control: unserialized partial writes interleave", async () => {
  const pipe = pipeLikeWriter()
  await writeConcurrently(pipe.io)
  expect(badFrames(pipe.wire())).toBeGreaterThan(0)
})

test("serialized writes keep every frame contiguous, in order", async () => {
  const pipe = pipeLikeWriter()
  await writeConcurrently(serializeWrites(pipe.io))
  expect(badFrames(pipe.wire())).toBe(0)
  expect(pipe.wire()).toBe(big + small(1) + small(2))
})

test("a failed write does not block the frames after it", async () => {
  let first = true
  const written: string[] = []
  const io = serializeWrites({
    async write(message: string): Promise<void> {
      if (first) {
        first = false
        throw new Error("EPIPE")
      }
      written.push(message)
    },
  })
  await expect(io.write(small(1))).rejects.toThrow("EPIPE")
  await io.write(small(2))
  expect(written).toEqual([small(2)])
})

test("the sidecar entry point serializes its stdout transport", () => {
  const entry = readFileSync(join(import.meta.dir, "..", "index.ts"), "utf-8")
  expect(entry).toMatch(/serializeWrites\(new BunIo\(/)
})
