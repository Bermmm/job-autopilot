import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Config } from '../config/config.schema.js';
import { resolveFromRoot } from '../config/load.js';
import type { Profile } from '../config/profile.schema.js';
import type { Repo } from '../db/repo.js';
import type { Job } from '../db/types.js';
import type { LlmClient } from '../llm/types.js';
import { draftLetter, type DraftedLetter } from '../letters/draft.js';
import { bandFor } from '../scoring/schema.js';
import { normalizeCompany } from '../util/normalize.js';
import { log, out } from '../util/logger.js';

/**
 * `pnpm draft <jobId>` — write one grounded cover letter.
 *
 * Three gates before anything is generated, and one after:
 *
 *  * The posting must exist.
 *  * It must score at or above `scoring.minScoreToDraft`, so tokens are not
 *    spent on jobs you would not apply to.
 *  * There must not already be an application for this company and role —
 *    that is the never-twice rule, and it is checked on the normalised key,
 *    so a second posting of the same job in another city is caught.
 *  * The letter must pass the grounding and style checks, or it is not saved.
 */

export interface DraftOptions {
  jobId: string;
  /** Draft even if the score is below the threshold, or absent. */
  force?: boolean;
  /** Draft again for a role already drafted or applied to. */
  again?: boolean;
}

export async function draft(
  config: Config,
  profile: Profile,
  repo: Repo,
  llm: LlmClient,
  options: DraftOptions,
): Promise<number> {
  const job = repo.getJob(options.jobId);
  if (!job) {
    log.error(`No posting with id ${options.jobId}.`);
    out('Run `pnpm hunt` to collect postings, then `pnpm score` to rank them.');
    return 1;
  }

  out(`${job.company} — ${job.title}`);
  out(`${job.url}\n`);

  // --- gate: already drafted or applied --------------------------------
  const existing = repo.findApplicationByRole(job.company, job.title, job.location);
  if (existing && existing.status !== 'found' && !options.again) {
    log.error(
      `You already have an application for this company and role, at status "${existing.status}".`,
    );
    const previous = existing.jobId ? repo.getLatestLetter(existing.jobId) : null;
    if (previous?.filePath) out(`Previous letter: ${previous.filePath}`);
    out('This is the never-apply-twice rule. Use --again to override deliberately.');
    return 1;
  }

  // --- gate: score ------------------------------------------------------
  const score = repo.getLatestScore(job.id);
  if (!options.force) {
    if (!score) {
      log.error('This posting has no score yet.');
      out(`Run \`pnpm score --job ${job.id}\` first, or pass --force to draft anyway.`);
      return 1;
    }
    if (score.score < config.scoring.minScoreToDraft) {
      log.error(
        `Score is ${score.score} (${bandFor(score.score).label}), below your ` +
          `minScoreToDraft of ${config.scoring.minScoreToDraft}.`,
      );
      if (score.summary) out(`  ${score.summary}`);
      out('Pass --force to draft anyway.');
      return 1;
    }
  }

  if (score) {
    out(`Score ${score.score} (${bandFor(score.score).label}). Drafting with ${llm.model}…\n`);
  } else {
    out(`No score (forced). Drafting with ${llm.model}…\n`);
  }

  // --- generate ---------------------------------------------------------
  const letter = await draftLetter({ job, profile, config, llm });

  if (!letter.grounded) {
    return reportFailure(letter);
  }

  // --- save -------------------------------------------------------------
  const filePath = writeLetterFile(config, job, letter);
  repo.insertLetter({
    jobId: job.id,
    body: letter.body,
    filePath,
    factsUsed: letter.factsUsed,
    provider: letter.provider,
    model: letter.model,
    promptVersion: letter.promptVersion,
    grounded: true,
    groundingNotes: [],
  });

  const application = repo.ensureApplicationForJob(job);
  repo.setApplicationStatus(application.application.id, 'drafted', `letter: ${filePath}`);

  out(letter.body);
  out('');
  out(`${letter.words} words, ${letter.attempts} attempt(s). Facts cited:`);
  for (const fact of letter.factsUsed) {
    out(`  ${fact.field}: ${fact.value.slice(0, 72)}${fact.value.length > 72 ? '…' : ''}`);
  }
  out('');
  out(`Saved to ${filePath}`);
  out(`Status for ${job.company} — ${job.title} is now "drafted".`);
  return 0;
}

function reportFailure(letter: DraftedLetter): number {
  log.error(
    `Letter failed its checks after ${letter.attempts} attempt(s). Nothing was saved.`,
  );
  out('');
  out('The model could not produce a letter that passes, so none is offered.');
  out('A letter with an invented fact in it is worse than no letter.\n');

  for (const issue of letter.issues) {
    out(`  ✗ [${issue.kind}] ${issue.detail}`);
  }

  out('');
  out('Usually this means the profile is thin for this posting. Adding a relevant');
  out('highlight to profile.yaml gives the model something true to work with.');
  return 1;
}

/** Writes the letter under `paths.letters`, named so it is findable later. */
function writeLetterFile(config: Config, job: Job, letter: DraftedLetter): string {
  const directory = resolveFromRoot(config.paths.letters);
  mkdirSync(directory, { recursive: true });

  const slug = `${normalizeCompany(job.company)}-${job.titleNormalized.replace(/\s+/g, '-')}`
    .replace(/[^a-z0-9-]/g, '')
    .slice(0, 80);
  const fileName = `${slug}-${job.id.slice(0, 8)}.md`;
  const absolute = join(directory, fileName);

  const frontMatter = [
    '---',
    `company: ${JSON.stringify(job.company)}`,
    `title: ${JSON.stringify(job.title)}`,
    `url: ${job.url}`,
    `jobId: ${job.id}`,
    `model: ${letter.model}`,
    `promptVersion: ${letter.promptVersion}`,
    `generatedAt: ${new Date().toISOString()}`,
    'factsUsed:',
    ...letter.factsUsed.map((fact) => `  - ${fact.field}`),
    '---',
    '',
  ].join('\n');

  writeFileSync(absolute, `${frontMatter}${letter.body}\n`, 'utf8');

  // Stored and displayed relative to the repo, which is what the dashboard
  // and the CLI both want to show.
  return join(config.paths.letters.replace(/^\.\//, ''), fileName);
}
