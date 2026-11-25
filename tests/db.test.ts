import { beforeEach, describe, expect, it } from 'vitest';
import type { Database } from 'better-sqlite3';

import { currentVersion, migrate, openDatabase, Repo, SCHEMA_VERSION } from '../src/db/index.js';
import type { JobInput } from '../src/db/repo.js';

/**
 * Database behaviour, against a real in-memory SQLite — not a mock. The
 * interesting assertions are about the constraints doing their job, since
 * they, not the TypeScript, are what make "never apply twice" true.
 */

let db: Database;
let repo: Repo;

function job(overrides: Partial<JobInput> = {}): JobInput {
  return {
    source: 'greenhouse',
    externalId: '1001',
    company: 'Northwind Logistics',
    title: 'Senior Backend Engineer',
    location: 'Remote (EU)',
    url: 'https://example.com/jobs/1001',
    description: 'We need someone to own the queue.',
    postedAt: '2026-11-24T09:00:00.000Z',
    ...overrides,
  };
}

beforeEach(() => {
  db = openDatabase({ path: ':memory:' });
  repo = new Repo(db);
});

describe('migrations', () => {
  it('brings a fresh database to the current schema version', () => {
    expect(currentVersion(db)).toBe(SCHEMA_VERSION);
  });

  it('is idempotent — running migrate again applies nothing', () => {
    expect(migrate(db)).toEqual([]);
    expect(currentVersion(db)).toBe(SCHEMA_VERSION);
  });

  it('enforces foreign keys', () => {
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(() =>
      repo.insertScore({
        jobId: 'does-not-exist',
        score: 50,
        reasons: [],
        redFlags: [],
        provider: 'anthropic',
        model: 'test',
        promptVersion: 'v1',
      }),
    ).toThrow(/FOREIGN KEY/i);
  });
});

describe('upsertJob', () => {
  it('inserts a new posting and reports it as new', () => {
    const result = repo.upsertJob(job());
    expect(result.inserted).toBe(true);
    expect(result.job.company).toBe('Northwind Logistics');
    expect(result.job.remote).toBe(false);
    expect(result.job.postedAtSource).toBe('board');
  });

  it('is idempotent: re-running hunt does not duplicate', () => {
    const first = repo.upsertJob(job());
    const second = repo.upsertJob(job());

    expect(second.inserted).toBe(false);
    expect(second.job.id).toBe(first.job.id);
    expect(repo.countJobs()).toBe(1);
  });

  it('refreshes last_seen_at but never moves first_seen_at or posted_at', () => {
    const first = repo.upsertJob(job());
    const second = repo.upsertJob({ ...job(), postedAt: '2026-01-01T00:00:00.000Z' });

    expect(second.job.firstSeenAt).toBe(first.job.firstSeenAt);
    expect(second.job.postedAt).toBe(first.job.postedAt);
    expect(second.job.lastSeenAt >= first.job.lastSeenAt).toBe(true);
  });

  it('marks a posting dated from first sight when the board gives no timestamp', () => {
    const result = repo.upsertJob({ ...job(), postedAt: null });
    expect(result.job.postedAtSource).toBe('first_seen');
    expect(result.job.postedAt).toBe(result.job.firstSeenAt);
  });

  it('treats the same external id on two boards as two postings', () => {
    repo.upsertJob(job({ source: 'greenhouse', externalId: '7' }));
    repo.upsertJob(job({ source: 'lever', externalId: '7' }));
    expect(repo.countJobs()).toBe(2);
  });

  it('stores a dedupe key that ignores city and spelling', () => {
    const berlin = repo.upsertJob(
      job({ externalId: 'a', title: 'Sr. Backend Engineer - Berlin', location: 'Berlin, Germany' }),
    );
    const lisbon = repo.upsertJob(
      job({ externalId: 'b', title: 'Senior Backend Engineer (Remote)', location: 'Lisbon' }),
    );
    expect(berlin.job.dedupeKey).toBe(lisbon.job.dedupeKey);
  });
});

describe('applications — the duplicate guard', () => {
  it('creates one application and records the creation event', () => {
    const { job: stored } = repo.upsertJob(job());
    const { application, created } = repo.ensureApplicationForJob(stored);

    expect(created).toBe(true);
    expect(application.status).toBe('found');

    const events = repo.listApplicationEvents(application.id);
    expect(events).toHaveLength(1);
    expect(events[0]?.toStatus).toBe('found');
    expect(events[0]?.fromStatus).toBeNull();
  });

  it('returns the existing application for a second posting of the same role', () => {
    const first = repo.upsertJob(job({ externalId: 'a', title: 'Senior Backend Engineer' }));
    const second = repo.upsertJob(
      job({ source: 'lever', externalId: 'b', title: 'Sr. Backend Engineer (Remote)' }),
    );

    const created = repo.ensureApplicationForJob(first.job);
    const again = repo.ensureApplicationForJob(second.job);

    expect(created.created).toBe(true);
    expect(again.created).toBe(false);
    expect(again.application.id).toBe(created.application.id);
    expect(repo.listApplications()).toHaveLength(1);
  });

  it('refuses a second application row for the same role at the database level', () => {
    const { job: stored } = repo.upsertJob(job());
    repo.ensureApplicationForJob(stored);

    // Bypassing the repo entirely: the UNIQUE index, not application code,
    // is what makes the rule hold.
    expect(() =>
      db
        .prepare(
          `INSERT INTO applications (dedupe_key, company, title, job_id, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'found', ?, ?)`,
        )
        .run(stored.dedupeKey, stored.company, stored.title, stored.id, 'now', 'now'),
    ).toThrow(/UNIQUE/i);
  });

  it('keeps separate applications for different roles at one company', () => {
    const backend = repo.upsertJob(job({ externalId: 'a', title: 'Backend Engineer' }));
    const frontend = repo.upsertJob(job({ externalId: 'b', title: 'Frontend Engineer' }));

    repo.ensureApplicationForJob(backend.job);
    repo.ensureApplicationForJob(frontend.job);

    expect(repo.listApplications()).toHaveLength(2);
  });

  it('finds an application by role without needing the posting', () => {
    const { job: stored } = repo.upsertJob(job());
    const { application } = repo.ensureApplicationForJob(stored);

    // A company we never applied to.
    expect(repo.findApplicationByRole('Globex', 'Senior Backend Engineer')).toBeNull();

    // The same role, spelled differently, with no posting in hand.
    const found = repo.findApplicationByRole(
      'Northwind Logistics, Inc.',
      'Sr Backend Engineer (Remote)',
    );
    expect(found?.id).toBe(application.id);
  });
});

describe('application status tracking', () => {
  it('records every transition with its predecessor', () => {
    const { job: stored } = repo.upsertJob(job());
    const { application } = repo.ensureApplicationForJob(stored);

    repo.setApplicationStatus(application.id, 'drafted');
    repo.setApplicationStatus(application.id, 'applied', 'submitted via Greenhouse');
    const final = repo.setApplicationStatus(application.id, 'interview');

    expect(final.status).toBe('interview');

    const events = repo.listApplicationEvents(application.id);
    expect(events.map((event) => event.toStatus)).toEqual([
      'found',
      'drafted',
      'applied',
      'interview',
    ]);
    expect(events[2]?.fromStatus).toBe('drafted');
    expect(events[2]?.note).toBe('submitted via Greenhouse');
  });

  it('rejects a status outside the allowed set', () => {
    const { job: stored } = repo.upsertJob(job());
    const { application } = repo.ensureApplicationForJob(stored);

    expect(() =>
      db
        .prepare('UPDATE applications SET status = ? WHERE id = ?')
        .run('ghosted', application.id),
    ).toThrow(/CHECK/i);
  });

  it('keeps the application if its posting is deleted', () => {
    const { job: stored } = repo.upsertJob(job());
    const { application } = repo.ensureApplicationForJob(stored);
    repo.setApplicationStatus(application.id, 'applied');

    db.prepare('DELETE FROM jobs WHERE id = ?').run(stored.id);

    const after = repo.getApplication(application.id);
    expect(after?.status).toBe('applied');
    expect(after?.jobId).toBeNull();
  });
});

describe('scores', () => {
  it('keeps history and returns the newest as latest', () => {
    const { job: stored } = repo.upsertJob(job());

    repo.insertScore({
      jobId: stored.id,
      score: 60,
      reasons: ['first pass'],
      redFlags: [],
      provider: 'anthropic',
      model: 'model-a',
      promptVersion: 'v1',
    });
    repo.insertScore({
      jobId: stored.id,
      score: 82,
      reasons: ['strong queue experience'],
      redFlags: [{ kind: 'years', detail: 'asks for 10 years, profile has 7' }],
      summary: 'Good fit',
      provider: 'anthropic',
      model: 'model-b',
      promptVersion: 'v2',
    });

    const latest = repo.getLatestScore(stored.id);
    expect(latest?.score).toBe(82);
    expect(latest?.model).toBe('model-b');
    expect(latest?.reasons).toEqual(['strong queue experience']);
    expect(latest?.redFlags[0]?.kind).toBe('years');

    const rows = db.prepare('SELECT COUNT(*) AS n FROM scores').get() as { n: number };
    expect(rows.n).toBe(2);
  });

  it('rejects a score outside 0-100', () => {
    const { job: stored } = repo.upsertJob(job());
    expect(() =>
      repo.insertScore({
        jobId: stored.id,
        score: 101,
        reasons: [],
        redFlags: [],
        provider: 'anthropic',
        model: 'm',
        promptVersion: 'v1',
      }),
    ).toThrow(/CHECK/i);
  });

  it('lists unscored postings as the work queue', () => {
    const a = repo.upsertJob(job({ externalId: 'a', title: 'Backend Engineer' }));
    repo.upsertJob(job({ externalId: 'b', title: 'Frontend Engineer' }));

    repo.insertScore({
      jobId: a.job.id,
      score: 70,
      reasons: [],
      redFlags: [],
      provider: 'anthropic',
      model: 'm',
      promptVersion: 'v1',
    });

    const unscored = repo.listUnscoredJobs();
    expect(unscored).toHaveLength(1);
    expect(unscored[0]?.title).toBe('Frontend Engineer');
  });
});

describe('letters', () => {
  it('round-trips the cited facts and the grounding verdict', () => {
    const { job: stored } = repo.upsertJob(job());
    repo.insertLetter({
      jobId: stored.id,
      body: 'Short letter body.',
      filePath: 'data/letters/x.md',
      factsUsed: [{ field: 'roles.0.highlights.0', value: 'Moved order processing to a queue' }],
      provider: 'anthropic',
      model: 'm',
      promptVersion: 'v1',
      grounded: true,
      groundingNotes: [],
    });

    const letter = repo.getLatestLetter(stored.id);
    expect(letter?.grounded).toBe(true);
    expect(letter?.factsUsed[0]?.field).toBe('roles.0.highlights.0');
  });
});

describe('fetch runs', () => {
  it('records a successful run and a failed one', () => {
    const ok = repo.startFetchRun('greenhouse', 'figma');
    repo.finishFetchRun(ok, { jobsSeen: 40, jobsFresh: 3, jobsNew: 2 });

    const bad = repo.startFetchRun('lever', 'netlify');
    repo.finishFetchRun(bad, { jobsSeen: 0, jobsFresh: 0, jobsNew: 0, error: 'HTTP 503' });

    const rows = db
      .prepare('SELECT target, ok, error FROM fetch_runs ORDER BY id')
      .all() as { target: string; ok: number; error: string | null }[];

    expect(rows[0]).toMatchObject({ target: 'figma', ok: 1, error: null });
    expect(rows[1]).toMatchObject({ target: 'netlify', ok: 0, error: 'HTTP 503' });
  });
});
