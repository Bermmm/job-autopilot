import { describe, expect, it } from 'vitest';

import { FreshnessConfigSchema } from '../src/config/config.schema.js';
import { filterFresh, isFresh, matchesTitleFilter } from '../src/sources/freshness.js';
import type { JobInput } from '../src/db/repo.js';

/**
 * The 48-hour rule. Getting this wrong in either direction is costly: too
 * strict and you miss jobs, too loose and you waste scoring tokens on
 * postings that have been up for months.
 */

const NOW = Date.parse('2026-11-26T12:00:00Z');
const hoursAgo = (hours: number) => new Date(NOW - hours * 3_600_000).toISOString();

const config = (overrides: Record<string, unknown> = {}) =>
  FreshnessConfigSchema.parse(overrides);

function job(overrides: Partial<JobInput> = {}): JobInput {
  return {
    source: 'greenhouse',
    externalId: 'x',
    company: 'Acme',
    title: 'Backend Engineer',
    url: 'https://example.com/x',
    postedAt: hoursAgo(1),
    ...overrides,
  };
}

describe('isFresh', () => {
  const options = { now: NOW, windowHours: 48, keepUndated: true };

  it('accepts a posting inside the window', () => {
    expect(isFresh(hoursAgo(1), options)).toBe(true);
    expect(isFresh(hoursAgo(47), options)).toBe(true);
  });

  it('accepts a posting exactly on the boundary', () => {
    expect(isFresh(hoursAgo(48), options)).toBe(true);
  });

  it('rejects a posting just past the window', () => {
    expect(isFresh(hoursAgo(48.1), options)).toBe(false);
    expect(isFresh(hoursAgo(72), options)).toBe(false);
  });

  it('keeps a future-dated posting, which is a board clock artefact', () => {
    // Discarding these would drop genuinely new jobs over a timezone bug.
    expect(isFresh(new Date(NOW + 3_600_000).toISOString(), options)).toBe(true);
  });

  it('follows the config for an undated posting', () => {
    expect(isFresh(null, { ...options, keepUndated: true })).toBe(true);
    expect(isFresh(null, { ...options, keepUndated: false })).toBe(false);
    expect(isFresh(undefined, { ...options, keepUndated: false })).toBe(false);
  });

  it('treats an unparseable date as undated rather than crashing', () => {
    expect(isFresh('last Tuesday', { ...options, keepUndated: true })).toBe(true);
    expect(isFresh('last Tuesday', { ...options, keepUndated: false })).toBe(false);
  });

  it('honours a widened window, for backfilling on a first run', () => {
    expect(isFresh(hoursAgo(100), { ...options, windowHours: 168 })).toBe(true);
    expect(isFresh(hoursAgo(200), { ...options, windowHours: 168 })).toBe(false);
  });

  it('handles offset timestamps as the boards send them', () => {
    // 2026-11-26T07:00:00-04:00 is 11:00Z — one hour before NOW.
    expect(isFresh('2026-11-26T07:00:00-04:00', options)).toBe(true);
  });
});

describe('filterFresh', () => {
  it('splits postings and counts why each was dropped', () => {
    const result = filterFresh(
      [
        job({ externalId: 'fresh-1', postedAt: hoursAgo(2) }),
        job({ externalId: 'fresh-2', postedAt: hoursAgo(40) }),
        job({ externalId: 'stale-1', postedAt: hoursAgo(100) }),
        job({ externalId: 'stale-2', postedAt: hoursAgo(5000) }),
        job({ externalId: 'undated', postedAt: null }),
      ],
      config({ keepUndatedOnFirstSight: false }),
      NOW,
    );

    expect(result.fresh.map((j) => j.externalId)).toEqual(['fresh-1', 'fresh-2']);
    expect(result.stale).toBe(2);
    expect(result.undated).toBe(1);
  });

  it('counts an undated posting as fresh when the config says to keep it', () => {
    const result = filterFresh(
      [job({ externalId: 'undated', postedAt: null })],
      config({ keepUndatedOnFirstSight: true }),
      NOW,
    );

    expect(result.fresh).toHaveLength(1);
    expect(result.undated).toBe(0);
  });

  it('never counts a posting twice', () => {
    const jobs = Array.from({ length: 20 }, (_, i) =>
      job({ externalId: `j${i}`, postedAt: hoursAgo(i * 10) }),
    );
    const result = filterFresh(jobs, config(), NOW);

    expect(result.fresh.length + result.stale + result.undated).toBe(jobs.length);
  });

  it('handles an empty board', () => {
    const result = filterFresh([], config(), NOW);
    expect(result).toEqual({ fresh: [], stale: 0, undated: 0 });
  });
});

describe('matchesTitleFilter', () => {
  it('passes everything when no filter is configured', () => {
    expect(matchesTitleFilter('Anything At All', [])).toBe(true);
  });

  it('matches case-insensitively on a substring', () => {
    expect(matchesTitleFilter('Senior Backend Engineer', ['engineer'])).toBe(true);
    expect(matchesTitleFilter('SENIOR BACKEND ENGINEER', ['engineer'])).toBe(true);
    expect(matchesTitleFilter('Engineering Manager', ['engineer'])).toBe(true);
  });

  it('passes when any term matches', () => {
    expect(matchesTitleFilter('Product Designer', ['engineer', 'designer'])).toBe(true);
  });

  it('rejects a title matching nothing', () => {
    expect(matchesTitleFilter('Account Executive', ['engineer', 'developer'])).toBe(false);
  });
});
