import { describe, expect, it } from 'vitest';

import { dedupeKey, jobId, normalizeCompany, normalizeTitle } from '../src/util/normalize.js';

/**
 * Dedupe is the rule with the worst failure mode: a false split means a second
 * application to the same job. So these tests are written as pairs — "these
 * two spellings are the same job" — rather than as assertions about the
 * normalised string, which is an implementation detail.
 */

function sameRole(a: string, b: string): void {
  expect(normalizeTitle(a), `"${a}" should match "${b}"`).toBe(normalizeTitle(b));
}

function differentRole(a: string, b: string): void {
  expect(normalizeTitle(a), `"${a}" should NOT match "${b}"`).not.toBe(normalizeTitle(b));
}

describe('normalizeTitle', () => {
  it('ignores case and surrounding whitespace', () => {
    sameRole('Senior Backend Engineer', '  senior backend engineer  ');
  });

  it('expands the abbreviations boards use interchangeably', () => {
    sameRole('Sr. Software Engineer', 'Senior Software Engineer');
    sameRole('Sr Backend Dev', 'Senior Backend Developer');
    sameRole('SWE II', 'Software Engineer II');
    sameRole('SRE', 'Site Reliability Engineer');
  });

  it('treats hyphenation of front-end/back-end as noise', () => {
    sameRole('Front-End Engineer', 'Frontend Engineer');
    sameRole('Back End Engineer', 'Backend Engineer');
    sameRole('Full-Stack Developer', 'Fullstack Developer');
  });

  it('ignores word order', () => {
    sameRole('Senior Backend Engineer', 'Backend Engineer, Senior');
  });

  it('strips trailing contract and remote decorations', () => {
    sameRole('Backend Engineer (Remote)', 'Backend Engineer');
    sameRole('Backend Engineer - Remote, EU', 'Backend Engineer');
    sameRole('Backend Engineer | Full-Time', 'Backend Engineer');
    sameRole('Backend Engineer (Permanent)', 'Backend Engineer');
  });

  it('strips the posting location when the board supplies it', () => {
    expect(normalizeTitle('Backend Engineer - Berlin', { location: 'Berlin, Germany' })).toBe(
      normalizeTitle('Backend Engineer'),
    );
    expect(normalizeTitle('Backend Engineer [Lisbon]', { location: 'Lisbon' })).toBe(
      normalizeTitle('Backend Engineer'),
    );
  });

  it('keeps a trailing qualifier that is not the location', () => {
    // "- Payments" names a different job; "- Berlin" names the same one. Only
    // the location field tells them apart, so an unknown tail is kept.
    expect(normalizeTitle('Backend Engineer - Payments', { location: 'Berlin' })).not.toBe(
      normalizeTitle('Backend Engineer', { location: 'Berlin' }),
    );
  });

  it('ignores gendered posting suffixes common on EU boards', () => {
    sameRole('Backend Engineer (m/w/d)', 'Backend Engineer');
    sameRole('Backend Engineer (f/m/x)', 'Backend Engineer');
  });

  it('ignores accents', () => {
    sameRole('Ingénieur Backend', 'Ingenieur Backend');
  });

  it('keeps seniority levels distinct', () => {
    differentRole('Software Engineer', 'Senior Software Engineer');
    differentRole('Junior Backend Engineer', 'Senior Backend Engineer');
  });

  it('keeps numbered levels distinct, in either numeral system', () => {
    differentRole('Software Engineer II', 'Software Engineer III');
    sameRole('Software Engineer II', 'Software Engineer 2');
  });

  it('keeps genuinely different roles distinct', () => {
    differentRole('Backend Engineer', 'Frontend Engineer');
    differentRole('Product Manager', 'Product Designer');
    differentRole('Data Engineer', 'Data Scientist');
  });

  it('keeps an in-title qualifier that is not a trailing decoration', () => {
    differentRole('Engineer (Platform)', 'Engineer (Mobile)');
  });

  it('never returns an empty string, even for an all-noise title', () => {
    // Without the fallback these would all normalise to "" and collide,
    // merging unrelated postings into one application record.
    for (const title of ['Remote', 'Open Position', 'The Role', '(Contract)']) {
      expect(normalizeTitle(title).length, `"${title}"`).toBeGreaterThan(0);
    }
    differentRole('Remote', 'Open Position');
  });
});

describe('normalizeCompany', () => {
  it('ignores case, punctuation, and legal suffixes', () => {
    expect(normalizeCompany('Acme, Inc.')).toBe(normalizeCompany('ACME Inc'));
    expect(normalizeCompany('Acme GmbH')).toBe(normalizeCompany('Acme'));
    expect(normalizeCompany('Acme Ltd.')).toBe(normalizeCompany('acme'));
  });

  it('keeps distinct companies distinct', () => {
    expect(normalizeCompany('Acme')).not.toBe(normalizeCompany('Acme Labs'));
  });

  it('produces a slug with no spaces', () => {
    expect(normalizeCompany('Northwind Logistics')).toBe('northwind-logistics');
  });
});

describe('dedupeKey', () => {
  it('matches the same role posted with different spellings', () => {
    expect(dedupeKey('Acme, Inc.', 'Sr. Software Engineer (Remote)')).toBe(
      dedupeKey('ACME Inc', 'Senior Software Engineer'),
    );
  });

  it('matches the same role posted in two cities, given the locations', () => {
    expect(dedupeKey('Acme', 'Backend Engineer - Berlin', 'Berlin, Germany')).toBe(
      dedupeKey('Acme', 'Backend Engineer - Lisbon', 'Lisbon, Portugal'),
    );
  });

  it('separates the same title at different companies', () => {
    expect(dedupeKey('Acme', 'Backend Engineer')).not.toBe(
      dedupeKey('Globex', 'Backend Engineer'),
    );
  });

  it('separates different roles at the same company', () => {
    expect(dedupeKey('Acme', 'Backend Engineer')).not.toBe(
      dedupeKey('Acme', 'Frontend Engineer'),
    );
  });
});

describe('jobId', () => {
  it('is stable across calls', () => {
    expect(jobId('greenhouse', '12345')).toBe(jobId('greenhouse', '12345'));
  });

  it('differs per source for the same external id', () => {
    expect(jobId('greenhouse', '12345')).not.toBe(jobId('lever', '12345'));
  });
});
