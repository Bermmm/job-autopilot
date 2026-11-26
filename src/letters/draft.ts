import type { Config } from '../config/config.schema.js';
import type { Profile } from '../config/profile.schema.js';
import type { Job } from '../db/types.js';
import type { LlmClient } from '../llm/types.js';
import { assessLetter, type GroundingIssue } from './grounding.js';
import {
  buildLetterPrompt,
  buildRetryPrompt,
  LETTER_PROMPT_VERSION,
  letterSystemPrompt,
} from './prompt.js';
import { LetterResultSchema } from './schema.js';
import type { FactCitation } from './schema.js';
import { checkStyle, wordCount, type StyleIssue } from './style.js';

/**
 * Drafts one letter, then checks it and makes the model fix its own failures.
 *
 * The loop exists because the checks are cheap and deterministic while the
 * generation is neither: it is better to reject and regenerate than to ship a
 * letter with an invented number in it. If the second attempt still fails,
 * nothing is saved — a refusal is a far better outcome than a letter you
 * would have to retract.
 */

export type LetterIssue = GroundingIssue | StyleIssue;

export interface DraftedLetter {
  jobId: string;
  body: string;
  factsUsed: FactCitation[];
  grounded: boolean;
  issues: LetterIssue[];
  attempts: number;
  words: number;
  provider: string;
  model: string;
  promptVersion: string;
  inputTokens: number | null;
  outputTokens: number | null;
}

export const MAX_DRAFT_ATTEMPTS = 2;

export async function draftLetter(options: {
  job: Job;
  profile: Profile;
  config: Config;
  llm: LlmClient;
  maxAttempts?: number;
}): Promise<DraftedLetter> {
  const { job, profile, config, llm } = options;
  const maxAttempts = options.maxAttempts ?? MAX_DRAFT_ATTEMPTS;

  let prompt = buildLetterPrompt({ profile, job });
  let last: DraftedLetter | null = null;
  let inputTokens = 0;
  let outputTokens = 0;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const result = await llm.completeStructured({
      system: letterSystemPrompt(profile),
      prompt,
      schema: LetterResultSchema,
      schemaName: 'CoverLetter',
      maxOutputTokens: Math.min(config.llm.maxOutputTokens, 4_000),
    });

    inputTokens += result.usage.inputTokens ?? 0;
    outputTokens += result.usage.outputTokens ?? 0;

    const body = result.value.body.trim();
    const grounding = assessLetter({
      body,
      citations: result.value.factsUsed,
      profile,
      job,
    });
    const style = checkStyle(body, profile);
    const issues: LetterIssue[] = [...grounding.issues, ...style];

    last = {
      jobId: job.id,
      body,
      factsUsed: result.value.factsUsed,
      grounded: issues.length === 0,
      issues,
      attempts: attempt,
      words: wordCount(body),
      provider: result.provider,
      model: result.model,
      promptVersion: LETTER_PROMPT_VERSION,
      inputTokens: inputTokens || null,
      outputTokens: outputTokens || null,
    };

    if (issues.length === 0) return last;

    prompt = buildRetryPrompt({ profile, job, previousBody: body, issues });
  }

  // Returned ungrounded; the caller decides what to do and must not save it
  // as if it had passed.
  return last!;
}
