import { AsyncLocalStorage } from "node:async_hooks"
import { createHash } from "node:crypto"
import { readFile, realpath, stat } from "node:fs/promises"
import { resolve } from "node:path"

import { resolveBdPath } from "./bd-paths"
import { execFileAsync } from "./exec"
import { type RegistryEntry, readRegistry } from "./workspace-registry"
import { invalidateWorkspaceTarget, resolveWorkspaceTarget } from "./workspace-resolver"

type Target = Readonly<RegistryEntry>

export interface OperationLease {
  readonly workspace: Target
  readonly generation: number
  release(): void
}

export interface TransitionHooks {
  stopServe(workspaceId: string): Promise<void>
  pauseSubscriptions(workspaces: RegistryEntry[]): Promise<() => Promise<void>>
  discardSubscriptions?(workspaces: RegistryEntry[]): Promise<void>
}

type BinaryIdentity = { path: string; signature: string; version: string; digest: string }

/** A sidecar-local barrier. Every database-touching route must acquire a lease. */
export class WorkspaceTransition {
  private readonly operationContext = new AsyncLocalStorage<OperationLease>()
  private readonly liveLeases = new WeakSet<OperationLease>()
  private readonly generations = new Map<string, number>()
  private readonly active = new Map<string, number>()
  private readonly idle = new Map<string, Set<() => void>>()
  private readonly blocked = new Set<string>()
  private readonly unblocked = new Map<string, Set<() => void>>()
  private transitionTail: Promise<void> = Promise.resolve()
  private binary: BinaryIdentity | null = null
  private binaryProbe: Promise<void> | null = null

  constructor(private readonly hooks: TransitionHooks) {}

  generation(id: string): number {
    return this.generations.get(id) ?? 0
  }

  async acquire(id: string): Promise<OperationLease> {
    for (;;) {
      await this.waitUntilUnblocked(id)
      const workspace = (await readRegistry()).workspaces.find((entry) => entry.id === id)
      if (!workspace) throw new Error(`Workspace ${id} is not registered`)
      // A transition may have started while readRegistry was pending.
      if (this.blocked.has(id)) continue
      this.active.set(id, (this.active.get(id) ?? 0) + 1)
      const generation = this.generation(id)
      let released = false
      const lease: OperationLease = {
        workspace: structuredClone(workspace),
        generation,
        release: () => {
          if (released) return
          released = true
          this.liveLeases.delete(lease)
          const remaining = (this.active.get(id) ?? 1) - 1
          if (remaining === 0) {
            this.active.delete(id)
            this.notify(this.idle, id)
          } else this.active.set(id, remaining)
        },
      }
      this.liveLeases.add(lease)
      return lease
    }
  }

  async withOperation<T>(id: string, run: (lease: OperationLease) => Promise<T>): Promise<T> {
    const current = this.operationContext.getStore()
    if (current?.workspace.id === id && this.liveLeases.has(current)) return run(current)
    await this.preflightBdBinary()
    const lease = await this.acquire(id)
    try {
      return await this.operationContext.run(lease, () => run(lease))
    } finally {
      lease.release()
    }
  }

  /** Stop one registry entry before replacing its target or removing it. */
  async runWorkspaceTransition<T>(
    id: string,
    mutate: () => Promise<T>,
    options?: { remove?: boolean },
  ): Promise<T> {
    return this.serialize(async () => {
      const registry = await readRegistry()
      const entry = registry.workspaces.find((workspace) => workspace.id === id)
      if (!entry) throw new Error(`Workspace ${id} is not registered`)
      return this.barrier([entry], mutate, options)
    })
  }

  /** Stop every known alias of a physical database before schema or storage mutation. */
  async runStorageTransition<T>(id: string, mutate: () => Promise<T>): Promise<T> {
    return this.serialize(async () => {
      const entries = (await readRegistry()).workspaces
      const target = entries.find((entry) => entry.id === id)
      if (!target) throw new Error(`Workspace ${id} is not registered`)
      const identity = (await resolveWorkspaceTarget(target.id)).storageIdentity
      const group: RegistryEntry[] = []
      for (const entry of entries) {
        if ((await resolveWorkspaceTarget(entry.id)).storageIdentity === identity) group.push(entry)
      }
      return this.barrier(group, mutate)
    })
  }

  /** Must run before any bd command that can open a workspace, including health. */
  async preflightBdBinary(): Promise<void> {
    if (this.binaryProbe) return this.binaryProbe
    const probe = this.inspectBinary().then(async (next) => {
      const previous = this.binary
      if (previous && previous.path === next.path && previous.signature === next.signature) return
      if (
        previous &&
        (previous.path !== next.path ||
          previous.digest !== next.digest ||
          previous.version !== next.version)
      ) {
        await this.serialize(async () => {
          const entries = (await readRegistry()).workspaces
          await this.barrier(entries, async () => undefined)
        })
      }
      this.binary = next
    })
    this.binaryProbe = probe
    try {
      await probe
    } finally {
      this.binaryProbe = null
    }
  }

  async bdVersion(): Promise<string> {
    await this.preflightBdBinary()
    if (!this.binary) throw new Error("bd binary identity is unavailable")
    return this.binary.version
  }

  private async inspectBinary(): Promise<BinaryIdentity> {
    const configured = resolveBdPath()
    // A bare command name is resolved using the same augmented PATH as execFileAsync.
    const candidate = configured.includes("/") ? configured : await findOnPath(configured)
    const path = await realpath(candidate)
    const before = await stat(path)
    const signature = `${before.dev}:${before.ino}:${before.size}:${before.mtimeMs}:${before.ctimeMs}`
    if (this.binary?.path === path && this.binary.signature === signature) return this.binary
    const [bytes, result] = await Promise.all([
      readFile(path),
      execFileAsync(path, ["--version"], { timeout: 5000 }),
    ])
    const after = await stat(path)
    const afterSignature = `${after.dev}:${after.ino}:${after.size}:${after.mtimeMs}:${after.ctimeMs}`
    if (signature !== afterSignature) throw new Error("bd binary changed during identity preflight")
    return {
      path,
      signature,
      version: result.stdout.trim(),
      digest: createHash("sha256").update(bytes).digest("hex"),
    }
  }

  private async barrier<T>(
    entries: RegistryEntry[],
    mutate: () => Promise<T>,
    options?: { remove?: boolean },
  ): Promise<T> {
    const unique = [...new Map(entries.map((entry) => [entry.id, entry])).values()]
    for (const entry of unique) this.blocked.add(entry.id)
    let resume: (() => Promise<void>) | null = null
    try {
      await Promise.all(unique.map((entry) => this.waitUntilIdle(entry.id)))
      resume = await this.hooks.pauseSubscriptions(unique)
      for (const entry of unique) {
        await this.hooks.stopServe(entry.id)
      }
      const result = await mutate()
      if (options?.remove) await this.hooks.discardSubscriptions?.(unique)
      return result
    } finally {
      for (const entry of unique) {
        this.generations.set(entry.id, this.generation(entry.id) + 1)
        invalidateWorkspaceTarget(entry.id)
      }
      try {
        if (resume) await resume()
      } finally {
        for (const entry of unique) {
          this.blocked.delete(entry.id)
          this.notify(this.unblocked, entry.id)
        }
      }
    }
  }

  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const next = this.transitionTail.then(work, work)
    this.transitionTail = next.then(
      () => undefined,
      () => undefined,
    )
    return next
  }

  private waitUntilIdle(id: string): Promise<void> {
    if (!this.active.has(id)) return Promise.resolve()
    return new Promise((done) => this.addWaiter(this.idle, id, done))
  }

  private waitUntilUnblocked(id: string): Promise<void> {
    if (!this.blocked.has(id)) return Promise.resolve()
    return new Promise((done) => this.addWaiter(this.unblocked, id, done))
  }

  private addWaiter(map: Map<string, Set<() => void>>, id: string, done: () => void): void {
    const waiters = map.get(id) ?? new Set()
    waiters.add(done)
    map.set(id, waiters)
  }

  private notify(map: Map<string, Set<() => void>>, id: string): void {
    const waiters = map.get(id)
    map.delete(id)
    for (const done of waiters ?? []) done()
  }
}

async function findOnPath(command: string): Promise<string> {
  for (const dir of (process.env.PATH ?? "").split(":")) {
    if (!dir) continue
    const path = resolve(dir, command)
    if (
      await stat(path).then(
        (file) => file.isFile(),
        () => false,
      )
    )
      return path
  }
  throw new Error(`bd executable ${command} not found`)
}

/** Shared coordinator for sidecar routes; imports are deferred to avoid handler cycles. */
export const workspaceTransition = new WorkspaceTransition({
  async stopServe(workspaceId) {
    const { serveManager } = await import("./serve-manager")
    await serveManager.stop(workspaceId)
  },
  async pauseSubscriptions(workspaces) {
    const { pauseWorkspaceSubscriptions } = await import("../handlers/subscribe-internals")
    return pauseWorkspaceSubscriptions(subscriptionPaths(workspaces))
  },
  async discardSubscriptions(workspaces) {
    const { discardWorkspaceSubscriptions } = await import("../handlers/subscribe-internals")
    await discardWorkspaceSubscriptions(subscriptionPaths(workspaces))
  },
})

function subscriptionPaths(workspaces: RegistryEntry[]): string[] {
  return workspaces.flatMap((entry) => {
    const result: string[] = []
    if (entry.local) result.push(entry.local.path, resolve(entry.local.path, "beads.db"))
    if (entry.server)
      result.push(`server://${entry.server.host}:${entry.server.port}/${entry.server.database}`)
    return result
  })
}
