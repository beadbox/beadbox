import { ArrowDownNarrowWide, CircleHelp, Columns2, ShieldCheck } from "lucide-react"
import { useMemo } from "react"
import type { FormulaStep, StepOverlay } from "../lib/types"
import { cn } from "../lib/utils"
import { StepCountBadge } from "./step-count-badge"
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip"

// ---------------------------------------------------------------------------
// Format description text: highlight {{variables}} and file paths
// ---------------------------------------------------------------------------

// Collapse single newlines into spaces, preserve double newlines as paragraph breaks
function collapseNewlines(text: string): string {
  return text
    .split(/\n{2,}/) // split on paragraph breaks
    .map((para) => para.replace(/\n/g, " ")) // collapse single newlines within each paragraph
    .join("\n\n") // rejoin with double newlines
}

const DESC_TOKEN_RE = /(\{\{[^}]+\}\}|(?:\/[\w./-]+|~\/[\w./-]+|\w+\/[\w./-]+)(?:\.\w+)?)/g

function formatDescription(text: string): React.ReactNode[] {
  const parts = text.split(DESC_TOKEN_RE)
  return parts.map((part, i) => {
    if (part.startsWith("{{")) {
      return (
        <span
          key={i}
          className="px-0.5 rounded bg-blue-900/30 text-blue-300 border border-blue-500/25"
        >
          {part.slice(2, -2)}
        </span>
      )
    }
    if (/^(\/|~\/|\w+\/)/.test(part) && part.includes("/")) {
      return (
        <span key={i} className="px-0.5 rounded bg-blue-900/20 text-blue-200">
          {part}
        </span>
      )
    }
    return <span key={i}>{part}</span>
  })
}

// ---------------------------------------------------------------------------
// Accent colors (same palette as DAG)
// ---------------------------------------------------------------------------

const ACCENT_COLORS = [
  "#22c55e",
  "#3b82f6",
  "#a855f7",
  "#f59e0b",
  "#ec4899",
  "#06b6d4",
  "#ef4444",
  "#84cc16",
]

const overlayStyles: Record<
  StepOverlay["status"],
  { bg: string; border: string; ring?: string; animate?: string }
> = {
  complete: { bg: "bg-green-500/10", border: "border-green-500/60", ring: "ring-green-500/30" },
  in_progress: {
    bg: "bg-blue-500/10",
    border: "border-blue-500/60",
    ring: "ring-blue-500/30",
    animate: "animate-pulse",
  },
  blocked: { bg: "bg-amber-500/10", border: "border-amber-500/60", ring: "ring-amber-500/30" },
  pending: { bg: "bg-card/50 opacity-60", border: "border-border/30" },
  failed: { bg: "bg-red-500/10", border: "border-red-500/60", ring: "ring-red-500/30" },
}

// ---------------------------------------------------------------------------
// Build tree from flat steps + dependency edges
// ---------------------------------------------------------------------------

interface TreeNode {
  step: FormulaStep
  stepIndex: number
  children: TreeNode[]
}

function buildTree(steps: FormulaStep[]): TreeNode[] {
  const stepMap = new Map(steps.map((s, i) => [s.id, { step: s, index: i }]))
  const childOf = new Map<string, string[]>()

  for (const step of steps) {
    for (const dep of step.needs ?? []) {
      const list = childOf.get(dep) ?? []
      list.push(step.id)
      childOf.set(dep, list)
    }
  }

  const roots = steps.filter((s) => !s.needs?.length)
  const placed = new Set<string>()

  function toNode(id: string): TreeNode | null {
    if (placed.has(id)) return null
    const entry = stepMap.get(id)
    if (!entry) return null

    placed.add(id)
    const childIds = childOf.get(id) ?? []
    const children = childIds.map((cid) => toNode(cid)).filter(Boolean) as TreeNode[]

    return { step: entry.step, stepIndex: entry.index, children }
  }

  return roots.map((r) => toNode(r.id)).filter(Boolean) as TreeNode[]
}

// ---------------------------------------------------------------------------
// Node card (same visual style as DAG nodes)
// ---------------------------------------------------------------------------

function NodeCard({
  step,
  stepIndex,
  selected,
  overlay,
  onClick,
}: {
  step: FormulaStep
  stepIndex: number
  selected?: boolean
  overlay?: StepOverlay
  onClick?: (stepId: string) => void
}) {
  const gateType = step.gate?.type
  const style = overlay ? overlayStyles[overlay.status] : null
  const accentColor = ACCENT_COLORS[stepIndex % ACCENT_COLORS.length]

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          data-step-id={step.id}
          onClick={() => onClick?.(step.id)}
          className={cn(
            "w-full rounded-lg border text-left transition-all overflow-hidden",
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
          <div className="flex">
            <div
              className="w-1 self-stretch shrink-0 rounded-l-lg"
              style={{ backgroundColor: style ? undefined : accentColor, opacity: style ? 0 : 0.7 }}
            />
            <div className="flex-1 min-w-0 px-3 pt-2 pb-3">
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2.5 min-w-0">
                  <span
                    className="text-[10px] font-mono font-bold shrink-0 w-5 h-5 rounded flex items-center justify-center"
                    style={{ backgroundColor: `${accentColor}20`, color: accentColor }}
                  >
                    {stepIndex + 1}
                  </span>
                  <span className="text-[17px] font-medium text-foreground truncate">
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
                  {overlay?.status === "complete" && (
                    <span className="text-[11px] px-1.5 py-0.5 rounded-full bg-green-500/15 text-green-400 border border-green-500/20">
                      completed
                    </span>
                  )}
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
              {step.description && (
                <p className="mt-1.5 w-full text-[14.3px] text-zinc-400 rounded-md bg-black/20 px-2.5 py-1.5 whitespace-pre-line">
                  {formatDescription(collapseNewlines(step.description.trim()).slice(0, 200))}
                  {step.description.trim().length > 400 ? "..." : ""}
                </p>
              )}
            </div>
          </div>
        </button>
      </TooltipTrigger>
      <TooltipContent side="right" className="max-w-xs">
        <p className="font-medium mb-1">{step.title}</p>
        {overlay && (
          <p className="text-xs text-muted-foreground mb-1">
            Status: {overlay.status.replace("_", " ")}
          </p>
        )}
        {step.description && (
          <p className="text-xs text-muted-foreground whitespace-pre-line line-clamp-6">
            {step.description.slice(0, 300)}
          </p>
        )}
      </TooltipContent>
    </Tooltip>
  )
}

// ---------------------------------------------------------------------------
// Sequential chain detection
// ---------------------------------------------------------------------------

// Collect a linear chain starting from a node: the node itself plus
// consecutive only-children. Stops when a node has 0 or 2+ children.
function collectChain(node: TreeNode): TreeNode[] {
  const chain: TreeNode[] = [node]
  let cur = node
  while (cur.children.length === 1 && !cur.children[0].step.gate) {
    cur = cur.children[0]
    chain.push(cur)
  }
  return chain
}

// ---------------------------------------------------------------------------
// Sequential group container
// ---------------------------------------------------------------------------

function SequentialGroup({
  chain,
  totalSteps,
  selectedStepId,
  overlay,
  onStepClick,
  depth,
}: {
  chain: TreeNode[]
  totalSteps: number
  selectedStepId?: string | null
  overlay?: Record<string, StepOverlay>
  onStepClick?: (stepId: string) => void
  depth: number
}) {
  const last = chain[chain.length - 1]

  return (
    <div
      className="rounded-xl border border-[#3f3f46] bg-[#1e1e21] shadow-[0_2px_8px_rgba(0,0,0,0.3)] p-3"
      style={{ width: "100%" }}
    >
      <div className="flex items-center gap-2 mb-2">
        <ArrowDownNarrowWide className="h-3 w-3 text-zinc-500" />
        <span className="text-[10px] font-mono font-bold uppercase tracking-wider text-zinc-500">
          Sequential
        </span>
        <span className="text-[10px] text-zinc-600">{chain.length} steps</span>
        <Tooltip>
          <TooltipTrigger asChild>
            <CircleHelp className="h-3 w-3 text-zinc-600 cursor-default" />
          </TooltipTrigger>
          <TooltipContent side="right" className="max-w-[220px] text-xs">
            These steps run one after another in order. Each must complete before the next begins.
          </TooltipContent>
        </Tooltip>
      </div>
      <div className="space-y-1.5">
        {chain.map((node) => (
          <div key={node.step.id} style={{ width: "100%" }}>
            <NodeCard
              step={node.step}
              stepIndex={node.stepIndex}
              selected={selectedStepId === node.step.id}
              overlay={overlay?.[node.step.title]}
              onClick={onStepClick}
            />
          </div>
        ))}
      </div>
      {/* Render the tail node's children (the node that broke the chain) */}
      {last.children.length > 0 && (
        <div className="mt-2">
          <TreeBranch
            nodes={last.children}
            totalSteps={totalSteps}
            selectedStepId={selectedStepId}
            overlay={overlay}
            onStepClick={onStepClick}
            depth={depth + 1}
            insideGroup
          />
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Parallel group container
// ---------------------------------------------------------------------------

function ParallelGroup({
  group,
  selectedStepId,
  overlay,
  onStepClick,
}: {
  group: TreeNode[]
  selectedStepId?: string | null
  overlay?: Record<string, StepOverlay>
  onStepClick?: (stepId: string) => void
}) {
  return (
    <div
      className="rounded-xl border border-[#3f3f46] bg-[#1e1e21] shadow-[0_2px_8px_rgba(0,0,0,0.3)] p-3"
      style={{ width: "100%" }}
    >
      <div className="flex items-center gap-2 mb-2">
        <Columns2 className="h-3 w-3 text-zinc-500" />
        <span className="text-[10px] font-mono font-bold uppercase tracking-wider text-zinc-500">
          Parallel
        </span>
        <span className="text-[10px] text-zinc-600">{group.length} tasks</span>
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
      <div className="space-y-1.5">
        {group.map((node) => (
          <div key={node.step.id} style={{ width: "100%" }}>
            <NodeCard
              step={node.step}
              stepIndex={node.stepIndex}
              selected={selectedStepId === node.step.id}
              overlay={overlay?.[node.step.title]}
              onClick={onStepClick}
            />
          </div>
        ))}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Gate group container
// ---------------------------------------------------------------------------

function GateGroup({
  group,
  selectedStepId,
  overlay,
  onStepClick,
}: {
  group: TreeNode[]
  selectedStepId?: string | null
  overlay?: Record<string, StepOverlay>
  onStepClick?: (stepId: string) => void
}) {
  return (
    <div
      className="rounded-xl border border-amber-500/30 bg-[#1e1e21] shadow-[0_2px_8px_rgba(0,0,0,0.3)] p-3"
      style={{ width: "100%" }}
    >
      <div className="flex items-center gap-2 mb-2">
        <ShieldCheck className="h-3 w-3 text-amber-500/70" />
        <span className="text-[10px] font-mono font-bold uppercase tracking-wider text-amber-500/70">
          Gate
        </span>
        <span className="text-[10px] text-zinc-600">
          {group.length} {group.length === 1 ? "checkpoint" : "checkpoints"}
        </span>
        <Tooltip>
          <TooltipTrigger asChild>
            <CircleHelp className="h-3 w-3 text-zinc-600 cursor-default" />
          </TooltipTrigger>
          <TooltipContent side="right" className="max-w-[220px] text-xs">
            A gate pauses the workflow until a condition is met (human approval or automated check).
          </TooltipContent>
        </Tooltip>
      </div>
      <div className="space-y-1.5">
        {group.map((node) => (
          <div key={node.step.id} style={{ width: "100%" }}>
            <NodeCard
              step={node.step}
              stepIndex={node.stepIndex}
              selected={selectedStepId === node.step.id}
              overlay={overlay?.[node.step.title]}
              onClick={onStepClick}
            />
          </div>
        ))}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Recursive tree branch with CSS connector lines
// ---------------------------------------------------------------------------

const INDENT = 28 // px per depth level
const LINE_COLOR = "rgb(113 113 122 / 0.35)" // zinc-500 at 35%

function TreeBranch({
  nodes,
  totalSteps,
  selectedStepId,
  overlay,
  onStepClick,
  depth,
  insideGroup,
}: {
  nodes: TreeNode[]
  totalSteps: number
  selectedStepId?: string | null
  overlay?: Record<string, StepOverlay>
  onStepClick?: (stepId: string) => void
  depth: number
  insideGroup?: boolean
}) {
  // Pre-process nodes: detect sequential chains and parallel leaf groups.
  // Skip grouping if we're already inside a group to avoid nesting.
  type RenderItem =
    | { type: "node"; node: TreeNode }
    | { type: "sequential"; chain: TreeNode[] }
    | { type: "parallel"; group: TreeNode[] }
    | { type: "gate"; group: TreeNode[] }

  const items: RenderItem[] = []
  const consumed = new Set<string>()

  if (!insideGroup) {
    // First pass: collect parallel leaf siblings (2+ consecutive childless nodes)
    let i = 0
    while (i < nodes.length) {
      if (nodes[i].children.length === 0) {
        // Scan ahead for consecutive leaves
        let j = i + 1
        while (j < nodes.length && nodes[j].children.length === 0) j++
        if (j - i >= 2) {
          const group = nodes.slice(i, j)
          for (const n of group) consumed.add(n.step.id)
          items.push({ type: "parallel", group })
          i = j
          continue
        }
      }
      i++
    }

    // Second pass: detect gate chains and sequential chains among remaining nodes
    for (const node of nodes) {
      if (consumed.has(node.step.id)) continue

      // Gate steps: wrap in a Gate container (single or chain of consecutive gates)
      if (node.step.gate) {
        const gateChain: TreeNode[] = [node]
        let cursor = node
        while (cursor.children.length === 1 && cursor.children[0].step.gate) {
          gateChain.push(cursor.children[0])
          cursor = cursor.children[0]
        }
        for (const c of gateChain) consumed.add(c.step.id)
        items.push({ type: "gate", group: gateChain })
        // Continue with the non-gate children if any
        if (cursor.children.length > 0) {
          for (const child of cursor.children) {
            if (!consumed.has(child.step.id)) {
              items.push({ type: "node", node: child })
              consumed.add(child.step.id)
            }
          }
        }
        continue
      }

      // Sequential chain (skip gate steps)
      if (node.children.length === 1 && !node.step.gate) {
        const chain = collectChain(node)
        if (chain.length >= 2) {
          for (const c of chain) consumed.add(c.step.id)
          items.push({ type: "sequential", chain })
          continue
        }
      }
      items.push({ type: "node", node })
    }
  } else {
    for (const node of nodes) {
      items.push({ type: "node", node })
    }
  }

  return (
    <ul className="list-none m-0 p-0">
      {items.map((item, i) => {
        const isLast = i === items.length - 1
        const key =
          item.type === "node"
            ? item.node.step.id
            : item.type === "sequential"
              ? `seq-${item.chain[0].step.id}`
              : `par-${item.group[0].step.id}`

        if (item.type === "parallel") {
          return (
            <li key={key} className="relative" style={{ paddingLeft: depth > 0 ? INDENT : 0 }}>
              {depth > 0 && (
                <div
                  className="absolute top-0"
                  style={{
                    left: 0,
                    width: 1,
                    height: isLast ? 21 : "100%",
                    backgroundColor: LINE_COLOR,
                  }}
                />
              )}
              {depth > 0 && (
                <div
                  className="absolute"
                  style={{
                    left: 0,
                    top: 21,
                    width: INDENT - 4,
                    height: 1,
                    backgroundColor: LINE_COLOR,
                  }}
                />
              )}
              <div className="py-1">
                <ParallelGroup
                  group={item.group}
                  selectedStepId={selectedStepId}
                  overlay={overlay}
                  onStepClick={onStepClick}
                />
              </div>
            </li>
          )
        }

        if (item.type === "gate") {
          return (
            <li key={key} className="relative" style={{ paddingLeft: depth > 0 ? INDENT : 0 }}>
              {depth > 0 && (
                <div
                  className="absolute top-0"
                  style={{
                    left: 0,
                    width: 1,
                    height: isLast ? 21 : "100%",
                    backgroundColor: LINE_COLOR,
                  }}
                />
              )}
              {depth > 0 && (
                <div
                  className="absolute"
                  style={{
                    left: 0,
                    top: 21,
                    width: INDENT - 4,
                    height: 1,
                    backgroundColor: LINE_COLOR,
                  }}
                />
              )}
              <div className="py-1">
                <GateGroup
                  group={item.group}
                  selectedStepId={selectedStepId}
                  overlay={overlay}
                  onStepClick={onStepClick}
                />
              </div>
            </li>
          )
        }

        if (item.type === "sequential") {
          return (
            <li key={key} className="relative" style={{ paddingLeft: depth > 0 ? INDENT : 0 }}>
              {depth > 0 && (
                <div
                  className="absolute top-0"
                  style={{
                    left: 0,
                    width: 1,
                    height: isLast ? 21 : "100%",
                    backgroundColor: LINE_COLOR,
                  }}
                />
              )}
              {depth > 0 && (
                <div
                  className="absolute"
                  style={{
                    left: 0,
                    top: 21,
                    width: INDENT - 4,
                    height: 1,
                    backgroundColor: LINE_COLOR,
                  }}
                />
              )}
              <div className="py-1">
                <SequentialGroup
                  chain={item.chain}
                  totalSteps={totalSteps}
                  selectedStepId={selectedStepId}
                  overlay={overlay}
                  onStepClick={onStepClick}
                  depth={depth}
                />
              </div>
            </li>
          )
        }

        const { node } = item
        const hasChildren = node.children.length > 0

        return (
          <li key={key} className="relative" style={{ paddingLeft: depth > 0 ? INDENT : 0 }}>
            {depth > 0 && (
              <div
                className="absolute top-0"
                style={{
                  left: 0,
                  width: 1,
                  height: isLast ? 21 : "100%",
                  backgroundColor: LINE_COLOR,
                }}
              />
            )}
            {depth > 0 && (
              <div
                className="absolute"
                style={{
                  left: 0,
                  top: 21,
                  width: INDENT - 4,
                  height: 1,
                  backgroundColor: LINE_COLOR,
                }}
              />
            )}
            <div className="py-1" style={{ width: "100%" }}>
              <NodeCard
                step={node.step}
                stepIndex={node.stepIndex}
                selected={selectedStepId === node.step.id}
                overlay={overlay?.[node.step.title]}
                onClick={onStepClick}
              />
            </div>
            {hasChildren && (
              <TreeBranch
                nodes={node.children}
                totalSteps={totalSteps}
                selectedStepId={selectedStepId}
                overlay={overlay}
                onStepClick={onStepClick}
                depth={depth + 1}
              />
            )}
          </li>
        )
      })}
    </ul>
  )
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

interface FormulaTreeProps {
  steps: FormulaStep[]
  selectedStepId?: string | null
  onStepClick?: (stepId: string) => void
  overlay?: Record<string, StepOverlay>
}

export function FormulaTree({ steps, selectedStepId, onStepClick, overlay }: FormulaTreeProps) {
  const tree = useMemo(() => buildTree(steps), [steps])

  if (steps.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center text-muted-foreground/40">
        No steps
      </div>
    )
  }

  return (
    <div className="flex-1 overflow-auto p-4">
      <TreeBranch
        nodes={tree}
        totalSteps={steps.length}
        selectedStepId={selectedStepId}
        overlay={overlay}
        onStepClick={onStepClick}
        depth={0}
      />
    </div>
  )
}
