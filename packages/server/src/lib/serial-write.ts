// kkrpc's BunIo writes each frame with `Bun.write(Bun.stdout, frame)`. On a
// pipe, a multi-megabyte frame (epics.getEpics on a 5000-issue workspace is
// ~7MB) goes out in several partial writes, and a reply written meanwhile
// lands in the middle of it. The client then fails to parse both frames and
// those calls never settle, which reads as a wedged sidecar: the client
// restarts it, the fresh session sends the same large reply, and the loop
// repeats (beadbox-hia). Chaining the writes keeps every frame contiguous.

interface FrameWriter {
  write(message: string): Promise<void>
}

export function serializeWrites<T extends FrameWriter>(io: T): T {
  const write = io.write.bind(io)
  let tail: Promise<void> = Promise.resolve()
  io.write = (message: string) => {
    const next = tail.then(() => write(message))
    tail = next.catch(() => {}) // a failed write must not block the ones after it
    return next
  }
  return io
}
