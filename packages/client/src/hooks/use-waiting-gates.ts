import { useQuery, useQueryClient } from "@tanstack/react-query"
import { useCallback } from "react"
import { rpc } from "@/lib/rpc"

function unwrap<T>(result: { success: true; data: T } | { success: false; error: string }): T {
  if (!result.success) throw new Error(result.error)
  return result.data
}

// Both Waiting queries live under this prefix, so one invalidation refreshes
// the list and the tab's presence together. A change event refetches both
// through invalidateQueries(); the live-update counter is not in the keys, or
// every change would leave another cached copy behind (beadbox-005).
const waitingKey = (dbPath: string | undefined) => ["waiting-gates", dbPath] as const

/**
 * Open gates for the active workspace, oldest first, with the issues they
 * hold. This is the full issue walk (`bd list --include-gates`): only the
 * Waiting view itself calls it.
 */
export function useWaitingGates(dbPath: string | undefined) {
  const query = useQuery({
    queryKey: [...waitingKey(dbPath), "list"],
    queryFn: async () => unwrap(await rpc.gates.listWaiting(dbPath)),
    enabled: Boolean(dbPath),
  })
  return { query, gates: query.data ?? [] }
}

/**
 * The Waiting surface (header tab + Cmd/Ctrl+6) exists only while the active
 * workspace has at least one open gate, the way Trains exists only with
 * .beadtrain files. Every view asks on every change event, so this is a
 * gates-only read (`bd gate list`), never the full list. A failed read counts
 * as none, and is not retried: a bd that cannot answer would fail again.
 */
export function useHasWaiting(dbPath: string | undefined): boolean {
  const query = useQuery({
    queryKey: [...waitingKey(dbPath), "presence"],
    queryFn: async () => unwrap(await rpc.gates.hasOpenGate(dbPath)),
    enabled: Boolean(dbPath),
    retry: false,
  })
  return query.data === true
}

/** Refetch the Waiting list and the tab's presence together, e.g. after a resolve. */
export function useRefreshWaiting(dbPath: string | undefined): () => Promise<void> {
  const queryClient = useQueryClient()
  return useCallback(
    () => queryClient.invalidateQueries({ queryKey: waitingKey(dbPath) }),
    [queryClient, dbPath],
  )
}
