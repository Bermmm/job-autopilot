#!/usr/bin/env node
import { loadAll, loadConfig } from '../config/load.js';
import { currentVersion, migrate, openDatabase } from '../db/index.js';
import { Repo } from '../db/repo.js';
import { formatError } from '../util/errors.js';
import { log, out } from '../util/logger.js';
import { createLlmClient } from '../llm/factory.js';
import { boolFlag, intFlag, parseArgs, stringFlag, type ParsedArgs } from './args.js';
import { doctor } from './doctor.js';
import { hunt } from './hunt.js';
import { score } from './score.js';

/**
 * The CLI. Commands arriving in later steps: score, draft, status, autofill.
 */

const USAGE = `job-autopilot

Usage:
  pnpm cli <command> [options]

Commands:
  doctor                Check config, profile, keys, and database. No network calls.
  hunt                  Fetch fresh postings from the configured boards.
  score                 Score postings against your profile.
  migrate               Apply pending database migrations.
  help                  Show this message.

Options:
  --config <path>       Config file to use (default: config.yaml)

hunt options:
  --window-hours <n>    Override freshness.windowHours for this run (1-720).
                        Useful on a first run: --window-hours 168 backfills
                        a week, 720 backfills 30 days.
  --only <text>         Only boards whose token or name contains <text>.
  --dry-run             Fetch and report, but write nothing.

score options:
  --limit <n>           Score at most n postings. Keeps a first run small.
  --job <jobId>         Score one posting, scored already or not.
  --rescore             Re-score postings that already have a score.
  --concurrency <n>     Requests in flight at once (1-16, default 4).

Not yet implemented (see the roadmap in README.md):
  draft <jobId>         Write a grounded cover letter for one posting.
`;

async function runHunt(args: ParsedArgs, configPath: string): Promise<number> {
  const { config, companies } = loadAll(configPath);
  // Same bound as freshness.windowHours in the schema: one rule, not two.
  const windowHours = intFlag(args, 'window-hours', { min: 1, max: 720 });
  const db = openDatabase({ path: config.paths.database });

  try {
    return await hunt(config, companies, new Repo(db), {
      ...(windowHours === undefined ? {} : { windowHours }),
      dryRun: boolFlag(args, 'dry-run'),
      ...(stringFlag(args, 'only') === undefined ? {} : { only: stringFlag(args, 'only')! }),
    });
  } finally {
    db.close();
  }
}

async function runScore(args: ParsedArgs, configPath: string): Promise<number> {
  const { config, profile } = loadAll(configPath);
  const limit = intFlag(args, 'limit', { min: 1, max: 10_000 });
  const concurrency = intFlag(args, 'concurrency', { min: 1, max: 16 });
  const jobId = stringFlag(args, 'job');
  const db = openDatabase({ path: config.paths.database });

  try {
    return await score(config, profile, new Repo(db), createLlmClient(config, 'scoring'), {
      ...(limit === undefined ? {} : { limit }),
      ...(concurrency === undefined ? {} : { concurrency }),
      ...(jobId === undefined ? {} : { jobId }),
      rescore: boolFlag(args, 'rescore'),
    });
  } finally {
    db.close();
  }
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

async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  const configPath = stringFlag(args, 'config') ?? 'config.yaml';

  switch (args.command) {
    case 'doctor':
      return doctor(configPath);
    case 'hunt':
      return runHunt(args, configPath);
    case 'score':
      return runScore(args, configPath);
    case 'migrate':
      return runMigrate(configPath);
    case 'help':
      out(USAGE);
      return 0;
    case 'draft':
      log.error(`"${args.command}" is not implemented yet.`);
      out(USAGE);
      return 2;
    default:
      log.error(`Unknown command: ${args.command}`);
      out(USAGE);
      return 2;
  }
}

try {
  process.exitCode = await main(process.argv);
} catch (error) {
  log.error(formatError(error));
  process.exitCode = 1;
}
