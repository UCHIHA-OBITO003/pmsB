import { Router } from 'express';
import type { Prisma } from '@prisma/client';
import { prisma } from '../utils/prisma';
import { authenticate, requirePermission } from '../middleware/auth';
import {
  applyCodemagenTicketVisibility,
  applyCodemagenUserVisibility,
  filterVisibleUsers,
  getCodemagenEnabled,
} from '../utils/system-settings';
import { getGitHubAnalyticsOverview } from '../services/github.service';

const router = Router();
router.use(authenticate);

// GET /api/analytics/users
router.get('/users', requirePermission('analytics', 'read'), async (req, res) => {
  const { projectId } = req.query as { projectId?: string };
  const where: Prisma.UserWhereInput = {};
  if (projectId) where.projectMemberships = { some: { projectId } };
  applyCodemagenUserVisibility(where, await getCodemagenEnabled());

  const users = await prisma.user.findMany({
    where,
    select: { id: true, firstName: true, lastName: true, avatar: true },
    orderBy: { firstName: 'asc' },
  });
  res.json({ success: true, data: users });
});

router.get('/github', requirePermission('analytics', 'read'), async (req, res) => {
  const { projectId, days = '7' } = req.query as { projectId?: string; days?: string };
  const data = await getGitHubAnalyticsOverview(projectId, Math.min(Math.max(parseInt(days) || 7, 1), 30));
  res.json({ success: true, data });
});

// GET /api/analytics/developer/:id
router.get('/developer/:id', requirePermission('analytics', 'read'), async (req, res) => {
  const { period = '30d' } = req.query as { period?: string };
  const days = period === '7d' ? 7 : period === '30d' ? 30 : period === '90d' ? 90 : period === '6m' ? 180 : period === '1y' ? 365 : 3650; // default max 10 years for 'all'
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const [scorecard, dailyMetrics, trends, allTickets] = await prisma.$transaction([
    prisma.developerScorecard.findUnique({ where: { userId: req.params.id } }),
    prisma.developerMetricDaily.findMany({
      where: { userId: req.params.id, date: { gte: since } },
      orderBy: { date: 'asc' },
    }),
    prisma.developerTrend.findMany({ where: { userId: req.params.id, period } }),
    prisma.ticket.findMany({
      where: { assignees: { some: { id: req.params.id } }, deletedAt: null },
      select: { id: true, type: true, module: true, workflowState: { select: { name: true, slug: true } } }
    })
  ]);

  // Aggregate real-time stats
  const typeBreakdown = allTickets.reduce((acc, t) => {
    acc[t.type] = (acc[t.type] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);

  const moduleBreakdown = allTickets.reduce((acc, t) => {
    const mod = t.module || 'Unassigned';
    acc[mod] = (acc[mod] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);

  const statusBreakdown = allTickets.reduce((acc, t) => {
    const status = t.workflowState?.name || 'Todo';
    acc[status] = (acc[status] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);

  res.json({
    success: true,
    data: {
      scorecard,
      dailyMetrics,
      trends,
      typeBreakdown,
      moduleBreakdown,
      statusBreakdown,
      totalTickets: allTickets.length,
      radar: scorecard
        ? [
            { metric: 'Delivery', value: Math.round(Number(scorecard.deliveryScore) || 0) },
            { metric: 'Quality', value: Math.round(Number(scorecard.qualityScore) || 0) },
            { metric: 'Efficiency', value: Math.round(Number(scorecard.efficiencyScore) || 0) },
            { metric: 'Collaboration', value: Math.round(Number(scorecard.collaborationScore) || 0) },
            { metric: 'Reliability', value: Math.round(Number(scorecard.reliabilityScore) || 0) },
          ]
        : [],
    },
  });
});

// GET /api/analytics/team/:id
router.get('/team/:id', requirePermission('analytics', 'read'), async (req, res) => {
  const analytics = await prisma.teamAnalytic.findMany({
    where: { teamId: req.params.id },
    orderBy: { computedAt: 'desc' },
    take: 10,
  });
  res.json({ success: true, data: analytics });
});

// GET /api/analytics/project/:id
router.get('/project/:id', requirePermission('analytics', 'read'), async (req, res) => {
  const [analytics, sprints, workload] = await prisma.$transaction([
    prisma.projectAnalytic.findMany({
      where: { projectId: req.params.id },
      orderBy: { computedAt: 'desc' },
      take: 10,
    }),
    prisma.sprintAnalytic.findMany({
      where: { projectId: req.params.id },
      orderBy: { computedAt: 'desc' },
      take: 10,
    }),
    prisma.workloadSnapshot.findMany({
      where: { projectId: req.params.id, date: { gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) } },
      orderBy: { date: 'asc' },
    }),
  ]);

  res.json({ success: true, data: { analytics, sprints, workload } });
});

// GET /api/analytics/workload-heatmap
router.get('/workload-heatmap', requirePermission('analytics', 'read'), async (req, res) => {
  const { projectId } = req.query as { projectId?: string };
  const since = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
  const codemagenEnabled = await getCodemagenEnabled();

  const snapshots = await prisma.workloadSnapshot.findMany({
    where: {
      ...(projectId ? { projectId } : {}),
      date: { gte: since },
    },
    include: { user: { select: { firstName: true, lastName: true, department: true } } },
    orderBy: [{ date: 'asc' }, { userId: 'asc' }],
  });

  res.json({
    success: true,
    data: snapshots.filter((row) => filterVisibleUsers([row.user], codemagenEnabled).length > 0),
  });
});

// GET /api/analytics/tickets
router.get('/tickets', requirePermission('analytics', 'read'), async (req, res) => {
  const { projectId, period = '30d' } = req.query as { projectId?: string; period?: string };
  const days = period === '7d' ? 7 : period === '30d' ? 30 : period === '90d' ? 90 : period === '6m' ? 180 : period === '1y' ? 365 : 3650;
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const codemagenEnabled = await getCodemagenEnabled();

  const where: Prisma.TicketWhereInput = {
    deletedAt: null,
    createdAt: { gte: since },
  };
  applyCodemagenTicketVisibility(where, codemagenEnabled);
  if (projectId) where.projectId = projectId;

  const tickets = await prisma.ticket.findMany({
    where,
    select: {
      id: true,
      createdAt: true,
      completedAt: true,
      priority: true,
      type: true,
      workflowState: { select: { name: true, isFinal: true } }
    },
    orderBy: { createdAt: 'asc' }
  });

  // Aggregate creation vs resolution over time
  const timeSeries = new Map<string, { created: number, resolved: number }>();
  
  tickets.forEach(t => {
    const createdDate = t.createdAt.toISOString().split('T')[0];
    if (!timeSeries.has(createdDate)) timeSeries.set(createdDate, { created: 0, resolved: 0 });
    timeSeries.get(createdDate)!.created++;

    if (t.completedAt && t.completedAt >= since) {
      const resolvedDate = t.completedAt.toISOString().split('T')[0];
      if (!timeSeries.has(resolvedDate)) timeSeries.set(resolvedDate, { created: 0, resolved: 0 });
      timeSeries.get(resolvedDate)!.resolved++;
    }
  });

  const trendData = Array.from(timeSeries.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, stats]) => ({
      date: new Date(date).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }),
      ...stats
    }));

  const priorityBreakdown = tickets.reduce((acc, t) => {
    acc[t.priority] = (acc[t.priority] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);

  res.json({ success: true, data: { trendData, priorityBreakdown, totalTickets: tickets.length } });
});

router.get('/leaderboard', requirePermission('analytics', 'read'), async (req, res) => {
  const { department, limit = '25' } = req.query as { department?: string; limit?: string };
  const codemagenEnabled = await getCodemagenEnabled();
  const where: { user?: Prisma.UserWhereInput } = {};
  if (department || !codemagenEnabled) {
    const userWhere: Prisma.UserWhereInput[] = [];
    if (department) userWhere.push({ department });
    if (!codemagenEnabled) {
      userWhere.push({ department: { not: 'Codemagen' } });
    }
    where.user = userWhere.length === 1 ? userWhere[0] : { AND: userWhere };
  }

  const scores = await prisma.developerScorecard.findMany({
    where,
    orderBy: { totalScore: 'desc' },
    take: Math.min(parseInt(limit), 100),
    include: {
      user: { select: { id: true, firstName: true, lastName: true, avatar: true, department: true } },
    },
  });
  res.json({ success: true, data: scores });
});

// GET /api/analytics/velocity — daily ticket created/closed counts for a period with optional project + priority filter
router.get('/velocity', requirePermission('analytics', 'read'), async (req, res) => {
  const { projectId, priority, days: daysStr = '30' } = req.query as {
    projectId?: string; priority?: string; days?: string;
  };
  const days = Math.min(Math.max(parseInt(daysStr) || 30, 1), 365);
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const codemagenEnabled = await getCodemagenEnabled();

  const where: Prisma.TicketWhereInput = { deletedAt: null };
  applyCodemagenTicketVisibility(where, codemagenEnabled);
  if (projectId) where.projectId = projectId;
  if (priority) where.priority = priority as any;

  const tickets = await prisma.ticket.findMany({
    where,
    select: { id: true, createdAt: true, completedAt: true, priority: true, source: true },
  });

  // Build day-by-day map for the window
  const map = new Map<string, { created: number; resolved: number; inProgress: number }>();
  for (let d = 0; d < days; d++) {
    const dt = new Date(since.getTime() + d * 86400000);
    map.set(dt.toISOString().split('T')[0], { created: 0, resolved: 0, inProgress: 0 });
  }

  for (const t of tickets) {
    const c = t.createdAt.toISOString().split('T')[0];
    if (map.has(c)) map.get(c)!.created++;
    if (t.completedAt) {
      const r = t.completedAt.toISOString().split('T')[0];
      if (map.has(r)) map.get(r)!.resolved++;
    }
  }

  // Rolling 7-day average for velocity
  const sorted = [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
  const result = sorted.map(([date, v], i) => {
    const window = sorted.slice(Math.max(0, i - 6), i + 1);
    const avg = window.reduce((s, [, x]) => s + x.created, 0) / window.length;
    return {
      date: new Date(date).toLocaleDateString('en-IN', { month: 'short', day: 'numeric' }),
      isoDate: date,
      ...v,
      movingAvg: Math.round(avg * 10) / 10,
    };
  });

  // Priority breakdown for the period
  const priorityBreakdown: Record<string, number> = {};
  for (const t of tickets) {
    if (t.createdAt >= since) {
      priorityBreakdown[t.priority] = (priorityBreakdown[t.priority] || 0) + 1;
    }
  }

  // Source breakdown
  const sourceBreakdown: Record<string, number> = {};
  for (const t of tickets) {
    if (t.createdAt >= since) {
      sourceBreakdown[t.source] = (sourceBreakdown[t.source] || 0) + 1;
    }
  }

  const totalCreated = result.reduce((s, r) => s + r.created, 0);
  const totalResolved = result.reduce((s, r) => s + r.resolved, 0);

  res.json({ success: true, data: { daily: result, priorityBreakdown, sourceBreakdown, totalCreated, totalResolved, days } });
});

// GET /api/analytics/user-activity — audit-log based action counts per user/day
router.get('/user-activity', requirePermission('analytics', 'read'), async (req, res) => {
  const { days: daysStr = '30', userId } = req.query as { days?: string; userId?: string };
  const days = Math.min(Math.max(parseInt(daysStr) || 30, 1), 180);
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const where: Record<string, unknown> = { createdAt: { gte: since }, NOT: { actorId: null } };
  if (userId) where.actorId = userId;

  const logs = await prisma.auditLog.findMany({
    where,
    select: { actorId: true, action: true, resource: true, createdAt: true },
    orderBy: { createdAt: 'asc' },
  });

  // Per-day counts
  const byDay = new Map<string, { date: string; events: number; creates: number; updates: number; merges: number }>();
  for (let d = 0; d < days; d++) {
    const dt = new Date(since.getTime() + d * 86400000);
    const k = dt.toISOString().split('T')[0];
    byDay.set(k, {
      date: new Date(k).toLocaleDateString('en-IN', { month: 'short', day: 'numeric' }),
      events: 0, creates: 0, updates: 0, merges: 0,
    });
  }
  for (const log of logs) {
    const k = log.createdAt.toISOString().split('T')[0];
    if (byDay.has(k)) {
      const row = byDay.get(k)!;
      row.events++;
      if (log.action === 'create') row.creates++;
      else if (log.action === 'update' || log.action === 'user_merge') row.updates++;
      if (log.action === 'user_merge') row.merges++;
    }
  }

  // Top active users
  const userCounts = new Map<string, number>();
  for (const log of logs) {
    if (log.actorId) userCounts.set(log.actorId, (userCounts.get(log.actorId) || 0) + 1);
  }
  const topUserIds = [...userCounts.entries()].sort(([, a], [, b]) => b - a).slice(0, 10).map(([id]) => id);
  const topUsers = topUserIds.length
    ? await prisma.user.findMany({
        where: { id: { in: topUserIds } },
        select: { id: true, firstName: true, lastName: true },
      })
    : [];
  const topUsersWithCount = topUsers.map((u) => ({
    ...u,
    events: userCounts.get(u.id) || 0,
    fullName: `${u.firstName} ${u.lastName}`,
  })).sort((a, b) => b.events - a.events);

  // Action type breakdown
  const actionBreakdown: Record<string, number> = {};
  for (const log of logs) actionBreakdown[log.action] = (actionBreakdown[log.action] || 0) + 1;

  // Resource breakdown
  const resourceBreakdown: Record<string, number> = {};
  for (const log of logs) resourceBreakdown[log.resource] = (resourceBreakdown[log.resource] || 0) + 1;

  res.json({
    success: true,
    data: {
      daily: [...byDay.values()],
      topUsers: topUsersWithCount,
      actionBreakdown,
      resourceBreakdown,
      totalEvents: logs.length,
    },
  });
});

router.get('/tickets-flow', requirePermission('analytics', 'read'), async (req, res) => {
  const { projectId } = req.query as { projectId?: string };
  const where: Prisma.TicketWhereInput = { deletedAt: null };
  applyCodemagenTicketVisibility(where, await getCodemagenEnabled());
  if (projectId) where.projectId = projectId;

  const tickets = await prisma.ticket.findMany({
    where,
    select: { workflowState: { select: { name: true, slug: true, order: true } } },
    take: 5000,
  });

  const map = new Map<string, number>();
  for (const t of tickets) {
    const slug = t.workflowState?.slug || 'todo';
    const label = t.workflowState?.name || slug;
    map.set(label, (map.get(label) || 0) + 1);
  }
  const funnel = [...map.entries()].map(([stage, count]) => ({ stage, count }));
  res.json({ success: true, data: funnel });
});

export default router;
