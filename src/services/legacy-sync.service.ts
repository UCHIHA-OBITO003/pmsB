import type { Prisma } from '@prisma/client';
import { prisma } from '../utils/prisma';
import { redmineScraper } from './redmine-scraper.service';
import { PRIORITY_MAP } from '../utils/mappings';
import type { TicketPriority } from '@prisma/client';
import { parseLegacyTicketSource } from '../utils/legacy-source-url';

/** Map Redmine JSON `converted` blob onto Prisma ticket fields (description, priority, dates, estimate). */
export function legacyPatchFromConverted(converted: Record<string, unknown>): Prisma.TicketUpdateInput {
  const data: Prisma.TicketUpdateInput = {};
  const desc = converted.description;
  if (typeof desc === 'string' && desc.trim()) data.description = desc.trim();

  const pr = converted.Priority;
  if (typeof pr === 'string' && PRIORITY_MAP[pr]) {
    data.priority = PRIORITY_MAP[pr] as TicketPriority;
  }

  const estRaw = converted['Estimated Time'];
  const hours = parseEstimatedHoursFromLegacy(estRaw);
  if (hours != null) data.estimatedHours = hours;

  const due = parseYmd(converted['Due Date']);
  if (due) data.dueDate = due;

  const start = parseYmd(converted['Start Date']);
  if (start) data.startedAt = start;

  return data;
}

export function parseYmd(val: unknown): Date | undefined {
  if (typeof val !== 'string' || !val.trim()) return undefined;
  const t = Date.parse(val.trim());
  return Number.isNaN(t) ? undefined : new Date(t);
}

export function parseEstimatedHoursFromLegacy(val: unknown): number | undefined {
  if (typeof val === 'number' && Number.isFinite(val)) return val;
  if (typeof val !== 'string') return undefined;
  const m = val.match(/([\d.]+)/);
  if (!m) return undefined;
  const n = parseFloat(m[1]);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Re-scrape Codemagen/Redmine for a ticket by ID (server-side; no participant scope).
 * Used by BullMQ worker and can be wrapped by HTTP handlers that enforce access.
 */
export async function performLegacyCodemagenSync(ticketId: string): Promise<void> {
  const existing = await prisma.ticket.findFirst({
    where: { id: ticketId, deletedAt: null },
    select: { id: true, sourceUrl: true },
  });
  if (!existing?.sourceUrl) {
    throw new Error('NO_SOURCE_URL');
  }
  if (!existing.sourceUrl.includes('codemagen')) {
    throw new Error('NOT_CODEMAGEN');
  }

  const metadata = await redmineScraper.scrapeIssue(existing.sourceUrl);
  const converted = (metadata.converted || {}) as Record<string, unknown>;
  const legacyApply = legacyPatchFromConverted(converted);
  const parts = parseLegacyTicketSource(existing.sourceUrl);

  await prisma.ticket.update({
    where: { id: existing.id },
    data: {
      metadata: metadata as object,
      ...legacyApply,
      ...(parts.legacySourceKey ? { legacySourceKey: parts.legacySourceKey } : {}),
      ...(parts.issueNumber != null ? { legacyIssueNumber: parts.issueNumber } : {}),
    },
  });
}
