// Read-only guard for SQL sent over a direct Dolt connection (mysql2).
// Lives outside lib/bd.ts because it never invokes the bd binary: bd.ts's
// exports are the bd-argv surface that bd-exports-argv.security.test.ts
// enumerates, and a connection parameter is not part of that surface.

/** The one method readOnlyQuery needs from a mysql2 connection. */
export interface SqlConnection {
  query(sql: string): Promise<[unknown, unknown]>
}

// Run one read inside a transaction the SERVER enforces as read-only.
// This is the direct-connection twin of `bd sql --readonly`: server://
// workspaces never reach the bd CLI, so an argv flag cannot guard them.
//
// It must be START TRANSACTION READ ONLY, not SET SESSION TRANSACTION READ
// ONLY: Dolt accepts the session form and then ignores it (a DELETE after it
// succeeds), while a write inside a READ ONLY transaction is refused with
// ER_CANT_EXECUTE_IN_READ_ONLY_TRANSACTION.
//
// Failures are loud on purpose. A server that rejects START TRANSACTION READ
// ONLY (an older Dolt) fails the read here, before the query runs; there is
// no fallback to an unguarded read. A statement the server refuses inside
// the transaction propagates, so "write blocked" never looks like "read
// returned nothing". The caller owns the connection and ends it.
export async function readOnlyQuery<T>(conn: SqlConnection, sql: string): Promise<T[]> {
  await conn.query("START TRANSACTION READ ONLY")
  try {
    const [rows] = await conn.query(sql)
    await conn.query("COMMIT")
    return rows as T[]
  } catch (error) {
    await conn.query("ROLLBACK").catch(() => {})
    throw error
  }
}
