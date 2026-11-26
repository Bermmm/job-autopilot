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
import { draftLetter } from '../src/letters/draft.js';
import { letterSystemPrompt, buildLetterPrompt } from '../src/letters/prompt.js';
import { LetterResultSchema } from '../src/letters/schema.js';
import { draft } from '../src/cli/draft.js';
import type { LlmClient, StructuredRequest } from '../src/llm/types.js';
import { LlmError } from '../src/util/errors.js';

const profile: Profile = ProfileSchema.parse(
  parseYaml(readFileSync(resolveFromRoot('profile.example.yaml'), 'utf8')),
);
const config = ConfigSchema.parse({
  llm: { model: 'test-model' },
  paths: { letters: './data/test-letters' },
});

const job: Job = {
  id: 'job-1',
  source: 'greenhouse',
  externalId: '1',
  company: 'Northstar Data',
  companySlug: 'northstar-data',
  title: 'Senior Backend Engineer',
  titleNormalized: 'backend engineer senior',
  dedupeKey: 'northstar-data::backend engineer senior',
  location: 'Remote (EU)',
  remote: true,
  url: 'https://example.com/jobs/1',
  description: 'You will own reliability and the migration off our legacy MySQL cluster.',
  postedAt: '2026-11-26T09:00:00.000Z',
  postedAtSource: 'board',
  firstSeenAt: '2026-11-26T10:00:00.000Z',
  lastSeenAt: '2026-11-26T10:00:00.000Z',
};

const GOOD_BODY = `Dear Northstar Data team,

Your posting mentions the migration off a legacy MySQL cluster. At Northwind Logistics
I migrated 40 million rows from MySQL to Postgres with no downtime and no data loss.

I also ran the on-call rotation for 6 engineers and brought monthly pages down from 31 to 9.

Jordan Avery`;

const BAD_BODY = `Dear Northstar Data team,

At Globex Corporation I cut infrastructure costs by 35% and I am passionate about
leveraging cutting-edge solutions.

Jordan Avery`;

const GOOD_CITATIONS = [
  {
    field: 'roles.0.highlights.3',
    value: 'Migrated 40 million rows from MySQL to Postgres with no downtime',
  },
];

/** Returns a scripted sequence of letters, one per attempt. */
function scriptedLlm(sequence: Array<{ body: string; factsUsed: typeof GOOD_CITATIONS }>) {
  const prompts: string[] = [];
  let call = 0;

  const client: LlmClient = {
    provider: 'anthropic',
    model: 'stub-model',
    async complete() {
      throw new Error('not used');
    },
    async completeStructured<T extends z.ZodType>(request: StructuredRequest<T>) {
      prompts.push(request.prompt);
      const next = sequence[Math.min(call, sequence.length - 1)]!;
      call += 1;
      const parsed = request.schema.safeParse(next);
      if (!parsed.success) throw new LlmError('stub failed schema', { retryable: false });
      return {
        value: parsed.data as z.infer<T>,
        usage: { inputTokens: 900, outputTokens: 220 },
        model: 'stub-model',
        provider: 'anthropic' as const,
      };
    },
  };

  return { client, prompts, get calls() { return call; } };
}

function freshRepo(): { repo: Repo; close: () => void } {
  const db = openDatabase({ path: ':memory:' });
  const repo = new Repo(db);
  repo.upsertJob({
    source: job.source,
    externalId: job.externalId,
    companyKey: 'northstar-data',
    company: job.company,
    title: job.title,
    location: job.location,
    remote: job.remote,
    url: job.url,
    description: job.description,
    postedAt: job.postedAt,
  });
  return { repo, close: () => db.close() };
}

function storedJob(repo: Repo): Job {
  return repo.listJobs({ limit: 1 })[0]!;
}

function addScore(repo: Repo, jobId: string, value: number): void {
  repo.insertScore({
    jobId,
    score: value,
    reasons: ['r'],
    redFlags: [],
    summary: 'A summary.',
    provider: 'anthropic',
    model: 'm',
    promptVersion: 'score-v1',
  });
}

describe('letterSystemPrompt', () => {
  it('states the no-invented-facts rule', () => {
    const prompt = letterSystemPrompt(profile);
    expect(prompt).toMatch(/only facts from the candidate profile and the job posting/i);
  });

  it('forbids placeholders', () => {
    expect(letterSystemPrompt(profile)).toMatch(/\[Company\]/);
  });

  it('lists the banned terms, including the ones the profile itself names', () => {
    const prompt = letterSystemPrompt(profile);
    expect(prompt).toContain('"rockstar"');
    expect(prompt).toContain('"passionate"');
  });

  it('includes the voice notes from the profile', () => {
    expect(letterSystemPrompt(profile)).toContain(profile.voiceNotes[0]!);
  });

  it('asks for citations by field tag', () => {
    expect(letterSystemPrompt(profile)).toMatch(/roles\.0\.highlights\.1/);
  });
});

describe('buildLetterPrompt', () => {
  it('omits constraints — a letter has no business quoting salary rules', () => {
    const prompt = buildLetterPrompt({ profile, job });
    expect(prompt).not.toContain('Constraints');
    expect(prompt).not.toContain(String(profile.salary.minimum));
  });

  it('still omits contact details', () => {
    const prompt = buildLetterPrompt({ profile, job });
    expect(prompt).not.toContain(profile.contact.email);
    expect(prompt).not.toContain(profile.contact.phone!);
  });
});

describe('draftLetter', () => {
  it('returns a grounded letter on the first attempt', async () => {
    const { client } = scriptedLlm([{ body: GOOD_BODY, factsUsed: GOOD_CITATIONS }]);
    const letter = await draftLetter({ job, profile, config, llm: client });

    expect(letter.grounded).toBe(true);
    expect(letter.attempts).toBe(1);
    expect(letter.issues).toEqual([]);
    expect(letter.words).toBeGreaterThan(20);
  });

  it('regenerates after a failed check and succeeds', async () => {
    const { client, prompts } = scriptedLlm([
      { body: BAD_BODY, factsUsed: GOOD_CITATIONS },
      { body: GOOD_BODY, factsUsed: GOOD_CITATIONS },
    ]);
    const letter = await draftLetter({ job, profile, config, llm: client });

    expect(letter.grounded).toBe(true);
    expect(letter.attempts).toBe(2);
    expect(prompts).toHaveLength(2);
  });

  it('tells the model exactly what failed, rather than asking it to try again', async () => {
    const { client, prompts } = scriptedLlm([
      { body: BAD_BODY, factsUsed: GOOD_CITATIONS },
      { body: GOOD_BODY, factsUsed: GOOD_CITATIONS },
    ]);
    await draftLetter({ job, profile, config, llm: client });

    const retry = prompts[1]!;
    expect(retry).toMatch(/was rejected/i);
    expect(retry).toContain('Globex');
    expect(retry).toContain('35');
    expect(retry).toMatch(/passionate/);
    // And it must not suggest fixing a fact with another fact.
    expect(retry).toMatch(/cut the claim instead/i);
  });

  it('gives up rather than returning an ungrounded letter as if it passed', async () => {
    const { client } = scriptedLlm([{ body: BAD_BODY, factsUsed: GOOD_CITATIONS }]);
    const letter = await draftLetter({ job, profile, config, llm: client });

    expect(letter.grounded).toBe(false);
    expect(letter.attempts).toBe(2);
    expect(letter.issues.length).toBeGreaterThan(0);
  });

  it('counts tokens across every attempt', async () => {
    const { client } = scriptedLlm([
      { body: BAD_BODY, factsUsed: GOOD_CITATIONS },
      { body: GOOD_BODY, factsUsed: GOOD_CITATIONS },
    ]);
    const letter = await draftLetter({ job, profile, config, llm: client });
    expect(letter.inputTokens).toBe(1_800);
  });

  it('rejects a body too short to be a letter', async () => {
    const { client } = scriptedLlm([{ body: 'No thanks.', factsUsed: GOOD_CITATIONS }]);
    await expect(draftLetter({ job, profile, config, llm: client })).rejects.toThrow(LlmError);
  });

  it('rejects a result with no citations at all', async () => {
    const { client } = scriptedLlm([{ body: GOOD_BODY, factsUsed: [] }]);
    await expect(draftLetter({ job, profile, config, llm: client })).rejects.toThrow(LlmError);
  });

  it('catches a bad citation even when the prose is clean', async () => {
    const { client } = scriptedLlm([
      { body: GOOD_BODY, factsUsed: [{ field: 'roles.9.highlights.0', value: 'Invented.' }] },
    ]);
    const letter = await draftLetter({ job, profile, config, llm: client, maxAttempts: 1 });

    expect(letter.grounded).toBe(false);
    expect(letter.issues.some((issue) => issue.kind === 'citation')).toBe(true);
  });
});

describe('LetterResultSchema', () => {
  it('rejects extra fields, catching output drift', () => {
    const result = LetterResultSchema.safeParse({
      body: GOOD_BODY,
      factsUsed: GOOD_CITATIONS,
      confidence: 0.9,
    });
    expect(result.success).toBe(false);
  });

  it('caps the citation list', () => {
    const many = Array.from({ length: 20 }, () => GOOD_CITATIONS[0]!);
    expect(LetterResultSchema.safeParse({ body: GOOD_BODY, factsUsed: many }).success).toBe(false);
  });
});

describe('draft command gates', () => {
  it('refuses an unknown job id', async () => {
    const { repo, close } = freshRepo();
    const { client } = scriptedLlm([{ body: GOOD_BODY, factsUsed: GOOD_CITATIONS }]);

    const code = await draft(config, profile, repo, client, { jobId: 'nope' });
    expect(code).toBe(1);
    close();
  });

  it('refuses an unscored posting unless forced', async () => {
    const { repo, close } = freshRepo();
    const stored = storedJob(repo);
    const stub = scriptedLlm([{ body: GOOD_BODY, factsUsed: GOOD_CITATIONS }]);

    const code = await draft(config, profile, repo, stub.client, { jobId: stored.id });
    expect(code).toBe(1);
    // The gate must come before generation: no tokens spent on a posting we
    // were not going to apply to.
    expect(stub.calls).toBe(0);
    close();
  });

  it('drafts an unscored posting when forced', async () => {
    const { repo, close } = freshRepo();
    const stored = storedJob(repo);
    const stub = scriptedLlm([{ body: GOOD_BODY, factsUsed: GOOD_CITATIONS }]);

    expect(
      await draft(config, profile, repo, stub.client, { jobId: stored.id, force: true }),
    ).toBe(0);
    expect(stub.calls).toBe(1);
    close();
  });

  it('refuses a posting below minScoreToDraft', async () => {
    const { repo, close } = freshRepo();
    const stored = storedJob(repo);
    addScore(repo, stored.id, 40);
    const { client } = scriptedLlm([{ body: GOOD_BODY, factsUsed: GOOD_CITATIONS }]);

    expect(await draft(config, profile, repo, client, { jobId: stored.id })).toBe(1);
    close();
  });

  it('drafts a posting at or above the threshold', async () => {
    const { repo, close } = freshRepo();
    const stored = storedJob(repo);
    addScore(repo, stored.id, 82);
    const { client } = scriptedLlm([{ body: GOOD_BODY, factsUsed: GOOD_CITATIONS }]);

    expect(await draft(config, profile, repo, client, { jobId: stored.id })).toBe(0);

    const letter = repo.getLatestLetter(stored.id);
    expect(letter?.grounded).toBe(true);
    expect(letter?.factsUsed).toHaveLength(1);
    close();
  });

  it('moves the application to "drafted" and records the transition', async () => {
    const { repo, close } = freshRepo();
    const stored = storedJob(repo);
    addScore(repo, stored.id, 82);
    const { client } = scriptedLlm([{ body: GOOD_BODY, factsUsed: GOOD_CITATIONS }]);

    await draft(config, profile, repo, client, { jobId: stored.id });

    const application = repo.findApplicationByRole(stored.company, stored.title, stored.location);
    expect(application?.status).toBe('drafted');
    expect(repo.listApplicationEvents(application!.id).map((e) => e.toStatus)).toEqual([
      'found',
      'drafted',
    ]);
    close();
  });

  it('refuses to draft the same company and role twice', async () => {
    const { repo, close } = freshRepo();
    const stored = storedJob(repo);
    addScore(repo, stored.id, 82);
    const { client } = scriptedLlm([{ body: GOOD_BODY, factsUsed: GOOD_CITATIONS }]);

    expect(await draft(config, profile, repo, client, { jobId: stored.id })).toBe(0);
    // Second time: the never-twice rule.
    expect(await draft(config, profile, repo, client, { jobId: stored.id })).toBe(1);
    close();
  });

  it('refuses a second posting of the same role from another board', async () => {
    const { repo, close } = freshRepo();
    const stored = storedJob(repo);
    addScore(repo, stored.id, 82);
    const { client } = scriptedLlm([{ body: GOOD_BODY, factsUsed: GOOD_CITATIONS }]);
    await draft(config, profile, repo, client, { jobId: stored.id });

    // Same role, different board, different city, different spelling.
    const duplicate = repo.upsertJob({
      source: 'lever',
      externalId: 'other',
      companyKey: 'northstar-data',
      company: 'Northstar Data',
      title: 'Sr. Backend Engineer - Lisbon',
      location: 'Lisbon, Portugal',
      url: 'https://example.com/other',
      description: job.description,
      postedAt: job.postedAt,
    }).job;
    addScore(repo, duplicate.id, 90);

    expect(await draft(config, profile, repo, client, { jobId: duplicate.id })).toBe(1);
    close();
  });

  it('allows a deliberate second draft with --again', async () => {
    const { repo, close } = freshRepo();
    const stored = storedJob(repo);
    addScore(repo, stored.id, 82);
    const { client } = scriptedLlm([{ body: GOOD_BODY, factsUsed: GOOD_CITATIONS }]);

    await draft(config, profile, repo, client, { jobId: stored.id });
    expect(await draft(config, profile, repo, client, { jobId: stored.id, again: true })).toBe(0);
    close();
  });

  it('saves nothing when the letter fails its checks', async () => {
    const { repo, close } = freshRepo();
    const stored = storedJob(repo);
    addScore(repo, stored.id, 82);
    const { client } = scriptedLlm([{ body: BAD_BODY, factsUsed: GOOD_CITATIONS }]);

    expect(await draft(config, profile, repo, client, { jobId: stored.id })).toBe(1);
    expect(repo.getLatestLetter(stored.id)).toBeNull();

    // And the application must not claim to be drafted.
    const application = repo.findApplicationByRole(stored.company, stored.title, stored.location);
    expect(application).toBeNull();
    close();
  });
});
