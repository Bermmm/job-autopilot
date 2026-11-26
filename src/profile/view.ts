import type { Profile } from '../config/profile.schema.js';

/**
 * Renders the profile as text for a prompt.
 *
 * Two rules govern what goes in:
 *
 *  1. **No contact details.** Scoring and drafting need your experience, not
 *    your email, phone number, or links. They are omitted so they are never
 *    sent to a provider, and a test asserts it.
 *  2. **Stable ordering.** Same profile in, same text out, so prompt caching
 *    works and two runs are comparable.
 *
 * Every line is labelled with the profile field it came from, which is what
 * lets the letter generator cite its sources and the grounding test verify
 * them.
 */

export interface RenderOptions {
  /** Include salary rules and deal-breakers. Wanted for scoring, not letters. */
  includeConstraints?: boolean;
}

export function renderProfileForPrompt(
  profile: Profile,
  options: RenderOptions = {},
): string {
  const lines: string[] = [];

  lines.push(`Name: ${profile.name}`);
  lines.push(`Headline: ${profile.headline}`);
  lines.push(`Years of professional experience: ${profile.yearsExperience}`);
  lines.push(`Based in: ${profile.contact.location}`);
  lines.push(`Work authorization: ${profile.workAuthorization}`);

  lines.push('', 'Work history (most recent first):');
  profile.roles.forEach((role, index) => {
    const period = `${role.start} to ${role.end}`;
    lines.push(`  [roles.${index}] ${role.title} at ${role.company} (${period})`);
    role.highlights.forEach((highlight, highlightIndex) => {
      lines.push(`    - [roles.${index}.highlights.${highlightIndex}] ${highlight}`);
    });
    if (role.technologies.length > 0) {
      lines.push(`    technologies: ${role.technologies.join(', ')}`);
    }
  });

  if (profile.education.length > 0) {
    lines.push('', 'Education:');
    profile.education.forEach((entry, index) => {
      const field = entry.field ? ` in ${entry.field}` : '';
      const completed = entry.completed ? `, ${entry.completed}` : '';
      lines.push(
        `  [education.${index}] ${entry.credential}${field} — ${entry.institution}${completed}`,
      );
    });
  }

  if (profile.certifications.length > 0) {
    lines.push('', 'Certifications:');
    profile.certifications.forEach((cert, index) => {
      const issued = cert.issued ? `, issued ${cert.issued}` : '';
      lines.push(`  [certifications.${index}] ${cert.name} — ${cert.issuer}${issued}`);
    });
  }

  lines.push('', 'Skills:');
  if (profile.skills.strong.length > 0) {
    lines.push(`  [skills.strong] confident: ${profile.skills.strong.join(', ')}`);
  }
  if (profile.skills.working.length > 0) {
    lines.push(
      `  [skills.working] some real but shallower experience: ${profile.skills.working.join(', ')}`,
    );
  }
  if (profile.skills.avoid.length > 0) {
    lines.push(`  [skills.avoid] does not want to work with: ${profile.skills.avoid.join(', ')}`);
  }

  if (options.includeConstraints) {
    lines.push('', 'Constraints:');
    lines.push(
      `  [salary] minimum acceptable ${profile.salary.minimum} ${profile.salary.currency} per ${profile.salary.period}` +
        ` (target ${profile.salary.target})`,
    );
    if (profile.preferences.locations.length > 0) {
      lines.push(`  [preferences.locations] will work: ${profile.preferences.locations.join(', ')}`);
    }
    lines.push(`  [preferences.remoteOnly] remote only: ${profile.preferences.remoteOnly}`);
    if (profile.preferences.titles.length > 0) {
      lines.push(`  [preferences.titles] looking for: ${profile.preferences.titles.join(', ')}`);
    }
    if (profile.preferences.dealBreakers.length > 0) {
      lines.push(
        `  [preferences.dealBreakers] will not accept: ${profile.preferences.dealBreakers.join(', ')}`,
      );
    }
  }

  return lines.join('\n');
}
