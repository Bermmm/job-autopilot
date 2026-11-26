import { z } from 'zod';

/**
 * The shape the model must return when scoring a posting.
 *
 * Kept flat and small on purpose. Every field is required — both providers'
 * structured-output modes handle required fields far more reliably than
 * optional ones, and a missing field here would mean a half-scored job.
 */

export const RedFlagKindSchema = z.enum([
  'years',
  'location',
  'degree',
  'salary',
  'seniority',
  'other',
]);
export type RedFlagKind = z.infer<typeof RedFlagKindSchema>;

export const RedFlagSchema = z
  .object({
    kind: RedFlagKindSchema,
    /** What the posting requires and how the profile falls short. */
    detail: z.string().min(1).max(300),
  })
  .strict();

/**
 * The canonical red-flag type. The database stores these, so `db/types.ts`
 * re-exports this rather than declaring a second copy that could drift.
 */
export type RedFlag = z.infer<typeof RedFlagSchema>;

export const ScoreResultSchema = z
  .object({
    /** 0-100. The bands are defined in the system prompt so runs compare. */
    score: z.number().int().min(0).max(100),
    /** One sentence, for the dashboard row. */
    summary: z.string().min(1).max(400),
    /**
     * Why the score is what it is. Each must point at something concrete in
     * both the profile and the posting — "strong Postgres overlap", not
     * "good culture fit".
     */
    reasons: z.array(z.string().min(1).max(300)).min(1).max(5),
    /** Stated requirements the profile does not meet. Empty is a valid answer. */
    redFlags: z.array(RedFlagSchema).max(8),
  })
  .strict();

export type ScoreResult = z.infer<typeof ScoreResultSchema>;

/** Score bands, shared by the prompt and the CLI's output formatting. */
export const SCORE_BANDS = [
  { min: 85, label: 'strong', hint: 'apply now' },
  { min: 70, label: 'good', hint: 'worth a letter' },
  { min: 50, label: 'partial', hint: 'real gaps' },
  { min: 25, label: 'weak', hint: 'probably not' },
  { min: 0, label: 'no', hint: 'not a fit' },
] as const;

export function bandFor(score: number): (typeof SCORE_BANDS)[number] {
  return SCORE_BANDS.find((band) => score >= band.min) ?? SCORE_BANDS[SCORE_BANDS.length - 1]!;
}
