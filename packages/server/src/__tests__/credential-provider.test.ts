import { afterEach, expect, test } from "bun:test"
import {
  clearWorkspacePassword,
  getWorkspacePassword,
  setWorkspacePassword,
} from "../lib/credential-provider"

const first = "localhost:3306/beads/alice"
const second = "localhost:3306/beads/bob"
const legacy = "localhost:3306/beads"

afterEach(() => {
  clearWorkspacePassword(first)
  clearWorkspacePassword(second)
  clearWorkspacePassword(legacy)
})

test("credentials for two users on one SQL database remain distinct", () => {
  setWorkspacePassword(first, "alice-secret")
  setWorkspacePassword(second, "bob-secret")

  expect(getWorkspacePassword(first)).toBe("alice-secret")
  expect(getWorkspacePassword(second)).toBe("bob-secret")
  expect(getWorkspacePassword(legacy)).toBeUndefined()
})

test("a legacy server credential remains available to its explicit user", () => {
  setWorkspacePassword(legacy, "legacy-secret")
  expect(getWorkspacePassword(first)).toBe("legacy-secret")
})
