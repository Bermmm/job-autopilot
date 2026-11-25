import { createHash } from 'node:crypto';

/**
 * Normalisation used for duplicate detection.
 *
 * The rule is: never draft or apply to the same company and role twice.
 * "Same role" has to survive the ways boards actually spell things —
 * "Senior Software Engineer (Backend) - Berlin" and "Sr. Software Engineer,
 * Backend" are one job to a human, so they must collapse to one key here.
 *
 * Everything in this file is pure and synchronous so it can be tested
 * exhaustively without a database or a network.
 */

/** Strips accents so "Zürich" and "Zurich" agree. */
function removeDiacritics(value: string): string {
  return value.normalize('NFD').replace(/\p{Diacritic}/gu, '');
}

/** Abbreviations boards use interchangeably. Longest keys first when applied. */
const TITLE_SYNONYMS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bsr\.?\b/g, 'senior'],
  [/\bjr\.?\b/g, 'junior'],
  [/\bmgr\.?\b/g, 'manager'],
  [/\beng\.?\b/g, 'engineer'],
  [/\bdev\b/g, 'developer'],
  [/\bswe\b/g, 'software engineer'],
  [/\bsde\b/g, 'software engineer'],
  [/\bsre\b/g, 'site reliability engineer'],
  [/\bqa\b/g, 'quality assurance'],
  [/\bml\b/g, 'machine learning'],
  [/\bui\/ux\b/g, 'ui ux'],
  [/\bfe\b/g, 'frontend'],
  [/\bbe\b/g, 'backend'],
  [/\bfull[\s-]?stack\b/g, 'fullstack'],
  [/\bfront[\s-]?end\b/g, 'frontend'],
  [/\bback[\s-]?end\b/g, 'backend'],
];

/**
 * Noise words that describe the posting rather than the role. Dropping these
 * is what makes two listings of one job agree.
 */
const TITLE_NOISE = new Set([
  'a',
  'an',
  'and',
  'at',
  'contract',
  'f',
  'ftc',
  'full',
  'fulltime',
  'gmbh',
  'hybrid',
  'inc',
  'intern',
  'ltd',
  'm',
  'new',
  'of',
  'onsite',
  'open',
  'opening',
  'part',
  'parttime',
  'permanent',
  'position',
  'remote',
  'role',
  'temporary',
  'the',
  'to',
  'w',
  'x',
]);

/**
 * Words that describe the *posting* rather than the role, and so may be
 * stripped from a trailing bracket or separator. Anything else in that
 * position is kept: "Engineer (Platform)" and "Engineer (Mobile)" are
 * different jobs, and merging them would quietly skip one of them.
 */
const DECORATION_WORDS = new Set([
  'all',
  'any',
  'contract',
  'd',
  'div',
  'diverse',
  'eu',
  'f',
  'fixed',
  'full',
  'fulltime',
  'gender',
  'genders',
  'gn',
  'hybrid',
  'm',
  'n',
  'onsite',
  'part',
  'parttime',
  'permanent',
  'remote',
  'tbd',
  'temporary',
  'term',
  'time',
  'uk',
  'us',
  'w',
  'x',
]);

/** True when every word in `segment` is a posting decoration. */
function isAllDecoration(segment: string): boolean {
  const words = removeDiacritics(segment)
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 0);
  return words.length > 0 && words.every((word) => DECORATION_WORDS.has(word));
}

/**
 * Trims trailing decorations: "(Remote)", "| Full-Time", "(m/w/d)".
 *
 * A trailing bracket or separator segment is removed only when all of its
 * words are decorations. A bare "- Something" is otherwise left alone,
 * because "Engineer - Payments" names a different job while
 * "Engineer - Berlin" names the same one, and nothing in the string itself
 * tells them apart — the posting's location field does, via the `location`
 * option on `normalizeTitle`.
 */
function stripTrailingDecorations(value: string): string {
  let result = value.trim();

  for (let guard = 0; guard < 6; guard += 1) {
    const bracketed = /[([{]([^)\]}]*)[)\]}]\s*$/u.exec(result);
    if (bracketed?.[1] !== undefined && isAllDecoration(bracketed[1])) {
      const trimmed = result.slice(0, bracketed.index).trim();
      if (trimmed.length > 0) {
        result = trimmed;
        continue;
      }
    }

    const separated = /[-–—|/,:]\s*([^-–—|/,:]+)\s*$/u.exec(result);
    if (separated?.[1] !== undefined && isAllDecoration(separated[1])) {
      const trimmed = result.slice(0, separated.index).trim();
      if (trimmed.length > 0) {
        result = trimmed;
        continue;
      }
    }

    break;
  }

  return result;
}

export interface NormalizeTitleOptions {
  /**
   * The posting's location, when the board publishes one. Boards routinely
   * append it to the title ("Backend Engineer - Berlin"), so it is removed
   * before comparing — which is what makes the same role posted in two
   * cities resolve to one key.
   */
  location?: string | null;
}

/** Removes the posting's location from the title, wherever the board put it. */
function stripLocation(title: string, location: string | null | undefined): string {
  if (!location) return title;

  // Split "Berlin, Germany (Hybrid)" into its parts and drop each from the
  // title, longest first so "Berlin, Germany" goes before "Berlin".
  const parts = removeDiacritics(location)
    .split(/[,;/()|]/)
    .map((part) => part.trim())
    .filter((part) => part.length >= 3)
    .sort((a, b) => b.length - a.length);

  let result = removeDiacritics(title);
  for (const part of [removeDiacritics(location).trim(), ...parts]) {
    if (part.length < 3) continue;
    const escaped = part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Only where it reads as a decoration: after a separator, or bracketed.
    result = result
      .replace(new RegExp(`\\s*[-–—|,:]\\s*${escaped}\\s*$`, 'iu'), '')
      .replace(new RegExp(`\\s*[([{]\\s*${escaped}\\s*[)\\]}]`, 'giu'), ' ');
  }
  return result.trim().length > 0 ? result.trim() : title;
}

/**
 * Collapses a job title to a comparable form: lowercase, de-accented,
 * synonyms expanded, noise dropped, remaining words sorted.
 *
 * Sorting makes word order irrelevant, so "Backend Engineer, Senior" and
 * "Senior Backend Engineer" match. That is deliberate: a false merge costs
 * one skipped posting, a false split costs a duplicate application.
 */
export function normalizeTitle(title: string, options: NormalizeTitleOptions = {}): string {
  const located = stripLocation(title, options.location);
  const base = removeDiacritics(stripTrailingDecorations(located))
    .toLowerCase()
    .replace(/[&+]/g, ' and ')
    .replace(/[^a-z0-9\s./-]/g, ' ');

  let expanded = base;
  for (const [pattern, replacement] of TITLE_SYNONYMS) {
    expanded = expanded.replace(pattern, replacement);
  }

  const allWords = expanded
    .replace(/[./-]/g, ' ')
    .split(/\s+/)
    .filter((word) => word.length > 0)
    // Roman-numeral and digit levels are meaningful ("Engineer II" is not
    // "Engineer"), so they are kept — but normalised to digits.
    .map((word) => ROMAN_LEVELS[word] ?? word);

  const meaningful = allWords.filter((word) => !TITLE_NOISE.has(word));

  // A title made entirely of noise ("Open Position", "Remote") would otherwise
  // normalise to the empty string and collide with every other such title.
  // Falling back to the unfiltered words keeps those apart.
  const words = meaningful.length > 0 ? meaningful : allWords;

  return [...new Set(words)].sort().join(' ');
}

const ROMAN_LEVELS: Record<string, string> = {
  i: '1',
  ii: '2',
  iii: '3',
  iv: '4',
  v: '5',
};

/** Company name to a stable slug: "Acme, Inc." and "ACME Inc" agree. */
export function normalizeCompany(company: string): string {
  return removeDiacritics(company)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((word) => word.length > 0)
    .filter((word) => !COMPANY_SUFFIXES.has(word))
    .join('-');
}

const COMPANY_SUFFIXES = new Set([
  'ab',
  'ag',
  'bv',
  'co',
  'corp',
  'corporation',
  'gmbh',
  'holding',
  'holdings',
  'inc',
  'incorporated',
  'limited',
  'llc',
  'ltd',
  'nv',
  'oy',
  'plc',
  'pty',
  'sa',
  'sarl',
  'sas',
  'spa',
  'srl',
  'technologies',
  'the',
]);

/**
 * The key that answers "have I already gone after this job?".
 * Stored on every row so the uniqueness constraint can do the work.
 *
 * Pass the posting's `location` when the board publishes one: it lets the
 * same role advertised in two cities resolve to a single key.
 */
export function dedupeKey(
  company: string,
  title: string,
  location?: string | null,
): string {
  return `${normalizeCompany(company)}::${normalizeTitle(title, { location })}`;
}

/** Stable id for a posting, so re-running `hunt` updates rather than duplicates. */
export function jobId(source: string, externalId: string): string {
  return createHash('sha256')
    .update(`${source}:${externalId}`)
    .digest('hex')
    .slice(0, 16);
}
