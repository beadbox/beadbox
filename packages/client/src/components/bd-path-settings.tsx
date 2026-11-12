import { QueryClientProvider, useMutation, useQuery } from "@tanstack/react-query"
import { useEffect, useId, useState } from "react"
import { queryClient } from "../lib/query-client"
import { RpcUnavailableError, rpc } from "../lib/rpc"
import { Button } from "./ui/button"
import { Input } from "./ui/input"

const key = ["bd-executable-path"]

/** Shared per-user executable controls for Settings and tool recovery screens. */
export function BdPathSettings({ onSaved }: { onSaved?: () => void | Promise<void> }) {
  return (
    <QueryClientProvider client={queryClient}>
      <BdPathForm onSaved={onSaved} />
    </QueryClientProvider>
  )
}

function BdPathForm({ onSaved }: { onSaved?: () => void | Promise<void> }) {
  const id = useId()
  const [path, setPath] = useState("")
  const selection = useQuery({
    queryKey: key,
    queryFn: () => rpc.bdSettings.getBdPath(),
    retry: false,
    staleTime: 0,
  })
  useEffect(() => {
    if (selection.data) setPath(selection.data.savedPath ?? "")
  }, [selection.data])
  const mutation = useMutation({
    mutationFn: (next: string | null) => rpc.bdSettings.setBdPath(next),
    onError: () => queryClient.invalidateQueries({ queryKey: key }),
    onSuccess: async (result) => {
      queryClient.setQueryData(key, result)
      setPath(result.savedPath ?? "")
      await queryClient.invalidateQueries()
      await onSaved?.()
    },
  })
  const data = selection.data
  const unavailable = selection.error instanceof RpcUnavailableError
  const error = mutation.error ?? selection.error
  const busy = mutation.isPending || selection.isPending || !data
  return (
    <section className="space-y-3 text-left">
      <h3 className="text-lg font-semibold">bd executable</h3>
      <p className="text-sm text-muted-foreground">Choose a bd executable for all workspaces.</p>
      {data && (
        <div className="text-sm space-y-1" role="status">
          <p>
            {data.source === "environment"
              ? "BD_PATH environment override"
              : data.source === "saved"
                ? "Saved path"
                : "Automatic detection"}
          </p>
          <p className="font-mono text-xs break-all">{data.resolvedPath}</p>
          {data.source === "environment" && (
            <p className="text-muted-foreground">
              BD_PATH takes priority over your saved path. Remove it from the launch environment to
              use your preference.
            </p>
          )}
        </div>
      )}
      <form
        onSubmit={(event) => {
          event.preventDefault()
          mutation.mutate(path)
        }}
        className="space-y-3"
      >
        <label htmlFor={id} className="text-sm font-medium">
          bd executable path
        </label>
        <Input
          id={id}
          value={path}
          onChange={(event) => setPath(event.target.value)}
          placeholder="Absolute path to bd"
          disabled={busy}
          spellCheck={false}
          autoComplete="off"
        />
        <div className="flex flex-wrap gap-2">
          <Button type="submit" size="sm" disabled={busy || !path}>
            Save bd path
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => mutation.mutate(null)}
          >
            Use automatic detection
          </Button>
        </div>
      </form>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {unavailable ? "Open Beadbox to configure its bd executable." : error.message}
        </p>
      )}
    </section>
  )
}
