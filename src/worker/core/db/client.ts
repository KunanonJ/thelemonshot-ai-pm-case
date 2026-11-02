import { drizzle } from "drizzle-orm/d1";
import type { SQLiteTable } from "drizzle-orm/sqlite-core";
import * as schema from "./schema";

export type Db = ReturnType<typeof getDb>;

export function getDb(env: Env) {
  return drizzle(env.DB, { schema });
}

// D1 reports a constraint failure in its error message. Drizzle wraps a single query's error (DrizzleQueryError,
// with D1's error as the cause) but passes a batch's through, so the whole cause chain is read.
export function isUniqueViolation(e: unknown, target?: RegExp): boolean {
  for (let cur: unknown = e, depth = 0; cur instanceof Error && depth < 4; cur = cur.cause, depth++) {
    if (/UNIQUE constraint failed/i.test(cur.message) && (!target || target.test(cur.message))) return true;
  }
  return false;
}

// D1 allows at most 100 bound parameters per statement, so bulk inserts are split by column count
const D1_MAX_PARAMS = 100;

export async function insertChunked<T extends SQLiteTable>(db: Db, table: T, rows: T["$inferInsert"][]): Promise<void> {
  if (rows.length === 0) return;
  const columns = Object.keys(rows[0] as object).length;
  const size = Math.max(1, Math.floor(D1_MAX_PARAMS / columns));
  const statements = [];
  for (let i = 0; i < rows.length; i += size) {
    statements.push(db.insert(table).values(rows.slice(i, i + size)).onConflictDoNothing());
  }
  const [first, ...rest] = statements;
  await db.batch([first!, ...rest]);
}
