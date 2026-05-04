import { prisma } from '../utils/prisma';
import { AppError } from '../middleware/errorHandler';

export async function mergeUsersIntoTarget(targetId: string, sourceIds: string[]) {
  const uniqueSources = [...new Set(sourceIds.filter((id) => id && id !== targetId))];
  if (!uniqueSources.length) return { merged: 0 };

  const [target, sources] = await Promise.all([
    prisma.user.findFirst({ where: { id: targetId, deletedAt: null } }),
    prisma.user.findMany({ where: { id: { in: uniqueSources }, deletedAt: null } }),
  ]);

  if (!target) throw new AppError(404, 'Target user not found', 'NOT_FOUND');
  if (sources.length !== uniqueSources.length) {
    throw new AppError(404, 'One or more source users not found', 'NOT_FOUND');
  }

  await prisma.$transaction(async (tx) => {
    for (const sourceId of uniqueSources) {
      await tx.refreshToken.deleteMany({ where: { userId: sourceId } });

      const memberships = await tx.projectMember.findMany({ where: { userId: sourceId } });
      for (const m of memberships) {
        await tx.projectMember.delete({
          where: { projectId_userId: { projectId: m.projectId, userId: sourceId } },
        });
        await tx.projectMember.upsert({
          where: { projectId_userId: { projectId: m.projectId, userId: targetId } },
          create: { projectId: m.projectId, userId: targetId, role: m.role },
          update: {},
        });
      }

      const teamMemberships = await tx.teamMember.findMany({ where: { userId: sourceId } });
      for (const tm of teamMemberships) {
        await tx.teamMember.delete({
          where: { teamId_userId: { teamId: tm.teamId, userId: sourceId } },
        });
        await tx.teamMember.upsert({
          where: { teamId_userId: { teamId: tm.teamId, userId: targetId } },
          create: { teamId: tm.teamId, userId: targetId, role: tm.role },
          update: {},
        });
      }

      const sourceRoles = await tx.userRole.findMany({ where: { userId: sourceId } });
      for (const r of sourceRoles) {
        await tx.userRole.upsert({
          where: { userId_roleId: { userId: targetId, roleId: r.roleId } },
          create: { userId: targetId, roleId: r.roleId, grantedBy: r.grantedBy },
          update: {},
        });
      }
      await tx.userRole.deleteMany({ where: { userId: sourceId } });

      await tx.ticket.updateMany({ where: { reporterId: sourceId }, data: { reporterId: targetId } });

      const ticketsWithSource = await tx.ticket.findMany({
        where: { assignees: { some: { id: sourceId } } },
        select: { id: true, assignees: { select: { id: true } } },
      });
      for (const t of ticketsWithSource) {
        const ids = new Set(t.assignees.map((a) => a.id));
        ids.delete(sourceId);
        ids.add(targetId);
        await tx.ticket.update({
          where: { id: t.id },
          data: {
            assignees: { set: [...ids].map((id) => ({ id })) },
          },
        });
      }

      await tx.ticketComment.updateMany({
        where: { authorId: sourceId },
        data: { authorId: targetId },
      });

      await tx.ticketAttachment.updateMany({
        where: { uploadedById: sourceId },
        data: { uploadedById: targetId },
      });

      await tx.ticketHistory.updateMany({
        where: { actorId: sourceId },
        data: { actorId: targetId },
      });

      await tx.notification.updateMany({
        where: { userId: sourceId },
        data: { userId: targetId },
      });

      await tx.timesheet.deleteMany({ where: { userId: sourceId } });
      await tx.userAvailability.deleteMany({ where: { userId: sourceId } });

      const targetDailyKeys = await tx.developerMetricDaily.findMany({
        where: { userId: targetId },
        select: { date: true, projectId: true },
      });
      for (const k of targetDailyKeys) {
        await tx.developerMetricDaily.deleteMany({
          where: {
            userId: sourceId,
            date: k.date,
            ...(k.projectId == null ? { projectId: null } : { projectId: k.projectId }),
          },
        });
      }
      await tx.developerMetricDaily.updateMany({
        where: { userId: sourceId },
        data: { userId: targetId },
      });

      const targetWeeks = await tx.developerMetricWeekly.findMany({
        where: { userId: targetId },
        select: { weekStart: true },
      });
      for (const w of targetWeeks) {
        await tx.developerMetricWeekly.deleteMany({
          where: { userId: sourceId, weekStart: w.weekStart },
        });
      }
      await tx.developerMetricWeekly.updateMany({
        where: { userId: sourceId },
        data: { userId: targetId },
      });

      await tx.developerScorecard.deleteMany({ where: { userId: sourceId } });

      const targetTrends = await tx.developerTrend.findMany({
        where: { userId: targetId },
        select: { period: true, metric: true },
      });
      for (const tr of targetTrends) {
        await tx.developerTrend.deleteMany({
          where: { userId: sourceId, period: tr.period, metric: tr.metric },
        });
      }
      await tx.developerTrend.updateMany({
        where: { userId: sourceId },
        data: { userId: targetId },
      });

      await tx.workloadSnapshot.updateMany({
        where: { userId: sourceId },
        data: { userId: targetId },
      });

      await tx.insightEvent.updateMany({
        where: { userId: sourceId },
        data: { userId: targetId },
      });

      await tx.auditLog.updateMany({
        where: { actorId: sourceId },
        data: { actorId: targetId },
      });

      await tx.predictiveRisk.updateMany({
        where: { userId: sourceId },
        data: { userId: targetId },
      });

      await tx.bottleneckEvent.updateMany({
        where: { userId: sourceId },
        data: { userId: targetId },
      });

      await tx.aiQueryLog.updateMany({
        where: { userId: sourceId },
        data: { userId: targetId },
      });

      await tx.sprintTicket.updateMany({
        where: { addedBy: sourceId },
        data: { addedBy: targetId },
      });

      await tx.excelImport.updateMany({
        where: { importedBy: sourceId },
        data: { importedBy: targetId },
      });

      await tx.sheetSyncConfig.updateMany({
        where: { createdBy: sourceId },
        data: { createdBy: targetId },
      });

      await tx.project.updateMany({
        where: { ownerId: sourceId },
        data: { ownerId: targetId },
      });

      await tx.team.updateMany({
        where: { leadId: sourceId },
        data: { leadId: targetId },
      });

      const tombstoneEmail = `merged.${sourceId.slice(0, 8)}.${Date.now()}@pms.merge`;
      await tx.user.update({
        where: { id: sourceId },
        data: {
          deletedAt: new Date(),
          status: 'INACTIVE',
          email: tombstoneEmail,
        },
      });
    }
  });

  return { merged: uniqueSources.length };
}
