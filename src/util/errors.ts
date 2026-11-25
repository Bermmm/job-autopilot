/** Base class for errors this tool raises on purpose, with a readable message. */
export class JobAutopilotError extends Error {
  constructor(
    message: string,
    readonly hint?: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

/** A config, profile, or companies file is missing or invalid. */
export class ConfigError extends JobAutopilotError {}

/** A job board or feed could not be read. */
export class SourceError extends JobAutopilotError {}

/** An LLM provider failed, or returned something unusable. */
export class LlmError extends JobAutopilotError {
  constructor(
    message: string,
    readonly options: { provider?: string; retryable?: boolean; cause?: unknown; hint?: string } = {},
  ) {
    super(message, options.hint);
    this.cause = options.cause;
  }

  get retryable(): boolean {
    return this.options.retryable ?? false;
  }
}

/** Formats an error for the CLI: message, then hint on its own line. */
export function formatError(error: unknown): string {
  if (error instanceof JobAutopilotError) {
    return error.hint ? `${error.message}\n  → ${error.hint}` : error.message;
  }
  if (error instanceof Error) return error.message;
  return String(error);
}
