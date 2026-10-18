// How the page reaches the sidecar (beadbox-r72.2, systemdesign §7.2).
//
// The Tauri app reaches it through tauri-plugin-js, as it always has. A
// headless test build (BEADBOX_TEST_TRANSPORT=1 at build time) reaches the
// same real sidecar through a Playwright binding, implemented in
// ./test-transport. That module is loaded only by the dynamic import() below,
// inside a branch whose condition is the build-time constant
// __BEADBOX_TEST_TRANSPORT__: in every other build the condition is the
// literal false, the branch is compiled out, and the build guard
// (vite-plugins/test-transport-guard.ts) fails the build if any of the module
// survives. Under bun test the constant is undefined, so the flag is off.

import type { UnlistenFn } from "@tauri-apps/api/event"
import {
  createChannel,
  getStatus,
  kill,
  onExit,
  spawn,
  onStderr as tauriOnStderr,
} from "tauri-plugin-js-api"
import type { RemoteApi, SidecarRuntime } from "./rpc"
import { isTauriRuntime } from "./tauri-runtime"

const SIDECAR_NAME = "beadbox-sidecar"

/** True only in a bundle built with BEADBOX_TEST_TRANSPORT=1. */
const TEST_TRANSPORT = typeof __BEADBOX_TEST_TRANSPORT__ === "boolean" && __BEADBOX_TEST_TRANSPORT__

type StderrListener = (name: string, callback: (data: string) => void) => Promise<UnlistenFn>

const tauriRuntime: SidecarRuntime = {
  onExit: (callback) => onExit(SIDECAR_NAME, callback),
  spawn: () => spawn(SIDECAR_NAME, { sidecar: SIDECAR_NAME }),
  kill: () => kill(SIDECAR_NAME),
  // getStatus rejects when no process is registered under the name.
  isRunning: () =>
    getStatus(SIDECAR_NAME).then(
      (status) => status.running,
      () => false,
    ),
  connect: async () => {
    const { api, channel, io } = await createChannel<Record<string, never>, RemoteApi>(SIDECAR_NAME)
    return {
      api,
      destroy: () => {
        try {
          void Promise.resolve(channel.destroy()).catch(() => {})
        } finally {
          void io.destroy().catch(() => {})
        }
      },
    }
  },
}

/** Every method loads the test module on first use; the module itself is never imported statically. */
function lazyTestTransport(): { runtime: SidecarRuntime; onStderr: StderrListener } {
  let loaded: ReturnType<typeof load> | null = null
  function load() {
    return import("./test-transport")
  }
  const module = () => {
    loaded ??= load()
    return loaded
  }
  return {
    runtime: {
      onExit: async (callback) => (await module()).runtime.onExit(callback),
      spawn: async () => (await module()).runtime.spawn(),
      kill: async () => (await module()).runtime.kill(),
      isRunning: async () => (await module()).runtime.isRunning?.() ?? false,
      connect: async () => (await module()).runtime.connect(),
    },
    onStderr: async (name, callback) => (await module()).onStderr(name, callback),
  }
}

const testTransport = TEST_TRANSPORT ? lazyTestTransport() : null

/** The sidecar runtime the sidecar manager in rpc.ts drives. */
export const runtime: SidecarRuntime = testTransport ? testTransport.runtime : tauriRuntime

/** Listen to the sidecar's stderr, one line per callback. */
export const onStderr: StderrListener = testTransport ? testTransport.onStderr : tauriOnStderr

/**
 * Whether there is a sidecar to talk to: the Tauri shell, or a test build's
 * binding. Gate rpc.* calls on this; gate native features on isTauriRuntime().
 */
export function hasSidecarTransport(): boolean {
  return isTauriRuntime() || TEST_TRANSPORT
}
