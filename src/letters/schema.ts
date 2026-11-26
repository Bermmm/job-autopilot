import { z } from 'zod';

/**
 * What the model must return when drafting a letter.
 *
 * The citations are not decoration. Each one names a profile field the letter
 * leaned on, and `verifyCitations` checks the path exists and the value
 * matches — so "which facts did you use" has a checkable answer rather than
 * a trusted one.
 */

export const FactCitationSchema = z
  .object({
    /** Dotted profile path, e.g. `roles.0.highlights.1`. */
    field: z.string().min(1).max(120),
    /** The part of that field's value the letter used. */
    value: z.string().min(1).max(600),
  })
  .strict();

export type FactCitation = z.infer<typeof FactCitationSchema>;

export const LetterResultSchema = z
  .object({
    /** The letter itself. Plain text, no markdown, no placeholders. */
    body: z.string().min(120).max(4_000),
    /** Every profile fact the letter relies on. */
    factsUsed: z.array(FactCitationSchema).min(1).max(12),
  })
  .strict();

export type LetterResult = z.infer<typeof LetterResultSchema>;
