// Helper: create an isolated tmpdir bd workspace + deterministic seed beads.
//
// Used by beads.unit.test.ts and epics.unit.test.ts. Each test gets its own
// workspace via mkdtemp; teardown removes it.

import { execFile } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"

const runBd = promisify(execFile)

/**
 * The deadline for a test or hook that builds or uses a workspace: a hang
 * guard, not a measurement (beadbox-mol-uua.1). bd init, bd create and Dolt's
 * commits are real processes; on a loaded Mac (several rigs running suites)
 * one workspace took over 17 s to build and setups crossed the old 30 s
 * deadline, failing pushes on the machine's load rather than the code. A
 * healthy setup takes seconds and returns as soon as it is done; only a hang
 * runs into this. Every file that uses this fixture sets it with
 * setDefaultTimeout(BD_WORKSPACE_TIMEOUT_MS), which covers its hooks too.
 */
export const BD_WORKSPACE_TIMEOUT_MS = 180_000

export interface Workspace {
  /** Path to the workspace root (tmpdir). */
  root: string
  /** Path to the .beads/ directory — pass to handlers as dbPath. */
  dbPath: string
  /** IDs of seed beads (deterministic via prefix=test). */
  seedIds: { test1: string; test2: string; test3: string; epic1: string }
  /** Tear down the workspace. */
  cleanup(): Promise<void>
}

// Build a child-process env with every GIT_* variable stripped (bb-aeb2 +
// bb-kvsy). Two failure modes both rooted in env inheritance:
//   1. husky pre-push hook (bb-aeb2): git sets GIT_DIR / GIT_WORK_TREE /
//      GIT_INDEX_FILE on the hook's process and they propagate to every
//      child. The tmpdir `git init` / `git commit` calls below would then
//      re-use the parent submodule's bare config and fail with "core.bare
//      and core.worktree do not make sense / fatal: unable to set up work
//      tree using invalid config" before the test could even seed.
//   2. bd CLI internal git operations (bb-kvsy): bd init / create / update
//      shell out to git internally for its own commit work. Without the
//      strip, those inherited GIT_DIR/GIT_WORK_TREE point at the agent's
//      eng3/src worktree and bd commits its scaffold ("bd init: initialize
//      beads issue tracking") into the host repo instead of the tmpdir
//      workspace.
// Forgiving regex over a named list — git keeps adding new GIT_* vars
// across releases (GIT_AUTHOR_*, GIT_COMMITTER_*, GIT_OBJECT_DIRECTORY,
// GIT_NAMESPACE, GIT_LITERAL_PATHSPECS, etc.). The /^GIT_/ filter catches
// every existing and future variant.
// Exported for direct regression testing (bb-kvsy). This is the load-
// bearing line of the fixture from a pollution-prevention standpoint:
// any change that drops the GIT_* strip will land the unit test on it
// before a misdirected commit can happen in CI / local dev.
export function _cleanEnvForTesting(
  parentEnv: NodeJS.ProcessEnv,
  extras: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...parentEnv, ...extras }
  for (const key of Object.keys(env)) {
    if (key.startsWith("GIT_")) delete env[key]
  }
  return env
}

function cleanEnv(extras: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return _cleanEnvForTesting(process.env, extras)
}

async function bd(args: string[], cwd: string): Promise<string> {
  const env = cleanEnv({ BD_NON_INTERACTIVE: "1" })
  const { stdout } = await runBd("bd", args, { cwd, env })
  return stdout
}

// Exposed so tests can mutate a seeded workspace post-creation (e.g.
// add a parent-child edge between two seeded task beads to exercise
// the non-epic-parent branch of handlers/epics.ts). Same shape +
// non-interactive env as the internal bd() above.
export async function runBdInWorkspace(args: string[], root: string): Promise<string> {
  return bd(args, root)
}

async function git(args: string[], cwd: string): Promise<void> {
  await runBd("git", args, { cwd, env: cleanEnv() })
}

/**
 * Create a fresh bd workspace in a tmpdir and seed it with:
 *   3 task beads + 1 epic bead. test1 is reparented under epic1 so getEpics
 *   produces a non-trivial tree.
 *
 * Returns dbPath = <root>/.beads (the canonical handler argument shape).
 */
export async function createBdWorkspace(): Promise<Workspace> {
  const root = await mkdtemp(join(tmpdir(), "bb-vy13.2-"))
  const dbPath = join(root, ".beads")

  // bd init requires a git repo with at least one commit, otherwise its
  // internal `git commit` of the .beads/ scaffolding hangs.
  await git(["init", "-q"], root)
  await git(["config", "user.email", "test@local"], root)
  await git(["config", "user.name", "Test"], root)
  await git(["commit", "-q", "--allow-empty", "-m", "init"], root)

  await bd(["init", "--non-interactive", "--prefix=test", "--skip-hooks"], root)
  await bd(["create", "Seed task 1", "--type", "task"], root)
  await bd(["create", "Seed task 2", "--type", "task"], root)
  await bd(["create", "Seed task 3", "--type", "task"], root)
  await bd(["create", "Seed epic 1", "--type", "epic"], root)

  const list = await bd(["list", "--all", "--json"], root)
  const beads = JSON.parse(list) as Array<{ id: string; issue_type: string; title: string }>
  const tasks = beads
    .filter((b) => b.issue_type === "task")
    .sort((a, b) => a.id.localeCompare(b.id))
  const epics = beads.filter((b) => b.issue_type === "epic")

  if (tasks.length < 3 || epics.length < 1) {
    throw new Error(`workspace seeding failed: got ${tasks.length} tasks, ${epics.length} epics`)
  }

  const seedIds = {
    test1: tasks[0]!.id,
    test2: tasks[1]!.id,
    test3: tasks[2]!.id,
    epic1: epics[0]!.id,
  }

  await bd(["update", seedIds.test1, "--parent", seedIds.epic1], root)

  return {
    root,
    dbPath,
    seedIds,
    cleanup: async () => {
      try {
        await rm(root, { recursive: true, force: true })
      } catch {
        // best effort
      }
    },
  }
}
