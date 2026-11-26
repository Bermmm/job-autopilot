import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';

import { ProfileSchema, type Profile } from '../src/config/profile.schema.js';
import { resolveFromRoot } from '../src/config/load.js';
import type { Job } from '../src/db/types.js';
import { indexProfileFacts, resolveProfileField } from '../src/profile/facts.js';
import { renderProfileForPrompt } from '../src/profile/view.js';
import {
  assessLetter,
  buildCorpus,
  checkGrounding,
  verifyCitations,
} from '../src/letters/grounding.js';
import { bannedTermsFromProfile, checkStyle, wordCount } from '../src/letters/style.js';

/**
 * The "no invented facts" suite.
 *
 * This is the test the project's main promise rests on: a letter must not
 * mention a company, number, or skill that is in neither the profile nor the
 * job posting. Each case below is a letter that would be embarrassing to send.
 */

const profile: Profile = ProfileSchema.parse(
  parseYaml(readFileSync(resolveFromRoot('profile.example.yaml'), 'utf8')),
);

const job: Job = {
  id: 'job-1',
  source: 'greenhouse',
  externalId: '1',
  company: 'Northstar Data',
  companySlug: 'northstar-data',
  title: 'Senior Backend Engineer',
  titleNormalized: 'backend engineer senior',
  dedupeKey: 'northstar-data::backend engineer senior',
  location: 'Remote (EU)',
  remote: true,
  url: 'https://example.com/jobs/1',
  description:
    'We run a large Postgres fleet and a Kafka pipeline. You will own reliability, ' +
    'on-call, and the migration off our legacy MySQL cluster. TypeScript and Node.js throughout.',
  postedAt: '2026-11-26T09:00:00.000Z',
  postedAtSource: 'board',
  firstSeenAt: '2026-11-26T10:00:00.000Z',
  lastSeenAt: '2026-11-26T10:00:00.000Z',
};

const corpus = buildCorpus(profile, job);

/** A letter whose every claim traces to the profile or the posting. */
const HONEST_LETTER = `Dear Northstar Data team,

Your posting mentions owning reliability and the migration off a legacy MySQL cluster.
At Northwind Logistics I migrated 40 million rows from MySQL to Postgres with no
downtime and no data loss, so that part of the job is familiar ground.

I also ran the on-call rotation for 6 engineers and brought monthly pages down from
31 to 9. Before that, at Tessellate Analytics, I added idempotency keys to the
payments path, which ended a recurring class of double-charge incidents.

Seven years in, most of my work has been TypeScript and Node.js against Postgres.

Jordan Avery`;

describe('the honest letter passes', () => {
  it('has no grounding issues', () => {
    expect(checkGrounding(HONEST_LETTER, corpus)).toEqual([]);
  });

  it('has no style issues', () => {
    expect(checkStyle(HONEST_LETTER, profile)).toEqual([]);
  });

  it('counts as grounded end to end', () => {
    const report = assessLetter({
      body: HONEST_LETTER,
      citations: [
        {
          field: 'roles.0.highlights.3',
          value: 'Migrated 40 million rows from MySQL to Postgres with no downtime',
        },
      ],
      profile,
      job,
    });
    expect(report.grounded).toBe(true);
    expect(report.issues).toEqual([]);
  });
});

describe('invented facts are caught', () => {
  it('rejects an invented percentage', () => {
    const issues = checkGrounding('At Northwind Logistics I cut costs by 35%.', corpus);
    expect(issues.some((issue) => issue.kind === 'number' && issue.token === '35')).toBe(true);
  });

  it('rejects an invented multiplier', () => {
    const issues = checkGrounding('I improved throughput 12x.', corpus);
    expect(issues.some((issue) => issue.token === '12')).toBe(true);
  });

  it('rejects an invented employer', () => {
    const issues = checkGrounding('At Globex Corporation I led the platform team.', corpus);
    expect(issues.some((issue) => issue.token === 'Globex')).toBe(true);
  });

  it('rejects a technology the candidate has never used', () => {
    const issues = checkGrounding('I have deep production experience with Rust and Elixir.', corpus);
    const tokens = issues.map((issue) => issue.token);
    expect(tokens).toContain('Rust');
    expect(tokens).toContain('Elixir');
  });

  it('rejects an invented qualification', () => {
    const issues = checkGrounding('I hold a Stanford MBA.', corpus);
    expect(issues.some((issue) => issue.token === 'Stanford')).toBe(true);
  });

  it('rejects a figure spelled out in words', () => {
    // "Fifteen years" is a numeric claim, not a proper noun — and the profile
    // says seven, so it must be caught as a number.
    const issues = checkGrounding('Fifteen years of backend experience.', corpus);
    expect(issues.some((issue) => issue.kind === 'number')).toBe(true);
  });

  it('accepts a figure spelled out that the profile does state', () => {
    const issues = checkGrounding('Seven years of backend experience.', corpus);
    expect(issues).toEqual([]);
  });

  it('rejects an inflated version of a real number', () => {
    // The profile says 40 million rows. "50 million" is not the same claim.
    const issues = checkGrounding('I migrated 50 million rows.', corpus);
    expect(issues.some((issue) => issue.token === '50')).toBe(true);
  });

  it('accepts numbers that come from the posting rather than the profile', () => {
    // Both sides of the corpus count: the posting is source material too.
    const withNumbers = buildCorpus(profile, { ...job, description: 'We run 900 services.' });
    expect(checkGrounding('Your 900 services are the interesting part.', withNumbers)).toEqual([]);
  });

  it('is not fooled by thousands separators', () => {
    const issues = checkGrounding('A salary of 75,000 EUR suits me.', corpus);
    // 75000 is the profile's stated minimum, written with a comma here.
    expect(issues.filter((issue) => issue.kind === 'number')).toEqual([]);
  });
});

describe('false positives are avoided', () => {
  it('does not flag ordinary sentence-opening words', () => {
    const body =
      'Your posting mentions Postgres. Happy to talk. Recently I moved 40 million rows. ' +
      'Currently I run on-call. Overall the work matches.';
    expect(checkGrounding(body, corpus)).toEqual([]);
  });

  it('does not flag the candidate or the hiring company', () => {
    expect(checkGrounding('Jordan Avery writing to Northstar Data.', corpus)).toEqual([]);
  });

  it('accepts either spelling of a dotted technology name', () => {
    expect(checkGrounding('I use Node.js daily.', corpus)).toEqual([]);
    expect(checkGrounding('I use Node daily.', corpus)).toEqual([]);
  });

  it('does not flag a month name', () => {
    expect(checkGrounding('I could start in March.', corpus)).toEqual([]);
  });

  it('does not treat a repeated invention as several issues', () => {
    const issues = checkGrounding('Globex and Globex and Globex again.', corpus);
    expect(issues.filter((issue) => issue.token.toLowerCase() === 'globex')).toHaveLength(1);
  });
});

describe('citations are verified, not trusted', () => {
  it('accepts a citation that matches the profile', () => {
    const issues = verifyCitations(profile, [
      { field: 'roles.0.company', value: 'Northwind Logistics' },
    ]);
    expect(issues).toEqual([]);
  });

  it('accepts a clause quoted out of a longer highlight', () => {
    const highlight = profile.roles[0]!.highlights[0]!;
    const issues = verifyCitations(profile, [
      { field: 'roles.0.highlights.0', value: highlight.slice(10, 50) },
    ]);
    expect(issues).toEqual([]);
  });

  it('rejects a field path that does not exist', () => {
    // A plausible-looking path on a profile with three roles.
    const issues = verifyCitations(profile, [
      { field: 'roles.7.highlights.2', value: 'Something impressive' },
    ]);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.detail).toMatch(/does not exist/);
  });

  it('rejects a value that is not what the field says', () => {
    const issues = verifyCitations(profile, [
      { field: 'roles.0.company', value: 'Globex Corporation' },
    ]);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.detail).toMatch(/actually says/);
  });

  it('rejects a misattributed but real fact', () => {
    // The achievement is real, but it belongs to a different role.
    const issues = verifyCitations(profile, [
      { field: 'roles.2.highlights.0', value: profile.roles[0]!.highlights[0]! },
    ]);
    expect(issues).toHaveLength(1);
  });

  it('flags every bad citation, not just the first', () => {
    const issues = verifyCitations(profile, [
      { field: 'roles.9', value: 'x' },
      { field: 'education.9', value: 'y' },
    ]);
    expect(issues).toHaveLength(2);
  });
});

describe('profile fact index', () => {
  it('resolves every tag the prompt renderer emits', () => {
    // If these drift apart, the model is shown tags it cannot validly cite.
    const rendered = renderProfileForPrompt(profile, { includeConstraints: true });
    const tags = [...rendered.matchAll(/\[([a-zA-Z0-9.]+)\]/g)].map((match) => match[1]!);

    expect(tags.length).toBeGreaterThan(5);
    const unresolvable = tags.filter(
      (tag) =>
        resolveProfileField(profile, tag) === null &&
        // The constraint tags are scoring-only and not citable in a letter.
        !tag.startsWith('preferences.') &&
        !tag.startsWith('salary') &&
        !tag.startsWith('skills.avoid'),
    );
    expect(unresolvable).toEqual([]);
  });

  it('indexes no contact details', () => {
    const values = indexProfileFacts(profile).map((fact) => fact.value).join(' ');
    expect(values).not.toContain(profile.contact.email);
    expect(values).not.toContain(profile.contact.phone!);
    for (const link of profile.contact.links) {
      expect(values).not.toContain(link.url);
    }
  });

  it('indexes every role and highlight', () => {
    const fields = indexProfileFacts(profile).map((fact) => fact.field);
    profile.roles.forEach((role, index) => {
      expect(fields).toContain(`roles.${index}`);
      role.highlights.forEach((_, highlightIndex) => {
        expect(fields).toContain(`roles.${index}.highlights.${highlightIndex}`);
      });
    });
  });
});

describe('style', () => {
  it('catches the usual AI tells', () => {
    const issues = checkStyle(
      'I am writing to apply for this role. I am passionate about leveraging cutting-edge synergies.',
      profile,
    );
    const tokens = issues.map((issue) => issue.token);
    expect(tokens).toContain('passionate');
    expect(tokens).toContain('leverage');
    expect(tokens).toContain('cutting-edge');
  });

  it('enforces the terms the profile itself bans', () => {
    // profile.example.yaml says: never say "rockstar" or "thrilled".
    expect(bannedTermsFromProfile(profile)).toContain('rockstar');
    expect(checkStyle('I am thrilled to be a rockstar.', profile).length).toBeGreaterThan(0);
  });

  it('catches inflected forms', () => {
    expect(checkStyle('We are leveraging our synergies.', profile).length).toBeGreaterThan(0);
  });

  it('does not fire on an innocent word that contains a banned one', () => {
    expect(checkStyle('I ran a compassionate on-call rotation.', profile)).toEqual([]);
  });

  it('passes plain prose', () => {
    expect(checkStyle(HONEST_LETTER, profile)).toEqual([]);
  });

  it('counts words for the length report', () => {
    expect(wordCount('one two three')).toBe(3);
    expect(wordCount('  spaced   out  ')).toBe(2);
  });
});

describe('assessLetter', () => {
  it('reports grounding and citation problems together', () => {
    const report = assessLetter({
      body: 'At Globex I cut costs 35%.',
      citations: [{ field: 'roles.9', value: 'nope' }],
      profile,
      job,
    });

    expect(report.grounded).toBe(false);
    expect(report.issues.some((issue) => issue.kind === 'number')).toBe(true);
    expect(report.issues.some((issue) => issue.kind === 'proper-noun')).toBe(true);
    expect(report.issues.some((issue) => issue.kind === 'citation')).toBe(true);
  });
});
