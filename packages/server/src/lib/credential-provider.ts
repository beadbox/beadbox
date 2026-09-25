import type { ServerConnection } from "./workspace-registry"

// One sidecar-owned credential store for CLI, direct SQL, and bd serve.
// The host injects credentials at startup; they never enter the registry.
const workspacePasswords = new Map<string, string>()

for (const [key, value] of Object.entries(process.env)) {
  if (!key.startsWith("BEADBOX_CRED_") || !value) continue
  const encoded = key.slice("BEADBOX_CRED_".length)
  let credentialKey: string
  try {
    credentialKey = decodeURIComponent(encoded)
  } catch {
    continue
  }
  workspacePasswords.set(credentialKey, value)
}

export function setWorkspacePassword(workspacePath: string, password: string): void {
  workspacePasswords.set(workspacePath, password)
}

export function clearWorkspacePassword(workspacePath: string): void {
  workspacePasswords.delete(workspacePath)
}

export function getWorkspacePassword(workspacePath: string): string | undefined {
  const exact = workspacePasswords.get(workspacePath)
  if (exact) return exact
  const segments = workspacePath.split("/")
  if (segments.length === 3 && !workspacePath.startsWith("/")) {
    return workspacePasswords.get(segments.slice(0, 2).join("/"))
  }
  // Older callers use host:port/database. Only accept that lookup when one
  // user-specific credential exists; choosing one of several is unsafe.
  if (workspacePath.startsWith("/") || segments.length !== 2) return undefined
  const candidates = [...workspacePasswords.entries()].filter(([key]) =>
    key.startsWith(`${workspacePath}/`),
  )
  return candidates.length === 1 ? candidates[0]?.[1] : undefined
}

export function buildServerEnv(
  server: ServerConnection,
  password?: string,
): Record<string, string> {
  const env: Record<string, string> = {
    BEADS_DOLT_SERVER_HOST: server.host,
    BEADS_DOLT_SERVER_PORT: server.port.toString(),
    BEADS_DOLT_SERVER_DATABASE: server.database,
    BEADS_DOLT_SERVER_USER: server.user,
    BEADS_DOLT_SERVER_TLS: server.tls ? "1" : "",
  }
  if (password) env.BEADS_DOLT_PASSWORD = password
  return env
}
