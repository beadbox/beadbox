import {
  Controls,
  type Edge,
  Handle,
  type Node,
  type NodeTypes,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  useReactFlow,
} from "@xyflow/react"
import { useCallback, useEffect, useRef } from "react"
import "@xyflow/react/dist/style.css"
// Dynamic import: elkjs bundled build is CJS and must be lazy-loaded in client components
const getElk = () => import("elkjs/lib/elk.bundled.js").then((m) => new m.default())

import { ArrowDownNarrowWide, CircleHelp, Columns2, FlaskConical, ShieldCheck } from "lucide-react"
import type { FormulaStep, StepOverlay } from "../lib/types"
import { cn } from "../lib/utils"
import { StepCountBadge } from "./step-count-badge"
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip"

// ---------------------------------------------------------------------------
// ELK layout engine (singleton)
// ---------------------------------------------------------------------------

let elkInstance: Awaited<ReturnType<typeof getElk>> | null = null
async function getElkInstance() {
  if (!elkInstance) elkInstance = await getElk()
  return elkInstance
}

const ELK_OPTIONS = {
  "elk.algorithm": "layered",
  "elk.direction": "DOWN",
  "elk.spacing.nodeNode": "22",
  "elk.layered.spacing.nodeNodeBetweenLayers": "28",
  "elk.edgeRouting": "SPLINES",
  "elk.spacing.edgeNode": "80",
  "elk.spacing.edgeEdge": "20",
  "elk.layered.spacing.edgeNodeBetweenLayers": "60",
  "elk.layered.nodePlacement.strategy": "BRANDES_KOEPF",
  "elk.alignment": "CENTER",
  "elk.contentAlignment": "V_CENTER H_CENTER",
  // Respect input node order when assigning layers: lower-indexed steps placed higher
  "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
}

const NODE_WIDTH = 445
const NODE_HEIGHT = 40
const GROUP_ITEM_HEIGHT = 44
const GROUP_PADDING = 16
const TERMINAL_SIZE = 32

// ---------------------------------------------------------------------------
// Parallel group detection: 3+ steps with identical needs AND identical dependents
// ---------------------------------------------------------------------------

interface ParallelGroup {
  id: string // synthetic group id
  steps: FormulaStep[]
  stepIndices: number[]
  needs: string[] // shared needs
}

function detectParallelGroups(steps: FormulaStep[]): {
  groups: ParallelGroup[]
  ungrouped: FormulaStep[]
  ungroupedIndices: number[]
} {
  // Build a map of step id -> list of steps that depend on it
  const dependentsOf = new Map<string, string[]>()
  for (const s of steps) {
    for (const dep of s.needs ?? []) {
      const list = dependentsOf.get(dep) ?? []
      list.push(s.id)
      dependentsOf.set(dep, list)
    }
  }

  // Key: sorted needs + sorted dependents -> group of step indices
  const signatureMap = new Map<string, number[]>()
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i]
    const needs = [...(s.needs ?? [])].sort().join(",")
    const deps = [...(dependentsOf.get(s.id) ?? [])].sort().join(",")
    const key = `${needs}|${deps}`
    const list = signatureMap.get(key) ?? []
    list.push(i)
    signatureMap.set(key, list)
  }

  const groups: ParallelGroup[] = []
  const groupedIndices = new Set<number>()

  for (const indices of signatureMap.values()) {
    if (indices.length >= 2) {
      const groupSteps = indices.map((i) => steps[i])
      groups.push({
        id: `__group_${indices[0]}__`,
        steps: groupSteps,
        stepIndices: indices,
        needs: groupSteps[0].needs ?? [],
      })
      for (const i of indices) groupedIndices.add(i)
    }
  }

  const ungrouped: FormulaStep[] = []
  const ungroupedIndices: number[] = []
  for (let i = 0; i < steps.length; i++) {
    if (!groupedIndices.has(i)) {
      ungrouped.push(steps[i])
      ungroupedIndices.push(i)
    }
  }

  return { groups, ungrouped, ungroupedIndices }
}

// ---------------------------------------------------------------------------
// Sequential chain detection: 2+ steps forming a linear chain (each with
// exactly one parent and one child within the chain)
// ---------------------------------------------------------------------------

interface SequentialGroup {
  id: string
  steps: FormulaStep[]
  stepIndices: number[]
  headNeeds: string[] // needs of the first step in the chain (incoming edges)
}

// ---------------------------------------------------------------------------
// Gate group detection: consecutive gate steps in a linear chain get their
// own "Gate" container. Runs before sequential detection so gates are excluded.
// ---------------------------------------------------------------------------

interface GateGroup {
  id: string
  steps: FormulaStep[]
  stepIndices: number[]
  headNeeds: string[]
}

function buildChildrenMap(steps: FormulaStep[], exclude: Set<number>): Map<string, number[]> {
  const childrenOf = new Map<string, number[]>()
  for (let i = 0; i < steps.length; i++) {
    if (exclude.has(i)) continue
    for (const dep of steps[i].needs ?? []) {
      const list = childrenOf.get(dep) ?? []
      list.push(i)
      childrenOf.set(dep, list)
    }
  }
  return childrenOf
}

function detectGateChains(
  steps: FormulaStep[],
  alreadyGrouped: Set<number>,
): { gateGroups: GateGroup[]; gateGroupedIndices: Set<number> } {
  const idxById = new Map(steps.map((s, i) => [s.id, i]))
  const childrenOf = buildChildrenMap(steps, alreadyGrouped)

  const gateGroupedIndices = new Set<number>()
  const gateGroups: GateGroup[] = []

  for (let i = 0; i < steps.length; i++) {
    if (alreadyGrouped.has(i) || gateGroupedIndices.has(i)) continue
    if (!steps[i].gate) continue // only start from gate steps
    const chain: number[] = [i]
    let cursor = i
    while (true) {
      const kids = (childrenOf.get(steps[cursor].id) ?? []).filter(
        (k) => !alreadyGrouped.has(k) && !gateGroupedIndices.has(k),
      )
      if (kids.length !== 1) break
      const next = kids[0]
      if (!steps[next].gate) break // stop at non-gate
      const parentNeeds = (steps[next].needs ?? [])
        .map((id) => idxById.get(id))
        .filter((idx) => idx !== undefined && !alreadyGrouped.has(idx))
      if (parentNeeds.length !== 1) break
      chain.push(next)
      cursor = next
    }
    if (chain.length >= 1) {
      for (const idx of chain) gateGroupedIndices.add(idx)
      gateGroups.push({
        id: `__gate_${chain[0]}__`,
        steps: chain.map((idx) => steps[idx]),
        stepIndices: chain,
        headNeeds: steps[chain[0]].needs ?? [],
      })
    }
  }

  return { gateGroups, gateGroupedIndices }
}

function detectSequentialChains(
  steps: FormulaStep[],
  alreadyGrouped: Set<number>,
): { seqGroups: SequentialGroup[]; seqGroupedIndices: Set<number> } {
  const idxById = new Map(steps.map((s, i) => [s.id, i]))
  const childrenOf = buildChildrenMap(steps, alreadyGrouped)

  const seqGroupedIndices = new Set<number>()
  const seqGroups: SequentialGroup[] = []

  for (let i = 0; i < steps.length; i++) {
    if (alreadyGrouped.has(i) || seqGroupedIndices.has(i)) continue
    if (steps[i].gate) continue // gate steps go into gate groups, not sequential
    const chain: number[] = [i]
    let cursor = i
    while (true) {
      const kids = (childrenOf.get(steps[cursor].id) ?? []).filter((k) => !alreadyGrouped.has(k))
      if (kids.length !== 1) break
      const next = kids[0]
      if (seqGroupedIndices.has(next)) break
      if (steps[next].gate) break // don't absorb gate steps into sequential chains
      const parentNeeds = (steps[next].needs ?? [])
        .map((id) => idxById.get(id))
        .filter((idx) => idx !== undefined && !alreadyGrouped.has(idx))
      if (parentNeeds.length !== 1) break
      chain.push(next)
      cursor = next
    }
    if (chain.length >= 2) {
      for (const idx of chain) seqGroupedIndices.add(idx)
      seqGroups.push({
        id: `__seq_${chain[0]}__`,
        steps: chain.map((idx) => steps[idx]),
        stepIndices: chain,
        headNeeds: steps[chain[0]].needs ?? [],
      })
    }
  }

  return { seqGroups, seqGroupedIndices }
}

function groupNodeHeight(count: number): number {
  const headerHeight = 28 // "PARALLEL/SEQUENTIAL N steps" header
  return GROUP_PADDING * 2 + headerHeight + count * GROUP_ITEM_HEIGHT + (count - 1) * 4
}

async function runElkLayout(steps: FormulaStep[]): Promise<{ nodes: Node[]; edges: Edge[] }> {
  if (steps.length === 0) return { nodes: [], edges: [] }

  const {
    groups,
    ungrouped: _parUngrouped,
    ungroupedIndices: _parUngroupedIndices,
  } = detectParallelGroups(steps)

  // Detect gate chains among the parallel-ungrouped steps
  const parGroupedIndices = new Set<number>()
  for (const g of groups) for (const i of g.stepIndices) parGroupedIndices.add(i)
  const { gateGroups, gateGroupedIndices } = detectGateChains(steps, parGroupedIndices)

  // Detect sequential chains among remaining ungrouped steps
  const preSeqExcluded = new Set([...parGroupedIndices, ...gateGroupedIndices])
  const { seqGroups, seqGroupedIndices } = detectSequentialChains(steps, preSeqExcluded)

  // Final ungrouped = not in any group
  const allGroupedIndices = new Set([
    ...parGroupedIndices,
    ...gateGroupedIndices,
    ...seqGroupedIndices,
  ])
  const ungrouped: FormulaStep[] = []
  const ungroupedIndices: number[] = []
  for (let i = 0; i < steps.length; i++) {
    if (!allGroupedIndices.has(i)) {
      ungrouped.push(steps[i])
      ungroupedIndices.push(i)
    }
  }

  // Build set of grouped step ids for edge rewiring
  const groupedStepIds = new Map<string, string>() // stepId -> groupId
  for (const g of groups) {
    for (const s of g.steps) {
      groupedStepIds.set(s.id, g.id)
    }
  }
  // For sequential and gate groups, map all steps to the group id
  for (const sg of [...seqGroups, ...gateGroups]) {
    for (const s of sg.steps) {
      groupedStepIds.set(s.id, sg.id)
    }
  }

  // Find root steps and leaves (considering groups as single nodes)
  const allNodeIds = new Set([
    ...ungrouped.map((s) => s.id),
    ...groups.map((g) => g.id),
    ...gateGroups.map((gg) => gg.id),
    ...seqGroups.map((sg) => sg.id),
  ])

  // Build effective edges (rewire grouped steps to their group node)
  const effectiveNeeds = new Map<string, Set<string>>() // nodeId -> set of dependency nodeIds
  for (const s of ungrouped) {
    const needs = new Set<string>()
    for (const dep of s.needs ?? []) {
      needs.add(groupedStepIds.get(dep) ?? dep)
    }
    effectiveNeeds.set(s.id, needs)
  }
  for (const g of groups) {
    const needs = new Set<string>()
    for (const dep of g.needs) {
      const resolved = groupedStepIds.get(dep) ?? dep
      if (resolved !== g.id) needs.add(resolved) // don't self-reference
    }
    effectiveNeeds.set(g.id, needs)
  }
  // Sequential and gate group incoming edges come from head step's needs
  for (const sg of [...seqGroups, ...gateGroups]) {
    const needs = new Set<string>()
    for (const dep of sg.headNeeds) {
      const resolved = groupedStepIds.get(dep) ?? dep
      if (resolved !== sg.id) needs.add(resolved)
    }
    effectiveNeeds.set(sg.id, needs)
  }
  // Outgoing edges: steps depending on the tail resolve to the group id automatically

  const allEffectiveTargets = new Set<string>()
  for (const needs of effectiveNeeds.values()) {
    for (const n of needs) allEffectiveTargets.add(n)
  }

  const rootIds = [...allNodeIds].filter((id) => {
    const needs = effectiveNeeds.get(id)
    return !needs || needs.size === 0
  })
  const leafIds = [...allNodeIds].filter((id) => !allEffectiveTargets.has(id))

  // Build ELK children sorted by minimum step index so model order reflects step numbering.
  // ELK's considerModelOrder.strategy: "NODES_AND_EDGES" uses this input order for layer assignment.
  type ElkChild = { id: string; width: number; height: number; minIdx: number }
  const elkChildrenUnsorted: ElkChild[] = [
    ...ungrouped.map((s, idx) => ({
      id: s.id,
      width: NODE_WIDTH,
      height: NODE_HEIGHT,
      minIdx: ungroupedIndices[idx],
    })),
    ...groups.map((g) => ({
      id: g.id,
      width: NODE_WIDTH,
      height: groupNodeHeight(g.steps.length),
      minIdx: Math.min(...g.stepIndices),
    })),
    ...seqGroups.map((sg) => ({
      id: sg.id,
      width: NODE_WIDTH,
      height: groupNodeHeight(sg.steps.length),
      minIdx: Math.min(...sg.stepIndices),
    })),
    ...gateGroups.map((gg) => ({
      id: gg.id,
      width: NODE_WIDTH,
      height: groupNodeHeight(gg.steps.length),
      minIdx: Math.min(...gg.stepIndices),
    })),
  ]
  elkChildrenUnsorted.sort((a, b) => a.minIdx - b.minIdx)
  const elkChildren = [
    { id: "__start__", width: TERMINAL_SIZE, height: TERMINAL_SIZE },
    ...elkChildrenUnsorted.map(({ id, width, height }) => ({ id, width, height })),
    { id: "__end__", width: TERMINAL_SIZE, height: TERMINAL_SIZE },
  ]

  // Build ELK edges
  const elkEdgeSet = new Set<string>()
  const elkEdges: Array<{ id: string; sources: string[]; targets: string[] }> = []

  function addElkEdge(src: string, tgt: string) {
    const key = `${src}->${tgt}`
    if (elkEdgeSet.has(key)) return
    elkEdgeSet.add(key)
    elkEdges.push({ id: key, sources: [src], targets: [tgt] })
  }

  for (const id of rootIds) addElkEdge("__start__", id)
  for (const [nodeId, needs] of effectiveNeeds) {
    for (const dep of needs) addElkEdge(dep, nodeId)
  }
  for (const id of leafIds) addElkEdge(id, "__end__")

  // Push short side branches down: when a join node (multiple deps) has dependencies
  // at very different depths, add invisible edges so shallow branches are placed near
  // the join point instead of floating up to the fork point.
  //
  // For each join node, compute the max "graph depth" of its dependencies by walking
  // the longest path from __start__. Short branches (low depth, high step index) get
  // a constraint edge from the deepest sibling to push them down.
  const depthOf = new Map<string, number>()
  function computeDepth(id: string): number {
    if (depthOf.has(id)) return depthOf.get(id)!
    const needs = effectiveNeeds.get(id)
    if (!needs || needs.size === 0) {
      depthOf.set(id, 0)
      return 0
    }
    const maxParentDepth = Math.max(...[...needs].map((d) => computeDepth(d)))
    const depth = maxParentDepth + 1
    depthOf.set(id, depth)
    return depth
  }
  for (const id of allNodeIds) computeDepth(id)

  const invisibleEdges = new Set<string>()

  for (const [_nodeId, needs] of effectiveNeeds) {
    if (needs.size <= 1) continue
    // Find the deepest dependency (longest path from start)
    const depDepths = [...needs].map((d) => ({ id: d, depth: depthOf.get(d) ?? 0 }))
    depDepths.sort((a, b) => b.depth - a.depth)
    const deepest = depDepths[0]
    // For each shallower dependency, if the depth gap is > 1, add a constraint
    for (let i = 1; i < depDepths.length; i++) {
      const shallow = depDepths[i]
      if (deepest.depth - shallow.depth > 1) {
        const key = `${deepest.id}->${shallow.id}`
        if (!elkEdgeSet.has(key)) {
          elkEdgeSet.add(key)
          elkEdges.push({ id: key, sources: [deepest.id], targets: [shallow.id] })
          invisibleEdges.add(key)
        }
      }
    }
  }

  const elkGraph = {
    id: "root",
    layoutOptions: ELK_OPTIONS,
    children: elkChildren,
    edges: elkEdges,
  }

  const elk = await getElkInstance()
  const laid = await elk.layout(elkGraph)

  const startElk = laid.children?.find((c) => c.id === "__start__")
  const endElk = laid.children?.find((c) => c.id === "__end__")
  const edgeColor = "#52525b80" // zinc-600 at 50% opacity
  const edgeStyle = { stroke: edgeColor, strokeWidth: 1.5 }

  const nodes: Node[] = [
    {
      id: "__start__",
      type: "terminal",
      position: { x: startElk?.x ?? 0, y: startElk?.y ?? 0 },
      data: { label: "Start" },
    },
    ...ungrouped.map((s, idx) => {
      const elkNode = laid.children?.find((c) => c.id === s.id)
      const stepIndex = ungroupedIndices[idx]
      return {
        id: s.id,
        type: "step",
        position: { x: elkNode?.x ?? 0, y: elkNode?.y ?? 0 },
        data: { step: s, stepIndex, totalSteps: steps.length },
      }
    }),
    ...groups.map((g) => {
      const elkNode = laid.children?.find((c) => c.id === g.id)
      return {
        id: g.id,
        type: "stepGroup",
        position: { x: elkNode?.x ?? 0, y: elkNode?.y ?? 0 },
        data: { group: g, totalSteps: steps.length },
      }
    }),
    ...seqGroups.map((sg) => {
      const elkNode = laid.children?.find((c) => c.id === sg.id)
      return {
        id: sg.id,
        type: "seqGroup",
        position: { x: elkNode?.x ?? 0, y: elkNode?.y ?? 0 },
        data: { group: sg, totalSteps: steps.length },
      }
    }),
    ...gateGroups.map((gg) => {
      const elkNode = laid.children?.find((c) => c.id === gg.id)
      return {
        id: gg.id,
        type: "gateGroup",
        position: { x: elkNode?.x ?? 0, y: elkNode?.y ?? 0 },
        data: { group: gg, totalSteps: steps.length },
      }
    }),
    {
      id: "__end__",
      type: "terminal",
      position: { x: endElk?.x ?? 0, y: endElk?.y ?? 0 },
      data: { label: "End" },
    },
  ]

  const edges: Edge[] = elkEdges
    .filter(({ id }) => !invisibleEdges.has(id)) // hide constraint-only edges
    .map(({ id, sources, targets }) => ({
      id,
      source: sources[0],
      target: targets[0],
      type: "smoothstep",
      animated: false,
      markerEnd: { type: "arrowclosed" as const, color: edgeColor, width: 12, height: 12 },
      style: edgeStyle,
    }))

  return { nodes, edges }
}

// ---------------------------------------------------------------------------
// Overlay status -> visual styles
// ---------------------------------------------------------------------------

const overlayStyles: Record<
  StepOverlay["status"],
  { border: string; bg: string; ring: string; animate?: string }
> = {
  complete: { border: "border-green-500/60", bg: "bg-green-500/10", ring: "ring-green-500/30" },
  in_progress: {
    border: "border-blue-500/60",
    bg: "bg-blue-500/10",
    ring: "ring-blue-500/30",
    animate: "animate-pulse",
  },
  blocked: { border: "border-amber-500/60", bg: "bg-amber-500/10", ring: "ring-amber-500/30" },
  pending: { border: "border-border/30", bg: "bg-card/50 opacity-60", ring: "" },
  failed: { border: "border-red-500/60", bg: "bg-red-500/10", ring: "ring-red-500/30" },
}

// ---------------------------------------------------------------------------
// Custom step node for React Flow
// ---------------------------------------------------------------------------

// Accent color per step index (cycles through a palette)
const ACCENT_COLORS = [
  "#22c55e", // green
  "#3b82f6", // blue
  "#a855f7", // purple
  "#f59e0b", // amber
  "#ec4899", // pink
  "#06b6d4", // cyan
  "#ef4444", // red
  "#84cc16", // lime
]

interface StepNodeData {
  step: FormulaStep
  stepIndex: number
  totalSteps: number
  selected?: boolean
  overlay?: StepOverlay
  onClick?: (stepId: string) => void
}

function StepNodeComponent({ data }: { data: StepNodeData }) {
  const { step, stepIndex, selected, overlay, onClick } = data
  const gateType = step.gate?.type
  const style = overlay ? overlayStyles[overlay.status] : null
  const accentColor = ACCENT_COLORS[stepIndex % ACCENT_COLORS.length]

  return (
    <>
      <Handle
        type="target"
        position={Position.Top}
        className="!bg-zinc-500/50 !border-0 !w-1.5 !h-1.5"
      />
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            data-step-id={step.id}
            onClick={() => onClick?.(step.id)}
            className={cn(
              "w-[445px] rounded-lg border text-left transition-all overflow-hidden",
              "shadow-[0_2px_8px_rgba(0,0,0,0.3)]",
              style
                ? cn(style.bg, style.border, style.ring && `ring-1 ${style.ring}`, style.animate)
                : cn(
                    "bg-[#27272a] hover:bg-[#2e2e32]",
                    selected
                      ? "border-primary/50 ring-1 ring-primary/30"
                      : "border-[#3f3f46] hover:border-[#52525b]",
                  ),
              selected && style && "ring-2 ring-primary/40",
            )}
          >
            <div className="flex items-center">
              {/* Colored left accent bar */}
              <div
                className="w-1 self-stretch shrink-0 rounded-l-lg"
                style={{
                  backgroundColor: style ? undefined : accentColor,
                  opacity: style ? 0 : 0.7,
                }}
              />
              <div className="flex items-center justify-between gap-3 flex-1 min-w-0 px-3 py-2.5">
                <div className="flex items-center gap-2.5 min-w-0">
                  <span
                    className="text-[10px] font-mono font-bold shrink-0 w-5 h-5 rounded flex items-center justify-center"
                    style={{ backgroundColor: `${accentColor}20`, color: accentColor }}
                  >
                    {stepIndex + 1}
                  </span>
                  <span className="text-sm font-medium text-foreground truncate">
                    {step.title.split(/(\{\{[^}]+\}\})/).map((part, i) =>
                      part.startsWith("{{") ? (
                        <span
                          key={i}
                          className="text-[11.5px] font-mono px-1 py-0.5 rounded bg-blue-900/30 text-blue-300 border border-blue-500/25 mx-0.5"
                        >
                          {part.slice(2, -2)}
                        </span>
                      ) : (
                        <span key={i}>{part}</span>
                      ),
                    )}
                  </span>
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  <StepCountBadge stepId={step.id} />
                  {overlay?.assignee && (
                    <span className="text-[11px] px-1.5 py-0.5 rounded bg-[#1e1e21] text-muted-foreground">
                      @{overlay.assignee}
                    </span>
                  )}
                  {!overlay?.assignee && step.assignee && (
                    <span className="text-[11px] px-1.5 py-0.5 rounded bg-[#1e1e21] text-muted-foreground">
                      @{step.assignee}
                    </span>
                  )}
                  {gateType === "human" && (
                    <span className="text-[11px] px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-400 border border-amber-500/20">
                      human
                    </span>
                  )}
                  {gateType === "conditional" && (
                    <span className="text-[11px] px-1.5 py-0.5 rounded bg-blue-500/15 text-blue-400 border border-blue-500/20">
                      conditional
                    </span>
                  )}
                </div>
              </div>
            </div>
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="max-w-xs">
          <p className="font-medium mb-1">{step.title}</p>
          {overlay && (
            <p className="text-xs text-muted-foreground mb-1">
              Status: {overlay.status.replace("_", " ")}
              {overlay.updatedAt &&
                ` (updated ${new Date(overlay.updatedAt).toLocaleDateString()})`}
            </p>
          )}
          {step.description && (
            <p className="text-xs text-muted-foreground whitespace-pre-line line-clamp-6">
              {step.description.slice(0, 300)}
            </p>
          )}
        </TooltipContent>
      </Tooltip>
      <Handle
        type="source"
        position={Position.Bottom}
        className="!bg-zinc-500/50 !border-0 !w-1.5 !h-1.5"
      />
    </>
  )
}

interface StepGroupData {
  group: ParallelGroup
  totalSteps: number
  selectedStepId?: string | null
  overlay?: Record<string, StepOverlay>
  onClick?: (stepId: string) => void
}

function StepGroupNodeComponent({ data }: { data: StepGroupData }) {
  const { group, totalSteps: _totalSteps, selectedStepId, overlay: overlayMap, onClick } = data

  return (
    <>
      <Handle
        type="target"
        position={Position.Top}
        className="!bg-zinc-500/50 !border-0 !w-1.5 !h-1.5"
      />
      <div
        className="rounded-xl border border-[#3f3f46] bg-[#1e1e21] shadow-[0_2px_8px_rgba(0,0,0,0.3)]"
        style={{ width: NODE_WIDTH, padding: GROUP_PADDING }}
      >
        <div className="flex items-center gap-1.5 mb-2 px-1">
          <Columns2 className="h-3 w-3 text-zinc-500" />
          <span className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
            Parallel
          </span>
          <span className="text-[10px] text-zinc-600">{group.steps.length} tasks</span>
          <Tooltip>
            <TooltipTrigger asChild>
              <CircleHelp className="h-3 w-3 text-zinc-600 cursor-default" />
            </TooltipTrigger>
            <TooltipContent side="right" className="max-w-[220px] text-xs">
              These steps run in parallel. They share the same dependencies and can execute
              simultaneously.
            </TooltipContent>
          </Tooltip>
        </div>
        <div className="space-y-1">
          {group.steps.map((step, i) => {
            const stepIndex = group.stepIndices[i]
            const accentColor = ACCENT_COLORS[stepIndex % ACCENT_COLORS.length]
            const gateType = step.gate?.type
            const stepOverlay = overlayMap?.[step.title]
            const style = stepOverlay ? overlayStyles[stepOverlay.status] : null
            const isSelected = selectedStepId === step.id

            return (
              <Tooltip key={step.id}>
                <TooltipTrigger asChild>
                  <button
                    data-step-id={step.id}
                    onClick={() => onClick?.(step.id)}
                    className={cn(
                      "w-full rounded-md border text-left transition-all overflow-hidden",
                      style
                        ? cn(
                            style.bg,
                            style.border,
                            style.ring && `ring-1 ${style.ring}`,
                            style.animate,
                          )
                        : cn(
                            "bg-[#27272a] hover:bg-[#2e2e32]",
                            isSelected
                              ? "border-primary/50 ring-1 ring-primary/30"
                              : "border-[#3f3f46]/50 hover:border-[#52525b]",
                          ),
                      isSelected && style && "ring-2 ring-primary/40",
                    )}
                  >
                    <div className="flex items-center">
                      <div
                        className="w-1 self-stretch shrink-0 rounded-l-md"
                        style={{
                          backgroundColor: style ? undefined : accentColor,
                          opacity: style ? 0 : 0.7,
                        }}
                      />
                      <div className="flex items-center justify-between gap-2 flex-1 min-w-0 px-2.5 py-1.5">
                        <div className="flex items-center gap-2 min-w-0">
                          <span
                            className="text-[9px] font-mono font-bold shrink-0 w-4 h-4 rounded flex items-center justify-center"
                            style={{ backgroundColor: `${accentColor}20`, color: accentColor }}
                          >
                            {stepIndex + 1}
                          </span>
                          <span className="text-[13px] font-medium text-foreground truncate">
                            {step.title.split(/(\{\{[^}]+\}\})/).map((part, pi) =>
                              part.startsWith("{{") ? (
                                <span
                                  key={pi}
                                  className="text-[10.5px] font-mono px-0.5 py-0.5 rounded bg-blue-900/30 text-blue-300 border border-blue-500/25 mx-0.5"
                                >
                                  {part.slice(2, -2)}
                                </span>
                              ) : (
                                <span key={pi}>{part}</span>
                              ),
                            )}
                          </span>
                        </div>
                        <div className="flex items-center gap-1 shrink-0">
                          <StepCountBadge stepId={step.id} compact />
                          {stepOverlay?.assignee && (
                            <span className="text-[10px] px-1 py-0.5 rounded bg-[#1e1e21] text-muted-foreground">
                              @{stepOverlay.assignee}
                            </span>
                          )}
                          {!stepOverlay?.assignee && step.assignee && (
                            <span className="text-[10px] px-1 py-0.5 rounded bg-[#1e1e21] text-muted-foreground">
                              @{step.assignee}
                            </span>
                          )}
                          {gateType === "human" && (
                            <span className="text-[10px] px-1 py-0.5 rounded bg-amber-500/15 text-amber-400 border border-amber-500/20">
                              human
                            </span>
                          )}
                          {gateType === "conditional" && (
                            <span className="text-[10px] px-1 py-0.5 rounded bg-blue-500/15 text-blue-400 border border-blue-500/20">
                              conditional
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom" className="max-w-xs">
                  <p className="font-medium mb-1">{step.title}</p>
                  {step.description && (
                    <p className="text-xs text-muted-foreground whitespace-pre-line line-clamp-6">
                      {step.description.slice(0, 300)}
                    </p>
                  )}
                </TooltipContent>
              </Tooltip>
            )
          })}
        </div>
      </div>
      <Handle
        type="source"
        position={Position.Bottom}
        className="!bg-zinc-500/50 !border-0 !w-1.5 !h-1.5"
      />
    </>
  )
}

interface SeqGroupData {
  group: SequentialGroup
  totalSteps: number
  selectedStepId?: string | null
  overlay?: Record<string, StepOverlay>
  onClick?: (stepId: string) => void
}

function SeqGroupNodeComponent({ data }: { data: SeqGroupData }) {
  const { group, totalSteps: _totalSteps, selectedStepId, overlay: overlayMap, onClick } = data

  return (
    <>
      <Handle
        type="target"
        position={Position.Top}
        className="!bg-zinc-500/50 !border-0 !w-1.5 !h-1.5"
      />
      <div
        className="rounded-xl border border-[#3f3f46] bg-[#1e1e21] shadow-[0_2px_8px_rgba(0,0,0,0.3)]"
        style={{ width: NODE_WIDTH, padding: GROUP_PADDING }}
      >
        <div className="flex items-center gap-1.5 mb-2 px-1">
          <ArrowDownNarrowWide className="h-3 w-3 text-zinc-500" />
          <span className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
            Sequential
          </span>
          <span className="text-[10px] text-zinc-600">{group.steps.length} steps</span>
          <Tooltip>
            <TooltipTrigger asChild>
              <CircleHelp className="h-3 w-3 text-zinc-600 cursor-default" />
            </TooltipTrigger>
            <TooltipContent side="right" className="max-w-[220px] text-xs">
              These steps run one after another in order. Each must complete before the next begins.
            </TooltipContent>
          </Tooltip>
        </div>
        <div className="space-y-1">
          {group.steps.map((step, i) => {
            const stepIndex = group.stepIndices[i]
            const accentColor = ACCENT_COLORS[stepIndex % ACCENT_COLORS.length]
            const gateType = step.gate?.type
            const stepOverlay = overlayMap?.[step.title]
            const style = stepOverlay ? overlayStyles[stepOverlay.status] : null
            const isSelected = selectedStepId === step.id

            return (
              <Tooltip key={step.id}>
                <TooltipTrigger asChild>
                  <button
                    data-step-id={step.id}
                    onClick={() => onClick?.(step.id)}
                    className={cn(
                      "w-full rounded-md border text-left transition-all overflow-hidden",
                      style
                        ? cn(
                            style.bg,
                            style.border,
                            style.ring && `ring-1 ${style.ring}`,
                            style.animate,
                          )
                        : cn(
                            "bg-[#27272a] hover:bg-[#2e2e32]",
                            isSelected
                              ? "border-primary/50 ring-1 ring-primary/30"
                              : "border-[#3f3f46]/50 hover:border-[#52525b]",
                          ),
                      isSelected && style && "ring-2 ring-primary/40",
                    )}
                  >
                    <div className="flex items-center">
                      <div
                        className="w-1 self-stretch shrink-0 rounded-l-md"
                        style={{
                          backgroundColor: style ? undefined : accentColor,
                          opacity: style ? 0 : 0.7,
                        }}
                      />
                      <div className="flex items-center justify-between gap-2 flex-1 min-w-0 px-2.5 py-1.5">
                        <div className="flex items-center gap-2 min-w-0">
                          <span
                            className="text-[9px] font-mono font-bold shrink-0 w-4 h-4 rounded flex items-center justify-center"
                            style={{ backgroundColor: `${accentColor}20`, color: accentColor }}
                          >
                            {stepIndex + 1}
                          </span>
                          <span className="text-[13px] font-medium text-foreground truncate">
                            {step.title.split(/(\{\{[^}]+\}\})/).map((part, pi) =>
                              part.startsWith("{{") ? (
                                <span
                                  key={pi}
                                  className="text-[10.5px] font-mono px-0.5 py-0.5 rounded bg-blue-900/30 text-blue-300 border border-blue-500/25 mx-0.5"
                                >
                                  {part.slice(2, -2)}
                                </span>
                              ) : (
                                <span key={pi}>{part}</span>
                              ),
                            )}
                          </span>
                        </div>
                        <div className="flex items-center gap-1 shrink-0">
                          <StepCountBadge stepId={step.id} compact />
                          {stepOverlay?.assignee && (
                            <span className="text-[10px] px-1 py-0.5 rounded bg-[#1e1e21] text-muted-foreground">
                              @{stepOverlay.assignee}
                            </span>
                          )}
                          {!stepOverlay?.assignee && step.assignee && (
                            <span className="text-[10px] px-1 py-0.5 rounded bg-[#1e1e21] text-muted-foreground">
                              @{step.assignee}
                            </span>
                          )}
                          {gateType === "human" && (
                            <span className="text-[10px] px-1 py-0.5 rounded bg-amber-500/15 text-amber-400 border border-amber-500/20">
                              human
                            </span>
                          )}
                          {gateType === "conditional" && (
                            <span className="text-[10px] px-1 py-0.5 rounded bg-blue-500/15 text-blue-400 border border-blue-500/20">
                              conditional
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom" className="max-w-xs">
                  <p className="font-medium mb-1">{step.title}</p>
                  {step.description && (
                    <p className="text-xs text-muted-foreground whitespace-pre-line line-clamp-6">
                      {step.description.slice(0, 300)}
                    </p>
                  )}
                </TooltipContent>
              </Tooltip>
            )
          })}
        </div>
      </div>
      <Handle
        type="source"
        position={Position.Bottom}
        className="!bg-zinc-500/50 !border-0 !w-1.5 !h-1.5"
      />
    </>
  )
}

interface GateGroupData {
  group: GateGroup
  totalSteps: number
  selectedStepId?: string | null
  overlay?: Record<string, StepOverlay>
  onClick?: (stepId: string) => void
}

function GateGroupNodeComponent({ data }: { data: GateGroupData }) {
  const { group, totalSteps: _totalSteps, selectedStepId, overlay: overlayMap, onClick } = data

  return (
    <>
      <Handle
        type="target"
        position={Position.Top}
        className="!bg-zinc-500/50 !border-0 !w-1.5 !h-1.5"
      />
      <div
        className="rounded-xl border border-amber-500/30 bg-[#1e1e21] shadow-[0_2px_8px_rgba(0,0,0,0.3)]"
        style={{ width: NODE_WIDTH, padding: GROUP_PADDING }}
      >
        <div className="flex items-center gap-1.5 mb-2 px-1">
          <ShieldCheck className="h-3 w-3 text-amber-500/70" />
          <span className="text-[10px] font-semibold uppercase tracking-wider text-amber-500/70">
            Gate
          </span>
          <span className="text-[10px] text-zinc-600">
            {group.steps.length} {group.steps.length === 1 ? "checkpoint" : "checkpoints"}
          </span>
          <Tooltip>
            <TooltipTrigger asChild>
              <CircleHelp className="h-3 w-3 text-zinc-600 cursor-default" />
            </TooltipTrigger>
            <TooltipContent side="right" className="max-w-[220px] text-xs">
              A gate pauses the workflow until a condition is met (human approval or automated
              check).
            </TooltipContent>
          </Tooltip>
        </div>
        <div className="space-y-1">
          {group.steps.map((step, i) => {
            const stepIndex = group.stepIndices[i]
            const accentColor = ACCENT_COLORS[stepIndex % ACCENT_COLORS.length]
            const gateType = step.gate?.type
            const stepOverlay = overlayMap?.[step.title]
            const style = stepOverlay ? overlayStyles[stepOverlay.status] : null
            const isSelected = selectedStepId === step.id

            return (
              <Tooltip key={step.id}>
                <TooltipTrigger asChild>
                  <button
                    data-step-id={step.id}
                    onClick={() => onClick?.(step.id)}
                    className={cn(
                      "w-full rounded-md border text-left transition-all overflow-hidden",
                      style
                        ? cn(
                            style.bg,
                            style.border,
                            style.ring && `ring-1 ${style.ring}`,
                            style.animate,
                          )
                        : cn(
                            "bg-[#27272a] hover:bg-[#2e2e32]",
                            isSelected
                              ? "border-primary/50 ring-1 ring-primary/30"
                              : "border-[#3f3f46]/50 hover:border-[#52525b]",
                          ),
                      isSelected && style && "ring-2 ring-primary/40",
                    )}
                  >
                    <div className="flex items-center">
                      <div
                        className="w-1 self-stretch shrink-0 rounded-l-md"
                        style={{
                          backgroundColor: style ? undefined : accentColor,
                          opacity: style ? 0 : 0.7,
                        }}
                      />
                      <div className="flex items-center justify-between gap-2 flex-1 min-w-0 px-2.5 py-1.5">
                        <div className="flex items-center gap-2 min-w-0">
                          <span
                            className="text-[9px] font-mono font-bold shrink-0 w-4 h-4 rounded flex items-center justify-center"
                            style={{ backgroundColor: `${accentColor}20`, color: accentColor }}
                          >
                            {stepIndex + 1}
                          </span>
                          <span className="text-[13px] font-medium text-foreground truncate">
                            {step.title.split(/(\{\{[^}]+\}\})/).map((part, pi) =>
                              part.startsWith("{{") ? (
                                <span
                                  key={pi}
                                  className="text-[10.5px] font-mono px-0.5 py-0.5 rounded bg-blue-900/30 text-blue-300 border border-blue-500/25 mx-0.5"
                                >
                                  {part.slice(2, -2)}
                                </span>
                              ) : (
                                <span key={pi}>{part}</span>
                              ),
                            )}
                          </span>
                        </div>
                        <div className="flex items-center gap-1 shrink-0">
                          <StepCountBadge stepId={step.id} compact />
                          {stepOverlay?.assignee && (
                            <span className="text-[10px] px-1 py-0.5 rounded bg-[#1e1e21] text-muted-foreground">
                              @{stepOverlay.assignee}
                            </span>
                          )}
                          {!stepOverlay?.assignee && step.assignee && (
                            <span className="text-[10px] px-1 py-0.5 rounded bg-[#1e1e21] text-muted-foreground">
                              @{step.assignee}
                            </span>
                          )}
                          {gateType === "human" && (
                            <span className="text-[10px] px-1 py-0.5 rounded bg-amber-500/15 text-amber-400 border border-amber-500/20">
                              human
                            </span>
                          )}
                          {gateType === "conditional" && (
                            <span className="text-[10px] px-1 py-0.5 rounded bg-blue-500/15 text-blue-400 border border-blue-500/20">
                              conditional
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom" className="max-w-xs">
                  <p className="font-medium mb-1">{step.title}</p>
                  {step.description && (
                    <p className="text-xs text-muted-foreground whitespace-pre-line line-clamp-6">
                      {step.description.slice(0, 300)}
                    </p>
                  )}
                </TooltipContent>
              </Tooltip>
            )
          })}
        </div>
      </div>
      <Handle
        type="source"
        position={Position.Bottom}
        className="!bg-zinc-500/50 !border-0 !w-1.5 !h-1.5"
      />
    </>
  )
}

function TerminalNodeComponent({ data }: { data: { label: string } }) {
  const isStart = data.label === "Start"
  return (
    <>
      {!isStart && (
        <Handle
          type="target"
          position={Position.Top}
          className="!bg-zinc-500/50 !border-0 !w-1.5 !h-1.5"
        />
      )}
      <div className="w-8 h-8 rounded-full bg-[#27272a] border border-[#3f3f46] flex items-center justify-center shadow-[0_2px_8px_rgba(0,0,0,0.3)]">
        {isStart ? (
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
            <polygon points="3,1 10,6 3,11" fill="#71717a" />
          </svg>
        ) : (
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
            <rect x="2" y="2" width="8" height="8" rx="1" fill="#71717a" />
          </svg>
        )}
      </div>
      {isStart && (
        <Handle
          type="source"
          position={Position.Bottom}
          className="!bg-zinc-500/50 !border-0 !w-1.5 !h-1.5"
        />
      )}
    </>
  )
}

const nodeTypes: NodeTypes = {
  step: StepNodeComponent,
  stepGroup: StepGroupNodeComponent,
  seqGroup: SeqGroupNodeComponent,
  gateGroup: GateGroupNodeComponent,
  terminal: TerminalNodeComponent,
}

// ---------------------------------------------------------------------------
// Main DAG component
// ---------------------------------------------------------------------------

interface FormulaDagProps {
  steps: FormulaStep[]
  selectedStepId?: string | null
  onStepClick?: (stepId: string) => void
  overlay?: Record<string, StepOverlay> // keyed by step title
}

export function FormulaDag(props: FormulaDagProps) {
  if (props.steps.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center text-muted-foreground/40">
        <div className="text-center">
          <FlaskConical className="h-10 w-10 mx-auto mb-2 opacity-30" />
          <p className="text-sm">This formula has no steps defined</p>
        </div>
      </div>
    )
  }

  return (
    <ReactFlowProvider>
      <FormulaDagInner {...props} />
    </ReactFlowProvider>
  )
}

function FormulaDagInner({ steps, selectedStepId, onStepClick, overlay }: FormulaDagProps) {
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([] as Node[])
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([] as Edge[])
  const { setViewport } = useReactFlow()
  const containerRef = useRef<HTMLDivElement>(null)

  // Run ELK layout when steps change, then position viewport at top-center
  useEffect(() => {
    let cancelled = false
    runElkLayout(steps).then(({ nodes: n, edges: e }) => {
      if (cancelled) return
      setNodes(n)
      setEdges(e)

      // Compute bounding box and position viewport to show top-center
      requestAnimationFrame(() => {
        if (cancelled || !containerRef.current) return
        const { width: cw } = containerRef.current.getBoundingClientRect()
        let minX = Infinity,
          maxX = -Infinity
        for (const node of n) {
          minX = Math.min(minX, node.position.x)
          maxX = Math.max(maxX, node.position.x + NODE_WIDTH)
        }
        const graphWidth = maxX - minX
        const zoom = Math.min(1.1, (cw / (graphWidth + 80)) * 1.1)
        const x = (cw - graphWidth * zoom) / 2 - minX * zoom
        const y = 20 // small top padding
        setViewport({ x, y, zoom })
      })
    })
    return () => {
      cancelled = true
    }
  }, [steps, setNodes, setEdges, setViewport])

  // Update node data when selection, overlay, or onClick changes
  useEffect(() => {
    setNodes((prev) =>
      prev.map((n) => {
        if (n.type === "step") {
          const d = n.data as unknown as StepNodeData
          return {
            ...n,
            data: {
              ...n.data,
              selected: selectedStepId === d.step.id,
              overlay: overlay?.[d.step.title],
              onClick: onStepClick,
            },
          }
        }
        if (n.type === "stepGroup" || n.type === "seqGroup" || n.type === "gateGroup") {
          return {
            ...n,
            data: {
              ...n.data,
              selectedStepId,
              overlay,
              onClick: onStepClick,
            },
          }
        }
        return n
      }),
    )
  }, [selectedStepId, overlay, onStepClick, setNodes])

  // Handle node clicks via React Flow's native handler (more reliable than
  // button onClick inside custom nodes, which React Flow can intercept).
  const handleNodeClick = useCallback(
    (_event: React.MouseEvent, node: Node) => {
      if (!onStepClick) return
      if (node.type === "step" || node.type === "terminal") {
        onStepClick(node.id)
        return
      }
      // For group nodes, find clicked step via data-step-id attribute
      const target = _event.target as HTMLElement
      const stepEl = target.closest("[data-step-id]")
      if (stepEl) {
        const stepId = stepEl.getAttribute("data-step-id")
        if (stepId) onStepClick(stepId)
      }
    },
    [onStepClick],
  )

  return (
    <div ref={containerRef} className="flex-1 dag-dotgrid" style={{ minHeight: 200 }}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeClick={handleNodeClick}
        colorMode="dark"
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        panOnDrag
        panOnScroll
        zoomOnScroll
        minZoom={0.3}
        maxZoom={1.5}
        proOptions={{ hideAttribution: true }}
      >
        <Controls
          showInteractive={false}
          position="bottom-left"
          className="!bg-card !border-border/50 !rounded-lg !shadow-lg [&>button]:!bg-card [&>button]:!border-border/30 [&>button]:!text-muted-foreground [&>button:hover]:!bg-accent/50 [&>button]:!rounded-md [&>button]:!w-7 [&>button]:!h-7 [&>button>svg]:!fill-current"
        />
      </ReactFlow>
    </div>
  )
}
