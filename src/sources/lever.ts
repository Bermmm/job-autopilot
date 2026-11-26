import { z } from 'zod';

import { boardLabel, type Board } from '../config/companies.schema.js';
import type { JobInput } from '../db/repo.js';
import { htmlToText, truncateText } from './html.js';
import { isRemotePosting, type BoardFetcher, type FetchContext } from './types.js';

/**
 * Lever public postings API.
 *
 *   https://api.lever.co/v0/postings/<token>?mode=json
 *
 * Quirks, all confirmed live:
 *
 *  * The response is a bare array, not an object.
 *  * The title field is `text`, not `title`.
 *  * `createdAt` is epoch milliseconds, not a string.
 *  * There is no company name anywhere in the payload, so it comes from config.
 *  * Far fewer companies use Lever than Greenhouse or Ashby, and a wrong token
 *    returns 404 rather than an empty list.
 */

const LeverPostingSchema = z
  .object({
    id: z.string(),
    text: z.string(),
    createdAt: z.number().nullish(),
    hostedUrl: z.string(),
    applyUrl: z.string().optional(),
    workplaceType: z.string().nullish(),
    country: z.string().nullish(),
    descriptionPlain: z.string().nullish(),
    description: z.string().nullish(),
    categories: z
      .object({
        location: z.string().nullish(),
        allLocations: z.array(z.string()).nullish(),
        department: z.string().nullish(),
        team: z.string().nullish(),
        commitment: z.string().nullish(),
      })
      .nullish(),
  })
  .loose();

const LeverResponseSchema = z.array(LeverPostingSchema);

export class LeverFetcher implements BoardFetcher {
  readonly source = 'lever' as const;

  endpoint(board: Board): string {
    return `https://api.lever.co/v0/postings/${encodeURIComponent(board.token)}?mode=json`;
  }

  async fetch(board: Board, context: FetchContext): Promise<JobInput[]> {
    const raw = await context.http.getJson<unknown>(this.endpoint(board));
    const postings = LeverResponseSchema.parse(raw);

    return postings.map((posting) => {
      const location = posting.categories?.location?.trim() ?? null;
      // `descriptionPlain` is already text; `description` is HTML. Prefer the
      // former and fall back rather than shipping markup to the model.
      const text = posting.descriptionPlain?.trim()
        ? posting.descriptionPlain
        : posting.description
          ? htmlToText(posting.description)
          : null;

      return {
        source: this.source,
        externalId: posting.id,
        companyKey: board.token,
        company: board.name ?? boardLabel(board),
        title: posting.text.trim(),
        location,
        remote: isRemotePosting({ workplaceType: posting.workplaceType, location }),
        url: posting.hostedUrl,
        description: text ? truncateText(text, context.maxDescriptionChars) : null,
        postedAt: epochMillisToIso(posting.createdAt),
        raw: {
          id: posting.id,
          createdAt: posting.createdAt,
          workplaceType: posting.workplaceType,
          allLocations: posting.categories?.allLocations,
          department: posting.categories?.department,
          team: posting.categories?.team,
          commitment: posting.categories?.commitment,
        },
      } satisfies JobInput;
    });
  }
}

function epochMillisToIso(value: number | null | undefined): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
  return new Date(value).toISOString();
}
