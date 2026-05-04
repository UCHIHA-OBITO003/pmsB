import { Router } from 'express';
import { prisma } from '../utils/prisma';
import { authenticate, requirePermission } from '../middleware/auth';

const router = Router();
router.use(authenticate);

// GET /api/analytics/users
router.get('/users', requirePermission('analytics', 'read'), async (req, res) => {
  const { projectId } = req.query as { projectId?: string };
  const where: any = {};
  if (projectId) where.projectMemberships = { some: { projectId } };

  const users = await prisma.user.findMany({
    where,
    select: { id: true, firstName: true, lastName: true, avatar: true },
    orderBy: { firstName: 'asc' },
  });
  res.json({ success: true, data: users });
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

  const snapshots = await prisma.workloadSnapshot.findMany({
    where: {
      ...(projectId ? { projectId } : {}),
      date: { gte: since },
    },
    include: { user: { select: { firstName: true, lastName: true } } },
    orderBy: [{ date: 'asc' }, { userId: 'asc' }],
  });

  res.json({ success: true, data: snapshots });
});

// GET /api/analytics/tickets
router.get('/tickets', requirePermission('analytics', 'read'), async (req, res) => {
  const { projectId, period = '30d' } = req.query as { projectId?: string; period?: string };
  const days = period === '7d' ? 7 : period === '30d' ? 30 : period === '90d' ? 90 : period === '6m' ? 180 : period === '1y' ? 365 : 3650;
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const where: any = {
    deletedAt: null,
    createdAt: { gte: since }
  };
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

router.get('/leaderboard', requirePermission('analytics', 'read'), async (_req, res) => {
  const scores = await prisma.developerScorecard.findMany({
    orderBy: { totalScore: 'desc' },
    take: 10,
    include: {
      user: { select: { id: true, firstName: true, lastName: true, avatar: true, department: true } },
    },
  });
  res.json({ success: true, data: scores });
});

router.get('/tickets-flow', requirePermission('analytics', 'read'), async (req, res) => {
  const { projectId } = req.query as { projectId?: string };
  const where: any = { deletedAt: null };
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
