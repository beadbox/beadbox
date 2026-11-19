// Test preload (wired via bunfig.toml's [test].preload). Sets up a
// minimal DOM environment so test files that transitively import
// posthog-js / react-dom / sonner don't crash at module-load time.
//
// We use happy-dom (already a devDep) instead of hand-rolled stubs
// because react-dom's module-level eval needs more DOM surface than is
// reasonable to mock by hand (style proxy, event prefix detection,
// HTMLElement, document.head etc.).
//
// bb-fjlv: the registered Window is the SINGLE source of DOM globals
// across every test file in the process. Test files MUST NOT create
// their own Window or reassign globalThis.document — doing so unbinds
// bun:test's beforeEach/afterEach hooks from the document the rest of
// the suite queries, surfacing as silent hook drops + cross-file DOM
// leaks (rc.8 retry hit this in custom-statuses-manager.test.tsx).
//
// bb-8w92: happy-dom 20 relocated `window.SyntaxError` / `Array` /
// `TypeError` into a VM-context bootstrap (`VMGlobalPropertyScript`)
// that needs a real `vm.createContext`. Bun's `node:vm` is a stub —
// `isContext` lies, the bootstrap never runs, and any `querySelector`
// call constructs `new this.window.SyntaxError(...)` unconditionally
// and crashes. `@happy-dom/global-registrator` is the supported API
// that performs the bootstrap correctly and exposes the full window
// onto globalThis, so we use it instead of `new Window()`.
import { GlobalRegistrator } from "@happy-dom/global-registrator"

if (!(globalThis as { document?: unknown }).document) {
  GlobalRegistrator.register()
}

const g = globalThis as unknown as Record<string, unknown>
g.requestAnimationFrame ??= ((cb: FrameRequestCallback) => {
  cb(0)
  return 0
}) as typeof requestAnimationFrame
g.IS_REACT_ACT_ENVIRONMENT ??= true

// beadbox-d6l: the archive double-click guard is module state shared by every
// row's archive button (it has to be: the second click lands on a different
// row). Reset it before each test, so archive clicks in one test never fall
// inside another test's guard window.
import { beforeEach } from "bun:test"
import { _resetArchiveClickGuard } from "../lib/archive-click-guard"

beforeEach(() => _resetArchiveClickGuard())
