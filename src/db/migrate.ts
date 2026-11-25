import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Database } from 'better-sqlite3';

/**
 * Migrations are intentionally simple: the whole schema lives in `schema.sql`
 * and is written with `IF NOT EXISTS`, so applying it to an existing database
 * is a no-op. When a future change needs real surgery, add a numbered entry
 * to `MIGRATIONS` below; the applied versions are tracked in the database.
 */

const here = dirname(fileURLToPath(import.meta.url));

export const SCHEMA_VERSION = 1;

interface Migration {
  version: number;
  name: string;
  up: (db: Database) => void;
}

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'initial-schema',
    up: (db) => db.exec(readFileSync(resolve(here, 'schema.sql'), 'utf8')),
  },
];

function ensureMigrationsTable(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INTEGER PRIMARY KEY,
      name       TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);
}

/** Applies any migration not yet recorded. Returns the versions applied. */
export function migrate(db: Database): number[] {
  ensureMigrationsTable(db);

  const applied = new Set<number>(
    db
      .prepare('SELECT version FROM schema_migrations')
      .all()
      .map((row) => (row as { version: number }).version),
  );

  const record = db.prepare(
    'INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)',
  );

  const ran: number[] = [];
  for (const migration of MIGRATIONS) {
    if (applied.has(migration.version)) continue;
    db.transaction(() => {
      migration.up(db);
      record.run(migration.version, migration.name, new Date().toISOString());
    })();
    ran.push(migration.version);
  }
  return ran;
}

/** The highest applied migration version, or 0 for a fresh database. */
export function currentVersion(db: Database): number {
  ensureMigrationsTable(db);
  const row = db
    .prepare('SELECT MAX(version) AS version FROM schema_migrations')
    .get() as { version: number | null };
  return row.version ?? 0;
}
