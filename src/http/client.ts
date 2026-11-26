import type { HttpConfig } from '../config/config.schema.js';
import { SourceError } from '../util/errors.js';
import { log } from '../util/logger.js';

/**
 * The only thing in this project that makes outbound requests.
 *
 * These are free public APIs run by other people, so politeness is a feature:
 * a global request ceiling, a minimum gap between hits on the same host, an
 * identifiable user agent, and `Retry-After` honoured when a server asks us
 * to back off.
 */

export type FetchImpl = (url: string, init: RequestInit) => Promise<Response>;

export interface HttpClientOptions extends HttpConfig {
  /** Injectable for tests. Defaults to global `fetch`. */
  fetchImpl?: FetchImpl;
  /** Injectable for tests, so rate-limit waits do not really sleep. */
  sleepImpl?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export class HttpClient {
  private readonly config: HttpConfig;
  private readonly fetchImpl: FetchImpl;
  private readonly sleep: (ms: number) => Promise<void>;

  /** Token bucket for the global ceiling. */
  private tokens: number;
  private lastRefillAt: number;

  /** Last request time per host, for the per-host gap. */
  private readonly lastHostRequestAt = new Map<string, number>();

  /**
   * Slot acquisition is serialised through this chain. Without it, N callers
   * would each see "a token is free" at the same moment and all proceed.
   */
  private slotQueue: Promise<unknown> = Promise.resolve();

  private requestCount = 0;

  constructor(options: HttpClientOptions) {
    const { fetchImpl, sleepImpl, ...config } = options;
    this.config = config;
    this.fetchImpl = fetchImpl ?? ((url, init) => fetch(url, init));
    this.sleep = sleepImpl ?? defaultSleep;
    this.tokens = config.requestsPerMinute;
    this.lastRefillAt = Date.now();
  }

  /** Requests issued so far. Reported by `hunt` so the pace is visible. */
  get requestsMade(): number {
    return this.requestCount;
  }

  async getJson<T>(url: string): Promise<T> {
    const response = await this.request(url, { Accept: 'application/json' });
    const body = await response.text();
    try {
      return JSON.parse(body) as T;
    } catch {
      throw new SourceError(
        `${url} returned ${body.length} bytes that are not valid JSON.`,
        'The board may have changed its API, or returned an error page.',
      );
    }
  }

  async getText(url: string): Promise<string> {
    const response = await this.request(url, { Accept: 'application/xml, text/xml, */*' });
    return response.text();
  }

  /** One request, with rate limiting and retries applied. */
  private async request(url: string, headers: Record<string, string>): Promise<Response> {
    const host = hostOf(url);
    let lastError: unknown;

    for (let attempt = 0; attempt <= this.config.maxRetries; attempt += 1) {
      await this.acquireSlot(host);

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);

      try {
        this.requestCount += 1;
        const response = await this.fetchImpl(url, {
          method: 'GET',
          headers: { 'user-agent': this.config.userAgent, ...headers },
          signal: controller.signal,
          redirect: 'follow',
        });

        if (response.ok) return response;

        // 404 on a board token is normal — companies move providers — and is
        // not worth retrying.
        if (!isRetryableStatus(response.status)) {
          throw new SourceError(
            `${url} returned HTTP ${response.status}.`,
            response.status === 404
              ? 'Check the board token. A wrong token returns 404 rather than an empty list.'
              : response.status === 403
                ? 'The board may be blocking this user agent. Try changing http.userAgent.'
                : undefined,
          );
        }

        lastError = new SourceError(`${url} returned HTTP ${response.status}.`);
        const waitMs = this.retryDelayMs(attempt, response);
        if (attempt < this.config.maxRetries) {
          log.warn(`HTTP ${response.status} from ${host}, retrying in ${waitMs}ms`);
          await this.sleep(waitMs);
        }
      } catch (error) {
        clearTimeout(timer);

        if (error instanceof SourceError) throw error;

        const aborted = controller.signal.aborted;
        lastError = new SourceError(
          aborted
            ? `${url} timed out after ${this.config.timeoutMs}ms.`
            : `${url} failed: ${(error as Error).message}`,
        );

        if (attempt < this.config.maxRetries) {
          const waitMs = this.retryDelayMs(attempt);
          log.warn(`${aborted ? 'Timeout' : 'Network error'} from ${host}, retrying in ${waitMs}ms`);
          await this.sleep(waitMs);
        }
        continue;
      } finally {
        clearTimeout(timer);
      }
    }

    throw lastError ?? new SourceError(`${url} failed.`);
  }

  /** Exponential backoff with jitter, unless the server named a delay. */
  private retryDelayMs(attempt: number, response?: Response): number {
    const retryAfter = response?.headers.get('retry-after');
    if (retryAfter) {
      const seconds = Number(retryAfter);
      if (Number.isFinite(seconds) && seconds >= 0) {
        return Math.min(60_000, seconds * 1_000);
      }
      const date = Date.parse(retryAfter);
      if (!Number.isNaN(date)) {
        return Math.min(60_000, Math.max(0, date - Date.now()));
      }
    }
    return Math.min(30_000, 500 * 2 ** attempt) + Math.floor(Math.random() * 250);
  }

  /** Waits until both the global ceiling and the per-host gap allow a request. */
  private acquireSlot(host: string): Promise<void> {
    const run = this.slotQueue.then(
      () => this.waitForSlot(host),
      () => this.waitForSlot(host),
    );
    this.slotQueue = run;
    return run;
  }

  private async waitForSlot(host: string): Promise<void> {
    const ratePerMs = this.config.requestsPerMinute / 60_000;

    for (;;) {
      const now = Date.now();

      this.tokens = Math.min(
        this.config.requestsPerMinute,
        this.tokens + (now - this.lastRefillAt) * ratePerMs,
      );
      this.lastRefillAt = now;

      const tokenWaitMs = this.tokens >= 1 ? 0 : Math.ceil((1 - this.tokens) / ratePerMs);

      const lastHit = this.lastHostRequestAt.get(host);
      const hostWaitMs =
        lastHit === undefined
          ? 0
          : Math.max(0, this.config.perHostMinIntervalMs - (now - lastHit));

      const waitMs = Math.max(tokenWaitMs, hostWaitMs);
      if (waitMs <= 0) {
        this.tokens -= 1;
        this.lastHostRequestAt.set(host, Date.now());
        return;
      }
      await this.sleep(waitMs);
    }
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}
