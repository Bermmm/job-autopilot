/**
 * Runs tasks with a bounded number in flight.
 *
 * Scoring 170 postings one at a time takes minutes of mostly waiting, and
 * firing all 170 at once earns a rate-limit. Results come back in input
 * order regardless of completion order, so output is deterministic.
 */
export async function mapPool<In, Out>(
  items: readonly In[],
  concurrency: number,
  worker: (item: In, index: number) => Promise<Out>,
  onSettled?: (result: PoolResult<Out>, item: In, index: number) => void,
): Promise<PoolResult<Out>[]> {
  const results = new Array<PoolResult<Out>>(items.length);
  const limit = Math.max(1, Math.min(concurrency, items.length));
  let next = 0;

  async function run(): Promise<void> {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) return;

      const item = items[index]!;
      let settled: PoolResult<Out>;
      try {
        settled = { ok: true, value: await worker(item, index) };
      } catch (error) {
        settled = { ok: false, error };
      }
      results[index] = settled;
      onSettled?.(settled, item, index);
    }
  }

  await Promise.all(Array.from({ length: limit }, run));
  return results;
}

export type PoolResult<T> = { ok: true; value: T } | { ok: false; error: unknown };
