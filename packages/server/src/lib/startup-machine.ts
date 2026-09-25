// Source-local copy of lib/startup-machine.ts (P1.3 / bb-vy13.3).
// Rewrites: @/lib/types → ./types

import type { Workspace } from "./types"

export type Phase = "idle" | "checking" | "healthy" | "no_registry" | "error"

export type HealthError =
  | { kind: "bd_missing" }
  | { kind: "bd_outdated" }
  | { kind: "bd_version_too_old"; current: string; required: string }
  | {
      kind: "access_denied"
      host: string
      port?: number
      database: string
      user: string
      credentialKey: string
      passwordMapKey: string
    }
  | { kind: "server_unreachable"; host: string; port?: number }
  | { kind: "database_missing"; database: string }
  | { kind: "project_identity_mismatch"; database: string; localId: string; databaseId: string }
  | { kind: "schema_migration_needed"; workspacePath: string; missingColumn?: string }
  | { kind: "timeout" }
  | { kind: "unknown"; message: string; bdOutput: string }

export type MachineEvent =
  | { type: "BOOT" }
  | { type: "HEALTH_OK"; workspaces: Workspace[] }
  | { type: "HEALTH_FAIL"; error: HealthError }
  | { type: "NO_WORKSPACES" }
  | { type: "RETRY" }
  | { type: "WORKSPACE_CHANGED" }

export interface MachineState {
  phase: Phase
  workspaces: Workspace[]
  error: HealthError | null
}

export const INITIAL_STATE: MachineState = {
  phase: "idle",
  workspaces: [],
  error: null,
}

export function transition(state: MachineState, event: MachineEvent): MachineState {
  switch (state.phase) {
    case "idle":
      if (event.type === "BOOT") return { ...state, phase: "checking" }
      return state
    case "checking":
      if (event.type === "HEALTH_OK")
        return { ...state, phase: "healthy", workspaces: event.workspaces, error: null }
      if (event.type === "HEALTH_FAIL") return { ...state, phase: "error", error: event.error }
      if (event.type === "NO_WORKSPACES") return { ...state, phase: "no_registry" }
      return state
    case "error":
      if (event.type === "RETRY") return { ...state, phase: "checking", error: null }
      return state
    case "healthy":
      if (event.type === "WORKSPACE_CHANGED") return { ...state, phase: "checking" }
      return state
    case "no_registry":
      if (event.type === "WORKSPACE_CHANGED") return { ...state, phase: "checking" }
      return state
  }
}
