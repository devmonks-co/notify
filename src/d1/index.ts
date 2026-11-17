import type { DrizzleD1Database } from 'drizzle-orm/d1';

import { SqliteStore, type AtomicStatement, type SqliteStoreOptions } from '../sqlite/store.js';
import type { SqliteTables } from '../sqlite/tables.js';

export { sqliteTables, type SqliteTables } from '../sqlite/tables.js';
export { MAX_DEVICE_FAILURES, type UserInfo } from '../shared/store.js';
export type { SqliteStoreOptions } from '../sqlite/store.js';

/**
 * `SqliteStore` for Cloudflare D1. D1 has no interactive transactions (`db.transaction` fails there), so
 * the all-or-none writes go through `db.batch`, which D1 runs in order as one implicit transaction.
 */
export class D1Store extends SqliteStore {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  declare protected readonly db: DrizzleD1Database<any>;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor(db: DrizzleD1Database<any>, tables: SqliteTables, opts: SqliteStoreOptions) {
    super(db, tables, opts);
  }

  protected override async atomic(statements: readonly AtomicStatement[]): Promise<unknown[][]> {
    if (statements.length === 0) return [];
    return (await this.db.batch(statements as [AtomicStatement, ...AtomicStatement[]])) as unknown[][];
  }
}
