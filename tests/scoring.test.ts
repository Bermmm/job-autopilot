import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

import { ConfigSchema } from '../src/config/config.schema.js';
import { ProfileSchema, type Profile } from '../src/config/profile.schema.js';
import { resolveFromRoot } from '../src/config/load.js';
import { openDatabase } from '../src/db/index.js';
import { Repo } from '../src/db/repo.js';
import type { Job } from '../src/db/types.js';
import { renderProfileForPrompt } from '../src/profile/view.js';
import { applyRules, extractYearsRequired, mergeRedFlags } from '../src/scoring/rules.js';
import { buildScorePrompt, SCORE_SYSTEM_PROMPT } from '../src/scoring/prompt.js';
import { ScoreResultSchema, bandFor, type RedFlag } from '../src/scoring/schema.js';
import { DEAL_BREAKER_CEILING, finaliseScore, scoreJob } from '../src/scoring/score.js';
import type { LlmClient, StructuredRequest, TextRequest } from '../src/llm/types.js';
import { LlmError } from '../src/util/errors.js';

const profile: Profile = ProfileSchema.parse(
  parseYaml(readFileSync(resolveFromRoot('profile.example.yaml'), 'utf8')),
);

const config = ConfigSchema.parse({ llm: { model: 'test-model' } });

function job(overrides: Partial<Job> = {}): Job {
  return {
    id: 'job-1',
    source: 'greenhouse',
    externalId: '1',
    company: 'Acme',
    companySlug: 'acme',
    title: 'Senior Backend Engineer',
    titleNormalized: 'backend engineer senior',
    dedupeKey: 'acme::backend engineer senior',
    location: 'Remote (EU)',
    remote: true,
    url: 'https://example.com/1',
    description: 'We need someone to own our Postgres and queue infrastructure.',
    postedAt: '2026-11-26T09:00:00.000Z',
    postedAtSource: 'board',
    firstSeenAt: '2026-11-26T10:00:00.000Z',
    lastSeenAt: '2026-11-26T10:00:00.000Z',
    ...overrides,
  };
}

/** An LlmClient that returns a canned score and records what it was sent. */
function stubLlm(result: unknown) {
  const structuredCalls: StructuredRequest<z.ZodType>[] = [];
  const client: LlmClient = {
    provider: 'anthropic',
    model: 'stub-model',
    async complete(request: TextRequest) {
      return {
        value: '',
        usage: { inputTokens: null, outputTokens: null },
        model: 'stub-model',
        provider: 'anthropic' as const,
      };
    },
    async completeStructured<T extends z.ZodType>(request: StructuredRequest<T>) {
      structuredCalls.push(request as StructuredRequest<z.ZodType>);
      const parsed = request.schema.safeParse(result);
      if (!parsed.success) {
        throw new LlmError('stub result failed schema validation', { retryable: false });
      }
      return {
        value: parsed.data as z.infer<T>,
        usage: { inputTokens: 1_200, outputTokens: 180 },
        model: 'stub-model',
        provider: 'anthropic' as const,
      };
    },
  };
  return { client, structuredCalls };
}

const goodResult = {
  score: 82,
  summary: 'Strong overlap on Postgres and queue work.',
  reasons: ['Posting wants Postgres ownership; profile shows a 40M-row migration.'],
  redFlags: [] as RedFlag[],
};

describe('profile rendering — privacy', () => {
  const rendered = renderProfileForPrompt(profile, { includeConstraints: true });

  it('never includes the email address', () => {
    expect(rendered).not.toContain(profile.contact.email);
    expect(rendered).not.toMatch(/@/);
  });

  it('never includes the phone number', () => {
    expect(rendered).not.toContain(profile.contact.phone!);
  });

  it('never includes personal links', () => {
    for (const link of profile.contact.links) {
      expect(rendered).not.toContain(link.url);
    }
    expect(rendered).not.toMatch(/https?:\/\//);
  });

  it('keeps the same omissions in the whole scoring prompt', () => {
    const prompt = buildScorePrompt({ profile, job: job() });
    expect(prompt).not.toContain(profile.contact.email);
    expect(prompt).not.toContain(profile.contact.phone!);
    for (const link of profile.contact.links) {
      expect(prompt).not.toContain(link.url);
    }
  });

  it('still includes what scoring actually needs', () => {
    expect(rendered).toContain(profile.name);
    expect(rendered).toContain(profile.headline);
    expect(rendered).toContain(String(profile.yearsExperience));
    expect(rendered).toContain(profile.contact.location);
    expect(rendered).toContain(profile.workAuthorization);
    expect(rendered).toContain(profile.roles[0]!.company);
    expect(rendered).toContain(profile.roles[0]!.highlights[0]!);
    expect(rendered).toContain(profile.skills.strong[0]!);
  });

  it('labels every fact with the profile field it came from', () => {
    // These tags are what let the letter generator cite its sources.
    expect(rendered).toMatch(/\[roles\.0\]/);
    expect(rendered).toMatch(/\[roles\.0\.highlights\.0\]/);
    expect(rendered).toMatch(/\[skills\.strong\]/);
  });

  it('marks shallower skills as shallower, so they are not oversold', () => {
    expect(rendered).toMatch(/shallower experience: .*Python/);
  });

  it('is deterministic, so prompt caching works', () => {
    expect(renderProfileForPrompt(profile, { includeConstraints: true })).toBe(rendered);
  });

  it('omits constraints unless asked for them', () => {
    const letterView = renderProfileForPrompt(profile);
    expect(letterView).not.toContain('Constraints');
    expect(letterView).not.toContain(String(profile.salary.minimum));
  });

  it('includes salary and deal-breakers when scoring', () => {
    expect(rendered).toContain(String(profile.salary.minimum));
    expect(rendered).toContain(profile.preferences.dealBreakers[0]!);
  });
});

describe('buildScorePrompt', () => {
  it('includes the posting and its metadata', () => {
    const prompt = buildScorePrompt({ profile, job: job() });
    expect(prompt).toContain('Acme');
    expect(prompt).toContain('Senior Backend Engineer');
    expect(prompt).toContain('Remote (EU)');
    expect(prompt).toContain('own our Postgres and queue infrastructure');
  });

  it('says so plainly when a board published no description', () => {
    const prompt = buildScorePrompt({ profile, job: job({ description: null }) });
    expect(prompt).toMatch(/published no description/);
  });

  it('treats a whitespace-only description as missing', () => {
    const prompt = buildScorePrompt({ profile, job: job({ description: '   \n  ' }) });
    expect(prompt).toMatch(/published no description/);
  });
});

describe('SCORE_SYSTEM_PROMPT', () => {
  it('defines every score band so runs are comparable', () => {
    for (const band of ['85-100', '70-84', '50-69', '25-49', '0-24']) {
      expect(SCORE_SYSTEM_PROMPT).toContain(band);
    }
  });

  it('forbids crediting unstated experience', () => {
    expect(SCORE_SYSTEM_PROMPT).toMatch(/[Nn]ever credit/);
  });

  it('allows an empty red-flag list, so flags are not invented to fill space', () => {
    expect(SCORE_SYSTEM_PROMPT).toMatch(/empty list/i);
  });
});

describe('extractYearsRequired', () => {
  it('reads the common phrasings', () => {
    expect(extractYearsRequired('5+ years of experience required')).toBe(5);
    expect(extractYearsRequired('8 years experience in backend systems')).toBe(8);
    expect(extractYearsRequired('At least 10 years of relevant experience')).toBe(10);
    expect(extractYearsRequired('Minimum of 6 years professional experience')).toBe(6);
    expect(extractYearsRequired("7 years' experience")).toBe(7);
  });

  it('takes the floor when a posting states a range', () => {
    // The floor is what gates an application; the preferred figure does not.
    expect(extractYearsRequired('3-5 years of experience')).toBe(3);
    expect(extractYearsRequired('3+ years required, 5+ years preferred')).toBe(3);
  });

  it('returns null when no figure is stated', () => {
    expect(extractYearsRequired('We want a seasoned engineer.')).toBeNull();
    expect(extractYearsRequired('')).toBeNull();
  });

  it('ignores figures that are obviously not experience requirements', () => {
    expect(extractYearsRequired('Founded 40 years ago')).toBeNull();
    expect(extractYearsRequired('Our 150 years of history')).toBeNull();
  });
});

describe('applyRules', () => {
  it('flags a deal-breaker the user named', () => {
    const findings = applyRules(
      profile,
      job({ description: 'Compensation is equity only for the first year.' }),
    );
    expect(findings.dealBreakerHit).toBe('equity only');
    expect(findings.redFlags.some((flag) => flag.detail.includes('equity only'))).toBe(true);
  });

  it('flags a remote-only mismatch', () => {
    const remoteOnly = { ...profile, preferences: { ...profile.preferences, remoteOnly: true } };
    const findings = applyRules(remoteOnly, job({ remote: false, location: 'Berlin' }));
    expect(findings.redFlags.some((flag) => flag.kind === 'location')).toBe(true);
  });

  it('does not flag location when the posting is remote', () => {
    const remoteOnly = { ...profile, preferences: { ...profile.preferences, remoteOnly: true } };
    const findings = applyRules(remoteOnly, job({ remote: true }));
    expect(findings.redFlags.some((flag) => flag.kind === 'location')).toBe(false);
  });

  it('flags a years requirement above the profile', () => {
    const findings = applyRules(
      profile,
      job({ description: 'We require 12+ years of experience.' }),
    );
    const flag = findings.redFlags.find((f) => f.kind === 'years');
    expect(flag?.detail).toMatch(/12 years/);
    expect(flag?.detail).toMatch(/7/);
  });

  it('does not flag a years requirement the profile meets', () => {
    const findings = applyRules(profile, job({ description: '5+ years of experience.' }));
    expect(findings.redFlags.some((flag) => flag.kind === 'years')).toBe(false);
  });

  it('flags a technology the profile says to avoid', () => {
    const findings = applyRules(
      profile,
      job({ description: 'This role is primarily Salesforce development.' }),
    );
    expect(findings.redFlags.some((flag) => /Salesforce/i.test(flag.detail))).toBe(true);
  });

  it('matches whole terms only, so "Go" does not match "Google"', () => {
    const goAvoider = { ...profile, skills: { ...profile.skills, avoid: ['Go'] } };
    const findings = applyRules(goAvoider, job({ description: 'We use Google Cloud heavily.' }));
    expect(findings.redFlags).toHaveLength(0);

    const hit = applyRules(goAvoider, job({ description: 'Backend written in Go.' }));
    expect(hit.redFlags).toHaveLength(1);
  });

  it('finds nothing to flag on a clean posting', () => {
    const findings = applyRules(profile, job());
    expect(findings.redFlags).toHaveLength(0);
    expect(findings.dealBreakerHit).toBeNull();
  });

  it('searches the title as well as the description', () => {
    // The example profile's avoid entry is the phrase "Salesforce
    // development", so the title has to contain that phrase, not just the
    // product name — which is the behaviour we want from a whole-term match.
    const findings = applyRules(
      profile,
      job({ title: 'Salesforce Development Lead', description: '' }),
    );
    expect(findings.redFlags.some((flag) => /Salesforce/i.test(flag.detail))).toBe(true);
  });

  it('does not flag a near-miss of an avoided phrase', () => {
    // "Salesforce Developer" is not "Salesforce development". Whether that
    // should flag is a judgment call, which is the model's job, not a rule's.
    const findings = applyRules(profile, job({ title: 'Salesforce Developer', description: '' }));
    expect(findings.redFlags).toHaveLength(0);
  });
});

describe('mergeRedFlags', () => {
  it('keeps both sets when they differ', () => {
    const merged = mergeRedFlags(
      [{ kind: 'degree', detail: 'Requires a PhD.' }],
      [{ kind: 'location', detail: 'Remote only mismatch.' }],
    );
    expect(merged).toHaveLength(2);
  });

  it('drops a model flag duplicating a rules flag', () => {
    const merged = mergeRedFlags(
      [{ kind: 'location', detail: 'remote-only mismatch' }],
      [{ kind: 'location', detail: 'Remote only mismatch.' }],
    );
    expect(merged).toHaveLength(1);
  });

  it('prefers the rules figure for years, which is exact', () => {
    const merged = mergeRedFlags(
      [{ kind: 'years', detail: 'Wants about a decade of experience.' }],
      [{ kind: 'years', detail: 'Posting asks for 12 years; your profile states 7.' }],
    );
    expect(merged).toHaveLength(1);
    expect(merged[0]!.detail).toMatch(/12 years/);
  });

  it('puts rules flags first and caps the list', () => {
    const many: RedFlag[] = Array.from({ length: 12 }, (_, i) => ({
      kind: 'other',
      detail: `model flag ${i}`,
    }));
    const merged = mergeRedFlags(many, [{ kind: 'salary', detail: 'Below your minimum.' }]);
    expect(merged[0]!.kind).toBe('salary');
    expect(merged.length).toBeLessThanOrEqual(8);
  });
});

describe('finaliseScore', () => {
  it('passes a clean score through untouched', () => {
    const result = finaliseScore(job(), goodResult, applyRules(profile, job()), {
      provider: 'anthropic',
      model: 'm',
      inputTokens: 100,
      outputTokens: 20,
    });
    expect(result.score).toBe(82);
    expect(result.cappedByDealBreaker).toBe(false);
  });

  it('caps an enthusiastic score when a deal-breaker is present', () => {
    const posting = job({ description: 'Compensation: equity only.' });
    const result = finaliseScore(
      posting,
      { ...goodResult, score: 95 },
      applyRules(profile, posting),
      { provider: 'anthropic', model: 'm', inputTokens: null, outputTokens: null },
    );

    expect(result.score).toBeLessThanOrEqual(DEAL_BREAKER_CEILING);
    expect(result.cappedByDealBreaker).toBe(true);
    expect(result.reasons[0]).toMatch(/capped/i);
  });

  it('does not raise a score that was already below the cap', () => {
    const posting = job({ description: 'Compensation: equity only.' });
    const result = finaliseScore(
      posting,
      { ...goodResult, score: 4 },
      applyRules(profile, posting),
      { provider: 'anthropic', model: 'm', inputTokens: null, outputTokens: null },
    );
    expect(result.score).toBe(4);
  });

  it('keeps reasons within the schema limit after prepending the cap note', () => {
    const posting = job({ description: 'Compensation: equity only.' });
    const result = finaliseScore(
      posting,
      { ...goodResult, score: 90, reasons: ['a', 'b', 'c', 'd', 'e'] },
      applyRules(profile, posting),
      { provider: 'anthropic', model: 'm', inputTokens: null, outputTokens: null },
    );
    expect(result.reasons).toHaveLength(5);
    expect(ScoreResultSchema.shape.reasons.safeParse(result.reasons).success).toBe(true);
  });

  it('records the prompt version, so scores are never compared across prompts', () => {
    const result = finaliseScore(job(), goodResult, applyRules(profile, job()), {
      provider: 'anthropic',
      model: 'm',
      inputTokens: null,
      outputTokens: null,
    });
    expect(result.promptVersion).toMatch(/^score-v\d+$/);
  });
});

describe('scoreJob', () => {
  it('scores a posting and reports the model that served it', async () => {
    const { client, structuredCalls } = stubLlm(goodResult);
    const result = await scoreJob({ job: job(), profile, config, llm: client });

    expect(result.score).toBe(82);
    expect(result.model).toBe('stub-model');
    expect(result.inputTokens).toBe(1_200);
    expect(structuredCalls).toHaveLength(1);
    expect(structuredCalls[0]!.schemaName).toBe('FitScore');
  });

  it('rejects a model result outside the schema rather than storing it', async () => {
    const { client } = stubLlm({ ...goodResult, score: 140 });
    await expect(scoreJob({ job: job(), profile, config, llm: client })).rejects.toThrow(LlmError);
  });

  it('rejects a result with no reasons', async () => {
    const { client } = stubLlm({ ...goodResult, reasons: [] });
    await expect(scoreJob({ job: job(), profile, config, llm: client })).rejects.toThrow(LlmError);
  });

  it('accepts a result with no red flags', async () => {
    const { client } = stubLlm({ ...goodResult, redFlags: [] });
    const result = await scoreJob({ job: job(), profile, config, llm: client });
    expect(result.redFlags).toHaveLength(0);
  });
});

describe('ScoreResultSchema', () => {
  it('rejects a non-integer score', () => {
    expect(ScoreResultSchema.safeParse({ ...goodResult, score: 82.5 }).success).toBe(false);
  });

  it('rejects an unknown red-flag kind', () => {
    expect(
      ScoreResultSchema.safeParse({
        ...goodResult,
        redFlags: [{ kind: 'vibes', detail: 'x' }],
      }).success,
    ).toBe(false);
  });

  it('rejects extra fields, so a drifting model output is caught', () => {
    expect(ScoreResultSchema.safeParse({ ...goodResult, confidence: 0.9 }).success).toBe(false);
  });
});

describe('bandFor', () => {
  it('labels each band', () => {
    expect(bandFor(100).label).toBe('strong');
    expect(bandFor(85).label).toBe('strong');
    expect(bandFor(84).label).toBe('good');
    expect(bandFor(70).label).toBe('good');
    expect(bandFor(69).label).toBe('partial');
    expect(bandFor(25).label).toBe('weak');
    expect(bandFor(0).label).toBe('no');
  });
});

describe('scores in the database', () => {
  it('appends rather than overwriting, so a letter can name its score', () => {
    const db = openDatabase({ path: ':memory:' });
    const repo = new Repo(db);
    const stored = repo.upsertJob({
      source: 'greenhouse',
      externalId: '1',
      company: 'Acme',
      title: 'Senior Backend Engineer',
      url: 'https://example.com/1',
      postedAt: '2026-11-26T09:00:00.000Z',
    }).job;

    for (const [score, version] of [
      [60, 'score-v1'],
      [82, 'score-v2'],
    ] as const) {
      repo.insertScore({
        jobId: stored.id,
        score,
        reasons: ['r'],
        redFlags: [],
        provider: 'anthropic',
        model: 'm',
        promptVersion: version,
      });
    }

    expect(repo.getLatestScore(stored.id)?.score).toBe(82);
    expect(repo.getLatestScore(stored.id)?.promptVersion).toBe('score-v2');
    expect(repo.listUnscoredJobs()).toHaveLength(0);
    db.close();
  });
});
