import type { Config } from '../config/config.schema.js';
import type { Profile } from '../config/profile.schema.js';
import type { Job } from '../db/types.js';
import type { LlmClient } from '../llm/types.js';
import { applyRules, mergeRedFlags } from './rules.js';
import { buildScorePrompt, SCORE_PROMPT_VERSION, SCORE_SYSTEM_PROMPT } from './prompt.js';
import { ScoreResultSchema, type RedFlag, type ScoreResult } from './schema.js';

/**
 * Scores one posting.
 *
 * The model's judgment is combined with the deterministic rules rather than
 * trusted alone: the rules catch stated mismatches exactly, and a deal-breaker
 * the user named in their own words caps the score no matter how enthusiastic
 * the model was.
 */

export interface ScoredJob {
  jobId: string;
  score: number;
  summary: string;
  reasons: string[];
  redFlags: RedFlag[];
  provider: string;
  model: string;
  promptVersion: string;
  inputTokens: number | null;
  outputTokens: number | null;
  /** True when a profile deal-breaker forced the score down. */
  cappedByDealBreaker: boolean;
}

/** A deal-breaker the user named is not a matter of degree. */
export const DEAL_BREAKER_CEILING = 15;

export async function scoreJob(options: {
  job: Job;
  profile: Profile;
  config: Config;
  llm: LlmClient;
}): Promise<ScoredJob> {
  const { job, profile, config, llm } = options;

  const rules = applyRules(profile, job);

  const result = await llm.completeStructured({
    system: SCORE_SYSTEM_PROMPT,
    prompt: buildScorePrompt({ profile, job }),
    schema: ScoreResultSchema,
    schemaName: 'FitScore',
    maxOutputTokens: Math.min(config.llm.maxOutputTokens, 2_000),
  });

  return finaliseScore(job, result.value, rules, {
    provider: result.provider,
    model: result.model,
    inputTokens: result.usage.inputTokens,
    outputTokens: result.usage.outputTokens,
  });
}

/**
 * Combines a model result with the rules findings. Pure, so the capping and
 * merging behaviour is testable without a provider.
 */
export function finaliseScore(
  job: Job,
  modelResult: ScoreResult,
  rules: ReturnType<typeof applyRules>,
  meta: {
    provider: string;
    model: string;
    inputTokens: number | null;
    outputTokens: number | null;
  },
): ScoredJob {
  const cappedByDealBreaker = rules.dealBreakerHit !== null;
  const score = cappedByDealBreaker
    ? Math.min(modelResult.score, DEAL_BREAKER_CEILING)
    : modelResult.score;

  const reasons = cappedByDealBreaker
    ? [
        `Score capped: posting mentions "${rules.dealBreakerHit}", a deal-breaker in your profile.`,
        ...modelResult.reasons,
      ].slice(0, 5)
    : modelResult.reasons;

  return {
    jobId: job.id,
    score,
    summary: modelResult.summary,
    reasons,
    redFlags: mergeRedFlags(modelResult.redFlags, rules.redFlags),
    provider: meta.provider,
    model: meta.model,
    promptVersion: SCORE_PROMPT_VERSION,
    inputTokens: meta.inputTokens,
    outputTokens: meta.outputTokens,
    cappedByDealBreaker,
  };
}
