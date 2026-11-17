import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { extname, join } from "node:path"
import {
  COLOR_KEYS,
  cssVarName,
  TEXT_DERIVED_KEYS,
  TONE_KEYS,
  toneTextVarName,
} from "@beadbox/server/theme-tokens"

const css = readFileSync(join(import.meta.dir, "../index.css"), "utf-8")
const html = readFileSync(join(import.meta.dir, "../../index.html"), "utf-8")

describe("index.css theme indirection", () => {
  test("every colour token dereferences a --bb-* variable", () => {
    for (const key of COLOR_KEYS) {
      const cssKey = key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)
      expect(css).toContain(`--color-${cssKey}: var(${cssVarName(key)})`)
    }
  })

  test("every --bb-* colour has a :root default", () => {
    for (const key of COLOR_KEYS) {
      expect(css).toMatch(new RegExp(`${cssVarName(key)}:\\s*#[0-9a-fA-F]{6}`))
    }
  })

  test("the superseded nested theme blocks are gone", () => {
    expect(css).not.toContain(".dark.theme-gray")
    expect(css).not.toContain(".dark.theme-green")
  })

  test("no baked literal remains on a --color-* token", () => {
    const themeBlock = css.slice(css.indexOf("@theme inline"))
    const bakedColor = /--color-[a-z-]+:\s*#[0-9a-fA-F]{6}/.exec(themeBlock)
    expect(bakedColor).toBeNull()
  })
})

describe("index.html", () => {
  test("keeps dark as the pre-hydration default and drops theme-gray", () => {
    expect(html).toContain('class="dark"')
    expect(html).not.toContain("theme-gray")
  })
})

describe("regression: no bare --token var() references survive in client source", () => {
  // Deleting `.dark.theme-gray` orphans any consumer still dereferencing a
  // bare colour token (no `bb-` prefix) instead of its `--bb-*` form. The
  // dormant `:root` oklch block and the slate-palette `.dark` block that
  // used to catch such a reference are themselves gone (Fix 7, final
  // whole-branch review): a bare token now resolves to nothing (an unset
  // custom property), not to some other palette. This walks every
  // .ts/.tsx/.css file under src/ and fails if any of the 19 colour token
  // names is referenced bare (without the `bb-` prefix), guarding against
  // reintroduction.
  const srcDir = join(import.meta.dir, "..")
  const scannedExtensions = new Set([".ts", ".tsx", ".css"])
  const tokenAlternation = COLOR_KEYS.map((key) =>
    key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`),
  ).join("|")
  const bareVarPattern = new RegExp(`var\\(--(${tokenAlternation})\\)`)

  function collectFiles(dir: string): string[] {
    const files: string[] = []
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === "dist") continue
      const fullPath = join(dir, entry.name)
      if (entry.isDirectory()) {
        files.push(...collectFiles(fullPath))
      } else if (scannedExtensions.has(extname(entry.name))) {
        files.push(fullPath)
      }
    }
    return files
  }

  test("grep for bare var(--<colour-token>) returns nothing", () => {
    const offenders: Array<{ file: string; match: string }> = []
    for (const file of collectFiles(srcDir)) {
      const content = readFileSync(file, "utf-8")
      const match = bareVarPattern.exec(content)
      if (match) {
        offenders.push({ file, match: match[0] })
      }
    }
    expect(offenders).toEqual([])
  })
})

describe("tone tokens in the stylesheet", () => {
  test("every tone dereferences a --bb-* variable", () => {
    for (const key of TONE_KEYS) {
      expect(css).toContain(`--color-${key}: var(${cssVarName(key)})`)
    }
  })

  // Four: the three tones plus `destructive`, whose tinted-text companion is
  // derived even though the base colour is authored.
  test("every derived -text companion dereferences a --bb-*-text variable", () => {
    for (const key of TEXT_DERIVED_KEYS) {
      expect(css).toContain(`--color-${key}-text: var(${toneTextVarName(key)})`)
    }
  })

  test("every tone and every derived -text has a :root default", () => {
    for (const key of TONE_KEYS) {
      expect(css).toMatch(new RegExp(`${cssVarName(key)}:\\s*#[0-9a-fA-F]{6}`))
    }
    for (const key of TEXT_DERIVED_KEYS) {
      expect(css).toMatch(new RegExp(`${toneTextVarName(key)}:\\s*#[0-9a-fA-F]{6}`))
    }
  })
})
