import { z } from 'zod';

/**
 * Schema for `config.yaml`.
 *
 * Everything here is non-secret and safe to commit in example form. API keys
 * live in `.env` only (see `src/config/env.ts`).
 */

export const LlmProviderSchema = z.enum(['anthropic', 'openai']);
export type LlmProvider = z.infer<typeof LlmProviderSchema>;

export const EffortSchema = z.enum(['low', 'medium', 'high', 'xhigh', 'max']);
export type Effort = z.infer<typeof EffortSchema>;

export const LlmConfigSchema = z
  .object({
    provider: LlmProviderSchema.default('anthropic'),
    /** Exact model id. Deliberately not checked against a list: ids change often. */
    model: z.string().min(1),
    /**
     * Reasoning effort. Honoured by the Anthropic adapter; the OpenAI adapter
     * ignores it unless the configured model takes a reasoning setting.
     */
    effort: EffortSchema.default('medium'),
    maxOutputTokens: z.number().int().min(256).max(128_000).default(8_000),
    /** Wall-clock budget for a single LLM call. */
    timeoutMs: z.number().int().min(1_000).max(600_000).default(120_000),
    maxRetries: z.number().int().min(0).max(8).default(3),
  })
  .strict();
export type LlmConfig = z.infer<typeof LlmConfigSchema>;

export const FreshnessConfigSchema = z
  .object({
    /** Only postings published within this window are ingested. */
    windowHours: z.number().int().min(1).max(720).default(48),
    /**
     * Some boards do not expose a publish timestamp. When true, such postings
     * are kept the first time they are seen and dated with first-seen time;
     * when false they are skipped.
     */
    keepUndatedOnFirstSight: z.boolean().default(true),
  })
  .strict();
export type FreshnessConfig = z.infer<typeof FreshnessConfigSchema>;

export const HttpConfigSchema = z
  .object({
    /**
     * Sent on every outbound request. Keep it identifiable and include a
     * contact URL — it is the polite thing to do, and some boards want it.
     */
    userAgent: z
      .string()
      .min(5)
      .default('job-autopilot/0.1 (+https://github.com/Bermmm/job-autopilot)'),
    /** Global ceiling across all sources, enforced by a token bucket. */
    requestsPerMinute: z.number().int().min(1).max(600).default(30),
    /** Minimum gap between two requests to the same host. */
    perHostMinIntervalMs: z.number().int().min(0).max(60_000).default(1_000),
    timeoutMs: z.number().int().min(1_000).max(120_000).default(15_000),
    maxRetries: z.number().int().min(0).max(8).default(3),
  })
  .strict();
export type HttpConfig = z.infer<typeof HttpConfigSchema>;

export const ScoringConfigSchema = z
  .object({
    /** Below this fit score, `draft` refuses to spend tokens on a letter. */
    minScoreToDraft: z.number().int().min(0).max(100).default(70),
    /** Hard cap on how much job description text is sent to the model. */
    maxDescriptionChars: z.number().int().min(500).max(100_000).default(12_000),
  })
  .strict();
export type ScoringConfig = z.infer<typeof ScoringConfigSchema>;

export const PathsConfigSchema = z
  .object({
    /** All paths are resolved relative to the repo root. */
    database: z.string().min(1).default('./data/job-autopilot.db'),
    letters: z.string().min(1).default('./data/letters'),
    profile: z.string().min(1).default('./profile.yaml'),
    companies: z.string().min(1).default('./companies.yaml'),
  })
  .strict();
export type PathsConfig = z.infer<typeof PathsConfigSchema>;

export const AutofillConfigSchema = z
  .object({
    /** Phase 2. Off unless explicitly enabled. */
    enabled: z.boolean().default(false),
    /**
     * Not a real option. The filler always stops for human review before
     * submitting, and the schema refuses any config that claims otherwise —
     * so "I turned the review off" can never be a true statement about a run.
     */
    requireHumanReview: z.literal(true).default(true),
    /** Stop and hand over whenever a form asks something the profile cannot answer. */
    pauseOnUnknownQuestion: z.literal(true).default(true),
    /** Run the browser headed so a human can actually watch and intervene. */
    headless: z.boolean().default(false),
  })
  .strict();
export type AutofillConfig = z.infer<typeof AutofillConfigSchema>;

export const ConfigSchema = z
  .object({
    llm: LlmConfigSchema,
    freshness: FreshnessConfigSchema.prefault({}),
    http: HttpConfigSchema.prefault({}),
    scoring: ScoringConfigSchema.prefault({}),
    paths: PathsConfigSchema.prefault({}),
    autofill: AutofillConfigSchema.prefault({}),
  })
  .strict();

export type Config = z.infer<typeof ConfigSchema>;
