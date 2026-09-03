// bb-ystl.1: import-sweep test for representative coverage measurement.
//
// Bun's --coverage only counts files imported by tests. Without this
// sweep, the packages/client coverage number is misleading (only 4 of
// 120 source files were instrumented in the bb-mf0h baseline).
//
// This file imports every src/ module that isn't a test, mock, or
// auto-generated artifact (routeTree.gen.ts is rebuilt by Vite's
// TanStackRouter plugin and shouldn't count). main.tsx is also
// excluded — it's the app entry, mounts React + spawns the rpc
// channel at module eval, which has side effects no unit test
// should trigger. Each import causes Bun to instrument the module;
// module-level code (imports, constants, top-level type erasure)
// registers as covered, while functions inside modules but not
// called by any test still register as uncovered. Net: gives a
// representative denominator for the % lines / % funcs numbers
// reported in client-rebaseline.md.
//
// REGEN: after adding/removing source files, re-run the QD baseline
// regen procedure (see docs/quality/2026-04-26/client-rebaseline.md).
//

import { describe, expect, test } from "bun:test"

import * as m0 from "../components/activity-feed"
import * as m1 from "../components/activity-feed-renderers"
import * as m2 from "../components/activity-page"
import * as m3 from "../components/add-workspace-dialog"
import * as m4 from "../components/agent-strip"
import * as m5 from "../components/bead-comments-section"
import * as m6 from "../components/bead-dependencies-display"
import * as m7 from "../components/bead-detail-helpers"
import * as m8 from "../components/bead-detail-panel"
import * as m9 from "../components/bead-expanded-view-modal"
import * as m10 from "../components/bead-metadata-controls"
import * as m11 from "../components/bead-scheduling-controls"
import * as m12 from "../components/bead-table"
import * as m13 from "../components/beadbox-logo"
import * as m14 from "../components/copyable-command"
import * as m15 from "../components/copyable-id"
import * as m16 from "../components/custom-statuses-manager"
import * as m17 from "../components/dev-badge"
import * as m18 from "../components/dev-console"
import * as m19 from "../components/dev-console-commands"
import * as m20 from "../components/edit-connection-dialog"
import * as m21 from "../components/epic-tree"
import * as m22 from "../components/epic-tree-skeleton"
import * as m23 from "../components/expanded-comment-modal"
import * as m24 from "../components/filter-bar"
import * as m25 from "../components/formula-dag"
import * as m26 from "../components/formula-pour-modal"
import * as m27 from "../components/formula-preview-modal"
import * as m28 from "../components/formula-step-detail"
import * as m29 from "../components/formula-tree"
import * as m30 from "../components/formulas-view"
import * as m31 from "../components/header"
import * as m32 from "../components/help-fab"
import * as m33 from "../components/home-page"
import * as m34 from "../components/incompatibility-banner"
import * as m35 from "../components/init-workspace-dialog"
import * as m36 from "../components/load-error-overlay"
import * as m37 from "../components/molecule-dag"
import * as m38 from "../components/molecule-phase-view"
import * as m39 from "../components/onboarding-hero"
import * as m40 from "../components/pipeline-flow"
import * as m41 from "../components/settings-dialog"
import * as m42 from "../components/simple-markdown"
import * as m43 from "../components/spec-viewer-modal"
import * as m44 from "../components/startup-gate"
import * as m45 from "../components/ui/alert-dialog"
import * as m46 from "../components/ui/badge"
import * as m47 from "../components/ui/button"
import * as m48 from "../components/ui/checkbox"
import * as m49 from "../components/ui/collapsible"
import * as m50 from "../components/ui/dialog"
import * as m51 from "../components/ui/dropdown-menu"
import * as m52 from "../components/ui/input"
import * as m53 from "../components/ui/popover"
import * as m54 from "../components/ui/progress"
import * as m55 from "../components/ui/resizable"
import * as m56 from "../components/ui/scroll-area"
import * as m57 from "../components/ui/select"
import * as m58 from "../components/ui/skeleton"
import * as m59 from "../components/ui/sonner"
import * as m60 from "../components/ui/spinner"
import * as m61 from "../components/ui/textarea"
import * as m62 from "../components/ui/toggle"
import * as m63 from "../components/ui/toggle-group"
import * as m64 from "../components/ui/tooltip"
import * as m65 from "../components/update-dialog"
import * as m66 from "../components/workspace-card"
import * as m67 from "../components/workspace-error-screen"
import * as m68 from "../components/workspace-rail"
import * as m69 from "../components/workspace-rail-panel"
import * as m70 from "../components/workspace-tab-dialog"
import * as m71 from "../components/workspaces-page"
import * as m72 from "../hooks/use-active-workspace"
import * as m73 from "../hooks/use-app-health"
import * as m74 from "../hooks/use-bead-actions"
import * as m75 from "../hooks/use-bead-mutations"
import * as m76 from "../hooks/use-comment-navigation"
import * as m77 from "../hooks/use-cross-filter"
import * as m78 from "../hooks/use-dev-console"
import * as m79 from "../hooks/use-epic-navigation"
import * as m80 from "../hooks/use-preferences"
import * as m81 from "../hooks/use-update-checker"
import * as m82 from "../hooks/use-update-downloader"
import * as m83 from "../hooks/use-viewport"
import * as m84 from "../hooks/use-workspace-label-sync"
import * as m85 from "../hooks/use-workspace-lifecycle"
import * as m86 from "../hooks/use-workspace-rail"
import * as m87 from "../lib/activity-bulk-operations"
import * as m88 from "../lib/activity-filters"
import * as m89 from "../lib/activity-message-utils"
import * as m90 from "../lib/activity-storage"
import * as m91 from "../lib/activity-time-utils"
import * as m92 from "../lib/activity-utils"
import * as m93 from "../lib/ai-cli-types"
import * as m94 from "../lib/badge-config"
import * as m95 from "../lib/bd-error"
import * as m96 from "../lib/capture-action-failed"
import * as m97 from "../lib/console-types"
import * as m98 from "../lib/epic-cache"
import * as m99 from "../lib/epic-navigation-keys"
import * as m100 from "../lib/epic-progress"
import * as m101 from "../lib/epic-tree-utils"
import * as m102 from "../lib/local-storage"
import * as m103 from "../lib/molecule-phases"
import * as m104 from "../lib/posthog-provider"
import * as m105 from "../lib/query-client"
import * as m106 from "../lib/rpc"
import * as m107 from "../lib/scrub-pii"
import * as m108 from "../lib/silence-three-clock-warn"
import * as m109 from "../lib/sort"
import * as m110 from "../lib/startup-machine"
import * as m111 from "../lib/status-validation"
import * as m112 from "../lib/subscribe"
import * as m113 from "../lib/tauri-credentials"
import * as m114 from "../lib/types"
import * as m115 from "../lib/update-checker"
import * as m116 from "../lib/use-version"
import * as m117 from "../lib/utils"
import * as m118 from "../lib/version-requirements"
import * as m119 from "../lib/window-bd"
import * as m120 from "../lib/workspace-actions"
import * as m121 from "../lib/workspace-cookie"
import * as m122 from "../lib/workspace-labels"
import * as m123 from "../lib/workspace-session-cache"
import * as m124 from "../routes/__root"
import * as m125 from "../routes/activity"
import * as m126 from "../routes/formulas"
import * as m127 from "../routes/index"
import * as m128 from "../routes/workspaces"

describe("client source coverage import sweep (bb-ystl.1)", () => {
  test("loads every non-test source module so Bun --coverage instruments them", () => {
    const modules = [
      m0,
      m1,
      m2,
      m3,
      m4,
      m5,
      m6,
      m7,
      m8,
      m9,
      m10,
      m11,
      m12,
      m13,
      m14,
      m15,
      m16,
      m17,
      m18,
      m19,
      m20,
      m21,
      m22,
      m23,
      m24,
      m25,
      m26,
      m27,
      m28,
      m29,
      m30,
      m31,
      m32,
      m33,
      m34,
      m35,
      m36,
      m37,
      m38,
      m39,
      m40,
      m41,
      m42,
      m43,
      m44,
      m45,
      m46,
      m47,
      m48,
      m49,
      m50,
      m51,
      m52,
      m53,
      m54,
      m55,
      m56,
      m57,
      m58,
      m59,
      m60,
      m61,
      m62,
      m63,
      m64,
      m65,
      m66,
      m67,
      m68,
      m69,
      m70,
      m71,
      m72,
      m73,
      m74,
      m75,
      m76,
      m77,
      m78,
      m79,
      m80,
      m81,
      m82,
      m83,
      m84,
      m85,
      m86,
      m87,
      m88,
      m89,
      m90,
      m91,
      m92,
      m93,
      m94,
      m95,
      m96,
      m97,
      m98,
      m99,
      m100,
      m101,
      m102,
      m103,
      m104,
      m105,
      m106,
      m107,
      m108,
      m109,
      m110,
      m111,
      m112,
      m113,
      m114,
      m115,
      m116,
      m117,
      m118,
      m119,
      m120,
      m121,
      m122,
      m123,
      m124,
      m125,
      m126,
      m127,
      m128,
    ]
    expect(modules).toHaveLength(129)
    for (const m of modules) {
      expect(m).toBeDefined()
    }
  })
})
