import { orderMoleculeSteps } from "./molecule-order"
import type { Bead, Epic } from "./types"

export interface GateInfo {
  id: string
  type: string
  status: string
  deadline?: string // ISO; a timer gate's due time, when bd gave a timeout
}

export interface PhaseTask extends Bead {
  gate?: GateInfo
}

export interface MoleculePhase {
  phaseNumber: number
  tasks: PhaseTask[]
  closedCount: number
  totalCount: number
}

// bb-fe03.7: original CCN was 26 — five distinct steps inlined into one
// function (gate/task split, gate-source map, gate-info map, predecessor
// resolution, topological sort + grouping). Each step extracted into a
// pure helper below; computeMoleculePhases is now a thin orchestrator
// (CCN ≤ 6). Each helper has CCN < 15. Behavior is identical: tests in
// src/__tests__/molecule-phases.test.ts pin the observable contract.

interface SplitChildren {
  gates: Bead[]
  tasks: Bead[]
  taskIds: Set<string>
  gateIds: Set<string>
}

function splitGatesAndTasks(children: Bead[]): SplitChildren {
  const gates = children.filter((b) => b.type === "gate")
  const tasks = children.filter((b) => b.type !== "gate")
  return {
    gates,
    tasks,
    taskIds: new Set(tasks.map((t) => t.id)),
    gateIds: new Set(gates.map((g) => g.id)),
  }
}

// Map gate -> source task (the task the gate depends on via blockedBy).
// May be empty in practice — molecule gates often only have parent-child
// deps to the root.
function buildGateToSourceTask(gates: Bead[], taskIds: Set<string>): Map<string, string> {
  const map = new Map<string, string>()
  for (const gate of gates) {
    const sourceTask = gate.blockedBy?.find((dep) => taskIds.has(dep.id))
    if (sourceTask) map.set(gate.id, sourceTask.id)
  }
  return map
}

function classifyGateType(gateTitle: string): GateInfo["type"] {
  if (gateTitle.includes("conditional")) return "conditional"
  if (gateTitle.includes("human")) return "human"
  return "unknown"
}

// bd's await_type when it sent one; the title heuristic only as the fallback
// (a formula's type:gate step carries no await_type).
function toGateInfo(gate: Bead): GateInfo {
  const info: GateInfo = {
    id: gate.id,
    type: gate.gateWait?.awaitType || classifyGateType(gate.title || ""),
    status: gate.status as string,
  }
  if (gate.gateWait?.deadline) info.deadline = gate.gateWait.deadline
  return info
}

// Attach gate badge to the destination task (task blocked by the gate).
function buildGateInfoByTask(
  tasks: Bead[],
  gates: Bead[],
  gateIds: Set<string>,
): Map<string, GateInfo> {
  const map = new Map<string, GateInfo>()
  for (const task of tasks) {
    const gateBlocker = task.blockedBy?.find((dep) => gateIds.has(dep.id))
    if (!gateBlocker) continue
    const gate = gates.find((g) => g.id === gateBlocker.id)
    if (!gate) continue
    map.set(task.id, toGateInfo(gate))
  }
  return map
}

// Resolve task -> set of predecessor task ids, walking gates through to
// their source task. Gates with no source task contribute nothing (the
// task is phased based on its other non-gate deps).
function buildTaskPredecessors(
  tasks: Bead[],
  taskIds: Set<string>,
  gateIds: Set<string>,
  gateToSourceTask: Map<string, string>,
): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>()
  for (const task of tasks) {
    const preds = new Set<string>()
    for (const dep of task.blockedBy || []) {
      if (taskIds.has(dep.id)) {
        preds.add(dep.id)
      } else if (gateIds.has(dep.id)) {
        const sourceTask = gateToSourceTask.get(dep.id)
        if (sourceTask) preds.add(sourceTask)
      }
    }
    map.set(task.id, preds)
  }
  return map
}

// Topological assignment: tasks with no preds get phase 1; each subsequent
// pass assigns tasks whose preds are all assigned, to maxPredPhase + 1.
// Unassigned tasks (cycles or orphans) collapse to phase 1.
function assignPhases(
  tasks: Bead[],
  taskPredecessors: Map<string, Set<string>>,
): Map<string, number> {
  const phaseOf = new Map<string, number>()
  const assigned = new Set<string>()

  for (const task of tasks) {
    const preds = taskPredecessors.get(task.id)!
    if (preds.size === 0) {
      phaseOf.set(task.id, 1)
      assigned.add(task.id)
    }
  }

  let changed = true
  while (changed) {
    changed = false
    for (const task of tasks) {
      if (assigned.has(task.id)) continue
      const preds = taskPredecessors.get(task.id)!
      if (![...preds].every((p) => assigned.has(p))) continue
      const maxPredPhase = Math.max(...[...preds].map((p) => phaseOf.get(p) || 1))
      phaseOf.set(task.id, maxPredPhase + 1)
      assigned.add(task.id)
      changed = true
    }
  }

  for (const task of tasks) {
    if (!assigned.has(task.id)) phaseOf.set(task.id, 1)
  }
  return phaseOf
}

// beadbox-wya0.2: each gate is a row. It sits in the phase of the earliest
// task it blocks (beside the work it holds); a gate that blocks no task goes
// one phase after its latest predecessor task, or phase 1. Task phases are
// computed without gates as nodes, so no task moves.
function assignGatePhases(gates: Bead[], tasks: Bead[], taskPhase: Map<string, number>): Map<string, number> {
  const phaseOf = new Map<string, number>()
  for (const gate of gates) {
    const held = tasks.filter((t) => t.blockedBy?.some((dep) => dep.id === gate.id))
    if (held.length > 0) {
      phaseOf.set(gate.id, Math.min(...held.map((t) => taskPhase.get(t.id) || 1)))
      continue
    }
    const predPhases = (gate.blockedBy || []).map((dep) => taskPhase.get(dep.id) ?? 0)
    phaseOf.set(gate.id, Math.max(0, ...predPhases) + 1)
  }
  return phaseOf
}

// Group rows (tasks and gates) by phase number, preserve input order within
// each phase, attach the gate-info badge (a gate row carries its own).
function groupTasksByPhase(
  rows: Bead[],
  phaseOf: Map<string, number>,
  gateInfoByTask: Map<string, GateInfo>,
): MoleculePhase[] {
  const taskIndex = new Map<string, number>(rows.map((t, i) => [t.id, i]))
  const phaseMap = new Map<number, PhaseTask[]>()
  for (const row of rows) {
    const phase = phaseOf.get(row.id) || 1
    if (!phaseMap.has(phase)) phaseMap.set(phase, [])
    const gate = row.type === "gate" ? toGateInfo(row) : gateInfoByTask.get(row.id)
    phaseMap.get(phase)!.push({ ...row, gate })
  }
  const phaseNumbers = [...phaseMap.keys()].sort((a, b) => a - b)
  return phaseNumbers.map((num) => {
    const phaseTasks = phaseMap.get(num)!
    phaseTasks.sort((a, b) => (taskIndex.get(a.id) ?? 0) - (taskIndex.get(b.id) ?? 0))
    return {
      phaseNumber: num,
      tasks: phaseTasks,
      closedCount: phaseTasks.filter((t) => t.status === "closed").length,
      totalCount: phaseTasks.length,
    }
  })
}

export function computeMoleculePhases(children: Bead[]): MoleculePhase[] {
  const { gates, tasks, taskIds, gateIds } = splitGatesAndTasks(children)
  const gateToSourceTask = buildGateToSourceTask(gates, taskIds)
  const gateInfoByTask = buildGateInfoByTask(tasks, gates, gateIds)
  const taskPredecessors = buildTaskPredecessors(tasks, taskIds, gateIds, gateToSourceTask)
  const phaseOf = assignPhases(tasks, taskPredecessors)
  for (const [id, phase] of assignGatePhases(gates, tasks, phaseOf)) phaseOf.set(id, phase)
  return groupTasksByPhase(children, phaseOf, gateInfoByTask)
}

// beadbox-e04o.1: a nested molecule's steps (the root's step epics), each with
// its children as rows (no phasing: a step is a phase of the molecule, its
// children are not phased from Phase 1 on their own). Rows carry the same gate
// badge a flat phase row gets. beadbox-e04o.3: steps and rows come in the
// plan's order from orderMoleculeSteps, the same order the keyboard walks.
export interface StepGroup {
  step: Epic
  rows: PhaseTask[]
}

export function computeStepGroups(steps: Epic[]): StepGroup[] {
  return orderMoleculeSteps(steps).map(({ step, children }) => {
    const { gates, tasks, gateIds } = splitGatesAndTasks(children)
    const gateInfoByTask = buildGateInfoByTask(tasks, gates, gateIds)
    const rows = children.map((row) => ({
      ...row,
      gate: row.type === "gate" ? toGateInfo(row) : gateInfoByTask.get(row.id),
    }))
    return { step, rows }
  })
}
