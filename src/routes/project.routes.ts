import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../utils/prisma';
import { authenticate, requirePermission, requireRole, AuthRequest } from '../middleware/auth';
import { AppError } from '../middleware/errorHandler';

const router = Router();
router.use(authenticate);

const ProjectSchema = z.object({
  name: z.string().min(1).max(100),
  key: z.string().min(2).max(10).toUpperCase(),
  description: z.string().optional(),
  companyId: z.string().uuid().optional().nullable(),
  teamId: z.string().uuid().optional(),
  startDate: z.coerce.date().optional(),
  endDate: z.coerce.date().optional(),
  budget: z.number().optional(),
  status: z.enum(['ACTIVE', 'ON_HOLD', 'COMPLETED', 'CANCELLED', 'PLANNING']).optional(),
});

// GET /api/projects
router.get('/', requirePermission('projects', 'read'), async (req: AuthRequest, res) => {
  const { search, status, page = '1', limit = '20' } = req.query as Record<string, string>;
  const skip = (parseInt(page) - 1) * parseInt(limit);

  const where: any = { deletedAt: null };

  // Non-admins only see their projects
  if (!req.user?.roles.includes('admin') && !req.user?.roles.includes('project_manager')) {
    where.members = { some: { userId: req.user!.id } };
  }

  if (search) where.name = { contains: search, mode: 'insensitive' };
  if (status) where.status = status;

  const [projects, total] = await prisma.$transaction([
    prisma.project.findMany({
      where,
      include: {
        members: {
          include: { project: false },
          take: 5,
        },
        _count: { select: { tickets: true, sprints: true } },
      },
      orderBy: { createdAt: 'desc' },
      skip,
      take: parseInt(limit),
    }),
    prisma.project.count({ where }),
  ]);

  res.json({ success: true, data: { projects, total, page: parseInt(page), limit: parseInt(limit) } });
});

// GET /api/projects/:id
router.get('/:id', requirePermission('projects', 'read'), async (req, res) => {
  const project = await prisma.project.findFirst({
    where: { id: req.params.id, deletedAt: null },
    include: {
      company: { select: { id: true, name: true, organisationId: true } },
      members: { include: { user: { select: { id: true, email: true, firstName: true, lastName: true, avatar: true, status: true, skills: true } } } },
      sprints: { where: { status: 'ACTIVE' }, take: 1 },
      _count: { select: { tickets: true, sprints: true, members: true } },
      workflowStates: { orderBy: { order: 'asc' } },
    },
  });

  if (!project) throw new AppError(404, 'Project not found', 'NOT_FOUND');
  res.json({ success: true, data: project });
});

// POST /api/projects
router.post('/', requirePermission('projects', 'create'), async (req: AuthRequest, res) => {
  const data = ProjectSchema.parse(req.body);

  const project = await prisma.project.create({
    data: {
      ...data,
      ownerId: req.user!.id,
      members: {
        create: [{ userId: req.user!.id, role: 'pm' }],
      },
      // Create default workflow states
      workflowStates: {
        create: [
          { name: 'To Do', slug: 'todo', color: '#94a3b8', order: 0, isDefault: true },
          { name: 'Started work', slug: 'started_work', color: '#64748b', order: 1 },
          { name: 'In Progress', slug: 'in_progress', color: '#3b82f6', order: 2 },
          { name: 'Testing', slug: 'testing', color: '#a855f7', order: 3 },
          { name: 'In Review', slug: 'in_review', color: '#f59e0b', order: 4 },
          { name: 'Deployed', slug: 'deployed', color: '#14b8a6', order: 5 },
          { name: 'Blocked', slug: 'blocked', color: '#ef4444', order: 6 },
          { name: 'Done', slug: 'done', color: '#22c55e', order: 7, isFinal: true },
        ],
      },
    },
  });

  res.status(201).json({ success: true, data: project });
});

// PATCH /api/projects/:id
router.patch('/:id', requirePermission('projects', 'update'), async (req, res) => {
  const data = ProjectSchema.partial().parse(req.body);
  const project = await prisma.project.update({ where: { id: req.params.id }, data });
  res.json({ success: true, data: project });
});

// DELETE /api/projects/:id (soft delete)
router.delete('/:id', requirePermission('projects', 'delete'), async (req, res) => {
  await prisma.project.update({ where: { id: req.params.id }, data: { deletedAt: new Date() } });
  res.json({ success: true, message: 'Project archived' });
});

// POST /api/projects/:id/members
router.post('/:id/members', requirePermission('projects', 'update'), async (req, res) => {
  const { userId, role } = z.object({
    userId: z.string().uuid(),
    role: z.enum(['pm', 'lead', 'developer', 'qa', 'stakeholder']),
  }).parse(req.body);

  await prisma.projectMember.upsert({
    where: { projectId_userId: { projectId: req.params.id, userId } },
    create: { projectId: req.params.id, userId, role },
    update: { role },
  });

  res.json({ success: true, message: 'Member added' });
});

const MilestoneBody = z.object({
  title: z.string().min(1),
  dueDate: z.coerce.date().optional().nullable(),
  status: z.enum(['PENDING', 'COMPLETED']).optional(),
  sortOrder: z.number().optional(),
});

router.get('/:id/milestones', requirePermission('projects', 'read'), async (req, res) => {
  const list = await prisma.projectMilestone.findMany({
    where: { projectId: req.params.id },
    orderBy: [{ sortOrder: 'asc' }, { dueDate: 'asc' }],
  });
  res.json({ success: true, data: list });
});

router.post('/:id/milestones', requirePermission('projects', 'update'), async (req: AuthRequest, res) => {
  const body = MilestoneBody.parse(req.body);
  const m = await prisma.projectMilestone.create({
    data: {
      projectId: req.params.id,
      title: body.title,
      dueDate: body.dueDate ?? undefined,
      status: body.status ?? 'PENDING',
      sortOrder: body.sortOrder ?? 0,
    },
  });
  res.status(201).json({ success: true, data: m });
});

router.patch('/:id/milestones/:mid', requirePermission('projects', 'update'), async (req, res) => {
  const body = MilestoneBody.partial().parse(req.body);
  await prisma.projectMilestone.updateMany({
    where: { id: req.params.mid, projectId: req.params.id },
    data: body,
  });
  const updated = await prisma.projectMilestone.findFirst({ where: { id: req.params.mid } });
  res.json({ success: true, data: updated });
});

router.delete('/:id/milestones/:mid', requirePermission('projects', 'update'), async (req, res) => {
  await prisma.projectMilestone.deleteMany({ where: { id: req.params.mid, projectId: req.params.id } });
  res.json({ success: true, message: 'Milestone deleted' });
});

router.get('/:id/docs', requirePermission('projects', 'read'), async (req, res) => {
  const docs = await prisma.projectDoc.findMany({
    where: { projectId: req.params.id },
    orderBy: { updatedAt: 'desc' },
    include: { author: { select: { id: true, firstName: true, lastName: true } } },
  });
  res.json({ success: true, data: docs });
});

router.post('/:id/docs', requirePermission('projects', 'update'), async (req: AuthRequest, res) => {
  const body = z
    .object({ title: z.string().min(1), content: z.string().default('') })
    .parse(req.body);
  const doc = await prisma.projectDoc.create({
    data: {
      projectId: req.params.id,
      title: body.title,
      content: body.content,
      authorId: req.user!.id,
    },
  });
  res.status(201).json({ success: true, data: doc });
});

router.patch('/:id/docs/:docId', requirePermission('projects', 'update'), async (req: AuthRequest, res) => {
  const patch = z
    .object({ title: z.string().optional(), content: z.string().optional() })
    .parse(req.body);
  const exists = await prisma.projectDoc.findFirst({
    where: { id: req.params.docId, projectId: req.params.id },
  });
  if (!exists) throw new AppError(404, 'Doc not found', 'NOT_FOUND');
  const doc = await prisma.projectDoc.update({
    where: { id: exists.id },
    data: { ...patch, authorId: req.user!.id },
    include: { author: { select: { id: true, firstName: true } } },
  });
  res.json({ success: true, data: doc });
});

router.delete('/:id/docs/:docId', requirePermission('projects', 'update'), async (req, res) => {
  await prisma.projectDoc.deleteMany({ where: { id: req.params.docId, projectId: req.params.id } });
  res.json({ success: true, message: 'Doc deleted' });
});

router.get('/:id/releases', requirePermission('projects', 'read'), async (req, res) => {
  const releases = await prisma.projectRelease.findMany({
    where: { projectId: req.params.id },
    orderBy: [{ releasedAt: 'desc' }, { createdAt: 'desc' }],
  });
  res.json({ success: true, data: releases });
});

router.post('/:id/releases', requirePermission('projects', 'update'), async (req, res) => {
  const body = z
    .object({
      version: z.string().min(1),
      name: z.string().optional(),
      notes: z.string().optional(),
      releasedAt: z.coerce.date().optional().nullable(),
    })
    .parse(req.body);
  const row = await prisma.projectRelease.create({
    data: {
      projectId: req.params.id,
      version: body.version,
      name: body.name,
      notes: body.notes,
      releasedAt: body.releasedAt ?? undefined,
    },
  });
  res.status(201).json({ success: true, data: row });
});

router.delete('/:id/releases/:rid', requirePermission('projects', 'update'), async (req, res) => {
  await prisma.projectRelease.deleteMany({ where: { id: req.params.rid, projectId: req.params.id } });
  res.json({ success: true, message: 'Release removed' });
});

router.get('/:id/health', requirePermission('projects', 'read'), async (req, res) => {
  const proj = await prisma.project.findFirst({
    where: { id: req.params.id, deletedAt: null },
    select: { healthScore: true, budget: true, status: true, name: true, key: true },
  });
  if (!proj) throw new AppError(404, 'Project not found', 'NOT_FOUND');

  const [blockedTickets, overdue] = await prisma.$transaction([
    prisma.ticket.count({
      where: {
        projectId: req.params.id,
        deletedAt: null,
        workflowState: { slug: 'blocked' },
      },
    }),
    prisma.ticket.count({
      where: {
        projectId: req.params.id,
        deletedAt: null,
        dueDate: { lt: new Date() },
        completedAt: null,
      },
    }),
  ]);

  const score = proj.healthScore ?? 70;
  res.json({
    success: true,
    data: {
      healthScore: score,
      status: proj.status,
      breakdown: {
        blockedTickets,
        overdueTickets: overdue,
      },
      note: proj.healthScore == null ? 'No stored health score yet — heuristic below is approximate.' : null,
      heuristicAdjusted: score - blockedTickets * 3 - overdue * 2,
    },
  });
});

router.get('/:id/budget', requirePermission('projects', 'read'), async (req, res) => {
  const proj = await prisma.project.findFirst({
    where: { id: req.params.id, deletedAt: null },
    select: { budget: true, name: true },
  });
  if (!proj) throw new AppError(404, 'Project not found', 'NOT_FOUND');

  const agg = await prisma.timesheet.aggregate({
    where: { ticket: { projectId: req.params.id, deletedAt: null } },
    _sum: { hours: true },
    _count: true,
  });
  const hourlyRateRaw = typeof req.query.rate === 'string' ? parseFloat(req.query.rate) : NaN;
  const hourlyRate = Number.isFinite(hourlyRateRaw) && hourlyRateRaw > 0 ? hourlyRateRaw : 50;
  const hours = agg._sum.hours ?? 0;
  const spentUsd = Math.round(hours * hourlyRate * 100) / 100;

  res.json({
    success: true,
    data: {
      budgetUsd: proj.budget ?? null,
      hoursLogged: hours,
      timesheetEntries: agg._count,
      estimatedSpendUsd: spentUsd,
      hourlyRateUsed: hourlyRate,
    },
  });
});

router.get('/:id/activity', requirePermission('projects', 'read'), async (req, res) => {
  const histories = await prisma.ticketHistory.findMany({
    where: { ticket: { projectId: req.params.id, deletedAt: null } },
    orderBy: { createdAt: 'desc' },
    take: 50,
    select: {
      id: true,
      field: true,
      oldValue: true,
      newValue: true,
      createdAt: true,
      ticket: { select: { id: true, title: true } },
    },
  });
  const audit = await prisma.auditLog.findMany({
    where: { resource: 'projects', resourceId: req.params.id },
    orderBy: { createdAt: 'desc' },
    take: 20,
  });
  res.json({ success: true, data: { ticketHistory: histories, auditLogs: audit } });
});

router.get('/:id/risks', requirePermission('projects', 'read'), async (req, res) => {
  const risks = await prisma.predictiveRisk.findMany({
    where: {
      projectId: req.params.id,
      resolved: false,
    },
    orderBy: { createdAt: 'desc' },
    take: 15,
  });
  res.json({ success: true, data: risks });
});

const WorkflowReorderSchema = z.object({
  states: z.array(z.object({
    id: z.string(),
    order: z.number().int(),
    name: z.string().min(1).optional(),
  })).min(1),
});

router.patch('/:id/workflow', requirePermission('projects', 'update'), async (req: AuthRequest, res) => {
  const parsed = WorkflowReorderSchema.parse(req.body);

  await prisma.$transaction(
    parsed.states.map((s) =>
      prisma.workflowState.updateMany({
        where: { id: s.id, projectId: req.params.id },
        data: { order: s.order, ...(s.name !== undefined ? { name: s.name } : {}) },
      }),
    ),
  );

  const workflowStates = await prisma.workflowState.findMany({
    where: { projectId: req.params.id },
    orderBy: { order: 'asc' },
  });
  res.json({ success: true, data: workflowStates });
});

export default router;
