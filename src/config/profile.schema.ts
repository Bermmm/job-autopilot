import { z } from 'zod';

/**
 * Schema for `profile.yaml` — the single source of truth about the applicant.
 *
 * Two rules shape this file:
 *
 *  1. The real `profile.yaml` is gitignored. Only `profile.example.yaml`,
 *     which is fake, is ever committed.
 *  2. The cover-letter generator may use *nothing* but what is in here plus
 *     the job posting. Every claim in a letter is traced back to a field in
 *     this schema, which is why the shape is flat and explicit rather than
 *     a free-text blob: a field can be cited, a paragraph cannot.
 */

/** `YYYY-MM`, or `present` for a current role. */
const YearMonthSchema = z
  .string()
  .regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'expected YYYY-MM');

const EndDateSchema = z.union([YearMonthSchema, z.literal('present')]);

export const ContactSchema = z
  .object({
    email: z.string().email(),
    phone: z.string().min(5).optional(),
    /** Free text, e.g. "Berlin, Germany" or "Remote (CET)". */
    location: z.string().min(1),
    links: z
      .array(
        z
          .object({
            label: z.string().min(1),
            url: z.string().url(),
          })
          .strict(),
      )
      .default([]),
  })
  .strict();

export const RoleSchema = z
  .object({
    company: z.string().min(1),
    title: z.string().min(1),
    start: YearMonthSchema,
    end: EndDateSchema,
    location: z.string().optional(),
    /**
     * One concrete thing done, in your own words. These are quoted and cited
     * by the letter generator, so write them as facts, not as marketing.
     */
    highlights: z.array(z.string().min(1)).min(1),
    technologies: z.array(z.string().min(1)).default([]),
  })
  .strict();

export const EducationSchema = z
  .object({
    institution: z.string().min(1),
    credential: z.string().min(1),
    field: z.string().optional(),
    completed: z.union([YearMonthSchema, z.literal('in-progress')]).optional(),
  })
  .strict();

export const CertificationSchema = z
  .object({
    name: z.string().min(1),
    issuer: z.string().min(1),
    issued: YearMonthSchema.optional(),
    expires: YearMonthSchema.optional(),
    credentialId: z.string().optional(),
  })
  .strict();

export const SkillsSchema = z
  .object({
    /** Things you would be happy to be interviewed on tomorrow. */
    strong: z.array(z.string().min(1)).default([]),
    /** Real but shallower experience. Letters must not oversell these. */
    working: z.array(z.string().min(1)).default([]),
    /** Explicitly not your thing. Used to raise red flags, never claimed. */
    avoid: z.array(z.string().min(1)).default([]),
  })
  .strict();

export const SalarySchema = z
  .object({
    currency: z.string().length(3),
    /** Walk-away number. Postings advertising below this get a red flag. */
    minimum: z.number().positive(),
    target: z.number().positive(),
    period: z.enum(['year', 'month', 'day', 'hour']).default('year'),
    /** Shown verbatim when a form demands a salary expectation. */
    publicAnswer: z.string().min(1).optional(),
  })
  .strict()
  .refine((s) => s.target >= s.minimum, {
    message: 'salary.target must be >= salary.minimum',
    path: ['target'],
  });

export const PreferencesSchema = z
  .object({
    titles: z.array(z.string().min(1)).default([]),
    /** Free text locations you would accept, e.g. ["Remote (EU)", "Berlin"]. */
    locations: z.array(z.string().min(1)).default([]),
    remoteOnly: z.boolean().default(false),
    /** Posting keywords that should drag a score down hard. */
    dealBreakers: z.array(z.string().min(1)).default([]),
    minYearsExperienceClaimable: z.number().min(0).max(60).optional(),
  })
  .strict();

/**
 * Canned answers to the questions application forms keep asking. Phase 2
 * autofill uses these verbatim and pauses on anything not listed here.
 */
export const StandardAnswerSchema = z
  .object({
    /** Stable key used by the form filler, e.g. `work_authorization`. */
    key: z.string().regex(/^[a-z0-9_]+$/, 'use snake_case'),
    /** The question as a human would read it. */
    question: z.string().min(1),
    answer: z.string().min(1),
  })
  .strict();

export const ProfileSchema = z
  .object({
    name: z.string().min(1),
    /** One or two sentences, your own voice. Quoted, never rewritten upward. */
    headline: z.string().min(1),
    contact: ContactSchema,
    workAuthorization: z.string().min(1),
    /**
     * Years of professional experience. A single number, so the letter
     * generator and the red-flag check cannot disagree about it.
     */
    yearsExperience: z.number().min(0).max(60),
    roles: z.array(RoleSchema).min(1),
    education: z.array(EducationSchema).default([]),
    certifications: z.array(CertificationSchema).default([]),
    skills: SkillsSchema.prefault({}),
    salary: SalarySchema,
    preferences: PreferencesSchema.prefault({}),
    standardAnswers: z.array(StandardAnswerSchema).default([]),
    /**
     * Tone notes for the letter generator, e.g. "short sentences", "no
     * exclamation marks". Style only — never new facts.
     */
    voiceNotes: z.array(z.string().min(1)).default([]),
  })
  .strict()
  .superRefine((profile, ctx) => {
    const keys = new Set<string>();
    profile.standardAnswers.forEach((answer, index) => {
      if (keys.has(answer.key)) {
        ctx.addIssue({
          code: 'custom',
          message: `duplicate standardAnswers key: ${answer.key}`,
          path: ['standardAnswers', index, 'key'],
        });
      }
      keys.add(answer.key);
    });
  });

export type Profile = z.infer<typeof ProfileSchema>;
export type Role = z.infer<typeof RoleSchema>;
export type StandardAnswer = z.infer<typeof StandardAnswerSchema>;
