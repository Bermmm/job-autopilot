import type { Profile } from '../config/profile.schema.js';
import type { Job } from '../db/types.js';
import { renderProfileForPrompt } from '../profile/view.js';
import { SCORE_BANDS } from './schema.js';

/**
 * The scoring prompt.
 *
 * Bumped whenever the wording changes, and stored alongside every score, so
 * scores from different prompt versions are never silently compared. Scores
 * are append-only in the database for the same reason.
 */
export const SCORE_PROMPT_VERSION = 'score-v1';

const BANDS = SCORE_BANDS.map(
  (band) => `  ${band.min}-${band.min === 85 ? 100 : nextBandCeiling(band.min)}: ${band.label} — ${band.hint}`,
).join('\n');

function nextBandCeiling(min: number): number {
  const higher = SCORE_BANDS.filter((band) => band.min > min).map((band) => band.min);
  return higher.length === 0 ? 100 : Math.min(...higher) - 1;
}

export const SCORE_SYSTEM_PROMPT = `You rate how well a job posting fits one specific candidate. You are blunt and calibrated, not encouraging.

Score 0-100 using these bands:
${BANDS}

Rules:

1. Judge only on what is in the candidate profile and the job posting. If the posting does not say something, it is unknown, not a point for or against.
2. Never credit the candidate with experience the profile does not state. Skills listed under "some real but shallower experience" are exactly that — do not treat them as strengths.
3. Every reason must name something concrete from both sides: a specific requirement in the posting and a specific fact in the profile. "Strong overlap on Postgres and queue work" is a reason. "Great culture fit" is not, and neither is anything you cannot point at.
4. Red flags are requirements the posting *states* that the profile does not meet — a years-of-experience floor, a required degree, a location or work-authorization mismatch, a seniority mismatch, advertised pay below the candidate's stated minimum. Do not invent flags, and do not list a flag for something the posting is simply silent about. An empty list is a perfectly good answer.
5. Calibrate on the work, not the title. A posting with a different title doing work the candidate has done is a better fit than a title-matching posting doing work they have not.
6. Do not pad. Three sharp reasons beat five vague ones.`;

export interface ScorePromptInput {
  profile: Profile;
  job: Job;
}

export function buildScorePrompt({ profile, job }: ScorePromptInput): string {
  const sections = [
    '## Candidate profile',
    '',
    renderProfileForPrompt(profile, { includeConstraints: true }),
    '',
    '## Job posting',
    '',
    `Company: ${job.company}`,
    `Title: ${job.title}`,
    `Location: ${job.location ?? 'not stated'}`,
    `Listed as remote: ${job.remote ? 'yes' : 'no'}`,
    `Posted: ${job.postedAt ?? 'not stated'}`,
    '',
    job.description?.trim()
      ? job.description.trim()
      : '(The board published no description for this posting. Score on the title, ' +
        'company, and location alone, and say so in the summary.)',
  ];

  return sections.join('\n');
}
