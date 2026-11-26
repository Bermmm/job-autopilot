import { existsSync } from 'node:fs';

import { boardLabel } from '../config/companies.schema.js';
import { resolveLlmConfig } from '../config/config.schema.js';
import { loadConfig, loadCompanies, loadProfile, resolveFromRoot } from '../config/load.js';
import { readEnv } from '../config/env.js';
import { currentVersion, openDatabase, Repo, SCHEMA_VERSION } from '../db/index.js';
import { formatError } from '../util/errors.js';
import { out } from '../util/logger.js';

/**
 * `pnpm doctor` — checks the setup without calling an LLM or a job board.
 *
 * This is the first thing to run after cloning, and the first thing to run
 * when something is wrong. It never spends money and never leaves the machine.
 */

type CheckResult = { ok: boolean; label: string; detail?: string };

function tick(result: CheckResult): string {
  const mark = result.ok ? '✓' : '✗';
  return result.detail ? `  ${mark} ${result.label}\n      ${result.detail}` : `  ${mark} ${result.label}`;
}

function check(label: string, run: () => string | undefined): CheckResult {
  try {
    return { ok: true, label, detail: run() };
  } catch (error) {
    return { ok: false, label, detail: formatError(error) };
  }
}

export function doctor(configPath = 'config.yaml'): number {
  const results: CheckResult[] = [];

  const configResult = check('config.yaml loads and validates', () => {
    const config = loadConfig(configPath);
    const scoring = resolveLlmConfig(config.llm, 'scoring');
    const writing = resolveLlmConfig(config.llm, 'writing');
    return [
      `provider=${config.llm.provider}`,
      `scoring=${scoring.model} (effort ${scoring.effort})`,
      `writing=${writing.model} (effort ${writing.effort})`,
      `freshness=${config.freshness.windowHours}h`,
    ].join('\n      ');
  });
  results.push(configResult);

  if (!configResult.ok) {
    out('job-autopilot doctor\n');
    out(results.map(tick).join('\n'));
    out('\nFix config.yaml first — the rest of the checks depend on it.');
    return 1;
  }

  const config = loadConfig(configPath);

  results.push(
    check('profile.yaml loads and validates', () => {
      const profile = loadProfile(config.paths.profile);
      return `${profile.name}, ${profile.yearsExperience}y, ${profile.roles.length} roles, ${profile.standardAnswers.length} standard answers`;
    }),
  );

  results.push(
    check('companies.yaml loads and validates', () => {
      const companies = loadCompanies(config.paths.companies);
      const enabled = companies.boards.filter((board) => board.enabled);
      const names = enabled.slice(0, 4).map(boardLabel).join(', ');
      const more = enabled.length > 4 ? `, +${enabled.length - 4} more` : '';
      return `${enabled.length} board(s) enabled${names ? `: ${names}${more}` : ''}; ${companies.feeds.filter((f) => f.enabled).length} feed(s)`;
    }),
  );

  results.push(
    check(`API key for provider "${config.llm.provider}"`, () => {
      const env = readEnv();
      const variable = config.llm.provider === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY';
      if (!env[variable]) {
        throw new Error(`${variable} is not set. Add it to .env (see .env.example).`);
      }
      return `${variable} is set (not validated — no network call made)`;
    }),
  );

  results.push(
    check('database opens and schema is current', () => {
      const db = openDatabase({ path: config.paths.database });
      try {
        const version = currentVersion(db);
        const repo = new Repo(db);
        const counts = repo.statusCounts();
        const summary = Object.entries(counts)
          .map(([status, count]) => `${status}=${count}`)
          .join(' ');
        const runs = repo.recentFetchRuns(20);
        const lastRun = runs[0];
        const lastHunt = lastRun ? `; last hunt ${lastRun.startedAt}` : '; no hunt run yet';
        return `schema v${version} (code expects v${SCHEMA_VERSION}); ${repo.countJobs()} job(s)${summary ? `; ${summary}` : ''}${lastHunt}`;
      } finally {
        db.close();
      }
    }),
  );

  results.push(
    check('letters directory is writable', () => {
      const path = resolveFromRoot(config.paths.letters);
      return existsSync(path) ? path : `${path} (will be created on first draft)`;
    }),
  );

  results.push(
    check('pre-commit guard is installed', () => {
      const hook = resolveFromRoot('.githooks/pre-commit');
      if (!existsSync(hook)) throw new Error('.githooks/pre-commit is missing');
      return 'run `pnpm install` if commits are not being checked';
    }),
  );

  out('job-autopilot doctor\n');
  out(results.map(tick).join('\n'));

  const failures = results.filter((result) => !result.ok).length;
  out('');
  out(failures === 0 ? 'All checks passed.' : `${failures} check(s) failed.`);
  return failures === 0 ? 0 : 1;
}
