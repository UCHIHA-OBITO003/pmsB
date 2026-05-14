import cron from 'node-cron';
import { logger } from '../utils/logger';
import { prisma } from '../utils/prisma';
import { CRON_MANIFEST } from './definitions';
import { sendDailyTicketDigests } from '../services/ticket-notification.service';
import { enqueueGitHubProjectSync } from '../queues';
import { generateGitHubDailySummaries } from '../services/github.service';
import { sendScheduledOwnerAnalyticsReports } from '../services/owner-analytics-report.service';

const [cronDevDaily, cronSheetSync, cronBottleneck, cronTicketDigest, cronGitHubSync, cronGitHubSummary, cronOwnerAnalytics] =
  CRON_MANIFEST;

export function startCrons() {
  // Daily developer metrics — runs at 2 AM
  cron.schedule(cronDevDaily.schedule, async () => {
    logger.info('Running daily developer metrics cron');
    try {
      await computeDeveloperMetrics();
    } catch (err) {
      logger.error({ err }, 'Developer metrics cron failed');
    }
  });

  // Google Sheet auto-sync — every 30 minutes (uses SheetSyncConfig table)
  cron.schedule(cronSheetSync.schedule, async () => {
    const { config } = await import('../utils/config');
    if (!config.features.googleSheets) return;

    logger.info('Running Google Sheet sync cron');
    try {
      const { excelImportService } = await import('../services/excel-import.service');

      // Primary: sync from DB-persisted configs
      await excelImportService.runAllSyncConfigs();

      // Fallback: if no configs exist, use env-configured sheet + sync to all active projects
      if (config.google.sheetId && config.google.serviceAccountPath) {
        const configCount = await (prisma as any).sheetSyncConfig.count({ where: { isEnabled: true } }).catch(() => 0);
        if (configCount === 0) {
          logger.info('No DB configs found, using env GOOGLE_SHEET_ID fallback');
          const projects = await prisma.project.findMany({ where: { status: 'ACTIVE', deletedAt: null } });
          for (const project of projects) {
            await excelImportService.syncGoogleSheet(config.google.sheetId, project.id, 'system').catch(() => {});
          }
        }
      }
    } catch (err) {
      logger.error({ err }, 'Sheet sync cron failed');
    }
  });

  // Bottleneck detection — every hour
  cron.schedule(cronBottleneck.schedule, async () => {
    logger.info('Running bottleneck detection cron');
    try {
      await detectBottlenecks();
    } catch (err) {
      logger.error({ err }, 'Bottleneck detection failed');
    }
  });

  cron.schedule(cronTicketDigest.schedule, async () => {
    const { config } = await import('../utils/config');
    if (!config.features.email) return;

    logger.info('Running daily ticket email digest cron');
    try {
      await sendDailyTicketDigests();
    } catch (err) {
      logger.error({ err }, 'Daily ticket email digest cron failed');
    }
  });

  cron.schedule(cronGitHubSync.schedule, async () => {
    const { config } = await import('../utils/config');
    if (!config.features.github) return;

    logger.info('Running GitHub project sync cron');
    try {
      const links = await prisma.projectGitHubLink.findMany({
        where: { status: 'ACTIVE', syncEnabled: true },
        select: { id: true },
      });
      for (const link of links) {
        await enqueueGitHubProjectSync({
          type: 'sync-project-link',
          projectGitHubLinkId: link.id,
        }).catch(() => {});
      }
    } catch (err) {
      logger.error({ err }, 'GitHub project sync cron failed');
    }
  });

  cron.schedule(cronGitHubSummary.schedule, async () => {
    const { config } = await import('../utils/config');
    if (!config.features.github) return;

    logger.info('Running GitHub daily summary cron');
    try {
      await generateGitHubDailySummaries(new Date());
    } catch (err) {
      logger.error({ err }, 'GitHub daily summary cron failed');
    }
  });

  cron.schedule(cronOwnerAnalytics.schedule, async () => {
    const { config } = await import('../utils/config');
    if (!config.features.email) return;

    logger.info('Running owner analytics report cron');
    try {
      await sendScheduledOwnerAnalyticsReports(new Date());
    } catch (err) {
      logger.error({ err }, 'Owner analytics report cron failed');
    }
  });

  logger.info('All cron jobs registered');
}

async function computeDeveloperMetrics() {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const users = await prisma.user.findMany({
    where: { status: 'ACTIVE', deletedAt: null },
    select: { id: true },
  });

  for (const user of users) {
    const [ticketsDone, reopened, blocked] = await prisma.$transaction([
      prisma.ticket.count({
        where: { assignees: { some: { id: user.id } }, completedAt: { gte: today }, deletedAt: null },
      }),
      prisma.ticketHistory.count({
        where: { actorId: user.id, field: 'workflowStateId', createdAt: { gte: today } },
      }),
      prisma.ticket.count({
        where: { assignees: { some: { id: user.id } }, workflowState: { slug: 'blocked' }, deletedAt: null },
      }),
    ]);

    const storyPointsDone = await prisma.ticket.aggregate({
      where: { assignees: { some: { id: user.id } }, completedAt: { gte: today }, deletedAt: null },
      _sum: { storyPoints: true },
    });

    const dailyRow = await prisma.developerMetricDaily.findFirst({
      where: { userId: user.id, date: today, projectId: null },
    });
    const dailyPayload = {
      ticketsDone,
      storyPointsDone: storyPointsDone._sum.storyPoints || 0,
      blockedHours: blocked * 8,
    };
    if (dailyRow) {
      await prisma.developerMetricDaily.update({
        where: { id: dailyRow.id },
        data: dailyPayload,
      });
    } else {
      await prisma.developerMetricDaily.create({
        data: {
          userId: user.id,
          date: today,
          projectId: null,
          ...dailyPayload,
        },
      });
    }

    // Compute scorecard
    const deliveryScore = Math.min(100, ticketsDone * 10 + (storyPointsDone._sum.storyPoints || 0) * 2);
    const qualityScore = Math.max(0, 100 - reopened * 10);
    const totalScore = deliveryScore * 0.3 + qualityScore * 0.3 + 60 * 0.4; // simplified

    const band = totalScore >= 90 ? 'top'
      : totalScore >= 75 ? 'strong'
        : totalScore >= 60 ? 'avg'
          : totalScore >= 40 ? 'attention' : 'risk';

    await prisma.developerScorecard.upsert({
      where: { userId: user.id },
      create: { userId: user.id, deliveryScore, qualityScore, totalScore, band },
      update: { deliveryScore, qualityScore, totalScore, band, computedAt: new Date() },
    });
  }
}

async function detectBottlenecks() {
  const staleCutoff = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);

  const staleTickets = await prisma.ticket.findMany({
    where: {
      deletedAt: null,
      workflowState: { slug: { in: ['in_progress', 'blocked'] } },
      updatedAt: { lt: staleCutoff },
    },
    select: { id: true, projectId: true, assignees: { select: { id: true } }, updatedAt: true },
  });

  for (const ticket of staleTickets) {
    const staleDays = Math.floor((Date.now() - ticket.updatedAt.getTime()) / 86400000);

    for (const assignee of ticket.assignees) {
      await prisma.insightEvent.create({
        data: {
          projectId: ticket.projectId,
          userId: assignee.id,
          type: 'stuck_ticket',
          title: 'Ticket stale',
          body: `Ticket has had no updates for ${staleDays} days`,
          severity: staleDays > 7 ? 'critical' : staleDays > 5 ? 'warning' : 'info',
          metadata: { ticketId: ticket.id },
        },
      }).catch(() => {}); // Ignore duplicates
    }
  }
}
