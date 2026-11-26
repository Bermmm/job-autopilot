import type { Database } from 'better-sqlite3';

import {
  dedupeKey,
  dedupeKeyFrom,
  jobId,
  normalizeCompany,
  normalizeTitle,
} from '../util/normalize.js';
import type {
  Application,
  ApplicationEvent,
  ApplicationStatus,
  FactCitation,
  Job,
  JobRow,
  JobSource,
  Letter,
  RedFlag,
  Score,
} from './types.js';

/**
 * Typed access to the database. Everything the CLI and dashboard do goes
 * through here, so the JSON encoding and the dedupe rules live in one place.
 */

function nowIso(): string {
  return new Date().toISOString();
}

function parseJson<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function toJob(row: JobRow): Job {
  return {
    id: row.id,
    source: row.source,
    externalId: row.external_id,
    company: row.company,
    companySlug: row.company_slug,
    title: row.title,
    titleNormalized: row.title_normalized,
    dedupeKey: row.dedupe_key,
    location: row.location,
    remote: row.remote === 1,
    url: row.url,
    description: row.description,
    postedAt: row.posted_at,
    postedAtSource: row.posted_at_source,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
  };
}

/** A posting as a fetcher produces it, before it has an id or timestamps. */
export interface JobInput {
  source: JobSource;
  externalId: string;
  company: string;
  title: string;
  location?: string | null;
  remote?: boolean;
  url: string;
  description?: string | null;
  /** ISO 8601. Omit when the board does not say. */
  postedAt?: string | null;
  /**
   * Stable identity for the company, independent of its display name.
   * Fetchers pass the board token. Falls back to the normalised `company`,
   * which is all a feed can offer.
   */
  companyKey?: string;
  raw?: unknown;
}

export interface UpsertJobResult {
  job: Job;
  /** True the first time this posting is stored. */
  inserted: boolean;
}

export class Repo {
  constructor(private readonly db: Database) {}

  // -- jobs -----------------------------------------------------------------

  /**
   * Stores a posting, or refreshes `last_seen_at` if it is already known.
   *
   * Idempotent on `(source, external_id)`, so `hunt` can run as often as you
   * like without creating duplicates. `first_seen_at` and `posted_at` are
   * never moved once set: they are what the freshness filter trusts.
   */
  upsertJob(input: JobInput): UpsertJobResult {
    const id = jobId(input.source, input.externalId);
    const timestamp = nowIso();
    const companySlug = normalizeCompany(input.companyKey ?? input.company);
    const location = input.location ?? null;
    // The location is folded into the title normalisation so the same role
    // advertised in two cities produces one dedupe key.
    const titleNormalized = normalizeTitle(input.title, { location });
    const key = dedupeKeyFrom(companySlug, input.title, location);

    const existing = this.db
      .prepare('SELECT * FROM jobs WHERE id = ?')
      .get(id) as JobRow | undefined;

    if (existing) {
      this.db
        .prepare(
          `UPDATE jobs
              SET last_seen_at = ?,
                  title = ?, title_normalized = ?, dedupe_key = ?,
                  location = ?, remote = ?, url = ?,
                  description = COALESCE(?, description)
            WHERE id = ?`,
        )
        .run(
          timestamp,
          input.title,
          titleNormalized,
          key,
          location,
          input.remote ? 1 : 0,
          input.url,
          input.description ?? null,
          id,
        );
      return { job: this.getJob(id)!, inserted: false };
    }

    const hasBoardDate = Boolean(input.postedAt);
    this.db
      .prepare(
        `INSERT INTO jobs (
           id, source, external_id, company, company_slug, title, title_normalized,
           dedupe_key, location, remote, url, description, posted_at,
           posted_at_source, first_seen_at, last_seen_at, raw
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.source,
        input.externalId,
        input.company,
        companySlug,
        input.title,
        titleNormalized,
        key,
        location,
        input.remote ? 1 : 0,
        input.url,
        input.description ?? null,
        input.postedAt ?? timestamp,
        hasBoardDate ? 'board' : 'first_seen',
        timestamp,
        timestamp,
        input.raw === undefined ? null : JSON.stringify(input.raw),
      );

    return { job: this.getJob(id)!, inserted: true };
  }

  getJob(id: string): Job | null {
    const row = this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as JobRow | undefined;
    return row ? toJob(row) : null;
  }

  listJobs(options: { limit?: number; since?: string } = {}): Job[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM jobs
          WHERE (? IS NULL OR posted_at >= ?)
          ORDER BY posted_at DESC, first_seen_at DESC
          LIMIT ?`,
      )
      .all(options.since ?? null, options.since ?? null, options.limit ?? 500) as JobRow[];
    return rows.map(toJob);
  }

  /** Postings with no score yet — the work queue for `pnpm score`. */
  listUnscoredJobs(limit = 100): Job[] {
    const rows = this.db
      .prepare(
        `SELECT j.* FROM jobs j
           LEFT JOIN scores s ON s.job_id = j.id
          WHERE s.id IS NULL
          ORDER BY j.posted_at DESC
          LIMIT ?`,
      )
      .all(limit) as JobRow[];
    return rows.map(toJob);
  }

  // -- scores ---------------------------------------------------------------

  insertScore(input: {
    jobId: string;
    score: number;
    reasons: string[];
    redFlags: RedFlag[];
    summary?: string | null;
    provider: string;
    model: string;
    promptVersion: string;
    inputTokens?: number | null;
    outputTokens?: number | null;
  }): number {
    const result = this.db
      .prepare(
        `INSERT INTO scores (
           job_id, score, reasons, red_flags, summary, provider, model,
           prompt_version, input_tokens, output_tokens, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.jobId,
        input.score,
        JSON.stringify(input.reasons),
        JSON.stringify(input.redFlags),
        input.summary ?? null,
        input.provider,
        input.model,
        input.promptVersion,
        input.inputTokens ?? null,
        input.outputTokens ?? null,
        nowIso(),
      );
    return Number(result.lastInsertRowid);
  }

  getLatestScore(jobId: string): Score | null {
    const row = this.db
      .prepare('SELECT * FROM latest_scores WHERE job_id = ?')
      .get(jobId) as Record<string, unknown> | undefined;
    return row ? this.toScore(row) : null;
  }

  private toScore(row: Record<string, unknown>): Score {
    return {
      id: row.id as number,
      jobId: row.job_id as string,
      score: row.score as number,
      reasons: parseJson<string[]>(row.reasons as string, []),
      redFlags: parseJson<RedFlag[]>(row.red_flags as string, []),
      summary: (row.summary as string | null) ?? null,
      provider: row.provider as string,
      model: row.model as string,
      promptVersion: row.prompt_version as string,
      inputTokens: (row.input_tokens as number | null) ?? null,
      outputTokens: (row.output_tokens as number | null) ?? null,
      createdAt: row.created_at as string,
    };
  }

  // -- letters --------------------------------------------------------------

  insertLetter(input: {
    jobId: string;
    body: string;
    filePath?: string | null;
    factsUsed: FactCitation[];
    provider: string;
    model: string;
    promptVersion: string;
    grounded: boolean;
    groundingNotes?: string[];
  }): number {
    const result = this.db
      .prepare(
        `INSERT INTO letters (
           job_id, body, file_path, facts_used, provider, model,
           prompt_version, grounded, grounding_notes, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.jobId,
        input.body,
        input.filePath ?? null,
        JSON.stringify(input.factsUsed),
        input.provider,
        input.model,
        input.promptVersion,
        input.grounded ? 1 : 0,
        JSON.stringify(input.groundingNotes ?? []),
        nowIso(),
      );
    return Number(result.lastInsertRowid);
  }

  getLatestLetter(jobId: string): Letter | null {
    const row = this.db
      .prepare('SELECT * FROM letters WHERE job_id = ? ORDER BY id DESC LIMIT 1')
      .get(jobId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      id: row.id as number,
      jobId: row.job_id as string,
      body: row.body as string,
      filePath: (row.file_path as string | null) ?? null,
      factsUsed: parseJson<FactCitation[]>(row.facts_used as string, []),
      provider: row.provider as string,
      model: row.model as string,
      promptVersion: row.prompt_version as string,
      grounded: row.grounded === 1,
      groundingNotes: parseJson<string[]>(row.grounding_notes as string, []),
      createdAt: row.created_at as string,
    };
  }

  // -- applications ---------------------------------------------------------

  /**
   * Finds the application for a company+role, whichever posting it came from.
   *
   * This is the duplicate check: call it before drafting or applying. It
   * matches on the normalised key, so a second posting of the same job in
   * another city finds the existing record.
   */
  findApplicationByRole(
    company: string,
    title: string,
    location?: string | null,
  ): Application | null {
    const row = this.db
      .prepare('SELECT * FROM applications WHERE dedupe_key = ?')
      .get(dedupeKey(company, title, location)) as Record<string, unknown> | undefined;
    return row ? this.toApplication(row) : null;
  }

  /**
   * Returns the existing application for this role, or creates one at `found`.
   *
   * The UNIQUE index on `dedupe_key` is the real guard; this method just makes
   * the common path convenient and reports which happened.
   */
  ensureApplication(input: {
    company: string;
    title: string;
    jobId: string;
    /** The posting's location, so the key matches `upsertJob`'s. */
    location?: string | null;
    /** Stable company identity, as passed to `upsertJob`. */
    companyKey?: string;
    status?: ApplicationStatus;
    notes?: string | null;
  }): { application: Application; created: boolean } {
    const key = dedupeKeyFrom(
      normalizeCompany(input.companyKey ?? input.company),
      input.title,
      input.location,
    );
    const existing = this.db
      .prepare('SELECT * FROM applications WHERE dedupe_key = ?')
      .get(key) as Record<string, unknown> | undefined;

    if (existing) {
      return { application: this.toApplication(existing), created: false };
    }

    const timestamp = nowIso();
    const status = input.status ?? 'found';
    const id = this.db.transaction(() => {
      const result = this.db
        .prepare(
          `INSERT INTO applications (
             dedupe_key, company, title, job_id, status, notes, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(key, input.company, input.title, input.jobId, status, input.notes ?? null, timestamp, timestamp);
      const applicationId = Number(result.lastInsertRowid);
      this.db
        .prepare(
          `INSERT INTO application_events (application_id, from_status, to_status, note, created_at)
           VALUES (?, NULL, ?, ?, ?)`,
        )
        .run(applicationId, status, 'created', timestamp);
      return applicationId;
    })();

    return { application: this.getApplication(id)!, created: true };
  }

  /**
   * Finds or creates the application for a posting already in the database,
   * reusing the `dedupe_key` computed when it was stored. Preferred over
   * `ensureApplication` whenever you hold a `Job`.
   */
  ensureApplicationForJob(
    job: Job,
    options: { status?: ApplicationStatus; notes?: string | null } = {},
  ): { application: Application; created: boolean } {
    return this.ensureApplication({
      company: job.company,
      title: job.title,
      jobId: job.id,
      location: job.location,
      // The job row already carries the key computed at fetch time; reusing
      // its slug keeps the two in step even if the display name changed.
      companyKey: job.companySlug,
      ...options,
    });
  }

  /** Moves an application to a new status and records the transition. */
  setApplicationStatus(
    applicationId: number,
    status: ApplicationStatus,
    note?: string,
  ): Application {
    const timestamp = nowIso();
    this.db.transaction(() => {
      const current = this.db
        .prepare('SELECT status FROM applications WHERE id = ?')
        .get(applicationId) as { status: ApplicationStatus } | undefined;
      if (!current) throw new Error(`no application with id ${applicationId}`);

      this.db
        .prepare('UPDATE applications SET status = ?, updated_at = ? WHERE id = ?')
        .run(status, timestamp, applicationId);
      this.db
        .prepare(
          `INSERT INTO application_events (application_id, from_status, to_status, note, created_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(applicationId, current.status, status, note ?? null, timestamp);
    })();
    return this.getApplication(applicationId)!;
  }

  getApplication(id: number): Application | null {
    const row = this.db
      .prepare('SELECT * FROM applications WHERE id = ?')
      .get(id) as Record<string, unknown> | undefined;
    return row ? this.toApplication(row) : null;
  }

  listApplications(status?: ApplicationStatus): Application[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM applications
          WHERE (? IS NULL OR status = ?)
          ORDER BY updated_at DESC`,
      )
      .all(status ?? null, status ?? null) as Record<string, unknown>[];
    return rows.map((row) => this.toApplication(row));
  }

  listApplicationEvents(applicationId: number): ApplicationEvent[] {
    const rows = this.db
      .prepare('SELECT * FROM application_events WHERE application_id = ? ORDER BY created_at, id')
      .all(applicationId) as Record<string, unknown>[];
    return rows.map((row) => ({
      id: row.id as number,
      applicationId: row.application_id as number,
      fromStatus: (row.from_status as ApplicationStatus | null) ?? null,
      toStatus: row.to_status as ApplicationStatus,
      note: (row.note as string | null) ?? null,
      createdAt: row.created_at as string,
    }));
  }

  private toApplication(row: Record<string, unknown>): Application {
    return {
      id: row.id as number,
      dedupeKey: row.dedupe_key as string,
      company: row.company as string,
      title: row.title as string,
      jobId: (row.job_id as string | null) ?? null,
      status: row.status as ApplicationStatus,
      notes: (row.notes as string | null) ?? null,
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string,
    };
  }

  // -- fetch runs -----------------------------------------------------------

  startFetchRun(source: string, target: string): number {
    const result = this.db
      .prepare('INSERT INTO fetch_runs (source, target, started_at) VALUES (?, ?, ?)')
      .run(source, target, nowIso());
    return Number(result.lastInsertRowid);
  }

  finishFetchRun(
    id: number,
    outcome: { jobsSeen: number; jobsFresh: number; jobsNew: number; error?: string },
  ): void {
    this.db
      .prepare(
        `UPDATE fetch_runs
            SET finished_at = ?, jobs_seen = ?, jobs_fresh = ?, jobs_new = ?, ok = ?, error = ?
          WHERE id = ?`,
      )
      .run(
        nowIso(),
        outcome.jobsSeen,
        outcome.jobsFresh,
        outcome.jobsNew,
        outcome.error ? 0 : 1,
        outcome.error ?? null,
        id,
      );
  }

  /** Most recent fetch runs, newest first. Shown by `hunt` and the dashboard. */
  recentFetchRuns(limit = 50): Array<{
    id: number;
    source: string;
    target: string;
    startedAt: string;
    jobsSeen: number;
    jobsFresh: number;
    jobsNew: number;
    ok: boolean;
    error: string | null;
  }> {
    const rows = this.db
      .prepare('SELECT * FROM fetch_runs ORDER BY id DESC LIMIT ?')
      .all(limit) as Record<string, unknown>[];
    return rows.map((row) => ({
      id: row.id as number,
      source: row.source as string,
      target: row.target as string,
      startedAt: row.started_at as string,
      jobsSeen: row.jobs_seen as number,
      jobsFresh: row.jobs_fresh as number,
      jobsNew: row.jobs_new as number,
      ok: row.ok === 1,
      error: (row.error as string | null) ?? null,
    }));
  }

  /** Counts per status, for the dashboard header and `doctor`. */
  statusCounts(): Record<string, number> {
    const rows = this.db
      .prepare('SELECT status, COUNT(*) AS count FROM applications GROUP BY status')
      .all() as { status: string; count: number }[];
    return Object.fromEntries(rows.map((row) => [row.status, row.count]));
  }

  countJobs(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS count FROM jobs').get() as { count: number };
    return row.count;
  }
}
