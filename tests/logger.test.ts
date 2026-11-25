import { describe, expect, it } from 'vitest';

import { redact } from '../src/util/logger.js';

/**
 * The README promises secrets stay out of the repo and out of the logs.
 * The first half is the pre-commit hook's job; this is the second half.
 */

describe('redact', () => {
  it('hides an Anthropic key', () => {
    const line = 'request failed with key sk-ant-api03-AAAAbbbbCCCCddddEEEEffff1234';
    expect(redact(line)).not.toMatch(/sk-ant-api03-AAAA/);
    expect(redact(line)).toMatch(/\[redacted\]/);
  });

  it('hides an OpenAI key', () => {
    const line = 'using sk-proj-abcdefghijklmnopqrstuvwxyz0123456789';
    expect(redact(line)).not.toMatch(/abcdefghij/);
    expect(redact(line)).toMatch(/\[redacted\]/);
  });

  it('hides a bearer token', () => {
    expect(redact('Authorization: Bearer abcdef1234567890xyz')).toMatch(/\[redacted\]/);
  });

  it('leaves ordinary text alone', () => {
    const line = 'fetched 12 postings from greenhouse board "figma"';
    expect(redact(line)).toBe(line);
  });

  it('does not mangle a job URL', () => {
    const url = 'https://job-boards.greenhouse.io/figma/jobs/5091234';
    expect(redact(url)).toBe(url);
  });
});
