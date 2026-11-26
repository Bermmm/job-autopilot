import { describe, expect, it } from 'vitest';

import { mapPool } from '../src/util/pool.js';

describe('mapPool', () => {
  it('returns results in input order regardless of completion order', async () => {
    const results = await mapPool([30, 10, 20], 3, async (ms) => {
      await new Promise((resolve) => setTimeout(resolve, ms));
      return ms;
    });

    expect(results.map((r) => (r.ok ? r.value : null))).toEqual([30, 10, 20]);
  });

  it('never exceeds the concurrency limit', async () => {
    let inFlight = 0;
    let peak = 0;

    await mapPool(Array.from({ length: 20 }, (_, i) => i), 4, async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return null;
    });

    expect(peak).toBeLessThanOrEqual(4);
    expect(peak).toBeGreaterThan(1);
  });

  it('isolates a failure instead of losing the whole batch', async () => {
    const results = await mapPool([1, 2, 3], 2, async (n) => {
      if (n === 2) throw new Error('boom');
      return n;
    });

    expect(results[0]).toEqual({ ok: true, value: 1 });
    expect(results[1]!.ok).toBe(false);
    expect(results[2]).toEqual({ ok: true, value: 3 });
  });

  it('reports each result as it settles, so progress is visible', async () => {
    const seen: number[] = [];
    await mapPool([1, 2, 3], 1, async (n) => n, (result) => {
      if (result.ok) seen.push(result.value);
    });
    expect(seen).toEqual([1, 2, 3]);
  });

  it('handles an empty list', async () => {
    expect(await mapPool([], 4, async () => null)).toEqual([]);
  });

  it('does not spawn more workers than there are items', async () => {
    let started = 0;
    await mapPool([1], 16, async (n) => {
      started += 1;
      return n;
    });
    expect(started).toBe(1);
  });
});
