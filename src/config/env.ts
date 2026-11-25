import { existsSync } from 'node:fs';
import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';

import { ConfigError } from '../util/errors.js';
import { repoRoot, resolveFromRoot } from './load.js';

/**
 * Secrets live in `.env` (gitignored) and nowhere else. They are read here and
 * never written to the database, the log, or a generated letter.
 */

let loaded = false;

/** Reads `.env` into `process.env` once. Existing env vars win. */
export function loadEnv(): void {
  if (loaded) return;
  const envPath = resolveFromRoot('.env');
  if (existsSync(envPath)) loadDotenv({ path: envPath, quiet: true });
  loaded = true;
}

const EnvSchema = z.object({
  ANTHROPIC_API_KEY: z.string().min(1).optional(),
  OPENAI_API_KEY: z.string().min(1).optional(),
  /** Optional override, mainly for proxies and local gateways. */
  ANTHROPIC_BASE_URL: z.string().url().optional(),
  OPENAI_BASE_URL: z.string().url().optional(),
});

export type Env = z.infer<typeof EnvSchema>;

export function readEnv(): Env {
  loadEnv();
  const result = EnvSchema.safeParse(process.env);
  if (!result.success) {
    throw new ConfigError(
      `Environment is invalid:\n${result.error.issues
        .map((i) => `  • ${i.path.join('.')}: ${i.message}`)
        .join('\n')}`,
      'See .env.example.',
    );
  }
  return result.data;
}

/** The API key for a provider, with a pointed message when it is missing. */
export function requireApiKey(provider: 'anthropic' | 'openai'): string {
  const env = readEnv();
  const variable = provider === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY';
  const key = env[variable];
  if (!key) {
    throw new ConfigError(
      `${variable} is not set, but config.yaml selects the "${provider}" provider.`,
      `Add ${variable}=... to ${repoRoot}/.env (copy .env.example), or switch llm.provider in config.yaml.`,
    );
  }
  return key;
}
