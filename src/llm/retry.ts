import { LlmError } from '../util/errors.js';
import { log } from '../util/logger.js';

/**
 * Retry with exponential backoff and jitter, shared by both adapters.
 *
 * Only errors marked retryable are retried — a 400 for a malformed request
 * will fail the same way three times, and a refusal is not a transient fault.
 */
export async function withRetries<T>(
  operation: () => Promise<T>,
  options: { maxRetries: number; label: string },
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= options.maxRetries; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      const retryable = error instanceof LlmError ? error.retryable : false;
      if (!retryable || attempt === options.maxRetries) break;

      const backoffMs = Math.min(30_000, 500 * 2 ** attempt);
      const jitterMs = Math.floor(Math.random() * 250);
      const waitMs = backoffMs + jitterMs;
      log.warn(
        `${options.label} failed (attempt ${attempt + 1}/${options.maxRetries + 1}), retrying in ${waitMs}ms`,
        error instanceof Error ? error.message : String(error),
      );
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }

  throw lastError;
}

/** HTTP statuses worth another try. */
export function isRetryableStatus(status: number | undefined): boolean {
  if (status === undefined) return true; // network-level failure
  return status === 408 || status === 409 || status === 429 || status >= 500;
}
