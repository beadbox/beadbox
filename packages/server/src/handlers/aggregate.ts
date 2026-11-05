// Read registered sources without activating them or merging their stores.
import { readRegistry, resolveBdDbPath } from "../lib/workspace-registry"
import { getEpics, type EpicResult } from "./epics"

type Reply = { workspaceId: string; databasePath: string; result: EpicResult }
const pending = new Map<string, Promise<Reply>>()
const waiting: Array<() => void> = []
let running = 0

async function acquire() {
  if (running < 2) {
    running++
    return
  }
  if (waiting.length >= 64) throw new Error("Too many project reads. Please retry.")
  await new Promise<void>((resolve) => waiting.push(resolve))
}

function release() {
  const next = waiting.shift()
  if (next) next()
  else running--
}

export async function readWorkspace(workspaceId: string, includeSystem = false): Promise<Reply> {
  const key = JSON.stringify([workspaceId, includeSystem])
  const existing = pending.get(key)
  if (existing) return existing
  const job = (async () => {
    await acquire()
    try {
      const registry = await readRegistry()
      const entry = registry.workspaces.find((w) => w.id === workspaceId)
      if (!entry) throw new Error("Project is no longer registered")
      const databasePath = resolveBdDbPath(entry)
      const result = await getEpics(databasePath, includeSystem)
      return { workspaceId, databasePath, result }
    } finally {
      release()
    }
  })()
  pending.set(key, job)
  try {
    return await job
  } finally {
    pending.delete(key)
  }
}
