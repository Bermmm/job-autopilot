/* eslint-disable no-console */

/**
 * Deliberately tiny logger. Writes to stderr so CLI output on stdout stays
 * pipeable, and redacts anything that looks like an API key before printing.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const SECRET_PATTERNS: RegExp[] = [
  /\bsk-ant-[A-Za-z0-9_-]{8,}/g,
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  /\bBearer\s+[A-Za-z0-9._-]{8,}/gi,
];

/** Replaces anything key-shaped with a placeholder. */
export function redact(value: string): string {
  return SECRET_PATTERNS.reduce((acc, pattern) => acc.replace(pattern, '[redacted]'), value);
}

function currentLevel(): LogLevel {
  const raw = (process.env.LOG_LEVEL ?? 'info').toLowerCase();
  return raw in LEVEL_ORDER ? (raw as LogLevel) : 'info';
}

const PREFIX: Record<LogLevel, string> = {
  debug: '·',
  info: '•',
  warn: '!',
  error: '✗',
};

function emit(level: LogLevel, message: string, detail?: unknown): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[currentLevel()]) return;
  const line = `${PREFIX[level]} ${redact(message)}`;
  const suffix =
    detail === undefined ? '' : ` ${redact(typeof detail === 'string' ? detail : JSON.stringify(detail))}`;
  console.error(line + suffix);
}

export const log = {
  debug: (message: string, detail?: unknown) => emit('debug', message, detail),
  info: (message: string, detail?: unknown) => emit('info', message, detail),
  warn: (message: string, detail?: unknown) => emit('warn', message, detail),
  error: (message: string, detail?: unknown) => emit('error', message, detail),
};

/** Writes a line of program output to stdout (results, not diagnostics). */
export function out(line = ''): void {
  console.log(line);
}
