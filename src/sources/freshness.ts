import type { FreshnessConfig } from '../config/config.schema.js';
import type { JobInput } from '../db/repo.js';

/**
 * The 48-hour filter.
 *
 * All three board APIs publish a real first-published timestamp
 * (`first_published`, `createdAt`, `publishedAt`) and across ~5,000 live
 * postings none were missing one — so this is reliable for boards, and the
 * undated path only comes up for RSS feeds.
 *
 * It deliberately does *not* use "last updated". On one real Greenhouse board,
 * `updated_at` reported five postings as new within 48 hours while
 * `first_published` reported none: old roles that had merely been edited.
 */

export interface FreshnessDecision {
  fresh: JobInput[];
  /** Postings that exist but are older than the window. */
  stale: number;
  /** Postings with no date, dropped because the config says to. */
  undated: number;
}

export function isFresh(
  postedAt: string | null | undefined,
  options: { now: number; windowHours: number; keepUndated: boolean },
): boolean {
  if (!postedAt) return options.keepUndated;

  const timestamp = Date.parse(postedAt);
  if (Number.isNaN(timestamp)) return options.keepUndated;

  // A posting dated in the future is a board clock or timezone artefact.
  // Treat it as new rather than discarding a real job.
  if (timestamp > options.now) return true;

  return options.now - timestamp <= options.windowHours * 3_600_000;
}

/** Splits a fetcher's output into fresh and not, counting why. */
export function filterFresh(
  jobs: JobInput[],
  config: FreshnessConfig,
  now: number = Date.now(),
): FreshnessDecision {
  const result: FreshnessDecision = { fresh: [], stale: 0, undated: 0 };

  for (const job of jobs) {
    const hasDate = Boolean(job.postedAt && !Number.isNaN(Date.parse(job.postedAt)));

    if (isFresh(job.postedAt, {
      now,
      windowHours: config.windowHours,
      keepUndated: config.keepUndatedOnFirstSight,
    })) {
      result.fresh.push(job);
    } else if (hasDate) {
      result.stale += 1;
    } else {
      result.undated += 1;
    }
  }

  return result;
}

/** Case-insensitive substring match against a board's `titleIncludes`. */
export function matchesTitleFilter(title: string, titleIncludes: readonly string[]): boolean {
  if (titleIncludes.length === 0) return true;
  const lower = title.toLowerCase();
  return titleIncludes.some((needle) => lower.includes(needle.toLowerCase()));
}
