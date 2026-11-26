import type { BoardSource } from '../config/companies.schema.js';
import { AshbyFetcher } from './ashby.js';
import { GreenhouseFetcher } from './greenhouse.js';
import { LeverFetcher } from './lever.js';
import type { BoardFetcher } from './types.js';

/** The fetcher for each supported board. */
export const FETCHERS: Record<BoardSource, BoardFetcher> = {
  greenhouse: new GreenhouseFetcher(),
  lever: new LeverFetcher(),
  ashby: new AshbyFetcher(),
};

export function fetcherFor(source: BoardSource): BoardFetcher {
  return FETCHERS[source];
}

export * from './types.js';
export * from './freshness.js';
export * from './html.js';
export { AshbyFetcher } from './ashby.js';
export { GreenhouseFetcher } from './greenhouse.js';
export { LeverFetcher } from './lever.js';
