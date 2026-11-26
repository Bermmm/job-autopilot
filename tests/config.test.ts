import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';

import { ConfigSchema, resolveLlmConfig } from '../src/config/config.schema.js';
import { ProfileSchema } from '../src/config/profile.schema.js';
import { CompaniesFileSchema } from '../src/config/companies.schema.js';
import { resolveFromRoot } from '../src/config/load.js';

/**
 * The committed example files are the project's documentation. If they stop
 * validating, every setup guide in the README is wrong — so they are tested.
 */

function loadExample(name: string): unknown {
  return parseYaml(readFileSync(resolveFromRoot(name), 'utf8'));
}

describe('config.example.yaml', () => {
  it('validates', () => {
    const result = ConfigSchema.safeParse(loadExample('config.example.yaml'));
    if (!result.success) throw new Error(JSON.stringify(result.error.issues, null, 2));
    expect(result.data.llm.provider).toBe('anthropic');
  });

  it('ships with a 48-hour freshness window', () => {
    const config = ConfigSchema.parse(loadExample('config.example.yaml'));
    expect(config.freshness.windowHours).toBe(48);
  });

  it('ships with autofill off', () => {
    const config = ConfigSchema.parse(loadExample('config.example.yaml'));
    expect(config.autofill.enabled).toBe(false);
  });
});

describe('ConfigSchema', () => {
  const minimal = { llm: { model: 'claude-opus-5-5' } };


  it('fills in every section from defaults', () => {
    const config = ConfigSchema.parse(minimal);
    expect(config.freshness.windowHours).toBe(48);
    expect(config.http.requestsPerMinute).toBe(30);
    expect(config.scoring.minScoreToDraft).toBe(70);
    expect(config.paths.database).toBe('./data/job-autopilot.db');
    expect(config.autofill.enabled).toBe(false);
  });

  it('requires a model — there is no sensible default to guess', () => {
    expect(ConfigSchema.safeParse({ llm: {} }).success).toBe(false);
  });

  it('rejects an unknown provider', () => {
    expect(
      ConfigSchema.safeParse({ llm: { provider: 'llamafile', model: 'x' } }).success,
    ).toBe(false);
  });

  it('rejects unknown keys, so a typo is an error rather than a silent no-op', () => {
    expect(
      ConfigSchema.safeParse({ ...minimal, freshnes: { windowHours: 48 } }).success,
    ).toBe(false);
    expect(
      ConfigSchema.safeParse({ llm: { model: 'x', tempurature: 0.5 } }).success,
    ).toBe(false);
  });

  it('refuses to let a config disable human review of autofill', () => {
    // The point of the literal type: there is no way to write a config file
    // that claims a form was submitted without someone looking at it.
    const result = ConfigSchema.safeParse({
      ...minimal,
      autofill: { enabled: true, requireHumanReview: false },
    });
    expect(result.success).toBe(false);
  });

  it('refuses to let a config skip questions the profile cannot answer', () => {
    expect(
      ConfigSchema.safeParse({
        ...minimal,
        autofill: { enabled: true, pauseOnUnknownQuestion: false },
      }).success,
    ).toBe(false);
  });

  it('rejects a freshness window of zero', () => {
    expect(
      ConfigSchema.safeParse({ ...minimal, freshness: { windowHours: 0 } }).success,
    ).toBe(false);
  });

  it('rejects a user agent that identifies nothing', () => {
    expect(ConfigSchema.safeParse({ ...minimal, http: { userAgent: 'x' } }).success).toBe(false);
  });
});

describe('profile.example.yaml', () => {
  it('validates', () => {
    const result = ProfileSchema.safeParse(loadExample('profile.example.yaml'));
    if (!result.success) throw new Error(JSON.stringify(result.error.issues, null, 2));
  });

  it('is obviously fake, so nobody mistakes it for a real profile', () => {
    const profile = ProfileSchema.parse(loadExample('profile.example.yaml'));
    expect(profile.contact.email).toMatch(/@example\.com$/);
    for (const link of profile.contact.links) {
      expect(link.url).toMatch(/example/);
    }
  });

  it('demonstrates every field the letter generator can cite', () => {
    const profile = ProfileSchema.parse(loadExample('profile.example.yaml'));
    expect(profile.roles.length).toBeGreaterThan(1);
    expect(profile.certifications.length).toBeGreaterThan(0);
    expect(profile.education.length).toBeGreaterThan(0);
    expect(profile.skills.strong.length).toBeGreaterThan(0);
    expect(profile.skills.working.length).toBeGreaterThan(0);
    expect(profile.standardAnswers.length).toBeGreaterThan(0);
    expect(profile.voiceNotes.length).toBeGreaterThan(0);
  });
});

describe('ProfileSchema', () => {
  const valid = ProfileSchema.parse(loadExample('profile.example.yaml'));

  it('requires at least one role', () => {
    expect(ProfileSchema.safeParse({ ...valid, roles: [] }).success).toBe(false);
  });

  it('requires every role to have at least one highlight', () => {
    const roleWithNoHighlights = { ...valid.roles[0]!, highlights: [] };
    expect(
      ProfileSchema.safeParse({ ...valid, roles: [roleWithNoHighlights] }).success,
    ).toBe(false);
  });

  it('rejects a malformed date', () => {
    const badRole = { ...valid.roles[0]!, start: '2022' };
    expect(ProfileSchema.safeParse({ ...valid, roles: [badRole] }).success).toBe(false);
  });

  it('accepts "present" as an end date', () => {
    const current = { ...valid.roles[0]!, end: 'present' };
    expect(ProfileSchema.safeParse({ ...valid, roles: [current] }).success).toBe(true);
  });

  it('rejects a salary target below the minimum', () => {
    const result = ProfileSchema.safeParse({
      ...valid,
      salary: { ...valid.salary, minimum: 90000, target: 80000 },
    });
    expect(result.success).toBe(false);
  });

  it('rejects duplicate standard-answer keys', () => {
    const duplicate = {
      ...valid,
      standardAnswers: [
        { key: 'notice_period', question: 'Notice?', answer: 'One month.' },
        { key: 'notice_period', question: 'Notice period?', answer: 'Two months.' },
      ],
    };
    const result = ProfileSchema.safeParse(duplicate);
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toMatch(/duplicate/);
  });

  it('rejects an unknown top-level key', () => {
    expect(ProfileSchema.safeParse({ ...valid, favouriteColour: 'blue' }).success).toBe(false);
  });

  it('rejects a bad email', () => {
    expect(
      ProfileSchema.safeParse({
        ...valid,
        contact: { ...valid.contact, email: 'not-an-email' },
      }).success,
    ).toBe(false);
  });
});

describe('companies.example.yaml', () => {
  it('validates', () => {
    const result = CompaniesFileSchema.safeParse(loadExample('companies.example.yaml'));
    if (!result.success) throw new Error(JSON.stringify(result.error.issues, null, 2));
  });

  it('covers all three board types', () => {
    const companies = CompaniesFileSchema.parse(loadExample('companies.example.yaml'));
    const sources = new Set(companies.boards.map((board) => board.source));
    expect(sources).toEqual(new Set(['greenhouse', 'lever', 'ashby']));
  });

  it('defaults boards to enabled', () => {
    const companies = CompaniesFileSchema.parse(loadExample('companies.example.yaml'));
    const greenhouse = companies.boards.find((board) => board.source === 'greenhouse');
    expect(greenhouse?.enabled).toBe(true);
  });
});

describe('CompaniesFileSchema', () => {
  it('rejects a file with nothing to hunt', () => {
    const result = CompaniesFileSchema.safeParse({ boards: [], feeds: [] });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toMatch(/nothing to hunt/);
  });

  it('rejects the same board listed twice', () => {
    const result = CompaniesFileSchema.safeParse({
      boards: [
        { source: 'greenhouse', token: 'acme' },
        { source: 'greenhouse', token: 'ACME' },
      ],
    });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toMatch(/duplicate board/);
  });

  it('allows the same token on two different boards', () => {
    const result = CompaniesFileSchema.safeParse({
      boards: [
        { source: 'greenhouse', token: 'acme' },
        { source: 'lever', token: 'acme' },
      ],
    });
    expect(result.success).toBe(true);
  });

  it('rejects an unsupported source — no scraping by the back door', () => {
    expect(
      CompaniesFileSchema.safeParse({ boards: [{ source: 'linkedin', token: 'acme' }] }).success,
    ).toBe(false);
  });
});

describe('resolveLlmConfig', () => {
  const base = { provider: 'anthropic' as const, model: 'default-model' };

  it('falls back to the top-level settings when a task overrides nothing', () => {
    const config = ConfigSchema.parse({ llm: base });
    const scoring = resolveLlmConfig(config.llm, 'scoring');

    expect(scoring.model).toBe('default-model');
    expect(scoring.effort).toBe('medium');
    expect(scoring.maxOutputTokens).toBe(8000);
    expect(scoring.task).toBe('scoring');
  });

  it('lets a task override the model without affecting the other task', () => {
    const config = ConfigSchema.parse({
      llm: { ...base, scoring: { model: 'cheap-model', effort: 'low' } },
    });

    expect(resolveLlmConfig(config.llm, 'scoring').model).toBe('cheap-model');
    expect(resolveLlmConfig(config.llm, 'scoring').effort).toBe('low');
    expect(resolveLlmConfig(config.llm, 'writing').model).toBe('default-model');
    expect(resolveLlmConfig(config.llm, 'writing').effort).toBe('medium');
  });

  it('shares timeout and retry settings across tasks', () => {
    const config = ConfigSchema.parse({ llm: { ...base, timeoutMs: 30000, maxRetries: 1 } });

    for (const task of ['scoring', 'writing'] as const) {
      expect(resolveLlmConfig(config.llm, task).timeoutMs).toBe(30000);
      expect(resolveLlmConfig(config.llm, task).maxRetries).toBe(1);
    }
  });

  it('still accepts a step-1 config with no task blocks at all', () => {
    // Backwards compatibility: one model for everything remains valid.
    const result = ConfigSchema.safeParse({ llm: { model: 'one-model' } });
    expect(result.success).toBe(true);
    expect(resolveLlmConfig(result.data!.llm, 'writing').model).toBe('one-model');
  });

  it('rejects a typo inside a task block rather than ignoring it', () => {
    expect(
      ConfigSchema.safeParse({ llm: { ...base, scoring: { modell: 'oops' } } }).success,
    ).toBe(false);
  });

  it('splits scoring and writing by default in the example config', () => {
    const config = ConfigSchema.parse(loadExample('config.example.yaml'));
    const scoring = resolveLlmConfig(config.llm, 'scoring');
    const writing = resolveLlmConfig(config.llm, 'writing');

    expect(scoring.model).not.toBe(writing.model);
    expect(scoring.effort).toBe('low');
  });
});

describe('companies.example.yaml — the seeded board list', () => {
  it('carries enough boards to make a 48h window useful', () => {
    const companies = CompaniesFileSchema.parse(loadExample('companies.example.yaml'));
    expect(companies.boards.filter((board) => board.enabled).length).toBeGreaterThanOrEqual(15);
  });

  it('has no duplicate tokens within a source', () => {
    // Also enforced by the schema; asserted here so the failure message names
    // the example file rather than a generic validation error.
    const companies = CompaniesFileSchema.parse(loadExample('companies.example.yaml'));
    const keys = companies.boards.map((board) => `${board.source}:${board.token}`);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
