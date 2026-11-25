import OpenAI, { APIError } from 'openai';
import { zodTextFormat } from 'openai/helpers/zod';
import type { z } from 'zod';

import type { LlmConfig } from '../config/config.schema.js';
import { LlmError } from '../util/errors.js';
import { isRetryableStatus, withRetries } from './retry.js';
import type { LlmClient, LlmResult, StructuredRequest, TextRequest, LlmUsage } from './types.js';

/**
 * OpenAI adapter, behind the same interface as the Anthropic one.
 *
 * It exists so the project is not married to one vendor, and so the adapter
 * boundary is tested by having two real implementations rather than one plus
 * an interface nobody else satisfies.
 *
 * `llm.effort` is not forwarded here. Only OpenAI's reasoning models accept a
 * reasoning effort, and sending it to one that does not is an error — so the
 * setting is documented as Anthropic-first rather than silently mistranslated.
 */

export class OpenAiClient implements LlmClient {
  readonly provider = 'openai' as const;
  readonly model: string;

  private readonly client: OpenAI;
  private readonly config: LlmConfig;

  constructor(options: { apiKey: string; baseURL?: string | undefined; config: LlmConfig }) {
    this.config = options.config;
    this.model = options.config.model;
    this.client = new OpenAI({
      apiKey: options.apiKey,
      ...(options.baseURL ? { baseURL: options.baseURL } : {}),
      timeout: options.config.timeoutMs,
      maxRetries: 0,
    });
  }

  async complete(request: TextRequest): Promise<LlmResult<string>> {
    return withRetries(
      async () => {
        const response = await this.send(() =>
          this.client.responses.create({
            model: this.model,
            instructions: request.system,
            input: request.prompt,
            max_output_tokens: request.maxOutputTokens ?? this.config.maxOutputTokens,
          }),
        );

        this.assertUsable(response.status, response.incomplete_details?.reason);

        const text = (response.output_text ?? '').trim();
        if (text.length === 0) {
          throw new LlmError('OpenAI returned no text content.', {
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
      { maxRetries: this.config.maxRetries, label: 'openai.complete' },
    );
  }

  async completeStructured<T extends z.ZodType>(
    request: StructuredRequest<T>,
  ): Promise<LlmResult<z.infer<T>>> {
    return withRetries(
      async () => {
        const response = await this.send(() =>
          this.client.responses.parse({
            model: this.model,
            instructions: request.system,
            input: request.prompt,
            max_output_tokens: request.maxOutputTokens ?? this.config.maxOutputTokens,
            text: { format: zodTextFormat(request.schema, request.schemaName) },
          }),
        );

        this.assertUsable(response.status, response.incomplete_details?.reason);

        if (response.output_parsed === null || response.output_parsed === undefined) {
          throw new LlmError(
            `OpenAI did not return output matching the ${request.schemaName} schema.`,
            { provider: this.provider, retryable: true },
          );
        }

        const parsed = request.schema.safeParse(response.output_parsed);
        if (!parsed.success) {
          throw new LlmError(
            `OpenAI output failed ${request.schemaName} validation: ${parsed.error.issues
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
      { maxRetries: this.config.maxRetries, label: 'openai.completeStructured' },
    );
  }

  private async send<T>(call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (error) {
      throw wrapError(error);
    }
  }

  private assertUsable(status: string | undefined, reason: string | undefined): void {
    if (status === 'incomplete' && reason === 'max_output_tokens') {
      throw new LlmError('OpenAI response hit the output token cap and was truncated.', {
        provider: this.provider,
        retryable: false,
        hint: 'Raise llm.maxOutputTokens in config.yaml.',
      });
    }
    if (status === 'incomplete') {
      throw new LlmError(`OpenAI response was incomplete (${reason ?? 'unknown reason'}).`, {
        provider: this.provider,
        retryable: true,
      });
    }
    if (status === 'failed') {
      throw new LlmError('OpenAI response failed.', { provider: this.provider, retryable: true });
    }
  }
}

function toUsage(
  usage: { input_tokens?: number; output_tokens?: number } | undefined | null,
): LlmUsage {
  return {
    inputTokens: usage?.input_tokens ?? null,
    outputTokens: usage?.output_tokens ?? null,
  };
}

function wrapError(error: unknown): unknown {
  if (error instanceof LlmError) return error;
  if (error instanceof APIError) {
    return new LlmError(`OpenAI API error ${error.status ?? '(no status)'}: ${error.message}`, {
      provider: 'openai',
      retryable: isRetryableStatus(error.status),
      cause: error,
      hint:
        error.status === 401
          ? 'Check OPENAI_API_KEY in .env.'
          : error.status === 429
            ? 'Rate limited. Lower http.requestsPerMinute or wait.'
            : undefined,
    });
  }
  return error;
}
