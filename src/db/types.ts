/** Row shapes as stored. JSON columns are strings here; the repo layer parses them. */

export type JobSource = 'greenhouse' | 'lever' | 'ashby' | 'feed';

export type ApplicationStatus =
  | 'found'
  | 'drafted'
  | 'applied'
  | 'rejected'
  | 'interview'
  | 'offer';

export const APPLICATION_STATUSES: readonly ApplicationStatus[] = [
  'found',
  'drafted',
  'applied',
  'rejected',
  'interview',
  'offer',
] as const;

export interface JobRow {
  id: string;
  source: JobSource;
  external_id: string;
  company: string;
  company_slug: string;
  title: string;
  title_normalized: string;
  dedupe_key: string;
  location: string | null;
  remote: 0 | 1;
  url: string;
  description: string | null;
  posted_at: string | null;
  posted_at_source: 'board' | 'first_seen';
  first_seen_at: string;
  last_seen_at: string;
  raw: string | null;
}

/** A posting as the rest of the app sees it: booleans real, dates ISO strings. */
export interface Job {
  id: string;
  source: JobSource;
  externalId: string;
  company: string;
  companySlug: string;
  title: string;
  titleNormalized: string;
  dedupeKey: string;
  location: string | null;
  remote: boolean;
  url: string;
  description: string | null;
  postedAt: string | null;
  postedAtSource: 'board' | 'first_seen';
  firstSeenAt: string;
  lastSeenAt: string;
}

export interface RedFlag {
  /** Which rule tripped, so the dashboard can group them. */
  kind: 'years' | 'location' | 'degree' | 'salary' | 'seniority' | 'other';
  detail: string;
}

export interface Score {
  id: number;
  jobId: string;
  score: number;
  reasons: string[];
  redFlags: RedFlag[];
  summary: string | null;
  provider: string;
  model: string;
  promptVersion: string;
  inputTokens: number | null;
  outputTokens: number | null;
  createdAt: string;
}

/** A profile fact the letter actually used, and where it came from. */
export interface FactCitation {
  /** Dotted path into profile.yaml, e.g. `roles.0.highlights.1`. */
  field: string;
  value: string;
}

export interface Letter {
  id: number;
  jobId: string;
  body: string;
  filePath: string | null;
  factsUsed: FactCitation[];
  provider: string;
  model: string;
  promptVersion: string;
  grounded: boolean;
  groundingNotes: string[];
  createdAt: string;
}

export interface Application {
  id: number;
  dedupeKey: string;
  company: string;
  title: string;
  jobId: string | null;
  status: ApplicationStatus;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ApplicationEvent {
  id: number;
  applicationId: number;
  fromStatus: ApplicationStatus | null;
  toStatus: ApplicationStatus;
  note: string | null;
  createdAt: string;
}
