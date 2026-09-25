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
  metadata?: Record<string, string>
  comments: Comment[]
  commentCount?: number
  parentId?: string
  createdAt?: Date
  updatedAt?: Date
  children?: Bead[] // Subtasks (nested parent-child relationships)
  blockedBy?: BeadDependency[] // Beads that must complete before this one
  blocks?: BeadDependency[] // Beads waiting on this one to complete
  orphanedFromEpic?: { id: string; title: string } // Set when parent epic is closed/archived
  rigName?: string // From routes.jsonl prefix matching, undefined for non-Gastown workspaces
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
}

export interface FormulaDetail {
  formula: string // formula name (may include {{var}} placeholders)
  description: string
  version: number
  type: string
  vars: Record<string, FormulaVariable>
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

// Step overlay data for coloring DAG nodes by molecule status
export interface StepOverlay {
  status: "complete" | "in_progress" | "blocked" | "pending" | "failed"
  assignee?: string
  updatedAt?: string
}
