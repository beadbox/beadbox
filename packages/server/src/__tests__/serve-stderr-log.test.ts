import { afterEach, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { mkdtemp, readFile, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ServeStderrLog } from "../lib/serve-stderr-log"

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function tempDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "beadbox-serve-log-"))
  directories.push(directory)
  return join(directory, "private")
}

function options(directory: string, maxBytes?: number) {
  return {
    workspaceId: "workspace-a",
    directory,
    maxBytes,
    token: "private-token",
    password: "secret/password",
    connection: {
      host: "db.example.test",
      port: 3306,
      database: "private_db",
      user: "private_user",
      tls: false,
    },
  }
}

test("redacts connection values and credentials across stderr chunks", async () => {
  const directory = await tempDirectory()
  const log = new ServeStderrLog(options(directory))
  log.write("event=request_error request_id=r1 error=private_user:sec")
  log.write("ret/password@tcp(db.example.test:3306)/private_db token=private-token\n")
  log.write("authorization: Bearer arbitrary-secret\n")
  log.write("password=another-secret\n")
  log.write(`url=${encodeURIComponent("secret/password")}\n`)
  log.close()

  const content = await readFile(log.path, "utf8")
  expect(content).toContain("request_id=r1")
  expect(content).toContain("event=request_error")
  for (const secret of [
    "private_user",
    "secret/password",
    "secret%2Fpassword",
    "db.example.test",
    "3306",
    "private_db",
    "private-token",
    "arbitrary-secret",
    "another-secret",
  ]) {
    expect(content).not.toContain(secret)
  }
  if (process.platform !== "win32") {
    expect((await stat(directory)).mode & 0o777).toBe(0o700)
    expect((await stat(log.path)).mode & 0o777).toBe(0o600)
  }
})

test("redacts a non-ASCII password split inside a UTF-8 character", async () => {
  const directory = await tempDirectory()
  const log = new ServeStderrLog({ ...options(directory), password: "sëcret" })
  const bytes = Buffer.from("error=password=sëcret\n")
  const split = bytes.indexOf(0xc3) + 1
  log.write(bytes.subarray(0, split))
  log.write(bytes.subarray(split))
  log.close()
  const content = await readFile(log.path, "utf8")
  expect(content).toContain("error=password=[redacted]")
  expect(content).not.toContain("sëcret")
})

test("redacts query-encoded credentials and full Authorization values", async () => {
  const directory = await tempDirectory()
  const log = new ServeStderrLog({ ...options(directory), password: "space /%" })
  log.write("error=bad auth Authorization: Basic OTHER_SECRET\n")
  log.write("url=mysql://u:other-password@host/db?credential=space+%2f%25\n")
  log.close()
  const content = await readFile(log.path, "utf8")
  expect(content).not.toContain("OTHER_SECRET")
  expect(content).not.toContain("other-password")
  expect(content).not.toContain("space+%2f%25")
  expect(content).toContain("error=bad auth authorization=[redacted]")
})

test("rotates diagnostic files and keeps only two backups", async () => {
  const directory = await tempDirectory()
  const log = new ServeStderrLog(options(directory, 180))
  for (let index = 0; index < 20; index++) {
    log.write(`event=request_error request_id=r${index} error=bad connection\n`)
  }
  log.close()
  expect(existsSync(log.path)).toBe(true)
  expect(existsSync(`${log.path}.1`)).toBe(true)
  expect(existsSync(`${log.path}.2`)).toBe(true)
  expect(existsSync(`${log.path}.3`)).toBe(false)
  for (const path of [log.path, `${log.path}.1`, `${log.path}.2`]) {
    expect((await stat(path)).size).toBeLessThanOrEqual(180)
  }
})
