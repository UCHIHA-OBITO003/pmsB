import { prisma } from '../utils/prisma';
import { AppError } from '../middleware/errorHandler';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface MergeStats {
  mergedSourceCount: number;
  projectMembershipsMoved: number;
  teamMembershipsMoved: number;
  rolesMoved: number;
  ticketsReassigned: number;
  commentsReassigned: number;
  attachmentsReassigned: number;
  historyRowsMoved: number;
  orgMembersMoved: number;
  companyMembersMoved: number;
  watchersMoved: number;
  votesMoved: number;
  retrosMoved: number;
  docsMoved: number;
  notificationsMoved: number;
  timesheetsMerged: number;
  availabilityMerged: number;
  metricRowsMoved: number;
  auditRowsMoved: number;
  sourcesDeactivated: string[];
}

export interface MergeResult {
  merged: number;
  stats: MergeStats;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function tombstoneEmail(sourceId: string) {
  return `merged.${sourceId.slice(0, 8)}.${Date.now()}@pms.merge`;
}

async function snapshotUser(id: string) {
  return prisma.user.findFirst({
    where: { id },
    select: {
      id: true, email: true, firstName: true, lastName: true,
      department: true, designation: true, status: true,
      roles: { select: { role: { select: { id: true, name: true } } } },
    },
  });
}

// ─── Core merge  (sequential, no single-transaction boundary) ─────────────────

export async function mergeUsersIntoTarget(
  targetId: string,
  sourceIds: string[],
  actorId?: string,
): Promise<MergeResult> {
  const uniqueSources = [...new Set(sourceIds.filter((id) => id && id !== targetId))];
  if (!uniqueSources.length) return { merged: 0, stats: emptyStats() };

  const [target, sources] = await Promise.all([
    prisma.user.findFirst({ where: { id: targetId, deletedAt: null } }),
    prisma.user.findMany({ where: { id: { in: uniqueSources }, deletedAt: null } }),
  ]);

  if (!target) throw new AppError(404, 'Target user not found', 'NOT_FOUND');
  if (sources.length !== uniqueSources.length)
    throw new AppError(404, 'One or more source users not found', 'NOT_FOUND');

  // Snapshot for audit log
  const [targetBefore, ...sourcesBefore] = await Promise.all([
    snapshotUser(targetId),
    ...uniqueSources.map((id) => snapshotUser(id)),
  ]);

  const stats: MergeStats = emptyStats();
  stats.mergedSourceCount = uniqueSources.length;

  for (const sourceId of uniqueSources) {
    // 1. Refresh tokens
    await prisma.refreshToken.deleteMany({ where: { userId: sourceId } });

    // 2. Project memberships
    const projMembers = await prisma.projectMember.findMany({ where: { userId: sourceId } });
    for (const m of projMembers) {
      await prisma.projectMember.delete({
        where: { projectId_userId: { projectId: m.projectId, userId: sourceId } },
      }).catch(() => {});
      await prisma.projectMember.upsert({
        where: { projectId_userId: { projectId: m.projectId, userId: targetId } },
        create: { projectId: m.projectId, userId: targetId, role: m.role },
        update: {},
      });
      stats.projectMembershipsMoved++;
    }

    // 3. Team memberships
    const teamMembers = await prisma.teamMember.findMany({ where: { userId: sourceId } });
    for (const tm of teamMembers) {
      await prisma.teamMember.delete({
        where: { teamId_userId: { teamId: tm.teamId, userId: sourceId } },
      }).catch(() => {});
      await prisma.teamMember.upsert({
        where: { teamId_userId: { teamId: tm.teamId, userId: targetId } },
        create: { teamId: tm.teamId, userId: targetId, role: tm.role },
        update: {},
      });
      stats.teamMembershipsMoved++;
    }

    // 4. Roles
    const sourceRoles = await prisma.userRole.findMany({ where: { userId: sourceId } });
    for (const r of sourceRoles) {
      await prisma.userRole.upsert({
        where: { userId_roleId: { userId: targetId, roleId: r.roleId } },
        create: { userId: targetId, roleId: r.roleId, grantedBy: r.grantedBy },
        update: {},
      });
      stats.rolesMoved++;
    }
    await prisma.userRole.deleteMany({ where: { userId: sourceId } });

    // 5. Ticket reporter
    const { count: reporterCount } = await prisma.ticket.updateMany({
      where: { reporterId: sourceId },
      data: { reporterId: targetId },
    });
    stats.ticketsReassigned += reporterCount;

    // 6. Ticket assignees
    const ticketsWithSource = await prisma.ticket.findMany({
      where: { assignees: { some: { id: sourceId } } },
      select: { id: true, assignees: { select: { id: true } } },
    });
    for (const t of ticketsWithSource) {
      const ids = new Set(t.assignees.map((a) => a.id));
      ids.delete(sourceId);
      ids.add(targetId);
      await prisma.ticket.update({
        where: { id: t.id },
        data: { assignees: { set: [...ids].map((id) => ({ id })) } },
      });
      stats.ticketsReassigned++;
    }

    // 7. Comments, attachments, history
    const { count: commentCount } = await prisma.ticketComment.updateMany({
      where: { authorId: sourceId },
      data: { authorId: targetId },
    });
    stats.commentsReassigned += commentCount;

    const { count: attCount } = await prisma.ticketAttachment.updateMany({
      where: { uploadedById: sourceId },
      data: { uploadedById: targetId },
    });
    stats.attachmentsReassigned += attCount;

    const { count: histCount } = await prisma.ticketHistory.updateMany({
      where: { actorId: sourceId },
      data: { actorId: targetId },
    });
    stats.historyRowsMoved += histCount;

    // 8. Organisation memberships
    const orgMembers = await prisma.organisationMember.findMany({ where: { userId: sourceId } });
    for (const m of orgMembers) {
      await prisma.organisationMember.delete({
        where: { organisationId_userId: { organisationId: m.organisationId, userId: sourceId } },
      }).catch(() => {});
      await prisma.organisationMember.upsert({
        where: { organisationId_userId: { organisationId: m.organisationId, userId: targetId } },
        create: { organisationId: m.organisationId, userId: targetId, role: m.role },
        update: {},
      });
      stats.orgMembersMoved++;
    }

    // 9. Company memberships
    const companyMembers = await prisma.companyMember.findMany({ where: { userId: sourceId } });
    for (const m of companyMembers) {
      await prisma.companyMember.delete({
        where: { companyId_userId: { companyId: m.companyId, userId: sourceId } },
      }).catch(() => {});
      await prisma.companyMember.upsert({
        where: { companyId_userId: { companyId: m.companyId, userId: targetId } },
        create: { companyId: m.companyId, userId: targetId, role: m.role },
        update: {},
      });
      stats.companyMembersMoved++;
    }

    // 10. Ticket watchers
    const watches = await prisma.ticketWatcher.findMany({ where: { userId: sourceId } });
    for (const w of watches) {
      await prisma.ticketWatcher.delete({
        where: { ticketId_userId: { ticketId: w.ticketId, userId: sourceId } },
      }).catch(() => {});
      const exists = await prisma.ticketWatcher.findUnique({
        where: { ticketId_userId: { ticketId: w.ticketId, userId: targetId } },
      });
      if (!exists) {
        await prisma.ticketWatcher.create({ data: { ticketId: w.ticketId, userId: targetId } });
      }
      stats.watchersMoved++;
    }

    // 11. Ticket votes
    const votes = await prisma.ticketVote.findMany({ where: { userId: sourceId } });
    for (const v of votes) {
      await prisma.ticketVote.delete({
        where: { ticketId_userId: { ticketId: v.ticketId, userId: sourceId } },
      }).catch(() => {});
      const exists = await prisma.ticketVote.findUnique({
        where: { ticketId_userId: { ticketId: v.ticketId, userId: targetId } },
      });
      if (!exists) {
        await prisma.ticketVote.create({ data: { ticketId: v.ticketId, userId: targetId } });
      }
      stats.votesMoved++;
    }

    // 12. Sprint retrospectives
    const { count: retroCount } = await prisma.sprintRetrospective.updateMany({
      where: { authorId: sourceId },
      data: { authorId: targetId },
    });
    stats.retrosMoved += retroCount;

    // 13. Project docs
    const { count: docCount } = await prisma.projectDoc.updateMany({
      where: { authorId: sourceId },
      data: { authorId: targetId },
    });
    stats.docsMoved += docCount;

    // 14. Notifications
    const { count: notifCount } = await prisma.notification.updateMany({
      where: { userId: sourceId },
      data: { userId: targetId },
    });
    stats.notificationsMoved += notifCount;

    // 14b. GitHub identity, mapped events, and daily summaries
    const sourceGitHubIdentity = await prisma.userGitHubIdentity.findUnique({
      where: { userId: sourceId },
    });
    if (sourceGitHubIdentity) {
      const targetGitHubIdentity = await prisma.userGitHubIdentity.findUnique({
        where: { userId: targetId },
      });
      if (!targetGitHubIdentity) {
        await prisma.userGitHubIdentity.update({
          where: { userId: sourceId },
          data: { userId: targetId },
        });
      } else {
        await prisma.userGitHubIdentity.delete({ where: { userId: sourceId } }).catch(() => {});
      }
    }
    await prisma.gitHubActivityEvent.updateMany({
      where: { mappedUserId: sourceId },
      data: { mappedUserId: targetId },
    });

    const sourceGitHubSummaries = await prisma.gitHubDailySummary.findMany({
      where: { userId: sourceId },
    });
    for (const summary of sourceGitHubSummaries) {
      const twin = await prisma.gitHubDailySummary.findUnique({
        where: {
          projectId_userId_date: {
            projectId: summary.projectId,
            userId: targetId,
            date: summary.date,
          },
        },
      });
      if (twin) {
        await prisma.gitHubDailySummary.update({
          where: { id: twin.id },
          data: {
            commits: twin.commits + summary.commits,
            pullRequestsOpened: twin.pullRequestsOpened + summary.pullRequestsOpened,
            pullRequestsMerged: twin.pullRequestsMerged + summary.pullRequestsMerged,
            reviewsSubmitted: twin.reviewsSubmitted + summary.reviewsSubmitted,
            issuesUpdated: twin.issuesUpdated + summary.issuesUpdated,
            checksPassed: twin.checksPassed + summary.checksPassed,
            checksFailed: twin.checksFailed + summary.checksFailed,
            projectItemsMoved: twin.projectItemsMoved + summary.projectItemsMoved,
            summary: [twin.summary, summary.summary].filter(Boolean).join(' '),
            plannedNext: [twin.plannedNext, summary.plannedNext].filter(Boolean).join(' '),
          },
        });
        await prisma.gitHubDailySummary.delete({ where: { id: summary.id } });
      } else {
        await prisma.gitHubDailySummary.update({
          where: { id: summary.id },
          data: { userId: targetId },
        });
      }
    }

    // 15. Timesheets
    const tsRows = await prisma.timesheet.findMany({ where: { userId: sourceId } });
    for (const ts of tsRows) {
      const twin = await prisma.timesheet.findFirst({
        where: { userId: targetId, date: ts.date, ticketId: ts.ticketId },
      });
      if (twin) {
        const mergedDesc = [twin.description, ts.description].filter(Boolean).join(' · ');
        await prisma.timesheet.update({
          where: { id: twin.id },
          data: { hours: twin.hours + ts.hours, ...(mergedDesc ? { description: mergedDesc } : {}) },
        });
        await prisma.timesheet.delete({ where: { id: ts.id } });
      } else {
        await prisma.timesheet.update({ where: { id: ts.id }, data: { userId: targetId } });
      }
      stats.timesheetsMerged++;
    }

    // 16. User availability
    const avRows = await prisma.userAvailability.findMany({ where: { userId: sourceId } });
    for (const a of avRows) {
      const twin = await prisma.userAvailability.findUnique({
        where: { userId_date: { userId: targetId, date: a.date } },
      });
      if (twin) {
        await prisma.userAvailability.delete({ where: { id: a.id } });
      } else {
        await prisma.userAvailability.update({ where: { id: a.id }, data: { userId: targetId } });
      }
      stats.availabilityMerged++;
    }

    // 17. Developer metrics (daily)
    const targetDailyKeys = await prisma.developerMetricDaily.findMany({
      where: { userId: targetId },
      select: { date: true, projectId: true },
    });
    for (const k of targetDailyKeys) {
      await prisma.developerMetricDaily.deleteMany({
        where: {
          userId: sourceId,
          date: k.date,
          ...(k.projectId == null ? { projectId: null } : { projectId: k.projectId }),
        },
      });
    }
    const { count: dailyCount } = await prisma.developerMetricDaily.updateMany({
      where: { userId: sourceId },
      data: { userId: targetId },
    });
    stats.metricRowsMoved += dailyCount;

    // 18. Developer metrics (weekly)
    const targetWeeks = await prisma.developerMetricWeekly.findMany({
      where: { userId: targetId },
      select: { weekStart: true },
    });
    for (const w of targetWeeks) {
      await prisma.developerMetricWeekly.deleteMany({
        where: { userId: sourceId, weekStart: w.weekStart },
      });
    }
    const { count: weeklyCount } = await prisma.developerMetricWeekly.updateMany({
      where: { userId: sourceId },
      data: { userId: targetId },
    });
    stats.metricRowsMoved += weeklyCount;

    // 19. Scorecard, trends, workload, insight, predictive risk, bottleneck, AI logs
    await prisma.developerScorecard.deleteMany({ where: { userId: sourceId } });

    const targetTrends = await prisma.developerTrend.findMany({
      where: { userId: targetId },
      select: { period: true, metric: true },
    });
    for (const tr of targetTrends) {
      await prisma.developerTrend.deleteMany({
        where: { userId: sourceId, period: tr.period, metric: tr.metric },
      });
    }
    await prisma.developerTrend.updateMany({ where: { userId: sourceId }, data: { userId: targetId } });
    await prisma.workloadSnapshot.updateMany({ where: { userId: sourceId }, data: { userId: targetId } });
    await prisma.insightEvent.updateMany({ where: { userId: sourceId }, data: { userId: targetId } });
    await prisma.predictiveRisk.updateMany({ where: { userId: sourceId }, data: { userId: targetId } });
    await prisma.bottleneckEvent.updateMany({ where: { userId: sourceId }, data: { userId: targetId } });
    await prisma.aiQueryLog.updateMany({ where: { userId: sourceId }, data: { userId: targetId } });
    await prisma.sprintTicket.updateMany({ where: { addedBy: sourceId }, data: { addedBy: targetId } });
    await prisma.excelImport.updateMany({ where: { importedBy: sourceId }, data: { importedBy: targetId } });
    await prisma.sheetSyncConfig.updateMany({ where: { createdBy: sourceId }, data: { createdBy: targetId } });
    await prisma.project.updateMany({ where: { ownerId: sourceId }, data: { ownerId: targetId } });
    await prisma.team.updateMany({ where: { leadId: sourceId }, data: { leadId: targetId } });

    // 20. Audit logs
    const { count: auditCount } = await prisma.auditLog.updateMany({
      where: { actorId: sourceId },
      data: { actorId: targetId },
    });
    stats.auditRowsMoved += auditCount;

    // 21. Deactivate source (tombstone email)
    await prisma.user.update({
      where: { id: sourceId },
      data: { deletedAt: new Date(), status: 'INACTIVE', email: tombstoneEmail(sourceId) },
    });
    stats.sourcesDeactivated.push(sourceId);
  }

  // Snapshot target after all merges
  const targetAfter = await snapshotUser(targetId);

  // Write comprehensive audit log entry
  const auditMetadata = {
    operation: 'user_merge',
    targetId,
    sourceIds: uniqueSources,
    stats: { ...stats, sourcesDeactivated: undefined },
    sourcesDeactivated: stats.sourcesDeactivated,
    sourcesSnapshot: sourcesBefore,
  };

  await prisma.auditLog.create({
    data: {
      actorId: actorId ?? null,
      actorEmail: actorId
        ? (await prisma.user.findFirst({ where: { id: actorId }, select: { email: true } }))?.email ?? null
        : null,
      action: 'user_merge',
      resource: 'user',
      resourceId: targetId,
      before: targetBefore as object,
      after: targetAfter as object,
      metadata: auditMetadata as object,
    },
  });

  return { merged: uniqueSources.length, stats };
}

function emptyStats(): MergeStats {
  return {
    mergedSourceCount: 0,
    projectMembershipsMoved: 0,
    teamMembershipsMoved: 0,
    rolesMoved: 0,
    ticketsReassigned: 0,
    commentsReassigned: 0,
    attachmentsReassigned: 0,
    historyRowsMoved: 0,
    orgMembersMoved: 0,
    companyMembersMoved: 0,
    watchersMoved: 0,
    votesMoved: 0,
    retrosMoved: 0,
    docsMoved: 0,
    notificationsMoved: 0,
    timesheetsMerged: 0,
    availabilityMerged: 0,
    metricRowsMoved: 0,
    auditRowsMoved: 0,
    sourcesDeactivated: [],
  };
}
