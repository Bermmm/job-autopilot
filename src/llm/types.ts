import type { z } from 'zod';
import type { Effort, LlmProvider } from '../config/config.schema.js';

/**
 * The adapter boundary.
 *
 * Everything above this line (scoring, letter drafting) talks only to
 * `LlmClient`. Provider SDKs are imported nowhere else, so swapping or adding
 * a provider is one file and one entry in the factory.
 */

export interface LlmUsage {
  inputTokens: number | null;
  outputTokens: number | null;
}

export interface LlmResult<T> {
  value: T;
  usage: LlmUsage;
  /** The model that actually served the request, which may differ from config. */
  model: string;
  provider: LlmProvider;
}

export interface TextRequest {
  system: string;
  /** Single user turn. This tool never needs multi-turn conversation. */
  prompt: string;
  /** Overrides the configured cap for this one call. */
  maxOutputTokens?: number;
  effort?: Effort;
}

export interface StructuredRequest<T extends z.ZodType> {
  system: string;
  prompt: string;
  /**
   * Shape the model must return. Enforced by the provider's structured-output
   * mode where available, and validated locally either way — a provider that
   * says it complied is not taken at its word.
   */
  schema: T;
  /** Name for the schema, used by providers that require one. */
  schemaName: string;
  maxOutputTokens?: number;
  effort?: Effort;
}

export interface LlmClient {
  readonly provider: LlmProvider;
  /** Model from config. The served model is reported per result. */
  readonly model: string;

  /** Free-form text. Used for cover letters. */
  complete(request: TextRequest): Promise<LlmResult<string>>;

  /**
   * JSON matching `schema`. Used for fit scoring.
   *
   * Rejects rather than guesses: if the model returns something that fails
   * validation, this throws `LlmError` instead of returning a partial object.
   */
  completeStructured<T extends z.ZodType>(
    request: StructuredRequest<T>,
  ): Promise<LlmResult<z.infer<T>>>;
}
