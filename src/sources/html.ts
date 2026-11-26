/**
 * HTML to readable plain text.
 *
 * Lever and Ashby hand us a `descriptionPlain`, so this is mostly for
 * Greenhouse, whose `content` field is *double-escaped*: the payload contains
 * `&lt;div&gt;` where the real document has `<div>`. So entities are decoded,
 * then tags are stripped, then entities are decoded again for the text's own
 * `&amp;` and friends.
 *
 * This is not a parser and does not try to be. The output is fed to an LLM and
 * shown in a dashboard; what matters is that paragraphs and list items stay on
 * separate lines and no markup leaks through.
 */

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  rsquo: '’',
  lsquo: '‘',
  rdquo: '”',
  ldquo: '“',
  bull: '•',
  middot: '·',
  eacute: 'é',
  egrave: 'è',
  uuml: 'ü',
  ouml: 'ö',
  auml: 'ä',
  szlig: 'ß',
};

/** Decodes named and numeric HTML entities. */
export function decodeEntities(value: string): string {
  return value.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (match, body: string) => {
    if (body.startsWith('#')) {
      const isHex = body[1] === 'x' || body[1] === 'X';
      const code = Number.parseInt(isHex ? body.slice(2) : body.slice(1), isHex ? 16 : 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return match;
      try {
        return String.fromCodePoint(code);
      } catch {
        return match;
      }
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? match;
  });
}

/**
 * Tags that should produce a line break where they close.
 *
 * `li` is absent on purpose: `<li>` already opens a new line with its dash,
 * so closing it too would put a blank line between every bullet.
 */
const BLOCK_TAGS =
  'p|div|br|hr|ul|ol|tr|table|thead|tbody|section|article|header|footer|h[1-6]|blockquote|pre';

/**
 * Converts an HTML fragment to plain text.
 *
 * `doubleEscaped` handles Greenhouse: decode entities once to reveal the
 * markup, then run the normal path.
 */
export function htmlToText(html: string, options: { doubleEscaped?: boolean } = {}): string {
  if (!html) return '';

  let text = options.doubleEscaped ? decodeEntities(html) : html;

  text = text
    // Drop anything whose contents are not prose.
    .replace(/<(script|style|svg|noscript)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    // List items become dashes so a bulleted requirements list stays legible.
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(new RegExp(`</(?:${BLOCK_TAGS})\\s*>`, 'gi'), '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    // Keep a word boundary where an inline tag was, so "<b>a</b><b>b</b>"
    // does not become "ab".
    .replace(/<[^>]+>/g, ' ');

  text = decodeEntities(text);

  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Trims description text to a budget without cutting mid-word.
 *
 * Scoring sends these to an LLM, and a handful of boards publish enormous
 * descriptions, so there is a cap. The note is left in so a truncated
 * description is never mistaken for a short one.
 */
export function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;

  const cut = text.slice(0, maxChars);
  const lastBreak = Math.max(cut.lastIndexOf('\n'), cut.lastIndexOf(' '));
  // Losing a few characters to land on a word boundary is always preferable
  // to a mid-word cut. Only a single unbroken run that long falls through.
  const body = lastBreak > 0 ? cut.slice(0, lastBreak) : cut;
  return `${body.trimEnd()}\n\n[truncated: posting continues for ${text.length - body.length} more characters]`;
}
