const startedAt = new Date().toISOString();

let apiRequestCountSinceBoot = 0;

/** Counts authenticated API routes only when middleware runs after /api/ mount. Excludes OPTIONS. */
export function incrementApiHits(): void {
  apiRequestCountSinceBoot++;
}

export function getApiHitsSnapshot(): { count: number; since: string } {
  return { count: apiRequestCountSinceBoot, since: startedAt };
}
