import { readFileSync, existsSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import type { z } from 'zod';

import { ConfigError } from '../util/errors.js';
import { ConfigSchema, type Config } from './config.schema.js';
import { ProfileSchema, type Profile } from './profile.schema.js';
import { CompaniesFileSchema, type CompaniesFile } from './companies.schema.js';

/** Repo root, derived from this file's location (ESM-safe — no `__dirname`). */
export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/** Resolves a config-supplied path against the repo root. */
export function resolveFromRoot(path: string): string {
  return isAbsolute(path) ? path : resolve(repoRoot, path);
}

/** Turns a Zod error into a flat, line-per-problem list a human can act on. */
function describeIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join('.') : '(root)';
      return `  • ${path}: ${issue.message}`;
    })
    .join('\n');
}

function loadYamlFile<T extends z.ZodType>(
  absolutePath: string,
  schema: T,
  label: string,
  hint: string,
): z.infer<T> {
  if (!existsSync(absolutePath)) {
    throw new ConfigError(`${label} not found at ${absolutePath}`, hint);
  }

  let raw: unknown;
  try {
    raw = parseYaml(readFileSync(absolutePath, 'utf8'));
  } catch (cause) {
    throw new ConfigError(
      `${label} at ${absolutePath} is not valid YAML: ${(cause as Error).message}`,
      'Check indentation and quoting.',
    );
  }

  if (raw === null || raw === undefined) {
    throw new ConfigError(`${label} at ${absolutePath} is empty`, hint);
  }

  const result = schema.safeParse(raw);
  if (!result.success) {
    throw new ConfigError(
      `${label} at ${absolutePath} is invalid:\n${describeIssues(result.error)}`,
      hint,
    );
  }
  return result.data;
}

export function loadConfig(path = 'config.yaml'): Config {
  return loadYamlFile(
    resolveFromRoot(path),
    ConfigSchema,
    'config.yaml',
    'Copy config.example.yaml to config.yaml and edit it.',
  );
}

export function loadProfile(path: string): Profile {
  return loadYamlFile(
    resolveFromRoot(path),
    ProfileSchema,
    'profile.yaml',
    'Copy profile.example.yaml to profile.yaml and fill in your real details. profile.yaml is gitignored.',
  );
}

export function loadCompanies(path: string): CompaniesFile {
  return loadYamlFile(
    resolveFromRoot(path),
    CompaniesFileSchema,
    'companies.yaml',
    'Copy companies.example.yaml to companies.yaml and list the board tokens you care about.',
  );
}

/** Everything the CLI needs, loaded and validated in one go. */
export interface LoadedContext {
  config: Config;
  profile: Profile;
  companies: CompaniesFile;
}

export function loadAll(configPath = 'config.yaml'): LoadedContext {
  const config = loadConfig(configPath);
  return {
    config,
    profile: loadProfile(config.paths.profile),
    companies: loadCompanies(config.paths.companies),
  };
}
