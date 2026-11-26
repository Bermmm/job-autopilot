import { z } from 'zod';

import { boardLabel, type Board } from '../config/companies.schema.js';
import type { JobInput } from '../db/repo.js';
import { htmlToText, truncateText } from './html.js';
import { isRemotePosting, type BoardFetcher, type FetchContext } from './types.js';

/**
 * Greenhouse public job board API.
 *
 *   https://boards-api.greenhouse.io/v1/boards/<token>/jobs?content=true
 *
 * Two things to know, both confirmed against live boards:
 *
 *  * `first_published` is the real publish date; `updated_at` is not. A role
 *    posted in 2025 and edited last week looks new by `updated_at`, and on one
 *    board that difference was five postings versus none inside 48 hours.
 *  * `content` is *double-escaped* HTML — the payload holds `&lt;div&gt;`
 *    where the document has `<div>`.
 *
 * `?content=true` returns descriptions inline, so there is no per-job request
 * to make. For a large board that is one 300KB response instead of 800 small
 * ones, which both boards and rate limits prefer.
 */

const GreenhouseJobSchema = z
  .object({
    id: z.union([z.number(), z.string()]),
    title: z.string(),
    absolute_url: z.string(),
    company_name: z.string().optional(),
    first_published: z.string().nullish(),
    updated_at: z.string().nullish(),
    location: z.object({ name: z.string().nullish() }).nullish(),
    offices: z.array(z.object({ name: z.string().nullish() })).optional(),
    departments: z.array(z.object({ name: z.string().nullish() })).optional(),
    content: z.string().nullish(),
  })
  // Boards add fields over time; unknown ones are ignored rather than fatal.
  .loose();

const GreenhouseResponseSchema = z.object({ jobs: z.array(GreenhouseJobSchema) }).loose();

export class GreenhouseFetcher implements BoardFetcher {
  readonly source = 'greenhouse' as const;

  endpoint(board: Board): string {
    return `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(board.token)}/jobs?content=true`;
  }

  async fetch(board: Board, context: FetchContext): Promise<JobInput[]> {
    const raw = await context.http.getJson<unknown>(this.endpoint(board));
    const parsed = GreenhouseResponseSchema.parse(raw);

    return parsed.jobs.map((job) => {
      const location = job.location?.name?.trim() ?? null;
      const description = job.content
        ? truncateText(htmlToText(job.content, { doubleEscaped: true }), context.maxDescriptionChars)
        : null;

      return {
        source: this.source,
        externalId: String(job.id),
        // The board token is the stable identity; `name` is only a label.
        companyKey: board.token,
        company: board.name ?? job.company_name ?? boardLabel(board),
        title: job.title.trim(),
        location,
        remote: isRemotePosting({ location }),
        url: job.absolute_url,
        description,
        postedAt: normalizeTimestamp(job.first_published),
        raw: {
          id: job.id,
          first_published: job.first_published,
          updated_at: job.updated_at,
          offices: job.offices?.map((office) => office.name).filter(Boolean),
          departments: job.departments?.map((department) => department.name).filter(Boolean),
        },
      } satisfies JobInput;
    });
  }
}

/** Greenhouse sends offsets ("2026-10-27T13:40:12-04:00"); store UTC. */
function normalizeTimestamp(value: string | null | undefined): string | null {
  if (!value) return null;
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? null : new Date(timestamp).toISOString();
}
