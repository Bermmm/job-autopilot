#!/usr/bin/env node
import { loadConfig } from '../config/load.js';
import { currentVersion, migrate, openDatabase } from '../db/index.js';
import { formatError } from '../util/errors.js';
import { log, out } from '../util/logger.js';
import { doctor } from './doctor.js';

/**
 * The CLI. Argument parsing is hand-rolled on purpose: the surface is a
 * handful of verbs, and one fewer dependency is one fewer thing to audit in
 * a tool that reads your personal data.
 *
 * Commands arriving in later steps: hunt, score, draft, status, autofill.
 */

const USAGE = `job-autopilot

Usage:
  pnpm cli <command> [options]

Commands:
  doctor              Check config, profile, keys, and database. Makes no network calls.
  migrate             Apply pending database migrations.
  help                Show this message.

Options:
  --config <path>     Config file to use (default: config.yaml)

Not yet implemented (see the roadmap in README.md):
  hunt                Fetch fresh postings from the configured boards.
  score               Score unscored postings against your profile.
  draft <jobId>       Write a grounded cover letter for one posting.
`;

function argValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index === -1) return undefined;
  return args[index + 1];
}

function runMigrate(configPath: string): number {
  const config = loadConfig(configPath);
  const db = openDatabase({ path: config.paths.database, migrateOnOpen: false });
  try {
    const applied = migrate(db);
    out(
      applied.length === 0
        ? `Database is up to date (schema v${currentVersion(db)}).`
        : `Applied migration(s): ${applied.join(', ')} — now at schema v${currentVersion(db)}.`,
    );
    return 0;
  } finally {
    db.close();
  }
}

function main(argv: string[]): number {
  const args = argv.slice(2);
  const command = args[0] ?? 'help';
  const configPath = argValue(args, '--config') ?? 'config.yaml';

  switch (command) {
    case 'doctor':
      return doctor(configPath);
    case 'migrate':
      return runMigrate(configPath);
    case 'help':
    case '--help':
    case '-h':
      out(USAGE);
      return 0;
    case 'hunt':
    case 'score':
    case 'draft':
      log.error(`"${command}" is not implemented yet.`);
      out(USAGE);
      return 2;
    default:
      log.error(`Unknown command: ${command}`);
      out(USAGE);
      return 2;
  }
}

try {
  process.exitCode = main(process.argv);
} catch (error) {
  log.error(formatError(error));
  process.exitCode = 1;
}
