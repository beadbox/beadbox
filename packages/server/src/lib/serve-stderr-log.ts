import {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs"
import { join } from "node:path"
import { StringDecoder } from "node:string_decoder"
import { getSidecarLogDirectory } from "./log-file"
import type { ServerConnection } from "./workspace-registry"

const MAX_BYTES = 2 * 1024 * 1024
const BACKUPS = 2
const MAX_LINE = 16 * 1024

export interface ServeStderrLogOptions {
  workspaceId: string
  connection: ServerConnection
  password?: string
  token: string
  directory?: string
  maxBytes?: number
}

function redact(text: string, options: ServeStderrLogOptions): string {
  // Replace the actual values, including their URL form, so different upstream
  // error formats do not need separate parsers. Longest first handles overlap.
  const values = [
    options.password,
    options.token,
    options.connection.host,
    String(options.connection.port),
    options.connection.database,
    options.connection.user,
  ]
    .filter((value): value is string => !!value)
    .flatMap((value) => {
      const encoded = encodeURIComponent(value)
      const query = encoded.replace(/%20/g, "+")
      return [
        value,
        encoded,
        encoded.replace(/%[0-9A-F]{2}/g, (part) => part.toLowerCase()),
        query,
        query.replace(/%[0-9A-F]{2}/g, (part) => part.toLowerCase()),
      ]
    })
    .sort((a, b) => b.length - a.length)
  let safe = text
  for (const value of new Set(values)) safe = safe.split(value).join("[redacted]")
  // Cover additional key/value secrets that bd or a driver may print.
  const redacted = safe
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s/@]+:[^\s/@]+@/gi, (authority) => {
      return `${authority.slice(0, authority.indexOf("://") + 3)}[redacted]@`
    })
    .replace(/\bauthorization\s*[:=]\s*[^\r\n]*/gi, "authorization=[redacted]")
    .replace(/\b(password|passwd|pwd|token)\s*[:=]\s*(?:"[^"]*"|'[^']*'|\S+)/gi, "$1=[redacted]")
  return Array.from(redacted, (char) => {
    const code = char.charCodeAt(0)
    return (code < 32 && code !== 9) || code === 127 ? " " : char
  }).join("")
}

function pruneStoppedProcesses(directory: string): void {
  const old = new Map<number, number>()
  for (const name of readdirSync(directory)) {
    const match = /^bd-serve-stderr-(\d+)-[a-zA-Z0-9_-]+\.log(?:\.[12])?$/.exec(name)
    if (!match) continue
    const pid = Number(match[1])
    if (pid === process.pid) continue
    try {
      process.kill(pid, 0)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") {
        old.set(pid, Math.max(old.get(pid) ?? 0, statSync(join(directory, name)).mtimeMs))
      }
    }
  }
  const expired = [...old].sort((a, b) => b[1] - a[1]).slice(2)
  const names = readdirSync(directory)
  for (const [pid] of expired) {
    for (const name of names) {
      if (!name.startsWith(`bd-serve-stderr-${pid}-`)) continue
      try {
        rmSync(join(directory, name))
      } catch {
        // Diagnostic retention never prevents the server from starting.
      }
    }
  }
}

/** Owner-only, bounded diagnostic file. One writer exists per sidecar process. */
export class ServeStderrLog {
  readonly path: string
  private fd: number
  private size: number
  private pending = ""
  private droppingLongLine = false
  private closed = false
  private readonly decoder = new StringDecoder("utf8")
  private readonly maxBytes: number

  constructor(private readonly options: ServeStderrLogOptions) {
    const directory = options.directory ?? join(getSidecarLogDirectory(), "bd-serve")
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    if (process.platform !== "win32") chmodSync(directory, 0o700)
    try {
      pruneStoppedProcesses(directory)
    } catch {
      // A cleanup failure must not disable diagnostics.
    }
    const workspace = options.workspaceId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64)
    this.path = join(directory, `bd-serve-stderr-${process.pid}-${workspace}.log`)
    this.maxBytes = options.maxBytes ?? MAX_BYTES
    this.fd = this.open()
    try {
      this.size = fstatSync(this.fd).size
      this.append(`--- ${new Date().toISOString()} workspace=${workspace} pid=${process.pid} ---\n`)
    } catch (error) {
      try {
        closeSync(this.fd)
      } catch {
        // Preserve the original open/write error.
      }
      throw error
    }
  }

  private open(): number {
    const fd = openSync(
      this.path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | (constants.O_NOFOLLOW ?? 0),
      0o600,
    )
    try {
      if (process.platform !== "win32") fchmodSync(fd, 0o600)
    } catch (error) {
      closeSync(fd)
      throw error
    }
    return fd
  }

  private rotate(): void {
    closeSync(this.fd)
    for (let index = BACKUPS; index > 0; index--) {
      const from = index === 1 ? this.path : `${this.path}.${index - 1}`
      try {
        renameSync(from, `${this.path}.${index}`)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
      }
    }
    this.fd = this.open()
    this.size = 0
  }

  private append(line: string): void {
    const data = Buffer.from(line)
    if (this.size > 0 && this.size + data.length > this.maxBytes) this.rotate()
    writeSync(this.fd, data)
    this.size += data.length
  }

  private line(line: string): void {
    const suffix = this.droppingLongLine ? " [truncated]" : ""
    const workspace = this.options.workspaceId.replace(/[^a-zA-Z0-9_-]/g, "_")
    this.append(
      `${new Date().toISOString()} workspace=${workspace} ${redact(line, this.options)}${suffix}\n`,
    )
    this.droppingLongLine = false
  }

  write(chunk: Buffer | string): void {
    if (this.closed) return
    try {
      const text = typeof chunk === "string" ? chunk : this.decoder.write(chunk)
      const parts = text.split("\n")
      for (let index = 0; index < parts.length; index++) {
        const part = parts[index]!
        if (!this.droppingLongLine && this.pending.length + part.length > MAX_LINE) {
          this.pending += part.slice(0, MAX_LINE - this.pending.length)
          this.droppingLongLine = true
        } else if (!this.droppingLongLine) {
          this.pending += part
        }
        if (index < parts.length - 1) {
          this.line(this.pending)
          this.pending = ""
        }
      }
    } catch (error) {
      this.abort()
      throw error
    }
  }

  close(): void {
    if (this.closed) return
    try {
      this.write(this.decoder.end())
      if (this.pending) this.line(this.pending)
    } finally {
      this.abort()
    }
  }

  private abort(): void {
    if (this.closed) return
    this.closed = true
    try {
      closeSync(this.fd)
    } catch {
      // A failed sink has no more diagnostic work to do.
    }
  }
}
