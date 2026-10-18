// The release guard for the test transport (beadbox-r72.2, systemdesign §7.2/§3.4).
//
// A headless test build (BEADBOX_TEST_TRANSPORT=1) carries src/lib/test-transport.ts,
// which drives the sidecar through a Playwright binding. No other build may
// carry a byte of it. The module is reached only by a dynamic import() that
// the build-time constant compiles out; this guard is the proof. It runs inside
// the build itself, so every path to a bundle is covered (tauri's
// beforeBuildCommand and the release workflows that call `bun run build`
// directly), and it fails the build, never the running app.

import type { Plugin } from "vite"

/** A name only src/lib/test-transport.ts spells, so it can be found in any output, sourcemaps included. */
export const TEST_TRANSPORT_MARKER = "__beadboxTestBridge"

/** The ONE place the flag is read. */
export function testTransportEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env.BEADBOX_TEST_TRANSPORT === "1"
}

type Output = { type: "chunk"; code: string } | { type: "asset"; source: string | Uint8Array }

/** The output files that carry the test transport: by content (code, assets, sourcemaps) or by chunk name. */
export function findTestTransport(bundle: Record<string, Output>): string[] {
  const decoder = new TextDecoder()
  return Object.entries(bundle)
    .filter(([fileName, output]) => {
      if (/test-transport/.test(fileName)) return true
      const text =
        output.type === "chunk"
          ? output.code
          : typeof output.source === "string"
            ? output.source
            : decoder.decode(output.source)
      return text.includes(TEST_TRANSPORT_MARKER)
    })
    .map(([fileName]) => fileName)
}

export function testTransportGuard(enabled: boolean): Plugin {
  return {
    name: "beadbox-test-transport-guard",
    apply: "build",
    generateBundle(_options, bundle) {
      if (enabled) return
      const offenders = findTestTransport(bundle as unknown as Record<string, Output>)
      if (offenders.length > 0) {
        this.error(
          `[test-transport-guard] this build has BEADBOX_TEST_TRANSPORT off, but the test transport ` +
            `is in ${offenders.join(", ")}. A release bundle must not carry it: it is reached only ` +
            "by the dynamic import() in src/lib/sidecar-transport.ts, behind __BEADBOX_TEST_TRANSPORT__.",
        )
      }
    },
  }
}
