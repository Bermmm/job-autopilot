import { z } from 'zod';

import { boardLabel, type Board } from '../config/companies.schema.js';
import type { JobInput } from '../db/repo.js';
import { htmlToText, truncateText } from './html.js';
import { isRemotePosting, type BoardFetcher, type FetchContext } from './types.js';

/**
 * Ashby public job board API.
 *
 *   https://api.ashbyhq.com/posting-api/job-board/<token>
 *
 * Quirks, all confirmed live:
 *
 *  * `isListed: false` marks postings the company is not advertising. They are
 *    skipped — applying to one would be applying to something nobody published.
 *  * `isRemote` and `workplaceType` can disagree on the same posting (a real
 *    one returned `isRemote: true` with `workplaceType: "Hybrid"`), so the
 *    explicit type wins.
 *  * Descriptions come inline and in plain text, which is convenient but makes
 *    responses large — one 183-posting board was 3MB.
 *  * There is no company name in the payload; it comes from config.
 */

const AshbyJobSchema = z
  .object({
    id: z.string(),
    title: z.string(),
    publishedAt: z.string().nullish(),
    location: z.string().nullish(),
    secondaryLocations: z
      .array(z.union([z.string(), z.object({ location: z.string().nullish() }).loose()]))
      .nullish(),
    isListed: z.boolean().nullish(),
    isRemote: z.boolean().nullish(),
    workplaceType: z.string().nullish(),
    employmentType: z.string().nullish(),
    department: z.string().nullish(),
    team: z.string().nullish(),
    jobUrl: z.string().nullish(),
    applyUrl: z.string().nullish(),
    descriptionPlain: z.string().nullish(),
    descriptionHtml: z.string().nullish(),
  })
  .loose();

const AshbyResponseSchema = z.object({ jobs: z.array(AshbyJobSchema) }).loose();

export class AshbyFetcher implements BoardFetcher {
  readonly source = 'ashby' as const;

  endpoint(board: Board): string {
    return `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(board.token)}`;
  }

  async fetch(board: Board, context: FetchContext): Promise<JobInput[]> {
    const raw = await context.http.getJson<unknown>(this.endpoint(board));
    const parsed = AshbyResponseSchema.parse(raw);

    return parsed.jobs
      // `isListed: false` means the company is not advertising it.
      // Treat a missing flag as listed, since older payloads omit it.
      .filter((job) => job.isListed !== false)
      .map((job) => {
        const location = job.location?.trim() ?? null;
        const text = job.descriptionPlain?.trim()
          ? job.descriptionPlain
          : job.descriptionHtml
            ? htmlToText(job.descriptionHtml)
            : null;

        const url = job.jobUrl ?? job.applyUrl;
        if (!url) {
          throw new Error(`Ashby posting ${job.id} has neither jobUrl nor applyUrl`);
        }

        return {
          source: this.source,
          externalId: job.id,
          companyKey: board.token,
          company: board.name ?? boardLabel(board),
          title: job.title.trim(),
          location,
          remote: isRemotePosting({
            workplaceType: job.workplaceType,
            remoteFlag: job.isRemote ?? undefined,
            location,
          }),
          url,
          description: text ? truncateText(text, context.maxDescriptionChars) : null,
          postedAt: normalizeTimestamp(job.publishedAt),
          raw: {
            id: job.id,
            publishedAt: job.publishedAt,
            workplaceType: job.workplaceType,
            isRemote: job.isRemote,
            employmentType: job.employmentType,
            department: job.department,
            team: job.team,
            secondaryLocations: job.secondaryLocations,
          },
        } satisfies JobInput;
      });
  }
}

function normalizeTimestamp(value: string | null | undefined): string | null {
  if (!value) return null;
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? null : new Date(timestamp).toISOString();
}
