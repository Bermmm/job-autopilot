import { z } from 'zod';

/**
 * Schema for `companies.yaml` — which public job boards to poll.
 *
 * Only sources with a documented public JSON API or feed belong here.
 * Scraping sites whose terms forbid it (LinkedIn, Indeed, and friends) is
 * out of scope for this project by design, not by omission.
 */

export const BoardSourceSchema = z.enum(['greenhouse', 'lever', 'ashby']);
export type BoardSource = z.infer<typeof BoardSourceSchema>;

export const BoardSchema = z
  .object({
    source: BoardSourceSchema,
    /**
     * The board token in the public API URL. For
     * `boards-api.greenhouse.io/v1/boards/acme/jobs` that is `acme`.
     */
    token: z.string().min(1),
    /** Display name. Falls back to the token when omitted. */
    name: z.string().min(1).optional(),
    enabled: z.boolean().default(true),
    /** Skip this board's postings unless the title matches one of these. */
    titleIncludes: z.array(z.string().min(1)).default([]),
  })
  .strict();
export type Board = z.infer<typeof BoardSchema>;

export const FeedSchema = z
  .object({
    /** Display name for the feed's publisher. */
    name: z.string().min(1),
    url: z.string().url(),
    format: z.enum(['rss', 'atom', 'json']),
    enabled: z.boolean().default(true),
  })
  .strict();
export type Feed = z.infer<typeof FeedSchema>;

export const CompaniesFileSchema = z
  .object({
    boards: z.array(BoardSchema).default([]),
    feeds: z.array(FeedSchema).default([]),
  })
  .strict()
  .superRefine((file, ctx) => {
    const seen = new Set<string>();
    file.boards.forEach((board, index) => {
      const key = `${board.source}:${board.token.toLowerCase()}`;
      if (seen.has(key)) {
        ctx.addIssue({
          code: 'custom',
          message: `duplicate board: ${key}`,
          path: ['boards', index, 'token'],
        });
      }
      seen.add(key);
    });

    const feedUrls = new Set<string>();
    file.feeds.forEach((feed, index) => {
      if (feedUrls.has(feed.url)) {
        ctx.addIssue({
          code: 'custom',
          message: `duplicate feed url: ${feed.url}`,
          path: ['feeds', index, 'url'],
        });
      }
      feedUrls.add(feed.url);
    });

    if (file.boards.length === 0 && file.feeds.length === 0) {
      ctx.addIssue({
        code: 'custom',
        message: 'companies.yaml lists no boards and no feeds — nothing to hunt',
        path: ['boards'],
      });
    }
  });

export type CompaniesFile = z.infer<typeof CompaniesFileSchema>;

/** Display label for a board. */
export function boardLabel(board: Board): string {
  return board.name ?? board.token;
}
