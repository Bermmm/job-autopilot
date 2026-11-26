import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

import { BoardSchema, type Board } from '../src/config/companies.schema.js';
import { resolveFromRoot } from '../src/config/load.js';
import { GreenhouseFetcher } from '../src/sources/greenhouse.js';
import { LeverFetcher } from '../src/sources/lever.js';
import { AshbyFetcher } from '../src/sources/ashby.js';
import { htmlToText, decodeEntities, truncateText } from '../src/sources/html.js';
import { isRemotePosting, normalizeWorkplaceType } from '../src/sources/types.js';
import type { FetchContext } from '../src/sources/types.js';
import type { HttpClient } from '../src/http/client.js';

/**
 * Fetchers are tested against fixtures captured from the live APIs, so the
 * field names, nesting, and encoding quirks under test are the real ones
 * rather than what the docs or I assumed they were.
 */

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(resolveFromRoot(`tests/fixtures/${name}`), 'utf8'));
}

/** An HttpClient stand-in that serves one canned payload. */
function stubHttp(payload: unknown): { context: FetchContext; urls: string[] } {
  const urls: string[] = [];
  const http = {
    async getJson<T>(url: string): Promise<T> {
      urls.push(url);
      return payload as T;
    },
    async getText(url: string): Promise<string> {
      urls.push(url);
      return String(payload);
    },
    get requestsMade() {
      return urls.length;
    },
  } as unknown as HttpClient;

  return { context: { http, maxDescriptionChars: 12_000 }, urls };
}

function board(overrides: Partial<Board> & Pick<Board, 'source' | 'token'>): Board {
  return BoardSchema.parse(overrides);
}

describe('GreenhouseFetcher', () => {
  const fetcher = new GreenhouseFetcher();
  const config = board({ source: 'greenhouse', token: 'discord', name: 'Discord' });

  it('asks for descriptions inline, so there is no per-job request', async () => {
    const { context, urls } = stubHttp(fixture('greenhouse-discord.json'));
    await fetcher.fetch(config, context);

    expect(urls).toHaveLength(1);
    expect(urls[0]).toBe(
      'https://boards-api.greenhouse.io/v1/boards/discord/jobs?content=true',
    );
  });

  it('maps a real posting', async () => {
    const { context } = stubHttp(fixture('greenhouse-discord.json'));
    const jobs = await fetcher.fetch(config, context);

    expect(jobs.length).toBeGreaterThan(0);
    const job = jobs[0]!;
    expect(job.source).toBe('greenhouse');
    expect(job.externalId).toMatch(/^\d+$/);
    expect(job.title.length).toBeGreaterThan(0);
    expect(job.url).toMatch(/^https:\/\//);
    expect(job.companyKey).toBe('discord');
    expect(job.company).toBe('Discord');
  });

  it('dates every real posting from first_published', async () => {
    const raw = fixture('greenhouse-discord.json') as {
      jobs: { first_published: string }[];
    };
    const { context } = stubHttp(raw);
    const jobs = await fetcher.fetch(config, context);

    jobs.forEach((job, index) => {
      expect(job.postedAt).toBe(new Date(raw.jobs[index]!.first_published).toISOString());
    });
  });

  it('ignores updated_at, which would make an edited old role look new', async () => {
    // Greenhouse publishes both. An old posting edited yesterday is the case
    // that matters: on one real board updated_at reported five such postings
    // as new within 48 hours while first_published reported none.
    const { context } = stubHttp({
      jobs: [
        {
          id: 1,
          title: 'Engineer',
          absolute_url: 'https://example.com/1',
          first_published: '2025-01-28T18:57:29-05:00',
          updated_at: '2026-11-25T13:40:12-04:00',
        },
      ],
    });
    const jobs = await fetcher.fetch(config, context);

    expect(jobs[0]!.postedAt).toBe('2025-01-28T23:57:29.000Z');
    expect(jobs[0]!.postedAt).not.toMatch(/^2026/);
  });

  it('normalises the offset timestamp to UTC', async () => {
    const { context } = stubHttp(fixture('greenhouse-discord.json'));
    const jobs = await fetcher.fetch(config, context);
    expect(jobs[0]!.postedAt).toMatch(/Z$/);
  });

  it('decodes the double-escaped HTML description into plain text', async () => {
    const { context } = stubHttp(fixture('greenhouse-discord.json'));
    const jobs = await fetcher.fetch(config, context);
    const description = jobs[0]!.description!;

    expect(description.length).toBeGreaterThan(50);
    // Neither the escaped form nor real markup should survive.
    expect(description).not.toMatch(/&lt;|&gt;|&quot;|&amp;/);
    expect(description).not.toMatch(/<\/?(div|p|strong)\b/i);
  });

  it('prefers the configured name but falls back to the board token', async () => {
    const { context } = stubHttp(fixture('greenhouse-discord.json'));
    const unnamed = board({ source: 'greenhouse', token: 'discord' });
    const jobs = await fetcher.fetch(unnamed, context);

    // company_name from the API is used when config gives no name.
    expect(jobs[0]!.company).toBe('Discord');
    expect(jobs[0]!.companyKey).toBe('discord');
  });

  it('tolerates fields the board adds later', async () => {
    const { context } = stubHttp({
      jobs: [
        {
          id: 1,
          title: 'Engineer',
          absolute_url: 'https://example.com/1',
          first_published: '2026-11-25T10:00:00Z',
          some_future_field: { nested: true },
        },
      ],
      another_new_top_level_key: 42,
    });
    const jobs = await fetcher.fetch(config, context);
    expect(jobs).toHaveLength(1);
  });

  it('rejects a payload missing a required field rather than storing junk', async () => {
    const { context } = stubHttp({ jobs: [{ id: 1, title: 'Engineer' }] });
    await expect(fetcher.fetch(config, context)).rejects.toThrow();
  });
});

describe('LeverFetcher', () => {
  const fetcher = new LeverFetcher();
  const config = board({ source: 'lever', token: 'leverdemo', name: 'Lever Demo' });

  it('maps a real posting, including the quirks', async () => {
    const { context } = stubHttp(fixture('lever-leverdemo.json'));
    const jobs = await fetcher.fetch(config, context);

    expect(jobs.length).toBeGreaterThan(0);
    const job = jobs[0]!;
    // The response is a bare array and the title field is `text`.
    expect(job.title.length).toBeGreaterThan(0);
    expect(job.source).toBe('lever');
    expect(job.url).toMatch(/jobs\.lever\.co/);
    // No company name exists in the payload, so it comes from config.
    expect(job.company).toBe('Lever Demo');
    expect(job.companyKey).toBe('leverdemo');
  });

  it('converts epoch-millisecond createdAt to an ISO string', async () => {
    const raw = fixture('lever-leverdemo.json') as { createdAt: number }[];
    const { context } = stubHttp(raw);
    const jobs = await fetcher.fetch(config, context);

    expect(typeof raw[0]!.createdAt).toBe('number');
    expect(jobs[0]!.postedAt).toBe(new Date(raw[0]!.createdAt).toISOString());
  });

  it('uses descriptionPlain rather than shipping HTML to the model', async () => {
    const { context } = stubHttp(fixture('lever-leverdemo.json'));
    const jobs = await fetcher.fetch(config, context);
    expect(jobs[0]!.description).not.toMatch(/<\/?(div|p|strong|br)\b/i);
  });

  it('reads remoteness from workplaceType', async () => {
    const { context } = stubHttp([
      {
        id: 'a',
        text: 'Engineer',
        hostedUrl: 'https://jobs.lever.co/x/a',
        workplaceType: 'remote',
        createdAt: 1764000000000,
        categories: { location: 'Anywhere' },
      },
      {
        id: 'b',
        text: 'Engineer',
        hostedUrl: 'https://jobs.lever.co/x/b',
        workplaceType: 'onsite',
        createdAt: 1764000000000,
        categories: { location: 'Berlin' },
      },
    ]);
    const jobs = await fetcher.fetch(config, context);
    expect(jobs[0]!.remote).toBe(true);
    expect(jobs[1]!.remote).toBe(false);
  });

  it('leaves postedAt null when createdAt is missing', async () => {
    const { context } = stubHttp([
      { id: 'a', text: 'Engineer', hostedUrl: 'https://jobs.lever.co/x/a' },
    ]);
    const jobs = await fetcher.fetch(config, context);
    expect(jobs[0]!.postedAt).toBeNull();
  });
});

describe('AshbyFetcher', () => {
  const fetcher = new AshbyFetcher();
  const config = board({ source: 'ashby', token: 'ramp', name: 'Ramp' });

  it('maps a real posting', async () => {
    const { context } = stubHttp(fixture('ashby-ramp.json'));
    const jobs = await fetcher.fetch(config, context);

    expect(jobs.length).toBeGreaterThan(0);
    const job = jobs[0]!;
    expect(job.source).toBe('ashby');
    expect(job.postedAt).toMatch(/Z$/);
    expect(job.company).toBe('Ramp');
    expect(job.companyKey).toBe('ramp');
    expect(job.description).toBeTruthy();
  });

  it('skips postings the company is not advertising', async () => {
    const raw = fixture('ashby-ramp.json') as { jobs: Record<string, unknown>[] };
    const withUnlisted = {
      ...raw,
      jobs: [...raw.jobs, { ...raw.jobs[0]!, id: 'unlisted-1', isListed: false }],
    };

    const { context } = stubHttp(withUnlisted);
    const jobs = await fetcher.fetch(config, context);

    expect(jobs.map((job) => job.externalId)).not.toContain('unlisted-1');
    expect(jobs).toHaveLength(raw.jobs.length);
  });

  it('treats a missing isListed flag as listed', async () => {
    const { context } = stubHttp({
      jobs: [
        {
          id: 'a',
          title: 'Engineer',
          jobUrl: 'https://jobs.ashbyhq.com/x/a',
          publishedAt: '2026-11-25T10:00:00.000+00:00',
        },
      ],
    });
    const jobs = await fetcher.fetch(config, context);
    expect(jobs).toHaveLength(1);
  });

  it('believes workplaceType over isRemote when they disagree', async () => {
    // A real Ramp posting returned isRemote: true with workplaceType "Hybrid".
    const { context } = stubHttp({
      jobs: [
        {
          id: 'a',
          title: 'Engineer',
          jobUrl: 'https://jobs.ashbyhq.com/x/a',
          publishedAt: '2026-11-25T10:00:00.000+00:00',
          isRemote: true,
          workplaceType: 'Hybrid',
        },
      ],
    });
    const jobs = await fetcher.fetch(config, context);
    expect(jobs[0]!.remote).toBe(false);
  });

  it('falls back to isRemote when no workplaceType is given', async () => {
    const { context } = stubHttp({
      jobs: [
        {
          id: 'a',
          title: 'Engineer',
          jobUrl: 'https://jobs.ashbyhq.com/x/a',
          publishedAt: '2026-11-25T10:00:00.000+00:00',
          isRemote: true,
        },
      ],
    });
    const jobs = await fetcher.fetch(config, context);
    expect(jobs[0]!.remote).toBe(true);
  });
});

describe('all fetchers', () => {
  const cases = [
    { fetcher: new GreenhouseFetcher(), board: board({ source: 'greenhouse', token: 'discord' }), fixture: 'greenhouse-discord.json' },
    { fetcher: new LeverFetcher(), board: board({ source: 'lever', token: 'leverdemo' }), fixture: 'lever-leverdemo.json' },
    { fetcher: new AshbyFetcher(), board: board({ source: 'ashby', token: 'ramp' }), fixture: 'ashby-ramp.json' },
  ];

  it.each(cases)('$board.source produces storable postings', async ({ fetcher, board: cfg, fixture: name }) => {
    const { context } = stubHttp(fixture(name));
    const jobs = await fetcher.fetch(cfg, context);

    expect(jobs.length).toBeGreaterThan(0);
    for (const job of jobs) {
      expect(job.source).toBe(fetcher.source);
      expect(job.externalId).toBeTruthy();
      expect(job.title.trim()).toBe(job.title);
      expect(job.title.length).toBeGreaterThan(0);
      expect(job.url).toMatch(/^https?:\/\//);
      expect(job.company).toBeTruthy();
      expect(job.companyKey).toBe(cfg.token);
      if (job.postedAt !== null) expect(job.postedAt).toMatch(/^\d{4}-\d\d-\d\dT.*Z$/);
    }
  });

  it.each(cases)('$board.source never emits markup in a description', async ({ fetcher, board: cfg, fixture: name }) => {
    const { context } = stubHttp(fixture(name));
    const jobs = await fetcher.fetch(cfg, context);

    for (const job of jobs) {
      if (!job.description) continue;
      expect(job.description).not.toMatch(/<\/?(div|p|span|strong|em|ul|ol|li|br|h[1-6])\b/i);
      expect(job.description).not.toMatch(/&(lt|gt|amp|quot|nbsp);/);
    }
  });

  it.each(cases)('$board.source respects maxDescriptionChars', async ({ fetcher, board: cfg, fixture: name }) => {
    const { context } = stubHttp(fixture(name));
    const jobs = await fetcher.fetch({ ...cfg }, { ...context, maxDescriptionChars: 200 });

    for (const job of jobs) {
      if (!job.description) continue;
      // The truncation note is appended after the budget, so allow for it.
      expect(job.description.length).toBeLessThan(200 + 120);
    }
  });
});

describe('htmlToText', () => {
  it('turns list items into dashes on their own lines', () => {
    const text = htmlToText('<ul><li>First</li><li>Second</li></ul>');
    expect(text).toBe('- First\n- Second');
  });

  it('separates paragraphs with a blank line at most', () => {
    expect(htmlToText('<p>One</p><p>Two</p>')).toBe('One\nTwo');
  });

  it('does not run inline text together', () => {
    expect(htmlToText('<b>alpha</b><b>beta</b>')).toBe('alpha beta');
  });

  it('drops scripts and styles entirely', () => {
    expect(htmlToText('<p>Real</p><script>alert(1)</script><style>p{}</style>')).toBe('Real');
  });

  it('decodes numeric and named entities', () => {
    expect(htmlToText('<p>R&amp;D &#8212; caf&eacute;</p>')).toBe('R&D — café');
  });

  it('handles the double-escaped Greenhouse form', () => {
    const escaped = '&lt;p&gt;Hello &amp;amp; welcome&lt;/p&gt;';
    expect(htmlToText(escaped, { doubleEscaped: true })).toBe('Hello & welcome');
  });

  it('returns an empty string for empty input', () => {
    expect(htmlToText('')).toBe('');
  });
});

describe('decodeEntities', () => {
  it('leaves an unknown entity untouched rather than mangling it', () => {
    expect(decodeEntities('a &notarealentity; b')).toBe('a &notarealentity; b');
  });

  it('ignores an out-of-range code point', () => {
    expect(decodeEntities('&#99999999;')).toBe('&#99999999;');
  });
});

describe('truncateText', () => {
  it('leaves short text alone', () => {
    expect(truncateText('short', 100)).toBe('short');
  });

  it('breaks on whitespace rather than mid-word', () => {
    const text = 'alpha beta gamma delta epsilon zeta eta theta';
    const kept = truncateText(text, 20).split('\n')[0]!;

    // The kept text must be a whole-word prefix: the original continues with
    // whitespace, not with the rest of a chopped word.
    expect(text.startsWith(kept)).toBe(true);
    expect(text.slice(kept.length)).toMatch(/^\s/);
    expect(kept).toBe('alpha beta gamma');
  });

  it('falls back to a hard cut when there is no break to use', () => {
    const result = truncateText('x'.repeat(50), 20);
    expect(result.split('\n')[0]).toBe('x'.repeat(20));
  });

  it('says how much was cut, so a truncated posting is not mistaken for a short one', () => {
    const result = truncateText('x'.repeat(500), 100);
    expect(result).toMatch(/truncated: posting continues for \d+ more characters/);
  });
});

describe('remoteness', () => {
  it('reads the common spellings of workplace type', () => {
    expect(normalizeWorkplaceType('Remote')).toBe('remote');
    expect(normalizeWorkplaceType('on-site')).toBe('onsite');
    expect(normalizeWorkplaceType('HYBRID')).toBe('hybrid');
    expect(normalizeWorkplaceType(null)).toBe('unknown');
    expect(normalizeWorkplaceType('Flexible')).toBe('unknown');
  });

  it('falls back to the location text when nothing else is given', () => {
    expect(isRemotePosting({ location: 'Remote (EU)' })).toBe(true);
    expect(isRemotePosting({ location: 'Berlin, Germany' })).toBe(false);
  });

  it('does not read "remote" inside another word', () => {
    expect(isRemotePosting({ location: 'Remotely Operated Vehicles Inc' })).toBe(false);
  });
});
