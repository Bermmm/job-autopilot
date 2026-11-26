import type { Profile } from '../config/profile.schema.js';
import type { Job } from '../db/types.js';
import type { RedFlag } from './schema.js';

/**
 * Red flags that are facts rather than judgments.
 *
 * Asking a model "does this posting contain a phrase the user said they will
 * not accept?" is asking it to do a substring search, and it will occasionally
 * get it wrong. These checks are cheap, exact, and always run — the model is
 * left to the things that genuinely need reading comprehension, like whether
 * a posting's seniority matches the work history.
 *
 * All of these are *stated* mismatches. None of them cap the score on their
 * own; they inform it, and the dashboard shows them.
 */

export interface DeterministicFindings {
  redFlags: RedFlag[];
  /** Deal-breakers are the one thing that forces a low score. */
  dealBreakerHit: string | null;
}

export function applyRules(profile: Profile, job: Job): DeterministicFindings {
  const redFlags: RedFlag[] = [];
  const haystack = `${job.title}\n${job.description ?? ''}`.toLowerCase();

  // Deal-breakers: the user said in their own words that these are out.
  let dealBreakerHit: string | null = null;
  for (const phrase of profile.preferences.dealBreakers) {
    if (haystack.includes(phrase.toLowerCase())) {
      dealBreakerHit ??= phrase;
      redFlags.push({
        kind: 'other',
        detail: `Posting mentions "${phrase}", listed as a deal-breaker in your profile.`,
      });
    }
  }

  // Remote-only against a posting the board itself does not call remote.
  if (profile.preferences.remoteOnly && !job.remote) {
    redFlags.push({
      kind: 'location',
      detail: `You set remoteOnly, and this posting is listed as ${job.location ?? 'on-site'}.`,
    });
  }

  // Technologies the user explicitly does not want to work with.
  for (const skill of profile.skills.avoid) {
    if (containsTerm(haystack, skill)) {
      redFlags.push({
        kind: 'other',
        detail: `Posting involves ${skill}, which your profile lists under skills.avoid.`,
      });
    }
  }

  // Years of experience, where the posting states a number plainly.
  const required = extractYearsRequired(job.description ?? '');
  if (required !== null && required > profile.yearsExperience) {
    redFlags.push({
      kind: 'years',
      detail: `Posting asks for ${required} years; your profile states ${profile.yearsExperience}.`,
    });
  }

  return { redFlags, dealBreakerHit };
}

/** Whole-term match, so "R" does not match "React" and "Go" not "Google". */
function containsTerm(haystack: string, term: string): boolean {
  const escaped = term.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, 'i').test(haystack);
}

/**
 * The smallest "N+ years" figure a posting states.
 *
 * Smallest, because postings often list a floor and a nice-to-have ("3+ years
 * required, 5+ preferred"), and the floor is the one that gates an
 * application. Only clearly-worded numbers are read; anything ambiguous is
 * left for the model rather than guessed at here.
 */
export function extractYearsRequired(description: string): number | null {
  if (!description) return null;

  const patterns = [
    // "5+ years", "5 - 7 years", "5 to 7 years of experience"
    /(\d{1,2})\s*\+?\s*(?:-|–|to)?\s*\d{0,2}\s*years?(?:['’]?\s*)?(?:\s+of)?\s+(?:relevant\s+|professional\s+|industry\s+|hands-on\s+)?experience/gi,
    // "minimum of 5 years", "at least 5 years"
    /(?:minimum(?:\s+of)?|at\s+least)\s+(\d{1,2})\s*\+?\s*years?/gi,
    // "3+ years required" / "5+ years preferred" — the explicit "+" is what
    // marks this as a floor rather than a passing mention of a duration.
    /(\d{1,2})\s*\+\s*years?\b/gi,
  ];

  const found: number[] = [];
  for (const pattern of patterns) {
    for (const match of description.matchAll(pattern)) {
      const value = Number(match[1]);
      // Above ~25 years it is almost always a company age or a typo.
      if (Number.isInteger(value) && value > 0 && value <= 25) found.push(value);
    }
  }

  return found.length === 0 ? null : Math.min(...found);
}

/**
 * Merges the model's red flags with the deterministic ones, dropping
 * duplicates so the dashboard does not show the same problem twice.
 */
export function mergeRedFlags(fromModel: RedFlag[], fromRules: RedFlag[]): RedFlag[] {
  const merged = [...fromRules];
  const seen = new Set(fromRules.map((flag) => `${flag.kind}:${normalise(flag.detail)}`));

  for (const flag of fromModel) {
    const key = `${flag.kind}:${normalise(flag.detail)}`;
    // A rules-derived flag of the same kind already covers this ground.
    if (seen.has(key)) continue;
    if (fromRules.some((rule) => rule.kind === flag.kind && flag.kind === 'years')) continue;
    seen.add(key);
    merged.push(flag);
  }

  return merged.slice(0, 8);
}

function normalise(detail: string): string {
  return detail.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}
