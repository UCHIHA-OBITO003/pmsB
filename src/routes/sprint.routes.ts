import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../utils/prisma';
import { authenticate, AuthRequest, requirePermission } from '../middleware/auth';
import { AppError } from '../middleware/errorHandler';
import type { Prisma } from '@prisma/client';

const router = Router();
router.use(authenticate);

const SprintSchema = z.object({
  projectId: z.string().uuid(),
  name: z.string().min(1),
  goal: z.string().optional(),
  startDate: z.coerce.date().optional(),
  endDate: z.coerce.date().optional(),
  capacity: z.number().optional(),
});

router.get('/velocity-trend', requirePermission('sprints', 'read'), async (req, res) => {
  const { projectId } = req.query as { projectId?: string };
  const where: { projectId?: string } = {};
  if (projectId) where.projectId = projectId;
  const rows = await prisma.sprint.findMany({
    where,
    orderBy: { endDate: 'desc' },
    take: 24,
    select: {
      id: true,
      name: true,
      projectId: true,
      velocity: true,
      capacity: true,
      status: true,
      endDate: true,
      analytics: { orderBy: { computedAt: 'desc' }, take: 1, select: { velocity: true, completionPct: true, pointsDone: true, pointsTotal: true, burndownData: true } },
    },
  });
  const trend = rows.map((r) => ({
    sprintId: r.id,
    name: r.name,
    velocity: r.analytics[0]?.velocity ?? r.velocity ?? 0,
    completionPct: r.analytics[0]?.completionPct ?? 0,
  }));
  res.json({ success: true, data: trend });
});

router.get('/compare', requirePermission('sprints', 'read'), async (req, res) => {
  const ids = (req.query.ids as string | undefined)?.split(',').filter(Boolean) ?? [];
  if (ids.length < 2 || ids.length > 6) {
    return res.status(400).json({
      success: false,
      error: { message: 'Provide 2–6 sprint ids as comma-separated `ids` query param' },
    });
  }
  const sprints = await prisma.sprint.findMany({
    where: { id: { in: ids } },
    include: { analytics: true, _count: { select: { tickets: true } } },
  });
  res.json({ success: true, data: sprints });
});

router.get('/', requirePermission('sprints', 'read'), async (req, res) => {
  const { projectId } = req.query as { projectId?: string };
  const where: any = {};
  if (projectId) where.projectId = projectId;

  const sprints = await prisma.sprint.findMany({
    where,
    include: {
      _count: { select: { tickets: true } },
      analytics: true,
    },
    orderBy: { createdAt: 'desc' },
  });

  res.json({ success: true, data: sprints });
});

router.get('/:id', requirePermission('sprints', 'read'), async (req, res) => {
  const sprint = await prisma.sprint.findUnique({
    where: { id: req.params.id },
    include: {
      tickets: {
        include: {
          assignees: { select: { id: true, firstName: true, lastName: true, avatar: true } },
          workflowState: true,
        },
      },
      analytics: true,
      retrospective: true,
    },
  });
  if (!sprint) throw new AppError(404, 'Sprint not found', 'NOT_FOUND');
  res.json({ success: true, data: sprint });
});

router.post('/', requirePermission('sprints', 'create'), async (req, res) => {
  const data = SprintSchema.parse(req.body);
  const sprint = await prisma.sprint.create({ data });
  res.status(201).json({ success: true, data: sprint });
});

router.patch('/:id', requirePermission('sprints', 'update'), async (req, res) => {
  const data = SprintSchema.partial().extend({
    status: z.enum(['PLANNING', 'ACTIVE', 'COMPLETED', 'CANCELLED']).optional(),
  }).parse(req.body);

  const sprint = await prisma.sprint.update({ where: { id: req.params.id }, data });

  if (data.status === 'COMPLETED') {
    // Compute sprint analytics
    const tickets = await prisma.ticket.findMany({ where: { sprintId: sprint.id } });
    const done = tickets.filter((t) => t.completedAt !== null);
    const pointsDone = done.reduce((a, t) => a + (t.storyPoints || 0), 0);
    const pointsTotal = tickets.reduce((a, t) => a + (t.storyPoints || 0), 0);

    await prisma.sprintAnalytic.upsert({
      where: { sprintId: sprint.id },
      create: {
        sprintId: sprint.id,
        projectId: sprint.projectId,
        completionPct: pointsTotal > 0 ? (pointsDone / pointsTotal) * 100 : 0,
        pointsDone,
        pointsTotal,
        velocity: pointsDone,
      },
      update: {
        completionPct: pointsTotal > 0 ? (pointsDone / pointsTotal) * 100 : 0,
        pointsDone,
        pointsTotal,
        velocity: pointsDone,
      },
    });
  }

  res.json({ success: true, data: sprint });
});

// Add ticket to sprint
router.post('/:id/tickets', requirePermission('sprints', 'update'), async (req, res) => {
  const { ticketId } = z.object({ ticketId: z.string().uuid() }).parse(req.body);
  await prisma.ticket.update({ where: { id: ticketId }, data: { sprintId: req.params.id } });
  res.json({ success: true, message: 'Ticket added to sprint' });
});

router.patch('/:id/retrospective', requirePermission('sprints', 'update'), async (req: AuthRequest, res) => {
  const body = z
    .object({
      wentWell: z.array(z.string()).optional(),
      improved: z.array(z.string()).optional(),
      actions: z.array(z.string()).optional(),
    })
    .parse(req.body);

  const sprint = await prisma.sprint.findUnique({ where: { id: req.params.id } });
  if (!sprint) throw new AppError(404, 'Sprint not found', 'NOT_FOUND');

  const toJson = (a?: string[]): Prisma.InputJsonValue =>
    JSON.parse(JSON.stringify(a ?? []));

  const retro = await prisma.sprintRetrospective.upsert({
    where: { sprintId: sprint.id },
    create: {
      sprintId: sprint.id,
      wentWell: toJson(body.wentWell ?? []),
      improved: toJson(body.improved ?? []),
      actions: toJson(body.actions ?? []),
      authorId: req.user!.id,
    },
    update: {
      ...(body.wentWell !== undefined ? { wentWell: toJson(body.wentWell) } : {}),
      ...(body.improved !== undefined ? { improved: toJson(body.improved) } : {}),
      ...(body.actions !== undefined ? { actions: toJson(body.actions) } : {}),
      authorId: req.user!.id,
    },
  });

  res.json({ success: true, data: retro });
});

router.get('/:id/capacity', requirePermission('sprints', 'read'), async (req, res) => {
  const sprint = await prisma.sprint.findUnique({
    where: { id: req.params.id },
    include: {
      tickets: {
        select: {
          storyPoints: true,
          assignees: { select: { id: true, firstName: true, lastName: true } },
        },
      },
    },
  });
  if (!sprint) throw new AppError(404, 'Sprint not found', 'NOT_FOUND');

  const map = new Map<string, { userId: string; name: string; points: number; tickets: number }>();
  for (const t of sprint.tickets) {
    const pts = t.storyPoints ?? 0;
    const list = t.assignees.length ? t.assignees : [{ id: 'unassigned', firstName: 'Unassigned', lastName: '' }];
    for (const u of list) {
      const key = u.id;
      const prev = map.get(key) ?? { userId: key, name: `${u.firstName} ${u.lastName ?? ''}`.trim(), points: 0, tickets: 0 };
      prev.points += pts / list.length;
      prev.tickets += 1 / list.length;
      map.set(key, prev);
    }
  }
  res.json({ success: true, data: [...map.values()] });
});

router.get('/:id/workload', requirePermission('sprints', 'read'), async (req, res) => {
  const sprint = await prisma.sprint.findUnique({
    where: { id: req.params.id },
    include: {
      tickets: {
        include: { assignees: { select: { id: true, firstName: true } }, workflowState: true },
      },
    },
  });
  if (!sprint) throw new AppError(404, 'Sprint not found', 'NOT_FOUND');

  const byUser = new Map<string, { name: string; count: number; blocked: number }>();
  for (const t of sprint.tickets) {
    const assignees = t.assignees.length ? t.assignees : [{ id: '_na', firstName: '—' }];
    const blocked = t.workflowState?.slug === 'blocked' ? 1 : 0;
    for (const a of assignees) {
      const cur = byUser.get(a.id) ?? { name: a.firstName, count: 0, blocked: 0 };
      cur.count += 1 / assignees.length;
      cur.blocked += blocked / assignees.length;
      byUser.set(a.id, cur);
    }
  }
  res.json({ success: true, data: [...byUser.entries()].map(([userId, v]) => ({ userId, ...v })) });
});

router.get('/:id/insights', requirePermission('sprints', 'read'), async (req, res) => {
  const sprint = await prisma.sprint.findUnique({
    where: { id: req.params.id },
    include: {
      tickets: {
        select: {
          completedAt: true,
          storyPoints: true,
          workflowState: { select: { slug: true } },
          assignees: { select: { id: true, firstName: true } },
        },
      },
      analytics: { orderBy: { computedAt: 'desc' }, take: 1 },
    },
  });
  if (!sprint) throw new AppError(404, 'Sprint not found', 'NOT_FOUND');

  const now = Date.now();
  const start = sprint.startDate?.getTime() ?? now;
  const end = sprint.endDate?.getTime() ?? start;
  const daysRemaining = end > now ? Math.ceil((end - now) / (86400 * 1000)) : 0;
  const totalDuration = Math.max(1, end - start);
  const elapsedRatio = Math.min(1, Math.max(0, (now - start) / totalDuration));

  const totalPts = sprint.tickets.reduce((a, t) => a + (t.storyPoints || 0), 0);
  const donePts = sprint.tickets
    .filter((t) => t.completedAt != null || t.workflowState?.slug === 'done')
    .reduce((a, t) => a + (t.storyPoints || 0), 0);
  const goalProgress = totalPts > 0 ? Math.round((donePts / totalPts) * 1000) / 10 : 0;

  const blockedCount = sprint.tickets.filter((t) => t.workflowState?.slug === 'blocked').length;
  const risks: string[] = [];
  if (blockedCount > 2) risks.push(`${blockedCount} blocked tickets`);
  if (elapsedRatio > 0.5 && goalProgress < 30) risks.push('Low completion mid-sprint');
  const assigneeLoad = new Map<string, number>();
  for (const t of sprint.tickets) {
    for (const a of t.assignees) assigneeLoad.set(a.id, (assigneeLoad.get(a.id) ?? 0) + 1);
  }
  const maxLoad = Math.max(0, ...assigneeLoad.values());
  if (maxLoad > 8) risks.push('One assignee has many tickets');

  res.json({
    success: true,
    data: {
      daysRemaining,
      goalProgress,
      goalText: sprint.goal,
      burndownData: sprint.analytics[0]?.burndownData ?? null,
      risks,
      blockedCount,
      analytics: sprint.analytics[0] ?? null,
    },
  });
});

export default router;
