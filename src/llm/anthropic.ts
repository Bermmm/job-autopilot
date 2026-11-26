import Anthropic, { APIError } from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import type { z } from 'zod';

import type { ResolvedLlmConfig } from '../config/config.schema.js';
import { LlmError } from '../util/errors.js';
import { isRetryableStatus, withRetries } from './retry.js';
import type { LlmClient, LlmResult, StructuredRequest, TextRequest, LlmUsage } from './types.js';

/**
 * Anthropic adapter.
 *
 * Notes on the choices here:
 *
 *  * Structured scoring goes through `messages.parse` with a Zod output
 *    format, so the model is constrained server-side rather than asked
 *    politely for JSON.
 *  * Server-side fallback is on. Safety classifiers can decline a request
 *    (HTTP 200, `stop_reason: "refusal"`); with `fallbacks: "default"` the
 *    request is re-routed instead of failing the run. A refusal that still
 *    gets through is surfaced as an error, never as an empty letter.
 *  * Thinking is left at the model's default (adaptive). Depth is controlled
 *    with `output_config.effort` from config.
 */

const SERVER_SIDE_FALLBACK_BETA = 'server-side-fallback-2026-07-01';

export class AnthropicClient implements LlmClient {
  readonly provider = 'anthropic' as const;
  readonly model: string;

  private readonly client: Anthropic;
  private readonly config: ResolvedLlmConfig;

  constructor(options: { apiKey: string; baseURL?: string | undefined; config: ResolvedLlmConfig }) {
    this.config = options.config;
    this.model = options.config.model;
    this.client = new Anthropic({
      apiKey: options.apiKey,
      ...(options.baseURL ? { baseURL: options.baseURL } : {}),
      timeout: options.config.timeoutMs,
      // Retries are handled here so both adapters behave identically.
      maxRetries: 0,
    });
  }

  async complete(request: TextRequest): Promise<LlmResult<string>> {
    return withRetries(
      async () => {
        const response = await this.send(() =>
          this.client.beta.messages.create({
            model: this.model,
            max_tokens: request.maxOutputTokens ?? this.config.maxOutputTokens,
            system: request.system,
            messages: [{ role: 'user', content: request.prompt }],
            output_config: { effort: request.effort ?? this.config.effort },
            betas: [SERVER_SIDE_FALLBACK_BETA],
            fallbacks: 'default',
          }),
        );

        this.assertUsable(response.stop_reason, response.stop_details);

        const text = response.content
          .filter((block): block is Anthropic.TextBlock => block.type === 'text')
          .map((block) => block.text)
          .join('')
          .trim();

        if (text.length === 0) {
          throw new LlmError('Anthropic returned no text content.', {
            provider: this.provider,
            retryable: true,
          });
        }

        return {
          value: text,
          usage: toUsage(response.usage),
          model: response.model,
          provider: this.provider,
        };
      },
      { maxRetries: this.config.maxRetries, label: 'anthropic.complete' },
    );
  }

  async completeStructured<T extends z.ZodType>(
    request: StructuredRequest<T>,
  ): Promise<LlmResult<z.infer<T>>> {
    return withRetries(
      async () => {
        const response = await this.send(() =>
          this.client.beta.messages.parse({
            model: this.model,
            max_tokens: request.maxOutputTokens ?? this.config.maxOutputTokens,
            system: request.system,
            messages: [{ role: 'user', content: request.prompt }],
            output_config: {
              effort: request.effort ?? this.config.effort,
              format: betaZodOutputFormat(request.schema),
            },
            betas: [SERVER_SIDE_FALLBACK_BETA],
            fallbacks: 'default',
          }),
        );

        this.assertUsable(response.stop_reason, response.stop_details);

        if (response.parsed_output === null || response.parsed_output === undefined) {
          throw new LlmError(
            `Anthropic did not return output matching the ${request.schemaName} schema.`,
            { provider: this.provider, retryable: true },
          );
        }

        // Validate locally too: the server constrains the shape, but this is
        // the only check that also runs for the OpenAI adapter and in tests.
        const parsed = request.schema.safeParse(response.parsed_output);
        if (!parsed.success) {
          throw new LlmError(
            `Anthropic output failed ${request.schemaName} validation: ${parsed.error.issues
              .map((issue) => `${issue.path.join('.')} ${issue.message}`)
              .join('; ')}`,
            { provider: this.provider, retryable: true },
          );
        }

        return {
          value: parsed.data as z.infer<T>,
          usage: toUsage(response.usage),
          model: response.model,
          provider: this.provider,
        };
      },
      { maxRetries: this.config.maxRetries, label: 'anthropic.completeStructured' },
    );
  }

  /**
   * Runs one SDK call, mapping its errors to `LlmError` *before* they reach
   * the retry loop — which decides what to retry by looking at that type.
   */
  private async send<T>(call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (error) {
      throw wrapError(error);
    }
  }

  /** Turns a non-`end_turn` stop into a clear error rather than silent truncation. */
  private assertUsable(stopReason: string | null, stopDetails: unknown): void {
    if (stopReason === 'refusal') {
      const category =
        stopDetails && typeof stopDetails === 'object' && 'category' in stopDetails
          ? String((stopDetails as { category: unknown }).category)
          : 'unspecified';
      throw new LlmError(`Anthropic declined the request (category: ${category}).`, {
        provider: this.provider,
        retryable: false,
        hint: 'Check the job description for content that trips a safety classifier, or skip this posting.',
      });
    }
    if (stopReason === 'max_tokens') {
      throw new LlmError('Anthropic response hit the output token cap and was truncated.', {
        provider: this.provider,
        retryable: false,
        hint: 'Raise llm.maxOutputTokens in config.yaml.',
      });
    }
  }
}

function toUsage(usage: { input_tokens?: number; output_tokens?: number } | undefined): LlmUsage {
  return {
    inputTokens: usage?.input_tokens ?? null,
    outputTokens: usage?.output_tokens ?? null,
  };
}

/** Maps SDK errors onto `LlmError`, preserving whether a retry makes sense. */
function wrapError(error: unknown): unknown {
  if (error instanceof LlmError) return error;
  if (error instanceof APIError) {
    return new LlmError(`Anthropic API error ${error.status ?? '(no status)'}: ${error.message}`, {
      provider: 'anthropic',
      retryable: isRetryableStatus(error.status),
      cause: error,
      hint:
        error.status === 401
          ? 'Check ANTHROPIC_API_KEY in .env.'
          : error.status === 429
            ? 'Rate limited. Lower http.requestsPerMinute or wait.'
            : undefined,
    });
  }
  return error;
}
