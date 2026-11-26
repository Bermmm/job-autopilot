import type { Config } from '../config/config.schema.js';
import type { Profile } from '../config/profile.schema.js';
import type { Repo } from '../db/repo.js';
import type { Job } from '../db/types.js';
import type { LlmClient } from '../llm/types.js';
import { bandFor } from '../scoring/schema.js';
import { scoreJob, type ScoredJob } from '../scoring/score.js';
import { formatError } from '../util/errors.js';
import { log, out } from '../util/logger.js';
import { mapPool } from '../util/pool.js';

/**
 * `pnpm score` — score postings against the profile.
 *
 * This is the command that spends money, so it says what it is about to do
 * before it does it, and `--limit` exists to keep a first run small.
 */

export interface ScoreOptions {
  /** Score at most this many postings. */
  limit?: number;
  /** Score one posting by id, scored or not. */
  jobId?: string;
  /** Re-score postings that already have a score. */
  rescore?: boolean;
  /** Parallel requests in flight. */
  concurrency?: number;
}

export async function score(
  config: Config,
  profile: Profile,
  repo: Repo,
  llm: LlmClient,
  options: ScoreOptions = {},
): Promise<number> {
  const jobs = selectJobs(repo, options);

  if (jobs.length === 0) {
    out(
      options.jobId
        ? `No posting with id ${options.jobId}.`
        : options.rescore
          ? 'No postings in the database. Run `pnpm hunt` first.'
          : 'Nothing to score — every posting already has a score. Use --rescore to redo them.',
    );
    return options.jobId ? 1 : 0;
  }

  const concurrency = options.concurrency ?? 4;
  const inputChars = jobs.reduce(
    (sum, job) => sum + (job.description?.length ?? 0) + 2_000,
    0,
  );

  out(
    `Scoring ${jobs.length} posting(s) with ${llm.model} ` +
      `(~${Math.round(inputChars / 4_000)}k input tokens, ${concurrency} at a time).\n`,
  );

  const scored: ScoredJob[] = [];
  const failures: Array<{ job: Job; error: unknown }> = [];

  await mapPool(
    jobs,
    concurrency,
    (job) => scoreJob({ job, profile, config, llm }),
    (result, job) => {
      if (result.ok) {
        repo.insertScore({
          jobId: result.value.jobId,
          score: result.value.score,
          reasons: result.value.reasons,
          redFlags: result.value.redFlags,
          summary: result.value.summary,
          provider: result.value.provider,
          model: result.value.model,
          promptVersion: result.value.promptVersion,
          inputTokens: result.value.inputTokens,
          outputTokens: result.value.outputTokens,
        });
        scored.push(result.value);
        out(formatScoreLine(job, result.value));
      } else {
        failures.push({ job, error: result.error });
        out(`  ✗ ${label(job)} ${formatError(result.error).split('\n')[0]}`);
      }
    },
  );

  return summarise(config, scored, failures);
}

function selectJobs(repo: Repo, options: ScoreOptions): Job[] {
  if (options.jobId) {
    const job = repo.getJob(options.jobId);
    return job ? [job] : [];
  }

  const jobs = options.rescore
    ? repo.listJobs({ limit: options.limit ?? 500 })
    : repo.listUnscoredJobs(options.limit ?? 500);

  return options.limit === undefined ? jobs : jobs.slice(0, options.limit);
}

function label(job: Job): string {
  return `${job.company} — ${job.title}`.slice(0, 54).padEnd(56);
}

function formatScoreLine(job: Job, result: ScoredJob): string {
  const band = bandFor(result.score);
  const flags = result.redFlags.length > 0 ? ` ⚠ ${result.redFlags.length}` : '';
  const capped = result.cappedByDealBreaker ? ' [capped]' : '';
  return `  ${String(result.score).padStart(3)} ${band.label.padEnd(8)} ${label(job)}${flags}${capped}`;
}

function summarise(
  config: Config,
  scored: ScoredJob[],
  failures: Array<{ job: Job; error: unknown }>,
): number {
  out('');

  if (scored.length > 0) {
    const sorted = [...scored].sort((a, b) => b.score - a.score);
    const threshold = config.scoring.minScoreToDraft;
    const draftable = sorted.filter((result) => result.score >= threshold);

    const inputTokens = sum(scored.map((r) => r.inputTokens ?? 0));
    const outputTokens = sum(scored.map((r) => r.outputTokens ?? 0));

    out(
      `Scored ${scored.length} posting(s): ` +
        `${inputTokens.toLocaleString()} input + ${outputTokens.toLocaleString()} output tokens.`,
    );
    out(
      `${draftable.length} at or above your minScoreToDraft of ${threshold}` +
        `${draftable.length > 0 ? ':' : '.'}`,
    );

    for (const result of draftable.slice(0, 10)) {
      out(`  ${String(result.score).padStart(3)}  ${result.summary}`);
    }
    if (draftable.length > 10) out(`  … and ${draftable.length - 10} more.`);

    if (draftable.length > 0) {
      out('');
      out('Next: pnpm draft <jobId>   (see `pnpm cli help`)');
    }
  }

  if (failures.length > 0) {
    out('');
    log.warn(`${failures.length} posting(s) failed to score:`);
    for (const failure of failures.slice(0, 5)) {
      log.warn(`  ${failure.job.company} — ${failure.job.title}: ${formatError(failure.error).split('\n')[0]}`);
    }
  }

  // Nothing scored at all is a failed run; some failures is not.
  return scored.length === 0 ? 1 : 0;
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}
