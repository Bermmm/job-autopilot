import type { Profile } from '../config/profile.schema.js';
import type { Job } from '../db/types.js';
import { renderProfileForPrompt } from '../profile/view.js';
import type { GroundingIssue } from './grounding.js';
import { bannedTerms } from './style.js';
import type { StyleIssue } from './style.js';

/** Bumped when the wording changes; stored with every letter. */
export const LETTER_PROMPT_VERSION = 'letter-v1';

export function letterSystemPrompt(profile: Profile): string {
  const voice = profile.voiceNotes.map((note) => `  - ${note}`).join('\n');

  return `You write a short cover letter as the candidate, in their voice. One letter, nothing else.

Hard rules:

1. Use only facts from the candidate profile and the job posting. You may not add an employer, a number, a technology, a qualification, or an achievement that is not written there. If you want to say something and cannot find it in the profile, leave it out.
2. Do not inflate. A skill listed under "some real but shallower experience" is not a strength, and "7 years" does not become "nearly a decade".
3. Every number you write must appear in the profile or the posting, exactly as it is there.
4. No placeholders. Never write [Company], [Role], or anything in brackets for someone to fill in.
5. Name one specific thing the posting asks for and one specific thing the candidate has actually done. That pairing is the whole letter.
6. Plain words. Short sentences. No buzzwords and no filler.

Never use these words or phrases:
${bannedTerms(profile)
  .map((term) => `"${term}"`)
  .join(', ')}

The candidate's own notes on voice:
${voice || '  (none given)'}

Alongside the letter, list the profile fields you used. Each entry is the field's tag exactly as it appears in square brackets in the profile below — for example "roles.0.highlights.1" — and the part of its text you relied on. Cite every fact the letter makes. These are checked against the profile, so a tag that does not exist or a value that does not match is a failure.`;
}

export function buildLetterPrompt(options: { profile: Profile; job: Job }): string {
  const { profile, job } = options;

  return [
    '## Candidate profile',
    '',
    '(Each fact is tagged with the field it comes from. Cite these tags.)',
    '',
    renderProfileForPrompt(profile),
    '',
    '## Job posting',
    '',
    `Company: ${job.company}`,
    `Title: ${job.title}`,
    `Location: ${job.location ?? 'not stated'}`,
    '',
    job.description?.trim() ??
      '(No description was published. Write from the title, company, and location only.)',
    '',
    '## Task',
    '',
    `Write ${profile.name}'s cover letter for this posting.`,
  ].join('\n');
}

/**
 * The retry prompt.
 *
 * When a letter fails a check, the model is told exactly which token failed
 * and why, rather than asked vaguely to try again. The issues are machine
 * findings, so the feedback is specific enough to act on.
 */
export function buildRetryPrompt(options: {
  profile: Profile;
  job: Job;
  previousBody: string;
  issues: ReadonlyArray<GroundingIssue | StyleIssue>;
}): string {
  const grouped = options.issues.map((issue) => `  - [${issue.kind}] ${issue.detail}`).join('\n');

  return [
    buildLetterPrompt({ profile: options.profile, job: options.job }),
    '',
    '## Your previous attempt was rejected',
    '',
    options.previousBody,
    '',
    '## Why it was rejected',
    '',
    grouped,
    '',
    'Rewrite the letter so none of these apply. Do not fix a factual problem by',
    'inventing a different fact — cut the claim instead. Keep everything that was',
    'already fine.',
  ].join('\n');
}
