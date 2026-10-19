// Where one `playwright test` run keeps everything (beadbox-r72.3).
//
// playwright.config.ts creates the run directory once (mkdtemp) and caches it
// in process.env.E2E_RUN_DIR, so global setup, every worker and teardown agree
// on it. Everything the harness creates lives under it: a scratch HOME, the
// template and per-worker Dolt data, workspaces, synthetic registries, sidecar
// logs and the test build. Two runs on one machine never share a path, and
// global teardown can find this run's processes by that path alone.

import { join } from "path"

export function runDir(): string {
  const dir = process.env.E2E_RUN_DIR
  if (!dir) throw new Error("[e2e] E2E_RUN_DIR is not set: run the suite through playwright.config.ts")
  return dir
}

export const runPaths = () => {
  const root = runDir()
  return {
    root,
    /** HOME for every process the harness spawns (bd, Dolt, the sidecar). */
    home: join(root, "home"),
    templateData: join(root, "template-dolt"),
    templateWorkspace: (name: string) => join(root, `template-ws-${name}`),
    worker: (index: number) => join(root, `worker-${index}`),
    clientDist: join(root, "client-dist"),
  }
}
