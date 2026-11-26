import type { Board, BoardSource } from '../config/companies.schema.js';
import type { JobInput } from '../db/repo.js';
import type { HttpClient } from '../http/client.js';

/**
 * A fetcher turns one board into postings. Each board API is different enough
 * that sharing code between them would obscure more than it saves, so they
 * share only this interface and the HTTP client.
 */

export interface FetchContext {
  http: HttpClient;
  /** Cap on description length, from `scoring.maxDescriptionChars`. */
  maxDescriptionChars: number;
}

export interface BoardFetcher {
  readonly source: BoardSource;
  /** The URL this fetcher will call, exposed so `hunt` can report it. */
  endpoint(board: Board): string;
  /**
   * Every posting the board currently lists, normalised. Freshness filtering
   * happens afterwards, so a fetcher's only job is faithful translation.
   */
  fetch(board: Board, context: FetchContext): Promise<JobInput[]>;
}

/** Remote-ness as the boards express it, before we reduce it to a boolean. */
export type WorkplaceType = 'remote' | 'hybrid' | 'onsite' | 'unknown';

export function normalizeWorkplaceType(value: unknown): WorkplaceType {
  if (typeof value !== 'string') return 'unknown';
  const lower = value.trim().toLowerCase();
  if (lower === 'remote' || lower === 'fully remote') return 'remote';
  if (lower === 'hybrid') return 'hybrid';
  if (lower === 'onsite' || lower === 'on-site' || lower === 'in office') return 'onsite';
  return 'unknown';
}

/**
 * Whether a posting counts as remote.
 *
 * An explicit workplace type wins where a board publishes one. Ashby, for
 * instance, returns `isRemote: true` alongside `workplaceType: "Hybrid"` on
 * the same posting, so the flag alone would overstate it. Falling back to the
 * location text is last resort.
 */
export function isRemotePosting(input: {
  workplaceType?: unknown;
  remoteFlag?: boolean | undefined;
  location?: string | null | undefined;
}): boolean {
  const workplace = normalizeWorkplaceType(input.workplaceType);
  if (workplace !== 'unknown') return workplace === 'remote';
  if (typeof input.remoteFlag === 'boolean') return input.remoteFlag;
  return /\bremote\b/i.test(input.location ?? '');
}
