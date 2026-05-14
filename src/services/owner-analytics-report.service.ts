import crypto from 'crypto';
import { OwnerAnalyticsCadence } from '@prisma/client';
import { prisma } from '../utils/prisma';
import { config } from '../utils/config';
import { logger } from '../utils/logger';
import { AppError } from '../middleware/errorHandler';
import { enqueueTransactionalEmail, type QueueEmailResult } from './email-dispatch.service';
import { markOwnerAnalyticsSent } from './email-preferences.service';
import { buildOwnerAnalyticsReportEmail } from './email-templates/owner-analytics-email.templates';

export type OwnerAnalyticsWindowPreset = 'daily' | 'weekly' | 'monthly' | 'custom';

export type OwnerAnalyticsWindow = {
  preset: OwnerAnalyticsWindowPreset;
  start: Date;
  end: Date;
  label: string;
  lookbackDays: number;
};

type OwnerAnalyticsUserSummary = {
  userId: string;
  name: string;
  email: string;
  commits: number;
  mergedPullRequests: number;
  openedPullRequests: number;
  reviews: number;
  issuesUpdated: number;
  ticketsCompleted: number;
  plannedNext: string[];
  projects: Set<string>;
};

type OwnerAnalyticsProjectSummary = {
  projectId: string;
  projectName: string;
  projectKey: string;
  commits: number;
  mergedPullRequests: number;
  contributors: Set<string>;
  ticketsCompleted: number;
  openRisks: number;
};

export type OwnerAnalyticsReport = {
  recipient: {
    id: string;
    email: string;
    firstName: string;
    lastName: string;
  };
  window: OwnerAnalyticsWindow;
  totals: {
    projects: number;
    contributors: number;
    commits: number;
    mergedPullRequests: number;
    ticketsCompleted: number;
    openRisks: number;
    unmappedEvents: number;
  };
  contributors: Array<
    Omit<OwnerAnalyticsUserSummary, 'projects'> & {
      projects: string[];
    }
  >;
  projects: Array<{
    projectId: string;
    projectName: string;
    projectKey: string;
    commits: number;
    mergedPullRequests: number;
    contributors: number;
    ticketsCompleted: number;
    openRisks: number;
  }>;
  followUps: string[];
};

function startOfDay(date: Date) {
  const next = new Date(date);
  next.setHours(0, 0, 0, 0);
  return next;
}

function cadenceToPreset(cadence: OwnerAnalyticsCadence | OwnerAnalyticsWindowPreset): OwnerAnalyticsWindowPreset {
  switch (cadence) {
    case 'DAILY':
    case 'daily':
      return 'daily';
    case 'WEEKLY':
    case 'weekly':
      return 'weekly';
    case 'MONTHLY':
    case 'monthly':
      return 'monthly';
    default:
      return 'custom';
  }
}

export function resolveOwnerAnalyticsWindow(args: {
  cadence: OwnerAnalyticsCadence | OwnerAnalyticsWindowPreset;
  lookbackDays?: number | null;
  now?: Date;
}): OwnerAnalyticsWindow {
  const preset = cadenceToPreset(args.cadence);
  const now = args.now ?? new Date();
  const lookbackDays =
    preset === 'daily'
      ? 1
      : preset === 'weekly'
        ? 7
        : preset === 'monthly'
          ? 30
          : Math.min(Math.max(args.lookbackDays ?? 14, 1), 365);

  const end = new Date(now);
  const start = startOfDay(now);
  start.setDate(start.getDate() - (lookbackDays - 1));

  const label =
    preset === 'daily'
      ? 'today so far'
      : preset === 'weekly'
        ? 'the last 7 days'
        : preset === 'monthly'
          ? 'the last 30 days'
          : `the last ${lookbackDays} days`;

  return { preset, start, end, label, lookbackDays };
}

function activityScore(summary: Pick<OwnerAnalyticsUserSummary, 'commits' | 'mergedPullRequests' | 'ticketsCompleted' | 'reviews'>) {
  return summary.commits + summary.mergedPullRequests * 2 + summary.ticketsCompleted * 2 + summary.reviews;
}

function shouldSendForCadence(args: {
  cadence: OwnerAnalyticsCadence;
  lookbackDays?: number | null;
  lastSentAt?: Date | null;
  now?: Date;
}) {
  const now = args.now ?? new Date();
  const today = startOfDay(now);
  const lastSentDay = args.lastSentAt ? startOfDay(args.lastSentAt) : null;

  if (args.cadence === 'DAILY') {
    return !lastSentDay || lastSentDay.getTime() < today.getTime();
  }

  if (args.cadence === 'WEEKLY') {
    if (now.getDay() !== 1) return false;
    if (!lastSentDay) return true;
    const sevenDaysAgo = new Date(today);
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 6);
    return lastSentDay.getTime() < sevenDaysAgo.getTime();
  }

  if (args.cadence === 'MONTHLY') {
    if (now.getDate() !== 1) return false;
    if (!lastSentDay) return true;
    return lastSentDay.getMonth() !== now.getMonth() || lastSentDay.getFullYear() !== now.getFullYear();
  }

  const intervalDays = Math.min(Math.max(args.lookbackDays ?? 14, 1), 365);
  if (!lastSentDay) return true;
  const nextDue = new Date(lastSentDay);
  nextDue.setDate(nextDue.getDate() + intervalDays);
  return today.getTime() >= nextDue.getTime();
}

export async function buildOwnerAnalyticsReport(
  recipientUserId: string,
  options?: { window?: OwnerAnalyticsWindow },
): Promise<OwnerAnalyticsReport> {
  const window = options?.window ?? resolveOwnerAnalyticsWindow({ cadence: 'daily' });
  const recipient = await prisma.user.findFirst({
    where: { id: recipientUserId, deletedAt: null, status: 'ACTIVE' },
    select: {
      id: true,
      email: true,
      firstName: true,
      lastName: true,
    },
  });
  if (!recipient) {
    throw new AppError(404, 'User not found', 'NOT_FOUND');
  }

  const [githubSummaries, completedTickets, openRisks, unmappedEvents] = await Promise.all([
    prisma.gitHubDailySummary.findMany({
      where: {
        date: { gte: window.start, lte: window.end },
      },
      include: {
        user: { select: { id: true, firstName: true, lastName: true, email: true } },
        project: { select: { id: true, name: true, key: true } },
      },
      orderBy: [{ date: 'desc' }, { commits: 'desc' }],
    }),
    prisma.ticket.findMany({
      where: {
        deletedAt: null,
        completedAt: { gte: window.start, lte: window.end },
      },
      select: {
        id: true,
        title: true,
        project: { select: { id: true, name: true, key: true } },
        assignees: { select: { id: true, firstName: true, lastName: true, email: true } },
      },
    }),
    prisma.predictiveRisk.findMany({
      where: { resolved: false },
      select: {
        projectId: true,
        severity: true,
      },
    }),
    prisma.gitHubActivityEvent.count({
      where: {
        occurredAt: { gte: window.start, lte: window.end },
        mappedUserId: null,
      },
    }),
  ]);

  const userSummaries = new Map<string, OwnerAnalyticsUserSummary>();
  const projectSummaries = new Map<string, OwnerAnalyticsProjectSummary>();

  for (const row of githubSummaries) {
    const userBucket =
      userSummaries.get(row.userId) ?? {
        userId: row.userId,
        name: `${row.user.firstName} ${row.user.lastName}`.trim(),
        email: row.user.email,
        commits: 0,
        mergedPullRequests: 0,
        openedPullRequests: 0,
        reviews: 0,
        issuesUpdated: 0,
        ticketsCompleted: 0,
        plannedNext: [],
        projects: new Set<string>(),
      };

    userBucket.commits += row.commits;
    userBucket.mergedPullRequests += row.pullRequestsMerged;
    userBucket.openedPullRequests += row.pullRequestsOpened;
    userBucket.reviews += row.reviewsSubmitted;
    userBucket.issuesUpdated += row.issuesUpdated;
    if (row.plannedNext) userBucket.plannedNext.push(row.plannedNext);
    userBucket.projects.add(row.project.name);
    userSummaries.set(row.userId, userBucket);

    const projectBucket =
      projectSummaries.get(row.projectId) ?? {
        projectId: row.projectId,
        projectName: row.project.name,
        projectKey: row.project.key,
        commits: 0,
        mergedPullRequests: 0,
        contributors: new Set<string>(),
        ticketsCompleted: 0,
        openRisks: 0,
      };

    projectBucket.commits += row.commits;
    projectBucket.mergedPullRequests += row.pullRequestsMerged;
    projectBucket.contributors.add(row.userId);
    projectSummaries.set(row.projectId, projectBucket);
  }

  for (const ticket of completedTickets) {
    let projectBucket = projectSummaries.get(ticket.project.id);
    if (!projectBucket) {
      projectBucket = {
        projectId: ticket.project.id,
        projectName: ticket.project.name,
        projectKey: ticket.project.key,
        commits: 0,
        mergedPullRequests: 0,
        contributors: new Set<string>(),
        ticketsCompleted: 0,
        openRisks: 0,
      };
    }
    projectBucket.ticketsCompleted += 1;
    projectSummaries.set(ticket.project.id, projectBucket);

    for (const assignee of ticket.assignees) {
      let userBucket = userSummaries.get(assignee.id);
      if (!userBucket) {
        userBucket = {
          userId: assignee.id,
          name: `${assignee.firstName} ${assignee.lastName}`.trim(),
          email: assignee.email,
          commits: 0,
          mergedPullRequests: 0,
          openedPullRequests: 0,
          reviews: 0,
          issuesUpdated: 0,
          ticketsCompleted: 0,
          plannedNext: [],
          projects: new Set<string>(),
        };
      }
      userBucket.ticketsCompleted += 1;
      userBucket.projects.add(ticket.project.name);
      userSummaries.set(assignee.id, userBucket);
      projectBucket.contributors.add(assignee.id);
    }
  }

  const riskOnlyProjectIds = [...new Set(openRisks.map((risk) => risk.projectId))].filter((projectId) => !projectSummaries.has(projectId));
  const riskProjectRows =
    riskOnlyProjectIds.length > 0
      ? await prisma.project.findMany({
          where: { id: { in: riskOnlyProjectIds } },
          select: { id: true, name: true, key: true },
        })
      : [];
  const riskProjectLookup = new Map(riskProjectRows.map((project) => [project.id, project]));

  for (const risk of openRisks) {
    const fallbackProject = riskProjectLookup.get(risk.projectId);
    const existing =
      projectSummaries.get(risk.projectId) ?? {
        projectId: risk.projectId,
        projectName: fallbackProject?.name ?? 'Unknown project',
        projectKey: fallbackProject?.key ?? 'PROJECT',
        commits: 0,
        mergedPullRequests: 0,
        contributors: new Set<string>(),
        ticketsCompleted: 0,
        openRisks: 0,
      };
    existing.openRisks += 1;
    projectSummaries.set(risk.projectId, existing);
  }

  const contributors = [...userSummaries.values()]
    .sort((a, b) => activityScore(b) - activityScore(a))
    .map((entry) => ({
      ...entry,
      plannedNext: [...new Set(entry.plannedNext)].slice(0, 2),
      projects: [...entry.projects].sort(),
    }));

  const projects = [...projectSummaries.values()]
    .sort((a, b) => b.commits + b.ticketsCompleted - (a.commits + a.ticketsCompleted))
    .map((entry) => ({
      projectId: entry.projectId,
      projectName: entry.projectName,
      projectKey: entry.projectKey,
      commits: entry.commits,
      mergedPullRequests: entry.mergedPullRequests,
      contributors: entry.contributors.size,
      ticketsCompleted: entry.ticketsCompleted,
      openRisks: entry.openRisks,
    }));

  const followUps: string[] = [];
  const pendingPlans = contributors
    .flatMap((entry) => entry.plannedNext.map((plannedNext) => `${entry.name}: ${plannedNext}`))
    .slice(0, 4);
  followUps.push(...pendingPlans);
  if (unmappedEvents > 0) {
    followUps.push(`${unmappedEvents} GitHub event${unmappedEvents === 1 ? '' : 's'} in this window still need a PMS user mapping.`);
  }
  const riskProjects = projects.filter((project) => project.openRisks > 0).slice(0, 3);
  followUps.push(...riskProjects.map((project) => `${project.projectKey}: ${project.openRisks} unresolved predictive risk${project.openRisks === 1 ? '' : 's'}.`));

  return {
    recipient,
    window,
    totals: {
      projects: projects.length,
      contributors: contributors.length,
      commits: projects.reduce((sum, project) => sum + project.commits, 0),
      mergedPullRequests: projects.reduce((sum, project) => sum + project.mergedPullRequests, 0),
      ticketsCompleted: projects.reduce((sum, project) => sum + project.ticketsCompleted, 0),
      openRisks: projects.reduce((sum, project) => sum + project.openRisks, 0),
      unmappedEvents,
    },
    contributors,
    projects,
    followUps: [...new Set(followUps)].filter(Boolean),
  };
}

export async function sendOwnerAnalyticsReport(
  recipientUserId: string,
  args?: { window?: OwnerAnalyticsWindow; source?: 'manual' | 'scheduled' },
): Promise<{ report: OwnerAnalyticsReport; queue: QueueEmailResult }> {
  const report = await buildOwnerAnalyticsReport(recipientUserId, { window: args?.window });
  const subject = `Owner analytics report for ${report.window.label}`;
  const template = buildOwnerAnalyticsReportEmail({
    firstName: report.recipient.firstName,
    subject,
    windowLabel: report.window.label,
    summaryLines: [
      `${report.totals.projects} active project rollups in scope`,
      `${report.totals.contributors} contributors with mapped activity`,
      `${report.totals.commits} commits, ${report.totals.mergedPullRequests} merged PRs, ${report.totals.ticketsCompleted} tickets completed`,
      `${report.totals.openRisks} open predictive risks and ${report.totals.unmappedEvents} unmapped GitHub events`,
    ],
    contributorLines: report.contributors
      .slice(0, 5)
      .map(
        (entry) =>
          `${entry.name}: ${entry.commits} commits, ${entry.mergedPullRequests} merged PRs, ${entry.ticketsCompleted} tickets completed${entry.projects.length ? ` across ${entry.projects.join(', ')}` : ''}.`,
      ),
    projectLines: report.projects
      .slice(0, 5)
      .map(
        (entry) =>
          `[${entry.projectKey}] ${entry.projectName}: ${entry.commits} commits, ${entry.ticketsCompleted} tickets completed, ${entry.contributors} contributors, ${entry.openRisks} open risks.`,
      ),
    followUpLines: report.followUps.slice(0, 5),
    actionHref: `${config.app.baseUrl.replace(/\/$/, '')}/analytics`,
  });

  const queue = await enqueueTransactionalEmail({
    userId: report.recipient.id,
    to: report.recipient.email,
    template,
    eventType: 'OWNER_ANALYTICS_REPORT',
    resourceType: 'owner-analytics-report',
    resourceId: report.recipient.id,
    fingerprint: crypto
      .createHash('sha1')
      .update(
        [
          'owner-analytics-report',
          report.recipient.id,
          report.window.start.toISOString(),
          report.window.end.toISOString(),
          args?.source ?? 'manual',
        ].join('|'),
      )
      .digest('hex'),
    metadata: {
      source: args?.source ?? 'manual',
      windowStart: report.window.start.toISOString(),
      windowEnd: report.window.end.toISOString(),
      lookbackDays: report.window.lookbackDays,
      totals: report.totals,
    },
    bypassPreferences: args?.source === 'manual',
  });

  if (queue.queued) {
    await markOwnerAnalyticsSent(report.recipient.id, new Date());
  }

  return { report, queue };
}

export async function sendScheduledOwnerAnalyticsReports(now = new Date()) {
  const recipients = await prisma.user.findMany({
    where: {
      deletedAt: null,
      status: 'ACTIVE',
      emailPreferences: {
        is: {
          ownerAnalyticsEnabled: true,
        },
      },
    },
    select: {
      id: true,
      email: true,
      firstName: true,
      emailPreferences: {
        select: {
          ownerAnalyticsCadence: true,
          ownerAnalyticsLookbackDays: true,
          lastOwnerAnalyticsSentAt: true,
        },
      },
    },
  });

  const results: Array<{ userId: string; queued: boolean; reason?: string }> = [];

  for (const recipient of recipients) {
    if (!recipient.emailPreferences) continue;
    const shouldSend = shouldSendForCadence({
      cadence: recipient.emailPreferences.ownerAnalyticsCadence,
      lookbackDays: recipient.emailPreferences.ownerAnalyticsLookbackDays,
      lastSentAt: recipient.emailPreferences.lastOwnerAnalyticsSentAt,
      now,
    });
    if (!shouldSend) continue;

    const window = resolveOwnerAnalyticsWindow({
      cadence: recipient.emailPreferences.ownerAnalyticsCadence,
      lookbackDays: recipient.emailPreferences.ownerAnalyticsLookbackDays,
      now,
    });

    try {
      const { queue } = await sendOwnerAnalyticsReport(recipient.id, { window, source: 'scheduled' });
      results.push({
        userId: recipient.id,
        queued: queue.queued,
        reason: queue.queued ? undefined : queue.reason,
      });
    } catch (error) {
      logger.error({ err: error, userId: recipient.id }, 'Owner analytics report send failed');
      results.push({ userId: recipient.id, queued: false, reason: 'failed' });
    }
  }

  return results;
}
