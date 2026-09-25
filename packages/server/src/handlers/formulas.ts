// Formulas handler namespace. Mirrors every export of actions/formulas.ts.
//
// Same name + signature + return discriminator (Success<T> | Failure) as the
// actions. Internals call into ../lib/bd. No "use server" annotation.
//
// Channel discipline: this file has no console.log calls; the underlying
// lib/bd CLI wrapper does, and they're redirected to stderr by
// ../lib/console-discipline (loaded first via index.ts).

import {
  cookFormula,
  getMoleculeProgress,
  getMoleculeStructureRaw,
  listFormulas,
  listMoleculesForFormula,
  pourMolecule,
  showFormula,
} from "../lib/bd"
import type {
  CookedFormula,
  FormulaDetail,
  FormulaStep,
  FormulaSummary,
  MoleculeCard,
  MolProgress,
  StepOverlay,
} from "../lib/types"
import { workspaceTargetOptions } from "./workspace-target-options"

type Success<T> = { success: true; data: T }
type Failure = { success: false; error: string }

function extractError(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error"
}

export async function loadFormulas(dbPath?: string): Promise<Success<FormulaSummary[]> | Failure> {
  const { options } = await workspaceTargetOptions(dbPath)
  try {
    const data = await listFormulas(options)
    return { success: true, data }
  } catch (error: unknown) {
    return { success: false, error: extractError(error) }
  }
}

export async function loadFormulaDetail(
  name: string,
  dbPath?: string,
): Promise<Success<FormulaDetail> | Failure> {
  const { options } = await workspaceTargetOptions(dbPath)
  try {
    const data = await showFormula(name, options)
    return { success: true, data }
  } catch (error: unknown) {
    return { success: false, error: extractError(error) }
  }
}

export async function previewFormula(
  name: string,
  vars?: Record<string, string>,
  dbPath?: string,
): Promise<Success<CookedFormula> | Failure> {
  const { options } = await workspaceTargetOptions(dbPath)
  try {
    const data = await cookFormula(name, vars, options)
    return { success: true, data }
  } catch (error: unknown) {
    return { success: false, error: extractError(error) }
  }
}

export async function pourFormulaAction(
  formula: string,
  vars: Record<string, string>,
  assignee?: string,
  dbPath?: string,
): Promise<{ success: true } | Failure> {
  const { options } = await workspaceTargetOptions(dbPath)
  try {
    await pourMolecule(formula, vars, assignee, options)
    return { success: true }
  } catch (error: unknown) {
    return { success: false, error: extractError(error) }
  }
}

/** @internal Used by tests only; no production consumers. */
export async function loadMoleculeProgress(
  id: string,
  dbPath?: string,
): Promise<Success<MolProgress> | Failure> {
  const { options } = await workspaceTargetOptions(dbPath)
  try {
    const data = await getMoleculeProgress(id, options)
    return { success: true, data }
  } catch (error: unknown) {
    return { success: false, error: extractError(error) }
  }
}

// List molecules associated with a formula, each with progress data
export async function loadFormulaMolecules(
  formulaName: string,
  dbPath?: string,
): Promise<Success<Array<MoleculeCard & { progress: MolProgress }>> | Failure> {
  const { options } = await workspaceTargetOptions(dbPath)
  try {
    const cards = await listMoleculesForFormula(formulaName, options)
    const withProgress = await Promise.all(
      cards.map(async (card) => {
        try {
          const progress = await getMoleculeProgress(card.id, options)
          return { ...card, progress }
        } catch {
          return {
            ...card,
            progress: {
              id: card.id,
              name: card.title,
              total: 0,
              completed: 0,
              inProgress: 0,
              percent: 0,
            },
          }
        }
      }),
    )
    return { success: true, data: withProgress }
  } catch (error: unknown) {
    return { success: false, error: extractError(error) }
  }
}

// Build step overlay map by matching formula steps to molecule tasks structurally.
// Both DAGs are isomorphic (pour creates one task per step with identical deps).
// We topologically sort both and pair by position to avoid title mismatch from
// template variable resolution (e.g. "v{{version}}" vs "v0.18.0").
export async function loadMoleculeOverlay(
  molId: string,
  formulaSteps: FormulaStep[],
  dbPath?: string,
): Promise<Success<Record<string, StepOverlay>> | Failure> {
  const { options } = await workspaceTargetOptions(dbPath)
  try {
    const molData = await getMoleculeStructureRaw(molId, options)
    const rootId = molData.root.id

    const tasks = molData.issues.filter((i) => i.issue_type === "task" && i.id !== rootId)

    const blockDeps = molData.dependencies.filter((d) => d.type === "blocks")
    const taskIdSet = new Set(tasks.map((t) => t.id))
    const taskNeeds = new Map<string, string[]>()
    for (const t of tasks) taskNeeds.set(t.id, [])
    for (const dep of blockDeps) {
      if (taskIdSet.has(dep.issue_id) && taskIdSet.has(dep.depends_on_id)) {
        taskNeeds.get(dep.issue_id)!.push(dep.depends_on_id)
      }
    }

    const molOrder = topoSort(
      tasks.map((t) => t.id),
      taskNeeds,
    )

    const stepNeeds = new Map<string, string[]>()
    for (const s of formulaSteps) stepNeeds.set(s.id, s.needs ?? [])
    const formulaOrder = topoSort(
      formulaSteps.map((s) => s.id),
      stepNeeds,
    )

    const taskById = new Map(tasks.map((t) => [t.id, t]))
    const overlay: Record<string, StepOverlay> = {}

    const count = Math.min(formulaOrder.length, molOrder.length)
    for (let i = 0; i < count; i++) {
      const stepId = formulaOrder[i]
      const step = formulaSteps.find((s) => s.id === stepId)
      const task = taskById.get(molOrder[i])
      if (step && task) {
        overlay[step.title] = {
          status: mapBeadStatusToOverlay(task.status),
          assignee: task.assignee,
          updatedAt: task.updated_at,
        }
      }
    }

    return { success: true, data: overlay }
  } catch (error: unknown) {
    return { success: false, error: extractError(error) }
  }
}

// bb-fe03.5: topoSort was CCN 25. Split into Kahn's-algorithm phases —
// each phase is a small pure function, the orchestrator just chains them.

function computeInDegree(ids: string[], needs: Map<string, string[]>): Map<string, number> {
  const idSet = new Set(ids)
  const inDegree = new Map<string, number>()
  for (const id of ids) inDegree.set(id, 0)
  for (const id of ids) {
    for (const dep of needs.get(id) ?? []) {
      if (idSet.has(dep)) {
        inDegree.set(id, (inDegree.get(id) ?? 0) + 1)
      }
    }
  }
  return inDegree
}

function collectRootNodes(ids: string[], inDegree: Map<string, number>): string[] {
  const queue: string[] = []
  for (const id of ids) {
    if (inDegree.get(id) === 0) queue.push(id)
  }
  return queue
}

// prettier-ignore
function decrementDependentsOf(
  node: string,
  ids: string[],
  needs: Map<string, string[]>,
  inDegree: Map<string, number>,
  queue: string[],
): void {
  for (const id of ids) {
    const deps = needs.get(id) ?? []
    if (!deps.includes(node)) continue
    inDegree.set(id, (inDegree.get(id) ?? 1) - 1)
    if (inDegree.get(id) === 0) queue.push(id)
  }
}

function appendCycleStragglers(ids: string[], result: string[]): void {
  // Any id never queued (= reachable from a cycle) is appended at the
  // tail in insertion order so the result still contains every input.
  for (const id of ids) {
    if (!result.includes(id)) result.push(id)
  }
}

// Stable topological sort (Kahn's algorithm). Returns IDs in layer order,
// with ties broken by insertion order for determinism.
function topoSort(ids: string[], needs: Map<string, string[]>): string[] {
  const inDegree = computeInDegree(ids, needs)
  const queue = collectRootNodes(ids, inDegree)
  const result: string[] = []

  while (queue.length > 0) {
    const node = queue.shift() as string
    result.push(node)
    decrementDependentsOf(node, ids, needs, inDegree, queue)
  }

  appendCycleStragglers(ids, result)
  return result
}

function mapBeadStatusToOverlay(status: string): StepOverlay["status"] {
  switch (status) {
    case "closed":
      return "complete"
    case "in_progress":
      return "in_progress"
    case "blocked":
      return "blocked"
    case "open":
      return "pending"
    default:
      return "pending"
  }
}
