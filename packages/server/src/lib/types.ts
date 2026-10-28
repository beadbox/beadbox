export type BeadType = string

// Core statuses that always exist
type CoreStatus = "open" | "in_progress" | "closed"

// BeadStatus can be a core status or any custom string
export type BeadStatus = CoreStatus | (string & {})
export type BeadPriority = "critical" | "high" | "medium" | "low" | "backlog"

export interface Comment {
  id: string
  author: string
  content: string
  timestamp: Date
}

export interface BeadDependency {
  id: string
  title: string
}

export interface Bead {
  id: string
  type: BeadType
  title: string
  description: string
  design?: string
  acceptanceCriteria?: string
  notes?: string
  externalRef?: string
  specId?: string
  dueAt?: Date
  deferUntil?: Date
  estimatedMinutes?: number
  status: BeadStatus
  priority: BeadPriority
  assignee: string
  labels?: string[]
  metadata?: Record<string, unknown>
  comments: Comment[]
  commentCount?: number
  parentId?: string
  createdAt?: Date
  updatedAt?: Date
  closedAt?: Date
  startedAt?: Date // bd's started_at; absent when bd recorded no start
  children?: Bead[] // Subtasks (nested parent-child relationships)
  blockedBy?: BeadDependency[] // Beads that must complete before this one
  blocks?: BeadDependency[] // Beads waiting on this one to complete
  orphanedFromEpic?: { id: string; title: string } // Set when parent epic is closed/archived
  rigName?: string // From routes.jsonl prefix matching, undefined for non-Gastown workspaces
  gateWait?: GateWait // Gate issues only: what bd says the gate waits on (beadbox-wya0.2)
}

/** What a gate issue waits on, from bd's await_type / await_id / timeout. */
export interface GateWait {
  awaitType: string // "human" | "timer" | "gh:run" | "gh:pr" | "bead"; "" if bd sent none
  awaitId?: string // gh run ID, PR number or bead ID; absent for human/timer
  deadline?: string // ISO; createdAt + timeout, when the gate has a timeout
}

export interface Epic extends Bead {
  children: Bead[]
  childEpics?: Epic[]
}

export type DoltMode = "embedded" | "server"

export interface Workspace {
  id: string
  name: string
  /** User-chosen emoji for the workspace tab; absent = default glyph. */
  icon?: string
  path?: string | null
  databasePath?: string
  registered?: boolean
  available?: boolean
  mode: DoltMode
  serverHost?: string
  serverPort?: number
  serverDatabase?: string
  serverUser?: string
  serverTls?: boolean
  metadataWarning?: string
}

export interface ActivityEvent {
  timestamp: string // ISO 8601
  type: "create" | "update" | "status" | "comment" | "delete"
  issue_id: string
  symbol: string // Display symbol: +, →, ✓, ✗, ⊘, 💬
  message: string // Human-readable one-line summary
  actor?: string // Who made the change (absent when not specified)
  old_status?: string // Status events only
  new_status?: string // Status events only
}

export interface WorkspaceCard extends Workspace {
  path: string | null
  databasePath: string
  stats?: {
    open: number
    inProgress: number
    error?: boolean
    errorMessage?: string
  }
}

export interface ServerDatabase {
  databaseName: string
  beadsPrefix: string
}

// Activity Dashboard types (cross-filter, agent state, pipeline)

type CrossFilterType = "agent" | "stage" | "bead" | null

export interface CrossFilter {
  type: CrossFilterType
  value: string | null
}

export interface AgentState {
  name: string
  lastEvent: ActivityEvent
  lastBeadId: string
  lastBeadTitle: string
  lastAction: string
  lastSeen: Date
  status: "active" | "quiet" | "silent"
}

export interface PipelineStage {
  name: string
  count: number
  beadIds: string[]
  displayIds: string[]
  overflow: number
  typeCounts: Record<string, number>
}

// Read state tracking for unread indicators
interface ReadStateEntry {
  viewedAt: string // ISO timestamp of last time user opened this bead
  commentCount: number // comment count at time of last view
}

export interface ReadState {
  [beadId: string]: ReadStateEntry
}

// Port scan types

export interface ScanResult {
  host: string
  port: number
}

// Molecule DAG visualization types

export interface MoleculeNode {
  id: string
  title: string
  status: BeadStatus
  type: BeadType
  gateType?: string // "human" | "timer" | "gh:run"
}

export interface MoleculeEdge {
  source: string // issue_id (depends on target)
  target: string // depends_on_id (must complete first)
}

export interface MoleculeGraph {
  nodes: MoleculeNode[]
  edges: MoleculeEdge[]
  rootId: string
}

// Formula types (from bd formula list/show --json)

export interface FormulaSummary {
  name: string
  type: string // e.g. "workflow"
  description?: string
  source: string // search path origin (file path)
  steps: number // count
  vars: number // count
}

export interface FormulaVariable {
  description?: string
  required?: boolean
  default?: string
}

export interface FormulaStep {
  id: string
  title: string
  type: string // e.g. "task"
  description?: string
  needs?: string[] // dependency step IDs
  assignee?: string
  gate?: { type: string; timeout?: string } // e.g. { type: "human", timeout: "3d" }
  // A nested formula's step holds its tasks here; their needs may name
  // children of other steps (beadbox-ptca.2). Absent on a flat formula.
  children?: FormulaStep[]
}

export interface FormulaDetail {
  formula: string // formula name (may include {{var}} placeholders)
  description: string
  version: number
  type: string
  // Absent, not {}, when the formula declares no variables: bd omits the key
  // for a missing or empty [vars] table (beadbox-vco).
  vars?: Record<string, FormulaVariable>
  steps: FormulaStep[]
  source?: string
}

// CookedFormula has the same shape as FormulaDetail (cook output matches show output)
export type CookedFormula = FormulaDetail

// Raw bd mol progress output (snake_case keys from CLI)
export interface MolProgressRaw {
  molecule_id: string
  molecule_title: string
  total: number
  completed: number
  in_progress: number
  percent: number
  current_step_id?: string
}

// Normalized molecule progress for UI consumption
export interface MolProgress {
  id: string
  name: string
  total: number
  completed: number
  inProgress: number
  percent: number
  currentStepId?: string
}

// Molecule card for listing in the Active Molecules section
export interface MoleculeCard {
  id: string
  title: string
  status: string
  assignee?: string
  createdAt: string
  updatedAt: string
}

// One bead of a poured molecule as the Formulas tab graph reads it
// (beadbox-ptca.1). needs lists the beads inside the same molecule that this
// one is blocked by; a need on a bead outside the molecule is dropped.
export interface MoleculeStepNode {
  id: string
  title: string
  type: string
  status: string
  needs: string[]
}

// A molecule step (a bead parented to the molecule root) with its children
// (the beads parented to it). A flat formula's steps have no children.
export interface MoleculeStep extends MoleculeStepNode {
  children: MoleculeStepNode[]
}

// closed/total of a molecule step's children, keyed by formula step id (beadbox-ptca.4)
export interface StepCount {
  closed: number
  total: number
}

// Step overlay data for coloring DAG nodes by molecule status
export interface StepOverlay {
  status: "complete" | "in_progress" | "blocked" | "pending" | "failed"
  assignee?: string
  updatedAt?: string
}

// Waiting view types (from `bd list --include-gates --json`)

// An open issue a gate keeps out of `bd ready`.
export interface GateHeldIssue {
  id: string
  title: string
  status: string
  issueType: string
  // Set when the issue is held only because an ancestor is gated: the ID of
  // that gated ancestor (an epic's children wait through the epic).
  via?: string
}

// An open gate: what waits, on what, since when.
export interface WaitingGate {
  id: string
  title: string
  description: string
  awaitType: string // "human" | "timer" | "gh:run" | "gh:pr" | "bead"; "" if bd sent none
  awaitId?: string // gh run ID, PR number or bead ID; absent for human/timer
  createdAt: string // ISO
  timeoutMs?: number // timer gates: bd's timeout (nanoseconds) in ms
  deadline?: string // ISO; createdAt + timeout, when the gate has a timeout
  held: GateHeldIssue[]
  // Set when held was cut by a bound (lib/gates.ts HELD_PER_GATE_CAP or
  // HELD_TOTAL_BUDGET): the gate holds more than is listed.
  heldTruncated?: boolean
}
