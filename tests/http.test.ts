import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { HttpClient, type FetchImpl } from '../src/http/client.js';
import { HttpConfigSchema } from '../src/config/config.schema.js';
import { SourceError } from '../src/util/errors.js';

/**
 * The HTTP client, with a fake clock. These are other people's free APIs, so
 * the rate limiting is a correctness requirement rather than a nicety — and
 * the tests must assert it without actually waiting.
 */

const config = (overrides: Record<string, unknown> = {}) =>
  HttpConfigSchema.parse({ userAgent: 'job-autopilot-test/1.0 (+https://example.com)', ...overrides });

/** Records how long the client asked to sleep, and advances the fake clock. */
function fakeSleep() {
  const waits: number[] = [];
  return {
    waits,
    sleep: async (ms: number) => {
      waits.push(ms);
      vi.advanceTimersByTime(ms);
    },
    get total() {
      return waits.reduce((sum, ms) => sum + ms, 0);
    },
  };
}

/** Captures the thrown SourceError so its hint can be asserted. */
async function captureError(run: () => Promise<unknown>): Promise<SourceError> {
  try {
    await run();
  } catch (error) {
    return error as SourceError;
  }
  throw new Error('expected the call to reject, but it resolved');
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-26T12:00:00Z'));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('user agent', () => {
  it('sends the configured user agent on every request', async () => {
    const seen: Array<Record<string, string> | undefined> = [];
    const fetchImpl: FetchImpl = async (_url, init) => {
      seen.push(init.headers as Record<string, string>);
      return jsonResponse({ ok: true });
    };

    const client = new HttpClient({
      ...config({ userAgent: 'my-agent/2.0 (+https://example.com/me)' }),
      fetchImpl,
      sleepImpl: fakeSleep().sleep,
    });

    await client.getJson('https://a.example.com/one');
    await client.getJson('https://b.example.com/two');

    expect(seen).toHaveLength(2);
    for (const headers of seen) {
      expect(headers?.['user-agent']).toBe(
        'my-agent/2.0 (+https://example.com/me)',
      );
    }
  });
});

describe('rate limiting', () => {
  it('keeps a minimum gap between hits on the same host', async () => {
    const sleeper = fakeSleep();
    const client = new HttpClient({
      ...config({ requestsPerMinute: 600, perHostMinIntervalMs: 1_000 }),
      fetchImpl: async () => jsonResponse({}),
      sleepImpl: sleeper.sleep,
    });

    await client.getJson('https://board.example.com/1');
    await client.getJson('https://board.example.com/2');
    await client.getJson('https://board.example.com/3');

    // Two gaps for three requests; the first goes straight through.
    expect(sleeper.waits.filter((ms) => ms > 0)).toHaveLength(2);
    expect(sleeper.total).toBeGreaterThanOrEqual(2_000);
  });

  it('does not make one host wait for another', async () => {
    const sleeper = fakeSleep();
    const client = new HttpClient({
      ...config({ requestsPerMinute: 600, perHostMinIntervalMs: 5_000 }),
      fetchImpl: async () => jsonResponse({}),
      sleepImpl: sleeper.sleep,
    });

    await client.getJson('https://one.example.com/x');
    await client.getJson('https://two.example.com/x');
    await client.getJson('https://three.example.com/x');

    expect(sleeper.total).toBe(0);
  });

  it('enforces the global ceiling once the burst is spent', async () => {
    const sleeper = fakeSleep();
    // Three per minute, so the fourth request has to wait for a refill.
    const client = new HttpClient({
      ...config({ requestsPerMinute: 3, perHostMinIntervalMs: 0 }),
      fetchImpl: async () => jsonResponse({}),
      sleepImpl: sleeper.sleep,
    });

    for (let i = 0; i < 3; i += 1) {
      await client.getJson(`https://h${i}.example.com/x`);
    }
    expect(sleeper.total).toBe(0);

    await client.getJson('https://h4.example.com/x');
    expect(sleeper.total).toBeGreaterThan(0);
  });

  it('serialises slot acquisition so concurrent callers do not all pass at once', async () => {
    const sleeper = fakeSleep();
    const client = new HttpClient({
      ...config({ requestsPerMinute: 600, perHostMinIntervalMs: 1_000 }),
      fetchImpl: async () => jsonResponse({}),
      sleepImpl: sleeper.sleep,
    });

    // Fired together: without a queue each would see a free slot and proceed.
    await Promise.all([
      client.getJson('https://board.example.com/1'),
      client.getJson('https://board.example.com/2'),
      client.getJson('https://board.example.com/3'),
    ]);

    expect(sleeper.waits.filter((ms) => ms > 0)).toHaveLength(2);
  });
});

describe('retries', () => {
  it('retries a 503 and succeeds', async () => {
    const sleeper = fakeSleep();
    const fetchImpl = vi
      .fn<FetchImpl>()
      .mockResolvedValueOnce(new Response('busy', { status: 503 }))
      .mockResolvedValueOnce(jsonResponse({ jobs: [] }));

    const client = new HttpClient({
      ...config({ maxRetries: 3 }),
      fetchImpl,
      sleepImpl: sleeper.sleep,
    });

    await expect(client.getJson('https://board.example.com/x')).resolves.toEqual({ jobs: [] });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('honours Retry-After given in seconds', async () => {
    const sleeper = fakeSleep();
    const fetchImpl = vi
      .fn<FetchImpl>()
      .mockResolvedValueOnce(
        new Response('slow down', { status: 429, headers: { 'retry-after': '7' } }),
      )
      .mockResolvedValueOnce(jsonResponse({}));

    const client = new HttpClient({
      ...config({ maxRetries: 2, perHostMinIntervalMs: 0 }),
      fetchImpl,
      sleepImpl: sleeper.sleep,
    });

    await client.getJson('https://board.example.com/x');
    expect(sleeper.waits).toContain(7_000);
  });

  it('caps an absurd Retry-After rather than hanging for an hour', async () => {
    const sleeper = fakeSleep();
    const fetchImpl = vi
      .fn<FetchImpl>()
      .mockResolvedValueOnce(
        new Response('', { status: 429, headers: { 'retry-after': '99999' } }),
      )
      .mockResolvedValueOnce(jsonResponse({}));

    const client = new HttpClient({
      ...config({ maxRetries: 2, perHostMinIntervalMs: 0 }),
      fetchImpl,
      sleepImpl: sleeper.sleep,
    });

    await client.getJson('https://board.example.com/x');
    expect(Math.max(...sleeper.waits)).toBeLessThanOrEqual(60_000);
  });

  it('does not retry a 404 — a wrong board token fails the same way every time', async () => {
    const fetchImpl = vi.fn<FetchImpl>().mockResolvedValue(new Response('', { status: 404 }));
    const client = new HttpClient({
      ...config({ maxRetries: 3 }),
      fetchImpl,
      sleepImpl: fakeSleep().sleep,
    });

    await expect(client.getJson('https://board.example.com/nope')).rejects.toThrow(SourceError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('explains a 404 in terms of the board token', async () => {
    const client = new HttpClient({
      ...config(),
      fetchImpl: async () => new Response('', { status: 404 }),
      sleepImpl: fakeSleep().sleep,
    });

    const error = await captureError(() => client.getJson('https://board.example.com/nope'));
    expect(error.message).toMatch(/HTTP 404/);
    expect(error.hint).toMatch(/board token/i);
  });

  it('suggests the user agent when a board returns 403', async () => {
    const client = new HttpClient({
      ...config(),
      fetchImpl: async () => new Response('', { status: 403 }),
      sleepImpl: fakeSleep().sleep,
    });

    const error = await captureError(() => client.getJson('https://board.example.com/x'));
    expect(error.hint).toMatch(/userAgent/);
  });

  it('gives up after maxRetries', async () => {
    const fetchImpl = vi.fn<FetchImpl>().mockResolvedValue(new Response('', { status: 500 }));
    const client = new HttpClient({
      ...config({ maxRetries: 2, perHostMinIntervalMs: 0 }),
      fetchImpl,
      sleepImpl: fakeSleep().sleep,
    });

    await expect(client.getJson('https://board.example.com/x')).rejects.toThrow(/HTTP 500/);
    expect(fetchImpl).toHaveBeenCalledTimes(3); // initial + 2 retries
  });

  it('retries a network-level failure', async () => {
    const fetchImpl = vi
      .fn<FetchImpl>()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(jsonResponse({ ok: 1 }));

    const client = new HttpClient({
      ...config({ maxRetries: 2, perHostMinIntervalMs: 0 }),
      fetchImpl,
      sleepImpl: fakeSleep().sleep,
    });

    await expect(client.getJson('https://board.example.com/x')).resolves.toEqual({ ok: 1 });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

describe('responses', () => {
  it('reports non-JSON with its size rather than a parser stack trace', async () => {
    const client = new HttpClient({
      ...config(),
      fetchImpl: async () => new Response('<html>maintenance</html>', { status: 200 }),
      sleepImpl: fakeSleep().sleep,
    });

    await expect(client.getJson('https://board.example.com/x')).rejects.toThrow(
      /not valid JSON/,
    );
  });

  it('counts requests, including retried ones', async () => {
    const fetchImpl = vi
      .fn<FetchImpl>()
      .mockResolvedValueOnce(new Response('', { status: 503 }))
      .mockResolvedValueOnce(jsonResponse({}));

    const client = new HttpClient({
      ...config({ maxRetries: 2, perHostMinIntervalMs: 0 }),
      fetchImpl,
      sleepImpl: fakeSleep().sleep,
    });

    await client.getJson('https://board.example.com/x');
    expect(client.requestsMade).toBe(2);
  });

  it('times out a slow response', async () => {
    const client = new HttpClient({
      ...config({ timeoutMs: 1_000, maxRetries: 0 }),
      fetchImpl: (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
      sleepImpl: fakeSleep().sleep,
    });

    // Attach the rejection handler before advancing the clock: otherwise the
    // promise rejects with nothing listening and Node reports it as unhandled.
    const assertion = expect(client.getJson('https://slow.example.com/x')).rejects.toThrow(
      /timed out after 1000ms/,
    );
    await vi.advanceTimersByTimeAsync(1_500);
    await assertion;
  });
});
