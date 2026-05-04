export function resolveUserAlias(rawName: string): string {
  const name = rawName.trim();
  const lower = name.toLowerCase();

  // Known short-forms from the user
  if (lower === 'm') return 'Muthuvel';
  if (lower === 'n') return 'Nishant';

  // Can add more as needed
  if (lower === 'ashik' || lower === 'ashik ibrahim') return 'Ashik';
  if (lower === 'raseeth') return 'Raseeth';
  if (lower === 'naveenkumar r' || lower === 'naveen') return 'Naveenkumar';

  return name;
}

export function isHanzDeveloper(resolvedName: string): boolean {
  const lower = resolvedName.toLowerCase();
  const knownHanz = ['muthuvel', 'nishant', 'ashik', 'raseeth', 'naveenkumar', 'mohan', 'sarves'];
  return knownHanz.some(n => lower.includes(n));
}
