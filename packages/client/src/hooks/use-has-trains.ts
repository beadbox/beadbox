import { useQuery } from "@tanstack/react-query"
import { rpc } from "@/lib/rpc"

/**
 * beadbox-if6: the Trains surface (header tab + Cmd/Ctrl+4) exists only when
 * the active workspace has .beadtrain files. A change event refetches it through
 * invalidateQueries(), so a plan file appearing or vanishing flips it live; the
 * live-update counter is not in the key, or every change would leave another
 * cached entry behind (beadbox-005).
 */
export function useHasTrains(dbPath: string | undefined): boolean {
  const query = useQuery({
    queryKey: ["trains-present", dbPath],
    queryFn: async () => {
      const result = await rpc.trains.hasTrains(dbPath)
      return result.success ? result.data : false
    },
    enabled: Boolean(dbPath),
  })
  return query.data === true
}
