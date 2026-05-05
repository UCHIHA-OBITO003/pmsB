import type { Prisma } from '@prisma/client';
import { prisma } from '../utils/prisma';
import { parseLegacyTicketSource } from '../utils/legacy-source-url';

export type RemediateLegacyResult = {
  examined: number;
  updated: number;
  keysBackfilled: number;
  dryRun: boolean;
};

/**
 * Moves Codemagen / sheet-backed rows to the canonical legacy project (default EEP) and backfills legacy keys from sourceUrl.
 */
export async function remediateLegacyCodemagenTickets(opts: {
  targetProjectKey: string;
  dryRun?: boolean;
}): Promise<RemediateLegacyResult> {
  const { targetProjectKey, dryRun } = opts;
  const target = await prisma.project.findFirst({
    where: { key: targetProjectKey, deletedAt: null },
    select: { id: true, companyId: true },
  });
  if (!target) {
    throw new Error(`PROJECT_NOT_FOUND:${targetProjectKey}`);
  }

  const candidates = await prisma.ticket.findMany({
    where: {
      deletedAt: null,
      OR: [
        { legacySourceKey: { startsWith: 'codemagen:' } },
        { sourceUrl: { contains: 'codemagen.net', mode: 'insensitive' as const } },
        { source: { in: ['codemagen_scraper', 'google_sheets', 'excel'] } },
      ],
    },
    select: {
      id: true,
      projectId: true,
      sourceUrl: true,
      legacySourceKey: true,
      legacyIssueNumber: true,
    },
  });

  const defaultState =
    !dryRun ?
      await prisma.workflowState.findFirst({
        where: { projectId: target.id, isDefault: true },
        select: { id: true },
      })
    : null;

  let updated = 0;
  let keysBackfilled = 0;

  if (dryRun) {
    return { examined: candidates.length, updated: 0, keysBackfilled: 0, dryRun: true };
  }

  for (const t of candidates) {
    const parts = parseLegacyTicketSource(t.sourceUrl ?? '');
    const data: Prisma.TicketUpdateInput = {};
    if (t.projectId !== target.id) {
      data.project = { connect: { id: target.id } };
      if (defaultState?.id) data.workflowState = { connect: { id: defaultState.id } };
    }
    if (target.companyId) {
      data.company = { connect: { id: target.companyId } };
    }
    if (parts.legacySourceKey && !t.legacySourceKey) {
      data.legacySourceKey = parts.legacySourceKey;
      keysBackfilled++;
    }
    if (parts.issueNumber != null && t.legacyIssueNumber == null) {
      data.legacyIssueNumber = parts.issueNumber;
    }

    const keys = Object.keys(data).filter((k) => !k.startsWith('_'));
    if (keys.length === 0) continue;
    try {
      await prisma.ticket.update({ where: { id: t.id }, data });
      updated++;
    } catch {
      /* unique legacySourceKey conflict — leave row; dedupe later */
    }
  }

  return {
    examined: candidates.length,
    updated,
    keysBackfilled,
    dryRun: false,
  };
}

export type DedupeLegacyResult = {
  groupsMerged: number;
  ticketsHidden: number;
  dryRun: boolean;
};

/**
 * Keeps newest-updated ticket per legacySourceKey (optionally preferring a given project key), merges assigns, hides dupes.
 */
export async function dedupeTicketsByLegacyKey(opts: {
  preferProjectKey?: string;
  dryRun?: boolean;
}): Promise<DedupeLegacyResult> {
  const { preferProjectKey, dryRun } = opts;
  let preferPid: string | null = null;
  if (preferProjectKey?.trim()) {
    const pref = await prisma.project.findFirst({
      where: { key: preferProjectKey.trim(), deletedAt: null },
      select: { id: true },
    });
    preferPid = pref?.id ?? null;
  }

  const rows = await prisma.ticket.findMany({
    where: { deletedAt: null, legacySourceKey: { not: null } },
    select: { id: true, legacySourceKey: true, updatedAt: true, projectId: true },
    orderBy: { updatedAt: 'desc' },
  });

  const buckets = new Map<string, typeof rows>();
  for (const r of rows) {
    const k = r.legacySourceKey!;
    const arr = buckets.get(k) ?? [];
    arr.push(r);
    buckets.set(k, arr);
  }

  let groupsMerged = 0;
  let ticketsHidden = 0;

  for (const [, listRaw] of buckets) {
    if (listRaw.length < 2) continue;
    let ordered = [...listRaw].sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
    if (preferPid) {
      ordered = [...ordered].sort((a, b) => {
        const ap = a.projectId === preferPid ? 0 : 1;
        const bp = b.projectId === preferPid ? 0 : 1;
        if (ap !== bp) return ap - bp;
        return b.updatedAt.getTime() - a.updatedAt.getTime();
      });
    }

    groupsMerged++;

    const [survivor, ...dupes] = ordered;

    if (dryRun) {
      ticketsHidden += dupes.length;
      continue;
    }

    await prisma.$transaction(async (tx) => {
      for (const d of dupes) {
        const dFull = await tx.ticket.findUnique({
          where: { id: d.id },
          include: { assignees: { select: { id: true } } },
        });
        if (!dFull) continue;

        const surv = await tx.ticket.findUnique({
          where: { id: survivor.id },
          select: { id: true, assignees: { select: { id: true } } },
        });
        if (!surv) return;

        const assigneeIds = new Set([
          ...surv.assignees.map((a) => a.id),
          ...dFull.assignees.map((a) => a.id),
        ]);

        await tx.ticket.update({
          where: { id: survivor.id },
          data: {
            assignees: { set: [...assigneeIds].map((uid) => ({ id: uid })) },
          },
        });

        const stLinks = await tx.sprintTicket.findMany({ where: { ticketId: d.id } });
        for (const st of stLinks) {
          const exists = await tx.sprintTicket.findUnique({
            where: { sprintId_ticketId: { sprintId: st.sprintId, ticketId: survivor.id } },
          });
          if (exists) {
            await tx.sprintTicket.delete({
              where: { sprintId_ticketId: { sprintId: st.sprintId, ticketId: d.id } },
            });
          } else {
            await tx.sprintTicket.update({
              where: { sprintId_ticketId: { sprintId: st.sprintId, ticketId: d.id } },
              data: { ticketId: survivor.id },
            });
          }
        }

        await tx.ticketComment.updateMany({ where: { ticketId: d.id }, data: { ticketId: survivor.id } });
        await tx.ticketAttachment.updateMany({ where: { ticketId: d.id }, data: { ticketId: survivor.id } });
        await tx.ticketHistory.updateMany({ where: { ticketId: d.id }, data: { ticketId: survivor.id } });
        await tx.timesheet.updateMany({ where: { ticketId: d.id }, data: { ticketId: survivor.id } });
        await tx.ticketStatusDuration.updateMany({ where: { ticketId: d.id }, data: { ticketId: survivor.id } });
        await tx.ticket.updateMany({ where: { parentId: d.id }, data: { parentId: survivor.id } });

        const checklist = await tx.ticketChecklistItem.findMany({ where: { ticketId: d.id } });
        if (checklist.length) {
          await tx.ticketChecklistItem.updateMany({
            where: { ticketId: d.id },
            data: { ticketId: survivor.id },
          });
        }

        await tx.ticketLink.updateMany({ where: { ticketId: d.id }, data: { ticketId: survivor.id } });
        await tx.ticketLink.updateMany({
          where: { linkedTicketId: d.id },
          data: { linkedTicketId: survivor.id },
        });

        const dupWatch = await tx.ticketWatcher.findMany({ where: { ticketId: d.id } });
        for (const w of dupWatch) {
          await tx.ticketWatcher.delete({
            where: { ticketId_userId: { ticketId: w.ticketId, userId: w.userId } },
          });
          const hit = await tx.ticketWatcher.findUnique({
            where: { ticketId_userId: { ticketId: survivor.id, userId: w.userId } },
          });
          if (!hit) {
            await tx.ticketWatcher.create({
              data: { ticketId: survivor.id, userId: w.userId },
            });
          }
        }

        const dupVotes = await tx.ticketVote.findMany({ where: { ticketId: d.id } });
        for (const v of dupVotes) {
          await tx.ticketVote.delete({
            where: { ticketId_userId: { ticketId: v.ticketId, userId: v.userId } },
          });
          const hit = await tx.ticketVote.findUnique({
            where: { ticketId_userId: { ticketId: survivor.id, userId: v.userId } },
          });
          if (!hit) {
            await tx.ticketVote.create({
              data: { ticketId: survivor.id, userId: v.userId },
            });
          }
        }

        await tx.ticket.update({
          where: { id: d.id },
          data: {
            deletedAt: new Date(),
            legacySourceKey: null,
            rowHash: null,
          },
        });
        ticketsHidden++;
      }
    });
  }

  return { groupsMerged, ticketsHidden, dryRun: !!dryRun };
}
