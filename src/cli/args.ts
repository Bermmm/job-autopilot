import { ConfigError } from '../util/errors.js';

/**
 * Minimal flag parsing. Hand-rolled because the CLI has a handful of verbs,
 * and one fewer dependency is one fewer thing to audit in a tool that reads
 * your personal data.
 */

export interface ParsedArgs {
  command: string;
  positional: string[];
  flags: Map<string, string | true>;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const args = argv.slice(2);
  const positional: string[] = [];
  const flags = new Map<string, string | true>();

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;

    if (!arg.startsWith('-')) {
      positional.push(arg);
      continue;
    }

    const [name, inlineValue] = splitFlag(arg);
    if (inlineValue !== undefined) {
      flags.set(name, inlineValue);
      continue;
    }

    const next = args[index + 1];
    // A bare flag followed by another flag (or nothing) is a boolean.
    if (next === undefined || next.startsWith('-')) {
      flags.set(name, true);
    } else {
      flags.set(name, next);
      index += 1;
    }
  }

  return { command: positional[0] ?? 'help', positional: positional.slice(1), flags };
}

function splitFlag(arg: string): [string, string | undefined] {
  const withoutDashes = arg.replace(/^--?/, '');
  const equals = withoutDashes.indexOf('=');
  if (equals === -1) return [withoutDashes, undefined];
  return [withoutDashes.slice(0, equals), withoutDashes.slice(equals + 1)];
}

export function stringFlag(args: ParsedArgs, name: string): string | undefined {
  const value = args.flags.get(name);
  if (value === undefined) return undefined;
  if (value === true) throw new ConfigError(`--${name} needs a value.`);
  return value;
}

export function boolFlag(args: ParsedArgs, name: string): boolean {
  const value = args.flags.get(name);
  if (value === undefined) return false;
  if (value === true) return true;
  return value !== 'false' && value !== '0';
}

export function intFlag(args: ParsedArgs, name: string, bounds: { min: number; max: number }): number | undefined {
  const raw = stringFlag(args, name);
  if (raw === undefined) return undefined;

  const value = Number(raw);
  if (!Number.isInteger(value)) {
    throw new ConfigError(`--${name} must be a whole number, got "${raw}".`);
  }
  if (value < bounds.min || value > bounds.max) {
    throw new ConfigError(`--${name} must be between ${bounds.min} and ${bounds.max}, got ${value}.`);
  }
  return value;
}
