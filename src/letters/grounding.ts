import type { Profile } from '../config/profile.schema.js';
import type { Job } from '../db/types.js';
import { indexProfileFacts, resolveProfileField } from '../profile/facts.js';
import type { FactCitation } from './schema.js';

/**
 * The "no invented facts" check.
 *
 * A letter may claim nothing that is not in the profile or the job posting.
 * That is checked three ways, from weakest to strongest:
 *
 *  1. **Numbers.** Every figure in the letter must appear in the source
 *     material. This is the check that catches a flattering "reduced costs by
 *     35%" when the profile never mentions 35 of anything.
 *  2. **Proper nouns.** Every capitalised term must appear in the source
 *     material. This catches an invented employer, a technology never used,
 *     or a product the candidate has not touched.
 *  3. **Citations.** Every field the model says it used must exist, and its
 *     claimed value must match what the profile actually says.
 *
 * None of this needs a model, which is the point: a check that cannot itself
 * hallucinate is worth more than a second opinion.
 */

export interface GroundingIssue {
  kind: 'number' | 'proper-noun' | 'citation';
  /** The offending token or field path. */
  token: string;
  /** Why it failed, phrased for a human and for feeding back to the model. */
  detail: string;
}

export interface GroundingReport {
  grounded: boolean;
  issues: GroundingIssue[];
}

/** The source material a letter is allowed to draw on. */
export interface Corpus {
  /** Lowercased word tokens from the profile and the posting. */
  words: Set<string>;
  /** Numeric strings, including those spelled out in words. */
  numbers: Set<string>;
  text: string;
}

const NUMBER_WORDS: Record<string, string> = {
  zero: '0',
  one: '1',
  two: '2',
  three: '3',
  four: '4',
  five: '5',
  six: '6',
  seven: '7',
  eight: '8',
  nine: '9',
  ten: '10',
  eleven: '11',
  twelve: '12',
  thirteen: '13',
  fourteen: '14',
  fifteen: '15',
  sixteen: '16',
  seventeen: '17',
  eighteen: '18',
  nineteen: '19',
  twenty: '20',
  thirty: '30',
  forty: '40',
  fifty: '50',
  sixty: '60',
  seventy: '70',
  eighty: '80',
  ninety: '90',
};

/**
 * Capitalised words that are ordinary English rather than proper nouns.
 *
 * Without this list every sentence-initial word would look like an invented
 * company. Letter scaffolding ("Dear", "Sincerely") is here too.
 */
const CAPITALISED_STOPWORDS = new Set(
  [
    'a', 'about', 'above', 'after', 'again', 'all', 'also', 'although', 'am', 'an', 'and', 'another',
    'any', 'are', 'as', 'at', 'back', 'be', 'because', 'been', 'before', 'being', 'best', 'both',
    'but', 'by', 'can', 'could', 'dear', 'did', 'do', 'does', 'doing', 'done', 'down', 'during',
    'each', 'either', 'enough', 'even', 'every', 'few', 'first', 'for', 'from', 'get', 'given',
    'had', 'has', 'have', 'having', 'he', 'hello', 'her', 'here', 'hi', 'him', 'his', 'how',
    'however', 'i', 'if', 'in', 'into', 'is', 'it', 'its', 'just', 'kind', 'last', 'let', 'like',
    'look', 'looking', 'made', 'make', 'many', 'may', 'me', 'might', 'mine', 'more', 'most', 'much',
    'must', 'my', 'neither', 'never', 'new', 'next', 'no', 'none', 'nor', 'not', 'now', 'of', 'on',
    'once', 'one', 'only', 'or', 'other', 'our', 'ours', 'out', 'over', 'own', 'per', 'please',
    'regards', 'right', 'said', 'same', 'say', 'see', 'several', 'shall', 'she', 'should',
    'sincerely', 'since', 'so', 'some', 'still', 'such', 'team', 'than', 'thanks', 'thank', 'that',
    'the', 'their', 'theirs', 'them', 'then', 'there', 'these', 'they', 'this', 'those', 'though',
    'through', 'to', 'too', 'under', 'until', 'up', 'us', 'use', 'used', 'using', 'very', 'was',
    'we', 'well', 'were', 'what', 'when', 'where', 'whether', 'which', 'while', 'who', 'whom',
    'why', 'will', 'with', 'within', 'without', 'work', 'worked', 'working', 'would', 'yes', 'yet',
    'you', 'your', 'yours',
    // Ordinary adjectives, adverbs and verbs that open sentences in a
    // letter. None of these is ever a company or a technology, so excluding
    // them loses no coverage — and leaving them out produced false positives
    // on perfectly honest letters.
    'able', 'across', 'actually', 'already', 'alongside', 'always', 'among', 'around', 'beyond',
    'between', 'bigger', 'certainly', 'clear', 'clearly', 'close', 'comfortable', 'confident',
    'currently', 'deep', 'deeply', 'despite', 'earlier', 'especially', 'exactly', 'experienced',
    'familiar', 'finally', 'full', 'generally', 'glad', 'good', 'great', 'half', 'happy', 'hard',
    'high', 'ideally', 'instead', 'interested', 'keen', 'largely', 'later', 'likely', 'long',
    'low', 'mainly', 'mostly', 'nearly', 'often', 'overall', 'particularly', 'perhaps', 'pleased',
    'previously', 'quite', 'rather', 'ready', 'real', 'really', 'recently', 'roughly', 'simply',
    'small', 'soon', 'specifically', 'strong', 'sure', 'throughout', 'today', 'together',
    'typically', 'usually', 'whole', 'wide', 'willing',
    // Days and months, which appear in dates rather than as claims.
    'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
    'january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september',
    'october', 'november', 'december',
  ],
);

/** Splits text into lowercase word tokens, keeping tech punctuation. */
function tokenise(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9+#./_-]+/)
    .flatMap((token) => {
      const trimmed = token.replace(/^[-./_]+|[-./_]+$/g, '');
      if (trimmed.length === 0) return [];
      // Index "node.js" as itself and as "node"/"js", so either spelling
      // in the letter resolves against either spelling in the source.
      const parts = trimmed.split(/[./_-]/).filter((part) => part.length > 0);
      return parts.length > 1 ? [trimmed, ...parts] : [trimmed];
    });
}

/** Every digit run in the text, plus number-words mapped to digits. */
function extractNumbers(text: string): string[] {
  const digits = [...text.matchAll(/\d+(?:[.,]\d+)*/g)].map((match) =>
    // 40,000 and 40000 are the same figure.
    match[0].replace(/,/g, ''),
  );

  const words = tokenise(text)
    .map((token) => NUMBER_WORDS[token])
    .filter((value): value is string => value !== undefined);

  return [...digits, ...words];
}

/**
 * The corpus is broader than the citation index.
 *
 * `indexProfileFacts` lists what is worth *citing* — the achievements a letter
 * is built from. The corpus is everything that is simply *true* about the
 * candidate, which is a larger set: a letter that states a salary expectation
 * from `salary.publicAnswer`, or a notice period from a standard answer, is
 * grounded even though neither is a citable highlight.
 *
 * Contact details stay out of both. They are never sent to a provider, so a
 * letter quoting an email address is a letter that invented it.
 */
export function buildCorpus(profile: Profile, job: Job): Corpus {
  const profileText = [
    ...indexProfileFacts(profile).map((fact) => fact.value),
    ...profile.skills.strong,
    ...profile.skills.working,
    ...profile.voiceNotes,
    ...profile.roles.flatMap((role) => role.technologies),
    ...profile.education.map((entry) => `${entry.institution} ${entry.field ?? ''}`),
    ...profile.certifications.map((cert) => `${cert.name} ${cert.issuer}`),
    // Constraints and canned answers: true statements a letter may make.
    `${profile.salary.minimum} ${profile.salary.target} ${profile.salary.currency} ${profile.salary.period}`,
    profile.salary.publicAnswer ?? '',
    ...profile.preferences.locations,
    ...profile.preferences.titles,
    ...profile.standardAnswers.map((answer) => answer.answer),
  ].join('\n');

  const jobText = [job.company, job.title, job.location ?? '', job.description ?? ''].join('\n');
  const text = `${profileText}\n${jobText}`;

  return {
    words: new Set(tokenise(text)),
    numbers: new Set(extractNumbers(text)),
    text,
  };
}

/**
 * Checks a letter body against the source material.
 *
 * Deliberately strict: a false positive costs one regeneration, while a false
 * negative puts an invented claim in front of an employer.
 */
export function checkGrounding(body: string, corpus: Corpus): GroundingIssue[] {
  const issues: GroundingIssue[] = [];

  // --- numbers ---------------------------------------------------------
  const seenNumbers = new Set<string>();
  for (const match of body.matchAll(/\d+(?:[.,]\d+)*/g)) {
    const value = match[0].replace(/,/g, '');
    if (seenNumbers.has(value)) continue;
    seenNumbers.add(value);

    if (!corpus.numbers.has(value)) {
      issues.push({
        kind: 'number',
        token: match[0],
        detail: `The letter states "${match[0]}", which appears in neither the profile nor the job posting.`,
      });
    }
  }

  // A figure spelled out ("Seven years in") is a numeric claim, so it is
  // checked against the numbers rather than treated as a proper noun.
  for (const [word, digits] of Object.entries(NUMBER_WORDS)) {
    if (!new RegExp(`(^|[^a-z])${word}([^a-z]|$)`, 'i').test(body)) continue;
    if (seenNumbers.has(digits)) continue;
    seenNumbers.add(digits);

    if (!corpus.numbers.has(digits)) {
      issues.push({
        kind: 'number',
        token: word,
        detail: `The letter states "${word}" (${digits}), which appears in neither the profile nor the job posting.`,
      });
    }
  }

  // --- proper nouns ----------------------------------------------------
  const seenNouns = new Set<string>();
  // Sentence-initial words are checked too, not skipped: an invented company
  // can open a sentence. The stopword list, not position, is what excludes
  // ordinary English. A false positive costs one regeneration; a false
  // negative puts an invented claim in front of an employer.
  for (const match of body.matchAll(/[A-Z][A-Za-z0-9+#.]*(?:[.\-][A-Za-z0-9+#]+)*/g)) {
    const token = match[0].replace(/\.$/, '');
    const lower = token.toLowerCase();

    if (token.length < 2) continue;
    if (CAPITALISED_STOPWORDS.has(lower)) continue;
    // Already handled by the numeric pass above.
    if (lower in NUMBER_WORDS) continue;
    if (seenNouns.has(lower)) continue;
    seenNouns.add(lower);

    if (!corpus.words.has(lower)) {
      issues.push({
        kind: 'proper-noun',
        token,
        detail: `The letter mentions "${token}", which appears in neither the profile nor the job posting.`,
      });
    }
  }

  return issues;
}

/** Checks that each cited field exists and says what the model claims. */
export function verifyCitations(
  profile: Profile,
  citations: readonly FactCitation[],
): GroundingIssue[] {
  const issues: GroundingIssue[] = [];

  for (const citation of citations) {
    const actual = resolveProfileField(profile, citation.field);

    if (actual === null) {
      issues.push({
        kind: 'citation',
        token: citation.field,
        detail: `Cited profile field "${citation.field}" does not exist.`,
      });
      continue;
    }

    if (!valuesAgree(citation.value, actual)) {
      issues.push({
        kind: 'citation',
        token: citation.field,
        detail:
          `Cited "${citation.field}" as "${truncate(citation.value)}", ` +
          `but that field actually says "${truncate(actual)}".`,
      });
    }
  }

  return issues;
}

/**
 * Whether a cited value is really what the field says.
 *
 * Containment either way, because the model may quote a clause out of a long
 * highlight or summarise a list — both are honest citations. What this
 * rejects is a value with no textual relationship to the field at all.
 */
function valuesAgree(cited: string, actual: string): boolean {
  const a = normaliseForCompare(cited);
  const b = normaliseForCompare(actual);
  if (a.length === 0) return false;
  if (b.includes(a) || a.includes(b)) return true;

  // A summarised list: every significant word of the citation is in the field.
  const citedWords = a.split(' ').filter((word) => word.length > 3);
  if (citedWords.length === 0) return false;
  return citedWords.every((word) => b.includes(word));
}

function normaliseForCompare(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function truncate(value: string, max = 80): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}

/** Runs every check and reports whether the letter may be saved. */
export function assessLetter(options: {
  body: string;
  citations: readonly FactCitation[];
  profile: Profile;
  job: Job;
}): GroundingReport {
  const corpus = buildCorpus(options.profile, options.job);
  const issues = [
    ...checkGrounding(options.body, corpus),
    ...verifyCitations(options.profile, options.citations),
  ];
  return { grounded: issues.length === 0, issues };
}
