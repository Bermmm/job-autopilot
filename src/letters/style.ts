import type { Profile } from '../config/profile.schema.js';

/**
 * The "does this read like a human wrote it" check.
 *
 * Grounding catches invented facts. It does not catch a letter that invents
 * nothing and still reads like a language model: "world-class expert",
 * "absolute rockstar", "I am writing to apply for". Those are honest and
 * unsendable, so they are checked separately.
 *
 * Two sources: a built-in list of the usual tells, and any term the profile's
 * `voiceNotes` puts in quotes — so "Never say 'passionate' or 'rockstar'"
 * becomes an enforced rule rather than a hopeful instruction.
 */

export interface StyleIssue {
  kind: 'style';
  token: string;
  detail: string;
}

/**
 * Phrases that mark machine-written prose. Multi-word entries are matched as
 * phrases; single words on word boundaries.
 */
const AI_TELLS: readonly string[] = [
  'i am writing to apply',
  'i am writing to express',
  'i am excited to apply',
  'thrilled',
  'passionate',
  'passion for',
  'leverage',
  'synergy',
  'synergies',
  'rockstar',
  'rock star',
  'ninja',
  'guru',
  'wheelhouse',
  'delve',
  'tapestry',
  'testament to',
  'pivotal',
  'seamless',
  'seamlessly',
  'cutting-edge',
  'game-changer',
  'game changer',
  'best-in-class',
  'world-class',
  'world class',
  'spearheaded',
  'meticulous',
  'meticulously',
  'in today',
  'fast-paced',
  'ever-evolving',
  'ever-changing',
  'holistic',
  'paradigm',
  'move the needle',
  'low-hanging fruit',
  'think outside the box',
  'circle back',
  'touch base',
  'deep dive',
  'furthermore',
  'moreover',
  'it is worth noting',
  'navigate the',
  'landscape of',
  'align with my',
  'perfect fit',
  'ideal candidate',
  'proven track record',
  'results-driven',
  'self-starter',
  'go-getter',
  'dynamic environment',
  'value-add',
  'at the end of the day',
  'look forward to hearing',
];

/** Pulls quoted terms out of the profile's voiceNotes. */
export function bannedTermsFromProfile(profile: Profile): string[] {
  const terms: string[] = [];
  for (const note of profile.voiceNotes) {
    for (const match of note.matchAll(/["“'‘]([^"”'’]{2,40})["”'’]/g)) {
      const term = match[1]?.trim().toLowerCase();
      if (term && term.length >= 2) terms.push(term);
    }
  }
  return [...new Set(terms)];
}

/** Every phrase a letter must avoid, for this profile. */
export function bannedTerms(profile: Profile): string[] {
  return [...new Set([...AI_TELLS, ...bannedTermsFromProfile(profile)])];
}

export function checkStyle(body: string, profile: Profile): StyleIssue[] {
  const issues: StyleIssue[] = [];
  const haystack = body.toLowerCase();

  for (const term of bannedTerms(profile)) {
    const pattern = inflectedPattern(term);
    if (pattern.test(haystack)) {
      issues.push({
        kind: 'style',
        token: term,
        detail: `The letter uses "${term}", which reads as filler. Say the thing plainly or cut it.`,
      });
    }
  }

  return issues;
}

/**
 * Matches a term and its common inflections.
 *
 * A boundary before the term, so "passionate" does not fire on
 * "compassionate". After it, inflections are allowed — and a trailing "e" is
 * made optional, because "leveraging" drops it and is the same tell as
 * "leverage". Listing every verb form by hand would guarantee gaps.
 */
function inflectedPattern(term: string): RegExp {
  const escape = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const stem = term.endsWith('e') ? `${escape(term.slice(0, -1))}e?` : escape(term);
  return new RegExp(`(^|[^a-z0-9])${stem}(?:s|es|d|ed|ing|ly)?([^a-z0-9]|$)`, 'i');
}

/** Soft length guidance, reported rather than enforced. */
export function wordCount(body: string): number {
  return body.trim().split(/\s+/).filter((word) => word.length > 0).length;
}
