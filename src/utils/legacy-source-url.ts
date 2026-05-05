export type LegacySourceParts = {
  /** Normalized HTTPS URL without trailing slash (Codemagen/Redmine issues). */
  canonicalUrl: string | null;
  /**
   * Global dedupe identity for synced legacy issues, e.g. `codemagen:11072`.
   * Null when the cell has no recognizable legacy URL / issue reference.
   */
  legacySourceKey: string | null;
  /** Numeric Redmine issue id when parsable (for stable list ordering). */
  issueNumber: number | null;
};

/**
 * Parses messy sheet cells ("Ticket #200 https://pms.codemagen.net/issues/200")
 * into a canonical URL plus a stable key for upserts across projects.
 */
export function parseLegacyTicketSource(raw: string | null | undefined): LegacySourceParts {
  if (!raw || typeof raw !== 'string') {
    return { canonicalUrl: null, legacySourceKey: null, issueNumber: null };
  }
  let s = raw.trim();
  if (!s) return { canonicalUrl: null, legacySourceKey: null, issueNumber: null };

  const embedded = s.match(/https?:\/\/[^\s]+/i);
  if (embedded) {
    s = embedded[0].trim();
  }

  try {
    if (/^https?:\/\//i.test(s)) {
      const url = new URL(s.split(/\?#/)[0].replace(/\/$/, ''));
      const issueMatch = url.pathname.match(/\/issues\/(\d+)/);
      const id = issueMatch?.[1];
      const host = url.hostname.toLowerCase();
      if (id && (host.includes('codemagen.net') || host.includes('redmine'))) {
        const canonicalUrl = `${url.origin}/issues/${id}`;
        const issueNumber = parseInt(id, 10);
        return {
          canonicalUrl,
          legacySourceKey: `codemagen:${id}`,
          issueNumber: Number.isFinite(issueNumber) ? issueNumber : null,
        };
      }
      return { canonicalUrl: url.href, legacySourceKey: `url:${url.href}`, issueNumber: null };
    }
  } catch {
    /* fall through */
  }

  const issuePath = raw.match(/issues\/(\d+)/i);
  if (issuePath?.[1] && /codemagen/i.test(raw)) {
    const n = parseInt(issuePath[1], 10);
    return { canonicalUrl: null, legacySourceKey: `codemagen:${issuePath[1]}`, issueNumber: Number.isFinite(n) ? n : null };
  }

  return { canonicalUrl: null, legacySourceKey: null, issueNumber: null };
}
