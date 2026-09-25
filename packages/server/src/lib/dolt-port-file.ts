// The one reader of .beads/dolt-server.port (beadbox-01f.5, from beadbox-0h2).
//
// bd writes the port its managed Dolt server listens on to this file. Seven
// readers used to parse it five different ways; parseInt-based ones read
// "45522abc" as 45522 and had no upper bound. Every reader now goes through
// here, and gets a result it can map onto its own contract (some treat a
// missing file as "not started yet", one throws a dedicated error).
//
// Precedence, where a port could come from more than one place: an explicit
// dolt_server_port in metadata.json wins, then this file, then the registry.
// bd treats an explicit port as a server it does not manage, so a leftover
// port file must not override it.

import { readFileSync } from "fs"
import { readFile } from "fs/promises"
import { join } from "path"

export const PORT_FILE_NAME = "dolt-server.port"

export type PortFileRead =
  | { status: "ok"; port: number }
  | { status: "missing" }
  | { status: "invalid"; raw: string }
  | { status: "unreadable"; error: NodeJS.ErrnoException }

export function portFilePath(beadsDir: string): string {
  return join(beadsDir, PORT_FILE_NAME)
}

/** A TCP port written as text: surrounding whitespace allowed, digits only, 1..65535. */
export function parsePort(raw: string): number | null {
  const value = raw.trim()
  if (!/^\d+$/.test(value)) return null
  return parsePortValue(Number(value))
}

/** A port from JSON (metadata.json's dolt_server_port): an integer in 1..65535. */
export function parsePortValue(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 && value <= 65535 ? value : null
}

function fromContent(raw: string): PortFileRead {
  const port = parsePort(raw)
  return port === null ? { status: "invalid", raw } : { status: "ok", port }
}

function fromError(error: unknown): PortFileRead {
  const err = error as NodeJS.ErrnoException
  return err?.code === "ENOENT" ? { status: "missing" } : { status: "unreadable", error: err }
}

export function readPortFileSync(beadsDir: string): PortFileRead {
  try {
    return fromContent(readFileSync(portFilePath(beadsDir), "utf-8"))
  } catch (error) {
    return fromError(error)
  }
}

export async function readPortFile(beadsDir: string): Promise<PortFileRead> {
  try {
    return fromContent(await readFile(portFilePath(beadsDir), "utf-8"))
  } catch (error) {
    return fromError(error)
  }
}

/** The explicit dolt_server_port in metadata.json, if there is a valid one. */
export function readMetadataPortSync(beadsDir: string): number | null {
  try {
    const meta = JSON.parse(readFileSync(join(beadsDir, "metadata.json"), "utf-8"))
    return parsePortValue(meta?.dolt_server_port)
  } catch {
    return null
  }
}
