import type { Board } from '../config/companies.schema.js';
import { boardLabel } from '../config/companies.schema.js';
import type { Config } from '../config/config.schema.js';
import type { CompaniesFile } from '../config/companies.schema.js';
import { Repo } from '../db/repo.js';
import { HttpClient } from '../http/client.js';
import { fetcherFor } from '../sources/index.js';
import { filterFresh, matchesTitleFilter } from '../sources/freshness.js';
import { formatError } from '../util/errors.js';
import { log, out } from '../util/logger.js';

/**
 * `pnpm hunt` — fetch fresh postings from every enabled board.
 *
 * Boards are polled one at a time. That is slower than it could be, but these
 * are other people's free APIs and the whole run is a handful of requests;
 * the rate limiter would serialise most of it anyway.
 *
 * One board failing never fails the run. A 404 means a company moved provider,
 * which is normal and worth reporting rather than crashing over.
 */

export interface HuntOptions {
  /** Override `freshness.windowHours`, e.g. to backfill a week on first run. */
  windowHours?: number;
  /** Fetch and report, but write nothing. */
  dryRun?: boolean;
  /** Only boards whose token or name matches this (case-insensitive). */
  only?: string;
  /**
   * The HTTP client to use. The CLI builds one from config; tests pass a stub
   * so the pipeline can be exercised without touching the network.
   */
  http?: HttpClient;
}

interface BoardOutcome {
  board: Board;
  seen: number;
  filteredByTitle: number;
  fresh: number;
  stale: number;
  undated: number;
  inserted: number;
  updated: number;
  error?: string;
}

export async function hunt(
  config: Config,
  companies: CompaniesFile,
  repo: Repo,
  options: HuntOptions = {},
): Promise<number> {
  const windowHours = options.windowHours ?? config.freshness.windowHours;
  const freshness = { ...config.freshness, windowHours };

  const boards = companies.boards
    .filter((board) => board.enabled)
    .filter((board) => matchesOnly(board, options.only));

  if (boards.length === 0) {
    log.error(
      options.only
        ? `No enabled board matches "${options.only}".`
        : 'No boards are enabled in companies.yaml.',
    );
    return 1;
  }

  const http = options.http ?? new HttpClient(config.http);
  const context = { http, maxDescriptionChars: config.scoring.maxDescriptionChars };

  out(
    `Hunting ${boards.length} board(s), postings newer than ${windowHours}h` +
      `${options.dryRun ? ' (dry run — nothing will be written)' : ''}\n`,
  );

  const outcomes: BoardOutcome[] = [];

  for (const board of boards) {
    const fetcher = fetcherFor(board.source);
    const runId = options.dryRun ? null : repo.startFetchRun(board.source, board.token);
    const outcome: BoardOutcome = {
      board,
      seen: 0,
      filteredByTitle: 0,
      fresh: 0,
      stale: 0,
      undated: 0,
      inserted: 0,
      updated: 0,
    };

    try {
      const all = await fetcher.fetch(board, context);
      outcome.seen = all.length;

      // Title filtering happens before anything is stored, so excluded
      // postings never reach the database or the scoring bill.
      const candidates = all.filter((job) => matchesTitleFilter(job.title, board.titleIncludes));
      outcome.filteredByTitle = all.length - candidates.length;

      const decision = filterFresh(candidates, freshness);
      outcome.fresh = decision.fresh.length;
      outcome.stale = decision.stale;
      outcome.undated = decision.undated;

      if (!options.dryRun) {
        for (const job of decision.fresh) {
          const result = repo.upsertJob(job);
          if (result.inserted) outcome.inserted += 1;
          else outcome.updated += 1;
        }
      }

      if (runId !== null) {
        repo.finishFetchRun(runId, {
          jobsSeen: outcome.seen,
          jobsFresh: outcome.fresh,
          jobsNew: outcome.inserted,
        });
      }
    } catch (error) {
      outcome.error = formatError(error);
      if (runId !== null) {
        repo.finishFetchRun(runId, {
          jobsSeen: 0,
          jobsFresh: 0,
          jobsNew: 0,
          error: outcome.error,
        });
      }
    }

    outcomes.push(outcome);
    out(formatBoardLine(outcome, options.dryRun ?? false));
  }

  out('');
  return summarise(outcomes, { windowHours, dryRun: options.dryRun ?? false, http });
}

function matchesOnly(board: Board, only: string | undefined): boolean {
  if (!only) return true;
  const needle = only.toLowerCase();
  return (
    board.token.toLowerCase().includes(needle) ||
    (board.name ?? '').toLowerCase().includes(needle)
  );
}

function formatBoardLine(outcome: BoardOutcome, dryRun: boolean): string {
  const label = `${boardLabel(outcome.board)} (${outcome.board.source})`.padEnd(28);

  if (outcome.error) {
    return `  ✗ ${label} ${outcome.error.split('\n')[0]}`;
  }

  const parts = [`${outcome.seen} listed`];
  if (outcome.filteredByTitle > 0) parts.push(`${outcome.filteredByTitle} filtered by title`);
  parts.push(`${outcome.fresh} fresh`);
  if (!dryRun) {
    parts.push(`${outcome.inserted} new`);
    if (outcome.updated > 0) parts.push(`${outcome.updated} already seen`);
  }
  if (outcome.undated > 0) parts.push(`${outcome.undated} undated`);

  const mark = outcome.fresh > 0 ? '✓' : '·';
  return `  ${mark} ${label} ${parts.join(', ')}`;
}

function summarise(
  outcomes: BoardOutcome[],
  context: { windowHours: number; dryRun: boolean; http: HttpClient },
): number {
  const failed = outcomes.filter((outcome) => outcome.error);
  const total = (pick: (outcome: BoardOutcome) => number): number =>
    outcomes.reduce((sum, outcome) => sum + pick(outcome), 0);

  const seen = total((o) => o.seen);
  const fresh = total((o) => o.fresh);
  const inserted = total((o) => o.inserted);
  const updated = total((o) => o.updated);

  out(
    `${seen} postings listed across ${outcomes.length - failed.length} board(s); ` +
      `${fresh} newer than ${context.windowHours}h.`,
  );

  if (context.dryRun) {
    out('Dry run — nothing was written.');
  } else {
    out(`${inserted} new posting(s) stored, ${updated} already known.`);
  }

  out(`${context.http.requestsMade} HTTP request(s) made.`);

  if (failed.length > 0) {
    out('');
    log.warn(`${failed.length} board(s) failed:`);
    for (const outcome of failed) {
      log.warn(`  ${boardLabel(outcome.board)}: ${outcome.error?.split('\n')[0]}`);
    }
    out('A 404 usually means the company moved to another provider. Check the token.');
  }

  if (fresh === 0 && failed.length === 0) {
    out('');
    out(
      `Nothing newer than ${context.windowHours}h. That is normal for a short window ` +
        'and a small company list — try --window-hours 168 for a week, or add more boards.',
    );
  }

  // A run where every board failed is a failed run; a few 404s is not.
  return failed.length === outcomes.length ? 1 : 0;
}
