-- job-autopilot schema.
--
-- One local SQLite file, no server, no cloud. Applied by src/db/migrate.ts,
-- which runs each statement inside a transaction and records the version in
-- `schema_migrations`.
--
-- Two ideas drive the layout:
--
--  * A *posting* (`jobs`) is a thing a board published. The same role can be
--    posted many times, in many cities, on many boards.
--  * An *application* (`applications`) is a thing you did. There is at most
--    one per company+role, enforced by a UNIQUE index on `dedupe_key`. That
--    constraint — not application code — is what makes "never apply twice"
--    true even if two `hunt` runs race.

PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- Postings
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS jobs (
  id                TEXT PRIMARY KEY,           -- jobId(source, external_id)
  source            TEXT NOT NULL CHECK (source IN ('greenhouse', 'lever', 'ashby', 'feed')),
  external_id       TEXT NOT NULL,              -- the board's own id
  company           TEXT NOT NULL,              -- as published
  company_slug      TEXT NOT NULL,              -- normalizeCompany()
  title             TEXT NOT NULL,              -- as published
  title_normalized  TEXT NOT NULL,              -- normalizeTitle()
  dedupe_key        TEXT NOT NULL,              -- company_slug || '::' || title_normalized
  location          TEXT,
  remote            INTEGER NOT NULL DEFAULT 0 CHECK (remote IN (0, 1)),
  url               TEXT NOT NULL,
  description       TEXT,                       -- plain text, HTML stripped
  posted_at         TEXT,                       -- ISO 8601 UTC, from the board
  posted_at_source  TEXT NOT NULL DEFAULT 'board'
                      CHECK (posted_at_source IN ('board', 'first_seen')),
  first_seen_at     TEXT NOT NULL,
  last_seen_at      TEXT NOT NULL,
  raw               TEXT,                       -- original payload, for debugging
  UNIQUE (source, external_id)
);

CREATE INDEX IF NOT EXISTS jobs_dedupe_key_idx  ON jobs (dedupe_key);
CREATE INDEX IF NOT EXISTS jobs_posted_at_idx   ON jobs (posted_at DESC);
CREATE INDEX IF NOT EXISTS jobs_company_idx     ON jobs (company_slug);

-- ---------------------------------------------------------------------------
-- Fit scores
-- ---------------------------------------------------------------------------

-- Scores are append-only: a re-score with a different model or prompt version
-- adds a row rather than overwriting, so a letter can always name the score it
-- was written against. `latest_scores` exposes the current one.
CREATE TABLE IF NOT EXISTS scores (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id          TEXT NOT NULL REFERENCES jobs (id) ON DELETE CASCADE,
  score           INTEGER NOT NULL CHECK (score BETWEEN 0 AND 100),
  reasons         TEXT NOT NULL DEFAULT '[]',   -- JSON array of strings
  red_flags       TEXT NOT NULL DEFAULT '[]',   -- JSON array of {kind, detail}
  summary         TEXT,
  provider        TEXT NOT NULL,
  model           TEXT NOT NULL,
  prompt_version  TEXT NOT NULL,
  input_tokens    INTEGER,
  output_tokens   INTEGER,
  created_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS scores_job_idx ON scores (job_id, created_at DESC);

CREATE VIEW IF NOT EXISTS latest_scores AS
SELECT s.*
FROM scores s
JOIN (
  SELECT job_id, MAX(id) AS id
  FROM scores
  GROUP BY job_id
) newest ON newest.id = s.id;

-- ---------------------------------------------------------------------------
-- Cover letters
-- ---------------------------------------------------------------------------

-- `facts_used` is the generator's citation list: which profile fields the
-- letter leaned on. The grounding test reads it, and the dashboard shows it.
CREATE TABLE IF NOT EXISTS letters (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id          TEXT NOT NULL REFERENCES jobs (id) ON DELETE CASCADE,
  body            TEXT NOT NULL,
  file_path       TEXT,                         -- under paths.letters
  facts_used      TEXT NOT NULL DEFAULT '[]',   -- JSON array of {field, value}
  provider        TEXT NOT NULL,
  model           TEXT NOT NULL,
  prompt_version  TEXT NOT NULL,
  grounded        INTEGER NOT NULL DEFAULT 0 CHECK (grounded IN (0, 1)),
  grounding_notes TEXT,                         -- JSON array of strings
  created_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS letters_job_idx ON letters (job_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- Applications
-- ---------------------------------------------------------------------------

-- At most one row per company+role. This is the duplicate guard.
CREATE TABLE IF NOT EXISTS applications (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  dedupe_key  TEXT NOT NULL UNIQUE,
  company     TEXT NOT NULL,
  title       TEXT NOT NULL,
  -- The posting acted on. Kept ON DELETE SET NULL: forgetting a stale posting
  -- must never erase the record that you applied.
  job_id      TEXT REFERENCES jobs (id) ON DELETE SET NULL,
  status      TEXT NOT NULL DEFAULT 'found'
                CHECK (status IN ('found', 'drafted', 'applied', 'rejected', 'interview', 'offer')),
  notes       TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS applications_status_idx ON applications (status, updated_at DESC);

-- Full status history, so the dashboard can show a timeline and nothing is
-- silently overwritten.
CREATE TABLE IF NOT EXISTS application_events (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  application_id  INTEGER NOT NULL REFERENCES applications (id) ON DELETE CASCADE,
  from_status     TEXT,
  to_status       TEXT NOT NULL,
  note            TEXT,
  created_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS application_events_app_idx
  ON application_events (application_id, created_at);

-- ---------------------------------------------------------------------------
-- Fetch bookkeeping
-- ---------------------------------------------------------------------------

-- One row per source per `hunt` run. Makes rate-limit and outage problems
-- visible instead of silent.
CREATE TABLE IF NOT EXISTS fetch_runs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  source        TEXT NOT NULL,
  target        TEXT NOT NULL,                  -- board token or feed url
  started_at    TEXT NOT NULL,
  finished_at   TEXT,
  jobs_seen     INTEGER NOT NULL DEFAULT 0,
  jobs_fresh    INTEGER NOT NULL DEFAULT 0,
  jobs_new      INTEGER NOT NULL DEFAULT 0,
  ok            INTEGER NOT NULL DEFAULT 0 CHECK (ok IN (0, 1)),
  error         TEXT
);

CREATE INDEX IF NOT EXISTS fetch_runs_started_idx ON fetch_runs (started_at DESC);
