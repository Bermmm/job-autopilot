import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

import { CompaniesFileSchema } from '../src/config/companies.schema.js';
import { ConfigSchema } from '../src/config/config.schema.js';
import { resolveFromRoot } from '../src/config/load.js';
import { openDatabase } from '../src/db/index.js';
import { Repo } from '../src/db/repo.js';
import { hunt } from '../src/cli/hunt.js';
import type { HttpClient } from '../src/http/client.js';

/**
 * End-to-end `hunt`, from board payload to stored rows, with the network
 * stubbed at the HTTP client. Fixtures are real API captures, so what is
 * exercised is the actual translation and the actual constraints.
 */

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(resolveFromRoot(`tests/fixtures/${name}`), 'utf8'));
}

/**
 * The fixtures are real captures, so their publish dates are real history —
 * spanning 885 days, which no legal freshness window covers. These tests are
 * about pipeline wiring, so the dates are rewritten to "an hour ago" while
 * every field name, nesting level, and encoding quirk stays exactly as the
 * board sent it. The freshness rule itself is tested exhaustively, against
 * fixed clocks, in freshness.test.ts.
 */
function dated(name: string): unknown {
  const oneHourAgo = Date.now() - 3_600_000;
  const payload = fixture(name);

  if (Array.isArray(payload)) {
    // Lever: bare array, epoch-millisecond createdAt.
    return payload.map((job) => ({ ...(job as object), createdAt: oneHourAgo }));
  }

  const iso = new Date(oneHourAgo).toISOString();
  const { jobs, ...rest } = payload as { jobs: Record<string, unknown>[] };
  return {
    ...rest,
    jobs: jobs.map((job) => ({
      ...job,
      // Greenhouse and Ashby respectively; setting both is harmless since
      // each fetcher only reads its own field.
      ...('first_published' in job ? { first_published: iso } : {}),
      ...('publishedAt' in job ? { publishedAt: iso } : {}),
    })),
  };
}

/** An HttpClient stand-in that serves fixtures by URL pattern. */
function stubHttpClient(routes: Array<[RegExp, unknown | Error]>) {
  const requested: string[] = [];

  const http = {
    async getJson<T>(url: string): Promise<T> {
      requested.push(url);
      for (const [pattern, payload] of routes) {
        if (pattern.test(url)) {
          if (payload instanceof Error) throw payload;
          return payload as T;
        }
      }
      throw new Error(`no stub for ${url}`);
    },
    async getText(): Promise<string> {
      return '';
    },
    get requestsMade() {
      return requested.length;
    },
  } as unknown as HttpClient;

  return { requested, http };
}

const config = (overrides: Record<string, unknown> = {}) =>
  ConfigSchema.parse({
    llm: { model: 'test-model' },
    ...overrides,
  });

const companies = (boards: unknown[]) => CompaniesFileSchema.parse({ boards, feeds: [] });

function freshRepo(): Repo {
  return new Repo(openDatabase({ path: ':memory:' }));
}

describe('hunt', () => {
  it('stores postings from all three board types in one run', async () => {
    const { http } = stubHttpClient([
      [/boards-api\.greenhouse\.io/, dated('greenhouse-discord.json')],
      [/api\.lever\.co/, dated('lever-leverdemo.json')],
      [/api\.ashbyhq\.com/, dated('ashby-ramp.json')],
    ]);

    const repo = freshRepo();
    const code = await hunt(
      config(),
      companies([
        { source: 'greenhouse', token: 'discord', name: 'Discord' },
        { source: 'lever', token: 'leverdemo', name: 'Lever Demo' },
        { source: 'ashby', token: 'ramp', name: 'Ramp' },
      ]),
      repo,
      { http },
    );

    expect(code).toBe(0);
    expect(repo.countJobs()).toBeGreaterThan(0);

    const sources = new Set(repo.listJobs({ limit: 100 }).map((job) => job.source));
    expect(sources).toEqual(new Set(['greenhouse', 'lever', 'ashby']));
  });

  it('is idempotent: a second run stores nothing new', async () => {
    const { http } = stubHttpClient([[/greenhouse/, dated('greenhouse-discord.json')]]);

    const repo = freshRepo();
    const boards = companies([{ source: 'greenhouse', token: 'discord' }]);

    await hunt(config(), boards, repo, { http });
    const afterFirst = repo.countJobs();

    await hunt(config(), boards, repo, { http });
    expect(repo.countJobs()).toBe(afterFirst);
  });

  it('writes nothing on a dry run', async () => {
    const { http } = stubHttpClient([[/greenhouse/, dated('greenhouse-discord.json')]]);

    const repo = freshRepo();
    await hunt(config(), companies([{ source: 'greenhouse', token: 'discord' }]), repo, {
      dryRun: true,
      http,
    });

    expect(repo.countJobs()).toBe(0);
  });

  it('keeps going when one board fails, and reports it', async () => {
    const { http } = stubHttpClient([
      [/api\.lever\.co/, new Error('https://api.lever.co/v0/postings/gone?mode=json returned HTTP 404.')],
      [/greenhouse/, dated('greenhouse-discord.json')],
    ]);

    const repo = freshRepo();
    const code = await hunt(
      config(),
      companies([
        { source: 'lever', token: 'gone' },
        { source: 'greenhouse', token: 'discord' },
      ]),
      repo,
      { http },
    );

    // A partial failure is not a failed run.
    expect(code).toBe(0);
    expect(repo.countJobs()).toBeGreaterThan(0);
  });

  it('fails the run only when every board fails', async () => {
    const { http } = stubHttpClient([[/./, new Error('HTTP 503')]]);

    const repo = freshRepo();
    const code = await hunt(
      config(),
      companies([{ source: 'greenhouse', token: 'x' }]),
      repo,
      { http },
    );

    expect(code).toBe(1);
  });

  it('records a fetch run per board, successes and failures alike', async () => {
    const { http } = stubHttpClient([
      [/api\.lever\.co/, new Error('HTTP 404')],
      [/greenhouse/, dated('greenhouse-discord.json')],
    ]);

    const repo = freshRepo();
    await hunt(
      config(),
      companies([
        { source: 'greenhouse', token: 'discord' },
        { source: 'lever', token: 'gone' },
      ]),
      repo,
      { http },
    );

    const runs = repo.recentFetchRuns();
    expect(runs).toHaveLength(2);
    expect(runs.filter((run) => run.ok)).toHaveLength(1);
    expect(runs.find((run) => !run.ok)?.error).toMatch(/404/);
  });

  it('skips disabled boards without making a request', async () => {
    const { requested, http } = stubHttpClient([[/greenhouse/, dated('greenhouse-discord.json')]]);

    const repo = freshRepo();
    await hunt(
      config(),
      companies([
        { source: 'greenhouse', token: 'discord' },
        { source: 'greenhouse', token: 'parked', enabled: false },
      ]),
      repo,
      { http },
    );

    expect(requested).toHaveLength(1);
  });

  it('applies --only before making any request', async () => {
    const { requested, http } = stubHttpClient([
      [/greenhouse/, dated('greenhouse-discord.json')],
      [/ashby/, dated('ashby-ramp.json')],
    ]);

    const repo = freshRepo();
    await hunt(
      config(),
      companies([
        { source: 'greenhouse', token: 'discord', name: 'Discord' },
        { source: 'ashby', token: 'ramp', name: 'Ramp' },
      ]),
      repo,
      { only: 'ramp', http },
    );

    expect(requested).toHaveLength(1);
    expect(requested[0]).toMatch(/ashby/);
  });

  it('errors when --only matches no board', async () => {
    const { http } = stubHttpClient([[/./, {}]]);
    const repo = freshRepo();
    const code = await hunt(
      config(),
      companies([{ source: 'greenhouse', token: 'discord' }]),
      repo,
      { only: 'nothing-like-this', http },
    );

    expect(code).toBe(1);
    expect(repo.countJobs()).toBe(0);
  });

  it('keeps title-filtered postings out of the database entirely', async () => {
    const { http } = stubHttpClient([[/greenhouse/, dated('greenhouse-discord.json')]]);

    const repo = freshRepo();
    await hunt(
      config(),
      companies([
        {
          source: 'greenhouse',
          token: 'discord',
          // No fixture posting is an engineering role, so everything is cut.
          titleIncludes: ['site reliability engineer'],
        },
      ]),
      repo,
      { http },
    );

    // Filtering before storage is what keeps these off the scoring bill.
    expect(repo.countJobs()).toBe(0);
  });

  it('honours a widened window for backfilling', async () => {
    // A posting from five days ago: outside the 48h default, inside a week.
    const fiveDaysAgo = new Date(Date.now() - 5 * 86_400_000).toISOString();
    const { http } = stubHttpClient([
      [
        /greenhouse/,
        {
          jobs: [
            {
              id: 1,
              title: 'Backend Engineer',
              absolute_url: 'https://example.com/1',
              first_published: fiveDaysAgo,
            },
          ],
        },
      ],
    ]);

    const repo = freshRepo();
    const boards = companies([{ source: 'greenhouse', token: 'discord' }]);

    await hunt(config({ freshness: { windowHours: 48 } }), boards, repo, { http });
    expect(repo.countJobs()).toBe(0);

    await hunt(config({ freshness: { windowHours: 48 } }), boards, repo, {
      windowHours: 168,
      http,
    });
    expect(repo.countJobs()).toBe(1);
  });

  it('collapses the same role at one company into a single application', async () => {
    // Two postings of one role in different cities, as boards really publish.
    const { http } = stubHttpClient([
      [
        /greenhouse/,
        {
          jobs: [
            {
              id: 1,
              title: 'Senior Backend Engineer - Berlin',
              absolute_url: 'https://example.com/1',
              first_published: '2026-11-26T09:00:00Z',
              location: { name: 'Berlin, Germany' },
            },
            {
              id: 2,
              title: 'Sr. Backend Engineer (Remote)',
              absolute_url: 'https://example.com/2',
              first_published: '2026-11-26T10:00:00Z',
              location: { name: 'Lisbon, Portugal' },
            },
          ],
        },
      ],
    ]);

    const repo = freshRepo();
    await hunt(
      config(),
      companies([{ source: 'greenhouse', token: 'acme', name: 'Acme' }]),
      repo,
      { http },
    );

    expect(repo.countJobs()).toBe(2);

    let created = 0;
    for (const job of repo.listJobs({ limit: 10 })) {
      if (repo.ensureApplicationForJob(job).created) created += 1;
    }

    expect(created).toBe(1);
    expect(repo.listApplications()).toHaveLength(1);
  });

  it('survives a board that renames itself in config', async () => {
    // Dedupe keys come from the board token, not the display name, so a
    // rename must not make past applications invisible.
    const { http } = stubHttpClient([
      [
        /greenhouse/,
        {
          jobs: [
            {
              id: 1,
              title: 'Backend Engineer',
              absolute_url: 'https://example.com/1',
              first_published: '2026-11-26T09:00:00Z',
            },
          ],
        },
      ],
    ]);

    const repo = freshRepo();
    await hunt(
      config(),
      companies([{ source: 'greenhouse', token: 'acme', name: 'Acme' }]),
      repo,
      { http },
    );
    const before = repo.listJobs({ limit: 1 })[0]!;
    repo.ensureApplicationForJob(before);

    await hunt(
      config(),
      companies([{ source: 'greenhouse', token: 'acme', name: 'Acme Corporation GmbH' }]),
      repo,
      { http },
    );
    const after = repo.listJobs({ limit: 1 })[0]!;

    expect(after.dedupeKey).toBe(before.dedupeKey);
    expect(repo.ensureApplicationForJob(after).created).toBe(false);
    expect(repo.listApplications()).toHaveLength(1);
  });
});
