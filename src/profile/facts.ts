import type { Profile } from '../config/profile.schema.js';

/**
 * The index of things a cover letter is allowed to claim.
 *
 * Every entry is a (field path, value) pair, where the path is the same tag
 * `renderProfileForPrompt` puts in the prompt. That is what makes citation
 * checkable: the model names the field it used, and `resolveProfileField`
 * either returns that field's real value or it does not exist.
 *
 * Contact details are deliberately absent. They are not sent to a provider
 * and a letter has no business quoting them.
 */

export interface ProfileFact {
  /** Dotted path, e.g. `roles.0.highlights.1`. */
  field: string;
  value: string;
}

export function indexProfileFacts(profile: Profile): ProfileFact[] {
  const facts: ProfileFact[] = [
    { field: 'name', value: profile.name },
    { field: 'headline', value: profile.headline },
    { field: 'yearsExperience', value: String(profile.yearsExperience) },
    { field: 'contact.location', value: profile.contact.location },
    { field: 'workAuthorization', value: profile.workAuthorization },
  ];

  profile.roles.forEach((role, index) => {
    facts.push({ field: `roles.${index}`, value: `${role.title} at ${role.company}` });
    facts.push({ field: `roles.${index}.company`, value: role.company });
    facts.push({ field: `roles.${index}.title`, value: role.title });
    facts.push({ field: `roles.${index}.start`, value: role.start });
    facts.push({ field: `roles.${index}.end`, value: role.end });
    role.highlights.forEach((highlight, highlightIndex) => {
      facts.push({ field: `roles.${index}.highlights.${highlightIndex}`, value: highlight });
    });
    if (role.technologies.length > 0) {
      facts.push({ field: `roles.${index}.technologies`, value: role.technologies.join(', ') });
    }
  });

  profile.education.forEach((entry, index) => {
    const field = entry.field ? ` in ${entry.field}` : '';
    facts.push({
      field: `education.${index}`,
      value: `${entry.credential}${field} — ${entry.institution}`,
    });
  });

  profile.certifications.forEach((cert, index) => {
    facts.push({ field: `certifications.${index}`, value: `${cert.name} — ${cert.issuer}` });
  });

  if (profile.skills.strong.length > 0) {
    facts.push({ field: 'skills.strong', value: profile.skills.strong.join(', ') });
  }
  if (profile.skills.working.length > 0) {
    facts.push({ field: 'skills.working', value: profile.skills.working.join(', ') });
  }

  return facts;
}

/**
 * Returns the real value at a dotted path, or null if the path does not exist.
 *
 * This is what catches a citation the model made up: a plausible-looking
 * `roles.7.highlights.2` on a profile with three roles resolves to null.
 */
export function resolveProfileField(profile: Profile, path: string): string | null {
  const facts = indexProfileFacts(profile);
  return facts.find((fact) => fact.field === path)?.value ?? null;
}

/** Every valid citation path, for error messages that suggest alternatives. */
export function validFieldPaths(profile: Profile): string[] {
  return indexProfileFacts(profile).map((fact) => fact.field);
}
