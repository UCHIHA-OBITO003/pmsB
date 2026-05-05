/**
 * One-off: find a ticket with a Codemagen sourceUrl and run the same scrape + patch as POST /tickets/:id/sync-legacy.
 * Run: pnpm exec tsx scripts/try-legacy-sync-local.ts
 */
import 'dotenv/config';
import type { Prisma, TicketPriority } from '@prisma/client';
import { prisma } from '../src/utils/prisma';
import { redmineScraper } from '../src/services/redmine-scraper.service';
import { PRIORITY_MAP } from '../src/utils/mappings';

function parseYmd(val: unknown): Date | undefined {
  if (typeof val !== 'string' || !val.trim()) return undefined;
  const t = Date.parse(val.trim());
  return Number.isNaN(t) ? undefined : new Date(t);
}

function parseEstimatedHoursFromLegacy(val: unknown): number | undefined {
  if (typeof val === 'number' && Number.isFinite(val)) return val;
  if (typeof val !== 'string') return undefined;
  const m = val.match(/([\d.]+)/);
  if (!m) return undefined;
  const n = parseFloat(m[1]);
  return Number.isFinite(n) ? n : undefined;
}

function legacyPatchFromConverted(converted: Record<string, unknown>): Prisma.TicketUpdateInput {
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

async function main() {
  const candidate =
    (await prisma.ticket.findFirst({
      where: { deletedAt: null, sourceUrl: { contains: 'codemagen' } },
      select: { id: true, sourceUrl: true, title: true, description: true, priority: true },
    })) ??
    (await prisma.ticket.findFirst({
      where: { deletedAt: null, sourceUrl: { not: null } },
      select: { id: true, sourceUrl: true, title: true, description: true, priority: true },
    }));

  if (!candidate?.sourceUrl) {
    console.error('No ticket with sourceUrl in DB. Create a ticket with a Codemagen issue URL first.');
    process.exit(1);
  }

  console.log('Ticket before:', candidate);

  if (!candidate.sourceUrl.includes('codemagen')) {
    console.warn('sourceUrl is not codemagen — API route would reject; continuing script for smoke test anyway.');
  }

  const metadata = await redmineScraper.scrapeIssue(candidate.sourceUrl);
  const converted = (metadata.converted || {}) as Record<string, unknown>;
  const legacyApply = legacyPatchFromConverted(converted);

  const updated = await prisma.ticket.update({
    where: { id: candidate.id },
    data: {
      metadata: metadata as object,
      ...legacyApply,
    },
    select: {
      id: true,
      title: true,
      description: true,
      priority: true,
      estimatedHours: true,
      dueDate: true,
      startedAt: true,
      metadata: true,
    },
  });

  console.log('\nPatch applied:', legacyApply);
  console.log('\nTicket after (selected fields):', {
    ...updated,
    metadata: updated.metadata
      ? { convertedKeys: Object.keys((updated.metadata as { converted?: object }).converted ?? {}) }
      : null,
  });
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
