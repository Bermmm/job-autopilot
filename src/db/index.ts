import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import BetterSqlite3, { type Database } from 'better-sqlite3';

import { resolveFromRoot } from '../config/load.js';
import { migrate } from './migrate.js';

export interface OpenDatabaseOptions {
  /** Path from config, or `:memory:` for tests. */
  path: string;
  /** Apply pending migrations on open. Default true. */
  migrateOnOpen?: boolean;
  readonly?: boolean;
}

/**
 * Opens the local database, creating its directory if needed.
 *
 * WAL keeps the CLI and the dashboard from blocking each other: `hunt` can
 * write while the dashboard reads.
 */
export function openDatabase(options: OpenDatabaseOptions): Database {
  const isMemory = options.path === ':memory:';
  const absolutePath = isMemory ? options.path : resolveFromRoot(options.path);

  if (!isMemory) mkdirSync(dirname(absolutePath), { recursive: true });

  const db = new BetterSqlite3(absolutePath, { readonly: options.readonly ?? false });

  if (!options.readonly) {
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
  }
  db.pragma('foreign_keys = ON');
  // Wait rather than fail when the dashboard and the CLI overlap.
  db.pragma('busy_timeout = 5000');

  if (options.migrateOnOpen ?? true) migrate(db);

  return db;
}

export { migrate, currentVersion, SCHEMA_VERSION } from './migrate.js';
export * from './types.js';
export * from './repo.js';
