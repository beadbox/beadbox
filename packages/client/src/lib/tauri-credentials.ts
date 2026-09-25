/**
 * Thin wrapper around Tauri keychain commands (set/get/delete_credential).
 * In web mode (non-Tauri), all operations silently no-op.
 * Errors are logged but never thrown, so keychain failures never block workspace operations.
 */

const SERVICE = "beadbox"

function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window
}

export async function storeCredential(credentialKey: string, password: string): Promise<void> {
  if (!isTauri() || !credentialKey || !password) return
  try {
    const { invoke } = await import("@tauri-apps/api/core")
    await invoke("set_credential", { service: SERVICE, account: credentialKey, password })
  } catch (err) {
    console.warn("[tauri-credentials] failed to store credential:", err)
  }
}

export async function deleteCredential(credentialKey: string): Promise<void> {
  if (!isTauri() || !credentialKey) return
  try {
    const { invoke } = await import("@tauri-apps/api/core")
    await invoke("delete_credential", { service: SERVICE, account: credentialKey })
  } catch (err) {
    console.warn("[tauri-credentials] failed to delete credential:", err)
  }
}

/**
 * Read one saved password from the keychain. Returns null when there is no
 * item (or outside Tauri) rather than throwing: a missing password is the
 * normal case for a server that has none.
 */
export async function getCredential(credentialKey: string): Promise<string | null> {
  if (!isTauri() || !credentialKey) return null
  try {
    const { invoke } = await import("@tauri-apps/api/core")
    return await invoke<string>("get_credential", { service: SERVICE, account: credentialKey })
  } catch {
    return null
  }
}

type PasswordApi = {
  workspaces: {
    getSavedCredentialKeys: () => Promise<Array<{ credentialKey: string; passwordMapKey: string }>>
    setServerPassword: (passwordMapKey: string, password: string) => Promise<void>
  }
}

/**
 * Hand every saved server password to the sidecar (beadbox-ct1). The keychain
 * write always worked, but nothing read it back, so each relaunch re-prompted.
 * Runs on every new sidecar session, because a fresh sidecar process starts
 * with an empty password map. Logs keys only, never a password.
 */
export async function hydrateSavedPasswords(
  api: PasswordApi,
  read: (credentialKey: string) => Promise<string | null> = getCredential,
): Promise<void> {
  const keys = await api.workspaces.getSavedCredentialKeys()
  for (const { credentialKey, passwordMapKey } of keys) {
    try {
      const password = await read(credentialKey)
      if (password) await api.workspaces.setServerPassword(passwordMapKey, password)
    } catch (err) {
      console.warn(
        `[tauri-credentials] could not restore the saved password for ${credentialKey}:`,
        err,
      )
    }
  }
}
