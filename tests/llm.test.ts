import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { LlmError } from '../src/util/errors.js';
import { withRetries, isRetryableStatus } from '../src/llm/retry.js';
import type { LlmClient, StructuredRequest, TextRequest } from '../src/llm/types.js';

/**
 * The adapter boundary, tested without a network or an API key.
 *
 * The real provider classes are exercised against the live APIs by hand; what
 * matters to the rest of the codebase is that `LlmClient` is satisfiable and
 * that the shared retry policy does what it says. A fake implementing the
 * interface is also what the scoring and drafting tests will use.
 */

/** A stand-in client, used here and (later) by the scoring and draft tests. */
class FakeLlmClient implements LlmClient {
  readonly provider = 'anthropic' as const;
  readonly model = 'fake-model';

  readonly textCalls: TextRequest[] = [];
  readonly structuredCalls: StructuredRequest<z.ZodType>[] = [];

  constructor(
    private readonly responses: { text?: string; structured?: unknown } = {},
  ) {}

  async complete(request: TextRequest) {
    this.textCalls.push(request);
    return {
      value: this.responses.text ?? 'fake letter',
      usage: { inputTokens: 100, outputTokens: 50 },
      model: this.model,
      provider: this.provider,
    };
  }

  async completeStructured<T extends z.ZodType>(request: StructuredRequest<T>) {
    this.structuredCalls.push(request as StructuredRequest<z.ZodType>);
    const parsed = request.schema.safeParse(this.responses.structured);
    if (!parsed.success) {
      throw new LlmError('fake output failed validation', {
        provider: this.provider,
        retryable: false,
      });
    }
    return {
      value: parsed.data as z.infer<T>,
      usage: { inputTokens: 100, outputTokens: 50 },
      model: this.model,
      provider: this.provider,
    };
  }
}

describe('LlmClient interface', () => {
  it('can be satisfied without any provider SDK', async () => {
    const client: LlmClient = new FakeLlmClient({ text: 'hello' });
    const result = await client.complete({ system: 's', prompt: 'p' });

    expect(result.value).toBe('hello');
    expect(result.provider).toBe('anthropic');
    expect(result.usage.inputTokens).toBe(100);
  });

  it('validates structured output against the caller\'s schema', async () => {
    const schema = z.object({ score: z.number().int().min(0).max(100) });
    const good = new FakeLlmClient({ structured: { score: 81 } });

    const result = await good.completeStructured({
      system: 's',
      prompt: 'p',
      schema,
      schemaName: 'FitScore',
    });
    expect(result.value.score).toBe(81);
  });

  it('rejects structured output that does not match, rather than coercing it', async () => {
    const schema = z.object({ score: z.number().int().min(0).max(100) });
    const bad = new FakeLlmClient({ structured: { score: 420 } });

    await expect(
      bad.completeStructured({ system: 's', prompt: 'p', schema, schemaName: 'FitScore' }),
    ).rejects.toThrow(LlmError);
  });
});

describe('withRetries', () => {
  it('returns the first success without waiting', async () => {
    const operation = vi.fn().mockResolvedValue('ok');
    await expect(withRetries(operation, { maxRetries: 3, label: 'test' })).resolves.toBe('ok');
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('retries a retryable error and succeeds', async () => {
    const operation = vi
      .fn()
      .mockRejectedValueOnce(new LlmError('rate limited', { retryable: true }))
      .mockResolvedValue('ok');

    await expect(withRetries(operation, { maxRetries: 3, label: 'test' })).resolves.toBe('ok');
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it('does not retry a non-retryable error — a 400 fails the same way three times', async () => {
    const operation = vi
      .fn()
      .mockRejectedValue(new LlmError('bad request', { retryable: false }));

    await expect(withRetries(operation, { maxRetries: 3, label: 'test' })).rejects.toThrow(
      'bad request',
    );
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('does not retry an unrecognised error, since retryability is unknown', async () => {
    const operation = vi.fn().mockRejectedValue(new Error('something else'));

    await expect(withRetries(operation, { maxRetries: 3, label: 'test' })).rejects.toThrow(
      'something else',
    );
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('gives up after maxRetries and rethrows the last error', async () => {
    const operation = vi
      .fn()
      .mockRejectedValue(new LlmError('still down', { retryable: true }));

    await expect(withRetries(operation, { maxRetries: 2, label: 'test' })).rejects.toThrow(
      'still down',
    );
    expect(operation).toHaveBeenCalledTimes(3); // initial + 2 retries
  });

  it('honours maxRetries: 0', async () => {
    const operation = vi.fn().mockRejectedValue(new LlmError('nope', { retryable: true }));
    await expect(withRetries(operation, { maxRetries: 0, label: 'test' })).rejects.toThrow('nope');
    expect(operation).toHaveBeenCalledTimes(1);
  });
});

describe('isRetryableStatus', () => {
  it('retries throttling and server faults', () => {
    for (const status of [408, 409, 429, 500, 502, 503, 504]) {
      expect(isRetryableStatus(status), String(status)).toBe(true);
    }
  });

  it('does not retry client mistakes', () => {
    for (const status of [400, 401, 403, 404, 422]) {
      expect(isRetryableStatus(status), String(status)).toBe(false);
    }
  });

  it('retries a network-level failure with no status', () => {
    expect(isRetryableStatus(undefined)).toBe(true);
  });
});

describe('LlmError', () => {
  it('defaults to not retryable, so unknown failures do not hammer a provider', () => {
    expect(new LlmError('x').retryable).toBe(false);
  });

  it('carries a hint for the CLI to print', () => {
    const error = new LlmError('no key', { hint: 'Set ANTHROPIC_API_KEY.' });
    expect(error.hint).toBe('Set ANTHROPIC_API_KEY.');
  });
});
